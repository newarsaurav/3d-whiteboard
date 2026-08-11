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
} from "@/types/board";

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

  generatedCommand: BoardCommand | null;
  generatedCommandVersion: number;

  onDrawingChange: (
    boardId: number,
    drawing: string,
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

function renderTextCommand(
  context: CanvasRenderingContext2D,
  command: BoardTextCommand,
) {
  const marginX = 95;

  context.fillStyle = "#312e81";
  context.font =
    '600 64px "Lixia Handwriting", "Comic Sans MS", cursive';
  context.textAlign = "left";
  context.textBaseline = "top";

  const titleLines = getWrappedLines(
    context,
    command.title,
    CANVAS_WIDTH - marginX * 2,
  ).slice(0, 2);

  titleLines.forEach((line, index) => {
    context.fillText(
      line,
      marginX,
      62 + index * 72,
    );
  });

  let currentY =
    62 + Math.max(1, titleLines.length) * 78 + 24;

  context.fillStyle = BOARD_INK;
  context.font =
    '400 42px "Lixia Handwriting", "Comic Sans MS", cursive';

  for (const bullet of command.bullets.slice(0, 8)) {
    const lines = getWrappedLines(
      context,
      bullet,
      CANVAS_WIDTH - 250,
    );

    if (currentY + lines.length * 54 > 760) {
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

    lines.forEach((line, index) => {
      context.fillText(
        line,
        marginX + 42,
        currentY + index * 54,
      );
    });

    currentY += Math.max(1, lines.length) * 54 + 18;
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
      92,
      18,
    );
    context.fill();
    context.stroke();

    context.fillStyle = "#3730a3";
    context.font =
      '600 32px "Lixia Handwriting", "Comic Sans MS", cursive';
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
          (index - (noteLines.length - 1) / 2) * 34,
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

  context.fillStyle = BOARD_INK;
  context.font = '600 29px "Segoe UI", sans-serif';

  drawCenteredWrappedText(
    context,
    node.label,
    node.center.x,
    node.center.y,
    node.width - 34,
    34,
    node.shape === "diamond" ? 2 : 3,
  );

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
    context.fillStyle = BOARD_INK;
    context.font = '38px "Segoe UI", sans-serif';
    context.fillText("No flowchart nodes were returned.", 90, 180);
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
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  context.save();

  if (command.type === "write_text") {
    renderTextCommand(context, command);
  } else if (command.type === "flowchart") {
    renderFlowchartCommand(context, command);
  } else if (command.type === "chart") {
    renderChartCommand(context, command);
  }

  context.restore();
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

  const completedCommandRenderRef =
    useRef<Record<number, number>>({});

  const drawingLoadRunRef = useRef(0);
  const commandRenderRunRef = useRef(0);

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
    ) => {
      if (!drawingCanvas || !context) {
        return;
      }

      // Do not paint a result onto a different board if the user
      // switched boards while Gemini was answering.
      if (
        renderRun !== commandRenderRunRef.current ||
        activeBoardIdRef.current !== targetBoardId
      ) {
        return;
      }

      if (command.type === "image") {
        const image = await loadBoardImage(command);

        // Image decoding is asynchronous. Check again after it finishes
        // so an old result cannot paint onto a newly selected board.
        if (
          renderRun !== commandRenderRunRef.current ||
          activeBoardIdRef.current !== targetBoardId
        ) {
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
        );
      }

      refreshTexture();

      const finishedDrawing =
        drawingCanvas.toDataURL("image/png");

      onDrawingChange(
        targetBoardId,
        finishedDrawing,
      );
    },
    [
      drawingCanvas,
      context,
      refreshTexture,
      onDrawingChange,
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

    completedCommandRenderRef.current[boardId] =
      generatedCommandVersion;

    drawingLoadRunRef.current += 1;
    const renderRun = ++commandRenderRunRef.current;

    void renderCommandToBoard(
      generatedCommand,
      boardId,
      renderRun,
    ).catch((error) => {
      console.error(
        "Could not render whiteboard command:",
        error,
      );

      // Allow this version to retry if rendering failed.
      if (
        activeBoardIdRef.current === boardId &&
        completedCommandRenderRef.current[boardId] ===
          generatedCommandVersion
      ) {
        delete completedCommandRenderRef.current[boardId];
      }
    });

    return () => {
      if (commandRenderRunRef.current === renderRun) {
        commandRenderRunRef.current += 1;
      }
    };
  }, [
    generatedCommand,
    generatedCommandVersion,
    boardId,
    drawingCanvas,
    context,
    renderCommandToBoard,
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