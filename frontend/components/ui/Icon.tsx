// A small set of line icons (24px grid, 2px rounded strokes), so the app needs no icon package.
import type { SVGProps } from 'react'

const PATHS = {
  upload: <><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
  camera: <><rect x="2.5" y="6" width="13.5" height="12" rx="3" /><path d="m16 10.5 5.5-3.2v9.4L16 13.5" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>,
  arrowRight: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  arrowLeft: <><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></>,
  pencil: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  sparkle: <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9z" />,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 17-5-5 5-5" /><path d="M5 12h11" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  pause: <><rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" /><rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" /></>,
  expand: <><path d="M4 9V5a1 1 0 0 1 1-1h4" /><path d="M15 4h4a1 1 0 0 1 1 1v4" /><path d="M20 15v4a1 1 0 0 1-1 1h-4" /><path d="M9 20H5a1 1 0 0 1-1-1v-4" /></>,
  shrink: <><path d="M9 4v4a1 1 0 0 1-1 1H4" /><path d="M20 9h-4a1 1 0 0 1-1-1V4" /><path d="M15 20v-4a1 1 0 0 1 1-1h4" /><path d="M4 15h4a1 1 0 0 1 1 1v4" /></>,
  volume: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  volumeOff: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="m16 9.5 5 5" /><path d="m21 9.5-5 5" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="7.8" r="0.6" fill="currentColor" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  trophy: <><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4" /><path d="M12 14v3.5" /><path d="M8.5 20.5h7" /><path d="M9.5 20.5 10.5 17.5h3l1 3" /></>,
  // Switch camera: two arrows chasing each other round
  flip: <><path d="M4.5 10.5A7.5 7.5 0 0 1 18 7.2" /><path d="M18.6 3.5v4h-4" /><path d="M19.5 13.5A7.5 7.5 0 0 1 6 16.8" /><path d="M5.4 20.5v-4h4" /></>,
  bone: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M7.5 7.5l9 9" /></>,
  // Move families
  leap: <><path d="M3 20Q12 1 21 20" /><circle cx="12" cy="9.6" r="2.2" fill="currentColor" stroke="none" /></>,
  turn: <><path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7" /><path d="M19.5 3.8v4.6h-4.6" /></>,
  hold: <><circle cx="9" cy="4.8" r="1.8" /><path d="M9.5 7.5 8.8 13" /><path d="m8.8 13-.9 7.5" /><path d="m8.8 13 11-3.5" /><path d="M9.3 9.2 4 7.5M9.3 9.2l5.2-3" /></>,
  kick: <><circle cx="8" cy="4.5" r="1.8" /><path d="M8 7.2v6.3" /><path d="m8 13.5-.8 7" /><path d="M8 13.5 18.5 5.5" /><path d="M3.5 9.6h9" /></>,
  unsure: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.3" /><circle cx="12" cy="16.8" r="0.6" fill="currentColor" /></>,
} as const

export type IconName = keyof typeof PATHS

export default function Icon({
  name,
  size = 20,
  strokeWidth = 2,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {PATHS[name]}
    </svg>
  )
}
