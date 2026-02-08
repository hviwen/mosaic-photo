import type { PhotoEntity, CropRect, PhotoAdjustments } from '@/types'
import { generateId } from './math'
import type { SmartDetection } from '@/utils/smartCrop'
import { calculateSmartCrop, prefetchSmartDetections } from '@/utils/smartCrop'

const MAX_IMAGE_EDGE = 2048 // 限制图片最大边长以提升性能
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]
const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']
const DEFAULT_ADJUSTMENTS: PhotoAdjustments = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  preset: 'none',
}

type DecodedImageSource = {
  srcUrl: string
  image: CanvasImageSource
  sourceWidth: number
  sourceHeight: number
  cleanup?: () => void
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
  const decoded = await decodeImageFile(file)
  let width = 0
  let height = 0
  let canvas!: HTMLCanvasElement
  try {
    const resized = resizeImage(decoded.image, MAX_IMAGE_EDGE)
    canvas = resized.canvas
    width = resized.width
    height = resized.height
  } finally {
    decoded.cleanup?.()
  }

  const crop: CropRect = { x: 0, y: 0, width, height }
  
  // 计算初始缩放和位置
  const fit = Math.min(canvasWidth / width, canvasHeight / height) * 0.4
  const scale = Math.max(0.05, Math.min(3, fit))

  const photo: PhotoEntity = {
    id,
    name: file.name,
    srcUrl: decoded.srcUrl,
    image: canvas,
    sourceWidth: decoded.sourceWidth,
    sourceHeight: decoded.sourceHeight,
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
 * 兼容 HEIC/HEIF 的图片解码：
 * - 优先尝试 createImageBitmap（异步解码，批量导入时更不易阻塞 UI）
 * - 失败后回退到 <img> 方式（用于浏览器原生可显示 HEIC 的场景）
 */
async function decodeImageFile(file: File): Promise<DecodedImageSource> {
  const isHeic = isHeicFile(file)
  if (!isHeic) {
    const srcUrl = URL.createObjectURL(file)
    const img = await loadImage(srcUrl)
    return {
      srcUrl,
      image: img,
      sourceWidth: img.naturalWidth || img.width,
      sourceHeight: img.naturalHeight || img.height,
    }
  }

  // HEIC 优先异步解码并转成可预览 URL，避免某些浏览器 <img> 无法直接显示 .heic
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      let srcUrl: string
      try {
        srcUrl = await createPreviewUrlFromSource(bitmap, bitmap.width, bitmap.height)
      } catch {
        // ignore: 预览 URL 失败时仍允许继续导入
        srcUrl = URL.createObjectURL(file)
      }
      return {
        srcUrl,
        image: bitmap,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
        cleanup: () => {
          try {
            bitmap.close()
          } catch {
            // ignore
          }
        },
      }
    } catch {
      // ignore and fallback
    }
  }

  const srcUrl = URL.createObjectURL(file)
  const img = await loadImage(srcUrl)
  return {
    srcUrl,
    image: img,
    sourceWidth: img.naturalWidth || img.width,
    sourceHeight: img.naturalHeight || img.height,
  }
}

async function createPreviewUrlFromSource(
  source: CanvasImageSource,
  width: number,
  height: number
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to create canvas context')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const blob = await canvasToBlob(canvas, 'jpeg', 0.92)
  return URL.createObjectURL(blob)
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
  img: CanvasImageSource,
  maxEdge: number
): { canvas: HTMLCanvasElement; width: number; height: number } {
  let { width, height } = resolveImageSize(img)

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

function resolveImageSize(img: CanvasImageSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }
  }
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    return { width: img.width, height: img.height }
  }
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    return { width: img.width, height: img.height }
  }
  const size = img as unknown as { width?: number; height?: number }
  const width = Number(size.width ?? 0)
  const height = Number(size.height ?? 0)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Unsupported image source')
  }
  return { width, height }
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

export function isHeicFile(file: File): boolean {
  const type = String(file.type || '').toLowerCase()
  if (type.includes('heic') || type.includes('heif')) return true
  const ext = getFileExtension(file.name)
  return ext === 'heic' || ext === 'heif'
}

/**
 * 验证是否为支持的图片格式
 */
export function isValidImageFile(file: File): boolean {
  const type = String(file.type || '').toLowerCase()
  if (type && SUPPORTED_IMAGE_TYPES.includes(type)) return true
  const ext = getFileExtension(file.name)
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext)
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
