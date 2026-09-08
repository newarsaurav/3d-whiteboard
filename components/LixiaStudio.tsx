"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Canvas,
  useThree,
} from "@react-three/fiber";

import {
  Environment,
  OrbitControls,
} from "@react-three/drei";

import MikeModel from "./MikeModel";
import type {
  MikeAnimationApi,
  MikeBounds,
} from "./MikeModel";

import { presentationDirector } from "@lixia/mike-animation";

import PresentationBoard from "./PresentationBoard";
import type {
  DrawingTool,
  TextSize,
} from "./PresentationBoard";

import StudioEnvironment from "./StudioEnvironment";

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

/**
 * When Gemini does not name a gesture for a lesson segment, rotate
 * through natural teaching gestures so Mike never freezes mid-lesson.
 */
const FALLBACK_LESSON_GESTURES = [
  "explain",
  "point",
  "emphasize",
  "offer",
] as const;

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
] = [0, 3.5, 11];

const DEFAULT_CAMERA_TARGET: [
  number,
  number,
  number,
] = [0.5, 2.2, 0];


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

  const handleMikeReady = useCallback(
    (api: MikeAnimationApi) => {
      mikeApiRef.current = api;
    },
    [],
  );

  /**
   * Resolve a gesture intent through the presentation director (which
   * only admits approved registry clips). While Mike is speaking, the
   * model keeps a looping talk pose and chains hand gestures for the
   * whole narration — this call just picks the next meaningful clip.
   */
  const playGestureIntent = useCallback(
    (intent: string | null | undefined) => {
      const mike = mikeApiRef.current;

      if (!mike || !intent) {
        return;
      }

      try {
        const plan = presentationDirector.resolve({
          gesture: intent,
        });

        if (plan.mode === "idle") {
          mike.playWaiting();
          return;
        }

        if (plan.mode !== "play" || !plan.animation_id) {
          return;
        }

        if (plan.record?.body_layer === "upper_body") {
          void mike.playGesture(plan.animation_id, {
            repeats: 1,
          });
        } else {
          void mike.playAnimation(plan.animation_id, {
            repeats: 1,
          });
        }
      } catch (error) {
        // Unknown intents are non-fatal: Mike simply keeps his
        // current pose instead of interrupting the lesson.
        console.warn(
          `Skipping unknown gesture intent "${intent}":`,
          error,
        );
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

  function stopTeaching() {
    teachingRunRef.current += 1;
    stopActiveTeacherAudio();
    setIsTeaching(false);
    setIsTeachingPaused(false);
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

  async function speakTeachingSegmentFallback(
    text: string,
    language: string,
    runId: number,
  ): Promise<void> {
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
        resolve();
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
  ): Promise<void> {
    if (!text.trim() || runId !== teachingRunRef.current) {
      return;
    }

    const audioContext = getTeacherAudioContext();

    if (!audioContext) {
      await speakTeachingSegmentFallback(
        text,
        language,
        runId,
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
        source.start(nextStartTime);
        nextStartTime += audioBuffer.duration;
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
      );
    } finally {
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

      mikeApiRef.current?.setSpeaking(true);
      playGestureIntent(gestureForBoardCommand(command));

      await speakTeachingSegment(
        narration,
        language,
        runId,
      );
    } finally {
      if (runId === teachingRunRef.current) {
        setIsTeaching(false);
        setIsTeachingPaused(false);
        mikeApiRef.current?.setSpeaking(false);
        mikeApiRef.current?.playWaiting();
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

    const audioContext = getTeacherAudioContext();

    if (audioContext?.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        // The segment function will use the browser fallback if needed.
      }
    }

    try {
      mikeApiRef.current?.setSpeaking(true);

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

        playGestureIntent(
          segment.gesture ??
            FALLBACK_LESSON_GESTURES[
              segmentIndex % FALLBACK_LESSON_GESTURES.length
            ],
        );

        await speakTeachingSegment(
          segment.narration,
          lesson.language ?? "en-US",
          runId,
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
        mikeApiRef.current?.setSpeaking(false);
        mikeApiRef.current?.playWaiting();
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
        </div>

        <div className="mode-label">
          {cameraMode
            ? "Camera Mode"
            : "Drawing Mode"}
        </div>

        <div className="lixia-assistant-panel">
          <div className="assistant-header">
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
          shadows
          camera={{
            position:
              DEFAULT_CAMERA_POSITION,
            fov: 42,
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
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
          />

          <StudioEnvironment />

          <MikeModel
            onMeasured={
              handleMikeMeasured
            }
            onReady={handleMikeReady}
          />
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

          <Environment preset="city" />

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
            minDistance={6}
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