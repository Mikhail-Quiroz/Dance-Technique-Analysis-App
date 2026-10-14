// The critique for each kind of jump, from the flight JumpRepDetector measured. Each move is
// scored only on what its own technique asks for, so a russian is never told to "straighten the
// front leg" (it has none) and a calypso is never told to straighten its attitude.
import type { JumpRepEvent, LegShape } from './jumpDetector'
import type { MoveKind } from './moveEngine'
import { JUMP_TYPE_CONFIG, oneLegHighEvidence, switchEvidence } from './jumpType'
import { kneeReading } from './geometry'

export function jumpMetrics(move: MoveKind, rep: JumpRepEvent): Record<string, number | null> {
  switch (move) {
    case 'split':
    case 'switch':
      // A switch leap is judged on the split it switches INTO: the leap metrics are taken on the
      // widest straight-kneed split of the flight, which in a switch comes after the switch.
      return { ...rep.metrics }
    case 'calypso':
      return rep.legShape ? calypsoMetrics(rep.legShape, rep.metrics) : {}
    case 'russian':
      return russianMetrics(rep)
    case 'firebird':
      return firebirdMetrics(rep)
    case 'tiltJump':
    case 'switchTilt':
      return { tilt_leg_height: highLegDeg(rep), tilt_leg_knee: highLegKnee(rep), land_plie: rep.metrics.land_plie ?? null }
    case 'switchArabesque':
      return { arabesque_leap_height: highLegDeg(rep), arabesque_leap_back_knee: highLegKnee(rep), land_plie: rep.metrics.land_plie ?? null }
    default:
      return {}
  }
}

/**
 * A firebird is judged like a split leap on what the two share - the front knee straight, the back
 * leg up at or above level, the landing - and on nothing it does differently: its back leg bends
 * and its chest arches back, so it is never told to straighten the back leg or lift the chest.
 */
export function firebirdMetrics(rep: JumpRepEvent): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const k of ['front_leg_ext', 'leap_back_leg_drop', 'land_plie'] as const) {
    if (k in rep.metrics) out[k] = rep.metrics[k]
  }
  return out
}

/**
 * The high leg of a tilt or a switch arabesque at the top of the flight, in 3-D, degrees raised
 * from hanging down: the same reading that identified the shape (oneLegHighEvidence), after the
 * switch where there was one. Null when no air frame had it.
 */
export function highLegDeg(rep: JumpRepEvent): number | null {
  const sw = switchEvidence(rep.trace)
  const switched = sw.ok && sw.brush <= JUMP_TYPE_CONFIG.tiltMaxBrushDeg
  const hi = oneLegHighEvidence(rep.trace, switched ? sw.lowMs : -Infinity).hiWorld
  return Number.isFinite(hi) ? hi : null
}

/**
 * The high leg's knee at the top of a tilt or a switch arabesque - the tilt leg, the arabesque's
 * back leg - on the same three frames its height is read on (oneLegHighEvidence): the straighter
 * of the 3-D and screen readings (geometry.kneeReading), median of the three. Null when it could
 * not be read.
 */
export function highLegKnee(rep: JumpRepEvent): number | null {
  const sw = switchEvidence(rep.trace)
  const switched = sw.ok && sw.brush <= JUMP_TYPE_CONFIG.tiltMaxBrushDeg
  const after = switched ? sw.lowMs : -Infinity
  const nz = (v: number) => (Number.isFinite(v) ? v : -Infinity)
  const hiOf = (s: (typeof rep.trace)[number]) => (Number.isFinite(s.elevL) || Number.isFinite(s.elevR)
    ? Math.max(nz(s.elevL), nz(s.elevR)) : Math.max(nz(s.elevImgL), nz(s.elevImgR)))
  const top = rep.trace.filter((s) => s.phase === 'air' && s.tMs > after).sort((a, b) => hiOf(b) - hiOf(a)).slice(0, 3)
  const knees = top
    .map((s) => {
      const left = (Number.isFinite(s.elevL) ? nz(s.elevL) >= nz(s.elevR) : nz(s.elevImgL) >= nz(s.elevImgR))
      return left ? kneeReading(s.kneeL, s.kneeImgL) : kneeReading(s.kneeR, s.kneeImgR)
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return knees.length ? knees[knees.length >> 1] : null
}

/**
 * A russian, at the top of the straddle: how wide, how high and how even the legs were (the
 * Straddle finalizeRep read front-on, in true screen proportions, off frames with both legs
 * found). Null - tried, not seen - when the top of the straddle was smeared, so the jump is never
 * praised for legs nobody saw. Not critiqued: knee straightness (a blurred front-on leg put a
 * knee landmark at the hip on two russians with visibly straight legs) and the chest (front-on,
 * pitching forward is depth, which read 20-35 degrees on chests the footage shows upright).
 */
export function russianMetrics(rep: JumpRepEvent): Record<string, number | null> {
  const st = rep.straddle
  return {
    russian_straddle: st ? st.widthDeg : null,
    russian_leg_height: st ? st.heightDeg : null,
    russian_symmetry: st ? st.unevenDeg : null,
    land_plie: rep.metrics.land_plie ?? null,
  }
}

/**
 * The calypso critique, from its shape in the air (LegShape, read across the readable split
 * frames) plus the landing and feet the leap already measured. A calypso is a turning leap with
 * the front leg straight and brushed high, the back leg in attitude with the thigh lifted and the
 * knee higher than the foot, and a slight cambré toward the back leg (Just For Kix; Myosource).
 * Square hips are not critiqued: the body is turning in the air, and the camera cannot tell an
 * open hip from the turn.
 */
export function calypsoMetrics(g: LegShape, leap: Record<string, number | null>): Record<string, number | null> {
  // Knees and the attitude are offered only when seen on enough frames (see finalizeRep).
  const seen: Record<string, number> = {}
  if (Number.isFinite(g.frontKneeDeg)) seen.calypso_front_ext = g.frontKneeDeg
  if (Number.isFinite(g.backKneeDeg)) seen.calypso_attitude_bend = g.backKneeDeg
  if (Number.isFinite(g.backKneeLift)) seen.calypso_knee_lift = g.backKneeLift
  return {
    ...seen,
    calypso_back_height: g.backThighDeg,
    calypso_front_height: g.frontLegDeg,
    calypso_arch: g.archDeg,
    land_plie: leap.land_plie ?? null,
  }
}
