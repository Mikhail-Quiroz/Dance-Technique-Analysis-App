# Dance Platform V2 — Roadmap

## Phase 1 — Upload & analyze

| Slice | Description | Status |
|-------|-------------|--------|
| 0 | Scaffold + shared JSON refactor | ✅ Done |
| 1 | Auth end-to-end (Supabase + Next.js) | ✅ Done |
| 2 | Full upload path (results UI; analysis now runs in the browser on the live engine) | ✅ Done |
| 3 | Persistence + session gallery (/session/[id], rename, delete, RLS) | ✅ Done |
| 4 | Polish (mobile: installable app done; migration script) | 🔶 In progress |

## Phase 2 — Real-time live coaching (/live)

| Slice | Description | Status |
|-------|-------------|--------|
| 2a | /live page: camera + mirrored live skeleton overlay at real-time FPS | ✅ Done |
| 2b | Live jump/leap rep detection + on-screen cue + rep tally | 🔶 Built — pending live camera verification |
| 2b-arabesque | Live arabesque detection + critique (height, knee, standing leg, carriage) | 🔶 Built — pending live camera verification |
| 2b-ii | Live pirouette detection + critique (relevé, passé, spot, axis, hips, arms) | 🔶 Built — pending live camera verification; move-selector chips not started |
| 2c | Voice cues via SpeechSynthesis (cooldown rules, praise after clean reps, mute) | ⬜ Not started |
| 2d | Live session summary + highlight reel, saved to Sessions | ✅ Done (Claude-phrased cues still future) |

Setting the app up yourself? Jump to [Supabase setup](#supabase-setup-required-to-run-the-app).

---

## Slice 0 — Scaffold + shared JSON refactor ✅

**Gate:** `python -m pytest tests/` passes; `streamlit run legacy_streamlit/app.py` works.

### What was done
- Extracted all coaching cues into `shared/cues.json`
- Extracted all scoring thresholds, metric→cue map, and cue priority into `shared/thresholds.json`
- Refactored `knowledge/cues.py` to load CUES + CUE_PRIORITY from JSON (logic unchanged)
- Refactored `analysis/feedback.py` to load SCORE_CONFIG + METRIC_TO_CUE from JSON (logic unchanged)
- Created monorepo directory structure: `backend/`, `frontend/`, `shared/`, `legacy_streamlit/`, `scripts/`, `tests/videos/`
- Moved Streamlit app to `legacy_streamlit/app.py` with sys.path + ROOT fixes

### Directory structure
```
Dance Technique App/
├── ROADMAP.md
├── shared/
│   ├── cues.json          ← 25 coaching cues (cue/why/drill)
│   └── thresholds.json    ← 33 scoring entries + metric→cue map + priority list
├── backend/               ← FastAPI app
├── frontend/              ← Next.js app
├── legacy_streamlit/
│   └── app.py             ← original Streamlit app; run with:
│                              streamlit run legacy_streamlit/app.py
├── scripts/               ← time_pipeline.py (per-stage timing), regenerate_thumbnails.py
├── tests/
│   └── videos/test.mp4    ← fixture for the end-to-end pipeline test
└── [all existing packages: analysis/, pose/, knowledge/, render/, utils/, library/]
```

---

## Slice 1 — Auth end-to-end ✅

**Gate:** Sign in with Google → land on `/analyze` with user email in nav.

### What was done
- Scaffolded FastAPI in `backend/`: `main.py`, `core/config.py`, `core/auth.py`, `routers/health.py` (`GET /health`)
- `get_current_user` FastAPI dependency: verifies Supabase Bearer JWT via `auth.get_user(token)`, returns `{id, email}`
- CORS locked to `frontend_origin` from `.env`
- Scaffolded Next.js 16 in `frontend/` with Tailwind 4 CSS-first config (`@theme` palette + `@theme inline` fonts)
- Zine palette wired: `bg-paper`, `bg-surface`, `text-ink`, `bg-accent`, `bg-accent-deep`, `text-dark-section`
- Google Fonts via `next/font/google` in `layout.tsx`: Anton, Special Elite, Space Grotesk, Yellowtail
- `/auth` page: email sign-in/sign-up + Google OAuth button; confirmation info banner; error banner
- `app/auth/callback/route.ts`: OAuth PKCE code exchange → session cookies → redirect `/analyze`
- `middleware.ts`: protects `/analyze`, `/diary`, `/session/*`; uses `getUser()` (not `getSession()` — verified JWT)
- `layout.tsx`: server-side `getUser()` → email passed to `<Navbar>`
- `<Navbar>`: Analyze link + email display + Sign out
- `/` redirects → `/analyze` (signed in) or `/auth` (signed out)

---

## Slice 2 — Full upload path ✅

**Gate:** Upload a dance video in browser → see progress stages → see coaching cards.

### What was done
- [x] `POST /analyze`: validates file (.mp4/.mov, ≤200 MB, ≤90 s), saves to tempfile, inserts job row, returns `{job_id}`, kicks off `BackgroundTask`
- [x] `core/pipeline.py`: wraps the 4-stage analysis pipeline (pose → moves → metrics/feedback → render), updates the job row at each stage, deletes temp files in `finally`
- [x] `GET /jobs/{id}`: job status, stage, percent, error, and (when done) the full report + video URL
- [x] `GET /jobs/{id}/video`: streams the annotated video (Bearer header or `?token=` for `<video>` elements)
- [x] `/analyze` frontend page: upload form + move-type selector chips + 2-second polling progress bar + results display (score cards, annotated video, coaching corrections, per-move metrics)

---

## Slice 3 — Persistence + session gallery ✅

**Gate:** Full round-trip: upload → gallery shows new card → open session → rename → delete.

### What was done
- [x] Pipeline inserts a `sessions` row after successful analysis (runs in a background thread — see [post-plan fixes](#post-plan-fixes))
- [x] Thumbnail generation: duotone/halftone still from the apex frame of the highest-scoring move
- [x] `GET /sessions`: user's sessions newest-first, with signed thumbnail URLs
- [x] `GET /sessions/{id}`: full report + 1-hour signed URLs for video + thumb
- [x] `PATCH /sessions/{id}`: rename
- [x] `DELETE /sessions/{id}`: deletes row + Storage objects (idempotent; clears the `jobs` FK first)
- [x] Session gallery: responsive card grid with rename/delete/delete-all. Since the 2026-10-04 redesign it has its own page (`/diary`, "Sessions" in the nav) and `/analyze` shows the three most recent with a "See all" link.
- [x] `/session/[id]` detail view: video player + full report + rename/delete controls
- [x] `tests/test_sessions_auth_isolation.py`: user B cannot read/rename/delete user A's sessions
- [ ] `scripts/migrate_library.py`: import existing `library/` sessions — **not built yet, tracked under Slice 4**

---

## Post-plan fixes

Improvements made after the original slice plan:

- **ffmpeg video encoding** (`render/overlay.py`): annotated videos are encoded via an ffmpeg subprocess (libx264, `-preset veryfast`) with an OpenCV `VideoWriter` fallback when ffmpeg isn't installed
- **Non-blocking Supabase upload** (`core/pipeline.py`): the job is marked `done` as soon as results are ready; the Storage upload + `sessions` insert run in a background thread, so the results screen never waits on the upload
- **Timing instrumentation** (`scripts/time_pipeline.py`): per-stage timing probe to find pipeline bottlenecks
- **Upload normalization** (`core/pipeline.py`): oversized/high-fps uploads (e.g. 4K/60fps phone footage) are transcoded once to ≤960px / ≤30fps before analysis, and the pose cache is keyed by the original file's content hash — roughly 2.5× faster on phone videos, and re-analyzing the same video skips inference entirely
- **Local dev mode**: a `LOCAL_MODE` env flag runs the whole app without a Supabase project (stub auth, on-disk session store) for offline development; flipping the flag back restores the cloud path

---

## Slice 4 — Polish 🔶

**Gate:** All tests pass; README complete; app works on mobile viewport.

- [x] `tests/videos/test.mp4` fixture + `tests/test_pipeline_end_to_end.py` (full POST-/analyze-equivalent pipeline run)
- [x] Empty states (no sessions, no dance detected) + error states (failed job, upload validation, network retry during polling)
- [x] Full `README.md`: prerequisites, Supabase setup link, env vars, run commands
- [x] Mobile responsiveness pass throughout (phone tab bar, safe areas, Live on a phone held upright)
- [x] Installable app (web app manifest, icons, offline page) - see "Mobile app" below
- [ ] `scripts/migrate_library.py`: import legacy `library/` sessions idempotently
- [ ] Final `python -m pytest tests/` pass before calling the slice done (currently 44/44 passing)

---

## Phase 2 — Live coaching details

In-browser real-time coaching on a new `/live` route (same auth protection as `/analyze`). Pose tracking runs entirely client-side with `@mediapipe/tasks-vision`; the dance thresholds and cue text come from the same `/shared` JSON files the upload pipeline uses — never duplicated in TypeScript.

### Slice 2a — camera + mirrored live skeleton ✅
- [x] `/live` route (auth-protected) + "Live" navbar link
- [x] Webcam via `getUserMedia`, PoseLandmarker (lite model) in VIDEO mode driven by `requestAnimationFrame` — synchronous `detectForVideo()` keeps the skeleton aligned with the frame on screen
- [x] Selfie mirroring: video preview flipped like a studio mirror; landmark data stays anatomical (only the draw step mirrors) so left/right cues stay correct
- [x] wasm runtime copied from the npm package + lite model auto-downloaded into `frontend/public/` on `npm run dev`/`build` (version-matched, no CDN at runtime)
- [x] Graceful states: camera explainer, permission denied, no camera, "can't see you" hint; approximate-feedback disclaimer
- [x] Dev-only FPS counter + console logging
- [x] Verified in-browser: 29–30 fps sustained (≈9 ms/detection after warmup), skeleton aligned over a mirrored test feed, permission-denied and mobile (380 px) states checked

### Slice 2b — live jump/leap rep detection + cue + rep tally 🔶
- [x] Ported minimal geometry to TS (`frontend/lib/live/geometry.ts`: `angleAt`, trailing
      rolling baseline, streaming body scale, trailing-average smoothing) with unit tests
      against the same known values `tests/test_geometry.py` checks (90°, 180°, collinear,
      body scale ≈ 0.80)
- [x] `/shared` JSON synced into the frontend at dev/build time (`scripts/copy-shared.mjs`,
      same precedent as the wasm/model copy) — cue text and thresholds are never duplicated
- [x] Streaming jump/leap detection (`frontend/lib/live/jumpDetector.ts`): airborne state
      machine ported from `detect_jumps`, full metric set ported from `compute_jump_metrics`
      (leg extension, pointed feet, split angle, torso uprightness, landing plié depth);
      emits a rep event only once the move fully closes — never mid-air
- [x] Cue selection (`frontend/lib/live/scoring.ts`): ported `score_metric` + the
      dedupe/threshold/`cue_priority`-sort logic from `build_move_feedback`, returning the
      single top cue per rep
- [x] Wired into `/live`: rep counter + cue/why caption panel
- [x] Automated verification: 22 new Vitest tests green (geometry parity with the Python
      values, scoring parity, synthetic jump-detector sequences), `python -m pytest tests/`
      still 44/44 (untouched), clean `tsc --noEmit`
- [ ] **Not yet verified with a real camera** — no live jump has been observed in-browser yet.
      Before trusting this slice, confirm on `/live`: a small jump/leap in frame increments
      the rep counter once (not multiple times, not zero) and shows a plausible cue after
      landing (not mid-air)
- [ ] Turns (jumps-only this slice — `detect_turns`' shoulder-rotation signal + valley-split
      logic is a second streaming state machine, deferred to 2b-ii below) and the
      move-selector chip UI (not meaningful with only one option) also deferred to 2b-ii

### Detection fixes (jumps, leaps, arabesques — live and upload)
- [x] **Floor gate**: nothing is a jump unless the lowest point of the feet leaves the floor.
      A relevé arabesque raised the hips and split the legs with the supporting toes planted,
      and read as a split leap. Live (`floorClearRatio`) and upload (`_feet_left_floor`).
- [x] **Leaps read as jumps**: world and image landmarks each vote on the split (world depth
      compresses a leap filmed across the frame). Upload path now classifies over the airborne
      flight frames with the same separation / leg-angle / knee gates as /live, replacing the
      single-apex-frame "> 100°" test.
- [x] **Dynamic arabesques**: confirmed after 250 ms once the leg settles (plateau test) and
      emitted immediately, instead of after an 800 ms hold and only once the leg came down.
      `hold_duration_s` no longer scored for arabesques.
- [x] `detect_grand_battements` NameError on overlapping L/R candidates fixed.

### Slice 2b-ii — turn detection + move-selector chips
- [x] `frontend/lib/live/turnDetector.ts`: streaming port of the shoulder-rotation signal
      (unwrap, 5-frame median, angular velocity on real timestamps, gap merging, ≥300°)
- [x] Identification: supporting foot must stay on the floor; working leg must be in passé,
      otherwise the turn is counted as a plain "turn" with an empty metrics object
- [x] Pirouette critique (shared with `analysis/metrics.py` `_pirouette_form_metrics`):
      `releve_angle`, `retire_connection`, `spot_follow`, `turn_axis_tilt`, `hip_level`,
      `support_knee_ext`, `arm_height_high` / `arm_height_low`, `elbow_drop`
- [ ] **Not yet verified with a real camera** — spot tracking relies on face landmarks while
      the dancer faces the camera, and MediaPipe can swap left/right while the back is turned
- [ ] Valley-splitting of back-to-back pirouettes (a continuous spin is one event for now)
- [ ] Move selector chips (same pattern as `/analyze`'s `selectedMoves`/`toggleMove`)

### Slice 2c — voice
- [ ] SpeechSynthesis: max one spoken cue per rep, no repeat within 8 s, praise after 3 clean reps, mute toggle; everything spoken also captioned

### Slice 2d — live session summary and highlight reel ✅ (2026-10-07)
- [x] Stop opens a summary: the same results an upload gets (score, what to work on first, strongest,
      score per move, every move's feedback), built by `liveReport` (`lib/live/highlights.ts`); moves the
      engine was still holding back are flushed rather than lost
- [x] Optional recording ("Record a highlight reel", on by default, remembered on the device; a Rec chip
      while it runs; stops after 15 minutes): `lib/live/recorder.ts`, one part per camera or frame shape
- [x] Highlight reel cut in the browser (`lib/live/reel.ts`): each move with 1.2 s of run-up and 0.9 s of
      finish, moves under 0.8 s apart played straight through, the rest cut out; the skeleton drawn over
      it from the poses read live. Measured against the pose model reading the reel itself: within 18 ms.
      A recording's media time 0 is worked back from its end (MediaRecorder's start event comes 150-300 ms
      late, and Chrome's mp4 and webm disagree on what time 0 is)
- [x] Save to Sessions (reel, report with `source: "live"`, thumbnail, pose track); a session recorded
      without a reel saves without a video. Titled "Live session NNN"; the session page says it was live
      and how long you danced. Download reel saves the clip locally
- [ ] Backend Claude-generated natural phrasing for cues

> Note: `getUserMedia` requires a secure context — localhost is fine for dev; on a phone over the Wi-Fi use `npm run dev:phone` (https), see "Mobile app" below.

### Uploads on the live engine + friendly redesign (2026-10-04) ✅
- [x] Upload page coaches only the moves the real-footage suite verifies (straight jump, split /
      switch / calypso / russian, pirouette, à la seconde, chaîné, piqué, arabesque) — identified
      automatically, so the move-selector chips are gone
- [x] The clip is analysed in the browser by the same `MoveEngine` as /live (`lib/live/clip.ts`
      `ClipAnalyzer`, shared with the real-footage replay; `lib/upload/analyzeVideo.ts` reads every
      frame, recovering any the page was too busy to catch), on MediaPipe's CPU delegate, whose
      landmarks match the fixtures (the GPU delegate's turned one reference arabesque into two)
- [x] `MoveEngine.flush()`: a clip trimmed 0.6 s after the move still counts it (tested on all 100 clips)
- [x] `POST /sessions` saves the original video + report + thumbnail + pose track; results page
      draws the skeleton over the video and lists every move with /live's feedback
- [x] Browser verification on the 100 reference clips through the real upload page: 96/100 named and counted exactly as the answer key (fixture replays: 100/100). The four misses are detector thresholds the browser's slightly different landmarks fall on the other side of: split leap 2 missed (far ankle visibility 0.49 against the 0.5 take-off gate), switch leap 9 adds a 51° preparation as an arabesque (entry 50°), russian 9 adds an uncritiqued turn during the walk-in, à la seconde 6 splits 1 + 4 instead of 2 + 2-3 (few leg-out frames)
- [x] Redesign: warm grey / mustard / cocoa / olive palette, Bricolage Grotesque + Plus Jakarta Sans,
      rounded cards and pill buttons, mascot, sticker headline, phone tab bar with Live in the middle,
      Sessions on its own page (`/diary`)
- [x] /live stays on the GPU delegate: on the CPU it ran at 6.5 fps at 720p (GPU: 23 fps), and a
      100-clip browser run scored both 96/100. Instead the same clips are now also extracted by the
      browser's MediaPipe on the CPU and the GPU (`scripts/extract-browser-fixtures.mjs`), and the
      real-footage suite identifies moves on all three sets
- [x] Detectors made robust where the browser runtimes tipped them: a separate 0.4 ankle bar for
      opening and identifying a leap (the far ankle hovered at 0.44-0.50), brief arabesque holds need
      60 degrees, a one-frame ground glitch no longer ends an arabesque hold, a turn-round while
      walking is not counted as a turn, and a switch may close just before a late-read take-off.
      browser-gpu 96 -> 99/100, browser-cpu 95 -> 97/100, python unchanged at 100/100
- [ ] Known browser misses (KNOWN in realFootage.test.ts): à la seconde 6's seconde/pirouette split,
      arabesque 1 vetoed by the turn after it (CPU), switch leap 2's turn-round (CPU), switch leap 8
      at 15 fps (CPU)

### Live feedback feed, russians, mobile app (2026-10-05) ✅
- [x] /live keeps every rep's feedback in a feed, newest first (the last 40), instead of replacing
      the one cue card; Stop sits above it with the tallies
- [x] Russians are judged at webcam frame rates: the straddle needs 2 wide flight frames, 1 when the
      capture is slower than ~22 fps (the straddle tops out for 150-250 ms). Unjudged russians
      ("too little of you was visible") went from 1 / 3 / 9 of 30 to 0 / 0 / 1 at native / 20 / 15 fps
- [x] Installable app (`app/manifest.ts`, icons from `scripts/make-app-icons.mjs`, iPhone home-screen
      meta, `viewport-fit=cover` with safe-area insets). Chrome reports no installability errors
- [x] `public/sw.js` (production builds only): an offline page instead of the browser's error, and
      nothing else cached, so a release is never hidden behind a stale copy
- [x] Live on a phone: the preview keeps the camera's proportions (a phone held upright films 3:4 /
      9:16) within 70% of the screen height; the newest cue shows over the video for 6 s; front /
      back camera switch; the screen is kept awake during a session (Wake Lock); a rotated phone or
      the other camera restarts the engine at the new frame shape
- [x] The engine re-expresses every frame in the 16:9 units its thresholds were tuned in
      (`REFERENCE_ASPECT` in `moveEngine.ts`): replayed as 3:4 crops of the same frames, 4 of 100
      clips changed answer before (a switch leap read as a russian, a split leap went missing), 0 after.
      Turn travel is measured in true torso lengths, differenced before dividing: it read 0.2-0.4 torso
      lengths of drift into turns on the spot, depending on where in the frame the dancer stood.
      Regression test: "a phone held upright sees the same moves" (3 crops x 100 clips x 3 sets)
- [x] `npm run dev:phone`: the dev server over https so a phone on the same Wi-Fi can use the camera;
      `allowedDevOrigins` takes this computer's network addresses, and a local backend is reached
      through the dev server's `/backend` proxy (`next.config.ts`, `lib/sessions.ts`)
- [x] Production build fixed (`/auth` read the URL with `useSearchParams` and made a Supabase client
      while being prerendered)
- [ ] Live, real time at 15 fps: split leap 1 is called a switch leap about half the time, upright or
      not (frame-exact replays always say split) - the switch/split call is timing-sensitive
- [x] Spelling: the app's text is American English ("analyze", "practice", "center"); British spellings
      read as mistakes to the user
- [x] Palette: six options previewed on the real pages (https://claude.ai/artifact/7b51cVzTs5zPGvPPNNKYpR);
      the user chose Rose & teal and asked for its reference screens: Home rose with a cream sheet, results
      cream with a big score and a score line, Sessions full teal with a podium. Built 2026-10-07, mobile
      first; new app icon (gold Pip on rose). Preview: https://claude.ai/artifact/TYpJ5Uv2pT2S6EjHyRnizb
- [ ] Publishing: deploy the site (frontend + backend over https), then wrap it for the stores -
      Android through a Trusted Web Activity (Bubblewrap / PWABuilder) or Capacitor, iOS through
      Capacitor (needs a Mac with Xcode and an Apple developer account), Windows through PWABuilder
      (Microsoft Store); Mac / Windows can also install the site as an app straight from the browser

---

## Supabase setup (required to run the app)

The README links here — these are the one-time steps to run the app against your own free Supabase project.

- [ ] Create a Supabase project; run the SQL below ([Supabase SQL](#supabase-sql-run-in-sql-editor)) for the `sessions` + `jobs` tables + RLS policies
- [ ] Create private Storage buckets: `videos`, `thumbs`
- [ ] Enable Google OAuth in Supabase Auth dashboard → add `http://localhost:3000/auth/callback` as a redirect URL
- [ ] Copy `backend/.env.example` → `backend/.env` and fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Copy `frontend/.env.example` → `frontend/.env.local` and fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

> The service role key is backend-only — it must never appear in `frontend/` or be committed.

### Run commands
```bash
# Backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload   # runs on :8000

# Frontend
cd frontend && npm install
npm run dev                  # runs on :3000
```

### Supabase SQL (run in SQL editor)
```sql
-- sessions table
CREATE TABLE sessions (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID    NOT NULL REFERENCES auth.users(id),
  title         TEXT    NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  duration_s    NUMERIC,
  overall_score NUMERIC,
  move_counts   JSONB   DEFAULT '{}',
  report        JSONB,
  video_path    TEXT,
  thumb_path    TEXT
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sessions" ON sessions FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- jobs table
CREATE TABLE jobs (
  id         UUID   DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID   NOT NULL REFERENCES auth.users(id),
  status     TEXT   NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','done','failed')),
  stage      TEXT,
  percent    NUMERIC DEFAULT 0,
  session_id UUID   REFERENCES sessions(id),
  error      TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own jobs" ON jobs FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```
