// Which leg a leap critique talks about, and when it says nothing. Regression cover for the bug
// where "the front leg" was simply the higher ankle: the back leg was then the lower leg by
// definition, and every split and switch leap in the reference footage was told its back leg had
// dropped - in eight of ten split leaps the back leg was the higher one.
import { describe, expect, it } from 'vitest'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { JumpRepDetector, type JumpRepEvent } from './jumpDetector'
import { selectFeedback } from './scoring'
import { russianMetrics } from './jumpMetrics'

// The synthetic bodies here are drawn in square coordinates (x and y on one scale), so the
// detectors are told the frame is square - a real webcam frame is 16:9 (MoveEngineConfig.aspect).
const SQUARE = { aspect: 1 }

const GROUND = 0.90
const THIGH = 0.20, SHIN = 0.20
const rad = (d: number) => (d * Math.PI) / 180
type Pt = { x: number; y: number }

/** A leg hanging from `hip`, `swing` degrees from straight down (positive = toward +x), knee bent by `bend`. */
function leg(hip: Pt, swing: number, bend = 0) {
  const s = Math.sign(swing) || 1
  const knee = { x: hip.x + THIGH * Math.sin(rad(swing)), y: hip.y + THIGH * Math.cos(rad(swing)) }
  // The shin folds back under the thigh, as a bent leg does in a leap.
  const shin = swing - s * bend
  const ankle = { x: knee.x + SHIN * Math.sin(rad(shin)), y: knee.y + SHIN * Math.cos(rad(shin)) }
  const foot = { x: ankle.x + 0.06 * Math.sin(rad(shin)), y: ankle.y + 0.06 * Math.cos(rad(shin)) }
  return { knee, ankle, foot }
}

interface Air { lift: number; front: number; back: number; backBend?: number; garbled?: boolean; smeared?: boolean }

/**
 * One frame, the dancer in profile facing `facing` (+1 = toward +x), or square to the camera
 * (facing 0). In the air the front leg reaches `front` degrees from hanging, toward the facing
 * side; the back leg `back` degrees to the other side.
 */
function frame(facing: number, air: Air | null, plie = 0): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const put = (id: number, q: Pt) => { lm[id] = { x: q.x, y: q.y, z: 0, visibility: 1 } }
  const hy = air ? 0.50 - air.lift : 0.50 + 0.4 * (1 - Math.cos(rad(plie / 2)))
  const hipL = { x: 0.47, y: hy }, hipR = { x: 0.53, y: hy }
  let L, R
  if (air && !air.garbled) {
    const dir = facing || 1
    // The left leg is the front leg.
    L = leg(hipL, dir * air.front)
    R = leg(hipR, -dir * air.back, air.backBend ?? 0)
    if (air.smeared) {
      // The legs are wide, but the tracker has lost the knees in the blur: both sit at the hips.
      L = { ...L, knee: { x: hipL.x + 0.01, y: hy + 0.01 } }
      R = { ...R, knee: { x: hipR.x - 0.01, y: hy + 0.01 } }
    }
  } else if (air) {
    // What blur does to a split on a webcam: knees and feet piled up at the hips.
    L = { knee: { x: 0.49, y: hy + 0.03 }, ankle: { x: 0.52, y: hy + 0.05 }, foot: { x: 0.53, y: hy + 0.06 } }
    R = { knee: { x: 0.51, y: hy + 0.03 }, ankle: { x: 0.48, y: hy + 0.05 }, foot: { x: 0.47, y: hy + 0.06 } }
  } else {
    const k = (h: Pt) => ({ x: h.x, y: GROUND - SHIN * Math.cos(rad(plie / 2)) })
    L = { knee: k(hipL), ankle: { x: hipL.x, y: GROUND }, foot: { x: hipL.x + 0.05, y: GROUND } }
    R = { knee: k(hipR), ankle: { x: hipR.x, y: GROUND }, foot: { x: hipR.x + 0.05, y: GROUND } }
  }
  put(0, { x: 0.50 + 0.04 * facing, y: hy - 0.40 })
  put(7, { x: 0.50, y: hy - 0.39 }); put(8, { x: 0.50, y: hy - 0.39 })
  put(11, { x: 0.46, y: hy - 0.30 }); put(12, { x: 0.54, y: hy - 0.30 })
  put(23, hipL); put(24, hipR)
  put(25, L.knee); put(26, R.knee)
  put(27, L.ankle); put(28, R.ankle)
  put(29, { x: L.ankle.x - 0.01, y: L.ankle.y + 0.01 }); put(30, { x: R.ankle.x - 0.01, y: R.ankle.y + 0.01 })
  put(31, L.foot); put(32, R.foot)
  return lm
}

/** One leap: stand, plié, the flight frames, land, stand. */
function leap(facing: number, flight: Air[], fps = 30): JumpRepEvent[] {
  const det = new JumpRepDetector(SQUARE)
  const dt = 1000 / fps
  const out: JumpRepEvent[] = []
  let t = 0
  const push = (lm: NormalizedLandmark[]) => { const ev = det.pushFrame(lm, t); if (ev) out.push(ev); t += dt }
  for (let i = 0; i < 3 * fps; i++) push(frame(facing, null))
  for (let i = 0; i < Math.round(fps / 5); i++) push(frame(facing, null, 60))
  for (const a of flight) push(frame(facing, a))
  for (let i = 0; i < Math.round(fps / 3); i++) push(frame(facing, null, 60))
  for (let i = 0; i < 2 * fps; i++) push(frame(facing, null))
  return out
}

/** A 30 fps flight: legs open into the split, hold it for `hold` frames, close. */
function flight(split: Omit<Air, 'lift'>, hold = 5): Air[] {
  const n = hold + 6
  return Array.from({ length: n }, (_, i) => {
    const lift = 0.14 * Math.sin((Math.PI * (i + 1)) / (n + 1))
    const open = i >= 3 && i < 3 + hold
    return open ? { ...split, lift } : { lift, front: 15, back: 15 }
  })
}

const cuesOf = (m: Record<string, number | null>) => {
  const fb = selectFeedback(m)
  return fb.kind === 'correction' ? [fb.cueId, ...fb.also.map((a) => a.cueId)] : [fb.kind]
}

describe('leap critique — which leg is the back leg', () => {
  it.each([[1], [-1]])('a back leg ABOVE the hips is not told to lift, whichever way the dancer faces (%i)', (facing) => {
    // Front leg reaching down for the landing, back leg high: the lower leg is the FRONT one.
    const [rep] = leap(facing, flight({ front: 60, back: 100 }))
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.leap_back_leg_drop!).toBeLessThan(0)   // degrees below level: negative is above
    expect(cuesOf(rep.metrics)).not.toContain('level_the_leap')
  })

  it.each([[1], [-1]])('a back leg well below the hips is told to lift it (%i)', (facing) => {
    const [rep] = leap(facing, flight({ front: 95, back: 55 }))
    expect(rep.metrics.leap_back_leg_drop!).toBeGreaterThan(20)
    expect(cuesOf(rep.metrics)).toContain('level_the_leap')
  })

  it('a bent knee is put on the leg it belongs to', () => {
    const [rep] = leap(1, flight({ front: 90, back: 90, backBend: 50 }))
    expect(rep.metrics.back_leg_ext!).toBeLessThan(140)
    expect(rep.metrics.front_leg_ext!).toBeGreaterThan(170)
    expect(cuesOf(rep.metrics)).toContain('straighten_back_leg')
    expect(cuesOf(rep.metrics)).not.toContain('straighten_front_leg')
  })

  it('square to the camera, front and back cannot be told apart, so neither is named', () => {
    const [rep] = leap(0, flight({ front: 90, back: 60 }))
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.leap_back_leg_drop ?? null).toBeNull()
    expect(rep.metrics.front_leg_ext ?? null).toBeNull()
    expect(rep.metrics.back_leg_ext ?? null).toBeNull()
  })
})

describe('leap critique — the split is judged at its fullest', () => {
  it('a back leg that reaches level on a frame where the front leg is smeared is judged there', () => {
    // A switch leap: the split opens over a few frames, the back leg still low (35 degrees below
    // level), and is fullest on the last one - where the fast-moving front leg's knee is lost in
    // the blur. Judged a frame early, it was told the back leg had dropped.
    const opening: Air[] = [
      { lift: 0.05, front: 20, back: 15 }, { lift: 0.09, front: 20, back: 15 },
      { lift: 0.12, front: 85, back: 55 }, { lift: 0.13, front: 88, back: 70 }, { lift: 0.14, front: 90, back: 88, smeared: true },
      { lift: 0.10, front: 20, back: 20 }, { lift: 0.05, front: 15, back: 15 },
    ]
    const [rep] = leap(1, opening)
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.leap_back_leg_drop!).toBeLessThan(5)
    expect(rep.metrics.split_angle!).toBeGreaterThan(170)
    expect(cuesOf(rep.metrics)).not.toContain('level_the_leap')
    expect(cuesOf(rep.metrics)).not.toContain('bigger_split')
  })
})

describe('leap critique — only what the camera actually saw', () => {
  it('at 15 fps the split is one frame: split and back leg are judged, knees are not', () => {
    // On the reference footage that single smeared frame read visibly straight legs at
    // 105-150 degrees. Not offered, rather than null, so the leap can still be praised. (Feet are
    // never critiqued live - see finalizeRep.)
    const fifteen: Air[] = [
      { lift: 0.05, front: 15, back: 15 }, { lift: 0.10, front: 20, back: 20 },
      { lift: 0.14, front: 90, back: 90 },
      { lift: 0.10, front: 20, back: 20 }, { lift: 0.05, front: 15, back: 15 },
    ]
    const [rep] = leap(1, fifteen, 15)
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.split_angle!).toBeGreaterThan(150)
    expect(rep.metrics.leap_back_leg_drop).not.toBeNull()
    for (const k of ['front_leg_ext', 'back_leg_ext', 'point_feet']) expect(rep.metrics).not.toHaveProperty(k)
  })

  it('split frames the blur scrambled are not critiqued, and the leap is not praised for them', () => {
    // The widest frames had the knees and feet piled at the hips; the only readable frames
    // were the take-off and landing, legs together - nothing to judge a split on.
    const blurred = flight({ front: 90, back: 90, garbled: true })
    const [rep] = leap(1, blurred)
    expect(rep).toBeDefined()
    // (Crossed legs read as a 90-degree split, so the gate does count it as a leap.)
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.split_angle).toBeNull()
    expect(rep.metrics.leap_back_leg_drop).toBeNull()
    // Even with a perfect landing and chest, a leap whose split was never seen is not praised.
    expect(selectFeedback({ ...rep.metrics, land_plie: 120, torso_uprightness: 3 }).kind).toBe('unassessable')
  })
})

describe('leap critique — a russian straddle, front-on', () => {
  /** A straddle facing the camera, legs `deg` out to each side, with per-frame overrides. */
  const straddle = (deg: number, over: Record<number, Partial<Air>> = {}): Air[] =>
    flight({ front: deg, back: deg }, 7).map((a, i) => ({ ...a, ...(over[i] ?? {}) }))

  it('level legs read as level, even with one blurred frame among them', () => {
    const [rep] = leap(0, straddle(80, { 5: { garbled: true } }))
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.straddle).not.toBeNull()
    expect(rep.straddle!.unevenDeg).toBeLessThan(5)
    expect(rep.straddle!.widthDeg).toBeGreaterThan(150)
  })

  it('one leg held well above the other is told to even them', () => {
    const [rep] = leap(0, flight({ front: 110, back: 50 }, 7))
    expect(rep.straddle!.unevenDeg).toBeGreaterThan(30)
    expect(cuesOf(russianMetrics(rep))).toContain('russian_even_legs')
  })

  it('a smeared shin does not cost the frame - the straddle is read from the ankles', () => {
    const [rep] = leap(0, straddle(80, { 4: { smeared: true }, 5: { smeared: true }, 6: { smeared: true } }))
    expect(rep.straddle).not.toBeNull()
    expect(rep.straddle!.widthDeg).toBeGreaterThan(150)
  })

  it('a straddle whose ankles were lost at the top is not judged', () => {
    // Ankles piled at the hips on every wide frame but two: nothing to judge the straddle on.
    const lost: Record<number, Partial<Air>> = {}
    for (let i = 4; i < 10; i++) lost[i] = { garbled: true }
    const [rep] = leap(0, straddle(80, lost))
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.straddle).toBeNull()
  })
})

