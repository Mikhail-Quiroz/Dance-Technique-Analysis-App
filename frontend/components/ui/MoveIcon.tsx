// The round badge that marks a move by its family: leaps sunny, turns lilac, balances & kicks olive.
// The family sets the colour; kicks keep their own icon inside it.
// A move the engine counted without naming (a turn or leap it was unsure of) is plain sand.
import type { MoveKind } from '@/lib/live/moveEngine'
import { MOVE_FAMILY, type MoveFamily } from '@/lib/moves'
import Icon from './Icon'

export const FAMILY_STYLE: Record<MoveFamily, { badge: string; dot: string }> = {
  leap: { badge: 'bg-sun-soft text-cocoa', dot: 'bg-chart-leap' },
  turn: { badge: 'bg-lilac text-grape', dot: 'bg-chart-turn' },
  hold: { badge: 'bg-olive-soft text-olive-deep', dot: 'bg-chart-hold' },
}

const KICKS: ReadonlySet<MoveKind> = new Set(['frontBattement', 'sideBattement', 'fanKick', 'illusion'])

const isUnsure = (move: MoveKind | null) => move === 'leapUnsure' || move === 'turnUnsure'

export default function MoveIcon({
  move,
  family,
  size = 44,
}: {
  move: MoveKind | null
  family: MoveFamily | null
  size?: number
}) {
  const fam = family ?? (move ? MOVE_FAMILY[move] : 'leap')
  const style = isUnsure(move) ? 'bg-sand text-ink' : FAMILY_STYLE[fam].badge
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${style}`}
      style={{ width: size, height: size }}
    >
      <Icon name={isUnsure(move) ? 'unsure' : move && KICKS.has(move) ? 'kick' : fam} size={Math.round(size * 0.5)} />
    </span>
  )
}
