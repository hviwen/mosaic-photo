import { describe, expect, it } from "vitest";
import type { PhotoEntity } from "@/types";
import { pointInPhoto } from "@/utils/math";

function makePhoto(overrides: Partial<PhotoEntity> = {}): PhotoEntity {
  return {
    id: "photo-1",
    name: "photo-1",
    srcUrl: "blob:preview",
    image: {} as unknown as CanvasImageSource,
    imageWidth: 1600,
    imageHeight: 1200,
    crop: { x: 120, y: 90, width: 1200, height: 900 },
    layoutCrop: { x: 200, y: 120, width: 800, height: 900 },
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

describe("visible hit area for tiled photos", () => {
  it("uses the tile-visible bounds instead of the full cover rect", () => {
    const photo = makePhoto();

    expect(pointInPhoto(photo, photo.cx, photo.cy + 140)).toBe(true);
    expect(pointInPhoto(photo, photo.cx, photo.cy + 180)).toBe(false);
  });
});
