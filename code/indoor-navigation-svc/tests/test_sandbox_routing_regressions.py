from __future__ import annotations

from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sandbox.services.sb_main_map_layout_service import SandboxMainMapLayoutService
from sandbox.services.sb_navigation_service import SandboxNavigationService
from sandbox.utils.sb_map_layout import map_layout_context


def _simple_sandbox_layout() -> dict:
    return {
        "version": 1,
        "units": "px",
        "viewBox": {"w": 1768, "h": 930},
        "grid": {"size": 40},
        "mainEntrance": {"x": 0, "y": 0},
        "floors": {
            "1": {
                "wings": {
                    "A": [
                        {
                            "id": "room-1",
                            "name": "Room 1",
                            "x": 520,
                            "y": 130,
                            "width": 120,
                            "height": 120,
                            "type": "room",
                            "passable": False,
                        },
                        {
                            "id": "room-2",
                            "name": "Room 2",
                            "x": 650,
                            "y": 130,
                            "width": 120,
                            "height": 120,
                            "type": "room",
                            "passable": False,
                        },
                        {
                            "id": "hallway-custom-1",
                            "name": "Hallway 1",
                            "x": 525,
                            "y": 270,
                            "width": 250,
                            "height": 40,
                            "type": "hallway",
                            "passable": True,
                        },
                    ],
                    "B": [],
                    "C": [],
                },
                "bridges": {
                    "AB": {
                        "id": "bridge-ab",
                        "name": "Bridge AB",
                        "x": 40,
                        "y": 40,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                    "BC": {
                        "id": "bridge-bc",
                        "name": "Bridge BC",
                        "x": 40,
                        "y": 40,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                },
            }
        },
    }


def _single_stair_multifloor_layout() -> dict:
    return {
        "version": 1,
        "units": "px",
        "viewBox": {"w": 1768, "h": 930},
        "grid": {"size": 40},
        "mainEntrance": {"x": 905, "y": 100},
        "floors": {
            "1": {
                "wingBackgrounds": {
                    "A": {"x": 60, "y": 140, "width": 840, "height": 220, "r": 10}
                },
                "wings": {
                    "A": [
                        {
                            "id": "stairs-A-1",
                            "name": "Stairs",
                            "x": 100,
                            "y": 180,
                            "width": 80,
                            "height": 80,
                            "type": "stairs",
                            "passable": True,
                        },
                        {
                            "id": "hallway-floor-1",
                            "name": "Hallway A",
                            "x": 180,
                            "y": 265,
                            "width": 400,
                            "height": 40,
                            "type": "hallway",
                            "passable": True,
                        },
                        {
                            "id": "A11",
                            "name": "Classroom 1",
                            "x": 180,
                            "y": 180,
                            "width": 160,
                            "height": 80,
                            "type": "room",
                            "passable": False,
                        },
                    ],
                    "B": [],
                    "C": [],
                },
                "bridges": {
                    "AB": {
                        "id": "bridge-ab",
                        "name": "Bridge AB",
                        "x": 20,
                        "y": 20,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                    "BC": {
                        "id": "bridge-bc",
                        "name": "Bridge BC",
                        "x": 20,
                        "y": 20,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                },
            },
            "2": {
                "wingBackgrounds": {
                    "A": {"x": 60, "y": 140, "width": 840, "height": 220, "r": 10}
                },
                "wings": {
                    "A": [
                        {
                            "id": "stairs-A-2",
                            "name": "Stairs",
                            "x": 100,
                            "y": 180,
                            "width": 80,
                            "height": 80,
                            "type": "stairs",
                            "passable": True,
                        },
                        {
                            "id": "hallway-floor-2",
                            "name": "Hallway A",
                            "x": 180,
                            "y": 265,
                            "width": 400,
                            "height": 40,
                            "type": "hallway",
                            "passable": True,
                        },
                        {
                            "id": "A21",
                            "name": "Faculty Room 1",
                            "x": 420,
                            "y": 180,
                            "width": 160,
                            "height": 80,
                            "type": "room",
                            "passable": False,
                        },
                    ],
                    "B": [],
                    "C": [],
                },
                "bridges": {
                    "AB": {
                        "id": "bridge-ab",
                        "name": "Bridge AB",
                        "x": 20,
                        "y": 20,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                    "BC": {
                        "id": "bridge-bc",
                        "name": "Bridge BC",
                        "x": 20,
                        "y": 20,
                        "width": 1,
                        "height": 1,
                        "type": "bridge",
                        "passable": True,
                    },
                },
            },
        },
    }


def test_sandbox_navigation_uses_custom_hallway_for_simple_room_to_room_route(tmp_path, monkeypatch):
    cache_path = Path(tmp_path) / "sandbox-navigation-cache.json"
    monkeypatch.setattr(SandboxNavigationService, "GRAPH_CACHE_PATH", cache_path)
    monkeypatch.setattr(SandboxNavigationService, "FORCE_REBUILD_GRAPH_CACHE", True)

    with map_layout_context(_simple_sandbox_layout()):
        nav_service = SandboxNavigationService()

    result = nav_service.parse_navigation("Room 1", "Room 2")
    path = result["path"]

    assert path, "Expected a generated sandbox route."
    assert "hallway-custom-1" in path, f"Expected route to use the custom hallway node: {path}"
    assert not any(node_id.startswith("hall_1_") for node_id in path), (
        f"Route should stay on the published custom hallway instead of legacy fallback hallways: {path}"
    )


def test_sandbox_navigation_uses_layout_defined_wing_a_stair_coordinates(tmp_path, monkeypatch):
    cache_path = Path(tmp_path) / "sandbox-navigation-cache.json"
    monkeypatch.setattr(SandboxNavigationService, "GRAPH_CACHE_PATH", cache_path)
    monkeypatch.setattr(SandboxNavigationService, "FORCE_REBUILD_GRAPH_CACHE", True)

    with map_layout_context(_single_stair_multifloor_layout()):
        nav_service = SandboxNavigationService()

    left_stair_1f = nav_service.graph.nodes["stairs2_Wing_A_1F"]
    left_stair_2f = nav_service.graph.nodes["stairs2_Wing_A_2F"]
    mirrored_stair_1f = nav_service.graph.nodes["stairs1_Wing_A_1F"]

    assert (left_stair_1f.x, left_stair_1f.y) == (100.0, 180.0)
    assert (left_stair_2f.x, left_stair_2f.y) == (100.0, 180.0)
    assert (mirrored_stair_1f.x, mirrored_stair_1f.y) == (100.0, 180.0)

    result = nav_service.parse_navigation("Classroom 1", "Faculty Room 1")
    floor_routes = result["floor_routes"]

    assert "140.0 220.0" in floor_routes[1], floor_routes[1]
    assert "140.0 220.0" in floor_routes[2], floor_routes[2]
    assert "50.0 360.0" not in floor_routes[1], floor_routes[1]
    assert "50.0 360.0" not in floor_routes[2], floor_routes[2]


def test_sandbox_layout_normalization_preserves_existing_floor_data():
    payload = {
        "floors": {
            "1": {
                "wings": {"A": [], "B": [], "C": []},
                "bridges": {
                    "AB": {"id": "bridge-ab", "type": "bridge", "x": 1, "y": 2, "width": 3, "height": 4, "passable": True},
                    "BC": {"id": "bridge-bc", "type": "bridge", "x": 5, "y": 6, "width": 7, "height": 8, "passable": True},
                },
            },
            "2": {
                "wings": {
                    "A": [
                        {
                            "id": "room-201",
                            "name": "Room 201",
                            "x": 10,
                            "y": 20,
                            "width": 30,
                            "height": 40,
                            "type": "room",
                            "passable": False,
                        }
                    ],
                    "B": [],
                    "C": [],
                },
                "bridges": {
                    "AB": {"id": "bridge-ab-2", "type": "bridge", "x": 11, "y": 12, "width": 13, "height": 14, "passable": True},
                    "BC": {"id": "bridge-bc-2", "type": "bridge", "x": 15, "y": 16, "width": 17, "height": 18, "passable": True},
                },
            },
        }
    }

    normalized = SandboxMainMapLayoutService._normalize_current_layout_payload(payload)

    assert normalized["floors"]["2"]["wings"]["A"][0]["id"] == "room-201"
    assert normalized["floors"]["2"]["bridges"]["AB"]["id"] == "bridge-ab-2"
    assert normalized["floors"]["3"]["wings"] == {"A": [], "B": [], "C": []}
    assert "3" not in payload["floors"], "Normalization should not mutate the original payload in-place."
