import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoEntity } from "@/types";

const getAssetBlob = vi.fn();
const canvasToBlob = vi.fn();
const downloadBlob = vi.fn();

vi.mock("@/project/assets", () => ({
  getAssetBlob,
}));

vi.mock("@/utils/image", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/image")>();
  return {
    ...actual,
    canvasToBlob,
    downloadBlob,
  };
});

const { exportMosaicWithOptions } = await import("@/composables/useExport");

function makePhoto(overrides: Partial<PhotoEntity> = {}): PhotoEntity {
  return {
    id: "photo-1",
    name: "source.heic",
    srcUrl: "blob:preview",
    assetId: "asset-1",
    image: { kind: "preview-canvas" } as unknown as CanvasImageSource,
    sourceWidth: 2400,
    sourceHeight: 1800,
    imageWidth: 1200,
    imageHeight: 900,
    crop: { x: 0, y: 0, width: 1200, height: 900 },
    adjustments: {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      preset: "none",
    },
    cx: 600,
    cy: 450,
    scale: 1,
    rotation: 0,
    zIndex: 0,
    ...overrides,
  };
}

describe("exportMosaicWithOptions", () => {
  beforeEach(() => {
    getAssetBlob.mockReset();
    canvasToBlob.mockReset();
    downloadBlob.mockReset();
    canvasToBlob.mockResolvedValue(new Blob(["ok"], { type: "image/png" }));

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      filter: "none",
      fillStyle: "#fff",
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn(),
    };

    vi.stubGlobal("document", {
      createElement: vi.fn((tagName: string) => {
        if (tagName === "canvas") return canvas as unknown as HTMLCanvasElement;
        throw new Error(`Unexpected element creation: ${tagName}`);
      }),
    });

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException(
          "The source image cannot be decoded.",
          "EncodingError",
        );
      }),
    );

    class FailingImage {
      decoding = "async";
      src = "";
      async decode() {
        throw new DOMException(
          "The source image cannot be decoded.",
          "EncodingError",
        );
      }
    }

    vi.stubGlobal("Image", FailingImage as unknown as typeof Image);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:asset"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("falls back to the in-memory preview when the original asset cannot be decoded", async () => {
    const photo = makePhoto();
    getAssetBlob.mockResolvedValue(new Blob(["bad"], { type: "image/heic" }));

    await exportMosaicWithOptions(
      {
        canvasWidth: 1200,
        canvasHeight: 900,
        sortedPhotos: [photo],
        exportFormat: "png",
        exportQuality: 0.92,
        exportResolution: "original",
      },
      { qualityMode: "original" },
    );

    expect(canvasToBlob).toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });
});
