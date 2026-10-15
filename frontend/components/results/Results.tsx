'use client'
// One analysed clip: what to work on, the video with its skeleton and a timeline of the moves,
// every move's score, and what /live would have said about each.
import { useEffect, useRef, useState } from 'react'
import type { MoveKind } from '@/lib/live/moveEngine'
import type { RepFeedback } from '@/lib/live/scoring'
import { FAMILY_LABEL, MOVE_TALLY, type MoveFamily } from '@/lib/moves'
import { formatTime, metricLabel, type ReportMove, type SessionReport } from '@/lib/upload/report'
import type { PoseTrack } from '@/lib/upload/poseTrack'
import Icon, { type IconName } from '@/components/ui/Icon'
import Mascot from '@/components/ui/Mascot'
import MoveIcon, { FAMILY_STYLE } from '@/components/ui/MoveIcon'
import SkeletonVideo from './SkeletonVideo'

const SHORT: Record<MoveKind, string> = {
  jump: 'Jump',
  split: 'Split',
  switch: 'Switch',
  calypso: 'Calypso',
  russian: 'Russian',
  leapUnsure: 'Leap?',
  firebird: 'Firebird',
  tiltJump: 'Tilt',
  switchTilt: 'Sw. tilt',
  switchArabesque: 'Sw. arab.',
  arabesque: 'Arabesque',
  frontBattement: 'Front',
  sideBattement: 'Side',
  fanKick: 'Fan',
  illusion: 'Illusion',
  pirouette: 'Pirouette',
  seconde: 'Second',
  changingSpot: 'Ch. spot',
  chaine: 'Chaînés',
  pique: 'Piqués',
  turnUnsure: 'Turn?',
}

/** A family's chart colour, for SVG marks. */
const FAMILY_FILL: Record<MoveFamily, string> = {
  leap: 'var(--color-chart-leap)',
  turn: 'var(--color-chart-turn)',
  hold: 'var(--color-chart-hold)',
}

const familyOf = (m: ReportMove): MoveFamily => m.family ?? 'leap'
const shortLabel = (m: ReportMove) => (m.move ? SHORT[m.move] : m.label.split(/[\s(]/)[0])
const isUnsure = (m: ReportMove) => m.move === 'leapUnsure' || m.move === 'turnUnsure'

export default function Results({
  report,
  videoSrc,
  track,
}: {
  report: SessionReport
  videoSrc: string | null
  track: PoseTrack | null
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [now, setNow] = useState(0)
  const [open, setOpen] = useState<Set<number>>(new Set())

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const tick = () => setNow(v.currentTime)
    v.addEventListener('timeupdate', tick)
    v.addEventListener('seeked', tick)
    return () => {
      v.removeEventListener('timeupdate', tick)
      v.removeEventListener('seeked', tick)
    }
  }, [videoSrc])

  const seekTo = (s: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, s - 0.3)
    v.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const showMove = (i: number) => {
    setOpen((o) => new Set(o).add(i))
    requestAnimationFrame(() => document.getElementById(`move-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }
  const toggle = (i: number) => setOpen((o) => {
    const n = new Set(o)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    return n
  })

  const duration = Math.max(report.duration_s, ...report.moves.map((m) => m.end_s), 0.1)
  const families = (['leap', 'turn', 'hold'] as MoveFamily[]).filter((f) => report.moves.some((m) => familyOf(m) === f))

  if (report.no_moves_detected) {
    return (
      <div className="space-y-6">
        <div className="card p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <Mascot color="lilac" width={120} look={-1} mood="oops" />
          <div className="space-y-2">
            <h2 className="font-display text-2xl font-extrabold">I couldn&rsquo;t spot a move I know</h2>
            <p className="text-muted">
              I coach split, switch, calypso, russian, firebird, tilt, switch tilt and switch arabesque leaps;
              pirouettes, second turns, changing-spot second turns, chaîné and piqué turns; front and side battements, fan
              kicks and illusions; arabesques and straight jumps. Check that your whole body stays in frame, head to toe,
              and that the clip keeps going for a second after your last move.
            </p>
          </div>
        </div>
        {videoSrc && (
          <div className="card p-3 sm:p-4">
            <SkeletonVideo src={videoSrc} track={track} videoRef={videoRef} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {report.legacy && (
        <p className="flex items-start gap-2 rounded-3xl bg-surface px-4 py-3 text-sm text-muted">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          This session was analyzed by the old detector, before uploads used the live coaching engine.
          Upload the clip again for the new feedback.
        </p>
      )}

      <Summary report={report} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <section className="card p-3 sm:p-4 space-y-3 lg:col-span-3" aria-label="Video">
          {videoSrc ? (
            <SkeletonVideo src={videoSrc} track={track} videoRef={videoRef} />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-[1.25rem] bg-sunken text-sm text-muted">
              Video not available
            </div>
          )}
          <Timeline moves={report.moves} duration={duration} now={now} onPick={(i) => { seekTo(report.moves[i].start_s); }} />
          <Legend families={families} />
        </section>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:col-span-2 lg:grid-cols-1">
          <FocusCard report={report} onSeek={seekTo} />
          <StrongestCard report={report} />
        </div>
      </div>

      <section className="card p-5 sm:p-6" aria-label="Score per move">
        <ScoreLine moves={report.moves} families={families} onPick={showMove} />
      </section>

      <section className="space-y-3" aria-label="Every move">
        <div className="flex items-end justify-between px-1">
          <h2 className="font-display text-2xl font-extrabold">Move by move</h2>
          <p className="text-sm text-muted">{report.moves.length} move{report.moves.length === 1 ? '' : 's'}</p>
        </div>
        {report.moves.map((m, i) => (
          <MoveCard key={i} index={i} move={m} open={open.has(i)} onToggle={() => toggle(i)} onSeek={() => seekTo(m.start_s)} />
        ))}
      </section>
    </div>
  )
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────

function Summary({ report }: { report: SessionReport }) {
  const tallies = Object.entries(report.counts) as Array<[MoveKind, number]>
  const total = report.moves.length
  const clean = report.moves.filter((m) => m.feedback.kind === 'praise').length
  const toWork = report.moves.filter((m) => m.feedback.kind === 'correction').length

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
        {/* The big number, like the reference's 78%. */}
        <div className="flex items-end justify-between gap-4 px-1">
          <div className="min-w-0">
            <p className="flex items-start font-display font-extrabold leading-[0.85] tracking-tight">
              <span className="text-[5.5rem] tabular-nums sm:text-[7rem]">{report.overall_score ?? '–'}</span>
              <span className="ml-1 mt-2 text-2xl text-muted sm:text-3xl">/100</span>
            </p>
            <p className="mt-3 font-bold">Technique score</p>
            {report.overall_score === null && <p className="text-sm text-muted">Nothing here had a shape to score</p>}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile icon="grid" badge="bg-teal text-surface" tile="bg-sage" value={total} label={total === 1 ? 'Move' : 'Moves'} />
          <StatTile icon="check" badge="bg-rose text-ink" tile="bg-rose-soft" value={clean} label="Nothing to fix" />
          <StatTile icon="pencil" badge="bg-gold text-ink" tile="bg-surface ring-1 ring-line" value={toWork} label="To work on" />
        </div>
      </div>

      {tallies.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {tallies.map(([k, n]) => (
            <span key={k} className="chip bg-surface">{MOVE_TALLY[k]} <span className="text-muted">{n}</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

/** What to work on first: the most fundamental correction, and where it first happened. */
function FocusCard({ report, onSeek }: { report: SessionReport; onSeek: (s: number) => void }) {
  return (
    <div className="flex h-full flex-col gap-3 rounded-[var(--radius-card)] bg-sun-soft p-6">
      <p className="eyebrow text-cocoa">Work on this first</p>
      {report.focus ? (
        <>
          <p className="font-display text-xl font-extrabold leading-snug">{report.focus.cue}</p>
          {report.focus.why && <p className="text-sm text-ink/80">{report.focus.why}</p>}
          {report.focus.label && report.focus.at_s !== undefined && (
            <button onClick={() => onSeek(report.focus!.at_s!)} className="btn btn-sm btn-dark mt-auto self-start">
              <Icon name="play" size={14} />
              {report.focus.times && report.focus.times > 1
                ? `${report.focus.times} moves · first at ${formatTime(report.focus.at_s)}`
                : `${report.focus.label} at ${formatTime(report.focus.at_s)}`}
            </button>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3">
          <Mascot width={64} mood="wink" />
          <p className="font-display text-xl font-extrabold leading-snug">Nothing to correct. Lovely.</p>
        </div>
      )}
    </div>
  )
}

/** The metric that scored best across the session. */
function StrongestCard({ report }: { report: SessionReport }) {
  return (
    <div className="flex h-full flex-col gap-3 rounded-[var(--radius-card)] bg-olive-soft p-6">
      <p className="eyebrow text-olive-deep">Your strongest</p>
      {report.strongest ? (
        <>
          <p className="font-display text-xl font-extrabold leading-snug">{report.strongest.label}</p>
          {report.strongest.score !== undefined && (
            <p className="text-sm text-ink/80">Scored {report.strongest.score}/100 on average</p>
          )}
          <Icon name="sparkle" size={28} className="mt-auto text-olive-deep" />
        </>
      ) : (
        <p className="text-sm text-ink/80">Nothing could be measured closely enough to pick a strength.</p>
      )}
    </div>
  )
}

/** One of the three tall tiles under the score: a round badge, a number, what it counts. */
function StatTile({ icon, badge, tile, value, label }: { icon: IconName; badge: string; tile: string; value: number; label: string }) {
  return (
    <div className={`flex flex-col items-center gap-2 rounded-[1.75rem] px-2 pb-4 pt-3 text-center ${tile}`}>
      <span className={`flex h-10 w-10 items-center justify-center rounded-full ${badge}`} aria-hidden>
        <Icon name={icon} size={18} />
      </span>
      <span className="font-display text-3xl font-extrabold leading-none tabular-nums">{value}</span>
      <span className="text-xs font-semibold leading-tight text-muted">{label}</span>
    </div>
  )
}

// ── Timeline under the video ─────────────────────────────────────────────────────────────────

function Timeline({ moves, duration, now, onPick }: {
  moves: ReportMove[]
  duration: number
  now: number
  onPick: (i: number) => void
}) {
  return (
    <div className="relative mx-1 h-8" aria-label="Moves on the video's timeline">
      <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-sunken" />
      {moves.map((m, i) => {
        const left = (m.start_s / duration) * 100
        const width = (Math.max(0, m.end_s - m.start_s) / duration) * 100
        return (
          <button
            key={i}
            onClick={() => onPick(i)}
            className="group absolute top-0 flex h-8 min-w-6 -translate-x-1 items-center"
            style={{ left: `${left}%`, width: `calc(${width}% + 8px)` }}
            aria-label={`Play ${m.label} at ${formatTime(m.start_s)}`}
            title={`${m.label} · ${formatTime(m.start_s)}`}
          >
            <span className={`h-4 w-full min-w-3 rounded-full ring-2 ring-surface transition-transform group-hover:scale-y-125 ${isUnsure(m) ? 'bg-sand' : FAMILY_STYLE[familyOf(m)].dot}`} />
          </button>
        )
      })}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-ink"
        style={{ left: `${Math.min(100, (now / duration) * 100)}%` }}
      />
    </div>
  )
}

function Legend({ families }: { families: MoveFamily[] }) {
  if (families.length < 2) return null
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs font-semibold text-muted">
      {families.map((f) => (
        <span key={f} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${FAMILY_STYLE[f].dot}`} />
          {FAMILY_LABEL[f]}
        </span>
      ))}
    </div>
  )
}

// ── Score per move ─────────────────────────────────────────────────────────────────────────

/**
 * The scored moves in order as a line, like the reference's progress chart: points in their
 * family's colour, the change from one move to the next in a bubble between them, and the
 * selected move's score in a dark tag (the lowest-scoring move until another is chosen). The
 * scale runs from a round number below the lowest score to 100, labelled, so a small dip is
 * visible without being exaggerated. Tap a point, or its name, to watch that move.
 */
function ScoreLine({ moves, families, onPick }: {
  moves: ReportMove[]
  families: MoveFamily[]
  onPick: (i: number) => void
}) {
  const pts = moves.flatMap((m, i) => (m.score === null ? [] : [{ m, i, score: m.score }]))
  const lowestAt = pts.reduce((best, p, k) => (best < 0 || p.score < pts[best].score ? k : best), -1)
  const [sel, setSel] = useState<number | null>(null)
  const active = sel ?? (lowestAt >= 0 ? lowestAt : null)
  const unscored = moves.length - pts.length
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const PAD_X = 30
  // Points spread to fill the card (64-150 px apart); more moves than fit, and it scrolls.
  const STEP = pts.length > 1 ? Math.max(64, Math.min(150, ((boxW || 320) - PAD_X * 2) / (pts.length - 1))) : 0
  const TOP = 48
  const BOTTOM = 156
  const H = 196
  const span = STEP * Math.max(0, pts.length - 1)
  const W = Math.max(boxW || 300, PAD_X * 2 + span)
  const left = (W - span) / 2
  const minScore = pts.length ? Math.min(...pts.map((p) => p.score)) : 0
  const floor = Math.max(0, Math.min(60, Math.floor((minScore - 10) / 10) * 10))
  const y = (score: number) => BOTTOM - ((score - floor) / (100 - floor)) * (BOTTOM - TOP)
  const xy = pts.map((p, k) => ({ x: left + k * STEP, y: y(p.score) }))

  // A smooth curve through the points (Catmull-Rom as cubic Béziers), kept inside the plot.
  const inPlot = (v: number) => Math.max(TOP - 8, Math.min(BOTTOM, v))
  let d = ''
  xy.forEach((p, k) => {
    if (k === 0) {
      d = `M${p.x},${p.y}`
      return
    }
    const p0 = xy[k - 2] ?? xy[k - 1]
    const p1 = xy[k - 1]
    const p3 = xy[k + 1] ?? p
    d += ` C${p1.x + (p.x - p0.x) / 6},${inPlot(p1.y + (p.y - p0.y) / 6)} ${p.x - (p3.x - p1.x) / 6},${inPlot(p.y - (p3.y - p1.y) / 6)} ${p.x},${p.y}`
  })
  const area = xy.length > 1 ? `${d} L${xy[xy.length - 1].x},${BOTTOM} L${xy[0].x},${BOTTOM} Z` : ''
  const ticks = [floor, Math.round((floor + 100) / 2), 100]

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <h2 className="font-display text-xl font-extrabold">Score per move</h2>
        <p className="text-sm text-muted">
          Each scored move in order. Tap one to watch it.
          {unscored > 0 && ` ${unscored} more counted without a score.`}
        </p>
      </div>
      {pts.length === 0 ? (
        <p className="rounded-2xl bg-sunken px-4 py-6 text-center text-sm text-muted">No move here had a shape to score.</p>
      ) : (
        <div
          ref={boxRef}
          className={`-mx-1 overflow-x-auto px-1 pb-1 ${W > boxW + 1 && boxW > 0 ? '[mask-image:linear-gradient(to_right,black_88%,transparent)]' : ''}`}
        >
          <div className="relative" style={{ width: W, height: H + 30 }}>
            <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" aria-hidden>
              <defs>
                <linearGradient id="score-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-rose)" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="var(--color-rose)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray="3 5" />
                  <text x={2} y={y(t) - 5} fontSize="10" fontWeight="600" fill="var(--color-muted)">{t}</text>
                </g>
              ))}
              {area && <path d={area} fill="url(#score-area)" />}
              {xy.length > 1 && <path d={d} fill="none" stroke="var(--color-rose)" strokeWidth="2.5" strokeLinecap="round" />}
              {active !== null && (
                <line x1={xy[active].x} x2={xy[active].x} y1={xy[active].y} y2={BOTTOM} stroke="var(--color-ink)" strokeDasharray="2 4" />
              )}
              {xy.map((p, k) => (
                <circle key={k} cx={p.x} cy={p.y} r={k === active ? 7.5 : 6} fill={FAMILY_FILL[familyOf(pts[k].m)]} stroke="var(--color-surface)" strokeWidth="2.5" />
              ))}
            </svg>

            {/* The change from one move to the next. */}
            {xy.slice(1).map((p, k) => {
              const delta = pts[k + 1].score - pts[k].score
              if (!delta) return null
              return (
                <span
                  key={k}
                  aria-hidden
                  className={`pointer-events-none absolute flex h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface px-1.5 text-[11px] font-extrabold tabular-nums ring-1 ring-line ${delta > 0 ? 'text-teal-deep' : 'text-rose-deep'}`}
                  style={{ left: (xy[k].x + p.x) / 2, top: (xy[k].y + p.y) / 2 + (delta > 0 ? 20 : -20) }}
                >
                  {delta > 0 ? '+' : '−'}{Math.abs(delta)}
                </span>
              )
            })}

            {active !== null && (
              <span
                className="pointer-events-none absolute -translate-x-1/2 rounded-full bg-ink px-2.5 py-1 text-xs font-extrabold tabular-nums text-surface"
                style={{ left: xy[active].x, top: xy[active].y - 38 }}
              >
                {pts[active].score}
              </span>
            )}

            {/* Points are big enough to tap through these columns; the names below are the buttons. */}
            {pts.map((p, k) => (
              <div
                key={`hit-${k}`}
                className="absolute top-0 cursor-pointer"
                style={{ left: xy[k].x - Math.max(STEP, 64) / 2, width: Math.max(STEP, 64), height: H - 14 }}
                onMouseEnter={() => setSel(k)}
                onClick={() => { setSel(k); onPick(p.i) }}
              />
            ))}
            {pts.map((p, k) => (
              <button
                key={`name-${k}`}
                onClick={() => { setSel(k); onPick(p.i) }}
                onMouseEnter={() => setSel(k)}
                onFocus={() => setSel(k)}
                className={`absolute -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-grape ${k === active ? 'bg-surface text-ink ring-1 ring-ink' : 'text-muted hover:text-ink'}`}
                style={{ left: xy[k].x, top: H - 8 }}
                aria-label={`${p.m.label} at ${formatTime(p.m.start_s)}: ${p.score} out of 100`}
              >
                {shortLabel(p.m)}
              </button>
            ))}
          </div>
        </div>
      )}
      <Legend families={families} />
    </div>
  )
}

// ── One move ─────────────────────────────────────────────────────────────────────────────

function MoveCard({ index, move, open, onToggle, onSeek }: {
  index: number
  move: ReportMove
  open: boolean
  onToggle: () => void
  onSeek: () => void
}) {
  const metrics = Object.entries(move.metric_scores)
  return (
    <article id={`move-${index}`} className="card scroll-mt-24 p-4 sm:p-5">
      <div className="flex items-center gap-3 sm:gap-4">
        <MoveIcon move={move.move} family={move.family} />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-extrabold leading-tight">{move.label}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <button onClick={onSeek} className="chip chip-btn bg-paper py-1 hover:bg-sunken" aria-label={`Play from ${formatTime(move.start_s)}`}>
              <Icon name="play" size={12} />
              <span className="tabular-nums">{formatTime(move.start_s)}</span>
            </button>
            {move.detail && <span className="text-sm text-muted">{move.detail}</span>}
          </div>
        </div>
        <ScoreBadge score={move.score} />
      </div>
      <div className="mt-3 sm:ml-[3.75rem]">
        <Feedback fb={move.feedback} />
      </div>

      {metrics.length > 0 && (
        <div className="mt-3 border-t border-line pt-3 sm:ml-[3.75rem]">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink" aria-expanded={open}>
            How it was scored
            <Icon name="chevronDown" size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <ul className="mt-3 space-y-2">
              {metrics.map(([k, s]) => (
                <li key={k} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
                  <span className="truncate">{metricLabel(k)}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-sunken">
                    <span className={`block h-full rounded-full ${FAMILY_STYLE[familyOf(move)].dot}`} style={{ width: `${s}%` }} />
                  </span>
                  <span className="text-right font-bold tabular-nums">{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="chip shrink-0 bg-sunken text-muted">Counted</span>
  }
  return (
    <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-full bg-sage">
      <span className="text-base font-extrabold leading-none">{score}</span>
      <span className="text-[10px] font-semibold text-muted">/100</span>
    </span>
  )
}

/** What was said about one move. `drill` adds the practice drill under a correction. */
export function Feedback({ fb, drill = true }: { fb: RepFeedback; drill?: boolean }) {
  switch (fb.kind) {
    case 'correction':
      return (
        <div className="space-y-2">
          <p className="font-semibold leading-snug">{fb.cue}</p>
          <p className="text-sm text-muted">{fb.why}</p>
          {drill && fb.drill && (
            <p className="rounded-2xl bg-paper px-3 py-2 text-sm"><span className="font-bold">Drill · </span>{fb.drill}</p>
          )}
          {fb.also.length > 0 && (
            <div className="pt-1">
              <p className="eyebrow">Also</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {fb.also.map((a) => <li key={a.cueId}>{a.cue}</li>)}
              </ul>
            </div>
          )}
        </div>
      )
    case 'praise':
      return (
        <div className="space-y-1.5">
          <span className="chip bg-olive-soft text-olive-deep"><Icon name="check" size={14} />Nothing to correct</span>
          <p className="font-semibold leading-snug">{fb.cue}</p>
          <p className="text-sm text-muted">{fb.why}</p>
        </div>
      )
    case 'fixed':
      return (
        <div className="space-y-1">
          <p className="font-semibold leading-snug">{fb.cue}</p>
          <p className="text-sm text-muted">{fb.why}</p>
        </div>
      )
    case 'unassessable':
      // Distinct from praise on purpose: this move could not be measured, so saying it was clean
      // would be a claim nothing supports.
      return (
        <p className="text-sm text-muted">
          Counted, but the key moment was too blurred or too quick for the camera to judge. Brighter
          light helps, and so does keeping your whole body in frame.
        </p>
      )
  }
}
