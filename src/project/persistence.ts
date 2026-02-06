import type { PhotoEntity } from '@/types'
import type { ProjectAssetMeta, ProjectV1 } from '@/project/schema'
import { buildProjectV1 } from '@/project/serialize'
import { getLatestProject, putLatestProject } from '@/project/projects'
import { getAsset } from '@/project/assets'

export interface MosaicStoreLike {
  currentPresetId: string
  canvasWidth: number
  canvasHeight: number
  exportFormat: ProjectV1['export']['format']
  exportQuality: number
  exportResolution: ProjectV1['export']['resolution']
  photos: PhotoEntity[]
}

let saveTimer: number | null = null

export function scheduleAutosave(params: {
  store: MosaicStoreLike
  delayMs?: number
}): void {
  const delayMs = params.delayMs ?? 400
  if (saveTimer != null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void autosaveNow(params.store)
  }, delayMs)
}

async function resolveAssetsForStore(photos: PhotoEntity[]): Promise<ProjectAssetMeta[]> {
  const ids = Array.from(
    new Set(
      photos
        .map((p) => p.assetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  )

  const metas: ProjectAssetMeta[] = []
  await Promise.all(
    ids.map(async (id) => {
      const asset = await getAsset(id)
      if (asset?.meta) metas.push(asset.meta)
    })
  )
  return metas
}

export async function autosaveNow(store: MosaicStoreLike): Promise<void> {
  const existing = await getLatestProject().catch(() => null)
  const assets = await resolveAssetsForStore(store.photos)
  const project = buildProjectV1({
    existing,
    canvas: { presetId: store.currentPresetId, width: store.canvasWidth, height: store.canvasHeight },
    export: { format: store.exportFormat, quality: store.exportQuality, resolution: store.exportResolution },
    photos: store.photos,
    assets,
  })
  await putLatestProject(project)
}

export async function loadLatestProject(): Promise<ProjectV1 | null> {
  return await getLatestProject()
}
