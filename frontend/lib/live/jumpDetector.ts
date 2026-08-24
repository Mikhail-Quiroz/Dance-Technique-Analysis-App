// Streaming TS port of jump/leap detection + metrics — analysis/moves.py's detect_jumps()
// and analysis/metrics.py's compute_jump_metrics(), adapted to run frame-by-frame instead
// of over a whole buffered clip. Turns (detect_turns) are intentionally not ported yet —
// see ROADMAP.md slice 2b / 2b-ii.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { angleAt, RollingBaseline, RunningBodyScale, type Point } from './geometry'

const L_SHOULDER = 11, R_SHOULDER = 12
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28
const L_HEEL = 29, R_HEEL = 30
const L_FOOT = 31, R_FOOT = 32

const VIS_THRESH = 0.5
const AIRBORNE_RATIO = 0.06        // threshold = 0.06 * bodyScale, same as detect_jumps
const MIN_AIRBORNE_FRAMES = 4      // same magic number as the Python version
const LEAP_SPLIT_DEG = 100.0       // split_angle > 100 deg => leap, else jump
const LAND_WINDOW_SEC = 0.35

export interface JumpRepEvent {
  type: 'leap (jeté-type)' | 'jump (sauté-type)'
  splitAngleDeg: number
  metrics: Record<string, number | null>
  takeoffMs: number
  apexMs: number
  landingMs: number
}

interface FrameSnapshot {
  lm: NormalizedLandmark[]
  tMs: number
  rise: number   // baseline - hipMidY at the moment this frame was pushed
}

function pt(lm: NormalizedLandmark[], id: number): Point {
  return { x: lm[id].x, y: lm[id].y }
}

function vis(lm: NormalizedLandmark[], ...ids: number[]): boolean {
  return ids.every((id) => (lm[id].visibility ?? 1) >= VIS_THRESH)
}

type Phase = 'grounded' | 'airborne' | 'landingTail'

export class JumpRepDetector {
  private readonly fps: number
  private readonly baseline: RollingBaseline
  private readonly bodyScale: RunningBodyScale
  private readonly landTailTarget: number

  private phase: Phase = 'grounded'
  private flightBuffer: FrameSnapshot[] = []
  private landingWindow: FrameSnapshot[] = []

  constructor(fps: number) {
    this.fps = fps
    this.baseline = new RollingBaseline(fps, 2.0)
    this.bodyScale = new RunningBodyScale(fps, 3.0)
    this.landTailTarget = Math.round(LAND_WINDOW_SEC * fps) + 1
  }

  /** Feed one detected frame. Returns a completed rep event, or null if none closed yet. */
  pushFrame(lm: NormalizedLandmark[], tMs: number): JumpRepEvent | null {
    const hipMidY = (lm[L_HIP].y + lm[R_HIP].y) / 2
    const baselineVal = this.baseline.push(hipMidY)

    if (vis(lm, L_SHOULDER, R_SHOULDER, L_ANKLE, R_ANKLE)) {
      const shoulderMid = { x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 }
      const ankleMid = { x: (lm[L_ANKLE].x + lm[R_ANKLE].x) / 2, y: (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2 }
      this.bodyScale.push(shoulderMid, ankleMid)
    }

    const threshold = AIRBORNE_RATIO * this.bodyScale.value
    const rise = baselineVal - hipMidY
    const airborneNow = rise > threshold
    const frame: FrameSnapshot = { lm, tMs, rise }

    if (this.phase === 'grounded') {
      if (airborneNow) {
        this.phase = 'airborne'
        this.flightBuffer = [frame]
      }
      return null
    }

    if (this.phase === 'airborne') {
      if (airborneNow) {
        this.flightBuffer.push(frame)
        return null
      }
      // Flight just ended.
      if (this.flightBuffer.length < MIN_AIRBORNE_FRAMES) {
        this.phase = 'grounded'
        this.flightBuffer = []
        return null
      }
      this.phase = 'landingTail'
      // land_plie's window starts at the last airborne frame (Python's landing_frame),
      // which is already the last element of flightBuffer — include it, then this
      // first grounded frame, and keep collecting until landTailTarget is reached.
      this.landingWindow = [this.flightBuffer[this.flightBuffer.length - 1], frame]
      if (this.landingWindow.length >= this.landTailTarget) {
        return this.finalizeRep()
      }
      return null
    }

    // phase === 'landingTail'
    this.landingWindow.push(frame)
    if (this.landingWindow.length >= this.landTailTarget) {
      return this.finalizeRep()
    }
    return null
  }

  private finalizeRep(): JumpRepEvent {
    const flight = this.flightBuffer
    const landingWindow = this.landingWindow
    this.phase = 'grounded'
    this.flightBuffer = []
    this.landingWindow = []

    // Apex = frame of maximum rise within the flight segment (rise was recorded causally
    // at push time, same as Python's baseline[i:j] - hip_mid_y[i:j] since the baseline is
    // already a trailing/causal statistic).
    let apexIdx = 0
    for (let i = 1; i < flight.length; i++) {
      if (flight[i].rise > flight[apexIdx].rise) apexIdx = i
    }
    const apex = flight[apexIdx]
    const takeoff = flight[0]
    const landing = flight[flight.length - 1]

    const apexLm = apex.lm
    const lAnkleY = apexLm[L_ANKLE].y
    const rAnkleY = apexLm[R_ANKLE].y
    const front = lAnkleY <= rAnkleY ? 'L' : 'R'
    const [fHip, fKnee, fAnkle, fFoot] = front === 'L'
      ? [L_HIP, L_KNEE, L_ANKLE, L_FOOT]
      : [R_HIP, R_KNEE, R_ANKLE, R_FOOT]
    const [bHip, bKnee, bAnkle, bFoot] = front === 'L'
      ? [R_HIP, R_KNEE, R_ANKLE, R_FOOT]
      : [L_HIP, L_KNEE, L_ANKLE, L_FOOT]

    const metrics: Record<string, number | null> = {}

    metrics.front_leg_ext = vis(apexLm, fHip, fKnee, fAnkle)
      ? angleAt(pt(apexLm, fKnee), pt(apexLm, fHip), pt(apexLm, fAnkle))
      : null
    metrics.back_leg_ext = vis(apexLm, bHip, bKnee, bAnkle)
      ? angleAt(pt(apexLm, bKnee), pt(apexLm, bHip), pt(apexLm, bAnkle))
      : null

    const pointFootFront = vis(apexLm, fKnee, fAnkle, fFoot)
      ? angleAt(pt(apexLm, fAnkle), pt(apexLm, fKnee), pt(apexLm, fFoot))
      : null
    const pointFootBack = vis(apexLm, bKnee, bAnkle, bFoot)
      ? angleAt(pt(apexLm, bAnkle), pt(apexLm, bKnee), pt(apexLm, bFoot))
      : null
    const feetVals = [pointFootFront, pointFootBack].filter((v): v is number => v !== null)
    metrics.point_feet = feetVals.length ? Math.min(...feetVals) : null

    // Split angle + jump/leap classification at apex.
    const hipMid2d = { x: (apexLm[L_HIP].x + apexLm[R_HIP].x) / 2, y: (apexLm[L_HIP].y + apexLm[R_HIP].y) / 2 }
    let splitAngle = angleAt(hipMid2d, pt(apexLm, L_ANKLE), pt(apexLm, R_ANKLE))
    if (Number.isNaN(splitAngle)) splitAngle = 0
    const type: JumpRepEvent['type'] = splitAngle > LEAP_SPLIT_DEG ? 'leap (jeté-type)' : 'jump (sauté-type)'
    metrics.split_angle = type === 'leap (jeté-type)' ? splitAngle : null

    // Torso uprightness at apex.
    if (vis(apexLm, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)) {
      const shoulderMid = { x: (apexLm[L_SHOULDER].x + apexLm[R_SHOULDER].x) / 2, y: (apexLm[L_SHOULDER].y + apexLm[R_SHOULDER].y) / 2 }
      const hipMid = { x: (apexLm[L_HIP].x + apexLm[R_HIP].x) / 2, y: (apexLm[L_HIP].y + apexLm[R_HIP].y) / 2 }
      const torso = { x: shoulderMid.x - hipMid.x, y: shoulderMid.y - hipMid.y }
      const norm = Math.hypot(torso.x, torso.y)
      metrics.torso_uprightness = norm > 1e-9
        ? (Math.acos(Math.max(-1, Math.min(1, (torso.x * 0 + torso.y * -1) / norm))) * 180) / Math.PI
        : null
    } else {
      metrics.torso_uprightness = null
    }

    // Back-leg height (leaps only).
    if (type === 'leap (jeté-type)' && vis(apexLm, L_HIP, R_HIP, bAnkle)) {
      const hipMidY = (apexLm[L_HIP].y + apexLm[R_HIP].y) / 2
      const backAnkleY = apexLm[bAnkle].y
      metrics.back_leg_height = (hipMidY - backAnkleY) / this.bodyScale.value
    } else {
      metrics.back_leg_height = null
    }

    // Landing plié depth: min bilateral knee angle across the landing window.
    const plieAngles: number[] = []
    for (const f of landingWindow) {
      for (const [hip, knee, ankle] of [[L_HIP, L_KNEE, L_ANKLE], [R_HIP, R_KNEE, R_ANKLE]] as const) {
        if (vis(f.lm, hip, knee, ankle)) {
          const ang = angleAt(pt(f.lm, knee), pt(f.lm, hip), pt(f.lm, ankle))
          if (!Number.isNaN(ang)) plieAngles.push(ang)
        }
      }
    }
    metrics.land_plie = plieAngles.length ? Math.min(...plieAngles) : null

    return {
      type,
      splitAngleDeg: splitAngle,
      metrics,
      takeoffMs: takeoff.tMs,
      apexMs: apex.tMs,
      landingMs: landing.tMs,
    }
  }
}
