import { describe, expect, it } from 'vitest'
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { ArabesqueDetector, type ArabesqueEvent } from './arabesqueDetector'
import { selectFeedback } from './scoring'

// The synthetic bodies here are drawn in square coordinates (x and y on one scale), so the
// detectors are told the frame is square - a real webcam frame is 16:9 (MoveEngineConfig.aspect).
const SQUARE = { aspect: 1 }

// ---------------------------------------------------------------------------
// Body model. Image space, y grows DOWNWARD.
//
// The supporting leg stays planted on the floor; the working leg swings BACK and UP from
// the hip. `arabesqueDeg` is how far the leg is raised from hanging straight down — 0 is
// standing, 90 is the leg horizontal behind, past 90 is a penché — which is the quantity
// arabesque_height measures and the quantity the detector gates on.
//
// These used to be degrees above HORIZONTAL, 90 less, so the fixtures were written around
// values like 45 and 75 that actually describe a 135 degree penché and a near-full standing
// split. They read as ordinary arabesques and hid the fact that nothing below roughly 97
// degrees could be detected at all.
// ---------------------------------------------------------------------------

const FPS = 30
const DT = 1000 / FPS
const GROUND = 0.90
const THIGH = 0.20
const SHIN = 0.20
const HIP_Y = 0.50
const rad = (d: number) => (d * Math.PI) / 180

interface Pose {
  /** Working-leg elevation behind, degrees from hanging straight down. 90 = horizontal. */
  arabesqueDeg?: number
  /** Working knee flexion; 0 = perfectly straight. */
  workingKneePlie?: number
  /** Supporting knee flexion; 0 = perfectly straight. */
  supportPlie?: number
  /** Torso tilt forward from vertical, in degrees. */
  torsoTilt?: number
  /** Lift the SUPPORTING foot off the floor (turns the balance into something else). */
  supportLift?: number
  vis?: number
}

function makeLandmarks(p: Pose = {}): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const v = p.vis ?? 1
  const put = (id: number, x: number, y: number) => { lm[id] = { x, y, z: 0, visibility: v } }

  const hipY = HIP_Y
  const hipX = 0.50

  // Supporting leg: hip, knee and ankle collinear under the supporting hip, so a
  // supportPlie of 0 really is a straight leg. `supportLift` raises the supporting
  // ankle toward the hips WITHOUT moving the body, which is what "foot left the
  // floor" looks like to the detector — translating everything would leave the
  // hip-to-ankle gap unchanged and test nothing.
  const sp = p.supportPlie ?? 0
  const sHipX = hipX + 0.05
  const sAnkleY = GROUND - (p.supportLift ?? 0)
  const sKneeX = sHipX + SHIN * Math.sin(rad(sp)) * 0.5
  const sKneeY = (hipY + sAnkleY) / 2

  // Working leg: swung behind (negative x), raised `arabesqueDeg` from straight down.
  // At 0 the leg hangs under its own hip, which is what standing actually looks like —
  // the old fixture idled at 60 degrees behind and called that standing.
  const lift = p.arabesqueDeg ?? 0
  const wp = p.workingKneePlie ?? 0
  const thighDir = { x: -Math.sin(rad(lift)), y: Math.cos(rad(lift)) }
  const wHipX = hipX - 0.05          // build from the working HIP landmark, or the leg
  const wKneeX = wHipX + THIGH * thighDir.x     // is not actually collinear at plie 0
  const wKneeY = hipY + THIGH * thighDir.y
  const shinLift = lift - wp         // a bent knee drops the shin, lowering the ankle
  const shinDir = { x: -Math.sin(rad(shinLift)), y: Math.cos(rad(shinLift)) }
  const wAnkleX = wKneeX + SHIN * shinDir.x
  const wAnkleY = wKneeY + SHIN * shinDir.y

  const tilt = p.torsoTilt ?? 0
  const shoulderY = hipY - 0.30 * Math.cos(rad(tilt))
  const shoulderX = hipX + 0.30 * Math.sin(rad(tilt))

  put(11, shoulderX - 0.05, shoulderY); put(12, shoulderX + 0.05, shoulderY)
  put(23, hipX - 0.05, hipY); put(24, hipX + 0.05, hipY)
  // Left = working, Right = supporting.
  put(25, wKneeX, wKneeY); put(26, sKneeX, sKneeY)
  put(27, wAnkleX, wAnkleY); put(28, sHipX, sAnkleY)
  put(29, wAnkleX, wAnkleY + 0.02); put(30, sHipX, sAnkleY + 0.02)
  put(31, wAnkleX, wAnkleY + 0.05); put(32, sHipX, sAnkleY + 0.05)
  return lm
}

const hold = (n: number, p: Pose = {}): Pose[] => Array.from({ length: n }, () => ({ ...p }))
const STAND: Pose = {}

function run(frames: Pose[], warmup = 60) {
  const det = new ArabesqueDetector(SQUARE)
  const events = []
  let t = 0
  for (const f of [...hold(warmup), ...frames, ...hold(30)]) {
    const ev = det.pushFrame(makeLandmarks(f), t)
    if (ev) events.push(ev)
    t += DT
  }
  return { events, det }
}

/** Ramp the working leg up to `arabesqueDeg`, hold it there, then lower it. */
function arabesque(arabesqueDeg: number, holdFrames: number, extra: Pose = {}): Pose[] {
  const up = Array.from({ length: 8 }, (_, i) => ({ arabesqueDeg: arabesqueDeg * ((i + 1) / 8), ...extra }))
  const down = Array.from({ length: 8 }, (_, i) => ({ arabesqueDeg: arabesqueDeg * (1 - (i + 1) / 8), ...extra }))
  return [...up, ...hold(holdFrames, { arabesqueDeg, ...extra }), ...down]
}

describe('ArabesqueDetector — no event on ordinary movement', () => {
  it('standing normally never fires', () => {
    expect(run(hold(240)).events).toHaveLength(0)
  })

  it('a leg swept up behind and straight back down counts once, as a passing arabesque', () => {
    // An arabesque does not have to be held: in choreography it is often hit and left at once.
    expect(run(arabesque(90, 1)).events).toHaveLength(1)
  })

  it('a low leg lift is not an arabesque', () => {
    // 25 degrees behind — a tendu or small battement derrière, under the 40 degree bar.
    expect(run(arabesque(25, 60)).events).toHaveLength(0)
  })

  it('does not fire while the body scale is warming up', () => {
    const det = new ArabesqueDetector(SQUARE)
    let t = 0
    for (let i = 0; i < 10; i++) {
      expect(det.pushFrame(makeLandmarks({ arabesqueDeg: 90 }), t)).toBeNull()
      t += DT
    }
    expect(det.debug.phase).toBe('warmup')
  })

  it('rejects the position when the supporting foot is not on the floor', () => {
    expect(run(arabesque(90, 60, { supportLift: 0.25 })).events).toHaveLength(0)
  })
})

describe('ArabesqueDetector — confirmed holds', () => {
  it('a clean held arabesque counts exactly once', () => {
    const { events } = run(arabesque(90, 60))
    expect(events).toHaveLength(1)
    // Confirmed as soon as the position settles, not after a long balance.
    expect(events[0].holdMs).toBeGreaterThanOrEqual(100)
    expect(events[0].holdMs).toBeLessThan(400)
    expect(events[0].workingLeg).toBe('L')
    expect(events[0].supportingLeg).toBe('R')
  })

  it('two separate holds count as two', () => {
    const { events } = run([...arabesque(90, 45), ...hold(45), ...arabesque(90, 45)])
    expect(events).toHaveLength(2)
  })

  it('measures the working-leg height it was given', () => {
    const low = run(arabesque(70, 60)).events[0]
    const high = run(arabesque(110, 60)).events[0]
    expect(low.metrics.arabesque_height).not.toBeNull()
    expect(high.metrics.arabesque_height!).toBeGreaterThan(low.metrics.arabesque_height!)
  })

  it('reports every scored metric the shared thresholds define for an arabesque', () => {
    const { events } = run(arabesque(90, 60))
    const m = events[0].metrics
    for (const key of ['arabesque_height', 'arabesque_knee_ext', 'support_knee_ext', 'arabesque_chest']) {
      expect(m[key], key).not.toBeNull()
      expect(m[key], key).not.toBeUndefined()
    }
    // A dynamic arabesque is not scored on how long it was held.
    expect(m).not.toHaveProperty('hold_duration_s')
  })

  it('exposes a debug readout for checking against footage', () => {
    const { det } = run(arabesque(90, 60))
    const d = det.debug
    expect(d).toMatchObject({
      phase: expect.any(String),
      arabesqueDeg: expect.any(Number),
      enterDeg: expect.any(Number),
      exitDeg: expect.any(Number),
      supportGap: expect.any(Number),
      bodyScale: expect.any(Number),
      reps: 1,
    })
    expect(d.exitDeg).toBeLessThan(d.enterDeg)   // hysteresis
  })

  it('counts one hold at 15, 30 and 60 fps', () => {
    for (const fps of [15, 30, 60]) {
      const dt = 1000 / fps
      const det = new ArabesqueDetector(SQUARE)
      let t = 0
      let n = 0
      const holdFrames = Math.round(1.5 * fps)
      const frames = [...hold(Math.round(2 * fps)), ...arabesque(90, holdFrames), ...hold(fps)]
      for (const f of frames) {
        if (det.pushFrame(makeLandmarks(f), t)) n++
        t += dt
      }
      expect(n, `${fps} fps`).toBe(1)
    }
  })
})

describe('ArabesqueDetector — critique', () => {
  it('a clean arabesque earns praise, not a correction', () => {
    const { events } = run(arabesque(100, 60, { workingKneePlie: 0, supportPlie: 0, torsoTilt: 5 }))
    expect(events).toHaveLength(1)
    const fb = selectFeedback(events[0].metrics)
    expect(fb.kind).toBe('praise')
  })

  it('a bent working knee earns a correction', () => {
    const { events } = run(arabesque(90, 60, { workingKneePlie: 45 }))
    expect(events).toHaveLength(1)
    const fb = selectFeedback(events[0].metrics)
    expect(fb.kind).toBe('correction')
    expect(fb.kind === 'correction' && fb.cueId).toBe('straighten_arabesque_leg')
  })
})

// ---------------------------------------------------------------------------
// DYNAMIC ARABESQUES. Reported: an arabesque only registered after ~1.5 s of holding,
// while in choreography it is usually a half-second moment. The detector demanded 800 ms
// of hold and then only emitted once the leg came DOWN.
// ---------------------------------------------------------------------------

/** Frame index (from the start of `frames`) at which the detector emitted, or -1. */
function emitIndex(frames: Pose[], warmup = 60): number {
  const det = new ArabesqueDetector(SQUARE)
  let t = 0
  const all = [...hold(warmup), ...frames, ...hold(30)]
  for (let i = 0; i < all.length; i++) {
    if (det.pushFrame(makeLandmarks(all[i]), t)) return i - warmup
    t += DT
  }
  return -1
}

describe('ArabesqueDetector — a dynamic arabesque is an arabesque', () => {
  it('a half-second arabesque inside a combination is counted', () => {
    // 4-frame ramp up, ~0.5 s at the top, 4-frame ramp down.
    const up = Array.from({ length: 4 }, (_, i) => ({ arabesqueDeg: 90 * ((i + 1) / 4) }))
    const down = Array.from({ length: 4 }, (_, i) => ({ arabesqueDeg: 90 * (1 - (i + 1) / 4) }))
    expect(run([...up, ...hold(15, { arabesqueDeg: 90 }), ...down]).events).toHaveLength(1)
  })

  it('fires while the leg is still up, not when it comes down', () => {
    const frames = arabesque(90, 60)            // 8 up, 60 held (2 s), 8 down
    const idx = emitIndex(frames)
    expect(idx).toBeGreaterThan(0)
    // Within about half a second of reaching the top, long before the 2 s hold ends.
    expect(idx).toBeLessThan(8 + 18)
  })

  it('a long balance is still ONE arabesque', () => {
    expect(run(arabesque(90, 150)).events).toHaveLength(1)
  })

  // Deliberate trade-off, chosen by the product owner: arabesques that are hit and left at
  // once (into a chassé or a tour jeté) must count, and from the leg alone a grand battement
  // derrière looks the same. Battements are not analysed on /live, so a kick counts ONCE as an
  // arabesque rather than a passing arabesque being missed.
  it('a leg kicked up behind and straight down counts once', () => {
    const kick = Array.from({ length: 15 }, (_, i) => ({ arabesqueDeg: 95 * Math.sin((Math.PI * (i + 1)) / 16) }))
    const { events, det } = run(kick)
    expect(events).toHaveLength(1)
    expect(det.debug.reps).toBe(1)
    // Scored on the top of the swing, not on the way up.
    expect(events[0].metrics.arabesque_height!).toBeGreaterThan(85)
  })

  it('a passing arabesque is counted before the leg is back down', () => {
    // Up in 4 frames, two frames at the top, then down: counted as the leg leaves the top.
    const up = [30, 55, 75, 90].map((d) => ({ arabesqueDeg: d }))
    const down = [75, 55, 30, 10].map((d) => ({ arabesqueDeg: d }))
    const idx = emitIndex([...up, ...hold(2, { arabesqueDeg: 90 }), ...down])
    expect(idx).toBeGreaterThan(0)
    expect(idx).toBeLessThanOrEqual(4 + 2 + 1)
  })
})

// ---------------------------------------------------------------------------
// The arabesque as the camera actually sees it.
//
// Built from ten real arabesques (videos/reference/arabesque): the dancer stands three-quarters
// to the camera, the raised leg crosses the image, and the face and the front arm turn away
// from the leg - out over the front hand. Both the image landmarks and MediaPipe-style world
// landmarks (x to the image right, y DOWN, z away from the camera, origin at the hips) come from
// one body built in the dancer's own frame and turned by `yaw` (0 = facing the camera).
// ---------------------------------------------------------------------------

interface Scene {
  /** Working leg raised from hanging straight down, degrees. */
  deg: number
  /** Body turned away from facing the camera, degrees. The real arabesques were about 45. */
  yaw?: number
  /** The raised leg is carried in FRONT instead of behind (a développé devant). */
  legInFront?: boolean
  kneeBend?: number
  supportBend?: number
  /** Chest pitched forward from vertical, degrees. */
  tilt?: number
  /** Head turned from where the chest faces: 0 looks out over the front arm, 180 back at the leg. */
  headTurn?: number
  flexFoot?: boolean
  noise?: number
}

let sSeed = 97531
const sJit = (a: number) => {
  sSeed = (sSeed * 1664525 + 1013904223) >>> 0
  return ((sSeed / 4294967296) * 2 - 1) * a
}

function scene(p: Scene): { lm: NormalizedLandmark[]; world: Landmark[] } {
  // Dancer frame: x to the dancer's right, y up, z forward; hips at the origin. Left leg works.
  type P = [number, number, number]
  const pts: Record<number, P> = {}
  const LEG = 0.43
  const sb = rad(p.supportBend ?? 0)
  const drop = 2 * LEG * Math.cos(sb / 2)
  pts[24] = [0.1, 0, 0]; pts[26] = [0.1, -drop / 2, LEG * Math.sin(sb / 2)]; pts[28] = [0.1, -drop, 0]
  pts[30] = [0.1, -drop - 0.03, -0.06]; pts[32] = [0.1, -drop - 0.03, 0.12]
  pts[23] = [-0.1, 0, 0]
  const dir = p.legInFront ? 1 : -1
  const at = (from: P, d: number, len: number): P => [from[0], from[1] - len * Math.cos(rad(d)), from[2] + dir * len * Math.sin(rad(d))]
  pts[25] = at(pts[23], p.deg, LEG)
  pts[27] = at(pts[25], p.deg - (p.kneeBend ?? 0), LEG)
  pts[29] = [pts[27][0], pts[27][1] + 0.03, pts[27][2] - dir * 0.03]
  if (p.flexFoot || p.deg < 20) {
    pts[31] = [pts[27][0], pts[27][1] + (p.deg < 20 ? -0.03 : 0.05), pts[27][2] + (p.deg < 20 ? 0.12 : -dir * 0.11)]
  } else {
    const s: P = [pts[27][0] - pts[25][0], pts[27][1] - pts[25][1], pts[27][2] - pts[25][2]]
    const n = Math.hypot(...s)
    pts[31] = [pts[27][0] + (0.12 * s[0]) / n, pts[27][1] + (0.12 * s[1]) / n, pts[27][2] + (0.12 * s[2]) / n]
  }
  const t = rad(p.tilt ?? 0)
  const sh: P = [0, 0.5 * Math.cos(t), 0.5 * Math.sin(t)]
  pts[11] = [-0.18, sh[1], sh[2]]; pts[12] = [0.18, sh[1], sh[2]]
  // Arms: the front arm (the supporting side's) reaches forward and up, the other out to the side.
  pts[16] = [0.15, sh[1] + 0.15, sh[2] + 0.55]; pts[14] = [0.17, sh[1] + 0.05, sh[2] + 0.3]
  pts[15] = [-0.7, sh[1] + 0.05, sh[2] - 0.1]; pts[13] = [-0.45, sh[1] + 0.02, sh[2] - 0.05]
  pts[20] = pts[16]; pts[19] = pts[15]
  const h = rad(p.headTurn ?? 0)
  const head: P = [sh[0], sh[1] + 0.18, sh[2]]
  const face = (x: number, z: number): P => [head[0] + x * Math.cos(h) + z * Math.sin(h), head[1], head[2] - x * Math.sin(h) + z * Math.cos(h)]
  pts[0] = face(0, 0.1); pts[7] = face(-0.07, 0); pts[8] = face(0.07, 0)

  // Into world coordinates: facing the camera at yaw 0, the dancer's right is the image LEFT and
  // forward is toward the camera (-z).
  const y = rad(p.yaw ?? 45)
  const r = { x: -Math.cos(y), z: Math.sin(y) }
  const f = { x: -Math.sin(y), z: -Math.cos(y) }
  const n = p.noise ?? 0
  const world: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  const lm: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  for (const [k, [x, up, z]] of Object.entries(pts)) {
    const wx = r.x * x + f.x * z + sJit(n)
    const wy = -up + sJit(n)
    const wz = r.z * x + f.z * z + sJit(n)
    world[+k] = { x: wx, y: wy, z: wz, visibility: 1 }
    lm[+k] = { x: 0.5 + wx * 0.4, y: 0.5 + wy * 0.4, z: 0, visibility: 1 }
  }
  return { lm, world }
}

/** Stand, rise into the position, hold, come down, stand. */
function sceneSession(p: Scene, holdMs = 1500, fps = 30): ArabesqueEvent[] {
  const det = new ArabesqueDetector(SQUARE)
  const dt = 1000 / fps
  const out: ArabesqueEvent[] = []
  let t = 0
  const push = (q: Scene) => {
    const s = scene(q)
    const ev = det.pushFrame(s.lm, t, s.world)
    if (ev) out.push(ev)
    t += dt
  }
  const N = (ms: number) => Math.max(1, Math.round((ms / 1000) * fps))
  const stand: Scene = { ...p, deg: 0, kneeBend: 0, tilt: 0 }
  for (let i = 0; i < N(2500); i++) push(stand)
  const up = N(300)
  for (let i = 0; i < up; i++) push({ ...p, deg: (p.deg * (i + 1)) / up, tilt: ((p.tilt ?? 0) * (i + 1)) / up })
  for (let i = 0; i < N(holdMs); i++) push(p)
  for (let i = 0; i < up; i++) push({ ...p, deg: p.deg * (1 - (i + 1) / up), tilt: (p.tilt ?? 0) * (1 - (i + 1) / up) })
  for (let i = 0; i < N(1000); i++) push(stand)
  return out
}

const cueOf = (m: Record<string, number | null>) => {
  const fb = selectFeedback(m)
  return fb.kind === 'correction' ? fb.cueId : fb.kind
}
const cuesOf = (m: Record<string, number | null>) => {
  const fb = selectFeedback(m)
  return fb.kind === 'correction' ? [fb.cueId, ...fb.also.map((a) => a.cueId)] : [fb.kind]
}

describe('ArabesqueDetector — the arabesque as the camera sees it', () => {
  it.each([60, 75, 90, 110, 130])('a held %s degree arabesque in three-quarter view is detected once', (deg) => {
    const evs = sceneSession({ deg })
    expect(evs).toHaveLength(1)
    expect(evs[0].workingLeg).toBe('L')
    expect(evs[0].metrics.arabesque_height!).toBeGreaterThan(deg - 8)
    expect(evs[0].metrics.arabesque_height!).toBeLessThan(deg + 8)
  })

  it.each([0, 20, 45, 70])('is detected whichever way the dancer faces the camera (yaw %s)', (yaw) => {
    expect(sceneSession({ deg: 95, yaw })).toHaveLength(1)
  })

  it('survives realistic landmark noise', () => {
    for (const noise of [0.005, 0.012, 0.02]) expect(sceneSession({ deg: 95, noise }), `noise ${noise}`).toHaveLength(1)
  })

  it('counts one hold at 15, 24, 30 and 60 fps', () => {
    for (const fps of [15, 24, 30, 60]) expect(sceneSession({ deg: 95 }, 1500, fps), `${fps} fps`).toHaveLength(1)
  })

  it('MediaPipe world Y points down - up is taken as -y, verified on 18k real frames', () => {
    // A deep forward pitch used to flip a shoulders-above-hips "up" estimate; a fixed up does not.
    expect(sceneSession({ deg: 130, tilt: 60 })).toHaveLength(1)
  })

  it('reports the metrics the shared thresholds define for an arabesque', () => {
    const m = sceneSession({ deg: 95 })[0].metrics
    for (const key of ['arabesque_height', 'arabesque_knee_ext', 'support_knee_ext', 'arabesque_chest', 'arabesque_gaze']) {
      expect(m[key], key).not.toBeNull()
      expect(m[key], key).not.toBeUndefined()
    }
    // Measured on real footage and found unmeasurable, so never reported.
    for (const key of ['arabesque_releve', 'arabesque_line', 'arabesque_point', 'arabesque_tilt', 'hold_duration_s']) expect(m).not.toHaveProperty(key)
  })
})

describe('ArabesqueDetector — what is not an arabesque', () => {
  it('standing still never fires', () => {
    const det = new ArabesqueDetector(SQUARE)
    let n = 0
    for (let i = 0; i < 300; i++) {
      const s = scene({ deg: 0, noise: 0.01 })
      if (det.pushFrame(s.lm, i * DT, s.world)) n++
    }
    expect(n).toBe(0)
  })

  it('a low leg lift (a tendu or dégagé) is not an arabesque', () => {
    expect(sceneSession({ deg: 40 })).toHaveLength(0)
  })

  it.each([0, 45])('a front développé is not an arabesque (yaw %s)', (yaw) => {
    // In three-quarter view the leg reaches the way the face looks; facing the camera it points
    // at the lens. Either way the leg is in front, and in front is not an arabesque.
    expect(sceneSession({ deg: 90, yaw, legInFront: true })).toHaveLength(0)
  })

  it('says why it refused a front extension', () => {
    const det = new ArabesqueDetector(SQUARE)
    for (let i = 0; i < 120; i++) {
      const s = scene({ deg: i < 80 ? 0 : 90, legInFront: true })
      det.pushFrame(s.lm, i * DT, s.world)
    }
    expect(det.debug.lastReject).toBe('leg-in-front')
  })

  it('a leg behind with the knee folded (an attitude, or a heel kicked up running) is not an arabesque', () => {
    expect(sceneSession({ deg: 110, kneeBend: 100 })).toHaveLength(0)
  })

  it('a leg lifted from a deep plié on the standing leg (the spring into a sashay) is not an arabesque', () => {
    expect(sceneSession({ deg: 90, supportBend: 75 })).toHaveLength(0)
  })
})

describe('ArabesqueDetector — critique', () => {
  it('a clean arabesque earns praise', () => {
    expect(cueOf(sceneSession({ deg: 100 })[0].metrics)).toBe('praise')
  })

  it('a low arabesque is told to lift the leg', () => {
    expect(cueOf(sceneSession({ deg: 58 })[0].metrics)).toBe('lift_arabesque_leg')
  })

  it('a bent working knee is cued on the knee, not on the height', () => {
    expect(cueOf(sceneSession({ deg: 100, kneeBend: 35 })[0].metrics)).toBe('straighten_arabesque_leg')
  })

  it('a bent standing leg is cued on the standing leg', () => {
    expect(cueOf(sceneSession({ deg: 100, supportBend: 40 })[0].metrics)).toBe('straighten_standing_leg')
  })

  it('pitching the chest forward is cued, beyond what a high leg asks for', () => {
    expect(cuesOf(sceneSession({ deg: 90, tilt: 45 })[0].metrics)).toContain('lift_chest')
    // The same pitch with the leg at 140 degrees is mostly the allowance a high arabesque needs.
    expect(cuesOf(sceneSession({ deg: 140, tilt: 30 })[0].metrics)).not.toContain('lift_chest')
  })

  it('looking at the camera instead of out over the front hand is cued', () => {
    // At yaw 45 a head turned 45 degrees back faces the lens: the face no longer follows the arm.
    expect(cuesOf(sceneSession({ deg: 100, headTurn: -45 })[0].metrics)).toContain('arabesque_gaze')
    expect(cuesOf(sceneSession({ deg: 100, headTurn: 0 })[0].metrics)).not.toContain('arabesque_gaze')
  })

  it('the foot is not critiqued: the toe landmark cannot tell a pointed foot from a flexed one', () => {
    // On ten real arabesques the toe landmark sat almost on the ankle of visibly pointed jazz
    // shoes and read every one as flexed. A cue built on it would be confidently wrong.
    const m = sceneSession({ deg: 100, flexFoot: true })[0].metrics
    expect(m).not.toHaveProperty('arabesque_point')
    expect(cuesOf(m)).not.toContain('point_arabesque_foot')
  })
})

describe('ArabesqueDetector — noise does not delay recognition', () => {
  it('one spiked frame at the top does not hold the confirmation hostage', () => {
    const det = new ArabesqueDetector(SQUARE)
    let t = 0
    const push = (d: number) => { const s = scene({ deg: d }); const e = det.pushFrame(s.lm, t, s.world); t += DT; return e }
    for (let i = 0; i < 75; i++) push(0)
    const seq = [30, 60, 85, 90, 120, 90, 91, 89, 90, 90, 91, 90, 89, 90]
    let at = -1
    seq.forEach((d, i) => { if (push(d) && at < 0) at = i })
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(3 + 8)
  })

  it('reports why a near miss was not counted', () => {
    const det = new ArabesqueDetector(SQUARE)
    let t = 0
    for (const d of [...Array(75).fill(0), 60, 110, 120, 120, 120, 110, 60, ...Array(30).fill(0)]) {
      const s = scene({ deg: d, kneeBend: d > 0 ? 100 : 0 })
      det.pushFrame(s.lm, t, s.world)
      t += DT
    }
    expect(det.lastAttempt?.reason).toBe('working-knee-folded')
  })
})
