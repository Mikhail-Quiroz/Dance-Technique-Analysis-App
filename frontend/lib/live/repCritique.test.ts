// Each confirmed rep must produce a critique computed from THAT rep's own measurements.
// Regression cover for the bug where a dropped rep left the previous rep's cue on
// screen, which read as "the critique never changes".
import { describe, expect, it } from 'vitest'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { JumpRepDetector } from './jumpDetector'
import { selectTopCue } from './scoring'

// The synthetic bodies here are drawn in square coordinates (x and y on one scale), so the
// detectors are told the frame is square - a real webcam frame is 16:9 (MoveEngineConfig.aspect).
const SQUARE = { aspect: 1 }

const FPS = 30
const DT = 1000 / FPS
const GROUND = 0.90
const THIGH = 0.20, SHIN = 0.20, FOOT = 0.06
const rad = (d: number) => (d * Math.PI) / 180
type Pt = { x: number; y: number }
interface Leg { plie?: number; swing?: number; footFlex?: number }
interface Pose { grounded?: { left: Leg; right: Leg }; lift?: number; air?: { left: Leg; right: Leg } }

function groundedLeg(ax: number, leg: Leg) {
  const p = leg.plie ?? 0, sw = leg.swing ?? 0
  const ankle = { x: ax, y: GROUND }
  const thS = sw + p / 2, thT = sw - p / 2
  const knee = { x: ankle.x + SHIN * Math.sin(rad(thS)), y: ankle.y - SHIN * Math.cos(rad(thS)) }
  const hip = { x: knee.x + THIGH * Math.sin(rad(thT)), y: knee.y - THIGH * Math.cos(rad(thT)) }
  const ff = leg.footFlex ?? 0
  const foot = { x: ankle.x + FOOT * Math.sin(rad(thS + 180 - ff)), y: ankle.y - FOOT * Math.cos(rad(thS + 180 - ff)) }
  return { hip, knee, ankle, foot }
}
function airLeg(hip: Pt, leg: Leg) {
  const p = leg.plie ?? 0, sw = leg.swing ?? 0
  const thT = sw, thS = sw - p
  const knee = { x: hip.x + THIGH * Math.sin(rad(thT)), y: hip.y + THIGH * Math.cos(rad(thT)) }
  const ankle = { x: knee.x + SHIN * Math.sin(rad(thS)), y: knee.y + SHIN * Math.cos(rad(thS)) }
  const ff = leg.footFlex ?? 0
  const foot = { x: ankle.x + FOOT * Math.sin(rad(thS - ff)), y: ankle.y + FOOT * Math.cos(rad(thS - ff)) }
  return { knee, ankle, foot }
}
function makeLandmarks(p: Pose): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const put = (id: number, q: Pt) => { lm[id] = { x: q.x, y: q.y, z: 0, visibility: 1 } }
  let hipL: Pt, hipR: Pt, L, R
  if (p.grounded) {
    const gl = groundedLeg(0.45, p.grounded.left), gr = groundedLeg(0.55, p.grounded.right)
    hipL = gl.hip; hipR = gr.hip
    L = { knee: gl.knee, ankle: gl.ankle, foot: gl.foot }
    R = { knee: gr.knee, ankle: gr.ankle, foot: gr.foot }
  } else {
    const hy = 0.50 - (p.lift ?? 0)
    hipL = { x: 0.45, y: hy }; hipR = { x: 0.55, y: hy }
    L = airLeg(hipL, p.air!.left); R = airLeg(hipR, p.air!.right)
  }
  const hipMidY = (hipL.y + hipR.y) / 2
  // Seen in profile, facing +x - the way the front (left) leg reaches: the nose leads the ears.
  put(0, { x: 0.54, y: hipMidY - 0.40 }); put(7, { x: 0.50, y: hipMidY - 0.39 }); put(8, { x: 0.50, y: hipMidY - 0.39 })
  put(11, { x: 0.45, y: hipMidY - 0.30 }); put(12, { x: 0.55, y: hipMidY - 0.30 })
  put(23, hipL); put(24, hipR)
  put(25, L.knee); put(26, R.knee)
  put(27, L.ankle); put(28, R.ankle)
  put(29, { x: L.ankle.x - 0.01, y: L.ankle.y + 0.02 }); put(30, { x: R.ankle.x - 0.01, y: R.ankle.y + 0.02 })
  put(31, L.foot); put(32, R.foot)
  return lm
}
const STAND: Pose = { grounded: { left: {}, right: {} } }
const plieP = (deg: number): Pose => ({ grounded: { left: { plie: deg }, right: { plie: deg } } })
const hold = (n: number, p: Pose): Pose[] => Array.from({ length: n }, () => p)

interface Spec { label: string; flightFrames: number; peak: number; split: number; backKneePlie: number; frontFootFlex: number; landPlie: number }
function leap(s: Spec): Pose[] {
  const flight: Pose[] = Array.from({ length: s.flightFrames }, (_, i) => ({
    lift: s.peak * Math.sin((Math.PI * (i + 1)) / (s.flightFrames + 1)),
    air: { left: { swing: s.split, footFlex: s.frontFootFlex }, right: { swing: -s.split, plie: s.backKneePlie } },
  }))
  return [...hold(6, plieP(40)), ...flight, ...hold(10, plieP(s.landPlie)), ...hold(30, STAND)]
}

interface RepResult { attempt: number; type: string; airborneMs: number; cueId: string | null }

function session(specs: Spec[], gapFrames: number) {
  const det = new JumpRepDetector(SQUARE)
  let t = 0
  const out: RepResult[] = []
  const rejects = new Map<string, number>()
  let attempt = 0
  const frames: Array<{ pose: Pose; mark?: number }> = [
    ...hold(90, STAND).map((pose) => ({ pose })),
    ...specs.flatMap((s) => {
      attempt++
      return [...leap(s).map((pose, i) => ({ pose, mark: i === 0 ? attempt : undefined })), ...hold(gapFrames, STAND).map((pose) => ({ pose }))]
    }),
  ]
  let current = 0
  for (const f of frames) {
    if (f.mark) current = f.mark
    const ev = det.pushFrame(makeLandmarks(f.pose), t)
    t += DT
    const r = det.debug.lastReject
    if (r && r !== 'warming-up') rejects.set(r, (rejects.get(r) ?? 0) + 1)
    if (!ev) continue
    const top = selectTopCue(ev.metrics)
    out.push({ attempt: current, type: ev.type, airborneMs: ev.airborneMs, cueId: top ? top.cueId : null })
  }
  return { out, reps: det.debug.reps, rejects }
}


// split is each leg's angle from hanging straight down: 85 puts both legs about level with the hips.
const CLEAN: Spec = { label: 'clean', flightFrames: 11, peak: 0.14, split: 85, backKneePlie: 0, frontFootFlex: 0, landPlie: 45 }
const BENT_BACK_KNEE: Spec = { ...CLEAN, label: 'bent back knee', backKneePlie: 50 }
const STIFF_LANDING: Spec = { ...CLEAN, label: 'flexed feet + stiff landing', frontFootFlex: 60, landPlie: 4 }

describe('per-rep critique', () => {
  it('gives three leaps of different quality three different critiques', () => {
    const { out, reps } = session([CLEAN, BENT_BACK_KNEE, STIFF_LANDING], 40)
    expect(reps).toBe(3)
    expect(out.map((r) => r.attempt)).toEqual([1, 2, 3])

    const cueIds = out.map((r) => r.cueId)
    expect(new Set(cueIds).size, `expected 3 distinct critiques, got ${JSON.stringify(cueIds)}`).toBe(3)
    // Each one names that leap's own fault - the bent knee on the leg BEHIND the dancer.
    expect(cueIds).toEqual([null, 'straighten_back_leg', 'land_through_plie'])
  })

  it('counts every rep in a rapid series, so the cue never goes stale', () => {
    // The reported bug looked like "the critique never changes". The real cause was
    // reps being dropped: with nothing emitted, the panel kept the previous rep's cue.
    for (const gap of [20, 40, 60]) {
      const { out, reps } = session(Array.from({ length: 6 }, () => ({ ...CLEAN })), gap)
      expect(reps, `${gap}-frame gap`).toBe(6)
      expect(out.map((r) => r.attempt), `${gap}-frame gap`).toEqual([1, 2, 3, 4, 5, 6])
    }
  })

  it('does not silently drop a short but genuine jump', () => {
    // Flight is measured between threshold crossings, so it reads shorter than the true
    // airtime: a 267 ms hop measures about 200 ms. That clears minAirborneMs (150 ms)
    // and must still produce its own rep rather than leaving the previous cue on screen.
    const short: Spec = { label: 'short', flightFrames: 8, peak: 0.085, split: 18, backKneePlie: 0, frontFootFlex: 0, landPlie: 6 }
    const { out, reps } = session([CLEAN, short, CLEAN], 40)
    expect(reps).toBe(3)
    expect(out.map((r) => r.attempt)).toEqual([1, 2, 3])
  })

  it('treats a run-up step as a step, not a rep', () => {
    // minAirborneMs is a deliberate floor, not just noise rejection. A jeté is normally
    // preceded by a chassé or run, and a vigorous preparatory step briefly leaves the
    // floor with a real hip rise — it passes the ankle gate. Dropping the floor to
    // 100 ms admitted those: a session of ~6-7 real jumps logged 10 reps. Anything under
    // 150 ms of MEASURED airtime is treated as travelling, not jumping.
    const step: Spec = { label: 'run-up', flightFrames: 4, peak: 0.07, split: 10, backKneePlie: 0, frontFootFlex: 0, landPlie: 4 }
    const { reps } = session([step, step, step], 20)
    expect(reps).toBe(0)
  })

  it('recomputes airtime per rep rather than reusing the first', () => {
    const slow: Spec = { ...CLEAN, flightFrames: 14, peak: 0.16 }
    const { out } = session([CLEAN, slow], 40)
    expect(out).toHaveLength(2)
    expect(out[1].airborneMs).toBeGreaterThan(out[0].airborneMs)
  })
})
