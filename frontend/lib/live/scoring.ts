// Streaming TS port of the scoring half of analysis/feedback.py: score_metric() and the
// cue-selection logic in build_move_feedback(). Reads shared/thresholds.json + cues.json
// (synced by scripts/copy-shared.mjs) so cue text and thresholds are never duplicated here
// per CLAUDE.md's single-source-of-truth rule.
import thresholds from './shared/thresholds.json'
import cuesData from './shared/cues.json'

interface ScoreConfigEntry {
  excellent: number
  poor: number
  invert: boolean
}

const SCORE_CONFIG: Record<string, ScoreConfigEntry> = thresholds.score_config
const METRIC_TO_CUE: Record<string, string> = thresholds.metric_to_cue
const CUE_PRIORITY: string[] = thresholds.cue_priority
const CUES: Record<string, { cue: string; why: string; drill: string }> = cuesData

const NEEDS_IMPROVEMENT_THRESHOLD = 80

/** How many further corrections are shown under the main one. */
const MAX_ALSO = 2

export interface TopCue {
  cueId: string
  cue: string
  why: string
  drill: string
  score: number
  /**
   * The next corrections in priority order, cue text only. The main cue is still the one to
   * fix first; these are here so a rep with several faults does not look like it has one.
   */
  also: Array<{ cueId: string; cue: string; score: number }>
}

/** 100 at/above excellent, 0 at/below poor, linear in between. invert: lower value is better. */
export function scoreMetric(value: number, excellent: number, poor: number, invert = false): number {
  if (invert) {
    ;[excellent, poor] = [poor, excellent]
    if (value >= excellent) return 0
    if (value <= poor) return 100
    return Math.round((100 * (excellent - value)) / (excellent - poor))
  }
  if (value >= excellent) return 100
  if (value <= poor) return 0
  return Math.round((100 * (value - poor)) / (excellent - poor))
}

/** 0-100 for every metric that has a threshold and was measured. Metrics without one are left out. */
export function metricScores(metrics: Record<string, number | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [metricKey, config] of Object.entries(SCORE_CONFIG)) {
    const val = metrics[metricKey]
    if (val === null || val === undefined) continue
    out[metricKey] = scoreMetric(val, config.excellent, config.poor, config.invert)
  }
  return out
}

/** Where a cue sits in cue_priority: lower is more fundamental. Unlisted cues come last. */
export function cuePriority(cueId: string): number {
  const idx = CUE_PRIORITY.indexOf(cueId)
  return idx === -1 ? CUE_PRIORITY.length : idx
}

/**
 * Score every available metric, dedupe by cue_id keeping the worst (lowest) score, drop
 * anything scoring >= 80, sort by (cue_priority tier, score) and return just the single
 * top entry — same algorithm as build_move_feedback, but "top cue per rep" (singular) per
 * the ROADMAP, vs. the upload pipeline's top 3.
 */
export function selectTopCue(metrics: Record<string, number | null | undefined>): TopCue | null {
  const cueScores = new Map<string, number>()

  for (const [metricKey, config] of Object.entries(SCORE_CONFIG)) {
    const val = metrics[metricKey]
    if (val === null || val === undefined) continue
    const score = scoreMetric(val, config.excellent, config.poor, config.invert)
    const cueId = METRIC_TO_CUE[metricKey]
    if (!cueId) continue
    const existing = cueScores.get(cueId)
    if (existing === undefined || score < existing) cueScores.set(cueId, score)
  }

  const priorityOf = (cueId: string) => {
    const idx = CUE_PRIORITY.indexOf(cueId)
    return idx === -1 ? CUE_PRIORITY.length : idx
  }

  const candidates = [...cueScores.entries()]
    .filter(([, score]) => score < NEEDS_IMPROVEMENT_THRESHOLD)
    .sort((a, b) => {
      const pa = priorityOf(a[0])
      const pb = priorityOf(b[0])
      if (pa !== pb) return pa - pb
      return a[1] - b[1]
    })

  if (candidates.length === 0) return null
  const [cueId, score] = candidates[0]
  const entry = CUES[cueId]
  if (!entry) return null
  const also = candidates
    .slice(1)
    .filter(([id]) => CUES[id])
    .slice(0, MAX_ALSO)
    .map(([id, s]) => ({ cueId: id, cue: CUES[id].cue, score: s }))
  return { cueId, cue: entry.cue, why: entry.why, drill: entry.drill, score, also }
}

// ---------------------------------------------------------------------------
// Praise.
//
// selectTopCue above returns null for TWO very different situations: "every metric
// scored well" and "no metric could be measured at all". The /live page rendered both
// as encouragement, which meant the worse the tracking, the better the feedback — and
// because a real rep almost always has one metric under 80, the praise branch was
// effectively unreachable in practice. selectFeedback separates the three outcomes so
// a caller can say something true about each.
// ---------------------------------------------------------------------------

const METRIC_TO_PRAISE: Record<string, string> = thresholds.metric_to_praise
const PRAISE_FALLBACK: string = thresholds.praise_fallback

export interface CorrectionFeedback {
  kind: 'correction'
  cueId: string
  cue: string
  why: string
  drill: string
  /** 0-100 for the metric that triggered the correction. */
  score: number
  /** Further corrections, lower priority than this one. */
  also: Array<{ cueId: string; cue: string; score: number }>
}

export interface PraiseFeedback {
  kind: 'praise'
  cueId: string
  cue: string
  why: string
  drill: string
  /** Mean score across every metric that could be assessed. */
  score: number
  /** The metric that scored best — what the praise is actually about. */
  bestMetric: string
}

/** Nothing could be measured, so nothing true can be said about the rep. */
export interface UnassessableFeedback {
  kind: 'unassessable'
}

/** A move with no score at all — one fixed cue about what the shape was missing. */
export interface FixedFeedback {
  kind: 'fixed'
  cueId: string
  cue: string
  why: string
  drill: string
}

export type RepFeedback = CorrectionFeedback | PraiseFeedback | UnassessableFeedback | FixedFeedback

/**
 * Full verdict for one rep: a correction if anything scored below the threshold, praise
 * if everything cleared it, and 'unassessable' if not a single metric was measurable.
 *
 * Praise names the metric the dancer scored HIGHEST on, so it says something specific
 * about the rep rather than a generic well-done.
 */
export function selectFeedback(metrics: Record<string, number | null | undefined>): RepFeedback {
  const correction = selectTopCue(metrics)
  if (correction) return { kind: 'correction', ...correction }

  const scored: Array<{ metric: string; score: number }> = []
  for (const [metricKey, config] of Object.entries(SCORE_CONFIG)) {
    const val = metrics[metricKey]
    if (val === null || val === undefined) continue
    scored.push({ metric: metricKey, score: scoreMetric(val, config.excellent, config.poor, config.invert) })
  }

  if (scored.length === 0) return { kind: 'unassessable' }

  // Praise requires FULL coverage: every metric the detector offered was measurable.
  //
  // A null metric is silently skipped when scoring, so anything unmeasurable simply
  // cannot count against the rep — which made the verdict non-monotonic. With the legs
  // closed, one knee occludes the other, that leg's extension drops out (measured: 81
  // degrees -> null), and the remaining straight leg becomes the best metric, so a badly
  // bent pair of legs was praised for its "fully extended" line. Detectors omit metrics
  // that do not APPLY to a move, so a null here always means "tried and failed", and
  // "nothing to correct" is only honest when there was nothing we failed to look at.
  const offered = Object.keys(metrics).filter((k) => SCORE_CONFIG[k] !== undefined)
  const unmeasured = offered.filter((k) => metrics[k] === null || metrics[k] === undefined)
  if (unmeasured.length > 0) return { kind: 'unassessable' }

  let best = scored[0]
  for (const s of scored) if (s.score > best.score) best = s
  const mean = Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length)

  const cueId = METRIC_TO_PRAISE[best.metric] ?? PRAISE_FALLBACK
  const entry = CUES[cueId] ?? CUES[PRAISE_FALLBACK]
  if (!entry) return { kind: 'unassessable' }

  return {
    kind: 'praise',
    cueId,
    cue: entry.cue,
    why: entry.why,
    drill: entry.drill,
    score: mean,
    bestMetric: best.metric,
  }
}

/**
 * A straight jump with the legs together is not a technique move this app scores, so it
 * never goes through selectFeedback - a numeric score it could ace by keeping its legs straight
 * would be meaningless. It gets one fixed cue saying it was counted. (It used to tell the dancer
 * to split into a leap, from when leaps were often misread as jumps; with the two told apart
 * reliably, that corrected every straight jump the dancer meant to do.)
 */
export const JUMP_CUE_ID = 'straight_jump_counted'

export function jumpFeedback(): FixedFeedback | UnassessableFeedback {
  const entry = CUES[JUMP_CUE_ID]
  if (!entry) return { kind: 'unassessable' }
  return { kind: 'fixed', cueId: JUMP_CUE_ID, cue: entry.cue, why: entry.why, drill: entry.drill }
}

/**
 * A turn the detector could not identify as a pirouette (no passé) is counted but never
 * scored — the same structural guarantee as jumpFeedback: its metrics object is empty.
 */
export const TURN_CUE_ID = 'turn_not_pirouette'

export function turnFeedback(): FixedFeedback | UnassessableFeedback {
  const entry = CUES[TURN_CUE_ID]
  if (!entry) return { kind: 'unassessable' }
  return { kind: 'fixed', cueId: TURN_CUE_ID, cue: entry.cue, why: entry.why, drill: entry.drill }
}

/**
 * A leap whose TYPE could not be confirmed — counted, never scored, the same
 * guarantee as turnFeedback.
 */
export const LEAP_UNSURE_CUE_ID = 'leap_type_unsure'

export function leapUnsureFeedback(): FixedFeedback | UnassessableFeedback {
  const entry = CUES[LEAP_UNSURE_CUE_ID]
  if (!entry) return { kind: 'unassessable' }
  return { kind: 'fixed', cueId: LEAP_UNSURE_CUE_ID, cue: entry.cue, why: entry.why, drill: entry.drill }
}
