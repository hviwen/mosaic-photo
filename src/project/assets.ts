import { reqToPromise, txStore } from '@/project/idb'
import type { ProjectAssetMeta } from '@/project/schema'

export interface StoredAsset {
  id: string
  meta: ProjectAssetMeta
  blob: Blob
}

export function createAssetId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function putAsset(meta: ProjectAssetMeta, blob: Blob): Promise<void> {
  await txStore('assets', 'readwrite', async (store) => {
    store.put({ id: meta.id, meta, blob })
  })
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  return await txStore('assets', 'readonly', async (store) => {
    const result = await reqToPromise<any>(store.get(id))
    return result ? (result as StoredAsset) : null
  })
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
  const asset = await getAsset(id)
  return asset?.blob ?? null
}

export async function hasAsset(id: string): Promise<boolean> {
  const asset = await getAsset(id)
  return Boolean(asset)
}

export async function clearAllAssets(): Promise<void> {
  await txStore('assets', 'readwrite', async (store) => {
    store.clear()
  })
}
