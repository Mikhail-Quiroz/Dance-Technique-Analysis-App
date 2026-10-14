// A tilted pill word, like a sticker on a notebook. Decorative.
const TONE = {
  blush: 'bg-blush text-berry',
  sun: 'bg-sun text-cocoa',
  olive: 'bg-olive-soft text-olive-deep',
  lilac: 'bg-lilac text-grape',
} as const

export default function Sticker({
  children,
  tone,
  rotate = -6,
  className = '',
}: {
  children: React.ReactNode
  tone: keyof typeof TONE
  rotate?: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={`inline-block rounded-full px-6 py-2.5 font-display text-2xl sm:text-3xl font-extrabold tracking-tight shadow-[0_6px_18px_rgba(30,28,25,0.10)] ${TONE[tone]} ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      {children}
    </span>
  )
}
