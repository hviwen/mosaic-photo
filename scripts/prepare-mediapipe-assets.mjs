import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import https from "node:https";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const outRoot = path.join(repoRoot, "public", "mediapipe");
const outWasm = path.join(outRoot, "wasm");
const outModels = path.join(outRoot, "models");
const outBundle = path.join(outRoot, "tasks-vision.js");

/* ── 模型下载地址（Google Storage 官方） ── */
const MODEL_URLS = {
  "face_detector.tflite":
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
  "object_detector.tflite":
    "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite",
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function findFirstExisting(base, candidates) {
  for (const rel of candidates) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 下载文件（支持 302 重定向，最多跟随 5 次）
 */
function downloadFile(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto
      .get(url, res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (maxRedirects <= 0) return reject(new Error("重定向次数过多"));
          return downloadFile(
            res.headers.location,
            dest,
            maxRedirects - 1,
          ).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        }
        const total = Number(res.headers["content-length"]) || 0;
        let received = 0;
        const ws = fs.createWriteStream(dest);
        res.on("data", chunk => {
          received += chunk.length;
          if (total > 0) {
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(
              `\r  下载进度: ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`,
            );
          }
        });
        res.pipe(ws);
        ws.on("finish", () => {
          if (total > 0) process.stdout.write("\n");
          ws.close(() => resolve());
        });
        ws.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  ensureDir(outRoot);
  ensureDir(outWasm);
  ensureDir(outModels);

  /* ──────── 1. 拷贝 @mediapipe/tasks-vision 中的 WASM 和 ESM bundle ──────── */

  const require = createRequire(import.meta.url);

  let pkgRoot;
  try {
    // 先尝试解析 package.json（某些包可能限制了 exports）
    let resolved;
    try {
      resolved = require.resolve("@mediapipe/tasks-vision/package.json");
      pkgRoot = path.dirname(resolved);
    } catch {
      // 通过主入口回溯到包根目录
      resolved = require.resolve("@mediapipe/tasks-vision");
      pkgRoot = path.dirname(resolved);
      // 确认 package.json 存在于同级目录
      if (!fs.existsSync(path.join(pkgRoot, "package.json"))) {
        throw new Error("无法定位 @mediapipe/tasks-vision 包根目录");
      }
    }
  } catch (e) {
    console.warn(
      "⚠  未安装 @mediapipe/tasks-vision，跳过自动拷贝。请先执行：pnpm add @mediapipe/tasks-vision",
    );
    console.warn("  ", e.message || e);
    process.exit(0);
  }

  // 拷贝 wasm
  const wasmDir = findFirstExisting(pkgRoot, ["wasm"]);
  if (wasmDir && fs.statSync(wasmDir).isDirectory()) {
    console.log("✔ 拷贝 wasm 目录：", wasmDir, "->", outWasm);
    copyDir(wasmDir, outWasm);
  } else {
    console.warn("⚠  未找到 wasm 目录：", path.join(pkgRoot, "wasm"));
  }

  // 拷贝 ESM bundle
  const bundlePath = findFirstExisting(pkgRoot, [
    "vision_bundle.mjs",
    "vision_bundle.js",
    "vision_bundle.min.js",
    "tasks_vision_bundle.mjs",
  ]);

  if (bundlePath) {
    console.log("✔ 拷贝 ESM bundle：", bundlePath, "->", outBundle);
    fs.copyFileSync(bundlePath, outBundle);
  } else {
    console.warn(
      "⚠  未找到可用的 ESM bundle。请在包目录下确认实际文件名，并手动拷贝到：",
      outBundle,
    );
  }

  /* ──────── 2. 自动下载模型文件（若不存在） ──────── */

  for (const [filename, url] of Object.entries(MODEL_URLS)) {
    const dest = path.join(outModels, filename);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      console.log(`✔ 模型已存在，跳过：${filename}`);
      continue;
    }
    console.log(`⬇ 下载模型 ${filename} ...`);
    console.log(`  来源：${url}`);
    try {
      await downloadFile(url, dest);
      const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
      console.log(`✔ 下载完成：${filename} (${size} MB)`);
    } catch (err) {
      console.error(`✖ 下载失败：${filename}`);
      console.error(`  ${err.message}`);
      console.error(`  请手动下载并放置到：${dest}`);
    }
  }

  console.log("\n✔ MediaPipe 资源准备完成！");
}

main();
