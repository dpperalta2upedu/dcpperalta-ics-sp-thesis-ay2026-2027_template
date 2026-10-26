from __future__ import annotations

from datetime import datetime
from typing import Any

from services.draft_main_map_layout_service import DraftMainMapLayoutService
from sandbox.services.sb_navigation_graph_cache_service import NavigationGraphCacheService
from sandbox.services.sb_storage_common import deserialize_json
from sandbox.services.sb_storage_common import make_draft_map_display_name
from sandbox.services.sb_storage_common import make_draft_filename
from sandbox.services.sb_storage_common import serialize_json


class SandboxDraftMainMapLayoutService(DraftMainMapLayoutService):
    IS_SANDBOX = True
    CACHE_SERVICE = NavigationGraphCacheService
    DRAFT_LIMIT = 15

    @classmethod
    def _deserialize_json(cls, raw: str) -> dict[str, Any]:
        return deserialize_json(raw)

    @classmethod
    def _serialize_json(cls, payload: dict[str, Any]) -> str:
        return serialize_json(payload)

    @classmethod
    def _make_draft_filename(cls, dt: datetime) -> str:
        return make_draft_filename(dt)

    @classmethod
    def _make_draft_map_display_name(cls, dt: datetime) -> str:
        return make_draft_map_display_name(dt)
