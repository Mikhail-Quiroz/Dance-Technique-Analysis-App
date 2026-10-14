// Kicks: grand battements to the front and to the side, and fan kicks. A kick is a straight leg
// thrown up past the head and brought straight back down while the dancer stands on the other leg.
//
// What tells the three apart depends on where the camera is, and the rules follow the footage
// (videos/reference/front battement, side battement, fan kick):
//  - Filmed from the front (shoulders wide), a side battement goes up and down on its own side of
//    the body, and a fan kick sweeps across the front: its foot passes the body's midline while the
//    leg is up. Every side battement's foot stayed at least 0.26 torso lengths out on its own side;
//    9 of 10 fan kicks crossed.
//  - Filmed from the side, a front battement rises on the side the dancer faces (the nose ahead of
//    the ears). A kick that rises behind is a battement derrière, which the dancer asked to keep
//    counting as an arabesque, so it is left to the arabesque detector.
// A front battement aimed at the camera, or a fan kick filmed from the side, cannot be told from
// the others on screen; on the reference footage those were the misses.
//
// How a kick is told from an arabesque: its height. Every reference arabesque peaked at 91-136
// degrees on screen; every kick at 140 or more. A held position is left to the arabesque detector.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { angleAt, angleAt3, kneeReading } from './geometry'

const NOSE = 0, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12
const L_WRIST = 15, R_WRIST = 16
const L_HIP = 23, R_HIP = 24
const L_KNEE = 25, R_KNEE = 26
const L_ANKLE = 27, R_ANKLE = 28

export type KickKind = 'frontBattement' | 'sideBattement' | 'fanKick'

export interface KickDetectorConfig {
  /** A kick starts when a leg rises past this (degrees raised from hanging down, on screen)... */
  startDeg: number
  /** ...and is over when it comes back below it. */
  endDeg: number
  /** It must reach this to be a kick at all (reference arabesques peaked at 91-136, kicks 140-178). */
  minPeakDeg: number
  /** The standing leg stays below this the whole time; both legs up is a jump. */
  supportMaxDeg: number
  /** A leg up longer than this is a held extension, not a kick (kicks were up 0.2-0.6 s). */
  maxKickMs: number
  /**
   * ...and up for less than this is a tracking glitch: the shortest of 402 kicks across the reference
   * footage was 144 ms; a leg "thrown" to 148 degrees for 33 ms in the run-up to a leap was not.
   */
  minKickMs: number
  /** Shoulders at least this many torso lengths above the hips: upright, not an illusion. */
  minUprightTorso: number
  /** Facing the camera at or above this shoulder width (over torso length): filmed from the front. */
  frontOnFacing: number
  /** From the front: a foot that comes within this of the midline (or past it) crossed - a fan kick. */
  fanCrossTorso: number
  /** From the side: the foot this far toward the face (torso lengths) is in front. */
  sideOnForwardTorso: number
  /** From the front, a leg this far behind in 3-D (share of its horizontal direction) is an arabesque... */
  behindWorldShare: number
  /**
   * ...unless the foot swept well past the midline (torso lengths): the 3-D depth put 4 of 13 left
   * fan kicks on the iPhone footage "behind" (-0.2 to -0.8). Every fan kick crossed to -0.39 or
   * further; a leg thrown up after a russian that read "behind" came to +0.07.
   */
  fanSureCrossTorso: number
  /**
   * Frames in a row the standing leg may read raised (or the body not upright) before the kick is
   * given up. Side-on, the tracker swaps the legs' labels for a frame or two as one passes the other.
   */
  glitchFrames: number
  /** Frames in a row the leg must stay down before the kick is over, so one noisy frame cannot split it. */
  endFrames: number
  /**
   * ...and for this long: a fan kick seen from the front passes the lens halfway round, where its
   * leg collapses to nothing on screen. Rising again within this, it is the same kick.
   */
  mergeGapMs: number
  /** The camera frame's width over its height (frames arrive in REFERENCE_ASPECT units). */
  aspect: number
}

export const DEFAULT_KICK_CONFIG: KickDetectorConfig = {
  startDeg: 45,
  endDeg: 45,
  minPeakDeg: 138,
  supportMaxDeg: 40,
  maxKickMs: 1500,
  minKickMs: 100,
  minUprightTorso: 0.5,
  frontOnFacing: 0.45,
  fanCrossTorso: 0.15,
  sideOnForwardTorso: 0.2,
  behindWorldShare: -0.3,
  fanSureCrossTorso: -0.3,
  glitchFrames: 3,
  endFrames: 2,
  mergeGapMs: 250,
  aspect: 16 / 9,
}

export interface KickEvent {
  /** null: a kick that rose behind the dancer (left to the arabesque detector), or unreadable. */
  kind: KickKind | null
  leg: 'L' | 'R'
  startMs: number
  endMs: number
  peakMs: number
  peakDeg: number
  metrics: Record<string, number | null>
  reason: string
}

interface KickFrame {
  tMs: number
  /** The higher leg on this frame: the kicking one (the labels can swap mid-kick). */
  leg: 'L' | 'R'
  el: number
  facing: number
  /** The kicking foot across the picture from the hip midpoint, + toward its own side (torso lengths). */
  own: number
  /** The same toward the way the face points. */
  forward: number
  /** 3-D share of the leg's horizontal direction pointing the way the face points (+ in front). */
  worldForward: number
  knee: number
  /** The kicking leg's length on screen, hip to ankle, in torso lengths: short when aimed at the lens. */
  legLen: number
  supportKnee: number
  armL: number
  armR: number
  /** Each foot from its own hip on screen, true proportions, torso lengths (x across, y up). */
  footL: { x: number; y: number }
  footR: { x: number; y: number }
}

/**
 * A fan kick draws a circle. The foot passes hip height twice, on the way up and on the way down,
 * and on a round fan it is out at the leg's full reach both times. A leg that goes up round and then
 * drops straight down passes hip height close in. Returned: where the foot passed hip height on the
 * way down, as a share of the farthest it reached (`path` in order, with the frame after the kick).
 * On the iPhone footage round fans passed at 0.83-0.96 of their reach on both sides; fans that
 * dropped flat at the end, 0.20-0.33 on the way down after 0.62-0.78 on the way up. Null when the
 * foot never came back below hip height inside the kick.
 */
export function fanCircleEnd(path: ReadonlyArray<{ x: number; y: number }>): number | null {
  const pts = path.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (pts.length < 4) return null
  const reach = Math.max(...pts.map((p) => Math.hypot(p.x, p.y)))
  let top = 0
  pts.forEach((p, i) => { if (p.y > pts[top].y) top = i })
  for (let i = pts.length - 2; i >= top; i--) {
    const a = pts[i], b = pts[i + 1]
    if (a.y >= 0 && b.y < 0) {
      const x = a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y)
      return reach > 0 ? Math.min(1, Math.abs(x) / reach) : null
    }
  }
  return null
}

export class KickDetector {
  private readonly cfg: KickDetectorConfig
  private active = false
  private frames: KickFrame[] = []
  private peak = 0
  private glitches = 0
  private downFrames = 0
  private downSince: number | null = null
  /** Both feet on the first frame after the leg came down: where a fast drop lands. */
  private exit: { footL: { x: number; y: number }; footR: { x: number; y: number } } | null = null
  /** Why recent candidate kicks were dropped, for the dev log. */
  readonly rejected: string[] = []

  private reject(tMs: number, why: string): void {
    if (this.peak >= 90) this.rejected.push(`${(tMs / 1000).toFixed(2)} kick (peak ${this.peak.toFixed(0)}) dropped: ${why}`)
    if (this.rejected.length > 100) this.rejected.shift()
    this.reset()
  }

  constructor(cfg: Partial<KickDetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_KICK_CONFIG, ...cfg }
  }

  reset(): void {
    this.active = false
    this.frames = []
    this.peak = 0
    this.glitches = 0
    this.downFrames = 0
    this.downSince = null
    this.exit = null
  }

  /** The input has ended: a kick on its way down is finished now. */
  flush(): KickEvent | null {
    const ev = this.active ? this.finish() : null
    this.reset()
    return ev
  }

  /** A kick under way that has already gone higher than any arabesque: hold arabesques back. */
  get highKick(): boolean {
    return this.active && this.peak >= this.cfg.minPeakDeg
  }

  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): KickEvent | null {
    const c = this.cfg
    const A = c.aspect
    const P = (i: number) => ({ x: lm[i].x * A, y: lm[i].y })
    const mid = (a: number, b: number) => ({ x: (P(a).x + P(b).x) / 2, y: (P(a).y + P(b).y) / 2 })
    const hip = mid(L_HIP, R_HIP), sh = mid(L_SHOULDER, R_SHOULDER)
    const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y) || 1e-6
    const raised = (h: number, a: number) => {
      const dx = P(a).x - P(h).x, dy = P(a).y - P(h).y
      return (Math.atan2(Math.abs(dx), dy) * 180) / Math.PI
    }
    const elL = raised(L_HIP, L_ANKLE), elR = raised(R_HIP, R_ANKLE)
    const upright = hip.y - sh.y >= c.minUprightTorso * torso

    // The kicking leg is the higher one on each frame: side-on, the tracker can swap the labels.
    const leg: 'L' | 'R' = elL >= elR ? 'L' : 'R'
    const foot = (h: number, a: number) => ({ x: (P(a).x - P(h).x) / torso, y: -(P(a).y - P(h).y) / torso })
    const el = Math.max(elL, elR)
    const other = Math.min(elL, elR)
    if (!this.active) {
      if (el >= c.startDeg && other <= c.supportMaxDeg && upright) {
        this.reset()
        this.active = true
      } else {
        return null
      }
    }
    if (other > c.supportMaxDeg || !upright) {
      if (++this.glitches > c.glitchFrames) this.reject(tMs, other > c.supportMaxDeg ? `standing leg up (${other.toFixed(0)})` : 'not upright')
      return null
    }
    this.glitches = 0
    if (el < c.endDeg) {
      if (!this.exit) this.exit = { footL: foot(L_HIP, L_ANKLE), footR: foot(R_HIP, R_ANKLE) }
      this.downFrames++
      if (this.downSince === null) this.downSince = tMs
      if (this.downFrames < c.endFrames || tMs - this.downSince < c.mergeGapMs) return null
      const ev = this.finish()
      this.reset()
      return ev
    }
    this.downFrames = 0
    this.downSince = null
    this.exit = null
    if (this.frames.length && tMs - this.frames[0].tMs > c.maxKickMs) {
      this.reject(tMs, 'held too long')
      return null
    }

    const [H, K, An] = leg === 'L' ? [L_HIP, L_KNEE, L_ANKLE] : [R_HIP, R_KNEE, R_ANKLE]
    const [SH, SK, SA] = leg === 'L' ? [R_HIP, R_KNEE, R_ANKLE] : [L_HIP, L_KNEE, L_ANKLE]
    const ownSign = P(H).x >= hip.x ? 1 : -1
    const ear = mid(L_EAR, R_EAR)
    const faceSign = P(NOSE).x >= ear.x ? 1 : -1
    const ankleDx = (P(An).x - hip.x) / torso
    const imgKnee = (h: number, k: number, a: number) => angleAt(P(k), P(h), P(a))
    const wKnee = (h: number, k: number, a: number) => (world ? angleAt3(world[k], world[h], world[a]) : NaN)
    // Arms: the angle at the shoulder between the arm and the side of the body (0 along it, 90 out
    // in second, 180 overhead) - against the torso, so a body leaning into the kick moves no arm.
    const arm = (s: number, w: number, h: number) => angleAt(P(s), P(w), P(h))
    let worldForward = NaN
    if (world) {
      const w = world
      let lx = w[R_HIP].x - w[L_HIP].x, lz = w[R_HIP].z - w[L_HIP].z
      const ln = Math.hypot(lx, lz) || 1
      lx /= ln; lz /= ln
      let fx = w[NOSE].x - (w[L_SHOULDER].x + w[R_SHOULDER].x) / 2
      let fz = w[NOSE].z - (w[L_SHOULDER].z + w[R_SHOULDER].z) / 2
      const along = fx * lx + fz * lz
      fx -= along * lx; fz -= along * lz
      const fn = Math.hypot(fx, fz)
      const vx = w[An].x - w[H].x, vz = w[An].z - w[H].z
      const vn = Math.hypot(vx, vz)
      if (fn > 1e-6 && vn > 1e-6) worldForward = (vx * fx + vz * fz) / (fn * vn)
    }
    this.frames.push({
      tMs,
      leg,
      el,
      facing: Math.hypot(P(L_SHOULDER).x - P(R_SHOULDER).x, P(L_SHOULDER).y - P(R_SHOULDER).y) / torso,
      own: ankleDx * ownSign,
      forward: ankleDx * faceSign,
      worldForward,
      knee: kneeReading(wKnee(H, K, An), imgKnee(H, K, An)),
      legLen: Math.hypot(P(An).x - P(H).x, P(An).y - P(H).y) / torso,
      footL: foot(L_HIP, L_ANKLE),
      footR: foot(R_HIP, R_ANKLE),
      supportKnee: kneeReading(wKnee(SH, SK, SA), imgKnee(SH, SK, SA)),
      armL: arm(L_SHOULDER, L_WRIST, L_HIP),
      armR: arm(R_SHOULDER, R_WRIST, R_HIP),
    })
    this.peak = Math.max(this.peak, el)
    return null
  }

  private finish(): KickEvent | null {
    const c = this.cfg
    const fr = this.frames
    if (!fr.length || this.peak < c.minPeakDeg) return null
    if (fr[fr.length - 1].tMs - fr[0].tMs < c.minKickMs) return null
    const leg: 'L' | 'R' = fr.filter((f) => f.leg === 'L').length * 2 >= fr.length ? 'L' : 'R'
    const med = (xs: number[]) => {
      const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
      return v.length ? v[v.length >> 1] : NaN
    }
    const top = [...fr].sort((a, b) => b.el - a.el).slice(0, 3)
    const peakFrame = top[0]
    const high = fr.filter((f) => f.el >= 90)
    const facing = med((high.length ? high : fr).map((f) => f.facing))
    // The foot's closest approach to the far side, on two frames at least: one frame is a glitch.
    const owns = fr.map((f) => f.own).sort((a, b) => a - b)
    const crossed = owns.length >= 2 ? owns[1] : owns[0]
    const forward = med(fr.filter((f) => f.el >= 60).map((f) => f.forward))
    const worldForward = med(top.map((f) => f.worldForward))

    let kind: KickKind | null
    let why: string
    if (facing >= c.frontOnFacing) {
      if (crossed >= c.fanSureCrossTorso && Number.isFinite(worldForward) && worldForward <= c.behindWorldShare) {
        kind = null
        why = `from the front, the leg went behind (${worldForward.toFixed(2)})`
      } else {
        kind = crossed < c.fanCrossTorso ? 'fanKick' : 'sideBattement'
        why = `from the front (facing ${facing.toFixed(2)}), foot ${crossed < c.fanCrossTorso ? 'crossed' : 'stayed out'} (${crossed.toFixed(2)}), world forward ${worldForward.toFixed(2)}`
      }
    } else if (forward >= c.sideOnForwardTorso) {
      kind = 'frontBattement'
      why = `from the side (facing ${facing.toFixed(2)}), in front (${forward.toFixed(2)})`
    } else {
      kind = null
      why = `from the side (facing ${facing.toFixed(2)}), not in front (${forward.toFixed(2)})`
    }

    // The arms: held out in second (both 60-120 degrees as the kick starts), how far either one
    // rose or fell during it (10th to 90th percentile). Not offered when the arms were elsewhere.
    const start = fr.slice(0, Math.max(2, Math.ceil(fr.length / 3)))
    const inSecond = (a: number) => a >= 60 && a <= 120
    const armsInSecond = inSecond(med(start.map((f) => f.armL))) && inSecond(med(start.map((f) => f.armR)))
    const spread = (xs: number[]) => {
      const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
      return v.length >= 3 ? v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)] : NaN
    }
    // The kicking knee near the top, on frames where the leg showed close to its full length: a leg
    // swept past the lens (a fan kick from the front) shrinks on screen and its knee reads anything.
    const longest = Math.max(...fr.map((f) => f.legLen))
    const readable = fr.filter((f) => f.el >= 110 && f.legLen >= 0.85 * longest)
    const fin = (v: number) => (Number.isFinite(v) ? v : null)
    const metrics: Record<string, number | null> = {
      kick_height: this.peak,
      kick_support_knee: fin(med(high.map((f) => f.supportKnee))),
    }
    // The kicking knee: not on a fan kick, whose leg is a blur as it sweeps across the front (on
    // the reference footage it read 93-132 degrees on legs the video shows straight).
    if (kind !== 'fanKick') metrics.kick_knee = fin(Math.max(...readable.map((f) => f.knee).filter(Number.isFinite)))
    // A fan kick's circle: does the foot come down the far side at full reach (fanCircleEnd)?
    if (kind === 'fanKick') {
      const path = fr.map((f) => (leg === 'L' ? f.footL : f.footR))
      if (this.exit) path.push(leg === 'L' ? this.exit.footL : this.exit.footR)
      metrics.fan_full_circle = fanCircleEnd(path)
    }
    // The arms only from the front: side-on, one arm is behind the body.
    if (armsInSecond && facing >= c.frontOnFacing) {
      const s = Math.max(spread(fr.map((f) => f.armL)), spread(fr.map((f) => f.armR)))
      metrics.kick_arms_steady = Number.isFinite(s) ? s : null
    }
    return {
      kind,
      leg,
      startMs: fr[0].tMs,
      endMs: fr[fr.length - 1].tMs,
      peakMs: peakFrame.tMs,
      peakDeg: this.peak,
      metrics,
      reason: `${kind ?? 'not a kick'} ${leg}: peak ${this.peak.toFixed(0)}, ${why}`,
    }
  }
}
