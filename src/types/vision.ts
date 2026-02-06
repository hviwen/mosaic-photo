import type { CropRect } from './index'

export type KeepRegionKind = 'face' | 'object'

/**
 * 需要尽量保留的区域（用于智能裁剪/排版）。
 * 坐标系：与 PhotoEntity.image（预览图）一致。
 */
export type KeepRegion = {
  kind: KeepRegionKind
  label?: string
  score: number
  box: CropRect
}

export type VisionMeta = {
  faces: KeepRegion[]
  objects: KeepRegion[]
}

