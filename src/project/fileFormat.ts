import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ProjectV1 } from '@/project/schema'

export interface ProjectArchive {
  project: ProjectV1
  assets: Array<{ id: string; blob: Blob }>
}

const PROJECT_JSON_PATH = 'project.json'

export async function buildProjectArchiveBlob(input: ProjectArchive): Promise<Blob> {
  const files: Record<string, Uint8Array> = {}
  files[PROJECT_JSON_PATH] = strToU8(JSON.stringify(input.project, null, 2))

  for (const a of input.assets) {
    const ab = await a.blob.arrayBuffer()
    files[`assets/${a.id}`] = new Uint8Array(ab)
  }

  const zipped = zipSync(files, { level: 6 })
  // fflate types use ArrayBufferLike; copy to ensure ArrayBuffer-backed view
  const out = new Uint8Array(zipped)
  return new Blob([out], { type: 'application/octet-stream' })
}

export async function parseProjectArchiveBlob(blob: Blob): Promise<ProjectArchive> {
  const u8 = new Uint8Array(await blob.arrayBuffer())
  const unzipped = unzipSync(u8)

  const projectRaw = unzipped[PROJECT_JSON_PATH]
  if (!projectRaw) {
    throw new Error('工程文件缺少 project.json')
  }
  const project = JSON.parse(strFromU8(projectRaw)) as ProjectV1

  const assets: Array<{ id: string; blob: Blob }> = []
  for (const [path, bytes] of Object.entries(unzipped)) {
    if (!path.startsWith('assets/')) continue
    const id = path.slice('assets/'.length)
    const out = new Uint8Array(bytes)
    assets.push({ id, blob: new Blob([out]) })
  }

  return { project, assets }
}
