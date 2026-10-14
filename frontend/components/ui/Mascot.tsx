// "Pip", the app's mascot: a little dome with a ballet bun, a smile and eyes that blink now and
// then. Placements tint it from the palette so it does not repeat itself, and give it a mood that
// fits the moment (a wink when there is nothing to correct, oops on errors, sleepy on empty states).
// Purely decorative.
export type MascotMood = 'happy' | 'wink' | 'oops' | 'sleepy'

const FILL = {
  /** Gold: Pip's own colour (the logo, the app icon). */
  sun: '#F5B13D',
  rose: '#E76E84',
  /** Soft rose. */
  lilac: '#F4A3B4',
  teal: '#4C998C',
  /** Light teal. */
  olive: '#8CCBBE',
  lime: '#B9D27A',
  blush: '#F7B6A8',
  cream: '#FFFDF4',
  cocoa: '#2B6B60',
  sand: '#EADFD0',
} as const

export type MascotColor = keyof typeof FILL

const INK = '#1E1C19'

export default function Mascot({
  color = 'sun',
  width = 96,
  className = '',
  look = 0,
  mood = 'happy',
}: {
  color?: MascotColor
  width?: number
  className?: string
  /** Where the pupils point, -1 (left) to 1 (right). */
  look?: number
  mood?: MascotMood
}) {
  // A theme can recolour Pip (--pip-<color> in app/globals.css); these are the defaults.
  const fill = `var(--pip-${color}, ${FILL[color]})`
  const dx = Math.max(-1, Math.min(1, look)) * 3
  const line = { stroke: INK, strokeWidth: 2.8, strokeLinecap: 'round' as const, fill: 'none' }
  return (
    <svg width={width} height={(width * 78) / 120} viewBox="0 0 120 78" className={className} aria-hidden>
      {/* bun */}
      <circle cx="60" cy="13" r="9" style={{ fill }} />
      <path d="M50 19q10 5 20 0" stroke={INK} strokeOpacity="0.18" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* body */}
      <path d="M2 78a58 58 0 0 1 116 0z" style={{ fill }} />
      {/* eyes, with a glint */}
      {mood === 'sleepy' ? (
        <>
          <path d="M35 51 Q43 57 51 51" {...line} />
          <path d="M69 51 Q77 57 85 51" {...line} />
        </>
      ) : (
        <g className={mood === 'happy' ? 'animate-blink' : ''} style={{ transformOrigin: '60px 50px', transformBox: 'view-box' }}>
          {mood === 'wink' ? (
            <path d="M35 53 Q43 45 51 53" {...line} />
          ) : (
            <>
              <ellipse cx="43" cy="50" rx="8.5" ry="9.5" fill="#fff" />
              <circle cx={44 + dx} cy="51.5" r="5" fill={INK} />
              <circle cx={45.8 + dx} cy="49.4" r="1.6" fill="#fff" />
            </>
          )}
          <ellipse cx="77" cy="50" rx="8.5" ry="9.5" fill="#fff" />
          <circle cx={78 + dx} cy="51.5" r="5" fill={INK} />
          <circle cx={79.8 + dx} cy="49.4" r="1.6" fill="#fff" />
        </g>
      )}
      {/* mouth */}
      {mood === 'oops'
        ? <ellipse cx="60" cy="65" rx="3.6" ry="4.4" fill={INK} />
        : <path d="M54 63q6 5 12 0" {...line} strokeWidth={2.6} />}
      {/* cheeks */}
      <ellipse cx="26" cy="64" rx="6" ry="3.5" fill="#fff" fillOpacity="0.35" />
      <ellipse cx="94" cy="64" rx="6" ry="3.5" fill="#fff" fillOpacity="0.35" />
    </svg>
  )
}
