import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PhotoEntity } from "@/types";

vi.mock("@/composables/useLayout", () => ({
  fillArrangePhotos: vi.fn(),
}));

vi.mock("@/project/assets", () => ({
  createAssetId: vi.fn(() => "asset-1"),
  putAsset: vi.fn(async () => undefined),
}));

vi.mock("@/utils/smartCrop", () => ({
  getSmartDetections: vi.fn(() => undefined),
  invalidateSmartDetections: vi.fn(),
  onSmartDetectionsChanged: vi.fn(() => () => undefined),
  prefetchSmartDetections: vi.fn(),
  seedSmartDetections: vi.fn(),
}));

vi.mock("@/vision/visionClient", () => ({
  getVisionClient: vi.fn(() => ({
    isEnabled: vi.fn(() => false),
    processFile: vi.fn(),
  })),
}));

const { useMosaicStore } = await import("@/stores/mosaic");

function makePhoto(overrides: Partial<PhotoEntity> = {}): PhotoEntity {
  return {
    id: "photo-1",
    name: "photo-1",
    srcUrl: "blob:preview",
    image: {} as unknown as CanvasImageSource,
    imageWidth: 1600,
    imageHeight: 1200,
    crop: { x: 120, y: 90, width: 1200, height: 900 },
    layoutCrop: { x: 200, y: 120, width: 800, height: 600 },
    adjustments: {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      preset: "none",
    },
    cx: 500,
    cy: 400,
    scale: 0.5,
    rotation: 0,
    zIndex: 0,
    tileRect: { x: 300, y: 250, w: 400, h: 300 },
    ...overrides,
  };
}

describe("mosaic store crop mode", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("keeps the tiled reference crop when entering crop mode", () => {
    const store = useMosaicStore();
    const photo = makePhoto();
    store.photos.push(photo);

    store.enterCropMode(photo.id);

    expect(store.cropModePhotoId).toBe(photo.id);
    expect(photo.crop).toEqual({ x: 120, y: 90, width: 1200, height: 900 });
    expect(photo.layoutCrop).toEqual({ x: 200, y: 120, width: 800, height: 600 });
    expect(store.getCropModeReferenceCrop(photo.id)).toEqual({
      x: 200,
      y: 120,
      width: 800,
      height: 600,
    });
  });

  it("derives the crop reference from the tile-visible region when cover overflow exists", () => {
    const store = useMosaicStore();
    const photo = makePhoto({
      layoutCrop: { x: 200, y: 120, width: 800, height: 900 },
      tileRect: { x: 300, y: 250, w: 400, h: 300 },
      scale: 0.5,
    });
    store.photos.push(photo);

    store.enterCropMode(photo.id);

    expect(store.getCropModeReferenceCrop(photo.id)).toEqual({
      x: 200,
      y: 270,
      width: 800,
      height: 600,
    });
  });

  it("applies crop edits back into layoutCrop for tiled photos", () => {
    const store = useMosaicStore();
    const photo = makePhoto();
    store.photos.push(photo);
    store.enterCropMode(photo.id);

    store.applyCropLocal(
      photo.id,
      { x: 240, y: 160, width: 720, height: 540 },
      0.56,
    );

    expect(photo.crop).toEqual({ x: 120, y: 90, width: 1200, height: 900 });
    expect(photo.layoutCrop).toEqual({ x: 240, y: 160, width: 720, height: 540 });
    expect(photo.scale).toBeCloseTo(0.56, 6);
  });
});
