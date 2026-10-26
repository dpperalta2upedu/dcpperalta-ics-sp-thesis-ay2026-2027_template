import math

from services.navigation_graph import NavigationGraph
from services.building_config import (
    create_hallway_nodes,
    create_room_nodes,
    create_stair_nodes,
    connect_room_to_hallway_nodes,
    line_intersects_rect,
)
from services.routing_topology import WING_B_ROUTING_EDGES
from services.routing_topology import WING_C_ROUTING_EDGES
from services.routing_topology import BRIDGE_ROUTING_EDGES

WING_A_ROUTING_EDGES = [
    ("hall_1_1", "hall_1_5"),
    ("hall_1_5", "hall_1_4"),
    ("hall_1_4", "hall_1_3"),
    ("hall_1_3", "hall_1_0"),
    ("hall_1_0", "hall_1_2"),
    ("hall_2_1", "hall_2_5"),
    ("hall_2_5", "hall_2_4"),
    ("hall_2_4", "hall_2_3"),
    ("hall_2_3", "hall_2_0"),
    ("hall_2_0", "hall_2_2"),
    ("hall_3_1", "hall_3_5"),
    ("hall_3_5", "hall_3_4"),
    ("hall_3_4", "hall_3_3"),
    ("hall_3_3", "hall_3_0"),
    ("hall_3_0", "hall_3_2"),
]


def build_graph():
    g = NavigationGraph()
    hallway_nodes = create_hallway_nodes()
    room_nodes = create_room_nodes()
    stair_nodes = create_stair_nodes()

    for n in hallway_nodes + room_nodes + stair_nodes:
        g.add_node(n)

    def nodes_exist(a, b):
        return a in g.nodes and b in g.nodes

    def add_edge_if_clear(a, b, force: bool = False):
        if not nodes_exist(a, b):
            return False
        if force:
            g.add_edge(a, b)
            return True
        a_node = g.nodes[a]
        b_node = g.nodes[b]
        blocked = False
        for room in room_nodes:
            # Only block against rooms on the same floor as the edge.
            if room.floor != a_node.floor or room.floor != b_node.floor:
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
                    if a != room.id and b != room.id:
                        blocked = True
                        break
            except Exception:
                pass
        if not blocked:
            g.add_edge(a, b)
            return True
        return False

    def hallway_attach_priority(anchor_id: str, hallway_id: str) -> tuple[int, float]:
        anchor = g.nodes[anchor_id]
        hallway = g.nodes[hallway_id]
        anchor_wing = effective_wing(anchor_id)
        hallway_wing = effective_wing(hallway_id)

        if hallway_wing == anchor_wing:
            wing_priority = 0
        elif hallway_wing == "A-B":
            wing_priority = 1
        else:
            wing_priority = 2

        dist = math.hypot(hallway.x - anchor.x, hallway.y - anchor.y)
        return (wing_priority, dist)

    def effective_wing(node_id: str) -> str | None:
        node = g.nodes[node_id]
        if node.wing:
            return node.wing
        lowered = node_id.lower()
        if "wing_a" in lowered:
            return "A"
        if "wing_b" in lowered:
            return "B"
        return None

    def stair_compatible_hallway(anchor_id: str, hallway_id: str) -> bool:
        anchor_wing = effective_wing(anchor_id)
        hallway_wing = effective_wing(hallway_id)
        # Keep stair attachment within the same wing; allow bridge hallways.
        return hallway_wing == anchor_wing or hallway_wing == "A-B"

    def connect_hallway_backbone():
        y_tolerance = 8
        for floor, groups in g.floors.items():
            hallway_ids = groups.get("hallway", [])
            floor_hallway_nodes = [g.nodes[h] for h in hallway_ids]

            y_groups = []
            for node in floor_hallway_nodes:
                placed = False
                for gr in y_groups:
                    if abs(node.y - gr["y"]) <= y_tolerance:
                        gr["nodes"].append(node)
                        placed = True
                        break
                if not placed:
                    y_groups.append({"y": node.y, "nodes": [node]})

            for gr in y_groups:
                nodes_sorted = sorted(gr["nodes"], key=lambda n: n.x)
                for i in range(len(nodes_sorted) - 1):
                    left = nodes_sorted[i]
                    right = nodes_sorted[i + 1]
                    if left.wing != right.wing and "A-B" not in (left.wing, right.wing):
                        continue
                    add_edge_if_clear(left.id, right.id)

    # Hallway backbone (auto)
    connect_hallway_backbone()

    # Wing B explicit hallway/stair routing edges
    for a_id, b_id in WING_B_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in WING_C_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in BRIDGE_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in WING_A_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)

    # Main entrance to nearest hallway
    entrance_id = "main entrance"
    if entrance_id in g.nodes:
        entrance = g.nodes[entrance_id]
        hallway_ids = [
            h for h in g.floors[entrance.floor].get("hallway", [])
            if h != entrance_id
        ]
        if hallway_ids:
            nearest_first = sorted(
                hallway_ids,
                key=lambda hid: hallway_attach_priority(entrance_id, hid),
            )
            for hid in nearest_first:
                if add_edge_if_clear(entrance_id, hid):
                    break

    # Stairs to nearest hallway
    for floor, groups in g.floors.items():
        hallway_ids = groups.get("hallway", [])
        stair_ids = groups.get("stairs", [])
        for stair_id in stair_ids:
            if not hallway_ids:
                continue
            compatible = [hid for hid in hallway_ids if stair_compatible_hallway(stair_id, hid)]
            if not compatible:
                continue
            stair = g.nodes[stair_id]
            nearest_first = sorted(
                compatible,
                key=lambda hid: hallway_attach_priority(stair_id, hid),
            )
            for hid in nearest_first:
                if add_edge_if_clear(stair_id, hid):
                    break

    # Connect rooms to hallways
    for floor, groups in g.floors.items():
        hallways = groups.get('hallway', [])
        rooms = groups.get('room', [])
        for room_id in rooms:
            room_node = g.nodes[room_id]
            corridor_hallways = [
                hid for hid in hallways
                if hid != "main entrance" and g.nodes[hid].wing != "A-B"
            ]
            candidate_hallways = [
                hid for hid in corridor_hallways
                if g.nodes[hid].wing == room_node.wing
            ]
            if not candidate_hallways:
                candidate_hallways = corridor_hallways
            connect_room_to_hallway_nodes(g, room_id, candidate_hallways)
            connect_hallway_backbone()
            for a_id, b_id in WING_B_ROUTING_EDGES:
                add_edge_if_clear(a_id, b_id, force=True)
            for a_id, b_id in WING_C_ROUTING_EDGES:
                add_edge_if_clear(a_id, b_id, force=True)
            for a_id, b_id in BRIDGE_ROUTING_EDGES:
                add_edge_if_clear(a_id, b_id, force=True)
            for a_id, b_id in WING_A_ROUTING_EDGES:
                add_edge_if_clear(a_id, b_id, force=True)

    # Re-apply explicit bridge/backbone edges after room-junction insertion.
    connect_hallway_backbone()
    for a_id, b_id in WING_B_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in WING_C_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in BRIDGE_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)
    for a_id, b_id in WING_A_ROUTING_EDGES:
        add_edge_if_clear(a_id, b_id, force=True)

    # Connect stairs vertically by prefix
    def stair_group_key(stair_id: str):
        if '_' in stair_id:
            return stair_id.rsplit('_', 1)[0]
        return stair_id

    stairs_by_key = {}
    for floor, groups in g.floors.items():
        for sid in groups.get('stairs', []):
            stairs_by_key.setdefault(stair_group_key(sid), []).append(sid)

    for stair_list in stairs_by_key.values():
        stair_list_sorted = sorted(stair_list, key=lambda s: g.nodes[s].floor)
        for i in range(len(stair_list_sorted) - 1):
            g.add_edge(stair_list_sorted[i], stair_list_sorted[i + 1])

    landing_by_stair_id = {}
    for floor, groups in g.floors.items():
        for stair_id in groups.get("stairs", []):
            landing_id = f"landing_{stair_id}"
            if landing_id not in g.nodes:
                stair = g.nodes[stair_id]
                landing_x, landing_y = stair.center
                g.add_node(type(stair)(
                    id=landing_id,
                    x=landing_x,
                    y=landing_y,
                    floor=stair.floor,
                    wing=stair.wing,
                    name="Stair Landing",
                    type="hallway",
                ))
            landing_by_stair_id[stair_id] = landing_id
            g.add_edge(stair_id, landing_id)

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

    for stair_id, landing_id in landing_by_stair_id.items():
        landing = g.nodes[landing_id]
        for nb_id in list(g.get_neighbors(landing_id)):
            nb = g.nodes[nb_id]
            if nb.type != "hallway":
                continue
            if nb_id.startswith("landing_"):
                continue
            if nb.floor != landing.floor:
                continue
            g.remove_edge(landing_id, nb_id)

    for landing_id in landing_by_stair_id.values():
        owner_stair = landing_owner_stair(landing_id)
        owner_wing = wing_from_node_id(owner_stair or "")
        for nb_id in list(g.get_neighbors(landing_id)):
            if nb_id.startswith("landing_"):
                nb_owner_stair = landing_owner_stair(nb_id)
                nb_wing = wing_from_node_id(nb_owner_stair or "")
                if owner_wing and nb_wing and owner_wing != nb_wing:
                    g.remove_edge(landing_id, nb_id)
                continue
            if "stairs" in nb_id.lower():
                nb_wing = wing_from_node_id(nb_id)
                if owner_wing and nb_wing and owner_wing != nb_wing:
                    g.remove_edge(landing_id, nb_id)

    return g


def test_route_1f_to_3f_uses_adjacent_stairs():
    g = build_graph()
    start = "Physical Chem Lab A113"
    goal = "Isotopes Lab A305"

    path, _ = g.a_star_pathfinding(start, goal)
    assert path, "Expected a valid path"

    # Ensure the stairs path does not jump 1F->3F directly
    if "stairs1_Wing_A_1F" in path or "stairs2_Wing_A_1F" in path:
        for i in range(len(path) - 1):
            a = g.nodes[path[i]]
            b = g.nodes[path[i + 1]]
            if a.type == 'stairs' and b.type == 'stairs':
                assert abs(a.floor - b.floor) == 1, f"Stairs jumped floors: {a.id} -> {b.id}"


def test_cross_wing_same_floor_route_exists_and_uses_bridge():
    g = build_graph()
    path, _ = g.a_star_pathfinding("Basic Chem Lab 1 B207", "Library - Conference A201")
    assert path, "Expected a valid cross-wing route"
    assert "bridge_hall_1_ab" in path, "Cross-wing route should pass through the bridge"


def test_main_entrance_to_prep_room_b120_uses_ab_bridge():
    g = build_graph()
    path, _ = g.a_star_pathfinding("main entrance", "Prep Room B120")
    assert path, "Expected a valid route from Main Entrance to Prep Room B120"
    assert "bridge_hall_1_ab" in path, f"Expected route to pass through Wing A-B bridge: {path}"


def test_main_entrance_to_auditorium_b2f_passes_vertical_hall_centers():
    g = build_graph()
    path, _ = g.a_star_pathfinding("main entrance", "Auditorium B2F")
    assert path, "Expected a valid route from Main Entrance to Auditorium B2F"
    assert "bridge_hall_1_ab" in path, f"Expected route to pass through Wing A-B bridge: {path}"
    assert "hall_1_6" in path, f"Expected Wing A vertical hallway center in path: {path}"
    assert "hall_b_1_curve_1" in path, f"Expected route to pass over the top of Bridge Hallway: {path}"
    floors = {g.nodes[n].floor for n in path}
    assert floors == {1}, f"Expected same-floor path on 1F: {path}"


def test_auditorium_b1f_to_balance_room_a118_uses_ab_bridge():
    g = build_graph()
    path, _ = g.a_star_pathfinding("Auditorium B1F", "Balance Room A118")
    assert path, "Expected a valid route from Auditorium B1F to Balance Room A118"
    assert "bridge_hall_1_ab" in path, f"Expected route to pass through Wing A-B bridge: {path}"
    floors = {g.nodes[n].floor for n in path}
    assert floors == {1}, f"Expected same-floor path on 1F: {path}"


def test_same_floor_route_has_no_unnecessary_floor_changes():
    g = build_graph()
    pairs = [
        ("main entrance", "Extension Meeting Room A101"),
        ("Basic Chem Lab 1 B107", "Auditorium B1F"),
        ("Basic Chem Lab 1 B107", "Auditorium B2F"),
        ("Classroom A236", "Office A240"),
    ]
    for start, goal in pairs:
        path, _ = g.a_star_pathfinding(start, goal)
        assert path, f"Expected valid path for {start} -> {goal}"
        floors = [g.nodes[n].floor for n in path]
        assert len(set(floors)) == 1, f"Unexpected floor changes for {start} -> {goal}: {path}"


def test_cross_wing_path_distance_is_reasonable():
    g = build_graph()
    path, distance = g.a_star_pathfinding("Balance Room B214", "Balance Room A240")
    assert path, "Expected route between Wing B and Wing A"
    # Regression guard: this route should not explode due to detours.
    assert distance < 2200, f"Route looks too long: distance={distance}, path={path}"


def test_wing_c_route_exists_within_floor():
    g = build_graph()
    path, _ = g.a_star_pathfinding("classroom-c101", "ibm-room1-c")
    assert path, "Expected valid Wing C same-floor route"
    floors = {g.nodes[n].floor for n in path}
    assert floors == {1}, f"Unexpected floors in Wing C 1F route: {path}"


def test_wing_b_to_wing_c_route_uses_bc_bridge():
    g = build_graph()
    path, _ = g.a_star_pathfinding("Basic Chem Lab 1 B107", "classroom-c101")
    assert path, "Expected valid cross-wing route B -> C"
    assert any(n.startswith("bridge_hall_1_bc") for n in path), f"Missing B-C bridge in path: {path}"


def test_main_entrance_to_classroom_c103_uses_top_ab_bc_bridge_path():
    g = build_graph()
    path, _ = g.a_star_pathfinding("main entrance", "classroom-c103")
    assert path, "Expected valid cross-wing route Main Entrance -> Classroom C103"
    assert "hall_1_6" in path, f"Expected top Wing A bridge connector in path: {path}"
    assert "bridge_hall_1_ab" in path, f"Expected A-B bridge in path: {path}"
    assert "hall_b_1_curve_1" in path, f"Expected top Wing B bridge connector in path: {path}"
    assert "bridge_hall_1_bc" in path, f"Expected B-C bridge in path: {path}"
    floors = {g.nodes[n].floor for n in path}
    assert floors == {1}, f"Expected same-floor path on 1F: {path}"
