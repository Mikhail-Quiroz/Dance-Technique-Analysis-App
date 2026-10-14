// The app icons: Pip (gold) peeking up from the bottom of a rose tile, rendered in Chrome.
//
//   node scripts/make-app-icons.mjs
//
// Writes the installed app's icons (public/icons: "any" and Android "maskable"), the iPhone home
// screen icon (app/apple-icon.png) and the browser tab icons (app/icon.svg, app/favicon.ico).
// Pip is drawn as in components/ui/Mascot.tsx; keep the two in step. Needs Google Chrome
// (CHROME_PATH to point at another).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TILE = '#E76E84'
const PIP = '#F5B13D'
const INK = '#1E1C19'

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p))

/** Pip in its own 120 x 78 box; `body` extends the dome downwards past its base. */
function pip(body = 0) {
  return `<circle cx="60" cy="13" r="9" fill="${PIP}"/>`
    + `<path d="M50 19q10 5 20 0" stroke="${INK}" stroke-opacity="0.18" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
    + `<path d="M2 78a58 58 0 0 1 116 0z" fill="${PIP}"/>`
    + (body ? `<rect x="2" y="77.5" width="116" height="${body}" fill="${PIP}"/>` : '')
    + `<ellipse cx="43" cy="50" rx="8.5" ry="9.5" fill="#fff"/><circle cx="44" cy="51.5" r="5" fill="${INK}"/><circle cx="45.8" cy="49.4" r="1.6" fill="#fff"/>`
    + `<ellipse cx="77" cy="50" rx="8.5" ry="9.5" fill="#fff"/><circle cx="78" cy="51.5" r="5" fill="${INK}"/><circle cx="79.8" cy="49.4" r="1.6" fill="#fff"/>`
    + `<path d="M54 63q6 5 12 0" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" fill="none"/>`
    + `<ellipse cx="26" cy="64" rx="6" ry="3.5" fill="#fff" fill-opacity="0.35"/><ellipse cx="94" cy="64" rx="6" ry="3.5" fill="#fff" fill-opacity="0.35"/>`
}

/**
 * A 100 x 100 icon. `rounded` cuts the tile's corners (browser tabs, desktop installs); without
 * it the tile is full-bleed for platforms that cut their own shape (iOS, Android).
 * `maskable` keeps the face inside Android's safe circle (the middle 80%), whatever shape the
 * launcher cuts: Pip sits a little higher and its body runs on past the edge.
 */
function iconSvg({ rounded, maskable = false }) {
  const width = maskable ? 72 : 80
  const base = maskable ? 92 : 100
  const s = width / 120
  const x = (100 - width) / 2
  const y = base - 78 * s
  const tile = `<rect width="100" height="100" fill="${TILE}"/><g transform="translate(${x} ${y}) scale(${s})">${pip(maskable ? 20 : 0)}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + (rounded ? `<clipPath id="tile"><rect width="100" height="100" rx="22"/></clipPath><g clip-path="url(#tile)">${tile}</g>` : tile)
    + `</svg>`
}

/** An .ico holding PNG images (every current browser reads these). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...pngs.map((p) => p.data)])
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found: set CHROME_PATH')
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  async function png(svg, size) {
    await page.setViewport({ width: size, height: size })
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
    return page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  }

  const rounded = iconSvg({ rounded: true })
  const fullBleed = iconSvg({ rounded: false })
  const maskable = iconSvg({ rounded: false, maskable: true })
  // One page renders them all, so strictly one at a time.
  const out = {
    'public/icons/icon-192.png': await png(rounded, 192),
    'public/icons/icon-512.png': await png(rounded, 512),
    'public/icons/maskable-512.png': await png(maskable, 512),
    'app/apple-icon.png': await png(fullBleed, 180),
  }
  const tabSizes = []
  for (const size of [16, 32, 48]) tabSizes.push({ size, data: await png(rounded, size) })
  out['app/favicon.ico'] = ico(tabSizes)
  out['app/icon.svg'] = Buffer.from(rounded)
  await browser.close()

  for (const [rel, data] of Object.entries(out)) {
    const dst = path.join(FRONTEND, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, data)
    console.log(`wrote ${rel}  ${data.length} bytes`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
