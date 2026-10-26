from __future__ import annotations

import re
from copy import deepcopy
from typing import Any


DEFAULT_CONFIG: dict[str, Any] = {
    "width": 1768,
    "height": 930,
    "floorCount": 3,
    "wingCount": 3,
    "roomsPerWing": 8,
    "roomScale": 100,
    "profile": "academic",
    "density": "medium",
    "placementPattern": "double-loaded",
    "offsetX": 0,
    "offsetY": 0,
    "includeBridges": True,
    "includeHallways": True,
    "includeWingBackgrounds": True,
    "includeEntrance": True,
    "includeLounges": True,
    "hallwayThickness": 40,
    "wingLabelMode": "wing",
    "wingRoomScaleOverrides": {},
}

PROFILE_KEYWORDS = {
    # mixed
    "mixed": "mixed",
    "mixed use": "mixed",
    "mixed-use": "mixed",
    "multi-use": "mixed",
    "multi use": "mixed",
    # academic
    "academic": "academic",
    "classroom": "academic",
    "lecture": "academic",
    "university": "academic",
    "campus": "academic",
    "school": "academic",
    "educational": "academic",
    # office
    "office": "office",
    "corporate": "office",
    "commercial": "office",
    "business": "office",
    "workplace": "office",
    # laboratory
    "laboratory": "laboratory",
    "lab": "laboratory",
    "research": "laboratory",
    "science": "laboratory",
    "technical": "laboratory",
}

PATTERN_KEYWORDS = {
    "single-loaded": "single-loaded",
    "single loaded": "single-loaded",
    "one-sided corridor": "single-loaded",
    "one sided corridor": "single-loaded",
    "rooms on one side": "single-loaded",
    "single corridor": "single-loaded",
    "one-sided": "single-loaded",
    "double-loaded": "double-loaded",
    "double loaded": "double-loaded",
    "both sides of a hallway": "double-loaded",
    "both sides of the hallway": "double-loaded",
    "rooms on both sides": "double-loaded",
    "double corridor": "double-loaded",
    "two-sided": "double-loaded",
    "two sided": "double-loaded",
    "clustered": "clustered",
    "cluster": "clustered",
    "grouped": "clustered",
    "pod layout": "clustered",
    "open plan": "clustered",
}


def _clamp(value: int | float, minimum: int | float, maximum: int | float) -> int | float:
    return max(minimum, min(maximum, value))


def _to_bool_toggle(message: str, label: str) -> bool | None:
    # _opt allows: nothing, articles (a/an/all/the/all the), then up to two qualifier words.
    # Covers "Main Entrance", "an office lounge", "all the main bridges", etc.
    _opt = r"(?:all\s+|the\s+|an?\s+|all\s+the\s+)?(?:\w+\s+)?(?:\w+\s+)?"
    # off patterns
    if re.search(rf"\b(no|without|remove|delete|disable|hide|clear|eliminate)\s+{_opt}{label}\b", message):
        return False
    if re.search(rf"\bget\s+rid\s+of\s+{_opt}{label}\b", message):
        return False
    if re.search(rf"\bno\s+more\s+{_opt}{label}\b", message):
        return False
    if re.search(rf"\btake\s+(?:away|out)\s+{_opt}{label}\b", message):
        return False
    if re.search(rf"\b(?:turn|switch|shut)\s+off\s+{_opt}{label}\b", message):
        return False
    # on patterns
    if re.search(rf"\b(with|include|add|enable|show|restore|bring\s+back)\s+{_opt}{label}\b", message):
        return True
    if re.search(rf"\b(?:turn|switch)\s+on\s+{_opt}{label}\b", message):
        return True
    return None


def _extract_first_int(message: str, pattern: str) -> int | None:
    match = re.search(pattern, message)
    if not match:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def _extract_percent(message: str, keywords: list[str]) -> int | None:
    joined = "|".join(re.escape(keyword) for keyword in keywords)
    match = re.search(rf"({joined}).*?(\d{{1,3}})\s*%", message)
    if match:
        return int(match.group(2))
    match = re.search(rf"(\d{{1,3}})\s*%.*?({joined})", message)
    if match:
        return int(match.group(1))
    return None


def _has_any(message: str, tokens: list[str]) -> bool:
    return any(token in message for token in tokens)


def is_undo_request(message: str) -> bool:
    normalized_message = (message or "").strip().lower()
    if not normalized_message:
        return False
    has_revert_qualifier = bool(
        re.search(r"\b(previous|last|prior|that|it)\b", normalized_message)
        or "change" in normalized_message
    )
    return (
        bool(re.search(r"\b(undo|revert|rollback)\b", normalized_message))
        or bool(re.search(r"\bgo\s+back\b", normalized_message))
        or (bool(re.search(r"\b(restore|cancel)\b", normalized_message)) and has_revert_qualifier)
    )


# Fields whose changes are visual-only and do NOT require re-running the floor plan generator.
# wingLabelMode  – only changes the label text on background boxes, no room layout change.
# includeWingBackgrounds – shows/hides the gray wing background overlays, no room layout change.
_VISUAL_ONLY_FIELDS: frozenset[str] = frozenset({"wingLabelMode", "includeWingBackgrounds"})


def _profile_keyword_in_label_context(message: str, keyword: str) -> bool:
    """Return True when a profile keyword appears as a modifier/adjective rather than
    the intended building profile, so the profile scanner is suppressed.

    Two cases:
    (A) Keyword is an adjective before a layout toggle-element noun.
        e.g. "remove an office lounge", "delete the lab entrance",
             "delete the office bridge" — "office"/"lab" describe the element type,
             not the building profile.
    (B) Keyword is a wing/zone *label name* (requires spatial context in message).
        e.g. "label wings as research zones", "call the wings corporate sections".
    """
    escaped = re.escape(keyword)
    _toggle_elements = (
        r"(?:lounge|lounges|entrance|bridge|bridges|hallway|hallways|"
        r"corridor|corridors|background|backgrounds|space|spaces)"
    )
    # Case A: keyword immediately precedes a toggle-element noun
    if re.search(rf"\b{escaped}\s+{_toggle_elements}\b", message):
        return True

    # Case B: keyword is a label name in a spatial/wing context
    _spatial = r"\b(?:wing|wings|zone|zones|area|areas|section|sections|block|blocks)\b"
    if not re.search(_spatial, message):
        return False
    # Note: {{0,3}} becomes {0,3} in the final f-string — quantifies the group, not \s+.
    return bool(
        re.search(
            rf"\b(?:as|to|into|call(?:ed)?)\b(?:\s+\w+){{0,3}}\s+{escaped}\b",
            message,
        )
        or re.search(
            rf"\b(?:name|label|rename|relabel|designate|mark)\b(?:\s+\w+){{0,3}}\s+{escaped}\b",
            message,
        )
    )


class SandboxLayoutArrangerService:
    @classmethod
    def normalize_config(cls, raw: dict[str, Any] | None) -> dict[str, Any]:
        config = deepcopy(DEFAULT_CONFIG)
        if not isinstance(raw, dict):
            return config

        for key, default_value in DEFAULT_CONFIG.items():
            value = raw.get(key, default_value)
            if isinstance(default_value, bool):
                config[key] = bool(value)
            elif isinstance(default_value, dict):
                config[key] = value if isinstance(value, dict) else deepcopy(default_value)
            elif isinstance(default_value, int):
                try:
                    config[key] = int(value)
                except (TypeError, ValueError):
                    config[key] = default_value
            else:
                config[key] = value if isinstance(value, str) and value.strip() else default_value

        config["width"] = int(_clamp(config["width"], 1200, 3200))
        config["height"] = int(_clamp(config["height"], 760, 1800))
        config["floorCount"] = int(_clamp(config["floorCount"], 1, 10))
        config["wingCount"] = int(_clamp(config["wingCount"], 1, 5))
        config["roomsPerWing"] = int(_clamp(config["roomsPerWing"], 1, 30))
        config["roomScale"] = int(_clamp(config.get("roomScale", 100), 60, 140))
        config["offsetX"] = int(_clamp(config["offsetX"], -400, 400))
        config["offsetY"] = int(_clamp(config["offsetY"], -400, 400))
        config["hallwayThickness"] = int(_clamp(config.get("hallwayThickness", 40), 20, 120))
        raw_scales = config.get("wingRoomScaleOverrides", {})
        if isinstance(raw_scales, dict):
            normalized_scales: dict[str, int] = {}
            for wing, value in raw_scales.items():
                if str(wing).upper() not in {"A", "B", "C", "D", "E"}:
                    continue
                try:
                    normalized_scales[str(wing).upper()] = int(_clamp(int(value), 60, 140))
                except (TypeError, ValueError):
                    continue
            config["wingRoomScaleOverrides"] = normalized_scales
        else:
            config["wingRoomScaleOverrides"] = {}
        if config["profile"] not in {"academic", "office", "laboratory", "mixed"}:
            config["profile"] = DEFAULT_CONFIG["profile"]
        if config["density"] not in {"low", "medium", "high"}:
            config["density"] = DEFAULT_CONFIG["density"]
        if config["placementPattern"] not in {"single-loaded", "double-loaded", "clustered"}:
            config["placementPattern"] = DEFAULT_CONFIG["placementPattern"]
        if config["wingLabelMode"] not in {"wing", "area"}:
            config["wingLabelMode"] = DEFAULT_CONFIG["wingLabelMode"]
        return config

    @classmethod
    def build_plan(
        cls,
        message: str,
        current_config: dict[str, Any] | None = None,
        previous_config: dict[str, Any] | None = None,
        current_layout_summary: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_message = (message or "").strip().lower()
        if not normalized_message:
            raise ValueError("A layout instruction is required.")

        base_config = cls.normalize_config(current_config)
        prior_config = cls.normalize_config(previous_config) if isinstance(previous_config, dict) else None
        proposed_config = deepcopy(base_config)
        config_patch: dict[str, Any] = {}
        commands: list[dict[str, str]] = []
        warnings: list[str] = []
        assumptions: list[str] = []
        force_regeneration: bool = False  # set True when regeneration is needed but no config change is made

        # ── undo / revert ────────────────────────────────────────────────────
        # "undo", "revert", "go back", "rollback" are unambiguous — no qualifier needed.
        # "restore" / "cancel" need a qualifier to avoid colliding with toggle phrases
        # like "restore bridges" or "cancel the entrance".
        undo_request = is_undo_request(normalized_message)
        if undo_request:
            if prior_config is None:
                # No history found — return early with a clear message.
                return {
                    "ok": True,
                    "reply": "No previous change found to revert. Make a layout change first, then use 'Revert last change'.",
                    "configPatch": {},
                    "baseConfig": base_config,
                    "proposedConfig": proposed_config,
                    "commands": [],
                    "warnings": ["No previous change is available to revert yet."],
                    "assumptions": [],
                    "requiresRegeneration": False,
                }

            changed_fields = [
                key for key, value in prior_config.items() if base_config.get(key) != value
            ]

            if not changed_fields:
                # Prior config == current config — the last action was a canvas-only
                # deletion (deleteAllElements). The config still has the elements enabled,
                # so regenerating the layout will restore them.
                return {
                    "ok": True,
                    "reply": "The previous action deleted canvas elements without changing the configuration. Regenerating the layout will restore the deleted elements.",
                    "configPatch": {},
                    "baseConfig": base_config,
                    "proposedConfig": proposed_config,
                    "commands": [],
                    "warnings": [],
                    "assumptions": ["Interpreted the request as reverting a canvas deletion — regenerating with the current configuration to restore deleted elements."],
                    "requiresRegeneration": True,
                }

            for field in changed_fields:
                previous_value = prior_config[field]
                config_patch[field] = deepcopy(previous_value)
                command_type = "setGeneratorConfig"
                if field == "hallwayThickness":
                    command_type = "resizeHallway"
                elif field == "roomsPerWing":
                    command_type = "rebalanceRooms"
                elif field in {"offsetX", "offsetY"}:
                    command_type = "moveWing"
                elif field == "wingRoomScaleOverrides":
                    command_type = "resizeRooms"
                commands.append({"type": command_type, "field": field, "value": str(previous_value).lower() if isinstance(previous_value, bool) else str(previous_value)})
            assumptions.append("Interpreted the request as reverting the most recent preview change.")
            proposed_config.update(config_patch)
            proposed_config = cls.normalize_config(proposed_config)
            undo_requires_regen = bool(config_patch) and any(
                f not in _VISUAL_ONLY_FIELDS for f in config_patch
            )
            if undo_requires_regen:
                reply = "I reverted the layout to the previous configuration."
            else:
                reply = "I reverted the display settings to the previous state. The room layout was preserved."
            return {
                "ok": True,
                "reply": reply,
                "configPatch": config_patch,
                "baseConfig": base_config,
                "proposedConfig": proposed_config,
                "commands": commands,
                "warnings": warnings,
                "assumptions": assumptions,
                "requiresRegeneration": undo_requires_regen,
            }

        # ── reset to defaults ────────────────────────────────────────────────
        _reset_default_request = _has_any(normalized_message, [
            "reset to default", "reset to defaults", "restore defaults", "restore default settings",
            "use default settings", "start fresh", "start over",
            "reset all settings", "reset everything", "back to defaults", "factory reset",
        ]) or bool(re.search(r"\breset\s+(?:all\s+)?(?:settings|configuration|config)\b", normalized_message))
        if _reset_default_request:
            for field, default_value in DEFAULT_CONFIG.items():
                if proposed_config.get(field) != default_value:
                    config_patch[field] = deepcopy(default_value)
                    commands.append({
                        "type": "setGeneratorConfig",
                        "field": field,
                        "value": str(default_value).lower() if isinstance(default_value, bool) else str(default_value),
                    })
            assumptions.append(
                "Interpreted the request as resetting all layout configuration to default settings."
            )

        # ── regenerate with same settings ────────────────────────────────────
        _regen_same_request = (
            not _reset_default_request
            and _has_any(normalized_message, [
                "regenerate", "generate again", "redo the layout", "redo layout",
                "refresh the layout", "refresh layout", "rebuild the layout",
                "fresh generation", "new generation",
            ])
            and not _has_any(normalized_message, [
                "hallway", "corridor", "room", "floor", "wing", "bridge",
                "lounge", "entrance", "wider", "taller", "smaller", "larger",
            ])
        )
        if _regen_same_request and not _reset_default_request:
            force_regeneration = True
            assumptions.append(
                "Interpreted the request as regenerating the layout with the current configuration settings."
            )

        # ── profile ──────────────────────────────────────────────────────────
        # Use word-boundary matching so "lab" doesn't fire inside "labels",
        # "office" doesn't fire inside "offices", etc.
        # Also guard against the keyword being used as a wing *label name*
        # ("label wings as research zones" must NOT change profile to laboratory).
        for key, value in PROFILE_KEYWORDS.items():
            if (
                re.search(rf"\b{re.escape(key)}\b", normalized_message)
                and not _profile_keyword_in_label_context(normalized_message, key)
            ):
                config_patch["profile"] = value
                commands.append({"type": "setGeneratorConfig", "field": "profile", "value": value})
                break

        # Room-type noun pattern (room synonyms used throughout this section)
        _room_noun = r"(?:room|classroom|office|lab(?:oratory)?|workspace|workstation)s?"
        # Wing reference in this message (used for assumption notes below)
        _wing_in_msg = re.search(r"\bwing\s+([abcde])\b", normalized_message)
        direct_delete_all_rooms = bool(
            re.search(
                rf"\b(?:delete|remove|eliminate|clear|take\s+out)\s+(?:all|all\s+the)\s+{_room_noun}\b",
                normalized_message,
            )
        )
        # "horizontal hallways/corridors" = cross-wing bridge connectors, NOT all hallways.
        # Detect that phrase first so the generic delete-all doesn't swallow it.
        _horizontal_hallway_request = bool(
            re.search(
                r"\b(?:delete|remove|eliminate|clear|take\s+out|disable|hide|get\s+rid\s+of|no)\s+"
                r"(?:all\s+|all\s+the\s+)?(?:the\s+)?horizontal\s+(?:hallway|hallways|corridor|corridors)\b",
                normalized_message,
            )
        )
        direct_delete_all_hallways = (
            not _horizontal_hallway_request
            and bool(
                re.search(
                    r"\b(?:delete|remove|eliminate|clear|take\s+out)\s+(?:all|all\s+the)\s+(?:hallway|hallways|corridor|corridors)\b",
                    normalized_message,
                )
            )
        )
        direct_delete_all_lounges = bool(
            re.search(
                r"\b(?:delete|remove|eliminate|clear|take\s+out)\s+(?:all\s+|all\s+the\s+|the\s+|an?\s+)?(?:\w+\s+)?(?:\w+\s+)?lounges?\b",
                normalized_message,
            )
        )
        # Bridges, entrance, and wing backgrounds use config-flag changes (not canvas deletes)
        # because the frontend removes them via regeneration, not direct element deletion.
        # direct_delete_bridges / entrance / wing_backgrounds are intentionally always False
        # so the toggle loop handles them with includeX = False → regeneration.
        direct_delete_bridges = False
        direct_delete_entrance = False
        direct_delete_wing_backgrounds = False

        # ── rooms per wing – delete/add N [room-type] ─────────────────────────
        # These N-based patterns run FIRST so "add 3 more classrooms" is NOT
        # caught as a generic +2 "more rooms" relative change.
        # Nouns that signal a toggle operation — prevent "remove an office lounge"
        # from being treated as a room-count delete when the room noun is an adjective.
        _toggle_nouns = (
            r"(?:lounge|lounges|entrance|bridge|bridges|hallway|hallways|"
            r"corridor|corridors|background|backgrounds|space|spaces)"
        )
        if direct_delete_all_rooms:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "room"})
            assumptions.append(
                "Interpreted the request as deleting all room elements from the current layout canvas rather than regenerating the layout."
            )

        if "roomsPerWing" not in config_patch and not direct_delete_all_rooms:
            def _wing_note() -> str:
                if _wing_in_msg:
                    return (
                        f" Wing {_wing_in_msg.group(1).upper()} was referenced, but rooms per wing "
                        "is a global setting — this change applies to all wings."
                    )
                return ""

            # DELETE N [room-type] [in/from Wing X]
            _delete_n = _extract_first_int(
                normalized_message,
                rf"\b(?:delete|remove|cut|take\s+out|eliminate)\s+(\d+)\s+{_room_noun}\b",
            )
            if _delete_n is not None:
                next_value = int(_clamp(base_config["roomsPerWing"] - _delete_n, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append(
                    f"Interpreted as deleting {_delete_n} room(s), reducing rooms per wing "
                    f"from {base_config['roomsPerWing']} to {next_value}.{_wing_note()}"
                )

            # DELETE A / ONE / THE [room-type] → remove 1
            # Negative lookahead prevents "remove an office lounge" from firing when
            # the room noun is actually an adjective modifying a toggle element noun.
            elif re.search(
                rf"\b(?:delete|remove|cut|take\s+out|eliminate)\s+(?:a|an|one|the)\s+{_room_noun}"
                rf"(?!\s+{_toggle_nouns})\b",
                normalized_message,
            ):
                next_value = int(_clamp(base_config["roomsPerWing"] - 1, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append(
                    f"Interpreted as removing one room, reducing rooms per wing "
                    f"from {base_config['roomsPerWing']} to {next_value}.{_wing_note()}"
                )

            # ADD N [more] [room-type] [to/in Wing X]
            _add_n = _extract_first_int(
                normalized_message,
                rf"\b(?:add|include|insert|put|place)\s+(\d+)\s+(?:more\s+)?{_room_noun}\b",
            )
            if _add_n is not None and "roomsPerWing" not in config_patch:
                next_value = int(_clamp(base_config["roomsPerWing"] + _add_n, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append(
                    f"Interpreted as adding {_add_n} room(s), increasing rooms per wing "
                    f"from {base_config['roomsPerWing']} to {next_value}.{_wing_note()}"
                )

            # ADD A / ONE / ANOTHER [room-type] → add 1
            elif (
                re.search(
                    rf"\b(?:add|include|insert|put|place)\s+(?:a|an|one|another)\s+{_room_noun}\b",
                    normalized_message,
                )
                and "roomsPerWing" not in config_patch
            ):
                next_value = int(_clamp(base_config["roomsPerWing"] + 1, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append(
                    f"Interpreted as adding one room, increasing rooms per wing "
                    f"from {base_config['roomsPerWing']} to {next_value}.{_wing_note()}"
                )

        # ── rooms per wing – relative (no explicit count) ─────────────────────
        if "roomsPerWing" not in config_patch:
            if _has_any(normalized_message, [
                "fewer rooms", "less rooms", "reduce number of rooms",
                "decrease number of rooms", "reduce room count", "decrease room count",
                "cut rooms", "remove rooms", "trim rooms",
                "delete rooms", "delete classrooms", "delete offices", "delete labs",
                "eliminate rooms", "eliminate classrooms",
                "fewer classrooms", "fewer offices", "fewer labs",
                "less classrooms", "less offices", "less labs",
            ]):
                next_value = int(_clamp(base_config["roomsPerWing"] - 2, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append("Interpreted the request as reducing rooms per wing by 2.")
            elif _has_any(normalized_message, [
                "more rooms", "increase number of rooms", "increase room count",
                "add more rooms", "add rooms", "more classrooms", "more offices", "more labs",
                "need more rooms", "want more rooms", "more workspaces", "more workstations",
            ]):
                next_value = int(_clamp(base_config["roomsPerWing"] + 2, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append("Interpreted the request as increasing rooms per wing by 2.")

        # ── rooms per wing – absolute ─────────────────────────────────────────
        if "roomsPerWing" not in config_patch:
            # Extended to recognise room-type synonyms (classroom, office, lab, etc.)
            rooms_per_wing = _extract_first_int(
                normalized_message, rf"(\d+)\s+{_room_noun}(?:\s+per\s+wing)?"
            )
            if rooms_per_wing is None:
                # "room count to N" / "set room count N"
                rooms_per_wing = _extract_first_int(
                    normalized_message,
                    r"room\s+count(?:\s+for\s+(?:each\s+)?wing)?(?:\s+\w+)*?\s+to\s+(\d+)",
                )
            if rooms_per_wing is None:
                rooms_per_wing = _extract_first_int(
                    normalized_message,
                    r"(?:change|set|make|increase|decrease|adjust)\s+room\s+count(?:\s+for\s+(?:each\s+)?wing)?(?:\s+\w+)*?\s+(\d+)",
                )
            if rooms_per_wing is None:
                rooms_per_wing = _extract_first_int(
                    normalized_message,
                    rf"each\s+wing\s+(?:should\s+have\s+|needs?\s+|with\s+)?(\d+)\s+{_room_noun}",
                )
            # "Wing X should have / needs / give Wing X / I want N in Wing X"
            if rooms_per_wing is None and _wing_in_msg:
                wl = _wing_in_msg.group(1)
                rooms_per_wing = (
                    _extract_first_int(
                        normalized_message,
                        rf"\bwing\s+{wl}\s+(?:should\s+have|needs?|must\s+have|will\s+have)\s+(\d+)\s+{_room_noun}\b",
                    )
                    or _extract_first_int(
                        normalized_message,
                        rf"\b(?:give|set|make)\s+wing\s+{wl}\s+(?:to\s+)?(\d+)\s+{_room_noun}\b",
                    )
                    or _extract_first_int(
                        normalized_message,
                        rf"\bi\s+want\s+(\d+)\s+{_room_noun}\s+in\s+wing\s+{wl}\b",
                    )
                )
            if rooms_per_wing is not None:
                next_value = int(_clamp(rooms_per_wing, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "roomsPerWing", "value": str(next_value)})

        # ── room scale – explicit percentage ──────────────────────────────────
        explicit_room_scale = _extract_first_int(
            normalized_message,
            r"(?:set|change|adjust|use|apply)\s+room\s*(?:scale|size)s?\s+(?:to\s+)?(\d{2,3})\s*%",
        )
        if explicit_room_scale is None:
            explicit_room_scale = _extract_first_int(
                normalized_message,
                r"room\s*(?:scale|size)\s+(?:at|to|of|=)\s*(\d{2,3})\s*%",
            )
        if explicit_room_scale is not None and "roomScale" not in config_patch:
            next_value = int(_clamp(explicit_room_scale, 60, 140))
            config_patch["roomScale"] = next_value
            commands.append({"type": "resizeRooms", "field": "roomScale", "value": str(next_value)})

        # ── room scale – relative ─────────────────────────────────────────────
        room_percent = _extract_percent(normalized_message, ["room", "rooms"])
        if "roomScale" not in config_patch:
            room_size_increase_request = bool(
                re.search(
                    r"\b(?:increase|expand|enlarge|grow|scale\s+up)\s+"
                    r"(?:all\s+|the\s+|generated\s+|all\s+generated\s+)?"
                    r"rooms?(?:\s+size|\s+sizes)?\b",
                    normalized_message,
                )
                or re.search(
                    r"\bmake\s+(?:all\s+|the\s+|generated\s+)?rooms?\s+"
                    r"(?:bigger|larger|wider|taller)\b",
                    normalized_message,
                )
                or re.search(
                    r"\b(?:larger|bigger)\s+(?:all\s+|the\s+|generated\s+)?rooms?\b",
                    normalized_message,
                )
            )
            room_size_decrease_request = bool(
                re.search(
                    r"\b(?:decrease|reduce|shrink|compress|scale\s+down)\s+"
                    r"(?:all\s+|the\s+|generated\s+|all\s+generated\s+)?"
                    r"rooms?(?:\s+size|\s+sizes)?\b",
                    normalized_message,
                )
                or re.search(
                    r"\bmake\s+(?:all\s+|the\s+|generated\s+)?rooms?\s+"
                    r"(?:smaller|narrower|shorter)\b",
                    normalized_message,
                )
                or re.search(
                    r"\bsmaller\s+(?:all\s+|the\s+|generated\s+)?rooms?\b",
                    normalized_message,
                )
            )
            if room_percent is not None and _has_any(normalized_message, ["larger", "bigger", "increase", "expand", "wider", "taller"]):
                next_value = int(_clamp(round(base_config["roomScale"] * (1 + room_percent / 100.0)), 60, 140))
                config_patch["roomScale"] = next_value
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": str(next_value)})
            elif room_percent is not None and _has_any(normalized_message, ["smaller", "decrease", "reduce", "shrink", "narrower", "shorter"]):
                next_value = int(_clamp(round(base_config["roomScale"] * (1 - room_percent / 100.0)), 60, 140))
                config_patch["roomScale"] = next_value
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": str(next_value)})
            elif room_size_increase_request or _has_any(normalized_message, ["increase room sizes", "increase room size", "larger rooms", "bigger rooms", "make rooms bigger", "expand rooms", "make rooms larger", "scale up rooms"]):
                next_value = int(_clamp(round(base_config["roomScale"] * 1.15), 60, 140))
                config_patch["roomScale"] = next_value
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": str(next_value)})
                assumptions.append("Interpreted the room size request as increasing all generated room sizes by 15%.")
            elif room_size_decrease_request or _has_any(normalized_message, ["decrease room sizes", "decrease room size", "smaller rooms", "make rooms smaller", "shrink rooms", "reduce room sizes", "make rooms smaller", "scale down rooms"]):
                next_value = int(_clamp(round(base_config["roomScale"] * 0.85), 60, 140))
                config_patch["roomScale"] = next_value
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": str(next_value)})
                assumptions.append("Interpreted the room size request as reducing all generated room sizes by 15%.")

        # ── room size presets (wide / narrow / compact / spacious) ───────────
        if "roomScale" not in config_patch:
            if _has_any(normalized_message, [
                "wide rooms", "wider rooms", "use wide rooms", "wide room style",
            ]):
                config_patch["roomScale"] = 120
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": "120"})
                assumptions.append("Interpreted 'wide rooms' as setting room scale to 120% of base size.")
            elif _has_any(normalized_message, [
                "narrow rooms", "narrower rooms", "use narrow rooms", "narrow room style",
                "thin rooms", "slim rooms",
            ]):
                config_patch["roomScale"] = 80
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": "80"})
                assumptions.append("Interpreted 'narrow rooms' as setting room scale to 80% of base size.")
            elif _has_any(normalized_message, [
                "compact rooms", "use compact rooms", "very small rooms", "tiny rooms",
                "miniature rooms",
            ]):
                config_patch["roomScale"] = 70
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": "70"})
                assumptions.append("Interpreted 'compact rooms' as setting room scale to 70% of base size.")
            elif _has_any(normalized_message, [
                "spacious rooms", "roomy layout", "large rooms", "use spacious rooms",
                "extra large rooms", "oversized rooms",
            ]):
                config_patch["roomScale"] = 130
                commands.append({"type": "resizeRooms", "field": "roomScale", "value": "130"})
                assumptions.append("Interpreted 'spacious rooms' as setting room scale to 130% of base size.")

        # ── max / min room count ──────────────────────────────────────────────
        if "roomsPerWing" not in config_patch:
            if _has_any(normalized_message, [
                "max rooms", "max out rooms", "maximum rooms", "maximum number of rooms",
                "as many rooms as possible", "fill with rooms",
            ]):
                config_patch["roomsPerWing"] = 30
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": "30"})
                assumptions.append("Interpreted the request as using the maximum rooms per wing (30).")
            elif _has_any(normalized_message, [
                "min rooms", "minimum rooms", "minimum number of rooms",
                "as few rooms as possible", "just one room",
                "one room per wing", "single room per wing",
            ]):
                config_patch["roomsPerWing"] = 1
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": "1"})
                assumptions.append("Interpreted the request as using the minimum rooms per wing (1).")

        # ── alignment cleanup ─────────────────────────────────────────────────
        # Three-condition form: alignment keyword + space keyword + fix verb
        # (e.g. "Fix all hallway alignments", "Correct corridor alignment")
        _align_kw   = ["align", "alignment", "alignments", "aligned", "misaligned", "realign", "realigned"]
        _space_kw   = ["hallway", "hallways", "corridor", "corridors", "room", "rooms"]
        _fix_kw     = ["fix", "adjust", "clean up", "improve", "correct", "straighten", "realign", "resolve"]
        alignment_cleanup_request = (
            (
                _has_any(normalized_message, _align_kw)
                and _has_any(normalized_message, _space_kw)
                and _has_any(normalized_message, _fix_kw)
            )
            # Imperative "align / realign [the/all/all the] [hallways/corridors/rooms]"
            or bool(re.search(
                r"\b(?:re)?align\s+(?:all\s+|the\s+|all\s+the\s+)?(?:hallway|corridor|room)s?\b",
                normalized_message,
            ))
            # Imperative "straighten [out] [the/all] [hallways/corridors/rooms]"
            or bool(re.search(
                r"\bstraighten\s+(?:out\s+)?(?:all\s+|the\s+|all\s+the\s+)?(?:hallway|corridor|room)s?\b",
                normalized_message,
            ))
        )
        if alignment_cleanup_request:
            # Hallway alignment is a generation-time property — the generator places corridors
            # based on the current config, and minor misalignments are a natural variance.
            # Changing parameters like room scale does not fix alignment; it just changes scale.
            # The correct fix is to regenerate with the same settings.
            force_regeneration = True
            assumptions.append(
                "Interpreted the request as regenerating the layout to resolve hallway alignment. "
                "Corridor alignment is determined during generation — a fresh generation with the "
                "same settings produces new corridor positions and typically resolves alignment issues."
            )

        # ── wing label mode ───────────────────────────────────────────────────
        # An Architect might use any natural phrasing to name/rename wing sections.
        # "Area" mode: wings are displayed as zones/areas/sections/blocks.
        # "Wing" mode: wings are displayed as Wing A/B/C.
        _label_verbs = r"\b(?:label|name|rename|relabel|designate|mark|call)\b"
        _area_nouns  = r"\b(?:area|zone|section|block)s?\b"
        _wing_nouns  = r"\bwings?\b"
        _gray_target = r"\bgray\s+(?:box|boxes|area|areas|region|regions|background|backgrounds)\b"
        _positional_gray_target = (
            r"\b(?:left|right|center|middle|first|last)\s+gray\s+"
            r"(?:box|boxes|area|areas|region|regions|background|backgrounds)\b"
        )
        _specific_gray_label_request = bool(
            re.search(_label_verbs, normalized_message)
            and re.search(_positional_gray_target, normalized_message)
            and (
                re.search(r"\bwing(?:s)?(?:\s+[a-e1-5])?\b", normalized_message)
                or re.search(_area_nouns, normalized_message)
            )
        )

        _to_area = _has_any(normalized_message, [
            # original exact phrases
            "label left and right gray boxes as areas", "label gray boxes as areas",
            "label the gray boxes as areas", "label wings as areas",
            "show area labels", "use area labels", "name them areas", "name the wings as areas",
            "call them areas", "call the wings areas",
            # zone / section / block synonyms
            "label wings as zones", "label wings as sections", "label wings as blocks",
            "name them zones", "name them sections", "name them blocks",
            "call them zones", "call them sections", "call them blocks",
            "show zone labels", "use zone labels", "area labels", "zone labels",
            "rename wings to zones", "rename wings to areas", "rename wings to sections",
            "relabel wings as areas", "relabel wings as zones", "relabel wings as sections",
            "designate wings as areas", "designate wings as zones", "designate wings as sections",
            "mark wings as areas", "mark wings as zones",
            "switch to area mode", "switch to zone mode",
            # singular gray box with position qualifier → area/zone
            "label the left gray box as area", "label the right gray box as area",
            "label the center gray box as area", "label the left gray box as zone",
            "label the right gray box as zone", "label left gray box as area",
            "label right gray box as area",
        ]) or bool(
            # "label/name/… [the/all/N] wings as/into zones/areas/sections"
            re.search(_label_verbs, normalized_message)
            and re.search(_wing_nouns, normalized_message)
            and re.search(_area_nouns, normalized_message)
        ) or bool(
            # "label/name/call … gray box/area/region/background … area/zone/section"
            re.search(r"\b(?:label|name|call|rename|set)\b.*" + _gray_target + r".*\b(?:area|zone|section)\b",
                      normalized_message)
        )

        _to_wing = _has_any(normalized_message, [
            # original exact phrases
            "label left and right gray boxes as wings", "label gray boxes as wings",
            "label the gray boxes as wings", "label areas as wings",
            "show wing labels", "use wing labels", "name them wings", "name the areas as wings",
            "call them wings", "call the areas wings",
            # extras
            "label zones as wings", "label sections as wings",
            "rename areas to wings", "rename zones to wings", "rename sections to wings",
            "relabel areas as wings", "relabel zones as wings",
            "show wing names", "use wing names",
            "switch to wing mode", "switch back to wings",
            # singular gray box with position qualifier → wing (left/right/center/first/last)
            "label the left gray box as wing", "label the right gray box as wing",
            "label the center gray box as wing", "label the middle gray box as wing",
            "label the first gray box as wing", "label the last gray box as wing",
            "label left gray box as wing", "label right gray box as wing",
            "label the gray box as wing",
            "name the left gray box wing", "name the right gray box wing",
            "call the left gray box wing", "call the right gray box wing",
        ]) or bool(
            # "label/name/… zones/areas/sections as/to wings"
            re.search(_label_verbs, normalized_message)
            and re.search(_area_nouns, normalized_message)
            and re.search(r"\b(?:as|to|back\s+to)\s+wings?\b", normalized_message)
        ) or bool(
            # "label/name/call … gray box/area/region/background … wing [letter or number]"
            re.search(r"\b(?:label|name|call|rename|set)\b.*" + _gray_target + r".*\bwing\b",
                      normalized_message)
        ) or bool(
            # "label … wing [1-5 or a-e]"  e.g. "label the left gray box as Wing 1"
            re.search(r"\b(?:label|name|call|rename)\b.*\bwing\s+[a-e1-5]\b",
                      normalized_message)
        )

        if _to_area and not _to_wing:
            config_patch["wingLabelMode"] = "area"
            commands.append({"type": "setGeneratorConfig", "field": "wingLabelMode", "value": "area"})
            _specific_note = ""
            if _specific_gray_label_request:
                _specific_note = (
                    " Specific left/right gray-area targeting is not configurable yet, so this "
                    "applies the area/zone label style to all wing background labels."
                )
            assumptions.append(
                "Interpreted the request as switching wing background labels to area/zone mode. "
                "The room layout will not be regenerated — only the label display changes."
                + _specific_note
            )
        elif _to_wing:
            config_patch["wingLabelMode"] = "wing"
            commands.append({"type": "setGeneratorConfig", "field": "wingLabelMode", "value": "wing"})
            _note = ""
            if re.search(r"\bwing\s+\d+\b", normalized_message):
                _note = (
                    " Note: the generator labels wings with letters (Wing A, Wing B, Wing C…); "
                    "'Wing 1' displays as Wing A, 'Wing 2' as Wing B, and so on."
                )
            if _specific_gray_label_request:
                _note += (
                    " Specific left/right gray-area targeting is not configurable yet, so this "
                    "applies wing labels globally across the wing background boxes."
                )
            assumptions.append(
                "Interpreted the request as switching wing background labels to wing mode. "
                "The room layout will not be regenerated — only the label display changes."
                + _note
            )

        # Hiding the wing-label overlay entirely (does not change the mode, removes the boxes)
        if _has_any(normalized_message, [
            "hide wing labels", "hide the wing labels", "remove wing labels",
            "no wing labels", "without wing labels", "hide wing name labels",
        ]) and "includeWingBackgrounds" not in config_patch:
            config_patch["includeWingBackgrounds"] = False
            commands.append({"type": "setGeneratorConfig", "field": "includeWingBackgrounds", "value": "false"})
            assumptions.append(
                "Interpreted 'hide wing labels' as removing the wing background boxes that display the labels. "
                "Use 'show wing labels' or 'add wing backgrounds' to restore them."
            )

        # ── floor count – absolute ────────────────────────────────────────────
        # Guard: "add 3 floors" / "remove 2 floors" are relative changes handled below;
        # don't let the absolute pattern swallow them.
        _is_relative_floor_phrase = bool(
            re.search(r"\b(?:add|remove|delete|drop|cut)\s+\d+\s+(?:more\s+)?floors?\b", normalized_message)
        )
        floor_count = None if _is_relative_floor_phrase else _extract_first_int(normalized_message, r"(\d+)\s+floors?")
        if floor_count is None:
            floor_count = _extract_first_int(normalized_message, r"(\d+)[\s-]stor(?:e(?:y|ys)|ies|y)")
        if floor_count is None:
            floor_count = _extract_first_int(normalized_message, r"(\d+)\s+levels?")
        if floor_count is not None:
            next_value = int(_clamp(floor_count, 1, 10))
            config_patch["floorCount"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})

        # ── canvas width ──────────────────────────────────────────────────────
        layout_width = _extract_first_int(normalized_message, r"(\d+)\s*(?:px|pixels?)?\s*(?:wide|width)")
        if layout_width is not None:
            next_value = int(_clamp(layout_width, 1200, 3200))
            config_patch["width"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "width", "value": str(next_value)})
        elif _has_any(normalized_message, ["make it wider", "increase width", "wider layout", "more horizontal space", "expand the canvas", "stretch it wider", "widen the canvas"]):
            next_value = int(_clamp(base_config["width"] + 160, 1200, 3200))
            config_patch["width"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "width", "value": str(next_value)})
            assumptions.append("Interpreted the width request as widening the preview canvas by 160 px.")
        elif _has_any(normalized_message, ["make it narrower", "decrease width", "narrower layout", "less horizontal space", "compress the canvas"]):
            next_value = int(_clamp(base_config["width"] - 160, 1200, 3200))
            config_patch["width"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "width", "value": str(next_value)})
            assumptions.append("Interpreted the width request as narrowing the preview canvas by 160 px.")

        # ── canvas width – percentage-based relative ──────────────────────────
        if "width" not in config_patch:
            _width_pct_increase = re.search(
                r"(\d{1,3})\s*%\s*wider|wider\s+by\s+(\d{1,3})\s*%|increase\s+(?:the\s+)?(?:canvas\s+)?width\s+by\s+(\d{1,3})\s*%",
                normalized_message,
            )
            _width_pct_decrease = re.search(
                r"(\d{1,3})\s*%\s*narrower|narrower\s+by\s+(\d{1,3})\s*%|(?:decrease|reduce)\s+(?:the\s+)?(?:canvas\s+)?width\s+by\s+(\d{1,3})\s*%",
                normalized_message,
            )
            if _width_pct_increase:
                pct = int(next(g for g in _width_pct_increase.groups() if g is not None))
                next_value = int(_clamp(round(base_config["width"] * (1 + pct / 100.0)), 1200, 3200))
                config_patch["width"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "width", "value": str(next_value)})
                assumptions.append(f"Interpreted the width request as increasing canvas width by {pct}% (to {next_value} px).")
            elif _width_pct_decrease:
                pct = int(next(g for g in _width_pct_decrease.groups() if g is not None))
                next_value = int(_clamp(round(base_config["width"] * (1 - pct / 100.0)), 1200, 3200))
                config_patch["width"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "width", "value": str(next_value)})
                assumptions.append(f"Interpreted the width request as reducing canvas width by {pct}% (to {next_value} px).")

        # ── canvas height ─────────────────────────────────────────────────────
        layout_height = _extract_first_int(normalized_message, r"(\d+)\s*(?:px|pixels?)?\s*(?:tall|height)")
        if layout_height is None:
            layout_height = _extract_first_int(normalized_message, r"(?:height|tall)\s+(?:to\s+)?(\d+)\s*(?:px|pixels?)?")
        if layout_height is not None and "wing " not in normalized_message:
            next_value = int(_clamp(layout_height, 760, 1800))
            config_patch["height"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "height", "value": str(next_value)})
        elif _has_any(normalized_message, ["make it taller", "increase height", "taller layout", "more vertical space", "extend vertically"]) and "wing " not in normalized_message:
            next_value = int(_clamp(base_config["height"] + 120, 760, 1800))
            config_patch["height"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "height", "value": str(next_value)})
            assumptions.append("Interpreted the height request as increasing the preview canvas height by 120 px.")
        elif _has_any(normalized_message, ["make it shorter", "decrease height", "shorter layout", "less vertical space"]) and "wing " not in normalized_message:
            next_value = int(_clamp(base_config["height"] - 120, 760, 1800))
            config_patch["height"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "height", "value": str(next_value)})
            assumptions.append("Interpreted the height request as reducing the preview canvas height by 120 px.")

        # ── canvas height – percentage-based relative ─────────────────────────
        if "height" not in config_patch and "wing " not in normalized_message:
            _height_pct_increase = re.search(
                r"(\d{1,3})\s*%\s*taller|taller\s+by\s+(\d{1,3})\s*%|increase\s+(?:the\s+)?(?:canvas\s+)?height\s+by\s+(\d{1,3})\s*%",
                normalized_message,
            )
            _height_pct_decrease = re.search(
                r"(\d{1,3})\s*%\s*shorter|shorter\s+by\s+(\d{1,3})\s*%|(?:decrease|reduce)\s+(?:the\s+)?(?:canvas\s+)?height\s+by\s+(\d{1,3})\s*%",
                normalized_message,
            )
            if _height_pct_increase:
                pct = int(next(g for g in _height_pct_increase.groups() if g is not None))
                next_value = int(_clamp(round(base_config["height"] * (1 + pct / 100.0)), 760, 1800))
                config_patch["height"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "height", "value": str(next_value)})
                assumptions.append(f"Interpreted the height request as increasing canvas height by {pct}% (to {next_value} px).")
            elif _height_pct_decrease:
                pct = int(next(g for g in _height_pct_decrease.groups() if g is not None))
                next_value = int(_clamp(round(base_config["height"] * (1 - pct / 100.0)), 760, 1800))
                config_patch["height"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "height", "value": str(next_value)})
                assumptions.append(f"Interpreted the height request as reducing canvas height by {pct}% (to {next_value} px).")

        # ── remove specific floor ─────────────────────────────────────────────
        remove_floor_match = re.search(r"\b(remove|delete|remvoe|drop|cut)\s+floor\s+(\d+)\b", normalized_message)
        if not remove_floor_match:
            remove_floor_match = re.search(r"\b(remove|delete|remvoe|drop|cut)\s+(?:the\s+)?(\d+)(?:st|nd|rd|th)\s+floor\b", normalized_message)
        if not remove_floor_match:
            remove_floor_match = re.search(r"\b(remove|delete|remvoe|drop|cut)\s+level\s+(\d+)\b", normalized_message)
        if remove_floor_match:
            target_floor = int(remove_floor_match.group(2))
            current_floor_count = int(base_config["floorCount"])
            if current_floor_count <= 1:
                warnings.append("The layout already has only one floor, so no floor can be removed.")
            else:
                next_value = current_floor_count - 1
                config_patch["floorCount"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})
                if target_floor != current_floor_count:
                    assumptions.append(
                        f"Interpreted 'remove floor {target_floor}' as reducing the generated layout from {current_floor_count} floors to {next_value}, because selective middle-floor removal is not supported yet."
                    )
                else:
                    assumptions.append(
                        f"Interpreted 'remove floor {target_floor}' as trimming the top floor and regenerating a {next_value}-floor layout."
                    )

        # ── add / remove multiple floors relatively (with explicit count) ───────
        if "floorCount" not in config_patch:
            _add_n_floors = _extract_first_int(
                normalized_message,
                r"\badd\s+(\d+)\s+(?:more\s+)?floors?\b",
            )
            _remove_n_floors = _extract_first_int(
                normalized_message,
                r"\b(?:remove|delete|drop|cut)\s+(\d+)\s+floors?\b",
            )
            if _add_n_floors is not None and _add_n_floors > 1:
                next_value = int(_clamp(base_config["floorCount"] + _add_n_floors, 1, 10))
                config_patch["floorCount"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})
                assumptions.append(f"Interpreted the request as adding {_add_n_floors} more floor(s), increasing floor count to {next_value}.")
            elif _remove_n_floors is not None and _remove_n_floors > 1:
                current_floor_count = int(base_config["floorCount"])
                if current_floor_count <= 1:
                    warnings.append("The layout already has only one floor, so no floor can be removed.")
                else:
                    next_value = int(_clamp(current_floor_count - _remove_n_floors, 1, 10))
                    config_patch["floorCount"] = next_value
                    commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})
                    assumptions.append(f"Interpreted the request as removing {_remove_n_floors} floor(s), reducing floor count to {next_value}.")

        # ── add / remove floor relatively (no number) ─────────────────────────
        if "floorCount" not in config_patch:
            if re.search(r"\badd\s+(?:a\s+|an?\s+extra\s+|another\s+|one\s+more\s+)?floor\b", normalized_message):
                next_value = int(_clamp(base_config["floorCount"] + 1, 1, 10))
                config_patch["floorCount"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})
                assumptions.append("Interpreted the request as adding one more floor to the layout.")
            elif re.search(r"\b(remove|delete|drop|take\s+out|cut)\s+(?:a\s+|one\s+|the\s+top\s+)floor\b", normalized_message):
                current_floor_count = int(base_config["floorCount"])
                if current_floor_count <= 1:
                    warnings.append("The layout already has only one floor, so no floor can be removed.")
                else:
                    next_value = current_floor_count - 1
                    config_patch["floorCount"] = next_value
                    commands.append({"type": "setGeneratorConfig", "field": "floorCount", "value": str(next_value)})
                    assumptions.append(f"Interpreted the request as removing the top floor, reducing to {next_value} floor(s).")

        # ── wing count ────────────────────────────────────────────────────────
        # Guard: "label the 3 wings as zones" must NOT reduce the wing count to 3.
        # The number describes existing wings being relabelled, not a structural count change.
        _is_labeling_wings = bool(
            re.search(r"\b(?:label|relabel|rename|designate|mark)\b", normalized_message)
            and re.search(r"\bwings?\b", normalized_message)
        )
        wing_count = _extract_first_int(normalized_message, r"(\d+)\s+wings?")
        if wing_count is None:
            wing_count = _extract_first_int(normalized_message, r"(\d+)-wing\b")
        if wing_count is not None:
            if _is_labeling_wings:
                assumptions.append(
                    f"The message contains '{wing_count} wings' in a wing-labeling context — "
                    "the wing count was not changed. To change the count, say e.g. 'Use 4 wings'."
                )
            else:
                next_value = int(_clamp(wing_count, 1, 5))
                config_patch["wingCount"] = next_value
                commands.append({"type": "setGeneratorConfig", "field": "wingCount", "value": str(next_value)})
        elif re.search(r"\b(add|include)\s+(?:1\s+)?more\s+wing\b", normalized_message) or re.search(
            r"\badd\s+(?:another|a(?:\s+new)?)\s+wing\b", normalized_message
        ):
            next_value = int(_clamp(base_config["wingCount"] + 1, 1, 5))
            config_patch["wingCount"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "wingCount", "value": str(next_value)})
            assumptions.append("Interpreted the request as increasing the generated wing count by 1.")
        elif re.search(r"\b(remove|delete|drop|cut)\s+(?:1\s+|a\s+|one\s+)?wing\b(?!\s+\w)", normalized_message):
            next_value = int(_clamp(base_config["wingCount"] - 1, 1, 5))
            config_patch["wingCount"] = next_value
            commands.append({"type": "setGeneratorConfig", "field": "wingCount", "value": str(next_value)})
            assumptions.append("Interpreted the request as decreasing the generated wing count by 1.")

        # ── placement pattern ─────────────────────────────────────────────────
        for key, value in PATTERN_KEYWORDS.items():
            if key in normalized_message:
                config_patch["placementPattern"] = value
                commands.append({"type": "setGeneratorConfig", "field": "placementPattern", "value": value})
                break

        # ── density ───────────────────────────────────────────────────────────
        if any(keyword in normalized_message for keyword in ["open", "airy", "spacious", "low density", "spread out", "less crowded", "not crowded", "less dense"]):
            config_patch["density"] = "low"
            commands.append({"type": "setGeneratorConfig", "field": "density", "value": "low"})
        elif any(keyword in normalized_message for keyword in ["balanced", "medium density", "moderate"]):
            config_patch["density"] = "medium"
            commands.append({"type": "setGeneratorConfig", "field": "density", "value": "medium"})
        elif any(keyword in normalized_message for keyword in ["dense", "packed", "high density", "compact", "tightly packed", "heavily packed", "overcrowded"]):
            config_patch["density"] = "high"
            commands.append({"type": "setGeneratorConfig", "field": "density", "value": "high"})

        # ── hallway thickness – exact px ──────────────────────────────────────
        # Pattern A: hallway/corridor … N px  (px required, no % allowed)
        hallway_exact_px = _extract_first_int(
            normalized_message,
            r"(?:hallway|corridor)s?\s+(?:thickness|width)?\s*(?:to\s+)?(\d+)\s*px",
        )
        # Pattern B: verb + hallway/corridor + required thickness/width keyword + N (px optional)
        if hallway_exact_px is None:
            hallway_exact_px = _extract_first_int(
                normalized_message,
                r"(?:set|change|resize|make)\s+(?:hallway|corridor)s?\s+(?:thickness|width)\s+(?:to\s+)?(\d+)\s*(?:px|pixels?)?",
            )
        # Pattern C: set/change/resize + hallway/corridor + to N (no thickness keyword, no px needed)
        if hallway_exact_px is None:
            hallway_exact_px = _extract_first_int(
                normalized_message,
                r"(?:set|change|resize)\s+(?:hallway|corridor)s?\s+(?:to\s+)?(\d+)\s*(?:px|pixels?)?",
            )
        if hallway_exact_px is not None:
            next_value = int(_clamp(hallway_exact_px, 20, 120))
            config_patch["hallwayThickness"] = next_value
            commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})

        # ── hallway thickness – relative ──────────────────────────────────────
        if "hallwayThickness" not in config_patch:
            hallway_percent = _extract_percent(normalized_message, ["hallway", "hallways", "corridor", "corridors"])
            if hallway_percent is not None and any(word in normalized_message for word in ["wider", "wide", "thicker", "thick"]):
                next_value = int(_clamp(round(base_config["hallwayThickness"] * (1 + hallway_percent / 100.0)), 20, 120))
                config_patch["hallwayThickness"] = next_value
                commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})
            elif hallway_percent is not None and any(word in normalized_message for word in ["narrower", "narrow", "thinner", "thin"]):
                next_value = int(_clamp(round(base_config["hallwayThickness"] * (1 - hallway_percent / 100.0)), 20, 120))
                config_patch["hallwayThickness"] = next_value
                commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})
            elif any(word in normalized_message for word in [
                "wider hallways", "wider corridors", "make hallways wider", "make corridors wider",
                "widen hallways", "widen corridors", "widen the hallways", "widen the corridors",
                "expand hallways", "expand corridors", "expand the hallways", "expand the corridors",
                "increase corridor width", "increase hallway width",
            ]):
                next_value = int(_clamp(round(base_config["hallwayThickness"] * 1.2), 20, 120))
                config_patch["hallwayThickness"] = next_value
                commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})
                assumptions.append("Interpreted 'wider hallways' as increasing hallway thickness by 20%.")
            elif any(word in normalized_message for word in [
                "narrower hallways", "narrower corridors", "make hallways narrower", "make corridors narrower",
                "narrow hallways", "narrow corridors", "narrow the hallways", "narrow the corridors",
                "narrow down hallways", "narrow down corridors", "compress hallways", "compress corridors",
                "decrease corridor width", "decrease hallway width",
            ]):
                next_value = int(_clamp(round(base_config["hallwayThickness"] * 0.85), 20, 120))
                config_patch["hallwayThickness"] = next_value
                commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})
                assumptions.append("Interpreted 'narrower hallways' as reducing hallway thickness by 15%.")

        # ── hallway overlap / misplaced cleanup ───────────────────────────────
        hallway_cleanup_request = (
            any(token in normalized_message for token in ["hallway", "hallways", "corridor", "corridors"])
            and any(token in normalized_message for token in ["overlap", "overlapping", "colliding", "collision", "misplaced", "misaligned", "awkward"])
            and any(token in normalized_message for token in ["remove", "fix", "resolve", "clean up", "eliminate", "stop"])
        )
        # Suppress hallway overlap-cleanup config changes when the alignment handler already
        # claimed the request via force_regeneration, UNLESS the message also explicitly asks to
        # remove/eliminate hallways (e.g. "Align all hallways. Remove misplaced hallways.").
        _explicit_hallway_removal = _has_any(
            normalized_message,
            ["remove", "eliminate", "take out", "get rid of", "stop"],
        )
        if hallway_cleanup_request and (not alignment_cleanup_request or _explicit_hallway_removal):
            if base_config["hallwayThickness"] > 20:
                next_value = int(_clamp(round(base_config["hallwayThickness"] * 0.8), 20, 120))
                if next_value != base_config["hallwayThickness"]:
                    config_patch["hallwayThickness"] = next_value
                    commands.append({"type": "resizeHallway", "field": "hallwayThickness", "value": str(next_value)})
                    assumptions.append(
                        f"Interpreted the hallway cleanup request as regenerating with narrower hallways ({base_config['hallwayThickness']} px to {next_value} px) instead of removing hallways entirely."
                    )
            elif base_config["placementPattern"] == "double-loaded":
                config_patch["placementPattern"] = "single-loaded"
                commands.append({"type": "setGeneratorConfig", "field": "placementPattern", "value": "single-loaded"})
                assumptions.append(
                    "Interpreted the hallway cleanup request as simplifying the corridor pattern from double-loaded to single-loaded to reduce misplaced or colliding hallways."
                )
            elif base_config["roomsPerWing"] > 1:
                next_value = int(_clamp(base_config["roomsPerWing"] - 1, 1, 30))
                config_patch["roomsPerWing"] = next_value
                commands.append({"type": "rebalanceRooms", "field": "roomsPerWing", "value": str(next_value)})
                assumptions.append(
                    f"Interpreted the hallway cleanup request as reducing rooms per wing from {base_config['roomsPerWing']} to {next_value} so the regenerated corridors have more space."
                )
            elif base_config["includeBridges"] and base_config["wingCount"] > 1:
                config_patch["includeBridges"] = False
                commands.append({"type": "setGeneratorConfig", "field": "includeBridges", "value": "false"})
                assumptions.append(
                    "Interpreted the hallway cleanup request as regenerating without bridges, because corridor simplification options were already exhausted."
                )
            else:
                warnings.append(
                    "The current generator settings are already minimal for hallway density, so overlap cleanup may still require manual layout edits."
                )

        # ── explicit hallway removal ───────────────────────────────────────────
        hallway_remove_request = (
            any(token in normalized_message for token in ["hallway", "hallways", "corridor", "corridors"])
            and any(token in normalized_message for token in ["remove", "delete", "eliminate", "take out", "without", "disable", "hide", "clear", "get rid of", "no"])
        )
        if _horizontal_hallway_request:
            # "Horizontal hallways" = the hallway elements the user sees rendered horizontally.
            # The generator doesn't track orientation, so delete all hallway elements from
            # the canvas — same physical action as "Delete all hallways".
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "hallway"})
            assumptions.append(
                "Interpreted 'horizontal hallways' as the hallway elements visible in the layout. "
                "Deleting all hallway elements from the canvas."
            )
        elif direct_delete_all_hallways:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "hallway"})
            assumptions.append(
                "Interpreted the request as deleting all hallway elements from the current layout canvas rather than regenerating the layout."
            )
        elif hallway_remove_request and not hallway_cleanup_request and not _horizontal_hallway_request:
            config_patch["includeHallways"] = False
            commands.append({"type": "setGeneratorConfig", "field": "includeHallways", "value": "false"})

        # ── direct canvas deletion: lounges, bridges, entrance, wing backgrounds ─
        # "delete/remove X" = delete elements from canvas (no config change, no regeneration).
        # "disable/hide/no/without X" = config flag change (may trigger regeneration).
        if direct_delete_all_lounges:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "lounge"})
            assumptions.append(
                "Interpreted as deleting all lounge elements from the canvas."
            )
        if direct_delete_bridges:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "bridge"})
            assumptions.append(
                "Interpreted as deleting all bridge elements from the canvas."
            )
        if direct_delete_entrance:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "entrance"})
            assumptions.append(
                "Interpreted as deleting the entrance element from the canvas."
            )
        if direct_delete_wing_backgrounds:
            commands.append({"type": "deleteAllElements", "field": "elementType", "value": "wingBackground"})
            assumptions.append(
                "Interpreted as deleting all wing background elements from the canvas."
            )

        # ── config toggles: only for disable/hide/no/without — NOT for delete/remove ─
        for label, field in [
            ("bridge", "includeBridges"),
            ("bridges", "includeBridges"),
            ("lounge", "includeLounges"),
            ("lounges", "includeLounges"),
            ("entrance", "includeEntrance"),
            ("wing backgrounds", "includeWingBackgrounds"),
            ("backgrounds", "includeWingBackgrounds"),
        ]:
            if direct_delete_all_lounges and field == "includeLounges":
                continue
            if (direct_delete_bridges or _horizontal_hallway_request) and field == "includeBridges":
                continue
            if direct_delete_entrance and field == "includeEntrance":
                continue
            if direct_delete_wing_backgrounds and field == "includeWingBackgrounds":
                continue
            if direct_delete_all_hallways and field == "includeHallways":
                continue
            toggle = _to_bool_toggle(normalized_message, label)
            if toggle is not None:
                config_patch[field] = toggle
                commands.append({"type": "setGeneratorConfig", "field": field, "value": str(toggle).lower()})

        if config_patch.get("includeHallways") is False:
            assumptions.append(
                "Interpreted the hallway request as regenerating the layout without generated hallways, because selective hallway removal is not supported yet."
            )

        # ── wing-specific room scale – explicit percentage ────────────────────
        wing_scale_explicit = re.search(
            r"\bwing\s+([abcde])\s+(?:rooms?\s+)?(?:scale\s+)?(?:at|to)\s+(\d{2,3})\s*%",
            normalized_message,
        )
        if wing_scale_explicit is None:
            wing_scale_explicit = re.search(
                r"(?:set|scale|resize)\s+wing\s+([abcde])\s+(?:rooms?\s+)?(?:to|at)\s+(\d{2,3})\s*%",
                normalized_message,
            )
        if wing_scale_explicit is not None:
            wing = wing_scale_explicit.group(1).upper()
            pct = int(_clamp(int(wing_scale_explicit.group(2)), 60, 140))
            next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
            next_overrides[wing] = pct
            config_patch["wingRoomScaleOverrides"] = next_overrides
            commands.append({"type": "resizeRooms", "field": f"wingRoomScaleOverrides.{wing}", "value": str(pct)})
            assumptions.append(f"Interpreted the Wing {wing} request as setting room scale in that wing to {pct}% of their base size.")

        # ── wing-specific room scale – relative ───────────────────────────────
        wing_match = re.search(r"\bwing\s+([abcde])\b", normalized_message)
        wing_height_increase_request = bool(
            wing_match
            and any(token in normalized_message for token in ["height", "taller", "tall"])
            and any(token in normalized_message for token in ["increase", "raise", "expand", "more", "larger", "bigger"])
        )
        wing_height_decrease_request = bool(
            wing_match
            and any(token in normalized_message for token in ["height", "shorter", "short"])
            and any(token in normalized_message for token in ["decrease", "reduce", "lower", "shrink", "less", "smaller"])
        )
        if wing_scale_explicit is None:
            if wing_height_increase_request:
                wing = wing_match.group(1).upper()
                next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
                next_overrides[wing] = 115
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": f"wingRoomScaleOverrides.{wing}", "value": "115"})
                assumptions.append(
                    f"Interpreted the Wing {wing} height request as scaling room sizes in that wing to 115% of their base size, which also increases the generated wing height."
                )
            elif wing_height_decrease_request:
                wing = wing_match.group(1).upper()
                next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
                next_overrides[wing] = 85
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": f"wingRoomScaleOverrides.{wing}", "value": "85"})
                assumptions.append(
                    f"Interpreted the Wing {wing} height request as scaling room sizes in that wing to 85% of their base size, which also reduces the generated wing height."
                )
            elif wing_match and any(token in normalized_message for token in ["reduce the size", "smaller rooms", "shrink", "smaller", "compress", "scale down"]):
                wing = wing_match.group(1).upper()
                next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
                next_overrides[wing] = 85
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": f"wingRoomScaleOverrides.{wing}", "value": "85"})
                assumptions.append(f"Interpreted the Wing {wing} request as scaling room sizes in that wing to 85% of their base size.")
            elif wing_match and any(token in normalized_message for token in ["increase the size", "larger rooms", "bigger rooms", "expand", "scale up", "make bigger"]):
                wing = wing_match.group(1).upper()
                next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
                next_overrides[wing] = 115
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": f"wingRoomScaleOverrides.{wing}", "value": "115"})
                assumptions.append(f"Interpreted the Wing {wing} request as scaling room sizes in that wing to 115% of their base size.")

        # ── equalize / reset all wing sizes ──────────────────────────────────
        # Guard: "make all wings the same size as Wing A" is a copy request, not equalize.
        _is_copy_wing_phrase = bool(
            re.search(r"\bmake\s+all\s+wings?\s+(?:the\s+)?(?:same\s+(?:size|scale)\s+as|like)\s+wing\s+[abcde]\b", normalized_message)
        )
        _equalize_wings_request = not _is_copy_wing_phrase and _has_any(normalized_message, [
            "equalize wings", "equalize wing sizes", "equalize all wings",
            "balance wings", "balance wing sizes", "balance all wings",
            "same size wings", "same size for all wings", "equal wing sizes",
            "make all wings equal", "make wings equal", "make all wings the same size",
            "uniform wings", "uniform wing sizes", "normalize wing sizes",
            "reset wing sizes", "reset wing overrides", "reset all wing sizes",
            "clear wing overrides", "remove wing overrides", "remove wing size overrides",
        ])
        if _equalize_wings_request and "wingRoomScaleOverrides" not in config_patch:
            config_patch["wingRoomScaleOverrides"] = {}
            commands.append({"type": "resizeRooms", "field": "wingRoomScaleOverrides", "value": "{}"})
            assumptions.append(
                "Interpreted the request as equalizing all wing room sizes by clearing per-wing scale overrides."
            )

        # ── reset specific wing override ──────────────────────────────────────
        if "wingRoomScaleOverrides" not in config_patch:
            _reset_wing_match = re.search(
                r"\b(?:reset|clear|remove|restore)\s+wing\s+([abcde])\s+(?:room\s+)?(?:size\s+)?(?:(?:scale\s+)?override|scale|size)\s*(?:to\s+default)?\b",
                normalized_message,
            )
            if _reset_wing_match is None:
                _reset_wing_match = re.search(
                    r"\b(?:reset|clear|remove)\s+(?:the\s+)?wing\s+([abcde])\s+(?:override|scale|size)\b",
                    normalized_message,
                )
            if _reset_wing_match:
                wing = _reset_wing_match.group(1).upper()
                next_overrides = deepcopy(base_config.get("wingRoomScaleOverrides", {}))
                if wing in next_overrides:
                    del next_overrides[wing]
                    config_patch["wingRoomScaleOverrides"] = next_overrides
                    commands.append({"type": "resizeRooms", "field": "wingRoomScaleOverrides", "value": str(next_overrides)})
                    assumptions.append(f"Interpreted the request as removing the room size override for Wing {wing}, restoring it to the global room scale.")
                else:
                    assumptions.append(f"Wing {wing} has no active size override — no change needed.")

        # ── copy wing scale to all other wings ────────────────────────────────
        if "wingRoomScaleOverrides" not in config_patch:
            _copy_wing_match = re.search(
                r"\b(?:apply|copy|use|make\s+all\s+wings?)\s+wing\s+([abcde])\s+(?:room\s+)?(?:size|scale)\s+(?:to\s+all|for\s+all|across\s+all)?\s*wings?\b",
                normalized_message,
            )
            if _copy_wing_match is None:
                _copy_wing_match = re.search(
                    r"\bmake\s+all\s+wings?\s+(?:the\s+)?(?:same\s+(?:size|scale)\s+as|like)\s+wing\s+([abcde])\b",
                    normalized_message,
                )
            if _copy_wing_match:
                source_wing = _copy_wing_match.group(1).upper()
                current_overrides = base_config.get("wingRoomScaleOverrides", {})
                source_scale = current_overrides.get(source_wing, base_config.get("roomScale", 100))
                next_overrides = {w: int(source_scale) for w in ["A", "B", "C", "D", "E"]}
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": "wingRoomScaleOverrides", "value": str(next_overrides)})
                assumptions.append(
                    f"Interpreted the request as applying Wing {source_wing}'s room scale ({source_scale}%) to all wings."
                )

        # ── set all wings to a specific scale percentage ──────────────────────
        if "wingRoomScaleOverrides" not in config_patch and "roomScale" not in config_patch:
            _all_wings_pct_match = re.search(
                r"\b(?:set|scale|resize|make)\s+all\s+wings?\s+(?:rooms?\s+)?(?:to|at)\s+(\d{2,3})\s*%",
                normalized_message,
            )
            if _all_wings_pct_match is None:
                _all_wings_pct_match = re.search(
                    r"\ball\s+wings?\s+(?:rooms?\s+)?(?:to|at|scale\s+to)\s+(\d{2,3})\s*%",
                    normalized_message,
                )
            if _all_wings_pct_match:
                pct = int(_clamp(int(_all_wings_pct_match.group(1)), 60, 140))
                next_overrides = {w: pct for w in ["A", "B", "C", "D", "E"]}
                config_patch["wingRoomScaleOverrides"] = next_overrides
                commands.append({"type": "resizeRooms", "field": "wingRoomScaleOverrides", "value": str(next_overrides)})
                assumptions.append(f"Interpreted the request as setting all wing room sizes to {pct}% of base size.")

        # ── layout offset / position ──────────────────────────────────────────
        # Center / reset layout position
        _center_request = _has_any(normalized_message, [
            "center the layout", "center layout", "center it", "reset position",
            "reset layout position", "reset offset", "move to center",
            "reset the position", "center the building", "no offset",
            "remove offset", "clear offset",
        ])
        if _center_request:
            if base_config["offsetX"] != 0:
                config_patch["offsetX"] = 0
                commands.append({"type": "moveWing", "field": "offsetX", "value": "0"})
            if base_config["offsetY"] != 0:
                config_patch["offsetY"] = 0
                commands.append({"type": "moveWing", "field": "offsetY", "value": "0"})
            assumptions.append("Interpreted the request as resetting the layout position offset to the default center (0, 0).")

        # Exact pixel offset amounts — "shift right 100px", "move up 60 pixels"
        if not _center_request:
            _exact_right = re.search(r"\b(?:shift|move|nudge|push)\s+right\s+(\d+)\s*(?:px|pixels?)?\b", normalized_message)
            _exact_left = re.search(r"\b(?:shift|move|nudge|push)\s+left\s+(\d+)\s*(?:px|pixels?)?\b", normalized_message)
            _exact_up = re.search(r"\b(?:shift|move|nudge|push)\s+up\s+(\d+)\s*(?:px|pixels?)?\b", normalized_message)
            _exact_down = re.search(r"\b(?:shift|move|nudge|push)\s+down\s+(\d+)\s*(?:px|pixels?)?\b", normalized_message)

            if _exact_right and "offsetX" not in config_patch:
                amt = int(_clamp(int(_exact_right.group(1)), 10, 400))
                next_value = int(_clamp(base_config["offsetX"] + amt, -400, 400))
                config_patch["offsetX"] = next_value
                commands.append({"type": "moveWing", "field": "offsetX", "value": str(next_value)})
            elif _exact_left and "offsetX" not in config_patch:
                amt = int(_clamp(int(_exact_left.group(1)), 10, 400))
                next_value = int(_clamp(base_config["offsetX"] - amt, -400, 400))
                config_patch["offsetX"] = next_value
                commands.append({"type": "moveWing", "field": "offsetX", "value": str(next_value)})
            elif any(word in normalized_message for word in ["shift right", "move right", "nudge right", "push right"]):
                next_value = int(_clamp(base_config["offsetX"] + 40, -400, 400))
                config_patch["offsetX"] = next_value
                commands.append({"type": "moveWing", "field": "offsetX", "value": str(next_value)})
            elif any(word in normalized_message for word in ["shift left", "move left", "nudge left", "push left"]):
                next_value = int(_clamp(base_config["offsetX"] - 40, -400, 400))
                config_patch["offsetX"] = next_value
                commands.append({"type": "moveWing", "field": "offsetX", "value": str(next_value)})

            if _exact_up and "offsetY" not in config_patch:
                amt = int(_clamp(int(_exact_up.group(1)), 10, 400))
                next_value = int(_clamp(base_config["offsetY"] - amt, -400, 400))
                config_patch["offsetY"] = next_value
                commands.append({"type": "moveWing", "field": "offsetY", "value": str(next_value)})
            elif _exact_down and "offsetY" not in config_patch:
                amt = int(_clamp(int(_exact_down.group(1)), 10, 400))
                next_value = int(_clamp(base_config["offsetY"] + amt, -400, 400))
                config_patch["offsetY"] = next_value
                commands.append({"type": "moveWing", "field": "offsetY", "value": str(next_value)})
            elif any(word in normalized_message for word in ["move up", "higher", "nudge up", "push up", "shift up"]):
                next_value = int(_clamp(base_config["offsetY"] - 40, -400, 400))
                config_patch["offsetY"] = next_value
                commands.append({"type": "moveWing", "field": "offsetY", "value": str(next_value)})
            elif any(word in normalized_message for word in ["move down", "lower", "nudge down", "push down", "shift down"]):
                next_value = int(_clamp(base_config["offsetY"] + 40, -400, 400))
                config_patch["offsetY"] = next_value
                commands.append({"type": "moveWing", "field": "offsetY", "value": str(next_value)})

        proposed_config.update(config_patch)
        proposed_config = cls.normalize_config(proposed_config)
        has_direct_layout_delete = any(command.get("type") == "deleteAllElements" for command in commands)

        _horizontal_already_warned = _horizontal_hallway_request and not config_patch
        if not config_patch and not force_regeneration and not has_direct_layout_delete and not _horizontal_already_warned and not undo_request:
            warnings.append(
                "No concrete generator change was detected. Try mentioning room count, room size presets (wide/narrow/compact/spacious), "
                "corridor pattern, hallway thickness, canvas size (including '20% wider'), wing labels, floors, wings, bridges, lounges, "
                "offsets (including 'shift right 100px', 'center layout'), 'reset to defaults', 'equalize wings', or per-wing scale changes."
            )

        if current_layout_summary and isinstance(current_layout_summary, dict):
            room_total = current_layout_summary.get("roomCount")
            if isinstance(room_total, int) and room_total > 120 and proposed_config["density"] == "high":
                warnings.append("This layout is already dense. Increasing density further may create cramped wings.")

        # Build delete-action summary for canvas deletion commands
        _delete_summary: list[str] = []
        for _cmd in commands:
            if _cmd.get("type") == "deleteAllElements":
                _et = _cmd.get("value", "")
                _label_map = {
                    "hallway": "hallways", "lounge": "lounges", "room": "rooms",
                    "bridge": "bridges", "entrance": "entrance", "wingBackground": "wing backgrounds",
                }
                _delete_summary.append(_label_map.get(_et, _et))

        summary_bits = []
        if proposed_config["width"] != base_config["width"]:
            summary_bits.append(f"canvas width to {proposed_config['width']} px")
        if proposed_config["height"] != base_config["height"]:
            summary_bits.append(f"canvas height to {proposed_config['height']} px")
        if proposed_config["profile"] != base_config["profile"]:
            summary_bits.append(f"profile to {proposed_config['profile']}")
        if proposed_config["roomsPerWing"] != base_config["roomsPerWing"]:
            summary_bits.append(f"rooms per wing to {proposed_config['roomsPerWing']}")
        if proposed_config["roomScale"] != base_config["roomScale"]:
            summary_bits.append(f"room size scale to {proposed_config['roomScale']}%")
        if proposed_config["hallwayThickness"] != base_config["hallwayThickness"]:
            summary_bits.append(f"hallway thickness to {proposed_config['hallwayThickness']} px")
        if proposed_config["placementPattern"] != base_config["placementPattern"]:
            summary_bits.append(f"corridor pattern to {proposed_config['placementPattern']}")
        if proposed_config["density"] != base_config["density"]:
            summary_bits.append(f"density to {proposed_config['density']}")
        if proposed_config["wingLabelMode"] != base_config["wingLabelMode"]:
            summary_bits.append(f"wing background labels to {proposed_config['wingLabelMode']} mode")
        if proposed_config["includeHallways"] != base_config["includeHallways"]:
            summary_bits.append("generated hallways removed" if not proposed_config["includeHallways"] else "generated hallways enabled")
        if proposed_config["includeBridges"] != base_config["includeBridges"]:
            summary_bits.append("bridges removed" if not proposed_config["includeBridges"] else "bridges enabled")
        if proposed_config["wingRoomScaleOverrides"] != base_config.get("wingRoomScaleOverrides", {}):
            summary_bits.append("wing-specific room sizing updated")

        # Only fields that actually restructure the floor plan require regeneration.
        # Visual-only changes (e.g. wingLabelMode) must NOT trigger a regeneration —
        # that is what caused rooms to disappear when wing labeling was requested.
        # force_regeneration is set for requests like alignment fixes that need a fresh
        # generation pass without changing any config parameters.
        requires_regeneration = force_regeneration or (
            bool(config_patch) and any(f not in _VISUAL_ONLY_FIELDS for f in config_patch)
        )

        if has_direct_layout_delete and not config_patch and not force_regeneration:
            reply = "I deleted " + " and ".join(_delete_summary) + " from the canvas."
        elif not config_patch and not force_regeneration:
            reply = "I prepared a regenerated layout preview."
        elif requires_regeneration:
            if force_regeneration and not config_patch:
                reply = "I regenerated the layout with the same configuration to resolve the hallway alignment."
            else:
                reply = (
                    "I prepared a regenerated layout preview"
                    + (f" by updating {', '.join(summary_bits)}." if summary_bits else ".")
                )
        else:
            reply = (
                "I updated the wing label display"
                + (f" ({', '.join(summary_bits)})." if summary_bits else ".")
                + " The existing room layout was preserved — no regeneration needed."
            )

        return {
            "ok": True,
            "reply": reply,
            "configPatch": config_patch,
            "baseConfig": base_config,
            "proposedConfig": proposed_config,
            "commands": commands,
            "warnings": warnings,
            "assumptions": assumptions,
            "requiresRegeneration": requires_regeneration,
        }
