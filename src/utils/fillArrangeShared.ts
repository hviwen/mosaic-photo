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

const CENTER_BIAS_WEIGHT = 0.55;
const EDGE_BIAS_WEIGHT = 0.14;
const FACE_CUT_WEIGHT = 1_000_000;
const ORIENTATION_WEIGHT = 100_000;
const LARGE_PHOTO_WEIGHT = 160;
const ASPECT_WEIGHT = 45;
const CENTER_WEIGHT = 8;
const CROP_AREA_EPSILON = 1e-6;
const RELAXED_PAIR_COST = 250_000;

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

function buildConstraintAwareTiles(
  count: number,
  canvasW: number,
  canvasH: number,
  constraints: PhotoLayoutConstraint[],
): FillRect[] {
  if (count <= 0) return [];
  const ranked = [...constraints].sort((a, b) => {
    if (a.isHighRisk !== b.isHighRisk) return a.isHighRisk ? -1 : 1;
    const deviationA = Math.abs(Math.log(Math.max(1e-6, a.idealAspect)));
    const deviationB = Math.abs(Math.log(Math.max(1e-6, b.idealAspect)));
    if (deviationA !== deviationB) return deviationB - deviationA;
    return b.preferredCenterWeight - a.preferredCenterWeight;
  });

  const tiles: FillRect[] = [];
  let remaining: FillRect = { x: 0, y: 0, w: canvasW, h: canvasH };
  const minBandSize = Math.max(80, Math.round(Math.min(canvasW, canvasH) * 0.12));
  const reserveCount = Math.min(
    Math.max(0, ranked.length - 1),
    Math.max(1, Math.floor(count / 3)),
  );
  for (let i = 0; i < reserveCount; i++) {
    const aspect = ranked[i].idealAspect;
    const left = count - i;
    if (left <= 1) break;
    const targetArea = (remaining.w * remaining.h) / left;
    if (aspect < 1) {
      if (remaining.w <= minBandSize * 2) break;
      const tileW = clamp(
        Math.round(Math.sqrt(targetArea * aspect)),
        minBandSize,
        Math.max(minBandSize, remaining.w - minBandSize),
      );
      const w = clamp(tileW, minBandSize, Math.max(minBandSize, remaining.w - minBandSize));
      tiles.push({ x: remaining.x, y: remaining.y, w, h: remaining.h });
      remaining = {
        x: remaining.x + w,
        y: remaining.y,
        w: remaining.w - w,
        h: remaining.h,
      };
    } else {
      if (remaining.h <= minBandSize * 2) break;
      const tileH = clamp(
        Math.round(Math.sqrt(targetArea / Math.max(1e-6, aspect))),
        minBandSize,
        Math.max(minBandSize, remaining.h - minBandSize),
      );
      const h = clamp(tileH, minBandSize, Math.max(minBandSize, remaining.h - minBandSize));
      tiles.push({ x: remaining.x, y: remaining.y, w: remaining.w, h });
      remaining = {
        x: remaining.x,
        y: remaining.y + h,
        w: remaining.w,
        h: remaining.h - h,
      };
    }
  }

  const rest = buildFallbackGridTiles(count - tiles.length, remaining.w, remaining.h).map(
    tile => ({
      x: tile.x + remaining.x,
      y: tile.y + remaining.y,
      w: tile.w,
      h: tile.h,
    }),
  );
  return [...tiles, ...rest].slice(0, count);
}

function safeAspect(w: number, h: number): number {
  return Math.max(1e-6, w / Math.max(1e-6, h));
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
  const faceRegions = detections
    .filter(d => d.kind === "face")
    .map(d => d.box);
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
    (0.3 - extremeLevel * 0.08 - areaRatio * 0.14 - tileAreaNorm * 0.08) *
      faceFactor,
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
  return (
    (losses.orientationViolation ? ORIENTATION_WEIGHT : 0) +
    losses.faceCutPenalty * FACE_CUT_WEIGHT +
    losses.largePhotoCropPenalty * LARGE_PHOTO_WEIGHT +
    losses.aspectDeviationPenalty * ASPECT_WEIGHT +
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
  if (constraint.idealAspect < 1 && cropAspect > 1) {
    crop = centerCropToAspect(
      photo.crop,
      1,
      photo.imageWidth,
      photo.imageHeight,
      cropOptions,
    );
  } else if (constraint.idealAspect > 1 && cropAspect < 1) {
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
  const cutRequiredRegions = countCutRequiredRegions(
    crop,
    constraint.requiredKeepRegions,
  );
  const aspectOutOfRange =
    tileAspect < constraint.minAspect - 1e-3 ||
    tileAspect > constraint.maxAspect + 1e-3;
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
  };
}

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
};

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
    const scales = [0.9, 0.94, 0.98, 1, 1.02, 1.06, 1.1, 1.15];
    for (const scale of scales) addSize(scale, scale);
    for (const sx of [0.94, 0.98, 1.02, 1.06]) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else if (mode === "extended") {
    for (const scale of [0.92, 0.96, 1, 1.04, 1.08]) addSize(scale, scale);
    for (const sx of [0.94, 0.98, 1.02, 1.06]) {
      addSize(sx, 1);
      addSize(1, sx);
    }
  } else {
    for (const scale of [0.96, 0.98, 1, 1.02, 1.04]) addSize(scale, scale);
    addSize(0.98, 1);
    addSize(1.02, 1);
    addSize(1, 0.98);
    addSize(1, 1.02);
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
  if (mode === "deep") return 16;
  if (mode === "extended") return 10;
  return 6;
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

function summarizeLayoutQuality(
  decisions: CropDecision[],
  thresholds: LayoutQualityThresholds,
  baseCanvasW: number,
  baseCanvasH: number,
  canvasW: number,
  canvasH: number,
  orientationViolations: number,
): LayoutQualitySummary {
  const worstCropLoss = decisions.reduce(
    (max, decision) => Math.max(max, decision.cropLoss),
    0,
  );
  const averageCropLoss =
    decisions.reduce((sum, decision) => sum + decision.cropLoss, 0) /
    Math.max(1, decisions.length);
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
    photosOverCropThreshold,
    photosCutRequiredRegions,
    orientationViolations,
    canvasDeltaRatio: canvasDelta,
    accepted,
    reason: reason || undefined,
  };
}

function compareCandidate(a: Candidate, b: Candidate): number {
  const keys: Array<keyof LayoutQualitySummary> = [
    "photosCutRequiredRegions",
    "photosOverCropThreshold",
    "worstCropLoss",
    "averageCropLoss",
    "orientationViolations",
    "canvasDeltaRatio",
  ];
  for (const key of keys) {
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
    tileOrder.map((item, idx) => ({
      tile: item.tile,
      placement: placements[idx],
    })),
    cw,
    ch,
    { coverMode: true },
  ).ok;
}

function tryAdjacentSwapRepair(
  candidate: Candidate,
  photos: FillArrangePhotoInput[],
  constraints: PhotoLayoutConstraint[],
  thresholds: LayoutQualityThresholds,
  baseCanvasW: number,
  baseCanvasH: number,
): Candidate {
  if (candidate.quality.photosOverCropThreshold > 3) return candidate;
  let best = candidate;
  for (let i = 0; i < candidate.tileToPhotoIndex.length - 1; i++) {
    const swapped = [...candidate.tileToPhotoIndex];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    const cropDecisions = candidate.tileOrder.map((orderedTile, tileIdx) =>
      buildCropDecision(
        photos[swapped[tileIdx]],
        {
          aspect: orderedTile.tile.w / Math.max(1, orderedTile.tile.h),
          dist: orderedTile.dist,
          area: orderedTile.tile.w * orderedTile.tile.h,
        },
        constraints[swapped[tileIdx]],
      ),
    );
    const orientationViolations = cropDecisions.filter(
      decision => decision.losses.orientationViolation,
    ).length;
    const totalCost = cropDecisions.reduce((sum, decision) => {
      return sum + decision.totalCost + (decision.feasible ? 0 : RELAXED_PAIR_COST);
    }, 0);
    const placements = buildPlacements(photos, candidate.tileOrder, swapped, cropDecisions);
    if (!validatePlacements(candidate.tileOrder, placements, candidate.cw, candidate.ch)) {
      continue;
    }
    const quality = summarizeLayoutQuality(
      cropDecisions,
      thresholds,
      baseCanvasW,
      baseCanvasH,
      candidate.cw,
      candidate.ch,
      orientationViolations,
    );
    const repaired: Candidate = {
      ...candidate,
      tileToPhotoIndex: swapped,
      cropDecisions,
      orientationViolations,
      totalCost,
      quality,
    };
    if (compareCandidate(repaired, best) < 0) best = repaired;
  }
  return best;
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
      quality: summarizeLayoutQuality(
        [],
        qualityThresholds,
        canvasW,
        canvasH,
        canvasW,
        canvasH,
        0,
      ),
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
  }));
  const photoById = new Map(photoFeatures.map(item => [item.photo.id, item.photo]));
  const constraintById = new Map(
    photoFeatures.map(item => [item.photo.id, item.constraint]),
  );
  const constraints = photoFeatures.map(item => item.constraint);

  let bestCandidate: Candidate | null = null;
  const maxPartitionAttempts = Math.min(
    searchOptions.maxSearchRounds,
    attemptCountForMode(searchOptions.mode),
  );

  for (const { w: cW, h: cH } of canvasSizes) {
    const root: FillRect = { x: 0, y: 0, w: cW, h: cH };
    for (let attempt = 0; attempt < maxPartitionAttempts; attempt++) {
      let seed = (baseSeed + attempt * 224_682_2519) >>> 0;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };

      const partitioned =
        attempt % 2 === 0
          ? partitionRectToTiles(root, n, rand, ratioMin, ratioMax)
          : buildConstraintAwareTiles(n, cW, cH, constraints);
      const tiles =
        partitioned.length === n ? partitioned : buildFallbackGridTiles(n, cW, cH);
      const tileOrder = createTileOrder(tiles, cW, cH);

      const pairDecisionCache = new Map<string, CropDecision>();
      let cacheHits = 0;
      let cacheMisses = 0;
      let evaluatedPairs = 0;

      const decisionFor = (
        photoId: string,
        tile: FillArrangeAssignmentTile,
      ): CropDecision => {
        evaluatedPairs++;
        const key = `${photoId}|${tile.aspect.toFixed(4)}|${tile.area}|${tile.dist.toFixed(4)}`;
        const cached = pairDecisionCache.get(key);
        if (cached) {
          cacheHits++;
          return cached;
        }
        const photo = photoById.get(photoId);
        const constraint = constraintById.get(photoId);
        if (!photo || !constraint) {
          throw new Error(`missing photo strategy for ${photoId}`);
        }
        const decision = buildCropDecision(photo, tile, constraint);
        pairDecisionCache.set(key, decision);
        cacheMisses++;
        return decision;
      };

      const assignmentPhotos: FillArrangeAssignmentPhoto[] = photoFeatures.map(item => ({
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

      let tileToPhotoIndex: number[];
      try {
        tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
          nonExtremeWeight: 1.1,
          centerBiasWeight: CENTER_BIAS_WEIGHT,
          edgeBiasWeight: EDGE_BIAS_WEIGHT,
          orientationPenalty: 40,
          isPairAllowed: (photoStrategy, tile) => decisionFor(photoStrategy.id, tile).feasible,
          evaluatePair: (photoStrategy, tile) =>
            decisionFor(photoStrategy.id, tile).totalCost,
        });
      } catch {
        try {
          tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
            nonExtremeWeight: 1.1,
            centerBiasWeight: CENTER_BIAS_WEIGHT,
            edgeBiasWeight: EDGE_BIAS_WEIGHT,
          orientationPenalty: 120,
          isPairAllowed: (photoStrategy, tile) => {
              const decision = decisionFor(photoStrategy.id, tile);
              return (
                !decision.losses.orientationViolation &&
                !decision.aspectOutOfRange &&
                decision.cutRequiredRegions === 0 &&
                decision.cropLoss <=
                  (constraintById.get(photoStrategy.id)?.maxCropLoss ?? 0.12) * 1.35
              );
            },
            evaluatePair: (photoStrategy, tile) => {
              const decision = decisionFor(photoStrategy.id, tile);
              return decision.totalCost + (decision.feasible ? 0 : RELAXED_PAIR_COST);
            },
          });
        } catch {
          try {
            tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
              nonExtremeWeight: 1.1,
              centerBiasWeight: CENTER_BIAS_WEIGHT,
              edgeBiasWeight: EDGE_BIAS_WEIGHT,
              orientationPenalty: 180,
              isPairAllowed: (photoStrategy, tile) => {
                const decision = decisionFor(photoStrategy.id, tile);
                return (
                  !decision.losses.orientationViolation &&
                  decision.cutRequiredRegions === 0
                );
              },
              evaluatePair: (photoStrategy, tile) => {
                const decision = decisionFor(photoStrategy.id, tile);
                const constraint = constraintById.get(photoStrategy.id);
                const overCropPenalty = Math.max(
                  0,
                  decision.cropLoss - (constraint?.maxCropLoss ?? 0.12),
                );
                return (
                  decision.totalCost +
                  overCropPenalty * RELAXED_PAIR_COST +
                  (decision.aspectOutOfRange ? RELAXED_PAIR_COST * 0.5 : 0)
                );
              },
            });
          } catch {
            continue;
          }
        }
      }

      const cropDecisions = tileOrder.map((_, tileIdx) => {
        const photo = photoFeatures[tileToPhotoIndex[tileIdx]];
        return decisionFor(photo.photo.id, assignmentTiles[tileIdx]);
      });
      const orientationViolations = cropDecisions.filter(
        decision => decision.losses.orientationViolation,
      ).length;
      const totalCost = cropDecisions.reduce((sum, decision) => {
        return sum + decision.totalCost + (decision.feasible ? 0 : RELAXED_PAIR_COST);
      }, 0);
      const quality = summarizeLayoutQuality(
        cropDecisions,
        qualityThresholds,
        canvasW,
        canvasH,
        cW,
        cH,
        orientationViolations,
      );

      let candidate: Candidate = {
        tileOrder,
        tileToPhotoIndex,
        cropDecisions,
        orientationViolations,
        totalCost,
        cw: cW,
        ch: cH,
        metrics: {
          evaluatedPairs,
          cacheHits,
          cacheMisses,
          orientationViolations,
          canvasAdjustmentsTried: canvasSizes.length,
        },
        quality,
      };

      const placements = buildPlacements(
        photos,
        candidate.tileOrder,
        candidate.tileToPhotoIndex,
        candidate.cropDecisions,
      );
      if (!validatePlacements(candidate.tileOrder, placements, cW, cH)) continue;

      if (searchOptions.allowLocalRepair && searchOptions.mode !== "standard") {
        candidate = tryAdjacentSwapRepair(
          candidate,
          photos,
          constraints,
          qualityThresholds,
          canvasW,
          canvasH,
        );
      }

      if (!bestCandidate || compareCandidate(candidate, bestCandidate) < 0) {
        bestCandidate = candidate;
      }
    }
  }

  let candidate = bestCandidate;
  if (!candidate) {
    const fallbackTileOrder = createTileOrder(
      buildFallbackGridTiles(n, canvasW, canvasH),
      canvasW,
      canvasH,
    );
    const assignmentPhotos: FillArrangeAssignmentPhoto[] = photoFeatures.map(item => ({
      id: item.photo.id,
      sourceAspect: item.strategy.sourceAspect,
      preferredAspect: item.constraint.idealAspect,
      orientation: item.strategy.orientation,
      isExtreme: item.strategy.isExtreme,
    }));
    const assignmentTiles: FillArrangeAssignmentTile[] = fallbackTileOrder.map(
      ({ tile, dist }) => ({
        aspect: tile.w / Math.max(1, tile.h),
        dist,
        area: tile.w * tile.h,
      }),
    );
    const pairDecisionCache = new Map<string, CropDecision>();
    const decisionFor = (photoId: string, tile: FillArrangeAssignmentTile) => {
      const key = `${photoId}|${tile.aspect.toFixed(4)}|${tile.area}|${tile.dist.toFixed(4)}`;
      const cached = pairDecisionCache.get(key);
      if (cached) return cached;
      const photo = photoById.get(photoId);
      const constraint = constraintById.get(photoId);
      if (!photo || !constraint) throw new Error(`missing photo strategy for ${photoId}`);
      const decision = buildCropDecision(photo, tile, constraint);
      pairDecisionCache.set(key, decision);
      return decision;
    };
    let tileToPhotoIndex: number[];
    try {
      tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
        nonExtremeWeight: 1.1,
        centerBiasWeight: CENTER_BIAS_WEIGHT,
        edgeBiasWeight: EDGE_BIAS_WEIGHT,
        orientationPenalty: 40,
        isPairAllowed: (photoStrategy, tile) => decisionFor(photoStrategy.id, tile).feasible,
        evaluatePair: (photoStrategy, tile) => decisionFor(photoStrategy.id, tile).totalCost,
      });
    } catch {
      try {
        tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
          nonExtremeWeight: 1.1,
          centerBiasWeight: CENTER_BIAS_WEIGHT,
          edgeBiasWeight: EDGE_BIAS_WEIGHT,
          orientationPenalty: 120,
          isPairAllowed: (photoStrategy, tile) => {
            const decision = decisionFor(photoStrategy.id, tile);
            return (
              !decision.losses.orientationViolation &&
              !decision.aspectOutOfRange &&
              decision.cutRequiredRegions === 0 &&
              decision.cropLoss <=
                (constraintById.get(photoStrategy.id)?.maxCropLoss ?? 0.12) * 1.35
            );
          },
          evaluatePair: (photoStrategy, tile) => {
            const decision = decisionFor(photoStrategy.id, tile);
            return decision.totalCost + (decision.feasible ? 0 : RELAXED_PAIR_COST);
          },
        });
      } catch {
        try {
          tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
            nonExtremeWeight: 1.1,
            centerBiasWeight: CENTER_BIAS_WEIGHT,
            edgeBiasWeight: EDGE_BIAS_WEIGHT,
            orientationPenalty: 180,
            isPairAllowed: (photoStrategy, tile) => {
              const decision = decisionFor(photoStrategy.id, tile);
              return !decision.losses.orientationViolation && decision.cutRequiredRegions === 0;
            },
            evaluatePair: (photoStrategy, tile) => {
              const decision = decisionFor(photoStrategy.id, tile);
              const constraint = constraintById.get(photoStrategy.id);
              const overCropPenalty = Math.max(
                0,
                decision.cropLoss - (constraint?.maxCropLoss ?? 0.12),
              );
              return (
                decision.totalCost +
                overCropPenalty * RELAXED_PAIR_COST +
                (decision.aspectOutOfRange ? RELAXED_PAIR_COST * 0.5 : 0)
              );
            },
          });
        } catch {
          tileToPhotoIndex = photos.map((_, idx) => idx);
        }
      }
    }
    const cropDecisions = fallbackTileOrder.map((_, idx) => {
      const photo = photoFeatures[tileToPhotoIndex[idx]];
      return decisionFor(photo.photo.id, assignmentTiles[idx]);
    });
    candidate = {
      tileOrder: fallbackTileOrder,
      tileToPhotoIndex,
      cropDecisions,
      orientationViolations: cropDecisions.filter(
        decision => decision.losses.orientationViolation,
      ).length,
      totalCost: cropDecisions.reduce((sum, decision) => sum + decision.totalCost, 0),
      cw: canvasW,
      ch: canvasH,
      metrics: {
        evaluatedPairs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        orientationViolations: 0,
        canvasAdjustmentsTried: canvasSizes.length,
      },
      quality: summarizeLayoutQuality(
        cropDecisions,
        qualityThresholds,
        canvasW,
        canvasH,
        canvasW,
        canvasH,
        cropDecisions.filter(decision => decision.losses.orientationViolation).length,
      ),
    };
  }

  const placements = buildPlacements(
    photos,
    candidate.tileOrder,
    candidate.tileToPhotoIndex,
    candidate.cropDecisions,
  );

  return {
    placements,
    canvasW: candidate.cw,
    canvasH: candidate.ch,
    metrics: candidate.metrics,
    quality: candidate.quality,
  };
}
