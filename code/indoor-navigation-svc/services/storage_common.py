from __future__ import annotations

from datetime import datetime
from typing import Any
import json


def serialize_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def deserialize_json(raw: str) -> dict[str, Any]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("JSON payload must be an object.")
    return payload


def dt_to_epoch_ms(value: datetime | None) -> float | None:
    if value is None:
        return None
    return value.timestamp() * 1000.0


def make_draft_filename(dt: datetime) -> str:
    return f"draft-{dt.strftime('%d-%b-%Y-%I-%M-%S-%p').lower()}.json"


def make_draft_map_display_name(dt: datetime) -> str:
    return f"Draft Map - {dt.strftime('%d-%b-%Y %I:%M:%S %p')}"


def make_map_layout_history_filename(dt: datetime) -> str:
    return f"map-layout-{dt.strftime('%d-%b-%Y-%I-%M-%S-%p').lower()}.json"


def default_current_map_layout_display_name() -> str:
    return "Current Main Layout"


def make_map_layout_history_display_name(dt: datetime) -> str:
    return f"Main Layout - {dt.strftime('%d-%b-%Y %I:%M:%S %p')}"
