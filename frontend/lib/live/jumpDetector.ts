// Streaming TS port of jump/leap detection + metrics — analysis/moves.py's detect_jumps()
// and analysis/metrics.py's compute_jump_metrics(), adapted to run frame-by-frame instead
// of over a whole buffered clip. Turns (detect_turns) are intentionally not ported yet —
// see ROADMAP.md slice 2b / 2b-ii.
//
// WHY THIS DIVERGES FROM detect_jumps()
// -------------------------------------
// The batch version's airborne test is `(baseline - hip_mid_y) > 0.06 * body_scale`, where
// baseline is a 2 s TRAILING median. That reference is "where the hips were recently", not
// "where the floor is", which makes it a drift detector rather than a jump detector: any
// sustained hip rise larger than the threshold that outpaces the median reads as flight.
// Measured against this detector, a crouch-to-stand of 0.10 with the feet planted the whole
// time produced a confirmed rep, as did any rise >= 0.05 completed in under ~2 s.
//
// That is survivable on uploaded clips of someone dancing. It is not survivable on a live
// webcam pointed at someone standing up, stepping into frame, or fixing their posture.
//
// The fix is not a bigger threshold — no displacement threshold separates a planted-feet
// posture change from a leap, because both move the hips by the same amount. It is an
// ANKLE GATE: in a real leap the whole body translates, so the ankles rise with the hips;
// standing up, the feet stay on the floor and the ankles do not move. See ankleRiseRatio.
//
// LEAP vs JUMP IS DECIDED BY THREE INDEPENDENT QUESTIONS
// ------------------------------------------------------
// Which frames, how wide, and which way — and the rep has to answer all three. Each came
// from a real misclassification, and none of them subsumes the others:
//
//  1. WHICH FRAMES may vote (the plié gate). Only frames whose feet are genuinely off the
//     floor. Without this, the tail of the push-off and the front of the landing fold get
//     to decide the split, and those are the frames where the legs are shortest and the
//     feet furthest apart — which is how a straight jump out of a deep plié read as a
//     split about half the time. See leapMinAnkleRiseFraction.
//
//  2. HOW WIDE the legs got (separation, normalised by leg length). Necessary, but on its
//     own it has almost no margin: a straight jump from a deep plié with the feet 44 cm
//     apart measures 0.52 against a 0.60 bar, while a genuine medium split measures 0.96.
//     The bands nearly touch, so the bar cannot simply be raised. Note that leg length is
//     the SUM OF THE SEGMENTS, never the hip-to-ankle distance — that distance is a
//     function of the knee angle, and using it as a divisor let a folded knee inflate
//     every separation measured in that pose by up to 1.4x. See leapSeparationRatioWorld.
//
//  3. WHICH WAY each leg went (the shape). Each leg's swing off vertical, and whether the
//     two went to OPPOSITE sides of the body. This is pure direction, so no amount of knee
//     folding, stance width or depth noise can manufacture it, and it is what actually
//     separates the classes: 8 degrees for the jump above, 27+ for a real split. It is
//     also the only test that rejects a tuck, where the ankles travel far but both legs
//     travel the same way. See leapMinLegDeviationDeg.
//
// A knee-extension gate runs alongside, to stop a tuck reading as a split on width, and is
// checked on the anchor frame as well as the sample median so that the frame which earned
// the rep its width is also a frame with the legs extended.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import {
  angleAt,
  angleAt3,
  lowestFootY,
  TimedRollingBaseline,
  TimedRunningBodyScale,
  type Point,
} from './geometry'

const NOSE = 0, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12
const L_WRIST = 15, R_WRIST = 16
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28
const L_FOOT = 31, R_FOOT = 32

// split_angle is still reported as a scored metric (see metric_to_cue -> bigger_split),
// but it no longer decides leap vs jump — leapSeparationRatio does. See finalizeRep.

// Timestamps accumulate float error (a 30 fps step is 33.333... ms), so a duration
// that should land exactly on a bound can come up a hair short. Every elapsed-time
// comparison below is slackened by this rather than dropping a rep on rounding.
const T_EPS = 1e-6

export interface JumpDetectorConfig {
  /** Trailing-median window for the hip and ankle height baselines. */
  baselineMs: number
  /** Trailing-median window for body scale (shoulder-mid to ankle-mid distance). */
  bodyScaleMs: number
  /** Hip rise needed to ENTER flight, as a fraction of body scale. */
  enterRatio: number
  /** Hip rise needed to STAY in flight — lower than enterRatio, this is the hysteresis. */
  exitRatio: number
  /** Ankles must rise at least this fraction of the hip rise. The planted-feet test. */
  ankleRiseRatio: number
  /**
   * THE FLOOR GATE. The lowest visible point of either foot must clear its floor baseline
   * by this fraction of body scale, on at least `minFloorClearFrames` flight frames, or the
   * "flight" was never a jump at all and no rep is emitted.
   *
   * The ankle gate above cannot stand in for this. It reads the ankle MIDPOINT, and raising
   * one leg behind lifts the midpoint by half that leg's travel — so an arabesque, above
   * all one taken on relevé (which lifts the hips too), passed it with the supporting foot
   * flat on the floor, and then read as a leap because its legs really are split. The
   * lowest point of the feet is the supporting toe in an arabesque, a relevé or a
   * battement, and it does not move; in any jump it leaves the floor.
   */
  floorClearRatio: number
  minFloorClearFrames: number
  /**
   * Ankle separation over body scale at the apex, above which a rep counts as a leap
   * rather than a jump. Legs together sits near hip width (~0.15); a real split is ~0.7.
   */
  leapSeparationRatio: number
  /**
   * Same test in WORLD coordinates, normalised by leg length instead of body scale.
   * Different units, so it needs its own value: legs together sit near 0.25, a real
   * split near 1.4.
   */
  leapSeparationRatioWorld: number
  /**
   * Both knees must be at least this extended at the apex for a rep to read as a leap.
   * Stops a hard tuck, which throws ankles sideways in frame, counting as a split.
   */
  leapMinKneeExtDeg: number
  /**
   * Angle between the two legs, in degrees, below which the shape is not a split however
   * wide it measured. Length-free and bend-free: it is the angle between the hip->ankle
   * DIRECTIONS, so nothing about how short a leg looks can inflate it, and two legs swung
   * the same way score near zero however far they travelled.
   */
  leapMinSplitAngleDeg: number
  /**
   * How long the split must be visible, in real ms, converted to a frame count at the rate
   * the flight was actually captured (never fewer than one frame). See the leap gate in
   * finalizeRep for why this is a short time and not a share of the flight.
   */
  leapMinSplitHoldMs: number
  /**
   * A frame may only be used to judge the split if its ankle rise is at least this share
   * of the peak ankle rise in the same flight. The plié gate: a foot on or near the floor
   * cannot vote on whether the legs were split in the air.
   */
  leapMinAnkleRiseFraction: number
  /**
   * Absolute floor for the same test, as a fraction of body scale, so a flight whose peak
   * ankle rise is itself tiny (a heel-raise roll-through, not a jump) has no frame that
   * counts as airborne rather than every frame clearing a proportion of almost nothing.
   */
  leapMinAnkleRiseRatio: number
  /**
   * Share of the eligible flight frames sampled around the widest point of the split.
   * Proportional rather than a fixed ms window: at 12 fps a 280 ms leap is only about 3
   * frames, so a fixed window collapses to nothing and the closing frames dominate.
   */
  leapSampleFraction: number
  /** Fewer usable samples than this and the rep cannot be called a leap. */
  leapSampleMinFrames: number
  /**
   * Share of sampled frames that must clear the SEPARATION gate for the split to count
   * as held. Applied as a rounded frame count, so a 3-sample rep needs 2 rather than
   * silently needing all 3.
   */
  leapHoldFraction: number
  /**
   * Final share of the flight never sampled for the split. Closing the legs to land on
   * two feet is correct technique, so those frames must not count against the split.
   */
  leapLandingExcludeFraction: number
  /**
   * Entry must hold BOTH this long and this many frames before flight is confirmed.
   * Keep confirmMs at or below (confirmMinFrames - 1) frame periods at the slowest fps
   * you support, or the ms bound silently demands an extra frame: at 30 fps, 3 frames
   * span only 66.7 ms, so a confirmMs of 100 really required 4 — which a genuine 200 ms
   * leap could not always supply.
   */
  confirmMs: number
  confirmMinFrames: number
  /** A confirmed flight shorter than this is noise; longer than max is baseline drift. */
  minAirborneMs: number
  maxAirborneMs: number
  /** Brief losses of hip visibility tolerated before an in-progress flight is dropped. */
  visGraceMs: number
  /** Brief dips below exitRatio are tolerated this long before flight is called over. */
  exitGraceMs: number
  /** How long to keep collecting frames after landing, for the landing-plié metric. */
  landWindowMs: number
  /**
   * Flight also ends when the FEET are back on the floor: the lowest foot point within this
   * many body-scale units of the floor baseline, on `landFloorFrames` consecutive frames, after
   * the flight cleared the floor. The hip test alone could not see a landing that finished
   * higher than the take-off - a calypso entered from a low chaîné in plié and landed standing
   * kept the hips "risen" against the low baseline, ran past maxAirborneMs and was discarded
   * as too long (2 of 10 real calypsos).
   */
  landFloorRatio: number
  landFloorFrames: number
  /** airborneOffFloor: both feet must have cleared the floor by this (body-scale units). */
  vetoFloorClearRatio: number
  /**
   * How much of the time BEFORE take-off is kept for the flight trace. A calypso's front kick
   * and a switch leap's first brush both start while the take-off foot is still on the floor,
   * so the shape of the leap cannot be read from the airborne frames alone.
   */
  preTakeoffMs: number
  /** Refractory period after a rep closes, before another can start. */
  refractoryMs: number
  /** No detection until the baselines and body scale hold this many samples. */
  minWarmupSamples: number
  /** Fraction of flight frames that must have trustworthy ankles, or the rep is dropped. */
  minAnkleVisFraction: number
  /**
   * The leap is critiqued only on a frame whose legs the tracker actually found: thigh and shin
   * each at least this share of the torso long on screen, in the image.
   */
  critiqueMinSegTorso: number
  /** ...and the two feet on opposite sides of the hips, each at least this far out (torsos). */
  critiqueMinSpreadTorso: number
  /**
   * Knees and feet are critiqued only when at least this many readable split frames were
   * captured, and on the straightest reading among them (see finalizeRep).
   */
  critiqueMinJointFrames: number
  /**
   * The back leg is judged on any airborne frame where IT was placed - ankle at least this far
   * (torsos) from the hips, out behind - whatever the front leg looked like on that frame.
   */
  leapBackLegMinTorso: number
  /** The front leg is read within this long (ms) of the back leg's highest frame for the split. */
  leapPeakWindowMs: number
  /** A calypso's back knee at or under this (degrees) is in attitude, for judging the attitude. */
  calypsoAttitudeMaxKneeDeg: number
  /** Straddle frames this wide (degrees, true proportions) or wider describe a russian's top. */
  straddleMinDeg: number
  /**
   * ...and at least this many readable ones, or the straddle is not judged - one frame where the
   * capture is slow (frames straddleSlowGapMs or more apart), since each of those covers as much of
   * the top as two at 30 fps. A russian's top lasts about 150-250 ms: at /live's 15-20 fps a
   * three-frame rule left 9 of 30 reference russians unjudged, and dancers were told "too little of
   * you was visible" with the whole body in frame.
   */
  straddleMinFrames: number
  straddleSlowGapMs: number
  /** A straddle frame is readable with each ankle at least this far from the hips (torsos). */
  straddleMinLegTorso: number
  /** The top of the straddle: its frames within this (degrees) of the widest. */
  straddleTopSlackDeg: number
  /** The direction of travel gives the facing if the hips moved at least this far (torsos)... */
  facingMinTravel: number
  /** ...otherwise the nose ahead of the ears by at least this (torsos, median over the flight). */
  facingMinNoseLead: number
  /**
   * The camera frame's width over its height. Landmarks are normalised separately in x and y,
   * so on a 16:9 frame an angle measured straight off them stretches every vertical offset 1.78
   * times: a 160-degree split read as 145. The critique angles are measured in true screen
   * proportions with this. /live asks the camera for 1280x720.
   */
  aspect: number
  /** Landmark visibility floor. */
  visThresh: number
  /**
   * The visibility the ankles need to open a flight and carry it. Below visThresh on purpose:
   * the far ankle of a side-on leap hovers around 0.5, and the browser's pose runtime read it at
   * 0.44-0.49 through a split leap that the Python fixtures read at 0.50 - the difference
   * between a leap and nothing at all. Where the legs are measured, visThresh still applies.
   */
  ankleGateVis: number
  /** A gap larger than this between frames means tracking was lost: full reset. */
  trackingGapMs: number
}

export const DEFAULT_CONFIG: JumpDetectorConfig = {
  baselineMs: 2000,
  bodyScaleMs: 3000,
  enterRatio: 0.06,          // unchanged from detect_jumps — the ankle gate does the real work
  exitRatio: 0.035,
  ankleRiseRatio: 0.7,
  // ~4 cm on an adult filling the frame. A small sauté clears the floor by well over that;
  // the supporting toe of an arabesque or relevé moves by landmark noise (~1 cm).
  floorClearRatio: 0.03,
  minFloorClearFrames: 2,
  leapSeparationRatio: 0.35,
  leapSeparationRatioWorld: 0.60,
  // Checked on the split frames themselves (straighter knee), not as a median over the flight.
  // Real leaps measured 131-176 there; a tuck, the thing this exists to reject, is far lower.
  leapMinKneeExtDeg: 120,
  // Reference footage: readable split frames had thighs and shins 0.28-0.64 torsos long and the
  // feet 0.53-1.05 torsos either side of the hips; frames the blur had scrambled put a knee at
  // the hip (segments 0.02-0.22) or both feet on one side.
  critiqueMinSegTorso: 0.25,
  critiqueMinSpreadTorso: 0.3,
  critiqueMinJointFrames: 2,
  leapBackLegMinTorso: 0.6,
  leapPeakWindowMs: 70,
  // Reference calypsos: the attitude frames read 99-132; the same back leg extended, 150-180.
  calypsoAttitudeMaxKneeDeg: 140,
  straddleMinDeg: 120,
  straddleMinFrames: 2,
  straddleSlowGapMs: 45,
  // A smeared ankle lands at the hips; a real one, even on a foreshortened leg, is 0.9+ torsos out.
  straddleMinLegTorso: 0.5,
  straddleTopSlackDeg: 20,
  // Reference leaps travelled 0.08-1.74 torsos; every one at 0.3 or more went the way the face
  // pointed. In profile the nose leads the ears by 0.02-0.05 torsos, the same sign all flight.
  facingMinTravel: 0.3,
  facingMinNoseLead: 0.015,
  aspect: 16 / 9,
  // Real footage, lite model, 15 fps: straight jumps never exceeded 34 degrees between the legs
  // on any airborne frame; split leaps peaked at 56-165. The bar sits in that gap.
  leapMinSplitAngleDeg: 45,
  leapMinSplitHoldMs: 50,
  leapMinAnkleRiseFraction: 0.5,
  leapMinAnkleRiseRatio: 0.04,
  leapSampleFraction: 0.6,
  leapSampleMinFrames: 2,
  leapHoldFraction: 0.7,
  leapLandingExcludeFraction: 0.30,
  confirmMs: 60,
  confirmMinFrames: 3,
  minAirborneMs: 150,
  maxAirborneMs: 800,
  visGraceMs: 120,
  exitGraceMs: 70,
  landWindowMs: 350,
  landFloorRatio: 0.02,
  landFloorFrames: 2,
  vetoFloorClearRatio: 0.1,
  preTakeoffMs: 400,
  refractoryMs: 400,
  minWarmupSamples: 15,
  minAnkleVisFraction: 0.6,
  visThresh: 0.5,
  ankleGateVis: 0.4,
  trackingGapMs: 400,
}

/** Which leap gate rejected a rep, or 'none' if it passed them all. */
export type LeapGateFailure =
  | 'none'
  | 'ankles-not-visible'
  | 'too-few-samples'
  | 'separation-median'
  | 'separation-not-held'
  | 'legs-not-split'
  | 'knees-bent'

export interface JumpRepEvent {
  type: 'leap (jeté-type)' | 'jump (sauté-type)'
  splitAngleDeg: number
  metrics: Record<string, number | null>
  takeoffMs: number
  apexMs: number
  /** The frame the leg critique was read from (see finalizeRep), or null if no frame was readable. */
  critiqueMs: number | null
  landingMs: number
  /** Measured flight duration in real milliseconds, not a frame count. */
  airborneMs: number
  peakHipRise: number
  peakAnkleRise: number
  /** Median ankle separation across the sampled window — what decided leap vs jump. */
  separationRatio: number
  /** Which measure produced separationRatio and the joint angles; different scales. */
  separationSource: 'world' | 'image'
  /**
   * Every leap gate this rep was measured against, and which one decided it. Present so
   * a rep that reads wrong can be diagnosed from one log line rather than by guessing
   * which of several conditions rejected it.
   */
  leapGate: {
    failed: LeapGateFailure
    sepMedian: number
    sepThreshold: number
    sepPassing: number
    sepRequired: number
    kneeMedian: number
    kneeThreshold: number
    /** Angle between the legs on the widest airborne frame(s) — what decided leap vs jump. */
    legSplitAngleDeg: number
    /** Airborne frames showing a straight-kneed split, against the number required. */
    splitFrames: number
    splitFramesRequired: number
    /** Straighter knee on the widest frame. */
    peakSplitKneeDeg: number
    legSplitAngleThreshold: number
    /** Flight frames that survived the airborne filter — the pool the sample came from. */
    airborneFrames: number
  }
  /**
   * Capture diagnostics for the machine this actually ran on. Frame timing is the
   * thing most likely to differ between a dev box and a laptop webcam under load, and
   * it is invisible from the outside, so every rep carries its own record of it.
   */
  flightFrames: number
  sampleFrames: number
  frameIntervalMs: { min: number; max: number; mean: number }
  /**
   * The calypso's shape in the air, read across the readable split frames with the legs named by
   * the direction of travel (see finalizeRep). Only for leaps that travelled or faced a side; the
   * calypso critique is built from it (jumpMetrics.calypsoMetrics).
   */
  legShape: LegShape | null
  /**
   * The straddle as a russian is judged on it, read front-on in true screen proportions (see
   * finalizeRep). Null when the top of the straddle was not seen clearly. jumpMetrics.russianMetrics.
   */
  straddle: Straddle | null
  /**
   * Frame-by-frame shape of the legs from shortly before take-off to landing — what tells the
   * kinds of leap apart (see jumpType.ts). Present for every rep, leap or not.
   */
  trace: FlightSample[]
  /** Peak hip rise in image torso lengths, and horizontal hip travel over the flight. */
  riseTorso: number
  travelTorso: number
}

export interface FlightSample {
  tMs: number
  /** 'pre' = before take-off, 'air' = flight, 'post' = landing window. */
  phase: 'pre' | 'air' | 'post'
  /** Angle between the two legs (hip to ankle), in world and image coordinates, degrees. */
  legAngleWorld: number
  legAngleImage: number
  /** Each leg raised from hanging straight down (world, up = -y), degrees. */
  elevL: number
  elevR: number
  /** The same in the image plane - exact for a leg spread across the picture (a russian). */
  elevImgL: number
  elevImgR: number
  /** Knee angles, 3-D (MediaPipe's world landmarks), degrees: 180 straight. */
  kneeL: number
  kneeR: number
  /** The same on screen, in true proportions: right where the 3-D reading under-reads a straight leg. */
  kneeImgL: number
  kneeImgR: number
  /** Torso pitched off vertical (world, up = -y), degrees. */
  leanDeg: number
  /**
   * How much of the ankle separation lies along the hip line, 0..1. A straddle (legs to the
   * sides) reads near 1; a split (one leg in front, one behind) much lower.
   */
  latHip: number
  /** Each leg's horizontal direction along the hip line (+ toward the right hip). */
  latL: number
  latR: number
  /** Shoulder width over torso length in the image: ~0.35+ facing the camera, ~0.1 side-on. */
  facing: number
  /** Hip-mid image x, in image torso lengths. */
  hipXT: number
  /** Lowest foot above the floor baseline, image torso lengths (NaN if unreadable). */
  floor: number
  /** The LOWER wrist above the nose, image torso lengths: positive when both arms are overhead. */
  wristsAboveNose: number
  /** The nose above the ears, image torso lengths: positive when the face tips up (the head back). */
  faceUp: number
  /** The nose off the midpoint of the ears, in ear-widths: ~0 facing the camera, 0.3+ turned away. */
  headYaw: number
}

/** A straddle at the top of a jump, front-on: how wide, how high, how even. */
export interface Straddle {
  /** Angle between the legs at the hips, degrees (180 = a full straddle). */
  widthDeg: number
  /** The two legs' mean height, raised from hanging straight down, degrees (90 = hip height). */
  heightDeg: number
  /** How far one leg sat above the other at the top of the straddle, degrees (typical). */
  unevenDeg: number
}

/** A calypso's shape in the air, from the readable split frames (see finalizeRep). */
export interface LegShape {
  /** The front leg: the one on the side the leap travelled. */
  frontLeg: 'L' | 'R'
  /** Front knee at its straightest, 180 straight. NaN: not seen on enough frames. */
  frontKneeDeg: number
  /** The attitude's knee, typically, on the frames it was bent. NaN: no attitude seen. */
  backKneeDeg: number
  /** Front leg (hip to ankle) at its highest, raised from hanging straight down, degrees. */
  frontLegDeg: number
  /** Back THIGH (hip to knee) at its highest, raised from hanging straight down, degrees. */
  backThighDeg: number
  /** Back knee above back ankle over shin length, at best while in attitude. Positive = knee higher than foot. NaN: no attitude seen. */
  backKneeLift: number
  /** The torso's furthest lean toward the back leg, degrees. Positive = the arch, negative = pitched forward. */
  archDeg: number
}

export type Phase = 'warmup' | 'idle' | 'candidate' | 'airborne' | 'landingTail' | 'refractory'

/** Why the most recent above-threshold hip rise did NOT become a rep. Dev readout only. */
export type RejectReason =
  | null
  | 'ankles-planted'
  | 'feet-on-floor'
  | 'ankles-not-visible'
  | 'hips-not-visible'
  | 'too-short'
  | 'too-long'
  | 'unconfirmed'
  | 'warming-up'
  | 'refractory'
  | 'tracking-lost'

export interface JumpDebugState {
  phase: Phase
  hipRise: number
  ankleRise: number
  /** Lowest foot point above its floor baseline — the floor gate's input. NaN if unreadable. */
  floorRise: number
  ankleRatio: number
  enterThreshold: number
  exitThreshold: number
  bodyScale: number
  anklesVisible: boolean
  hipsVisible: boolean
  lastReject: RejectReason
  candidateFrames: number
  flightFrames: number
  reps: number
}

interface FrameSnapshot {
  lm: NormalizedLandmark[]
  tMs: number
  hipRise: number
  ankleRise: number
  /** Lowest visible foot point above the floor baseline; NaN when a foot is unreadable. */
  floorRise: number
  /** Both ankles at visThresh: trusted for measuring the legs. */
  ankleVisible: boolean
  /** Both ankles at ankleGateVis: enough to open and carry a flight. */
  ankleUsable: boolean
  world?: Landmark[]
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function pt(lm: NormalizedLandmark[], id: number): Point {
  return { x: lm[id].x, y: lm[id].y }
}

export class JumpRepDetector {
  private readonly cfg: JumpDetectorConfig
  private readonly hipBaseline: TimedRollingBaseline
  private readonly ankleBaseline: TimedRollingBaseline
  private readonly floorBaseline: TimedRollingBaseline
  private readonly bodyScale: TimedRunningBodyScale

  private phase: Phase = 'warmup'
  private candidateBuffer: FrameSnapshot[] = []
  /** Every recent frame, for the pre-take-off part of the flight trace. */
  private recentFrames: FrameSnapshot[] = []
  private preTakeoff: FrameSnapshot[] = []
  private floorLandRun = 0
  private flightBuffer: FrameSnapshot[] = []
  private landingWindow: FrameSnapshot[] = []
  private landingStartMs = 0
  private refractoryUntilMs = 0
  private graceStartMs: number | null = null
  private lastFrameMs: number | null = null
  private visLostAtMs: number | null = null
  private repCount = 0

  // Dev readout only.
  private dbgHipRise = 0
  private dbgAnkleRise = 0
  private dbgFloorRise = NaN
  private dbgEnter = 0
  private dbgExit = 0
  private dbgAnklesVisible = false
  private dbgHipsVisible = false
  private dbgReject: RejectReason = 'warming-up'

  constructor(config: Partial<JumpDetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
    this.hipBaseline = new TimedRollingBaseline(this.cfg.baselineMs)
    this.ankleBaseline = new TimedRollingBaseline(this.cfg.baselineMs)
    this.floorBaseline = new TimedRollingBaseline(this.cfg.baselineMs)
    this.bodyScale = new TimedRunningBodyScale(this.cfg.bodyScaleMs)
  }

  private vis(lm: NormalizedLandmark[], ...ids: number[]): boolean {
    return this.visAt(this.cfg.visThresh, lm, ...ids)
  }

  private visAt(floor: number, lm: NormalizedLandmark[], ...ids: number[]): boolean {
    return ids.every((id) => (lm[id]?.visibility ?? 0) >= floor)
  }

  /**
   * Angle at joint `b` between `a` and `c`, measured in 3-D when world landmarks are
   * available and in the image plane otherwise.
   *
   * The image plane cannot be trusted for a limb pointing at the camera, which on this
   * page is the common case: /live faces the dancer, and a jeté sends both legs fore and
   * aft. Measured on a perfectly straight leg, the image angle decays from 176 degrees
   * (leg hanging down) to 129 degrees (leg almost at the lens) purely from the
   * projection collapsing, while the 3-D angle holds 175-176 degrees throughout. That
   * decay was rejecting confirmed-straight legs at the 140-degree gate and, through the
   * same call, telling dancers to straighten legs that were already straight.
   */
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

  /**
   * The straighter of the image and 3-D readings of the angle at `b`. In flight a smeared leg
   * pulls the knee and toe landmarks off the line of the limb in one source or the other - on
   * the reference leaps they disagreed by 20-30 degrees on the same straight leg, each
   * under-reading a different leg - and blur only ever makes a straight line read bent, so the
   * straighter reading is the honest one.
   */
  private bestJointAngle(lm: NormalizedLandmark[], world: Landmark[] | undefined, b: number, a: number, c: number): number {
    const vals: number[] = []
    if (world && world.length > Math.max(a, b, c)) vals.push(angleAt3(world[b], world[a], world[c]))
    if (this.vis(lm, a, b, c)) vals.push(angleAt(pt(lm, b), pt(lm, a), pt(lm, c)))
    const ok = vals.filter(Number.isFinite)
    return ok.length ? Math.max(...ok) : NaN
  }

  /**
   * Drop all detection state AND the rolling windows. Call on tracking loss, on
   * stop/start, or any time frame continuity breaks — a baseline that bridges a gap is
   * comparing the hips now against wherever the dancer was before they left frame.
   */
  reset(): void {
    this.hipBaseline.reset()
    this.ankleBaseline.reset()
    this.floorBaseline.reset()
    this.bodyScale.reset()
    this.phase = 'warmup'
    this.candidateBuffer = []
    this.recentFrames = []
    this.preTakeoff = []
    this.floorLandRun = 0
    this.flightBuffer = []
    this.landingWindow = []
    this.graceStartMs = null
    this.lastFrameMs = null
    this.visLostAtMs = null
    this.refractoryUntilMs = 0
    this.dbgReject = 'tracking-lost'
  }

  /** Abandon an in-progress detection but keep the rolling windows (momentary dropout). */
  private abortFlight(reason: RejectReason): void {
    this.candidateBuffer = []
    this.flightBuffer = []
    this.landingWindow = []
    this.graceStartMs = null
    this.phase = 'idle'
    this.dbgReject = reason
  }

  /**
   * True once a flight is under way AND the feet have actually left the floor. The candidate
   * phase alone is not a flight: lifting a leg raises the hips and the ankle midpoint the same
   * way, which is why other detectors must not be vetoed by it.
   */
  get airborneOffFloor(): boolean {
    if (this.phase !== 'airborne' && this.phase !== 'landingTail') return false
    // A clear bar, well above floorClearRatio: the floor baseline lags a dancer who has just
    // stepped, by up to ~0.2 torso lengths on real footage, and a standing arabesque must not
    // read as a flight because of it.
    // Two frames, not one: rising into an arabesque on relevé can throw a single frame of the
    // lowest foot over the bar (measured on real arabesques), a flight keeps both feet up.
    const bar = this.cfg.vetoFloorClearRatio * this.bodyScale.value
    return this.flightBuffer.filter((f) => f.floorRise >= bar).length >= 2
  }

  get debug(): JumpDebugState {
    const hip = this.dbgHipRise
    return {
      phase: this.phase,
      hipRise: hip,
      ankleRise: this.dbgAnkleRise,
      floorRise: this.dbgFloorRise,
      ankleRatio: Math.abs(hip) > 1e-9 ? this.dbgAnkleRise / hip : 0,
      enterThreshold: this.dbgEnter,
      exitThreshold: this.dbgExit,
      bodyScale: this.bodyScale.value,
      anklesVisible: this.dbgAnklesVisible,
      hipsVisible: this.dbgHipsVisible,
      lastReject: this.dbgReject,
      candidateFrames: this.candidateBuffer.length,
      flightFrames: this.flightBuffer.length,
      reps: this.repCount,
    }
  }

  /** Feed one detected frame. Returns a completed rep event, or null if none closed yet. */
  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): JumpRepEvent | null {
    // Frame continuity. A gap means the dancer left, the tab was backgrounded, or detection
    // stalled; the windows either side of it are not comparable.
    if (this.lastFrameMs !== null && tMs - this.lastFrameMs > this.cfg.trackingGapMs) {
      this.reset()
    }
    this.lastFrameMs = tMs

    // Visibility gate on the CORE signal. Previously the hips were the only landmarks read
    // without one: every metric was gated but the value driving detection was not, so
    // MediaPipe's extrapolated hips for a half-cropped body fed straight into the baseline
    // and a rep fired as the estimate snapped onto the real body.
    const hipsVisible = this.vis(lm, L_HIP, R_HIP)
    const anklesVisible = this.vis(lm, L_ANKLE, R_ANKLE)
    const anklesUsable = this.visAt(this.cfg.ankleGateVis, lm, L_ANKLE, R_ANKLE)
    this.dbgHipsVisible = hipsVisible
    this.dbgAnklesVisible = anklesVisible

    if (!hipsVisible) {
      // A brief dip in hip confidence is normal under motion blur, and it happens most
      // during the fastest part of a jump. Aborting on the first bad frame threw the
      // whole rep away: measured, a single low-visibility frame late in flight took a
      // clean five-jump sequence from 5 detections to 0. Tolerate a short dropout the
      // same way a sub-threshold dip is tolerated, and only abort if it persists.
      if (this.phase === 'candidate' || this.phase === 'airborne' || this.phase === 'landingTail') {
        if (this.visLostAtMs === null) this.visLostAtMs = tMs
        if (tMs - this.visLostAtMs > this.cfg.visGraceMs) this.abortFlight('hips-not-visible')
      }
      this.dbgReject = 'hips-not-visible'
      return null
    }
    this.visLostAtMs = null

    const hipMidY = (lm[L_HIP].y + lm[R_HIP].y) / 2
    const hipBase = this.hipBaseline.push(hipMidY, tMs)

    // The ankle baseline only accepts trustworthy ankles, so it stays a clean reference
    // across frames where the feet are momentarily lost.
    let ankleBase = NaN
    let ankleMidY = NaN
    if (anklesUsable) {
      ankleMidY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2
      // Only well-seen ankles feed the reference itself.
      ankleBase = anklesVisible ? this.ankleBaseline.push(ankleMidY, tMs) : this.ankleBaseline.value
    }

    if (this.vis(lm, L_SHOULDER, R_SHOULDER, L_ANKLE, R_ANKLE)) {
      const shoulderMid = { x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 }
      const ankleMid = { x: (lm[L_ANKLE].x + lm[R_ANKLE].x) / 2, y: (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2 }
      this.bodyScale.push(shoulderMid, ankleMid, tMs)
    }

    // Where the floor is: the lowest point of the feet, as a trailing median. Only frames
    // where both feet are readable feed it, for the same reason as the ankle baseline.
    const lowestY = lowestFootY(lm, this.cfg.visThresh)
    const floorBase = Number.isFinite(lowestY) ? this.floorBaseline.push(lowestY, tMs) : this.floorBaseline.value
    const floorRise = Number.isFinite(lowestY) && Number.isFinite(floorBase) ? floorBase - lowestY : NaN
    this.dbgFloorRise = floorRise

    // Warm-up. No detection until there is enough history for the medians to mean anything;
    // the first second of a session used to detect reps off a 1–5 sample buffer.
    const warm = this.cfg.minWarmupSamples
    if (!this.bodyScale.ready(warm) || !this.hipBaseline.ready(warm)) {
      this.phase = 'warmup'
      this.dbgReject = 'warming-up'
      return null
    }
    if (this.phase === 'warmup') this.phase = 'idle'

    const scale = this.bodyScale.value
    const enterThreshold = this.cfg.enterRatio * scale
    const exitThreshold = this.cfg.exitRatio * scale
    const hipRise = hipBase - hipMidY
    const ankleRise = anklesUsable && Number.isFinite(ankleBase) ? ankleBase - ankleMidY : 0

    this.dbgHipRise = hipRise
    this.dbgAnkleRise = ankleRise
    this.dbgEnter = enterThreshold
    this.dbgExit = exitThreshold

    const frame: FrameSnapshot = { lm, tMs, hipRise, ankleRise, floorRise, ankleVisible: anklesVisible, ankleUsable: anklesUsable, world }
    this.recentFrames.push(frame)
    while (this.recentFrames.length && this.recentFrames[0].tMs < tMs - this.cfg.preTakeoffMs - 400) {
      this.recentFrames.shift()
    }

    // THE ANKLE GATE. In a leap the body translates: ankles rise with the hips. Standing up,
    // rising out of a plié or straightening a slouch moves the hips while the feet stay
    // planted, so ankleRise stays near zero and the ratio collapses.
    const ankleGateOk = anklesUsable && ankleRise >= this.cfg.ankleRiseRatio * hipRise

    // Refractory. Stops a landing rebound, or the recovery out of a landing plié, from
    // opening a second rep on the frame after one closed.
    if (this.phase === 'refractory') {
      if (tMs < this.refractoryUntilMs) {
        this.dbgReject = 'refractory'
        return null
      }
      this.phase = 'idle'
    }

    switch (this.phase) {
      case 'idle': {
        if (hipRise <= enterThreshold) {
          this.dbgReject = null
          return null
        }
        if (!anklesUsable) {
          this.dbgReject = 'ankles-not-visible'
          return null
        }
        if (!ankleGateOk) {
          this.dbgReject = 'ankles-planted'
          return null
        }
        this.phase = 'candidate'
        this.candidateBuffer = [frame]
        this.preTakeoff = this.recentFrames.filter((f) => f.tMs < tMs && f.tMs >= tMs - this.cfg.preTakeoffMs)
        this.floorLandRun = 0
        this.dbgReject = 'unconfirmed'
        return null
      }

      case 'candidate': {
        // Multi-frame confirmation: the rise AND the ankle gate must hold continuously.
        // One noisy spike can no longer open a flight.
        if (hipRise <= enterThreshold || !ankleGateOk) {
          this.abortFlight(ankleGateOk ? 'unconfirmed' : 'ankles-planted')
          return null
        }
        this.candidateBuffer.push(frame)
        const held = tMs - this.candidateBuffer[0].tMs
        if (held + T_EPS >= this.cfg.confirmMs && this.candidateBuffer.length >= this.cfg.confirmMinFrames) {
          this.phase = 'airborne'
          this.flightBuffer = this.candidateBuffer
          this.candidateBuffer = []
          this.graceStartMs = null
          this.dbgReject = null
        }
        return null
      }

      case 'airborne': {
        const takeoffMs = this.flightBuffer[0].tMs
        if (tMs - takeoffMs > this.cfg.maxAirborneMs) {
          // Nobody is airborne for over a second — this is baseline drift, not flight.
          this.abortFlight('too-long')
          this.enterRefractory(tMs)
          return null
        }
        // Feet back on the floor after the flight had cleared it: landed, whatever the hips say.
        const floorScale = this.bodyScale.value
        // Its own positive bar, independent of floorClearRatio: a flight that never really left
        // the floor has no landing to detect.
        const clearBar = Math.max(this.cfg.floorClearRatio, 2 * this.cfg.landFloorRatio) * floorScale
        const clearedFloor = this.flightBuffer.some((f) => f.floorRise >= clearBar)
        if (clearedFloor && Number.isFinite(floorRise) && floorRise <= this.cfg.landFloorRatio * floorScale) {
          this.floorLandRun++
          if (this.floorLandRun >= this.cfg.landFloorFrames) {
            this.flightBuffer.push(frame)
            return this.closeFlight(frame, true)
          }
        } else {
          this.floorLandRun = 0
        }
        if (hipRise > exitThreshold) {
          this.flightBuffer.push(frame)
          this.graceStartMs = null
          return null
        }
        // Below the exit threshold. Hysteresis plus a short grace window: a single noisy
        // frame no longer terminates the flight and splits one leap into two events.
        if (this.graceStartMs === null) this.graceStartMs = tMs
        if (tMs - this.graceStartMs <= this.cfg.exitGraceMs) {
          this.flightBuffer.push(frame)
          return null
        }
        return this.closeFlight(frame)
      }

      case 'landingTail': {
        this.landingWindow.push(frame)
        if (tMs - this.landingStartMs + T_EPS >= this.cfg.landWindowMs) return this.finalizeRep()
        return null
      }

      default:
        return null
    }
  }

  /** Flight ended at the last above-threshold frame; decide whether it was a real rep. */
  private closeFlight(landingFrame: FrameSnapshot, landedOnFloor = false): JumpRepEvent | null {
    // Trim the grace-window tail back to the last frame genuinely above the exit threshold -
    // or, for a floor landing, back to the last frame the feet were still off the floor.
    const exitThreshold = this.dbgExit
    const landFloor = this.cfg.landFloorRatio * this.bodyScale.value
    let last = this.flightBuffer.length - 1
    if (landedOnFloor) {
      while (last > 0 && !(this.flightBuffer[last].floorRise > landFloor)) last--
    } else {
      while (last > 0 && this.flightBuffer[last].hipRise <= exitThreshold) last--
    }
    const flight = this.flightBuffer.slice(0, last + 1)

    const airborneMs = flight.length > 1 ? flight[flight.length - 1].tMs - flight[0].tMs : 0
    if (airborneMs + T_EPS < this.cfg.minAirborneMs) {
      this.abortFlight('too-short')
      this.enterRefractory(landingFrame.tMs)
      return null
    }

    const visFrac = flight.filter((f) => f.ankleUsable).length / flight.length
    if (visFrac < this.cfg.minAnkleVisFraction) {
      // Can't trust the ankles across the flight, so can't trust that it was a leap.
      this.abortFlight('ankles-not-visible')
      this.enterRefractory(landingFrame.tMs)
      return null
    }

    // The floor gate (see floorClearRatio). Nothing left the floor, so this was not a jump
    // of any kind — not a leap and not a sauté — and there is nothing to count or critique.
    const floorThreshold = this.cfg.floorClearRatio * this.bodyScale.value
    const offFloor = flight.filter((f) => f.floorRise >= floorThreshold).length
    if (offFloor < this.cfg.minFloorClearFrames) {
      this.abortFlight('feet-on-floor')
      this.enterRefractory(landingFrame.tMs)
      return null
    }

    this.flightBuffer = flight
    this.phase = 'landingTail'
    this.landingStartMs = landingFrame.tMs
    // land_plie's window starts at the last airborne frame (Python's landing_frame).
    this.landingWindow = [flight[flight.length - 1], landingFrame]
    return null
  }

  private enterRefractory(tMs: number): void {
    this.phase = 'refractory'
    this.refractoryUntilMs = tMs + this.cfg.refractoryMs
    this.candidateBuffer = []
    this.flightBuffer = []
    this.landingWindow = []
    this.graceStartMs = null
  }

  private finalizeRep(): JumpRepEvent {
    const flight = this.flightBuffer
    const landingWindow = this.landingWindow
    this.repCount++
    this.dbgReject = null
    const lastT = landingWindow.length ? landingWindow[landingWindow.length - 1].tMs : flight[flight.length - 1].tMs

    // Apex = frame of maximum hip rise within the flight segment.
    let apexIdx = 0
    for (let i = 1; i < flight.length; i++) {
      if (flight[i].hipRise > flight[apexIdx].hipRise) apexIdx = i
    }
    const apex = flight[apexIdx]
    const takeoff = flight[0]
    const landing = flight[flight.length - 1]

    const apexLm = apex.lm
    const torsoOf = (lm: NormalizedLandmark[]) =>
      Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
        (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2) || 1e-6
    const hipXOf = (lm: NormalizedLandmark[]) => (lm[L_HIP].x + lm[R_HIP].x) / 2

    // ---- Leap vs jump ----------------------------------------------------------
    // A straight jump with the legs together is never a leap, at any height. Deciding
    // that from ONE apex frame made it a coin toss whenever a landmark blipped, so the
    // test runs over a window of frames around the apex and the split has to HOLD.
    //
    // Two independent conditions must both be true on each sampled frame:
    //
    //  - Horizontal ankle separation over body scale. Horizontal only: the full 2-D
    //    distance scaled with jump height, because a higher jump is tucked harder, no
    //    tuck is symmetric, and that VERTICAL ankle offset fed straight into a measure
    //    that is supposed to mean "how far apart are the legs" (measured: closed-leg
    //    jumps climbing 0.144 -> 0.219 with height while the horizontal gap stayed at
    //    hip width). A split is a fore/aft opening, so only the horizontal term counts.
    //
    //  - Both knees extended. A bent knee swings an ankle sideways in frame without the
    //    legs parting at all, so a tuck must not be able to fake a split on its own.
    //
    // This is a frontal-plane measure, so a split aimed straight at the camera still
    // reads as a jump — the accepted limit of 2-D landmarks here.
    const scale = this.bodyScale.value
    const anklesTrustworthy = this.vis(apexLm, L_ANKLE, R_ANKLE)
    const hipMid2d = { x: (apexLm[L_HIP].x + apexLm[R_HIP].x) / 2, y: (apexLm[L_HIP].y + apexLm[R_HIP].y) / 2 }
    let splitAngle = anklesTrustworthy
      ? angleAt(hipMid2d, pt(apexLm, L_ANKLE), pt(apexLm, R_ANKLE))
      : 0
    if (Number.isNaN(splitAngle)) splitAngle = 0

    // The split is a property of the APEX, not of the whole flight. A dancer closes the
    // legs on the way down to land on two feet — that is correct technique, not a failed
    // split — so the run-up to landing is excluded before anything is sampled. Sampling
    // it meant every rep, good or bad, was partly judged on frames that are supposed to
    // show the legs together.
    const scaleUsable = Number.isFinite(scale) && scale > 1e-9

    // Measure the split in WORLD coordinates when they are available.
    //
    // /live requests facingMode:'user', so the dancer faces the lens — and a jeté splits
    // the legs fore and aft, which from directly in front is almost entirely DEPTH. The
    // image-plane measure sees the ankles stay at about hip width and calls a real leap a
    // jump. It only worked when the dancer happened to travel across frame rather than
    // toward the camera, which is why leaps read as jumps with occasional successes.
    //
    // Ankle separation across the horizontal plane (x,z) is blind to that orientation:
    // a split reads the same whether it is aimed across the frame or at the camera.
    // Normalised by leg length, which is the natural scale for how far ankles can part.
    const worldUsable = flight.every((f) => f.world && f.world.length > R_ANKLE)
    const sepThreshold = worldUsable
      ? this.cfg.leapSeparationRatioWorld
      : this.cfg.leapSeparationRatio

    // Leg length is the SUM OF THE SEGMENTS (hip->knee->ankle), not the hip-to-ankle
    // distance, because the latter is a function of the knee angle and this is a divisor.
    // Bending a knee to 90 degrees pulls the hip and ankle from 0.84 m apart to 0.59 m —
    // a 1.4x inflation of every separation measured in that pose, for legs that never
    // moved apart. That is the hole a deep plié falls through: the ankles sit at stance
    // width, the divisor collapses, and hip-width feet measure like a split. The segment
    // sum is the dancer's actual leg length and does not move when the knee folds.
    const legLenOf = (w: Landmark[]): number => {
      const seg = (a: number, b: number) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z)
      return (
        seg(L_HIP, L_KNEE) + seg(L_KNEE, L_ANKLE) + seg(R_HIP, R_KNEE) + seg(R_KNEE, R_ANKLE)
      ) / 2
    }

    const imageSepOf = (f: FrameSnapshot): number =>
      scaleUsable && this.vis(f.lm, L_ANKLE, R_ANKLE)
        ? Math.abs(f.lm[L_ANKLE].x - f.lm[R_ANKLE].x) / scale
        : 0

    const sepOf = (f: FrameSnapshot): number => {
      if (worldUsable && f.world) {
        const w = f.world
        const legLen = legLenOf(w)
        if (legLen > 1e-6) {
          return Math.hypot(w[L_ANKLE].x - w[R_ANKLE].x, w[L_ANKLE].z - w[R_ANKLE].z) / legLen
        }
      }
      return imageSepOf(f)
    }

    // WORLD AND IMAGE EACH GET A VOTE. World landmarks are the only view of a split aimed at
    // the lens, but their depth axis is MediaPipe's least accurate one, and it compresses: a
    // real jeté travelling ACROSS the frame — the way most leaps are actually filmed — can
    // read short of the world bar while the image plane, which is where the camera is most
    // precise, shows the split plainly. Requiring the world view alone turned those leaps
    // into jumps. Each source is scored against its OWN bar and the better one counts; the
    // shape and knee gates below still apply, so this widens what a split may look like,
    // not what may be called one.
    const sepScoreOf = (f: FrameSnapshot): number => {
      const primary = sepOf(f) / sepThreshold
      return worldUsable ? Math.max(primary, imageSepOf(f) / this.cfg.leapSeparationRatio) : primary
    }

    // ---- The SHAPE of the opening, independently of how wide it measured ----------
    //
    // Separation is a distance, and every way of normalising a distance can be gamed by
    // something that is not a split: a bent knee shortens the divisor, a wide stance widens
    // the numerator, MediaPipe's depth estimate is noisy in exactly the axis a jeté opens
    // along. So width alone decides nothing. The second measure is the ANGLE BETWEEN THE
    // TWO LEGS — the 3-D angle between the hip->ankle vectors — which is the classical
    // definition of a split and is a pure direction, so no amount of knee folding, stance
    // width or leg-length error can manufacture it.
    //
    // Measured across this repo's fixtures: legs together in a deep plié 7 deg, a tuck with
    // both ankles swung half a metre forward 6 deg, a deep plié in a wide second 22 deg, a
    // lateral straddle 49 deg, a medium jeté 54 deg, a full jeté 70 deg, an asymmetric jeté
    // whose back leg trails almost straight down 52-62 deg. Non-splits top out at 22 and
    // splits start at 49, so the bar sits in a gap nothing occupies.
    //
    // That wide second is the case that makes this gate load-bearing rather than belt-and-
    // braces: it measures 0.61 separation against a 0.60 bar, so width alone calls a
    // straight jump a split, and only the 22-vs-35 degree opening rejects it.
    //
    // Why the inter-leg ANGLE and not each leg's swing off vertical:
    //
    //  - It is forgiving of an ASYMMETRIC split, which most real ones are. A jeté whose
    //    front leg reaches 60 deg while the back leg trails almost straight down is still a
    //    60 deg opening. Requiring each leg separately to clear a bar rejects that rep, and
    //    a trailing back leg is the single most common way a real leap is uneven.
    //
    //  - It already encodes direction, so it needs no separate opposition test. Two legs
    //    swung the SAME way — a tuck, a passé, a stag — have a small angle between them
    //    however far they travelled, because the angle is between the legs and not between
    //    each leg and the floor.
    //
    // Measured per leg from its OWN hip, so hip width does not read as an opening.
    const splitAngleOf = (f: FrameSnapshot, source: 'world' | 'image' = 'world'): number => {
      const legOf = (hip: number, ankle: number): { x: number; y: number; z: number } | null => {
        if (source === 'world' && worldUsable && f.world) {
          const w = f.world
          return {
            x: w[ankle].x - w[hip].x,
            y: w[ankle].y - w[hip].y,
            z: w[ankle].z - w[hip].z,
          }
        }
        if (!this.vis(f.lm, hip, ankle)) return null
        // Image fallback: depth is gone, so a split aimed at the lens reads as no opening
        // at all. The same blind spot the image-plane separation has, and the reason world
        // landmarks are preferred everywhere in this function.
        return { x: f.lm[ankle].x - f.lm[hip].x, y: f.lm[ankle].y - f.lm[hip].y, z: 0 }
      }
      const l = legOf(L_HIP, L_ANKLE)
      const r = legOf(R_HIP, R_ANKLE)
      if (!l || !r) return 0
      const nl = Math.hypot(l.x, l.y, l.z)
      const nr = Math.hypot(r.x, r.y, r.z)
      if (nl < 1e-9 || nr < 1e-9) return 0
      const cos = (l.x * r.x + l.y * r.y + l.z * r.z) / (nl * nr)
      return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
    }

    // Sampling is proportional to the flight, and keyed off REAL elapsed time.
    //
    // Two earlier versions of this got the unit wrong. A fixed ±ms window became a
    // frame-count problem at low capture rates (a 280 ms leap is 17 frames at 60 fps but
    // 3 at 12 fps). Slicing by frame INDEX then fixed that but silently assumed frames
    // arrive evenly spaced — under a webcam that stalls when MediaPipe is under load,
    // dropping "the last 30% of frames" is not dropping the last 30% of the flight.
    // Both bounds below are therefore fractions of the measured flight duration, with
    // frame-count floors only so a very short flight still has something to look at.
    const flightStart = flight[0].tMs
    const flightEnd = flight[flight.length - 1].tMs
    const flightDur = flightEnd - flightStart
    const landingCutoff = flightEnd - this.cfg.leapLandingExcludeFraction * flightDur
    let eligible = flight.filter((f) => f.tMs <= landingCutoff + T_EPS)
    if (eligible.length < this.cfg.leapSampleMinFrames) {
      eligible = flight.slice(0, Math.max(this.cfg.leapSampleMinFrames, 1))
    }

    // THE PLIÉ GATE. Only frames where the FEET are genuinely off the floor may vote on
    // whether the legs were split.
    //
    // This is the fix for the reported bug: a straight jump taken off from, or landed
    // into, a deep plié classified as a split roughly half the time. The ankle gate that
    // opens a flight is evaluated on the ENTRY frames only, so the flight buffer still
    // collects the tail of the push-off — where a dancer rolling through a deep plié has
    // the heels up (which MOVES the ankle landmark, so the entry gate is satisfied) with
    // the knees still folded and the feet at stance width — and the front of the landing
    // fold. Those are the worst frames in the rep to measure a split on: the legs are
    // short, the feet are apart, and nothing is in the air.
    //
    // Worse, the anchor below deliberately seeks the WIDEST frame, so it sought out
    // exactly those frames. A deeper plié makes them shorter-legged and wider, which is
    // why the misclassification tracked plié depth rather than anything about the split.
    //
    // Relative to the flight's own peak so it scales with jump height, with an absolute
    // floor so a flight whose peak ankle rise is itself near nothing (a heel raise, not a
    // jump) has no airborne frames at all rather than every frame clearing half of almost
    // nothing. The floor sits below the entry bar (ankleRiseRatio * enterRatio = 0.042 of
    // body scale), so it cannot reject frames from a rep that legitimately took off.
    //
    // Measured on the LOWEST point of the feet rather than the ankle midpoint. The midpoint
    // rises whenever one leg lifts, so a frame with the trailing foot still on the floor and
    // the other leg swinging up counted as airborne — exactly the frames where the legs look
    // most split and nothing is in the air.
    let peakEligibleFloorRise = 0
    for (const f of eligible) if (f.floorRise > peakEligibleFloorRise) peakEligibleFloorRise = f.floorRise
    const airborneFloor = Math.max(
      this.cfg.leapMinAnkleRiseFraction * peakEligibleFloorRise,
      scaleUsable ? this.cfg.leapMinAnkleRiseRatio * scale : 0,
    )
    // Which leap it was is read with the flight's own ankle bar (ankleGateVis); how well it was
    // done, further down, only off ankles at visThresh.
    const airborne = eligible.filter((f) => f.ankleUsable && f.floorRise >= airborneFloor)
    const feetAirborne = airborne.length >= this.cfg.leapSampleMinFrames
    if (feetAirborne) eligible = airborne

    // Anchor on the widest point of the SPLIT, not on the hip apex.
    //
    // The hip apex is the top of the trajectory, which is not reliably where the legs are
    // widest — a dancer can reach full split before or after peak height, and when the
    // scissor starts closing before the apex, no window centred on the apex can avoid the
    // closing phase at all. Since the question this gate asks is "was a split ever held",
    // the honest anchor is the widest separation inside the flight.
    //
    // This does not weaken the test: the sample still has to hold across
    // leapHoldFraction of its frames, so a single wide frame cannot carry it, and legs
    // that are never apart have no wide point to find.
    let anchor = eligible[0]
    let anchorSep = sepScoreOf(anchor)
    for (const f of eligible) {
      const s = sepScoreOf(f)
      if (s > anchorSep) { anchor = f; anchorSep = s }
    }
    const anchorT = anchor.tMs

    // A time window around the anchor, sized as a share of the measured flight — so a
    // stall mid-flight widens nothing and a burst of fast frames narrows nothing.
    const halfWindowMs = Math.max((this.cfg.leapSampleFraction * flightDur) / 2, 1)
    let samples = eligible.filter((f) => Math.abs(f.tMs - anchorT) <= halfWindowMs + T_EPS)
    if (samples.length < this.cfg.leapSampleMinFrames) {
      // Too few frames landed inside the window (a stall straddling the anchor): fall
      // back to the nearest few in time rather than refusing to classify.
      samples = [...eligible]
        .sort((a, b) => Math.abs(a.tMs - anchorT) - Math.abs(b.tMs - anchorT))
        .slice(0, Math.min(this.cfg.leapSampleMinFrames, eligible.length))
    }
    /**
     * The STRAIGHTER of the two knees on this frame, or NaN if neither is readable.
     *
     * Deliberately the better leg, not the worse. This gate only asks "is this a split
     * rather than a tuck", and a tuck folds BOTH knees — so one fully extended leg
     * settles the question. Taking the worse knee meant the back leg decided it, and the
     * back leg is the one dancers most often carry slightly bent in a jeté: reps logged
     * at knee 115, 135 and 140 against a 140 bar were real, wide splits (separation
     * 1.43-1.80 against a 0.60 bar) rejected on a back-leg bend of 40-60 degrees.
     *
     * How straight each leg actually was is not lost — it is measured per leg as
     * front_leg_ext / back_leg_ext and cued through straighten_back_leg, which is where
     * that belongs. Classification and technique quality are separate questions.
     */
    const straightestKneeOf = (f: FrameSnapshot): number => {
      const l = this.jointAngle(f.lm, f.world, L_KNEE, L_HIP, L_ANKLE)
      const r = this.jointAngle(f.lm, f.world, R_KNEE, R_HIP, R_ANKLE)
      const vals = [l, r].filter((v) => Number.isFinite(v))
      return vals.length ? Math.max(...vals) : NaN
    }

    const seps = samples.map(sepOf)
    // Median, not the apex value: one blown frame cannot move it. Reported in the primary
    // source's units; the gate itself reads the both-sources score (see sepScoreOf).
    const separationRatio = median(seps)
    const separationScore = median(samples.map(sepScoreOf))

    // The two gates are evaluated SEPARATELY, and the hold requirement is a rounded
    // frame COUNT rather than a raw fraction.
    //
    // Both of those were bugs. ANDing "wide enough" and "knees straight" on the same
    // frame and then demanding 70% of frames pass meant a real leap logged at sep=1.57
    // (nearly three times the 0.60 bar) still classified as a jump: with 3 sampled
    // frames, 2/3 = 0.667 falls under 0.7, so the rule silently required 3 of 3 to be
    // simultaneously wide AND straight-kneed. One noisy knee estimate killed the rep.
    //
    // Short reps make that quantisation bite hardest — a 183 ms leap yields 3 samples,
    // which is exactly where all-or-nothing behaviour appears.
    const sepPassing = samples.filter((f) => sepScoreOf(f) >= 1).length
    const sepRequired = Math.max(
      Math.min(2, samples.length),
      Math.round(this.cfg.leapHoldFraction * samples.length),
    )
    const splitHeld = sepPassing >= sepRequired

    // The shape test, on the median so one blown frame cannot move it — the same treatment
    // the separation gets, and for the same reason.
    const legSplitAngle = worldUsable
      ? Math.max(median(samples.map((f) => splitAngleOf(f, 'world'))), median(samples.map((f) => splitAngleOf(f, 'image'))))
      : median(samples.map((f) => splitAngleOf(f, 'image')))
    void legSplitAngle

    // Knees are checked on the MEDIAN across the sample, not per frame. The gate exists
    // to stop a tuck faking a split, and a tuck is bent at the widest point; requiring
    // every frame to be straight also penalises the opening and closing transitions,
    // which are legitimately bent.
    const kneeVals = samples.map(straightestKneeOf).filter((v) => Number.isFinite(v))
    const kneeMedian = kneeVals.length ? median(kneeVals) : NaN
    // Deliberately the median ALONE, with no additional test on the anchor frame. Requiring
    // the widest frame to clear the bar as well was tried and reverted: it is a single-frame
    // veto, which is the exact failure this file has already been bitten by twice (see the
    // straightestKneeOf note above), and the plié gate now keeps folded near-floor frames
    // out of the sample entirely, which is what an anchor test was reaching for.
    void separationScore
    void splitHeld

    // ---- THE LEAP GATE: was the split SEEN, on the airborne frames ---------------------
    //
    // Everything above samples a window and asks the split to HOLD across most of it. Real
    // footage showed that cannot work on a laptop webcam. Ten split leaps and ten straight
    // jumps, filmed at 15 fps and run through this exact detector: in every leap the full split
    // appears on ONE or two frames (legs 145-165 degrees apart), with the legs still folded
    // from the push-off on the frame before and already closing on the frame after. The
    // hold rules called 8 of 10 of those leaps jumps.
    //
    // So the question is now "did the legs open into a split while the feet were off the
    // floor", answered on the frames where they were most open:
    //
    //  - A frame counts if the angle between the legs clears leapMinSplitAngleDeg AND the
    //    straighter knee on that same frame clears leapMinKneeExtDeg — a tuck folds both
    //    knees, so a straight leg on the split frame is what rules a tuck out.
    //  - Enough such frames to cover leapMinSplitHoldMs at the measured frame rate: one frame
    //    at 15 fps, two at 30, three at 60. Robustness to a single blown landmark therefore
    //    scales with how many frames the camera can actually supply.
    //
    // The margin is wide: straight jumps topped out at 34 degrees on any airborne frame, the
    // weakest leap reached 56. Separation (width) is still measured and logged but no longer
    // decides anything — at 15 fps its median and hold rules failed the same way.
    const flightIntervals: number[] = []
    for (let i = 1; i < flight.length; i++) flightIntervals.push(flight[i].tMs - flight[i - 1].tMs)
    const frameMs = flightIntervals.length ? median(flightIntervals) : 1000 / 30
    const splitFramesRequired = Math.max(1, Math.ceil(this.cfg.leapMinSplitHoldMs / Math.max(frameMs, 1) - T_EPS))

    const shapeOf = (f: FrameSnapshot) => ({
      f,
      angle: worldUsable
        ? Math.max(splitAngleOf(f, 'world'), splitAngleOf(f, 'image'))
        : splitAngleOf(f, 'image'),
      knee: straightestKneeOf(f),
    })
    const scored = eligible.filter((f) => f.ankleUsable).map(shapeOf).sort((a, b) => b.angle - a.angle)
    const opened = scored.filter((x) => x.angle >= this.cfg.leapMinSplitAngleDeg)
    const openedStraight = opened.filter((x) => Number.isFinite(x.knee) && x.knee >= this.cfg.leapMinKneeExtDeg)
    // Reported as the k-th widest frame, k being the frames required, so the logged number is
    // the one the decision was made on.
    const peakSplit = scored.length >= splitFramesRequired ? scored[splitFramesRequired - 1] : null
    // The frame the leap is critiqued on: the widest straight-kneed split, not the hip apex.
    // At 15 fps the apex is as likely to be a folded take-off frame as the split itself, and
    // coaching "straighten your front leg" off that frame would be coaching a frame the dancer
    // was only passing through.
    const shapeFrame = openedStraight.length ? openedStraight[0].f : apex

    // ...but only a frame whose legs the tracker actually found. A leap smears the legs, and on
    // the reference footage the widest frame by the 3-D reading was, in three split leaps of
    // ten, one where the image had put a knee at the hip or both feet on one side: a straight
    // leg in the video read as a knee bent to 50 degrees, and the dancer was told to straighten
    // it. The leg critique comes from the widest frame with both legs readable, or not at all.
    const seg = (lm: NormalizedLandmark[], a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y)
    const legsReadable = (lm: NormalizedLandmark[]): boolean => {
      const t = torsoOf(lm)
      const legOk = (h: number, k: number, a: number) =>
        seg(lm, h, k) >= this.cfg.critiqueMinSegTorso * t && seg(lm, k, a) >= this.cfg.critiqueMinSegTorso * t
      const l = (lm[L_ANKLE].x - hipXOf(lm)) / t
      const r = (lm[R_ANKLE].x - hipXOf(lm)) / t
      return legOk(L_HIP, L_KNEE, L_ANKLE) && legOk(R_HIP, R_KNEE, R_ANKLE) &&
        Math.min(l, r) <= -this.cfg.critiqueMinSpreadTorso && Math.max(l, r) >= this.cfg.critiqueMinSpreadTorso
    }
    // Every frame with the feet off the floor is a candidate, not only the gate's sample: the
    // gate leaves out the last 30% of the flight so landing frames cannot vote on the split, and
    // a calypso's shape forms in exactly that stretch, after the turn.
    const readableRanked = flight
      .filter((f) => f.ankleVisible && f.floorRise >= airborneFloor && legsReadable(f.lm))
      .map(shapeOf)
      .filter((x) => x.angle >= this.cfg.leapMinSplitAngleDeg)
      .sort((a, b) => b.angle - a.angle)
    const critiqueFrame = (readableRanked.find((x) => Number.isFinite(x.knee) && x.knee >= this.cfg.leapMinKneeExtDeg) ??
      readableRanked[0])?.f ?? null

    // Which leg is in front: the one on the side the leap travels - a leap goes over its front
    // leg - or, for a leap that barely travels, the side the dancer faces (in profile the nose
    // leads the ears; a calypso turns its face away mid-air, so the face comes second). It used
    // to be "the higher ankle", which made the lower leg the back leg by definition: all twenty
    // reference split and switch leaps were told their back leg had dropped, when in eight of
    // the ten split leaps the back leg was the HIGHER one, at or above the hips. Unknown (a leap
    // seen from the front), the legs are not told apart and nothing front- or back-specific is
    // critiqued.
    const noseLead = median(flight.map((f) => (f.lm[NOSE].x - (f.lm[L_EAR].x + f.lm[R_EAR].x) / 2) / torsoOf(f.lm)))
    const travelled = (hipXOf(landing.lm) - hipXOf(takeoff.lm)) / torsoOf(takeoff.lm)
    const facing = Math.abs(travelled) >= this.cfg.facingMinTravel ? Math.sign(travelled)
      : Math.abs(noseLead) >= this.cfg.facingMinNoseLead ? Math.sign(noseLead)
      : 0

    // Each readable split frame, its legs named front and back by the facing.
    const readable = readableRanked.map((x) => x.f)
    const legsOf = (f: FrameSnapshot) => {
      const front: 'L' | 'R' = (f.lm[L_ANKLE].x - f.lm[R_ANKLE].x) * facing >= 0 ? 'L' : 'R'
      const L = { hip: L_HIP, knee: L_KNEE, ankle: L_ANKLE, foot: L_FOOT }
      const R = { hip: R_HIP, knee: R_KNEE, ankle: R_ANKLE, foot: R_FOOT }
      return front === 'L' ? { front, f: L, b: R } : { front, f: R, b: L }
    }
    const best = (vals: number[]): number | null => {
      const ok = vals.filter(Number.isFinite)
      return ok.length ? Math.max(...ok) : null
    }
    // True screen proportions: x stretched back by the frame's aspect ratio.
    const A = this.cfg.aspect
    const px = (p: { x: number; y: number }) => ({ x: p.x * A, y: p.y })
    const hipMidOf = (lm: NormalizedLandmark[]) => ({ x: hipXOf(lm), y: (lm[L_HIP].y + lm[R_HIP].y) / 2 })

    // The split and the back leg are read off the ANKLES, which a smeared knee does not move. A
    // switch leap reaches its full split in the frame or two after the legs pass - the fastest
    // the legs move all leap - and on the reference footage that frame was exactly the one whose
    // blurred thigh failed legsReadable: the split was read a frame early, the back leg still on
    // its way up, and all ten switch leaps were told it had dropped. At the full split, on the
    // footage, it sat within 13 degrees of hip level on every one.
    const inAir = flight.filter((f) => f.ankleVisible && f.floorRise >= airborneFloor)
    /** Both ankles placed: each well clear of the hips, out to opposite sides. */
    const anklesOut = (lm: NormalizedLandmark[]) => {
      const t = torsoOf(lm)
      const hip = hipMidOf(lm)
      const out = (a: number) => Math.hypot(lm[a].x - hip.x, lm[a].y - hip.y) / t >= this.cfg.straddleMinLegTorso
      const l = (lm[L_ANKLE].x - hip.x) / t
      const r = (lm[R_ANKLE].x - hip.x) / t
      return out(L_ANKLE) && out(R_ANKLE) &&
        Math.min(l, r) <= -this.cfg.critiqueMinSpreadTorso && Math.max(l, r) >= this.cfg.critiqueMinSpreadTorso
    }
    const splitOf = (lm: NormalizedLandmark[]) => angleAt(px(hipMidOf(lm)), px(pt(lm, L_ANKLE)), px(pt(lm, R_ANKLE)))
    let widest: { f: FrameSnapshot; deg: number } | null = null
    for (const f of inAir) {
      if (!anklesOut(f.lm)) continue
      const d = splitOf(f.lm)
      if (Number.isFinite(d) && d >= this.cfg.leapMinSplitAngleDeg && (!widest || d > widest.deg)) widest = { f, deg: d }
    }
    /**
     * How far the back leg sat below horizontal on this frame, degrees, from its own hip in true
     * proportions (negative = above): the leg BEHIND the dancer, placed out behind and well clear
     * of the hips. NaN if it was not.
     */
    /**
     * One leg's height on this frame, degrees raised from hanging straight down (90 = level), from
     * its own hip in true proportions - the leg placed out in FRONT (side 1) or BEHIND (side -1),
     * well clear of the hips. NaN if it was not.
     */
    const legRaisedOf = (f: FrameSnapshot, side: 1 | -1): number => {
      if (facing === 0) return NaN
      const lm = f.lm
      const t = torsoOf(lm)
      const hip = hipMidOf(lm)
      const outL = ((lm[L_ANKLE].x - hip.x) / t) * facing * side
      const outR = ((lm[R_ANKLE].x - hip.x) / t) * facing * side
      const [h, a, out] = outL >= outR ? [L_HIP, L_ANKLE, outL] : [R_HIP, R_ANKLE, outR]
      if (out < this.cfg.critiqueMinSpreadTorso) return NaN
      if (Math.hypot(lm[a].x - hip.x, lm[a].y - hip.y) / t < this.cfg.leapBackLegMinTorso) return NaN
      return (Math.atan2(Math.abs((lm[a].x - lm[h].x) * A), lm[a].y - lm[h].y) * 180) / Math.PI
    }
    /** How far the back leg sat below horizontal on this frame, degrees (negative = above). */
    const backDropOf = (f: FrameSnapshot): number => 90 - legRaisedOf(f, -1)

    const gateFailed: LeapGateFailure =
      scored.length === 0 ? 'ankles-not-visible'
      : eligible.length < 1 ? 'too-few-samples'
      : opened.length < splitFramesRequired ? 'legs-not-split'
      : openedStraight.length < splitFramesRequired ? 'knees-bent'
      : 'none'

    const type: JumpRepEvent['type'] =
      gateFailed === 'none' ? 'leap (jeté-type)' : 'jump (sauté-type)'
    // Technique metrics are computed ONLY for a leap. A straight jump with the legs
    // together is not a move this app scores: running it through the leap metrics let it
    // earn 100/100 for having straight legs it never split. Leaving `metrics` empty makes
    // a leap critique on a jump structurally impossible rather than threshold-dependent —
    // there is nothing for selectFeedback to score. The caller gives a jump its own fixed
    // cue instead (see jumpFeedback in scoring.ts).
    const metrics: Record<string, number | null> = {}
    if (type === 'leap (jeté-type)') {
      const sided = facing !== 0
      // The split at its widest, off the ankles. Null - looked for, not seen - when no airborne
      // frame had both ankles placed, so the leap is never praised for a split nobody saw.
      // ...or, where the full split smeared one ankle, the two legs read separately at the back
      // leg's highest moment: its height plus the front leg's within a frame or two. On a reference
      // switch leap the frame with both ankles placed came one frame before the full split.
      let peakSplit = NaN
      let peak: { f: FrameSnapshot; raised: number } | null = null
      for (const f of inAir) {
        const r = legRaisedOf(f, -1)
        if (Number.isFinite(r) && (!peak || r > peak.raised)) peak = { f, raised: r }
      }
      if (peak) {
        const near = inAir.filter((f) => Math.abs(f.tMs - peak!.f.tMs) <= this.cfg.leapPeakWindowMs)
          .map((f) => legRaisedOf(f, 1)).filter(Number.isFinite)
        if (near.length) peakSplit = peak.raised + Math.max(...near)
      }
      const splits = [widest?.deg ?? NaN, peakSplit].filter(Number.isFinite)
      metrics.split_angle = splits.length ? Math.max(...splits) : null

      // The back leg at its highest: the frame where it sat least below level. Null when no frame
      // had it placed out behind (or the leap's direction was unknown).
      const drops = inAir.map(backDropOf).filter(Number.isFinite)
      metrics.leap_back_leg_drop = sided && drops.length ? Math.min(...drops) : null

      // Knees, on the straightest reading across the readable split frames - and only if there
      // were at least two. At 15 fps a split leap is one smeared frame, and on the reference
      // footage that frame read visibly straight legs at 105-150 degrees (seven of seven back legs
      // told to straighten). Not offered at all then, rather than null: the camera could not see
      // it, so the leap is judged on what it could.
      if (critiqueFrame && readable.length >= this.cfg.critiqueMinJointFrames) {
        const knee = (role: 'f' | 'b') => best(readable.map((f) => {
          const g = legsOf(f)[role]
          return this.bestJointAngle(f.lm, f.world, g.knee, g.hip, g.ankle)
        }))
        metrics.front_leg_ext = sided ? knee('f') : null
        metrics.back_leg_ext = sided ? knee('b') : null
      }

      // No pointed-feet metric: the toe landmark sits almost on the ankle on a pointed jazz shoe -
      // held still in an arabesque it read visibly pointed feet as flexed, and in the air it is
      // worse. The chest, on the widest split frame - it does not need the legs to be readable.
      const chestLm = (widest?.f ?? critiqueFrame ?? shapeFrame).lm
      if (this.vis(chestLm, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)) {
        const shoulderMid = { x: (chestLm[L_SHOULDER].x + chestLm[R_SHOULDER].x) / 2, y: (chestLm[L_SHOULDER].y + chestLm[R_SHOULDER].y) / 2 }
        const hipMid = { x: (chestLm[L_HIP].x + chestLm[R_HIP].x) / 2, y: (chestLm[L_HIP].y + chestLm[R_HIP].y) / 2 }
        const torso = { x: (shoulderMid.x - hipMid.x) * A, y: shoulderMid.y - hipMid.y }
        const norm = Math.hypot(torso.x, torso.y)
        metrics.torso_uprightness = norm > 1e-9
          ? (Math.acos(Math.max(-1, Math.min(1, (torso.x * 0 + torso.y * -1) / norm))) * 180) / Math.PI
          : null
      } else {
        metrics.torso_uprightness = null
      }

      // Landing plié depth: min bilateral knee angle across the landing window.
      const plieAngles: number[] = []
      for (const f of landingWindow) {
        for (const [hip, knee, ankle] of [[L_HIP, L_KNEE, L_ANKLE], [R_HIP, R_KNEE, R_ANKLE]] as const) {
          if (this.vis(f.lm, hip, knee, ankle)) {
            const ang = angleAt(pt(f.lm, knee), pt(f.lm, hip), pt(f.lm, ankle))
            if (!Number.isNaN(ang)) plieAngles.push(ang)
          }
        }
      }
      metrics.land_plie = plieAngles.length ? Math.min(...plieAngles) : null
    }
    // ---- The calypso's shape ------------------------------------------------------------
    // Across the readable split frames, legs named by the facing: the leg on the side the
    // calypso travels is the front leg. It used to be one frame (the widest - on the reference
    // footage as often the take-off, push-off foot still down) with front and back from the 3-D
    // "forward", which is depth: that called a standing leg the front leg, read a straight leg
    // as bent and an arched back as none. Each height is the higher of the true-proportion
    // screen reading and the 3-D one (a limb angled off the screen under-reads in 2-D, never
    // over-reads); each the best the dancer reached in the air, so nothing is critiqued off a
    // frame they were passing through. The attitude's knee lift is read where the back thigh
    // was highest.
    let legShape: LegShape | null = null
    if (type === 'leap (jeté-type)' && facing !== 0 && readable.length > 0) {
      const deg = (r: number) => (r * 180) / Math.PI
      const fmax = (a: number, b: number) => (Number.isFinite(a) ? (Number.isFinite(b) ? Math.max(a, b) : a) : b)
      /** Raised from hanging straight down, degrees: 0 hanging, 90 level, 180 straight up. */
      const raised2d = (lm: NormalizedLandmark[], a: number, b: number) =>
        deg(Math.atan2(Math.abs((lm[b].x - lm[a].x) * A), lm[b].y - lm[a].y))
      const raised3d = (w: Landmark[] | undefined, a: number, b: number) => {
        if (!w) return NaN
        const v = { x: w[b].x - w[a].x, y: w[b].y - w[a].y, z: w[b].z - w[a].z }
        const n = Math.hypot(v.x, v.y, v.z)
        return n > 1e-9 ? deg(Math.acos(Math.max(-1, Math.min(1, v.y / n)))) : NaN   // world y points down
      }
      const per = readable.map((f) => {
        const { front, f: F, b: B } = legsOf(f)
        const lm = f.lm
        const hip = px({ x: (lm[L_HIP].x + lm[R_HIP].x) / 2, y: (lm[L_HIP].y + lm[R_HIP].y) / 2 })
        const sh = px({ x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 })
        const shin = { x: (lm[B.ankle].x - lm[B.knee].x) * A, y: lm[B.ankle].y - lm[B.knee].y }
        return {
          front,
          frontKnee: this.bestJointAngle(lm, f.world, F.knee, F.hip, F.ankle),
          backKnee: this.bestJointAngle(lm, f.world, B.knee, B.hip, B.ankle),
          frontLeg: fmax(raised2d(lm, F.hip, F.ankle), raised3d(f.world, F.hip, F.ankle)),
          backThigh: fmax(raised2d(lm, B.hip, B.knee), raised3d(f.world, B.hip, B.knee)),
          kneeLift: shin.y / (Math.hypot(shin.x, shin.y) || 1e-6),
          // The torso's lean toward the back leg - the side opposite the travel.
          arch: deg(Math.atan2((sh.x - hip.x) * -facing, hip.y - sh.y)),
        }
      })
      const fin = (v: number) => (Number.isFinite(v) ? v : -Infinity)
      const top = per.reduce((a, b) => (fin(b.backThigh) > fin(a.backThigh) ? b : a))
      // Knees as for any leap: only off two readable frames or more (NaN = not offered). The
      // attitude itself - how far the knee folds, and whether it rides above the foot - only on
      // frames where the back knee WAS bent into one, and on two of them at least: the back leg
      // straightens on the way down, and a straight leg's knee is above its foot by default.
      const kneesSeen = readable.length >= this.cfg.critiqueMinJointFrames
      const attitude = per.filter((q) => Number.isFinite(q.backKnee) && q.backKnee <= this.cfg.calypsoAttitudeMaxKneeDeg)
      const attitudeSeen = attitude.length >= this.cfg.critiqueMinJointFrames
      legShape = {
        frontLeg: top.front,
        frontKneeDeg: kneesSeen ? best(per.map((q) => q.frontKnee)) ?? NaN : NaN,
        backKneeDeg: attitudeSeen ? median(attitude.map((q) => q.backKnee)) : NaN,
        frontLegDeg: best(per.map((q) => q.frontLeg)) ?? NaN,
        backThighDeg: top.backThigh,
        backKneeLift: attitudeSeen ? best(attitude.map((q) => q.kneeLift)) ?? NaN : NaN,
        archDeg: best(per.map((q) => q.arch)) ?? NaN,
      }
    }
    // ---- A russian's straddle -------------------------------------------------------------
    // Front-on, the straddle lies in the image plane, so it is read on screen in true proportions
    // and from the ankles alone: the 3-D reading put one leg 25 degrees above the other on
    // straddles the footage shows level, and the far shin - foreshortened, or smeared at the top -
    // is no reason to throw a frame away when the ankle is where it should be. A frame counts
    // with each ankle out to its side and well clear of the hips. Width and height as the
    // straddle held them (75th percentile of its wide frames); evenness at the TOP of the
    // straddle (its frames within straddleTopSlackDeg of the widest), because one leg always
    // leads on the way up and trails on the way down - judged across the whole jump, that hid a
    // visibly lopsided top behind its even closing frames.
    let straddle: Straddle | null = null
    if (type === 'leap (jeté-type)') {
      const deg = (r: number) => (r * 180) / Math.PI
      const raised = (lm: NormalizedLandmark[], h: number, a: number) =>
        deg(Math.atan2(Math.abs((lm[a].x - lm[h].x) * A), lm[a].y - lm[h].y))
      const wide = flight
        .filter((f) => f.ankleVisible && anklesOut(f.lm))
        .map((f) => {
          const lm = f.lm
          const hip = px({ x: (lm[L_HIP].x + lm[R_HIP].x) / 2, y: (lm[L_HIP].y + lm[R_HIP].y) / 2 })
          const eL = raised(lm, L_HIP, L_ANKLE)
          const eR = raised(lm, R_HIP, R_ANKLE)
          return { width: angleAt(hip, px(pt(lm, L_ANKLE)), px(pt(lm, R_ANKLE))), height: (eL + eR) / 2, uneven: Math.abs(eL - eR) }
        })
        .filter((r) => r.width >= this.cfg.straddleMinDeg)
      const pct = (xs: number[], q: number) => {
        const v = [...xs].sort((a, b) => a - b)
        return v[Math.round(q * (v.length - 1))]
      }
      const gaps = flight.slice(1).map((f, i) => f.tMs - flight[i].tMs)
      const slowCapture = gaps.length > 0 && median(gaps) >= this.cfg.straddleSlowGapMs
      if (wide.length >= (slowCapture ? 1 : this.cfg.straddleMinFrames)) {
        const widest = Math.max(...wide.map((r) => r.width))
        const top = wide.filter((r) => r.width >= widest - this.cfg.straddleTopSlackDeg)
        straddle = {
          widthDeg: pct(wide.map((r) => r.width), 0.75),
          heightDeg: pct(wide.map((r) => r.height), 0.75),
          unevenDeg: median(top.map((r) => r.uneven)),
        }
      }
    }

    const torso0 = torsoOf(takeoff.lm)
    const sampleOf = (f: FrameSnapshot, phase: FlightSample['phase']): FlightSample =>
      flightSample(f.lm, f.world, f.tMs, phase, Number.isFinite(f.floorRise) ? f.floorRise / torsoOf(f.lm) : NaN, torso0, this.cfg.aspect)
    const trace: FlightSample[] = [
      ...this.preTakeoff.map((f) => sampleOf(f, 'pre')),
      ...this.candidateBuffer.filter((f) => f.tMs < takeoff.tMs).map((f) => sampleOf(f, 'pre')),
      ...flight.map((f) => sampleOf(f, 'air')),
      ...landingWindow.filter((f) => f.tMs > landing.tMs).map((f) => sampleOf(f, 'post')),
    ]
    const hipX = (lm: NormalizedLandmark[]) => (lm[L_HIP].x + lm[R_HIP].x) / 2
    const travelTorso = (hipX(landing.lm) - hipX(takeoff.lm)) / torso0

    // Real gaps between captured frames during this flight, so a session on a laptop
    // webcam under MediaPipe load reports its own timing rather than an assumed rate.
    const intervals: number[] = []
    for (let i = 1; i < flight.length; i++) intervals.push(flight[i].tMs - flight[i - 1].tMs)

    let peakHipRise = 0
    let peakAnkleRise = 0
    for (const f of flight) {
      if (f.hipRise > peakHipRise) peakHipRise = f.hipRise
      if (f.ankleRise > peakAnkleRise) peakAnkleRise = f.ankleRise
    }

    const event: JumpRepEvent = {
      type,
      splitAngleDeg: splitAngle,
      metrics,
      takeoffMs: takeoff.tMs,
      apexMs: apex.tMs,
      critiqueMs: type === 'leap (jeté-type)' ? (widest?.f ?? critiqueFrame)?.tMs ?? null : null,
      landingMs: landing.tMs,
      airborneMs: landing.tMs - takeoff.tMs,
      peakHipRise,
      peakAnkleRise,
      separationRatio,
      separationSource: worldUsable ? 'world' : 'image',
      leapGate: {
        failed: gateFailed,
        sepMedian: separationRatio,
        sepThreshold,
        sepPassing,
        sepRequired,
        kneeMedian: Number.isFinite(kneeMedian) ? kneeMedian : NaN,
        kneeThreshold: this.cfg.leapMinKneeExtDeg,
        legSplitAngleDeg: peakSplit ? peakSplit.angle : 0,
        splitFrames: openedStraight.length,
        splitFramesRequired,
        peakSplitKneeDeg: peakSplit && Number.isFinite(peakSplit.knee) ? peakSplit.knee : NaN,
        legSplitAngleThreshold: this.cfg.leapMinSplitAngleDeg,
        airborneFrames: airborne.length,
      },
      flightFrames: flight.length,
      sampleFrames: samples.length,
      frameIntervalMs: intervals.length
        ? {
            min: Math.min(...intervals),
            max: Math.max(...intervals),
            mean: intervals.reduce((a, b) => a + b, 0) / intervals.length,
          }
        : { min: 0, max: 0, mean: 0 },
      legShape,
      straddle,
      trace,
      riseTorso: Number.isFinite(scale) ? (peakHipRise / torso0) : 0,
      travelTorso,
    }

    this.enterRefractory(lastT)
    return event
  }
}

/** One frame of the flight trace (see FlightSample). World "up" is -y: MediaPipe world Y points down. */
export function flightSample(
  lm: NormalizedLandmark[],
  w: Landmark[] | undefined,
  tMs: number,
  phase: FlightSample['phase'],
  floor: number,
  torso0: number,
  aspect = 16 / 9,
): FlightSample {
  const deg = (r: number) => (r * 180) / Math.PI
  const angle3 = (a: number[], b: number[]) => {
    const n = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])
    return n < 1e-12 ? NaN : deg(Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n))))
  }
  const li = [lm[L_ANKLE].x - lm[L_HIP].x, lm[L_ANKLE].y - lm[L_HIP].y, 0]
  const ri = [lm[R_ANKLE].x - lm[R_HIP].x, lm[R_ANKLE].y - lm[R_HIP].y, 0]
  const torso = Math.hypot((lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2 - (lm[L_HIP].x + lm[R_HIP].x) / 2,
    (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 - (lm[L_HIP].y + lm[R_HIP].y) / 2) || 1e-6
  const imgKnee = (h: number, k: number, a: number) =>
    angleAt({ x: lm[k].x * aspect, y: lm[k].y }, { x: lm[h].x * aspect, y: lm[h].y }, { x: lm[a].x * aspect, y: lm[a].y })
  const s: FlightSample = {
    tMs,
    phase,
    legAngleImage: angle3(li, ri),
    legAngleWorld: NaN,
    elevL: NaN,
    elevR: NaN,
    elevImgL: angle3(li, [0, 1, 0]),
    elevImgR: angle3(ri, [0, 1, 0]),
    kneeL: NaN,
    kneeR: NaN,
    kneeImgL: imgKnee(L_HIP, L_KNEE, L_ANKLE),
    kneeImgR: imgKnee(R_HIP, R_KNEE, R_ANKLE),
    leanDeg: NaN,
    latHip: NaN,
    latL: NaN,
    latR: NaN,
    facing: Math.hypot(lm[L_SHOULDER].x - lm[R_SHOULDER].x, lm[L_SHOULDER].y - lm[R_SHOULDER].y) / torso,
    hipXT: ((lm[L_HIP].x + lm[R_HIP].x) / 2) / torso0,
    floor,
    wristsAboveNose: (lm[NOSE].y - Math.max(lm[L_WRIST].y, lm[R_WRIST].y)) / torso,
    faceUp: ((lm[L_EAR].y + lm[R_EAR].y) / 2 - lm[NOSE].y) / torso,
    headYaw: Math.abs(lm[NOSE].x - (lm[L_EAR].x + lm[R_EAR].x) / 2) / Math.max(Math.abs(lm[L_EAR].x - lm[R_EAR].x), 1e-3),
  }
  if (w && w.length > R_FOOT) {
    const lw = [w[L_ANKLE].x - w[L_HIP].x, w[L_ANKLE].y - w[L_HIP].y, w[L_ANKLE].z - w[L_HIP].z]
    const rw = [w[R_ANKLE].x - w[R_HIP].x, w[R_ANKLE].y - w[R_HIP].y, w[R_ANKLE].z - w[R_HIP].z]
    const down = [0, 1, 0]
    s.legAngleWorld = angle3(lw, rw)
    s.elevL = angle3(lw, down)
    s.elevR = angle3(rw, down)
    s.kneeL = angleAt3(w[L_KNEE], w[L_HIP], w[L_ANKLE])
    s.kneeR = angleAt3(w[R_KNEE], w[R_HIP], w[R_ANKLE])
    const torsoV = [
      (w[L_SHOULDER].x + w[R_SHOULDER].x) / 2 - (w[L_HIP].x + w[R_HIP].x) / 2,
      (w[L_SHOULDER].y + w[R_SHOULDER].y) / 2 - (w[L_HIP].y + w[R_HIP].y) / 2,
      (w[L_SHOULDER].z + w[R_SHOULDER].z) / 2 - (w[L_HIP].z + w[R_HIP].z) / 2,
    ]
    s.leanDeg = angle3(torsoV, [0, -1, 0])
    let hx = w[R_HIP].x - w[L_HIP].x
    let hz = w[R_HIP].z - w[L_HIP].z
    const hn = Math.hypot(hx, hz)
    if (hn > 1e-9) {
      hx /= hn
      hz /= hn
      const sx = w[R_ANKLE].x - w[L_ANKLE].x
      const sz = w[R_ANKLE].z - w[L_ANKLE].z
      const sn = Math.hypot(sx, sz)
      s.latHip = sn > 1e-9 ? Math.abs(sx * hx + sz * hz) / sn : NaN
      const ln = Math.hypot(lw[0], lw[2])
      const rn = Math.hypot(rw[0], rw[2])
      s.latL = ln > 1e-9 ? (lw[0] * hx + lw[2] * hz) / ln : 0
      s.latR = rn > 1e-9 ? (rw[0] * hx + rw[2] * hz) / rn : 0
    }
  }
  return s
}
