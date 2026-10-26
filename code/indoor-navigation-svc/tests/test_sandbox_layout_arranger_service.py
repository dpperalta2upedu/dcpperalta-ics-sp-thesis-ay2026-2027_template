from __future__ import annotations

from pathlib import Path
import sys

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sandbox.services.sb_layout_arranger_service import SandboxLayoutArrangerService
from sandbox.services.sb_layout_arranger_service import is_undo_request
import sandbox.sb_router as sb_router


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _build(message: str, current: dict | None = None, previous: dict | None = None, summary: dict | None = None):
    return SandboxLayoutArrangerService.build_plan(
        message=message,
        current_config=current,
        previous_config=previous,
        current_layout_summary=summary,
    )


# ===========================================================================
# BASIC CONTRACT
# ===========================================================================

def test_raises_for_empty_message():
    with pytest.raises(ValueError):
        _build("")


def test_raises_for_whitespace_only_message():
    with pytest.raises(ValueError):
        _build("   ")


def test_no_recognized_instruction_adds_warning():
    result = _build("Hello there")
    assert result["ok"] is True
    assert any("No concrete generator change" in w for w in result["warnings"])


def test_result_always_has_required_keys():
    for key in ("ok", "reply", "configPatch", "baseConfig", "proposedConfig", "commands", "warnings", "assumptions", "requiresRegeneration"):
        assert key in _build("Make it wider")


def test_requires_regeneration_is_always_true():
    assert _build("Make it wider")["requiresRegeneration"] is True


# ===========================================================================
# PROFILE
# ===========================================================================

class TestProfile:
    def test_mixed(self):
        assert _build("mixed use building", current={"profile": "academic"})["proposedConfig"]["profile"] == "mixed"

    def test_mixed_hyphen(self):
        assert _build("mixed-use layout")["proposedConfig"]["profile"] == "mixed"

    def test_multi_use(self):
        assert _build("multi-use building")["proposedConfig"]["profile"] == "mixed"

    def test_academic_keyword(self):
        assert _build("academic layout")["proposedConfig"]["profile"] == "academic"

    def test_classroom(self):
        assert _build("classroom-style rooms", current={"profile": "office"})["proposedConfig"]["profile"] == "academic"

    def test_lecture(self):
        assert _build("lecture hall profile")["proposedConfig"]["profile"] == "academic"

    def test_university(self):
        assert _build("university campus layout")["proposedConfig"]["profile"] == "academic"

    def test_campus(self):
        assert _build("campus style")["proposedConfig"]["profile"] == "academic"

    def test_school(self):
        assert _build("school building layout")["proposedConfig"]["profile"] == "academic"

    def test_educational(self):
        assert _build("educational building")["proposedConfig"]["profile"] == "academic"

    def test_office(self):
        assert _build("office layout", current={"profile": "academic"})["proposedConfig"]["profile"] == "office"

    def test_corporate(self):
        assert _build("corporate building layout")["proposedConfig"]["profile"] == "office"

    def test_commercial(self):
        assert _build("commercial building")["proposedConfig"]["profile"] == "office"

    def test_business(self):
        assert _build("business building")["proposedConfig"]["profile"] == "office"

    def test_workplace(self):
        assert _build("workplace layout")["proposedConfig"]["profile"] == "office"

    def test_laboratory(self):
        assert _build("laboratory profile")["proposedConfig"]["profile"] == "laboratory"

    def test_lab(self):
        assert _build("use a lab profile")["proposedConfig"]["profile"] == "laboratory"

    def test_research(self):
        assert _build("research building")["proposedConfig"]["profile"] == "laboratory"

    def test_science(self):
        assert _build("science building layout")["proposedConfig"]["profile"] == "laboratory"

    def test_technical(self):
        assert _build("technical laboratory layout")["proposedConfig"]["profile"] == "laboratory"

    def test_command_emitted(self):
        r = _build("office layout")
        assert any(c["field"] == "profile" and c["value"] == "office" for c in r["commands"])


# ===========================================================================
# ROOMS PER WING
# ===========================================================================

class TestRoomsPerWing:
    # ── relative decrease ───────────────────────────────────────────────────
    def test_fewer_rooms(self):
        assert _build("Fewer rooms please.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_less_rooms(self):
        assert _build("Less rooms.", current={"roomsPerWing": 5})["proposedConfig"]["roomsPerWing"] == 3

    def test_reduce_room_count(self):
        assert _build("Reduce room count.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_cut_rooms(self):
        assert _build("Cut rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_remove_rooms(self):
        assert _build("Remove rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_trim_rooms(self):
        assert _build("Trim rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_fewer_classrooms(self):
        assert _build("Fewer classrooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_fewer_offices(self):
        assert _build("Fewer offices.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_fewer_labs(self):
        assert _build("Fewer labs.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_delete_classrooms_relative(self):
        assert _build("Delete classrooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_delete_offices_relative(self):
        assert _build("Delete offices.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_eliminate_classrooms_relative(self):
        assert _build("Eliminate classrooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_decrease_clamps_at_min(self):
        assert _build("Fewer rooms.", current={"roomsPerWing": 2})["proposedConfig"]["roomsPerWing"] == 1

    # ── relative increase ───────────────────────────────────────────────────
    def test_more_rooms(self):
        assert _build("More rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 10

    def test_add_rooms(self):
        assert _build("Add rooms.", current={"roomsPerWing": 6})["proposedConfig"]["roomsPerWing"] == 8

    def test_need_more_rooms(self):
        assert _build("I need more rooms.", current={"roomsPerWing": 6})["proposedConfig"]["roomsPerWing"] == 8

    def test_more_classrooms(self):
        assert _build("Add more classrooms.", current={"roomsPerWing": 6})["proposedConfig"]["roomsPerWing"] == 8

    def test_more_offices(self):
        assert _build("I need more offices.", current={"roomsPerWing": 4})["proposedConfig"]["roomsPerWing"] == 6

    def test_more_labs(self):
        assert _build("Include more labs.", current={"roomsPerWing": 10})["proposedConfig"]["roomsPerWing"] == 12

    def test_increase_clamps_at_max(self):
        assert _build("More rooms.", current={"roomsPerWing": 29})["proposedConfig"]["roomsPerWing"] == 30

    # ── delete N [room-type] [in/from Wing X] ──────────────────────────────
    def test_delete_n_classrooms_in_wing(self):
        r = _build("Delete 3 classrooms in Wing A", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 5
        assert any(c["type"] == "rebalanceRooms" and c["value"] == "5" for c in r["commands"])
        assert any("deleting 3 room" in a for a in r["assumptions"])
        assert any("Wing A" in a for a in r["assumptions"])

    def test_remove_n_offices_from_wing(self):
        assert _build("Remove 2 offices from Wing B", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_cut_n_labs_in_wing(self):
        assert _build("Cut 4 labs in Wing C", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 4

    def test_eliminate_n_rooms_from_wing(self):
        assert _build("Eliminate 1 room from Wing D", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 7

    def test_take_out_n_classrooms(self):
        assert _build("Take out 2 classrooms from Wing A", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_delete_n_rooms_without_wing(self):
        assert _build("Delete 5 rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 3

    def test_remove_n_rooms_clamps_at_min(self):
        assert _build("Delete 10 classrooms in Wing A", current={"roomsPerWing": 4})["proposedConfig"]["roomsPerWing"] == 1

    def test_delete_all_rooms(self):
        r = _build("Delete all rooms.", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 8
        assert r["requiresRegeneration"] is False
        assert any(c["type"] == "deleteAllElements" and c["value"] == "room" for c in r["commands"])
        assert "rooms" in r["reply"]

    def test_delete_all_classrooms(self):
        r = _build("Delete all classrooms.", current={"roomsPerWing": 8})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "room" for c in r["commands"])

    def test_remove_all_offices(self):
        r = _build("Remove all offices.", current={"roomsPerWing": 8})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "room" for c in r["commands"])

    # ── delete a/one/the [room-type] → remove 1 ────────────────────────────
    def test_delete_a_classroom(self):
        r = _build("Delete a classroom from Wing A", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 7
        assert any("removing one room" in a for a in r["assumptions"])

    def test_remove_one_office(self):
        assert _build("Remove one office from Wing B", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 7

    def test_cut_the_lab(self):
        assert _build("Cut the lab from Wing C", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 7

    def test_remove_an_office(self):
        assert _build("Remove an office.", current={"roomsPerWing": 5})["proposedConfig"]["roomsPerWing"] == 4

    # ── add N [room-type] [to/in Wing X] ───────────────────────────────────
    def test_add_n_classrooms_to_wing(self):
        r = _build("Add 3 classrooms to Wing A", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 11
        assert any(c["type"] == "rebalanceRooms" and c["value"] == "11" for c in r["commands"])
        assert any("adding 3 room" in a for a in r["assumptions"])

    def test_add_n_offices_to_wing(self):
        assert _build("Add 2 offices to Wing B", current={"roomsPerWing": 6})["proposedConfig"]["roomsPerWing"] == 8

    def test_include_n_labs_in_wing(self):
        assert _build("Include 4 labs in Wing C", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 12

    def test_insert_n_workspaces(self):
        assert _build("Insert 2 workspaces into Wing D", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 10

    def test_add_n_more_classrooms(self):
        assert _build("Add 3 more classrooms to Wing A", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 11

    def test_add_n_rooms_without_wing(self):
        assert _build("Add 5 rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 13

    def test_add_n_clamps_at_max(self):
        assert _build("Add 10 classrooms to Wing A", current={"roomsPerWing": 25})["proposedConfig"]["roomsPerWing"] == 30

    # ── add a/one/another [room-type] → add 1 ──────────────────────────────
    def test_add_a_classroom(self):
        r = _build("Add a classroom to Wing A", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 9
        assert any("adding one room" in a for a in r["assumptions"])

    def test_add_another_office(self):
        assert _build("Add another office to Wing B", current={"roomsPerWing": 6})["proposedConfig"]["roomsPerWing"] == 7

    def test_include_one_lab(self):
        assert _build("Include one lab in Wing C", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 9

    def test_add_an_office(self):
        assert _build("Add an office.", current={"roomsPerWing": 5})["proposedConfig"]["roomsPerWing"] == 6

    # ── N-based takes priority over relative +2 ────────────────────────────
    def test_add_3_more_classrooms_adds_3_not_2(self):
        # "more classrooms" substring is in the +2 relative list, but N=3 must win
        assert _build("Add 3 more classrooms to Wing A", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 11

    # ── absolute (set to N) with room-type synonyms ─────────────────────────
    def test_explicit_n_rooms_per_wing(self):
        r = _build("Use 10 rooms per wing.", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 10
        assert any(c["field"] == "roomsPerWing" and c["value"] == "10" for c in r["commands"])

    def test_explicit_n_classrooms_per_wing(self):
        assert _build("Use 6 classrooms per wing.", current={})["proposedConfig"]["roomsPerWing"] == 6

    def test_explicit_n_offices_per_wing(self):
        assert _build("Use 5 offices per wing.", current={})["proposedConfig"]["roomsPerWing"] == 5

    def test_explicit_n_labs_per_wing(self):
        assert _build("Use 4 labs per wing.", current={})["proposedConfig"]["roomsPerWing"] == 4

    def test_explicit_n_rooms(self):
        assert _build("Set to 12 rooms.", current={})["proposedConfig"]["roomsPerWing"] == 12

    def test_explicit_clamps_high(self):
        assert _build("50 rooms per wing", current={})["proposedConfig"]["roomsPerWing"] == 30

    def test_explicit_clamps_low(self):
        assert _build("0 rooms per wing", current={})["proposedConfig"]["roomsPerWing"] == 1

    def test_room_count_to_verb(self):
        assert _build("Change room count for each wing to 20", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 20

    def test_set_room_count(self):
        assert _build("Set room count to 15", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 15

    def test_each_wing_should_have(self):
        assert _build("Each wing should have 6 rooms.", current={})["proposedConfig"]["roomsPerWing"] == 6

    def test_each_wing_needs(self):
        assert _build("Each wing needs 9 rooms.", current={})["proposedConfig"]["roomsPerWing"] == 9

    def test_each_wing_should_have_classrooms(self):
        assert _build("Each wing should have 5 classrooms.", current={})["proposedConfig"]["roomsPerWing"] == 5

    def test_increase_number_of_rooms(self):
        assert _build("Increase number of rooms", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 10

    # ── per-wing absolute set ────────────────────────────────────────────────
    def test_wing_should_have_n_classrooms(self):
        assert _build("Wing A should have 6 classrooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 6

    def test_wing_needs_n_offices(self):
        assert _build("Wing B needs 5 offices.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 5

    def test_give_wing_n_labs(self):
        assert _build("Give Wing C 4 labs.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 4

    def test_set_wing_to_n_rooms(self):
        assert _build("Set Wing A to 7 rooms.", current={"roomsPerWing": 8})["proposedConfig"]["roomsPerWing"] == 7

    def test_i_want_n_rooms_in_wing(self):
        assert _build("I want 8 classrooms in Wing B.", current={"roomsPerWing": 4})["proposedConfig"]["roomsPerWing"] == 8


# ===========================================================================
# ROOM SCALE – GLOBAL
# ===========================================================================

class TestRoomScaleGlobal:
    # explicit %
    def test_set_room_scale_to_120(self):
        r = _build("Set room scale to 120%", current={"roomScale": 100})
        assert r["proposedConfig"]["roomScale"] == 120

    def test_adjust_room_size_to_90(self):
        assert _build("Adjust room size to 90%", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 90

    def test_room_scale_at_110(self):
        assert _build("Room scale at 110%", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 110

    def test_room_size_of_80(self):
        assert _build("Room size of 80%", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 80

    def test_explicit_scale_clamps_high(self):
        assert _build("Set room scale to 200%", current={})["proposedConfig"]["roomScale"] == 140

    def test_explicit_scale_clamps_low(self):
        assert _build("Set room scale to 20%", current={})["proposedConfig"]["roomScale"] == 60

    # relative +15 %
    def test_increase_room_sizes(self):
        assert _build("Increase room sizes", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_larger_rooms(self):
        assert _build("Larger rooms please.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_bigger_rooms(self):
        assert _build("Make rooms bigger.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_make_rooms_larger(self):
        assert _build("Make rooms larger.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_scale_up_rooms(self):
        assert _build("Scale up rooms.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_expand_rooms(self):
        assert _build("Expand rooms.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_increase_all_room_sizes(self):
        assert _build("Increase all room sizes", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_increase_generated_room_sizes(self):
        assert _build("Increase generated room sizes.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    def test_make_all_rooms_bigger(self):
        assert _build("Make all rooms bigger.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 115

    # relative −15 %
    def test_decrease_room_sizes(self):
        assert _build("Decrease room sizes", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_smaller_rooms(self):
        assert _build("Smaller rooms please.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_make_rooms_smaller(self):
        assert _build("Make rooms smaller.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_shrink_rooms(self):
        assert _build("Shrink rooms.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_scale_down_rooms(self):
        assert _build("Scale down rooms.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_decrease_all_room_sizes(self):
        assert _build("Decrease all room sizes", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_reduce_generated_room_sizes(self):
        assert _build("Reduce generated room sizes.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    def test_make_all_rooms_smaller(self):
        assert _build("Make all rooms smaller.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 85

    # percentage-based relative
    def test_rooms_20_percent_larger(self):
        assert _build("Make rooms 20% larger.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 120

    def test_rooms_10_percent_smaller(self):
        assert _build("Make rooms 10% smaller.", current={"roomScale": 100})["proposedConfig"]["roomScale"] == 90

    # clamping
    def test_clamps_at_max(self):
        assert _build("Expand rooms", current={"roomScale": 140})["proposedConfig"]["roomScale"] == 140

    def test_clamps_at_min(self):
        assert _build("Shrink rooms", current={"roomScale": 60})["proposedConfig"]["roomScale"] == 60


# ===========================================================================
# WING-SPECIFIC ROOM SCALE OVERRIDES
# ===========================================================================

class TestWingSpecificScale:
    # explicit %
    def test_wing_a_at_110(self):
        r = _build("Wing A at 110%", current={"wingRoomScaleOverrides": {}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"]["A"] == 110
        assert any(c["field"] == "wingRoomScaleOverrides.A" and c["value"] == "110" for c in r["commands"])

    def test_wing_b_to_90(self):
        assert _build("Wing B to 90%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 90

    def test_set_wing_c_to_120(self):
        assert _build("Set Wing C to 120%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["C"] == 120

    def test_scale_wing_d_to_85(self):
        assert _build("Scale Wing D to 85%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["D"] == 85

    def test_wing_e_rooms_at_115(self):
        assert _build("Wing E rooms at 115%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["E"] == 115

    def test_explicit_scale_clamps_high(self):
        assert _build("Wing A at 200%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["A"] == 140

    def test_explicit_scale_clamps_low(self):
        assert _build("Wing B to 10%", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 60

    # height-based (requires both height keyword + direction keyword)
    def test_increase_wing_a_height(self):
        r = _build("Increase Wing A height", current={"wingRoomScaleOverrides": {}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"]["A"] == 115
        assert any("increases the generated wing height" in a for a in r["assumptions"])

    def test_raise_wing_b_height(self):
        assert _build("Raise Wing B height", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 115

    def test_wing_c_taller_and_bigger(self):
        assert _build("Make Wing C taller and bigger.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["C"] == 115

    def test_decrease_wing_b_height(self):
        r = _build("Decrease Wing B height", current={"wingRoomScaleOverrides": {}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 85
        assert any("reduces the generated wing height" in a for a in r["assumptions"])

    def test_reduce_wing_d_height(self):
        assert _build("Reduce Wing D height", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["D"] == 85

    def test_wing_d_shorter_and_smaller(self):
        assert _build("Make Wing D shorter and smaller.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["D"] == 85

    # size-based relative
    def test_reduce_size_wing_b(self):
        assert _build("Reduce the size of all rooms in Wing B.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 85

    def test_smaller_rooms_wing_e(self):
        assert _build("Wing E smaller rooms.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["E"] == 85

    def test_shrink_wing_a(self):
        assert _build("Shrink Wing A.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["A"] == 85

    def test_compress_wing_c(self):
        assert _build("Compress Wing C.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["C"] == 85

    def test_increase_size_wing_a(self):
        assert _build("Increase the size of Wing A.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["A"] == 115

    def test_expand_wing_c(self):
        assert _build("Expand Wing C.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["C"] == 115

    def test_bigger_rooms_wing_b(self):
        assert _build("Bigger rooms in Wing B.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["B"] == 115

    def test_scale_up_wing_d(self):
        assert _build("Scale up Wing D.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["D"] == 115

    def test_make_bigger_wing_e(self):
        assert _build("Make bigger Wing E.", current={"wingRoomScaleOverrides": {}})["proposedConfig"]["wingRoomScaleOverrides"]["E"] == 115


# ===========================================================================
# FLOOR COUNT
# ===========================================================================

class TestFloorCount:
    # absolute
    def test_n_floors(self):
        assert _build("Use 5 floors.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 5

    def test_n_story(self):
        assert _build("4-story building", current={})["proposedConfig"]["floorCount"] == 4

    def test_n_stories(self):
        assert _build("3 stories high", current={})["proposedConfig"]["floorCount"] == 3

    def test_n_storey(self):
        assert _build("5 storey building", current={})["proposedConfig"]["floorCount"] == 5

    def test_n_storeys(self):
        assert _build("2 storeys", current={})["proposedConfig"]["floorCount"] == 2

    def test_n_levels(self):
        assert _build("I need 4 levels.", current={})["proposedConfig"]["floorCount"] == 4

    def test_floor_clamps_high(self):
        assert _build("20 floors", current={})["proposedConfig"]["floorCount"] == 10

    def test_floor_clamps_low(self):
        assert _build("0 floors", current={})["proposedConfig"]["floorCount"] == 1

    # remove specific floor
    def test_remove_floor_by_number(self):
        r = _build("Remove floor 3", current={"floorCount": 3})
        assert r["proposedConfig"]["floorCount"] == 2
        assert any(c["field"] == "floorCount" and c["value"] == "2" for c in r["commands"])

    def test_drop_floor_by_number(self):
        assert _build("Drop floor 3", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_cut_floor_by_number(self):
        assert _build("Cut floor 2", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_remove_non_top_floor_adds_assumption(self):
        r = _build("Remove floor 2", current={"floorCount": 3})
        assert r["proposedConfig"]["floorCount"] == 2
        assert any("selective middle-floor removal is not supported" in a for a in r["assumptions"])

    def test_remove_top_floor_adds_trimming_assumption(self):
        r = _build("Remove floor 3", current={"floorCount": 3})
        assert any("trimming the top floor" in a for a in r["assumptions"])

    def test_remove_floor_ordinal(self):
        assert _build("Remove 3rd floor", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_drop_floor_ordinal(self):
        assert _build("Drop the 2nd floor", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_remove_floor_with_typo(self):
        assert _build("Remvoe 3rd floor", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_remove_floor_warns_at_min(self):
        r = _build("Remove floor 1", current={"floorCount": 1})
        assert any("only one floor" in w for w in r["warnings"])

    def test_remove_level_by_number(self):
        assert _build("Remove level 3", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    # relative add / remove
    def test_add_a_floor(self):
        r = _build("Add a floor.", current={"floorCount": 3})
        assert r["proposedConfig"]["floorCount"] == 4
        assert any("adding one more floor" in a for a in r["assumptions"])

    def test_add_another_floor(self):
        assert _build("Add another floor.", current={"floorCount": 2})["proposedConfig"]["floorCount"] == 3

    def test_add_one_more_floor(self):
        assert _build("Add one more floor.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 4

    def test_add_extra_floor(self):
        assert _build("Add an extra floor.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 4

    def test_add_floor_clamps_at_max(self):
        assert _build("Add a floor.", current={"floorCount": 10})["proposedConfig"]["floorCount"] == 10

    def test_remove_a_floor(self):
        r = _build("Remove a floor.", current={"floorCount": 3})
        assert r["proposedConfig"]["floorCount"] == 2
        assert any("removing the top floor" in a for a in r["assumptions"])

    def test_drop_a_floor(self):
        assert _build("Drop a floor.", current={"floorCount": 4})["proposedConfig"]["floorCount"] == 3

    def test_remove_one_floor(self):
        assert _build("Remove one floor.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_remove_top_floor(self):
        assert _build("Remove the top floor.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_cut_a_floor(self):
        assert _build("Cut a floor.", current={"floorCount": 3})["proposedConfig"]["floorCount"] == 2

    def test_remove_a_floor_warns_at_min(self):
        r = _build("Remove a floor.", current={"floorCount": 1})
        assert any("only one floor" in w for w in r["warnings"])


# ===========================================================================
# WING COUNT
# ===========================================================================

class TestWingCount:
    # absolute
    def test_n_wings(self):
        assert _build("Use 4 wings.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 4

    def test_n_wing_hyphenated(self):
        assert _build("I want a 2-wing building.", current={})["proposedConfig"]["wingCount"] == 2

    def test_wing_clamps_high(self):
        assert _build("Use 10 wings.", current={})["proposedConfig"]["wingCount"] == 5

    def test_wing_clamps_low(self):
        assert _build("0 wings", current={})["proposedConfig"]["wingCount"] == 1

    # relative add
    def test_add_1_more_wing(self):
        r = _build("Add 1 more wing", current={"wingCount": 3})
        assert r["proposedConfig"]["wingCount"] == 4
        assert any("increasing the generated wing count by 1" in a for a in r["assumptions"])

    def test_add_another_wing(self):
        assert _build("Add another wing", current={"wingCount": 2})["proposedConfig"]["wingCount"] == 3

    def test_add_a_wing(self):
        r = _build("Add a wing.", current={"wingCount": 2})
        assert r["proposedConfig"]["wingCount"] == 3
        assert any("increasing the generated wing count by 1" in a for a in r["assumptions"])

    def test_add_a_new_wing(self):
        assert _build("Add a new wing.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 4

    def test_include_more_wing(self):
        assert _build("Include more wing.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 4

    def test_add_wing_clamps_at_max(self):
        assert _build("Add another wing", current={"wingCount": 5})["proposedConfig"]["wingCount"] == 5

    # relative remove
    def test_remove_wing(self):
        r = _build("Remove wing", current={"wingCount": 3})
        assert r["proposedConfig"]["wingCount"] == 2
        assert any("decreasing the generated wing count by 1" in a for a in r["assumptions"])

    def test_delete_wing(self):
        assert _build("Delete wing", current={"wingCount": 4})["proposedConfig"]["wingCount"] == 3

    def test_drop_wing(self):
        assert _build("Drop a wing.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 2

    def test_cut_wing(self):
        assert _build("Cut a wing.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 2

    def test_remove_one_wing(self):
        assert _build("Remove one wing.", current={"wingCount": 3})["proposedConfig"]["wingCount"] == 2

    def test_remove_wing_clamps_at_min(self):
        assert _build("Remove wing", current={"wingCount": 1})["proposedConfig"]["wingCount"] == 1


# ===========================================================================
# CANVAS WIDTH
# ===========================================================================

class TestCanvasWidth:
    def test_exact_px(self):
        assert _build("Make it 2000px wide.", current={"width": 1768})["proposedConfig"]["width"] == 2000

    def test_exact_without_px(self):
        assert _build("Make it 1500 wide.", current={"width": 1768})["proposedConfig"]["width"] == 1500

    def test_width_keyword(self):
        assert _build("2400px width.", current={})["proposedConfig"]["width"] == 2400

    def test_clamps_high(self):
        assert _build("5000px wide", current={})["proposedConfig"]["width"] == 3200

    def test_clamps_low(self):
        assert _build("100px wide", current={})["proposedConfig"]["width"] == 1200

    def test_make_it_wider(self):
        assert _build("Make it wider.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_increase_width(self):
        assert _build("Increase width.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_wider_layout(self):
        assert _build("I want a wider layout.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_more_horizontal_space(self):
        assert _build("Give it more horizontal space.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_expand_the_canvas(self):
        assert _build("Expand the canvas.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_stretch_it_wider(self):
        assert _build("Stretch it wider.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_widen_the_canvas(self):
        assert _build("Widen the canvas.", current={"width": 1768})["proposedConfig"]["width"] == 1928

    def test_make_it_narrower(self):
        assert _build("Make it narrower.", current={"width": 1768})["proposedConfig"]["width"] == 1608

    def test_decrease_width(self):
        assert _build("Decrease width.", current={"width": 1768})["proposedConfig"]["width"] == 1608

    def test_narrower_layout(self):
        assert _build("I want a narrower layout.", current={"width": 1768})["proposedConfig"]["width"] == 1608

    def test_less_horizontal_space(self):
        assert _build("Less horizontal space.", current={"width": 1768})["proposedConfig"]["width"] == 1608

    def test_compress_canvas(self):
        assert _build("Compress the canvas.", current={"width": 1768})["proposedConfig"]["width"] == 1608

    def test_wider_adds_assumption(self):
        r = _build("Make it wider.", current={"width": 1768})
        assert any("160 px" in a for a in r["assumptions"])


# ===========================================================================
# CANVAS HEIGHT
# ===========================================================================

class TestCanvasHeight:
    def test_exact_px(self):
        assert _build("Make it 1200px tall.", current={"height": 930})["proposedConfig"]["height"] == 1200

    def test_height_keyword(self):
        assert _build("Set the height to 1000px.", current={})["proposedConfig"]["height"] == 1000

    def test_clamps_high(self):
        assert _build("5000px tall", current={})["proposedConfig"]["height"] == 1800

    def test_clamps_low(self):
        assert _build("100px tall", current={})["proposedConfig"]["height"] == 760

    def test_make_it_taller(self):
        r = _build("Make it taller.", current={"height": 930})
        assert r["proposedConfig"]["height"] == 1050
        assert any(c["field"] == "height" and c["value"] == "1050" for c in r["commands"])

    def test_increase_height(self):
        assert _build("Increase height.", current={"height": 930})["proposedConfig"]["height"] == 1050

    def test_taller_layout(self):
        assert _build("Taller layout.", current={"height": 930})["proposedConfig"]["height"] == 1050

    def test_more_vertical_space(self):
        assert _build("More vertical space.", current={"height": 930})["proposedConfig"]["height"] == 1050

    def test_extend_vertically(self):
        assert _build("Extend vertically.", current={"height": 930})["proposedConfig"]["height"] == 1050

    def test_make_it_shorter(self):
        r = _build("Make it shorter.", current={"height": 930})
        assert r["proposedConfig"]["height"] == 810
        assert any("120 px" in a for a in r["assumptions"])

    def test_decrease_height(self):
        assert _build("Decrease height.", current={"height": 930})["proposedConfig"]["height"] == 810

    def test_shorter_layout(self):
        assert _build("Shorter layout.", current={"height": 930})["proposedConfig"]["height"] == 810

    def test_less_vertical_space(self):
        assert _build("Less vertical space.", current={"height": 930})["proposedConfig"]["height"] == 810

    def test_height_ignored_when_wing_in_message(self):
        r = _build("Increase Wing A height", current={"height": 930, "wingRoomScaleOverrides": {}})
        assert r["proposedConfig"]["height"] == 930


# ===========================================================================
# PLACEMENT PATTERN
# ===========================================================================

class TestPlacementPattern:
    def test_single_loaded(self):
        assert _build("Single-loaded corridors.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_single_loaded_space(self):
        assert _build("Single loaded layout.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_one_sided_corridor(self):
        assert _build("One-sided corridor layout.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_rooms_on_one_side(self):
        assert _build("Rooms on one side.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_single_corridor(self):
        assert _build("Single corridor.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_one_sided(self):
        assert _build("One-sided layout.")["proposedConfig"]["placementPattern"] == "single-loaded"

    def test_double_loaded(self):
        assert _build("Double-loaded corridors.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_double_loaded_space(self):
        assert _build("Double loaded layout.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_both_sides_of_hallway(self):
        assert _build("Rooms on both sides of a hallway.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_both_sides_of_the_hallway(self):
        assert _build("Rooms on both sides of the hallway.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_rooms_on_both_sides(self):
        assert _build("Rooms on both sides.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_double_corridor(self):
        assert _build("Double corridor layout.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_two_sided(self):
        assert _build("Two-sided corridor.")["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_clustered(self):
        assert _build("Clustered layout.")["proposedConfig"]["placementPattern"] == "clustered"

    def test_cluster_keyword(self):
        assert _build("Cluster the rooms.")["proposedConfig"]["placementPattern"] == "clustered"

    def test_grouped(self):
        assert _build("Grouped rooms.")["proposedConfig"]["placementPattern"] == "clustered"

    def test_pod_layout(self):
        assert _build("Pod layout.")["proposedConfig"]["placementPattern"] == "clustered"

    def test_open_plan(self):
        assert _build("Open plan layout.")["proposedConfig"]["placementPattern"] == "clustered"


# ===========================================================================
# DENSITY
# ===========================================================================

class TestDensity:
    # low
    def test_open(self):
        assert _build("Make it more open.", current={"density": "medium"})["proposedConfig"]["density"] == "low"

    def test_airy(self):
        assert _build("An airy feel.", current={"density": "high"})["proposedConfig"]["density"] == "low"

    def test_spacious(self):
        assert _build("More spacious layout.", current={"density": "medium"})["proposedConfig"]["density"] == "low"

    def test_low_density(self):
        assert _build("Low density layout.", current={})["proposedConfig"]["density"] == "low"

    def test_spread_out(self):
        assert _build("Spread out the rooms.", current={"density": "high"})["proposedConfig"]["density"] == "low"

    def test_less_crowded(self):
        assert _build("Less crowded layout.", current={"density": "high"})["proposedConfig"]["density"] == "low"

    def test_not_crowded(self):
        assert _build("Not crowded.", current={"density": "medium"})["proposedConfig"]["density"] == "low"

    def test_less_dense(self):
        assert _build("Less dense.", current={"density": "high"})["proposedConfig"]["density"] == "low"

    # medium
    def test_balanced(self):
        assert _build("Balanced layout.", current={"density": "high"})["proposedConfig"]["density"] == "medium"

    def test_medium_density(self):
        assert _build("Medium density please.", current={"density": "low"})["proposedConfig"]["density"] == "medium"

    def test_moderate(self):
        assert _build("Moderate density.", current={"density": "high"})["proposedConfig"]["density"] == "medium"

    # high
    def test_dense(self):
        assert _build("I want a dense layout.", current={"density": "low"})["proposedConfig"]["density"] == "high"

    def test_packed(self):
        assert _build("Packed layout.", current={"density": "medium"})["proposedConfig"]["density"] == "high"

    def test_high_density(self):
        assert _build("High density.", current={"density": "low"})["proposedConfig"]["density"] == "high"

    def test_compact(self):
        assert _build("Compact layout.", current={"density": "low"})["proposedConfig"]["density"] == "high"

    def test_tightly_packed(self):
        assert _build("Tightly packed rooms.", current={"density": "medium"})["proposedConfig"]["density"] == "high"

    def test_overcrowded(self):
        assert _build("Overcrowded layout.", current={"density": "low"})["proposedConfig"]["density"] == "high"

    def test_dense_layout_warning(self):
        r = _build("High density.", current={"density": "medium"}, summary={"roomCount": 150})
        assert r["proposedConfig"]["density"] == "high"
        assert any("already dense" in w for w in r["warnings"])


# ===========================================================================
# HALLWAY THICKNESS
# ===========================================================================

class TestHallwayThickness:
    # exact px
    def test_hallway_to_60px(self):
        r = _build("Hallway to 60px.", current={"hallwayThickness": 40})
        assert r["proposedConfig"]["hallwayThickness"] == 60
        assert any(c["type"] == "resizeHallway" for c in r["commands"])

    def test_corridor_thickness_to_80px(self):
        assert _build("Corridor thickness to 80px.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 80

    def test_set_hallway_thickness_to_50(self):
        assert _build("Set hallway thickness to 50.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 50

    def test_change_hallway_to_30(self):
        assert _build("Change hallway to 30.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 30

    def test_resize_corridor_to_70(self):
        assert _build("Resize corridor to 70.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 70

    def test_make_hallway_60px(self):
        assert _build("Make hallway 60px.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 60

    def test_exact_clamps_high(self):
        assert _build("Set hallway thickness to 200.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 120

    def test_exact_clamps_low(self):
        assert _build("Set hallway thickness to 5.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 20

    # relative: % based
    def test_hallway_50_percent_wider(self):
        assert _build("Make hallways 50% wider.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 60

    def test_corridor_25_percent_thinner(self):
        assert _build("Make corridors 25% thinner.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 30

    # relative: +20%
    def test_wider_hallways(self):
        r = _build("Wider hallways.", current={"hallwayThickness": 40})
        assert r["proposedConfig"]["hallwayThickness"] == 48
        assert any("20%" in a for a in r["assumptions"])

    def test_make_hallways_wider(self):
        assert _build("Make hallways wider.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_widen_hallways(self):
        assert _build("Widen hallways.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_widen_the_hallways(self):
        assert _build("Widen the hallways.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_widen_corridors(self):
        assert _build("Widen corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_widen_the_corridors(self):
        assert _build("Widen the corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_expand_hallways(self):
        assert _build("Expand hallways.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_expand_corridors(self):
        assert _build("Expand corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_expand_the_corridors(self):
        assert _build("Expand the corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_increase_corridor_width(self):
        assert _build("Increase corridor width.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_increase_hallway_width(self):
        assert _build("Increase hallway width.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    def test_make_corridors_wider(self):
        assert _build("Make corridors wider.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 48

    # relative: −15%
    def test_narrower_hallways(self):
        r = _build("Narrower hallways.", current={"hallwayThickness": 40})
        assert r["proposedConfig"]["hallwayThickness"] == 34
        assert any("15%" in a for a in r["assumptions"])

    def test_make_hallways_narrower(self):
        assert _build("Make hallways narrower.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_narrow_hallways(self):
        assert _build("Narrow hallways.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_narrow_the_corridors(self):
        assert _build("Narrow the corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_narrow_down_corridors(self):
        assert _build("Narrow down corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_compress_corridors(self):
        assert _build("Compress corridors.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_compress_hallways(self):
        assert _build("Compress hallways.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_decrease_hallway_width(self):
        assert _build("Decrease hallway width.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_decrease_corridor_width(self):
        assert _build("Decrease corridor width.", current={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 34

    def test_clamps_high_on_percent(self):
        assert _build("Make hallways 200% wider.", current={"hallwayThickness": 100})["proposedConfig"]["hallwayThickness"] == 120

    def test_clamps_low_on_percent(self):
        assert _build("Make hallways 90% thinner.", current={"hallwayThickness": 25})["proposedConfig"]["hallwayThickness"] == 20


# ===========================================================================
# HALLWAY CLEANUP (overlap / misplaced)
# ===========================================================================

class TestHallwayCleanup:
    def test_misplaced_narrows_thickness(self):
        r = _build("Remove misplaced hallways", current={"includeHallways": True, "hallwayThickness": 40, "placementPattern": "double-loaded"})
        assert r["proposedConfig"]["includeHallways"] is True
        assert r["proposedConfig"]["hallwayThickness"] == 32
        assert not any(c["field"] == "includeHallways" for c in r["commands"])
        assert any("hallway cleanup request" in a for a in r["assumptions"])

    def test_overlapping_at_min_thickness_simplifies_pattern(self):
        r = _build("Remove the overlapping hallways", current={"includeHallways": True, "hallwayThickness": 20, "placementPattern": "double-loaded", "roomsPerWing": 1})
        assert r["proposedConfig"]["includeHallways"] is True
        assert r["proposedConfig"]["placementPattern"] == "single-loaded"
        assert not any(c["field"] == "includeHallways" for c in r["commands"])

    def test_fix_overlapping_narrows(self):
        r = _build("Fix the overlapping hallways", current={"includeHallways": True, "hallwayThickness": 40, "placementPattern": "double-loaded"})
        assert r["proposedConfig"]["hallwayThickness"] == 32

    def test_collisions_reduces_rooms_when_single_loaded(self):
        r = _build("Fix hallway collisions", current={"includeHallways": True, "hallwayThickness": 20, "placementPattern": "single-loaded", "roomsPerWing": 8, "includeBridges": True, "wingCount": 3})
        assert r["proposedConfig"]["roomsPerWing"] == 7

    def test_disables_bridges_as_last_resort(self):
        r = _build("Fix hallway collisions", current={"includeHallways": True, "hallwayThickness": 20, "placementPattern": "single-loaded", "roomsPerWing": 1, "includeBridges": True, "wingCount": 3})
        assert r["proposedConfig"]["includeBridges"] is False
        assert any("regenerating without bridges" in a for a in r["assumptions"])

    def test_warns_when_all_options_exhausted(self):
        r = _build("Resolve hallway collisions", current={"includeHallways": True, "hallwayThickness": 20, "placementPattern": "single-loaded", "roomsPerWing": 1, "includeBridges": False, "wingCount": 1})
        assert any("already minimal" in w for w in r["warnings"])


# ===========================================================================
# EXPLICIT HALLWAY REMOVAL
# ===========================================================================

class TestHallwayRemoval:
    def test_remove_hallways(self):
        r = _build("Remove the hallways.", current={"includeHallways": True})
        assert r["proposedConfig"]["includeHallways"] is False
        assert any("selective hallway removal" in a for a in r["assumptions"])

    def test_delete_all_hallways(self):
        r = _build("Delete all hallways.", current={"includeHallways": True})
        assert r["proposedConfig"]["includeHallways"] is True
        assert r["requiresRegeneration"] is False
        assert any(c["type"] == "deleteAllElements" and c["value"] == "hallway" for c in r["commands"])
        assert any("current layout canvas" in a for a in r["assumptions"])
        assert not any("selective hallway removal" in a for a in r["assumptions"])

    def test_without_hallways(self):
        assert _build("Without hallways.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False

    def test_disable_hallways(self):
        assert _build("Disable hallways.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False

    def test_hide_hallways(self):
        assert _build("Hide hallways.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False

    def test_clear_hallways(self):
        assert _build("Clear hallways.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False

    def test_get_rid_of_corridors(self):
        assert _build("Get rid of corridors.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False

    def test_no_corridors(self):
        assert _build("No corridors.", current={"includeHallways": True})["proposedConfig"]["includeHallways"] is False


# ===========================================================================
# ALIGNMENT CLEANUP
# ===========================================================================

class TestAlignmentCleanup:
    """Alignment requests trigger a fresh regeneration with the same config.
    Corridor alignment is a generation-time property — no parameter change fixes it;
    regenerating with the same settings produces new corridor positions."""

    def _assert_regen_no_change(self, r: dict, current_config: dict) -> None:
        """Helper: alignment must set requiresRegeneration=True and change no config fields."""
        assert r["requiresRegeneration"] is True, "Alignment request must require regeneration"
        assert r["configPatch"] == {}, f"Alignment request must NOT change any config, got: {r['configPatch']}"
        assert r["proposedConfig"]["roomScale"] == current_config.get("roomScale", 100)
        assert r["proposedConfig"]["placementPattern"] == current_config.get("placementPattern", "double-loaded")
        assert r["proposedConfig"]["hallwayThickness"] == current_config.get("hallwayThickness", 30)
        assert r["proposedConfig"]["roomsPerWing"] == current_config.get("roomsPerWing", 8)
        assert any("alignment" in a.lower() for a in r["assumptions"])

    # ── three-condition phrases ──────────────────────────────────────────────
    def test_fix_hallway_alignments(self):
        cfg = {"placementPattern": "double-loaded", "roomScale": 100, "hallwayThickness": 40, "roomsPerWing": 8}
        self._assert_regen_no_change(_build("Fix all hallway alignments", current=cfg), cfg)

    def test_fix_horizontal_hallway_alignments(self):
        cfg = {"placementPattern": "double-loaded", "roomScale": 100, "hallwayThickness": 40, "roomsPerWing": 8}
        self._assert_regen_no_change(_build("Fix horizontal hallway alignments", current=cfg), cfg)

    def test_fix_hallway_and_room_alignments(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Fix hallway and room alignments", current=cfg), cfg)

    def test_correct_corridor_alignment(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Correct corridor alignment.", current=cfg), cfg)

    def test_improve_room_alignment(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Improve room alignment.", current=cfg), cfg)

    def test_adjust_corridor_alignment(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Adjust corridor alignments.", current=cfg), cfg)

    def test_fix_misaligned_hallways(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Fix misaligned hallways.", current=cfg), cfg)

    def test_correct_misaligned_rooms(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Correct the misaligned rooms.", current=cfg), cfg)

    def test_resolve_corridor_alignment(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Resolve corridor alignment issues.", current=cfg), cfg)

    def test_straighten_room_alignments(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten room alignments.", current=cfg), cfg)

    def test_realign_keyword_three_conditions(self):
        cfg = {"placementPattern": "double-loaded", "roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8}
        self._assert_regen_no_change(_build("Realign the corridors and fix them.", current=cfg), cfg)

    # ── imperative "align [the/all] [hallways/corridors]" ───────────────────
    def test_align_the_hallways(self):
        cfg = {"placementPattern": "double-loaded", "roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8}
        self._assert_regen_no_change(_build("Align the hallways.", current=cfg), cfg)

    def test_align_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Align corridors.", current=cfg), cfg)

    def test_align_all_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Align all corridors.", current=cfg), cfg)

    def test_align_all_rooms(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Align all rooms.", current=cfg), cfg)

    def test_align_the_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Align the corridors.", current=cfg), cfg)

    def test_realign_hallways(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Realign hallways.", current=cfg), cfg)

    def test_realign_the_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Realign the corridors.", current=cfg), cfg)

    def test_realign_all_hallways(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Realign all hallways.", current=cfg), cfg)

    # ── imperative "straighten [out] [the/all] [hallways/corridors]" ────────
    def test_straighten_the_hallways(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten the hallways.", current=cfg), cfg)

    def test_straighten_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten corridors.", current=cfg), cfg)

    def test_straighten_out_the_hallways(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten out the hallways.", current=cfg), cfg)

    def test_straighten_out_all_corridors(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten out all corridors.", current=cfg), cfg)

    def test_straighten_all_rooms(self):
        cfg = {"roomScale": 100, "hallwayThickness": 30, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Straighten all rooms.", current=cfg), cfg)

    # ── config must stay unchanged regardless of current settings ────────────
    def test_no_config_change_when_scale_at_min(self):
        cfg = {"roomScale": 60, "hallwayThickness": 20, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Fix hallway alignments", current=cfg), cfg)

    def test_no_config_change_when_already_single_loaded(self):
        cfg = {"roomScale": 60, "hallwayThickness": 20, "roomsPerWing": 5, "placementPattern": "single-loaded"}
        self._assert_regen_no_change(_build("Fix hallway alignments", current=cfg), cfg)

    def test_horizontal_qualifier_still_regen_only(self):
        cfg = {"roomScale": 100, "hallwayThickness": 40, "roomsPerWing": 8, "placementPattern": "double-loaded"}
        self._assert_regen_no_change(_build("Fix horizontal hallway alignments", current=cfg), cfg)


# ===========================================================================
# TOGGLES: BRIDGES, LOUNGES, ENTRANCE, WING BACKGROUNDS
# ===========================================================================

class TestToggles:
    # bridges
    def test_add_bridges(self):
        assert _build("Add bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_restore_bridges(self):
        assert _build("Restore bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_bring_back_bridges(self):
        assert _build("Bring back bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_no_bridges(self):
        assert _build("No bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_remove_bridges(self):
        assert _build("Remove bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_remove_all_bridges(self):
        assert _build("Remove all bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_remove_the_bridges(self):
        assert _build("Remove the bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_disable_bridges(self):
        assert _build("Disable bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_clear_bridges(self):
        assert _build("Clear bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_get_rid_of_bridges(self):
        assert _build("Get rid of bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_no_more_bridges(self):
        assert _build("No more bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_take_away_bridges(self):
        assert _build("Take away bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    # lounges
    def test_add_lounges(self):
        assert _build("Add lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_include_lounges(self):
        assert _build("Include lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_delete_lounge(self):
        r = _build("Delete Lounge", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_remove_lounges(self):
        r = _build("Remove lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_delete_all_lounges(self):
        r = _build("Delete all lounges", current={"includeLounges": True})
        assert r["proposedConfig"]["includeLounges"] is True
        assert r["requiresRegeneration"] is False
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_remove_all_lounges(self):
        r = _build("Remove all lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_remove_the_lounges(self):
        r = _build("Remove the lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_delete_all_the_lounges(self):
        r = _build("Delete all the lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_hide_lounges(self):
        assert _build("Hide lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_get_rid_of_lounges(self):
        assert _build("Get rid of lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_no_more_lounges(self):
        assert _build("No more lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_clear_all_lounges(self):
        r = _build("Clear all lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_eliminate_lounges(self):
        r = _build("Eliminate lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_take_away_lounges(self):
        assert _build("Take away lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_add_all_lounges(self):
        assert _build("Add all lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    # entrance
    def test_add_entrance(self):
        assert _build("Add entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_include_entrance(self):
        assert _build("Include entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_enable_entrance(self):
        assert _build("Enable entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_remove_entrance(self):
        r = _build("Remove entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_no_entrance(self):
        assert _build("No entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_delete_the_entrance(self):
        r = _build("Delete the entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_hide_entrance(self):
        assert _build("Hide entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_get_rid_of_entrance(self):
        assert _build("Get rid of entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_no_more_entrance(self):
        assert _build("No more entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    # ── named-element qualifier words (e.g. "Main Entrance", "Side Lounge") ─
    def test_delete_main_entrance(self):
        r = _build("Delete Main Entrance", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_remove_main_entrance(self):
        r = _build("Remove Main Entrance", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_delete_the_main_entrance(self):
        r = _build("Delete the Main Entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_hide_the_main_entrance(self):
        assert _build("Hide the Main Entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_no_main_entrance(self):
        assert _build("No Main Entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_add_main_entrance(self):
        assert _build("Add Main Entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_include_the_main_entrance(self):
        assert _build("Include the Main Entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_restore_main_entrance(self):
        assert _build("Restore Main Entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_delete_side_entrance(self):
        r = _build("Delete Side Entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_delete_main_lounge(self):
        r = _build("Delete Main Lounge.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_remove_central_lounge(self):
        r = _build("Remove Central Lounge.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_delete_study_lounge(self):
        r = _build("Delete Study Lounge.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_add_main_lounge(self):
        assert _build("Add Main Lounge.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_remove_connection_bridges(self):
        r = _build("Remove Connection Bridges.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_delete_main_bridges(self):
        r = _build("Delete Main Bridges.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_add_connector_bridges(self):
        assert _build("Add Connector Bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    # wing backgrounds
    def test_add_wing_backgrounds(self):
        assert _build("Add wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_include_backgrounds(self):
        assert _build("Include backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_remove_wing_backgrounds(self):
        r = _build("Remove wing backgrounds.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    def test_disable_backgrounds(self):
        assert _build("Disable backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_no_backgrounds(self):
        assert _build("No backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_hide_all_backgrounds(self):
        assert _build("Hide all backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_get_rid_of_wing_backgrounds(self):
        assert _build("Get rid of wing backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_no_more_backgrounds(self):
        assert _build("No more backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_clear_backgrounds(self):
        r = _build("Clear backgrounds.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    def test_eliminate_backgrounds(self):
        r = _build("Eliminate backgrounds.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    def test_take_out_backgrounds(self):
        r = _build("Take out backgrounds.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False


# ===========================================================================
# WING LABEL MODE
# ===========================================================================

class TestWingLabelMode:
    # ── area mode – existing phrases ────────────────────────────────────────
    def test_label_gray_boxes_as_areas(self):
        r = _build("Label left and right gray boxes as Areas", current={"wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert any(c["field"] == "wingLabelMode" and c["value"] == "area" for c in r["commands"])

    def test_label_wings_as_areas(self):
        assert _build("Label wings as areas.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_show_area_labels(self):
        assert _build("Show area labels.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_use_area_labels(self):
        assert _build("Use area labels.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_name_them_areas(self):
        assert _build("Name them areas.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_call_them_areas(self):
        assert _build("Call them areas.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    # ── area mode – zone / section / block synonyms ─────────────────────────
    def test_label_wings_as_zones(self):
        assert _build("Label wings as zones.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_label_wings_as_sections(self):
        assert _build("Label wings as sections.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_label_wings_as_blocks(self):
        assert _build("Label wings as blocks.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_name_them_zones(self):
        assert _build("Name them zones.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_call_them_sections(self):
        assert _build("Call them sections.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_rename_wings_to_zones(self):
        assert _build("Rename wings to zones.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_relabel_wings_as_zones(self):
        assert _build("Relabel wings as zones.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_designate_wings_as_areas(self):
        assert _build("Designate wings as areas.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_mark_wings_as_zones(self):
        assert _build("Mark wings as zones.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_switch_to_area_mode(self):
        assert _build("Switch to area mode.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    # ── area mode – regex-driven natural phrases ─────────────────────────────
    def test_label_3_wings_as_zones(self):
        # The "3" must NOT change wing count — only the label mode should change
        r = _build("Label the 3 wings as zones.", current={"wingCount": 4, "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["wingCount"] == 4  # count unchanged

    def test_name_wings_as_research_zones(self):
        # "research" must NOT change profile to laboratory in a labeling phrase
        r = _build("Name the wings as research zones.", current={"profile": "academic", "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["profile"] == "academic"  # profile unchanged

    def test_label_wings_as_office_sections(self):
        r = _build("Label the wings as office sections.", current={"profile": "academic", "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["profile"] == "academic"  # profile unchanged

    def test_call_wings_corporate_zones(self):
        r = _build("Call the wings corporate zones.", current={"profile": "academic", "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["profile"] == "academic"

    def test_designate_wings_as_classroom_areas(self):
        r = _build("Designate the wings as classroom areas.", current={"profile": "office", "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["profile"] == "office"

    def test_rename_wings_as_laboratory_blocks(self):
        r = _build("Rename wings as laboratory blocks.", current={"profile": "academic", "wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["proposedConfig"]["profile"] == "academic"

    # ── wing mode – existing and new phrases ────────────────────────────────
    def test_label_gray_boxes_as_wings(self):
        r = _build("Label gray boxes as wings.", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_areas_as_wings(self):
        assert _build("Label areas as wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_show_wing_labels(self):
        assert _build("Show wing labels.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_use_wing_labels(self):
        assert _build("Use wing labels.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_name_them_wings(self):
        assert _build("Name them wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_call_them_wings(self):
        assert _build("Call them wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_rename_zones_to_wings(self):
        assert _build("Rename zones to wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_rename_areas_to_wings(self):
        assert _build("Rename areas to wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_relabel_zones_as_wings(self):
        assert _build("Relabel zones as wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_switch_to_wing_mode(self):
        assert _build("Switch to wing mode.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_switch_back_to_wings(self):
        assert _build("Switch back to wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_sections_as_wings(self):
        assert _build("Label sections as wings.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    # ── singular gray box with position qualifier ────────────────────────────
    def test_label_the_left_gray_box_as_wing_1(self):
        r = _build("Label the left gray box as Wing 1", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"
        assert r["requiresRegeneration"] is False
        assert any("Wing A" in a for a in r["assumptions"])  # numbered → lettered note

    def test_label_the_right_gray_box_as_wing_3(self):
        r = _build("Label the right gray box as Wing 3", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"
        assert any("Wing A" in a for a in r["assumptions"])

    def test_label_the_center_gray_box_as_wing(self):
        assert _build("Label the center gray box as Wing.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_the_left_gray_box_as_wing_a(self):
        r = _build("Label the left gray box as Wing A", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_left_gray_area_as_wing_a(self):
        r = _build("Label left gray area as Wing A", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"
        assert any("Specific left/right gray-area targeting is not configurable yet" in a for a in r["assumptions"])

    def test_label_right_gray_region_as_wing_b(self):
        r = _build("Label the right gray region as Wing B", current={"wingLabelMode": "area"})
        assert r["proposedConfig"]["wingLabelMode"] == "wing"
        assert any("applies wing labels globally" in a for a in r["assumptions"])

    def test_label_the_right_gray_box_as_wing_b(self):
        assert _build("Label the right gray box as Wing B", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_left_gray_box_as_wing_no_the(self):
        assert _build("Label left gray box as Wing 1", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_the_gray_box_as_wing(self):
        assert _build("Label the gray box as Wing 2.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_name_the_left_gray_box_wing(self):
        assert _build("Name the left gray box Wing 1.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_call_the_right_gray_box_wing(self):
        assert _build("Call the right gray box Wing 2.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_the_first_gray_box_as_wing(self):
        assert _build("Label the first gray box as Wing.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    def test_label_the_last_gray_box_as_wing(self):
        assert _build("Label the last gray box as Wing.", current={"wingLabelMode": "area"})["proposedConfig"]["wingLabelMode"] == "wing"

    # ── singular gray box → area mode ───────────────────────────────────────
    def test_label_the_left_gray_box_as_area_1(self):
        r = _build("Label the left gray box as Area 1", current={"wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert r["requiresRegeneration"] is False

    def test_label_left_gray_area_as_area_1(self):
        r = _build("Label left gray area as Area 1", current={"wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert any("Specific left/right gray-area targeting is not configurable yet" in a for a in r["assumptions"])

    def test_label_the_right_gray_box_as_zone_3(self):
        assert _build("Label the right gray box as Zone 3", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    def test_label_center_gray_background_as_zone_3(self):
        r = _build("Label the center gray background as Zone 3", current={"wingLabelMode": "wing"})
        assert r["proposedConfig"]["wingLabelMode"] == "area"
        assert any("applies the area/zone label style to all wing background labels" in a for a in r["assumptions"])

    def test_label_the_center_gray_box_as_section(self):
        assert _build("Label the center gray box as Section B.", current={"wingLabelMode": "wing"})["proposedConfig"]["wingLabelMode"] == "area"

    # ── numbered wing note in assumption ────────────────────────────────────
    def test_numbered_wing_assumption_note_added(self):
        r = _build("Label the left gray box as Wing 1", current={"wingLabelMode": "area"})
        assert any("letters" in a or "Wing A" in a for a in r["assumptions"])

    def test_lettered_wing_has_no_number_note(self):
        r = _build("Label the left gray box as Wing A", current={"wingLabelMode": "area"})
        # No extra note about letter/number mapping needed
        assert r["proposedConfig"]["wingLabelMode"] == "wing"

    # ── requiresRegeneration is False for all label-only changes ────────────
    def test_no_regeneration_for_gray_box_wing_label(self):
        assert _build("Label the left gray box as Wing 1", current={"wingLabelMode": "area"})["requiresRegeneration"] is False

    def test_no_regeneration_for_gray_box_area_label(self):
        assert _build("Label the left gray box as Area 1", current={"wingLabelMode": "wing"})["requiresRegeneration"] is False

    # ── requiresRegeneration must be FALSE for label-only changes ────────────
    def test_requires_no_regeneration_for_area_mode(self):
        r = _build("Label wings as areas.", current={"wingLabelMode": "wing"})
        assert r["requiresRegeneration"] is False

    def test_requires_no_regeneration_for_wing_mode(self):
        r = _build("Show wing labels.", current={"wingLabelMode": "area"})
        assert r["requiresRegeneration"] is False

    def test_requires_no_regeneration_for_hide_wing_labels(self):
        r = _build("Hide wing labels.", current={"includeWingBackgrounds": True})
        assert r["requiresRegeneration"] is False

    def test_requires_regeneration_when_combined_with_structural_change(self):
        # wingLabelMode + roomsPerWing → must still regenerate
        r = _build("Label wings as areas and add more rooms.", current={"wingLabelMode": "wing", "roomsPerWing": 6})
        assert r["requiresRegeneration"] is True
        assert r["proposedConfig"]["wingLabelMode"] == "area"

    def test_reply_says_preserved_for_label_only(self):
        r = _build("Label wings as areas.", current={"wingLabelMode": "wing"})
        assert "preserved" in r["reply"] or "not be regenerated" in r["assumptions"][0]

    # ── hide wing labels ─────────────────────────────────────────────────────
    def test_hide_wing_labels(self):
        r = _build("Hide wing labels.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    def test_remove_wing_labels(self):
        r = _build("Remove wing labels.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    def test_no_wing_labels(self):
        r = _build("No wing labels.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    # ── wing count is NOT changed when intent is labeling ────────────────────
    def test_label_3_wings_does_not_change_wing_count(self):
        r = _build("Label the 3 wings as areas.", current={"wingCount": 4})
        assert r["proposedConfig"]["wingCount"] == 4

    def test_rename_all_wings_does_not_change_wing_count(self):
        r = _build("Rename all the wings as research sections.", current={"wingCount": 3})
        assert r["proposedConfig"]["wingCount"] == 3

    def test_designate_2_wings_does_not_reduce_wing_count(self):
        r = _build("Designate the 2 wings as zones.", current={"wingCount": 3})
        assert r["proposedConfig"]["wingCount"] == 3

    def test_label_count_assumption_is_added(self):
        r = _build("Label the 3 wings as zones.", current={"wingCount": 4})
        assert any("wing-labeling context" in a for a in r["assumptions"])

    # ── profile is NOT changed when keyword is a label name ──────────────────
    def test_research_zones_does_not_change_profile(self):
        r = _build("Label wings as research zones.", current={"profile": "academic"})
        assert r["proposedConfig"]["profile"] == "academic"

    def test_office_sections_does_not_change_profile(self):
        r = _build("Name wings as office sections.", current={"profile": "academic"})
        assert r["proposedConfig"]["profile"] == "academic"

    def test_corporate_blocks_does_not_change_profile(self):
        r = _build("Call the wings corporate blocks.", current={"profile": "academic"})
        assert r["proposedConfig"]["profile"] == "academic"

    def test_classroom_areas_does_not_change_profile(self):
        r = _build("Designate wings as classroom areas.", current={"profile": "office"})
        assert r["proposedConfig"]["profile"] == "office"

    def test_laboratory_zones_does_not_change_profile(self):
        r = _build("Rename wings as laboratory zones.", current={"profile": "academic"})
        assert r["proposedConfig"]["profile"] == "academic"

    def test_campus_sections_does_not_change_profile(self):
        r = _build("Mark wings as campus sections.", current={"profile": "office"})
        assert r["proposedConfig"]["profile"] == "office"

    # ── profile IS changed when it's the actual building type request ────────
    def test_research_building_does_change_profile(self):
        assert _build("Research building layout.", current={"profile": "academic"})["proposedConfig"]["profile"] == "laboratory"

    def test_corporate_office_does_change_profile(self):
        assert _build("Corporate office layout.", current={"profile": "academic"})["proposedConfig"]["profile"] == "office"

    def test_switch_to_lab_profile_does_change(self):
        assert _build("Switch to laboratory profile.", current={"profile": "academic"})["proposedConfig"]["profile"] == "laboratory"


# ===========================================================================
# LAYOUT OFFSET / POSITION
# ===========================================================================

class TestLayoutOffset:
    def test_shift_right(self):
        r = _build("Shift right.", current={"offsetX": 0})
        assert r["proposedConfig"]["offsetX"] == 40
        assert any(c["type"] == "moveWing" and c["field"] == "offsetX" for c in r["commands"])

    def test_move_right(self):
        assert _build("Move right.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == 40

    def test_nudge_right(self):
        assert _build("Nudge right.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == 40

    def test_push_right(self):
        assert _build("Push right.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == 40

    def test_shift_left(self):
        assert _build("Shift left.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == -40

    def test_move_left(self):
        assert _build("Move left.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == -40

    def test_nudge_left(self):
        assert _build("Nudge left.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == -40

    def test_push_left(self):
        assert _build("Push left.", current={"offsetX": 0})["proposedConfig"]["offsetX"] == -40

    def test_move_up(self):
        assert _build("Move up.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == -40

    def test_higher(self):
        assert _build("Higher.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == -40

    def test_nudge_up(self):
        assert _build("Nudge up.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == -40

    def test_push_up(self):
        assert _build("Push up.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == -40

    def test_shift_up(self):
        assert _build("Shift up.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == -40

    def test_move_down(self):
        assert _build("Move down.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == 40

    def test_lower(self):
        assert _build("Lower.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == 40

    def test_nudge_down(self):
        assert _build("Nudge down.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == 40

    def test_push_down(self):
        assert _build("Push down.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == 40

    def test_shift_down(self):
        assert _build("Shift down.", current={"offsetY": 0})["proposedConfig"]["offsetY"] == 40

    def test_offsetX_clamps_max(self):
        assert _build("Move right.", current={"offsetX": 400})["proposedConfig"]["offsetX"] == 400

    def test_offsetX_clamps_min(self):
        assert _build("Move left.", current={"offsetX": -400})["proposedConfig"]["offsetX"] == -400

    def test_offsetY_clamps_max(self):
        assert _build("Move down.", current={"offsetY": 400})["proposedConfig"]["offsetY"] == 400

    def test_offsetY_clamps_min(self):
        assert _build("Move up.", current={"offsetY": -400})["proposedConfig"]["offsetY"] == -400


# ===========================================================================
# UNDO / REVERT
# ===========================================================================

class TestUndoRevert:
    def test_revert_previous_change(self):
        r = _build("Revert previous change", current={"profile": "mixed", "hallwayThickness": 48, "roomsPerWing": 6}, previous={"profile": "academic", "hallwayThickness": 40, "roomsPerWing": 8})
        assert r["proposedConfig"]["profile"] == "academic"
        assert r["proposedConfig"]["hallwayThickness"] == 40
        assert r["proposedConfig"]["roomsPerWing"] == 8
        assert any("reverting the most recent preview change" in a for a in r["assumptions"])

    def test_undo_last_change(self):
        assert _build("Undo last change", current={"wingCount": 4}, previous={"wingCount": 3})["proposedConfig"]["wingCount"] == 3

    def test_go_back_to_previous(self):
        assert _build("Go back to previous", current={"floorCount": 5}, previous={"floorCount": 3})["proposedConfig"]["floorCount"] == 3

    def test_restore_previous(self):
        assert _build("Restore previous change", current={"density": "high"}, previous={"density": "low"})["proposedConfig"]["density"] == "low"

    def test_undo_that(self):
        assert _build("Undo that", current={"wingCount": 4}, previous={"wingCount": 3})["proposedConfig"]["wingCount"] == 3

    def test_undo_it(self):
        assert _build("Undo it", current={"floorCount": 5}, previous={"floorCount": 3})["proposedConfig"]["floorCount"] == 3

    # ── bare revert phrases (no qualifier needed) ───────────────────────────

    def test_bare_undo(self):
        assert _build("Undo", current={"wingCount": 4}, previous={"wingCount": 3})["proposedConfig"]["wingCount"] == 3

    def test_bare_revert(self):
        assert _build("Revert", current={"floorCount": 5}, previous={"floorCount": 3})["proposedConfig"]["floorCount"] == 3

    def test_bare_go_back(self):
        assert _build("Go back", current={"density": "high"}, previous={"density": "low"})["proposedConfig"]["density"] == "low"

    def test_rollback(self):
        assert _build("Rollback", current={"roomScale": 115}, previous={"roomScale": 100})["proposedConfig"]["roomScale"] == 100

    def test_rollback_last_change(self):
        assert _build("Rollback last change", current={"hallwayThickness": 48}, previous={"hallwayThickness": 40})["proposedConfig"]["hallwayThickness"] == 40

    def test_cancel_last_change(self):
        assert _build("Cancel last change", current={"wingCount": 4}, previous={"wingCount": 3})["proposedConfig"]["wingCount"] == 3

    def test_cancel_that_change(self):
        assert _build("Cancel that change", current={"profile": "mixed"}, previous={"profile": "academic"})["proposedConfig"]["profile"] == "academic"

    # ── bare undo warns if no previous config ───────────────────────────────

    def test_bare_undo_warns_if_no_previous(self):
        r = _build("Undo", current={"profile": "mixed"}, previous=None)
        assert r["configPatch"] == {}
        assert r["requiresRegeneration"] is False
        assert "No previous" in r["reply"] or any("No previous" in w for w in r["warnings"])

    def test_bare_revert_warns_if_no_previous(self):
        r = _build("Revert", current={"wingCount": 4}, previous=None)
        assert r["configPatch"] == {}
        assert r["requiresRegeneration"] is False

    def test_go_back_warns_if_no_previous(self):
        r = _build("Go back", current={"density": "high"}, previous=None)
        assert r["configPatch"] == {}
        assert r["requiresRegeneration"] is False

    def test_rollback_warns_if_no_previous(self):
        r = _build("Rollback", current={"roomScale": 115}, previous=None)
        assert r["configPatch"] == {}
        assert r["requiresRegeneration"] is False

    # ── "restore X" is NOT treated as undo (toggle phrase) ─────────────────

    def test_restore_bridges_is_not_undo(self):
        r = _build("Restore bridges.", current={"includeBridges": False})
        assert r["proposedConfig"]["includeBridges"] is True
        assert not any("reverting" in a for a in r["assumptions"])

    def test_restore_lounges_is_not_undo(self):
        r = _build("Restore lounges.", current={"includeLounges": False})
        assert r["proposedConfig"]["includeLounges"] is True

    # ── existing qualifier-based phrases still work ─────────────────────────

    def test_revert_with_no_previous_warns(self):
        r = _build("Revert previous change", current={"profile": "mixed"}, previous=None)
        assert r["configPatch"] == {}
        assert r["requiresRegeneration"] is False

    def test_command_type_hallway(self):
        r = _build("Undo previous change", current={"hallwayThickness": 48}, previous={"hallwayThickness": 40})
        assert any(c["type"] == "resizeHallway" for c in r["commands"])

    def test_command_type_rooms_per_wing(self):
        r = _build("Undo previous change", current={"roomsPerWing": 10}, previous={"roomsPerWing": 8})
        assert any(c["type"] == "rebalanceRooms" for c in r["commands"])

    def test_command_type_offset(self):
        r = _build("Revert previous change", current={"offsetX": 40}, previous={"offsetX": 0})
        assert any(c["type"] == "moveWing" for c in r["commands"])

    def test_command_type_wing_scale_overrides(self):
        r = _build("Undo previous change", current={"wingRoomScaleOverrides": {"A": 115}}, previous={"wingRoomScaleOverrides": {}})
        assert any(c["type"] == "resizeRooms" for c in r["commands"])


# ===========================================================================
# normalize_config VALIDATION & CLAMPING
# ===========================================================================

class TestNormalizeConfig:
    def test_clamps_floor_count_high(self):
        assert SandboxLayoutArrangerService.normalize_config({"floorCount": 99})["floorCount"] == 10

    def test_clamps_floor_count_low(self):
        assert SandboxLayoutArrangerService.normalize_config({"floorCount": 0})["floorCount"] == 1

    def test_clamps_width_low(self):
        assert SandboxLayoutArrangerService.normalize_config({"width": 500})["width"] == 1200

    def test_clamps_height_high(self):
        assert SandboxLayoutArrangerService.normalize_config({"height": 5000})["height"] == 1800

    def test_clamps_hallway_thickness_high(self):
        assert SandboxLayoutArrangerService.normalize_config({"hallwayThickness": 200})["hallwayThickness"] == 120

    def test_clamps_room_scale_low(self):
        assert SandboxLayoutArrangerService.normalize_config({"roomScale": 10})["roomScale"] == 60

    def test_invalid_profile_falls_back(self):
        assert SandboxLayoutArrangerService.normalize_config({"profile": "hospital"})["profile"] == "academic"

    def test_invalid_density_falls_back(self):
        assert SandboxLayoutArrangerService.normalize_config({"density": "ultra"})["density"] == "medium"

    def test_invalid_placement_pattern_falls_back(self):
        assert SandboxLayoutArrangerService.normalize_config({"placementPattern": "zigzag"})["placementPattern"] == "double-loaded"

    def test_invalid_wing_label_mode_falls_back(self):
        assert SandboxLayoutArrangerService.normalize_config({"wingLabelMode": "zone"})["wingLabelMode"] == "wing"

    def test_none_uses_defaults(self):
        c = SandboxLayoutArrangerService.normalize_config(None)
        assert c["profile"] == "academic"
        assert c["density"] == "medium"
        assert c["floorCount"] == 3

    def test_wing_scale_override_filters_invalid_keys(self):
        c = SandboxLayoutArrangerService.normalize_config({"wingRoomScaleOverrides": {"Z": 100, "A": 110, "F": 90}})
        assert "Z" not in c["wingRoomScaleOverrides"]
        assert "F" not in c["wingRoomScaleOverrides"]
        assert c["wingRoomScaleOverrides"]["A"] == 110

    def test_wing_scale_override_lowercased_key_uppercased(self):
        c = SandboxLayoutArrangerService.normalize_config({"wingRoomScaleOverrides": {"a": 110}})
        assert c["wingRoomScaleOverrides"]["A"] == 110

    def test_wing_scale_override_clamped(self):
        c = SandboxLayoutArrangerService.normalize_config({"wingRoomScaleOverrides": {"A": 999}})
        assert c["wingRoomScaleOverrides"]["A"] == 140


# ===========================================================================
# COMBINED / MULTI-CHANGE REQUESTS
# ===========================================================================

class TestCombined:
    def test_multi_change_all_fields(self):
        r = _build("Use 4 wings, 2 floors, 10 rooms per wing, and single-loaded corridors without bridges.")
        assert r["proposedConfig"]["wingCount"] == 4
        assert r["proposedConfig"]["floorCount"] == 2
        assert r["proposedConfig"]["roomsPerWing"] == 10
        assert r["proposedConfig"]["placementPattern"] == "single-loaded"
        assert r["proposedConfig"]["includeBridges"] is False

    def test_mixed_use_wider_corridors_fewer_rooms(self):
        r = _build("Make this more like a mixed-use building with wider corridors and fewer rooms.", current={"profile": "academic", "roomsPerWing": 8, "hallwayThickness": 40})
        assert r["configPatch"]["profile"] == "mixed"
        assert r["configPatch"]["roomsPerWing"] == 6
        assert r["configPatch"]["hallwayThickness"] == 48

    def test_architect_scenario_office_4_story_3_wings(self):
        r = _build("I want a 4-story corporate building with 3 wings.", current={})
        assert r["proposedConfig"]["floorCount"] == 4
        assert r["proposedConfig"]["profile"] == "office"
        assert r["proposedConfig"]["wingCount"] == 3

    def test_architect_scenario_research_single_loaded(self):
        r = _build("Research lab, single corridor layout, spread out rooms.", current={})
        assert r["proposedConfig"]["profile"] == "laboratory"
        assert r["proposedConfig"]["placementPattern"] == "single-loaded"
        assert r["proposedConfig"]["density"] == "low"

    def test_admin_scenario_compact_add_floor(self):
        r = _build("Compact layout, add a floor, no lounges.", current={"floorCount": 3, "includeLounges": True, "density": "low"})
        assert r["proposedConfig"]["density"] == "high"
        assert r["proposedConfig"]["floorCount"] == 4
        assert r["proposedConfig"]["includeLounges"] is False

    def test_engineer_scenario_explicit_dimensions(self):
        r = _build("Set canvas to 2400px wide and 5 floors, room scale at 110%.", current={})
        assert r["proposedConfig"]["width"] == 2400
        assert r["proposedConfig"]["floorCount"] == 5
        assert r["proposedConfig"]["roomScale"] == 110

    def test_reply_includes_changed_fields_width(self):
        r = _build("Make it wider.", current={"width": 1768})
        assert "canvas width" in r["reply"]

    def test_reply_includes_changed_fields_height(self):
        r = _build("Make it taller.", current={"height": 930})
        assert "canvas height" in r["reply"]

    def test_reply_is_generic_when_no_change(self):
        assert "layout preview" in _build("Hello")["reply"]


# ===========================================================================
# FALSE-POSITIVE GUARD: phrases that must NOT change roomsPerWing
# Covers all delete/remove/eliminate/take-out verbs applied to non-room nouns
# ===========================================================================

_BASE_ALL = {
    "roomsPerWing": 8, "wingCount": 3, "floorCount": 2, "hallwayThickness": 3,
    "roomScaleGlobal": 1.0, "corridorPattern": "double", "density": 0.5,
    "canvasWidth": 1200, "canvasHeight": 800, "profile": "office",
    "includeBridges": True, "includeLounges": True, "includeEntrance": True,
    "includeWingBackgrounds": True, "wingLabelMode": "none", "includeHallways": True,
    "offsetX": 0, "offsetY": 0,
}


class TestNoFalseRoomCountChange:
    """Phrases that contain room-type nouns as adjectives or modifiers of toggle
    elements must NOT be mistaken for room-count operations."""

    # ── "space" ambiguity ────────────────────────────────────────────────────
    def test_remove_the_space_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove the space.", current=_BASE_ALL)["configPatch"]

    def test_add_a_space_no_room_change(self):
        assert "roomsPerWing" not in _build("Add a space.", current=_BASE_ALL)["configPatch"]

    def test_remove_a_space_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove a space.", current=_BASE_ALL)["configPatch"]

    # ── "office" as adjective before toggle nouns ────────────────────────────
    def test_remove_an_office_lounge_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove an office lounge.", current=_BASE_ALL)["configPatch"]

    def test_delete_the_office_bridge_no_room_change(self):
        assert "roomsPerWing" not in _build("Delete the office bridge.", current=_BASE_ALL)["configPatch"]

    def test_eliminate_the_office_bridge_no_room_change(self):
        assert "roomsPerWing" not in _build("Eliminate the office bridge.", current=_BASE_ALL)["configPatch"]

    def test_take_out_the_office_lounge_no_room_change(self):
        assert "roomsPerWing" not in _build("Take out the office lounge.", current=_BASE_ALL)["configPatch"]

    # ── "lab" as adjective before toggle nouns ───────────────────────────────
    def test_remove_the_lab_entrance_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove the lab entrance.", current=_BASE_ALL)["configPatch"]

    def test_delete_a_lab_lounge_no_room_change(self):
        assert "roomsPerWing" not in _build("Delete a lab lounge.", current=_BASE_ALL)["configPatch"]

    def test_remove_the_lab_corridor_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove the lab corridor.", current=_BASE_ALL)["configPatch"]

    # ── "classroom" / "workspace" as adjective before toggle nouns ──────────
    def test_remove_the_classroom_hallway_no_room_change(self):
        assert "roomsPerWing" not in _build("Remove the classroom hallway.", current=_BASE_ALL)["configPatch"]

    def test_delete_the_workspace_bridge_no_room_change(self):
        assert "roomsPerWing" not in _build("Delete the workspace bridge.", current=_BASE_ALL)["configPatch"]

    # ── profile-keyword labeling phrases must not change room count ──────────
    def test_label_wings_as_research_zones_no_room_change(self):
        assert "roomsPerWing" not in _build("Label wings as research zones.", current=_BASE_ALL)["configPatch"]

    def test_label_wings_as_corporate_sections_no_room_change(self):
        assert "roomsPerWing" not in _build("Label wings as corporate sections.", current=_BASE_ALL)["configPatch"]

    def test_call_wings_classroom_areas_no_room_change(self):
        assert "roomsPerWing" not in _build("Call the wings classroom areas.", current=_BASE_ALL)["configPatch"]


# ===========================================================================
# ALL-VERB TOGGLE COVERAGE
# Every supported on/off verb for each toggle field
# ===========================================================================

class TestToggleVerbCoverage:
    """Comprehensive coverage of on/off verbs for all four toggle fields."""

    # ── includeBridges: delete/remove/clear/eliminate/take-out → canvas delete ─
    def test_remove_bridges(self):
        assert _build("Remove bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_delete_bridges(self):
        r = _build("Delete bridges.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_clear_bridges(self):
        assert _build("Clear bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_eliminate_bridges(self):
        r = _build("Eliminate bridges.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_take_out_bridges(self):
        r = _build("Take out bridges.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    # ── includeBridges: disable/hide/no/without → config flag ───────────────
    def test_disable_bridges(self):
        assert _build("Disable bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_turn_off_bridges(self):
        assert _build("Turn off bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_switch_off_bridges(self):
        assert _build("Switch off bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_shut_off_bridges(self):
        assert _build("Shut off bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_hide_bridges(self):
        assert _build("Hide bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_no_bridges(self):
        assert _build("No bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_without_bridges(self):
        assert _build("Without bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_no_more_bridges(self):
        assert _build("No more bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_get_rid_of_bridges(self):
        assert _build("Get rid of bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    def test_take_away_bridges(self):
        assert _build("Take away bridges.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    # ── bridge singular ──────────────────────────────────────────────────────
    def test_remove_the_bridge(self):
        r = _build("Remove the bridge.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_delete_the_office_bridge(self):
        r = _build("Delete the office bridge.", current={"includeBridges": True})
        assert r["proposedConfig"]["includeBridges"] is False

    def test_turn_off_the_bridge(self):
        assert _build("Turn off the bridge.", current={"includeBridges": True})["proposedConfig"]["includeBridges"] is False

    # ── includeBridges on ────────────────────────────────────────────────────
    def test_enable_bridges(self):
        assert _build("Enable bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_add_bridges(self):
        assert _build("Add bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_include_bridges(self):
        assert _build("Include bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_show_bridges(self):
        assert _build("Show bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_restore_bridges(self):
        assert _build("Restore bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_turn_on_bridges(self):
        assert _build("Turn on bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_switch_on_bridges(self):
        assert _build("Switch on bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_with_bridges(self):
        assert _build("With bridges.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_enable_bridge_singular(self):
        assert _build("Enable bridge.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    def test_add_bridge_singular(self):
        assert _build("Add bridge.", current={"includeBridges": False})["proposedConfig"]["includeBridges"] is True

    # ── includeLounges off ───────────────────────────────────────────────────
    def test_remove_all_lounges(self):
        r = _build("Remove all lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_delete_all_lounges(self):
        r = _build("Delete all lounges.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_disable_lounge(self):
        assert _build("Disable the lounge.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_turn_off_lounges(self):
        assert _build("Turn off lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_switch_off_lounges(self):
        assert _build("Switch off lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_shut_off_lounge(self):
        assert _build("Shut off the lounge.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_remove_an_office_lounge(self):
        r = _build("Remove an office lounge.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_delete_the_lab_lounge(self):
        r = _build("Delete the lab lounge.", current={"includeLounges": True})
        assert any(c["type"] == "deleteAllElements" and c["value"] == "lounge" for c in r["commands"])

    def test_hide_lounge(self):
        assert _build("Hide lounge.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_no_lounges(self):
        assert _build("No lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    def test_get_rid_of_lounges(self):
        assert _build("Get rid of lounges.", current={"includeLounges": True})["proposedConfig"]["includeLounges"] is False

    # ── includeLounges on ────────────────────────────────────────────────────
    def test_enable_lounges(self):
        assert _build("Enable lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_add_lounges(self):
        assert _build("Add lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_show_lounges(self):
        assert _build("Show lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_turn_on_lounges(self):
        assert _build("Turn on lounges.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    def test_include_lounge(self):
        assert _build("Include lounge.", current={"includeLounges": False})["proposedConfig"]["includeLounges"] is True

    # ── includeEntrance off ──────────────────────────────────────────────────
    def test_remove_the_lab_entrance(self):
        r = _build("Remove the lab entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    def test_turn_off_entrance(self):
        assert _build("Turn off entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_switch_off_entrance(self):
        assert _build("Switch off entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_shut_off_entrance(self):
        assert _build("Shut off the entrance.", current={"includeEntrance": True})["proposedConfig"]["includeEntrance"] is False

    def test_eliminate_entrance(self):
        r = _build("Eliminate entrance.", current={"includeEntrance": True})
        assert r["proposedConfig"]["includeEntrance"] is False

    # ── includeEntrance on ───────────────────────────────────────────────────
    def test_turn_on_entrance(self):
        assert _build("Turn on entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_switch_on_entrance(self):
        assert _build("Switch on entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    def test_bring_back_entrance(self):
        assert _build("Bring back entrance.", current={"includeEntrance": False})["proposedConfig"]["includeEntrance"] is True

    # ── includeWingBackgrounds off ───────────────────────────────────────────
    def test_turn_off_wing_backgrounds(self):
        assert _build("Turn off wing backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_switch_off_wing_backgrounds(self):
        assert _build("Switch off wing backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_shut_off_backgrounds(self):
        assert _build("Shut off backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_hide_wing_backgrounds(self):
        assert _build("Hide wing backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_disable_backgrounds(self):
        assert _build("Disable backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_no_wing_backgrounds(self):
        assert _build("No wing backgrounds.", current={"includeWingBackgrounds": True})["proposedConfig"]["includeWingBackgrounds"] is False

    def test_remove_backgrounds(self):
        r = _build("Remove backgrounds.", current={"includeWingBackgrounds": True})
        assert r["proposedConfig"]["includeWingBackgrounds"] is False

    # ── includeWingBackgrounds on ────────────────────────────────────────────
    def test_turn_on_wing_backgrounds(self):
        assert _build("Turn on wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_switch_on_wing_backgrounds(self):
        assert _build("Switch on wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_show_wing_backgrounds(self):
        assert _build("Show wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_enable_backgrounds(self):
        assert _build("Enable backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_restore_wing_backgrounds(self):
        assert _build("Restore wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True

    def test_add_wing_backgrounds(self):
        assert _build("Add wing backgrounds.", current={"includeWingBackgrounds": False})["proposedConfig"]["includeWingBackgrounds"] is True


class TestUndoRoutingFallback:
    def setup_method(self):
        with sb_router._LAYOUT_CONFIG_HISTORY_LOCK:
            sb_router._LAYOUT_CONFIG_HISTORY.clear()

    def test_restore_previous_change_uses_router_history(self):
        sb_router.plan_sandbox_layout_arrangement({
            "message": "Use 4 wings.",
            "currentConfig": {"wingCount": 3},
        })

        result = sb_router.plan_sandbox_layout_arrangement({
            "message": "Restore the previous change.",
            "currentConfig": {"wingCount": 4},
        })

        assert result["configPatch"]["wingCount"] == 3
        assert result["proposedConfig"]["wingCount"] == 3

    def test_cancel_last_change_supports_repeat_undo(self):
        sb_router.plan_sandbox_layout_arrangement({
            "message": "Use 4 wings.",
            "currentConfig": {"wingCount": 3},
        })
        sb_router.plan_sandbox_layout_arrangement({
            "message": "Use 5 wings.",
            "currentConfig": {"wingCount": 4},
        })

        first_undo = sb_router.plan_sandbox_layout_arrangement({
            "message": "Cancel that change.",
            "currentConfig": {"wingCount": 5},
        })
        second_undo = sb_router.plan_sandbox_layout_arrangement({
            "message": "Undo it.",
            "currentConfig": {"wingCount": 4},
        })

        assert first_undo["proposedConfig"]["wingCount"] == 4
        assert second_undo["proposedConfig"]["wingCount"] == 3


class TestUndoDetectionHelper:
    def test_restore_previous_change_is_undo(self):
        assert is_undo_request("Restore the previous change.") is True

    def test_cancel_that_change_is_undo(self):
        assert is_undo_request("Cancel that change.") is True

    def test_restore_bridges_is_not_undo(self):
        assert is_undo_request("Restore bridges.") is False


class TestScenarioCoverageGaps:
    def test_hallway_cleanup_can_fall_back_to_reducing_rooms(self):
        result = _build(
            "Fix overlapping hallways.",
            current={
                "hallwayThickness": 20,
                "placementPattern": "single-loaded",
                "roomsPerWing": 4,
                "includeBridges": True,
                "wingCount": 3,
            },
        )
        assert result["proposedConfig"]["roomsPerWing"] == 3
        assert any("reducing rooms per wing from 4 to 3" in note for note in result["assumptions"])

    def test_hallway_cleanup_warns_when_all_fallbacks_are_exhausted(self):
        result = _build(
            "Resolve overlapping hallways.",
            current={
                "hallwayThickness": 20,
                "placementPattern": "single-loaded",
                "roomsPerWing": 1,
                "includeBridges": False,
                "wingCount": 1,
            },
        )
        assert result["configPatch"] == {}
        assert any("already minimal for hallway density" in warning for warning in result["warnings"])

    def test_dense_layout_warning_uses_current_layout_summary(self):
        result = _build(
            "Compact layout.",
            current={"density": "medium"},
            summary={"roomCount": 150},
        )
        assert result["proposedConfig"]["density"] == "high"
        assert any("already dense" in warning for warning in result["warnings"])

    def test_reply_mentions_generated_hallways_removed(self):
        result = _build("Remove hallways.", current={"includeHallways": True})
        assert "generated hallways removed" in result["reply"]

    def test_reply_mentions_bridges_removed(self):
        result = _build("Remove bridges.", current={"includeBridges": True})
        assert "bridges" in result["reply"]

    def test_reply_mentions_wing_specific_room_sizing_updated(self):
        result = _build("Set Wing B rooms to 120%.", current={"wingRoomScaleOverrides": {}})
        assert "wing-specific room sizing updated" in result["reply"]

    def test_hide_wing_backgrounds_is_visual_only(self):
        result = _build("Hide wing backgrounds.", current={"includeWingBackgrounds": True})
        assert result["proposedConfig"]["includeWingBackgrounds"] is False
        assert result["requiresRegeneration"] is False
        assert "room layout was preserved" in result["reply"]


# ===========================================================================
# HORIZONTAL HALLWAY — bridge-connector interpretation
# ===========================================================================

class TestHorizontalHallway:
    """'Horizontal hallways/corridors' = delete hallway elements from the canvas
    (same physical action as 'Delete all hallways') — no config change, no regeneration."""

    def _assert_deletes_elements(self, r: dict) -> None:
        assert r["configPatch"] == {}, "must not change any config"
        assert any(
            c.get("type") == "deleteAllElements" and c.get("value") == "hallway"
            for c in r["commands"]
        ), "must issue deleteAllElements for hallway type"
        assert r["requiresRegeneration"] is False

    def test_delete_all_horizontal_hallways(self):
        self._assert_deletes_elements(_build("Delete all horizontal hallways.", current={}))

    def test_remove_horizontal_hallways(self):
        self._assert_deletes_elements(_build("Remove horizontal hallways.", current={}))

    def test_remove_all_horizontal_corridors(self):
        self._assert_deletes_elements(_build("Remove all horizontal corridors.", current={}))

    def test_delete_horizontal_corridors(self):
        self._assert_deletes_elements(_build("Delete horizontal corridors.", current={}))

    def test_get_rid_of_horizontal_hallways(self):
        self._assert_deletes_elements(_build("Get rid of horizontal hallways.", current={}))

    def test_no_horizontal_hallways(self):
        self._assert_deletes_elements(_build("No horizontal hallways.", current={}))

    def test_disable_horizontal_corridors(self):
        self._assert_deletes_elements(_build("Disable horizontal corridors.", current={}))

    def test_hide_horizontal_hallways(self):
        self._assert_deletes_elements(_build("Hide horizontal hallways.", current={}))

    # ── bridges must NOT be disabled ──────────────────────────────────────────
    def test_no_include_bridges_false(self):
        r = _build("Delete all horizontal hallways.", current={"includeBridges": True})
        assert r["configPatch"].get("includeBridges") is None

    # ── includeHallways must NOT be set False ─────────────────────────────────
    def test_no_include_hallways_false(self):
        r = _build("Remove all horizontal hallways.", current={"includeHallways": True})
        assert r["configPatch"].get("includeHallways") is None

    # ── generic "delete all hallways" still works (no horizontal qualifier) ──
    def test_delete_all_hallways_still_removes_hallways(self):
        r = _build("Delete all hallways.", current={"includeHallways": True})
        assert r["configPatch"].get("includeHallways") is None
        assert any(c.get("type") == "deleteAllElements" for c in r["commands"])

    def test_remove_all_corridors_still_removes_corridors(self):
        r = _build("Remove all corridors.", current={"includeHallways": True})
        assert any(c.get("type") == "deleteAllElements" for c in r["commands"])


# ===========================================================================
# RESET TO DEFAULTS
# ===========================================================================

class TestResetToDefaults:
    def test_reset_to_defaults(self):
        r = _build("Reset to defaults.", current={"roomsPerWing": 20, "floorCount": 5, "roomScale": 80})
        assert r["proposedConfig"]["roomsPerWing"] == 8
        assert r["proposedConfig"]["floorCount"] == 3
        assert r["proposedConfig"]["roomScale"] == 100

    def test_start_fresh(self):
        r = _build("Start fresh.", current={"density": "high", "placementPattern": "single-loaded"})
        assert r["proposedConfig"]["density"] == "medium"
        assert r["proposedConfig"]["placementPattern"] == "double-loaded"

    def test_restore_defaults(self):
        r = _build("Restore defaults.", current={"wingCount": 5, "roomsPerWing": 25})
        assert r["proposedConfig"]["wingCount"] == 3
        assert r["proposedConfig"]["roomsPerWing"] == 8

    def test_start_over(self):
        r = _build("Start over.", current={"hallwayThickness": 80, "roomScale": 60})
        assert r["proposedConfig"]["hallwayThickness"] == 40
        assert r["proposedConfig"]["roomScale"] == 100

    def test_factory_reset(self):
        r = _build("Factory reset.", current={"floorCount": 7, "profile": "laboratory"})
        assert r["proposedConfig"]["floorCount"] == 3
        assert r["proposedConfig"]["profile"] == "academic"

    def test_reset_all_settings(self):
        r = _build("Reset all settings.", current={"density": "high", "wingCount": 5})
        assert r["proposedConfig"]["density"] == "medium"
        assert r["proposedConfig"]["wingCount"] == 3

    def test_requires_regeneration(self):
        r = _build("Reset to defaults.", current={"roomsPerWing": 15})
        assert r["requiresRegeneration"] is True


# ===========================================================================
# REGENERATE WITH SAME SETTINGS
# ===========================================================================

class TestRegenerateSameSettings:
    def test_regenerate(self):
        r = _build("Regenerate.")
        assert r["requiresRegeneration"] is True
        assert not r["configPatch"]

    def test_generate_again(self):
        r = _build("Generate again.")
        assert r["requiresRegeneration"] is True

    def test_refresh_layout(self):
        r = _build("Refresh the layout.")
        assert r["requiresRegeneration"] is True

    def test_redo_the_layout(self):
        r = _build("Redo the layout.")
        assert r["requiresRegeneration"] is True

    def test_fresh_generation(self):
        r = _build("Fresh generation.")
        assert r["requiresRegeneration"] is True


# ===========================================================================
# ROOM SIZE PRESETS
# ===========================================================================

class TestRoomSizePresets:
    def test_wide_rooms(self):
        r = _build("Use wide rooms.")
        assert r["proposedConfig"]["roomScale"] == 120

    def test_wide_rooms_alt(self):
        r = _build("I want wider rooms.")
        assert r["proposedConfig"]["roomScale"] == 120

    def test_narrow_rooms(self):
        r = _build("Use narrow rooms.")
        assert r["proposedConfig"]["roomScale"] == 80

    def test_thin_rooms(self):
        r = _build("Use thin rooms.")
        assert r["proposedConfig"]["roomScale"] == 80

    def test_compact_rooms(self):
        r = _build("Use compact rooms.")
        assert r["proposedConfig"]["roomScale"] == 70

    def test_tiny_rooms(self):
        r = _build("Use tiny rooms.")
        assert r["proposedConfig"]["roomScale"] == 70

    def test_spacious_rooms(self):
        r = _build("Use spacious rooms.")
        assert r["proposedConfig"]["roomScale"] == 130

    def test_roomy_layout(self):
        r = _build("I prefer a roomy layout.")
        assert r["proposedConfig"]["roomScale"] == 130


# ===========================================================================
# MIN / MAX ROOM COUNT
# ===========================================================================

class TestMinMaxRoomCount:
    def test_max_rooms(self):
        r = _build("Max out rooms.")
        assert r["proposedConfig"]["roomsPerWing"] == 30

    def test_maximum_rooms(self):
        r = _build("Use maximum rooms.")
        assert r["proposedConfig"]["roomsPerWing"] == 30

    def test_fill_with_rooms(self):
        r = _build("Fill with rooms.")
        assert r["proposedConfig"]["roomsPerWing"] == 30

    def test_minimum_rooms(self):
        r = _build("Use minimum rooms.", current={"roomsPerWing": 10})
        assert r["proposedConfig"]["roomsPerWing"] == 1

    def test_just_one_room(self):
        r = _build("Just one room per wing.", current={"roomsPerWing": 8})
        assert r["proposedConfig"]["roomsPerWing"] == 1

    def test_single_room_per_wing(self):
        r = _build("Single room per wing.", current={"roomsPerWing": 5})
        assert r["proposedConfig"]["roomsPerWing"] == 1


# ===========================================================================
# PERCENTAGE-BASED CANVAS RESIZING
# ===========================================================================

class TestPercentageCanvasResize:
    def test_canvas_20_percent_wider(self):
        r = _build("Make the canvas 20% wider.", current={"width": 1768})
        expected = int(min(round(1768 * 1.20), 3200))
        assert r["proposedConfig"]["width"] == expected

    def test_wider_by_30_percent(self):
        r = _build("Wider by 30%.", current={"width": 1768})
        expected = int(min(round(1768 * 1.30), 3200))
        assert r["proposedConfig"]["width"] == expected

    def test_increase_width_by_15_percent(self):
        r = _build("Increase the canvas width by 15%.", current={"width": 1768})
        expected = int(min(round(1768 * 1.15), 3200))
        assert r["proposedConfig"]["width"] == expected

    def test_canvas_20_percent_narrower(self):
        r = _build("Make the canvas 20% narrower.", current={"width": 1768})
        expected = int(max(round(1768 * 0.80), 1200))
        assert r["proposedConfig"]["width"] == expected

    def test_taller_by_25_percent(self):
        r = _build("Taller by 25%.", current={"height": 930})
        expected = int(min(round(930 * 1.25), 1800))
        assert r["proposedConfig"]["height"] == expected

    def test_increase_height_by_20_percent(self):
        r = _build("Increase the canvas height by 20%.", current={"height": 930})
        expected = int(min(round(930 * 1.20), 1800))
        assert r["proposedConfig"]["height"] == expected

    def test_shorter_by_10_percent(self):
        r = _build("Shorter by 10%.", current={"height": 930})
        expected = int(max(round(930 * 0.90), 760))
        assert r["proposedConfig"]["height"] == expected


# ===========================================================================
# MULTIPLE FLOORS RELATIVE
# ===========================================================================

class TestMultipleFloorsRelative:
    def test_add_2_floors(self):
        r = _build("Add 2 more floors.", current={"floorCount": 3})
        assert r["proposedConfig"]["floorCount"] == 5

    def test_add_3_floors(self):
        r = _build("Add 3 floors.", current={"floorCount": 2})
        assert r["proposedConfig"]["floorCount"] == 5

    def test_add_2_floors_clamped_at_max(self):
        r = _build("Add 2 more floors.", current={"floorCount": 9})
        assert r["proposedConfig"]["floorCount"] == 10

    def test_remove_2_floors(self):
        r = _build("Remove 2 floors.", current={"floorCount": 5})
        assert r["proposedConfig"]["floorCount"] == 3

    def test_remove_3_floors(self):
        r = _build("Remove 3 floors.", current={"floorCount": 4})
        assert r["proposedConfig"]["floorCount"] == 1

    def test_remove_2_floors_warns_if_only_one(self):
        r = _build("Remove 2 floors.", current={"floorCount": 1})
        assert any("only one floor" in w for w in r["warnings"])


# ===========================================================================
# EQUALIZE / RESET WING SIZES
# ===========================================================================

class TestEqualizeWings:
    def test_equalize_wings(self):
        r = _build("Equalize wings.", current={"wingRoomScaleOverrides": {"A": 120, "B": 80}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"] == {}

    def test_balance_wings(self):
        r = _build("Balance wing sizes.", current={"wingRoomScaleOverrides": {"A": 110, "C": 90}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"] == {}

    def test_reset_wing_sizes(self):
        r = _build("Reset wing sizes.", current={"wingRoomScaleOverrides": {"A": 130}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"] == {}

    def test_make_all_wings_equal(self):
        r = _build("Make all wings equal.", current={"wingRoomScaleOverrides": {"B": 85}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"] == {}

    def test_clear_wing_overrides(self):
        r = _build("Clear wing overrides.", current={"wingRoomScaleOverrides": {"A": 110, "B": 90}})
        assert r["proposedConfig"]["wingRoomScaleOverrides"] == {}


# ===========================================================================
# RESET SPECIFIC WING OVERRIDE
# ===========================================================================

class TestResetSpecificWingOverride:
    def test_reset_wing_a_override(self):
        overrides = {"A": 120, "B": 85}
        r = _build("Reset Wing A size override.", current={"wingRoomScaleOverrides": overrides})
        assert "A" not in r["proposedConfig"]["wingRoomScaleOverrides"]
        assert r["proposedConfig"]["wingRoomScaleOverrides"].get("B") == 85

    def test_clear_wing_b_scale(self):
        overrides = {"A": 110, "B": 75}
        r = _build("Clear Wing B scale.", current={"wingRoomScaleOverrides": overrides})
        assert "B" not in r["proposedConfig"]["wingRoomScaleOverrides"]
        assert r["proposedConfig"]["wingRoomScaleOverrides"].get("A") == 110

    def test_remove_wing_c_override(self):
        overrides = {"C": 90}
        r = _build("Remove Wing C override.", current={"wingRoomScaleOverrides": overrides})
        assert "C" not in r["proposedConfig"]["wingRoomScaleOverrides"]

    def test_reset_wing_a_size_to_default(self):
        overrides = {"A": 130}
        r = _build("Reset Wing A size to default.", current={"wingRoomScaleOverrides": overrides})
        assert "A" not in r["proposedConfig"]["wingRoomScaleOverrides"]


# ===========================================================================
# COPY WING SCALE TO ALL WINGS
# ===========================================================================

class TestCopyWingScaleToAll:
    def test_make_all_wings_same_as_wing_a(self):
        r = _build(
            "Make all wings the same size as Wing A.",
            current={"wingRoomScaleOverrides": {"A": 120}, "roomScale": 100},
        )
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("A") == 120
        assert overrides.get("B") == 120
        assert overrides.get("C") == 120

    def test_apply_wing_b_scale_to_all(self):
        r = _build(
            "Apply Wing B room size to all wings.",
            current={"wingRoomScaleOverrides": {"B": 85}, "roomScale": 100},
        )
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("A") == 85
        assert overrides.get("B") == 85

    def test_copy_uses_global_scale_when_no_override(self):
        r = _build(
            "Make all wings same size as Wing C.",
            current={"wingRoomScaleOverrides": {}, "roomScale": 110},
        )
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("A") == 110
        assert overrides.get("C") == 110


# ===========================================================================
# SET ALL WINGS TO SPECIFIC PERCENTAGE
# ===========================================================================

class TestSetAllWingsToPercent:
    def test_scale_all_wings_to_110(self):
        r = _build("Scale all wings to 110%.", current={"wingRoomScaleOverrides": {}})
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("A") == 110
        assert overrides.get("B") == 110
        assert overrides.get("C") == 110

    def test_set_all_wings_at_90_percent(self):
        r = _build("Set all wings at 90%.", current={})
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("A") == 90

    def test_all_wings_to_120_percent(self):
        r = _build("All wings to 120%.", current={})
        overrides = r["proposedConfig"]["wingRoomScaleOverrides"]
        assert overrides.get("B") == 120


# ===========================================================================
# EXACT PIXEL OFFSETS
# ===========================================================================

class TestExactPixelOffsets:
    def test_shift_right_100px(self):
        r = _build("Shift right 100px.", current={"offsetX": 0})
        assert r["proposedConfig"]["offsetX"] == 100

    def test_move_left_80_pixels(self):
        r = _build("Move left 80 pixels.", current={"offsetX": 0})
        assert r["proposedConfig"]["offsetX"] == -80

    def test_nudge_up_60px(self):
        r = _build("Nudge up 60px.", current={"offsetY": 0})
        assert r["proposedConfig"]["offsetY"] == -60

    def test_push_down_120_pixels(self):
        r = _build("Push down 120 pixels.", current={"offsetY": 0})
        assert r["proposedConfig"]["offsetY"] == 120

    def test_shift_right_100px_adds_to_existing_offset(self):
        r = _build("Shift right 100px.", current={"offsetX": 50})
        assert r["proposedConfig"]["offsetX"] == 150

    def test_clamps_at_max(self):
        r = _build("Shift right 300px.", current={"offsetX": 200})
        assert r["proposedConfig"]["offsetX"] == 400


# ===========================================================================
# CENTER / RESET LAYOUT POSITION
# ===========================================================================

class TestCenterLayout:
    def test_center_the_layout(self):
        r = _build("Center the layout.", current={"offsetX": 80, "offsetY": -40})
        assert r["proposedConfig"]["offsetX"] == 0
        assert r["proposedConfig"]["offsetY"] == 0

    def test_reset_position(self):
        r = _build("Reset position.", current={"offsetX": -100, "offsetY": 60})
        assert r["proposedConfig"]["offsetX"] == 0
        assert r["proposedConfig"]["offsetY"] == 0

    def test_reset_offset(self):
        r = _build("Reset offset.", current={"offsetX": 40, "offsetY": 0})
        assert r["proposedConfig"]["offsetX"] == 0

    def test_center_it(self):
        r = _build("Center it.", current={"offsetX": 120, "offsetY": -80})
        assert r["proposedConfig"]["offsetX"] == 0
        assert r["proposedConfig"]["offsetY"] == 0

    def test_move_to_center(self):
        r = _build("Move to center.", current={"offsetX": -200, "offsetY": 100})
        assert r["proposedConfig"]["offsetX"] == 0
        assert r["proposedConfig"]["offsetY"] == 0

    def test_no_change_when_already_centered(self):
        r = _build("Center the layout.", current={"offsetX": 0, "offsetY": 0})
        assert r["proposedConfig"]["offsetX"] == 0
        assert r["proposedConfig"]["offsetY"] == 0
