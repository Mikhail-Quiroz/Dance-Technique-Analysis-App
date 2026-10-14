// The /live move engine: runs every detector on each frame and decides what the dancer actually
// did. LiveClient and the real-footage tests both drive this one class, so what is tested is
// exactly what runs.
//
// The detectors each see one kind of motion - a flight, a raised leg, a rotation - and a real
// combination sets several of them off at once: the brush before a switch leap looks like an
// arabesque for a frame, a calypso's chaîné is a turn, a pirouette with a little hop is a
// "flight", the landing out of a russian lifts a leg behind. The engine arbitrates:
//
//  - Jumps are named by jumpType.ts. Hops and sashays are preparations and are dropped, and so is
//    a small flight in the middle of a turn: that is a hop in the turn, which the turn detector
//    counts as a fault of its own.
//  - A chaîné that leads straight into a calypso is the calypso's entry, not a move of its own,
//    and a rotation that starts in the air belongs to the leap it happened in. So does the spin a
//    russian or a calypso lands into (to the floor, or staying up): the dancer asked for it never
//    to be counted.
//  - An arabesque is only counted when the dancer is standing still: not turning, not in or just
//    out of a flight, and not about to take off. It is held for a moment to be sure.
//  - A kick that goes higher than any arabesque (KickDetector) holds arabesques back until it is
//    over: a front or side battement or a fan kick replaces the arabesque its leg passed through;
//    a kick behind is a battement derrière, which the dancer asked to count as an arabesque.
//  - An illusion is the body tipped over and a leg thrown up past vertical (IllusionDetector) while
//    the turn detector sees at least half a turn: the turn, any arabesque and any kick in it are
//    the illusion's, not moves of their own.
//
// Holding an event costs a fraction of a second of latency and is what makes these vetoes
// possible at all: the arabesque about to become a take-off cannot be known on its first frame.
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { JumpRepDetector, type JumpRepEvent } from './jumpDetector'
import { ArabesqueDetector, type ArabesqueEvent } from './arabesqueDetector'
import { TurnDetector, type TurnEvent } from './turnDetector'
import { KickDetector, type KickEvent } from './kickDetector'
import { IllusionDetector, type IllusionShape } from './illusionDetector'
import { classifyJump, hasEntryTurn, type JumpContext, type JumpVerdict } from './jumpType'
import { jumpMetrics } from './jumpMetrics'

export type MoveKind =
  | 'jump' | 'split' | 'switch' | 'calypso' | 'russian' | 'leapUnsure'
  | 'firebird' | 'tiltJump' | 'switchTilt' | 'switchArabesque'
  | 'arabesque'
  | 'frontBattement' | 'sideBattement' | 'fanKick' | 'illusion'
  | 'pirouette' | 'seconde' | 'changingSpot' | 'chaine' | 'pique' | 'turnUnsure'

export interface MoveEvent {
  move: MoveKind
  /** When the engine emitted it. */
  tMs: number
  startMs: number
  endMs: number
  /** Short human summary for the cue card, e.g. "3 rotations". */
  detail: string
  /** Scored metrics; empty for moves that are counted but not critiqued. */
  metrics: Record<string, number | null>
  /** Rotations (turns) or turns in a series. */
  count?: number
  /** One dev-log line explaining the decision. */
  log: string
  source: { jump?: JumpRepEvent; jumpVerdict?: JumpVerdict; arabesque?: ArabesqueEvent; turn?: TurnEvent; kick?: KickEvent; illusion?: IllusionShape }
}

export interface MoveEngineConfig {
  /** An arabesque is held this long before it is emitted, so a take-off or a turn can veto it. */
  arabesqueHoldMs: number
  /** No arabesque within this long after a landing (the leg trailing out of a leap). */
  arabesqueAfterLandingMs: number
  /** No arabesque within this long after a turn sequence ends. */
  arabesqueAfterTurnMs: number
  /** A chaîné is held this long to see whether it leads into a calypso. */
  chaineHoldMs: number
  /**
   * A flight that took off during a turn is a hop in the turn, not a jump, unless it is this
   * big: real leaps out of a turn (calypsos) rose 0.67-0.98 torso lengths and stayed up
   * 460-590 ms; hops in pirouettes and à la seconde turns were far smaller.
   */
  inTurnLeapMinRiseTorso: number
  inTurnLeapMinAirMs: number
  /** A turn starting this close to a flight (in the air or just after landing) belongs to it. */
  turnInFlightMarginMs: number
  /**
   * A turn starting this soon after a russian or a calypso lands is the spin out of it. On the
   * reference russians it started 272-736 ms after the landing, and up to 880 ms at 15 fps.
   */
  leapExitTurnMs: number
  /** Only a turn already this far round vetoes an arabesque (see TurnDetector.isActive). */
  vetoTurnMinDeg: number
  /**
   * An illusion turns: at least this much rotation over it. The reference ones read 151-534 degrees:
   * upside down, the shoulders read badly and a full turn can come out short.
   */
  illusionMinTurnDeg: number
  /**
   * The rotation is read this long after the body comes back up: an inverted body's shoulders read
   * badly, and the turn detector finishes counting the turn only once the dancer is upright again.
   */
  illusionWaitMs: number
  /**
   * The camera frame's width over its height. Landmarks are normalised separately in x and y, so
   * a frame of any other shape than REFERENCE_ASPECT is re-expressed in its units on the way in
   * (see pushFrame), and the detectors measure critique angles in true proportions from there.
   */
  aspect: number
}

/**
 * The frame shape the detectors' thresholds were tuned at: every reference clip is 1280 x 720.
 * Many of their measures are image x-distances over a torso length, so on a narrower frame - a
 * phone held upright films 3:4 or 9:16 - the same dancer reads 2.4-3x wider. Replayed as a 3:4
 * crop of the very same frames, 4 of the 100 reference clips changed answer before frames were
 * re-expressed in these units.
 */
export const REFERENCE_ASPECT = 16 / 9

export const DEFAULT_ENGINE_CONFIG: MoveEngineConfig = {
  arabesqueHoldMs: 400,
  arabesqueAfterLandingMs: 600,
  arabesqueAfterTurnMs: 400,
  chaineHoldMs: 900,
  inTurnLeapMinRiseTorso: 0.55,
  inTurnLeapMinAirMs: 380,
  turnInFlightMarginMs: 200,
  leapExitTurnMs: 1000,
  vetoTurnMinDeg: 150,
  illusionMinTurnDeg: 140,
  illusionWaitMs: 1200,
  // /live asks the camera for 1280x720, and every reference clip is 1280x720.
  aspect: 16 / 9,
}

interface Pending {
  ev: MoveEvent
  releaseAt: number
  kind: 'arabesque' | 'turn' | 'kick' | 'illusion' | 'jump'
}

interface Flight {
  takeoffMs: number
  landingMs: number
  move: MoveKind | 'hop' | 'sashay' | 'in-turn hop'
}

const fmtT = (t: number) => (t / 1000).toFixed(2)

export class MoveEngine {
  readonly jump: JumpRepDetector
  readonly arabesque: ArabesqueDetector
  readonly turn: TurnDetector
  readonly kick: KickDetector
  readonly illusion: IllusionDetector
  private readonly cfg: MoveEngineConfig
  /** Recent illusions: every move inside one is part of it. */
  private illusions: Array<{ startMs: number; endMs: number }> = []
  /** Image x into REFERENCE_ASPECT units: 1 on a 16:9 frame. */
  private readonly xScale: number
  private pending: Pending[] = []
  private flights: Flight[] = []
  private takeoffMs: number | null = null
  private turnActiveAtTakeoff = false
  private takeoffCtx: JumpContext = { entryTurnDeg: 0, entryTurnGapMs: Infinity }
  /** Every turn sequence the detector closed recently, before arbitration: [start, end, rotation]. */
  private closedTurns: Array<{ startMs: number; endMs: number; rotationDeg: number }> = []
  private lastTurnEndMs = -Infinity
  /** Everything that was detected and then dropped, for the dev log. */
  readonly dropped: string[] = []

  constructor(cfg: Partial<MoveEngineConfig> = {}) {
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...cfg }
    this.xScale = this.cfg.aspect / REFERENCE_ASPECT
    // Every frame reaches the detectors in REFERENCE_ASPECT units (pushFrame).
    this.jump = new JumpRepDetector({ aspect: REFERENCE_ASPECT })
    this.arabesque = new ArabesqueDetector({ aspect: REFERENCE_ASPECT })
    this.turn = new TurnDetector({ aspect: REFERENCE_ASPECT })
    this.kick = new KickDetector({ aspect: REFERENCE_ASPECT })
    this.illusion = new IllusionDetector({ aspect: REFERENCE_ASPECT })
  }

  reset(): void {
    this.jump.reset()
    this.arabesque.reset()
    this.turn.reset()
    this.kick.reset()
    this.illusion.reset()
    this.pending = []
    this.takeoffMs = null
  }

  /** A flight whose feet have left the floor (see JumpRepDetector.airborneOffFloor). */
  private inFlight(): boolean {
    return this.jump.airborneOffFloor
  }

  /** Any flight still being decided - turn events wait for it. */
  private flightPending(): boolean {
    const p = this.jump.debug.phase
    return p === 'candidate' || p === 'airborne' || p === 'landingTail'
  }

  private drop(tMs: number, what: string): void {
    this.dropped.push(`${fmtT(tMs)} ${what}`)
    if (this.dropped.length > 200) this.dropped.shift()
  }

  pushFrame(lm: NormalizedLandmark[], tMs: number, world?: Landmark[]): MoveEvent[] {
    // The picture as it would sit in a 16:9 frame of the same height: x rescaled, y unchanged.
    // World landmarks are in metres and need nothing. The identity on 16:9 footage.
    if (this.xScale !== 1) lm = lm.map((p) => ({ ...p, x: p.x * this.xScale }))
    const out: MoveEvent[] = []
    const phaseBefore = this.jump.debug.phase

    // ---- jumps -----------------------------------------------------------------------------
    const j = this.jump.pushFrame(lm, tMs, world)
    const phaseNow = this.jump.debug.phase
    if (phaseBefore !== 'candidate' && phaseBefore !== 'airborne' && phaseNow === 'candidate') {
      this.takeoffMs = tMs
      this.turnActiveAtTakeoff = this.turn.isActive()
      // The turn the dancer is in, or has just come out of, at take-off: a calypso's entry.
      const active = this.turn.isActive() ? this.turn.debug.rotationDeg : 0
      const recent = this.closedTurns.filter((c) => tMs - c.endMs <= 1500)
      const best = recent.reduce((b, c) => (c.rotationDeg > b.rotationDeg ? c : b), { startMs: 0, endMs: -Infinity, rotationDeg: 0 })
      this.takeoffCtx = active >= best.rotationDeg
        ? { entryTurnDeg: active, entryTurnGapMs: active > 0 ? 0 : Infinity }
        : { entryTurnDeg: best.rotationDeg, entryTurnGapMs: tMs - best.endMs }
    }
    if (j) this.handleJump(j, tMs, out)

    // ---- arabesque ---------------------------------------------------------------------------
    const a = this.arabesque.pushFrame(lm, tMs, world)
    if (a) this.handleArabesque(a, tMs)

    // ---- kicks -----------------------------------------------------------------------------------
    const k = this.kick.pushFrame(lm, tMs, world)
    if (k) this.handleKick(k, tMs)

    // ---- illusions -------------------------------------------------------------------------------
    const ill = this.illusion.pushFrame(lm, tMs, world)

    // ---- turns ---------------------------------------------------------------------------------
    const r = this.turn.pushFrame(lm, tMs, world)
    if (r) {
      this.closedTurns.push({ startMs: r.startMs, endMs: r.endMs, rotationDeg: r.rotations * 360 })
      if (this.closedTurns.length > 6) this.closedTurns.shift()
      this.lastTurnEndMs = r.endMs
      this.pending.push({ kind: 'turn', releaseAt: tMs + (r.kind === 'chaine' ? this.cfg.chaineHoldMs : 0), ev: turnToMove(r, tMs) })
    }
    if (ill) this.handleIllusion(ill, tMs, out)

    this.release(tMs, out)
    return out
  }

  /**
   * The input has ended: an uploaded clip's last frame. Releases what was only being held for a
   * veto that can no longer come - a chaîné waiting to see whether a calypso follows, an arabesque
   * waiting to see whether a take-off or a turn follows. Vetoes that already fired still apply,
   * and a turn waiting on a flight the clip cut off is dropped with it. /live never calls this:
   * a camera's input does not end.
   */
  flush(tMs: number): MoveEvent[] {
    const out: MoveEvent[] = []
    const k = this.kick.flush()
    if (k) this.handleKick(k, tMs)
    const ill = this.illusion.flush()
    if (ill) this.handleIllusion(ill, tMs, out)
    for (const p of this.pending) p.releaseAt = -Infinity
    this.release(tMs, out)
    for (const p of this.pending) this.drop(tMs, `${p.ev.move} still waiting on a flight when the clip ended`)
    this.pending = []
    return out
  }

  private handleJump(j: JumpRepEvent, tMs: number, out: MoveEvent[]): void {
    const ctx = this.takeoffCtx
    // By height alone: a real leap out of a turn can be cut short by a landing read early, but it
    // still rose like a leap.
    const inTurn = this.turnActiveAtTakeoff && j.riseTorso < this.cfg.inTurnLeapMinRiseTorso
    this.takeoffMs = null
    this.turnActiveAtTakeoff = false
    this.takeoffCtx = { entryTurnDeg: 0, entryTurnGapMs: Infinity }
    if (inTurn) {
      this.flights.push({ takeoffMs: j.takeoffMs, landingMs: j.landingMs, move: 'in-turn hop' })
      this.drop(tMs, `hop inside a turn (rise ${j.riseTorso.toFixed(2)}, ${j.airborneMs.toFixed(0)} ms)`)
      return
    }
    const verdict = classifyJump(j, this.turn.recentSpins, ctx)
    if (verdict.kind === 'hop' || verdict.kind === 'sashay') {
      this.flights.push({ takeoffMs: j.takeoffMs, landingMs: j.landingMs, move: verdict.kind })
      this.drop(tMs, `${verdict.kind}: ${verdict.reason}`)
      return
    }
    const move: MoveKind = verdict.kind
    this.flights.push({ takeoffMs: j.takeoffMs, landingMs: j.landingMs, move })
    if (this.flights.length > 8) this.flights.shift()
    // A calypso absorbs the turn that led into it - whatever that turn looked like on its own
    // (a low chaîné with the kick starting reads as a passé turn as easily as a chaîné).
    if (move === 'calypso' && hasEntryTurn(ctx)) {
      const before = this.pending.length
      this.pending = this.pending.filter((p) => !(p.kind === 'turn' && p.ev.endMs >= j.takeoffMs - 1000))
      if (this.pending.length !== before) this.drop(tMs, 'entry turn absorbed into the calypso')
    }
    // While the body is tipped over, or an illusion's shape waits on its turn, a "flight" may be
    // the hips lifting in the illusion: it waits too.
    const held = this.illusion.inverted || this.pending.some((p) => p.kind === 'illusion')
    ;(held ? (ev: MoveEvent) => this.pending.push({ kind: 'jump', releaseAt: tMs, ev }) : (ev: MoveEvent) => out.push(ev))({
      move,
      tMs,
      startMs: j.takeoffMs,
      endMs: j.landingMs,
      detail: `${Math.round(j.airborneMs)} ms airtime`,
      metrics: move === 'jump' ? {} : jumpMetrics(move, j),
      log: `${move}: ${verdict.reason} [entry turn ${ctx.entryTurnDeg.toFixed(0)}deg, gap ${Number.isFinite(ctx.entryTurnGapMs) ? ctx.entryTurnGapMs.toFixed(0) : '-'} ms] (rise ${j.riseTorso.toFixed(2)}, ${j.airborneMs.toFixed(0)} ms, travel ${j.travelTorso.toFixed(2)}) spins[${this.turn.recentSpins.map((sp) => `${sp.rotationDeg.toFixed(0)}deg ${fmtT(sp.startMs)}-${fmtT(sp.endMs)}`).join('; ')}] takeoff ${fmtT(j.takeoffMs)} trace[${j.trace.map((x) => `${x.phase[0]}${Math.round(x.legAngleImage)}/${Math.round(x.legAngleWorld)}`).join(' ')}]`,
      source: { jump: j, jumpVerdict: verdict },
    })
  }

  private handleArabesque(a: ArabesqueEvent, tMs: number): void {
    const lastLanding = this.flights.length ? this.flights[this.flights.length - 1].landingMs : -Infinity
    const veto = this.inFlight() ? 'during a flight'
      : tMs - lastLanding < this.cfg.arabesqueAfterLandingMs ? 'just after a landing'
      : this.turn.isActive(this.cfg.vetoTurnMinDeg) ? 'during a turn'
      : tMs - this.lastTurnEndMs < this.cfg.arabesqueAfterTurnMs ? 'just after a turn'
      : null
    if (veto) {
      this.drop(tMs, `arabesque vetoed: ${veto}`)
      return
    }
    this.pending.push({
      kind: 'arabesque',
      releaseAt: tMs + this.cfg.arabesqueHoldMs,
      ev: {
        move: 'arabesque',
        tMs,
        startMs: a.startMs,
        endMs: a.endMs,
        detail: `${Math.round(a.peakArabesqueDeg)}° leg`,
        metrics: a.metrics,
        log: `arabesque ${a.workingLeg}: peak ${a.peakArabesqueDeg.toFixed(0)}deg`,
        source: { arabesque: a },
      },
    })
  }

  /** The shape of an illusion: held until its turn can be read (see resolveIllusion). */
  private handleIllusion(s: IllusionShape, tMs: number, _out: MoveEvent[]): void {
    this.pending.push({
      kind: 'illusion',
      releaseAt: tMs + this.cfg.illusionWaitMs,
      ev: {
        move: 'illusion',
        tMs,
        startMs: s.startMs,
        endMs: s.endMs,
        detail: `${Math.round(s.legDeg)}° leg`,
        metrics: s.metrics,
        log: `illusion: torso ${s.torsoDeg.toFixed(0)}, leg ${s.legDeg.toFixed(0)}`,
        source: { illusion: s },
      },
    })
  }

  /** Did the body turn over the illusion's shape? Every spin and closed turn near it counts. */
  private illusionTurned(ev: MoveEvent): number {
    const near = (a: { startMs: number; endMs: number }) => a.endMs >= ev.startMs - 600 && a.startMs <= ev.endMs + 600
    const spins = this.turn.recentSpins.filter(near).map((sp) => sp.rotationDeg)
    const turns = this.closedTurns.filter(near).map((t) => t.rotationDeg)
    return Math.max(0, ...spins, ...turns)
  }

  private handleKick(k: KickEvent, tMs: number): void {
    if (!k.kind) {
      this.drop(tMs, k.reason)
      return
    }
    // The arabesque detector saw the leg pass through an arabesque's angles on its way up or down.
    const before = this.pending.length
    this.pending = this.pending.filter((p) => !(p.kind === 'arabesque' && p.ev.endMs >= k.startMs - 300 && p.ev.startMs <= k.endMs + 300))
    if (this.pending.length !== before) this.drop(tMs, `arabesque replaced by the ${k.kind}`)
    // Held, like a turn, until any flight is decided: a leg thrown up in a leap is not a kick.
    this.pending.push({
      kind: 'kick',
      releaseAt: tMs,
      ev: {
        move: k.kind,
        tMs,
        startMs: k.startMs,
        endMs: k.endMs,
        detail: `${Math.round(k.peakDeg)}° kick`,
        metrics: k.metrics,
        log: k.reason,
        source: { kick: k },
      },
    })
  }

  private release(tMs: number, out: MoveEvent[]): void {
    if (!this.pending.length) return
    const flying = this.inFlight()
    const keep: Pending[] = []
    // Illusion shapes whose wait is over: confirmed by a turn, or not an illusion at all.
    for (const p of this.pending) {
      if (p.kind !== 'illusion' || tMs < p.releaseAt) continue
      const turned = this.illusionTurned(p.ev)
      if (turned >= this.cfg.illusionMinTurnDeg) {
        this.illusions.push({ startMs: p.ev.startMs, endMs: p.ev.endMs })
        if (this.illusions.length > 6) this.illusions.shift()
        p.ev.tMs = tMs
        p.ev.log += `, turned ${turned.toFixed(0)}`
        out.push(p.ev)
      } else {
        this.drop(tMs, `${p.ev.log} but turned only ${turned.toFixed(0)} degrees: not an illusion`)
      }
    }
    const undecided = this.pending.filter((p) => p.kind === 'illusion' && tMs < p.releaseAt)
    for (const p of this.pending) {
      if (p.kind === 'illusion') {
        if (tMs < p.releaseAt) keep.push(p)
        continue
      }
      const inside = (w: { startMs: number; endMs: number }) => p.ev.endMs >= w.startMs - 600 && p.ev.startMs <= w.endMs + 600
      // Anything inside an illusion is the illusion's: dropped once it is confirmed, held until then.
      if (this.illusions.some(inside)) {
        this.drop(tMs, `${p.ev.move} inside an illusion dropped`)
        continue
      }
      if (this.illusion.inverted || undecided.some((u) => inside(u.ev))) { keep.push(p); continue }
      if (p.kind === 'jump') { p.ev.tMs = tMs; out.push(p.ev); continue }
      if (p.kind === 'arabesque') {
        // A take-off or a turn starting during the hold means the leg was a preparation.
        if (flying || this.turn.isActive(this.cfg.vetoTurnMinDeg)) {
          this.drop(tMs, `arabesque vetoed: ${flying ? 'take-off followed' : 'turn followed'}`)
          continue
        }
        // A kick higher than any arabesque is under way: wait to see which way it went.
        if (this.kick.highKick) { keep.push(p); continue }
        if (tMs >= p.releaseAt) { p.ev.tMs = tMs; out.push(p.ev) } else keep.push(p)
        continue
      }
      // Turns and kicks wait until no flight is under way: a rotation that started in the air
      // belongs to that leap, and a chaîné may yet turn out to be a calypso's entry.
      if (this.flightPending() || tMs < p.releaseAt) { keep.push(p); continue }
      if (p.kind === 'kick') {
        // A leg in second whipping round a turn can read as a kick: wait for the turn to close.
        if (this.turn.isActive(90)) { keep.push(p); continue }
        const inTurn = this.closedTurns.find((t) => t.rotationDeg >= 300 && t.startMs <= p.ev.endMs && t.endMs >= p.ev.startMs)
        // A rise onto the toes in a kick reads as a hop; only a real jump owns the leg.
        const leap = this.flights.find((f) => !(f.move === 'hop' || f.move === 'sashay' || f.move === 'in-turn hop') &&
          f.takeoffMs <= p.ev.endMs && f.landingMs >= p.ev.startMs)
        if (inTurn) this.drop(tMs, `${p.ev.move} inside a turn dropped`)
        else if (leap) this.drop(tMs, `${p.ev.move} inside a ${leap.move} dropped`)
        else { p.ev.tMs = tMs; out.push(p.ev) }
        continue
      }
      const m = this.cfg.turnInFlightMarginMs
      // Only a real jump owns a rotation in its flight. A hop - in a pirouette's take-off, between
      // piqués - is part of the turn, not the other way round.
      // A rotation spanning a real leap's take-off belongs to the leap too: a side-on leap's
      // shoulders flicker through apparent "turns" in the air (a switch leap read as a 405-degree
      // chaîné, 19 degrees of it before take-off). A real turn INTO a leap is a calypso's entry
      // and is absorbed below.
      const owner = this.flights.find((f) => !(f.move === 'hop' || f.move === 'sashay' || f.move === 'in-turn hop') &&
        ((p.ev.startMs >= f.takeoffMs - m && p.ev.startMs <= f.landingMs + m) ||
         (p.ev.startMs < f.takeoffMs && p.ev.endMs > f.takeoffMs + m)))
      if (owner) {
        this.drop(tMs, `${p.ev.move} starting in a flight (${owner.move}) dropped`)
        continue
      }
      // The spin out of a russian or a calypso is part of the leap.
      const exitOf = this.flights.find((f) => (f.move === 'russian' || f.move === 'calypso') &&
        p.ev.startMs > f.landingMs && p.ev.startMs <= f.landingMs + this.cfg.leapExitTurnMs)
      if (exitOf) {
        this.drop(tMs, `${p.ev.move} out of the ${exitOf.move} dropped (${(p.ev.startMs - exitOf.landingMs).toFixed(0)} ms after landing)`)
        continue
      }
      if (this.flights.some((f) => f.move === 'calypso' && f.takeoffMs >= p.ev.startMs && f.takeoffMs <= p.ev.endMs + 1000)) {
        this.drop(tMs, `${p.ev.move} absorbed into the calypso`)
        continue
      }
      p.ev.tMs = tMs
      out.push(p.ev)
    }
    this.pending = keep
  }
}

function turnToMove(r: TurnEvent, tMs: number): MoveEvent {
  const move: MoveKind = r.kind === 'pirouette' ? 'pirouette'
    : r.kind === 'seconde' ? (r.changingSpot ? 'changingSpot' : 'seconde')
    : r.kind === 'chaine' ? 'chaine'
    : r.kind === 'pique' ? 'pique'
    : 'turnUnsure'
  const count = r.kind === 'pique' ? (r.turns ?? r.rotations) : r.kind === 'seconde' ? (r.secondeTurns ?? r.rotations) : r.rotations
  const detail = r.kind === 'seconde'
    ? `${r.secondeTurns} à la seconde${r.floaters ? ' with floaters' : ''}${r.finishTurns ? ` + ${r.finishTurns} pirouette` : ''}`
    : r.kind === 'pique' ? `${count} piqué turn${count === 1 ? '' : 's'}`
    : `${count} rotation${count === 1 ? '' : 's'}`
  return {
    move,
    tMs,
    startMs: r.startMs,
    endMs: r.endMs,
    detail,
    metrics: r.metrics,
    count,
    log: `${move} x${count}: ${r.reason}${r.secondeTurns !== undefined ? ` [seconde ${r.secondeTurns} + finish ${r.finishTurns}]` : ''}${r.turns !== undefined ? ` [turns ${r.turns}]` : ''} hops ${r.hops}`,
    source: { turn: r },
  }
}
