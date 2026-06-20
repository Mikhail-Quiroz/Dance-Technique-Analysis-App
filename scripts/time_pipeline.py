"""Per-stage timing probe for the analysis pipeline.

Run from the repo root:
    python scripts/time_pipeline.py [path/to/video.mp4]

Defaults to tests/videos/test.mp4.  Prints elapsed seconds for every major
sub-step so we can pinpoint the bottleneck without modifying the real pipeline.
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

VIDEO = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests/videos/test.mp4"

if not VIDEO.exists():
    sys.exit(f"Video not found: {VIDEO}")

# ── helpers ───────────────────────────────────────────────────────────────────

_t0 = time.perf_counter()

def _lap(label: str, ref: float) -> float:
    now = time.perf_counter()
    print(f"  {now - ref:7.3f}s  {label}")
    return now


def section(title: str) -> None:
    print(f"\n{'-'*60}\n{title}")


# ── video properties ──────────────────────────────────────────────────────────

import cv2
cap = cv2.VideoCapture(str(VIDEO))
fps_src    = cap.get(cv2.CAP_PROP_FPS)
n_frames   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
w_src      = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h_src      = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
cap.release()
duration_s = n_frames / fps_src

section("VIDEO")
print(f"  path      : {VIDEO}")
print(f"  size      : {VIDEO.stat().st_size / 1024:.0f} KB")
print(f"  resolution: {w_src}×{h_src}")
print(f"  frames    : {n_frames}  @  {fps_src:.1f} fps  =  {duration_s:.1f} s")

# ── imports (measure import overhead) ─────────────────────────────────────────

section("IMPORTS")
t = time.perf_counter()

from pose.extractor import (
    PoseExtractor, _TASKS_AVAILABLE, _LEGACY_AVAILABLE,
    _MODEL_PATH, INFERENCE_STRIDE, _CACHE_DIR, _cache_path,
)
t = _lap(f"pose.extractor  (tasks_api={_TASKS_AVAILABLE}, legacy={_LEGACY_AVAILABLE},"
         f" stride={INFERENCE_STRIDE})", t)

from utils.geometry import smooth_landmarks, compute_body_scale
t = _lap("utils.geometry", t)

from analysis.moves import (
    detect_jumps, detect_turns, detect_arabesques,
    detect_grand_battements, detect_tilts, detect_compound_jumps,
)
t = _lap("analysis.moves", t)

from analysis.metrics import compute_jump_metrics, compute_turn_metrics
t = _lap("analysis.metrics (sample)", t)

from analysis.feedback import build_move_feedback, build_session_report, report_to_dict
t = _lap("analysis.feedback", t)

from render.overlay import render_annotated_video
t = _lap("render.overlay", t)

# ── model file ────────────────────────────────────────────────────────────────

section("MODEL")
print(f"  tasks model path  : {_MODEL_PATH}")
print(f"  tasks model exists: {_MODEL_PATH.exists()}")
if _MODEL_PATH.exists():
    print(f"  tasks model size  : {_MODEL_PATH.stat().st_size / 1024 / 1024:.1f} MB")

# ── cache check ───────────────────────────────────────────────────────────────

section("CACHE")
cache_file = _cache_path(str(VIDEO))
cache_hit  = cache_file.exists()
print(f"  cache dir  : {_CACHE_DIR}")
print(f"  cache file : {cache_file.name}")
print(f"  cache HIT  : {cache_hit}")
if cache_hit:
    print(f"  cache size : {cache_file.stat().st_size / 1024:.0f} KB")

# ── make a temp copy so the finally-unlink in the real pipeline doesn't
#    destroy the real test file ─────────────────────────────────────────────

import tempfile, os
tmp = tempfile.NamedTemporaryFile(suffix=VIDEO.suffix, delete=False)
tmp.close()
shutil.copy(VIDEO, tmp.name)
tmp_video = Path(tmp.name)

# ── Stage 1: pose extraction ──────────────────────────────────────────────────

section("STAGE 1 — POSE EXTRACTION")

extractor = PoseExtractor()

# Time the model creation separately from inference
if _TASKS_AVAILABLE and _MODEL_PATH.exists():
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision as mp_vision
    from mediapipe.tasks.python.vision import RunningMode

    t = time.perf_counter()
    base_opts = mp_tasks.BaseOptions(model_asset_path=str(_MODEL_PATH))
    opts = mp_vision.PoseLandmarkerOptions(
        base_options=base_opts,
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    lm = mp_vision.PoseLandmarker.create_from_options(opts)
    lm.close()
    t = _lap("PoseLandmarker.create_from_options (model load)", t)
elif _LEGACY_AVAILABLE:
    import mediapipe as mp
    t = time.perf_counter()
    with mp.solutions.pose.Pose(model_complexity=1, static_image_mode=False) as _:
        pass
    t = _lap("mp.solutions.pose.Pose() construction (model load)", t)

# Now run the full extract (which may hit cache or re-run inference)
t = time.perf_counter()
frames_inferred = [0]
_orig_progress = None

def _counting_progress(frac: float) -> None:
    frames_inferred[0] = int(frac * n_frames)

if cache_hit:
    print("  [cache hit — loading from .npz, skipping inference]")
    t_pose_start = time.perf_counter()
    pose_data = extractor.extract(str(tmp_video), progress_cb=_counting_progress)
    t = _lap(f"extract() [cache hit]", t_pose_start)
else:
    print(f"  [cache miss — running inference on {n_frames} frames,"
          f" every {INFERENCE_STRIDE}th = {n_frames // INFERENCE_STRIDE} inferences]")
    t_pose_start = time.perf_counter()
    pose_data = extractor.extract(str(tmp_video), progress_cb=_counting_progress)
    t = _lap(f"extract() [full inference, {n_frames} frames -> "
             f"{n_frames // INFERENCE_STRIDE} inferred]", t_pose_start)

fps          = pose_data["fps"]
image_lm_raw = pose_data["image_lm"]
world_lm_raw = pose_data["world_lm"]
timestamps_ms = pose_data["timestamps_ms"]

# ── smooth + body scale ───────────────────────────────────────────────────────

t = time.perf_counter()
image_lm   = smooth_landmarks(image_lm_raw)
world_lm   = smooth_landmarks(world_lm_raw)
body_scale = compute_body_scale(image_lm)
t = _lap(f"smooth_landmarks + compute_body_scale  (body_scale={body_scale:.4f})", t)

# ── Stage 2: move detection ───────────────────────────────────────────────────

section("STAGE 2 — MOVE DETECTION")
t = time.perf_counter()
jumps            = detect_jumps(image_lm, fps, body_scale, timestamps_ms, world_lm=world_lm)
t = _lap(f"detect_jumps            -> {len(jumps)} jumps", t)

t = time.perf_counter()
turns            = detect_turns(world_lm, fps, body_scale, image_lm, timestamps_ms)
t = _lap(f"detect_turns            -> {len(turns)} turns", t)

t = time.perf_counter()
arabesques       = detect_arabesques(image_lm, world_lm, fps, body_scale, timestamps_ms)
t = _lap(f"detect_arabesques       -> {len(arabesques)}", t)

t = time.perf_counter()
grand_battements = detect_grand_battements(image_lm, world_lm, fps, body_scale, timestamps_ms)
t = _lap(f"detect_grand_battements -> {len(grand_battements)}", t)

t = time.perf_counter()
tilts            = detect_tilts(image_lm, fps, body_scale, timestamps_ms)
t = _lap(f"detect_tilts            -> {len(tilts)}", t)

t = time.perf_counter()
compound_jumps   = detect_compound_jumps(image_lm, world_lm, fps, body_scale, timestamps_ms)
t = _lap(f"detect_compound_jumps   -> {len(compound_jumps)}", t)

# ── Stage 3: metrics + feedback ───────────────────────────────────────────────

section("STAGE 3 — METRICS + FEEDBACK")
from analysis.moves import JumpEvent, TurnEvent

all_events = (
    [("jump", i, ev) for i, ev in enumerate(jumps)]
    + [("turn", i, ev) for i, ev in enumerate(turns)]
)

move_reports = []
t = time.perf_counter()
for kind, idx, event in all_events:
    if kind == "jump":
        from analysis.metrics import compute_jump_metrics
        metrics = compute_jump_metrics(image_lm, event, fps, body_scale)
    else:
        metrics = compute_turn_metrics(image_lm, world_lm, event, fps, body_scale)
    report = build_move_feedback(metrics, event)
    move_reports.append(report)

session   = build_session_report(move_reports)
json_data = report_to_dict(session)
t = _lap(f"metrics + feedback for {len(all_events)} events", t)

# ── Stage 4: render ───────────────────────────────────────────────────────────

section("STAGE 4 — VIDEO RENDER")

import tempfile as _tf
out_mp4 = Path(_tf.mktemp(suffix=".mp4"))

t = time.perf_counter()
try:
    render_annotated_video(
        video_path=str(tmp_video),
        image_lm=image_lm,
        move_reports=move_reports,
        jumps=jumps,
        turns=turns,
        fps=fps,
        output_path=str(out_mp4),
    )
    size_mb = out_mp4.stat().st_size / 1024 / 1024 if out_mp4.exists() else 0
    t = _lap(f"render_annotated_video -> {size_mb:.1f} MB output", t)
except Exception as e:
    t = _lap(f"render FAILED: {e}", t)
    out_mp4 = None

# ── Total ─────────────────────────────────────────────────────────────────────

section("TOTALS")
total = time.perf_counter() - _t0
print(f"  wall time end-to-end: {total:.2f}s")
print(f"  (Supabase upload is stage 5 — runs in background thread after status=done)")

# ── Cleanup ───────────────────────────────────────────────────────────────────

try:
    tmp_video.unlink(missing_ok=True)
    if out_mp4 and out_mp4.exists():
        out_mp4.unlink()
except Exception:
    pass

print()
