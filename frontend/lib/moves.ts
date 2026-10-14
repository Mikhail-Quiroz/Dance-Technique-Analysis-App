// Names for the moves the MoveEngine identifies, shared by /live and the upload results so the
// two never describe the same move differently.
import type { MoveKind } from './live/moveEngine'

/**
 * 'hold' is "Balances & kicks": the arabesque, the battements, fan kicks and illusions share one
 * family (the user's choice, 2026-10-13: one balance on its own was too thin, and they preferred the
 * green to the kicks' own violet). Reports saved before that may say 'kick' (see normalizeReport).
 */
export type MoveFamily = 'leap' | 'turn' | 'hold'

export const MOVE_LABEL: Record<MoveKind, string> = {
  jump: 'Jump',
  split: 'Split leap',
  switch: 'Switch leap',
  calypso: 'Calypso',
  russian: 'Russian',
  leapUnsure: 'Leap (type unsure)',
  firebird: 'Firebird',
  tiltJump: 'Tilt jump',
  switchTilt: 'Switch tilt',
  switchArabesque: 'Switch arabesque',
  arabesque: 'Arabesque',
  frontBattement: 'Front battement',
  sideBattement: 'Side battement',
  fanKick: 'Fan kick',
  illusion: 'Illusion',
  pirouette: 'Pirouette',
  seconde: 'À la seconde turns',
  changingSpot: 'Changing-spot 2nd turns',
  chaine: 'Chaîné turns',
  pique: 'Piqué turns',
  // Spinning was certain; WHICH turn was not, so the label says so rather than implying a move
  // it could not identify.
  turnUnsure: 'Turn (type unsure)',
}

/** Plural labels for tallies. */
export const MOVE_TALLY: Record<MoveKind, string> = {
  jump: 'Jumps',
  split: 'Split leaps',
  switch: 'Switch leaps',
  calypso: 'Calypsos',
  russian: 'Russians',
  leapUnsure: 'Unsure leaps',
  firebird: 'Firebirds',
  tiltJump: 'Tilt jumps',
  switchTilt: 'Switch tilts',
  switchArabesque: 'Switch arabesques',
  arabesque: 'Arabesques',
  frontBattement: 'Front battements',
  sideBattement: 'Side battements',
  fanKick: 'Fan kicks',
  illusion: 'Illusions',
  pirouette: 'Pirouettes',
  seconde: 'À la seconde',
  changingSpot: 'Changing-spot 2nd turns',
  chaine: 'Chaînés',
  pique: 'Piqués',
  turnUnsure: 'Unsure turns',
}

export const MOVE_VERB: Record<MoveKind, string> = {
  jump: ' landed',
  split: ' landed',
  switch: ' landed',
  calypso: ' landed',
  russian: ' landed',
  leapUnsure: '',
  firebird: ' landed',
  tiltJump: ' landed',
  switchTilt: ' landed',
  switchArabesque: ' landed',
  arabesque: '',
  frontBattement: '',
  sideBattement: '',
  fanKick: '',
  illusion: '',
  pirouette: ' finished',
  seconde: ' finished',
  changingSpot: ' finished',
  chaine: ' finished',
  pique: ' finished',
  turnUnsure: '',
}

export const MOVE_FAMILY: Record<MoveKind, MoveFamily> = {
  jump: 'leap',
  split: 'leap',
  switch: 'leap',
  calypso: 'leap',
  russian: 'leap',
  leapUnsure: 'leap',
  firebird: 'leap',
  tiltJump: 'leap',
  switchTilt: 'leap',
  switchArabesque: 'leap',
  arabesque: 'hold',
  frontBattement: 'hold',
  sideBattement: 'hold',
  fanKick: 'hold',
  illusion: 'hold',
  pirouette: 'turn',
  seconde: 'turn',
  changingSpot: 'turn',
  chaine: 'turn',
  pique: 'turn',
  turnUnsure: 'turn',
}

export const FAMILY_LABEL: Record<MoveFamily, string> = {
  leap: 'Jumps & leaps',
  turn: 'Turns',
  hold: 'Balances & kicks',
}

/** The moves verified on real footage - the only ones the app names. Unsure kinds are not listed. */
export const COACHED_MOVES: ReadonlyArray<{ family: MoveFamily; moves: MoveKind[] }> = [
  { family: 'leap', moves: ['jump', 'split', 'switch', 'calypso', 'russian', 'firebird', 'tiltJump', 'switchTilt', 'switchArabesque'] },
  { family: 'turn', moves: ['pirouette', 'seconde', 'changingSpot', 'chaine', 'pique'] },
  { family: 'hold', moves: ['arabesque', 'frontBattement', 'sideBattement', 'fanKick', 'illusion'] },
]

export const ALL_MOVES = Object.keys(MOVE_LABEL) as MoveKind[]
