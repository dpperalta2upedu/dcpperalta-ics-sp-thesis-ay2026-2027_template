import type { Layout, LayoutRoom, FloorId } from "../layout/layout.schema";
import {
  SPACE_TYPE_ROOM,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_STAIRS,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_BRIDGE,
} from "../constants/space_constants";

const GRID_SIZE = 40;
const snap = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE;

const WING_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

export interface GeneratorConfig {
  width: number;
  height: number;
  roomsPerWing: number;
  floorId: FloorId;
  wingSpacing: number;
  roomSizeVariation: "small" | "medium" | "large";
  roomShape: "rectangular" | "varied";
  includeFloorBackground: boolean;
  wingCount: number;
  hallwayCount: number;
  includeBridges: boolean;
}

const ROOM_SIZES: Record<string, { width: number; height: number }> = {
  small: { width: 80, height: 80 },
  medium: { width: 120, height: 80 },
  large: { width: 200, height: 80 },
};

const HALLWAY_THICKNESS = 24;
const STAIRS_WIDTH = 55;
const STAIRS_HEIGHT = 80;
const LOUNGE_WIDTH = 100;
const LOUNGE_HEIGHT = 80;

function generateRoomId(wing: string, floor: number, index: number): string {
  return `room-${wing}${floor}-${index}`;
}

function generateRoomName(type: string, wing: string, floor: number, index: number): string {
  const typeLabels: Record<string, string> = {
    room: "Office",
    lounge: "Lounge",
    stairs: "Stairs",
  };
  return `${typeLabels[type] || "Room"} ${wing}${floor}${index}`;
}

function generateWingRooms(
  wingX: number,
  wingY: number,
  wingWidth: number,
  wingHeight: number,
  wing: string,
  floor: number,
  roomCount: number,
  roomSizeVariation: string,
  roomShape: string = "rectangular"
): LayoutRoom[] {
  const rooms: LayoutRoom[] = [];
  const sizeConfig = ROOM_SIZES[roomSizeVariation] || ROOM_SIZES.medium;

  // Main hallway is in the center
  const hallwayY = snap(wingY + wingHeight / 2 - HALLWAY_THICKNESS / 2);

  // Add stairs at the beginning and end of wing
  const stairsPositions = [
    { x: wingX + snap(20), y: wingY + snap(30) },
    { x: wingX + wingWidth - STAIRS_WIDTH - snap(20), y: wingY + snap(30) },
  ];

  stairsPositions.forEach((pos, idx) => {
    rooms.push({
      id: `stairs-${wing}-${floor}-${idx + 1}`,
      floor: floor as FloorId,
      kind: SPACE_TYPE_STAIRS,
      wing: wing as any,
      rect: {
        x: snap(pos.x),
        y: snap(pos.y),
        w: STAIRS_WIDTH,
        h: STAIRS_HEIGHT,
      },
      label: {
        x: snap(pos.x) + STAIRS_WIDTH / 2,
        y: snap(pos.y) + STAIRS_HEIGHT / 2,
        text: `Stairs ${idx + 1}`,
      },
    });
  });

  // Add lounge in the middle
  const loungeX = snap(wingX + wingWidth / 2 - LOUNGE_WIDTH / 2);
  const loungeY = snap(wingY + snap(30));

  rooms.push({
    id: `lounge-${wing}-${floor}`,
    floor: floor as FloorId,
    kind: SPACE_TYPE_LOUNGE,
    wing: wing as any,
    rect: {
      x: loungeX,
      y: loungeY,
      w: LOUNGE_WIDTH,
      h: LOUNGE_HEIGHT,
    },
    label: {
      x: loungeX + LOUNGE_WIDTH / 2,
      y: loungeY + LOUNGE_HEIGHT / 2,
      text: "Lounge",
    },
  });

  // Generate rooms in left and right columns around the hallway
  const topAreaY = wingY + snap(120);
  const topAreaHeight = hallwayY - topAreaY - snap(10);
  const bottomAreaY = hallwayY + HALLWAY_THICKNESS + snap(10);
  const bottomAreaHeight = wingY + wingHeight - bottomAreaY - snap(20);

  const usableWidth = wingWidth - snap(60);
  const leftAreaX = wingX + snap(30);
  const leftAreaWidth = snap(usableWidth / 2 - 20);
  const rightAreaX = leftAreaX + leftAreaWidth + snap(40);
  const rightAreaWidth = leftAreaWidth;

  const areas = [
    { x: leftAreaX, y: topAreaY, width: leftAreaWidth, height: topAreaHeight, side: "left-top" },
    { x: rightAreaX, y: topAreaY, width: rightAreaWidth, height: topAreaHeight, side: "right-top" },
    { x: leftAreaX, y: bottomAreaY, width: leftAreaWidth, height: bottomAreaHeight, side: "left-bottom" },
    { x: rightAreaX, y: bottomAreaY, width: rightAreaWidth, height: bottomAreaHeight, side: "right-bottom" },
  ];

  let roomIndex = 0;
  const roomHeight = snap(sizeConfig.height);
  const roomWidth = snap(sizeConfig.width);

  // Distribute rooms across the four areas
  const roomsPerArea = Math.ceil(roomCount / 4);

  areas.forEach((area) => {
    let areaRoomCount = 0;
    let y = area.y;

    while (areaRoomCount < roomsPerArea && roomIndex < roomCount && y + roomHeight <= area.y + area.height) {
      const x = area.x + snap(5);

      if (x + roomWidth <= area.x + area.width) {
        const room: LayoutRoom = {
          id: generateRoomId(wing, floor, roomIndex),
          floor: floor as FloorId,
          kind: SPACE_TYPE_ROOM,
          wing: wing as any,
          rect: {
            x: snap(x),
            y: snap(y),
            w: roomWidth,
            h: roomHeight,
          },
          label: {
            x: snap(x) + roomWidth / 2,
            y: snap(y) + roomHeight / 2,
            text: generateRoomName(SPACE_TYPE_ROOM, wing, floor, roomIndex),
          },
        };

        // For varied shape, randomly add some L-shaped rooms
        if (roomShape === "varied" && Math.random() < 0.15) {
          const notchSize = snap(40);
          room.poly = {
            points: [
              { x: snap(x), y: snap(y) },
              { x: snap(x) + roomWidth, y: snap(y) },
              { x: snap(x) + roomWidth, y: snap(y) + roomHeight - notchSize },
              { x: snap(x) + snap(60), y: snap(y) + roomHeight - notchSize },
              { x: snap(x) + snap(60), y: snap(y) + roomHeight },
              { x: snap(x), y: snap(y) + roomHeight },
            ],
          };
          delete room.rect;
        }

        rooms.push(room);
        y = snap(y + roomHeight + snap(20));
        areaRoomCount++;
        roomIndex++;
      } else {
        break;
      }
    }
  });

  return rooms;
}

function generateHallways(
  wingX: number,
  wingY: number,
  wingWidth: number,
  wingHeight: number,
  wing: string,
  floor: number,
  hallwayCount: number = 1
): LayoutRoom[] {
  const hallways: LayoutRoom[] = [];
  const usableHeight = wingHeight - snap(100);

  if (hallwayCount === 0) {
    return hallways;
  }

  if (hallwayCount === 1) {
    // Single main horizontal hallway across the middle
    const hallwayY = snap(wingY + wingHeight / 2 - HALLWAY_THICKNESS / 2);
    hallways.push({
      id: `hallway-main-${wing}-${floor}`,
      floor: floor as FloorId,
      kind: SPACE_TYPE_HALLWAY,
      wing: wing as any,
      rect: {
        x: snap(wingX + 20),
        y: hallwayY,
        w: snap(wingWidth - 40),
        h: HALLWAY_THICKNESS,
      },
      label: {
        x: snap(wingX + wingWidth / 2),
        y: hallwayY + HALLWAY_THICKNESS / 2,
        text: `Hallway ${wing}`,
      },
    });
  } else if (hallwayCount === 2) {
    // Two horizontal hallways - one in upper third, one in lower third
    const hallwayY1 = snap(wingY + snap(100));
    const hallwayY2 = snap(wingY + wingHeight - snap(150));

    hallways.push({
      id: `hallway-1-${wing}-${floor}`,
      floor: floor as FloorId,
      kind: SPACE_TYPE_HALLWAY,
      wing: wing as any,
      rect: {
        x: snap(wingX + 20),
        y: hallwayY1,
        w: snap(wingWidth - 40),
        h: HALLWAY_THICKNESS,
      },
      label: {
        x: snap(wingX + wingWidth / 2),
        y: hallwayY1 + HALLWAY_THICKNESS / 2,
        text: `Hallway 1-${wing}`,
      },
    });

    hallways.push({
      id: `hallway-2-${wing}-${floor}`,
      floor: floor as FloorId,
      kind: SPACE_TYPE_HALLWAY,
      wing: wing as any,
      rect: {
        x: snap(wingX + 20),
        y: hallwayY2,
        w: snap(wingWidth - 40),
        h: HALLWAY_THICKNESS,
      },
      label: {
        x: snap(wingX + wingWidth / 2),
        y: hallwayY2 + HALLWAY_THICKNESS / 2,
        text: `Hallway 2-${wing}`,
      },
    });
  } else {
    // Three or more hallways - distribute evenly
    const hallwayCount_actual = Math.min(hallwayCount, 4);
    const spacing = usableHeight / (hallwayCount_actual + 1);

    for (let i = 0; i < hallwayCount_actual; i++) {
      const hallwayY = snap(wingY + snap(50) + (i + 1) * spacing - HALLWAY_THICKNESS / 2);
      hallways.push({
        id: `hallway-${i + 1}-${wing}-${floor}`,
        floor: floor as FloorId,
        kind: SPACE_TYPE_HALLWAY,
        wing: wing as any,
        rect: {
          x: snap(wingX + 20),
          y: hallwayY,
          w: snap(wingWidth - 40),
          h: HALLWAY_THICKNESS,
        },
        label: {
          x: snap(wingX + wingWidth / 2),
          y: hallwayY + HALLWAY_THICKNESS / 2,
          text: `Hallway ${i + 1}-${wing}`,
        },
      });
    }
  }

  return hallways;
}

function generateWingPositions(width: number, wingCount: number, wingSpacing: number): Record<string, { x: number; y: number }> {
  const wingWidth = snap((width - wingSpacing * 2) / wingCount);
  const wingPositions: Record<string, { x: number; y: number }> = {};

  for (let i = 0; i < Math.min(wingCount, WING_NAMES.length); i++) {
    const wing = WING_NAMES[i];
    const x = snap(wingSpacing + i * (wingWidth + wingSpacing));
    wingPositions[wing] = { x, y: snap(50) };
  }

  return wingPositions;
}

export function generateFloorLayout(config: GeneratorConfig): Layout {
  const { width, height, roomsPerWing, floorId, wingSpacing, roomSizeVariation, roomShape, includeFloorBackground, wingCount, hallwayCount, includeBridges } = config;

  const wingWidth = snap((width - wingSpacing * 2) / wingCount);
  const wingHeight = snap(height - 100);

  const wingPositions = generateWingPositions(width, wingCount, wingSpacing);
  const wingNames = Object.keys(wingPositions);

  const rooms: LayoutRoom[] = [];

  // Generate floor background (wing backgrounds) if enabled
  if (includeFloorBackground) {
    Object.entries(wingPositions).forEach(([wing, pos]) => {
      rooms.push({
        id: `wing-background-${wing}-${floorId}`,
        floor: floorId,
        kind: "wing_background",
        wing: wing as any,
        rect: {
          x: pos.x,
          y: pos.y,
          w: wingWidth,
          h: wingHeight,
          r: 10,
        },
      });
    });
  }

  // Generate rooms for each wing
  Object.entries(wingPositions).forEach(([wing, pos]) => {
    const wingRooms = generateWingRooms(
      pos.x,
      pos.y,
      wingWidth,
      wingHeight,
      wing,
      floorId,
      Math.max(2, Math.floor(roomsPerWing / 2)),
      roomSizeVariation,
      roomShape
    );
    rooms.push(...wingRooms);

    const hallways = generateHallways(pos.x, pos.y, wingWidth, wingHeight, wing, floorId, hallwayCount);
    rooms.push(...hallways);
  });

  // Add bridges between wings if enabled
  if (includeBridges && wingNames.length > 1) {
    const bridgeY = snap(height / 2);

    for (let i = 0; i < wingNames.length - 1; i++) {
      const currentWing = wingNames[i];
      const nextWing = wingNames[i + 1];
      const currentPos = wingPositions[currentWing];

      rooms.push({
        id: `bridge-${currentWing}${nextWing}-${floorId}`,
        floor: floorId,
        kind: SPACE_TYPE_BRIDGE,
        rect: {
          x: snap(currentPos.x + wingWidth),
          y: bridgeY,
          w: snap(wingSpacing),
          h: HALLWAY_THICKNESS * 2,
        },
        label: {
          x: snap(currentPos.x + wingWidth + wingSpacing / 2),
          y: bridgeY + HALLWAY_THICKNESS,
          text: `Bridge ${currentWing}${nextWing}`,
        },
      });
    }
  }

  return {
    version: 1,
    units: "px",
    viewBox: { w: width, h: height },
    grid: { size: GRID_SIZE },
    rooms,
  };
}

export function generateMultiFloorLayout(
  config: Omit<GeneratorConfig, "floorId">,
  floors: FloorId[]
): Record<FloorId, Layout> {
  const result: Record<FloorId, Layout> = {} as any;

  floors.forEach((floor) => {
    result[floor] = generateFloorLayout({ ...config, floorId: floor });
  });

  return result;
}

export function generateFloorNumbers(count: number): FloorId[] {
  const floors: FloorId[] = [];
  for (let i = 1; i <= Math.min(count, 10); i++) {
    if (i === 1 || i === 2 || i === 3) {
      floors.push(i as FloorId);
    }
  }
  return floors.length > 0 ? floors : [1];
}
