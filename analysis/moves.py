"""Jump/leap and turn/pirouette detection from smoothed landmark sequences."""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass
from typing import Optional

from utils.geometry import (
    angle_at,
    compute_rolling_baseline,
    median_filter1d,
)

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class JumpEvent:
    takeoff_frame: int
    apex_frame:    int
    landing_frame: int
    type: str          # "leap (jeté-type)" | "jump (sauté-type)"
    split_angle_deg: float
    takeoff_ts_ms: int
    apex_ts_ms:    int
    landing_ts_ms: int


@dataclass
class TurnEvent:
    start_frame:    int
    end_frame:      int
    rotation_count: float
    supporting_leg: str   # "L" | "R"
    working_leg:    str   # "R" | "L"
    start_ts_ms:    int
    end_ts_ms:      int


@dataclass
class ArabesqueEvent:
    start_frame:    int
    end_frame:      int
    peak_frame:     int   # frame of highest working-ankle world-Y elevation
    working_leg:    str   # "L" | "R"
    supporting_leg: str
    start_ts_ms:    int
    end_ts_ms:      int
    peak_ts_ms:     int


# ---------------------------------------------------------------------------
# Shared shoulder-rotation signal
# ---------------------------------------------------------------------------

def _shoulder_signal(world_lm: np.ndarray, fps: float):
    """Return (theta_deg, omega_deg_s, spinning_mask) from shoulder vector.

    spinning_mask: True where |omega| >= 180 deg/s (pirouette-speed rotation).
    """
    N = len(world_lm)
    r_sh = world_lm[:, 12, :]
    l_sh = world_lm[:, 11, :]
    vec_x = r_sh[:, 0] - l_sh[:, 0]
    vec_z = r_sh[:, 2] - l_sh[:, 2]
    theta_raw      = np.arctan2(vec_z, vec_x)
    theta_filtered = median_filter1d(theta_raw, window=5)
    theta_unwrapped = np.unwrap(theta_filtered)
    theta_deg = np.degrees(theta_unwrapped)

    omega = np.zeros(N)
    omega[1:-1] = (theta_deg[2:] - theta_deg[:-2]) / (2.0 / fps)
    omega[0]    = omega[1]
    omega[-1]   = omega[-2]

    spinning = np.abs(omega) >= 180.0
    spinning[:min(10, N)] = False   # first 10 frames: tracker warmup
    return theta_deg, omega, spinning


# ---------------------------------------------------------------------------
# Jump / leap detection
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Floor contact + leap classification (shared by detect_jumps / detect_compound_jumps)
#
# Kept in step with frontend/lib/live/jumpDetector.ts -- same gates, same bars.
# ---------------------------------------------------------------------------

_FOOT_POINTS = {"L": (27, 29, 31), "R": (28, 30, 32)}   # ankle, heel, toe
_VIS_T = 0.5

FLOOR_CLEAR_RATIO      = 0.03   # lowest foot point must clear the floor by this x body_scale
MIN_FLOOR_CLEAR_FRAMES = 2
LEAP_MIN_SPLIT_DEG     = 35.0   # angle BETWEEN the legs (hip->ankle directions)
LEAP_SEP_IMAGE         = 0.35   # |ankle dx| / body_scale
LEAP_SEP_WORLD         = 0.60   # ankle distance in the horizontal plane / leg length
LEAP_MIN_KNEE_DEG      = 140.0  # the STRAIGHTER knee (a tuck folds both)
LEAP_LANDING_EXCLUDE   = 0.30   # closing the legs to land is correct, so not sampled


def _lowest_foot_y(image_lm: np.ndarray) -> np.ndarray:
    """Per-frame image y of the lowest visible point of EITHER foot (y grows downward).

    NaN where either foot is unreadable: with one foot unseen there is no telling whether it
    is the one still on the floor.
    """
    N = len(image_lm)
    per_side = []
    for ids in _FOOT_POINTS.values():
        ys = np.where(image_lm[:, ids, 3] >= _VIS_T, image_lm[:, ids, 1], np.nan)
        all_nan = np.all(np.isnan(ys), axis=1)
        side = np.full(N, np.nan)
        side[~all_nan] = np.nanmax(ys[~all_nan], axis=1)
        per_side.append(side)
    lowest = np.fmax(per_side[0], per_side[1])
    lowest[np.isnan(per_side[0]) | np.isnan(per_side[1])] = np.nan
    return lowest


def _floor_rise(image_lm: np.ndarray, fps: float) -> np.ndarray:
    """How far the lowest foot point sits above its own trailing floor baseline, per frame."""
    lowest = _lowest_foot_y(image_lm)
    filled = lowest.copy()
    # The baseline only learns from readable frames; carry the last readable value through gaps.
    last = np.nan
    for t in range(len(filled)):
        if np.isnan(filled[t]):
            filled[t] = last
        else:
            last = filled[t]
    if np.all(np.isnan(filled)):
        return np.full(len(lowest), np.nan)
    first = filled[~np.isnan(filled)][0]
    filled = np.where(np.isnan(filled), first, filled)
    baseline = compute_rolling_baseline(filled, fps=fps, window_sec=2.0)
    return baseline - lowest


def _feet_left_floor(floor_rise: np.ndarray, i: int, j: int, body_scale: float) -> bool:
    """THE FLOOR GATE: did the lowest point of the feet actually leave the floor?

    A hip rise alone cannot say. A releve raises the hips with the toes planted, and an
    arabesque raises one ankle a long way -- an arabesque on releve passes every hip and
    ankle test with the supporting foot flat on the floor, and its legs really are split,
    so it used to read as a leap.  In every one of those the supporting toes stay down.
    """
    seg = floor_rise[i:j]
    return int(np.sum(seg >= FLOOR_CLEAR_RATIO * body_scale)) >= MIN_FLOOR_CLEAR_FRAMES


def _leg_vec(lm: np.ndarray, t: int, hip: int, ankle: int, use_z: bool) -> np.ndarray:
    v = lm[t, ankle, :3] - lm[t, hip, :3]
    if not use_z:
        v = v.copy()
        v[2] = 0.0
    return v


def _inter_leg_deg(lm: np.ndarray, t: int, use_z: bool) -> float:
    a = _leg_vec(lm, t, 23, 27, use_z)
    b = _leg_vec(lm, t, 24, 28, use_z)
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(np.degrees(np.arccos(np.clip(a @ b / (na * nb), -1.0, 1.0))))


def _classify_leap(
    image_lm: np.ndarray,
    world_lm: Optional[np.ndarray],
    floor_rise: np.ndarray,
    i: int,
    j: int,
    body_scale: float,
) -> tuple[bool, int]:
    """Leap vs jump over the flight, not one apex frame. Returns (is_leap, widest_frame).

    The old test was the 2-D angle at the hip midpoint between the ankles, on the single
    hip-apex frame, against a 100 degree bar.  The hip apex is often not where the legs are
    widest, one frame is one landmark blip from either answer, and 100 degrees there is a
    big split -- real leaps routinely came out as jumps.  This mirrors the live detector:

      - only frames with the feet genuinely off the floor, before the landing, may vote;
      - the split must be WIDE (separation) and SHAPED like a split (angle between the legs,
        which a tuck or a wide stance cannot fake) and have at least one straight leg;
      - world and image landmarks each get a vote, because world depth is MediaPipe's weakest
        axis and compresses a split filmed across the frame, while the image plane cannot see
        a split aimed at the lens.
    """
    end = i + max(1, int(round((j - i) * (1.0 - LEAP_LANDING_EXCLUDE))))
    frames = list(range(i, end))
    rises = floor_rise[i:end]
    peak = float(np.nanmax(rises)) if np.any(~np.isnan(rises)) else 0.0
    floor = max(0.5 * peak, 0.04 * body_scale)
    airborne = [t for t in frames if not np.isnan(floor_rise[t]) and floor_rise[t] >= floor]
    if len(airborne) >= 2:
        frames = airborne

    def sep_score(t: int) -> float:
        score = 0.0
        if all(image_lm[t, k, 3] >= _VIS_T for k in (27, 28)):
            score = abs(image_lm[t, 27, 0] - image_lm[t, 28, 0]) / body_scale / LEAP_SEP_IMAGE
        if world_lm is not None:
            w = world_lm[t]
            leg = (np.linalg.norm(w[23, :3] - w[25, :3]) + np.linalg.norm(w[25, :3] - w[27, :3])
                   + np.linalg.norm(w[24, :3] - w[26, :3]) + np.linalg.norm(w[26, :3] - w[28, :3])) / 2
            if leg > 1e-6:
                d = w[27, :3] - w[28, :3]
                score = max(score, float(np.hypot(d[0], d[2])) / leg / LEAP_SEP_WORLD)
        return score

    def split_deg(t: int) -> float:
        best = _inter_leg_deg(image_lm, t, use_z=False)
        if world_lm is not None:
            best = max(best, _inter_leg_deg(world_lm, t, use_z=True))
        return best

    def straightest_knee(t: int) -> float:
        vals = []
        for lm, use in ((world_lm, world_lm is not None), (image_lm, True)):
            if not use:
                continue
            for h, k, a in ((23, 25, 27), (24, 26, 28)):
                if lm is image_lm and not all(image_lm[t, x, 3] >= _VIS_T for x in (h, k, a)):
                    continue
                dims = slice(0, 3) if lm is world_lm else slice(0, 2)
                ang = angle_at(lm[t, k, dims], lm[t, h, dims], lm[t, a, dims])
                if not np.isnan(ang):
                    vals.append(ang)
        return max(vals) if vals else float("nan")

    scores = [sep_score(t) for t in frames]
    widest = frames[int(np.argmax(scores))]
    knees = [k for k in (straightest_knee(t) for t in frames) if not np.isnan(k)]
    is_leap = (
        float(np.median(scores)) >= 1.0
        and float(np.median([split_deg(t) for t in frames])) >= LEAP_MIN_SPLIT_DEG
        and bool(knees) and float(np.median(knees)) >= LEAP_MIN_KNEE_DEG
    )
    return is_leap, widest


def _hip_mid_split_angle(image_lm: np.ndarray, t: int) -> float:
    """The reported (and scored) split_angle: 2-D angle at the hip midpoint between ankles."""
    hip_mid_2d = (image_lm[t, 23, :2] + image_lm[t, 24, :2]) / 2.0
    ang = angle_at(hip_mid_2d, image_lm[t, 27, :2], image_lm[t, 28, :2])
    return 0.0 if np.isnan(ang) else ang


def detect_jumps(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
    world_lm: Optional[np.ndarray] = None,
) -> list[JumpEvent]:
    """Detect jumps and leaps from smoothed image landmarks.

    If world_lm is provided, segments with concurrent shoulder rotation
    (spinning_overlap_fraction > 0.20) are rejected as turns, not jumps.  A hip rise in which
    the feet never leave the floor (a releve, an arabesque, a battement) is not a jump of any
    kind and produces no event -- see _feet_left_floor.
    """
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    # Hip midpoint y (y increases downward in image coords)
    hip_mid_y = (image_lm[:, 23, 1] + image_lm[:, 24, 1]) / 2.0
    baseline  = compute_rolling_baseline(hip_mid_y, fps=fps, window_sec=2.0)

    threshold = 0.06 * body_scale
    airborne  = (baseline - hip_mid_y) > threshold
    floor_rise = _floor_rise(image_lm, fps)

    # Optional spinning mask to filter out turn-type segments
    spinning_mask: Optional[np.ndarray] = None
    if world_lm is not None:
        _, _, spinning_mask = _shoulder_signal(world_lm, fps)

    events: list[JumpEvent] = []
    i = 0
    while i < N:
        if not airborne[i]:
            i += 1
            continue
        j = i
        while j < N and airborne[j]:
            j += 1
        duration = j - i

        if duration >= 4:
            # Reject if shoulder is actively spinning (this is a turn, not a jump)
            if spinning_mask is not None:
                spin_frac = float(np.mean(spinning_mask[i:j]))
                if spin_frac > 0.20:
                    i = j
                    continue

            if not _feet_left_floor(floor_rise, i, j, body_scale):
                i = j
                continue

            rise      = baseline[i:j] - hip_mid_y[i:j]
            apex_rel  = int(np.argmax(rise))
            apex_frame = i + apex_rel

            is_leap, widest = _classify_leap(image_lm, world_lm, floor_rise, i, j, body_scale)
            split_angle = _hip_mid_split_angle(image_lm, widest)
            jump_type = "leap (jeté-type)" if is_leap else "jump (sauté-type)"

            events.append(JumpEvent(
                takeoff_frame=i,
                apex_frame=apex_frame,
                landing_frame=j - 1,
                type=jump_type,
                split_angle_deg=split_angle,
                takeoff_ts_ms=int(timestamps_ms[i]),
                apex_ts_ms=int(timestamps_ms[apex_frame]),
                landing_ts_ms=int(timestamps_ms[j - 1]),
            ))
        i = j

    return events


# ---------------------------------------------------------------------------
# Turn / pirouette detection
# ---------------------------------------------------------------------------

def detect_turns(
    world_lm: np.ndarray,
    fps: float,
    body_scale: float,
    image_lm: Optional[np.ndarray] = None,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[TurnEvent]:
    """Detect turns from two complementary signals:

    1. Shoulder-rotation speed (classical pirouette signal, after valley-splitting).
    2. Hip-elevation + spinning concurrence (catches à la seconde and relevé-based turns
       that the shoulder signal might merge into one long artifact segment).

    Results from both are merged and deduplicated by temporal overlap.
    """
    N = len(world_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)
    if image_lm is None:
        image_lm = world_lm

    theta_deg, omega, spinning = _shoulder_signal(world_lm, fps)
    spinning_merged = _merge_gaps(spinning.copy(), max_gap=5)

    turns_shoulder  = _turns_from_shoulder(theta_deg, omega, spinning_merged, image_lm,
                                            fps, timestamps_ms)
    turns_elevation = _turns_from_elevation(image_lm, world_lm, theta_deg, spinning,
                                             fps, body_scale, timestamps_ms)

    all_turns = _deduplicate(turns_shoulder + turns_elevation)
    return sorted(all_turns, key=lambda t: t.start_frame)


# ---------------------------------------------------------------------------
# Turn source 1: shoulder rotation speed
# ---------------------------------------------------------------------------

def _turns_from_shoulder(
    theta_deg, omega, spinning, image_lm, fps, timestamps_ms
) -> list[TurnEvent]:
    """Classical pirouette detection on shoulder angular velocity.

    Long spinning segments (> 1.5 s) are split at omega valleys to separate
    individual turns. The >90%-of-video artifact filter is replaced by this.
    """
    N = len(theta_deg)
    events: list[TurnEvent] = []

    i = 0
    while i < N:
        if not spinning[i]:
            i += 1
            continue
        j = i
        while j < N and spinning[j]:
            j += 1

        # Split long segments only at genuine prep plié valleys
        sub_segs = _valley_split(i, j, omega, fps,
                                  valley_omega=90.0, min_valley_frames=3,
                                  image_lm=image_lm)

        for seg_s, seg_e in sub_segs:
            delta = abs(theta_deg[seg_e] - theta_deg[seg_s])
            if delta >= 300.0:
                rot = round(delta / 180.0) * 0.5
                ev  = _make_turn(seg_s, seg_e, rot, image_lm, timestamps_ms)
                events.append(ev)

        i = j

    return events


# ---------------------------------------------------------------------------
# Turn source 2: hip elevation + spinning (catches à la seconde / relevé turns)
# ---------------------------------------------------------------------------

def _turns_from_elevation(
    image_lm, world_lm, theta_deg, spinning, fps, body_scale, timestamps_ms
) -> list[TurnEvent]:
    """Detect turns where the dancer rises onto relevé (hip elevation) while spinning.

    Uses a slightly lower hip-rise threshold than jump detection (0.04 × body_scale
    vs 0.06) so soft relevé turns are caught. The hip-elevation window itself is used
    to segment individual turns within what might be one long shoulder-spin segment.
    """
    N = len(image_lm)
    hip_y    = (image_lm[:, 23, 1] + image_lm[:, 24, 1]) / 2.0
    baseline = compute_rolling_baseline(hip_y, fps=fps, window_sec=2.0)

    # Slightly lower threshold than jump detection to catch relevé turns
    threshold = 0.04 * body_scale
    elevated  = (baseline - hip_y) > threshold

    events: list[TurnEvent] = []
    i = 0
    while i < N:
        if not elevated[i]:
            i += 1
            continue
        j = i
        while j < N and elevated[j]:
            j += 1
        duration = j - i

        if duration >= 4:
            spin_frac = float(np.mean(spinning[i:j]))
            if spin_frac > 0.20:   # at least 20 % of elevation frames are spinning
                delta = abs(theta_deg[j - 1] - theta_deg[i])
                if delta >= 120.0:   # at least 1/3 rotation
                    rot = max(0.5, round(delta / 180.0) * 0.5)
                    ev  = _make_turn(i, j - 1, rot, image_lm, timestamps_ms)
                    events.append(ev)
        i = j

    return events


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_turn(start, end, rotation_count, image_lm, timestamps_ms) -> TurnEvent:
    # The foot that sits LOWER across the turn. The first frame alone is often still the
    # preparation, with both feet down and either one marginally lower.
    l_ankle_y = float(np.median(image_lm[start:end + 1, 27, 1]))
    r_ankle_y = float(np.median(image_lm[start:end + 1, 28, 1]))
    if l_ankle_y >= r_ankle_y:
        supporting_leg, working_leg = "L", "R"
    else:
        supporting_leg, working_leg = "R", "L"
    return TurnEvent(
        start_frame=start,
        end_frame=end,
        rotation_count=rotation_count,
        supporting_leg=supporting_leg,
        working_leg=working_leg,
        start_ts_ms=int(timestamps_ms[start]),
        end_ts_ms=int(timestamps_ms[end]),
    )


def _has_prep_dip(i: int, j: int, image_lm: np.ndarray) -> bool:
    """Return True if frames i:j contain a clear prep plié (supporting knee < 150°).

    Used to distinguish a genuine preparation between rotations from a natural
    velocity dip during continuous à la seconde or multi-pirouette sequences.
    """
    VIS_T = 0.5
    for t in range(i, min(j, len(image_lm))):
        l_ankle_y = image_lm[t, 27, 1]
        r_ankle_y = image_lm[t, 28, 1]
        if l_ankle_y >= r_ankle_y:
            knee_id, hip_id, ankle_id = 25, 23, 27
        else:
            knee_id, hip_id, ankle_id = 26, 24, 28
        if not all(image_lm[t, jid, 3] >= VIS_T for jid in [knee_id, hip_id, ankle_id]):
            continue
        knee_ang = angle_at(
            image_lm[t, knee_id, :2],
            image_lm[t, hip_id, :2],
            image_lm[t, ankle_id, :2],
        )
        if not np.isnan(knee_ang) and knee_ang < 150.0:
            return True
    return False


def _valley_split(
    seg_start: int, seg_end: int,
    omega: np.ndarray,
    fps: float,
    valley_omega: float = 90.0,
    min_valley_frames: int = 3,
    image_lm: Optional[np.ndarray] = None,
) -> list[tuple[int, int]]:
    """Split a spinning segment into sub-segments at low-omega valleys.

    Only attempts splitting if the segment is longer than 1.5 s AND if the
    valley contains a clear prep plié (supporting-knee bend).  This prevents
    splitting continuous à la seconde or multi-pirouette sequences at natural
    velocity oscillations.
    """
    MIN_LONG = int(1.5 * fps)
    if seg_end - seg_start < MIN_LONG:
        return [(seg_start, seg_end)]

    sub_segs: list[tuple[int, int]] = []
    current_start = seg_start
    i = seg_start

    while i < seg_end:
        if abs(omega[i]) < valley_omega:
            j = i
            while j < seg_end and abs(omega[j]) < valley_omega:
                j += 1
            if j - i >= min_valley_frames:
                # Only split at a genuine preparation (plié dip), not a natural
                # velocity oscillation during continuous rotation.
                if image_lm is None or _has_prep_dip(i, j, image_lm):
                    if current_start < i:
                        sub_segs.append((current_start, i - 1))
                    current_start = j
            i = j if j > i else i + 1
        else:
            i += 1

    if current_start < seg_end:
        sub_segs.append((current_start, seg_end))

    return sub_segs if sub_segs else [(seg_start, seg_end)]


def _deduplicate(events: list[TurnEvent]) -> list[TurnEvent]:
    """Remove TurnEvents that overlap with a higher-confidence duplicate.

    When two events overlap by > 50 % of the shorter one's duration,
    keep only the one with the higher rotation_count (more informative).
    """
    events = sorted(events, key=lambda e: e.start_frame)
    kept: list[TurnEvent] = []
    for ev in events:
        if not kept:
            kept.append(ev)
            continue
        prev = kept[-1]
        overlap_start = max(prev.start_frame, ev.start_frame)
        overlap_end   = min(prev.end_frame,   ev.end_frame)
        overlap_len   = max(0, overlap_end - overlap_start + 1)
        shorter_len   = min(prev.end_frame - prev.start_frame + 1,
                            ev.end_frame  - ev.start_frame  + 1)
        if shorter_len > 0 and overlap_len / shorter_len > 0.50:
            # Keep the one with more rotations (or the longer one on tie)
            if ev.rotation_count >= prev.rotation_count:
                kept[-1] = ev
        else:
            kept.append(ev)
    return kept


def _pt3(lm: np.ndarray, frame: int, jid: int) -> np.ndarray:
    """Return (x, y, z) world-coord point. Mirrors the helper of the same name in metrics.py."""
    return lm[frame, jid, :3]


def _merge_gaps(mask: np.ndarray, max_gap: int) -> np.ndarray:
    """Fill gaps of ≤ max_gap False values between True regions."""
    out = mask.copy()
    N = len(mask)
    i = 0
    while i < N:
        if mask[i]:
            i += 1
            continue
        j = i
        while j < N and not mask[j]:
            j += 1
        gap = j - i
        if gap <= max_gap:
            left_ok  = i > 0 and mask[i - 1]
            right_ok = j < N and mask[j]
            if left_ok and right_ok:
                out[i:j] = True
        i = j if j > i else i + 1
    return out


# ---------------------------------------------------------------------------
# Arabesque / single-leg-hold detection
# ---------------------------------------------------------------------------

def _arabesque_angle(
    world_lm: np.ndarray, t: int, work_ankle_id: int, work_hip_id: int,
) -> tuple[float, float]:
    """(arabesque angle in degrees, supporting-ankle gap in torso lengths) at frame t.

    Module level because detect_grand_battements needs it too. It used to be nested inside
    detect_arabesques, so the battement L/R dedupe raised NameError whenever both sides
    produced overlapping candidates.
    """
    shoulder_mid = (_pt3(world_lm, t, 11) + _pt3(world_lm, t, 12)) / 2.0
    hip_l, hip_r = _pt3(world_lm, t, 23), _pt3(world_lm, t, 24)
    hip_mid      = (hip_l + hip_r) / 2.0
    torso        = float(np.linalg.norm(shoulder_mid - hip_mid))
    if torso <= 1e-6:
        return -180.0, 0.0
    up_sign  = np.sign(shoulder_mid[1] - hip_mid[1]) or -1.0
    down     = np.array([0.0, -up_sign, 0.0])
    right    = np.array([hip_r[0] - hip_l[0], 0.0, hip_r[2] - hip_l[2]])
    rn       = float(np.linalg.norm(right))
    right    = right / rn if rn > 1e-9 else np.array([1.0, 0.0, 0.0])
    backward = np.cross(down, right)   # right-handed body frame; see compute_arabesque_metrics
    leg      = _pt3(world_lm, t, work_ankle_id) - _pt3(world_lm, t, work_hip_id)
    deg      = float(np.degrees(np.arctan2(float(leg @ backward), float(leg @ down))))
    supp_id  = 28 if work_ankle_id == 27 else 27
    gap      = float((hip_mid[1] - world_lm[t, supp_id, 1]) * up_sign) / torso
    return deg, gap


def detect_arabesques(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[ArabesqueEvent]:
    """Detect arabesque holds: the working leg raised behind the dancer, the other grounded.

    Gated on the ARABESQUE ANGLE -- degrees the working leg is raised behind, 0 standing and
    90 horizontal -- the same quantity compute_arabesque_metrics scores as arabesque_height
    and the same one the streaming port in frontend/lib/live/arabesqueDetector.ts uses.

    This replaced "working ankle >= 8 cm above the hip midpoint", which had three problems.
    It only admitted arabesques above roughly 95 degrees, so a textbook 90 degree arabesque
    was never detected at all.  Being an absolute distance, it meant a different position on
    a child than on an adult, and this app is for kids.  And it read world Y as positive-up
    while MediaPipe documents Y positive-DOWN, with nothing in this repo verifying either --
    under Y-down the supporting-ankle test can never pass, so the mask would be empty and
    this function would never fire.  The angle below takes its axes from the BODY, so it is
    agnostic about the Y convention and about where the camera is.

    Front and side extensions score negative and near zero respectively, so a developpe is
    not admitted as a low arabesque.
    """
    N = len(world_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    MIN_ARABESQUE_DEG = 40.0   # keep in step with minArabesqueDeg in the streaming port
    SUPP_GROUND_RATIO = 0.8    # supporting ankle this many torso lengths below the hips
    MIN_FRAMES  = max(4, int(0.25 * fps))

    candidates: list[ArabesqueEvent] = []

    def _arabesque_deg(t: int, work_ankle_id: int, work_hip_id: int) -> tuple[float, float]:
        return _arabesque_angle(world_lm, t, work_ankle_id, work_hip_id)

    for work_side, work_ankle_id, supp_ankle_id in [("L", 27, 28), ("R", 28, 27)]:
        work_hip_id = 23 if work_side == "L" else 24
        mask = np.zeros(N, dtype=bool)
        for t in range(N):
            deg, gap = _arabesque_deg(t, work_ankle_id, work_hip_id)
            if deg < MIN_ARABESQUE_DEG:
                continue
            if gap < SUPP_GROUND_RATIO:
                continue   # supporting foot off the floor (jump) or poor tracking
            mask[t] = True

        mask = _merge_gaps(mask, max_gap=4)

        i = 0
        while i < N:
            if not mask[i]:
                i += 1
                continue
            j = i
            while j < N and mask[j]:
                j += 1
            if j - i >= MIN_FRAMES:
                # Peak = highest ARABESQUE ANGLE, not the largest raw world Y: raw Y is
                # upside-down under the Y-down convention, so argmax picked the LOWEST frame.
                segment = [_arabesque_deg(t, work_ankle_id, work_hip_id)[0] for t in range(i, j)]
                peak    = i + int(np.argmax(segment))
                candidates.append(ArabesqueEvent(
                    start_frame=i,
                    end_frame=j - 1,
                    peak_frame=peak,
                    working_leg=work_side,
                    supporting_leg="R" if work_side == "L" else "L",
                    start_ts_ms=int(timestamps_ms[i]),
                    end_ts_ms=int(timestamps_ms[j - 1]),
                    peak_ts_ms=int(timestamps_ms[peak]),
                ))
            i = j

    # Deduplicate overlapping L/R detections — keep the one with the higher peak elevation
    candidates.sort(key=lambda e: e.start_frame)
    deduped: list[ArabesqueEvent] = []
    for ev in candidates:
        if deduped:
            prev = deduped[-1]
            overlap = min(prev.end_frame, ev.end_frame) - max(prev.start_frame, ev.start_frame)
            if overlap >= 0:
                prev_deg = _arabesque_deg(
                    prev.peak_frame,
                    27 if prev.working_leg == "L" else 28,
                    23 if prev.working_leg == "L" else 24,
                )[0]
                ev_deg = _arabesque_deg(
                    ev.peak_frame,
                    27 if ev.working_leg == "L" else 28,
                    23 if ev.working_leg == "L" else 24,
                )[0]
                if ev_deg > prev_deg:
                    deduped[-1] = ev
                continue
        deduped.append(ev)

    return deduped


# ---------------------------------------------------------------------------
# New dataclasses for Phase 1 remaining moves
# ---------------------------------------------------------------------------

@dataclass
class PliéEvent:
    start_frame: int
    end_frame:   int
    peak_frame:  int   # frame of deepest knee bend
    start_ts_ms: int
    end_ts_ms:   int
    peak_ts_ms:  int


@dataclass
class RelevéEvent:
    start_frame: int
    end_frame:   int
    peak_frame:  int   # frame of highest heel elevation
    start_ts_ms: int
    end_ts_ms:   int
    peak_ts_ms:  int


@dataclass
class TiltEvent:
    start_frame: int
    end_frame:   int
    peak_frame:  int   # frame of maximum tilt angle
    start_ts_ms: int
    end_ts_ms:   int
    peak_ts_ms:  int


# ---------------------------------------------------------------------------
# Grand battement detection (brief arabesque-like signal)
# ---------------------------------------------------------------------------

def detect_grand_battements(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[ArabesqueEvent]:
    """Detect grand battements: brief (< 0.7 s) ankle elevations above hip.

    Reuses the ArabesqueEvent dataclass.  Same signal as arabesques but
    only keeps segments shorter than int(0.7 * fps) frames (the brief kick).
    """
    N = len(world_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    ELEV_THRESH  = 0.08    # working ankle ≥ 8 cm above hip midpoint
    SUPP_FLOOR   = -0.10   # supporting ankle clearly grounded
    MAX_FRAMES   = int(0.7 * fps)
    MIN_FRAMES   = 2

    candidates: list[ArabesqueEvent] = []

    for work_side, work_ankle_id, supp_ankle_id in [("L", 27, 28), ("R", 28, 27)]:
        mask = np.zeros(N, dtype=bool)
        for t in range(N):
            hip_y = (world_lm[t, 23, 1] + world_lm[t, 24, 1]) / 2.0
            if world_lm[t, work_ankle_id, 1] < hip_y + ELEV_THRESH:
                continue
            if world_lm[t, supp_ankle_id, 1] > SUPP_FLOOR:
                continue
            mask[t] = True

        mask = _merge_gaps(mask, max_gap=3)

        i = 0
        while i < N:
            if not mask[i]:
                i += 1
                continue
            j = i
            while j < N and mask[j]:
                j += 1
            duration = j - i
            # Brief kick only
            if MIN_FRAMES <= duration < MAX_FRAMES:
                seg_y = world_lm[i:j, work_ankle_id, 1]
                peak  = i + int(np.argmax(seg_y))
                candidates.append(ArabesqueEvent(
                    start_frame=i,
                    end_frame=j - 1,
                    peak_frame=peak,
                    working_leg=work_side,
                    supporting_leg="R" if work_side == "L" else "L",
                    start_ts_ms=int(timestamps_ms[i]),
                    end_ts_ms=int(timestamps_ms[j - 1]),
                    peak_ts_ms=int(timestamps_ms[peak]),
                ))
            i = j

    # Deduplicate overlapping L/R detections
    candidates.sort(key=lambda e: e.start_frame)
    deduped: list[ArabesqueEvent] = []
    for ev in candidates:
        if deduped:
            prev = deduped[-1]
            overlap = min(prev.end_frame, ev.end_frame) - max(prev.start_frame, ev.start_frame)
            if overlap >= 0:
                prev_deg = _arabesque_angle(
                    world_lm, prev.peak_frame,
                    27 if prev.working_leg == "L" else 28,
                    23 if prev.working_leg == "L" else 24,
                )[0]
                ev_deg = _arabesque_angle(
                    world_lm, ev.peak_frame,
                    27 if ev.working_leg == "L" else 28,
                    23 if ev.working_leg == "L" else 24,
                )[0]
                if ev_deg > prev_deg:
                    deduped[-1] = ev
                continue
        deduped.append(ev)

    return deduped


# ---------------------------------------------------------------------------
# Plié detection
# ---------------------------------------------------------------------------

def detect_plies(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[PliéEvent]:
    """Detect plié holds: bilateral knee bend below 155 degrees."""
    from utils.geometry import angle_at as _angle_at
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    VIS_T = 0.5
    MIN_HOLD = max(4, int(0.2 * fps))

    # Joint ids: L_HIP=23, L_KNEE=25, L_ANKLE=27, R_HIP=24, R_KNEE=26, R_ANKLE=28
    mask = np.zeros(N, dtype=bool)
    bilateral_flex = np.full(N, 180.0)

    for t in range(N):
        # Check all 6 joints visible
        ids = [23, 25, 27, 24, 26, 28]
        if not all(image_lm[t, jid, 3] >= VIS_T for jid in ids):
            continue
        l_knee_ang = _angle_at(
            image_lm[t, 25, :2],
            image_lm[t, 23, :2],
            image_lm[t, 27, :2],
        )
        r_knee_ang = _angle_at(
            image_lm[t, 26, :2],
            image_lm[t, 24, :2],
            image_lm[t, 28, :2],
        )
        if np.isnan(l_knee_ang) or np.isnan(r_knee_ang):
            continue
        avg = (l_knee_ang + r_knee_ang) / 2.0
        bilateral_flex[t] = avg
        if avg < 155.0:
            mask[t] = True

    mask = _merge_gaps(mask, max_gap=3)

    events: list[PliéEvent] = []
    i = 0
    while i < N:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < N and mask[j]:
            j += 1
        duration = j - i
        if duration >= MIN_HOLD:
            peak = i + int(np.argmin(bilateral_flex[i:j]))
            events.append(PliéEvent(
                start_frame=i,
                end_frame=j - 1,
                peak_frame=peak,
                start_ts_ms=int(timestamps_ms[i]),
                end_ts_ms=int(timestamps_ms[j - 1]),
                peak_ts_ms=int(timestamps_ms[peak]),
            ))
        i = j

    return events


# ---------------------------------------------------------------------------
# Relevé detection
# ---------------------------------------------------------------------------

def detect_releves(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[RelevéEvent]:
    """Detect relevé holds: both heels elevated above foot index."""
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    # L_HEEL=29, L_FOOT=31, R_HEEL=30, R_FOOT=32
    MIN_HOLD = max(4, int(0.3 * fps))

    mask = np.zeros(N, dtype=bool)
    avg_releve = np.zeros(N)

    for t in range(N):
        # Need heel and foot visible for both sides
        l_heel_h = (image_lm[t, 31, 1] - image_lm[t, 29, 1]) / body_scale  # foot_y - heel_y
        r_heel_h = (image_lm[t, 32, 1] - image_lm[t, 30, 1]) / body_scale
        avg_releve[t] = (l_heel_h + r_heel_h) / 2.0
        if l_heel_h > 0.015 and r_heel_h > 0.015:
            mask[t] = True

    mask = _merge_gaps(mask, max_gap=3)

    events: list[RelevéEvent] = []
    i = 0
    while i < N:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < N and mask[j]:
            j += 1
        duration = j - i
        if duration >= MIN_HOLD:
            peak = i + int(np.argmax(avg_releve[i:j]))
            events.append(RelevéEvent(
                start_frame=i,
                end_frame=j - 1,
                peak_frame=peak,
                start_ts_ms=int(timestamps_ms[i]),
                end_ts_ms=int(timestamps_ms[j - 1]),
                peak_ts_ms=int(timestamps_ms[peak]),
            ))
        i = j

    return events


# ---------------------------------------------------------------------------
# Tilt / layout / hinge detection
# ---------------------------------------------------------------------------

def detect_tilts(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[TiltEvent]:
    """Detect extreme torso tilts held >= 0.25 s."""
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    VIS_T    = 0.5
    MIN_HOLD = max(4, int(0.25 * fps))
    # L_SHOULDER=11, R_SHOULDER=12, L_HIP=23, R_HIP=24
    mask       = np.zeros(N, dtype=bool)
    tilt_angle = np.zeros(N)

    for t in range(N):
        if not all(image_lm[t, jid, 3] >= VIS_T for jid in [11, 12, 23, 24]):
            continue
        sh_mid = (image_lm[t, 11, :2] + image_lm[t, 12, :2]) / 2.0
        hp_mid = (image_lm[t, 23, :2] + image_lm[t, 24, :2]) / 2.0
        torso  = sh_mid - hp_mid
        norm   = float(np.linalg.norm(torso))
        if norm < 1e-9:
            continue
        upward = np.array([0.0, -1.0])
        cos_a  = float(np.clip(np.dot(torso / norm, upward), -1.0, 1.0))
        angle  = float(np.degrees(np.arccos(cos_a)))
        tilt_angle[t] = angle
        if angle > 40.0:
            mask[t] = True

    mask = _merge_gaps(mask, max_gap=4)

    events: list[TiltEvent] = []
    i = 0
    while i < N:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < N and mask[j]:
            j += 1
        duration = j - i
        if duration >= MIN_HOLD:
            peak = i + int(np.argmax(tilt_angle[i:j]))
            events.append(TiltEvent(
                start_frame=i,
                end_frame=j - 1,
                peak_frame=peak,
                start_ts_ms=int(timestamps_ms[i]),
                end_ts_ms=int(timestamps_ms[j - 1]),
                peak_ts_ms=int(timestamps_ms[peak]),
            ))
        i = j

    return events


# ---------------------------------------------------------------------------
# Compound jump detection (spinning fraction 0.20 – 0.80)
# ---------------------------------------------------------------------------

def detect_compound_jumps(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[JumpEvent]:
    """Detect compound jumps: airborne segments with moderate spinning (tour jeté, calypso).

    Accepts segments where spinning_fraction is 0.20 – 0.80 (the ones
    that detect_jumps rejects as turns, but are clearly in the air).
    """
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    hip_mid_y = (image_lm[:, 23, 1] + image_lm[:, 24, 1]) / 2.0
    baseline  = compute_rolling_baseline(hip_mid_y, fps=fps, window_sec=2.0)

    threshold = 0.06 * body_scale
    airborne  = (baseline - hip_mid_y) > threshold

    _, _, spinning_mask = _shoulder_signal(world_lm, fps)
    floor_rise = _floor_rise(image_lm, fps)

    events: list[JumpEvent] = []
    i = 0
    while i < N:
        if not airborne[i]:
            i += 1
            continue
        j = i
        while j < N and airborne[j]:
            j += 1
        duration = j - i

        if duration >= 4:
            spin_frac = float(np.mean(spinning_mask[i:j]))
            # Accept compound jumps: moderate spinning fraction
            if 0.20 <= spin_frac <= 0.80 and _feet_left_floor(floor_rise, i, j, body_scale):
                rise       = baseline[i:j] - hip_mid_y[i:j]
                apex_rel   = int(np.argmax(rise))
                apex_frame = i + apex_rel

                hip_mid_2d = np.array([
                    (image_lm[apex_frame, 23, 0] + image_lm[apex_frame, 24, 0]) / 2,
                    (image_lm[apex_frame, 23, 1] + image_lm[apex_frame, 24, 1]) / 2,
                ])
                l_ankle = image_lm[apex_frame, 27, :2]
                r_ankle = image_lm[apex_frame, 28, :2]
                split_angle = angle_at(hip_mid_2d, l_ankle, r_ankle)
                if np.isnan(split_angle):
                    split_angle = 0.0

                events.append(JumpEvent(
                    takeoff_frame=i,
                    apex_frame=apex_frame,
                    landing_frame=j - 1,
                    type="compound jump (spinning)",
                    split_angle_deg=split_angle,
                    takeoff_ts_ms=int(timestamps_ms[i]),
                    apex_ts_ms=int(timestamps_ms[apex_frame]),
                    landing_ts_ms=int(timestamps_ms[j - 1]),
                ))
        i = j

    return events
