// Which jump was it? JumpRepDetector finds a flight and decides whether the legs split; this
// names the move, from the shape of the whole flight (JumpRepEvent.trace) and what came before it.
//
//   hop / sashay   a preparation, not a move: counted nowhere, critiqued never
//   jump           a straight jump (sauté), legs together, in place
//   calypso        a leap entered through a turn (the chaîné)
//   firebird       a leap with both arms overhead and the head thrown back
//   tiltJump       one leg kicked high to the side, the other low, facing the camera
//   switchTilt     the same, after a brush and a switch
//   switchArabesque  a switch into one leg high behind, the other low, the head turned to the side
//   russian        a straddle: legs out to the SIDES, body facing front, held through the flight
//   switch         a leap whose legs close between the first brush and the split
//   split          any other leap: the split leap (grand jeté)
//
// Every threshold below was set against real footage (videos/reference, see realFootage.test.ts),
// filmed on a laptop webcam at 15 and 30 fps. Each one names the measurement it rests on.
import type { FlightSample, JumpRepEvent } from './jumpDetector'
import { spinRotationBy, type SpinRun } from './turnDetector'

export type JumpKind =
  | 'hop' | 'sashay' | 'jump' | 'split' | 'switch' | 'calypso' | 'russian'
  | 'firebird' | 'tiltJump' | 'switchTilt' | 'switchArabesque' | 'leapUnsure'

export const JUMP_TYPE_CONFIG = {
  // ---- legs together --------------------------------------------------------------------
  /**
   * Straight jumps on real footage: 400-544 ms in the air, hips rising 0.7-1.0 torso lengths.
   * The little hop in a sashay or a step-hop: 160-272 ms, 0.2-0.4. Below both bars it is a hop.
   */
  minJumpAirMs: 300,
  minJumpRiseTorso: 0.45,
  /**
   * A legs-together flight that travels is a sashay (chassé), not a jump: real straight jumps
   * moved the hips 0.01-0.05 torso lengths sideways, the sashays before switch leaps 0.34-0.57.
   */
  sashayTravelTorso: 0.2,

  // ---- calypso ----------------------------------------------------------------------------
  /** The entry turn: at least this much rotation... */
  minSpinDeg: 270,
  /** ...starting at least this long before take-off (a "spin" that starts in the air is noise)... */
  spinLeadMs: 150,
  /** ...and still turning no more than this long before take-off. */
  maxSpinGapMs: 1500,
  /** The engine's entry turn (JumpContext) must have ended no more than this before take-off... */
  maxEntryGapMs: 700,
  /**
   * ...and have rotated at least this far by take-off. Measured on real footage: calypsos had
   * turned 281-783 degrees by take-off (197 for the one filmed at 15 fps, where the shoulder
   * signal lags), switch leaps 13-71, russians 0-27.
   */
  minEntryTurnDeg: 150,
  /**
   * ...turning at least this fast on average: the calypsos' chaînés went 150-630 degrees a second;
   * the slow turn to face the camera before a switch tilt, 57.
   */
  minEntryTurnDegPerS: 100,

  // ---- russian ----------------------------------------------------------------------------
  /** A straddle frame: legs at least this far apart... */
  russianWideDeg: 100,
  /** ...held at least this long (russians held 250-400 ms; a split leap's peak is 1-2 frames). */
  russianMinWideMs: 120,
  /** Ankle separation along the hip line (russians 0.94-1.0, split leaps 0.48-0.92). */
  russianMinLatHip: 0.8,
  /** Facing the camera (russians 0.27-0.41 shoulder width / torso; split and switch leaps 0.04-0.28). */
  russianMinFacing: 0.25,

  // ---- switch -----------------------------------------------------------------------------
  /** The first brush: legs at least this far apart, from just before take-off... */
  switchBrushDeg: 55,
  /** ...with one leg actually raised this far - not just the feet apart in a step. */
  switchBrushElevDeg: 55,
  /** The switch itself: the legs come back to within this of each other... */
  switchCloseDeg: 35,
  /** ...or at least dip this far below the brush before opening again (fast switches at 30 fps). */
  switchDipDeg: 25,
  /** The split after the switch. */
  switchSplitDeg: 100,
  /**
   * The legs pass in the air - or in this last stretch before the take-off frame. At 15 fps the
   * take-off can be read a frame late, and the switch lands just before it: on the reference
   * footage a brush of 69 degrees closed to 5 there and opened into a 140-degree split in the
   * air, and only the first airborne frame (34 degrees under one pose runtime, 40 under another,
   * against a 35-degree close) had decided it.
   */
  switchPreTakeoffMs: 150,
  /**
   * A brush this long before the take-off must be a kick on screen, one leg at least
   * switchEarlyBrushImageDeg up in the image. Early brushes on the reference footage (190-340 ms)
   * read 57-73 degrees there; the open step of a chassé 300 ms before a split leap read 36, and made
   * the leap a switch (blind test). Brushes nearer the take-off read as low as 36 and stay as they are.
   */
  switchEarlyBrushMs: 150,
  switchEarlyBrushImageDeg: 45,
  /**
   * The legs closing late in the flight (after this share of it) into an opening narrower than the
   * widest before it (under this share) are closing to land, not switching: a tilt jump read as a
   * switch tilt that way, closing at 93% of the flight and opening to 67% (blind test). The latest
   * switch on the reference footage passed at 80% of the flight.
   */
  switchLateFrac: 0.85,
  switchLateSplitShare: 0.8,

  // ---- firebird ---------------------------------------------------------------------------
  /**
   * Both arms overhead through the flight (the lower wrist above the nose, 75th percentile of the
   * air frames)... Firebirds 0.29-0.49 torso lengths; split leaps -0.21-0.41, switch leaps up to 0.07.
   */
  firebirdWristsTorso: 0.25,
  /**
   * ...with the head thrown back (the nose above the ears, 75th percentile). Firebirds 0.02-0.10;
   * split and switch leaps never above 0.00. Arms up alone is not enough: two split leaps had both
   * hands as high, with the face level.
   */
  firebirdFaceUpTorso: 0.015,

  // ---- one leg high: tilts and switch arabesques --------------------------------------------
  /**
   * At the top of the flight one leg is high and the other low - on the frames where a leg was
   * highest. In 3-D, russians held the legs within 30 degrees of each other; tilt jumps, switch
   * tilts and switch arabesques 49-102 apart. A split leap with its legs level reads within 45.
   */
  oneLegMinGapWorldDeg: 47,
  /**
   * ...and on screen too. The 3-D reading alone dropped the near leg of three side-on switch leaps
   * to 5-14 degrees (a leg aimed at the lens); on screen those legs were level.
   */
  oneLegMinGapImageDeg: 45,
  /** The high leg itself, in 3-D: tilts 105-131 degrees, switch arabesques 87-113. */
  oneLegMinHighDeg: 80,
  /**
   * ...and on screen, where a tilt or an arabesque leg rose 93-156 degrees. A switch leap whose
   * split one pose runtime read lopsided (86/12 in 3-D) only reached 83 there.
   */
  oneLegMinHighImageDeg: 90,
  /**
   * Which way the head points at the top tells a tilt from an arabesque on the footage: every tilt
   * faced the camera (the nose 0.02-0.15 ear-widths off centre), every switch arabesque was filmed
   * travelling across it with the head turned (0.30-3.2). The leg's own direction - out to the side
   * or behind - could not be read: the 3-D depth that would say so overlapped completely.
   */
  tiltMaxHeadYaw: 0.17,
  /**
   * A tilt's switch starts with a brush to about hip height (63-97 degrees between the legs on the
   * footage). A "brush" past this is the tilt opening early and closing again, not a switch.
   */
  tiltMaxBrushDeg: 105,
}

export interface JumpVerdict {
  kind: JumpKind
  /** Why — for the dev log. */
  reason: string
}

const maxAngle = (s: FlightSample) => Math.max(nz(s.legAngleImage), nz(s.legAngleWorld))
const minAngle = (s: FlightSample) => Math.min(nzHigh(s.legAngleImage), nzHigh(s.legAngleWorld))
const nz = (v: number) => (Number.isFinite(v) ? v : 0)
const nzHigh = (v: number) => (Number.isFinite(v) ? v : 180)
const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * Was the leap entered through a turn? Only rotation BEFORE take-off counts. A leap filmed
 * side-on shows the shoulder line edge-on, and its depth flickers so much in the air that the
 * shoulders appear to spin: real switch leaps and russians showed 300+ degree "spins" running
 * from just before take-off through the flight. A calypso's chaîné has done its turning by the
 * time the feet leave the floor.
 */
export function enteredThroughTurn(takeoffMs: number, spins: readonly SpinRun[]): boolean {
  const c = JUMP_TYPE_CONFIG
  return spins.some((s) =>
    spinRotationBy(s, takeoffMs - c.spinLeadMs / 3) >= c.minSpinDeg &&
    s.startMs <= takeoffMs - c.spinLeadMs &&
    s.endMs >= takeoffMs - c.maxSpinGapMs)
}

/**
 * A straddle held facing the front. Real russians kept the legs 110+ degrees apart for 8-12
 * frames at 30 fps, spread along the hip line, with the shoulders square to the camera. Split
 * leaps filmed side-on reach the same width for a frame or two and spread across the hip line.
 */
export function russianEvidence(trace: FlightSample[]): { ok: boolean; wideMs: number; latHip: number; facing: number; opposed: boolean } {
  const c = JUMP_TYPE_CONFIG
  const air = trace.filter((s) => s.phase === 'air')
  const wide = air.filter((s) => maxAngle(s) >= c.russianWideDeg)
  // Each wide frame stands for one frame interval, so the bar means the same at 15 and 30 fps.
  const dts = air.slice(1).map((s, i) => s.tMs - air[i].tMs).sort((a, b) => a - b)
  const frameMs = dts.length ? dts[Math.floor(dts.length / 2)] : 33
  const wideMs = wide.length * frameMs
  const latHip = median(wide.map((s) => s.latHip))
  const facing = median(air.map((s) => s.facing))
  const latL = median(wide.map((s) => s.latL))
  const latR = median(wide.map((s) => s.latR))
  // Legs to opposite sides of the hips, as a straddle has them.
  const opposed = Number.isFinite(latL) && Number.isFinite(latR) && latL * latR < 0
  const ok = wideMs + 1e-6 >= c.russianMinWideMs && latHip >= c.russianMinLatHip && facing >= c.russianMinFacing && opposed
  return { ok, wideMs, latHip, facing, opposed }
}

/**
 * Brush - switch - split. The legs open for the first brush (often before the take-off foot
 * leaves the floor), come back together as they pass each other in the air, and open into the
 * split. A split leap opens once. On real footage the switch is a frame or two at 30 fps, so a
 * clear dip between the brush and the split counts as well as a full close.
 */
export function switchEvidence(trace: FlightSample[]): { ok: boolean; brush: number; low: number; split: number; lowMs: number } {
  const c = JUMP_TYPE_CONFIG
  const s = trace.filter((x) => x.phase !== 'post')
  const air = s.filter((x) => x.phase === 'air')
  const takeoffMs = air[0]?.tMs ?? Infinity
  const flightMs = air.length ? air[air.length - 1].tMs - takeoffMs : 0
  const passing = (x: FlightSample) => x.phase === 'air' || takeoffMs - x.tMs <= c.switchPreTakeoffMs
  let best = { ok: false, brush: 0, low: 180, split: 0, lowMs: NaN }
  for (let i = 0; i < s.length; i++) {
    const brush = maxAngle(s[i])
    if (brush < c.switchBrushDeg) continue
    if (!(Math.max(nz(s[i].elevL), nz(s[i].elevR)) >= c.switchBrushElevDeg)) continue
    // Long before the take-off, legs apart are a step unless one is kicked up on screen too.
    if (takeoffMs - s[i].tMs >= c.switchEarlyBrushMs &&
        Math.max(nz(s[i].elevImgL), nz(s[i].elevImgR)) < c.switchEarlyBrushImageDeg) continue
    // The lowest point after this brush, and the widest split after that low point.
    for (let j = i + 1; j < s.length; j++) {
      if (!passing(s[j])) continue
      const low = minAngle(s[j])
      const lowHi = maxAngle(s[j])
      const closed = low <= c.switchCloseDeg || brush - lowHi >= c.switchDipDeg
      if (!closed) continue
      const late = s[j].phase === 'air' && s[j].tMs - takeoffMs > c.switchLateFrac * flightMs
      const widestBefore = late ? Math.max(...s.slice(0, j).map(maxAngle)) : 0
      for (let k = j + 1; k < s.length; k++) {
        if (s[k].phase !== 'air') continue
        const split = maxAngle(s[k])
        if (split >= c.switchSplitDeg && split - lowHi >= c.switchDipDeg) {
          if (late && split < c.switchLateSplitShare * widestBefore) continue   // closing to land
          return { ok: true, brush, low, split, lowMs: s[j].tMs }
        }
      }
      if (low < best.low) best = { ok: false, brush, low, split: 0, lowMs: s[j].tMs }
    }
  }
  return best
}

const quantile = (xs: number[], q: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : NaN
}

/** Both arms overhead and the head thrown back through the flight: a firebird's upper body. */
export function firebirdEvidence(trace: FlightSample[]): { ok: boolean; wrists: number; faceUp: number } {
  const c = JUMP_TYPE_CONFIG
  const air = trace.filter((s) => s.phase === 'air')
  const wrists = quantile(air.map((s) => s.wristsAboveNose), 0.75)
  const faceUp = quantile(air.map((s) => s.faceUp), 0.75)
  return { ok: wrists >= c.firebirdWristsTorso && faceUp >= c.firebirdFaceUpTorso, wrists, faceUp }
}

/**
 * One leg high and the other low at the top of the flight, read on the three air frames where a
 * leg was highest (in 3-D; on screen where there is no 3-D reading): the shape of a tilt and of an
 * arabesque in the air, as against a russian's two raised legs or a split leap's level ones. For a
 * leap with a switch, only the frames after the legs passed (`afterMs`): before it, the brush has
 * one leg up and the other still down in every switch leap.
 */
export function oneLegHighEvidence(trace: FlightSample[], afterMs = -Infinity): {
  ok: boolean; hiWorld: number; loWorld: number; hiImage: number; loImage: number; headYaw: number
} {
  const c = JUMP_TYPE_CONFIG
  const air = trace.filter((s) => s.phase === 'air' && s.tMs > afterMs)
  const hiOf = (s: FlightSample) => (Number.isFinite(s.elevL) || Number.isFinite(s.elevR)
    ? Math.max(nz(s.elevL), nz(s.elevR)) : Math.max(nz(s.elevImgL), nz(s.elevImgR)))
  const top = [...air].sort((a, b) => hiOf(b) - hiOf(a)).slice(0, 3)
  const hiWorld = median(top.map((s) => Math.max(s.elevL, s.elevR)))
  const loWorld = median(top.map((s) => Math.min(s.elevL, s.elevR)))
  const hiImage = median(top.map((s) => Math.max(s.elevImgL, s.elevImgR)))
  const loImage = median(top.map((s) => Math.min(s.elevImgL, s.elevImgR)))
  const headYaw = median(top.map((s) => s.headYaw))
  const ok = top.length > 0 &&
    hiWorld - loWorld >= c.oneLegMinGapWorldDeg &&
    hiImage - loImage >= c.oneLegMinGapImageDeg &&
    hiWorld >= c.oneLegMinHighDeg &&
    hiImage >= c.oneLegMinHighImageDeg
  return { ok, hiWorld, loWorld, hiImage, loImage, headYaw }
}

/**
 * What was happening just before take-off, as the move engine saw it: the turn the dancer was in
 * (or had just come out of) and how far it had rotated BEFORE the feet left the floor.
 */
export interface JumpContext {
  entryTurnDeg: number
  /** How long before take-off that turn ended (0 if it was still going). */
  entryTurnGapMs: number
  /** Its average speed, degrees per second. */
  entryTurnDegPerS: number
}

export const NO_JUMP_CONTEXT: JumpContext = { entryTurnDeg: 0, entryTurnGapMs: Infinity, entryTurnDegPerS: 0 }

/** A turn of at least minSpinDeg, still going or just finished at take-off: a calypso's chaîné. */
export function hasEntryTurn(ctx: JumpContext): boolean {
  return ctx.entryTurnDeg >= JUMP_TYPE_CONFIG.minEntryTurnDeg && ctx.entryTurnGapMs <= JUMP_TYPE_CONFIG.maxEntryGapMs &&
    ctx.entryTurnDegPerS >= JUMP_TYPE_CONFIG.minEntryTurnDegPerS
}

export function classifyJump(rep: JumpRepEvent, spins: readonly SpinRun[], ctx: JumpContext = NO_JUMP_CONTEXT): JumpVerdict {
  const c = JUMP_TYPE_CONFIG
  if (rep.type !== 'leap (jeté-type)') {
    if (rep.airborneMs < c.minJumpAirMs || rep.riseTorso < c.minJumpRiseTorso) {
      return { kind: 'hop', reason: `small flight (${rep.airborneMs.toFixed(0)} ms, rise ${rep.riseTorso.toFixed(2)})` }
    }
    if (Math.abs(rep.travelTorso) >= c.sashayTravelTorso) {
      return { kind: 'sashay', reason: `travelled ${rep.travelTorso.toFixed(2)} torso lengths with the legs together` }
    }
    return { kind: 'jump', reason: 'legs together, in place' }
  }
  // Every real leap rose 0.67-1.18 torso lengths; "leaps" with the legs apart that rose 0.10-0.37
  // were an arabesque taken onto relevé, a hop in a turn, the lift of a pirouette preparation.
  if (rep.riseTorso < c.minJumpRiseTorso) {
    return { kind: 'hop', reason: `legs apart but barely left the floor (rise ${rep.riseTorso.toFixed(2)})` }
  }
  if (hasEntryTurn(ctx)) {
    return { kind: 'calypso', reason: `leap out of a ${ctx.entryTurnDeg.toFixed(0)}-degree turn (${ctx.entryTurnGapMs.toFixed(0)} ms before take-off)` }
  }
  if (ctx === NO_JUMP_CONTEXT && enteredThroughTurn(rep.takeoffMs, spins)) return { kind: 'calypso', reason: 'leap entered through a turn' }
  const ru = russianEvidence(rep.trace)
  const fb = firebirdEvidence(rep.trace)
  // A straddle with the arms overhead is a russian: a firebird's legs split front and back.
  if (fb.ok && !ru.ok) {
    return { kind: 'firebird', reason: `arms overhead (${fb.wrists.toFixed(2)}) and head back (${fb.faceUp.toFixed(2)})` }
  }
  // One leg high, one low: before the straddle test, which a tilt facing the camera also passes.
  const sw = switchEvidence(rep.trace)
  const switched = sw.ok && sw.brush <= c.tiltMaxBrushDeg
  const one = oneLegHighEvidence(rep.trace, switched ? sw.lowMs : -Infinity)
  if (one.ok) {
    const shape = `legs ${one.hiWorld.toFixed(0)}/${one.loWorld.toFixed(0)} (screen ${one.hiImage.toFixed(0)}/${one.loImage.toFixed(0)}), head ${one.headYaw.toFixed(2)}`
    if (one.headYaw <= c.tiltMaxHeadYaw) {
      return switched
        ? { kind: 'switchTilt', reason: `${shape}, switch ${sw.brush.toFixed(0)} -> ${sw.low.toFixed(0)} -> ${sw.split.toFixed(0)}` }
        : { kind: 'tiltJump', reason: `${shape}, no switch` }
    }
    if (switched) {
      return { kind: 'switchArabesque', reason: `${shape}, switch ${sw.brush.toFixed(0)} -> ${sw.low.toFixed(0)} -> ${sw.split.toFixed(0)}` }
    }
  }
  // A russian lifts both legs together (within 30 degrees in 3-D). One leg high and the other low,
  // with the head turned and no switch seen, passed the straddle test once - a switch arabesque on
  // the iPhone footage whose switch was not read - and is a leap this app cannot name: counted,
  // never scored.
  if (ru.ok && one.ok) {
    return { kind: 'leapUnsure', reason: `straddle test passed, but one leg high and one low (legs ${one.hiWorld.toFixed(0)}/${one.loWorld.toFixed(0)}, head ${one.headYaw.toFixed(2)}), no switch seen` }
  }
  if (ru.ok) {
    return { kind: 'russian', reason: `straddle held ${ru.wideMs.toFixed(0)} ms, lateral ${ru.latHip.toFixed(2)}, facing ${ru.facing.toFixed(2)}` }
  }
  if (sw.ok) {
    return { kind: 'switch', reason: `brush ${sw.brush.toFixed(0)} -> ${sw.low.toFixed(0)} -> split ${sw.split.toFixed(0)}` }
  }
  return {
    kind: 'split',
    reason: `no switch (closest dip ${sw.low.toFixed(0)}), not a straddle (held ${ru.wideMs.toFixed(0)} ms, lateral ${Number.isFinite(ru.latHip) ? ru.latHip.toFixed(2) : 'n/a'})`,
  }
}
