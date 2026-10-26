import os
from collections import defaultdict
from itertools import permutations
from pathlib import Path

import pytest
from shapely.geometry import LineString, box

from services.navigation_service import NavigationService


WINGS = ("A", "B", "C")
FLOORS = (1, 2, 3)
MAIN_ENTRANCE_ID = "main entrance"


def _extract_room_id_from_door(node_id: str) -> str | None:
    if isinstance(node_id, str) and node_id.startswith("door_"):
        return node_id[5:]
    return None


def _extract_room_id_from_junction(node_id: str, graph) -> str | None:
    if not isinstance(node_id, str) or not node_id.startswith("junction_"):
        return None
    room_id = node_id[len("junction_") :]
    room = graph.nodes.get(room_id)
    if room and room.type == "room":
        return room_id
    return None


def _edge_crosses_non_excluded_room(
    graph,
    a_id: str,
    b_id: str,
    excluded_room_ids: set[str],
) -> bool:
    a = graph.nodes[a_id]
    b = graph.nodes[b_id]
    if a.floor != b.floor:
        return False
    segment = LineString([(a.x, a.y), (b.x, b.y)])

    edge_related_rooms = set(excluded_room_ids)
    if a.type == "room":
        edge_related_rooms.add(a_id)
    if b.type == "room":
        edge_related_rooms.add(b_id)
    from_a = _extract_room_id_from_door(a_id)
    from_b = _extract_room_id_from_door(b_id)
    if from_a:
        edge_related_rooms.add(from_a)
    if from_b:
        edge_related_rooms.add(from_b)
    from_a_junction = _extract_room_id_from_junction(a_id, graph)
    from_b_junction = _extract_room_id_from_junction(b_id, graph)
    if from_a_junction:
        edge_related_rooms.add(from_a_junction)
    if from_b_junction:
        edge_related_rooms.add(from_b_junction)

    for room in graph.nodes.values():
        if room.type != "room" or not room.width or not room.height:
            continue
        if (room.metadata or {}).get("layout_matched") is False:
            continue
        if bool((room.metadata or {}).get("passable")):
            continue
        if room.floor != a.floor:
            continue
        if room.id in edge_related_rooms:
            continue
        rect = box(room.x, room.y, room.x + room.width, room.y + room.height)
        if segment.intersects(rect) and not segment.touches(rect):
            return True
    return False


def _is_valid_route_start(graph, origin_id: str, first_path_id: str) -> bool:
    if origin_id == first_path_id:
        return True
    origin = graph.nodes[origin_id]
    if origin.type == "room":
        return first_path_id in graph.get_neighbors(origin_id) or first_path_id == f"door_{origin_id}"
    return first_path_id in graph.get_neighbors(origin_id)


def _is_valid_route_end(graph, destination_id: str, last_path_id: str) -> bool:
    if destination_id == last_path_id:
        return True
    destination = graph.nodes[destination_id]
    if destination.type == "room":
        door_id = f"door_{destination_id}"
        if last_path_id == door_id:
            return True
        if door_id in graph.nodes and last_path_id in graph.get_neighbors(door_id):
            return True
    return last_path_id in graph.get_neighbors(destination_id)


def _path_single_wing_zones(graph, path: list[str]) -> set[tuple[str, int]]:
    zones = set()
    for node_id in path:
        node = graph.nodes.get(node_id)
        if not node or node.wing not in WINGS:
            continue
        zones.add((node.wing, node.floor))
    return zones


@pytest.fixture(scope="module")
def nav_service() -> NavigationService:
    original_cache_path = NavigationService.GRAPH_CACHE_PATH
    temp_cache_path = Path(__file__).resolve().parent / "tmp_navigation_graph_cache_test_tmp.json"
    temp_cache_path.parent.mkdir(parents=True, exist_ok=True)
    NavigationService.GRAPH_CACHE_PATH = temp_cache_path
    try:
        service = NavigationService()
        yield service
    finally:
        NavigationService.GRAPH_CACHE_PATH = original_cache_path
        try:
            temp_cache_path.unlink(missing_ok=True)
        except Exception:
            pass


@pytest.fixture(scope="module")
def representative_endpoints(nav_service: NavigationService) -> dict[str, str]:
    graph = nav_service.graph
    buckets = defaultdict(list)
    for node_id, node in graph.nodes.items():
        if node.type == "room" and node.wing in WINGS and node.floor in FLOORS:
            buckets[(node.wing, node.floor)].append(node_id)

    endpoints: dict[str, str] = {}
    for wing in WINGS:
        for floor in FLOORS:
            room_ids = sorted(buckets[(wing, floor)])
            assert room_ids, f"Missing representative room in {wing}{floor}F"
            endpoints[f"{wing}{floor}"] = room_ids[0]

    assert MAIN_ENTRANCE_ID in graph.nodes, "Main entrance node is missing from graph"
    endpoints["ENTRANCE"] = MAIN_ENTRANCE_ID
    return endpoints


@pytest.fixture(scope="module")
def route_cases(
    representative_endpoints: dict[str, str],
) -> list[tuple[str, str, str, str]]:
    labels = sorted(representative_endpoints.keys())
    cases = [
        (
            src_label,
            dst_label,
            representative_endpoints[src_label],
            representative_endpoints[dst_label],
        )
        for src_label, dst_label in permutations(labels, 2)
    ]

    case_limit = int(os.getenv("ROUTING_COMBO_CASE_LIMIT", "0"))
    if case_limit > 0:
        cases = cases[:case_limit]
    return cases


@pytest.fixture(scope="module")
def route_results(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str, str]],
) -> dict[tuple[str, str], dict]:
    results: dict[tuple[str, str], dict] = {}
    for src_label, dst_label, src_id, dst_id in route_cases:
        results[(src_label, dst_label)] = nav_service.parse_navigation(src_id, dst_id)
    return results


def test_all_directional_route_combinations_are_valid(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    assert route_cases, "No route-combination cases generated"

    for src_label, dst_label, src_id, dst_id in route_cases:
        result = route_results[(src_label, dst_label)]
        assert not result.get("error"), f"Routing error for {src_label}->{dst_label} ({src_id}->{dst_id}): {result.get('error')}"

        path = result.get("path") or []
        assert path, f"No path for {src_label}->{dst_label} ({src_id}->{dst_id})"
        assert _is_valid_route_start(graph, src_id, path[0]), (
            f"Path start does not connect from origin for {src_label}->{dst_label}: {path}"
        )
        assert _is_valid_route_end(graph, dst_id, path[-1]), (
            f"Path end does not connect to destination for {src_label}->{dst_label}: {path}"
        )

        excluded_rooms = set()
        if graph.nodes[src_id].type == "room":
            excluded_rooms.add(src_id)
        if graph.nodes[dst_id].type == "room":
            excluded_rooms.add(dst_id)

        for node_id in path[1:-1]:
            node = graph.nodes[node_id]
            assert node.type != "room", f"Room used as transit node for {src_label}->{dst_label}: {path}"

        for i in range(len(path) - 1):
            a_id = path[i]
            b_id = path[i + 1]
            if b_id not in graph.get_neighbors(a_id):
                # parse_navigation may simplify colinear hallway sequences in the display path.
                a_node = graph.nodes[a_id]
                b_node = graph.nodes[b_id]
                assert a_node.floor == b_node.floor, (
                    f"Simplified hop changed floor for {src_label}->{dst_label}: {a_id} -> {b_id} | {path}"
                )
                assert a_node.type != "room" and b_node.type != "room", (
                    f"Simplified hop should not skip through room endpoints for {src_label}->{dst_label}: "
                    f"{a_id} -> {b_id} | {path}"
                )
            assert not _edge_crosses_non_excluded_room(graph, a_id, b_id, excluded_rooms), (
                f"Edge crosses room interior for {src_label}->{dst_label}: {a_id} -> {b_id} | {path}"
            )


def test_cross_wing_routes_use_required_bridges(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph

    for src_label, dst_label, src_id, dst_id in route_cases:
        if MAIN_ENTRANCE_ID in {src_id, dst_id}:
            continue
        src_wing = graph.nodes[src_id].wing
        dst_wing = graph.nodes[dst_id].wing
        if src_wing not in WINGS or dst_wing not in WINGS or src_wing == dst_wing:
            continue

        path = route_results[(src_label, dst_label)].get("path") or []
        wing_pair = {src_wing, dst_wing}

        if wing_pair == {"A", "B"}:
            path_zones = _path_single_wing_zones(graph, path)
            assert (
                "bridge_hall_1_ab" in path
                or any(("A", floor) in path_zones and ("B", floor) in path_zones for floor in (2, 3))
            ), f"A<->B route missing a legal A/B transfer for {src_label}->{dst_label}: {path}"
        elif wing_pair == {"B", "C"}:
            assert any(node_id.startswith("bridge_hall_") and node_id.endswith("_bc") for node_id in path), (
                f"B<->C route missing B-C bridge for {src_label}->{dst_label}: {path}"
            )
        elif wing_pair == {"A", "C"}:
            assert any(node_id.startswith("bridge_hall_") and node_id.endswith("_bc") for node_id in path), (
                f"A<->C route missing B-C bridge leg for {src_label}->{dst_label}: {path}"
            )
            if "bridge_hall_1_bc" in path:
                assert "bridge_hall_1_ab" in path, (
                    f"A<->C route using the 1F B-C bridge must include the 1F A-B bridge first for {src_label}->{dst_label}: {path}"
                )


def test_stair_changes_are_adjacent_floors_only(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph

    for src_label, dst_label, _, _ in route_cases:
        path = route_results[(src_label, dst_label)].get("path") or []
        for i in range(len(path) - 1):
            a = graph.nodes[path[i]]
            b = graph.nodes[path[i + 1]]
            if a.type == "stairs" and b.type == "stairs":
                assert abs(a.floor - b.floor) == 1, (
                    f"Non-adjacent stair jump for {src_label}->{dst_label}: {a.id}({a.floor}) -> {b.id}({b.floor})"
                )
