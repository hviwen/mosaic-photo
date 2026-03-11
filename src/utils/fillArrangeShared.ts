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
type OrderedTile = { tile: FillRect; dist: number };
type SearchStage = "strict" | "relaxed" | "last_resort";
type OrientationClass = PhotoLayoutConstraint["orientationClass"];

type TileProfile = {
  landscapeCount: number;
  portraitCount: number;
  squareCount: number;
  largeReserveCount: number;
  highRiskReserveCount: number;
  targets: OrientationClass[];
};

type CandidateDiagnostics = {
  worstTileIndex: number;
  topSoftCropTileIndices: number[];
  topSoftCropPhotoIds: string[];
};

type Candidate = {
  tileOrder: OrderedTile[];
  tileToPhotoIndex: number[];
  cropDecisions: CropDecision[];
  orientationViolations: number;
  totalCost: number;
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

  const targets: OrientationClass[] = [];
  const remaining = { ...quotas };
  for (const item of sorted) {
    const orientation = item.constraint.orientationClass;
    if (remaining[orientation] > 0) {
      targets.push(orientation);
      remaining[orientation]--;
    }
  }
  for (const orientation of ["landscape", "portrait", "square"] as const) {
    while (remaining[orientation] > 0) {
      targets.push(orientation);
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
  targets: OrientationClass[],
  rand: () => number,
  minSize: number,
): FillRect[] {
  if (targets.length <= 1) return [rect];

  const counts = {
    landscape: targets.filter(v => v === "landscape").length,
    portrait: targets.filter(v => v === "portrait").length,
    square: targets.filter(v => v === "square").length,
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
    if (vertical) {
      if (rect.w < minSize * 2) return null;
      const ratio = clamp(leftTargets.length / targets.length, 0.2, 0.8);
      const w1 = clamp(Math.round(rect.w * ratio), minSize, rect.w - minSize);
      return {
        a: { x: rect.x, y: rect.y, w: w1, h: rect.h },
        b: { x: rect.x + w1, y: rect.y, w: rect.w - w1, h: rect.h },
      };
    }

    if (rect.h < minSize * 2) return null;
    const ratio = clamp(leftTargets.length / targets.length, 0.2, 0.8);
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
    .filter(target => target === stripOrientation)
    .slice(0, stripCount);
  const mainTargets = profile.targets
    .filter(target => target !== stripOrientation)
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
      .map(item => item.constraint.orientationClass),
    ...photoFeatures
      .filter(item => !prioritySet.has(item.photo.id))
      .map(item => item.constraint.orientationClass),
  ];
  return buildTilesFromProfile(
    count,
    canvasW,
    canvasH,
    { ...profile, targets: reorderedTargets },
    rand,
  );
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
): LayoutSearchOptions {
  return {
    ...DEFAULT_SEARCH_OPTIONS,
    ...options,
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
): Array<{ w: number; h: number }> {
  if (!allowCanvasResize) return [{ w: canvasW, h: canvasH }];
  const sizes = new Map<string, { w: number; h: number }>();
  const addSize = (sx: number, sy: number) => {
    const w = Math.max(1, Math.round(canvasW * sx));
    const h = Math.max(1, Math.round(canvasH * sy));
    sizes.set(`${w}x${h}`, { w, h });
  };

  if (mode === "deep") {
    const scales = [0.9, 0.94, 0.98, 1, 1.03, 1.08, 1.15];
    for (const scale of scales) addSize(scale, scale);
    for (const sx of [0.94, 0.98, 1.02, 1.06]) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else if (mode === "extended") {
    for (const scale of [0.94, 0.98, 1, 1.04, 1.08]) addSize(scale, scale);
    for (const sx of [0.98, 1.02, 1.06]) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else {
    for (const scale of [0.98, 1, 1.02]) addSize(scale, scale);
    addSize(0.99, 1);
    addSize(1.01, 1);
    addSize(1, 0.99);
    addSize(1, 1.01);
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

function attemptCountForMode(mode: LayoutSearchMode): number {
  if (mode === "deep") return 10;
  if (mode === "extended") return 7;
  return 6;
}

function stagesForMode(mode: LayoutSearchMode): SearchStage[] {
  return mode === "standard" ? ["strict", "relaxed"] : ["strict", "relaxed", "last_resort"];
}

function createTileOrder(
  tiles: FillRect[],
  canvasW: number,
  canvasH: number,
): OrderedTile[] {
  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;
  return [...tiles]
    .map(tile => {
      const tileCx = tile.x + tile.w / 2;
      const tileCy = tile.y + tile.h / 2;
      const dist = Math.sqrt((tileCx - canvasCx) ** 2 + (tileCy - canvasCy) ** 2);
      return { tile, dist: dist / maxDist };
    })
    .sort((a, b) => a.dist - b.dist);
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
  const topSoftCropPhotoIds = topSoftCropTileIndices.map(
    idx => photos[tileToPhotoIndex[idx]]?.id ?? "",
  ).filter(Boolean);
  void tileOrder;
  return { worstTileIndex, topSoftCropTileIndices, topSoftCropPhotoIds };
}

function summarizeLayoutQuality(
  decisions: CropDecision[],
  tileOrder: OrderedTile[],
  tileToPhotoIndex: number[],
  photos: FillArrangePhotoInput[],
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
    "averageCropLoss",
    "orientationViolations",
    "canvasDeltaRatio",
  ];
  for (const key of compareFields) {
    const av = a.quality[key] as number;
    const bv = b.quality[key] as number;
    if (av !== bv) return av - bv;
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
    tileOrder,
    tileToPhotoIndex,
    cropDecisions,
    orientationViolations,
    totalCost,
    cw,
    ch,
    metrics,
    quality,
    diagnostics,
    stage,
  };
}

function solveAssignmentForTileOrder(
  ctx: SolverContext,
  tileOrder: OrderedTile[],
  cw: number,
  ch: number,
  stage: SearchStage,
  canvasAdjustmentsTried: number,
): Candidate | null {
  let evaluatedPairs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
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
    tileOrder,
    tileToPhotoIndex,
    cw,
    ch,
    stage,
    {
      evaluatedPairs,
      cacheHits,
      cacheMisses,
      orientationViolations: 0,
      canvasAdjustmentsTried,
    },
  );
}

function rectsTouch(a: FillRect, b: FillRect): boolean {
  const verticalTouch =
    (Math.abs(a.x + a.w - b.x) < 0.5 || Math.abs(b.x + b.w - a.x) < 0.5) &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5;
  const horizontalTouch =
    (Math.abs(a.y + a.h - b.y) < 0.5 || Math.abs(b.y + b.h - a.y) < 0.5) &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5;
  return verticalTouch || horizontalTouch;
}

function chooseRepairGroupIndices(candidate: Candidate, anchorIdx: number): number[] {
  const anchor = candidate.tileOrder[anchorIdx]?.tile;
  if (!anchor) return [];
  const rowMatches = candidate.tileOrder
    .map((entry, idx) => ({ idx, tile: entry.tile }))
    .filter(entry => Math.abs(entry.tile.y - anchor.y) < 0.5 && Math.abs(entry.tile.h - anchor.h) < 0.5)
    .sort((a, b) => a.tile.x - b.tile.x)
    .map(entry => entry.idx);
  const colMatches = candidate.tileOrder
    .map((entry, idx) => ({ idx, tile: entry.tile }))
    .filter(entry => Math.abs(entry.tile.x - anchor.x) < 0.5 && Math.abs(entry.tile.w - anchor.w) < 0.5)
    .sort((a, b) => a.tile.y - b.tile.y)
    .map(entry => entry.idx);

  const scoreGroup = (indices: number[]) =>
    indices.reduce((sum, idx) => sum + candidate.cropDecisions[idx].cropLoss, 0);

  const cropGroup = (indices: number[]) => {
    const pos = indices.indexOf(anchorIdx);
    if (pos === -1) return [];
    const start = Math.max(0, pos - 1);
    return indices.slice(start, start + Math.min(4, indices.length));
  };

  const rowGroup = cropGroup(rowMatches);
  const colGroup = cropGroup(colMatches);
  if (rowGroup.length < 2) return colGroup;
  if (colGroup.length < 2) return rowGroup;
  return scoreGroup(rowGroup) >= scoreGroup(colGroup) ? rowGroup : colGroup;
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
): Candidate {
  let best = candidate;
  const anchors = candidate.diagnostics.topSoftCropTileIndices.slice(0, 2);
  let attempts = 0;

  for (const anchorIdx of anchors) {
    if (attempts >= 2) break;
    const subsetIndices = chooseRepairGroupIndices(best, anchorIdx);
    if (subsetIndices.length < 2 || subsetIndices.length > 4) continue;

    const subsetTiles = subsetIndices.map(idx => best.tileOrder[idx].tile);
    const minX = Math.min(...subsetTiles.map(tile => tile.x));
    const minY = Math.min(...subsetTiles.map(tile => tile.y));
    const maxX = Math.max(...subsetTiles.map(tile => tile.x + tile.w));
    const maxY = Math.max(...subsetTiles.map(tile => tile.y + tile.h));
    const region: FillRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    const subsetPhotoIndices = subsetIndices.map(idx => best.tileToPhotoIndex[idx]);
    const subsetFeatures = subsetPhotoIndices.map(idx => ctx.photoFeatures[idx]);
    const profile = buildTileProfileFromPhotos(
      subsetFeatures,
      subsetIndices.map(idx => ctx.photos[best.tileToPhotoIndex[idx]].id),
    );
    let localSeed = (randSeed + anchorIdx * 2654435761) >>> 0;
    const localRand = () => {
      localSeed = (localSeed * 1664525 + 1013904223) >>> 0;
      return localSeed / 2 ** 32;
    };
    const tileSets = [
      buildTilesFromProfile(subsetIndices.length, region.w, region.h, profile, localRand),
      partitionRectToTiles({ x: 0, y: 0, w: region.w, h: region.h }, subsetIndices.length, localRand, 0.38, 0.62),
      buildFallbackGridTiles(subsetIndices.length, region.w, region.h),
    ];

    for (const tiles of tileSets) {
      const orderedSubsetTiles = createTileOrder(
        tiles.map(tile => ({ x: tile.x + region.x, y: tile.y + region.y, w: tile.w, h: tile.h })),
        best.cw,
        best.ch,
      );
      const assignmentPhotos: FillArrangeAssignmentPhoto[] = subsetFeatures.map(item => ({
        id: item.photo.id,
        sourceAspect: item.strategy.sourceAspect,
        preferredAspect: item.constraint.idealAspect,
        orientation: item.strategy.orientation,
        isExtreme: item.strategy.isExtreme,
      }));
      const assignmentTiles: FillArrangeAssignmentTile[] = orderedSubsetTiles.map(({ tile, dist }) => ({
        aspect: tile.w / Math.max(1, tile.h),
        dist,
        area: tile.w * tile.h,
      }));

      let localTileToPhoto: number[];
      try {
        localTileToPhoto = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
          nonExtremeWeight: 1.1,
          centerBiasWeight: CENTER_BIAS_WEIGHT,
          edgeBiasWeight: EDGE_BIAS_WEIGHT,
          orientationPenalty: best.stage === "strict" ? 40 : best.stage === "relaxed" ? 120 : 180,
          isPairAllowed: (photoStrategy, tile) => {
            const decision = decisionFor(ctx, photoStrategy.id, tile, best.stage);
            const constraint = ctx.constraintById.get(photoStrategy.id)!;
            return isAllowedByStage(decision, constraint, best.stage);
          },
          evaluatePair: (photoStrategy, tile) => {
            const decision = decisionFor(ctx, photoStrategy.id, tile, best.stage);
            const constraint = ctx.constraintById.get(photoStrategy.id)!;
            return pairCostByStage(decision, constraint, best.stage);
          },
        });
      } catch {
        continue;
      }

      const nextTileOrder = [...best.tileOrder];
      const nextAssignment = [...best.tileToPhotoIndex];
      const orderedSubsetIndices = [...subsetIndices].sort((a, b) => a - b);
      for (let i = 0; i < orderedSubsetIndices.length; i++) {
        nextTileOrder[orderedSubsetIndices[i]] = orderedSubsetTiles[i];
        nextAssignment[orderedSubsetIndices[i]] = subsetPhotoIndices[localTileToPhoto[i]];
      }

      const repaired = buildCandidateFromAssignment(
        ctx,
        nextTileOrder,
        nextAssignment,
        best.cw,
        best.ch,
        best.stage,
        best.metrics,
      );
      if (repaired && compareCandidate(repaired, best) < 0) {
        best = repaired;
      }
    }
    attempts++;
  }
  return best;
}

function findRefinementNeighbors(candidate: Candidate, tileIdx: number): number[] {
  const tile = candidate.tileOrder[tileIdx]?.tile;
  if (!tile) return [];
  return candidate.tileOrder
    .map((entry, idx) => ({ idx, tile: entry.tile }))
    .filter(entry => entry.idx !== tileIdx && rectsTouch(tile, entry.tile))
    .map(entry => entry.idx);
}

function trySplitRatioRefinement(
  ctx: SolverContext,
  candidate: Candidate,
): Candidate {
  let best = candidate;
  const refinementTargets = [
    candidate.diagnostics.worstTileIndex,
    ...candidate.diagnostics.topSoftCropTileIndices,
  ].slice(0, 3);
  let attempts = 0;

  for (const tileIdx of refinementTargets) {
    const neighbors = findRefinementNeighbors(best, tileIdx);
    for (const neighborIdx of neighbors) {
      if (attempts >= 6) return best;
      const a = best.tileOrder[tileIdx].tile;
      const b = best.tileOrder[neighborIdx].tile;
      const verticalPair = Math.abs(a.y - b.y) < 0.5 && Math.abs(a.h - b.h) < 0.5;
      const horizontalPair = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.w - b.w) < 0.5;
      if (!verticalPair && !horizontalPair) continue;

      const deltas = [-0.08, 0.08];
      for (const delta of deltas) {
        const nextTileOrder = [...best.tileOrder];
        if (verticalPair) {
          const totalW = a.w + b.w;
          const newW = clamp(Math.round(totalW * (a.w / totalW + delta)), 80, totalW - 80);
          const left = a.x < b.x ? tileIdx : neighborIdx;
          const right = left === tileIdx ? neighborIdx : tileIdx;
          const leftTile = nextTileOrder[left].tile;
          nextTileOrder[left] = {
            ...nextTileOrder[left],
            tile: { x: leftTile.x, y: leftTile.y, w: newW, h: leftTile.h },
          };
          nextTileOrder[right] = {
            ...nextTileOrder[right],
            tile: {
              x: leftTile.x + newW,
              y: leftTile.y,
              w: totalW - newW,
              h: leftTile.h,
            },
          };
        } else {
          const totalH = a.h + b.h;
          const newH = clamp(Math.round(totalH * (a.h / totalH + delta)), 80, totalH - 80);
          const top = a.y < b.y ? tileIdx : neighborIdx;
          const bottom = top === tileIdx ? neighborIdx : tileIdx;
          const topTile = nextTileOrder[top].tile;
          nextTileOrder[top] = {
            ...nextTileOrder[top],
            tile: { x: topTile.x, y: topTile.y, w: topTile.w, h: newH },
          };
          nextTileOrder[bottom] = {
            ...nextTileOrder[bottom],
            tile: {
              x: topTile.x,
              y: topTile.y + newH,
              w: topTile.w,
              h: totalH - newH,
            },
          };
        }

        const refined = buildCandidateFromAssignment(
          ctx,
          nextTileOrder,
          best.tileToPhotoIndex,
          best.cw,
          best.ch,
          best.stage,
          best.metrics,
        );
        attempts++;
        if (
          refined &&
          (refined.quality.worstCropLoss < best.quality.worstCropLoss - 1e-6 ||
            (refined.quality.photosOverSoftCropThreshold < best.quality.photosOverSoftCropThreshold &&
              Math.abs(refined.quality.canvasDeltaRatio - best.quality.canvasDeltaRatio) < 1e-6))
        ) {
          best = refined;
        }
      }
    }
  }
  return best;
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
): FillRect[][] {
  const sets: FillRect[][] = [];
  if (attempt % 2 === 0) {
    sets.push(partitionRectToTiles(root, count, rand, ratioMin, ratioMax));
  }
  sets.push(buildTilesFromProfile(count, root.w, root.h, profile, rand));
  if (attempt === 0) {
    const stripTiles = buildStripTilesFromProfile(count, root.w, root.h, profile, rand);
    if (stripTiles) sets.push(stripTiles);
  }
  if (mode === "deep") {
    sets.push(
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
      },
      quality: {
        worstCropLoss: 0,
        averageCropLoss: 0,
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
        item.constraint.maxCropLoss * (0.78 - item.constraint.sizeRankWeight * 0.18),
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
  const maxPartitionAttempts = Math.min(
    searchOptions.maxSearchRounds,
    attemptCountForMode(searchOptions.mode),
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
      const profile = buildTileProfileFromPhotos(photoFeatures, priorityPhotoIds);
      let producedCandidate = false;

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
          profile,
          priorityPhotoIds,
          photoFeatures,
          searchOptions.mode,
          attempt,
        );

        for (const tiles of tileSets) {
          if (tiles.length !== n) continue;
          const tileOrder = createTileOrder(tiles, cW, cH);
          const candidate = solveAssignmentForTileOrder(
            ctx,
            tileOrder,
            cW,
            cH,
            stage,
            canvasSizes.length,
          );
          if (!candidate) continue;
          producedCandidate = true;
          if (searchOptions.allowLocalRepair) {
            let repaired = candidate;
            if (searchOptions.mode !== "standard" || n <= 8) {
              repaired = tryAdjacentSwapRepair(ctx, repaired);
            }
            if (searchOptions.mode !== "standard") {
              repaired = tryLocalRetileRepair(ctx, repaired, seed);
              repaired = trySplitRatioRefinement(ctx, repaired);
            }
            if (compareCandidate(repaired, candidate) < 0) {
              if (!stageBest || compareCandidate(repaired, stageBest) < 0) {
                stageBest = repaired;
              }
            }
          }
          if (!stageBest || compareCandidate(candidate, stageBest) < 0) {
            stageBest = candidate;
          }

          if (
            stageBest.quality.accepted &&
            stageBest.quality.worstCropLoss <= SOFT_CROP_THRESHOLD + 1e-6 &&
            stageBest.quality.photosOverSoftCropThreshold === 0
          ) {
            break;
          }
        }

        if (
          stageBest?.quality.accepted &&
          stageBest.quality.worstCropLoss <= SOFT_CROP_THRESHOLD + 1e-6 &&
          stageBest.quality.photosOverSoftCropThreshold === 0
        ) {
          break;
        }
      }

      if (!producedCandidate) {
        const fallback = solveAssignmentForTileOrder(
          ctx,
          createTileOrder(buildFallbackGridTiles(n, cW, cH), cW, cH),
          cW,
          cH,
          stage,
          canvasSizes.length,
        );
        if (fallback && (!stageBest || compareCandidate(fallback, stageBest) < 0)) {
          stageBest = fallback;
        }
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
    solveAssignmentForTileOrder(
      ctx,
      createTileOrder(buildFallbackGridTiles(n, canvasW, canvasH), canvasW, canvasH),
      canvasW,
      canvasH,
      searchOptions.mode === "standard" ? "relaxed" : "last_resort",
      canvasSizes.length,
    );

  const resolvedCandidate =
    candidate ??
    buildCandidateFromAssignment(
      ctx,
      createTileOrder(buildFallbackGridTiles(n, canvasW, canvasH), canvasW, canvasH),
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
