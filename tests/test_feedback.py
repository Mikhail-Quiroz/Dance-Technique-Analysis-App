"""Tests for session-level feedback logic, including the zero-moves case."""

import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis.feedback import (
    build_session_report,
    build_move_feedback,
    report_to_dict,
    report_to_markdown,
    MoveReport,
    SessionReport,
)


# ---------------------------------------------------------------------------
# Zero-moves (no dance detected)
# ---------------------------------------------------------------------------

def test_zero_moves_sets_flag():
    session = build_session_report([])
    assert session.no_moves_detected is True


def test_zero_moves_score_is_zero():
    session = build_session_report([])
    assert session.overall_score == 0


def test_zero_moves_areas_are_na():
    session = build_session_report([])
    assert session.strongest_area == "N/A"
    assert session.focus_area == "N/A"


def test_zero_moves_dict_includes_flag():
    session = build_session_report([])
    d = report_to_dict(session)
    assert d["no_moves_detected"] is True
    assert d["moves"] == []


def test_zero_moves_markdown_no_score():
    session = build_session_report([])
    md = report_to_markdown(session)
    assert "0/100" not in md
    assert "No dance moves detected" in md


def test_zero_moves_markdown_no_great_technique():
    session = build_session_report([])
    md = report_to_markdown(session)
    assert "great technique" not in md.lower()


# ---------------------------------------------------------------------------
# Nonzero moves — no_moves_detected must be False
# ---------------------------------------------------------------------------

def _make_move_report(overall_score: int = 85) -> MoveReport:
    return MoveReport(
        move_type="leap (jeté-type)",
        timestamp_str="0:03",
        scores={"split_angle": overall_score},
        overall_score=overall_score,
        top_cues=[],
        raw_metrics={},
    )


def test_nonzero_moves_flag_false():
    session = build_session_report([_make_move_report()])
    assert session.no_moves_detected is False


def test_nonzero_moves_dict_flag_false():
    session = build_session_report([_make_move_report()])
    d = report_to_dict(session)
    assert d["no_moves_detected"] is False


def test_nonzero_moves_markdown_has_score():
    session = build_session_report([_make_move_report(overall_score=85)])
    md = report_to_markdown(session)
    assert "/100" in md


def test_session_score_averages_moves():
    reports = [_make_move_report(60), _make_move_report(80)]
    session = build_session_report(reports)
    assert session.overall_score == 70
