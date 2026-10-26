from itertools import permutations
from pathlib import Path

import pytest
from shapely.geometry import LineString, box

from services.navigation_service import NavigationService


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


@pytest.fixture(scope="module")
def nav_service() -> NavigationService:
    original_cache_path = NavigationService.GRAPH_CACHE_PATH
    temp_cache_path = Path(__file__).resolve().parent.parent / "data" / "navigation_graph_cache_test_tmp_wing_b_2_3.json"
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
def wing_b_rooms(nav_service: NavigationService) -> dict[int, list[str]]:
    graph = nav_service.graph
    rooms = {
        floor: sorted(
            node_id
            for node_id, node in graph.nodes.items()
            if node.type == "room" and node.wing == "B" and node.floor == floor
        )
        for floor in (2, 3)
    }
    assert rooms[2], "Expected at least one Wing B room on floor 2"
    assert rooms[3], "Expected at least one Wing B room on floor 3"
    return rooms


@pytest.fixture(scope="module")
def route_cases(wing_b_rooms: dict[int, list[str]]) -> list[tuple[str, str, str]]:
    rooms = wing_b_rooms[2] + wing_b_rooms[3]
    cases = []
    for room_id in rooms:
        cases.append((MAIN_ENTRANCE_ID, room_id, "entrance_to_room"))
        cases.append((room_id, MAIN_ENTRANCE_ID, "room_to_entrance"))
    for src_id, dst_id in permutations(rooms, 2):
        if src_id in wing_b_rooms[2] and dst_id in wing_b_rooms[2]:
            kind = "same_floor_2"
        elif src_id in wing_b_rooms[3] and dst_id in wing_b_rooms[3]:
            kind = "same_floor_3"
        else:
            kind = "cross_floor_2_3"
        cases.append((src_id, dst_id, kind))
    return cases


@pytest.fixture(scope="module")
def route_results(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str]],
) -> dict[tuple[str, str], dict]:
    results: dict[tuple[str, str], dict] = {}
    for src_id, dst_id, _ in route_cases:
        results[(src_id, dst_id)] = nav_service.parse_navigation(src_id, dst_id)
    return results


def test_all_wing_b_floor_2_and_3_routes_are_valid(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    for src_id, dst_id, kind in route_cases:
        result = route_results[(src_id, dst_id)]
        assert not result.get("error"), f"Routing error for {src_id}->{dst_id} [{kind}]: {result.get('error')}"

        path = result.get("path") or []
        assert path, f"No path for {src_id}->{dst_id} [{kind}]"
        assert _is_valid_route_start(graph, src_id, path[0]), (
            f"Path start does not connect from origin for {src_id}->{dst_id} [{kind}]: {path}"
        )
        assert _is_valid_route_end(graph, dst_id, path[-1]), (
            f"Path end does not connect to destination for {src_id}->{dst_id} [{kind}]: {path}"
        )

        excluded_rooms = set()
        if graph.nodes[src_id].type == "room":
            excluded_rooms.add(src_id)
        if graph.nodes[dst_id].type == "room":
            excluded_rooms.add(dst_id)

        for node_id in path[1:-1]:
            node = graph.nodes[node_id]
            assert node.type != "room", f"Room used as transit node for {src_id}->{dst_id} [{kind}]: {path}"

        for i in range(len(path) - 1):
            a_id = path[i]
            b_id = path[i + 1]
            a_node = graph.nodes[a_id]
            b_node = graph.nodes[b_id]
            if a_node.type == "stairs" and b_node.type == "stairs":
                assert abs(a_node.floor - b_node.floor) == 1, (
                    f"Non-adjacent stair jump for {src_id}->{dst_id} [{kind}]: {a_id}->{b_id} | {path}"
                )
            assert not _edge_crosses_non_excluded_room(graph, a_id, b_id, excluded_rooms), (
                f"Edge crosses room interior for {src_id}->{dst_id} [{kind}]: {a_id}->{b_id} | {path}"
            )


def test_same_floor_wing_b_routes_stay_on_one_floor(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    for src_id, dst_id, kind in route_cases:
        if kind not in {"same_floor_2", "same_floor_3"}:
            continue
        expected_floor = graph.nodes[src_id].floor
        path = route_results[(src_id, dst_id)].get("path") or []
        assert path, f"No path for {src_id}->{dst_id} [{kind}]"
        floors_in_path = {graph.nodes[node_id].floor for node_id in path}
        assert floors_in_path == {expected_floor}, (
            f"Expected same-floor Wing B route to stay on floor {expected_floor}: {path}"
        )
        assert set((route_results[(src_id, dst_id)].get("floor_routes") or {}).keys()) == {expected_floor}, (
            f"Expected rendered route only on floor {expected_floor}: "
            f"{route_results[(src_id, dst_id)].get('floor_routes')}"
        )


def test_cross_floor_wing_b_routes_only_use_floors_2_and_3(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    for src_id, dst_id, kind in route_cases:
        if kind != "cross_floor_2_3":
            continue
        path = route_results[(src_id, dst_id)].get("path") or []
        assert path, f"No path for {src_id}->{dst_id} [{kind}]"
        floors_in_path = {graph.nodes[node_id].floor for node_id in path}
        assert floors_in_path == {2, 3}, f"Expected Wing B cross-floor route to stay on floors 2 and 3: {path}"
        assert set((route_results[(src_id, dst_id)].get("floor_routes") or {}).keys()) == {2, 3}, (
            f"Expected rendered route on floors 2 and 3 for {src_id}->{dst_id}: "
            f"{route_results[(src_id, dst_id)].get('floor_routes')}"
        )


def test_main_entrance_routes_to_wing_b_use_bc_bridge_without_ab_detour(
    route_cases: list[tuple[str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    for src_id, dst_id, kind in route_cases:
        if kind not in {"entrance_to_room", "room_to_entrance"}:
            continue
        path = route_results[(src_id, dst_id)].get("path") or []
        assert path, f"No path for {src_id}->{dst_id} [{kind}]"
        assert "bridge_hall_1_bc" in path, f"Expected Wing B entrance route to use the B-C bridge: {path}"
        assert "bridge_hall_1_ab" not in path, f"Expected Wing B entrance route to avoid the A-B bridge: {path}"


def test_main_entrance_routes_use_expected_floor_sets(
    nav_service: NavigationService,
    route_cases: list[tuple[str, str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    for src_id, dst_id, kind in route_cases:
        if kind not in {"entrance_to_room", "room_to_entrance"}:
            continue
        path = route_results[(src_id, dst_id)].get("path") or []
        assert path, f"No path for {src_id}->{dst_id} [{kind}]"
        room_id = dst_id if kind == "entrance_to_room" else src_id
        room_floor = graph.nodes[room_id].floor
        floors_in_path = {graph.nodes[node_id].floor for node_id in path}
        if room_floor == 2:
            assert floors_in_path == {1, 2}, (
                f"Expected Wing B 2F entrance route to use only floors 1 and 2: {path}"
            )
            assert set((route_results[(src_id, dst_id)].get("floor_routes") or {}).keys()) == {1, 2}, (
                f"Expected rendered route on floors 1 and 2 for {src_id}->{dst_id}: "
                f"{route_results[(src_id, dst_id)].get('floor_routes')}"
            )
        else:
            assert floors_in_path == {1, 2, 3}, (
                f"Expected Wing B 3F entrance route to use floors 1, 2, and 3: {path}"
            )
            assert set((route_results[(src_id, dst_id)].get("floor_routes") or {}).keys()) == {1, 2, 3}, (
                f"Expected rendered route on floors 1, 2, and 3 for {src_id}->{dst_id}: "
                f"{route_results[(src_id, dst_id)].get('floor_routes')}"
            )
