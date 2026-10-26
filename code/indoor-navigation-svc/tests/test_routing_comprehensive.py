import os
from itertools import combinations

import pytest
from shapely.geometry import LineString, box

from services.navigation_service import NavigationService
from utils.navigation_utils import path_to_svg


def _svg_route_points(route: str) -> list[tuple[float, float]]:
    if not route:
        return []
    tokens = route.split()
    points: list[tuple[float, float]] = []
    i = 0
    while i + 2 < len(tokens):
        cmd = tokens[i]
        if cmd not in {"M", "L"}:
            i += 1
            continue
        try:
            x = float(tokens[i + 1])
            y = float(tokens[i + 2])
        except ValueError:
            i += 1
            continue
        points.append((x, y))
        i += 3
    return points


def _renderable_path(graph, path: list[str]) -> list[str]:
    if len(path) >= 2:
        last_node = graph.nodes.get(path[-1])
        prev_node = graph.nodes.get(path[-2])
        if last_node and prev_node and last_node.type == "room" and prev_node.type == "door":
            return path[:-1]
    return path


def _route_length_for_path(graph, path: list[str]) -> float:
    route = path_to_svg(graph, _renderable_path(graph, path))
    points = _svg_route_points(route)
    return sum(
        ((points[i + 1][0] - points[i][0]) ** 2 + (points[i + 1][1] - points[i][1]) ** 2) ** 0.5
        for i in range(len(points) - 1)
    )


def _path_via_waypoints(graph, start_id: str, goal_id: str, waypoints: list[str]) -> list[str]:
    full_path: list[str] = []
    current_id = start_id
    for waypoint_id in [*waypoints, goal_id]:
        segment_path, _ = graph.a_star_pathfinding(current_id, waypoint_id, exact=True)
        if not segment_path:
            return []
        full_path.extend(segment_path if not full_path else segment_path[1:])
        current_id = waypoint_id
    return full_path


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


def _foreign_room_access_nodes(graph, path: list[str], allowed_room_ids: set[str]) -> list[str]:
    offenders = []
    for node_id in path:
        room_id = _extract_room_id_from_door(node_id)
        if room_id is None:
            room_id = _extract_room_id_from_junction(node_id, graph)
        if room_id and room_id not in allowed_room_ids:
            offenders.append(node_id)
    return offenders


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


@pytest.fixture(scope="module")
def nav_service() -> NavigationService:
    return NavigationService()


@pytest.fixture(scope="module")
def endpoint_pairs(nav_service: NavigationService) -> list[tuple[str, str]]:
    graph = nav_service.graph
    endpoints = [
        node_id
        for node_id, node in graph.nodes.items()
        if node.type == "room" or node_id == "main entrance"
    ]
    endpoints = sorted(set(endpoints))
    pairs = list(combinations(endpoints, 2))

    pair_limit = int(os.getenv("ROUTING_PAIR_LIMIT", "0"))
    if pair_limit > 0:
        pairs = pairs[:pair_limit]
    return pairs


@pytest.fixture(scope="module")
def route_results(
    nav_service: NavigationService,
    endpoint_pairs: list[tuple[str, str]],
) -> dict[tuple[str, str], dict]:
    results: dict[tuple[str, str], dict] = {}
    for start, goal in endpoint_pairs:
        results[(start, goal)] = nav_service.parse_navigation(start, goal)
    return results


def test_exhaustive_routes_exist_and_do_not_pass_through_rooms(
    nav_service: NavigationService,
    endpoint_pairs: list[tuple[str, str]],
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph
    assert endpoint_pairs, "No endpoint pairs generated for routing tests"

    for start, goal in endpoint_pairs:
        result = route_results[(start, goal)]
        assert not result.get("error"), f"Routing error for {start} -> {goal}: {result.get('error')}"
        assert result.get("path"), f"No path for {start} -> {goal}"

        path = result.get("path") or []
        assert path, f"No path nodes for {start} -> {goal}"
        excluded_rooms = set()
        if graph.nodes[start].type == "room":
            excluded_rooms.add(start)
        if graph.nodes[goal].type == "room":
            excluded_rooms.add(goal)

        for node_id in path[1:-1]:
            node = graph.nodes[node_id]
            assert node.type != "room", f"Route uses room as transit for {start} -> {goal}: {path}"

        for i in range(len(path) - 1):
            a = path[i]
            b = path[i + 1]
            assert not _edge_crosses_non_excluded_room(graph, a, b, excluded_rooms), (
                f"Route edge crosses room interior for {start} -> {goal}: {a} -> {b} | path={path}"
            )


def test_exhaustive_b_to_c_routes_pass_bridge_midpoint(
    nav_service: NavigationService,
    route_results: dict[tuple[str, str], dict],
):
    graph = nav_service.graph

    for (start, goal), result in route_results.items():
        start_node = graph.nodes.get(start)
        goal_node = graph.nodes.get(goal)
        if not start_node or not goal_node:
            continue
        if {start_node.wing, goal_node.wing} != {"B", "C"}:
            continue

        path = result.get("path") or []
        assert any(node_id.startswith("bridge_hall_") and node_id.endswith("_bc") for node_id in path), (
            f"B<->C route missing bridge midpoint for {start} -> {goal}: {path}"
        )


def test_main_entrance_to_balance_room_a118_uses_vertical_hallway_connector(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "Balance Room A118")
    assert not result.get("error"), f"Routing error: {result.get('error')}"

    path = result.get("path") or []
    assert path, "Expected a valid path for Main Entrance -> Balance Room A118"
    assert "vertical_hallway_1_1" in path, f"Expected route to reach Wing A horizontal hallway: {path}"
    assert "bridge_hall_1_ab" not in path, f"Expected same-wing route to avoid A-B bridge detour: {path}"
    assert not any(node_id.startswith("bypass_") for node_id in path), (
        f"Expected route to avoid far bypass detours: {path}"
    )
    door_count = sum(1 for node_id in path if nav_service.graph.nodes[node_id].type == "door")
    assert door_count <= 2, f"Expected minimal door transit for this route: {path}"

    # Rendered route must include a turn from main entrance into Wing A hallway
    # and travel along the hallway centerline before heading to the room door.
    route_points = _svg_route_points(result.get("route", ""))
    assert len(route_points) >= 4, f"Expected polyline route with turn points: {result.get('route')}"
    origin = result.get("origin_point") or {}
    origin_point = (float(origin.get("x", 0.0)), float(origin.get("y", 0.0)))
    vertical_hall = nav_service.graph.nodes["vertical_hallway_1_1"]
    horizontal_hall = nav_service.graph.nodes["hallway_wing_a_1_1"]
    vertical_center_x = vertical_hall.center[0]
    horizontal_center_y = horizontal_hall.center[1]
    assert origin_point in route_points, f"Expected route to include origin point: {route_points}"
    origin_idx = route_points.index(origin_point)
    vertical_center_idx = next(
        (
            i
            for i, (px, py) in enumerate(route_points)
            if i > origin_idx and abs(px - vertical_center_x) < 1e-6
        ),
        None,
    )
    assert vertical_center_idx is not None, (
        f"Expected route to reach the vertical hallway centerline x={vertical_center_x}: {route_points}"
    )
    between = route_points[origin_idx + 1 : vertical_center_idx]
    assert any(
        abs(py - origin_point[1]) < 1e-6 and abs(px - origin_point[0]) > 1e-6
        for px, py in between
    ), f"Expected right-shifted turn from origin into Wing A hallway: {route_points}"

    assert any(
        abs(route_points[i][0] - vertical_center_x) < 1e-6
        and abs(route_points[i + 1][0] - vertical_center_x) < 1e-6
        and abs(route_points[i][1] - route_points[i + 1][1]) > 1e-6
        for i in range(len(route_points) - 1)
    ), f"Expected a vertical segment on the Wing A hallway centerline: {route_points}"

    assert any(
        abs(route_points[i][1] - horizontal_center_y) < 1e-6
        and abs(route_points[i + 1][1] - horizontal_center_y) < 1e-6
        and abs(route_points[i][0] - route_points[i + 1][0]) > 1e-6
        for i in range(len(route_points) - 1)
    ), f"Expected a horizontal segment on Wing A hallway centerline y={horizontal_center_y}: {route_points}"


def test_main_entrance_to_office_c112_uses_direct_c_hallway_access(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "office-c112")
    path = result.get("path") or []

    assert path, "Expected valid route from Main Entrance to Office C112"
    assert "hallway_wing_c_1_3" in path, f"Expected direct access into Wing C hallway: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the A-B bridge: {path}"
    assert "bridge_hall_1_bc" not in path, f"Should not detour through the B-C bridge: {path}"
    assert "stairs1_Wing_A_2F" not in path, f"Should not detour to floor 2: {path}"
    assert "stairs2_Wing_C_2F" not in path, f"Should not detour to floor 2: {path}"

    floors = {nav_service.graph.nodes[node_id].floor for node_id in path if node_id in nav_service.graph.nodes}
    assert floors == {1}, f"Expected route to remain on floor 1: {path}"


def test_main_entrance_to_office_c114_uses_direct_c_hallway_access(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "office-c114")
    path = result.get("path") or []

    assert path, "Expected valid route from Main Entrance to Office C114"
    assert "hallway_wing_c_1_3" in path, f"Expected direct access into Wing C hallway: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the A-B bridge: {path}"
    assert "bridge_hall_1_bc" not in path, f"Should not detour through the B-C bridge: {path}"

    floors = {nav_service.graph.nodes[node_id].floor for node_id in path if node_id in nav_service.graph.nodes}
    assert floors == {1}, f"Expected route to remain on floor 1: {path}"


def test_classroom_a122_to_womens_cr_wing_c_1f_stays_on_floor_1(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("classroom-a122", "womens-cr-wingc-1f")
    path = result.get("path") or []

    assert path, "Expected valid route from Classroom A122 to Women's CR Wing C 1F"
    assert "bridge_hall_1_ab" in path, f"Expected 1F A-B bridge usage: {path}"
    assert "bridge_hall_1_bc" in path, f"Expected 1F B-C bridge usage: {path}"
    assert "stairs1_Wing_A_2F" not in path, f"Should not detour to Wing A 2F stairs: {path}"
    assert "stairs2_Wing_C_2F" not in path, f"Should not detour to Wing C 2F stairs: {path}"

    floors = {nav_service.graph.nodes[node_id].floor for node_id in path if node_id in nav_service.graph.nodes}
    assert floors == {1}, f"Expected route to remain on floor 1: {path}"

    floor_routes = result.get("floor_routes") or {}
    assert set(floor_routes.keys()) == {1}, f"Expected only a floor 1 route segment: {floor_routes}"


def test_main_entrance_to_pc_lab_1_avoids_wing_a_detour(
    nav_service: NavigationService,
):
    graph = nav_service.graph
    result = nav_service.parse_navigation("main entrance", "pc-lab-1")
    path = result.get("path") or []

    assert path, "Expected valid route from Main Entrance to PC Lab 1"
    assert "hallway_wing_c_1_3" in path, f"Expected route to start from the C-side main entrance access: {path}"
    assert any(node_id in {"bridge_hall_1_bc", "bridge_hall_2_bc"} for node_id in path), (
        f"Expected route to transfer through the B-C bridge chain: {path}"
    )
    assert "vertical_hallway_1_1" not in path, f"Should not begin by detouring through Wing A: {path}"
    assert "stairs1_Wing_A_1F" not in path, f"Should not detour through Wing A stairs: {path}"
    assert "stairs1_Wing_A_2F" not in path, f"Should not detour through Wing A 2F stairs: {path}"

    wing_a_candidate = _path_via_waypoints(graph, "main entrance", "pc-lab-1", ["stairs1_Wing_A_1F", "stairs1_Wing_A_2F"])
    assert wing_a_candidate, "Expected a baseline Wing A detour candidate for comparison"
    assert _route_length_for_path(graph, path) < _route_length_for_path(graph, wing_a_candidate), (
        f"Expected chosen route to be shorter than the Wing A detour: actual={path}, detour={wing_a_candidate}"
    )

    floor_routes = result.get("floor_routes") or {}
    assert set(floor_routes.keys()) == {1, 2}, f"Expected floor 1 and floor 2 route segments: {floor_routes}"


def test_classroom_a322_alias_resolves_to_chromatography_a322(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "Classroom A322 ")
    path = result.get("path") or []

    assert not result.get("error"), f"Expected Classroom A322 alias to resolve: {result.get('error')}"
    assert result.get("destination") == "Chromatography A322", (
        f"Expected Classroom A322 to resolve to Chromatography A322: {result}"
    )
    assert path, f"Expected a valid route to Classroom A322 alias: {result}"


def test_main_entrance_to_a322_floor3_route_uses_hallway_centerline_intersection(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "Classroom A322")
    floor_3_route = result.get("floor_routes", {}).get(3, "")
    floor_3_points = _svg_route_points(floor_3_route)

    assert floor_3_points, f"Expected floor 3 route points: {floor_3_route}"

    vertical_hall = nav_service.graph.nodes["vertical_hallway_3_1"]
    horizontal_hall = nav_service.graph.nodes["hallway_wing_a_3_1"]
    shared_connector = (vertical_hall.center[0], horizontal_hall.y + horizontal_hall.height)
    boundary_dogleg_points = {
        (vertical_hall.x, horizontal_hall.y + horizontal_hall.height),
        (vertical_hall.x, horizontal_hall.center[1]),
    }

    assert shared_connector in floor_3_points, (
        f"Expected floor 3 route to pass through the shared hallway connector {shared_connector}: "
        f"{floor_3_points}"
    )
    assert not (boundary_dogleg_points & set(floor_3_points)), (
        f"Expected floor 3 route to avoid the boundary dogleg points {boundary_dogleg_points}: {floor_3_points}"
    )


def test_main_entrance_to_a132_avoids_small_vertical_hallway_entry_jog(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "Scientific Glassblowing Room A132")
    floor_1_route = result.get("floor_routes", {}).get(1, "")
    floor_1_points = _svg_route_points(floor_1_route)

    assert floor_1_points, f"Expected floor 1 route points: {floor_1_route}"
    assert (905.0, 837.0) in floor_1_points, f"Expected route to enter the vertical hallway on its centerline: {floor_1_points}"
    assert (893.0, 837.0) not in floor_1_points, (
        f"Expected route to avoid the small boundary jog before entering the vertical hallway: {floor_1_points}"
    )


def test_main_entrance_to_b103_does_not_use_neighbor_room_access_nodes(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "General Chemistry Teaching Lab B103")
    path = result.get("path") or []

    assert path, "Expected valid route from Main Entrance to General Chemistry Teaching Lab B103"
    assert "junction_basic-chem-lab1-b101" not in path, f"Should not route through B101 junction: {path}"
    assert "door_basic-chem-lab1-b101" not in path, f"Should not route through B101 door: {path}"
    assert "bridge_hall_1_bc" in path, f"Expected shorter Main Entrance route to enter Wing B through the B-C bridge: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the longer A-B bridge chain: {path}"
    assert "door_general-chemistry-teaching-lab-b113" in path, f"Expected route to end at the destination door: {path}"


def test_main_entrance_floor1_b_routes_choose_shorter_legal_bridge_chain(
    nav_service: NavigationService,
):
    graph = nav_service.graph
    failures = []

    floor1_b_rooms = [
        room_id
        for room_id, room in graph.nodes.items()
        if room.type == "room"
        and room.floor == 1
        and room.wing == "B"
        and not bool((room.metadata or {}).get("passable"))
    ]

    for room_id in floor1_b_rooms:
        result = nav_service.parse_navigation("main entrance", room_id)
        actual_path = result.get("path") or []
        assert actual_path, f"Expected route from Main Entrance to {room_id}"
        actual_length = _route_length_for_path(graph, actual_path)

        candidate_lengths = []
        for bridge_id in ("bridge_hall_1_ab", "bridge_hall_1_bc"):
            candidate_path = _path_via_waypoints(graph, "main entrance", room_id, [bridge_id])
            if candidate_path:
                candidate_lengths.append(_route_length_for_path(graph, candidate_path))

        if candidate_lengths and actual_length > min(candidate_lengths) + 1e-6:
            failures.append((room_id, actual_length, min(candidate_lengths), actual_path))

    assert not failures, (
        "Expected Main Entrance -> 1F Wing B routes to choose the shortest legal bridge chain. "
        + "; ".join(
            f"{room_id}: actual={actual_len:.1f}, best={best_len:.1f}, path={path}"
            for room_id, actual_len, best_len, path in failures[:10]
        )
    )


def test_main_entrance_room_routes_remain_connected_without_foreign_room_shortcuts(
    nav_service: NavigationService,
):
    failures = []
    for room_id, room in nav_service.graph.nodes.items():
        if room.type != "room":
            continue
        if bool((room.metadata or {}).get("passable")):
            continue

        result = nav_service.parse_navigation("main entrance", room_id)
        path = result.get("path") or []
        if not path:
            failures.append(f"{room_id}: no path")
            continue

        offenders = _foreign_room_access_nodes(nav_service.graph, path, {room_id})
        if offenders:
            failures.append(f"{room_id}: {offenders}")

    assert not failures, (
        "Main entrance routes should stay connected and avoid unrelated room access nodes. "
        + "; ".join(failures[:20])
    )


def test_restroom_room_names_are_unique_in_live_graph(
    nav_service: NavigationService,
):
    restroom_rooms = [
        (node_id, node.name)
        for node_id, node in nav_service.graph.nodes.items()
        if node.type == "room" and "cr" in (node.name or "").lower()
    ]
    duplicate_names = []
    seen_names = {}
    for node_id, room_name in restroom_rooms:
        if room_name in seen_names:
            duplicate_names.append((room_name, seen_names[room_name], node_id))
        else:
            seen_names[room_name] = node_id

    assert not duplicate_names, f"Expected unique restroom room names, found duplicates: {duplicate_names}"


def test_womens_cr_to_office_c209_prefers_a_stairs_and_2f_bc_bridge(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Women's CR", "office-c209")
    assert not result.get("error"), f"Routing error: {result.get('error')}"
    assert result.get("origin") == "Women's CR A116", f"Expected generic Women's CR to resolve to A116: {result}"

    path = result.get("path") or []
    assert path, "Expected valid route from Women's CR to Office C209"
    assert "bridge_hall_2_bc" in path, f"Expected route to cross via the 2F B-C bridge: {path}"
    assert "stairs1_Wing_A_1F" in path, f"Expected route to use the shorter Wing A stairs: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the 1F A-B bridge: {path}"
    assert "stairs2_Wing_A_1F" not in path, f"Should not detour to the far Wing A stair shaft: {path}"


def test_main_entrance_to_a105_avoids_neighbor_room_junctions(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("main entrance", "physical-chemistry-teaching-lab-a105")
    path = result.get("path") or []

    assert path, "Expected valid route from Main Entrance to Physical Chemistry Teaching Lab A105"
    assert "junction_physical-chemistry-teaching-lab-a133" not in path, (
        f"Route should not cut through neighboring A133 room junction: {path}"
    )
    assert "vertical_hallway_1_2" not in path, (
        f"Route should stay on the Wing A hallway backbone instead of detouring to the far-right vertical: {path}"
    )


def test_a118_to_office_c208_prefers_upper_floor_bc_bridge_without_floor1_bridge_detour(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Balance Room A118", "office-c208")
    path = result.get("path") or []

    assert path, "Expected valid route from Balance Room A118 to Office C208"
    assert "bridge_hall_2_bc" in path, f"Expected route to use the 2F B-C bridge: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the 1F A-B bridge: {path}"
    assert "bridge_hall_1_bc" not in path, f"Should not detour through the 1F B-C bridge: {path}"
    assert "stairs2_Wing_C_1F" not in path, f"Should not detour into Wing C 1F stairs: {path}"

    floors = {nav_service.graph.nodes[node_id].floor for node_id in path if node_id in nav_service.graph.nodes}
    assert floors <= {1, 2}, f"Expected route to stay on floors 1 and 2 only: {path}"


def test_a118_to_c304_uses_bridge_centers_without_legacy_wing_a_top_detour(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Balance Room A118", "teaching-laboratory-statistics-c304")
    assert not result.get("error"), f"Routing error: {result.get('error')}"

    path = result.get("path") or []
    assert path, "Expected a valid path for Balance Room A118 -> Teaching Laboratory Statistics C304"
    assert "bridge_hall_3_bc" in path, f"Expected route to use the 3F B-C bridge: {path}"
    assert "bridge_hall_1_ab" not in path, f"Should not detour through the 1F A-B bridge: {path}"
    assert "bridge_hall_1_bc" not in path, f"Should not detour through the 1F B-C bridge: {path}"
    assert any(node_id in path for node_id in {"stairs1_Wing_A_3F", "stairs2_Wing_A_3F"}), (
        f"Expected route to climb through a Wing A stair shaft to 3F: {path}"
    )

    route_points = _svg_route_points(result.get("route", ""))
    bridge_bc = nav_service.graph.nodes["bridge_hall_3_bc"]
    assert (bridge_bc.x, bridge_bc.y) in route_points, (
        f"Expected route to pass through the 3F B-C bridge midpoint: {route_points}"
    )


def test_a118_to_c304_floor1_stair_turn_does_not_overshoot(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Balance Room A118", "teaching-laboratory-statistics-c304")
    assert not result.get("error"), f"Routing error: {result.get('error')}"

    floor_1_route = result.get("floor_routes", {}).get(1, "")
    floor_1_points = _svg_route_points(floor_1_route)
    assert floor_1_points, f"Expected floor 1 route points: {floor_1_route}"

    path = result.get("path") or []
    stair_id = "stairs1_Wing_A_1F" if "stairs1_Wing_A_1F" in path else "stairs2_Wing_A_1F"
    hallway_id = "vertical_hallway_1_1" if stair_id == "stairs1_Wing_A_1F" else "vertical_hallway_1_2"

    hallway = nav_service.graph.nodes[hallway_id]
    stair = nav_service.graph.nodes[stair_id]
    stair_point = stair.center if stair.width and stair.height else (stair.x, stair.y)

    assert stair_point in floor_1_points, f"Missing Wing A stair anchor in floor 1 route: {floor_1_points}"

    stair_idx = floor_1_points.index(stair_point)
    hallway_min_x = hallway.x - 1e-6
    hallway_max_x = hallway.x + (hallway.width or 0.0) + 1e-6
    matching_turns = [
        point
        for point in floor_1_points[:stair_idx]
        if abs(point[1] - stair_point[1]) < 1e-6 and hallway_min_x <= point[0] <= hallway_max_x
    ]
    assert matching_turns, f"Missing expected hallway-to-stair turn point: {floor_1_points}"
    turn_idx = floor_1_points.index(matching_turns[-1])
    assert turn_idx < stair_idx, (
        f"Expected a clean L-shaped turn from hallway into the stair on floor 1: {floor_1_points}"
    )


def test_a105_to_ics_lecture_hall_4_uses_hallway_boundary_bends_on_3f(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("physical-chemistry-teaching-lab-a105", "ics-lecture-hall-4")
    assert not result.get("error"), f"Routing error: {result.get('error')}"

    path = result.get("path") or []
    assert "vertical_hallway_3_1" in path, f"Expected route to pass through Wing A 3F vertical hallway: {path}"
    assert "hallway_wing_a_3_4" in path, f"Expected route to pass through Wing A 3F lecture hallway: {path}"

    floor_3_route = result.get("floor_routes", {}).get(3, "")
    floor_3_points = _svg_route_points(floor_3_route)
    assert floor_3_points, f"Expected floor 3 route points: {floor_3_route}"

    graph = nav_service.graph
    hall_a_3_1_idx = path.index("hallway_wing_a_3_1")
    preceding_node_id = path[hall_a_3_1_idx - 1]
    expected_points = [
        graph._edge_points(preceding_node_id, "hallway_wing_a_3_1")[0],
        graph._edge_points("hallway_wing_a_3_1", "vertical_hallway_3_1")[0],
        graph._edge_points("vertical_hallway_3_1", "hallway_wing_a_3_4")[0],
        graph._edge_points("hallway_wing_a_3_4", "junction_ics-lecture-hall-4")[0],
    ]
    for point in expected_points:
        assert point in floor_3_points, f"Missing expected 3F boundary point {point}: {floor_3_points}"

    upper_turn_idx = floor_3_points.index(expected_points[1])
    side_turn_idx = floor_3_points.index(expected_points[2])
    junction_idx = floor_3_points.index(expected_points[3])
    assert upper_turn_idx < side_turn_idx < junction_idx, (
        f"Expected route to descend the 3F vertical hallway before crossing into the lecture hall corridor: {floor_3_points}"
    )


def test_c315_to_b105_does_not_backtrack_at_bc_bridge_transition(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Office C315", "Basic Chem Lab B105")
    assert not result.get("error"), f"Routing error: {result.get('error')}"
    assert result.get("origin") == "office-c315", f"Expected canonical Office C315 room ID: {result}"
    assert result.get("destination") == "basic-chem-lab-b105", f"Expected canonical B105 room ID: {result}"

    path = result.get("path") or []
    assert "bridge_hall_3_bc" in path, f"Expected route to use the 3F B-C bridge: {path}"
    assert any(node_id in path for node_id in {"stairs1_Wing_B_3F", "stairs2_Wing_B_3F"}), (
        f"Expected route to descend via a Wing B stair shaft: {path}"
    )

    floor_3_route = result.get("floor_routes", {}).get(3, "")
    floor_3_points = _svg_route_points(floor_3_route)
    assert floor_3_points, f"Expected floor 3 route points: {floor_3_route}"

    assert all(
        floor_3_points[i] != floor_3_points[i + 2]
        for i in range(len(floor_3_points) - 2)
    ), f"Expected floor 3 route to avoid immediate backtracks: {floor_3_points}"

    legacy_result = nav_service.parse_navigation("equipment-room-physics-c330", "Basic Chem Lab B105")
    assert not legacy_result.get("error"), f"Legacy Office C315 alias failed: {legacy_result}"
    assert legacy_result.get("origin") == "office-c315", f"Expected legacy ID to resolve to canonical Office C315: {legacy_result}"
    assert legacy_result.get("path") == path, f"Expected legacy Office C315 alias to keep the same route: {legacy_result}"


def test_a105_to_office_c309_prefers_shorter_3f_bridge_route(
    nav_service: NavigationService,
):
    result = nav_service.parse_navigation("Physical Chemistry Teaching Lab A105", "Office C309")
    assert not result.get("error"), f"Routing error: {result.get('error')}"

    path = result.get("path") or []
    assert path, "Expected valid route from Physical Chemistry Teaching Lab A105 to Office C309"
    assert "bridge_hall_3_bc" in path, f"Expected route to use the 3F B-C bridge: {path}"
    assert any(node_id in path for node_id in {"stairs1_Wing_A_3F", "stairs2_Wing_A_3F"}), (
        f"Expected route to climb to Wing A 3F before crossing to Wing C: {path}"
    )
    assert "stairs1_Wing_C_2F" not in path, f"Should not take the longer 2F bridge then Wing C stair detour: {path}"
    assert "stairs1_Wing_C_3F" not in path, f"Should not need Wing C stairs when already crossing on 3F: {path}"

    floors = {nav_service.graph.nodes[node_id].floor for node_id in path if node_id in nav_service.graph.nodes}
    assert floors <= {1, 2, 3}, f"Unexpected floors in route: {path}"
