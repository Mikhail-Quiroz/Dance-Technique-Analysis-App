'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { LOCAL_MODE, LOCAL_TOKEN } from '@/lib/local-mode'

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

// Must match _SEQ_MAP keys in backend/core/pipeline.py
const SEQUENCE_OPTIONS = [
  'Arabesque', 'Développé (front)', 'Développé (side)',
  'Grand Battement (front)', 'Grand Battement (back)', 'Grand Battement (side)',
  'Chaîné turns', 'Piqué turns', 'Fouetté turns',
  'Pirouette (passé/retiré)', 'Pirouette (en dehors)', 'Pirouette (en dedans)',
  'Turn à la seconde',
  'Jump / Sauté', 'Leap / Grand Jeté',
  'Changement', 'Saut de chat', 'Switch leap', 'Assemblé', 'Toe touch (jazz)',
  'Tour jeté', 'Tilt / layout', 'Calypso leap', 'Hitch kick',
]

const METRIC_LABELS: Record<string, string> = {
  front_leg_ext:          'Front leg extension',
  back_leg_ext:           'Back leg extension',
  back_leg_height:        'Back leg height (level)',
  point_feet:             'Foot point',
  split_angle:            'Split angle',
  torso_uprightness:      'Torso uprightness',
  land_plie:              'Landing plié depth',
  retire_dist:            'Retiré position',
  working_knee_fold:      'Working knee fold',
  releve_height:          'Relevé height',
  vert_stack:             'Vertical alignment',
  seconde_height:         'À la seconde height',
  seconde_knee_ext:       'Working knee extension',
  arabesque_height:       'Arabesque height (°)',
  arabesque_knee_ext:     'Working knee extension',
  support_knee_ext:       'Standing knee extension',
  arabesque_tilt:         'Torso tilt',
  hold_duration_s:        'Hold duration (s)',
  battement_height:       'Battement height (°)',
  battement_knee_ext:     'Working knee extension',
  battement_tilt:         'Torso tilt',
  plie_depth:             'Plié depth (°)',
  plie_back_vertical:     'Back vertical',
  ankle_wobble:           'Balance stability',
  travel_distance:        'Lateral drift',
  rotation_consistency:   'Rotation consistency',
  knee_oscillation:       'Fouetté action',
  knee_extension_max:     'Leg extension',
  feet_together:          'Feet together',
  ankle_join:             'Ankles joined',
  tilt_angle:             'Tilt angle (°)',
  tilt_hold_s:            'Tilt hold (s)',
  tilt_leg_line:          'Leg line',
}

function metricLabel(key: string) {
  return METRIC_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Cue {
  cue_id: string
  cue:    string
  why:    string
  drill:  string
  score:  number
}

export interface Move {
  move_type:     string
  timestamp:     string
  overall_score: number
  top_cues:      Cue[]
  scores:        Record<string, number | null>
  raw_metrics:   Record<string, number | string | null>
}

export interface Report {
  overall_score:      number
  strongest_area:     string
  focus_area:         string
  no_moves_detected:  boolean
  moves:              Move[]
}

interface SessionSummary {
  id:            string
  title:         string
  created_at:    string
  overall_score: number | null
  thumb_url:     string | null
}

type AppStage = 'idle' | 'uploading' | 'polling' | 'done' | 'error'

// ── Sub-components ────────────────────────────────────────────────────────────

function ProgressBar({ stage, percent }: { stage: string; percent: number }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="font-elite text-sm text-ink uppercase tracking-widest">
          {stage || 'Starting…'}
        </span>
        <span className="font-anton text-2xl text-accent">{percent}%</span>
      </div>
      <div className="h-2.5 bg-paper rounded-full overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-500 rounded-full"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export function CueCard({ cue }: { cue: Cue }) {
  return (
    <div className="bg-surface border-2 border-ink p-4 space-y-2">
      <p className="font-grotesk text-sm font-semibold text-ink leading-snug">
        {cue.cue}
      </p>
      <p className="font-grotesk text-base text-ink leading-relaxed">{cue.why}</p>
      <p className="font-grotesk text-sm text-muted border-t border-ink/10 pt-2 mt-1">
        Drill: {cue.drill}
      </p>
    </div>
  )
}

export function MoveAccordion({ move, index }: { move: Move; index: number }) {
  const [open, setOpen] = useState(false)
  const scored = Object.entries(move.scores).filter(([, v]) => v !== null)

  return (
    <div className="bg-surface border-2 border-ink overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 active:bg-accent active:text-paper"
      >
        <span className="font-anton text-sm uppercase tracking-wide text-left">
          Move {index} · {move.move_type}{' '}
          <span className="text-accent">@{move.timestamp}</span>
        </span>
        <span className="font-elite text-sm text-ink ml-2">
          {move.overall_score}/100 {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="border-t border-ink/10 px-4 py-3 space-y-2">
          {move.raw_metrics['accuracy_note'] && (
            <p className="font-elite text-xs text-muted">
              {String(move.raw_metrics['accuracy_note'])}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-grotesk border-collapse">
              <thead>
                <tr className="border-b border-ink/20">
                  <th className="text-left py-1 pr-4 font-elite uppercase tracking-wider text-muted">Metric</th>
                  <th className="text-right py-1 font-elite uppercase tracking-wider text-muted">Score</th>
                </tr>
              </thead>
              <tbody>
                {scored.map(([k, v]) => (
                  <tr key={k} className="border-b border-ink/10">
                    <td className="py-1 pr-4 text-ink/80">{metricLabel(k)}</td>
                    <td className="py-1 text-right font-elite text-ink">{v}/100</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export function Results({
  report,
  videoUrl,
  onReset,
}: {
  report: Report
  videoUrl: string | null
  onReset: () => void
}) {
  const cueMap: Record<string, Cue> = {}
  for (const move of report.moves) {
    for (const cue of move.top_cues) {
      if (!cueMap[cue.cue_id] || cue.score < cueMap[cue.cue_id].score) {
        cueMap[cue.cue_id] = cue
      }
    }
  }
  const topCues = Object.values(cueMap).slice(0, 5)

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-anton text-3xl text-ink uppercase tracking-widest">
          Results
        </h1>
        <button
          onClick={onReset}
          className="font-elite text-sm text-muted hover:text-accent transition-colors"
        >
          ← New video
        </button>
      </div>

      {report.no_moves_detected && (
        <div className="bg-surface border-2 border-ink p-5">
          <p className="font-elite text-sm uppercase tracking-widest text-accent-deep mb-1">
            No Dance Detected
          </p>
          <p className="font-grotesk text-sm text-ink">
            We couldn't find any jumps, turns, or other technique elements.
            Make sure the dancer's whole body is visible head-to-toe, the video
            is well lit, and there's actually dancing in the clip — then try again.
          </p>
        </div>
      )}

      {!report.no_moves_detected && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: 'Score',          value: `${report.overall_score}/100` },
            { label: 'Strongest Area', value: report.strongest_area         },
            { label: '#1 Focus',       value: report.focus_area             },
          ].map(({ label, value }) => (
            <div key={label} className="bg-surface border-2 border-ink shadow-hard p-5">
              <div
                className="inline-block bg-accent text-paper font-elite text-xs uppercase tracking-wider px-3 py-1 mb-3"
                style={{ transform: 'rotate(-2deg)' }}
              >
                {label}
              </div>
              <p className="font-grotesk text-xl text-ink font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}

      {!report.no_moves_detected && (
        <div className="flex flex-col md:flex-row gap-6">
          <div className="md:w-2/5 flex-shrink-0">
            <div
              className="bg-surface border-2 border-ink shadow-hard-lg p-2"
              style={{ transform: 'rotate(-2deg)' }}
            >
              {videoUrl ? (
                <video
                  src={videoUrl}
                  controls
                  playsInline
                  className="w-full"
                />
              ) : (
                <div className="w-full aspect-video bg-dark-section flex items-center justify-center">
                  <span className="font-elite text-xs text-paper opacity-40">
                    video not available
                  </span>
                </div>
              )}
              <p className="font-elite text-xs text-center text-muted mt-2">
                annotated · {report.moves.length} move{report.moves.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div className="flex-1 space-y-3">
            <div
              className="inline-block bg-accent text-paper font-elite text-xs uppercase tracking-wider px-3 py-1 mb-1 border-2 border-ink shadow-[2px_2px_0_#1B2330]"
              style={{ transform: 'rotate(-2deg)' }}
            >
              {topCues.length > 0 ? 'Top Corrections' : 'Great Technique!'}
            </div>
            {topCues.map((cue) => (
              <CueCard key={cue.cue_id} cue={cue} />
            ))}
          </div>
        </div>
      )}

      {report.moves.length > 0 && (
        <div className="space-y-2">
          <p className="font-elite text-xs uppercase tracking-widest text-muted mb-3">
            Move Metrics
          </p>
          {report.moves.map((move, i) => (
            <MoveAccordion key={i} move={move} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Diary grid ────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch {
    return iso
  }
}

function StarburstDoodle() {
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className="opacity-30" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i * 30 * Math.PI) / 180
        const x2 = 40 + 35 * Math.cos(angle)
        const y2 = 40 + 35 * Math.sin(angle)
        return <line key={i} x1="40" y1="40" x2={x2} y2={y2} stroke="#2074C4" strokeWidth="2" />
      })}
      <circle cx="40" cy="40" r="6" fill="#2074C4" />
    </svg>
  )
}

function EmptyDiaryState() {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <StarburstDoodle />
      <p className="font-yellowtail text-3xl text-ink/50">Nothing here yet</p>
      <p className="font-elite text-xs text-muted uppercase tracking-widest">
        Upload a video above to start your sessions
      </p>
    </div>
  )
}

function SessionCard({
  session,
  onRename,
  onDelete,
}: {
  session: SessionSummary
  onRename: (id: string, currentTitle: string) => void
  onDelete: (id: string) => void
}) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const score = session.overall_score

  return (
    <div
      className="relative group bg-surface border-2 border-ink cursor-pointer
                 transition-all duration-150 hover:-translate-y-0.5
                 active:translate-y-0"
      onClick={() => router.push(`/session/${session.id}`)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') router.push(`/session/${session.id}`) }}
    >
      {/* Thumbnail */}
      <div className="aspect-[4/3] overflow-hidden bg-dark-section">
        {session.thumb_url ? (
          <img
            src={session.thumb_url}
            alt={session.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="font-elite text-xs text-paper opacity-30 uppercase tracking-widest">
              no preview
            </span>
          </div>
        )}
      </div>

      {/* Score sticker */}
      {score !== null && score !== undefined && (
        <div
          className="absolute top-2 right-2 bg-accent text-paper font-grotesk font-bold
                     text-xs px-2 py-0.5 border border-accent-deep shadow-[2px_2px_0_#1B2330]"
          style={{ transform: 'rotate(-2deg)' }}
          aria-label={`Score ${score}`}
        >
          {score} ★
        </div>
      )}

      {/* Card body */}
      <div className="p-3 space-y-1">
        <p
          className="font-elite text-xs uppercase tracking-widest text-ink leading-tight line-clamp-2 min-h-[2.5rem]"
          title={session.title}
        >
          {session.title}
        </p>
        <p className="font-elite text-xs text-muted">
          {formatDate(session.created_at)}
        </p>
      </div>

      {/* ⋮ menu */}
      <div
        ref={menuRef}
        className="absolute bottom-3 right-3"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
          className="w-7 h-7 flex items-center justify-center bg-paper border-2 border-ink
                     font-grotesk text-ink text-sm opacity-0 group-hover:opacity-100
                     focus:opacity-100 transition-opacity"
          aria-label="Session options"
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="absolute bottom-8 right-0 bg-surface border-2 border-ink shadow-hard min-w-[120px] z-10 overflow-hidden">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onRename(session.id, session.title)
              }}
              className="w-full text-left px-3 py-2.5 font-elite text-xs uppercase tracking-wide
                         text-ink hover:bg-paper transition-colors"
            >
              Rename
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onDelete(session.id)
              }}
              className="w-full text-left px-3 py-2.5 font-elite text-xs uppercase tracking-wide
                         bg-accent text-paper hover:bg-accent-deep transition-colors border-t-2 border-ink"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function DiaryGrid({
  sessions,
  loading,
  onRename,
  onDelete,
  onDeleteAll,
}: {
  sessions: SessionSummary[]
  loading: boolean
  onRename: (id: string, currentTitle: string) => void
  onDelete: (id: string) => void
  onDeleteAll: () => void
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-anton text-3xl text-ink uppercase tracking-widest">Sessions</h2>
        {!loading && sessions.length > 0 && (
          <button
            onClick={onDeleteAll}
            className="font-elite text-xs uppercase tracking-wider border-2 border-ink
                       text-ink px-4 py-1.5 hover:bg-ink hover:text-paper transition-colors shadow-hard"
          >
            Delete all
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-3 py-8">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="font-elite text-xs text-muted uppercase tracking-widest">
            Loading sessions…
          </span>
        </div>
      ) : sessions.length === 0 ? (
        <EmptyDiaryState />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Rename modal ──────────────────────────────────────────────────────────────

function RenameModal({
  initialTitle,
  onConfirm,
  onCancel,
}: {
  initialTitle: string
  onConfirm: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialTitle)

  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="bg-surface border-2 border-ink shadow-hard p-6 w-full max-w-sm space-y-4">
        <p className="font-anton text-xl text-ink uppercase tracking-widest">Rename Session</p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value.trim())
            if (e.key === 'Escape') onCancel()
          }}
          className="w-full border-2 border-ink bg-paper px-3 py-2.5 font-grotesk text-sm text-ink focus:border-accent transition-colors"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(value.trim())}
            disabled={!value.trim()}
            style={{ transform: 'rotate(-2deg)' }}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       bg-accent text-paper border-2 border-ink shadow-hard
                       hover:bg-accent-deep transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete confirm ────────────────────────────────────────────────────────────

function DeleteConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="bg-surface border-2 border-ink shadow-hard p-6 w-full max-w-sm space-y-4">
        <p className="font-anton text-xl text-ink uppercase tracking-widest">Delete Session?</p>
        <p className="font-grotesk text-sm text-ink/70">
          This will permanently delete the session, video, and all coaching data. This cannot be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ transform: 'rotate(-2deg)' }}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       bg-accent text-paper border-2 border-ink shadow-hard
                       hover:bg-accent-deep transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete-all confirm ────────────────────────────────────────────────────────

function DeleteAllConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
      <div className="bg-surface border-2 border-ink shadow-hard p-6 w-full max-w-sm space-y-4">
        <p className="font-anton text-xl text-ink uppercase tracking-widest">Delete All Sessions?</p>
        <p className="font-grotesk text-sm text-ink/70">
          This will permanently delete all sessions, videos, and coaching data. This cannot be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ transform: 'rotate(-2deg)' }}
            className="font-elite text-xs uppercase tracking-widest px-4 py-2
                       bg-accent text-paper border-2 border-ink shadow-hard
                       hover:bg-accent-deep transition-colors"
          >
            Delete all
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalyzeClient() {
  const supabase = createClient()

  const [selectedMoves, setSelectedMoves] = useState<string[]>([])
  const [file, setFile]                   = useState<File | null>(null)
  const [appStage, setAppStage]           = useState<AppStage>('idle')
  const [progress, setProgress]           = useState<{ stage: string; percent: number }>({
    stage: '', percent: 0,
  })
  const [jobId, setJobId]         = useState<string | null>(null)
  const [report, setReport]       = useState<Report | null>(null)
  const [videoUrl, setVideoUrl]   = useState<string | null>(null)
  const [errorMsg, setErrorMsg]   = useState<string | null>(null)
  const [token, setToken]         = useState<string | null>(null)
  const pollRef                   = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileInputRef              = useRef<HTMLInputElement>(null)

  // Diary state
  const [sessions, setSessions]               = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [renameTarget, setRenameTarget]       = useState<{ id: string; title: string } | null>(null)
  const [deleteTarget, setDeleteTarget]       = useState<string | null>(null)
  const [deleteAllTarget, setDeleteAllTarget] = useState(false)

  useEffect(() => {
    // Recover a file picked before hydration finished: the native input
    // already holds it, but no onChange ever reached React state.
    const preSelected = fileInputRef.current?.files?.[0]
    if (preSelected) setFile(preSelected)

    if (LOCAL_MODE) {
      setToken(LOCAL_TOKEN)
      fetchSessions(LOCAL_TOKEN)
    } else {
      supabase.auth.getSession().then(({ data }) => {
        const tok = data.session?.access_token ?? null
        setToken(tok)
        if (tok) fetchSessions(tok)
        else setSessionsLoading(false)
      })
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function fetchSessions(tok: string) {
    setSessionsLoading(true)
    try {
      const res = await fetch(`${BACKEND}/sessions`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      if (res.ok) setSessions(await res.json())
    } catch {
      // Non-fatal — diary just stays empty
    } finally {
      setSessionsLoading(false)
    }
  }

  function toggleMove(move: string) {
    setSelectedMoves((prev) =>
      prev.includes(move) ? prev.filter((m) => m !== move) : [...prev, move],
    )
  }

  function startPolling(jid: string, authToken: string) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND}/jobs/${jid}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        if (!res.ok) return
        const data = await res.json()

        setProgress({ stage: data.stage ?? '', percent: data.percent ?? 0 })

        if (data.status === 'done') {
          clearInterval(pollRef.current!)
          setReport(data.result?.report ?? null)

          const vidUrl  = data.result?.video_url
          const vidPath = data.result?.video_path
          setVideoUrl(vidUrl ?? (vidPath ? `${BACKEND}${vidPath}?token=${authToken}` : null))

          setAppStage('done')
          fetchSessions(authToken)
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current!)
          setErrorMsg(data.error ?? 'Analysis failed — please try again.')
          setAppStage('error')
        }
      } catch {
        // Network hiccup during polling — keep retrying
      }
    }, 2000)
  }

  async function handleAnalyze() {
    if (!file) return
    setErrorMsg(null)

    const authToken = token
    if (!authToken) {
      setErrorMsg('Session expired — please sign in again.')
      return
    }

    setAppStage('uploading')
    setProgress({ stage: 'Uploading…', percent: 0 })

    const formData = new FormData()
    formData.append('video', file)
    formData.append('moves', JSON.stringify(selectedMoves))

    try {
      const res = await fetch(`${BACKEND}/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      })

      let body: Record<string, string>
      try { body = await res.json() } catch { body = {} }

      if (!res.ok) {
        throw new Error(body['detail'] ?? `Upload failed (HTTP ${res.status})`)
      }

      const jid = body['job_id']
      if (!jid) throw new Error('Server did not return a job ID.')

      setJobId(jid)
      setAppStage('polling')
      setProgress({ stage: 'Queued', percent: 0 })
      startPolling(jid, authToken)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed.'
      setErrorMsg(msg)
      setAppStage('error')
    }
  }

  function handleReset() {
    if (pollRef.current) clearInterval(pollRef.current)
    setFile(null)
    setSelectedMoves([])
    setAppStage('idle')
    setProgress({ stage: '', percent: 0 })
    setJobId(null)
    setReport(null)
    setVideoUrl(null)
    setErrorMsg(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleRename(id: string, newTitle: string) {
    setRenameTarget(null)
    if (!token || !newTitle) return
    try {
      const res = await fetch(`${BACKEND}/sessions/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: newTitle }),
      })
      if (res.ok) {
        setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title: newTitle } : s))
      }
    } catch {
      // Silently fail — user can retry
    }
  }

  async function handleDelete(id: string) {
    setDeleteTarget(null)
    if (!token) return
    try {
      await fetch(`${BACKEND}/sessions/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch {
      // Silently fail — user can retry
    }
  }

  async function handleDeleteAll() {
    setDeleteAllTarget(false)
    if (!token) return
    try {
      await Promise.all(
        sessions.map((s) =>
          fetch(`${BACKEND}/sessions/${s.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }),
        ),
      )
      setSessions([])
    } catch {
      // Silently fail — user can retry
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-16">

      {/* Modals */}
      {renameTarget && (
        <RenameModal
          initialTitle={renameTarget.title}
          onConfirm={(title) => handleRename(renameTarget.id, title)}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteConfirm
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {deleteAllTarget && (
        <DeleteAllConfirm
          onConfirm={handleDeleteAll}
          onCancel={() => setDeleteAllTarget(false)}
        />
      )}

      {/* ── TOP: analysis section ── */}
      <section>
        {appStage === 'done' && report && (
          <Results report={report} videoUrl={videoUrl} onReset={handleReset} />
        )}

        {appStage === 'error' && (
          <div className="space-y-6">
            <h1 className="font-anton text-3xl text-ink uppercase tracking-widest">Analyze</h1>
            <div className="bg-surface border-2 border-ink p-5">
              <p className="font-elite text-sm uppercase tracking-widest text-accent-deep mb-1">
                Something went wrong
              </p>
              <p className="font-grotesk text-sm text-ink">{errorMsg}</p>
            </div>
            <button
              onClick={handleReset}
              className="font-elite text-sm text-muted hover:text-accent transition-colors"
            >
              ← Try again
            </button>
          </div>
        )}

        {(appStage === 'idle' || appStage === 'uploading' || appStage === 'polling') && (
          <div className="max-w-2xl space-y-8">
            <h1 className="font-anton text-3xl text-ink uppercase tracking-widest">Analyze</h1>

            {errorMsg && (
              <div className="bg-surface border-2 border-ink p-4">
                <p className="font-grotesk text-sm text-ink/80">{errorMsg}</p>
              </div>
            )}

            {(appStage === 'uploading' || appStage === 'polling') && (
              <div className="bg-surface border-2 border-ink p-6">
                <ProgressBar stage={progress.stage} percent={progress.percent} />
                <p className="font-elite text-xs text-muted mt-4 text-center">
                  {appStage === 'uploading'
                    ? 'Uploading your video…'
                    : 'Analyzing — this takes a minute for a full clip'}
                </p>
              </div>
            )}

            {appStage === 'idle' && (
              <div className="space-y-6">
                <div className="bg-surface border-2 border-ink p-6">
                  <label
                    htmlFor="video-input"
                    className="block font-elite text-xs uppercase tracking-widest text-muted mb-3"
                  >
                    Upload video (.mp4 / .mov · max 200 MB · max 90 s)
                  </label>
                  <input
                    id="video-input"
                    ref={fileInputRef}
                    type="file"
                    accept="video/mp4,video/quicktime,video/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block w-full font-grotesk text-sm text-ink
                               file:mr-4 file:py-2.5 file:px-5
                               file:border-2 file:border-ink
                               file:bg-accent file:text-paper
                               file:font-elite file:text-xs file:uppercase file:tracking-wider
                               file:cursor-pointer
                               hover:file:bg-accent-deep
                               transition-colors"
                  />
                  {file && (
                    <p className="font-elite text-xs text-muted mt-2">
                      {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  )}
                </div>

                <div className="bg-surface border-2 border-ink p-5">
                  <p className="font-elite text-xs uppercase tracking-widest text-ink mb-1">
                    Moves in this video
                  </p>
                  <p className="font-grotesk text-xs text-muted mb-4">
                    Tap to select — leave empty for auto-detection of jumps &amp; turns.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SEQUENCE_OPTIONS.map((move) => {
                      const active = selectedMoves.includes(move)
                      return (
                        <button
                          key={move}
                          onClick={() => toggleMove(move)}
                          className={[
                            'px-3 py-1.5 font-elite text-xs uppercase tracking-wide transition-colors',
                            active
                              ? 'bg-accent text-paper border-2 border-ink shadow-[2px_2px_0_#1B2330]'
                              : 'bg-paper text-ink border-2 border-ink hover:bg-accent hover:text-paper',
                          ].join(' ')}
                        >
                          {move}
                        </button>
                      )
                    })}
                  </div>
                  {selectedMoves.length > 0 && (
                    <button
                      onClick={() => setSelectedMoves([])}
                      className="mt-3 font-elite text-xs text-muted underline"
                    >
                      Clear selection
                    </button>
                  )}
                </div>

                <button
                  onClick={handleAnalyze}
                  disabled={!file}
                  className={[
                    'w-full py-4 font-anton text-lg uppercase tracking-widest transition-colors border-2 border-ink',
                    file
                      ? 'bg-accent text-paper hover:bg-accent-deep shadow-hard-lg cursor-pointer'
                      : 'bg-ink/10 text-ink/40 cursor-not-allowed opacity-40',
                  ].join(' ')}
                >
                  Analyze
                </button>

                <div className="bg-surface border-2 border-ink px-4 py-4">
                  <p className="font-elite text-xs uppercase tracking-widest text-muted mb-2">
                    Recording Tips
                  </p>
                  <ul className="font-grotesk text-xs text-ink/70 space-y-1 list-disc list-inside">
                    <li>Whole body head-to-toe visible at all times</li>
                    <li>One dancer in frame, plain background</li>
                    <li>30+ FPS recommended for fast moves</li>
                    <li>Side-on for leaps/jumps · Front-on for turns</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── BOTTOM: sessions grid ── */}
      <DiaryGrid
        sessions={sessions}
        loading={sessionsLoading}
        onRename={(id, title) => setRenameTarget({ id, title })}
        onDelete={(id) => setDeleteTarget(id)}
        onDeleteAll={() => setDeleteAllTarget(true)}
      />
    </div>
  )
}
