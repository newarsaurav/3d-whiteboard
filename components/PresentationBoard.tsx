"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import type {
  BoardChartCommand,
  BoardCommand,
  BoardFlowchartCommand,
  BoardImageCommand,
  BoardTextCommand,
  BoardTextFormatting,
  FontFamily,
} from "@/types/board";

import {
  AVAILABLE_FONTS,
  DEFAULT_FONT,
} from "@/types/board";

export type DrawingTool = "pen" | "eraser";
export type TextSize = "small" | "medium" | "large";

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

  generatedCommand: BoardCommand | null;
  generatedCommandVersion: number;
  textSize: TextSize;

  // 10 = slow, 100 = fast.
  writingSpeed: number;
  drawingSpeed: number;
  animationPaused?: boolean;

  onDrawingChange: (
    boardId: number,
    drawing: string,
  ) => void;

  onCommandRenderComplete?: (
    boardId: number,
    version: number,
  ) => void;

}

type Point = {
  x: number;
  y: number;
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


type RenderPoint = {
  x: number;
  y: number;
};

type RenderNode = {
  id: string;
  label: string;
  row: number;
  column: number;
  shape: "rounded" | "diamond" | "circle";
  center: RenderPoint;
  width: number;
  height: number;
};

const BOARD_BACKGROUND = "#fffef9";
const BOARD_INK = "#172033";
const BOARD_MUTED = "#5b6474";
const CHART_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#7c3aed",
];

function clampNumber(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value));
}

function getWrappedLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let currentLine = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const candidate = `${currentLine} ${words[index]}`;

    if (context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
    } else {
      lines.push(currentLine);
      currentLine = words[index];
    }
  }

  lines.push(currentLine);
  return lines;
}

function drawCenteredWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 3,
) {
  const lines = getWrappedLines(
    context,
    text,
    maxWidth,
  ).slice(0, maxLines);

  const totalHeight =
    Math.max(0, lines.length - 1) * lineHeight;

  context.textAlign = "center";
  context.textBaseline = "middle";

  lines.forEach((line, index) => {
    context.fillText(
      line,
      centerX,
      centerY - totalHeight / 2 + index * lineHeight,
    );
  });
}

function getFontString(
  font: FontFamily | undefined,
  weight: "400" | "600",
  sizeInPx: number,
): string {
  const fontFamily = font || DEFAULT_FONT;
  const fontStack = AVAILABLE_FONTS[fontFamily];
  return `${weight} ${sizeInPx}px ${fontStack}`;
}

type StyledTextToken = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
};

function parseStyledText(
  text: string,
  formatting: BoardTextFormatting | undefined,
): StyledTextToken[] {
  const tokens: StyledTextToken[] = [];
  const markerPattern = /(\*\*|__|\*|_|\[color=#[0-9a-fA-F]{6}\]|\[\/color\])/g;
  let bold = formatting?.bold ?? false;
  let italic = formatting?.italic ?? false;
  let underline = formatting?.underline ?? false;
  let color = formatting?.textColor;
  let cursor = 0;

  for (const match of text.matchAll(markerPattern)) {
    const marker = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ text: text.slice(cursor, index), bold, italic, underline, color });
    }
    if (marker === "**") bold = !bold;
    else if (marker === "__") underline = !underline;
    else if (marker === "*") italic = !italic;
    else if (marker === "_") underline = !underline;
    else if (marker === "[/color]") color = formatting?.textColor;
    else color = marker.slice(7, -1);
    cursor = index + marker.length;
  }

  if (cursor < text.length) {
    tokens.push({ text: text.slice(cursor), bold, italic, underline, color });
  }
  return tokens.length > 0 ? tokens : [{ text: "", bold, italic, underline, color }];
}

function drawStyledWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  sizeInPx: number,
  weight: "400" | "600",
  font: FontFamily | undefined,
  formatting: BoardTextFormatting | undefined,
  maxLines: number,
): number {
  const tokens = parseStyledText(text, formatting);
  const lines: StyledTextToken[][] = [[]];
  let lineWidth = 0;

  const tokenFont = (token: StyledTextToken) =>
    `${token.italic ? "italic " : ""}${token.bold ? "600" : weight} ${sizeInPx}px ${AVAILABLE_FONTS[font || DEFAULT_FONT]}`;

  for (const token of tokens) {
    for (const part of token.text.split(/(\s+)/).filter(Boolean)) {
      context.font = tokenFont(token);
      const partWidth = context.measureText(part).width;
      if (lineWidth > 0 && lineWidth + partWidth > maxWidth && !/^\s+$/.test(part)) {
        lines.push([]);
        lineWidth = 0;
      }
      lines[lines.length - 1].push({ ...token, text: part });
      lineWidth += partWidth;
    }
  }

  const visibleLines = lines.slice(0, maxLines);
  context.textAlign = "left";
  context.textBaseline = "top";
  visibleLines.forEach((line, lineIndex) => {
    let offsetX = x;
    for (const token of line) {
      context.font = tokenFont(token);
      context.fillStyle = token.color || formatting?.textColor || BOARD_INK;
      context.fillText(token.text, offsetX, y + lineIndex * lineHeight);
      const width = context.measureText(token.text).width;
      if (token.underline && token.text.trim()) {
        context.fillRect(offsetX, y + lineIndex * lineHeight + sizeInPx + 3, width, 2);
      }
      offsetX += width;
    }
  });
  return visibleLines.length;
}

function renderTextCommand(
  context: CanvasRenderingContext2D,
  command: BoardTextCommand,
  textSize: TextSize,
) {
  const marginX = 95;
  const sizeScale = {
    small: 0.8,
    medium: 1,
    large: 1.2,
  }[textSize];

  const formatting = command.formatting;
  context.fillStyle = formatting?.titleColor || "#312e81";
  context.font = getFontString(command.font, "600", 64 * sizeScale);
  context.textAlign = "left";
  context.textBaseline = "top";

  const titleLines = getWrappedLines(
    context,
    command.title,
    CANVAS_WIDTH - marginX * 2,
  ).slice(0, 2);

  titleLines.forEach((line, index) => {
    drawStyledWrappedText(
      context, line, marginX, 62 + index * 72 * sizeScale,
      CANVAS_WIDTH - marginX * 2, 72 * sizeScale, 64 * sizeScale,
      "600", command.font, { ...formatting, textColor: formatting?.titleColor }, 1,
    );
  });

  let currentY =
    62 + Math.max(1, titleLines.length) * 78 * sizeScale + 24;

  context.fillStyle = formatting?.textColor || BOARD_INK;
  context.font = getFontString(
    command.font,
    "400",
    42 * sizeScale,
  );

  for (const bullet of command.bullets.slice(0, 8)) {
    const lines = getWrappedLines(context, bullet.replace(/\*\*|__|\*|_|\[color=#[0-9a-fA-F]{6}\]|\[\/color\]/g, ""), CANVAS_WIDTH - 250);

    if (currentY + lines.length * 54 * sizeScale > 760) {
      break;
    }

    context.beginPath();
    context.arc(
      marginX + 12,
      currentY + 24,
      6,
      0,
      Math.PI * 2,
    );
    context.fill();

    drawStyledWrappedText(
      context, bullet, marginX + 42, currentY, CANVAS_WIDTH - 250,
      54 * sizeScale, 42 * sizeScale, "400", command.font, formatting, lines.length,
    );

    currentY += Math.max(1, lines.length) * 54 * sizeScale + 18;
  }

  if (command.formulas && command.formulas.length > 0 && currentY < 730) {
    context.save();

    context.fillStyle = "#4338ca";
    context.font = getFontString(
      command.font,
      "600",
      30 * sizeScale,
    );
    context.fillText("Formula", marginX, currentY + 2);

    currentY += 48 * sizeScale;

    for (const formula of command.formulas.slice(0, 4)) {
      if (currentY + 78 * sizeScale > 770) {
        break;
      }

      context.fillStyle = "#eef2ff";
      context.strokeStyle = "#818cf8";
      context.lineWidth = 3;

      context.beginPath();
      context.roundRect(
        marginX,
        currentY,
        Math.min(
          CANVAS_WIDTH - marginX * 2,
          980,
        ),
        68 * sizeScale,
        16 * sizeScale,
      );
      context.fill();
      context.stroke();

      context.fillStyle = "#1e1b4b";
      context.font = getFontString(
        command.font,
        "600",
        46 * sizeScale,
      );
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(
        formula,
        marginX + 28,
        currentY + 34 * sizeScale,
      );

      currentY += 82 * sizeScale;
    }

    context.restore();

    context.textAlign = "left";
    context.textBaseline = "top";
  }

  if (command.note && currentY < 785) {
    context.save();
    context.fillStyle = "#eef2ff";
    context.strokeStyle = "#818cf8";
    context.lineWidth = 3;

    context.beginPath();
    context.roundRect(
      marginX,
      Math.min(currentY + 6, 760),
      CANVAS_WIDTH - marginX * 2,
      92 * sizeScale,
      18 * sizeScale,
    );
    context.fill();
    context.stroke();

    context.fillStyle = formatting?.textColor || "#3730a3";
    context.font = getFontString(
      command.font,
      "600",
      32 * sizeScale,
    );
    context.textBaseline = "middle";

    const noteLines = getWrappedLines(
      context,
      command.note,
      CANVAS_WIDTH - marginX * 2 - 56,
    ).slice(0, 2);

    noteLines.forEach((line, index) => {
      context.fillText(
        line,
        marginX + 28,
        Math.min(currentY + 52, 806) +
          (index - (noteLines.length - 1) / 2) * 34 * sizeScale,
      );
    });

    context.restore();
  }
}

function nodeBoundaryPoint(
  from: RenderNode,
  toward: RenderNode,
): RenderPoint {
  const dx = toward.center.x - from.center.x;
  const dy = toward.center.y - from.center.y;

  if (dx === 0 && dy === 0) {
    return { ...from.center };
  }

  const halfWidth = from.width / 2;
  const halfHeight = from.height / 2;

  const scale = 1 / Math.max(
    Math.abs(dx) / Math.max(halfWidth, 1),
    Math.abs(dy) / Math.max(halfHeight, 1),
  );

  return {
    x: from.center.x + dx * scale,
    y: from.center.y + dy * scale,
  };
}

function drawArrow(
  context: CanvasRenderingContext2D,
  start: RenderPoint,
  end: RenderPoint,
  label?: string,
) {
  const angle = Math.atan2(
    end.y - start.y,
    end.x - start.x,
  );

  context.save();
  context.strokeStyle = "#475569";
  context.fillStyle = "#475569";
  context.lineWidth = 4;
  context.lineCap = "round";

  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();

  const arrowSize = 18;

  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - arrowSize * Math.cos(angle - Math.PI / 6),
    end.y - arrowSize * Math.sin(angle - Math.PI / 6),
  );
  context.lineTo(
    end.x - arrowSize * Math.cos(angle + Math.PI / 6),
    end.y - arrowSize * Math.sin(angle + Math.PI / 6),
  );
  context.closePath();
  context.fill();

  if (label) {
    const middleX = (start.x + end.x) / 2;
    const middleY = (start.y + end.y) / 2;

    context.font = '600 25px "Segoe UI", sans-serif';
    const width = context.measureText(label).width + 22;

    context.fillStyle = BOARD_BACKGROUND;
    context.fillRect(
      middleX - width / 2,
      middleY - 18,
      width,
      36,
    );

    context.fillStyle = "#334155";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, middleX, middleY);
  }

  context.restore();
}

function splitFlowchartWord(
  context: CanvasRenderingContext2D,
  word: string,
  maxWidth: number,
): string[] {
  if (context.measureText(word).width <= maxWidth) {
    return [word];
  }

  const pieces: string[] = [];
  let current = "";

  for (const character of Array.from(word)) {
    const candidate = current + character;

    if (
      current &&
      context.measureText(candidate).width > maxWidth
    ) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}

function getFlowchartLabelLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const rawWords = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const words = rawWords.flatMap((word) =>
    splitFlowchartWord(context, word, maxWidth),
  );

  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let current = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const candidate = current + " " + words[index];

    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[index];
    }
  }

  lines.push(current);
  return lines;
}

function drawFlowchartNode(
  context: CanvasRenderingContext2D,
  node: RenderNode,
) {
  const left = node.center.x - node.width / 2;
  const top = node.center.y - node.height / 2;

  context.save();
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#334155";
  context.lineWidth = 4;

  if (node.shape === "diamond") {
    context.beginPath();
    context.moveTo(node.center.x, top);
    context.lineTo(left + node.width, node.center.y);
    context.lineTo(node.center.x, top + node.height);
    context.lineTo(left, node.center.y);
    context.closePath();
    context.fill();
    context.stroke();
  } else if (node.shape === "circle") {
    context.beginPath();
    context.ellipse(
      node.center.x,
      node.center.y,
      node.width / 2,
      node.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.stroke();
  } else {
    context.beginPath();
    context.roundRect(
      left,
      top,
      node.width,
      node.height,
      22,
    );
    context.fill();
    context.stroke();
  }

  /*
   * Text must fit inside the usable interior of the shape, not merely
   * inside its outer bounding box. Diamonds and circles have much less
   * usable width near their edges, so give them a narrower text area.
   */
  const usableWidth =
    node.shape === "diamond"
      ? node.width * 0.52
      : node.shape === "circle"
        ? node.width * 0.7
        : node.width - 42;

  const usableHeight =
    node.shape === "diamond"
      ? node.height * 0.58
      : node.shape === "circle"
        ? node.height * 0.68
        : node.height - 28;

  const maxLines = node.shape === "diamond" ? 3 : 4;

  let fontSize = 30;
  let lineHeight = 34;
  let lines: string[] = [];

  while (fontSize >= 17) {
    context.font =
      `600 ${fontSize}px "Lixia Handwriting", "Segoe UI", sans-serif`;

    lineHeight = Math.round(fontSize * 1.12);
    lines = getFlowchartLabelLines(
      context,
      node.label,
      usableWidth,
    );

    const requiredHeight =
      Math.max(1, lines.length) * lineHeight;

    if (
      lines.length <= maxLines &&
      requiredHeight <= usableHeight
    ) {
      break;
    }

    fontSize -= 2;
  }

  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);

    const lastIndex = lines.length - 1;
    let lastLine = lines[lastIndex];

    while (
      lastLine.length > 1 &&
      context.measureText(lastLine + "…").width > usableWidth
    ) {
      lastLine = lastLine.slice(0, -1);
    }

    lines[lastIndex] = lastLine.trimEnd() + "…";
  }

  const totalHeight =
    Math.max(0, lines.length - 1) * lineHeight;

  context.fillStyle = BOARD_INK;
  context.textAlign = "center";
  context.textBaseline = "middle";

  lines.forEach((line, index) => {
    context.fillText(
      line,
      node.center.x,
      node.center.y - totalHeight / 2 + index * lineHeight,
    );
  });

  context.restore();
}

function renderFlowchartCommand(
  context: CanvasRenderingContext2D,
  command: BoardFlowchartCommand,
) {
  context.fillStyle = "#312e81";
  context.font =
    '600 58px "Lixia Handwriting", "Comic Sans MS", cursive';
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillText(command.title, 90, 52);

  if (command.nodes.length === 0) {
    // During animation the title is written before the first node.
    // Keep the rest of the board clean instead of showing an error.
    return;
  }

  const minRow = Math.min(
    ...command.nodes.map((node) => node.row),
  );
  const maxRow = Math.max(
    ...command.nodes.map((node) => node.row),
  );
  const minColumn = Math.min(
    ...command.nodes.map((node) => node.column),
  );
  const maxColumn = Math.max(
    ...command.nodes.map((node) => node.column),
  );

  const rowCount = Math.max(1, maxRow - minRow + 1);
  const columnCount = Math.max(
    1,
    maxColumn - minColumn + 1,
  );

  const areaLeft = 80;
  const areaTop = 150;
  const areaWidth = CANVAS_WIDTH - 160;
  const areaHeight = 650;

  const cellWidth = areaWidth / columnCount;
  const cellHeight = areaHeight / rowCount;

  const nodeWidth = clampNumber(
    cellWidth * 0.7,
    180,
    300,
  );
  const nodeHeight = clampNumber(
    cellHeight * 0.56,
    82,
    126,
  );

  const renderNodes: RenderNode[] = command.nodes.map((node) => ({
    ...node,
    center: {
      x:
        areaLeft +
        cellWidth * (node.column - minColumn + 0.5),
      y:
        areaTop +
        cellHeight * (node.row - minRow + 0.5),
    },
    width:
      node.shape === "circle"
        ? Math.min(nodeWidth, 190)
        : nodeWidth,
    height:
      node.shape === "circle"
        ? Math.min(nodeHeight, 110)
        : nodeHeight,
  }));

  const nodeMap = new Map(
    renderNodes.map((node) => [node.id, node]),
  );

  for (const edge of command.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);

    if (!from || !to) {
      continue;
    }

    drawArrow(
      context,
      nodeBoundaryPoint(from, to),
      nodeBoundaryPoint(to, from),
      edge.label,
    );
  }

  renderNodes.forEach((node) => {
    drawFlowchartNode(context, node);
  });
}

function formatChartValue(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1000) {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  if (absolute >= 100) {
    return value.toFixed(0);
  }

  return value.toFixed(1).replace(/\.0$/, "");
}

function renderCartesianChart(
  context: CanvasRenderingContext2D,
  command: BoardChartCommand,
) {
  const chartLeft = 135;
  const chartTop = 210;
  const chartWidth = 1325;
  const chartHeight = 500;

  const values: number[] = [];

  for (const row of command.data) {
    for (const series of command.series) {
      const value = row[series.key];

      if (typeof value === "number" && Number.isFinite(value)) {
        values.push(value);
      }
    }
  }

  if (values.length === 0) {
    context.fillStyle = BOARD_INK;
    context.font = '36px "Segoe UI", sans-serif';
    context.fillText("No numeric chart data was returned.", 100, 220);
    return;
  }

  let minimum = Math.min(...values);
  let maximum = Math.max(...values);

  if (command.chartType === "bar" && minimum >= 0) {
    minimum = 0;
  } else {
    const padding = Math.max((maximum - minimum) * 0.12, 1);
    minimum -= padding;
    maximum += padding;
  }

  if (maximum === minimum) {
    maximum += 1;
    minimum -= 1;
  }

  const yTicks = 5;

  context.save();
  context.font = '24px "Segoe UI", sans-serif';
  context.textBaseline = "middle";

  for (let index = 0; index <= yTicks; index += 1) {
    const ratio = index / yTicks;
    const y = chartTop + chartHeight - ratio * chartHeight;
    const value = minimum + ratio * (maximum - minimum);

    context.strokeStyle = "#dbe2ea";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(chartLeft, y);
    context.lineTo(chartLeft + chartWidth, y);
    context.stroke();

    context.fillStyle = BOARD_MUTED;
    context.textAlign = "right";
    context.fillText(
      formatChartValue(value),
      chartLeft - 18,
      y,
    );
  }

  context.strokeStyle = "#64748b";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(chartLeft, chartTop);
  context.lineTo(chartLeft, chartTop + chartHeight);
  context.lineTo(chartLeft + chartWidth, chartTop + chartHeight);
  context.stroke();

  const dataCount = Math.max(1, command.data.length);
  const stepX = chartWidth / dataCount;
  const labelEvery = Math.max(1, Math.ceil(dataCount / 12));

  command.data.forEach((row, index) => {
    if (index % labelEvery !== 0 && index !== command.data.length - 1) {
      return;
    }

    const label = String(row.label ?? row.date ?? index + 1);
    const x = chartLeft + stepX * (index + 0.5);

    context.fillStyle = BOARD_MUTED;
    context.font = '22px "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(
      label,
      x,
      chartTop + chartHeight + 16,
    );
  });

  const valueToY = (value: number) =>
    chartTop +
    chartHeight -
    ((value - minimum) / (maximum - minimum)) * chartHeight;

  if (command.chartType === "bar") {
    const seriesCount = Math.max(1, command.series.length);
    const groupWidth = stepX * 0.72;
    const barWidth = Math.max(5, groupWidth / seriesCount - 5);
    const zeroY = valueToY(clampNumber(0, minimum, maximum));

    command.data.forEach((row, dataIndex) => {
      command.series.forEach((series, seriesIndex) => {
        const value = row[series.key];

        if (typeof value !== "number" || !Number.isFinite(value)) {
          return;
        }

        const x =
          chartLeft +
          stepX * dataIndex +
          (stepX - groupWidth) / 2 +
          seriesIndex * (groupWidth / seriesCount) +
          2;

        const valueY = valueToY(value);
        const top = Math.min(zeroY, valueY);
        const height = Math.max(2, Math.abs(zeroY - valueY));

        context.fillStyle =
          CHART_COLORS[seriesIndex % CHART_COLORS.length];

        context.beginPath();
        context.roundRect(
          x,
          top,
          barWidth,
          height,
          7,
        );
        context.fill();
      });
    });
  } else {
    command.series.forEach((series, seriesIndex) => {
      context.strokeStyle =
        CHART_COLORS[seriesIndex % CHART_COLORS.length];
      context.fillStyle =
        CHART_COLORS[seriesIndex % CHART_COLORS.length];
      context.lineWidth = 5;
      context.lineJoin = "round";
      context.lineCap = "round";

      let started = false;
      context.beginPath();

      command.data.forEach((row, dataIndex) => {
        const value = row[series.key];

        if (typeof value !== "number" || !Number.isFinite(value)) {
          return;
        }

        const x = chartLeft + stepX * (dataIndex + 0.5);
        const y = valueToY(value);

        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.lineTo(x, y);
        }
      });

      context.stroke();

      command.data.forEach((row, dataIndex) => {
        const value = row[series.key];

        if (typeof value !== "number" || !Number.isFinite(value)) {
          return;
        }

        const x = chartLeft + stepX * (dataIndex + 0.5);
        const y = valueToY(value);

        context.beginPath();
        context.arc(x, y, 6, 0, Math.PI * 2);
        context.fill();
      });
    });
  }

  context.font = '600 23px "Segoe UI", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";

  let legendX = chartLeft;
  const legendY = 170;

  command.series.forEach((series, index) => {
    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.fillRect(legendX, legendY - 7, 28, 14);

    context.fillStyle = BOARD_INK;
    const label = series.unit
      ? `${series.label} (${series.unit})`
      : series.label;

    context.fillText(label, legendX + 38, legendY);
    legendX += context.measureText(label).width + 85;
  });

  if (command.yAxisLabel) {
    context.save();
    context.translate(34, chartTop + chartHeight / 2);
    context.rotate(-Math.PI / 2);
    context.fillStyle = BOARD_MUTED;
    context.font = '600 23px "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.fillText(command.yAxisLabel, 0, 0);
    context.restore();
  }

  if (command.xAxisLabel) {
    context.fillStyle = BOARD_MUTED;
    context.font = '600 23px "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(
      command.xAxisLabel,
      chartLeft + chartWidth / 2,
      780,
    );
  }

  context.restore();
}

function renderPieChart(
  context: CanvasRenderingContext2D,
  command: BoardChartCommand,
) {
  const series = command.series[0];

  if (!series) {
    return;
  }

  const slices = command.data
    .map((row, index) => {
      const value = row[series.key];

      return {
        label: String(row.label ?? row.name ?? `Item ${index + 1}`),
        value:
          typeof value === "number" && Number.isFinite(value)
            ? Math.max(0, value)
            : 0,
      };
    })
    .filter((slice) => slice.value > 0)
    .slice(0, 8);

  const total = slices.reduce(
    (sum, slice) => sum + slice.value,
    0,
  );

  if (total <= 0) {
    context.fillStyle = BOARD_INK;
    context.font = '36px "Segoe UI", sans-serif';
    context.fillText("No positive pie-chart data was returned.", 100, 220);
    return;
  }

  const centerX = 520;
  const centerY = 470;
  const radius = 250;
  let startAngle = -Math.PI / 2;

  slices.forEach((slice, index) => {
    const angle = (slice.value / total) * Math.PI * 2;

    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.arc(
      centerX,
      centerY,
      radius,
      startAngle,
      startAngle + angle,
    );
    context.closePath();
    context.fill();

    startAngle += angle;
  });

  context.font = '600 28px "Segoe UI", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";

  slices.forEach((slice, index) => {
    const y = 280 + index * 62;
    const percentage = (slice.value / total) * 100;

    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.fillRect(900, y - 12, 30, 24);

    context.fillStyle = BOARD_INK;
    context.fillText(
      `${slice.label} — ${percentage.toFixed(1)}%`,
      948,
      y,
    );
  });
}

function renderChartCommand(
  context: CanvasRenderingContext2D,
  command: BoardChartCommand,
) {
  context.fillStyle = "#312e81";
  context.font = '700 52px "Segoe UI", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "top";

  const titleLines = getWrappedLines(
    context,
    command.title,
    1420,
  ).slice(0, 2);

  titleLines.forEach((line, index) => {
    context.fillText(line, 90, 45 + index * 58);
  });

  if (command.subtitle) {
    context.fillStyle = BOARD_MUTED;
    context.font = '25px "Segoe UI", sans-serif';
    context.fillText(
      command.subtitle,
      92,
      112 + Math.max(0, titleLines.length - 1) * 58,
    );
  }

  if (command.chartType === "pie") {
    renderPieChart(context, command);
  } else {
    renderCartesianChart(context, command);
  }

  const footerParts: string[] = [];

  if (command.source) {
    footerParts.push(`Source: ${command.source}`);
  }

  if (command.fetchedAt) {
    const date = new Date(command.fetchedAt);

    if (!Number.isNaN(date.getTime())) {
      footerParts.push(
        `Fetched: ${date.toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        })}`,
      );
    }
  }

  if (footerParts.length > 0) {
    context.fillStyle = "#64748b";
    context.font = '22px "Segoe UI", sans-serif';
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillText(
      footerParts.join(" • "),
      90,
      865,
    );
  }
}

function renderBoardCommandToCanvas(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  command: BoardCommand,
  textSize: TextSize = "medium",
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = command.type === "write_text"
    ? command.formatting?.backgroundColor || BOARD_BACKGROUND
    : BOARD_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  context.save();

  if (command.type === "write_text") {
    renderTextCommand(context, command, textSize);
  } else if (command.type === "flowchart") {
    renderFlowchartCommand(context, command);
  } else if (command.type === "chart") {
    renderChartCommand(context, command);
  }

  context.restore();
}


function clampAnimationSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    return 55;
  }

  return Math.min(100, Math.max(10, value));
}

function writingDelayMs(speed: number): number {
  const normalized = (clampAnimationSpeed(speed) - 10) / 90;
  return 92 - normalized * 84;
}

function drawingUnitMs(speed: number): number {
  const normalized = (clampAnimationSpeed(speed) - 10) / 90;
  return 720 - normalized * 610;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function takeCharacterPrefix(
  value: string,
  count: number,
): string {
  return Array.from(value)
    .slice(0, Math.max(0, count))
    .join("");
}

function countTextCommandCharacters(
  command: BoardTextCommand,
): number {
  return (
    characterLength(command.title) +
    command.bullets.reduce(
      (sum, item) => sum + characterLength(item),
      0,
    ) +
    (command.formulas ?? []).reduce(
      (sum, item) => sum + characterLength(item),
      0,
    ) +
    (command.note ? characterLength(command.note) : 0)
  );
}

function buildPartialTextCommand(
  command: BoardTextCommand,
  visibleCharacters: number,
): BoardTextCommand {
  let remaining = Math.max(0, visibleCharacters);

  const take = (value: string): string => {
    if (remaining <= 0) {
      return "";
    }

    const length = characterLength(value);
    const result = takeCharacterPrefix(
      value,
      Math.min(length, remaining),
    );

    remaining -= Math.min(length, remaining);
    return result;
  };

  const title = take(command.title);
  const bullets: string[] = [];

  for (const bullet of command.bullets) {
    if (remaining <= 0) {
      break;
    }

    const partial = take(bullet);

    if (partial) {
      bullets.push(partial);
    }
  }

  const formulas: string[] = [];

  for (const formula of command.formulas ?? []) {
    if (remaining <= 0) {
      break;
    }

    const partial = take(formula);

    if (partial) {
      formulas.push(partial);
    }
  }

  const note =
    remaining > 0 && command.note
      ? take(command.note)
      : undefined;

  return {
    type: "write_text",
    title,
    bullets,
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(note ? { note } : {}),
  };
}

function buildPartialFlowchartCommand(
  command: BoardFlowchartCommand,
  progress: number,
): BoardFlowchartCommand {
  const safeProgress = Math.min(1, Math.max(0, progress));

  // Title uses the first 18% of the drawing animation.
  const titleProgress = Math.min(1, safeProgress / 0.18);
  const title = takeCharacterPrefix(
    command.title,
    Math.ceil(characterLength(command.title) * titleProgress),
  );

  if (safeProgress <= 0.18) {
    return {
      type: "flowchart",
      title,
      nodes: [],
      edges: [],
    };
  }

  const contentProgress = (safeProgress - 0.18) / 0.82;
  const nodeWeight = Math.max(1, command.nodes.length) * 2;
  const edgeWeight = Math.max(1, command.edges.length);
  const totalWeight = nodeWeight + edgeWeight;
  const contentUnits = contentProgress * totalWeight;

  const nodeUnits = Math.min(nodeWeight, contentUnits);
  const fullNodes = Math.min(
    command.nodes.length,
    Math.floor(nodeUnits / 2),
  );

  const nodes = command.nodes
    .slice(0, fullNodes)
    .map((node) => ({ ...node }));

  if (
    fullNodes < command.nodes.length &&
    nodeUnits > fullNodes * 2
  ) {
    const currentNode = command.nodes[fullNodes];
    const labelProgress = Math.min(
      1,
      nodeUnits - fullNodes * 2,
    );

    nodes.push({
      ...currentNode,
      label: takeCharacterPrefix(
        currentNode.label,
        Math.ceil(
          characterLength(currentNode.label) * labelProgress,
        ),
      ),
    });
  }

  const edgeUnits = Math.max(0, contentUnits - nodeWeight);
  const edgeCount = Math.min(
    command.edges.length,
    Math.floor(edgeUnits + 0.001),
  );

  return {
    type: "flowchart",
    title,
    nodes,
    edges: command.edges.slice(0, edgeCount),
  };
}

function buildPartialChartCommand(
  command: BoardChartCommand,
  progress: number,
): BoardChartCommand {
  const safeProgress = Math.min(1, Math.max(0, progress));
  const titleProgress = Math.min(1, safeProgress / 0.2);
  const dataProgress = Math.max(0, (safeProgress - 0.2) / 0.8);

  const title = takeCharacterPrefix(
    command.title,
    Math.ceil(characterLength(command.title) * titleProgress),
  );

  const visibleRows =
    command.data.length > 0
      ? Math.max(
          1,
          Math.ceil(command.data.length * dataProgress),
        )
      : 0;

  return {
    ...command,
    title,
    data: command.data.slice(0, visibleRows),
  };
}

function createFittedImageCanvas(
  image: HTMLImageElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    return canvas;
  }

  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, width, height);

  const scale = Math.min(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );

  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  context.drawImage(
    image,
    x,
    y,
    drawWidth,
    drawHeight,
  );

  return canvas;
}

function deterministicStrokeJitter(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

type DoodleRevealPoint = {
  x: number;
  y: number;
  breakBefore: boolean;
};

type DoodleRevealPlan = {
  points: DoodleRevealPoint[];
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D | null;
  revealCanvas: HTMLCanvasElement;
  revealContext: CanvasRenderingContext2D | null;
  revealedCount: number;
};

function isInkPixel(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): boolean {
  if (alpha < 24) {
    return false;
  }

  /*
   * Doodle images are generated on an almost-white background.
   * Detect actual marker/colored pixels instead of scanning the whole
   * rectangle. This is what prevents the old left-to-right wipe.
   */
  const darkest = Math.min(red, green, blue);
  const lightest = Math.max(red, green, blue);
  const saturation = lightest - darkest;
  const distanceFromWhite =
    (255 - red) + (255 - green) + (255 - blue);

  return (
    darkest < 232 ||
    saturation > 24 ||
    distanceFromWhite > 55
  );
}

function buildDoodleRevealPlan(
  sourceCanvas: HTMLCanvasElement,
): DoodleRevealPlan {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;

  const revealCanvas = document.createElement("canvas");
  revealCanvas.width = width;
  revealCanvas.height = height;

  const maskContext = maskCanvas.getContext("2d");
  const revealContext = revealCanvas.getContext("2d");
  const sourceContext = sourceCanvas.getContext("2d");

  if (!sourceContext) {
    return {
      points: [],
      maskCanvas,
      maskContext,
      revealCanvas,
      revealContext,
      revealedCount: 0,
    };
  }

  const imageData = sourceContext.getImageData(
    0,
    0,
    width,
    height,
  );

  /*
   * Each occupied grid cell represents a small piece of visible ink.
   * We later walk connected cells, which makes the reveal follow the
   * cat/dog outline rather than sweeping horizontally across the board.
   */
  const cellSize = 16;
  const sampleStep = 4;
  const columns = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const occupied = new Uint8Array(columns * rows);
  const hitCounts = new Uint8Array(columns * rows);

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const pixelIndex = (y * width + x) * 4;

      if (
        !isInkPixel(
          imageData.data[pixelIndex],
          imageData.data[pixelIndex + 1],
          imageData.data[pixelIndex + 2],
          imageData.data[pixelIndex + 3],
        )
      ) {
        continue;
      }

      const column = Math.floor(x / cellSize);
      const row = Math.floor(y / cellSize);
      const gridIndex = row * columns + column;

      hitCounts[gridIndex] = Math.min(
        255,
        hitCounts[gridIndex] + 1,
      );
    }
  }

  for (let index = 0; index < hitCounts.length; index += 1) {
    if (hitCounts[index] > 0) {
      occupied[index] = 1;
    }
  }

  const neighborOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;

  function neighborsOf(index: number): number[] {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const result: number[] = [];

    for (const [dx, dy] of neighborOffsets) {
      const nextColumn = column + dx;
      const nextRow = row + dy;

      if (
        nextColumn < 0 ||
        nextColumn >= columns ||
        nextRow < 0 ||
        nextRow >= rows
      ) {
        continue;
      }

      const nextIndex = nextRow * columns + nextColumn;

      if (occupied[nextIndex]) {
        result.push(nextIndex);
      }
    }

    return result;
  }

  /*
   * First collect connected components. The largest component is
   * usually the main animal outline, so it is drawn before tiny details.
   */
  const componentVisited = new Uint8Array(occupied.length);
  const components: number[][] = [];

  for (let index = 0; index < occupied.length; index += 1) {
    if (!occupied[index] || componentVisited[index]) {
      continue;
    }

    const component: number[] = [];
    const queue = [index];
    componentVisited[index] = 1;

    while (queue.length > 0) {
      const current = queue.pop();

      if (current === undefined) {
        break;
      }

      component.push(current);

      for (const neighbor of neighborsOf(current)) {
        if (!componentVisited[neighbor]) {
          componentVisited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);

  const points: DoodleRevealPoint[] = [];
  const walkVisited = new Uint8Array(occupied.length);

  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex];

    if (component.length === 0) {
      continue;
    }

    /*
     * Prefer an endpoint (fewest neighbours) as the place where the
     * marker first touches this connected stroke.
     */
    let startIndex = component[0];
    let smallestNeighborCount = Number.POSITIVE_INFINITY;

    for (const candidate of component) {
      const count = neighborsOf(candidate).length;
      const jitter = deterministicStrokeJitter(candidate + componentIndex * 97);

      if (
        count < smallestNeighborCount ||
        (count === smallestNeighborCount && jitter > 0.35)
      ) {
        startIndex = candidate;
        smallestNeighborCount = count;
      }
    }

    const stack = [startIndex];
    let previousGridIndex: number | null = null;

    while (stack.length > 0) {
      const current = stack.pop();

      if (current === undefined || walkVisited[current]) {
        continue;
      }

      walkVisited[current] = 1;

      const row = Math.floor(current / columns);
      const column = current % columns;
      const centerX = Math.min(
        width - 1,
        column * cellSize + cellSize / 2,
      );
      const centerY = Math.min(
        height - 1,
        row * cellSize + cellSize / 2,
      );

      let breakBefore = previousGridIndex === null;

      if (previousGridIndex !== null) {
        const previousRow = Math.floor(previousGridIndex / columns);
        const previousColumn = previousGridIndex % columns;
        const columnDistance = Math.abs(previousColumn - column);
        const rowDistance = Math.abs(previousRow - row);

        /*
         * DFS sometimes returns from a branch to another branch. Treat
         * that as lifting the marker and touching down somewhere else,
         * rather than drawing an artificial connecting line.
         */
        breakBefore =
          columnDistance > 1 ||
          rowDistance > 1;
      }

      points.push({
        x:
          centerX +
          deterministicStrokeJitter(current + 301) * 2.4,
        y:
          centerY +
          deterministicStrokeJitter(current + 607) * 2.4,
        breakBefore,
      });

      previousGridIndex = current;

      const candidates = neighborsOf(current)
        .filter((neighbor) => !walkVisited[neighbor])
        .sort((a, b) => {
          /*
           * Deterministic non-raster ordering avoids a hidden left-to-
           * right bias while still producing stable animation each run.
           */
          const scoreA = deterministicStrokeJitter(
            a * 31 + current * 7 + componentIndex * 101,
          );
          const scoreB = deterministicStrokeJitter(
            b * 31 + current * 7 + componentIndex * 101,
          );

          return scoreA - scoreB;
        });

      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        stack.push(candidates[i]);
      }
    }

    /* Make the next disconnected component start with a marker lift. */
    previousGridIndex = null;
  }

  return {
    points,
    maskCanvas,
    maskContext,
    revealCanvas,
    revealContext,
    revealedCount: 0,
  };
}

function resetDoodleRevealPlan(plan: DoodleRevealPlan) {
  plan.revealedCount = 0;

  plan.maskContext?.clearRect(
    0,
    0,
    plan.maskCanvas.width,
    plan.maskCanvas.height,
  );

  plan.revealContext?.clearRect(
    0,
    0,
    plan.revealCanvas.width,
    plan.revealCanvas.height,
  );
}

type TracedStroke = {
  points: RenderPoint[];
};

function thinBinaryImage(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const data = pixels.slice();
  const neighbors = new Array<number>(8);

  const at = (x: number, y: number) => data[y * width + x];

  for (let iteration = 0; iteration < 40; iteration += 1) {
    let changed = false;

    for (let pass = 0; pass < 2; pass += 1) {
      const remove: number[] = [];

      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = y * width + x;

          if (!data[index]) {
            continue;
          }

          neighbors[0] = at(x, y - 1);
          neighbors[1] = at(x + 1, y - 1);
          neighbors[2] = at(x + 1, y);
          neighbors[3] = at(x + 1, y + 1);
          neighbors[4] = at(x, y + 1);
          neighbors[5] = at(x - 1, y + 1);
          neighbors[6] = at(x - 1, y);
          neighbors[7] = at(x - 1, y - 1);

          const count = neighbors.reduce((sum, value) => sum + value, 0);

          if (count < 2 || count > 6) {
            continue;
          }

          let transitions = 0;

          for (let i = 0; i < 8; i += 1) {
            if (neighbors[i] === 0 && neighbors[(i + 1) % 8] === 1) {
              transitions += 1;
            }
          }

          if (transitions !== 1) {
            continue;
          }

          const p2 = neighbors[0];
          const p4 = neighbors[2];
          const p6 = neighbors[4];
          const p8 = neighbors[6];

          const firstCondition =
            pass === 0
              ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0
              : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0;

          if (firstCondition) {
            remove.push(index);
          }
        }
      }

      if (remove.length > 0) {
        changed = true;

        for (const index of remove) {
          data[index] = 0;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  return data;
}

function simplifyTracePoints(
  points: RenderPoint[],
  minimumDistance = 5,
): RenderPoint[] {
  if (points.length <= 2) {
    return points;
  }

  const simplified: RenderPoint[] = [points[0]];
  let previous = points[0];

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const distance = Math.hypot(
      point.x - previous.x,
      point.y - previous.y,
    );

    if (distance >= minimumDistance) {
      simplified.push(point);
      previous = point;
    }
  }

  simplified.push(points[points.length - 1]);
  return simplified;
}

function traceDoodleImageToStrokes(
  sourceCanvas: HTMLCanvasElement,
): TracedStroke[] {
  const traceWidth = 320;
  const traceHeight = 180;
  const traceCanvas = document.createElement("canvas");
  traceCanvas.width = traceWidth;
  traceCanvas.height = traceHeight;

  const traceContext = traceCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!traceContext) {
    return [];
  }

  traceContext.fillStyle = BOARD_BACKGROUND;
  traceContext.fillRect(0, 0, traceWidth, traceHeight);
  traceContext.drawImage(
    sourceCanvas,
    0,
    0,
    traceWidth,
    traceHeight,
  );

  const imageData = traceContext.getImageData(
    0,
    0,
    traceWidth,
    traceHeight,
  );

  const binary = new Uint8Array(traceWidth * traceHeight);

  for (let y = 1; y < traceHeight - 1; y += 1) {
    for (let x = 1; x < traceWidth - 1; x += 1) {
      const pixelIndex = (y * traceWidth + x) * 4;
      const red = imageData.data[pixelIndex];
      const green = imageData.data[pixelIndex + 1];
      const blue = imageData.data[pixelIndex + 2];
      const alpha = imageData.data[pixelIndex + 3];

      const luminance =
        red * 0.2126 +
        green * 0.7152 +
        blue * 0.0722;

      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const saturation = maxChannel - minChannel;

      if (
        alpha > 24 &&
        (luminance < 218 || saturation > 40)
      ) {
        binary[y * traceWidth + x] = 1;
      }
    }
  }

  const skeleton = thinBinaryImage(
    binary,
    traceWidth,
    traceHeight,
  );

  const neighborOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;

  const neighborsOf = (index: number): number[] => {
    const x = index % traceWidth;
    const y = Math.floor(index / traceWidth);
    const result: number[] = [];

    for (const [dx, dy] of neighborOffsets) {
      const nx = x + dx;
      const ny = y + dy;

      if (
        nx < 0 ||
        nx >= traceWidth ||
        ny < 0 ||
        ny >= traceHeight
      ) {
        continue;
      }

      const next = ny * traceWidth + nx;

      if (skeleton[next]) {
        result.push(next);
      }
    }

    return result;
  };

  const edgeKey = (a: number, b: number) =>
    a < b ? `${a}:${b}` : `${b}:${a}`;

  const visitedEdges = new Set<string>();
  const rawStrokes: number[][] = [];

  const followEdge = (
    start: number,
    next: number,
  ): number[] => {
    const path = [start, next];
    visitedEdges.add(edgeKey(start, next));

    let previous = start;
    let current = next;

    while (true) {
      const candidates = neighborsOf(current).filter(
        (candidate) =>
          candidate !== previous &&
          !visitedEdges.has(edgeKey(current, candidate)),
      );

      if (candidates.length !== 1) {
        break;
      }

      const following = candidates[0];
      visitedEdges.add(edgeKey(current, following));
      path.push(following);
      previous = current;
      current = following;
    }

    return path;
  };

  const starts: number[] = [];

  for (let index = 0; index < skeleton.length; index += 1) {
    if (!skeleton[index]) {
      continue;
    }

    const degree = neighborsOf(index).length;

    if (degree !== 2 && degree > 0) {
      starts.push(index);
    }
  }

  for (const start of starts) {
    for (const neighbor of neighborsOf(start)) {
      if (visitedEdges.has(edgeKey(start, neighbor))) {
        continue;
      }

      const path = followEdge(start, neighbor);

      if (path.length >= 3) {
        rawStrokes.push(path);
      }
    }
  }

  // Remaining edges are closed loops.
  for (let index = 0; index < skeleton.length; index += 1) {
    if (!skeleton[index]) {
      continue;
    }

    for (const neighbor of neighborsOf(index)) {
      if (visitedEdges.has(edgeKey(index, neighbor))) {
        continue;
      }

      const path = followEdge(index, neighbor);

      if (path.length >= 3) {
        rawStrokes.push(path);
      }
    }
  }

  const scaleX = sourceCanvas.width / traceWidth;
  const scaleY = sourceCanvas.height / traceHeight;

  const strokes = rawStrokes
    .map((path) => {
      const points = path.map((index) => ({
        x: (index % traceWidth + 0.5) * scaleX,
        y: (Math.floor(index / traceWidth) + 0.5) * scaleY,
      }));

      return {
        points: simplifyTracePoints(points, 5),
      };
    })
    .filter((stroke) => stroke.points.length >= 2)
    .filter((stroke) => {
      let length = 0;

      for (let i = 1; i < stroke.points.length; i += 1) {
        length += Math.hypot(
          stroke.points[i].x - stroke.points[i - 1].x,
          stroke.points[i].y - stroke.points[i - 1].y,
        );
      }

      return length >= 18;
    });

  if (strokes.length <= 1) {
    return strokes;
  }

  // Greedy pen ordering: continue from whichever stroke endpoint is nearest.
  const remaining = strokes.slice();
  const ordered: TracedStroke[] = [];
  let currentPoint: RenderPoint = {
    x: sourceCanvas.width / 2,
    y: sourceCanvas.height / 2,
  };

  while (remaining.length > 0) {
    let bestIndex = 0;
    let reverse = false;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const stroke = remaining[index];
      const first = stroke.points[0];
      const last = stroke.points[stroke.points.length - 1];
      const firstDistance = Math.hypot(
        first.x - currentPoint.x,
        first.y - currentPoint.y,
      );
      const lastDistance = Math.hypot(
        last.x - currentPoint.x,
        last.y - currentPoint.y,
      );

      if (firstDistance < bestDistance) {
        bestDistance = firstDistance;
        bestIndex = index;
        reverse = false;
      }

      if (lastDistance < bestDistance) {
        bestDistance = lastDistance;
        bestIndex = index;
        reverse = true;
      }
    }

    const [stroke] = remaining.splice(bestIndex, 1);
    const points = reverse
      ? stroke.points.slice().reverse()
      : stroke.points;

    ordered.push({ points });
    currentPoint = points[points.length - 1];
  }

  return ordered.slice(0, 600);
}

function countTracedStrokeUnits(
  strokes: TracedStroke[],
): number {
  return strokes.reduce(
    (sum, stroke) =>
      sum + Math.max(1, stroke.points.length - 1),
    0,
  );
}

function paintTracedDoodle(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  strokes: TracedStroke[],
  progress: number,
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const totalUnits = Math.max(1, countTracedStrokeUnits(strokes));
  let remaining = Math.ceil(totalUnits * Math.min(1, Math.max(0, progress)));

  context.save();
  context.strokeStyle = "#1f2937";
  context.lineWidth = 4.6;
  context.lineCap = "round";
  context.lineJoin = "round";

  for (let strokeIndex = 0; strokeIndex < strokes.length; strokeIndex += 1) {
    if (remaining <= 0) {
      break;
    }

    const stroke = strokes[strokeIndex];
    const units = Math.max(1, stroke.points.length - 1);
    const visibleUnits = Math.min(units, remaining);

    if (stroke.points.length >= 2 && visibleUnits > 0) {
      context.globalAlpha = 0.92;
      context.beginPath();
      context.moveTo(stroke.points[0].x, stroke.points[0].y);

      for (let index = 1; index <= visibleUnits; index += 1) {
        context.lineTo(
          stroke.points[index].x,
          stroke.points[index].y,
        );
      }

      context.stroke();

      // A subtle second pass gives the dry-erase line a human retraced feel.
      if (visibleUnits === units && strokeIndex % 3 === 0) {
        const jitterX = deterministicStrokeJitter(strokeIndex + 91) * 1.5;
        const jitterY = deterministicStrokeJitter(strokeIndex + 193) * 1.5;
        context.globalAlpha = 0.24;
        context.lineWidth = 3.2;
        context.beginPath();
        context.moveTo(
          stroke.points[0].x + jitterX,
          stroke.points[0].y + jitterY,
        );

        for (let index = 1; index < stroke.points.length; index += 1) {
          context.lineTo(
            stroke.points[index].x + jitterX,
            stroke.points[index].y + jitterY,
          );
        }

        context.stroke();
      }
    }

    remaining -= visibleUnits;
  }

  context.restore();
}

function paintImageDoodleReveal(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  sourceCanvas: HTMLCanvasElement,
  plan: DoodleRevealPlan,
  progress: number,
) {
  const safeProgress = Math.min(1, Math.max(0, progress));

  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  if (
    !plan.maskContext ||
    !plan.revealContext ||
    plan.points.length === 0
  ) {
    /*
     * Fallback for an unexpectedly blank/photographic model response:
     * fade the image in rather than reverting to a directional wipe.
     */
    context.save();
    context.globalAlpha = safeProgress;
    context.drawImage(
      sourceCanvas,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    context.restore();
    return;
  }

  const visibleCount = Math.min(
    plan.points.length,
    Math.ceil(plan.points.length * safeProgress),
  );

  if (visibleCount < plan.revealedCount) {
    resetDoodleRevealPlan(plan);
  }

  const mask = plan.maskContext;
  mask.save();
  mask.strokeStyle = "#ffffff";
  mask.fillStyle = "#ffffff";
  mask.lineCap = "round";
  mask.lineJoin = "round";
  mask.lineWidth = 24;

  for (
    let index = plan.revealedCount;
    index < visibleCount;
    index += 1
  ) {
    const point = plan.points[index];
    const previous = index > 0 ? plan.points[index - 1] : null;

    if (
      point.breakBefore ||
      !previous ||
      previous.breakBefore
    ) {
      mask.beginPath();
      mask.arc(point.x, point.y, 12, 0, Math.PI * 2);
      mask.fill();
      continue;
    }

    mask.beginPath();
    mask.moveTo(previous.x, previous.y);
    mask.lineTo(point.x, point.y);
    mask.stroke();

    /*
     * A second, thinner offset pass mimics the marker briefly retracing
     * the same line. It overlaps the first pass instead of sweeping a
     * fresh rectangular region.
     */
    if (index % 4 === 0) {
      const offsetX = deterministicStrokeJitter(index + 911) * 2.2;
      const offsetY = deterministicStrokeJitter(index + 1217) * 2.2;

      mask.save();
      mask.globalAlpha = 0.82;
      mask.lineWidth = 12;
      mask.beginPath();
      mask.moveTo(
        previous.x + offsetX,
        previous.y + offsetY,
      );
      mask.lineTo(
        point.x + offsetX,
        point.y + offsetY,
      );
      mask.stroke();
      mask.restore();
    }
  }

  mask.restore();
  plan.revealedCount = visibleCount;

  const reveal = plan.revealContext;
  reveal.save();
  reveal.globalCompositeOperation = "source-over";
  reveal.clearRect(
    0,
    0,
    plan.revealCanvas.width,
    plan.revealCanvas.height,
  );
  reveal.drawImage(
    sourceCanvas,
    0,
    0,
    plan.revealCanvas.width,
    plan.revealCanvas.height,
  );
  reveal.globalCompositeOperation = "destination-in";
  reveal.drawImage(plan.maskCanvas, 0, 0);
  reveal.restore();

  context.drawImage(
    plan.revealCanvas,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function loadBoardImage(
  command: BoardImageCommand,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "Could not load the generated image for the whiteboard.",
        ),
      );

    image.src = command.imageDataUrl;
  });
}

function paintBoardImage(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Gemini is requested to return 16:9 images, matching the board.
  // Use contain as a safety net so no part of the generated image is
  // cropped if a model returns a slightly different aspect ratio.
  const scale = Math.min(
    canvas.width / image.naturalWidth,
    canvas.height / image.naturalHeight,
  );

  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (canvas.width - width) / 2;
  const y = (canvas.height - height) / 2;

  context.drawImage(
    image,
    x,
    y,
    width,
    height,
  );
  context.restore();
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
  generatedCommand,
  generatedCommandVersion,
  textSize,
  writingSpeed,
  drawingSpeed,
  animationPaused = false,
  onDrawingChange,
  onCommandRenderComplete,
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

  const completedCommandRenderRef =
    useRef<Record<number, number>>({});

  const drawingLoadRunRef = useRef(0);
  const commandRenderRunRef = useRef(0);
  const animationPausedRef = useRef(animationPaused);
  const writingSpeedRef = useRef(writingSpeed);
  const drawingSpeedRef = useRef(drawingSpeed);

  useEffect(() => {
    animationPausedRef.current = animationPaused;
  }, [animationPaused]);

  useEffect(() => {
    writingSpeedRef.current = writingSpeed;
  }, [writingSpeed]);

  useEffect(() => {
    drawingSpeedRef.current = drawingSpeed;
  }, [drawingSpeed]);

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

  const renderCommandToBoard = useCallback(
    async (
      command: BoardCommand,
      targetBoardId: number,
      renderRun: number,
      commandVersion: number,
      animateCommand = true,
    ) => {
      if (!drawingCanvas || !context) {
        return;
      }

      const isCancelled = () =>
        renderRun !== commandRenderRunRef.current ||
        activeBoardIdRef.current !== targetBoardId;

      if (
        command.type === "write_text" ||
        command.type === "flowchart"
      ) {
        await document.fonts.load(
          '400 42px "Lixia Handwriting"',
        );
      }

      const animate = async (
        durationMs: number,
        drawFrame: (progress: number) => void,
      ): Promise<boolean> => {
        return new Promise((resolve) => {
          let accumulated = 0;
          let lastTimestamp: number | null = null;

          const frame = (timestamp: number) => {
            if (isCancelled()) {
              resolve(false);
              return;
            }

            if (lastTimestamp === null) {
              lastTimestamp = timestamp;
            }

            const delta = Math.min(50, timestamp - lastTimestamp);
            lastTimestamp = timestamp;

            // Pausing voice also pauses the board-writing clock.
            if (!animationPausedRef.current) {
              accumulated += delta;
            }

            const progress = Math.min(
              1,
              accumulated /
                Math.max(1, animateCommand ? durationMs : 1),
            );

            drawFrame(progress);
            refreshTexture();

            if (progress >= 1) {
              resolve(true);
              return;
            }

            window.requestAnimationFrame(frame);
          };

          window.requestAnimationFrame(frame);
        });
      };

      let completed = false;

      if (command.type === "image") {
        const image = await loadBoardImage(command);

        if (isCancelled()) {
          return;
        }

        const fittedImage = createFittedImageCanvas(
          image,
          drawingCanvas.width,
          drawingCanvas.height,
        );

        const doodleRevealPlan =
          buildDoodleRevealPlan(fittedImage);

        const duration = command.style === "doodle"
          ? Math.min(
              9500,
              Math.max(
                750,
                480 +
                  drawingUnitMs(drawingSpeedRef.current) *
                    Math.max(5, doodleRevealPlan.points.length / 70),
              ),
            )
          : Math.min(
              12000,
              Math.max(
                700,
                420 +
                  drawingUnitMs(drawingSpeedRef.current) *
                    Math.max(4, doodleRevealPlan.points.length / 80),
              ),
            );

        completed = await animate(
          duration,
          (progress) => {
            paintImageDoodleReveal(
              context,
              drawingCanvas,
              fittedImage,
              doodleRevealPlan,
              progress,
            );
          },
        );
      } else if (command.type === "write_text") {
        const characterCount = Math.max(
          1,
          countTextCommandCharacters(command),
        );

        const duration = Math.min(
          30000,
          Math.max(450, characterCount * writingDelayMs(writingSpeedRef.current)),
        );

        completed = await animate(
          duration,
          (progress) => {
            const visibleCharacters = Math.ceil(
              characterCount * progress,
            );

            renderBoardCommandToCanvas(
              context,
              drawingCanvas,
              buildPartialTextCommand(
                command,
                visibleCharacters,
              ),
              textSize,
            );
          },
        );
      } else if (command.type === "flowchart") {
        const complexity =
          Math.max(1, command.nodes.length) * 1.25 +
          Math.max(1, command.edges.length) * 0.8;

        const duration = Math.min(
          24000,
          1000 + drawingUnitMs(drawingSpeedRef.current) * complexity,
        );

        completed = await animate(
          duration,
          (progress) => {
            renderBoardCommandToCanvas(
              context,
              drawingCanvas,
              buildPartialFlowchartCommand(
                command,
                progress,
              ),
            );
          },
        );
      } else {
        const dataCount = Math.max(1, command.data.length);
        const duration = Math.min(
          18000,
          1100 +
            drawingUnitMs(drawingSpeedRef.current) *
              Math.min(12, dataCount) *
              0.7,
        );

        completed = await animate(
          duration,
          (progress) => {
            renderBoardCommandToCanvas(
              context,
              drawingCanvas,
              buildPartialChartCommand(
                command,
                progress,
              ),
            );
          },
        );
      }

      if (!completed || isCancelled()) {
        return;
      }

      // Ensure the exact final scene is painted after the animation.
      if (command.type === "image") {
        const image = await loadBoardImage(command);

        if (isCancelled()) {
          return;
        }

        paintBoardImage(
          context,
          drawingCanvas,
          image,
        );
      } else {
        renderBoardCommandToCanvas(
          context,
          drawingCanvas,
          command,
          textSize,
        );
      }

      refreshTexture();

      const finishedDrawing =
        drawingCanvas.toDataURL("image/png");

      onDrawingChange(
        targetBoardId,
        finishedDrawing,
      );

      onCommandRenderComplete?.(
        targetBoardId,
        commandVersion,
      );
    },
    [
      drawingCanvas,
      context,
      refreshTexture,
      onDrawingChange,
      onCommandRenderComplete,
      textSize,
    ],
  );

  /*
   * Initialize the white canvas.
   */
  useEffect(() => {
    fillBoardWhite();

    return () => {
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

    // Cancel any pending render/load work that belonged to the previous board.
    const loadRun = ++drawingLoadRunRef.current;
    commandRenderRunRef.current += 1;

    if (!drawingCanvas || !context) {
      return;
    }

    const hasPendingAiRender =
      generatedCommand !== null &&
      generatedCommandVersion > 0 &&
      completedCommandRenderRef.current[boardId] !==
        generatedCommandVersion;

    // If this board has a new Gemini scene waiting to render, do not
    // load an older PNG over it. Start from white and let the
    // structured-command render effect below paint the new scene.
    if (hasPendingAiRender) {
      loadingDrawingRef.current = false;
      fillBoardWhite();
      return;
    }

    loadingDrawingRef.current = true;

    context.save();
    context.globalCompositeOperation = "source-over";
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
        loadRun !== drawingLoadRunRef.current ||
        activeBoardIdRef.current !== boardId ||
        !drawingCanvas ||
        !context
      ) {
        return;
      }

      context.save();
      context.globalCompositeOperation = "source-over";
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
      if (loadRun !== drawingLoadRunRef.current) {
        return;
      }

      loadingDrawingRef.current = false;
      fillBoardWhite();
    };

    image.src = savedDrawing;
  }, [
    boardId,
    savedDrawing,
    generatedCommand,
    generatedCommandVersion,
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

    drawingLoadRunRef.current += 1;
    commandRenderRunRef.current += 1;

    delete completedCommandRenderRef.current[
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
   * Render Gemini's structured whiteboard command onto the 2D canvas.
   *
   * Our application draws text, flowcharts, and charts itself.
   * For realistic image tools, Gemini Image returns a raster image
   * which is then painted onto this same board canvas.
   */
  useEffect(() => {
    const alreadyRenderedVersion =
      completedCommandRenderRef.current[boardId];

    if (
      generatedCommand === null ||
      generatedCommandVersion === 0 ||
      !drawingCanvas ||
      !context ||
      alreadyRenderedVersion === generatedCommandVersion
    ) {
      return;
    }

    drawingLoadRunRef.current += 1;
    const renderRun = ++commandRenderRunRef.current;
    const animateCommand =
      generatedCommand.type !== "write_text" ||
      alreadyRenderedVersion === undefined;

    void renderCommandToBoard(
      generatedCommand,
      boardId,
      renderRun,
      generatedCommandVersion,
      animateCommand,
    ).then(() => {
      if (
        activeBoardIdRef.current === boardId &&
        commandRenderRunRef.current === renderRun
      ) {
        completedCommandRenderRef.current[boardId] =
          generatedCommandVersion;
      }
    }).catch((error) => {
      console.error(
        "Could not render whiteboard command:",
        error,
      );

      // Allow this version to retry if rendering failed.
      if (activeBoardIdRef.current === boardId) {
        delete completedCommandRenderRef.current[boardId];
      }
    });

    return () => {
      if (commandRenderRunRef.current === renderRun) {
        commandRenderRunRef.current += 1;

        // Keep completed versions cached so switching boards does not
        // replay a command that was already written.
      }
    };
  }, [
    generatedCommand,
    generatedCommandVersion,
    boardId,
    drawingCanvas,
    context,
    renderCommandToBoard,
    textSize,
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