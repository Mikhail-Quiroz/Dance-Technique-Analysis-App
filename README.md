# Dance Technique Analyzer

A local web app that analyzes dance technique from uploaded video. It tracks your body pose frame-by-frame using MediaPipe, automatically detects jumps/leaps and turns (pirouettes), measures technique quality, and returns an annotated video with skeleton overlay plus a detailed coaching report.

---

## Setup

**Requirements:** Python 3.10+ (tested on 3.13). All dependencies are CPU-only.

```bash
# 1. Navigate to the project folder
cd "Dance Technique App"

# 2. (Recommended) Create a virtual environment
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

# 3. Install dependencies
pip install -r requirements.txt
```

> **Note on Python 3.13 + MediaPipe:** If `pip install mediapipe` fails on Python 3.13,
> the app automatically falls back to the legacy `mp.solutions.pose` API, which works on
> all supported Python versions. If mediapipe itself won't install, create a virtual
> environment using Python 3.11 or 3.12 instead.

> **ffmpeg (recommended for fast video encoding):** The annotated video export uses
> ffmpeg (libx264) when available, and falls back to OpenCV's VideoWriter otherwise.
> Install ffmpeg for faster, more reliable H.264 output:
> - macOS: `brew install ffmpeg`
> - Ubuntu/Debian: `sudo apt install ffmpeg`
> - Windows: download from <https://ffmpeg.org/download.html> and add the `bin/` folder to your PATH

---

## Run

```bash
streamlit run app.py
```

Open your browser to `http://localhost:8501`. Upload a video, click **Analyze**, and wait for results.

**Processing time:** approximately 1–2× video duration on a modern laptop CPU for a 30-second clip.

---

## Recording Tips

For best results:

| Tip | Why |
|-----|-----|
| Landscape orientation | Full-body tracking requires horizontal framing |
| Whole body visible head-to-toe | All 33 landmarks must be in frame throughout |
| One dancer only | Multi-dancer scenes confuse the tracker |
| 30+ FPS | Fast moves (turns, landings) may be missed at lower frame rates |
| Plain background | Reduces false detections |
| Side-on camera for leaps | Best for measuring split angle and leg extension |
| Front-on camera for turns | Best for shoulder rotation and alignment |

---

## Pipeline Overview

```
Upload (.mp4/.mov)
  → resize (long side ≤ 960 px)
  → MediaPipe PoseLandmarker → 33 landmarks/frame (.npz cache)
  → 5-frame centered moving-average smoothing
  → compute body_scale (shoulder–ankle distance)
  → detect jumps (hip elevation baseline crossing)
  → detect turns (shoulder vector rotation, world landmarks)
  → measure technique metrics at key frames
  → score 0–100, select top coaching cues by priority
  → render annotated MP4 (skeleton + labels + angle callouts)
  → show report (Streamlit) + save report.md / report.json
```

---

## Limitations

- **Turn metrics are approximate.** MediaPipe estimates depth (Z) from a single 2D camera, so shoulder-rotation angles and relevé height during turns have higher uncertainty than jump metrics. Use turn scores as directional guidance, not precise measurements.
- **Camera angle matters.** Angles measured from a non-ideal angle (e.g. front-on for a leap) will read lower than reality. A side-on view is needed for accurate split angles and leg extension.
- **2D video only.** True 3D joint angles require a multi-camera or depth sensor setup.
- **Not medical advice.** Technique corrections are pedagogical guidance only. Consult a qualified teacher or physiotherapist for injury-related concerns.
- **One dancer.** Multiple people in frame will confuse the pose tracker.
- **FPS matters.** Videos below 24 FPS may miss fast move onset/landing frames.

---

## Outputs

After analysis, three files are saved to `outputs/`:

| File | Description |
|------|-------------|
| `<name>_annotated.mp4` | Original video with skeleton overlay, move labels, and angle callouts |
| `report.md` | Human-readable coaching report in Markdown |
| `report.json` | Machine-readable report with all scores and cues |

Pose landmarks are cached to `outputs/<name>.mp4.pose.npz` — re-analyzing the same video skips inference and is nearly instant.

---

## Running Tests

```bash
python -m pytest tests/ -v
```

Tests cover geometry utilities (angle calculations, smoothing), synthetic jump detection, and synthetic turn detection.

---

## Project Structure

```
Dance Technique App/
  app.py                    Streamlit UI
  pose/extractor.py         Video → landmarks with .npz cache
  analysis/moves.py         Jump + turn detection
  analysis/metrics.py       Joint angle and alignment metrics
  analysis/feedback.py      Thresholds → scores → cue selection
  knowledge/cues.py         Coaching cue knowledge base
  render/overlay.py         Annotated video renderer
  utils/geometry.py         angle_at, smoothing, body_scale helpers
  tests/
    test_geometry.py        Geometry unit tests
    test_moves.py           Jump detection on synthetic data
    test_turns.py           Turn detection on synthetic data
    videos/test.mp4         Test clip
  outputs/                  Generated files (annotated video, reports)
  models/                   MediaPipe .task model (downloaded on first run)
  requirements.txt
  README.md
```

---

## V2 Ideas

Features deliberately out of scope for this MVP:

- **Multiple dancers** — detect and track individual performers in a group scene
- **Music/beat sync** — correlate jump timing with musical phrases
- **3D mesh models** — use a volumetric body model for true 3D angle measurement
- **Reference comparison** — compare the dancer's technique against a professional reference video
- **Style/artistry scoring** — dynamics, musicality, spatial patterning
- **Mobile app** — native iOS/Android capture and analysis
- **Login/accounts** — save and compare sessions over time
- **Progress tracking** — trend graphs for each metric across sessions
