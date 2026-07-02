// Prepares MediaPipe browser assets before dev/build:
//  1. Copies the wasm runtime from node_modules into public/ so the browser
//     loads a wasm build that exactly matches the installed npm package
//     (no CDN, works offline once set up).
//  2. Downloads the pose_landmarker_lite model on first run (models/ is
//     gitignored repo-wide; the backend auto-downloads its model the same way).
import { cpSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// ── wasm runtime ─────────────────────────────────────────────────────────────
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmDst = join(root, 'public', 'mediapipe', 'wasm')

if (!existsSync(wasmSrc)) {
  console.error('[mediapipe-assets] wasm source not found — run npm install first:', wasmSrc)
  process.exit(1)
}
mkdirSync(wasmDst, { recursive: true })
cpSync(wasmSrc, wasmDst, { recursive: true })
console.log('[mediapipe-assets] wasm runtime -> public/mediapipe/wasm')

// ── pose model (download once) ───────────────────────────────────────────────
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
  'pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'
const modelDst = join(root, 'public', 'models', 'pose_landmarker_lite.task')

if (existsSync(modelDst)) {
  console.log('[mediapipe-assets] pose model already present')
} else {
  console.log('[mediapipe-assets] downloading pose_landmarker_lite (~5.5 MB)…')
  const res = await fetch(MODEL_URL)
  if (!res.ok) {
    console.error(`[mediapipe-assets] model download failed: HTTP ${res.status}`)
    process.exit(1)
  }
  mkdirSync(dirname(modelDst), { recursive: true })
  writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()))
  console.log('[mediapipe-assets] pose model -> public/models/pose_landmarker_lite.task')
}
