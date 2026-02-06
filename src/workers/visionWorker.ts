/// <reference lib="webworker" />

import type { KeepRegion } from "@/types/vision";

type VisionAssets = {
  wasmBaseUrl: string;
  tasksVisionUrl: string;
  faceModelUrl: string;
  objectModelUrl: string;
};

type InitRequest = {
  id: number;
  type: "init";
  assets: VisionAssets;
  options?: {
    face?: { scoreThreshold?: number; maxFaces?: number };
    object?: { scoreThreshold?: number; maxResults?: number };
  };
};

type ProcessFileRequest = {
  id: number;
  type: "processFile";
  photoId: string;
  file: File;
  previewMaxEdge: number;
  detectShortSide: number;
  enableObject: boolean;
};

type ProcessFileOk = {
  id: number;
  ok: true;
  result: {
    photoId: string;
    sourceWidth: number;
    sourceHeight: number;
    previewWidth: number;
    previewHeight: number;
    previewBitmap: ImageBitmap;
    detections: KeepRegion[];
  };
};

type ProcessFileErr = { id: number; ok: false; error: string };

type InitedOk = { id: number; ok: true; type: "inited" };

type Request = InitRequest | ProcessFileRequest;

let inited = false;
let initError: Error | null = null;

let faceDetector: any = null;
let objectDetector: any = null;

async function importEsmFromUrlViaBlob(url: string): Promise<any> {
  const absUrl = new URL(url, self.location.href).toString();
  const res = await fetch(absUrl);
  if (!res.ok) {
    throw new Error(
      `加载 Tasks Vision bundle 失败：${res.status} ${res.statusText}`,
    );
  }

  const code = await res.text();
  const blobUrl = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // ignore
    }
  }
}

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

function ensureAbsBaseUrl(url: string): string {
  // FilesetResolver.forVisionTasks 需要的是可 fetch 的 baseUrl（支持相对路径）。
  return url.replace(/\/+$/, "");
}

async function decodeFileToBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("当前浏览器不支持 createImageBitmap，无法在 Worker 中解码");
  }
  try {
    return await createImageBitmap(file, {
      imageOrientation: "from-image",
    } as any);
  } catch {
    return await createImageBitmap(file);
  }
}

function resizeDimsByMaxEdge(
  w: number,
  h: number,
  maxEdge: number,
): { w: number; h: number } {
  const edge = Math.max(w, h);
  if (!isFinite(maxEdge) || maxEdge <= 0 || edge <= maxEdge) return { w, h };
  const ratio = maxEdge / edge;
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
  };
}

function resizeDimsByShortSide(
  w: number,
  h: number,
  shortSide: number,
): { w: number; h: number } {
  const s = Math.min(w, h);
  if (!isFinite(shortSide) || shortSide <= 0 || s <= shortSide) return { w, h };
  const ratio = shortSide / s;
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
  };
}

async function resizeBitmap(
  src: ImageBitmap,
  w: number,
  h: number,
): Promise<ImageBitmap> {
  if (src.width === w && src.height === h) return src;

  // 优先 OffscreenCanvas：性能更稳定
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (ctx) {
      ctx.drawImage(src, 0, 0, w, h);
      return canvas.transferToImageBitmap();
    }
  }

  // fallback：使用 createImageBitmap 的 resize 选项
  try {
    return await createImageBitmap(src, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: "high",
    } as any);
  } catch {
    // 最后兜底：不缩放（可能导致检测慢/内存大）
    return src;
  }
}

function normalizeDetections(res: any): any[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.detections)) return res.detections;
  if (Array.isArray(res.results)) return res.results;
  return [];
}

function readBoundingBox(
  det: any,
): { x: number; y: number; w: number; h: number } | null {
  const bb =
    det?.boundingBox ??
    det?.locationData?.boundingBox ??
    det?.locationData?.relativeBoundingBox;
  if (!bb) return null;
  const x = bb.originX ?? bb.x ?? bb.xMin ?? bb.left ?? 0;
  const y = bb.originY ?? bb.y ?? bb.yMin ?? bb.top ?? 0;
  const w =
    bb.width ?? (bb.right != null && bb.left != null ? bb.right - bb.left : 0);
  const h =
    bb.height ?? (bb.bottom != null && bb.top != null ? bb.bottom - bb.top : 0);
  if (
    !isFinite(x) ||
    !isFinite(y) ||
    !isFinite(w) ||
    !isFinite(h) ||
    w <= 0 ||
    h <= 0
  )
    return null;
  return { x, y, w, h };
}

function readCategory(det: any): { label?: string; score: number } {
  const cat = det?.categories?.[0] ?? det?.classes?.[0] ?? null;
  const score =
    typeof cat?.score === "number"
      ? cat.score
      : typeof det?.score === "number"
        ? det.score
        : 1;
  const label =
    typeof cat?.categoryName === "string"
      ? cat.categoryName
      : typeof cat?.displayName === "string"
        ? cat.displayName
        : undefined;
  return { label, score: isFinite(score) ? score : 1 };
}

async function initMediapipe(req: InitRequest): Promise<void> {
  if (inited) return;
  if (initError) throw initError;

  try {
    // Vite 禁止从 /public 目录用 import() 直接加载模块（会触发 dev server 的 transform 报错）。
    // 这里改为：fetch 代码 -> blob: URL -> import(blob)，让浏览器运行时加载。
    const mod = await importEsmFromUrlViaBlob(req.assets.tasksVisionUrl);
    const FilesetResolver = (mod as any).FilesetResolver;
    const FaceDetector = (mod as any).FaceDetector;
    const ObjectDetector = (mod as any).ObjectDetector;
    if (!FilesetResolver || !FaceDetector || !ObjectDetector) {
      throw new Error(
        "未找到 Tasks Vision 导出（请检查 /public/mediapipe/tasks-vision.js 是否存在且可加载）",
      );
    }

    const baseUrl = ensureAbsBaseUrl(req.assets.wasmBaseUrl);
    const vision = await FilesetResolver.forVisionTasks(baseUrl);

    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: req.assets.faceModelUrl },
      runningMode: "IMAGE",
      minDetectionConfidence: req.options?.face?.scoreThreshold ?? 0.25,
      numFaces: req.options?.face?.maxFaces ?? 5,
    });

    objectDetector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: req.assets.objectModelUrl },
      runningMode: "IMAGE",
      scoreThreshold: req.options?.object?.scoreThreshold ?? 0.25,
      maxResults: req.options?.object?.maxResults ?? 6,
    });

    inited = true;
  } catch (e) {
    initError = e instanceof Error ? e : new Error(String(e));
    throw initError;
  }
}

async function runDetections(params: {
  bitmap: ImageBitmap;
  kind: "face" | "object";
  enableObject: boolean;
}): Promise<KeepRegion[]> {
  if (params.kind === "object" && !params.enableObject) return [];
  const det = params.kind === "face" ? faceDetector : objectDetector;
  if (!det) return [];

  let res: any;
  try {
    res = det.detect(params.bitmap as any);
  } catch (e) {
    // 某些版本 API 可能是异步
    try {
      res = await det.detect(params.bitmap as any);
    } catch {
      return [];
    }
  }

  const arr = normalizeDetections(res);
  const out: KeepRegion[] = [];
  for (const d of arr) {
    const bb = readBoundingBox(d);
    if (!bb) continue;
    const cat = readCategory(d);
    out.push({
      kind: params.kind,
      label: cat.label,
      score: clamp(cat.score, 0, 1),
      box: { x: bb.x, y: bb.y, width: bb.w, height: bb.h },
    });
  }
  return out;
}

function mapDetectionsToPreview(
  dets: KeepRegion[],
  scaleX: number,
  scaleY: number,
  previewW: number,
  previewH: number,
): KeepRegion[] {
  const out: KeepRegion[] = [];
  for (const d of dets) {
    const x = d.box.x * scaleX;
    const y = d.box.y * scaleY;
    const w = d.box.width * scaleX;
    const h = d.box.height * scaleY;
    if (
      !isFinite(x) ||
      !isFinite(y) ||
      !isFinite(w) ||
      !isFinite(h) ||
      w <= 0 ||
      h <= 0
    )
      continue;
    const clampedX = clamp(x, 0, Math.max(0, previewW - 1));
    const clampedY = clamp(y, 0, Math.max(0, previewH - 1));
    const clampedW = clamp(w, 1, Math.max(1, previewW - clampedX));
    const clampedH = clamp(h, 1, Math.max(1, previewH - clampedY));
    out.push({
      ...d,
      box: { x: clampedX, y: clampedY, width: clampedW, height: clampedH },
    });
  }
  return out;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "init") {
    try {
      await initMediapipe(msg);
      const res: InitedOk = { id: msg.id, ok: true, type: "inited" };
      self.postMessage(res);
    } catch (err) {
      const res: ProcessFileErr = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(res);
    }
    return;
  }

  if (msg.type === "processFile") {
    if (!inited) {
      const res: ProcessFileErr = {
        id: msg.id,
        ok: false,
        error: "Vision worker 未初始化",
      };
      self.postMessage(res);
      return;
    }

    let source: ImageBitmap | null = null;
    let preview: ImageBitmap | null = null;
    let detect: ImageBitmap | null = null;

    try {
      source = await decodeFileToBitmap(msg.file);
      const sourceWidth = source.width;
      const sourceHeight = source.height;

      const previewDims = resizeDimsByMaxEdge(
        sourceWidth,
        sourceHeight,
        msg.previewMaxEdge,
      );
      preview = await resizeBitmap(source, previewDims.w, previewDims.h);

      const detectDims = resizeDimsByShortSide(
        preview.width,
        preview.height,
        msg.detectShortSide,
      );
      detect = await resizeBitmap(preview, detectDims.w, detectDims.h);

      const faces = await runDetections({
        bitmap: detect,
        kind: "face",
        enableObject: msg.enableObject,
      });
      const objects = await runDetections({
        bitmap: detect,
        kind: "object",
        enableObject: msg.enableObject,
      });

      const scaleX = preview.width / Math.max(1, detect.width);
      const scaleY = preview.height / Math.max(1, detect.height);
      const mapped = [
        ...mapDetectionsToPreview(
          faces,
          scaleX,
          scaleY,
          preview.width,
          preview.height,
        ),
        ...mapDetectionsToPreview(
          objects,
          scaleX,
          scaleY,
          preview.width,
          preview.height,
        ),
      ];

      const res: ProcessFileOk = {
        id: msg.id,
        ok: true,
        result: {
          photoId: msg.photoId,
          sourceWidth,
          sourceHeight,
          previewWidth: preview.width,
          previewHeight: preview.height,
          previewBitmap: preview,
          detections: mapped,
        },
      };

      // transfer preview bitmap to main thread
      self.postMessage(res, [preview]);
      preview = null;
    } catch (err) {
      const res: ProcessFileErr = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(res);
    } finally {
      try {
        detect?.close();
      } catch {
        // ignore
      }
      try {
        source?.close();
      } catch {
        // ignore
      }
      try {
        preview?.close();
      } catch {
        // ignore
      }
    }
  }
};
