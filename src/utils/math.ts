import type { PhotoEntity, CropRect, OBB, Point, Handle } from '@/types'

/**
 * 将值限制在指定范围内
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 生成指定范围内的随机数
 */
export function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * 角度转弧度
 */
export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * 弧度转角度
 */
export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/**
 * 旋转点
 */
export function rotatePoint(x: number, y: number, rad: number): Point {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: x * c - y * s, y: x * s + y * c }
}

/**
 * 反向旋转点
 */
export function inverseRotatePoint(x: number, y: number, rad: number): Point {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: x * c + y * s, y: -x * s + y * c }
}

/**
 * 计算旋转后的轴对齐边界框的半尺寸
 */
export function rotatedAABBHalf(hw: number, hh: number, rad: number): { ex: number; ey: number } {
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  return { ex: hw * c + hh * s, ey: hw * s + hh * c }
}

/**
 * 获取照片的绘制半尺寸
 */
export function getDrawHalfSize(photo: PhotoEntity, cropOverride?: CropRect): { hw: number; hh: number } {
  const crop = cropOverride ?? photo.layoutCrop ?? photo.crop
  return {
    hw: (crop.width * photo.scale) / 2,
    hh: (crop.height * photo.scale) / 2,
  }
}

/**
 * 限制裁剪区域
 */
export function clampCrop(crop: CropRect, imageWidth: number, imageHeight: number): CropRect {
  const x = Math.max(0, Math.min(imageWidth - 1, crop.x))
  const y = Math.max(0, Math.min(imageHeight - 1, crop.y))
  const maxW = Math.max(1, imageWidth - x)
  const maxH = Math.max(1, imageHeight - y)
  const width = Math.max(1, Math.min(maxW, crop.width))
  const height = Math.max(1, Math.min(maxH, crop.height))
  return { x, y, width, height }
}

/**
 * 将照片限制在画布范围内
 */
export function clampPhotoToCanvas(
  photo: PhotoEntity | { crop: CropRect; scale: number; rotation: number; cx: number; cy: number },
  canvasW: number,
  canvasH: number
): { cx: number; cy: number } {
  const { hw, hh } = getDrawHalfSize(photo as PhotoEntity)
  const { ex, ey } = rotatedAABBHalf(hw, hh, photo.rotation)
  return {
    cx: clamp(photo.cx, ex, canvasW - ex),
    cy: clamp(photo.cy, ey, canvasH - ey),
  }
}

/**
 * 将照片转换为OBB（定向边界框）
 */
export function photoToOBB(photo: PhotoEntity): OBB {
  const { hw, hh } = getDrawHalfSize(photo)
  return {
    cx: photo.cx,
    cy: photo.cy,
    hw,
    hh,
    rotation: photo.rotation,
  }
}

/**
 * 检测两个OBB是否相交
 */
export function obbIntersects(a: OBB, b: OBB, padding: number = 0): boolean {
  // SAT (Separating Axis Theorem) for OBB
  const aHw = a.hw + padding / 2
  const aHh = a.hh + padding / 2
  const bHw = b.hw + padding / 2
  const bHh = b.hh + padding / 2

  const dx = b.cx - a.cx
  const dy = b.cy - a.cy

  const axes = [
    rotatePoint(1, 0, a.rotation),
    rotatePoint(0, 1, a.rotation),
    rotatePoint(1, 0, b.rotation),
    rotatePoint(0, 1, b.rotation),
  ]

  const aCorners = [
    { x: -aHw, y: -aHh },
    { x: aHw, y: -aHh },
    { x: aHw, y: aHh },
    { x: -aHw, y: aHh },
  ].map(c => rotatePoint(c.x, c.y, a.rotation))

  const bCorners = [
    { x: -bHw, y: -bHh },
    { x: bHw, y: -bHh },
    { x: bHw, y: bHh },
    { x: -bHw, y: bHh },
  ].map(c => rotatePoint(c.x, c.y, b.rotation))

  for (const axis of axes) {
    const aProjs = aCorners.map(c => c.x * axis.x + c.y * axis.y)
    const bProjs = bCorners.map(c => (c.x + dx) * axis.x + (c.y + dy) * axis.y)

    const aMin = Math.min(...aProjs)
    const aMax = Math.max(...aProjs)
    const bMin = Math.min(...bProjs)
    const bMax = Math.max(...bProjs)

    if (aMax < bMin || bMax < aMin) return false
  }

  return true
}

/**
 * 检测点是否在照片内
 */
export function pointInPhoto(photo: PhotoEntity, x: number, y: number): boolean {
  const dx = x - photo.cx
  const dy = y - photo.cy
  const local = inverseRotatePoint(dx, dy, photo.rotation)
  const { hw, hh } = getDrawHalfSize(photo)
  return Math.abs(local.x) <= hw && Math.abs(local.y) <= hh
}

/**
 * 获取手柄的本地坐标
 */
export function getHandleLocal(handle: Handle, hw: number, hh: number): Point {
  switch (handle) {
    case 'n': return { x: 0, y: -hh }
    case 'ne': return { x: hw, y: -hh }
    case 'e': return { x: hw, y: 0 }
    case 'se': return { x: hw, y: hh }
    case 's': return { x: 0, y: hh }
    case 'sw': return { x: -hw, y: hh }
    case 'w': return { x: -hw, y: 0 }
    case 'nw': return { x: -hw, y: -hh }
  }
}

/**
 * 获取照片的所有手柄位置
 */
export function getHandlePositions(photo: PhotoEntity): Array<{ handle: Handle; x: number; y: number }> {
  const { hw, hh } = getDrawHalfSize(photo)
  const handles: Handle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
  return handles.map(h => {
    const local = getHandleLocal(h, hw, hh)
    const rotated = rotatePoint(local.x, local.y, photo.rotation)
    return { handle: h, x: photo.cx + rotated.x, y: photo.cy + rotated.y }
  })
}

/**
 * 计算两点之间的距离
 */
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2))
}

/**
 * 唯一ID生成器
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}
