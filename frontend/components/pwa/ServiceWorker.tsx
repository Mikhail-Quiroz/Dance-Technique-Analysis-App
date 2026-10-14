'use client'

import { useEffect } from 'react'

const SCRIPT = '/sw.js'

// Registers public/sw.js (the offline page of the installed app) in production builds. In
// development a service worker only gets in the way of hot reloading, so one left over from a
// production run on this address is removed instead.
export default function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register(SCRIPT, { scope: '/', updateViaCache: 'none' }).catch(() => {})
      return
    }
    navigator.serviceWorker.getRegistrations().then(
      (all) => all
        .filter((r) => r.active?.scriptURL.endsWith(SCRIPT))
        .forEach((r) => r.unregister()),
      () => {},
    )
  }, [])
  return null
}
