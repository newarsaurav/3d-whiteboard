import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { NextResponse } from "next/server";

import type {
  BoardChartCommand,
  BoardCommand,
  BoardFlowchartCommand,
  BoardImageCommand,
  BoardManagementCommand,
  BoardTextCommand,
  FontFamily,
  TeacherLessonCommand,
  FlowchartEdge,
  FlowchartNode,
} from "@/types/board";

export const runtime = "nodejs";

interface GeminiRequestBody {
  prompt?: unknown;
  boardImage?: unknown;
  currentCommand?: unknown;
  boards?: unknown;
}

interface GeocodingResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  country?: string;
  admin1?: string;
}

interface GeocodingResponse {
  results?: GeocodingResult[];
}

interface WeatherDaily {
  time?: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_mean?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
}

interface WeatherResponse {
  timezone?: string;
  daily?: WeatherDaily;
}

const MAX_PROMPT_LENGTH = 3000;
const MAX_CONTEXT_LENGTH = 18000;

const writeTextDeclaration: FunctionDeclaration = {
  name: "write_text",
  description:
    "Write concise key points on the whiteboard for a short factual answer or when the user explicitly asks for text only/on the board. For explanations, teaching, or help understanding a concept, use teach_lesson so the voice gives the fuller explanation while the board shows only the important points. For a follow-up edit to existing text, return the COMPLETE updated text content, not only the change.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short whiteboard title, ideally under 8 words.",
      },
      bullets: {
        type: "array",
        description:
          "Two to eight short teaching bullets. Keep each bullet concise enough to fit on a 1600x900 whiteboard.",
        items: {
          type: "string",
        },
      },
      formulas: {
        type: "array",
        description:
          "Optional important formulas/equations to show prominently on the board. Use symbolic notation such as a = Δv / Δt. Keep each formula short.",
        items: {
          type: "string",
        },
      },
      note: {
        type: "string",
        description:
          "Optional one-line takeaway, worked example, or important note.",
      },
      font: {
        type: "string",
        enum: ["sans-serif", "serif", "monospace", "handwriting", "cursive"],
        description:
          "Font family for the text. Default is sans-serif. Available fonts: sans-serif, serif, monospace, handwriting, cursive.",
      },
      backgroundColor: {
        type: "string",
        description: "Optional six-digit hex background color for the whole whiteboard, such as #fff7ed.",
      },
      titleColor: {
        type: "string",
        description: "Optional six-digit hex color for the title ONLY (e.g., #FF0000 for red). For coloring specific words within the title, use inline [color=#RRGGBB]markers[/color] in the title string instead.",
      },
      textColor: {
        type: "string",
        description: "Optional six-digit hex color for ALL bullets and notes (e.g., #0000FF for blue). For coloring specific words, use inline [color=#RRGGBB]markers[/color] in the text strings instead.",
      },
      bold: {
        type: "boolean",
        description: "Make ALL board text bold when true. For bolding specific words, use **inline markers** in the text strings instead.",
      },
      italic: {
        type: "boolean",
        description: "Make ALL board text italic when true. For italicizing specific words, use *inline markers* in the text strings instead.",
      },
      underline: {
        type: "boolean",
        description: "Underline ALL board text when true. For underlining specific words, use __inline markers__ in the text strings instead.",
      },
      writingSpeed: {
        type: "number",
        description: "Optional writing animation speed from 10 (slow) to 100 (fast).",
      },
      drawingSpeed: {
        type: "number",
        description: "Optional drawing animation speed from 10 (slow) to 100 (fast).",
      },
    },
    required: ["title", "bullets"],
  },
};

const manageBoardDeclaration: FunctionDeclaration = {
  name: "manage_board",
  description:
    "Manage whiteboard tabs when the user asks to create/add a new board, open/select a specific board, delete/remove the current board, clear the current board, or restore content cleared earlier. Use restore for requests such as redo that board, bring it back, undo the clear, or restore what was there before. For create, include concise initial board content about the requested topic. For select, use the matching boardId or boardName from the available board list.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "select", "delete", "clear", "restore"],
        description: "The board management action to perform.",
      },
      boardId: {
        type: "number",
        description: "ID of an existing board to select.",
      },
      boardName: {
        type: "string",
        description: "Exact name of an existing board to select.",
      },
      topic: {
        type: "string",
        description: "Topic for a newly created board.",
      },
      title: {
        type: "string",
        description: "Short initial title for a newly created board.",
      },
      bullets: {
        type: "array",
        description: "Up to eight concise initial teaching bullets for a new board.",
        items: { type: "string" },
      },
      formulas: {
        type: "array",
        description: "Optional initial formulas for a new board.",
        items: { type: "string" },
      },
      note: {
        type: "string",
        description: "Optional initial note for a new board.",
      },
    },
    required: ["action"],
  },
};

const teachLessonDeclaration: FunctionDeclaration = {
  name: "teach_lesson",
  description:
    "Teach a concept like a real teacher: speak a detailed but clear explanation while progressively updating the whiteboard with definitions, formulas, and examples. Use when the user asks to explain, teach, walk through, or help them understand a concept in some depth. Do not use for a simple one-line factual answer.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Short lesson topic.",
      },
      language: {
        type: "string",
        description:
          "BCP-47 language code for narration, for example en-US. Match the user's language when practical.",
      },
      segments: {
        type: "array",
        description:
          "Two to six sequential teaching segments. Each segment contains fuller natural spoken narration for the teacher's explanation and the COMPLETE cumulative board state containing only the important points visible while that narration is spoken.",
        items: {
          type: "object",
          properties: {
            narration: {
              type: "string",
              description:
                "Natural teacher-style speech, usually 2-5 sentences. Explain the idea, connect it to the board points, and use a simple example when useful. Do not merely read the board word-for-word. Explain symbols in spoken words instead of reading raw notation awkwardly.",
            },
            boardTitle: {
              type: "string",
              description: "Short title currently visible on the board.",
            },
            boardBullets: {
              type: "array",
              description:
                "Complete cumulative list of only the important short points visible at this point in the lesson. Keep the board concise; put the fuller explanation in narration.",
              items: { type: "string" },
            },
            formulas: {
              type: "array",
              description:
                "Complete cumulative list of important formulas visible at this point, using compact mathematical notation.",
              items: { type: "string" },
            },
            note: {
              type: "string",
              description:
                "Optional worked example, key takeaway, or short teacher note visible on the board.",
            },
              backgroundColor: { type: "string", description: "Optional six-digit hex background color." },
              titleColor: { type: "string", description: "Optional six-digit hex title color." },
              textColor: { type: "string", description: "Optional six-digit hex bullet and note color." },
              bold: { type: "boolean", description: "Make board text bold." },
              italic: { type: "boolean", description: "Make board text italic." },
              underline: { type: "boolean", description: "Underline board text." },
              writingSpeed: { type: "number", description: "Writing speed from 10 (slow) to 100 (fast)." },
              drawingSpeed: { type: "number", description: "Drawing speed from 10 (slow) to 100 (fast)." },
            gesture: {
              type: "string",
              enum: [
                "continue",
                "wave",
                "goodbye",
                "talk",
                "point",
                "think",
                "agree",
                "disagree",
                "explain",
                "emphasize",
                "thanks",
                "welcome",
                "offer",
                "uncertain",
                "idea",
                "approve",
                "next",
                "listen",
                "confused",
                "ready",
                "reveal",
                "contrast",
                "together",
              ],
              description:
                "Body gesture Mike performs while speaking this segment. Pick the one matching the narration's intent: 'welcome' or 'ready' to open a lesson, 'explain' for how something works, 'emphasize' for key points, 'point' when directing attention to the board, 'reveal' for results, 'contrast' for however/alternatives, 'next' when moving to a new part, 'approve' for praise, 'goodbye' to close. Use 'continue' when no distinct gesture fits.",
            },
          },
          required: ["narration", "boardTitle", "boardBullets"],
        },
      },
    },
    required: ["topic", "segments"],
  },
};

const drawFlowchartDeclaration: FunctionDeclaration = {
  name: "draw_flowchart",
  description:
    "Create or update a flowchart/process diagram on the whiteboard. Return the COMPLETE flowchart. Place nodes on a simple row/column grid so the app can render clean shapes and arrows itself.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short flowchart title.",
      },
      nodes: {
        type: "array",
        description:
          "Flowchart nodes. Use rows 0-5 and columns 0-3. Avoid placing two nodes in the same row and column unless absolutely necessary.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Short unique node id such as start, login, valid.",
            },
            label: {
              type: "string",
              description: "Short text shown inside the node.",
            },
            row: {
              type: "number",
              description: "Grid row from 0 to 5.",
            },
            column: {
              type: "number",
              description: "Grid column from 0 to 3.",
            },
            shape: {
              type: "string",
              description:
                "Node shape: rounded for normal steps, diamond for decisions, circle for compact start/end nodes.",
            },
          },
          required: ["id", "label", "row", "column", "shape"],
        },
      },
      edges: {
        type: "array",
        description: "Directed arrows connecting node ids.",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Source node id.",
            },
            to: {
              type: "string",
              description: "Destination node id.",
            },
            label: {
              type: "string",
              description: "Optional short arrow label such as Yes or No.",
            },
          },
          required: ["from", "to"],
        },
      },
    },
    required: ["title", "nodes", "edges"],
  },
};

const plotWeatherHistoryDeclaration: FunctionDeclaration = {
  name: "plot_weather_history",
  description:
    "Fetch REAL recent weather data and plot it on the whiteboard. Use this whenever the user asks for historical/recent temperature, precipitation, or wind data for a real place. Never invent weather values.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description:
          "Place name to look up, for example Kathmandu, Nepal or Pokhara.",
      },
      days: {
        type: "number",
        description:
          "Number of calendar days ending today, usually 2-30. Example: last 10 days means 10.",
      },
      metric: {
        type: "string",
        description:
          "One of: temperature, precipitation, wind_speed.",
      },
      chartType: {
        type: "string",
        description:
          "One of: line or bar. Prefer line for temperature/wind trends and bar for precipitation unless the user explicitly asks otherwise.",
      },
    },
    required: ["location", "days", "metric", "chartType"],
  },
};


const generateImageDeclaration: FunctionDeclaration = {
  name: "generate_image",
  description:
    "Generate a new image for the whiteboard. By default, make it look like a hand-drawn whiteboard doodle or marker sketch. Only make it realistic/photo-like when the user explicitly asks for realistic, photo, or photorealistic style. Use this for requests such as draw/show/create/generate a cat, dog, person, object, scene, or other visual that should be an image rather than a flowchart or simple text answer.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A self-contained image-generation prompt describing exactly what should appear. Preserve important details from the user's request.",
      },
      title: {
        type: "string",
        description:
          "Optional short title describing the generated image. Do not invent a title when none is useful.",
      },
    },
    required: ["prompt"],
  },
};

const editBoardImageDeclaration: FunctionDeclaration = {
  name: "edit_board_image",
  description:
    "Edit the CURRENT visible whiteboard image. By default, preserve or create a hand-drawn whiteboard doodle/marker-sketch look unless the user explicitly asks for realistic/photo style. Use this for visual follow-ups such as add a dog beside that cat, remove the tree, change its color, make the cat bigger, move it left, or otherwise modify an image already on the board. Preserve everything the user did not ask to change.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description:
          "A precise edit instruction. State what to change and explicitly preserve unrelated existing board content.",
      },
      title: {
        type: "string",
        description:
          "Optional short title for the edited image/scene.",
      },
    },
    required: ["instruction"],
  },
};

function readBoardImage(dataUrl: string): Part | null {
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/,
  );

  if (!match) {
    return null;
  }

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2],
    },
  };
}

function readString(
  value: unknown,
  fallback = "",
  maxLength = 220,
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function readNumber(
  value: unknown,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readTextFormatting(
  args: Record<string, unknown>,
): BoardTextCommand["formatting"] {
  const hexColor = (value: unknown): string | undefined => {
    const color = readString(value, "", 7);
    return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
  };

  const formatting = {
    ...(hexColor(args.backgroundColor) ? { backgroundColor: hexColor(args.backgroundColor) } : {}),
    ...(hexColor(args.titleColor) ? { titleColor: hexColor(args.titleColor) } : {}),
    ...(hexColor(args.textColor) ? { textColor: hexColor(args.textColor) } : {}),
    ...(args.bold === true ? { bold: true } : {}),
    ...(args.italic === true ? { italic: true } : {}),
    ...(args.underline === true ? { underline: true } : {}),
  };

  return Object.keys(formatting).length > 0 ? formatting : undefined;
}

function readSpeed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(10, value)))
    : undefined;
}

function buildTextCommand(
  args: Record<string, unknown>,
): BoardTextCommand {
  const title = readString(args.title, "Lixia", 90);

  const bullets = Array.isArray(args.bullets)
    ? args.bullets
        .map((item) => readString(item, "", 190))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const formulas = Array.isArray(args.formulas)
    ? args.formulas
        .map((item) => readString(item, "", 120))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const note = readString(args.note, "", 220);

  const rawFont = readString(args.font, "", 20).toLowerCase();
  const validFonts: FontFamily[] = ["sans-serif", "serif", "monospace", "handwriting", "cursive"];
  const font = validFonts.includes(rawFont as FontFamily)
    ? (rawFont as FontFamily)
    : undefined;

  const formatting = readTextFormatting(args);

  return {
    type: "write_text",
    title,
    bullets:
      bullets.length > 0
        ? bullets
        : ["No whiteboard content was returned."],
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(note ? { note } : {}),
    ...(font ? { font } : {}),
    ...(formatting ? { formatting } : {}),
    ...(readSpeed(args.writingSpeed) !== undefined ? { writingSpeed: readSpeed(args.writingSpeed) } : {}),
    ...(readSpeed(args.drawingSpeed) !== undefined ? { drawingSpeed: readSpeed(args.drawingSpeed) } : {}),
  };
}

function buildTeacherLessonCommand(
  args: Record<string, unknown>,
): TeacherLessonCommand {
  const topic = readString(args.topic, "Lesson", 90);
  const language = readString(args.language, "en-US", 24);
  const rawSegments = Array.isArray(args.segments)
    ? args.segments
    : [];

  const segments = rawSegments
    .slice(0, 6)
    .map((rawSegment, index) => {
      const segment =
        rawSegment && typeof rawSegment === "object"
          ? (rawSegment as Record<string, unknown>)
          : {};

      const narration = readString(
        segment.narration,
        "",
        900,
      );

      const bullets = Array.isArray(segment.boardBullets)
        ? segment.boardBullets
            .map((item) => readString(item, "", 180))
            .filter(Boolean)
            .slice(0, 7)
        : [];

      const formulas = Array.isArray(segment.formulas)
        ? segment.formulas
            .map((item) => readString(item, "", 120))
            .filter(Boolean)
            .slice(0, 4)
        : [];

      const note = readString(segment.note, "", 220);
      const formatting = readTextFormatting(segment);

      const gesture = readString(segment.gesture, "", 24)
        .toLowerCase();

      return {
        narration,
        ...(gesture ? { gesture } : {}),
        board: {
          type: "write_text" as const,
          title: readString(
            segment.boardTitle,
            topic,
            90,
          ),
          bullets:
            bullets.length > 0
              ? bullets
              : [
                  index === 0
                    ? "Introduction to " + topic
                    : "Continue learning " + topic,
                ],
          ...(formulas.length > 0 ? { formulas } : {}),
          ...(note ? { note } : {}),
          ...(formatting ? { formatting } : {}),
          ...(readSpeed(segment.writingSpeed) !== undefined ? { writingSpeed: readSpeed(segment.writingSpeed) } : {}),
          ...(readSpeed(segment.drawingSpeed) !== undefined ? { drawingSpeed: readSpeed(segment.drawingSpeed) } : {}),
        },
      };
    })
    .filter((segment) => segment.narration.length > 0);

  if (segments.length === 0) {
    throw new Error("Gemini returned an empty teaching lesson.");
  }

  return {
    type: "teach_lesson",
    topic,
    ...(language ? { language } : {}),
    segments,
  };
}

function buildFlowchartCommand(
  args: Record<string, unknown>,
): BoardFlowchartCommand {
  const rawNodes = Array.isArray(args.nodes)
    ? args.nodes
    : [];

  const seenIds = new Set<string>();

  const nodes: FlowchartNode[] = [];

  for (let index = 0; index < rawNodes.length && nodes.length < 10; index += 1) {
    const rawNode = rawNodes[index];

    if (!rawNode || typeof rawNode !== "object") {
      continue;
    }

    const node = rawNode as Record<string, unknown>;

    let id = readString(node.id, `node-${index + 1}`, 36)
      .replace(/[^a-zA-Z0-9_-]/g, "-");

    if (!id) {
      id = `node-${index + 1}`;
    }

    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }

    seenIds.add(id);

    const rawShape = readString(node.shape, "rounded", 20).toLowerCase();
    const shape =
      rawShape === "diamond" || rawShape === "circle"
        ? rawShape
        : "rounded";

    nodes.push({
      id,
      label: readString(node.label, `Step ${index + 1}`, 90),
      row: Math.round(clamp(readNumber(node.row, index), 0, 5)),
      column: Math.round(clamp(readNumber(node.column, 1), 0, 3)),
      shape,
    });
  }

  const validIds = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(args.edges)
    ? args.edges
    : [];

  const edges: FlowchartEdge[] = rawEdges
    .map((rawEdge) => {
      if (!rawEdge || typeof rawEdge !== "object") {
        return null;
      }

      const edge = rawEdge as Record<string, unknown>;
      const from = readString(edge.from, "", 36);
      const to = readString(edge.to, "", 36);
      const label = readString(edge.label, "", 28);

      if (!validIds.has(from) || !validIds.has(to) || from === to) {
        return null;
      }

      return {
        from,
        to,
        ...(label ? { label } : {}),
      } satisfies FlowchartEdge;
    })
    .filter((edge): edge is FlowchartEdge => edge !== null)
    .slice(0, 16);

  return {
    type: "flowchart",
    title: readString(args.title, "Flowchart", 90),
    nodes,
    edges,
  };
}

function getDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return new Date().toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function subtractIsoDays(isoDate: string, amount: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() - amount);

  return date.toISOString().slice(0, 10);
}

function formatDayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

async function geocodeLocation(location: string): Promise<Required<Pick<GeocodingResult, "name" | "latitude" | "longitude">> & GeocodingResult> {
  const url = new URL(
    "https://geocoding-api.open-meteo.com/v1/search",
  );

  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Could not look up that location.");
  }

  const data = (await response.json()) as GeocodingResponse;
  const result = data.results?.[0];

  if (
    !result ||
    typeof result.name !== "string" ||
    typeof result.latitude !== "number" ||
    typeof result.longitude !== "number"
  ) {
    throw new Error(`Could not find a location matching "${location}".`);
  }

  return {
    ...result,
    name: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

function valueAt(
  values: Array<number | null> | undefined,
  index: number,
): number | null {
  const value = values?.[index];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

async function buildWeatherChart(
  args: Record<string, unknown>,
): Promise<BoardChartCommand> {
  const locationQuery = readString(args.location, "", 120);

  if (!locationQuery) {
    throw new Error("Weather chart requires a location.");
  }

  const days = Math.round(
    clamp(readNumber(args.days, 10), 2, 30),
  );

  const rawMetric = readString(args.metric, "temperature", 30).toLowerCase();
  const metric =
    rawMetric === "precipitation" || rawMetric === "wind_speed"
      ? rawMetric
      : "temperature";

  const rawChartType = readString(args.chartType, "line", 20).toLowerCase();
  const chartType = rawChartType === "bar" ? "bar" : "line";

  const location = await geocodeLocation(locationQuery);
  const timeZone = location.timezone || "UTC";
  const endDate = getDateInTimeZone(timeZone);
  const startDate = subtractIsoDays(endDate, days - 1);

  const dailyVariables =
    metric === "temperature"
      ? "temperature_2m_max,temperature_2m_mean,temperature_2m_min"
      : metric === "precipitation"
        ? "precipitation_sum"
        : "wind_speed_10m_max";

  const weatherUrl = new URL(
    "https://api.open-meteo.com/v1/forecast",
  );

  weatherUrl.searchParams.set("latitude", String(location.latitude));
  weatherUrl.searchParams.set("longitude", String(location.longitude));
  weatherUrl.searchParams.set("daily", dailyVariables);
  weatherUrl.searchParams.set("timezone", "auto");
  weatherUrl.searchParams.set("start_date", startDate);
  weatherUrl.searchParams.set("end_date", endDate);

  const weatherResponse = await fetch(weatherUrl, {
    cache: "no-store",
  });

  if (!weatherResponse.ok) {
    throw new Error("Open-Meteo could not return weather data.");
  }

  const weather = (await weatherResponse.json()) as WeatherResponse;
  const dates = weather.daily?.time ?? [];

  if (dates.length === 0) {
    throw new Error("No weather data was returned for that period.");
  }

  const placeParts = [location.name, location.admin1, location.country]
    .filter((value, index, array) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      array.indexOf(value) === index,
    ) as string[];

  const placeLabel = placeParts.join(", ");

  let series: BoardChartCommand["series"];
  let title: string;
  let yAxisLabel: string;
  let preferredChartType: "line" | "bar" = chartType;

  if (metric === "temperature") {
    title = `${placeLabel} temperature — last ${days} days`;
    yAxisLabel = "Temperature (°C)";
    series = [
      { key: "max", label: "Max", unit: "°C" },
      { key: "mean", label: "Mean", unit: "°C" },
      { key: "min", label: "Min", unit: "°C" },
    ];
  } else if (metric === "precipitation") {
    title = `${placeLabel} precipitation — last ${days} days`;
    yAxisLabel = "Precipitation (mm)";
    preferredChartType = rawChartType === "line" ? "line" : "bar";
    series = [
      { key: "precipitation", label: "Precipitation", unit: "mm" },
    ];
  } else {
    title = `${placeLabel} wind speed — last ${days} days`;
    yAxisLabel = "Max wind speed (km/h)";
    series = [
      { key: "wind", label: "Max wind", unit: "km/h" },
    ];
  }

  const data: Array<Record<string, string | number>> = [];

  dates.forEach((date, index) => {
    const row: Record<string, string | number> = {
      label: formatDayLabel(date),
      date,
    };

    if (metric === "temperature") {
      const max = valueAt(weather.daily?.temperature_2m_max, index);
      const mean = valueAt(weather.daily?.temperature_2m_mean, index);
      const min = valueAt(weather.daily?.temperature_2m_min, index);

      if (max !== null) row.max = max;
      if (mean !== null) row.mean = mean;
      if (min !== null) row.min = min;
    } else if (metric === "precipitation") {
      const precipitation = valueAt(weather.daily?.precipitation_sum, index);
      if (precipitation !== null) row.precipitation = precipitation;
    } else {
      const wind = valueAt(weather.daily?.wind_speed_10m_max, index);
      if (wind !== null) row.wind = wind;
    }

    data.push(row);
  });

  return {
    type: "chart",
    chartType: preferredChartType,
    title,
    subtitle: `${startDate} to ${endDate} • ${weather.timezone || timeZone}`,
    xAxisLabel: "Date",
    yAxisLabel,
    series,
    data,
    source: "Open-Meteo",
    fetchedAt: new Date().toISOString(),
  };
}

function requestNeedsRealisticImage(text: string): boolean {
  const normalized = text.toLowerCase();

  const realisticMarkers = [
    "realistic",
    "photo",
    "photorealistic",
    "photographic",
    "lifelike",
    "3d render",
    "highly detailed",
  ];

  return realisticMarkers.some((marker) =>
    normalized.includes(marker),
  );
}

async function buildImageCommand(
  ai: GoogleGenAI,
  args: Record<string, unknown>,
  mode: "create" | "edit",
  boardImagePart: Part | null,
  currentCommandValue: unknown,
): Promise<BoardImageCommand> {
  const title = readString(args.title, "", 90);

  const requestedText =
    mode === "edit"
      ? readString(args.instruction, "", 1200)
      : readString(args.prompt, "", 1200);

  if (!requestedText) {
    throw new Error(
      mode === "edit"
        ? "Image edit requires an instruction."
        : "Image generation requires a prompt.",
    );
  }

  const currentCommand =
    currentCommandValue && typeof currentCommandValue === "object"
      ? (currentCommandValue as Record<string, unknown>)
      : null;

  const currentStyle =
    currentCommand?.type === "image" &&
    currentCommand.style === "realistic"
      ? "realistic"
      : currentCommand?.type === "image" &&
          currentCommand.style === "doodle"
        ? "doodle"
        : null;

  const prefersRealistic =
    requestNeedsRealisticImage(requestedText) ||
    (mode === "edit" && currentStyle === "realistic");

  if (mode === "edit" && !boardImagePart) {
    throw new Error(
      "I need the current board image before I can edit it. Please try the edit again.",
    );
  }

  const styleInstructions = prefersRealistic
    ? [
        "Style: realistic / photo-like.",
        "Render the subject convincingly with natural form and detail.",
      ].join("\n")
    : [
        "Style: simple classroom whiteboard marker drawing.",
        "Use bold clean dark marker outlines with a transparent background, like an isolated PNG sticker.",
        "Prioritize a clear recognizable silhouette first, then add only a few important interior details.",
        "Make cartoon characters and animals easy to recognize from a distance.",
        "Use loose hand-drawn contours with occasional retraced lines, small overshoots, and slight wobble.",
        "Keep the drawing simple and readable: avoid tiny details, clutter, dense hatching, or broken fragmented lines.",
        "Do not use gradients, shadows, photographic texture, or large filled areas.",
        "Never draw a background, floor, sky, scenery, setting, or white rectangle.",
        "Do not add text, labels, borders, watermarks, or a poster-like layout.",
        "The final result should look like a teacher quickly sketched it with a black dry-erase marker.",
      ].join("\n");

  const imageInstructions =
    mode === "edit"
      ? `
Edit the attached current whiteboard image according to this instruction:
${requestedText}

${styleInstructions}

Rules:
- Preserve every existing element that the user did NOT ask to change.
- Add only the requested new element; do not redraw the whole existing picture.
- Keep the same overall 16:9 whiteboard composition.
- Do not replace, restyle, or distort unrelated content.
- If adding an object, place it naturally without covering important existing content.
- Keep all empty areas transparent; do not add a background or white rectangle.
- If the current board already looks hand-drawn, continue in the same whiteboard-doodle style unless the user explicitly asks for realistic style.
- Do not add new text, labels, borders, watermarks, or captions unless explicitly requested.
- Return only the edited image.
      `.trim()
      : `
Create an image for display on a 16:9 interactive teaching whiteboard.

User request:
${requestedText}

${styleInstructions}

Rules:
- Compose the subject clearly with comfortable margins so it looks good on a whiteboard.
- Keep the subject large enough and visually simple enough to remain recognizable after whiteboard rendering.
- Avoid unnecessary text, labels, frames, watermarks, or captions.
- Always draw only the requested subject as an isolated PNG-like doodle with a transparent background. Do not add scenery, ground, sky, shadows, props, or decorative background elements.
- Include a background or setting only when the user's request explicitly names one, and then show only the requested subject together with that requested background.
- Return only the generated image.
      `.trim();

  const imageParts: Part[] = [{ text: imageInstructions }];

  if (mode === "edit" && boardImagePart) {
    imageParts.push(boardImagePart);
  }

  const imageResponse = await ai.models.generateContent({
    model: prefersRealistic
      ? process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image"
      : process.env.GEMINI_DOODLE_MODEL ?? "gemini-3.1-flash-lite-image",
    contents: [
      {
        role: "user",
        parts: imageParts,
      },
    ],
    config: {
      responseModalities: ["IMAGE"],
      // `responseFormat` is not part of GenerateContentConfig in
      // @google/genai; aspect ratio goes through imageConfig.
      imageConfig: {
        aspectRatio: "16:9",
      },
    },
  });

  const responseParts =
    imageResponse.candidates?.[0]?.content?.parts ?? [];

  const generatedImagePart = responseParts.find(
    (part) =>
      typeof part.inlineData?.data === "string" &&
      part.inlineData.data.length > 0,
  );

  const imageData = generatedImagePart?.inlineData?.data;

  if (!imageData) {
    throw new Error(
      "The image model did not return an image.",
    );
  }

  const mimeType =
    generatedImagePart?.inlineData?.mimeType ||
    "image/png";

  return {
    type: "image",
    ...(title ? { title } : {}),
    imageDataUrl: `data:${mimeType};base64,${imageData}`,
    style: prefersRealistic ? "realistic" : "doodle",
    mode,
  };
}

function serializeCurrentCommand(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "(none)";
  }

  const command = value as Record<string, unknown>;

  // Never send the generated image's base64 data back inside textual
  // structured context. The current board screenshot is attached
  // separately when a visual follow-up needs it.
  if (command.type === "image") {
    return JSON.stringify({
      type: "image",
      title:
        typeof command.title === "string"
          ? command.title.slice(0, 90)
          : undefined,
      mode: command.mode,
      style: command.style,
      note:
        "The current board contains an AI-generated image. Inspect the attached board screenshot for visual details when it is provided.",
    });
  }

  try {
    return JSON.stringify(value).slice(0, MAX_CONTEXT_LENGTH);
  } catch {
    return "(none)";
  }
}

function serializeBoards(value: unknown): string {
  if (!Array.isArray(value)) {
    return "(none)";
  }

  const boards = value
    .filter((board): board is Record<string, unknown> =>
      Boolean(board && typeof board === "object"),
    )
    .map((board) => ({
      id: readNumber(board.id, 0),
      name: readString(board.name, "", 120),
      content: readString(board.searchText, "", 1200),
    }))
    .filter((board) => board.id > 0 && board.name);

  return boards.length > 0 ? JSON.stringify(boards) : "(none)";
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is missing from .env.local." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as GeminiRequestBody;

    const prompt =
      typeof body.prompt === "string"
        ? body.prompt.trim()
        : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "Please enter a prompt." },
        { status: 400 },
      );
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return NextResponse.json(
        {
          error: `The prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }

    const boardImage =
      typeof body.boardImage === "string"
        ? body.boardImage
        : "";

    const boardImagePart = boardImage
      ? readBoardImage(boardImage)
      : null;

    const currentCommandValue = body.currentCommand;
    const boards = serializeBoards(body.boards);

    const currentCommand = serializeCurrentCommand(
      currentCommandValue,
    );

    const routerInstructions = `
You are the fast tool router for Lixia, an interactive teaching whiteboard.

You MUST call exactly one available function.
Do not answer with normal prose.

ROUTING RULES:
- teach_lesson: any request to explain, teach, learn, understand, walk through, define a concept, solve a problem, or give a lesson. The voice must give the fuller teacher-style explanation and the board must progressively show only the important points, definitions, formulas, and examples.
- Use teach_lesson by default for educational questions, even when the user asks a short definition, unless they explicitly ask for a brief answer, text only, or board-only response.
- write_text: short direct answers or concise key points when the user explicitly wants a brief answer, text only, or board-only content. Do not use it for a teaching explanation when narration would help.
- draw_flowchart: flowcharts, workflows, processes, decision trees, sequences with arrows.
- plot_weather_history: REAL recent weather graphs/charts for a real location. This tool fetches live/recent Open-Meteo data, so never invent weather numbers yourself.
- generate_image: create a NEW visual such as a cat, dog, car, person, object, landscape, or scene. By default, this should look like a hand-drawn whiteboard doodle/marker sketch unless the user explicitly asks for realistic/photo style.
- edit_board_image: modify a visual already visible on the board, including a specific part of it, for example "change the leaf", "make the flower petals red", "add a dog beside that cat", "remove the tree", or "make the cat bigger". Use this for any follow-up that says change, edit, remove, add to, recolor, resize, move, or otherwise adjust something in the existing drawing. By default, preserve or continue a hand-drawn whiteboard doodle style unless the user explicitly asks for realistic/photo style.
- manage_board: create/add a new board, select/open an existing board, delete/remove the current board, clear the current board, or restore content cleared earlier. Use restore when the user says redo, bring it back, undo the clear, or restore what was there before. For select, match the user's requested board by its name, ID, or content in the available board list, then return that board's boardId. For create, include concise initial content in the same tool call.

BOARD CONTEXT:
- The current structured board content is included below.
- A current board screenshot may also be attached for follow-up context.
- When a current board screenshot is attached, inspect it before answering. Pay attention to the user's hand-drawn circles, underlines, highlights, arrows, marks, and the object or text those marks point to. If the user asks what is inside, what something is, or what they pointed to, answer from the attached board image rather than guessing from structured text alone.
- If the user says "it", "that", "this chart", "add", "change", "remove", "make it a bar chart", etc., use the existing board context and return the COMPLETE updated content through the appropriate tool.
- For a follow-up that refers to an object or part of an existing image (for example "change the leaf" after drawing a flower), always use edit_board_image and keep the edit on the current board. Do not use generate_image for that follow-up.
- If the user asks a clearly unrelated new question, replace the old topic with the new content.
- Keep whiteboard content concise and readable.
- For flowcharts, use row 0-5 and column 0-3 and avoid overlapping grid positions.
- For weather requests such as "KTM", normalize the location to a geocodable place name such as "Kathmandu, Nepal" when you are confident.
- "last 10 days till today" means days=10.
- For object/animal/person drawings, NEVER fake them with text, SVG, or a flowchart. Use generate_image or edit_board_image.
- Default image style should be a whiteboard doodle / marker sketch. Only choose realistic/photo style when the user clearly asks for it.
- Use edit_board_image only when the request refers to visual content already on the current board.
- For teach_lesson, make every segment board state cumulative: later segments must keep useful content/formulas from earlier segments while adding the next idea.
- Keep teach_lesson narration conversational and substantially more detailed than the board. The voice should explain reasoning and examples like a teacher, not read the board word-for-word. The board is a concise visual summary containing only important information.
- Keep each lesson board segment to roughly 3-6 short bullets plus only the most important formulas or note. Put supporting detail, transitions, and examples in narration.
- For formulas, put symbolic notation on the board, but phrase the narration naturally. Example: board shows "a = Δv / Δt" while narration says "acceleration equals change in velocity divided by change in time."
- Prefer 3-5 lesson segments so the learner sees the board develop step by step.
- For teach_lesson, give every segment a gesture that matches its narration. Vary the gestures across the lesson: typically open with welcome/ready, use explain/point/emphasize in the middle, and end with approve/goodbye. Do not repeat the same gesture in consecutive segments unless it clearly fits.

FONT MANAGEMENT:
- Default font is "sans-serif" - a clean, modern font suitable for most content.
- When the user asks to change the font, use the "font" parameter in write_text with one of these options:
  * "sans-serif" - Clean, modern, default font (Segoe UI, Arial)
  * "serif" - Traditional, formal font (Georgia, Times New Roman)
  * "monospace" - Fixed-width font for code or technical content (Courier New)
  * "handwriting" - Playful, handwritten style (Lixia Handwriting, Comic Sans MS)
  * "cursive" - Elegant, flowing script font (Brush Script MT)
- When changing fonts, return the complete updated board content with all existing text and the new font applied.
- If the user asks what fonts are available, use write_text to show them this list.

TEXT FORMATTING AND COLORS:
- SELECTIVE/PARTIAL FORMATTING: When the user asks to format specific words, phrases, or parts (e.g., "underline the title", "color the word 'gold' red", "italicize some bullets"), use INLINE formatting markers within the text strings:
  * **bold text** for bold
  * *italic text* for italic
  * __underlined text__ for underline
  * [color=#RRGGBB]colored text[/color] for colors (use six-digit hex, e.g., #FF0000 for red)
  * Examples: "__What is Gold__" or "[color=#FF0000]important[/color]"
  * DO NOT use the global titleColor, textColor, or formatting boolean parameters for selective formatting.
- UNIFORM/FULL-BOARD FORMATTING: When the user asks to format ALL text uniformly (e.g., "make everything bold", "make the entire board italic"), use the global parameters:
  * bold, italic, underline boolean flags apply to all board text
  * backgroundColor applies to the entire board background
  * titleColor applies to the title only
  * textColor applies to all bullets and notes
- Always embed inline formatting markers directly in the text (title, bullets, formulas, note) when doing selective formatting.
- For follow-up formatting requests, return the complete updated content and preserve existing formatting and colors unless the user asks to replace them.

ANIMATION SPEED:
- Users can control how quickly Lixia writes or draws through prompts. Set writingSpeed and/or drawingSpeed from 10 (slow) to 100 (fast).
- Interpret slow, slowly, deliberate, and careful as lower values; fast, quickly, rapid, and hurry as higher values.
- When the user changes only speed, return the complete current board content and preserve its formatting, colors, and text.

Current structured board content:
${currentCommand}

Available boards:
${boards}

User request:
${prompt}
    `.trim();

    const parts: Part[] = [];

    if (boardImagePart) {
      parts.push(boardImagePart);
    }

    parts.push({ text: routerInstructions });

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model:
        process.env.GEMINI_MODEL ??
        "gemini-3.5-flash-lite",
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      config: {
        temperature: 0.1,
        tools: [
          {
            functionDeclarations: [
              writeTextDeclaration,
              manageBoardDeclaration,
              teachLessonDeclaration,
              drawFlowchartDeclaration,
              plotWeatherHistoryDeclaration,
              generateImageDeclaration,
              editBoardImageDeclaration,
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
          },
        },
      },
    });

    const functionCall = response.functionCalls?.[0];

    if (!functionCall) {
      const fallbackText = response.text?.trim();

      if (fallbackText) {
        const command: BoardTextCommand = {
          type: "write_text",
          title: "Lixia",
          bullets: [fallbackText.slice(0, 600)],
        };

        return NextResponse.json({
          tool: "write_text",
          command,
        });
      }

      return NextResponse.json(
        { error: "Gemini did not choose a whiteboard tool." },
        { status: 502 },
      );
    }

    const args =
      functionCall.args && typeof functionCall.args === "object"
        ? (functionCall.args as Record<string, unknown>)
        : {};

    const isAdditiveImageRequest =
      Boolean(boardImagePart) &&
      /\b(add|place|put|include|beside|next to|alongside)\b/i.test(prompt);

    const shouldEditExistingImage =
      functionCall.name === "edit_board_image" ||
      (functionCall.name === "generate_image" && isAdditiveImageRequest);

    const imageEditArgs =
      functionCall.name === "generate_image" && isAdditiveImageRequest
        ? {
            ...args,
            instruction: readString(args.prompt, prompt, 1200),
          }
        : args;

    let command: BoardCommand | TeacherLessonCommand | BoardManagementCommand;

    if (functionCall.name === "manage_board") {
      const action = readString(args.action, "", 20);

      if (
        action !== "create" &&
        action !== "select" &&
        action !== "delete" &&
        action !== "clear" &&
        action !== "restore"
      ) {
        throw new Error("Gemini returned an invalid board management action.");
      }

      command = {
        type: "manage_board",
        action,
        ...(readString(args.topic, "", 120)
          ? { topic: readString(args.topic, "", 120) }
          : {}),
        ...(action === "select"
          ? {
              ...(readNumber(args.boardId, 0) > 0
                ? { boardId: readNumber(args.boardId, 0) }
                : {}),
              ...(readString(args.boardName, "", 120)
                ? { boardName: readString(args.boardName, "", 120) }
                : {}),
            }
          : {}),
        ...(action === "create"
          ? {
              title: readString(args.title, "New board", 90),
              bullets: Array.isArray(args.bullets)
                ? args.bullets
                    .map((bullet) => readString(bullet, "", 180))
                    .filter(Boolean)
                    .slice(0, 8)
                : [],
              ...(Array.isArray(args.formulas)
                ? {
                    formulas: args.formulas
                      .map((formula) => readString(formula, "", 120))
                      .filter(Boolean)
                      .slice(0, 4),
                  }
                : {}),
              ...(readString(args.note, "", 240)
                ? { note: readString(args.note, "", 240) }
                : {}),
            }
          : {}),
      };
    } else if (functionCall.name === "write_text") {
      command = buildTextCommand(args);
    } else if (functionCall.name === "teach_lesson") {
      command = buildTeacherLessonCommand(args);
    } else if (functionCall.name === "draw_flowchart") {
      command = buildFlowchartCommand(args);
    } else if (functionCall.name === "plot_weather_history") {
      command = await buildWeatherChart(args);
    } else if (functionCall.name === "generate_image" && !shouldEditExistingImage) {
      command = await buildImageCommand(
        ai,
        args,
        "create",
        null,
        currentCommandValue,
      );
    } else if (shouldEditExistingImage) {
      command = await buildImageCommand(
        ai,
        imageEditArgs,
        "edit",
        boardImagePart,
        currentCommandValue,
      );
    } else {
      return NextResponse.json(
        { error: `Unsupported Gemini tool: ${functionCall.name}` },
        { status: 502 },
      );
    }

    if (command.type === "manage_board") {
      return NextResponse.json({
        tool: functionCall.name,
        management: command,
      });
    }

    return NextResponse.json({
      tool: functionCall.name,
      command,
    });
  } catch (error) {
    console.error("Gemini tool router error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Lixia could not complete that whiteboard request.";

    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}