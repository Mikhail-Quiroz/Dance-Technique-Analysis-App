"""Video → per-frame pose landmarks with content-hash .npz cache.

Output format:
    image_lm     : np.ndarray (N, 33, 4)  normalised image coords [x, y, z, visibility]
    world_lm     : np.ndarray (N, 33, 4)  metric world coords     [x, y, z, visibility]
    timestamps_ms: np.ndarray (N,)        milliseconds from start of video
    fps          : float                  original video frame rate
    frame_size   : (width, height)        dimensions used for inference
"""

from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Frame-sampling stride
# ---------------------------------------------------------------------------
# Run MediaPipe inference on every INFERENCE_STRIDE-th frame and linearly
# interpolate the skipped frames afterward.  With VIDEO running-mode the
# tracker is fed real timestamps for the sampled frames so it still maintains
# continuity; per-frame inference time stays the same (~22 ms/frame on CPU),
# so stride-2 gives ~2× speedup with negligible accuracy loss because
# smooth_landmarks() averages over a larger window anyway.
#
# STRIDE=1 disables sampling (use if you need maximum accuracy on very fast
# moves or low frame-rate source footage).
INFERENCE_STRIDE: int = int(os.environ.get("POSE_INFERENCE_STRIDE", "2"))


# ---------------------------------------------------------------------------
# Stable pose-result cache
# ---------------------------------------------------------------------------
# Cache by content hash so that re-uploading the same video (even with a
# different filename / temp path) hits the cache instantly.
# Old extractor behaviour cached next to the source file (e.g.
# /tmp/tmpXXX.mp4.pose.npz), which never re-hit for backend temp files.
_CACHE_DIR = Path(__file__).parent.parent / "pose_cache"
_CACHE_DIR.mkdir(exist_ok=True)


def _content_hash(video_path: str) -> str:
    """Quick content fingerprint: first 8 MB + total file size."""
    h = hashlib.md5()
    with open(video_path, "rb") as f:
        h.update(f.read(8 * 1024 * 1024))
        size = f.seek(0, 2)          # seek to end → returns position = file size
    h.update(str(size).encode())
    return h.hexdigest()


def _cache_path(video_path: str) -> Path:
    return _CACHE_DIR / (_content_hash(video_path) + ".npz")


# ---------------------------------------------------------------------------
# MediaPipe strategy: Tasks API → legacy fallback
# ---------------------------------------------------------------------------

_TASKS_AVAILABLE = False
_LEGACY_AVAILABLE = False

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision as mp_vision
    from mediapipe.tasks.python.vision import RunningMode
    _TASKS_AVAILABLE = True
except Exception:
    pass

if not _TASKS_AVAILABLE:
    try:
        import mediapipe as mp
        _legacy_pose_mod = mp.solutions.pose
        _LEGACY_AVAILABLE = True
    except Exception:
        pass

if _TASKS_AVAILABLE or _LEGACY_AVAILABLE:
    try:
        import mediapipe as mp
        _LEGACY_AVAILABLE = True
    except Exception:
        pass

# Model path for Tasks API
_MODEL_DIR  = Path(__file__).parent.parent / "models"
_MODEL_PATH = _MODEL_DIR / "pose_landmarker_full.task"
_MODEL_URL  = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
)

MAX_SIDE = 960


def _resize_frame(frame: np.ndarray):
    """Resize so the longer side ≤ MAX_SIDE. Returns (resized, scale)."""
    h, w = frame.shape[:2]
    long_side = max(h, w)
    if long_side <= MAX_SIDE:
        return frame, 1.0
    scale = MAX_SIDE / long_side
    return cv2.resize(frame, (round(w * scale), round(h * scale)),
                      interpolation=cv2.INTER_AREA), scale


def _download_model() -> bool:
    """Download the Tasks API model. Returns True on success."""
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        print(f"Downloading pose model to {_MODEL_PATH} …")
        urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)
        return True
    except Exception as e:
        print(f"Model download failed: {e}")
        return False


def _lm_to_array(landmarks, n: int = 33) -> np.ndarray:
    """Convert a mediapipe landmark list to (33, 4) float32 array."""
    arr = np.zeros((n, 4), dtype=np.float32)
    if landmarks is None:
        return arr
    for i, lm in enumerate(landmarks):
        arr[i] = [lm.x, lm.y, lm.z, getattr(lm, "visibility", 1.0)]
    return arr


def _interpolate_to_full(
    sampled: list[np.ndarray],
    sampled_indices: np.ndarray,
    total_frames: int,
) -> np.ndarray:
    """Linearly interpolate sampled landmark arrays back to full frame count.

    Args:
        sampled:         list of (33, 4) arrays at the sampled frame positions.
        sampled_indices: 1-D array of the original frame indices that were processed.
        total_frames:    total number of frames in the source video.

    Returns:
        np.ndarray of shape (total_frames, 33, 4).
    """
    if len(sampled) == 0:
        return np.zeros((total_frames, 33, 4), dtype=np.float32)
    if len(sampled) == total_frames:
        return np.stack(sampled, axis=0)

    all_idx = np.arange(total_frames, dtype=np.float64)
    src     = np.stack(sampled, axis=0)                    # (K, 33, 4)
    flat    = src.reshape(len(sampled), -1)                # (K, 132)
    out     = np.empty((total_frames, flat.shape[1]), dtype=np.float32)
    for k in range(flat.shape[1]):
        out[:, k] = np.interp(all_idx, sampled_indices.astype(np.float64), flat[:, k])
    return out.reshape(total_frames, 33, 4)


# ---------------------------------------------------------------------------
# Main extractor class
# ---------------------------------------------------------------------------

class PoseExtractor:
    """Extract pose landmarks from a video file with content-hash .npz caching."""

    def extract(
        self,
        video_path: str,
        progress_cb: Optional[Callable[[float], None]] = None,
        cache_key: Optional[str] = None,
    ) -> dict:
        """Run pose inference or load from cache.

        cache_key overrides the default content-hash cache name — used when
        video_path is a transcoded working copy but the cache should be keyed
        by the original upload (so re-uploads hit without re-transcoding).

        Returns dict with keys: image_lm, world_lm, timestamps_ms, fps, frame_size.
        """
        cp = (_CACHE_DIR / f"{cache_key}.npz") if cache_key else _cache_path(video_path)
        if cp.exists():
            return self._load_cache(str(cp))

        result = self._run_inference(video_path, progress_cb)
        self._save_cache(str(cp), result)
        return result

    # ------------------------------------------------------------------
    def _run_inference(self, video_path: str, progress_cb) -> dict:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # Read first frame to determine resize dimensions
        ok, first = cap.read()
        if not ok:
            raise RuntimeError("Video has no readable frames.")
        first_resized, _ = _resize_frame(first)
        frame_h, frame_w = first_resized.shape[:2]
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

        use_tasks = _TASKS_AVAILABLE and self._ensure_model()
        if use_tasks:
            return self._run_tasks_api(cap, fps, total_frames, frame_w, frame_h, progress_cb)
        else:
            return self._run_legacy(cap, fps, total_frames, frame_w, frame_h, progress_cb)

    # ------------------------------------------------------------------
    # Tasks API path
    # ------------------------------------------------------------------

    def _ensure_model(self) -> bool:
        if _MODEL_PATH.exists():
            return True
        return _download_model()

    def _run_tasks_api(self, cap, fps, total_frames, fw, fh, progress_cb) -> dict:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision as mp_vision
        from mediapipe.tasks.python.vision import RunningMode

        base_opts = mp_tasks.BaseOptions(model_asset_path=str(_MODEL_PATH))
        opts = mp_vision.PoseLandmarkerOptions(
            base_options=base_opts,
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        image_lm_sampled: list[np.ndarray] = []
        world_lm_sampled: list[np.ndarray] = []
        sampled_indices:  list[int]        = []

        with mp_vision.PoseLandmarker.create_from_options(opts) as landmarker:
            frame_idx = 0
            while True:
                if frame_idx % INFERENCE_STRIDE == 0:
                    ok, frame = cap.read()
                    if not ok:
                        break
                    resized, _ = _resize_frame(frame)
                    ts_ms = int(frame_idx * 1000 / fps)

                    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    result   = landmarker.detect_for_video(mp_image, ts_ms)

                    if result.pose_landmarks:
                        img_arr   = _lm_to_array(result.pose_landmarks[0])
                        world_arr = _lm_to_array(result.pose_world_landmarks[0])
                    else:
                        img_arr   = np.zeros((33, 4), dtype=np.float32)
                        world_arr = np.zeros((33, 4), dtype=np.float32)

                    image_lm_sampled.append(img_arr)
                    world_lm_sampled.append(world_arr)
                    sampled_indices.append(frame_idx)
                else:
                    # Advance video without decoding; skipped frames are
                    # filled by linear interpolation after inference.
                    if not cap.grab():
                        break

                frame_idx += 1

                if progress_cb and total_frames > 0:
                    progress_cb(frame_idx / total_frames)

        cap.release()

        # Reconstruct full-frame arrays so downstream code (detection + renderer)
        # sees one entry per original video frame, as it always has.
        si = np.array(sampled_indices, dtype=np.int64)
        image_lm = _interpolate_to_full(image_lm_sampled, si, total_frames)
        world_lm = _interpolate_to_full(world_lm_sampled, si, total_frames)
        ts_full  = (np.arange(total_frames, dtype=np.float64) * 1000.0 / fps).astype(np.int64)

        return self._pack(image_lm, world_lm, ts_full, fps, (fw, fh))

    # ------------------------------------------------------------------
    # Legacy mp.solutions.pose path
    # ------------------------------------------------------------------

    def _run_legacy(self, cap, fps, total_frames, fw, fh, progress_cb) -> dict:
        import mediapipe as mp
        pose_solution = mp.solutions.pose

        image_lm_sampled: list[np.ndarray] = []
        world_lm_sampled: list[np.ndarray] = []
        sampled_indices:  list[int]        = []

        with pose_solution.Pose(
            model_complexity=1,
            static_image_mode=False,
            smooth_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        ) as pose:
            frame_idx = 0
            while True:
                if frame_idx % INFERENCE_STRIDE == 0:
                    ok, frame = cap.read()
                    if not ok:
                        break
                    resized, _ = _resize_frame(frame)

                    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                    rgb.flags.writeable = False
                    result = pose.process(rgb)
                    rgb.flags.writeable = True

                    if result.pose_landmarks:
                        img_arr   = _lm_to_array(result.pose_landmarks.landmark)
                        world_arr = _lm_to_array(result.pose_world_landmarks.landmark)
                    else:
                        img_arr   = np.zeros((33, 4), dtype=np.float32)
                        world_arr = np.zeros((33, 4), dtype=np.float32)

                    image_lm_sampled.append(img_arr)
                    world_lm_sampled.append(world_arr)
                    sampled_indices.append(frame_idx)
                else:
                    if not cap.grab():
                        break

                frame_idx += 1

                if progress_cb and total_frames > 0:
                    progress_cb(frame_idx / total_frames)

        cap.release()

        si = np.array(sampled_indices, dtype=np.int64)
        image_lm = _interpolate_to_full(image_lm_sampled, si, total_frames)
        world_lm = _interpolate_to_full(world_lm_sampled, si, total_frames)
        ts_full  = (np.arange(total_frames, dtype=np.float64) * 1000.0 / fps).astype(np.int64)

        return self._pack(image_lm, world_lm, ts_full, fps, (fw, fh))

    # ------------------------------------------------------------------

    @staticmethod
    def _pack(image_lm, world_lm, timestamps_ms, fps, frame_size) -> dict:
        return {
            "image_lm":      image_lm,
            "world_lm":      world_lm,
            "timestamps_ms": timestamps_ms,
            "fps":           fps,
            "frame_size":    frame_size,
        }

    @staticmethod
    def _save_cache(path: str, data: dict) -> None:
        np.savez_compressed(
            path,
            image_lm=data["image_lm"],
            world_lm=data["world_lm"],
            timestamps_ms=data["timestamps_ms"],
            fps=np.array([data["fps"]]),
            frame_size=np.array(list(data["frame_size"])),
        )

    @staticmethod
    def _load_cache(path: str) -> dict:
        d = np.load(path)
        return {
            "image_lm":      d["image_lm"],
            "world_lm":      d["world_lm"],
            "timestamps_ms": d["timestamps_ms"],
            "fps":           float(d["fps"][0]),
            "frame_size":    tuple(d["frame_size"].tolist()),
        }
