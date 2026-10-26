import json
from pathlib import Path


def _iter_layout_spaces(layout: dict):
    floors = layout.get("floors", {})
    if not isinstance(floors, dict):
        return

    for floor_data in floors.values():
        if not isinstance(floor_data, dict):
            continue
        wings = floor_data.get("wings", {})
        if not isinstance(wings, dict):
            continue
        for entries in wings.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict):
                    yield entry


def test_vertical_hallways_use_hidden_destination_prefix():
    layout_path = Path(__file__).resolve().parents[1] / "data" / "map_layout.json"
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    vertical_hallways = [
        entry
        for entry in _iter_layout_spaces(layout)
        if str(entry.get("id", "")).startswith("vertical_hallway_")
    ]

    assert vertical_hallways, "Expected vertical hallway entries in map layout"
    for entry in vertical_hallways:
        label = str(entry.get("name", "")).strip().lower()
        assert label.startswith("hallway"), (
            f"Vertical hallway should stay hidden from destination suggestions: "
            f"{entry.get('id')} -> {entry.get('name')}"
        )
