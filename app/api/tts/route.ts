import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import {
  INVALID_GEMINI_KEY_FORMAT,
  MISSING_GEMINI_KEY,
  isGeminiApiKeyFormat,
  readGeminiApiKey,
} from "../../../lib/geminiAuth";

export const runtime = "nodejs";

interface TtsRequestBody {
  text?: unknown;
  language?: unknown;
}

const MAX_TTS_TEXT_LENGTH = 2200;
const SAMPLE_RATE = 24000;

export async function POST(request: Request) {
  try {
    const apiKey = readGeminiApiKey();

    if (!apiKey) {
      return NextResponse.json(
        { error: MISSING_GEMINI_KEY },
        { status: 500 },
      );
    }

    if (!isGeminiApiKeyFormat(apiKey)) {
      return NextResponse.json(
        { error: INVALID_GEMINI_KEY_FORMAT },
        { status: 401 },
      );
    }

    const body = (await request.json()) as TtsRequestBody;

    const text =
      typeof body.text === "string"
        ? body.text.trim()
        : "";

    const language =
      typeof body.language === "string"
        ? body.language.trim().slice(0, 32)
        : "en-US";

    if (!text) {
      return NextResponse.json(
        { error: "TTS text is required." },
        { status: 400 },
      );
    }

    if (text.length > MAX_TTS_TEXT_LENGTH) {
      return NextResponse.json(
        {
          error: `TTS text must be ${MAX_TTS_TEXT_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }

    const ai = new GoogleGenAI({ apiKey });

    const speechPrompt = `
Speak the teaching narration below exactly as written.

Delivery direction:
- Speak like a warm, confident classroom teacher.
- Be clear, patient, and conversational rather than robotic.
- Use a moderate teaching pace.
- Add brief natural pauses after important definitions, formulas, and worked-example steps.
- Gently emphasize important technical terms and conclusions.
- Do not add, remove, summarize, or rephrase the narration.
- Do not read these delivery instructions aloud.
- Narration language/locale: ${language}.

Narration:
${text}
    `.trim();

    const responseStream =
      await ai.models.generateContentStream({
        model:
          process.env.GEMINI_TTS_MODEL ??
          "gemini-2.5-flash-preview-tts",
        contents: [
          {
            role: "user",
            parts: [{ text: speechPrompt }],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName:
                  process.env.GEMINI_TTS_VOICE ??
                  "Iapetus",
              },
            },
          },
        },
      });

    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of responseStream) {
            if (cancelled) {
              break;
            }

            const parts =
              chunk.candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
              const base64 = part.inlineData?.data;

              if (!base64) {
                continue;
              }

              const pcm = Buffer.from(base64, "base64");

              if (pcm.length > 0) {
                controller.enqueue(
                  new Uint8Array(
                    pcm.buffer,
                    pcm.byteOffset,
                    pcm.byteLength,
                  ),
                );
              }
            }
          }

          if (!cancelled) {
            controller.close();
          }
        } catch (error) {
          if (!cancelled) {
            console.error("Gemini streaming TTS error:", error);
            controller.error(error);
          }
        }
      },

      cancel() {
        cancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": `audio/L16;rate=${SAMPLE_RATE};channels=1`,
        "Cache-Control": "no-store",
        "X-Audio-Sample-Rate": String(SAMPLE_RATE),
        "X-Audio-Channels": "1",
        "X-Audio-Format": "pcm_s16le",
      },
    });
  } catch (error) {
    console.error("Gemini TTS route error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Gemini could not generate teacher audio.";

    const is429 =
      message.includes("429") ||
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("quota");

    return NextResponse.json(
      { error: message },
      { status: is429 ? 429 : 500 },
    );
  }
}