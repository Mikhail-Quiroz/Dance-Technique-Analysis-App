// MediaPipe PoseLandmarker setup + skeleton drawing for the /live page.
//
// Runtime decisions (see README "Live coaching assets"):
// - VIDEO running mode driven by requestAnimationFrame, not LIVE_STREAM:
//   detectForVideo() returns synchronously in the same rAF tick, so the
//   skeleton is drawn against the exact frame currently on screen.
//   LIVE_STREAM delivers results in an async callback that can land after
//   the next paint, which makes the overlay visibly lag the video.
// - pose_landmarker_lite model: real-time on ordinary laptops. The upload
//   pipeline (backend) keeps using the full model where accuracy matters
//   more than latency. Swap MODEL_PATH to change variants.
// - wasm + model served from /public (prepared by scripts/copy-mediapipe-wasm.mjs).

import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'

const WASM_PATH = '/mediapipe/wasm'
const MODEL_PATH = '/models/pose_landmarker_lite.task'

export type { NormalizedLandmark }

export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
  try {
    return await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
  } catch {
    // Some machines/browsers fail GPU delegate init — fall back to CPU.
    return await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
  }
}

// MediaPipe 33-point skeleton (same connection list the Python renderer uses).
const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
]

const VIS_THRESH = 0.5
// Zine accent pink for bones/joints, dark outline — mirrors render/overlay.py.
const CLR_BONE = '#e8568f'
const CLR_JOINT = '#e8568f'
const CLR_OUTLINE = '#1a1008'

/**
 * Draw the skeleton onto a canvas that overlays a MIRRORED video preview.
 *
 * The landmark data itself is anatomical/unmirrored — all math must run on
 * the raw coordinates. Only here, at draw time, is x flipped (x' = 1 - x)
 * so the overlay lines up with the CSS-mirrored <video>.
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  mirror = true,
): void {
  const px = (lm: NormalizedLandmark) => ({
    x: (mirror ? 1 - lm.x : lm.x) * width,
    y: lm.y * height,
  })

  ctx.lineCap = 'round'

  for (const [a, b] of CONNECTIONS) {
    const la = landmarks[a]
    const lb = landmarks[b]
    if (!la || !lb) continue
    if ((la.visibility ?? 1) < VIS_THRESH || (lb.visibility ?? 1) < VIS_THRESH) continue
    const pa = px(la)
    const pb = px(lb)
    ctx.strokeStyle = CLR_OUTLINE
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
    ctx.strokeStyle = CLR_BONE
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  }

  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < VIS_THRESH) continue
    const p = px(lm)
    ctx.fillStyle = CLR_JOINT
    ctx.strokeStyle = CLR_OUTLINE
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}
