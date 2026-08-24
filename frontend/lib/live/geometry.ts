// Streaming TS port of utils/geometry.py — kept numerically aligned with the Python
// version (see geometry.test.ts, which mirrors tests/test_geometry.py's cases) since the
// upload pipeline and /live must agree on what an angle or a body scale means.
//
// Two pieces are deliberately NOT a 1:1 port because the batch Python versions see the
// whole clip up front and streaming can't:
//   - compute_body_scale takes one whole-clip median. RunningBodyScale below keeps a
//     rolling median over the last ~3 s of frames with visible shoulders+ankles instead.
//   - smooth_landmarks is a CENTERED 5-frame average (needs future frames). Streaming
//     smoothing here is a trailing moving average.
// compute_rolling_baseline is already causal (trailing median) in Python, so RollingBaseline
// ports it exactly with the same 2.0 s window.

export interface Point {
  x: number
  y: number
}

/** Angle ABC in degrees at vertex b. Returns NaN if either arm has ~zero length. */
export function angleAt(b: Point, a: Point, c: Point): number {
  const ux = a.x - b.x
  const uy = a.y - b.y
  const vx = c.x - b.x
  const vy = c.y - b.y
  const normU = Math.hypot(ux, uy)
  const normV = Math.hypot(vx, vy)
  if (normU < 1e-9 || normV < 1e-9) return NaN
  let cosTheta = (ux * vx + uy * vy) / (normU * normV)
  cosTheta = Math.max(-1, Math.min(1, cosTheta))   // guard against float rounding
  return (Math.acos(cosTheta) * 180) / Math.PI
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Trailing-median baseline over a ring buffer of the last `windowSec * fps` samples —
 * streaming port of compute_rolling_baseline (already causal in Python: baseline[t] =
 * median of hip_y[t-W+1 : t+1]).
 */
export class RollingBaseline {
  private readonly window: number
  private buf: number[] = []

  constructor(fps: number, windowSec = 2.0) {
    this.window = Math.max(1, Math.round(windowSec * fps))
  }

  /** Push the latest sample and return the current trailing-median baseline. */
  push(value: number): number {
    this.buf.push(value)
    if (this.buf.length > this.window) this.buf.shift()
    return median(this.buf)
  }
}

/**
 * Rolling median body scale (shoulder-mid to ankle-mid distance) over recent
 * visible frames. Deviates from compute_body_scale's whole-clip median by design —
 * see module doc comment.
 */
export class RunningBodyScale {
  private readonly maxSamples: number
  private buf: number[] = []

  constructor(fps: number, windowSec = 3.0) {
    this.maxSamples = Math.max(1, Math.round(windowSec * fps))
  }

  /** Returns 1.0 (the Python fallback) until at least one visible sample has been seen. */
  get value(): number {
    return this.buf.length ? median(this.buf) : 1.0
  }

  /** shoulderMid/ankleMid: normalized-image-space midpoints of the shoulder/ankle pair. */
  push(shoulderMid: Point, ankleMid: Point): void {
    const dist = Math.hypot(shoulderMid.x - ankleMid.x, shoulderMid.y - ankleMid.y)
    this.buf.push(dist)
    if (this.buf.length > this.maxSamples) this.buf.shift()
  }
}

/** Trailing moving average over the last `window` landmark-point samples (x, y only). */
export class TrailingSmoother {
  private readonly window: number
  private bufX: number[] = []
  private bufY: number[] = []

  constructor(window = 5) {
    this.window = Math.max(1, window)
  }

  push(p: Point): Point {
    this.bufX.push(p.x)
    this.bufY.push(p.y)
    if (this.bufX.length > this.window) {
      this.bufX.shift()
      this.bufY.shift()
    }
    const n = this.bufX.length
    const sumX = this.bufX.reduce((a, b) => a + b, 0)
    const sumY = this.bufY.reduce((a, b) => a + b, 0)
    return { x: sumX / n, y: sumY / n }
  }
}
