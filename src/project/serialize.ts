import type { PhotoEntity } from '@/types'
import type { ProjectAssetMeta, ProjectPhotoV1, ProjectV1 } from '@/project/schema'

export function createProjectId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function serializePhotos(photos: PhotoEntity[]): ProjectPhotoV1[] {
  return photos
    .filter((p) => typeof p.assetId === 'string' && p.assetId.length > 0)
    .map((p) => ({
      id: p.id,
      assetId: p.assetId as string,
      name: p.name,

      sourceWidth: p.sourceWidth ?? p.imageWidth,
      sourceHeight: p.sourceHeight ?? p.imageHeight,
      imageWidth: p.imageWidth,
      imageHeight: p.imageHeight,
      crop: { ...p.crop },
      layoutCrop: p.layoutCrop ? { ...p.layoutCrop } : undefined,
      adjustments: { ...p.adjustments },
      cx: p.cx,
      cy: p.cy,
      scale: p.scale,
      rotation: p.rotation,
      zIndex: p.zIndex,
    }))
}

export function buildProjectV1(params: {
  existing?: ProjectV1 | null
  canvas: { presetId: string; width: number; height: number }
  export: { format: ProjectV1['export']['format']; quality: number; resolution: ProjectV1['export']['resolution'] }
  photos: PhotoEntity[]
  assets: ProjectAssetMeta[]
}): ProjectV1 {
  const now = Date.now()
  const base = params.existing
  return {
    version: 1,
    id: base?.id ?? createProjectId(),
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    canvas: {
      presetId: params.canvas.presetId,
      width: params.canvas.width,
      height: params.canvas.height,
    },
    export: {
      format: params.export.format,
      quality: params.export.quality,
      resolution: params.export.resolution,
    },
    photos: serializePhotos(params.photos),
    assets: params.assets,
  }
}

export function isProjectV1(input: unknown): input is ProjectV1 {
  if (!input || typeof input !== 'object') return false
  const any = input as any
  return any.version === 1 && typeof any.id === 'string' && Array.isArray(any.photos)
}
