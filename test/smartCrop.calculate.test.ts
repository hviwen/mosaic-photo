import { describe, expect, it } from 'vitest'
import { calculateSmartCrop, type SmartDetection } from '@/utils/smartCrop'
import type { CropRect } from '@/types'

function approx(a: number, b: number, eps: number = 1e-3): boolean {
  return Math.abs(a - b) <= eps
}

function expandBox(box: CropRect, margin: number): CropRect {
  const pad = margin * Math.min(box.width, box.height)
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  }
}

function contains(outer: CropRect, inner: CropRect, tol: number = 1e-3): boolean {
  return (
    outer.x <= inner.x + tol &&
    outer.y <= inner.y + tol &&
    outer.x + outer.width >= inner.x + inner.width - tol &&
    outer.y + outer.height >= inner.y + inner.height - tol
  )
}

describe('calculateSmartCrop', () => {
  it('竖图裁成横向时尽量不切脸（人脸优先）', () => {
    const image = { width: 1000, height: 1500 }
    const targetAspect = 1.5
    const face: SmartDetection = {
      kind: 'face',
      score: 0.9,
      box: { x: 380, y: 80, width: 220, height: 220 },
    }

    const crop = calculateSmartCrop(image, targetAspect, [face])
    expect(approx(crop.width / crop.height, targetAspect, 1e-2)).toBe(true)

    const safe = expandBox(face.box, 0.12)
    expect(contains(crop, safe)).toBe(true)
    // 更偏向上方：不应把窗口推到很靠下
    expect(crop.y).toBeLessThan(250)
  })

  it('无人脸时对象框可作为兜底（尽量覆盖主体）', () => {
    const image = { width: 2000, height: 1000 }
    const targetAspect = 1
    const obj: SmartDetection = {
      kind: 'object',
      score: 0.9,
      label: 'cat',
      box: { x: 120, y: 260, width: 260, height: 260 },
    }

    const crop = calculateSmartCrop(image, targetAspect, [obj])
    expect(approx(crop.width / crop.height, targetAspect, 1e-2)).toBe(true)

    const safe = expandBox(obj.box, 0.12)
    expect(contains(crop, safe)).toBe(true)
    expect(crop.x).toBeLessThan(400)
  })
})

