import type { KeepRegion } from '@/types/vision'
import { DEFAULT_VISION_ASSETS, type VisionAssets } from '@/vision/assets'

type InitRequest = {
  id: number
  type: 'init'
  assets: VisionAssets
  options?: {
    face?: { scoreThreshold?: number; maxFaces?: number }
    object?: { scoreThreshold?: number; maxResults?: number }
  }
}

type ProcessFileRequest = {
  id: number
  type: 'processFile'
  photoId: string
  file: File
  previewMaxEdge: number
  detectShortSide: number
  enableObject: boolean
}

type ProcessFileOk = {
  id: number
  ok: true
  result: {
    photoId: string
    sourceWidth: number
    sourceHeight: number
    previewWidth: number
    previewHeight: number
    previewBitmap: ImageBitmap
    detections: KeepRegion[]
  }
}

type ProcessFileErr = { id: number; ok: false; error: string }
type WorkerResponse = ProcessFileOk | ProcessFileErr | { id: number; ok: true; type: 'inited' }

export type VisionMode = 'mediapipe' | 'native' | 'off'

function resolveVisionMode(): VisionMode {
  const raw = String((import.meta as any).env?.VITE_VISION_MODE ?? '').trim().toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'native') return 'native'
  return 'mediapipe'
}

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void }

export class VisionClient {
  private worker: Worker | null = null
  private reqId = 0
  private pending = new Map<number, Pending<any>>()
  private initPromise: Promise<void> | null = null
  private failed = false
  private assets: VisionAssets

  constructor(assets: VisionAssets = DEFAULT_VISION_ASSETS) {
    this.assets = assets
  }

  isEnabled(): boolean {
    return resolveVisionMode() === 'mediapipe' && !this.failed
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('../workers/visionWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if ((msg as any).ok) p.resolve(msg)
      else p.reject(new Error((msg as any).error || 'Vision worker 处理失败'))
    }
    w.onerror = () => {
      this.failed = true
      for (const p of this.pending.values()) {
        try {
          p.reject(new Error('Vision worker 发生错误'))
        } catch {
          // ignore
        }
      }
      this.pending.clear()
      try {
        w.terminate()
      } catch {
        // ignore
      }
      this.worker = null
    }
    this.worker = w
    return w
  }

  async initOnce(): Promise<void> {
    if (this.failed) throw new Error('Vision 已失效（初始化失败）')
    if (resolveVisionMode() !== 'mediapipe') throw new Error('Vision 模式未启用')
    if (this.initPromise) return await this.initPromise

    this.initPromise = (async () => {
      const id = ++this.reqId
      const w = this.getWorker()
      const req: InitRequest = {
        id,
        type: 'init',
        assets: this.assets,
        options: {
          face: { scoreThreshold: 0.15, maxFaces: 8 },
          object: { scoreThreshold: 0.25, maxResults: 6 },
        },
      }

      await new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve: () => resolve(), reject })
        w.postMessage(req)
      })
    })()

    try {
      await this.initPromise
    } catch (e) {
      this.failed = true
      this.initPromise = null
      throw e
    }
  }

  async processFile(params: {
    photoId: string
    file: File
    previewMaxEdge?: number
    detectShortSide?: number
    enableObject?: boolean
  }): Promise<ProcessFileOk['result']> {
    await this.initOnce()

    const id = ++this.reqId
    const w = this.getWorker()
    const req: ProcessFileRequest = {
      id,
      type: 'processFile',
      photoId: params.photoId,
      file: params.file,
      previewMaxEdge: params.previewMaxEdge ?? 1536,
      detectShortSide: params.detectShortSide ?? 512,
      enableObject: params.enableObject !== false,
    }

    const msg = await new Promise<ProcessFileOk>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage(req)
    })

    return msg.result
  }
}

let singleton: VisionClient | null = null

export function getVisionClient(): VisionClient {
  if (!singleton) singleton = new VisionClient()
  return singleton
}
