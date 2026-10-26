import json
from pathlib import Path


def _wing_ids(layout: dict, floor: str, wing: str) -> set[str]:
    floors = layout.get("floors", {})
    entries = (((floors.get(floor) or {}).get("wings") or {}).get(wing) or [])
    return {
        str(entry.get("id", "")).strip()
        for entry in entries
        if isinstance(entry, dict)
    }


def test_left_side_wing_b_rooms_are_bucketed_under_wing_b():
    layout_path = Path(__file__).resolve().parents[1] / "data" / "map_layout.json"
    layout = json.loads(layout_path.read_text(encoding="utf-8"))

    floor_2_expected = {
        "room-1773161197320",
        "ics-mega-hall",
        "pc-lab-4",
        "pc-lab-3",
        "pc-lab-2",
        "pc-lab-1",
        "pc-lab-5",
    }
    floor_3_expected = {
        "ics-lecture-hall-4",
        "ics-lecture-hall-3",
        "pc-lab-9",
        "pc-lab-7",
        "pc-lab-6",
    }

    floor_2_wing_b = _wing_ids(layout, "2", "B")
    floor_3_wing_b = _wing_ids(layout, "3", "B")

    assert floor_2_expected <= floor_2_wing_b, (
        f"Missing 2F Wing B destinations: {sorted(floor_2_expected - floor_2_wing_b)}"
    )
    assert floor_3_expected <= floor_3_wing_b, (
        f"Missing 3F Wing B destinations: {sorted(floor_3_expected - floor_3_wing_b)}"
    )

    floor_2_non_b = _wing_ids(layout, "2", "A") | _wing_ids(layout, "2", "C")
    floor_3_non_b = _wing_ids(layout, "3", "A") | _wing_ids(layout, "3", "C")

    assert floor_2_expected.isdisjoint(floor_2_non_b), "2F Wing B rooms are still bucketed under A/C"
    assert floor_3_expected.isdisjoint(floor_3_non_b), "3F Wing B rooms are still bucketed under A/C"
