import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PhotoEntity, CanvasPreset, ExportFormat, ExportResolutionPreset, CropRect, AppMode, Placement, PhotoAdjustments } from '@/types'
import { fillArrangePhotos } from '@/composables/useLayout'
import { clampPhotoToCanvas, clampCrop, clamp } from '@/utils/math'
import { centerCropToAspect, createPhotoFromFile } from '@/utils/image'
import { getSmartDetections, invalidateSmartDetections, onSmartDetectionsChanged, prefetchSmartDetections } from '@/utils/smartCrop'

const PRESETS: CanvasPreset[] = [
  { id: '40x50', label: '40cm × 50cm', width: 4724, height: 5906 },
  { id: '40x60', label: '40cm × 60cm', width: 4724, height: 7087 },
  { id: '50x70', label: '50cm × 70cm', width: 5906, height: 8268 },
  { id: '60x80', label: '60cm × 80cm', width: 7087, height: 9449 },
  { id: '60x90', label: '60cm × 90cm', width: 7087, height: 10630 },
  { id: 'custom', label: '自定义尺寸', width: 4000, height: 4000 },
]

export const useMosaicStore = defineStore('mosaic', () => {
  type PhotoCoreSnapshot = {
    id: string
    cx: number
    cy: number
    scale: number
    rotation: number
    zIndex: number
    crop: CropRect
    layoutCrop?: CropRect
    adjustments: PhotoAdjustments
  }

  type PhotoFullSnapshot = PhotoCoreSnapshot & {
    name: string
    srcUrl: string
    image: HTMLCanvasElement
    imageWidth: number
    imageHeight: number
  }

  type CanvasSnapshot = PhotoCoreSnapshot[]

  type HistoryEntry =
    | {
        id: string
        at: number
        label: string
        kind: 'photo'
        photoId: string
        before: PhotoCoreSnapshot
        after: PhotoCoreSnapshot
      }
    | {
        id: string
        at: number
        label: string
        kind: 'photoFull'
        photoId: string
        before: PhotoFullSnapshot
        after: PhotoFullSnapshot
      }
    | {
        id: string
        at: number
        label: string
        kind: 'canvas'
        before: CanvasSnapshot
        after: CanvasSnapshot
      }

  const HISTORY_LIMIT = 80

  // State
  const presets = ref<CanvasPreset[]>(PRESETS)
  const currentPresetId = ref<string>('40x50')
  const canvasWidth = ref<number>(PRESETS[0].width)
  const canvasHeight = ref<number>(PRESETS[0].height)
  const photos = ref<PhotoEntity[]>([])
  const selectedPhotoId = ref<string | null>(null)
  const cropModePhotoId = ref<string | null>(null)
  const exportFormat = ref<ExportFormat>('png')
  const exportQuality = ref<number>(0.95)
  const exportResolution = ref<ExportResolutionPreset>('original')
  const isExporting = ref<boolean>(false)
  const mode = ref<AppMode>({ kind: 'idle' })

  // 智能裁剪检测结果到达后，尽可能只更新 layoutCrop（不改变位置/缩放），避免“跳动”
  onSmartDetectionsChanged(photoId => {
    if (mode.value.kind !== 'idle') return
    const photo = photos.value.find(p => p.id === photoId)
    if (!photo?.layoutCrop) return
    const ta = photo.layoutCrop.width / Math.max(1, photo.layoutCrop.height)
    const next = centerCropToAspect(photo.crop, ta, photo.imageWidth, photo.imageHeight, {
      detections: getSmartDetections(photoId),
    })
    photo.layoutCrop = clampCrop(next, photo.imageWidth, photo.imageHeight)
  })

  // 操作历史（撤销/重做）
  const historyUndoStack = ref<HistoryEntry[]>([])
  const historyRedoStack = ref<HistoryEntry[]>([])

  // Computed
  const currentPreset = computed(() => 
    presets.value.find(p => p.id === currentPresetId.value)
  )

  const selectedPhoto = computed(() => 
    photos.value.find(p => p.id === selectedPhotoId.value)
  )

  const cropModePhoto = computed(() =>
    photos.value.find(p => p.id === cropModePhotoId.value)
  )

  const photoCount = computed(() => photos.value.length)

  const sortedPhotos = computed(() => 
    [...photos.value].sort((a, b) => a.zIndex - b.zIndex)
  )

  const canUndo = computed(() => historyUndoStack.value.length > 0)
  const canRedo = computed(() => historyRedoStack.value.length > 0)
  const history = computed(() => historyUndoStack.value)

  function snapshotCropRect(crop: CropRect): CropRect {
    return { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
  }

  function snapshotAdjustments(a: PhotoAdjustments): PhotoAdjustments {
    return {
      brightness: a.brightness,
      contrast: a.contrast,
      saturation: a.saturation,
      preset: a.preset,
    }
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
      layoutCrop: photo.layoutCrop ? snapshotCropRect(photo.layoutCrop) : undefined,
      adjustments: snapshotAdjustments(photo.adjustments),
    }
  }

  function snapshotPhotoFull(photo: PhotoEntity): PhotoFullSnapshot {
    return {
      ...snapshotPhotoCore(photo),
      name: photo.name,
      srcUrl: photo.srcUrl,
      image: photo.image,
      imageWidth: photo.imageWidth,
      imageHeight: photo.imageHeight,
    }
  }

  function snapshotCanvas(): CanvasSnapshot {
    return photos.value.map(snapshotPhotoCore)
  }

  function applyPhotoCoreSnapshot(photo: PhotoEntity, snap: PhotoCoreSnapshot) {
    photo.cx = snap.cx
    photo.cy = snap.cy
    photo.scale = snap.scale
    photo.rotation = snap.rotation
    photo.zIndex = snap.zIndex
    photo.crop = clampCrop(snapshotCropRect(snap.crop), photo.imageWidth, photo.imageHeight)
    photo.layoutCrop = snap.layoutCrop
      ? clampCrop(snapshotCropRect(snap.layoutCrop), photo.imageWidth, photo.imageHeight)
      : undefined
    photo.adjustments = snapshotAdjustments(snap.adjustments)
  }

  function applyPhotoFullSnapshot(photo: PhotoEntity, snap: PhotoFullSnapshot) {
    photo.name = snap.name
    photo.srcUrl = snap.srcUrl
    photo.image = snap.image
    photo.imageWidth = snap.imageWidth
    photo.imageHeight = snap.imageHeight
    applyPhotoCoreSnapshot(photo, snap)
  }

  function applyCanvasSnapshot(snap: CanvasSnapshot) {
    for (const s of snap) {
      const photo = photos.value.find(p => p.id === s.id)
      if (!photo) continue
      applyPhotoCoreSnapshot(photo, s)
    }
  }

  function pushHistory(entry: HistoryEntry) {
    historyUndoStack.value.push(entry)
    historyRedoStack.value = []
    if (historyUndoStack.value.length > HISTORY_LIMIT) {
      historyUndoStack.value.splice(0, historyUndoStack.value.length - HISTORY_LIMIT)
    }
  }

  type PhotoHistoryPartial = Partial<
    Pick<PhotoEntity, 'cx' | 'cy' | 'scale' | 'rotation' | 'zIndex' | 'crop' | 'layoutCrop' | 'adjustments'>
  >

  function toSnapshotCropMaybe(crop?: CropRect): CropRect | undefined {
    if (!crop) return undefined
    return snapshotCropRect(crop)
  }

  function toSnapshotAdjustmentsMaybe(a?: PhotoAdjustments): PhotoAdjustments | undefined {
    if (!a) return undefined
    return snapshotAdjustments(a)
  }

  function pushPhotoHistoryFromPartials(
    photoId: string,
    label: string,
    beforePartial: PhotoHistoryPartial,
    afterPartial: PhotoHistoryPartial
  ) {
    const photo = photos.value.find(p => p.id === photoId)
    if (!photo) return

    const base = snapshotPhotoCore(photo)

    const before: PhotoCoreSnapshot = {
      ...base,
      cx: beforePartial.cx ?? base.cx,
      cy: beforePartial.cy ?? base.cy,
      scale: beforePartial.scale ?? base.scale,
      rotation: beforePartial.rotation ?? base.rotation,
      zIndex: beforePartial.zIndex ?? base.zIndex,
      crop: toSnapshotCropMaybe(beforePartial.crop) ?? base.crop,
      layoutCrop: beforePartial.layoutCrop ? toSnapshotCropMaybe(beforePartial.layoutCrop) : base.layoutCrop,
      adjustments: toSnapshotAdjustmentsMaybe(beforePartial.adjustments) ?? base.adjustments,
    }

    const after: PhotoCoreSnapshot = {
      ...base,
      cx: afterPartial.cx ?? base.cx,
      cy: afterPartial.cy ?? base.cy,
      scale: afterPartial.scale ?? base.scale,
      rotation: afterPartial.rotation ?? base.rotation,
      zIndex: afterPartial.zIndex ?? base.zIndex,
      crop: toSnapshotCropMaybe(afterPartial.crop) ?? base.crop,
      layoutCrop: afterPartial.layoutCrop ? toSnapshotCropMaybe(afterPartial.layoutCrop) : base.layoutCrop,
      adjustments: toSnapshotAdjustmentsMaybe(afterPartial.adjustments) ?? base.adjustments,
    }

    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: 'photo',
      photoId,
      before,
      after,
    })
  }

  function undo() {
    const entry = historyUndoStack.value.pop()
    if (!entry) return

    if (entry.kind === 'photo') {
      const photo = photos.value.find(p => p.id === entry.photoId)
      if (photo) applyPhotoCoreSnapshot(photo, entry.before)
    } else if (entry.kind === 'photoFull') {
      const photo = photos.value.find(p => p.id === entry.photoId)
      if (photo) applyPhotoFullSnapshot(photo, entry.before)
    } else if (entry.kind === 'canvas') {
      applyCanvasSnapshot(entry.before)
    }

    historyRedoStack.value.push(entry)
  }

  function redo() {
    const entry = historyRedoStack.value.pop()
    if (!entry) return

    if (entry.kind === 'photo') {
      const photo = photos.value.find(p => p.id === entry.photoId)
      if (photo) applyPhotoCoreSnapshot(photo, entry.after)
    } else if (entry.kind === 'photoFull') {
      const photo = photos.value.find(p => p.id === entry.photoId)
      if (photo) applyPhotoFullSnapshot(photo, entry.after)
    } else if (entry.kind === 'canvas') {
      applyCanvasSnapshot(entry.after)
    }

    historyUndoStack.value.push(entry)
  }

  function clearHistory() {
    historyUndoStack.value = []
    historyRedoStack.value = []
  }

  // Actions
  function addPhoto(photo: PhotoEntity) {
    const maxZ = photos.value.reduce((max, p) => Math.max(max, p.zIndex), 0)
    photo.zIndex = maxZ + 1
    photos.value.push(photo)
    selectedPhotoId.value = photo.id
  }

  function removePhoto(id: string) {
    const index = photos.value.findIndex(p => p.id === id)
    if (index !== -1) {
      URL.revokeObjectURL(photos.value[index].srcUrl)
      invalidateSmartDetections(id)
      photos.value.splice(index, 1)
      if (selectedPhotoId.value === id) selectedPhotoId.value = null
      if (cropModePhotoId.value === id) cropModePhotoId.value = null
    }
  }

  function updatePhoto(id: string, patch: Partial<Omit<PhotoEntity, 'id' | 'image' | 'imageWidth' | 'imageHeight' | 'srcUrl' | 'name'>>) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return

    if (patch.crop) {
      photo.crop = clampCrop(patch.crop, photo.imageWidth, photo.imageHeight)
      photo.layoutCrop = undefined
    }

    if (patch.adjustments) {
      photo.adjustments = snapshotAdjustments(patch.adjustments)
    }

    if (patch.cx !== undefined || patch.cy !== undefined || 
        patch.scale !== undefined || patch.rotation !== undefined) {
      const updatedPhoto = { ...photo, ...patch }
      const clamped = clampPhotoToCanvas(
        updatedPhoto, 
        canvasWidth.value, 
        canvasHeight.value
      )
      photo.cx = patch.cx !== undefined ? clamped.cx : photo.cx
      photo.cy = patch.cy !== undefined ? clamped.cy : photo.cy
      photo.scale = patch.scale ?? photo.scale
      photo.rotation = patch.rotation ?? photo.rotation
    }

    if (patch.zIndex !== undefined) {
      photo.zIndex = patch.zIndex
    }
  }

  function updatePhotoWithHistory(
    id: string,
    patch: Partial<Omit<PhotoEntity, 'id' | 'image' | 'imageWidth' | 'imageHeight' | 'srcUrl' | 'name'>>,
    label: string
  ) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return
    const before = snapshotPhotoCore(photo)
    updatePhoto(id, patch)
    const after = snapshotPhotoCore(photo)
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: 'photo',
      photoId: id,
      before,
      after,
    })
  }

  function autoLayout() {
    if (photos.value.length === 0) return
    const placements = fillArrangePhotos(photos.value, canvasWidth.value, canvasHeight.value)
    applyPlacements(placements)
  }

  function autoLayoutWithHistory(label: string = '自动排版') {
    if (photos.value.length === 0) return
    const before = snapshotCanvas()
    autoLayout()
    const after = snapshotCanvas()
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: 'canvas',
      before,
      after,
    })
  }

  function applyPlacementsWithHistory(placements: Placement[], label: string) {
    if (photos.value.length === 0) return
    const before = snapshotCanvas()
    applyPlacements(placements)
    const after = snapshotCanvas()
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: 'canvas',
      before,
      after,
    })
  }

  function applyCrop(id: string, crop: CropRect, label: string = '裁剪') {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return

    const before = snapshotCanvas()
    photo.crop = clampCrop(crop, photo.imageWidth, photo.imageHeight)
    photo.layoutCrop = undefined
    // 裁剪后重新排版，自动更新位置和尺寸
    autoLayout()

    const after = snapshotCanvas()
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label,
      kind: 'canvas',
      before,
      after,
    })
  }

  function replacePhotoImage(
    id: string, 
    image: HTMLCanvasElement, 
    imageWidth: number, 
    imageHeight: number, 
    crop: CropRect
  ) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return
    invalidateSmartDetections(id)
    photo.image = image
    photo.imageWidth = imageWidth
    photo.imageHeight = imageHeight
    photo.crop = clampCrop(crop, imageWidth, imageHeight)
    photo.layoutCrop = undefined
    prefetchSmartDetections(id, image)
  }

  async function replacePhotoFromFile(id: string, file: File) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return

    const before = snapshotPhotoFull(photo)
    invalidateSmartDetections(id)
    const loaded = await createPhotoFromFile(file, canvasWidth.value, canvasHeight.value, { id })

    const effectiveCrop = photo.layoutCrop ?? photo.crop
    const targetAspect = effectiveCrop.width / Math.max(1, effectiveCrop.height)
    const fullCrop: CropRect = { x: 0, y: 0, width: loaded.imageWidth, height: loaded.imageHeight }
    const nextCrop = centerCropToAspect(fullCrop, targetAspect, loaded.imageWidth, loaded.imageHeight, {
      detections: getSmartDetections(id),
    })

    const oldDrawW = effectiveCrop.width * photo.scale
    const nextScale = clamp(oldDrawW / Math.max(1, nextCrop.width), 0.05, 3)

    photo.name = file.name
    photo.srcUrl = loaded.srcUrl
    photo.image = loaded.image
    photo.imageWidth = loaded.imageWidth
    photo.imageHeight = loaded.imageHeight

    if (photo.layoutCrop) {
      photo.crop = fullCrop
      photo.layoutCrop = nextCrop
    } else {
      photo.crop = nextCrop
      photo.layoutCrop = undefined
    }

    photo.scale = nextScale
    const clampedPos = clampPhotoToCanvas(photo, canvasWidth.value, canvasHeight.value)
    photo.cx = clampedPos.cx
    photo.cy = clampedPos.cy

    const after = snapshotPhotoFull(photo)
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: `替换照片：${before.name} → ${after.name}`,
      kind: 'photoFull',
      photoId: id,
      before,
      after,
    })
  }

  function setPhotoAdjustments(id: string, next: PhotoAdjustments) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return
    photo.adjustments = snapshotAdjustments(next)
  }

  function setPreset(presetId: string) {
    const preset = presets.value.find(p => p.id === presetId)
    if (!preset) return
    currentPresetId.value = presetId
    canvasWidth.value = preset.width
    canvasHeight.value = preset.height
    // 画布尺寸变化后自动排版（即使当前有选中照片也需要重排）
    autoLayout()
  }

  function setCustomSize(width: number, height: number) {
    canvasWidth.value = width
    canvasHeight.value = height
    currentPresetId.value = 'custom'
    autoLayout()
  }

  function selectPhoto(id: string | null) {
    selectedPhotoId.value = id
  }

  function bringToFront(id: string) {
    const maxZ = photos.value.reduce((max, p) => Math.max(max, p.zIndex), 0)
    const photo = photos.value.find(p => p.id === id)
    if (photo) {
      photo.zIndex = maxZ + 1
      selectedPhotoId.value = id
    }
  }

  function sendToBack(id: string) {
    const minZ = photos.value.reduce((min, p) => Math.min(min, p.zIndex), Infinity)
    const photo = photos.value.find(p => p.id === id)
    if (photo) {
      photo.zIndex = minZ - 1
      selectedPhotoId.value = id
    }
  }

  function bringToFrontWithHistory(id: string) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return
    const before = snapshotPhotoCore(photo)
    bringToFront(id)
    const after = snapshotPhotoCore(photo)
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: '置顶',
      kind: 'photo',
      photoId: id,
      before,
      after,
    })
  }

  function sendToBackWithHistory(id: string) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return
    const before = snapshotPhotoCore(photo)
    sendToBack(id)
    const after = snapshotPhotoCore(photo)
    pushHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
      label: '置底',
      kind: 'photo',
      photoId: id,
      before,
      after,
    })
  }

  function setCropMode(id: string | null) {
    cropModePhotoId.value = id
  }

  function setExporting(value: boolean) {
    isExporting.value = value
  }

  function setExportFormat(value: ExportFormat) {
    exportFormat.value = value
  }

  function setExportQuality(value: number) {
    exportQuality.value = value
  }

  function setExportResolution(value: ExportResolutionPreset) {
    exportResolution.value = value
  }

  function setMode(newMode: AppMode) {
    mode.value = newMode
  }

  function clearAllPhotos() {
    photos.value.forEach(p => URL.revokeObjectURL(p.srcUrl))
    photos.value = []
    selectedPhotoId.value = null
    cropModePhotoId.value = null
    clearHistory()
  }

  function applyPlacements(placements: Placement[]) {
    placements.forEach(({ id, cx, cy, scale, rotation, crop }) => {
      const photo = photos.value.find(p => p.id === id)
      if (photo) {
        photo.cx = cx
        photo.cy = cy
        photo.scale = scale
        photo.rotation = rotation
        if (crop) {
          photo.layoutCrop = clampCrop(crop, photo.imageWidth, photo.imageHeight)
        }
      }
    })
  }

  return {
    // State
    presets,
    currentPresetId,
    canvasWidth,
    canvasHeight,
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

    // Actions
    addPhoto,
    removePhoto,
    updatePhoto,
    updatePhotoWithHistory,
    replacePhotoImage,
    autoLayout,
    autoLayoutWithHistory,
    applyPlacementsWithHistory,
    applyCrop,
    undo,
    redo,
    clearHistory,
    pushPhotoHistoryFromPartials,
    replacePhotoFromFile,
    setPhotoAdjustments,
    setPreset,
    setCustomSize,
    selectPhoto,
    bringToFront,
    sendToBack,
    bringToFrontWithHistory,
    sendToBackWithHistory,
    setCropMode,
    setExporting,
    setExportFormat,
    setExportQuality,
    setExportResolution,
    setMode,
    clearAllPhotos,
    applyPlacements,
  }
})
