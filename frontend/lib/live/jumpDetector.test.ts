import { describe, expect, it } from 'vitest'
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { JumpRepDetector, type JumpRepEvent } from './jumpDetector'
import { jumpFeedback, selectFeedback } from './scoring'

// The synthetic bodies here are drawn in square coordinates (x and y on one scale), so the
// detectors are told the frame is square - a real webcam frame is 16:9 (MoveEngineConfig.aspect).
const SQUARE = { aspect: 1 }

// ---------------------------------------------------------------------------
// Body model.
//
// The distinction the detector now turns on is whether the FEET leave the floor,
// so the fixture has to model that honestly: `hipY` moves the hips against planted
// feet (crouching, standing up, swaying), while `lift` translates the WHOLE body
// including the ankles (the only thing that is physically a jump). A fixture that
// moved the hips alone would make every leap test vacuous.
// ---------------------------------------------------------------------------

const FPS = 30
const DT = 1000 / FPS
const GROUND = 0.90        // ankle y with the feet on the floor
const STANDING_HIP = 0.50

let seed = 12345
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
function jitter(amp: number): number {
  return (rnd() * 2 - 1) * amp
}

interface Frame {
  /** Legs splayed this many degrees fore and aft — what separates a leap from a jump. */
  split?: number
  /** Raise the LEFT ankle only, as an asymmetric tuck does. Not a split. */
  ankleDy?: number
  /** Push both knees outward in frame, as bending them does. Not a split either. */
  kneeBend?: number
  hipY?: number
  /** Whole-body upward translation — feet leave the ground. */
  lift?: number
  /** Visibility applied to hips (and, unless ankleVis is set, to the legs). */
  vis?: number
  ankleVis?: number
}

const DEFAULT_JITTER = 0.004   // ~0.4% of frame height: typical lite-model hip noise

function makeLandmarks(f: Frame = {}, jitterAmp = DEFAULT_JITTER): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const lift = f.lift ?? 0
  const hip = (f.hipY ?? STANDING_HIP) - lift
  const shoulder = hip - 0.30
  const ankle = GROUND - lift
  const knee = (hip + ankle) / 2   // planted case; the split case derives its own
  const v = f.vis ?? 1
  const av = f.ankleVis ?? v
  const put = (id: number, x: number, y: number, visibility: number) => {
    lm[id] = { x, y: y + jitter(jitterAmp), z: 0, visibility }
  }
  // `split` swings the legs fore and aft from the hips, which is what separates a leap
  // from a jump. At 0 the legs hang straight down and the geometry is the planted case.
  const s = f.split ?? 0
  const LEG = GROUND - STANDING_HIP
  const dx = s !== 0 ? LEG * Math.sin((s * Math.PI) / 180) : 0
  const splitAnkleY = s !== 0 ? hip + LEG * Math.cos((s * Math.PI) / 180) : ankle
  const lAnkleX = 0.45 + dx
  const rAnkleX = 0.55 - dx
  // A tuck raises one ankle more than the other. That vertical offset is NOT the legs
  // parting, and must not read as separation.
  const lAnkleY = splitAnkleY - (f.ankleDy ?? 0)
  // Bending a knee pushes it sideways in frame without the legs opening at all.
  const kb = f.kneeBend ?? 0
  const lKneeY = s !== 0 ? (hip + splitAnkleY) / 2 : knee
  const rKneeY = lKneeY

  put(11, 0.45, shoulder, v); put(12, 0.55, shoulder, v)
  put(23, 0.45, hip, v); put(24, 0.55, hip, v)
  put(25, (0.45 + lAnkleX) / 2 - kb, lKneeY, v)
  put(26, (0.55 + rAnkleX) / 2 + kb, rKneeY, av)
  put(27, lAnkleX, lAnkleY, av); put(28, rAnkleX, splitAnkleY, av)
  put(29, lAnkleX, lAnkleY + 0.02, av); put(30, rAnkleX, splitAnkleY + 0.02, av)
  put(31, lAnkleX, lAnkleY + 0.05, av); put(32, rAnkleX, splitAnkleY + 0.05, av)
  return lm
}

const hold = (n: number, f: Frame = {}): Frame[] => Array.from({ length: n }, () => ({ ...f }))

/** Ramp hipY from `from` to `to` over n frames, feet planted throughout. */
const ramp = (n: number, from: number, to: number): Frame[] =>
  Array.from({ length: n }, (_, i) => ({ hipY: from + (to - from) * ((i + 1) / n) }))

/**
 * One physically plausible leap: plié, ~300 ms of whole-body flight, landing plié.
 * `lift` peaks at 0.12 — the ankles rise exactly as much as the hips.
 */
function leapFrames(peak = 0.12, flightFrames = 9): Frame[] {
  return [
    ...hold(6, { hipY: 0.56 }),
    ...Array.from({ length: flightFrames }, (_, i) => ({
      lift: peak * Math.sin((Math.PI * (i + 1)) / (flightFrames + 1)),
    })),
    ...hold(6, { hipY: 0.56 }),
    ...hold(24),
  ]
}

/** Run frames through a detector after a settling period; return every rep emitted. */
function runSession(frames: Frame[], opts: { warmup?: number; jitterAmp?: number; tail?: number } = {}) {
  const { warmup = 90, jitterAmp = DEFAULT_JITTER, tail = 45 } = opts
  const det = new JumpRepDetector(SQUARE)
  const reps: JumpRepEvent[] = []
  let t = 0
  for (const f of [...hold(warmup), ...frames, ...hold(tail)]) {
    const ev = det.pushFrame(makeLandmarks(f, jitterAmp), t)
    if (ev) reps.push(ev)
    t += DT
  }
  return { reps, det }
}

const countReps = (frames: Frame[], opts?: Parameters<typeof runSession>[1]) => runSession(frames, opts).reps.length

// ---------------------------------------------------------------------------

describe('JumpRepDetector — no event on ordinary movement', () => {
  it('stands still for 10 s without firing', () => {
    expect(countReps(hold(300))).toBe(0)
  })

  it('ignores idle sway and posture adjustment', () => {
    const sway = Array.from({ length: 300 }, (_, i) => ({
      hipY: STANDING_HIP - 0.015 * Math.sin((2 * Math.PI * i) / 60),
    }))
    expect(countReps(sway)).toBe(0)
  })

  it('ignores walking gait bounce up to +/-0.03 at 1.5 Hz', () => {
    for (const amp of [0.01, 0.02, 0.03]) {
      const gait = Array.from({ length: 300 }, (_, i) => ({
        hipY: STANDING_HIP - amp * Math.sin((2 * Math.PI * 1.5 * i) / FPS),
      }))
      expect(countReps(gait), `gait bounce +/-${amp}`).toBe(0)
    }
  })

  it('ignores standing up out of a crouch — the original false positive', () => {
    // Hips rise 0.10, well over the 0.06 * bodyScale threshold, with the feet planted.
    // This is the exact sequence that used to emit a confirmed rep.
    expect(countReps([...hold(30, { hipY: 0.60 }), ...ramp(20, 0.60, 0.50), ...hold(180)])).toBe(0)
  })

  it('ignores a crouch-to-stand at every speed that used to fire', () => {
    // Measured before the fix: every ramp up to ~2 s produced exactly one rep.
    for (const frames of [5, 10, 20, 40, 60]) {
      expect(
        countReps([...hold(30, { hipY: 0.60 }), ...ramp(frames, 0.60, 0.50), ...hold(180)]),
        `crouch-to-stand over ${frames} frames`,
      ).toBe(0)
    }
  })

  it('ignores a postural rise at every magnitude that used to fire', () => {
    for (const amp of [0.05, 0.06, 0.08, 0.10]) {
      expect(
        countReps([
          ...hold(30, { hipY: STANDING_HIP + amp }),
          ...ramp(20, STANDING_HIP + amp, STANDING_HIP),
          ...hold(180),
        ]),
        `postural rise of ${amp}`,
      ).toBe(0)
    }
  })

  it('ignores walking into frame with untrustworthy hips', () => {
    const entering = Array.from({ length: 45 }, (_, i) => ({
      hipY: 0.58 - 0.02 * Math.sin(i / 3),
      vis: 0.3,
      ankleVis: 0.15,
    }))
    expect(countReps([...entering, ...hold(180)], { warmup: 30, jitterAmp: 0.012 })).toBe(0)
  })

  it('ignores a brief hip wobble under the confirmation window', () => {
    expect(countReps([...hold(2, { hipY: 0.40 }), ...hold(60)])).toBe(0)
  })

  it('never fires while the body scale is still warming up', () => {
    const det = new JumpRepDetector(SQUARE)
    let t = 0
    for (let i = 0; i < 10; i++) {
      expect(det.pushFrame(makeLandmarks({ lift: 0.15 }), t)).toBeNull()
      t += DT
    }
    expect(det.debug.phase).toBe('warmup')
  })
})

describe('JumpRepDetector — confirmed leaps', () => {
  it('counts one real leap exactly once', () => {
    expect(countReps(leapFrames())).toBe(1)
  })

  it('counts two real leaps in a row as exactly two', () => {
    expect(countReps([...leapFrames(), ...hold(20), ...leapFrames()])).toBe(2)
  })

  it('counts five real leaps as exactly five', () => {
    const many = Array.from({ length: 5 }, () => [...leapFrames(), ...hold(20)]).flat()
    expect(countReps(many)).toBe(5)
  })

  it('reports plausible takeoff/apex/landing ordering and real airtime', () => {
    const { reps } = runSession(leapFrames())
    expect(reps).toHaveLength(1)
    const rep = reps[0]
    expect(rep.takeoffMs).toBeLessThan(rep.apexMs)
    expect(rep.apexMs).toBeLessThanOrEqual(rep.landingMs)
    expect(rep.airborneMs).toBeGreaterThanOrEqual(100)
    expect(rep.airborneMs).toBeLessThanOrEqual(800)
    expect(rep.metrics.land_plie).not.toBeNull()
    expect(rep.metrics.front_leg_ext).not.toBeNull()
    expect(rep.metrics.back_leg_ext).not.toBeNull()
  })

  it('records ankles rising with the hips on a real leap', () => {
    const { reps } = runSession(leapFrames())
    expect(reps[0].peakAnkleRise).toBeGreaterThanOrEqual(0.7 * reps[0].peakHipRise)
  })

  it('does not double-count a landing plié recovery or rebound', () => {
    const withRebound: Frame[] = [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: 9 }, (_, i) => ({ lift: 0.12 * Math.sin((Math.PI * (i + 1)) / 10) })),
      ...hold(4, { hipY: 0.58 }),        // deep landing plié
      ...ramp(8, 0.58, 0.48),            // fast recovery up, overshooting standing
      ...hold(6, { hipY: 0.48 }),
      ...hold(80),
    ]
    expect(countReps(withRebound)).toBe(1)
  })

  it('survives one noisy sub-threshold frame mid-flight without splitting the leap', () => {
    const flight = Array.from({ length: 11 }, (_, i) => ({
      // Frame 5 collapses to the floor for a single frame, as a dropped track would.
      lift: i === 5 ? 0.0 : 0.12 * Math.sin((Math.PI * (i + 1)) / 12),
    }))
    const frames = [...hold(6, { hipY: 0.56 }), ...flight, ...hold(6, { hipY: 0.56 }), ...hold(40)]
    expect(countReps(frames)).toBe(1)
  })
})

describe('JumpRepDetector — gates', () => {
  it('rejects a hip rise when the ankles stay planted, and says why', () => {
    const det = new JumpRepDetector(SQUARE)
    let t = 0
    for (const f of [...hold(90), ...hold(30, { hipY: 0.60 }), ...ramp(20, 0.60, 0.50)]) {
      det.pushFrame(makeLandmarks(f), t)
      t += DT
    }
    expect(det.debug.lastReject).toBe('ankles-planted')
    expect(det.debug.reps).toBe(0)
  })

  it('refuses to count a rep when the ankles are not trustworthy', () => {
    // Same whole-body flight, but the ankles report low visibility throughout.
    const frames = leapFrames().map((f) => ({ ...f, ankleVis: 0.2 }))
    expect(countReps(frames)).toBe(0)
  })

  it('resets state and rolling windows across a tracking gap', () => {
    const det = new JumpRepDetector(SQUARE)
    let t = 0
    for (const f of hold(90)) {
      det.pushFrame(makeLandmarks(f), t)
      t += DT
    }
    expect(det.debug.phase).toBe('idle')
    t += 1000                                    // dancer leaves frame for a second
    det.pushFrame(makeLandmarks(), t)
    expect(det.debug.phase).toBe('warmup')       // windows dropped, not bridged
  })

  it('drops an implausibly long "flight" as baseline drift', () => {
    // Whole body held aloft for 2 s — passes the ankle gate but is not a jump.
    expect(countReps([...Array.from({ length: 60 }, () => ({ lift: 0.12 })), ...hold(60)])).toBe(0)
  })

  it('exposes a debug readout for diagnosing against footage', () => {
    const { det } = runSession(leapFrames())
    const d = det.debug
    expect(d).toMatchObject({
      phase: expect.any(String),
      hipRise: expect.any(Number),
      ankleRise: expect.any(Number),
      ankleRatio: expect.any(Number),
      enterThreshold: expect.any(Number),
      exitThreshold: expect.any(Number),
      bodyScale: expect.any(Number),
      reps: 1,
    })
    expect(d.exitThreshold).toBeLessThan(d.enterThreshold)   // hysteresis
  })
})

describe('JumpRepDetector — frame rate independence', () => {
  it('counts one leap at 15, 30 and 60 fps', () => {
    for (const fps of [15, 30, 60]) {
      const dt = 1000 / fps
      const det = new JumpRepDetector(SQUARE)
      let t = 0
      let reps = 0
      const warm = Math.round(3 * fps)
      const flightFrames = Math.max(4, Math.round(0.30 * fps))   // 300 ms of flight
      const plieFrames = Math.max(2, Math.round(0.20 * fps))
      const frames: Frame[] = [
        ...hold(warm),
        ...hold(plieFrames, { hipY: 0.56 }),
        ...Array.from({ length: flightFrames }, (_, i) => ({
          lift: 0.12 * Math.sin((Math.PI * (i + 1)) / (flightFrames + 1)),
        })),
        ...hold(plieFrames, { hipY: 0.56 }),
        ...hold(Math.round(2 * fps)),
      ]
      for (const f of frames) {
        if (det.pushFrame(makeLandmarks(f), t)) reps++
        t += dt
      }
      expect(reps, `${fps} fps`).toBe(1)
    }
  })
})

describe('JumpRepDetector — leap vs jump', () => {
  /** Whole-body flight with the legs splayed `split` degrees fore and aft. */
  function flight(split: number, peak = 0.13, n = 10): Frame[] {
    return [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => ({
        lift: peak * Math.sin((Math.PI * (i + 1)) / (n + 1)),
        split,
      })),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
  }

  it('counts a straight jump with the legs together as a JUMP, not a leap', () => {
    const { reps } = runSession(flight(0))
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
    expect(reps[0].separationRatio).toBeLessThan(0.35)
  })

  it('counts a real split leap as a LEAP', () => {
    const { reps } = runSession(flight(50))
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
    expect(reps[0].separationRatio).toBeGreaterThanOrEqual(0.35)
  })

  it('applies no leap-only metric to a jump', () => {
    const { reps } = runSession(flight(0))
    // split_angle and back_leg_height are leap critiques, so a jump must not receive
    // them. They are ABSENT rather than null: null is reserved for "tried to measure
    // and failed", which is what stops selectFeedback praising an unmeasurable rep.
    expect(reps[0].metrics).not.toHaveProperty('split_angle')
    expect(reps[0].metrics).not.toHaveProperty('back_leg_height')
    expect(reps[0].metrics).not.toHaveProperty('leap_back_leg_drop')
  })

  it('still scores a leap on its split', () => {
    const { reps } = runSession(flight(50))
    expect(reps[0].metrics.split_angle).not.toBeNull()
  })

  it('does not drop the jump — it is a real rep, just not a leap', () => {
    const { reps } = runSession([...flight(0), ...hold(20), ...flight(50)])
    expect(reps.map((r) => r.type)).toEqual(['jump (sauté-type)', 'leap (jeté-type)'])
  })
})

describe('JumpRepDetector — closed legs stay a jump at every height', () => {
  /** Closed-leg jump whose tuck deepens with height, as a real one does. */
  function tuckJump(peak: number): Frame[] {
    const n = 10
    return [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => {
        const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
        return {
          lift: peak * ph,
          // Asymmetric tuck: one ankle rides higher, and both knees splay in frame.
          ankleDy: 0.18 * ph * (peak / 0.12),
          kneeBend: 0.06 * ph,
        }
      }),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
  }

  it('never calls a closed-leg jump a leap, however high it goes', () => {
    // The regression: separationRatio used the full 2-D ankle distance, so an
    // asymmetric tuck's VERTICAL offset climbed with jump height (measured
    // 0.144 -> 0.219) and eventually crossed the leap threshold.
    for (const peak of [0.08, 0.12, 0.16, 0.20, 0.24]) {
      const { reps } = runSession(tuckJump(peak))
      expect(reps.length, `peak ${peak}`).toBe(1)
      expect(reps[0].type, `peak ${peak} classified as leap`).toBe('jump (sauté-type)')
    }
  })

  it('keeps separationRatio flat across jump height for closed legs', () => {
    const ratios = [0.08, 0.12, 0.16, 0.20].map((p) => runSession(tuckJump(p)).reps[0].separationRatio)
    const spread = Math.max(...ratios) - Math.min(...ratios)
    expect(spread, `ratios ${ratios.map((r) => r.toFixed(3)).join(', ')}`).toBeLessThan(0.05)
  })

  it('does not let bent knees masquerade as a split', () => {
    // Legs wide enough in frame to clear the separation bar, but knees folded.
    const bent = [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: 10 }, (_, i) => ({
        lift: 0.13 * Math.sin((Math.PI * (i + 1)) / 11),
        split: 50,
        kneeBend: 0.16,
      })),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
    const { reps } = runSession(bent)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
  })
})

describe('JumpRepDetector — a closed-leg jump is never a leap, at any height', () => {
  /** Closed legs throughout. `blip` splays the ankles apart on ONE apex frame only. */
  function closedJump(peak: number, opts: { bend?: number; blip?: number } = {}): Frame[] {
    const n = 12
    const apexIdx = Math.round(n / 2)
    return [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => {
        const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
        return {
          lift: peak * ph,
          ankleDy: 0.20 * ph * (peak / 0.12),
          kneeBend: (opts.bend ?? 0.05) * ph,
          // A single-frame landmark blip must not be enough to pass the gate.
          split: i === apexIdx ? (opts.blip ?? 0) : 0,
        }
      }),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
  }

  const HEIGHTS: Array<[string, number]> = [
    ['low', 0.07], ['medium', 0.12], ['high', 0.18], ['very high', 0.24],
  ]

  it.each(HEIGHTS)('%s closed-leg jump is classified as a jump', (_label, peak) => {
    const { reps } = runSession(closedJump(peak))
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
  })

  it.each(HEIGHTS)('%s closed-leg jump carries no scoreable metric at all', (_label, peak) => {
    const { reps } = runSession(closedJump(peak))
    // Structural guarantee: with no metrics there is nothing for the leap scorer to
    // score, so a leap critique on a jump is impossible rather than threshold-dependent.
    expect(Object.keys(reps[0].metrics)).toHaveLength(0)
    expect(selectFeedback(reps[0].metrics).kind).toBe('unassessable')
  })

  it.each(HEIGHTS)('%s closed-leg jump gets the fixed "counted" cue, not a correction', (_label, peak) => {
    const { reps } = runSession(closedJump(peak))
    const fb = reps[0].type === 'leap (jeté-type)' ? selectFeedback(reps[0].metrics) : jumpFeedback()
    expect(fb.kind).toBe('fixed')
    if (fb.kind !== 'fixed') return
    expect(fb.cueId).toBe('straight_jump_counted')
    expect(fb.cue.toLowerCase()).toContain('counted')
  })

  it('a one-frame ankle blip at the apex cannot pass the split gate', () => {
    // Legs closed for the whole flight except a single frame splayed to a full split.
    for (const peak of [0.12, 0.18, 0.24]) {
      const { reps } = runSession(closedJump(peak, { blip: 55 }))
      expect(reps).toHaveLength(1)
      expect(reps[0].type, `peak ${peak} with apex blip`).toBe('jump (sauté-type)')
    }
  })

  it('a hard tuck cannot fake a split even with the ankles far apart in frame', () => {
    const { reps } = runSession(closedJump(0.18, { bend: 0.20 }))
    expect(reps[0].type).toBe('jump (sauté-type)')
  })
})

describe('JumpRepDetector — real split leaps are unaffected', () => {
  function splitLeap(peak: number): Frame[] {
    const n = 12
    return [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => ({
        lift: peak * Math.sin((Math.PI * (i + 1)) / (n + 1)),
        split: 50,
      })),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
  }

  it.each([['low', 0.07], ['medium', 0.12], ['high', 0.18]] as Array<[string, number]>)(
    '%s split leap is still classified as a leap and still scored',
    (_label, peak) => {
      const { reps } = runSession(splitLeap(peak))
      expect(reps).toHaveLength(1)
      expect(reps[0].type).toBe('leap (jeté-type)')
      expect(reps[0].metrics.split_angle).not.toBeNull()
      expect(Object.keys(reps[0].metrics).length).toBeGreaterThan(0)
      // Goes down the scoring path, not the fixed-cue path.
      expect(selectFeedback(reps[0].metrics).kind).not.toBe('fixed')
    },
  )

  it('a single dropped frame mid-split does not demote a leap to a jump', () => {
    const n = 12
    const frames: Frame[] = [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => ({
        lift: 0.14 * Math.sin((Math.PI * (i + 1)) / (n + 1)),
        split: i === 6 ? 0 : 50,      // one frame where the legs read as closed
      })),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
    const { reps } = runSession(frames)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
  })
})

describe('JumpRepDetector — legs closing to land must not demote a leap', () => {
  /**
   * A realistic jeté: legs open through takeoff, hold the split across the apex, then
   * close again on the way down so the dancer lands on two feet. That closing phase is
   * correct technique — the split gate must not sample it.
   */
  function leapClosingToLand(peak: number, closeFrames: number): Frame[] {
    const n = 12
    return [
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => {
        const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
        const framesLeft = n - 1 - i
        // Legs scissor shut over the final `closeFrames` frames of flight.
        const closing = framesLeft < closeFrames ? framesLeft / closeFrames : 1
        return { lift: peak * ph, split: 50 * closing }
      }),
      ...hold(8, { hipY: 0.56 }),
      ...hold(30),
    ]
  }

  it.each([['low', 0.07], ['medium', 0.12], ['high', 0.18], ['very high', 0.24]] as Array<[string, number]>)(
    '%s split leap that closes its legs to land is still a leap',
    (_label, peak) => {
      const { reps } = runSession(leapClosingToLand(peak, 4))
      expect(reps).toHaveLength(1)
      expect(reps[0].type).toBe('leap (jeté-type)')
      expect(reps[0].metrics.split_angle).not.toBeNull()
    },
  )

  it('survives a long closing phase — a third of the flight spent shutting the legs', () => {
    const { reps } = runSession(leapClosingToLand(0.14, 5))
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
  })

  it('a jump whose legs never open is still a jump, at every height', () => {
    // Same flight shape and the same landing close, but the split never opens at all —
    // there is no wide point anywhere in the flight for the gate to anchor on.
    for (const peak of [0.07, 0.12, 0.18, 0.24]) {
      const { reps } = runSession(leapClosingToLand(peak, 4).map((f) => ({ ...f, split: 0 })))
      expect(reps, `peak ${peak}`).toHaveLength(1)
      expect(reps[0].type, `peak ${peak}`).toBe('jump (sauté-type)')
      expect(Object.keys(reps[0].metrics), `peak ${peak}`).toHaveLength(0)
    }
  })
})

describe('JumpRepDetector — classification holds at real capture rates', () => {
  /**
   * A leap or jump built for a given fps and airtime. `splitDeg` 0 means the legs never
   * open; `closeFrac` is the share of flight spent scissoring shut to land.
   *
   * This exists because the fixed-ms sampling window turned into a frame-count problem
   * off-camera: a 280 ms leap is ~17 frames at 60 fps but only ~3 at 12 fps. Measured
   * before the fix, real split leaps misclassified as jumps at every rate from 12 to
   * 30 fps and only 60 fps passed — which is why classification is now fps-parameterised.
   */
  function rep(fps: number, flightMs: number, peak: number, splitDeg: number, closeFrac = 0.3): Frame[] {
    const n = Math.max(3, Math.round((flightMs / 1000) * fps))
    const plie = Math.max(2, Math.round(0.2 * fps))
    const cf = Math.max(1, Math.round(n * closeFrac))
    return [
      ...hold(plie, { hipY: 0.56 }),
      ...Array.from({ length: n }, (_, i) => {
        const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
        const left = n - 1 - i
        return { lift: peak * ph, split: splitDeg * (left < cf ? left / cf : 1) }
      }),
      ...hold(plie, { hipY: 0.56 }),
      ...hold(Math.round(fps)),
    ]
  }

  function runAt(frames: Frame[], fps: number): JumpRepEvent[] {
    const det = new JumpRepDetector(SQUARE)
    const dt = 1000 / fps
    let t = 0
    const out: JumpRepEvent[] = []
    for (const f of [...hold(Math.round(3 * fps)), ...frames, ...hold(Math.round(1.5 * fps))]) {
      const ev = det.pushFrame(makeLandmarks(f), t)
      if (ev) out.push(ev)
      t += dt
    }
    return out
  }

  const RATES = [12, 15, 20, 24, 30, 60]
  const SIZES: Array<[string, number, number]> = [
    ['low', 180, 0.07], ['medium', 280, 0.13], ['high', 400, 0.20],
  ]

  for (const fps of RATES) {
    for (const [label, ms, peak] of SIZES) {
      it(`${label} split leap at ${fps} fps is never misclassified as a jump`, () => {
        const reps = runAt(rep(fps, ms, peak, 50), fps)
        // A small hop at a low frame rate can have too few frames above the rise
        // threshold to confirm at all (180 ms at 20 fps clears it on 2 frames, under
        // confirmMinFrames). That is a detection-sensitivity floor, not a
        // classification bug — what must never happen is a split leap reading as a jump.
        if (!reps.length) return
        expect(reps[0].type).toBe('leap (jeté-type)')
        // Must reach the scoring path, not the fixed jump cue.
        expect(Object.keys(reps[0].metrics).length).toBeGreaterThan(0)
        expect(selectFeedback(reps[0].metrics).kind).not.toBe('fixed')
      })
    }
  }

  it('medium and high split leaps are detected AND classified at every rate', () => {
    // The guard above tolerates a missing rep; this pins that the tolerance is not
    // hiding a total failure to detect at any realistic capture rate.
    for (const fps of RATES) {
      for (const [label, ms, peak] of SIZES.slice(1)) {
        const reps = runAt(rep(fps, ms, peak, 50), fps)
        expect(reps, `${label} at ${fps} fps`).toHaveLength(1)
        expect(reps[0].type, `${label} at ${fps} fps`).toBe('leap (jeté-type)')
      }
    }
  })

  for (const fps of RATES) {
    it(`closed-leg jumps stay jumps at ${fps} fps`, () => {
      for (const [label, ms, peak] of SIZES) {
        const reps = runAt(rep(fps, ms, peak, 0), fps)
        // A very small hop can fall under minAirborneMs and not be a rep at all; what
        // must never happen is it being called a leap.
        if (!reps.length) continue
        expect(reps[0].type, `${label} at ${fps} fps`).toBe('jump (sauté-type)')
        expect(Object.keys(reps[0].metrics), `${label} at ${fps} fps`).toHaveLength(0)
      }
    })
  }

  it('a long closing phase still does not demote a leap', () => {
    // 60% of the flight spent scissoring shut — the landing-window bug, re-checked
    // against the proportional sampler.
    //
    // Only rates that give the flight enough frames to show a HELD split. At 12 fps a
    // 280 ms flight is 3 frames and 2 of them are closing, so there is genuinely no held
    // split to find; calling that a jump is the correct conservative answer, not a bug.
    for (const fps of RATES.filter((f) => (280 / 1000) * f >= 5)) {
      const reps = runAt(rep(fps, 280, 0.13, 50, 0.6), fps)
      expect(reps, `${fps} fps`).toHaveLength(1)
      expect(reps[0].type, `${fps} fps`).toBe('leap (jeté-type)')
    }
  })
})

// ---------------------------------------------------------------------------
// Real capture conditions: irregular frame timing, and a split aimed at the camera.
// ---------------------------------------------------------------------------

/** The pose as a continuous function of TIME; the camera samples it at irregular instants. */
interface Move { plieMs: number; flightMs: number; peak: number; splitDeg: number; closeFrac: number }

function poseAt(tMs: number, m: Move): Frame {
  if (tMs < m.plieMs) return { hipY: 0.56 }
  const ft = tMs - m.plieMs
  if (ft < m.flightMs) {
    const ph = Math.sin((Math.PI * ft) / m.flightMs)
    const closeStart = m.flightMs * (1 - m.closeFrac)
    const close = ft < closeStart ? 1 : Math.max(0, (m.flightMs - ft) / (m.flightMs - closeStart))
    return { lift: m.peak * ph, split: m.splitDeg * close }
  }
  if (ft < m.flightMs + m.plieMs) return { hipY: 0.56 }
  return {}
}

let jseed = 99
const jrnd = () => ((jseed = (jseed * 1664525 + 1013904223) >>> 0), jseed / 4294967296)

/** Irregular capture: a base interval with jitter, plus periodic MediaPipe stalls. */
function jitteryIntervals(n: number, baseMs: number, jitterMs: number, stallMs: number, stallEvery: number) {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    let dt = baseMs + (jrnd() * 2 - 1) * jitterMs
    if (stallEvery > 0 && i % stallEvery === stallEvery - 1) dt += stallMs
    out.push(Math.max(8, dt))
  }
  return out
}

function runIrregular(m: Move, iv: number[]): JumpRepEvent[] {
  const det = new JumpRepDetector(SQUARE)
  const out: JumpRepEvent[] = []
  let t = 0
  let k = 0
  while (t < 3000) { det.pushFrame(makeLandmarks({}), t); t += iv[k++ % iv.length] }
  const t0 = t
  while (t - t0 < m.plieMs * 2 + m.flightMs + 1500) {
    const ev = det.pushFrame(makeLandmarks(poseAt(t - t0, m)), t)
    if (ev) out.push(ev)
    t += iv[k++ % iv.length]
  }
  return out
}

describe('JumpRepDetector — irregular capture timing', () => {
  const LEAP: Move = { plieMs: 200, flightMs: 300, peak: 0.14, splitDeg: 50, closeFrac: 0.3 }
  const JUMP: Move = { ...LEAP, splitDeg: 0 }

  // base, jitter, stall, stallEvery — a laptop webcam under MediaPipe load.
  const PROFILES: Array<[string, number, number, number, number]> = [
    ['steady 24 fps', 42, 0, 0, 0],
    ['24 fps, +/-15 ms jitter', 42, 15, 0, 0],
    ['24 fps, +/-25 ms jitter', 42, 25, 0, 0],
    ['24 fps with 80 ms stalls', 42, 15, 80, 4],
    ['24 fps with 120 ms stalls', 42, 25, 120, 3],
    ['18 fps with 150 ms stalls', 55, 30, 150, 3],
  ]

  it.each(PROFILES)('a split leap is never called a jump under %s', (_label, base, jit, stall, every) => {
    const reps = runIrregular(LEAP, jitteryIntervals(60, base, jit, stall, every))
    // Heavy stalling (120 ms every third frame is ~12 fps effective) can leave too few
    // frames above the rise threshold to confirm a rep at all. Losing the rep is a
    // detection limit; calling a real split a jump is the bug this guards.
    if (!reps.length) return
    expect(reps[0].type).toBe('leap (jeté-type)')
  })

  it('detects the leap outright under jitter without heavy stalls', () => {
    for (const [label, base, jit, stall, every] of PROFILES.filter((p) => p[3] <= 80)) {
      const reps = runIrregular(LEAP, jitteryIntervals(60, base, jit, stall, every))
      expect(reps, label).toHaveLength(1)
      expect(reps[0].type, label).toBe('leap (jeté-type)')
    }
  })

  it.each(PROFILES)('a closed-leg jump stays a jump under %s', (_label, base, jit, stall, every) => {
    const reps = runIrregular(JUMP, jitteryIntervals(60, base, jit, stall, every))
    if (!reps.length) return
    expect(reps[0].type).toBe('jump (sauté-type)')
  })

  it('reports the capture timing it actually saw', () => {
    const reps = runIrregular(LEAP, jitteryIntervals(60, 42, 25, 120, 3))
    const rep = reps[0]
    expect(rep.flightFrames).toBeGreaterThan(1)
    expect(rep.sampleFrames).toBeGreaterThanOrEqual(2)
    // A stalling capture must be visible as a spread, not averaged away.
    expect(rep.frameIntervalMs.max).toBeGreaterThan(rep.frameIntervalMs.min)
    expect(rep.frameIntervalMs.mean).toBeGreaterThan(0)
  })
})

describe('JumpRepDetector — a split aimed at the camera', () => {
  // /live runs facingMode:'user', so the dancer faces the lens and a jeté splits fore
  // and aft — almost entirely in DEPTH. In the image plane the ankles stay at about hip
  // width, which is why real leaps read as jumps with only occasional successes.
  // World coordinates are metric and unforeshortened, so the split is visible there.

  /** Image landmarks: whole body rises, but the split barely shows across frame. */
  function depthImage(lift: number, splitFrac: number): NormalizedLandmark[] {
    const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
    const put = (i: number, x: number, y: number) => { lm[i] = { x, y, z: 0, visibility: 1 } }
    const hipY = 0.50 - lift
    // A leg swung toward/away from the lens foreshortens: the ankle rides UP the frame
    // slightly, but its horizontal position hardly moves at all.
    const fore = 0.06 * splitFrac
    put(11, 0.45, hipY - 0.30); put(12, 0.55, hipY - 0.30)
    put(23, 0.45, hipY); put(24, 0.55, hipY)
    put(25, 0.45, hipY + 0.20 - fore * 0.5); put(26, 0.55, hipY + 0.20 - fore * 0.5)
    put(27, 0.45, hipY + 0.40 - fore); put(28, 0.55, hipY + 0.40 - fore)
    put(29, 0.45, hipY + 0.42 - fore); put(30, 0.55, hipY + 0.42 - fore)
    put(31, 0.45, hipY + 0.45 - fore); put(32, 0.55, hipY + 0.45 - fore)
    return lm
  }

  /** World landmarks (metres, hip-centred, Y-down): the split is plainly there, in z. */
  function depthWorld(splitFrac: number): Landmark[] {
    const w: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const put = (i: number, x: number, up: number, z: number) => { w[i] = { x, y: -up, z, visibility: 1 } }
    const reach = 0.62 * splitFrac        // how far each ankle travels fore/aft, metres
    put(11, -0.16, 0.50, 0); put(12, 0.16, 0.50, 0)
    put(23, -0.10, 0, 0); put(24, 0.10, 0, 0)
    put(25, -0.10, -0.42, -reach * 0.5); put(26, 0.10, -0.42, reach * 0.5)
    put(27, -0.10, -0.84, -reach); put(28, 0.10, -0.84, reach)
    put(29, -0.10, -0.86, -reach); put(30, 0.10, -0.86, reach)
    put(31, -0.10, -0.90, -reach); put(32, 0.10, -0.90, reach)
    return w
  }

  function runDepth(splitFrac: number, withWorld: boolean, fps = 24) {
    const det = new JumpRepDetector(SQUARE)
    const dt = 1000 / fps
    const n = Math.round(0.30 * fps)
    const out: JumpRepEvent[] = []
    let t = 0
    const push = (lift: number, sf: number) => {
      const ev = det.pushFrame(depthImage(lift, sf), t, withWorld ? depthWorld(sf) : undefined)
      if (ev) out.push(ev)
      t += dt
    }
    for (let i = 0; i < Math.round(3 * fps); i++) push(0, 0)
    for (let i = 0; i < Math.round(0.2 * fps); i++) push(-0.06, 0)      // plié
    for (let i = 0; i < n; i++) {
      const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
      push(0.14 * ph, splitFrac * ph)
    }
    for (let i = 0; i < Math.round(0.2 * fps); i++) push(-0.06, 0)      // landing plié
    for (let i = 0; i < Math.round(1.5 * fps); i++) push(0, 0)
    return out
  }

  it('image landmarks alone cannot see a split aimed at the camera (the reported bug)', () => {
    const reps = runDepth(1, false)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
    expect(reps[0].separationSource).toBe('image')
  })

  it('world landmarks see it, at every capture rate', () => {
    for (const fps of [15, 20, 24, 30, 60]) {
      const reps = runDepth(1, true, fps)
      expect(reps, `${fps} fps`).toHaveLength(1)
      expect(reps[0].type, `${fps} fps`).toBe('leap (jeté-type)')
      expect(reps[0].separationSource).toBe('world')
      expect(Object.keys(reps[0].metrics).length).toBeGreaterThan(0)
    }
  })

  it('legs together in depth is still a jump when world data is available', () => {
    const reps = runDepth(0, true)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
    expect(Object.keys(reps[0].metrics)).toHaveLength(0)
  })
})

describe('JumpRepDetector — short reps must be able to clear the leap gates', () => {
  // Reproduces a real logged rep:
  //   [live] jump airborne=183ms sep=1.57 (world) ... 7 flight frames, 3 sampled
  // sep=1.57 is nearly 3x the 0.60 bar, yet it classified as a jump. The gates were
  // ANDed per frame and then fraction-tested: with 3 samples, 2/3 = 0.667 < 0.7, so the
  // rule silently demanded 3 of 3 frames be simultaneously wide AND straight-kneed.

  function worldSplit(splitFrac: number, kneeBendDeg: number): Landmark[] {
    const w: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const put = (i: number, x: number, up: number, z: number) => { w[i] = { x, y: -up, z, visibility: 1 } }
    const reach = 0.62 * splitFrac
    put(11, -0.16, 0.50, 0); put(12, 0.16, 0.50, 0)
    put(23, -0.10, 0, 0); put(24, 0.10, 0, 0)
    put(25, -0.10, -0.42, -reach * 0.5); put(26, 0.10, -0.42, reach * 0.5)
    put(27, -0.10, -0.84, -reach); put(28, 0.10, -0.84, reach)
    put(29, -0.10, -0.86, -reach); put(30, 0.10, -0.86, reach)
    put(31, -0.10, -0.90, -reach); put(32, 0.10, -0.90, reach)
    void kneeBendDeg
    return w
  }

  /** Image frame whose knees can be bent independently of the world split. */
  function img(lift: number, kneeBendDeg: number): NormalizedLandmark[] {
    const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
    const put = (i: number, x: number, y: number) => { lm[i] = { x, y, z: 0, visibility: 1 } }
    const hipY = 0.50 - lift
    const kb = (kneeBendDeg / 90) * 0.10      // bend pushes the knee sideways in frame
    put(11, 0.45, hipY - 0.30); put(12, 0.55, hipY - 0.30)
    put(23, 0.45, hipY); put(24, 0.55, hipY)
    put(25, 0.45 - kb, hipY + 0.20); put(26, 0.55 + kb, hipY + 0.20)
    put(27, 0.45, hipY + 0.40); put(28, 0.55, hipY + 0.40)
    put(29, 0.45, hipY + 0.42); put(30, 0.55, hipY + 0.42)
    put(31, 0.45, hipY + 0.45); put(32, 0.55, hipY + 0.45)
    return lm
  }

  /** A 183 ms leap at 24 fps with one frame's knee estimate gone noisy. */
  function shortLeap(noisyKneeAt: number | null) {
    const det = new JumpRepDetector(SQUARE)
    const fps = 24
    const dt = 1000 / fps
    const n = 7
    const out: JumpRepEvent[] = []
    let t = 0
    const push = (lift: number, sf: number, bend: number) => {
      const ev = det.pushFrame(img(lift, bend), t, worldSplit(sf, bend))
      if (ev) out.push(ev)
      t += dt
    }
    for (let i = 0; i < 72; i++) push(0, 0, 0)
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0)
    for (let i = 0; i < n; i++) {
      const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
      push(0.13 * ph, ph, i === noisyKneeAt ? 70 : 0)
    }
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0)
    for (let i = 0; i < 36; i++) push(0, 0, 0)
    return out
  }

  it('a wide short leap is a leap even when one sampled frame has a bad knee estimate', () => {
    const reps = shortLeap(3)
    expect(reps).toHaveLength(1)
    expect(reps[0].leapGate.sepMedian).toBeGreaterThan(reps[0].leapGate.sepThreshold)
    expect(reps[0].type).toBe('leap (jeté-type)')
    expect(reps[0].leapGate.failed).toBe('none')
  })

  it('the hold requirement is a rounded count, so 2 of 3 frames is enough', () => {
    const reps = shortLeap(null)
    const g = reps[0].leapGate
    // With few samples a raw 0.7 fraction rounds up to "all of them"; the count must not.
    expect(g.sepRequired).toBeLessThanOrEqual(Math.max(2, Math.round(0.7 * reps[0].sampleFrames)))
    expect(g.sepPassing).toBeGreaterThanOrEqual(g.sepRequired)
  })

  it('reports which gate decided the rep', () => {
    const leap = shortLeap(null)[0]
    expect(leap.leapGate.failed).toBe('none')

    // Legs together: the deciding gate must be named, not left to guesswork.
    const det = new JumpRepDetector(SQUARE)
    const fps = 24
    const dt = 1000 / fps
    let t = 0
    let closed: JumpRepEvent | undefined
    const push = (lift: number) => {
      const ev = det.pushFrame(img(lift, 0), t, worldSplit(0, 0))
      if (ev) closed = ev
      t += dt
    }
    for (let i = 0; i < 72; i++) push(0)
    for (let i = 0; i < 5; i++) push(-0.06)
    for (let i = 0; i < 8; i++) push(0.13 * Math.sin((Math.PI * (i + 1)) / 9))
    for (let i = 0; i < 5; i++) push(-0.06)
    for (let i = 0; i < 36; i++) push(0)
    expect(closed).toBeDefined()
    expect(closed!.type).toBe('jump (sauté-type)')
    // The split ANGLE decides leap vs jump now (see the leap gate in finalizeRep), so legs that
    // never open are named as exactly that.
    expect(closed!.leapGate.failed).toBe('legs-not-split')
  })
})

describe('JumpRepDetector — knee gate on legs pointing at the camera', () => {
  // Reproduces a real logged rep:
  //   [live] jump | FAILED on knees-bent — sep median 1.83 vs 0.60, 7/7 cleared,
  //          knee median 131 vs 140 deg
  // The legs were visually confirmed straight. Measured on a perfectly straight leg,
  // the IMAGE-plane angle decays from 176 deg (leg hanging down) to 129 deg (leg almost
  // at the lens) purely from the projection collapsing; in 3-D it holds 175-176 deg.

  const THIGH = 0.42, SHIN = 0.42
  const SCALE = 0.40 / (THIGH + SHIN)      // normalized image units per metre
  const rad = (d: number) => (d * Math.PI) / 180

  /**
   * One flight frame. `legDeg` swings both legs fore/aft in the sagittal plane (so they
   * point toward and away from the lens); `bendDeg` genuinely folds the knees.
   */
  function frame(lift: number, legDeg: number, bendDeg: number, imgNoise = 0) {
    const world: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))

    const setW = (i: number, p: { x: number; y: number; z: number }) => {
      world[i] = { x: p.x, y: -p.y, z: p.z, visibility: 1 }   // world y-down
      // Orthographic projection: z vanishes. Projection preserves collinearity, so a
      // straight leg alone still reads 180 here — what actually breaks the 2-D angle is
      // landmark NOISE, whose angular leverage explodes once the projected limb has
      // collapsed to a few percent of frame height.
      lm[i] = {
        x: 0.5 + p.x * SCALE + jitter(imgNoise),
        y: 0.5 - p.y * SCALE - lift + jitter(imgNoise),
        z: 0,
        visibility: 1,
      }
    }

    const leg = (hipX: number, dir: number) => {
      const t = rad(legDeg * dir)
      const bt = rad(legDeg * dir + bendDeg * dir)
      const hip = { x: hipX, y: 0, z: 0 }
      const knee = { x: hipX, y: -Math.cos(t) * THIGH, z: -Math.sin(t) * THIGH }
      const ankle = { x: hipX, y: knee.y - Math.cos(bt) * SHIN, z: knee.z - Math.sin(bt) * SHIN }
      return { hip, knee, ankle }
    }
    const L = leg(-0.10, 1)      // front leg swings toward the camera
    const R = leg(0.10, -1)      // back leg swings away

    setW(11, { x: -0.16, y: 0.50, z: 0 }); setW(12, { x: 0.16, y: 0.50, z: 0 })
    setW(23, L.hip); setW(24, R.hip)
    setW(25, L.knee); setW(26, R.knee)
    setW(27, L.ankle); setW(28, R.ankle)
    setW(29, L.ankle); setW(30, R.ankle)
    setW(31, L.ankle); setW(32, R.ankle)
    return { lm, world }
  }

  function run(legDeg: number, bendDeg: number, withWorld = true, imgNoise = 0) {
    const det = new JumpRepDetector(SQUARE)
    const fps = 24
    const dt = 1000 / fps
    const out: JumpRepEvent[] = []
    let t = 0
    const push = (lift: number, deg: number, bend: number) => {
      const f = frame(lift, deg, bend, imgNoise)
      const ev = det.pushFrame(f.lm, t, withWorld ? f.world : undefined)
      if (ev) out.push(ev)
      t += dt
    }
    for (let i = 0; i < 72; i++) push(0, 0, 0)
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0)
    const n = 9
    for (let i = 0; i < n; i++) {
      const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
      push(0.13 * ph, legDeg * ph, bendDeg * ph)
    }
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0)
    for (let i = 0; i < 36; i++) push(0, 0, 0)
    return out
  }

  it.each([[45], [60], [70], [80], [85]])(
    'a straight-legged split at %i deg from vertical clears the knee gate',
    (legDeg) => {
      const reps = run(legDeg, 0)
      expect(reps).toHaveLength(1)
      const g = reps[0].leapGate
      expect(g.kneeMedian, `knee median at ${legDeg} deg`).toBeGreaterThanOrEqual(g.kneeThreshold)
      expect(g.failed).not.toBe('knees-bent')
      expect(reps[0].type).toBe('leap (jeté-type)')
    },
  )

  // Bends of 70 and 90 (knee angles 110 and 90). A 50-degree bend — knees at 130 — used to be
  // here too, but real footage moved it: split leaps filmed at 15 fps measured a straighter
  // knee of 131-136 on their widest frame. At 130 the shape is a bent-knee leap, which is
  // counted and then told to straighten (next test), not a tuck.
  it('a genuinely bent-knee tuck still fails the knee gate', () => {
    for (const bend of [70, 90]) {
      const reps = run(70, bend)
      expect(reps, `bend ${bend}`).toHaveLength(1)
      expect(reps[0].leapGate.kneeMedian, `bend ${bend}`).toBeLessThan(reps[0].leapGate.kneeThreshold)
      expect(reps[0].type, `bend ${bend}`).toBe('jump (sauté-type)')
    }
  })

  it('a straight leg aimed at the lens is never told to straighten', () => {
    // The same measurement used to feed the coaching cues: an image-plane angle that
    // collapses told dancers to straighten legs that were already straight. Legs swung at the
    // lens cannot be told front from back (the face is square to the camera) and do not open
    // sideways on screen, so neither leg is critiqued at all - it counts, and is judged side-on
    // only (see "which leg is the back leg" below).
    const rep = run(80, 0)[0]
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.front_leg_ext ?? null).toBeNull()
    expect(rep.metrics.back_leg_ext ?? null).toBeNull()
    const fb = selectFeedback(rep.metrics)
    if (fb.kind === 'correction') {
      expect(['straighten_front_leg', 'straighten_back_leg']).not.toContain(fb.cueId)
    }
  })

  it('the image plane under-reads a straight leg that the 3-D measure gets right', () => {
    // The mechanism this fix addresses. Projection preserves collinearity, so a straight
    // leg alone still projects to 180 — the damage comes from landmark noise, whose
    // angular leverage grows as the projected limb collapses toward the lens. Measured
    // standalone at a fixed 85 deg with realistic noise, the image angle's median falls
    // to 129 deg (10th percentile 74) while 3-D holds 175-176.
    //
    // Across a whole leap the legs sweep through that angle rather than sitting at it,
    // so the assertion here is the direction and size of the gap, which is stable.
    const withWorld = run(85, 0, true, 0.010)[0]
    const imageOnly = run(85, 0, false, 0.010)[0]
    expect(imageOnly.separationSource).toBe('image')
    expect(withWorld.separationSource).toBe('world')
    expect(imageOnly.leapGate.kneeMedian).toBeLessThan(withWorld.leapGate.kneeMedian - 5)
    expect(withWorld.leapGate.kneeMedian).toBeGreaterThan(170)
  })
})

describe('JumpRepDetector — the back leg must not veto a real split', () => {
  // Real logged reps, all rejected on 'knees-bent' despite separation far above the bar:
  //   sep 1.43 — knee 115 vs 140      sep 1.80 — knee 135 vs 140
  //   sep 1.73 — knee 140 vs 140 (logged as an exact tie; .toFixed(0) rounding of 139.x)
  // The gate took the WORSE knee, so the back leg decided it — and the back leg is the
  // one dancers most often carry bent in a jeté. Those bends were 40-60 degrees.

  const THIGH = 0.42, SHIN = 0.42
  const SCALE = 0.40 / (THIGH + SHIN)
  const rad = (d: number) => (d * Math.PI) / 180

  /** Front leg straight, back leg bent by `backBend`, both swung fore/aft in depth. */
  function frame(lift: number, legDeg: number, frontBend: number, backBend: number) {
    const world: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
    const set = (i: number, p: { x: number; y: number; z: number }) => {
      world[i] = { x: p.x, y: -p.y, z: p.z, visibility: 1 }
      lm[i] = { x: 0.5 + p.x * SCALE, y: 0.5 - p.y * SCALE - lift, z: 0, visibility: 1 }
    }
    const leg = (hipX: number, dir: number, bend: number) => {
      const t = rad(legDeg * dir), bt = rad(legDeg * dir + bend * dir)
      const hip = { x: hipX, y: 0, z: 0 }
      const knee = { x: hipX, y: -Math.cos(t) * THIGH, z: -Math.sin(t) * THIGH }
      const ankle = { x: hipX, y: knee.y - Math.cos(bt) * SHIN, z: knee.z - Math.sin(bt) * SHIN }
      return { hip, knee, ankle }
    }
    const F = leg(-0.10, 1, frontBend)
    const B = leg(0.10, -1, backBend)
    set(11, { x: -0.16, y: 0.50, z: 0 }); set(12, { x: 0.16, y: 0.50, z: 0 })
    set(23, F.hip); set(24, B.hip)
    set(25, F.knee); set(26, B.knee)
    set(27, F.ankle); set(28, B.ankle)
    set(29, F.ankle); set(30, B.ankle)
    set(31, F.ankle); set(32, B.ankle)
    return { lm, world }
  }

  function run(legDeg: number, frontBend: number, backBend: number): JumpRepEvent[] {
    const det = new JumpRepDetector(SQUARE)
    const fps = 24, dt = 1000 / fps
    const out: JumpRepEvent[] = []
    let t = 0
    const push = (lift: number, deg: number, fb: number, bb: number) => {
      const f = frame(lift, deg, fb, bb)
      const ev = det.pushFrame(f.lm, t, f.world)
      if (ev) out.push(ev)
      t += dt
    }
    for (let i = 0; i < 72; i++) push(0, 0, 0, 0)
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0, 0)
    const n = 10
    for (let i = 0; i < n; i++) {
      const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
      push(0.14 * ph, legDeg * ph, frontBend * ph, backBend * ph)
    }
    for (let i = 0; i < 5; i++) push(-0.06, 0, 0, 0)
    for (let i = 0; i < 36; i++) push(0, 0, 0, 0)
    return out
  }

  it.each([[40], [50], [60]])(
    'a split with a straight front leg and a %i deg back-leg bend is still a leap',
    (backBend) => {
      const reps = run(70, 0, backBend)
      expect(reps).toHaveLength(1)
      expect(reps[0].leapGate.failed).not.toBe('knees-bent')
      expect(reps[0].type).toBe('leap (jeté-type)')
    },
  )

  it('counts it as a leap; the bend itself is coached only when the leap is seen side-on', () => {
    // Classification and technique quality are separate questions: it counts as a leap. Seen
    // end-on, which leg is bent cannot be told (the face is square to the lens) and the legs
    // never open sideways on screen, so the bend is not coached from this angle. Side-on it
    // is: repCritique.test.ts tells a bent back knee to straighten.
    const rep = run(70, 0, 55)[0]
    expect(rep.type).toBe('leap (jeté-type)')
    expect(rep.metrics.back_leg_ext ?? null).toBeNull()
  })

  it('a 50-degree bend on both legs still counts as a (bent-knee) leap', () => {
    const reps = run(70, 50, 50)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
  })

  it('a tuck with BOTH knees folded is still rejected', () => {
    for (const bend of [70, 90]) {
      const reps = run(70, bend, bend)
      expect(reps, `bend ${bend}`).toHaveLength(1)
      expect(reps[0].type, `bend ${bend}`).toBe('jump (sauté-type)')
      expect(reps[0].leapGate.failed, `bend ${bend}`).toBe('knees-bent')
    }
  })
})

describe('JumpRepDetector — one physical jump counts once', () => {
  function jump(opts: { flightMs?: number; peak?: number; flickerAt?: number; rebound?: boolean } = {}): Frame[] {
    const flightMs = opts.flightMs ?? 320
    const peak = opts.peak ?? 0.13
    const n = Math.round((flightMs / 1000) * FPS)
    const out: Frame[] = [...hold(5, { hipY: 0.57 })]
    for (let i = 0; i < n; i++) {
      const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
      out.push({ lift: peak * ph, vis: i === opts.flickerAt ? 0.2 : 1 })
    }
    out.push(...hold(4, { hipY: 0.58 }))
    if (opts.rebound) {
      // Landing absorption then an elastic rebound of the whole body.
      for (let i = 0; i < 5; i++) out.push({ lift: 0.05 * Math.sin((Math.PI * (i + 1)) / 6) })
    }
    out.push(...hold(6, { hipY: 0.54 }), ...hold(30))
    return out
  }

  it('five deliberate jumps with a clear pause count exactly five', () => {
    expect(countReps(Array.from({ length: 5 }, () => jump()).flat())).toBe(5)
  })

  it('a landing rebound does not add a sixth', () => {
    expect(countReps(Array.from({ length: 5 }, () => jump({ rebound: true })).flat())).toBe(5)
  })

  it('a brief hip-visibility dip mid-flight neither drops nor duplicates the rep', () => {
    // Aborting on the first low-confidence frame took a clean five-jump sequence to
    // zero; not aborting at all would let the descent open a second rep.
    for (const at of [2, 3, 4, 5, 6]) {
      expect(countReps(Array.from({ length: 5 }, () => jump({ flickerAt: at })).flat()), `dip at ${at}`).toBe(5)
    }
  })

  it('a sustained loss of the hips does drop the rep rather than inventing one', () => {
    const frames = Array.from({ length: 5 }, () => jump()).flat()
    const blinded = frames.map((f) => (f.lift !== undefined ? { ...f, vis: 0.2 } : f))
    expect(countReps(blinded)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A STRAIGHT JUMP OUT OF, AND INTO, A DEEP PLIÉ.
//
// The reported bug: landing in a deep plié made a straight jump read as a split roughly
// half the time. Every fixture above models the legs as two straight sticks swung from the
// hips, so nothing above could see it — the failure is entirely about what a FOLDED knee
// does to the measurement, and about which frames of the rep get to vote.
//
// This body is articulated: the knee is placed at a true thigh length from the hip and a
// true shank length from the ankle, so a plié shortens the hip-to-ankle distance exactly
// as much as it does on a real dancer. It also models the heel ROLL-THROUGH — in a deep
// plié the heels leave the floor before the toes do, which moves the ankle landmark while
// the foot is still on the ground, and that is what lets push-off frames satisfy the entry
// ankle gate and end up in the flight buffer in the first place.
//
// Three things went wrong at once, and all three are needed to reproduce it:
//   - separation was normalised by hip-to-ankle distance, which a folded knee shortens by
//     up to 1.4x, inflating every separation measured in that pose;
//   - the anchor seeks the WIDEST frame, so it actively sought those folded frames out;
//   - nothing required the measured frames to be off the floor at all.
// ---------------------------------------------------------------------------

const THIGH = 0.42, SHANK = 0.42, HIP_HALF = 0.10, SHOULDER_UP = 0.50
const M_TO_FRAME = 0.476     // metres -> normalized image units, so both views agree

let aSeed = 987654321
function aJit(a: number): number {
  aSeed = (aSeed * 1664525 + 1013904223) >>> 0
  return ((aSeed / 4294967296) * 2 - 1) * a
}

interface Articulated {
  /** Whole body off the floor, metres — the only thing that is physically flight. */
  lift: number
  /** 0 standing tall .. 1 deep plié. Folds both knees, feet planted. */
  crouch: number
  /** Heel/ankle raised with the toes still down, metres — the roll-through. */
  heel: number
  /** Fore/aft ankle swing, OPPOSED per leg, metres. This is a split. */
  reach: number
  /** Lateral ankle offset beyond hip width, per leg, metres. Stance, or a straddle. */
  stanceX: number
  /** BOTH ankles swung the same way, metres. This is a tuck, and is NOT a split. */
  bothZ: number
}

const POSE: Articulated = { lift: 0, crouch: 0, heel: 0, reach: 0, stanceX: 0.05, bothZ: 0 }

/** World landmarks (metres, y DOWN) for an exactly-articulated body. */
function artWorld(p: Articulated, noise = 0): Landmark[] {
  const w: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  const put = (i: number, x: number, up: number, z: number) => {
    w[i] = { x: x + aJit(noise), y: -(up + aJit(noise)), z: z + aJit(noise * 2), visibility: 1 }
  }
  const hipUp = (THIGH + SHANK) * (1 - 0.45 * p.crouch) + p.lift + p.heel
  const ankleUp = p.lift + p.heel
  put(11, -0.16, hipUp + SHOULDER_UP, 0); put(12, 0.16, hipUp + SHOULDER_UP, 0)
  put(23, -HIP_HALF, hipUp, 0); put(24, HIP_HALF, hipUp, 0)
  for (const side of [-1, 1] as const) {
    const [kneeId, ankleId, heelId, footId] = side < 0 ? [25, 27, 29, 31] : [26, 28, 30, 32]
    const hip = { x: side * HIP_HALF, y: hipUp, z: 0 }
    const ank = { x: side * (HIP_HALF + p.stanceX), y: ankleUp, z: side * p.reach + p.bothZ }
    // The knee sits on the perpendicular bisector of hip->ankle, pushed out and forward —
    // so |hip-knee| = |knee-ankle| = THIGH exactly, whatever the crouch.
    const d = { x: ank.x - hip.x, y: ank.y - hip.y, z: ank.z - hip.z }
    const len = Math.hypot(d.x, d.y, d.z)
    const off = Math.sqrt(Math.max(0, THIGH * THIGH - (len / 2) ** 2))
    let dir = { x: side * Math.cos(0.61), y: 0, z: -Math.sin(0.61) }
    const k = (dir.x * d.x + dir.y * d.y + dir.z * d.z) / (len * len)
    dir = { x: dir.x - k * d.x, y: dir.y - k * d.y, z: dir.z - k * d.z }
    const dn = Math.hypot(dir.x, dir.y, dir.z) || 1
    put(kneeId, (hip.x + ank.x) / 2 + (dir.x / dn) * off, (hip.y + ank.y) / 2 + (dir.y / dn) * off,
        (hip.z + ank.z) / 2 + (dir.z / dn) * off)
    put(ankleId, ank.x, ank.y, ank.z)
    put(heelId, ank.x, ank.y - 0.02, ank.z - 0.04)
    put(footId, ank.x, p.lift, ank.z + 0.10)     // the toe stays down until the body leaves
  }
  return w
}

/** The same body projected to the image plane, floor anchored in frame. */
function artImage(p: Articulated, noise = 0): NormalizedLandmark[] {
  return artWorld(p, noise).map((l) => ({
    x: 0.5 + l.x * M_TO_FRAME, y: 0.90 - -l.y * M_TO_FRAME, z: 0, visibility: 1,
  }))
}

interface Shot {
  plie: number; heel: number; stanceX: number; reach: number; bothZ: number
  peak: number; flightMs: number; prepMs: number; fps: number
  /** Open the shape only once the body is off the floor, as a straddle or tuck does. */
  airOnly?: boolean
}
const SHOT: Shot = {
  plie: 0.85, heel: 0.09, stanceX: 0.05, reach: 0, bothZ: 0,
  peak: 0.16, flightMs: 300, prepMs: 400, fps: 30,
}

/** plié -> roll through the feet -> flight -> absorb into a deep plié -> recover. */
function shotFrames(o: Shot): Articulated[] {
  const N = (ms: number) => Math.max(1, Math.round((ms / 1000) * o.fps))
  const ground = o.airOnly ? 0.05 : o.stanceX
  const still = (n: number, crouch = 0): Articulated[] =>
    Array.from({ length: n }, () => ({ ...POSE, stanceX: ground, crouch }))
  const seq: Articulated[] = [...still(N(3000))]
  const dn = N(200)
  for (let i = 0; i < dn; i++) seq.push({ ...POSE, stanceX: ground, crouch: (o.plie * (i + 1)) / dn })
  seq.push(...still(N(o.prepMs), o.plie))
  const push = N(150)
  for (let i = 0; i < push; i++) {
    const u = (i + 1) / push
    seq.push({ ...POSE, stanceX: ground, heel: o.heel * u, crouch: o.plie * (1 - u) })
  }
  const n = N(o.flightMs)
  for (let i = 0; i < n; i++) {
    const ph = Math.sin((Math.PI * (i + 1)) / (n + 1))
    seq.push({
      ...POSE, crouch: 0, heel: o.heel, lift: o.peak * ph,
      reach: o.reach * ph, bothZ: o.bothZ * ph,
      stanceX: o.airOnly ? ground + (o.stanceX - ground) * ph : o.stanceX,
    })
  }
  const fold = N(150)
  for (let i = 0; i < fold; i++) {
    const u = (i + 1) / fold
    seq.push({ ...POSE, stanceX: ground, heel: o.heel * (1 - u), crouch: o.plie * u })
  }
  seq.push(...still(N(500), o.plie))
  const up = N(300)
  for (let i = 0; i < up; i++) seq.push({ ...POSE, stanceX: ground, crouch: o.plie * (1 - (i + 1) / up) })
  seq.push(...still(N(1500)))
  return seq
}

function runShot(o: Shot, withWorld = true, noise = 0): JumpRepEvent[] {
  const det = new JumpRepDetector(SQUARE)
  const dt = 1000 / o.fps
  const out: JumpRepEvent[] = []
  let t = 0
  for (const p of shotFrames(o)) {
    const ev = det.pushFrame(artImage(p, noise), t, withWorld ? artWorld(p, noise) : undefined)
    if (ev) out.push(ev)
    t += dt
  }
  return out
}

/** Everything that decided the rep, on one line, so a failure reads as a diagnosis. */
const gateLine = (r: JumpRepEvent) => {
  const g = r.leapGate
  return `${r.type} ${r.separationSource} sep=${g.sepMedian.toFixed(2)}/${g.sepThreshold} ` +
    `split=${g.legSplitAngleDeg.toFixed(0)}/${g.legSplitAngleThreshold}deg ` +
    `airborne=${g.airborneFrames}/${r.flightFrames} knee=${g.kneeMedian.toFixed(0)} -> ${g.failed}`
}

describe('JumpRepDetector — a straight jump out of a deep plié is not a split', () => {
  const CASES: Array<[string, Partial<Shot>]> = [
    ['shallow plié', { plie: 0.2 }],
    ['deep plié', { plie: 0.85 }],
    ['deep plié, wide stance', { plie: 0.85, stanceX: 0.14 }],
    ['deep plié, pronounced heel roll-through', { plie: 0.85, heel: 0.15 }],
    ['deep plié, small low jump', { plie: 0.9, peak: 0.09, flightMs: 200 }],
    ['deep plié, short flight at 15 fps', { plie: 0.9, peak: 0.10, flightMs: 200, fps: 15 }],
    ['deep plié, long flight', { plie: 0.9, peak: 0.22, flightMs: 420 }],
  ]

  for (const [label, over] of CASES) {
    for (const withWorld of [true, false]) {
      for (const noise of [0, 0.012]) {
        const view = `${withWorld ? 'world' : 'image'}${noise ? ' + landmark noise' : ''}`
        it(`${label} [${view}]`, () => {
          const reps = runShot({ ...SHOT, ...over }, withWorld, noise)
          // Detection sensitivity is not what this block tests — misclassification is —
          // so a missing rep is tolerated, but a rep that IS found must not be a leap.
          for (const r of reps) expect(r.type, gateLine(r)).toBe('jump (sauté-type)')
        })
      }
    }
  }

  it('the rep is still counted — a straight jump is a real rep, just not a leap', () => {
    const reps = runShot({ ...SHOT, plie: 0.85 })
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('jump (sauté-type)')
    expect(Object.keys(reps[0].metrics)).toHaveLength(0)
    expect(jumpFeedback().kind).toBe('fixed')
  })

  it('width alone has no margin on a wide stance — the shape test is what carries it', () => {
    // Worth pinning because it is the reason the shape test exists at all rather than a
    // higher separation threshold. Jumped from a deep plié with the feet 44 cm apart, a
    // straight jump measures 0.52 against a 0.60 bar: 87% of the way to being called a
    // split, on a movement where the legs never parted. No separation threshold can be
    // raised past that without also rejecting genuine medium splits, which measure around
    // 0.96 — the bands very nearly touch.
    //
    // The angle between the legs is not close at all: 22 degrees against a 35 degree bar
    // for this jump, 49+ for a real split. Direction separates the two classes where width
    // does not, because a wide stance widens the numerator without turning either leg away
    // from the other.
    const r = runShot({ ...SHOT, plie: 0.9, stanceX: 0.12 })[0]
    expect(r.type, gateLine(r)).toBe('jump (sauté-type)')
    expect(r.leapGate.sepMedian, gateLine(r)).toBeGreaterThan(0.8 * r.leapGate.sepThreshold)
    expect(r.leapGate.legSplitAngleDeg, gateLine(r)).toBeLessThan(0.7 * r.leapGate.legSplitAngleThreshold)
  })

  it('excludes the near-floor frames of the flight from the split measurement', () => {
    // The plié gate has to actually be dropping frames, or it is not the thing protecting
    // the classification and this whole block would pass for the wrong reason.
    const r = runShot({ ...SHOT, plie: 0.85 })[0]
    expect(r.leapGate.airborneFrames).toBeGreaterThanOrEqual(2)
    expect(r.leapGate.airborneFrames).toBeLessThan(r.flightFrames)
  })

  it('normalises separation by a divisor a folded knee cannot shrink', () => {
    // Legs together throughout, measured across the full range of plié depth. If the
    // divisor were hip-to-ankle distance these would climb with depth; leg length is the
    // sum of the segments, so they must not.
    const seps = [0.2, 0.5, 0.85, 1.0].map((plie) => {
      const reps = runShot({ ...SHOT, plie })
      return reps.length ? reps[0].leapGate.sepMedian : NaN
    }).filter((v) => Number.isFinite(v))
    expect(seps.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...seps) - Math.min(...seps)).toBeLessThan(0.08)
  })
})

describe('JumpRepDetector — the same plié does not stop a real split reading as a leap', () => {
  it('a fore/aft split out of a deep plié is a leap', () => {
    for (const reach of [0.45, 0.62]) {
      const reps = runShot({ ...SHOT, plie: 0.85, reach })
      expect(reps, `reach ${reach}`).toHaveLength(1)
      expect(reps[0].type, gateLine(reps[0])).toBe('leap (jeté-type)')
      expect(Object.keys(reps[0].metrics).length).toBeGreaterThan(0)
    }
  })

  it('a lateral straddle split is a leap', () => {
    for (const stanceX of [0.40, 0.55]) {
      const reps = runShot({ ...SHOT, stanceX, airOnly: true })
      expect(reps, `stanceX ${stanceX}`).toHaveLength(1)
      expect(reps[0].type, gateLine(reps[0])).toBe('leap (jeté-type)')
    }
  })

  it('an ASYMMETRIC split, back leg trailing nearly straight down, is a leap', () => {
    // The most common real leap, and the shape that a per-leg bar gets wrong. An earlier
    // version of the shape gate asked each leg separately to swing far enough off vertical,
    // which rejects every jeté whose back leg trails under the body — and in a session of
    // seven real leaps, six read as jumps. The angle BETWEEN the legs does not care which
    // leg did the reaching, so it reads these at 52-62 degrees against the 35 degree bar.
    for (const [reach, bias] of [[0.62, 0.45], [0.55, 0.45], [0.50, 0.42]] as Array<[number, number]>) {
      const det = new JumpRepDetector(SQUARE)
      const dt = 1000 / SHOT.fps
      const out: JumpRepEvent[] = []
      let t = 0
      for (const p of shotFrames({ ...SHOT, plie: 0.85, reach })) {
        // bothZ shifts BOTH ankles back by the same amount, cancelling the back leg's
        // rearward swing while leaving the front leg reaching — an uneven split.
        const q = { ...p, bothZ: p.reach > 0 ? bias * (p.reach / reach) : 0 }
        const ev = det.pushFrame(artImage(q), t, artWorld(q))
        if (ev) out.push(ev)
        t += dt
      }
      expect(out, `reach ${reach}`).toHaveLength(1)
      expect(out[0].type, gateLine(out[0])).toBe('leap (jeté-type)')
    }
  })

  it('a real split clears both bars by a multiple, not a margin', () => {
    const r = runShot({ ...SHOT, plie: 0.85, reach: 0.62 })[0]
    expect(r.leapGate.sepMedian).toBeGreaterThan(1.5 * r.leapGate.sepThreshold)
    expect(r.leapGate.legSplitAngleDeg).toBeGreaterThan(1.5 * r.leapGate.legSplitAngleThreshold)
  })
})

describe('JumpRepDetector — a tuck is not a split, however far the ankles travel', () => {
  // Both ankles swung the same way. Width alone cannot tell this from a split — the
  // ankle-to-ankle distance is whatever the stance was — so the shape test has to.
  it.each([0.35, 0.50])('both legs swung %s m the SAME way is a jump', (bothZ) => {
    const reps = runShot({ ...SHOT, bothZ, airOnly: true })
    expect(reps).toHaveLength(1)
    expect(reps[0].type, gateLine(reps[0])).toBe('jump (sauté-type)')
  })

  it('the legs travel far and the angle BETWEEN them stays small', () => {
    // The whole point of measuring leg-to-leg rather than leg-to-floor. Each leg here has
    // swung a long way off vertical — further than in a medium split — and the opening
    // between them is still almost nothing, because they went the same way.
    const r = runShot({ ...SHOT, bothZ: 0.50, airOnly: true })[0]
    expect(r.leapGate.legSplitAngleDeg, gateLine(r)).toBeLessThan(
      0.5 * r.leapGate.legSplitAngleThreshold,
    )
    expect(r.type).toBe('jump (sauté-type)')
  })
})

// ---------------------------------------------------------------------------
// REPORTED: arabesques were counted as split leaps. An arabesque on relevé raises the hips,
// and raising one leg behind lifts the ankle MIDPOINT by half that leg's travel, so the
// entry and ankle gates both passed with the supporting foot flat on the floor — and the
// legs really are split, so it read as a leap. Nothing asked whether anything left the floor.
// ---------------------------------------------------------------------------

/** Side view: rise to relevé and lift the LEFT leg behind by `deg`, toes of the right foot down. */
function releveArabesque(deg: number, releve: number): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const put = (id: number, x: number, y: number) => { lm[id] = { x, y: y + jitter(0.002), z: 0, visibility: 1 } }
  const LEG = GROUND - STANDING_HIP
  // Hips ride up with the relevé, plus the pelvis tipping as the leg goes back.
  const hip = STANDING_HIP - releve - 0.04 * Math.sin((deg * Math.PI) / 180)
  put(11, 0.45, hip - 0.30); put(12, 0.55, hip - 0.30)
  put(23, 0.45, hip); put(24, 0.55, hip)
  // Supporting (right) leg: heel and ankle up on relevé, TOES STILL ON THE FLOOR.
  put(26, 0.55, (hip + GROUND - releve) / 2)
  put(28, 0.55, GROUND - releve); put(30, 0.54, GROUND - releve + 0.02); put(32, 0.57, GROUND + 0.05)
  // Working (left) leg swung behind.
  const r = (deg * Math.PI) / 180
  const ax = 0.45 - LEG * Math.sin(r), ay = hip + LEG * Math.cos(r)
  put(25, (0.45 + ax) / 2, (hip + ay) / 2)
  put(27, ax, ay); put(29, ax + 0.01, ay + 0.02); put(31, ax - 0.05 * Math.sin(r), ay + 0.05 * Math.cos(r))
  return lm
}

function runReleveArabesque(config: Partial<ConstructorParameters<typeof JumpRepDetector>[0]> = {}) {
  const det = new JumpRepDetector(config)
  const reps: JumpRepEvent[] = []
  let t = 0
  const seq: Array<[number, number]> = [
    ...Array.from({ length: 90 }, (): [number, number] => [0, 0]),
    ...Array.from({ length: 5 }, (_, i): [number, number] => [90 * (i + 1) / 5, 0.05 * (i + 1) / 5]),
    ...Array.from({ length: 12 }, (): [number, number] => [90, 0.05]),     // ~0.4 s dynamic arabesque
    ...Array.from({ length: 5 }, (_, i): [number, number] => [90 * (1 - (i + 1) / 5), 0.05 * (1 - (i + 1) / 5)]),
    ...Array.from({ length: 60 }, (): [number, number] => [0, 0]),
  ]
  for (const [deg, rel] of seq) {
    const ev = det.pushFrame(releveArabesque(deg, rel), t)
    if (ev) reps.push(ev)
    t += DT
  }
  return { reps, det }
}

describe('JumpRepDetector — nothing is a jump unless the feet leave the floor', () => {
  it('without the floor gate, a relevé arabesque reads as a split leap (the reported bug)', () => {
    // Documents the failure: every other gate passes, because the legs really are split.
    const { reps } = runReleveArabesque({ floorClearRatio: -Infinity })
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
  })

  it('a relevé arabesque is neither a leap nor a jump', () => {
    const { reps, det } = runReleveArabesque()
    expect(reps).toHaveLength(0)
    expect(det.debug.reps).toBe(0)
  })

  it('real leaps and jumps still clear the floor gate', () => {
    expect(countReps(leapFrames())).toBe(1)
    const r = runSession([...hold(6, { hipY: 0.56 }), ...Array.from({ length: 9 }, (_, i) => ({
      lift: 0.10 * Math.sin((Math.PI * (i + 1)) / 10), split: 45,
    })), ...hold(30)]).reps
    expect(r).toHaveLength(1)
    expect(r[0].type).toBe('leap (jeté-type)')
  })
})

// ---------------------------------------------------------------------------
// REPORTED: real split leaps registered as straight jumps. World landmarks are preferred
// because they see a split aimed at the lens, but their depth axis is MediaPipe's weakest
// and compresses; a leap travelling ACROSS the frame — the usual way leaps are filmed —
// could read short of the world bar while the image plane showed the split plainly.
// ---------------------------------------------------------------------------

/** World landmarks for an image frame, with every leg's horizontal reach squashed by `k`. */
function compressedWorld(img: NormalizedLandmark[], k: number): Landmark[] {
  const S = 1 / 0.476
  const w: Landmark[] = img.map((l) => ({ x: (l.x - 0.5) * S, y: (l.y - 0.5) * S, z: 0, visibility: 1 }))
  for (const [hip, ids] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]] as const) {
    for (const id of ids) w[id] = { ...w[id], x: w[hip].x + (w[id].x - w[hip].x) * k }
  }
  return w
}

describe('JumpRepDetector — a leap across the frame is a leap even when world depth under-reads it', () => {
  function runAcross(k: number) {
    const det = new JumpRepDetector(SQUARE)
    const reps: JumpRepEvent[] = []
    let t = 0
    const frames: Frame[] = [
      ...hold(90),
      ...hold(6, { hipY: 0.56 }),
      ...Array.from({ length: 10 }, (_, i) => {
        const ph = Math.sin((Math.PI * (i + 1)) / 11)
        return { lift: 0.12 * ph, split: 60 * ph }
      }),
      ...hold(6, { hipY: 0.56 }),
      ...hold(45),
    ]
    for (const f of frames) {
      const img = makeLandmarks(f)
      const ev = det.pushFrame(img, t, compressedWorld(img, k))
      if (ev) reps.push(ev)
      t += DT
    }
    return reps
  }

  it('is a leap when world landmarks agree', () => {
    const reps = runAcross(1)
    expect(reps).toHaveLength(1)
    expect(reps[0].type).toBe('leap (jeté-type)')
  })

  it('is still a leap when the world view squashes the split to a third', () => {
    const reps = runAcross(0.3)
    expect(reps).toHaveLength(1)
    expect(reps[0].type, gateLine(reps[0])).toBe('leap (jeté-type)')
  })
})
