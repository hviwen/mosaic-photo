/// <reference lib="webworker" />

import type { CropRect, Placement } from "@/types";
import { centerCropToAspect } from "@/utils/image";
import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
  shouldApplySmartCropByImageAspect,
  type SmartDetection,
} from "@/utils/smartCrop";

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

const FILL_MIN_SCALE = 0.1;
const FILL_MAX_SCALE = 2.0;
const CENTER_BIAS_WEIGHT = 0.55;
const EDGE_BIAS_WEIGHT = 0.14;

function splitLength(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
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
    const preferVertical = rectAspect >= 1;
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

    return [
      ...splitRec(split.a, leftCount),
      ...splitRec(split.b, rightCount),
    ];
  };

  return splitRec(root, count);
}

function recenterCropWithinBase(
  base: CropRect,
  preferred: CropRect,
  targetWidth: number,
  targetHeight: number,
): CropRect {
  const safeWidth = clamp(targetWidth, 1, base.width);
  const safeHeight = clamp(targetHeight, 1, base.height);
  const centerX = preferred.x + preferred.width / 2;
  const centerY = preferred.y + preferred.height / 2;
  const x = clamp(centerX - safeWidth / 2, base.x, base.x + base.width - safeWidth);
  const y = clamp(
    centerY - safeHeight / 2,
    base.y,
    base.y + base.height - safeHeight,
  );
  return { x, y, width: safeWidth, height: safeHeight };
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

  // Simple deterministic RNG when seed is provided.
  let seed = options.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  const root: FillRect = { x: 0, y: 0, w: canvasW, h: canvasH };
  const partitioned = partitionRectToTiles(root, n, rand, ratioMin, ratioMax);
  const tiles =
    partitioned.length === n
      ? partitioned
      : buildFallbackGridTiles(n, canvasW, canvasH);

  console.log(
    "[LayoutDebug] fillArrangePhotosWorker: Created",
    tiles.length,
    "tiles, needed",
    n,
  );

  // Greedy match:
  // 1) 保留“宽高比越接近越优先”
  // 2) 叠加中心优先，中心 tile 更倾向 1:1 照片
  const photosLeft = photos.map(photo => {
    const photoAspect = photo.crop.width / Math.max(1, photo.crop.height);
    const deviation = Math.abs(Math.log(Math.max(1e-6, photoAspect)));
    return { photo, deviation, aspect: photoAspect };
  });

  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;

  const tileOrder = [...tiles]
    .map(tile => {
      const tileCx = tile.x + tile.w / 2;
      const tileCy = tile.y + tile.h / 2;
      const dist = Math.sqrt(
        (tileCx - canvasCx) ** 2 + (tileCy - canvasCy) ** 2,
      );
      return { tile, dist: dist / maxDist };
    })
    .sort((a, b) => a.dist - b.dist);

  const placements: Placement[] = [];
  for (const { tile, dist } of tileOrder) {
    if (photosLeft.length === 0) break;

    const ta = tile.w / Math.max(1, tile.h);
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < photosLeft.length; i++) {
      const item = photosLeft[i];
      const aspectDelta = Math.abs(
        Math.log(Math.max(1e-6, item.aspect)) - Math.log(Math.max(1e-6, ta)),
      );
      const centerPenalty = CENTER_BIAS_WEIGHT * (1 - dist) * item.deviation;
      const edgeBonus = EDGE_BIAS_WEIGHT * dist * item.deviation;
      const cost = aspectDelta + centerPenalty - edgeBonus;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }

    const p = photosLeft.splice(bestIdx, 1)[0].photo;
    const shouldSmartCrop = shouldApplySmartCropByImageAspect(
      p.imageWidth,
      p.imageHeight,
    ) && ta >= SMART_CROP_ASPECT_MIN &&
      ta <= SMART_CROP_ASPECT_MAX;
    const detections = shouldSmartCrop ? p.detections : undefined;
    let nextCrop = centerCropToAspect(
      p.crop,
      ta,
      p.imageWidth,
      p.imageHeight,
      detections && detections.length > 0 ? { detections } : undefined,
    );
    const calculatedScale = tile.w / Math.max(1, nextCrop.width);
    const clampedScale = Math.max(
      FILL_MIN_SCALE,
      Math.min(FILL_MAX_SCALE, calculatedScale),
    );
    let scale = clampedScale;

    if (scale < calculatedScale - 1e-6) {
      const targetCropW = tile.w / scale;
      const targetCropH = tile.h / scale;
      if (targetCropW <= p.crop.width + 1e-6 && targetCropH <= p.crop.height + 1e-6) {
        nextCrop = recenterCropWithinBase(
          p.crop,
          nextCrop,
          targetCropW,
          targetCropH,
        );
      } else {
        scale = calculatedScale;
      }
    }

    if (scale > calculatedScale + 1e-6) {
      const targetCropW = tile.w / scale;
      const targetCropH = tile.h / scale;
      nextCrop = recenterCropWithinBase(p.crop, nextCrop, targetCropW, targetCropH);
    }

    placements.push({
      id: p.id,
      cx: tile.x + tile.w / 2,
      cy: tile.y + tile.h / 2,
      scale,
      rotation: 0,
      crop: nextCrop,
    });
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
