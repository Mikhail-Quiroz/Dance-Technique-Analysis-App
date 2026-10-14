// The session report an upload produces: every move the MoveEngine decided, with the same
// feedback /live gives for it, plus a short summary for the top of the results page. Pure, so
// it is tested on the real-footage fixtures (report.test.ts).
//
// Sessions saved by the old server pipeline have a different shape; normalizeReport() reads both.
import type { MoveEvent, MoveKind } from '../live/moveEngine'
import {
  cuePriority, jumpFeedback, leapUnsureFeedback, metricScores, selectFeedback, turnFeedback,
  type RepFeedback,
} from '../live/scoring'
import { MOVE_FAMILY, MOVE_LABEL, type MoveFamily } from '../moves'

export const REPORT_VERSION = 2

export interface ReportMove {
  /** null on a session from the old pipeline, whose move names were free text. */
  move: MoveKind | null
  label: string
  family: MoveFamily | null
  start_s: number
  end_s: number
  /** Short summary, e.g. "3 rotations" or "540 ms airtime". */
  detail: string
  /** Rotations for a turn, turns in a series. */
  count?: number
  /** Mean of the measured metric scores; null when the move is counted but not scored. */
  score: number | null
  feedback: RepFeedback
  metrics: Record<string, number | null>
  metric_scores: Record<string, number>
}

export interface ReportFocus {
  cue: string
  why?: string
  drill?: string
  /** The move it was first seen on, and when. */
  label?: string
  at_s?: number
  /** How many moves were given this correction. */
  times?: number
}

export interface SessionReport {
  version: typeof REPORT_VERSION
  duration_s: number
  overall_score: number | null
  no_moves_detected: boolean
  counts: Partial<Record<MoveKind, number>>
  focus: ReportFocus | null
  strongest: { metric?: string; label: string; score?: number } | null
  moves: ReportMove[]
  /** Read from a session the old server pipeline analysed. */
  legacy?: boolean
  /** A /live session (lib/live/highlights.ts liveReport); absent on uploads. */
  source?: 'live'
  /** How long a live session ran, s; its duration_s is the highlight reel's length. */
  session_s?: number
}

/** What /live says about a move; moves that are counted but not critiqued get a fixed cue. */
export function feedbackFor(ev: Pick<MoveEvent, 'move' | 'metrics'>): RepFeedback {
  if (ev.move === 'jump') return jumpFeedback()
  if (ev.move === 'leapUnsure') return leapUnsureFeedback()
  if (ev.move === 'turnUnsure') return turnFeedback()
  return selectFeedback(ev.metrics)
}

/** Labels for the metrics the move engine reports. Display text only; thresholds and cues live in shared/. */
export const METRIC_LABELS: Record<string, string> = {
  split_angle: 'Split angle',
  leap_back_leg_drop: 'Back leg height',
  front_leg_ext: 'Front knee',
  back_leg_ext: 'Back knee',
  torso_uprightness: 'Upright chest',
  land_plie: 'Landing plié',
  calypso_front_ext: 'Front knee',
  calypso_attitude_bend: 'Attitude shape',
  calypso_knee_lift: 'Attitude knee lift',
  calypso_back_height: 'Back thigh height',
  calypso_front_height: 'Front leg height',
  calypso_arch: 'Arch',
  russian_straddle: 'Straddle width',
  russian_leg_height: 'Leg height',
  russian_symmetry: 'Even legs',
  arabesque_height: 'Leg height',
  arabesque_knee_ext: 'Working knee',
  support_knee_ext: 'Standing knee',
  arabesque_chest: 'Chest lifted',
  arabesque_gaze: 'Gaze',
  passe_connection: 'Passé connection',
  turn_axis_tilt: 'Vertical axis',
  turn_hip_level: 'Level hips',
  arm_height_high: 'Arms not too high',
  arm_height_low: 'Arms not too low',
  elbow_drop: 'Lifted elbows',
  seconde_leg_height: 'Leg height',
  seconde_leg_knee: 'Working knee',
  seconde_height_drop: 'Leg stays up',
  seconde_travel: 'Stays in place',
  chaine_feet_apart: 'Feet together',
  chaine_arm_open: 'Arm control',
  tilt_leg_height: 'Tilt leg height',
  arabesque_leap_height: 'Arabesque leg height',
  kick_height: 'Kick height',
  kick_knee: 'Kicking knee',
  kick_support_knee: 'Standing knee',
  kick_arms_steady: 'Steady arms',
  illusion_leg_height: 'Leg height',
  illusion_support_knee: 'Standing knee',
  tilt_leg_knee: 'Tilt leg straight',
  arabesque_leap_back_knee: 'Back knee straight',
  floater_support_knee: 'Standing knee in floaters',
  fan_full_circle: 'Full circle',
}

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const round1 = (x: number) => Math.round(x * 10) / 10
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export function buildReport(events: MoveEvent[], durationMs: number): SessionReport {
  const moves: ReportMove[] = [...events]
    .sort((a, b) => a.startMs - b.startMs)
    .map((ev) => {
      const scores = metricScores(ev.metrics)
      const vals = Object.values(scores)
      return {
        move: ev.move,
        label: MOVE_LABEL[ev.move],
        family: MOVE_FAMILY[ev.move],
        start_s: round1(ev.startMs / 1000),
        end_s: round1(ev.endMs / 1000),
        detail: ev.detail,
        ...(ev.count !== undefined ? { count: ev.count } : {}),
        score: vals.length ? Math.round(mean(vals)) : null,
        feedback: feedbackFor(ev),
        metrics: ev.metrics,
        metric_scores: scores,
      }
    })

  const counts: Partial<Record<MoveKind, number>> = {}
  for (const m of moves) if (m.move) counts[m.move] = (counts[m.move] ?? 0) + 1

  const scored = moves.filter((m) => m.score !== null).map((m) => m.score as number)

  // The #1 focus: the most fundamental correction (cue_priority), then the most frequent - the
  // same rule as the old pipeline's session summary.
  const byCue = new Map<string, { first: ReportMove; times: number }>()
  for (const m of moves) {
    if (m.feedback.kind !== 'correction') continue
    const hit = byCue.get(m.feedback.cueId)
    if (hit) hit.times += 1
    else byCue.set(m.feedback.cueId, { first: m, times: 1 })
  }
  const focusEntry = [...byCue.entries()].sort(
    (a, b) => cuePriority(a[0]) - cuePriority(b[0]) || b[1].times - a[1].times,
  )[0]
  let focus: ReportFocus | null = null
  if (focusEntry) {
    const fb = focusEntry[1].first.feedback
    if (fb.kind === 'correction') {
      focus = {
        cue: fb.cue, why: fb.why, drill: fb.drill,
        label: focusEntry[1].first.label, at_s: focusEntry[1].first.start_s, times: focusEntry[1].times,
      }
    }
  }

  // Strongest: the metric with the best mean score, across every move that measured it.
  const perMetric = new Map<string, number[]>()
  for (const m of moves) for (const [k, v] of Object.entries(m.metric_scores)) {
    if (!perMetric.has(k)) perMetric.set(k, [])
    perMetric.get(k)!.push(v)
  }
  let strongest: SessionReport['strongest'] = null
  for (const [k, vs] of perMetric) {
    const s = Math.round(mean(vs))
    if (!strongest || s > (strongest.score ?? -1)) strongest = { metric: k, label: metricLabel(k), score: s }
  }

  return {
    version: REPORT_VERSION,
    duration_s: round1(durationMs / 1000),
    overall_score: scored.length ? Math.round(mean(scored)) : null,
    no_moves_detected: moves.length === 0,
    counts,
    focus,
    strongest,
    moves,
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions from the old server pipeline.
// ---------------------------------------------------------------------------------------------

interface LegacyCue { cue_id: string; cue: string; why: string; drill: string; score: number }
interface LegacyMove {
  move_type: string
  timestamp: string
  overall_score: number
  top_cues: LegacyCue[]
  scores: Record<string, number | null>
  raw_metrics: Record<string, number | string | null>
}
interface LegacyReport {
  overall_score: number
  strongest_area: string
  focus_area: string
  no_moves_detected: boolean
  moves: LegacyMove[]
}

function legacyFamily(label: string): MoveFamily {
  const l = label.toLowerCase()
  if (/turn|pirouette|chaîné|chaine|piqué|pique|fouetté|seconde/.test(l)) return 'turn'
  if (/arabesque|battement|développé|tilt/.test(l)) return 'hold'
  return 'leap'
}

/** "1:05" -> 65 */
function parseStamp(ts: string): number {
  const parts = String(ts).split(':').map(Number)
  if (parts.some((p) => !Number.isFinite(p))) return 0
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function fromLegacy(r: LegacyReport): SessionReport {
  const moves: ReportMove[] = (r.moves ?? []).map((m) => {
    const [top, ...rest] = m.top_cues ?? []
    const feedback: RepFeedback = top
      ? { kind: 'correction', cueId: top.cue_id, cue: top.cue, why: top.why, drill: top.drill, score: top.score,
          also: rest.map((c) => ({ cueId: c.cue_id, cue: c.cue, score: c.score })) }
      : { kind: 'unassessable' }
    const metric_scores: Record<string, number> = {}
    for (const [k, v] of Object.entries(m.scores ?? {})) if (typeof v === 'number') metric_scores[k] = v
    const metrics: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(m.raw_metrics ?? {})) if (typeof v === 'number' || v === null) metrics[k] = v
    const at = parseStamp(m.timestamp)
    return {
      move: null,
      label: m.move_type,
      family: legacyFamily(m.move_type),
      start_s: at,
      end_s: at,
      detail: '',
      score: typeof m.overall_score === 'number' ? m.overall_score : null,
      feedback,
      metrics,
      metric_scores,
    }
  })
  const okText = (s: unknown) => typeof s === 'string' && s && s !== 'N/A'
  return {
    version: REPORT_VERSION,
    duration_s: moves.length ? Math.max(...moves.map((m) => m.end_s)) : 0,
    overall_score: r.no_moves_detected ? null : r.overall_score ?? null,
    no_moves_detected: !!r.no_moves_detected,
    counts: {},
    focus: okText(r.focus_area) ? { cue: r.focus_area } : null,
    strongest: okText(r.strongest_area) ? { label: r.strongest_area } : null,
    moves,
    legacy: true,
  }
}

/** A stored report of either shape, as a version 2 report; null when there is none. */
export function normalizeReport(raw: unknown): SessionReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { version?: number }
  if (r.version === REPORT_VERSION) {
    // Kicks were a family of their own for a few days (2026-10-10 to 13); they are 'hold' now.
    const report = raw as SessionReport
    const isKick = (m: ReportMove) => (m.family as string) === 'kick'
    if (!report.moves.some(isKick)) return report
    return { ...report, moves: report.moves.map((m) => (isKick(m) ? { ...m, family: 'hold' as const } : m)) }
  }
  if (Array.isArray((raw as LegacyReport).moves)) return fromLegacy(raw as LegacyReport)
  return null
}

/** 65.3 -> "1:05" */
export function formatTime(s: number): string {
  const total = Math.max(0, Math.floor(s))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
