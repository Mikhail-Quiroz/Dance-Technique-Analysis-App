"""Pirouette critique on an articulated, rotating synthetic dancer.

Same body as frontend/lib/live/turnDetector.test.ts, so the Python and TypeScript ports of
the pirouette metrics are checked against identical geometry: built in the dancer's own
frame (x right, y up from the floor, z forward, metres), turned about the vertical axis,
then expressed in MediaPipe world coordinates (x right, y DOWN, z away from the camera,
origin at the hips).  Each fault the critique names is its own knob.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis.feedback import build_move_feedback
from analysis.metrics import compute_turn_metrics
from analysis.moves import TurnEvent

FPS = 30.0


def _body(yaw, head_rel=0.0, releve=60.0, passe_gap=0.0, lean=0.0, hip_hike=0.0,
          arms_dy=0.0, elbow_sag=0.0):
    r = np.radians(releve)
    toe = np.array([0.0, 0.0, 0.12])
    heel = np.array([0.0, 0.20 * np.sin(r), 0.12 - 0.20 * np.cos(r)])
    s_ankle = np.array([0.0, heel[1] + 0.07, heel[2] + 0.03])
    s_knee = np.array([0.05, s_ankle[1] + 0.42, s_ankle[2]])
    hip_y = s_knee[1] + 0.42
    hz = s_ankle[2]
    p = {
        24: [0.10, hip_y, hz], 26: s_knee, 28: s_ankle, 30: heel, 32: toe,
        23: [-0.10, hip_y + hip_hike, hz],
    }
    w_toe = np.array([s_knee[0] - passe_gap * 0.3, s_knee[1] - passe_gap * 0.6, hz + 0.06 + passe_gap * 0.7])
    p[31] = w_toe
    p[27] = w_toe + [-0.10, 0.04, -0.04]
    p[29] = p[27] + [-0.02, -0.03, -0.05]
    p[25] = [-0.35, hip_y - 0.19, hz + 0.25]
    sh = hip_y + 0.50
    p[11], p[12] = [-0.18, sh, hz], [0.18, sh, hz]
    for side, (el, wr, ix) in ((-1, (13, 15, 19)), (1, (14, 16, 20))):
        p[el] = [side * 0.25, sh - 0.19 + arms_dy - elbow_sag, hz + 0.20]
        p[wr] = [side * 0.12, sh - 0.26 + arms_dy, hz + 0.38]
        p[ix] = [side * 0.06, sh - 0.28 + arms_dy, hz + 0.42]
    h = np.radians(head_rel)
    head = lambda x, z: [x * np.cos(h) + z * np.sin(h), sh + 0.18, hz - x * np.sin(h) + z * np.cos(h)]  # noqa: E731
    p[0], p[7], p[8] = head(0, 0.10), head(-0.07, 0), head(0.07, 0)
    le = np.radians(lean)
    out = {}
    for k, (x, y, z) in p.items():
        dx = x - toe[0]
        out[k] = np.array([toe[0] + dx * np.cos(le) - y * np.sin(le), dx * np.sin(le) + y * np.cos(le), z])
    return out


def _frame(yaw, **kw):
    pts = _body(yaw, **kw)
    hip_y = (pts[23][1] + pts[24][1]) / 2
    y = np.radians(yaw)
    world = np.zeros((33, 4))
    world[:, 3] = 1.0
    for k, (x, py, z) in pts.items():
        x1 = x * np.cos(y) + z * np.sin(y)
        z1 = -x * np.sin(y) + z * np.cos(y)
        world[k, :3] = (-x1, -(py - hip_y), -z1)
    image = np.zeros((33, 4))
    image[:, 0] = 0.5 + world[:, 0] * 0.4
    image[:, 1] = 0.95 + (world[:, 1] - hip_y) * 0.4
    facing = abs(((yaw + kw.get("head_rel", 0.0)) % 360 + 540) % 360 - 180) < 100
    image[:, 3] = 0.95
    if not facing:
        image[[0, 7, 8], 3] = 0.1
    return image, world


def _spot_head(yaw):
    return float(np.clip(-(((yaw % 360) + 540) % 360 - 180), -80, 80))


def _turn(spot=True, **kw):
    n = 20   # one rotation at 540 deg/s, 30 fps
    image, world = [], []
    for i in range(1, n + 1):
        yaw = 360.0 * i / n
        im, w = _frame(yaw, head_rel=_spot_head(yaw) if spot else 0.0, **kw)
        image.append(im)
        world.append(w)
    image_lm, world_lm = np.array(image), np.array(world)
    ev = TurnEvent(start_frame=0, end_frame=n - 1, rotation_count=1.0,
                   supporting_leg="R", working_leg="L", start_ts_ms=0, end_ts_ms=int((n - 1) * 1000 / FPS))
    metrics = compute_turn_metrics(image_lm, world_lm, ev, FPS, body_scale=0.5, turn_style="pirouette")
    return metrics, build_move_feedback(metrics, ev)


def test_clean_pirouette_measures_what_it_was_given():
    m, report = _turn()
    assert m["releve_angle"] > 50
    assert m["retire_connection"] < 0.12
    assert m["spot_follow"] < 0.2
    assert m["turn_axis_tilt"] < 3
    assert m["hip_level"] < 2
    assert 15 < m["arm_height_high"] and m["arm_height_low"] < 45
    assert m["elbow_drop"] <= 0
    new_cues = {"press_releve", "connect_passe", "quick_spot", "vertical_axis", "level_hips",
                "lower_arms_first", "lift_arms_first", "lift_elbows"}
    assert not new_cues & {c.cue_id for c in report.top_cues}


def test_passe_drift_is_not_double_cued():
    """retire_connection replaces the 2-D retire_dist, so one fault is one cue."""
    m, _ = _turn()
    assert m["retire_connection"] is not None
    assert m["retire_dist"] is None


@pytest.mark.parametrize("kw, cue", [
    ({"releve": 15}, "press_releve"),
    ({"passe_gap": 0.30}, "connect_passe"),
    ({"spot": False}, "quick_spot"),
    ({"lean": 14}, "vertical_axis"),
    ({"hip_hike": 0.035}, "level_hips"),
    ({"arms_dy": 0.30}, "lower_arms_first"),
    ({"arms_dy": -0.30}, "lift_arms_first"),
    ({"elbow_sag": 0.20}, "lift_elbows"),
])
def test_each_fault_is_cued(kw, cue):
    _, report = _turn(**kw)
    assert cue in [c.cue_id for c in report.top_cues], [c.cue_id for c in report.top_cues]
