export type FlowchartNodeShape =
  | "rounded"
  | "diamond"
  | "circle";

export interface FlowchartNode {
  id: string;
  label: string;
  row: number;
  column: number;
  shape: FlowchartNodeShape;
}

export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
}

export interface BoardTextCommand {
  type: "write_text";
  title: string;
  bullets: string[];
  note?: string;
}

export interface BoardFlowchartCommand {
  type: "flowchart";
  title: string;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

export type BoardChartType =
  | "line"
  | "bar"
  | "pie";

export interface BoardChartSeries {
  key: string;
  label: string;
  unit?: string;
}

export interface BoardChartCommand {
  type: "chart";
  chartType: BoardChartType;
  title: string;
  subtitle?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  series: BoardChartSeries[];
  data: Array<Record<string, string | number>>;
  source?: string;
  fetchedAt?: string;
}

export interface BoardImageCommand {
  type: "image";
  title?: string;

  // Base64 data URL returned by Gemini Image.
  imageDataUrl: string;

  // Helps the router understand whether this came from a new image
  // request or an edit of the existing board image.
  mode: "create" | "edit";
}

export type BoardCommand =
  | BoardTextCommand
  | BoardFlowchartCommand
  | BoardChartCommand
  | BoardImageCommand;

export interface Board {
  id: number;
  name: string;

  // Final PNG snapshot of everything currently visible on the board.
  // This is also what Gemini can inspect for follow-up requests.
  drawing: string | null;

  // Structured AI command rendered by our own canvas code.
  // Images are returned as a BoardImageCommand and then painted
  // onto the same 1600x900 board canvas.
  generatedCommand: BoardCommand | null;
  generatedCommandVersion: number;
}