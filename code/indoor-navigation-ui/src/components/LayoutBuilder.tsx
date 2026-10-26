import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import {
  MDBBtn,
  MDBModal,
  MDBModalBody,
  MDBModalContent,
  MDBModalDialog,
  MDBModalFooter,
  MDBModalHeader,
  MDBModalTitle,
} from "mdb-react-ui-kit";
import TopNavBar from "./TopNavBar";
import Footer from "./Footer";
import "../assets/layout_builder.css";
import { AUTH_CHANGED_EVENT, getAuthState, SERVICE_BASE_URL } from "../utils/auth";
import {
  SPACE_TYPE_BRIDGE,
  SPACE_TYPE_ENTRANCE,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_ROOM,
  SPACE_TYPE_STAIRS,
} from "../constants/space_constants";
import type { FloorId, Layout, LayoutPoint, LayoutRoom, LayoutRoomKind, WingId } from "../layout/layout.schema";
import { cloneLayout } from "../layout/layout.schema";
import { ROOM_STYLE_BY_WING, layoutToSvg, polyToFlatPoints, roomLabelPosition, roomStyle } from "../layout/layout.renderers";
import type { Space } from "../types/models";

type Tool =
  | "select"
  | "pan"
  | "room"
  | "polygon_room"
  | "lounge"
  | "stairs"
  | "hallway"
  | "entrance"
  | "wing_background";
type Selection = string | null;
type PolygonDraft = {
  points: LayoutPoint[];
  hover: LayoutPoint | null;
};

const GRID_SIZE = 40;
const WORLD_SIZE = 5000;
const GRID_PADDING = 20;
const HALLWAY_RESIZE_SNAP = 5;
const AUTO_HALLWAY_THICKNESS = 24;
const AUTO_HALLWAY_MIN_ROW_GAP = 56;
const AUTO_HALLWAY_EDGE_INSET = 0;
const AUTO_VERTICAL_OVERLAP_TRIM = 12;
const MAP_LAYOUT_REFRESH_PENDING_KEY = "indoor-nav.map-layout.refresh.pending";
const MAP_HISTORY_NAME_OVERRIDES_KEY = "indoor-nav.map-history.name-overrides";
const BASE_FLOORS = [1, 2, 3] as const;
const WING_IDS = ["A", "B", "C", "D", "E"] as const;
const ROOM_COLOR_OPTIONS = WING_IDS.map((wing) => ({
  label: `Wing ${wing} color`,
  value: ROOM_STYLE_BY_WING[wing].fill,
}));
const DEFAULT_WING_NAME_OPTIONS = WING_IDS.map((wing) => `Wing ${wing}`);

type BuilderFloor = number;
type LayoutsByFloor = Record<number, Layout>;

const DEFAULT_VIEW = { x: 80, y: 80, scale: 1 };
const LOADED_MAP_VIEW = { x: 20, y: 10, scale: 0.65 };
const DEFAULT_VIEWPORT = { width: 1200, height: 700 };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const snap = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE;
const snapToStep = (value: number, step: number): number => Math.round(value / step) * step;
const snapPoint = (point: LayoutPoint): LayoutPoint => ({ x: snap(point.x), y: snap(point.y) });
const HORIZONTAL_NUDGE_PX = 80;
const VERTICAL_NUDGE_PX = 80;
const PUBLISH_REQUEST_TIMEOUT_MS = 20000;
const UI_BACKUP_TIMEOUT_MS = 1500;
const ROOM_LABEL_PADDING_X = 6;
const ROOM_LABEL_PADDING_Y = 4;
const ROOM_LABEL_MAX_FONT_SIZE = 12;
const ROOM_LABEL_MIN_FONT_SIZE = 8;
const ROOM_LABEL_LINE_HEIGHT = 1.2;
const ROOM_LABEL_CHAR_WIDTH_FACTOR = 0.56;
const ROOM_COPY_OFFSET_STEP = GRID_SIZE;
const ROOM_COPY_SEARCH_LIMIT = 24;
const POLYGON_VERTEX_HIT_RADIUS = 7;

const normalizeHexColor = (value?: string | null): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

type FloorSource = {
  wingBackgrounds?: Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>;
  wings: { A: Space[]; B: Space[]; C: Space[] };
  bridges: { AB: Space; BC: Space };
};

type CanonicalMapLayout = {
  version: 1;
  units: "px";
  viewBox: { w: number; h: number };
  grid?: { size: number };
  mainEntrance?: { x: number; y: number };
  floors: Record<"1" | "2" | "3", FloorSource>;
};

function emptyFloorSource(): FloorSource {
  return {
    wings: { A: [], B: [], C: [] },
    bridges: {
      AB: { id: "bridge-ab", name: "Bridge AB", x: 0, y: 0, width: 1, height: 1, type: "bridge", passable: true },
      BC: { id: "bridge-bc", name: "Bridge BC", x: 0, y: 0, width: 1, height: 1, type: "bridge", passable: true },
    },
  };
}

function fallbackCanonicalLayout(): CanonicalMapLayout {
  return {
    version: 1,
    units: "px",
    viewBox: { w: 1768, h: 930 },
    grid: { size: 40 },
    mainEntrance: { x: 0, y: 0 },
    floors: {
      "1": emptyFloorSource(),
      "2": emptyFloorSource(),
      "3": emptyFloorSource(),
    },
  };
}

function isCanonicalMapLayout(value: unknown): value is CanonicalMapLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanonicalMapLayout>;
  if (!candidate.floors || typeof candidate.floors !== "object") return false;
  const f1 = (candidate.floors as any)["1"];
  const f2 = (candidate.floors as any)["2"];
  const f3 = (candidate.floors as any)["3"];
  const hasValidFloor = (f: any) =>
    f &&
    typeof f === "object" &&
    f.wings &&
    typeof f.wings === "object" &&
    Array.isArray(f.wings.A) &&
    Array.isArray(f.wings.B) &&
    Array.isArray(f.wings.C) &&
    f.bridges &&
    typeof f.bridges === "object";
  return hasValidFloor(f1) && hasValidFloor(f2) && hasValidFloor(f3);
}

const CANONICAL_MAP_LAYOUT: CanonicalMapLayout = fallbackCanonicalLayout();

type MainLayoutSvgDraft = {
  draftId?: string;
  createdAt?: string;
  note?: string;
  source?: string;
  version?: number;
  baseMapLayout?: CanonicalMapLayout;
  floors?: Record<string, { svg?: string }>;
};

type DraftOption = {
  key: string;
  sourceLabel: string;
  filename: string;
  draftId: string;
  createdAt: string;
  note: string;
  floorCount: number;
  payload: MainLayoutSvgDraft;
  isDraftFile?: boolean;
};

const buildDraftOptionKey = (filename: string): string => `api-draft-${filename}`;
const buildMapHistoryOptionKey = (filename: string): string => `api-map-history-${filename}`;

type SvgListTab = "main" | "drafts";
type DraftFileItem = {
  id?: number;
  filename: string;
  displayName?: string;
  isSandbox?: boolean;
  mtimeMs: number;
  payload: MainLayoutSvgDraft;
};
type MapHistoryFileItem = {
  filename: string;
  mtimeMs: number;
  payload: CanonicalMapLayout & { createdAt?: string; note?: string };
};
type RoomDeleteTarget = {
  id: string;
  floor: BuilderFloor;
  text: string;
};
type ToastTone = "success" | "danger" | "info";
type BlockingAction = "publish" | "save";

function pointerToWorld(
  stage: any,
  view: { x: number; y: number; scale: number }
): LayoutPoint | null {
  const pointer = stage?.getPointerPosition?.();
  if (!pointer) return null;
  return {
    x: (pointer.x - view.x) / view.scale,
    y: (pointer.y - view.y) / view.scale,
  };
}

function toLayoutKind(tool: Tool): LayoutRoomKind {
  if (tool === "room") return "room";
  if (tool === "polygon_room") return "room";
  if (tool === "lounge") return "lounge";
  if (tool === "stairs") return "stairs";
  if (tool === "entrance") return "entrance";
  if (tool === "wing_background") return "wing_background";
  return "hallway";
}

function spaceTypeToLayoutKind(type: Space["type"]): LayoutRoomKind {
  if (type === SPACE_TYPE_ROOM) return "room";
  if (type === SPACE_TYPE_LOUNGE) return "lounge";
  if (type === SPACE_TYPE_STAIRS) return "stairs";
  if (type === SPACE_TYPE_HALLWAY) return "hallway";
  if (type === SPACE_TYPE_BRIDGE) return "bridge";
  if (type === SPACE_TYPE_ENTRANCE) return "entrance";
  return "room";
}

type SpaceWithWing = {
  space: Space;
  wing?: WingId;
};

function spacesToLayout(floor: BuilderFloor, spaces: SpaceWithWing[]): Layout {
  return {
    version: CANONICAL_MAP_LAYOUT.version,
    units: CANONICAL_MAP_LAYOUT.units,
    viewBox: { ...CANONICAL_MAP_LAYOUT.viewBox },
    grid: CANONICAL_MAP_LAYOUT.grid ? { ...CANONICAL_MAP_LAYOUT.grid } : undefined,
    rooms: spaces.map(({ space, wing }) => ({
      id: space.id,
      floor: floor as FloorId,
      kind: spaceTypeToLayoutKind(space.type),
      wing: space.type === SPACE_TYPE_ROOM ? wing : undefined,
      fill: space.type === SPACE_TYPE_ROOM ? normalizeHexColor(space.fill) : undefined,
      rect: space.poly?.points?.length
        ? undefined
        : {
            x: space.x,
            y: space.y,
            w: space.width,
            h: space.height,
            r: space.type === "lounge" ? 20 : space.type === "entrance" ? 10 : 8,
          },
      poly: space.poly?.points?.length
        ? { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) }
        : undefined,
      label: {
        x: space.poly?.points?.length
          ? roomLabelPosition({
              id: space.id,
              floor: floor as FloorId,
              kind: spaceTypeToLayoutKind(space.type),
              poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
            }).x
          : space.x + space.width / 2,
        y: space.poly?.points?.length
          ? roomLabelPosition({
              id: space.id,
              floor: floor as FloorId,
              kind: spaceTypeToLayoutKind(space.type),
              poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
            }).y
          : space.y + space.height / 2,
        text: space.name,
      },
    })),
  };
}

function wingBackgroundsToLayoutRooms(
  floor: BuilderFloor,
  wingBackgrounds?: Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>
): LayoutRoom[] {
  if (!wingBackgrounds) return [];
  const rooms: LayoutRoom[] = [];
  WING_IDS.forEach((wing) => {
    const rect = wingBackgrounds[wing];
    if (!rect) return;
    rooms.push({
      id: `wing-background-${wing.toLowerCase()}-${floor}`,
      floor: floor as FloorId,
      kind: "wing_background" as const,
      wing,
      wingName: displayWingName(wing),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, r: rect.r },
      label: {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: wingBackgroundLabel(wing, displayWingName(wing)),
      },
    });
  });
  return rooms;
}

function mapLayoutToLayoutsByFloor(mapLayout: unknown): LayoutsByFloor {
  const safeMap = isCanonicalMapLayout(mapLayout) ? mapLayout : fallbackCanonicalLayout();
  const f1 = safeMap.floors["1"] ?? emptyFloorSource();
  const f2 = safeMap.floors["2"] ?? emptyFloorSource();
  const f3 = safeMap.floors["3"] ?? emptyFloorSource();
  const toLayoutWithBackgrounds = (floor: BuilderFloor, source: FloorSource): Layout => {
    const baseLayout = spacesToLayout(floor, [
      ...source.wings.C.map((space) => ({ space, wing: "C" as WingId })),
      { space: source.bridges.BC },
      ...source.wings.A.map((space) => ({ space, wing: "A" as WingId })),
      { space: source.bridges.AB },
      ...source.wings.B.map((space) => ({ space, wing: "B" as WingId })),
    ]);
    return {
      ...baseLayout,
      rooms: [...wingBackgroundsToLayoutRooms(floor, source.wingBackgrounds), ...baseLayout.rooms],
    };
  };
  return normalizeLayoutsToGrid({
    1: materializeHorizontalAutoHallways(toLayoutWithBackgrounds(1, f1), 1),
    2: materializeHorizontalAutoHallways(toLayoutWithBackgrounds(2, f2), 2),
    3: materializeHorizontalAutoHallways(toLayoutWithBackgrounds(3, f3), 3),
  });
}

function makeDefaultLabel(kind: LayoutRoomKind, index: number): string {
  if (kind === "wing_background") return "Wing A Background";
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${title} ${index}`;
}

function displayWingName(wing?: WingId, wingName?: string): string {
  const trimmed = wingName?.trim();
  if (trimmed) return trimmed;
  return wing ? `Wing ${wing}` : "Wing A";
}

function parseWingIdFromName(value?: string | null): WingId | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();
  if (normalized === "A" || normalized === "B" || normalized === "C" || normalized === "D" || normalized === "E") {
    return normalized as WingId;
  }
  const match = normalized.match(/^WING\s+([ABCDE])$/);
  return match ? (match[1] as WingId) : undefined;
}

function normalizeWingName(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const canonicalWing = parseWingIdFromName(trimmed);
  return canonicalWing ? displayWingName(canonicalWing) : trimmed.replace(/\s+/g, " ");
}

function wingBackgroundLabel(wing?: WingId, wingName?: string): string {
  return `${displayWingName(wing, wingName)} Background`;
}

function roomFromDraft(
  floor: BuilderFloor,
  kind: LayoutRoomKind,
  start: LayoutPoint,
  end: LayoutPoint,
  labelText: string
): LayoutRoom | null {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  if (w < GRID_SIZE / 2 || h < GRID_SIZE / 2) return null;
  const defaultWing: WingId | undefined = kind === "wing_background" ? "A" : undefined;
  const defaultWingName = kind === "wing_background" ? displayWingName(defaultWing) : undefined;
  const nextLabel = kind === "wing_background" ? wingBackgroundLabel(defaultWing, defaultWingName) : labelText;
  return {
    id: kind === "wing_background" ? `wing-background-${defaultWing?.toLowerCase() ?? "a"}-${floor}-${Date.now()}` : `${kind}-${Date.now()}`,
    floor: floor as FloorId,
    kind,
    wing: defaultWing,
    wingName: defaultWingName,
    rect: {
      x,
      y,
      w,
      h,
      r: kind === "lounge" ? 20 : kind === "entrance" || kind === "wing_background" ? 10 : 8,
    },
    label: { x: x + w / 2, y: y + h / 2, text: nextLabel },
  };
}

function polygonRoomFromPoints(
  floor: BuilderFloor,
  kind: LayoutRoomKind,
  points: LayoutPoint[],
  labelText: string
): LayoutRoom | null {
  const normalizedPoints = points.map((point) => snapPoint(point));
  const roomId = `${kind}-${Date.now()}`;
  if (normalizedPoints.length < 3) return null;
  const bounds = roomBounds({
    id: roomId,
    floor: floor as FloorId,
    kind,
    poly: { points: normalizedPoints },
  });
  if (!bounds || bounds.width < GRID_SIZE / 2 || bounds.height < GRID_SIZE / 2) return null;
  return {
    id: roomId,
    floor: floor as FloorId,
    kind,
    poly: { points: normalizedPoints },
    label: {
      ...roomLabelPosition({
        id: roomId,
        floor: floor as FloorId,
        kind,
        poly: { points: normalizedPoints },
      }),
      text: labelText,
    },
  };
}

function polygonPerimeter(points: LayoutPoint[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return total;
}

function polygonArea(points: LayoutPoint[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}

function polygonEdgeLength(points: LayoutPoint[], startIndex: number): number {
  if (points.length < 2) return 0;
  const current = points[startIndex];
  const next = points[(startIndex + 1) % points.length];
  return Math.hypot(next.x - current.x, next.y - current.y);
}

function replaceRoomPolygonPoint(room: LayoutRoom, pointIndex: number, nextPoint: LayoutPoint): LayoutRoom {
  if (!room.poly) return room;
  const nextPoints = room.poly.points.map((point, index) => (index === pointIndex ? snapPoint(nextPoint) : point));
  return {
    ...room,
    poly: { points: nextPoints },
    label: room.label
      ? { ...roomLabelPosition({ ...room, poly: { points: nextPoints } }), text: room.label.text }
      : room.label,
  };
}

function insertRoomPolygonPoint(room: LayoutRoom, pointIndex: number): LayoutRoom {
  if (!room.poly || room.poly.points.length < 2) return room;
  const nextIndex = (pointIndex + 1) % room.poly.points.length;
  const current = room.poly.points[pointIndex];
  const next = room.poly.points[nextIndex];
  const midPoint = snapPoint({ x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 });
  const nextPoints = [...room.poly.points];
  nextPoints.splice(pointIndex + 1, 0, midPoint);
  return {
    ...room,
    poly: { points: nextPoints },
    label: room.label
      ? { ...roomLabelPosition({ ...room, poly: { points: nextPoints } }), text: room.label.text }
      : room.label,
  };
}

function removeRoomPolygonPoint(room: LayoutRoom, pointIndex: number): LayoutRoom {
  if (!room.poly || room.poly.points.length <= 3) return room;
  const nextPoints = room.poly.points.filter((_, index) => index !== pointIndex);
  return {
    ...room,
    poly: { points: nextPoints },
    label: room.label
      ? { ...roomLabelPosition({ ...room, poly: { points: nextPoints } }), text: room.label.text }
      : room.label,
  };
}

function scalePolygonToBounds(
  room: LayoutRoom,
  nextBounds: { x?: number; y?: number; width?: number; height?: number }
): LayoutRoom {
  if (!room.poly?.points?.length) return room;
  const currentBounds = roomBounds(room);
  if (!currentBounds) return room;
  const targetX = nextBounds.x ?? currentBounds.x;
  const targetY = nextBounds.y ?? currentBounds.y;
  const targetWidth = Math.max(10, nextBounds.width ?? currentBounds.width);
  const targetHeight = Math.max(10, nextBounds.height ?? currentBounds.height);
  const scaleX = currentBounds.width === 0 ? 1 : targetWidth / currentBounds.width;
  const scaleY = currentBounds.height === 0 ? 1 : targetHeight / currentBounds.height;
  const nextPoints = room.poly.points.map((point) => ({
    x: snap(targetX + (point.x - currentBounds.x) * scaleX),
    y: snap(targetY + (point.y - currentBounds.y) * scaleY),
  }));
  return {
    ...room,
    poly: { points: nextPoints },
    label: room.label
      ? { ...roomLabelPosition({ ...room, poly: { points: nextPoints } }), text: room.label.text }
      : room.label,
  };
}

function sortedFloorNumbersFromLayouts(layouts: LayoutsByFloor): BuilderFloor[] {
  return Object.keys(layouts)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

function cloneLayoutsByFloor(layouts: LayoutsByFloor): LayoutsByFloor {
  const next: LayoutsByFloor = {};
  sortedFloorNumbersFromLayouts(layouts).forEach((floorNum) => {
    next[floorNum] = cloneLayout(layouts[floorNum]);
  });
  return next;
}

function relabelLayoutFloor(layout: Layout, floor: BuilderFloor): Layout {
  const next = cloneLayout(layout);
  next.rooms = next.rooms.map((room) => ({ ...room, floor: floor as FloorId }));
  return next;
}

function clearLayoutRooms(layout: Layout): Layout {
  const next = cloneLayout(layout);
  next.rooms = [];
  return next;
}

function deriveVisibleFloorsFromLayouts(layouts: LayoutsByFloor): BuilderFloor[] {
  const floors = sortedFloorNumbersFromLayouts(layouts);
  const nonEmptyFloors = floors.filter((floorNum) => layouts[floorNum].rooms.length > 0);
  return nonEmptyFloors.length ? nonEmptyFloors : [1];
}

function createEmptyLayoutsFromCanonical(canonicalMapLayout: CanonicalMapLayout): LayoutsByFloor {
  const canonicalLayouts = mapLayoutToLayoutsByFloor(canonicalMapLayout);
  const empty: LayoutsByFloor = {};
  BASE_FLOORS.forEach((floorNum) => {
    empty[floorNum] = clearLayoutRooms(canonicalLayouts[floorNum]);
  });
  return empty;
}

function loadDefaults(): LayoutsByFloor {
  return mapLayoutToLayoutsByFloor(CANONICAL_MAP_LAYOUT);
}

async function fetchJsonFromEndpoints<T>(endpoints: string[]): Promise<T | null> {
  for (const endpoint of Array.from(new Set(endpoints))) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      // Try the next endpoint.
    }
  }
  return null;
}

function parseLayoutFromSvg(svg: string, floor: BuilderFloor): Layout {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  const root = doc.querySelector("svg");
  const viewBox = root?.getAttribute("viewBox") ?? "0 0 1768 930";
  const viewParts = viewBox.split(/\s+/).map(Number);
  const vbw = Number.isFinite(viewParts[2]) ? viewParts[2] : 1768;
  const vbh = Number.isFinite(viewParts[3]) ? viewParts[3] : 930;

  const rawMpc = Number(root?.getAttribute("data-meters-per-cell") ?? "");
  const metersPerCellSvg = Number.isFinite(rawMpc) && rawMpc > 0 ? rawMpc : undefined;

  const groups = Array.from(doc.querySelectorAll("g[data-room-id]"));
  const rooms: LayoutRoom[] = groups.map((g) => {
    const id = g.getAttribute("data-room-id") ?? `room-${Date.now()}`;
    const kind = (g.getAttribute("data-kind") as LayoutRoomKind) ?? "room";
    const wing = ((g.getAttribute("data-wing") ?? undefined) as WingId | undefined) ?? undefined;
    const wingName = normalizeWingName(g.getAttribute("data-wing-name"));
    const rect = g.querySelector("rect");
    const path = g.querySelector("path");
    const shape = rect ?? path;
    const text = g.querySelector("text");
    const rx = Number(rect?.getAttribute("rx") ?? 8);
    const x = Number(rect?.getAttribute("x") ?? 0);
    const y = Number(rect?.getAttribute("y") ?? 0);
    const w = Number(rect?.getAttribute("width") ?? 0);
    const h = Number(rect?.getAttribute("height") ?? 0);
    const rawRotation = Number(rect?.getAttribute("data-rotation") ?? 0);
    const rotation = Number.isFinite(rawRotation) && rawRotation !== 0 ? rawRotation : undefined;
    const pathD = path?.getAttribute("d") ?? "";
    const pathPoints = pathD
      .replace(/[MLZ]/gi, " ")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isFinite(value));
    const parsedPolyPoints: LayoutPoint[] = [];
    for (let index = 0; index < pathPoints.length - 1; index += 2) {
      parsedPolyPoints.push({ x: pathPoints[index], y: pathPoints[index + 1] });
    }
    const lx = Number(text?.getAttribute("x") ?? x + w / 2);
    const ly = Number(text?.getAttribute("y") ?? y + h / 2);
    const labelText = text?.textContent ?? id;
    const defaultFill = roomStyle(kind, wing).fill.toLowerCase();
    const parsedFill = normalizeHexColor(shape?.getAttribute("fill"));
    return {
      id,
      floor: floor as FloorId,
      kind,
      wing,
      wingName,
      fill: parsedFill && parsedFill !== defaultFill ? parsedFill : undefined,
      rect: rect ? { x, y, w, h, r: Number.isFinite(rx) ? rx : 8, rotation } : undefined,
      poly: !rect && parsedPolyPoints.length >= 3 ? { points: parsedPolyPoints } : undefined,
      label: { x: lx, y: ly, text: labelText },
    };
  });

  return {
    version: 1,
    units: "px",
    viewBox: { w: vbw, h: vbh },
    grid: CANONICAL_MAP_LAYOUT.grid ? { ...CANONICAL_MAP_LAYOUT.grid } : undefined,
    metersPerCell: metersPerCellSvg,
    rooms,
  };
}

function buildSvgDraftFromLayouts(
  layouts: LayoutsByFloor,
  fields?: {
    draftId?: string;
    note?: string;
    source?: string;
    createdAt?: string;
    baseMapLayout?: CanonicalMapLayout;
  }
): MainLayoutSvgDraft {
  const createdAt = fields?.createdAt ?? new Date().toISOString();
  const floors = sortedFloorNumbersFromLayouts(layouts).reduce<Record<string, { svg?: string }>>((acc, floorNum) => {
    acc[String(floorNum)] = { svg: layoutToSvg(layouts[floorNum]) };
    return acc;
  }, {});
  return {
    version: 1,
    source: fields?.source ?? "layout-config",
    draftId: fields?.draftId,
    createdAt,
    note: fields?.note,
    baseMapLayout: fields?.baseMapLayout ? cloneCanonicalMapLayout(fields.baseMapLayout) : undefined,
    floors,
  };
}

function roomBounds(room: LayoutRoom): { x: number; y: number; width: number; height: number } | null {
  if (room.rect) {
    return { x: room.rect.x, y: room.rect.y, width: room.rect.w, height: room.rect.h };
  }
  if (room.poly?.points?.length) {
    const xs = room.poly.points.map((point) => point.x);
    const ys = room.poly.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }
  return null;
}

type AutoHallwayOverlay = {
  id: string;
  label: string;
  slot: "a" | "b" | "c" | "vertical";
  x: number;
  y: number;
  w: number;
  h: number;
};

const ROUTING_HALLWAY_ID_MAP: Record<
  1 | 2 | 3,
  { a: string; b: string; c: string; vertical: string }
> = {
  1: { a: "hallway_wing_a_1_1", b: "hallway_wing_b_1_2", c: "hallway_wing_c_1_3", vertical: "vertical_hallway_1_1" },
  2: { a: "hallway_wing_a_2_1", b: "hallway_wing_b_2_2", c: "hallway_wing_c_2_3", vertical: "vertical_hallway_2_1" },
  3: { a: "hallway_wing_a_3_1", b: "hallway_wing_b_3_2", c: "hallway_wing_c_3_3", vertical: "vertical_hallway_3_1" },
};

const PREVIOUS_ROUTING_HALLWAY_ID_MAP: Record<
  1 | 2 | 3,
  { a: string; b: string; c: string; vertical: string }
> = {
  1: { a: "hall_1_3", b: "hall_b_1_4", c: "hall_c_1_3", vertical: "hall_1_6" },
  2: { a: "hall_2_3", b: "hall_b_2_4", c: "hall_c_2_2", vertical: "hall_2_0" },
  3: { a: "hall_3_3", b: "hall_b_3_4", c: "hall_c_3_3", vertical: "hall_3_0" },
};

function routingHallwayIdForSlot(floor: BuilderFloor, slot: "a" | "b" | "c" | "vertical"): string {
  const mapped = ROUTING_HALLWAY_ID_MAP[floor as 1 | 2 | 3];
  if (mapped) return mapped[slot];
  if (slot === "vertical") return `hallway_wing_a_${floor}_4`;
  if (slot === "a") return `hallway_wing_a_${floor}_1`;
  if (slot === "b") return `hallway_wing_b_${floor}_2`;
  return `hallway_wing_c_${floor}_3`;
}

function legacyAutoHallwayIdForSlot(floor: BuilderFloor, slot: "a" | "b" | "c" | "vertical"): string {
  return `hallway-auto-f${floor}-${slot}`;
}

function shiftRoomBy(room: LayoutRoom, dx: number, dy: number): LayoutRoom {
  const next: LayoutRoom = { ...room };
  if (room.rect) {
    next.rect = { ...room.rect, x: room.rect.x + dx, y: room.rect.y + dy };
  }
  if (room.poly?.points?.length) {
    next.poly = {
      ...room.poly,
      points: room.poly.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    };
  }
  if (room.label) {
    next.label = { ...room.label, x: room.label.x + dx, y: room.label.y + dy };
  }
  return next;
}

function roomBoundsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function roomGroupBounds(rooms: LayoutRoom[]): { x: number; y: number; width: number; height: number } | null {
  const bounds = rooms
    .map((room) => roomBounds(room))
    .filter((roomBoundsValue): roomBoundsValue is NonNullable<typeof roomBoundsValue> => Boolean(roomBoundsValue));
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function pickRoomCopyOffset(sourceRoom: LayoutRoom, rooms: LayoutRoom[]): { dx: number; dy: number } {
  const sourceBounds = roomBounds(sourceRoom);
  if (!sourceBounds) {
    return { dx: ROOM_COPY_OFFSET_STEP, dy: ROOM_COPY_OFFSET_STEP };
  }
  const occupiedBounds = rooms
    .filter((room) => room !== sourceRoom)
    .map((room) => roomBounds(room))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds));

  for (let step = 1; step <= ROOM_COPY_SEARCH_LIMIT; step += 1) {
    const offset = ROOM_COPY_OFFSET_STEP * step;
    const candidates = [
      { dx: offset, dy: offset },
      { dx: offset, dy: 0 },
      { dx: 0, dy: offset },
      { dx: -offset, dy: offset },
      { dx: offset, dy: -offset },
      { dx: -offset, dy: 0 },
      { dx: 0, dy: -offset },
      { dx: -offset, dy: -offset },
    ];
    for (const candidate of candidates) {
      const candidateBounds = {
        x: sourceBounds.x + candidate.dx,
        y: sourceBounds.y + candidate.dy,
        width: sourceBounds.width,
        height: sourceBounds.height,
      };
      const overlaps = occupiedBounds.some((occupied) => roomBoundsOverlap(candidateBounds, occupied));
      if (!overlaps) return candidate;
    }
  }

  return { dx: ROOM_COPY_OFFSET_STEP, dy: ROOM_COPY_OFFSET_STEP };
}

function pickRoomGroupCopyOffset(sourceRooms: LayoutRoom[], rooms: LayoutRoom[]): { dx: number; dy: number } {
  if (sourceRooms.length <= 1) {
    return sourceRooms.length === 1
      ? pickRoomCopyOffset(sourceRooms[0], rooms)
      : { dx: ROOM_COPY_OFFSET_STEP, dy: ROOM_COPY_OFFSET_STEP };
  }
  const sourceBounds = roomGroupBounds(sourceRooms);
  if (!sourceBounds) {
    return { dx: ROOM_COPY_OFFSET_STEP, dy: ROOM_COPY_OFFSET_STEP };
  }
  const sourceIds = new Set(sourceRooms.map((room) => room.id));
  const occupiedBounds = rooms
    .filter((room) => !sourceIds.has(room.id))
    .map((room) => roomBounds(room))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds));

  for (let step = 1; step <= ROOM_COPY_SEARCH_LIMIT; step += 1) {
    const offset = ROOM_COPY_OFFSET_STEP * step;
    const candidates = [
      { dx: offset, dy: offset },
      { dx: offset, dy: 0 },
      { dx: 0, dy: offset },
      { dx: -offset, dy: offset },
      { dx: offset, dy: -offset },
      { dx: -offset, dy: 0 },
      { dx: 0, dy: -offset },
      { dx: -offset, dy: -offset },
    ];
    for (const candidate of candidates) {
      const candidateBounds = {
        x: sourceBounds.x + candidate.dx,
        y: sourceBounds.y + candidate.dy,
        width: sourceBounds.width,
        height: sourceBounds.height,
      };
      const overlaps = occupiedBounds.some((occupied) => roomBoundsOverlap(candidateBounds, occupied));
      if (!overlaps) return candidate;
    }
  }

  return { dx: ROOM_COPY_OFFSET_STEP, dy: ROOM_COPY_OFFSET_STEP };
}

function buildCopiedRoomId(sourceId: string, existingIds: Set<string>): string {
  const source = sourceId.trim() || "room";
  const baseCandidate = `${source}-copy`;
  if (!existingIds.has(baseCandidate)) return baseCandidate;
  let suffix = 2;
  while (existingIds.has(`${baseCandidate}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseCandidate}-${suffix}`;
}

function buildCopiedRoomLabel(sourceRoom: LayoutRoom, existingRooms: LayoutRoom[]): string {
  const baseText = sourceRoom.label?.text?.trim() || sourceRoom.id;
  const labelCandidate = `${baseText} Copy`;
  const existingLabels = new Set(
    existingRooms
      .map((room) => room.label?.text?.trim())
      .filter((text): text is string => Boolean(text))
  );
  if (!existingLabels.has(labelCandidate)) return labelCandidate;
  let suffix = 2;
  while (existingLabels.has(`${labelCandidate} ${suffix}`)) {
    suffix += 1;
  }
  return `${labelCandidate} ${suffix}`;
}

function normalizeLayoutsToGrid(layouts: LayoutsByFloor): LayoutsByFloor {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;

  const floors = sortedFloorNumbersFromLayouts(layouts);
  floors.forEach((floor) => {
    layouts[floor].rooms.forEach((room) => {
      const bounds = roomBounds(room);
      if (!bounds) return;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
    });
  });

  const base = cloneLayoutsByFloor(layouts);

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return base;
  }

  const dx = minX < GRID_PADDING ? GRID_PADDING - minX : 0;
  const dy = minY < GRID_PADDING ? GRID_PADDING - minY : 0;
  if (dx === 0 && dy === 0) {
    return base;
  }

  const shifted = cloneLayoutsByFloor(base);
  floors.forEach((floorNum) => {
    shifted[floorNum] = {
      ...shifted[floorNum],
      rooms: shifted[floorNum].rooms.map((room) => shiftRoomBy(room, dx, dy)),
    };
  });
  return shifted;
}

function inferWingForAutoHallway(room: LayoutRoom): "A" | "B" | "C" | null {
  if (
    room.kind === "bridge" ||
    room.kind === "entrance" ||
    room.kind === "hallway" ||
    room.kind === "wing_background"
  ) {
    return null;
  }
  const id = room.id.toLowerCase();
  const label = room.label?.text?.toLowerCase() ?? "";

  if (
    id.includes("wingc") ||
    id.includes("womens-cr-c") ||
    id.includes("mens-cr-c") ||
    id.includes("office-c") ||
    /(?:^|[-_])c\d{1,3}[a-z]?(?:$|[-_])/i.test(id) ||
    /\bc\d{3}[a-z]?\b/i.test(label) ||
    /\bwing c\b/i.test(label)
  ) {
    return "C";
  }
  if (
    id.includes("wingb") ||
    /(?:^|[-_])b\d{1,3}[a-z]?(?:$|[-_])/i.test(id) ||
    /\bb\d{3}[a-z]?\b/i.test(label) ||
    /\bwing b\b/i.test(label)
  ) {
    return "B";
  }
  if (
    id.includes("winga") ||
    /(?:^|[-_])a\d{1,3}[a-z]?(?:$|[-_])/i.test(id) ||
    /\ba\d{3}[a-z]?\b/i.test(label) ||
    /\bwing a\b/i.test(label)
  ) {
    return "A";
  }
  return null;
}

function deriveWingCorridor(
  layout: Layout,
  wing: "A" | "B" | "C"
): { x: number; w: number; centerY: number } | null {
  const boxes = layout.rooms
    .filter((room) => inferWingForAutoHallway(room) === wing)
    .map((room) => roomBounds(room))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds));
  if (boxes.length < 2) return null;

  const centerYs = boxes.map((bounds) => bounds.y + bounds.height / 2).sort((a, b) => a - b);
  let splitIdx = -1;
  let maxGap = 0;
  for (let i = 0; i < centerYs.length - 1; i += 1) {
    const gap = centerYs[i + 1] - centerYs[i];
    if (gap > maxGap) {
      maxGap = gap;
      splitIdx = i;
    }
  }
  if (splitIdx < 0 || maxGap < AUTO_HALLWAY_MIN_ROW_GAP) return null;

  const topRow = centerYs.slice(0, splitIdx + 1);
  const bottomRow = centerYs.slice(splitIdx + 1);
  if (!topRow.length || !bottomRow.length) return null;

  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const centerY = (avg(topRow) + avg(bottomRow)) / 2;
  const minX = Math.min(...boxes.map((bounds) => bounds.x));
  const maxX = Math.max(...boxes.map((bounds) => bounds.x + bounds.width));
  return { x: minX, w: Math.max(40, maxX - minX), centerY };
}

function deriveAutoHallwayOverlays(layout: Layout, floor: BuilderFloor): AutoHallwayOverlay[] {
  const corridors: Record<"A" | "B" | "C", { x: number; w: number; centerY: number } | null> = {
    A: deriveWingCorridor(layout, "A"),
    B: deriveWingCorridor(layout, "B"),
    C: deriveWingCorridor(layout, "C"),
  };
  const overlays: AutoHallwayOverlay[] = [];

  (["A", "B", "C"] as const).forEach((wing) => {
    const corridor = corridors[wing];
    if (!corridor) return;
    const slot = wing.toLowerCase() as "a" | "b" | "c";
    const routingId = routingHallwayIdForSlot(floor, slot);
    const edgeInset = wing === "A" || wing === "C" ? AUTO_HALLWAY_EDGE_INSET : 0;
    const trimmedX = corridor.x + edgeInset;
    const trimmedW = Math.max(20, corridor.w - edgeInset * 2);
    overlays.push({
      id: routingId,
      label: routingId,
      slot,
      x: trimmedX,
      y: corridor.centerY - AUTO_HALLWAY_THICKNESS / 2,
      w: trimmedW,
      h: AUTO_HALLWAY_THICKNESS,
    });
  });

  let abBridgeCenterX: number | null = null;
  let bcBridgeCenterX: number | null = null;
  layout.rooms.forEach((room) => {
    if (room.kind !== "bridge" || !room.rect) return;
    const centerX = room.rect.x + room.rect.w / 2;
    const id = room.id.toLowerCase();
    if (id.includes("to-c") || id.includes("_bc")) {
      bcBridgeCenterX = centerX;
      return;
    }
    if (id.includes("to-stairs") || id.includes("_ab") || id.includes("a") || id.includes("b")) {
      abBridgeCenterX = centerX;
    }
  });

  const verticalXCandidates: number[] = [];
  if (abBridgeCenterX !== null) verticalXCandidates.push(abBridgeCenterX);
  if (bcBridgeCenterX !== null) verticalXCandidates.push(bcBridgeCenterX);

  const verticalYCandidates: number[] = [];
  (["A", "B", "C"] as const).forEach((wing) => {
    const centerY = corridors[wing]?.centerY;
    if (typeof centerY === "number") {
      verticalYCandidates.push(centerY);
    }
  });
  if (verticalXCandidates.length && verticalYCandidates.length >= 2) {
    const x = verticalXCandidates.reduce((sum, value) => sum + value, 0) / verticalXCandidates.length;
    let top = Math.min(...verticalYCandidates);
    let bottom = Math.max(...verticalYCandidates);
    if (bottom - top > AUTO_VERTICAL_OVERLAP_TRIM * 2 + 12) {
      top += AUTO_VERTICAL_OVERLAP_TRIM;
      bottom -= AUTO_VERTICAL_OVERLAP_TRIM;
    }
    if (bottom - top >= 12) {
      const routingId = routingHallwayIdForSlot(floor, "vertical");
      overlays.push({
        id: routingId,
        label: routingId,
        slot: "vertical",
        x: x - AUTO_HALLWAY_THICKNESS / 2,
        y: top,
        w: AUTO_HALLWAY_THICKNESS,
        h: bottom - top,
      });
    }
  }

  return overlays;
}

function autoHallwayOverlayToRoom(floor: BuilderFloor, overlay: AutoHallwayOverlay): LayoutRoom {
  return {
    id: overlay.id,
    floor: floor as FloorId,
    kind: "hallway",
    rect: { x: overlay.x, y: overlay.y, w: overlay.w, h: overlay.h, r: 8 },
    label: {
      x: overlay.x + overlay.w / 2,
      y: overlay.y + overlay.h / 2,
      text: overlay.label,
    },
  };
}

function normalizeRoutingHallwayRooms(layout: Layout, floor: BuilderFloor): Layout {
  const routingByLegacy = new Map<string, string>();
  (["a", "b", "c", "vertical"] as const).forEach((slot) => {
    routingByLegacy.set(legacyAutoHallwayIdForSlot(floor, slot), routingHallwayIdForSlot(floor, slot));
    const previous = PREVIOUS_ROUTING_HALLWAY_ID_MAP[floor as 1 | 2 | 3];
    if (previous) {
      routingByLegacy.set(previous[slot], routingHallwayIdForSlot(floor, slot));
    }
  });

  const usedIds = new Set<string>();
  const nextRooms: LayoutRoom[] = [];

  layout.rooms.forEach((room) => {
    let nextRoom = room;
    if (room.kind === "hallway") {
      const mappedId = routingByLegacy.get(room.id) ?? room.id;
      if (mappedId !== room.id) {
        nextRoom = { ...nextRoom, id: mappedId };
      }
      if (
        mappedId.startsWith("hall_") ||
        mappedId.startsWith("hallway_wing_") ||
        mappedId.startsWith("bridge_hall_") ||
        routingByLegacy.has(room.id)
      ) {
        nextRoom = {
          ...nextRoom,
          label: { ...(nextRoom.label ?? roomLabelPosition(nextRoom)), text: mappedId },
        };
      }
    }

    if (usedIds.has(nextRoom.id)) {
      return;
    }
    usedIds.add(nextRoom.id);
    nextRooms.push(nextRoom);
  });

  return { ...layout, rooms: nextRooms };
}

function materializeHorizontalAutoHallways(layout: Layout, floor: BuilderFloor): Layout {
  const normalized = normalizeRoutingHallwayRooms(layout, floor);
  const existingIds = new Set(normalized.rooms.map((room) => room.id));
  const additions = deriveAutoHallwayOverlays(normalized, floor)
    .filter((overlay) => !existingIds.has(overlay.id))
    .map((overlay) => autoHallwayOverlayToRoom(floor, overlay));
  if (!additions.length) return normalized;
  return { ...normalized, rooms: [...normalized.rooms, ...additions] };
}

function layoutKindToSpaceType(kind: LayoutRoomKind): Space["type"] {
  if (kind === "bridge") return SPACE_TYPE_BRIDGE;
  if (kind === "entrance") return SPACE_TYPE_ENTRANCE;
  if (kind === "stairs") return SPACE_TYPE_STAIRS;
  if (kind === "lounge") return SPACE_TYPE_LOUNGE;
  if (kind === "hallway") return SPACE_TYPE_HALLWAY;
  return SPACE_TYPE_ROOM;
}

function isPassableForKind(kind: LayoutRoomKind): boolean {
  return kind === "stairs" || kind === "lounge" || kind === "bridge" || kind === "entrance" || kind === "hallway";
}

function cloneFloorSource(source: FloorSource): FloorSource {
  return {
    wingBackgrounds: source.wingBackgrounds
      ? (Object.fromEntries(
          Object.entries(source.wingBackgrounds).map(([wing, rect]) => [wing, rect ? { ...rect } : rect])
        ) as Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>)
      : undefined,
    wings: {
      A: source.wings.A.map((space) => ({
        ...space,
        poly: space.poly ? { points: space.poly.points.map((point) => ({ ...point })) } : undefined,
      })),
      B: source.wings.B.map((space) => ({
        ...space,
        poly: space.poly ? { points: space.poly.points.map((point) => ({ ...point })) } : undefined,
      })),
      C: source.wings.C.map((space) => ({
        ...space,
        poly: space.poly ? { points: space.poly.points.map((point) => ({ ...point })) } : undefined,
      })),
    },
    bridges: {
      AB: { ...source.bridges.AB, poly: source.bridges.AB.poly ? { points: source.bridges.AB.poly.points.map((point) => ({ ...point })) } : undefined },
      BC: { ...source.bridges.BC, poly: source.bridges.BC.poly ? { points: source.bridges.BC.poly.points.map((point) => ({ ...point })) } : undefined },
    },
  };
}

function cloneCanonicalMapLayout(source: CanonicalMapLayout): CanonicalMapLayout {
  return {
    version: source.version,
    units: source.units,
    viewBox: { ...source.viewBox },
    grid: source.grid ? { ...source.grid } : undefined,
    mainEntrance: source.mainEntrance ? { ...source.mainEntrance } : undefined,
    floors: {
      "1": cloneFloorSource(source.floors["1"] ?? emptyFloorSource()),
      "2": cloneFloorSource(source.floors["2"] ?? emptyFloorSource()),
      "3": cloneFloorSource(source.floors["3"] ?? emptyFloorSource()),
    },
  };
}

function buildFloorSourceFromLayout(layout: Layout, canonicalSource: FloorSource): FloorSource {
  const next: FloorSource = {
    wingBackgrounds: canonicalSource.wingBackgrounds
      ? (Object.fromEntries(
          Object.entries(canonicalSource.wingBackgrounds).map(([wing, rect]) => [wing, rect ? { ...rect } : rect])
        ) as Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>)
      : {},
    wings: { A: [], B: [], C: [] },
    bridges: { AB: { ...canonicalSource.bridges.AB }, BC: { ...canonicalSource.bridges.BC } },
  };

  const canonicalBucketById = new Map<string, "A" | "B" | "C" | "AB" | "BC">();
  canonicalSource.wings.A.forEach((space) => canonicalBucketById.set(space.id, "A"));
  canonicalSource.wings.B.forEach((space) => canonicalBucketById.set(space.id, "B"));
  canonicalSource.wings.C.forEach((space) => canonicalBucketById.set(space.id, "C"));
  canonicalBucketById.set(canonicalSource.bridges.AB.id, "AB");
  canonicalBucketById.set(canonicalSource.bridges.BC.id, "BC");

  const getWingBounds = (spaces: Space[]) => {
    if (!spaces.length) return null;
    const xs = spaces.map((space) => [space.x, space.x + space.width]).flat();
    const ys = spaces.map((space) => [space.y, space.y + space.height]).flat();
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  };
  const combineBounds = (boxes: Array<{ x: number; y: number; width: number; height: number } | null>) => {
    const resolved = boxes.filter((box): box is NonNullable<typeof box> => Boolean(box));
    if (!resolved.length) return null;
    const xs = resolved.map((box) => [box.x, box.x + box.width]).flat();
    const ys = resolved.map((box) => [box.y, box.y + box.height]).flat();
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  };
  const getLayoutWingBackgroundBounds = (wing: "A" | "B" | "C") =>
    combineBounds(
      layout.rooms
        .filter((room) => room.kind === "wing_background" && room.wing === wing)
        .map((room) => roomBounds(room))
    );
  const getCanonicalWingBackgroundBounds = (wing: "A" | "B" | "C") => {
    const rect = canonicalSource.wingBackgrounds?.[wing];
    if (!rect) return null;
    return {
      minX: rect.x,
      maxX: rect.x + rect.width,
      minY: rect.y,
      maxY: rect.y + rect.height,
    };
  };
  const wingBounds: Record<"A" | "B" | "C", ReturnType<typeof getWingBounds>> = {
    A: getLayoutWingBackgroundBounds("A") ?? getCanonicalWingBackgroundBounds("A") ?? getWingBounds(canonicalSource.wings.A),
    B: getLayoutWingBackgroundBounds("B") ?? getCanonicalWingBackgroundBounds("B") ?? getWingBounds(canonicalSource.wings.B),
    C: getLayoutWingBackgroundBounds("C") ?? getCanonicalWingBackgroundBounds("C") ?? getWingBounds(canonicalSource.wings.C),
  };
  const inferWingBucketFromIdentifiers = (space: Space): "A" | "B" | "C" | null => {
    const id = space.id.toLowerCase();
    const name = space.name.toLowerCase();
    const hasIdToken = (letter: "a" | "b" | "c") =>
      new RegExp(`(?:^|[-_])${letter}\\d{1,3}(?:$|[-_])`, "i").test(id);
    const hasNameToken = (letter: "A" | "B" | "C") =>
      new RegExp(`\\b${letter}\\d{3}\\b`, "i").test(space.name);

    if (
      id.includes("wingc") ||
      id.includes("womens-cr-c") ||
      id.includes("mens-cr-c") ||
      id.includes("office-c") ||
      hasIdToken("c") ||
      hasNameToken("C") ||
      /\bwing c\b/i.test(name)
    ) {
      return "C";
    }
    if (id.includes("wingb") || hasIdToken("b") || hasNameToken("B") || /\bwing b\b/i.test(name)) {
      return "B";
    }
    if (id.includes("winga") || hasIdToken("a") || hasNameToken("A") || /\bwing a\b/i.test(name)) {
      return "A";
    }
    return null;
  };
  const inferWingBucket = (space: Space): "A" | "B" | "C" => {
    const centerX = space.x + space.width / 2;
    const centerY = space.y + space.height / 2;
    const inBounds: Array<"A" | "B" | "C"> = (["A", "B", "C"] as const).filter((wing) => {
      const bounds = wingBounds[wing];
      return (
        bounds &&
        centerX >= bounds.minX &&
        centerX <= bounds.maxX &&
        centerY >= bounds.minY &&
        centerY <= bounds.maxY
      );
    });
    if (inBounds.length === 1) return inBounds[0];
    if (inBounds.length > 1) {
      return inBounds[0];
    }

    let bestWing: "A" | "B" | "C" = "A";
    let bestDistance = Number.POSITIVE_INFINITY;
    (["A", "B", "C"] as const).forEach((wing) => {
      const bounds = wingBounds[wing];
      if (!bounds) return;
      const clampedX = Math.max(bounds.minX, Math.min(centerX, bounds.maxX));
      const clampedY = Math.max(bounds.minY, Math.min(centerY, bounds.maxY));
      const dx = centerX - clampedX;
      const dy = centerY - clampedY;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestWing = wing;
      }
    });
    return bestWing;
  };

  layout.rooms.forEach((room) => {
    const bounds = roomBounds(room);
    if (!bounds) return;
    if (room.kind === "wing_background") {
      const wing = room.wing ?? "A";
      next.wingBackgrounds = next.wingBackgrounds ?? {};
      next.wingBackgrounds[wing] = {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        r: room.rect?.r ?? 10,
      };
      return;
    }

    const kind = room.kind;
    const space: Space = {
      id: room.id,
      name: room.label?.text?.trim() || room.id,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      poly: room.poly?.points?.length
        ? {
            points: room.poly.points.map((point) => ({
              x: Math.round(point.x),
              y: Math.round(point.y),
            })),
          }
        : undefined,
      type: layoutKindToSpaceType(kind),
      passable: isPassableForKind(kind),
      fill: room.kind === "room" ? normalizeHexColor(room.fill) : undefined,
    };

    const canonicalBucket = canonicalBucketById.get(room.id);
    const canonicalWingBucket =
      canonicalBucket === "A" || canonicalBucket === "B" || canonicalBucket === "C" ? canonicalBucket : null;
    const inferredFromId = space.type === SPACE_TYPE_ROOM ? inferWingBucketFromIdentifiers(space) : null;
    const canonicalBridgeBucket =
      canonicalBucket === "AB" || canonicalBucket === "BC" ? canonicalBucket : null;
    const bucket =
      space.type === SPACE_TYPE_BRIDGE && canonicalBridgeBucket
        ? canonicalBridgeBucket
        : space.type === SPACE_TYPE_BRIDGE
          ? inferredFromId ?? canonicalWingBucket ?? inferWingBucket(space)
        : inferredFromId ?? canonicalWingBucket ?? inferWingBucket(space);

    if (bucket === "A" || bucket === "B" || bucket === "C") {
      next.wings[bucket].push(space);
      return;
    }

    if (bucket === "AB" || bucket === "BC") {
      next.bridges[bucket] = { ...space, type: "bridge", passable: true };
    }
  });

  return next;
}

function buildMainLayoutJsonFromLayouts(
  layouts: LayoutsByFloor,
  canonicalMapLayout: CanonicalMapLayout
): CanonicalMapLayout {
  const floors = {
    "1": buildFloorSourceFromLayout(layouts[1], cloneFloorSource(canonicalMapLayout.floors["1"])),
    "2": buildFloorSourceFromLayout(layouts[2], cloneFloorSource(canonicalMapLayout.floors["2"])),
    "3": buildFloorSourceFromLayout(layouts[3], cloneFloorSource(canonicalMapLayout.floors["3"])),
  };

  const mainEntranceRoom = layouts[1].rooms.find((room) => room.id === "main-entrance" || room.kind === "entrance");
  const mainEntranceBounds = mainEntranceRoom ? roomBounds(mainEntranceRoom) : null;
  const mainEntrance =
    mainEntranceBounds !== null
      ? {
          x: Math.round(mainEntranceBounds.x + mainEntranceBounds.width / 2),
          y: Math.round(mainEntranceBounds.y + mainEntranceBounds.height / 2),
        }
      : canonicalMapLayout.mainEntrance;

  return {
    version: canonicalMapLayout.version,
    units: canonicalMapLayout.units,
    viewBox: { ...canonicalMapLayout.viewBox },
    grid: canonicalMapLayout.grid ? { ...canonicalMapLayout.grid } : undefined,
    mainEntrance,
    floors,
  };
}

function formatDateForMainSvgLabel(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = date.getFullYear();
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${day}-${month}-${year} ${time}`;
}

function formatDraftSvgLabel(value?: string): string {
  return `Draft ${formatDateForMainSvgLabel(value)}`;
}

function formatMainSvgDateFromFilename(filename: string): string | null {
  const match =
    filename.match(/^map-layout-(\d{2})-([a-z]{3})-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(am|pm)\.json$/i) ??
    filename.match(/^main-svg-(\d{2})-([a-z]{3})-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(am|pm)\.json$/i);
  if (!match) return null;
  const [, day, monthRaw, year, hour, minute, second, ampmRaw] = match;
  const month = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1).toLowerCase();
  const ampm = ampmRaw.toUpperCase();
  return `${day}-${month}-${year} ${hour}:${minute}:${second} ${ampm}`;
}

function normalizeMainLayoutLabel(value: string): string {
  return value.replace(/Main Map/gi, "Main Layout");
}

type RoomLabelRender = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
};

function roomLabelBounds(room: LayoutRoom): { x: number; y: number; w: number; h: number } | null {
  if (room.rect) {
    return { x: room.rect.x, y: room.rect.y, w: room.rect.w, h: room.rect.h };
  }
  const points = room.poly?.points ?? [];
  if (!points.length) return null;
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function ellipsisText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return ".".repeat(maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function wrapLabelText(rawText: string, maxCharsPerLine: number, maxLines: number): string {
  if (maxCharsPerLine <= 0 || maxLines <= 0) return "";
  let remaining = rawText.replace(/\s+/g, " ").trim();
  if (!remaining) return "";
  const lines: string[] = [];

  for (let lineIndex = 0; lineIndex < maxLines && remaining; lineIndex += 1) {
    if (lineIndex === maxLines - 1) {
      lines.push(ellipsisText(remaining, maxCharsPerLine));
      break;
    }
    if (remaining.length <= maxCharsPerLine) {
      lines.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf(" ", maxCharsPerLine);
    if (cutAt < Math.floor(maxCharsPerLine * 0.6)) {
      cutAt = maxCharsPerLine;
    }
    const line = remaining.slice(0, cutAt).trimEnd();
    lines.push(line);
    remaining = remaining.slice(cutAt).trimStart();
  }

  return lines.join("\n");
}

function fitRoomLabel(room: LayoutRoom): RoomLabelRender | null {
  const bounds = roomLabelBounds(room);
  if (!bounds) return null;
  const width = Math.max(0, bounds.w - ROOM_LABEL_PADDING_X * 2);
  const height = Math.max(0, bounds.h - ROOM_LABEL_PADDING_Y * 2);
  if (width < 12 || height < 10) return null;

  const rawText = (room.label?.text ?? room.id).trim();
  if (!rawText) return null;

  for (let fontSize = ROOM_LABEL_MAX_FONT_SIZE; fontSize >= ROOM_LABEL_MIN_FONT_SIZE; fontSize -= 1) {
    const maxCharsPerLine = Math.floor(width / (fontSize * ROOM_LABEL_CHAR_WIDTH_FACTOR));
    const maxLines = Math.max(1, Math.floor(height / (fontSize * ROOM_LABEL_LINE_HEIGHT)));
    if (maxCharsPerLine < 2) continue;
    const text = wrapLabelText(rawText, maxCharsPerLine, maxLines);
    if (!text) continue;
    return {
      x: bounds.x + ROOM_LABEL_PADDING_X,
      y: bounds.y + ROOM_LABEL_PADDING_Y,
      width,
      height,
      text,
      fontSize,
    };
  }
  return null;
}

function roomRenderPriority(kind: LayoutRoomKind): number {
  if (kind === "wing_background") return -1;
  return 0;
}

const DEFAULT_METERS_PER_CELL = 1.0;

function fmtMeters(m: number): string {
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${Math.round(m * 100)} cm`;
}

function fmtSquareMeters(area: number): string {
  if (area >= 100) return `${area.toFixed(0)} sq m`;
  if (area >= 10) return `${area.toFixed(1)} sq m`;
  if (area >= 1) return `${area.toFixed(2)} sq m`;
  return `${Math.round(area * 10000)} sq cm`;
}

function makeRotateCursor(angle: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${angle} 12 12)"><path d="M3 12 A9 9 0 0 1 12 3" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M3 12 A9 9 0 0 1 12 3" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M9 3 L12 0 L15 3" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 3 L12 0 L15 3" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
}

const ROTATE_CURSORS = [0, 90, 180, 270].map(makeRotateCursor);

export default function LayoutBuilder() {
  const stageRef = useRef<any>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedWingBackgroundNodeRef = useRef<any>(null);
  const wingBackgroundTransformerRef = useRef<any>(null);
  const copiedRoomsRef = useRef<LayoutRoom[]>([]);
  const rotateStartRef = useRef<{ startAngle: number; startRotation: number; roomId: string } | null>(null);
  const rotationDraftRef = useRef<number | null>(null);

  const [tool, setTool] = useState<Tool>("pan");
  const [activeFloor, setActiveFloor] = useState<BuilderFloor>(1);
  const [canonicalMapLayout, setCanonicalMapLayout] = useState<CanonicalMapLayout>(CANONICAL_MAP_LAYOUT);
  const [editorBaseMapLayout, setEditorBaseMapLayout] = useState<CanonicalMapLayout>(CANONICAL_MAP_LAYOUT);
  const [layoutsByFloor, setLayoutsByFloor] = useState<LayoutsByFloor>(loadDefaults);
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [view, setView] = useState(DEFAULT_VIEW);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPointer, setLastPanPointer] = useState<LayoutPoint | null>(null);
  const [rotationDraft, setRotationDraft] = useState<number | null>(null);
  const [hoveredRotateHandle, setHoveredRotateHandle] = useState<number | null>(null);
  const [liveResizeDims, setLiveResizeDims] = useState<{ w: number; h: number } | null>(null);
  const [selectedPolygonVertexIndex, setSelectedPolygonVertexIndex] = useState<number | null>(null);
  const [hoveredPolygonVertexIndex, setHoveredPolygonVertexIndex] = useState<number | null>(null);
  const [draftRoom, setDraftRoom] = useState<{ start: LayoutPoint; end: LayoutPoint } | null>(null);
  const [polygonDraft, setPolygonDraft] = useState<PolygonDraft | null>(null);
  const setStatusMessage = (_message: string) => {};
  const [showDraftsPopup, setShowDraftsPopup] = useState(true);
  const [svgListTab, setSvgListTab] = useState<SvgListTab>("main");
  const [activeDraftKey, setActiveDraftKey] = useState<string>("main-layout-svg-current");
  const [loadingDraftKey, setLoadingDraftKey] = useState<string | null>(null);
  const [isBackgroundMapLoading, setIsBackgroundMapLoading] = useState(false);
  const [hoveredDraftKey, setHoveredDraftKey] = useState<string | null>(null);
  const [draftFiles, setDraftFiles] = useState<DraftFileItem[]>([]);
  const [mapHistoryFiles, setMapHistoryFiles] = useState<MapHistoryFileItem[]>([]);
  const [loadedDraftFilename, setLoadedDraftFilename] = useState<string | null>(null);
  const [visibleFloors, setVisibleFloors] = useState<BuilderFloor[]>(() =>
    deriveVisibleFloorsFromLayouts(loadDefaults())
  );
  const [floorToDelete, setFloorToDelete] = useState<BuilderFloor | null>(null);
  const [roomToDelete, setRoomToDelete] = useState<RoomDeleteTarget | null>(null);
  const [draftToDelete, setDraftToDelete] = useState<DraftOption | null>(null);
  const [draftToRename, setDraftToRename] = useState<DraftOption | null>(null);
  const [draftRenameValue, setDraftRenameValue] = useState("");
  const [draftRenameError, setDraftRenameError] = useState("");
  const [mapHistoryNameOverrides, setMapHistoryNameOverrides] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(MAP_HISTORY_NAME_OVERRIDES_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (!parsed || typeof parsed !== "object") return {};
      const normalized = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? normalizeMainLayoutLabel(value) : value])
      ) as Record<string, string>;
      return normalized;
    } catch {
      return {};
    }
  });
  const [toast, setToast] = useState<{ id: number; text: string; tone: ToastTone } | null>(null);
  const [blockingAction, setBlockingAction] = useState<BlockingAction | null>(null);
  const isUiBlocked = blockingAction !== null;
  const [pendingAddFloor, setPendingAddFloor] = useState<{
    sourceFloor: BuilderFloor;
    targetFloor: BuilderFloor;
  } | null>(null);
  const [isAddingFloor, setIsAddingFloor] = useState(false);
  const [copiedRoomCount, setCopiedRoomCount] = useState(0);
  const undoStackRef = useRef<Array<LayoutsByFloor>>([]);
  const hasAutoLoadedMainCurrentRef = useRef(false);
  const [undoCount, setUndoCount] = useState(0);
  const [idDraft, setIdDraft] = useState("");
  const [rectDraft, setRectDraft] = useState<{ x: string; y: string; w: string; h: string }>({
    x: "",
    y: "",
    w: "",
    h: "",
  });

  const applyLoadedMapView = useCallback(() => {
    setView(LOADED_MAP_VIEW);
  }, []);

  const resetToMainMapCurrent = useCallback((source: CanonicalMapLayout) => {
    const nextLayouts = mapLayoutToLayoutsByFloor(source);
    const nextVisibleFloors = deriveVisibleFloorsFromLayouts(nextLayouts);
    setEditorBaseMapLayout(cloneCanonicalMapLayout(source));
    setActiveDraftKey("main-layout-svg-current");
    setLoadedDraftFilename(null);
    setSelection(null);
    applyLayoutChange(() => nextLayouts, {
      recordHistory: false,
    });
    setVisibleFloors(nextVisibleFloors);
    setActiveFloor((prev) => (nextVisibleFloors.includes(prev) ? prev : nextVisibleFloors[0]));
    applyLoadedMapView();
    undoStackRef.current = [];
    setUndoCount(0);
  }, [applyLoadedMapView]);

  const autoLoadMainMapCurrentOnLogin = useCallback(async () => {
    const auth = getAuthState();
    if (!auth.loggedIn) {
      hasAutoLoadedMainCurrentRef.current = false;
      return;
    }
    if (hasAutoLoadedMainCurrentRef.current) {
      return;
    }
    hasAutoLoadedMainCurrentRef.current = true;
    setIsBackgroundMapLoading(true);
    const loadedFromService = await refreshCanonicalMapLayout(true);
    if (!loadedFromService) {
      resetToMainMapCurrent(canonicalMapLayout);
    }
    window.setTimeout(() => setIsBackgroundMapLoading(false), 450);
  }, [canonicalMapLayout, resetToMainMapCurrent]);

  const pushUndoSnapshot = (snapshot: LayoutsByFloor) => {
    undoStackRef.current.push(cloneLayoutsByFloor(snapshot));
    if (undoStackRef.current.length > 100) {
      undoStackRef.current.shift();
    }
    setUndoCount(undoStackRef.current.length);
  };

  const applyLayoutChange = (
    updater: (prev: LayoutsByFloor) => LayoutsByFloor,
    options?: { recordHistory?: boolean }
  ) => {
    setLayoutsByFloor((prev) => {
      const next = updater(prev);
      if (options?.recordHistory !== false) {
        pushUndoSnapshot(prev);
      }
      return next;
    });
  };

  const undoLayoutChange = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) {
      showToast("Nothing to undo.", "info");
      return;
    }
    setUndoCount(undoStackRef.current.length);
    setLayoutsByFloor(cloneLayoutsByFloor(previous));
    setSelection(null);
    setStatusMessage("Undid last change.");
  };

  const showToast = (text: string, tone: ToastTone = "success") => {
    setToast({ id: Date.now(), text, tone });
  };

  const refreshCanonicalMapLayout = async (applyToCanvas: boolean): Promise<boolean> => {
    const endpoints = Array.from(
      new Set([`${SERVICE_BASE_URL}/map-layout`, "/api/map-layout", "/map-layout", "http://127.0.0.1:8000/map-layout"])
    );
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) continue;
        const payload = await res.json();
        if (!isCanonicalMapLayout(payload)) continue;
        setCanonicalMapLayout(payload);
        if (applyToCanvas || (!loadedDraftFilename && activeDraftKey === "main-layout-svg-current")) {
          setEditorBaseMapLayout(cloneCanonicalMapLayout(payload));
        }
        if (applyToCanvas) {
          const nextLayouts = mapLayoutToLayoutsByFloor(payload);
          const nextVisibleFloors = deriveVisibleFloorsFromLayouts(nextLayouts);
          applyLayoutChange(() => nextLayouts, { recordHistory: false });
          setVisibleFloors(nextVisibleFloors);
          setActiveFloor((prev) => (nextVisibleFloors.includes(prev) ? prev : nextVisibleFloors[0]));
          applyLoadedMapView();
          undoStackRef.current = [];
          setUndoCount(0);
        }
        return true;
      } catch {
        // Try next endpoint.
      }
    }
    return false;
  };

  const currentLayout =
    layoutsByFloor[activeFloor] ??
    layoutsByFloor[sortedFloorNumbersFromLayouts(layoutsByFloor)[0] ?? 1] ??
    createEmptyLayoutsFromCanonical(editorBaseMapLayout)[1];
  const metersPerCell = currentLayout.metersPerCell ?? DEFAULT_METERS_PER_CELL;
  const pxToM = (px: number) => fmtMeters((px / GRID_SIZE) * metersPerCell);
  const fileMainHistoryOptions = useMemo<DraftOption[]>(() => {
    return mapHistoryFiles
      .map((item) => {
        const data = item.payload;
        const filename = item.filename;
        const createdAtFromMtime =
          Number.isFinite(item.mtimeMs) && item.mtimeMs > 0 ? new Date(item.mtimeMs).toISOString() : undefined;
        const resolvedCreatedAt = data.createdAt ?? createdAtFromMtime;
        const converted = mapLayoutToLayoutsByFloor(data);
        const payload = buildSvgDraftFromLayouts(converted, {
          createdAt: resolvedCreatedAt,
          note: data.note ?? "Map layout history snapshot",
          source: "map-layout-history-file",
          baseMapLayout: data,
        });
        const floorCount = payload.floors ? Object.keys(payload.floors).length : 0;
        const createdAtLabel = formatDateForMainSvgLabel(payload.createdAt);
        const filenameLabel = formatMainSvgDateFromFilename(filename);
        const finalLabel = createdAtLabel === "Unknown" && filenameLabel ? filenameLabel : createdAtLabel;
        const overrideName =
          typeof mapHistoryNameOverrides[filename] === "string" && mapHistoryNameOverrides[filename].trim()
            ? normalizeMainLayoutLabel(mapHistoryNameOverrides[filename].trim())
            : null;
        return {
          key: buildMapHistoryOptionKey(filename),
          sourceLabel: "",
          filename,
          draftId: overrideName ?? `Main Layout - ${finalLabel}`,
          createdAt: payload.createdAt ?? "unknown",
          note: payload.note ?? "",
          floorCount,
          payload,
        };
      })
      .sort((a, b) => {
        const aMs = Date.parse(a.createdAt);
        const bMs = Date.parse(b.createdAt);
        if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs;
        return b.filename.localeCompare(a.filename);
      });
  }, [mapHistoryFiles, mapHistoryNameOverrides]);

  const fileDraftOptions = useMemo<DraftOption[]>(() => {
    return draftFiles
      .map((item) => {
        const data = item.payload;
        const floorCount = data.floors ? Object.keys(data.floors).length : 0;
        const resolvedDraftLabel =
          typeof data.draftId === "string" && data.draftId.trim()
            ? data.draftId.trim()
            : formatDraftSvgLabel(data.createdAt);
        return {
          key: buildDraftOptionKey(item.filename),
          sourceLabel: "",
          filename: item.filename,
          draftId: resolvedDraftLabel,
          createdAt: data.createdAt ?? "unknown",
          note: data.note ?? "",
          floorCount,
          payload: data,
          isDraftFile: true,
        };
      })
      .sort((a, b) => b.filename.localeCompare(a.filename));
  }, [draftFiles]);

  const mainAndHistoryOptions = useMemo<DraftOption[]>(() => {
    const mainPayload = buildSvgDraftFromLayouts(mapLayoutToLayoutsByFloor(canonicalMapLayout), {
      source: "map-layout-current-file",
      note: "Current map_layout.json",
      baseMapLayout: canonicalMapLayout,
    });
    const mainOption: DraftOption = {
      key: "main-layout-svg-current",
      sourceLabel: "Current Main Layout",
      filename: "map_layout.json",
      draftId: "Main Layout - Current",
      createdAt: "current",
      note: "Generated from map_layout.json",
      floorCount: mainPayload.floors ? Object.keys(mainPayload.floors).length : 0,
      payload: JSON.parse(JSON.stringify(mainPayload)) as MainLayoutSvgDraft,
    };
    return [mainOption, ...fileMainHistoryOptions];
  }, [fileMainHistoryOptions, canonicalMapLayout]);

  const draftUnpublishedOptions = useMemo<DraftOption[]>(() => {
    return [...fileDraftOptions];
  }, [fileDraftOptions]);

  const availableDrafts = svgListTab === "main" ? mainAndHistoryOptions : draftUnpublishedOptions;
  const allDraftOptions = useMemo<DraftOption[]>(() => {
    return [...mainAndHistoryOptions, ...draftUnpublishedOptions];
  }, [mainAndHistoryOptions, draftUnpublishedOptions]);
  const currentLoadedDraftOption = useMemo(() => {
    const byActiveKey = allDraftOptions.find((item) => item.key === activeDraftKey) ?? null;
    const byLoadedFilename =
      loadedDraftFilename && loadedDraftFilename.trim()
        ? allDraftOptions.find((item) => item.filename === loadedDraftFilename.trim()) ?? null
        : null;
    return byLoadedFilename ?? byActiveKey;
  }, [loadedDraftFilename, allDraftOptions, activeDraftKey]);
  const currentLoadedMapMeta = useMemo(() => {
    const resolved = currentLoadedDraftOption;
    const displayName =
      resolved?.draftId && resolved.draftId.trim()
        ? resolved.draftId.trim()
        : loadedDraftFilename
        ? "Draft Map"
        : "Main Layout - Current";
    const filename =
      loadedDraftFilename && loadedDraftFilename.trim()
        ? loadedDraftFilename.trim()
        : resolved?.filename && resolved.filename.trim()
        ? resolved.filename.trim()
        : "map_layout.json";
    return { displayName, filename };
  }, [loadedDraftFilename, currentLoadedDraftOption]);
  const openMapLayoutsModal = useCallback(() => {
    setSvgListTab(currentLoadedDraftOption?.isDraftFile ? "drafts" : "main");
    setShowDraftsPopup(true);
  }, [currentLoadedDraftOption]);

  const refreshDraftFiles = async () => {
    const json = await fetchJsonFromEndpoints<{ ok?: boolean; items?: DraftFileItem[] }>([
      `${SERVICE_BASE_URL}/draft-maps`,
      "/api/draft-maps",
      "/draft-maps",
      "http://127.0.0.1:8000/draft-maps",
    ]);
    if (!json?.ok || !Array.isArray(json.items)) return;
    setDraftFiles(json.items);
  };

  const refreshMapHistoryFiles = async () => {
    const json = await fetchJsonFromEndpoints<{ ok?: boolean; items?: MapHistoryFileItem[] }>([
      `${SERVICE_BASE_URL}/map-layout-history`,
      "/api/map-layout-history",
      "/map-layout-history",
      "http://127.0.0.1:8000/map-layout-history",
    ]);
    if (!json?.ok || !Array.isArray(json.items)) return;
    setMapHistoryFiles(json.items);
  };

  useEffect(() => {
    void refreshDraftFiles();
    void refreshMapHistoryFiles();
    // Keep UI backup as the initial rendered source of truth.
    // Service refresh updates canonical metadata but won't overwrite the canvas on load.
    void refreshCanonicalMapLayout(false);
  }, []);

  useEffect(() => {
    const syncAuthAutoload = () => {
      void autoLoadMainMapCurrentOnLogin();
    };
    syncAuthAutoload();
    window.addEventListener(AUTH_CHANGED_EVENT, syncAuthAutoload);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, syncAuthAutoload);
  }, [autoLoadMainMapCurrentOnLogin]);

  useEffect(() => {
    if (!showDraftsPopup) return;
    void refreshDraftFiles();
    void refreshMapHistoryFiles();
  }, [showDraftsPopup]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem(MAP_HISTORY_NAME_OVERRIDES_KEY, JSON.stringify(mapHistoryNameOverrides));
  }, [mapHistoryNameOverrides]);

  const loadDraftSvg = async (draft: DraftOption) => {
    setLoadingDraftKey(draft.key);
    setIsBackgroundMapLoading(true);
    const floors = draft.payload.floors;
    if (!floors) {
      setStatusMessage(`Draft ${draft.draftId} has no floors to load.`);
      setLoadingDraftKey(null);
      window.setTimeout(() => setIsBackgroundMapLoading(false), 250);
      return;
    }
    const loadedFloors: BuilderFloor[] = [];
    const nextCanonicalMapLayout = isCanonicalMapLayout(draft.payload.baseMapLayout)
      ? cloneCanonicalMapLayout(draft.payload.baseMapLayout)
      : cloneCanonicalMapLayout(canonicalMapLayout);
    const nextLayouts = createEmptyLayoutsFromCanonical(nextCanonicalMapLayout);
    Object.entries(floors).forEach(([floorKey, floorPayload]) => {
      const floorNum = Number(floorKey);
      const floorSvg = floorPayload?.svg;
      if (!Number.isFinite(floorNum) || floorNum <= 0 || !floorSvg || !floorSvg.trim()) return;
      loadedFloors.push(floorNum);
      nextLayouts[floorNum] = materializeHorizontalAutoHallways(parseLayoutFromSvg(floorSvg, floorNum), floorNum);
    });
    loadedFloors.sort((a, b) => a - b);
    if (!loadedFloors.length) {
      setStatusMessage(`Draft ${draft.draftId} has no valid floor SVG entries.`);
      setLoadingDraftKey(null);
      window.setTimeout(() => setIsBackgroundMapLoading(false), 250);
      return;
    }

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 280));
      setEditorBaseMapLayout(nextCanonicalMapLayout);
      applyLayoutChange(() => normalizeLayoutsToGrid(nextLayouts), { recordHistory: false });
      setVisibleFloors(loadedFloors);
      setActiveFloor((prev) => (loadedFloors.includes(prev) ? prev : loadedFloors[0]));
      applyLoadedMapView();
      setActiveDraftKey(draft.key);
      setLoadedDraftFilename(draft.isDraftFile ? draft.filename : null);
      setSelection(null);
      setSelectedIds([]);
      undoStackRef.current = [];
      setUndoCount(0);
      setShowDraftsPopup(false);
      setStatusMessage(
        `Loaded SVG draft: ${draft.draftId} (${loadedFloors.length} floor${loadedFloors.length === 1 ? "" : "s"}).`
      );
    } finally {
      setLoadingDraftKey(null);
      window.setTimeout(() => setIsBackgroundMapLoading(false), 350);
    }
  };

  const deleteDraftSvg = async (draft: DraftOption) => {
    if (!draft.isDraftFile) return;
    try {
      const res = await fetch(`${SERVICE_BASE_URL}/draft-maps/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: draft.filename }),
      });
      const payload = (await res.json()) as { ok?: boolean; deleted?: boolean };
      if (!res.ok || !payload?.ok) {
        throw new Error("delete failed");
      }
      await refreshDraftFiles();
      if (loadedDraftFilename === draft.filename) {
        resetToMainMapCurrent(canonicalMapLayout);
        setSvgListTab("main");
        setStatusMessage("Loaded draft was deleted. Switched to Main Layout - Current.");
        showToast("Loaded draft deleted. Main Layout - Current loaded.", "info");
      } else {
        setStatusMessage(`Deleted draft: ${draft.filename}`);
        showToast(`Draft deleted: ${draft.filename}`, "danger");
      }
    } catch {
      setStatusMessage(`Failed to delete draft: ${draft.filename}`);
      showToast(`Failed to delete: ${draft.filename}`, "danger");
    } finally {
      setDraftToDelete(null);
    }
  };

  const renameDraftSvg = async (draft: DraftOption, nextNameRaw: string) => {
    const input = nextNameRaw.trim();
    if (!input || input === draft.draftId) {
      setDraftToRename(null);
      setDraftRenameValue("");
      setDraftRenameError("");
      return;
    }
    const normalizedInput = input.toLowerCase();
    const isLoadedTarget = currentLoadedDraftOption?.key === draft.key;
    const duplicate = availableDrafts.some(
      (item) => item.key !== draft.key && item.draftId.trim().toLowerCase() === normalizedInput
    );
    if (duplicate) {
      const message = `Duplicate draft name not allowed: ${input}.`;
      setDraftRenameError(message);
      showToast(`Duplicate draft name: ${input}`, "danger");
      setStatusMessage(message);
      return;
    }
    if (!draft.isDraftFile) {
      setMapHistoryNameOverrides((prev) => ({ ...prev, [draft.filename]: input }));
      setDraftToRename(null);
      setDraftRenameValue("");
      setDraftRenameError("");
      showToast(`History renamed: ${input}`, isLoadedTarget ? "info" : "success");
      setStatusMessage(`History entry renamed to ${input}.`);
      return;
    }
    const sourceItem = draftFiles.find((item) => item.filename === draft.filename);
    if (!sourceItem) {
      showToast("Draft not found.", "danger");
      return;
    }
    const nextPayload: MainLayoutSvgDraft = {
      ...sourceItem.payload,
      draftId: input,
    };
    try {
      const deleteRes = await fetch(`${SERVICE_BASE_URL}/draft-maps/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: draft.filename }),
      });
      const deleteJson = (await deleteRes.json().catch(() => ({}))) as { ok?: boolean };
      if (!deleteRes.ok || !deleteJson?.ok) {
        throw new Error("delete-before-rename failed");
      }
      const saveRes = await fetch(`${SERVICE_BASE_URL}/draft-maps/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: nextPayload }),
      });
      const saveJson = (await saveRes.json().catch(() => ({}))) as { ok?: boolean; filename?: string };
      if (!saveRes.ok || !saveJson?.ok || typeof saveJson.filename !== "string") {
        throw new Error("save-after-rename failed");
      }
      await refreshDraftFiles();
      if (loadedDraftFilename === draft.filename) {
        setLoadedDraftFilename(saveJson.filename);
        setActiveDraftKey(buildDraftOptionKey(saveJson.filename));
      }
      setDraftToRename(null);
      setDraftRenameValue("");
      setDraftRenameError("");
      showToast(`Draft renamed: ${input}`, isLoadedTarget ? "info" : "success");
      setStatusMessage(`Draft renamed to ${input}.`);
    } catch {
      showToast("Failed to rename draft.", "danger");
      setStatusMessage(`Failed to rename draft: ${draft.filename}`);
    }
  };

  const renameCurrentLoadedMap = () => {
    if (!currentLoadedDraftOption) {
      showToast("No loaded map entry to rename.", "info");
      return;
    }
    if (currentLoadedDraftOption.key === "main-layout-svg-current") {
      const message = "Main Layout - Current cannot be renamed.";
      setStatusMessage(message);
      showToast(message, "info");
      return;
    }
    setDraftToRename(currentLoadedDraftOption);
    setDraftRenameValue(currentLoadedDraftOption.draftId);
    setDraftRenameError("");
  };

  const gridLines = useMemo(() => {
    const lines: { points: number[] }[] = [];
    for (let x = 0; x <= WORLD_SIZE; x += GRID_SIZE) {
      lines.push({ points: [x, 0, x, WORLD_SIZE] });
    }
    for (let y = 0; y <= WORLD_SIZE; y += GRID_SIZE) {
      lines.push({ points: [0, y, WORLD_SIZE, y] });
    }
    return lines;
  }, []);
  const autoHallwayOverlays = useMemo(
    () => deriveAutoHallwayOverlays(currentLayout, activeFloor),
    [currentLayout, activeFloor]
  );
  const visibleAutoHallwayOverlays = useMemo(() => {
    const existingIds = new Set(currentLayout.rooms.map((room) => room.id));
    return autoHallwayOverlays.filter((overlay) => !existingIds.has(overlay.id));
  }, [autoHallwayOverlays, currentLayout.rooms]);
  const autoHallwayStyle = roomStyle("hallway");
  const activeSelectionIds = useMemo(
    () => (selectedIds.length ? selectedIds : selection ? [selection] : []),
    [selectedIds, selection]
  );
  const selectedRoom = useMemo(
    () =>
      currentLayout.rooms.find((room) => room.id === selection) ??
      (selectedIds.length ? currentLayout.rooms.find((room) => room.id === selectedIds[selectedIds.length - 1]) ?? null : null),
    [currentLayout.rooms, selection, selectedIds]
  );
  const selectedRoomBounds = useMemo(() => (selectedRoom ? roomBounds(selectedRoom) : null), [selectedRoom]);
  const selectedRoomMetrics = useMemo(() => {
    if (!selectedRoom) return null;
    if (selectedRoom.rect) {
      return {
        width: selectedRoom.rect.w,
        height: selectedRoom.rect.h,
        area: selectedRoom.rect.w * selectedRoom.rect.h,
        perimeter: (selectedRoom.rect.w + selectedRoom.rect.h) * 2,
      };
    }
    if (selectedRoom.poly?.points?.length) {
      const bounds = roomBounds(selectedRoom);
      return {
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        area: polygonArea(selectedRoom.poly.points),
        perimeter: polygonPerimeter(selectedRoom.poly.points),
      };
    }
    return null;
  }, [selectedRoom]);
  const selectedRoomAreaSqMeters = useMemo(() => {
    if (!selectedRoomMetrics) return 0;
    const metersPerPx = metersPerCell / GRID_SIZE;
    return selectedRoomMetrics.area * metersPerPx * metersPerPx;
  }, [metersPerCell, selectedRoomMetrics]);
  const selectedPolygonVertex = useMemo(() => {
    if (!selectedRoom?.poly?.points?.length || selectedPolygonVertexIndex === null) return null;
    return selectedRoom.poly.points[selectedPolygonVertexIndex] ?? null;
  }, [selectedPolygonVertexIndex, selectedRoom]);
  const selectedPolygonVertexEdgeLengths = useMemo(() => {
    if (!selectedRoom?.poly?.points?.length || selectedPolygonVertexIndex === null) return null;
    const points = selectedRoom.poly.points;
    const prevIndex = (selectedPolygonVertexIndex - 1 + points.length) % points.length;
    return {
      incoming: polygonEdgeLength(points, prevIndex),
      outgoing: polygonEdgeLength(points, selectedPolygonVertexIndex),
    };
  }, [selectedPolygonVertexIndex, selectedRoom]);
  const wingNameOptions = useMemo(() => {
    const options = new Set(DEFAULT_WING_NAME_OPTIONS);
    sortedFloorNumbersFromLayouts(layoutsByFloor).forEach((floorNum) => {
      layoutsByFloor[floorNum]?.rooms.forEach((room) => {
        if (room.kind !== "wing_background") return;
        options.add(displayWingName(room.wing, room.wingName));
      });
    });
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [layoutsByFloor]);
  const selectedRoomStyle = useMemo(
    () => (selectedRoom ? roomStyle(selectedRoom.kind, selectedRoom.wing, selectedRoom.fill) : null),
    [selectedRoom]
  );
  const selectedRoomColorPresetValue =
    selectedRoom?.kind === "room" &&
    ROOM_COLOR_OPTIONS.some((option) => option.value === selectedRoomStyle?.fill)
      ? (selectedRoomStyle?.fill ?? "")
      : "";
  const selectedRooms = useMemo(
    () => currentLayout.rooms.filter((room) => activeSelectionIds.includes(room.id)),
    [currentLayout.rooms, activeSelectionIds]
  );
  const getRoomsForIds = useCallback(
    (ids: string[]) => {
      if (!ids.length) return [];
      const roomMap = new Map(currentLayout.rooms.map((room) => [room.id, room] as const));
      return ids
        .map((id) => roomMap.get(id))
        .filter((room): room is LayoutRoom => Boolean(room));
    },
    [currentLayout.rooms]
  );
  const copyRoomsToClipboard = useCallback((rooms: LayoutRoom[]) => {
    copiedRoomsRef.current = rooms.map((room) => shiftRoomBy(room, 0, 0));
    setCopiedRoomCount(rooms.length);
  }, []);
  const copySelectedElements = useCallback(() => {
    if (isUiBlocked) return;
    const rooms = getRoomsForIds(activeSelectionIds);
    if (!rooms.length) return;
    copyRoomsToClipboard(rooms);
    showToast(
      rooms.length === 1
        ? `Copied ${rooms[0].label?.text?.trim() || rooms[0].id}.`
        : `Copied ${rooms.length} selected elements.`,
      "success"
    );
  }, [activeSelectionIds, copyRoomsToClipboard, getRoomsForIds, isUiBlocked]);
  const pasteCopiedElements = useCallback(() => {
    if (isUiBlocked || !copiedRoomsRef.current.length) return;
    const sourceRooms = copiedRoomsRef.current.map((room) => shiftRoomBy(room, 0, 0));
    const nextOffset = pickRoomGroupCopyOffset(sourceRooms, currentLayout.rooms);
    const existingIds = new Set(currentLayout.rooms.map((room) => room.id));
    const workingRooms = [...currentLayout.rooms];
    const pastedRooms = sourceRooms.map((sourceRoom) => {
      const shiftedCopy = shiftRoomBy(sourceRoom, nextOffset.dx, nextOffset.dy);
      const nextId = buildCopiedRoomId(sourceRoom.id, existingIds);
      existingIds.add(nextId);
      const nextLabelText = buildCopiedRoomLabel(sourceRoom, workingRooms);
      const nextRoom: LayoutRoom = {
        ...shiftedCopy,
        id: nextId,
        label: shiftedCopy.label
          ? { ...shiftedCopy.label, text: nextLabelText }
          : { ...roomLabelPosition(shiftedCopy), text: nextLabelText },
      };
      workingRooms.push(nextRoom);
      return nextRoom;
    });
    if (!pastedRooms.length) return;
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      next[activeFloor].rooms = [...next[activeFloor].rooms, ...pastedRooms];
      return next;
    });
    copyRoomsToClipboard(pastedRooms);
    setSelectedIds(pastedRooms.map((room) => room.id));
    setSelection(pastedRooms[pastedRooms.length - 1]?.id ?? null);
    showToast(
      pastedRooms.length === 1
        ? `Pasted ${pastedRooms[0].label?.text?.trim() || pastedRooms[0].id}.`
        : `Pasted ${pastedRooms.length} elements.`,
      "success"
    );
  }, [activeFloor, copyRoomsToClipboard, currentLayout.rooms, isUiBlocked]);

  useEffect(() => {
    const validIds = new Set(currentLayout.rooms.map((room) => room.id));
    setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
    setSelection((prev) => (prev && validIds.has(prev) ? prev : null));
  }, [currentLayout.rooms]);

  useEffect(() => {
    if (!selection) {
      if (selectedIds.length) setSelectedIds([]);
      return;
    }
    if (!selectedIds.includes(selection)) {
      setSelectedIds([selection]);
    }
  }, [selection, selectedIds]);

  useEffect(() => {
    if (!selectedRoom?.poly?.points?.length) {
      if (selectedPolygonVertexIndex !== null) setSelectedPolygonVertexIndex(null);
      if (hoveredPolygonVertexIndex !== null) setHoveredPolygonVertexIndex(null);
      return;
    }
    if (selectedPolygonVertexIndex !== null && selectedPolygonVertexIndex >= selectedRoom.poly.points.length) {
      setSelectedPolygonVertexIndex(selectedRoom.poly.points.length - 1);
    }
  }, [hoveredPolygonVertexIndex, selectedPolygonVertexIndex, selectedRoom]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const isNarrowViewport = window.innerWidth <= 900;
      const minWidth = isNarrowViewport ? 280 : 640;
      const minHeight = isNarrowViewport ? 360 : 620;
      const nextWidth = Math.max(minWidth, Math.floor(entry.contentRect.width));
      const nextHeight = Math.max(minHeight, Math.floor(window.innerHeight - 170));
      setViewport({ width: nextWidth, height: nextHeight });
    });
    if (canvasWrapRef.current) observer.observe(canvasWrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isUiBlocked) return;
      const target = e.target as HTMLElement | null;
      const typingTarget =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (typingTarget) return;
        e.preventDefault();
        undoLayoutChange();
        return;
      }
      if (typingTarget) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && activeSelectionIds.length) {
        e.preventDefault();
        copySelectedElements();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && copiedRoomsRef.current.length) {
        e.preventDefault();
        pasteCopiedElements();
        return;
      }
      if (e.key === "Escape") {
        setDraftRoom(null);
        setPolygonDraft(null);
      }
      if (e.key === "Enter" && tool === "polygon_room" && polygonDraft?.points?.length) {
        e.preventDefault();
        const nextRoom = polygonRoomFromPoints(
          activeFloor,
          "room",
          polygonDraft.points,
          makeDefaultLabel("room", currentLayout.rooms.length + 1)
        );
        if (nextRoom) {
          applyLayoutChange((prev) => {
            const next = cloneLayoutsByFloor(prev);
            next[activeFloor].rooms = [...next[activeFloor].rooms, nextRoom];
            return next;
          });
          setSelection(nextRoom.id);
          setSelectedIds([nextRoom.id]);
          setPolygonDraft(null);
          setTool("select");
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && activeSelectionIds.length) {
        const idSet = new Set(activeSelectionIds);
        applyLayoutChange((prev) => {
          const next = cloneLayoutsByFloor(prev);
          next[activeFloor].rooms = next[activeFloor].rooms.filter((room) => !idSet.has(room.id));
          return next;
        });
        clearSelectedRooms();
        return;
      }
      if (selectedRooms.length) {
        const step = selectedRooms.some((room) => room.kind === "wing_background")
          ? e.shiftKey
            ? 1
            : 5
          : e.shiftKey
            ? 10
            : GRID_SIZE;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          moveSelectedRoomsBy(activeSelectionIds, -step, 0);
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          moveSelectedRoomsBy(activeSelectionIds, step, 0);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelectedRoomsBy(activeSelectionIds, 0, -step);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelectedRoomsBy(activeSelectionIds, 0, step);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFloor, activeSelectionIds, copySelectedElements, currentLayout.rooms.length, pasteCopiedElements, polygonDraft?.points?.length, selectedRooms, tool, undoCount, isUiBlocked]);

  const selectedRoomDeleteTarget = useMemo<RoomDeleteTarget | null>(() => {
    if (!selectedRoom) return null;
    return {
      id: selectedRoom.id,
      floor: Number.isFinite(selectedRoom.floor) ? Number(selectedRoom.floor) : activeFloor,
      text: selectedRoom.label?.text?.trim() || selectedRoom.id,
    };
  }, [selectedRoom, activeFloor]);
  const canDeleteFloorFromPanel = visibleFloors.length > 1 && !isUiBlocked && !isAddingFloor;
  const canDeleteSelectedComponent = Boolean(selectedRoomDeleteTarget) && !isUiBlocked && !isAddingFloor;
  const propertiesDeleteLabel = selectedRoomDeleteTarget
    ? `Delete ${selectedRoomDeleteTarget.text}`
    : `Delete Floor ${activeFloor}`;
  const handlePropertiesDelete = () => {
    if (selectedRoomDeleteTarget) {
      if (!canDeleteSelectedComponent) return;
      setRoomToDelete(selectedRoomDeleteTarget);
      return;
    }
    if (!canDeleteFloorFromPanel) return;
    setFloorToDelete(activeFloor);
  };
  const getRoomStackingBounds = useCallback((rooms: LayoutRoom[]) => {
    let firstMovableIndex = rooms.findIndex((room) => room.kind !== "wing_background");
    if (firstMovableIndex < 0) {
      firstMovableIndex = 0;
    }
    const lastMovableIndex = rooms.length - 1;
    return { firstMovableIndex, lastMovableIndex };
  }, []);
  const roomsForRender = useMemo(() => {
    return currentLayout.rooms
      .map((room, index) => ({ room, index }))
      .sort((a, b) => {
        const priorityDelta = roomRenderPriority(a.room.kind) - roomRenderPriority(b.room.kind);
        if (priorityDelta !== 0) return priorityDelta;
        return a.index - b.index;
      })
      .map((item) => item.room);
  }, [currentLayout.rooms]);
  const selectedCorridorLayerState = useMemo(() => {
    if (!selectedRoom || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge")) {
      return { canSendToBack: false, canSendToFront: false };
    }
    const hallwayIndex = currentLayout.rooms.findIndex((room) => room.id === selectedRoom.id);
    if (hallwayIndex < 0) {
      return { canSendToBack: false, canSendToFront: false };
    }
    const { firstMovableIndex, lastMovableIndex } = getRoomStackingBounds(currentLayout.rooms);
    return {
      canSendToBack: hallwayIndex > firstMovableIndex,
      canSendToFront: hallwayIndex < lastMovableIndex,
    };
  }, [currentLayout.rooms, getRoomStackingBounds, selectedRoom]);

  useEffect(() => {
    setIdDraft(selectedRoom?.id ?? "");
    setLiveResizeDims(null);
  }, [selectedRoom?.id]);

  useEffect(() => {
    const transformer = wingBackgroundTransformerRef.current;
    if (!transformer) return;
    const shouldAttach =
      Boolean(selectedRoom?.rect) &&
      Boolean(selectedWingBackgroundNodeRef.current);
    transformer.nodes(shouldAttach ? [selectedWingBackgroundNodeRef.current] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedRoom?.id, selectedRoom?.kind, selectedRoom?.rect?.x, selectedRoom?.rect?.y, selectedRoom?.rect?.w, selectedRoom?.rect?.h]);

  useEffect(() => {
    if (selectedRoom?.rect) {
      setRectDraft({
        x: String(selectedRoom.rect.x),
        y: String(selectedRoom.rect.y),
        w: String(selectedRoom.rect.w),
        h: String(selectedRoom.rect.h),
      });
      return;
    }
    if (selectedRoomBounds) {
      setRectDraft({
        x: String(selectedRoomBounds.x),
        y: String(selectedRoomBounds.y),
        w: String(Math.round(selectedRoomBounds.width)),
        h: String(Math.round(selectedRoomBounds.height)),
      });
      return;
    }
    setRectDraft({ x: "", y: "", w: "", h: "" });
  }, [selectedRoom?.id, selectedRoom?.rect?.x, selectedRoom?.rect?.y, selectedRoom?.rect?.w, selectedRoom?.rect?.h, selectedRoomBounds?.x, selectedRoomBounds?.y, selectedRoomBounds?.width, selectedRoomBounds?.height]);

  const updateSelectedRoomLabel = (nextText: string) => {
    if (!selectedRoom) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      const nextLabel = prevRoom.label
        ? { ...prevRoom.label, text: nextText }
        : { ...roomLabelPosition(prevRoom), text: nextText };
      return { ...prevRoom, label: nextLabel };
    });
  };

  const updateSelectedRoomKind = (nextKind: LayoutRoomKind) => {
    if (!selectedRoom) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (nextKind === "wing_background") {
        const wing = prevRoom.wing ?? parseWingIdFromName(prevRoom.wingName) ?? "A";
        const wingName = normalizeWingName(prevRoom.wingName) ?? displayWingName(wing);
        return {
          ...prevRoom,
          kind: nextKind,
          wing,
          wingName,
          fill: undefined,
          rect: prevRoom.rect ? { ...prevRoom.rect, r: 10 } : prevRoom.rect,
          label: {
            ...(prevRoom.label ?? roomLabelPosition(prevRoom)),
            text: wingBackgroundLabel(wing, wingName),
          },
        };
      }
      return {
        ...prevRoom,
        kind: nextKind,
        wing: undefined,
        wingName: undefined,
        fill: nextKind === "room" ? prevRoom.fill : undefined,
      };
    });
  };

  const updateSelectedRoomFill = (nextFill: string) => {
    if (!selectedRoom || selectedRoom.kind !== "room") return;
    const normalized = normalizeHexColor(nextFill);
    if (!normalized) return;
    updateRoom(selectedRoom.id, (prevRoom) => ({
      ...prevRoom,
      fill: normalized,
    }));
  };

  const clearSelectedRoomFill = () => {
    if (!selectedRoom || selectedRoom.kind !== "room") return;
    updateRoom(selectedRoom.id, (prevRoom) => ({
      ...prevRoom,
      fill: undefined,
    }));
  };

  const updateSelectedWingBackgroundName = (nextWingNameRaw: string, options?: { commitEmpty?: boolean }) => {
    if (!selectedRoom || selectedRoom.kind !== "wing_background") return;
    const normalizedWingName = normalizeWingName(nextWingNameRaw);
    updateRoom(selectedRoom.id, (prevRoom) => {
      const nextWing = parseWingIdFromName(nextWingNameRaw) ?? prevRoom.wing ?? "A";
      const nextWingName = normalizedWingName ?? (options?.commitEmpty ? displayWingName(nextWing) : nextWingNameRaw);
      return {
        ...prevRoom,
        wing: nextWing,
        wingName: nextWingName,
        label: {
          ...(prevRoom.label ?? roomLabelPosition(prevRoom)),
          text: wingBackgroundLabel(nextWing, normalizedWingName ?? displayWingName(nextWing)),
        },
      };
    });
  };

  const rotateSelectedCorridor = () => {
    if (!selectedRoom || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge") || !selectedRoom.rect) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if ((prevRoom.kind !== "hallway" && prevRoom.kind !== "bridge") || !prevRoom.rect) return prevRoom;
      const centerX = prevRoom.rect.x + prevRoom.rect.w / 2;
      const centerY = prevRoom.rect.y + prevRoom.rect.h / 2;
      const nextW = prevRoom.rect.h;
      const nextH = prevRoom.rect.w;
      const nextRect = {
        ...prevRoom.rect,
        x: centerX - nextW / 2,
        y: centerY - nextH / 2,
        w: nextW,
        h: nextH,
      };
      const nextLabelPosition = roomLabelPosition({ ...prevRoom, rect: nextRect });
      return {
        ...prevRoom,
        rect: nextRect,
        label: {
          x: nextLabelPosition.x,
          y: nextLabelPosition.y,
          text: prevRoom.label?.text ?? prevRoom.id,
        },
      };
    });
  };

  const rotateSelectedRoom = () => {
    if (!selectedRoom || (selectedRoom.kind !== "room" && selectedRoom.kind !== "lounge" && selectedRoom.kind !== "stairs")) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (prevRoom.kind !== "room" && prevRoom.kind !== "lounge" && prevRoom.kind !== "stairs") return prevRoom;
      if (prevRoom.rect) {
        const newRotation = ((prevRoom.rect.rotation ?? 0) + 90) % 360;
        return { ...prevRoom, rect: { ...prevRoom.rect, rotation: newRotation } };
      }
      if (prevRoom.poly) {
        const points = prevRoom.poly.points;
        const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const nextPoints = points.map((p) => ({ x: cx + (p.y - cy), y: cy - (p.x - cx) }));
        const nextPoly = { points: nextPoints };
        const nextLabelPosition = roomLabelPosition({ ...prevRoom, poly: nextPoly });
        return {
          ...prevRoom,
          poly: nextPoly,
          label: prevRoom.label ? { ...nextLabelPosition, text: prevRoom.label.text } : prevRoom.label,
        };
      }
      return prevRoom;
    });
  };

  const duplicateSelectedRoom = () => {
    if (isUiBlocked || !activeSelectionIds.length) return;
    copySelectedElements();
  };

  const commitSelectedRoomId = (rawValue: string) => {
    if (!selectedRoom) return;
    const nextId = rawValue.trim();
    if (!nextId || nextId === selectedRoom.id) return;
    const duplicate = currentLayout.rooms.some((room) => room.id === nextId && room.id !== selectedRoom.id);
    if (duplicate) {
      showToast(`Room ID already exists: ${nextId}`, "danger");
      setIdDraft(selectedRoom.id);
      return;
    }
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      next[activeFloor].rooms = next[activeFloor].rooms.map((room) =>
        room.id === selectedRoom.id ? { ...room, id: nextId } : room
      );
      return next;
    });
    setSelection(nextId);
    setIdDraft(nextId);
  };

  const commitSelectedRoomRect = (
    key: "x" | "y" | "w" | "h",
    rawValue: string
  ) => {
    if (!selectedRoom || !selectedRoom.rect) return;
    if (rawValue.trim() === "") return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.rect) return prevRoom;
      const nextRect = { ...prevRoom.rect };
      if (key === "x" || key === "y") {
        nextRect[key] = numeric;
      } else {
        nextRect[key] = Math.max(10, numeric);
      }
      const nextLabelPosition = roomLabelPosition({ ...prevRoom, rect: nextRect });
      return {
        ...prevRoom,
        rect: nextRect,
        label: {
          x: nextLabelPosition.x,
          y: nextLabelPosition.y,
          text: prevRoom.label?.text ?? prevRoom.id,
        },
      };
    });
  };

  const commitSelectedRoomPolyBounds = (key: "x" | "y" | "w" | "h", rawValue: string) => {
    if (!selectedRoom?.poly || !selectedRoomBounds) return;
    if (rawValue.trim() === "") return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.poly) return prevRoom;
      if (key === "x") return scalePolygonToBounds(prevRoom, { x: numeric });
      if (key === "y") return scalePolygonToBounds(prevRoom, { y: numeric });
      if (key === "w") return scalePolygonToBounds(prevRoom, { width: Math.max(10, numeric) });
      return scalePolygonToBounds(prevRoom, { height: Math.max(10, numeric) });
    });
  };

  const commitSelectedPolygonPoint = (pointIndex: number, axis: "x" | "y", rawValue: string) => {
    if (!selectedRoom?.poly?.points?.[pointIndex]) return;
    if (rawValue.trim() === "") return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.poly?.points?.[pointIndex]) return prevRoom;
      const point = prevRoom.poly.points[pointIndex];
      return replaceRoomPolygonPoint(prevRoom, pointIndex, { ...point, [axis]: numeric });
    });
  };

  const addSelectedPolygonVertex = () => {
    if (!selectedRoom?.poly?.points?.length) return;
    const anchorIndex = selectedPolygonVertexIndex ?? (selectedRoom.poly.points.length - 1);
    updateRoom(selectedRoom.id, (prevRoom) => {
      return insertRoomPolygonPoint(prevRoom, anchorIndex);
    });
    setSelectedPolygonVertexIndex(anchorIndex + 1);
  };

  const removeSelectedPolygonVertex = () => {
    if (!selectedRoom?.poly || selectedRoom.poly.points.length <= 3) return;
    const pointIndex = selectedPolygonVertexIndex ?? (selectedRoom.poly.points.length - 1);
    updateRoom(selectedRoom.id, (prevRoom) => {
      return removeRoomPolygonPoint(prevRoom, pointIndex);
    });
    setSelectedPolygonVertexIndex((prev) => {
      if (prev === null) return null;
      return Math.max(0, Math.min(prev - 1, selectedRoom.poly!.points.length - 2));
    });
  };

  const clearSelectedRooms = () => {
    setSelection(null);
    setSelectedIds([]);
  };

  const handleRoomSelection = (id: string, additive = false) => {
    if (!additive) {
      setSelection(id);
      setSelectedIds([id]);
      return;
    }
    if (selectedIds.includes(id)) {
      const nextIds = selectedIds.filter((selectedId) => selectedId !== id);
      setSelectedIds(nextIds);
      setSelection((prev) => {
        if (!nextIds.length) return null;
        if (prev && nextIds.includes(prev)) return prev;
        return nextIds[nextIds.length - 1] ?? null;
      });
      return;
    }
    setSelectedIds([...selectedIds, id]);
    setSelection(id);
  };

  const updateRooms = (ids: string[], updater: (room: LayoutRoom) => LayoutRoom) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      next[activeFloor].rooms = next[activeFloor].rooms.map((room) => (idSet.has(room.id) ? updater(room) : room));
      return next;
    });
  };

  const moveSelectedRoomsBy = (ids: string[], dx: number, dy: number) => {
    if (!ids.length) return;
    updateRooms(ids, (prevRoom) => {
      if (prevRoom.rect) {
        return {
          ...prevRoom,
          rect: {
            ...prevRoom.rect,
            x: prevRoom.rect.x + dx,
            y: prevRoom.rect.y + dy,
          },
          label: prevRoom.label
            ? {
                ...prevRoom.label,
                x: prevRoom.label.x + dx,
                y: prevRoom.label.y + dy,
              }
            : prevRoom.label,
        };
      }
      if (prevRoom.poly) {
        return {
          ...prevRoom,
          poly: {
            points: prevRoom.poly.points.map((point) => ({
              x: point.x + dx,
              y: point.y + dy,
            })),
          },
          label: prevRoom.label
            ? {
                ...prevRoom.label,
                x: prevRoom.label.x + dx,
                y: prevRoom.label.y + dy,
              }
            : prevRoom.label,
        };
      }
      return prevRoom;
    });
  };

  const updateRoom = (id: string, updater: (room: LayoutRoom) => LayoutRoom) => {
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      next[activeFloor].rooms = next[activeFloor].rooms.map((room) =>
        room.id === id ? updater(room) : room
      );
      return next;
    });
  };

  const moveSelectedCorridorLayer = useCallback(
    (direction: "back" | "front") => {
      if (!selectedRoom || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge")) return;
      applyLayoutChange((prev) => {
        const next = cloneLayoutsByFloor(prev);
        const rooms = [...next[activeFloor].rooms];
        const sourceIndex = rooms.findIndex((room) => room.id === selectedRoom.id);
        if (sourceIndex < 0) return prev;
        const { firstMovableIndex, lastMovableIndex } = getRoomStackingBounds(rooms);
        if (firstMovableIndex > lastMovableIndex) return prev;
        const targetIndex = direction === "back" ? firstMovableIndex : lastMovableIndex;
        if (sourceIndex === targetIndex) return prev;
        const [room] = rooms.splice(sourceIndex, 1);
        rooms.splice(targetIndex, 0, room);
        next[activeFloor].rooms = rooms;
        return next;
      });
    },
    [activeFloor, getRoomStackingBounds, selectedRoom]
  );

  const selectAutoHallwayOverlay = (overlay: AutoHallwayOverlay) => {
    if (tool !== "select" || isUiBlocked) return;
    const existing = currentLayout.rooms.find((room) => room.id === overlay.id);
    if (existing) {
      setSelection(existing.id);
      return;
    }
    const hallwayRoom = autoHallwayOverlayToRoom(activeFloor, overlay);
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      const alreadyExists = next[activeFloor].rooms.some((room) => room.id === hallwayRoom.id);
      if (!alreadyExists) {
        next[activeFloor].rooms = [...next[activeFloor].rooms, hallwayRoom];
      }
      return next;
    });
    setSelection(hallwayRoom.id);
  };

  const onWheel = (evt: any) => {
    evt.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition?.();
    if (!pointer) return;
    const oldScale = view.scale;
    const direction = evt.evt.deltaY > 0 ? -1 : 1;
    const nextScale = clamp(oldScale * (direction > 0 ? 1.08 : 0.92), 0.25, 3);
    const mousePointTo = {
      x: (pointer.x - view.x) / oldScale,
      y: (pointer.y - view.y) / oldScale,
    };
    setView({
      scale: nextScale,
      x: pointer.x - mousePointTo.x * nextScale,
      y: pointer.y - mousePointTo.y * nextScale,
    });
  };

  const onStageMouseDown = (evt: any) => {
    const stage = stageRef.current;
    const world = pointerToWorld(stage, view);
    const screenPointer = stage?.getPointerPosition?.();
    if (!world || !screenPointer) return;

    const mouseButton = typeof evt.evt?.button === "number" ? evt.evt.button : 0;
    const gesturePan = mouseButton === 1 || mouseButton === 2 || Boolean(evt.evt?.ctrlKey);
    const clickedBackground = evt.target === stage || evt.target?.name?.() === "canvas-hit";

    if (gesturePan || (tool === "pan" && clickedBackground)) {
      setIsPanning(true);
      setLastPanPointer({ x: screenPointer.x, y: screenPointer.y });
      return;
    }

    if (!clickedBackground) return;

    if (tool === "select") {
      setSelection(null);
      return;
    }
    if (mouseButton !== 0) return;

    if (tool === "polygon_room") {
      const snapped = snapPoint(world);
      setPolygonDraft((prev) => (prev ? { points: [...prev.points, snapped], hover: snapped } : { points: [snapped], hover: snapped }));
      return;
    }

    const snapped = snapPoint(world);
    setDraftRoom({ start: snapped, end: snapped });
  };

  const onStageMouseMove = () => {
    const stage = stageRef.current;
    const screenPointer = stage?.getPointerPosition?.();
    const world = pointerToWorld(stage, view);
    if (!screenPointer || !world) return;

    if (isPanning && lastPanPointer) {
      const dx = screenPointer.x - lastPanPointer.x;
      const dy = screenPointer.y - lastPanPointer.y;
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      setLastPanPointer({ x: screenPointer.x, y: screenPointer.y });
      return;
    }

    if (draftRoom) {
      setDraftRoom((prev) => (prev ? { ...prev, end: snapPoint(world) } : prev));
      return;
    }

    if (tool === "polygon_room" && polygonDraft) {
      setPolygonDraft((prev) => (prev ? { ...prev, hover: snapPoint(world) } : prev));
    }
  };

  const onStageMouseUp = () => {
    if (isPanning) {
      setIsPanning(false);
      setLastPanPointer(null);
      return;
    }

    if (tool === "polygon_room") return;
    if (!draftRoom) return;

    const kind = toLayoutKind(tool);
    const nextRoom = roomFromDraft(
      activeFloor,
      kind,
      draftRoom.start,
      draftRoom.end,
      makeDefaultLabel(kind, currentLayout.rooms.length + 1)
    );
    if (nextRoom) {
      applyLayoutChange((prev) => {
        const next = cloneLayoutsByFloor(prev);
        next[activeFloor].rooms = [...next[activeFloor].rooms, nextRoom];
        return next;
      });
      setSelection(nextRoom.id);
    }
    setDraftRoom(null);
  };

  const downloadText = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportLayoutJson = () => {
    const byActiveKey = allDraftOptions.find((item) => item.key === activeDraftKey) ?? null;
    const byLoadedFilename =
      loadedDraftFilename && loadedDraftFilename.trim()
        ? allDraftOptions.find((item) => item.filename === loadedDraftFilename.trim()) ?? null
        : null;
    const resolved = byLoadedFilename ?? byActiveKey;
    const filename =
      loadedDraftFilename && loadedDraftFilename.trim()
        ? loadedDraftFilename.trim()
        : resolved?.filename && resolved.filename.trim()
        ? resolved.filename.trim()
        : "map_layout.json";

    const exportDraftFormat = Boolean(resolved?.isDraftFile || (loadedDraftFilename && loadedDraftFilename.trim()));

    if (exportDraftFormat) {
      const draftPayload = buildSvgDraftFromLayouts(layoutsByFloor, {
        draftId:
          resolved?.draftId && resolved.draftId.trim()
            ? resolved.draftId.trim()
            : `draft-${new Date().toISOString()}`,
        createdAt: new Date().toISOString(),
        source: "layout-builder-export",
        note: "Exported from layout builder",
        baseMapLayout: editorBaseMapLayout,
      });
      downloadText(filename, JSON.stringify(draftPayload, null, 2), "application/json");
      showToast(`Exported ${filename}`, "success");
      return;
    }

    const mapPayload = buildMainLayoutJsonFromLayouts(layoutsByFloor, editorBaseMapLayout);
    downloadText(filename, JSON.stringify(mapPayload, null, 2), "application/json");
    showToast(`Exported ${filename}`, "success");
  };

  const resetCurrentFloor = () => {
    const canonicalLayouts = mapLayoutToLayoutsByFloor(editorBaseMapLayout);
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      const fallbackFloor = sortedFloorNumbersFromLayouts(next).at(-1) ?? 3;
      const source = canonicalLayouts[activeFloor] ?? canonicalLayouts[fallbackFloor] ?? canonicalLayouts[3];
      next[activeFloor] = relabelLayoutFloor(source, activeFloor);
      return next;
    });
    setSelection(null);
    setStatusMessage(`Floor ${activeFloor} reset from canonical defaults.`);
  };

  const resetAllFloors = () => {
    applyLayoutChange(() => mapLayoutToLayoutsByFloor(editorBaseMapLayout));
    setSelection(null);
    setStatusMessage("All floors reset from canonical defaults.");
  };

  const triggerImport = () => fileInputRef.current?.click();

  const nudgeMapHorizontally = (deltaX: number) => {
    setView((prev) => ({ ...prev, x: prev.x + deltaX }));
  };

  const nudgeMapVertically = (deltaY: number) => {
    setView((prev) => ({ ...prev, y: prev.y + deltaY }));
  };

  const saveMainLayoutJsonBackupToUi = async (payload: CanonicalMapLayout): Promise<boolean> => {
    try {
      const res = await fetchWithTimeout(
        "/api/ui-main-layout/save",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        UI_BACKUP_TIMEOUT_MS
      );
      const data = await res.json().catch(() => ({}));
      return Boolean(res.ok && data?.ok);
    } catch {
      return false;
    }
  };

  const saveLayout = async (
    sourceLayouts?: LayoutsByFloor,
    options?: { showBlockingModal?: boolean }
  ) => {
    if (isUiBlocked) return;
    const showBlockingModal = options?.showBlockingModal ?? true;
    if (showBlockingModal) {
      setBlockingAction("save");
    }
    const resolvedLayouts = sourceLayouts && typeof sourceLayouts === "object" ? sourceLayouts : layoutsByFloor;
    const createdAt = new Date().toISOString();
    const replacingFilename = loadedDraftFilename?.trim() ? loadedDraftFilename.trim() : null;
    const loadedDraftLabel = replacingFilename
      ? ((currentLoadedDraftOption?.isDraftFile && currentLoadedDraftOption.filename === replacingFilename
          ? currentLoadedDraftOption.draftId
          : undefined) ??
          draftFiles.find((item) => item.filename === replacingFilename)?.payload?.draftId)
      : undefined;
    const retainedDraftId =
      typeof loadedDraftLabel === "string" && loadedDraftLabel.trim() ? loadedDraftLabel.trim() : `saved-${createdAt}`;
    const draft = buildSvgDraftFromLayouts(resolvedLayouts, {
      draftId: retainedDraftId,
      createdAt,
      source: "layout-config-save",
      note: "Saved from layout builder",
      baseMapLayout: editorBaseMapLayout,
    });
    try {
      if (replacingFilename) {
        const deleteRes = await fetch(`${SERVICE_BASE_URL}/draft-maps/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: replacingFilename }),
        });
        const deletePayload = await deleteRes.json().catch(() => ({} as { ok?: boolean }));
        if (!deleteRes.ok || !deletePayload?.ok) {
          throw new Error("Failed to replace existing draft file.");
        }
      }
      const res = await fetch(`${SERVICE_BASE_URL}/draft-maps/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        throw new Error("Failed to save draft file.");
      }
      await refreshDraftFiles();
      if (typeof payload.filename === "string" && payload.filename.trim()) {
        setLoadedDraftFilename(payload.filename);
        setActiveDraftKey(buildDraftOptionKey(payload.filename));
      }
      const deleted = Array.isArray(payload.deleted) ? payload.deleted.length : 0;
      if (replacingFilename) {
        setStatusMessage(`Draft updated: ${payload.filename}.`);
        showToast(`Draft updated: ${payload.filename}`, "info");
      } else {
        setStatusMessage(
          deleted
            ? `Draft saved as ${payload.filename}. Oldest draft removed to keep max 10.`
            : `Draft saved as ${payload.filename}.`
        );
        showToast(`Map saved as draft: ${payload.filename}`, "info");
      }
    } catch {
      setStatusMessage("Failed to save draft file.");
      showToast("Failed to save map draft.", "danger");
    } finally {
      if (showBlockingModal) {
        setBlockingAction(null);
      }
    }
  };

  const publishLayout = async () => {
    if (isUiBlocked) return;
    setBlockingAction("publish");
    showToast("Publishing map layout...", "success");
    const nextMapLayout = buildMainLayoutJsonFromLayouts(layoutsByFloor, editorBaseMapLayout);

    try {
      const publishUrl = `${SERVICE_BASE_URL}/map-layout/publish`;
      const publishRequest: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapLayout: nextMapLayout,
          draftFilename: loadedDraftFilename,
        }),
      };
      const publishRes = await fetchWithTimeout(publishUrl, publishRequest, PUBLISH_REQUEST_TIMEOUT_MS);
      const publishPayload = await publishRes.json().catch(() => ({} as { ok?: boolean; error?: string }));
      const publishAccepted = publishRes.ok && (typeof publishPayload.ok !== "boolean" || publishPayload.ok);
      if (!publishAccepted) {
        throw new Error("publish failed");
      }

      // Immediately load the exact layout we just published.
      setCanonicalMapLayout(nextMapLayout);
      setEditorBaseMapLayout(cloneCanonicalMapLayout(nextMapLayout));
      applyLayoutChange(() => mapLayoutToLayoutsByFloor(nextMapLayout), { recordHistory: false });
      applyLoadedMapView();
      undoStackRef.current = [];
      setUndoCount(0);
      setActiveDraftKey("main-layout-svg-current");
      setLoadedDraftFilename(null);
      setSelection(null);

      localStorage.setItem(MAP_LAYOUT_REFRESH_PENDING_KEY, "1");
      setLoadedDraftFilename(null);
      setStatusMessage("Layout published successfully.");
      showToast("Map published successfully.", "success");

      void (async () => {
        const [backupSaved] = await Promise.all([
          saveMainLayoutJsonBackupToUi(nextMapLayout),
          Promise.allSettled([refreshDraftFiles(), refreshMapHistoryFiles(), refreshCanonicalMapLayout(false)]),
        ]);
        if (!backupSaved) {
          setStatusMessage("Layout published. UI backup save did not complete.");
        }
      })();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("Publish timed out. Please retry.");
        showToast("Publish timed out. Please retry.", "danger");
      } else {
        setStatusMessage("Failed to publish layout file.");
        showToast("Failed to publish map.", "danger");
      }
    } finally {
      setBlockingAction(null);
    }
  };

  const onImportLayout = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as Layout;
      if (!parsed || parsed.version !== 1 || parsed.units !== "px" || !Array.isArray(parsed.rooms)) {
        throw new Error("Invalid layout file.");
      }
      applyLayoutChange((prev) => {
        const next = cloneLayoutsByFloor(prev);
        next[activeFloor] = relabelLayoutFloor(cloneLayout(parsed), activeFloor);
        return next;
      });
      setSelection(null);
      setStatusMessage(`Imported ${file.name} into floor ${activeFloor}.`);
    } catch {
      setStatusMessage(`Failed to import ${file.name}.`);
    } finally {
      event.target.value = "";
    }
  };

  const getNextFloorPlan = (): { sourceFloor: BuilderFloor; targetFloor: BuilderFloor } => {
    const floorsAsc = [...visibleFloors].sort((a, b) => a - b);
    const sourceFloor = floorsAsc.at(-1) ?? 1;
    const targetFloor = sourceFloor + 1;
    return { sourceFloor, targetFloor };
  };

  const addFloor = (sourceFloor: BuilderFloor, targetFloor: BuilderFloor) => {
    applyLayoutChange((prev) => {
      const nextLayouts = cloneLayoutsByFloor(prev);
      const sourceLayout = nextLayouts[sourceFloor] ?? nextLayouts[3] ?? mapLayoutToLayoutsByFloor(editorBaseMapLayout)[3];
      nextLayouts[targetFloor] = relabelLayoutFloor(sourceLayout, targetFloor);
      return nextLayouts;
    });
    setVisibleFloors((prev) => (prev.includes(targetFloor) ? prev : [...prev, targetFloor].sort((a, b) => a - b)));
    setActiveFloor(targetFloor);
    setSelection(null);
    showToast(`Floor ${targetFloor} added from Floor ${sourceFloor}.`, "success");
    setStatusMessage(`Floor ${targetFloor} created by copying Floor ${sourceFloor}.`);
  };

  const openAddFloorConfirm = () => {
    if (isUiBlocked || isAddingFloor) return;
    const { sourceFloor, targetFloor } = getNextFloorPlan();
    setPendingAddFloor({ sourceFloor, targetFloor });
  };

  const confirmAddFloor = async () => {
    if (!pendingAddFloor || isAddingFloor || isUiBlocked) return;
    const { sourceFloor, targetFloor } = pendingAddFloor;
    setIsAddingFloor(true);
    setIsBackgroundMapLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 620));
      addFloor(sourceFloor, targetFloor);
      setPendingAddFloor(null);
    } finally {
      setIsAddingFloor(false);
      window.setTimeout(() => setIsBackgroundMapLoading(false), 220);
    }
  };

  const confirmDeleteFloor = () => {
    if (floorToDelete === null) return;
    if (visibleFloors.length <= 1) {
      showToast("At least one floor must remain visible.", "danger");
      setFloorToDelete(null);
      return;
    }
    const targetFloor = floorToDelete;
    const currentLayouts = cloneLayoutsByFloor(layoutsByFloor);
    const nextLayouts: LayoutsByFloor = {};
    sortedFloorNumbersFromLayouts(currentLayouts).forEach((floorNum) => {
      if (floorNum === targetFloor) return;
      const shiftedFloor = floorNum > targetFloor ? floorNum - 1 : floorNum;
      nextLayouts[shiftedFloor] = relabelLayoutFloor(currentLayouts[floorNum], shiftedFloor);
    });
    applyLayoutChange(() => nextLayouts);
    const nextVisibleFromState = visibleFloors
      .filter((floorNum) => floorNum !== targetFloor)
      .map((floorNum) => (floorNum > targetFloor ? floorNum - 1 : floorNum))
      .sort((a, b) => a - b);
    const nextVisible = nextVisibleFromState.length ? nextVisibleFromState : [1];
    setVisibleFloors(nextVisible);
    let nextActive: BuilderFloor = activeFloor;
    if (activeFloor > targetFloor) {
      nextActive = activeFloor - 1;
    } else if (activeFloor === targetFloor) {
      nextActive = targetFloor > 1 ? targetFloor - 1 : 1;
    }
    if (!nextVisible.includes(nextActive)) {
      nextActive = nextVisible[0] ?? 1;
    }
    setActiveFloor(nextActive);
    setSelection(null);
    const adjustmentMessage =
      "Other floor numbers were automatically adjusted. Empty floors are hidden from the floor buttons.";
    if (loadedDraftFilename) {
      void saveLayout(nextLayouts, { showBlockingModal: false });
      showToast(`Floor ${targetFloor} deleted and saved. ${adjustmentMessage}`, "info");
      setStatusMessage(`Floor ${targetFloor} deleted. ${adjustmentMessage}`);
    } else {
      showToast(`Floor ${targetFloor} deleted. ${adjustmentMessage}`, "info");
      setStatusMessage(`Floor ${targetFloor} deleted. ${adjustmentMessage}`);
    }
    setFloorToDelete(null);
  };

  const confirmDeleteRoom = () => {
    if (!roomToDelete) return;
    const { id: roomId, floor: roomFloor, text: roomText } = roomToDelete;
    applyLayoutChange((prev) => {
      const next = cloneLayoutsByFloor(prev);
      next[roomFloor].rooms = next[roomFloor].rooms.filter((room) => room.id !== roomId);
      return next;
    });
    if (selection === roomId) {
      setSelection(null);
    }
    showToast(`${roomText} deleted.`, "info");
    setRoomToDelete(null);
  };

  return (
    <div className="layout-config-page">
      <TopNavBar />
      <main className="layout-config-main">
        {isUiBlocked ? (
          <div className="layout-publish-blocker" role="alert" aria-live="assertive" aria-busy="true">
            <div className="layout-publish-blocker-card">
              <div className="layout-publish-spinner" aria-hidden="true" />
              <div className="layout-publish-blocker-title">
                {blockingAction === "save" ? "Saving Draft" : "Publishing Map"}
              </div>
              <div className="layout-publish-blocker-subtitle">
                {blockingAction === "save"
                  ? "Please wait while the draft is being saved."
                  : "Please wait while the publish process completes."}
              </div>
            </div>
          </div>
        ) : null}
        {toast ? (
          <div className={`layout-toast layout-toast--${toast.tone}`} role="status" aria-live="polite">
            {toast.text}
          </div>
        ) : null}
        <MDBModal open={showDraftsPopup} setOpen={setShowDraftsPopup} tabIndex="-1">
          <MDBModalDialog centered scrollable>
            <MDBModalContent className="svg-list-modal-content">
              <MDBModalHeader className="svg-list-modal-header">
                <MDBModalTitle>MAP LAYOUTS</MDBModalTitle>
                <MDBBtn
                  type="button"
                  color="none"
                  className="btn-close"
                  aria-label="Close SVG list"
                  onClick={() => setShowDraftsPopup(false)}
                />
              </MDBModalHeader>
              <MDBModalBody>
                <p>Select which <strong>map</strong> source to load into the layout builder.</p>
                <div className="layout-history-tabs">
                  <button
                    type="button"
                    className={`layout-history-tab-btn${svgListTab === "main" ? " is-active" : ""}`}
                    onClick={() => setSvgListTab("main")}
                  >
                    Main Layout + History
                  </button>
                  <button
                    type="button"
                    className={`layout-history-tab-btn${svgListTab === "drafts" ? " is-active" : ""}`}
                    onClick={() => setSvgListTab("drafts")}
                  >
                    Draft Map (Unpublished)
                  </button>
                </div>
                <ul className="layout-history-list">
                  {!availableDrafts.length && (
                    <li>
                      <div className="layout-history-item-btn">
                        <span>
                          {svgListTab === "drafts"
                            ? "No draft unpublished Maps are available."
                            : "No main/history layouts are available."}
                        </span>
                      </div>
                    </li>
                  )}
                  {availableDrafts.map((draft) => (
                    <li key={draft.key}>
                      <div className="layout-history-item-row">
                        {(() => {
                          const isLoadedDraft = Boolean(loadedDraftFilename && draft.filename === loadedDraftFilename);
                          const isActive = hoveredDraftKey
                            ? hoveredDraftKey === draft.key
                            : activeDraftKey === draft.key || isLoadedDraft;
                          return (
                        <button
                          type="button"
                          className={`layout-history-item-btn${
                            draft.key === "main-layout-svg-current" ? " is-main-current" : ""
                          }${isActive ? " is-active" : ""}${loadingDraftKey === draft.key ? " is-loading" : ""}`}
                          onClick={() => {
                            void loadDraftSvg(draft);
                          }}
                          disabled={loadingDraftKey !== null}
                          aria-busy={loadingDraftKey === draft.key}
                          onMouseEnter={() => setHoveredDraftKey(draft.key)}
                          onMouseLeave={() => setHoveredDraftKey(null)}
                        >
                          <strong>{draft.draftId}</strong>
                          {draft.sourceLabel ? <span>{draft.sourceLabel}</span> : null}
                          <span>{draft.filename}</span>
                        </button>
                          );
                        })()}
                        {((svgListTab === "drafts" && draft.isDraftFile) ||
                          (svgListTab === "main" && draft.key !== "main-layout-svg-current")) ? (
                          <button
                            type="button"
                            className="layout-history-edit-btn"
                            aria-label={`Rename ${draft.filename}`}
                            title={`Rename ${draft.filename}`}
                            onClick={() => {
                              setDraftToRename(draft);
                              setDraftRenameValue(draft.draftId);
                              setDraftRenameError("");
                            }}
                          >
                            <i className="fas fa-pen" aria-hidden="true" />
                          </button>
                        ) : null}
                        {svgListTab === "drafts" && draft.isDraftFile ? (
                          <button
                            type="button"
                            className="layout-history-delete-btn"
                            aria-label={`Delete ${draft.filename}`}
                            title={`Delete ${draft.filename}`}
                            onClick={() => {
                              setDraftToDelete(draft);
                            }}
                          >
                            <i className="fas fa-trash" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </MDBModalBody>
              <MDBModalFooter>
                <MDBBtn className="layout-action-btn" onClick={() => setShowDraftsPopup(false)}>
                  Close
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal open={Boolean(draftToDelete)} setOpen={() => setDraftToDelete(null)} tabIndex="-1">
          <MDBModalDialog centered>
            <MDBModalContent className="draft-delete-modal-content">
              <MDBModalHeader className="draft-delete-modal-header">
                <MDBModalTitle className="draft-delete-modal-title">
                  <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                  Delete Draft Map
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-delete-modal-body">
                {draftToDelete ? (
                  <p>
                    Delete <strong>{draftToDelete.filename}</strong>?
                  </p>
                ) : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-delete-modal-footer">
                <MDBBtn color="secondary" className="draft-delete-cancel-btn" onClick={() => setDraftToDelete(null)}>
                  Cancel
                </MDBBtn>
                <MDBBtn
                  color="danger"
                  className="draft-delete-confirm-btn"
                  onClick={() => {
                    if (draftToDelete) {
                      void deleteDraftSvg(draftToDelete);
                    }
                  }}
                >
                  Delete
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal
          open={Boolean(draftToRename)}
          setOpen={() => {
            setDraftToRename(null);
            setDraftRenameValue("");
            setDraftRenameError("");
          }}
          tabIndex="-1"
        >
          <MDBModalDialog centered>
            <MDBModalContent className="draft-rename-modal-content">
              <MDBModalHeader className="draft-rename-modal-header">
                <MDBModalTitle className="draft-rename-modal-title">
                  <i className="fas fa-pen-to-square" aria-hidden="true" />
                  {draftToRename?.isDraftFile ? "Rename Draft Map" : "Rename Main Layout History"}
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-rename-modal-body">
                {draftToRename ? (
                  <>
                    <p>
                      Update name for <strong>{draftToRename.filename}</strong>
                    </p>
                    <input
                      type="text"
                      className="draft-rename-input"
                      value={draftRenameValue}
                      onChange={(e) => {
                        setDraftRenameValue(e.target.value);
                        if (draftRenameError) setDraftRenameError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void renameDraftSvg(draftToRename, draftRenameValue);
                        }
                      }}
                      autoFocus
                    />
                    {draftRenameError ? <div className="draft-rename-error">{draftRenameError}</div> : null}
                  </>
                ) : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-rename-modal-footer">
                <MDBBtn
                  color="secondary"
                  className="draft-rename-cancel-btn"
                  onClick={() => {
                    setDraftToRename(null);
                    setDraftRenameValue("");
                    setDraftRenameError("");
                  }}
                >
                  Cancel
                </MDBBtn>
                <MDBBtn
                  className="draft-rename-confirm-btn"
                  onClick={() => {
                    if (draftToRename) {
                      void renameDraftSvg(draftToRename, draftRenameValue);
                    }
                  }}
                >
                  Save Name
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal
          open={pendingAddFloor !== null}
          setOpen={() => {
            if (isAddingFloor) return;
            setPendingAddFloor(null);
          }}
          tabIndex="-1"
        >
          <MDBModalDialog centered>
            <MDBModalContent className="draft-delete-modal-content">
              <MDBModalHeader className="draft-delete-modal-header">
                <MDBModalTitle className="draft-delete-modal-title">
                  <i className="fas fa-layer-group" aria-hidden="true" />
                  Add Floor
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-delete-modal-body">
                {pendingAddFloor ? (
                  <p>
                    Add <strong>Floor {pendingAddFloor.targetFloor}</strong> by copying{" "}
                    <strong>Floor {pendingAddFloor.sourceFloor}</strong>?
                  </p>
                ) : null}
                {isAddingFloor ? (
                  <div style={{ display: "grid", justifyItems: "center", gap: 8, marginTop: 6 }}>
                    <div className="layout-publish-spinner" aria-hidden="true" />
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "#475569" }}>
                      Creating floor layout...
                    </p>
                  </div>
                ) : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-delete-modal-footer">
                <MDBBtn
                  color="secondary"
                  className="draft-delete-cancel-btn"
                  onClick={() => setPendingAddFloor(null)}
                  disabled={isAddingFloor}
                >
                  Cancel
                </MDBBtn>
                <MDBBtn
                  className="draft-delete-confirm-btn"
                  onClick={() => void confirmAddFloor()}
                  disabled={isAddingFloor}
                >
                  {isAddingFloor ? "Adding..." : "Add Floor"}
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal open={floorToDelete !== null} setOpen={() => setFloorToDelete(null)} tabIndex="-1">
          <MDBModalDialog centered>
            <MDBModalContent className="draft-delete-modal-content">
              <MDBModalHeader className="draft-delete-modal-header">
                <MDBModalTitle className="draft-delete-modal-title">
                  <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                  Delete Floor
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-delete-modal-body">
                {floorToDelete !== null ? (
                  <p>
                    Delete <strong>Floor {floorToDelete}</strong> and remove its map data from the current layout?
                  </p>
                ) : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-delete-modal-footer">
                <MDBBtn color="secondary" className="draft-delete-cancel-btn" onClick={() => setFloorToDelete(null)}>
                  Cancel
                </MDBBtn>
                <MDBBtn color="danger" className="draft-delete-confirm-btn" onClick={confirmDeleteFloor}>
                  Delete Floor
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal open={roomToDelete !== null} setOpen={() => setRoomToDelete(null)} tabIndex="-1">
          <MDBModalDialog centered>
            <MDBModalContent className="draft-delete-modal-content">
              <MDBModalHeader className="draft-delete-modal-header">
                <MDBModalTitle className="draft-delete-modal-title">
                  <i className="fas fa-triangle-exclamation" aria-hidden="true" />
                  Delete Component
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-delete-modal-body">
                {roomToDelete ? (
                  <p>
                    Delete <strong>{roomToDelete.text}</strong> from Floor {roomToDelete.floor}?
                  </p>
                ) : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-delete-modal-footer">
                <MDBBtn color="secondary" className="draft-delete-cancel-btn" onClick={() => setRoomToDelete(null)}>
                  Cancel
                </MDBBtn>
                <MDBBtn color="danger" className="draft-delete-confirm-btn" onClick={confirmDeleteRoom}>
                  Delete Component
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <section className="layout-config-toolbar">
          <div className="layout-config-title-wrap">
            <div className="layout-config-title-row">
              <div className="layout-config-title-meta">
                <h1 className="layout-config-ribbon-title">Layout Builder</h1>
                <div
                  className="layout-config-loaded-badge"
                  title={`Loaded: ${currentLoadedMapMeta.displayName} (${currentLoadedMapMeta.filename})`}
                >
                  <span className="layout-config-loaded-tag">Loaded</span>
                  <span className="layout-config-loaded-details">
                    <span className="layout-config-loaded-name-row">
                      <span className="layout-config-loaded-name">{currentLoadedMapMeta.displayName}</span>
                      {currentLoadedDraftOption?.key !== "main-layout-svg-current" ? (
                        <button
                          type="button"
                          className="layout-config-loaded-edit-btn"
                          aria-label={`Rename ${currentLoadedMapMeta.displayName}`}
                          title={`Rename ${currentLoadedMapMeta.displayName}`}
                          onClick={renameCurrentLoadedMap}
                        >
                          <i className="fas fa-pen" aria-hidden="true" />
                        </button>
                      ) : null}
                    </span>
                    <span className="layout-config-loaded-file-row">
                      <span className="layout-config-loaded-file">{currentLoadedMapMeta.filename}</span>
                    </span>
                  </span>
                </div>
              </div>
              <div className="layout-config-title-actions">
                <MDBBtn
                  className="layout-action-btn layout-open-drafts-btn"
                  onClick={openMapLayoutsModal}
                >
                  MAP LAYOUTS
                </MDBBtn>
                <MDBBtn className="layout-action-btn layout-save-btn" onClick={() => void saveLayout()} disabled={isUiBlocked}>
                  SAVE DRAFT
                </MDBBtn>
                <MDBBtn className="layout-action-btn layout-publish-btn" onClick={publishLayout} disabled={isUiBlocked}>
                  Publish
                </MDBBtn>
              </div>
            </div>
          </div>
          <div className="layout-config-tool-row">
            <div className="layout-config-tool-group layout-config-tool-group--add layout-config-tool-group--add-wrap">
              <div className="layout-config-tool-row-line">
                <MDBBtn
                  className="layout-tool-btn layout-add-floor-btn"
                  onClick={() => {
                    openAddFloorConfirm();
                  }}
                  disabled={isAddingFloor || isUiBlocked}
                  title="Add a new floor by copying the current top floor."
                >
                  ADD FLOOR
                </MDBBtn>
                {([
                  { toolKey: "room", label: "ADD ROOM" },
                  { toolKey: "polygon_room", label: "ADD IRREGULAR ROOM" },
                  { toolKey: "lounge", label: "ADD LOUNGE" },
                ] as const).map(({ toolKey, label }) => (
                  <MDBBtn
                    key={toolKey}
                    className={`layout-tool-btn${tool === toolKey ? " is-active" : ""}`}
                    onClick={() => {
                      setTool(toolKey);
                    }}
                  >
                    {label}
                  </MDBBtn>
                ))}
              </div>
              <div className="layout-config-tool-row-line">
                {([
                  { toolKey: "stairs", label: "ADD STAIRS" },
                  { toolKey: "hallway", label: "ADD HALLWAY" },
                  { toolKey: "entrance", label: "ADD ENTRANCE" },
                  { toolKey: "wing_background", label: "ADD GRAY SLAB" },
                ] as const).map(({ toolKey, label }) => (
                  <MDBBtn
                    key={toolKey}
                    className={`layout-tool-btn${tool === toolKey ? " is-active" : ""}`}
                    onClick={() => {
                      setTool(toolKey);
                    }}
                  >
                    {label}
                  </MDBBtn>
                ))}
              </div>
            </div>
            <MDBBtn
              className={`layout-action-btn layout-action-light-gray layout-toolbar-pan-btn${tool === "select" ? " is-active" : ""}`}
              onClick={() => {
                setTool("select");
              }}
              title="Select mode"
            >
              <i className="fas fa-mouse-pointer" aria-hidden="true" />
              <span>SELECT</span>
            </MDBBtn>
            <MDBBtn
              className={`layout-action-btn layout-action-light-gray layout-toolbar-pan-btn${tool === "pan" ? " is-active" : ""}`}
              onClick={() => {
                setTool("pan");
              }}
              title="Pan mode"
            >
              <i className="fas fa-hand-paper" aria-hidden="true" />
              <span>PAN</span>
            </MDBBtn>
            <span className="layout-toolbar-pan-hint">Use mouse for zoom</span>
            {tool === "polygon_room" ? (
              <span className="layout-toolbar-pan-hint">Click to add points, double-click or press Enter to finish</span>
            ) : null}
            <div className="layout-tool-break" />
            <div className="layout-config-io-group" aria-label="JSON file actions">
              <MDBBtn className="layout-action-btn layout-action-light-gray layout-io-btn layout-io-btn-export" onClick={exportLayoutJson}>
                <i className="fas fa-download" aria-hidden="true" />
                <span>EXPORT JSON</span>
              </MDBBtn>
              <MDBBtn className="layout-action-btn layout-action-light-gray layout-io-btn layout-io-btn-import" onClick={triggerImport}>
                <i className="fas fa-upload" aria-hidden="true" />
                <span>IMPORT JSON</span>
              </MDBBtn>
            </div>
            <div className="layout-config-maintenance-group" aria-label="Reset and undo actions">
              <MDBBtn
                className="layout-action-btn layout-action-light-gray layout-copy-room-btn"
                onClick={duplicateSelectedRoom}
                disabled={!activeSelectionIds.length || isUiBlocked}
                title={
                  activeSelectionIds.length
                    ? "Copy selected elements (Ctrl/Cmd+C)"
                    : "Select an element first to copy it."
                }
              >
                <i className="fas fa-copy" aria-hidden="true" />
                <span>Copy Selected</span>
              </MDBBtn>
              <MDBBtn
                className="layout-action-btn layout-action-light-gray"
                onClick={pasteCopiedElements}
                disabled={!copiedRoomCount || isUiBlocked}
                title={copiedRoomCount ? "Paste copied elements (Ctrl/Cmd+V)" : "Copy an element first to paste it."}
              >
                <i className="fas fa-paste" aria-hidden="true" />
                <span>Paste</span>
              </MDBBtn>
              <MDBBtn className="layout-action-btn layout-action-light-gray" onClick={resetCurrentFloor}>
                Reset Floor
              </MDBBtn>
              <MDBBtn className="layout-action-btn layout-action-light-gray" onClick={resetAllFloors}>
                Reset All
              </MDBBtn>
              <MDBBtn
                className="layout-action-btn layout-action-light-gray"
                onClick={undoLayoutChange}
                disabled={undoCount === 0}
                title="Undo last change (Ctrl/Cmd+Z)"
              >
                Undo
              </MDBBtn>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={onImportLayout}
            />
          </div>
        </section>

        <section className="layout-config-workspace">
          <div
            className={`layout-config-canvas-wrap${isBackgroundMapLoading ? " is-map-loading" : ""}`}
            ref={canvasWrapRef}
          >
            <div className="layout-canvas-left-controls">
              <div className="layout-canvas-floor-stack-row">
                <div className="layout-canvas-floor-stack">
                  {visibleFloors.map((floorNum) => (
                    <MDBBtn
                      key={`canvas-floor-${floorNum}`}
                      className={`layout-tool-btn layout-canvas-floor-btn${activeFloor === floorNum ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveFloor(floorNum);
                        setSelection(null);
                      }}
                    >
                      FLOOR {floorNum}
                    </MDBBtn>
                  ))}
                </div>
                {tool !== "pan" ? (
                  <div className="layout-canvas-pan-arrows-right" aria-label="Map move controls">
                    <button
                      type="button"
                      className="layout-canvas-pan-arrow layout-canvas-pan-arrow-up"
                      aria-label="Move map up"
                      title="Move map up"
                      onClick={() => nudgeMapVertically(-VERTICAL_NUDGE_PX)}
                    >
                      <i className="fas fa-chevron-up" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="layout-canvas-pan-arrow layout-canvas-pan-arrow-left"
                      aria-label="Move map left"
                      title="Move map left"
                      onClick={() => nudgeMapHorizontally(-HORIZONTAL_NUDGE_PX)}
                    >
                      <i className="fas fa-chevron-left" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="layout-canvas-pan-arrow layout-canvas-pan-arrow-right"
                      aria-label="Move map right"
                      title="Move map right"
                      onClick={() => nudgeMapHorizontally(HORIZONTAL_NUDGE_PX)}
                    >
                      <i className="fas fa-chevron-right" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="layout-canvas-pan-arrow layout-canvas-pan-arrow-down"
                      aria-label="Move map down"
                      title="Move map down"
                      onClick={() => nudgeMapVertically(VERTICAL_NUDGE_PX)}
                    >
                      <i className="fas fa-chevron-down" aria-hidden="true" />
                    </button>
                    <span className="layout-canvas-pan-cross-center" aria-hidden="true" />
                  </div>
                ) : null}
              </div>
              <div className="layout-canvas-pan-panel">
                <MDBBtn
                  className={`layout-tool-btn layout-canvas-pan-btn${tool === "pan" ? " is-active" : ""}`}
                  onClick={() => {
                    setTool("pan");
                  }}
                  title="Pan mode (right-drag, middle-drag, or Ctrl+drag also works)"
                >
                  <i className="fas fa-hand-paper" aria-hidden="true" />
                  <span>PAN</span>
                </MDBBtn>
              </div>
            </div>
            {isBackgroundMapLoading ? <div className="layout-canvas-loading-overlay" aria-hidden="true" /> : null}
            <Stage
              ref={stageRef}
              width={viewport.width}
              height={viewport.height}
              className="layout-config-stage"
              onWheel={onWheel}
              onMouseDown={onStageMouseDown}
              onMouseMove={onStageMouseMove}
              onMouseUp={onStageMouseUp}
              onDblClick={() => {
                if (tool === "polygon_room" && polygonDraft?.points?.length) {
                  const nextRoom = polygonRoomFromPoints(
                    activeFloor,
                    "room",
                    polygonDraft.points,
                    makeDefaultLabel("room", currentLayout.rooms.length + 1)
                  );
                  if (nextRoom) {
                    applyLayoutChange((prev) => {
                      const next = cloneLayoutsByFloor(prev);
                      next[activeFloor].rooms = [...next[activeFloor].rooms, nextRoom];
                      return next;
                    });
                    setSelection(nextRoom.id);
                    setSelectedIds([nextRoom.id]);
                    setPolygonDraft(null);
                    setTool("select");
                  }
                }
              }}
              onContextMenu={(evt) => evt.evt.preventDefault()}
            >
              <Layer>
                <Group x={view.x} y={view.y} scaleX={view.scale} scaleY={view.scale}>
                  <Rect name="canvas-hit" x={0} y={0} width={WORLD_SIZE} height={WORLD_SIZE} fill="#f8fafc" />
                  {gridLines.map((line, idx) => (
                    <Line
                      key={`grid-${idx}`}
                      points={line.points}
                      stroke="#e2e8f0"
                      strokeWidth={idx % 5 === 0 ? 1.2 : 0.8}
                      listening={false}
                    />
                  ))}
                  {visibleAutoHallwayOverlays.map((overlay) => (
                    <Rect
                      key={overlay.id}
                      x={overlay.x}
                      y={overlay.y}
                      width={overlay.w}
                      height={overlay.h}
                      cornerRadius={8}
                      fill={autoHallwayStyle.fill}
                      stroke={autoHallwayStyle.stroke}
                      strokeWidth={2}
                      opacity={0.45}
                      listening={tool === "select"}
                      onClick={() => selectAutoHallwayOverlay(overlay)}
                      onTap={() => selectAutoHallwayOverlay(overlay)}
                    />
                  ))}
                  {tool === "polygon_room" && polygonDraft?.points?.length ? (
                    <Group listening={false}>
                      <Line
                        points={polyToFlatPoints(
                          polygonDraft.hover ? [...polygonDraft.points, polygonDraft.hover] : polygonDraft.points
                        )}
                        stroke="#2563eb"
                        strokeWidth={2}
                        dash={[8, 6]}
                        lineCap="round"
                        lineJoin="round"
                      />
                      {polygonDraft.points.map((point, index) => (
                        <Rect
                          key={`draft-point-${index}`}
                          x={point.x - POLYGON_VERTEX_HIT_RADIUS}
                          y={point.y - POLYGON_VERTEX_HIT_RADIUS}
                          width={POLYGON_VERTEX_HIT_RADIUS * 2}
                          height={POLYGON_VERTEX_HIT_RADIUS * 2}
                          cornerRadius={999}
                          fill="#ffffff"
                          stroke="#2563eb"
                          strokeWidth={2}
                        />
                      ))}
                    </Group>
                  ) : null}

                  {roomsForRender.map((room) => {
                    const style = roomStyle(room.kind, room.wing, room.fill);
                    const fittedLabel = room.kind === "wing_background" ? null : fitRoomLabel(room);
                    const isSelected = activeSelectionIds.includes(room.id);
                    const draggedSelectionIds = isSelected ? activeSelectionIds : [room.id];
                    if (room.rect) {
                      const isRotatable = room.kind === "room" || room.kind === "lounge" || room.kind === "stairs";
                      const visualRotation = (rotateStartRef.current?.roomId === room.id && rotationDraft !== null)
                        ? rotationDraft
                        : (room.rect.rotation ?? 0);
                      const rectCx = room.rect.x + room.rect.w / 2;
                      const rectCy = room.rect.y + room.rect.h / 2;
                      const isInteractive = !isUiBlocked && (tool === "select" || isSelected);

                      if (isRotatable) {
                        return (
                          <Group
                            key={room.id}
                            ref={isSelected ? selectedWingBackgroundNodeRef : undefined}
                            x={rectCx}
                            y={rectCy}
                            rotation={visualRotation}
                            draggable={isInteractive && isSelected}
                            listening={isInteractive}
                            onDragStart={() => { if (!isSelected) handleRoomSelection(room.id); }}
                            onDragEnd={(e) => {
                              const newCx = snap(e.target.x());
                              const newCy = snap(e.target.y());
                              const nextX = newCx - room.rect!.w / 2;
                              const nextY = newCy - room.rect!.h / 2;
                              const dx = nextX - room.rect!.x;
                              const dy = nextY - room.rect!.y;
                              if (draggedSelectionIds.length > 1) {
                                moveSelectedRoomsBy(draggedSelectionIds, dx, dy);
                                return;
                              }
                              updateRoom(room.id, (prevRoom) => {
                                if (!prevRoom.rect) return prevRoom;
                                return {
                                  ...prevRoom,
                                  rect: { ...prevRoom.rect, x: nextX, y: nextY },
                                  label: prevRoom.label
                                    ? { ...prevRoom.label, x: prevRoom.label.x + dx, y: prevRoom.label.y + dy }
                                    : prevRoom.label,
                                };
                              });
                            }}
                            onTransform={(e) => {
                              const node = e.target;
                              const lw = Math.round(Math.max(GRID_SIZE / 2, room.rect!.w * node.scaleX()));
                              const lh = Math.round(Math.max(GRID_SIZE / 2, room.rect!.h * node.scaleY()));
                              setLiveResizeDims((prev) => (prev?.w === lw && prev?.h === lh ? prev : { w: lw, h: lh }));
                            }}
                            onTransformEnd={(e) => {
                              setLiveResizeDims(null);
                              updateRoom(room.id, (prevRoom) => {
                                if (!prevRoom.rect) return prevRoom;
                                const node = e.target;
                                const newW = Math.max(GRID_SIZE / 2, prevRoom.rect.w * node.scaleX());
                                const newH = Math.max(GRID_SIZE / 2, prevRoom.rect.h * node.scaleY());
                                const newCx = node.x();
                                const newCy = node.y();
                                node.scaleX(1);
                                node.scaleY(1);
                                const nextW = snap(newW);
                                const nextH = snap(newH);
                                const nextX = snap(newCx - nextW / 2);
                                const nextY = snap(newCy - nextH / 2);
                                return {
                                  ...prevRoom,
                                  rect: { ...prevRoom.rect, x: nextX, y: nextY, w: nextW, h: nextH },
                                  label: prevRoom.label
                                    ? { ...prevRoom.label, x: nextX + nextW / 2, y: nextY + nextH / 2 }
                                    : prevRoom.label,
                                };
                              });
                            }}
                            onClick={(evt) =>
                              handleRoomSelection(room.id, Boolean(evt.evt?.shiftKey || evt.evt?.ctrlKey || evt.evt?.metaKey))
                            }
                            onTap={() => handleRoomSelection(room.id)}
                          >
                            <Rect
                              x={-room.rect.w / 2 - 10}
                              y={-room.rect.h / 2 - 10}
                              width={room.rect.w + 20}
                              height={room.rect.h + 20}
                              cornerRadius={(room.rect.r ?? 8) + 10}
                              fill="rgba(15, 23, 42, 0.001)"
                              strokeEnabled={false}
                              listening={true}
                            />
                            <Rect
                              x={-room.rect.w / 2}
                              y={-room.rect.h / 2}
                              width={room.rect.w}
                              height={room.rect.h}
                              cornerRadius={room.rect.r ?? 8}
                              fill={style.fill}
                              stroke={isSelected ? "#1d4ed8" : style.stroke}
                              strokeWidth={isSelected ? 3 : 2}
                              listening={false}
                            />
                            {fittedLabel ? (
                              <Text
                                x={0}
                                y={0}
                                offsetX={fittedLabel.width / 2}
                                offsetY={fittedLabel.height / 2}
                                width={fittedLabel.width}
                                height={fittedLabel.height}
                                text={fittedLabel.text}
                                fill="#0f172a"
                                fontSize={fittedLabel.fontSize}
                                lineHeight={ROOM_LABEL_LINE_HEIGHT}
                                align="center"
                                verticalAlign="middle"
                                listening={false}
                              />
                            ) : null}
                          </Group>
                        );
                      }

                      return (
                        <Group key={room.id}>
                          <Rect
                            ref={
                              isSelected && (room.kind === "wing_background" || room.kind === "hallway")
                                ? selectedWingBackgroundNodeRef
                                : undefined
                            }
                            x={room.rect.x}
                            y={room.rect.y}
                            width={room.rect.w}
                            height={room.rect.h}
                            cornerRadius={room.rect.r ?? 8}
                            fill={style.fill}
                            stroke={isSelected ? "#1d4ed8" : style.stroke}
                            strokeWidth={isSelected ? 3 : 2}
                            draggable={!isUiBlocked && (tool === "select" || isSelected)}
                            onDragStart={() => { if (!isSelected) handleRoomSelection(room.id); }}
                            onDragEnd={(e) => {
                              const nextX = snap(e.target.x());
                              const nextY = snap(e.target.y());
                              const dx = nextX - room.rect!.x;
                              const dy = nextY - room.rect!.y;
                              if (draggedSelectionIds.length > 1) {
                                moveSelectedRoomsBy(draggedSelectionIds, dx, dy);
                                return;
                              }
                              updateRoom(room.id, (prevRoom) => {
                                if (!prevRoom.rect) return prevRoom;
                                return {
                                  ...prevRoom,
                                  rect: { ...prevRoom.rect, x: nextX, y: nextY },
                                  label: prevRoom.label
                                    ? { ...prevRoom.label, x: prevRoom.label.x + dx, y: prevRoom.label.y + dy }
                                    : prevRoom.label,
                                };
                              });
                            }}
                            onTransform={(e) => {
                              const node = e.target;
                              const lw = Math.round(Math.max(GRID_SIZE / 2, node.width() * node.scaleX()));
                              const lh = Math.round(Math.max(GRID_SIZE / 2, node.height() * node.scaleY()));
                              setLiveResizeDims((prev) => (prev?.w === lw && prev?.h === lh ? prev : { w: lw, h: lh }));
                            }}
                            onTransformEnd={(e) => {
                              setLiveResizeDims(null);
                              updateRoom(room.id, (prevRoom) => {
                                if (!prevRoom.rect) return prevRoom;
                                const node = e.target;
                                const rawX = node.x();
                                const rawY = node.y();
                                const rawW = Math.max(GRID_SIZE / 2, node.width() * node.scaleX());
                                const rawH = Math.max(GRID_SIZE / 2, node.height() * node.scaleY());
                                node.scaleX(1);
                                node.scaleY(1);
                                const isVerticalHallway =
                                  prevRoom.kind === "hallway" && prevRoom.rect.h > prevRoom.rect.w;
                                const hallwaySnap = (value: number) => snapToStep(value, HALLWAY_RESIZE_SNAP);
                                const nextX =
                                  prevRoom.kind === "hallway" && isVerticalHallway
                                    ? prevRoom.rect.x
                                    : prevRoom.kind === "hallway"
                                      ? hallwaySnap(rawX)
                                      : snap(rawX);
                                const nextY =
                                  prevRoom.kind === "hallway" && !isVerticalHallway
                                    ? prevRoom.rect.y
                                    : prevRoom.kind === "hallway"
                                      ? hallwaySnap(rawY)
                                      : snap(rawY);
                                const nextW =
                                  prevRoom.kind === "hallway" && isVerticalHallway
                                    ? prevRoom.rect.w
                                    : prevRoom.kind === "hallway"
                                      ? Math.max(GRID_SIZE / 2, hallwaySnap(rawW))
                                      : Math.max(GRID_SIZE / 2, snap(rawW));
                                const nextH =
                                  prevRoom.kind === "hallway" && !isVerticalHallway
                                    ? prevRoom.rect.h
                                    : prevRoom.kind === "hallway"
                                      ? Math.max(GRID_SIZE / 2, hallwaySnap(rawH))
                                      : Math.max(GRID_SIZE / 2, snap(rawH));
                                return {
                                  ...prevRoom,
                                  rect: { ...prevRoom.rect, x: nextX, y: nextY, w: nextW, h: nextH },
                                  label: prevRoom.label
                                    ? { ...prevRoom.label, x: nextX + nextW / 2, y: nextY + nextH / 2 }
                                    : prevRoom.label,
                                };
                              });
                            }}
                            onClick={(evt) =>
                              handleRoomSelection(room.id, Boolean(evt.evt?.shiftKey || evt.evt?.ctrlKey || evt.evt?.metaKey))
                            }
                            onTap={() => handleRoomSelection(room.id)}
                          />
                          {room.kind === "wing_background" ? (
                            <Text
                              x={room.rect.x + 12}
                              y={room.rect.y + 8}
                              text={displayWingName(room.wing, room.wingName)}
                              fill="rgba(15, 23, 42, 0.55)"
                              fontSize={13}
                              fontStyle="bold"
                              listening={false}
                            />
                          ) : fittedLabel ? (
                            <Text
                              x={fittedLabel.x}
                              y={fittedLabel.y}
                              width={fittedLabel.width}
                              height={fittedLabel.height}
                              text={fittedLabel.text}
                              fill="#0f172a"
                              fontSize={fittedLabel.fontSize}
                              lineHeight={ROOM_LABEL_LINE_HEIGHT}
                              align="center"
                              verticalAlign="middle"
                              listening={false}
                            />
                          ) : null}
                        </Group>
                      );
                    }

                    if (room.poly) {
                      return (
                        <Group key={room.id}>
                          {isSelected ? (
                            <Line
                              points={polyToFlatPoints(room.poly.points)}
                              closed
                              stroke="#60a5fa"
                              strokeWidth={10}
                              opacity={0.22}
                              listening={false}
                            />
                          ) : null}
                          <Line
                            points={polyToFlatPoints(room.poly.points)}
                            closed
                            fill={style.fill}
                            stroke={isSelected ? "#1d4ed8" : style.stroke}
                            strokeWidth={isSelected ? 3 : 2}
                            dash={isSelected ? [12, 8] : undefined}
                            draggable={!isUiBlocked && (tool === "select" || isSelected)}
                            onDragStart={() => {
                              if (!isSelected) {
                                handleRoomSelection(room.id);
                              }
                            }}
                            onDragEnd={(e) => {
                              const dx = snap(e.target.x());
                              const dy = snap(e.target.y());
                              e.target.position({ x: 0, y: 0 });
                              if (draggedSelectionIds.length > 1) {
                                moveSelectedRoomsBy(draggedSelectionIds, dx, dy);
                                return;
                              }
                              updateRoom(room.id, (prevRoom) => {
                                if (!prevRoom.poly) return prevRoom;
                                return {
                                  ...prevRoom,
                                  poly: {
                                    points: prevRoom.poly.points.map((point) => ({
                                      x: point.x + dx,
                                      y: point.y + dy,
                                    })),
                                  },
                                  label: prevRoom.label
                                    ? {
                                        ...prevRoom.label,
                                        x: prevRoom.label.x + dx,
                                        y: prevRoom.label.y + dy,
                                      }
                                    : prevRoom.label,
                                };
                              });
                            }}
                            onClick={(evt) =>
                              handleRoomSelection(
                                room.id,
                                Boolean(evt.evt?.shiftKey || evt.evt?.ctrlKey || evt.evt?.metaKey)
                              )
                            }
                            onTap={() => handleRoomSelection(room.id)}
                          />
                          {isSelected && room.poly.points.length <= 8
                            ? room.poly.points.map((point, pointIndex) => {
                                const nextPoint = room.poly!.points[(pointIndex + 1) % room.poly!.points.length];
                                const edgeLength = polygonEdgeLength(room.poly!.points, pointIndex);
                                return (
                                  <Text
                                    key={`${room.id}-edge-${pointIndex}`}
                                    x={(point.x + nextPoint.x) / 2 - 18}
                                    y={(point.y + nextPoint.y) / 2 - 10}
                                    text={`${Math.round(edgeLength)} px`}
                                    fontSize={10}
                                    fill="#1e40af"
                                    listening={false}
                                  />
                                );
                              })
                            : null}
                          {fittedLabel ? (
                            <Text
                              x={fittedLabel.x}
                              y={fittedLabel.y}
                              width={fittedLabel.width}
                              height={fittedLabel.height}
                              text={fittedLabel.text}
                              fill="#0f172a"
                              fontSize={fittedLabel.fontSize}
                              lineHeight={ROOM_LABEL_LINE_HEIGHT}
                              align="center"
                              verticalAlign="middle"
                              listening={false}
                            />
                          ) : null}
                          {isSelected
                            ? room.poly.points.map((point, pointIndex) => (
                                <Group
                                  key={`${room.id}-vertex-${pointIndex}`}
                                  x={point.x}
                                  y={point.y}
                                  draggable
                                  onClick={() => setSelectedPolygonVertexIndex(pointIndex)}
                                  onTap={() => setSelectedPolygonVertexIndex(pointIndex)}
                                  onMouseEnter={() => setHoveredPolygonVertexIndex(pointIndex)}
                                  onMouseLeave={() => setHoveredPolygonVertexIndex((prev) => (prev === pointIndex ? null : prev))}
                                  onDragEnd={(e) => {
                                    const nextX = snap(e.target.x());
                                    const nextY = snap(e.target.y());
                                    e.target.position({ x: nextX, y: nextY });
                                    updateRoom(room.id, (prevRoom) => replaceRoomPolygonPoint(prevRoom, pointIndex, { x: nextX, y: nextY }));
                                  }}
                                >
                                  <Circle
                                    radius={
                                      selectedPolygonVertexIndex === pointIndex
                                        ? POLYGON_VERTEX_HIT_RADIUS + 4
                                        : hoveredPolygonVertexIndex === pointIndex
                                          ? POLYGON_VERTEX_HIT_RADIUS + 2
                                          : POLYGON_VERTEX_HIT_RADIUS
                                    }
                                    fill={selectedPolygonVertexIndex === pointIndex ? "#2563eb" : "#ffffff"}
                                    stroke="#1d4ed8"
                                    strokeWidth={2}
                                  />
                                  <Text
                                    x={-8}
                                    y={-6}
                                    width={16}
                                    align="center"
                                    text={String(pointIndex + 1)}
                                    fontSize={9}
                                    fontStyle="bold"
                                    fill={selectedPolygonVertexIndex === pointIndex ? "#ffffff" : "#1d4ed8"}
                                    listening={false}
                                  />
                                </Group>
                              ))
                            : null}
                        </Group>
                      );
                    }

                    return null;
                  })}

                  {selectedRoom?.rect ? (
                    <Transformer
                      ref={wingBackgroundTransformerRef}
                      rotateEnabled={false}
                      flipEnabled={false}
                      borderStroke="#2563eb"
                      borderStrokeWidth={2}
                      anchorStroke="#2563eb"
                      anchorFill="#ffffff"
                      anchorSize={9}
                      enabledAnchors={
                        selectedRoom.kind === "hallway"
                          ? selectedRoom.rect!.h > selectedRoom.rect!.w
                            ? ["top-center", "bottom-center"]
                            : ["middle-right", "middle-left"]
                          : [
                              "top-left",
                              "top-center",
                              "top-right",
                              "middle-right",
                              "bottom-right",
                              "bottom-center",
                              "bottom-left",
                              "middle-left",
                            ]
                      }
                      boundBoxFunc={(oldBox, newBox) => {
                        if (newBox.width < GRID_SIZE / 2 || newBox.height < GRID_SIZE / 2) {
                          return oldBox;
                        }
                        if (selectedRoom.kind === "hallway") {
                          if (selectedRoom.rect!.h > selectedRoom.rect!.w) {
                            return {
                              ...newBox,
                              x: oldBox.x,
                              width: oldBox.width,
                            };
                          }
                          return {
                            ...newBox,
                            y: oldBox.y,
                            height: oldBox.height,
                          };
                        }
                        return newBox;
                      }}
                    />
                  ) : null}

                  {selectedRoom && (selectedRoom.kind === "room" || selectedRoom.kind === "lounge" || selectedRoom.kind === "stairs") && selectedRoom.rect && tool === "select"
                    ? (() => {
                        const r = selectedRoom.rect;
                        const cx = r.x + r.w / 2;
                        const cy = r.y + r.h / 2;
                        const currentRotation = rotationDraft !== null ? rotationDraft : (r.rotation ?? 0);
                        const rotRad = (currentRotation * Math.PI) / 180;
                        const HANDLE_OFFSET = 14;
                        const hw = r.w / 2 + HANDLE_OFFSET;
                        const hh = r.h / 2 + HANDLE_OFFSET;
                        const corners = [
                          { dx: -hw, dy: -hh },
                          { dx:  hw, dy: -hh },
                          { dx:  hw, dy:  hh },
                          { dx: -hw, dy:  hh },
                        ].map(({ dx, dy }) => ({
                          x: cx + dx * Math.cos(rotRad) - dy * Math.sin(rotRad),
                          y: cy + dx * Math.sin(rotRad) + dy * Math.cos(rotRad),
                        }));
                        return corners.map((corner, i) => (
                          <Circle
                            key={`rotate-handle-${i}`}
                            x={corner.x}
                            y={corner.y}
                            radius={hoveredRotateHandle === i ? 9 : 7}
                            fill={hoveredRotateHandle === i ? "#dbeafe" : "#ffffff"}
                            stroke="#2563eb"
                            strokeWidth={2}
                            draggable
                            dragBoundFunc={() => ({
                              x: corner.x * view.scale + view.x,
                              y: corner.y * view.scale + view.y,
                            })}
                            onMouseEnter={() => {
                              setHoveredRotateHandle(i);
                              const container = stageRef.current?.container();
                              if (container) container.style.cursor = ROTATE_CURSORS[i];
                            }}
                            onMouseLeave={() => {
                              setHoveredRotateHandle(null);
                              const container = stageRef.current?.container();
                              if (container) container.style.cursor = "default";
                            }}
                            onDragStart={() => {
                              const worldPos = pointerToWorld(stageRef.current, view);
                              if (!worldPos) return;
                              const roomCx = selectedRoom.rect!.x + selectedRoom.rect!.w / 2;
                              const roomCy = selectedRoom.rect!.y + selectedRoom.rect!.h / 2;
                              rotateStartRef.current = {
                                startAngle: Math.atan2(worldPos.y - roomCy, worldPos.x - roomCx),
                                startRotation: selectedRoom.rect!.rotation ?? 0,
                                roomId: selectedRoom.id,
                              };
                            }}
                            onDragMove={() => {
                              if (!rotateStartRef.current) return;
                              const worldPos = pointerToWorld(stageRef.current, view);
                              if (!worldPos) return;
                              const roomCx = selectedRoom.rect!.x + selectedRoom.rect!.w / 2;
                              const roomCy = selectedRoom.rect!.y + selectedRoom.rect!.h / 2;
                              const currentAngle = Math.atan2(worldPos.y - roomCy, worldPos.x - roomCx);
                              const delta = (currentAngle - rotateStartRef.current.startAngle) * (180 / Math.PI);
                              const newRotation = rotateStartRef.current.startRotation + delta;
                              rotationDraftRef.current = newRotation;
                              setRotationDraft(newRotation);
                            }}
                            onDragEnd={() => {
                              const finalRotation = rotationDraftRef.current;
                              if (finalRotation !== null && rotateStartRef.current?.roomId === selectedRoom.id) {
                                updateRoom(selectedRoom.id, (prevRoom) => ({
                                  ...prevRoom,
                                  rect: prevRoom.rect ? { ...prevRoom.rect, rotation: finalRotation } : prevRoom.rect,
                                }));
                              }
                              rotationDraftRef.current = null;
                              setRotationDraft(null);
                              rotateStartRef.current = null;
                              setHoveredRotateHandle(null);
                              const container = stageRef.current?.container();
                              if (container) container.style.cursor = "default";
                            }}
                          />
                        ));
                      })()
                    : null}

                  {/* Canvas dimension badge for selected room */}
                  {selectedRoom && tool === "select" && (() => {
                    const dispW = liveResizeDims?.w ?? selectedRoomMetrics?.width;
                    const dispH = liveResizeDims?.h ?? selectedRoomMetrics?.height;
                    if (!dispW || !dispH) return null;
                    let cx: number, cy: number, rectW: number, rectH: number, rotation: number;
                    if (selectedRoom.rect) {
                      const r = selectedRoom.rect;
                      cx = r.x + r.w / 2;
                      cy = r.y + r.h / 2;
                      rectW = liveResizeDims?.w ?? r.w;
                      rectH = liveResizeDims?.h ?? r.h;
                      rotation = (rotateStartRef.current?.roomId === selectedRoom.id && rotationDraft !== null)
                        ? rotationDraft : (r.rotation ?? 0);
                    } else if (selectedRoom.poly?.points?.length) {
                      const pts = selectedRoom.poly.points;
                      const xs = pts.map((p) => p.x);
                      const ys = pts.map((p) => p.y);
                      cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
                      rectW = dispW;
                      rectH = dispH;
                      rotation = 0;
                    } else {
                      return null;
                    }
                    const rotRad = (rotation * Math.PI) / 180;
                    const aabbH = rectW * Math.abs(Math.sin(rotRad)) + rectH * Math.abs(Math.cos(rotRad));
                    const badgeY = cy + aabbH / 2 + 16;
                    const isHallway = selectedRoom.kind === "hallway" || selectedRoom.kind === "bridge";
                    const pxLine = isHallway
                      ? `L: ${Math.round(Math.max(dispW, dispH))}  T: ${Math.round(Math.min(dispW, dispH))} px`
                      : `${Math.round(dispW)} × ${Math.round(dispH)} px`;
                    const mLine = isHallway
                      ? `L: ${pxToM(Math.max(dispW, dispH))}  T: ${pxToM(Math.min(dispW, dispH))}`
                      : `${pxToM(dispW)} × ${pxToM(dispH)}`;
                    const badgeW = isHallway ? 148 : 116;
                    const badgeH = 40;
                    return (
                      <Group x={cx} y={badgeY} listening={false}>
                        <Rect
                          x={-badgeW / 2} y={-badgeH / 2}
                          width={badgeW} height={badgeH}
                          fill="#1e40af" cornerRadius={5} opacity={0.88}
                        />
                        <Text
                          x={-badgeW / 2} y={-badgeH / 2 + 4}
                          width={badgeW} height={18}
                          text={pxLine}
                          fill="#ffffff" fontSize={11} fontStyle="bold"
                          align="center" verticalAlign="middle"
                          listening={false}
                        />
                        <Text
                          x={-badgeW / 2} y={-badgeH / 2 + 21}
                          width={badgeW} height={15}
                          text={mLine}
                          fill="#93c5fd" fontSize={10}
                          align="center" verticalAlign="middle"
                          listening={false}
                        />
                      </Group>
                    );
                  })()}

                  {draftRoom && (
                    <Rect
                      x={Math.min(draftRoom.start.x, draftRoom.end.x)}
                      y={Math.min(draftRoom.start.y, draftRoom.end.y)}
                      width={Math.abs(draftRoom.end.x - draftRoom.start.x)}
                      height={Math.abs(draftRoom.end.y - draftRoom.start.y)}
                      fill="rgba(59, 130, 246, 0.22)"
                      stroke="#2563eb"
                      dash={[8, 6]}
                      strokeWidth={2}
                      listening={false}
                    />
                  )}
                </Group>
              </Layer>
            </Stage>
          </div>

          <aside className="layout-config-props-panel">
            <h2>Properties</h2>
            <div className="layout-props-floor-row">
              <button type="button" className="layout-props-floor-btn">
                Floor {activeFloor}
              </button>
              <button
                type="button"
                className="layout-props-floor-delete-btn"
                aria-label={propertiesDeleteLabel}
                title={propertiesDeleteLabel}
                onClick={handlePropertiesDelete}
                disabled={selectedRoomDeleteTarget ? !canDeleteSelectedComponent : !canDeleteFloorFromPanel}
              >
                <i className="fas fa-trash" aria-hidden="true" />
              </button>
            </div>
            {selectedRoom ? (
              <div className="layout-props-grid">
                <label>
                  <span>Room ID</span>
                  <input
                    type="text"
                    value={idDraft}
                    onChange={(e) => setIdDraft(e.target.value)}
                    onBlur={(e) => commitSelectedRoomId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitSelectedRoomId((e.target as HTMLInputElement).value);
                      }
                    }}
                  />
                </label>
                <label>
                  <span>Text</span>
                  <input
                    type="text"
                    value={selectedRoom.label?.text ?? ""}
                    onChange={(e) => updateSelectedRoomLabel(e.target.value)}
                  />
                </label>
                <label>
                  <span>Type</span>
                  <select
                    value={selectedRoom.kind}
                    onChange={(e) => updateSelectedRoomKind(e.target.value as LayoutRoomKind)}
                  >
                    <option value="room">Room</option>
                    <option value="lounge">Lounge</option>
                    <option value="stairs">Stairs</option>
                    <option value="hallway">Hallway</option>
                    <option value="bridge">Bridge</option>
                    <option value="entrance">Entrance</option>
                    <option value="wing_background">Wing Background</option>
                  </select>
                </label>
                {selectedRoom.kind === "wing_background" ? (
                  <label>
                    <span>Wing Name</span>
                    <input
                      type="text"
                      list="layout-builder-wing-name-options"
                      value={selectedRoom.wingName ?? displayWingName(selectedRoom.wing)}
                      onChange={(e) => updateSelectedWingBackgroundName(e.target.value)}
                      onBlur={(e) => updateSelectedWingBackgroundName(e.target.value, { commitEmpty: true })}
                    />
                    <datalist id="layout-builder-wing-name-options">
                      {wingNameOptions.map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                  </label>
                ) : null}
                {selectedRoom.kind === "room" ? (
                  <label className="layout-props-color-field">
                    <span>Room Color</span>
                    <select
                      value={selectedRoomColorPresetValue}
                      onChange={(e) => updateSelectedRoomFill(e.target.value)}
                      aria-label="Room color preset"
                    >
                      <option value="" disabled>
                        Custom
                      </option>
                      {ROOM_COLOR_OPTIONS.map((option) => (
                        <option key={option.label} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="layout-props-color-row">
                      <input
                        type="color"
                        value={selectedRoomStyle?.fill ?? "#f8fafc"}
                        onChange={(e) => updateSelectedRoomFill(e.target.value)}
                        aria-label="Room color"
                      />
                      <button
                        type="button"
                        className="layout-props-color-reset"
                        onClick={clearSelectedRoomFill}
                        disabled={!selectedRoom.fill}
                      >
                        Default
                      </button>
                    </div>
                  </label>
                ) : null}
                {selectedRoomMetrics ? (
                  <div className="layout-props-measurements">
                    <div className="layout-props-measurements-title">Measurements</div>
                    <div className="layout-props-measurements-grid">
                      <span>Width: {Math.round(selectedRoomMetrics.width)} px</span>
                      <span className="layout-props-dim-hint-inline">({pxToM(selectedRoomMetrics.width)})</span>
                      <span>Height: {Math.round(selectedRoomMetrics.height)} px</span>
                      <span className="layout-props-dim-hint-inline">({pxToM(selectedRoomMetrics.height)})</span>
                      <span>Area: {Math.round(selectedRoomMetrics.area)} sq px</span>
                      <span className="layout-props-dim-hint-inline">
                        ({fmtMeters(((selectedRoomMetrics.width / GRID_SIZE) * metersPerCell) * ((selectedRoomMetrics.height / GRID_SIZE) * metersPerCell))} ㎡)
                      </span>
                      <span>Perimeter: {Math.round(selectedRoomMetrics.perimeter)} px</span>
                      <span className="layout-props-dim-hint-inline">({pxToM(selectedRoomMetrics.perimeter)})</span>
                    </div>
                  </div>
                ) : null}
                {selectedRoom ? (
                  <div className="layout-props-shape-visual">
                    <div className="layout-props-measurements-title">Shape Visual</div>
                    <div className="layout-props-shape-badges">
                      <span className="layout-props-shape-badge">{selectedRoom.poly ? "Polygon Room" : "Rectangle Room"}</span>
                      <span className="layout-props-shape-badge">{selectedRoom.poly ? `${selectedRoom.poly.points.length} vertices` : "Resizable frame"}</span>
                    </div>
                    <div className="layout-props-shape-meta">
                      <span className="layout-props-shape-swatch" style={{ background: selectedRoomStyle?.fill ?? "#f8fafc" }} aria-hidden="true" />
                      <span>
                        {selectedRoom.poly
                          ? "Drag numbered handles on the canvas to sculpt the room outline."
                          : "Use the resize frame or dimension inputs to reshape this room."}
                      </span>
                    </div>
                    <div className="layout-props-shape-badges">
                      <span className="layout-props-shape-badge">{`Area ${fmtSquareMeters(selectedRoomAreaSqMeters)}`}</span>
                    </div>
                    {selectedPolygonVertex && selectedPolygonVertexEdgeLengths ? (
                      <div className="layout-props-shape-focus">
                        <strong>Selected vertex P{(selectedPolygonVertexIndex ?? 0) + 1}</strong>
                        <span>{`x ${Math.round(selectedPolygonVertex.x)}, y ${Math.round(selectedPolygonVertex.y)}`}</span>
                        <span>{`incoming ${Math.round(selectedPolygonVertexEdgeLengths.incoming)} px, outgoing ${Math.round(selectedPolygonVertexEdgeLengths.outgoing)} px`}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {(selectedRoom.kind === "room" || selectedRoom.kind === "lounge" || selectedRoom.kind === "stairs") ? (
                  <label>
                    <span>Orientation</span>
                    <button
                      type="button"
                      className="layout-tool-btn"
                      onClick={rotateSelectedRoom}
                    >
                      Rotate 90°
                    </button>
                  </label>
                ) : null}
                {(selectedRoom.kind === "hallway" || selectedRoom.kind === "bridge") && selectedRoom.rect ? (
                  <>
                    <label>
                      <span>Orientation</span>
                      <button
                        type="button"
                        className="layout-tool-btn"
                        onClick={rotateSelectedCorridor}
                      >
                        Rotate
                      </button>
                    </label>
                    <label>
                      <span>Layer Order</span>
                      <div className="layout-props-layer-actions">
                        <button
                          type="button"
                          className="layout-tool-btn"
                          onClick={() => moveSelectedCorridorLayer("back")}
                          disabled={isUiBlocked || !selectedCorridorLayerState.canSendToBack}
                        >
                          Send to Back
                        </button>
                        <button
                          type="button"
                          className="layout-tool-btn"
                          onClick={() => moveSelectedCorridorLayer("front")}
                          disabled={isUiBlocked || !selectedCorridorLayerState.canSendToFront}
                        >
                          Bring to Front
                        </button>
                      </div>
                    </label>
                  </>
                ) : null}
                <label>
                  <span>X</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rectDraft.x}
                    onChange={(e) => setRectDraft((prev) => ({ ...prev, x: e.target.value }))}
                    onBlur={(e) => selectedRoom.rect ? commitSelectedRoomRect("x", e.target.value) : commitSelectedRoomPolyBounds("x", e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        selectedRoom.rect ? commitSelectedRoomRect("x", (e.target as HTMLInputElement).value) : commitSelectedRoomPolyBounds("x", (e.target as HTMLInputElement).value);
                      }
                    }}
                    disabled={!selectedRoom.rect && !selectedRoom.poly}
                  />
                </label>
                <label>
                  <span>Y</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rectDraft.y}
                    onChange={(e) => setRectDraft((prev) => ({ ...prev, y: e.target.value }))}
                    onBlur={(e) => selectedRoom.rect ? commitSelectedRoomRect("y", e.target.value) : commitSelectedRoomPolyBounds("y", e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        selectedRoom.rect ? commitSelectedRoomRect("y", (e.target as HTMLInputElement).value) : commitSelectedRoomPolyBounds("y", (e.target as HTMLInputElement).value);
                      }
                    }}
                    disabled={!selectedRoom.rect && !selectedRoom.poly}
                  />
                </label>
                <label>
                  <span>Width</span>
                  <div className="layout-props-dim-row">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={rectDraft.w}
                      onChange={(e) => setRectDraft((prev) => ({ ...prev, w: e.target.value }))}
                      onBlur={(e) => selectedRoom.rect ? commitSelectedRoomRect("w", e.target.value) : commitSelectedRoomPolyBounds("w", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          selectedRoom.rect ? commitSelectedRoomRect("w", (e.target as HTMLInputElement).value) : commitSelectedRoomPolyBounds("w", (e.target as HTMLInputElement).value);
                        }
                      }}
                      disabled={!selectedRoom.rect && !selectedRoom.poly}
                    />
                    {selectedRoomMetrics && (
                      <span className="layout-props-dim-hint">{pxToM(selectedRoomMetrics.width)}</span>
                    )}
                  </div>
                </label>
                <label>
                  <span>Height</span>
                  <div className="layout-props-dim-row">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={rectDraft.h}
                      onChange={(e) => setRectDraft((prev) => ({ ...prev, h: e.target.value }))}
                      onBlur={(e) => selectedRoom.rect ? commitSelectedRoomRect("h", e.target.value) : commitSelectedRoomPolyBounds("h", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          selectedRoom.rect ? commitSelectedRoomRect("h", (e.target as HTMLInputElement).value) : commitSelectedRoomPolyBounds("h", (e.target as HTMLInputElement).value);
                        }
                      }}
                      disabled={!selectedRoom.rect && !selectedRoom.poly}
                    />
                    {selectedRoomMetrics && (
                      <span className="layout-props-dim-hint">{pxToM(selectedRoomMetrics.height)}</span>
                    )}
                  </div>
                </label>
                {selectedRoom.poly?.points?.length ? (
                  <div className="layout-props-polygon-editor">
                    <div className="layout-props-measurements-title">Irregular Shape Points</div>
                    <p className="layout-props-polygon-hint">
                      Click a numbered handle on the canvas or a row below, then add a midpoint or remove that vertex.
                    </p>
                    <div className="layout-props-layer-actions">
                      <button type="button" className="layout-tool-btn" onClick={addSelectedPolygonVertex}>
                        {selectedPolygonVertexIndex === null ? "Add Vertex at End" : `Add After P${selectedPolygonVertexIndex + 1}`}
                      </button>
                      <button
                        type="button"
                        className="layout-tool-btn"
                        onClick={removeSelectedPolygonVertex}
                        disabled={selectedRoom.poly.points.length <= 3}
                      >
                        {selectedPolygonVertexIndex === null ? "Remove Last Vertex" : `Remove P${selectedPolygonVertexIndex + 1}`}
                      </button>
                    </div>
                    {selectedRoom.poly.points.map((point, pointIndex) => (
                      <div
                        key={`${selectedRoom.id}-point-${pointIndex}-${point.x}-${point.y}`}
                        className={`layout-props-polygon-point-row${selectedPolygonVertexIndex === pointIndex ? " is-active" : ""}`}
                        onClick={() => setSelectedPolygonVertexIndex(pointIndex)}
                      >
                        <span>P{pointIndex + 1}</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          defaultValue={String(point.x)}
                          onFocus={() => setSelectedPolygonVertexIndex(pointIndex)}
                          onBlur={(e) => commitSelectedPolygonPoint(pointIndex, "x", e.target.value)}
                        />
                        <input
                          type="text"
                          inputMode="numeric"
                          defaultValue={String(point.y)}
                          onFocus={() => setSelectedPolygonVertexIndex(pointIndex)}
                          onBlur={(e) => commitSelectedPolygonPoint(pointIndex, "y", e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="layout-props-actions">
                  <button
                    type="button"
                    className="layout-props-copy-btn"
                    onClick={duplicateSelectedRoom}
                    disabled={isUiBlocked || !activeSelectionIds.length}
                  >
                    <i className="fas fa-copy" aria-hidden="true" />
                    <span>Copy Selected</span>
                  </button>
                </div>
              </div>
            ) : (
              <p className="layout-props-empty">Select a room on the map to edit text and coordinates.</p>
            )}
          </aside>
        </section>
      </main>
      <Footer />
    </div>
  );
}
