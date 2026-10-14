import type { Metadata, Viewport } from 'next'
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google'
import './globals.css'
import Navbar from '@/components/layout/Navbar'
import ServiceWorker from '@/components/pwa/ServiceWorker'
import { createServerSupabase } from '@/lib/supabase-server'
import { LOCAL_MODE } from '@/lib/local-mode'

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-nf-display',
})
const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-nf-sans',
})

export const metadata: Metadata = {
  title: 'Dance Platform',
  description: 'Technique feedback for your leaps, turns and balances',
  applicationName: 'Dance Platform',
  // Added to an iPhone's home screen it opens full screen, like an app (app/manifest.ts does the same
  // for Android and desktops).
  appleWebApp: { capable: true, title: 'Dance', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: '#F8E3EB',
  // Use the whole screen, under the notch and the home bar too: the header, the phone tab bar
  // and the page keep clear of them with the safe-area insets.
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let userEmail: string | null | undefined = 'local@dev'
  if (!LOCAL_MODE) {
    const supabase = await createServerSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    userEmail = user?.email
  }

  return (
    <html lang="en" className={`${display.variable} ${sans.variable} h-full`}>
      {/* The page colour is the screen's (app/globals.css, data-screen), so not set here. */}
      <body className="min-h-full flex flex-col text-ink font-sans">
        <Navbar email={userEmail} />
        {/* Room for the phone tab bar, which sits over the bottom of the page. */}
        <main className={`flex-1 ${userEmail ? 'pb-[calc(7rem+env(safe-area-inset-bottom))] sm:pb-0' : ''}`}>{children}</main>
        <ServiceWorker />
      </body>
    </html>
  )
}
