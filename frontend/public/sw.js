// The installed app's service worker (registered by components/pwa/ServiceWorker.tsx, production
// builds only). It does one thing: when a page cannot load because the device is offline, it shows
// /offline.html instead of the browser's error page, which app-store wrappers (Google Play's TWA,
// PWABuilder) expect. Nothing else is cached or intercepted, so a new release is never hidden
// behind a stale copy. Bump CACHE when offline.html changes.
const CACHE = 'offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Lets the browser start the page request while this worker boots, so pages are not slower for it.
    await self.registration.navigationPreload?.enable()
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(event.request))
    } catch {
      return (await caches.match(OFFLINE_URL)) || Response.error()
    }
  })())
})
