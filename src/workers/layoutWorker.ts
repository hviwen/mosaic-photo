/// <reference lib="webworker" />

import type { CropRect, FillArrangeResult } from "@/types";
import type { SmartDetection } from "@/utils/smartCrop";
import {
  fillArrangePhotosShared,
  type FillArrangeOptions,
} from "@/utils/fillArrangeShared";

type FillArrangePhotoInput = {
  id: string;
  crop: CropRect;
  imageWidth: number;
  imageHeight: number;
  detections?: SmartDetection[];
};

type FillArrangeRequest = {
  id: number;
  type: "fillArrange";
  photos: FillArrangePhotoInput[];
  canvasW: number;
  canvasH: number;
  options?: FillArrangeOptions;
};

type FillArrangeResponse =
  | { id: number; ok: true; result: FillArrangeResult }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<FillArrangeRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== "fillArrange") return;

  try {
    const result = fillArrangePhotosShared(
      msg.photos,
      msg.canvasW,
      msg.canvasH,
      msg.options,
    );
    const res: FillArrangeResponse = { id: msg.id, ok: true, result };
    self.postMessage(res);
  } catch (err) {
    const res: FillArrangeResponse = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};
