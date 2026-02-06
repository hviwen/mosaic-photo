# MediaPipe Tasks Vision 资源说明

本目录用于离线加载 MediaPipe Tasks Vision 的 wasm / 模型文件。

## 你需要准备的文件

1. `wasm/`：Tasks Vision wasm 文件目录  
2. `models/face_detector.tflite`：人脸检测模型  
3. `models/object_detector.tflite`：对象检测模型  
4. `tasks-vision.js`：Tasks Vision 的 ESM bundle（从 `@mediapipe/tasks-vision` 拷贝/生成）

> 由于仓库不包含模型文件与第三方 bundle，你需要在本地准备后放入以上路径。

## 推荐做法

1. 安装依赖：`pnpm add @mediapipe/tasks-vision`
2. 运行脚本：`node scripts/prepare-mediapipe-assets.mjs`

脚本会尝试把 `@mediapipe/tasks-vision` 包内的 bundle 与 wasm 目录拷贝到本目录（若找不到，会提示你手动处理）。

