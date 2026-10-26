import type { FloorId, Layout, LayoutPoint, LayoutRoom, LayoutRoomKind, WingId } from "../../src/layout/layout.schema";

const GRID_SIZE = 40;
const VIEWBOX = { w: 1768, h: 930 };
const WINGS: WingId[] = ["A", "B", "C", "D", "E"];
const POSITION_STEP = 5;
const ROOM_COLUMN_GAP = 8;
const ROOM_ROW_GAP = 8;
const HALLWAY_ROW_GAP = 6;
const ACCESSORY_GAP = 10;
const WING_OUTER_GUTTER = 60;
const WING_SLOT_GAP = 24;
const WING_INNER_PADDING = 18;

export type SmartRoomKind = Extract<LayoutRoomKind, "room" | "lounge" | "stairs" | "hallway" | "bridge" | "entrance">;
export type RoomSizePreset = "small" | "medium" | "large" | "lab";
export type CorridorPattern = "single-loaded" | "double-loaded" | "clustered";
export type BuildingProfile = "academic" | "office" | "laboratory" | "mixed";
export type DensityPreset = "low" | "medium" | "high";
export type WingLabelMode = "wing" | "area";

export type TableBatchConfig = {
  id: string;
  floor: FloorId;
  wing: WingId;
  roomType: SmartRoomKind;
  roomNamePrefix: string;
  roomIdPrefix: string;
  count: number;
  startNumber: number;
  sizePreset: RoomSizePreset;
  pattern: CorridorPattern;
  roomScale: number;
  offsetX: number;
  offsetY: number;
  includeHallway: boolean;
  includeStairs: boolean;
  includeLounge: boolean;
};

export type AutoGenerateConfig = {
  width: number;
  height: number;
  floorCount: number;
  wingCount: number;
  roomsPerWing: number;
  roomScale: number;
  profile: BuildingProfile;
  density: DensityPreset;
  placementPattern: CorridorPattern;
  offsetX: number;
  offsetY: number;
  includeBridges: boolean;
  includeHallways: boolean;
  includeWingBackgrounds: boolean;
  includeEntrance: boolean;
  includeLounges: boolean;
  hallwayThickness: number;
  wingLabelMode: WingLabelMode;
  wingRoomScaleOverrides: Partial<Record<WingId, number>>;
};

type SizeDef = {
  width: number;
  height: number;
  radius: number;
};

const ROOM_SIZE_PRESETS: Record<RoomSizePreset, SizeDef> = {
  small: { width: 80, height: 80, radius: 8 },
  medium: { width: 120, height: 80, radius: 8 },
  large: { width: 200, height: 120, radius: 8 },
  lab: { width: 240, height: 120, radius: 8 },
};

const snap = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE;
const snapToStep = (value: number, step: number): number => Math.round(value / step) * step;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function roomRadiusForKind(kind: SmartRoomKind): number {
  if (kind === "lounge") return 20;
  if (kind === "entrance") return 10;
  return 8;
}

function roomNameForBatch(batch: TableBatchConfig, numericId: number): string {
  if (batch.roomType === "hallway") return `${batch.roomNamePrefix || "Hallway"} ${batch.wing}`;
  if (batch.roomType === "stairs") return `${batch.roomNamePrefix || "Stairs"} ${numericId}`;
  if (batch.roomType === "entrance") return batch.roomNamePrefix || "Entrance";
  return `${batch.roomNamePrefix} ${numericId}`;
}

function roomIdForBatch(batch: TableBatchConfig, numericId: number): string {
  return `${batch.roomIdPrefix}${numericId}`;
}

function makeRectRoom({
  id,
  floor,
  kind,
  wing,
  x,
  y,
  width,
  height,
  label,
}: {
  id: string;
  floor: FloorId;
  kind: SmartRoomKind | "wing_background";
  wing?: WingId;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}): LayoutRoom {
  return {
    id,
    floor,
    kind,
    wing,
    rect: {
      x: snapToStep(x, POSITION_STEP),
      y: snapToStep(y, POSITION_STEP),
      w: snap(width),
      h: snap(height),
      r: kind === "wing_background" ? 10 : roomRadiusForKind(kind),
    },
    label: label
      ? {
          x: snapToStep(x, POSITION_STEP) + snap(width) / 2,
          y: snapToStep(y, POSITION_STEP) + snap(height) / 2,
          text: label,
        }
      : undefined,
  };
}

type WingSlot = {
  left: number;
  right: number;
  width: number;
  innerLeft: number;
  innerRight: number;
  innerWidth: number;
};

function getWingSlots(viewWidth: number, wingCount: number): Record<WingId, WingSlot> {
  const activeWings = WINGS.slice(0, clamp(wingCount, 1, WINGS.length));
  const usableWidth = viewWidth - WING_OUTER_GUTTER * 2 - WING_SLOT_GAP * Math.max(0, activeWings.length - 1);
  const slotWidth = usableWidth / activeWings.length;
  return WINGS.reduce(
    (acc, wing, index) => {
      const fallbackIndex = Math.min(index, activeWings.length - 1);
      const left = WING_OUTER_GUTTER + fallbackIndex * (slotWidth + WING_SLOT_GAP);
      const right = left + slotWidth;
      const innerLeft = left + WING_INNER_PADDING;
      const innerRight = right - WING_INNER_PADDING;
      acc[wing] = {
        left,
        right,
        width: slotWidth,
        innerLeft,
        innerRight,
        innerWidth: innerRight - innerLeft,
      };
      return acc;
    },
    {} as Record<WingId, WingSlot>
  );
}

function roomBounds(room: LayoutRoom): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (room.rect) {
    return {
      minX: room.rect.x,
      minY: room.rect.y,
      maxX: room.rect.x + room.rect.w,
      maxY: room.rect.y + room.rect.h,
    };
  }
  const points: LayoutPoint[] = room.poly?.points ?? [];
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function mergeBounds(
  current: { minX: number; minY: number; maxX: number; maxY: number } | null,
  next: { minX: number; minY: number; maxX: number; maxY: number } | null
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!next) return current;
  if (!current) return next;
  return {
    minX: Math.min(current.minX, next.minX),
    minY: Math.min(current.minY, next.minY),
    maxX: Math.max(current.maxX, next.maxX),
    maxY: Math.max(current.maxY, next.maxY),
  };
}

function buildBatchRooms(batch: TableBatchConfig, viewWidth: number, wingCount: number): LayoutRoom[] {
  const baseSize = ROOM_SIZE_PRESETS[batch.sizePreset];
  const roomScale = clamp(batch.roomScale || 100, 60, 180) / 100;
  const size = {
    width: Math.max(40, snap(baseSize.width * roomScale)),
    height: Math.max(40, snap(baseSize.height * roomScale)),
    radius: baseSize.radius,
  };
  const wingSlots = getWingSlots(viewWidth, wingCount);
  const wingSlot = wingSlots[batch.wing];
  const stairsReserve = batch.includeStairs ? 80 + ACCESSORY_GAP : 0;
  const loungeReserve = batch.includeLounge ? 160 + ACCESSORY_GAP : 0;
  const startX = snap(Math.max(wingSlot.innerLeft + stairsReserve, wingSlot.innerLeft + stairsReserve + batch.offsetX));
  const startY = snap(140 + batch.offsetY);
  const gapX = ROOM_COLUMN_GAP;
  const gapY = ROOM_ROW_GAP;
  const corridorHeight = 40;
  const rooms: LayoutRoom[] = [];
  const count = clamp(batch.count, 1, 40);
  const roomAreaWidth = Math.max(size.width, wingSlot.innerRight - loungeReserve - startX);
  const maxColumnsThatFit = Math.max(1, Math.floor((roomAreaWidth + gapX) / (size.width + gapX)));

  if (batch.includeStairs) {
    rooms.push(
      makeRectRoom({
        id: `stairs-${batch.wing}-${batch.floor}-${batch.id}`,
        floor: batch.floor,
        kind: "stairs",
        wing: batch.wing,
        x: wingSlot.innerLeft,
        y: startY,
        width: 80,
        height: 80,
        label: "Stairs",
      })
    );
  }

  if (batch.pattern === "clustered") {
    const columns = Math.max(1, Math.min(maxColumnsThatFit, Math.min(3, Math.max(2, Math.ceil(Math.sqrt(count))))));
    const loungeSlot = batch.includeLounge ? Math.floor(count / 2) : -1;
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const roomNumber = batch.startNumber + index;
      const x = startX + column * (size.width + gapX);
      const y = startY + row * (size.height + gapY);
      rooms.push(
        makeRectRoom({
          id: roomIdForBatch(batch, roomNumber),
          floor: batch.floor,
          kind: batch.roomType,
          wing: batch.wing,
          x,
          y,
          width: size.width,
          height: size.height,
          label: roomNameForBatch(batch, roomNumber),
        })
      );

      if (index === loungeSlot) {
        const loungeX = Math.min(x + size.width + ACCESSORY_GAP, wingSlot.innerRight - 160);
        rooms.push(
          makeRectRoom({
            id: `lounge-${batch.wing}-${batch.floor}-${batch.id}`,
            floor: batch.floor,
            kind: "lounge",
            wing: batch.wing,
            x: loungeX,
            y,
            width: 160,
            height: 120,
            label: "Shared Lounge",
          })
        );
      }
    }

    return rooms;
  }

  const requestedColumns =
    batch.pattern === "double-loaded"
      ? Math.min(6, Math.max(3, Math.ceil(count / 2)))
      : Math.min(5, Math.max(3, Math.ceil(Math.sqrt(count))));
  const columns = Math.max(1, Math.min(requestedColumns, maxColumnsThatFit));
  const bands = batch.pattern === "double-loaded" ? Math.ceil(count / (columns * 2)) : Math.ceil(count / columns);
  let created = 0;

  for (let band = 0; band < bands; band += 1) {
    const bandTopY =
      startY +
      band *
        (size.height * (batch.pattern === "double-loaded" ? 2 : 1) +
          corridorHeight +
          HALLWAY_ROW_GAP * 2 +
          gapY);
    const hallwayWidth = columns * size.width + Math.max(0, columns - 1) * gapX;
    if (batch.includeHallway) {
      rooms.push(
        makeRectRoom({
          id: `hallway-${batch.wing}-${batch.floor}-${batch.id}-${band + 1}`,
          floor: batch.floor,
          kind: "hallway",
          wing: batch.wing,
          x: startX,
          y: bandTopY + size.height + HALLWAY_ROW_GAP,
          width: hallwayWidth,
          height: corridorHeight,
          label: `Hallway ${batch.wing}`,
        })
      );
    }

    for (let column = 0; column < columns && created < count; column += 1) {
      const x = startX + column * (size.width + gapX);
      const topRoomNumber = batch.startNumber + created;
      rooms.push(
        makeRectRoom({
          id: roomIdForBatch(batch, topRoomNumber),
          floor: batch.floor,
          kind: batch.roomType,
          wing: batch.wing,
          x,
          y: bandTopY,
          width: size.width,
          height: size.height,
          label: roomNameForBatch(batch, topRoomNumber),
        })
      );
      created += 1;

      if (batch.pattern === "double-loaded" && created < count) {
        const bottomRoomNumber = batch.startNumber + created;
        rooms.push(
          makeRectRoom({
            id: roomIdForBatch(batch, bottomRoomNumber),
            floor: batch.floor,
            kind: batch.roomType,
            wing: batch.wing,
            x,
            y: bandTopY + size.height + corridorHeight + HALLWAY_ROW_GAP * 2,
            width: size.width,
            height: size.height,
            label: roomNameForBatch(batch, bottomRoomNumber),
          })
        );
        created += 1;
      }
    }

    if (batch.includeLounge && band === 0) {
      const loungeX = Math.min(startX + hallwayWidth + ACCESSORY_GAP, wingSlot.innerRight - 160);
      rooms.push(
        makeRectRoom({
          id: `lounge-${batch.wing}-${batch.floor}-${batch.id}`,
          floor: batch.floor,
          kind: "lounge",
          wing: batch.wing,
          x: loungeX,
          y: bandTopY,
          width: 160,
          height: 120,
          label: "Lounge",
        })
      );
    }
  }

  return rooms;
}

function resolvedHallwayThickness(config: AutoGenerateConfig): number {
  return snap(clamp(config.hallwayThickness || 40, 20, 120));
}

export function buildLayoutsFromTableBatches(
  batches: TableBatchConfig[],
  viewWidth = VIEWBOX.w,
  viewHeight = VIEWBOX.h
): Partial<Record<FloorId, Layout>> {
  const layouts: Partial<Record<FloorId, Layout>> = {};
  const activeWingCount = Math.max(
    1,
    batches.reduce((max, batch) => Math.max(max, WINGS.indexOf(batch.wing) + 1), 0)
  );

  batches.forEach((batch) => {
    if (!layouts[batch.floor]) {
      layouts[batch.floor] = {
        version: 1,
        units: "px",
        viewBox: { w: viewWidth, h: viewHeight },
        grid: { size: GRID_SIZE },
        rooms: [],
      };
    }
    layouts[batch.floor]?.rooms.push(...buildBatchRooms(batch, viewWidth, activeWingCount));
  });

  return layouts;
}

function profileBatches(config: AutoGenerateConfig): TableBatchConfig[] {
  const floors = Array.from({ length: clamp(config.floorCount, 1, 10) }, (_, index) => (index + 1) as FloorId);
  const wings = WINGS.slice(0, clamp(config.wingCount, 1, WINGS.length));
  const densityCounts: Record<DensityPreset, number> = { low: 4, medium: 8, high: 12 };
  const perWingCount = clamp(config.roomsPerWing || densityCounts[config.density], 1, 30);
  const batches: TableBatchConfig[] = [];

  floors.forEach((floor) => {
    wings.forEach((wing, wingIndex) => {
      const defaultConfig: Omit<TableBatchConfig, "id" | "floor" | "wing"> = {
        roomType: "room",
        roomNamePrefix: "Room",
        roomIdPrefix: `${wing}${floor}`,
        count: perWingCount,
        startNumber: 1,
        sizePreset: "medium",
        pattern: config.placementPattern,
        roomScale: Math.round((config.roomScale * (config.wingRoomScaleOverrides[wing] ?? 100)) / 100),
        offsetX: config.offsetX,
        offsetY: config.offsetY + wingIndex * 20 + (floor - 1) * 8,
        includeHallway: config.includeHallways,
        includeStairs: true,
        includeLounge: config.includeLounges,
      };

      let batch: TableBatchConfig = {
        id: `${config.profile}-${floor}-${wing}`,
        floor,
        wing,
        ...defaultConfig,
      };

      if (config.profile === "academic") {
        batch = {
          ...batch,
          roomNamePrefix: floor === 1 ? "Classroom" : "Faculty Room",
          roomIdPrefix: `${wing}${floor}`,
          sizePreset: floor === 1 ? "large" : "medium",
        };
      }

      if (config.profile === "office") {
        batch = {
          ...batch,
          roomNamePrefix: "Office",
          roomIdPrefix: `${wing}${floor}`,
          sizePreset: "small",
          count: perWingCount + 2,
        };
      }

      if (config.profile === "laboratory") {
        batch = {
          ...batch,
          roomNamePrefix: "Laboratory",
          roomIdPrefix: `${wing}${floor}`,
          sizePreset: "lab",
          count: Math.max(3, Math.ceil(perWingCount / 2)),
          includeLounge: floor === 1 && config.includeLounges,
        };
      }

      if (config.profile === "mixed") {
        const mixedByWing: Partial<Record<WingId, Partial<TableBatchConfig>>> = {
          A: { roomNamePrefix: "Classroom", sizePreset: "large" },
          B: { roomNamePrefix: "Laboratory", sizePreset: "lab", count: Math.max(3, Math.ceil(perWingCount / 2)) },
          C: { roomNamePrefix: "Office", sizePreset: "small", count: Math.max(4, Math.ceil(perWingCount / 2)) },
        };
        batch = { ...batch, ...mixedByWing[wing] };
      }

      batches.push(batch);
    });
  });

  return batches;
}

function buildWingBackgrounds(
  layout: Layout,
  floorId: FloorId,
  wingCount: number,
  width: number,
  height: number,
  labelMode: WingLabelMode
): LayoutRoom[] {
  return WINGS.slice(0, wingCount)
    .map((wing) => {
      const contentBounds = layout.rooms
        .filter((room) => room.kind !== "wing_background" && room.wing === wing)
        .reduce<{ minX: number; minY: number; maxX: number; maxY: number } | null>((acc, room) => mergeBounds(acc, roomBounds(room)), null);

      if (!contentBounds) return null;

      const paddingX = GRID_SIZE;
      const paddingY = GRID_SIZE;
      const x = clamp(snap(contentBounds.minX - paddingX), 0, width);
      const y = clamp(snap(contentBounds.minY - paddingY), 0, height);
      const maxX = clamp(snap(contentBounds.maxX + paddingX), 0, width);
      const maxY = clamp(snap(contentBounds.maxY + paddingY), 0, height);

      return makeRectRoom({
        id: `wing-background-${wing}-${floorId}`,
        floor: floorId,
        kind: "wing_background",
        wing,
        x,
        y,
        width: Math.max(GRID_SIZE * 2, maxX - x),
        height: Math.max(GRID_SIZE * 2, maxY - y),
        label: `${labelMode === "area" ? "Area" : "Wing"} ${wing} Background`,
      });
    })
    .filter((room): room is LayoutRoom => Boolean(room));
}

function buildEntrance(width: number): LayoutRoom {
  return makeRectRoom({
    id: "main-entrance-floor-1",
    floor: 1,
    kind: "entrance",
    x: width / 2 - 120,
    y: 40,
    width: 240,
    height: 80,
    label: "Main Entrance",
  });
}

function buildBridges(layout: Layout, width: number, wingCount: number, floorId: FloorId): LayoutRoom[] {
  const slots = getWingSlots(width, wingCount);
  const wings = WINGS.slice(0, wingCount);
  const rooms: LayoutRoom[] = [];

  for (let index = 0; index < wings.length - 1; index += 1) {
    const currentWing = wings[index];
    const nextWing = wings[index + 1];
    const currentSlot = slots[currentWing];
    const nextSlot = slots[nextWing];
    const currentHallways = layout.rooms.filter(
      (room) => room.kind === "hallway" && room.wing === currentWing && room.rect
    );
    const nextHallways = layout.rooms.filter(
      (room) => room.kind === "hallway" && room.wing === nextWing && room.rect
    );
    const sourceHallway = currentHallways[0]?.rect;
    const targetHallway = nextHallways[0]?.rect;
    if (!sourceHallway || !targetHallway) {
      continue;
    }
    const bridgeLeft = sourceHallway.x + sourceHallway.w;
    const bridgeRight = targetHallway.x;
    const bridgeWidth = Math.max(40, bridgeRight - bridgeLeft);
    const bridgeHeight = Math.min(sourceHallway.h, targetHallway.h);
    const bridgeY = Math.round(((sourceHallway.y + targetHallway.y) / 2) / POSITION_STEP) * POSITION_STEP;
    rooms.push(
      makeRectRoom({
        id: `bridge-${currentWing}${nextWing}-${floorId}`,
        floor: floorId,
        kind: "bridge",
        x: bridgeLeft,
        y: bridgeY,
        width: bridgeWidth,
        height: bridgeHeight,
        label: `Bridge ${currentWing}${nextWing}`,
      })
    );
  }

  return rooms;
}

export function generateSmartLayouts(config: AutoGenerateConfig): Partial<Record<FloorId, Layout>> {
  const layouts = buildLayoutsFromTableBatches(profileBatches(config), config.width, config.height);
  const hallwayThickness = resolvedHallwayThickness(config);
  const floors = Array.from({ length: clamp(config.floorCount, 1, 10) }, (_, index) => (index + 1) as FloorId);

  floors.forEach((floorId) => {
    const layout = layouts[floorId];
    if (!layout) return;
    if (config.includeBridges && config.wingCount > 1) {
      layout.rooms.push(...buildBridges(layout, config.width, clamp(config.wingCount, 1, 5), floorId));
    }
    if (floorId === 1 && config.includeEntrance) {
      layout.rooms.push(buildEntrance(config.width));
    }
    if (config.includeWingBackgrounds) {
      layout.rooms.unshift(
        ...buildWingBackgrounds(layout, floorId, clamp(config.wingCount, 1, 5), config.width, config.height, config.wingLabelMode)
      );
    }
    layout.rooms = layout.rooms.map((room) => {
      if (room.kind !== "hallway" && room.kind !== "bridge") return room;
      if (!room.rect) return room;
      const isVertical = room.rect.h > room.rect.w;
      const centerX = room.rect.x + room.rect.w / 2;
      const centerY = room.rect.y + room.rect.h / 2;
      const nextRect = isVertical
        ? {
            ...room.rect,
            x: centerX - hallwayThickness / 2,
            w: hallwayThickness,
          }
        : {
            ...room.rect,
            y: centerY - hallwayThickness / 2,
            h: hallwayThickness,
          };
      return {
        ...room,
        rect: nextRect,
        label: room.label
          ? {
              ...room.label,
              x: nextRect.x + nextRect.w / 2,
              y: nextRect.y + nextRect.h / 2,
            }
          : room.label,
      };
    });
  });

  return layouts;
}

export function estimateGeneratedRooms(config: AutoGenerateConfig): number {
  return profileBatches(config).reduce((sum, batch) => {
    const extras = Number(batch.includeHallway) + Number(batch.includeStairs) + Number(batch.includeLounge);
    return sum + batch.count + extras;
  }, config.includeEntrance ? 1 : 0);
}

export function createDefaultAutoGenerateConfig(): AutoGenerateConfig {
  return {
    width: VIEWBOX.w,
    height: VIEWBOX.h,
    floorCount: 3,
    wingCount: 3,
    roomsPerWing: 8,
    roomScale: 100,
    profile: "academic",
    density: "medium",
    placementPattern: "double-loaded",
    offsetX: 0,
    offsetY: 0,
    includeBridges: true,
    includeHallways: true,
    includeWingBackgrounds: true,
    includeEntrance: true,
    includeLounges: true,
    hallwayThickness: 40,
    wingLabelMode: "wing",
    wingRoomScaleOverrides: {},
  };
}

export function createDefaultTableBatch(): TableBatchConfig {
  return {
    id: `batch-${Date.now()}`,
    floor: 1,
    wing: "A",
    roomType: "room",
    roomNamePrefix: "Classroom",
    roomIdPrefix: "A1",
    count: 8,
    startNumber: 1,
    sizePreset: "medium",
    pattern: "double-loaded",
    roomScale: 100,
    offsetX: 0,
    offsetY: 0,
    includeHallway: true,
    includeStairs: true,
    includeLounge: true,
  };
}
