<template>
  <div class="canvas-stage">
    <div class="canvas-stage__header">
      <div class="canvas-stage__title">
        <span>画布预览</span>
        <span class="badge badge--primary">{{ store.photoCount }} 张照片</span>
      </div>
      <div class="canvas-stage__actions">
        <div class="zoom-control">
          <button
            class="btn btn--ghost btn--icon"
            @click="zoomOut"
            title="缩小">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <span class="zoom-control__value">{{ zoomPercent }}%</span>
          <button class="btn btn--ghost btn--icon" @click="zoomIn" title="放大">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
        </div>
        <button
          class="btn btn--ghost btn--sm"
          @click="fitToView"
          title="适应窗口">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="16"
            height="16">
            <path
              d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
          </svg>
          适应
        </button>
        <button
          class="btn btn--ghost btn--sm"
          :disabled="
            !store.hasCanvasOffset && Math.abs(viewport.scale - 1) < 0.001
          "
          @click="resetView"
          title="重置视图">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="16"
            height="16">
            <polyline points="1 4 1 10 7 10" />
            <polyline points="23 20 23 14 17 14" />
            <path
              d="M20.49 9a9 9 0 00-14.13-3.36L1 10m22 4l-5.36 4.36A9 9 0 013.51 15" />
          </svg>
          重置
        </button>
      </div>
    </div>

    <div
      ref="stageBody"
      class="canvas-stage__body"
      :class="{
        'canvas-stage__body--pan-ready':
          isSpacePressed && pointerMode.kind !== 'pan',
        'canvas-stage__body--panning': pointerMode.kind === 'pan',
      }"
      @wheel.prevent="handleWheel">
      <canvas
        ref="canvasEl"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointerleave="handlePointerUp" />
    </div>

    <!-- 裁剪模式提示 -->
    <Transition name="fade">
      <div v-if="store.cropModePhotoId" class="crop-hint">
        <span>裁剪模式 - 拖动照片内容调整裁剪</span>
        <div class="crop-hint__actions">
          <button class="btn btn--success btn--sm" @click="applyCrop">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="16"
              height="16">
              <polyline points="20,6 9,17 4,12" />
            </svg>
            确认
          </button>
          <button class="btn btn--secondary btn--sm" @click="cancelCrop">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="16"
              height="16">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            取消
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useMosaicStore } from "@/stores/mosaic";
import { useToastStore } from "@/stores/toast";
import { useThemeStore } from "@/stores/theme";
import type { PhotoEntity, Handle, CropRect, Viewport } from "@/types";
import {
  clamp,
  inverseRotatePoint,
  getDrawHalfSize,
  getHandlePositions,
  pointInPhoto,
} from "@/utils/math";
import { buildCanvasFilter } from "@/utils/filters";

const store = useMosaicStore();
const toast = useToastStore();
const themeStore = useThemeStore();

const stageBody = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const ctx = ref<CanvasRenderingContext2D | null>(null);
const resizeObserver = ref<ResizeObserver | null>(null);

const viewport = ref<Viewport>({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dpr: 1,
  cssWidth: 800,
  cssHeight: 600,
});

// 默认保持“自适应填充”模式；当用户手动缩放后，停止自动重算缩放比例
const autoFit = ref(true);

const zoomPercent = computed(() => Math.round(viewport.value.scale * 100));

// 拖拽状态
type PointerMode =
  | { kind: "none" }
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startOffsetX: number;
      startOffsetY: number;
    }
  | {
      kind: "drag";
      id: string;
      dx: number;
      dy: number;
      startCx: number;
      startCy: number;
    }
  | {
      kind: "resize";
      id: string;
      handle: Handle;
      startScale: number;
      startX: number;
      startY: number;
    }
  | {
      kind: "crop-move";
      id: string;
      startX: number;
      startY: number;
      startCrop: CropRect;
    };

const pointerMode = ref<PointerMode>({ kind: "none" });
const cropDraft = ref<CropRect | null>(null);
const rafId = ref<number | null>(null);
const isSpacePressed = ref(false);

type CanvasColors = { bg: string; innerBg: string };
const cachedColors = ref<CanvasColors | null>(null);
const gridPatternCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

type LayerCanvases = {
  base: HTMLCanvasElement;
  baseCtx: CanvasRenderingContext2D;
  photos: HTMLCanvasElement;
  photosCtx: CanvasRenderingContext2D;
};

const layers = ref<LayerCanvases | null>(null);
const layerSizeKey = ref<string>("");
const baseLayerDirty = ref(true);

type PhotoLayerState = {
  dirty: boolean;
  inProgress: boolean;
  index: number;
  version: number;
};
const photoLayerState = ref<PhotoLayerState>({
  dirty: true,
  inProgress: false,
  index: 0,
  version: 0,
});

// 150 张照片场景优先启用分帧渲染，避免主线程一次性绘制卡顿。
const PROGRESSIVE_PHOTO_THRESHOLD = 120;
const CROP_CONFIRM_EVENT = "mosaic:crop-confirm";
const CROP_CANCEL_EVENT = "mosaic:crop-cancel";

function handleExternalCropConfirm() {
  if (!store.cropModePhotoId) return;
  applyCrop();
}

function handleExternalCropCancel() {
  if (!store.cropModePhotoId) return;
  cancelCrop();
}

function readCanvasColors(): CanvasColors {
  const rootStyles = window.getComputedStyle(document.documentElement);
  const bg = rootStyles.getPropertyValue("--canvas-bg").trim() || "#1a1a2e";
  const innerBg =
    rootStyles.getPropertyValue("--canvas-inner-bg").trim() || "#2a2a3e";
  return { bg, innerBg };
}

function ensureCanvasColors(): CanvasColors {
  if (!cachedColors.value) cachedColors.value = readCanvasColors();
  return cachedColors.value;
}

function ensureGridPattern(c: CanvasRenderingContext2D): CanvasPattern | null {
  const existing = gridPatternCache.get(c);
  if (existing) return existing;

  const gridSize = 100;
  const tile = document.createElement("canvas");
  tile.width = gridSize;
  tile.height = gridSize;

  const tc = tile.getContext("2d");
  if (!tc) return null;

  tc.clearRect(0, 0, gridSize, gridSize);
  tc.strokeStyle = "rgba(255, 255, 255, 0.03)";
  tc.lineWidth = 1;

  // Crisp 1px lines in the tile's own coordinate space.
  tc.beginPath();
  tc.moveTo(0.5, 0);
  tc.lineTo(0.5, gridSize);
  tc.moveTo(0, 0.5);
  tc.lineTo(gridSize, 0.5);
  tc.stroke();

  const pattern = c.createPattern(tile, "repeat");
  if (pattern) gridPatternCache.set(c, pattern);
  return pattern;
}

function ensureLayers(): LayerCanvases | null {
  if (!canvasEl.value) return null;
  if (layers.value) return layers.value;

  const base = document.createElement("canvas");
  const photos = document.createElement("canvas");
  const baseCtx = base.getContext("2d");
  const photosCtx = photos.getContext("2d");
  if (!baseCtx || !photosCtx) return null;

  layers.value = { base, baseCtx, photos, photosCtx };
  return layers.value;
}

function invalidateBaseLayer() {
  baseLayerDirty.value = true;
}

function invalidatePhotoLayer() {
  photoLayerState.value.dirty = true;
  photoLayerState.value.inProgress = false;
  photoLayerState.value.index = 0;
  photoLayerState.value.version++;
}

function getCanvasTranslate() {
  return {
    x: viewport.value.offsetX + store.canvasOffsetX,
    y: viewport.value.offsetY + store.canvasOffsetY,
  };
}

function ensureLayerSizes() {
  const l = ensureLayers();
  if (!l || !canvasEl.value) return;

  const key = `${canvasEl.value.width}x${canvasEl.value.height}`;
  if (layerSizeKey.value === key) return;
  layerSizeKey.value = key;

  l.base.width = canvasEl.value.width;
  l.base.height = canvasEl.value.height;
  l.photos.width = canvasEl.value.width;
  l.photos.height = canvasEl.value.height;

  invalidateBaseLayer();
  invalidatePhotoLayer();
}

function rebuildBaseLayer() {
  const l = ensureLayers();
  if (!l) return;

  const c = l.baseCtx;
  const { scale, dpr, cssWidth, cssHeight } = viewport.value;
  const translate = getCanvasTranslate();
  const { bg, innerBg } = ensureCanvasColors();

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssWidth, cssHeight);

  c.fillStyle = bg;
  c.fillRect(0, 0, cssWidth, cssHeight);

  c.save();
  c.translate(translate.x, translate.y);
  c.scale(scale, scale);

  c.fillStyle = innerBg;
  c.fillRect(0, 0, store.canvasWidth, store.canvasHeight);
  drawGrid(c);

  c.restore();
  baseLayerDirty.value = false;
}

function renderPhotoLayerBatch() {
  const l = ensureLayers();
  if (!l) return;

  const state = photoLayerState.value;
  const { scale, dpr, cssWidth, cssHeight } = viewport.value;
  const translate = getCanvasTranslate();
  const list = store.sortedPhotos;

  if (state.dirty && !state.inProgress) {
    // Fresh build.
    const pc = l.photosCtx;
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    pc.clearRect(0, 0, cssWidth, cssHeight);
    state.dirty = false;
    state.inProgress = true;
    state.index = 0;
  }

  if (!state.inProgress) return;

  const startVersion = state.version;
  const pc = l.photosCtx;
  pc.setTransform(dpr, 0, 0, dpr, 0, 0);
  pc.save();
  pc.translate(translate.x, translate.y);
  pc.scale(scale, scale);

  const t0 = performance.now();
  let i = state.index;
  while (i < list.length) {
    // Abort if invalidated mid-frame.
    if (photoLayerState.value.version !== startVersion) break;
    drawPhoto(pc, list[i]);
    i++;
    if (i - state.index >= 40) break;
    if (performance.now() - t0 > 8) break;
  }

  pc.restore();
  state.index = i;
  if (i >= list.length && photoLayerState.value.version === startVersion) {
    state.inProgress = false;
  }
}

// 初始化
onMounted(() => {
  if (!canvasEl.value) return;
  ctx.value = canvasEl.value.getContext("2d");

  // Prefer ResizeObserver over window resize (sidebar width changes, etc.)
  if (stageBody.value && "ResizeObserver" in window) {
    resizeObserver.value = new ResizeObserver(() => {
      handleResize({ preserveScale: !autoFit.value });
    });
    resizeObserver.value.observe(stageBody.value);
  } else {
    window.addEventListener("resize", handleResize);
  }

  // First layout pass after DOM is ready
  nextTick(() => {
    handleResize({ preserveScale: false });
  });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener(CROP_CONFIRM_EVENT, handleExternalCropConfirm);
  window.addEventListener(CROP_CANCEL_EVENT, handleExternalCropCancel);

  // Prewarm cached CSS-derived colors after the initial DOM paint.
  nextTick(() => {
    cachedColors.value = null;
    ensureCanvasColors();
  });

  // Ensure offscreen layers are ready after first sizing pass.
  nextTick(() => {
    ensureLayerSizes();
  });

  requestRender();
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  window.removeEventListener("keydown", handleKeyDown);
  window.removeEventListener("keyup", handleKeyUp);
  window.removeEventListener(CROP_CONFIRM_EVENT, handleExternalCropConfirm);
  window.removeEventListener(CROP_CANCEL_EVENT, handleExternalCropCancel);
  if (resizeObserver.value) {
    resizeObserver.value.disconnect();
    resizeObserver.value = null;
  }
  if (rafId.value) cancelAnimationFrame(rafId.value);
});

// 监听状态变化
watch(
  () => [
    store.photos,
    store.selectedPhotoId,
    store.cropModePhotoId,
    store.canvasWidth,
    store.canvasHeight,
  ],
  () => {
    // Photos/canvas changes should invalidate cached photo layer.
    invalidatePhotoLayer();
    if (store.canvasWidth || store.canvasHeight) invalidateBaseLayer();
    requestRender();
  },
  { deep: true },
);

watch(
  () => [store.canvasWidth, store.canvasHeight],
  async () => {
    // Canvas size changed (preset/custom): refit to viewport.
    await nextTick();
    autoFit.value = true;
    store.resetCanvasOffset();
    handleResize({ preserveScale: false });
  },
);

watch(
  () => store.cropModePhotoId,
  id => {
    if (id) {
      const photo = store.photos.find(p => p.id === id);
      const reference = photo ? store.getCropModeReferenceCrop(id) : null;
      if (photo && reference) {
        // 进入裁剪时,固定裁剪框尺寸为进入前显示区域,从原图左上角(0,0)开始显示,后续只通过拖动内容改变 x/y。
        cropDraft.value = {
          x: clamp(0, 0, photo.imageWidth - reference.width),
          y: clamp(0, 0, photo.imageHeight - reference.height),
          width: clamp(reference.width, 1, photo.imageWidth),
          height: clamp(reference.height, 1, photo.imageHeight),
        };
      } else {
        cropDraft.value = photo ? { ...photo.crop } : null;
      }
    } else {
      cropDraft.value = null;
    }
    requestRender();
  },
);

watch(
  () => themeStore.theme,
  () => {
    cachedColors.value = null;
    // Theme changes should rebuild base and photo layers.
    invalidateBaseLayer();
    invalidatePhotoLayer();
    requestRender();
  },
  { flush: "post" },
);

// 响应式调整大小
function computeFitViewport(cssWidth: number, cssHeight: number) {
  const padding = 32;
  const safeW = Math.max(1, cssWidth - padding * 2);
  const safeH = Math.max(1, cssHeight - padding * 2);
  const scale = Math.min(safeW / store.canvasWidth, safeH / store.canvasHeight);
  const clampedScale = clamp(scale, 0.02, 2);

  const offsetX = (cssWidth - store.canvasWidth * clampedScale) / 2;
  const offsetY = (cssHeight - store.canvasHeight * clampedScale) / 2;
  return { scale: clampedScale, offsetX, offsetY };
}

function handleResize(opts?: { preserveScale?: boolean } | UIEvent) {
  if (!stageBody.value || !canvasEl.value) return;

  const styles = window.getComputedStyle(stageBody.value);
  const padX =
    parseFloat(styles.paddingLeft || "0") +
    parseFloat(styles.paddingRight || "0");
  const padY =
    parseFloat(styles.paddingTop || "0") +
    parseFloat(styles.paddingBottom || "0");

  // Content-box size (exclude padding)
  const cssWidth = Math.max(
    200,
    Math.floor(stageBody.value.clientWidth - padX),
  );
  const cssHeight = Math.max(
    200,
    Math.floor(stageBody.value.clientHeight - padY),
  );
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvasEl.value.style.width = `${cssWidth}px`;
  canvasEl.value.style.height = `${cssHeight}px`;
  canvasEl.value.width = Math.floor(cssWidth * dpr);
  canvasEl.value.height = Math.floor(cssHeight * dpr);

  const preserveScale =
    typeof opts === "object" && opts != null && "preserveScale" in opts
      ? Boolean((opts as { preserveScale?: boolean }).preserveScale)
      : false;
  const next = preserveScale
    ? {
        scale: viewport.value.scale,
        offsetX: (cssWidth - store.canvasWidth * viewport.value.scale) / 2,
        offsetY: (cssHeight - store.canvasHeight * viewport.value.scale) / 2,
      }
    : computeFitViewport(cssWidth, cssHeight);

  viewport.value = { ...next, dpr, cssWidth, cssHeight };
  ensureLayerSizes();
  invalidateBaseLayer();
  invalidatePhotoLayer();
  requestRender();
}

function fitToView() {
  autoFit.value = true;
  store.resetCanvasOffset();
  handleResize({ preserveScale: false });
}

function resetView() {
  autoFit.value = true;
  store.resetCanvasOffset();
  handleResize({ preserveScale: false });
}

function applyZoom(nextScale: number, anchorClient?: { x: number; y: number }) {
  const scale = clamp(nextScale, 0.02, 2);
  if (Math.abs(scale - viewport.value.scale) < 1e-6) return;

  const rect = canvasEl.value?.getBoundingClientRect();
  const anchorX =
    rect && anchorClient
      ? clamp(anchorClient.x - rect.left, 0, viewport.value.cssWidth)
      : viewport.value.cssWidth / 2;
  const anchorY =
    rect && anchorClient
      ? clamp(anchorClient.y - rect.top, 0, viewport.value.cssHeight)
      : viewport.value.cssHeight / 2;

  const current = getCanvasTranslate();
  const worldX = (anchorX - current.x) / viewport.value.scale;
  const worldY = (anchorY - current.y) / viewport.value.scale;

  const baseOffsetX = (viewport.value.cssWidth - store.canvasWidth * scale) / 2;
  const baseOffsetY =
    (viewport.value.cssHeight - store.canvasHeight * scale) / 2;

  const nextTotalX = anchorX - worldX * scale;
  const nextTotalY = anchorY - worldY * scale;

  viewport.value.scale = scale;
  viewport.value.offsetX = baseOffsetX;
  viewport.value.offsetY = baseOffsetY;
  store.setCanvasOffset(nextTotalX - baseOffsetX, nextTotalY - baseOffsetY);

  invalidateBaseLayer();
  invalidatePhotoLayer();
  requestRender();
}

function zoomIn() {
  autoFit.value = false;
  applyZoom(viewport.value.scale * 1.2);
}

function zoomOut() {
  autoFit.value = false;
  applyZoom(viewport.value.scale / 1.2);
}

function handleWheel(e: WheelEvent) {
  autoFit.value = false;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  applyZoom(viewport.value.scale * delta, { x: e.clientX, y: e.clientY });
}

// 坐标转换
function screenToCanvas(
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const { scale } = viewport.value;
  const translate = getCanvasTranslate();
  const rect = canvasEl.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };

  const x = (screenX - rect.left - translate.x) / scale;
  const y = (screenY - rect.top - translate.y) / scale;
  return { x, y };
}

// 查找点击的照片
function findPhotoAt(x: number, y: number): PhotoEntity | null {
  // 从上层到下层遍历
  const sorted = [...store.sortedPhotos].reverse();
  for (const photo of sorted) {
    if (pointInPhoto(photo, x, y)) {
      return photo;
    }
  }
  return null;
}

// 查找点击的手柄
function findHandleAt(photo: PhotoEntity, x: number, y: number): Handle | null {
  const handles = getHandlePositions(photo);
  const hitRadius = 12 / viewport.value.scale;

  for (const { handle, x: hx, y: hy } of handles) {
    if (Math.abs(x - hx) <= hitRadius && Math.abs(y - hy) <= hitRadius) {
      return handle;
    }
  }
  return null;
}

// 指针事件处理
function handlePointerDown(e: PointerEvent) {
  const isMiddlePan = e.button === 1;
  const isSpacePan = isSpacePressed.value && e.button === 0;
  if (isMiddlePan || isSpacePan) {
    e.preventDefault();
    autoFit.value = false;
    pointerMode.value = {
      kind: "pan",
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffsetX: store.canvasOffsetX,
      startOffsetY: store.canvasOffsetY,
    };
    try {
      canvasEl.value?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    return;
  }

  if (e.button !== 0) return;

  const { x, y } = screenToCanvas(e.clientX, e.clientY);

  // 裁剪模式
  if (store.cropModePhotoId && cropDraft.value) {
    const photo = store.photos.find(p => p.id === store.cropModePhotoId);
    if (photo) {
      if (pointInCropArea(photo, x, y)) {
        pointerMode.value = {
          kind: "crop-move",
          id: photo.id,
          startX: x,
          startY: y,
          startCrop: { ...cropDraft.value },
        };
        return;
      }
    }
    return;
  }

  // 检查是否点击选中照片的手柄
  if (store.selectedPhoto) {
    const handle = findHandleAt(store.selectedPhoto, x, y);
    if (handle) {
      pointerMode.value = {
        kind: "resize",
        id: store.selectedPhoto.id,
        handle,
        startScale: store.selectedPhoto.scale,
        startX: x,
        startY: y,
      };
      return;
    }
  }

  // 查找点击的照片
  const photo = findPhotoAt(x, y);
  if (photo) {
    store.selectPhoto(photo.id);
    pointerMode.value = {
      kind: "drag",
      id: photo.id,
      dx: x - photo.cx,
      dy: y - photo.cy,
      startCx: photo.cx,
      startCy: photo.cy,
    };
  } else {
    store.selectPhoto(null);
  }
}

function handlePointerMove(e: PointerEvent) {
  const mode = pointerMode.value;
  if (mode.kind === "none") return;

  if (mode.kind === "pan") {
    const dx = e.clientX - mode.startClientX;
    const dy = e.clientY - mode.startClientY;
    store.setCanvasOffset(mode.startOffsetX + dx, mode.startOffsetY + dy);
    invalidateBaseLayer();
    invalidatePhotoLayer();
    requestRender();
    return;
  }

  const { x, y } = screenToCanvas(e.clientX, e.clientY);

  if (mode.kind === "drag") {
    const newCx = x - mode.dx;
    const newCy = y - mode.dy;
    store.updatePhoto(mode.id, { cx: newCx, cy: newCy });
  } else if (mode.kind === "resize") {
    const photo = store.photos.find(p => p.id === mode.id);
    if (!photo) return;

    const { startScale, startX, startY } = mode;
    const dist = Math.sqrt(
      Math.pow(x - photo.cx, 2) + Math.pow(y - photo.cy, 2),
    );
    const startDist = Math.sqrt(
      Math.pow(startX - photo.cx, 2) + Math.pow(startY - photo.cy, 2),
    );

    if (startDist > 10) {
      const newScale = clamp(startScale * (dist / startDist), 0.05, 3);
      store.updatePhoto(photo.id, { scale: newScale });
    }
  } else if (mode.kind === "crop-move" && cropDraft.value) {
    const dx = x - mode.startX;
    const dy = y - mode.startY;
    const photo = store.photos.find(p => p.id === mode.id);
    if (!photo) return;

    cropDraft.value = {
      ...mode.startCrop,
      // 拖动的是“照片内容”，因此 crop 方向与指针位移相反。
      x: clamp(
        mode.startCrop.x - dx / photo.scale,
        0,
        photo.imageWidth - mode.startCrop.width,
      ),
      y: clamp(
        mode.startCrop.y - dy / photo.scale,
        0,
        photo.imageHeight - mode.startCrop.height,
      ),
    };
    requestRender();
  }
}

function handlePointerUp() {
  const prev = pointerMode.value;
  pointerMode.value = { kind: "none" };

  if (prev.kind === "pan") {
    try {
      if (canvasEl.value?.hasPointerCapture(prev.pointerId)) {
        canvasEl.value.releasePointerCapture(prev.pointerId);
      }
    } catch {
      // ignore
    }
    return;
  }

  if (prev.kind === "drag") {
    const photo = store.photos.find(p => p.id === prev.id);
    if (!photo) return;
    if (photo.cx !== prev.startCx || photo.cy !== prev.startCy) {
      store.pushPhotoHistoryFromPartials(
        prev.id,
        "拖动",
        { cx: prev.startCx, cy: prev.startCy },
        { cx: photo.cx, cy: photo.cy },
      );
    }
    return;
  }

  if (prev.kind === "resize") {
    const photo = store.photos.find(p => p.id === prev.id);
    if (!photo) return;
    if (photo.scale !== prev.startScale) {
      store.pushPhotoHistoryFromPartials(
        prev.id,
        "缩放",
        { scale: prev.startScale },
        { scale: photo.scale },
      );
    }
  }
}

function getCropFrame(photo: PhotoEntity): CropRect {
  const reference = store.getCropModeReferenceCrop(photo.id);
  if (reference) return reference;
  if (cropDraft.value) return cropDraft.value;
  return { x: 0, y: 0, width: photo.imageWidth, height: photo.imageHeight };
}

function getCropFrameHalfSize(photo: PhotoEntity): { hw: number; hh: number } {
  const frame = getCropFrame(photo);
  return {
    hw: (frame.width * photo.scale) / 2,
    hh: (frame.height * photo.scale) / 2,
  };
}

function pointInCropArea(
  photo: PhotoEntity,
  canvasX: number,
  canvasY: number,
): boolean {
  if (!cropDraft.value) return false;

  const dx = canvasX - photo.cx;
  const dy = canvasY - photo.cy;
  const local = inverseRotatePoint(dx, dy, photo.rotation);
  const cropRect = getCropFrameHalfSize(photo);
  return Math.abs(local.x) <= cropRect.hw && Math.abs(local.y) <= cropRect.hh;
}

// 键盘事件
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.code === "Space" && !isTypingTarget(e.target)) {
    if (!isSpacePressed.value) {
      isSpacePressed.value = true;
      requestRender();
    }
    e.preventDefault();
  }

  // 裁剪撤销/重做（无论是否在裁剪模式，都可用）
  const key = e.key.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && key === "z" && !e.shiftKey) {
    e.preventDefault();
    store.undo();
    return;
  }
  if (mod && ((key === "z" && e.shiftKey) || key === "y")) {
    e.preventDefault();
    store.redo();
    return;
  }

  if (store.cropModePhotoId) {
    if (e.key === "Enter") {
      applyCrop();
    } else if (e.key === "Escape") {
      cancelCrop();
    }
    return;
  }

  if (store.selectedPhotoId && (e.key === "Delete" || e.key === "Backspace")) {
    store.removePhoto(store.selectedPhotoId);
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (e.code !== "Space") return;
  if (isSpacePressed.value) {
    isSpacePressed.value = false;
    requestRender();
  }
}

function applyCrop() {
  if (!store.cropModePhotoId || !cropDraft.value) return;

  const photo = store.photos.find(p => p.id === store.cropModePhotoId);
  if (!photo) return;

  store.applyCropLocal(photo.id, { ...cropDraft.value });
  store.commitCropMode();
  toast.success("裁剪已应用");
}

function cancelCrop() {
  store.cancelCropMode();
  toast.info("已取消裁剪");
}

// 渲染
function requestRender() {
  if (rafId.value != null) return;
  rafId.value = requestAnimationFrame(() => {
    rafId.value = null;
    draw();
  });
}

function draw() {
  if (!ctx.value || !canvasEl.value) return;

  const c = ctx.value;
  const { scale, dpr, cssWidth, cssHeight } = viewport.value;
  const translate = getCanvasTranslate();

  ensureLayerSizes();

  // Base layer: background + canvas boundary + grid
  if (baseLayerDirty.value) rebuildBaseLayer();

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssWidth, cssHeight);

  const l = ensureLayers();
  if (l) {
    c.drawImage(l.base, 0, 0, cssWidth, cssHeight);
  }

  const interactive =
    pointerMode.value.kind !== "none" || Boolean(store.cropModePhotoId);
  const shouldProgressive =
    !interactive && store.photoCount >= PROGRESSIVE_PHOTO_THRESHOLD;

  if (shouldProgressive && l) {
    renderPhotoLayerBatch();
    c.drawImage(l.photos, 0, 0, cssWidth, cssHeight);
  } else {
    // Immediate draw (interaction mode or small photo count)
    c.save();
    c.translate(translate.x, translate.y);
    c.scale(scale, scale);
    for (const photo of store.sortedPhotos) {
      drawPhoto(c, photo);
    }
    c.restore();
  }

  // Overlays always drawn on top
  c.save();
  c.translate(translate.x, translate.y);
  c.scale(scale, scale);
  if (store.selectedPhoto && !store.cropModePhotoId) {
    drawSelection(c, store.selectedPhoto);
  }
  if (store.cropModePhoto && cropDraft.value) {
    drawCropOverlay(c, store.cropModePhoto);
  }
  c.restore();

  if (shouldProgressive && photoLayerState.value.inProgress) {
    requestRender();
  }
}

function drawGrid(c: CanvasRenderingContext2D) {
  const pattern = ensureGridPattern(c);
  if (pattern) {
    c.save();
    c.fillStyle = pattern;
    c.fillRect(0, 0, store.canvasWidth, store.canvasHeight);
    c.restore();
    return;
  }

  // Fallback: old per-line drawing (should be rare)
  const gridSize = 100;
  c.strokeStyle = "rgba(255, 255, 255, 0.03)";
  c.lineWidth = 1;

  for (let x = 0; x <= store.canvasWidth; x += gridSize) {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, store.canvasHeight);
    c.stroke();
  }

  for (let y = 0; y <= store.canvasHeight; y += gridSize) {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(store.canvasWidth, y);
    c.stroke();
  }
}

function drawPhoto(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  c.save();
  c.translate(photo.cx, photo.cy);
  c.rotate(photo.rotation);
  const f = buildCanvasFilter(photo.adjustments);
  c.filter = f === "none" ? "none" : f;

  if (store.cropModePhotoId === photo.id && cropDraft.value) {
    const frame = getCropFrame(photo);
    const source = cropDraft.value;
    const frameW = frame.width * photo.scale;
    const frameH = frame.height * photo.scale;
    const fullW = photo.imageWidth * photo.scale;
    const fullH = photo.imageHeight * photo.scale;
    const drawX = -frameW / 2 - source.x * photo.scale;
    const drawY = -frameH / 2 - source.y * photo.scale;

    c.drawImage(
      photo.image,
      0,
      0,
      photo.imageWidth,
      photo.imageHeight,
      drawX,
      drawY,
      fullW,
      fullH,
    );
  } else {
    const crop = photo.layoutCrop ?? photo.crop;
    const { hw, hh } = getDrawHalfSize(photo, crop);
    c.drawImage(
      photo.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      -hw,
      -hh,
      hw * 2,
      hh * 2,
    );
  }

  c.restore();
}

function drawSelection(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  c.save();
  c.translate(photo.cx, photo.cy);
  c.rotate(photo.rotation);

  const { hw, hh } = getDrawHalfSize(photo);

  // 绘制边框
  c.strokeStyle = "#6366f1";
  c.lineWidth = 2 / viewport.value.scale;
  c.strokeRect(-hw, -hh, hw * 2, hh * 2);

  // 绘制手柄
  const handleSize = 10 / viewport.value.scale;
  c.fillStyle = "#ffffff";
  c.strokeStyle = "#6366f1";

  const positions = [
    { x: -hw, y: -hh },
    { x: 0, y: -hh },
    { x: hw, y: -hh },
    { x: -hw, y: 0 },
    { x: hw, y: 0 },
    { x: -hw, y: hh },
    { x: 0, y: hh },
    { x: hw, y: hh },
  ];

  for (const pos of positions) {
    c.fillRect(
      pos.x - handleSize / 2,
      pos.y - handleSize / 2,
      handleSize,
      handleSize,
    );
    c.strokeRect(
      pos.x - handleSize / 2,
      pos.y - handleSize / 2,
      handleSize,
      handleSize,
    );
  }

  c.restore();
}

function drawCropOverlay(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  if (!cropDraft.value) return;

  c.save();
  c.translate(photo.cx, photo.cy);
  c.rotate(photo.rotation);

  const cropRect = getCropFrameHalfSize(photo);

  // 暗化裁剪框外部区域，保留裁剪框内照片内容可见。
  // 使用 evenodd clip 代替 destination-out，避免清除裁剪框内已绘制的照片像素。
  c.save();
  c.beginPath();
  c.rect(-100000, -100000, 200000, 200000);
  c.rect(-cropRect.hw, -cropRect.hh, cropRect.hw * 2, cropRect.hh * 2);
  c.clip("evenodd");
  c.fillStyle = "rgba(0, 0, 0, 0.5)";
  c.fillRect(-100000, -100000, 200000, 200000);
  c.restore();

  // 绘制裁剪边框
  c.strokeStyle = "#6366f1";
  c.lineWidth = 2 / viewport.value.scale;
  c.setLineDash([5 / viewport.value.scale, 5 / viewport.value.scale]);
  c.strokeRect(-cropRect.hw, -cropRect.hh, cropRect.hw * 2, cropRect.hh * 2);
  c.setLineDash([]);

  c.restore();
}
</script>

<style scoped>
.canvas-stage {
  position: relative;
}

.canvas-stage__body {
  cursor: crosshair;
}

.canvas-stage__body canvas {
  display: block;
}

.canvas-stage__body--pan-ready {
  cursor: grab;
}

.canvas-stage__body--panning {
  cursor: grabbing;
}

.crop-hint {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.5rem;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 0.75rem;
  color: white;
  font-size: 0.875rem;
  z-index: 10;
}

.crop-hint__actions {
  display: flex;
  gap: 0.5rem;
}
</style>
