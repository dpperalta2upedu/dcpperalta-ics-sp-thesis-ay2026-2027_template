from fastapi import Body
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi import Request
from threading import Lock
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from contextlib import asynccontextmanager
from threading import Thread
from models.search_request import SearchRequest
from models.search_response import SearchResponse
from sandbox.sb_router import initialize_sandbox_state
from sandbox.sb_router import sandbox_router
from services.database import ensure_database_ready
from services.draft_main_map_layout_service import DraftMainMapLayoutService
from services.legacy_storage_migration_service import LegacyStorageMigrationService
from services.layout_route_cache_service import LayoutRouteCacheService
from services.login_service import LoginService
from services.main_map_layout_history_service import MainMapLayoutHistoryService
from services.main_map_layout_service import MainMapLayoutService
from services.navigation_service import NavigationService
from utils.map_layout import load_map_layout
from utils.map_layout import map_layout_to_svg
from typing import Any
import os
import json


def _run_post_startup_warmup(app: FastAPI) -> None:
    try:
        print("Starting post-startup warmup...")
        app.state.migration_summary = LegacyStorageMigrationService.migrate_from_legacy_files()
        LayoutRouteCacheService.ensure_all_layout_caches()
        NavigationService.rebuild_graph_cache()
        app.state.nav_service = NavigationService()
        app.state.layout_mtime_ns = _map_layout_mtime_ns()
        initialize_sandbox_state(app)
        print("Post-startup warmup complete.")
    except Exception as exc:
        print(f"Post-startup warmup failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_database_ready()
    LoginService.validate_configuration()
    LoginService.ensure_default_account()
    app.state.migration_summary = None
    app.state.nav_service = None
    app.state.layout_mtime_ns = None
    app.state.sandbox_nav_service = None
    app.state.sandbox_layout_cache_token = None
    Thread(target=_run_post_startup_warmup, args=(app,), daemon=True).start()
    yield


app = FastAPI(title="Indoor Navigation API", lifespan=lifespan)
_REBUILD_LOCK = Lock()
_FILE_OPS_LOCK = Lock()
_REBUILD_SCHED_LOCK = Lock()
_REBUILD_SCHEDULED = False


def _refresh_navigation_cache(app: FastAPI) -> bool:
    with _REBUILD_LOCK:
        current = _map_layout_mtime_ns()
        cached = getattr(app.state, "layout_mtime_ns", None)
        if current == cached and getattr(app.state, "nav_service", None) is not None:
            return False
        app.state.nav_service = NavigationService()
        app.state.layout_mtime_ns = _map_layout_mtime_ns()
        return True


def _queue_navigation_cache_rebuild(app: FastAPI) -> bool:
    global _REBUILD_SCHEDULED
    with _REBUILD_SCHED_LOCK:
        if _REBUILD_SCHEDULED:
            return False
        _REBUILD_SCHEDULED = True

    def _runner() -> None:
        global _REBUILD_SCHEDULED
        try:
            _refresh_navigation_cache(app)
        finally:
            with _REBUILD_SCHED_LOCK:
                _REBUILD_SCHEDULED = False

    Thread(target=_runner, daemon=True).start()
    return True


def _map_layout_mtime_ns() -> int | None:
    return MainMapLayoutService.get_cache_token()


def _ensure_nav_service_fresh(app: FastAPI) -> None:
    current = _map_layout_mtime_ns()
    cached = getattr(app.state, "layout_mtime_ns", None)
    if current != cached:
        _refresh_navigation_cache(app)


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


# CORS CONFIG (IMPORTANT)
_DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]
_EXTRA_CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
_CORS_ORIGINS = sorted(set(_DEFAULT_CORS_ORIGINS + _EXTRA_CORS_ORIGINS))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(sandbox_router)


@app.get("/status")
def status():
    return {"status": "ok"}


@app.get("/auth/status")
def auth_status():
    creds = LoginService.get_status()
    return {"ok": True, "username": creds["username"]}


@app.post("/auth/login")
def auth_login(payload: dict = Body(...), response: Response = None):
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")
    if not LoginService.verify_credentials(username, password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    session_token = LoginService.create_session_token(username)
    if not session_token:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    response.set_cookie(
        key=LoginService.SESSION_COOKIE_NAME,
        value=session_token,
        max_age=LoginService.SESSION_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )
    return {"ok": True, "username": username}


@app.post("/auth/logout")
def auth_logout(response: Response = None):
    response.delete_cookie(LoginService.SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@app.post("/auth/change-password")
def auth_change_password(payload: dict = Body(...)):
    username = str(payload.get("username", "")).strip()
    current_password = str(payload.get("currentPassword", payload.get("current_password", "")))
    new_password = str(payload.get("newPassword", payload.get("new_password", "")))
    confirm_new_password = str(
        payload.get("confirmNewPassword", payload.get("confirm_new_password", ""))
    )
    if not username or not current_password.strip() or not new_password.strip() or not confirm_new_password.strip():
        raise HTTPException(
            status_code=400,
            detail="username, currentPassword, newPassword, and confirmNewPassword are required",
        )
    if (
        current_password != current_password.strip()
        or new_password != new_password.strip()
        or confirm_new_password != confirm_new_password.strip()
    ):
        raise HTTPException(status_code=400, detail="passwords cannot start or end with spaces")
    if new_password != confirm_new_password:
        raise HTTPException(status_code=400, detail="new passwords do not match")
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    if new_password == current_password:
        raise HTTPException(
            status_code=400,
            detail="new password must be different from current password",
        )

    with _FILE_OPS_LOCK:
        updated = LoginService.change_password(username, current_password, new_password)
    if not updated:
        raise HTTPException(status_code=401, detail="Invalid username or current password")
    return {"ok": True}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest, request: Request):
    origin = (req.origin or "").strip()
    destination = (req.destination or "").strip()

    print("ORIGIN", origin)
    print("DESTINATION", destination)

    _ensure_nav_service_fresh(request.app)
    nav_service = request.app.state.nav_service
    reply = nav_service.parse_navigation(origin, destination)
    print("ROUTE_RESULT", json.dumps(reply, indent=2))

    # Convert JSON to string
    return {"reply": json.dumps(reply, indent=2)}


@app.get("/map-layout")
def get_map_layout():
    try:
        return MainMapLayoutService.get_current_layout()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/map-layout")
def post_map_layout(request: Request, payload: dict = Body(...)):
    floors = payload.get("floors")
    if not isinstance(floors, (dict, list)):
        raise HTTPException(status_code=400, detail="floors must be an object or list.")
    display_name = payload.get("displayName", payload.get("display_name"))
    try:
        record = MainMapLayoutService.create_layout(
            payload,
            display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cache_rebuild = "updated" if LayoutRouteCacheService.ensure_layout_cache(record) else "already_present"
    _refresh_navigation_cache(request.app)
    record = MainMapLayoutService.get_current_record() or record
    return {
        "ok": True,
        "cacheRebuild": cache_rebuild,
        "layoutVersion": record["layoutVersion"],
        "displayName": record["displayName"],
        "routeCacheId": record.get("routeCacheId"),
    }


@app.put("/map-layout")
def put_map_layout(request: Request, payload: dict = Body(...)):
    floors = payload.get("floors")
    if not isinstance(floors, (dict, list)):
        raise HTTPException(status_code=400, detail="floors must be an object or list.")
    display_name = payload.get("displayName", payload.get("display_name"))

    previous_record = MainMapLayoutService.get_current_record()
    previous_layout = previous_record["payload"] if previous_record is not None else {}

    record = MainMapLayoutService.upsert_layout(
        payload,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
    )
    cache_rebuild = LayoutRouteCacheService.sync_current_layout_cache(
        previous_layout=previous_layout,
        current_record=record,
    )
    if cache_rebuild == "updated":
        _refresh_navigation_cache(request.app)
    else:
        request.app.state.layout_mtime_ns = _map_layout_mtime_ns()
    record = MainMapLayoutService.get_current_record() or record
    return {
        "ok": True,
        "cacheRebuild": cache_rebuild,
        "layoutVersion": record["layoutVersion"],
        "displayName": record["displayName"],
        "routeCacheId": record.get("routeCacheId"),
    }


@app.delete("/map-layout")
def delete_map_layout(request: Request):
    deleted = MainMapLayoutService.delete_layout()
    if deleted:
        request.app.state.layout_mtime_ns = _map_layout_mtime_ns()
    return {"ok": True, "deleted": deleted}


@app.api_route("/map-layout/publish", methods=["POST", "PUT"])
def post_map_layout_publish(request: Request, payload: dict = Body(...)):
    next_map_layout = payload.get("mapLayout")
    draft_filename = payload.get("draftFilename")
    draft_id = payload.get("draftId")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    if not isinstance(next_map_layout, dict):
        raise HTTPException(status_code=400, detail="Invalid mapLayout payload.")

    published = MainMapLayoutService.publish_layout(
        next_map_layout,
        source_draft_id=_coerce_optional_int(draft_id),
        draft_filename=str(draft_filename).strip() if isinstance(draft_filename, str) else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    cache_rebuild = LayoutRouteCacheService.publish_layout_cache(
        payload=next_map_layout,
        published=published,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
        source_draft_id=_coerce_optional_int(draft_id),
        draft_filename=str(draft_filename).strip() if isinstance(draft_filename, str) else None,
    )
    _refresh_navigation_cache(request.app)
    current_record = MainMapLayoutService.get_current_record() or published["current"]

    return {
        "ok": True,
        "cacheRebuild": cache_rebuild,
        "deletedDraft": published["deletedDraft"],
        "trimmedMapHistory": published["trimmedHistory"],
        "layoutVersion": current_record["layoutVersion"],
        "displayName": current_record["displayName"],
        "routeCacheId": current_record.get("routeCacheId"),
    }


@app.api_route("/map-layout/publish/", methods=["POST", "PUT"], include_in_schema=False)
def post_map_layout_publish_with_slash(request: Request, payload: dict = Body(...)):
    return post_map_layout_publish(request, payload)


@app.get("/draft-maps")
def get_draft_maps():
    return {"ok": True, "items": DraftMainMapLayoutService.list_drafts()}


@app.get("/draft-maps/{draft_id}")
def get_draft_map(draft_id: int):
    item = DraftMainMapLayoutService.get_draft(draft_id)
    if item is None or item["isDeleted"]:
        raise HTTPException(status_code=404, detail="Draft map layout not found.")
    return {"ok": True, "item": item}


@app.post("/draft-maps")
def create_draft_map(payload: dict = Body(...)):
    draft = payload.get("draft", payload)
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = DraftMainMapLayoutService.create_draft(
        draft,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    return {"ok": True, "item": item}


@app.post("/draft-maps/save")
def post_draft_maps_save(payload: dict = Body(...)):
    draft = payload.get("draft")
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = DraftMainMapLayoutService.create_draft(
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


@app.put("/draft-maps/{draft_id}")
def update_draft_map(draft_id: int, payload: dict = Body(...)):
    draft = payload.get("draft", payload)
    if not isinstance(draft, dict):
        raise HTTPException(status_code=400, detail="Invalid draft payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = DraftMainMapLayoutService.update_draft(
        draft_id,
        draft,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Draft map layout not found.")
    return {"ok": True, "item": item}


@app.post("/draft-maps/delete")
def post_draft_maps_delete(payload: dict = Body(...)):
    filename = payload.get("filename")
    if not isinstance(filename, str) or not filename.strip():
        raise HTTPException(status_code=400, detail="Invalid filename.")

    deleted_item = DraftMainMapLayoutService.delete_draft(filename=filename.strip())
    return {"ok": True, "filename": filename.strip(), "deleted": deleted_item is not None}


@app.delete("/draft-maps/{draft_id}")
def delete_draft_map(draft_id: int):
    deleted_item = DraftMainMapLayoutService.delete_draft(draft_id=draft_id)
    return {"ok": True, "deleted": deleted_item is not None}


@app.get("/map-layout-history")
def get_map_layout_history():
    return {"ok": True, "items": MainMapLayoutHistoryService.list_history()}


@app.get("/map-layout-history/{history_id}")
def get_map_layout_history_item(history_id: int):
    item = MainMapLayoutHistoryService.get_history_item(history_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Map layout history item not found.")
    return {"ok": True, "item": item}


@app.post("/map-layout-history")
def create_map_layout_history_item(payload: dict = Body(...)):
    history_payload = payload.get("payload", payload.get("mapLayout", payload))
    if not isinstance(history_payload, dict):
        raise HTTPException(status_code=400, detail="Invalid map layout history payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_draft_id = payload.get("sourceDraftId", payload.get("source_draft_id"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    item = MainMapLayoutHistoryService.create_history_item(
        history_payload,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_draft_id=_coerce_optional_int(source_draft_id),
    )
    cache_rebuild = LayoutRouteCacheService.sync_history_item_cache(
        previous_layout={},
        history_record=item,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    item = MainMapLayoutHistoryService.get_history_item(item["id"]) or item
    return {"ok": True, "item": item, "cacheRebuild": cache_rebuild}


@app.put("/map-layout-history/{history_id}")
def update_map_layout_history_item(history_id: int, payload: dict = Body(...)):
    history_payload = payload.get("payload", payload.get("mapLayout", payload))
    if not isinstance(history_payload, dict):
        raise HTTPException(status_code=400, detail="Invalid map layout history payload.")
    filename = payload.get("filename")
    display_name = payload.get("displayName", payload.get("display_name"))
    source_draft_id = payload.get("sourceDraftId", payload.get("source_draft_id"))
    source_map_layout_id = payload.get("sourceMapLayoutId", payload.get("source_map_layout_id"))
    previous_item = MainMapLayoutHistoryService.get_history_item(history_id)
    item = MainMapLayoutHistoryService.update_history_item(
        history_id,
        history_payload,
        filename=str(filename).strip() if isinstance(filename, str) and filename.strip() else None,
        display_name=str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
        source_draft_id=_coerce_optional_int(source_draft_id),
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Map layout history item not found.")
    cache_rebuild = LayoutRouteCacheService.sync_history_item_cache(
        previous_layout=previous_item["payload"] if previous_item is not None else {},
        history_record=item,
        source_map_layout_id=_coerce_optional_int(source_map_layout_id),
    )
    item = MainMapLayoutHistoryService.get_history_item(item["id"]) or item
    return {"ok": True, "item": item, "cacheRebuild": cache_rebuild}


@app.delete("/map-layout-history/{history_id}")
def delete_map_layout_history_item(history_id: int):
    deleted = MainMapLayoutHistoryService.delete_history_item(history_id)
    return {"ok": True, "deleted": deleted}


@app.get("/map-svg")
def get_map_svg():
    layout = load_map_layout()
    svg = map_layout_to_svg(layout)
    return Response(content=svg, media_type="image/svg+xml")



