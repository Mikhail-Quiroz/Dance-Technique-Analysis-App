'use client'
// Home's pieces (the upload page before a clip is picked): the greeting, the practice numbers, the
// latest session as a little player, and what the coach knows. The upload block itself stays in
// AnalyzeClient, which owns the file and the analysis.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { COACHED_MOVES, FAMILY_LABEL, MOVE_LABEL } from '@/lib/moves'
import { displayTitle, formatDate, type SessionSummary } from '@/lib/sessions'
import Icon, { type IconName } from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import { FAMILY_STYLE } from '@/components/ui/MoveIcon'

/** "Good evening" and today's date, read on this device (so not at build time). */
export function useToday(): { greeting: string; date: string } | null {
  const [today, setToday] = useState<{ greeting: string; date: string } | null>(null)
  useEffect(() => {
    const now = new Date()
    const h = now.getHours()
    setToday({
      greeting: h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening',
      date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    })
  }, [])
  return today
}

const moveTotal = (s: SessionSummary) => Object.values(s.move_counts ?? {}).reduce((a, b) => a + b, 0)

/** The three numbers under "Ready to dance?": sessions, average score, moves coached. */
export function PracticeStats({ sessions, loading }: { sessions: SessionSummary[]; loading: boolean }) {
  const scored = sessions.filter((s) => typeof s.overall_score === 'number')
  const avg = scored.length ? Math.round(scored.reduce((a, s) => a + (s.overall_score ?? 0), 0) / scored.length) : null
  const moves = sessions.reduce((a, s) => a + moveTotal(s), 0)
  const items: Array<{ icon: IconName; tint: string; label: string; value: string }> = [
    { icon: 'grid', tint: 'bg-teal-soft text-teal-deep', label: 'Sessions', value: loading ? '…' : String(sessions.length) },
    { icon: 'sparkle', tint: 'bg-rose-soft text-rose-deep', label: 'Average score', value: loading ? '…' : avg === null ? '–' : String(avg) },
    { icon: 'leap', tint: 'bg-gold-soft text-ink', label: 'Moves coached', value: loading ? '…' : String(moves) },
  ]
  return (
    <dl className="grid grid-cols-3 gap-2 sm:gap-4">
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${it.tint}`}>
            <Icon name={it.icon} size={20} />
          </span>
          <div className="min-w-0">
            <dt className="truncate text-xs font-semibold text-muted">{it.label}</dt>
            <dd className="font-display text-2xl font-extrabold leading-tight tabular-nums">{it.value}</dd>
          </div>
        </div>
      ))}
    </dl>
  )
}

/** A score as a ring: gold arc on a pale track, the number in the middle. */
export function ScoreRing({ score, size = 84, track = 'rgb(255 253 244 / 0.25)' }: { score: number | null; size?: number; track?: string }) {
  const r = 40
  const c = 2 * Math.PI * r
  const f = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke={track} strokeWidth="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-gold)" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${c * f} ${c}`} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-display text-2xl font-extrabold">{score ?? '–'}</span>
        <span className="mt-0.5 text-[10px] font-bold opacity-80">/100</span>
      </span>
    </span>
  )
}

/** The newest session, like a player: its score, its name, a big play button. */
export function LatestSession({ session, loading }: { session: SessionSummary | undefined; loading: boolean }) {
  return (
    <section className="relative overflow-hidden rounded-[2rem] bg-teal-deep p-5 text-surface sm:p-6" aria-label="Latest session">
      {/* the reference's curved bands, as two soft circles */}
      <span aria-hidden className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-teal-light/40" />
      <span aria-hidden className="absolute -bottom-24 -left-10 h-48 w-48 rounded-full bg-teal/60" />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <p className="eyebrow text-teal-soft">Latest session</p>
          <Link href="/diary" className="flex items-center gap-1 text-sm font-bold text-surface hover:underline">
            All sessions <Icon name="arrowRight" size={16} />
          </Link>
        </div>
        {loading ? (
          <p className="mt-4 text-teal-soft">Loading…</p>
        ) : !session ? (
          <div className="mt-3 flex items-center gap-4">
            <Mascot color="olive" width={84} mood="sleepy" />
            <p className="text-teal-soft">Your sessions will show up here: every upload, and every Live session you save.</p>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-4">
            <ScoreRing score={session.overall_score ?? null} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-xl font-extrabold">{displayTitle(session.title)}</p>
              <p className="text-sm text-teal-soft">
                {formatDate(session.created_at)}
                {moveTotal(session) > 0 && ` · ${moveTotal(session)} move${moveTotal(session) === 1 ? '' : 's'}`}
              </p>
            </div>
            <Link
              href={`/session/${session.id}`}
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface text-teal-deep ring-[6px] ring-teal-light/60 transition-transform hover:scale-105"
              aria-label={`Open ${displayTitle(session.title)}`}
            >
              <Icon name="play" size={22} />
            </Link>
          </div>
        )}
      </div>
    </section>
  )
}

export function CoachedMoves() {
  return (
    <section className="rounded-[var(--radius-card)] bg-sage p-5 sm:p-6">
      <h2 className="font-display text-xl font-extrabold">Moves I can coach</h2>
      <p className="mt-1 text-sm text-muted">
        Each one checked against real footage. I spot them myself, so there&rsquo;s no need to tell me what&rsquo;s in the clip.
      </p>
      {COACHED_MOVES.map((g) => (
        <div key={g.family} className="mt-4">
          <p className="eyebrow mb-2">{FAMILY_LABEL[g.family]}</p>
          <div className="flex flex-wrap gap-1.5">
            {g.moves.map((m) => (
              <span key={m} className={`chip ${FAMILY_STYLE[g.family].badge}`}>
                {m === 'jump' ? 'Straight jump' : MOVE_LABEL[m]}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

export function Tips({ className = '' }: { className?: string }) {
  return (
    <section className={`rounded-[var(--radius-card)] bg-rose-soft p-5 sm:p-6 ${className}`}>
      <h2 className="font-display text-xl font-extrabold">For the best read</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {[
          'Your whole body in frame, head to toe, the whole time',
          'One dancer and a steady camera',
          'Film leaps side-on, and turns and russians from the front',
          'Film front battements side-on, and side battements and fan kicks from the front',
          'Keep filming for a second after your last move',
        ].map((t) => (
          <li key={t} className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-rose-deep">
              <Icon name="check" size={13} strokeWidth={3} />
            </span>
            {t}
          </li>
        ))}
      </ul>
    </section>
  )
}
