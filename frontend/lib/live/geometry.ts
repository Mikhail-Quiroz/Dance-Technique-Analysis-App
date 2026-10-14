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

// ---------------------------------------------------------------------------
// Time-windowed variants used by the LIVE detector.
//
// RollingBaseline / RunningBodyScale above are sample-counted, sized off an
// assumed fps — a 1:1 port of the Python batch versions, kept that way so
// geometry.test.ts can keep mirroring tests/test_geometry.py. The live camera
// has no such guarantee: rAF delivers whatever the webcam gives (15–60 fps, and
// it drifts), so the same sample count is a different amount of real time from
// machine to machine. These variants window on the frame's own tMs instead.
// ---------------------------------------------------------------------------

/** Trailing-median baseline over a real-time window, in milliseconds. */
export class TimedRollingBaseline {
  private readonly windowMs: number
  private vals: number[] = []
  private times: number[] = []

  constructor(windowMs = 2000) {
    this.windowMs = Math.max(1, windowMs)
  }

  /** Push a sample stamped at tMs; returns the trailing median over the window. */
  push(value: number, tMs: number): number {
    this.vals.push(value)
    this.times.push(tMs)
    const cutoff = tMs - this.windowMs
    let drop = 0
    while (drop < this.times.length && this.times[drop] < cutoff) drop++
    if (drop > 0) {
      this.vals.splice(0, drop)
      this.times.splice(0, drop)
    }
    return median(this.vals)
  }

  /** NaN until at least one sample has been pushed — callers must check `ready`. */
  get value(): number {
    return this.vals.length ? median(this.vals) : NaN
  }

  get count(): number {
    return this.vals.length
  }

  /** True once the window holds enough history to be a meaningful median. */
  ready(minSamples: number): boolean {
    return this.vals.length >= minSamples
  }

  reset(): void {
    this.vals = []
    this.times = []
  }
}

/**
 * Rolling median body scale over a real-time window.
 *
 * Deliberately returns NaN rather than compute_body_scale's 1.0 fallback: 1.0 is
 * a normalized-coordinate impossibility (the whole frame is 1.0 tall) that
 * silently produced a 0.06 threshold for a dancer whose legs were never visible.
 * Callers gate on `ready()` and refuse to detect instead of guessing.
 */
export class TimedRunningBodyScale {
  private readonly windowMs: number
  private vals: number[] = []
  private times: number[] = []

  constructor(windowMs = 3000) {
    this.windowMs = Math.max(1, windowMs)
  }

  push(shoulderMid: Point, ankleMid: Point, tMs: number): void {
    this.vals.push(Math.hypot(shoulderMid.x - ankleMid.x, shoulderMid.y - ankleMid.y))
    this.times.push(tMs)
    const cutoff = tMs - this.windowMs
    let drop = 0
    while (drop < this.times.length && this.times[drop] < cutoff) drop++
    if (drop > 0) {
      this.vals.splice(0, drop)
      this.times.splice(0, drop)
    }
  }

  get value(): number {
    return this.vals.length ? median(this.vals) : NaN
  }

  get count(): number {
    return this.vals.length
  }

  ready(minSamples: number): boolean {
    return this.vals.length >= minSamples
  }

  reset(): void {
    this.vals = []
    this.times = []
  }
}

/** A point in metric world space (MediaPipe world landmarks). */
export interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * Angle ABC in degrees at vertex b, in 3-D. Returns NaN if either arm has ~zero length.
 *
 * The 2-D `angleAt` above is only trustworthy for a limb lying roughly parallel to the
 * image plane. As a limb rotates toward the camera its projection collapses, and the
 * angle it reports degrades into noise: measured on a PERFECTLY straight leg, the image
 * angle falls from 176 degrees when the leg hangs down to 129 degrees (10th percentile
 * 74) when it points almost at the lens, while the same leg measured in 3-D holds
 * 175-176 degrees throughout. Any joint angle that must survive a limb pointing at the
 * camera has to be computed here instead.
 */
export function angleAt3(b: Point3, a: Point3, c: Point3): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z
  const normU = Math.hypot(ux, uy, uz)
  const normV = Math.hypot(vx, vy, vz)
  if (normU < 1e-9 || normV < 1e-9) return NaN
  const cosTheta = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (normU * normV)))
  return (Math.acos(cosTheta) * 180) / Math.PI
}

// ---------------------------------------------------------------------------
// Floor contact.
//
// "Is anything still touching the floor" is the question that separates a jump from
// everything that merely LOOKS like one — an arabesque, a relevé, a battement. A hip rise
// cannot answer it (a relevé raises the hips with the toes planted), and neither can the
// ankle midpoint (raising ONE leg behind lifts the midpoint by half that leg's travel).
// The lowest visible point of either foot can: in flight it leaves the floor, and in every
// one of those look-alikes the supporting toes stay down.
// ---------------------------------------------------------------------------

/** Ankle, heel and toe (foot_index) landmark ids, per side. */
export const FOOT_POINTS = { L: [27, 29, 31], R: [28, 30, 32] } as const

interface VisPoint { x: number; y: number; visibility?: number }

/**
 * Image y of the lowest visible point of one foot (y grows DOWNWARD, so this is a max),
 * or NaN if none of that foot's landmarks clear `visThresh`.
 */
export function footLowestY(lm: VisPoint[], side: 'L' | 'R', visThresh: number): number {
  let lowest = NaN
  for (const id of FOOT_POINTS[side]) {
    const p = lm[id]
    if (!p || (p.visibility ?? 0) < visThresh) continue
    lowest = Number.isNaN(lowest) ? p.y : Math.max(lowest, p.y)
  }
  return lowest
}

/**
 * Image y of the lowest visible point of EITHER foot — where the body meets the floor
 * when anything does. NaN unless both feet are readable: with one foot unseen there is
 * no telling whether it is the one still planted.
 */
export function lowestFootY(lm: VisPoint[], visThresh: number): number {
  const l = footLowestY(lm, 'L', visThresh)
  const r = footLowestY(lm, 'R', visThresh)
  if (Number.isNaN(l) || Number.isNaN(r)) return NaN
  return Math.max(l, r)
}

/**
 * A knee held in a position (an arabesque, the supporting leg of a turn), from its 3-D and its
 * true-proportion image readings. The 3-D reading under-reads a straight leg on this camera - by
 * 14-44 degrees on the reference arabesques and piqués, where a crossing leg or the tracker's own
 * bias pulls the knee off the line - while the screen reads that same leg at 162-180. But the
 * screen cannot see a bend aimed at the camera: a 40-degree plié turned 45 degrees from the lens
 * reads 151 on screen and 140 in 3-D. So the screen overrides only when it is clearly straighter
 * (imageLeadDeg or more); otherwise the 3-D reading stands.
 */
export function kneeReading(world: number, image: number, imageLeadDeg = 15): number {
  if (!Number.isFinite(world)) return image
  if (!Number.isFinite(image)) return world
  return image - world >= imageLeadDeg ? image : world
}

/**
 * How far a leg is raised from hanging straight down, the larger of the 3-D and image readings.
 * World "up" is -y: MediaPipe's world Y points down, verified on 18k real frames (99%). The image
 * reading is exact for a leg in the image plane (a side extension facing the camera); the 3-D one
 * for a leg pointing at or away from the lens. Each fails where the other is right.
 */
export function legElevation(lm: VisPoint[], w: Point3[], hip: number, ankle: number): number {
  const vx = w[ankle].x - w[hip].x, vy = w[ankle].y - w[hip].y, vz = w[ankle].z - w[hip].z
  const n = Math.hypot(vx, vy, vz)
  const deg = (r: number) => (r * 180) / Math.PI
  const world = n > 1e-9 ? deg(Math.acos(Math.max(-1, Math.min(1, vy / n)))) : 0
  const ix = lm[ankle].x - lm[hip].x
  const iy = lm[ankle].y - lm[hip].y
  const ni = Math.hypot(ix, iy)
  const image = ni > 1e-9 ? deg(Math.acos(Math.max(-1, Math.min(1, iy / ni)))) : 0
  // The image squeezes the horizontal part of a leg that is turned toward or away from the lens,
  // which pulls its angle toward vertical: BELOW horizontal that under-reads the lift, ABOVE it
  // (an arabesque past 90) it over-reads it. So take the larger reading below 90 and the smaller
  // above - each picks the one the projection did not distort.
  return world >= 90 && image >= 90 ? Math.min(world, image) : Math.max(world, image)
}
