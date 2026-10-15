// Streaming turn / pirouette detection for /live — the port of analysis/moves.py's
// shoulder-rotation signal (_shoulder_signal + _turns_from_shoulder), plus the pirouette
// technique metrics shared with analysis/metrics.py's _pirouette_form_metrics.
//
// DETECTION
// ---------
// The shoulder line, seen from above, is the turn: its angle in the world x-z plane is
// unwrapped frame to frame, lightly median-filtered, and differentiated against REAL
// timestamps into an angular velocity. A turn is a run of frames spinning faster than
// `spinDegPerS` (gaps up to `mergeGapMs` bridged, as _merge_gaps does) that rotates at least
// `minRotationDeg` in total. It is emitted when the spinning stops — never mid-turn.
//
// IDENTIFICATION — WHAT KIND OF TURN
// ----------------------------------
// Per CLAUDE.md, a move this detector cannot name is a move it must not score. Two gates:
//
//  - The supporting foot stays on the floor (the lowest foot point stays at its floor
//    baseline). A spin in the air is a tour en l'air, not a pirouette.
//  - The working leg is in PASSÉ: its knee folded and its foot drawn up near the supporting
//    knee for most of the turn. A chaîné, an à la seconde turn or a spin on two feet rotates
//    just as fast, and each has a different correct shape. Those are emitted as plain
//    'turn' events with an EMPTY metrics object — the JumpRepDetector pattern — so there is
//    structurally nothing for the pirouette scorer to critique.
//
// THE CRITIQUE (each maps to a shared/thresholds.json key and a shared/cues.json cue)
// -----------------------------------------------------------------------------------
//  releve_angle       pitch of the supporting foot, heel over toe — "not high enough relevé"
//  retire_connection  working toe to supporting knee / leg length — "unconnected passé".
//                     The 75th percentile over the turn, not the median: a passé that is
//                     connected for half the turn and drifts for the other half is exactly
//                     the fault, and a median would hide it.
//  spot_follow        how much the head turns WITH the body while the face is toward the
//                     spot — "slow spot". 0 means the head stayed on the spot while the body
//                     turned underneath it; 1 means the head simply rode along with the body.
//  turn_axis_tilt     supporting ankle -> shoulder line off vertical — "turning at an angle"
//  hip_level          hip line off horizontal — a hiked working hip
//  support_knee_ext   supporting knee straightness (shared with the arabesque)
//  arm_height_high    shoulder -> fingertip slope below horizontal, higher arm — arms too high
//  arm_height_low     the same slope, lower arm — arms dropped. First position sits between:
//                     fingertips from sternum to navel height, so the line from shoulder to
//                     fingers slopes gently DOWN. Two metrics because the fault has two
//                     directions and each needs its own correction.
//  elbow_drop         elbow below wrist, over forearm length — sagging elbows
//
// Everything is measured in WORLD coordinates, with "up" taken from the body (shoulders are
// above hips) rather than assumed about MediaPipe's Y axis, for the same reasons as the
// arabesque detector. The front-facing camera sees a pirouette from every side in turn;
// image-plane angles of a limb pointing at the lens are meaningless.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { angleAt, angleAt3, footLowestY, kneeReading, legElevation, lowestFootY, TimedRollingBaseline, TimedRunningBodyScale, type Point3 } from './geometry'

const NOSE = 0, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12
const L_ELBOW = 13, R_ELBOW = 14
const L_WRIST = 15, R_WRIST = 16
const L_INDEX = 19, R_INDEX = 20
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28
const L_HEEL = 29, R_HEEL = 30
const L_FOOT = 31, R_FOOT = 32

const T_EPS = 1e-6

export interface TurnDetectorConfig {
  /** Angular velocity of the shoulder line that counts as spinning (Python: 180 deg/s). */
  spinDegPerS: number
  /** Non-spinning gaps up to this long are bridged (Python: _merge_gaps max_gap=5 @30fps). */
  mergeGapMs: number
  /** Total rotation for a run to count as a turn at all (Python: 300 deg). */
  minRotationDeg: number
  /** Longest plausible single turn sequence; anything longer is tracking drift. */
  maxTurnMs: number
  /** Supporting foot's lowest point may rise this many torso lengths and still be "down". */
  floorLiftRatio: number
  /** Share of turn frames that must have the foot down for it to be a floor turn. */
  minFloorFraction: number
  /** Working knee must fold to at most this angle for the leg to be in passé. */
  passeMaxKneeDeg: number
  /** Working ankle must sit at least this many leg lengths above the supporting ankle. */
  passeMinAnkleLift: number
  /** Share of the turn's middle frames that must show the passé. */
  passeMinFraction: number
  /** Face frames needed, and the body-yaw spread they must cover, to judge the spot. */
  spotMinFrames: number
  spotMinBodySpreadDeg: number
  /** Only frames with the body within this yaw of the camera are used to judge the spot. */
  spotWindowDeg: number
  refractoryMs: number
  minWarmupSamples: number
  visThresh: number
  trackingGapMs: number
  /** The camera frame's width over its height (see MoveEngineConfig.aspect). */
  aspect: number
  /** Once a sequence has started, rotation this fast keeps it going (hysteresis on spinDegPerS). */
  spinStayDegPerS: number
  /** A foot this many image torso lengths above the floor is raised... */
  raisedFootMin: number
  /** ...and one at most this high is down. */
  downFootMax: number
  /** A raised leg straight to at least this angle and lifted at least this far is extended. */
  extendedMinKneeDeg: number
  extendedMinElevDeg: number
  /** Short breaks inside a single-support phase that are bridged, in frames. */
  phaseGapFrames: number
  /** A single-support phase shorter than this is a step, not a turn on one leg. */
  minPhaseMs: number
  /** À la seconde: extended frames needed, absolute and as a share of the raised frames. */
  secondeMinFrames: number
  secondeMinShare: number
  /** How far short of its last second turn the leg-out/passé change-point falls (turns). */
  secondePullInTurns: number
  /**
   * Changing spot (see spotChanges): a second turn whose slowest moment - where it shows the leg at
   * its spot - is at least this far round from where the sequence's spot started...
   */
  changingSpotFarDeg: number
  /** ...on at least this many second turns. Regular reference sequences had none; changing-spot ones 2-8. */
  changingSpotMinFar: number
  /**
   * Floaters (see floaterTurns): second turns with the arms up - both wrists above the nose on at
   * least this share of the rotation's frames (floater turns 46-100% on the reference footage; every
   * regular second turn and changing-spot turn 0-11%)...
   */
  floaterArmsUpShare: number
  /**
   * ...and the standing knee not bent into a plié: on screen, its 20th percentile over the rotation
   * at least this (degrees; floater turns read 145-173, the laptop footage lower). Straighter than
   * this, how straight is the critique (floater_support_knee).
   */
  floaterMinKneeDeg: number
  /** A second turn with the arms up this much is not judged for its spot: the arms moving shift it. */
  spotArmsUpShare: number
  /** A piqué phase rotating this far is a double. */
  doublePiqueDeg: number
  /** Chaîné: share of the sequence with both feet down, and the shortest a chaîné can take. */
  chaineMinDownShare: number
  minChaineMs: number
  /** ...and the shortest distance it travels, in torso lengths. */
  chaineMinTravel: number
  /**
   * A turn nothing identifies that travelled at least this far (torso lengths) without both feet
   * ever down at once is the dancer turning round as they walk, not a dance turn.
   */
  walkMinTravel: number
  /** A hop: the supporting foot this far off the floor AND the hips this far up (torso lengths)... */
  hopLiftTorso: number
  hopHipRiseTorso: number
  /** ...for at least this long. */
  hopMinMs: number
  /** A sequence's direction is fixed once it has turned this far... */
  progressDirDeg: number
  /** ...unless it then comes back this far, which restarts it the other way... */
  reversalDeg: number
  /** ...but only while it is still small enough to be a wind-up, not a turn with a glitch in it. */
  maxWindUpDeg: number
  /** ...and it counts as progressing when it gets this much further round. */
  progressStepDeg: number
  /** A sequence whose median floor lift (torso lengths) exceeds this was in the air. */
  airborneMedianLift: number
  /** Share of a sequence's frames with both ankles visible and inside the image. */
  minFullBodyFraction: number
  /** A sequence shorter than this, or rotating faster on average than this, is a glitch. */
  minTurnMs: number
  maxTurnRateDegPerS: number
  /** An ankle below this image y (1 = bottom edge) is at or past the bottom of the frame. */
  feetInFrameMaxY: number
}

export const DEFAULT_TURN_CONFIG: TurnDetectorConfig = {
  aspect: 16 / 9,
  spinDegPerS: 180,
  mergeGapMs: 450,
  minRotationDeg: 300,
  maxTurnMs: 20000,
  floorLiftRatio: 0.12,
  minFloorFraction: 0.8,
  passeMaxKneeDeg: 120,
  passeMinAnkleLift: 0.25,
  passeMinFraction: 0.5,
  spotMinFrames: 4,
  spotMinBodySpreadDeg: 40,
  spotWindowDeg: 100,
  refractoryMs: 300,
  minWarmupSamples: 15,
  visThresh: 0.5,
  trackingGapMs: 400,
  spinStayDegPerS: 120,
  raisedFootMin: 0.45,
  downFootMax: 0.3,
  extendedMinKneeDeg: 140,
  extendedMinElevDeg: 45,
  phaseGapFrames: 2,
  minPhaseMs: 150,
  secondeMinFrames: 3,
  secondeMinShare: 0.12,
  secondePullInTurns: 0.3,
  changingSpotFarDeg: 60,
  changingSpotMinFar: 2,
  floaterArmsUpShare: 0.4,
  floaterMinKneeDeg: 145,
  spotArmsUpShare: 0.2,
  doublePiqueDeg: 540,
  chaineMinDownShare: 0.5,
  minChaineMs: 600,
  chaineMinTravel: 0.8,
  walkMinTravel: 0.6,
  hopLiftTorso: 0.2,
  hopHipRiseTorso: 0.1,
  hopMinMs: 70,
  progressDirDeg: 45,
  reversalDeg: 60,
  maxWindUpDeg: 150,
  progressStepDeg: 15,
  airborneMedianLift: 0.35,
  minFullBodyFraction: 0.9,
  minTurnMs: 400,
  maxTurnRateDegPerS: 2000,
  feetInFrameMaxY: 0.99,
}

export type TurnKind = 'pirouette' | 'seconde' | 'chaine' | 'pique' | 'turn'

export interface TurnEvent {
  /** What kind of turn the sequence was. 'turn' is counted but carries no metrics at all. */
  kind: TurnKind
  /** Legacy: 'pirouette' for a pirouette, 'turn' for everything else. */
  type: 'pirouette' | 'turn'
  /** Whole rotations in the sequence (half rotations for an unidentified turn). */
  rotations: number
  /** À la seconde: the second turns, and the pirouette turns that finished the sequence. */
  secondeTurns?: number
  finishTurns?: number
  /** Piqué series: how many piqué turns (a double counts twice). */
  turns?: number
  /** À la seconde: the spot moved during the second turns (see spotChanges). */
  changingSpot?: boolean
  /**
   * À la seconde: how many of the second turns read as floaters (see floaterTurns). Not a count to
   * show: the arms rise during the first floater and come down in the last, so it runs about one
   * short of what was danced. Above 0, the sequence had floaters.
   */
  floaters?: number
  supportingLeg: 'L' | 'R'
  workingLeg: 'L' | 'R'
  /** Rotation relative to the supporting leg, or null when it could not be told. */
  direction: 'en dehors' | 'en dedans' | null
  /** Small jumps of the supporting foot during the sequence. */
  hops: number
  metrics: Record<string, number | null>
  startMs: number
  endMs: number
  /** How it was classified - for the dev log. */
  reason: string
  /** Legacy: why a 'turn' was not identified as a pirouette, or null. */
  notPirouetteReason: null | 'no-passe' | 'no-world-landmarks'
  /** An unidentified turn taken while walking (see walkMinTravel); never emitted. */
  walking?: boolean
}

export type TurnPhase = 'warmup' | 'idle' | 'spinning' | 'refractory'

/**
 * Where each second turn shows its leg: an à la seconde turn slows at its spot every rotation (the
 * "front" of the turn) and whips round the rest. Its slowest moment, read as how far round the
 * rotation it fell, is the spot. A regular sequence shows the leg at one spot every time: on the
 * reference footage every second turn's slowest moment fell within 35 degrees of the first ones.
 * Changing the spot moves it a quarter turn at a time, and two or more second turns then slow
 * 60+ degrees round from where the sequence started (2-8 of them in the changing-spot clips).
 * The first and last frames of each rotation are left out: the slowest moment of a turn that is
 * starting up or settling is not its spot. So is the last second turn, which runs into the
 * finishing pirouettes: at 15 fps its slowest moment fell anywhere (164-182 degrees round on four
 * regular sequences).
 */
export function spotChanges(
  frames: Array<{ theta: number; omega: number }>,
  rotations: number,
  c: { changingSpotFarDeg: number },
  floater: readonly boolean[] = [],
): { spots: number[]; far: number } {
  if (frames.length < 6) return { spots: [], far: 0 }
  const t0 = frames[0].theta
  const prog = frames.map((f) => Math.abs(f.theta - t0))
  const spots: number[] = []
  for (let k = 0; k < rotations; k++) {
    // A floater whips round with no pause at a spot: its slowest moment is anywhere (two floater
    // sequences on the iPhone footage read as changing spot on their floaters alone).
    if (floater[k]) continue
    const idx = rotationIndices(prog, k)
    const inner = idx.length > 6 ? idx.slice(2, -2) : idx
    if (inner.length < 3) continue
    const slow = inner.reduce((a, b) => (Math.abs(frames[b].omega) < Math.abs(frames[a].omega) ? b : a))
    spots.push(prog[slow] % 360)
  }
  if (spots.length < 3) return { spots, far: 0 }
  const circ = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) }
  const first = spots.slice(0, 3)
  const ref = first.reduce((a, b) => (first.reduce((s, x) => s + circ(b, x), 0) < first.reduce((s, x) => s + circ(a, x), 0) ? b : a))
  return { spots, far: spots.slice(0, -1).filter((s) => circ(s, ref) >= c.changingSpotFarDeg).length }
}

/**
 * The most recent run of spinning, whether or not it went on to count as a turn. A chaîné that
 * leads straight into a leap is often not a turn event at all — the leap lifts the feet before
 * the spin is closed, and an off-floor spin is rejected — but it is still the evidence that a
 * calypso was entered through a turn. See jumpType.ts.
 */
export interface SpinRun {
  startMs: number
  /** Last frame that was still spinning. */
  endMs: number
  rotationDeg: number
  /** [time, rotation so far] through the run, so the rotation before a given moment can be read. */
  samples: Array<[number, number]>
}

/** How far a run had rotated by `tMs` (0 if it had not started). */
export function spinRotationBy(run: SpinRun, tMs: number): number {
  let r = 0
  for (const [t, rot] of run.samples) {
    if (t > tMs) break
    r = Math.max(r, rot)
  }
  return r
}

export type TurnRejectReason =
  | null
  | 'too-little-rotation'
  | 'off-floor'
  | 'too-long'
  | 'warming-up'
  | 'refractory'
  | 'tracking-lost'
  | 'shoulders-not-visible'
  | 'body-out-of-frame'
  | 'walking'

export interface TurnDebugState {
  phase: TurnPhase
  omegaDegPerS: number
  rotationDeg: number
  /** When the sequence under way started (NaN when none is). */
  startMs: number
  spinFrames: number
  lastReject: TurnRejectReason
  reps: number
}

/** The frames of rotation `k` of a sequence, by how far round (`prog`, degrees) each frame had turned. */
function rotationIndices(prog: readonly number[], k: number): number[] {
  return prog.map((p, i) => (p >= k * 360 && p < (k + 1) * 360 ? i : -1)).filter((i) => i >= 0)
}

/**
 * Floaters: second turns with no plié between them - the standing leg stays straight and up on
 * relevé, usually with the arms up in fifth. The relevé cannot be seen on a webcam, nor (on the
 * laptop footage) the plié; the arms can, and on iPhone footage the knee too. So a rotation is a
 * floater when both wrists are above the nose for most of it and the standing knee stays straight.
 * Returns, per second turn: floater or not, the arms-up share, and the standing knee on screen -
 * its 20th percentile (the gate) and its median (the critique: a floater's standing leg is locked;
 * the median, because a rotation's frames can catch the plié of the regular turn next to it).
 */
function floaterTurns(
  frames: readonly TurnFrame[],
  rotations: number,
  supportingLeg: 'L' | 'R',
  c: TurnDetectorConfig,
): { floater: boolean[]; armsUp: number[]; knee: number[]; kneeMid: number[] } {
  const out = { floater: [] as boolean[], armsUp: [] as number[], knee: [] as number[], kneeMid: [] as number[] }
  if (!frames.length) return out
  const t0 = frames[0].theta
  const prog = frames.map((f) => Math.abs(f.theta - t0))
  const [H, K, A] = supportingLeg === 'L' ? [L_HIP, L_KNEE, L_ANKLE] : [R_HIP, R_KNEE, R_ANKLE]
  for (let k = 0; k < rotations; k++) {
    const idx = rotationIndices(prog, k)
    const lms = idx.map((i) => frames[i].lm)
    const up = lms.filter((lm) => lm[L_WRIST].y < lm[NOSE].y && lm[R_WRIST].y < lm[NOSE].y).length
    const P = (lm: NormalizedLandmark[], i: number) => ({ x: lm[i].x * c.aspect, y: lm[i].y })
    const knees = lms
      .filter((lm) => Math.min(lm[K].visibility ?? 1, lm[A].visibility ?? 1) >= c.visThresh)
      .map((lm) => angleAt(P(lm, K), P(lm, H), P(lm, A)))
      .sort((a, b) => a - b)
    const armsUp = lms.length ? up / lms.length : 0
    const knee = knees.length >= 3 ? knees[Math.floor(knees.length * 0.2)] : NaN
    out.armsUp.push(armsUp)
    out.knee.push(knee)
    out.kneeMid.push(knees.length >= 3 ? knees[knees.length >> 1] : NaN)
    out.floater.push(lms.length >= 3 && armsUp >= c.floaterArmsUpShare && knee >= c.floaterMinKneeDeg)
  }
  return out
}

interface TurnFrame {
  lm: NormalizedLandmark[]
  world?: Landmark[]
  tMs: number
  theta: number
  floorLift: number
  omega: number
  /** Each foot's lowest point above the floor baseline, in image torso lengths. */
  hL: number
  hR: number
  kneeL: number
  kneeR: number
  /** Each leg raised from hanging straight down, degrees (see legElevation). */
  elevL: number
  elevR: number
  /** Shoulder width over torso length in the image (facing the camera ~0.35+). */
  facing: number
  /** Hip-mid image x, for travel (see travelTorso). */
  hipX: number
}

/** Shoulder-mid to hip-mid in the image, in true proportions (x stretched back by the aspect). */
function trueTorso(lm: NormalizedLandmark[], aspect: number): number {
  return Math.hypot(
    ((lm[L_SHOULDER].x + lm[R_SHOULDER].x - lm[L_HIP].x - lm[R_HIP].x) / 2) * aspect,
    (lm[L_SHOULDER].y + lm[R_SHOULDER].y - lm[L_HIP].y - lm[R_HIP].y) / 2,
  )
}

/**
 * How far the hips moved across the floor, in torso lengths: first frame to last (`net`) or the
 * full spread (`range`), in true proportions, over the sequence's median torso. It used to be
 * each frame's hip position over that frame's own torso length, differenced: the torso's image
 * length swings ~20% through a turn, so that read 0.2-0.4 torso lengths of travel into a dancer
 * turning on the spot, by an amount that depended on where in the frame they stood - and it read
 * sideways distances in frame widths against a torso in frame heights, 16:9 short.
 */
function travelTorso(frames: TurnFrame[], aspect: number, span: 'net' | 'range'): number | null {
  if (!frames.length) return null
  const torso = median(frames.map((f) => trueTorso(f.lm, aspect)).filter((t) => t > 1e-6))
  if (torso === null) return null
  const xs = frames.map((f) => f.hipX * aspect)
  const d = span === 'net' ? Math.abs(xs[xs.length - 1] - xs[0]) : Math.max(...xs) - Math.min(...xs)
  return d / torso
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

const percentile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const mid = (a: Point3, b: Point3): Point3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const norm = (v: Point3): number => Math.hypot(v.x, v.y, v.z)
const deg = (r: number): number => (r * 180) / Math.PI

/** Signed angle in degrees from `ref` to `v`, both projected onto the horizontal x-z plane. */
function yawFrom(ref: { x: number; z: number }, v: { x: number; z: number }): number {
  return deg(Math.atan2(ref.x * v.z - ref.z * v.x, ref.x * v.x + ref.z * v.z))
}

// ---------------------------------------------------------------------------
// Technique metrics — pure, so the TS and Python ports can be checked against one fixture.
// ---------------------------------------------------------------------------

export interface PirouetteMetricInput {
  /** Middle frames of the turn (the arrival and the finish are not the position). */
  mid: Array<{ lm: NormalizedLandmark[]; world: Landmark[] }>
  /** Every frame of the turn — the spot is judged across whole rotations. */
  all: Array<{ lm: NormalizedLandmark[]; world: Landmark[] }>
  supportingLeg: 'L' | 'R'
  visThresh: number
  /** The camera frame's width over its height, for true-proportion image angles. Default 16:9. */
  aspect?: number
  spotMinFrames: number
  spotMinBodySpreadDeg: number
  spotWindowDeg: number
}

export function pirouetteMetrics(input: PirouetteMetricInput): Record<string, number | null> {
  const { mid: frames, all, supportingLeg, visThresh } = input
  const vis = (lm: NormalizedLandmark[], ...ids: number[]) =>
    ids.every((id) => (lm[id]?.visibility ?? 0) >= visThresh)
  const S = supportingLeg === 'L'
    ? { hip: L_HIP, knee: L_KNEE, ankle: L_ANKLE, heel: L_HEEL, toe: L_FOOT }
    : { hip: R_HIP, knee: R_KNEE, ankle: R_ANKLE, heel: R_HEEL, toe: R_FOOT }
  const W = supportingLeg === 'L'
    ? { hip: R_HIP, knee: R_KNEE, ankle: R_ANKLE, toe: R_FOOT }
    : { hip: L_HIP, knee: L_KNEE, ankle: L_ANKLE, toe: L_FOOT }

  const releve: number[] = []
  const connection: number[] = []
  const axisTilt: number[] = []
  const hipLevel: number[] = []
  const suppKnee: number[] = []
  const armHigh: number[] = []
  const armLow: number[] = []
  const elbowDrop: number[] = []

  for (const { lm, world: w } of frames) {
    const shoulderMid = mid(w[L_SHOULDER], w[R_SHOULDER])
    const hipMid = mid(w[L_HIP], w[R_HIP])
    const upSign = Math.sign(shoulderMid.y - hipMid.y) || -1
    const up = (v: Point3) => v.y * upSign             // height component of a vector

    // Relevé: pitch of the supporting foot, heel over toe. Flat ~0, high demi-pointe 55+.
    if (vis(lm, S.heel, S.toe)) {
      const f = sub(w[S.heel], w[S.toe])
      const rise = up(f)
      const horiz = Math.hypot(f.x, f.z)
      if (Math.hypot(rise, horiz) > 1e-6) releve.push(deg(Math.atan2(rise, horiz)))
    }

    // Passé connection: working toe to supporting knee, over the supporting leg's length.
    const legLen = norm(sub(w[S.hip], w[S.knee])) + norm(sub(w[S.knee], w[S.ankle]))
    if (legLen > 1e-6 && vis(lm, W.toe, S.knee)) {
      connection.push(norm(sub(w[W.toe], w[S.knee])) / legLen)
    }

    // Axis: supporting ankle to shoulders, off vertical.
    if (vis(lm, S.ankle, L_SHOULDER, R_SHOULDER)) {
      const axis = sub(shoulderMid, w[S.ankle])
      const n = norm(axis)
      if (n > 1e-6) axisTilt.push(deg(Math.acos(Math.min(1, Math.abs(up(axis)) / n))))
    }

    // Hips level: the hip line off horizontal.
    {
      const h = sub(w[R_HIP], w[L_HIP])
      const n = norm(h)
      if (n > 1e-6) hipLevel.push(deg(Math.asin(Math.min(1, Math.abs(up(h)) / n))))
    }

    // The supporting knee from the 3-D and true-proportion image readings (geometry.kneeReading).
    // Turning one way, the passé leg crosses in front of the supporting leg from the camera and the
    // tracker pulls the supporting knee onto it: on the reference footage the 3-D reading alone
    // told every piqué on the left leg to straighten a leg the video shows straight (3-D 128-151,
    // screen up to 180), while the unoccluded right leg read 175-180.
    if (vis(lm, S.hip, S.knee, S.ankle)) {
      const A = input.aspect ?? 16 / 9
      const P = (i: number) => ({ x: lm[i].x * A, y: lm[i].y })
      const a = kneeReading(angleAt3(w[S.knee], w[S.hip], w[S.ankle]), angleAt(P(S.knee), P(S.hip), P(S.ankle)))
      if (Number.isFinite(a)) suppKnee.push(a)
    }

    // Arms: slope from shoulder to fingertip, degrees BELOW horizontal (positive = hand lower).
    const slopes: number[] = []
    const drops: number[] = []
    for (const [sh, el, wr, ix] of [[L_SHOULDER, L_ELBOW, L_WRIST, L_INDEX], [R_SHOULDER, R_ELBOW, R_WRIST, R_INDEX]]) {
      const hand = vis(lm, ix) ? ix : wr
      if (vis(lm, sh, hand)) {
        const a = sub(w[sh], w[hand])
        const n = norm(a)
        if (n > 1e-6) slopes.push(deg(Math.asin(Math.max(-1, Math.min(1, up(a) / n)))))
      }
      if (vis(lm, el, wr)) {
        const fore = sub(w[wr], w[el])
        const n = norm(fore)
        // Positive when the elbow sits BELOW the wrist — the sag.
        if (n > 1e-6) drops.push(up(fore) / n)
      }
    }
    if (slopes.length) {
      armHigh.push(Math.min(...slopes))
      armLow.push(Math.max(...slopes))
    }
    if (drops.length) elbowDrop.push(Math.max(...drops))
  }

  // What /live reports, after checking every metric against 20 real pirouettes and piqués:
  //
  //  - releve_angle and spot_follow are NOT reported. The 3-D foot pitch read a clearly lifted
  //    heel barely above standing flat (23-39 degrees against 14-25 on flat), and the 3-D head
  //    yaw read a dancer visibly holding the spot as "head rides with the body" (0.74-0.94):
  //    MediaPipe guesses the face when the back is turned. Coaching built on either would be
  //    confidently wrong, which is worse than no coaching (CLAUDE.md).
  //  - The passé is measured in the IMAGE (passeConnection2d): in 3-D the toe-to-knee distance
  //    picks up the depth error of both points and read 0.35-0.48 leg lengths for passés seen
  //    connected on the footage.
  //  - turn_hip_level replaces hip_level with a band fitted to the webcam: a correct passé read
  //    10-17 degrees here (the working hip landmark rides up with the thigh), so full marks run
  //    to 17 - three pirouettes reading 16-17 were told to level hips the footage shows level.
  //
  // The upload pipeline (analysis/metrics.py, full model) keeps the 3-D metrics.
  void releve
  void connection
  return {
    passe_connection: passeConnection2d(frames, supportingLeg, visThresh),
    turn_axis_tilt: median(axisTilt),
    turn_hip_level: median(hipLevel),
    support_knee_ext: median(suppKnee),
    arm_height_high: median(armHigh),
    arm_height_low: median(armLow),
    elbow_drop: median(elbowDrop),
  }
}

/**
 * Passé connection in the IMAGE: the working toe's distance from the supporting knee, over image
 * torso length, 75th percentile across the frames (a passé connected for half the turn and
 * drifting for the rest is exactly the fault, and a median would hide it). On real footage a
 * connected passé read 0.25-0.45.
 */
export function passeConnection2d(
  frames: Array<{ lm: NormalizedLandmark[] }>,
  supportingLeg: 'L' | 'R',
  visThresh: number,
): number | null {
  const [wToe, sKnee] = supportingLeg === 'L' ? [R_FOOT, L_KNEE] : [L_FOOT, R_KNEE]
  const d: number[] = []
  for (const { lm } of frames) {
    if ((lm[wToe]?.visibility ?? 0) < visThresh || (lm[sKnee]?.visibility ?? 0) < visThresh) continue
    const torso = Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
      (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2)
    if (torso > 1e-6) d.push(Math.hypot(lm[wToe].x - lm[sKnee].x, lm[wToe].y - lm[sKnee].y) / torso)
  }
  return percentile(d, 0.75)
}

/**
 * How much the head yaws WITH the body while the face is toward the camera (the spot), as
 * the least-squares slope of head yaw on body yaw. A dancer who spots holds the face on the
 * spot while the body turns underneath it — slope near 0 — and the head only leaves when it
 * whips round out of view. A slow spot rides along with the shoulders — slope near 1.
 *
 * Only frames with the body within `spotWindowDeg` of facing the camera are used. That is
 * where the face is visible and the yaws are unambiguous, and it is also where the spot is:
 * a dancer practising in front of a camera spots the camera, or the mirror it sits under.
 */
function spotFollow(input: PirouetteMetricInput): number | null {
  const bodyYaws: number[] = []
  const headYaws: number[] = []
  for (const { lm, world: w } of input.all) {
    const faceVis = [NOSE, L_EAR, R_EAR].every((id) => (lm[id]?.visibility ?? 0) >= input.visThresh)
    if (!faceVis) continue
    // Facing the camera, the person's right shoulder is at image left (-x) and the face points
    // toward the camera (-z). Both yaws are measured from those references, so they read 0
    // together and rotate together.
    const right = sub(w[R_SHOULDER], w[L_SHOULDER])
    const fwd = sub(w[NOSE], mid(w[L_EAR], w[R_EAR]))
    if (Math.hypot(right.x, right.z) < 1e-6 || Math.hypot(fwd.x, fwd.z) < 1e-6) continue
    const body = yawFrom({ x: -1, z: 0 }, right)
    if (Math.abs(body) > input.spotWindowDeg) continue
    bodyYaws.push(body)
    headYaws.push(yawFrom({ x: 0, z: -1 }, fwd))
  }
  if (bodyYaws.length < input.spotMinFrames) return null
  const spread = Math.max(...bodyYaws) - Math.min(...bodyYaws)
  if (spread < input.spotMinBodySpreadDeg) return null
  const mb = bodyYaws.reduce((a, b) => a + b, 0) / bodyYaws.length
  const mh = headYaws.reduce((a, b) => a + b, 0) / headYaws.length
  let cov = 0
  let varB = 0
  for (let i = 0; i < bodyYaws.length; i++) {
    cov += (bodyYaws[i] - mb) * (headYaws[i] - mh)
    varB += (bodyYaws[i] - mb) ** 2
  }
  if (varB < 1e-9) return null
  return Math.max(0, Math.min(1.5, cov / varB))
}

// ---------------------------------------------------------------------------
// Turn sequences
// ---------------------------------------------------------------------------

/** Per-frame leg state inside a turn sequence. */
type LegState = 'P' | 'E' | 'R' | 'D' | 'A'
//  P  one foot raised, its knee folded: passé
//  E  one foot raised, leg straight and lifted: extended (à la seconde)
//  R  one foot raised, neither
//  D  both feet down (a step, a chaîné, a plié)
//  A  both feet up (a hop or a jump)

interface Phase {
  side: 'L' | 'R'
  start: number
  end: number
  nP: number
  nE: number
  rotDeg: number
}

export class TurnDetector {
  private readonly cfg: TurnDetectorConfig
  private readonly bodyScale: TimedRunningBodyScale
  private readonly floorBaseline = new TimedRollingBaseline(2000)

  private phase: TurnPhase = 'warmup'
  private unwrapped: number | null = null
  private prevRaw: number | null = null
  private recent: Array<{ t: number; theta: number }> = []   // smoothed theta history
  private raw: number[] = []                                  // unwrapped, pre-median
  private turn: TurnFrame[] = []
  private turnStartTheta = 0
  private lastSpinMs = 0
  /** Direction of the current sequence (+1/-1), fixed once it has turned progressDirDeg. */
  private seqDir = 0
  /** Furthest the sequence has rotated in its direction, and when it last got further. */
  private bestProgress = 0
  private refractoryUntilMs = 0
  private lastFrameMs: number | null = null
  private repCount = 0

  private dbgOmega = 0
  private spinRun: SpinRun | null = null
  /** The last few runs, newest last — a later spurious one must not hide an earlier real one. */
  private spinHistory: SpinRun[] = []
  private dbgReject: TurnRejectReason = 'warming-up'

  constructor(config: Partial<TurnDetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_TURN_CONFIG, ...config }
    this.bodyScale = new TimedRunningBodyScale(3000)
  }

  private vis(lm: NormalizedLandmark[], ...ids: number[]): boolean {
    return ids.every((id) => (lm[id]?.visibility ?? 0) >= this.cfg.visThresh)
  }

  reset(): void {
    this.bodyScale.reset()
    this.floorBaseline.reset()
    this.phase = 'warmup'
    this.unwrapped = null
    this.prevRaw = null
    this.recent = []
    this.raw = []
    this.turn = []
    this.lastFrameMs = null
    this.refractoryUntilMs = 0
    this.spinRun = null
    this.spinHistory = []
    this.dbgReject = 'tracking-lost'
  }

  /** The latest spinning run (see SpinRun), or null if none since tracking began. */
  get lastSpin(): SpinRun | null {
    return this.spinRun
  }

  /** The most recent spinning runs (up to 4), oldest first. */
  get recentSpins(): readonly SpinRun[] {
    return this.spinHistory
  }

  /**
   * True while a turn sequence is under way, pauses between its rotations included - once it
   * has rotated at least `minDeg`. A brief twist of the shoulders (opening the body into an
   * arabesque) starts a sequence that never becomes a turn, and must not count as one.
   */
  isActive(minDeg = 0): boolean {
    if (this.phase !== 'spinning') return false
    if (minDeg <= 0) return true
    const last = this.turn.length ? this.turn[this.turn.length - 1].theta : this.turnStartTheta
    return Math.abs(last - this.turnStartTheta) >= minDeg
  }

  get debug(): TurnDebugState {
    const last = this.turn.length ? this.turn[this.turn.length - 1].theta : this.turnStartTheta
    return {
      phase: this.phase,
      omegaDegPerS: this.dbgOmega,
      rotationDeg: this.phase === 'spinning' ? Math.abs(last - this.turnStartTheta) : 0,
      startMs: this.phase === 'spinning' && this.turn.length ? this.turn[0].tMs : NaN,
      spinFrames: this.turn.length,
      lastReject: this.dbgReject,
      reps: this.repCount,
    }
  }

  /**
   * End the current sequence NOW, e.g. because the dancer just took off: the rest of the rotation
   * happens in the air and belongs to the leap. Returns the sequence if it counts as a turn.
   */
  interrupt(tMs: number): TurnEvent | null {
    if (this.phase !== 'spinning') return null
    return this.close(tMs)
  }

  /** Feed one detected frame. Returns a completed turn sequence, or null. */
  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): TurnEvent | null {
    if (this.lastFrameMs !== null && tMs - this.lastFrameMs > this.cfg.trackingGapMs) this.reset()
    this.lastFrameMs = tMs

    // Rotation needs depth: without world landmarks the shoulder line's angle about the
    // vertical axis is not observable at all.
    if (!world || world.length <= R_FOOT || !this.vis(lm, L_SHOULDER, R_SHOULDER)) {
      this.dbgReject = 'shoulders-not-visible'
      // One unreadable frame is skipped, not treated as the end of the turn: on real footage the
      // tracker lost the shoulders for a frame at the start of a five-turn pirouette, and closing
      // there split it in two. The sequence still ends if the shoulders stay lost.
      if (this.phase === 'spinning' && tMs - this.lastSpinMs > this.cfg.mergeGapMs) return this.close(tMs)
      return null
    }

    const torso = imageTorso(lm)
    if (this.vis(lm, L_HIP, R_HIP)) {
      this.bodyScale.push(
        { x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 },
        { x: (lm[L_HIP].x + lm[R_HIP].x) / 2, y: (lm[L_HIP].y + lm[R_HIP].y) / 2 },
        tMs,
      )
    }
    const scale = this.bodyScale.value
    const lowestY = lowestFootY(lm, this.cfg.visThresh)
    const floorBase = Number.isFinite(lowestY) ? this.floorBaseline.push(lowestY, tMs) : this.floorBaseline.value
    const floorLift = Number.isFinite(lowestY) && Number.isFinite(floorBase) && scale > 1e-9
      ? (floorBase - lowestY) / scale
      : NaN

    // Shoulder-line angle in the horizontal plane, unwrapped against the previous frame.
    const vx = world[R_SHOULDER].x - world[L_SHOULDER].x
    const vz = world[R_SHOULDER].z - world[L_SHOULDER].z
    const thetaRaw = deg(Math.atan2(vz, vx))
    if (this.unwrapped === null || this.prevRaw === null) {
      this.unwrapped = thetaRaw
    } else {
      // Smallest signed step from the previous raw angle, as np.unwrap takes it.
      this.unwrapped += ((((thetaRaw - this.prevRaw) % 360) + 540) % 360) - 180
    }
    this.prevRaw = thetaRaw
    // 5-frame median, as _shoulder_signal's median_filter1d — causal here, so 2 frames late.
    this.raw.push(this.unwrapped)
    if (this.raw.length > 5) this.raw.shift()
    const theta = median(this.raw)!
    this.recent.push({ t: tMs, theta })
    if (this.recent.length > 3) this.recent.shift()

    if (!this.bodyScale.ready(this.cfg.minWarmupSamples) || this.recent.length < 3) {
      this.phase = 'warmup'
      this.dbgReject = 'warming-up'
      return null
    }
    if (this.phase === 'warmup') this.phase = 'idle'

    // Central difference over two frame intervals, on real time (Python: 2 / fps).
    const a = this.recent[0]
    const b = this.recent[this.recent.length - 1]
    const omega = b.t - a.t > 1e-6 ? ((b.theta - a.theta) / (b.t - a.t)) * 1000 : 0
    this.dbgOmega = omega
    const spinning = Math.abs(omega) >= this.cfg.spinDegPerS
    const still = Math.abs(omega) >= this.cfg.spinStayDegPerS

    const footH = (side: 'L' | 'R') => {
      const y = footLowestY(lm, side, this.cfg.visThresh)
      return Number.isFinite(y) && Number.isFinite(floorBase) ? (floorBase - y) / torso : NaN
    }
    const frame: TurnFrame = {
      lm, world, tMs, theta, floorLift, omega,
      hL: footH('L'),
      hR: footH('R'),
      kneeL: angleAt3(world[L_KNEE], world[L_HIP], world[L_ANKLE]),
      kneeR: angleAt3(world[R_KNEE], world[R_HIP], world[R_ANKLE]),
      elevL: legElevation(lm, world, L_HIP, L_ANKLE),
      elevR: legElevation(lm, world, R_HIP, R_ANKLE),
      facing: Math.hypot(lm[L_SHOULDER].x - lm[R_SHOULDER].x, lm[L_SHOULDER].y - lm[R_SHOULDER].y) / torso,
      hipX: (lm[L_HIP].x + lm[R_HIP].x) / 2,
    }

    if (this.phase === 'refractory') {
      if (tMs < this.refractoryUntilMs) {
        this.dbgReject = 'refractory'
        return null
      }
      this.phase = 'idle'
    }

    switch (this.phase) {
      case 'idle': {
        if (!spinning) return null
        this.phase = 'spinning'
        // The velocity is centred a frame back, so the turn began there.
        this.turnStartTheta = this.recent[1].theta
        this.turn = [frame]
        this.lastSpinMs = tMs
        this.seqDir = 0
        this.bestProgress = 0
        this.spinRun = { startMs: tMs, endMs: tMs, rotationDeg: 0, samples: [[tMs, 0]] }
        this.spinHistory.push(this.spinRun)
        if (this.spinHistory.length > 4) this.spinHistory.shift()
        return null
      }
      case 'spinning': {
        if (tMs - this.turn[0].tMs > this.cfg.maxTurnMs) {
          this.dbgReject = 'too-long'
          this.turn = []
          this.phase = 'refractory'
          this.refractoryUntilMs = tMs + this.cfg.refractoryMs
          return null
        }
        this.turn.push(frame)
        // The sequence lives on PROGRESS, not on angular speed: it stays open while the rotation
        // keeps getting further round in one direction. A pause - the front of an à la seconde
        // turn, the step between piqués - is bridged for up to mergeGapMs. Shoulder-angle jitter
        // of 120+ deg/s is common when the dancer is side-on, and a speed rule let it hold a
        // "turn" open through seconds of preparation.
        const delta = theta - this.turnStartTheta
        if (this.seqDir === 0) {
          if (Math.abs(delta) >= this.cfg.progressDirDeg) this.seqDir = Math.sign(delta)
          else if (still) this.lastSpinMs = tMs
        }
        // A reversal - the wind-up of a preparation, turning slightly the other way before the
        // pirouette goes - restarts the sequence from the turning point. Otherwise the wind-up
        // fixes the direction and the real turn, going the other way, never counts as progress
        // (a five-turn pirouette on real footage was cut to four this way).
        if (this.seqDir !== 0 && this.bestProgress < this.cfg.maxWindUpDeg &&
            delta * this.seqDir < this.bestProgress - this.cfg.reversalDeg) {
          const turnAt = this.turnStartTheta + this.seqDir * this.bestProgress
          let k = this.turn.length - 1
          while (k > 0 && Math.abs(this.turn[k - 1].theta - turnAt) > 1e-9 && (this.turn[k - 1].theta - turnAt) * this.seqDir < 0) k--
          this.turn = this.turn.slice(Math.max(0, k - 1))
          this.turnStartTheta = turnAt
          this.seqDir = -this.seqDir
          this.bestProgress = Math.abs(theta - turnAt)
          this.lastSpinMs = tMs
          this.spinRun = { startMs: this.turn[0].tMs, endMs: tMs, rotationDeg: this.bestProgress, samples: [[tMs, this.bestProgress]] }
          this.spinHistory.push(this.spinRun)
          if (this.spinHistory.length > 4) this.spinHistory.shift()
        }
        if (this.seqDir !== 0) {
          const progress = delta * this.seqDir
          if (progress >= this.bestProgress + this.cfg.progressStepDeg || (still && Math.sign(omega) === this.seqDir && progress > this.bestProgress)) {
            this.bestProgress = Math.max(this.bestProgress, progress)
            this.lastSpinMs = tMs
            if (this.spinRun) {
              this.spinRun.endMs = tMs
              this.spinRun.rotationDeg = this.bestProgress
              this.spinRun.samples.push([tMs, this.bestProgress])
            }
          }
        }
        if (tMs - this.lastSpinMs <= this.cfg.mergeGapMs + T_EPS) return null
        return this.close(tMs)
      }
      default:
        return null
    }
  }

  private close(tMs: number): TurnEvent | null {
    // Trim the paused tail back to the last spinning frame.
    const frames = this.turn.filter((f) => f.tMs <= this.lastSpinMs + T_EPS)
    this.turn = []
    this.phase = 'refractory'
    this.refractoryUntilMs = tMs + this.cfg.refractoryMs
    if (!frames.length) return null

    const rotationDeg = this.seqDir !== 0 ? this.bestProgress : Math.abs(frames[frames.length - 1].theta - this.turnStartTheta)
    if (rotationDeg < this.cfg.minRotationDeg) {
      // Not a turn at all - so no refractory either: the real turn may be starting right now.
      this.dbgReject = 'too-little-rotation'
      this.phase = 'idle'
      return null
    }
    // Physically possible: a whole turn in a few frames is a tracking glitch (the shoulder labels
    // swapping), not a dancer. Real pirouettes averaged under 1000 deg/s.
    const durMs = frames[frames.length - 1].tMs - frames[0].tMs
    if (durMs < this.cfg.minTurnMs || rotationDeg / Math.max(durMs, 1) * 1000 > this.cfg.maxTurnRateDegPerS) {
      this.dbgReject = 'too-little-rotation'
      this.phase = 'idle'
      return null
    }
    // The whole body must have been in view: a turn is identified by what the legs do, and with
    // the feet out of frame there is nothing to identify it by. On real footage this is the
    // dancer turning round right in front of the camera to walk to their spot - ankles visible
    // in 0-82% of frames, against 100% in every real turn.
    const inView = frames.filter((f) =>
      this.vis(f.lm, L_ANKLE, R_ANKLE) && f.lm[L_ANKLE].y < this.cfg.feetInFrameMaxY && f.lm[R_ANKLE].y < this.cfg.feetInFrameMaxY).length
    if (inView < this.cfg.minFullBodyFraction * frames.length) {
      this.dbgReject = 'body-out-of-frame'
      return null
    }
    // A spin that was mostly clearly in the air: a tour en l'air, not a floor turn. Only a clear
    // majority counts - the floor baseline drifts for a dancer travelling across a tilted view,
    // and real flights are the move engine's business (it hears from the jump detector).
    const lifts = frames.map((f) => f.floorLift).filter(Number.isFinite).sort((a, b) => a - b)
    if (lifts.length && lifts[Math.floor(lifts.length / 2)] > this.cfg.airborneMedianLift) {
      this.dbgReject = 'off-floor'
      return null
    }

    const event = this.classify(frames, rotationDeg)
    // Turning round while walking to the spot: no position anything identifies, a foot always
    // stepping (never both down, as they are nearly all the way round a chaîné or the turn out
    // of a russian), and the body travelling across the floor. One pose runtime read such a
    // turn-round at 309 degrees where the Python fixtures saw it short of a turn, and counted it.
    if (event.kind === 'turn' && event.walking) {
      this.dbgReject = 'walking'
      return null
    }
    this.repCount++
    this.dbgReject = null
    return event
  }

  /** Per-frame leg state (see LegState) and which foot is raised. */
  private legState(f: TurnFrame): { side: 'L' | 'R' | null; state: LegState } {
    const c = this.cfg
    const hL = Number.isFinite(f.hL) ? f.hL : 0
    const hR = Number.isFinite(f.hR) ? f.hR : 0
    const hi = Math.max(hL, hR)
    const lo = Math.min(hL, hR)
    if (lo > c.downFootMax && hi > c.downFootMax) return { side: null, state: 'A' }
    if (hi < c.raisedFootMin) return { side: null, state: 'D' }
    const side: 'L' | 'R' = hL > hR ? 'L' : 'R'
    const knee = side === 'L' ? f.kneeL : f.kneeR
    const elev = side === 'L' ? f.elevL : f.elevR
    if (knee <= c.passeMaxKneeDeg) return { side, state: 'P' }
    if (knee >= c.extendedMinKneeDeg && elev >= c.extendedMinElevDeg) return { side, state: 'E' }
    return { side, state: 'R' }
  }

  private classify(frames: TurnFrame[], rotationDeg: number): TurnEvent {
    const c = this.cfg
    const states = frames.map((f) => this.legState(f))
    const raisedIdx = states.map((s, i) => (s.side ? i : -1)).filter((i) => i >= 0)
    const nL = raisedIdx.filter((i) => states[i].side === 'L').length
    const nR = raisedIdx.length - nL
    const workingLeg: 'L' | 'R' = nL >= nR ? 'L' : 'R'
    const supportingLeg: 'L' | 'R' = workingLeg === 'L' ? 'R' : 'L'
    const nP = states.filter((s) => s.state === 'P').length
    const nE = states.filter((s) => s.state === 'E').length
    const nD = states.filter((s) => s.state === 'D').length
    const n = frames.length

    // Rotation relative to the supporting leg. Measured on real footage: every pirouette and
    // every à la seconde turned AWAY from the supporting leg (en dehors), every piqué toward it
    // (en dedans), with the same sign convention throughout: supporting on the left and the
    // shoulder angle decreasing is en dehors.
    const dirSign = Math.sign(frames[frames.length - 1].theta - this.turnStartTheta)
    const direction: TurnEvent['direction'] = raisedIdx.length < 3 || dirSign === 0 ? null
      : (supportingLeg === 'L') === (dirSign < 0) ? 'en dehors' : 'en dedans'

    // Single-support phases: runs of frames with the same foot raised, bridging short gaps.
    const phases: Phase[] = []
    let cur: Phase | null = null
    let gap = 0
    for (let i = 0; i < n; i++) {
      const s = states[i]
      if (s.side && cur && s.side === cur.side) {
        cur.end = i
        if (s.state === 'P') cur.nP++
        if (s.state === 'E') cur.nE++
        gap = 0
        continue
      }
      if (cur && gap < c.phaseGapFrames && (!s.side || s.side === cur.side)) {
        gap++
        continue
      }
      if (cur) phases.push(cur)
      cur = s.side ? { side: s.side, start: i, end: i, nP: s.state === 'P' ? 1 : 0, nE: s.state === 'E' ? 1 : 0, rotDeg: 0 } : null
      gap = 0
    }
    if (cur) phases.push(cur)
    for (const p of phases) p.rotDeg = Math.abs(frames[p.end].theta - frames[p.start].theta)
    const minPhaseFrames = Math.max(2, Math.round((c.minPhaseMs / 1000) * this.fpsOf(frames)))
    const solid = phases.filter((p) => p.end - p.start + 1 >= minPhaseFrames)
    const passePhases = solid.filter((p) => p.nP >= Math.max(2, 0.4 * (p.end - p.start + 1)))

    const travel = travelTorso(frames, c.aspect, 'net') ?? 0
    const hops = this.countHops(frames, states)
    const base = {
      supportingLeg,
      workingLeg,
      direction,
      hops,
      startMs: frames[0].tMs,
      endMs: frames[frames.length - 1].tMs,
      notPirouetteReason: null as TurnEvent['notPirouetteReason'],
    }
    const summary = `P${nP} E${nE} D${nD}/${n} phases ${solid.map((p) => `${p.side}${p.end - p.start + 1}(P${p.nP}E${p.nE},${p.rotDeg.toFixed(0)}deg)`).join(' ')} ${direction ?? 'dir?'} travel ${travel.toFixed(2)} rot ${rotationDeg.toFixed(0)}`
    const mids = (idx: number[]) => idx.map((i) => frames[i]).filter((f) => f.world) as Array<TurnFrame & { world: Landmark[] }>

    // 1. À la seconde: the leg is out to the side, straight and lifted, for a real share of the
    //    raised frames - and before any passé finish, which is how these sequences end.
    const eIdx = states.map((s, i) => (s.state === 'E' ? i : -1)).filter((i) => i >= 0)
    if (nE >= c.secondeMinFrames && nE >= c.secondeMinShare * raisedIdx.length) {
      // Where the second turns end and the finishing pirouettes begin: the one change-point that
      // best separates leg-out frames (before) from passé frames (after). A stray leg-out reading
      // inside the pirouette - a passé seen side-on can look straight - must not drag the boundary
      // to the end, which is what "the last leg-out frame" did on real footage.
      let split = n
      let bestScore = -Infinity
      let eBefore = 0
      let pBefore = 0
      const eTotal = nE
      const pTotal = nP
      for (let k = 0; k <= n; k++) {
        const score = eBefore - pBefore + (pTotal - pBefore) - (eTotal - eBefore)
        if (score > bestScore) { bestScore = score; split = k }
        if (k < n) {
          if (states[k].state === 'E') eBefore++
          if (states[k].state === 'P') pBefore++
        }
      }
      const progressAt = (i: number) => Math.abs(frames[Math.max(0, Math.min(n - 1, i))].theta - this.turnStartTheta)
      const totalTurns = Math.max(1, Math.round(rotationDeg / 360))
      // The leg is drawn in to passé during the last quarter of the last second turn, as the
      // dancer comes round to the front - so the change-point sits about a quarter turn short of
      // the turn it ends. Measured on ten real sequences it fell 0.21-0.31 turns early (one 0.77).
      const secondeTurns = Math.max(1, Math.min(totalTurns, Math.round(progressAt(split - 1) / 360 + c.secondePullInTurns)))
      const finishTurns = totalTurns - secondeTurns
      const lastE = split - 1
      const pIdx = states.map((s, i) => (s.state === 'P' && i >= split ? i : -1)).filter((i) => i >= 0)
      const fl = floaterTurns(frames.slice(0, split), secondeTurns, supportingLeg, c)
      const floaters = fl.floater.filter(Boolean).length
      const spot = spotChanges(frames.slice(0, split), secondeTurns, c, fl.armsUp.map((a) => a >= c.spotArmsUpShare))
      const floaterKnees = fl.kneeMid.filter((v, k) => fl.floater[k] && Number.isFinite(v))
      return {
        ...base,
        kind: 'seconde',
        type: 'turn',
        rotations: Math.max(1, Math.round(rotationDeg / 360)),
        secondeTurns,
        finishTurns,
        metrics: {
          ...secondeMetrics(mids(eIdx.filter((i) => i <= lastE)), mids(pIdx), frames, workingLeg, hops, c),
          // The floaters' standing knee: on the least straight floater.
          ...(floaterKnees.length ? { floater_support_knee: Math.min(...floaterKnees) } : {}),
        },
        changingSpot: spot.far >= c.changingSpotMinFar,
        floaters,
        reason: `à la seconde: split@${split}/${n} at ${(progressAt(split - 1) / 360).toFixed(2)} turns of ${(rotationDeg / 360).toFixed(2)}, spots [${spot.spots.map((x) => x.toFixed(0)).join(' ')}] ${spot.far} far, floaters ${floaters} [${fl.armsUp.map((a, k) => `${(a * 100).toFixed(0)}%/${Number.isFinite(fl.knee[k]) ? fl.knee[k].toFixed(0) : '-'}`).join(' ')}]: ${summary}`,
      }
    }

    // 2. Piqué: passé turns entered by a step - several of them with steps between, or one -
    //    turning toward the supporting leg (en dedans), as every real piqué did and no real
    //    pirouette did. Several passé phases turning en dehors are a pirouette with a wobble or a
    //    garbled frame in it, not a piqué series.
    if ((passePhases.length >= 2 && direction !== 'en dehors') || (passePhases.length === 1 && direction === 'en dedans')) {
      const turns = passePhases.reduce((acc, p) => acc + (p.rotDeg >= c.doublePiqueDeg ? 2 : 1), 0)
      const pIdx = passePhases.flatMap((p) => range(p.start, p.end).filter((i) => states[i].state === 'P'))
      return {
        ...base,
        kind: 'pique',
        type: 'turn',
        rotations: Math.max(1, Math.round(rotationDeg / 360)),
        turns,
        supportingLeg: passePhases[0].side === 'L' ? 'R' : 'L',
        workingLeg: passePhases[0].side,
        metrics: this.pirouetteLikeMetrics(mids(pIdx), mids(range(0, n - 1)), passePhases[0].side === 'L' ? 'R' : 'L'),
        reason: `piqué: ${summary}`,
      }
    }

    // 3. Pirouette: a passé turn on one supporting leg (the longest passé phase, if a wobble split it).
    if (passePhases.length >= 1) {
      const p = passePhases.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
      const pIdx = range(p.start, p.end)
      const trim = Math.floor(pIdx.length * 0.15)
      const midIdx = pIdx.slice(trim, pIdx.length - trim)
      const support: 'L' | 'R' = p.side === 'L' ? 'R' : 'L'
      const metrics = this.pirouetteLikeMetrics(mids(midIdx.length ? midIdx : pIdx), mids(range(0, n - 1)), support)
      // No hop critique: every hop counted on real pirouettes and à la seconde turns was, on the
      // footage, the supporting foot staying down on relevé. Hops are still counted on the event
      // (TurnEvent.hops) for the dev log, not scored.
      return {
        ...base,
        kind: 'pirouette',
        type: 'pirouette',
        rotations: Math.max(1, Math.round(rotationDeg / 360)),
        supportingLeg: support,
        workingLeg: p.side,
        metrics,
        reason: `pirouette: ${summary}`,
      }
    }

    // 4. Chaîné: rotation with both feet down, stepping from foot to foot - two steps to a turn,
    //    so never faster than a turn per minChaineMs (real chaînés: 250-400 deg/s).
    // And it travels: every real chaîné crossed 1.6+ torso lengths of floor. A spin on two feet in
    // place (a soutenu, a pencil turn) is a different turn this app does not name.
    const durMs = frames[n - 1].tMs - frames[0].tMs
    if (nD >= c.chaineMinDownShare * n && durMs >= c.minChaineMs && travel >= c.chaineMinTravel) {
      const dIdx = states.map((s, i) => (s.state === 'D' ? i : -1)).filter((i) => i >= 0)
      return {
        ...base,
        kind: 'chaine',
        type: 'turn',
        rotations: Math.max(1, Math.round(rotationDeg / 360)),
        metrics: chaineMetrics(mids(dIdx), c),
        reason: `chaîné: ${summary}`,
      }
    }

    return {
      ...base,
      kind: 'turn',
      type: 'turn',
      rotations: Math.max(0.5, Math.round(rotationDeg / 180) * 0.5),
      metrics: {},
      notPirouetteReason: 'no-passe',
      walking: nD === 0 && nP === 0 && nE === 0 && travel >= c.walkMinTravel,
      reason: `unsure: ${summary}`,
    }
  }

  private fpsOf(frames: TurnFrame[]): number {
    if (frames.length < 2) return 30
    return ((frames.length - 1) / (frames[frames.length - 1].tMs - frames[0].tMs)) * 1000
  }

  /**
   * Hops: the whole body leaving the floor mid-turn - the supporting foot's lowest point AND the
   * hips both clearly above where they ride during the turn, for several frames running, away
   * from the start and the finish.
   *
   * Deliberately conservative. Every "hop" an earlier, looser rule counted on real pirouettes
   * turned out on the footage to be the foot staying down under landmark noise, a blurred frame,
   * or the legs' labels swapping. A small hop lifts the foot 2-5 cm, which is inside the noise of
   * the lite model's foot landmarks at this distance - so subtle hops go uncounted rather than
   * correct turns being told they hopped.
   */
  private countHops(frames: TurnFrame[], states: Array<{ side: 'L' | 'R' | null; state: LegState }>): number {
    const c = this.cfg
    const n = frames.length
    if (n < 6) return 0
    const footOf = (i: number) => {
      const side = states[i].side
      const lm = frames[i].lm
      const ids = side === 'L' ? [R_ANKLE, R_HEEL, R_FOOT] : side === 'R' ? [L_ANKLE, L_HEEL, L_FOOT] : [L_ANKLE, R_ANKLE]
      return Math.max(...ids.map((id) => lm[id].y))
    }
    const torso = frames.map((f) => imageTorso(f.lm))
    const foot = frames.map((_, i) => footOf(i) / torso[i])
    const hip = frames.map((f, i) => ((f.lm[L_HIP].y + f.lm[R_HIP].y) / 2) / torso[i])
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const fm = med(foot)
    const hm = med(hip)
    const lo = Math.floor(n * 0.15)
    const hi = Math.ceil(n * 0.85)
    const minFrames = Math.max(2, Math.round((c.hopMinMs / 1000) * this.fpsOf(frames)))
    let hops = 0
    let run = 0
    for (let i = lo; i < hi; i++) {
      const up = states[i].side !== null && fm - foot[i] >= c.hopLiftTorso && hm - hip[i] >= c.hopHipRiseTorso
      if (up) {
        run++
        if (run === minFrames) hops++
      } else {
        run = 0
      }
    }
    return hops
  }

  private pirouetteLikeMetrics(
    mid: Array<TurnFrame & { world: Landmark[] }>,
    all: Array<TurnFrame & { world: Landmark[] }>,
    supportingLeg: 'L' | 'R',
  ): Record<string, number | null> {
    if (!mid.length) return {}
    return pirouetteMetrics({
      mid,
      all,
      supportingLeg,
      visThresh: this.cfg.visThresh,
      aspect: this.cfg.aspect,
      spotMinFrames: this.cfg.spotMinFrames,
      spotMinBodySpreadDeg: this.cfg.spotMinBodySpreadDeg,
      spotWindowDeg: this.cfg.spotWindowDeg,
    })
  }
}

function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

function imageTorso(lm: NormalizedLandmark[]): number {
  return Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
    (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2) || 1e-6
}

/**
 * À la seconde critique, over the frames where the leg was out to the side, plus the passé of the
 * pirouettes that finished the sequence. From the technique (Pointe, "Mastering à la Seconde
 * Turns"): the leg at hip height and fully stretched, kept at the SAME height turn after turn,
 * the supporting foot anchored rather than travelling, and a connected passé to finish.
 */
function secondeMetrics(
  ext: Array<TurnFrame & { world: Landmark[] }>,
  finish: Array<TurnFrame & { world: Landmark[] }>,
  all: TurnFrame[],
  workingLeg: 'L' | 'R',
  hops: number,
  c: TurnDetectorConfig,
): Record<string, number | null> {
  const elev = ext.map((f) => (workingLeg === 'L' ? f.elevL : f.elevR))
  // The working knee from the 3-D and true-proportion image readings (geometry.kneeReading), as
  // for the supporting knee in a pirouette: the 3-D reading alone told all five left-side
  // sequences on the reference footage to straighten a leg the video shows straight.
  const W = workingLeg === 'L' ? { hip: L_HIP, knee: L_KNEE, ankle: L_ANKLE } : { hip: R_HIP, knee: R_KNEE, ankle: R_ANKLE }
  const P = (lm: NormalizedLandmark[], i: number) => ({ x: lm[i].x * c.aspect, y: lm[i].y })
  const knee = ext.map((f) => kneeReading(workingLeg === 'L' ? f.kneeL : f.kneeR,
    (f.lm[W.knee]?.visibility ?? 0) >= c.visThresh ? angleAt(P(f.lm, W.knee), P(f.lm, W.hip), P(f.lm, W.ankle)) : NaN))
    .filter(Number.isFinite)
  // Height lost between the first and the last second turns.
  const third = Math.max(1, Math.floor(elev.length / 3))
  const early = median(elev.slice(0, third))
  const late = median(elev.slice(elev.length - third))
  // Travel: how far the hips moved across the floor over the whole sequence, torso lengths.
  const travel = travelTorso(all, c.aspect, 'range')
  const out: Record<string, number | null> = {
    seconde_leg_height: median(elev),
    seconde_leg_knee: median(knee),
    seconde_height_drop: early !== null && late !== null && elev.length >= 6 ? early - late : null,
    seconde_travel: travel,
  }
  void hops
  if (finish.length >= 3) out.passe_connection = passeConnection2d(finish, workingLeg === 'L' ? 'R' : 'L', c.visThresh)
  return out
}

/**
 * Chaîné critique. The feet come together on every second half-turn - measured on the closest
 * quarter of the frames, where the feet should meet. The arms may open and close (first to second
 * and back) as long as they never open past second, behind the shoulders: measured as how far the
 * wider arm has swung round from straight ahead, in the chest's own frame (0 in front, 90 out to
 * the side), on the frames where it was widest (75th percentile).
 *
 * Not critiqued: whether the arms hold one height through the turn. A wrist swings behind the body
 * every revolution, and on the reference footage arms held steady in a pirouette read as much
 * up-and-down as any chaîné (10th-90th percentile spread up to 0.73 torso lengths).
 */
function chaineMetrics(down: Array<TurnFrame & { world: Landmark[] }>, c: TurnDetectorConfig): Record<string, number | null> {
  void c
  if (!down.length) return {}
  const sep: number[] = []
  const open: number[] = []
  const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z
  const cross = (a: Point3, b: Point3): Point3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
  for (const f of down) {
    const w = f.world
    const legLen = (norm(sub(w[L_HIP], w[L_KNEE])) + norm(sub(w[L_KNEE], w[L_ANKLE])) +
      norm(sub(w[R_HIP], w[R_KNEE])) + norm(sub(w[R_KNEE], w[R_ANKLE]))) / 2
    if (legLen > 1e-6) sep.push(norm(sub(w[L_ANKLE], w[R_ANKLE])) / legLen)

    // The chest's own frame: up the spine, forward out of the chest (left-to-right shoulders
    // crossed with up), so the measure turns with the dancer.
    const torso = sub(mid(w[L_SHOULDER], w[R_SHOULDER]), mid(w[L_HIP], w[R_HIP]))
    const tn = norm(torso)
    if (tn < 1e-6) continue
    const up = { x: torso.x / tn, y: torso.y / tn, z: torso.z / tn }
    const fwd = cross(up, sub(w[R_SHOULDER], w[L_SHOULDER]))
    const fn = norm(fwd)
    if (fn < 1e-6) continue
    const swung = [[L_SHOULDER, L_WRIST], [R_SHOULDER, R_WRIST]].map(([s, wr]) => {
      const a = sub(w[wr], w[s])
      const along = dot(a, up)
      const flat = { x: a.x - up.x * along, y: a.y - up.y * along, z: a.z - up.z * along }
      const n = norm(flat)
      return n > 1e-6 ? deg(Math.acos(Math.max(-1, Math.min(1, dot(flat, fwd) / (n * fn))))) : NaN
    }).filter(Number.isFinite)
    if (swung.length) open.push(Math.max(...swung))
  }
  return {
    chaine_feet_apart: percentile(sep, 0.25),
    chaine_arm_open: percentile(open, 0.75),
  }
}

