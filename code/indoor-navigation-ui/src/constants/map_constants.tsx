import type { Point, Space } from "../types/models";
import type { FloorId, Layout, LayoutRoomKind, WingId } from "../layout/layout.schema";
import { cloneLayout } from "../layout/layout.schema";
import { layoutToSvg, roomLabelPosition } from "../layout/layout.renderers";
import { SERVICE_BASE_URL } from "../utils/auth";
import MAIN_LAYOUT_JSON from "../data/main_layout.json";

// Kept for compatibility with existing imports.
export const STD_ROOM_HEIGHT = 80;
export const STD_ROOM_WIDTH = 100;

export const WIDTH_30 = 30;
export const WIDTH_50 = 50;
export const WIDTH_55 = 55;
export const WIDTH_75 = 75;
export const WIDTH_125 = 125;
export const WIDTH_150 = 150;
export const WIDTH_175 = 175;
export const WIDTH_200 = 200;
export const WIDTH_250 = 250;
export const WIDTH_420 = 420;

export const MAP_LAYOUT_REFRESH_PENDING_KEY = "indoor-nav.map-layout.refresh.pending";

type FloorLayoutSource = {
  wingBackgrounds?: Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>;
  wings: {
    A: Space[];
    B: Space[];
    C: Space[];
  };
  bridges: {
    AB: Space;
    BC: Space;
  };
};

type MapLayoutSource = {
  version: 1;
  units: "px";
  viewBox: { w: number; h: number };
  grid?: { size: number };
  mainEntrance: Point;
  floors: Record<"1" | "2" | "3", FloorLayoutSource>;
};

function emptyFloorSource(): FloorLayoutSource {
  return {
    wings: { A: [], B: [], C: [] },
    bridges: {
      AB: { id: "bridge-ab", name: "Bridge AB", x: 0, y: 0, width: 1, height: 1, type: "bridge", passable: true },
      BC: { id: "bridge-bc", name: "Bridge BC", x: 0, y: 0, width: 1, height: 1, type: "bridge", passable: true },
    },
  };
}

function fallbackMapLayout(): MapLayoutSource {
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

let MAP_LAYOUT: MapLayoutSource = isMapLayoutSource(MAIN_LAYOUT_JSON)
  ? (MAIN_LAYOUT_JSON as MapLayoutSource)
  : fallbackMapLayout();

export let MAIN_ENTRANCE: Point = MAP_LAYOUT.mainEntrance;

export let WING_BRIDGE_1F: Space = MAP_LAYOUT.floors["1"].bridges.AB;
export let WING_BRIDGE_BC_1F: Space = MAP_LAYOUT.floors["1"].bridges.BC;
export let WING_BRIDGE_2F: Space = MAP_LAYOUT.floors["2"].bridges.AB;
export let WING_BRIDGE_BC_2F: Space = MAP_LAYOUT.floors["2"].bridges.BC;
export let WING_BRIDGE_3F: Space = MAP_LAYOUT.floors["3"].bridges.AB;
export let WING_BRIDGE_BC_3F: Space = MAP_LAYOUT.floors["3"].bridges.BC;

export let WING_A_1F_OFFSET: Space[] = MAP_LAYOUT.floors["1"].wings.A;
export let WING_A_2F_OFFSET: Space[] = MAP_LAYOUT.floors["2"].wings.A;
export let WING_A_3F_OFFSET: Space[] = MAP_LAYOUT.floors["3"].wings.A;

export let WING_B_1F_OFFSET: Space[] = MAP_LAYOUT.floors["1"].wings.B;
export let WING_B_2F_OFFSET: Space[] = MAP_LAYOUT.floors["2"].wings.B;
export let WING_B_3F_OFFSET: Space[] = MAP_LAYOUT.floors["3"].wings.B;

export let WING_C_1F_OFFSET: Space[] = MAP_LAYOUT.floors["1"].wings.C;
export let WING_C_2F_OFFSET: Space[] = MAP_LAYOUT.floors["2"].wings.C;
export let WING_C_3F_OFFSET: Space[] = MAP_LAYOUT.floors["3"].wings.C;
export let WING_BACKGROUND_RECTS: Partial<Record<
  FloorId,
  Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>
>> = {
  1: { ...(MAP_LAYOUT.floors["1"].wingBackgrounds ?? {}) },
  2: { ...(MAP_LAYOUT.floors["2"].wingBackgrounds ?? {}) },
  3: { ...(MAP_LAYOUT.floors["3"].wingBackgrounds ?? {}) },
};

function toLayoutKind(type: Space["type"]): LayoutRoomKind {
  switch (type) {
    case "room":
      return "room";
    case "lounge":
      return "lounge";
    case "stairs":
      return "stairs";
    case "hallway":
      return "hallway";
    case "bridge":
      return "bridge";
    case "entrance":
      return "entrance";
    default:
      return "room";
  }
}

function spacesToLayout(floor: FloorId, spaces: Space[]): Layout {
  return {
    version: MAP_LAYOUT.version,
    units: MAP_LAYOUT.units,
    viewBox: { ...MAP_LAYOUT.viewBox },
    grid: MAP_LAYOUT.grid ? { ...MAP_LAYOUT.grid } : undefined,
    rooms: spaces.map((space) => ({
      id: space.id,
      floor,
      kind: toLayoutKind(space.type),
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
        ? {
            points: space.poly.points.map((point) => ({ x: point.x, y: point.y })),
          }
        : undefined,
      label: {
        x: space.poly?.points?.length
          ? roomLabelPosition({
              id: space.id,
              floor,
              kind: toLayoutKind(space.type),
              poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
            }).x
          : space.x + space.width / 2,
        y: space.poly?.points?.length
          ? roomLabelPosition({
              id: space.id,
              floor,
              kind: toLayoutKind(space.type),
              poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
            }).y
          : space.y + space.height / 2,
        text: space.name,
      },
    })),
  };
}

const spacesForFloor = (floor: FloorId): Space[] => {
  const key = String(floor) as "1" | "2" | "3";
  const source = MAP_LAYOUT.floors[key];
  return [...source.wings.C, source.bridges.BC, ...source.wings.A, source.bridges.AB, ...source.wings.B];
};

export let FLOOR_LAYOUTS: Partial<Record<FloorId, Layout>> = {
  1: spacesToLayout(1, spacesForFloor(1)),
  2: spacesToLayout(2, spacesForFloor(2)),
  3: spacesToLayout(3, spacesForFloor(3)),
};

// SVG strings are generated from canonical JSON-backed layouts.
export let FLOOR_SVGS: Partial<Record<FloorId, string>> = {
  1: layoutToSvg(FLOOR_LAYOUTS[1]),
  2: layoutToSvg(FLOOR_LAYOUTS[2]),
  3: layoutToSvg(FLOOR_LAYOUTS[3]),
};

function isMapLayoutSource(value: unknown): value is MapLayoutSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MapLayoutSource>;
  const floors = candidate.floors as any;
  if (!floors || typeof floors !== "object") return false;
  return Boolean(floors["1"]?.wings && floors["2"]?.wings && floors["3"]?.wings);
}

function applyMapLayout(next: MapLayoutSource): void {
  MAP_LAYOUT = next;
  MAIN_ENTRANCE = next.mainEntrance;

  WING_BRIDGE_1F = next.floors["1"].bridges.AB;
  WING_BRIDGE_BC_1F = next.floors["1"].bridges.BC;
  WING_BRIDGE_2F = next.floors["2"].bridges.AB;
  WING_BRIDGE_BC_2F = next.floors["2"].bridges.BC;
  WING_BRIDGE_3F = next.floors["3"].bridges.AB;
  WING_BRIDGE_BC_3F = next.floors["3"].bridges.BC;

  WING_A_1F_OFFSET = next.floors["1"].wings.A;
  WING_A_2F_OFFSET = next.floors["2"].wings.A;
  WING_A_3F_OFFSET = next.floors["3"].wings.A;
  WING_B_1F_OFFSET = next.floors["1"].wings.B;
  WING_B_2F_OFFSET = next.floors["2"].wings.B;
  WING_B_3F_OFFSET = next.floors["3"].wings.B;
  WING_C_1F_OFFSET = next.floors["1"].wings.C;
  WING_C_2F_OFFSET = next.floors["2"].wings.C;
  WING_C_3F_OFFSET = next.floors["3"].wings.C;
  WING_BACKGROUND_RECTS = {
    1: { ...(next.floors["1"].wingBackgrounds ?? {}) },
    2: { ...(next.floors["2"].wingBackgrounds ?? {}) },
    3: { ...(next.floors["3"].wingBackgrounds ?? {}) },
  };

  FLOOR_LAYOUTS = {
    1: spacesToLayout(1, spacesForFloor(1)),
    2: spacesToLayout(2, spacesForFloor(2)),
    3: spacesToLayout(3, spacesForFloor(3)),
  };
  FLOOR_SVGS = {
    1: layoutToSvg(FLOOR_LAYOUTS[1]),
    2: layoutToSvg(FLOOR_LAYOUTS[2]),
    3: layoutToSvg(FLOOR_LAYOUTS[3]),
  };
}

export async function refreshMapLayoutAfterPublishIfNeeded(force = false): Promise<boolean> {
  const pending = localStorage.getItem(MAP_LAYOUT_REFRESH_PENDING_KEY);
  if (!force && pending !== "1") return false;
  const endpoints = Array.from(
    new Set([`${SERVICE_BASE_URL}/map-layout`, "/api/map-layout", "/map-layout", "http://127.0.0.1:8000/map-layout"])
  );
  for (const endpoint of endpoints) {
    try {
      const url = endpoint.includes("?") ? `${endpoint}&_ts=${Date.now()}` : `${endpoint}?_ts=${Date.now()}`;
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!res.ok) continue;
      const payload = await res.json();
      if (!isMapLayoutSource(payload)) continue;
      applyMapLayout(payload);
      if (pending === "1") {
        localStorage.removeItem(MAP_LAYOUT_REFRESH_PENDING_KEY);
      }
      return true;
    } catch {
      // Try next endpoint.
    }
  }
  return false;
}

export function getFloorLayout(floor: number): Layout {
  const nextFloor = floor === 2 || floor === 3 ? floor : 1;
  return cloneLayout(FLOOR_LAYOUTS[nextFloor] ?? FLOOR_LAYOUTS[1]!);
}

export function getFloorSvg(floor: number): string {
  const nextFloor = floor === 2 || floor === 3 ? floor : 1;
  return FLOOR_SVGS[nextFloor] ?? FLOOR_SVGS[1] ?? "";
}


