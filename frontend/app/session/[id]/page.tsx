'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { LOCAL_MODE, LOCAL_TOKEN } from '@/lib/local-mode'
import { CueCard, MoveAccordion, type Cue, type Move, type Report } from '@/app/analyze/AnalyzeClient'

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

interface SessionDetail {
  id:            string
  title:         string
  created_at:    string
  duration_s:    number | null
  overall_score: number | null
  move_counts:   Record<string, number> | null
  report:        Report | null
  video_url:     string | null
  thumb_url:     string | null
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })
  } catch {
    return iso
  }
}

export default function SessionPage() {
  const params    = useParams()
  const router    = useRouter()
  const supabase  = createClient()
  const sessionId = params?.id as string

  const [session, setSession]       = useState<SessionDetail | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [token, setToken]           = useState<string | null>(null)

  const [editing, setEditing]       = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [saving, setSaving]         = useState(false)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]           = useState(false)

  useEffect(() => {
    if (LOCAL_MODE) {
      setToken(LOCAL_TOKEN)
      if (sessionId) fetchSession(LOCAL_TOKEN, sessionId)
      else { setError('Not signed in'); setLoading(false) }
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      const tok = data.session?.access_token ?? null
      setToken(tok)
      if (tok && sessionId) fetchSession(tok, sessionId)
      else { setError('Not signed in'); setLoading(false) }
    })
  }, [sessionId])

  async function fetchSession(tok: string, id: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BACKEND}/sessions/${id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      if (res.status === 404) { setError('Session not found'); return }
      if (!res.ok) { setError('Failed to load session'); return }
      const data = await res.json()
      setSession(data)
      setTitleDraft(data.title)
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  async function handleRename() {
    if (!token || !session || !titleDraft.trim() || saving) return
    setSaving(true)
    try {
      const res = await fetch(`${BACKEND}/sessions/${session.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: titleDraft.trim() }),
      })
      if (res.ok) {
        setSession((s) => s ? { ...s, title: titleDraft.trim() } : s)
        setEditing(false)
      }
    } catch {
      // fail silently — user can retry
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!token || !session || deleting) return
    setDeleting(true)
    try {
      await fetch(`${BACKEND}/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      router.push('/analyze')
    } catch {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="font-elite text-xs text-muted uppercase tracking-widest">
          Loading session…
        </span>
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 space-y-6">
        <h1 className="font-anton text-3xl text-ink uppercase tracking-widest">Session</h1>
        <div className="bg-surface border-2 border-ink p-5">
          <p className="font-elite text-sm text-accent-deep uppercase tracking-widest">
            {error ?? 'Something went wrong'}
          </p>
        </div>
        <button
          onClick={() => router.push('/analyze')}
          className="font-elite text-sm text-muted hover:text-accent transition-colors"
        >
          ← Back to Analyze
        </button>
      </div>
    )
  }

  const report   = session.report
  const topCues: Cue[] = []
  if (report) {
    const cueMap: Record<string, Cue> = {}
    for (const move of report.moves) {
      for (const cue of move.top_cues) {
        if (!cueMap[cue.cue_id] || cue.score < cueMap[cue.cue_id].score) {
          cueMap[cue.cue_id] = cue
        }
      }
    }
    topCues.push(...Object.values(cueMap).slice(0, 5))
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">

      {/* Delete confirm overlay */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-ink/50 flex items-center justify-center z-50 px-4">
          <div className="bg-surface border-2 border-ink shadow-hard p-6 w-full max-w-sm space-y-4">
            <p className="font-anton text-xl text-ink uppercase tracking-widest">Delete Session?</p>
            <p className="font-grotesk text-sm text-ink/70">
              This will permanently delete the session, video, and all coaching data. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="font-elite text-xs uppercase tracking-widest px-4 py-2
                           border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{ transform: 'rotate(-2deg)' }}
                className="font-elite text-xs uppercase tracking-widest px-4 py-2
                           bg-accent text-paper border-2 border-ink shadow-hard
                           hover:bg-accent-deep transition-colors disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1 flex-1 min-w-0">
          <button
            onClick={() => router.push('/analyze')}
            className="font-elite text-xs uppercase tracking-widest text-muted
                       hover:text-accent transition-colors mb-2 block"
          >
            ← Sessions
          </button>

          {editing ? (
            <div className="flex gap-2 items-center">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename()
                  if (e.key === 'Escape') { setEditing(false); setTitleDraft(session.title) }
                }}
                className="border-2 border-ink bg-paper px-3 py-1.5 font-anton text-2xl text-ink
                           uppercase tracking-widest w-full max-w-md focus:border-accent transition-colors"
              />
              <button
                onClick={handleRename}
                disabled={saving || !titleDraft.trim()}
                style={{ transform: 'rotate(-2deg)' }}
                className="font-elite text-xs px-3 py-2 bg-accent text-paper border-2 border-ink shadow-hard
                           hover:bg-accent-deep transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {saving ? '…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditing(false); setTitleDraft(session.title) }}
                className="font-elite text-xs px-3 py-2 border-2 border-ink text-ink
                           hover:bg-ink hover:text-paper transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-left group"
              title="Click to rename"
            >
              <h1 className="font-anton text-3xl sm:text-4xl text-ink uppercase tracking-widest
                             group-hover:text-accent-deep transition-colors">
                {session.title}
              </h1>
            </button>
          )}

          <p className="font-elite text-xs text-muted">
            {formatDate(session.created_at)}
            {session.duration_s != null && ` · ${Math.round(session.duration_s)}s`}
          </p>
        </div>

        <button
          onClick={() => setConfirmDelete(true)}
          style={{ transform: 'rotate(-2deg)' }}
          className="font-elite text-xs uppercase tracking-widest px-4 py-2
                     bg-accent text-paper border-2 border-ink shadow-hard
                     hover:bg-accent-deep transition-colors
                     whitespace-nowrap self-start mt-7"
        >
          Delete
        </button>
      </div>

      {/* Score summary */}
      {report && !report.no_moves_detected && (
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

      {report?.no_moves_detected && (
        <div className="bg-surface border-2 border-ink p-5">
          <p className="font-elite text-sm uppercase tracking-widest text-accent-deep mb-1">
            No Dance Detected
          </p>
          <p className="font-grotesk text-sm text-ink">
            No technique elements were detected in this session.
          </p>
        </div>
      )}

      {/* Video + coaching */}
      {report && !report.no_moves_detected && (
        <div className="flex flex-col md:flex-row gap-6">
          <div className="md:w-2/5 flex-shrink-0">
            <div
              className="bg-surface border-2 border-ink shadow-[4px_4px_0_#1B2330] p-2"
              style={{ transform: 'rotate(-2deg)' }}
            >
              {session.video_url ? (
                <video
                  src={session.video_url}
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

      {/* Per-move details */}
      {report && report.moves.length > 0 && (
        <div className="space-y-2">
          <p className="font-elite text-xs uppercase tracking-widest text-muted mb-3">
            Move Metrics
          </p>
          {report.moves.map((move: Move, i: number) => (
            <MoveAccordion key={i} move={move} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
