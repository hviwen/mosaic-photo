import { reqToPromise, txStore } from '@/project/idb'
import type { ProjectV1 } from '@/project/schema'

const LATEST_KEY = 'latest'

export async function putLatestProject(project: ProjectV1): Promise<void> {
  await txStore('projects', 'readwrite', async (store) => {
    store.put({ id: LATEST_KEY, project })
  })
}

export async function getLatestProject(): Promise<ProjectV1 | null> {
  return await txStore('projects', 'readonly', async (store) => {
    const result = await reqToPromise<any>(store.get(LATEST_KEY))
    return result?.project ?? null
  })
}

export async function clearProjects(): Promise<void> {
  await txStore('projects', 'readwrite', async (store) => {
    store.clear()
  })
}
