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

function rectIntersectionArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

describe("fillArrangePhotos elastic seam optimization", () => {
  it("deep 模式下 tileRect 仍然精确铺满画布且无重叠", () => {
    const photos = [
      makePhoto("large-1", 2400, 1800),
      makePhoto("large-2", 2000, 1600),
      makePhoto("small-1", 800, 800),
      makePhoto("small-2", 700, 700),
      makePhoto("small-3", 640, 640),
      makePhoto("small-4", 720, 720),
    ];

    const result = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: {
        mode: "deep",
        allowCanvasResize: true,
        allowLocalRepair: true,
        maxSearchRounds: 16,
      },
    });

    expect(result.metrics.elasticTrials).toBeGreaterThan(0);
    const tiles = result.placements.map(item => item.tileRect);
    expect(tiles.every(Boolean)).toBe(true);

    const rects = tiles.map(tile => tile!);
    const areaSum = rects.reduce((sum, rect) => sum + rect.w * rect.h, 0);
    expect(areaSum).toBe(result.canvasW * result.canvasH);

    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(result.canvasW);
      expect(rect.y + rect.h).toBeLessThanOrEqual(result.canvasH);
      expect(rect.w).toBeGreaterThan(0);
      expect(rect.h).toBeGreaterThan(0);
    }

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectIntersectionArea(rects[i], rects[j])).toBeLessThanOrEqual(1);
      }
    }
  });

  it("standard 保持轻量，extended/deep 启用连续细化", () => {
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
      searchOptions: { mode: "standard", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 12 },
    });
    const extended = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "extended", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 12 },
    });
    const deep = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "deep", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 16 },
    });

    expect(standard.metrics.elasticTrials).toBeGreaterThan(0);
    expect(standard.metrics.continuousRefinements).toBe(0);
    expect(standard.metrics.localRetileAccepted).toBe(0);

    expect(extended.metrics.continuousRefinements).toBeGreaterThan(0);
    expect(deep.metrics.continuousRefinements).toBeGreaterThanOrEqual(
      extended.metrics.continuousRefinements,
    );
    expect(deep.metrics.elasticTrials).toBeGreaterThanOrEqual(
      standard.metrics.elasticTrials,
    );
  });

  it("elastic 优化不会让大图加权裁剪质量劣于 standard", () => {
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
      searchOptions: { mode: "standard", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 12 },
    });
    const deep = fillArrangePhotos(photos, 1600, 1000, {
      seed: 77,
      searchOptions: { mode: "deep", allowCanvasResize: true, allowLocalRepair: true, maxSearchRounds: 16 },
    });

    expect(standard.quality).toBeDefined();
    expect(deep.quality).toBeDefined();
    expect(deep.quality!.sizeWeightedAverageCropLoss).toBeLessThanOrEqual(
      standard.quality!.sizeWeightedAverageCropLoss + 1e-6,
    );
    expect(deep.quality!.orientationViolations).toBeLessThanOrEqual(
      standard.quality!.orientationViolations,
    );
  });
});
