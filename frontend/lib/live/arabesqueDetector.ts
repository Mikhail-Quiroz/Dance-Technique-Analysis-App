// Streaming arabesque detection for /live — the balance counterpart to jumpDetector.
//
// An arabesque is a POSITION, not a ballistic event, so the state machine is gated on the
// leg arriving and settling rather than on airtime:
//   idle -> entering -> held -> (emit as soon as the position is confirmed) -> sustain
//        -> refractory once the leg comes down.
//
// "Confirmed" is deliberately short. In choreography an arabesque is usually a dynamic
// moment of about half a second, not a two-second balance, and the detector used to demand
// 800 ms of hold and then stay silent until the leg came DOWN - so a real arabesque either
// never counted or surfaced 1.5 s after the dancer reached it. What separates a position
// from a leg swinging through it is not how long it lasts but whether it SETTLES: a battement
// derriere passes the top in a continuous arc, an arabesque arrives and stays. That is the
// plateau test (minPlateauMs / plateauToleranceDeg).
//
// WHY THIS IS NOT A PORT OF detect_arabesques()
// ---------------------------------------------
// analysis/moves.py has an arabesque detector, but it works in MediaPipe WORLD
// coordinates and assumes Y is positive-up: it requires the working ankle to sit at
// `hip_y + 0.08` and the supporting ankle at or below -0.10. MediaPipe documents world
// landmarks with Y positive-DOWN, the same orientation as image space. Under Y-down the
// supporting-ankle test can never pass (a grounded ankle is at roughly +0.8, never
// <= -0.10), so the mask would be empty and the batch detector would never fire. Nothing
// in pose/extractor.py flips the sign, and there is no test covering it either way, so
// the assumption is unverified in this repo.
//
// So the up-direction is MEASURED, not assumed: on a dancer upright enough to balance,
// the shoulders sit above the hips, and the sign of that difference says which way is up
// under either convention. Elevation is then read from world coordinates, which matters
// more than it first appears — /live runs a front-facing camera, and an arabesque points
// the working leg straight away from it. In the image plane that leg foreshortens to
// almost nothing, so a genuine, well-held arabesque leaves the ankle barely above the
// hips on screen and never reaches any sane 2-D threshold. That is why a held pose
// produced no detection at all until this was fixed.
//
// Image space remains the fallback when a caller supplies no world landmarks; every
// distance is normalised by torso length so it stays camera-distance invariant.
//
// The scored metrics reuse the existing shared/thresholds.json keys (arabesque_height,
// arabesque_knee_ext, support_knee_ext, arabesque_tilt) so cue text is not duplicated.
// arabesque_height keeps its units — degrees of the working leg above horizontal — but is
// measured in the image plane, which matches the batch 3-D value when the dancer is
// side-on to the camera, the usual filming angle for this position.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { angleAt, angleAt3, legElevation, lowestFootY, TimedRollingBaseline, TimedRunningBodyScale, type Point, kneeReading } from './geometry'

const NOSE = 0, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12
const L_WRIST = 15, R_WRIST = 16
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28
const L_HEEL = 29, R_HEEL = 30
const L_FOOT = 31, R_FOOT = 32

const T_EPS = 1e-6

export interface ArabesqueDetectorConfig {
  /** Trailing-median window for the torso-length scale. */
  bodyScaleMs: number
  /**
   * How far the working leg must be raised BEHIND the dancer, in degrees from hanging
   * straight down, before the position counts as an arabesque. 0 is standing, 90 is the
   * leg horizontal behind, past 90 is a penché.
   *
   * An ANGLE rather than a height, because a height has to be normalised by something and
   * every candidate is a body proportion. The bar this replaced was "working ankle a fifth
   * of a torso length above the hips", which works out to roughly 97 degrees on adult
   * proportions — so a textbook 90 degree arabesque never entered, and nothing at all fired
   * for a normal one. Worse, leg-length-to-torso ratio differs between a child and an
   * adult, so that bar silently demanded a different arabesque from every dancer. This app
   * is for kids; the bar has to mean the same position on every body.
   */
  minArabesqueDeg: number
  /** Hysteresis: once held, the leg may sag to this angle before the hold is over. */
  exitArabesqueDeg: number
  /**
   * IMAGE PATH ONLY. The working leg's hip-to-ankle distance on screen must be at least this
   * many torso lengths before its angle is trusted at all.
   *
   * An angle is scale-free, which is a virtue in world coordinates and a trap in the image
   * plane. A leg pointing straight at the lens collapses to a couple of pixels, and those
   * pixels still have a direction: measured on the front-on fixture, an ankle 0.02 across and
   * 0.03 above its hip yields a confident 146 degrees — a deep penché read off a leg that is
   * not visibly raised at all. The height ratio this angle replaced could not do that,
   * because a collapsed leg gives a small ratio. So the image path has to refuse to answer
   * when the leg is too foreshortened to measure, rather than answer wrongly.
   */
  minImageLegExtension: number
  /**
   * The working ankle must sit at least this many leg lengths above the supporting ankle - the
   * foot is off the floor, not stretched back along it as in a fourth-position lunge. Real
   * arabesques read 0.6-2.0 at the top; a straight leg raised 50 degrees reads 0.36.
   */
  minFootRaise: number
  /** legInFront: the leg must cross the image by this many torso lengths for the face cue... */
  frontCueMinLegDx: number
  /** ...and the face must be turned at least this far (nose off the ear midpoint, torso lengths). */
  frontCueMinFace: number
  /** Fallback cue: the higher hand at least this far to one side of its shoulder. */
  frontCueMinArmDx: number
  /** For a leg pointing at or away from the lens: depth at least this share of the leg. */
  frontCueMinDepth: number
  /** Supporting ankle must stay at least this far BELOW the hips — i.e. still standing. */
  supportGroundRatio: number
  /** Supporting ankle may not drift more than this from its own hold-start height. */
  supportDriftRatio: number
  /** Entry must hold both this long and this many frames before the hold is confirmed. */
  confirmMs: number
  confirmMinFrames: number
  /** Time above the entry angle before a position can count at all. */
  minHoldMs: number
  /**
   * The leg must stay inside a band `plateauToleranceDeg` wide for this long. This is what
   * tells a settled arabesque from a kick that sweeps through the same angles: a 500 ms grand
   * battement derriere spends ~80 ms inside a 6 degree band at its top, a half-second
   * arabesque spends most of its duration there. The window is 100 ms so a dynamic arabesque
   * registers almost as soon as it arrives; the tolerance is what keeps kicks out, so loosen
   * one only by tightening the other.
   *
   * The band floats with the leg rather than hanging off the hold's single highest frame.
   * Anchoring it to the peak made the test hostage to noise: one landmark spike sets a peak
   * the real leg never reaches, every honest frame then sits more than 6 degrees under it,
   * and the longer the dancer holds the more chances there are for such a spike — so a held
   * arabesque could take seconds to register, which is what was reported. See plateauOf.
   */
  minPlateauMs: number
  plateauToleranceDeg: number
  /**
   * A hold shorter than briefHoldMs must reach briefMinDeg to count; a longer one still counts
   * from minArabesqueDeg. A leg only just over the bar for an instant is the reading two pose
   * runtimes disagree on: the browser lifted the step before a switch leap to 53-56 degrees for
   * 64 ms where the Python fixtures saw one frame at 54. The reference arabesques that were hit
   * and left at once all peaked at 68 or more.
   */
  briefHoldMs: number
  briefMinDeg: number
  /**
   * PASSING arabesques. In choreography an arabesque is often hit and left at once — into a
   * chassé, a tour jeté, a pas de bourrée — and never settles at all. So a position is also
   * counted the moment the leg is clearly past its highest point: this many degrees below it,
   * or on its way down below the exit angle. Either way it is scored on the frames at the top.
   *
   * The cost, accepted deliberately: a grand battement derrière, which also goes up and comes
   * straight back down, now counts as an arabesque. Battements are not analysed on /live.
   */
  peakDropDeg: number
  /**
   * The working knee, at the top of the position, must be at least this straight. Below it
   * the leg behind is an attitude, or the heel kicking up in a run, not an arabesque. A bent
   * arabesque ABOVE it is still counted, and told to straighten.
   */
  minWorkingKneeDeg: number
  /** The standing knee, at the top of the position, must be at least this straight. */
  minSupportKneeDeg: number
  /** Chest pitch allowed per degree of leg height above horizontal (see arabesque_chest). */
  chestAllowancePerDeg: number
  /** The camera frame's width over its height (see MoveEngineConfig.aspect). */
  aspect: number
  /**
   * The lowest point of the feet may rise at most this many torso lengths above its floor
   * baseline. The supporting toes stay down in an arabesque, on flat or on releve; in a leap
   * they leave the floor. Without it, a small jete whose front leg drops early looked like an
   * arabesque for long enough to be confirmed.
   */
  floorLiftRatio: number
  /**
   * Brief dips below the exit angle tolerated before the hold is called over — and, while
   * still entering, brief dips below the ENTRY angle. One noisy frame on the way in used to
   * throw the whole entry away and start the clock again.
   */
  exitGraceMs: number
  /**
   * Supporting-foot pitch (heel over toe) above which the dancer is taken to be ON relevé,
   * and so is critiqued on how high it is. Below it the arabesque is on flat, which is a
   * correct arabesque in its own right, and relevé is not mentioned at all.
   */
  releveAttemptDeg: number
  /**
   * A front arm counts as REACHING forward when at least this share of its shoulder-to-wrist
   * length points forward. Only then is there a hand for the eyes to follow.
   */
  gazeArmForward: number
  /** Refractory period after a hold closes. */
  refractoryMs: number
  minWarmupSamples: number
  visThresh: number
  /**
   * Over the hold, every leg point (knees, ankles, heels, toes) must be tracked at least this
   * surely (median of each frame's least visible one). Real arabesques read 0.82 or more; legs
   * hidden behind furniture, which the tracker still drew as a leg raised, read 0.65.
   */
  minLegVisibility: number
  trackingGapMs: number
}

export const DEFAULT_ARABESQUE_CONFIG: ArabesqueDetectorConfig = {
  bodyScaleMs: 3000,
  // Degrees the leg is raised from hanging straight down. Real arabesques peaked at 68-147; the
  // tendus and dégagés that prepare other moves stay well under 50.
  minArabesqueDeg: 50,
  exitArabesqueDeg: 38,
  // Real legs run about 1.4-1.7 torso lengths hip-to-ankle, and a knee bent 45 degrees still
  // spans about 1.2, so 1.0 admits every genuinely side-on leg and refuses a collapsed one.
  minImageLegExtension: 1.0,
  // Lowered from 1.0: the test is "is the supporting foot still on the floor", and a
  // fondu arabesque bends the supporting knee, which shortens the hip-to-ankle gap without
  // the foot leaving the ground. At 1.0 a deep fondu read as the foot lifting.
  supportGroundRatio: 0.8,
  minFootRaise: 0.25,
  frontCueMinLegDx: 0.3,
  frontCueMinFace: 0.03,
  frontCueMinArmDx: 0.25,
  frontCueMinDepth: 0.3,
  supportDriftRatio: 0.30,
  // Two frames above the entry angle is a position rather than a glitch. At a laptop webcam's
  // 15 fps that is 67 ms; a held time bar on top of it only made a passing arabesque miss.
  confirmMs: 0,
  confirmMinFrames: 2,
  minHoldMs: 50,
  minPlateauMs: 60,
  plateauToleranceDeg: 6,
  briefHoldMs: 150,
  briefMinDeg: 60,
  peakDropDeg: 10,
  minWorkingKneeDeg: 120,
  minSupportKneeDeg: 125,
  chestAllowancePerDeg: 0.5,
  aspect: 16 / 9,
  // Loose on purpose: the floor baseline lags a dancer who has just moved, and leaps are vetoed
  // by the move engine, which knows when a flight is under way. At 0.12 a real arabesque
  // stepped into from a walk read 0.13 and was refused.
  floorLiftRatio: 0.25,
  exitGraceMs: 120,
  releveAttemptDeg: 20,
  gazeArmForward: 0.5,
  refractoryMs: 500,
  minWarmupSamples: 15,
  visThresh: 0.5,
  minLegVisibility: 0.75,
  trackingGapMs: 400,
}

export interface ArabesqueEvent {
  workingLeg: 'L' | 'R'
  supportingLeg: 'L' | 'R'
  metrics: Record<string, number | null>
  startMs: number
  peakMs: number
  endMs: number
  /**
   * How long the position had been held when it was confirmed and emitted, in real ms. The
   * event fires as soon as the arabesque is recognised, not when the leg comes down, so this
   * is the time to recognition, not the full length of the hold.
   */
  holdMs: number
  /** How long the leg stayed within plateauToleranceDeg of its peak before confirmation. */
  plateauMs: number
  /** Highest the working leg reached during the hold, in degrees. */
  peakArabesqueDeg: number
}

/**
 * A position that started to look like an arabesque but was not counted, with the numbers
 * that decided it. Logged by /live in development so a missed or slow detection can be
 * diagnosed from the console instead of guessed at.
 */
export interface ArabesqueAttempt {
  /** Increments on every attempt, so a caller can tell a new one from the last. */
  seq: number
  reason: ArabesqueRejectReason
  workingLeg: 'L' | 'R' | null
  tMs: number
  /** Highest leg angle reached during the attempt. */
  peakDeg: number
  /** Time the leg spent above the entry angle. */
  heldMs: number
  /** Longest settled stretch, against minPlateauMs. */
  plateauMs: number
  floorLift: number
  supportGap: number
}

export type ArabesquePhase = 'warmup' | 'idle' | 'entering' | 'held' | 'sustain' | 'refractory'

export type ArabesqueRejectReason =
  | null
  | 'leg-not-raised'
  | 'leg-in-front'
  | 'support-not-grounded'
  | 'support-lifted'
  | 'feet-off-floor'
  | 'no-plateau'
  | 'working-knee-folded'
  | 'support-in-plie'
  | 'legs-not-visible'
  | 'legs-unclear'
  | 'too-short'
  | 'brief-and-low'
  | 'unconfirmed'
  | 'warming-up'
  | 'refractory'
  | 'tracking-lost'

export interface ArabesqueDebugState {
  phase: ArabesquePhase
  workingLeg: 'L' | 'R' | null
  /** Working-leg elevation behind the dancer, degrees from hanging straight down. */
  arabesqueDeg: number
  enterDeg: number
  exitDeg: number
  supportGap: number
  /** Lowest foot point above the floor baseline, in torso lengths. NaN when unreadable. */
  floorLift: number
  heldMs: number
  plateauMs: number
  bodyScale: number
  legsVisible: boolean
  lastReject: ArabesqueRejectReason
  enteringFrames: number
  holdFrames: number
  reps: number
}

interface Snapshot {
  lm: NormalizedLandmark[]
  tMs: number
  arabesqueDeg: number
  /**
   * Kept per frame because every scored metric needs it, not just the elevation. An
   * arabesque points the working leg away from a front-facing camera, so in the image plane
   * that leg is a few pixels long: measured on the front-on fixture, a perfectly straight
   * working leg reads 180 degrees by projection accident and a 40-degree bent one reads 0.
   * Both are artefacts, and both drive coaching - the second tells a dancer their leg is
   * folded double when it is not. The elevation was moved to world coordinates for exactly
   * this reason; the knee and carriage metrics had been left behind in the image plane.
   */
  world?: Landmark[]
}

function pt(lm: NormalizedLandmark[], id: number): Point {
  return { x: lm[id].x, y: lm[id].y }
}

export class ArabesqueDetector {
  private readonly cfg: ArabesqueDetectorConfig
  private readonly bodyScale: TimedRunningBodyScale
  private readonly floorBaseline = new TimedRollingBaseline(2000)

  private phase: ArabesquePhase = 'warmup'
  private working: 'L' | 'R' | null = null
  private entering: Snapshot[] = []
  private hold: Snapshot[] = []
  private supportStartY: number | null = null
  private graceStartMs: number | null = null
  /** The first frame of a hold that read the foot off the floor (or moved), waiting on the next. */
  private groundGlitch: { frame: Snapshot; reason: ArabesqueRejectReason } | null = null
  private refractoryUntilMs = 0
  private lastFrameMs: number | null = null
  private repCount = 0

  private dbgLift = 0
  private dbgEnterLift = 0
  private dbgExitLift = 0
  private dbgSupportGap = 0
  private dbgFloorLift = NaN
  private dbgLegsVisible = false
  private dbgReject: ArabesqueRejectReason = 'warming-up'
  private entryDipStartMs: number | null = null
  private attempt: ArabesqueAttempt | null = null
  private attemptSeq = 0

  constructor(config: Partial<ArabesqueDetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_ARABESQUE_CONFIG, ...config }
    this.bodyScale = new TimedRunningBodyScale(this.cfg.bodyScaleMs)
  }

  private vis(lm: NormalizedLandmark[], ...ids: number[]): boolean {
    return ids.every((id) => (lm[id]?.visibility ?? 0) >= this.cfg.visThresh)
  }

  reset(): void {
    this.bodyScale.reset()
    this.floorBaseline.reset()
    this.phase = 'warmup'
    this.working = null
    this.entering = []
    this.hold = []
    this.supportStartY = null
    this.graceStartMs = null
    this.groundGlitch = null
    this.refractoryUntilMs = 0
    this.lastFrameMs = null
    this.dbgReject = 'tracking-lost'
  }

  /** The most recent position that was abandoned before it counted, or null. */
  get lastAttempt(): ArabesqueAttempt | null {
    return this.attempt
  }

  /** Record why a candidate that got past the first frame was not counted. */
  private noteAttempt(reason: ArabesqueRejectReason, tMs: number): void {
    const frames = this.hold.length ? this.hold : this.entering
    if (frames.length < 2) return   // a single frame over the bar is noise, not an attempt
    let peak = -Infinity
    for (const f of frames) peak = Math.max(peak, f.arabesqueDeg)
    this.attempt = {
      seq: ++this.attemptSeq,
      reason,
      workingLeg: this.working,
      tMs,
      peakDeg: peak,
      heldMs: frames[frames.length - 1].tMs - frames[0].tMs,
      plateauMs: plateauOf(frames, this.cfg.plateauToleranceDeg).ms,
      floorLift: this.dbgFloorLift,
      supportGap: this.dbgSupportGap,
    }
  }

  private abort(reason: ArabesqueRejectReason): void {
    this.groundGlitch = null
    this.entryDipStartMs = null
    this.entering = []
    this.hold = []
    this.working = null
    this.supportStartY = null
    this.graceStartMs = null
    this.phase = 'idle'
    this.dbgReject = reason
  }

  private enterRefractory(tMs: number): void {
    this.entering = []
    this.hold = []
    this.working = null
    this.supportStartY = null
    this.graceStartMs = null
    this.phase = 'refractory'
    this.refractoryUntilMs = tMs + this.cfg.refractoryMs
  }

  get debug(): ArabesqueDebugState {
    return {
      phase: this.phase,
      workingLeg: this.working,
      arabesqueDeg: this.dbgLift,
      enterDeg: this.dbgEnterLift,
      exitDeg: this.dbgExitLift,
      supportGap: this.dbgSupportGap,
      floorLift: this.dbgFloorLift,
      plateauMs: this.hold.length ? plateauOf(this.hold, this.cfg.plateauToleranceDeg).ms : 0,
      heldMs: this.hold.length > 1 ? this.hold[this.hold.length - 1].tMs - this.hold[0].tMs : 0,
      bodyScale: this.bodyScale.value,
      legsVisible: this.dbgLegsVisible,
      lastReject: this.dbgReject,
      enteringFrames: this.entering.length,
      holdFrames: this.hold.length,
      reps: this.repCount,
    }
  }

  /**
   * Evaluate one candidate working leg from world landmarks (with the image as a second opinion).
   *
   * WHAT REAL FOOTAGE CHANGED
   * The first version measured how far the leg was raised BEHIND the dancer, in a body frame
   * built from the hip line. On ten real arabesques that "behind" component was noise: the
   * dancer stands three-quarters to the camera, the leg crosses the image, and the 3-D depth
   * that separates behind from beside is MediaPipe's weakest axis. Measured arabesques ranged
   * from 3 degrees in front to 25 behind, and a la seconde legs from 81 in front to 85 behind.
   * So the angle is now simply how far the leg is raised from hanging straight down, and
   * "not in front" is decided separately (legInFront) from cues the image does show.
   *
   * Up is -y: MediaPipe's world Y points down, verified on 18k real frames (99%). The old
   * up-direction came from the shoulders sitting above the hips, which flips sign in a deep
   * forward pitch - exactly the position of a high arabesque.
   */
  private evaluateWorld(lm: NormalizedLandmark[], world: Landmark[], side: 'L' | 'R') {
    const [workHip, workKnee, workAnkle] = side === 'L' ? [L_HIP, L_KNEE, L_ANKLE] : [R_HIP, R_KNEE, R_ANKLE]
    const [suppHip, suppKnee, suppAnkle] = side === 'L' ? [R_HIP, R_KNEE, R_ANKLE] : [L_HIP, L_KNEE, L_ANKLE]
    const d = (a: number, b: number) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z)
    const torso = Math.hypot(
      (world[L_SHOULDER].x + world[R_SHOULDER].x) / 2 - (world[L_HIP].x + world[R_HIP].x) / 2,
      (world[L_SHOULDER].y + world[R_SHOULDER].y) / 2 - (world[L_HIP].y + world[R_HIP].y) / 2,
      (world[L_SHOULDER].z + world[R_SHOULDER].z) / 2 - (world[L_HIP].z + world[R_HIP].z) / 2,
    )
    if (!(torso > 1e-6)) return null
    const legLen = (d(workHip, workKnee) + d(workKnee, workAnkle) + d(suppHip, suppKnee) + d(suppKnee, suppAnkle)) / 2
    if (!(legLen > 1e-6)) return null
    const hipY = (world[L_HIP].y + world[R_HIP].y) / 2
    const elevation = legElevation(lm, world, workHip, workAnkle)
    // The working foot has to be clearly off the floor: above the supporting foot by a share of
    // the leg. A fourth-position lunge has the back leg at a steep angle with its foot DOWN.
    const raise = (world[suppAnkle].y - world[workAnkle].y) / legLen
    const front = this.legInFront(lm, world, side, legLen)
    const raised = raise >= this.cfg.minFootRaise
    return {
      // Negative for a leg in front, so it can never clear the entry bar; 0 for a foot still down.
      arabesqueDeg: !raised ? 0 : front ? -elevation : elevation,
      supportGap: (world[suppAnkle].y - hipY) / torso,
      suppAnkleY: -world[suppAnkle].y / torso,
    }
  }

  /**
   * Is the raised leg in FRONT of the dancer? Decided from what the camera sees reliably:
   *
   *  - When the leg crosses the image, by where the face points. On all ten real arabesques the
   *    nose sat off the ear midpoint on the side AWAY from the leg - looking out over the front
   *    arm - and in a front extension the leg and the gaze go the same way. Failing a readable
   *    face, the higher arm reaching away from the leg says the same thing.
   *  - When the leg points at or away from the lens, by its depth: toward the camera is in front
   *    for a dancer facing it (face visible) and behind for one turned away.
   *
   * null when neither cue is readable - the leg is not then treated as being in front.
   */
  private legInFront(lm: NormalizedLandmark[], world: Landmark[], side: 'L' | 'R', legLen: number): boolean | null {
    const [hip, ankle] = side === 'L' ? [L_HIP, L_ANKLE] : [R_HIP, R_ANKLE]
    const torso = Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
      (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2)
    if (!(torso > 1e-6)) return null
    const legDx = (lm[ankle].x - lm[hip].x) / torso
    const faceVisible = this.vis(lm, NOSE, L_EAR, R_EAR)
    if (Math.abs(legDx) >= this.cfg.frontCueMinLegDx) {
      if (faceVisible) {
        const face = (lm[NOSE].x - (lm[L_EAR].x + lm[R_EAR].x) / 2) / torso
        if (Math.abs(face) >= this.cfg.frontCueMinFace) return Math.sign(face) === Math.sign(legDx)
      }
      const wrists = [L_WRIST, R_WRIST].filter((id) => this.vis(lm, id))
      if (wrists.length) {
        const hi = wrists.reduce((a, b) => (lm[a].y <= lm[b].y ? a : b))
        const sh = hi === L_WRIST ? L_SHOULDER : R_SHOULDER
        const armDx = (lm[hi].x - lm[sh].x) / torso
        if (Math.abs(armDx) >= this.cfg.frontCueMinArmDx) return Math.sign(armDx) === Math.sign(legDx)
      }
      return null
    }
    // MediaPipe world z: smaller is closer to the camera.
    const dz = (world[ankle].z - world[hip].z) / legLen
    if (Math.abs(dz) < this.cfg.frontCueMinDepth) return null
    const towardCamera = dz < 0
    return faceVisible ? towardCamera : !towardCamera
  }

  /**
   * Image-space fallback for callers with no world landmarks (and for unit fixtures).
   *
   * Depth is gone, so front and back are indistinguishable: the horizontal term is taken as
   * a magnitude and a front développé reads the same as an arabesque. That is the accepted
   * limit of 2-D landmarks, and the reason /live always passes world landmarks — every
   * direction-dependent guarantee above holds only on the world path.
   */
  private evaluate(lm: NormalizedLandmark[], side: 'L' | 'R', scale: number) {
    const workAnkle = side === 'L' ? L_ANKLE : R_ANKLE
    const workHip = side === 'L' ? L_HIP : R_HIP
    const suppAnkle = side === 'L' ? R_ANKLE : L_ANKLE
    const hipMidY = (lm[L_HIP].y + lm[R_HIP].y) / 2
    // y grows downward, so "below the hip" is a POSITIVE y difference.
    const downComp = lm[workAnkle].y - lm[workHip].y
    const horiz = Math.abs(lm[workAnkle].x - lm[workHip].x)
    // Refuse to measure a leg too foreshortened for its on-screen angle to mean anything.
    // -180 can never clear any entry bar, so this reads as "not an arabesque" rather than
    // as a penché (see minImageLegExtension).
    const legOnScreen = Math.hypot(horiz, downComp)
    const measurable = scale > 1e-9 && legOnScreen / scale >= this.cfg.minImageLegExtension
    const arabesqueDeg = measurable ? (Math.atan2(horiz, downComp) * 180) / Math.PI : -180
    return {
      arabesqueDeg,
      supportGap: (lm[suppAnkle].y - hipMidY) / scale,
      suppAnkleY: lm[suppAnkle].y / scale,
    }
  }

  /**
   * Angle at joint `b` between `a` and `c`, in 3-D when world landmarks are available and in
   * the image plane otherwise. Same policy as JumpRepDetector.jointAngle, and needed here for
   * the same reason: the image plane cannot be trusted for a limb pointing at the camera, and
   * on /live the working leg of an arabesque always is.
   */
  /**
   * A knee, from the 3-D and true-proportion image readings (geometry.kneeReading). On ten real
   * arabesques the 3-D reading alone told three visibly straight legs to straighten - one with
   * the ankle landmark on the hand - while the screen read all ten at 162-180.
   */
  private kneeAngle(lm: NormalizedLandmark[], world: Landmark[] | undefined, b: number, a: number, c: number): number {
    const A = this.cfg.aspect
    const w = world && world.length > Math.max(a, b, c) ? angleAt3(world[b], world[a], world[c]) : NaN
    const img = this.vis(lm, a, b, c)
      ? angleAt({ x: lm[b].x * A, y: lm[b].y }, { x: lm[a].x * A, y: lm[a].y }, { x: lm[c].x * A, y: lm[c].y })
      : NaN
    return kneeReading(w, img)
  }

  private jointAngle(
    lm: NormalizedLandmark[],
    world: Landmark[] | undefined,
    b: number,
    a: number,
    c: number,
  ): number {
    if (world && world.length > Math.max(a, b, c)) {
      const ang = angleAt3(world[b], world[a], world[c])
      if (Number.isFinite(ang)) return ang
    }
    if (!this.vis(lm, a, b, c)) return NaN
    return angleAt(pt(lm, b), pt(lm, a), pt(lm, c))
  }

  /** Feed one detected frame. Returns a completed arabesque, or null. */
  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): ArabesqueEvent | null {
    if (this.lastFrameMs !== null && tMs - this.lastFrameMs > this.cfg.trackingGapMs) {
      this.reset()
    }
    this.lastFrameMs = tMs

    const legsVisible = this.vis(lm, L_HIP, R_HIP, L_ANKLE, R_ANKLE)
    this.dbgLegsVisible = legsVisible

    if (!legsVisible) {
      if (this.phase === 'entering' || this.phase === 'held') this.abort('legs-not-visible')
      else this.dbgReject = 'legs-not-visible'
      return null
    }

    if (this.vis(lm, L_SHOULDER, R_SHOULDER)) {
      // TORSO length (shoulder-mid to hip-mid), NOT the shoulder-to-ankle-mid scale the
      // jump detector uses. Ankle-mid is only a stable reference while both feet are on
      // the floor; raising one leg drags it upward, so in a 45-degree arabesque that
      // scale collapses by roughly two thirds and every ratio measured against it
      // silently inflates. Torso length does not move when a leg does.
      const shoulderMid = { x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 }
      const hipMid = { x: (lm[L_HIP].x + lm[R_HIP].x) / 2, y: (lm[L_HIP].y + lm[R_HIP].y) / 2 }
      this.bodyScale.push(shoulderMid, hipMid, tMs)
    }

    if (!this.bodyScale.ready(this.cfg.minWarmupSamples)) {
      this.phase = 'warmup'
      this.dbgReject = 'warming-up'
      return null
    }
    if (this.phase === 'warmup') this.phase = 'idle'

    const scale = this.bodyScale.value
    const enterLift = this.cfg.minArabesqueDeg

    const lowestY = lowestFootY(lm, this.cfg.visThresh)
    const floorBase = Number.isFinite(lowestY) ? this.floorBaseline.push(lowestY, tMs) : this.floorBaseline.value
    const floorLift = Number.isFinite(lowestY) && Number.isFinite(floorBase) && scale > 1e-9
      ? (floorBase - lowestY) / scale
      : NaN
    this.dbgFloorLift = floorLift
    // Unreadable feet do not veto: the legsVisible gate above already demands the ankles.
    const onFloor = !(floorLift > this.cfg.floorLiftRatio)
    const exitLift = this.cfg.exitArabesqueDeg
    this.dbgEnterLift = enterLift
    this.dbgExitLift = exitLift

    if (this.phase === 'refractory') {
      if (tMs < this.refractoryUntilMs) {
        this.dbgReject = 'refractory'
        return null
      }
      this.phase = 'idle'
    }

    // Once a side is chosen, stay on it — swapping mid-hold would splice two positions.
    const sides: Array<'L' | 'R'> = this.working ? [this.working] : ['L', 'R']
    let best: { side: 'L' | 'R'; arabesqueDeg: number; supportGap: number; suppAnkleY: number } | null = null
    // Tracked separately from `best`, which is a MAXIMUM over the sides: a dancer holding a
    // front extension has their standing leg at about 0 degrees, and 0 beats the raised
    // leg's negative value, so `best` alone reports "nothing happening". A front extension
    // is not nothing - it is a different move - and the readout has to distinguish them, or
    // a tally of zero has no explanation.
    let frontRaised = false
    for (const side of sides) {
      const e = (world && world.length > R_FOOT ? this.evaluateWorld(lm, world, side) : null)
        ?? this.evaluate(lm, side, scale)
      if (e.arabesqueDeg <= -this.cfg.minArabesqueDeg) frontRaised = true
      if (!best || e.arabesqueDeg > best.arabesqueDeg) best = { side, ...e }
    }
    if (!best) return null

    this.dbgLift = best.arabesqueDeg
    this.dbgSupportGap = best.supportGap

    const supportGrounded = best.supportGap >= this.cfg.supportGroundRatio && onFloor
    const groundReject: ArabesqueRejectReason = onFloor ? 'support-not-grounded' : 'feet-off-floor'
    const frame: Snapshot = { lm, tMs, arabesqueDeg: best.arabesqueDeg, world }

    switch (this.phase) {
      case 'idle': {
        if (best.arabesqueDeg < enterLift) {
          this.dbgReject = frontRaised ? 'leg-in-front'
            : best.arabesqueDeg > 0 ? 'leg-not-raised' : null
          return null
        }
        if (!supportGrounded) {
          this.dbgReject = groundReject
          return null
        }
        this.phase = 'entering'
        this.working = best.side
        this.entering = [frame]
        this.supportStartY = best.suppAnkleY
        this.dbgReject = 'unconfirmed'
        return null
      }

      case 'entering': {
        if (!supportGrounded) {
          this.noteAttempt(groundReject, tMs)
          this.abort(groundReject)
          return null
        }
        if (best.arabesqueDeg < enterLift) {
          // Forgive a brief dip on the way in, as long as the leg is still clearly up.
          if (this.entryDipStartMs === null) this.entryDipStartMs = tMs
          if (best.arabesqueDeg > exitLift && tMs - this.entryDipStartMs <= this.cfg.exitGraceMs) {
            this.entering.push(frame)
            return null
          }
          this.noteAttempt('leg-not-raised', tMs)
          this.abort('leg-not-raised')
          return null
        }
        this.entryDipStartMs = null
        this.entering.push(frame)
        const held = tMs - this.entering[0].tMs
        if (held + T_EPS >= this.cfg.confirmMs && this.entering.length >= this.cfg.confirmMinFrames) {
          this.phase = 'held'
          this.hold = this.entering
          this.entering = []
          this.graceStartMs = null
          this.entryDipStartMs = null
          this.dbgReject = null
          // A dancer who arrives already settled is confirmed on this frame, not the next.
          return this.tryConfirm(frame)
        }
        return null
      }

      case 'held': {
        // The supporting foot leaving the floor means this became a jump or a fall, not
        // a longer arabesque — end it rather than folding the travel into the hold.
        // suppAnkleY is ALREADY in torso-length units (both evaluate paths divide by the
        // torso scale before returning it), so dividing by `scale` again double-normalised
        // the drift. With an image torso around 0.2 that inflated every measured drift about
        // fivefold, and on the world path — where suppAnkleY is ~1.7 torso units and `scale`
        // is an IMAGE length — the two were not even the same quantity. A couple of
        // centimetres of ankle noise could read as the supporting foot leaving the floor,
        // truncating the hold below minHoldMs so it was discarded as too short. A hold that
        // ends early is indistinguishable from no detection at all from the outside, which
        // is part of why nothing fired.
        const lost: ArabesqueRejectReason =
          this.supportStartY !== null && Math.abs(best.suppAnkleY - this.supportStartY) > this.cfg.supportDriftRatio
            ? 'support-lifted'
            : !onFloor ? 'feet-off-floor' : null
        if (lost) {
          // One frame of it in the middle of a hold is a tracking glitch more often than a jump:
          // on the reference footage a frame that swapped the legs read the standing foot well
          // off the floor, ended a rising arabesque at 69 degrees under one pose runtime, and
          // the refractory after it hid the 119-degree hold that followed. A real take-off stays
          // off the floor, so it still ends the hold - one frame later, at its first frame.
          if (!this.groundGlitch) {
            this.groundGlitch = { frame, reason: lost }
            return null
          }
          const first = this.groundGlitch
          this.groundGlitch = null
          return this.closeHold(first.frame, first.reason)
        }
        this.groundGlitch = null
        if (best.arabesqueDeg > exitLift && supportGrounded) {
          this.hold.push(frame)
          this.graceStartMs = null
          // Emit the moment the position is confirmed rather than when the leg comes down -
          // the dancer gets the critique while they are still in, or just out of, the pose.
          const settled = this.tryConfirm(frame)
          if (settled) return settled
          // Or the moment the leg has clearly left its highest point: a passing arabesque.
          if (this.hold.length >= this.cfg.confirmMinFrames && !this.briefAndLow() &&
              best.arabesqueDeg <= topOf(this.hold) - this.cfg.peakDropDeg) {
            return this.emit(frame, 'sustain')
          }
          return null
        }
        if (this.graceStartMs === null) this.graceStartMs = tMs
        if (tMs - this.graceStartMs <= this.cfg.exitGraceMs) {
          this.hold.push(frame)
          return null
        }
        return this.closeHold(frame, null)
      }

      case 'sustain': {
        // Already counted. Wait for the leg to come down (or the foot to leave the floor) so
        // one long balance is one arabesque, then go refractory.
        const stillUp = best.arabesqueDeg > exitLift && supportGrounded &&
          !(this.supportStartY !== null &&
            Math.abs(best.suppAnkleY - this.supportStartY) > this.cfg.supportDriftRatio)
        if (stillUp) {
          this.graceStartMs = null
          return null
        }
        if (this.graceStartMs === null) this.graceStartMs = tMs
        if (tMs - this.graceStartMs > this.cfg.exitGraceMs) this.enterRefractory(tMs)
        return null
      }

      default:
        return null
    }
  }

  /**
   * The critiques that need depth: where the leg points, the relevé, the gaze and the foot.
   * World landmarks only — every one of them is a direction, and on the image plane the
   * front-facing camera cannot tell front from back.
   *
   * Unlike the core metrics, these are OMITTED rather than nulled when they cannot be read.
   * A null tells selectFeedback "tried and failed" and withholds praise, which is right for
   * the knee or the height; but a face turned out of view, an arm held in second rather than
   * reaching forward, or a flat supporting foot are not failures to measure the arabesque.
   * Each is either not part of THIS arabesque or a detail that should not cost the dancer
   * the verdict on everything else.
   */
  private worldMetrics(frames: Snapshot[], working: 'L' | 'R'): Record<string, number> {
    const gaze: number[] = []
    for (const f of frames) {
      const lm = f.lm
      // Gaze, in the IMAGE: is the face turned toward the reaching (higher) arm? Measured as the
      // nose's offset from the ear midpoint, toward that arm's side, in torso lengths. On ten real
      // arabesques the dancer looked out over the front arm every time and this read +0.04 to
      // +0.11. The 3-D version (face direction against arm direction) needed the depth of the
      // face and the arm, and returned nothing usable on any of them.
      const torso = Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
        (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2)
      const wrists = [L_WRIST, R_WRIST].filter((id) => this.vis(lm, id))
      if (torso > 1e-6 && wrists.length && this.vis(lm, NOSE, L_EAR, R_EAR)) {
        const hi = wrists.reduce((a, b) => (lm[a].y <= lm[b].y ? a : b))
        const sh = hi === L_WRIST ? L_SHOULDER : R_SHOULDER
        const armDx = lm[hi].x - lm[sh].x
        if (Math.abs(armDx) / torso >= this.cfg.frontCueMinArmDx) {
          const face = (lm[NOSE].x - (lm[L_EAR].x + lm[R_EAR].x) / 2) / torso
          gaze.push(face * Math.sign(armDx))
        }
      }
    }
    // Not reported (checked against ten real arabesques, and wrong on them):
    //  - arabesque_line: whether the leg points straight back or out to the side is the depth axis
    //    (see evaluateWorld), and a cue built on it told correct arabesques to bring the leg behind.
    //  - arabesque_releve: the supporting foot's heel-over-toe pitch read 21-38 degrees on every
    //    arabesque against 14-25 standing flat - not separable from flat at webcam resolution.
    //  - arabesque_point: the toe landmark sits almost on the ankle on a pointed jazz shoe, so
    //    every visibly pointed foot read 113-133 degrees, "flexed" - eight of ten told to point.
    const out: Record<string, number> = {}
    // Two frames at least, so one glance does not decide it.
    const g = gaze.length >= 2 ? medianOf(gaze) : null
    if (g !== null) out.arabesque_gaze = g
    return out
  }

  /** Emit if the hold so far is long enough AND has settled into a plateau. */
  private tryConfirm(latest: Snapshot): ArabesqueEvent | null {
    const held = this.hold
    const holdMs = held[held.length - 1].tMs - held[0].tMs
    if (holdMs + T_EPS < this.cfg.minHoldMs) return null
    const plateau = plateauOf(held, this.cfg.plateauToleranceDeg)
    if (plateau.ms + T_EPS < this.cfg.minPlateauMs) return null
    // Only just over the bar so far: wait - held a little longer, it counts.
    if (this.briefAndLow()) return null
    return this.emit(latest, 'sustain')
  }

  /**
   * The leg has been up (at minArabesqueDeg or more) for under briefHoldMs and never reached
   * briefMinDeg. Frames carried by the exit grace after the leg dropped do not count as up.
   */
  private briefAndLow(): boolean {
    const up = this.hold.filter((f) => f.arabesqueDeg >= this.cfg.minArabesqueDeg)
    if (!up.length) return true
    const upMs = up[up.length - 1].tMs - up[0].tMs
    return upMs + T_EPS < this.cfg.briefHoldMs && topOf(this.hold) < this.cfg.briefMinDeg
  }

  /**
   * Count the position now, scored on the frames at the top of the hold, then either keep
   * watching for the leg to come down ('sustain') or, if it already has, go refractory.
   */
  private emit(latest: Snapshot, next: 'sustain' | 'refractory'): ArabesqueEvent | null {
    this.groundGlitch = null
    const held = this.hold
    const holdMs = held.length > 1 ? held[held.length - 1].tMs - held[0].tMs : 0
    const plateau = plateauOf(held, this.cfg.plateauToleranceDeg)
    const top = plateau.frames.length ? plateau.frames : held
    const working = this.working ?? 'L'

    // A leg the tracker had to guess: hidden behind furniture, it still draws one, raised.
    const LEG_POINTS = [L_KNEE, R_KNEE, L_ANKLE, R_ANKLE, L_HEEL, R_HEEL, L_FOOT, R_FOOT]
    const legVis = medianOf(held.map((f) => Math.min(...LEG_POINTS.map((id) => f.lm[id]?.visibility ?? 0))))
    if (legVis !== null && legVis < this.cfg.minLegVisibility) {
      this.noteAttempt('legs-unclear', latest.tMs)
      this.abort('legs-unclear')
      return null
    }

    // A leg behind with the knee folded is an attitude, or a heel kicking up mid-run.
    const [wHip, wKnee, wAnkle] = working === 'L' ? [L_HIP, L_KNEE, L_ANKLE] : [R_HIP, R_KNEE, R_ANKLE]
    const knees = top.map((f) => this.jointAngle(f.lm, f.world, wKnee, wHip, wAnkle)).filter(Number.isFinite)
    const knee = medianOf(knees)
    // The standing leg in a deep plié is a preparation - the spring into a sashay or a jump -
    // not an arabesque. Real arabesques held the standing knee at 149-164 degrees; the leg
    // lift before a sashay that read as one stood at 106.
    const [sHip, sKnee, sAnkle] = working === 'L' ? [R_HIP, R_KNEE, R_ANKLE] : [L_HIP, L_KNEE, L_ANKLE]
    const supp = medianOf(top.map((f) => this.jointAngle(f.lm, f.world, sKnee, sHip, sAnkle)).filter(Number.isFinite))
    if (supp !== null && supp < this.cfg.minSupportKneeDeg) {
      this.noteAttempt('support-in-plie', latest.tMs)
      this.abort('support-in-plie')
      return null
    }
    if (knee !== null && knee < this.cfg.minWorkingKneeDeg) {
      // No refractory: a développé passes through a folded knee on its way up, and the
      // arabesque it unfolds into is a moment later. A cooldown here hid exactly that.
      this.noteAttempt('working-knee-folded', latest.tMs)
      this.abort('working-knee-folded')
      return null
    }

    const event = this.finalize(held, top, holdMs, plateau.ms, working)
    this.repCount++
    this.dbgReject = null
    if (next === 'refractory') {
      this.enterRefractory(latest.tMs)
    } else {
      // Keep the side and the support reference: 'sustain' still watches both.
      this.phase = 'sustain'
      this.entering = []
      this.hold = [latest]
      this.graceStartMs = null
    }
    return event
  }

  /**
   * The leg came down (or the foot left the floor) before the position settled. Since an
   * arabesque does not have to be held, a confirmed one is still counted here — scored on the
   * frames from BEFORE the foot left or the leg dropped, which are all that the hold contains.
   */
  private closeHold(endFrame: Snapshot, reason: ArabesqueRejectReason): ArabesqueEvent | null {
    const brief = this.briefAndLow()
    if (this.hold.length >= this.cfg.confirmMinFrames && !brief) return this.emit(endFrame, 'refractory')
    const holdMs = this.hold.length > 1 ? this.hold[this.hold.length - 1].tMs - this.hold[0].tMs : 0
    const why = brief ? 'brief-and-low' : reason ?? (holdMs + T_EPS < this.cfg.minHoldMs ? 'too-short' : 'no-plateau')
    this.noteAttempt(why, endFrame.tMs)
    this.abort(why)
    this.enterRefractory(endFrame.tMs)
    return null
  }

  /**
   * Metrics over the PLATEAU - the frames where the leg sat at the top of the position.
   * The hold also contains the ramp up from the entry angle, and with the event now firing
   * as soon as the position settles that ramp is a large share of it; scoring the ramp would
   * report every arabesque lower than the dancer actually took it.
   */
  private finalize(
    held: Snapshot[],
    plateau: Snapshot[],
    holdMs: number,
    plateauMs: number,
    working: 'L' | 'R',
  ): ArabesqueEvent {
    const midFrames = plateau.length ? plateau : held

    let peak = held[0]
    for (const f of held) if (f.arabesqueDeg > peak.arabesqueDeg) peak = f

    const [wHip, wKnee, wAnkle] = working === 'L' ? [L_HIP, L_KNEE, L_ANKLE] : [R_HIP, R_KNEE, R_ANKLE]
    const [sHip, sKnee, sAnkle] = working === 'L' ? [R_HIP, R_KNEE, R_ANKLE] : [L_HIP, L_KNEE, L_ANKLE]

    const median = (xs: number[]): number | null => {
      if (!xs.length) return null
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
    }

    const metrics: Record<string, number | null> = {}

    // arabesque_height is the SAME angle the gate uses: degrees the working leg is raised
    // behind the dancer, 0 standing and 90 horizontal. It used to be degrees above
    // HORIZONTAL, which is 90 less, and scored against a band of 30 (poor) to 70
    // (excellent) — so a textbook 90 degree arabesque measured 0 and scored 0/100 while
    // being told to lift the leg higher. The band in shared/thresholds.json moved with this
    // definition; the two have to be read together.
    //
    // Taken from the snapshots rather than recomputed, so the number the dancer is scored on
    // is the number the detector actually gated on.
    const heights = [peak, ...midFrames].map((f) => f.arabesqueDeg)
    metrics.arabesque_height = median(heights)

    // A working shin under half its thigh's length on screen is an ankle the tracker lost - on a
    // real arabesque it sat on the knee, and both readings called a straight leg bent.
    const workKneeOf = (f: Snapshot): number => {
      const A = this.cfg.aspect
      const seg = (a: number, b: number) => Math.hypot((f.lm[a].x - f.lm[b].x) * A, f.lm[a].y - f.lm[b].y)
      return seg(wKnee, wAnkle) >= 0.5 * seg(wHip, wKnee) ? this.kneeAngle(f.lm, f.world, wKnee, wHip, wAnkle) : NaN
    }
    const workKnee: number[] = []
    const suppKnee: number[] = []
    const tilts: number[] = []
    for (const f of midFrames) {
      const wa = workKneeOf(f)
      if (Number.isFinite(wa)) workKnee.push(wa)
      const sa = this.kneeAngle(f.lm, f.world, sKnee, sHip, sAnkle)
      if (Number.isFinite(sa)) suppKnee.push(sa)

      // Carriage: how far the torso is pitched off vertical. In 3-D when world landmarks are
      // available, because a chest pitched TOWARD or AWAY from the lens foreshortens in the
      // image plane and reads as upright - and on /live, pitching over an arabesque is
      // pitched straight at the camera, so the image measure misses the one fault this
      // metric exists to catch.
      if (f.world && f.world.length > R_HIP) {
        const w = f.world
        const torso = {
          x: (w[L_SHOULDER].x + w[R_SHOULDER].x) / 2 - (w[L_HIP].x + w[R_HIP].x) / 2,
          y: (w[L_SHOULDER].y + w[R_SHOULDER].y) / 2 - (w[L_HIP].y + w[R_HIP].y) / 2,
          z: (w[L_SHOULDER].z + w[R_SHOULDER].z) / 2 - (w[L_HIP].z + w[R_HIP].z) / 2,
        }
        const norm = Math.hypot(torso.x, torso.y, torso.z)
        if (norm > 1e-9) {
          // Up is the direction the torso mostly points, so its sign falls out of the same
          // measurement rather than being assumed about the Y axis.
          const upSign = Math.sign(torso.y) || -1
          const cos = (torso.y * upSign) / norm
          tilts.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI)
        }
      } else if (this.vis(f.lm, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)) {
        const shoulderMid = { x: (f.lm[L_SHOULDER].x + f.lm[R_SHOULDER].x) / 2, y: (f.lm[L_SHOULDER].y + f.lm[R_SHOULDER].y) / 2 }
        const hipMid = { x: (f.lm[L_HIP].x + f.lm[R_HIP].x) / 2, y: (f.lm[L_HIP].y + f.lm[R_HIP].y) / 2 }
        const torso = { x: shoulderMid.x - hipMid.x, y: shoulderMid.y - hipMid.y }
        const norm = Math.hypot(torso.x, torso.y)
        if (norm > 1e-9) {
          tilts.push((Math.acos(Math.max(-1, Math.min(1, (torso.y * -1) / norm))) * 180) / Math.PI)
        }
      }
    }
    // The working knee as it typically read at the top of the position OR across the whole hold,
    // whichever is straighter. A développé is still unfolding on the way up, so the top is where
    // to judge it; a kick is straight all the way and blurred at the top - on the reference
    // footage a fast kick to 125 degrees read 122-142 over its top frames and 161-178 either side.
    // A leg bent throughout reads bent on both.
    const topKnee = median(workKnee)
    const holdKnee = median(held.map(workKneeOf).filter(Number.isFinite))
    metrics.arabesque_knee_ext = topKnee === null ? holdKnee : holdKnee === null ? topKnee : Math.max(topKnee, holdKnee)
    metrics.support_knee_ext = median(suppKnee)
    // How far the chest pitched forward BEYOND what the leg height asks for. A leg above 90
    // degrees takes the torso forward with it - the higher the arabesque the more it tips - and
    // scoring the raw pitch told every high arabesque to lift the chest. Real arabesques at 66-150
    // degrees pitched 9-33; the allowance is half a degree per degree of leg above horizontal.
    const tilt = median(tilts)
    const height = metrics.arabesque_height
    metrics.arabesque_chest = tilt !== null && height !== null
      ? tilt - Math.max(0, (height - 90) * this.cfg.chestAllowancePerDeg)
      : null
    Object.assign(metrics, this.worldMetrics(midFrames, working))
    // No hold_duration_s. It scored a 2 s balance as excellent and anything under 0.5 s as 0,
    // which told every dynamic arabesque in a combination to "hold" a position the
    // choreography never asked them to hold. How long it lasted is reported on the event.

    return {
      workingLeg: working,
      supportingLeg: working === 'L' ? 'R' : 'L',
      metrics,
      startMs: held[0].tMs,
      peakMs: peak.tMs,
      endMs: held[held.length - 1].tMs,
      holdMs,
      plateauMs,
      peakArabesqueDeg: peak.arabesqueDeg,
    }
  }
}

type V3 = { x: number; y: number; z: number }
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const mid3 = (a: V3, b: V3): V3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const deg = (r: number) => (r * 180) / Math.PI

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

/**
 * Highest leg angle in the hold, with single-frame spikes removed the same way plateauOf does,
 * so one glitched frame cannot make the real leg look like it has already dropped from its top.
 */
function topOf(frames: Snapshot[]): number {
  let top = -Infinity
  for (let i = 0; i < frames.length; i++) {
    const x = frames[i].arabesqueDeg
    if (i > 0 && i < frames.length - 1) {
      const a = frames[i - 1].arabesqueDeg
      const b = frames[i + 1].arabesqueDeg
      if (Math.abs(a - b) <= 6 && Math.abs(x - a) > 6 && Math.abs(x - b) > 6) continue
    }
    if (x > top) top = x
  }
  return top
}

/**
 * The dancer's own horizontal frame from the SHOULDER line: `right`, `forward`, and the sign
 * of up. Shoulders rather than hips because an arabesque is supposed to open the working hip
 * a little — measuring "behind" against the hip line would call that correct hip a leg
 * drifting sideways. The shoulders stay facing where the dancer faces.
 */
function shoulderFrame(w: Landmark[]): { right: V3; forward: V3; upSign: number } | null {
  const upSign = Math.sign(mid3(w[L_SHOULDER], w[R_SHOULDER]).y - mid3(w[L_HIP], w[R_HIP]).y) || -1
  const rx = w[R_SHOULDER].x - w[L_SHOULDER].x
  const rz = w[R_SHOULDER].z - w[L_SHOULDER].z
  const rn = Math.hypot(rx, rz)
  if (rn < 1e-6) return null
  const right = { x: rx / rn, y: 0, z: rz / rn }
  // backward = down x right (see evaluateWorld); forward is its negation.
  const forward = { x: upSign * right.z, y: 0, z: -upSign * right.x }
  return { right, forward, upSign }
}

/**
 * The longest run of frames whose leg angle stays inside a band `toleranceDeg` wide, near
 * the top of the hold. Returns its duration and the frames inside it.
 *
 * Two defences against tracking noise, neither of which lets a kick through:
 *
 *  - A single frame that jumps more than the tolerance away from BOTH neighbours, while the
 *    neighbours agree with each other, is one bad landmark and is replaced by their mean. A
 *    kick's top is a smooth arc, so no frame in it is ever an isolated spike like that.
 *  - The band floats: it is measured as max minus min INSIDE the window, not as distance
 *    below the whole hold's highest frame. Under the old peak anchor one spike set a target
 *    the real leg never reached, and the plateau could not be found again until the leg
 *    happened to jitter up to it. For a clean kick the two definitions give the same answer,
 *    because the window that holds its top also holds its peak.
 *
 * The window must also sit near the top of the hold (its mean within two tolerances of the
 * despiked peak), so a pause on the way up is not mistaken for the position itself.
 */
function plateauOf(frames: Snapshot[], toleranceDeg: number): { ms: number; frames: Snapshot[] } {
  const n = frames.length
  if (!n) return { ms: 0, frames: [] }
  const raw = frames.map((f) => f.arabesqueDeg)
  const v = raw.map((x, i) => {
    if (i === 0 || i === n - 1) return x
    const a = raw[i - 1]
    const b = raw[i + 1]
    const spike = Math.abs(a - b) <= toleranceDeg &&
      Math.abs(x - a) > toleranceDeg && Math.abs(x - b) > toleranceDeg
    return spike ? (a + b) / 2 : x
  })
  let peak = -Infinity
  for (const x of v) if (x > peak) peak = x
  const nearTop = peak - 2 * toleranceDeg

  let best: { ms: number; frames: Snapshot[] } = { ms: 0, frames: [] }
  let lo = 0
  for (let hi = 0; hi < n; hi++) {
    for (;;) {
      let mx = -Infinity
      let mn = Infinity
      for (let k = lo; k <= hi; k++) {
        if (v[k] > mx) mx = v[k]
        if (v[k] < mn) mn = v[k]
      }
      if (mx - mn <= toleranceDeg + T_EPS) break
      lo++
    }
    let sum = 0
    for (let k = lo; k <= hi; k++) sum += v[k]
    if (sum / (hi - lo + 1) < nearTop) continue
    const ms = frames[hi].tMs - frames[lo].tMs
    if (ms > best.ms || (ms === best.ms && hi - lo + 1 > best.frames.length)) {
      best = { ms, frames: frames.slice(lo, hi + 1) }
    }
  }
  return best
}
