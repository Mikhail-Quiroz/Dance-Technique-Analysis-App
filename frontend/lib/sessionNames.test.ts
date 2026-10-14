import { describe, expect, it } from 'vitest'
import { displayTitle } from './sessionNames'

describe('session names', () => {
  it('shows old default titles the new way, and the dancer\'s own names as given', () => {
    expect(displayTitle('Session 013 — Oct 05, 2026')).toBe('Session 13')
    expect(displayTitle('Live session 014 — Oct 06, 2026')).toBe('Live session 14')
    expect(displayTitle('Session 4')).toBe('Session 4')
    expect(displayTitle('Live session 2')).toBe('Live session 2')
    expect(displayTitle('Recital run')).toBe('Recital run')
    expect(displayTitle('Session notes — tired legs')).toBe('Session notes — tired legs')
  })
})
