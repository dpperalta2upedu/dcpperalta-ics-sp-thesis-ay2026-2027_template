from typing import List, Dict, Tuple, Set
from models.node import Node
import json
import math
import re
from shapely.geometry import LineString, box
from collections import defaultdict
from constants.navigation_constants import LOCATION_ALIASES
from constants.navigation_constants import MAIN_ENTRANCE_NODE_ID


class NavigationGraph:
    def __init__(self):
        self.nodes: Dict[str, Node] = {}
        self.edges: List[Tuple[str, str]] = []
        self.adjacency: Dict[str, Set[str]] = {}
        self.floors = defaultdict(lambda: defaultdict(list))
        self._edge_cross_cache: Dict[Tuple[str, str], bool] = {}

    def _has_area(self, node: Node) -> bool:
        return (
            node.width is not None
            and node.height is not None
            and node.width > 0
            and node.height > 0
        )

    def _traversal_point(self, node_id: str) -> Tuple[float, float]:
        node = self.nodes[node_id]
        if node.type != "hallway" and self._has_area(node):
            return node.center
        return (node.x, node.y)

    def _closest_point_on_rect(self, node: Node, target: Tuple[float, float]) -> Tuple[float, float]:
        left = node.x
        top = node.y
        right = node.x + (node.width or 0.0)
        bottom = node.y + (node.height or 0.0)
        tx, ty = target
        px = min(max(tx, left), right)
        py = min(max(ty, top), bottom)
        if left < tx < right and top < ty < bottom:
            candidates = (
                (abs(tx - left), (left, ty)),
                (abs(tx - right), (right, ty)),
                (abs(ty - top), (tx, top)),
                (abs(ty - bottom), (tx, bottom)),
            )
            return min(candidates, key=lambda item: item[0])[1]
        return (px, py)

    def _edge_points(self, node1_id: str, node2_id: str) -> Tuple[Tuple[float, float], Tuple[float, float]]:
        node1 = self.nodes[node1_id]
        node2 = self.nodes[node2_id]
        point1 = self._traversal_point(node1_id)
        point2 = self._traversal_point(node2_id)

        if node1.type == "hallway" and self._has_area(node1):
            point1 = self._closest_point_on_rect(node1, point2)
        if node2.type == "hallway" and self._has_area(node2):
            point2 = self._closest_point_on_rect(node2, point1)
        return point1, point2

    def _room_ids_for_endpoint(self, node_id: str, node: Node) -> Set[str]:
        room_ids: Set[str] = set()
        if node.type == "room":
            room_ids.add(node_id)
        if isinstance(node_id, str) and node_id.startswith("door_"):
            room_ids.add(node_id[5:])
        if isinstance(node_id, str) and node_id.startswith("junction_"):
            room_ids.add(node_id[len("junction_"):])
        return {
            room_id
            for room_id in room_ids
            if room_id in self.nodes and self.nodes[room_id].type == "room"
        }

    def _rooms_overlap_interior(self, room_a: Node, room_b: Node) -> bool:
        if room_a.floor != room_b.floor:
            return False
        if not (self._has_area(room_a) and self._has_area(room_b)):
            return False
        overlap_x = min(room_a.x + room_a.width, room_b.x + room_b.width) - max(room_a.x, room_b.x)
        overlap_y = min(room_a.y + room_a.height, room_b.y + room_b.height) - max(room_a.y, room_b.y)
        return overlap_x > 0 and overlap_y > 0

    # --------------------------
    # Node / Edge Management
    # --------------------------
    def add_node(self, node: Node):
        self.nodes[node.id] = node
        if node.id not in self.adjacency:
            self.adjacency[node.id] = set()
        self.floors[node.floor][node.type].append(node.id)
        self._edge_cross_cache.clear()

    def add_edge(self, node1_id: str, node2_id: str):
        if node1_id == node2_id:
            return
        # Avoid duplicate undirected edges
        if (node1_id, node2_id) in self.edges or (node2_id, node1_id) in self.edges:
            return
        self.edges.append((node1_id, node2_id))
        self.adjacency.setdefault(node1_id, set()).add(node2_id)
        self.adjacency.setdefault(node2_id, set()).add(node1_id)
        self._edge_cross_cache.clear()

    def remove_edge(self, node1_id: str, node2_id: str):
        if (node1_id, node2_id) in self.edges:
            self.edges.remove((node1_id, node2_id))
        elif (node2_id, node1_id) in self.edges:
            self.edges.remove((node2_id, node1_id))
        if node1_id in self.adjacency:
            self.adjacency[node1_id].discard(node2_id)
        if node2_id in self.adjacency:
            self.adjacency[node2_id].discard(node1_id)
        self._edge_cross_cache.clear()

    def get_neighbors(self, node_id: str) -> List[str]:
        return list(self.adjacency.get(node_id, set()))

    # --------------------------
    # Distance / Heuristic
    # --------------------------
    def calculate_distance(self, node1_id: str, node2_id: str) -> float:
        node1 = self.nodes[node1_id]
        node2 = self.nodes[node2_id]
        (x1, y1), (x2, y2) = self._edge_points(node1_id, node2_id)
        # Strongly discourage unnecessary floor changes (e.g., going down then up via another wing).
        floor_penalty = abs(node1.floor - node2.floor) * 150
        horizontal_dist = math.hypot(x2 - x1, y2 - y1)
        # Prefer backbone hallway traversal over long chains of room-connection junctions.
        node1_is_junction = node1_id.startswith("junction_")
        node2_is_junction = node2_id.startswith("junction_")
        if node1_is_junction and node2_is_junction:
            junction_penalty = 120
        elif node1_is_junction or node2_is_junction:
            junction_penalty = 24
        else:
            junction_penalty = 0
        # Doors are entry/exit points, not corridor spine; discourage door-to-door transit.
        door_penalty = 25 if (node1.type == "door" and node2.type == "door") else 0
        return horizontal_dist + floor_penalty + junction_penalty + door_penalty

    def heuristic(self, node_a: Node, node_b: Node) -> float:
        ax, ay = node_a.center if node_a.type != "hallway" and self._has_area(node_a) else (node_a.x, node_a.y)
        bx, by = node_b.center if node_b.type != "hallway" and self._has_area(node_b) else (node_b.x, node_b.y)
        return math.hypot(bx - ax, by - ay)

    def _match_keys(self, value: str) -> Set[str]:
        norm = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())).strip()
        if not norm:
            return set()
        keys = {norm}
        keys.add(re.sub(r"([0-9])f\b", r"\1", norm))
        keys.add(re.sub(r"([0-9])\b", r"\1f", norm))
        return {k for k in keys if k}

    def _room_code_keys(self, value: str) -> Set[str]:
        raw = str(value or "").lower()
        keys = set()
        keys.update(re.findall(r"\b([abc]\d{3}[a-z]?)\b", raw))
        compact = re.sub(r"[^a-z0-9]+", "", raw)
        keys.update(re.findall(r"([abc]\d{3}[a-z]?)", compact))
        return {k for k in keys if k}

    def resolve_node_id(self, node_id: str) -> str | None:
        if node_id in self.nodes:
            return node_id

        alias_value = LOCATION_ALIASES.get(str(node_id or "").strip().lower())
        target_keys = self._match_keys(node_id) | self._match_keys(alias_value or "")
        target_room_codes = self._room_code_keys(node_id) | self._room_code_keys(alias_value or "")
        if not target_keys:
            target_keys = set()

        for existing_id, node in self.nodes.items():
            if target_keys & self._match_keys(existing_id):
                return existing_id
            if target_keys & self._match_keys(node.name or ""):
                return existing_id
            if target_room_codes:
                existing_room_codes = self._room_code_keys(existing_id) | self._room_code_keys(node.name or "")
                if target_room_codes & existing_room_codes:
                    return existing_id
        return None

    # --------------------------
    # Room Collision
    # --------------------------
    def edge_crosses_room(self, node_a_id: str, node_b_id: str) -> bool:
        """
        True if the edge crosses the interior of any room (not allowed).
        Safe connections via doors, junctions, stairs, hallways are allowed.
        """
        if MAIN_ENTRANCE_NODE_ID in {node_a_id, node_b_id}:
            return False
        cache_key = (node_a_id, node_b_id) if node_a_id <= node_b_id else (node_b_id, node_a_id)
        cached = self._edge_cross_cache.get(cache_key)
        if cached is not None:
            return cached

        a = self.nodes[node_a_id]
        b = self.nodes[node_b_id]
        (ax, ay), (bx, by) = self._edge_points(node_a_id, node_b_id)
        line = LineString([(ax, ay), (bx, by)])

        excluded_room_ids: Set[str] = set()
        endpoint_rooms: list[Node] = []
        for node_id, node in ((node_a_id, a), (node_b_id, b)):
            room_ids = self._room_ids_for_endpoint(node_id, node)
            excluded_room_ids.update(room_ids)
            endpoint_rooms.extend(
                self.nodes[room_id]
                for room_id in room_ids
                if room_id in self.nodes and self.nodes[room_id].type == "room"
            )

        for room in self.nodes.values():
            if room.type != "room":
                continue
            if room.floor != a.floor:
                continue
            if (room.metadata or {}).get("layout_matched") is False:
                continue
            if bool((room.metadata or {}).get("passable")):
                continue
            if room.id in excluded_room_ids:
                continue
            if any(self._rooms_overlap_interior(room, endpoint_room) for endpoint_room in endpoint_rooms):
                continue
            if not hasattr(room, "width") or not hasattr(room, "height"):
                continue
            rect = box(room.x, room.y, room.x + room.width, room.y + room.height)
            if line.intersects(rect) and not line.touches(rect):
                self._edge_cross_cache[cache_key] = True
                return True
        self._edge_cross_cache[cache_key] = False
        return False

    # --------------------------
    # A* Pathfinding
    # --------------------------
    def a_star_pathfinding(
        self,
        start: str,
        goal: str,
        blocked_nodes: Set[str] | None = None,
        *,
        exact: bool = False,
    ):
        start_id = self.resolve_node_id(start)
        goal_id = self.resolve_node_id(goal)
        if not start_id or not goal_id:
            raise ValueError("Start or goal node not found in graph")
        start = start_id
        goal = goal_id
        blocked = set(blocked_nodes or set())
        if start != MAIN_ENTRANCE_NODE_ID and goal != MAIN_ENTRANCE_NODE_ID:
            blocked.add(MAIN_ENTRANCE_NODE_ID)
        blocked.discard(start)
        blocked.discard(goal)
        if start in blocked or goal in blocked:
            return [], float("inf")

        open_set = {start}
        came_from = {}

        g_score = {node_id: float("inf") for node_id in self.nodes}
        g_score[start] = 0

        f_score = {node_id: float("inf") for node_id in self.nodes}
        f_score[start] = 0.0 if exact else self.heuristic(self.nodes[start], self.nodes[goal])

        while open_set:
            current = min(open_set, key=lambda n: f_score[n])
            if current == goal:
                return self.reconstruct_path(came_from, current), g_score[goal]

            open_set.remove(current)
            current_node = self.nodes[current]

            for neighbor in self.get_neighbors(current):
                if neighbor in blocked:
                    continue
                neighbor_node = self.nodes[neighbor]

                # Strict geometry: never traverse edges that cut through room interiors.
                if self.edge_crosses_room(current, neighbor):
                    continue

                tentative_g = g_score[current] + self.calculate_distance(current, neighbor)
                if tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    heuristic = 0.0 if exact else self.heuristic(neighbor_node, self.nodes[goal])
                    f_score[neighbor] = tentative_g + heuristic
                    open_set.add(neighbor)

        # No path found
        return [], float("inf")

    # --------------------------
    # Path Reconstruction
    # --------------------------
    def reconstruct_path(self, came_from: Dict[str, str], current: str) -> List[str]:
        path = [current]
        while current in came_from:
            current = came_from[current]
            path.append(current)
        return path[::-1]

    # --------------------------
    # Path Details
    # --------------------------
    def get_path_details(self, path: List[str]) -> Dict:
        if not path:
            return {"path": [], "distance": 0, "steps": []}

        total_distance = 0
        steps = []

        for i in range(len(path) - 1):
            current_node = self.nodes[path[i]]
            next_node = self.nodes[path[i + 1]]
            segment_distance = self.calculate_distance(path[i], path[i + 1])
            total_distance += segment_distance
            current_dict = current_node.to_dict()
            next_dict = next_node.to_dict()
            if self._has_area(current_node):
                cx, cy = current_node.center
                current_dict["x"] = cx
                current_dict["y"] = cy
            if self._has_area(next_node):
                nx, ny = next_node.center
                next_dict["x"] = nx
                next_dict["y"] = ny
            steps.append({
                "from": current_dict,
                "to": next_dict,
                "distance": round(segment_distance, 2)
            })

        return {
            "path": path,
            "distance": round(total_distance, 2),
            "steps": steps,
            "num_stops": len(path)
        }

    # --------------------------
    # Export / Import
    # --------------------------
    def to_dict(self) -> Dict:
        return {
            "nodes": [node.to_dict() for node in self.nodes.values()],
            "edges": [[e[0], e[1]] for e in self.edges]
        }

    def to_json(self, filename: str):
        with open(filename, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def from_dict(cls, data: Dict):
        graph = cls()
        for node_data in data.get("nodes", []):
            node = Node(
                id=node_data["id"],
                x=node_data["x"],
                y=node_data["y"],
                width=node_data.get("width"),
                height=node_data.get("height"),
                floor=node_data.get("floor", 1),
                wing=node_data.get("wing"),
                name=node_data.get("name"),
                type=node_data.get("type"),
                metadata=node_data.get("metadata", {})
            )
            graph.add_node(node)

        for edge in data.get("edges", []):
            graph.add_edge(edge[0], edge[1])

        return graph

    @classmethod
    def from_json(cls, filename: str):
        with open(filename, "r") as f:
            data = json.load(f)
        return cls.from_dict(data)
