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

import type { Board } from "@/types/board";

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

  useMemo(() => {
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

export default function LixiaStudio() {



  const [boardText, setBoardText] = useState("");

  const [assistantPrompt, setAssistantPrompt] =
    useState("");

  const [assistantResponse, setAssistantResponse] =
    useState(
      "Hello! What would you like me to explain on the board?",
    );

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
      generatedText: "",
      generatedTextVersion: 0,
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
      generatedText: "",
      generatedTextVersion: 0,
    };

    setBoards((currentBoards) => [
      ...currentBoards,
      newBoard,
    ]);

    setActiveBoardId(nextId);
  }

  if (!activeBoard) {
    return null;
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

  async function askGemini() {
    const prompt = assistantPrompt.trim();

    if (!prompt || isGenerating) {
      return;
    }

    /*
     * Remember which board started the request.
     * This value will not change if the user switches boards.
     */
    const targetBoardId = activeBoardId;

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
        }),
      });

      const data = (await response.json()) as {
        text?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          data.error ??
          "Gemini request failed.",
        );
      }

      if (!data.text) {
        throw new Error(
          "Gemini returned no text.",
        );
      }

      setAssistantResponse(data.text);

      /*
       * Store the response only on the board
       * that was active when the request began.
       */
      setBoards((currentBoards) =>
        currentBoards.map((board) =>
          board.id === targetBoardId
            ? {
              ...board,

              /*
               * Clear the previous board image so the
               * new AI response starts on a clean board.
               *
               * Remove this line if you want AI content
               * added below existing content instead.
               */
              drawing: null,

              generatedText: data.text ?? "",

              generatedTextVersion:
                board.generatedTextVersion + 1,
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

          <div className="assistant-message">
            <p className="assistant-response-text">
              {isGenerating
                ? "Lixia is thinking..."
                : assistantResponse}
            </p>

            {assistantError && (
              <p className="assistant-error">
                {assistantError}
              </p>
            )}
          </div>

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
            generatedText={
              activeBoard.generatedText
            }
            generatedTextVersion={
              activeBoard.generatedTextVersion
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
              <button
                key={board.id}
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