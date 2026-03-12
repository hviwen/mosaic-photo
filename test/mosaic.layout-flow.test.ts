import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FillArrangeResult, LayoutQualitySummary, PhotoEntity } from "@/types";

const { fillArrangePhotos } = vi.hoisted(() => ({
  fillArrangePhotos: vi.fn(),
}));

vi.mock("@/composables/useLayout", () => ({
  fillArrangePhotos,
}));

vi.mock("@/project/assets", () => ({
  createAssetId: vi.fn(() => "asset-1"),
  putAsset: vi.fn(async () => undefined),
}));

vi.mock("@/utils/smartCrop", () => ({
  getSmartDetections: vi.fn(() => undefined),
  invalidateSmartDetections: vi.fn(),
  onSmartDetectionsChanged: vi.fn(() => () => undefined),
  prefetchSmartDetections: vi.fn(),
  seedSmartDetections: vi.fn(),
}));

vi.mock("@/vision/visionClient", () => ({
  getVisionClient: vi.fn(() => ({
    isEnabled: vi.fn(() => false),
    processFile: vi.fn(),
  })),
}));

const { useMosaicStore } = await import("@/stores/mosaic");

function makePhoto(id: string): PhotoEntity {
  return {
    id,
    name: id,
    srcUrl: "blob:preview",
    image: {} as unknown as CanvasImageSource,
    imageWidth: 1800,
    imageHeight: 1200,
    crop: { x: 0, y: 0, width: 1800, height: 1200 },
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

function makeMixedBatch(count: number): PhotoEntity[] {
  const photos: PhotoEntity[] = [];
  for (let i = 0; i < count; i++) {
    const ratioBucket = i % 6;
    const [width, height] =
      ratioBucket === 0
        ? [3600 + i * 3, 900 + (i % 5) * 20]
        : ratioBucket === 1
          ? [900 + (i % 5) * 20, 3600 + i * 3]
          : ratioBucket === 2
            ? [2400 + (i % 7) * 30, 1600 + (i % 4) * 20]
            : ratioBucket === 3
              ? [1600 + (i % 4) * 20, 2400 + (i % 7) * 30]
              : ratioBucket === 4
                ? [960 + (i % 6) * 10, 960 + (i % 6) * 10]
                : [1500 + (i % 8) * 25, 1100 + (i % 6) * 15];

    photos.push({
      ...makePhoto(`photo-${i}`),
      imageWidth: width,
      imageHeight: height,
      crop: { x: 0, y: 0, width, height },
    });
  }
  return photos;
}

function makeQuality(
  overrides: Partial<LayoutQualitySummary> = {},
): LayoutQualitySummary {
  return {
    worstCropLoss: 0.12,
    averageCropLoss: 0.06,
    sizeWeightedAverageCropLoss: 0.06,
    photosOverSoftCropThreshold: 2,
    photosOverCropThreshold: 2,
    photosCutRequiredRegions: 0,
    orientationViolations: 0,
    canvasDeltaRatio: 0,
    softCropThreshold: 0.08,
    accepted: false,
    ...overrides,
  };
}

function makeResult(
  photo: PhotoEntity,
  quality: Partial<LayoutQualitySummary>,
  placementOverrides?: Partial<FillArrangeResult["placements"][number]>,
): FillArrangeResult {
  return {
    placements: [
      {
        id: photo.id,
        cx: placementOverrides?.cx ?? 500,
        cy: placementOverrides?.cy ?? 400,
        scale: placementOverrides?.scale ?? 0.4,
        rotation: placementOverrides?.rotation ?? 0,
        crop: placementOverrides?.crop ?? photo.crop,
        tileRect: placementOverrides?.tileRect ?? { x: 0, y: 0, w: 900, h: 600 },
      },
    ],
    canvasW: 1600,
    canvasH: 1000,
    metrics: {
      evaluatedPairs: 10,
      cacheHits: 0,
      cacheMisses: 10,
      orientationViolations: 0,
      canvasAdjustmentsTried: 1,
      elasticTrials: 8,
      elasticAccepted: 1,
      localRetileAccepted: 0,
      continuousRefinements: 0,
    },
    quality: makeQuality(quality),
  };
}

function makeBatchResult(
  photos: PhotoEntity[],
  quality: Partial<LayoutQualitySummary>,
  canvasW: number,
  canvasH: number,
): FillArrangeResult {
  return {
    placements: photos.map((photo, index) => ({
      id: photo.id,
      cx: 120 + (index % 12) * 80,
      cy: 120 + Math.floor(index / 12) * 80,
      scale: 0.12,
      rotation: 0,
      crop: photo.crop,
      tileRect: { x: (index % 12) * 60, y: Math.floor(index / 12) * 60, w: 56, h: 56 },
    })),
    canvasW,
    canvasH,
    metrics: {
      evaluatedPairs: 100,
      cacheHits: 20,
      cacheMisses: 80,
      orientationViolations: 0,
      canvasAdjustmentsTried: 1,
      elasticTrials: 24,
      elasticAccepted: 3,
      localRetileAccepted: 1,
      continuousRefinements: 4,
    },
    quality: makeQuality(quality),
  };
}

describe("mosaic store layout flow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fillArrangePhotos.mockReset();
  });

  it("reuses the current applied layout as the assess baseline without recomputing", async () => {
    const store = useMosaicStore();
    const photo = makePhoto("photo-1");
    const baseline = makeResult(photo, {
      worstCropLoss: 0.14,
      averageCropLoss: 0.07,
      sizeWeightedAverageCropLoss: 0.065,
      photosOverSoftCropThreshold: 3,
      photosOverCropThreshold: 2,
    });

    store.photos.push(photo);
    fillArrangePhotos.mockReturnValueOnce(baseline);

    await store.autoLayoutAsync();
    const assessed = await store.autoLayoutAssess();

    expect(assessed).toEqual(baseline);
    expect(store.lastLayoutResult).toEqual(baseline);
    expect(store.lastLayoutSignature).toContain("1600x1000");
    expect(store.lastLayoutSeed).not.toBeNull();
    expect(fillArrangePhotos).toHaveBeenCalledTimes(1);
  });

  it("applies objectively better deep-relayout results even when the improvement is small", async () => {
    const store = useMosaicStore();
    const photo = makePhoto("photo-1");
    const baseline = makeResult(photo, {
      worstCropLoss: 0.11,
      averageCropLoss: 0.055,
      sizeWeightedAverageCropLoss: 0.055,
      photosOverSoftCropThreshold: 2,
      photosOverCropThreshold: 2,
    });
    const improved = makeResult(
      photo,
      {
        worstCropLoss: 0.105,
        averageCropLoss: 0.054,
        sizeWeightedAverageCropLoss: 0.054,
        photosOverSoftCropThreshold: 2,
        photosOverCropThreshold: 2,
      },
      { cx: 520, tileRect: { x: 20, y: 0, w: 880, h: 600 } },
    );

    store.photos.push(photo);
    fillArrangePhotos.mockReturnValueOnce(baseline).mockReturnValueOnce(improved);

    await store.autoLayoutAsync();
    const outcome = await store.autoLayoutDeepSearchConfirmed(baseline);

    expect(outcome.improved).toBe(true);
    expect(outcome.baselineAlreadyApplied).toBe(true);
    expect(outcome.appliedResult).toEqual(improved);
    expect(store.lastLayoutResult).toEqual(improved);
    expect(fillArrangePhotos).toHaveBeenNthCalledWith(
      2,
      store.photos,
      store.canvasWidth,
      store.canvasHeight,
      expect.objectContaining({
        searchOptions: expect.objectContaining({
          intent: "confirmed-relayout",
          mode: "deep",
        }),
      }),
    );
  });

  it("keeps the current applied layout when deep relayout is not better", async () => {
    const store = useMosaicStore();
    const photo = makePhoto("photo-1");
    const baseline = makeResult(photo, {
      worstCropLoss: 0.11,
      averageCropLoss: 0.055,
      sizeWeightedAverageCropLoss: 0.055,
      photosOverSoftCropThreshold: 2,
      photosOverCropThreshold: 2,
    });
    const worse = makeResult(
      photo,
      {
        worstCropLoss: 0.113,
        averageCropLoss: 0.057,
        sizeWeightedAverageCropLoss: 0.057,
        photosOverSoftCropThreshold: 3,
        photosOverCropThreshold: 2,
      },
      { cx: 540, tileRect: { x: 40, y: 0, w: 860, h: 600 } },
    );

    store.photos.push(photo);
    fillArrangePhotos.mockReturnValueOnce(baseline).mockReturnValueOnce(worse);

    await store.autoLayoutAsync();
    const outcome = await store.autoLayoutDeepSearchConfirmed(baseline);

    expect(outcome.improved).toBe(false);
    expect(outcome.baselineAlreadyApplied).toBe(true);
    expect(outcome.appliedResult).toEqual(baseline);
    expect(store.lastLayoutResult).toEqual(baseline);
  });

  it("uses the 136-photo quality-first profile with a stable auto-import seed and stronger confirmed relayout options", async () => {
    const store = useMosaicStore();
    const photos = makeMixedBatch(136);
    const baseline = makeBatchResult(
      photos,
      {
        worstCropLoss: 0.19,
        averageCropLoss: 0.08,
        sizeWeightedAverageCropLoss: 0.082,
        photosOverSoftCropThreshold: 30,
        photosOverCropThreshold: 12,
      },
      store.canvasWidth,
      store.canvasHeight,
    );
    const improved = makeBatchResult(
      photos,
      {
        worstCropLoss: 0.17,
        averageCropLoss: 0.076,
        sizeWeightedAverageCropLoss: 0.079,
        photosOverSoftCropThreshold: 26,
        photosOverCropThreshold: 10,
      },
      store.canvasWidth,
      store.canvasHeight,
    );

    store.photos.push(...photos);
    fillArrangePhotos
      .mockReturnValueOnce(baseline)
      .mockReturnValueOnce(baseline)
      .mockReturnValueOnce(improved);

    await store.autoLayoutAsync();
    await store.autoLayoutAsync();
    const outcome = await store.autoLayoutDeepSearchConfirmed(baseline);

    const firstCallOptions = fillArrangePhotos.mock.calls[0][3];
    const secondCallOptions = fillArrangePhotos.mock.calls[1][3];
    const thirdCallOptions = fillArrangePhotos.mock.calls[2][3];

    expect(firstCallOptions.searchOptions).toEqual(
      expect.objectContaining({
        mode: "deep",
        intent: "auto-import",
        allowLocalRepair: false,
        maxSearchRounds: 4,
      }),
    );
    expect(secondCallOptions.seed).toBe(firstCallOptions.seed);
    expect(thirdCallOptions.searchOptions).toEqual(
      expect.objectContaining({
        mode: "deep",
        intent: "confirmed-relayout",
        maxSearchRounds: 10,
      }),
    );
    expect(outcome.improved).toBe(true);
    expect(outcome.appliedResult).toEqual(improved);
  });
});
