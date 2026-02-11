import type { CropRect } from "@/types";
import type { KeepRegion, KeepRegionKind } from "@/types/vision";

export type SmartDetectionKind = KeepRegionKind;
export type SmartDetection = KeepRegion;
export type FaceDetection = SmartDetection & { kind: "face" };

export interface SmartCropConfig {
  /**
   * 单次检测用于加速的最大边长（会等比缩小后检测，再映射回原图坐标）
   */
  detectionMaxEdge?: number;
  /**
   * 人脸最多返回数量
   */
  maxFaces?: number;
  /**
   * 人脸检测最低分数（native FaceDetector 不一定提供 score，会默认 1）
   */
  faceScoreThreshold?: number;
  /**
   * 检测的超时时间（用于保证交互流畅）
   */
  deadlineMs?: number;
  /**
   * 是否启用“显著性（内容密度）”对象检测兜底
   */
  enableSaliencyObject?: boolean;
}

const DEFAULT_CONFIG: Required<SmartCropConfig> = {
  detectionMaxEdge: 640,
  maxFaces: 5,
  faceScoreThreshold: 0.2,
  deadlineMs: 450,
  enableSaliencyObject: true,
};

let config: Required<SmartCropConfig> = { ...DEFAULT_CONFIG };

export function setSmartCropConfig(next: SmartCropConfig) {
  config = { ...config, ...next };
}

export type FaceDetectionProviderResult = {
  /**
   * 注意：此 boundingBox 坐标以“输入给 provider 的 canvas”为基准（通常是缩放后的检测画布）
   */
  boundingBox: CropRect;
  score?: number;
};

/**
 * 可插拔的人脸检测 Provider：
 * - 默认使用浏览器原生 Shape Detection API (FaceDetector)
 * - 若希望接入 MediaPipe / face-api.js，可在业务侧注入 provider（避免把大模型/wasm 强绑进主包）
 */
export type FaceDetectionProvider = (
  canvas: HTMLCanvasElement,
  options: { maxFaces: number },
) => Promise<FaceDetectionProviderResult[]>;

let faceDetectionProvider: FaceDetectionProvider | null = null;

export function setFaceDetectionProvider(
  provider: FaceDetectionProvider | null,
) {
  faceDetectionProvider = provider;
}

type CacheEntry = {
  detections: SmartDetection[];
  updatedAt: number;
  hasFaces: boolean;
  hasObjects: boolean;
};

const detectionCache = new Map<string, CacheEntry>();
const facePending = new Map<string, Promise<FaceDetection[]>>();

let revision = 0;
type DetectionsListener = (photoId: string) => void;
const listeners = new Set<DetectionsListener>();

export function onSmartDetectionsChanged(
  listener: DetectionsListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitDetectionsChanged(photoId: string) {
  revision++;
  for (const l of listeners) {
    try {
      l(photoId);
    } catch {
      // ignore listener errors
    }
  }
}

export function getSmartDetectionsRevision(): number {
  return revision;
}

export function getSmartDetections(
  photoId: string,
): SmartDetection[] | undefined {
  return detectionCache.get(photoId)?.detections;
}

export function getSmartDetectionsState(photoId: string): {
  hasCache: boolean;
  hasFaces: boolean;
  hasObjects: boolean;
  facePending: boolean;
} {
  const cached = detectionCache.get(photoId);
  return {
    hasCache: Boolean(cached),
    hasFaces: cached?.hasFaces ?? false,
    hasObjects: cached?.hasObjects ?? false,
    facePending: facePending.has(photoId),
  };
}

export function invalidateSmartDetections(photoId: string) {
  detectionCache.delete(photoId);
  facePending.delete(photoId);
}

export function prefetchSmartDetections(
  photoId: string,
  source: CanvasImageSource,
) {
  console.log("[FaceDebug] prefetchSmartDetections called for photo:", photoId); // 先快速放入“对象显著性”结果，让首次自动排版立刻可用
  trySeedSaliencyObject(photoId, source);
  // 再异步做更准确的人脸检测（若浏览器支持）
  void ensureFaces(photoId, source);
}

/**
 * 将外部检测结果“种入”缓存（常用于 Web Worker 推理后回传的 keep-regions）。
 * 坐标系：与 PhotoEntity.image（预览图）一致。
 */
export function seedSmartDetections(
  photoId: string,
  detections: KeepRegion[],
  flags: { hasFaces: boolean; hasObjects: boolean },
) {
  mergeDetections(photoId, detections, flags);
}

async function ensureFaces(
  photoId: string,
  source: CanvasImageSource,
): Promise<FaceDetection[]> {
  console.log("[FaceDebug] ensureFaces called for photo:", photoId);
  const cached = detectionCache.get(photoId);
  if (cached?.hasFaces) {
    console.log("[FaceDebug] ensureFaces: Using cached faces");
    return cached.detections.filter(d => d.kind === "face") as FaceDetection[];
  }

  const existing = facePending.get(photoId);
  if (existing) {
    console.log("[FaceDebug] ensureFaces: Face detection already pending");
    return existing;
  }

  console.log("[FaceDebug] ensureFaces: Starting new face detection");
  const promise = withDeadline<FaceDetection[]>(
    (async () => {
      const faces = await detectFaces(source);
      console.log(
        "[FaceDebug] ensureFaces: detectFaces returned",
        faces.length,
        "faces",
      );
      const filtered = faces
        .filter(f => isFinite(f.score) && f.score >= config.faceScoreThreshold)
        .slice(0, config.maxFaces);

      console.log(
        "[FaceDebug] ensureFaces: After filtering, kept",
        filtered.length,
        "faces",
      );
      mergeDetections(photoId, filtered, { hasFaces: true });
      return filtered;
    })(),
    config.deadlineMs,
    [],
  );

  facePending.set(photoId, promise);
  let result: FaceDetection[] = [];
  try {
    result = await promise;
    console.log(
      "[FaceDebug] ensureFaces: Final result:",
      result.length,
      "faces",
    );
    return result;
  } finally {
    facePending.delete(photoId);
    // 即使没人脸，也要通知一次，便于 UI 结束“检测中”状态。
    if (result.length === 0) emitDetectionsChanged(photoId);
  }
}

function trySeedSaliencyObject(photoId: string, source: CanvasImageSource) {
  if (!config.enableSaliencyObject) return;
  const cached = detectionCache.get(photoId);
  if (cached?.hasObjects) return;

  const obj = detectSaliencyObject(source);
  if (obj.length === 0) return;
  mergeDetections(photoId, obj, { hasObjects: true });
}

function mergeDetections(
  photoId: string,
  add: SmartDetection[],
  flags: Partial<Pick<CacheEntry, "hasFaces" | "hasObjects">>,
) {
  const prev = detectionCache.get(photoId);
  const prevDetections = prev?.detections ?? [];

  // 保持 faces 优先、objects 兜底：合并时不去重，避免 O(n^2)；数量很小影响可忽略
  const next = [...prevDetections, ...add];
  const nextEntry: CacheEntry = {
    detections: next,
    updatedAt: Date.now(),
    hasFaces: flags.hasFaces ?? prev?.hasFaces ?? false,
    hasObjects: flags.hasObjects ?? prev?.hasObjects ?? false,
  };

  // 只有在确实新增了内容才增加 revision，避免频繁触发重排
  const changed = add.length > 0;
  detectionCache.set(photoId, nextEntry);
  if (changed) {
    emitDetectionsChanged(photoId);
  }
}

type Size = { width: number; height: number };

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

/**
 * 智能裁剪期望比例边界：
 * - 最窄 4:6（约 0.667）
 * - 最宽 6:4（1.5）
 */
export const SMART_CROP_ASPECT_MIN = 1 / 1.5;
export const SMART_CROP_ASPECT_MAX = 1.5;

/**
 * 是否需要启用“比例受限”的智能裁剪：
 * - 竖图且高宽比 > 1.5
 * - 横图且高宽比 < 0.667（等价于宽高比 > 1.5）
 */
export function shouldApplySmartCropByImageAspect(
  imageWidth: number,
  imageHeight: number,
): boolean {
  const safeW = Math.max(1, imageWidth);
  const safeH = Math.max(1, imageHeight);
  const hOverW = safeH / safeW;

  if (safeH > safeW) return hOverW > SMART_CROP_ASPECT_MAX;
  if (safeW > safeH) return hOverW < SMART_CROP_ASPECT_MIN;
  return false;
}

/**
 * 按原图宽高比决定目标裁剪比例是否需要限制。
 */
export function clampSmartCropTargetAspect(
  targetAspect: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (!isFinite(targetAspect) || targetAspect <= 0) return targetAspect;
  const safeW = Math.max(1, imageWidth);
  const safeH = Math.max(1, imageHeight);
  const srcAspect = safeW / safeH;

  if (srcAspect < SMART_CROP_ASPECT_MIN) {
    return clamp(targetAspect, SMART_CROP_ASPECT_MIN, 1);
  }
  if (srcAspect > SMART_CROP_ASPECT_MAX) {
    return clamp(targetAspect, 1, SMART_CROP_ASPECT_MAX);
  }

  // Non-extreme images: allow limited deviation from srcAspect (max 25%).
  // This prevents a 1:1 image being cropped to 1.9:1, for instance.
  const MAX_ASPECT_DEVIATION = 0.25;
  const lo = srcAspect / (1 + MAX_ASPECT_DEVIATION);
  const hi = srcAspect * (1 + MAX_ASPECT_DEVIATION);
  return clamp(targetAspect, lo, hi);
}

function resolveSourceSize(source: CanvasImageSource): Size | null {
  if (
    typeof HTMLImageElement !== "undefined" &&
    source instanceof HTMLImageElement
  ) {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    source instanceof HTMLCanvasElement
  ) {
    if (source.width > 0 && source.height > 0)
      return { width: source.width, height: source.height };
    return null;
  }
  const maybeSize = source as unknown as { width?: unknown; height?: unknown };
  if (
    typeof maybeSize.width === "number" &&
    typeof maybeSize.height === "number"
  ) {
    const w = maybeSize.width;
    const h = maybeSize.height;
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

function toCanvasForDetection(
  source: CanvasImageSource,
  maxEdge: number,
): { canvas: HTMLCanvasElement; scaleX: number; scaleY: number } | null {
  const size = resolveSourceSize(source);
  if (!size) return null;

  const { width, height } = size;
  const edge = Math.max(width, height);
  const ratio = edge > maxEdge ? maxEdge / edge : 1;
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch {
    return null;
  }

  return { canvas, scaleX: width / w, scaleY: height / h };
}

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  if (!isFinite(ms) || ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>(resolve => {
    let settled = false;
    const setTimeoutFn = (
      globalThis as unknown as { setTimeout?: typeof setTimeout }
    ).setTimeout;
    const clearTimeoutFn = (
      globalThis as unknown as { clearTimeout?: typeof clearTimeout }
    ).clearTimeout;
    if (!setTimeoutFn || !clearTimeoutFn) {
      promise.then(v => resolve(v)).catch(() => resolve(fallback));
      return;
    }

    const t = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);

    promise
      .then(v => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(t as any);
        resolve(v);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(t as any);
        resolve(fallback);
      });
  });
}

/**
 * 人脸检测：
 * - 默认使用浏览器原生 Shape Detection API (FaceDetector)，无需额外模型文件
 * - 也支持通过 setFaceDetectionProvider 注入第三方实现（例如 MediaPipe / face-api.js）
 * - 在不支持且未注入 provider 的浏览器中返回空数组（由对象显著性/居中裁剪兜底）
 */
export async function detectFaces(
  image: CanvasImageSource,
): Promise<FaceDetection[]> {
  const prepared = toCanvasForDetection(image, config.detectionMaxEdge);
  if (!prepared) {
    console.log("[FaceDebug] detectFaces: toCanvasForDetection failed");
    return [];
  }

  const { canvas, scaleX, scaleY } = prepared;

  try {
    const provider =
      faceDetectionProvider ?? createNativeFaceDetectionProvider();
    if (!provider) {
      console.log(
        "[FaceDebug] detectFaces: No face detection provider available",
      );
      return [];
    }

    console.log("[FaceDebug] detectFaces: Starting detection...");
    const results = await provider(canvas, { maxFaces: config.maxFaces });
    console.log(
      "[FaceDebug] detectFaces: Detection complete, found",
      results.length,
      "faces",
    );
    return results
      .map(r => ({
        kind: "face" as const,
        box: {
          x: r.boundingBox.x * scaleX,
          y: r.boundingBox.y * scaleY,
          width: r.boundingBox.width * scaleX,
          height: r.boundingBox.height * scaleY,
        },
        score: typeof r.score === "number" ? r.score : 1,
      }))
      .filter(
        f =>
          isFinite(f.box.x) &&
          isFinite(f.box.y) &&
          f.box.width > 0 &&
          f.box.height > 0,
      );
  } catch (err) {
    console.error("[FaceDebug] detectFaces: Error during detection", err);
    return [];
  }
}

function createNativeFaceDetectionProvider(): FaceDetectionProvider | null {
  type NativeFaceDetectorResult = {
    boundingBox: DOMRectReadOnly;
    score?: number;
  };
  type NativeFaceDetector = {
    detect: (image: CanvasImageSource) => Promise<NativeFaceDetectorResult[]>;
  };
  type NativeFaceDetectorConstructor = new (options: {
    fastMode?: boolean;
    maxDetectedFaces?: number;
  }) => NativeFaceDetector;

  const FaceDetectorCtor = (
    globalThis as unknown as { FaceDetector?: NativeFaceDetectorConstructor }
  ).FaceDetector;
  if (!FaceDetectorCtor) {
    console.log(
      "[FaceDebug] createNativeFaceDetectionProvider: FaceDetector API not available in this browser",
    );
    return null;
  }

  console.log(
    "[FaceDebug] createNativeFaceDetectionProvider: FaceDetector API available",
  );
  return async (canvas, options) => {
    const detector = new FaceDetectorCtor({
      fastMode: true,
      maxDetectedFaces: options.maxFaces,
    });

    // Native API 返回的是 FaceDetection 对象数组，至少包含 boundingBox
    const results = await detector.detect(canvas);
    return results.map(r => ({
      boundingBox: {
        x: r.boundingBox.x,
        y: r.boundingBox.y,
        width: r.boundingBox.width,
        height: r.boundingBox.height,
      },
      score: r.score,
    }));
  };
}

/**
 * “对象显著性”检测（快速兜底）：
 * - 非语义识别，但能把裁剪中心从“纯居中”拉向“细节/边缘密度更高的区域”
 * - 对于无明显主体的照片会自动退化为空
 */
function detectSaliencyObject(source: CanvasImageSource): SmartDetection[] {
  const prepared = toCanvasForDetection(source, 256);
  if (!prepared) return [];

  const { canvas, scaleX, scaleY } = prepared;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const w = canvas.width;
  const h = canvas.height;
  if (w < 8 || h < 8) return [];

  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    return [];
  }

  const grid = 16;
  const gw = grid;
  const gh = grid;
  const cellW = w / gw;
  const cellH = h / gh;

  const energy = new Float32Array(gw * gh);
  const idx = (x: number, y: number) => (y * w + x) * 4;

  // 计算简易梯度能量：|dx| + |dy|
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = idx(x, y);
      const r = data.data[i];
      const g = data.data[i + 1];
      const b = data.data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      const i2 = idx(x + 1, y);
      const r2 = data.data[i2];
      const g2 = data.data[i2 + 1];
      const b2 = data.data[i2 + 2];
      const lum2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;

      const i3 = idx(x, y + 1);
      const r3 = data.data[i3];
      const g3 = data.data[i3 + 1];
      const b3 = data.data[i3 + 2];
      const lum3 = 0.2126 * r3 + 0.7152 * g3 + 0.0722 * b3;

      const e = Math.abs(lum2 - lum) + Math.abs(lum3 - lum);

      const cx = Math.min(gw - 1, Math.floor(x / cellW));
      const cy = Math.min(gh - 1, Math.floor(y / cellH));
      energy[cy * gw + cx] += e;
    }
  }

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < energy.length; i++) {
    const v = energy[i];
    sum += v;
    sumSq += v * v;
  }
  if (sum <= 0) return [];

  const mean = sum / energy.length;
  const variance = Math.max(0, sumSq / energy.length - mean * mean);
  // 方差太小：画面能量分布过于均匀，认为没有明显主体
  if (variance < mean * mean * 0.08) return [];

  // 选取能量 Top 18% 的格子作为“显著区域”
  const values = Array.from(energy);
  values.sort((a, b) => b - a);
  const k = Math.max(1, Math.floor(values.length * 0.18));
  const threshold = values[k - 1] ?? values[values.length - 1];

  let minX = gw;
  let minY = gh;
  let maxX = -1;
  let maxY = -1;

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (energy[gy * gw + gx] < threshold) continue;
      minX = Math.min(minX, gx);
      minY = Math.min(minY, gy);
      maxX = Math.max(maxX, gx);
      maxY = Math.max(maxY, gy);
    }
  }

  if (maxX < minX || maxY < minY) return [];

  // 稍微扩张一圈，避免贴边截断
  minX = Math.max(0, minX - 1);
  minY = Math.max(0, minY - 1);
  maxX = Math.min(gw - 1, maxX + 1);
  maxY = Math.min(gh - 1, maxY + 1);

  const x = minX * cellW * scaleX;
  const y = minY * cellH * scaleY;
  const width = ((maxX + 1) * cellW - minX * cellW) * scaleX;
  const height = ((maxY + 1) * cellH - minY * cellH) * scaleY;

  if (!isFinite(x) || !isFinite(y) || width <= 0 || height <= 0) return [];

  // 若显著区域几乎覆盖全图，则不视为“对象”
  const fullArea = w * scaleX * (h * scaleY);
  const area = width * height;
  if (area / Math.max(1, fullArea) > 0.92) return [];

  // 归一化 score：越集中/越显著越高（简单使用方差/均值比）
  const score = clamp(
    (Math.sqrt(variance) / Math.max(1e-6, mean)) * 0.35,
    0.1,
    1,
  );

  return [
    { kind: "object", box: { x, y, width, height }, score, label: "saliency" },
  ];
}

function intersect(a: CropRect, b: CropRect): CropRect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return null;
  return { x: x1, y: y1, width: w, height: h };
}

function clampCropToBounds(crop: CropRect, bounds: CropRect): CropRect {
  const width = Math.min(crop.width, bounds.width);
  const height = Math.min(crop.height, bounds.height);
  const x = clamp(crop.x, bounds.x, bounds.x + bounds.width - width);
  const y = clamp(crop.y, bounds.y, bounds.y + bounds.height - height);
  return { x, y, width, height };
}

function fitAspectInside(base: CropRect, targetAspect: number): CropRect {
  if (!isFinite(targetAspect) || targetAspect <= 0) return { ...base };
  const ar = base.width / Math.max(1e-6, base.height);
  let width = base.width;
  let height = base.height;
  if (ar > targetAspect) {
    width = height * targetAspect;
  } else {
    height = width / targetAspect;
  }
  const x = base.x + (base.width - width) / 2;
  const y = base.y + (base.height - height) / 2;
  return { x, y, width, height };
}

function bboxOf(boxes: CropRect[]): CropRect | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { x: minX, y: minY, width, height };
}

function centerOfRect(rect: CropRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function expandBox(box: CropRect, margin: number): CropRect {
  if (!isFinite(margin) || margin <= 0) return { ...box };
  const pad = margin * Math.min(box.width, box.height);
  if (!isFinite(pad) || pad <= 0) return { ...box };
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function pickImportantSubset(
  detections: SmartDetection[],
  base: CropRect,
  imageArea: number,
): CropRect | null {
  const inBase = detections
    .map(d => ({ ...d, box: intersect(expandBox(d.box, 0.12), base) }))
    .filter((d): d is SmartDetection & { box: CropRect } => !!d.box);

  if (inBase.length === 0) return null;

  // 只在少量候选上做组合搜索，避免性能问题
  const candidates = [...inBase]
    .map(d => {
      const area = d.box.width * d.box.height;
      const ratio = Math.min(1, area / Math.max(1, imageArea));
      const kindMultiplier = d.kind === "face" ? 10 : 3;
      const weight =
        kindMultiplier * clamp(d.score, 0, 1) * Math.sqrt(Math.max(0, ratio));
      return { d, weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  if (candidates.length === 0) return null;

  const baseArea = Math.max(1, base.width * base.height);
  const subsets: Array<
    Array<{ d: SmartDetection & { box: CropRect }; weight: number }>
  > = [];
  // 单个
  for (const c of candidates) subsets.push([c]);
  // 两两组合
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      subsets.push([candidates[i], candidates[j]]);
    }
  }

  let best: { score: number; bbox: CropRect } | null = null;
  for (const subset of subsets) {
    const boxes = subset.map(s => s.d.box);
    const bb = bboxOf(boxes);
    if (!bb) continue;
    const weightSum = subset.reduce((s, x) => s + x.weight, 0);
    const areaPenalty = (bb.width * bb.height) / baseArea;
    // 更偏向包含更高权重，同时惩罚过大的 bbox
    const score = weightSum - 0.65 * weightSum * areaPenalty;
    if (!best || score > best.score) best = { score, bbox: bb };
  }

  return best?.bbox ?? null;
}

function cropContains(
  outer: CropRect,
  inner: CropRect,
  tolerance: number = 1e-3,
): boolean {
  return (
    outer.x <= inner.x + tolerance &&
    outer.y <= inner.y + tolerance &&
    outer.x + outer.width >= inner.x + inner.width - tolerance &&
    outer.y + outer.height >= inner.y + inner.height - tolerance
  );
}

function placeCropToContain(
  bounds: CropRect,
  required: CropRect,
  width: number,
  height: number,
  anchor: { x: number; y: number },
): CropRect {
  const safeWidth = Math.min(Math.max(1, width), bounds.width);
  const safeHeight = Math.min(Math.max(1, height), bounds.height);

  const xMin = bounds.x;
  const yMin = bounds.y;
  const xMax = bounds.x + bounds.width - safeWidth;
  const yMax = bounds.y + bounds.height - safeHeight;

  const includeMinX = required.x + required.width - safeWidth;
  const includeMaxX = required.x;
  const loX = Math.max(xMin, includeMinX);
  const hiX = Math.min(xMax, includeMaxX);
  const x =
    loX <= hiX
      ? clamp(anchor.x - safeWidth / 2, loX, hiX)
      : clamp(required.x + required.width / 2 - safeWidth / 2, xMin, xMax);

  const includeMinY = required.y + required.height - safeHeight;
  const includeMaxY = required.y;
  const loY = Math.max(yMin, includeMinY);
  const hiY = Math.min(yMax, includeMaxY);
  const y =
    loY <= hiY
      ? clamp(anchor.y - safeHeight / 2, loY, hiY)
      : clamp(required.y + required.height / 2 - safeHeight / 2, yMin, yMax);

  return { x, y, width: safeWidth, height: safeHeight };
}

function ensureFaceVisibilityCrop(
  base: CropRect,
  initialCrop: CropRect,
  detections: SmartDetection[],
): CropRect {
  const faceDetections = detections.filter(d => d.kind === "face");
  if (faceDetections.length === 0) return initialCrop;

  const MIN_FACE_VISIBLE = 100;
  const faceRequiredBoxes = faceDetections
    .map(fd => {
      const padded = expandBox(fd.box, 0.12);
      const center = centerOfRect(padded);
      const requiredWidth = Math.max(MIN_FACE_VISIBLE, padded.width);
      const requiredHeight = Math.max(MIN_FACE_VISIBLE, padded.height);
      return clampCropToBounds(
        {
          x: center.x - requiredWidth / 2,
          y: center.y - requiredHeight / 2,
          width: requiredWidth,
          height: requiredHeight,
        },
        base,
      );
    })
    .filter(box => box.width > 0 && box.height > 0);

  const required = bboxOf(faceRequiredBoxes);
  if (!required) return initialCrop;

  const aspect = initialCrop.width / Math.max(1e-6, initialCrop.height);
  const maxAspectCrop = fitAspectInside(base, aspect);
  const makeAspectSizeContaining = (
    minWidth: number,
    minHeight: number,
  ): { width: number; height: number } => {
    let width = Math.max(minWidth, minHeight * aspect);
    let height = width / aspect;
    if (height < minHeight) {
      height = minHeight;
      width = height * aspect;
    }
    return { width, height };
  };

  const anchor = centerOfRect(initialCrop);
  let candidate = placeCropToContain(
    base,
    required,
    initialCrop.width,
    initialCrop.height,
    anchor,
  );
  if (cropContains(candidate, required)) return candidate;

  const minAspectContainingRequired = makeAspectSizeContaining(
    required.width,
    required.height,
  );
  const needFactor = Math.max(
    minAspectContainingRequired.width / Math.max(1, initialCrop.width),
    minAspectContainingRequired.height / Math.max(1, initialCrop.height),
    1,
  );
  const maxFactor = Math.min(
    maxAspectCrop.width / Math.max(1, initialCrop.width),
    maxAspectCrop.height / Math.max(1, initialCrop.height),
  );
  if (isFinite(maxFactor) && maxFactor >= 1) {
    const factor = Math.min(Math.max(1, needFactor), maxFactor);
    candidate = placeCropToContain(
      base,
      required,
      initialCrop.width * factor,
      initialCrop.height * factor,
      anchor,
    );
    if (cropContains(candidate, required)) return candidate;
  }

  // 比例约束无法满足时，仍保持比例不变，并尽可能放大到能覆盖最多人脸区域。
  const finalAspectSize = makeAspectSizeContaining(
    required.width,
    required.height,
  );
  candidate = placeCropToContain(
    base,
    required,
    Math.min(
      maxAspectCrop.width,
      Math.max(initialCrop.width, finalAspectSize.width),
    ),
    Math.min(
      maxAspectCrop.height,
      Math.max(initialCrop.height, finalAspectSize.height),
    ),
    anchor,
  );

  return clampCropToBounds(candidate, base);
}

/**
 * 基于检测框计算智能裁剪区域：
 * - 结果一定在 baseCrop 内
 * - 严格满足 targetAspect
 * - 尽量把“重要区域”完整包含（做不到时尽量靠近并居中对齐）
 */
export function calculateSmartCrop(
  image:
    | { width: number; height: number }
    | HTMLImageElement
    | HTMLCanvasElement,
  targetAspect: number,
  detections: SmartDetection[],
  baseCrop?: CropRect,
): CropRect {
  const size = resolveSizeFromImageLike(image);

  const imageWidth = Math.max(1, size.width);
  const imageHeight = Math.max(1, size.height);
  const imageArea = imageWidth * imageHeight;

  const full: CropRect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
  const base = baseCrop ? clampCropToBounds(baseCrop, full) : full;

  if (!isFinite(targetAspect) || targetAspect <= 0) return { ...base };

  // 按原图比例策略收敛目标比例：
  // - 极端竖图：收敛到 [4:6, 1]
  // - 极端横图：收敛到 [1, 6:4]
  // - 非极端：保持原图比例
  const clampedAspect = clampSmartCropTargetAspect(
    targetAspect,
    imageWidth,
    imageHeight,
  );

  const maxFit = fitAspectInside(base, clampedAspect);
  const cropW = maxFit.width;
  const cropH = maxFit.height;

  if (!detections || detections.length === 0)
    return clampCropToBounds(maxFit, base);

  // 优化：竖向人像（原图高 > 宽）被裁剪为横向比例（targetAspect > 1）时，
  // 常见问题是裁剪高度受“原图宽度/目标比例”限制，导致人脸上下被截断。
  // 处理策略：
  // 1) 仅用人脸检测框计算焦点，避免被其它“显著性对象”拉偏
  // 2) 对人脸焦点增加更强的纵向 padding（且略偏向“上方”保护头部）
  // 3) 若 padding 导致无法完整包含，则自动把 padding 压缩到“刚好能放下”为止，优先保证不切脸
  const hasFaces = detections.some(d => d.kind === "face");
  const portraitToLandscape =
    imageHeight > imageWidth && targetAspect > 1 && hasFaces;

  const focusCandidates = portraitToLandscape
    ? detections.filter(d => d.kind === "face")
    : detections;
  const focus = pickImportantSubset(focusCandidates, base, imageArea);
  if (!focus) return clampCropToBounds(maxFit, base);

  // 给 focus 增加 padding，避免贴边切脸/切主体（同时确保不会因 padding 过大而“必然切脸”）
  const basePad = 0.12 * Math.min(base.width, base.height);
  const focusPad = 0.18 * Math.min(focus.width, focus.height);
  const pad = basePad + focusPad;

  // 竖向人像 → 横向裁剪：更偏向纵向留白（尤其是上方）
  let padX = pad;
  let padY = pad;
  let topBias = 0.5;
  if (portraitToLandscape) {
    padX *= 1.15;
    padY *= 1.65;
    topBias = 0.65;
    // 若 focus 尺寸已接近/超过裁剪框，则把 padding 压缩到可以完整包含为止（优先保证不切脸）
    const maxPadX = Math.max(0, cropW - focus.width);
    const maxPadY = Math.max(0, cropH - focus.height);
    padX = Math.min(padX, maxPadX);
    padY = Math.min(padY, maxPadY);
  }

  const topPadY = padY * topBias;
  const bottomPadY = padY - topPadY;
  const focusPadded: CropRect = {
    x: focus.x - padX / 2,
    y: focus.y - topPadY,
    width: focus.width + padX,
    height: focus.height + topPadY + bottomPadY,
  };

  const baseXMin = base.x;
  const baseYMin = base.y;
  const baseXMax = base.x + base.width - cropW;
  const baseYMax = base.y + base.height - cropH;

  // 默认保持“最大裁剪”居中（不做不必要的缩小）
  let x = maxFit.x;
  let y = maxFit.y;
  const focusCenter = centerOfRect(focusPadded);

  // 尽量把 focus 完整放进裁剪框：可行时通过移动 x/y 实现；不可行时退化为以中心对齐
  if (focusPadded.width <= cropW) {
    const includeMinX = focusPadded.x + focusPadded.width - cropW;
    const includeMaxX = focusPadded.x;
    const lo = Math.max(baseXMin, includeMinX);
    const hi = Math.min(baseXMax, includeMaxX);
    if (lo <= hi) x = clamp(x, lo, hi);
    else x = clamp(focusCenter.x - cropW / 2, baseXMin, baseXMax);
  } else {
    x = clamp(focusCenter.x - cropW / 2, baseXMin, baseXMax);
  }

  if (focusPadded.height <= cropH) {
    const includeMinY = focusPadded.y + focusPadded.height - cropH;
    const includeMaxY = focusPadded.y;
    const lo = Math.max(baseYMin, includeMinY);
    const hi = Math.min(baseYMax, includeMaxY);
    if (lo <= hi) y = clamp(y, lo, hi);
    else y = clamp(focusCenter.y - cropH / 2, baseYMin, baseYMax);
  } else {
    y = clamp(focusCenter.y - cropH / 2, baseYMin, baseYMax);
  }

  const refinedCrop = refineCropPosition(
    { x, y, width: cropW, height: cropH },
    base,
    detections,
    imageArea,
    { searchRadius: 80, step: 20, lambda: 0.6 },
  );
  if (!hasFaces) return refinedCrop;
  return ensureFaceVisibilityCrop(base, refinedCrop, detections);
}

function resolveSizeFromImageLike(
  image:
    | { width: number; height: number }
    | HTMLImageElement
    | HTMLCanvasElement,
): Size {
  if (
    typeof HTMLImageElement !== "undefined" &&
    image instanceof HTMLImageElement
  ) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    image instanceof HTMLCanvasElement
  ) {
    return {
      width: Math.max(1, image.width),
      height: Math.max(1, image.height),
    };
  }
  return { width: Math.max(1, image.width), height: Math.max(1, image.height) };
}

function rectArea(r: CropRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function intersectArea(a: CropRect, b: CropRect): number {
  const r = intersect(a, b);
  return r ? rectArea(r) : 0;
}

function refineCropPosition(
  initial: CropRect,
  base: CropRect,
  detections: SmartDetection[],
  imageArea: number,
  opts: { searchRadius: number; step: number; lambda: number },
): CropRect {
  if (!detections || detections.length === 0)
    return clampCropToBounds(initial, base);
  if (!isFinite(opts.searchRadius) || opts.searchRadius <= 0)
    return clampCropToBounds(initial, base);
  if (!isFinite(opts.step) || opts.step <= 0)
    return clampCropToBounds(initial, base);

  type WeightedBox = { box: CropRect; weight: number };
  const weighted: WeightedBox[] = [];

  for (const d of detections) {
    const safe = expandBox(d.box, 0.12);
    const safeInBase = intersect(safe, base);
    if (!safeInBase) continue;

    const area = rectArea(safeInBase);
    const ratio = Math.min(1, area / Math.max(1, imageArea));
    const kindMultiplier = d.kind === "face" ? 10 : 3;
    const weight =
      kindMultiplier * clamp(d.score, 0, 1) * Math.sqrt(Math.max(0, ratio));
    if (!isFinite(weight) || weight <= 0) continue;

    weighted.push({ box: safeInBase, weight });
  }

  if (weighted.length === 0) return clampCropToBounds(initial, base);

  const baseXMin = base.x;
  const baseYMin = base.y;
  const baseXMax = base.x + base.width - initial.width;
  const baseYMax = base.y + base.height - initial.height;

  const clampX = (x: number) => clamp(x, baseXMin, baseXMax);
  const clampY = (y: number) => clamp(y, baseYMin, baseYMax);

  const searchRadius = Math.round(opts.searchRadius);
  const step = Math.max(1, Math.round(opts.step));
  const lambda = clamp(opts.lambda, 0, 2);

  const evalScore = (crop: CropRect): number => {
    let covSum = 0;
    let borderPenalty = 0;

    const win = crop;
    const norm = Math.max(1, Math.min(win.width, win.height) * 0.15);

    for (const it of weighted) {
      const box = it.box;
      const w = it.weight;
      const boxArea = rectArea(box);
      if (boxArea <= 0) continue;

      const coverage = intersectArea(win, box) / boxArea;
      covSum += w * coverage;

      const left = box.x - win.x;
      const right = win.x + win.width - (box.x + box.width);
      const top = box.y - win.y;
      const bottom = win.y + win.height - (box.y + box.height);
      const minMargin = Math.min(left, right, top, bottom);
      const p = clamp(1 - minMargin / norm, 0, 1);
      borderPenalty += w * p;
    }

    return covSum - lambda * borderPenalty;
  };

  let best = clampCropToBounds(initial, base);
  let bestScore = evalScore(best);

  for (let dy = -searchRadius; dy <= searchRadius; dy += step) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += step) {
      if (dx === 0 && dy === 0) continue;
      const cand: CropRect = {
        x: clampX(initial.x + dx),
        y: clampY(initial.y + dy),
        width: initial.width,
        height: initial.height,
      };
      const s = evalScore(cand);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
  }

  return best;
}
