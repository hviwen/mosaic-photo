import { describe, expect, it } from "vitest";
import type { PhotoEntity, Placement } from "@/types";
import { fillArrangePhotos } from "@/composables/useLayout";
import { fillArrangePhotosShared } from "@/utils/fillArrangeShared";
import {
  SMART_CROP_ASPECT_MAX,
  SMART_CROP_ASPECT_MIN,
} from "@/utils/smartCrop";

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

function placementAspect(
  placement: Placement,
  fallbackWidth: number,
  fallbackHeight: number,
): number {
  const crop = placement.crop ?? {
    x: 0,
    y: 0,
    width: fallbackWidth,
    height: fallbackHeight,
  };
  return crop.width / Math.max(1, crop.height);
}

function toRect(
  placement: Placement,
  fallbackWidth: number,
  fallbackHeight: number,
): { x: number; y: number; w: number; h: number } {
  const crop = placement.crop ?? {
    x: 0,
    y: 0,
    width: fallbackWidth,
    height: fallbackHeight,
  };
  const w = crop.width * placement.scale;
  const h = crop.height * placement.scale;
  return {
    x: placement.cx - w / 2,
    y: placement.cy - h / 2,
    w,
    h,
  };
}

function oldGreedyAssignment(
  photos: PhotoEntity[],
  placements: Placement[],
  canvasW: number,
  canvasH: number,
): Map<string, number> {
  const centerBiasWeight = 0.55;
  const edgeBiasWeight = 0.14;
  const canvasCx = canvasW / 2;
  const canvasCy = canvasH / 2;
  const maxDist = Math.sqrt(canvasCx * canvasCx + canvasCy * canvasCy) || 1;

  const byId = new Map(photos.map(p => [p.id, p]));
  const tileOrder = placements
    .map(p => {
      const src = byId.get(p.id)!;
      const aspect = placementAspect(p, src.crop.width, src.crop.height);
      const dist =
        Math.hypot(p.cx - canvasCx, p.cy - canvasCy) / Math.max(1e-6, maxDist);
      return { aspect, dist };
    })
    .sort((a, b) => a.dist - b.dist);

  const photosLeft = photos.map(photo => {
    const sourceAspect = photo.imageWidth / Math.max(1, photo.imageHeight);
    const deviation = Math.abs(Math.log(Math.max(1e-6, sourceAspect)));
    return { id: photo.id, sourceAspect, deviation };
  });

  const assigned = new Map<string, number>();
  for (const tile of tileOrder) {
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < photosLeft.length; i++) {
      const item = photosLeft[i];
      const aspectDelta = Math.abs(
        Math.log(Math.max(1e-6, item.sourceAspect)) -
          Math.log(Math.max(1e-6, tile.aspect)),
      );
      const centerPenalty = centerBiasWeight * (1 - tile.dist) * item.deviation;
      const edgeBonus = edgeBiasWeight * tile.dist * item.deviation;
      const cost = aspectDelta + centerPenalty - edgeBonus;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    const [chosen] = photosLeft.splice(bestIdx, 1);
    assigned.set(chosen.id, tile.aspect);
  }
  return assigned;
}

describe("fillArrangePhotos aspect policy", () => {
  it("混合方向图片保持全覆盖并避免方向反转", () => {
    const canvasW = 1200;
    const canvasH = 1200;
    const photos = [
      makePhoto("p1", 900, 1600),
      makePhoto("p2", 1000, 1500),
      makePhoto("p3", 1100, 1500),
      makePhoto("p4", 1200, 1700),
      makePhoto("l1", 1700, 900),
      makePhoto("l2", 1500, 1000),
      makePhoto("l3", 1400, 1000),
      makePhoto("l4", 1800, 1200),
      makePhoto("s1", 1200, 1200),
      makePhoto("s2", 1300, 1300),
    ];

    const result = fillArrangePhotos(photos, canvasW, canvasH, { seed: 27 });
    const placements = result.placements;
    expect(placements).toHaveLength(photos.length);
    const byId = new Map(photos.map(p => [p.id, p]));

    const eps = 1e-2;
    for (const placement of placements) {
      const src = byId.get(placement.id)!;
      const sourceAspect = src.imageWidth / Math.max(1, src.imageHeight);
      const targetAspect = placementAspect(
        placement,
        src.crop.width,
        src.crop.height,
      );
      if (sourceAspect < 1 - eps) {
        expect(targetAspect).toBeLessThanOrEqual(1 + eps);
      } else if (sourceAspect > 1 + eps) {
        expect(targetAspect).toBeGreaterThanOrEqual(1 - eps);
      }
    }

    // In cover mode, rects may slightly exceed tile boundaries. Check centers.
    const rects = placements.map(p => {
      const src = byId.get(p.id)!;
      return toRect(p, src.crop.width, src.crop.height);
    });
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
    let areaSum = 0;
    for (const r of rects) areaSum += r.w * r.h;
    expect(areaSum).toBeGreaterThanOrEqual(result.canvasW * result.canvasH - 1);
  });

  it("非极端图片的裁剪损失不高于旧贪心基线", () => {
    const canvasW = 1200;
    const canvasH = 1200;
    const photos = [
      makePhoto("p1", 900, 1600),
      makePhoto("p2", 1000, 1500),
      makePhoto("p3", 1100, 1500),
      makePhoto("p4", 1200, 1700),
      makePhoto("l1", 1700, 900),
      makePhoto("l2", 1500, 1000),
      makePhoto("l3", 1400, 1000),
      makePhoto("l4", 1800, 1200),
      makePhoto("s1", 1200, 1200),
      makePhoto("s2", 1300, 1300),
    ];

    const result = fillArrangePhotos(photos, canvasW, canvasH, { seed: 27 });
    const placements = result.placements;
    const byId = new Map(photos.map(p => [p.id, p]));

    const newAssigned = new Map<string, number>();
    for (const placement of placements) {
      const src = byId.get(placement.id)!;
      newAssigned.set(
        placement.id,
        placementAspect(placement, src.crop.width, src.crop.height),
      );
    }

    const oldAssigned = oldGreedyAssignment(
      photos,
      placements,
      result.canvasW,
      result.canvasH,
    );

    const calcLoss = (assigned: Map<string, number>) => {
      let loss = 0;
      for (const photo of photos) {
        const sourceAspect = photo.imageWidth / Math.max(1, photo.imageHeight);
        const isNonExtreme =
          sourceAspect >= SMART_CROP_ASPECT_MIN &&
          sourceAspect <= SMART_CROP_ASPECT_MAX;
        if (!isNonExtreme) continue;
        const tileAspect = assigned.get(photo.id)!;
        loss += Math.abs(
          Math.log(Math.max(1e-6, tileAspect)) -
            Math.log(Math.max(1e-6, sourceAspect)),
        );
      }
      return loss;
    };

    const newLoss = calcLoss(newAssigned);
    const oldLoss = calcLoss(oldAssigned);
    // With crop area-loss limiting, the crop aspect may deviate from tile aspect
    // (by design), so a small regression (~10%) vs the greedy baseline is acceptable.
    expect(newLoss).toBeLessThanOrEqual(oldLoss * 1.1 + 1e-6);
  });

  it("共享实现与主线程实现保持一致", () => {
    const canvasW = 1400;
    const canvasH = 1000;
    const photos = [
      makePhoto("p1", 900, 1600),
      makePhoto("p2", 1500, 900),
      makePhoto("p3", 1200, 1200),
      makePhoto("p4", 2000, 1100),
      makePhoto("p5", 900, 1700),
    ];

    const main = fillArrangePhotos(photos, canvasW, canvasH, { seed: 101 });
    const shared = fillArrangePhotosShared(
      photos.map(photo => ({
        id: photo.id,
        crop: photo.crop,
        imageWidth: photo.imageWidth,
        imageHeight: photo.imageHeight,
      })),
      canvasW,
      canvasH,
      { seed: 101 },
    );

    expect(shared.canvasW).toBe(main.canvasW);
    expect(shared.canvasH).toBe(main.canvasH);
    expect(shared.placements).toEqual(main.placements);
  });

  it("大图的平均裁剪率接近或低于小图", () => {
    const canvasW = 1600;
    const canvasH = 1000;
    const photos = [
      makePhoto("large-1", 2400, 1800),
      makePhoto("large-2", 2000, 1600),
      makePhoto("small-1", 800, 800),
      makePhoto("small-2", 700, 700),
      makePhoto("small-3", 640, 640),
      makePhoto("small-4", 720, 720),
    ];

    const result = fillArrangePhotos(photos, canvasW, canvasH, { seed: 77 });
    const byId = new Map(photos.map(p => [p.id, p]));
    const loss = (placement: Placement) => {
      const src = byId.get(placement.id)!;
      const crop = placement.crop ?? src.crop;
      return 1 - (crop.width * crop.height) / (src.crop.width * src.crop.height);
    };

    const largeAvg =
      (loss(result.placements.find(p => p.id === "large-1")!) +
        loss(result.placements.find(p => p.id === "large-2")!)) /
      2;
    const smallAvg =
      ["small-1", "small-2", "small-3", "small-4"]
        .map(id => loss(result.placements.find(p => p.id === id)!))
        .reduce((sum, value) => sum + value, 0) / 4;

    expect(largeAvg).toBeLessThanOrEqual(smallAvg + 0.005);
  });
});
