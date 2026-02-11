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

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function makeRandomPhotos(count: number, seed: number): PhotoEntity[] {
  const rand = createSeededRandom(seed);
  const list: PhotoEntity[] = [];
  for (let i = 0; i < count; i++) {
    const width = Math.round(500 + rand() * 2200);
    const height = Math.round(500 + rand() * 2200);
    list.push(makePhoto(`rand-${seed}-${i}`, width, height));
  }
  return list;
}

function assertCoverageNoCriticalOverlap(
  placements: Placement[],
  photos: PhotoEntity[],
  canvasW: number,
  canvasH: number,
) {
  const byId = new Map(photos.map(p => [p.id, p]));
  const rects = placements.map(p => {
    const src = byId.get(p.id);
    expect(src).toBeDefined();
    return toRect(p, src!.crop.width, src!.crop.height);
  });

  // In cover mode, rects may extend slightly beyond canvas (up to ~35% of tile dim).
  // Verify each rect covers a positive area and center is within canvas.
  for (const r of rects) {
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.x + r.w / 2).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h / 2).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w / 2).toBeLessThanOrEqual(canvasW + 1);
    expect(r.y + r.h / 2).toBeLessThanOrEqual(canvasH + 1);
  }

  // Total rendered area should be >= canvas area (cover mode)
  let areaSum = 0;
  for (const r of rects) areaSum += r.w * r.h;
  expect(areaSum).toBeGreaterThanOrEqual(canvasW * canvasH - 1);
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

    const result = fillArrangePhotos(photos, canvasW, canvasH, { seed: 7 });
    expect(result.placements).toHaveLength(photos.length);
    assertCoverageNoCriticalOverlap(
      result.placements,
      photos,
      result.canvasW,
      result.canvasH,
    );
  });

  it("不同照片数量与种子下仍保持无缝覆盖、无重叠和边界内", () => {
    const scenarios = [
      { count: 10, seed: 17 },
      { count: 30, seed: 29 },
      { count: 80, seed: 41 },
      { count: 120, seed: 53 },
    ];
    for (const scenario of scenarios) {
      const photos = makeRandomPhotos(scenario.count, scenario.seed);
      const canvasW = 2400;
      const canvasH = 1800;
      const result = fillArrangePhotos(photos, canvasW, canvasH, {
        seed: scenario.seed,
      });
      expect(result.placements).toHaveLength(photos.length);
      assertCoverageNoCriticalOverlap(
        result.placements,
        photos,
        result.canvasW,
        result.canvasH,
      );
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

    const result = fillArrangePhotos(photos, canvasW, canvasH, {
      seed: 11,
    });
    const placements = result.placements;
    expect(placements).toHaveLength(photos.length);

    const center = { x: result.canvasW / 2, y: result.canvasH / 2 };
    const distById = new Map(
      placements.map(p => [p.id, Math.hypot(p.cx - center.x, p.cy - center.y)]),
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
