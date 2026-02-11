/// <reference lib="webworker" />

import type { CropRect, Placement } from "@/types";
import { centerCropToAspect } from "@/utils/image";
import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
  type SmartDetection,
} from "@/utils/smartCrop";
import {
  assignPhotosToTiles,
  buildFillArrangePhotoStrategy,
  isFillOrientationReversed,
} from "@/utils/fillArrangeAssignment";
import { validateFillArrangePlacements } from "@/utils/fillArrangeValidation";

type FillArrangeOptions = {
  seed?: number;
  splitRatioMin?: number;
  splitRatioMax?: number;
};

type FillArrangePhotoInput = {
  id: string;
  crop: CropRect;
  imageWidth: number;
  imageHeight: number;
  detections?: SmartDetection[];
};

type FillArrangeRequest = {
  id: number;
  type: "fillArrange";
  photos: FillArrangePhotoInput[];
  canvasW: number;
  canvasH: number;
  options?: FillArrangeOptions;
};

type FillArrangeResponse =
  | { id: number; ok: true; placements: Placement[] }
  | { id: number; ok: false; error: string };

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

type FillRect = { x: number; y: number; w: number; h: number };

const CENTER_BIAS_WEIGHT = 0.55;
const EDGE_BIAS_WEIGHT = 0.14;

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
    // 优先选择能让子 tile 比例更接近 [4:6, 6:4] 的切分方向。
    let preferVertical: boolean;
    if (rectAspect > SMART_CROP_ASPECT_MAX) {
      // 太宽：优先竖切（减少宽度）
      preferVertical = true;
    } else if (rectAspect < SMART_CROP_ASPECT_MIN) {
      // 太高：优先横切（减少高度）
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

function fillArrangePhotosWorker(
  photos: FillArrangePhotoInput[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeOptions = {},
): Placement[] {
  const n = photos.length;
  if (n === 0) return [];

  const ratioMin = clamp(options.splitRatioMin ?? 0.38, 0.2, 0.49);
  const ratioMax = clamp(options.splitRatioMax ?? 0.62, 0.51, 0.8);

  const photosWithStrategy = photos.map(photo => ({
    photo,
    ...buildFillArrangePhotoStrategy(photo.imageWidth, photo.imageHeight),
  }));
  const assignmentPhotos = photosWithStrategy.map(item => ({
    id: item.photo.id,
    sourceAspect: item.sourceAspect,
    preferredAspect: item.preferredAspect,
    orientation: item.orientation,
    isExtreme: item.isExtreme,
  }));
  const assignmentOptions = {
    nonExtremeWeight: 1.1,
    centerBiasWeight: CENTER_BIAS_WEIGHT,
    edgeBiasWeight: EDGE_BIAS_WEIGHT,
    orientationPenalty: 40,
  } as const;

  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
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
  const baseSeed = options.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const maxPartitionAttempts = 8;
  let bestCandidate: {
    tileOrder: Array<{ tile: FillRect; dist: number }>;
    tileToPhotoIndex: number[];
    orientationViolations: number;
    centerCost: number;
    nonExtremeLoss: number;
    weightedLoss: number;
  } | null = null;

  const root: FillRect = { x: 0, y: 0, w: canvasW, h: canvasH };
  for (let attempt = 0; attempt < maxPartitionAttempts; attempt++) {
    let seed = (baseSeed + attempt * 224_682_2519) >>> 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };

    const partitioned = partitionRectToTiles(root, n, rand, ratioMin, ratioMax);
    const tiles =
      partitioned.length === n
        ? partitioned
        : buildFallbackGridTiles(n, canvasW, canvasH);

    const tileOrder = createTileOrder(tiles);

    const tileToPhotoIndex = assignPhotosToTiles(
      assignmentPhotos,
      tileOrder.map(({ tile, dist }) => ({
        aspect: tile.w / Math.max(1, tile.h),
        dist,
      })),
      assignmentOptions,
    );

    let orientationViolations = 0;
    let centerCost = 0;
    let nonExtremeLoss = 0;
    let weightedLoss = 0;
    for (let tileIdx = 0; tileIdx < tileOrder.length; tileIdx++) {
      const item = assignmentPhotos[tileToPhotoIndex[tileIdx]];
      const dist = tileOrder[tileIdx].dist;
      const tileAspect =
        tileOrder[tileIdx].tile.w / Math.max(1, tileOrder[tileIdx].tile.h);
      if (isFillOrientationReversed(item.orientation, tileAspect)) {
        orientationViolations++;
      }
      const deviation = Math.abs(Math.log(Math.max(1e-6, item.sourceAspect)));
      centerCost +=
        CENTER_BIAS_WEIGHT * (1 - dist) * deviation -
        EDGE_BIAS_WEIGHT * dist * deviation;
      const deltaPreferred = Math.abs(
        Math.log(Math.max(1e-6, item.preferredAspect)) -
          Math.log(Math.max(1e-6, tileAspect)),
      );
      weightedLoss += (item.isExtreme ? 1 : 1.1) * deltaPreferred;
      if (!item.isExtreme) {
        nonExtremeLoss += Math.abs(
          Math.log(Math.max(1e-6, item.sourceAspect)) -
            Math.log(Math.max(1e-6, tileAspect)),
        );
      }
    }

    const candidate = {
      tileOrder,
      tileToPhotoIndex,
      orientationViolations,
      centerCost,
      nonExtremeLoss,
      weightedLoss,
    };
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    const isBetter =
      candidate.orientationViolations < bestCandidate.orientationViolations ||
      (candidate.orientationViolations ===
        bestCandidate.orientationViolations &&
        (candidate.centerCost < bestCandidate.centerCost ||
          (candidate.centerCost === bestCandidate.centerCost &&
            (candidate.nonExtremeLoss < bestCandidate.nonExtremeLoss ||
              (candidate.nonExtremeLoss === bestCandidate.nonExtremeLoss &&
                candidate.weightedLoss < bestCandidate.weightedLoss)))));
    if (isBetter) bestCandidate = candidate;
  }

  const tileOrder = bestCandidate
    ? bestCandidate.tileOrder
    : createTileOrder(buildFallbackGridTiles(n, canvasW, canvasH));
  const tileToPhotoIndex = bestCandidate
    ? bestCandidate.tileToPhotoIndex
    : assignPhotosToTiles(
        assignmentPhotos,
        tileOrder.map(({ tile, dist }) => ({
          aspect: tile.w / Math.max(1, tile.h),
          dist,
        })),
        assignmentOptions,
      );

  console.log(
    "[LayoutDebug] fillArrangePhotosWorker: Created",
    tileOrder.length,
    "tiles, needed",
    n,
  );

  const buildPlacementsFor = (
    currentTileOrder: Array<{ tile: FillRect; dist: number }>,
    currentTileToPhotoIndex: number[],
  ): Placement[] => {
    const placements: Placement[] = [];
    for (let tileIdx = 0; tileIdx < currentTileOrder.length; tileIdx++) {
      const { tile } = currentTileOrder[tileIdx];
      const assignedPhoto =
        photosWithStrategy[currentTileToPhotoIndex[tileIdx]];
      if (!assignedPhoto) return [];
      const p = assignedPhoto.photo;
      const ta = tile.w / Math.max(1, tile.h);
      // Always pass detections if available – crop limiting is handled internally
      const detections = p.detections;
      const nextCrop = centerCropToAspect(
        p.crop,
        ta,
        p.imageWidth,
        p.imageHeight,
        detections && detections.length > 0 ? { detections } : undefined,
      );
      if (!isFinite(nextCrop.width) || !isFinite(nextCrop.height)) return [];
      if (nextCrop.width <= 0 || nextCrop.height <= 0) return [];

      // Cover mode: ensure photo fully covers tile even if crop aspect differs
      const scale = Math.max(tile.w / nextCrop.width, tile.h / nextCrop.height);
      placements.push({
        id: p.id,
        cx: tile.x + tile.w / 2,
        cy: tile.y + tile.h / 2,
        scale,
        rotation: 0,
        crop: nextCrop,
      });
    }
    return placements;
  };

  const validatePlacements = (
    currentTileOrder: Array<{ tile: FillRect; dist: number }>,
    placements: Placement[],
  ) => {
    if (placements.length !== currentTileOrder.length) {
      return { ok: false as const, reason: "placement count mismatch" };
    }
    return validateFillArrangePlacements(
      currentTileOrder.map((item, idx) => ({
        tile: item.tile,
        placement: placements[idx],
      })),
      canvasW,
      canvasH,
      { coverMode: true },
    );
  };

  let placements = buildPlacementsFor(tileOrder, tileToPhotoIndex);
  let validation = validatePlacements(tileOrder, placements);

  if (!validation.ok) {
    const fallbackTileOrder = createTileOrder(
      buildFallbackGridTiles(n, canvasW, canvasH),
    );
    const fallbackTileToPhotoIndex = assignPhotosToTiles(
      assignmentPhotos,
      fallbackTileOrder.map(({ tile, dist }) => ({
        aspect: tile.w / Math.max(1, tile.h),
        dist,
      })),
      assignmentOptions,
    );
    const fallbackPlacements = buildPlacementsFor(
      fallbackTileOrder,
      fallbackTileToPhotoIndex,
    );
    const fallbackValidation = validatePlacements(
      fallbackTileOrder,
      fallbackPlacements,
    );
    if (fallbackValidation.ok) {
      placements = fallbackPlacements;
      validation = fallbackValidation;
    } else {
      console.warn(
        "[LayoutDebug] fillArrangePhotosWorker: fallback validation failed:",
        fallbackValidation.reason,
      );
    }
  }

  console.log(
    "[LayoutDebug] fillArrangePhotosWorker: Generated",
    placements.length,
    "placements out of",
    n,
    "photos",
  );
  return placements;
}

self.onmessage = (e: MessageEvent<FillArrangeRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== "fillArrange") return;

  try {
    const placements = fillArrangePhotosWorker(
      msg.photos,
      msg.canvasW,
      msg.canvasH,
      msg.options,
    );
    const res: FillArrangeResponse = { id: msg.id, ok: true, placements };
    self.postMessage(res);
  } catch (err) {
    const res: FillArrangeResponse = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};
