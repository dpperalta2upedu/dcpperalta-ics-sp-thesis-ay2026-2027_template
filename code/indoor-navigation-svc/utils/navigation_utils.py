from collections import defaultdict
from typing import Dict, List


def _has_area(node) -> bool:
    return (
        node.width is not None
        and node.height is not None
        and node.width > 0
        and node.height > 0
    )


def _node_route_point(node_id: str, node) -> tuple[float, float]:
    if node.type == "hallway":
        return (node.x, node.y)
    if _has_area(node):
        return node.center
    return (node.x, node.y)


def _point_touches_rect(point: tuple[float, float], rx: float, ry: float, rw: float, rh: float, tol: float = 1e-6) -> bool:
    px, py = point
    return (rx - tol) <= px <= (rx + rw + tol) and (ry - tol) <= py <= (ry + rh + tol)

def _point_inside_rect(px: float, py: float, rx: float, ry: float, rw: float, rh: float) -> bool:
    return rx < px < (rx + rw) and ry < py < (ry + rh)


def _segments_intersect(a1, a2, b1, b2) -> bool:
    def orient(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        if v > 0:
            return 1
        if v < 0:
            return -1
        return 0

    def on_segment(p, q, r):
        return min(p[0], r[0]) <= q[0] <= max(p[0], r[0]) and min(p[1], r[1]) <= q[1] <= max(p[1], r[1])

    o1 = orient(a1, a2, b1)
    o2 = orient(a1, a2, b2)
    o3 = orient(b1, b2, a1)
    o4 = orient(b1, b2, a2)

    if o1 != o2 and o3 != o4:
        return True
    if o1 == 0 and on_segment(a1, b1, a2):
        return True
    if o2 == 0 and on_segment(a1, b2, a2):
        return True
    if o3 == 0 and on_segment(b1, a1, b2):
        return True
    if o4 == 0 and on_segment(b1, a2, b2):
        return True
    return False


def _segment_intersects_any_room(graph, p1, p2, floor: int, excluded_room_ids: set[str]) -> bool:
    for node in graph.nodes.values():
        if node.type != "room" or node.floor != floor or not _has_area(node):
            continue
        if node.id in excluded_room_ids:
            continue
        rx, ry, rw, rh = node.x, node.y, node.width, node.height
        if _point_inside_rect(p1[0], p1[1], rx, ry, rw, rh) or _point_inside_rect(p2[0], p2[1], rx, ry, rw, rh):
            return True
        tl = (rx, ry)
        tr = (rx + rw, ry)
        br = (rx + rw, ry + rh)
        bl = (rx, ry + rh)
        if (
            _segments_intersect(p1, p2, tl, tr)
            or _segments_intersect(p1, p2, tr, br)
            or _segments_intersect(p1, p2, br, bl)
            or _segments_intersect(p1, p2, bl, tl)
        ):
            return True
    return False


def _extract_room_id_from_door(node_id: str) -> str | None:
    if isinstance(node_id, str) and node_id.startswith("door_"):
        return node_id[5:]
    return None


def _hallway_centerline_intersection_points(from_node, to_node) -> tuple[tuple[float, float], tuple[float, float]] | None:
    if from_node.type != "hallway" or to_node.type != "hallway":
        return None
    if not (_has_area(from_node) and _has_area(to_node)):
        return None

    overlap_left = max(from_node.x, to_node.x)
    overlap_right = min(from_node.x + from_node.width, to_node.x + to_node.width)
    overlap_top = max(from_node.y, to_node.y)
    overlap_bottom = min(from_node.y + from_node.height, to_node.y + to_node.height)
    if overlap_left > overlap_right or overlap_top > overlap_bottom:
        return None

    def clamp(value: float, low: float, high: float) -> float:
        return min(max(value, low), high)

    candidates = []
    if from_node.height > from_node.width:
        candidates.append((clamp(from_node.center[0], overlap_left, overlap_right), (overlap_top + overlap_bottom) / 2.0))
    else:
        candidates.append(((overlap_left + overlap_right) / 2.0, clamp(from_node.center[1], overlap_top, overlap_bottom)))

    if to_node.height > to_node.width:
        candidates.append((clamp(to_node.center[0], overlap_left, overlap_right), (overlap_top + overlap_bottom) / 2.0))
    else:
        candidates.append(((overlap_left + overlap_right) / 2.0, clamp(to_node.center[1], overlap_top, overlap_bottom)))

    for point in candidates:
        if _point_touches_rect(point, from_node.x, from_node.y, from_node.width, from_node.height) and _point_touches_rect(
            point, to_node.x, to_node.y, to_node.width, to_node.height
        ):
            return (point, point)
    return None


def _project_helper_point_to_hallway_centerline(helper_node, hallway_node) -> tuple[tuple[float, float], tuple[float, float]] | None:
    if helper_node.type != "hallway" or _has_area(helper_node):
        return None
    if hallway_node.type != "hallway" or not _has_area(hallway_node):
        return None
    if not (helper_node.id.startswith("layout_attach_") or helper_node.id.startswith("layout_junction_")):
        return None
    if not _point_touches_rect(
        (helper_node.x, helper_node.y),
        hallway_node.x,
        hallway_node.y,
        hallway_node.width,
        hallway_node.height,
    ):
        return None

    if hallway_node.height > hallway_node.width:
        projected = (hallway_node.center[0], min(max(helper_node.y, hallway_node.y), hallway_node.y + hallway_node.height))
    else:
        projected = (min(max(helper_node.x, hallway_node.x), hallway_node.x + hallway_node.width), hallway_node.center[1])
    return (projected, projected)


def _preferred_helper_render_point(graph, node_id: str, node) -> tuple[float, float] | None:
    if node.type != "hallway" or _has_area(node):
        return None
    if not (node_id.startswith("layout_attach_") or node_id.startswith("layout_junction_")):
        return None

    hallway_neighbors = []
    for neighbor_id in graph.get_neighbors(node_id):
        neighbor = graph.nodes.get(neighbor_id)
        if not neighbor or neighbor.type != "hallway" or not _has_area(neighbor):
            continue
        hallway_neighbors.append(neighbor)
    if len(hallway_neighbors) != 1:
        return None

    hallway_node = hallway_neighbors[0]
    projected_pair = _project_helper_point_to_hallway_centerline(node, hallway_node)
    if not projected_pair:
        return None
    return projected_pair[0]


def _edge_route_points(graph, from_node_id: str, to_node_id: str) -> tuple[tuple[float, float], tuple[float, float]]:
    if hasattr(graph, "_edge_points"):
        try:
            from_node = graph.nodes.get(from_node_id)
            to_node = graph.nodes.get(to_node_id)
            if from_node and to_node and from_node.floor == to_node.floor:
                hallway_intersection = _hallway_centerline_intersection_points(from_node, to_node)
                if hallway_intersection:
                    return hallway_intersection
                helper_projection = _project_helper_point_to_hallway_centerline(from_node, to_node)
                if helper_projection:
                    return helper_projection
                helper_projection = _project_helper_point_to_hallway_centerline(to_node, from_node)
                if helper_projection:
                    return helper_projection
            p1, p2 = graph._edge_points(from_node_id, to_node_id)
            if from_node:
                preferred = _preferred_helper_render_point(graph, from_node_id, from_node)
                if preferred:
                    p1 = preferred
            if to_node:
                preferred = _preferred_helper_render_point(graph, to_node_id, to_node)
                if preferred:
                    p2 = preferred
            return p1, p2
        except Exception:
            pass

    from_node = graph.nodes.get(from_node_id)
    to_node = graph.nodes.get(to_node_id)
    if not from_node or not to_node:
        return ((0.0, 0.0), (0.0, 0.0))
    return (_node_route_point(from_node_id, from_node), _node_route_point(to_node_id, to_node))


def _hallway_axis_points(node, entry_point: tuple[float, float], exit_point: tuple[float, float]) -> list[tuple[float, float]]:
    if node.type != "hallway" or not _has_area(node) or entry_point == exit_point:
        return []

    center_x, center_y = node.center
    if node.height > node.width:
        candidates = [(center_x, entry_point[1]), (center_x, exit_point[1])]
    else:
        candidates = [(entry_point[0], center_y), (exit_point[0], center_y)]

    internal_points: list[tuple[float, float]] = []
    for point in candidates:
        if point == entry_point or point == exit_point:
            continue
        if internal_points and internal_points[-1] == point:
            continue
        internal_points.append(point)
    return internal_points


def _collapse_immediate_backtracks(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    collapsed: list[tuple[float, float]] = []
    for point in points:
        collapsed.append(point)
        while len(collapsed) >= 3 and collapsed[-1] == collapsed[-3]:
            collapsed.pop()
            collapsed.pop()
    return collapsed


def path_to_svg(graph, path: List[str]) -> str:
    if not path:
        return ""

    def append_unique(point: tuple[float, float]) -> None:
        if expanded_points and expanded_points[-1] == point:
            return
        expanded_points.append(point)

    valid_node_ids = [node_id for node_id in path if node_id in graph.nodes]
    if not valid_node_ids:
        return ""
    if len(valid_node_ids) == 1:
        node = graph.nodes[valid_node_ids[0]]
        point = _node_route_point(valid_node_ids[0], node)
        return f"M {point[0]} {point[1]}"

    expanded_points: list[tuple[float, float]] = []
    previous_segment_end: tuple[float, float] | None = None

    for i in range(len(valid_node_ids) - 1):
        from_id = valid_node_ids[i]
        to_id = valid_node_ids[i + 1]
        n1 = graph.nodes.get(from_id)
        n2 = graph.nodes.get(to_id)
        if not n1 or not n2:
            continue
        p1, p2 = _edge_route_points(graph, from_id, to_id)
        if not expanded_points:
            expanded_points.append(p1)
        else:
            for point in _hallway_axis_points(n1, previous_segment_end, p1):
                append_unique(point)
            append_unique(p1)

        is_hallway_door_edge = (
            (n1.type == "hallway" and n2.type == "door")
            or (n1.type == "door" and n2.type == "hallway")
        )
        is_main_entrance_hallway_edge = (
            n1.floor == n2.floor
            and (
                (from_id == "main entrance" and n2.type == "hallway")
                or (to_id == "main entrance" and n1.type == "hallway")
            )
        )
        is_bridge_centerline_edge = (
            n1.floor == n2.floor
            and (
                (from_id.startswith("bridge_hall_") and n2.type in {"hallway", "stairs"})
                or (to_id.startswith("bridge_hall_") and n1.type in {"hallway", "stairs"})
            )
        )
        is_hallway_junction_edge = (
            n1.floor == n2.floor
            and (
                (n1.type == "hallway" and to_id.startswith("junction_"))
                or (n2.type == "hallway" and from_id.startswith("junction_"))
            )
        )
        needs_orthogonal_bend = (
            n1.floor == n2.floor
            and p1[0] != p2[0]
            and p1[1] != p2[1]
            and (
                is_hallway_door_edge
                or is_main_entrance_hallway_edge
                or is_bridge_centerline_edge
                or is_hallway_junction_edge
            )
        )
        if needs_orthogonal_bend:
            if p1[0] != p2[0] and p1[1] != p2[1]:
                # Prefer orthogonal transitions through stair/bridge centerlines and
                # hallway-door boundaries instead of diagonal cuts.
                candidate_bends = [(p1[0], p2[1]), (p2[0], p1[1])]
                if is_main_entrance_hallway_edge:
                    # Bias the entrance turn toward the hallway x-side (rightward for
                    # the current map), then descend/ascend to hallway centerline.
                    if from_id == "main entrance":
                        candidate_bends = [(p2[0], p1[1]), (p1[0], p2[1])]
                    else:
                        candidate_bends = [(p1[0], p2[1]), (p2[0], p1[1])]
                elif is_bridge_centerline_edge:
                    # Keep vertical bridge transfers aligned to bridge midpoint x.
                    if from_id.startswith("bridge_hall_"):
                        candidate_bends = [(p1[0], p2[1]), (p2[0], p1[1])]
                    else:
                        candidate_bends = [(p2[0], p1[1]), (p1[0], p2[1])]
                elif is_hallway_junction_edge:
                    if n1.type == "hallway":
                        candidate_bends = [(p2[0], p1[1]), (p1[0], p2[1])]
                    else:
                        candidate_bends = [(p1[0], p2[1]), (p2[0], p1[1])]
                excluded_room_ids = set()
                for node_id in (from_id, to_id):
                    owner_room = _extract_room_id_from_door(node_id)
                    if owner_room:
                        excluded_room_ids.add(owner_room)

                bend = None
                for candidate in candidate_bends:
                    if candidate == p1 or candidate == p2:
                        continue
                    if _segment_intersects_any_room(graph, p1, candidate, n1.floor, excluded_room_ids):
                        continue
                    if _segment_intersects_any_room(graph, candidate, p2, n1.floor, excluded_room_ids):
                        continue
                    bend = candidate
                    break

                if bend is None:
                    for candidate in candidate_bends:
                        if candidate != p1 and candidate != p2:
                            bend = candidate
                            break

                if bend:
                    append_unique(bend)

        append_unique(p2)
        previous_segment_end = p2

    expanded_points = _collapse_immediate_backtracks(expanded_points)

    d = f"M {expanded_points[0][0]} {expanded_points[0][1]}"
    for x, y in expanded_points[1:]:
        d += f" L {x} {y}"

    return d


def split_path_by_floor(graph, path: List[str]) -> Dict[int, List[str]]:
    floor_paths: Dict[int, List[str]] = {}
    current_floor = None

    for node_id in path:
        node = graph.nodes.get(node_id)
        if not node:
            print(f"[WARN] Node not found: {node_id}")
            continue

        if current_floor is None:
            current_floor = node.floor
            floor_paths[current_floor] = []

        if node.floor != current_floor:
            current_floor = node.floor
            if current_floor not in floor_paths:
                floor_paths[current_floor] = []

        floor_paths[current_floor].append(node_id)

    return floor_paths


def group_nodes_by_floor(graph) -> dict:
    floors = defaultdict(list)
    for node in graph.nodes.values():
        floors[node.floor].append(node.id)
    return floors
