"""Annotated video renderer.

Draws skeleton overlay, move labels, and angle callouts at key frames.
"""

from __future__ import annotations

import cv2
import numpy as np
from pathlib import Path
from typing import Callable, Optional

from analysis.moves import JumpEvent, TurnEvent
from analysis.feedback import MoveReport

# ---------------------------------------------------------------------------
# MediaPipe skeleton connections (33-point model)
# We define them here statically so the render module works regardless of
# which MediaPipe API variant is active.
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

# Try to use MediaPipe's own connection list if available
try:
    import mediapipe as mp
    _mp_connections = mp.solutions.pose.POSE_CONNECTIONS
    POSE_CONNECTIONS = list(_mp_connections)
except Exception:
    pass

# Colors (BGR)
CLR_BONE       = (143, 86, 232)    # accent pink #E8568F in BGR
CLR_JOINT      = (143, 86, 232)    # accent pink dots
CLR_OUTLINE    = (30, 30, 30)      # dark outline for contrast on light footage
CLR_HIGHLIGHT  = (0, 165, 255)     # orange for active move joints
CLR_CALLOUT    = (0, 255, 255)     # cyan angle callout text
CLR_BANNER_BG  = (30, 30, 30)      # dark banner background
CLR_BANNER_TXT = (255, 255, 255)
CLR_FREEZE_BG  = (0, 0, 0)

VIS_THRESH = 0.5


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
    """Render the annotated video.

    Returns the output_path on success.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video for rendering: {video_path}")

    total_frames_source = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    source_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    w_orig = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_orig = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Determine render dimensions (same resize logic as extractor)
    MAX_SIDE = 960
    long_side = max(w_orig, h_orig)
    if long_side > MAX_SIDE:
        scale = MAX_SIDE / long_side
        render_w = round(w_orig * scale)
        render_h = round(h_orig * scale)
    else:
        render_w, render_h = w_orig, h_orig

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    # Try codecs in order
    writer = None
    for fourcc_str in ("H264", "avc1", "mp4v"):
        fourcc = cv2.VideoWriter_fourcc(*fourcc_str)
        w = cv2.VideoWriter(output_path, fourcc, fps, (render_w, render_h))
        if w.isOpened():
            writer = w
            break
    if writer is None:
        raise RuntimeError("Could not open VideoWriter with any available codec.")

    N = len(image_lm)

    # Pre-compute per-frame sets for fast lookup
    freeze_frames: dict[int, dict] = _build_freeze_map(jumps, fps, image_lm)
    jump_frame_map: dict[int, JumpEvent] = {}
    for j in jumps:
        for f in range(j.takeoff_frame, j.landing_frame + 1):
            jump_frame_map[f] = j
    turn_frame_map: dict[int, TurnEvent] = {}
    for t in turns:
        for f in range(t.start_frame, t.end_frame + 1):
            turn_frame_map[f] = t

    # Pair moves with their reports
    jump_report_map = _pair_move_reports(jumps, move_reports)
    turn_report_map = _pair_move_reports(turns, move_reports)

    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx >= N:
            break

        # Resize to render dimensions
        if (frame.shape[1], frame.shape[0]) != (render_w, render_h):
            frame = cv2.resize(frame, (render_w, render_h), interpolation=cv2.INTER_AREA)

        lm_frame = image_lm[frame_idx]

        # Draw skeleton
        frame = _draw_skeleton(frame, lm_frame, render_w, render_h)

        # Active move banner
        active_jump = jump_frame_map.get(frame_idx)
        active_turn = turn_frame_map.get(frame_idx)

        if active_jump:
            label = _jump_banner_text(active_jump, jump_report_map.get(id(active_jump)))
            frame = _draw_banner(frame, label)

        if active_turn:
            label = f"TURN — {active_turn.rotation_count} rotations"
            frame = _draw_banner(frame, label, y_offset=60 if active_jump else 0)

        # Apex freeze-frame callouts
        if frame_idx in freeze_frames:
            frame = _draw_apex_callouts(
                frame, lm_frame, freeze_frames[frame_idx], render_w, render_h
            )

        writer.write(frame)
        frame_idx += 1

        if progress_cb and total_frames_source > 0:
            progress_cb(frame_idx / total_frames_source)

    cap.release()
    writer.release()
    return output_path


# ---------------------------------------------------------------------------
# Skeleton drawing
# ---------------------------------------------------------------------------

def _lm_px(lm: np.ndarray, jid: int, w: int, h: int) -> tuple[int, int]:
    """Convert normalized landmark to pixel coordinates."""
    return (int(lm[jid, 0] * w), int(lm[jid, 1] * h))


def _draw_skeleton(frame: np.ndarray, lm: np.ndarray, w: int, h: int) -> np.ndarray:
    # Dark outline pass first, then pink on top for contrast on light footage
    for a_idx, b_idx in POSE_CONNECTIONS:
        if lm[a_idx, 3] >= VIS_THRESH and lm[b_idx, 3] >= VIS_THRESH:
            pa = _lm_px(lm, a_idx, w, h)
            pb = _lm_px(lm, b_idx, w, h)
            cv2.line(frame, pa, pb, CLR_OUTLINE, 4, cv2.LINE_AA)
            cv2.line(frame, pa, pb, CLR_BONE, 2, cv2.LINE_AA)
    for jid in range(33):
        if lm[jid, 3] >= VIS_THRESH:
            px = _lm_px(lm, jid, w, h)
            cv2.circle(frame, px, 5, CLR_OUTLINE, -1, cv2.LINE_AA)
            cv2.circle(frame, px, 4, CLR_JOINT, -1, cv2.LINE_AA)
    return frame


# ---------------------------------------------------------------------------
# Banners
# ---------------------------------------------------------------------------

def _draw_banner(frame: np.ndarray, text: str, y_offset: int = 0) -> np.ndarray:
    """Draw a semi-transparent banner at the top of the frame."""
    h, w = frame.shape[:2]
    banner_h = 40
    y0 = y_offset
    y1 = y0 + banner_h
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, y0), (w, y1), CLR_BANNER_BG, -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    cv2.putText(frame, text, (10, y0 + 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, CLR_BANNER_TXT, 2, cv2.LINE_AA)
    return frame


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
    """Map frame numbers → callout data for freeze-frame annotation."""
    result = {}
    freeze_duration = max(1, round(fps / 2))   # 0.5 s
    N = len(image_lm)
    for jump in jumps:
        af = jump.apex_frame
        for df in range(freeze_duration):
            f = af + df
            if f < N:
                result[f] = {"jump": jump, "apex_frame": af}
    return result


def _draw_apex_callouts(
    frame: np.ndarray,
    lm: np.ndarray,
    freeze_info: dict,
    w: int,
    h: int,
) -> np.ndarray:
    """Draw angle callouts during the freeze-frame window."""
    jump: JumpEvent = freeze_info["jump"]
    af_lm = lm   # we already have the landmark at the current frame

    # Helper: draw angle label near a joint
    def callout(jid: int, text: str):
        if lm[jid, 3] < VIS_THRESH:
            return
        px = _lm_px(lm, jid, w, h)
        cv2.putText(
            frame, text, (px[0] + 8, px[1] - 8),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, CLR_CALLOUT, 1, cv2.LINE_AA,
        )
        cv2.circle(frame, px, 6, CLR_CALLOUT, 2, cv2.LINE_AA)

    # Determine front/back
    l_ankle_y = lm[27, 1]
    r_ankle_y = lm[28, 1]
    f_knee = 25 if l_ankle_y <= r_ankle_y else 26  # front knee
    b_knee = 26 if f_knee == 25 else 25

    from utils.geometry import angle_at

    def _knee_angle(knee_id: int) -> "float | None":
        hip_id   = 23 if knee_id == 25 else 24   # L_hip or R_hip
        ankle_id = 27 if knee_id == 25 else 28   # L_ankle or R_ankle
        if lm[knee_id, 3] < VIS_THRESH or lm[hip_id, 3] < VIS_THRESH or lm[ankle_id, 3] < VIS_THRESH:
            return None
        ang = angle_at(lm[knee_id, :2], lm[hip_id, :2], lm[ankle_id, :2])
        return None if np.isnan(ang) else ang

    # Front knee
    front_ang = _knee_angle(f_knee)
    if front_ang is not None:
        callout(f_knee, f"F:{front_ang:.0f}")

    # Back knee
    back_ang = _knee_angle(b_knee)
    if back_ang is not None:
        callout(b_knee, f"B:{back_ang:.0f}")

    # Split angle at hip mid
    split = jump.split_angle_deg
    if split > 0:
        hip_x = int(((lm[23, 0] + lm[24, 0]) / 2) * w)
        hip_y = int(((lm[23, 1] + lm[24, 1]) / 2) * h)
        cv2.putText(frame, f"Split:{split:.0f}", (hip_x - 40, hip_y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, CLR_CALLOUT, 1, cv2.LINE_AA)

    return frame


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pair_move_reports(moves: list, reports: list[MoveReport]) -> dict[int, MoveReport]:
    """Match moves to reports by insertion order (they are produced in parallel)."""
    result = {}
    jump_count = 0
    turn_count = 0
    jump_reports = [r for r in reports if "Turn" not in r.move_type and "turn" not in r.move_type]
    turn_reports = [r for r in reports if "Turn" in r.move_type or "turn" in r.move_type]

    for move in moves:
        if hasattr(move, "apex_frame"):   # jump
            if jump_count < len(jump_reports):
                result[id(move)] = jump_reports[jump_count]
            jump_count += 1
        else:                             # turn
            if turn_count < len(turn_reports):
                result[id(move)] = turn_reports[turn_count]
            turn_count += 1
    return result
