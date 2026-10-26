from __future__ import annotations

from typing import Any

from services.draft_main_map_layout_service import DraftMainMapLayoutService
from services.main_map_layout_history_service import MainMapLayoutHistoryService
from services.main_map_layout_service import MainMapLayoutService
from services.map_layout_routing_diff import has_routing_entity_changes
from services.navigation_graph_cache_service import NavigationGraphCacheService
from services.navigation_service import NavigationService


class LayoutRouteCacheService:
    DRAFT_SERVICE = DraftMainMapLayoutService
    HISTORY_SERVICE = MainMapLayoutHistoryService
    LAYOUT_SERVICE = MainMapLayoutService
    CACHE_SERVICE = NavigationGraphCacheService
    NAVIGATION_SERVICE = NavigationService

    @classmethod
    def _resolve_source_layout_id(
        cls,
        *,
        source_map_layout_id: int | None = None,
        source_draft_id: int | None = None,
        draft_filename: str | None = None,
    ) -> int | None:
        if source_map_layout_id is not None:
            return source_map_layout_id
        draft_record: dict[str, Any] | None = None
        if source_draft_id is not None:
            draft_record = cls.DRAFT_SERVICE.get_draft(source_draft_id)
        elif draft_filename:
            draft_record = cls.DRAFT_SERVICE.get_draft_by_filename(draft_filename)
        if draft_record is None:
            return None
        value = draft_record.get("sourceMapLayoutId")
        return int(value) if value is not None else None

    @classmethod
    def ensure_layout_cache(cls, layout_record: dict[str, Any] | None) -> bool:
        if layout_record is None:
            return False
        layout_id = layout_record.get("id")
        payload = layout_record.get("payload")
        if layout_id is None or not isinstance(payload, dict):
            return False
        if cls.CACHE_SERVICE.get_cache_metadata_by_layout_id(int(layout_id)) is not None:
            return False
        cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(layout_id), payload)
        return True

    @classmethod
    def ensure_all_layout_caches(cls) -> int:
        rebuilt = 0
        current = cls.LAYOUT_SERVICE.get_current_record()
        if cls.ensure_layout_cache(current):
            rebuilt += 1
        for item in cls.HISTORY_SERVICE.list_history():
            if cls.ensure_layout_cache(item):
                rebuilt += 1
        return rebuilt

    @classmethod
    def sync_current_layout_cache(
        cls,
        *,
        previous_layout: dict[str, Any],
        current_record: dict[str, Any] | None,
    ) -> str:
        if current_record is None:
            return "missing_current"
        layout_id = current_record.get("id")
        payload = current_record.get("payload")
        if layout_id is None or not isinstance(payload, dict):
            return "missing_current"
        if cls.CACHE_SERVICE.get_cache_metadata_by_layout_id(int(layout_id)) is None:
            cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(layout_id), payload)
            return "updated"
        if not has_routing_entity_changes(previous_layout, payload):
            return "skipped_no_routing_changes"
        cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(layout_id), payload)
        return "updated"

    @classmethod
    def publish_layout_cache(
        cls,
        *,
        payload: dict[str, Any],
        published: dict[str, Any],
        source_map_layout_id: int | None = None,
        source_draft_id: int | None = None,
        draft_filename: str | None = None,
    ) -> str:
        current_record = published.get("current")
        if not isinstance(current_record, dict):
            return "missing_current"

        current_layout_id = current_record.get("id")
        if current_layout_id is None:
            return "missing_current"

        resolved_source_layout_id = cls._resolve_source_layout_id(
            source_map_layout_id=source_map_layout_id,
            source_draft_id=source_draft_id,
            draft_filename=draft_filename,
        )

        if resolved_source_layout_id is None:
            history_record = published.get("history")
            if isinstance(history_record, dict) and history_record.get("id") is not None:
                resolved_source_layout_id = int(history_record["id"])

        source_record = (
            cls.LAYOUT_SERVICE.get_record_by_id(int(resolved_source_layout_id))
            if resolved_source_layout_id is not None
            else None
        )

        if source_record is not None and not has_routing_entity_changes(source_record.get("payload", {}), payload):
            cloned = cls.CACHE_SERVICE.clone_cache(
                source_layout_id=int(source_record["id"]),
                target_layout_id=int(current_layout_id),
            )
            if cloned:
                return "cloned"

        cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(current_layout_id), payload)
        return "updated"

    @classmethod
    def sync_history_item_cache(
        cls,
        *,
        previous_layout: dict[str, Any],
        history_record: dict[str, Any] | None,
        source_map_layout_id: int | None = None,
    ) -> str:
        if history_record is None:
            return "missing_history"
        layout_id = history_record.get("id")
        payload = history_record.get("payload")
        if layout_id is None or not isinstance(payload, dict):
            return "missing_history"

        if source_map_layout_id is not None:
            source_record = cls.LAYOUT_SERVICE.get_record_by_id(int(source_map_layout_id))
            if source_record is not None and not has_routing_entity_changes(source_record.get("payload", {}), payload):
                cloned = cls.CACHE_SERVICE.clone_cache(
                    source_layout_id=int(source_record["id"]),
                    target_layout_id=int(layout_id),
                )
                if cloned:
                    return "cloned"

        if cls.CACHE_SERVICE.get_cache_metadata_by_layout_id(int(layout_id)) is None:
            cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(layout_id), payload)
            return "updated"

        if not has_routing_entity_changes(previous_layout, payload):
            return "skipped_no_routing_changes"

        cls.NAVIGATION_SERVICE.rebuild_graph_cache_for_layout(int(layout_id), payload)
        return "updated"
