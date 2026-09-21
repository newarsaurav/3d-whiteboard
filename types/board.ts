export type FlowchartNodeShape =
  | "rounded"
  | "diamond"
  | "circle";

export type FontFamily =
  | "sans-serif"
  | "serif"
  | "monospace"
  | "handwriting"
  | "cursive";

export const AVAILABLE_FONTS: Record<FontFamily, string> = {
  "sans-serif": '"Segoe UI", "Arial", sans-serif',
  "serif": '"Georgia", "Times New Roman", serif',
  "monospace": '"Courier New", monospace',
  "handwriting": '"Lixia Handwriting", "Comic Sans MS", cursive',
  "cursive": '"Brush Script MT", cursive',
};

export const DEFAULT_FONT: FontFamily = "sans-serif";

export interface BoardTextFormatting {
  backgroundColor?: string;
  titleColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

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
  formulas?: string[];
  note?: string;
  font?: FontFamily;
  formatting?: BoardTextFormatting;
  writingSpeed?: number;
  drawingSpeed?: number;
}

export interface TeacherLessonSegment {
  narration: string;
  board: BoardTextCommand;

  // Presentation gesture intent Mike performs while this segment is
  // narrated (from the @lixia/mike-animation gesture vocabulary,
  // e.g. "explain", "emphasize", "point"). Optional — the studio
  // falls back to a rotation of teaching gestures when absent.
  gesture?: string;
}

export interface TeacherLessonCommand {
  type: "teach_lesson";
  topic: string;
  language?: string;
  segments: TeacherLessonSegment[];
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

  // Doodle images are traced locally into actual marker strokes.
  // Realistic images stay as raster images.
  style?: "doodle" | "realistic";

  // Helps the router understand whether this came from a new image
  // request or an edit of the existing board image.
  mode: "create" | "edit";
}

export type BoardManagementAction =
  | "create"
  | "delete"
  | "clear"
  | "restore"
  | "select";

export interface BoardManagementCommand {
  type: "manage_board";
  action: BoardManagementAction;
  topic?: string;
  boardId?: number;
  boardName?: string;
  title?: string;
  bullets?: string[];
  formulas?: string[];
  note?: string;
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

  // Content saved by the most recent clear, available only on request.
  previousDrawing?: string | null;
  previousGeneratedCommand?: BoardCommand | null;

  // Structured AI command rendered by our own canvas code.
  // Images are returned as a BoardImageCommand and then painted
  // onto the same 1600x900 board canvas.
  generatedCommand: BoardCommand | null;
  generatedCommandVersion: number;
}