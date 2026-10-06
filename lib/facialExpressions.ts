/**
 * Facial emotion presets for Mike.
 *
 * MIKE_RealLixia.glb ships Character Creator face morphs (Brow_*, Eye_*,
 * Mouth_*, Cheek_*, Jaw_*, Nose_*). Each preset lists morph weights in the
 * 0..1 range. Names without an _L/_R suffix are applied to both sides when
 * the mesh has paired morphs.
 *
 * `sustain` is the fraction of the peak the expression settles to after the
 * first few seconds, so a surprised face does not stay frozen wide-eyed.
 */

export const MIKE_EMOTIONS = [
  "neutral",
  "attentive",
  "happy",
  "encouraging",
  "amused",
  "surprised",
  "thinking",
  "concerned",
  "serious",
  "angry",
] as const;

export type MikeEmotion = (typeof MIKE_EMOTIONS)[number];

export interface EmotionPreset {
  morphs: Record<string, number>;
  /** 0..1 fraction of the peak kept after `peakSeconds`. */
  sustain: number;
  /** Seconds the peak is held before easing to `sustain`. */
  peakSeconds: number;
}

export const EMOTION_PRESETS: Record<MikeEmotion, EmotionPreset> = {
  neutral: {
    morphs: {},
    sustain: 1,
    peakSeconds: 0,
  },
  attentive: {
    morphs: {
      Brow_Raise_Inner: 0.1,
      Eye_Wide: 0.06,
      Mouth_Smile: 0.06,
    },
    sustain: 1,
    peakSeconds: 0,
  },
  happy: {
    morphs: {
      Mouth_Smile: 0.55,
      Mouth_Smile_Sharp: 0.12,
      Mouth_Dimple: 0.2,
      Cheek_Raise: 0.35,
      Eye_Squint: 0.18,
      Brow_Raise_Inner: 0.1,
    },
    sustain: 0.75,
    peakSeconds: 2.5,
  },
  encouraging: {
    morphs: {
      Mouth_Smile: 0.4,
      Cheek_Raise: 0.2,
      Brow_Raise_Inner: 0.35,
      Brow_Raise_Outer: 0.2,
      Eye_Wide: 0.12,
    },
    sustain: 0.75,
    peakSeconds: 2,
  },
  amused: {
    morphs: {
      Mouth_Smile: 0.7,
      Mouth_Dimple: 0.3,
      Cheek_Raise: 0.5,
      Eye_Squint: 0.4,
      Jaw_Open: 0.1,
      Brow_Raise_Outer: 0.15,
    },
    sustain: 0.5,
    peakSeconds: 1.6,
  },
  surprised: {
    morphs: {
      Brow_Raise_Inner: 0.8,
      Brow_Raise_Outer: 0.7,
      Eye_Wide: 0.7,
      Jaw_Open: 0.22,
      Mouth_Drop_Lower: 0.15,
    },
    sustain: 0.2,
    peakSeconds: 1.4,
  },
  thinking: {
    morphs: {
      Brow_Raise_Outer_L: 0.45,
      Brow_Raise_Inner_L: 0.2,
      Brow_Drop_R: 0.2,
      Eye_Squint: 0.2,
      Mouth_Press: 0.3,
      Mouth_L: 0.15,
    },
    sustain: 0.75,
    peakSeconds: 2,
  },
  concerned: {
    morphs: {
      Brow_Raise_Inner: 0.55,
      Brow_Compress: 0.35,
      Mouth_Frown: 0.3,
      Mouth_Down: 0.12,
      Eye_Squint: 0.1,
    },
    sustain: 0.7,
    peakSeconds: 2,
  },
  serious: {
    morphs: {
      Brow_Drop: 0.35,
      Brow_Compress: 0.3,
      Eye_Squint: 0.12,
      Mouth_Press: 0.25,
      Mouth_Frown: 0.08,
    },
    sustain: 0.85,
    peakSeconds: 2,
  },
  angry: {
    morphs: {
      Brow_Drop: 0.8,
      Brow_Compress: 0.7,
      Eye_Squint: 0.35,
      Nose_Sneer: 0.3,
      Nose_Nostril_Dilate: 0.3,
      Mouth_Frown: 0.35,
      Mouth_Press: 0.3,
      Jaw_Forward: 0.1,
    },
    sustain: 0.55,
    peakSeconds: 2,
  },
};

const EMOTION_ALIASES: Record<string, MikeEmotion> = {
  none: "neutral",
  calm: "neutral",
  default: "neutral",
  listening: "attentive",
  interested: "attentive",
  curious: "attentive",
  focused: "attentive",
  smile: "happy",
  smiling: "happy",
  joy: "happy",
  joyful: "happy",
  pleased: "happy",
  proud: "happy",
  warm: "encouraging",
  supportive: "encouraging",
  friendly: "encouraging",
  welcoming: "encouraging",
  laugh: "amused",
  laughing: "amused",
  chuckle: "amused",
  playful: "amused",
  funny: "amused",
  excited: "surprised",
  amazed: "surprised",
  shocked: "surprised",
  wow: "surprised",
  astonished: "surprised",
  think: "thinking",
  pondering: "thinking",
  puzzled: "thinking",
  uncertain: "thinking",
  confused: "thinking",
  worried: "concerned",
  sad: "concerned",
  sympathetic: "concerned",
  empathetic: "concerned",
  apologetic: "concerned",
  stern: "serious",
  firm: "serious",
  strict: "serious",
  important: "serious",
  warning: "serious",
  frustrated: "angry",
  annoyed: "angry",
  mad: "angry",
  upset: "angry",
  displeased: "angry",
};

export function normalizeEmotion(
  value: string | null | undefined,
): MikeEmotion | null {
  if (!value) return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((MIKE_EMOTIONS as readonly string[]).includes(key)) {
    return key as MikeEmotion;
  }
  return EMOTION_ALIASES[key] ?? null;
}

/**
 * When Gemini does not tag an emotion, derive a mild one from the body
 * gesture so the face still matches what the hands are doing.
 */
export function emotionForGesture(
  gestureIntent: string | null | undefined,
): MikeEmotion {
  switch ((gestureIntent ?? "").trim().toLowerCase()) {
    case "welcome":
    case "wave":
    case "goodbye":
    case "thanks":
    case "ready":
      return "encouraging";
    case "approve":
    case "agree":
    case "together":
      return "happy";
    case "think":
    case "uncertain":
    case "confused":
    case "listen":
      return "thinking";
    case "disagree":
    case "contrast":
    case "emphasize":
      return "serious";
    case "reveal":
    case "idea":
      return "surprised";
    default:
      return "attentive";
  }
}
