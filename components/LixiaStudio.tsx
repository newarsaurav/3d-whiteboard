"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  Canvas,
  useFrame,
  useThree,
} from "@react-three/fiber";

import {
  OrbitControls,
} from "@react-three/drei";
import * as THREE from "three";

import type {
  MikeAnimationApi,
  MikeBounds,
  MikeSpeakingOptions,
} from "./MikeModel";

import {
  cameraShotForIntent,
  estimateSpeechSeconds,
  FALLBACK_LESSON_GESTURES,
  gestureForBoardCommand,
  resolveGesturePlan,
  shouldLookAtBoard,
} from "@/lib/presentationGestures";

import PresentationBoard from "./PresentationBoard";
import type {
  DrawingTool,
  TextSize,
} from "./PresentationBoard";

import StudioEnvironment from "./StudioEnvironment";

type MikeModelComponent = ComponentType<{
  onMeasured?: (bounds: MikeBounds) => void;
  onReady?: (api: MikeAnimationApi) => void;
  lookTarget?: [number, number, number] | null;
  lookStrength?: number;
}>;

import type {
  Board,
  BoardCommand,
  BoardManagementCommand,
  TeacherLessonCommand,
} from "@/types/board";

const BOARD_X = 1.4;
const BOARD_Z = -0.7;

const HIP_RATIO = 0.42;
const BELOW_HIP_OFFSET = 0.25;
const ABOVE_HEAD_OFFSET = 0.75;

type CameraShot = "waist" | "full" | "close";

const CAMERA_FOV = 34;

const WAIST_CAMERA_POSITION: [
  number,
  number,
  number,
] = [-0.4, 4.21, 7.46];

const WAIST_CAMERA_TARGET: [
  number,
  number,
  number,
] = [-0.13, 4.32, -0.71];

const FULL_CAMERA_POSITION: [
  number,
  number,
  number,
] = [-0.4, 2.72, 12.2];

const FULL_CAMERA_TARGET: [
  number,
  number,
  number,
] = [-0.13, 2.62, -0.71];

function getShotPose(
  shot: CameraShot,
  bounds: MikeBounds | null,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  if (shot === "waist") {
    return {
      position: new THREE.Vector3(...WAIST_CAMERA_POSITION),
      target: new THREE.Vector3(...WAIST_CAMERA_TARGET),
    };
  }

  if (shot === "full") {
    if (!bounds) {
      return {
        position: new THREE.Vector3(...FULL_CAMERA_POSITION),
        target: new THREE.Vector3(...FULL_CAMERA_TARGET),
      };
    }

    const topY = bounds.headY + 0.7;
    const bottomY = bounds.feetY - 0.2;
    const midY = (topY + bottomY) / 2;
    const halfSpan = Math.max(2.8, (topY - bottomY) / 2);
    const distance =
      halfSpan / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) * 0.5) + 1.5;

    return {
      position: new THREE.Vector3(
        WAIST_CAMERA_POSITION[0],
        midY,
        WAIST_CAMERA_TARGET[2] + distance,
      ),
      target: new THREE.Vector3(
        WAIST_CAMERA_TARGET[0],
        midY,
        WAIST_CAMERA_TARGET[2],
      ),
    };
  }

  if (shot === "close") {
    if (!bounds) {
      return {
        position: new THREE.Vector3(-0.15, 3.35, 6.2),
        target: new THREE.Vector3(-0.2, 3.15, 0.1),
      };
    }
    const handsY = bounds.waistY - 0.4;
    const bottomY = Math.max(bounds.feetY + 0.2, handsY);
    const topY = bounds.headY + 0.14;
    const midY = (bottomY + topY) / 2;
    const span = Math.max(1.8, topY - bottomY);
    const distance = span * 1.62;
    const mikeBias = 0.58;
    const lookX = BOARD_X * (1 - mikeBias) + bounds.centerX * mikeBias;
    const lookZ = BOARD_Z * (1 - mikeBias) + bounds.centerZ * mikeBias;
    return {
      position: new THREE.Vector3(lookX, midY, lookZ + distance),
      target: new THREE.Vector3(lookX, midY, lookZ),
    };
  }

  return {
    position: new THREE.Vector3(...FULL_CAMERA_POSITION),
    target: new THREE.Vector3(...FULL_CAMERA_TARGET),
  };
}

function CameraShotController({
  shot,
  bounds,
}: {
  shot: CameraShot;
  bounds: MikeBounds | null;
}) {
  const { camera, controls } = useThree();
  const pose = useMemo(
    () => getShotPose(shot, bounds),
    [shot, bounds],
  );
  const currentTarget = useRef(pose.target.clone());
  const arrivingRef = useRef(true);
  const shotKey = shot === "waist"
    ? "waist"
    : `${shot}:${bounds?.waistY ?? "x"}:${bounds?.headY ?? "x"}`;

  useEffect(() => {
    arrivingRef.current = true;
  }, [shotKey]);

  useFrame((_, delta) => {
    if (!arrivingRef.current) return;

    const blend = 1 - Math.exp(-delta * 6);
    camera.position.lerp(pose.position, blend);
    currentTarget.current.lerp(pose.target, blend);
    camera.lookAt(currentTarget.current);

    const orbit = controls as
      | { target?: THREE.Vector3; update?: () => void }
      | undefined;
    if (orbit?.target) {
      orbit.target.copy(currentTarget.current);
      orbit.update?.();
    }

    if (
      camera.position.distanceTo(pose.position) < 0.035 &&
      currentTarget.current.distanceTo(pose.target) < 0.035
    ) {
      camera.position.copy(pose.position);
      currentTarget.current.copy(pose.target);
      camera.lookAt(currentTarget.current);
      arrivingRef.current = false;
    }
  });

  return null;
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

function getBoardSearchText(board: Board): string {
  const command = board.generatedCommand;

  if (!command) {
    return "";
  }

  if (command.type === "write_text") {
    return [
      command.title,
      ...command.bullets,
      ...(command.formulas ?? []),
      command.note ?? "",
    ].join(" ");
  }

  if (command.type === "flowchart") {
    return [
      command.title,
      ...command.nodes.map((node) => node.label),
      ...command.edges.map((edge) => edge.label ?? ""),
    ].join(" ");
  }

  if (command.type === "chart") {
    return [
      command.title,
      command.subtitle ?? "",
      command.xAxisLabel ?? "",
      command.yAxisLabel ?? "",
      ...command.series.map((series) => series.label),
    ].join(" ");
  }

  return command.title ?? "";
}

function estimateTextCommandLength(
  command: BoardCommand,
): number {
  if (command.type !== "write_text") {
    return Number.POSITIVE_INFINITY;
  }

  return [
    command.title,
    ...command.bullets,
    ...(command.formulas ?? []),
    command.note ?? "",
  ].join(" ").length;
}

function canAppendTextCommand(
  currentCommand: BoardCommand | null,
  nextCommand: BoardCommand,
): currentCommand is Extract<BoardCommand, { type: "write_text" }> {
  if (
    !currentCommand ||
    currentCommand.type !== "write_text" ||
    nextCommand.type !== "write_text"
  ) {
    return false;
  }

  const addsTitleBullet =
    nextCommand.title.trim() &&
    nextCommand.title.trim() !== currentCommand.title.trim()
      ? 1
      : 0;

  return (
    currentCommand.bullets.length +
      nextCommand.bullets.length +
      addsTitleBullet <= 7 &&
    (currentCommand.formulas?.length ?? 0) +
      (nextCommand.formulas?.length ?? 0) <= 3 &&
    estimateTextCommandLength(currentCommand) +
      estimateTextCommandLength(nextCommand) <= 950
  );
}

function appendTextCommand(
  currentCommand: Extract<BoardCommand, { type: "write_text" }>,
  nextCommand: Extract<BoardCommand, { type: "write_text" }>,
): Extract<BoardCommand, { type: "write_text" }> {
  const titleBullet =
    nextCommand.title.trim() &&
    nextCommand.title.trim() !== currentCommand.title.trim()
      ? [`${nextCommand.title.trim()}:`]
      : [];

  return {
    type: "write_text",
    title: currentCommand.title,
    bullets: [
      ...currentCommand.bullets,
      ...titleBullet,
      ...nextCommand.bullets,
    ],
    formulas: [
      ...(currentCommand.formulas ?? []),
      ...(nextCommand.formulas ?? []),
    ],
    note: [currentCommand.note, nextCommand.note]
      .filter((note): note is string => Boolean(note?.trim()))
      .join(" "),
  };
}

function appendLessonToTextCommand(
  currentCommand: Extract<BoardCommand, { type: "write_text" }>,
  lesson: TeacherLessonCommand,
): TeacherLessonCommand {
  return {
    ...lesson,
    segments: lesson.segments.map((segment) => ({
      ...segment,
      board: appendTextCommand(
        currentCommand,
        segment.board,
      ),
    })),
  };
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
  const assistantPanelRef = useRef<HTMLDivElement>(null);
  const assistantDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [assistantPosition, setAssistantPosition] = useState({ x: 0, y: 0 });
  const [isAssistantDragging, setIsAssistantDragging] = useState(false);

  function startAssistantDrag(event: ReactPointerEvent<HTMLDivElement>) {
    assistantDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: assistantPosition.x,
      originY: assistantPosition.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsAssistantDragging(true);
  }

  function moveAssistantPanel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = assistantDragRef.current;
    const panel = assistantPanelRef.current;
    const scene = panel?.parentElement;
    if (!drag || drag.pointerId !== event.pointerId || !panel || !scene) return;

    const panelRect = panel.getBoundingClientRect();
    const sceneRect = scene.getBoundingClientRect();
    const baseLeft = panelRect.left - assistantPosition.x;
    const baseTop = panelRect.top - assistantPosition.y;
    const desiredX = drag.originX + event.clientX - drag.startX;
    const desiredY = drag.originY + event.clientY - drag.startY;
    const inset = 8;

    setAssistantPosition({
      x: Math.min(
        sceneRect.right - panelRect.width - baseLeft - inset,
        Math.max(sceneRect.left - baseLeft + inset, desiredX),
      ),
      y: Math.min(
        sceneRect.bottom - panelRect.height - baseTop - inset,
        Math.max(sceneRect.top - baseTop + inset, desiredY),
      ),
    });
  }

  function stopAssistantDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (assistantDragRef.current?.pointerId !== event.pointerId) return;
    assistantDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsAssistantDragging(false);
  }



  const [assistantPrompt, setAssistantPrompt] =
    useState("");

  const [isGenerating, setIsGenerating] =
    useState(false);

  const [assistantError, setAssistantError] =
    useState<string | null>(null);

  const [isTeaching, setIsTeaching] =
    useState(false);

  const [isTeachingPaused, setIsTeachingPaused] =
    useState(false);

  const teachingRunRef = useRef(0);

  const boardVersionRef =
    useRef<Record<number, number>>({ 1: 0 });

  const boardRenderWaitersRef = useRef(
    new Map<string, () => void>(),
  );

  const teacherAudioContextRef =
    useRef<AudioContext | null>(null);

  const teacherAbortControllerRef =
    useRef<AbortController | null>(null);

  const teacherAudioSourcesRef =
    useRef<Set<AudioBufferSourceNode>>(new Set());

  const mikeApiRef =
    useRef<MikeAnimationApi | null>(null);
  const activeSpeechMotionRef =
    useRef<MikeSpeakingOptions | null>(null);

  const handleMikeReady = useCallback(
    (api: MikeAnimationApi) => {
      mikeApiRef.current = api;
      const activeSpeech = activeSpeechMotionRef.current;
      if (activeSpeech) {
        api.setSpeaking(true, activeSpeech);
      }
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

  const [cameraShot, setCameraShot] =
    useState<CameraShot>("waist");

  const [cameraFollow, setCameraFollow] =
    useState(true);

  const [lookStrength, setLookStrength] =
    useState(0);

  const [mikeBounds, setMikeBounds] =
    useState<MikeBounds | null>(null);

  const cameraFollowRef = useRef(true);
  const cameraModeRef = useRef(false);
  const lastBoardCommandRef = useRef<BoardCommand | null>(null);
  const lastBoardCueVersionRef = useRef(0);

  useEffect(() => {
    cameraFollowRef.current = cameraFollow;
  }, [cameraFollow]);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  function applyAutoShot(shot: CameraShot) {
    if (!cameraFollowRef.current || cameraModeRef.current) return;
    setCameraShot(shot);
  }

  function chooseCameraShot(shot: CameraShot) {
    setCameraFollow(false);
    setCameraShot(shot);
  }
  const [tool, setTool] =
    useState<DrawingTool>("pen");

  const [penColor, setPenColor] =
    useState("#111111");

  const [lineWidth, setLineWidth] =
    useState(8);

  // 10 = slow and deliberate, 100 = very fast.
  const [writingSpeed, setWritingSpeed] =
    useState(55);

  const [textSize, setTextSize] =
    useState<TextSize>("medium");

  const [drawingSpeed, setDrawingSpeed] =
    useState(55);

  const [MikeModel, setMikeModel] =
    useState<MikeModelComponent | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("./MikeModel").then((mod) => {
      if (!cancelled) setMikeModel(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
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
    (bounds: MikeBounds) => {
      setMikeBounds(bounds);

      const { feetY, headY } = bounds;
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

  useEffect(() => {
    if (!isGenerating && !isTeaching) {
      mikeApiRef.current?.setIdleMode("rest");
      mikeApiRef.current?.setLookAtBoard(false);
      setLookStrength(0);
    }
  }, [isGenerating, isTeaching]);

  useEffect(() => {
    const command = activeBoard.generatedCommand;
    if (!command || command.type === "teach_lesson") return;
    lastBoardCommandRef.current = command;
    const version = activeBoard.generatedCommandVersion;
    if (!version || lastBoardCueVersionRef.current === version) return;
    lastBoardCueVersionRef.current = version;
    if (cameraFollowRef.current) {
      applyAutoShot("full");
    }
  }, [activeBoard]);

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

  function stopTeaching() {
    teachingRunRef.current += 1;
    stopActiveTeacherAudio();
    setIsTeaching(false);
    setIsTeachingPaused(false);
    activeSpeechMotionRef.current = null;
    mikeApiRef.current?.setPaused(false);
    mikeApiRef.current?.setSpeaking(false);
    mikeApiRef.current?.setLookAtBoard(false);
    mikeApiRef.current?.setIdleMode("rest");
    mikeApiRef.current?.playWaiting();
    setLookStrength(0);
    applyAutoShot("waist");
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
    if (runId !== teachingRunRef.current) return;
    const plan = resolveGesturePlan(gestureIntent, fallbackIndex);
    const options: MikeSpeakingOptions = {
      preferredAnimationId: plan.animationId,
      estimatedDurationSec: durationSeconds,
      forcePreferred: true,
      lookAtBoard: shouldLookAtBoard(plan.intent),
    };
    activeSpeechMotionRef.current = options;
    setLookStrength(shouldLookAtBoard(plan.intent) ? 0.4 : 0.24);
    applyAutoShot(cameraShotForIntent(plan.intent));
    mikeApiRef.current?.setSpeaking(true, options);
    if (shouldLookAtBoard(plan.intent)) {
      mikeApiRef.current?.setLookAtBoard(true, 0.4);
    }
  }

  async function prepareSpeechMotion(
    runId: number,
    gestureIntent: string | null | undefined,
    durationSeconds: number,
    fallbackIndex = 0,
  ) {
    if (runId !== teachingRunRef.current) return false;
    const mike = mikeApiRef.current;
    if (!mike) return false;

    const plan = resolveGesturePlan(gestureIntent, fallbackIndex);
    return mike.prepareSpeech({
      preferredAnimationId: plan.animationId,
      estimatedDurationSec: durationSeconds,
      forcePreferred: true,
      lookAtBoard: shouldLookAtBoard(plan.intent),
    });
  }

  function stopSpeechMotion(runId: number) {
    if (runId !== teachingRunRef.current) return;
    activeSpeechMotionRef.current = null;
    mikeApiRef.current?.setSpeaking(false);
    mikeApiRef.current?.setLookAtBoard(false);
    mikeApiRef.current?.playWaiting();
    setLookStrength(0);
    applyAutoShot("waist");
  }

  async function speakTeachingSegmentFallback(
    text: string,
    language: string,
    runId: number,
    gestureIntent?: string | null,
    fallbackIndex = 0,
  ): Promise<void> {
    const estimatedDuration = estimateSpeechSeconds(text);
    void prepareSpeechMotion(
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
  ): Promise<void> {
    if (!text.trim() || runId !== teachingRunRef.current) {
      return;
    }

    // Warm Mike independently while the original TTS stream starts normally.
    const speechMotionDuration = estimateSpeechSeconds(text);
    void prepareSpeechMotion(
      runId,
      gestureIntent,
      speechMotionDuration,
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
      const sourceEndPromises: Promise<void>[] = [];

      let leftover = new Uint8Array(0);
      let nextStartTime = Math.max(
        audioContext.currentTime + 0.08,
        audioContext.currentTime,
      );
      let receivedAudio = false;
      let speechMotionScheduled = false;

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

        const merged = new Uint8Array(
          leftover.byteLength + value.byteLength,
        );

        merged.set(leftover, 0);
        merged.set(value, leftover.byteLength);

        const usableLength =
          merged.byteLength - (merged.byteLength % 2);

        if (usableLength === 0) {
          leftover = merged;
          continue;
        }

        const usable = merged.subarray(0, usableLength);
        leftover = merged.slice(usableLength);

        const floatSamples = pcm16ToFloat32(usable);

        if (floatSamples.length === 0) {
          continue;
        }

        receivedAudio = true;

        const audioBuffer = audioContext.createBuffer(
          1,
          floatSamples.length,
          sampleRate,
        );

        audioBuffer.copyToChannel(floatSamples, 0);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        teacherAudioSourcesRef.current.add(source);

        const ended = new Promise<void>((resolve) => {
          source.onended = () => {
            teacherAudioSourcesRef.current.delete(source);
            resolve();
          };
        });

        sourceEndPromises.push(ended);
        const scheduledStart = nextStartTime;
        source.start(nextStartTime);
        nextStartTime += audioBuffer.duration;

        if (!speechMotionScheduled) {
          speechMotionScheduled = true;
          const delayMs = Math.max(
            0,
            (scheduledStart - audioContext.currentTime) * 1000,
          );
          window.setTimeout(() => {
            startSpeechMotion(
              runId,
              gestureIntent,
              text,
              fallbackIndex,
              speechMotionDuration,
            );
          }, delayMs);
        }
      }

      if (!receivedAudio) {
        throw new Error(
          "Gemini teacher voice returned an empty audio stream.",
        );
      }

      await Promise.all(sourceEndPromises);
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
  ) {
    const narration = buildSpokenResponse(command);

    if (!narration.trim()) {
      return;
    }

    stopTeaching();

    const runId = teachingRunRef.current + 1;
    teachingRunRef.current = runId;
    setIsTeaching(true);
    setIsTeachingPaused(false);
    setCameraFollow(true);
    applyAutoShot("full");

    const audioContext = getTeacherAudioContext();

    if (audioContext?.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // TTS playback will fall back to browser speech if needed.
      }
    }

    try {
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
      );
    } finally {
      if (runId === teachingRunRef.current) {
        setIsTeaching(false);
        setIsTeachingPaused(false);
        stopSpeechMotion(runId);
      }
    }
  }


  const handleBoardRenderComplete = useCallback(
    (boardId: number, version: number) => {
      const key = `${boardId}:${version}`;
      const resolve = boardRenderWaitersRef.current.get(key);

      if (resolve) {
        boardRenderWaitersRef.current.delete(key);
        resolve();
      }

      if (activeSpeechMotionRef.current) return;
      applyAutoShot("waist");
      setLookStrength(0);
    },
    [],
  );

  function waitForBoardRender(
    boardId: number,
    version: number,
    runId: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const key = `${boardId}:${version}`;
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        boardRenderWaitersRef.current.delete(key);
        resolve();
      };

      boardRenderWaitersRef.current.set(key, finish);

      // Safety timeout only. Normal completion comes from PresentationBoard.
      window.setTimeout(() => {
        if (runId !== teachingRunRef.current) {
          finish();
          return;
        }

        finish();
      }, 45000);
    });
  }

  async function runTeacherLesson(
    boardId: number,
    lesson: TeacherLessonCommand,
  ) {
    stopTeaching();

    const runId = teachingRunRef.current + 1;
    teachingRunRef.current = runId;
    setIsTeaching(true);
    setIsTeachingPaused(false);
    setCameraFollow(true);
    applyAutoShot("full");

    const audioContext = getTeacherAudioContext();

    if (audioContext?.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // The segment function will use the browser fallback if needed.
      }
    }

    try {
      for (const [
        segmentIndex,
        segment,
      ] of lesson.segments.entries()) {
        if (runId !== teachingRunRef.current) {
          return;
        }

        const nextVersion =
          (boardVersionRef.current[boardId] ?? 0) + 1;

        boardVersionRef.current[boardId] = nextVersion;

        const boardFinished = waitForBoardRender(
          boardId,
          nextVersion,
          runId,
        );

        setBoards((currentBoards) =>
          currentBoards.map((board) =>
            board.id === boardId
              ? {
                  ...board,
                  generatedCommand: segment.board,
                  generatedCommandVersion: nextVersion,
                }
              : board,
          ),
        );

        if (segment.board.writingSpeed !== undefined) {
          setWritingSpeed(segment.board.writingSpeed);
        }
        if (segment.board.drawingSpeed !== undefined) {
          setDrawingSpeed(segment.board.drawingSpeed);
        }


        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 180);
        });

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

// <!--         conflict changed 
//   // Start speaking while Lixia writes, like a real teacher.
//         // Do not advance to the next segment until BOTH have finished.
//         await Promise.all([
//           boardFinished,
//           speakTeachingSegment(
//             segment.narration,
//             lesson.language ?? "en-US",
//             runId,
//           ),
//         ]); -->

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

  function addBoard(): number {
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

    return nextId;
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

    // Remember the exact board that started this request.
    const targetBoardId = activeBoardId;
    const targetBoard = boards.find(
      (board) => board.id === targetBoardId,
    );

    if (!targetBoard) {
      return;
    }

    /*
     * If the board snapshot has not been saved yet, fall back to the
     * current generated image data URL. Otherwise always attach the
     * snapshot so Gemini can answer questions about user-drawn marks.
     */
    const boardImageForGemini =
      getBoardImageForGemini(targetBoard);

    // The board snapshot is visual context, not only edit context. Send it
    // whenever available so Gemini can inspect circles, underlines,
    // highlights, handwritten additions, and objects already on the board.
    const sendBoardImage = Boolean(boardImageForGemini);

    setIsGenerating(true);
    setCameraFollow(true);
    setAssistantError(null);

    try {
      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          currentCommand: targetBoard.generatedCommand,
          boards: boards.map((board) => ({
            id: board.id,
            name: board.name,
            searchText: getBoardSearchText(board),
          })),
          boardImage: sendBoardImage
            ? boardImageForGemini
            : null,
        }),
      });

      const data = (await response.json()) as {
        tool?: string;
        command?: BoardCommand | TeacherLessonCommand;
        management?: BoardManagementCommand;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          data.error ?? "Gemini request failed.",
        );
      }

      if (data.management) {
        if (data.management.action === "clear") {
          clearBoard();
        } else if (data.management.action === "delete") {
          deleteBoard(targetBoardId);
        } else if (data.management.action === "select") {
          const requestedName = data.management.boardName?.trim().toLowerCase();
          const requestedBoard = boards.find(
            (board) =>
              (data.management?.boardId !== undefined &&
                board.id === data.management.boardId) ||
              (requestedName !== undefined &&
                board.name.toLowerCase() === requestedName),
          );

          if (!requestedBoard) {
            throw new Error("I could not find that board.");
          }

          selectBoard(requestedBoard.id);
        } else {
          const newBoardId = addBoard();
          const newCommand: BoardCommand = {
            type: "write_text",
            title: data.management.title ?? data.management.topic ?? "New board",
            bullets: data.management.bullets ?? [],
            ...(data.management.formulas
              ? { formulas: data.management.formulas }
              : {}),
            ...(data.management.note
              ? { note: data.management.note }
              : {}),
          };
          const nextVersion = 1;

          boardVersionRef.current[newBoardId] = nextVersion;
          setBoards((currentBoards) =>
            currentBoards.map((board) =>
              board.id === newBoardId
                ? {
                    ...board,
                    generatedCommand: newCommand,
                    generatedCommandVersion: nextVersion,
                  }
                : board,
            ),
          );
          void speakSingleBoardResponse(newCommand);
        }

        setAssistantPrompt("");
        return;
      }

      if (!data.command) {
        throw new Error(
          "Gemini returned no whiteboard command.",
        );
      }

      const command = data.command;

      if (command.type === "teach_lesson") {
        setAssistantPrompt("");

        const currentTextCommand =
          targetBoard.generatedCommand?.type === "write_text"
            ? targetBoard.generatedCommand
            : null;
        const finalLessonBoard =
          command.segments[command.segments.length - 1]?.board;
        const canContinueOnCurrentBoard =
          currentTextCommand !== null &&
          finalLessonBoard !== undefined &&
          canAppendTextCommand(
            currentTextCommand,
            finalLessonBoard,
          );
        const lessonBoardId =
          targetBoard.generatedCommand !== null &&
          !canContinueOnCurrentBoard
            ? addBoard()
            : targetBoardId;
        const lessonToRun =
          canContinueOnCurrentBoard && currentTextCommand
            ? appendLessonToTextCommand(
                currentTextCommand,
                command,
              )
            : command;

        void runTeacherLesson(
          lessonBoardId,
          lessonToRun,
        );

        return;
      }

      if (command.type === "write_text") {
        if (command.writingSpeed !== undefined) {
          setWritingSpeed(command.writingSpeed);
        }
        if (command.drawingSpeed !== undefined) {
          setDrawingSpeed(command.drawingSpeed);
        }
      }

      // Keep earlier text answers visible when the active board has room.
      // Structured visuals stay intact by moving a new answer to a fresh board.
      const shouldAppend = canAppendTextCommand(
        targetBoard.generatedCommand,
        command,
      );
      const nextCommand =
        shouldAppend &&
        targetBoard.generatedCommand?.type === "write_text" &&
        command.type === "write_text"
          ? appendTextCommand(
              targetBoard.generatedCommand,
              command,
            )
          : command;
      const needsNewBoard =
        targetBoard.generatedCommand !== null &&
        !shouldAppend;
      const commandTargetBoardId = needsNewBoard
        ? addBoard()
        : targetBoardId;

      // command is now narrowed to BoardCommand.
      const nextVersion =
        (boardVersionRef.current[commandTargetBoardId] ??
          (needsNewBoard ? 0 : targetBoard.generatedCommandVersion)) + 1;

      boardVersionRef.current[commandTargetBoardId] = nextVersion;

      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.id === commandTargetBoardId
            ? {
                ...board,
                generatedCommand: nextCommand,
                generatedCommandVersion: nextVersion,
              }
            : board,
        ),
      );

      // Every normal response is spoken too. The existing structured
      // command becomes a concise narration, so this adds no extra
      // Gemini reasoning call before TTS starts.
      void speakSingleBoardResponse(command);

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

          <div className="toolbar-divider" />

          <button
            type="button"
            className={
              cameraShot === "waist"
                ? "toolbar-button shot active"
                : "toolbar-button shot"
            }
            onClick={() => chooseCameraShot("waist")}
            title="Waist-up camera"
          >
            ½
          </button>

          <button
            type="button"
            className={
              cameraShot === "full"
                ? "toolbar-button shot active"
                : "toolbar-button shot"
            }
            onClick={() => chooseCameraShot("full")}
            title="Full-body camera"
          >
            🧍
          </button>

          <button
            type="button"
            className={
              cameraFollow
                ? "toolbar-button shot active"
                : "toolbar-button shot"
            }
            onClick={() => {
              setCameraFollow(true);
              applyAutoShot(isTeaching || isGenerating ? cameraShot : "waist");
            }}
            title="Auto camera with the lesson"
          >
            A
          </button>
        </div>

        <div className="mode-label">
          {cameraMode
            ? "Camera Mode"
            : "Drawing Mode"}
          {cameraFollow
            ? " · Auto"
            : cameraShot === "close"
              ? " · Close"
              : cameraShot === "waist"
                ? " · Waist"
                : " · Full"}
        </div>

        <div
          ref={assistantPanelRef}
          className={`lixia-assistant-panel${isAssistantDragging ? " dragging" : ""}`}
          style={{
            transform: `translate3d(${assistantPosition.x}px, ${assistantPosition.y}px, 0)`,
          }}
        >
          <div
            className="assistant-header"
            title="Drag to move the assistant panel"
            onPointerDown={startAssistantDrag}
            onPointerMove={moveAssistantPanel}
            onPointerUp={stopAssistantDrag}
            onPointerCancel={stopAssistantDrag}
            onDoubleClick={() => setAssistantPosition({ x: 0, y: 0 })}
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
            <div className="text-size-controls" aria-label="Board text size">
              {(["small", "medium", "large"] as TextSize[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  className={textSize === size ? "active" : ""}
                  aria-pressed={textSize === size}
                  onClick={() => setTextSize(size)}
                >
                  {size[0].toUpperCase() + size.slice(1)}
                </button>
              ))}
            </div>

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
              WAIST_CAMERA_POSITION,
            fov: CAMERA_FOV,
            near: 0.1,
            far: 100,
          }}
        >
          <CameraShotController
            shot={cameraShot}
            bounds={mikeBounds}
          />

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
              lookTarget={[
                BOARD_X,
                boardLayout.y + boardLayout.frameHeight * 0.16,
                BOARD_Z,
              ]}
              lookStrength={lookStrength}
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
            textSize={textSize}
            writingSpeed={writingSpeed}
            drawingSpeed={drawingSpeed}
            animationPaused={isTeachingPaused}
            onDrawingChange={updateBoardDrawing}
            onCommandRenderComplete={
              handleBoardRenderComplete
            }
          />

          <OrbitControls
            makeDefault
            enabled={cameraMode}
            enableRotate
            enableZoom
            enablePan
            enableDamping
            dampingFactor={0.08}
            minDistance={3}
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
