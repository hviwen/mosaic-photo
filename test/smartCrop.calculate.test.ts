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
  it("竖图裁成横向时尽量不切脸（人脸优先）", () => {
    const image = { width: 1000, height: 1500 };
    const targetAspect = 1.5;
    const face: SmartDetection = {
      kind: "face",
      score: 0.9,
      box: { x: 380, y: 80, width: 220, height: 220 },
    };

    const crop = calculateSmartCrop(image, targetAspect, [face]);
    expect(approx(crop.width / crop.height, targetAspect, 1e-2)).toBe(true);

    const safe = expandBox(face.box, 0.12);
    expect(contains(crop, safe)).toBe(true);
    // 更偏向上方：不应把窗口推到很靠下
    expect(crop.y).toBeLessThan(250);
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

  // 优化1：竖图裁剪比例不超过 6:4（1.5）
  it("竖图裁剪比例限制：targetAspect > 1.5 时被夹持到 1.5", () => {
    const image = { width: 700, height: 1200 }; // 竖图，height/width > 1.5
    const targetAspect = 2.5; // 极端横向比例

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    // 应被限制为 ≤ 1.5（允许少量浮点误差）
    expect(actual).toBeLessThanOrEqual(1.5 + 1e-2);
  });

  // 优化1：横图裁剪比例不低于 4:6（0.667）
  it("横图裁剪比例限制：targetAspect < 0.667 时被夹持到 0.667", () => {
    const image = { width: 1600, height: 900 }; // 横图
    const targetAspect = 0.3; // 极端竖向比例

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    // 应被限制为 ≥ 0.667（即 1/1.5）
    expect(actual).toBeGreaterThanOrEqual(1 / 1.5 - 1e-2);
  });

  // 优化1：非极端比例图片，不触发“比例受限”智能裁剪
  it("比例在范围内的竖图不强制限制目标比例", () => {
    const image = { width: 1000, height: 1400 }; // height/width = 1.4
    const targetAspect = 2.0;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    expect(approx(actual, targetAspect, 1e-2)).toBe(true);
  });

  it("比例在范围内的横图不强制限制目标比例", () => {
    const image = { width: 1400, height: 1000 }; // height/width = 0.714
    const targetAspect = 0.5;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    expect(approx(actual, targetAspect, 1e-2)).toBe(true);
  });

  it("正方形图片默认不触发比例受限逻辑", () => {
    const image = { width: 1000, height: 1000 }; // 正方形
    const targetAspect = 2.0;

    const crop = calculateSmartCrop(image, targetAspect, []);
    const actual = crop.width / crop.height;
    expect(approx(actual, targetAspect, 1e-2)).toBe(true);
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
  });
});
