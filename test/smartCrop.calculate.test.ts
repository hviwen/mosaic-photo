import { describe, expect, it } from "vitest";
import {
  calculateSmartCrop,
  shouldApplySmartCropByImageAspect,
  type SmartDetection,
} from "@/utils/smartCrop";
import type { CropRect } from "@/types";

function approx(a: number, b: number, eps: number = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

function expandBox(box: CropRect, margin: number): CropRect {
  const pad = margin * Math.min(box.width, box.height);
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function contains(
  outer: CropRect,
  inner: CropRect,
  tol: number = 1e-3,
): boolean {
  return (
    outer.x <= inner.x + tol &&
    outer.y <= inner.y + tol &&
    outer.x + outer.width >= inner.x + inner.width - tol &&
    outer.y + outer.height >= inner.y + inner.height - tol
  );
}

describe("calculateSmartCrop", () => {
  it("极端竖图裁剪时优先保脸，且不反转为横向", () => {
    const image = { width: 900, height: 1700 };
    const targetAspect = 1.5;
    const face: SmartDetection = {
      kind: "face",
      score: 0.9,
      box: { x: 320, y: 120, width: 240, height: 240 },
    };

    const crop = calculateSmartCrop(image, targetAspect, [face]);
    const actual = crop.width / crop.height;
    expect(actual).toBeLessThanOrEqual(1 + 1e-2);
    expect(actual).toBeGreaterThanOrEqual(1 / 1.5 - 1e-2);

    const safe = expandBox(face.box, 0.12);
    expect(contains(crop, safe)).toBe(true);
    // 更偏向上方：不应把窗口推到很靠下
    expect(crop.y).toBeLessThan(450);
  });

  it("无人脸时对象框可作为兜底（尽量覆盖主体）", () => {
    const image = { width: 2000, height: 1000 };
    const targetAspect = 1;
    const obj: SmartDetection = {
      kind: "object",
      score: 0.9,
      label: "cat",
      box: { x: 120, y: 260, width: 260, height: 260 },
    };

    const crop = calculateSmartCrop(image, targetAspect, [obj]);
    expect(approx(crop.width / crop.height, targetAspect, 1e-2)).toBe(true);

    const safe = expandBox(obj.box, 0.12);
    expect(contains(crop, safe)).toBe(true);
    expect(crop.x).toBeLessThan(400);
  });

  it("极端竖图：目标比例向 [4:6, 1] 收敛，不会裁成横图", () => {
    const image = { width: 700, height: 1200 }; // 700 / 1200 = 0.583 < 4:6
    const targetAspect = 2.5; // 极端横向目标

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    expect(actual).toBeGreaterThanOrEqual(1 / 1.5 - 1e-2);
    expect(actual).toBeLessThanOrEqual(1 + 1e-2);
    expect(approx(actual, 1, 1e-2)).toBe(true);
  });

  it("极端横图：目标比例向 [1, 6:4] 收敛，不会裁成竖图", () => {
    const image = { width: 1600, height: 900 }; // 1600 / 900 = 1.778 > 6:4
    const targetAspect = 0.3; // 极端竖向目标

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    expect(actual).toBeGreaterThanOrEqual(1 - 1e-2);
    expect(actual).toBeLessThanOrEqual(1.5 + 1e-2);
    expect(approx(actual, 1, 1e-2)).toBe(true);
  });

  it("非极端竖图：裁剪比例偏差不超过 25%", () => {
    const image = { width: 1000, height: 1400 }; // 0.714 在 [4:6, 6:4] 内
    const targetAspect = 2.0;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    const srcAspect = image.width / image.height;
    // With 25% max deviation, clamped to [srcAspect/1.25, srcAspect*1.25]
    expect(actual).toBeGreaterThanOrEqual(srcAspect / 1.25 - 1e-2);
    expect(actual).toBeLessThanOrEqual(srcAspect * 1.25 + 1e-2);
  });

  it("非极端横图：裁剪比例偏差不超过 25%", () => {
    const image = { width: 1400, height: 1000 }; // 1.4 在 [4:6, 6:4] 内
    const targetAspect = 0.5;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    const srcAspect = image.width / image.height;
    expect(actual).toBeGreaterThanOrEqual(srcAspect / 1.25 - 1e-2);
    expect(actual).toBeLessThanOrEqual(srcAspect * 1.25 + 1e-2);
  });

  it("正方形图片：裁剪比例偏差不超过 25%", () => {
    const image = { width: 1000, height: 1000 };
    const targetAspect = 2.0;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    // srcAspect = 1.0, so clamped aspect ∈ [0.8, 1.25]
    expect(actual).toBeGreaterThanOrEqual(0.8 - 1e-2);
    expect(actual).toBeLessThanOrEqual(1.25 + 1e-2);
  });

  it("边界比例 4:6 与 6:4 的裁剪偏差受限", () => {
    const portraitBoundary = { width: 2, height: 3 }; // 4:6 = 0.667
    const landscapeBoundary = { width: 3, height: 2 }; // 6:4 = 1.5

    const cropA = calculateSmartCrop(portraitBoundary, 2, []);
    const cropB = calculateSmartCrop(landscapeBoundary, 0.4, []);

    // Portrait boundary: srcAspect = 0.667, extreme (< SMART_CROP_ASPECT_MIN)
    // Clamped to [SMART_CROP_ASPECT_MIN, 1] = [0.667, 1]
    expect(cropA.width / cropA.height).toBeGreaterThanOrEqual(0.667 - 1e-2);
    expect(cropA.width / cropA.height).toBeLessThanOrEqual(1 + 1e-2);
    // Landscape boundary: srcAspect = 1.5, extreme (>= SMART_CROP_ASPECT_MAX)
    // Clamped to [1, 1.5]
    expect(cropB.width / cropB.height).toBeGreaterThanOrEqual(1 - 1e-2);
    expect(cropB.width / cropB.height).toBeLessThanOrEqual(1.5 + 1e-2);
  });

  // 优化1：人脸最小尺寸保证 100×100
  it("人脸在裁剪框中可见尺寸不小于 100×100", () => {
    const image = { width: 2000, height: 3000 };
    const targetAspect = 1.5;
    const smallFace: SmartDetection = {
      kind: "face",
      score: 0.95,
      box: { x: 900, y: 100, width: 80, height: 80 }, // 很小的人脸
    };

    const crop = calculateSmartCrop(image, targetAspect, [smallFace]);

    // 验证人脸在裁剪框中的可见尺寸
    const visibleW =
      Math.min(smallFace.box.x + smallFace.box.width, crop.x + crop.width) -
      Math.max(smallFace.box.x, crop.x);
    const visibleH =
      Math.min(smallFace.box.y + smallFace.box.height, crop.y + crop.height) -
      Math.max(smallFace.box.y, crop.y);

    // 人脸应完整包含在裁剪框内（可见宽高 == 人脸宽高）
    expect(visibleW).toBeGreaterThanOrEqual(smallFace.box.width - 1);
    expect(visibleH).toBeGreaterThanOrEqual(smallFace.box.height - 1);
  });

  it("按原图比例判断是否启用受限智能裁剪", () => {
    expect(shouldApplySmartCropByImageAspect(700, 1200)).toBe(true); // 竖图 > 1.5
    expect(shouldApplySmartCropByImageAspect(1600, 900)).toBe(true); // 横图 < 0.667
    expect(shouldApplySmartCropByImageAspect(1000, 1400)).toBe(false);
    expect(shouldApplySmartCropByImageAspect(1400, 1000)).toBe(false);
    expect(shouldApplySmartCropByImageAspect(2, 3)).toBe(false); // 4:6 边界
    expect(shouldApplySmartCropByImageAspect(3, 2)).toBe(false); // 6:4 边界
  });
});
