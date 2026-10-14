'use client'
import { useEffect } from 'react'

/**
 * Keeps the screen on while `active`: nobody touches the phone mid-dance or while a clip is being
 * analyzed, and a dimmed or locked screen hides the cues and pauses the video. The browser drops
 * the lock when the page is hidden, so it is taken again on return. Unsupported or refused (battery
 * saver), the screen just dims as usual.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let done = false
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock.request('screen').then(
        (l) => { if (done) l.release().catch(() => {}); else lock = l },
        () => {},
      )
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      done = true
      document.removeEventListener('visibilitychange', acquire)
      lock?.release().catch(() => {})
    }
  }, [active])
}
