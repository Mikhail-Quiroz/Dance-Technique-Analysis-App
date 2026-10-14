// Illusions: the body tips forward and down over the standing leg while the free leg swings up
// past vertical, the whole turning once on the standing foot, and comes back up.
//
// This detector finds the shape - the torso going past horizontal while a leg rises high, then the
// torso back upright - and the move engine requires the turn: a rotation of at least half a turn
// over the same moment (TurnDetector.recentSpins). Without it the shape is a penché, which is not
// a move this app coaches. On the reference footage (videos/reference/illusion) the torso went to
// 100-180 degrees from upright and the free leg to 130-180 degrees from hanging down, for 0.5-1.2 s.
// At the most inverted moment the tracker often loses the dancer for a few frames; a gap that short
// is ridden out.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { angleAt, angleAt3, kneeReading } from './geometry'

const L_SHOULDER = 11, R_SHOULDER = 12
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28

export interface IllusionDetectorConfig {
  /** The torso past this from upright (degrees) starts the shape... */
  downDeg: number
  /** ...and back under this ends it. */
  upDeg: number
  /** It must have gone at least this far over (horizontal is 90)... */
  minTorsoDeg: number
  /** ...with a leg at least this high, raised from hanging down. */
  minLegDeg: number
  /** Longer than this is not an illusion (they took 0.3-1.0 s on the reference footage). */
  maxMs: number
  /**
   * The standing leg stays down (degrees raised, median over the shape), and the hips and ankles
   * are clearly seen (visibility, median). Leaning over the camera to start a recording fills the
   * picture with a body whose leg landmarks are guesses: that read as a 2-second "illusion".
   */
  maxStandingDeg: number
  /** ...on at least this share of the frames (real illusions: all of them). */
  minStandingShare: number
  /**
   * The torso tips over at its full length: on screen it kept 44-102% of its length upright, just
   * before, in every reference illusion. A skeleton the tracker collapsed - shoulders read at hip
   * height, which also reads as "tipped over" - kept 20%. With no upright frames before it to
   * compare with (the start of a recording), nothing counts.
   */
  minTorsoRatio: number
  minVisibility: number
  /** A gap in tracking up to this long is ridden out (the tracker loses an inverted body). */
  gapMs: number
  /** Coming up for less than this and going over again is the same illusion (doubles were 0.8 s+ apart). */
  mergeMs: number
  aspect: number
}

export const DEFAULT_ILLUSION_CONFIG: IllusionDetectorConfig = {
  downDeg: 70,
  upDeg: 40,
  minTorsoDeg: 90,
  minLegDeg: 120,
  maxMs: 1500,
  maxStandingDeg: 50,
  minStandingShare: 0.75,
  minTorsoRatio: 0.35,
  minVisibility: 0.5,
  gapMs: 700,
  mergeMs: 300,
  aspect: 16 / 9,
}

export interface IllusionShape {
  startMs: number
  endMs: number
  /** The furthest the torso went over, degrees from upright. */
  torsoDeg: number
  /** The free leg at its highest, degrees raised from hanging down. */
  legDeg: number
  metrics: Record<string, number | null>
}

interface Frame {
  tMs: number
  torso: number
  hi: number
  supportKnee: number
  standing: number
  vis: number
  torsoLen: number
}

export class IllusionDetector {
  private readonly cfg: IllusionDetectorConfig
  private frames: Frame[] = []
  private down = false
  private lastSeenMs = -Infinity
  private upSince: number | null = null
  /** Torso lengths on recent upright frames: what a full-length torso looks like on screen. */
  private uprightLens: number[] = []

  constructor(cfg: Partial<IllusionDetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_ILLUSION_CONFIG, ...cfg }
  }

  reset(): void {
    this.frames = []
    this.down = false
    this.upSince = null
  }

  /** The input has ended: a shape still open is finished now. */
  flush(): IllusionShape | null {
    const shape = this.down ? this.finish() : null
    this.reset()
    return shape
  }

  /** The body is tipped over right now (an illusion may be under way). */
  get inverted(): boolean {
    return this.down
  }

  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): IllusionShape | null {
    const c = this.cfg
    if (this.down && tMs - this.lastSeenMs > c.gapMs) this.reset()
    this.lastSeenMs = tMs
    const A = c.aspect
    const P = (i: number) => ({ x: lm[i].x * A, y: lm[i].y })
    const hip = { x: (P(L_HIP).x + P(R_HIP).x) / 2, y: (P(L_HIP).y + P(R_HIP).y) / 2 }
    const sh = { x: (P(L_SHOULDER).x + P(R_SHOULDER).x) / 2, y: (P(L_SHOULDER).y + P(R_SHOULDER).y) / 2 }
    const torsoLen = Math.hypot(sh.x - hip.x, sh.y - hip.y) || 1e-6
    const torso = (Math.atan2(Math.abs(sh.x - hip.x), hip.y - sh.y) * 180) / Math.PI
    const raised = (h: number, a: number) => (Math.atan2(Math.abs(P(a).x - P(h).x), P(a).y - P(h).y) * 180) / Math.PI
    const elL = raised(L_HIP, L_ANKLE), elR = raised(R_HIP, R_ANKLE)
    if (torso < 25) {
      this.uprightLens.push(torsoLen)
      if (this.uprightLens.length > 30) this.uprightLens.shift()
    }

    if (!this.down) {
      if (torso < c.downDeg) return null
      this.down = true
      this.frames = []
    }
    if (torso <= c.upDeg) {
      if (this.upSince === null) this.upSince = tMs
      if (tMs - this.upSince < c.mergeMs) return null
      const shape = this.finish()
      this.reset()
      return shape
    }
    this.upSince = null
    if (this.frames.length && tMs - this.frames[0].tMs > c.maxMs) {
      this.reset()
      return null
    }
    const free = elL >= elR ? 'L' : 'R'
    const [SH, SK, SA] = free === 'L' ? [R_HIP, R_KNEE, R_ANKLE] : [L_HIP, L_KNEE, L_ANKLE]
    const imgKnee = angleAt(P(SK), P(SH), P(SA))
    const wKnee = world ? angleAt3(world[SK], world[SH], world[SA]) : NaN
    this.frames.push({
      tMs,
      torso,
      hi: Math.max(elL, elR),
      supportKnee: kneeReading(wKnee, imgKnee),
      standing: Math.min(elL, elR),
      vis: Math.min(...[L_HIP, R_HIP, L_ANKLE, R_ANKLE].map((i) => lm[i].visibility ?? 1)),
      torsoLen,
    })
    return null
  }

  private finish(): IllusionShape | null {
    const c = this.cfg
    const fr = this.frames
    if (fr.length < 2) return null
    const torsoDeg = Math.max(...fr.map((f) => f.torso))
    const legDeg = Math.max(...fr.map((f) => f.hi))
    if (torsoDeg < c.minTorsoDeg || legDeg < c.minLegDeg) return null
    const med = (xs: number[]) => {
      const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
      return v.length ? v[v.length >> 1] : NaN
    }
    // The standing leg down on (nearly) every frame: a skeleton the tracker flipped upside down for a
    // second - an upright dancer read inverted, legs and all - has it up on most of them.
    const standing = fr.filter((f) => f.standing <= c.maxStandingDeg).length / fr.length
    if (standing < c.minStandingShare || med(fr.map((f) => f.vis)) < c.minVisibility) return null
    if (this.uprightLens.length < 5 || med(fr.map((f) => f.torsoLen)) < c.minTorsoRatio * med(this.uprightLens)) return null
    const knee = med(fr.map((f) => f.supportKnee))
    // Not critiqued: whether a hand touched the floor (the dancer's rule: better not, but still an
    // illusion). Upside down, with the torso aimed at the lens, the wrists read 10 torso lengths
    // below the floor on the reference footage.
    return {
      startMs: fr[0].tMs,
      endMs: fr[fr.length - 1].tMs,
      torsoDeg,
      legDeg,
      metrics: {
        illusion_leg_height: legDeg,
        illusion_support_knee: Number.isFinite(knee) ? knee : null,
      },
    }
  }
}
