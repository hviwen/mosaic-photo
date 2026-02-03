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
            title="缩小"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <span class="zoom-control__value">{{ zoomPercent }}%</span>
          <button 
            class="btn btn--ghost btn--icon"
            @click="zoomIn"
            title="放大"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
          title="适应窗口"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
          </svg>
          适应
        </button>
      </div>
    </div>

    <div 
      ref="stageBody"
      class="canvas-stage__body"
      @wheel.prevent="handleWheel"
    >
      <canvas
        ref="canvasEl"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointerleave="handlePointerUp"
      />
    </div>

    <!-- 裁剪模式提示 -->
    <Transition name="fade">
      <div v-if="store.cropModePhotoId" class="crop-hint">
        <span>裁剪模式 - 拖动调整区域</span>
        <div class="crop-hint__actions">
          <button class="btn btn--success btn--sm" @click="applyCrop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="20,6 9,17 4,12" />
            </svg>
            确认
          </button>
          <button class="btn btn--secondary btn--sm" @click="cancelCrop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
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
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useMosaicStore } from '@/stores/mosaic'
import { useToastStore } from '@/stores/toast'
import type { PhotoEntity, Handle, CropRect, Viewport } from '@/types'
import { 
  clamp, 
  rotatePoint, 
  inverseRotatePoint, 
  getDrawHalfSize,
  getHandlePositions,
  pointInPhoto
} from '@/utils/math'
import { buildCanvasFilter } from '@/utils/filters'

const store = useMosaicStore()
const toast = useToastStore()

const stageBody = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const ctx = ref<CanvasRenderingContext2D | null>(null)
const resizeObserver = ref<ResizeObserver | null>(null)

const viewport = ref<Viewport>({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dpr: 1,
  cssWidth: 800,
  cssHeight: 600
})

// 默认保持“自适应填充”模式；当用户手动缩放后，停止自动重算缩放比例
const autoFit = ref(true)

const zoomPercent = computed(() => Math.round(viewport.value.scale * 100))

// 拖拽状态
type PointerMode = 
  | { kind: 'none' }
  | { kind: 'drag'; id: string; dx: number; dy: number; startCx: number; startCy: number }
  | { kind: 'resize'; id: string; handle: Handle; startScale: number; startX: number; startY: number }
  | { kind: 'crop-move'; id: string; startX: number; startY: number; startCrop: CropRect }
  | { kind: 'crop-resize'; id: string; handle: Handle; startX: number; startY: number; startCrop: CropRect }

const pointerMode = ref<PointerMode>({ kind: 'none' })
const cropDraft = ref<CropRect | null>(null)
const rafId = ref<number | null>(null)

// 初始化
onMounted(() => {
  if (!canvasEl.value) return
  ctx.value = canvasEl.value.getContext('2d')

  // Prefer ResizeObserver over window resize (sidebar width changes, etc.)
  if (stageBody.value && 'ResizeObserver' in window) {
    resizeObserver.value = new ResizeObserver(() => {
      handleResize({ preserveScale: !autoFit.value })
    })
    resizeObserver.value.observe(stageBody.value)
  } else {
    window.addEventListener('resize', handleResize)
  }

  // First layout pass after DOM is ready
  nextTick(() => {
    handleResize({ preserveScale: false })
  })
  window.addEventListener('keydown', handleKeyDown)
  requestRender()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', handleKeyDown)
  if (resizeObserver.value) {
    resizeObserver.value.disconnect()
    resizeObserver.value = null
  }
  if (rafId.value) cancelAnimationFrame(rafId.value)
})

// 监听状态变化
watch(
  () => [store.photos, store.selectedPhotoId, store.cropModePhotoId, store.canvasWidth, store.canvasHeight],
  () => requestRender(),
  { deep: true }
)

watch(
  () => [store.canvasWidth, store.canvasHeight],
  async () => {
    // Canvas size changed (preset/custom): refit to viewport.
    await nextTick()
    autoFit.value = true
    handleResize({ preserveScale: false })
  }
)

watch(
  () => store.cropModePhotoId,
  (id) => {
    if (id) {
      const photo = store.photos.find(p => p.id === id)
      cropDraft.value = photo ? { ...photo.crop } : null
    } else {
      cropDraft.value = null
    }
    requestRender()
  }
)

// 响应式调整大小
function computeFitViewport(cssWidth: number, cssHeight: number) {
  const padding = 32
  const safeW = Math.max(1, cssWidth - padding * 2)
  const safeH = Math.max(1, cssHeight - padding * 2)
  const scale = Math.min(safeW / store.canvasWidth, safeH / store.canvasHeight)
  const clampedScale = clamp(scale, 0.02, 2)

  const offsetX = (cssWidth - store.canvasWidth * clampedScale) / 2
  const offsetY = (cssHeight - store.canvasHeight * clampedScale) / 2
  return { scale: clampedScale, offsetX, offsetY }
}

function handleResize(opts?: { preserveScale?: boolean } | UIEvent) {
  if (!stageBody.value || !canvasEl.value) return

  const styles = window.getComputedStyle(stageBody.value)
  const padX =
    parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
  const padY =
    parseFloat(styles.paddingTop || '0') + parseFloat(styles.paddingBottom || '0')

  // Content-box size (exclude padding)
  const cssWidth = Math.max(200, Math.floor(stageBody.value.clientWidth - padX))
  const cssHeight = Math.max(200, Math.floor(stageBody.value.clientHeight - padY))
  const dpr = Math.max(1, window.devicePixelRatio || 1)

  canvasEl.value.style.width = `${cssWidth}px`
  canvasEl.value.style.height = `${cssHeight}px`
  canvasEl.value.width = Math.floor(cssWidth * dpr)
  canvasEl.value.height = Math.floor(cssHeight * dpr)

  const preserveScale =
    typeof opts === 'object' && opts != null && 'preserveScale' in opts
      ? Boolean((opts as { preserveScale?: boolean }).preserveScale)
      : false
  const next = preserveScale
    ? {
        scale: viewport.value.scale,
        offsetX: (cssWidth - store.canvasWidth * viewport.value.scale) / 2,
        offsetY: (cssHeight - store.canvasHeight * viewport.value.scale) / 2,
      }
    : computeFitViewport(cssWidth, cssHeight)

  viewport.value = { ...next, dpr, cssWidth, cssHeight }
  requestRender()
}

function fitToView() {
  autoFit.value = true
  handleResize({ preserveScale: false })
}

function zoomIn() {
  autoFit.value = false
  viewport.value.scale = Math.min(viewport.value.scale * 1.2, 2)
  recenterViewport()
  requestRender()
}

function zoomOut() {
  autoFit.value = false
  viewport.value.scale = Math.max(viewport.value.scale / 1.2, 0.02)
  recenterViewport()
  requestRender()
}

function recenterViewport() {
  const { cssWidth, cssHeight, scale } = viewport.value
  viewport.value.offsetX = (cssWidth - store.canvasWidth * scale) / 2
  viewport.value.offsetY = (cssHeight - store.canvasHeight * scale) / 2
}

function handleWheel(e: WheelEvent) {
  autoFit.value = false
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  viewport.value.scale = clamp(viewport.value.scale * delta, 0.02, 2)
  recenterViewport()
  requestRender()
}

// 坐标转换
function screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
  const { scale, offsetX, offsetY } = viewport.value
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  
  const x = (screenX - rect.left - offsetX) / scale
  const y = (screenY - rect.top - offsetY) / scale
  return { x, y }
}

// 查找点击的照片
function findPhotoAt(x: number, y: number): PhotoEntity | null {
  // 从上层到下层遍历
  const sorted = [...store.sortedPhotos].reverse()
  for (const photo of sorted) {
    if (pointInPhoto(photo, x, y)) {
      return photo
    }
  }
  return null
}

// 查找点击的手柄
function findHandleAt(photo: PhotoEntity, x: number, y: number): Handle | null {
  const handles = getHandlePositions(photo)
  const hitRadius = 12 / viewport.value.scale
  
  for (const { handle, x: hx, y: hy } of handles) {
    if (Math.abs(x - hx) <= hitRadius && Math.abs(y - hy) <= hitRadius) {
      return handle
    }
  }
  return null
}

// 指针事件处理
function handlePointerDown(e: PointerEvent) {
  const { x, y } = screenToCanvas(e.clientX, e.clientY)
  
  // 裁剪模式
  if (store.cropModePhotoId && cropDraft.value) {
    const photo = store.photos.find(p => p.id === store.cropModePhotoId)
    if (photo) {
      // 检查是否点击裁剪手柄或区域
      const handle = findCropHandleAt(photo, x, y)
      if (handle) {
        pointerMode.value = {
          kind: 'crop-resize',
          id: photo.id,
          handle,
          startX: x,
          startY: y,
          startCrop: { ...cropDraft.value }
        }
        return
      }
      
      if (pointInCropArea(photo, x, y)) {
        pointerMode.value = {
          kind: 'crop-move',
          id: photo.id,
          startX: x,
          startY: y,
          startCrop: { ...cropDraft.value }
        }
        return
      }
    }
    return
  }

  // 检查是否点击选中照片的手柄
  if (store.selectedPhoto) {
    const handle = findHandleAt(store.selectedPhoto, x, y)
    if (handle) {
      pointerMode.value = {
        kind: 'resize',
        id: store.selectedPhoto.id,
        handle,
        startScale: store.selectedPhoto.scale,
        startX: x,
        startY: y
      }
      return
    }
  }

  // 查找点击的照片
  const photo = findPhotoAt(x, y)
  if (photo) {
    store.selectPhoto(photo.id)
    pointerMode.value = {
      kind: 'drag',
      id: photo.id,
      dx: x - photo.cx,
      dy: y - photo.cy,
      startCx: photo.cx,
      startCy: photo.cy,
    }
  } else {
    store.selectPhoto(null)
  }
}

function handlePointerMove(e: PointerEvent) {
  const mode = pointerMode.value
  if (mode.kind === 'none') return
  
  const { x, y } = screenToCanvas(e.clientX, e.clientY)
  
  if (mode.kind === 'drag') {
    const newCx = x - mode.dx
    const newCy = y - mode.dy
    store.updatePhoto(mode.id, { cx: newCx, cy: newCy })
  } else if (mode.kind === 'resize') {
    const photo = store.photos.find(p => p.id === mode.id)
    if (!photo) return
    
    const { startScale, startX, startY } = mode
    const dist = Math.sqrt(
      Math.pow(x - photo.cx, 2) + Math.pow(y - photo.cy, 2)
    )
    const startDist = Math.sqrt(
      Math.pow(startX - photo.cx, 2) + Math.pow(startY - photo.cy, 2)
    )
    
    if (startDist > 10) {
      const newScale = clamp(startScale * (dist / startDist), 0.05, 3)
      store.updatePhoto(photo.id, { scale: newScale })
    }
  } else if (mode.kind === 'crop-move' && cropDraft.value) {
    const dx = x - mode.startX
    const dy = y - mode.startY
    const photo = store.photos.find(p => p.id === mode.id)
    if (!photo) return
    
    cropDraft.value = {
      ...mode.startCrop,
      x: clamp(mode.startCrop.x + dx / photo.scale, 0, photo.imageWidth - mode.startCrop.width),
      y: clamp(mode.startCrop.y + dy / photo.scale, 0, photo.imageHeight - mode.startCrop.height)
    }
    requestRender()
  } else if (mode.kind === 'crop-resize' && cropDraft.value) {
    const photo = store.photos.find(p => p.id === mode.id)
    if (!photo) return
    
    const dx = (x - mode.startX) / photo.scale
    const dy = (y - mode.startY) / photo.scale
    const { handle, startCrop } = mode
    
    let newCrop = { ...startCrop }
    
    if (handle.includes('w')) {
      const newX = clamp(startCrop.x + dx, 0, startCrop.x + startCrop.width - 50)
      newCrop.width = startCrop.width - (newX - startCrop.x)
      newCrop.x = newX
    }
    if (handle.includes('e')) {
      newCrop.width = clamp(startCrop.width + dx, 50, photo.imageWidth - startCrop.x)
    }
    if (handle.includes('n')) {
      const newY = clamp(startCrop.y + dy, 0, startCrop.y + startCrop.height - 50)
      newCrop.height = startCrop.height - (newY - startCrop.y)
      newCrop.y = newY
    }
    if (handle.includes('s')) {
      newCrop.height = clamp(startCrop.height + dy, 50, photo.imageHeight - startCrop.y)
    }
    
    cropDraft.value = newCrop
    requestRender()
  }
}

function handlePointerUp() {
  const prev = pointerMode.value
  pointerMode.value = { kind: 'none' }

  if (prev.kind === 'drag') {
    const photo = store.photos.find(p => p.id === prev.id)
    if (!photo) return
    if (photo.cx !== prev.startCx || photo.cy !== prev.startCy) {
      store.pushPhotoHistoryFromPartials(
        prev.id,
        '拖动',
        { cx: prev.startCx, cy: prev.startCy },
        { cx: photo.cx, cy: photo.cy }
      )
    }
    return
  }

  if (prev.kind === 'resize') {
    const photo = store.photos.find(p => p.id === prev.id)
    if (!photo) return
    if (photo.scale !== prev.startScale) {
      store.pushPhotoHistoryFromPartials(
        prev.id,
        '缩放',
        { scale: prev.startScale },
        { scale: photo.scale }
      )
    }
  }
}

function findCropHandleAt(photo: PhotoEntity, canvasX: number, canvasY: number): Handle | null {
  if (!cropDraft.value) return null
  
  const { hw, hh } = getDrawHalfSize(photo, cropDraft.value)
  const handles: Handle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']
  const hitRadius = 15 / viewport.value.scale
  
  for (const handle of handles) {
    let lx = 0, ly = 0
    if (handle.includes('w')) lx = -hw
    if (handle.includes('e')) lx = hw
    if (handle.includes('n')) ly = -hh
    if (handle.includes('s')) ly = hh
    
    const rotated = rotatePoint(lx, ly, photo.rotation)
    const hx = photo.cx + rotated.x
    const hy = photo.cy + rotated.y
    
    if (Math.abs(canvasX - hx) <= hitRadius && Math.abs(canvasY - hy) <= hitRadius) {
      return handle
    }
  }
  return null
}

function pointInCropArea(photo: PhotoEntity, canvasX: number, canvasY: number): boolean {
  if (!cropDraft.value) return false
  
  const dx = canvasX - photo.cx
  const dy = canvasY - photo.cy
  const local = inverseRotatePoint(dx, dy, photo.rotation)
  const { hw, hh } = getDrawHalfSize(photo, cropDraft.value)
  
  return Math.abs(local.x) <= hw && Math.abs(local.y) <= hh
}

// 键盘事件
function handleKeyDown(e: KeyboardEvent) {
  // 裁剪撤销/重做（无论是否在裁剪模式，都可用）
  const key = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault()
    store.undo()
    return
  }
  if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
    e.preventDefault()
    store.redo()
    return
  }

  if (store.cropModePhotoId) {
    if (e.key === 'Enter') {
      applyCrop()
    } else if (e.key === 'Escape') {
      cancelCrop()
    }
    return
  }
  
  if (store.selectedPhotoId && (e.key === 'Delete' || e.key === 'Backspace')) {
    store.removePhoto(store.selectedPhotoId)
  }
}

function applyCrop() {
  if (!store.cropModePhotoId || !cropDraft.value) return
  
  const photo = store.photos.find(p => p.id === store.cropModePhotoId)
  if (!photo) return

  store.applyCrop(photo.id, { ...cropDraft.value })
  store.setCropMode(null)
  toast.success('裁剪已应用')
}

function cancelCrop() {
  store.setCropMode(null)
  toast.info('已取消裁剪')
}

// 渲染
function requestRender() {
  if (rafId.value != null) return
  rafId.value = requestAnimationFrame(() => {
    rafId.value = null
    draw()
  })
}

function draw() {
  if (!ctx.value || !canvasEl.value) return
  
  const c = ctx.value
  const { scale, offsetX, offsetY, dpr, cssWidth, cssHeight } = viewport.value
  
  // 清空画布
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, cssWidth, cssHeight)
  
  // 绘制背景
  const rootStyles = window.getComputedStyle(document.documentElement)
  const bg = rootStyles.getPropertyValue('--canvas-bg').trim() || '#1a1a2e'
  const innerBg = rootStyles.getPropertyValue('--canvas-inner-bg').trim() || '#2a2a3e'

  c.fillStyle = bg
  c.fillRect(0, 0, cssWidth, cssHeight)
  
  // 应用视口变换
  c.save()
  c.translate(offsetX, offsetY)
  c.scale(scale, scale)
  
  // 绘制画布边界
  c.fillStyle = innerBg
  c.fillRect(0, 0, store.canvasWidth, store.canvasHeight)
  
  // 绘制网格
  drawGrid(c)
  
  // 绘制照片
  for (const photo of store.sortedPhotos) {
    drawPhoto(c, photo)
  }
  
  // 绘制选中框
  if (store.selectedPhoto && !store.cropModePhotoId) {
    drawSelection(c, store.selectedPhoto)
  }
  
  // 绘制裁剪框
  if (store.cropModePhoto && cropDraft.value) {
    drawCropOverlay(c, store.cropModePhoto)
  }
  
  c.restore()
}

function drawGrid(c: CanvasRenderingContext2D) {
  const gridSize = 100
  c.strokeStyle = 'rgba(255, 255, 255, 0.03)'
  c.lineWidth = 1
  
  for (let x = 0; x <= store.canvasWidth; x += gridSize) {
    c.beginPath()
    c.moveTo(x, 0)
    c.lineTo(x, store.canvasHeight)
    c.stroke()
  }
  
  for (let y = 0; y <= store.canvasHeight; y += gridSize) {
    c.beginPath()
    c.moveTo(0, y)
    c.lineTo(store.canvasWidth, y)
    c.stroke()
  }
}

function drawPhoto(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  c.save()
  c.translate(photo.cx, photo.cy)
  c.rotate(photo.rotation)
  c.filter = buildCanvasFilter(photo.adjustments)
  
  const crop = store.cropModePhotoId === photo.id
    ? photo.crop
    : (photo.layoutCrop ?? photo.crop)
  
  const { hw, hh } = getDrawHalfSize(photo, crop)
  
  c.drawImage(
    photo.image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -hw,
    -hh,
    hw * 2,
    hh * 2
  )
  
  c.restore()
}

function drawSelection(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  c.save()
  c.translate(photo.cx, photo.cy)
  c.rotate(photo.rotation)
  
  const { hw, hh } = getDrawHalfSize(photo)
  
  // 绘制边框
  c.strokeStyle = '#6366f1'
  c.lineWidth = 2 / viewport.value.scale
  c.strokeRect(-hw, -hh, hw * 2, hh * 2)
  
  // 绘制手柄
  const handleSize = 10 / viewport.value.scale
  c.fillStyle = '#ffffff'
  c.strokeStyle = '#6366f1'
  
  const positions = [
    { x: -hw, y: -hh }, { x: 0, y: -hh }, { x: hw, y: -hh },
    { x: -hw, y: 0 }, { x: hw, y: 0 },
    { x: -hw, y: hh }, { x: 0, y: hh }, { x: hw, y: hh }
  ]
  
  for (const pos of positions) {
    c.fillRect(pos.x - handleSize / 2, pos.y - handleSize / 2, handleSize, handleSize)
    c.strokeRect(pos.x - handleSize / 2, pos.y - handleSize / 2, handleSize, handleSize)
  }
  
  c.restore()
}

function drawCropOverlay(c: CanvasRenderingContext2D, photo: PhotoEntity) {
  if (!cropDraft.value) return
  
  c.save()
  c.translate(photo.cx, photo.cy)
  c.rotate(photo.rotation)
  
  const { hw, hh } = getDrawHalfSize(photo, photo.crop)
  const cropHw = (cropDraft.value.width * photo.scale) / 2
  const cropHh = (cropDraft.value.height * photo.scale) / 2
  
  // 绘制暗化区域
  c.fillStyle = 'rgba(0, 0, 0, 0.5)'
  c.fillRect(-hw, -hh, hw * 2, hh * 2)
  
  // 清除裁剪区域
  c.globalCompositeOperation = 'destination-out'
  c.fillStyle = 'white'
  c.fillRect(-cropHw, -cropHh, cropHw * 2, cropHh * 2)
  c.globalCompositeOperation = 'source-over'
  
  // 绘制裁剪边框
  c.strokeStyle = '#6366f1'
  c.lineWidth = 2 / viewport.value.scale
  c.setLineDash([5 / viewport.value.scale, 5 / viewport.value.scale])
  c.strokeRect(-cropHw, -cropHh, cropHw * 2, cropHh * 2)
  c.setLineDash([])
  
  // 绘制裁剪手柄
  const handleSize = 12 / viewport.value.scale
  c.fillStyle = '#ffffff'
  c.strokeStyle = '#6366f1'
  c.lineWidth = 2 / viewport.value.scale
  
  const handles = [
    { x: -cropHw, y: -cropHh },
    { x: cropHw, y: -cropHh },
    { x: -cropHw, y: cropHh },
    { x: cropHw, y: cropHh },
    { x: 0, y: -cropHh },
    { x: 0, y: cropHh },
    { x: -cropHw, y: 0 },
    { x: cropHw, y: 0 }
  ]
  
  for (const h of handles) {
    c.beginPath()
    c.arc(h.x, h.y, handleSize / 2, 0, Math.PI * 2)
    c.fill()
    c.stroke()
  }
  
  c.restore()
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
