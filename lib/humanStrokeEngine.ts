export type StrokePoint = {
  x: number;
  y: number;
};

export type HumanStroke = {
  points: StrokePoint[];
};

export type PenEvent =
  | {
      type: "pen-down";
      x: number;
      y: number;
    }
  | {
      type: "pen-move";
      x: number;
      y: number;
    }
  | {
      type: "pen-up";
      x: number;
      y: number;
    };

type PreparedPoint = StrokePoint & {
  distanceFromStrokeStart: number;
};

type PreparedStroke = {
  points: PreparedPoint[];
  length: number;
  globalStart: number;
  globalEnd: number;
};

export type HumanStrokePlayer = {
  reset: () => void;
  drawToProgress: (progress: number) => void;
  totalLength: number;
};

type HumanStrokePlayerOptions = {
  context: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  strokes: HumanStroke[];

  color?: string;
  lineWidth?: number;

  onPenEvent?: (event: PenEvent) => void;
};

const BOARD_BACKGROUND = "#fffef9";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distance(
  a: StrokePoint,
  b: StrokePoint,
): number {
  return Math.hypot(
    b.x - a.x,
    b.y - a.y,
  );
}

function lerp(
  start: number,
  end: number,
  amount: number,
): number {
  return start + (end - start) * amount;
}

/**
 * Very small deterministic movement.
 *
 * We deliberately do NOT use Math.random() because:
 * - the doodle should look identical after a rerender
 * - board persistence becomes predictable
 * - the marker does not jump between animation frames
 */
function humanNoise(seed: number): number {
  const value =
    Math.sin(seed * 12.9898 + 78.233) *
    43758.5453;

  return (
    (value - Math.floor(value)) * 2 - 1
  );
}

function humanizePoint(
  point: StrokePoint,
  index: number,
  amount = 0.8,
): StrokePoint {
  return {
    x:
      point.x +
      humanNoise(index * 2 + 31) *
        amount,

    y:
      point.y +
      humanNoise(index * 2 + 89) *
        amount,
  };
}

/**
 * Chaikin smoothing.
 *
 * This turns rough skeleton/grid points into a path that looks
 * much closer to continuous hand movement.
 */
function smoothStroke(
  input: StrokePoint[],
  iterations = 2,
): StrokePoint[] {
  if (input.length <= 2) {
    return input;
  }

  let points = input.slice();

  for (
    let iteration = 0;
    iteration < iterations;
    iteration += 1
  ) {
    if (points.length <= 2) {
      break;
    }

    const next: StrokePoint[] = [
      points[0],
    ];

    for (
      let index = 0;
      index < points.length - 1;
      index += 1
    ) {
      const current = points[index];
      const following = points[index + 1];

      next.push({
        x:
          current.x * 0.75 +
          following.x * 0.25,

        y:
          current.y * 0.75 +
          following.y * 0.25,
      });

      next.push({
        x:
          current.x * 0.25 +
          following.x * 0.75,

        y:
          current.y * 0.25 +
          following.y * 0.75,
      });
    }

    next.push(
      points[points.length - 1],
    );

    points = next;
  }

  return points;
}

function removeVeryClosePoints(
  input: StrokePoint[],
  minimumDistance = 1.8,
): StrokePoint[] {
  if (input.length <= 2) {
    return input;
  }

  const output: StrokePoint[] = [
    input[0],
  ];

  let previous = input[0];

  for (
    let index = 1;
    index < input.length;
    index += 1
  ) {
    const current = input[index];

    if (
      distance(previous, current) >=
      minimumDistance
    ) {
      output.push(current);
      previous = current;
    }
  }

  const finalPoint =
    input[input.length - 1];

  if (
    output[output.length - 1] !==
    finalPoint
  ) {
    output.push(finalPoint);
  }

  return output;
}

function prepareStrokes(
  strokes: HumanStroke[],
): {
  strokes: PreparedStroke[];
  totalLength: number;
} {
  const prepared: PreparedStroke[] = [];

  let globalDistance = 0;
  let globalPointIndex = 0;

  for (const sourceStroke of strokes) {
    if (
      !sourceStroke.points ||
      sourceStroke.points.length < 2
    ) {
      continue;
    }

    /*
     * Important ordering:
     *
     * skeleton
     * -> remove junk points
     * -> smooth path
     * -> tiny human imperfection
     */
    const cleaned =
      removeVeryClosePoints(
        sourceStroke.points,
      );

    const smoothed =
      smoothStroke(
        cleaned,
        2,
      );

    const humanized =
      smoothed.map((point) => {
        const result =
          humanizePoint(
            point,
            globalPointIndex,
            0.65,
          );

        globalPointIndex += 1;

        return result;
      });

    if (humanized.length < 2) {
      continue;
    }

    let strokeDistance = 0;

    const points: PreparedPoint[] = [
      {
        ...humanized[0],
        distanceFromStrokeStart: 0,
      },
    ];

    for (
      let index = 1;
      index < humanized.length;
      index += 1
    ) {
      strokeDistance += distance(
        humanized[index - 1],
        humanized[index],
      );

      points.push({
        ...humanized[index],
        distanceFromStrokeStart:
          strokeDistance,
      });
    }

    if (strokeDistance < 3) {
      continue;
    }

    const globalStart =
      globalDistance;

    const globalEnd =
      globalStart + strokeDistance;

    prepared.push({
      points,
      length: strokeDistance,
      globalStart,
      globalEnd,
    });

    globalDistance =
      globalEnd;
  }

  return {
    strokes: prepared,
    totalLength: globalDistance,
  };
}

function pointAtStrokeDistance(
  stroke: PreparedStroke,
  targetDistance: number,
): StrokePoint {
  const safeDistance =
    Math.max(
      0,
      Math.min(
        stroke.length,
        targetDistance,
      ),
    );

  if (safeDistance <= 0) {
    return stroke.points[0];
  }

  if (
    safeDistance >=
    stroke.length
  ) {
    return stroke.points[
      stroke.points.length - 1
    ];
  }

  for (
    let index = 1;
    index < stroke.points.length;
    index += 1
  ) {
    const previous =
      stroke.points[index - 1];

    const current =
      stroke.points[index];

    if (
      current.distanceFromStrokeStart <
      safeDistance
    ) {
      continue;
    }

    const segmentStart =
      previous.distanceFromStrokeStart;

    const segmentEnd =
      current.distanceFromStrokeStart;

    const segmentLength =
      Math.max(
        0.0001,
        segmentEnd - segmentStart,
      );

    const localProgress =
      (
        safeDistance -
        segmentStart
      ) /
      segmentLength;

    return {
      x: lerp(
        previous.x,
        current.x,
        localProgress,
      ),

      y: lerp(
        previous.y,
        current.y,
        localProgress,
      ),
    };
  }

  return stroke.points[
    stroke.points.length - 1
  ];
}

function drawCurveSegment(
  context: CanvasRenderingContext2D,
  previous: StrokePoint,
  current: StrokePoint,
) {
  /*
   * Midpoint quadratic curve produces a smoother marker
   * line than repeatedly calling lineTo().
   */
  const midpointX =
    (previous.x + current.x) / 2;

  const midpointY =
    (previous.y + current.y) / 2;

  context.beginPath();

  context.moveTo(
    previous.x,
    previous.y,
  );

  context.quadraticCurveTo(
    previous.x,
    previous.y,
    midpointX,
    midpointY,
  );

  context.stroke();
}

/**
 * Stateful player.
 *
 * The important part:
 *
 * It does NOT clear and redraw the complete canvas every frame.
 *
 * It only paints the additional distance travelled by the
 * virtual marker since the previous animation frame.
 */
export function createHumanStrokePlayer({
  context,
  canvas,
  strokes,
  color = "#1f2937",
  lineWidth = 4.8,
  onPenEvent,
}: HumanStrokePlayerOptions): HumanStrokePlayer {
  const prepared =
    prepareStrokes(strokes);

  let previousGlobalDistance = 0;

  let activeStrokeIndex = -1;

  let lastPoint:
    | StrokePoint
    | null = null;

  let penDown = false;

  function emitPenDown(
    point: StrokePoint,
  ) {
    penDown = true;

    onPenEvent?.({
      type: "pen-down",
      x: point.x,
      y: point.y,
    });
  }

  function emitPenMove(
    point: StrokePoint,
  ) {
    onPenEvent?.({
      type: "pen-move",
      x: point.x,
      y: point.y,
    });
  }

  function emitPenUp(
    point: StrokePoint,
  ) {
    if (!penDown) {
      return;
    }

    penDown = false;

    onPenEvent?.({
      type: "pen-up",
      x: point.x,
      y: point.y,
    });
  }

  function reset() {
    previousGlobalDistance = 0;
    activeStrokeIndex = -1;
    lastPoint = null;
    penDown = false;

    context.save();

    context.globalCompositeOperation =
      "source-over";

    context.fillStyle =
      BOARD_BACKGROUND;

    context.fillRect(
      0,
      0,
      canvas.width,
      canvas.height,
    );

    context.restore();
  }

  function drawStrokeRange(
    stroke: PreparedStroke,
    strokeIndex: number,
    fromDistance: number,
    toDistance: number,
  ) {
    if (
      toDistance <=
      fromDistance
    ) {
      return;
    }

    const start =
      pointAtStrokeDistance(
        stroke,
        fromDistance,
      );

    if (
      activeStrokeIndex !==
      strokeIndex
    ) {
      if (lastPoint) {
        emitPenUp(lastPoint);
      }

      activeStrokeIndex =
        strokeIndex;

      lastPoint = start;

      emitPenDown(start);
    }

    context.save();

    context.globalCompositeOperation =
      "source-over";

    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";

    /*
     * Fixed small spatial steps mean animation speed is based
     * on DISTANCE, not on how many points Gemini/tracing produced.
     */
    const step = 3.2;

    let cursor =
      Math.max(
        fromDistance + step,
        step,
      );

    let previous =
      lastPoint ?? start;

    while (
      cursor < toDistance
    ) {
      const current =
        pointAtStrokeDistance(
          stroke,
          cursor,
        );

      drawCurveSegment(
        context,
        previous,
        current,
      );

      emitPenMove(current);

      previous = current;
      lastPoint = current;

      cursor += step;
    }

    const end =
      pointAtStrokeDistance(
        stroke,
        toDistance,
      );

    drawCurveSegment(
      context,
      previous,
      end,
    );

    emitPenMove(end);

    lastPoint = end;

    context.restore();

    if (
      toDistance >=
      stroke.length - 0.01
    ) {
      emitPenUp(end);

      activeStrokeIndex = -1;
      lastPoint = null;
    }
  }

  function drawToProgress(
    progress: number,
  ) {
    if (
      prepared.totalLength <= 0
    ) {
      return;
    }

    const safeProgress =
      clamp01(progress);

    const targetGlobalDistance =
      prepared.totalLength *
      safeProgress;

    /*
     * Animation restarted or seeked backwards.
     */
    if (
      targetGlobalDistance <
      previousGlobalDistance
    ) {
      reset();
    }

    if (
      targetGlobalDistance <=
      previousGlobalDistance
    ) {
      return;
    }

    for (
      let strokeIndex = 0;
      strokeIndex <
      prepared.strokes.length;
      strokeIndex += 1
    ) {
      const stroke =
        prepared.strokes[
          strokeIndex
        ];

      if (
        targetGlobalDistance <=
        stroke.globalStart
      ) {
        break;
      }

      if (
        previousGlobalDistance >=
        stroke.globalEnd
      ) {
        continue;
      }

      const fromDistance =
        Math.max(
          0,
          previousGlobalDistance -
            stroke.globalStart,
        );

      const toDistance =
        Math.min(
          stroke.length,
          targetGlobalDistance -
            stroke.globalStart,
        );

      drawStrokeRange(
        stroke,
        strokeIndex,
        fromDistance,
        toDistance,
      );
    }

    previousGlobalDistance =
      targetGlobalDistance;
  }

  return {
    reset,
    drawToProgress,
    totalLength:
      prepared.totalLength,
  };
}