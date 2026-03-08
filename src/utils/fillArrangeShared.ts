import type {
  CropDecision,
  CropLossBreakdown,
  FillArrangeResult,
  LayoutMetrics,
  Placement,
  CropRect,
} from "@/types";
import type { KeepRegion } from "@/types/vision";
import { centerCropToAspect } from "@/utils/image";
import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
  getSmartCropMode,
  buildRequiredKeepRegions,
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
};

export type FillArrangePhotoInput = {
  id: string;
  crop: CropRect;
  imageWidth: number;
  imageHeight: number;
  detections?: KeepRegion[];
};

type FillRect = { x: number; y: number; w: number; h: number };

const CENTER_BIAS_WEIGHT = 0.55;
const EDGE_BIAS_WEIGHT = 0.14;
const FACE_CUT_WEIGHT = 1_000_000;
const ORIENTATION_WEIGHT = 100_000;
const LARGE_PHOTO_WEIGHT = 160;
const ASPECT_WEIGHT = 45;
const CENTER_WEIGHT = 8;
const CROP_AREA_EPSILON = 1e-6;
const CANVAS_ADJUST_MAX = 100;
const CANVAS_ADJUST_STEP = 50;

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

function detectionCoveragePenalty(crop: CropRect, detections: KeepRegion[]): number {
  const faceRegions = buildRequiredKeepRegions(detections, "face");
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

function scoreCropDecision(losses: CropLossBreakdown): number {
  return (
    (losses.orientationViolation ? ORIENTATION_WEIGHT : 0) +
    losses.faceCutPenalty * FACE_CUT_WEIGHT +
    losses.largePhotoCropPenalty * LARGE_PHOTO_WEIGHT +
    losses.aspectDeviationPenalty * ASPECT_WEIGHT +
    losses.centerPreference * CENTER_WEIGHT
  );
}

function buildCropDecision(
  photo: FillArrangePhotoInput,
  tile: FillArrangeAssignmentTile,
): CropDecision {
  const tileAspect = tile.aspect;
  const crop = centerCropToAspect(
    photo.crop,
    tileAspect,
    photo.imageWidth,
    photo.imageHeight,
    photo.detections && photo.detections.length > 0
      ? { detections: photo.detections }
      : undefined,
  );
  const losses = buildLossBreakdown(photo, tile, tileAspect, crop);
  return {
    crop,
    mode: getSmartCropMode(photo.detections ?? []),
    losses,
    totalCost: scoreCropDecision(losses),
  };
}

type Candidate = {
  tileOrder: Array<{ tile: FillRect; dist: number }>;
  tileToPhotoIndex: number[];
  cropDecisions: CropDecision[];
  orientationViolations: number;
  totalCost: number;
  cw: number;
  ch: number;
  metrics: LayoutMetrics;
};

function createCanvasSizes(
  canvasW: number,
  canvasH: number,
  count: number,
): Array<{ w: number; h: number }> {
  if (count > 24) return [{ w: canvasW, h: canvasH }];
  if (count > 12) {
    return [
      { w: canvasW, h: canvasH },
      { w: canvasW + 50, h: canvasH },
      { w: canvasW, h: canvasH + 50 },
      { w: canvasW - 50, h: canvasH },
      { w: canvasW, h: canvasH - 50 },
    ].filter(size => size.w > 0 && size.h > 0);
  }
  const canvasSizes: Array<{ w: number; h: number }> = [{ w: canvasW, h: canvasH }];
  for (let dw = -CANVAS_ADJUST_MAX; dw <= CANVAS_ADJUST_MAX; dw += CANVAS_ADJUST_STEP) {
    for (let dh = -CANVAS_ADJUST_MAX; dh <= CANVAS_ADJUST_MAX; dh += CANVAS_ADJUST_STEP) {
      if (dw === 0 && dh === 0) continue;
      const w = canvasW + dw;
      const h = canvasH + dh;
      if (w > 0 && h > 0) canvasSizes.push({ w, h });
    }
  }
  return canvasSizes;
}

export function fillArrangePhotosShared(
  photos: FillArrangePhotoInput[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeOptions = {},
): FillArrangeResult {
  const n = photos.length;
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
    };
  }

  const ratioMin = clamp(options.splitRatioMin ?? 0.38, 0.2, 0.49);
  const ratioMax = clamp(options.splitRatioMax ?? 0.62, 0.51, 0.8);
  const baseSeed = options.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const maxPartitionAttempts = n > 60 ? 4 : n > 24 ? 6 : 8;
  const canvasSizes = createCanvasSizes(canvasW, canvasH, n);

  const photoFeatures = photos.map(photo => ({
    photo,
    strategy: buildFillArrangePhotoStrategy(photo.imageWidth, photo.imageHeight),
  }));
  const photoById = new Map(photoFeatures.map(item => [item.photo.id, item.photo]));

  let bestCandidate: Candidate | null = null;

  for (const { w: cW, h: cH } of canvasSizes) {
    const canvasCx = cW / 2;
    const canvasCy = cH / 2;
    const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;

    const createTileOrder = (tiles: FillRect[]) =>
      [...tiles]
        .map(tile => {
          const tileCx = tile.x + tile.w / 2;
          const tileCy = tile.y + tile.h / 2;
          const dist = Math.sqrt(
            (tileCx - canvasCx) ** 2 + (tileCy - canvasCy) ** 2,
          );
          return { tile, dist: dist / maxDist };
        })
        .sort((a, b) => a.dist - b.dist);

    const root: FillRect = { x: 0, y: 0, w: cW, h: cH };

    for (let attempt = 0; attempt < maxPartitionAttempts; attempt++) {
      let seed = (baseSeed + attempt * 224_682_2519) >>> 0;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };

      const partitioned = partitionRectToTiles(root, n, rand, ratioMin, ratioMax);
      const tiles =
        partitioned.length === n ? partitioned : buildFallbackGridTiles(n, cW, cH);
      const tileOrder = createTileOrder(tiles);

      const pairDecisionCache = new Map<string, CropDecision>();
      let cacheHits = 0;
      let cacheMisses = 0;
      let evaluatedPairs = 0;

      const assignmentPhotos: FillArrangeAssignmentPhoto[] = photoFeatures.map(item => ({
        id: item.photo.id,
        sourceAspect: item.strategy.sourceAspect,
        preferredAspect: item.strategy.preferredAspect,
        orientation: item.strategy.orientation,
        isExtreme: item.strategy.isExtreme,
      }));

      const assignmentTiles: FillArrangeAssignmentTile[] = tileOrder.map(({ tile, dist }) => ({
        aspect: tile.w / Math.max(1, tile.h),
        dist,
        area: tile.w * tile.h,
      }));

      const tileToPhotoIndex = assignPhotosToTiles(assignmentPhotos, assignmentTiles, {
        nonExtremeWeight: 1.1,
        centerBiasWeight: CENTER_BIAS_WEIGHT,
        edgeBiasWeight: EDGE_BIAS_WEIGHT,
        orientationPenalty: 40,
        evaluatePair: (photoStrategy, tile) => {
          evaluatedPairs++;
          const key = `${photoStrategy.id}|${tile.aspect.toFixed(4)}|${tile.area}`;
          const cached = pairDecisionCache.get(key);
          if (cached) {
            cacheHits++;
            return cached.totalCost;
          }
          const photo = photoById.get(photoStrategy.id);
          if (!photo) return 0;
          const decision = buildCropDecision(photo, tile);
          pairDecisionCache.set(key, decision);
          cacheMisses++;
          return decision.totalCost;
        },
      });

      const cropDecisions: CropDecision[] = [];
      let orientationViolations = 0;
      for (let tileIdx = 0; tileIdx < tileOrder.length; tileIdx++) {
        const photo = photoFeatures[tileToPhotoIndex[tileIdx]]?.photo;
        if (!photo) continue;
        const tile = assignmentTiles[tileIdx];
        const key = `${photo.id}|${tile.aspect.toFixed(4)}|${tile.area}`;
        const decision = pairDecisionCache.get(key) ?? buildCropDecision(photo, tile);
        cropDecisions.push(decision);
        if (decision.losses.orientationViolation) orientationViolations++;
      }

      const totalCost = cropDecisions.reduce((sum, decision) => sum + decision.totalCost, 0);
      const candidate: Candidate = {
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
      };

      if (
        !bestCandidate ||
        candidate.orientationViolations < bestCandidate.orientationViolations ||
        (candidate.orientationViolations === bestCandidate.orientationViolations &&
          candidate.totalCost < bestCandidate.totalCost)
      ) {
        bestCandidate = candidate;
      }
    }
  }

  const candidate = bestCandidate;
  const cw = candidate?.cw ?? canvasW;
  const ch = candidate?.ch ?? canvasH;
  const tileOrder = candidate?.tileOrder ?? [];
  const tileToPhotoIndex = candidate?.tileToPhotoIndex ?? [];

  let placements: Placement[] = tileOrder.map(({ tile }, tileIdx) => {
    const photo = photos[tileToPhotoIndex[tileIdx]];
    const decision = candidate?.cropDecisions[tileIdx];
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

  const validate = () =>
    validateFillArrangePlacements(
      tileOrder.map((item, idx) => ({
        tile: item.tile,
        placement: placements[idx],
      })),
      cw,
      ch,
      { coverMode: true },
    );

  const validation = validate();
  if (!validation.ok) {
    const fallbackTileOrder = buildFallbackGridTiles(n, cw, ch).map(tile => ({
      tile,
      dist: 0,
    }));
    placements = fallbackTileOrder.map(({ tile }, idx) => {
      const photo = photos[idx];
      const tileInput: FillArrangeAssignmentTile = {
        aspect: tile.w / Math.max(1, tile.h),
        dist: 0,
        area: tile.w * tile.h,
      };
      const decision = buildCropDecision(photo, tileInput);
      const scale = Math.max(tile.w / decision.crop.width, tile.h / decision.crop.height);
      return {
        id: photo.id,
        cx: tile.x + tile.w / 2,
        cy: tile.y + tile.h / 2,
        scale,
        rotation: 0,
        crop: decision.crop,
        tileRect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      };
    });
  }

  return {
    placements,
    canvasW: cw,
    canvasH: ch,
    metrics:
      candidate?.metrics ?? {
        evaluatedPairs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        orientationViolations: 0,
        canvasAdjustmentsTried: canvasSizes.length,
      },
  };
}
