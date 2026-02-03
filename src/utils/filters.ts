import type { PhotoAdjustments } from '@/types'
import { clamp } from '@/utils/math'

export function buildCanvasFilter(adjustments: PhotoAdjustments): string {
  const brightness = clamp(adjustments.brightness, 0, 3)
  const contrast = clamp(adjustments.contrast, 0, 3)
  const saturation = clamp(adjustments.saturation, 0, 5)

  const parts: string[] = [
    `brightness(${brightness})`,
    `contrast(${contrast})`,
    `saturate(${saturation})`,
  ]

  if (adjustments.preset === 'blackWhite') {
    parts.push('grayscale(1)')
  } else if (adjustments.preset === 'sepia') {
    parts.push('sepia(1)')
  } else if (adjustments.preset === 'vintage') {
    // 轻量“复古”：偏暖 + 轻微去饱和 + 少量对比提升
    parts.push('sepia(0.35)')
    parts.push('saturate(0.9)')
    parts.push('contrast(1.08)')
  }

  return parts.join(' ')
}

