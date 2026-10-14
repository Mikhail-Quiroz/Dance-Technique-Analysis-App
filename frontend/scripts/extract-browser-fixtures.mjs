// Browser fixtures: every reference clip read by the browser's MediaPipe - the runtime /live and
// uploads run - at exactly the frame times of its Python fixture, in the same format 2, so
// replay.ts loads them and the real-footage tests run on what users' browsers see.
//
//   node scripts/extract-browser-fixtures.mjs cpu        # lib/live/fixtures/browser-cpu (uploads)
//   node scripts/extract-browser-fixtures.mjs gpu        # lib/live/fixtures/browser-gpu (/live)
//   node scripts/extract-browser-fixtures.mjs cpu split_leap calypso   # just these folders
//
// Needs the Python fixtures first (scripts/extract_live_fixtures.py: they supply the frame times)
// and Google Chrome (CHROME_PATH to point at another). FORCE=1 re-extracts existing ones.
// Seeking to each frame makes the result independent of how busy the machine is.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(FRONTEND, 'lib/live/fixtures')
const VIDEOS = path.resolve(FRONTEND, '../videos/reference')
const SCALE = { lm: 1000, world: 1000, vis: 100 }
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }

const [which = 'cpu', ...only] = process.argv.slice(2)
const delegate = which.toUpperCase()
if (delegate !== 'CPU' && delegate !== 'GPU') throw new Error('usage: extract-browser-fixtures.mjs <cpu|gpu> [folder ...]')
const OUT = path.join(FIXTURES, `browser-${which.toLowerCase()}`)
const PARALLEL = Number(process.env.PARALLEL || 3)

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p))

// One clip per call: seek to each frame time in order and read the pose there, with a landmarker
// of its own (VIDEO mode tracks from frame to frame, so clips never share one).
const PAGE = `<!doctype html><html><body><script type="module">
import { FilesetResolver, PoseLandmarker } from '/tasks-vision/vision_bundle.mjs'
let fileset = null
window.extract = async (clipUrl, timesMs, delegate) => {
  fileset ??= await FilesetResolver.forVisionTasks('/wasm')
  const lmk = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/model.task', delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  })
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.style.width = '320px'
  document.body.appendChild(v)
  v.src = clipUrl
  await new Promise((r, j) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', () => j(new Error('cannot decode ' + clipUrl)), { once: true }) })
  const frames = []
  let last = -1
  for (const t of timesMs) {
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = (t + 1) / 1000 })
    const ts = Math.max(Math.round(t), last + 1)
    last = ts
    const res = lmk.detectForVideo(v, ts)
    const lm = res.landmarks?.[0], w = res.worldLandmarks?.[0]
    frames.push(lm && w ? [ts, lm.map((p) => [p.x, p.y, p.visibility ?? 0]), w.map((p) => [p.x, p.y, p.z, p.visibility ?? 0])] : [ts, null, null])
  }
  const size = [v.videoWidth, v.videoHeight]
  lmk.close(); v.remove()
  return { size, frames }
}
window.ready = true
</script></body></html>`

function route(url) {
  const u = decodeURIComponent(url.split('?')[0])
  if (u === '/') return { html: PAGE }
  if (u.startsWith('/tasks-vision/')) return { file: path.join(FRONTEND, 'node_modules/@mediapipe/tasks-vision', u.slice(14)) }
  if (u.startsWith('/wasm/')) return { file: path.join(FRONTEND, 'public/mediapipe/wasm', u.slice(6)) }
  if (u === '/model.task') return { file: path.join(FRONTEND, 'public/models/pose_landmarker_lite.task') }
  if (u.startsWith('/video/')) return { file: path.join(VIDEOS, u.slice(7)) }
  return null
}

function serve() {
  return http.createServer((req, res) => {
    const r = route(req.url)
    if (r?.html) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(r.html) }
    if (!r || !fs.existsSync(r.file)) { res.writeHead(404); return res.end() }
    const stat = fs.statSync(r.file)
    const type = TYPES[path.extname(r.file)] || 'application/octet-stream'
    const range = req.headers.range
    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-')
      const start = Number(s), end = e ? Number(e) : stat.size - 1
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 })
      return fs.createReadStream(r.file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(r.file).pipe(res)
  }).listen(0)
}

/** The Python fixture's frame times, so both sets read the very same frames. */
function fixtureTimes(folder, name) {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'real', folder, `${name}.json.gz`))).toString())
  let t = 0
  return { times: raw.t.map((d) => (t += d)), fps: raw.fps, label: raw.label }
}

/** Format 2, exactly as scripts/extract_live_fixtures.py writes it. */
function encode(label, fps, size, frames) {
  const t = [], has = [], lm = [], w = []
  let prevT = 0
  const prevL = new Array(33 * 3).fill(0)
  const prevW = new Array(33 * 4).fill(0)
  for (const [ts, pts, world] of frames) {
    t.push(ts - prevT)
    prevT = ts
    if (!pts) { has.push(0); continue }
    has.push(1)
    pts.flatMap(([x, y, v]) => [Math.round(x * SCALE.lm), Math.round(y * SCALE.lm), Math.round(v * SCALE.vis)])
      .forEach((c, i) => { lm.push(c - prevL[i]); prevL[i] = c })
    world.flatMap(([x, y, z, v]) => [Math.round(x * SCALE.world), Math.round(y * SCALE.world), Math.round(z * SCALE.world), Math.round(v * SCALE.vis)])
      .forEach((c, i) => { w.push(c - prevW[i]); prevW[i] = c })
  }
  return { version: 2, label, fps, size, scale: SCALE, t, has, lm, w }
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found: set CHROME_PATH')
  const server = serve()
  const port = server.address().port
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 1_800_000 })
  const folders = only.length ? only : fs.readdirSync(path.join(FIXTURES, 'real'))
  const jobs = []
  for (const folder of folders) {
    for (const f of fs.readdirSync(path.join(FIXTURES, 'real', folder))) {
      if (!f.endsWith('.json.gz')) continue
      const name = f.slice(0, -'.json.gz'.length)
      const video = ['.mp4', '.mov', '.MP4', '.MOV'].map((e) => name + e).find((v) => fs.existsSync(path.join(VIDEOS, folder, v)))
      if (video) jobs.push({ folder, name, video })
      else console.log(`skip  ${folder}/${name}: no video under videos/reference`)
    }
  }

  async function worker() {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('pageerror', e.message))
    await page.goto(`http://localhost:${port}/`)
    await page.waitForFunction(() => window.ready)
    while (jobs.length) {
      const { folder, name, video } = jobs.shift()
      const dst = path.join(OUT, folder, `${name}.json.gz`)
      if (fs.existsSync(dst) && !process.env.FORCE) { console.log(`skip  ${path.relative(FRONTEND, dst)}`); continue }
      const { times, fps, label } = fixtureTimes(folder, name)
      const url = `/video/${encodeURIComponent(folder)}/${encodeURIComponent(video)}`
      const { size, frames } = await page.evaluate((u, ts, d) => window.extract(u, ts, d), url, times, delegate)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, zlib.gzipSync(JSON.stringify(encode(label, fps, size, frames)), { level: 9 }))
      console.log(`wrote ${path.relative(FRONTEND, dst)}  ${frames.length} frames, ${frames.filter((f) => f[1]).length} with a pose`)
    }
    await page.close()
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  await browser.close()
  server.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
