import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  PhotoEntity,
  CanvasPreset,
  ExportFormat,
  ExportResolutionPreset,
  CropRect,
  AppMode,
  Placement,
  PhotoAdjustments,
} from "@/types";
import { fillArrangePhotos } from "@/composables/useLayout";
import { clampPhotoToCanvas, clampCrop, clamp, generateId } from "@/utils/math";
import {
  centerCropToAspect,
  createPhotoFromFile,
  isHeicFile,
} from "@/utils/image";
import { createAssetId, putAsset } from "@/project/assets";
import type { ProjectAssetMeta } from "@/project/schema";
import {
  getSmartDetections,
  invalidateSmartDetections,
  onSmartDetectionsChanged,
  prefetchSmartDetections,
  seedSmartDetections,
} from "@/utils/smartCrop";
import { getVisionClient } from "@/vision/visionClient";

type LayoutWorkerFillArrangeOptions = {
  seed?: number;
  splitRatioMin?: number;
  splitRatioMax?: number;
};

type LayoutWorkerFillArrangePhotoInput = {
  id: string;
  crop: CropRect;
  imageWidth: number;
  imageHeight: number;
  detections?: ReturnType<typeof getSmartDetections>;
};

type LayoutWorkerFillArrangeRequest = {
  id: number;
  type: "fillArrange";
  photos: LayoutWorkerFillArrangePhotoInput[];
  canvasW: number;
  canvasH: number;
  options?: LayoutWorkerFillArrangeOptions;
};

type LayoutWorkerFillArrangeResponse =
  | { id: number; ok: true; placements: Placement[] }
  | { id: number; ok: false; error: string };

const PRESETS: CanvasPreset[] = [
  { id: "40x50", label: "40cm × 50cm", width: 4724, height: 5906 },
  { id: "40x60", label: "40cm × 60cm", width: 4724, height: 7087 },
  { id: "50x70", label: "50cm × 70cm", width: 5906, height: 8268 },
  { id: "60x80", label: "60cm × 80cm", width: 7087, height: 9449 },
  { id: "60x90", label: "60cm × 90cm", width: 7087, height: 10630 },
  { id: "50x40", label: "50cm × 40cm", width: 5906, height: 4724 },
  { id: "60x40", label: "60cm × 40cm", width: 7087, height: 4724 },
  { id: "70x50", label: "70cm × 50cm", width: 8268, height: 5906 },
  { id: "80x60", label: "80cm × 60cm", width: 9449, height: 7087 },
  { id: "90x60", label: "90cm × 60cm", width: 10630, height: 7087 },
  { id: "100x70", label: "100cm × 70cm", width: 11811, height: 8268 },
  { id: "100x80", label: "100cm × 80cm", width: 11811, height: 9449 },
  { id: "custom", label: "自定义尺寸", width: 4000, height: 4000 },
];

const MAX_IMPORT_PHOTO_COUNT = 150;
type ImportPhotosResult = { added: number; failed: number; truncated: number };

export const useMosaicStore = defineStore("mosaic", () => {
  type PhotoCoreSnapshot = {
    id: string;
    cx: number;
    cy: number;
    scale: number;
    rotation: number;
    zIndex: number;
    crop: CropRect;
    layoutCrop?: CropRect;
    adjustments: PhotoAdjustments;
  };

  type PhotoFullSnapshot = PhotoCoreSnapshot & {
    name: string;
    srcUrl: string;
    assetId?: string;
    image: CanvasImageSource;
    sourceWidth?: number;
    sourceHeight?: number;
    imageWidth: number;
    imageHeight: number;
  };

  type CanvasSnapshot = PhotoCoreSnapshot[];

  type HistoryEntry =
    | {
        id: string;
        at: number;
        label: string;
        kind: "photo";
        photoId: string;
        before: PhotoCoreSnapshot;
        after: PhotoCoreSnapshot;
      }
    | {
        id: string;
        at: number;
        label: string;
        kind: "photoFull";
        photoId: string;
        before: PhotoFullSnapshot;
        after: PhotoFullSnapshot;
      }
    | {
        id: string;
        at: number;
        label: string;
        kind: "canvas";
        before: CanvasSnapshot;
        after: CanvasSnapshot;
      }
    | {
        id: string;
        at: number;
        label: string;
        kind: "removePhoto";
        photoId: string;
        index: number;
        photo: PhotoFullSnapshot;
        selectedBefore: string | null;
        cropModeBefore: string | null;
      }
    | {
        id: string;
        at: number;
        label: string;
        kind: "clearAll";
        photos: Array<{ index: number; photo: PhotoFullSnapshot }>;
        selectedBefore: string | null;
        cropModeBefore: string | null;
      };

  const HISTORY_LIMIT = 80;
  const DEFAULT_ADJUSTMENTS: PhotoAdjustments = {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    preset: "none",
  };

  // State
  const presets = ref<CanvasPreset[]>(PRESETS);
  const currentPresetId = ref<string>("40x50");
  const canvasWidth = ref<number>(PRESETS[0].width);
  const canvasHeight = ref<number>(PRESETS[0].height);
  const canvasOffsetX = ref<number>(0);
  const canvasOffsetY = ref<number>(0);
  const photos = ref<PhotoEntity[]>([]);
  const selectedPhotoId = ref<string | null>(null);
  const cropModePhotoId = ref<string | null>(null);
  const exportFormat = ref<ExportFormat>("png");
  const exportQuality = ref<number>(0.95);
  const exportResolution = ref<ExportResolutionPreset>("original");
  const isExporting = ref<boolean>(false);
  const mode = ref<AppMode>({ kind: "idle" });

  // 智能裁剪检测结果到达后，尽可能只更新 layoutCrop（不改变位置/缩放），避免“跳动”
  onSmartDetectionsChanged(photoId => {
    if (mode.value.kind !== "idle") return;
    const photo = photos.value.find(p => p.id === photoId);
    if (!photo?.layoutCrop) return;
    const ta = photo.layoutCrop.width / Math.max(1, photo.layoutCrop.height);
    const next = centerCropToAspect(
      photo.crop,
      ta,
      photo.imageWidth,
      photo.imageHeight,
      {
        detections: getSmartDetections(photoId),
      },
    );
    photo.layoutCrop = clampCrop(next, photo.imageWidth, photo.imageHeight);
  });

  // 操作历史（撤销/重做）
  const historyUndoStack = ref<HistoryEntry[]>([]);
  const historyRedoStack = ref<HistoryEntry[]>([]);

  // Layout worker (best-effort): used by async layout APIs only.
  let layoutWorker: Worker | null = null;
  let layoutWorkerReqId = 0;
  const layoutWorkerPending = new Map<
    number,
    { resolve: (placements: Placement[]) => void; reject: (err: Error) => void }
  >();

  function rejectAllLayoutWorkerPending(err: Error) {
    for (const p of layoutWorkerPending.values()) {
      try {
        p.reject(err);
      } catch {
        // ignore
      }
    }
    layoutWorkerPending.clear();
  }

  function getLayoutWorker(): Worker {
    if (layoutWorker) return layoutWorker;
    const w = new Worker(
      new URL("../workers/layoutWorker.ts", import.meta.url),
      { type: "module" },
    );
    w.onmessage = (e: MessageEvent<LayoutWorkerFillArrangeResponse>) => {
      const msg = e.data;
      const pending = layoutWorkerPending.get(msg.id);
      if (!pending) return;
      layoutWorkerPending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.placements);
      else pending.reject(new Error(msg.error));
    };
    w.onerror = () => {
      rejectAllLayoutWorkerPending(new Error("布局 Worker 发生错误"));
      layoutWorker = null;
      try {
        w.terminate();
      } catch {
        // ignore
      }
    };
    layoutWorker = w;
    return w;
  }

  async function computeFillArrangeInWorker(): Promise<Placement[] | null> {
    if (typeof Worker === "undefined") return null;
    if (photos.value.length === 0) return [];

    const photoIdsSnapshot = photos.value.map(p => p.id).join("|");
    const inputs: LayoutWorkerFillArrangePhotoInput[] = photos.value.map(p => ({
      id: p.id,
      crop: snapshotCropRect(p.crop),
      imageWidth: p.imageWidth,
      imageHeight: p.imageHeight,
      detections: getSmartDetections(p.id),
    }));

    const requestId = ++layoutWorkerReqId;
    const w = getLayoutWorker();

    const placements = await new Promise<Placement[]>((resolve, reject) => {
      layoutWorkerPending.set(requestId, { resolve, reject });
      const req: LayoutWorkerFillArrangeRequest = {
        id: requestId,
        type: "fillArrange",
        photos: inputs,
        canvasW: canvasWidth.value,
        canvasH: canvasHeight.value,
      };
      w.postMessage(req);
    });

    // Avoid applying stale results if photo list changed mid-flight.
    const photoIdsNow = photos.value.map(p => p.id).join("|");
    if (photoIdsNow !== photoIdsSnapshot) return null;
    return placements;
  }

  // Computed
  const currentPreset = computed(() =>
    presets.value.find(p => p.id === currentPresetId.value),
  );

  const selectedPhoto = computed(() =>
    photos.value.find(p => p.id === selectedPhotoId.value),
  );

  const cropModePhoto = computed(() =>
    photos.value.find(p => p.id === cropModePhotoId.value),
  );

  const photoCount = computed(() => photos.value.length);

  const sortedPhotos = computed(() => {
    // Track zIndex changes so ordering stays reactive.
    // (Without this, mutating photo.zIndex would not invalidate this computed.)
    void photos.value.map(p => p.zIndex);
    const sorted = [...photos.value].sort((a, b) => a.zIndex - b.zIndex);
    // 裁剪模式：将裁剪中的照片放到最底层（数组最前面），
    // 其他照片覆盖在其上方，形成"固定裁剪框"效果。
    const cropId = cropModePhotoId.value;
    if (cropId) {
      const idx = sorted.findIndex(p => p.id === cropId);
      if (idx > 0) {
        const [cropPhoto] = sorted.splice(idx, 1);
        sorted.unshift(cropPhoto);
      }
    }
    return sorted;
  });

  const canUndo = computed(() => historyUndoStack.value.length > 0);
  const canRedo = computed(() => historyRedoStack.value.length > 0);
  const history = computed(() => historyUndoStack.value);
  const hasCanvasOffset = computed(
    () =>
      Math.abs(canvasOffsetX.value) > 0.5 ||
      Math.abs(canvasOffsetY.value) > 0.5,
  );

  type CropModeSnapshot = {
    photoId: string;
    crop: CropRect;
    layoutCrop?: CropRect;
  };
  const cropModeSnapshot = ref<CropModeSnapshot | null>(null);

  function snapshotCropRect(crop: CropRect): CropRect {
    return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  }

  function snapshotAdjustments(a: PhotoAdjustments): PhotoAdjustments {
    return {
      brightness: a.brightness,
      contrast: a.contrast,
      saturation: a.saturation,
      preset: a.preset,
    };
  }

  function snapshotPhotoCore(photo: PhotoEntity): PhotoCoreSnapshot {
    return {
      id: photo.id,
      cx: photo.cx,
      cy: photo.cy,
      scale: photo.scale,
      rotation: photo.rotation,
      zIndex: photo.zIndex,
      crop: snapshotCropRect(photo.crop),
      layoutCrop: photo.layoutCrop
        ? snapshotCropRect(photo.layoutCrop)
        : undefined,
      adjustments: snapshotAdjustments(photo.adjustments),
    };
  }

  function snapshotPhotoFull(photo: PhotoEntity): PhotoFullSnapshot {
    return {
      ...snapshotPhotoCore(photo),
      name: photo.name,
      srcUrl: photo.srcUrl,
      assetId: photo.assetId,
      image: photo.image,
      sourceWidth: photo.sourceWidth,
      sourceHeight: photo.sourceHeight,
      imageWidth: photo.imageWidth,
      imageHeight: photo.imageHeight,
    };
  }

  function snapshotCanvas(): CanvasSnapshot {
    return photos.value.map(snapshotPhotoCore);
  }

  function applyPhotoCoreSnapshot(photo: PhotoEntity, snap: PhotoCoreSnapshot) {
    photo.cx = snap.cx;
    photo.cy = snap.cy;
    photo.scale = snap.scale;
    photo.rotation = snap.rotation;
    photo.zIndex = snap.zIndex;
    photo.crop = clampCrop(
      snapshotCropRect(snap.crop),
      photo.imageWidth,
      photo.imageHeight,
    );
    photo.layoutCrop = snap.layoutCrop
      ? clampCrop(
          snapshotCropRect(snap.layoutCrop),
          photo.imageWidth,
          photo.imageHeight,
        )
      : undefined;
    photo.adjustments = snapshotAdjustments(snap.adjustments);
  }

  function applyPhotoFullSnapshot(photo: PhotoEntity, snap: PhotoFullSnapshot) {
    photo.name = snap.name;
    photo.srcUrl = snap.srcUrl;
    photo.assetId = snap.assetId;
    photo.image = snap.image;
    photo.sourceWidth = snap.sourceWidth;
    photo.sourceHeight = snap.sourceHeight;
    photo.imageWidth = snap.imageWidth;
    photo.imageHeight = snap.imageHeight;
    applyPhotoCoreSnapshot(photo, snap);
  }

  function collectInUseSrcUrls(): Set<string> {
    const urls = new Set<string>();
    for (const p of photos.value) urls.add(p.srcUrl);
    return urls;
  }

  function maybeRevokeUrl(url: string, inUse: Set<string>) {
    if (!url) return;
    if (inUse.has(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  function cleanupHistoryEntry(entry: HistoryEntry) {
    const inUse = collectInUseSrcUrls();
    if (entry.kind === "photoFull") {
      maybeRevokeUrl(entry.before.srcUrl, inUse);
      // Do not revoke entry.after.srcUrl blindly: it may be current.
    } else if (entry.kind === "removePhoto") {
      maybeRevokeUrl(entry.photo.srcUrl, inUse);
    } else if (entry.kind === "clearAll") {
      for (const item of entry.photos) {
        maybeRevokeUrl(item.photo.srcUrl, inUse);
      }
    }
  }

  function applyCanvasSnapshot(snap: CanvasSnapshot) {
    for (const s of snap) {
      const photo = photos.value.find(p => p.id === s.id);
      if (!photo) continue;
      applyPhotoCoreSnapshot(photo, s);
    }
  }

  function pushHistory(entry: HistoryEntry) {
    historyUndoStack.value.push(entry);
    historyRedoStack.value = [];
    if (historyUndoStack.value.length > HISTORY_LIMIT) {
      const removed = historyUndoStack.value.splice(
        0,
        historyUndoStack.value.length - HISTORY_LIMIT,
      );
      for (const r of removed) cleanupHistoryEntry(r);
    }
  }

  type PhotoHistoryPartial = Partial<
    Pick<
      PhotoEntity,
      | "cx"
      | "cy"
      | "scale"
      | "rotation"
      | "zIndex"
      | "crop"
      | "layoutCrop"
      | "adjustments"
    >
  >;

  function toSnapshotCropMaybe(crop?: CropRect): CropRect | undefined {
    if (!crop) return undefined;
    return snapshotCropRect(crop);
  }

  function toSnapshotAdjustmentsMaybe(
    a?: PhotoAdjustments,
  ): PhotoAdjustments | undefined {
    if (!a) return undefined;
    return snapshotAdjustments(a);
  }

  function pushPhotoHistoryFromPartials(
    photoId: string,
    label: string,
    beforePartial: PhotoHistoryPartial,
    afterPartial: PhotoHistoryPartial,
  ) {
    const photo = photos.value.find(p => p.id === photoId);
    if (!photo) return;

    const base = snapshotPhotoCore(photo);

    const before: PhotoCoreSnapshot = {
      ...base,
      cx: beforePartial.cx ?? base.cx,
      cy: beforePartial.cy ?? base.cy,
      scale: beforePartial.scale ?? base.scale,
      rotation: beforePartial.rotation ?? base.rotation,
      zIndex: beforePartial.zIndex ?? base.zIndex,
      crop: toSnapshotCropMaybe(beforePartial.crop) ?? base.crop,
      layoutCrop: beforePartial.layoutCrop
        ? toSnapshotCropMaybe(beforePartial.layoutCrop)
        : base.layoutCrop,
      adjustments:
        toSnapshotAdjustmentsMaybe(beforePartial.adjustments) ??
        base.adjustments,
    };

    const after: PhotoCoreSnapshot = {
      ...base,
      cx: afterPartial.cx ?? base.cx,
      cy: afterPartial.cy ?? base.cy,
      scale: afterPartial.scale ?? base.scale,
      rotation: afterPartial.rotation ?? base.rotation,
      zIndex: afterPartial.zIndex ?? base.zIndex,
      crop: toSnapshotCropMaybe(afterPartial.crop) ?? base.crop,
      layoutCrop: afterPartial.layoutCrop
        ? toSnapshotCropMaybe(afterPartial.layoutCrop)
        : base.layoutCrop,
      adjustments:
        toSnapshotAdjustmentsMaybe(afterPartial.adjustments) ??
        base.adjustments,
    };

    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "photo",
      photoId,
      before,
      after,
    });
  }

  function undo() {
    const entry = historyUndoStack.value.pop();
    if (!entry) return;

    if (entry.kind === "photo") {
      const photo = photos.value.find(p => p.id === entry.photoId);
      if (photo) applyPhotoCoreSnapshot(photo, entry.before);
    } else if (entry.kind === "photoFull") {
      const photo = photos.value.find(p => p.id === entry.photoId);
      if (photo) applyPhotoFullSnapshot(photo, entry.before);
    } else if (entry.kind === "canvas") {
      applyCanvasSnapshot(entry.before);
    } else if (entry.kind === "removePhoto") {
      // Re-insert the removed photo
      photos.value.splice(entry.index, 0, {
        id: entry.photo.id,
        assetId: entry.photo.assetId,
        name: entry.photo.name,
        srcUrl: entry.photo.srcUrl,
        image: entry.photo.image,
        sourceWidth: entry.photo.sourceWidth,
        sourceHeight: entry.photo.sourceHeight,
        imageWidth: entry.photo.imageWidth,
        imageHeight: entry.photo.imageHeight,
        crop: snapshotCropRect(entry.photo.crop),
        layoutCrop: entry.photo.layoutCrop
          ? snapshotCropRect(entry.photo.layoutCrop)
          : undefined,
        adjustments: snapshotAdjustments(entry.photo.adjustments),
        cx: entry.photo.cx,
        cy: entry.photo.cy,
        scale: entry.photo.scale,
        rotation: entry.photo.rotation,
        zIndex: entry.photo.zIndex,
      });
      selectedPhotoId.value = entry.selectedBefore;
      cropModePhotoId.value = entry.cropModeBefore;
    } else if (entry.kind === "clearAll") {
      for (const item of entry.photos) {
        photos.value.splice(item.index, 0, {
          id: item.photo.id,
          assetId: item.photo.assetId,
          name: item.photo.name,
          srcUrl: item.photo.srcUrl,
          image: item.photo.image,
          sourceWidth: item.photo.sourceWidth,
          sourceHeight: item.photo.sourceHeight,
          imageWidth: item.photo.imageWidth,
          imageHeight: item.photo.imageHeight,
          crop: snapshotCropRect(item.photo.crop),
          layoutCrop: item.photo.layoutCrop
            ? snapshotCropRect(item.photo.layoutCrop)
            : undefined,
          adjustments: snapshotAdjustments(item.photo.adjustments),
          cx: item.photo.cx,
          cy: item.photo.cy,
          scale: item.photo.scale,
          rotation: item.photo.rotation,
          zIndex: item.photo.zIndex,
        });
      }
      selectedPhotoId.value = entry.selectedBefore;
      cropModePhotoId.value = entry.cropModeBefore;
    }

    historyRedoStack.value.push(entry);
  }

  function redo() {
    const entry = historyRedoStack.value.pop();
    if (!entry) return;

    if (entry.kind === "photo") {
      const photo = photos.value.find(p => p.id === entry.photoId);
      if (photo) applyPhotoCoreSnapshot(photo, entry.after);
    } else if (entry.kind === "photoFull") {
      const photo = photos.value.find(p => p.id === entry.photoId);
      if (photo) applyPhotoFullSnapshot(photo, entry.after);
    } else if (entry.kind === "canvas") {
      applyCanvasSnapshot(entry.after);
    } else if (entry.kind === "removePhoto") {
      removePhotoInternal(entry.photoId, { revokeUrl: false });
      selectedPhotoId.value = null;
      cropModePhotoId.value = null;
    } else if (entry.kind === "clearAll") {
      clearAllPhotosInternal({ revokeUrls: false, clearHistoryStacks: false });
    }

    historyUndoStack.value.push(entry);
  }

  function clearHistory() {
    for (const e of historyUndoStack.value) cleanupHistoryEntry(e);
    for (const e of historyRedoStack.value) cleanupHistoryEntry(e);
    historyUndoStack.value = [];
    historyRedoStack.value = [];
  }

  // Actions
  function addPhoto(photo: PhotoEntity) {
    const maxZ = photos.value.reduce((max, p) => Math.max(max, p.zIndex), 0);
    photo.zIndex = maxZ + 1;
    photos.value.push(photo);
    selectedPhotoId.value = photo.id;
  }

  function removePhotoInternal(id: string, opts?: { revokeUrl?: boolean }) {
    const index = photos.value.findIndex(p => p.id === id);
    if (index !== -1) {
      const revokeUrl = opts?.revokeUrl !== false;
      if (revokeUrl) {
        try {
          URL.revokeObjectURL(photos.value[index].srcUrl);
        } catch {
          // ignore
        }
        // 无历史记录时可以释放 bitmap 资源（避免内存上涨）
        const img = photos.value[index].image as any;
        if (img && typeof img.close === "function") {
          try {
            img.close();
          } catch {
            // ignore
          }
        }
      }
      invalidateSmartDetections(id);
      photos.value.splice(index, 1);
      if (selectedPhotoId.value === id) selectedPhotoId.value = null;
      if (cropModePhotoId.value === id) cropModePhotoId.value = null;
      if (cropModeSnapshot.value?.photoId === id) cropModeSnapshot.value = null;
    }
  }

  function removePhoto(id: string) {
    removePhotoInternal(id, { revokeUrl: true });
  }

  function removePhotoWithHistory(id: string, label: string = "删除照片") {
    const index = photos.value.findIndex(p => p.id === id);
    const photo = photos.value.find(p => p.id === id);
    if (!photo || index === -1) return;

    const snap = snapshotPhotoFull(photo);
    const selectedBefore = selectedPhotoId.value;
    const cropModeBefore = cropModePhotoId.value;
    removePhotoInternal(id, { revokeUrl: false });
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "removePhoto",
      photoId: id,
      index,
      photo: snap,
      selectedBefore,
      cropModeBefore,
    });
  }

  function updatePhoto(
    id: string,
    patch: Partial<
      Omit<
        PhotoEntity,
        "id" | "image" | "imageWidth" | "imageHeight" | "srcUrl" | "name"
      >
    >,
  ) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;

    if (patch.crop) {
      photo.crop = clampCrop(patch.crop, photo.imageWidth, photo.imageHeight);
      photo.layoutCrop = undefined;
    }

    if (patch.adjustments) {
      photo.adjustments = snapshotAdjustments(patch.adjustments);
    }

    if (
      patch.cx !== undefined ||
      patch.cy !== undefined ||
      patch.scale !== undefined ||
      patch.rotation !== undefined
    ) {
      const updatedPhoto = { ...photo, ...patch };
      const clamped = clampPhotoToCanvas(
        updatedPhoto,
        canvasWidth.value,
        canvasHeight.value,
      );
      photo.cx = patch.cx !== undefined ? clamped.cx : photo.cx;
      photo.cy = patch.cy !== undefined ? clamped.cy : photo.cy;
      photo.scale = patch.scale ?? photo.scale;
      photo.rotation = patch.rotation ?? photo.rotation;
    }

    if (patch.zIndex !== undefined) {
      photo.zIndex = patch.zIndex;
    }
  }

  function updatePhotoWithHistory(
    id: string,
    patch: Partial<
      Omit<
        PhotoEntity,
        "id" | "image" | "imageWidth" | "imageHeight" | "srcUrl" | "name"
      >
    >,
    label: string,
  ) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;
    const before = snapshotPhotoCore(photo);
    updatePhoto(id, patch);
    const after = snapshotPhotoCore(photo);
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "photo",
      photoId: id,
      before,
      after,
    });
  }

  function autoLayout() {
    if (photos.value.length === 0) return;
    console.log(
      "[LayoutDebug] autoLayout: Starting layout for",
      photos.value.length,
      "photos",
    );
    const placements = fillArrangePhotos(
      photos.value,
      canvasWidth.value,
      canvasHeight.value,
    );
    console.log(
      "[LayoutDebug] autoLayout: Generated",
      placements.length,
      "placements",
    );
    applyPlacements(placements);
  }

  async function autoLayoutAsync(): Promise<boolean> {
    if (photos.value.length === 0) return true;

    try {
      const placements = await computeFillArrangeInWorker();
      if (!placements) {
        autoLayout();
        return true;
      }
      applyPlacements(placements);
      return true;
    } catch {
      // Fallback to main thread on any worker error.
      autoLayout();
      return true;
    }
  }

  function autoLayoutWithHistory(label: string = "自动排版") {
    if (photos.value.length === 0) return;
    const before = snapshotCanvas();
    autoLayout();
    const after = snapshotCanvas();
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "canvas",
      before,
      after,
    });
  }

  async function autoLayoutWithHistoryAsync(label: string = "自动排版") {
    if (photos.value.length === 0) return;

    const before = snapshotCanvas();
    await autoLayoutAsync();
    const after = snapshotCanvas();

    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "canvas",
      before,
      after,
    });
  }

  function applyPlacementsWithHistory(placements: Placement[], label: string) {
    if (photos.value.length === 0) return;
    const before = snapshotCanvas();
    applyPlacements(placements);
    const after = snapshotCanvas();
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "canvas",
      before,
      after,
    });
  }

  function applyCrop(id: string, crop: CropRect, label: string = "裁剪") {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;

    const before = snapshotCanvas();
    if (cropModeSnapshot.value?.photoId === id) {
      const snap = cropModeSnapshot.value;
      const target = before.find(item => item.id === id);
      if (target) {
        target.crop = snapshotCropRect(snap.crop);
        target.layoutCrop = snap.layoutCrop
          ? snapshotCropRect(snap.layoutCrop)
          : undefined;
      }
    }

    photo.crop = clampCrop(crop, photo.imageWidth, photo.imageHeight);
    photo.layoutCrop = undefined;
    // 裁剪后重新排版，自动更新位置和尺寸
    autoLayout();

    const after = snapshotCanvas();
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "canvas",
      before,
      after,
    });
  }

  /**
   * 裁剪确认但不触发全局重排：仅更新当前照片的 crop，保持其他照片位置不变。
   * 用于裁剪模式下的确认操作，避免 autoLayout() 打乱已有布局。
   */
  function applyCropLocal(id: string, crop: CropRect, label: string = "裁剪") {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;

    const before = snapshotCanvas();
    if (cropModeSnapshot.value?.photoId === id) {
      const snap = cropModeSnapshot.value;
      const target = before.find(item => item.id === id);
      if (target) {
        target.crop = snapshotCropRect(snap.crop);
        target.layoutCrop = snap.layoutCrop
          ? snapshotCropRect(snap.layoutCrop)
          : undefined;
      }
    }

    photo.crop = clampCrop(crop, photo.imageWidth, photo.imageHeight);
    photo.layoutCrop = undefined;
    // 不调用 autoLayout()，保持其他照片位置不变

    const after = snapshotCanvas();
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "canvas",
      before,
      after,
    });
  }

  function replacePhotoImage(
    id: string,
    image: CanvasImageSource,
    imageWidth: number,
    imageHeight: number,
    crop: CropRect,
  ) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;
    invalidateSmartDetections(id);
    photo.image = image;
    photo.imageWidth = imageWidth;
    photo.imageHeight = imageHeight;
    photo.crop = clampCrop(crop, imageWidth, imageHeight);
    photo.layoutCrop = undefined;
    prefetchSmartDetections(id, image);
  }

  async function addPhotos(
    files: File[],
    opts?: {
      concurrency?: number;
      onProgress?: (p: { done: number; total: number; label?: string }) => void;
    },
  ): Promise<ImportPhotosResult> {
    const availableSlots = Math.max(
      0,
      MAX_IMPORT_PHOTO_COUNT - photos.value.length,
    );
    const queue = files.slice(0, availableSlots);
    const truncated = Math.max(0, files.length - queue.length);
    if (truncated > 0) {
      console.warn(
        "[LayoutDebug] addPhotos: import limited to 150 photos, truncated",
        truncated,
        "files",
      );
    }
    const total = queue.length;
    if (total === 0) return { added: 0, failed: 0, truncated };

    const vision = getVisionClient();
    const concurrency = clamp(opts?.concurrency ?? 3, 1, 4);

    let done = 0;
    let added = 0;
    let failed = 0;

    const runOne = async (file: File) => {
      const photoId = generateId();

      // 先把原图落盘（用于工程导出/高清导出）
      let assetId: string | null = null;
      try {
        assetId = createAssetId();
        const assetMeta: ProjectAssetMeta = {
          id: assetId,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          lastModified: file.lastModified || Date.now(),
        };
        await putAsset(assetMeta, file);
      } catch {
        assetId = null;
      }

      let photo: PhotoEntity | null = null;

      // 优先走 vision worker；失败则自动降级到主线程导入（native face + saliency）
      // HEIC 优先走主线程解码链路（兼容 createImageBitmap / 浏览器原生显示兜底）
      if (vision.isEnabled() && !isHeicFile(file)) {
        try {
          console.log("[FaceDebug] Using vision worker for photo:", photoId);
          const res = await vision.processFile({ photoId, file });
          const srcUrl = URL.createObjectURL(file);

          const fullCrop: CropRect = {
            x: 0,
            y: 0,
            width: res.previewWidth,
            height: res.previewHeight,
          };
          const fit =
            Math.min(
              canvasWidth.value / res.previewWidth,
              canvasHeight.value / res.previewHeight,
            ) * 0.4;
          const scale = clamp(fit, 0.05, 3);

          const hasFaces = res.detections.some(d => d.kind === "face");
          const hasObjects = res.detections.some(d => d.kind === "object");
          console.log(
            "[FaceDebug] Vision worker detections:",
            res.detections.length,
            "hasFaces:",
            hasFaces,
            "hasObjects:",
            hasObjects,
          );
          seedSmartDetections(photoId, res.detections, {
            hasFaces,
            hasObjects,
          });

          photo = {
            id: photoId,
            assetId: assetId ?? undefined,
            name: file.name,
            srcUrl,
            image: res.previewBitmap,
            sourceWidth: res.sourceWidth,
            sourceHeight: res.sourceHeight,
            imageWidth: res.previewWidth,
            imageHeight: res.previewHeight,
            crop: fullCrop,
            adjustments: { ...DEFAULT_ADJUSTMENTS },
            cx: canvasWidth.value / 2,
            cy: canvasHeight.value / 2,
            scale,
            rotation: 0,
            zIndex: 0,
          };
        } catch (e) {
          console.warn(
            "[FaceDebug] Vision worker failed, falling back to main thread:",
            file.name,
            e,
          );
          photo = null;
        }
      } else {
        console.log(
          "[FaceDebug] Vision worker disabled or HEIC file, using main thread for:",
          photoId,
        );
      }

      if (!photo) {
        try {
          const fallback = await createPhotoFromFile(
            file,
            canvasWidth.value,
            canvasHeight.value,
            {
              id: photoId,
              prefetchSmartCrop: true,
            },
          );
          fallback.assetId = assetId ?? undefined;
          photo = fallback;
        } catch (e) {
          failed++;
          console.warn("Import failed:", file.name, e);
          return;
        }
      }

      addPhoto(photo);
      added++;
    };

    const executing = new Set<Promise<void>>();
    for (const f of queue) {
      const p = runOne(f).finally(() => {
        executing.delete(p);
        done++;
        opts?.onProgress?.({ done, total, label: f.name });
      });
      executing.add(p);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);

    // 导入完成后统一自动排版（全量重排，避免重叠/集中/空白）
    await autoLayoutAsync();
    return { added, failed, truncated };
  }

  async function importFiles(
    files: File[],
    opts?: {
      concurrency?: number;
      onProgress?: (p: { done: number; total: number; label?: string }) => void;
    },
  ): Promise<ImportPhotosResult> {
    return addPhotos(files, opts);
  }

  async function replacePhotoFromFile(id: string, file: File) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;

    const before = snapshotPhotoFull(photo);
    invalidateSmartDetections(id);

    // Persist original file for restore/high-quality export
    try {
      const assetId = createAssetId();
      const assetMeta: ProjectAssetMeta = {
        id: assetId,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        lastModified: file.lastModified || Date.now(),
      };
      await putAsset(assetMeta, file);
      photo.assetId = assetId;
    } catch (e) {
      // If persistence fails, continue with in-memory replace.
      console.warn("Failed to persist replacement asset:", e);
    }

    const loaded = await createPhotoFromFile(
      file,
      canvasWidth.value,
      canvasHeight.value,
      { id },
    );

    const effectiveCrop = photo.layoutCrop ?? photo.crop;
    const targetAspect =
      effectiveCrop.width / Math.max(1, effectiveCrop.height);
    const fullCrop: CropRect = {
      x: 0,
      y: 0,
      width: loaded.imageWidth,
      height: loaded.imageHeight,
    };
    const nextCrop = centerCropToAspect(
      fullCrop,
      targetAspect,
      loaded.imageWidth,
      loaded.imageHeight,
      {
        detections: getSmartDetections(id),
      },
    );

    const oldDrawW = effectiveCrop.width * photo.scale;
    const nextScale = clamp(oldDrawW / Math.max(1, nextCrop.width), 0.05, 3);

    photo.name = file.name;
    photo.srcUrl = loaded.srcUrl;
    photo.image = loaded.image;
    photo.sourceWidth = loaded.sourceWidth;
    photo.sourceHeight = loaded.sourceHeight;
    photo.imageWidth = loaded.imageWidth;
    photo.imageHeight = loaded.imageHeight;

    if (photo.layoutCrop) {
      photo.crop = fullCrop;
      photo.layoutCrop = nextCrop;
    } else {
      photo.crop = nextCrop;
      photo.layoutCrop = undefined;
    }

    photo.scale = nextScale;
    const clampedPos = clampPhotoToCanvas(
      photo,
      canvasWidth.value,
      canvasHeight.value,
    );
    photo.cx = clampedPos.cx;
    photo.cy = clampedPos.cy;

    const after = snapshotPhotoFull(photo);
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: `替换照片：${before.name} → ${after.name}`,
      kind: "photoFull",
      photoId: id,
      before,
      after,
    });
  }

  function setPhotoAdjustments(id: string, next: PhotoAdjustments) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;
    photo.adjustments = snapshotAdjustments(next);
  }

  function setPreset(presetId: string) {
    const preset = presets.value.find(p => p.id === presetId);
    if (!preset) return;
    currentPresetId.value = presetId;
    canvasWidth.value = preset.width;
    canvasHeight.value = preset.height;
    // 画布尺寸变化后自动排版（即使当前有选中照片也需要重排）
    autoLayout();
  }

  function setCustomSize(width: number, height: number) {
    canvasWidth.value = width;
    canvasHeight.value = height;
    currentPresetId.value = "custom";
    autoLayout();
  }

  function setCanvasOffset(x: number, y: number) {
    canvasOffsetX.value = x;
    canvasOffsetY.value = y;
  }

  function nudgeCanvasOffset(dx: number, dy: number) {
    canvasOffsetX.value += dx;
    canvasOffsetY.value += dy;
  }

  function resetCanvasOffset() {
    canvasOffsetX.value = 0;
    canvasOffsetY.value = 0;
  }

  function selectPhoto(id: string | null) {
    selectedPhotoId.value = id;
  }

  function bringToFront(id: string) {
    const maxZ = photos.value.reduce((max, p) => Math.max(max, p.zIndex), 0);
    const photo = photos.value.find(p => p.id === id);
    if (photo) {
      photo.zIndex = maxZ + 1;
      selectedPhotoId.value = id;
    }
  }

  function sendToBack(id: string) {
    const minZ = photos.value.reduce(
      (min, p) => Math.min(min, p.zIndex),
      Infinity,
    );
    const photo = photos.value.find(p => p.id === id);
    if (photo) {
      photo.zIndex = minZ - 1;
      selectedPhotoId.value = id;
    }
  }

  function bringToFrontWithHistory(id: string) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;
    const before = snapshotPhotoCore(photo);
    bringToFront(id);
    const after = snapshotPhotoCore(photo);
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: "置顶",
      kind: "photo",
      photoId: id,
      before,
      after,
    });
  }

  function sendToBackWithHistory(id: string) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;
    const before = snapshotPhotoCore(photo);
    sendToBack(id);
    const after = snapshotPhotoCore(photo);
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: "置底",
      kind: "photo",
      photoId: id,
      before,
      after,
    });
  }

  /**
   * 进入裁剪模式时，先把显示裁剪重置为全图，便于用户从原图开始自定义裁剪。
   * 取消裁剪时会恢复进入前的 crop / layoutCrop。
   */
  function enterCropMode(id: string) {
    const photo = photos.value.find(p => p.id === id);
    if (!photo) return;

    if (cropModeSnapshot.value && cropModeSnapshot.value.photoId !== id) {
      cancelCropMode();
    }

    cropModeSnapshot.value = {
      photoId: id,
      crop: snapshotCropRect(photo.crop),
      layoutCrop: photo.layoutCrop
        ? snapshotCropRect(photo.layoutCrop)
        : undefined,
    };
    photo.crop = {
      x: 0,
      y: 0,
      width: photo.imageWidth,
      height: photo.imageHeight,
    };
    photo.layoutCrop = undefined;
    cropModePhotoId.value = id;
    selectedPhotoId.value = id;
  }

  function commitCropMode() {
    cropModeSnapshot.value = null;
    cropModePhotoId.value = null;
  }

  function cancelCropMode() {
    const snap = cropModeSnapshot.value;
    if (snap) {
      const photo = photos.value.find(p => p.id === snap.photoId);
      if (photo) {
        photo.crop = clampCrop(
          snapshotCropRect(snap.crop),
          photo.imageWidth,
          photo.imageHeight,
        );
        photo.layoutCrop = snap.layoutCrop
          ? clampCrop(
              snapshotCropRect(snap.layoutCrop),
              photo.imageWidth,
              photo.imageHeight,
            )
          : undefined;
      }
    }
    cropModeSnapshot.value = null;
    cropModePhotoId.value = null;
  }

  /**
   * 裁剪模式固定框：优先使用进入裁剪前的 layoutCrop，保证“显示尺寸不跳变”。
   */
  function getCropModeReferenceCrop(id: string): CropRect | null {
    const snap = cropModeSnapshot.value;
    if (!snap || snap.photoId !== id) return null;
    return snapshotCropRect(snap.layoutCrop ?? snap.crop);
  }

  function setCropMode(id: string | null) {
    if (id) {
      enterCropMode(id);
      return;
    }
    commitCropMode();
  }

  function setExporting(value: boolean) {
    isExporting.value = value;
  }

  function setExportFormat(value: ExportFormat) {
    exportFormat.value = value;
  }

  function setExportQuality(value: number) {
    exportQuality.value = value;
  }

  function setExportResolution(value: ExportResolutionPreset) {
    exportResolution.value = value;
  }

  function setMode(newMode: AppMode) {
    mode.value = newMode;
  }

  function clearAllPhotosInternal(opts?: {
    revokeUrls?: boolean;
    clearHistoryStacks?: boolean;
  }) {
    const revokeUrls = opts?.revokeUrls !== false;
    const clearHistoryStacks = opts?.clearHistoryStacks !== false;
    if (revokeUrls) {
      photos.value.forEach(p => {
        try {
          URL.revokeObjectURL(p.srcUrl);
        } catch {
          // ignore
        }
        const img = p.image as any;
        if (img && typeof img.close === "function") {
          try {
            img.close();
          } catch {
            // ignore
          }
        }
      });
    }
    photos.value = [];
    selectedPhotoId.value = null;
    cropModePhotoId.value = null;
    cropModeSnapshot.value = null;
    if (clearHistoryStacks) clearHistory();
  }

  function clearAllPhotos() {
    clearAllPhotosInternal({ revokeUrls: true, clearHistoryStacks: true });
  }

  function clearAllPhotosWithHistory(label: string = "清空所有照片") {
    if (photos.value.length === 0) return;
    const selectedBefore = selectedPhotoId.value;
    const cropModeBefore = cropModePhotoId.value;
    const snaps = photos.value.map((p, idx) => ({
      index: idx,
      photo: snapshotPhotoFull(p),
    }));
    clearAllPhotosInternal({ revokeUrls: false, clearHistoryStacks: false });
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: "clearAll",
      photos: snaps,
      selectedBefore,
      cropModeBefore,
    });
  }

  function applyPlacements(placements: Placement[]) {
    placements.forEach(({ id, cx, cy, scale, rotation, crop }) => {
      const photo = photos.value.find(p => p.id === id);
      if (photo) {
        photo.cx = cx;
        photo.cy = cy;
        photo.scale = scale;
        photo.rotation = rotation;
        if (crop) {
          photo.layoutCrop = clampCrop(
            crop,
            photo.imageWidth,
            photo.imageHeight,
          );
        }
      }
    });
  }

  return {
    // State
    presets,
    currentPresetId,
    canvasWidth,
    canvasHeight,
    canvasOffsetX,
    canvasOffsetY,
    photos,
    selectedPhotoId,
    cropModePhotoId,
    exportFormat,
    exportQuality,
    exportResolution,
    isExporting,
    mode,
    history,

    // Computed
    currentPreset,
    selectedPhoto,
    cropModePhoto,
    photoCount,
    sortedPhotos,
    canUndo,
    canRedo,
    hasCanvasOffset,

    // Actions
    addPhoto,
    removePhoto,
    removePhotoWithHistory,
    updatePhoto,
    updatePhotoWithHistory,
    replacePhotoImage,
    autoLayout,
    autoLayoutAsync,
    autoLayoutWithHistory,
    autoLayoutWithHistoryAsync,
    applyPlacementsWithHistory,
    applyCrop,
    applyCropLocal,
    undo,
    redo,
    clearHistory,
    pushPhotoHistoryFromPartials,
    replacePhotoFromFile,
    addPhotos,
    importFiles,
    setPhotoAdjustments,
    setPreset,
    setCustomSize,
    setCanvasOffset,
    nudgeCanvasOffset,
    resetCanvasOffset,
    selectPhoto,
    bringToFront,
    sendToBack,
    bringToFrontWithHistory,
    sendToBackWithHistory,
    enterCropMode,
    commitCropMode,
    cancelCropMode,
    getCropModeReferenceCrop,
    setCropMode,
    setExporting,
    setExportFormat,
    setExportQuality,
    setExportResolution,
    setMode,
    clearAllPhotos,
    clearAllPhotosWithHistory,
    applyPlacements,
  };
});
