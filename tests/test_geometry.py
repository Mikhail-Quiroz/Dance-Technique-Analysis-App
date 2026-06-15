"""Unit tests for utils/geometry.py."""

import numpy as np
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils.geometry import (
    angle_at,
    smooth_landmarks,
    compute_body_scale,
    compute_rolling_baseline,
    median_filter1d,
)


# ---------------------------------------------------------------------------
# angle_at
# ---------------------------------------------------------------------------

def test_right_angle():
    b = np.array([0.0, 0.0])
    a = np.array([1.0, 0.0])
    c = np.array([0.0, 1.0])
    assert abs(angle_at(b, a, c) - 90.0) < 0.01


def test_straight_line():
    b = np.array([0.0, 0.0])
    a = np.array([-1.0, 0.0])
    c = np.array([1.0, 0.0])
    assert abs(angle_at(b, a, c) - 180.0) < 0.01


def test_45_degrees():
    b = np.array([0.0, 0.0])
    a = np.array([1.0, 0.0])
    c = np.array([1.0, 1.0])
    assert abs(angle_at(b, a, c) - 45.0) < 0.1


def test_collinear_returns_180():
    b = np.array([0.0, 0.0])
    a = np.array([-2.0, 0.0])
    c = np.array([3.0, 0.0])
    assert abs(angle_at(b, a, c) - 180.0) < 0.1


def test_3d_right_angle():
    b = np.array([0.0, 0.0, 0.0])
    a = np.array([1.0, 0.0, 0.0])
    c = np.array([0.0, 1.0, 0.0])
    assert abs(angle_at(b, a, c) - 90.0) < 0.01


def test_zero_length_arm_returns_nan():
    b = np.array([0.0, 0.0])
    a = np.array([0.0, 0.0])   # zero-length arm
    c = np.array([1.0, 0.0])
    assert np.isnan(angle_at(b, a, c))


# ---------------------------------------------------------------------------
# smooth_landmarks
# ---------------------------------------------------------------------------

def test_smooth_shape_preserved():
    lm = np.random.rand(30, 33, 4).astype(np.float32)
    out = smooth_landmarks(lm, window=5)
    assert out.shape == lm.shape


def test_smooth_constant_signal_unchanged():
    lm = np.ones((30, 33, 4), dtype=np.float32) * 0.5
    out = smooth_landmarks(lm, window=5)
    np.testing.assert_allclose(out[:, :, :3], lm[:, :, :3], atol=1e-5)


def test_smooth_visibility_unchanged():
    lm = np.random.rand(30, 33, 4).astype(np.float32)
    lm[:, :, 3] = 0.9   # specific visibility
    out = smooth_landmarks(lm, window=5)
    np.testing.assert_array_equal(out[:, :, 3], lm[:, :, 3])


# ---------------------------------------------------------------------------
# compute_body_scale
# ---------------------------------------------------------------------------

def _make_lm(n_frames=30, body_height=0.8):
    """Synthetic landmarks: person standing, body_scale ≈ body_height."""
    lm = np.zeros((n_frames, 33, 4), dtype=np.float32)
    lm[:, :, 3] = 0.9   # all visible
    # shoulder mid at y=0.2, ankle mid at y=0.2+body_height
    lm[:, 11, :2] = [0.45, 0.20]   # L_shoulder
    lm[:, 12, :2] = [0.55, 0.20]   # R_shoulder
    lm[:, 27, :2] = [0.45, 0.20 + body_height]   # L_ankle
    lm[:, 28, :2] = [0.55, 0.20 + body_height]   # R_ankle
    return lm


def test_body_scale_positive_finite():
    lm = _make_lm()
    bs = compute_body_scale(lm)
    assert np.isfinite(bs) and bs > 0


def test_body_scale_approximate_value():
    lm = _make_lm(body_height=0.8)
    bs = compute_body_scale(lm)
    # shoulder_mid = (0.5, 0.20), ankle_mid = (0.5, 1.00) → dist = 0.80
    assert abs(bs - 0.80) < 0.01


def test_body_scale_no_visible_returns_one():
    lm = np.zeros((20, 33, 4), dtype=np.float32)   # visibility = 0
    assert compute_body_scale(lm) == 1.0


# ---------------------------------------------------------------------------
# compute_rolling_baseline
# ---------------------------------------------------------------------------

def test_rolling_baseline_flat():
    hip_y = np.full(60, 0.5)
    bl = compute_rolling_baseline(hip_y, fps=30.0, window_sec=2.0)
    np.testing.assert_allclose(bl, 0.5, atol=1e-6)


def test_rolling_baseline_length():
    hip_y = np.random.rand(90)
    bl = compute_rolling_baseline(hip_y, fps=30.0, window_sec=2.0)
    assert len(bl) == len(hip_y)


# ---------------------------------------------------------------------------
# median_filter1d
# ---------------------------------------------------------------------------

def test_median_filter_constant():
    arr = np.full(20, 3.14)
    out = median_filter1d(arr, window=5)
    np.testing.assert_allclose(out, 3.14, atol=1e-6)


def test_median_filter_length():
    arr = np.random.rand(50)
    assert len(median_filter1d(arr, window=5)) == 50
