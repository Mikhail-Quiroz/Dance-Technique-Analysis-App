import type { MetadataRoute } from 'next'

// What makes the site installable as an app on a phone, tablet or laptop (Add to Home Screen /
// Install app), and what app-store wrappers (Google Play's TWA, the Microsoft Store via
// PWABuilder) read. Icons: scripts/make-app-icons.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Dance Platform',
    short_name: 'Dance',
    description: 'Technique feedback for your leaps, turns and balances',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F8E3EB',
    theme_color: '#E76E84',
    categories: ['sports', 'health', 'education'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the app icon (Android) or right-click it (desktop).
    shortcuts: [
      { name: 'Live coaching', short_name: 'Live', url: '/live', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Upload a clip', short_name: 'Upload', url: '/analyze', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Sessions', url: '/diary', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  }
}
