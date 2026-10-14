import { describe, expect, it } from 'vitest'
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { TurnDetector, type TurnEvent } from './turnDetector'
import { selectFeedback } from './scoring'
import { JumpRepDetector } from './jumpDetector'
import { ArabesqueDetector } from './arabesqueDetector'

// The synthetic bodies here are drawn in square coordinates (x and y on one scale), so the
// detectors are told the frame is square - a real webcam frame is 16:9 (MoveEngineConfig.aspect).
const SQUARE = { aspect: 1 }

// ---------------------------------------------------------------------------
// Body model: an articulated dancer built in their OWN frame (x to their right, y up from
// the floor, z forward, metres), turned about the vertical axis by `yaw`, then expressed in
// MediaPipe world coordinates (x right in the image, y DOWN, z away from the camera, origin
// at the hips). At yaw 0 the dancer faces the camera, so their right side is at image left.
//
// Every fault the critique names is its own knob, so each test changes exactly one thing.
// ---------------------------------------------------------------------------

const FPS = 30
const DT = 1000 / FPS
const rad = (d: number) => (d * Math.PI) / 180
type V = [number, number, number]

interface Pose {
  yaw: number
  /** Head yaw relative to the shoulders, degrees. */
  headRel?: number
  /** Relevé: supporting foot pitch, degrees. 0 is flat. */
  releve?: number
  /** Passé: false = both feet down (a spin on two feet / chaîné-like). */
  passe?: boolean
  /** The working leg out to the side at hip height instead of in passé (à la seconde). */
  seconde?: boolean
  /** Image x shift of the whole body, in image units - travel across the floor. */
  shiftX?: number
  /** Extra gap between working toe and supporting knee, metres. */
  passeGap?: number
  /** Whole body leaned sideways off vertical, degrees. */
  lean?: number
  /** Working hip hiked, metres. */
  hipHike?: number
  /** Hands and elbows moved up (+) or down (-), metres. */
  armsDy?: number
  /** Elbows dropped, metres. */
  elbowSag?: number
  /** Arms open to second (out to the sides, a little in front), or swung back past it. */
  arms?: 'first' | 'second' | 'behind'
  /** Whole body off the floor, metres. */
  lift?: number
}

function bodyPoints(p: Pose): Record<number, V> {
  const r = p.releve ?? 60
  // In a pirouette the weight is over the supporting foot, so it sits under the body's
  // midline and the supporting leg angles in slightly from its own hip.
  const toe: V = [0.0, 0, 0.12]
  const heel: V = [0.0, 0.20 * Math.sin(rad(r)), 0.12 - 0.20 * Math.cos(rad(r))]
  const sAnkle: V = [0.0, heel[1] + 0.07, heel[2] + 0.03]
  const sKnee: V = [0.05, sAnkle[1] + 0.42, sAnkle[2]]
  const hipY = sKnee[1] + 0.42
  const pts: Record<number, V> = {
    24: [0.10, hipY, sAnkle[2]], 26: sKnee, 28: sAnkle, 30: heel, 32: toe,   // right = supporting
    23: [-0.10, hipY + (p.hipHike ?? 0), sAnkle[2]],
  }
  const hz = sAnkle[2]
  if (p.seconde) {
    // Working (left) leg straight out to the dancer's left at 85 degrees from straight down.
    const e = rad(85)
    const d: V = [-Math.sin(e), -Math.cos(e), 0]
    const hip: V = [-0.10, hipY, sAnkle[2]]
    pts[25] = [hip[0] + 0.42 * d[0], hip[1] + 0.42 * d[1], hip[2]]
    pts[27] = [hip[0] + 0.84 * d[0], hip[1] + 0.84 * d[1], hip[2]]
    pts[29] = [pts[27][0] + 0.03, pts[27][1] - 0.04, pts[27][2] - 0.03]
    pts[31] = [pts[27][0] + 0.12 * d[0], pts[27][1] + 0.12 * d[1], pts[27][2]]
  } else if (p.passe ?? true) {
    const gap = p.passeGap ?? 0
    const wToe: V = [sKnee[0] - gap * 0.3, sKnee[1] - gap * 0.6, hz + 0.06 + gap * 0.7]
    pts[31] = wToe
    pts[27] = [wToe[0] - 0.10, wToe[1] + 0.04, wToe[2] - 0.04]
    pts[29] = [pts[27][0] - 0.02, pts[27][1] - 0.03, pts[27][2] - 0.05]
    pts[25] = [-0.35, hipY - 0.19, hz + 0.25]
  } else {
    pts[25] = [-0.10, sKnee[1], hz]; pts[27] = [-0.10, sAnkle[1], hz]
    pts[29] = [-0.10, heel[1], heel[2]]; pts[31] = [-0.10, 0, 0.12]
  }
  const sh = hipY + 0.50
  const dy = p.armsDy ?? 0
  pts[11] = [-0.18, sh, hz]; pts[12] = [0.18, sh, hz]
  pts[13] = [-0.25, sh - 0.19 + dy - (p.elbowSag ?? 0), hz + 0.20]; pts[14] = [0.25, sh - 0.19 + dy - (p.elbowSag ?? 0), hz + 0.20]
  pts[15] = [-0.12, sh - 0.26 + dy, hz + 0.38]; pts[16] = [0.12, sh - 0.26 + dy, hz + 0.38]
  if (p.arms === 'second') {
    pts[13] = [-0.40, sh - 0.06, hz + 0.05]; pts[14] = [0.40, sh - 0.06, hz + 0.05]
    pts[15] = [-0.66, sh - 0.10, hz + 0.10]; pts[16] = [0.66, sh - 0.10, hz + 0.10]
  } else if (p.arms === 'behind') {
    pts[13] = [-0.34, sh - 0.06, hz - 0.18]; pts[14] = [0.34, sh - 0.06, hz - 0.18]
    pts[15] = [-0.46, sh - 0.10, hz - 0.40]; pts[16] = [0.46, sh - 0.10, hz - 0.40]
  }
  pts[19] = [-0.06, sh - 0.28 + dy, hz + 0.42]; pts[20] = [0.06, sh - 0.28 + dy, hz + 0.42]
  // Head turned by headRel about the neck.
  const h = rad(p.headRel ?? 0)
  const head = (x: number, z: number): V => [x * Math.cos(h) + z * Math.sin(h), sh + 0.18, hz - x * Math.sin(h) + z * Math.cos(h)]
  pts[0] = head(0, 0.10); pts[7] = head(-0.07, 0); pts[8] = head(0.07, 0)
  // Lean: rotate everything about the supporting toe around the body's forward axis.
  const lean = rad(p.lean ?? 0)
  for (const k of Object.keys(pts)) {
    const [x, y, z] = pts[+k]
    const dx = x - toe[0]
    pts[+k] = [toe[0] + dx * Math.cos(lean) - y * Math.sin(lean), dx * Math.sin(lean) + y * Math.cos(lean) + (p.lift ?? 0), z]
  }
  return pts
}

/** Hip height above the floor, for placing the world origin (MediaPipe puts it at the hips). */
const hipHeightOf = (p: Pose) => { const b = bodyPoints(p); return (b[23][1] + b[24][1]) / 2 }

function toWorld(p: Pose): Landmark[] {
  const pts = bodyPoints(p)
  const hipY = hipHeightOf(p)
  const y = rad(p.yaw)
  const w: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  for (const [k, [x, py, z]] of Object.entries(pts)) {
    const x1 = x * Math.cos(y) + z * Math.sin(y)
    const z1 = -x * Math.sin(y) + z * Math.cos(y)
    w[+k] = { x: -x1, y: -(py - hipY), z: -z1, visibility: 1 }
  }
  return w
}

function toImage(p: Pose, w: Landmark[]): NormalizedLandmark[] {
  // The face is only trackable while it points roughly at the camera.
  const facing = Math.abs(((p.yaw + (p.headRel ?? 0)) % 360 + 540) % 360 - 180) < 100
  // The image keeps the floor fixed in frame (world coordinates are hip-relative, so a body
  // leaving the floor is only visible here).
  const hipAbove = hipHeightOf(p)
  return w.map((l, i) => ({
    x: 0.5 + l.x * 0.4 + (p.shiftX ?? 0),
    y: 0.95 + (l.y - hipAbove) * 0.4,
    z: 0,
    visibility: [0, 7, 8].includes(i) && !facing ? 0.1 : 0.95,
  }))
}

/** Head yaw relative to the body for a dancer who spots the camera (neck turns up to 80). */
const spotHead = (yaw: number) => Math.max(-80, Math.min(80, -(((yaw % 360) + 540) % 360 - 180)))

interface Session { turns?: number; degPerS?: number; pose?: Partial<Pose>; spot?: 'good' | 'none'; fps?: number }

function runTurn(s: Session = {}): TurnEvent[] {
  const fps = s.fps ?? FPS
  const dt = 1000 / fps
  const det = new TurnDetector(SQUARE)
  const out: TurnEvent[] = []
  let t = 0
  const push = (p: Pose) => {
    const w = toWorld(p)
    const ev = det.pushFrame(toImage(p, w), t, w)
    if (ev) out.push(ev)
    t += dt
  }
  const base = { ...s.pose }
  const standing: Pose = { yaw: 0, passe: false, releve: 0 }
  for (let i = 0; i < fps * 2; i++) push(standing)
  const total = 360 * (s.turns ?? 1)
  const rate = s.degPerS ?? 540
  const n = Math.round((total / rate) * fps)
  // En dehors - away from the supporting (right) leg, to the dancer's left - as every real
  // pirouette in the reference footage turned.
  for (let i = 1; i <= n; i++) {
    const yaw = -(total * i) / n
    push({ yaw, headRel: s.spot === 'none' ? 0 : spotHead(yaw), ...base })
  }
  for (let i = 0; i < fps * 1.5; i++) push({ ...standing, yaw: -total })
  return out
}

const cueOf = (e: TurnEvent) => {
  const fb = selectFeedback(e.metrics)
  return fb.kind === 'correction' ? fb.cueId : fb.kind
}

describe('TurnDetector — detection', () => {
  it('standing still never fires', () => {
    const det = new TurnDetector(SQUARE)
    let n = 0
    for (let i = 0; i < 300; i++) {
      const w = toWorld({ yaw: 0, passe: false, releve: 0 })
      if (det.pushFrame(toImage({ yaw: 0 }, w), i * DT, w)) n++
    }
    expect(n).toBe(0)
  })

  it('a single pirouette is one pirouette of one rotation', () => {
    const evs = runTurn()
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('pirouette')
    expect(evs[0].type).toBe('pirouette')
    expect(evs[0].direction).toBe('en dehors')
    expect(evs[0].rotations).toBe(1)
    expect(evs[0].supportingLeg).toBe('R')
    expect(evs[0].workingLeg).toBe('L')
  })

  it('counts a double as two rotations', () => {
    const evs = runTurn({ turns: 2 })
    expect(evs).toHaveLength(1)
    expect(evs[0].rotations).toBe(2)
  })

  it('a quarter turn is not a pirouette', () => {
    const det = new TurnDetector(SQUARE)
    let n = 0
    let t = 0
    for (let i = 0; i < 60; i++) { const p = { yaw: 0, passe: false }; const w = toWorld(p); if (det.pushFrame(toImage(p, w), t, w)) n++; t += DT }
    for (let i = 1; i <= 6; i++) { const p = { yaw: -15 * i }; const w = toWorld(p); if (det.pushFrame(toImage(p, w), t, w)) n++; t += DT }
    for (let i = 0; i < 45; i++) { const p = { yaw: -90, passe: false }; const w = toWorld(p); if (det.pushFrame(toImage(p, w), t, w)) n++; t += DT }
    expect(n).toBe(0)
  })

  it('works at 15, 24, 30 and 60 fps', () => {
    for (const fps of [15, 24, 30, 60]) {
      const evs = runTurn({ fps })
      expect(evs, `${fps} fps`).toHaveLength(1)
      expect(evs[0].type, `${fps} fps`).toBe('pirouette')
    }
  })

  it('a spin in the air is not a pirouette', () => {
    expect(runTurn({ pose: { lift: 0.25 } })).toHaveLength(0)
  })
})

describe('TurnDetector — a turn it cannot identify is a turn it must not score', () => {
  it('a turn without a passé is counted as a plain turn with NO metrics', () => {
    const evs = runTurn({ pose: { passe: false } })
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('turn')
    expect(evs[0].notPirouetteReason).toBe('no-passe')
    expect(evs[0].metrics).toEqual({})
  })
})

describe('TurnDetector — pirouette critique', () => {
  it('a clean pirouette is praised', () => {
    const evs = runTurn()
    const m = evs[0].metrics
    for (const [k, v] of Object.entries(m)) expect(v, k).not.toBeNull()
    expect(selectFeedback(m).kind).toBe('praise')
  })

  it('measures each quantity it was given', () => {
    const m = runTurn()[0].metrics
    expect(m.passe_connection!).toBeLessThan(0.3)
    expect(m.turn_axis_tilt!).toBeLessThan(3)
    expect(m.turn_hip_level!).toBeLessThan(2)
    expect(m.arm_height_high!).toBeGreaterThan(15)
    expect(m.arm_height_low!).toBeLessThan(45)
  })

  it('does not critique the relevé or the spot live - neither is measurable on a webcam', () => {
    // Checked on real footage: a clearly lifted heel read barely above flat, and a dancer
    // visibly holding the spot read as "head rides with the body". See pirouetteMetrics.
    const m = runTurn({ pose: { releve: 15 }, spot: 'none' })[0].metrics
    for (const k of ['releve_angle', 'spot_follow', 'retire_connection', 'hip_level']) expect(m).not.toHaveProperty(k)
  })

  // One fault at a time: each must be cued on ITS OWN correction.
  const FAULTS: Array<[string, Session, string]> = [
    ['a passé that floats off the knee', { pose: { passeGap: 0.30 } }, 'connect_passe'],
    ['turning at a slant', { pose: { lean: 14 } }, 'vertical_axis'],
    ['a hiked working hip', { pose: { hipHike: 0.12 } }, 'level_hips'],
    ['arms up at shoulder height', { pose: { armsDy: 0.30 } }, 'lower_arms_first'],
    ['arms dropped to the hips', { pose: { armsDy: -0.30 } }, 'lift_arms_first'],
    ['sagging elbows', { pose: { elbowSag: 0.20 } }, 'lift_elbows'],
  ]
  it.each(FAULTS)('%s is cued on its own correction', (_name, session, cue) => {
    const evs = runTurn(session)
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('pirouette')
    expect(cueOf(evs[0]), JSON.stringify(evs[0].metrics)).toBe(cue)
  })

  it('a hip hike does not also read as a slanted axis', () => {
    const m = runTurn({ pose: { hipHike: 0.035 } })[0].metrics
    expect(m.turn_axis_tilt!).toBeLessThan(6)
  })
})

describe('TurnDetector — a pirouette is not mistaken for another move', () => {
  it('neither the jump nor the arabesque detector fires during a double pirouette', () => {
    const jump = new JumpRepDetector()
    const ara = new ArabesqueDetector()
    let fired = 0
    let t = 0
    const push = (p: Pose) => {
      const w = toWorld(p)
      const lm = toImage(p, w)
      if (jump.pushFrame(lm, t, w)) fired++
      if (ara.pushFrame(lm, t, w)) fired++
      t += DT
    }
    for (let i = 0; i < 60; i++) push({ yaw: 0, passe: false, releve: 0 })
    for (let i = 1; i <= 40; i++) push({ yaw: -(720 * i) / 40, headRel: spotHead(-(720 * i) / 40) })
    for (let i = 0; i < 45; i++) push({ yaw: -720, passe: false, releve: 0 })
    expect(fired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The other turns. Each is told apart by what the legs do while the body rotates, as on the
// reference footage: the leg out to the side with a pause at the front of every rotation (à la
// seconde), passé turns entered by a step and turning toward the supporting leg (piqué), and
// both feet down while travelling (chaîné).
// ---------------------------------------------------------------------------

function runSequence(steps: Array<{ frames: number; pose: (i: number, n: number) => Pose }>, fps = FPS): TurnEvent[] {
  const det = new TurnDetector(SQUARE)
  const dt = 1000 / fps
  const out: TurnEvent[] = []
  let t = 0
  for (const st of [{ frames: Math.round(fps * 2), pose: (): Pose => ({ yaw: 0, passe: false, releve: 0 }) }, ...steps]) {
    for (let i = 0; i < st.frames; i++) {
      const p = st.pose(i, st.frames)
      const w = toWorld(p)
      const ev = det.pushFrame(toImage(p, w), t, w)
      if (ev) out.push(ev)
      t += dt
    }
  }
  return out
}

describe('TurnDetector — à la seconde, piqué and chaîné turns', () => {
  /** n second turns (each a rotation then a pause at the front), then m pirouette turns in passé. */
  function seconde(n: number, m: number, fps = FPS) {
    const steps: Array<{ frames: number; pose: (i: number, k: number) => Pose }> = []
    for (let k = 0; k < n; k++) {
      steps.push({ frames: Math.round(fps * 0.55), pose: (i, f) => ({ yaw: -360 * (k + (i + 1) / f), seconde: true }) })
      steps.push({ frames: Math.round(fps * 0.2), pose: () => ({ yaw: -360 * (k + 1), seconde: true }) })
    }
    steps.push({ frames: Math.round(fps * 0.5 * m), pose: (i, f) => ({ yaw: -360 * (n + (m * (i + 1)) / f) }) })
    steps.push({ frames: Math.round(fps * 1.5), pose: () => ({ yaw: -360 * (n + m), passe: false, releve: 0 }) })
    return runSequence(steps, fps)
  }

  it.each([[2, 2], [3, 3], [4, 2]])('%i second turns finished by %i pirouettes', (n, m) => {
    const evs = seconde(n, m)
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('seconde')
    expect(evs[0].secondeTurns).toBe(n)
    expect(evs[0].finishTurns).toBe(m)
  })

  it('à la seconde is critiqued on the leg out to the side, not as a pirouette', () => {
    const m = seconde(3, 2)[0].metrics
    expect(m.seconde_leg_height!).toBeGreaterThan(80)
    expect(m.seconde_leg_knee!).toBeGreaterThan(160)
    expect(m).not.toHaveProperty('turn_axis_tilt')
  })

  it('two piqué turns, each entered by a step and turning toward the supporting leg', () => {
    const steps: Array<{ frames: number; pose: (i: number, k: number) => Pose }> = []
    for (let k = 0; k < 2; k++) {
      const x0 = -0.06 * k
      steps.push({ frames: 10, pose: (i, f) => ({ yaw: 360 * k, passe: false, releve: 0, shiftX: x0 - (0.03 * (i + 1)) / f }) })
      // En dedans: supporting on the right, turning to the dancer's right (yaw increasing).
      steps.push({ frames: 16, pose: (i, f) => ({ yaw: 360 * (k + (i + 1) / f), shiftX: x0 - 0.03 }) })
    }
    steps.push({ frames: 45, pose: () => ({ yaw: 720, passe: false, releve: 0, shiftX: -0.15 }) })
    const evs = runSequence(steps)
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('pique')
    expect(evs[0].direction).toBe('en dedans')
    expect(evs[0].turns).toBe(2)
  })

  it('chaînés: both feet down, travelling, several turns', () => {
    const evs = runSequence([
      { frames: 75, pose: (i, f) => ({ yaw: (1080 * (i + 1)) / f, passe: false, releve: 50, shiftX: (0.4 * (i + 1)) / f }) },
      { frames: 45, pose: () => ({ yaw: 1080, passe: false, releve: 0, shiftX: 0.4 }) },
    ])
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('chaine')
    expect(evs[0].rotations).toBe(3)
    expect(evs[0].metrics).toHaveProperty('chaine_feet_apart')
  })

  it.each([['first', false], ['second', false], ['behind', true]] as const)(
    'chaînés with the arms in %s: told not to over-open = %s',
    (arms, told) => {
      // The arms may open and close; only swinging them back past second is a fault.
      const evs = runSequence([
        { frames: 75, pose: (i, f) => ({ yaw: (1080 * (i + 1)) / f, passe: false, releve: 50, shiftX: (0.4 * (i + 1)) / f, arms }) },
        { frames: 45, pose: () => ({ yaw: 1080, passe: false, releve: 0, shiftX: 0.4, arms }) },
      ])
      expect(evs[0].kind).toBe('chaine')
      const fb = selectFeedback(evs[0].metrics)
      const cues = fb.kind === 'correction' ? [fb.cueId, ...fb.also.map((a) => a.cueId)] : []
      expect(cues.includes('chaine_dont_overopen'), JSON.stringify(evs[0].metrics)).toBe(told)
    },
  )

  it('a spin on two feet that does not travel is a turn the app does not name', () => {
    const evs = runTurn({ pose: { passe: false } })
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('turn')
    expect(evs[0].metrics).toEqual({})
  })
})
