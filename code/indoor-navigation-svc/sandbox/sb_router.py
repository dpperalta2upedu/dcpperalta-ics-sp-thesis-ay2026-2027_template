from __future__ import annotations

from threading import Lock
from threading import Thread
from typing import Any
import json

from fastapi import APIRouter
from fastapi import Body
from fastapi import Depends
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi import Request
from fastapi.responses import Response

from models.search_request import SearchRequest
from models.search_response import SearchResponse
from sandbox.services.sb_admin_access import require_admin
from sandbox.services.sb_draft_main_map_layout_service import SandboxDraftMainMapLayoutService
from sandbox.services.sb_layout_arranger_service import SandboxLayoutArrangerService
from sandbox.services.sb_layout_arranger_service import is_undo_request
from sandbox.services.sb_layout_route_cache_service import SandboxLayoutRouteCacheService
from sandbox.services.sb_main_map_layout_history_service import SandboxMainMapLayoutHistoryService
from sandbox.services.sb_main_map_layout_service import SandboxMainMapLayoutService
from sandbox.services.sb_navigation_service import SandboxNavigationService
from sandbox.utils.sb_map_layout import load_map_layout
from sandbox.utils.sb_map_layout import map_layout_to_svg


sandbox_router = APIRouter(
    prefix="/sandbox",
    tags=["sandbox"],
    dependencies=[Depends(require_admin)],
)

_SANDBOX_REBUILD_LOCK = Lock()
_SANDBOX_REBUILD_SCHED_LOCK = Lock()
_SANDBOX_REBUILD_SCHEDULED = False

# Server-side config history for undo support (in-memory only).
# Each non-undo plan request pushes the currentConfig so that
# "revert last change" can restore the state before the last change.
_LAYOUT_CONFIG_HISTORY: list[dict] = []
_LAYOUT_CONFIG_HISTORY_LOCK = Lock()
_LAYOUT_CONFIG_HISTORY_MAX = 20


def _push_config_history(config: dict) -> None:
    with _LAYOUT_CONFIG_HISTORY_LOCK:
        _LAYOUT_CONFIG_HISTORY.append(dict(config))
        if len(_LAYOUT_CONFIG_HISTORY) > _LAYOUT_CONFIG_HISTORY_MAX:
            _LAYOUT_CONFIG_HISTORY.pop(0)


def _consume_previous_config_for_undo() -> dict | None:
    """Pop and return the most recent recorded config from history.

    Pops without skipping — if the popped entry equals the current config it means
    the last action was a canvas-only operation (no config change). The service will
    trigger a force-regeneration to restore deleted elements.
    """
    with _LAYOUT_CONFIG_HISTORY_LOCK:
        if _LAYOUT_CONFIG_HISTORY:
            return dict(_LAYOUT_CONFIG_HISTORY.pop())
        return None


def _coerce_optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _sandbox_layout_cache_token() -> int | None:
    return SandboxMainMapLayoutService.get_cache_token()


def _refresh_sandbox_navigation_cache(app: FastAPI) -> bool:
    with _SANDBOX_REBUILD_LOCK:
        current = _sandbox_layout_cache_token()
        cached = getattr(app.state, "sandbox_layout_cache_token", None)
        if current == cached and getattr(app.state, "sandbox_nav_service", None) is not None:
            return False
        app.state.sandbox_nav_service = SandboxNavigationService()
        app.state.sandbox_layout_cache_token = _sandbox_layout_cache_token()
        return True


def _queue_sandbox_navigation_cache_rebuild(app: FastAPI) -> bool:
    global _SANDBOX_REBUILD_SCHEDULED
    with _SANDBOX_REBUILD_SCHED_LOCK:
        if _SANDBOX_REBUILD_SCHEDULED:
            return False
        _SANDBOX_REBUILD_SCHEDULED = True

    def _runner() -> None:
        global _SANDBOX_REBUILD_SCHEDULED
        try:
            _refresh_sandbox_navigation_cache(app)
        finally:
            with _SANDBOX_REBUILD_SCHED_LOCK:
                _SANDBOX_REBUILD_SCHEDULED = False

    Thread(target=_runner, daemon=True).start()
    return True


def _ensure_sandbox_nav_service_fresh(app: FastAPI) -> None:
    current = _sandbox_layout_cache_token()
    cached = getattr(app.state, "sandbox_layout_cache_token", None)
    if current != cached or getattr(app.state, "sandbox_nav_service", None) is None:
        _refresh_sandbox_navigation_cache(app)


def initialize_sandbox_state(app: FastAPI) -> None:
    SandboxLayoutRouteCacheService.ensure_all_layout_caches()
    try:
        SandboxNavigationService.rebuild_graph_cache()
        app.state.sandbox_nav_service = SandboxNavigationService()
    except Exception:
        app.state.sandbox_nav_service = SandboxNavigationService()
    app.state.sandbox_layout_cache_token = _sandbox_layout_cache_token()


@sandbox_router.get("/status")
def sandbox_status():
    return {"status": "ok", "mode": "sandbox"}


@sandbox_router.post("/search", response_model=SearchResponse)
def sandbox_search(req: SearchRequest, request: Request):
    origin = (req.origin or "").strip()
    destination = (req.destination or "").strip()

    _ensure_sandbox_nav_service_fresh(request.app)
    nav_service = request.app.state.sandbox_nav_service
    reply = nav_service.parse_navigation(origin, destination)
    return {"reply": json.dumps(reply, indent=2)}


@sandbox_router.post("/layout-arranger/plan")
def plan_sandbox_layout_arrangement(payload: dict = Body(...)):
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="message is required.")
    current_config = payload.get("currentConfig")
    previous_config = payload.get("previousConfig")
    current_layout_summary = payload.get("currentLayoutSummary")

    resolved_current = current_config if isinstance(current_config, dict) else None
    resolved_previous = previous_config if isinstance(previous_config, dict) else None

    # Detect undo intent without calling build_plan, so we can fall back to the
    # server-side history when the frontend does not send previousConfig.
    _is_undo = is_undo_request(message)

    if _is_undo:
        if resolved_previous is None:
            resolved_previous = _consume_previous_config_for_undo()
    else:
        # Record current config in history so future undo requests can use it.
        if resolved_current is not None:
            _push_config_history(resolved_current)

    try:
        return SandboxLayoutArrangerService.build_plan(
            message=message,
            current_config=resolved_current,
            previous_config=resolved_previous,
            current_layout_summary=current_layout_summary if isinstance(current_layout_summary, dict) else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@sandbox_router.get("/map-layout")
def get_sandbox_map_layout():
    try:
        return SandboxMainMapLayoutService.get_current_layout()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@sandbox_router.post("/map-layout")
def create_sandbox_map_layout(request: Request, payload: dict = Body(...)):
    floors = payload.get("floors")
    if not isinstance(floors, (dict, list)):
        raise HTTPException(status_code=400, detail="floors must be an object or list.")
    display_name = payload.get("displayName", payload.get("display_name"))
    try:
        record = SandboxMainMapLayoutService.create_layout(
            payload,
            display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cache_rebuild = "updated" if SandboxLayoutRouteCacheService.ensure_layout_cache(record) else "already_present"
    _refresh_sandbox_navigation_cache(request.app)
    record = SandboxMainMapLayoutService.get_current_record() or record
    return {
        "ok": True,
        "cacheRebuild": cache_rebuild,
        "layoutVersion": record["layoutVersion"],
        "displayName": record["displayName"],
        "routeCacheId": record.get("routeCacheId"),
    }


@sandbox_router.put("/map-layout")
def update_sandbox_map_layout(request: Request, payload: dict = Body(...)):
    floors = payload.get("floors")
    if not isinstance(floors, (dict, list)):
        raise HTTPException(status_code=400, detail="floors must be an object or list.")
    display_name = payload.get("displayName", payload.get("display_name"))
    previous_record = SandboxMainMapLayoutService.get_current_record()
    record = SandboxMainMapLayoutService.upsert_layout(
        payload,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
    )
    cache_rebuild = SandboxLayoutRouteCacheService.sync_current_layout_cache(
        previous_layout=previous_record["payload"] if previous_record is not None else {},
        current_record=record,
    )
    if cache_rebuild == "updated":
        _refresh_sandbox_navigation_cache(request.app)
    else:
        request.app.state.sandbox_layout_cache_token = _sandbox_layout_cache_token()
    record = SandboxMainMapLayoutService.get_current_record() or record
    return {
        "ok": True,
        "cacheRebuild": cache_rebuild,
        "layoutVersion": record["layoutVersion"],
        "displayName": record["displayName"],
        "routeCacheId": record.get("routeCacheId"),
    }


@sandbox_router.delete("/map-layout")
def delete_sandbox_map_layout(request: Request):
    deleted = SandboxMainMapLayoutService.delete_layout()
    if deleted:
        _refresh_sandbox_navigation_cache(request.app)
    return {"ok": True, "deleted": deleted}


@sandbox_router.api_route("/map-layout/publish", methods=["POST", "PUT"])
def publish_sandbox_map_layout(request: Request, payload: dict = Body(...)):
    next_map_layout = payload.get("mapLayout")
    draft_filename = payload.get("draftFilename")
    draft_id = payload.get("draftId")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    if not isinstance(next_map_layout, dict):
        raise HTTPException(status_code=400, detail="Invalid mapLayout payload.")

    published = SandboxMainMapLayoutService.publish_layout(
        next_map_layout,
        source_draft_id=_coerce_optional_int(draft_id),
        draft_filename=str(draft_filename).strip() if isinstance(draft_filename, str) else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    cache_rebuild = SandboxLayoutRouteCacheService.publish_layout_cache(
        payload=next_map_layout,
        published=published,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
        source_draft_id=_coerce_optional_int(draft_id),
        draft_filename=str(draft_filename).strip() if isinstance(draft_filename, str) else None,
    )
    new_current = published.get("current") or {}
    new_layout_id = new_current.get("id") if isinstance(new_current, dict) else None
    if new_layout_id is not None:
        SandboxNavigationService.rebuild_graph_cache_for_layout(int(new_layout_id), next_map_layout)
    _refresh_sandbox_navigation_cache(request.app)
    current_record = SandboxMainMapLayoutService.get_current_record() or published["current"]
    return {
        "ok": True,
        "current": current_record,
        "history": published["history"],
        "cacheRebuild": cache_rebuild,
        "deletedDraft": published["deletedDraft"],
        "trimmedMapHistory": published["trimmedHistory"],
        "layoutVersion": current_record["layoutVersion"],
        "displayName": current_record["displayName"],
        "routeCacheId": current_record.get("routeCacheId"),
    }


@sandbox_router.api_route("/map-layout/publish/", methods=["POST", "PUT"], include_in_schema=False)
def publish_sandbox_map_layout_with_slash(request: Request, payload: dict = Body(...)):
    return publish_sandbox_map_layout(request, payload)


@sandbox_router.get("/draft-maps")
def get_sandbox_draft_maps():
    return {"ok": True, "items": SandboxDraftMainMapLayoutService.list_drafts()}


@sandbox_router.get("/draft-maps/{draft_id}")
def get_sandbox_draft_map(draft_id: int):
    item = SandboxDraftMainMapLayoutService.get_draft(draft_id)
    if item is None or item["isDeleted"]:
        raise HTTPException(status_code=404, detail="Sandbox draft map layout not found.")
    return {"ok": True, "item": item}


@sandbox_router.post("/draft-maps")
def create_sandbox_draft_map(payload: dict = Body(...)):
    draft = payload.get("draft", payload)
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = SandboxDraftMainMapLayoutService.create_draft(
        draft,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    return {"ok": True, "item": item}


@sandbox_router.post("/draft-maps/save")
def save_sandbox_draft_map(payload: dict = Body(...)):
    draft = payload.get("draft")
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = SandboxDraftMainMapLayoutService.create_draft(
        draft,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    return {
        "ok": True,
        "filename": item["filename"],
        "displayName": item["displayName"],
        "deleted": item.get("trimmedDrafts", []),
    }


@sandbox_router.put("/draft-maps/{draft_id}")
def update_sandbox_draft_map(draft_id: int, payload: dict = Body(...)):
    draft = payload.get("draft", payload)
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = SandboxDraftMainMapLayoutService.update_draft(
        draft_id,
        draft,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Sandbox draft map layout not found.")
    return {"ok": True, "item": item}


@sandbox_router.post("/draft-maps/delete")
def delete_sandbox_draft_map_by_filename(payload: dict = Body(...)):
    filename = payload.get("filename")
    if not isinstance(filename, str) or not filename.strip():
        raise HTTPException(status_code=400, detail="Invalid filename.")

    deleted_item = SandboxDraftMainMapLayoutService.delete_draft(filename=filename.strip())
    return {"ok": True, "filename": filename.strip(), "deleted": deleted_item is not None}


@sandbox_router.delete("/draft-maps/{draft_id}")
def delete_sandbox_draft_map(draft_id: int):
    deleted_item = SandboxDraftMainMapLayoutService.delete_draft(draft_id=draft_id)
    return {"ok": True, "deleted": deleted_item is not None}


@sandbox_router.get("/map-layout-history")
def get_sandbox_map_layout_history():
    return {"ok": True, "items": SandboxMainMapLayoutHistoryService.list_history()}


@sandbox_router.get("/map-layout-history/{history_id}")
def get_sandbox_map_layout_history_item(history_id: int):
    item = SandboxMainMapLayoutHistoryService.get_history_item(history_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Sandbox map layout history item not found.")
    return {"ok": True, "item": item}


@sandbox_router.post("/map-layout-history")
def create_sandbox_map_layout_history_item(payload: dict = Body(...)):
    history_payload = payload.get("payload", payload.get("mapLayout", payload))
    if not isinstance(history_payload, dict):
        raise HTTPException(status_code=400, detail="Invalid map layout history payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_draft_id = payload.get("sourceDraftId", payload.get("source_draft_id"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = SandboxMainMapLayoutHistoryService.create_history_item(
        history_payload,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_draft_id=_coerce_optional_int(source_draft_id),
    )
    cache_rebuild = SandboxLayoutRouteCacheService.sync_history_item_cache(
        previous_layout={},
        history_record=item,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    item = SandboxMainMapLayoutHistoryService.get_history_item(item["id"]) or item
    return {"ok": True, "item": item, "cacheRebuild": cache_rebuild}


@sandbox_router.put("/map-layout-history/{history_id}")
def update_sandbox_map_layout_history_item(history_id: int, payload: dict = Body(...)):
    history_payload = payload.get("payload", payload.get("mapLayout", payload))
    if not isinstance(history_payload, dict):
        raise HTTPException(status_code=400, detail="Invalid map layout history payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_draft_id = payload.get("sourceDraftId", payload.get("source_draft_id"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    previous_item = SandboxMainMapLayoutHistoryService.get_history_item(history_id)
    item = SandboxMainMapLayoutHistoryService.update_history_item(
        history_id,
        history_payload,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_draft_id=_coerce_optional_int(source_draft_id),
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Sandbox map layout history item not found.")
    cache_rebuild = SandboxLayoutRouteCacheService.sync_history_item_cache(
        previous_layout=previous_item["payload"] if previous_item is not None else {},
        history_record=item,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    item = SandboxMainMapLayoutHistoryService.get_history_item(item["id"]) or item
    return {"ok": True, "item": item, "cacheRebuild": cache_rebuild}


@sandbox_router.delete("/map-layout-history/{history_id}")
def delete_sandbox_map_layout_history_item(history_id: int):
    deleted = SandboxMainMapLayoutHistoryService.delete_history_item(history_id)
    return {"ok": True, "deleted": deleted}


@sandbox_router.get("/map-svg")
def get_sandbox_map_svg():
    layout = load_map_layout()
    svg = map_layout_to_svg(layout)
    return Response(content=svg, media_type="image/svg+xml")
