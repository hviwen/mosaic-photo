import type {
  CropDecision,
  CropLossBreakdown,
  FillArrangeResult,
  LayoutMetrics,
  LayoutQualitySummary,
  LayoutQualityThresholds,
  LayoutSearchMode,
  LayoutSearchOptions,
  Placement,
  CropRect,
  PhotoLayoutConstraint,
} from "@/types";
import type { KeepRegion } from "@/types/vision";
import { centerCropToAspect } from "@/utils/image";
import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
  getSmartCropMode,
  buildPhotoLayoutConstraint,
} from "@/utils/smartCrop";
import {
  assignPhotosToTiles,
  buildFillArrangePhotoStrategy,
  isFillOrientationReversed,
  type FillArrangeAssignmentPhoto,
  type FillArrangeAssignmentTile,
} from "@/utils/fillArrangeAssignment";
import { validateFillArrangePlacements } from "@/utils/fillArrangeValidation";

export type FillArrangeOptions = {
  seed?: number;
  splitRatioMin?: number;
  splitRatioMax?: number;
  searchOptions?: Partial<LayoutSearchOptions>;
  qualityThresholds?: Partial<LayoutQualityThresholds>;
  allowCanvasResize?: boolean;
};

export type FillArrangePhotoInput = {
  id: string;
  crop: CropRect;
  imageWidth: number;
  imageHeight: number;
  detections?: KeepRegion[];
};

type FillRect = { x: number; y: number; w: number; h: number };
type OrderedTile = { tile: FillRect; dist: number; leafId: string };
type SearchStage = "strict" | "relaxed" | "last_resort";
type OrientationClass = PhotoLayoutConstraint["orientationClass"];
type SplitAxis = "vertical" | "horizontal";

type TileProfile = {
  landscapeCount: number;
  portraitCount: number;
  squareCount: number;
  largeReserveCount: number;
  highRiskReserveCount: number;
  targets: Array<{ orientation: OrientationClass; weight: number }>;
};

type LeafNode = {
  kind: "leaf";
  id: string;
  bounds: FillRect;
  leafIds: string[];
  minW: number;
  minH: number;
};

type SplitNode = {
  kind: "split";
  id: string;
  axis: SplitAxis;
  baseRatio: number;
  ratio: number;
  minRatio: number;
  maxRatio: number;
  bounds: FillRect;
  children: [TileLayoutTree, TileLayoutTree];
  leafIds: string[];
  minW: number;
  minH: number;
};

type TileLayoutTree = LeafNode | SplitNode;

type TileLayoutCandidate = {
  tree: TileLayoutTree;
  tiles: FillRect[];
  leafOrder: string[];
};

type ElasticOptimizationProfile = {
  rootBudget: number;
  innerBudget: number;
  coarseSteps: number[];
  coarseRounds: number;
  maxPathSplits: number;
  fineTopK: number;
  fineIterations: number;
  allowLocalRetile: boolean;
  allowContinuousRefinement: boolean;
  rerunAfterLocalRetile: boolean;
};

type CandidateDiagnostics = {
  worstTileIndex: number;
  worstLeafId?: string;
  topSoftCropTileIndices: number[];
  topSoftCropPhotoIds: string[];
  topSoftCropLeafIds: string[];
};

type Candidate = {
  tree: TileLayoutTree;
  tileOrder: OrderedTile[];
  tileToPhotoIndex: number[];
  cropDecisions: CropDecision[];
  orientationViolations: number;
  totalCost: number;
  seamMovementPenalty: number;
  cw: number;
  ch: number;
  metrics: LayoutMetrics;
  quality: LayoutQualitySummary;
  diagnostics: CandidateDiagnostics;
  stage: SearchStage;
};

type PhotoFeature = {
  photo: FillArrangePhotoInput;
  strategy: ReturnType<typeof buildFillArrangePhotoStrategy>;
  constraint: PhotoLayoutConstraint;
  sourceArea: number;
};

type SolverContext = {
  photos: FillArrangePhotoInput[];
  photoFeatures: PhotoFeature[];
  photoById: Map<string, FillArrangePhotoInput>;
  constraintById: Map<string, PhotoLayoutConstraint>;
  photoIndexById: Map<string, number>;
  qualityThresholds: LayoutQualityThresholds;
  baseCanvasW: number;
  baseCanvasH: number;
  decisionCache: Map<string, CropDecision>;
};

const CENTER_BIAS_WEIGHT = 0.55;
const EDGE_BIAS_WEIGHT = 0.14;
const FACE_CUT_WEIGHT = 1_000_000;
const ORIENTATION_WEIGHT = 100_000;
const LARGE_PHOTO_WEIGHT = 160;
const ASPECT_WEIGHT = 45;
const CENTER_WEIGHT = 8;
const CROP_AREA_EPSILON = 1e-6;
const SOFT_CROP_THRESHOLD = 0.08;
const TREE_ID_PREFIX = "layout";

const DEFAULT_SEARCH_OPTIONS: LayoutSearchOptions = {
  mode: "standard",
  allowCanvasResize: true,
  allowLocalRepair: true,
  maxSearchRounds: 6,
};

const DEFAULT_QUALITY_THRESHOLDS: LayoutQualityThresholds = {
  maxWorstCropLoss: 0.12,
  maxAverageCropLoss: 0.06,
  maxPhotosOverCropThreshold: 1,
  requireKeepRegionsFullyVisible: true,
};

function defaultModeForPhotoCount(count: number): LayoutSearchMode {
  if (count <= 8) return "deep";
  if (count <= 12) return "extended";
  return DEFAULT_SEARCH_OPTIONS.mode;
}

function defaultMaxSearchRounds(mode: LayoutSearchMode): number {
  if (mode === "deep") return 10;
  if (mode === "extended") return 7;
  return DEFAULT_SEARCH_OPTIONS.maxSearchRounds;
}

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

function splitLength(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from(
    { length: parts },
    (_, i) => base + (i < remainder ? 1 : 0),
  );
}

function mergeMetrics(
  base: LayoutMetrics,
  extra: Partial<LayoutMetrics>,
): LayoutMetrics {
  return {
    evaluatedPairs: base.evaluatedPairs + (extra.evaluatedPairs ?? 0),
    cacheHits: base.cacheHits + (extra.cacheHits ?? 0),
    cacheMisses: base.cacheMisses + (extra.cacheMisses ?? 0),
    orientationViolations:
      base.orientationViolations + (extra.orientationViolations ?? 0),
    canvasAdjustmentsTried:
      base.canvasAdjustmentsTried + (extra.canvasAdjustmentsTried ?? 0),
    elasticTrials: base.elasticTrials + (extra.elasticTrials ?? 0),
    elasticAccepted: base.elasticAccepted + (extra.elasticAccepted ?? 0),
    localRetileAccepted:
      base.localRetileAccepted + (extra.localRetileAccepted ?? 0),
    continuousRefinements:
      base.continuousRefinements + (extra.continuousRefinements ?? 0),
  };
}

function emptyMetrics(canvasAdjustmentsTried: number): LayoutMetrics {
  return {
    evaluatedPairs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    orientationViolations: 0,
    canvasAdjustmentsTried,
    elasticTrials: 0,
    elasticAccepted: 0,
    localRetileAccepted: 0,
    continuousRefinements: 0,
  };
}

function rectKey(rect: FillRect): string {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function cloneRect(rect: FillRect): FillRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function buildLeafNode(
  id: string,
  bounds: FillRect,
  minSize: number,
): LeafNode {
  return {
    kind: "leaf",
    id,
    bounds: cloneRect(bounds),
    leafIds: [id],
    minW: Math.min(bounds.w, minSize),
    minH: Math.min(bounds.h, minSize),
  };
}

function applySplitBounds(
  axis: SplitAxis,
  bounds: FillRect,
  ratio: number,
): [FillRect, FillRect] {
  if (axis === "vertical") {
    const leftW = clamp(Math.round(bounds.w * ratio), 1, bounds.w - 1);
    return [
      { x: bounds.x, y: bounds.y, w: leftW, h: bounds.h },
      { x: bounds.x + leftW, y: bounds.y, w: bounds.w - leftW, h: bounds.h },
    ];
  }
  const topH = clamp(Math.round(bounds.h * ratio), 1, bounds.h - 1);
  return [
    { x: bounds.x, y: bounds.y, w: bounds.w, h: topH },
    { x: bounds.x, y: bounds.y + topH, w: bounds.w, h: bounds.h - topH },
  ];
}

function buildSplitNode(
  id: string,
  axis: SplitAxis,
  bounds: FillRect,
  ratio: number,
  baseRatio: number,
  children: [TileLayoutTree, TileLayoutTree],
): SplitNode {
  const [a, b] = children;
  const minRatio =
    axis === "vertical"
      ? a.minW / Math.max(1, bounds.w)
      : a.minH / Math.max(1, bounds.h);
  const maxRatio =
    axis === "vertical"
      ? 1 - b.minW / Math.max(1, bounds.w)
      : 1 - b.minH / Math.max(1, bounds.h);
  return {
    kind: "split",
    id,
    axis,
    baseRatio,
    ratio: clamp(ratio, minRatio, maxRatio),
    minRatio,
    maxRatio,
    bounds: cloneRect(bounds),
    children,
    leafIds: [...a.leafIds, ...b.leafIds],
    minW: axis === "vertical" ? a.minW + b.minW : Math.max(a.minW, b.minW),
    minH: axis === "horizontal" ? a.minH + b.minH : Math.max(a.minH, b.minH),
  };
}

function flattenTreeLeaves(tree: TileLayoutTree): LeafNode[] {
  if (tree.kind === "leaf") return [tree];
  return [...flattenTreeLeaves(tree.children[0]), ...flattenTreeLeaves(tree.children[1])];
}

function rebuildTreeBounds(
  tree: TileLayoutTree,
  bounds: FillRect,
): TileLayoutTree {
  if (tree.kind === "leaf") {
    return { ...tree, bounds: cloneRect(bounds) };
  }
  const ratio = clamp(tree.ratio, tree.minRatio, tree.maxRatio);
  const [leftBounds, rightBounds] = applySplitBounds(tree.axis, bounds, ratio);
  const left = rebuildTreeBounds(tree.children[0], leftBounds);
  const right = rebuildTreeBounds(tree.children[1], rightBounds);
  return buildSplitNode(
    tree.id,
    tree.axis,
    bounds,
    ratio,
    tree.baseRatio,
    [left, right],
  );
}

type SplitCandidateLine = {
  axis: SplitAxis;
  line: number;
  score: number;
  aRects: FillRect[];
  bRects: FillRect[];
};

function findTreeSplitCandidate(
  bounds: FillRect,
  rects: FillRect[],
): SplitCandidateLine | null {
  const candidates: SplitCandidateLine[] = [];
  const eps = 0.5;
  const tryAxis = (axis: SplitAxis) => {
    const lines = new Set<number>();
    for (const rect of rects) {
      const line =
        axis === "vertical" ? rect.x + rect.w : rect.y + rect.h;
      const min = axis === "vertical" ? bounds.x : bounds.y;
      const max =
        axis === "vertical" ? bounds.x + bounds.w : bounds.y + bounds.h;
      if (line > min + eps && line < max - eps) lines.add(line);
    }
    for (const line of lines) {
      const aRects = rects.filter(rect =>
        axis === "vertical"
          ? rect.x + rect.w <= line + eps
          : rect.y + rect.h <= line + eps,
      );
      const bRects = rects.filter(rect =>
        axis === "vertical" ? rect.x >= line - eps : rect.y >= line - eps,
      );
      if (
        aRects.length === 0 ||
        bRects.length === 0 ||
        aRects.length + bRects.length !== rects.length
      ) {
        continue;
      }
      const midpoint =
        axis === "vertical"
          ? bounds.x + bounds.w / 2
          : bounds.y + bounds.h / 2;
      const score =
        Math.abs(aRects.length - bRects.length) * 1000 +
        Math.abs(line - midpoint);
      candidates.push({ axis, line, score, aRects, bRects });
    }
  };
  tryAxis("vertical");
  tryAxis("horizontal");
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.score - b.score)[0];
}

function buildTreeFromRects(
  bounds: FillRect,
  rects: FillRect[],
  minSize: number,
  leafIdMap: Map<string, string>,
  counter: { value: number },
): TileLayoutTree {
  if (rects.length <= 1) {
    const rect = rects[0] ?? bounds;
    const id = leafIdMap.get(rectKey(rect)) ?? `${TREE_ID_PREFIX}-leaf-${counter.value++}`;
    return buildLeafNode(id, rect, minSize);
  }

  const split = findTreeSplitCandidate(bounds, rects);
  if (!split) {
    const sorted = [...rects].sort(
      (a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h,
    );
    const mid = Math.floor(sorted.length / 2);
    const axis: SplitAxis = bounds.w >= bounds.h ? "vertical" : "horizontal";
    const ratio = clamp(mid / sorted.length, 0.25, 0.75);
    const [aBounds, bBounds] = applySplitBounds(axis, bounds, ratio);
    const left = buildTreeFromRects(
      aBounds,
      sorted.slice(0, mid),
      minSize,
      leafIdMap,
      counter,
    );
    const right = buildTreeFromRects(
      bBounds,
      sorted.slice(mid),
      minSize,
      leafIdMap,
      counter,
    );
    return buildSplitNode(
      `${TREE_ID_PREFIX}-split-${counter.value++}`,
      axis,
      bounds,
      ratio,
      ratio,
      [left, right],
    );
  }

  const ratio =
    split.axis === "vertical"
      ? (split.line - bounds.x) / Math.max(1, bounds.w)
      : (split.line - bounds.y) / Math.max(1, bounds.h);
  const [aBounds, bBounds] = applySplitBounds(split.axis, bounds, ratio);
  const left = buildTreeFromRects(aBounds, split.aRects, minSize, leafIdMap, counter);
  const right = buildTreeFromRects(bBounds, split.bRects, minSize, leafIdMap, counter);
  return buildSplitNode(
    `${TREE_ID_PREFIX}-split-${counter.value++}`,
    split.axis,
    bounds,
    ratio,
    ratio,
    [left, right],
  );
}

function buildLayoutCandidateFromRects(
  bounds: FillRect,
  rects: FillRect[],
  minSize: number,
): TileLayoutCandidate | null {
  if (rects.length === 0) return null;
  const leafIdMap = new Map<string, string>();
  const sortedRects = [...rects].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h,
  );
  sortedRects.forEach((rect, idx) => {
    leafIdMap.set(rectKey(rect), `${TREE_ID_PREFIX}-leaf-${idx}`);
  });
  const tree = rebuildTreeBounds(
    buildTreeFromRects(bounds, rects, minSize, leafIdMap, { value: 0 }),
    bounds,
  );
  const leaves = flattenTreeLeaves(tree);
  return {
    tree,
    tiles: leaves.map(leaf => cloneRect(leaf.bounds)),
    leafOrder: leaves.map(leaf => leaf.id),
  };
}

function getSeamMovementPenalty(tree: TileLayoutTree, weight: number = 1.2): number {
  if (tree.kind === "leaf") return 0;
  const current = Math.abs(tree.ratio - tree.baseRatio) * weight;
  return (
    current +
    getSeamMovementPenalty(tree.children[0], 1) +
    getSeamMovementPenalty(tree.children[1], 1)
  );
}

function safeAspect(w: number, h: number): number {
  return Math.max(1e-6, w / Math.max(1e-6, h));
}

function orientationFromAspect(aspect: number): OrientationClass {
  if (aspect > 1.08) return "landscape";
  if (aspect < 0.92) return "portrait";
  return "square";
}

function buildFallbackGridTiles(
  count: number,
  canvasW: number,
  canvasH: number,
): FillRect[] {
  if (count <= 0) return [];
  const aspect = canvasW / Math.max(1, canvasH);
  const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.ceil(count / cols));

  const rowCounts = Array.from({ length: rows }, (_, i) => {
    const remain = count - i * cols;
    return Math.max(0, Math.min(cols, remain));
  }).filter(v => v > 0);

  const rowHeights = splitLength(canvasH, rowCounts.length);
  const tiles: FillRect[] = [];
  let y = 0;
  for (let r = 0; r < rowCounts.length; r++) {
    const colsInRow = rowCounts[r];
    const h = rowHeights[r];
    const colWidths = splitLength(canvasW, colsInRow);
    let x = 0;
    for (let c = 0; c < colsInRow; c++) {
      const w = colWidths[c];
      tiles.push({ x, y, w, h });
      x += w;
    }
    y += h;
  }
  return tiles.slice(0, count);
}

function partitionRectToTiles(
  root: FillRect,
  count: number,
  rand: () => number,
  ratioMin: number,
  ratioMax: number,
): FillRect[] {
  if (count <= 0) return [];
  if (count === 1) return [root];

  const splitRec = (rect: FillRect, need: number): FillRect[] => {
    if (need <= 1) return [rect];

    const countRatio = clamp(
      ratioMin + (ratioMax - ratioMin) * rand(),
      1 / need,
      1 - 1 / need,
    );
    const leftCount = clamp(Math.round(need * countRatio), 1, need - 1);
    const rightCount = need - leftCount;
    const areaRatio = leftCount / need;

    const trySplit = (
      vertical: boolean,
    ): { a: FillRect; b: FillRect } | null => {
      if (vertical) {
        if (rect.w < 2) return null;
        const jitter = (rand() - 0.5) * 0.12;
        const splitRatio = clamp(areaRatio + jitter, 0.1, 0.9);
        const w1 = clamp(Math.round(rect.w * splitRatio), 1, rect.w - 1);
        const w2 = rect.w - w1;
        if (w1 < 1 || w2 < 1) return null;
        return {
          a: { x: rect.x, y: rect.y, w: w1, h: rect.h },
          b: { x: rect.x + w1, y: rect.y, w: w2, h: rect.h },
        };
      }

      if (rect.h < 2) return null;
      const jitter = (rand() - 0.5) * 0.12;
      const splitRatio = clamp(areaRatio + jitter, 0.1, 0.9);
      const h1 = clamp(Math.round(rect.h * splitRatio), 1, rect.h - 1);
      const h2 = rect.h - h1;
      if (h1 < 1 || h2 < 1) return null;
      return {
        a: { x: rect.x, y: rect.y, w: rect.w, h: h1 },
        b: { x: rect.x, y: rect.y + h1, w: rect.w, h: h2 },
      };
    };

    const rectAspect = rect.w / Math.max(1, rect.h);
    let preferVertical: boolean;
    if (rectAspect > SMART_CROP_ASPECT_MAX) {
      preferVertical = true;
    } else if (rectAspect < SMART_CROP_ASPECT_MIN) {
      preferVertical = false;
    } else {
      preferVertical = rectAspect >= 1;
    }

    let split =
      trySplit(preferVertical) ??
      trySplit(!preferVertical) ??
      trySplit(rect.w >= rect.h);

    if (!split) {
      if (rect.w >= 2) {
        const w1 = Math.floor(rect.w / 2);
        split = {
          a: { x: rect.x, y: rect.y, w: w1, h: rect.h },
          b: { x: rect.x + w1, y: rect.y, w: rect.w - w1, h: rect.h },
        };
      } else if (rect.h >= 2) {
        const h1 = Math.floor(rect.h / 2);
        split = {
          a: { x: rect.x, y: rect.y, w: rect.w, h: h1 },
          b: { x: rect.x, y: rect.y + h1, w: rect.w, h: rect.h - h1 },
        };
      } else {
        return [rect];
      }
    }

    return [...splitRec(split.a, leftCount), ...splitRec(split.b, rightCount)];
  };

  return splitRec(root, count);
}

function buildTileProfileFromPhotos(
  photoFeatures: PhotoFeature[],
  priorityPhotoIds: string[] = [],
): TileProfile {
  const prioritySet = new Set(priorityPhotoIds);
  const sorted = [...photoFeatures].sort((a, b) => {
    const aPriority = prioritySet.has(a.photo.id) ? 1 : 0;
    const bPriority = prioritySet.has(b.photo.id) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    if (a.constraint.isHighRisk !== b.constraint.isHighRisk) {
      return a.constraint.isHighRisk ? -1 : 1;
    }
    if (a.constraint.sizeRankWeight !== b.constraint.sizeRankWeight) {
      return b.constraint.sizeRankWeight - a.constraint.sizeRankWeight;
    }
    return b.constraint.preferredCenterWeight - a.constraint.preferredCenterWeight;
  });

  const averageArea =
    photoFeatures.reduce((sum, item) => sum + item.sourceArea, 0) /
    Math.max(1, photoFeatures.length);
  const weightedOrientationTotals = {
    landscape: 0,
    portrait: 0,
    square: 0,
  } satisfies Record<OrientationClass, number>;

  for (const item of sorted) {
    const areaWeight = clamp(item.sourceArea / Math.max(1, averageArea), 0.65, 2.6);
    const priorityWeight = prioritySet.has(item.photo.id) ? 0.8 : 0;
    const riskWeight = item.constraint.isHighRisk ? 0.4 : 0;
    weightedOrientationTotals[item.constraint.orientationClass] +=
      areaWeight + priorityWeight + riskWeight;
  }

  const exactCounts = {
    landscape:
      (weightedOrientationTotals.landscape /
        Math.max(
          1e-6,
          weightedOrientationTotals.landscape +
            weightedOrientationTotals.portrait +
            weightedOrientationTotals.square,
        )) *
      photoFeatures.length,
    portrait:
      (weightedOrientationTotals.portrait /
        Math.max(
          1e-6,
          weightedOrientationTotals.landscape +
            weightedOrientationTotals.portrait +
            weightedOrientationTotals.square,
        )) *
      photoFeatures.length,
    square:
      (weightedOrientationTotals.square /
        Math.max(
          1e-6,
          weightedOrientationTotals.landscape +
            weightedOrientationTotals.portrait +
            weightedOrientationTotals.square,
        )) *
      photoFeatures.length,
  } satisfies Record<OrientationClass, number>;

  const rawPresence = {
    landscape: sorted.some(item => item.constraint.orientationClass === "landscape"),
    portrait: sorted.some(item => item.constraint.orientationClass === "portrait"),
    square: sorted.some(item => item.constraint.orientationClass === "square"),
  } satisfies Record<OrientationClass, boolean>;
  const quotas = {
    landscape: Math.floor(exactCounts.landscape),
    portrait: Math.floor(exactCounts.portrait),
    square: Math.floor(exactCounts.square),
  } satisfies Record<OrientationClass, number>;

  for (const orientation of ["landscape", "portrait", "square"] as const) {
    if (rawPresence[orientation] && quotas[orientation] === 0) quotas[orientation] = 1;
  }

  let assignedCount = quotas.landscape + quotas.portrait + quotas.square;
  if (assignedCount > photoFeatures.length) {
    const removable = (["square", "portrait", "landscape"] as const).filter(
      orientation => quotas[orientation] > (rawPresence[orientation] ? 1 : 0),
    );
    while (assignedCount > photoFeatures.length && removable.length > 0) {
      const orientation = removable.shift()!;
      quotas[orientation]--;
      assignedCount--;
      if (quotas[orientation] > (rawPresence[orientation] ? 1 : 0)) {
        removable.push(orientation);
      }
    }
  }

  const remainderOrder = (["landscape", "portrait", "square"] as const)
    .map(orientation => ({
      orientation,
      remainder: exactCounts[orientation] - Math.floor(exactCounts[orientation]),
    }))
    .sort((a, b) => b.remainder - a.remainder);
  while (assignedCount < photoFeatures.length) {
    const next = remainderOrder[assignedCount % remainderOrder.length];
    quotas[next.orientation]++;
    assignedCount++;
  }

  const targets: Array<{ orientation: OrientationClass; weight: number }> = [];
  const remaining = { ...quotas };
  for (const item of sorted) {
    const orientation = item.constraint.orientationClass;
    if (remaining[orientation] > 0) {
      const areaWeight = clamp(item.sourceArea / Math.max(1, averageArea), 0.65, 2.8);
      const priorityWeight = prioritySet.has(item.photo.id) ? 0.45 : 0;
      const riskWeight = item.constraint.isHighRisk ? 0.25 : 0;
      const sizeWeight = item.constraint.sizeRankWeight * 0.55;
      targets.push({
        orientation,
        weight: areaWeight + priorityWeight + riskWeight + sizeWeight,
      });
      remaining[orientation]--;
    }
  }
  for (const orientation of ["landscape", "portrait", "square"] as const) {
    while (remaining[orientation] > 0) {
      targets.push({ orientation, weight: 1 });
      remaining[orientation]--;
    }
  }

  const landscapeCount = quotas.landscape;
  const portraitCount = quotas.portrait;
  const squareCount = quotas.square;
  const largeReserveCount = Math.max(1, Math.ceil(targets.length * 0.3));
  const highRiskReserveCount = sorted.filter(item => item.constraint.isHighRisk).length;

  return {
    landscapeCount,
    portraitCount,
    squareCount,
    largeReserveCount,
    highRiskReserveCount,
    targets,
  };
}

function splitRectByTargets(
  rect: FillRect,
  targets: Array<{ orientation: OrientationClass; weight: number }>,
  rand: () => number,
  minSize: number,
): FillRect[] {
  if (targets.length <= 1) return [rect];

  const counts = {
    landscape: targets.filter(v => v.orientation === "landscape").length,
    portrait: targets.filter(v => v.orientation === "portrait").length,
    square: targets.filter(v => v.orientation === "square").length,
  };
  const dominant =
    counts.landscape >= counts.portrait && counts.landscape >= counts.square
      ? "landscape"
      : counts.portrait >= counts.square
        ? "portrait"
        : "square";

  const leftCount = clamp(
    Math.round(targets.length * (0.42 + (rand() - 0.5) * 0.16)),
    1,
    targets.length - 1,
  );
  const leftTargets = targets.slice(0, leftCount);
  const rightTargets = targets.slice(leftCount);

  const trySplit = (
    vertical: boolean,
  ): { a: FillRect; b: FillRect } | null => {
    const totalWeight = targets.reduce((sum, item) => sum + item.weight, 0);
    const leftWeight = leftTargets.reduce((sum, item) => sum + item.weight, 0);
    const targetRatio = clamp(
      leftWeight / Math.max(1e-6, totalWeight),
      0.2,
      0.8,
    );
    if (vertical) {
      if (rect.w < minSize * 2) return null;
      const ratio = targetRatio;
      const w1 = clamp(Math.round(rect.w * ratio), minSize, rect.w - minSize);
      return {
        a: { x: rect.x, y: rect.y, w: w1, h: rect.h },
        b: { x: rect.x + w1, y: rect.y, w: rect.w - w1, h: rect.h },
      };
    }

    if (rect.h < minSize * 2) return null;
    const ratio = targetRatio;
    const h1 = clamp(Math.round(rect.h * ratio), minSize, rect.h - minSize);
    return {
      a: { x: rect.x, y: rect.y, w: rect.w, h: h1 },
      b: { x: rect.x, y: rect.y + h1, w: rect.w, h: rect.h - h1 },
    };
  };

  const preferVertical =
    dominant === "portrait" ? true : dominant === "landscape" ? false : rect.w >= rect.h;
  const split = trySplit(preferVertical) ?? trySplit(!preferVertical);
  if (!split) return buildFallbackGridTiles(targets.length, rect.w, rect.h).map(tile => ({
    x: tile.x + rect.x,
    y: tile.y + rect.y,
    w: tile.w,
    h: tile.h,
  }));

  return [
    ...splitRectByTargets(split.a, leftTargets, rand, minSize),
    ...splitRectByTargets(split.b, rightTargets, rand, minSize),
  ];
}

function buildTilesFromProfile(
  count: number,
  canvasW: number,
  canvasH: number,
  profile: TileProfile,
  rand: () => number,
): FillRect[] {
  if (count <= 0) return [];
  const minSize = Math.max(80, Math.round(Math.min(canvasW, canvasH) * 0.12));
  const root = { x: 0, y: 0, w: canvasW, h: canvasH };
  const targets = profile.targets.slice(0, count);
  return splitRectByTargets(root, targets, rand, minSize).slice(0, count);
}

function buildStripTilesFromProfile(
  count: number,
  canvasW: number,
  canvasH: number,
  profile: TileProfile,
  rand: () => number,
): FillRect[] | null {
  if (count <= 1) return null;

  const minSize = Math.max(80, Math.round(Math.min(canvasW, canvasH) * 0.12));
  const isLandscapeCanvas = canvasW >= canvasH;
  const stripOrientation: OrientationClass | null = isLandscapeCanvas
    ? profile.landscapeCount > 0 && profile.landscapeCount < count
      ? "landscape"
      : null
    : profile.portraitCount > 0 && profile.portraitCount < count
      ? "portrait"
      : null;
  if (!stripOrientation) return null;

  const stripCount =
    stripOrientation === "landscape" ? profile.landscapeCount : profile.portraitCount;
  if (stripCount < 1 || stripCount >= count) return null;

  const stripTargets = profile.targets
    .filter(target => target.orientation === stripOrientation)
    .slice(0, stripCount);
  const mainTargets = profile.targets
    .filter(target => target.orientation !== stripOrientation)
    .slice(0, count - stripCount);
  if (stripTargets.length !== stripCount || mainTargets.length !== count - stripCount) {
    return null;
  }

  if (isLandscapeCanvas) {
    if (canvasW < minSize * 2) return null;
    const stripRatio = clamp(stripCount / count + 0.08, 0.28, 0.58);
    const stripW = clamp(Math.round(canvasW * stripRatio), minSize, canvasW - minSize);
    const mainRect: FillRect = { x: 0, y: 0, w: canvasW - stripW, h: canvasH };
    const stripRect: FillRect = { x: canvasW - stripW, y: 0, w: stripW, h: canvasH };
    return [
      ...splitRectByTargets(mainRect, mainTargets, rand, minSize),
      ...splitRectByTargets(stripRect, stripTargets, rand, minSize),
    ];
  }

  if (canvasH < minSize * 2) return null;
  const stripRatio = clamp(stripCount / count + 0.08, 0.28, 0.58);
  const stripH = clamp(Math.round(canvasH * stripRatio), minSize, canvasH - minSize);
  const mainRect: FillRect = { x: 0, y: 0, w: canvasW, h: canvasH - stripH };
  const stripRect: FillRect = { x: 0, y: canvasH - stripH, w: canvasW, h: stripH };
  return [
    ...splitRectByTargets(mainRect, mainTargets, rand, minSize),
    ...splitRectByTargets(stripRect, stripTargets, rand, minSize),
  ];
}

function reserveTilesForPriorityPhotos(
  count: number,
  canvasW: number,
  canvasH: number,
  profile: TileProfile,
  rand: () => number,
  priorityPhotoIds: string[],
  photoFeatures: PhotoFeature[],
): FillRect[] {
  if (priorityPhotoIds.length === 0) {
    return buildTilesFromProfile(count, canvasW, canvasH, profile, rand);
  }

  const prioritySet = new Set(priorityPhotoIds);
  const reorderedTargets = [
    ...photoFeatures
      .filter(item => prioritySet.has(item.photo.id))
      .map(item => ({
        orientation: item.constraint.orientationClass,
        weight:
          clamp(
            item.sourceArea /
              Math.max(
                1,
                photoFeatures.reduce((sum, feature) => sum + feature.sourceArea, 0) /
                  Math.max(1, photoFeatures.length),
              ),
            0.65,
            2.8,
          ) +
          item.constraint.sizeRankWeight * 0.55 +
          (item.constraint.isHighRisk ? 0.25 : 0),
      })),
    ...photoFeatures
      .filter(item => !prioritySet.has(item.photo.id))
      .map(item => ({
        orientation: item.constraint.orientationClass,
        weight:
          clamp(
            item.sourceArea /
              Math.max(
                1,
                photoFeatures.reduce((sum, feature) => sum + feature.sourceArea, 0) /
                  Math.max(1, photoFeatures.length),
              ),
            0.65,
            2.8,
          ) +
          item.constraint.sizeRankWeight * 0.55 +
          (item.constraint.isHighRisk ? 0.25 : 0),
      })),
  ];
  return buildTilesFromProfile(
    count,
    canvasW,
    canvasH,
    { ...profile, targets: reorderedTargets },
    rand,
  );
}

function createLayoutCandidateForTiles(
  root: FillRect,
  tiles: FillRect[],
): TileLayoutCandidate | null {
  const minSize = Math.max(80, Math.round(Math.min(root.w, root.h) * 0.12));
  return buildLayoutCandidateFromRects(root, tiles, minSize);
}

function createLayoutCandidateFromTree(tree: TileLayoutTree): TileLayoutCandidate {
  const leaves = flattenTreeLeaves(tree);
  return {
    tree,
    tiles: leaves.map(leaf => cloneRect(leaf.bounds)),
    leafOrder: leaves.map(leaf => leaf.id),
  };
}

function rectIntersectionArea(a: CropRect, b: CropRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function countCutRequiredRegions(crop: CropRect, regions: CropRect[]): number {
  if (regions.length === 0) return 0;
  return regions.reduce((sum, region) => {
    const area = Math.max(1, region.width * region.height);
    const visible = rectIntersectionArea(crop, region);
    return sum + (visible + 1e-3 < area ? 1 : 0);
  }, 0);
}

function detectionCoveragePenalty(crop: CropRect, detections: KeepRegion[]): number {
  const faceRegions = detections.filter(d => d.kind === "face").map(d => d.box);
  if (faceRegions.length === 0) return 0;

  let penalty = 0;
  for (const region of faceRegions) {
    const area = Math.max(1, region.width * region.height);
    const visible = rectIntersectionArea(crop, region);
    penalty += 1 - visible / area;
  }
  return penalty / faceRegions.length;
}

function computeCropBudget(
  crop: CropRect,
  imageWidth: number,
  imageHeight: number,
  tile: FillArrangeAssignmentTile,
  detections: KeepRegion[],
): number {
  const sourceArea = Math.max(1, crop.width * crop.height);
  const sourceAspect = safeAspect(crop.width, crop.height);
  const imageArea = Math.max(1, imageWidth * imageHeight);
  const areaRatio = sourceArea / imageArea;
  const extremeLevel = Math.abs(Math.log(sourceAspect));
  const faceFactor = detections.some(d => d.kind === "face") ? 0.55 : 1;
  const tileAreaNorm = clamp(tile.area / Math.max(1, imageArea), 0, 1);
  return clamp(
    (0.3 - extremeLevel * 0.08 - areaRatio * 0.14 - tileAreaNorm * 0.08) * faceFactor,
    0.08,
    0.28,
  );
}

function buildLossBreakdown(
  photo: FillArrangePhotoInput,
  tile: FillArrangeAssignmentTile,
  tileAspect: number,
  crop: CropRect,
): CropLossBreakdown {
  const sourceArea = Math.max(1, photo.crop.width * photo.crop.height);
  const cropArea = Math.max(1, crop.width * crop.height);
  const cropAreaLoss = clamp(1 - cropArea / sourceArea, 0, 1);
  const cropBudget = computeCropBudget(
    photo.crop,
    photo.imageWidth,
    photo.imageHeight,
    tile,
    photo.detections ?? [],
  );
  const sourceAspect = safeAspect(photo.crop.width, photo.crop.height);
  const aspectDeviationPenalty = Math.abs(
    Math.log(Math.max(CROP_AREA_EPSILON, safeAspect(crop.width, crop.height))) -
      Math.log(Math.max(CROP_AREA_EPSILON, sourceAspect)),
  );
  const sourceAreaRatio = clamp(
    sourceArea / Math.max(1, photo.imageWidth * photo.imageHeight),
    0,
    1,
  );
  const extremeBonus = clamp(Math.abs(Math.log(sourceAspect)) / 1.2, 0, 1);
  const largePhotoCropPenalty =
    cropAreaLoss * (0.3 + sourceAreaRatio * 1.9 + extremeBonus * 1.35) +
    Math.max(0, cropAreaLoss - cropBudget) *
      (2 + sourceAreaRatio * 2.2 + extremeBonus * 1.6);
  const centerPreference =
    tile.dist * Math.abs(Math.log(Math.max(CROP_AREA_EPSILON, sourceAspect)));

  return {
    orientationViolation: isFillOrientationReversed(
      buildFillArrangePhotoStrategy(photo.imageWidth, photo.imageHeight).orientation,
      tileAspect,
    ),
    faceCutPenalty: detectionCoveragePenalty(crop, photo.detections ?? []),
    largePhotoCropPenalty,
    aspectDeviationPenalty,
    centerPreference,
    cropAreaLoss,
    cropBudget,
  };
}

function scoreCropDecision(
  losses: CropLossBreakdown,
  constraint: PhotoLayoutConstraint,
): number {
  const sizeWeight = 1 + constraint.sizeRankWeight * 2.4;
  return (
    (losses.orientationViolation ? ORIENTATION_WEIGHT : 0) +
    losses.faceCutPenalty * FACE_CUT_WEIGHT +
    losses.largePhotoCropPenalty * LARGE_PHOTO_WEIGHT * sizeWeight +
    losses.aspectDeviationPenalty * ASPECT_WEIGHT * (1 + constraint.sizeRankWeight * 0.8) +
    losses.centerPreference * CENTER_WEIGHT * constraint.preferredCenterWeight
  );
}

function buildCropDecision(
  photo: FillArrangePhotoInput,
  tile: FillArrangeAssignmentTile,
  constraint: PhotoLayoutConstraint,
): CropDecision {
  const tileAspect = tile.aspect;
  const cropOptions =
    photo.detections && photo.detections.length > 0
      ? { detections: photo.detections }
      : undefined;
  let crop = centerCropToAspect(
    photo.crop,
    tileAspect,
    photo.imageWidth,
    photo.imageHeight,
    cropOptions,
  );
  const cropAspect = safeAspect(crop.width, crop.height);
  if (constraint.orientationClass === "portrait" && cropAspect > 1) {
    crop = centerCropToAspect(
      photo.crop,
      1,
      photo.imageWidth,
      photo.imageHeight,
      cropOptions,
    );
  } else if (constraint.orientationClass === "landscape" && cropAspect < 1) {
    crop = centerCropToAspect(
      photo.crop,
      1,
      photo.imageWidth,
      photo.imageHeight,
      cropOptions,
    );
  }

  const losses = buildLossBreakdown(photo, tile, tileAspect, crop);
  const cropLoss = losses.cropAreaLoss;
  const cutRequiredRegions = countCutRequiredRegions(crop, constraint.requiredKeepRegions);
  const tileOrientation = orientationFromAspect(tileAspect);
  const orientationClassMismatch =
    constraint.orientationClass !== "square" &&
    tileOrientation !== "square" &&
    tileOrientation !== constraint.orientationClass;
  const aspectOutOfRange =
    tileAspect < constraint.minAspect - 1e-3 || tileAspect > constraint.maxAspect + 1e-3;
  const softBudgetExceeded = cropLoss > constraint.softCropBudget;
  const infeasibleReasons: string[] = [];
  if (cutRequiredRegions > 0) infeasibleReasons.push("required-region-cut");
  if (cropLoss > constraint.maxCropLoss) infeasibleReasons.push("crop-loss");
  if (aspectOutOfRange) infeasibleReasons.push("aspect-out-of-range");
  if (losses.orientationViolation) infeasibleReasons.push("orientation");
  const feasible = infeasibleReasons.length === 0;

  return {
    crop,
    mode: getSmartCropMode(photo.detections ?? []),
    losses,
    totalCost: scoreCropDecision(losses, constraint),
    feasible,
    infeasibleReasons,
    cropLoss,
    cutRequiredRegions,
    aspectOutOfRange,
    softBudgetExceeded,
    orientationClassMismatch,
  };
}

function resolveSearchOptions(
  options?: Partial<LayoutSearchOptions>,
  allowCanvasResize?: boolean,
  photoCount: number = 0,
): LayoutSearchOptions {
  const mode = options?.mode ?? defaultModeForPhotoCount(photoCount);
  return {
    ...DEFAULT_SEARCH_OPTIONS,
    ...options,
    mode,
    maxSearchRounds: options?.maxSearchRounds ?? defaultMaxSearchRounds(mode),
    allowCanvasResize:
      allowCanvasResize ?? options?.allowCanvasResize ?? DEFAULT_SEARCH_OPTIONS.allowCanvasResize,
  };
}

function resolveQualityThresholds(
  thresholds?: Partial<LayoutQualityThresholds>,
): LayoutQualityThresholds {
  return { ...DEFAULT_QUALITY_THRESHOLDS, ...thresholds };
}

function canvasDeltaRatio(
  baseW: number,
  baseH: number,
  w: number,
  h: number,
): number {
  return Math.max(
    Math.abs(w - baseW) / Math.max(1, baseW),
    Math.abs(h - baseH) / Math.max(1, baseH),
  );
}

function createCanvasSizes(
  canvasW: number,
  canvasH: number,
  mode: LayoutSearchMode,
  allowCanvasResize: boolean,
  photoCount: number = 0,
): Array<{ w: number; h: number }> {
  if (!allowCanvasResize) return [{ w: canvasW, h: canvasH }];
  const sizes = new Map<string, { w: number; h: number }>();
  const addSize = (sx: number, sy: number) => {
    const w = Math.max(1, Math.round(canvasW * sx));
    const h = Math.max(1, Math.round(canvasH * sy));
    sizes.set(`${w}x${h}`, { w, h });
  };

  if (mode === "deep") {
    const scales =
      photoCount >= 120
        ? [0.94, 0.98, 1, 1.04, 1.08]
        : photoCount >= 72
          ? [0.92, 0.96, 1, 1.04, 1.08]
          : [0.9, 0.94, 0.98, 1, 1.03, 1.08, 1.15];
    for (const scale of scales) addSize(scale, scale);
    const anisotropic =
      photoCount >= 120
        ? [0.98, 1.02]
        : photoCount >= 72
          ? [0.96, 1, 1.04]
          : [0.94, 0.98, 1.02, 1.06];
    for (const sx of anisotropic) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else if (mode === "extended") {
    const scales =
      photoCount >= 120
        ? [0.96, 1, 1.04]
        : photoCount >= 72
          ? [0.94, 0.98, 1, 1.04]
          : [0.94, 0.98, 1, 1.04, 1.08];
    for (const scale of scales) addSize(scale, scale);
    const anisotropic =
      photoCount >= 120
        ? [0.99, 1.01]
        : photoCount >= 72
          ? [0.98, 1.02]
          : [0.98, 1.02, 1.06];
    for (const sx of anisotropic) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else {
    const scales = photoCount >= 120 ? [0.99, 1, 1.01] : [0.98, 1, 1.02];
    for (const scale of scales) addSize(scale, scale);
    for (const sx of [0.99, 1.01]) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  }

  return [...sizes.values()].sort((a, b) => {
    const aspectA = Math.abs(a.w / Math.max(1, a.h) - canvasW / Math.max(1, canvasH));
    const aspectB = Math.abs(b.w / Math.max(1, b.h) - canvasW / Math.max(1, canvasH));
    if (aspectA !== aspectB) return aspectA - aspectB;
    const deltaA = canvasDeltaRatio(canvasW, canvasH, a.w, a.h);
    const deltaB = canvasDeltaRatio(canvasW, canvasH, b.w, b.h);
    if (deltaA !== deltaB) return deltaA - deltaB;
    return Math.abs(a.w * a.h - canvasW * canvasH) - Math.abs(b.w * b.h - canvasW * canvasH);
  });
}

function attemptCountForMode(
  mode: LayoutSearchMode,
  photoCount: number = 0,
): number {
  if (photoCount >= 120) {
    if (mode === "deep") return 4;
    if (mode === "extended") return 4;
    return 3;
  }
  if (photoCount >= 72) {
    if (mode === "deep") return 6;
    if (mode === "extended") return 5;
    return 4;
  }
  if (mode === "deep") return 10;
  if (mode === "extended") return 7;
  return 6;
}

function stagesForMode(mode: LayoutSearchMode): SearchStage[] {
  return mode === "standard" ? ["strict", "relaxed"] : ["strict", "relaxed", "last_resort"];
}

function getElasticProfile(
  mode: LayoutSearchMode,
  photoCount: number = 0,
): ElasticOptimizationProfile {
  if (mode === "deep") {
    if (photoCount >= 120) {
      return {
        rootBudget: 0.12,
        innerBudget: 0.08,
        coarseSteps: [0.01, 0.02, 0.04, 0.06],
        coarseRounds: 2,
        maxPathSplits: 2,
        fineTopK: 1,
        fineIterations: 2,
        allowLocalRetile: false,
        allowContinuousRefinement: true,
        rerunAfterLocalRetile: false,
      };
    }
    if (photoCount >= 72) {
      return {
        rootBudget: 0.13,
        innerBudget: 0.1,
        coarseSteps: [0.01, 0.02, 0.04, 0.06, 0.08],
        coarseRounds: 3,
        maxPathSplits: 3,
        fineTopK: 2,
        fineIterations: 3,
        allowLocalRetile: false,
        allowContinuousRefinement: true,
        rerunAfterLocalRetile: false,
      };
    }
    return {
      rootBudget: 0.15,
      innerBudget: 0.15,
      coarseSteps: [0.01, 0.02, 0.04, 0.06, 0.08, 0.12, 0.15],
      coarseRounds: 4,
      maxPathSplits: 5,
      fineTopK: 3,
      fineIterations: 5,
      allowLocalRetile: true,
      allowContinuousRefinement: true,
      rerunAfterLocalRetile: true,
    };
  }
  if (mode === "extended") {
    if (photoCount >= 120) {
      return {
        rootBudget: 0.08,
        innerBudget: 0.06,
        coarseSteps: [0.01, 0.02, 0.04, 0.06],
        coarseRounds: 2,
        maxPathSplits: 2,
        fineTopK: 1,
        fineIterations: 2,
        allowLocalRetile: false,
        allowContinuousRefinement: true,
        rerunAfterLocalRetile: false,
      };
    }
    if (photoCount >= 72) {
      return {
        rootBudget: 0.09,
        innerBudget: 0.07,
        coarseSteps: [0.01, 0.02, 0.04, 0.06],
        coarseRounds: 2,
        maxPathSplits: 2,
        fineTopK: 1,
        fineIterations: 3,
        allowLocalRetile: false,
        allowContinuousRefinement: true,
        rerunAfterLocalRetile: false,
      };
    }
    return {
      rootBudget: 0.1,
      innerBudget: 0.08,
      coarseSteps: [0.01, 0.02, 0.04, 0.06, 0.08],
      coarseRounds: 2,
      maxPathSplits: 3,
      fineTopK: 1,
      fineIterations: 5,
      allowLocalRetile: true,
      allowContinuousRefinement: true,
      rerunAfterLocalRetile: false,
    };
  }
  return {
    rootBudget: 0.06,
    innerBudget: 0.04,
    coarseSteps: [0.01, 0.02, 0.04, 0.06],
    coarseRounds: 1,
    maxPathSplits: 2,
    fineTopK: 0,
    fineIterations: 0,
    allowLocalRetile: false,
    allowContinuousRefinement: false,
    rerunAfterLocalRetile: false,
  };
}

function createTileOrder(
  tiles: FillRect[],
  canvasW: number,
  canvasH: number,
  leafOrder?: string[],
): OrderedTile[] {
  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;
  return [...tiles]
    .map((tile, idx) => {
      const tileCx = tile.x + tile.w / 2;
      const tileCy = tile.y + tile.h / 2;
      const dist = Math.sqrt((tileCx - canvasCx) ** 2 + (tileCy - canvasCy) ** 2);
      return {
        tile,
        dist: dist / maxDist,
        leafId: leafOrder?.[idx] ?? `${TREE_ID_PREFIX}-leaf-${idx}`,
      };
    })
    .sort((a, b) => a.dist - b.dist);
}

function createTileOrderFromLayout(
  layout: TileLayoutCandidate,
  canvasW: number,
  canvasH: number,
): OrderedTile[] {
  return createTileOrder(layout.tiles, canvasW, canvasH, layout.leafOrder);
}

function findSplitPathToLeaf(
  tree: TileLayoutTree,
  leafId: string,
  depth: number = 0,
): Array<{ id: string; depth: number }> {
  if (tree.kind === "leaf") return tree.id === leafId ? [] : [];
  if (!tree.leafIds.includes(leafId)) return [];
  const childPath =
    tree.children[0].leafIds.includes(leafId)
      ? findSplitPathToLeaf(tree.children[0], leafId, depth + 1)
      : findSplitPathToLeaf(tree.children[1], leafId, depth + 1);
  return [{ id: tree.id, depth }, ...childPath];
}

function findNodeById(tree: TileLayoutTree, id: string): TileLayoutTree | null {
  if (tree.id === id) return tree;
  if (tree.kind === "leaf") return null;
  return findNodeById(tree.children[0], id) ?? findNodeById(tree.children[1], id);
}

function findNodeDepth(
  tree: TileLayoutTree,
  id: string,
  depth: number = 0,
): number | null {
  if (tree.id === id) return depth;
  if (tree.kind === "leaf") return null;
  return (
    findNodeDepth(tree.children[0], id, depth + 1) ??
    findNodeDepth(tree.children[1], id, depth + 1)
  );
}

function replaceSubtree(
  tree: TileLayoutTree,
  targetId: string,
  nextTree: TileLayoutTree,
): TileLayoutTree {
  if (tree.id === targetId) return rebuildTreeBounds(nextTree, tree.bounds);
  if (tree.kind === "leaf") return tree;
  const left = replaceSubtree(tree.children[0], targetId, nextTree);
  const right = replaceSubtree(tree.children[1], targetId, nextTree);
  return buildSplitNode(
    tree.id,
    tree.axis,
    tree.bounds,
    tree.ratio,
    tree.baseRatio,
    [left, right],
  );
}

function applyLeafIdsToTree(
  tree: TileLayoutTree,
  leafIds: string[],
): TileLayoutTree {
  let index = 0;
  const assign = (node: TileLayoutTree): TileLayoutTree => {
    if (node.kind === "leaf") {
      const id = leafIds[index++] ?? node.id;
      return { ...node, id, leafIds: [id] };
    }
    const left = assign(node.children[0]);
    const right = assign(node.children[1]);
    return buildSplitNode(
      node.id,
      node.axis,
      node.bounds,
      node.ratio,
      node.baseRatio,
      [left, right],
    );
  };
  return assign(tree);
}

function collectOptimizableSplitIds(
  candidate: Candidate,
  maxCount: number,
): string[] {
  const leafIds = [
    candidate.diagnostics.worstLeafId,
    ...candidate.diagnostics.topSoftCropLeafIds,
  ].filter((id): id is string => !!id);
  const collected: Array<{ id: string; depth: number }> = [];
  const seen = new Set<string>();
  for (const leafId of leafIds) {
    const path = findSplitPathToLeaf(candidate.tree, leafId)
      .sort((a, b) => b.depth - a.depth);
    for (const item of path) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      collected.push(item);
      if (collected.length >= maxCount) return collected.map(entry => entry.id);
    }
  }
  return collected.map(entry => entry.id);
}

function getElasticBoundsForSplit(
  node: SplitNode,
  depth: number,
  profile: ElasticOptimizationProfile,
): { min: number; max: number } {
  const budget = depth === 0 ? profile.rootBudget : profile.innerBudget;
  return {
    min: Math.max(node.minRatio, node.baseRatio - budget),
    max: Math.min(node.maxRatio, node.baseRatio + budget),
  };
}

function updateTreeSplitRatio(
  tree: TileLayoutTree,
  targetId: string,
  targetRatio: number,
): TileLayoutTree {
  if (tree.kind === "leaf") return tree;
  if (tree.id === targetId) {
    return rebuildTreeBounds({ ...tree, ratio: targetRatio }, tree.bounds);
  }
  const left = updateTreeSplitRatio(tree.children[0], targetId, targetRatio);
  const right = updateTreeSplitRatio(tree.children[1], targetId, targetRatio);
  return buildSplitNode(
    tree.id,
    tree.axis,
    tree.bounds,
    tree.ratio,
    tree.baseRatio,
    [left, right],
  );
}

function decisionCacheKey(
  photoId: string,
  tile: FillArrangeAssignmentTile,
  stage: SearchStage,
): string {
  return `${photoId}|${tile.aspect.toFixed(4)}|${tile.area}|${tile.dist.toFixed(4)}|${stage}`;
}

function decisionFor(
  ctx: SolverContext,
  photoId: string,
  tile: FillArrangeAssignmentTile,
  stage: SearchStage,
): CropDecision {
  const key = decisionCacheKey(photoId, tile, stage);
  const cached = ctx.decisionCache.get(key);
  if (cached) return cached;
  const photo = ctx.photoById.get(photoId);
  const constraint = ctx.constraintById.get(photoId);
  if (!photo || !constraint) throw new Error(`missing photo strategy for ${photoId}`);
  const decision = buildCropDecision(photo, tile, constraint);
  ctx.decisionCache.set(key, decision);
  return decision;
}

function isAllowedByStage(
  decision: CropDecision,
  constraint: PhotoLayoutConstraint,
  stage: SearchStage,
): boolean {
  if (stage === "strict") return decision.feasible;
  if (stage === "relaxed") {
    return (
      !decision.losses.orientationViolation &&
      !decision.aspectOutOfRange &&
      !decision.orientationClassMismatch &&
      decision.cutRequiredRegions === 0 &&
      decision.cropLoss <= constraint.maxCropLoss * 1.35
    );
  }
  return !decision.losses.orientationViolation && decision.cutRequiredRegions === 0;
}

function pairCostByStage(
  decision: CropDecision,
  constraint: PhotoLayoutConstraint,
  stage: SearchStage,
): number {
  const softOver = Math.max(0, decision.cropLoss - constraint.softCropBudget);
  const hardOver = Math.max(0, decision.cropLoss - constraint.maxCropLoss);
  const sizeWeight = 1 + constraint.sizeRankWeight * 1.8;
  const softPenalty = softOver * 60_000 * sizeWeight;
  const hardPenalty = hardOver * 180_000 * sizeWeight;
  const aspectPenalty = decision.aspectOutOfRange ? 80_000 : 0;
  const mismatchPenalty = decision.orientationClassMismatch ? 60_000 : 0;

  if (stage === "strict") {
    return decision.totalCost + softPenalty * 2 + hardPenalty * 4;
  }
  if (stage === "relaxed") {
    return decision.totalCost + softPenalty * 1.5 + hardPenalty * 2.5 + mismatchPenalty;
  }
  return decision.totalCost + softPenalty + hardPenalty * 2 + aspectPenalty + mismatchPenalty;
}

function buildCandidateDiagnostics(
  decisions: CropDecision[],
  tileOrder: OrderedTile[],
  tileToPhotoIndex: number[],
  photos: FillArrangePhotoInput[],
): CandidateDiagnostics {
  const ranked = decisions
    .map((decision, idx) => ({ idx, cropLoss: decision.cropLoss }))
    .sort((a, b) => b.cropLoss - a.cropLoss);
  const worstTileIndex = ranked[0]?.idx ?? 0;
  const topSoftCropTileIndices = ranked
    .filter(item => item.cropLoss > SOFT_CROP_THRESHOLD)
    .slice(0, 3)
    .map(item => item.idx);
  const worstLeafId = tileOrder[worstTileIndex]?.leafId;
  const topSoftCropPhotoIds = topSoftCropTileIndices.map(
    idx => photos[tileToPhotoIndex[idx]]?.id ?? "",
  ).filter(Boolean);
  const topSoftCropLeafIds = topSoftCropTileIndices.map(
    idx => tileOrder[idx]?.leafId ?? "",
  ).filter(Boolean);
  return {
    worstTileIndex,
    worstLeafId,
    topSoftCropTileIndices,
    topSoftCropPhotoIds,
    topSoftCropLeafIds,
  };
}

function summarizeLayoutQuality(
  decisions: CropDecision[],
  tileOrder: OrderedTile[],
  tileToPhotoIndex: number[],
  photos: FillArrangePhotoInput[],
  constraintById: Map<string, PhotoLayoutConstraint>,
  thresholds: LayoutQualityThresholds,
  baseCanvasW: number,
  baseCanvasH: number,
  canvasW: number,
  canvasH: number,
  orientationViolations: number,
): LayoutQualitySummary {
  const worstEntry = decisions.reduce(
    (best, decision, idx) =>
      !best || decision.cropLoss > best.cropLoss ? { idx, cropLoss: decision.cropLoss } : best,
    null as { idx: number; cropLoss: number } | null,
  );
  const worstCropLoss = worstEntry?.cropLoss ?? 0;
  const averageCropLoss =
    decisions.reduce((sum, decision) => sum + decision.cropLoss, 0) /
    Math.max(1, decisions.length);
  const weightedCrop = decisions.reduce(
    (sum, decision, idx) => {
      const photoId = photos[tileToPhotoIndex[idx]]?.id;
      const constraint = photoId ? constraintById.get(photoId) : null;
      const weight = 1 + (constraint?.sizeRankWeight ?? 0) * 2.4;
      return {
        weightedLoss: sum.weightedLoss + decision.cropLoss * weight,
        totalWeight: sum.totalWeight + weight,
      };
    },
    { weightedLoss: 0, totalWeight: 0 },
  );
  const sizeWeightedAverageCropLoss =
    weightedCrop.weightedLoss / Math.max(1e-6, weightedCrop.totalWeight);
  const photosOverSoftCropThreshold = decisions.filter(
    decision => decision.cropLoss > SOFT_CROP_THRESHOLD,
  ).length;
  const photosOverCropThreshold = decisions.filter(
    decision => decision.cropLoss > thresholds.maxWorstCropLoss,
  ).length;
  const photosCutRequiredRegions = decisions.filter(
    decision => decision.cutRequiredRegions > 0,
  ).length;
  const canvasDelta = canvasDeltaRatio(baseCanvasW, baseCanvasH, canvasW, canvasH);
  let accepted = true;
  let reason = "";
  if (thresholds.requireKeepRegionsFullyVisible && photosCutRequiredRegions > 0) {
    accepted = false;
    reason = "required-regions-cut";
  } else if (photosOverCropThreshold > thresholds.maxPhotosOverCropThreshold) {
    accepted = false;
    reason = "too-many-over-crop";
  } else if (worstCropLoss > thresholds.maxWorstCropLoss) {
    accepted = false;
    reason = "worst-crop-loss";
  } else if (averageCropLoss > thresholds.maxAverageCropLoss) {
    accepted = false;
    reason = "average-crop-loss";
  }

  return {
    worstCropLoss,
    averageCropLoss,
    sizeWeightedAverageCropLoss,
    photosOverSoftCropThreshold,
    photosOverCropThreshold,
    photosCutRequiredRegions,
    orientationViolations,
    canvasDeltaRatio: canvasDelta,
    softCropThreshold: SOFT_CROP_THRESHOLD,
    worstCropPhotoId:
      worstEntry != null ? photos[tileToPhotoIndex[worstEntry.idx]]?.id : undefined,
    worstCropTileAspect:
      worstEntry != null
        ? safeAspect(tileOrder[worstEntry.idx].tile.w, tileOrder[worstEntry.idx].tile.h)
        : undefined,
    accepted,
    reason: reason || undefined,
  };
}

function compareCandidate(a: Candidate, b: Candidate): number {
  const compareFields: Array<keyof LayoutQualitySummary> = [
    "photosCutRequiredRegions",
    "worstCropLoss",
    "photosOverSoftCropThreshold",
    "photosOverCropThreshold",
    "sizeWeightedAverageCropLoss",
    "averageCropLoss",
  ];
  for (const key of compareFields) {
    const av = a.quality[key] as number;
    const bv = b.quality[key] as number;
    if (av !== bv) return av - bv;
  }
  if (a.seamMovementPenalty !== b.seamMovementPenalty) {
    return a.seamMovementPenalty - b.seamMovementPenalty;
  }
  if (a.quality.orientationViolations !== b.quality.orientationViolations) {
    return a.quality.orientationViolations - b.quality.orientationViolations;
  }
  if (a.quality.canvasDeltaRatio !== b.quality.canvasDeltaRatio) {
    return a.quality.canvasDeltaRatio - b.quality.canvasDeltaRatio;
  }
  return a.totalCost - b.totalCost;
}

function buildPlacements(
  photos: FillArrangePhotoInput[],
  tileOrder: OrderedTile[],
  tileToPhotoIndex: number[],
  cropDecisions: CropDecision[],
): Placement[] {
  return tileOrder.map(({ tile }, tileIdx) => {
    const photo = photos[tileToPhotoIndex[tileIdx]];
    const decision = cropDecisions[tileIdx];
    const crop = decision?.crop ?? photo.crop;
    const scale = Math.max(tile.w / crop.width, tile.h / crop.height);
    return {
      id: photo.id,
      cx: tile.x + tile.w / 2,
      cy: tile.y + tile.h / 2,
      scale,
      rotation: 0,
      crop,
      tileRect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    };
  });
}

function validatePlacements(
  tileOrder: OrderedTile[],
  placements: Placement[],
  cw: number,
  ch: number,
): boolean {
  return validateFillArrangePlacements(
    tileOrder.map((item, idx) => ({ tile: item.tile, placement: placements[idx] })),
    cw,
    ch,
    { coverMode: true },
  ).ok;
}

function buildCandidateFromAssignment(
  ctx: SolverContext,
  tree: TileLayoutTree,
  tileOrder: OrderedTile[],
  tileToPhotoIndex: number[],
  cw: number,
  ch: number,
  stage: SearchStage,
  metrics: LayoutMetrics,
): Candidate | null {
  const cropDecisions = tileOrder.map((orderedTile, tileIdx) => {
    const photo = ctx.photoFeatures[tileToPhotoIndex[tileIdx]];
    return decisionFor(
      ctx,
      photo.photo.id,
      {
        aspect: orderedTile.tile.w / Math.max(1, orderedTile.tile.h),
        dist: orderedTile.dist,
        area: orderedTile.tile.w * orderedTile.tile.h,
      },
      stage,
    );
  });
  const orientationViolations = cropDecisions.filter(
    decision => decision.losses.orientationViolation,
  ).length;
  const totalCost = cropDecisions.reduce((sum, decision, idx) => {
    const photo = ctx.photoFeatures[tileToPhotoIndex[idx]];
    return sum + pairCostByStage(decision, photo.constraint, stage);
  }, 0);
  const placements = buildPlacements(ctx.photos, tileOrder, tileToPhotoIndex, cropDecisions);
  if (!validatePlacements(tileOrder, placements, cw, ch)) return null;

  const quality = summarizeLayoutQuality(
    cropDecisions,
    tileOrder,
    tileToPhotoIndex,
    ctx.photos,
    ctx.constraintById,
    ctx.qualityThresholds,
    ctx.baseCanvasW,
    ctx.baseCanvasH,
    cw,
    ch,
    orientationViolations,
  );
  const diagnostics = buildCandidateDiagnostics(
    cropDecisions,
    tileOrder,
    tileToPhotoIndex,
    ctx.photos,
  );
  return {
    tree,
    tileOrder,
    tileToPhotoIndex,
    cropDecisions,
    orientationViolations,
    totalCost,
    seamMovementPenalty: getSeamMovementPenalty(tree),
    cw,
    ch,
    metrics,
    quality,
    diagnostics,
    stage,
  };
}

function solveAssignmentForLayout(
  ctx: SolverContext,
  layout: TileLayoutCandidate,
  cw: number,
  ch: number,
  stage: SearchStage,
  canvasAdjustmentsTried: number,
  metricSeed: LayoutMetrics = emptyMetrics(canvasAdjustmentsTried),
): Candidate | null {
  let evaluatedPairs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const tileOrder = createTileOrderFromLayout(layout, cw, ch);
  const assignmentPhotos: FillArrangeAssignmentPhoto[] = ctx.photoFeatures.map(item => ({
    id: item.photo.id,
    sourceAspect: item.strategy.sourceAspect,
    preferredAspect: item.constraint.idealAspect,
    orientation: item.strategy.orientation,
    isExtreme: item.strategy.isExtreme,
  }));
  const assignmentTiles: FillArrangeAssignmentTile[] = tileOrder.map(({ tile, dist }) => ({
    aspect: tile.w / Math.max(1, tile.h),
    dist,
    area: tile.w * tile.h,
  }));
  const trackedDecisionFor = (photoId: string, tile: FillArrangeAssignmentTile) => {
    evaluatedPairs++;
    const key = decisionCacheKey(photoId, tile, stage);
    if (ctx.decisionCache.has(key)) {
      cacheHits++;
    } else {
      cacheMisses++;
    }
    return decisionFor(ctx, photoId, tile, stage);
  };

  let tileToPhotoIndex: number[];
  try {
    tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
      nonExtremeWeight: 1.1,
      centerBiasWeight: CENTER_BIAS_WEIGHT,
      edgeBiasWeight: EDGE_BIAS_WEIGHT,
      orientationPenalty: stage === "strict" ? 40 : stage === "relaxed" ? 120 : 180,
      isPairAllowed: (photoStrategy, tile) => {
        const decision = trackedDecisionFor(photoStrategy.id, tile);
        const constraint = ctx.constraintById.get(photoStrategy.id)!;
        return isAllowedByStage(decision, constraint, stage);
      },
      evaluatePair: (photoStrategy, tile) => {
        const decision = trackedDecisionFor(photoStrategy.id, tile);
        const constraint = ctx.constraintById.get(photoStrategy.id)!;
        return pairCostByStage(decision, constraint, stage);
      },
    });
  } catch {
    return null;
  }

  return buildCandidateFromAssignment(
    ctx,
    layout.tree,
    tileOrder,
    tileToPhotoIndex,
    cw,
    ch,
    stage,
    mergeMetrics(metricSeed, {
      evaluatedPairs,
      cacheHits,
      cacheMisses,
      orientationViolations: 0,
      canvasAdjustmentsTried,
    }),
  );
}

function tryAdjacentSwapRepair(
  ctx: SolverContext,
  candidate: Candidate,
): Candidate {
  if (candidate.quality.photosOverCropThreshold > 3) return candidate;
  let best = candidate;
  for (let i = 0; i < candidate.tileToPhotoIndex.length - 1; i++) {
    const swapped = [...candidate.tileToPhotoIndex];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    const repaired = buildCandidateFromAssignment(
      ctx,
      candidate.tree,
      candidate.tileOrder,
      swapped,
      candidate.cw,
      candidate.ch,
      candidate.stage,
      candidate.metrics,
    );
    if (repaired && compareCandidate(repaired, best) < 0) best = repaired;
  }
  return best;
}

function tryLocalRetileRepair(
  ctx: SolverContext,
  candidate: Candidate,
  randSeed: number,
  profile: ElasticOptimizationProfile,
): Candidate {
  if (!profile.allowLocalRetile) return candidate;
  let best = candidate;
  let localRetileAccepted = 0;
  const anchors = [
    candidate.diagnostics.worstLeafId,
    ...candidate.diagnostics.topSoftCropLeafIds,
  ].filter((id): id is string => !!id).slice(0, 2);
  let attempts = 0;

  const findRetileSplit = (
    tree: TileLayoutTree,
    leafId: string,
  ): SplitNode | null => {
    let bestNode: SplitNode | null = null;
    const walk = (node: TileLayoutTree) => {
      if (node.kind === "leaf" || !node.leafIds.includes(leafId)) return;
      if (node.leafIds.length >= 2 && node.leafIds.length <= 4) {
        if (!bestNode || node.leafIds.length < bestNode.leafIds.length) {
          bestNode = node;
        }
      }
      walk(node.children[0]);
      walk(node.children[1]);
    };
    walk(tree);
    return bestNode;
  };

  for (const anchorLeafId of anchors) {
    if (attempts >= 2) break;
    const target = findRetileSplit(best.tree, anchorLeafId);
    if (!target) continue;

    const subsetPhotoIndices = target.leafIds.map(leafId => {
      const tileIdx = best.tileOrder.findIndex(entry => entry.leafId === leafId);
      return tileIdx >= 0 ? best.tileToPhotoIndex[tileIdx] : -1;
    });
    if (subsetPhotoIndices.some(idx => idx < 0)) continue;
    const subsetFeatures = subsetPhotoIndices.map(idx => ctx.photoFeatures[idx]);
    const localTileProfile = buildTileProfileFromPhotos(
      subsetFeatures,
      subsetPhotoIndices.map(idx => ctx.photos[idx]?.id ?? "").filter(Boolean),
    );
    let localSeed = (randSeed + attempts * 2654435761) >>> 0;
    const localRand = () => {
      localSeed = (localSeed * 1664525 + 1013904223) >>> 0;
      return localSeed / 2 ** 32;
    };
    const relativeRoot = { x: 0, y: 0, w: target.bounds.w, h: target.bounds.h };
    const tileSets = [
      buildTilesFromProfile(
        target.leafIds.length,
        relativeRoot.w,
        relativeRoot.h,
        localTileProfile,
        localRand,
      ),
      partitionRectToTiles(relativeRoot, target.leafIds.length, localRand, 0.38, 0.62),
      buildFallbackGridTiles(target.leafIds.length, relativeRoot.w, relativeRoot.h),
    ];

    for (const tiles of tileSets) {
      const absoluteTiles = tiles.map(tile => ({
        x: tile.x + target.bounds.x,
        y: tile.y + target.bounds.y,
        w: tile.w,
        h: tile.h,
      }));
      const localLayout = createLayoutCandidateForTiles(target.bounds, absoluteTiles);
      if (!localLayout) {
        continue;
      }
      const remappedLocalTree = applyLeafIdsToTree(localLayout.tree, target.leafIds);
      const nextTree = replaceSubtree(best.tree, target.id, remappedLocalTree);
      const repaired = solveAssignmentForLayout(
        ctx,
        createLayoutCandidateFromTree(nextTree),
        best.cw,
        best.ch,
        best.stage,
        0,
        best.metrics,
      );
      if (repaired && compareCandidate(repaired, best) < 0) {
        best = repaired;
        localRetileAccepted++;
      }
    }
    attempts++;
  }

  return localRetileAccepted > 0
    ? { ...best, metrics: mergeMetrics(best.metrics, { localRetileAccepted }) }
    : best;
}

function optimizeElasticSeams(
  ctx: SolverContext,
  candidate: Candidate,
  profile: ElasticOptimizationProfile,
): Candidate {
  if (candidate.tree.kind === "leaf") return candidate;
  let best = candidate;
  let elasticTrials = 0;
  let elasticAccepted = 0;
  let continuousRefinements = 0;

  const evaluateTree = (
    tree: TileLayoutTree,
    isContinuous: boolean = false,
  ): Candidate | null => {
    elasticTrials++;
    if (isContinuous) continuousRefinements++;
    return solveAssignmentForLayout(
      ctx,
      createLayoutCandidateFromTree(tree),
      best.cw,
      best.ch,
      best.stage,
      0,
      best.metrics,
    );
  };

  for (let round = 0; round < profile.coarseRounds; round++) {
    const splitIds = collectOptimizableSplitIds(best, profile.maxPathSplits);
    if (splitIds.length === 0) break;
    let improved = false;

    for (const splitId of splitIds) {
      const node = findNodeById(best.tree, splitId);
      if (!node || node.kind === "leaf") continue;
      const depth = findNodeDepth(best.tree, splitId) ?? 0;
      const { min, max } = getElasticBoundsForSplit(node, depth, profile);
      if (max - min < 1e-4) continue;

      for (const step of profile.coarseSteps) {
        for (const sign of [-1, 1] as const) {
          const nextRatio = clamp(node.baseRatio + step * sign, min, max);
          if (Math.abs(nextRatio - node.ratio) < 1e-4) continue;
          const refined = evaluateTree(
            updateTreeSplitRatio(best.tree, splitId, nextRatio),
          );
          if (refined && compareCandidate(refined, best) < 0) {
            best = refined;
            elasticAccepted++;
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }

  if (profile.allowContinuousRefinement && profile.fineTopK > 0) {
    const splitIds = collectOptimizableSplitIds(best, profile.fineTopK);
    for (const splitId of splitIds) {
      const node = findNodeById(best.tree, splitId);
      if (!node || node.kind === "leaf") continue;
      const depth = findNodeDepth(best.tree, splitId) ?? 0;
      let { min, max } = getElasticBoundsForSplit(node, depth, profile);
      if (max - min < 1e-4) continue;

      for (let iteration = 0; iteration < profile.fineIterations; iteration++) {
        const leftRatio = min + (max - min) / 3;
        const rightRatio = max - (max - min) / 3;
        const leftCandidate = evaluateTree(
          updateTreeSplitRatio(best.tree, splitId, leftRatio),
          true,
        );
        const rightCandidate = evaluateTree(
          updateTreeSplitRatio(best.tree, splitId, rightRatio),
          true,
        );
        const better =
          leftCandidate && rightCandidate
            ? compareCandidate(leftCandidate, rightCandidate) <= 0
              ? leftCandidate
              : rightCandidate
            : leftCandidate ?? rightCandidate;
        if (better && compareCandidate(better, best) < 0) {
          best = better;
          elasticAccepted++;
        }
        if (
          leftCandidate &&
          rightCandidate &&
          compareCandidate(leftCandidate, rightCandidate) <= 0
        ) {
          max = rightRatio;
        } else {
          min = leftRatio;
        }
      }
    }
  }

  if (elasticTrials === 0 && continuousRefinements === 0) return best;
  return {
    ...best,
    metrics: mergeMetrics(best.metrics, {
      elasticTrials,
      elasticAccepted,
      continuousRefinements,
    }),
  };
}

function buildTileSetsForStage(
  root: FillRect,
  count: number,
  rand: () => number,
  ratioMin: number,
  ratioMax: number,
  profile: TileProfile,
  priorityPhotoIds: string[],
  photoFeatures: PhotoFeature[],
  mode: LayoutSearchMode,
  attempt: number,
): TileLayoutCandidate[] {
  const sets: TileLayoutCandidate[] = [];
  const pushTiles = (tiles: FillRect[]) => {
    const layout = createLayoutCandidateForTiles(root, tiles);
    if (layout) sets.push(layout);
  };
  if (attempt % 2 === 0) {
    pushTiles(partitionRectToTiles(root, count, rand, ratioMin, ratioMax));
  }
  pushTiles(buildTilesFromProfile(count, root.w, root.h, profile, rand));
  if (attempt === 0) {
    const stripTiles = buildStripTilesFromProfile(count, root.w, root.h, profile, rand);
    if (stripTiles) pushTiles(stripTiles);
  }
  if (mode === "deep") {
    pushTiles(
      reserveTilesForPriorityPhotos(
        count,
        root.w,
        root.h,
        profile,
        rand,
        priorityPhotoIds,
        photoFeatures,
      ),
    );
  }
  return sets;
}

export function fillArrangePhotosShared(
  photos: FillArrangePhotoInput[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeOptions = {},
): FillArrangeResult {
  const n = photos.length;
  const searchOptions = resolveSearchOptions(
    options.searchOptions,
    options.allowCanvasResize,
    photos.length,
  );
  const qualityThresholds = resolveQualityThresholds(options.qualityThresholds);
  if (n === 0) {
    return {
      placements: [],
      canvasW,
      canvasH,
      metrics: {
        evaluatedPairs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        orientationViolations: 0,
        canvasAdjustmentsTried: 1,
        elasticTrials: 0,
        elasticAccepted: 0,
        localRetileAccepted: 0,
        continuousRefinements: 0,
      },
      quality: {
        worstCropLoss: 0,
        averageCropLoss: 0,
        sizeWeightedAverageCropLoss: 0,
        photosOverSoftCropThreshold: 0,
        photosOverCropThreshold: 0,
        photosCutRequiredRegions: 0,
        orientationViolations: 0,
        canvasDeltaRatio: 0,
        softCropThreshold: SOFT_CROP_THRESHOLD,
        accepted: true,
      },
    };
  }

  const ratioMin = clamp(options.splitRatioMin ?? 0.38, 0.2, 0.49);
  const ratioMax = clamp(options.splitRatioMax ?? 0.62, 0.51, 0.8);
  const baseSeed = options.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const canvasSizes = createCanvasSizes(
    canvasW,
    canvasH,
    searchOptions.mode,
    searchOptions.allowCanvasResize,
    photos.length,
  );

  const photoFeatures = photos.map(photo => ({
    photo,
    strategy: buildFillArrangePhotoStrategy(photo.imageWidth, photo.imageHeight),
    constraint: buildPhotoLayoutConstraint({
      imageWidth: photo.imageWidth,
      imageHeight: photo.imageHeight,
      crop: photo.crop,
      detections: photo.detections,
    }),
    sourceArea: photo.crop.width * photo.crop.height,
  }));
  [...photoFeatures]
    .sort((a, b) => b.sourceArea - a.sourceArea)
    .forEach((item, rank) => {
      item.constraint.sizeRankWeight = 1 - rank / Math.max(1, photoFeatures.length - 1);
      item.constraint.softCropBudget = Math.min(
        item.constraint.softCropBudget,
        item.constraint.maxCropLoss * (0.72 - item.constraint.sizeRankWeight * 0.22),
      );
    });

  const ctx: SolverContext = {
    photos,
    photoFeatures,
    photoById: new Map(photoFeatures.map(item => [item.photo.id, item.photo])),
    constraintById: new Map(photoFeatures.map(item => [item.photo.id, item.constraint])),
    photoIndexById: new Map(photoFeatures.map((item, idx) => [item.photo.id, idx])),
    qualityThresholds,
    baseCanvasW: canvasW,
    baseCanvasH: canvasH,
    decisionCache: new Map<string, CropDecision>(),
  };

  let bestCandidate: Candidate | null = null;
  const stages = stagesForMode(searchOptions.mode);
  const elasticProfile = getElasticProfile(searchOptions.mode, photos.length);
  const maxPartitionAttempts = Math.min(
    searchOptions.maxSearchRounds,
    attemptCountForMode(searchOptions.mode, photos.length),
  );

  for (const stage of stages) {
    let stageBest: Candidate | null = null;
    const priorityPhotoIds =
      searchOptions.mode === "deep" && bestCandidate
        ? [
            bestCandidate.quality.worstCropPhotoId,
            ...bestCandidate.diagnostics.topSoftCropPhotoIds,
          ].filter((id): id is string => !!id)
        : [];

    for (const { w: cW, h: cH } of canvasSizes) {
      const root: FillRect = { x: 0, y: 0, w: cW, h: cH };
      const tileProfile = buildTileProfileFromPhotos(photoFeatures, priorityPhotoIds);
      let producedCandidate = false;
      let canvasBest: Candidate | null = null;

      for (let attempt = 0; attempt < maxPartitionAttempts; attempt++) {
        let seed = (baseSeed + attempt * 2246822519 + stage.length * 977) >>> 0;
        const rand = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 2 ** 32;
        };
        const tileSets = buildTileSetsForStage(
          root,
          n,
          rand,
          ratioMin,
          ratioMax,
          tileProfile,
          priorityPhotoIds,
          photoFeatures,
          searchOptions.mode,
          attempt,
        );

        for (const layout of tileSets) {
          const candidate = solveAssignmentForLayout(
            ctx,
            layout,
            cW,
            cH,
            stage,
            canvasSizes.length,
          );
          if (!candidate) continue;
          producedCandidate = true;
          if (!canvasBest || compareCandidate(candidate, canvasBest) < 0) {
            canvasBest = candidate;
          }

          if (
            canvasBest.quality.accepted &&
            canvasBest.quality.worstCropLoss <= SOFT_CROP_THRESHOLD + 1e-6 &&
            canvasBest.quality.photosOverSoftCropThreshold === 0
          ) {
            break;
          }
        }

        if (
          canvasBest?.quality.accepted &&
          canvasBest.quality.worstCropLoss <= SOFT_CROP_THRESHOLD + 1e-6 &&
          canvasBest.quality.photosOverSoftCropThreshold === 0
        ) {
          break;
        }
      }

      if (!producedCandidate) {
        const fallbackLayout = createLayoutCandidateForTiles(
          root,
          buildFallbackGridTiles(n, cW, cH),
        );
        const fallback = fallbackLayout
          ? solveAssignmentForLayout(
              ctx,
              fallbackLayout,
              cW,
              cH,
              stage,
              canvasSizes.length,
            )
          : null;
        if (fallback) {
          canvasBest = fallback;
        }
      }

      if (canvasBest && searchOptions.allowLocalRepair) {
        let repaired = canvasBest;
        if (searchOptions.mode !== "standard" || n <= 8) {
          repaired = tryAdjacentSwapRepair(ctx, repaired);
        }
        repaired = optimizeElasticSeams(ctx, repaired, elasticProfile);
        const shouldRetile =
          elasticProfile.allowLocalRetile &&
          (searchOptions.mode === "extended"
            ? repaired.quality.photosOverSoftCropThreshold > 0
            : repaired.quality.photosOverSoftCropThreshold > 0 ||
              repaired.quality.worstCropLoss >
                repaired.quality.softCropThreshold + 1e-6);
        if (shouldRetile) {
          repaired = tryLocalRetileRepair(ctx, repaired, baseSeed ^ cW ^ cH, elasticProfile);
          if (elasticProfile.rerunAfterLocalRetile) {
            repaired = optimizeElasticSeams(ctx, repaired, elasticProfile);
          }
        }
        if (compareCandidate(repaired, canvasBest) < 0) {
          canvasBest = repaired;
        } else {
          canvasBest = { ...canvasBest, metrics: repaired.metrics };
        }
      }

      if (canvasBest && (!stageBest || compareCandidate(canvasBest, stageBest) < 0)) {
        stageBest = canvasBest;
      }

      if (
        stageBest?.quality.accepted &&
        stageBest.quality.worstCropLoss <= SOFT_CROP_THRESHOLD + 1e-6 &&
        stageBest.quality.photosOverSoftCropThreshold === 0
      ) {
        break;
      }
    }

    if (stageBest && (!bestCandidate || compareCandidate(stageBest, bestCandidate) < 0)) {
      bestCandidate = stageBest;
    }
    if (stageBest?.quality.accepted) {
      bestCandidate = stageBest;
      break;
    }
  }

  const candidate =
    bestCandidate ??
    (() => {
      const fallbackLayout = createLayoutCandidateForTiles(
        { x: 0, y: 0, w: canvasW, h: canvasH },
        buildFallbackGridTiles(n, canvasW, canvasH),
      );
      return fallbackLayout
        ? solveAssignmentForLayout(
            ctx,
            fallbackLayout,
            canvasW,
            canvasH,
            searchOptions.mode === "standard" ? "relaxed" : "last_resort",
            canvasSizes.length,
          )
        : null;
    })();

  const fallbackLayout =
    createLayoutCandidateForTiles(
      { x: 0, y: 0, w: canvasW, h: canvasH },
      buildFallbackGridTiles(n, canvasW, canvasH),
    ) ??
    createLayoutCandidateFromTree(
      buildLeafNode(
        `${TREE_ID_PREFIX}-fallback`,
        { x: 0, y: 0, w: canvasW, h: canvasH },
        1,
      ),
    );
  const resolvedCandidate =
    candidate ??
    buildCandidateFromAssignment(
      ctx,
      fallbackLayout.tree,
      createTileOrderFromLayout(fallbackLayout, canvasW, canvasH),
      photos.map((_, idx) => idx),
      canvasW,
      canvasH,
      searchOptions.mode === "standard" ? "relaxed" : "last_resort",
      {
        evaluatedPairs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        orientationViolations: 0,
        canvasAdjustmentsTried: canvasSizes.length,
        elasticTrials: 0,
        elasticAccepted: 0,
        localRetileAccepted: 0,
        continuousRefinements: 0,
      },
    );

  if (!resolvedCandidate) {
    throw new Error("fillArrange failed: no valid candidate");
  }

  return {
    placements: buildPlacements(
      photos,
      resolvedCandidate.tileOrder,
      resolvedCandidate.tileToPhotoIndex,
      resolvedCandidate.cropDecisions,
    ),
    canvasW: resolvedCandidate.cw,
    canvasH: resolvedCandidate.ch,
    metrics: {
      ...resolvedCandidate.metrics,
      orientationViolations: resolvedCandidate.orientationViolations,
    },
    quality: resolvedCandidate.quality,
  };
}
