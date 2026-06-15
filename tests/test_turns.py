"""Tests for turn detection using synthetic rotating shoulder vectors."""

import sys
import os
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis.moves import detect_turns, TurnEvent


FPS = 30.0


def _make_turn_landmarks(
    rotation_speed_deg_s: float = 360.0,
    turn_duration_s: float = 1.0,
    start_frame: int = 30,
    total_frames: int = 120,
    shoulder_spread: float = 0.3,
) -> np.ndarray:
    """Synthetic world landmarks with one turn.

    The shoulders rotate in the x-z plane at the given angular speed.
    """
    world_lm = np.zeros((total_frames, 33, 4), dtype=np.float32)
    world_lm[:, :, 3] = 0.9

    turn_frames = int(turn_duration_s * FPS)

    for t in range(total_frames):
        if start_frame <= t < start_frame + turn_frames:
            elapsed = (t - start_frame) / FPS
            theta = np.radians(rotation_speed_deg_s * elapsed)
        else:
            theta = 0.0 if t < start_frame else np.radians(
                rotation_speed_deg_s * turn_duration_s
            )

        # R_shoulder (12) and L_shoulder (11) placed symmetrically
        world_lm[t, 12, 0] =  shoulder_spread * np.cos(theta)   # x
        world_lm[t, 12, 2] =  shoulder_spread * np.sin(theta)   # z
        world_lm[t, 11, 0] = -shoulder_spread * np.cos(theta)
        world_lm[t, 11, 2] = -shoulder_spread * np.sin(theta)

        # Ankles: L slightly lower (more grounded) so L is supporting leg
        world_lm[t, 27, 1] = 0.05   # L_ankle y (lower in image = weight bearing)
        world_lm[t, 28, 1] = 0.02   # R_ankle y

    return world_lm


# ---------------------------------------------------------------------------

def test_one_turn_detected():
    world_lm = _make_turn_landmarks(rotation_speed_deg_s=360.0, turn_duration_s=1.0)
    # Mirror into image_lm for ankle detection
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 1, f"Expected 1 event, got {len(events)}"


def test_rotation_count_one():
    world_lm = _make_turn_landmarks(rotation_speed_deg_s=360.0, turn_duration_s=1.0)
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 1
    assert abs(events[0].rotation_count - 1.0) <= 0.5


def test_double_turn_count():
    world_lm = _make_turn_landmarks(rotation_speed_deg_s=360.0, turn_duration_s=2.0)
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 1
    assert abs(events[0].rotation_count - 2.0) <= 0.5


def test_slow_rotation_not_detected():
    """50 deg/s is too slow to qualify as a turn."""
    world_lm = _make_turn_landmarks(rotation_speed_deg_s=50.0, turn_duration_s=2.0)
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 0


def test_short_partial_turn_not_detected():
    """Less than 300° total should not be reported."""
    world_lm = _make_turn_landmarks(rotation_speed_deg_s=360.0, turn_duration_s=0.5)
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 0


def test_supporting_leg_assigned():
    world_lm = _make_turn_landmarks()
    events = detect_turns(world_lm, FPS, body_scale=0.75, image_lm=world_lm)
    assert len(events) == 1
    assert events[0].supporting_leg in ("L", "R")
    assert events[0].working_leg != events[0].supporting_leg
