"""Tests for jump detection using synthetic landmark sequences."""

import sys
import os
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis.moves import detect_jumps, JumpEvent
from utils.geometry import smooth_landmarks


FPS = 30.0
N_FRAMES = int(FPS * 5)   # 5-second clip


def _make_jump_landmarks(
    jump_start_frame: int = 60,
    jump_duration: int = 30,
    apex_offset: int = 15,
    jump_height: float = 0.12,  # in normalized units
    body_scale: float = 0.75,
    split_angle_deg: float = 120.0,  # > 100 → leap
) -> tuple[np.ndarray, float]:
    """Build synthetic (N, 33, 4) landmarks with one jump."""
    lm = np.zeros((N_FRAMES, 33, 4), dtype=np.float32)
    lm[:, :, 3] = 0.9   # all visible

    # Standing hip position (y in image coords — larger y = lower on screen)
    hip_y_base = 0.5

    hip_y = np.full(N_FRAMES, hip_y_base)

    # Add a smooth arch in the jump segment using a sine curve
    for t in range(jump_duration):
        frac = t / jump_duration
        rise = jump_height * np.sin(np.pi * frac)
        hip_y[jump_start_frame + t] = hip_y_base - rise   # y decreases as dancer rises

    # Place L_hip (23) and R_hip (24)
    lm[:, 23, 1] = hip_y
    lm[:, 24, 1] = hip_y
    lm[:, 23, 0] = 0.45
    lm[:, 24, 0] = 0.55

    # Shoulders above hips (body_scale distance)
    lm[:, 11, 1] = hip_y - body_scale * 0.5   # L_shoulder
    lm[:, 12, 1] = hip_y - body_scale * 0.5   # R_shoulder

    # Ankles below hips
    lm[:, 27, 1] = hip_y + body_scale * 0.5   # L_ankle
    lm[:, 28, 1] = hip_y + body_scale * 0.5   # R_ankle

    # Position ankles to produce the desired split angle at apex
    apex = jump_start_frame + apex_offset
    half_angle = np.radians(split_angle_deg / 2.0)
    hip_mid_apex = np.array([0.5, hip_y[apex]])
    dist = 0.2  # arbitrary reach
    lm[apex, 27, 0] = hip_mid_apex[0] - dist * np.sin(half_angle)   # L_ankle x
    lm[apex, 27, 1] = hip_mid_apex[1] + dist * np.cos(half_angle)
    lm[apex, 28, 0] = hip_mid_apex[0] + dist * np.sin(half_angle)   # R_ankle x
    lm[apex, 28, 1] = hip_mid_apex[1] + dist * np.cos(half_angle)

    return lm, body_scale


# ---------------------------------------------------------------------------

def test_one_jump_detected():
    lm, bs = _make_jump_landmarks()
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1, f"Expected 1 event, got {len(events)}"


def test_jump_type_leap():
    """Split angle > 100° → leap."""
    lm, bs = _make_jump_landmarks(split_angle_deg=130.0)
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1
    assert events[0].type == "leap (jeté-type)"


def test_jump_type_saut():
    """Split angle ≤ 100° → sauté-type jump."""
    lm, bs = _make_jump_landmarks(split_angle_deg=60.0)
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1
    assert events[0].type == "jump (sauté-type)"


def test_apex_frame_near_midpoint():
    jump_start = 60
    jump_duration = 30
    apex_expected = jump_start + 15  # sine peak at midpoint
    lm, bs = _make_jump_landmarks(
        jump_start_frame=jump_start,
        jump_duration=jump_duration,
        apex_offset=15,
    )
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1
    assert abs(events[0].apex_frame - apex_expected) <= 3, (
        f"Apex at {events[0].apex_frame}, expected ~{apex_expected}"
    )


def test_short_jump_discarded():
    """Airborne segments < 4 frames should be discarded."""
    lm, bs = _make_jump_landmarks(jump_duration=2, jump_height=0.20)
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 0


def test_no_jump_in_flat_signal():
    lm = np.zeros((N_FRAMES, 33, 4), dtype=np.float32)
    lm[:, :, 3] = 0.9
    lm[:, 23, 1] = 0.5
    lm[:, 24, 1] = 0.5
    lm[:, 11, 1] = 0.1
    lm[:, 12, 1] = 0.1
    lm[:, 27, 1] = 0.9
    lm[:, 28, 1] = 0.9
    bs = 0.75
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 0
