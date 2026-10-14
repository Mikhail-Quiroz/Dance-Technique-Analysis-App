'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { deleteSession, displayTitle, listSessions, useAuthToken, type SessionSummary } from '@/lib/sessions'
import { ConfirmModal, SessionCard, useSessionActions } from '@/components/sessions/SessionCards'
import Icon from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import ScreenColor from '@/components/ui/ScreenColor'

type Order = 'latest' | 'top'
/** Cards on the cream sheet take turns in the three tints, like the reference's coloured cards. */
const TINTS = ['bg-rose-soft', 'bg-gold-soft', 'bg-teal-soft']
/** The podium: #1 rose, #2 cream, #3 gold, as in the reference's leaderboard. */
const PODIUM = ['bg-rose', 'bg-surface', 'bg-gold']

export default function SessionsClient() {
  const { token, ready } = useAuthToken()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [order, setOrder] = useState<Order>('latest')
  const [busy, setBusy] = useState(false)
  const actions = useSessionActions(token, setSessions)

  useEffect(() => {
    if (!ready) return
    if (!token) {
      setLoading(false)
      return
    }
    listSessions(token)
      .then(setSessions)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [ready, token])

  async function deleteAll() {
    if (!token) return
    setBusy(true)
    await Promise.all(sessions.map((s) => deleteSession(token, s.id)))
    setSessions([])
    setBusy(false)
    setConfirmAll(false)
  }

  const scored = sessions.filter((x) => typeof x.overall_score === 'number')
  const best = [...scored].sort((a, b) => (b.overall_score ?? 0) - (a.overall_score ?? 0)).slice(0, 3)
  const shown = order === 'top'
    ? [...sessions].sort((a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1))
    : sessions

  return (
    <div data-screen="teal" className="flex flex-1 flex-col">
      <ScreenColor color="#367E73" />
      {actions.dialogs}
      {confirmAll && (
        <ConfirmModal
          title="Delete every session?"
          body="This permanently deletes all your sessions, their videos and their coaching. It can't be undone."
          confirm="Delete all"
          busy={busy}
          onConfirm={deleteAll}
          onCancel={() => setConfirmAll(false)}
        />
      )}

      {/* On teal: the title, the order, and the podium. */}
      <header className="mx-auto w-full max-w-5xl space-y-5 px-5 pb-8 pt-3 text-surface sm:px-6 sm:pt-8">
        <div>
          <p className="eyebrow text-teal-soft">Your dancing</p>
          <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight">Sessions</h1>
        </div>

        {!loading && sessions.length > 1 && (
          <div className="inline-flex rounded-full bg-teal-deep p-1" role="group" aria-label="Order">
            {(['latest', 'top'] as Order[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrder(o)}
                aria-pressed={order === o}
                className={`rounded-full px-5 py-2 text-sm font-bold transition-colors ${order === o ? 'bg-surface text-ink' : 'text-surface hover:bg-teal-light/40'}`}
              >
                {o === 'latest' ? 'Latest' : 'Top scores'}
              </button>
            ))}
          </div>
        )}

        {best.length > 0 && (
          <ol className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Your best sessions">
            {best.map((x, i) => (
              <li key={x.id}>
                <Link
                  href={`/session/${x.id}`}
                  className={`flex items-center gap-3 rounded-full p-2 pr-3 text-ink shadow-[0_8px_20px_rgba(20,40,36,0.18)] transition-transform hover:-translate-y-0.5 ${PODIUM[i]}`}
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface/55" aria-hidden>
                    <Icon name="trophy" size={20} />
                  </span>
                  <span className="font-display text-2xl font-extrabold">#{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{displayTitle(x.title)}</span>
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface font-extrabold tabular-nums ring-2 ring-ink/10" aria-label={`Score ${x.overall_score}`}>
                    {x.overall_score}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </header>

      {/* The cream sheet with every session. */}
      <div className="sheet flex-1">
        <div className="mx-auto max-w-5xl px-4 pb-[calc(8rem+env(safe-area-inset-bottom))] pt-1 sm:px-6 sm:pb-16">
          {loading ? (
            <div className="flex items-center gap-3 py-8 text-muted">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink border-t-transparent" />
              Loading sessions…
            </div>
          ) : error ? (
            <p className="card p-5 text-berry">{error}</p>
          ) : sessions.length === 0 ? (
            <EmptySessions />
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-3 px-1">
                <h2 className="font-display text-2xl font-extrabold">
                  {order === 'top' ? 'Highest score first' : 'Newest first'}
                </h2>
                <button onClick={() => setConfirmAll(true)} className="btn btn-quiet btn-sm">
                  <Icon name="trash" size={16} /> Delete all
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-3">
                {shown.map((x, i) => (
                  <SessionCard key={x.id} session={x} onRename={actions.rename} onDelete={actions.remove} tint={TINTS[i % TINTS.length]} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function EmptySessions() {
  return (
    <div className="card flex flex-col items-center gap-4 px-6 py-12 text-center">
      <Mascot color="teal" width={120} look={1} mood="sleepy" />
      <div>
        <p className="font-display text-2xl font-extrabold">Nothing here yet</p>
        <p className="mt-1 text-muted">Upload a clip, or save a Live session, and its coaching will be kept here.</p>
      </div>
      <Link href="/analyze" className="btn btn-sun">
        <Icon name="upload" size={18} /> Upload a video
      </Link>
    </div>
  )
}
