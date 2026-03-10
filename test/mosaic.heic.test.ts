import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { PhotoEntity } from "@/types";

const {
  normalizeImageFileForImport,
  createPhotoFromFile,
  createPreviewUrlFromImageSource,
  processFile,
  isVisionEnabled,
} = vi.hoisted(() => ({
  normalizeImageFileForImport: vi.fn(),
  createPhotoFromFile: vi.fn(),
  createPreviewUrlFromImageSource: vi.fn(),
  processFile: vi.fn(),
  isVisionEnabled: vi.fn(),
}));

vi.mock("@/composables/useLayout", () => ({
  fillArrangePhotos: vi.fn((photos: PhotoEntity[], canvasW: number, canvasH: number) => ({
    placements: photos.map(photo => ({
      id: photo.id,
      cx: 0,
      cy: 0,
      scale: photo.scale,
      rotation: 0,
      crop: photo.crop,
      tileRect: { x: 0, y: 0, w: 100, h: 100 },
    })),
    canvasW,
    canvasH,
  })),
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
    isEnabled: isVisionEnabled,
    processFile,
  })),
}));

vi.mock("@/utils/image", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/image")>();
  return {
    ...actual,
    normalizeImageFileForImport,
    createPhotoFromFile,
    createPreviewUrlFromImageSource,
  };
});

const { useMosaicStore } = await import("@/stores/mosaic");

function makePhoto(overrides: Partial<PhotoEntity> = {}): PhotoEntity {
  return {
    id: "photo-1",
    name: "original.heic",
    srcUrl: "blob:preview",
    image: {} as unknown as CanvasImageSource,
    sourceWidth: 4000,
    sourceHeight: 3000,
    imageWidth: 1000,
    imageHeight: 750,
    crop: { x: 0, y: 0, width: 1000, height: 750 },
    adjustments: {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      preset: "none",
    },
    cx: 0,
    cy: 0,
    scale: 1,
    rotation: 0,
    zIndex: 0,
    ...overrides,
  };
}

describe("mosaic store HEIC flow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    normalizeImageFileForImport.mockReset();
    createPhotoFromFile.mockReset();
    createPreviewUrlFromImageSource.mockReset();
    processFile.mockReset();
    isVisionEnabled.mockReset();

    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:generated"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("normalizes HEIC files before sending them to the vision worker", async () => {
    const store = useMosaicStore();
    const originalFile = new File(["heic"], "holiday.HEIC");
    const normalizedFile = new File(["jpeg"], "holiday.HEIC", {
      type: "image/jpeg",
    });

    normalizeImageFileForImport.mockResolvedValue({
      file: normalizedFile,
      originalFile,
      isTranscoded: true,
    });
    isVisionEnabled.mockReturnValue(true);
    createPreviewUrlFromImageSource.mockResolvedValue("blob:transcoded-preview");
    processFile.mockResolvedValue({
      photoId: "generated-id",
      sourceWidth: 4000,
      sourceHeight: 3000,
      previewWidth: 1000,
      previewHeight: 750,
      previewBitmap: {} as ImageBitmap,
      detections: [],
    });

    const res = await store.addPhotos([originalFile], { concurrency: 1 });

    expect(res.added).toBe(1);
    expect(normalizeImageFileForImport).toHaveBeenCalledWith(originalFile);
    expect(processFile).toHaveBeenCalledWith(
      expect.objectContaining({ file: normalizedFile }),
    );
    expect(store.photos).toHaveLength(1);
    expect(store.photos[0].name).toBe("holiday.HEIC");
  });

  it("reuses the normalized file when replacing a photo", async () => {
    const store = useMosaicStore();
    const current = makePhoto();
    const originalFile = new File(["heic"], "updated.heic");
    const normalizedFile = new File(["jpeg"], "updated.heic", {
      type: "image/jpeg",
    });

    store.photos.push(current);
    normalizeImageFileForImport.mockResolvedValue({
      file: normalizedFile,
      originalFile,
      isTranscoded: true,
    });
    createPhotoFromFile.mockResolvedValue(
      makePhoto({
        id: current.id,
        name: normalizedFile.name,
        srcUrl: "blob:updated",
      }),
    );

    await store.replacePhotoFromFile(current.id, originalFile);

    expect(normalizeImageFileForImport).toHaveBeenCalledWith(originalFile);
    expect(createPhotoFromFile).toHaveBeenCalledWith(
      normalizedFile,
      store.canvasWidth,
      store.canvasHeight,
      { id: current.id },
    );
    expect(store.photos[0].name).toBe("updated.heic");
  });
});
