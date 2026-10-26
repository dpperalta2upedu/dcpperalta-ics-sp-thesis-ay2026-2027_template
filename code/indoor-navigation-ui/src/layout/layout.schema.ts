export type FloorId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type WingId = "A" | "B" | "C" | "D" | "E";

export type LayoutPoint = {
  x: number;
  y: number;
};

export type LayoutRoomKind =
  | "room"
  | "lounge"
  | "stairs"
  | "elevator"
  | "hallway"
  | "bridge"
  | "entrance"
  | "wing_background";

export type LayoutRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  rotation?: number;
};

export type LayoutPoly = {
  points: LayoutPoint[];
};

export type LayoutLabel = {
  x: number;
  y: number;
  text: string;
};

export type LayoutRoom = {
  id: string;
  floor: FloorId;
  kind: LayoutRoomKind;
  wing?: WingId;
  wingName?: string;
  fill?: string;
  rect?: LayoutRect;
  poly?: LayoutPoly;
  label?: LayoutLabel;
};

export type Layout = {
  version: 1;
  units: "px";
  viewBox: { w: number; h: number };
  grid?: { size: number };
  /** Real-world scale: meters represented by one grid cell (default 1.0). */
  metersPerCell?: number;
  rooms: LayoutRoom[];
};

export function cloneLayout(layout: Layout): Layout {
  return {
    ...layout,
    viewBox: { ...layout.viewBox },
    grid: layout.grid ? { ...layout.grid } : undefined,
    rooms: layout.rooms.map((room) => ({
      ...room,
      rect: room.rect ? { ...room.rect } : undefined,
      poly: room.poly
        ? {
            points: room.poly.points.map((point) => ({ ...point })),
          }
        : undefined,
      label: room.label ? { ...room.label } : undefined,
    })),
  };
}
