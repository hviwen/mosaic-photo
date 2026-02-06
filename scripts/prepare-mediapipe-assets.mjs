import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const outRoot = path.join(repoRoot, 'public', 'mediapipe')
const outWasm = path.join(outRoot, 'wasm')
const outModels = path.join(outRoot, 'models')
const outBundle = path.join(outRoot, 'tasks-vision.js')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyDir(src, dst) {
  ensureDir(dst)
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name)
    const to = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function findFirstExisting(base, candidates) {
  for (const rel of candidates) {
    const p = path.join(base, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}

function main() {
  ensureDir(outRoot)
  ensureDir(outWasm)
  ensureDir(outModels)

  const require = createRequire(import.meta.url)

  let pkgJsonPath
  try {
    pkgJsonPath = require.resolve('@mediapipe/tasks-vision/package.json')
  } catch {
    console.warn('未安装 @mediapipe/tasks-vision，跳过自动拷贝。请先执行：pnpm add @mediapipe/tasks-vision')
    process.exit(0)
  }

  const pkgRoot = path.dirname(pkgJsonPath)

  const wasmDir = findFirstExisting(pkgRoot, ['wasm', 'wasm/vision_wasm_internal.wasm'])
  if (wasmDir && fs.statSync(wasmDir).isDirectory()) {
    console.log('拷贝 wasm 目录：', wasmDir, '->', outWasm)
    copyDir(wasmDir, outWasm)
  } else {
    const maybeWasm = path.join(pkgRoot, 'wasm')
    console.warn('未找到 wasm 目录：', maybeWasm)
  }

  const bundlePath = findFirstExisting(pkgRoot, [
    'vision_bundle.mjs',
    'vision_bundle.js',
    'vision_bundle.min.js',
    'tasks_vision_bundle.mjs',
  ])

  if (bundlePath) {
    console.log('拷贝 ESM bundle：', bundlePath, '->', outBundle)
    fs.copyFileSync(bundlePath, outBundle)
  } else {
    console.warn('未找到可用的 ESM bundle。请在包目录下确认实际文件名，并手动拷贝到：', outBundle)
  }

  console.log('完成。模型文件请你自行放置：')
  console.log('-', path.join(outModels, 'face_detector.tflite'))
  console.log('-', path.join(outModels, 'object_detector.tflite'))
}

main()

