import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PhotoEntity, CanvasPreset, ExportFormat, ExportResolutionPreset, CropRect, AppMode, Placement } from '@/types'
import { fillArrangePhotos } from '@/composables/useLayout'
import { clampPhotoToCanvas, clampCrop } from '@/utils/math'

const PRESETS: CanvasPreset[] = [
  { id: '40x50', label: '40cm × 50cm', width: 4724, height: 5906 },
  { id: '40x60', label: '40cm × 60cm', width: 4724, height: 7087 },
  { id: '50x70', label: '50cm × 70cm', width: 5906, height: 8268 },
  { id: '60x80', label: '60cm × 80cm', width: 7087, height: 9449 },
  { id: '60x90', label: '60cm × 90cm', width: 7087, height: 10630 },
  { id: 'custom', label: '自定义尺寸', width: 4000, height: 4000 },
]

export const useMosaicStore = defineStore('mosaic', () => {
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

  // Crop history (undo/redo)
  const cropUndoStack = ref<Array<{ id: string; before: CropRect; after: CropRect }>>([])
  const cropRedoStack = ref<Array<{ id: string; before: CropRect; after: CropRect }>>([])

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

  const canUndoCrop = computed(() => cropUndoStack.value.length > 0)
  const canRedoCrop = computed(() => cropRedoStack.value.length > 0)

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

  function autoLayout() {
    if (photos.value.length === 0) return
    const placements = fillArrangePhotos(photos.value, canvasWidth.value, canvasHeight.value)
    applyPlacements(placements)
  }

  function applyCrop(id: string, crop: CropRect) {
    const photo = photos.value.find(p => p.id === id)
    if (!photo) return

    const before = { ...photo.crop }
    const after = clampCrop(crop, photo.imageWidth, photo.imageHeight)

    photo.crop = after
    photo.layoutCrop = undefined
    cropUndoStack.value.push({ id, before, after })
    cropRedoStack.value = []

    // 裁剪后重新排版，自动更新位置和尺寸
    autoLayout()
  }

  function undoCrop() {
    const cmd = cropUndoStack.value.pop()
    if (!cmd) return

    const photo = photos.value.find(p => p.id === cmd.id)
    if (!photo) return

    photo.crop = clampCrop(cmd.before, photo.imageWidth, photo.imageHeight)
    photo.layoutCrop = undefined
    cropRedoStack.value.push(cmd)
    autoLayout()
  }

  function redoCrop() {
    const cmd = cropRedoStack.value.pop()
    if (!cmd) return

    const photo = photos.value.find(p => p.id === cmd.id)
    if (!photo) return

    photo.crop = clampCrop(cmd.after, photo.imageWidth, photo.imageHeight)
    photo.layoutCrop = undefined
    cropUndoStack.value.push(cmd)
    autoLayout()
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
    photo.image = image
    photo.imageWidth = imageWidth
    photo.imageHeight = imageHeight
    photo.crop = clampCrop(crop, imageWidth, imageHeight)
    photo.layoutCrop = undefined
  }

  function setPreset(presetId: string) {
    const preset = presets.value.find(p => p.id === presetId)
    if (!preset) return
    currentPresetId.value = presetId
    canvasWidth.value = preset.width
    canvasHeight.value = preset.height
    // 重新约束所有照片位置
    photos.value.forEach(photo => {
      const clamped = clampPhotoToCanvas(photo, preset.width, preset.height)
      photo.cx = clamped.cx
      photo.cy = clamped.cy
    })
  }

  function setCustomSize(width: number, height: number) {
    canvasWidth.value = width
    canvasHeight.value = height
    currentPresetId.value = 'custom'
    photos.value.forEach(photo => {
      const clamped = clampPhotoToCanvas(photo, width, height)
      photo.cx = clamped.cx
      photo.cy = clamped.cy
    })
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

    // Computed
    currentPreset,
    selectedPhoto,
    cropModePhoto,
    photoCount,
    sortedPhotos,
    canUndoCrop,
    canRedoCrop,

    // Actions
    addPhoto,
    removePhoto,
    updatePhoto,
    replacePhotoImage,
    autoLayout,
    applyCrop,
    undoCrop,
    redoCrop,
    setPreset,
    setCustomSize,
    selectPhoto,
    bringToFront,
    sendToBack,
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
