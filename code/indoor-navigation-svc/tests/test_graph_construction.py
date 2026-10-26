import pytest

from tests.test_routing import build_graph


@pytest.fixture()
def graph():
    return build_graph()


def test_rooms_have_doors_and_junctions(graph):
    room_ids = [n.id for n in graph.nodes.values() if n.type == 'room']
    assert room_ids

    for rid in room_ids:
        door_id = f"door_{rid}"
        junction_id = f"junction_{rid}"
        assert door_id in graph.nodes, f"Missing door for {rid}"

        # Room must connect to door.
        assert door_id in graph.adjacency[rid], f"Room not connected to door: {rid}"

        # Door should connect either to the room-specific junction or directly to a hallway
        # when the projection snapped to an existing hallway endpoint.
        door_neighbors = graph.adjacency[door_id]
        if junction_id in graph.nodes:
            assert junction_id in door_neighbors, f"Door not connected to junction: {rid}"
        else:
            hallway_neighbors = [nid for nid in door_neighbors if graph.nodes[nid].type == "hallway"]
            assert hallway_neighbors, f"Door not connected to hallway for {rid}"
