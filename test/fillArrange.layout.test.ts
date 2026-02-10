import { describe, expect, it } from "vitest";
import type { PhotoEntity, Placement } from "@/types";
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

function toRect(
  placement: Placement,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const crop = placement.crop ?? { x: 0, y: 0, width, height };
  const w = crop.width * placement.scale;
  const h = crop.height * placement.scale;
  return {
    x: placement.cx - w / 2,
    y: placement.cy - h / 2,
    w,
    h,
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

describe("fillArrangePhotos", () => {
  it("铺满布局无重叠、无缝隙并完全覆盖画布", () => {
    const canvasW = 1200;
    const canvasH = 900;
    const photos = [
      makePhoto("p1", 1600, 1200),
      makePhoto("p2", 1280, 1280),
      makePhoto("p3", 900, 1600),
      makePhoto("p4", 1800, 1200),
      makePhoto("p5", 1000, 1500),
      makePhoto("p6", 1400, 1000),
      makePhoto("p7", 1200, 1700),
      makePhoto("p8", 1700, 1200),
      makePhoto("p9", 1300, 1300),
      makePhoto("p10", 1500, 1000),
      makePhoto("p11", 1000, 1400),
      makePhoto("p12", 1600, 1100),
    ];

    const placements = fillArrangePhotos(photos, canvasW, canvasH, { seed: 7 });
    expect(placements).toHaveLength(photos.length);

    const byId = new Map(photos.map(p => [p.id, p]));
    const rects = placements.map(p => {
      const src = byId.get(p.id);
      expect(src).toBeDefined();
      return toRect(p, src!.crop.width, src!.crop.height);
    });

    const eps = 1e-3;
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-eps);
      expect(r.y).toBeGreaterThanOrEqual(-eps);
      expect(r.x + r.w).toBeLessThanOrEqual(canvasW + eps);
      expect(r.y + r.h).toBeLessThanOrEqual(canvasH + eps);
    }

    let areaSum = 0;
    for (const r of rects) areaSum += r.w * r.h;
    expect(Math.abs(areaSum - canvasW * canvasH)).toBeLessThan(0.5);

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(intersectArea(rects[i], rects[j])).toBeLessThan(0.1);
      }
    }
  });

  it("中心区域优先分配给更接近 1:1 的照片", () => {
    const canvasW = 1000;
    const canvasH = 1000;
    const photos = [
      makePhoto("s1", 1000, 1000),
      makePhoto("s2", 900, 900),
      makePhoto("s3", 1200, 1200),
      makePhoto("w1", 1800, 900),
      makePhoto("w2", 2000, 900),
      makePhoto("w3", 1600, 800),
      makePhoto("t1", 900, 1800),
      makePhoto("t2", 900, 2000),
      makePhoto("t3", 800, 1600),
    ];

    const placements = fillArrangePhotos(photos, canvasW, canvasH, { seed: 11 });
    expect(placements).toHaveLength(photos.length);

    const center = { x: canvasW / 2, y: canvasH / 2 };
    const distById = new Map(
      placements.map(p => [
        p.id,
        Math.hypot(p.cx - center.x, p.cy - center.y),
      ]),
    );

    const squareAvgDist =
      (distById.get("s1")! + distById.get("s2")! + distById.get("s3")!) / 3;
    const stripAvgDist =
      (distById.get("w1")! +
        distById.get("w2")! +
        distById.get("w3")! +
        distById.get("t1")! +
        distById.get("t2")! +
        distById.get("t3")!) /
      6;

    expect(squareAvgDist).toBeLessThan(stripAvgDist);
  });
});
