"""Geometry helpers: angles, smoothing, body-scale, rolling baseline."""

import numpy as np
from scipy.ndimage import uniform_filter1d, median_filter


def angle_at(b: np.ndarray, a: np.ndarray, c: np.ndarray) -> float:
    """Return the angle ABC in degrees, at vertex b.

    Accepts 2-D or 3-D point arrays.  Returns NaN if either arm has zero length.
    """
    u = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    v = np.asarray(c, dtype=float) - np.asarray(b, dtype=float)
    norm_u = np.linalg.norm(u)
    norm_v = np.linalg.norm(v)
    if norm_u < 1e-9 or norm_v < 1e-9:
        return float("nan")
    cos_theta = np.dot(u, v) / (norm_u * norm_v)
    cos_theta = np.clip(cos_theta, -1.0, 1.0)   # guard against float rounding
    return float(np.degrees(np.arccos(cos_theta)))


def smooth_landmarks(lm: np.ndarray, window: int = 5) -> np.ndarray:
    """5-frame centered moving average over x, y, z; visibility is left untouched.

    Args:
        lm: shape (N, 33, 4)  — last axis is [x, y, z, visibility]
    Returns:
        smoothed array, same shape
    """
    out = lm.copy()
    for coord in range(3):   # x, y, z only
        channel = lm[:, :, coord]   # (N, 33)
        out[:, :, coord] = uniform_filter1d(channel, size=window, axis=0, mode="nearest")
    return out


def compute_body_scale(lm: np.ndarray) -> float:
    """Median shoulder-mid to ankle-mid distance over frames with good visibility.

    Args:
        lm: shape (N, 33, 4) — normalized image or world landmarks
    Returns:
        Scalar body scale (same units as lm x/y).  Returns 1.0 if no good frames.
    """
    # Indices: L_shoulder=11, R_shoulder=12, L_ankle=27, R_ankle=28
    vis_thresh = 0.5
    # Visibility mask: all four joints must be visible
    vis_ok = (
        (lm[:, 11, 3] >= vis_thresh) &
        (lm[:, 12, 3] >= vis_thresh) &
        (lm[:, 27, 3] >= vis_thresh) &
        (lm[:, 28, 3] >= vis_thresh)
    )
    if not np.any(vis_ok):
        return 1.0
    frames = lm[vis_ok]
    shoulder_mid = (frames[:, 11, :2] + frames[:, 12, :2]) / 2.0
    ankle_mid    = (frames[:, 27, :2] + frames[:, 28, :2]) / 2.0
    dist = np.linalg.norm(shoulder_mid - ankle_mid, axis=1)
    return float(np.median(dist))


def compute_rolling_baseline(hip_y: np.ndarray, fps: float, window_sec: float = 2.0) -> np.ndarray:
    """Trailing-median baseline of hip height.

    For each frame t, baseline[t] = median of hip_y[max(0, t-W) : t+1]
    where W = round(window_sec * fps).

    Args:
        hip_y: 1-D array of hip midpoint y-coordinates (length N)
        fps:   frames per second
    Returns:
        baseline array, same length as hip_y
    """
    W = max(1, round(window_sec * fps))
    N = len(hip_y)
    baseline = np.empty(N)
    for t in range(N):
        start = max(0, t - W + 1)
        baseline[t] = np.median(hip_y[start : t + 1])
    return baseline


def median_filter1d(arr: np.ndarray, window: int = 5) -> np.ndarray:
    """1-D median filter (used to denoise theta before unwrapping)."""
    return median_filter(arr, size=window, mode="nearest")
