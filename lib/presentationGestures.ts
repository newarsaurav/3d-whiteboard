/**
 * Small local intent map so LixiaStudio does not import the 3MB
 * @lixia/mike-animation registry on first paint.
 *
 * Each teaching intent has 2–3 approved upper-body clips. Unknown
 * intents fall back instead of silently no-oping.
 */

export type GestureLayer = "full_body" | "upper_body";

export type GesturePlan = {
  intent: string;
  animationId: string;
  layer: GestureLayer;
  pool: string[];
};

export const DEFAULT_GESTURE_INTENT = "explain";

type GestureSpec = {
  ids: string[];
  layer: GestureLayer;
};

export const GESTURE_POOLS: Record<string, GestureSpec> = {
  idle: { ids: ["mixamo_1094"], layer: "full_body" },
  wave: { ids: ["seg_055", "seg_056", "seg_057"], layer: "upper_body" },
  goodbye: { ids: ["seg_009", "seg_055"], layer: "upper_body" },
  walk: { ids: ["seg_499"], layer: "upper_body" },
  explain: { ids: ["seg_377", "seg_379", "seg_380", "seg_369", "seg_371"], layer: "upper_body" },
  talk: { ids: ["seg_377", "seg_379", "seg_380", "seg_373", "seg_456"], layer: "upper_body" },
  emphasize: { ids: ["seg_373", "seg_374", "seg_375", "seg_391"], layer: "upper_body" },
  point: { ids: ["seg_369", "seg_371", "seg_079"], layer: "upper_body" },
  think: { ids: ["seg_312", "seg_427", "seg_404"], layer: "upper_body" },
  agree: { ids: ["seg_415", "seg_416", "seg_417"], layer: "upper_body" },
  disagree: { ids: ["seg_422", "seg_423", "seg_424"], layer: "upper_body" },
  thanks: { ids: ["seg_009", "seg_536"], layer: "upper_body" },
  welcome: { ids: ["seg_055", "seg_056", "seg_057"], layer: "upper_body" },
  offer: { ids: ["seg_456", "seg_457", "seg_504"], layer: "upper_body" },
  uncertain: { ids: ["seg_404", "seg_405", "seg_507"], layer: "upper_body" },
  idea: { ids: ["seg_225", "seg_391", "seg_380"], layer: "upper_body" },
  approve: { ids: ["seg_536", "seg_415", "seg_416"], layer: "upper_body" },
  next: { ids: ["seg_499", "seg_388"], layer: "upper_body" },
  listen: { ids: ["seg_427", "seg_312", "seg_417"], layer: "upper_body" },
  confused: { ids: ["seg_404", "seg_405", "seg_507"], layer: "upper_body" },
  ready: { ids: ["seg_225", "seg_391", "seg_055"], layer: "upper_body" },
  reveal: { ids: ["seg_388", "seg_389", "seg_481"], layer: "upper_body" },
  contrast: { ids: ["seg_492", "seg_413", "seg_469"], layer: "upper_body" },
  together: { ids: ["seg_413", "seg_469", "seg_481"], layer: "upper_body" },
};

/** Idle stays on the standing loop. Nods are not mixed in at rest. */
export const IDLE_FIDGET_IDS = [] as const;

/** Intents that should glance at the whiteboard. */
export const LOOK_AT_BOARD_INTENTS = new Set([
  "point",
  "reveal",
  "approve",
  "contrast",
  "next",
  "emphasize",
  "offer",
]);

export const GESTURE_BY_INTENT: Record<
  string,
  { animationId: string; layer: GestureLayer }
> = Object.fromEntries(
  Object.entries(GESTURE_POOLS).map(([intent, spec]) => [
    intent,
    { animationId: spec.ids[0], layer: spec.layer },
  ]),
);

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
  wait: "think",
  waiting: "think",
  thinking: "think",
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

const lastPickByIntent = new Map<string, string>();

function pickPoolId(intent: string, ids: string[], fallbackIndex = 0): string {
  if (ids.length === 1) {
    lastPickByIntent.set(intent, ids[0]);
    return ids[0];
  }

  const last = lastPickByIntent.get(intent);
  const choices = ids.filter((id) => id !== last);
  const pool = choices.length > 0 ? choices : ids;
  const picked = pool[Math.abs(fallbackIndex) % pool.length];
  lastPickByIntent.set(intent, picked);
  return picked;
}

/**
 * Caption / narration length → expected speak hold (seconds).
 * Ported from lab mike-studio speakHold.
 */
export function estimateSpeechSeconds(text: string): number {
  const normalized = String(text || "").trim();
  if (!normalized) return 2.4;
  const wordCount = normalized.split(/\s+/).length;
  return Math.min(30, Math.max(2.4, 2.5 + wordCount / 2.1));
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
    const spec = GESTURE_POOLS.idle;
    return {
      intent: "idle",
      animationId: spec.ids[0],
      layer: spec.layer,
      pool: spec.ids,
    };
  }

  if (normalized && GESTURE_POOLS[normalized]) {
    const spec = GESTURE_POOLS[normalized];
    return {
      intent: normalized,
      animationId: pickPoolId(normalized, spec.ids, fallbackIndex),
      layer: spec.layer,
      pool: spec.ids,
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
  const spec = GESTURE_POOLS[fallback];
  return {
    intent: fallback,
    animationId: pickPoolId(fallback, spec.ids, fallbackIndex),
    layer: spec.layer,
    pool: spec.ids,
  };
}

export function shouldWaitForBoard(intent: string | null | undefined): boolean {
  const plan = resolveGesturePlan(intent);
  return BOARD_FIRST_GESTURES.has(plan.intent);
}

export function shouldLookAtBoard(intent: string | null | undefined): boolean {
  const normalized = normalizeGestureIntent(intent);
  if (normalized && LOOK_AT_BOARD_INTENTS.has(normalized)) return true;
  return BOARD_FIRST_GESTURES.has(resolveGesturePlan(intent).intent);
}

export function gestureForBoardCommand(
  command: { type: string; formulas?: string[]; title?: string; mode?: string },
): string {
  switch (command.type) {
    case "flowchart":
      return "point";
    case "chart":
      return "reveal";
    case "image":
      return command.mode === "edit" ? "approve" : "reveal";
    case "write_text":
      if (command.formulas && command.formulas.length > 0) return "reveal";
      if (command.title?.trim()) return "point";
      return "explain";
    default:
      return "explain";
  }
}

export function cameraShotForIntent(
  intent: string | null | undefined,
): "waist" | "full" | "close" {
  const plan = resolveGesturePlan(intent);
  if (plan.intent === "reveal" || plan.intent === "approve") return "close";
  if (plan.intent === "point" || plan.intent === "next") return "full";
  return "waist";
}
