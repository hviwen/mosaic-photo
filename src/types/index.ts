// 类型定义

export type ExportFormat = "png" | "jpeg" | "webp";

export type ExportResolutionPreset = "original" | "1080p" | "2k" | "4k";

export interface CanvasPreset {
  id: string;
  label: string;
  width: number; // px (300DPI)
  height: number; // px (300DPI)
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FilterPreset = "none" | "blackWhite" | "sepia" | "vintage";

export interface PhotoAdjustments {
  /**
   * 亮度：1 为原始
   */
  brightness: number;
  /**
   * 对比度：1 为原始
   */
  contrast: number;
  /**
   * 饱和度：1 为原始
   */
  saturation: number;
  /**
   * 滤镜预设（会叠加在三项数值之上）
   */
  preset: FilterPreset;
}

export interface PhotoEntity {
  id: string;
  /**
   * 原始图片资源引用（用于持久化与高清导出）。
   * 预览渲染仍使用 image（缩略图 canvas）。
   */
  assetId?: string;
  name: string;
  srcUrl: string;
  /**
   * 预览渲染使用的图片源（通常为缩略图）。
   * - 主线程导入：HTMLCanvasElement
   * - vision worker：ImageBitmap
   */
  image: CanvasImageSource;
  /** 原始图片像素尺寸（未缩放）。缺省时与 imageWidth/imageHeight 相同。 */
  sourceWidth?: number;
  sourceHeight?: number;
  imageWidth: number;
  imageHeight: number;
  crop: CropRect;
  /**
   * 自动排版为了铺满画布可能会在用户 crop 基础上进一步裁剪到 tile 宽高比。
   * - 不写回 crop，避免破坏用户裁剪与 undo/redo
   * - 渲染/导出优先使用 layoutCrop
   */
  layoutCrop?: CropRect;
  /**
   * 照片调色与滤镜
   */
  adjustments: PhotoAdjustments;
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  zIndex: number;
  /** 铺满布局时照片所属 tile 的画布坐标矩形，用于渲染时 clip 防止溢出 */
  tileRect?: { x: number; y: number; w: number; h: number };
}

export interface AppMode {
  kind: "idle" | "dragging" | "resizing" | "cropping";
  photoId?: string;
}

export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
}

export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface Point {
  x: number;
  y: number;
}

export interface OBB {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rotation: number;
}

export interface ArrangeOptions {
  paddingPx?: number;
  maxGlobalRetries?: number;
  maxCandidates?: number;
  randomScaleMin?: number;
  randomScaleMax?: number;
  rotationDeg?: number;
}

export interface Placement {
  id: string;
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  crop?: CropRect;
  /** 铺满布局时照片所属 tile 的画布坐标矩形，用于渲染时 clip 防止溢出 */
  tileRect?: { x: number; y: number; w: number; h: number };
}

export type CropStrategyMode =
  | "face-priority"
  | "object-priority"
  | "center";

export interface CropLossBreakdown {
  orientationViolation: boolean;
  faceCutPenalty: number;
  largePhotoCropPenalty: number;
  aspectDeviationPenalty: number;
  centerPreference: number;
  cropAreaLoss: number;
  cropBudget: number;
}

export interface CropDecision {
  crop: CropRect;
  mode: CropStrategyMode;
  losses: CropLossBreakdown;
  totalCost: number;
}

export interface PhotoLayoutFeatures {
  id: string;
  sourceAspect: number;
  preferredAspect: number;
  sizeWeight: number;
  extremeLevel: number;
  hasFaces: boolean;
  faceCount: number;
}

export interface LayoutMetrics {
  evaluatedPairs: number;
  cacheHits: number;
  cacheMisses: number;
  orientationViolations: number;
  canvasAdjustmentsTried: number;
}

export interface FillArrangeResult {
  placements: Placement[];
  canvasW: number;
  canvasH: number;
  metrics: LayoutMetrics;
}

// Toast 类型
export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}
