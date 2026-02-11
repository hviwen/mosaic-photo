import { describe, expect, it } from "vitest";
import type { PhotoEntity } from "@/types";
import { buildPhotoSelectionInfo } from "@/utils/photoSelectionMetrics";

function makePhoto(): PhotoEntity {
  return {
    id: "p1",
    name: "p1",
    srcUrl: "",
    image: {} as unknown as CanvasImageSource,
    sourceWidth: 4032,
    sourceHeight: 3024,
    imageWidth: 1344,
    imageHeight: 1008,
    crop: { x: 10, y: 20, width: 999.126, height: 555.333 },
    layoutCrop: { x: 1, y: 2, width: 800.1, height: 600.25 },
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
    zIndex: 1,
  };
}

describe("buildPhotoSelectionInfo", () => {
  it("输出原图、用户裁剪、显示裁剪三组信息并保留 2 位比例", () => {
    const info = buildPhotoSelectionInfo(makePhoto());
    expect(info.original.width).toBe(4032);
    expect(info.original.height).toBe(3024);
    expect(info.original.aspect).toBe("1.33");

    expect(info.userCrop.width).toBe("999.13");
    expect(info.userCrop.height).toBe("555.33");
    expect(info.userCrop.aspect).toBe("1.80");

    expect(info.displayCrop.width).toBe("800.10");
    expect(info.displayCrop.height).toBe("600.25");
    expect(info.displayCrop.aspect).toBe("1.33");
  });

  it("原图尺寸缺省时回退到预览尺寸，显示裁剪缺省时回退用户裁剪", () => {
    const photo = makePhoto();
    photo.sourceWidth = undefined;
    photo.sourceHeight = undefined;
    photo.layoutCrop = undefined;
    const info = buildPhotoSelectionInfo(photo);

    expect(info.original.width).toBe(photo.imageWidth);
    expect(info.original.height).toBe(photo.imageHeight);
    expect(info.displayCrop.width).toBe(info.userCrop.width);
    expect(info.displayCrop.height).toBe(info.userCrop.height);
    expect(info.displayCrop.aspect).toBe(info.userCrop.aspect);
  });
});
