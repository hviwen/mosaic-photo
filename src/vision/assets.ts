export type VisionAssets = {
  /**
   * MediaPipe Tasks Vision wasm 文件目录（结尾不带 / 也可）。
   * 示例：/mediapipe/wasm
   */
  wasmBaseUrl: string
  /**
   * Tasks Vision ESM bundle 的 URL（放在 public 下，运行时由浏览器加载）。
   * 示例：/mediapipe/tasks-vision.js
   */
  tasksVisionUrl: string
  faceModelUrl: string
  objectModelUrl: string
}

export const DEFAULT_VISION_ASSETS: VisionAssets = {
  wasmBaseUrl: '/mediapipe/wasm',
  tasksVisionUrl: '/mediapipe/tasks-vision.js',
  faceModelUrl: '/mediapipe/models/face_detector.tflite',
  objectModelUrl: '/mediapipe/models/object_detector.tflite',
}
