import * as THREE from "three";

/**
 * Procedural "presence" layer for Mike, applied after the mixer each frame:
 *
 *  - Gaze: head/neck/eyes bias toward the camera (eye contact) or the board,
 *    with small eye saccades so the eyes never sit dead still.
 *  - Micro-motion: breathing on the spine, slow weight shifts, and small
 *    nods on stressed syllables (driven by the lipsync level).
 *
 * Everything here is a delta on top of the clip pose and is recomputed from
 * the mixer output every frame, so nothing accumulates. The caller must skip
 * update() while the mixer is paused, otherwise the deltas would stack.
 */

export type GazeMode = "camera" | "board" | "none";

/** Short physical reactions people do while presenting. */
export type MikeReaction = "laugh" | "hm" | "surprise" | "nod" | "shrug";
export const MIKE_REACTIONS: readonly MikeReaction[] = [
  "laugh",
  "hm",
  "surprise",
  "nod",
  "shrug",
];

export function normalizeReaction(value: unknown): MikeReaction | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "none") return null;
  if (raw === "chuckle" || raw === "giggle") return "laugh";
  if (raw === "hmm" || raw === "ponder") return "hm";
  if (raw === "surprised" || raw === "gasp") return "surprise";
  if (raw === "agree") return "nod";
  return (MIKE_REACTIONS as readonly string[]).includes(raw)
    ? (raw as MikeReaction)
    : null;
}

const HEAD_NAME = "CC_Base_Head";
const NECK_NAMES = ["CC_Base_NeckTwist01", "CC_Base_NeckTwist02"];
const EYE_NAMES = ["CC_Base_L_Eye", "CC_Base_R_Eye"];
const SPINE_NAMES = ["CC_Base_Spine01", "CC_Base_Spine02"];
const CLAVICLE_NAMES = ["CC_Base_L_Clavicle", "CC_Base_R_Clavicle"];

/**
 * Body posture per emotion (radians). `chest` > 0 lifts/opens the chest,
 * < 0 settles forward. `headPitch` > 0 drops the chin. `headTilt` rolls the
 * head to one side. Small on purpose: the face carries the emotion, the
 * body only needs to agree with it.
 */
type Posture = { chest: number; headPitch: number; headTilt: number };
const ZERO_POSTURE: Posture = { chest: 0, headPitch: 0, headTilt: 0 };
const EMOTION_POSTURE: Record<string, Posture> = {
  neutral: ZERO_POSTURE,
  attentive: { chest: 0.008, headPitch: 0, headTilt: 0.025 },
  happy: { chest: 0.025, headPitch: -0.015, headTilt: 0.02 },
  encouraging: { chest: 0.02, headPitch: -0.01, headTilt: 0.035 },
  amused: { chest: 0.015, headPitch: -0.02, headTilt: 0.05 },
  surprised: { chest: 0.035, headPitch: -0.03, headTilt: 0 },
  thinking: { chest: -0.005, headPitch: 0.02, headTilt: 0.07 },
  concerned: { chest: -0.015, headPitch: 0.03, headTilt: 0.03 },
  serious: { chest: 0.012, headPitch: 0.02, headTilt: 0 },
  angry: { chest: -0.025, headPitch: 0.035, headTilt: 0 },
};
// Posture eases over ~0.6 s with a brief overshoot so the change reads as a
// movement rather than a re-pose.
const POSTURE_DAMP = 5;
const POSTURE_IMPULSE_SECONDS = 0.7;
const POSTURE_IMPULSE_GAIN = 0.6;
/** Emotion changes that come with a physical reaction. */
const EMOTION_REACTION: Record<string, MikeReaction> = {
  amused: "laugh",
  surprised: "surprise",
  thinking: "hm",
};

// Listening: head tilt plus an occasional slow nod while the user talks.
const LISTEN_POSTURE: Posture = { chest: 0.006, headPitch: 0.012, headTilt: 0.055 };
const LISTEN_NOD_GAP = [3, 6.5] as const;
const LISTEN_NOD_DEPTH = 0.03;
const LISTEN_NOD_SECONDS = 0.9;

const REACTION_SECONDS: Record<MikeReaction, number> = {
  laugh: 1.0,
  hm: 1.3,
  surprise: 0.75,
  nod: 0.65,
  shrug: 0.95,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Gaze limits (radians). Head turns partway; eyes make up the rest.
const HEAD_YAW_LIMIT = 0.6;
const HEAD_PITCH_LIMIT = 0.28;
const EYE_YAW_LIMIT = 0.32;
const EYE_PITCH_LIMIT = 0.2;
const HEAD_SHARE = 0.5;
const NECK_SHARE = 0.22;

// Saccades: tiny eye jumps between fixations.
const SACCADE_GAP = [0.9, 2.6] as const;
const SACCADE_YAW = 0.045;
const SACCADE_PITCH = 0.028;

// Breathing on the spine.
const BREATH_HZ = 0.21;
const BREATH_PITCH = 0.009;

// Weight shift: slow lateral sway plus a hint of spine roll.
const SWAY_GAP = [9, 15] as const;
const SWAY_OFFSET = 0.028;
const SWAY_ROLL = 0.014;

// Speech nods: short pitch impulse on loud syllables.
const NOD_TRIGGER_LEVEL = 0.62;
const NOD_REFRACTORY = 1.4;
const NOD_CHANCE = 0.55;
const NOD_DURATION = 0.42;
const NOD_DEPTH = 0.04;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Smooth 0→1→0 bump. */
function bump(t: number): number {
  return Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1));
}

/** Fast rise, slow fall: 0→1 by `rise`, back to 0 at 1. */
function snap(t: number, rise = 0.25): number {
  if (t <= 0 || t >= 1) return 0;
  if (t < rise) return Math.sin((Math.PI / 2) * (t / rise));
  const fall = (t - rise) / (1 - rise);
  return Math.cos((Math.PI / 2) * fall);
}

export class MikePresenceRig {
  private readonly head: THREE.Bone | null;
  private readonly necks: THREE.Bone[];
  private readonly eyes: THREE.Bone[];
  private readonly spines: THREE.Bone[];
  private readonly bodyRoot: THREE.Object3D;
  private readonly baseRootX: number;
  /**
   * Eye bones are not animated by the body clips, so the mixer never
   * rewrites them. Reset to the rest pose each frame before adding the gaze
   * delta, otherwise the rotation would accumulate.
   */
  private readonly eyeRest: THREE.Quaternion[];

  private gazeMode: GazeMode = "camera";
  private gazeStrength = 0.7;
  private glanceRemaining = 0;
  private glanceReturn: GazeMode = "camera";
  private boardTarget = new THREE.Vector3(1.4, 4.6, -0.7);

  private yaw = 0;
  private pitch = 0;
  private eyeYaw = 0;
  private eyePitch = 0;

  private saccadeTimer = randomBetween(...SACCADE_GAP);
  private saccadeYaw = 0;
  private saccadePitch = 0;

  private clock = 0;
  private swayTimer = randomBetween(3, 6);
  private swaySide = 0;
  private swayCurrent = 0;

  private speaking = false;
  /** 1 at waist; lower on face/close so sway stays in-frame. */
  private shotScale = 1;
  private nodTimer = 0;
  private nodCooldown = 0;
  private lastLevel = 0;

  // Emotion posture (item 2).
  private emotion = "attentive";
  private postureTarget: Posture = EMOTION_POSTURE.attentive;
  private posture: Posture = { ...EMOTION_POSTURE.attentive };
  private impulse: Posture = { ...ZERO_POSTURE };
  private impulseTimer = 0;

  // Listening (item 4).
  private listening = false;
  private listenBlend = 0;
  private listenNodTimer = randomBetween(...LISTEN_NOD_GAP);
  private listenNodActive = 0;

  // Reactions (item 6).
  private reaction: MikeReaction | null = null;
  private reactionTimer = 0;
  private readonly clavicles: THREE.Bone[];
  /** +1 / -1 per clavicle: which way to rotate about forward to raise it. */
  private readonly clavicleSign: number[];

  private readonly headPos = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly rootQuat = new THREE.Quaternion();
  /** Head's forward axis in head-local space, measured at bind pose. */
  private readonly headForwardLocal = new THREE.Vector3(0, 0, 1);
  private readonly headForward = new THREE.Vector3();
  private readonly headRight = new THREE.Vector3();
  private readonly headQuat = new THREE.Quaternion();

  constructor(bones: Map<string, THREE.Bone>, bodyRoot: THREE.Object3D) {
    this.head = bones.get(HEAD_NAME) ?? null;
    this.necks = NECK_NAMES.map((name) => bones.get(name)).filter(
      (bone): bone is THREE.Bone => Boolean(bone),
    );
    this.eyes = EYE_NAMES.map((name) => bones.get(name)).filter(
      (bone): bone is THREE.Bone => Boolean(bone),
    );
    this.spines = SPINE_NAMES.map((name) => bones.get(name)).filter(
      (bone): bone is THREE.Bone => Boolean(bone),
    );
    this.clavicles = CLAVICLE_NAMES.map((name) => bones.get(name)).filter(
      (bone): bone is THREE.Bone => Boolean(bone),
    );
    this.bodyRoot = bodyRoot;
    this.baseRootX = bodyRoot.position.x;
    this.eyeRest = this.eyes.map((eye) => eye.quaternion.clone());

    bodyRoot.updateWorldMatrix(true, true);
    const rootQuat = bodyRoot.getWorldQuaternion(new THREE.Quaternion());
    const bodyForward = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQuat);
    const bodyRight = new THREE.Vector3().crossVectors(WORLD_UP, bodyForward).normalize();

    // At bind pose the head faces the same way as the body (+Z in model
    // space). Express that direction in head-local space so we can read the
    // head's real facing every frame regardless of bone axis conventions.
    if (this.head) {
      const headWorld = this.head.getWorldQuaternion(new THREE.Quaternion());
      this.headForwardLocal.copy(bodyForward).applyQuaternion(headWorld.invert()).normalize();
    }

    // A clavicle on the +right side raises when rotated positively about
    // forward (right-hand rule), the other side the opposite way.
    const rootPos = bodyRoot.getWorldPosition(new THREE.Vector3());
    const clavPos = new THREE.Vector3();
    this.clavicleSign = this.clavicles.map((clav) => {
      clav.getWorldPosition(clavPos).sub(rootPos);
      return clavPos.dot(bodyRight) >= 0 ? 1 : -1;
    });
  }

  /** Body agrees with the face: sets the posture target for this emotion. */
  setEmotion(emotion: string): void {
    const next = EMOTION_POSTURE[emotion] ? emotion : "attentive";
    if (next === this.emotion) return;
    const previous = this.postureTarget;
    this.emotion = next;
    this.postureTarget = EMOTION_POSTURE[next];

    const auto = EMOTION_REACTION[next];
    if (auto) {
      // The reaction carries the transition; no extra overshoot.
      this.playReaction(auto);
      this.impulseTimer = 0;
      return;
    }
    this.impulse = {
      chest: (this.postureTarget.chest - previous.chest) * POSTURE_IMPULSE_GAIN,
      headPitch: (this.postureTarget.headPitch - previous.headPitch) * POSTURE_IMPULSE_GAIN,
      headTilt: (this.postureTarget.headTilt - previous.headTilt) * POSTURE_IMPULSE_GAIN,
    };
    this.impulseTimer = POSTURE_IMPULSE_SECONDS;
  }

  currentEmotion(): string {
    return this.emotion;
  }

  /** Attentive stance while the user types or Lixia is thinking. */
  setListening(value: boolean): void {
    if (this.listening === value) return;
    this.listening = value;
    if (value) this.listenNodTimer = randomBetween(1.2, 2.5);
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Play a short physical reaction on top of whatever else is running. */
  playReaction(kind: MikeReaction): void {
    this.reaction = kind;
    this.reactionTimer = REACTION_SECONDS[kind];
  }

  setGaze(mode: GazeMode, strength?: number): void {
    this.gazeMode = mode;
    this.glanceRemaining = 0;
    if (typeof strength === "number") {
      this.gazeStrength = THREE.MathUtils.clamp(strength, 0, 1);
    }
  }

  currentGaze(): GazeMode {
    return this.glanceRemaining > 0 ? "board" : this.gazeMode;
  }

  /** Look at the board for a moment, then return to the current gaze. */
  glanceAtBoard(seconds = 2.2): void {
    if (this.glanceRemaining <= 0) this.glanceReturn = this.gazeMode;
    this.glanceRemaining = Math.max(this.glanceRemaining, seconds);
  }

  setBoardTarget(target: readonly [number, number, number]): void {
    this.boardTarget.set(target[0], target[1], target[2]);
  }

  setShotScale(scale: number): void {
    this.shotScale = THREE.MathUtils.clamp(scale, 0.2, 1.3);
  }

  setSpeaking(value: boolean): void {
    this.speaking = value;
    if (!value) {
      this.nodTimer = 0;
      this.lastLevel = 0;
    }
  }

  /** Called with the lipsync mouth level so nods land on stressed words. */
  noteSpeechLevel(level: number): void {
    if (!this.speaking || this.nodCooldown > 0 || this.nodTimer > 0) {
      this.lastLevel = level;
      return;
    }
    if (
      level >= NOD_TRIGGER_LEVEL &&
      this.lastLevel < NOD_TRIGGER_LEVEL &&
      Math.random() < NOD_CHANCE
    ) {
      this.nodTimer = NOD_DURATION;
      this.nodCooldown = NOD_REFRACTORY;
    }
    this.lastLevel = level;
  }

  private resolveTarget(
    camera: THREE.Camera,
    out: THREE.Vector3,
  ): boolean {
    const mode = this.currentGaze();
    if (mode === "none") return false;
    if (mode === "board") {
      out.copy(this.boardTarget);
      return true;
    }
    camera.getWorldPosition(out);
    return true;
  }

  update(
    delta: number,
    camera: THREE.Camera,
    facingRoot: THREE.Object3D,
  ): void {
    this.clock += delta;
    if (this.glanceRemaining > 0) {
      this.glanceRemaining -= delta;
      if (this.glanceRemaining <= 0) this.gazeMode = this.glanceReturn;
    }

    // Body facing in world space; all gaze angles are relative to it.
    facingRoot.getWorldQuaternion(this.rootQuat);
    this.forward.set(0, 0, 1).applyQuaternion(this.rootQuat);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    this.forward.normalize();
    this.right.crossVectors(WORLD_UP, this.forward).normalize();
    const bodyYaw = Math.atan2(this.forward.x, this.forward.z);

    this.updateGaze(delta, camera, bodyYaw);
    this.updateMicroMotion(delta);
    this.updatePosture(delta);
    this.updateReaction(delta);
  }

  private updatePosture(delta: number): void {
    // Ease toward the emotion posture, with the listening tilt layered on.
    this.listenBlend = THREE.MathUtils.damp(
      this.listenBlend,
      this.listening ? 1 : 0,
      4,
      delta,
    );
    const target = {
      chest: this.postureTarget.chest + LISTEN_POSTURE.chest * this.listenBlend,
      headPitch: this.postureTarget.headPitch + LISTEN_POSTURE.headPitch * this.listenBlend,
      headTilt: this.postureTarget.headTilt + LISTEN_POSTURE.headTilt * this.listenBlend,
    };
    this.posture.chest = THREE.MathUtils.damp(this.posture.chest, target.chest, POSTURE_DAMP, delta);
    this.posture.headPitch = THREE.MathUtils.damp(
      this.posture.headPitch,
      target.headPitch,
      POSTURE_DAMP,
      delta,
    );
    this.posture.headTilt = THREE.MathUtils.damp(
      this.posture.headTilt,
      target.headTilt,
      POSTURE_DAMP,
      delta,
    );

    let overshoot = 0;
    if (this.impulseTimer > 0) {
      overshoot = bump(1 - this.impulseTimer / POSTURE_IMPULSE_SECONDS);
      this.impulseTimer -= delta;
    }

    // Slow listening nods.
    let listenNod = 0;
    if (this.listening && this.listenBlend > 0.5) {
      if (this.listenNodActive > 0) {
        listenNod = bump(1 - this.listenNodActive / LISTEN_NOD_SECONDS) * LISTEN_NOD_DEPTH;
        this.listenNodActive -= delta;
      } else {
        this.listenNodTimer -= delta;
        if (this.listenNodTimer <= 0) {
          this.listenNodTimer = randomBetween(...LISTEN_NOD_GAP);
          this.listenNodActive = LISTEN_NOD_SECONDS;
        }
      }
    } else {
      this.listenNodActive = 0;
    }

    const chest = this.posture.chest + this.impulse.chest * overshoot;
    const headPitch = this.posture.headPitch + this.impulse.headPitch * overshoot + listenNod;
    const headTilt = this.posture.headTilt + this.impulse.headTilt * overshoot;
    this.applyBodyPose(chest, headPitch, headTilt, 0);
  }

  private updateReaction(delta: number): void {
    const kind = this.reaction;
    if (!kind || this.reactionTimer <= 0) {
      this.reaction = null;
      return;
    }
    const total = REACTION_SECONDS[kind];
    const t = 1 - this.reactionTimer / total;
    this.reactionTimer -= delta;

    let chest = 0;
    let headPitch = 0;
    let headTilt = 0;
    let shoulders = 0;
    switch (kind) {
      case "laugh": {
        // Two quick forward pulses that fade, shoulders bouncing with them.
        const pulse = Math.max(0, Math.sin(Math.PI * 4 * t));
        const fade = 1 - t * 0.6;
        chest = -0.03 * pulse * fade;
        headPitch = 0.035 * pulse * fade - 0.012 * bump(t);
        shoulders = 0.045 * pulse * fade;
        headTilt = 0.02 * bump(t);
        break;
      }
      case "hm": {
        // Head tilts and lifts a little, as if weighing the thought.
        const env = bump(t);
        headTilt = 0.075 * env;
        headPitch = -0.02 * env;
        chest = 0.006 * env;
        break;
      }
      case "surprise": {
        const env = snap(t, 0.22);
        chest = 0.05 * env;
        headPitch = -0.045 * env;
        shoulders = 0.03 * env;
        break;
      }
      case "nod": {
        // Two deliberate nods.
        headPitch = 0.05 * Math.max(0, Math.sin(Math.PI * 2 * t));
        break;
      }
      case "shrug": {
        const env = bump(t);
        shoulders = 0.09 * env;
        headTilt = 0.04 * env;
        chest = -0.01 * env;
        break;
      }
    }
    this.applyBodyPose(chest, headPitch, headTilt, shoulders);
  }

  /** Write a posture delta onto spine, head and clavicles. */
  private applyBodyPose(
    chest: number,
    headPitch: number,
    headTilt: number,
    shoulders: number,
  ): void {
    for (const [index, spine] of this.spines.entries()) {
      // Split the chest motion over the spine chain, upper taking more.
      spine.rotateOnWorldAxis(this.right, -chest * (index === 0 ? 0.4 : 0.6));
    }
    if (this.head) {
      this.head.rotateOnWorldAxis(this.headRight, headPitch);
      this.head.rotateOnWorldAxis(this.headForward, headTilt);
    }
    if (shoulders !== 0) {
      for (const [index, clav] of this.clavicles.entries()) {
        clav.rotateOnWorldAxis(this.forward, shoulders * this.clavicleSign[index]);
      }
    }
  }

  private updateGaze(
    delta: number,
    camera: THREE.Camera,
    bodyYaw: number,
  ): void {
    const head = this.head;
    if (!head) return;

    // Where the head is looking right now (mixer pose, before our delta).
    head.getWorldQuaternion(this.headQuat);
    this.headForward.copy(this.headForwardLocal).applyQuaternion(this.headQuat);
    const headYawNow = Math.atan2(this.headForward.x, this.headForward.z);
    const headPitchNow = Math.atan2(
      this.headForward.y,
      Math.hypot(this.headForward.x, this.headForward.z),
    );

    // Error from the current head facing to the target, scaled by strength.
    // The correction is re-measured every frame from the mixer pose, so it
    // follows the clip's own head motion instead of stacking on it.
    let targetYaw = 0;
    let targetPitch = 0;
    const hasTarget = this.resolveTarget(camera, this.toTarget);
    if (hasTarget) {
      head.getWorldPosition(this.headPos);
      this.toTarget.sub(this.headPos);
      const horizontal = Math.hypot(this.toTarget.x, this.toTarget.z);
      const worldYaw = Math.atan2(this.toTarget.x, this.toTarget.z);
      const worldPitch = Math.atan2(this.toTarget.y, horizontal);
      // Never ask the head to turn further than the body could plausibly allow.
      const yawFromBody = wrapAngle(worldYaw - bodyYaw);
      if (Math.abs(yawFromBody) < Math.PI * 0.6) {
        targetYaw = wrapAngle(worldYaw - headYawNow) * this.gazeStrength;
        targetPitch = (worldPitch - headPitchNow) * this.gazeStrength;
      }
    }

    // Head/neck take a share of the turn, clamped; eyes take the rest.
    const headYawGoal = THREE.MathUtils.clamp(
      targetYaw * (HEAD_SHARE + NECK_SHARE),
      -HEAD_YAW_LIMIT,
      HEAD_YAW_LIMIT,
    );
    const headPitchGoal = THREE.MathUtils.clamp(
      targetPitch * (HEAD_SHARE + NECK_SHARE),
      -HEAD_PITCH_LIMIT,
      HEAD_PITCH_LIMIT,
    );
    this.yaw = THREE.MathUtils.damp(this.yaw, headYawGoal, 4.5, delta);
    this.pitch = THREE.MathUtils.damp(this.pitch, headPitchGoal, 5, delta);

    // Saccades: re-aim the eyes slightly every so often.
    this.saccadeTimer -= delta;
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = randomBetween(...SACCADE_GAP);
      this.saccadeYaw = randomBetween(-SACCADE_YAW, SACCADE_YAW);
      this.saccadePitch = randomBetween(-SACCADE_PITCH, SACCADE_PITCH);
    }
    const eyeYawGoal = THREE.MathUtils.clamp(
      targetYaw - this.yaw + this.saccadeYaw,
      -EYE_YAW_LIMIT,
      EYE_YAW_LIMIT,
    );
    const eyePitchGoal = THREE.MathUtils.clamp(
      targetPitch - this.pitch + this.saccadePitch,
      -EYE_PITCH_LIMIT,
      EYE_PITCH_LIMIT,
    );
    // Eyes move much faster than the head.
    this.eyeYaw = THREE.MathUtils.damp(this.eyeYaw, eyeYawGoal, 18, delta);
    this.eyePitch = THREE.MathUtils.damp(this.eyePitch, eyePitchGoal, 18, delta);

    // Nod impulse rides on top of the head pitch.
    let nod = 0;
    if (this.nodCooldown > 0) this.nodCooldown -= delta;
    if (this.nodTimer > 0) {
      const t = 1 - this.nodTimer / NOD_DURATION;
      nod = Math.sin(Math.PI * t) * NOD_DEPTH;
      this.nodTimer -= delta;
    }

    const neckShare = this.necks.length > 0 ? NECK_SHARE / (HEAD_SHARE + NECK_SHARE) : 0;
    const headShare = 1 - neckShare;

    // Pitch about the head's own right axis so a turned head still nods
    // forward/back rather than rolling.
    this.headRight.crossVectors(WORLD_UP, this.headForward).normalize();
    if (this.headRight.lengthSq() < 1e-6) this.headRight.copy(this.right);

    head.rotateOnWorldAxis(WORLD_UP, this.yaw * headShare);
    head.rotateOnWorldAxis(this.headRight, -(this.pitch * headShare) + nod);
    for (const neck of this.necks) {
      neck.rotateOnWorldAxis(WORLD_UP, (this.yaw * neckShare) / this.necks.length);
      neck.rotateOnWorldAxis(this.headRight, -(this.pitch * neckShare) / this.necks.length);
    }
    for (const [index, eye] of this.eyes.entries()) {
      eye.quaternion.copy(this.eyeRest[index]);
      eye.rotateOnWorldAxis(WORLD_UP, this.eyeYaw);
      eye.rotateOnWorldAxis(this.headRight, -this.eyePitch);
    }
  }

  private updateMicroMotion(delta: number): void {
    // Breathing: gentle pitch on the spine, opposite hint on the head so the
    // chest rises without the face bobbing.
    const breath = Math.sin(this.clock * Math.PI * 2 * BREATH_HZ);
    for (const [index, spine] of this.spines.entries()) {
      spine.rotateOnWorldAxis(this.right, -breath * BREATH_PITCH * (index === 0 ? 0.6 : 1));
    }
    this.head?.rotateOnWorldAxis(this.right, breath * BREATH_PITCH * 0.5);

    // Weight shift: pick a side now and then, ease the body over to it.
    this.swayTimer -= delta;
    if (this.swayTimer <= 0) {
      this.swayTimer = randomBetween(...SWAY_GAP);
      this.swaySide = this.swaySide === 0 ? (Math.random() < 0.5 ? -1 : 1) : -this.swaySide;
      if (Math.random() < 0.3) this.swaySide = 0;
    }
    this.swayCurrent = THREE.MathUtils.damp(this.swayCurrent, this.swaySide, 1.1, delta);
    this.bodyRoot.position.x =
      this.baseRootX + this.swayCurrent * SWAY_OFFSET * this.shotScale;
    const roll = this.swayCurrent * SWAY_ROLL * this.shotScale;
    if (this.spines[0]) {
      this.spines[0].rotateOnWorldAxis(this.forward, roll);
    }
    this.head?.rotateOnWorldAxis(this.forward, -roll * 0.5);
  }
}
