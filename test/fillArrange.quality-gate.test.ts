import { describe, expect, it } from "vitest";
import type { CropRect, PhotoEntity } from "@/types";
import type { KeepRegion } from "@/types/vision";
import { fillArrangePhotos } from "@/composables/useLayout";
import { fillArrangePhotosShared } from "@/utils/fillArrangeShared";

function makePhoto(id: string, width: number, height: number): PhotoEntity {
  return {
    id,
    name: id,
    srcUrl: "",
    image: {} as unknown as CanvasImageSource,
    imageWidth: width,
    imageHeight: height,
    crop: { x: 0, y: 0, width, height },
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
  };
}

function intersectionArea(a: CropRect, b: CropRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

describe("fillArrangePhotos quality gate", () => {
  it("standard search returns quality diagnostics for hard mixed-composition input", () => {
    const photos = [
      makePhoto("large-1", 2400, 1800),
      makePhoto("large-2", 2000, 1600),
      makePhoto("small-1", 800, 800),
      makePhoto("small-2", 700, 700),
      makePhoto("small-3", 640, 640),
      makePhoto("small-4", 720, 720),
    ];

    const standard = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "standard" },
    });

    expect(standard.quality).toBeDefined();
    expect(standard.quality!.softCropThreshold).toBeCloseTo(0.08, 6);
    expect(standard.quality!.worstCropLoss).toBeGreaterThan(0);
    if (!standard.quality!.accepted) {
      expect(standard.quality!.reason).toBeTruthy();
    }
  });

  it("deep search is not worse than standard on crop-loss gate and canvas delta", () => {
    const photos = [
      makePhoto("large-1", 2400, 1800),
      makePhoto("large-2", 2000, 1600),
      makePhoto("small-1", 800, 800),
      makePhoto("small-2", 700, 700),
      makePhoto("small-3", 640, 640),
      makePhoto("small-4", 720, 720),
    ];

    const standard = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "standard" },
    });
    const deep = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "deep", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 16 },
    });

    expect(deep.quality).toBeDefined();
    expect(standard.quality).toBeDefined();
    expect(deep.quality!.worstCropLoss).toBeLessThanOrEqual(
      standard.quality!.worstCropLoss + 1e-6,
    );
    expect(deep.quality!.photosOverCropThreshold).toBeLessThanOrEqual(
      standard.quality!.photosOverCropThreshold,
    );
    expect(deep.quality!.canvasDeltaRatio).toBeLessThanOrEqual(0.15 + 1e-6);
  });

  it("face keep regions remain fully visible after layout", () => {
    const detections: KeepRegion[] = [
      {
        kind: "face",
        score: 0.98,
        box: { x: 280, y: 120, width: 260, height: 320 },
      },
    ];
    const result = fillArrangePhotosShared(
      [
        {
          id: "hero",
          crop: { x: 0, y: 0, width: 900, height: 1600 },
          imageWidth: 900,
          imageHeight: 1600,
          detections,
        },
        {
          id: "support",
          crop: { x: 0, y: 0, width: 1200, height: 1200 },
          imageWidth: 1200,
          imageHeight: 1200,
        },
      ],
      1200,
      800,
      { seed: 11, searchOptions: { mode: "deep" } },
    );

    const placement = result.placements.find(item => item.id === "hero");
    expect(placement?.crop).toBeDefined();
    const keepArea = detections[0].box.width * detections[0].box.height;
    const visible = intersectionArea(placement!.crop!, detections[0].box);
    expect(visible).toBeGreaterThanOrEqual(keepArea - 1);
  });
});
