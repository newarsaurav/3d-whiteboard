import * as THREE from "three";

import {
  EMOTION_PRESETS,
  type MikeEmotion,
} from "@/lib/facialExpressions";

type MorphSlot = { influences: number[]; index: number };

const ATTACK_RATE = 9;
const RELEASE_RATE = 4.5;
const BLINK_CLOSE_SECONDS = 0.09;
const BLINK_OPEN_SECONDS = 0.16;
const BLINK_MIN_GAP = 2.4;
const BLINK_MAX_GAP = 6.5;

/** Lipsync tuning. Levels come from TTS PCM RMS (typically 0.03–0.25). */
const MOUTH_NOISE_FLOOR = 0.012;
const MOUTH_GAIN = 5.5;
const MOUTH_ATTACK_RATE = 28;
const MOUTH_RELEASE_RATE = 14;
const MOUTH_MAX_JAW = 0.32;
const MOUTH_MAX_OPEN = 0.75;
/** Pseudo-syllable cadence for the browser-voice fallback (no audio tap). */
const SYNTHETIC_SYLLABLE_SECONDS = 0.16;

/** Something that can be polled for the current speech loudness. */
export type LipsyncSource =
  | { kind: "analyser"; node: AnalyserNode }
  | { kind: "synthetic" }
  | null;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Drives Character Creator face morphs on Mike's meshes.
 *
 * Body clips only animate bones, so the mixer never touches
 * morphTargetInfluences and this layer owns them outright:
 *  - an emotion preset that eases in, holds, then settles to a sustain level
 *  - an ambient blink loop so the face never looks frozen
 */
export class MikeFaceRig {
  private readonly slots = new Map<string, MorphSlot[]>();
  private readonly current = new Map<string, number>();
  private readonly target = new Map<string, number>();

  private emotion: MikeEmotion = "attentive";
  private intensity = 1;
  private emotionAge = 0;

  private blinkTimer = randomBetween(1.2, 3);
  private blinkPhase = 0;
  private blinking = false;
  private doubleBlinkPending = false;

  private lipsync: LipsyncSource = null;
  private timeDomain: Float32Array<ArrayBuffer> | null = null;
  private frequency: Uint8Array<ArrayBuffer> | null = null;
  private mouthLevel = 0;
  /** 0 = rounded "oo", 1 = wide "ee". */
  private mouthShape = 0.5;
  private syntheticClock = 0;
  private syntheticTarget = 0;

  constructor(root: THREE.Object3D) {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const dictionary = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;
      if (!dictionary || !influences) return;
      for (const [name, index] of Object.entries(dictionary)) {
        const list = this.slots.get(name) ?? [];
        list.push({ influences, index });
        this.slots.set(name, list);
      }
    });
  }

  get morphCount(): number {
    return this.slots.size;
  }

  morphNames(): string[] {
    return [...this.slots.keys()].sort();
  }

  currentEmotion(): MikeEmotion {
    return this.emotion;
  }

  setEmotion(emotion: MikeEmotion, intensity = 1): void {
    const changed = emotion !== this.emotion;
    this.emotion = emotion;
    this.intensity = THREE.MathUtils.clamp(intensity, 0, 1);
    if (changed) this.emotionAge = 0;
    this.refreshTargets();
  }

  /**
   * Point the mouth at a loudness source. Pass an AnalyserNode wired into the
   * TTS graph for real lipsync, "synthetic" for browser speechSynthesis (no
   * audio access), or null to close the mouth.
   */
  setLipsync(source: LipsyncSource): void {
    this.lipsync = source;
    if (source?.kind === "analyser") {
      const node = source.node;
      if (!this.timeDomain || this.timeDomain.length !== node.fftSize) {
        this.timeDomain = new Float32Array(node.fftSize);
      }
      if (
        !this.frequency ||
        this.frequency.length !== node.frequencyBinCount
      ) {
        this.frequency = new Uint8Array(node.frequencyBinCount);
      }
    }
    if (!source) {
      this.syntheticClock = 0;
      this.syntheticTarget = 0;
    }
  }

  currentMouthLevel(): number {
    return this.mouthLevel;
  }

  private sampleLoudness(delta: number): { level: number; shape: number } {
    const source = this.lipsync;
    if (!source) return { level: 0, shape: this.mouthShape };

    if (source.kind === "synthetic") {
      this.syntheticClock -= delta;
      if (this.syntheticClock <= 0) {
        this.syntheticClock = randomBetween(
          SYNTHETIC_SYLLABLE_SECONDS * 0.6,
          SYNTHETIC_SYLLABLE_SECONDS * 1.5,
        );
        // Mostly open syllables with occasional closures (consonants/pauses).
        this.syntheticTarget =
          Math.random() < 0.22 ? 0 : randomBetween(0.35, 1);
        this.mouthShape = randomBetween(0.2, 0.9);
      }
      return { level: this.syntheticTarget, shape: this.mouthShape };
    }

    const node = source.node;
    const samples = this.timeDomain;
    if (!samples) return { level: 0, shape: this.mouthShape };
    node.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    const level = THREE.MathUtils.clamp(
      (rms - MOUTH_NOISE_FLOOR) * MOUTH_GAIN,
      0,
      1,
    );

    // Spectral tilt: energy above ~1.2 kHz versus below picks the vowel
    // shape. Bright = wide (ee/ih), dark = rounded (oh/oo).
    let shape = this.mouthShape;
    const bins = this.frequency;
    if (bins && level > 0.05) {
      node.getByteFrequencyData(bins);
      const nyquist = node.context.sampleRate / 2;
      const split = Math.max(
        1,
        Math.floor((1200 / nyquist) * bins.length),
      );
      const top = Math.min(
        bins.length,
        Math.floor((4000 / nyquist) * bins.length),
      );
      let low = 0;
      let high = 0;
      for (let index = 1; index < split; index += 1) low += bins[index];
      for (let index = split; index < top; index += 1) high += bins[index];
      const lowAvg = low / Math.max(1, split - 1);
      const highAvg = high / Math.max(1, top - split);
      const total = lowAvg + highAvg;
      if (total > 1) {
        shape = THREE.MathUtils.clamp(
          (highAvg / total) * 1.6,
          0,
          1,
        );
      }
    }
    return { level, shape };
  }

  private applyMouth(delta: number): void {
    const { level, shape } = this.sampleLoudness(delta);
    const rate = level > this.mouthLevel ? MOUTH_ATTACK_RATE : MOUTH_RELEASE_RATE;
    this.mouthLevel = THREE.MathUtils.damp(this.mouthLevel, level, rate, delta);
    this.mouthShape = THREE.MathUtils.damp(this.mouthShape, shape, 10, delta);

    if (this.mouthLevel < 0.002) return;

    const open = Math.pow(this.mouthLevel, 0.8);
    const wide = this.mouthShape;
    const targets: Array<[string, number]> = [
      ["Jaw_Open", open * MOUTH_MAX_JAW * (1 - wide * 0.35)],
      ["V_Open", open * MOUTH_MAX_OPEN * (1 - wide * 0.45)],
      ["V_Lip_Open", open * 0.4],
      ["V_Wide", open * wide * 0.7],
      ["V_Tight_O", open * (1 - wide) * 0.45],
      ["Mouth_Drop_Lower", open * 0.18],
    ];
    for (const [name, weight] of targets) {
      if (weight <= 0.0005) continue;
      for (const slot of this.resolveSlots(name)) {
        slot.influences[slot.index] = Math.max(
          slot.influences[slot.index],
          weight,
        );
      }
    }
  }

  private resolveSlots(name: string): MorphSlot[] {
    const direct = this.slots.get(name);
    if (direct) return direct;
    const left = this.slots.get(`${name}_L`) ?? [];
    const right = this.slots.get(`${name}_R`) ?? [];
    return [...left, ...right];
  }

  private expandName(name: string): string[] {
    if (this.slots.has(name)) return [name];
    const pair: string[] = [];
    if (this.slots.has(`${name}_L`)) pair.push(`${name}_L`);
    if (this.slots.has(`${name}_R`)) pair.push(`${name}_R`);
    return pair;
  }

  private refreshTargets(): void {
    const preset = EMOTION_PRESETS[this.emotion];
    const settle =
      preset.peakSeconds <= 0
        ? 1
        : THREE.MathUtils.lerp(
            1,
            preset.sustain,
            THREE.MathUtils.smoothstep(
              this.emotionAge,
              preset.peakSeconds,
              preset.peakSeconds + 2.2,
            ),
          );
    const scale = this.intensity * settle;

    for (const key of this.target.keys()) {
      this.target.set(key, 0);
    }
    for (const [name, weight] of Object.entries(preset.morphs)) {
      for (const morph of this.expandName(name)) {
        this.target.set(morph, Math.max(this.target.get(morph) ?? 0, weight * scale));
      }
    }
  }

  private blinkWeight(): number {
    if (!this.blinking) return 0;
    if (this.blinkPhase < BLINK_CLOSE_SECONDS) {
      return THREE.MathUtils.smoothstep(this.blinkPhase, 0, BLINK_CLOSE_SECONDS);
    }
    const opening = this.blinkPhase - BLINK_CLOSE_SECONDS;
    return 1 - THREE.MathUtils.smoothstep(opening, 0, BLINK_OPEN_SECONDS);
  }

  private advanceBlink(delta: number): void {
    if (this.blinking) {
      this.blinkPhase += delta;
      if (this.blinkPhase >= BLINK_CLOSE_SECONDS + BLINK_OPEN_SECONDS) {
        this.blinking = false;
        this.blinkPhase = 0;
        if (this.doubleBlinkPending) {
          this.doubleBlinkPending = false;
          this.blinkTimer = 0.18;
        } else {
          this.blinkTimer = randomBetween(BLINK_MIN_GAP, BLINK_MAX_GAP);
        }
      }
      return;
    }
    this.blinkTimer -= delta;
    if (this.blinkTimer <= 0) {
      this.blinking = true;
      this.blinkPhase = 0;
      this.doubleBlinkPending = Math.random() < 0.14;
    }
  }

  update(delta: number): void {
    if (this.slots.size === 0) return;

    this.emotionAge += delta;
    this.refreshTargets();
    this.advanceBlink(delta);

    for (const [name, slots] of this.slots) {
      const goal = this.target.get(name) ?? 0;
      const now = this.current.get(name) ?? 0;
      const rate = goal > now ? ATTACK_RATE : RELEASE_RATE;
      const next =
        Math.abs(goal - now) < 0.0005
          ? goal
          : THREE.MathUtils.damp(now, goal, rate, delta);
      if (next !== now) this.current.set(name, next);
      // Always write so blink overrides from the previous frame are cleared.
      for (const slot of slots) {
        slot.influences[slot.index] = next;
      }
    }

    const blink = this.blinkWeight();
    if (blink > 0) {
      for (const slot of this.resolveSlots("Eye_Blink")) {
        slot.influences[slot.index] = Math.max(
          slot.influences[slot.index],
          blink,
        );
      }
    }

    this.applyMouth(delta);
  }
}
