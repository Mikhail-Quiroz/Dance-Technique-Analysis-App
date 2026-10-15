import { describe, expect, it } from 'vitest'
import type { FlightSample, JumpRepEvent } from './jumpDetector'
import { classifyJump, hasEntryTurn, russianEvidence, switchEvidence, NO_JUMP_CONTEXT } from './jumpType'
import { russianMetrics } from './jumpMetrics'
import { selectFeedback } from './scoring'

// Synthetic flight traces, shaped like the real ones in the reference footage (see the comments in
// jumpType.ts for the measured ranges each rule rests on). One sample per 33 ms (30 fps).

interface S {
  a: number; phase?: FlightSample['phase']; latHip?: number; latL?: number; latR?: number; facing?: number; elev?: number
  elevL?: number; elevR?: number; elevImgL?: number; elevImgR?: number; wrists?: number; faceUp?: number; yaw?: number
}

function trace(samples: S[]): FlightSample[] {
  return samples.map((s, i) => ({
    tMs: i * 33,
    phase: s.phase ?? 'air',
    legAngleImage: s.a,
    legAngleWorld: s.a,
    elevL: s.elevL ?? s.elev ?? s.a / 2,
    elevR: s.elevR ?? s.a / 2,
    elevImgL: s.elevImgL ?? s.elev ?? s.a / 2,
    elevImgR: s.elevImgR ?? s.a / 2,
    kneeL: 165,
    kneeR: 165,
    kneeImgL: 175,
    kneeImgR: 175,
    leanDeg: 10,
    latHip: s.latHip ?? 0.5,
    latL: s.latL ?? -0.2,
    latR: s.latR ?? 0.2,
    facing: s.facing ?? 0.15,
    hipXT: 0,
    floor: 0.5,
    wristsAboveNose: s.wrists ?? -0.4,
    faceUp: s.faceUp ?? -0.03,
    headYaw: s.yaw ?? 0.05,
  }))
}

function leap(tr: FlightSample[], over: Partial<JumpRepEvent> = {}): JumpRepEvent {
  return {
    type: 'leap (jeté-type)',
    takeoffMs: 1000,
    landingMs: 1500,
    airborneMs: 500,
    riseTorso: 0.9,
    travelTorso: 0.6,
    trace: tr,
    metrics: {},
    legShape: null,
    ...over,
  } as unknown as JumpRepEvent
}

const splitLeap = trace([5, 30, 70, 150, 160, 120, 40, 10].map((a) => ({ a })))
const switchLeap = trace([
  { a: 20, phase: 'pre' }, { a: 80, phase: 'pre', elev: 80 },
  ...[90, 80, 55, 20, 8, 25, 70, 120, 150, 165, 60, 10].map((a) => ({ a, elev: a > 60 ? 80 : undefined })),
])
const straddle_ = trace([20, 50, 100, 140, 160, 170, 165, 150, 120, 60].map((a) => ({ a, latHip: 0.97, latL: -0.95, latR: 0.95, facing: 0.36 })))

describe('classifyJump — legs together', () => {
  const together = (over: Partial<JumpRepEvent>) => ({ ...leap(trace([{ a: 5 }]), over), type: 'jump (sauté-type)' } as JumpRepEvent)

  it('a straight jump in place is a jump', () => {
    expect(classifyJump(together({ travelTorso: 0.02 }), []).kind).toBe('jump')
  })
  it('a small hop (short or low) is a preparation, not a jump', () => {
    expect(classifyJump(together({ airborneMs: 200, travelTorso: 0 }), []).kind).toBe('hop')
    expect(classifyJump(together({ riseTorso: 0.25, travelTorso: 0 }), []).kind).toBe('hop')
  })
  it('a legs-together flight that travels is a sashay, not a jump', () => {
    expect(classifyJump(together({ travelTorso: 0.5 }), []).kind).toBe('sashay')
  })
})

describe('classifyJump — which leap', () => {
  it('one opening of the legs is a split leap', () => {
    expect(classifyJump(leap(splitLeap), []).kind).toBe('split')
  })

  it('brush, legs passing together, split: a switch leap', () => {
    expect(switchEvidence(switchLeap).ok).toBe(true)
    expect(classifyJump(leap(switchLeap), []).kind).toBe('switch')
  })

  it('feet apart in a step before take-off is not a brush', () => {
    // The pre-take-off opening has no raised leg (elev stays low), so there is no switch.
    const stepThenSplit = trace([{ a: 70, phase: 'pre', elev: 35 }, ...[20, 60, 140, 160, 120].map((a) => ({ a }))])
    expect(switchEvidence(stepThenSplit).ok).toBe(false)
  })

  it('a straddle held facing the front, legs out to the sides: a russian', () => {
    expect(russianEvidence(straddle_).ok).toBe(true)
    expect(classifyJump(leap(straddle_), []).kind).toBe('russian')
  })

  it('the same width side-on, legs front and back, is not a russian', () => {
    const sideOn = trace([20, 50, 100, 140, 160, 170, 165, 150, 120, 60].map((a) => ({ a, latHip: 0.6, facing: 0.1 })))
    expect(russianEvidence(sideOn).ok).toBe(false)
  })

  it('a leap out of a turn is a calypso - however its legs looked', () => {
    const ctx = { entryTurnDeg: 320, entryTurnGapMs: 0, entryTurnDegPerS: 640 }
    expect(hasEntryTurn(ctx)).toBe(true)
    expect(classifyJump(leap(straddle_), [], ctx).kind).toBe('calypso')
    expect(classifyJump(leap(splitLeap), [], ctx).kind).toBe('calypso')
  })

  it('a "turn" of a few tens of degrees before take-off is not a calypso entry', () => {
    // Real switch leaps and russians showed 13-71 degrees here: the shoulders seen edge-on.
    expect(hasEntryTurn({ entryTurnDeg: 70, entryTurnGapMs: 0, entryTurnDegPerS: 200 })).toBe(false)
    expect(classifyJump(leap(switchLeap), [], { entryTurnDeg: 70, entryTurnGapMs: 0, entryTurnDegPerS: 200 }).kind).toBe('switch')
  })

  it('a slow turn to face the front before take-off is not a calypso entry', () => {
    // A switch tilt's approach turned 170 degrees at 57 a second; calypsos' chaînés went 150-630.
    expect(hasEntryTurn({ entryTurnDeg: 170, entryTurnGapMs: 0, entryTurnDegPerS: 57 })).toBe(false)
  })

  it('a turn that ended long before take-off is not a calypso entry', () => {
    expect(hasEntryTurn({ entryTurnDeg: 400, entryTurnGapMs: 1500, entryTurnDegPerS: 640 })).toBe(false)
  })

  it('legs apart but barely off the floor is a hop, not a leap', () => {
    expect(classifyJump(leap(splitLeap, { riseTorso: 0.2 }), [], NO_JUMP_CONTEXT).kind).toBe('hop')
  })
})

describe('russianMetrics', () => {
  // The straddle itself is read by the detector (finalizeRep; leapCritique.test.ts covers it).
  const russian = (straddle: JumpRepEvent['straddle']) =>
    leap(straddle_, { straddle, metrics: { point_feet: 150, land_plie: 120 } } as Partial<JumpRepEvent>)

  it('critiques the straddle the detector saw - never the knees, never the chest', () => {
    const m = russianMetrics(russian({ widthDeg: 166, heightDeg: 95, unevenDeg: 8 }))
    expect(m.russian_straddle).toBe(166)
    expect(m.russian_leg_height).toBe(95)
    expect(m.russian_symmetry).toBe(8)
    expect(m).not.toHaveProperty('russian_knees')
    expect(m).not.toHaveProperty('russian_chest')
    expect(selectFeedback(m).kind).toBe('praise')
  })

  it('a straddle whose top was never seen clearly is not judged, and not praised', () => {
    const m = russianMetrics(russian(null))
    expect(m.russian_straddle).toBeNull()
    expect(selectFeedback(m).kind).not.toBe('praise')
  })
})
