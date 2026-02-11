import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
} from "@/utils/smartCrop";

export type FillOrientation = "portrait" | "landscape" | "square";

export type FillArrangePhotoStrategy = {
  sourceAspect: number;
  preferredAspect: number;
  orientation: FillOrientation;
  isExtreme: boolean;
};

export type FillArrangeAssignmentPhoto = FillArrangePhotoStrategy & {
  id: string;
};

export type FillArrangeAssignmentTile = {
  aspect: number;
  dist: number;
};

export type FillArrangeAssignmentOptions = {
  nonExtremeWeight?: number;
  centerBiasWeight?: number;
  edgeBiasWeight?: number;
  orientationPenalty?: number;
};

const EPS = 1e-6;
const HARD_ORIENTATION_BLOCK_COST = 1e7;

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

function safeAspect(aspect: number): number {
  if (!isFinite(aspect) || aspect <= 0) return 1;
  return Math.max(EPS, aspect);
}

function toOrientation(aspect: number): FillOrientation {
  if (aspect > 1 + EPS) return "landscape";
  if (aspect < 1 - EPS) return "portrait";
  return "square";
}

function isOrientationReversed(
  photoOrientation: FillOrientation,
  tileAspect: number,
): boolean {
  const tileOrientation = toOrientation(tileAspect);
  if (photoOrientation === "square" || tileOrientation === "square") return false;
  return photoOrientation !== tileOrientation;
}

export function isFillOrientationReversed(
  photoOrientation: FillOrientation,
  tileAspect: number,
): boolean {
  return isOrientationReversed(photoOrientation, tileAspect);
}

function deviationFromSquare(aspect: number): number {
  return Math.abs(Math.log(safeAspect(aspect)));
}

function createAllowedOrientationMatrix(
  photos: FillArrangeAssignmentPhoto[],
  tiles: FillArrangeAssignmentTile[],
): boolean[][] {
  return photos.map(photo =>
    tiles.map(tile => !isOrientationReversed(photo.orientation, tile.aspect)),
  );
}

/**
 * 基于允许边做一次二分图完美匹配探测：
 * - 返回 null 表示“严格方向约束下无解”
 * - 返回数组表示每张 photo 分配到的 tile 下标
 */
function findPerfectMatching(allowed: boolean[][]): number[] | null {
  const n = allowed.length;
  if (n === 0) return [];
  const m = allowed[0]?.length ?? 0;
  if (m !== n) return null;

  const tileToPhoto = Array<number>(n).fill(-1);
  const photoToTile = Array<number>(n).fill(-1);

  const dfs = (photoIdx: number, seen: boolean[]): boolean => {
    for (let tileIdx = 0; tileIdx < n; tileIdx++) {
      if (!allowed[photoIdx][tileIdx] || seen[tileIdx]) continue;
      seen[tileIdx] = true;
      const matchedPhoto = tileToPhoto[tileIdx];
      if (matchedPhoto === -1 || dfs(matchedPhoto, seen)) {
        tileToPhoto[tileIdx] = photoIdx;
        photoToTile[photoIdx] = tileIdx;
        return true;
      }
    }
    return false;
  };

  for (let photoIdx = 0; photoIdx < n; photoIdx++) {
    const seen = Array<boolean>(n).fill(false);
    if (!dfs(photoIdx, seen)) return null;
  }

  return photoToTile;
}

function buildCostMatrix(
  photos: FillArrangeAssignmentPhoto[],
  tiles: FillArrangeAssignmentTile[],
  options: Required<FillArrangeAssignmentOptions>,
  strictOrientation: boolean,
): number[][] {
  const costs = photos.map(photo => {
    const prefAspect = safeAspect(photo.preferredAspect);
    const deviation = deviationFromSquare(prefAspect);
    const aspectWeight = photo.isExtreme ? 1 : options.nonExtremeWeight;

    return tiles.map(tile => {
      const tileAspect = safeAspect(tile.aspect);
      const aspectDelta = Math.abs(Math.log(prefAspect) - Math.log(tileAspect));
      const centerPenalty =
        options.centerBiasWeight * (1 - tile.dist) * deviation -
        options.edgeBiasWeight * tile.dist * deviation;
      const reversed = isOrientationReversed(photo.orientation, tileAspect);
      const orientationPenalty = reversed ? options.orientationPenalty : 0;
      const hardPenalty =
        strictOrientation && reversed ? HARD_ORIENTATION_BLOCK_COST : 0;
      return aspectWeight * aspectDelta + centerPenalty + orientationPenalty + hardPenalty;
    });
  });

  let minValue = Infinity;
  for (const row of costs) {
    for (const value of row) minValue = Math.min(minValue, value);
  }
  if (isFinite(minValue) && minValue < 0) {
    const offset = Math.abs(minValue);
    for (const row of costs) {
      for (let i = 0; i < row.length; i++) row[i] += offset;
    }
  }
  return costs;
}

/**
 * Hungarian 算法（最小权完美匹配）：
 * 输入 n*n 代价矩阵，输出每个 photo 对应的 tile 下标。
 */
function solveHungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0]?.length ?? 0;
  if (m !== n) {
    throw new Error("fillArrange assignment requires square matrix");
  }

  const u = Array<number>(n + 1).fill(0);
  const v = Array<number>(m + 1).fill(0);
  const p = Array<number>(m + 1).fill(0);
  const way = Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array<number>(m + 1).fill(Infinity);
    const used = Array<boolean>(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const photoToTile = Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const photo = p[j];
    if (photo > 0) photoToTile[photo - 1] = j - 1;
  }

  if (photoToTile.some(idx => idx < 0)) {
    throw new Error("fillArrange assignment failed: incomplete matching");
  }
  return photoToTile;
}

export function buildFillArrangePhotoStrategy(
  imageWidth: number,
  imageHeight: number,
): FillArrangePhotoStrategy {
  const safeW = Math.max(1, imageWidth);
  const safeH = Math.max(1, imageHeight);
  const sourceAspect = safeAspect(safeW / safeH);

  if (sourceAspect < SMART_CROP_ASPECT_MIN) {
    return {
      sourceAspect,
      preferredAspect: clamp(sourceAspect, SMART_CROP_ASPECT_MIN, 1),
      orientation: toOrientation(sourceAspect),
      isExtreme: true,
    };
  }

  if (sourceAspect > SMART_CROP_ASPECT_MAX) {
    return {
      sourceAspect,
      preferredAspect: clamp(sourceAspect, 1, SMART_CROP_ASPECT_MAX),
      orientation: toOrientation(sourceAspect),
      isExtreme: true,
    };
  }

  return {
    sourceAspect,
    preferredAspect: sourceAspect,
    orientation: toOrientation(sourceAspect),
    isExtreme: false,
  };
}

/**
 * 计算“tile -> photoIndex”的全局最小代价分配。
 * - 优先最小化裁剪比例损失
 * - 对非极端图提高权重（尽量保持原比例）
 * - 方向不反转可行时作为硬约束，否则退化为强惩罚
 */
export function assignPhotosToTiles(
  photos: FillArrangeAssignmentPhoto[],
  tiles: FillArrangeAssignmentTile[],
  options: FillArrangeAssignmentOptions = {},
): number[] {
  if (photos.length !== tiles.length) {
    throw new Error("fillArrange assignment requires equal photo/tile count");
  }
  const n = photos.length;
  if (n === 0) return [];

  const resolved: Required<FillArrangeAssignmentOptions> = {
    nonExtremeWeight: options.nonExtremeWeight ?? 1.1,
    centerBiasWeight: options.centerBiasWeight ?? 0.55,
    edgeBiasWeight: options.edgeBiasWeight ?? 0.14,
    orientationPenalty: options.orientationPenalty ?? 40,
  };

  const allowed = createAllowedOrientationMatrix(photos, tiles);
  const hardMatch = findPerfectMatching(allowed);
  const strictOrientation = hardMatch !== null;

  const cost = buildCostMatrix(photos, tiles, resolved, strictOrientation);
  let photoToTile = solveHungarian(cost);

  if (strictOrientation) {
    const violates = photoToTile.some((tileIdx, photoIdx) =>
      isOrientationReversed(photos[photoIdx].orientation, tiles[tileIdx].aspect),
    );
    if (violates && hardMatch) {
      // 极端浮点/数值场景兜底：退回到严格方向可行匹配，确保不反转方向。
      photoToTile = hardMatch;
    }
  }

  const tileToPhoto = Array<number>(n).fill(-1);
  photoToTile.forEach((tileIdx, photoIdx) => {
    tileToPhoto[tileIdx] = photoIdx;
  });
  if (tileToPhoto.some(idx => idx < 0)) {
    throw new Error("fillArrange assignment failed: missing tile mapping");
  }
  return tileToPhoto;
}
