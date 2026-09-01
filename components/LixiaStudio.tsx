"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import {
  Canvas,
  useThree,
} from "@react-three/fiber";

import {
  OrbitControls,
} from "@react-three/drei";
import * as THREE from "three";

import type {
  MikeAnimationApi,
  MikeBounds,
} from "./MikeModel";

import {
  estimateSpeechSeconds,
  FALLBACK_LESSON_GESTURES,
  resolveGesturePlan,
} from "@/lib/presentationGestures";

import PresentationBoard from "./PresentationBoard";
import type { DrawingTool } from "./PresentationBoard";

import StudioEnvironment from "./StudioEnvironment";

type MikeModelComponent = ComponentType<{
  onMeasured?: (bounds: MikeBounds) => void;
  onReady?: (api: MikeAnimationApi) => void;
}>;

import type {
  Board,
  BoardCommand,
  TeacherLessonCommand,
} from "@/types/board";

const BOARD_X = 1.4;
const BOARD_Z = -0.7;

const HIP_RATIO = 0.42;
const BELOW_HIP_OFFSET = 0.25;
const ABOVE_HEAD_OFFSET = 0.75;

/** Deterministic gesture for single (non-lesson) board responses. */
function gestureForBoardCommand(
  command: BoardCommand,
): string {
  switch (command.type) {
    case "flowchart":
      return "point";
    case "chart":
      return "reveal";
    case "image":
      return command.mode === "edit" ? "approve" : "reveal";
    default:
      return "explain";
  }
}




const DEFAULT_CAMERA_POSITION: [
  number,
  number,
  number,
] = [0, 3.7, 9.3];

const DEFAULT_CAMERA_TARGET: [
  number,
  number,
  number,
] = [0.5, 2.6, 0];


function InitialCameraSetup() {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(
      ...DEFAULT_CAMERA_POSITION,
    );

    camera.lookAt(
      ...DEFAULT_CAMERA_TARGET,
    );

    camera.updateProjectionMatrix();
  }, [camera]);

  return null;
}

function getLocalBoardCommand(
  prompt: string,
): "clear" | "new" | null {
  const normalized = prompt
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    normalized === "clear board" ||
    normalized === "clear the board" ||
    normalized === "erase board" ||
    normalized === "erase the board"
  ) {
    return "clear";
  }

  if (
    normalized === "new board" ||
    normalized === "add board" ||
    normalized === "create new board"
  ) {
    return "new";
  }

  return null;
}

function looksLikeBoardFollowUp(
  prompt: string,
): boolean {
  const normalized = prompt.toLowerCase();

  const markers = [
    "add ",
    "change ",
    "update ",
    "remove ",
    "delete ",
    "move ",
    "replace ",
    "edit ",
    "keep ",
    "make it",
    "make this",
    "make that",
    "make the ",
    "this ",
    "that ",
    " it ",
    "same ",
    "above",
    "below",
    "beside",
    "next to",
    "on the side",
    "bigger",
    "smaller",
    "left",
    "right",
    "the chart",
    "the graph",
    "the flowchart",
    "the diagram",
    "the board",
    "the cat",
    "the dog",
    "the image",
    "the picture",
  ];

  return markers.some((marker) =>
    normalized.includes(marker),
  );
}

function getBoardImageForGemini(
  board: Board | undefined,
): string | null {
  if (!board) {
    return null;
  }

  if (
    typeof board.drawing === "string" &&
    board.drawing.startsWith("data:image/")
  ) {
    return board.drawing;
  }

  if (
    board.generatedCommand?.type === "image" &&
    typeof board.generatedCommand.imageDataUrl === "string" &&
    board.generatedCommand.imageDataUrl.startsWith("data:image/")
  ) {
    return board.generatedCommand.imageDataUrl;
  }

  return null;
}

function makeFormulaSpeakable(formula: string): string {
  return formula
    .replace(/Δ/g, " delta " )
    .replace(/²/g, " squared " )
    .replace(/³/g, " cubed " )
    .replace(/=/g, " equals " )
    .replace(/\//g, " divided by " )
    .replace(/\*/g, " times " )
    .replace(/\+/g, " plus " )
    .replace(/-/g, " minus " )
    .replace(/\s+/g, " " )
    .trim();
}

function buildSpokenResponse(command: BoardCommand): string {
  if (command.type === "write_text") {
    const parts: string[] = [];

    if (command.title.trim()) {
      parts.push(command.title.trim());
    }

    for (const bullet of command.bullets) {
      const clean = bullet.trim();
      if (clean) {
        parts.push(clean);
      }
    }

    if (command.formulas?.length) {
      for (const formula of command.formulas) {
        const clean = formula.trim();
        if (clean) {
          parts.push(`The formula is ${makeFormulaSpeakable(clean)}.`);
        }
      }
    }

    if (command.note?.trim()) {
      parts.push(command.note.trim());
    }

    return parts.join(". " );
  }

  if (command.type === "flowchart") {
    const orderedNodes = [...command.nodes]
      .sort((a, b) =>
        a.row === b.row
          ? a.column - b.column
          : a.row - b.row,
      )
      .map((node) => node.label.trim())
      .filter(Boolean);

    const nodeSummary = orderedNodes.slice(0, 8).join(", then " );

    return nodeSummary
      ? `Here is the ${command.title} flowchart. The main flow is ${nodeSummary}.`
      : `I have drawn the ${command.title} flowchart on the board.`;
  }

  if (command.type === "chart") {
    const sourceText = command.source
      ? ` The data source is ${command.source}.`
      : "";

    return `I have plotted ${command.title} on the board.${sourceText}`;
  }

  if (command.type === "image") {
    const subject = command.title?.trim() || "the requested drawing";

    return command.mode === "edit"
      ? `I have updated ${subject} on the whiteboard.`
      : `I have drawn ${subject} on the whiteboard.`;
  }

  return "I have updated the whiteboard.";
}

export default function LixiaStudio() {


  const [assistantPrompt, setAssistantPrompt] =
    useState("");

  const [isGenerating, setIsGenerating] =
    useState(false);

  const [assistantError, setAssistantError] =
    useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/gemini")
      .then(async (response) => {
        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!cancelled && !response.ok) {
          setAssistantError(
            data.error ?? "Gemini is not ready.",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAssistantError("Could not reach the Gemini route.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const [isTeaching, setIsTeaching] =
    useState(false);

  const [isTeachingPaused, setIsTeachingPaused] =
    useState(false);

  const teachingRunRef = useRef(0);

  const boardVersionRef =
    useRef<Record<number, number>>({ 1: 0 });

  const teacherAudioContextRef =
    useRef<AudioContext | null>(null);

  const teacherAbortControllerRef =
    useRef<AbortController | null>(null);

  const teacherAudioSourcesRef =
    useRef<Set<AudioBufferSourceNode>>(new Set());

  const mikeApiRef =
    useRef<MikeAnimationApi | null>(null);
  const mikeReadyRef = useRef(false);

  const handleMikeReady = useCallback(
    (api: MikeAnimationApi) => {
      mikeApiRef.current = api;
      mikeReadyRef.current = true;
    },
    [],
  );

  /**
   * Bind one teaching clip to the current speech segment.
   * Full-body is only for greet/goodbye/walk; talk uses upper-body over idle.
   */
  const playGestureIntent = useCallback(
    (
      intent: string | null | undefined,
      options: {
        fallbackIndex?: number;
        estimatedDurationSec?: number;
        asSpeakingSegment?: boolean;
      } = {},
    ) => {
      const mike = mikeApiRef.current;
      if (!mike) return null;

      const plan = resolveGesturePlan(intent, options.fallbackIndex ?? 0);
      if (plan.intent === "idle" || plan.intent === "continue") {
        mike.playWaiting();
        return plan;
      }

      if (options.asSpeakingSegment) {
        mike.setSpeaking(true, {
          preferredAnimationId: plan.animationId,
          estimatedDurationSec: options.estimatedDurationSec,
          forcePreferred: true,
        });
        return plan;
      }

      if (plan.layer === "full_body") {
        void mike.playAnimation(plan.animationId, { repeats: 1 });
        return plan;
      }

      void mike.playGesture(plan.animationId, { repeats: 1 });
      return plan;
    },
    [],
  );

  const [boardLayout, setBoardLayout] =
    useState({
      y: 2.6,
      frameHeight: 4.5,
    });

  const [cameraMode, setCameraMode] =
    useState(false);

  const [tool, setTool] =
    useState<DrawingTool>("pen");

  const [penColor, setPenColor] =
    useState("#111111");

  const [lineWidth, setLineWidth] =
    useState(8);

  // 10 = slow and deliberate, 100 = very fast.
  const [writingSpeed, setWritingSpeed] =
    useState(55);

  const [drawingSpeed, setDrawingSpeed] =
    useState(55);

  const [MikeModel, setMikeModel] =
    useState<MikeModelComponent | null>(null);

  useEffect(() => {
    // Load immediately — do not wait an artificial 600ms.
    let cancelled = false;
    void import("./MikeModel").then((mod) => {
      if (!cancelled) setMikeModel(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function waitForMikeReady(timeoutMs = 8000): Promise<boolean> {
    if (mikeApiRef.current) return true;
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (mikeApiRef.current) return true;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 50);
      });
    }
    return Boolean(mikeApiRef.current);
  }

  const [assistantPanelPos, setAssistantPanelPos] =
    useState<{ left: number; top: number } | null>(null);

  const assistantPanelRef = useRef<HTMLDivElement>(null);

  const assistantDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
  } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(
        "lixia-assistant-panel-pos",
      );

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        left?: number;
        top?: number;
      };

      if (
        typeof parsed.left === "number" &&
        typeof parsed.top === "number"
      ) {
        setAssistantPanelPos({
          left: parsed.left,
          top: parsed.top,
        });
      }
    } catch {
      // Ignore a bad stored position.
    }
  }, []);

  const [clearSignal, setClearSignal] =
    useState(0);

  const [activeBoardId, setActiveBoardId] =
    useState(1);

  const [boards, setBoards] = useState<Board[]>([
    {
      id: 1,
      name: "WhiteBoard Detail name ",
      drawing: null,
      generatedCommand: null,
      generatedCommandVersion: 0,
    },
  ]);

  const activeBoard = useMemo(() => {

    return (
      boards.find(
        (board) =>
          board.id === activeBoardId,
      ) ?? boards[0]
    );
  }, [boards, activeBoardId]);

  const handleMikeMeasured = useCallback(
    ({ feetY, headY }: MikeBounds) => {
      const characterHeight =
        headY - feetY;

      const hipY =
        feetY +
        characterHeight * HIP_RATIO;

      const boardBottom =
        hipY - BELOW_HIP_OFFSET;

      const boardTop =
        headY + ABOVE_HEAD_OFFSET;

      const frameHeight =
        boardTop - boardBottom;

      const boardCenterY =
        boardBottom +
        frameHeight / 2;

      setBoardLayout({
        y: boardCenterY,
        frameHeight,
      });
    },
    [],
  );

  function getTeacherAudioContext(): AudioContext | null {
    if (typeof window === "undefined") {
      return null;
    }

    if (
      !teacherAudioContextRef.current ||
      teacherAudioContextRef.current.state === "closed"
    ) {
      teacherAudioContextRef.current =
        new window.AudioContext({
          sampleRate: 24000,
        });
    }

    return teacherAudioContextRef.current;
  }

  function stopActiveTeacherAudio() {
    teacherAbortControllerRef.current?.abort();
    teacherAbortControllerRef.current = null;

    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.cancel();
    }

    for (const source of teacherAudioSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Source may already be stopped.
      }
    }

    teacherAudioSourcesRef.current.clear();
  }

  function beginTeachingRun(): number {
    stopActiveTeacherAudio();
    setIsTeachingPaused(false);
    mikeApiRef.current?.setPaused(false);
    mikeApiRef.current?.setSpeaking(false);
    mikeApiRef.current?.playWaiting();
    teachingRunRef.current += 1;
    return teachingRunRef.current;
  }

  function stopTeaching() {
    teachingRunRef.current += 1;
    stopActiveTeacherAudio();
    setIsTeaching(false);
    setIsTeachingPaused(false);
    mikeApiRef.current?.setPaused(false);
    mikeApiRef.current?.setSpeaking(false);
    mikeApiRef.current?.playWaiting();
  }

  async function pauseTeaching() {
    const audioContext = teacherAudioContextRef.current;

    if (!isTeaching || !audioContext) {
      return;
    }

    if (audioContext.state === "running") {
      await audioContext.suspend();
    }

    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.pause();
    }

    mikeApiRef.current?.setPaused(true);
    setIsTeachingPaused(true);
  }

  async function resumeTeaching() {
    const audioContext = teacherAudioContextRef.current;

    if (!isTeaching || !audioContext) {
      return;
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.resume();
    }

    mikeApiRef.current?.setPaused(false);
    setIsTeachingPaused(false);
  }

  function pcm16ToFloat32(
    bytes: Uint8Array,
  ): Float32Array<ArrayBuffer> {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const samples = new Float32Array(sampleCount);
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      sampleCount * 2,
    );

    for (let index = 0; index < sampleCount; index += 1) {
      const value = view.getInt16(index * 2, true);
      samples[index] = value / 32768;
    }

    return samples;
  }

  function startSpeechMotion(
    runId: number,
    gestureIntent?: string | null,
    narration = "",
    fallbackIndex = 0,
    durationSeconds = estimateSpeechSeconds(narration),
  ) {
    if (runId !== teachingRunRef.current) {
      return;
    }

    playGestureIntent(gestureIntent, {
      fallbackIndex,
      estimatedDurationSec: durationSeconds,
      asSpeakingSegment: true,
    });
  }

  async function prepareSpeechMotion(
    runId: number,
    gestureIntent: string | null | undefined,
    durationSeconds: number,
    fallbackIndex = 0,
  ) {
    if (runId !== teachingRunRef.current) {
      return false;
    }

    const mike = mikeApiRef.current;
    if (!mike) {
      return false;
    }

    const plan = resolveGesturePlan(gestureIntent, fallbackIndex);

    return mike.prepareSpeech({
      preferredAnimationId: plan.animationId,
      estimatedDurationSec: durationSeconds,
      forcePreferred: true,
    });
  }

  function stopSpeechMotion(runId: number) {
    if (runId !== teachingRunRef.current) {
      return;
    }

    mikeApiRef.current?.setSpeaking(false);
    mikeApiRef.current?.playWaiting();
  }

  async function speakTeachingSegmentFallback(
    text: string,
    language: string,
    runId: number,
    gestureIntent?: string | null,
    fallbackIndex = 0,
    onPlaybackStart?: (durationSeconds: number) => void,
  ): Promise<void> {
    const estimatedDuration = estimateSpeechSeconds(text);
    await prepareSpeechMotion(
      runId,
      gestureIntent,
      estimatedDuration,
      fallbackIndex,
    );

    return new Promise((resolve) => {
      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window) ||
        !text.trim() ||
        runId !== teachingRunRef.current
      ) {
        onPlaybackStart?.(estimatedDuration);
        resolve();
        return;
      }

      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);

      utterance.lang = language || "en-US";
      utterance.rate = 0.94;
      utterance.pitch = 1;
      utterance.volume = 1;

      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        stopSpeechMotion(runId);
        resolve();
      };

      utterance.onstart = () => {
        onPlaybackStart?.(estimatedDuration);
        startSpeechMotion(
          runId,
          gestureIntent,
          text,
          fallbackIndex,
          estimatedDuration,
        );
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
    });
  }

  async function speakTeachingSegment(
    text: string,
    language: string,
    runId: number,
    gestureIntent?: string | null,
    fallbackIndex = 0,
    onPlaybackStart?: (durationSeconds: number) => void,
  ): Promise<void> {
    if (!text.trim() || runId !== teachingRunRef.current) {
      return;
    }

    await waitForMikeReady();

    // Warm the likely Mixamo sequence while Gemini is generating audio. Once
    // the exact PCM duration is known below, prepareSpeech reuses the clip
    // cache and only adjusts the final playlist length when necessary.
    void prepareSpeechMotion(
      runId,
      gestureIntent,
      estimateSpeechSeconds(text),
      fallbackIndex,
    );

    const audioContext = getTeacherAudioContext();

    if (!audioContext) {
      await speakTeachingSegmentFallback(
        text,
        language,
        runId,
        gestureIntent,
        fallbackIndex,
        onPlaybackStart,
      );
      return;
    }

    try {
      if (audioContext.state === "suspended" && !isTeachingPaused) {
        await audioContext.resume();
      }

      const controller = new AbortController();
      teacherAbortControllerRef.current = controller;

      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          language,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;

        if (response.status === 429) {
          await speakTeachingSegmentFallback(
            text,
            language,
            runId,
            gestureIntent,
            fallbackIndex,
            onPlaybackStart,
          );
          return;
        }

        throw new Error(
          data?.error ?? "Gemini teacher voice failed.",
        );
      }

      if (!response.body) {
        throw new Error(
          "Gemini teacher voice returned no audio stream.",
        );
      }

      const sampleRate = Number(
        response.headers.get("X-Audio-Sample-Rate") ?? "24000",
      );

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        if (runId !== teachingRunRef.current) {
          await reader.cancel();
          return;
        }

        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        if (!value || value.byteLength === 0) {
          continue;
        }

        chunks.push(value);
        totalBytes += value.byteLength;
      }

      if (totalBytes < 2) {
        throw new Error(
          "Gemini teacher voice returned an empty audio stream.",
        );
      }

      const pcm = new Uint8Array(totalBytes - (totalBytes % 2));
      let offset = 0;

      for (const chunk of chunks) {
        const remaining = pcm.byteLength - offset;
        if (remaining <= 0) break;
        const part = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
        pcm.set(part, offset);
        offset += part.byteLength;
      }

      const floatSamples = pcm16ToFloat32(pcm);
      const audioBuffer = audioContext.createBuffer(
        1,
        floatSamples.length,
        sampleRate,
      );
      audioBuffer.copyToChannel(floatSamples, 0);

      await prepareSpeechMotion(
        runId,
        gestureIntent,
        audioBuffer.duration,
        fallbackIndex,
      );

      if (runId !== teachingRunRef.current) {
        return;
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      teacherAudioSourcesRef.current.add(source);

      const ended = new Promise<void>((resolve) => {
        source.onended = () => {
          teacherAudioSourcesRef.current.delete(source);
          source.disconnect();
          resolve();
        };
      });

      source.start();
      onPlaybackStart?.(audioBuffer.duration);
      startSpeechMotion(
        runId,
        gestureIntent,
        text,
        fallbackIndex,
        audioBuffer.duration,
      );

      await ended;
    } catch (error) {
      if (
        runId !== teachingRunRef.current ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }

      console.warn(
        "Gemini TTS unavailable; using browser voice fallback.",
        error,
      );

      await speakTeachingSegmentFallback(
        text,
        language,
        runId,
        gestureIntent,
        fallbackIndex,
        onPlaybackStart,
      );
    } finally {
      stopSpeechMotion(runId);

      if (
        teacherAbortControllerRef.current?.signal.aborted ||
        runId === teachingRunRef.current
      ) {
        teacherAbortControllerRef.current = null;
      }
    }
  }

  async function speakSingleBoardResponse(
    command: BoardCommand,
    language = "en-US",
    onPlaybackStart?: (durationSeconds: number) => void,
  ) {
    const narration = buildSpokenResponse(command);

    if (!narration.trim()) {
      return;
    }

    const runId = beginTeachingRun();
    setIsTeaching(true);

    const audioContext = getTeacherAudioContext();

    if (audioContext?.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // TTS playback will fall back to browser speech if needed.
      }
    }

    try {
      await waitForMikeReady();

      // Let React paint the board update before Lixia begins speaking.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 120);
      });

      if (runId !== teachingRunRef.current) {
        return;
      }

      await speakTeachingSegment(
        narration,
        language,
        runId,
        gestureForBoardCommand(command),
        0,
        onPlaybackStart,
      );
    } finally {
      if (runId === teachingRunRef.current) {
        setIsTeaching(false);
        setIsTeachingPaused(false);
        stopSpeechMotion(runId);
      }
    }
  }


  async function runTeacherLesson(
    boardId: number,
    lesson: TeacherLessonCommand,
  ) {
    const runId = beginTeachingRun();
    setIsTeaching(true);

    const audioContext = getTeacherAudioContext();

    if (audioContext?.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // The segment function will use the browser fallback if needed.
      }
    }

    try {
      await waitForMikeReady();

      // The board is a visual teaching aid, not a caption track. Stream the
      // complete concise lesson notes once on the board's own clock while
      // narration and presenter motion run independently.
      const finalBoard = lesson.segments.at(-1)?.board;
      if (finalBoard && runId === teachingRunRef.current) {
        const nextVersion =
          (boardVersionRef.current[boardId] ?? 0) + 1;
        boardVersionRef.current[boardId] = nextVersion;
        setBoards((currentBoards) =>
          currentBoards.map((board) =>
            board.id === boardId
              ? {
                  ...board,
                  generatedCommand: finalBoard,
                  generatedCommandVersion: nextVersion,
                }
              : board,
          ),
        );
      }

      for (const [
        segmentIndex,
        segment,
      ] of lesson.segments.entries()) {
        if (runId !== teachingRunRef.current) {
          return;
        }

        const gestureIntent =
          segment.gesture ??
          FALLBACK_LESSON_GESTURES[
            segmentIndex % FALLBACK_LESSON_GESTURES.length
          ];

        await speakTeachingSegment(
          segment.narration,
          lesson.language ?? "en-US",
          runId,
          gestureIntent,
          segmentIndex,
        );
      }
    } finally {
      if (runId === teachingRunRef.current) {
        setIsTeaching(false);
        setIsTeachingPaused(false);
        stopSpeechMotion(runId);
      }
    }
  }

  useEffect(() => {
    return () => {
      teachingRunRef.current += 1;
      stopActiveTeacherAudio();

      if (
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
      }

      const audioContext = teacherAudioContextRef.current;
      teacherAudioContextRef.current = null;

      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
    };
  }, []);

  function toggleCameraMode() {
    setCameraMode(
      (currentMode) => !currentMode,
    );
  }

  function clearBoard() {
    // Clear the AI SVG context too, so a future prompt reads
    // the blank/current board instead of an old generated scene.
    setBoards((currentBoards) =>
      currentBoards.map((board) =>
        board.id === activeBoardId
          ? {
              ...board,
              generatedCommand: null,
            }
          : board,
      ),
    );

    setClearSignal(
      (currentSignal) =>
        currentSignal + 1,
    );
  }

  function selectBoard(boardId: number) {
    if (boardId !== activeBoardId) {
      stopTeaching();
    }

    setActiveBoardId(boardId);
  }

  function addBoard() {
    const nextId =
      boards.length === 0
        ? 1
        : Math.max(
          ...boards.map((board) => board.id),
        ) + 1;

    const newBoard: Board = {
      id: nextId,
      name: `Board ${nextId}`,
      drawing: null,
      generatedCommand: null,
      generatedCommandVersion: 0,
    };

    setBoards((currentBoards) => [
      ...currentBoards,
      newBoard,
    ]);

    boardVersionRef.current[nextId] = 0;
    setActiveBoardId(nextId);
  }

  function deleteBoard(boardId: number) {
    if (boards.length <= 1) {
      return;
    }

    const boardIndex = boards.findIndex(
      (board) => board.id === boardId,
    );

    if (boardIndex === -1) {
      return;
    }

    const boardToDelete = boards[boardIndex];

    const shouldDelete = window.confirm(
      `Delete ${boardToDelete.name}? This cannot be undone.`,
    );

    if (!shouldDelete) {
      return;
    }

    const nextActiveBoard =
      boards[boardIndex + 1] ??
      boards[boardIndex - 1];

    setBoards((currentBoards) =>
      currentBoards.filter(
        (board) => board.id !== boardId,
      ),
    );

    if (boardId === activeBoardId && nextActiveBoard) {
      setActiveBoardId(nextActiveBoard.id);
    }
  }

  const updateBoardDrawing = useCallback(
    (
      boardId: number,
      drawing: string,
    ) => {
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.id === boardId
            ? {
              ...board,
              drawing,
            }
            : board,
        ),
      );
    },
    [],
  );

  if (!activeBoard) {
    return null;
  }

  async function askGemini() {
    const prompt = assistantPrompt.trim();

    if (!prompt || isGenerating) {
      return;
    }

    /*
     * Unlock Web Audio while this function is still running from the
     * user's submit/click gesture. Browsers may block audio if the
     * AudioContext is first resumed only after the Gemini request ends.
     */
    const teacherAudioContext = getTeacherAudioContext();

    if (teacherAudioContext?.state === "suspended") {
      void teacherAudioContext.resume().catch(() => {
        // If the browser still blocks it, the pause/resume button is
        // another user gesture and can resume it later.
      });
    }

    if (isTeaching) {
      stopTeaching();
    }

    /*
     * Very obvious board commands do not need Gemini at all.
     * This makes them instant and saves an API request.
     */
    const localCommand = getLocalBoardCommand(prompt);

    if (localCommand === "clear") {
      clearBoard();
      setAssistantPrompt("");
      setAssistantError(null);

      const quickCommand: BoardCommand = {
        type: "write_text",
        title: "Board cleared",
        bullets: [],
      };

      void speakSingleBoardResponse(quickCommand);
      return;
    }

    if (localCommand === "new") {
      addBoard();
      setAssistantPrompt("");
      setAssistantError(null);

      const quickCommand: BoardCommand = {
        type: "write_text",
        title: "New board created",
        bullets: [],
      };

      void speakSingleBoardResponse(quickCommand);
      return;
    }

    // Remember the exact board that started this request.
    const targetBoardId = activeBoardId;
    const targetBoard = boards.find(
      (board) => board.id === targetBoardId,
    );

    if (!targetBoard) {
      return;
    }

    /*
     * Sending a 1600x900 PNG on every request adds latency.
     * For most text/chart requests, only attach it when the prompt
     * looks like a follow-up.
     *
     * Important exception: if the current board already contains an
     * AI-generated image, always provide an image context source.
     * Otherwise requests such as "make the dog smaller" may route to
     * edit_board_image without an actual image to edit.
     *
     * If the board snapshot has not been saved yet, fall back to the
     * current generated image data URL.
     */
    const boardImageForGemini =
      getBoardImageForGemini(targetBoard);

    const sendBoardImage =
      Boolean(boardImageForGemini) &&
      (looksLikeBoardFollowUp(prompt) ||
        targetBoard.generatedCommand?.type === "image");

    setIsGenerating(true);
    setAssistantError(null);

    try {
      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          currentCommand:
            targetBoard.generatedCommand,
          boardImage: sendBoardImage
            ? boardImageForGemini
            : null,
        }),
      });

      const data = (await response.json()) as {
        tool?: string;
        command?: BoardCommand | TeacherLessonCommand;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          data.error ?? "Gemini request failed.",
        );
      }

      if (!data.command) {
        throw new Error(
          "Gemini returned no whiteboard command.",
        );
      }

      const command = data.command;

      if (command.type === "teach_lesson") {
        setAssistantPrompt("");

        void runTeacherLesson(
          targetBoardId,
          command,
        );

        return;
      }

      // command is now narrowed to BoardCommand.
      const nextVersion =
        (boardVersionRef.current[targetBoardId] ??
          targetBoard.generatedCommandVersion) + 1;

      boardVersionRef.current[targetBoardId] = nextVersion;

      // Render the board immediately. TTS generation and playback no longer
      // own or pace the visual teaching aid.
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.id === targetBoardId
            ? {
                ...board,
                generatedCommand: command,
                generatedCommandVersion: nextVersion,
              }
            : board,
        ),
      );

      // Every normal response is spoken too. The existing structured
      // command becomes a concise narration, so this adds no extra
      // Gemini reasoning call before TTS starts.
      void speakSingleBoardResponse(
        command,
        "en-US",
      );

      setAssistantPrompt("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Something went wrong.";

      setAssistantError(message);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="studio">
      <header className="studio-header">
        <div className="studio-brand">
          <div className="brand-mark" />

          <div>
            <h1>LIXIA</h1>
            <p>Whiteboard Mode</p>
          </div>
        </div>

        <div className="studio-title">
          <strong>{activeBoard.name}</strong>
          <span>
            Board {activeBoard.id}
          </span>
        </div>

        <div className="header-actions">
          <button type="button">
            Share
          </button>

          <button type="button">
            Export
          </button>

          <button
            type="button"
            onClick={addBoard}
          >
            New Board
          </button>

          <button
            type="button"
            className="primary"
          >
            Save
          </button>
        </div>
      </header>

      <section className="studio-scene">
        <div className="studio-toolbar vertical">
          <button
            type="button"
            disabled={cameraMode}
            className={
              tool === "pen"
                ? "toolbar-button active"
                : "toolbar-button"
            }
            onClick={() => setTool("pen")}
            title="Pen"
          >
            ✎
          </button>

          <button
            type="button"
            disabled={cameraMode}
            className={
              tool === "eraser"
                ? "toolbar-button active"
                : "toolbar-button"
            }
            onClick={() => setTool("eraser")}
            title="Eraser"
          >
            ◇
          </button>

          <input
            type="color"
            disabled={cameraMode}
            value={penColor}
            title="Choose color"
            className="toolbar-color"
            onChange={(event) => {
              setPenColor(event.target.value);
              setTool("pen");
            }}
          />

          <div className="toolbar-divider" />

          <input
            type="range"
            min="2"
            max="30"
            disabled={cameraMode}
            value={lineWidth}
            title="Line thickness"
            className="toolbar-range vertical-range"
            onChange={(event) => {
              setLineWidth(Number(event.target.value));
            }}
          />

          <div className="toolbar-divider" />

          <button
            type="button"
            disabled={cameraMode}
            className="toolbar-button danger"
            onClick={clearBoard}
            title="Clear board"
          >
            🗑
          </button>

          <button
            type="button"
            className={
              cameraMode
                ? "toolbar-button camera-active"
                : "toolbar-button"
            }
            onClick={toggleCameraMode}
            title={
              cameraMode
                ? "Return to drawing mode"
                : "Camera mode"
            }
          >
            📷
          </button>
        </div>

        <div className="mode-label">
          {cameraMode
            ? "Camera Mode"
            : "Drawing Mode"}
        </div>

        <div
          ref={assistantPanelRef}
          className={
            assistantPanelPos
              ? "lixia-assistant-panel is-moved"
              : "lixia-assistant-panel"
          }
          style={
            assistantPanelPos
              ? {
                  left: assistantPanelPos.left,
                  top: assistantPanelPos.top,
                }
              : undefined
          }
        >
          <div
            className="assistant-header"
            title="Drag to move"
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }

              const panel = assistantPanelRef.current;
              const parent = panel?.offsetParent as HTMLElement | null;

              if (!panel || !parent) {
                return;
              }

              const panelRect = panel.getBoundingClientRect();
              const parentRect = parent.getBoundingClientRect();

              assistantDragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                origLeft: panelRect.left - parentRect.left,
                origTop: panelRect.top - parentRect.top,
              };

              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = assistantDragRef.current;
              const panel = assistantPanelRef.current;
              const parent = panel?.offsetParent as HTMLElement | null;

              if (!drag || drag.pointerId !== event.pointerId || !panel || !parent) {
                return;
              }

              const nextLeft =
                drag.origLeft + (event.clientX - drag.startX);
              const nextTop =
                drag.origTop + (event.clientY - drag.startY);
              const maxLeft = Math.max(
                8,
                parent.clientWidth - panel.offsetWidth - 8,
              );
              const maxTop = Math.max(
                8,
                parent.clientHeight - panel.offsetHeight - 8,
              );

              setAssistantPanelPos({
                left: Math.min(maxLeft, Math.max(8, nextLeft)),
                top: Math.min(maxTop, Math.max(8, nextTop)),
              });
            }}
            onPointerUp={(event) => {
              if (assistantDragRef.current?.pointerId === event.pointerId) {
                assistantDragRef.current = null;

                const panel = assistantPanelRef.current;
                const parent = panel?.offsetParent as HTMLElement | null;

                if (panel && parent) {
                  const panelRect = panel.getBoundingClientRect();
                  const parentRect = parent.getBoundingClientRect();
                  const next = {
                    left: panelRect.left - parentRect.left,
                    top: panelRect.top - parentRect.top,
                  };

                  setAssistantPanelPos(next);

                  try {
                    window.localStorage.setItem(
                      "lixia-assistant-panel-pos",
                      JSON.stringify(next),
                    );
                  } catch {
                    // Ignore storage failures.
                  }
                }
              }
            }}
            onPointerCancel={() => {
              assistantDragRef.current = null;
            }}
          >
            <div className="assistant-avatar">
              L
            </div>

            <div>
              <strong>Lixia</strong>
              <span>
                <span className="online-dot" />
                {isTeaching
                  ? isTeachingPaused
                    ? "Voice paused"
                    : "Speaking..."
                  : "Ready to help"}
              </span>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: 6,
              margin: "10px 0 4px",
              padding: "9px 10px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.06)",
              fontSize: 12,
            }}
          >
            <label
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr 34px",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span>Writing</span>
              <input
                type="range"
                min="10"
                max="100"
                value={writingSpeed}
                title="Lixia writing speed"
                onChange={(event) =>
                  setWritingSpeed(Number(event.target.value))
                }
              />
              <strong>{writingSpeed}</strong>
            </label>

            <label
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr 34px",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span>Drawing</span>
              <input
                type="range"
                min="10"
                max="100"
                value={drawingSpeed}
                title="Lixia drawing speed"
                onChange={(event) =>
                  setDrawingSpeed(Number(event.target.value))
                }
              />
              <strong>{drawingSpeed}</strong>
            </label>
          </div>

          {assistantError && (
            <p className="assistant-error">
              {assistantError}
            </p>
          )}

          <form
            className="assistant-input-area"
            onSubmit={(event) => {
              event.preventDefault();
              void askGemini();
            }}
          >
            <input
              type="text"
              value={assistantPrompt}
              disabled={isGenerating}
              placeholder="Ask Lixia..."
              aria-label="Ask Lixia"
              onChange={(event) =>
                setAssistantPrompt(
                  event.target.value,
                )
              }
            />

            {isTeaching ? (
              <>
                <button
                  type="button"
                  className="assistant-mic-button"
                  title={
                    isTeachingPaused
                      ? "Resume voice"
                      : "Pause voice"
                  }
                  disabled={isGenerating}
                  onClick={() => {
                    if (isTeachingPaused) {
                      void resumeTeaching();
                    } else {
                      void pauseTeaching();
                    }
                  }}
                >
                  {isTeachingPaused ? "▶" : "⏸"}
                </button>

                <button
                  type="button"
                  className="assistant-mic-button"
                  title="Stop voice"
                  disabled={isGenerating}
                  onClick={stopTeaching}
                >
                  ⏹
                </button>
              </>
            ) : (
              <button
                type="button"
                className="assistant-mic-button"
                title="Microphone will be added later"
                disabled={isGenerating}
              >
                🎤
              </button>
            )}

            <button
              type="submit"
              className="assistant-send-button"
              title="Send prompt"
              disabled={
                isGenerating ||
                !assistantPrompt.trim()
              }
            >
              {isGenerating ? "…" : "➤"}
            </button>
          </form>


        </div>

        <Canvas
          shadows={{ type: THREE.PCFShadowMap }}
          camera={{
            position:
              DEFAULT_CAMERA_POSITION,
            fov: 36,
            near: 0.1,
            far: 100,
          }}
        >
          <InitialCameraSetup />

          <color
            attach="background"
            args={["#0c0f18"]}
          />

          <ambientLight intensity={1} />

          <directionalLight
            castShadow
            position={[5, 8, 6]}
            intensity={2.2}
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />

          <StudioEnvironment />

          {MikeModel ? (
            <MikeModel
              onMeasured={handleMikeMeasured}
              onReady={handleMikeReady}
            />
          ) : null}
          <PresentationBoard
            position={[
              BOARD_X,
              boardLayout.y,
              BOARD_Z,
            ]}
            frameHeight={boardLayout.frameHeight}
            cameraMode={cameraMode}
            tool={tool}
            penColor={penColor}
            lineWidth={lineWidth}
            clearSignal={clearSignal}
            boardId={activeBoard.id}
            savedDrawing={activeBoard.drawing}
            generatedCommand={
              activeBoard.generatedCommand
            }
            generatedCommandVersion={
              activeBoard.generatedCommandVersion
            }
            writingSpeed={writingSpeed}
            drawingSpeed={drawingSpeed}
            onDrawingChange={updateBoardDrawing}
          />

          <OrbitControls
            enabled={cameraMode}
            target={
              DEFAULT_CAMERA_TARGET
            }
            enableRotate
            enableZoom
            enablePan
            enableDamping
            dampingFactor={0.08}
            minDistance={4}
            maxDistance={18}
          />
        </Canvas>

        <div className="board-strip">
          <button
            type="button"
            className="board-add-card"
            onClick={addBoard}
          >
            <span className="board-add-icon">
              +
            </span>

            <span>New Board</span>
          </button>

          <div className="board-list">
            {boards.map((board) => (
              <div
                key={board.id}
                className="board-card-shell"
              >
                <button
                  type="button"
                  className={
                    board.id ===
                      activeBoardId
                      ? "board-card active"
                      : "board-card"
                  }
                  onClick={() =>
                    selectBoard(board.id)
                  }
                >
                  <div className="board-preview">
                    {board.drawing ? (
                      <img
                        src={board.drawing}
                        alt={board.name}
                        className="board-preview-image"
                      />
                    ) : (
                      <div className="board-preview-placeholder">
                        <span className="placeholder-icon">📝</span>
                        <span>Empty Board</span>
                      </div>
                    )}
                  </div>
                  <div className="board-card-footer">
                    <span>{board.id}</span>
                    <strong>
                      {board.name}
                    </strong>
                  </div>
                </button>

                <button
                  type="button"
                  className="board-card-delete"
                  onClick={() => deleteBoard(board.id)}
                  disabled={boards.length <= 1}
                  title={
                    boards.length > 1
                      ? `Delete ${board.name}`
                      : "At least one board must remain"
                  }
                  aria-label={`Delete ${board.name}`}
                >
                  🗑
                </button>
              </div>
            ))}

            <button
              type="button"
              className="board-add-card compact"
              onClick={addBoard}
            >
              <span className="board-add-icon">
                +
              </span>

              <span>Add Board</span>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
