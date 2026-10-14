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
    split_angle_deg: float = 120.0,  # opening between the legs at the widest point
) -> tuple[np.ndarray, float]:
    """Build synthetic (N, 33, 4) landmarks with one jump.

    The whole body -- feet included -- rises during the jump, and the legs open and close
    with the flight (widest at the apex), as a real leap does.  Knees sit halfway down each
    leg so a split leg reads as straight.
    """
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

    # Legs open with the flight: each leg swings split/2 off vertical at the apex.
    lm[:, 27, 0] = 0.45
    lm[:, 28, 0] = 0.55
    leg = body_scale * 0.5
    for t in range(jump_duration):
        frame = jump_start_frame + t
        half = np.radians(split_angle_deg / 2.0) * np.sin(np.pi * t / jump_duration)
        lm[frame, 27, 0] = 0.45 - leg * np.sin(half)
        lm[frame, 27, 1] = hip_y[frame] + leg * np.cos(half)
        lm[frame, 28, 0] = 0.55 + leg * np.sin(half)
        lm[frame, 28, 1] = hip_y[frame] + leg * np.cos(half)

    # Knees halfway down each leg; heels and toes under the ankles.
    for knee, hip, ankle in ((25, 23, 27), (26, 24, 28)):
        lm[:, knee, :2] = (lm[:, hip, :2] + lm[:, ankle, :2]) / 2.0
    for foot_pt, ankle, dy in ((29, 27, 0.02), (30, 28, 0.02), (31, 27, 0.04), (32, 28, 0.04)):
        lm[:, foot_pt, 0] = lm[:, ankle, 0]
        lm[:, foot_pt, 1] = lm[:, ankle, 1] + dy

    return lm, body_scale


# ---------------------------------------------------------------------------

def test_one_jump_detected():
    lm, bs = _make_jump_landmarks()
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1, f"Expected 1 event, got {len(events)}"


def test_jump_type_leap():
    """Legs split wide through the flight → leap."""
    lm, bs = _make_jump_landmarks(split_angle_deg=130.0)
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1
    assert events[0].type == "leap (jeté-type)"


def test_jump_type_saut():
    """Legs together → sauté-type jump."""
    lm, bs = _make_jump_landmarks(split_angle_deg=8.0)
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


def test_moderate_split_is_a_leap():
    """A 90° split is a leap.  The old bar (>100° at the hip-apex frame) called it a jump."""
    lm, bs = _make_jump_landmarks(split_angle_deg=90.0)
    events = detect_jumps(lm, FPS, bs)
    assert len(events) == 1
    assert events[0].type == "leap (jeté-type)"


def _releve_arabesque_landmarks(body_scale: float = 0.75) -> np.ndarray:
    """Rise to relevé and lift the left leg behind to 90°, right toes planted throughout.

    The hips rise well past the jump threshold and the legs really are split -- but nothing
    leaves the floor.  This is the reported "arabesque detected as a split leap".
    """
    lm = np.zeros((N_FRAMES, 33, 4), dtype=np.float32)
    lm[:, :, 3] = 0.9
    leg = body_scale * 0.5
    start, ramp, hold = 60, 5, 12
    for t in range(N_FRAMES):
        if t < start:
            u = 0.0
        elif t < start + ramp:
            u = (t - start + 1) / ramp
        elif t < start + ramp + hold:
            u = 1.0
        elif t < start + 2 * ramp + hold:
            u = 1.0 - (t - start - ramp - hold + 1) / ramp
        else:
            u = 0.0
        releve = 0.05 * u
        hip = 0.5 - releve - 0.04 * u
        lm[t, 23, :2] = (0.45, hip)
        lm[t, 24, :2] = (0.55, hip)
        lm[t, 11, :2] = (0.45, hip - body_scale * 0.5)
        lm[t, 12, :2] = (0.55, hip - body_scale * 0.5)
        # Supporting (right) leg: ankle and heel up on relevé, toe ON THE FLOOR.
        ground = 0.5 + leg
        lm[t, 28, :2] = (0.55, ground - releve)
        lm[t, 30, :2] = (0.54, ground - releve + 0.02)
        lm[t, 32, :2] = (0.57, ground + 0.04)
        lm[t, 26, :2] = (0.55, (hip + ground - releve) / 2)
        # Working (left) leg swung behind.
        a = np.radians(90.0 * u)
        ax, ay = 0.45 - leg * np.sin(a), hip + leg * np.cos(a)
        lm[t, 27, :2] = (ax, ay)
        lm[t, 25, :2] = ((0.45 + ax) / 2, (hip + ay) / 2)
        lm[t, 29, :2] = (ax + 0.01, ay + 0.02)
        lm[t, 31, :2] = (ax - 0.04 * np.sin(a), ay + 0.04 * np.cos(a))
    return lm


def test_releve_arabesque_is_not_a_jump():
    """The hips rise and the legs split, but the supporting toes never leave the floor."""
    lm = _releve_arabesque_landmarks()
    events = detect_jumps(lm, FPS, 0.75)
    assert events == []
