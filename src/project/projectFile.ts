import type { ProjectV1 } from '@/project/schema'
import { buildProjectArchiveBlob, parseProjectArchiveBlob } from '@/project/fileFormat'
import { buildProjectV1, isProjectV1 } from '@/project/serialize'
import { getAsset, putAsset } from '@/project/assets'
import { downloadBlob } from '@/utils/image'
import type { PhotoEntity } from '@/types'
import { hydratePhotosFromProject } from '@/project/applyProject'

export interface ExportableStore {
  currentPresetId: string
  canvasWidth: number
  canvasHeight: number
  exportFormat: ProjectV1['export']['format']
  exportQuality: number
  exportResolution: ProjectV1['export']['resolution']
  photos: PhotoEntity[]
}

export async function exportProjectFile(params: {
  store: ExportableStore
  filename?: string
}): Promise<void> {
  const { store } = params

  // Resolve asset metas + blobs for referenced photos
  const ids = Array.from(
    new Set(
      store.photos
        .map((p) => p.assetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  )

  const assets: Array<{ id: string; blob: Blob }> = []
  const metas = [] as ProjectV1['assets']

  for (const id of ids) {
    const asset = await getAsset(id)
    if (!asset) continue
    metas.push(asset.meta)
    assets.push({ id, blob: asset.blob })
  }

  const project = buildProjectV1({
    existing: null,
    canvas: { presetId: store.currentPresetId, width: store.canvasWidth, height: store.canvasHeight },
    export: { format: store.exportFormat, quality: store.exportQuality, resolution: store.exportResolution },
    photos: store.photos,
    assets: metas,
  })

  const blob = await buildProjectArchiveBlob({ project, assets })
  const ts = new Date().toISOString().slice(0, 10)
  downloadBlob(blob, params.filename ?? `mosaic-project-${ts}.mosaicproj`)
}

export interface ImportableStore {
  currentPresetId: string
  canvasWidth: number
  canvasHeight: number
  exportFormat: ProjectV1['export']['format']
  exportQuality: number
  exportResolution: ProjectV1['export']['resolution']
  photos: PhotoEntity[]

  clearAllPhotos: () => void
  selectPhoto: (id: string | null) => void
  setExportFormat: (v: any) => void
  setExportQuality: (v: number) => void
  setExportResolution: (v: any) => void
}

export async function importProjectFile(params: {
  file: File
  store: ImportableStore
}): Promise<void> {
  const parsed = await parseProjectArchiveBlob(params.file)
  if (!isProjectV1(parsed.project)) {
    throw new Error('不支持的工程文件版本')
  }

  // Write assets to IndexedDB
  const metaById = new Map(parsed.project.assets.map((m) => [m.id, m]))
  for (const a of parsed.assets) {
    const meta = metaById.get(a.id)
    if (!meta) continue
    const typed = meta.type ? new Blob([a.blob], { type: meta.type }) : a.blob
    await putAsset(meta, typed)
  }

  // Apply project to store
  params.store.clearAllPhotos()
  params.store.currentPresetId = parsed.project.canvas.presetId
  params.store.canvasWidth = parsed.project.canvas.width
  params.store.canvasHeight = parsed.project.canvas.height
  params.store.setExportFormat(parsed.project.export.format)
  params.store.setExportQuality(parsed.project.export.quality)
  params.store.setExportResolution(parsed.project.export.resolution)

  const hydrated = await hydratePhotosFromProject({
    project: parsed.project,
    canvasWidth: parsed.project.canvas.width,
    canvasHeight: parsed.project.canvas.height,
  })

  params.store.photos = hydrated
  params.store.selectPhoto(hydrated[0]?.id ?? null)
}
