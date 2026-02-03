import type { PhotoEntity, CropRect, PhotoAdjustments } from '@/types'
import { generateId } from './math'
import type { SmartDetection } from '@/utils/smartCrop'
import { calculateSmartCrop, prefetchSmartDetections } from '@/utils/smartCrop'

const MAX_IMAGE_EDGE = 2048 // 限制图片最大边长以提升性能
const DEFAULT_ADJUSTMENTS: PhotoAdjustments = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  preset: 'none',
}

/**
 * 从文件创建照片实体
 */
export async function createPhotoFromFile(
  file: File,
  canvasWidth: number,
  canvasHeight: number,
  options?: { id?: string; prefetchSmartCrop?: boolean }
): Promise<PhotoEntity> {
  const id = options?.id ?? generateId()
  const srcUrl = URL.createObjectURL(file)
  const img = await loadImage(srcUrl)
  const { canvas, width, height } = resizeImage(img, MAX_IMAGE_EDGE)

  const crop: CropRect = { x: 0, y: 0, width, height }
  
  // 计算初始缩放和位置
  const fit = Math.min(canvasWidth / width, canvasHeight / height) * 0.4
  const scale = Math.max(0.05, Math.min(3, fit))

  const photo: PhotoEntity = {
    id,
    name: file.name,
    srcUrl,
    image: canvas,
    imageWidth: width,
    imageHeight: height,
    crop,
    adjustments: { ...DEFAULT_ADJUSTMENTS },
    cx: canvasWidth / 2,
    cy: canvasHeight / 2,
    scale,
    rotation: 0,
    zIndex: 0,
  }

  // 智能裁剪：在导入时预热检测（同步显著性 + 异步人脸）
  if (options?.prefetchSmartCrop !== false) {
    prefetchSmartDetections(id, canvas)
  }

  return photo
}

/**
 * 加载图片
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.src = src
  })
}

/**
 * 调整图片大小
 */
export function resizeImage(
  img: HTMLImageElement,
  maxEdge: number
): { canvas: HTMLCanvasElement; width: number; height: number } {
  let { width, height } = img

  if (width > maxEdge || height > maxEdge) {
    const ratio = Math.min(maxEdge / width, maxEdge / height)
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, width, height)

  return { canvas, width, height }
}

/**
 * 将裁剪框按目标宽高比进行“居中裁剪”调整。
 * - 不改变裁剪中心点
 * - 仅缩小裁剪范围以匹配目标比例
 */
export function centerCropToAspect(
  crop: CropRect,
  targetAspect: number,
  imageWidth: number,
  imageHeight: number,
  options?: { detections?: SmartDetection[] }
): CropRect {
  const detections = options?.detections
  if (detections && detections.length > 0) {
    try {
      return calculateSmartCrop(
        { width: imageWidth, height: imageHeight },
        targetAspect,
        detections,
        crop
      )
    } catch {
      // 任何检测/计算异常都退回到原有居中裁剪逻辑
    }
  }

  if (!isFinite(targetAspect) || targetAspect <= 0) return crop

  let { x, y, width, height } = crop
  if (width <= 0 || height <= 0) return crop

  const currentAspect = width / height
  if (!isFinite(currentAspect) || Math.abs(currentAspect - targetAspect) < 1e-6) {
    return crop
  }

  const cx = x + width / 2
  const cy = y + height / 2

  if (currentAspect > targetAspect) {
    // 太宽：收窄 width
    width = height * targetAspect
  } else {
    // 太高：收窄 height
    height = width / targetAspect
  }

  x = cx - width / 2
  y = cy - height / 2

  // clamp to image bounds
  width = Math.min(width, imageWidth)
  height = Math.min(height, imageHeight)
  x = Math.max(0, Math.min(x, imageWidth - width))
  y = Math.max(0, Math.min(y, imageHeight - height))

  return { x, y, width, height }
}

/**
 * 获取文件扩展名
 */
export function getFileExtension(filename: string): string {
  const parts = filename.split('.')
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ''
}

/**
 * 验证是否为支持的图片格式
 */
export function isValidImageFile(file: File): boolean {
  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  return validTypes.includes(file.type)
}

/**
 * 将画布导出为 Blob
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpeg' | 'webp',
  quality: number = 0.95
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mimeType = `image/${format}`
    canvas.toBlob(
      blob => {
        if (blob) resolve(blob)
        else reject(new Error('Failed to create blob'))
      },
      mimeType,
      format === 'png' ? undefined : quality
    )
  })
}

/**
 * 下载 Blob 文件
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
