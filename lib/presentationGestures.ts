/**
 * Small local intent map so LixiaStudio does not import the 3MB
 * @lixia/mike-animation registry on first paint.
 *
 * Curated full-body Mixamo teaching performances from the retarget-results
 * catalog. Unknown intents fall back instead of silently no-oping.
 */

export type GestureLayer = "full_body" | "upper_body";

export type GesturePlan = {
  intent: string;
  animationId: string;
  layer: GestureLayer;
};

export const DEFAULT_GESTURE_INTENT = "explain";

export const GESTURE_BY_INTENT: Record<
  string,
  { animationId: string; layer: GestureLayer }
> = {
  idle: { animationId: "mixamo_1193", layer: "full_body" },
  wave: { animationId: "mixamo_038", layer: "full_body" },
  goodbye: { animationId: "mixamo_038", layer: "full_body" },
  walk: { animationId: "seg_499", layer: "upper_body" },
  talk: { animationId: "seg_377", layer: "upper_body" },
  point: { animationId: "mixamo_1005", layer: "full_body" },
  think: { animationId: "seg_312", layer: "upper_body" },
  agree: { animationId: "seg_415", layer: "upper_body" },
  disagree: { animationId: "seg_422", layer: "upper_body" },
  explain: { animationId: "seg_377", layer: "upper_body" },
  emphasize: { animationId: "seg_373", layer: "upper_body" },
  thanks: { animationId: "seg_009", layer: "upper_body" },
  welcome: { animationId: "seg_055", layer: "upper_body" },
  offer: { animationId: "seg_456", layer: "upper_body" },
  uncertain: { animationId: "seg_404", layer: "upper_body" },
  idea: { animationId: "seg_225", layer: "upper_body" },
  approve: { animationId: "seg_536", layer: "upper_body" },
  next: { animationId: "seg_499", layer: "upper_body" },
  listen: { animationId: "seg_427", layer: "upper_body" },
  confused: { animationId: "mixamo_056", layer: "full_body" },
  ready: { animationId: "seg_225", layer: "upper_body" },
  reveal: { animationId: "seg_388", layer: "upper_body" },
  contrast: { animationId: "seg_492", layer: "upper_body" },
  together: { animationId: "seg_413", layer: "upper_body" },
};

/** Gemini sometimes invents close cousins of real intents. */
const INTENT_ALIASES: Record<string, string> = {
  show: "reveal",
  demonstrate: "point",
  demo: "point",
  present: "reveal",
  introduce: "welcome",
  greeting: "wave",
  greet: "wave",
  hi: "wave",
  hello: "wave",
  nod: "agree",
  yes: "agree",
  no: "disagree",
  shrug: "uncertain",
  question: "confused",
  ask: "listen",
  highlight: "emphasize",
  stress: "emphasize",
  summarise: "explain",
  summarize: "explain",
  teach: "explain",
  writing: "point",
  write: "point",
  board: "point",
};

/** Wait for board ink before speaking when Mike should reference the board. */
export const BOARD_FIRST_GESTURES = new Set([
  "point",
  "reveal",
  "approve",
  "contrast",
  "next",
]);

export const FALLBACK_LESSON_GESTURES = [
  "explain",
  "point",
  "emphasize",
  "offer",
] as const;

/**
 * Caption / narration length → expected speak hold (seconds).
 * Ported from lab mike-studio speakHold.
 */
export function estimateSpeechSeconds(text: string): number {
  const length = String(text || "").trim().length;
  if (!length) return 2.4;
  return Math.min(14, Math.max(2.4, 2.0 + length * 0.045));
}

export function normalizeGestureIntent(
  intent: string | null | undefined,
): string | null {
  const raw = String(intent || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "continue") return null;
  return INTENT_ALIASES[raw] ?? raw;
}

/**
 * Always returns a playable plan. Unknown / empty intents use fallbackIndex
 * into FALLBACK_LESSON_GESTURES (or DEFAULT_GESTURE_INTENT).
 */
export function resolveGesturePlan(
  intent: string | null | undefined,
  fallbackIndex = 0,
): GesturePlan {
  const normalized = normalizeGestureIntent(intent);
  if (normalized === "idle") {
    return {
      intent: "idle",
      animationId: GESTURE_BY_INTENT.idle.animationId,
      layer: "full_body",
    };
  }

  if (normalized && GESTURE_BY_INTENT[normalized]) {
    const plan = GESTURE_BY_INTENT[normalized];
    return {
      intent: normalized,
      animationId: plan.animationId,
      layer: plan.layer,
    };
  }

  if (normalized && process.env.NODE_ENV !== "production") {
    console.warn(
      `[gestures] Unknown intent "${intent}" → fallback.`,
    );
  }

  const fallback =
    FALLBACK_LESSON_GESTURES[
      Math.abs(fallbackIndex) % FALLBACK_LESSON_GESTURES.length
    ] ?? DEFAULT_GESTURE_INTENT;
  const plan = GESTURE_BY_INTENT[fallback];
  return {
    intent: fallback,
    animationId: plan.animationId,
    layer: plan.layer,
  };
}

export function shouldWaitForBoard(intent: string | null | undefined): boolean {
  const plan = resolveGesturePlan(intent);
  return BOARD_FIRST_GESTURES.has(plan.intent);
}
