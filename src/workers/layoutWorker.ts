/// <reference lib="webworker" />

import type { CropRect, Placement } from '@/types'
import { centerCropToAspect } from '@/utils/image'
import type { SmartDetection } from '@/utils/smartCrop'

type FillArrangeOptions = {
  seed?: number
  splitRatioMin?: number
  splitRatioMax?: number
}

type FillArrangePhotoInput = {
  id: string
  crop: CropRect
  imageWidth: number
  imageHeight: number
  detections?: SmartDetection[]
}

type FillArrangeRequest = {
  id: number
  type: 'fillArrange'
  photos: FillArrangePhotoInput[]
  canvasW: number
  canvasH: number
  options?: FillArrangeOptions
}

type FillArrangeResponse =
  | { id: number; ok: true; placements: Placement[] }
  | { id: number; ok: false; error: string }

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num))
}

function fillArrangePhotosWorker(
  photos: FillArrangePhotoInput[],
  canvasW: number,
  canvasH: number,
  options: FillArrangeOptions = {}
): Placement[] {
  const n = photos.length
  if (n === 0) return []

  const ratioMin = clamp(options.splitRatioMin ?? 0.38, 0.2, 0.49)
  const ratioMax = clamp(options.splitRatioMax ?? 0.62, 0.51, 0.8)

  // Simple deterministic RNG when seed is provided.
  let seed = options.seed ?? Math.floor(Math.random() * 1_000_000_000)
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }

  type Rect = { x: number; y: number; w: number; h: number }
  const rectArea = (r: Rect) => r.w * r.h
  const rectAspect = (r: Rect) => r.w / r.h

  let minSide = Math.max(60, Math.min(canvasW, canvasH) / (Math.sqrt(n) * 2.2))

  const rects: Rect[] = [{ x: 0, y: 0, w: canvasW, h: canvasH }]

  // Irregular guillotine partition: keep splitting existing rectangles until we have n tiles.
  for (let i = 1; i < n; i++) {
    let splitDone = false

    for (let relax = 0; relax < 6 && !splitDone; relax++) {
      // Try candidates (largest first) to avoid getting stuck on tiny blocks.
      const candidates = [...rects]
        .map((r, idx) => ({ r, idx }))
        .sort((a, b) => rectArea(b.r) - rectArea(a.r))

      for (const { r, idx } of candidates) {
        const ar = rectAspect(r)
        const preferVertical = ar > 1.2 ? true : ar < 0.85 ? false : rand() > 0.5

        const trySplit = (vertical: boolean) => {
          if (vertical) {
            if (r.w < minSide * 2) return null
            const ratio = ratioMin + (ratioMax - ratioMin) * rand()
            const w1 = Math.round(r.w * ratio)
            const w2 = r.w - w1
            if (w1 < minSide || w2 < minSide) return null
            const a: Rect = { x: r.x, y: r.y, w: w1, h: r.h }
            const b: Rect = { x: r.x + w1, y: r.y, w: w2, h: r.h }
            return [a, b] as const
          }

          if (r.h < minSide * 2) return null
          const ratio = ratioMin + (ratioMax - ratioMin) * rand()
          const h1 = Math.round(r.h * ratio)
          const h2 = r.h - h1
          if (h1 < minSide || h2 < minSide) return null
          const a: Rect = { x: r.x, y: r.y, w: r.w, h: h1 }
          const b: Rect = { x: r.x, y: r.y + h1, w: r.w, h: h2 }
          return [a, b] as const
        }

        const split = trySplit(preferVertical) ?? trySplit(!preferVertical)
        if (!split) continue

        rects.splice(idx, 1, split[0], split[1])
        splitDone = true
        break
      }

      if (!splitDone) {
        // Relax minSide to guarantee we can always reach n tiles.
        minSide = Math.max(8, minSide * 0.75)
      }
    }
  }

  const tiles = rects.slice(0, n)

  // Greedy match: choose photo whose aspect is closest to tile aspect to reduce crop.
  const photosLeft = [...photos]
  const tileOrder = [...tiles].sort((a, b) => rectArea(b) - rectArea(a))

  const placements: Placement[] = []
  for (const tile of tileOrder) {
    if (photosLeft.length === 0) break

    const ta = tile.w / tile.h
    let bestIdx = 0
    let bestScore = Infinity
    for (let i = 0; i < photosLeft.length; i++) {
      const p = photosLeft[i]
      const pa = p.crop.width / p.crop.height
      const score = Math.abs(Math.log(pa) - Math.log(ta))
      if (score < bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    const p = photosLeft.splice(bestIdx, 1)[0]
    const nextCrop = centerCropToAspect(p.crop, ta, p.imageWidth, p.imageHeight, {
      detections: p.detections,
    })
    const scale = tile.w / nextCrop.width

    placements.push({
      id: p.id,
      cx: tile.x + tile.w / 2,
      cy: tile.y + tile.h / 2,
      scale,
      rotation: 0,
      crop: nextCrop,
    })
  }

  return placements
}

self.onmessage = (e: MessageEvent<FillArrangeRequest>) => {
  const msg = e.data
  if (!msg || msg.type !== 'fillArrange') return

  try {
    const placements = fillArrangePhotosWorker(msg.photos, msg.canvasW, msg.canvasH, msg.options)
    const res: FillArrangeResponse = { id: msg.id, ok: true, placements }
    self.postMessage(res)
  } catch (err) {
    const res: FillArrangeResponse = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(res)
  }
}
