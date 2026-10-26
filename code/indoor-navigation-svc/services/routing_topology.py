"""Static routing topology (edges only, no coordinates)."""

WING_B_ROUTING_EDGES = [
    # 1F hallway spine + stair access
    ("hall_b_1_curve_1", "hall_b_1_curve_2"),
    ("hall_b_1_curve_2", "hallway_wing_b_1_2"),
    ("hall_b_1_0", "hall_b_1_1"),
    ("hall_b_1_1", "hall_b_1_2"),
    ("hall_b_1_2", "hall_b_1_3"),
    ("hall_b_1_3", "hall_b_1_turn"),
    ("hall_b_1_turn", "hallway_wing_b_1_2"),
    ("hallway_wing_b_1_2", "hall_b_1_5"),
    ("hall_b_1_5", "hall_b_1_aud"),
    ("stairs1_Wing_B_1F", "hallway_wing_b_1_2"),
    ("stairs2_Wing_B_1F", "hall_b_1_0"),
    # 2F hallway spine + stair access
    ("hall_b_2_0", "hall_b_2_1"),
    ("hall_b_2_1", "hall_b_2_2"),
    ("hall_b_2_2", "hall_b_2_3"),
    ("hall_b_2_3", "hallway_wing_b_2_2"),
    ("vertical_hallway_2_1", "hallway_wing_b_2_2"),
    ("vertical_hallway_2_1", "hallway_wing_b_2_4"),
    ("vertical_hallway_2_1", "hallway_wing_b_2_5"),
    ("vertical_hallway_2_3", "hallway_wing_b_2_4"),
    ("vertical_hallway_2_3", "hallway_wing_b_2_5"),
    ("stairs1_Wing_B_2F", "hallway_wing_b_2_2"),
    ("stairs2_Wing_B_2F", "hall_b_2_0"),
    # 3F hallway spine + stair access
    ("hall_b_3_0", "hall_b_3_1"),
    ("hall_b_3_1", "hall_b_3_2"),
    ("hall_b_3_2", "hall_b_3_3"),
    ("hall_b_3_3", "hallway_wing_b_3_2"),
    ("vertical_hallway_3_1", "hallway_wing_b_3_2"),
    ("vertical_hallway_3_1", "hallway_wing_a_3_4"),
    ("vertical_hallway_3_1", "hallway_wing_a_3_5"),
    ("vertical_hallway_3_3", "hallway_wing_a_3_4"),
    ("vertical_hallway_3_3", "hallway_wing_a_3_5"),
    ("stairs-3f-wingb", "vertical_hallway_3_3"),
    ("stairs1_Wing_B_3F", "hallway_wing_b_3_2"),
    ("stairs2_Wing_B_3F", "hall_b_3_0"),
]


WING_C_ROUTING_EDGES = [
    # 1F hallway spine + stair access
    ("hall_c_1_0", "hall_c_1_1"),
    ("hall_c_1_1", "hall_c_1_2"),
    ("hall_c_1_2", "hallway_wing_c_1_3"),
    ("hallway_wing_c_1_3", "hall_c_1_4"),
    ("hall_c_1_4", "hall_c_1_5"),
    ("hall_c_1_5", "hall_c_1_6"),
    ("hall_c_1_6", "hall_c_1_7"),
    ("stairs1_Wing_C_1F", "hall_c_1_7"),
    ("stairs2_Wing_C_1F", "hallway_wing_c_1_3"),
    # 2F hallway spine + stair access
    ("hall_c_2_0", "hall_c_2_1"),
    ("hall_c_2_1", "hallway_wing_c_2_3"),
    ("hallway_wing_c_2_3", "hall_c_2_3"),
    ("hall_c_2_3", "hall_c_2_4"),
    ("hall_c_2_4", "hall_c_2_5"),
    ("stairs1_Wing_C_2F", "hall_c_2_5"),
    ("stairs2_Wing_C_2F", "hall_c_2_turn"),
    ("hall_c_2_turn", "hallway_wing_c_2_3"),
    # 3F hallway spine + stair access
    ("hall_c_3_0", "hall_c_3_1"),
    ("hall_c_3_1", "hall_c_3_2"),
    ("hall_c_3_2", "hallway_wing_c_3_3"),
    ("hallway_wing_c_3_3", "hall_c_3_4"),
    ("hall_c_3_4", "hall_c_3_5"),
    ("hall_c_3_5", "hall_c_3_6"),
    ("stairs1_Wing_C_3F", "hall_c_3_6"),
    ("stairs2_Wing_C_3F", "hallway_wing_c_3_3"),
]


BRIDGE_ROUTING_EDGES = [
    # A <-> B bridge (1F)
    ("vertical_hallway_1_1", "bridge_hall_1_ab"),
    ("bridge_hall_1_ab", "hall_b_1_curve_1"),
    # B <-> C bridges by floor
    ("hallway_wing_b_1_2", "bridge_hall_1_bc"),
    ("bridge_hall_1_bc", "hallway_wing_c_1_3"),
    ("hallway_wing_b_2_2", "bridge_hall_2_bc"),
    ("bridge_hall_2_bc", "hallway_wing_c_2_3"),
    ("hallway_wing_b_3_2", "bridge_hall_3_bc"),
    ("bridge_hall_3_bc", "hallway_wing_c_3_3"),
]
