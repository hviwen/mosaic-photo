/// <reference lib="webworker" />

import type { CropRect, Placement } from "@/types";
import { centerCropToAspect } from "@/utils/image";
import type { SmartDetection } from "@/utils/smartCrop";

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

  type Rect = { x: number; y: number; w: number; h: number };
  const rectArea = (r: Rect) => r.w * r.h;
  const rectAspect = (r: Rect) => r.w / r.h;

  const canvasArea = Math.max(1, canvasW * canvasH);
  const avgTileSide = Math.sqrt(canvasArea / Math.max(1, n));
  let minSide = clamp(avgTileSide * 0.38, 8, 42);

  const rects: Rect[] = [{ x: 0, y: 0, w: canvasW, h: canvasH }];

  function forceSplitLargestRect(): boolean {
    if (rects.length === 0) return false;
    let largestIdx = 0;
    let largestArea = -1;
    for (let i = 0; i < rects.length; i++) {
      const area = rectArea(rects[i]);
      if (area > largestArea) {
        largestArea = area;
        largestIdx = i;
      }
    }

    const r = rects[largestIdx];
    const splitVertical = r.w >= r.h;
    if (splitVertical) {
      if (r.w < 2) return false;
      const w1 = Math.floor(r.w / 2);
      const w2 = r.w - w1;
      if (w1 < 1 || w2 < 1) return false;
      rects.splice(
        largestIdx,
        1,
        { x: r.x, y: r.y, w: w1, h: r.h },
        { x: r.x + w1, y: r.y, w: w2, h: r.h },
      );
      return true;
    }

    if (r.h < 2) return false;
    const h1 = Math.floor(r.h / 2);
    const h2 = r.h - h1;
    if (h1 < 1 || h2 < 1) return false;
    rects.splice(
      largestIdx,
      1,
      { x: r.x, y: r.y, w: r.w, h: h1 },
      { x: r.x, y: r.y + h1, w: r.w, h: h2 },
    );
    return true;
  }

  // Irregular guillotine partition: keep splitting existing rectangles until we have n tiles.
  const splitGuardLimit = Math.max(64, n * 8);
  let splitGuard = 0;
  while (rects.length < n && splitGuard < splitGuardLimit) {
    splitGuard++;
    let splitDone = false;

    for (let relax = 0; relax < 8 && !splitDone; relax++) {
      // Try candidates (largest first) to avoid getting stuck on tiny blocks.
      const candidates = [...rects]
        .map((r, idx) => ({ r, idx }))
        .sort((a, b) => rectArea(b.r) - rectArea(a.r));

      for (const { r, idx } of candidates) {
        const ar = rectAspect(r);
        const preferVertical =
          ar > 1.2 ? true : ar < 0.85 ? false : rand() > 0.5;

        const trySplit = (vertical: boolean) => {
          if (vertical) {
            if (r.w < minSide * 2) return null;
            const ratio = ratioMin + (ratioMax - ratioMin) * rand();
            const w1 = Math.round(r.w * ratio);
            const w2 = r.w - w1;
            if (w1 < minSide || w2 < minSide) return null;
            const a: Rect = { x: r.x, y: r.y, w: w1, h: r.h };
            const b: Rect = { x: r.x + w1, y: r.y, w: w2, h: r.h };
            return [a, b] as const;
          }

          if (r.h < minSide * 2) return null;
          const ratio = ratioMin + (ratioMax - ratioMin) * rand();
          const h1 = Math.round(r.h * ratio);
          const h2 = r.h - h1;
          if (h1 < minSide || h2 < minSide) return null;
          const a: Rect = { x: r.x, y: r.y, w: r.w, h: h1 };
          const b: Rect = { x: r.x, y: r.y + h1, w: r.w, h: h2 };
          return [a, b] as const;
        };

        const split = trySplit(preferVertical) ?? trySplit(!preferVertical);
        if (!split) continue;

        rects.splice(idx, 1, split[0], split[1]);
        splitDone = true;
        break;
      }

      if (!splitDone) {
        // Relax minSide to guarantee we can always reach n tiles.
        minSide = Math.max(2, minSide * 0.6);
      }
    }

    if (!splitDone) {
      // 兜底强制切分，确保在大批量（如 150 张）场景也能拿到足够 tile。
      if (!forceSplitLargestRect()) break;
      minSide = Math.max(2, minSide * 0.9);
    }
  }

  while (rects.length < n) {
    if (!forceSplitLargestRect()) break;
  }

  if (splitGuard >= splitGuardLimit && rects.length < n) {
    console.warn(
      "[LayoutDebug] fillArrangePhotosWorker: split guard reached, tiles",
      rects.length,
      "needed",
      n,
    );
  }

  const tiles = rects.slice(0, n);
  console.log(
    "[LayoutDebug] fillArrangePhotosWorker: Created",
    tiles.length,
    "tiles, needed",
    n,
  );

  // Greedy match: choose photo whose aspect is closest to tile aspect to reduce crop.
  // Greedy match: center-biased strategy — tiles closer to canvas center
  // prefer photos with aspect ratios closer to 1:1
  const photosLeft = photos.map(photo => {
    const photoAspect = photo.crop.width / Math.max(1, photo.crop.height);
    const deviation = Math.abs(Math.log(Math.max(1e-6, photoAspect)));
    return { photo, deviation };
  });

  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;
  const centerWeight = 0.38;

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

    const ta = tile.w / tile.h;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < photosLeft.length; i++) {
      const item = photosLeft[i];
      const pa = item.photo.crop.width / Math.max(1, item.photo.crop.height);
      const aspectDelta = Math.abs(Math.log(Math.max(1e-6, pa)) - Math.log(ta));
      const score = -(aspectDelta + centerWeight * (1 - dist) * item.deviation);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const p = photosLeft.splice(bestIdx, 1)[0].photo;
    const nextCrop = centerCropToAspect(
      p.crop,
      ta,
      p.imageWidth,
      p.imageHeight,
      {
        detections: p.detections,
      },
    );
    const scale = tile.w / nextCrop.width;

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
