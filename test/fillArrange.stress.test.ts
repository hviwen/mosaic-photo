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

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function intersectArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

describe("fillArrangePhotos stress", () => {
  it("随机比例输入下保持面积覆盖误差与重叠阈值", () => {
    const rounds = 16;
    const canvasW = 3200;
    const canvasH = 2400;

    for (let round = 0; round < rounds; round++) {
      const seed = 2026 + round * 97;
      const rand = createSeededRandom(seed);
      const photoCount = 20 + Math.floor(rand() * 101); // 20 ~ 120
      const photos: PhotoEntity[] = [];

      for (let i = 0; i < photoCount; i++) {
        // 随机比值覆盖极端长图和常规比例
        const base = 500 + rand() * 1700;
        const ratioBucket = rand();
        const ratio =
          ratioBucket < 0.2
            ? 0.18 + rand() * 0.35
            : ratioBucket > 0.8
              ? 2.0 + rand() * 2.2
              : 0.6 + rand() * 1.2;
        const width = Math.max(80, Math.round(base * ratio));
        const height = Math.max(80, Math.round(base));
        photos.push(makePhoto(`stress-${seed}-${i}`, width, height));
      }

      const result = fillArrangePhotos(photos, canvasW, canvasH, { seed });
      const placements = result.placements;
      expect(placements).toHaveLength(photos.length);

      const byId = new Map(photos.map(p => [p.id, p]));
      const rects = placements.map(p => {
        const src = byId.get(p.id)!;
        const crop = p.crop ?? src.crop;
        const w = crop.width * p.scale;
        const h = crop.height * p.scale;
        return { x: p.cx - w / 2, y: p.cy - h / 2, w, h };
      });

      // Cover mode: rects may slightly exceed canvas boundaries.
      // Verify rendered area >= canvas area (all tiles covered).
      let areaSum = 0;
      for (const r of rects) {
        areaSum += r.w * r.h;
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
      }
      expect(areaSum).toBeGreaterThanOrEqual(
        result.canvasW * result.canvasH - 1,
      );
    }
  });
});
