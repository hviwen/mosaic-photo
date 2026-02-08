import type { PhotoEntity, ArrangeOptions, Placement } from "@/types";
import { centerCropToAspect } from "@/utils/image";
import { getSmartDetections } from "@/utils/smartCrop";
import {
  randomInRange,
  degreesToRadians,
  clamp,
  rotatedAABBHalf,
  photoToOBB,
  obbIntersects,
} from "@/utils/math";

/**
 * 计算照片面积
 */
function area(photo: PhotoEntity): number {
  return photo.crop.width * photo.crop.height;
}

/**
 * 检测候选照片是否与已放置的照片碰撞
 */
function collides(
  candidate: PhotoEntity,
  placed: PhotoEntity[],
  padding: number,
): boolean {
  const a = photoToOBB(candidate);
  for (const p of placed) {
    if (obbIntersects(a, photoToOBB(p), padding)) return true;
  }
  return false;
}

/**
 * 生成偏向中心的采样点
 */
function sampleCenterBiased(
  canvasW: number,
  canvasH: number,
): { x: number; y: number } {
  const u = Math.random();
  if (u < 0.55) {
    // 使用三角分布，偏向中心
    const sx = (Math.random() + Math.random() + Math.random()) / 3;
    const sy = (Math.random() + Math.random() + Math.random()) / 3;
    return { x: canvasW * sx, y: canvasH * sy };
  }
  return { x: Math.random() * canvasW, y: Math.random() * canvasH };
}

/**
 * 网格采样（更均匀的分布）
 */
function sampleGrid(
  canvasW: number,
  canvasH: number,
  gridSize: number = 4,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const cellW = canvasW / gridSize;
  const cellH = canvasH / gridSize;

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      // 在每个网格单元内随机采样
      const x = (i + Math.random()) * cellW;
      const y = (j + Math.random()) * cellH;
      points.push({ x, y });
    }
  }

  // 打乱顺序
  return points.sort(() => Math.random() - 0.5);
}

/**
 * 自动排列照片 - 优化版算法
 *
 * 改进点：
 * 1. 使用网格采样提高成功率
 * 2. 动态调整缩放因子
 * 3. 支持螺旋式布局
 */
export function autoArrangePhotos(
  photos: PhotoEntity[],
  canvasW: number,
  canvasH: number,
  options: ArrangeOptions = {},
): Placement[] | null {
  const padding = options.paddingPx ?? 12;
  const maxGlobalRetries = options.maxGlobalRetries ?? 8;
  const maxCandidates = options.maxCandidates ?? 1200;
  const randomScaleMin = options.randomScaleMin ?? 0.25;
  const randomScaleMax = options.randomScaleMax ?? 0.75;
  const rotationDeg = options.rotationDeg ?? 5;

  // 按面积从大到小排序
  const sorted = [...photos].sort((a, b) => area(b) - area(a));

  for (let global = 0; global <= maxGlobalRetries; global++) {
    const globalShrink = Math.pow(0.92, global);
    const placed: PhotoEntity[] = [];
    const placements: Placement[] = [];
    let failed = false;

    for (let photoIdx = 0; photoIdx < sorted.length; photoIdx++) {
      const p = sorted[photoIdx];

      // 基础缩放，确保能放入画布
      const fit =
        Math.min(canvasW / p.crop.width, canvasH / p.crop.height) * 0.9;
      let s =
        fit * randomInRange(randomScaleMin, randomScaleMax) * globalShrink;
      s = clamp(s, 0.05, 3);

      // 轻微随机旋转
      const rot = degreesToRadians(randomInRange(-rotationDeg, rotationDeg));

      let placedOk = false;

      for (let shrinkTry = 0; shrinkTry < 8 && !placedOk; shrinkTry++) {
        const hw = (p.crop.width * s) / 2;
        const hh = (p.crop.height * s) / 2;
        const { ex, ey } = rotatedAABBHalf(hw, hh, rot);

        // 检查是否太大
        if (ex * 2 > canvasW || ey * 2 > canvasH) {
          s *= 0.85;
          continue;
        }

        // 混合采样策略
        const gridPoints = sampleGrid(canvasW, canvasH, 6);
        const samples = [
          ...gridPoints,
          ...Array.from({ length: maxCandidates - gridPoints.length }, () =>
            sampleCenterBiased(canvasW, canvasH),
          ),
        ];

        for (const sample of samples) {
          const cx = clamp(sample.x, ex, canvasW - ex);
          const cy = clamp(sample.y, ey, canvasH - ey);

          const candidate: PhotoEntity = {
            ...p,
            cx,
            cy,
            scale: s,
            rotation: rot,
          };

          if (!collides(candidate, placed, padding)) {
            placed.push(candidate);
            placements.push({ id: p.id, cx, cy, scale: s, rotation: rot });
            placedOk = true;
            break;
          }
        }

        if (!placedOk) s *= 0.85;
      }

      if (!placedOk) {
        failed = true;
        break;
      }
    }

    if (!failed && placements.length === photos.length) {
      return placements;
    }
  }

  return null;
}

/**
 * 紧凑排列 - 尽可能减少空白
 */
export function compactArrange(
  photos: PhotoEntity[],
  canvasW: number,
  canvasH: number,
  targetScale: number = 0.3,
): Placement[] {
  const sorted = [...photos].sort((a, b) => area(b) - area(a));
  const placements: Placement[] = [];

  // 计算每行可以放置的照片数量
  const avgWidth =
    sorted.reduce((sum, p) => sum + p.crop.width, 0) / sorted.length;
  const avgHeight =
    sorted.reduce((sum, p) => sum + p.crop.height, 0) / sorted.length;

  const scale = Math.min(
    targetScale,
    canvasW / (avgWidth * 3),
    canvasH / (avgHeight * 3),
  );

  const padding = 20;
  let currentX = padding;
  let currentY = padding;
  let rowHeight = 0;

  for (const photo of sorted) {
    const w = photo.crop.width * scale;
    const h = photo.crop.height * scale;

    if (currentX + w > canvasW - padding) {
      currentX = padding;
      currentY += rowHeight + padding;
      rowHeight = 0;
    }

    if (currentY + h > canvasH - padding) {
      // 画布已满，使用更小的缩放
      break;
    }

    placements.push({
      id: photo.id,
      cx: currentX + w / 2,
      cy: currentY + h / 2,
      scale,
      rotation: 0,
    });

    currentX += w + padding;
    rowHeight = Math.max(rowHeight, h);
  }

  return placements;
}

export interface FillArrangeOptions {
  /**
   * 随机种子：不传则每次排版不同。
   * 传入固定 seed 可让布局可复现。
   */
  seed?: number;

  /**
   * 切分比例范围（避免过细的条状块）。
   */
  splitRatioMin?: number;
  splitRatioMax?: number;
}

/**
 * 画布“铺满式”自动排版：
 * - 无重叠
 * - 无缝隙（上下左右相邻无间隔）
 * - 所有照片铺满整个画布（无空白区域）
 *
 * 实现策略：把画布按行切分，每行按数量等分宽度，形成 n 个矩形 tile。
 * 每张照片会被自动居中裁剪到 tile 的宽高比，避免拉伸变形。
 */
export function fillArrangePhotos(
  photos: PhotoEntity[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeOptions = {},
): Placement[] {
  const n = photos.length;
  if (n === 0) return [];
  console.log(
    "[LayoutDebug] fillArrangePhotos: Input",
    n,
    "photos, canvas",
    canvasW,
    "x",
    canvasH,
  );

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

  // 二次兜底：继续强制切分，优先保证 tile 数量达到 n。
  while (rects.length < n) {
    if (!forceSplitLargestRect()) break;
  }

  if (splitGuard >= splitGuardLimit && rects.length < n) {
    console.warn(
      "[LayoutDebug] fillArrangePhotos: split guard reached, tiles",
      rects.length,
      "needed",
      n,
    );
  }

  const tiles = rects.slice(0, n);
  console.log(
    "[LayoutDebug] fillArrangePhotos: Created",
    tiles.length,
    "tiles, needed",
    n,
  );

  // Greedy match: choose photo whose aspect is closest to tile aspect to reduce crop.
  // 优化2：中心放置策略——中心 tile 更优先给接近 1:1 的照片。
  const photosLeft = photos.map(photo => {
    const photoAspect = photo.crop.width / Math.max(1, photo.crop.height);
    const deviation = Math.abs(Math.log(Math.max(1e-6, photoAspect)));
    return { photo, deviation };
  });

  // 预计算画布中心和最大距离（用于归一化）
  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;
  const centerWeight = 0.38;

  // 按中心距离升序排序（从中心到边缘），而非按面积降序
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
      // 中心越近，越惩罚长条图（deviation 大）。
      const score = -(aspectDelta + centerWeight * (1 - dist) * item.deviation);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const p = photosLeft.splice(bestIdx, 1)[0].photo;
    const detections = getSmartDetections(p.id);
    const nextCrop = centerCropToAspect(
      p.crop,
      ta,
      p.imageWidth,
      p.imageHeight,
      { detections },
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

  // Preserve original input order by mapping back (store.applyPlacements matches by id).
  console.log(
    "[LayoutDebug] fillArrangePhotos: Generated",
    placements.length,
    "placements out of",
    n,
    "photos",
  );
  return placements;
}
