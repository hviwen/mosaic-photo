import type { CropRect, PhotoEntity } from "@/types";

export type PhotoSelectionInfo = {
  original: {
    width: number;
    height: number;
    aspect: string;
  };
  userCrop: {
    width: string;
    height: string;
    aspect: string;
  };
  displayCrop: {
    width: string;
    height: string;
    aspect: string;
  };
};

function toSafeSize(value: number, fallback: number): number {
  if (!isFinite(value) || value <= 0) return fallback;
  return value;
}

function formatAspect(width: number, height: number): string {
  const ratio = width / Math.max(1e-6, height);
  if (!isFinite(ratio)) return "0.00";
  return ratio.toFixed(2);
}

function formatCrop(crop: CropRect) {
  const width = toSafeSize(crop.width, 1);
  const height = toSafeSize(crop.height, 1);
  return {
    width: width.toFixed(2),
    height: height.toFixed(2),
    aspect: formatAspect(width, height),
  };
}

export function buildPhotoSelectionInfo(photo: PhotoEntity): PhotoSelectionInfo {
  const originalWidth = Math.round(
    toSafeSize(photo.sourceWidth ?? photo.imageWidth, photo.imageWidth),
  );
  const originalHeight = Math.round(
    toSafeSize(photo.sourceHeight ?? photo.imageHeight, photo.imageHeight),
  );
  const userCrop = formatCrop(photo.crop);
  const displayCrop = formatCrop(photo.layoutCrop ?? photo.crop);

  return {
    original: {
      width: originalWidth,
      height: originalHeight,
      aspect: formatAspect(originalWidth, originalHeight),
    },
    userCrop,
    displayCrop,
  };
}
