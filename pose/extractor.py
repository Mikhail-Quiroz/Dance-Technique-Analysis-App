"""Video → per-frame pose landmarks with .npz cache.

Output format:
    image_lm  : np.ndarray (N, 33, 4)  normalized image coords [x, y, z, visibility]
    world_lm  : np.ndarray (N, 33, 4)  metric world coords    [x, y, z, visibility]
    timestamps_ms : np.ndarray (N,)
    fps        : float
    frame_size : (width, height) of the RESIZED frames used for inference
"""

import os
import urllib.request
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

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
_MODEL_DIR = Path(__file__).parent.parent / "models"
_MODEL_PATH = _MODEL_DIR / "pose_landmarker_full.task"
_MODEL_URL = (
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
    new_w = round(w * scale)
    new_h = round(h * scale)
    return cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA), scale


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


def _lm_to_array(landmarks, n=33) -> np.ndarray:
    """Convert a mediapipe landmark list to (33, 4) float32 array."""
    arr = np.zeros((n, 4), dtype=np.float32)
    if landmarks is None:
        return arr
    for i, lm in enumerate(landmarks):
        arr[i] = [lm.x, lm.y, lm.z, getattr(lm, "visibility", 1.0)]
    return arr


# ---------------------------------------------------------------------------
# Main extractor class
# ---------------------------------------------------------------------------

class PoseExtractor:
    """Extract pose landmarks from a video file with .npz caching."""

    def extract(
        self,
        video_path: str,
        progress_cb: Optional[Callable[[float], None]] = None,
    ) -> dict:
        """Run pose inference or load from cache.

        Returns dict with keys: image_lm, world_lm, timestamps_ms, fps, frame_size.
        """
        cache_path = str(video_path) + ".pose.npz"
        if os.path.exists(cache_path):
            return self._load_cache(cache_path)

        result = self._run_inference(video_path, progress_cb)
        self._save_cache(cache_path, result)
        return result

    # ------------------------------------------------------------------
    def _run_inference(self, video_path: str, progress_cb) -> dict:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # Read first frame to determine resize dimensions
        ok, first = cap.read()
        if not ok:
            raise RuntimeError("Video has no readable frames.")
        first_resized, _ = _resize_frame(first)
        frame_h, frame_w = first_resized.shape[:2]
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)   # rewind

        # Choose inference backend
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

        image_lm_list = []
        world_lm_list = []
        ts_list = []

        with mp_vision.PoseLandmarker.create_from_options(opts) as landmarker:
            frame_idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                resized, _ = _resize_frame(frame)
                ts_ms = int(frame_idx * 1000 / fps)

                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = landmarker.detect_for_video(mp_image, ts_ms)

                if result.pose_landmarks:
                    img_arr = _lm_to_array(result.pose_landmarks[0])
                    world_arr = _lm_to_array(result.pose_world_landmarks[0])
                else:
                    img_arr = np.zeros((33, 4), dtype=np.float32)
                    world_arr = np.zeros((33, 4), dtype=np.float32)

                image_lm_list.append(img_arr)
                world_lm_list.append(world_arr)
                ts_list.append(ts_ms)
                frame_idx += 1

                if progress_cb and total_frames > 0:
                    progress_cb(frame_idx / total_frames)

        cap.release()
        return self._pack(image_lm_list, world_lm_list, ts_list, fps, (fw, fh))

    # ------------------------------------------------------------------
    # Legacy mp.solutions.pose path
    # ------------------------------------------------------------------

    def _run_legacy(self, cap, fps, total_frames, fw, fh, progress_cb) -> dict:
        import mediapipe as mp
        pose_solution = mp.solutions.pose

        image_lm_list = []
        world_lm_list = []
        ts_list = []

        with pose_solution.Pose(
            model_complexity=1,
            static_image_mode=False,
            smooth_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        ) as pose:
            frame_idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                resized, _ = _resize_frame(frame)
                ts_ms = int(frame_idx * 1000 / fps)

                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                result = pose.process(rgb)
                rgb.flags.writeable = True

                if result.pose_landmarks:
                    img_arr = _lm_to_array(result.pose_landmarks.landmark)
                    world_arr = _lm_to_array(result.pose_world_landmarks.landmark)
                else:
                    img_arr = np.zeros((33, 4), dtype=np.float32)
                    world_arr = np.zeros((33, 4), dtype=np.float32)

                image_lm_list.append(img_arr)
                world_lm_list.append(world_arr)
                ts_list.append(ts_ms)
                frame_idx += 1

                if progress_cb and total_frames > 0:
                    progress_cb(frame_idx / total_frames)

        cap.release()
        return self._pack(image_lm_list, world_lm_list, ts_list, fps, (fw, fh))

    # ------------------------------------------------------------------

    @staticmethod
    def _pack(img_list, world_list, ts_list, fps, frame_size) -> dict:
        return {
            "image_lm": np.stack(img_list, axis=0),       # (N, 33, 4)
            "world_lm": np.stack(world_list, axis=0),
            "timestamps_ms": np.array(ts_list, dtype=np.int64),
            "fps": fps,
            "frame_size": frame_size,
        }

    @staticmethod
    def _save_cache(path: str, data: dict):
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
            "image_lm": d["image_lm"],
            "world_lm": d["world_lm"],
            "timestamps_ms": d["timestamps_ms"],
            "fps": float(d["fps"][0]),
            "frame_size": tuple(d["frame_size"].tolist()),
        }
