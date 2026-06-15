"""Technique metric computation at key frames for jumps and turns.

All metrics return None when required joints have visibility < 0.5
(reported as "could not assess" in the feedback layer).
"""

from __future__ import annotations

import numpy as np
from typing import Optional

from utils.geometry import angle_at
from analysis.moves import JumpEvent, TurnEvent, ArabesqueEvent, PliéEvent, RelevéEvent, TiltEvent

# ---------------------------------------------------------------------------
# MediaPipe landmark indices
# ---------------------------------------------------------------------------
L_SHOULDER, R_SHOULDER = 11, 12
L_HIP,      R_HIP      = 23, 24
L_KNEE,     R_KNEE     = 25, 26
L_ANKLE,    R_ANKLE    = 27, 28
L_HEEL,     R_HEEL     = 29, 30
L_FOOT,     R_FOOT     = 31, 32   # foot_index (toe)

VIS_THRESH = 0.5


# ---------------------------------------------------------------------------
# Visibility helpers
# ---------------------------------------------------------------------------

def _vis(lm: np.ndarray, frame: int, *joint_ids: int) -> bool:
    """True if all listed joints are visible at the given frame."""
    return all(lm[frame, jid, 3] >= VIS_THRESH for jid in joint_ids)


def _pt(lm: np.ndarray, frame: int, jid: int) -> np.ndarray:
    """Return (x, y) image-coord point for a joint at a frame."""
    return lm[frame, jid, :2]


def _pt3(lm: np.ndarray, frame: int, jid: int) -> np.ndarray:
    """Return (x, y, z) world-coord point."""
    return lm[frame, jid, :3]


def _mid(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a + b) / 2.0


def _dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b))


# ---------------------------------------------------------------------------
# Jump / Leap metrics
# ---------------------------------------------------------------------------

def compute_jump_metrics(
    image_lm: np.ndarray,
    jump: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Compute all jump/leap technique metrics.

    Returns a dict of metric_name → float | None.
    None means "could not assess (joint not clearly visible)".
    Also returns extra info used for rendering (which leg is front/back).
    """
    af = jump.apex_frame
    lf = jump.landing_frame

    # ---- Determine front vs back leg at apex ----
    # "front" = higher in the air = lower y in image coords
    l_ankle_y = image_lm[af, L_ANKLE, 1]
    r_ankle_y = image_lm[af, R_ANKLE, 1]
    if l_ankle_y <= r_ankle_y:   # L is higher (lower y) → L is front
        front = "L"
        back  = "R"
        front_ids = (L_HIP, L_KNEE, L_ANKLE, L_FOOT, L_HEEL)
        back_ids  = (R_HIP, R_KNEE, R_ANKLE, R_FOOT, R_HEEL)
        f_hip, f_knee, f_ankle, f_foot = L_HIP, L_KNEE, L_ANKLE, L_FOOT
        b_hip, b_knee, b_ankle, b_foot = R_HIP, R_KNEE, R_ANKLE, R_FOOT
    else:
        front = "R"
        back  = "L"
        f_hip, f_knee, f_ankle, f_foot = R_HIP, R_KNEE, R_ANKLE, R_FOOT
        b_hip, b_knee, b_ankle, b_foot = L_HIP, L_KNEE, L_ANKLE, L_FOOT

    metrics: dict = {"_front_leg": front, "_back_leg": back}

    # ---- Front leg extension ----
    if _vis(image_lm, af, f_hip, f_knee, f_ankle):
        metrics["front_leg_ext"] = angle_at(
            _pt(image_lm, af, f_knee),
            _pt(image_lm, af, f_hip),
            _pt(image_lm, af, f_ankle),
        )
    else:
        metrics["front_leg_ext"] = None

    # ---- Back leg extension ----
    if _vis(image_lm, af, b_hip, b_knee, b_ankle):
        metrics["back_leg_ext"] = angle_at(
            _pt(image_lm, af, b_knee),
            _pt(image_lm, af, b_hip),
            _pt(image_lm, af, b_ankle),
        )
    else:
        metrics["back_leg_ext"] = None

    # ---- Pointed feet ----
    # point_feet: mean of front and back foot point score (use single value = min)
    for side_name, knee_id, ankle_id, foot_id in [
        ("front", f_knee, f_ankle, f_foot),
        ("back",  b_knee, b_ankle, b_foot),
    ]:
        if _vis(image_lm, af, knee_id, ankle_id, foot_id):
            metrics[f"point_foot_{side_name}"] = angle_at(
                _pt(image_lm, af, ankle_id),
                _pt(image_lm, af, knee_id),
                _pt(image_lm, af, foot_id),
            )
        else:
            metrics[f"point_foot_{side_name}"] = None

    # Combined foot score = min of both (weakest foot reported)
    pf = [v for v in [metrics["point_foot_front"], metrics["point_foot_back"]] if v is not None]
    metrics["point_feet"] = min(pf) if pf else None

    # ---- Split angle ----
    metrics["split_angle"] = jump.split_angle_deg if jump.type == "leap (jeté-type)" else None

    # ---- Torso uprightness at apex ----
    if _vis(image_lm, af, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP):
        shoulder_mid = _mid(_pt(image_lm, af, L_SHOULDER), _pt(image_lm, af, R_SHOULDER))
        hip_mid      = _mid(_pt(image_lm, af, L_HIP),      _pt(image_lm, af, R_HIP))
        torso_vec = shoulder_mid - hip_mid
        norm = np.linalg.norm(torso_vec)
        if norm > 1e-9:
            upward = np.array([0.0, -1.0])   # image coords: up = negative y
            cos_a = np.clip(np.dot(torso_vec / norm, upward), -1.0, 1.0)
            metrics["torso_uprightness"] = float(np.degrees(np.arccos(cos_a)))
        else:
            metrics["torso_uprightness"] = None
    else:
        metrics["torso_uprightness"] = None

    # ---- Back-leg height / leap levelness ----
    # Only meaningful for leaps; measures whether the back ankle reaches at least
    # hip-height (parallel to floor).  Positive = above hip (good), negative = below.
    if jump.type == "leap (jeté-type)" and _vis(image_lm, af, L_HIP, R_HIP, b_ankle):
        hip_mid_y    = float((image_lm[af, L_HIP, 1] + image_lm[af, R_HIP, 1]) / 2.0)
        back_ankle_y = float(image_lm[af, b_ankle, 1])
        # In image coords y increases downward; positive result = ankle above hip = good
        metrics["back_leg_height"] = (hip_mid_y - back_ankle_y) / body_scale
    else:
        metrics["back_leg_height"] = None

    # ---- Landing plié depth ----
    # Window: landing_frame to landing_frame + 0.35 s
    land_window = range(lf, min(lf + round(0.35 * fps) + 1, len(image_lm)))
    plie_angles: list[float] = []
    for side_ids in [
        (L_HIP, L_KNEE, L_ANKLE),
        (R_HIP, R_KNEE, R_ANKLE),
    ]:
        hip_id, knee_id, ankle_id = side_ids
        for t in land_window:
            if _vis(image_lm, t, hip_id, knee_id, ankle_id):
                ang = angle_at(
                    _pt(image_lm, t, knee_id),
                    _pt(image_lm, t, hip_id),
                    _pt(image_lm, t, ankle_id),
                )
                if not np.isnan(ang):
                    plie_angles.append(ang)

    metrics["land_plie"] = float(min(plie_angles)) if plie_angles else None

    return metrics


# ---------------------------------------------------------------------------
# Turn metrics
# ---------------------------------------------------------------------------

def compute_turn_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    turn: TurnEvent,
    fps: float,
    body_scale: float,
    turn_style: str = "auto",
) -> dict:
    """Compute turn technique metrics over the middle 60% of the turn.

    turn_style: "auto" | "pirouette" | "a_la_seconde"
      "auto" → infer from working knee angle (> 140° = à la seconde)
      "pirouette" → passé/retiré metrics (retire_dist, working_knee_fold)
      "a_la_seconde" → extended-leg metrics (seconde_height, extend check)
    """
    sf = turn.start_frame
    ef = turn.end_frame
    duration = ef - sf + 1

    trim = int(duration * 0.20)
    mid_start = sf + trim
    mid_end   = ef - trim + 1
    if mid_start >= mid_end:
        mid_start = sf
        mid_end   = ef + 1

    mid_frames = list(range(mid_start, mid_end))
    if not mid_frames:
        mid_frames = [sf]

    # Joint index aliases
    if turn.supporting_leg == "L":
        sup_ankle, sup_knee, sup_heel, sup_foot = L_ANKLE, L_KNEE, L_HEEL, L_FOOT
        wkg_hip, wkg_knee, wkg_ankle            = R_HIP,   R_KNEE,  R_ANKLE
    else:
        sup_ankle, sup_knee, sup_heel, sup_foot = R_ANKLE, R_KNEE, R_HEEL, R_FOOT
        wkg_hip, wkg_knee, wkg_ankle            = L_HIP,   L_KNEE,  L_ANKLE

    metrics: dict = {}

    # ---- Working knee fold — compute raw value first (used for auto-detect) ----
    knee_fold_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, wkg_hip, wkg_knee, wkg_ankle):
            ang = angle_at(
                _pt(image_lm, t, wkg_knee),
                _pt(image_lm, t, wkg_hip),
                _pt(image_lm, t, wkg_ankle),
            )
            if not np.isnan(ang):
                knee_fold_vals.append(ang)
    knee_fold_raw = float(np.median(knee_fold_vals)) if knee_fold_vals else None

    # ---- Auto-detect turn style ----
    if turn_style == "auto":
        # Extended working leg (> 140°) → à la seconde; folded (≤ 140°) → pirouette
        if knee_fold_raw is not None and knee_fold_raw > 140.0:
            turn_style = "a_la_seconde"
        else:
            turn_style = "pirouette"

    metrics["_turn_style"] = turn_style   # consumed by feedback layer

    # ---- Relevé height (common to both styles) ----
    releve_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, sup_heel, sup_foot):
            r = (image_lm[t, sup_foot, 1] - image_lm[t, sup_heel, 1]) / body_scale
            releve_vals.append(r)
    metrics["releve_height"] = float(np.median(releve_vals)) if releve_vals else None

    # ---- Vertical stacking (common to both styles) ----
    stack_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, sup_ankle):
            sh_mid_x = (image_lm[t, L_SHOULDER, 0] + image_lm[t, R_SHOULDER, 0]) / 2.0
            hp_mid_x = (image_lm[t, L_HIP, 0]      + image_lm[t, R_HIP, 0])      / 2.0
            an_x     = image_lm[t, sup_ankle, 0]
            deviation = max(abs(sh_mid_x - hp_mid_x), abs(hp_mid_x - an_x)) / body_scale
            stack_vals.append(deviation)
    metrics["vert_stack"] = float(np.median(stack_vals)) if stack_vals else None

    if turn_style == "pirouette":
        # ---- Retiré distance ----
        retire_vals: list[float] = []
        for t in mid_frames:
            if _vis(image_lm, t, wkg_ankle, sup_knee):
                d = _dist(_pt(image_lm, t, wkg_ankle), _pt(image_lm, t, sup_knee))
                retire_vals.append(d / body_scale)
        metrics["retire_dist"]       = float(np.median(retire_vals)) if retire_vals else None
        metrics["working_knee_fold"] = knee_fold_raw
        # à la seconde metrics not applicable
        metrics["seconde_height"]     = None
        metrics["seconde_knee_ext"]   = None

    else:  # a_la_seconde
        # ---- Seconde height: working ankle y relative to hip_mid y ----
        # Positive = ankle above hip (good); negative = ankle below hip (dropped)
        seconde_vals: list[float] = []
        for t in mid_frames:
            if _vis(image_lm, t, wkg_ankle, L_HIP, R_HIP):
                hip_y    = (image_lm[t, L_HIP, 1] + image_lm[t, R_HIP, 1]) / 2.0
                ankle_y  = image_lm[t, wkg_ankle, 1]
                # image coords: lower y = higher position
                # ankle above hip → ankle_y < hip_y → (hip_y - ankle_y) > 0
                height_ratio = (hip_y - ankle_y) / body_scale
                seconde_vals.append(height_ratio)
        metrics["seconde_height"] = float(np.median(seconde_vals)) if seconde_vals else None

        # ---- Working knee extension in à la seconde ----
        # For à la seconde the knee should be fully straight (> 165°)
        metrics["seconde_knee_ext"] = knee_fold_raw

        # Passé metrics not applicable for à la seconde
        metrics["retire_dist"]       = None
        metrics["working_knee_fold"] = None

    return metrics


# ---------------------------------------------------------------------------
# Arabesque metrics
# ---------------------------------------------------------------------------

def compute_arabesque_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    arabesque: ArabesqueEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Compute arabesque technique metrics over the middle 60% of the hold."""
    sf = arabesque.start_frame
    ef = arabesque.end_frame
    pf = arabesque.peak_frame

    trim      = int((ef - sf + 1) * 0.20)
    mid_start = sf + trim
    mid_end   = ef - trim + 1
    if mid_start >= mid_end:
        mid_start, mid_end = sf, ef + 1
    mid_frames = list(range(mid_start, mid_end)) or [sf]

    if arabesque.working_leg == "L":
        w_hip, w_knee, w_ankle = L_HIP, L_KNEE, L_ANKLE
        s_hip, s_knee, s_ankle = R_HIP, R_KNEE, R_ANKLE
    else:
        w_hip, w_knee, w_ankle = R_HIP, R_KNEE, R_ANKLE
        s_hip, s_knee, s_ankle = L_HIP, L_KNEE, L_ANKLE

    metrics: dict = {}

    # ---- Arabesque height: angle of working leg above horizontal (world coords) ----
    height_vals: list[float] = []
    for t in [pf] + mid_frames:
        hip_pos   = _pt3(world_lm, t, w_hip)
        ankle_pos = _pt3(world_lm, t, w_ankle)
        leg_vec   = ankle_pos - hip_pos
        horiz     = float(np.sqrt(leg_vec[0] ** 2 + leg_vec[2] ** 2))
        elev_deg  = float(np.degrees(np.arctan2(leg_vec[1], horiz + 1e-9)))
        height_vals.append(elev_deg)
    metrics["arabesque_height"] = float(np.median(height_vals)) if height_vals else None

    # ---- Working (back) knee extension ----
    knee_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, w_hip, w_knee, w_ankle):
            ang = angle_at(_pt(image_lm, t, w_knee),
                           _pt(image_lm, t, w_hip),
                           _pt(image_lm, t, w_ankle))
            if not np.isnan(ang):
                knee_vals.append(ang)
    metrics["arabesque_knee_ext"] = float(np.median(knee_vals)) if knee_vals else None

    # ---- Supporting knee extension ----
    supp_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, s_hip, s_knee, s_ankle):
            ang = angle_at(_pt(image_lm, t, s_knee),
                           _pt(image_lm, t, s_hip),
                           _pt(image_lm, t, s_ankle))
            if not np.isnan(ang):
                supp_vals.append(ang)
    metrics["support_knee_ext"] = float(np.median(supp_vals)) if supp_vals else None

    # ---- Torso tilt from vertical ----
    tilt_vals: list[float] = []
    for t in mid_frames:
        if _vis(image_lm, t, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP):
            sh_mid = _mid(_pt(image_lm, t, L_SHOULDER), _pt(image_lm, t, R_SHOULDER))
            hp_mid = _mid(_pt(image_lm, t, L_HIP),      _pt(image_lm, t, R_HIP))
            torso  = sh_mid - hp_mid
            norm   = float(np.linalg.norm(torso))
            if norm > 1e-9:
                cos_a = float(np.clip(np.dot(torso / norm, np.array([0.0, -1.0])), -1.0, 1.0))
                tilt_vals.append(float(np.degrees(np.arccos(cos_a))))
    metrics["arabesque_tilt"] = float(np.median(tilt_vals)) if tilt_vals else None

    return metrics


# ---------------------------------------------------------------------------
# Développé metrics
# ---------------------------------------------------------------------------

def compute_developpe_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    arabesque: "ArabesqueEvent",
    fps: float,
    body_scale: float,
) -> dict:
    """Compute développé technique metrics.

    Same measurements as arabesque plus hold_duration_s: how long the leg
    stayed within 90% of its peak elevation (quality of the sustained position).
    """
    metrics = compute_arabesque_metrics(image_lm, world_lm, arabesque, fps, body_scale)

    # Rename arabesque_tilt → re-use key (same metric, different move label)
    # Compute hold duration: frames where working ankle world-Y ≥ 90% of peak elevation
    if arabesque.working_leg == "L":
        work_ankle_id = L_ANKLE
    else:
        work_ankle_id = R_ANKLE

    sf, ef, pf = arabesque.start_frame, arabesque.end_frame, arabesque.peak_frame
    peak_y   = float(world_lm[pf, work_ankle_id, 1])
    hip_y    = (world_lm[pf, 23, 1] + world_lm[pf, 24, 1]) / 2.0
    elev     = peak_y - hip_y   # net elevation at peak

    if elev > 0:
        threshold_y = hip_y + elev * 0.90   # 90% of peak elevation above hip
        hold_frames = int(np.sum(world_lm[sf:ef + 1, work_ankle_id, 1] >= threshold_y))
        metrics["hold_duration_s"] = hold_frames / fps
    else:
        metrics["hold_duration_s"] = None

    return metrics


# ---------------------------------------------------------------------------
# Torso tilt helper (shared)
# ---------------------------------------------------------------------------

def _torso_tilt_at(image_lm: np.ndarray, frame: int) -> Optional[float]:
    """Return torso tilt from vertical (degrees) at a given frame."""
    if not _vis(image_lm, frame, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP):
        return None
    sh_mid = _mid(_pt(image_lm, frame, L_SHOULDER), _pt(image_lm, frame, R_SHOULDER))
    hp_mid = _mid(_pt(image_lm, frame, L_HIP),      _pt(image_lm, frame, R_HIP))
    torso  = sh_mid - hp_mid
    norm   = float(np.linalg.norm(torso))
    if norm < 1e-9:
        return None
    upward = np.array([0.0, -1.0])
    cos_a  = float(np.clip(np.dot(torso / norm, upward), -1.0, 1.0))
    return float(np.degrees(np.arccos(cos_a)))


# ---------------------------------------------------------------------------
# Grand battement metrics
# ---------------------------------------------------------------------------

def compute_grand_battement_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    arabesque_ev: ArabesqueEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for grand battement: measured at peak frame (brief event)."""
    pf = arabesque_ev.peak_frame

    if arabesque_ev.working_leg == "L":
        w_hip, w_knee, w_ankle = L_HIP, L_KNEE, L_ANKLE
    else:
        w_hip, w_knee, w_ankle = R_HIP, R_KNEE, R_ANKLE

    metrics: dict = {}

    # battement_height: working leg angle above horizontal (world coords)
    hip_pos   = _pt3(world_lm, pf, w_hip)
    ankle_pos = _pt3(world_lm, pf, w_ankle)
    leg_vec   = ankle_pos - hip_pos
    horiz     = float(np.sqrt(leg_vec[0] ** 2 + leg_vec[2] ** 2))
    metrics["battement_height"] = float(np.degrees(np.arctan2(leg_vec[1], horiz + 1e-9)))

    # battement_knee_ext: working knee angle at peak
    if _vis(image_lm, pf, w_hip, w_knee, w_ankle):
        ang = angle_at(_pt(image_lm, pf, w_knee),
                       _pt(image_lm, pf, w_hip),
                       _pt(image_lm, pf, w_ankle))
        metrics["battement_knee_ext"] = ang if not np.isnan(ang) else None
    else:
        metrics["battement_knee_ext"] = None

    # battement_tilt: torso tilt at peak
    metrics["battement_tilt"] = _torso_tilt_at(image_lm, pf)

    return metrics


# ---------------------------------------------------------------------------
# Plié metrics
# ---------------------------------------------------------------------------

def compute_plie_metrics(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    plie_ev: PliéEvent,
) -> dict:
    """Metrics for plié: measured at peak_frame (deepest bend)."""
    pf = plie_ev.peak_frame
    metrics: dict = {}

    # plie_depth: bilateral knee angle at peak
    angles = []
    for hip_id, knee_id, ankle_id in [(L_HIP, L_KNEE, L_ANKLE), (R_HIP, R_KNEE, R_ANKLE)]:
        if _vis(image_lm, pf, hip_id, knee_id, ankle_id):
            ang = angle_at(_pt(image_lm, pf, knee_id),
                           _pt(image_lm, pf, hip_id),
                           _pt(image_lm, pf, ankle_id))
            if not np.isnan(ang):
                angles.append(ang)
    metrics["plie_depth"] = float(np.mean(angles)) if angles else None

    # plie_back_vertical: torso tilt at peak
    metrics["plie_back_vertical"] = _torso_tilt_at(image_lm, pf)

    return metrics


# ---------------------------------------------------------------------------
# Relevé balance metrics
# ---------------------------------------------------------------------------

def compute_releve_metrics(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    releve_ev: RelevéEvent,
) -> dict:
    """Metrics for relevé balance hold."""
    pf = releve_ev.peak_frame
    sf = releve_ev.start_frame
    ef = releve_ev.end_frame
    metrics: dict = {}

    # releve_height: average bilateral heel height at peak
    l_rh = (image_lm[pf, L_FOOT, 1] - image_lm[pf, L_HEEL, 1]) / body_scale
    r_rh = (image_lm[pf, R_FOOT, 1] - image_lm[pf, R_HEEL, 1]) / body_scale
    metrics["releve_height"] = float((l_rh + r_rh) / 2.0)

    # hold_duration_s: duration of the relevé hold
    duration = ef - sf + 1
    metrics["hold_duration_s"] = float(duration / fps)

    # ankle_wobble: std-dev of average ankle x over middle 50% of hold
    mid_start = sf + int(duration * 0.25)
    mid_end   = ef - int(duration * 0.25) + 1
    if mid_start >= mid_end:
        mid_start, mid_end = sf, ef + 1
    ankle_x_vals = []
    for t in range(mid_start, mid_end):
        ax = (image_lm[t, L_ANKLE, 0] + image_lm[t, R_ANKLE, 0]) / 2.0
        ankle_x_vals.append(ax / body_scale)
    metrics["ankle_wobble"] = float(np.std(ankle_x_vals)) if len(ankle_x_vals) > 1 else 0.0

    return metrics


# ---------------------------------------------------------------------------
# Tilt metrics
# ---------------------------------------------------------------------------

def compute_tilt_metrics(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    tilt_ev: TiltEvent,
) -> dict:
    """Metrics for tilt / layout / hinge."""
    pf = tilt_ev.peak_frame
    sf = tilt_ev.start_frame
    ef = tilt_ev.end_frame
    metrics: dict = {}

    # tilt_angle: torso tilt from vertical at peak
    metrics["tilt_angle"] = _torso_tilt_at(image_lm, pf)

    # tilt_hold_s: hold duration
    metrics["tilt_hold_s"] = float((ef - sf + 1) / fps)

    # tilt_leg_line: average knee extension at peak
    angles = []
    for hip_id, knee_id, ankle_id in [(L_HIP, L_KNEE, L_ANKLE), (R_HIP, R_KNEE, R_ANKLE)]:
        if _vis(image_lm, pf, hip_id, knee_id, ankle_id):
            ang = angle_at(_pt(image_lm, pf, knee_id),
                           _pt(image_lm, pf, hip_id),
                           _pt(image_lm, pf, ankle_id))
            if not np.isnan(ang):
                angles.append(ang)
    metrics["tilt_leg_line"] = float(np.mean(angles)) if angles else None

    return metrics


# ---------------------------------------------------------------------------
# Chaîné turn metrics
# ---------------------------------------------------------------------------

def compute_chaine_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    turn_ev: TurnEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for chaîné turns: standard pirouette metrics + travel distance."""
    metrics = compute_turn_metrics(image_lm, world_lm, turn_ev, fps, body_scale,
                                   turn_style="pirouette")

    # travel_distance: total horizontal displacement of hip midpoint
    sf = turn_ev.start_frame
    ef = turn_ev.end_frame
    start_hip_x = (image_lm[sf, L_HIP, 0] + image_lm[sf, R_HIP, 0]) / 2.0
    end_hip_x   = (image_lm[ef, L_HIP, 0] + image_lm[ef, R_HIP, 0]) / 2.0
    metrics["travel_distance"] = float(abs(end_hip_x - start_hip_x) / body_scale)

    return metrics


# ---------------------------------------------------------------------------
# Piqué turn metrics
# ---------------------------------------------------------------------------

def compute_pique_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    turn_ev: TurnEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for piqué turns: standard pirouette metrics + rotation consistency."""
    metrics = compute_turn_metrics(image_lm, world_lm, turn_ev, fps, body_scale,
                                   turn_style="pirouette")

    # rotation_consistency: CV of angular velocity during the spin window
    _, omega, _ = _get_shoulder_signal_cached(world_lm, fps)
    sf = turn_ev.start_frame
    ef = turn_ev.end_frame
    omega_seg = omega[sf:ef + 1]
    mean_om   = float(np.mean(np.abs(omega_seg)))
    std_om    = float(np.std(omega_seg))
    if mean_om > 1e-6:
        metrics["rotation_consistency"] = float(std_om / mean_om)
    else:
        metrics["rotation_consistency"] = None

    return metrics


def _get_shoulder_signal_cached(world_lm: np.ndarray, fps: float):
    """Wrapper to call _shoulder_signal from moves module."""
    from analysis.moves import _shoulder_signal
    return _shoulder_signal(world_lm, fps)


# ---------------------------------------------------------------------------
# Fouetté turn metrics
# ---------------------------------------------------------------------------

def compute_fouette_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    turn_ev: TurnEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for fouetté turns: pirouette base + working knee oscillation."""
    metrics = compute_turn_metrics(image_lm, world_lm, turn_ev, fps, body_scale,
                                   turn_style="pirouette")

    sf = turn_ev.start_frame
    ef = turn_ev.end_frame

    # Working knee angle over the turn
    if turn_ev.working_leg == "L":
        wkg_hip, wkg_knee, wkg_ankle = L_HIP, L_KNEE, L_ANKLE
    else:
        wkg_hip, wkg_knee, wkg_ankle = R_HIP, R_KNEE, R_ANKLE

    knee_angles = []
    for t in range(sf, ef + 1):
        if _vis(image_lm, t, wkg_hip, wkg_knee, wkg_ankle):
            ang = angle_at(_pt(image_lm, t, wkg_knee),
                           _pt(image_lm, t, wkg_hip),
                           _pt(image_lm, t, wkg_ankle))
            if not np.isnan(ang):
                knee_angles.append(ang)

    if knee_angles:
        metrics["knee_oscillation"]  = float(np.std(knee_angles))
        metrics["knee_extension_max"] = float(np.max(knee_angles))
    else:
        metrics["knee_oscillation"]  = None
        metrics["knee_extension_max"] = None

    return metrics


# ---------------------------------------------------------------------------
# Pirouette upgrade: en dehors / en dedans direction
# ---------------------------------------------------------------------------

def compute_pirouette_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    turn_ev: TurnEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Pirouette metrics with direction classification."""
    metrics = compute_turn_metrics(image_lm, world_lm, turn_ev, fps, body_scale,
                                   turn_style="pirouette")

    # Classify direction from mean omega during the turn
    _, omega, _ = _get_shoulder_signal_cached(world_lm, fps)
    sf = turn_ev.start_frame
    ef = turn_ev.end_frame
    mean_omega = float(np.mean(omega[sf:ef + 1]))
    metrics["_turn_direction"] = "en_dehors" if mean_omega > 0 else "en_dedans"

    return metrics


# ---------------------------------------------------------------------------
# Changement metrics
# ---------------------------------------------------------------------------

def compute_changement_metrics(
    image_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for changement: both feet together at apex + feet swap."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)
    af = jump_ev.apex_frame
    tf = jump_ev.takeoff_frame
    lf = jump_ev.landing_frame

    # feet_together: ankle distance at apex normalized by body_scale
    l_ankle = _pt(image_lm, af, L_ANKLE)
    r_ankle = _pt(image_lm, af, R_ANKLE)
    dist    = _dist(l_ankle, r_ankle)
    metrics["feet_together"] = float(dist / body_scale)

    # feet_swap: which ankle is in front at takeoff vs landing
    # "front" = lower y (higher in frame)
    take_l_y  = image_lm[tf, L_ANKLE, 1]
    take_r_y  = image_lm[tf, R_ANKLE, 1]
    land_l_y  = image_lm[lf, L_ANKLE, 1]
    land_r_y  = image_lm[lf, R_ANKLE, 1]
    front_at_take = "L" if take_l_y <= take_r_y else "R"
    front_at_land = "L" if land_l_y <= land_r_y else "R"
    metrics["feet_swap"] = 1.0 if front_at_take != front_at_land else 0.0

    return metrics


# ---------------------------------------------------------------------------
# Saut de chat metrics
# ---------------------------------------------------------------------------

def compute_saut_de_chat_metrics(
    image_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for saut de chat: front knee fold at takeoff."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)
    tf = jump_ev.takeoff_frame

    # Front leg at apex determines which knee to check at takeoff
    front_leg = metrics.get("_front_leg", "L")
    if front_leg == "L":
        f_hip, f_knee, f_ankle = L_HIP, L_KNEE, L_ANKLE
    else:
        f_hip, f_knee, f_ankle = R_HIP, R_KNEE, R_ANKLE

    if _vis(image_lm, tf, f_hip, f_knee, f_ankle):
        ang = angle_at(_pt(image_lm, tf, f_knee),
                       _pt(image_lm, tf, f_hip),
                       _pt(image_lm, tf, f_ankle))
        metrics["front_knee_fold_takeoff"] = ang if not np.isnan(ang) else None
    else:
        metrics["front_knee_fold_takeoff"] = None

    return metrics


# ---------------------------------------------------------------------------
# Switch leap metrics
# ---------------------------------------------------------------------------

def compute_switch_leap_metrics(
    image_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for switch leap: ankle positions swap mid-air."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)
    af  = jump_ev.apex_frame
    N   = len(image_lm)

    pre_frame  = max(0, af - int(fps * 0.1))
    post_frame = min(N - 1, af + int(fps * 0.1))

    pre_l_y  = image_lm[pre_frame,  L_ANKLE, 1]
    pre_r_y  = image_lm[pre_frame,  R_ANKLE, 1]
    post_l_y = image_lm[post_frame, L_ANKLE, 1]
    post_r_y = image_lm[post_frame, R_ANKLE, 1]

    front_pre  = "L" if pre_l_y  <= pre_r_y  else "R"
    front_post = "L" if post_l_y <= post_r_y else "R"
    metrics["swap_achieved"] = 1.0 if front_pre != front_post else 0.0

    return metrics


# ---------------------------------------------------------------------------
# Assemblé metrics
# ---------------------------------------------------------------------------

def compute_assemble_metrics(
    image_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for assemblé: ankles should join at apex."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)
    af = jump_ev.apex_frame

    l_ankle = _pt(image_lm, af, L_ANKLE)
    r_ankle = _pt(image_lm, af, R_ANKLE)
    metrics["ankle_join"] = float(_dist(l_ankle, r_ankle) / body_scale)

    return metrics


# ---------------------------------------------------------------------------
# Toe touch (jazz) metrics
# ---------------------------------------------------------------------------

def compute_toe_touch_metrics(
    image_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for toe touch: wide split + torso upright."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)
    # split_angle and torso_uprightness are already computed — just return with toe_touch label
    return metrics


# ---------------------------------------------------------------------------
# Compound jump metrics (tour jeté, calypso)
# ---------------------------------------------------------------------------

def compute_compound_jump_metrics(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    jump_ev: JumpEvent,
    fps: float,
    body_scale: float,
) -> dict:
    """Metrics for spinning jumps: standard jump metrics + spinning fraction."""
    metrics = compute_jump_metrics(image_lm, jump_ev, fps, body_scale)

    # spinning_during_jump: fraction of airborne frames that are spinning
    from analysis.moves import _shoulder_signal
    _, _, spinning_mask = _shoulder_signal(world_lm, fps)
    tf = jump_ev.takeoff_frame
    lf = jump_ev.landing_frame
    N  = len(image_lm)
    seg_end = min(lf + 1, N)
    if seg_end > tf:
        spin_frac = float(np.mean(spinning_mask[tf:seg_end]))
    else:
        spin_frac = 0.0
    metrics["spinning_during_jump"] = spin_frac

    return metrics
