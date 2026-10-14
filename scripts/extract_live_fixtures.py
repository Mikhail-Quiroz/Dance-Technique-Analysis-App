"""Turn labeled practice videos into replayable /live test fixtures.

    python scripts/extract_live_fixtures.py            # every video under videos/
    python scripts/extract_live_fixtures.py --force    # re-extract even if a fixture exists

Runs the SAME model /live uses (pose_landmarker_lite, VIDEO mode, every frame, no
interpolation) over each clip and writes, per video, a gzipped JSON fixture (format 2):

    frontend/lib/live/fixtures/real/<folder>/<video name>.json.gz
    { "version": 2, "label": "<folder>", "fps": 29.9, "size": [1280, 720],
      "scale": {"lm": 1000, "world": 1000, "vis": 100},
      "t":   [ms deltas between frames],
      "has": [1 if the frame has a pose, else 0],
      "lm":  [per posed frame, 33 x (x, y, visibility) as integer deltas from the previous posed frame],
      "w":   [per posed frame, 33 x (x, y, z, visibility) world, the same way] }

Integers at 1/1000 (about a pixel on screen, a millimetre in world space - under the tracker's
own noise) and frame-to-frame deltas, which gzip packs about four times tighter than decimals.
lib/live/replay.ts decodes it. "size" (frame width, height) lets the replay measure critique angles in
true proportions - landmarks are normalised separately in x and y. Fixtures written before it was
recorded are all 1280x720, which is what the replay assumes without it.

The fixtures are small enough to commit, so the real-footage tests keep running after the
videos themselves are deleted. The videos stay git-ignored.

Deliberately NOT pose/extractor.py: that uses the full model with stride-2 sampling and
linear interpolation, which is right for the upload pipeline but is not what /live sees.
Interpolated frames would smooth exactly the fast leg motion the live detectors gate on.
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision
from mediapipe.tasks.python.vision import RunningMode

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "videos"
OUT = ROOT / "frontend" / "lib" / "live" / "fixtures" / "real"
MODEL = ROOT / "frontend" / "public" / "models" / "pose_landmarker_lite.task"
EXTS = {".mp4", ".mov"}


SCALE = {"lm": 1000, "world": 1000, "vis": 100}


def _ints(landmarks, world: bool) -> list[int]:
    # The image z (MediaPipe's relative depth) is read by nothing on /live, so it is not stored.
    q = SCALE["world"] if world else SCALE["lm"]
    out: list[int] = []
    for p in landmarks:
        vis = round((getattr(p, "visibility", 0.0) or 0.0) * SCALE["vis"])
        out += [round(p.x * q), round(p.y * q)] + ([round(p.z * q)] if world else []) + [vis]
    return out


def extract(video: Path) -> dict:
    # Same thresholds as createPoseLandmarker in frontend/lib/live/pose.ts.
    opts = mp_vision.PoseLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    size = [int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))]
    t_deltas: list[int] = []
    has: list[int] = []
    lm_out: list[int] = []
    w_out: list[int] = []
    prev_lm = [0] * (33 * 3)
    prev_w = [0] * (33 * 4)
    prev_t = 0
    last_ts = -1
    with mp_vision.PoseLandmarker.create_from_options(opts) as landmarker:
        i = 0
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            pos = cap.get(cv2.CAP_PROP_POS_MSEC)
            ts = int(round(pos)) if pos > 0 else int(round(i * 1000.0 / fps))
            ts = max(ts, last_ts + 1)           # VIDEO mode needs strictly increasing stamps
            last_ts = ts
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)
            t_deltas.append(ts - prev_t)
            prev_t = ts
            if res.pose_landmarks and res.pose_world_landmarks:
                has.append(1)
                cur = _ints(res.pose_landmarks[0], world=False)
                lm_out += [c - p for c, p in zip(cur, prev_lm)]
                prev_lm = cur
                cur = _ints(res.pose_world_landmarks[0], world=True)
                w_out += [c - p for c, p in zip(cur, prev_w)]
                prev_w = cur
            else:
                has.append(0)
            i += 1
    cap.release()
    return {"version": 2, "label": video.parent.name, "fps": round(fps, 2), "size": size, "scale": SCALE,
            "t": t_deltas, "has": has, "lm": lm_out, "w": w_out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    if not MODEL.exists():
        raise SystemExit(f"model not found: {MODEL} (run npm run dev once to fetch it)")

    # A long recording that was cut into numbered clips is kept beside them in "full recording/":
    # only the clips are fixtures.
    videos = sorted(p for p in VIDEOS.rglob("*") if p.suffix.lower() in EXTS and "full recording" not in p.parts)
    for v in videos:
        rel = v.parent.relative_to(VIDEOS)
        # reference/<move>/x.mp4 -> real/<move>/x ; blind/x.mp4 -> real/blind/x
        sub = rel.parts[-1] if rel.parts[0] == "reference" else "/".join(rel.parts)
        dst = OUT / sub / (v.stem + ".json.gz")
        if dst.exists() and not args.force:
            print(f"skip  {dst.relative_to(ROOT)}")
            continue
        data = extract(v)
        dst.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(dst, "wt", encoding="utf-8", compresslevel=9) as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"wrote {dst.relative_to(ROOT)}  {len(data['has'])} frames, {sum(data['has'])} with a pose")


if __name__ == "__main__":
    main()
