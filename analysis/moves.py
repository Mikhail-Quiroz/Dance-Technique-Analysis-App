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

def detect_jumps(
    image_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
    world_lm: Optional[np.ndarray] = None,
) -> list[JumpEvent]:
    """Detect jumps and leaps from smoothed image landmarks.

    If world_lm is provided, segments with concurrent shoulder rotation
    (spinning_overlap_fraction > 0.20) are rejected as turns, not jumps.
    """
    N = len(image_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    # Hip midpoint y (y increases downward in image coords)
    hip_mid_y = (image_lm[:, 23, 1] + image_lm[:, 24, 1]) / 2.0
    baseline  = compute_rolling_baseline(hip_mid_y, fps=fps, window_sec=2.0)

    threshold = 0.06 * body_scale
    airborne  = (baseline - hip_mid_y) > threshold

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

            rise      = baseline[i:j] - hip_mid_y[i:j]
            apex_rel  = int(np.argmax(rise))
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

            jump_type = "leap (jeté-type)" if split_angle > 100.0 else "jump (sauté-type)"

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
    l_ankle_y = image_lm[start, 27, 1]
    r_ankle_y = image_lm[start, 28, 1]
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

def detect_arabesques(
    image_lm: np.ndarray,
    world_lm: np.ndarray,
    fps: float,
    body_scale: float,
    timestamps_ms: Optional[np.ndarray] = None,
) -> list[ArabesqueEvent]:
    """Detect arabesque holds: one leg elevated above the hip while the other stays grounded.

    Uses world-coordinate Y (positive = up) for elevation.  Both arabesque and
    front/side développé produce this signal; the user's sequence specification is
    the primary discriminator between those moves.
    """
    N = len(world_lm)
    if timestamps_ms is None:
        timestamps_ms = np.array([int(i * 1000 / fps) for i in range(N)], dtype=np.int64)

    ELEV_THRESH = 0.08    # working ankle must be ≥ 8 cm above hip midpoint
    SUPP_FLOOR  = -0.10   # supporting ankle must be ≤ this world-Y (clearly grounded)
    MIN_FRAMES  = max(4, int(0.25 * fps))

    candidates: list[ArabesqueEvent] = []

    for work_side, work_ankle_id, supp_ankle_id in [("L", 27, 28), ("R", 28, 27)]:
        mask = np.zeros(N, dtype=bool)
        for t in range(N):
            hip_y = (world_lm[t, 23, 1] + world_lm[t, 24, 1]) / 2.0
            if world_lm[t, work_ankle_id, 1] < hip_y + ELEV_THRESH:
                continue
            if world_lm[t, supp_ankle_id, 1] > SUPP_FLOOR:
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
                seg_y  = world_lm[i:j, work_ankle_id, 1]
                peak   = i + int(np.argmax(seg_y))
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
                prev_y = world_lm[prev.peak_frame, 27 if prev.working_leg == "L" else 28, 1]
                ev_y   = world_lm[ev.peak_frame,   27 if ev.working_leg   == "L" else 28, 1]
                if ev_y > prev_y:
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
                prev_y = world_lm[prev.peak_frame, 27 if prev.working_leg == "L" else 28, 1]
                ev_y   = world_lm[ev.peak_frame,   27 if ev.working_leg   == "L" else 28, 1]
                if ev_y > prev_y:
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
            if 0.20 <= spin_frac <= 0.80:
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
