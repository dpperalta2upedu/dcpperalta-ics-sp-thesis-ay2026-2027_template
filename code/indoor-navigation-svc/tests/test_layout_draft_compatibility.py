import json
from pathlib import Path

import services.building_config as building_config
from services.database import ensure_database_ready
from services.draft_main_map_layout_service import DraftMainMapLayoutService
from services.main_map_layout_service import MainMapLayoutService
from services.navigation_service import NavigationService
from services.building_config import create_hallway_nodes
from services.building_config import create_room_nodes
from services.building_config import create_stair_nodes


def _saved_layout_builder_draft() -> dict:
    ensure_database_ready()
    drafts = DraftMainMapLayoutService.list_drafts()
    assert drafts, "Expected at least one draft map layout in the database"
    return drafts[0]["payload"]


def _current_layout() -> dict:
    ensure_database_ready()
    return MainMapLayoutService.get_current_layout()


def _scaled_layout_x(factor: float) -> dict:
    layout = _current_layout()

    def scale_entry(entry: dict, *, origin_x: float) -> None:
        if "x" in entry:
            entry["x"] = origin_x + ((entry["x"] - origin_x) * factor)
        if "width" in entry:
            entry["width"] = entry["width"] * factor
        if "cx" in entry:
            entry["cx"] = origin_x + ((entry["cx"] - origin_x) * factor)

    for floor_data in layout.get("floors", {}).values():
        if not isinstance(floor_data, dict):
            continue
        for entries in floor_data.get("wings", {}).values():
            if not isinstance(entries, list):
                continue
            xs = [entry.get("x") for entry in entries if isinstance(entry, dict) and isinstance(entry.get("x"), (int, float))]
            if not xs:
                continue
            origin_x = min(xs)
            for entry in entries:
                if isinstance(entry, dict):
                    scale_entry(entry, origin_x=origin_x)
        bridges = floor_data.get("bridges", {})
        bridge_entries = bridges.values() if isinstance(bridges, dict) else bridges
        if isinstance(bridge_entries, list) or hasattr(bridge_entries, "__iter__"):
            bridge_entries = list(bridge_entries)
            xs = [entry.get("x") for entry in bridge_entries if isinstance(entry, dict) and isinstance(entry.get("x"), (int, float))]
            origin_x = min(xs) if xs else 0.0
            for entry in bridge_entries:
                if isinstance(entry, dict):
                    scale_entry(entry, origin_x=origin_x)
        routing_hallways = floor_data.get("routingHallways", [])
        if isinstance(routing_hallways, list):
            xs = [entry.get("x") for entry in routing_hallways if isinstance(entry, dict) and isinstance(entry.get("x"), (int, float))]
            origin_x = min(xs) if xs else 0.0
            for entry in routing_hallways:
                if isinstance(entry, dict):
                    scale_entry(entry, origin_x=origin_x)

    main_entrance = layout.get("mainEntrance")
    if isinstance(main_entrance, dict) and isinstance(main_entrance.get("x"), (int, float)):
        main_entrance["x"] = main_entrance["x"] * factor

    return layout


def test_layout_builder_svg_draft_still_extracts_routing_nodes(monkeypatch):
    monkeypatch.setattr(building_config, "load_map_layout", _saved_layout_builder_draft)

    hallway_ids = {node.id for node in create_hallway_nodes()}
    room_ids = {node.id for node in create_room_nodes()}
    stair_ids = {node.id for node in create_stair_nodes()}

    assert "hallway_wing_b_1_2" in hallway_ids
    assert "hallway_wing_c_3_3" in hallway_ids
    assert "Balance Room A118" in room_ids
    assert "classroom-c103" in room_ids
    assert "stairs1_Wing_B_3F" in stair_ids
    assert "stairs1_Wing_C_1F" in stair_ids


def test_layout_builder_svg_draft_still_builds_cross_wing_routes(monkeypatch):
    monkeypatch.setattr(building_config, "load_map_layout", _saved_layout_builder_draft)
    cache_path = Path(__file__).resolve().parent / "tmp_navigation_graph_cache_test.json"
    if cache_path.exists():
        cache_path.unlink()
    monkeypatch.setattr(NavigationService, "GRAPH_CACHE_PATH", cache_path)
    monkeypatch.setattr(NavigationService, "FORCE_REBUILD_GRAPH_CACHE", True)

    nav_service = NavigationService()
    path, _ = nav_service.graph.a_star_pathfinding("Balance Room A118", "classroom-c103")

    assert path, "Expected a route to exist for saved SVG draft layouts"
    assert "bridge_hall_1_ab" in path, f"Expected A-B bridge in route: {path}"
    assert any(node_id.endswith("_bc") for node_id in path), f"Expected B-C bridge in route: {path}"


def test_scaled_layout_still_builds_same_wing_and_cross_wing_routes(monkeypatch):
    monkeypatch.setattr(building_config, "load_map_layout", lambda: _scaled_layout_x(1.12))
    cache_path = Path(__file__).resolve().parent / "tmp_navigation_graph_cache_scaled_test.json"
    if cache_path.exists():
        cache_path.unlink()
    monkeypatch.setattr(NavigationService, "GRAPH_CACHE_PATH", cache_path)
    monkeypatch.setattr(NavigationService, "FORCE_REBUILD_GRAPH_CACHE", True)

    nav_service = NavigationService()

    same_wing_path, _ = nav_service.graph.a_star_pathfinding("main entrance", "Balance Room A118")
    cross_wing_path, _ = nav_service.graph.a_star_pathfinding("Balance Room A118", "classroom-c103")

    assert same_wing_path, "Expected same-wing route after stretching the layout"
    assert "bridge_hall_1_ab" not in same_wing_path, f"Same-wing route should not detour through bridge: {same_wing_path}"

    assert cross_wing_path, "Expected cross-wing route after stretching the layout"
    assert any(node_id.startswith("bridge_hall_") for node_id in cross_wing_path), (
        f"Expected at least one bridge connector in scaled-layout route: {cross_wing_path}"
    )
