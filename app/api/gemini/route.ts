import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface GeminiRequestBody {
  prompt?: unknown;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("GEMINI_API_KEY:", apiKey ? "Present" : "Missing");
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY is missing from .env.local.",
        },
        {
          status: 500,
        },
      );
    }

    const body =
      (await request.json()) as GeminiRequestBody;

    const prompt =
      typeof body.prompt === "string"
        ? body.prompt.trim()
        : "";

    if (!prompt) {
      return NextResponse.json(
        {
          error: "Please enter a prompt.",
        },
        {
          status: 400,
        },
      );
    }

    if (prompt.length > 3000) {
      return NextResponse.json(
        {
          error:
            "The prompt must be 3000 characters or fewer.",
        },
        {
          status: 400,
        },
      );
    }

    const ai = new GoogleGenAI({
      apiKey,
    });

    const response =
      await ai.models.generateContent({
        model:
          process.env.GEMINI_MODEL ??
          "gemini-2.5-flash",

        contents: `
You are Lixia, a concise and friendly teaching assistant
inside an interactive 3D whiteboard application.

Answer the user's request in a format suitable for writing
on a whiteboard.

Rules:
- Give a short title.
- Use short sentences or bullet points.
- Keep the full answer under 120 words.
- Do not use markdown tables.
- Do not include unnecessary introductions.
- Make difficult concepts easy to understand.

User request:
${prompt}
        `.trim(),
      });

    const text = response.text?.trim();

    if (!text) {
      return NextResponse.json(
        {
          error:
            "Gemini returned an empty response.",
        },
        {
          status: 502,
        },
      );
    }

    return NextResponse.json({
      text,
    });
  } catch (error) {
    console.error("Gemini API error:", error);

    return NextResponse.json(
      {
        error:
          "Gemini could not generate a response.",
      },
      {
        status: 500,
      },
    );
  }
}