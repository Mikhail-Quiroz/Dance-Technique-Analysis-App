# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests
python -m pytest tests/ -v

# Run a single test file
python -m pytest tests/test_pipeline_end_to_end.py -v

# Backend (from backend/)
uvicorn main:app --reload   # http://localhost:8000

# Frontend (from frontend/)
npm run dev                 # http://localhost:3000
npm run dev:phone           # same over https, for a phone on the same Wi-Fi (camera needs https)
node scripts/make-app-icons.mjs   # app icons (Pip) after changing the mascot; needs Chrome
npx vitest run              # /live detector tests, incl. the real-footage suite (lib/live/fixtures/real/)

# Real-footage fixtures for /live: after adding clips under videos/reference/<move>/
python scripts/cut_recording.py "<folder>/full recording/<file>.MOV" 8.5 13.6 ...   # one long recording -> clips
python scripts/extract_live_fixtures.py          # --force re-extracts existing ones; skips "full recording/"
# ...then the same clips read by the browser's MediaPipe (from frontend/, needs Chrome; FORCE=1 redoes)
node scripts/extract-browser-fixtures.mjs cpu    # lib/live/fixtures/browser-cpu - what uploads run
node scripts/extract-browser-fixtures.mjs gpu    # lib/live/fixtures/browser-gpu - what /live runs

# Legacy Streamlit app
streamlit run legacy_streamlit/app.py

# Disable pose-stride sampling (maximum accuracy)
POSE_INFERENCE_STRIDE=1 python ...
```

## Scope: technique movements only

This platform critiques **technique-based movements** — turns (pirouettes), leaps, jumps, flips,
arabesques, battements — and nothing else.

Those moves have a *correct answer*. A pirouette has a defined retiré position, a vertical axis and
a spot; a jeté has a defined split, extension and landing. The geometry is the technique, so
measuring joint angles against thresholds is a legitimate critique, and a dancer can act on it.

**Contemporary / interpretive movement is deliberately out of scope.** There is no correct shape to
measure it against — the choice of shape *is* the artistic content. Scoring it would be like asking a
model to grade an original painting: it can report angles, but the angles do not mean anything
about whether the movement was good. A numeric score on contemporary movement would be confidently
wrong, which is worse for a dancer than no score.

Practical consequences for anyone working in this repo:

- Never add a detector or a cue for a movement whose "correct" form is a matter of interpretation.
- A detector that cannot confidently identify *which* technique move it is seeing must not score it.
  `JumpRepDetector` already works this way: a rep it cannot confirm as a leap is emitted as a plain
  jump with **no metrics at all**, so there is structurally nothing for the leap scorer to score
  (see `finalizeRep` and `jumpFeedback` in `lib/live/scoring.ts`). Copy that pattern — an empty
  metrics object, not a lowered threshold.
- Misclassifying one technique move as another is the failure mode to guard hardest against, because
  it produces confident coaching about a move the dancer did not perform.

## Architecture

This is a monorepo: a **FastAPI + Next.js 16** web platform (`backend/`, `frontend/`) plus the older
Python analysis pipeline, which the **legacy Streamlit app** (`legacy_streamlit/app.py`) still uses.

### Uploads run the live engine, in the browser

Both `/live` and the upload page (`/analyze`) analyse with **one** engine: MediaPipe's lite pose model
in the browser, through `MoveEngine` (`frontend/lib/live/moveEngine.ts`). It only names the moves the
real-footage suite verifies (`lib/moves.ts` `COACHED_MOVES`): straight jump; split / switch / calypso /
russian / firebird / tilt / switch tilt / switch arabesque leaps; pirouette, à la seconde, changing-spot,
chaîné and piqué turns; front and side battements, fan kicks, illusions; arabesque. See "Moves added
2026-10-10" below for how the newer ones are told apart and what can't be.

- `lib/live/clip.ts` `ClipAnalyzer`: a recorded clip through the engine, frame by frame, then
  `MoveEngine.flush()` at the end of the clip. `replay.ts` (the real-footage tests) and the upload page
  both use it, so an upload is analysed exactly the way the 100 reference clips are tested.
- `lib/upload/analyzeVideo.ts`: plays the uploaded file in a `<video>` that is on the page, pausing on
  every frame (`requestVideoFrameCallback`) while the pose is read, and steps back to any frame that went
  by without a callback. Footage above ~35 fps is read at ~30. Safari reports no frame for a seek made
  while paused (waiting for it froze uploads on an iPhone), so the first step back that reports nothing
  turns stepping back off for that clip. A frame that isn't reported within 1.5 s is not waited for, and
  three in a row end the analysis with an error (`walkFrames`, tested in `walkFrames.test.ts` against a
  fake video). The screen stays awake while a clip is analyzed (`lib/useWakeLock.ts`, shared with /live).
- `lib/upload/report.ts`: the session report (`version: 2`) - every move with the same feedback /live
  gives (`feedbackFor`), plus score / focus / strongest. `normalizeReport` also reads sessions saved
  by the old pipeline (marked `legacy`).
- `lib/upload/poseTrack.ts`: the skeleton saved with a session (gzipped integer deltas), drawn over the
  video on playback.
- `POST /sessions` saves the original video, the report, a thumbnail and the pose track. The old
  `POST /analyze` + `/jobs` server pipeline is no longer called by the web app.

**Delegates** (`delegateFor` in `lib/live/pose.ts`; `?delegate=cpu|gpu` overrides it in development):
`/live` runs the GPU delegate - on the CPU it managed 6.5 fps at 720p on an Iris Xe laptop, against 23
on the GPU. Uploads run the CPU delegate: no real-time constraint, deterministic, and closest to the
Python fixtures.

**Three fixture sets.** The Python fixtures (`fixtures/real`, MediaPipe 1.0.1) are what the critiques
were checked against frame by frame. `fixtures/browser-cpu` and `fixtures/browser-gpu` are the same
frames read by the browser's `@mediapipe/tasks-vision` (scripts/extract-browser-fixtures.mjs). The
runtimes disagree by ~0.5% of the frame, which tipped detectors sitting on a threshold, so the
real-footage suite runs identification on all three (`FIXTURE_SETS` in `replay.ts`). Remaining
misses are listed, each with its reason, in `KNOWN` in `realFootageExpect.ts` and run as `it.fails`
(`report.test.ts` skips them too). Scores on the original ten folders (2026-10-05): python 100/100
(15 fps 77/77), browser-gpu 99/100 (77/77), browser-cpu 97/100 (75/77); the new folders are scored
below.

**Any frame shape.** The thresholds were tuned on 1280x720 footage, and many are image x-distances over a
torso length. A phone held upright films 3:4 or 9:16, so `MoveEngine` re-expresses every frame in 16:9
units on the way in (`REFERENCE_ASPECT`; the identity on 16:9). The suite replays every clip as upright
crops, centred and off to one side, and expects the same moves and feedback ("a phone held upright sees
the same moves"). Measure distances from differences (positions mean nothing on their own) and in true
proportions (x times the aspect).

### Moves added 2026-10-10

Ten new folders under `videos/reference/` (each has a `clips.md`: original filename -> `<move> N`, angle,
leg, deliberate mistakes). Needle is not done yet (the user will find clips).

- **Leaps** (`jumpType.ts` `classifyJump`, in order after hop / sashay / jump and the rise check):
  calypso (entry turn), **firebird** (both wrists above the nose and the face up, not a straddle), then
  **one leg high** (`oneLegHighEvidence`, read after the switch's low point when there was one): head
  facing the camera -> `tiltJump` / `switchTilt`, head turned with a switch -> `switchArabesque`; then
  russian, switch, split.
- **Kicks** (`kickDetector.ts`): a leg past 138 degrees on screen (arabesques peaked at 136). Facing
  the camera (since 2026-10-15): the foot sweeping well past the center line is a **fan kick**; one
  that stays out but tops out near its own hip line, the leg rising forward in 3-D, is a **front
  battement**; otherwise a **side battement**; a leg behind in 3-D is not a kick. Side-on: a foot
  rising in front is a **front battement**; behind is left to the arabesque detector. Kicks wait out turns and flights (`MoveEngine.release`), and a
  kick inside a closed turn of 300+ degrees or a real leap is dropped. Critiques: height, straight
  knee (battements only: a fan kick's knee blurs), standing knee, and arm steadiness (both arms in
  second, from the front only, measured against the torso).
- **Illusion** (`illusionDetector.ts`): torso past horizontal with a leg 120+ degrees, then the
  engine requires a 140+ degree turn read 1.2 s later. Guards against tracker glitches: the standing
  leg down on 75% of frames, visibility, torso length vs. upright, 1.5 s at most. Moves inside an
  illusion are dropped.
- **Changing spot** (`turnDetector.ts` `spotChanges`): the slowest moment of each second turn is its
  spot; two or more second turns (not counting the last, which runs into the pirouettes) spotted
  60+ degrees from the circular median of the first three make it `changingSpot`. `maxTurnMs` is
  20 s for long sequences.
- **Russian / calypso exit turn:** a turn starting within 1 s of the landing is not counted (the
  user's rule).
- App text calls à la seconde turns **second turns**, spelled out (the user's choice, 2026-10-14: the audience is mostly competitive dancers, and "2nd" looks tacky), and the leg position "in second". The code keeps `seconde` in keys, metric names and cue IDs.
- Kicks share the balances family since 2026-10-13: `hold` is "Balances & kicks" (the user's choice: one balance alone was too thin, and they preferred its green to the kicks' former violet). Kick moves keep the kick icon in the green badge (`MoveIcon`); `normalizeReport` reads a saved report's old `kick` family as `hold`.

**What the webcam can't do** (so neither the app nor the answer key tries):
- **Floaters** are told by the arms, not the plié: hip height per turn overlaps completely with
  regular second turns on a webcam (see "Floaters, knees and fan kicks" below). A floater danced with
  the arms down is a regular second turn to the app.
- **Fan kicks need a front view**: their sweep across the body is hidden from the side. From the
  front, a front battement and a side battement are told apart by the leg's 3-D direction on the way
  up, which a fast kick can skip in one frame; side-on they are certain.
- **Switch arabesque vs. switch tilt** rests on the head direction and the filming angle.
- **15 fps** loses many switches (the switch falls between frames).
- Not critiqued: a fan kick's chest curl, hands touching the floor in an illusion, arm steadiness
  during turns.

Identification, native fps (python / browser-cpu / browser-gpu): firebird 10/10/10, side battement
10/10/10, illusion 10/10/8, changing spot 9/8/9, floater (as seconde) 9/9/9, tilt jump 9/9/8, switch
tilt 8/7/7, switch arabesque 7/8/6, front battement 6/7/7 of 9, fan kick 6/5/7.

### iPhone re-shoots (2026-10-13)

Five `High Quality - <move>` folders: fan kick, front battement, switch arabesque, a floater test and
changing spot. Each was filmed as one long iPhone recording (kept in the folder's `full recording/`)
and cut at the pauses with `scripts/cut_recording.py`; `clips.md` says what is in each clip. The
iPhone filmed 1080p HDR (HLG): the clips are tone-mapped to standard range, which is what a browser
shows (read as-is, HLG comes out washed out). Chrome on the user's laptop plays the HEVC originals.

- Fan kicks: the 3-D depth put some left fan kicks "behind", which handed them to the arabesque
  detector. A foot that sweeps well past the midline (`fanSureCrossTorso`) is now a fan kick
  whatever the depth says.
- A kick must last `minKickMs` (100 ms; the shortest of 402 real kicks was 144): a 33 ms "kick" in a
  leap's run-up was a tracking glitch.
- Front battements facing the camera (clips 9-14) read as fan kicks or side battements until
  2026-10-15, when the front-on kick rules changed (see "Blind test" below). Side-on, all 8 were right.
- A leap with one leg high and one low that also passes the straddle test is not a russian (a
  russian lifts both legs together): with the head turned and no switch seen it is `leapUnsure`,
  counted and never scored. Switch arabesque 4 read as a russian on every reader before.
- `realFootage.test.ts` yields to the event loop before each test (the file runs minutes of
  synchronous replays; vitest's worker otherwise times out on its own progress calls), and the
  upright-phone crop test is one test per folder.
- Floaters: with iPhone footage the standing knee does differ (floater turns 159-178 degrees at the
  20th percentile, regular 2nd turns 140-168), right on about 5 turns in 6 - not enough to name a
  floater on its own. Arms up marks every floater in the user's clips, so it is what names them
  (next section).

Identification, native fps (python / browser-cpu / browser-gpu): fan kick 12/12/12 of 13 (the laptop
clips: 6/5/7 of 10), front battement side-on 8/8/8 of 8 (facing the camera 0/6, 6/6 since
2026-10-15), switch arabesque 6/6/6 of 8 (clip 4 is an unsure leap), floater test as seconde 5/6/6 of
6, changing spot 3/2/3 of 4. At 15 fps switch arabesques mostly fail (1-2 of 8). The switch tilt and
second turn re-shoots came on 2026-10-14 (next sections).

### Floaters, knees and fan kicks (2026-10-13)

- **Floaters** (`turnDetector.ts` `floaterTurns`, the user's choice: arms up plus a straight knee).
  Each second turn of an à la seconde sequence (one rotation, counted from the sequence start) is a
  floater when both wrists are above the nose on 40%+ of its frames and its standing knee's 20th
  percentile on screen is 145+. Every regular and changing-spot turn on the reference footage had
  the arms up on 0-11% of frames; floater turns 46-100%. The sequence stays `seconde` with
  `TurnEvent.floaters` (shown as "... second turns with floaters"); the count runs about one short
  (the arms rise during the first floater), so it is not shown. Turns with the arms 20%+ up are left
  out of the changing-spot check: a floater has no spot pause, and two floater sequences read as
  changing spot before. Critique: `floater_support_knee` (median standing knee of the least straight
  floater). Laptop floater clips 1 and 5 keep the arms in second and are known misses.
- **Knees "fully locked"** (the user: every move except the calypso's back leg). Every straight-leg
  knee metric now scores 170 excellent / 95 poor, so a correction fires below 155 (it was 151; 139
  for kicks). Not stricter: legs checked straight frame by frame read as low as 155-159 on the laptop
  footage (calypso 10's front leg, piqué 2's standing leg, à la seconde 7, the standing-still test),
  so the camera cannot tell "locked" from "nearly locked" above that.
- **New knee critiques**: `arabesque_leap_back_knee` (switch arabesque) and `tilt_leg_knee` (tilt
  jump, switch tilt) - the high leg's knee on the three top frames (`jumpMetrics.highLegKnee`, the
  straighter of 3-D and screen, which the flight samples now carry as `kneeImgL/R`). The iPhone
  switch arabesques read 139-154 where the back knee is bent on the video (1, 2, 5) and 169-176
  where it is straight.
- **Fan kick circle** (`kickDetector.ts` `fanCircleEnd`, the user's rule: the foot draws a full
  circle and must not drop flat at the end): where the foot passes hip height on the way down, as a
  share of its full reach (`fan_full_circle`, 0.85 / 0.40). Round fans 0.81-0.95 on the iPhone
  footage; right-leg fans that dropped straight down 0.18-0.33. Locked in by "real footage — fan
  kicks (iPhone)" and "switch arabesques (iPhone)" in `realFootage.test.ts`.

### Blind test and upright iPhone footage (2026-10-14/15)

The user filmed three blind videos (`videos/blind/`, ten moves each in an order they kept to themselves
until the app had answered; `BLIND_KEY` in `realFootageExpect.ts`) and three folders on an iPhone held
upright (1080x1920):
- `High Quality - Second Turns`: 2+2, 3+2, 2+3, 3+3 and 4+2 on both sides.
- `High Quality - Switch Tilt`: 14 leaps travelling across the narrow frame.
- `High Quality - Fan Kick vs Front Battement`: both kicks facing the camera, keyed per clip with
  `FolderExpectation.moves`.

The blind videos are tone-mapped at full length, camera setup and all, as a user's upload would be.
Both extractors read `videos/blind/` into `fixtures/<set>/blind/`. The browser extractor allows 2 h
per page call, because a two-minute video is 3,700 seeks. The "blind test" block of
`realFootage.test.ts` checks each video's moves against the key in order (longest common
subsequence), allowing the shortfalls listed with their reasons in `BLIND_SCORE`.

**Before any change (Python reader): 26 of 30 named in order, 4 moves invented.** What changed, with
the numbers in the code comments:
- **A hop's landing hid the leap after it.** A firebird was missed, and a split leap read as the
  arabesque of its trailing leg.
  - `JumpRepDetector` now closes a hop (a rise under `JUMP_TYPE_CONFIG.minJumpRiseTorso`) at once,
    with no landing window or refractory, and a rise that never left the floor gets no refractory.
  - A flight too short to count keeps the refractory: firebird 6 relies on it.
  - `MoveEngine`'s "no arabesque just after a landing" ignores hops, which are now reported the
    moment they land.
- **Switches read where there were none.**
  - A chassé's open step long before the take-off is not a brush unless a leg is kicked up on screen
    (`switchEarlyBrushMs` / `switchEarlyBrushImageDeg`).
  - The legs closing in the last 15% of the flight, into a narrower opening, are the landing
    (`switchLateFrac` / `switchLateSplitShare`).
  - Switch arabesque 9 had passed only on such a landing. It is now a known miss: its real brush
    reads 44 degrees through the blur.
- **A calypso's entry must be a real spin**, 100+ degrees a second on average (`minEntryTurnDegPerS`).
  Calypsos' chaînés went 150-630; the slow turn to face the camera before switch tilt 4 went 57.
- **An arabesque needs both legs clearly tracked**: every leg point at 0.75+ visibility, median over
  the hold (`minLegVisibility`). Legs hidden behind furniture read 0.65; real arabesques 0.82+.
- **Kicks from the front:**
  - a fan kick sweeps past the midline: second-closest frame under -0.25, or (for 15 fps) one frame
    under -0.5 in a sweep 1.5+ wide;
  - otherwise a foot that tops out within 0.4 of its hip line, with the leg rising forward in 3-D,
    is a front battement;
  - otherwise a side battement.
- **A clip that ends mid-turn:** `MoveEngine.flush` now closes a turn still going on the last frame
  (second turns 5 and 7 ended 0.3 s after the last pirouette). It does so only for a turn named by
  its shape: a chaîné or an unnamed spin there was the dancer turning to walk away.

After (python / browser-cpu / browser-gpu):

| Clips | Result |
|---|---|
| Blind test | 29+1 / 26+5 / 29+3 of 30 (named in order + invented) |
| Second turns | 10/10/10, every count exact |
| Fan kick vs front battement | 9/9/9 of 10 |
| Front-facing front battements (HQ 9-14) | 6/6/6 |
| Switch tilts | 9/8/8 of 14 |

Switch tilts at 15 fps mostly fail. The misses:
- **Switch tilts entering the frame:** the dancer comes into the upright frame just before taking off,
  so the run-up and the brush are partly missed. Two others don't show the switch from the front.
- **A split leap danced facing the camera with the chest open** reads as a russian: shoulders and
  hips read square to the camera.
- **Both blind illusions on the CPU reader:** the reference illusions pass there, and the old code
  missed them too.
- **A calypso that travels under 0.3 torso lengths** gets no critique: `legShape` needs the travel
  direction.
- **During the camera setup** (the dancer against the lens, the legs out of the picture), the browser
  readers invented jumps and a side battement. The GPU reader also turned a left/right swap into a
  300-degree turn.

### Live session summary and highlight reel

Stop on `/live` opens `app/live/LiveSummary.tsx`: the upload results (`components/results/Results.tsx`)
for the session, from `liveReport` (`lib/live/highlights.ts`, unit-tested), over a highlight reel when
the session was recorded.

- `lib/live/recorder.ts` records the camera (opt-in toggle, on by default; 15-minute limit) in parts: a
  camera switch or a turned phone starts a new part. The live loop logs the poses alongside (`PoseLog`).
- `highlightSegments` picks each move with `LEAD_MS` before and `TAIL_MS` after, inside its part, merging
  near neighbors; `lib/live/reel.ts` `cutReel` plays those stretches into a canvas and records it with
  the recorder paused in between, then `reelTrack` puts the skeleton on the reel's clock. The recorder
  runs on the wall clock, so it resumes on each new frame and pauses whenever frames stop coming (a
  muted video the browser paused off screen, buffering): otherwise those moments record as a frozen
  picture. Each segment and the finished file's length are logged as `[reel] ...` (the user reported
  reels freezing around a move on laptop and phone; it did not reproduce with a fake camera). A part's media
  time 0 is its stop time minus its length: never trust MediaRecorder's start event for timing.
- Saving reuses `POST /sessions` with the reel as the video and `source: "live"` in the report; a live
  session without a reel is saved without a video (uploads still require one).

### Website, phone and laptop app

The platform is meant to ship as a website, a mobile app and a laptop app from this one codebase, so
keep every page usable at phone width and avoid browser-only assumptions that a store wrapper breaks.

- Installable now: `app/manifest.ts` (standalone, icons in `public/icons/` and `app/apple-icon.png`,
  made by `scripts/make-app-icons.mjs`), `viewport-fit=cover` with safe-area insets on the header, the
  phone tab bar and `<body>`.
- `public/sw.js`, registered by `components/pwa/ServiceWorker.tsx` in production builds only: an offline
  page (`public/offline.html`) for navigations and nothing else, so it never serves stale code. In
  development it unregisters itself.
- `/live` on a phone: the preview keeps the camera's proportions, the newest cue flashes over the video
  (`animate-flash`), front/back camera switch, Wake Lock while a session runs.
- `npm run dev:phone` serves over https (first run installs a local certificate authority; the phone
  shows a certificate warning to accept). `allowedDevOrigins` includes this computer's network
  addresses. When the backend is on this computer and the page is not plain `http://localhost`,
  `lib/sessions.ts` calls it through the same-origin `/backend` rewrite (`next.config.ts`). Next 16
  buffers a request body for the middleware up to `experimental.proxyClientMaxBodySize` even on paths
  its matcher skips; at the default 10 MB, saving an iPhone upload failed ("socket hang up"), so it
  is 250 MB.
- Store packaging (not done yet): Android by Trusted Web Activity (Bubblewrap / PWABuilder) or
  Capacitor; iOS by Capacitor (needs a Mac with Xcode); Windows by PWABuilder; desktop browsers can
  install the site directly.

### Python pipeline (`analysis/`, `pose/`, `render/`, `utils/`, `knowledge/`) - legacy

Four stages run in sequence:
1. **Pose extraction** (`pose/extractor.py`): MediaPipe PoseLandmarker → `(N, 33, 4)` arrays. Content-hash NPZ cache in `pose_cache/`; stride-2 sampling with linear interpolation for 2× speedup.
2. **Move detection** (`analysis/moves.py`): jumps, turns, arabesques, battements, tilts, compounds.
3. **Metrics + feedback** (`analysis/metrics.py`, `analysis/feedback.py`): joint angles → scores 0–100 → coaching cues selected by priority.
4. **Video render** (`render/overlay.py`): skeleton overlay + move labels → ffmpeg libx264 (primary) or OpenCV H264 (fallback). Output: 720px long side.

`shared/cues.json` and `shared/thresholds.json` are the single source of truth for all coaching cues and scoring thresholds. Do not hardcode cue text or threshold values elsewhere.

### Backend (`backend/`)

FastAPI. Entry point: `backend/main.py` (adds monorepo root to `sys.path`).

- `core/config.py`: Pydantic Settings loads `.env`
- `core/auth.py`: `get_current_user` FastAPI dependency — verifies Supabase Bearer JWT via service role client
- `core/pipeline.py`: `run_pipeline()` — sync 4-stage wrapper run via `BackgroundTasks`; saves results under `backend/job_results/{job_id}/`
- `routers/sessions.py`: `POST /sessions` (save a browser-analysed upload: video ≤200 MB as .mp4/.mov/.m4v/.webm, version 2 report, thumb, pose track), list / get / rename / delete. In local mode a session lives in `job_results/{id}/` (`video.<ext>`, `report.json`, `thumb.jpg`, `pose.json.gz`); in Supabase mode the pose track sits next to the video as `<user>/<id>.pose.json.gz`.
  A new session is named "Session N" or "Live session N" (`_next_title`: one past the highest number
  of its kind, so a delete never repeats a name and renamed sessions don't count). The frontend shows
  names saved before that ("Session 013 — Oct 05, 2026") as "Session 13" (`lib/sessionNames.ts`
  `displayTitle`); the stored titles are not migrated.
- `routers/analyze.py`, `routers/jobs.py`: the old server pipeline (`POST /analyze`, `GET /jobs/{id}`). Unused by the web app since uploads moved to the browser.

**Security**: `SUPABASE_SERVICE_ROLE_KEY` must stay backend-only (`backend/.env`). Never expose it to the frontend.

### Frontend (`frontend/`)

Next.js **16** + React 19 + Tailwind **4** (CSS-first, no tailwind.config.js). **Read `frontend/AGENTS.md` before editing frontend code** — this Next.js version has breaking API changes.

- `app/layout.tsx`: server component; reads Supabase user for `<Navbar>` (top pill nav; on phones a bottom tab bar where the current tab grows into a pill of its page's colour with its name - Upload rose, Live gold, Sessions teal with white text - and the others are icons, animated; the user's choice over a raised Live button)
- Routes: `/analyze` upload + results, `/live` camera coaching, `/diary` the sessions grid, `/session/[id]` one saved session
- `middleware.ts`: protects `/analyze`, `/diary`, `/session/*`, `/live`; uses `getUser()` not `getSession()`
- `lib/supabase.ts`: browser client (`createBrowserClient`)
- `lib/supabase-server.ts`: server client (`createServerClient` with cookies)

**Env vars**:
- Frontend: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_BACKEND_URL` → `frontend/.env.local`
- Backend: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FRONTEND_ORIGIN` → `backend/.env`

**Copy** is American English ("analyze", "practice", "center", "color"): the user reads British spellings as
mistakes.

**Design system** (`app/globals.css`): Rose & teal, from the user's reference app (chosen 2026-10-07). Friendly,
rounded and playful: a soft rose page `paper` (#F8E3EB), cream `surface` cards, gold `sun` (#F5B13D) primary
pills, ink `btn-dark` pills for the second action, `rose` / `teal` / `gold` / `sage` blocks, `text-ink`
(#2A2224) / `text-muted` (#6E5C63). Legacy names keep their roles: `cocoa` is the dark feature card (deep teal),
`olive` balances and praise (teal), `lilac`/`grape` turns and headline accents (rose). Headlines `font-display`
(Bricolage Grotesque), everything else `font-sans` (Plus Jakarta Sans). Every text colour is checked against
what it sits on (4.5:1, 3:1 for big headings); grey text is not used on rose or teal.

- **Screens.** A page marks its root `data-screen` and the whole window takes the colour (CSS `:has()`, no
  flash): `home` rose (Home, sign-in), `teal` (Sessions), `cream` (results: upload results, a saved session,
  the Live summary; and Live itself, which the user wanted to look like a session's page); default blush. `<ScreenColor>` tints the phone's status bar to match. On rose
  and teal the content sits in a `.sheet` (cream, rounded top; no grab handle, which the user read as a stray line) that runs to the bottom. Teal
  screens carry faint diagonal stripes from the very top, behind the header.
- **Live's detector readout** (raw signals, state machines, fps) shows only on a development server opened
  with `?debug` (e.g. `/live?debug`); the user found it in the way while dancing.
- **Home** (`app/analyze/AnalyzeClient.tsx` + `HomeParts.tsx`): greeting and date, a dark "Start live coaching"
  pill, Pip peeking over the sheet, the practice numbers, a gold "Analyze a clip" block, the latest session as
  a teal player with a score ring.
- **Results** (`components/results/Results.tsx`): a big score, three tall stat tiles, the video beside "Work on
  this first" / "Your strongest", and `ScoreLine` (scored moves as a smooth line, change bubbles, the lowest
  move's score in a dark tag).
- **Video player** (`components/results/SkeletonVideo.tsx`): our own controls (play, seek, time, 1× / 0.5× /
  0.25×, sound, full screen), not the browser's: its full screen showed the video without the skeleton, and
  its dark control shade stayed up. Full screen takes the whole player (video, skeleton, "Hide skeleton"),
  and the controls fade after 2.2 s without the pointer moving - in full screen even while paused. An
  iPhone has no full screen for page elements, so there the player fills the window (`fixed inset-0`).
- **Sessions** (`app/diary/SessionsClient.tsx`): teal with a Latest / Top scores toggle, a podium for the best
  three, tinted cards on the sheet (rows on a phone).
- Component classes: `btn btn-sun|btn-dark|btn-outline|btn-quiet`, `chip`, `field`, `eyebrow`, `icon-btn`,
  `sheet`, `stripes`. Layout grids use `grid-cols-1` / `minmax(0, …)` columns so one-line text truncates
  instead of widening the page on a phone.
- Move families have fixed colours (leaps gold #E3901F, turns rose #A6354F, balances & kicks teal #2E9E86: `bg-chart-*`
  and `FAMILY_FILL` for marks, `FAMILY_STYLE` in `components/ui/MoveIcon.tsx` for badges), checked with the
  dataviz palette validator. Icons are inline SVG (`components/ui/Icon.tsx`); the mascot Pip is
  `components/ui/Mascot.tsx` (gold by default; the app icon is gold Pip on rose).

### Supabase schema

```sql
-- sessions: one row per completed analysis
id, user_id, title, created_at, duration_s, overall_score,
move_counts (JSONB), report (JSONB), video_path, thumb_path
RLS: user_id = auth.uid()

-- jobs: background job progress
id, user_id, status (queued/running/done/failed), stage, percent,
session_id (FK → sessions), error
RLS: user_id = auth.uid()
```

Storage buckets: `videos` (the uploaded video and its `.pose.json.gz`; old sessions: annotated mp4), `thumbs` (thumbnail jpg). Both private.

## Roadmap status

See `ROADMAP.md` for full detail. Summary:

| Phase | Slice | Description | Status |
|-------|-------|-------------|--------|
| 1 — Upload & analyze | 0 | Shared JSON + monorepo scaffold | Done |
| 1 | 1 | Auth (email + Google OAuth) | Done |
| 1 | 2 | Upload + results UI (now analysed in the browser by the live engine) | Done |
| 1 | 3 | Persistence + session gallery (/session/[id]) | Done |
| 1 | 4 | Polish, mobile (installable app done), migration script | In progress |
| 2 — Real-time live coaching (/live) | 2a | Camera + mirrored live skeleton overlay | Done |
| 2 | 2b | Live rep detection + on-screen cue + rep tally | Done |
| 2 | 2c | Voice cues via SpeechSynthesis | Not started |
| 2 | 2d | Live session summary + highlight reel, saved to Sessions | Done |

There is no "Learn mode" / Duolingo-style teaching phase — this is a dance analysis + corrections platform, not a teaching platform. After Phase 2, the plan is deployment + store packaging (website, mobile app, laptop app; see "Website, phone and laptop app").
