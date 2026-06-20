"""Annotated video renderer.

Draws skeleton overlay, move labels, and angle callouts at key frames.

Encoding strategy (in priority order):
  1. ffmpeg subprocess (libx264, -preset veryfast, -crf 23) when ffmpeg is
     installed and on PATH — fast, portable H.264 with predictable behaviour.
  2. OpenCV VideoWriter (H264 → avc1 → mp4v fallback chain) when ffmpeg is
     not available.

Install ffmpeg to use path 1:
  macOS:   brew install ffmpeg
  Ubuntu:  sudo apt install ffmpeg
  Windows: https://ffmpeg.org/download.html  (add bin/ folder to PATH)
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

from analysis.moves import JumpEvent, TurnEvent
from analysis.feedback import MoveReport
from utils.geometry import angle_at

# ---------------------------------------------------------------------------
# MediaPipe skeleton connections (33-point model)
# ---------------------------------------------------------------------------

POSE_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (27, 31), (29, 31),
    (24, 26), (26, 28), (28, 30), (28, 32), (30, 32),
]

try:
    import mediapipe as mp
    POSE_CONNECTIONS = list(mp.solutions.pose.POSE_CONNECTIONS)
except Exception:
    pass

# Colors (BGR)
CLR_BONE       = (143, 86, 232)
CLR_JOINT      = (143, 86, 232)
CLR_OUTLINE    = (30, 30, 30)
CLR_HIGHLIGHT  = (0, 165, 255)
CLR_CALLOUT    = (0, 255, 255)
CLR_BANNER_BG  = (30, 30, 30)
CLR_BANNER_TXT = (255, 255, 255)
CLR_FREEZE_BG  = (0, 0, 0)

VIS_THRESH = 0.5

# Output resolution cap. Landmarks are normalised [0-1] so this is
# independent of the extractor's resolution.
RENDER_MAX_SIDE: int = 720


# ---------------------------------------------------------------------------
# ffmpeg detection (checked once, result cached at module level)
# ---------------------------------------------------------------------------

def _find_ffmpeg() -> Optional[str]:
    """Return the path to ffmpeg, or None if not found."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    # Common Windows locations when ffmpeg is installed but not on PATH
    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    # winget install (Gyan.FFmpeg) puts ffmpeg under %LOCALAPPDATA%\Microsoft\WinGet\Packages
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_root = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
        matches = sorted(winget_root.glob("Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe"))
        if matches:
            return str(matches[-1])  # newest version last alphabetically
    return None


_FFMPEG_PATH: Optional[str] = _find_ffmpeg()

if _FFMPEG_PATH is None:
    print(
        "[render] ffmpeg not found — falling back to OpenCV VideoWriter.\n"
        "         Install ffmpeg for faster, more reliable H.264 encoding:\n"
        "           macOS:   brew install ffmpeg\n"
        "           Ubuntu:  sudo apt install ffmpeg\n"
        "           Windows: https://ffmpeg.org/download.html  (add bin/ to PATH)"
    )


# ---------------------------------------------------------------------------
# Writer abstractions
# ---------------------------------------------------------------------------

class _FfmpegWriter:
    """Write BGR frames to an H.264 mp4 via ffmpeg stdin pipe.

    Faster than OpenCV VideoWriter on most systems, and avoids the openh264
    DLL fallback chain on Windows.
    """

    def __init__(self, output_path: str, fps: float, width: int, height: int) -> None:
        cmd = [
            _FFMPEG_PATH, "-y",
            "-f",       "rawvideo",
            "-vcodec",  "rawvideo",
            "-s",       f"{width}x{height}",
            "-pix_fmt", "bgr24",
            "-r",       f"{fps:.3f}",
            "-i",       "pipe:0",
            "-c:v",     "libx264",
            "-preset",  "veryfast",
            "-crf",     "23",
            "-pix_fmt", "yuv420p",
            output_path,
        ]
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        # Drain stderr in a background thread to prevent OS pipe-buffer deadlock
        # when writing large amounts of raw-video data to stdin concurrently.
        self._stderr_buf = io.BytesIO()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        for chunk in iter(lambda: self._proc.stderr.read(4096), b""):
            self._stderr_buf.write(chunk)

    def write(self, frame: np.ndarray) -> None:
        try:
            self._proc.stdin.write(frame.tobytes())
        except (BrokenPipeError, OSError):
            self._stderr_thread.join(timeout=2)
            stderr = self._stderr_buf.getvalue().decode("utf-8", errors="replace")
            raise RuntimeError(f"ffmpeg pipe closed unexpectedly: {stderr[-400:]}")

    def release(self) -> None:
        self._proc.stdin.close()
        self._proc.wait()
        self._stderr_thread.join(timeout=5)
        if self._proc.returncode != 0:
            stderr = self._stderr_buf.getvalue().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"ffmpeg exited with code {self._proc.returncode}: {stderr[-400:]}"
            )


def _open_cv_writer_quiet(
    path: str, fourcc: int, fps: float, size: tuple[int, int]
) -> cv2.VideoWriter:
    """Open a VideoWriter while suppressing C-level stderr noise.

    OpenCV's FFMPEG binding prints DLL-load warnings directly to the OS file
    descriptor for stderr (fd 2), bypassing Python's sys.stderr.  We
    temporarily redirect fd 2 to /dev/null so those messages don't pollute
    the server log.
    """
    import io
    null_fd = os.open(os.devnull, os.O_WRONLY)
    saved_fd = os.dup(2)
    try:
        os.dup2(null_fd, 2)
        return cv2.VideoWriter(path, fourcc, fps, size)
    finally:
        os.dup2(saved_fd, 2)
        os.close(saved_fd)
        os.close(null_fd)


class _OpenCVWriter:
    """Write BGR frames via OpenCV VideoWriter.

    H264 is tried first because it uses async buffered encoding (write()
    returns immediately; flush happens at release()), which pipelines better
    with the draw loop and reduces total render time by ~0.3s on real video
    compared to mp4v's synchronous per-frame encode.

    The openh264 DLL errors on Windows are cosmetic — the codec falls back
    to an alternative H264 path and still produces valid output.  They are
    suppressed by temporarily redirecting the C-level file descriptor 2.
    """

    def __init__(self, output_path: str, fps: float, width: int, height: int) -> None:
        self._writer: Optional[cv2.VideoWriter] = None
        for fourcc_str in ("H264", "avc1", "mp4v"):
            fourcc = cv2.VideoWriter_fourcc(*fourcc_str)
            w = _open_cv_writer_quiet(output_path, fourcc, fps, (width, height))
            if w.isOpened():
                self._writer = w
                return
        raise RuntimeError("Could not open VideoWriter with any available codec.")

    def write(self, frame: np.ndarray) -> None:
        self._writer.write(frame)

    def release(self) -> None:
        self._writer.release()


def _open_writer(output_path: str, fps: float, width: int, height: int):
    """Return the best available writer for the given output path."""
    if _FFMPEG_PATH is not None:
        return _FfmpegWriter(output_path, fps, width, height)
    return _OpenCVWriter(output_path, fps, width, height)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def render_annotated_video(
    video_path: str,
    image_lm: np.ndarray,
    move_reports: list[MoveReport],
    jumps: list[JumpEvent],
    turns: list[TurnEvent],
    fps: float,
    output_path: str,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> str:
    """Render the annotated video. Returns output_path on success."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video for rendering: {video_path}")

    total_frames_source = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w_orig = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_orig = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    long_side = max(w_orig, h_orig)
    if long_side > RENDER_MAX_SIDE:
        scale = RENDER_MAX_SIDE / long_side
        # yuv420p (used by ffmpeg) requires even dimensions; floor to nearest 2.
        render_w = (round(w_orig * scale) // 2) * 2
        render_h = (round(h_orig * scale) // 2) * 2
    else:
        render_w, render_h = w_orig, h_orig

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    N = len(image_lm)

    freeze_frames   = _build_freeze_map(jumps, fps, image_lm)
    jump_frame_map  = {f: j for j in jumps  for f in range(j.takeoff_frame, j.landing_frame + 1)}
    turn_frame_map  = {f: t for t in turns  for f in range(t.start_frame,   t.end_frame + 1)}
    jump_report_map = _pair_move_reports(jumps,  move_reports)
    turn_report_map = _pair_move_reports(turns,  move_reports)

    writer = _open_writer(output_path, fps, render_w, render_h)
    try:
        frame_idx = 0
        while True:
            ok, frame = cap.read()
            if not ok or frame_idx >= N:
                break

            if (frame.shape[1], frame.shape[0]) != (render_w, render_h):
                frame = cv2.resize(frame, (render_w, render_h), interpolation=cv2.INTER_AREA)

            lm_frame    = image_lm[frame_idx]
            active_jump = jump_frame_map.get(frame_idx)
            active_turn = turn_frame_map.get(frame_idx)

            _draw_skeleton(frame, lm_frame, render_w, render_h)

            if active_jump:
                _draw_banner(frame, _jump_banner_text(active_jump, jump_report_map.get(id(active_jump))))
            if active_turn:
                _draw_banner(frame, f"TURN — {active_turn.rotation_count} rotations",
                             y_offset=60 if active_jump else 0)
            if frame_idx in freeze_frames:
                _draw_apex_callouts(frame, lm_frame, freeze_frames[frame_idx], render_w, render_h)

            writer.write(frame)
            frame_idx += 1

            if progress_cb and total_frames_source > 0:
                progress_cb(frame_idx / total_frames_source)
    finally:
        cap.release()
        writer.release()

    return output_path


# ---------------------------------------------------------------------------
# Skeleton drawing
# ---------------------------------------------------------------------------

def _lm_px(lm: np.ndarray, jid: int, w: int, h: int) -> tuple[int, int]:
    return (int(lm[jid, 0] * w), int(lm[jid, 1] * h))


def _draw_skeleton(frame: np.ndarray, lm: np.ndarray, w: int, h: int) -> None:
    """Draw pose skeleton onto frame in-place."""
    xy  = (lm[:, :2] * (w, h)).astype(np.int32)  # (33, 2) — one vectorised op
    vis = lm[:, 3] >= VIS_THRESH                   # (33,) bool mask

    for a_idx, b_idx in POSE_CONNECTIONS:
        if vis[a_idx] and vis[b_idx]:
            pa = (xy[a_idx, 0].item(), xy[a_idx, 1].item())
            pb = (xy[b_idx, 0].item(), xy[b_idx, 1].item())
            # Outline pass uses LINE_8 — covered by the colored bone on top
            cv2.line(frame, pa, pb, CLR_OUTLINE, 4, cv2.LINE_8)
            cv2.line(frame, pa, pb, CLR_BONE,    2, cv2.LINE_AA)

    for jid in range(33):
        if vis[jid]:
            p = (xy[jid, 0].item(), xy[jid, 1].item())
            cv2.circle(frame, p, 5, CLR_OUTLINE, -1, cv2.LINE_8)
            cv2.circle(frame, p, 4, CLR_JOINT,   -1, cv2.LINE_AA)


# ---------------------------------------------------------------------------
# Banners
# ---------------------------------------------------------------------------

def _draw_banner(frame: np.ndarray, text: str, y_offset: int = 0) -> None:
    """Draw a semi-transparent banner in-place.

    Operates only on the 40-row banner ROI instead of the whole frame so
    addWeighted processes ~21x fewer pixels than the old frame.copy() path.
    """
    h, w = frame.shape[:2]
    y0, y1 = y_offset, min(y_offset + 40, h)
    roi  = frame[y0:y1, :]
    dark = np.full_like(roi, CLR_BANNER_BG[0])  # (30, 30, 30) — all channels equal
    cv2.addWeighted(dark, 0.6, roi, 0.4, 0, roi)
    cv2.putText(frame, text, (10, y0 + 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, CLR_BANNER_TXT, 2, cv2.LINE_AA)


def _jump_banner_text(jump: JumpEvent, report: Optional[MoveReport]) -> str:
    label = "LEAP" if "jeté" in jump.type else "JUMP"
    parts = [f"{label} — split {jump.split_angle_deg:.0f}°"]
    if report and report.top_cues:
        parts.append(report.top_cues[0].cue.split(".")[0])
    return " | ".join(parts)


# ---------------------------------------------------------------------------
# Apex freeze-frame callouts
# ---------------------------------------------------------------------------

def _build_freeze_map(
    jumps: list[JumpEvent], fps: float, image_lm: np.ndarray
) -> dict[int, dict]:
    result = {}
    freeze_duration = max(1, round(fps / 2))
    N = len(image_lm)
    for jump in jumps:
        af = jump.apex_frame
        for df in range(freeze_duration):
            f = af + df
            if f < N:
                result[f] = {"jump": jump, "apex_frame": af}
    return result


def _draw_apex_callouts(
    frame: np.ndarray, lm: np.ndarray, freeze_info: dict, w: int, h: int,
) -> None:
    """Draw angle callouts during the freeze-frame window (in-place)."""
    jump: JumpEvent = freeze_info["jump"]

    def callout(jid: int, text: str) -> None:
        if lm[jid, 3] < VIS_THRESH:
            return
        px = _lm_px(lm, jid, w, h)
        cv2.putText(frame, text, (px[0] + 8, px[1] - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, CLR_CALLOUT, 1, cv2.LINE_AA)
        cv2.circle(frame, px, 6, CLR_CALLOUT, 2, cv2.LINE_AA)

    f_knee = 25 if lm[27, 1] <= lm[28, 1] else 26
    b_knee = 26 if f_knee == 25 else 25

    def _knee_angle(knee_id: int) -> "float | None":
        hip_id   = 23 if knee_id == 25 else 24
        ankle_id = 27 if knee_id == 25 else 28
        if any(lm[j, 3] < VIS_THRESH for j in (knee_id, hip_id, ankle_id)):
            return None
        ang = angle_at(lm[knee_id, :2], lm[hip_id, :2], lm[ankle_id, :2])
        return None if np.isnan(ang) else ang

    front_ang = _knee_angle(f_knee)
    if front_ang is not None:
        callout(f_knee, f"F:{front_ang:.0f}")
    back_ang = _knee_angle(b_knee)
    if back_ang is not None:
        callout(b_knee, f"B:{back_ang:.0f}")

    split = jump.split_angle_deg
    if split > 0:
        hip_x = int(((lm[23, 0] + lm[24, 0]) / 2) * w)
        hip_y = int(((lm[23, 1] + lm[24, 1]) / 2) * h)
        cv2.putText(frame, f"Split:{split:.0f}", (hip_x - 40, hip_y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, CLR_CALLOUT, 1, cv2.LINE_AA)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pair_move_reports(moves: list, reports: list[MoveReport]) -> dict[int, MoveReport]:
    """Match moves to reports by insertion order."""
    result = {}
    jump_reports = [r for r in reports if "Turn" not in r.move_type and "turn" not in r.move_type]
    turn_reports = [r for r in reports if "Turn" in r.move_type or "turn" in r.move_type]
    j_idx = t_idx = 0
    for move in moves:
        if hasattr(move, "apex_frame"):
            if j_idx < len(jump_reports):
                result[id(move)] = jump_reports[j_idx]
            j_idx += 1
        else:
            if t_idx < len(turn_reports):
                result[id(move)] = turn_reports[t_idx]
            t_idx += 1
    return result
