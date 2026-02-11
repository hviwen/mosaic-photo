import type { Placement } from "@/types";

export type FillArrangeRect = { x: number; y: number; w: number; h: number };

export type FillArrangePlacementCheckEntry = {
  tile: FillArrangeRect;
  placement: Placement;
};

export type FillArrangeValidationOptions = {
  strictTileMatchEpsilon?: number;
  boundaryEpsilon?: number;
  overlapEpsilon?: number;
  areaEpsilon?: number;
  /**
   * When true, the photo may be slightly larger than its tile (cover mode).
   * Validation checks that the photo covers the tile completely rather than
   * matching it exactly. Small tile-level overlaps are expected and tolerated.
   */
  coverMode?: boolean;
};

function toDrawRect(placement: Placement): FillArrangeRect | null {
  const crop = placement.crop;
  if (!crop) return null;
  if (!isFinite(placement.scale) || placement.scale <= 0) return null;
  if (!isFinite(crop.width) || !isFinite(crop.height)) return null;
  if (crop.width <= 0 || crop.height <= 0) return null;

  const w = crop.width * placement.scale;
  const h = crop.height * placement.scale;
  return {
    x: placement.cx - w / 2,
    y: placement.cy - h / 2,
    w,
    h,
  };
}

function intersectArea(a: FillArrangeRect, b: FillArrangeRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/**
 * 校验铺满布局结果：
 * - 每张 placement 对应的绘制矩形应与 tile 对齐
 * - 总面积覆盖画布
 * - 无明显重叠
 */
export function validateFillArrangePlacements(
  entries: FillArrangePlacementCheckEntry[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeValidationOptions = {},
): { ok: boolean; reason?: string } {
  const strictTileMatchEpsilon = options.strictTileMatchEpsilon ?? 0.05;
  const boundaryEpsilon = options.boundaryEpsilon ?? 0.05;
  const overlapEpsilon = options.overlapEpsilon ?? 0.1;
  const areaEpsilon = options.areaEpsilon ?? 0.5;
  const coverMode = options.coverMode ?? false;

  // In cover mode, allow up to 50% overflow per dimension (matching the 30% area-loss limit
  // which can cause ~43% overflow in one dimension for extreme-aspect tiles).
  const coverMaxOverflow = coverMode ? 0.5 : 0;

  if (
    !isFinite(canvasW) ||
    !isFinite(canvasH) ||
    canvasW <= 0 ||
    canvasH <= 0
  ) {
    return { ok: false, reason: "invalid canvas size" };
  }
  if (entries.length === 0) return { ok: true };

  const rects: FillArrangeRect[] = [];
  let tileAreaSum = 0;

  for (let i = 0; i < entries.length; i++) {
    const { tile, placement } = entries[i];
    const rect = toDrawRect(placement);
    if (!rect) return { ok: false, reason: `invalid draw rect at index ${i}` };

    if (coverMode) {
      // Cover mode: rect must cover tile (rect >= tile in both dimensions, centered)
      const centerXOk =
        Math.abs(rect.x + rect.w / 2 - (tile.x + tile.w / 2)) <
        strictTileMatchEpsilon;
      const centerYOk =
        Math.abs(rect.y + rect.h / 2 - (tile.y + tile.h / 2)) <
        strictTileMatchEpsilon;
      const coversW = rect.w >= tile.w - strictTileMatchEpsilon;
      const coversH = rect.h >= tile.h - strictTileMatchEpsilon;
      // Overflow should not exceed coverMaxOverflow of tile dimension
      const overflowWOk =
        rect.w - tile.w <= tile.w * coverMaxOverflow + strictTileMatchEpsilon;
      const overflowHOk =
        rect.h - tile.h <= tile.h * coverMaxOverflow + strictTileMatchEpsilon;

      if (!centerXOk || !centerYOk) {
        return { ok: false, reason: `center mismatch at index ${i}` };
      }
      if (!coversW || !coversH) {
        return { ok: false, reason: `photo does not cover tile at index ${i}` };
      }
      if (!overflowWOk || !overflowHOk) {
        return { ok: false, reason: `excessive overflow at index ${i}` };
      }
    } else {
      // Strict mode: rect must match tile exactly
      if (
        Math.abs(rect.x - tile.x) > strictTileMatchEpsilon ||
        Math.abs(rect.y - tile.y) > strictTileMatchEpsilon ||
        Math.abs(rect.w - tile.w) > strictTileMatchEpsilon ||
        Math.abs(rect.h - tile.h) > strictTileMatchEpsilon
      ) {
        return { ok: false, reason: `tile mismatch at index ${i}` };
      }
    }

    if (!coverMode) {
      if (
        rect.x < -boundaryEpsilon ||
        rect.y < -boundaryEpsilon ||
        rect.x + rect.w > canvasW + boundaryEpsilon ||
        rect.y + rect.h > canvasH + boundaryEpsilon
      ) {
        return { ok: false, reason: `out of bounds at index ${i}` };
      }
    }

    rects.push(rect);
    tileAreaSum += tile.w * tile.h;
  }

  const canvasArea = canvasW * canvasH;
  if (Math.abs(tileAreaSum - canvasArea) > areaEpsilon) {
    return { ok: false, reason: "area mismatch" };
  }

  // In cover mode, skip pairwise overlap check (small overlaps expected)
  if (!coverMode) {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (intersectArea(rects[i], rects[j]) > overlapEpsilon) {
          return { ok: false, reason: `overlap between ${i} and ${j}` };
        }
      }
    }
  }

  return { ok: true };
}
