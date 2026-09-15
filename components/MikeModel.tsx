"use client";

/**
 * Animated Mike for whiteboard mode.
 *
 * Loads the canonical MIKE_RealLixia.glb and plays pre-baked animation clips
 * from the final-approved Lixia presentation pack (public/lixia-animation/v2)
 * through the @lixia/mike-animation runtime: registry admission, priority
 * scheduling, crossfades, and masked upper-body gesture playback.
 *
 * The clip-binding logic (hierarchy binding, unit scaling, additive upper
 * body masking) is ported from the lixia-movements viewer bridge. Clips are baked
 * for this exact skeleton — no runtime retargeting happens here.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DEFAULT_IDLE_ANIMATION_ID } from "@/lib/idleAnimation";
import {
  animationClipCache,
  animationRegistry,
  createMikeAnimationFeature,
  createPlaybackQueue,
  createThreeMikeExecutor,
  createVersionedAssetResolver,
  PLAYBACK_STATES,
} from "@lixia/mike-animation";
import type {
  MikeAnimationFeature,
  PlaybackEvent,
  PlaybackQueue,
  AnimationRecord,
} from "@lixia/mike-animation";

export interface MikeBounds {
  feetY: number;
  headY: number;
  waistY: number;
  centerX: number;
  centerZ: number;
}
export interface MikeSpeakingOptions {
  /** Clip to play first for this speech segment (bound to this audio). */
  preferredAnimationId?: string | null;
  /** Approximate remaining speech time; fillers stop after this. */
  estimatedDurationSec?: number;
  /**
   * Force the preferred clip even if it matches the last animation id
   * (explain → talk both use seg_377 must still replay).
   */
  forcePreferred?: boolean;
  /** Glance toward the whiteboard during this speech. */
  lookAtBoard?: boolean;
}

export type MikeIdleMode = "rest" | "think" | "listen";

export interface MikeAnimationApi {
  playAnimation(
    animationId: string,
    options?: { repeats?: number; loop?: boolean },
  ): Promise<boolean>;
  playGesture(
    animationId: string,
    options?: { repeats?: number; loop?: boolean },
  ): Promise<boolean>;
  playWaiting(): void;
  prepareSpeech(options?: MikeSpeakingOptions): Promise<boolean>;
  setSpeaking(value: boolean, options?: MikeSpeakingOptions): void;
  setIdleMode(mode: MikeIdleMode): void;
  setLookAtBoard(enabled: boolean, strength?: number): void;
  setPaused(value: boolean): void;
  stop(): void;
  registryRecord(animationId: string): AnimationRecord | null;
  subscribePlayback(listener: (event: PlaybackEvent) => void): () => void;
}

interface MikeModelProps {
  onMeasured?: (bounds: MikeBounds) => void;
  onReady?: (api: MikeAnimationApi) => void;
  lookTarget?: [number, number, number] | null;
  lookStrength?: number;
}

export const mikeAssets = createVersionedAssetResolver({
  baseUrl: "/lixia-animation/v2",
});

/** Explaining-hand pool only. Nods/shrugs are not used as talk fillers. */
const SPEAKING_FILLER_IDS = [
  "seg_377", // Hands Explain
  "seg_379", // Hands Explain 3
  "seg_380", // Hands Explain 4
  "seg_373", // Hands Emphasis
  "seg_374", // Hands Emphasis 2
  "seg_375", // Hands Emphasis 4
  "seg_369", // Hands Draw Outline
  "seg_371", // Hands Draw Outline 3
  "seg_372", // Hands Draw Outline 4
  "seg_456", // Palm Offer
  "seg_457", // Palm Offer 2
  "seg_388", // Hands Reveal
  "seg_389", // Hands Reveal 2
  "seg_469", // Palms Balance
  "seg_481", // Palms Expand
  "seg_485", // Palms Front
  "seg_488", // Palms Overturn
  "seg_504", // Palms Up Low
  "seg_391", // Hands Rise
  "seg_392", // Hands Rise 2
  "seg_413", // Hands Unite
  "seg_364", // Hands Divide
  "seg_472", // Palms Boundary
  "seg_492", // Palms Reverse / Contrast
] as const;

const SPEECH_HOLD_SECONDS = 2.05;
const SPEECH_FADE_SECONDS = 0.32;

function shuffleIds(ids: string[]): string[] {
  const next = [...ids];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = next[index];
    next[index] = next[swap];
    next[swap] = current;
  }
  return next;
}

function capClipDuration(
  clip: THREE.AnimationClip,
  maxSeconds: number,
): number {
  if (clip.duration <= maxSeconds + 0.05) return clip.duration;
  for (const track of clip.tracks) {
    track.trim(0, maxSeconds);
  }
  clip.duration = maxSeconds;
  clip.resetDuration();
  return clip.duration;
}

function buildSpeechCandidateIds(preferred: string): string[] {
  const pool = shuffleIds(
    SPEAKING_FILLER_IDS.filter((id) => id !== preferred),
  );
  return [preferred, ...pool];
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOOK_HEAD_POS = new THREE.Vector3();
const LOOK_OFFSET = new THREE.Vector3();
const LOOK_HEAD_NAMES = ["CC_Base_Head"];
const LOOK_NECK_NAMES = ["CC_Base_NeckTwist01", "CC_Base_NeckTwist02"];
const LOOK_EYE_NAMES = ["CC_Base_L_Eye", "CC_Base_R_Eye"];

type PreparedSpeech = {
  key: string;
  items: Array<{
    name: string;
    animationId: string;
    repeats: number;
    fade: number;
    transitionLeadSeconds: number;
  }>;
};

const MODEL_POSITION: [number, number, number] = [-3.1, 0, 1.0];
const MODEL_ROTATION: [number, number, number] = [0, 0.25, 0];
const STUDIO_FLOOR_Y = 0.02;
const FOOT_BOX = new THREE.Box3();

// Mike's height in scene units. The board layout adapts to the measured
// bounds, so this only controls his size relative to the studio/camera.
const SCENE_HEIGHT = 5.4;

const FINGER_BONE = /^CC_Base_[LR]_(?:Thumb|Index|Mid|Ring|Pinky)[123]$/;
const NATURAL_FINGER_STRENGTH = 0.65;
const UPPER_BODY_BONE =
  /^CC_Base_(?:Spine0[123]|NeckTwist\d+|Head|JawRoot|FacialBone|[LR]_(?:Clavicle|Upperarm.*|Forearm.*|Hand|Thumb\d|Index\d|Mid\d|Ring\d|Pinky\d))$/;
const WAIST_BONE_NAMES = ["CC_Base_Waist", "CC_Base_Hip"];
const WAIST_HEIGHT_RATIO = 0.42;

type BodyLayer = "full_body" | "upper_body";

/** Remove only genuinely motionless lead-in/tail frames from gesture clips. */
function trimStaticGestureEdges(clip: THREE.AnimationClip): THREE.AnimationClip {
  let firstMotion = clip.duration;
  let lastMotion = 0;

  for (const track of clip.tracks) {
    if (!track.name.endsWith(".quaternion") || track.getValueSize() !== 4) continue;
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion();
    for (let key = 1; key < track.times.length; key += 1) {
      q0.fromArray(track.values, (key - 1) * 4).normalize();
      q1.fromArray(track.values, key * 4).normalize();
      // Ignore capture jitter; 0.12 degrees between samples is visible motion.
      if (q0.angleTo(q1) < THREE.MathUtils.degToRad(0.12)) continue;
      firstMotion = Math.min(firstMotion, track.times[key - 1]);
      lastMotion = Math.max(lastMotion, track.times[key]);
    }
  }

  if (lastMotion <= firstMotion) return clip;
  const start = Math.max(0, firstMotion - 0.12);
  const end = Math.min(clip.duration, lastMotion + 0.16);
  // Small holds are natural. Only remove pauses long enough to look frozen.
  if (start < 0.3 && clip.duration - end < 0.3) return clip;

  const trimmed = clip.clone();
  for (const track of trimmed.tracks) {
    track.trim(start, end);
    for (let index = 0; index < track.times.length; index += 1) {
      track.times[index] -= start;
    }
  }
  trimmed.duration = end - start;
  trimmed.resetDuration();
  return trimmed;
}

function findWaistBone(root: THREE.Object3D | null): THREE.Bone | null {
  const bones = getDrivingBones(root);
  for (const name of WAIST_BONE_NAMES) {
    const bone = bones.get(name);
    if (bone) return bone;
  }
  return null;
}

/** Select real outer bones, not FBXLoader's same-named skin wrappers. */
function getDrivingBones(root: THREE.Object3D | null): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  root?.traverse((node) => {
    const bone = node as THREE.Bone;
    if (bone.isBone && bone.parent?.name !== bone.name) {
      bones.set(bone.name, bone);
    }
  });
  return bones;
}

function dampQuaternionTrack(
  track: THREE.KeyframeTrack,
  restQuaternion: THREE.Quaternion,
  strength: number,
): THREE.KeyframeTrack {
  const result = track.clone();
  const animated = new THREE.Quaternion();
  const corrected = new THREE.Quaternion();
  for (let i = 0; i < result.values.length; i += 4) {
    animated.fromArray(result.values, i).normalize();
    corrected.copy(restQuaternion).slerp(animated, strength).normalize();
    corrected.toArray(result.values, i);
  }
  return result;
}

/**
 * Baked FBX clips store bone positions in centimetres while the GLB uses
 * metres. Derive the factor from the median ratio between each bone's rest
 * offset and the clip's first-frame value (~1 when units already agree).
 */
function clipUnitScale(
  clip: THREE.AnimationClip,
  drivingBones: Map<string, THREE.Bone>,
): number {
  const ratios: number[] = [];
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const node = track.name.slice(0, track.name.indexOf("."));
    const target = drivingBones.get(node);
    if (!target) continue;
    const rest = target.position.length();
    const first = Math.hypot(track.values[0], track.values[1], track.values[2]);
    if (rest > 0.01 && first > 0.001) ratios.push(first / rest);
  }
  if (!ratios.length) return 1;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return median > 1e-6 ? 1 / median : 1;
}

/** Bind baked tracks to the live Mike hierarchy and preserve root translation. */
function toHierarchyClip(
  clip: THREE.AnimationClip,
  drivingBones: Map<string, THREE.Bone>,
  fingerStrength = 1,
  layer: BodyLayer = "full_body",
): THREE.AnimationClip | null {
  if (!clip?.tracks?.length || !drivingBones.size) return null;
  const unitScale = clipUnitScale(clip, drivingBones);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.indexOf(".");
    if (dot < 0) continue;
    const node = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    if (node === "Armature" || !["position", "quaternion", "scale"].includes(prop)) {
      continue;
    }
    if (layer === "upper_body" && !UPPER_BODY_BONE.test(node)) continue;
    const target = drivingBones.get(node);
    if (!target) continue;
    const isRootBone = Boolean(target.parent && !(target.parent as THREE.Bone).isBone);
    const useFingerStrength =
      layer === "upper_body" ? 1 : fingerStrength;

    const next =
      prop === "quaternion" && FINGER_BONE.test(node) && useFingerStrength < 1
        ? dampQuaternionTrack(track, target.quaternion, useFingerStrength)
        : track.clone();

    // FBX clips and the GLB character put the up-axis conversion in different
    // places. Re-express the root bone's rotation as "GLB rest plus the
    // clip's own delta from frame 0" so the body never tips over 90 degrees.
    if (prop === "quaternion" && isRootBone && Math.abs(unitScale - 1) > 0.05) {
      const firstInverse = new THREE.Quaternion()
        .fromArray(next.values, 0)
        .normalize()
        .invert();
      const rest = target.quaternion.clone();
      const q = new THREE.Quaternion();
      for (let i = 0; i < next.values.length; i += 4) {
        q.fromArray(next.values, i).normalize();
        q.premultiply(firstInverse).premultiply(rest);
        q.toArray(next.values, i);
      }
    }

    // Keep motion relative to Mike's rest location so clips do not jump.
    if (prop === "position" && next.getValueSize() === 3 && next.values.length >= 3) {
      for (let i = 0; i < next.values.length; i++) next.values[i] *= unitScale;
      const offsetX = target.position.x - next.values[0];
      const offsetY = target.position.y - next.values[1];
      // Mike's CC armature maps local Z to world height. Preserve it so floor
      // clips keep their baked standing/floor level.
      for (let frame = 0; frame < next.values.length; frame += 3) {
        next.values[frame] += offsetX;
        next.values[frame + 1] += offsetY;
      }
    }
    next.name = `${target.uuid}.${prop}`;
    tracks.push(next);
  }
  if (!tracks.length) return null;
  // Upper-body clips replace only arm/spine/head tracks. Do not convert
  // them to additive deltas — that stacked on the talk pose and twisted
  // the arms. Legs stay on the looping idle underneath.
  const playable = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  return layer === "upper_body" ? trimStaticGestureEdges(playable) : playable;
}

function tuneMikeMaterials(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const isHair = /hair|afro|beard/i.test(mesh.name);
    const isClothing = /jacket|converse|_mesh/i.test(mesh.name);
    const isEye = /eye/i.test(mesh.name);
    const isTeeth = /teeth/i.test(mesh.name);
    const isTongue = /tongue/i.test(mesh.name);
    const tune = (material: THREE.Material) => {
      const next = material.clone() as THREE.Material & {
        transparent?: boolean;
        opacity?: number;
        depthWrite?: boolean;
        alphaTest?: number;
        side?: THREE.Side;
      };
      if (next instanceof THREE.MeshPhongMaterial) {
        if (isHair) {
          next.specular.setHex(0x080808);
          next.shininess = 1;
        } else if (isClothing) {
          next.specular.setHex(0x101010);
          next.shininess = 3;
        } else if (isEye) {
          next.specular.setHex(0x555555);
          next.shininess = 18;
        } else if (isTeeth) {
          next.specular.setHex(0x303030);
          next.shininess = 10;
        } else if (isTongue) {
          next.specular.setHex(0x202020);
          next.shininess = 6;
        } else {
          next.specular.setHex(0x242424);
          next.shininess = 8;
        }
      }
      if (isHair) {
        // Hair cards use soft semi-transparent strand textures; keep real
        // alpha blending so overlapping cards don't punch holes.
        next.side = THREE.DoubleSide;
        next.transparent = true;
        next.depthWrite = false;
        next.alphaTest = 0.08;
      } else if (next.transparent && (next.opacity ?? 1) >= 1) {
        // The GLB atlas material ships transparent with depthWrite off, so
        // closer meshes lose the depth race and disappear. Opacity is 1 —
        // render as opaque alpha-cutout instead.
        next.transparent = false;
        next.depthWrite = true;
        next.alphaTest = Math.max(next.alphaTest ?? 0, 0.35);
      }
      next.needsUpdate = true;
      return next;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(tune)
      : tune(mesh.material);
  });
}

/** Measure the current skinned pose rather than the bind-pose geometry box. */
function measureAnimatedBounds(model: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  model.updateMatrixWorld(true);
  model.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.isSkinnedMesh && typeof mesh.computeBoundingBox === "function") {
      mesh.skeleton?.update?.();
      mesh.computeBoundingBox();
    } else if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    const childBox = mesh.boundingBox ?? mesh.geometry.boundingBox;
    if (childBox) box.union(childBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

/** Scale to SCENE_HEIGHT, stand on y=0, center on x/z. */
function fitMike(root: THREE.Object3D): THREE.Object3D {
  const model = skeletonClone(root);
  model.position.set(0, 0, 0);
  model.scale.set(1, 1, 1);
  model.rotation.set(0, 0, 0);

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = true;
    }
  });

  const bounds = measureAnimatedBounds(model);
  const size = bounds.getSize(new THREE.Vector3());
  const height = size.y > 1e-4 ? size.y : Math.max(size.x, size.y, size.z);

  let scale = height > 1e-4 ? SCENE_HEIGHT / height : 1;
  scale = Math.min(Math.max(scale, 0.001), 10);

  const center = bounds.isEmpty()
    ? new THREE.Vector3()
    : bounds.getCenter(new THREE.Vector3());
  const groundY = bounds.isEmpty() ? 0 : -bounds.min.y * scale;
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, groundY, -center.z * scale);
  tuneMikeMaterials(model);
  model.updateMatrixWorld(true);
  return model;
}

function loadCharacter(url: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

export default function MikeModel({
  onMeasured,
  onReady,
  lookTarget = null,
  lookStrength = 0.2,
}: MikeModelProps) {
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const groupRef = useRef<THREE.Group>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const basePositionRef = useRef<THREE.Vector3 | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Record<string, THREE.AnimationAction>>({});
  const currentAction = useRef<THREE.AnimationAction | null>(null);
  const upperBodyActions = useRef<Record<string, THREE.AnimationAction>>({});
  const upperBodyCurrentAction = useRef<THREE.AnimationAction | null>(null);
  const queueRef = useRef<PlaybackQueue | null>(null);
  const upperBodyQueueRef = useRef<PlaybackQueue | null>(null);
  const featureRef = useRef<MikeAnimationFeature | null>(null);
  const speakingRef = useRef(false);
  const speechPreparationTokenRef = useRef(0);
  const preparedSpeechRef = useRef<PreparedSpeech | null>(null);
  const lastSpeechOpenerIdRef = useRef<string | null>(null);
  const playToken = useRef(0);
  const upperBodyPlayToken = useRef(0);
  const onMeasuredRef = useRef(onMeasured);
  const onReadyRef = useRef(onReady);
  const lookTargetRef = useRef<[number, number, number] | null>(lookTarget);
  const lookStrengthRef = useRef(lookStrength);
  const lookYawRef = useRef(0);
  const lookPitchRef = useRef(0);
  const lookBonesRef = useRef<{
    head: THREE.Bone[];
    neck: THREE.Bone[];
    eyes: THREE.Bone[];
  }>({ head: [], neck: [], eyes: [] });
  const idleModeRef = useRef<MikeIdleMode>("rest");

  useEffect(() => {
    onMeasuredRef.current = onMeasured;
  }, [onMeasured]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    lookTargetRef.current = lookTarget ?? null;
  }, [lookTarget]);

  useEffect(() => {
    lookStrengthRef.current = lookStrength;
  }, [lookStrength]);

  useEffect(() => {
    let cancelled = false;
    loadCharacter(mikeAssets.characterUrl)
      .then((scene) => {
        if (cancelled) return;
        const fitted = fitMike(scene);
        modelRef.current = fitted;
        basePositionRef.current = fitted.position.clone();
        const bones = getDrivingBones(fitted);
        lookBonesRef.current = {
          head: LOOK_HEAD_NAMES.map((name) => bones.get(name)).filter(
            (bone): bone is THREE.Bone => Boolean(bone),
          ),
          neck: LOOK_NECK_NAMES.map((name) => bones.get(name)).filter(
            (bone): bone is THREE.Bone => Boolean(bone),
          ),
          eyes: LOOK_EYE_NAMES.map((name) => bones.get(name)).filter(
            (bone): bone is THREE.Bone => Boolean(bone),
          ),
        };
        setModel(fitted);
      })
      .catch((error) => {
        console.error("Failed to load Mike character:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Report world bounds so the board and camera shots track Mike's pose.
  useEffect(() => {
    if (!model || !groupRef.current) return;
    groupRef.current.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(groupRef.current);
    const center = box.getCenter(new THREE.Vector3());
    const waistBone = findWaistBone(model);
    const waist = new THREE.Vector3();
    if (waistBone) {
      waistBone.getWorldPosition(waist);
    } else {
      waist.set(
        center.x,
        box.min.y + (box.max.y - box.min.y) * WAIST_HEIGHT_RATIO,
        center.z,
      );
    }
    onMeasuredRef.current?.({
      feetY: box.min.y,
      headY: box.max.y,
      waistY: waist.y,
      centerX: center.x,
      centerZ: center.z,
    });
  }, [model]);

  const prepareClip = useCallback(
    async (url: string, name: string, layer: BodyLayer = "full_body") => {
      const clip = await animationClipCache.load(url);
      if (!clip?.tracks?.length || !mixer.current || !modelRef.current) return null;
      const playable = toHierarchyClip(
        clip,
        getDrivingBones(modelRef.current),
        NATURAL_FINGER_STRENGTH,
        layer,
      );
      if (!playable?.tracks?.length) return null;
      playable.name = name;
      const action = mixer.current.clipAction(playable);
      const actionMap =
        layer === "upper_body" ? upperBodyActions.current : actions.current;
      actionMap[name] = action;
      return action;
    },
    [],
  );

  const playAsset = useCallback(
    async (
      url: string,
      name = "generated",
      options: Record<string, unknown> = {},
    ) => {
      const fadeDuration = (options.fadeDuration as number) ?? 0.25;
      const layer = ((options.layer as BodyLayer) ?? "full_body") as BodyLayer;
      const seamlessHandoff = Boolean(options.seamlessHandoff);
      const repeats =
        typeof options.repeats === "number"
          ? (options.repeats as number)
          : options.loop === true
            ? Infinity
            : 1;
      const targetQueue =
        layer === "upper_body" ? upperBodyQueueRef.current : queueRef.current;
      if (!mixer.current || !modelRef.current || !targetQueue) return false;
      const tokenRef = layer === "upper_body" ? upperBodyPlayToken : playToken;
      const token = ++tokenRef.current;
      featureRef.current?.lifecycle.transition(PLAYBACK_STATES.LOADING, {
        animation_id: name,
        asset: url,
        layer,
      });

      try {
        const actionName = `${name}-${token}`;
        const action = await prepareClip(url, actionName, layer);
        if (token !== tokenRef.current || !action) return false;
        targetQueue.playNow([
          {
            name: actionName,
            animationId: name,
            repeats,
            fade: fadeDuration,
            layer,
            seamlessHandoff,
          },
        ]);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to load animation ${url}:`, message);
        featureRef.current?.lifecycle.transition(PLAYBACK_STATES.ERROR, {
          animation_id: name,
          asset: url,
          error_code: "ANIMATION_LOAD_FAILED",
          message,
          layer,
        });
        targetQueue?.returnToWaiting();
        return false;
      }
    },
    [prepareClip],
  );

  // The Three.js scene graph is intentionally imperative; React owns only
  // the reference that triggers setup when loading completes.
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => {
    if (!model) return undefined;

    let cancelled = false;
    mixer.current = new THREE.AnimationMixer(model);
    actions.current = {};
    currentAction.current = null;
    featureRef.current?.dispose();
    featureRef.current = createMikeAnimationFeature({
      registry: animationRegistry,
      assetResolver: mikeAssets,
      executor: createThreeMikeExecutor({
        playAsset,
        preloadAsset: (url: string) => animationClipCache.load(url),
      }),
      stopExecutor: (command) => {
        const commandOptions = (command as { options?: { layer?: string } })
          ?.options;
        if (commandOptions?.layer === "upper_body") {
          upperBodyQueueRef.current?.clear({
            emitInterrupted: true,
            reason: "stopped",
          });
        } else if (!speakingRef.current) {
          queueRef.current?.returnToWaiting();
        }
        return true;
      },
      diagnostics: console,
    });
    queueRef.current = createPlaybackQueue({
      mixer: mixer.current,
      actionsRef: actions,
      currentRef: currentAction,
      lifecycle: featureRef.current.lifecycle,
      onActionStart: () => {
        // Baked root motion stays untouched; just re-pin the fitted position.
        if (modelRef.current && basePositionRef.current) {
          modelRef.current.position.copy(basePositionRef.current);
        }
      },
      onActionRetired: ({ name, action }: {
        name: string;
        action: THREE.AnimationAction;
      }) => {
        // Speech actions are prepared as a complete queue. PlaybackQueue
        // temporarily retires future actions while crossfading, so keep them
        // cached until the audio segment ends and cleanup runs.
        if (
          name === "waiting" ||
          name === "wave" ||
          name.startsWith("speech-")
        ) {
          return;
        }
        if (actions.current[name] !== action) return;
        action.stop();
        mixer.current?.uncacheAction(action.getClip(), modelRef.current ?? undefined);
        delete actions.current[name];
      },
    });
    upperBodyActions.current = {};
    upperBodyCurrentAction.current = null;
    upperBodyQueueRef.current = createPlaybackQueue({
      mixer: mixer.current,
      actionsRef: upperBodyActions,
      currentRef: upperBodyCurrentAction,
      lifecycle: featureRef.current.lifecycle,
      layer: "upper_body",
      fallbackActionName: null,
      fadeOutWhenEmpty: true,
      onActionRetired: ({ name, action }: {
        name: string;
        action: THREE.AnimationAction;
      }) => {
        // The entire speech sequence is prepared before audio starts. Queue
        // crossfades temporarily retire future actions, so retain them until
        // the speech segment completes and cleanup runs.
        if (name.startsWith("speech-")) return;
        if (upperBodyActions.current[name] !== action) return;
        action.stop();
        mixer.current?.uncacheAction(action.getClip(), modelRef.current ?? undefined);
        delete upperBodyActions.current[name];
      },
    });
    // eslint-disable-next-line react-hooks/immutability
    model.visible = true;

    const speechKey = (options: MikeSpeakingOptions = {}) => {
      const preferred = options.preferredAnimationId ?? "seg_377";
      const duration = Math.max(1, options.estimatedDurationSec ?? 3);
      return `${preferred}:${duration.toFixed(3)}`;
    };

    function cleanupPreparedSpeechActions(options: {
      preparationToken?: number;
      retireAction?: THREE.AnimationAction | null;
    } = {}) {
      const active = upperBodyCurrentAction.current;

      Object.entries(upperBodyActions.current).forEach(([name, action]) => {
        if (
          !name.startsWith("speech-") ||
          (options.preparationToken !== undefined &&
            !name.startsWith(`speech-${options.preparationToken}-`)) ||
          (action === active && action !== options.retireAction)
        ) {
          return;
        }

        action.stop();
        action.enabled = false;
        action.setEffectiveWeight(0);
        if (upperBodyCurrentAction.current === action) {
          upperBodyCurrentAction.current = null;
        }
        mixer.current?.uncacheAction(
          action.getClip(),
          modelRef.current ?? undefined,
        );
        delete upperBodyActions.current[name];
      });
    }

    async function prepareSpeechPerformance(
      options: MikeSpeakingOptions = {},
    ): Promise<boolean> {
      const key = speechKey(options);

      if (preparedSpeechRef.current?.key === key) {
        return preparedSpeechRef.current.items.length > 0;
      }

      const preparationToken = ++speechPreparationTokenRef.current;
      const requestedPreferred = options.preferredAnimationId ?? "seg_377";
      const preferredRecord = animationRegistry.resolve(requestedPreferred);
      const preferred =
        preferredRecord?.presentation_safe !== false &&
        preferredRecord?.body_layer === "upper_body"
          ? requestedPreferred
          : "seg_377";
      const targetSeconds = Math.max(1, options.estimatedDurationSec ?? 3);
      const candidates = buildSpeechCandidateIds(preferred);
      cleanupPreparedSpeechActions();
      const items: PreparedSpeech["items"] = [];
      let coveredSeconds = 0;
      let candidateIndex = 0;
      let attempts = 0;
      const failedIds = new Set<string>();

      while (
        coveredSeconds < targetSeconds + 0.35 &&
        items.length < 12 &&
        failedIds.size < candidates.length &&
        attempts < candidates.length * 3
      ) {
        attempts += 1;
        const animationId = candidates[candidateIndex % candidates.length];
        candidateIndex += 1;

        if (failedIds.has(animationId)) {
          continue;
        }
        if (items.at(-1)?.animationId === animationId) {
          continue;
        }

        const record = animationRegistry.resolve(animationId);
        if (!record) {
          console.warn(`Missing Mixamo teaching animation: ${animationId}`);
          failedIds.add(animationId);
          continue;
        }

        const name = `speech-${preparationToken}-${items.length}-${animationId}`;
        let action: THREE.AnimationAction | null = null;
        try {
          action = await prepareClip(
            mikeAssets.resolveAnimation(record),
            name,
            "upper_body",
          );
        } catch (error) {
          console.warn(`Skipping failed speech animation ${animationId}:`, error);
          failedIds.add(animationId);
          continue;
        }

        if (
          preparationToken !== speechPreparationTokenRef.current ||
          cancelled
        ) {
          return false;
        }

        if (!action) {
          failedIds.add(animationId);
          continue;
        }

        const holdDuration = capClipDuration(
          action.getClip(),
          SPEECH_HOLD_SECONDS,
        );
        if (!Number.isFinite(holdDuration) || holdDuration <= 0) {
          action.stop();
          action.enabled = false;
          action.setEffectiveWeight(0);
          mixer.current?.uncacheAction(
            action.getClip(),
            modelRef.current ?? undefined,
          );
          delete upperBodyActions.current[name];
          failedIds.add(animationId);
          continue;
        }
        items.push({
          name,
          animationId,
          repeats: 1,
          fade: SPEECH_FADE_SECONDS,
          transitionLeadSeconds: SPEECH_FADE_SECONDS,
        });
        coveredSeconds += Math.max(0.7, holdDuration - SPEECH_FADE_SECONDS);
      }

      if (items[0]?.animationId) {
        lastSpeechOpenerIdRef.current = items[0].animationId;
      }
      preparedSpeechRef.current = { key, items };
      return items.length > 0;
    }

    async function playUpperBodyClip(
      animationId: string,
      options: { loop?: boolean; fade?: number } = {},
    ): Promise<boolean> {
      const record = animationRegistry.resolve(animationId);
      if (!record || !mixer.current || !upperBodyQueueRef.current) return false;
      const name = `cue-${animationId}-${++upperBodyPlayToken.current}`;
      try {
        const action = await prepareClip(
          mikeAssets.resolveAnimation(record),
          name,
          "upper_body",
        );
        if (!action || !upperBodyQueueRef.current) return false;
        upperBodyQueueRef.current.playNow([
          {
            name,
            animationId,
            loop: options.loop === true,
            repeats: options.loop ? Infinity : 1,
            fade: options.fade ?? 0.3,
            transitionLeadSeconds: 0.28,
          },
        ]);
        return true;
      } catch (error) {
        console.warn(`Upper-body cue ${animationId} failed:`, error);
        return false;
      }
    }

    function stopSpeakingMotion() {
      const retiringPreparationToken = speechPreparationTokenRef.current;
      const retiringAction = upperBodyCurrentAction.current;
      speakingRef.current = false;
      speechPreparationTokenRef.current += 1;
      playToken.current += 1;
      upperBodyPlayToken.current += 1;
      featureRef.current?.setSpeaking(false);
      retiringAction?.fadeOut(0.25);
      // Clearing pending items immediately prevents another speech gesture
      // from starting while the current action completes its fade.
      upperBodyQueueRef.current?.clear({
        emitInterrupted: true,
        reason: "idle",
      });
      queueRef.current?.returnToWaiting();
      preparedSpeechRef.current = null;
      const cleanupToken = speechPreparationTokenRef.current;
      window.setTimeout(() => {
        cleanupPreparedSpeechActions({
          preparationToken: retiringPreparationToken,
          retireAction: retiringAction,
        });
        // Do not clear a newer speech queue if another segment has started.
        if (cleanupToken === speechPreparationTokenRef.current) {
          upperBodyQueueRef.current?.clear();
        }
      }, 260);
    }

    const unsubscribePlayback = featureRef.current.subscribePlayback(() => {});

    function buildApi(): MikeAnimationApi {
      const feature = featureRef.current;
      const api: MikeAnimationApi = {
        playAnimation: async (animationId, options = {}) => {
          if (!feature) return false;
          const result = await feature.play({
            animationId,
            priority: 50,
            mode: "replace",
            repeats: options.repeats,
            loop: options.loop,
          });
          return result.accepted;
        },
        playGesture: async (animationId, options = {}) => {
          if (!feature) return false;
          const result = await feature.gesture({
            animationId,
            priority: 40,
            mode: "replace",
            repeats: options.repeats ?? 1,
            loop: options.loop,
            layer: "upper_body",
          });
          return result.accepted;
        },
        playWaiting: () => {
          idleModeRef.current = "rest";
          if (speakingRef.current) {
            stopSpeakingMotion();
          } else {
            queueRef.current?.returnToWaiting();
            upperBodyQueueRef.current?.clear({
              emitInterrupted: true,
              reason: "idle",
            });
          }
        },
        prepareSpeech: prepareSpeechPerformance,
        setSpeaking: (value, options = {}) => {
          const next = Boolean(value);
          feature?.setSpeaking(next);
          if (options.lookAtBoard) {
            lookStrengthRef.current = Math.max(lookStrengthRef.current, 0.38);
          }
          if (!next) {
            if (speakingRef.current) stopSpeakingMotion();
            idleModeRef.current = "rest";
            return;
          }

          idleModeRef.current = "rest";
          speakingRef.current = true;

          const startPrepared = () => {
            if (!speakingRef.current) {
              return;
            }

            const prepared = preparedSpeechRef.current;
            if (!prepared || prepared.key !== speechKey(options)) {
              queueRef.current?.returnToWaiting();
              return;
            }

            upperBodyQueueRef.current?.playNow(prepared.items);
          };

          if (preparedSpeechRef.current?.key === speechKey(options)) {
            startPrepared();
          } else {
            void prepareSpeechPerformance(options).then(startPrepared);
          }
        },
        setPaused: (value) => {
          if (mixer.current) {
            mixer.current.timeScale = value ? 0 : 1;
          }
        },
        setIdleMode: (mode) => {
          idleModeRef.current = mode;
          if (speakingRef.current) return;
          if (mode === "think") {
            void playUpperBodyClip("seg_312", { loop: true, fade: 0.4 });
            return;
          }
          if (mode === "listen") {
            void playUpperBodyClip("seg_427", { loop: true, fade: 0.4 });
            return;
          }
          upperBodyQueueRef.current?.clear({
            emitInterrupted: true,
            reason: "idle",
          });
        },
        setLookAtBoard: (enabled, strength) => {
          if (!enabled) {
            lookStrengthRef.current = 0;
            return;
          }
          lookStrengthRef.current = strength ?? 0.36;
        },
        stop: () => {
          stopSpeakingMotion();
          feature?.stop();
        },
        registryRecord: (animationId) =>
          animationRegistry.resolve(animationId),
        subscribePlayback: (listener) =>
          feature?.subscribePlayback(listener) ?? (() => {}),
      };
      return api;
    }

    async function bootPresence() {
      try {
        const idleRecord = animationRegistry.playable(DEFAULT_IDLE_ANIMATION_ID);
        const waiting = await prepareClip(
          mikeAssets.resolveAnimation(idleRecord),
          "waiting",
        );
        if (cancelled || !mixer.current || !model) return;

        if (waiting) {
          queueRef.current?.playNow([
            {
              name: "waiting",
              animationId: DEFAULT_IDLE_ANIMATION_ID,
              loop: true,
              fade: 0.2,
            },
          ]);
        }

        const api = buildApi();
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as Record<string, unknown>).__lixiaMike = api;
        }
        onReadyRef.current?.(api);

        void animationClipCache.preload(
          SPEAKING_FILLER_IDS.flatMap((id) => {
            const record = animationRegistry.resolve(id);
            return record ? [mikeAssets.resolveAnimation(record)] : [];
          }),
        );
      } catch (error) {
        console.warn("Mike presence boot failed:", error);
        if (model) model.visible = true;
        onReadyRef.current?.(buildApi());
      }
    }

    void bootPresence();

    return () => {
      cancelled = true;
      speakingRef.current = false;
      unsubscribePlayback();
      playToken.current += 1;
      upperBodyPlayToken.current += 1;
      queueRef.current?.clear();
      queueRef.current = null;
      upperBodyQueueRef.current?.clear();
      upperBodyQueueRef.current = null;
      upperBodyActions.current = {};
      upperBodyCurrentAction.current = null;
      mixer.current?.stopAllAction();
      mixer.current = null;
      featureRef.current?.dispose();
      featureRef.current = null;
    };
    // Boot once per model instance only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useFrame((_, delta) => {
    mixer.current?.update(delta);
    queueRef.current?.update(delta);
    upperBodyQueueRef.current?.update(delta);
    featureRef.current?.update(delta);

    if (groupRef.current) {
      groupRef.current.updateMatrixWorld(true);
      FOOT_BOX.setFromObject(groupRef.current);
      if (Number.isFinite(FOOT_BOX.min.y)) {
        const lift = STUDIO_FLOOR_Y - FOOT_BOX.min.y;
        if (Math.abs(lift) > 0.0005) {
          groupRef.current.position.y += lift;
        }
      }
    }

    const target = lookTargetRef.current;
    const strength = lookStrengthRef.current;
    const head = lookBonesRef.current.head[0];
    if (head && target && strength > 0.12) {
      head.getWorldPosition(LOOK_HEAD_POS);
      LOOK_OFFSET.set(target[0], target[1], target[2]).sub(LOOK_HEAD_POS);
      const desiredYaw = Math.atan2(LOOK_OFFSET.x, LOOK_OFFSET.z);
      const yaw = THREE.MathUtils.clamp(desiredYaw * strength, -0.45, 0.45);
      lookYawRef.current = THREE.MathUtils.damp(lookYawRef.current, yaw, 5, delta);
      lookPitchRef.current = THREE.MathUtils.damp(lookPitchRef.current, 0, 6, delta);
      head.rotateOnWorldAxis(WORLD_UP, lookYawRef.current);
      for (const neck of lookBonesRef.current.neck) {
        neck.rotateOnWorldAxis(WORLD_UP, lookYawRef.current * 0.28);
      }
      for (const eye of lookBonesRef.current.eyes) {
        eye.rotateOnWorldAxis(WORLD_UP, lookYawRef.current * 0.12);
      }
    } else {
      lookYawRef.current = THREE.MathUtils.damp(lookYawRef.current, 0, 6, delta);
      lookPitchRef.current = THREE.MathUtils.damp(lookPitchRef.current, 0, 6, delta);
    }
  });

  if (!model) return null;
  return (
    <group
      ref={groupRef}
      position-x={MODEL_POSITION[0]}
      position-z={MODEL_POSITION[2]}
      rotation={MODEL_ROTATION}
    >
      <primitive object={model} />
    </group>
  );
}
