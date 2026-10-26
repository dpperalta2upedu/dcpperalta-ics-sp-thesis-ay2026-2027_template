from __future__ import annotations

from typing import Any

from services.navigation_graph_cache_service import NavigationGraphCacheService as BaseNavigationGraphCacheService
from sandbox.services.sb_storage_common import deserialize_json
from sandbox.services.sb_storage_common import serialize_json


DEFAULT_CACHE_KEY = "default"


class NavigationGraphCacheService(BaseNavigationGraphCacheService):
    IS_SANDBOX = True

    @classmethod
    def _deserialize_json(cls, raw: str) -> dict[str, Any]:
        return deserialize_json(raw)

    @classmethod
    def _serialize_json(cls, payload: dict[str, Any]) -> str:
        return serialize_json(payload)
