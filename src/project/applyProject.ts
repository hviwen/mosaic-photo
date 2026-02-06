import type { ProjectV1 } from '@/project/schema'
import type { PhotoEntity } from '@/types'
import { createPhotoFromFile } from '@/utils/image'
import { getAsset } from '@/project/assets'

export async function hydratePhotosFromProject(params: {
  project: ProjectV1
  canvasWidth: number
  canvasHeight: number
}): Promise<PhotoEntity[]> {
  const { project, canvasWidth, canvasHeight } = params

  const result: PhotoEntity[] = []
  for (const p of project.photos) {
    const asset = await getAsset(p.assetId)
    if (!asset) {
      throw new Error(`缺少图片资源：${p.name}（assetId=${p.assetId}）`)
    }

    const file = new File([asset.blob], asset.meta.name, {
      type: asset.meta.type,
      lastModified: asset.meta.lastModified,
    })

    const base = await createPhotoFromFile(file, canvasWidth, canvasHeight, {
      id: p.id,
      prefetchSmartCrop: true,
    })

    // Apply persisted transforms/params
    base.assetId = p.assetId
    base.name = p.name
    base.sourceWidth = p.sourceWidth
    base.sourceHeight = p.sourceHeight
    base.crop = { ...p.crop }
    base.layoutCrop = p.layoutCrop ? { ...p.layoutCrop } : undefined
    base.adjustments = { ...p.adjustments }
    base.cx = p.cx
    base.cy = p.cy
    base.scale = p.scale
    base.rotation = p.rotation
    base.zIndex = p.zIndex

    result.push(base)
  }

  return result
}
