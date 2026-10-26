from __future__ import annotations

from datetime import datetime
from typing import Any
import json

from services.main_map_layout_service import MainMapLayoutService
from sandbox.services.sb_navigation_graph_cache_service import NavigationGraphCacheService
from sandbox.services.sb_storage_common import default_current_map_layout_display_name
from sandbox.services.sb_storage_common import deserialize_json
from sandbox.services.sb_storage_common import make_map_layout_history_display_name
from sandbox.services.sb_storage_common import make_map_layout_history_filename
from sandbox.services.sb_storage_common import serialize_json


class SandboxMainMapLayoutService(MainMapLayoutService):
    IS_SANDBOX = True
    CACHE_SERVICE = NavigationGraphCacheService

    @classmethod
    def _normalize_current_layout_payload(cls, payload: dict[str, Any]) -> dict[str, Any]:
        next_payload = json.loads(json.dumps(payload))
        floors = next_payload.get("floors")
        if not isinstance(floors, dict):
            return next_payload

        empty_floor_template = {
            "wings": {"A": [], "B": [], "C": []},
            "bridges": {
                "AB": {"id": "bridge-ab", "name": "Bridge AB", "x": 0, "y": 0, "width": 1, "height": 1, "type": "bridge", "passable": True},
                "BC": {"id": "bridge-bc", "name": "Bridge BC", "x": 0, "y": 0, "width": 1, "height": 1, "type": "bridge", "passable": True},
            },
        }

        for floor_key in ("1", "2", "3"):
            floor_payload = floors.get(floor_key)
            if not isinstance(floor_payload, dict):
                floors[floor_key] = json.loads(json.dumps(empty_floor_template))
                continue

            wings = floor_payload.get("wings")
            if not isinstance(wings, dict):
                floor_payload["wings"] = {"A": [], "B": [], "C": []}
            else:
                for wing_key in ("A", "B", "C"):
                    wing_entries = wings.get(wing_key)
                    if not isinstance(wing_entries, list):
                        wings[wing_key] = []

            bridges = floor_payload.get("bridges")
            if not isinstance(bridges, dict):
                floor_payload["bridges"] = json.loads(json.dumps(empty_floor_template["bridges"]))
            else:
                for bridge_key, default_bridge in empty_floor_template["bridges"].items():
                    bridge_payload = bridges.get(bridge_key)
                    if not isinstance(bridge_payload, dict):
                        bridges[bridge_key] = json.loads(json.dumps(default_bridge))
        return next_payload

    @classmethod
    def create_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        return super().create_layout(
            cls._normalize_current_layout_payload(payload),
            source_draft_id=source_draft_id,
            display_name=display_name,
        )

    @classmethod
    def upsert_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        return super().upsert_layout(
            cls._normalize_current_layout_payload(payload),
            source_draft_id=source_draft_id,
            display_name=display_name,
        )

    @classmethod
    def publish_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        draft_filename: str | None = None,
        display_name: str | None = None,
        source_map_layout_id: int | None = None,
    ) -> dict[str, Any]:
        return super().publish_layout(
            cls._normalize_current_layout_payload(payload),
            source_draft_id=source_draft_id,
            draft_filename=draft_filename,
            display_name=display_name,
            source_map_layout_id=source_map_layout_id,
        )

    @classmethod
    def _deserialize_json(cls, raw: str) -> dict[str, Any]:
        return deserialize_json(raw)

    @classmethod
    def _serialize_json(cls, payload: dict[str, Any]) -> str:
        return serialize_json(payload)

    @classmethod
    def _default_current_display_name(cls) -> str:
        return default_current_map_layout_display_name()

    @classmethod
    def _current_filename(cls) -> str:
        return "sandbox_map_layout.json"

    @classmethod
    def _make_history_filename(cls, dt: datetime) -> str:
        return make_map_layout_history_filename(dt)

    @classmethod
    def _make_history_display_name(cls, dt: datetime) -> str:
        return make_map_layout_history_display_name(dt)

    @classmethod
    def get_current_layout(cls) -> dict[str, Any]:
        record = cls.get_current_record()
        if record is None:
            raise FileNotFoundError("Main map layout not found in the database.")
        return cls._normalize_current_layout_payload(record["payload"])
