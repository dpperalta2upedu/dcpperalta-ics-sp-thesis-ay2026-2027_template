import {
  SPACE_TYPE_BRIDGE,
  SPACE_TYPE_ENTRANCE,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_ROOM,
  SPACE_TYPE_STAIRS,
} from "../constants/space_constants";

type SpaceType =
  | typeof SPACE_TYPE_ROOM
  | typeof SPACE_TYPE_LOUNGE
  | typeof SPACE_TYPE_STAIRS
  | typeof SPACE_TYPE_HALLWAY
  | typeof SPACE_TYPE_BRIDGE
  | typeof SPACE_TYPE_ENTRANCE;

export type Space = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  poly?: {
    points: Point[];
  };
  type: SpaceType;
  passable?: boolean;
  fill?: string;
  // connectsTo?: string[]; // for stairs
};

export type Point = { x: number; y: number };

export type Message = {
  text: string;
};
