from __future__ import annotations

from typing import Any

from utils.map_layout import extract_svg_floor_entities


_ROUTING_RELEVANT_TOKENS = (
    "room",
    "hallway",
    "routing_hallway",
    "stairs",
    "lounge",
    "lobby",
    "bridge",
    "entrance",
)


def _routing_entity_key(el: dict[str, Any], floor_id: str, index: int) -> str:
    entity_id = str(el.get("id", "")).strip()
    if entity_id:
        return entity_id.lower()
    label = str(el.get("name") or el.get("label") or el.get("value") or "").strip().lower()
    css = str(el.get("class", "")).strip().lower()
    kind = str(el.get("type", "")).strip().lower()
    return f"{floor_id}:{kind}:{css}:{label}:{index}"


def normalize_routing_entities(layout: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entities: dict[str, dict[str, Any]] = {}
    floors = layout.get("floors", [])

    if isinstance(floors, list):
        for floor_index, floor in enumerate(floors):
            if not isinstance(floor, dict):
                continue
            floor_id = str(floor.get("id", f"floor-{floor_index}")).strip().lower()
            elements = floor.get("elements", [])
            if not isinstance(elements, list):
                continue

            for el_index, el in enumerate(elements):
                if not isinstance(el, dict):
                    continue
                blob = " ".join(
                    str(el.get(k, "")).lower()
                    for k in ("id", "class", "name", "label", "value", "kind", "type")
                )
                if not any(token in blob for token in _ROUTING_RELEVANT_TOKENS):
                    continue

                key = _routing_entity_key(el, floor_id, el_index)
                entities[key] = {
                    "floor": floor_id,
                    "id": str(el.get("id", "")).strip().lower(),
                    "name": str(el.get("name", "")).strip().lower(),
                    "label": str(el.get("label", "")).strip().lower(),
                    "value": str(el.get("value", "")).strip().lower(),
                    "class": str(el.get("class", "")).strip().lower(),
                    "type": str(el.get("type", "")).strip().lower(),
                    "x": el.get("x"),
                    "y": el.get("y"),
                    "cx": el.get("cx"),
                    "cy": el.get("cy"),
                    "width": el.get("width"),
                    "height": el.get("height"),
                    "r": el.get("r"),
                    "d": el.get("d"),
                }
        return entities

    if not isinstance(floors, dict):
        return entities

    def dict_entity_key(
        entity: dict[str, Any],
        *,
        floor_id: str,
        section: str,
        index: int,
    ) -> str:
        entity_id = str(entity.get("id", "")).strip().lower()
        if entity_id:
            return f"{floor_id}:{section}:{entity_id}"
        label = str(entity.get("name") or entity.get("label") or entity.get("value") or "").strip().lower()
        entity_type = str(entity.get("type", "")).strip().lower()
        return f"{floor_id}:{section}:{entity_type}:{label}:{index}"

    for floor_key, floor_data in floors.items():
        if not isinstance(floor_data, dict):
            continue
        floor_id = str(floor_key).strip().lower()

        wings = floor_data.get("wings", {})
        if isinstance(wings, dict):
            for wing_key, entries in wings.items():
                if not isinstance(entries, list):
                    continue
                wing_id = str(wing_key).strip().lower()
                section = f"wing:{wing_id}"
                for index, entry in enumerate(entries):
                    if not isinstance(entry, dict):
                        continue
                    entry_type = str(entry.get("type", "")).strip().lower()
                    if entry_type in {"", "label"} or entry_type not in _ROUTING_RELEVANT_TOKENS:
                        continue
                    key = dict_entity_key(entry, floor_id=floor_id, section=section, index=index)
                    entities[key] = {
                        "schema": "v2",
                        "floor": floor_id,
                        "section": section,
                        "bucketWing": wing_id,
                        "wing": str(entry.get("wing", "")).strip().lower(),
                        "id": str(entry.get("id", "")).strip().lower(),
                        "name": str(entry.get("name", "")).strip().lower(),
                        "type": entry_type,
                        "x": entry.get("x"),
                        "y": entry.get("y"),
                        "width": entry.get("width"),
                        "height": entry.get("height"),
                        "passable": bool(entry.get("passable", False)),
                    }

        routing_hallways = floor_data.get("routingHallways", [])
        if isinstance(routing_hallways, list):
            section = "routingHallways"
            for index, entry in enumerate(routing_hallways):
                if not isinstance(entry, dict):
                    continue
                entry_type = str(entry.get("type", "hallway")).strip().lower()
                if entry_type == "routing_hallway":
                    entry_type = "hallway"
                if entry_type not in _ROUTING_RELEVANT_TOKENS:
                    continue
                key = dict_entity_key(entry, floor_id=floor_id, section=section, index=index)
                entities[key] = {
                    "schema": "v2",
                    "floor": floor_id,
                    "section": section,
                    "bucketWing": str(entry.get("wing", "")).strip().lower(),
                    "wing": str(entry.get("wing", "")).strip().lower(),
                    "id": str(entry.get("id", "")).strip().lower(),
                    "name": str(entry.get("name", "")).strip().lower(),
                    "type": entry_type,
                    "x": entry.get("x"),
                    "y": entry.get("y"),
                    "width": entry.get("width"),
                    "height": entry.get("height"),
                    "passable": bool(entry.get("passable", False)),
                }

        bridges = floor_data.get("bridges", {})
        if isinstance(bridges, dict):
            for bridge_key, bridge in bridges.items():
                if not isinstance(bridge, dict):
                    continue
                bridge_section = f"bridge:{str(bridge_key).strip().lower()}"
                key = dict_entity_key(bridge, floor_id=floor_id, section=bridge_section, index=0)
                entities[key] = {
                    "schema": "v2",
                    "floor": floor_id,
                    "section": bridge_section,
                    "id": str(bridge.get("id", "")).strip().lower(),
                    "name": str(bridge.get("name", "")).strip().lower(),
                    "type": str(bridge.get("type", "bridge")).strip().lower(),
                    "x": bridge.get("x"),
                    "y": bridge.get("y"),
                    "width": bridge.get("width"),
                    "height": bridge.get("height"),
                    "cx": bridge.get("cx"),
                    "cy": bridge.get("cy"),
                    "passable": bool(bridge.get("passable", False)),
                }

        floor_svg = floor_data.get("svg")
        if isinstance(floor_svg, str):
            for index, entry in enumerate(extract_svg_floor_entities(floor_svg)):
                if not isinstance(entry, dict):
                    continue
                entry_type = str(entry.get("type", "")).strip().lower()
                if entry_type in {"lounge", "lobby"}:
                    entry_type = "room"
                if entry_type not in _ROUTING_RELEVANT_TOKENS and entry_type != "bridge":
                    continue
                key = dict_entity_key(entry, floor_id=floor_id, section="svg", index=index)
                entities[key] = {
                    "schema": "svg",
                    "floor": floor_id,
                    "section": "svg",
                    "id": str(entry.get("id", "")).strip().lower(),
                    "name": str(entry.get("name", "")).strip().lower(),
                    "type": entry_type,
                    "x": entry.get("x"),
                    "y": entry.get("y"),
                    "width": entry.get("width"),
                    "height": entry.get("height"),
                    "cx": entry.get("cx"),
                    "cy": entry.get("cy"),
                    "passable": bool(entry.get("passable", False)),
                }

    main_entrance = layout.get("mainEntrance", {})
    if isinstance(main_entrance, dict):
        entities["root:mainentrance"] = {
            "schema": "v2",
            "id": "mainentrance",
            "type": "entrance",
            "x": main_entrance.get("x"),
            "y": main_entrance.get("y"),
        }

    return entities


def has_routing_entity_changes(previous_layout: dict[str, Any], next_layout: dict[str, Any]) -> bool:
    return normalize_routing_entities(previous_layout) != normalize_routing_entities(next_layout)
