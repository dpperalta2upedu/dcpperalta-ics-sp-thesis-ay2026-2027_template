from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from sandbox.services.sb_main_map_layout_service import SandboxMainMapLayoutService


_MAP_LAYOUT_OVERRIDE: ContextVar[dict[str, Any] | None] = ContextVar("sandbox_map_layout_override", default=None)


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def load_map_layout() -> dict[str, Any]:
    override = _MAP_LAYOUT_OVERRIDE.get()
    if override is not None:
        return override
    return SandboxMainMapLayoutService.get_current_layout()


def write_map_layout(payload: dict[str, Any]) -> None:
    SandboxMainMapLayoutService.upsert_layout(payload)


@contextmanager
def map_layout_context(payload: dict[str, Any]):
    token = _MAP_LAYOUT_OVERRIDE.set(payload)
    try:
        yield
    finally:
        _MAP_LAYOUT_OVERRIDE.reset(token)


def _svg_local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _svg_num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _svg_group_label(group: ET.Element) -> str:
    for child in list(group):
        if _svg_local_name(child.tag) != "text":
            continue
        text = "".join(child.itertext()).strip()
        if text:
            return text
    return ""


def _svg_group_geometry(group: ET.Element) -> dict[str, float]:
    for child in list(group):
        tag = _svg_local_name(child.tag)
        if tag == "rect":
            x = _svg_num(child.get("x"))
            y = _svg_num(child.get("y"))
            width = _svg_num(child.get("width"))
            height = _svg_num(child.get("height"))
            if None not in (x, y, width, height):
                return {
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                    "cx": x + (width / 2.0),
                    "cy": y + (height / 2.0),
                }
        if tag == "circle":
            cx = _svg_num(child.get("cx"))
            cy = _svg_num(child.get("cy"))
            radius = _svg_num(child.get("r"))
            if None not in (cx, cy, radius):
                return {
                    "x": cx - radius,
                    "y": cy - radius,
                    "width": radius * 2.0,
                    "height": radius * 2.0,
                    "cx": cx,
                    "cy": cy,
                    "r": radius,
                }
    return {}


def extract_svg_floor_entities(svg_markup: str, *, floor: int | None = None) -> list[dict[str, Any]]:
    if not isinstance(svg_markup, str) or not svg_markup.strip():
        return []

    try:
        root = ET.fromstring(svg_markup)
    except ET.ParseError:
        return []

    entities: list[dict[str, Any]] = []
    for group in root.iter():
        if _svg_local_name(group.tag) != "g":
            continue
        entity_id = str(group.get("data-room-id", "")).strip()
        entity_kind = str(group.get("data-kind", "")).strip().lower()
        if not entity_id or not entity_kind:
            continue

        geometry = _svg_group_geometry(group)
        label = _svg_group_label(group)
        entities.append(
            {
                "floor": floor,
                "id": entity_id,
                "name": label or entity_id,
                "type": entity_kind,
                "passable": entity_kind in {"stairs", "hallway", "bridge", "entrance"},
                **geometry,
            }
        )
    return entities


def _render_svg_document(
    width: float,
    height: float,
    view_box: str,
    background: str,
    floors: list[dict[str, Any]],
) -> str:
    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}" '
            f'height="{height:g}" viewBox="{escape(view_box)}">'
        ),
        "<defs>",
        "<style>",
        ".room{fill:#dbeafe;stroke:#1e3a8a;stroke-width:1.2}"
        ".hallway{fill:#fef3c7;stroke:#92400e;stroke-width:1.2}"
        ".stairs{fill:#fee2e2;stroke:#991b1b;stroke-width:1.2}"
        ".label{fill:#111827;font-size:11px;font-family:Arial,sans-serif}"
        ".floor-title{fill:#0f172a;font-size:16px;font-family:Arial,sans-serif;font-weight:700}"
        "</style>",
        "</defs>",
        f'<rect x="0" y="0" width="{width:g}" height="{height:g}" fill="{escape(background)}" />',
    ]

    for floor in floors:
        if not isinstance(floor, dict):
            continue
        floor_id = escape(str(floor.get("id", "floor")))
        title = escape(str(floor.get("title", floor_id)))
        tx = _num(floor.get("titleX"), 20)
        ty = _num(floor.get("titleY"), 32)
        parts.append(f'<g id="{floor_id}">')
        parts.append(f'<text class="floor-title" x="{tx:g}" y="{ty:g}">{title}</text>')

        elements = floor.get("elements", [])
        if not isinstance(elements, list):
            elements = []

        for el in elements:
            if not isinstance(el, dict):
                continue
            kind = str(el.get("type", "")).lower()
            css = escape(str(el.get("class", "")).strip())
            if kind == "rect":
                x = _num(el.get("x"))
                y = _num(el.get("y"))
                w = _num(el.get("width"))
                h = _num(el.get("height"))
                rx = _num(el.get("rx"))
                cls_attr = f' class="{css}"' if css else ""
                parts.append(
                    f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}"{cls_attr} />'
                )
            elif kind == "circle":
                cx = _num(el.get("cx"))
                cy = _num(el.get("cy"))
                r = _num(el.get("r"), 4)
                cls_attr = f' class="{css}"' if css else ""
                parts.append(f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}"{cls_attr} />')
            elif kind == "path":
                d = escape(str(el.get("d", "")).strip())
                if not d:
                    continue
                cls_attr = f' class="{css}"' if css else ""
                parts.append(f'<path d="{d}"{cls_attr} fill="none" />')
            elif kind == "text":
                x = _num(el.get("x"))
                y = _num(el.get("y"))
                value = escape(str(el.get("value", "")))
                cls_attr = f' class="{css}"' if css else ' class="label"'
                parts.append(f'<text{cls_attr} x="{x:g}" y="{y:g}">{value}</text>')

        parts.append("</g>")

    parts.append("</svg>")
    return "".join(parts)


def map_layout_to_svg(layout: dict[str, Any]) -> str:
    canvas = layout.get("canvas", {})
    width = _num(canvas.get("width"), 1200)
    height = _num(canvas.get("height"), 800)
    view_box = canvas.get("viewBox", f"0 0 {int(width)} {int(height)}")
    background = str(canvas.get("background", "#f6f7fb"))

    floors = layout.get("floors", [])
    if not isinstance(floors, list):
        raise ValueError("map_layout.floors must be a list.")
    return _render_svg_document(width, height, view_box, background, floors)
