import type { PhotoEntity, ArrangeOptions, Placement, CropRect } from "@/types";
import { centerCropToAspect } from "@/utils/image";
import {
  getSmartDetections,
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
  shouldApplySmartCropByImageAspect,
} from "@/utils/smartCrop";
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

type FillRect = { x: number; y: number; w: number; h: number };

const FILL_MIN_SCALE = 0.1;
const FILL_MAX_SCALE = 2.0;
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
    // 优先选择能让子 tile 比例更接近 [4:6, 6:4] 范围的切分方向
    // 横切（水平分）保持宽度不变、减小高度 → 子 tile 更宽
    // 竖切（垂直分）保持高度不变、减小宽度 → 子 tile 更高
    // 如果当前 tile 太宽（> 6:4），应横切使子 tile 更高
    // 如果当前 tile 太高（< 4:6），应竖切使子 tile 更宽
    let preferVertical: boolean;
    if (rectAspect > SMART_CROP_ASPECT_MAX) {
      // 太宽：竖切（减少宽度）
      preferVertical = true;
    } else if (rectAspect < SMART_CROP_ASPECT_MIN) {
      // 太高：横切（减少高度）
      preferVertical = false;
    } else {
      preferVertical = rectAspect >= 1;
    }
    let split =
      trySplit(preferVertical) ??
      trySplit(!preferVertical) ??
      trySplit(rect.w >= rect.h);

    if (!split) {
      // 极端退化场景兜底（超小像素块）：优先按可切方向二分。
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
  const x = clamp(
    centerX - safeWidth / 2,
    base.x,
    base.x + base.width - safeWidth,
  );
  const y = clamp(
    centerY - safeHeight / 2,
    base.y,
    base.y + base.height - safeHeight,
  );
  return { x, y, width: safeWidth, height: safeHeight };
}

/**
 * 画布“铺满式”自动排版：
 * - 无重叠
 * - 无缝隙（上下左右相邻无间隔）
 * - 所有照片铺满整个画布（无空白区域）
 *
 * 实现策略：递归切分画布为 n 个矩形 tile（整像素边界对齐）。
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

  const root: FillRect = { x: 0, y: 0, w: canvasW, h: canvasH };
  const partitioned = partitionRectToTiles(root, n, rand, ratioMin, ratioMax);
  const tiles =
    partitioned.length === n
      ? partitioned
      : buildFallbackGridTiles(n, canvasW, canvasH);

  console.log(
    "[LayoutDebug] fillArrangePhotos: Created",
    tiles.length,
    "tiles, needed",
    n,
  );

  // Greedy match:
  // 1) 保持“tile 与照片宽高比越接近越优先”
  // 2) 叠加中心优先：中心 tile 更偏好接近 1:1 的照片
  const photosLeft = photos.map(photo => {
    const photoAspect = photo.crop.width / Math.max(1, photo.crop.height);
    const deviation = Math.abs(Math.log(Math.max(1e-6, photoAspect)));
    return { photo, deviation, aspect: photoAspect };
  });

  // 预计算画布中心和最大距离（用于归一化）
  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;

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
    // 始终对极端比例图片启用智能裁剪（不再限制 tile 比例范围），
    // calculateSmartCrop 内部会将裁剪比例限制到 [4:6, 6:4]。
    const shouldSmartCrop = shouldApplySmartCropByImageAspect(
      p.imageWidth,
      p.imageHeight,
    );
    const detections = shouldSmartCrop ? getSmartDetections(p.id) : undefined;
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

    // 命中最大缩放时，优先尝试放大裁剪区域；若不可行，回退计算值保证铺满。
    if (scale < calculatedScale - 1e-6) {
      const targetCropW = tile.w / scale;
      const targetCropH = tile.h / scale;
      if (
        targetCropW <= p.crop.width + 1e-6 &&
        targetCropH <= p.crop.height + 1e-6
      ) {
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

    // 最小缩放命中时，优先收窄裁剪框，避免放大后跨 tile 叠压。
    if (scale > calculatedScale + 1e-6) {
      const targetCropW = tile.w / scale;
      const targetCropH = tile.h / scale;
      nextCrop = recenterCropWithinBase(
        p.crop,
        nextCrop,
        targetCropW,
        targetCropH,
      );
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
