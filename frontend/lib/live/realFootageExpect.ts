// What each folder of real footage contains, as described by the dancer who filmed it. Shared by
// the real-footage tests and the diagnostic scoreboard so both judge against the same answer key.
import type { MoveKind } from './moveEngine'

export interface FolderExpectation {
  /** The move every clip in the folder is a rep (or a series) of. */
  move: MoveKind
  /** A series move (chaînés, piqués): one or more events of `move`, nothing else. */
  series?: boolean
  /** Other moves that may legitimately appear BEFORE the main one (e.g. a high chaîné before a calypso). */
  allowBefore?: MoveKind[]
  /** Other moves that may legitimately appear AFTER it. */
  allowAfter?: MoveKind[]
  /** Per clip number (1-based): the rotation count the dancer reported, where they did. */
  rotations?: number[]
  /** À la seconde clips: second turns per clip, and the finishing pirouettes (any of these). */
  secondeTurns?: number[]
  finishTurns?: number[]
  /** À la seconde clips: whether the second turns include floaters (TurnEvent.floaters above 0). */
  floaters?: boolean
  /** Per clip number (1-based), for a folder holding more than one move: each clip's move (it stands in for `move`). */
  moves?: MoveKind[]
}

/** What one clip of a folder should hold: its own move where the folder mixes moves (`moves`). */
export function expectedFor(ex: FolderExpectation, clipName: string): FolderExpectation {
  const move = ex.moves?.[clipNumber(clipName) - 1]
  return move ? { ...ex, move } : ex
}

export const FOLDER_EXPECT: Record<string, FolderExpectation> = {
  straight_jump: { move: 'jump' },
  split_leap: { move: 'split' },
  'switch leap': { move: 'switch' },
  calypso: { move: 'calypso', allowBefore: ['chaine'] },
  // Every russian turns out of its landing; that spin is part of the russian and never counted.
  russian: { move: 'russian' },
  arabesque: { move: 'arabesque' },
  pirouettes: { move: 'pirouette', rotations: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5] },
  'a la seconde turns': { move: 'seconde', secondeTurns: [2, 3, 4, 5, 4, 2, 3, 4, 5, 5], finishTurns: [2, 3], floaters: false },
  'chaine turns': { move: 'chaine', series: true },
  'pique turns': { move: 'pique', series: true },
  // The intros (step, sashay, run) sometimes include a small jump with the legs together.
  firebird: { move: 'firebird', allowBefore: ['jump'] },
  'tilt jump': { move: 'tiltJump', allowBefore: ['jump'] },
  'switch tilt': { move: 'switchTilt', allowBefore: ['jump'] },
  'switch arabesque': { move: 'switchArabesque', allowBefore: ['jump'] },
  // Two or three kicks to a clip. Some side battement clips end with a turn on the spot.
  'front battement': { move: 'frontBattement', series: true },
  'side battement': { move: 'sideBattement', series: true, allowAfter: ['turnUnsure'] },
  'fan kick': { move: 'fanKick', series: true },
  // Clips 9 and 10 hold two illusions each.
  illusion: { move: 'illusion', series: true },
  // À la seconde turns with the spot moved a quarter turn every two turns, ending in pirouettes.
  'changing spot 2nd turns': { move: 'changingSpot', floaters: false },
  // Floaters (no plié between the turns) and regular second turns mixed: à la seconde turns with
  // floaters. A floater is told by the arms up and the standing knee straight (TurnDetector
  // floaterTurns); the plié itself cannot be seen on a webcam.
  'floater 2nd turns': { move: 'seconde', floaters: true },
  // Re-filmed 2026-10-12 on an iPhone (1080p, about 30 fps, HDR tone-mapped to standard range), one
  // recording per move cut into clips at the pauses; each folder's clips.md says what is in each
  // clip. Kicks: some clips hold a series of two or three. Front battement 9-14 face the camera.
  'High Quality - Fan Kick': { move: 'fanKick', series: true },
  'High Quality - Front Battement': { move: 'frontBattement', series: true },
  'High Quality - Switch Arabesque': { move: 'switchArabesque', allowBefore: ['jump'] },
  // Floaters mixed with regular second turns: to the app, à la seconde turns (see above).
  'High Quality - Floater Test': { move: 'seconde', floaters: true },
  // 1-2: 3/4 spot changes (right, left); 3-4: 5/4 (right, left).
  'High Quality - Changing Spot': { move: 'changingSpot', floaters: false },
  // Filmed 2026-10-14 on an iPhone held upright (1080x1920). Second turns finished with pirouettes,
  // each combination on both sides: 2+2, 3+2, 2+3, 3+3, 4+2 (the right side the stronger).
  'High Quality - Second Turns': { move: 'seconde', secondeTurns: [2, 2, 3, 3, 2, 2, 3, 3, 4, 4], finishTurns: [2, 3], floaters: false },
  // Switch tilts facing the camera, entered from a sashay, two steps or one step; the dancer travels
  // into and out of the narrow upright frame.
  'High Quality - Switch Tilt': { move: 'switchTilt', allowBefore: ['jump'] },
  // Both kicks facing the camera, one per clip, in the order the dancer gave.
  'High Quality - Fan Kick vs Front Battement': {
    move: 'fanKick',
    moves: ['frontBattement', 'frontBattement', 'fanKick', 'frontBattement', 'fanKick', 'fanKick', 'frontBattement', 'fanKick', 'frontBattement', 'fanKick'],
  },
}

/**
 * Known misses, keyed "<set> <folder>/<clip>" (plus " @15fps" for the decimated replay): still wrong,
 * each for a reason found on the footage. The real-footage suite runs them as it.fails, which keeps
 * them visible - a change that fixes one turns its test red until it is taken off this list.
 *
 * The new moves (2026-10-10) brought most of them, in four groups: switched leaps at 15 fps, where
 * the switch falls between frames; kicks filmed from an angle that hides their direction (a front
 * battement toward the lens, a fan kick from the side); illusions and changing spots on the edge of
 * their thresholds; and floater 10, which reads as a changing spot.
 */
export const KNOWN: Record<string, string> = {
  'browserCpu switch leap/switch leap 2': 'a turn-round before the leap reads as an unsure turn',
  'browserCpu arabesque/arabesque 1': 'the turn after it crosses 150 degrees inside the 400 ms hold, which vetoes it as a preparation',
  'browserCpu a la seconde turns/a la seconde 6': 'passé readings among the 12 leg-out frames pull the change-point a turn early (1 + 4)',
  'browserGpu a la seconde turns/a la seconde 6': 'passé readings among the 13 leg-out frames pull the change-point a turn early (1 + 4)',
  'browserCpu a la seconde turns/a la seconde 6 @15fps': 'at 15 fps too few leg-out frames remain to call it à la seconde',
  'browserCpu switch leap/switch leap 8 @15fps': 'at 15 fps the switch falls between frames and it reads as a split leap',
  'python tilt jump/tilt jump 6': 'two rotations before the jump read as an unsure turn',
  'python tilt jump/tilt jump 6 @15fps': 'at 15 fps two rotations before the jump read as an unsure turn',
  'python switch tilt/switch tilt 2': 'reads as a plain jump (no critique)',
  'python switch tilt/switch tilt 3 @15fps': 'at 15 fps reads as a switch leap',
  'python switch tilt/switch tilt 8 @15fps': 'at 15 fps reads as a russian',
  'python switch tilt/switch tilt 9': 'a 15 fps clip: reads as a tilt jump',
  'python switch tilt/switch tilt 10 @15fps': 'at 15 fps reads as an arabesque',
  'python switch arabesque/switch arabesque 1': 'reads as a plain jump (no critique)',
  'python switch arabesque/switch arabesque 3 @15fps': 'at 15 fps reads as a switch leap',
  'python switch arabesque/switch arabesque 6 @15fps': 'at 15 fps reads as a switch leap',
  'python switch arabesque/switch arabesque 7 @15fps': 'at 15 fps reads as a switch leap',
  'python switch arabesque/switch arabesque 8 @15fps': 'at 15 fps reads as a switch leap',
  'python switch arabesque/switch arabesque 10 @15fps': 'at 15 fps reads as a plain jump (no critique)',
  'python front battement/front battement 5': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python front battement/front battement 5 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python front battement/front battement 6': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python front battement/front battement 6 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python front battement/front battement 9': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python front battement/front battement 9 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'python fan kick/fan kick 3': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'python fan kick/fan kick 3 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'python fan kick/fan kick 4': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'python fan kick/fan kick 4 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'python fan kick/fan kick 5': 'the foot never crossed the center line on screen: reads as a side battement',
  'python fan kick/fan kick 6': 'the foot never crossed the center line on screen: reads as a side battement',
  'python fan kick/fan kick 6 @15fps': 'the foot never crossed the center line on screen: reads as a side battement',
  'python illusion/illusion 4 @15fps': 'at 15 fps the illusion is not found',
  'python changing spot 2nd turns/changing spot 1': 'fewer than two second turns spotted 60+ degrees away from the first: reads as plain à la seconde',
  'python floater 2nd turns/floater 10': 'two second turns spotted 60+ degrees away from the first: reads as a changing-spot turn',
  'browserCpu tilt jump/tilt jump 6': 'two rotations before the jump read as an unsure turn',
  'browserCpu tilt jump/tilt jump 8 @15fps': 'at 15 fps reads as a russian',
  'browserCpu switch tilt/switch tilt 1': 'a 15 fps clip: reads as a plain jump (no critique)',
  'browserCpu switch tilt/switch tilt 2': 'reads as a plain jump (no critique)',
  'browserCpu switch tilt/switch tilt 2 @15fps': 'at 15 fps reads as a plain jump (no critique)',
  'browserCpu switch tilt/switch tilt 3 @15fps': 'at 15 fps no leap is found',
  'browserCpu switch tilt/switch tilt 8 @15fps': 'at 15 fps reads as a russian',
  'browserCpu switch tilt/switch tilt 9': 'a 15 fps clip: one leg high and one low, head turned, no switch seen: an unsure leap (no critique)',
  'browserCpu switch tilt/switch tilt 10 @15fps': 'at 15 fps reads as an arabesque',
  'browserCpu switch arabesque/switch arabesque 3 @15fps': 'at 15 fps reads as a switch leap',
  'browserCpu switch arabesque/switch arabesque 8 @15fps': 'at 15 fps reads as a switch leap',
  'browserCpu switch arabesque/switch arabesque 9': 'reads as a split leap',
  'browserCpu switch arabesque/switch arabesque 10 @15fps': 'at 15 fps reads as a plain jump (no critique)',
  'browserCpu front battement/front battement 5': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserCpu front battement/front battement 5 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserCpu front battement/front battement 6': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserCpu front battement/front battement 6 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserCpu fan kick/fan kick 3': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserCpu fan kick/fan kick 3 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserCpu fan kick/fan kick 4': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserCpu fan kick/fan kick 4 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserCpu fan kick/fan kick 5': 'the foot never crossed the center line on screen: reads as a side battement',
  'browserCpu fan kick/fan kick 6': 'the foot never crossed the center line on screen: reads as a side battement',
  'browserCpu fan kick/fan kick 6 @15fps': 'the foot never crossed the center line on screen: reads as a side battement',
  'browserCpu fan kick/fan kick 8': 'an arabesque is read as well as the fan kick',
  'browserCpu illusion/illusion 4 @15fps': 'at 15 fps the illusion is not found',
  'browserCpu changing spot 2nd turns/changing spot 1': 'fewer than two second turns spotted 60+ degrees away from the first: reads as plain à la seconde',
  'browserCpu changing spot 2nd turns/changing spot 2': 'the sequence breaks into two à la seconde turns',
  'browserCpu changing spot 2nd turns/changing spot 2 @15fps': 'at 15 fps the sequence breaks into two à la seconde turns',
  'browserCpu floater 2nd turns/floater 10': 'two second turns spotted 60+ degrees away from the first: reads as a changing-spot turn',
  'browserGpu tilt jump/tilt jump 3': 'the take-off reads as a brush and a switch: a switch tilt',
  'browserGpu tilt jump/tilt jump 4': 'the take-off reads as a brush and a switch: a switch tilt',
  'browserGpu tilt jump/tilt jump 4 @15fps': 'at 15 fps the take-off reads as a brush and a switch: a switch tilt',
  'browserGpu tilt jump/tilt jump 6 @15fps': 'at 15 fps two rotations before the jump read as an unsure turn',
  'browserGpu tilt jump/tilt jump 8 @15fps': 'at 15 fps reads as a russian',
  'browserGpu switch tilt/switch tilt 1': 'a 15 fps clip: reads as a plain jump (no critique)',
  'browserGpu switch tilt/switch tilt 2': 'reads as a plain jump (no critique)',
  'browserGpu switch tilt/switch tilt 2 @15fps': 'at 15 fps reads as a plain jump (no critique)',
  'browserGpu switch tilt/switch tilt 3 @15fps': 'at 15 fps reads as a switch leap',
  'browserGpu switch tilt/switch tilt 8 @15fps': 'at 15 fps reads as a russian',
  'browserGpu switch tilt/switch tilt 9': 'a 15 fps clip: one leg high and one low, head turned, no switch seen: an unsure leap (no critique)',
  'browserGpu switch tilt/switch tilt 10 @15fps': 'at 15 fps reads as a switch leap',
  'browserGpu switch arabesque/switch arabesque 3 @15fps': 'at 15 fps reads as a switch leap',
  'browserGpu switch arabesque/switch arabesque 4 @15fps': 'at 15 fps reads as a switch leap',
  'browserGpu switch arabesque/switch arabesque 7': 'reads as a plain jump (no critique)',
  'browserGpu switch arabesque/switch arabesque 7 @15fps': 'at 15 fps reads as a plain jump (no critique)',
  'browserGpu switch arabesque/switch arabesque 8 @15fps': 'at 15 fps reads as a switch leap',
  'browserGpu switch arabesque/switch arabesque 9': 'reads as a split leap',
  'browserGpu switch arabesque/switch arabesque 10 @15fps': 'at 15 fps no leap is found',
  'browserGpu front battement/front battement 5': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserGpu front battement/front battement 5 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserGpu front battement/front battement 6': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserGpu front battement/front battement 6 @15fps': 'the kick filmed facing the camera reads as a side battement: toward the lens and out to the side look alike from the front',
  'browserGpu fan kick/fan kick 3': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserGpu fan kick/fan kick 3 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserGpu fan kick/fan kick 4': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserGpu fan kick/fan kick 4 @15fps': 'filmed from the side, the sweep across the body is not visible: reads as a front battement',
  'browserGpu fan kick/fan kick 6': 'the foot never crossed the center line on screen: reads as a side battement',
  'browserGpu fan kick/fan kick 6 @15fps': 'the foot never crossed the center line on screen: reads as a side battement',
  'browserGpu illusion/illusion 4 @15fps': 'at 15 fps the illusion is not found',
  'browserGpu illusion/illusion 6': 'the illusion is not found',
  'browserGpu illusion/illusion 8': 'not found as an illusion; its turn reads as an à la seconde turn',
  'browserGpu illusion/illusion 8 @15fps': 'at 15 fps not found as an illusion; its turn reads as an à la seconde turn',
  'browserGpu changing spot 2nd turns/changing spot 9': 'fewer than two second turns spotted 60+ degrees away from the first: reads as plain à la seconde',
  'browserGpu floater 2nd turns/floater 10': 'two second turns spotted 60+ degrees away from the first: reads as a changing-spot turn',
  // Floaters (2026-10-13): told by the arms up.
  'python floater 2nd turns/floater 1': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'python floater 2nd turns/floater 5': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'python floater 2nd turns/floater 1 @15fps': 'at 15 fps the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserCpu floater 2nd turns/floater 1': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserCpu floater 2nd turns/floater 5': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserCpu floater 2nd turns/floater 1 @15fps': 'at 15 fps the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserGpu floater 2nd turns/floater 1': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserGpu floater 2nd turns/floater 5': 'the arms stay out in second through the floaters, so they are not told from regular second turns',
  'browserGpu floater 2nd turns/floater 1 @15fps': 'at 15 fps the arms stay out in second through the floaters, so they are not told from regular second turns',
  'python floater 2nd turns/floater 6 @15fps': 'at 15 fps too few arms-up frames remain in a floater turn',
  'browserGpu floater 2nd turns/floater 6 @15fps': 'at 15 fps too few arms-up frames remain in a floater turn',
  'browserGpu floater 2nd turns/floater 5 @15fps': 'at 15 fps the arms stay out in second through the floaters, so they are not told from regular second turns',
  // The iPhone re-shoots (2026-10-13).
  'python High Quality - Fan Kick/High Quality - Fan Kick 7': 'filmed at a slight angle (facing 0.44, under the 0.45 front-on mark): not read as from the front',
  'python High Quality - Fan Kick/High Quality - Fan Kick 7 @15fps': 'at 15 fps filmed at a slight angle (facing 0.44, under the 0.45 front-on mark): not read as from the front; the leg passes for an arabesque',
  'python High Quality - Front Battement/High Quality - Front Battement 14 @15fps': 'filmed facing the camera: the foot rises in front of the body, between where fan kicks cross and side battements stay out; reads as a side battement',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 1 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 2 @15fps': 'at 15 fps reads as a switch tilt',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 3 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 4': 'one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 4 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 6 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 7 @15fps': 'at 15 fps reads as a split leap',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 8': 'reads as a switch leap',
  'python High Quality - Switch Arabesque/High Quality - Switch Arabesque 8 @15fps': 'at 15 fps reads as a russian',
  'python High Quality - Changing Spot/High Quality - Changing Spot 1': 'fewer than two second turns spotted 60+ degrees from the first: reads as plain à la seconde (3/4 turns are not whole rotations)',
  'browserCpu High Quality - Fan Kick/High Quality - Fan Kick 7': 'filmed at a slight angle (facing 0.44, under the 0.45 front-on mark): not read as from the front; the leg passes for an arabesque',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 2 @15fps': 'at 15 fps reads as a switch tilt',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 3 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 4': 'one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 4 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 6': 'no leap is found',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 6 @15fps': 'at 15 fps reads as a switch leap',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 7 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserCpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 8 @15fps': 'at 15 fps reads as a split leap',
  'browserCpu High Quality - Changing Spot/High Quality - Changing Spot 1': 'fewer than two second turns spotted 60+ degrees from the first: reads as plain à la seconde (3/4 turns are not whole rotations)',
  'browserCpu High Quality - Changing Spot/High Quality - Changing Spot 2': 'fewer than two second turns spotted 60+ degrees from the first: reads as plain à la seconde (3/4 turns are not whole rotations)',
  'browserGpu High Quality - Fan Kick/High Quality - Fan Kick 7': 'filmed at a slight angle (facing 0.44, under the 0.45 front-on mark): not read as from the front; the leg passes for an arabesque',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 2 @15fps': 'at 15 fps reads as a switch tilt',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 3 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 4': 'one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 4 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 6': 'reads as a switch leap',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 6 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 7 @15fps': 'at 15 fps one leg high and one low, but no switch seen: an unsure leap (no critique)',
  'browserGpu High Quality - Switch Arabesque/High Quality - Switch Arabesque 8 @15fps': 'at 15 fps reads as a split leap',
  'browserGpu High Quality - Changing Spot/High Quality - Changing Spot 1': 'fewer than two second turns spotted 60+ degrees from the first: reads as plain à la seconde (3/4 turns are not whole rotations)',
  // 2026-10-15: the switch rules no longer take the legs closing at a landing for a switch (see
  // JUMP_TYPE_CONFIG.switchLateFrac); this one had passed on exactly that.
  'python switch arabesque/switch arabesque 9': 'the brush reads 44 degrees through the blur, so the real switch (legs together a third of the way in) has no brush before it: one leg high and one low, no switch seen - an unsure leap',
  'browserGpu fan kick/fan kick 5': 'the foot came to the center line but not past it (0.10): reads as a side battement',
  // iPhone held upright, 2026-10-14. The switch tilts travel across a narrow frame: the dancer comes
  // into it just before taking off, so the run-up and the brush are partly missed.
  'python High Quality - Fan Kick vs Front Battement/High Quality - Fan Kick vs Front Battement 9': 'a front battement facing the camera whose leg read as rising sideways in 3-D (0.33): reads as a side battement',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 2': 'the dancer comes into the upright frame just before the take-off: the flight reads too short to count',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 4': 'the dancer comes into the upright frame just before the take-off, so the brush is not tracked: one leg high and one low, no switch seen - an unsure leap',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 6': 'the dancer comes into the upright frame just before the take-off: the flight reads too short, and the trailing leg passes for an arabesque',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 7': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 9': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 1 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 2 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 3 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 4 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 8 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 10 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 12 @15fps': 'at 15 fps no leap is found',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 5 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 7 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 9 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 13 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'python High Quality - Switch Tilt/High Quality - Switch Tilt 6 @15fps': 'at 15 fps reads as a piqué turn',
  // The browser readers on the upright iPhone footage of 2026-10-14 (see the Python entries above).
  'browserCpu High Quality - Fan Kick vs Front Battement/High Quality - Fan Kick vs Front Battement 9': 'a front battement facing the camera whose leg read as rising sideways in 3-D: reads as a side battement',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 2': 'the dancer comes into the upright frame just before the take-off: no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 4': 'the dancer comes into the upright frame just before the take-off, the head turned toward the travel: reads as a switch arabesque',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 5': 'the head turned toward the travel (past the 0.17 a tilt allows): reads as a switch arabesque',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 6': 'the dancer comes into the upright frame just before the take-off: no switch seen (a tilt jump), and the walk out reads as a piqué turn',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 7': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 9': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 2 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 3 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 4 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 8 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 10 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 12 @15fps': 'at 15 fps no leap is found',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 1 @15fps': 'at 15 fps no leap is found, and the trailing leg passes for an arabesque',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 5 @15fps': 'at 15 fps reads as a russian',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 6 @15fps': 'at 15 fps reads as a piqué turn',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 7 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'browserCpu High Quality - Switch Tilt/High Quality - Switch Tilt 9 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'browserGpu High Quality - Fan Kick vs Front Battement/High Quality - Fan Kick vs Front Battement 9': 'a front battement facing the camera whose leg read as rising sideways in 3-D: reads as a side battement',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 2': 'the dancer comes into the upright frame just before the take-off: no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 4': 'the dancer comes into the upright frame just before the take-off, the head turned toward the travel: reads as a switch arabesque',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 5': 'the head turned toward the travel (past the 0.17 a tilt allows): reads as a switch arabesque',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 6': 'the dancer comes into the upright frame just before the take-off: no switch seen (a tilt jump), and the walk out reads as a piqué turn',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 7': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 9': 'filmed from the front the switch does not show (the legs open once): reads as a tilt jump',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 2 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 3 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 4 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 8 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 10 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 12 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 1 @15fps': 'at 15 fps no leap is found',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 5 @15fps': 'at 15 fps reads as a russian',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 6 @15fps': 'at 15 fps reads as a piqué turn',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 7 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 9 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
  'browserGpu High Quality - Switch Tilt/High Quality - Switch Tilt 13 @15fps': 'at 15 fps the switch falls between frames: reads as a tilt jump',
}

/**
 * The blind test (2026-10-14): three iPhone videos of ten moves each, in an order the dancer chose and
 * kept to themselves until the app had answered. The key is the moves in order ("whenever there is no L
 * or R, I did L"); videos/blind/notes.md says how it was filmed. The videos run from the camera setup
 * to the reach for the phone, as a user's upload would.
 */
export const BLIND_KEY: Record<string, MoveKind[]> = {
  'blind 1': ['chaine', 'split', 'switch', 'arabesque', 'pirouette', 'frontBattement', 'calypso', 'seconde', 'switchTilt', 'illusion'],
  'blind 2': ['pique', 'russian', 'fanKick', 'pirouette', 'firebird', 'sideBattement', 'changingSpot', 'tiltJump', 'switchArabesque', 'arabesque'],
  'blind 3': ['jump', 'chaine', 'switch', 'illusion', 'pirouette', 'calypso', 'fanKick', 'seconde', 'split', 'tiltJump'],
}

/**
 * How many of the key's moves the app must name in order, and how many moves of its own it may
 * add, per "<set> <video>"; all ten and none where a set is not listed. Each shortfall says why.
 */
export const BLIND_SCORE: Record<string, { named: number; extra: number; why: string }> = {
  'python blind 1': { named: 9, extra: 1, why: 'the split leap, danced facing the camera with the chest open, reads as a russian (a straddle held square to the camera)' },
  'browserGpu blind 1': { named: 9, extra: 1, why: 'the split leap, danced facing the camera with the chest open, reads as a russian (a straddle held square to the camera)' },
  'browserCpu blind 1': { named: 8, extra: 1, why: 'the split leap, danced facing the camera with the chest open, reads as a russian (a straddle held square to the camera); the illusion is not found on this reader (the Python and GPU readers find it)' },
  'browserCpu blind 2': { named: 10, extra: 3, why: 'two jumps and a side battement read during the camera setup, the dancer up against the lens with the legs out of the picture' },
  'browserCpu blind 3': { named: 8, extra: 1, why: 'the illusion is not found on this reader, and the split leap after a chassé reads as a switch leap' },
  'browserGpu blind 2': { named: 10, extra: 1, why: 'a jump read during the camera setup, the dancer up against the lens with the legs out of the picture' },
  'browserGpu blind 3': { named: 10, extra: 1, why: 'a 300-degree turn in 0.4 s after the switch leap: the tracker swapping left and right' },
}

/** The clip number in a file name like "pirouettes 3". */
export const clipNumber = (name: string): number => Number(name.match(/(\d+)(?:\s+@\d+fps)?\s*$/)?.[1] ?? 0)
