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

export interface TopCue {
  cueId: string
  cue: string
  why: string
  drill: string
  score: number
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
  return { cueId, cue: entry.cue, why: entry.why, drill: entry.drill, score }
}
