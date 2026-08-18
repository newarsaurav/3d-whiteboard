/**
 * Minimal typings for the vendored @lixia/mike-animation package
 * (plain-ESM JavaScript, no bundled declarations).
 */
declare module "@lixia/mike-animation" {
  import type { AnimationClip } from "three";

  export interface AnimationRecord {
    id: string;
    source_id: string;
    name: string;
    source_type: string;
    mike_asset: string;
    body_layer: "full_body" | "upper_body";
    loop_mode: "once" | "repeat";
    default_repeats: number;
    blend_in_seconds?: number;
    blend_out_seconds?: number;
    duration_seconds?: number | null;
    quality_status: string;
    presentation_safe?: boolean;
    enabled: boolean;
    [key: string]: unknown;
  }

  export interface AssetResolver {
    baseUrl: string;
    characterUrl: string;
    manifestUrl: string;
    resolveAnimation(record: AnimationRecord): string;
  }

  export function createVersionedAssetResolver(options: {
    baseUrl: string;
  }): AssetResolver;

  export const DEFAULT_CHARACTER_FILE: string;

  export interface PlaybackEvent {
    state: string;
    animation_id?: string | null;
    action_name?: string;
    message?: string;
    error_code?: string;
    [key: string]: unknown;
  }

  export interface ScheduleResult {
    accepted: boolean;
    command_id?: string;
    reason?: string;
    [key: string]: unknown;
  }

  export interface MikeAnimationFeature {
    play(request: {
      animationId: string;
      priority?: number;
      mode?: string;
      interruptible?: boolean;
      repeats?: number;
      loop?: boolean;
      transitionSeconds?: number;
      options?: Record<string, unknown>;
    }): Promise<ScheduleResult>;
    gesture(request: {
      animationId: string;
      layer?: string;
      priority?: number;
      mode?: string;
      interruptible?: boolean;
      repeats?: number;
      loop?: boolean;
      transitionSeconds?: number;
      options?: Record<string, unknown>;
    }): Promise<ScheduleResult>;
    setSpeaking(value: boolean): boolean;
    isSpeaking(): boolean;
    stop(reason?: string): { full_body: number; upper_body: number };
    resolve(animationId: string): AnimationRecord | null;
    requirePlayable(
      animationId: string,
      options?: { strict?: boolean },
    ): AnimationRecord;
    getPlaybackState(): PlaybackEvent | null;
    subscribePlayback(
      listener: (event: PlaybackEvent) => void,
      options?: Record<string, unknown>,
    ): () => void;
    update(deltaSeconds: number): void;
    dispose(): void;
    readonly lifecycle: {
      transition(state: string, details?: Record<string, unknown>): void;
    };
    readonly registry: AnimationRegistry;
  }

  export function createMikeAnimationFeature(options: {
    executor: (command: unknown, context?: unknown) => Promise<boolean> | boolean;
    registry?: AnimationRegistry;
    assetResolver?: AssetResolver | ((record: AnimationRecord, asset: string) => string);
    assetBaseUrl?: string;
    stopExecutor?: (command: unknown) => boolean;
    diagnostics?: unknown;
    maxQueue?: number;
  }): MikeAnimationFeature;

  export function createThreeMikeExecutor(options: {
    playAsset: (
      url: string,
      animationId: string,
      playOptions: Record<string, unknown>,
    ) => Promise<boolean> | boolean;
    preloadAsset?: (
      url: string,
      animationId: string,
      playOptions: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    diagnostics?: unknown;
  }): (command: unknown, context?: unknown) => Promise<boolean>;

  export class AnimationRegistry {
    resolve(idOrAlias: string): AnimationRecord | null;
    require(idOrAlias: string): AnimationRecord;
    playable(idOrAlias: string, options?: { strict?: boolean }): AnimationRecord;
  }

  export const animationRegistry: AnimationRegistry;

  export class AnimationClipCache {
    load(url: string): Promise<AnimationClip>;
    preload(urls: string[]): Promise<unknown>;
    has(url: string): boolean;
    clear(): void;
    readonly size: number;
  }

  export const animationClipCache: AnimationClipCache;

  export const PLAYBACK_STATES: Record<string, string>;

  export interface PlaybackQueueItem {
    name: string;
    animationId?: string;
    repeats?: number;
    loop?: boolean;
    fade?: number;
    layer?: string;
    seamlessHandoff?: boolean;
  }

  export interface PlaybackQueue {
    playNow(items: PlaybackQueueItem[]): void;
    returnToWaiting(): void;
    clear(options?: { emitInterrupted?: boolean; reason?: string }): void;
    update(delta: number): void;
  }

  export function createPlaybackQueue(options: Record<string, unknown>): PlaybackQueue;

  export interface GesturePlan {
    ok: boolean;
    mode: "play" | "idle" | "continue";
    gesture: string | null;
    animation_id: string | null;
    record: AnimationRecord | null;
    reason: string;
  }

  export class PresentationDirector {
    constructor(options?: {
      registry?: AnimationRegistry;
      catalog?: unknown;
      strictApproved?: boolean;
    });
    listGestures(): Array<{
      intent: string;
      label: string;
      animation_id: string | null;
      description: string;
    }>;
    formatCatalogForPrompt(): string;
    resolve(request?: {
      gesture?: string | null;
      intent?: string | null;
      animationId?: string | null;
    }): GesturePlan;
  }

  export const presentationDirector: PresentationDirector;
  export class PresentationDirectorError extends Error {}
}
