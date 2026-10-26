from models.node import Node
from constants.navigation_constants import STD_ROOM_WIDTH
from constants.navigation_constants import STD_ROOM_HEIGHT
from constants.navigation_constants import STAIRS_WIDTH
from constants.navigation_constants import STAIRS_HEIGHT
from typing import List
from typing import Any
from shapely.geometry import LineString, box
import math
import re
from utils.map_layout import load_map_layout
from utils.map_layout import extract_svg_floor_entities


def _norm_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _expanded_keys(value: Any) -> set[str]:
    base = _norm_key(value)
    keys = {base} if base else set()
    if not base:
        return keys
    # Allow matching names that differ only by floor suffix style (e.g. B2 vs B2F).
    keys.add(re.sub(r"([0-9])f$", r"\1", base))
    keys.add(re.sub(r"([0-9])$", r"\1f", base))
    return {k for k in keys if k}


def _infer_wing_from_identity(*values: Any) -> str | None:
    raw_parts = [str(v).strip() for v in values if str(v).strip()]
    if not raw_parts:
        return None

    normalized = "".join(_norm_key(part) for part in raw_parts)
    if not normalized:
        return None

    # Cross-wing hallways/bridges should take precedence over single-wing inference.
    if (
        "wingatob" in normalized
        or "hallwaywingatob" in normalized
        or re.search(r"bridgehall\d+ab", normalized)
    ):
        return "A-B"
    if (
        "wingbtoc" in normalized
        or "hallwaywingbtoc" in normalized
        or re.search(r"bridgehall\d+bc", normalized)
    ):
        return "B-C"

    if "winga" in normalized:
        return "A"
    if "wingb" in normalized:
        return "B"
    if "wingc" in normalized:
        return "C"

    raw_blob = " ".join(raw_parts).lower()
    if re.search(r"(?:^|[\s\-_])a\d{1,3}(?:$|[\s\-_])", raw_blob):
        return "A"
    if re.search(r"(?:^|[\s\-_])b\d{1,3}(?:$|[\s\-_])", raw_blob):
        return "B"
    if re.search(r"(?:^|[\s\-_])c\d{1,3}(?:$|[\s\-_])", raw_blob):
        return "C"
    return None


def _resolve_space_wing(
    *,
    kind: str,
    bucket_wing: str,
    explicit_wing: Any,
    entry_id: str,
    entry_name: str,
) -> str:
    inferred = _infer_wing_from_identity(entry_id, entry_name, explicit_wing)
    if inferred:
        return inferred

    if kind == "main-entrance":
        return "A"

    explicit = str(explicit_wing or "").strip().upper()
    if explicit:
        return explicit
    return bucket_wing


def _is_routing_hallway_id(raw_id: str) -> bool:
    lowered = str(raw_id or "").strip().lower()
    if not lowered:
        return False
    canonical = _canonical_hallway_id(lowered)
    return (
        canonical.startswith("hallway_wing_")
        or canonical.startswith("vertical_hallway_")
        or canonical.startswith("bridge_hall_")
    )


def _bridge_connection_kind(entry_id: Any, entry_name: Any) -> str | None:
    inferred = _infer_wing_from_identity(entry_id, entry_name)
    if inferred in {"A-B", "B-C"}:
        return inferred

    normalized = _norm_key(f"{entry_id} {entry_name}")
    if re.search(r"bridgea\d+to", normalized):
        return "A-B"
    if re.search(r"bridgeb\d+toc\d+", normalized):
        return "B-C"
    return None


def _collect_layout_spaces() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        layout = load_map_layout()
    except Exception:
        return [], {}

    floors = layout.get("floors", {})
    if not isinstance(floors, dict):
        return [], layout

    spaces: list[dict[str, Any]] = []

    def append_entry(floor: int, wing: str, entry: dict[str, Any]) -> None:
        kind = str(entry.get("type", "")).strip().lower()
        if kind in {"lobby", "lounge"}:
            kind = "room"
        if kind in {"hallway", "routing_hallway"}:
            kind = "hallway"
        if kind == "entrance":
            kind = "main-entrance"
        if kind not in {"room", "stairs", "hallway", "main-entrance", "bridge"}:
            return
        entry_id = str(entry.get("id", "")).strip()
        entry_name = str(entry.get("name", "")).strip()
        if kind == "hallway":
            entry_id = _canonical_hallway_id(entry_id)
            if entry_name:
                entry_name = _canonical_hallway_id(entry_name)
            else:
                entry_name = entry_id
            if not _is_routing_hallway_id(entry_id):
                return
        elif kind == "stairs":
            entry_id = _canonical_stair_id(entry_id)
            if not entry_name:
                entry_name = entry_id

        resolved_wing = _resolve_space_wing(
            kind=kind,
            bucket_wing=wing,
            explicit_wing=entry.get("wing"),
            entry_id=entry_id,
            entry_name=entry_name,
        )

        spaces.append(
            {
                "floor": floor,
                "wing": resolved_wing,
                "type": kind,
                "id": entry_id,
                "name": entry_name,
                "x": entry.get("x"),
                "y": entry.get("y"),
                "width": entry.get("width"),
                "height": entry.get("height"),
                "cx": entry.get("cx"),
                "cy": entry.get("cy"),
                "passable": bool(entry.get("passable", False)),
            }
        )

    for floor_key, floor_data in floors.items():
        try:
            floor = int(floor_key)
        except (TypeError, ValueError):
            continue
        if not isinstance(floor_data, dict):
            continue
        wings = floor_data.get("wings", {})
        if not isinstance(wings, dict):
            continue
        routing_hallways = floor_data.get("routingHallways", [])
        has_explicit_routing_hallways = isinstance(routing_hallways, list) and any(
            isinstance(entry, dict) for entry in routing_hallways
        )
        for wing_key, entries in wings.items():
            wing = str(wing_key or "").upper()
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if has_explicit_routing_hallways:
                    kind = str(entry.get("type", "")).strip().lower()
                    if kind in {"hallway", "routing_hallway"}:
                        continue
                append_entry(floor, wing, entry)

        # Optional routing-only hallways block per floor; hidden from UI layers.
        if isinstance(routing_hallways, list):
            for entry in routing_hallways:
                if not isinstance(entry, dict):
                    continue
                wing = str(entry.get("wing", "")).upper()
                append_entry(floor, wing, entry)

        bridges = floor_data.get("bridges", {})
        if isinstance(bridges, dict):
            bridge_entries = bridges.values()
        elif isinstance(bridges, list):
            bridge_entries = bridges
        else:
            bridge_entries = []
        for entry in bridge_entries:
            if not isinstance(entry, dict):
                continue
            append_entry(floor, "", entry)

        floor_svg = floor_data.get("svg")
        if isinstance(floor_svg, str):
            for entry in extract_svg_floor_entities(floor_svg, floor=floor):
                if not isinstance(entry, dict):
                    continue
                append_entry(floor, "", entry)
    return spaces, layout


def _find_layout_match(
    node: Node,
    spaces: list[dict[str, Any]],
    target_type: str,
) -> dict[str, Any] | None:
    candidates = [
        space
        for space in spaces
        if space["type"] == target_type and space["floor"] == node.floor
    ]
    if not candidates:
        return None

    target_keys = _expanded_keys(node.id) | _expanded_keys(node.name)
    if not target_keys:
        return None
    target_id_keys = _expanded_keys(node.id)

    preferred = candidates
    if node.wing:
        same_wing = [space for space in candidates if space["wing"] == node.wing]
        if same_wing:
            preferred = same_wing + [space for space in candidates if space["wing"] != node.wing]

    if target_id_keys:
        for space in preferred:
            space_id_keys = _expanded_keys(space["id"])
            if target_id_keys & space_id_keys:
                return space

    for space in preferred:
        space_keys = _expanded_keys(space["id"]) | _expanded_keys(space["name"])
        if target_keys & space_keys:
            return space
    return None


def _to_float_or_default(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _layout_spaces_for_type(target_type: str) -> list[dict[str, Any]]:
    spaces, _ = _collect_layout_spaces()
    return [space for space in spaces if space.get("type") == target_type]


_STAIR_ID_ALIAS = {
    "stairs1wingb1f": "stairs1_Wing_B_1F",
    "stairs2wingb1f": "stairs2_Wing_B_1F",
    "stairs1wingb2f": "stairs1_Wing_B_2F",
    "stairs2wingb2f": "stairs2_Wing_B_2F",
    "stairs1wingb3f": "stairs1_Wing_B_3F",
    "stairs2wingb3f": "stairs2_Wing_B_3F",
    "stairs1wingc1f": "stairs1_Wing_C_1F",
    "stairs2wingc1f": "stairs2_Wing_C_1F",
    "stairs1wingc2f": "stairs1_Wing_C_2F",
    "stairs2wingc2f": "stairs2_Wing_C_2F",
    "stairs1wingc3f": "stairs1_Wing_C_3F",
    "stairs2wingc3f": "stairs2_Wing_C_3F",
}


def _canonical_stair_id(raw_id: str) -> str:
    key = _norm_key(raw_id)
    return _STAIR_ID_ALIAS.get(key, raw_id)


HALLWAY_ID_RENAMES = {
    "hall_1_3": "hallway_wing_a_1_1",
    "hall_1_6": "vertical_hallway_1_1",
    "hall_2_3": "hallway_wing_a_2_1",
    "hall_2_0": "vertical_hallway_2_1",
    "hall_3_3": "hallway_wing_a_3_1",
    "hall_3_0": "vertical_hallway_3_1",
    "hall_b_1_4": "hallway_wing_b_1_2",
    "hall_b_2_4": "hallway_wing_b_2_2",
    "hall_b_3_4": "hallway_wing_b_3_2",
    "hall_c_1_3": "hallway_wing_c_1_3",
    "hall_c_2_2": "hallway_wing_c_2_3",
    "hall_c_3_3": "hallway_wing_c_3_3",
}

ALWAYS_INCLUDE_LAYOUT_ROOM_IDS = {
    "room-1773161780420",
    "mens-cr-2-3f-wingb",
}


def _canonical_hallway_id(raw_id: str) -> str:
    return HALLWAY_ID_RENAMES.get(raw_id, raw_id)


def _apply_layout_overrides(nodes: list[Node], target_type: str) -> None:
    spaces, _ = _collect_layout_spaces()
    if not spaces:
        return

    for node in nodes:
        if node.metadata is None:
            node.metadata = {}
        node.metadata["layout_matched"] = False
        match = _find_layout_match(node, spaces, target_type)
        if not match:
            continue
        node.metadata["layout_matched"] = True
        node.x = _to_float_or_default(match.get("x"), node.x)
        node.y = _to_float_or_default(match.get("y"), node.y)
        match_wing = str(match.get("wing") or "").strip().upper()
        if match_wing:
            node.wing = match_wing
            node.metadata["wing"] = match_wing
        if match.get("width") is not None:
            node.width = _to_float_or_default(match.get("width"), node.width or 0.0)
        if match.get("height") is not None:
            node.height = _to_float_or_default(match.get("height"), node.height or 0.0)
        node.metadata["passable"] = bool(match.get("passable", False))


def _apply_main_entrance_from_layout(nodes: list[Node]) -> None:
    spaces, layout = _collect_layout_spaces()
    if not spaces and not layout:
        return

    entrance_x = None
    entrance_y = None

    main_entrance = layout.get("mainEntrance", {}) if isinstance(layout, dict) else {}
    if isinstance(main_entrance, dict):
        entrance_x = main_entrance.get("x")
        entrance_y = main_entrance.get("y")

    if entrance_x is None or entrance_y is None:
        for space in spaces:
            if space.get("type") == "main-entrance":
                entrance_x = space.get("x")
                entrance_y = space.get("y")
                break

    if entrance_x is None or entrance_y is None:
        return

    for node in nodes:
        if node.id == "main entrance":
            node.x = _to_float_or_default(entrance_x, node.x)
            node.y = _to_float_or_default(entrance_y, node.y)
            return


def _align_main_entrance_wing_to_nearest_hallway(nodes: list[Node]) -> None:
    entrance = next((node for node in nodes if node.id == "main entrance"), None)
    if not entrance:
        return
    if entrance.wing:
        # Preserve the explicit entrance wing assignment from defaults/layout data.
        return

    candidates = [
        node for node in nodes
        if (
            node.type == "hallway"
            and node.id != "main entrance"
            and node.floor == entrance.floor
            and node.wing
            and node.wing not in {"A-B", "B-C"}
            and not node.id.startswith("bridge_hall_")
            and not node.id.startswith("landing_")
        )
    ]
    if not candidates:
        return

    nearest = min(
        candidates,
        key=lambda node: math.hypot(node.x - entrance.x, node.y - entrance.y),
    )
    entrance.wing = nearest.wing
    if entrance.metadata is None:
        entrance.metadata = {}
    entrance.metadata["wing"] = nearest.wing


def _bridge_center(bridge: dict[str, Any]) -> tuple[float, float] | None:
    x = bridge.get("x")
    y = bridge.get("y")
    width = bridge.get("width")
    height = bridge.get("height")
    if x is not None and y is not None and width is not None and height is not None:
        return (
            _to_float_or_default(x, 0.0) + (_to_float_or_default(width, 0.0) / 2.0),
            _to_float_or_default(y, 0.0) + (_to_float_or_default(height, 0.0) / 2.0),
        )

    cx = bridge.get("cx")
    cy = bridge.get("cy")
    if cx is None or cy is None:
        return None
    return (_to_float_or_default(cx, 0.0), _to_float_or_default(cy, 0.0))


def _apply_bridge_centerline_alignment(nodes: list[Node]) -> None:
    bridge_spaces = _layout_spaces_for_type("bridge")
    if not bridge_spaces:
        return

    node_by_id = {node.id: node for node in nodes}
    bc_c_hall_by_floor = {
        1: "hallway_wing_c_1_3",
        2: "hallway_wing_c_2_3",
        3: "hallway_wing_c_3_3",
    }

    for floor in (1, 2, 3):
        floor_bridges = [
            bridge
            for bridge in bridge_spaces
            if int(bridge.get("floor", -1)) == floor
        ]

        bc_bridge = next(
            (
                bridge for bridge in floor_bridges
                if _bridge_connection_kind(bridge.get("id"), bridge.get("name")) == "B-C"
            ),
            None,
        )
        center = _bridge_center(bc_bridge) if isinstance(bc_bridge, dict) else None
        if center:
            cx, cy = center
            bc_bridge_node = node_by_id.get(f"bridge_hall_{floor}_bc")
            if bc_bridge_node:
                bc_bridge_node.x = cx
                bc_bridge_node.y = cy

            for connector_id in (
                _canonical_hallway_id(f"hall_b_{floor}_4"),
                bc_c_hall_by_floor.get(floor),
            ):
                if not connector_id:
                    continue
                connector = node_by_id.get(connector_id)
                if connector and not (
                    bool((connector.metadata or {}).get("layout_matched"))
                    and connector.width is not None
                    and connector.height is not None
                ):
                    connector.x = cx

        if floor != 1:
            continue

        ab_bridge = next(
            (
                bridge for bridge in floor_bridges
                if _bridge_connection_kind(bridge.get("id"), bridge.get("name")) == "A-B"
            ),
            None,
        )
        center = _bridge_center(ab_bridge) if isinstance(ab_bridge, dict) else None
        if not center:
            continue
        cx, cy = center
        ab_bridge_node = node_by_id.get("bridge_hall_1_ab")
        if ab_bridge_node:
            ab_bridge_node.x = cx
            ab_bridge_node.y = cy

        for connector_id in ("vertical_hallway_1_1", "hall_b_1_curve_1", "hall_b_1_curve_2"):
            connector = node_by_id.get(connector_id)
            if connector and not (
                bool((connector.metadata or {}).get("layout_matched"))
                and connector.width is not None
                and connector.height is not None
            ):
                connector.x = cx


_LEGACY_ROUTING_HALLWAY_TEMPLATES = [
    # A <-> B bridge (1F only)
    {"id": "bridge_hall_1_ab", "name": "Bridge Hallway 1F A-B", "x": 845.0, "y": 260.0, "floor": 1, "wing": "A-B"},
    # B <-> C bridges (all floors)
    {"id": "bridge_hall_1_bc", "name": "Bridge Hallway 1F B-C", "x": 845.0, "y": -80.0, "floor": 1, "wing": "B-C"},
    {"id": "bridge_hall_2_bc", "name": "Bridge Hallway 2F B-C", "x": 845.0, "y": -80.0, "floor": 2, "wing": "B-C"},
    {"id": "bridge_hall_3_bc", "name": "Bridge Hallway 3F B-C", "x": 845.0, "y": -80.0, "floor": 3, "wing": "B-C"},
    # Wing B 1F
    {"id": "hall_b_1_0", "name": "hall_b_1_0", "x": 20.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_1", "name": "hall_b_1_1", "x": 250.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_2", "name": "hall_b_1_2", "x": 450.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_3", "name": "hall_b_1_3", "x": 650.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_turn", "name": "hall_b_1_turn", "x": 690.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_curve_1", "name": "hall_b_1_curve_1", "x": 845.0, "y": 260.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_curve_2", "name": "hall_b_1_curve_2", "x": 845.0, "y": 190.0, "floor": 1, "wing": "B"},
    {"id": "hallway_wing_b_1_2", "name": "hallway_wing_b_1_2", "x": 845.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_5", "name": "hall_b_1_5", "x": 930.0, "y": 125.0, "floor": 1, "wing": "B"},
    {"id": "hall_b_1_aud", "name": "hall_b_1_aud", "x": 980.0, "y": 125.0, "floor": 1, "wing": "B"},
    # Wing B 2F
    {"id": "hall_b_2_0", "name": "hall_b_2_0", "x": 20.0, "y": 125.0, "floor": 2, "wing": "B"},
    {"id": "hall_b_2_1", "name": "hall_b_2_1", "x": 250.0, "y": 125.0, "floor": 2, "wing": "B"},
    {"id": "hall_b_2_2", "name": "hall_b_2_2", "x": 450.0, "y": 125.0, "floor": 2, "wing": "B"},
    {"id": "hall_b_2_3", "name": "hall_b_2_3", "x": 650.0, "y": 125.0, "floor": 2, "wing": "B"},
    {"id": "hallway_wing_b_2_2", "name": "hallway_wing_b_2_2", "x": 870.0, "y": 125.0, "floor": 2, "wing": "B"},
    # Wing B 3F
    {"id": "hall_b_3_0", "name": "hall_b_3_0", "x": 20.0, "y": 125.0, "floor": 3, "wing": "B"},
    {"id": "hall_b_3_1", "name": "hall_b_3_1", "x": 250.0, "y": 125.0, "floor": 3, "wing": "B"},
    {"id": "hall_b_3_2", "name": "hall_b_3_2", "x": 450.0, "y": 125.0, "floor": 3, "wing": "B"},
    {"id": "hall_b_3_3", "name": "hall_b_3_3", "x": 650.0, "y": 125.0, "floor": 3, "wing": "B"},
    {"id": "hallway_wing_b_3_2", "name": "hallway_wing_b_3_2", "x": 870.0, "y": 125.0, "floor": 3, "wing": "B"},
    # Wing C 1F
    {"id": "hall_c_1_0", "name": "hall_c_1_0", "x": 435.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_1", "name": "hall_c_1_1", "x": 565.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_2", "name": "hall_c_1_2", "x": 695.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hallway_wing_c_1_3", "name": "hallway_wing_c_1_3", "x": 845.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_4", "name": "hall_c_1_4", "x": 1035.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_5", "name": "hall_c_1_5", "x": 1245.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_6", "name": "hall_c_1_6", "x": 1450.0, "y": -185.0, "floor": 1, "wing": "C"},
    {"id": "hall_c_1_7", "name": "hall_c_1_7", "x": 1575.0, "y": -185.0, "floor": 1, "wing": "C"},
    # Wing C 2F
    {"id": "hall_c_2_0", "name": "hall_c_2_0", "x": 400.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hall_c_2_1", "name": "hall_c_2_1", "x": 590.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hall_c_2_turn", "name": "hall_c_2_turn", "x": 845.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hallway_wing_c_2_3", "name": "hallway_wing_c_2_3", "x": 845.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hall_c_2_3", "name": "hall_c_2_3", "x": 1110.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hall_c_2_4", "name": "hall_c_2_4", "x": 1395.0, "y": -185.0, "floor": 2, "wing": "C"},
    {"id": "hall_c_2_5", "name": "hall_c_2_5", "x": 1550.0, "y": -185.0, "floor": 2, "wing": "C"},
    # Wing C 3F
    {"id": "hall_c_3_0", "name": "hall_c_3_0", "x": 435.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hall_c_3_1", "name": "hall_c_3_1", "x": 565.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hall_c_3_2", "name": "hall_c_3_2", "x": 695.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hallway_wing_c_3_3", "name": "hallway_wing_c_3_3", "x": 845.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hall_c_3_4", "name": "hall_c_3_4", "x": 1110.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hall_c_3_5", "name": "hall_c_3_5", "x": 1350.0, "y": -185.0, "floor": 3, "wing": "C"},
    {"id": "hall_c_3_6", "name": "hall_c_3_6", "x": 1530.0, "y": -185.0, "floor": 3, "wing": "C"},
]


def _wing_b_layout_stair_points() -> dict[int, dict[str, tuple[float, float]]]:
    out: dict[int, dict[str, tuple[float, float]]] = {}
    for stair in _layout_spaces_for_type("stairs"):
        wing = str(stair.get("wing", "")).upper()
        if wing != "B":
            continue
        canonical_id = _canonical_stair_id(str(stair.get("id", "")))
        match = re.match(r"stairs([12])_Wing_B_([123])F$", canonical_id)
        if not match:
            continue
        stair_key = f"stairs{match.group(1)}"
        floor = int(match.group(2))
        out.setdefault(floor, {})[stair_key] = (
            _to_float_or_default(stair.get("x"), 0.0),
            _to_float_or_default(stair.get("y"), 0.0),
        )
    return out


def _legacy_to_layout_xy_transform_for_floor(
    floor: int,
    stair_points: dict[int, dict[str, tuple[float, float]]],
) -> tuple[float, float, float, float]:
    # Defaults match the current normalized map transform used by map_layout.json.
    fallback = (-1.0, 1670.0, -1.0, 480.0)
    points = stair_points.get(floor, {})
    stairs1 = points.get("stairs1")
    stairs2 = points.get("stairs2")
    if not stairs1 or not stairs2:
        return fallback

    old_s1x, old_s1y = 870.0, 20.0
    old_s2x, old_s2y = 20.0, 150.0
    denom_x = old_s1x - old_s2x
    denom_y = old_s1y - old_s2y
    if not denom_x or not denom_y:
        return fallback

    ax = (stairs1[0] - stairs2[0]) / denom_x
    bx = stairs1[0] - (ax * old_s1x)
    ay = (stairs1[1] - stairs2[1]) / denom_y
    by = stairs1[1] - (ay * old_s1y)
    return (ax, bx, ay, by)


def _layout_corridor_centerline_y(spaces: list[dict[str, Any]], wing: str, floor: int) -> float | None:
    row_groups: dict[float, list[float]] = {}
    for space in spaces:
        if space.get("type") != "room":
            continue
        if int(space.get("floor", -1)) != floor:
            continue
        if str(space.get("wing", "")).upper() != wing.upper():
            continue
        if bool(space.get("passable", False)):
            continue
        y = _to_float_or_default(space.get("y"), float("nan"))
        h = _to_float_or_default(space.get("height"), STD_ROOM_HEIGHT)
        if not math.isfinite(y):
            continue
        row_groups.setdefault(y, []).append(h)

    if len(row_groups) < 2:
        return None

    # Pick the two densest rows as corridor boundaries.
    dominant_rows = sorted(row_groups.items(), key=lambda kv: len(kv[1]), reverse=True)[:2]
    row_ys = sorted([dominant_rows[0][0], dominant_rows[1][0]])
    upper_row_y, lower_row_y = row_ys[0], row_ys[1]
    upper_heights = row_groups.get(upper_row_y, [STD_ROOM_HEIGHT])
    upper_row_h = sum(upper_heights) / max(len(upper_heights), 1)

    gap_start = upper_row_y + upper_row_h
    if lower_row_y > gap_start:
        return gap_start + ((lower_row_y - gap_start) / 2.0)

    # If rows overlap due inconsistent input, keep a conservative offset.
    return upper_row_y + upper_row_h + 25.0


def _fallback_routing_hallways(existing_ids: set[str]) -> list[dict[str, Any]]:
    spaces, _ = _collect_layout_spaces()
    stair_points = _wing_b_layout_stair_points()
    corridor_by_wing_floor = {
        ("B", floor): _layout_corridor_centerline_y(spaces, "B", floor)
        for floor in (1, 2, 3)
    }
    corridor_by_wing_floor.update(
        {
            ("C", floor): _layout_corridor_centerline_y(spaces, "C", floor)
            for floor in (1, 2, 3)
        }
    )

    bridge_center_by_key: dict[str, tuple[float, float]] = {}
    for bridge in _layout_spaces_for_type("bridge"):
        try:
            floor = int(bridge.get("floor", -1))
        except (TypeError, ValueError):
            continue
        connection_kind = _bridge_connection_kind(bridge.get("id"), bridge.get("name"))
        if connection_kind == "A-B":
            suffix = "ab"
        elif connection_kind == "B-C":
            suffix = "bc"
        else:
            continue
        center = _bridge_center(bridge)
        if center:
            bridge_center_by_key[f"{floor}_{suffix}"] = center

    out: list[dict[str, Any]] = []
    for template in _LEGACY_ROUTING_HALLWAY_TEMPLATES:
        hallway_id = template["id"]
        if hallway_id in existing_ids:
            continue
        floor = int(template["floor"])
        ax, bx, ay, by = _legacy_to_layout_xy_transform_for_floor(floor, stair_points)
        x = (float(template["x"]) * ax) + bx
        y = (float(template["y"]) * ay) + by
        wing = str(template.get("wing", "")).upper()

        corridor_y = corridor_by_wing_floor.get((wing, floor))
        if wing == "B" and corridor_y is not None:
            y = corridor_y
            if hallway_id == "hall_b_1_curve_1":
                ab_center = bridge_center_by_key.get("1_ab")
                if ab_center:
                    y = ab_center[1]
            elif hallway_id == "hall_b_1_curve_2":
                ab_center = bridge_center_by_key.get("1_ab")
                if ab_center:
                    y = ab_center[1] + ((corridor_y - ab_center[1]) * 0.5)
        elif wing == "C" and corridor_y is not None:
            y = corridor_y

        if hallway_id.startswith("bridge_hall_"):
            suffix = "ab" if hallway_id.endswith("_ab") else "bc"
            bridge_center = bridge_center_by_key.get(f"{floor}_{suffix}")
            if bridge_center:
                x, y = bridge_center

        out.append(
            {
                "id": hallway_id,
                "name": template["name"],
                "x": x,
                "y": y,
                "floor": floor,
                "wing": template["wing"],
                "passable": True,
            }
        )
    return out


def create_hallway_nodes() -> List[Node]:
    nodes = []
    # 1F - Wing A
    nodes.append(Node(
        id="main entrance",
        x=875,
        y=575,
        floor=1,
        wing="A",
        name="Main Entrance",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_0",
        x=820,
        y=-125,
        floor=1,
        wing="A",        
        name="hall_1_0",
        type="hallway",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="hall_1_turn_right",
        x=795,
        y=-125,
        floor=1,
        wing="A",
        name="hall_1_turn_right",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_turn",
        x=970,
        y=-125,
        floor=1,
        wing="A",
        name="hall_1_turn",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_1",
        x=1650,
        y=-125,
        floor=1,
        wing="A",
        name="hall_1_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_2",
        x=535,
        y=-125,
        floor=1,
        wing="A",
        name="hall_1_2",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hallway_wing_a_1_1",
        x=1220,
        y=-125,
        floor=1,
        wing="A",
        name="hallway_wing_a_1_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_4",
        x=1370,
        y=-125,
        floor=1,
        wing="A",    
        name="hall_1_4",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_1_5",
        x=1470,
        y=-125,
        floor=1,
        wing="A",
        name="hall_1_5",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="vertical_hallway_1_1",
        x=825,
        y=-125,
        floor=1,
        wing="A",
        name="vertical_hallway_1_1",
        type="hallway",
        metadata={"wing": "A"}
    ))

    # 2F - Wing A 
    nodes.append(Node(
        id="vertical_hallway_2_1",
        x=820,
        y=-125,
        floor=2,
        wing="A",
        name="vertical_hallway_2_1",
        type="hallway",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="hall_2_1",
        x=1650,
        y=-125,
        floor=2,
        wing="A",
        name="hall_2_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_2_2",
        x=535,
        y=-125,
        floor=2,
        wing="A",
        name="hall_2_2",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hallway_wing_a_2_1",
        x=1220,
        y=-125,
        floor=2,
        wing="A",
        name="hallway_wing_a_2_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_2_4",
        x=1370,
        y=-125,
        floor=2,
        wing="A",
        name="hall_2_4",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_2_5",
        x=1470,
        y=-125,
        floor=2,
        wing="A",
        name="hall_2_5",
        type="hallway",
        metadata={"wing": "A"}
    ))
    
    # 3F - Wing A 
    nodes.append(Node(
        id="vertical_hallway_3_1",
        x=820,
        y=-125,
        floor=3,
        wing="A",
        name="vertical_hallway_3_1",
        type="hallway",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="hall_3_1",
        x=1650,
        y=-125,
        floor=3,
        wing="A",
        name="hall_3_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_3_2",
        x=535,
        y=-125,
        floor=3,
        wing="A",
        name="hall_3_2",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hallway_wing_a_3_1",
        x=1220,
        y=-125,
        floor=3,
        wing="A",
        name="hallway_wing_a_3_1",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_3_4",
        x=1370,
        y=-125,
        floor=3,
        wing="A",
        name="hall_3_4",
        type="hallway",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="hall_3_5",
        x=1470,
        y=-125,
        floor=3,
        wing="A",
        name="hall_3_5",
        type="hallway",
        metadata={"wing": "A"}
    ))
    # Remaining hallways (Wing B/C + bridge hallways) come from layout routingHallways.
    existing_ids = {node.id for node in nodes}
    for hallway in _layout_spaces_for_type("hallway"):
        hallway_id = _canonical_hallway_id(str(hallway.get("id", "")).strip())
        if not hallway_id or hallway_id in existing_ids:
            continue
        wing = str(hallway.get("wing", "")).upper()
        if hallway_id.startswith("bridge_hall_"):
            if hallway_id.endswith("_ab"):
                wing = "A-B"
            elif hallway_id.endswith("_bc"):
                wing = "B-C"
            else:
                wing = "bridge"
        if not wing:
            wing = "A"
        nodes.append(Node(
            id=hallway_id,
            x=_to_float_or_default(hallway.get("x"), 0.0),
            y=_to_float_or_default(hallway.get("y"), 0.0),
            width=_to_float_or_default(hallway.get("width"), 0.0),
            height=_to_float_or_default(hallway.get("height"), 0.0),
            floor=int(hallway.get("floor", 1)),
            wing=wing,
            name=str(hallway.get("name") or hallway_id),
            type="hallway",
            metadata={"wing": wing, "layout_matched": True, "passable": bool(hallway.get("passable", True))}
        ))
        existing_ids.add(hallway_id)

    # Backward-compatible fallback: synthesize routing hallways when layout routingHallways are missing.
    for hallway in _fallback_routing_hallways(existing_ids):
        hallway_id = str(hallway.get("id", "")).strip()
        if not hallway_id or hallway_id in existing_ids:
            continue
        wing = str(hallway.get("wing", "")).upper() or "A"
        fallback_width = hallway.get("width")
        fallback_height = hallway.get("height")
        nodes.append(Node(
            id=hallway_id,
            x=_to_float_or_default(hallway.get("x"), 0.0),
            y=_to_float_or_default(hallway.get("y"), 0.0),
            width=_to_float_or_default(fallback_width, 0.0) if fallback_width is not None else None,
            height=_to_float_or_default(fallback_height, 0.0) if fallback_height is not None else None,
            floor=int(hallway.get("floor", 1)),
            wing=wing,
            name=str(hallway.get("name") or hallway_id),
            type="hallway",
            metadata={"wing": wing, "layout_fallback": True, "passable": True}
        ))
        existing_ids.add(hallway_id)

    _apply_layout_overrides(nodes, "hallway")
    _apply_main_entrance_from_layout(nodes)

    # Align legacy Wing A hallway guide nodes to the live hallway geometry.
    # Prefer the actual hallway rectangle edge when available so legacy point
    # nodes stay on the rendered corridor line instead of an inferred room-gap center.
    spaces = _layout_spaces_for_type("room")
    wing_a_centerline_by_floor = {
        floor: _layout_corridor_centerline_y(spaces, "A", floor)
        for floor in (1, 2, 3)
    }
    wing_a_hallway_y_by_floor: dict[int, float] = {}
    for node in nodes:
        if (
            node.type == "hallway"
            and node.wing == "A"
            and node.id.startswith("hallway_wing_a_")
            and bool((node.metadata or {}).get("layout_matched"))
            and node.width is not None
            and node.height is not None
        ):
            wing_a_hallway_y_by_floor.setdefault(node.floor, node.y + node.height)
    for node in nodes:
        if node.type != "hallway" or node.wing != "A":
            continue
        if node.id == "main entrance":
            continue
        if not (node.id.startswith("hall_") or node.id.startswith("hallway_wing_a_")):
            continue
        if bool((node.metadata or {}).get("layout_matched")):
            continue
        target_y = wing_a_hallway_y_by_floor.get(node.floor)
        if target_y is None:
            target_y = wing_a_centerline_by_floor.get(node.floor)
        if target_y is None:
            continue
        node.y = target_y

    _apply_bridge_centerline_alignment(nodes)
    _align_main_entrance_wing_to_nearest_hallway(nodes)

    # Backward compatibility: preserve legacy hallway IDs as aliases of the
    # current canonical routing nodes so older route graphs and tests still
    # build against the same physical anchors.
    node_by_id = {node.id: node for node in nodes}
    existing_ids = set(node_by_id)
    for legacy_id, canonical_id in HALLWAY_ID_RENAMES.items():
        if legacy_id in existing_ids:
            continue
        canonical = node_by_id.get(canonical_id)
        if not canonical:
            continue
        alias_metadata = dict(canonical.metadata or {})
        alias_metadata["legacy_alias_for"] = canonical_id
        alias_x = canonical.x
        alias_y = canonical.y
        if canonical.width is not None and canonical.height is not None:
            if canonical.width >= canonical.height:
                alias_y = canonical.y + canonical.height
        nodes.append(Node(
            id=legacy_id,
            x=alias_x,
            y=alias_y,
            width=None,
            height=None,
            floor=canonical.floor,
            wing=canonical.wing,
            name=legacy_id,
            type=canonical.type,
            metadata=alias_metadata,
        ))
        existing_ids.add(legacy_id)
    return nodes

def create_room_nodes() -> List[Node]:
    nodes = []
    # 1F - Wing A - Front row
    nodes.append(Node(
        id="Extension Meeting Room A101",
        x=1035,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=1,
        wing="A",
        name="Extension Meeting Room A101",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Classroom and Semninar Room A105",
        x=930,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=1,
        wing="A",
        name="Classroom and Semninar Room A105",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Physical Chem Lab A113",
        x=720,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=1,
        wing="A",
        name="Physical Chem Lab A113",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Teaching Lab (Analytical) A125",
        x=390,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Teaching Lab (Analytical) A125",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Teaching Lab (Organic) A131",
        x=235,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Teaching Lab (Organic) A131",
        type="room",
        metadata={"wing": "A"}
    ))    
    nodes.append(Node(
        id="Spectograph and X-Ray Lab A137",
        x=80,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Spectograph and X-Ray Lab A137",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Office A141",
        x=20,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Office A141",
        type="room",
        metadata={"wing": "A"}
    ))        

    # 1F - Wing A - Back row
    nodes.append(Node(
        id="Museum and Display Room A104",
        x=1010,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Museum and Display Room A104",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Office Extension A108",
        x=930,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Office Extension A108",
        type="room",
        metadata={"wing": "A"}
    ))    
    nodes.append(Node(
        id="Men's CR A114",
        x=765,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Men's CR A114",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Women's CR A116",
        x=705,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Women's CR A116",
        type="room",
        metadata={"wing": "A"}
    ))     
    nodes.append(Node(
        id="Balance Room A118",
        x=600,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Balance Room A118",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Office Lab A122",
        x=520,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Office Lab A122",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Instructor's Room A126",
        x=390,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Instructor's Room A126",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Fine Machanics A132",
        x=330,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Fine Machanics A132",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Scientific Glassblowing Room A132",
        x=225,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Scientific Glassblowing Room A132",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Glass Blowing A136",
        x=165,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Glass Blowing A136",
        type="room",
        metadata={"wing": "A"}
    ))
    nodes.append(Node(
        id="Mi Meo A140 / Office A138",
        x=85,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=1,
        wing="A",
        name="Office Lab A122",
        type="room",
        metadata={"wing": "A"}
    ))                    


    # 2F - Wing A - Back row
    nodes.append(Node(
        id="Head A202 / Document A204",
        x=1035,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Head A202 / Document A204",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Clerical A206",
        x=930,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Clerical A206",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Men's CR A214",
        x=765,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Men's CR A214",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Women's CR A216",
        x=705,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Women's CR A216",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office Lab A218",
        x=600,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Office Lab A218",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Chromatography A222",
        x=540,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Chromatography A222",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Balance Room A240",
        x=410,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Balance Room A240",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Instrument Room A230",
        x=280,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Instrument Room A230",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Classroom A236",
        x=150,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Classroom A236",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office A240",
        x=90,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=2,
        wing="A",
        name="Office A240",
        type="room",
        metadata={"wing": "A"}
    ))    

    # 2F - Wing A - Front row
    nodes.append(Node(
        id="Library - Conference A201",
        x=930,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Library - Conference A201",
        type="room",
        metadata={"wing": "A"}
    ))  
    nodes.append(Node(
        id="Classrom A213",
        x=720,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Classrom A213",
        type="room",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="Classroom A217",
        x=615,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Classroom A217",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Classroom A221",
        x=510,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Classroom A221",
        type="room",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="Advance Analytical Lab A234",
        x=405,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Advance Analytical Lab A234",
        type="room",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="Bio Chem Lab 1 A231",
        x=275,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Bio Chem Lab 1 A231",
        type="room",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="Bio Chem Lab 2 A237",
        x=145,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Bio Chem Lab 2 A237",
        type="room",
        metadata={"wing": "A"}
    ))   
    nodes.append(Node(
        id="Cold Room / Pre-fab Walk-in Cold Box A241",
        x=40,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=2,
        wing="A",
        name="Cold Room / Pre-fab Walk-in Cold Box A241",
        type="room",
        metadata={"wing": "A"}
    ))   


    # 3F - Wing A - Back row
    nodes.append(Node(
        id="Office Lab A302",
        x=1070,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office Lab A302",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office A304",
        x=990,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office A304",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Radio Chem Storage A308",
        x=930,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Radio Chem Storage A308",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Men's CR A314",
        x=765,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Men's CR A314",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Women's CR A316",
        x=705,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Women's CR A316",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office A318",
        x=645,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office A318",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office Lab A320",
        x=565,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office Lab A320",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Chromatography A322",
        x=505,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Chromatography A322",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office Lab A330",
        x=445,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office Lab A330",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Solvent Extraction Room A330",
        x=385,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Solvent Extraction Room A330",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="kjeldahl A330",
        x=325,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="kjeldahl A330",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office Lab A332",
        x=265,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office Lab A332",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Cages Animal Room A336",
        x=205,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Cages Animal Room A336",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Cage Wash & Feed Storage A338",
        x=145,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Cage Wash & Feed Storage A338",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Office Room A340",
        x=85,
        y=330,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,
        floor=3,
        wing="A",
        name="Office Room A340",
        type="room",
        metadata={"wing": "A"}
    ))   

    # 3F - Wing A - Front row
    nodes.append(Node(
        id="Photo Chem Lab A301",
        x=1095,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Photo Chem Lab A301",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Counting Room A303",
        x=1035,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Counting Room A303",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Isotopes Lab A305",
        x=930,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Isotopes Lab A305",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Adv Physical Chem Laboratory A315",
        x=695,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Adv Physical Chem Laboratory A315",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Balance Room A319",
        x=635,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Balance Room A319",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Instrument Room A321",
        x=575,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Instrument Room A321",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Advanced Organic Laboratory A325",
        x=445,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Advanced Organic Laboratory A325",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Infrared Research A329",
        x=340,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Infrared Research A329",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="50/60% RH A333",
        x=280,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="50/60% RH A333",
        type="room",
        metadata={"wing": "A"}
    )) 
    nodes.append(Node(
        id="Analytical Services A337",
        x=25,
        y=460,
        width=STD_ROOM_WIDTH,
        height=STD_ROOM_HEIGHT,      
        floor=3,
        wing="A",
        name="Analytical Services A337",
        type="room",
        metadata={"wing": "A"}
    )) 
                                                       
    # Wing A/B/C rooms are sourced from map_layout wing spaces.
    # We still keep legacy named rooms when they can be matched to layout,
    # so existing aliases remain routable.
    existing_ids = {node.id for node in nodes}
    existing_room_keys = set()
    for node in nodes:
        existing_room_keys |= (_expanded_keys(node.id) | _expanded_keys(node.name))
    for room in _layout_spaces_for_type("room"):
        wing = str(room.get("wing", "")).upper()
        if wing not in {"A", "B", "C"}:
            continue
        if bool(room.get("passable", False)):
            continue
        room_id = str(room.get("id", "")).strip()
        if not room_id or room_id in existing_ids:
            continue
        room_name = str(room.get("name") or room_id)
        room_keys = _expanded_keys(room_id) | _expanded_keys(room_name)
        # Avoid duplicate room nodes for the same physical room (legacy vs layout IDs).
        if room_keys & existing_room_keys and room_id not in ALWAYS_INCLUDE_LAYOUT_ROOM_IDS:
            continue
        nodes.append(Node(
            id=room_id,
            x=_to_float_or_default(room.get("x"), 0.0),
            y=_to_float_or_default(room.get("y"), 0.0),
            width=_to_float_or_default(room.get("width"), STD_ROOM_WIDTH),
            height=_to_float_or_default(room.get("height"), STD_ROOM_HEIGHT),
            floor=int(room.get("floor", 1)),
            wing=wing,
            name=room_name,
            type="room",
            metadata={"wing": wing, "layout_matched": True, "passable": bool(room.get("passable", False))}
        ))
        existing_ids.add(room_id)
        existing_room_keys |= room_keys

    _apply_layout_overrides(nodes, "room")
    # When a layout is present, drop legacy room entries that do not map to it.
    if any((node.metadata or {}).get("layout_matched") for node in nodes):
        nodes = [node for node in nodes if (node.metadata or {}).get("layout_matched") is not False]
    return nodes



def create_stair_nodes():
    nodes = []

    # Same X/Y position on BOTH floors
    nodes.append(Node(
        id="stairs1_Wing_A_1F",
        x=870,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=1,
        wing="A",
        name="stairs1_Wing_A_1F",
        type="stairs"
    ))
    nodes.append(Node(
        id="stairs2_Wing_A_1F",
        x=20,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=1,
        wing="A",
        name="stairs2_Wing_A_1F",
        type="stairs"
    ))  

    nodes.append(Node(
        id="stairs1_Wing_A_2F",
        x=870,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=2,
        wing="A",
        name="stairs1_Wing_A_2F",
        type="stairs"
    ))
    nodes.append(Node(
        id="stairs2_Wing_A_2F",
        x=20,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=2,
        wing="A",
        name="stairs2_Wing_A_2F",
        type="stairs"
    ))

    nodes.append(Node(
        id="stairs1_Wing_A_3F",
        x=870,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=3,
        wing="A",
        name="stairs1_Wing_A_3F",
        type="stairs"
    ))
    nodes.append(Node(
        id="stairs2_Wing_A_3F",
        x=20,
        y=330,
        width=STAIRS_WIDTH,
        height=STAIRS_HEIGHT,
        floor=3,
        wing="A",
        name="stairs2_Wing_A_3F",
        type="stairs"
    ))

    # Wing B/C stairs are sourced from map_layout, canonicalized for routing IDs.
    existing_ids = {node.id for node in nodes}
    for stair in _layout_spaces_for_type("stairs"):
        wing = str(stair.get("wing", "")).upper()
        if wing not in {"B", "C"}:
            continue
        raw_id = str(stair.get("id", "")).strip()
        if not raw_id:
            continue
        stair_id = _canonical_stair_id(raw_id)
        if stair_id in existing_ids:
            continue
        nodes.append(Node(
            id=stair_id,
            x=_to_float_or_default(stair.get("x"), 0.0),
            y=_to_float_or_default(stair.get("y"), 0.0),
            width=_to_float_or_default(stair.get("width"), STAIRS_WIDTH),
            height=_to_float_or_default(stair.get("height"), STAIRS_HEIGHT),
            floor=int(stair.get("floor", 1)),
            wing=wing,
            name=stair_id,
            type="stairs",
            metadata={"wing": wing, "layout_matched": True, "passable": bool(stair.get("passable", True))}
        ))

    _apply_layout_overrides(nodes, "stairs")
    return nodes


def connect_room_to_hallway_nodes(graph, room_id, hallway_nodes, preferred_hallway_id=None):
    room = graph.nodes[room_id]

    # Room center
    cx = room.x + room.width / 2
    cy = room.y + room.height / 2

    # -------------------------------------------------
    # Find BEST hallway segment (not node)
    # -------------------------------------------------
    best_dist = float("inf")
    best_point = None
    best_edge = None
    best_t = None

    hallway_set = {
        hid for hid in hallway_nodes
        if hid in graph.nodes
        and graph.nodes[hid].type == "hallway"
        and graph.nodes[hid].floor == room.floor
        and hid != "main entrance"
        and not hid.startswith("landing_")
        and not hid.startswith("door_")
    }

    # Prefer segments in the same wing so Wing B rooms don't attach to Wing A corridors.
    preferred_hallway_set = hallway_set
    if room.wing:
        same_wing = {hid for hid in hallway_set if graph.nodes[hid].wing == room.wing}
        if same_wing:
            preferred_hallway_set = same_wing

    def hallway_boundary_point(hallway_id):
        hallway = graph.nodes.get(hallway_id)
        if not hallway:
            return None
        if hallway.type != "hallway" or hallway.floor != room.floor:
            return None
        if hallway.width is None or hallway.height is None:
            return None

        left = hallway.x
        right = hallway.x + hallway.width
        top = hallway.y
        bottom = hallway.y + hallway.height
        hallway_cx = hallway.x + hallway.width / 2
        hallway_cy = hallway.y + hallway.height / 2

        if hallway.width >= hallway.height:
            px = min(max(cx, left), right)
            py = top if cy <= hallway_cy else bottom
        else:
            px = left if cx <= hallway_cx else right
            py = min(max(cy, top), bottom)
        return px, py

    def segment_crosses_other_rooms(x1, y1, x2, y2, excluded_room_ids=None):
        excluded_room_ids = excluded_room_ids or set()
        for node in graph.nodes.values():
            if node.type != "room":
                continue
            if (node.metadata or {}).get("layout_matched") is False:
                continue
            if bool((node.metadata or {}).get("passable")):
                continue
            if node.floor != room.floor:
                continue
            if node.id in excluded_room_ids:
                continue
            if not node.width or not node.height:
                continue
            try:
                if line_intersects_rect(
                    x1,
                    y1,
                    x2,
                    y2,
                    node.x,
                    node.y,
                    node.width,
                    node.height,
                ):
                    return True
            except Exception:
                continue
        return False

    def door_on_room_wall(target_x, target_y):
        dx = target_x - cx
        dy = target_y - cy
        if abs(dx) > abs(dy):
            return (
                room.x + room.width if dx > 0 else room.x,
                cy,
            )
        return (
            cx,
            room.y + room.height if dy > 0 else room.y,
        )

    def find_best_segment(candidate_hallways):
        local_best_dist = float("inf")
        local_best_point = None
        local_best_edge = None
        local_best_t = None

        for a_id, b_id in graph.edges:
            if a_id not in candidate_hallways or b_id not in candidate_hallways:
                continue

            a = graph.nodes[a_id]
            b = graph.nodes[b_id]

            if a.floor != room.floor or b.floor != room.floor:
                continue

            if a.type != "hallway" or b.type != "hallway":
                continue

            # Project center onto segment AB
            ax, ay = a.x, a.y
            bx, by = b.x, b.y

            abx = bx - ax
            aby = by - ay
            ab_len2 = abx * abx + aby * aby

            if ab_len2 == 0:
                continue

            t = ((cx - ax) * abx + (cy - ay) * aby) / ab_len2
            t = max(0, min(1, t))

            px = ax + t * abx
            py = ay + t * aby

            dist = math.hypot(cx - px, cy - py)

            if dist < local_best_dist:
                local_best_dist = dist
                local_best_point = (px, py)
                local_best_edge = (a_id, b_id)
                local_best_t = t

        return local_best_dist, local_best_point, local_best_edge, local_best_t

    def find_best_direct_hallway(candidate_hallways):
        direct_candidates = []
        for hallway_id in candidate_hallways:
            hallway = graph.nodes.get(hallway_id)
            if not hallway or hallway.type != "hallway":
                continue
            if hallway.floor != room.floor:
                continue
            if not hallway.width or not hallway.height:
                continue
            boundary_point = hallway_boundary_point(hallway_id)
            if boundary_point is None:
                continue
            distance = math.hypot(cx - boundary_point[0], cy - boundary_point[1])
            direct_candidates.append((distance, hallway_id, boundary_point))

        if not direct_candidates:
            return None, None

        direct_candidates.sort(key=lambda item: item[0])
        _, hallway_id, boundary_point = direct_candidates[0]
        return hallway_id, boundary_point

    direct_hallway_id = None
    if preferred_hallway_id in hallway_set:
        preferred_point = hallway_boundary_point(preferred_hallway_id)
        if preferred_point is not None:
            best_point = preferred_point
            direct_hallway_id = preferred_hallway_id

    if best_point is None:
        direct_hallway_id, direct_point = find_best_direct_hallway(preferred_hallway_set)
        if direct_point is None and preferred_hallway_set is not hallway_set:
            direct_hallway_id, direct_point = find_best_direct_hallway(hallway_set)
        if direct_point is not None:
            best_point = direct_point

    if best_point is None:
        best_dist, best_point, best_edge, best_t = find_best_segment(preferred_hallway_set)
        if best_edge is None and preferred_hallway_set is not hallway_set:
            best_dist, best_point, best_edge, best_t = find_best_segment(hallway_set)

    if best_point is None:
        return

    if direct_hallway_id:
        hallway = graph.nodes[direct_hallway_id]
        snap_eps = 1e-9
        if (
            abs(best_point[0] - hallway.x) <= snap_eps
            and abs(best_point[1] - hallway.y) <= snap_eps
        ):
            junction_id = direct_hallway_id
        else:
            junction_id = f"junction_{room_id}"
            graph.add_node(Node(
                id=junction_id,
                x=best_point[0],
                y=best_point[1],
                floor=room.floor,
                wing=room.wing,
                name="Hallway Junction",
                type="hallway",
                metadata={"wing": room.wing} if room.wing else {}
            ))
            graph.add_edge(direct_hallway_id, junction_id)
            graph.add_edge(junction_id, direct_hallway_id)
    else:
        a_id, b_id = best_edge
        snap_eps = 1e-9
        if best_t is not None and best_t <= snap_eps:
            # Projection lands on endpoint A; reuse existing hallway node.
            junction_id = a_id
        elif best_t is not None and best_t >= 1.0 - snap_eps:
            # Projection lands on endpoint B; reuse existing hallway node.
            junction_id = b_id
        else:
            # -------------------------------------------------
            # Create hallway junction node
            # -------------------------------------------------
            junction_id = f"junction_{room_id}"

            junction = Node(
                id=junction_id,
                x=best_point[0],
                y=best_point[1],
                floor=room.floor,
                wing=room.wing,
                name="Hallway Junction",
                type="hallway",
                metadata={"wing": room.wing} if room.wing else {}
            )

            graph.add_node(junction)

            # Split the hallway segment so paths follow the corridor
            graph.remove_edge(a_id, b_id)

            graph.add_edge(a_id, junction_id)
            graph.add_edge(junction_id, a_id)

            graph.add_edge(b_id, junction_id)
            graph.add_edge(junction_id, b_id)

    # -------------------------------------------------
    # Create doorway on room wall
    # -------------------------------------------------
    door_x, door_y = door_on_room_wall(best_point[0], best_point[1])

    door_id = f"door_{room_id}"

    door = Node(
        id=door_id,
        x=door_x,
        y=door_y,
        floor=room.floor,
        wing=room.wing,
        name="Door",
        type="door",
        metadata={"wing": room.wing} if room.wing else {}
    )

    graph.add_node(door)

    def create_or_reuse_waypoint(base_id, x, y):
        waypoint_id = f"{base_id}_{round(x, 2)}_{round(y, 2)}"
        existing = graph.nodes.get(waypoint_id)
        if existing:
            return waypoint_id
        waypoint = Node(
            id=waypoint_id,
            x=x,
            y=y,
            floor=room.floor,
            wing=room.wing,
            name="Routing Bypass",
            type="hallway",
            metadata={"wing": room.wing} if room.wing else {}
        )
        graph.add_node(waypoint)
        return waypoint_id

    def doorway_to_target_path(target_x, target_y):
        # Prefer direct attachment.
        if not segment_crosses_other_rooms(
            door_x,
            door_y,
            target_x,
            target_y,
            excluded_room_ids={room_id},
        ):
            return []

        same_floor_rooms = [
            n for n in graph.nodes.values()
            if n.type == "room" and n.floor == room.floor and n.width and n.height
        ]
        if not same_floor_rooms:
            return None

        min_x = min(n.x for n in same_floor_rooms)
        max_x = max(n.x + n.width for n in same_floor_rooms)
        min_y = min(n.y for n in same_floor_rooms)
        max_y = max(n.y + n.height for n in same_floor_rooms)
        margin = 40.0

        candidates = []
        x_outside_values = [min_x - margin, max_x + margin]
        for x_out in x_outside_values:
            p1 = (x_out, door_y)
            p2 = (x_out, target_y)
            segments = [
                (door_x, door_y, p1[0], p1[1]),
                (p1[0], p1[1], p2[0], p2[1]),
                (p2[0], p2[1], target_x, target_y),
            ]
            if any(
                segment_crosses_other_rooms(x1, y1, x2, y2, excluded_room_ids={room_id})
                for x1, y1, x2, y2 in segments
            ):
                continue
            total = sum(math.hypot(x2 - x1, y2 - y1) for x1, y1, x2, y2 in segments)
            candidates.append((total, [p1, p2]))

        y_outside_values = [min_y - margin, max_y + margin]
        for y_out in y_outside_values:
            p1 = (door_x, y_out)
            p2 = (target_x, y_out)
            segments = [
                (door_x, door_y, p1[0], p1[1]),
                (p1[0], p1[1], p2[0], p2[1]),
                (p2[0], p2[1], target_x, target_y),
            ]
            if any(
                segment_crosses_other_rooms(x1, y1, x2, y2, excluded_room_ids={room_id})
                for x1, y1, x2, y2 in segments
            ):
                continue
            total = sum(math.hypot(x2 - x1, y2 - y1) for x1, y1, x2, y2 in segments)
            candidates.append((total, [p1, p2]))

        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]

    # -------------------------------------------------
    # Connect graph properly
    # -------------------------------------------------
    graph.add_edge(room_id, door_id)
    graph.add_edge(door_id, room_id)

    target = graph.nodes[junction_id]
    bypass_points = doorway_to_target_path(target.x, target.y)
    if bypass_points is None:
        # Keep room reachable even when layout is highly inconsistent.
        graph.add_edge(door_id, junction_id)
        graph.add_edge(junction_id, door_id)
        return

    if not bypass_points:
        graph.add_edge(door_id, junction_id)
        graph.add_edge(junction_id, door_id)
        return

    prev_id = door_id
    for idx, (wx, wy) in enumerate(bypass_points):
        waypoint_id = create_or_reuse_waypoint(f"bypass_{room_id}_{idx+1}", wx, wy)
        graph.add_edge(prev_id, waypoint_id)
        graph.add_edge(waypoint_id, prev_id)
        prev_id = waypoint_id

    graph.add_edge(prev_id, junction_id)
    graph.add_edge(junction_id, prev_id)


def line_intersects_rect(x1, y1, x2, y2, room_x, room_y, room_width, room_height):
    line = LineString([(x1, y1), (x2, y2)])
    rect = box(room_x, room_y, room_x + room_width, room_y + room_height)
    return line.intersects(rect) and not line.touches(rect)

