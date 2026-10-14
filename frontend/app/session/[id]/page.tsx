'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { deleteSession, displayTitle, formatDate, getSession, renameSession, useAuthToken, type SessionDetail } from '@/lib/sessions'
import { normalizeReport, type SessionReport } from '@/lib/upload/report'
import { trackFromGzip, type PoseTrack } from '@/lib/upload/poseTrack'
import Results from '@/components/results/Results'
import { ConfirmModal } from '@/components/sessions/SessionCards'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import ScreenColor from '@/components/ui/ScreenColor'

export default function SessionPage() {
  const params = useParams()
  const router = useRouter()
  const sessionId = params?.id as string
  const { token, ready } = useAuthToken()

  const [session, setSession] = useState<SessionDetail | null>(null)
  const [report, setReport] = useState<SessionReport | null>(null)
  const [track, setTrack] = useState<PoseTrack | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!ready) return
    if (!token || !sessionId) {
      setError('Sign in to see this session.')
      setLoading(false)
      return
    }
    let live = true
    getSession(token, sessionId)
      .then(async (s) => {
        if (!live) return
        if (!s) {
          setError('Session not found')
          return
        }
        setSession(s)
        setTitleDraft(displayTitle(s.title))
        setReport(normalizeReport(s.report))
        // The skeleton is a nicety: a session without its pose track still plays.
        if (s.pose_url) {
          try {
            const res = await fetch(s.pose_url)
            if (res.ok && live) setTrack(await trackFromGzip(await res.blob()))
          } catch { /* no skeleton */ }
        }
      })
      .catch(() => live && setError('Could not load this session. Please try again.'))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [ready, token, sessionId])

  async function handleRename() {
    if (!token || !session || !titleDraft.trim() || saving) return
    setSaving(true)
    if (await renameSession(token, session.id, titleDraft.trim())) {
      setSession((s) => (s ? { ...s, title: titleDraft.trim() } : s))
      setEditing(false)
    }
    setSaving(false)
  }

  async function handleDelete() {
    if (!token || !session || deleting) return
    setDeleting(true)
    if (await deleteSession(token, session.id)) router.push('/diary')
    else {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-16 text-muted sm:px-6">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink border-t-transparent" />
        Loading session…
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="mx-auto max-w-xl space-y-6 px-4 py-16 sm:px-6">
        <div className="card flex flex-col items-center gap-4 p-8 text-center">
          <Mascot color="blush" width={110} look={1} mood="oops" />
          <p className="font-display text-2xl font-extrabold">{error ?? 'Something went wrong'}</p>
          <button onClick={() => router.push('/diary')} className="btn btn-dark">
            <Icon name="arrowLeft" size={18} /> Back to sessions
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-screen="cream" className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <ScreenColor color="#F8F3DE" />
      {confirmDelete && (
        <ConfirmModal
          title="Delete session?"
          body="This permanently deletes the session, its video and its coaching. It can't be undone."
          confirm="Delete"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <button onClick={() => router.push('/diary')} className="icon-btn mt-1 shrink-0" aria-label="Back to sessions">
            <Icon name="arrowLeft" size={20} />
          </button>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename()
                    if (e.key === 'Escape') { setEditing(false); setTitleDraft(displayTitle(session.title)) }
                  }}
                  className="field max-w-md bg-surface font-display text-xl font-extrabold"
                  aria-label="Session name"
                />
                <button onClick={handleRename} disabled={saving || !titleDraft.trim()} className="btn btn-sun btn-sm">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => { setEditing(false); setTitleDraft(displayTitle(session.title)) }} className="btn btn-quiet btn-sm">
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setEditing(true)} className="group flex items-center gap-2 text-left" title="Rename">
                <h1 className="font-display text-2xl font-extrabold tracking-tight sm:text-4xl">{displayTitle(session.title)}</h1>
                <Icon name="pencil" size={18} className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <p className="mt-1 text-muted">
              {formatDate(session.created_at, true)}
            </p>
          </div>
        </div>
        <button onClick={() => setConfirmDelete(true)} className="btn btn-quiet btn-sm shrink-0 text-berry" aria-label="Delete session">
          <Icon name="trash" size={16} /> <span className="hidden sm:inline">Delete</span>
        </button>
      </div>

      {report ? (
        <Results report={report} videoSrc={session.video_url} track={track} />
      ) : (
        <p className="card p-5 text-muted">This session has no report.</p>
      )}
    </div>
  )
}
