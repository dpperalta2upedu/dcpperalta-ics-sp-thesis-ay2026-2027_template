import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from typing import List
from services.navigation_graph import NavigationGraph
from models.node import Node
from sandbox.services.sb_main_map_layout_service import SandboxMainMapLayoutService
from sandbox.services.sb_navigation_graph_cache_service import NavigationGraphCacheService
import math
from sandbox.services.sb_building_config import (
    create_hallway_nodes,
    create_room_nodes,
    create_stair_nodes,
    connect_room_to_hallway_nodes,
    line_intersects_rect,
)
from utils.navigation_utils import path_to_svg
from utils.navigation_utils import split_path_by_floor
from utils.navigation_utils import group_nodes_by_floor
from constants.navigation_constants import (
    FLOOR_KEY,
    LOCATION_ALIASES,
    MAIN_ENTRANCE_NODE_ID,
    NODE_TYPE_HALLWAY,
    NODE_TYPE_ROOM,
    NODE_TYPE_STAIRS,
)
from services.routing_topology import WING_B_ROUTING_EDGES
from services.routing_topology import WING_C_ROUTING_EDGES
from services.routing_topology import BRIDGE_ROUTING_EDGES
from sandbox.utils.sb_map_layout import map_layout_context

HALLWAY_WING_A_1_1 = "hallway_wing_a_1_1"
HALLWAY_WING_A_1_4 = "vertical_hallway_1_1"
VERTICAL_HALLWAY_1_2 = "vertical_hallway_1_2"
HALLWAY_WING_A_2_1 = "hallway_wing_a_2_1"
HALLWAY_WING_A_2_4 = "vertical_hallway_2_1"
VERTICAL_HALLWAY_2_2 = "vertical_hallway_2_2"
VERTICAL_HALLWAY_2_3 = "vertical_hallway_2_3"
HALLWAY_WING_A_3_1 = "hallway_wing_a_3_1"
HALLWAY_WING_A_3_4 = "vertical_hallway_3_1"
VERTICAL_HALLWAY_3_2 = "vertical_hallway_3_2"
VERTICAL_HALLWAY_3_3 = "vertical_hallway_3_3"
HALLWAY_WING_A_3_4_LEFT = "hallway_wing_a_3_4"
HALLWAY_WING_A_3_5 = "hallway_wing_a_3_5"
HALLWAY_WING_B_1_2 = "hallway_wing_b_1_2"
HALLWAY_WING_B_2_2 = "hallway_wing_b_2_2"
HALLWAY_WING_B_2_4 = "hallway_wing_b_2_4"
HALLWAY_WING_B_2_5 = "hallway_wing_b_2_5"
HALLWAY_WING_B_3_2 = "hallway_wing_b_3_2"
HALLWAY_WING_C_1_3 = "hallway_wing_c_1_3"
HALLWAY_WING_C_2_3 = "hallway_wing_c_2_3"
HALLWAY_WING_C_3_3 = "hallway_wing_c_3_3"

WING_A_ROUTING_EDGES = [
    # 1F hallway spine
    ("hall_1_1", "hall_1_5"),
    ("hall_1_5", "hall_1_4"),
    ("hall_1_4", HALLWAY_WING_A_1_1),
    (HALLWAY_WING_A_1_1, "hall_1_turn"),
    ("hall_1_turn", "hall_1_0"),
    ("hall_1_0", "hall_1_turn_right"),
    ("hall_1_0", HALLWAY_WING_A_1_4),
    (HALLWAY_WING_A_1_1, VERTICAL_HALLWAY_1_2),
    ("stairs1_Wing_A_1F", "bridge_hall_1_ab"),
    ("hall_1_turn_right", "hall_1_2"),
    # 2F hallway spine
    ("hall_2_1", "hall_2_5"),
    ("hall_2_5", "hall_2_4"),
    ("hall_2_4", HALLWAY_WING_A_2_1),
    (HALLWAY_WING_A_2_1, HALLWAY_WING_A_2_4),
    (HALLWAY_WING_A_2_1, VERTICAL_HALLWAY_2_2),
    (HALLWAY_WING_A_2_4, HALLWAY_WING_B_2_4),
    (HALLWAY_WING_A_2_4, HALLWAY_WING_B_2_5),
    (VERTICAL_HALLWAY_2_3, HALLWAY_WING_B_2_4),
    (VERTICAL_HALLWAY_2_3, HALLWAY_WING_B_2_5),
    (HALLWAY_WING_A_2_4, "hall_2_2"),
    # 3F hallway spine
    ("hall_3_1", "hall_3_5"),
    ("hall_3_5", "hall_3_4"),
    ("hall_3_4", HALLWAY_WING_A_3_1),
    (HALLWAY_WING_A_3_1, HALLWAY_WING_A_3_4),
    (HALLWAY_WING_A_3_1, VERTICAL_HALLWAY_3_2),
    (HALLWAY_WING_A_3_4, HALLWAY_WING_A_3_4_LEFT),
    (HALLWAY_WING_A_3_4, HALLWAY_WING_A_3_5),
    (VERTICAL_HALLWAY_3_3, HALLWAY_WING_A_3_4_LEFT),
    (VERTICAL_HALLWAY_3_3, HALLWAY_WING_A_3_5),
    (HALLWAY_WING_A_3_4, "hall_3_2"),
]
# Forbidden direct connectors that cut through rooms.
FORBIDDEN_SHORTCUT_CONNECTORS = [
    ("junction_Balance Room B214", "junction_Balance Room A240"),
]
BRIDGE_REQUIRED_DESTINATION_WAYPOINTS = {
    # Keep Reflection Pool routing anchored to the left Wing C hallway endpoint.
    "reflection-pool": ["hall_c_1_0"],
}
BRIDGE_REQUIRED_ORIGIN_WAYPOINTS = {
    # Keep Reflection Pool departures exiting through the left Wing C hallway endpoint.
    "reflection-pool": ["hall_c_1_0"],
}
ROOM_HALLWAY_HINTS = {
    "ics-mega-hall": ["hallway_wing_b_2_4", "vertical_hallway_2_3"],
    "ics-lecture-hall-3": ["hallway_wing_a_3_4", "vertical_hallway_3_3"],
    "ics-lecture-hall-4": ["hallway_wing_a_3_4", "vertical_hallway_3_3"],
    "pc-lab-6": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "pc-lab-7": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "pc-lab-8": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "pc-lab-9": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "switch-room-wingb-2f": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "mens-cr-2-3f-wingb": ["hallway_wing_a_3_5", "vertical_hallway_3_3"],
    "pc-lab-1": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
    "pc-lab-2": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
    "pc-lab-3": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
    "pc-lab-4": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
    "pc-lab-5": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
    "function-room-2f-wingb": ["hallway_wing_b_2_5", "vertical_hallway_2_3"],
}
ROOM_DIRECT_HALLWAY_ATTACHMENTS = {
    "ics-mega-hall": "hallway_wing_b_2_4",
    "ics-lecture-hall-3": "hallway_wing_a_3_4",
    "ics-lecture-hall-4": "hallway_wing_a_3_4",
    "pc-lab-6": "hallway_wing_a_3_5",
    "pc-lab-7": "hallway_wing_a_3_5",
    "pc-lab-8": "hallway_wing_a_3_5",
    "pc-lab-9": "hallway_wing_a_3_5",
    "switch-room-wingb-2f": "hallway_wing_a_3_5",
    "mens-cr-2-3f-wingb": "hallway_wing_a_3_5",
    "pc-lab-1": "hallway_wing_b_2_5",
    "pc-lab-2": "hallway_wing_b_2_5",
    "pc-lab-3": "hallway_wing_b_2_5",
    "pc-lab-4": "hallway_wing_b_2_5",
    "pc-lab-5": "hallway_wing_b_2_5",
    "function-room-2f-wingb": "hallway_wing_b_2_5",
}
MANUAL_HALLWAY_CONNECTOR_NODES = [
    Node(
        id="hallway_connector_wing_b_2f_upper",
        x=852.5,
        y=414.0,
        floor=2,
        wing="B",
        name="Hallway Connector",
        type=NODE_TYPE_HALLWAY,
        metadata={"wing": "B"},
    ),
    Node(
        id="hallway_connector_wing_b_2f_lower",
        x=852.5,
        y=584.0,
        floor=2,
        wing="B",
        name="Hallway Connector",
        type=NODE_TYPE_HALLWAY,
        metadata={"wing": "B"},
    ),
    Node(
        id="hallway_connector_wing_b_3f_upper",
        x=855.0,
        y=340.0,
        floor=3,
        wing="B",
        name="Hallway Connector",
        type=NODE_TYPE_HALLWAY,
        metadata={"wing": "B"},
    ),
    Node(
        id="hallway_connector_wing_b_3f_lower",
        x=855.0,
        y=423.0,
        floor=3,
        wing="B",
        name="Hallway Connector",
        type=NODE_TYPE_HALLWAY,
        metadata={"wing": "B"},
    ),
]
MANUAL_ROUTING_EDGES = [
    ("hallway_wing_b_2_2", "hallway_connector_wing_b_2f_upper"),
    ("hallway_wing_b_2_2", "hallway_connector_wing_b_2f_lower"),
    ("stairs-2f-wingb", "hallway_connector_wing_b_2f_upper"),
    ("hallway_connector_wing_b_2f_upper", "hallway_wing_b_2_4"),
    ("stairs-2f-wingb", "hallway_connector_wing_b_2f_lower"),
    ("hallway_connector_wing_b_2f_lower", "hallway_wing_b_2_5"),
    ("stairs-3f-wingb", "hallway_connector_wing_b_3f_upper"),
    ("hallway_connector_wing_b_3f_upper", "hallway_connector_wing_b_3f_lower"),
    ("hallway_connector_wing_b_3f_lower", "hallway_wing_b_3_2"),
]


@dataclass
class SandboxNavigationService:

    # Initialize graph with building nodes and connections
    graph: NavigationGraph = field(default_factory=NavigationGraph, init=False)
    cache_layout_id: int | None = None
    GRAPH_CACHE_PATH: Path | None = None
    GRAPH_CACHE_KEY = "sandbox-default"
    FORCE_REBUILD_GRAPH_CACHE = False
    GRAPH_CACHE_VERSION = 12
    LAYOUT_SERVICE = SandboxMainMapLayoutService

    def _resolve_cache_layout_id(self) -> int | None:
        if self.cache_layout_id is not None:
            return int(self.cache_layout_id)
        current_record = self.LAYOUT_SERVICE.get_current_record()
        if current_record is None or current_record.get("id") is None:
            return None
        self.cache_layout_id = int(current_record["id"])
        return self.cache_layout_id

    @classmethod
    def _layout_cache_key(cls, layout_id: int | None) -> str:
        if layout_id is None:
            return cls.GRAPH_CACHE_KEY
        return f"layout:{layout_id}"

    def _is_cached_graph_valid(self) -> bool:
        required_nodes = (
            MAIN_ENTRANCE_NODE_ID,
            "hall_1_0",
            HALLWAY_WING_A_1_4,
            VERTICAL_HALLWAY_1_2,
            HALLWAY_WING_B_1_2,
            HALLWAY_WING_A_2_4,
            VERTICAL_HALLWAY_2_2,
            VERTICAL_HALLWAY_2_3,
            HALLWAY_WING_B_2_2,
            HALLWAY_WING_B_2_4,
            HALLWAY_WING_B_2_5,
            "hallway_connector_wing_b_2f_upper",
            "hallway_connector_wing_b_2f_lower",
            HALLWAY_WING_C_1_3,
            "bridge_hall_1_ab",
            "bridge_hall_1_bc",
            "bridge_hall_2_bc",
            "bridge_hall_3_bc",
            HALLWAY_WING_A_3_4,
            VERTICAL_HALLWAY_3_2,
            VERTICAL_HALLWAY_3_3,
            HALLWAY_WING_A_3_4_LEFT,
            HALLWAY_WING_A_3_5,
            HALLWAY_WING_B_3_2,
            HALLWAY_WING_C_2_3,
            HALLWAY_WING_C_3_3,
        )
        if any(node_id not in self.graph.nodes for node_id in required_nodes):
            return False

        entrance_neighbors = set(self.graph.get_neighbors(MAIN_ENTRANCE_NODE_ID))
        if "bridge_hall_1_ab" in entrance_neighbors or "bridge_hall_1_bc" in entrance_neighbors:
            return False
        entrance = self.graph.nodes.get(MAIN_ENTRANCE_NODE_ID)
        if not entrance or entrance.wing != "A":
            return False

        required_edges = (
            (HALLWAY_WING_A_1_4, "bridge_hall_1_ab"),
            (HALLWAY_WING_A_1_1, VERTICAL_HALLWAY_1_2),
            ("stairs1_Wing_A_1F", "bridge_hall_1_ab"),
            ("bridge_hall_1_ab", "hall_b_1_curve_1"),
            (HALLWAY_WING_B_1_2, "bridge_hall_1_bc"),
            ("bridge_hall_1_bc", HALLWAY_WING_C_1_3),
            (HALLWAY_WING_A_2_1, HALLWAY_WING_A_2_4),
            (HALLWAY_WING_A_2_1, VERTICAL_HALLWAY_2_2),
            (HALLWAY_WING_A_2_4, HALLWAY_WING_B_2_2),
            (HALLWAY_WING_A_2_4, HALLWAY_WING_B_2_4),
            (HALLWAY_WING_A_2_4, HALLWAY_WING_B_2_5),
            (VERTICAL_HALLWAY_2_3, HALLWAY_WING_B_2_4),
            (VERTICAL_HALLWAY_2_3, HALLWAY_WING_B_2_5),
            (HALLWAY_WING_B_2_2, "hallway_connector_wing_b_2f_upper"),
            (HALLWAY_WING_B_2_2, "hallway_connector_wing_b_2f_lower"),
            ("stairs-2f-wingb", "stairs-3f-wingb"),
            ("stairs-2f-wingb", "hallway_connector_wing_b_2f_upper"),
            ("hallway_connector_wing_b_2f_upper", HALLWAY_WING_B_2_4),
            ("stairs-2f-wingb", "hallway_connector_wing_b_2f_lower"),
            ("hallway_connector_wing_b_2f_lower", HALLWAY_WING_B_2_5),
            (HALLWAY_WING_B_2_2, "bridge_hall_2_bc"),
            ("bridge_hall_2_bc", HALLWAY_WING_C_2_3),
            (HALLWAY_WING_A_3_1, HALLWAY_WING_A_3_4),
            (HALLWAY_WING_A_3_1, VERTICAL_HALLWAY_3_2),
            (HALLWAY_WING_A_3_4, HALLWAY_WING_B_3_2),
            (HALLWAY_WING_A_3_4, HALLWAY_WING_A_3_4_LEFT),
            (HALLWAY_WING_A_3_4, HALLWAY_WING_A_3_5),
            (VERTICAL_HALLWAY_3_3, HALLWAY_WING_A_3_4_LEFT),
            (VERTICAL_HALLWAY_3_3, HALLWAY_WING_A_3_5),
            (HALLWAY_WING_B_3_2, "bridge_hall_3_bc"),
            ("bridge_hall_3_bc", HALLWAY_WING_C_3_3),
        )
        for a_id, b_id in required_edges:
            if a_id not in self.graph.nodes or b_id not in self.graph.nodes:
                return False
            if b_id not in self.graph.get_neighbors(a_id):
                return False

        if "stairs-2f-wingb" in self.graph.nodes and VERTICAL_HALLWAY_2_3 in self.graph.get_neighbors("stairs-2f-wingb"):
            return False
        if "stairs1_Wing_B_3F" in self.graph.nodes and "stairs-3f-wingb" in self.graph.get_neighbors("stairs1_Wing_B_3F"):
            return False
        if "junction_classroom-b207" in self.graph.nodes:
            if "stairs-2f-wingb" in self.graph.get_neighbors("junction_classroom-b207"):
                return False
            if "stairs1_Wing_B_2F" in self.graph.get_neighbors("junction_classroom-b207"):
                return False

        # Ensure cache coordinates match current layout-driven hallway anchors.
        key_coord_nodes = (
            HALLWAY_WING_A_1_4,
            VERTICAL_HALLWAY_1_2,
            "bridge_hall_1_ab",
            "hall_b_1_curve_1",
            "hall_b_1_curve_2",
            HALLWAY_WING_B_1_2,
            "bridge_hall_1_bc",
            HALLWAY_WING_C_1_3,
            HALLWAY_WING_A_2_4,
            VERTICAL_HALLWAY_2_2,
            VERTICAL_HALLWAY_2_3,
            HALLWAY_WING_B_2_2,
            HALLWAY_WING_B_2_4,
            HALLWAY_WING_B_2_5,
            "hallway_connector_wing_b_2f_upper",
            "hallway_connector_wing_b_2f_lower",
            "bridge_hall_2_bc",
            "hall_c_2_turn",
            HALLWAY_WING_C_2_3,
            HALLWAY_WING_A_3_4,
            VERTICAL_HALLWAY_3_2,
            VERTICAL_HALLWAY_3_3,
            HALLWAY_WING_A_3_4_LEFT,
            HALLWAY_WING_A_3_5,
            HALLWAY_WING_B_3_2,
            "bridge_hall_3_bc",
            HALLWAY_WING_C_3_3,
        )
        expected_hallways = {node.id: node for node in create_hallway_nodes() if node.id in key_coord_nodes}
        for node_id in key_coord_nodes:
            cached_node = self.graph.nodes.get(node_id)
            expected_node = expected_hallways.get(node_id)
            if not cached_node or not expected_node:
                return False
            if (
                float(cached_node.x) != float(expected_node.x)
                or float(cached_node.y) != float(expected_node.y)
                or int(cached_node.floor) != int(expected_node.floor)
                or str(cached_node.wing or "") != str(expected_node.wing or "")
            ):
                return False

        for node in self.graph.nodes.values():
            if node.id.startswith("junction_") and not node.wing:
                return False
            if node.id.startswith("door_") and not node.wing:
                return False

        for a_id, b_id in FORBIDDEN_SHORTCUT_CONNECTORS:
            if a_id in self.graph.nodes and b_id in self.graph.nodes:
                if b_id in self.graph.get_neighbors(a_id):
                    return False

        # Stair nodes must not connect directly to landings on a different floor.
        for node_id, node in self.graph.nodes.items():
            if node.type != NODE_TYPE_STAIRS:
                continue
            for nb_id in self.graph.get_neighbors(node_id):
                if not nb_id.startswith("landing_"):
                    continue
                nb = self.graph.nodes.get(nb_id)
                if not nb or nb.floor != node.floor:
                    return False

        # Ensure cached graph still has valid Wing A vertical connectivity.
        for a_id, b_id in (
            (HALLWAY_WING_A_1_1, "stairs1_Wing_A_1F"),
            ("stairs1_Wing_A_1F", "stairs1_Wing_A_3F"),
        ):
            if a_id not in self.graph.nodes or b_id not in self.graph.nodes:
                return False
            path, _ = self.graph.a_star_pathfinding(a_id, b_id)
            if not path:
                return False

        # Ensure stairs retain at least one nearby same-wing room-junction connector
        # only when they otherwise lack same-floor transit.
        max_connector_distance = 260.0
        for node_id, node in self.graph.nodes.items():
            if node.type != NODE_TYPE_STAIRS:
                continue
            has_same_floor_transit = any(
                self.graph.nodes.get(nb_id)
                and self.graph.nodes[nb_id].floor == node.floor
                and self.graph.nodes[nb_id].type in {NODE_TYPE_HALLWAY, "door"}
                and not nb_id.startswith("landing_")
                for nb_id in self.graph.get_neighbors(node_id)
            )
            if has_same_floor_transit:
                continue
            candidates = []
            for junction_id, junction in self.graph.nodes.items():
                if not junction_id.startswith("junction_"):
                    continue
                if junction.floor != node.floor:
                    continue
                if node.wing and junction.wing and node.wing != junction.wing:
                    continue
                dist = math.hypot(junction.x - node.x, junction.y - node.y)
                if dist <= max_connector_distance:
                    candidates.append(junction_id)
            if not candidates:
                continue
            if not any(candidate in self.graph.get_neighbors(node_id) for candidate in candidates):
                return False
        return True

    def _load_graph_from_cache(self) -> bool:
        try:
            cache_data: dict[str, Any] | None
            if self.GRAPH_CACHE_PATH is not None:
                cache_path = self.GRAPH_CACHE_PATH
                if not cache_path.exists():
                    return False
                with open(cache_path, "r", encoding="utf-8") as f:
                    cache_data = json.load(f)
            else:
                layout_id = self._resolve_cache_layout_id()
                cache_data = NavigationGraphCacheService.load_cache(
                    cache_key=self._layout_cache_key(layout_id),
                    layout_id=layout_id,
                )
                if cache_data is None:
                    return False
            if cache_data.get("cache_version") != self.GRAPH_CACHE_VERSION:
                return False
            self.graph = NavigationGraph.from_dict(cache_data)
            if not self._is_cached_graph_valid():
                # Ensure rebuild starts from a clean graph when cache is stale/invalid.
                self.graph = NavigationGraph()
                return False
            self.graph.nodes_by_floor = group_nodes_by_floor(self.graph)
            return True
        except Exception as e:
            print("Graph cache load failed:", e)
            self.graph = NavigationGraph()
            return False

    def _write_graph_cache(self):
        graph_data = self.graph.to_dict()
        graph_data["cache_version"] = self.GRAPH_CACHE_VERSION
        if self.GRAPH_CACHE_PATH is not None:
            cache_path = self.GRAPH_CACHE_PATH
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(graph_data, f, indent=2)
            return
        layout_id = self._resolve_cache_layout_id()
        NavigationGraphCacheService.save_cache(
            graph_data,
            cache_version=self.GRAPH_CACHE_VERSION,
            cache_key=self._layout_cache_key(layout_id),
            layout_id=layout_id,
        )

    @classmethod
    def rebuild_graph_cache(cls) -> str:
        current_record = cls.LAYOUT_SERVICE.get_current_record()
        if current_record is None:
            prev_force = cls.FORCE_REBUILD_GRAPH_CACHE
            cls.FORCE_REBUILD_GRAPH_CACHE = True
            try:
                _ = cls()
                return str(cls.GRAPH_CACHE_PATH) if cls.GRAPH_CACHE_PATH is not None else cls.GRAPH_CACHE_KEY
            finally:
                cls.FORCE_REBUILD_GRAPH_CACHE = prev_force
        return cls.rebuild_graph_cache_for_layout(int(current_record["id"]), current_record["payload"])

    @classmethod
    def rebuild_graph_cache_for_layout(cls, layout_id: int, layout_payload: dict[str, Any]) -> str:
        prev_force = cls.FORCE_REBUILD_GRAPH_CACHE
        cls.FORCE_REBUILD_GRAPH_CACHE = True
        try:
            with map_layout_context(layout_payload):
                _ = cls(cache_layout_id=layout_id)
            return str(cls.GRAPH_CACHE_PATH) if cls.GRAPH_CACHE_PATH is not None else cls._layout_cache_key(layout_id)
        finally:
            cls.FORCE_REBUILD_GRAPH_CACHE = prev_force

    def __post_init__(self):
        if not self.FORCE_REBUILD_GRAPH_CACHE and self._load_graph_from_cache():
            return
        # Always rebuild from an empty graph to avoid stale/duplicate counts.
        self.graph = NavigationGraph()

        ########################
        # NAVIGATION
        ########################

        hallway_nodes = create_hallway_nodes()
        room_nodes = create_room_nodes()
        stair_nodes = create_stair_nodes()

        # ---------- Add Nodes ----------
        for n in hallway_nodes + room_nodes + stair_nodes + MANUAL_HALLWAY_CONNECTOR_NODES:
            self.graph.add_node(n)

        self.graph.nodes_by_floor = group_nodes_by_floor(self.graph)

        # ---------- Helper ----------
        def nodes_exist(a, b):
            return a in self.graph.nodes and b in self.graph.nodes

        def node_point(node_id: str) -> tuple[float, float]:
            node = self.graph.nodes[node_id]
            if (
                node.type != NODE_TYPE_HALLWAY
                and node.width is not None
                and node.height is not None
                and node.width > 0
                and node.height > 0
            ):
                return node.center
            return (node.x, node.y)

        def node_rect(node_id: str) -> tuple[float, float, float, float] | None:
            node = self.graph.nodes[node_id]
            if (
                node.width is None
                or node.height is None
                or node.width <= 0
                or node.height <= 0
            ):
                return None
            return (node.x, node.y, node.x + node.width, node.y + node.height)

        def point_to_rect_distance(point: tuple[float, float], rect: tuple[float, float, float, float]) -> float:
            px, py = point
            left, top, right, bottom = rect
            dx = 0.0 if left <= px <= right else min(abs(px - left), abs(px - right))
            dy = 0.0 if top <= py <= bottom else min(abs(py - top), abs(py - bottom))
            return math.hypot(dx, dy)

        def closest_point_on_rect(point: tuple[float, float], rect: tuple[float, float, float, float]) -> tuple[float, float]:
            px, py = point
            left, top, right, bottom = rect
            clamped_x = min(max(px, left), right)
            clamped_y = min(max(py, top), bottom)
            if left < px < right and top < py < bottom:
                candidates = (
                    (abs(px - left), (left, py)),
                    (abs(px - right), (right, py)),
                    (abs(py - top), (px, top)),
                    (abs(py - bottom), (px, bottom)),
                )
                return min(candidates, key=lambda item: item[0])[1]
            return (clamped_x, clamped_y)

        def rooms_block_segment(
            start: tuple[float, float],
            end: tuple[float, float],
            *,
            floor: int,
            excluded_room_ids: set[str] | None = None,
        ) -> bool:
            excluded = excluded_room_ids or set()
            x1, y1 = start
            x2, y2 = end
            for room in room_nodes:
                if room.floor != floor:
                    continue
                if room.id in excluded:
                    continue
                if (room.metadata or {}).get("layout_matched") is False:
                    continue
                if bool((room.metadata or {}).get("passable")):
                    continue
                try:
                    if line_intersects_rect(
                        x1,
                        y1,
                        x2,
                        y2,
                        room.x,
                        room.y,
                        room.width,
                        room.height,
                    ):
                        return True
                except Exception:
                    continue
            return False

        def wing_labels(node_id: str) -> set[str]:
            wing = effective_wing(node_id)
            if not wing:
                return set()
            return {part for part in str(wing).split("-") if part}

        def hallway_anchor_junction_id(anchor_id: str, hallway_id: str, point: tuple[float, float]) -> str:
            x, y = point
            return f"layout_attach_{anchor_id}_{hallway_id}_{round(x, 1)}_{round(y, 1)}"

        def hallway_intersection_junction_id(a_id: str, b_id: str, point: tuple[float, float]) -> str:
            left, right = sorted((a_id, b_id))
            x, y = point
            return f"layout_junction_{left}_{right}_{round(x, 1)}_{round(y, 1)}"

        # ---------- Connectivity Helpers ----------
        def add_edge_if_clear(a, b, force: bool = False):
            if not nodes_exist(a, b):
                return False
            if force:
                self.graph.add_edge(a, b)
                return True

            a_node = self.graph.nodes[a]
            b_node = self.graph.nodes[b]
            start = node_point(a)
            end = node_point(b)

            if not rooms_block_segment(start, end, floor=a_node.floor, excluded_room_ids={a, b}):
                self.graph.add_edge(a, b)
                return True
            return False

        def hallway_attach_priority(anchor_id: str, hallway_id: str) -> tuple[int, float]:
            anchor_wing = effective_wing(anchor_id)
            hallway_wing = effective_wing(hallway_id)

            if hallway_wing == anchor_wing:
                wing_priority = 0
            elif hallway_wing in {"A-B", "B-C"} and anchor_wing and anchor_wing in hallway_wing.split("-"):
                wing_priority = 1
            else:
                wing_priority = 2

            anchor_point = node_point(anchor_id)
            hallway_rect = node_rect(hallway_id)
            if hallway_rect:
                dist = point_to_rect_distance(anchor_point, hallway_rect)
            else:
                hallway_point = node_point(hallway_id)
                dist = math.hypot(hallway_point[0] - anchor_point[0], hallway_point[1] - anchor_point[1])
            return (wing_priority, dist)

        def effective_wing(node_id: str) -> str | None:
            node = self.graph.nodes[node_id]
            if node.wing:
                return node.wing
            lowered = node_id.lower()
            if "wing_a" in lowered:
                return "A"
            if "wing_b" in lowered:
                return "B"
            if "wing_c" in lowered:
                return "C"
            if "bridge_hall_" in lowered and lowered.endswith("_ab"):
                return "A-B"
            if "bridge_hall_" in lowered and lowered.endswith("_bc"):
                return "B-C"
            return None

        def stair_compatible_hallway(anchor_id: str, hallway_id: str) -> bool:
            anchor_wings = wing_labels(anchor_id)
            hallway_wings = wing_labels(hallway_id)
            if not anchor_wings or not hallway_wings:
                return False
            return bool(anchor_wings & hallway_wings)

        def connect_layout_transit_topology():
            hallway_ids = [
                node_id
                for node_id, node in self.graph.nodes.items()
                if (
                    node.type == NODE_TYPE_HALLWAY
                    and node.width
                    and node.height
                    and not bool((node.metadata or {}).get("exterior_access"))
                )
            ]

            def rect_connection_point(a_rect, b_rect):
                ax1, ay1, ax2, ay2 = a_rect
                bx1, by1, bx2, by2 = b_rect
                x1 = max(ax1, bx1)
                x2 = min(ax2, bx2)
                y1 = max(ay1, by1)
                y2 = min(ay2, by2)
                if x1 <= x2 and y1 <= y2:
                    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

                overlap_y = max(0.0, min(ay2, by2) - max(ay1, by1))
                overlap_x = max(0.0, min(ax2, bx2) - max(ax1, bx1))
                if overlap_y > 0:
                    if ax2 < bx1:
                        x = (ax2 + bx1) / 2.0
                    elif bx2 < ax1:
                        x = (bx2 + ax1) / 2.0
                    else:
                        x = (max(ax1, bx1) + min(ax2, bx2)) / 2.0
                    y = (max(ay1, by1) + min(ay2, by2)) / 2.0
                    return (x, y)
                if overlap_x > 0:
                    x = (max(ax1, bx1) + min(ax2, bx2)) / 2.0
                    if ay2 < by1:
                        y = (ay2 + by1) / 2.0
                    elif by2 < ay1:
                        y = (by2 + ay1) / 2.0
                    else:
                        y = (max(ay1, by1) + min(ay2, by2)) / 2.0
                    return (x, y)
                return None

            for i, a_id in enumerate(hallway_ids):
                a_node = self.graph.nodes[a_id]
                a_rect = node_rect(a_id)
                if not a_rect:
                    continue
                for b_id in hallway_ids[i + 1:]:
                    b_node = self.graph.nodes[b_id]
                    if a_node.floor != b_node.floor:
                        continue
                    if not (wing_labels(a_id) & wing_labels(b_id)):
                        continue
                    b_rect = node_rect(b_id)
                    if not b_rect:
                        continue
                    connection_point = rect_connection_point(a_rect, b_rect)
                    if connection_point is None:
                        continue
                    junction_id = hallway_intersection_junction_id(a_id, b_id, connection_point)
                    if junction_id not in self.graph.nodes:
                        self.graph.add_node(Node(
                            id=junction_id,
                            x=connection_point[0],
                            y=connection_point[1],
                            floor=a_node.floor,
                            wing=a_node.wing if a_node.wing == b_node.wing else a_node.wing or b_node.wing,
                            name="Layout Hallway Junction",
                            type=NODE_TYPE_HALLWAY,
                            metadata={"auto_generated": True},
                        ))
                    add_edge_if_clear(a_id, junction_id, force=True)
                    add_edge_if_clear(b_id, junction_id, force=True)

            anchor_ids = [
                node_id
                for node_id, node in self.graph.nodes.items()
                if (
                    node_id == MAIN_ENTRANCE_NODE_ID
                    or node_id.startswith("bridge_hall_")
                    or node.type == NODE_TYPE_STAIRS
                    or (
                        node.type == NODE_TYPE_HALLWAY
                        and not (node.width and node.height)
                        and not bool((node.metadata or {}).get("auto_generated"))
                    )
                )
            ]

            for anchor_id in anchor_ids:
                anchor = self.graph.nodes[anchor_id]
                anchor_point = node_point(anchor_id)
                compatible_hallways = []
                for hallway_id in hallway_ids:
                    hallway = self.graph.nodes[hallway_id]
                    if hallway.floor != anchor.floor or hallway_id == anchor_id:
                        continue
                    if not (wing_labels(anchor_id) & wing_labels(hallway_id)):
                        continue
                    hallway_rect = node_rect(hallway_id)
                    if not hallway_rect:
                        continue
                    boundary_point = closest_point_on_rect(anchor_point, hallway_rect)
                    distance = math.hypot(boundary_point[0] - anchor_point[0], boundary_point[1] - anchor_point[1])
                    if distance > 160.0:
                        continue
                    if rooms_block_segment(anchor_point, boundary_point, floor=anchor.floor, excluded_room_ids={anchor_id}):
                        continue
                    compatible_hallways.append((distance, hallway_id, boundary_point))

                compatible_hallways.sort(key=lambda item: (hallway_attach_priority(anchor_id, item[1]), item[0]))
                attached_wings: set[str] = set()
                attachments = 0
                for _, hallway_id, boundary_point in compatible_hallways:
                    hallway_wing = effective_wing(hallway_id) or ""
                    if anchor_id.startswith("bridge_hall_"):
                        if hallway_wing in attached_wings:
                            continue
                    junction_id = hallway_anchor_junction_id(anchor_id, hallway_id, boundary_point)
                    if junction_id not in self.graph.nodes:
                        self.graph.add_node(Node(
                            id=junction_id,
                            x=boundary_point[0],
                            y=boundary_point[1],
                            floor=anchor.floor,
                            wing=hallway_wing or anchor.wing,
                            name="Layout Transit Attachment",
                            type=NODE_TYPE_HALLWAY,
                            metadata={"auto_generated": True},
                        ))
                    add_edge_if_clear(anchor_id, junction_id, force=True)
                    add_edge_if_clear(hallway_id, junction_id, force=True)
                    attachments += 1
                    if hallway_wing:
                        attached_wings.add(hallway_wing)
                    if anchor_id.startswith("bridge_hall_") and len(attached_wings) >= 2:
                        break
                    if not anchor_id.startswith("bridge_hall_") and attachments >= 2:
                        break

        def connect_main_entrance_exterior_access():
            entrance_id = MAIN_ENTRANCE_NODE_ID
            if entrance_id not in self.graph.nodes:
                return

            entrance = self.graph.nodes[entrance_id]
            target_candidates = [
                hid
                for hid in self.graph.floors[entrance.floor].get(NODE_TYPE_HALLWAY, [])
                if (
                    hid != entrance_id
                    and not hid.startswith("bridge_hall_")
                    and self.graph.nodes[hid].wing not in {"A-B", "B-C"}
                    and self.graph.nodes[hid].width
                    and self.graph.nodes[hid].height
                    and not bool((self.graph.nodes[hid].metadata or {}).get("exterior_access"))
                )
            ]
            if not target_candidates:
                return

            for nb_id in list(self.graph.get_neighbors(entrance_id)):
                self.graph.remove_edge(entrance_id, nb_id)

            entrance_point = node_point(entrance_id)
            reachable_targets: list[tuple[float, str, tuple[float, float], list[tuple[float, float]]]] = []

            for hallway_id in target_candidates:
                hallway_rect = node_rect(hallway_id)
                if not hallway_rect:
                    continue
                boundary_point = closest_point_on_rect(entrance_point, hallway_rect)
                distance = math.hypot(boundary_point[0] - entrance_point[0], boundary_point[1] - entrance_point[1])
                if distance > 220.0:
                    continue

                candidate_paths = []
                if boundary_point == entrance_point:
                    candidate_paths.append([])
                else:
                    candidate_paths.append([boundary_point])
                    candidate_paths.append([(boundary_point[0], entrance_point[1]), boundary_point])
                    candidate_paths.append([(entrance_point[0], boundary_point[1]), boundary_point])

                chosen_points: list[tuple[float, float]] | None = None
                chosen_cost = float("inf")
                for candidate_points in candidate_paths:
                    deduped_points: list[tuple[float, float]] = []
                    for point in candidate_points:
                        if point == entrance_point:
                            continue
                        if deduped_points and deduped_points[-1] == point:
                            continue
                        deduped_points.append(point)

                    prev_point = entrance_point
                    segment_ok = True
                    path_cost = 0.0
                    for point in deduped_points:
                        if rooms_block_segment(
                            prev_point,
                            point,
                            floor=entrance.floor,
                            excluded_room_ids={entrance_id},
                        ):
                            segment_ok = False
                            break
                        path_cost += math.hypot(point[0] - prev_point[0], point[1] - prev_point[1])
                        prev_point = point
                    if not segment_ok:
                        continue
                    if path_cost < chosen_cost:
                        chosen_cost = path_cost
                        chosen_points = deduped_points

                if chosen_points is None:
                    continue
                reachable_targets.append((chosen_cost, hallway_id, boundary_point, chosen_points))

            if not reachable_targets:
                return

            targets_by_wing: dict[str, tuple[float, str, tuple[float, float], list[tuple[float, float]]]] = {}
            for target in sorted(reachable_targets, key=lambda item: (item[0], hallway_attach_priority(entrance_id, item[1]))):
                hallway_wing = effective_wing(target[1]) or ""
                if hallway_wing and hallway_wing in targets_by_wing:
                    continue
                targets_by_wing[hallway_wing] = target

            selected_targets = sorted(targets_by_wing.values(), key=lambda item: (item[0], item[1]))[:2]
            for _, hallway_id, boundary_point, waypoint_points in selected_targets:
                junction_id = hallway_anchor_junction_id(entrance_id, hallway_id, boundary_point)
                if junction_id not in self.graph.nodes:
                    hallway_wing = effective_wing(hallway_id) or entrance.wing
                    self.graph.add_node(Node(
                        id=junction_id,
                        x=boundary_point[0],
                        y=boundary_point[1],
                        floor=entrance.floor,
                        wing=hallway_wing,
                        name="Main Entrance Exterior Attachment",
                        type=NODE_TYPE_HALLWAY,
                        metadata={"auto_generated": True, "exterior_access": True},
                    ))
                add_edge_if_clear(hallway_id, junction_id, force=True)

                previous_id = entrance_id
                for index, (wx, wy) in enumerate(waypoint_points[:-1], start=1):
                    waypoint_id = f"main_entrance_exterior_{hallway_id}_{index}"
                    if waypoint_id not in self.graph.nodes:
                        self.graph.add_node(Node(
                            id=waypoint_id,
                            x=wx,
                            y=wy,
                            floor=entrance.floor,
                            wing=entrance.wing,
                            name="Main Entrance Exterior Access",
                            type=NODE_TYPE_HALLWAY,
                            metadata={"auto_generated": True, "exterior_access": True},
                        ))
                    self.graph.add_edge(previous_id, waypoint_id)
                    previous_id = waypoint_id

                self.graph.add_edge(previous_id, junction_id)

        def connect_hallway_backbone():
            y_tolerance = 8
            for floor, groups in self.graph.floors.items():
                hallway_ids = groups.get(NODE_TYPE_HALLWAY, [])
                floor_hallway_nodes = [
                    self.graph.nodes[h]
                    for h in hallway_ids
                    if (
                        not bool((self.graph.nodes[h].metadata or {}).get("exterior_access"))
                        and not str(h).startswith("junction_")
                    )
                ]

                # group hallways by approximate y (handles rows)
                y_groups = []
                for node in floor_hallway_nodes:
                    placed = False
                    for g in y_groups:
                        if abs(node.y - g["y"]) <= y_tolerance:
                            g["nodes"].append(node)
                            placed = True
                            break
                    if not placed:
                        y_groups.append({"y": node.y, "nodes": [node]})

                for g in y_groups:
                    wing_groups = {}
                    for node in g["nodes"]:
                        wing_groups.setdefault(node.wing, []).append(node)

                    for wing_nodes in wing_groups.values():
                        nodes_sorted = sorted(wing_nodes, key=lambda n: n.x)
                        for i in range(len(nodes_sorted) - 1):
                            left = nodes_sorted[i]
                            right = nodes_sorted[i + 1]
                            add_edge_if_clear(left.id, right.id)

        def connect_colinear_doors():
            y_tolerance = 2
            for floor, groups in self.graph.floors.items():
                door_ids = groups.get("door", [])
                if not door_ids:
                    continue

                doors_by_wing = {}
                for door_id in door_ids:
                    node = self.graph.nodes.get(door_id)
                    if not node:
                        continue
                    doors_by_wing.setdefault(node.wing or "", []).append(node)

                for wing_doors in doors_by_wing.values():
                    if len(wing_doors) < 2:
                        continue
                    y_groups = []
                    for node in wing_doors:
                        placed = False
                        for group in y_groups:
                            if abs(node.y - group["y"]) <= y_tolerance:
                                group["nodes"].append(node)
                                placed = True
                                break
                        if not placed:
                            y_groups.append({"y": node.y, "nodes": [node]})

                    for group in y_groups:
                        row = sorted(group["nodes"], key=lambda n: n.x)
                        for i in range(len(row) - 1):
                            add_edge_if_clear(row[i].id, row[i + 1].id)

        # ---------- Hallway Backbone (auto) ----------
        connect_hallway_backbone()

        # ---------- Wing B explicit hallway/stair routing edges ----------
        for a_id, b_id in WING_B_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in WING_C_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in BRIDGE_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in WING_A_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in MANUAL_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)

        # ---------- Main Entrance to Nearest Hallway ----------
        entrance_id = MAIN_ENTRANCE_NODE_ID
        if entrance_id in self.graph.nodes:
            entrance = self.graph.nodes[entrance_id]
            hallway_ids = [
                h for h in self.graph.floors[entrance.floor].get(NODE_TYPE_HALLWAY, [])
                if (
                    h != entrance_id
                    and not h.startswith("bridge_hall_")
                    and self.graph.nodes[h].wing not in {"A-B", "B-C"}
                    and self.graph.nodes[h].wing == entrance.wing
                )
            ]
            if hallway_ids:
                nearest_first = sorted(
                    hallway_ids,
                    key=lambda hid: hallway_attach_priority(entrance_id, hid),
                )
                connected_count = 0
                for hid in nearest_first:
                    if add_edge_if_clear(entrance_id, hid):
                        connected_count += 1
                    # Keep at most two entry connectors so same-wing routes don't get
                    # forced through bridge-adjacent hallways.
                    if connected_count >= 2:
                        break
                # Guarantee the main entrance remains routable after layout shifts.
                if connected_count == 0:
                    add_edge_if_clear(entrance_id, nearest_first[0], force=True)

            stair_ids = [
                sid for sid in self.graph.floors[entrance.floor].get(NODE_TYPE_STAIRS, [])
                if self.graph.nodes[sid].wing == entrance.wing
            ]
            if stair_ids:
                nearest_stairs = sorted(
                    stair_ids,
                    key=lambda sid: math.hypot(
                        node_point(sid)[0] - node_point(entrance_id)[0],
                        node_point(sid)[1] - node_point(entrance_id)[1],
                    ),
                )
                if not any(nb_id in stair_ids for nb_id in self.graph.get_neighbors(entrance_id)):
                    if not add_edge_if_clear(entrance_id, nearest_stairs[0]):
                        add_edge_if_clear(entrance_id, nearest_stairs[0], force=True)

        # ---------- Stairs to Nearest Hallway (auto) ----------
        for floor, groups in self.graph.floors.items():
            hallway_ids = groups.get(NODE_TYPE_HALLWAY, [])
            stair_ids = groups.get(NODE_TYPE_STAIRS, [])
            for stair_id in stair_ids:
                if not hallway_ids:
                    continue
                compatible = [hid for hid in hallway_ids if stair_compatible_hallway(stair_id, hid)]
                if not compatible:
                    continue
                stair = self.graph.nodes[stair_id]
                nearest_first = sorted(
                    compatible,
                    key=lambda hid: hallway_attach_priority(stair_id, hid),
                )
                for hid in nearest_first:
                    if add_edge_if_clear(stair_id, hid):
                        break

        connect_main_entrance_exterior_access()

        # ---------- Connect Rooms ----------
        for floor, groups in self.graph.floors.items():

            hallways = groups.get(NODE_TYPE_HALLWAY, [])
            rooms = groups.get(NODE_TYPE_ROOM, [])

            for room_id in rooms:
                try:
                    room_node = self.graph.nodes[room_id]
                    # Exclude non-corridor hallway nodes from room segment splitting.
                    corridor_hallways = [
                        hid for hid in hallways
                        if (
                            hid != MAIN_ENTRANCE_NODE_ID
                            and self.graph.nodes[hid].wing != "A-B"
                            and not bool((self.graph.nodes[hid].metadata or {}).get("exterior_access"))
                        )
                    ]
                    candidate_hallways = [
                        hid for hid in corridor_hallways
                        if self.graph.nodes[hid].wing == room_node.wing
                    ]
                    if not candidate_hallways:
                        candidate_hallways = corridor_hallways
                    hinted_hallways = ROOM_HALLWAY_HINTS.get(room_id)
                    if hinted_hallways:
                        hinted_candidates = [
                            hid for hid in corridor_hallways
                            if hid in hinted_hallways
                        ]
                        if hinted_candidates:
                            candidate_hallways = hinted_candidates
                    connect_room_to_hallway_nodes(
                        self.graph,
                        room_id,
                        candidate_hallways,
                        preferred_hallway_id=ROOM_DIRECT_HALLWAY_ATTACHMENTS.get(room_id),
                    )
                    # Room insertion splits hallway segments; re-stitch trunk each time
                    # so subsequent rooms still have corridor segments to attach to.
                    connect_hallway_backbone()
                    for a_id, b_id in WING_B_ROUTING_EDGES:
                        add_edge_if_clear(a_id, b_id, force=True)
                    for a_id, b_id in WING_C_ROUTING_EDGES:
                        add_edge_if_clear(a_id, b_id, force=True)
                    for a_id, b_id in BRIDGE_ROUTING_EDGES:
                        add_edge_if_clear(a_id, b_id, force=True)
                    for a_id, b_id in WING_A_ROUTING_EDGES:
                        add_edge_if_clear(a_id, b_id, force=True)
                    for a_id, b_id in MANUAL_ROUTING_EDGES:
                        add_edge_if_clear(a_id, b_id, force=True)
                except Exception as e:
                    print("Room connection failed:", room_id, e)

        # Connect colinear doors along room boundaries when unobstructed.
        connect_colinear_doors()

        # Re-stitch hallway backbones after room-junction insertion.
        # Room connections split hallway segments.
        connect_hallway_backbone()
        connect_layout_transit_topology()

        # Re-apply explicit bridge/backbone edges after room-junction insertion.
        for a_id, b_id in WING_B_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in WING_C_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in BRIDGE_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in WING_A_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)
        for a_id, b_id in MANUAL_ROUTING_EDGES:
            add_edge_if_clear(a_id, b_id, force=True)

        def stair_has_same_floor_transit(stair_id: str) -> bool:
            stair = self.graph.nodes[stair_id]
            for nb_id in self.graph.get_neighbors(stair_id):
                if nb_id.startswith("landing_"):
                    continue
                nb = self.graph.nodes.get(nb_id)
                if not nb or nb.floor != stair.floor:
                    continue
                if nb.type in {NODE_TYPE_HALLWAY, "door"}:
                    return True
            return False

        def connect_stairs_to_floor_transit():
            # Run after room/door creation so fallback door connectors exist.
            for floor, groups in self.graph.floors.items():
                stair_ids = groups.get(NODE_TYPE_STAIRS, [])
                if not stair_ids:
                    continue
                hallway_ids = [
                    hid for hid in groups.get(NODE_TYPE_HALLWAY, [])
                    if hid != MAIN_ENTRANCE_NODE_ID and not hid.startswith("landing_")
                ]
                door_ids = groups.get("door", [])

                for stair_id in stair_ids:
                    if stair_has_same_floor_transit(stair_id):
                        continue

                    # Prefer same-wing hallway attachment if unobstructed.
                    compatible_hallways = [
                        hid for hid in hallway_ids if stair_compatible_hallway(stair_id, hid)
                    ]
                    for hid in sorted(
                        compatible_hallways,
                        key=lambda node_id: hallway_attach_priority(stair_id, node_id),
                    ):
                        if add_edge_if_clear(stair_id, hid):
                            break

                    if stair_has_same_floor_transit(stair_id):
                        continue

                    if not door_ids:
                        continue
                    stair_node = self.graph.nodes[stair_id]
                    candidate_doors = []
                    for door_id in door_ids:
                        door_node = self.graph.nodes[door_id]
                        if door_node.floor != floor:
                            continue
                        if stair_node.wing and door_node.wing and stair_node.wing != door_node.wing:
                            continue
                        candidate_doors.append(door_id)

                    candidate_doors.sort(
                        key=lambda did: math.hypot(
                            self.graph.nodes[did].x - stair_node.x,
                            self.graph.nodes[did].y - stair_node.y,
                        )
                    )

                    for door_id in candidate_doors:
                        door_room_id = door_id[5:] if door_id.startswith("door_") else None
                        door_node = self.graph.nodes[door_id]
                        blocked = False
                        for room in room_nodes:
                            if room.floor != floor:
                                continue
                            if (room.metadata or {}).get("layout_matched") is False:
                                continue
                            if bool((room.metadata or {}).get("passable")):
                                continue
                            if room.id == door_room_id:
                                continue
                            try:
                                if line_intersects_rect(
                                    stair_node.x,
                                    stair_node.y,
                                    door_node.x,
                                    door_node.y,
                                    room.x,
                                    room.y,
                                    room.width,
                                    room.height,
                                ):
                                    blocked = True
                                    break
                            except Exception:
                                continue
                        if blocked:
                            continue
                        self.graph.add_edge(stair_id, door_id)
                        break

        connect_stairs_to_floor_transit()

        def connect_stairs_to_nearby_room_junctions():
            # Add one short, safe connector from each stair to a nearby same-wing
            # room junction. This prevents very long detours through far-edge bypass nodes.
            max_connector_distance = 260.0
            for floor, groups in self.graph.floors.items():
                stair_ids = groups.get(NODE_TYPE_STAIRS, [])
                if not stair_ids:
                    continue
                junction_ids = [
                    hid for hid in groups.get(NODE_TYPE_HALLWAY, [])
                    if hid.startswith("junction_")
                ]
                if not junction_ids:
                    continue

                for stair_id in stair_ids:
                    if stair_has_same_floor_transit(stair_id):
                        continue
                    stair_node = self.graph.nodes[stair_id]
                    candidates = []
                    for junction_id in junction_ids:
                        if junction_id in self.graph.get_neighbors(stair_id):
                            continue
                        junction_node = self.graph.nodes[junction_id]
                        if stair_node.wing and junction_node.wing and stair_node.wing != junction_node.wing:
                            continue
                        dist = math.hypot(junction_node.x - stair_node.x, junction_node.y - stair_node.y)
                        if dist > max_connector_distance:
                            continue
                        candidates.append((dist, junction_id))

                    candidates.sort(key=lambda item: item[0])
                    for _, junction_id in candidates:
                        if add_edge_if_clear(stair_id, junction_id):
                            break

        connect_stairs_to_nearby_room_junctions()

        def connect_main_entrance_to_nearest_stair():
            entrance_id = MAIN_ENTRANCE_NODE_ID
            if entrance_id not in self.graph.nodes:
                return
            entrance = self.graph.nodes[entrance_id]
            groups = self.graph.floors.get(entrance.floor, {})
            stair_ids = groups.get(NODE_TYPE_STAIRS, [])
            if not stair_ids:
                return

            candidate_stairs = []
            for stair_id in stair_ids:
                stair_node = self.graph.nodes[stair_id]
                if entrance.wing and stair_node.wing and entrance.wing != stair_node.wing:
                    continue
                dist = math.hypot(stair_node.x - entrance.x, stair_node.y - entrance.y)
                candidate_stairs.append((dist, stair_id))

            candidate_stairs.sort(key=lambda item: item[0])

            # Prefer existing hallway-based access. Only add a direct entrance->stair
            # edge when no route currently reaches any candidate stair.
            for _, stair_id in candidate_stairs:
                path_to_stair, _ = self.graph.a_star_pathfinding(entrance_id, stair_id)
                if path_to_stair:
                    return

            for _, stair_id in candidate_stairs:
                if add_edge_if_clear(entrance_id, stair_id):
                    break

        connect_main_entrance_to_nearest_stair()

        # Keep Wing A stair transit inside mapped boundaries. Legacy top-corridor
        # fallback edges (-125 y-axis) create long detours outside the visible plan.
        for legacy_hall_id in ("hall_1_turn_right", "hall_1_0"):
            if (
                "stairs1_Wing_A_1F" in self.graph.nodes
                and legacy_hall_id in self.graph.nodes
                and legacy_hall_id in self.graph.get_neighbors("stairs1_Wing_A_1F")
            ):
                self.graph.remove_edge("stairs1_Wing_A_1F", legacy_hall_id)

        def room_for_door(node_id: str) -> str | None:
            if not node_id.startswith("door_"):
                return None
            room_id = node_id[5:]
            room_node = self.graph.nodes.get(room_id)
            if room_node and room_node.type == NODE_TYPE_ROOM:
                return room_id
            return None

        def room_for_access_node(node_id: str) -> str | None:
            owner_room_id = room_for_door(node_id)
            if owner_room_id:
                return owner_room_id
            if not node_id.startswith("junction_"):
                return None
            room_id = node_id[len("junction_"):]
            room_node = self.graph.nodes.get(room_id)
            if room_node and room_node.type == NODE_TYPE_ROOM:
                return room_id
            return None

        def edge_crosses_non_owner_room(a_id: str, b_id: str) -> bool:
            a_node = self.graph.nodes.get(a_id)
            b_node = self.graph.nodes.get(b_id)
            if not a_node or not b_node or a_node.floor != b_node.floor:
                return False
            excluded_room_ids = set()
            owner_a = room_for_door(a_id)
            owner_b = room_for_door(b_id)
            if owner_a:
                excluded_room_ids.add(owner_a)
            if owner_b:
                excluded_room_ids.add(owner_b)

            for room in self.graph.nodes.values():
                if room.type != NODE_TYPE_ROOM:
                    continue
                if (room.metadata or {}).get("layout_matched") is False:
                    continue
                if bool((room.metadata or {}).get("passable")):
                    continue
                if room.id in excluded_room_ids:
                    continue
                if not room.width or not room.height:
                    continue
                try:
                    if line_intersects_rect(
                        a_node.x,
                        a_node.y,
                        b_node.x,
                        b_node.y,
                        room.x,
                        room.y,
                        room.width,
                        room.height,
                    ):
                        return True
                except Exception:
                    continue
            return False

        # Remove unsafe legacy Wing A shortcuts that slice through rooms.
        # Scope is intentionally narrow so Wing B/C connectivity remains intact.
        for a_id, b_id in list(self.graph.edges):
            a_node = self.graph.nodes.get(a_id)
            b_node = self.graph.nodes.get(b_id)
            if not a_node or not b_node:
                continue
            if a_node.floor != b_node.floor:
                continue
            a_is_hall = a_node.type == NODE_TYPE_HALLWAY and not a_id.startswith("landing_")
            b_is_hall = b_node.type == NODE_TYPE_HALLWAY and not b_id.startswith("landing_")
            hall_id = a_id if a_is_hall else (b_id if b_is_hall else None)
            if not hall_id:
                continue
            is_legacy_wing_a_hall = (
                hall_id.startswith("hall_2_")
                or hall_id.startswith("hall_3_")
                or hall_id.startswith("hallway_wing_a_2_")
                or hall_id.startswith("hallway_wing_a_3_")
                or hall_id == HALLWAY_WING_A_1_4
            )
            if not is_legacy_wing_a_hall:
                continue
            is_candidate = (
                (a_is_hall and b_node.type in {"door", NODE_TYPE_STAIRS})
                or (b_is_hall and a_node.type in {"door", NODE_TYPE_STAIRS})
            )
            if not is_candidate:
                continue
            if edge_crosses_non_owner_room(a_id, b_id):
                self.graph.remove_edge(a_id, b_id)

        # After pruning unsafe legacy stair->hall edges, recover only via safe door fallback.
        for floor, groups in self.graph.floors.items():
            stair_ids = groups.get(NODE_TYPE_STAIRS, [])
            door_ids = groups.get("door", [])
            if not stair_ids or not door_ids:
                continue
            for stair_id in stair_ids:
                if stair_has_same_floor_transit(stair_id):
                    continue
                stair_node = self.graph.nodes[stair_id]
                candidate_doors = []
                for door_id in door_ids:
                    door_node = self.graph.nodes[door_id]
                    if door_node.floor != floor:
                        continue
                    if stair_node.wing and door_node.wing and stair_node.wing != door_node.wing:
                        continue
                    candidate_doors.append(door_id)
                candidate_doors.sort(
                    key=lambda did: math.hypot(
                        self.graph.nodes[did].x - stair_node.x,
                        self.graph.nodes[did].y - stair_node.y,
                    )
                )
                for door_id in candidate_doors:
                    door_room_id = door_id[5:] if door_id.startswith("door_") else None
                    door_node = self.graph.nodes[door_id]
                    blocked = False
                    for room in room_nodes:
                        if room.floor != floor:
                            continue
                        if (room.metadata or {}).get("layout_matched") is False:
                            continue
                        if bool((room.metadata or {}).get("passable")):
                            continue
                        if room.id == door_room_id:
                            continue
                        try:
                            if line_intersects_rect(
                                stair_node.x,
                                stair_node.y,
                                door_node.x,
                                door_node.y,
                                room.x,
                                room.y,
                                room.width,
                                room.height,
                            ):
                                blocked = True
                                break
                        except Exception:
                            continue
                    if blocked:
                        continue
                    self.graph.add_edge(stair_id, door_id)
                    break

        # Remove unsafe direct door-to-door shortcuts that cut through unrelated rooms.
        for a_id, b_id in list(self.graph.edges):
            a_node = self.graph.nodes.get(a_id)
            b_node = self.graph.nodes.get(b_id)
            if not a_node or not b_node:
                continue
            if a_node.floor != b_node.floor:
                continue
            if a_node.type != "door" or b_node.type != "door":
                continue
            if edge_crosses_non_owner_room(a_id, b_id):
                self.graph.remove_edge(a_id, b_id)

        # Room-access nodes are entry/exit points only; never allow direct transit
        # between different rooms' doors/junctions.
        for a_id, b_id in list(self.graph.edges):
            a_node = self.graph.nodes.get(a_id)
            b_node = self.graph.nodes.get(b_id)
            if not a_node or not b_node:
                continue
            if a_node.floor != b_node.floor:
                continue
            owner_a = room_for_access_node(a_id)
            owner_b = room_for_access_node(b_id)
            if not owner_a or not owner_b:
                continue
            if owner_a == owner_b:
                continue
            self.graph.remove_edge(a_id, b_id)

        def stair_group_key(stair_id: str, stair_node):
            custom_match = re.fullmatch(r"stairs-(\d)f-wing([a-z])", stair_id.lower())
            if custom_match:
                return f"stairs-custom-wing-{custom_match.group(2)}"
            if "_" in stair_id:
                return stair_id.rsplit("_", 1)[0]
            return stair_node.name or stair_id

        stairs_by_name = {}

        for floor, groups in self.graph.floors.items():
            for stair_id in groups.get(NODE_TYPE_STAIRS, []):
                stair_node = self.graph.nodes[stair_id]
                key = stair_group_key(stair_id, stair_node)
                stairs_by_name.setdefault(key, []).append(stair_id)

        # Create hallway landings for stairs and connect vertically via landings
        # This ensures routes include a floor-appropriate hallway node before changing floors.
        landing_by_stair_id = {}
        for stair_id in (sid for sids in stairs_by_name.values() for sid in sids):
            stair = self.graph.nodes[stair_id]
            landing_id = f"landing_{stair_id}"
            if landing_id not in self.graph.nodes:
                landing_x, landing_y = stair.center
                landing = Node(
                    id=landing_id,
                    x=landing_x,
                    y=landing_y,
                    floor=stair.floor,
                    name="Stair Landing",
                    type=NODE_TYPE_HALLWAY,
                )
                self.graph.add_node(landing)
            landing_by_stair_id[stair_id] = landing_id
            # connect stair <-> landing on the same floor
            self.graph.add_edge(stair_id, landing_id)

        # Remove any landing <-> hallway edges so paths must pass through stair centers
        for stair_id, landing_id in landing_by_stair_id.items():
            landing = self.graph.nodes[landing_id]
            for nb_id in list(self.graph.get_neighbors(landing_id)):
                nb = self.graph.nodes[nb_id]
                if nb.type != NODE_TYPE_HALLWAY:
                    continue
                if nb_id.startswith("landing_"):
                    continue
                if nb.floor != landing.floor:
                    continue
                # Disallow direct landing <-> hallway
                self.graph.remove_edge(landing_id, nb_id)

        # Connect stairs vertically by adjacent floors.
        for stair_list in stairs_by_name.values():
            stair_list_sorted = sorted(
                stair_list,
                key=lambda sid: self.graph.nodes[sid].floor
            )
            for i in range(len(stair_list_sorted) - 1):
                lower_stair_id = stair_list_sorted[i]
                upper_stair_id = stair_list_sorted[i + 1]
                self.graph.add_edge(lower_stair_id, upper_stair_id)

        def wing_from_node_id(node_id: str) -> str | None:
            lowered = node_id.lower()
            if "wing_a" in lowered:
                return "A"
            if "wing_b" in lowered:
                return "B"
            return None

        def landing_owner_stair(landing_id: str) -> str | None:
            if landing_id.startswith("landing_"):
                return landing_id[len("landing_"):]
            return None

        # Final enforcement: remove any remaining landing <-> hallway edges
        for stair_id, landing_id in landing_by_stair_id.items():
            landing = self.graph.nodes[landing_id]
            for nb_id in list(self.graph.get_neighbors(landing_id)):
                nb = self.graph.nodes[nb_id]
                if nb.type != NODE_TYPE_HALLWAY:
                    continue
                if nb_id.startswith("landing_"):
                    continue
                if nb.floor != landing.floor:
                    continue
                self.graph.remove_edge(landing_id, nb_id)

        # Remove any cross-wing landing/vertical links that can create invalid transfers.
        for landing_id in landing_by_stair_id.values():
            owner_stair = landing_owner_stair(landing_id)
            owner_wing = wing_from_node_id(owner_stair or "")
            for nb_id in list(self.graph.get_neighbors(landing_id)):
                if nb_id.startswith("landing_"):
                    nb_owner_stair = landing_owner_stair(nb_id)
                    nb_wing = wing_from_node_id(nb_owner_stair or "")
                    if owner_wing and nb_wing and owner_wing != nb_wing:
                        self.graph.remove_edge(landing_id, nb_id)
                    continue
                if NODE_TYPE_STAIRS in nb_id.lower():
                    nb_wing = wing_from_node_id(nb_id)
                    if owner_wing and nb_wing and owner_wing != nb_wing:
                        self.graph.remove_edge(landing_id, nb_id)

        # Prefer explicit boundary attachment nodes over legacy direct point->rectangle
        # edges, which can look like room-cutting shortcuts in rendered/simplified paths.
        for a_id, b_id in list(self.graph.edges):
            a_node = self.graph.nodes.get(a_id)
            b_node = self.graph.nodes.get(b_id)
            if not a_node or not b_node:
                continue
            if a_node.floor != b_node.floor:
                continue

            a_hallway_rect = (
                a_node.type == NODE_TYPE_HALLWAY
                and a_node.width is not None
                and a_node.height is not None
                and a_node.width > 0
                and a_node.height > 0
            )
            b_hallway_rect = (
                b_node.type == NODE_TYPE_HALLWAY
                and b_node.width is not None
                and b_node.height is not None
                and b_node.width > 0
                and b_node.height > 0
            )
            if a_hallway_rect == b_hallway_rect:
                continue

            point_id = b_id if a_hallway_rect else a_id
            rect_id = a_id if a_hallway_rect else b_id
            attach_prefix = f"layout_attach_{point_id}_{rect_id}_"
            if any(node_id.startswith(attach_prefix) for node_id in self.graph.nodes):
                self.graph.remove_edge(a_id, b_id)


        # ---------- DEBUG VISIBILITY ----------
        if os.getenv("DEBUG_GRAPH_CONNECTIVITY", "0") == "1":
            print("\nGRAPH CONNECTIVITY")
            for k, v in self.graph.adjacency.items():
                print(k, "->", v)

        self._write_graph_cache()

    def parse_navigation(self, origin: str, destination: str) -> dict:
        """
        Strict search mode: route only from explicit origin and destination values.
        """

        def coerce_node_id_strict(graph, value: str):
            if not value:
                return None
            if value in graph.nodes:
                return value

            text = value.strip()
            lowered = text.lower()
            alias = LOCATION_ALIASES.get(lowered, lowered)

            if alias != lowered:
                resolved_alias_id = graph.resolve_node_id(str(alias))
                if resolved_alias_id:
                    return resolved_alias_id

            def norm_text(v: str) -> str:
                return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (v or "").lower())).strip()

            def match_keys(v: str) -> set[str]:
                base = norm_text(v)
                if not base:
                    return set()
                keys = {base}
                keys.add(re.sub(r"([0-9])f\b", r"\1", base))
                keys.add(re.sub(r"([0-9])\b", r"\1f", base))
                return {k for k in keys if k}

            def room_code_keys(v: str) -> set[str]:
                raw = str(v or "").lower()
                keys = set()
                keys.update(re.findall(r"\b([abc]\d{3}[a-z]?)\b", raw))
                compact = re.sub(r"[^a-z0-9]+", "", raw)
                keys.update(re.findall(r"([abc]\d{3}[a-z]?)", compact))
                return {k for k in keys if k}

            for node_id in graph.nodes.keys():
                node_lower = node_id.lower().strip()
                if node_lower == lowered or node_lower == str(alias).lower().strip():
                    return node_id

            target_keys = match_keys(str(alias)) | match_keys(lowered)
            target_room_codes = room_code_keys(str(alias)) | room_code_keys(lowered)
            for node_id, node in graph.nodes.items():
                node_keys = match_keys(node_id) | match_keys(node.name or "")
                if target_keys & node_keys:
                    return node_id
                if target_room_codes:
                    node_room_codes = room_code_keys(node_id) | room_code_keys(node.name or "")
                    if target_room_codes & node_room_codes:
                        return node_id

            return None

        def display_path_for_route(raw_path: List[str]) -> List[str]:
            path_view = list(raw_path)

            if len(path_view) >= 2:
                first = self.graph.nodes.get(path_view[0])
                second = self.graph.nodes.get(path_view[1])
                if first and second and first.type == NODE_TYPE_ROOM and second.type == "door":
                    path_view = path_view[1:]

            return path_view

        def node_point(node_id: str):
            node = self.graph.nodes.get(node_id)
            if not node:
                return None
            if node_id == MAIN_ENTRANCE_NODE_ID:
                return {
                    "x": node.x,
                    "y": node.y,
                    FLOOR_KEY: node.floor,
                }
            if node.type == NODE_TYPE_ROOM:
                for nb_id in self.graph.get_neighbors(node_id):
                    nb = self.graph.nodes.get(nb_id)
                    if nb and nb.type == "door":
                        return {"x": nb.x, "y": nb.y, FLOOR_KEY: nb.floor}
            x, y = node.center if node.width and node.height else (node.x, node.y)
            return {"x": x, "y": y, FLOOR_KEY: node.floor}

        def path_via_waypoints(
            start_id: str,
            goal_id: str,
            waypoints: List[str],
            blocked_nodes: set[str] | None = None,
        ) -> tuple[List[str], float]:
            stitched: List[str] = []
            current = start_id
            for wp in waypoints + [goal_id]:
                if wp not in self.graph.nodes:
                    return [], float("inf")
                seg, _ = self.graph.a_star_pathfinding(
                    current,
                    wp,
                    blocked_nodes=blocked_nodes,
                    exact=True,
                )
                if not seg:
                    return [], float("inf")
                if stitched:
                    stitched.extend(seg[1:])
                else:
                    stitched.extend(seg)
                current = wp
            total = 0.0
            for i in range(len(stitched) - 1):
                total += self.graph.calculate_distance(stitched[i], stitched[i + 1])
            return stitched, total

        def reroute_avoiding_foreign_room_junctions(
            current_path: List[str],
            *,
            start_id: str,
            goal_id: str,
            chosen_waypoints: List[str],
        ) -> tuple[List[str], float]:
            allowed_room_ids = set()
            for endpoint_id in (start_id, goal_id):
                endpoint = self.graph.nodes.get(endpoint_id)
                if endpoint and endpoint.type == NODE_TYPE_ROOM:
                    allowed_room_ids.add(endpoint_id)
            def foreign_room_transit_nodes(path_to_check: List[str]) -> set[str]:
                return {
                    node_id
                    for node_id in path_to_check
                    if (
                        node_id.startswith("junction_")
                        and node_id[len("junction_"):] not in allowed_room_ids
                    )
                    or (
                        node_id.startswith("door_")
                        and node_id[5:] not in allowed_room_ids
                    )
                }

            best_path = current_path
            blocked_transit_nodes: set[str] = set()
            for _ in range(6):
                newly_blocked = foreign_room_transit_nodes(best_path) - blocked_transit_nodes
                if not newly_blocked:
                    break
                blocked_transit_nodes |= newly_blocked

                if chosen_waypoints:
                    alt_path, alt_distance = path_via_waypoints(
                        start_id,
                        goal_id,
                        chosen_waypoints,
                        blocked_nodes=blocked_transit_nodes,
                    )
                else:
                    alt_path, alt_distance = self.graph.a_star_pathfinding(
                        start_id,
                        goal_id,
                        blocked_nodes=blocked_transit_nodes,
                    )

                if not alt_path:
                    break
                best_path = alt_path

            total = 0.0
            for i in range(len(best_path) - 1):
                total += self.graph.calculate_distance(best_path[i], best_path[i + 1])
            return best_path, total

        def effective_wing_for_node_id(node_id: str) -> str | None:
            node = self.graph.nodes.get(node_id)
            if not node:
                return None
            if node_id == MAIN_ENTRANCE_NODE_ID:
                return None
            if bool((node.metadata or {}).get("exterior_access")):
                return None
            if node.wing:
                return node.wing
            lowered = node_id.lower()
            if "wing_b" in lowered or "_b_" in lowered or " wing b" in lowered or "-b" in lowered:
                return "B"
            if "wing_c" in lowered or "_c_" in lowered or " wing c" in lowered or "-c" in lowered:
                return "C"
            if "wing_a" in lowered or "_a_" in lowered or " wing a" in lowered or "-a" in lowered:
                return "A"
            return None

        def traversal_anchor_node_id(node_id: str) -> str:
            node = self.graph.nodes.get(node_id)
            if not node:
                return node_id

            # For room inputs, route starts at a door; use it for accurate wing/floor inference.
            if node.type == NODE_TYPE_ROOM:
                for nb_id in self.graph.get_neighbors(node_id):
                    nb = self.graph.nodes.get(nb_id)
                    if nb and nb.type == "door":
                        return nb_id
                return node_id

            # For door/junction inputs, prefer adjacent transit nodes (hallway/bridge/stairs).
            if node.type in {"door", "junction"}:
                hallway_like = {
                    NODE_TYPE_HALLWAY,
                    NODE_TYPE_STAIRS,
                    "bridge",
                }
                for nb_id in self.graph.get_neighbors(node_id):
                    nb = self.graph.nodes.get(nb_id)
                    if nb and (
                        nb.type in hallway_like
                        or nb_id.startswith("hall_")
                        or nb_id.startswith("hallway_wing_")
                        or nb_id.startswith("bridge_hall_")
                    ):
                        return nb_id
                for nb_id in self.graph.get_neighbors(node_id):
                    nb = self.graph.nodes.get(nb_id)
                    if nb and nb.type != NODE_TYPE_ROOM:
                        return nb_id

            return node_id

        def single_wing_zone_for_node(node_id: str) -> str | None:
            node = self.graph.nodes.get(node_id)
            if not node:
                return None
            wing = effective_wing_for_node_id(node_id)
            if wing not in {"A", "B", "C"}:
                return None
            return f"{wing}:{node.floor}"

        def adjacent_access_zones(node_id: str) -> set[str]:
            node = self.graph.nodes.get(node_id)
            if not node:
                return set()
            zones: set[str] = set()
            own_zone = single_wing_zone_for_node(node_id)
            if own_zone:
                zones.add(own_zone)
            for nb_id in self.graph.get_neighbors(node_id):
                nb = self.graph.nodes.get(nb_id)
                if not nb or nb.floor != node.floor:
                    continue
                nb_zone = single_wing_zone_for_node(nb_id)
                if (
                    not nb_zone
                    and node_id == MAIN_ENTRANCE_NODE_ID
                    and nb.wing in {"A", "B", "C"}
                ):
                    # Main entrance attaches through exterior-access helper nodes.
                    # Keep those nodes excluded from general wing inference, but still
                    # allow the entrance to discover the wing/floor zones they reach.
                    nb_zone = f"{nb.wing}:{nb.floor}"
                if nb_zone:
                    zones.add(nb_zone)
            return zones

        def stair_group_key(node_id: str) -> str | None:
            lowered = str(node_id or "").lower()
            if "stairs" not in lowered:
                return None
            lowered = re.sub(r"_[123]f$", "", lowered)
            lowered = re.sub(r"-[123]f(?=-|$)", "", lowered)
            return lowered or None

        def transfer_waypoint_plans_for_route(start_id: str, goal_id: str) -> List[List[str]]:
            start_anchor_id = traversal_anchor_node_id(start_id)
            goal_anchor_id = traversal_anchor_node_id(goal_id)
            start_zones = {
                zone
                for zone in (
                    single_wing_zone_for_node(start_anchor_id),
                    single_wing_zone_for_node(start_id),
                )
                if zone
            }
            goal_zones = {
                zone
                for zone in (
                    single_wing_zone_for_node(goal_anchor_id),
                    single_wing_zone_for_node(goal_id),
                )
                if zone
            }

            if start_id == MAIN_ENTRANCE_NODE_ID or goal_id == MAIN_ENTRANCE_NODE_ID:
                if not start_zones and start_id == MAIN_ENTRANCE_NODE_ID:
                    start_zones |= adjacent_access_zones(start_id)
                if not goal_zones and goal_id == MAIN_ENTRANCE_NODE_ID:
                    goal_zones |= adjacent_access_zones(goal_id)

            if not start_zones or not goal_zones or (start_zones & goal_zones):
                return []

            transfer_options: dict[tuple[str, str], set[tuple[str, ...]]] = {}

            def add_transfer_edge(
                from_zone: str,
                to_zone: str,
                waypoints_forward: List[str],
                waypoints_reverse: List[str] | None = None,
            ) -> None:
                if from_zone == to_zone or not waypoints_forward:
                    return
                reverse = list(waypoints_reverse) if waypoints_reverse is not None else list(reversed(waypoints_forward))
                transfer_options.setdefault((from_zone, to_zone), set()).add(tuple(waypoints_forward))
                transfer_options.setdefault((to_zone, from_zone), set()).add(tuple(reverse))

            # Same-floor cross-zone connectors discovered from the live graph itself.
            for a_id, b_id in self.graph.edges:
                a_node = self.graph.nodes.get(a_id)
                b_node = self.graph.nodes.get(b_id)
                if not a_node or not b_node or a_node.floor != b_node.floor:
                    continue
                if a_node.type not in {NODE_TYPE_HALLWAY, NODE_TYPE_STAIRS}:
                    continue
                if b_node.type not in {NODE_TYPE_HALLWAY, NODE_TYPE_STAIRS}:
                    continue
                a_zone = single_wing_zone_for_node(a_id)
                b_zone = single_wing_zone_for_node(b_id)
                if not a_zone or not b_zone or a_zone == b_zone:
                    continue
                if self.graph.edge_crosses_room(a_id, b_id):
                    continue
                add_transfer_edge(a_zone, b_zone, [a_id, b_id])

            # Bridge hallways can connect any zones they physically attach to on the current layout.
            for node_id in self.graph.nodes:
                if not str(node_id).startswith("bridge_hall_"):
                    continue
                zones = sorted(adjacent_access_zones(node_id))
                for index, from_zone in enumerate(zones):
                    for to_zone in zones[index + 1:]:
                        add_transfer_edge(from_zone, to_zone, [node_id])

            # Stair shafts create adjacent-floor transfers within their discovered access zones.
            stairs_by_group: dict[str, list[str]] = {}
            for node_id, node in self.graph.nodes.items():
                if node.type != NODE_TYPE_STAIRS:
                    continue
                group_key = stair_group_key(node_id)
                if not group_key:
                    continue
                stairs_by_group.setdefault(group_key, []).append(node_id)

            for stair_ids in stairs_by_group.values():
                sorted_stairs = sorted(stair_ids, key=lambda sid: self.graph.nodes[sid].floor)
                for i in range(len(sorted_stairs) - 1):
                    lower_id = sorted_stairs[i]
                    upper_id = sorted_stairs[i + 1]
                    lower_node = self.graph.nodes[lower_id]
                    upper_node = self.graph.nodes[upper_id]
                    if upper_node.floor - lower_node.floor != 1:
                        continue
                    lower_zone = single_wing_zone_for_node(lower_id)
                    upper_zone = single_wing_zone_for_node(upper_id)
                    if not lower_zone or not upper_zone:
                        continue
                    add_transfer_edge(lower_zone, upper_zone, [lower_id, upper_id])

            transfer_graph: dict[str, list[tuple[str, List[str]]]] = {}
            for (from_zone, to_zone), options in transfer_options.items():
                ranked_options = sorted(
                    options,
                    key=lambda item: (len(item), item),
                )[:6]
                for waypoint_tuple in ranked_options:
                    transfer_graph.setdefault(from_zone, []).append((to_zone, list(waypoint_tuple)))

            plans: List[List[str]] = []
            queue: List[tuple[int, int, str, List[str], set[str]]] = [
                (0, 0, start_zone, [], {start_zone})
                for start_zone in sorted(start_zones)
            ]
            while queue and len(plans) < 24:
                queue.sort(key=lambda item: (item[0], item[1]))
                depth, waypoint_count, current_zone, current_waypoints, visited = queue.pop(0)
                if current_zone in goal_zones:
                    if current_waypoints:
                        plans.append(current_waypoints)
                    continue
                if depth >= 5:
                    continue
                next_edges = sorted(
                    transfer_graph.get(current_zone, []),
                    key=lambda item: (len(item[1]), item[1]),
                )
                for next_zone, edge_waypoints in next_edges:
                    if next_zone in visited:
                        continue
                    queue.append((
                        depth + 1,
                        waypoint_count + len(edge_waypoints),
                        next_zone,
                        current_waypoints + edge_waypoints,
                        visited | {next_zone},
                    ))

            deduped: List[List[str]] = []
            seen_plans: set[tuple[str, ...]] = set()
            for plan in plans:
                plan_key = tuple(plan)
                if plan_key in seen_plans:
                    continue
                seen_plans.add(plan_key)
                deduped.append(plan)
            return deduped

        def entrance_floor1_bridge_plans_for_route(start_id: str, goal_id: str) -> List[List[str]]:
            if MAIN_ENTRANCE_NODE_ID not in {start_id, goal_id}:
                return []

            other_id = goal_id if start_id == MAIN_ENTRANCE_NODE_ID else start_id
            other_anchor_id = traversal_anchor_node_id(other_id)
            other_zone = single_wing_zone_for_node(other_anchor_id) or single_wing_zone_for_node(other_id)
            if other_zone != "B:1":
                return []

            candidate_plans: List[List[str]] = []
            for bridge_id in ("bridge_hall_1_ab", "bridge_hall_1_bc"):
                if bridge_id in self.graph.nodes:
                    candidate_plans.append([bridge_id])
            return candidate_plans

        def path_satisfies_transfer_requirements(
            current_path: List[str],
            start_id: str,
            goal_id: str,
        ) -> bool:
            start_anchor_id = traversal_anchor_node_id(start_id)
            goal_anchor_id = traversal_anchor_node_id(goal_id)
            start_wing = effective_wing_for_node_id(start_anchor_id) or effective_wing_for_node_id(start_id)
            goal_wing = effective_wing_for_node_id(goal_anchor_id) or effective_wing_for_node_id(goal_id)
            wing_pair = {start_wing, goal_wing}
            if wing_pair == {"A", "B"}:
                if "bridge_hall_1_ab" in current_path:
                    return True
                path_zones = {
                    zone
                    for node_id in current_path
                    for zone in [single_wing_zone_for_node(node_id)]
                    if zone
                }
                return any(
                    f"A:{floor}" in path_zones and f"B:{floor}" in path_zones
                    for floor in (2, 3)
                )
            if wing_pair == {"B", "C"}:
                return any(
                    node_id.startswith("bridge_hall_") and node_id.endswith("_bc")
                    for node_id in current_path
                )
            if wing_pair == {"A", "C"}:
                if not any(
                    node_id.startswith("bridge_hall_") and node_id.endswith("_bc")
                    for node_id in current_path
                ):
                    return False
                if "bridge_hall_1_bc" in current_path and "bridge_hall_1_ab" not in current_path:
                    return False
            return True

        def simplify_display_path(raw_path: List[str]) -> List[str]:
            if len(raw_path) < 3:
                return raw_path

            keep = [raw_path[0]]
            eps = 1e-6

            for i in range(1, len(raw_path) - 1):
                prev_id = keep[-1]
                cur_id = raw_path[i]
                next_id = raw_path[i + 1]

                prev_node = self.graph.nodes[prev_id]
                cur_node = self.graph.nodes[cur_id]
                next_node = self.graph.nodes[next_id]

                if cur_node.type != NODE_TYPE_HALLWAY or cur_id.startswith("bridge_hall_") or cur_id.startswith("landing_"):
                    keep.append(cur_id)
                    continue
                if cur_id.startswith("layout_attach_"):
                    keep.append(cur_id)
                    continue
                if cur_id.startswith("layout_junction_"):
                    keep.append(cur_id)
                    continue
                if bool((cur_node.metadata or {}).get("exterior_access")):
                    keep.append(cur_id)
                    continue
                if cur_id.startswith("junction_"):
                    keep.append(cur_id)
                    continue

                if (
                    cur_id.startswith("hall_b_")
                    or cur_id.startswith("hall_1_")
                    or cur_id.startswith("hall_2_")
                    or cur_id.startswith("hall_3_")
                    or cur_id.startswith("hall_c_1_")
                    or cur_id.startswith("vertical_hallway_")
                    or cur_id.startswith("hallway_wing_")
                ):
                    keep.append(cur_id)
                    continue

                if not (prev_node.floor == cur_node.floor == next_node.floor):
                    keep.append(cur_id)
                    continue

                x1, y1 = prev_node.x, prev_node.y
                x2, y2 = cur_node.x, cur_node.y
                x3, y3 = next_node.x, next_node.y
                cross = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1)
                if abs(cross) > eps:
                    keep.append(cur_id)
                    continue

                between_x = min(x1, x3) - eps <= x2 <= max(x1, x3) + eps
                between_y = min(y1, y3) - eps <= y2 <= max(y1, y3) + eps
                if not (between_x and between_y):
                    keep.append(cur_id)
                    continue

                if self.graph.edge_crosses_room(prev_id, next_id):
                    keep.append(cur_id)
                    continue

            keep.append(raw_path[-1])
            return keep

        def prune_repeated_node_cycles(raw_path: List[str]) -> List[str]:
            if len(raw_path) < 2:
                return raw_path

            pruned: List[str] = []
            node_index: dict[str, int] = {}
            for node_id in raw_path:
                existing_index = node_index.get(node_id)
                if existing_index is not None:
                    pruned = pruned[: existing_index + 1]
                    node_index = {existing_id: idx for idx, existing_id in enumerate(pruned)}
                    continue
                node_index[node_id] = len(pruned)
                pruned.append(node_id)
            return pruned

        def render_path_for_length(raw_path: List[str]) -> List[str]:
            if not raw_path:
                return []
            render_path = prune_repeated_node_cycles(raw_path)
            if len(render_path) >= 2:
                last_node = self.graph.nodes.get(render_path[-1])
                prev_node = self.graph.nodes.get(render_path[-2])
                if last_node and prev_node and last_node.type == NODE_TYPE_ROOM and prev_node.type == "door":
                    render_path = render_path[:-1]
            return render_path

        def route_geometry_length(raw_path: List[str]) -> float:
            render_path = render_path_for_length(raw_path)
            if not render_path:
                return float("inf")
            svg_path = path_to_svg(self.graph, render_path)
            if not svg_path:
                return float("inf")

            tokens = svg_path.split()
            points: list[tuple[float, float]] = []
            i = 0
            while i + 2 < len(tokens):
                if tokens[i] not in {"M", "L"}:
                    i += 1
                    continue
                try:
                    points.append((float(tokens[i + 1]), float(tokens[i + 2])))
                except ValueError:
                    i += 1
                    continue
                i += 3

            if len(points) < 2:
                return 0.0
            return sum(
                math.hypot(points[idx + 1][0] - points[idx][0], points[idx + 1][1] - points[idx][1])
                for idx in range(len(points) - 1)
            )

        def choose_best_route_candidate(
            start_id: str,
            goal_id: str,
            candidate_waypoint_plans: List[List[str]],
            *,
            blocked_nodes: set[str] | None = None,
        ) -> tuple[List[str], float, List[str]]:
            best_path, best_distance = self.graph.a_star_pathfinding(
                start_id,
                goal_id,
                blocked_nodes=blocked_nodes,
                exact=bool(candidate_waypoint_plans),
            )
            best_waypoints: List[str] = []

            if not candidate_waypoint_plans:
                return best_path, best_distance, best_waypoints

            best_transfer_path: List[str] = []
            best_transfer_distance = float("inf")
            best_transfer_geometry = float("inf")
            best_transfer_waypoints: List[str] = []

            if best_path and path_satisfies_transfer_requirements(
                best_path,
                start_id,
                goal_id,
            ):
                best_transfer_path = best_path
                best_transfer_distance = best_distance
                best_transfer_geometry = route_geometry_length(best_path)

            for candidate_waypoints in candidate_waypoint_plans:
                if blocked_nodes and any(waypoint in blocked_nodes for waypoint in candidate_waypoints):
                    continue
                transfer_path, transfer_distance = path_via_waypoints(
                    start_id,
                    goal_id,
                    candidate_waypoints,
                    blocked_nodes=blocked_nodes,
                )
                if not transfer_path:
                    continue
                transfer_geometry = route_geometry_length(transfer_path)
                if (
                    transfer_geometry < best_transfer_geometry - 1e-6
                    or (
                        abs(transfer_geometry - best_transfer_geometry) <= 1e-6
                        and transfer_distance < best_transfer_distance
                    )
                ):
                    best_transfer_path = transfer_path
                    best_transfer_distance = transfer_distance
                    best_transfer_geometry = transfer_geometry
                    best_transfer_waypoints = candidate_waypoints

            if best_transfer_path:
                return best_transfer_path, best_transfer_distance, best_transfer_waypoints
            return best_path, best_distance, best_waypoints

        path: List[str] = []
        distance: float = 0
        route: str = ""
        floor_routes: dict = {}

        resolved_origin = coerce_node_id_strict(self.graph, origin)
        if not resolved_origin or resolved_origin not in self.graph.nodes:
            return {
                "origin": None,
                "destination": None,
                "route": "",
                "path": [],
                "error": f"Origin not found: {origin}",
            }

        resolved_destination = coerce_node_id_strict(self.graph, destination)
        if not resolved_destination or resolved_destination not in self.graph.nodes:
            return {
                "origin": resolved_origin,
                "destination": None,
                "route": "",
                "path": [],
                "error": f"Destination not found: {destination}",
            }

        transfer_waypoint_plans = transfer_waypoint_plans_for_route(
            resolved_origin,
            resolved_destination,
        )
        transfer_waypoint_plans.extend(
            entrance_floor1_bridge_plans_for_route(
                resolved_origin,
                resolved_destination,
            )
        )
        forced_origin_waypoints = BRIDGE_REQUIRED_ORIGIN_WAYPOINTS.get(resolved_origin)
        forced_waypoints = BRIDGE_REQUIRED_DESTINATION_WAYPOINTS.get(resolved_destination)
        chosen_waypoints: List[str] = []

        path, distance, chosen_waypoints = choose_best_route_candidate(
            resolved_origin,
            resolved_destination,
            transfer_waypoint_plans,
        )

        origin_node = self.graph.nodes.get(resolved_origin)
        destination_node = self.graph.nodes.get(resolved_destination)
        if (
            path
            and origin_node
            and destination_node
            and origin_node.floor == destination_node.floor
            and any(
                self.graph.nodes[node_id].floor != origin_node.floor
                for node_id in path
                if node_id in self.graph.nodes
            )
        ):
            shared_floor = origin_node.floor
            same_floor_waypoint_plans = [
                plan
                for plan in transfer_waypoint_plans
                if all(
                    waypoint in self.graph.nodes and self.graph.nodes[waypoint].floor == shared_floor
                    for waypoint in plan
                )
            ]
            same_floor_blocked_nodes = {
                node_id
                for node_id, node in self.graph.nodes.items()
                if node.floor != shared_floor and node_id not in {resolved_origin, resolved_destination}
            }
            path, distance, chosen_waypoints = choose_best_route_candidate(
                resolved_origin,
                resolved_destination,
                same_floor_waypoint_plans,
                blocked_nodes=same_floor_blocked_nodes,
            )
        if forced_origin_waypoints:
            forced_origin_path, forced_origin_distance = path_via_waypoints(
                resolved_origin,
                resolved_destination,
                forced_origin_waypoints,
            )
            if forced_origin_path:
                path, distance = forced_origin_path, forced_origin_distance
                chosen_waypoints = forced_origin_waypoints
        if forced_waypoints:
            forced_path, forced_distance = path_via_waypoints(
                resolved_origin,
                resolved_destination,
                forced_waypoints,
            )
            if forced_path:
                path, distance = forced_path, forced_distance
                chosen_waypoints = forced_waypoints

        if path:
            path, distance = reroute_avoiding_foreign_room_junctions(
                path,
                start_id=resolved_origin,
                goal_id=resolved_destination,
                chosen_waypoints=chosen_waypoints,
            )
            path = prune_repeated_node_cycles(path)
            path = simplify_display_path(path)
            path = display_path_for_route(path)
            render_path = list(path)
            # Keep logical path ending at room, but render to the door endpoint to avoid
            # drawing an extra segment into room-center coordinates.
            if len(render_path) >= 2:
                last_node = self.graph.nodes.get(render_path[-1])
                prev_node = self.graph.nodes.get(render_path[-2])
                if last_node and prev_node and last_node.type == NODE_TYPE_ROOM and prev_node.type == "door":
                    render_path = render_path[:-1]

            # Keep API path consistent with rendered geometry, with fallback
            # to the logical path if rendering compaction removes all nodes.
            path = list(render_path) if render_path else list(path)

            floor_paths = split_path_by_floor(self.graph, render_path)
            floor_routes = {f: path_to_svg(self.graph, nodes) for f, nodes in floor_paths.items()}
            route = path_to_svg(self.graph, render_path)

        return {
            "origin": resolved_origin,
            "destination": resolved_destination,
            "origin_point": node_point(resolved_origin),
            "destination_point": node_point(resolved_destination),
            "route": route,
            "floor_routes": floor_routes,
            "path": path,
        }

