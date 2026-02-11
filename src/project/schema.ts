import type {
  CropRect,
  ExportFormat,
  ExportResolutionPreset,
  PhotoAdjustments,
} from "@/types";

export type ProjectVersion = 1;

export interface ProjectAssetMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
}

export interface ProjectPhotoV1 {
  id: string;
  assetId: string;
  name: string;

  sourceWidth: number;
  sourceHeight: number;

  imageWidth: number;
  imageHeight: number;

  crop: CropRect;
  layoutCrop?: CropRect;
  adjustments: PhotoAdjustments;

  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  zIndex: number;
  tileRect?: { x: number; y: number; w: number; h: number };
}

export interface ProjectCanvasV1 {
  presetId: string;
  width: number;
  height: number;
}

export interface ProjectExportV1 {
  format: ExportFormat;
  quality: number;
  resolution: ExportResolutionPreset;
}

export interface ProjectV1 {
  version: ProjectVersion;
  id: string;
  createdAt: number;
  updatedAt: number;

  canvas: ProjectCanvasV1;
  export: ProjectExportV1;

  photos: ProjectPhotoV1[];
  assets: ProjectAssetMeta[];
}
