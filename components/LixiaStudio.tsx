"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
import type { MikeBounds } from "./MikeModel";

import PresentationBoard from "./PresentationBoard";
import type { DrawingTool } from "./PresentationBoard";

import StudioEnvironment from "./StudioEnvironment";

import type {
  Board,
  BoardCommand,
} from "@/types/board";

const BOARD_X = 1.4;
const BOARD_Z = -0.7;

const HIP_RATIO = 0.42;
const BELOW_HIP_OFFSET = 0.25;
const ABOVE_HEAD_OFFSET = 0.75;




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
    "make it",
    "make this",
    "make that",
    "this ",
    "that ",
    " it ",
    "same ",
    "above",
    "below",
    "beside",
    "next to",
    "on the side",
    "the chart",
    "the graph",
    "the flowchart",
    "the diagram",
    "the board",
  ];

  return markers.some((marker) =>
    normalized.includes(marker),
  );
}

export default function LixiaStudio() {


  const [assistantPrompt, setAssistantPrompt] =
    useState("");

  const [isGenerating, setIsGenerating] =
    useState(false);

  const [assistantError, setAssistantError] =
    useState<string | null>(null);

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
     * Very obvious board commands do not need Gemini at all.
     * This makes them instant and saves an API request.
     */
    const localCommand = getLocalBoardCommand(prompt);

    if (localCommand === "clear") {
      clearBoard();
      setAssistantPrompt("");
      setAssistantError(null);
      return;
    }

    if (localCommand === "new") {
      addBoard();
      setAssistantPrompt("");
      setAssistantError(null);
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
     * New standalone questions such as "what is silver?" do not
     * need it. Follow-up/edit language does, so only attach the
     * board screenshot when it is likely useful.
     */
    const sendBoardImage =
      looksLikeBoardFollowUp(prompt);

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
            ? targetBoard.drawing
            : null,
        }),
      });

      const data = (await response.json()) as {
        tool?: string;
        command?: BoardCommand;
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

      // Store the result only on the board that started the request.
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.id === targetBoardId
            ? {
                ...board,
                generatedCommand: data.command ?? null,
                generatedCommandVersion:
                  board.generatedCommandVersion + 1,
              }
            : board,
        ),
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

        <div className="lixia-assistant-panel">
          <div className="assistant-header">
            <div className="assistant-avatar">
              L
            </div>

            <div>
              <strong>Lixia</strong>
              <span>
                <span className="online-dot" />
                Ready to help
              </span>
            </div>
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

            <button
              type="button"
              className="assistant-mic-button"
              title="Microphone will be added later"
              disabled={isGenerating}
            >
              🎤
            </button>

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
            onDrawingChange={updateBoardDrawing}
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