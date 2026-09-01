export function readGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() ?? "";
}

/** Older AI Studio keys are AIza…; new auth keys are AQ.… */
export function isGeminiApiKeyFormat(apiKey: string): boolean {
  return /^(AIza|AQ)/i.test(apiKey);
}

export const MISSING_GEMINI_KEY =
  "GEMINI_API_KEY is missing from .env.local.";

export const INVALID_GEMINI_KEY_FORMAT =
  "GEMINI_API_KEY does not look like an AI Studio key. New keys start with AQ. Older keys start with AIza. Get one at https://aistudio.google.com/apikey then restart npm run dev.";
