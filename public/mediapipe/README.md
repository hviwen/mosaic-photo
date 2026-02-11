# MediaPipe Tasks Vision 资源说明

本目录用于离线加载 MediaPipe Tasks Vision 的 wasm / 模型文件。

## 你需要准备的文件

1. `wasm/`：Tasks Vision wasm 文件目录
2. `models/face_detector.tflite`：人脸检测模型（自动从 Google Storage 下载）
3. `models/object_detector.tflite`：对象检测模型（自动从 Google Storage 下载）
4. `tasks-vision.js`：Tasks Vision 的 ESM bundle（从 `@mediapipe/tasks-vision` 拷贝）

> 这些文件已被 `.gitignore` 排除，不会提交到仓库。每位开发者需在本地执行准备脚本。

## 快速开始

```bash
# 1. 安装依赖（已包含在 pnpm install 中）
pnpm install

# 2. 准备 MediaPipe 资源（自动拷贝 WASM/ESM bundle + 下载模型）
pnpm prepare:mediapipe
```

脚本 `scripts/prepare-mediapipe-assets.mjs` 会自动完成以下工作：

- 从 `@mediapipe/tasks-vision` 包拷贝 WASM 文件到 `wasm/`
- 从包中拷贝 ESM bundle 为 `tasks-vision.js`
- 从 Google Storage 下载人脸检测和对象检测模型到 `models/`

## 模型来源

| 模型                     | 来源 URL                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `face_detector.tflite`   | `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite` |
| `object_detector.tflite` | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite`          |
