import type { PhotoEntity, ExportFormat, ExportResolutionPreset } from '@/types'
import { canvasToBlob, downloadBlob } from '@/utils/image'
import { buildCanvasFilter } from '@/utils/filters'

interface ExportStore {
  canvasWidth: number
  canvasHeight: number
  sortedPhotos: PhotoEntity[]
  exportFormat: ExportFormat
  exportQuality: number
  exportResolution: ExportResolutionPreset
}

function resolveExportSize(
  canvasWidth: number,
  canvasHeight: number,
  preset: ExportResolutionPreset
): { width: number; height: number; scale: number } {
  if (preset === 'original') {
    return { width: canvasWidth, height: canvasHeight, scale: 1 }
  }

  const maxEdge = Math.max(canvasWidth, canvasHeight)
  const targetMaxEdge =
    preset === '1080p' ? 1920 : preset === '2k' ? 2560 : 3840
  const scale = targetMaxEdge / maxEdge
  return {
    width: Math.max(1, Math.round(canvasWidth * scale)),
    height: Math.max(1, Math.round(canvasHeight * scale)),
    scale,
  }
}

/**
 * 导出拼图为图片
 */
export async function exportMosaic(store: ExportStore): Promise<void> {
  const { canvasWidth, canvasHeight, sortedPhotos, exportFormat, exportQuality, exportResolution } = store

  const { width: outW, height: outH, scale: outScale } = resolveExportSize(
    canvasWidth,
    canvasHeight,
    exportResolution
  )

  // Soft limits: browsers vary by platform/GPU, keep it generous but safe.
  const maxPixels = 120_000_000
  const maxDim = 16384
  if (outW > maxDim || outH > maxDim) {
    throw new Error(`导出边长超出浏览器限制（${outW}×${outH}），请降低分辨率或缩小画布`)
  }
  if (outW * outH > maxPixels) {
    throw new Error(`导出像素过大（${outW}×${outH}），请降低分辨率或缩小画布`)
  }

  // 创建全尺寸画布
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  
  if (!ctx) {
    throw new Error('无法创建 Canvas 2D 上下文（可能是浏览器/内存限制）')
  }

  // 填充白色背景 (JPEG 需要)
  if (exportFormat === 'jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, outW, outH)
  }

  // 按 zIndex 顺序绘制所有照片
  for (const photo of sortedPhotos) {
    if (!photo.image) {
      throw new Error(`照片数据不完整：${photo.name ?? photo.id}`)
    }

    const crop = photo.layoutCrop ?? photo.crop
    if (!crop || crop.width <= 0 || crop.height <= 0) {
      throw new Error(`裁剪数据不合法：${photo.name ?? photo.id}`)
    }

    ctx.save()
    ctx.translate(photo.cx * outScale, photo.cy * outScale)
    ctx.rotate(photo.rotation)
    ctx.filter = buildCanvasFilter(photo.adjustments)

    const hw = (crop.width * photo.scale * outScale) / 2
    const hh = (crop.height * photo.scale * outScale) / 2

    ctx.drawImage(
      photo.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      -hw,
      -hh,
      hw * 2,
      hh * 2
    )

    ctx.restore()
  }

  // 转换为 Blob 并下载
  let blob: Blob
  try {
    blob = await canvasToBlob(canvas, exportFormat, exportQuality)
  } catch (e) {
    if (exportFormat === 'webp') {
      throw new Error('当前浏览器可能不支持 WebP 导出，请改用 PNG/JPEG')
    }
    throw e
  }
  const timestamp = new Date().toISOString().slice(0, 10)
  const suffix = exportResolution === 'original' ? '' : `-${exportResolution}`
  const filename = `mosaic-${timestamp}${suffix}.${exportFormat}`
  
  downloadBlob(blob, filename)
}

/**
 * 使用 Web Worker 导出（用于大尺寸图片）
 */
export async function exportMosaicWithWorker(store: ExportStore): Promise<void> {
  // 对于普通尺寸，直接使用主线程
  if (store.canvasWidth * store.canvasHeight < 30000000) {
    return exportMosaic(store)
  }

  // 大尺寸图片使用分块渲染
  // 这里可以实现 OffscreenCanvas 或分块渲染
  return exportMosaic(store)
}
