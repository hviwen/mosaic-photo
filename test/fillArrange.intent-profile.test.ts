import { describe, expect, it } from "vitest";
import type { PhotoEntity } from "@/types";
import { fillArrangePhotos } from "@/composables/useLayout";

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

function makeMixedBatch(): PhotoEntity[] {
  return [
    makePhoto("wide-1", 3400, 900),
    makePhoto("wide-2", 3200, 860),
    makePhoto("wide-3", 3000, 820),
    makePhoto("tall-1", 900, 3400),
    makePhoto("tall-2", 860, 3200),
    makePhoto("tall-3", 820, 3000),
    makePhoto("land-1", 2400, 1600),
    makePhoto("land-2", 2300, 1500),
    makePhoto("land-3", 2200, 1400),
    makePhoto("land-4", 2100, 1350),
    makePhoto("land-5", 2000, 1320),
    makePhoto("land-6", 1900, 1280),
    makePhoto("port-1", 1600, 2400),
    makePhoto("port-2", 1500, 2300),
    makePhoto("port-3", 1400, 2200),
    makePhoto("port-4", 1350, 2100),
    makePhoto("port-5", 1320, 2000),
    makePhoto("port-6", 1280, 1900),
    makePhoto("square-1", 900, 900),
    makePhoto("square-2", 940, 940),
    makePhoto("square-3", 980, 980),
    makePhoto("square-4", 1020, 1020),
    makePhoto("square-5", 1060, 1060),
    makePhoto("square-6", 1100, 1100),
  ];
}

describe("fillArrangePhotos intent-aware profiles", () => {
  it("same input and intent produce deterministic layouts without an explicit seed", () => {
    const photos = makeMixedBatch();
    const options = {
      searchOptions: {
        mode: "deep" as const,
        intent: "auto-import" as const,
        allowCanvasResize: true,
        allowLocalRepair: true,
        maxSearchRounds: 12,
      },
    };

    const first = fillArrangePhotos(photos, 2400, 1800, options);
    const second = fillArrangePhotos(photos, 2400, 1800, options);

    expect(second).toEqual(first);
  }, 15000);

  it("confirmed relayout keeps the stronger deep profile and is not worse than auto-import", () => {
    const photos = makeMixedBatch();
    const autoImport = fillArrangePhotos(photos, 2400, 1800, {
      searchOptions: {
        mode: "deep",
        intent: "auto-import",
        allowCanvasResize: true,
        allowLocalRepair: true,
        maxSearchRounds: 12,
      },
    });
    const confirmed = fillArrangePhotos(photos, 2400, 1800, {
      searchOptions: {
        mode: "deep",
        intent: "confirmed-relayout",
        allowCanvasResize: true,
        allowLocalRepair: true,
        maxSearchRounds: 10,
      },
    });

    expect(autoImport.quality).toBeDefined();
    expect(confirmed.quality).toBeDefined();
    expect(confirmed.metrics.continuousRefinements).toBeGreaterThan(0);
    expect(confirmed.metrics.elasticTrials).toBeGreaterThanOrEqual(
      autoImport.metrics.elasticTrials,
    );
    expect(confirmed.quality!.worstCropLoss).toBeLessThanOrEqual(
      autoImport.quality!.worstCropLoss + 1e-6,
    );
    expect(confirmed.quality!.photosOverSoftCropThreshold).toBeLessThanOrEqual(
      autoImport.quality!.photosOverSoftCropThreshold,
    );
  }, 20000);
});
