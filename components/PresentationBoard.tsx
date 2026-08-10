"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

export type DrawingTool = "pen" | "eraser";

interface PresentationBoardProps {
  position: [number, number, number];
  frameHeight: number;

  cameraMode: boolean;
  tool: DrawingTool;
  penColor: string;
  lineWidth: number;
  clearSignal: number;

  boardId: number;
  savedDrawing: string | null;

  generatedText: string;
  generatedTextVersion: number;

  onDrawingChange: (
    boardId: number,
    drawing: string,
  ) => void;
}

type Point = {
  x: number;
  y: number;
};

type CharacterInstruction = {
  character: string;
  x: number;
  y: number;
  font: string;
  color: string;
  rotation: number;
  delay: number;
};

const FRAME_WIDTH = 7.4;
const FRAME_DEPTH = 0.18;
const INNER_MARGIN = 0.38;

const FLOOR_Y = -0.02;

const FRONT_LEG_X = 1.55;
const FRONT_LEG_Z = 0.25;
const BACK_LEG_Z = -1.5;

const HUB_Z = -0.2;
const HUB_Y_OFFSET = 0.12;

const LEG_RADIUS = 0.065;
const FOOT_RADIUS = 0.1;
const FOOT_HEIGHT = 0.05;
const HUB_RADIUS = 0.15;

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 900;

function getCylinderTransform(
  start: THREE.Vector3,
  end: THREE.Vector3,
) {
  const direction =
    new THREE.Vector3().subVectors(
      end,
      start,
    );

  const length = direction.length();

  const midpoint =
    new THREE.Vector3()
      .addVectors(start, end)
      .multiplyScalar(0.5);

  const quaternion =
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    );

  return {
    length,
    midpoint,
    quaternion,
  };
}

function StandLeg({
  start,
  end,
}: {
  start: [number, number, number];
  end: [number, number, number];
}) {
  const transform = getCylinderTransform(
    new THREE.Vector3(...start),
    new THREE.Vector3(...end),
  );

  return (
    <group>
      <mesh
        castShadow
        position={transform.midpoint}
        quaternion={transform.quaternion}
      >
        <cylinderGeometry
          args={[
            LEG_RADIUS,
            LEG_RADIUS,
            transform.length,
            16,
          ]}
        />

        <meshStandardMaterial
          color="#4b5563"
          roughness={0.4}
          metalness={0.55}
        />
      </mesh>

      <mesh
        castShadow
        receiveShadow
        position={[
          end[0],
          end[1] + FOOT_HEIGHT / 2,
          end[2],
        ]}
      >
        <cylinderGeometry
          args={[
            FOOT_RADIUS,
            FOOT_RADIUS,
            FOOT_HEIGHT,
            16,
          ]}
        />

        <meshStandardMaterial
          color="#4b5563"
          roughness={0.4}
          metalness={0.55}
        />
      </mesh>
    </group>
  );
}

function StandBrace({
  start,
  end,
}: {
  start: [number, number, number];
  end: [number, number, number];
}) {
  const transform = getCylinderTransform(
    new THREE.Vector3(...start),
    new THREE.Vector3(...end),
  );

  return (
    <mesh
      castShadow
      position={transform.midpoint}
      quaternion={transform.quaternion}
    >
      <cylinderGeometry
        args={[
          0.04,
          0.04,
          transform.length,
          12,
        ]}
      />

      <meshStandardMaterial
        color="#4b5563"
        roughness={0.4}
        metalness={0.55}
      />
    </mesh>
  );
}

function interpolatePoint(
  start: [number, number, number],
  end: [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    start[0] +
    (end[0] - start[0]) * amount,

    start[1] +
    (end[1] - start[1]) * amount,

    start[2] +
    (end[2] - start[2]) * amount,
  ];
}

export default function PresentationBoard({
  position,
  frameHeight,
  cameraMode,
  tool,
  penColor,
  lineWidth,
  clearSignal,
  boardId,
  savedDrawing,
  generatedText,
  generatedTextVersion,
  onDrawingChange,
}: PresentationBoardProps) {
  const isDrawingRef = useRef(false);

  const previousPointRef =
    useRef<Point | null>(null);

  const previousClearSignalRef =
    useRef(clearSignal);

  const loadingDrawingRef =
    useRef(false);

  const activeBoardIdRef =
    useRef(boardId);

  const handwritingTimerRef =
    useRef<number | null>(null);

  const handwritingRunRef =
    useRef(0);

  /*
   * Stores the last Gemini response version that
   * has already been written for each board.
   *
   * Example:
   * {
   *   1: 4,
   *   2: 7
   * }
   */
  const completedHandwritingRef =
    useRef<Record<number, number>>({});

  const drawingCanvas = useMemo(() => {
    if (typeof document === "undefined") {
      return null;
    }

    const canvas =
      document.createElement("canvas");

    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    return canvas;
  }, []);

  const context = useMemo(() => {
    return (
      drawingCanvas?.getContext("2d") ??
      null
    );
  }, [drawingCanvas]);

  const texture = useMemo(() => {
    if (!drawingCanvas) {
      return null;
    }

    const canvasTexture =
      new THREE.CanvasTexture(
        drawingCanvas,
      );

    canvasTexture.colorSpace =
      THREE.SRGBColorSpace;

    canvasTexture.minFilter =
      THREE.LinearFilter;

    canvasTexture.magFilter =
      THREE.LinearFilter;

    canvasTexture.generateMipmaps =
      false;

    canvasTexture.needsUpdate =
      true;

    return canvasTexture;
  }, [drawingCanvas]);

  const refreshTexture =
    useCallback(() => {
      if (texture) {
        texture.needsUpdate = true;
      }
    }, [texture]);

  const fillBoardWhite =
    useCallback(() => {
      if (
        !drawingCanvas ||
        !context
      ) {
        return;
      }

      context.save();

      context.globalCompositeOperation =
        "source-over";

      context.fillStyle = "#fffef9";

      context.fillRect(
        0,
        0,
        drawingCanvas.width,
        drawingCanvas.height,
      );

      context.restore();

      refreshTexture();
    }, [
      drawingCanvas,
      context,
      refreshTexture,
    ]);

  const saveCurrentBoard =
    useCallback(() => {
      if (
        !drawingCanvas ||
        loadingDrawingRef.current
      ) {
        return;
      }

      const drawing =
        drawingCanvas.toDataURL(
          "image/png",
        );

      onDrawingChange(
        activeBoardIdRef.current,
        drawing,
      );
    }, [
      drawingCanvas,
      onDrawingChange,
    ]);

  /*
   * Initialize the white canvas.
   */
  useEffect(() => {
    fillBoardWhite();

    return () => {
      if (
        handwritingTimerRef.current !== null
      ) {
        window.clearTimeout(
          handwritingTimerRef.current,
        );
      }

      texture?.dispose();

      document.body.style.cursor =
        "default";
    };
  }, [
    fillBoardWhite,
    texture,
  ]);

  /*
   * Load the saved drawing when switching boards.
   */
  useEffect(() => {
    activeBoardIdRef.current = boardId;

    if (
      !drawingCanvas ||
      !context
    ) {
      return;
    }

    /*
     * Stop any handwriting animation when
     * changing boards.
     */
    handwritingRunRef.current += 1;

    if (
      handwritingTimerRef.current !== null
    ) {
      window.clearTimeout(
        handwritingTimerRef.current,
      );

      handwritingTimerRef.current =
        null;
    }

    loadingDrawingRef.current = true;

    context.save();

    context.globalCompositeOperation =
      "source-over";

    context.fillStyle = "#fffef9";

    context.fillRect(
      0,
      0,
      drawingCanvas.width,
      drawingCanvas.height,
    );

    context.restore();

    if (!savedDrawing) {
      loadingDrawingRef.current = false;
      refreshTexture();
      return;
    }

    const image = new Image();

    image.onload = () => {
      if (
        !drawingCanvas ||
        !context
      ) {
        loadingDrawingRef.current =
          false;

        return;
      }

      context.save();

      context.globalCompositeOperation =
        "source-over";

      context.fillStyle = "#fffef9";

      context.fillRect(
        0,
        0,
        drawingCanvas.width,
        drawingCanvas.height,
      );

      context.drawImage(
        image,
        0,
        0,
        drawingCanvas.width,
        drawingCanvas.height,
      );

      context.restore();

      loadingDrawingRef.current = false;

      refreshTexture();
    };

    image.onerror = () => {
      loadingDrawingRef.current = false;

      fillBoardWhite();
    };

    image.src = savedDrawing;
  }, [
    boardId,
    savedDrawing,
    drawingCanvas,
    context,
    fillBoardWhite,
    refreshTexture,
  ]);

  /*
   * Clear only the active board.
   */
  useEffect(() => {
    if (
      previousClearSignalRef.current ===
      clearSignal
    ) {
      return;
    }

    previousClearSignalRef.current =
      clearSignal;

    handwritingRunRef.current += 1;

    if (
      handwritingTimerRef.current !== null
    ) {
      window.clearTimeout(
        handwritingTimerRef.current,
      );

      handwritingTimerRef.current = null;
    }

    delete completedHandwritingRef.current[
      boardId
    ];

    fillBoardWhite();

    requestAnimationFrame(() => {
      saveCurrentBoard();
    });
  }, [
    clearSignal,
    boardId,
    fillBoardWhite,
    saveCurrentBoard,
  ]);

  /*
   * Disable drawing while camera mode is active.
   */
  useEffect(() => {
    if (!cameraMode) {
      return;
    }

    isDrawingRef.current = false;
    previousPointRef.current = null;

    document.body.style.cursor =
      "default";
  }, [cameraMode]);

  /*
   * Stop drawing even if the cursor leaves
   * the board.
   */
  useEffect(() => {
    function stopDrawingGlobally() {
      if (!isDrawingRef.current) {
        return;
      }

      isDrawingRef.current = false;
      previousPointRef.current = null;

      saveCurrentBoard();
    }

    window.addEventListener(
      "pointerup",
      stopDrawingGlobally,
    );

    window.addEventListener(
      "pointercancel",
      stopDrawingGlobally,
    );

    return () => {
      window.removeEventListener(
        "pointerup",
        stopDrawingGlobally,
      );

      window.removeEventListener(
        "pointercancel",
        stopDrawingGlobally,
      );
    };
  }, [saveCurrentBoard]);

  /*
   * Gemini handwriting animation.
   *
   * This effect runs only once for each combination
   * of boardId + generatedTextVersion.
   */
  useEffect(() => {
    const alreadyCompletedVersion =
      completedHandwritingRef.current[
      boardId
      ];

    if (
      !generatedText.trim() ||
      generatedTextVersion === 0 ||
      !drawingCanvas ||
      !context ||
      alreadyCompletedVersion ===
      generatedTextVersion
    ) {
      return;
    }

    /*
     * Mark this response as started immediately.
     *
     * This prevents saving the board image from
     * causing the effect to restart.
     */
    completedHandwritingRef.current[
      boardId
    ] = generatedTextVersion;

    handwritingRunRef.current += 1;

    const currentRun =
      handwritingRunRef.current;

    if (
      handwritingTimerRef.current !== null
    ) {
      window.clearTimeout(
        handwritingTimerRef.current,
      );

      handwritingTimerRef.current =
        null;
    }

    let cancelled = false;

    async function startHandwriting() {
      /*
       * Wait for the handwriting font.
       * The browser uses cursive when it is missing.
       */
      try {
        await document.fonts.load(
          '52px "Lixia Handwriting"',
        );
      } catch {
        // Use the fallback cursive font.
      }

      if (
        cancelled ||
        currentRun !==
        handwritingRunRef.current ||
        !drawingCanvas ||
        !context
      ) {
        return;
      }

      const marginX = 95;
      const marginTop = 75;

      const maxTextWidth =
        drawingCanvas.width -
        marginX * 2;

      const titleSize = 66;
      const bodySize = 46;

      const titleLineHeight = 84;
      const bodyLineHeight = 60;

      const sourceLines =
        generatedText
          .replace(/\r/g, "")
          .split("\n");

      const instructions:
        CharacterInstruction[] = [];

      let currentY = marginTop;
      let visibleLineIndex = 0;

      function addWrappedLine(
        sourceLine: string,
        isTitle: boolean,
      ) {
        if (
          !context ||
          !drawingCanvas
        ) {
          return;
        }

        const fontSize = isTitle
          ? titleSize
          : bodySize;

        const lineHeight = isTitle
          ? titleLineHeight
          : bodyLineHeight;

        const fontWeight = isTitle
          ? "600"
          : "400";

        const font =
          `${fontWeight} ${fontSize}px ` +
          `"Lixia Handwriting", cursive`;

        context.font = font;

        const cleanLine = sourceLine
          .replace(/^[-*]\s*/, "• ")
          .trim();

        if (!cleanLine) {
          currentY +=
            lineHeight * 0.55;

          return;
        }

        const words =
          cleanLine.split(/\s+/);

        let currentX = marginX;

        for (const word of words) {
          const wordWithSpace =
            `${word} `;

          const wordWidth =
            context.measureText(
              wordWithSpace,
            ).width;

          if (
            currentX > marginX &&
            currentX + wordWidth >
            marginX + maxTextWidth
          ) {
            currentX = marginX;
            currentY += lineHeight;
          }

          for (
            const character of wordWithSpace
          ) {
            const characterWidth =
              context.measureText(
                character,
              ).width;

            if (
              currentX > marginX &&
              currentX +
              characterWidth >
              marginX +
              maxTextWidth
            ) {
              currentX = marginX;
              currentY += lineHeight;
            }

            if (
              currentY + lineHeight >
              drawingCanvas.height -
              55
            ) {
              return;
            }

            const yJitter =
              (Math.random() - 0.5) *
              2.2;

            const rotation =
              (Math.random() - 0.5) *
              0.018;

            instructions.push({
              character,
              x: currentX,
              y:
                currentY +
                yJitter,
              font,
              color: isTitle
                ? "#312e81"
                : "#172033",
              rotation,
              delay:
                character === " "
                  ? 13
                  : 28 +
                  Math.random() *
                  22,
            });

            currentX +=
              characterWidth +
              (Math.random() - 0.5) *
              0.7;
          }
        }

        currentY += lineHeight;
      }

      for (
        const sourceLine of sourceLines
      ) {
        const hasContent =
          sourceLine.trim().length > 0;

        const isTitle =
          hasContent &&
          visibleLineIndex === 0;

        addWrappedLine(
          sourceLine,
          isTitle,
        );

        if (hasContent) {
          visibleLineIndex += 1;
        }

        if (
          currentY >=
          drawingCanvas.height - 70
        ) {
          break;
        }
      }

      let instructionIndex = 0;

      function drawNextCharacter() {
        if (
          cancelled ||
          currentRun !==
          handwritingRunRef.current ||
          !context ||
          !drawingCanvas
        ) {
          return;
        }

        const instruction =
          instructions[
          instructionIndex
          ];

        if (!instruction) {
          refreshTexture();

          const finishedDrawing =
            drawingCanvas.toDataURL(
              "image/png",
            );

          onDrawingChange(
            boardId,
            finishedDrawing,
          );

          handwritingTimerRef.current =
            null;

          return;
        }

        context.save();

        context.globalCompositeOperation =
          "source-over";

        context.font =
          instruction.font;

        context.fillStyle =
          instruction.color;

        context.textBaseline = "top";

        context.translate(
          instruction.x,
          instruction.y,
        );

        context.rotate(
          instruction.rotation,
        );

        context.fillText(
          instruction.character,
          0,
          0,
        );

        context.restore();

        refreshTexture();

        instructionIndex += 1;

        handwritingTimerRef.current =
          window.setTimeout(
            drawNextCharacter,
            instruction.delay,
          );
      }

      drawNextCharacter();
    }

    void startHandwriting();

    return () => {
      cancelled = true;

      if (
        handwritingTimerRef.current !==
        null
      ) {
        window.clearTimeout(
          handwritingTimerRef.current,
        );

        handwritingTimerRef.current =
          null;
      }
    };
  }, [
    generatedText,
    generatedTextVersion,
    boardId,
    drawingCanvas,
    context,
    refreshTexture,
    onDrawingChange,
  ]);

  function getPoint(
    event: ThreeEvent<PointerEvent>,
  ): Point | null {
    if (
      !event.uv ||
      !drawingCanvas
    ) {
      return null;
    }

    return {
      x:
        event.uv.x *
        drawingCanvas.width,

      y:
        (1 - event.uv.y) *
        drawingCanvas.height,
    };
  }

  function startDrawing(
    event: ThreeEvent<PointerEvent>,
  ) {
    if (
      cameraMode ||
      event.button !== 0 ||
      !context
    ) {
      return;
    }

    event.stopPropagation();

    const point = getPoint(event);

    if (!point) {
      return;
    }

    isDrawingRef.current = true;

    previousPointRef.current =
      point;

    context.save();

    context.globalCompositeOperation =
      "source-over";

    context.fillStyle =
      tool === "eraser"
        ? "#fffef9"
        : penColor;

    context.beginPath();

    context.arc(
      point.x,
      point.y,
      tool === "eraser"
        ? Math.max(
          lineWidth * 2,
          20,
        )
        : Math.max(
          lineWidth / 2,
          4,
        ),
      0,
      Math.PI * 2,
    );

    context.fill();
    context.restore();

    refreshTexture();
  }

  function continueDrawing(
    event: ThreeEvent<PointerEvent>,
  ) {
    if (
      cameraMode ||
      !isDrawingRef.current ||
      !previousPointRef.current ||
      !context
    ) {
      return;
    }

    event.stopPropagation();

    const point = getPoint(event);

    if (!point) {
      return;
    }

    context.save();

    context.globalCompositeOperation =
      "source-over";

    context.strokeStyle =
      tool === "eraser"
        ? "#fffef9"
        : penColor;

    context.lineWidth =
      tool === "eraser"
        ? Math.max(
          lineWidth * 4,
          40,
        )
        : Math.max(
          lineWidth,
          8,
        );

    context.lineCap = "round";
    context.lineJoin = "round";

    context.beginPath();

    context.moveTo(
      previousPointRef.current.x,
      previousPointRef.current.y,
    );

    context.lineTo(
      point.x,
      point.y,
    );

    context.stroke();
    context.restore();

    previousPointRef.current =
      point;

    refreshTexture();
  }

  function stopDrawing(
    event: ThreeEvent<PointerEvent>,
  ) {
    if (!cameraMode) {
      event.stopPropagation();
    }

    if (!isDrawingRef.current) {
      return;
    }

    isDrawingRef.current = false;
    previousPointRef.current = null;

    saveCurrentBoard();
  }

  const frameHalfHeight =
    frameHeight / 2;

  const innerHeight =
    frameHeight - INNER_MARGIN;

  const localFloorY =
    FLOOR_Y - position[1];

  const hub: [
    number,
    number,
    number,
  ] = [
      0,
      -frameHalfHeight +
      HUB_Y_OFFSET,
      HUB_Z,
    ];

  const leftFoot: [
    number,
    number,
    number,
  ] = [
      -FRONT_LEG_X,
      localFloorY,
      FRONT_LEG_Z,
    ];

  const rightFoot: [
    number,
    number,
    number,
  ] = [
      FRONT_LEG_X,
      localFloorY,
      FRONT_LEG_Z,
    ];

  const backFoot: [
    number,
    number,
    number,
  ] = [
      0,
      localFloorY,
      BACK_LEG_Z,
    ];

  const leftBracePoint =
    interpolatePoint(
      hub,
      leftFoot,
      0.58,
    );

  const rightBracePoint =
    interpolatePoint(
      hub,
      rightFoot,
      0.58,
    );

  return (
    <group position={position}>
      {/* Outer board frame */}
      <mesh
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[
            FRAME_WIDTH,
            frameHeight,
            FRAME_DEPTH,
          ]}
        />

        <meshStandardMaterial
          color="#202532"
          roughness={0.55}
          metalness={0.15}
        />
      </mesh>

      {/* Drawable whiteboard surface */}
      {texture && (
        <mesh
          position={[0, 0, 0.12]}
          renderOrder={10}
          onPointerDown={
            startDrawing
          }
          onPointerMove={
            continueDrawing
          }
          onPointerUp={
            stopDrawing
          }
          onPointerCancel={
            stopDrawing
          }
          onPointerOver={(
            event,
          ) => {
            event.stopPropagation();

            if (!cameraMode) {
              document.body.style.cursor =
                "crosshair";
            }
          }}
          onPointerOut={() => {
            if (
              !isDrawingRef.current
            ) {
              document.body.style.cursor =
                "default";
            }
          }}
        >
          <planeGeometry
            args={[
              FRAME_WIDTH -
              INNER_MARGIN,
              innerHeight,
            ]}
          />

          <meshBasicMaterial
            map={texture}
            toneMapped={false}
            side={
              THREE.DoubleSide
            }
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Marker tray */}
      <mesh
        castShadow
        receiveShadow
        position={[
          0,
          -frameHalfHeight -
          0.03,
          0.18,
        ]}
      >
        <boxGeometry
          args={[
            FRAME_WIDTH - 0.25,
            0.14,
            0.45,
          ]}
        />

        <meshStandardMaterial
          color="#3b4252"
          roughness={0.5}
          metalness={0.25}
        />
      </mesh>

      {/* Tripod hub */}
      <mesh
        castShadow
        position={hub}
      >
        <sphereGeometry
          args={[
            HUB_RADIUS,
            16,
            16,
          ]}
        />

        <meshStandardMaterial
          color="#374151"
          roughness={0.45}
          metalness={0.5}
        />
      </mesh>

      <StandLeg
        start={hub}
        end={leftFoot}
      />

      <StandLeg
        start={hub}
        end={rightFoot}
      />

      <StandLeg
        start={hub}
        end={backFoot}
      />

      <StandBrace
        start={leftBracePoint}
        end={rightBracePoint}
      />
    </group>
  );
}