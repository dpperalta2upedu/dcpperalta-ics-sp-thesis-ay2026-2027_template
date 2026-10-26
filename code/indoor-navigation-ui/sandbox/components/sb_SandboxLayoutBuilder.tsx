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
import SandboxFooter from "./sb_SandboxFooter";
import SandboxTopNavBar from "./sb_SandboxTopNavBar";
import LayoutAssistantModal from "./LayoutAssistantModal";
import LayoutGeneratorModal from "./LayoutGeneratorModal";
import { createDefaultAutoGenerateConfig } from "./layoutSmartBuilder";
import "../../src/assets/layout_builder.css";
import { sandboxFetch } from "../sb_api";
import {
  SANDBOX_MAIN_LAYOUT_BACKUP_SAVE_URL,
  SANDBOX_SERVICE_BASE_URL,
  getSandboxAuthState,
} from "../sb_auth";
import { AUTH_CHANGED_EVENT } from "../../src/utils/auth";
import {
  SPACE_TYPE_BRIDGE,
  SPACE_TYPE_ENTRANCE,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_ROOM,
  SPACE_TYPE_STAIRS,
} from "../../src/constants/space_constants";
import type { FloorId, Layout, LayoutPoint, LayoutRoom, LayoutRoomKind, WingId } from "../../src/layout/layout.schema";
import { cloneLayout } from "../../src/layout/layout.schema";
import {
  ROOM_STYLE_BY_WING,
  layoutToSvg,
  polyToFlatPoints,
  roomLabelPosition,
  roomStyle,
} from "../../src/layout/layout.renderers";
import type { Space } from "../../src/types/models";
import type { AutoGenerateConfig } from "./layoutSmartBuilder";

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
const MAP_LAYOUT_REFRESH_PENDING_KEY = "indoor-nav.sandbox.map-layout.refresh.pending";
const MAP_HISTORY_NAME_OVERRIDES_KEY = "indoor-nav.sandbox.map-history.name-overrides";
const CURRENT_SANDBOX_DRAFT_KEY = "sandbox-layout-svg-current";
const CURRENT_SANDBOX_FILENAME = "sandbox_map_layout.json";
const CURRENT_SANDBOX_LABEL = "Sandbox Layout - Current";
const CURRENT_SANDBOX_SOURCE_LABEL = "Current Sandbox Layout";
const BASE_FLOORS = [1, 2, 3] as const;
const WING_OPTIONS = ["A", "B", "C", "D", "E"] as const;
const ROOM_COLOR_OPTIONS = WING_OPTIONS.map((wing) => ({
  label: `Wing ${wing} color`,
  value: ROOM_STYLE_BY_WING[wing].fill,
}));

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
const COMPONENT_HIT_PADDING = 10;
const COMPONENT_HIT_STROKE_WIDTH = 24;
const PUBLISH_REQUEST_TIMEOUT_MS = 20000;
const UI_BACKUP_TIMEOUT_MS = 1500;
const SANDBOX_DRAFT_LIMIT = 15;
const ROOM_LABEL_PADDING_X = 6;
const ROOM_LABEL_PADDING_Y = 4;
const ROOM_LABEL_MAX_FONT_SIZE = 12;
const ROOM_LABEL_MIN_FONT_SIZE = 8;
const ROOM_LABEL_LINE_HEIGHT = 1.2;
const ROOM_LABEL_CHAR_WIDTH_FACTOR = 0.56;
const ROOM_COPY_OFFSET_STEP = GRID_SIZE;
const ROOM_COPY_SEARCH_LIMIT = 24;
const POLYGON_VERTEX_HIT_RADIUS = 7;
const REFERENCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read that file."));
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read that file."));
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load that image."));
    img.src = src;
  });
}

async function decodeTiffFileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const buffer = await readFileAsArrayBuffer(file);
  const { default: UTIF } = await import("utif");
  const ifds = UTIF.decode(buffer);
  const firstIfd = ifds[0];
  if (!firstIfd) {
    throw new Error("No image found in that TIFF file.");
  }
  UTIF.decodeImage(buffer, firstIfd, ifds);
  const rgba = UTIF.toRGBA8(firstIfd);
  const canvas = document.createElement("canvas");
  canvas.width = firstIfd.width;
  canvas.height = firstIfd.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not decode that TIFF file.");
  }
  const imageData = ctx.createImageData(firstIfd.width, firstIfd.height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function decodePdfFirstPageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const buffer = await readFileAsArrayBuffer(file);
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not render that PDF file.");
  }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function decodeFloorPlanFile(file: File): Promise<{ src: string; image: HTMLImageElement }> {
  const lowerName = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
  const isTiff = file.type === "image/tiff" || /\.tiff?$/i.test(lowerName);

  if (isPdf) {
    const canvas = await decodePdfFirstPageToCanvas(file);
    const src = canvas.toDataURL("image/png");
    return { src, image: await loadImageFromSrc(src) };
  }
  if (isTiff) {
    const canvas = await decodeTiffFileToCanvas(file);
    const src = canvas.toDataURL("image/png");
    return { src, image: await loadImageFromSrc(src) };
  }
  const src = await readFileAsDataUrl(file);
  return { src, image: await loadImageFromSrc(src) };
}

type DetectedRoomBox = { x: number; y: number; w: number; h: number };

// Otsu's method: picks the luminance cutoff that best separates "wall ink" from
// "open floor" pixels instead of assuming a fixed brightness for every floor plan.
function computeOtsuThreshold(histogram: Float64Array, totalPixels: number): number {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];
  let sumB = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;
    sumB += t * histogram[t];
    const meanBackground = sumB / weightBackground;
    const meanForeground = (sumAll - sumB) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

type GridPoint = { x: number; y: number };
type DetectedRegion = { box: DetectedRoomBox };

// Fills in small enclosed dark marks (text, furniture symbols, door-swing arcs) that
// don't touch the image border before room detection runs, so they can't be mistaken for
// walls or split a room into spurious extra pieces. Real walls are long and/or reach the
// page edge; clutter like this is small and floats inside open space.
function fillSmallWallHoles(open: Uint8Array, w: number, h: number, maxHoleAreaPx: number): Uint8Array {
  const result = open.slice();
  const wallLabels = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  let nextLabel = 0;

  for (let start = 0; start < w * h; start++) {
    if (open[start] || wallLabels[start] !== -1) continue;
    const label = nextLabel++;
    let touchesBorder = false;
    let area = 0;
    const pixels: number[] = [];
    wallLabels[start] = label;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      pixels.push(idx);
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesBorder = true;
      if (x > 0) {
        const n = idx - 1;
        if (!open[n] && wallLabels[n] === -1) {
          wallLabels[n] = label;
          stack.push(n);
        }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (!open[n] && wallLabels[n] === -1) {
          wallLabels[n] = label;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (!open[n] && wallLabels[n] === -1) {
          wallLabels[n] = label;
          stack.push(n);
        }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (!open[n] && wallLabels[n] === -1) {
          wallLabels[n] = label;
          stack.push(n);
        }
      }
    }
    if (!touchesBorder && area <= maxHoleAreaPx) {
      for (const idx of pixels) result[idx] = 1;
    }
  }
  return result;
}

// A pixel survives erosion only if it and all 4 of its neighbors are foreground - this
// strips thin 1-2px-wide protrusions (e.g. a door-gap leaking into a hallway) that the
// hole-filling pass above doesn't catch because they touch the open region itself rather
// than being fully enclosed by it.
function erodeMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      const okLeft = x === 0 || mask[idx - 1];
      const okRight = x === w - 1 || mask[idx + 1];
      const okUp = y === 0 || mask[idx - w];
      const okDown = y === h - 1 || mask[idx + w];
      out[idx] = okLeft && okRight && okUp && okDown ? 1 : 0;
    }
  }
  return out;
}

// Grows foreground back out by 1px so morphological opening (erode then dilate) removes
// thin spurs/noise without permanently shrinking the rooms that survive it.
function dilateMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx]) {
        out[idx] = 1;
        continue;
      }
      const anyLeft = x > 0 && mask[idx - 1];
      const anyRight = x < w - 1 && mask[idx + 1];
      const anyUp = y > 0 && mask[idx - w];
      const anyDown = y < h - 1 && mask[idx + w];
      out[idx] = anyLeft || anyRight || anyUp || anyDown ? 1 : 0;
    }
  }
  return out;
}

type DoorSplitResult = {
  pieceCount: number;
  labelByPixel: Map<number, number>;
  seamGroups: Map<string, number[]>;
};

// A doorway is a gap in a wall, so the two rooms either side of it flood-fill into one
// connected blob instead of two closed rooms. This re-separates such a blob: erode it
// hard enough that the narrow doorway neck disappears while the (much wider) room bodies
// survive as separate seed pieces, then grow each seed back out to its true extent via a
// multi-source BFS constrained to the original blob - the doorway neck pixels get divided
// between the two regrown pieces, closing both rooms off near where the gap was. Returns
// null if erosion didn't actually separate the blob (i.e. it really is one room).
function attemptDoorSplit(
  labels: Int32Array,
  w: number,
  h: number,
  lightLabel: number,
  bbox: { x: number; y: number; w: number; h: number },
  erosionRadius: number
): DoorSplitResult | null {
  const inComponent = (idx: number) => labels[idx] === lightLabel;

  let mask: Uint8Array = new Uint8Array(w * h);
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * w + x;
      if (inComponent(idx)) mask[idx] = 1;
    }
  }
  for (let i = 0; i < erosionRadius; i++) mask = erodeMask(mask, w, h);

  const seedPiece = new Int32Array(w * h).fill(-1);
  let pieceCount = 0;
  const seedStack: number[] = [];
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || seedPiece[idx] !== -1) continue;
      const pieceId = pieceCount++;
      seedPiece[idx] = pieceId;
      seedStack.push(idx);
      while (seedStack.length) {
        const cur = seedStack.pop()!;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0 && mask[cur - 1] && seedPiece[cur - 1] === -1) {
          seedPiece[cur - 1] = pieceId;
          seedStack.push(cur - 1);
        }
        if (cx < w - 1 && mask[cur + 1] && seedPiece[cur + 1] === -1) {
          seedPiece[cur + 1] = pieceId;
          seedStack.push(cur + 1);
        }
        if (cy > 0 && mask[cur - w] && seedPiece[cur - w] === -1) {
          seedPiece[cur - w] = pieceId;
          seedStack.push(cur - w);
        }
        if (cy < h - 1 && mask[cur + w] && seedPiece[cur + w] === -1) {
          seedPiece[cur + w] = pieceId;
          seedStack.push(cur + w);
        }
      }
    }
  }

  if (pieceCount < 2) return null;

  const finalPiece = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * w + x;
      if (seedPiece[idx] !== -1) {
        finalPiece[idx] = seedPiece[idx];
        queue.push(idx);
      }
    }
  }
  let qHead = 0;
  while (qHead < queue.length) {
    const cur = queue[qHead++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const pieceId = finalPiece[cur];
    const expand = (nIdx: number) => {
      if (inComponent(nIdx) && finalPiece[nIdx] === -1) {
        finalPiece[nIdx] = pieceId;
        queue.push(nIdx);
      }
    };
    if (cx > 0) expand(cur - 1);
    if (cx < w - 1) expand(cur + 1);
    if (cy > 0) expand(cur - w);
    if (cy < h - 1) expand(cur + w);
  }

  const labelByPixel = new Map<number, number>();
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * w + x;
      if (!inComponent(idx)) continue;
      // Any pixel the BFS never reached (shouldn't normally happen) folds into piece 0
      // rather than being dropped.
      labelByPixel.set(idx, finalPiece[idx] === -1 ? 0 : finalPiece[idx]);
    }
  }

  const seamGroups = new Map<string, number[]>();
  const recordSeam = (idxA: number, idxB: number) => {
    const pieceA = labelByPixel.get(idxA)!;
    const pieceB = labelByPixel.get(idxB)!;
    if (pieceA === pieceB) return;
    const key = pieceA < pieceB ? `${pieceA}_${pieceB}` : `${pieceB}_${pieceA}`;
    let list = seamGroups.get(key);
    if (!list) {
      list = [];
      seamGroups.set(key, list);
    }
    list.push(idxA, idxB);
  };
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const idx = y * w + x;
      if (!inComponent(idx)) continue;
      if (x + 1 < w && inComponent(idx + 1)) recordSeam(idx, idx + 1);
      if (y + 1 < h && inComponent(idx + w)) recordSeam(idx, idx + w);
    }
  }

  return { pieceCount, labelByPixel, seamGroups };
}

// Best-effort room detection: treats dark pixels as wall ink and light pixels as open
// floor. Small enclosed marks (text/furniture/door arcs) are filled in first, then a
// light morphological opening removes residual thin noise, then enclosed open regions
// are found via flood fill and reported as their axis-aligned bounding box, so every
// detected room renders as a clean rectangle regardless of how raggedly its walls were
// drawn/scanned. Doorway gaps are still detected separately (see attemptDoorSplit) and
// reported as door lines alongside the room boxes.
type FloorPlanDetectionResult = { regions: DetectedRegion[]; doorLines: [GridPoint, GridPoint][] };

function detectRoomBoxesFromImage(image: HTMLImageElement, maxDimension = 1400): FloorPlanDetectionResult {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { regions: [], doorLines: [] };
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const luminance = new Uint8ClampedArray(w * h);
  const histogram = new Float64Array(256);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const value = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
    luminance[i] = value;
    histogram[value] += 1;
  }
  const threshold = computeOtsuThreshold(histogram, w * h);

  let open: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    open[i] = luminance[i] >= threshold ? 1 : 0;
  }
  open = fillSmallWallHoles(open, w, h, (w * h) / 3000);
  open = dilateMask(erodeMask(open, w, h), w, h);

  const labels = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  const boxes: DetectedRoomBox[] = [];
  const areas: number[] = [];
  let nextLabel = 0;

  for (let start = 0; start < w * h; start++) {
    if (!open[start] || labels[start] !== -1) continue;
    const label = nextLabel++;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) {
        const n = idx - 1;
        if (open[n] && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (x < w - 1) {
        const n = idx + 1;
        if (open[n] && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (open[n] && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y < h - 1) {
        const n = idx + w;
        if (open[n] && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    areas.push(area);
  }

  if (!boxes.length) return { regions: [], doorLines: [] };

  // The single largest open region is assumed to be the page background / exterior,
  // not a room - exclude it. Small leftover specks are filtered by area.
  let largestIndex = 0;
  for (let i = 1; i < areas.length; i++) {
    if (areas[i] > areas[largestIndex]) largestIndex = i;
  }
  const minAreaPx = (w * h) / 2500;
  const doorErosionRadius = 5; // in downscaled-image pixels; wider gaps won't be split

  // Try to re-separate any room+hallway/room+room blobs that merged through a doorway
  // gap before tracing shapes, so the traced rooms come out closed instead of fused.
  const retiredLabels = new Set<number>();
  const doorLinesPx: [GridPoint, GridPoint][] = [];
  const originalLabelCount = boxes.length;
  for (let label = 0; label < originalLabelCount; label++) {
    if (label === largestIndex || areas[label] < minAreaPx) continue;
    const split = attemptDoorSplit(labels, w, h, label, boxes[label], doorErosionRadius);
    if (!split) continue;

    const pieceBounds = Array.from({ length: split.pieceCount }, () => ({
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      area: 0,
    }));
    const baseNewLabel = nextLabel;
    nextLabel += split.pieceCount;
    for (const [idx, pieceId] of split.labelByPixel) {
      const x = idx % w;
      const y = (idx - x) / w;
      const bounds = pieceBounds[pieceId];
      if (x < bounds.minX) bounds.minX = x;
      if (x > bounds.maxX) bounds.maxX = x;
      if (y < bounds.minY) bounds.minY = y;
      if (y > bounds.maxY) bounds.maxY = y;
      bounds.area += 1;
      labels[idx] = baseNewLabel + pieceId;
    }
    for (const bounds of pieceBounds) {
      boxes.push({ x: bounds.minX, y: bounds.minY, w: bounds.maxX - bounds.minX + 1, h: bounds.maxY - bounds.minY + 1 });
      areas.push(bounds.area);
    }
    retiredLabels.add(label);

    for (const seamPixels of split.seamGroups.values()) {
      if (seamPixels.length < 2) continue;
      const seamPoints = seamPixels.map((idx): GridPoint => ({ x: idx % w, y: Math.floor(idx / w) }));
      let maxDist = -1;
      let bestA: GridPoint = seamPoints[0];
      let bestB: GridPoint = seamPoints[0];
      for (let i = 0; i < seamPoints.length; i++) {
        for (let j = i + 1; j < seamPoints.length; j++) {
          const dist = Math.hypot(seamPoints[i].x - seamPoints[j].x, seamPoints[i].y - seamPoints[j].y);
          if (dist > maxDist) {
            maxDist = dist;
            bestA = seamPoints[i];
            bestB = seamPoints[j];
          }
        }
      }
      doorLinesPx.push([bestA, bestB]);
    }
  }

  const inverseScale = 1 / scale;
  const results: DetectedRegion[] = [];

  for (let label = 0; label < boxes.length; label++) {
    if (label === largestIndex || retiredLabels.has(label) || areas[label] < minAreaPx) continue;
    const box = boxes[label];
    const worldBox: DetectedRoomBox = {
      x: box.x * inverseScale,
      y: box.y * inverseScale,
      w: box.w * inverseScale,
      h: box.h * inverseScale,
    };

    results.push({ box: worldBox });
  }

  const doorLines: [GridPoint, GridPoint][] = doorLinesPx.map(([a, b]) => [
    { x: a.x * inverseScale, y: a.y * inverseScale },
    { x: b.x * inverseScale, y: b.y * inverseScale },
  ]);

  return { regions: results, doorLines };
}

const normalizeHexColor = (value?: string | null): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await sandboxFetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

type FloorSource = {
  wingBackgrounds?: Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>;
  routingHallways?: Space[];
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

function normalizeFloorSource(source: unknown): FloorSource {
  if (!source || typeof source !== "object") {
    return emptyFloorSource();
  }

  const candidate = source as Partial<FloorSource>;
  const fallback = emptyFloorSource();

  return {
    wingBackgrounds: candidate.wingBackgrounds,
    wings: {
      A: Array.isArray(candidate.wings?.A) ? candidate.wings.A : fallback.wings.A,
      B: Array.isArray(candidate.wings?.B) ? candidate.wings.B : fallback.wings.B,
      C: Array.isArray(candidate.wings?.C) ? candidate.wings.C : fallback.wings.C,
    },
    bridges: {
      AB:
        candidate.bridges && typeof candidate.bridges === "object" && candidate.bridges.AB
          ? candidate.bridges.AB
          : fallback.bridges.AB,
      BC:
        candidate.bridges && typeof candidate.bridges === "object" && candidate.bridges.BC
          ? candidate.bridges.BC
          : fallback.bridges.BC,
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

const buildDraftOptionKey = (filename: string): string => `sandbox-draft-${filename}`;
const buildMapHistoryOptionKey = (filename: string): string => `sandbox-map-history-${filename}`;

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
  id?: number;
  filename: string;
  displayName?: string;
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
        ? {
            points: space.poly.points.map((point) => ({ x: point.x, y: point.y })),
          }
        : undefined,
      label: {
        x: space.poly?.points?.length ? roomLabelPosition({
          id: space.id,
          floor: floor as FloorId,
          kind: spaceTypeToLayoutKind(space.type),
          poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
        }).x : space.x + space.width / 2,
        y: space.poly?.points?.length ? roomLabelPosition({
          id: space.id,
          floor: floor as FloorId,
          kind: spaceTypeToLayoutKind(space.type),
          poly: { points: space.poly.points.map((point) => ({ x: point.x, y: point.y })) },
        }).y : space.y + space.height / 2,
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
  WING_OPTIONS.forEach((wing) => {
    const rect = wingBackgrounds[wing];
    if (!rect) return;
    rooms.push({
      id: `wing-background-${wing.toLowerCase()}-${floor}`,
      floor: floor as FloorId,
      kind: "wing_background" as const,
      wing,
      wingName: formatWingName(wing),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, r: rect.r },
      label: {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: wingBackgroundLabel(wing, formatWingName(wing)),
      },
    });
  });
  return rooms;
}

function mapLayoutToLayoutsByFloor(mapLayout: unknown): LayoutsByFloor {
  const safeMap = isCanonicalMapLayout(mapLayout) ? mapLayout : fallbackCanonicalLayout();
  const f1 = normalizeFloorSource(safeMap.floors["1"]);
  const f2 = normalizeFloorSource(safeMap.floors["2"]);
  const f3 = normalizeFloorSource(safeMap.floors["3"]);
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

function formatLayoutKindLabel(kind: LayoutRoomKind): string {
  if (kind === "wing_background") return "Wing Background";
  return kind.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function componentPickerLabel(room: LayoutRoom): string {
  const name = room.label?.text?.trim() || room.id;
  const kindLabel = formatLayoutKindLabel(room.kind);
  return name === room.id ? `${name} - ${kindLabel}` : `${name} - ${kindLabel} [${room.id}]`;
}

function wingBackgroundLabel(wing: WingId, wingName?: string): string {
  const trimmedWingName = wingName?.trim();
  return `${trimmedWingName || formatWingName(wing)} Background`;
}

function formatWingName(wing: WingId): string {
  return `Wing ${wing}`;
}

function parseWingNameInput(value: string): WingId | null {
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase();
  if (normalized === "A" || normalized === "WING A") return "A";
  if (normalized === "B" || normalized === "WING B") return "B";
  if (normalized === "C" || normalized === "WING C") return "C";
  if (normalized === "D" || normalized === "WING D") return "D";
  if (normalized === "E" || normalized === "WING E") return "E";
  return null;
}

function normalizeWingNameInput(value: string): string | undefined {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  const parsedWing = parseWingNameInput(trimmed);
  return parsedWing ? formatWingName(parsedWing) : trimmed;
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
  const defaultWingName = kind === "wing_background" && defaultWing ? formatWingName(defaultWing) : undefined;
  const nextLabel = kind === "wing_background" && defaultWing ? wingBackgroundLabel(defaultWing, defaultWingName) : labelText;
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

function ensureBaseFloors(layouts: LayoutsByFloor, canonicalMapLayout: CanonicalMapLayout): LayoutsByFloor {
  const next = cloneLayoutsByFloor(layouts);
  const emptyLayouts = createEmptyLayoutsFromCanonical(canonicalMapLayout);
  BASE_FLOORS.forEach((floorNum) => {
    if (!next[floorNum]) {
      next[floorNum] = cloneLayout(emptyLayouts[floorNum]);
    }
  });
  return next;
}

function loadDefaults(): LayoutsByFloor {
  return mapLayoutToLayoutsByFloor(CANONICAL_MAP_LAYOUT);
}

async function fetchJsonFromEndpoints<T>(endpoints: string[]): Promise<T | null> {
  for (const endpoint of Array.from(new Set(endpoints))) {
    try {
      const res = await sandboxFetch(endpoint);
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
  const metersPerCell = Number.isFinite(rawMpc) && rawMpc > 0 ? rawMpc : undefined;

  const groups = Array.from(doc.querySelectorAll("g[data-room-id]"));
  const rooms: LayoutRoom[] = groups.map((g) => {
    const id = g.getAttribute("data-room-id") ?? `room-${Date.now()}`;
    const kind = (g.getAttribute("data-kind") as LayoutRoomKind) ?? "room";
    const wing = ((g.getAttribute("data-wing") ?? undefined) as WingId | undefined) ?? undefined;
    const wingName = normalizeWingNameInput(g.getAttribute("data-wing-name") ?? "");
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
    metersPerCell,
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

function hallwayLabelForSlot(slot: "a" | "b" | "c" | "vertical"): string {
  if (slot === "a") return "Hallway A";
  if (slot === "b") return "Hallway B";
  if (slot === "c") return "Hallway C";
  return "";
}

function hallwayLabelForId(id: string, floor: BuilderFloor): string {
  if (id === routingHallwayIdForSlot(floor, "a")) return hallwayLabelForSlot("a");
  if (id === routingHallwayIdForSlot(floor, "b")) return hallwayLabelForSlot("b");
  if (id === routingHallwayIdForSlot(floor, "c")) return hallwayLabelForSlot("c");
  if (id === routingHallwayIdForSlot(floor, "vertical")) return hallwayLabelForSlot("vertical");
  return id;
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

function parseRequestedRoomCount(prompt: string): number {
  const digitMatch = prompt.match(/\b(\d+)\b/);
  if (digitMatch) {
    const parsed = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, 10);
    }
  }

  const wordToCount: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (const [word, count] of Object.entries(wordToCount)) {
    if (new RegExp(`\\b${word}\\b`).test(prompt)) {
      return count;
    }
  }

  return 1;
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

function inferWingForAutoHallway(layout: Layout, room: LayoutRoom): "A" | "B" | "C" | null {
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

  const bounds = roomBounds(room);
  if (!bounds) return null;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const wingBackgrounds = layout.rooms
    .filter((candidate) => candidate.kind === "wing_background" && (candidate.wing === "A" || candidate.wing === "B" || candidate.wing === "C"))
    .map((candidate) => ({ wing: candidate.wing as "A" | "B" | "C", bounds: roomBounds(candidate) }))
    .filter((candidate): candidate is { wing: "A" | "B" | "C"; bounds: NonNullable<ReturnType<typeof roomBounds>> } => Boolean(candidate.bounds));

  const containingWing = wingBackgrounds.find(
    (candidate) =>
      centerX >= candidate.bounds.x &&
      centerX <= candidate.bounds.x + candidate.bounds.width &&
      centerY >= candidate.bounds.y &&
      centerY <= candidate.bounds.y + candidate.bounds.height
  );
  if (containingWing) {
    return containingWing.wing;
  }

  // When wing backgrounds exist, only rooms physically inside a slab should
  // influence generated hallway/circulation geometry for that wing.
  if (wingBackgrounds.length) {
    return null;
  }

  let nearestWing: "A" | "B" | "C" | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  wingBackgrounds.forEach((candidate) => {
    const clampedX = Math.max(candidate.bounds.x, Math.min(centerX, candidate.bounds.x + candidate.bounds.width));
    const clampedY = Math.max(candidate.bounds.y, Math.min(centerY, candidate.bounds.y + candidate.bounds.height));
    const distance = Math.hypot(centerX - clampedX, centerY - clampedY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestWing = candidate.wing;
    }
  });
  if (nearestWing) {
    return nearestWing;
  }

  return null;
}

function deriveWingCorridor(
  layout: Layout,
  wing: "A" | "B" | "C"
): { x: number; w: number; centerY: number } | null {
  const boxes = layout.rooms
    .filter((room) => inferWingForAutoHallway(layout, room) === wing)
    .map((room) => roomBounds(room))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds));
  if (boxes.length < 2) return null;

  const sortedBoxes = [...boxes].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  let bestCorridor:
    | {
        topRow: typeof sortedBoxes;
        bottomRow: typeof sortedBoxes;
        gap: number;
        support: number;
      }
    | null = null;

  for (let i = 0; i < sortedBoxes.length - 1; i += 1) {
    const topRow = sortedBoxes.slice(0, i + 1);
    const bottomRow = sortedBoxes.slice(i + 1);
    if (!topRow.length || !bottomRow.length) continue;
    const topBottomEdge = Math.max(...topRow.map((bounds) => bounds.y + bounds.height));
    const bottomTopEdge = Math.min(...bottomRow.map((bounds) => bounds.y));
    const gap = bottomTopEdge - topBottomEdge;
    if (gap < AUTO_HALLWAY_MIN_ROW_GAP) continue;

    const support = Math.min(topRow.length, bottomRow.length);
    if (
      !bestCorridor ||
      support > bestCorridor.support ||
      (support === bestCorridor.support && gap > bestCorridor.gap)
    ) {
      bestCorridor = { topRow, bottomRow, gap, support };
    }
  }

  if (!bestCorridor) return null;

  const topBottomEdge = Math.max(...bestCorridor.topRow.map((bounds) => bounds.y + bounds.height));
  const bottomTopEdge = Math.min(...bestCorridor.bottomRow.map((bounds) => bounds.y));
  const centerY = (topBottomEdge + bottomTopEdge) / 2;
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
      label: hallwayLabelForSlot(slot),
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
    if (bottom - top >= AUTO_HALLWAY_THICKNESS * 2) {
      const routingId = routingHallwayIdForSlot(floor, "vertical");
      overlays.push({
        id: routingId,
        label: hallwayLabelForSlot("vertical"),
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
          label: { ...(nextRoom.label ?? roomLabelPosition(nextRoom)), text: hallwayLabelForId(mappedId, floor) },
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

function isGeneratedHallwayId(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    normalized.startsWith("hallway_wing_") ||
    normalized.startsWith("vertical_hallway_") ||
    normalized.startsWith("hallway-auto-") ||
    normalized.startsWith("hall_")
  );
}

function hallwayLooksSmallOrIrregular(
  room: LayoutRoom,
  expected?: AutoHallwayOverlay
): boolean {
  if (!room.rect) return false;
  const thickness = Math.min(room.rect.w, room.rect.h);
  const length = Math.max(room.rect.w, room.rect.h);
  const isExpectedVertical = expected ? expected.h > expected.w : room.rect.h > room.rect.w;
  const expectedThickness = expected ? Math.min(expected.w, expected.h) : AUTO_HALLWAY_THICKNESS;
  const expectedLength = expected ? Math.max(expected.w, expected.h) : null;

  if (thickness <= Math.max(4, Math.floor(expectedThickness * 0.45))) {
    return true;
  }
  if (thickness < expectedThickness - HALLWAY_RESIZE_SNAP * 2) {
    return true;
  }
  if (expectedLength !== null && length < expectedLength * 0.72) {
    return true;
  }
  if (expected) {
    const isRoomVertical = room.rect.h > room.rect.w;
    if (isRoomVertical !== isExpectedVertical) {
      return true;
    }
  }

  return false;
}

function hallwayLooksLikeGeneratedRoutingStrip(room: LayoutRoom): boolean {
  if (room.kind !== "hallway") return false;
  const normalizedId = room.id.trim().toLowerCase();
  const normalizedLabel = (room.label?.text ?? "").trim().toLowerCase();
  if (!normalizedId || !isGeneratedHallwayId(normalizedId)) return false;
  return normalizedLabel === normalizedId;
}

function hallwayRectOverlapArea(a: NonNullable<LayoutRoom["rect"]>, b: NonNullable<LayoutRoom["rect"]>): number {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  return overlapW * overlapH;
}

function findMisalignedHallwayIdsForLayouts(layouts: LayoutsByFloor): string[] {
  const ids = new Set<string>();
  const floors = sortedFloorNumbersFromLayouts(layouts);

  floors.forEach((floorNum) => {
    const floor = floorNum as BuilderFloor;
    const layout = layouts[floor];
    if (!layout) return;
    const normalized = normalizeRoutingHallwayRooms(layout, floor);
    const expectedById = new Map(
      deriveAutoHallwayOverlays(normalized, floor).map((overlay) => [overlay.id, overlay])
    );

    normalized.rooms.forEach((room) => {
      if (room.kind !== "hallway" || !room.rect) return;
      if (hallwayLooksLikeGeneratedRoutingStrip(room)) {
        ids.add(room.id);
        return;
      }
      const expected = expectedById.get(room.id);
      if (!expected) {
        if (isGeneratedHallwayId(room.id)) {
          ids.add(room.id);
        }
        return;
      }

      if (hallwayLooksSmallOrIrregular(room, expected)) {
        ids.add(room.id);
        return;
      }

      const delta = Math.max(
        Math.abs(room.rect.x - expected.x),
        Math.abs(room.rect.y - expected.y),
        Math.abs(room.rect.w - expected.w),
        Math.abs(room.rect.h - expected.h)
      );
      if (delta > HALLWAY_RESIZE_SNAP) {
        ids.add(room.id);
      }
    });

    const hallwayRooms = normalized.rooms.filter((room) => room.kind === "hallway" && room.rect);
    const bridgeRooms = normalized.rooms.filter((room) => room.kind === "bridge" && room.rect);

    hallwayRooms.forEach((hallway) => {
      const hallwayRect = hallway.rect;
      if (!hallwayRect) return;
      const hallwayArea = hallwayRect.w * hallwayRect.h;
      if (hallwayArea <= 0) return;

      bridgeRooms.forEach((bridge) => {
        const bridgeRect = bridge.rect;
        if (!bridgeRect) return;
        const overlapArea = hallwayRectOverlapArea(hallwayRect, bridgeRect);
        if (overlapArea <= 0) return;

        const overlapRatio = overlapArea / hallwayArea;
        const verticallyOffset =
          hallwayRect.w >= hallwayRect.h &&
          Math.abs(hallwayRect.y - bridgeRect.y) >= HALLWAY_RESIZE_SNAP;

        if (overlapRatio >= 0.25 && verticallyOffset) {
          ids.add(hallway.id);
        }
      });
    });

    for (let index = 0; index < hallwayRooms.length; index += 1) {
      const current = hallwayRooms[index];
      const currentRect = current.rect;
      if (!currentRect) continue;
      for (let otherIndex = index + 1; otherIndex < hallwayRooms.length; otherIndex += 1) {
        const other = hallwayRooms[otherIndex];
        const otherRect = other.rect;
        if (!otherRect) continue;

        const overlapArea = hallwayRectOverlapArea(currentRect, otherRect);
        if (overlapArea <= 0) continue;

        const currentArea = currentRect.w * currentRect.h;
        const otherArea = otherRect.w * otherRect.h;
        const smallerArea = Math.min(currentArea, otherArea);
        if (smallerArea <= 0 || overlapArea < smallerArea * 0.35) continue;

        const sameOrientation = (currentRect.w >= currentRect.h) === (otherRect.w >= otherRect.h);
        if (!sameOrientation) continue;

        const currentExpected = expectedById.get(current.id);
        const otherExpected = expectedById.get(other.id);
        const currentDelta = currentExpected
          ? Math.max(
              Math.abs(currentRect.x - currentExpected.x),
              Math.abs(currentRect.y - currentExpected.y),
              Math.abs(currentRect.w - currentExpected.w),
              Math.abs(currentRect.h - currentExpected.h)
            )
          : Number.POSITIVE_INFINITY;
        const otherDelta = otherExpected
          ? Math.max(
              Math.abs(otherRect.x - otherExpected.x),
              Math.abs(otherRect.y - otherExpected.y),
              Math.abs(otherRect.w - otherExpected.w),
              Math.abs(otherRect.h - otherExpected.h)
            )
          : Number.POSITIVE_INFINITY;
        const currentPenalty =
          (hallwayLooksSmallOrIrregular(current, currentExpected) ? 1000 : 0) +
          (hallwayLooksLikeGeneratedRoutingStrip(current) ? 500 : 0) +
          currentDelta;
        const otherPenalty =
          (hallwayLooksSmallOrIrregular(other, otherExpected) ? 1000 : 0) +
          (hallwayLooksLikeGeneratedRoutingStrip(other) ? 500 : 0) +
          otherDelta;

        if (currentPenalty === otherPenalty) {
          const isHorizontal = currentRect.w >= currentRect.h && otherRect.w >= otherRect.h;
          if (isHorizontal && Math.abs(currentRect.y - otherRect.y) >= HALLWAY_RESIZE_SNAP) {
            ids.add(currentRect.y <= otherRect.y ? current.id : other.id);
          } else {
            ids.add(currentArea <= otherArea ? current.id : other.id);
          }
        } else {
          ids.add(currentPenalty > otherPenalty ? current.id : other.id);
        }
      }
    }
  });

  return Array.from(ids);
}

function inferWingForBackgroundCoverage(layout: Layout, room: LayoutRoom): "A" | "B" | "C" | null {
  if (room.kind === "bridge" || room.kind === "entrance" || room.kind === "wing_background") {
    return null;
  }
  if (room.kind !== "hallway") {
    return inferWingForAutoHallway(layout, room);
  }

  const hallwayText = `${room.id} ${room.label?.text ?? ""}`.toLowerCase();
  if (/\bhallway\s*a\b/.test(hallwayText) || /\bwing[_\s-]*a\b/.test(hallwayText)) return "A";
  if (/\bhallway\s*b\b/.test(hallwayText) || /\bwing[_\s-]*b\b/.test(hallwayText)) return "B";
  if (/\bhallway\s*c\b/.test(hallwayText) || /\bwing[_\s-]*c\b/.test(hallwayText)) return "C";

  const bounds = roomBounds(room);
  if (!bounds) return null;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const wingCandidates = layout.rooms
    .filter((candidate) => candidate.kind !== "hallway" && candidate.kind !== "bridge" && candidate.kind !== "entrance")
    .map((candidate) => ({
      wing: inferWingForAutoHallway(layout, candidate),
      bounds: roomBounds(candidate),
    }))
    .filter(
      (candidate): candidate is { wing: "A" | "B" | "C"; bounds: NonNullable<ReturnType<typeof roomBounds>> } =>
        Boolean(candidate.wing && candidate.bounds)
    );

  let nearestWing: "A" | "B" | "C" | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  wingCandidates.forEach((candidate) => {
    const clampedX = Math.max(candidate.bounds.x, Math.min(centerX, candidate.bounds.x + candidate.bounds.width));
    const clampedY = Math.max(candidate.bounds.y, Math.min(centerY, candidate.bounds.y + candidate.bounds.height));
    const distance = Math.hypot(centerX - clampedX, centerY - clampedY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestWing = candidate.wing;
    }
  });

  return nearestWing;
}

function deriveWingBackgroundRoomsForLayout(layout: Layout): LayoutRoom[] {
  const viewWidth = layout.viewBox.w || CANONICAL_MAP_LAYOUT.viewBox.w;
  const viewHeight = layout.viewBox.h || CANONICAL_MAP_LAYOUT.viewBox.h;
  const wingBounds = new Map<"A" | "B" | "C", { minX: number; minY: number; maxX: number; maxY: number }>();
  const floor = (layout.rooms[0]?.floor ?? 1) as BuilderFloor;

  const extendWingBounds = (wing: "A" | "B" | "C", bounds: { x: number; y: number; width: number; height: number }) => {
    const existing = wingBounds.get(wing);
    wingBounds.set(
      wing,
      existing
        ? {
            minX: Math.min(existing.minX, bounds.x),
            minY: Math.min(existing.minY, bounds.y),
            maxX: Math.max(existing.maxX, bounds.x + bounds.width),
            maxY: Math.max(existing.maxY, bounds.y + bounds.height),
          }
        : {
            minX: bounds.x,
            minY: bounds.y,
            maxX: bounds.x + bounds.width,
            maxY: bounds.y + bounds.height,
          }
    );
  };

  layout.rooms.forEach((room) => {
    if (room.kind === "wing_background" || room.kind === "bridge" || room.kind === "entrance") {
      return;
    }
    const wing = inferWingForBackgroundCoverage(layout, room);
    const bounds = roomBounds(room);
    if (!wing || !bounds) return;
    extendWingBounds(wing, bounds);
  });

  deriveAutoHallwayOverlays(layout, floor).forEach((overlay) => {
    const wing = overlay.slot === "a" ? "A" : overlay.slot === "b" ? "B" : overlay.slot === "c" ? "C" : null;
    if (!wing) return;
    extendWingBounds(wing, {
      x: overlay.x,
      y: overlay.y,
      width: overlay.w,
      height: overlay.h,
    });
  });

  return (["A", "B", "C"] as const)
    .map((wing) => {
      const bounds = wingBounds.get(wing);
      if (!bounds) return null;
      const paddingX = GRID_SIZE;
      const paddingY = GRID_SIZE;
      const x = clamp(snap(bounds.minX - paddingX), 0, viewWidth);
      const y = clamp(snap(bounds.minY - paddingY), 0, viewHeight);
      const maxX = clamp(snap(bounds.maxX + paddingX), 0, viewWidth);
      const maxY = clamp(snap(bounds.maxY + paddingY), 0, viewHeight);
      const wingName = formatWingName(wing);
      return {
        id: `wing-background-${wing.toLowerCase()}-${floor}`,
        floor: floor as FloorId,
        kind: "wing_background" as const,
        wing,
        wingName,
        rect: {
          x,
          y,
          w: Math.max(GRID_SIZE * 2, maxX - x),
          h: Math.max(GRID_SIZE * 2, maxY - y),
          r: 10,
        },
        label: {
          x: x + Math.max(GRID_SIZE * 2, maxX - x) / 2,
          y: y + Math.max(GRID_SIZE * 2, maxY - y) / 2,
          text: wingBackgroundLabel(wing, wingName),
        },
      };
    })
    .filter(Boolean) as LayoutRoom[];
}

function clampRoomRectToWorld(rect: NonNullable<LayoutRoom["rect"]>): NonNullable<LayoutRoom["rect"]> {
  const w = Math.max(GRID_SIZE / 2, Math.min(WORLD_SIZE, rect.w));
  const h = Math.max(GRID_SIZE / 2, Math.min(WORLD_SIZE, rect.h));
  const x = clamp(rect.x, 0, Math.max(0, WORLD_SIZE - w));
  const y = clamp(rect.y, 0, Math.max(0, WORLD_SIZE - h));
  return { ...rect, x, y, w, h };
}

function resizeRoomsInLayout(layout: Layout, scaleFactor: number): Layout {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || Math.abs(scaleFactor - 1) < 0.001) {
    return layout;
  }

  return {
    ...layout,
    rooms: layout.rooms.map((room) => {
      if (room.kind !== "room" || !room.rect) return room;
      const centerX = room.rect.x + room.rect.w / 2;
      const centerY = room.rect.y + room.rect.h / 2;
      const nextRect = clampRoomRectToWorld({
        ...room.rect,
        x: Math.round(centerX - (room.rect.w * scaleFactor) / 2),
        y: Math.round(centerY - (room.rect.h * scaleFactor) / 2),
        w: Math.round(room.rect.w * scaleFactor),
        h: Math.round(room.rect.h * scaleFactor),
      });
      return {
        ...room,
        rect: nextRect,
        label: room.label ? { ...roomLabelPosition({ ...room, rect: nextRect }), text: room.label.text } : room.label,
      };
    }),
  };
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
    routingHallways: source.routingHallways?.map((space) => ({ ...space })),
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
      AB: {
        ...source.bridges.AB,
        poly: source.bridges.AB.poly ? { points: source.bridges.AB.poly.points.map((point) => ({ ...point })) } : undefined,
      },
      BC: {
        ...source.bridges.BC,
        poly: source.bridges.BC.poly ? { points: source.bridges.BC.poly.points.map((point) => ({ ...point })) } : undefined,
      },
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
  const floor = (layout.rooms[0]?.floor ?? 1) as BuilderFloor;
  const normalizedForRouting = normalizeRoutingHallwayRooms(layout, floor);
  const explicitLayoutWingBackgrounds = (["A", "B", "C"] as const).filter((wing) =>
    layout.rooms.some((room) => room.kind === "wing_background" && room.wing === wing)
  );
  const hasExplicitLayoutWingBackgrounds = explicitLayoutWingBackgrounds.length > 0;
  const routingHallways = deriveAutoHallwayOverlays(normalizedForRouting, floor).map((overlay) => {
    const wing =
      overlay.slot === "a" ? "A" : overlay.slot === "b" ? "B" : overlay.slot === "c" ? "C" : "A";
    return {
      id: overlay.id,
      name: overlay.label || overlay.id,
      x: Math.round(overlay.x),
      y: Math.round(overlay.y),
      width: Math.round(overlay.w),
      height: Math.round(overlay.h),
      type: SPACE_TYPE_HALLWAY,
      passable: true,
      wing,
    } as Space & { wing: string };
  });
  const next: FloorSource = {
    wingBackgrounds:
      !hasExplicitLayoutWingBackgrounds && canonicalSource.wingBackgrounds
        ? (Object.fromEntries(
            Object.entries(canonicalSource.wingBackgrounds).map(([wing, rect]) => [wing, rect ? { ...rect } : rect])
          ) as Partial<Record<WingId, { x: number; y: number; width: number; height: number; r?: number }>>)
        : {},
    routingHallways,
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
    A:
      getLayoutWingBackgroundBounds("A") ??
      (!hasExplicitLayoutWingBackgrounds ? getCanonicalWingBackgroundBounds("A") ?? getWingBounds(canonicalSource.wings.A) : null),
    B:
      getLayoutWingBackgroundBounds("B") ??
      (!hasExplicitLayoutWingBackgrounds ? getCanonicalWingBackgroundBounds("B") ?? getWingBounds(canonicalSource.wings.B) : null),
    C:
      getLayoutWingBackgroundBounds("C") ??
      (!hasExplicitLayoutWingBackgrounds ? getCanonicalWingBackgroundBounds("C") ?? getWingBounds(canonicalSource.wings.C) : null),
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
    // For rotated rect rooms, compute rotated corner points and their AABB.
    let effectiveBounds: { x: number; y: number; width: number; height: number } | null = null;
    let rotatedRectPoly: { points: LayoutPoint[] } | undefined = undefined;
    if (room.rect?.rotation) {
      const r = room.rect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const rad = (r.rotation * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);
      const rotatedPoints = (
        [[-r.w / 2, -r.h / 2], [r.w / 2, -r.h / 2], [r.w / 2, r.h / 2], [-r.w / 2, r.h / 2]] as [number, number][]
      ).map(([dx, dy]) => ({
        x: Math.round(cx + dx * cosA - dy * sinA),
        y: Math.round(cy + dx * sinA + dy * cosA),
      }));
      const xs = rotatedPoints.map((p) => p.x);
      const ys = rotatedPoints.map((p) => p.y);
      effectiveBounds = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      rotatedRectPoly = { points: rotatedPoints };
    } else {
      effectiveBounds = roomBounds(room);
    }
    if (!effectiveBounds) return;
    const bounds = effectiveBounds;

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
        : rotatedRectPoly,
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
  const resolvedLayouts = ensureBaseFloors(layouts, canonicalMapLayout);
  const floors = {
    "1": buildFloorSourceFromLayout(resolvedLayouts[1], cloneFloorSource(canonicalMapLayout.floors["1"])),
    "2": buildFloorSourceFromLayout(resolvedLayouts[2], cloneFloorSource(canonicalMapLayout.floors["2"])),
    "3": buildFloorSourceFromLayout(resolvedLayouts[3], cloneFloorSource(canonicalMapLayout.floors["3"])),
  };

  const mainEntranceRoom = resolvedLayouts[1].rooms.find((room) => room.id === "main-entrance" || room.kind === "entrance");
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
  return value.replace(/Main Map/gi, "Sandbox Layout").replace(/Main Layout/gi, "Sandbox Layout");
}

function buildDefaultNewMapName(): string {
  const timestamp = new Date().toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `New Sandbox Plan - ${timestamp}`;
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

/** Default real-world scale: meters per grid cell (40 px). Overridden by layout.metersPerCell. */
const DEFAULT_METERS_PER_CELL = 1.0;

function fmtMeters(m: number): string {
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${Math.round(m * 100)} cm`;
}

function makeRotateCursor(angle: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${angle} 12 12)"><path d="M3 12 A9 9 0 0 1 12 3" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M3 12 A9 9 0 0 1 12 3" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M9 3 L12 0 L15 3" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 3 L12 0 L15 3" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
}

// Curved-arrow cursors for each corner: TL=0°, TR=90°, BR=180°, BL=270°
const ROTATE_CURSORS = [0, 90, 180, 270].map(makeRotateCursor);

export default function SandboxLayoutBuilder() {
  const stageRef = useRef<any>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const selectedWingBackgroundNodeRef = useRef<any>(null);
  const wingBackgroundTransformerRef = useRef<any>(null);
  const copiedRoomsRef = useRef<LayoutRoom[]>([]);
  const rotateStartRef = useRef<{ startAngle: number; startRotation: number; roomId: string } | null>(null);
  const rotationDraftRef = useRef<number | null>(null);

  const [tool, setTool] = useState<Tool>("select");
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
  const [draftRoom, setDraftRoom] = useState<{ start: LayoutPoint; end: LayoutPoint } | null>(null);
  const [polygonDraft, setPolygonDraft] = useState<PolygonDraft | null>(null);
  const setStatusMessage = (_message: string) => {};
  const [showDraftsPopup, setShowDraftsPopup] = useState(true);
  const [svgListTab, setSvgListTab] = useState<SvgListTab>("main");
  const [activeDraftKey, setActiveDraftKey] = useState<string>(CURRENT_SANDBOX_DRAFT_KEY);
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
  const [isNewMapModalOpen, setIsNewMapModalOpen] = useState(false);
  const [newMapName, setNewMapName] = useState("");
  const [newMapError, setNewMapError] = useState("");
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
  const [isLayoutGeneratorOpen, setIsLayoutGeneratorOpen] = useState(false);
  const [isLayoutAssistantOpen, setIsLayoutAssistantOpen] = useState(false);
  const [lastAutoGenerateConfig, setLastAutoGenerateConfig] = useState<AutoGenerateConfig | null>(null);
  const [previousAutoGenerateConfig, setPreviousAutoGenerateConfig] = useState<AutoGenerateConfig | null>(null);
  const undoStackRef = useRef<Array<LayoutsByFloor>>([]);
  const hasAutoLoadedSandboxCurrentRef = useRef(false);
  const [undoCount, setUndoCount] = useState(0);
  const [idDraft, setIdDraft] = useState("");
  const [wingNameDraft, setWingNameDraft] = useState("");
  const [isWingNameMenuOpen, setIsWingNameMenuOpen] = useState(false);
  const [rectDraft, setRectDraft] = useState<{ x: string; y: string; w: string; h: string }>({
    x: "",
    y: "",
    w: "",
    h: "",
  });
  const wingNameComboRef = useRef<HTMLDivElement | null>(null);

  const referenceFileInputRef = useRef<HTMLInputElement | null>(null);
  const [doorIndicatorsByFloor, setDoorIndicatorsByFloor] = useState<
    Partial<Record<BuilderFloor, { x1: number; y1: number; x2: number; y2: number }[]>>
  >({});

  const applyLoadedMapView = useCallback(() => {
    setView(LOADED_MAP_VIEW);
  }, []);

  const resetToMainMapCurrent = useCallback((source: CanonicalMapLayout) => {
    const nextLayouts = mapLayoutToLayoutsByFloor(source);
    const nextVisibleFloors = deriveVisibleFloorsFromLayouts(nextLayouts);
    setEditorBaseMapLayout(cloneCanonicalMapLayout(source));
    setActiveDraftKey(CURRENT_SANDBOX_DRAFT_KEY);
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
    const auth = getSandboxAuthState();
    if (!auth.loggedIn) {
      hasAutoLoadedSandboxCurrentRef.current = false;
      return;
    }
    if (hasAutoLoadedSandboxCurrentRef.current) {
      return;
    }
    hasAutoLoadedSandboxCurrentRef.current = true;
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

  const openNewMapModal = useCallback(() => {
    if (isUiBlocked) return;
    setNewMapName(buildDefaultNewMapName());
    setNewMapError("");
    setIsNewMapModalOpen(true);
  }, [isUiBlocked]);

  const closeNewMapModal = useCallback(() => {
    setIsNewMapModalOpen(false);
    setNewMapName("");
    setNewMapError("");
  }, []);

  const refreshCanonicalMapLayout = async (applyToCanvas: boolean): Promise<boolean> => {
    const endpoints = Array.from(
      new Set([`${SANDBOX_SERVICE_BASE_URL}/map-layout`])
    );
    for (const endpoint of endpoints) {
      try {
        const res = await sandboxFetch(endpoint);
        if (!res.ok) continue;
        const payload = await res.json();
        if (!isCanonicalMapLayout(payload)) continue;
        setCanonicalMapLayout(payload);
        if (applyToCanvas || (!loadedDraftFilename && activeDraftKey === CURRENT_SANDBOX_DRAFT_KEY)) {
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

  const handleReferenceImageUpload = (event: { target: HTMLInputElement }) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
      showToast("That file is too large. Please upload a file under 5 MB.", "danger");
      return;
    }
    if (isUiBlocked) {
      showToast("Please wait for the current action to finish before uploading a floor plan.", "danger");
      return;
    }

    void (async () => {
      setBlockingAction("save");
      try {
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        const isTiff = file.type === "image/tiff" || /\.tiff?$/i.test(file.name);
        if (isPdf) showToast("Rendering PDF page 1...", "info");
        if (isTiff) showToast("Decoding TIFF image...", "info");

        const { image } = await decodeFloorPlanFile(file);
        const { viewBox } = resetToBlankNewMapInMemory();

        const viewW = viewBox.w || WORLD_SIZE;
        const viewH = viewBox.h || WORLD_SIZE;
        const maxW = viewW * 0.85;
        const maxH = viewH * 0.85;
        const fitScale = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight, 1);
        const width = Math.max(40, image.naturalWidth * fitScale);
        const height = Math.max(40, image.naturalHeight * fitScale);
        const refX = snap((viewW - width) / 2);
        const refY = snap((viewH - height) / 2);

        showToast("Detecting rooms from the floor plan...", "info");
        const pxToWorldX = width / image.naturalWidth;
        const pxToWorldY = height / image.naturalHeight;
        const detection = detectRoomBoxesFromImage(image);
        const toWorldPoint = (p: GridPoint): LayoutPoint => ({
          x: refX + p.x * pxToWorldX,
          y: refY + p.y * pxToWorldY,
        });
        const detectedRegionsWorld = detection.regions
          .map((region) => ({
            box: {
              x: refX + region.box.x * pxToWorldX,
              y: refY + region.box.y * pxToWorldY,
              w: region.box.w * pxToWorldX,
              h: region.box.h * pxToWorldY,
            },
          }))
          .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
        const doorIndicatorsWorld = detection.doorLines.map(([a, b]) => {
          const worldA = toWorldPoint(a);
          const worldB = toWorldPoint(b);
          return { x1: worldA.x, y1: worldA.y, x2: worldB.x, y2: worldB.y };
        });

        // If one open region dominates the detected area, it's almost always the overall
        // building's connecting corridor (undetected interior walls merge it with the open
        // floor) - render it as a hallway, using the same standard hallway styling as every
        // other hallway in the app, instead of discarding it into a plain background slab.
        const looksLikeHallway = (box: DetectedRoomBox): boolean => {
          const longSide = Math.max(box.w, box.h);
          const shortSide = Math.max(1, Math.min(box.w, box.h));
          return longSide / shortSide >= 3.2 && longSide >= GRID_SIZE * 4;
        };
        const regionAreas = detectedRegionsWorld.map((region) => region.box.w * region.box.h);
        const totalArea = regionAreas.reduce((sum, area) => sum + area, 0);
        let dominantIndex = -1;
        if (detectedRegionsWorld.length >= 2 && totalArea > 0) {
          let maxArea = -1;
          regionAreas.forEach((area, i) => {
            if (area > maxArea) {
              maxArea = area;
              dominantIndex = i;
            }
          });
          if (maxArea / totalArea < 0.5) dominantIndex = -1;
        }
        const regionsToPlace = detectedRegionsWorld;

        const generatedRooms: LayoutRoom[] = [];
        let roomCount = 0;
        let hallwayCount = 0;
        let footprintMinX = Infinity;
        let footprintMinY = Infinity;
        let footprintMaxX = -Infinity;
        let footprintMaxY = -Infinity;

        regionsToPlace.forEach(({ box }, index) => {
          // The dominant region (the building's connecting corridor) and any other long,
          // narrow region read as hallways rather than rooms.
          const isHallway = index === dominantIndex || looksLikeHallway(box);
          const kind: LayoutRoomKind = isHallway ? "hallway" : "room";
          const label = makeDefaultLabel(kind, (isHallway ? hallwayCount : roomCount) + 1);
          const room = roomFromDraft(1, kind, { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, label);
          if (!room) return;
          if (isHallway) hallwayCount += 1;
          else roomCount += 1;
          generatedRooms.push({ ...room, id: `${room.id}-${index}` });
          footprintMinX = Math.min(footprintMinX, box.x);
          footprintMinY = Math.min(footprintMinY, box.y);
          footprintMaxX = Math.max(footprintMaxX, box.x + box.w);
          footprintMaxY = Math.max(footprintMaxY, box.y + box.h);
        });

        if (generatedRooms.length) {
          const padding = GRID_SIZE;
          const backgroundBounds = { minX: footprintMinX, minY: footprintMinY, maxX: footprintMaxX, maxY: footprintMaxY };
          const backgroundRoom = roomFromDraft(
            1,
            "wing_background",
            { x: backgroundBounds.minX - padding, y: backgroundBounds.minY - padding },
            { x: backgroundBounds.maxX + padding, y: backgroundBounds.maxY + padding },
            ""
          );
          applyLayoutChange(
            (prev) => {
              const next = cloneLayoutsByFloor(prev);
              next[1].rooms = backgroundRoom ? [backgroundRoom, ...generatedRooms] : generatedRooms;
              return next;
            },
            { recordHistory: false }
          );
        }

        setDoorIndicatorsByFloor({ 1: doorIndicatorsWorld });
        activateTool("pan");

        const detectionSummary = hallwayCount
          ? `${roomCount} room${roomCount === 1 ? "" : "s"} and ${hallwayCount} hallway${hallwayCount === 1 ? "" : "s"}`
          : `${roomCount} room${roomCount === 1 ? "" : "s"}`;
        const doorSummary = doorIndicatorsWorld.length
          ? ` ${doorIndicatorsWorld.length} doorway${doorIndicatorsWorld.length === 1 ? "" : "s"} marked with a line.`
          : "";
        setStatusMessage(`New unsaved map created from uploaded floor plan with ${detectionSummary}.${doorSummary}`);
        showToast(
          generatedRooms.length
            ? `Detected ${detectionSummary}, plus a background slab.${doorSummary} This is an automatic best-effort guess - review shapes, labels, and wings, then click SAVE DRAFT when ready.`
            : "Could not auto-detect any rooms in that floor plan. Try a clearer black-and-white floor plan, or use the room tools to build the layout manually.",
          generatedRooms.length ? "success" : "info"
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Could not process that floor plan file.", "danger");
      } finally {
        setBlockingAction(null);
      }
    })();
  };

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
          note: data.note ?? "Sandbox layout history snapshot",
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
        const displayName =
          typeof item.displayName === "string" && item.displayName.trim()
            ? item.displayName.trim()
            : overrideName;
        return {
          key: buildMapHistoryOptionKey(filename),
          sourceLabel: "",
          filename,
          draftId: displayName ?? `Sandbox Layout - ${finalLabel}`,
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
          typeof item.displayName === "string" && item.displayName.trim()
            ? item.displayName.trim()
            : typeof data.draftId === "string" && data.draftId.trim()
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
      note: "Current sandbox_map_layout.json",
      baseMapLayout: canonicalMapLayout,
    });
    const mainOption: DraftOption = {
      key: CURRENT_SANDBOX_DRAFT_KEY,
      sourceLabel: CURRENT_SANDBOX_SOURCE_LABEL,
      filename: CURRENT_SANDBOX_FILENAME,
      draftId: CURRENT_SANDBOX_LABEL,
      createdAt: "current",
      note: "Generated from sandbox_map_layout.json",
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
        : CURRENT_SANDBOX_LABEL;
    const filename =
      loadedDraftFilename && loadedDraftFilename.trim()
        ? loadedDraftFilename.trim()
        : resolved?.filename && resolved.filename.trim()
        ? resolved.filename.trim()
        : CURRENT_SANDBOX_FILENAME;
    return { displayName, filename };
  }, [loadedDraftFilename, currentLoadedDraftOption]);
  const openMapLayoutsModal = useCallback(() => {
    setSvgListTab(currentLoadedDraftOption?.isDraftFile ? "drafts" : "main");
    setDraftFiles([]);
    setMapHistoryFiles([]);
    setShowDraftsPopup(true);
  }, [currentLoadedDraftOption]);

  const refreshDraftFiles = async () => {
    setDraftFiles([]);
    const json = await fetchJsonFromEndpoints<{ ok?: boolean; items?: DraftFileItem[] }>([
      `${SANDBOX_SERVICE_BASE_URL}/draft-maps`,
    ]);
    if (!json?.ok || !Array.isArray(json.items)) return;
    setDraftFiles(json.items);
  };

  const refreshMapHistoryFiles = async () => {
    setMapHistoryFiles([]);
    const json = await fetchJsonFromEndpoints<{ ok?: boolean; items?: MapHistoryFileItem[] }>([
      `${SANDBOX_SERVICE_BASE_URL}/map-layout-history`,
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
    setDraftFiles([]);
    setMapHistoryFiles([]);
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
    try {
      let res: Response;
      if (draft.isDraftFile) {
        res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/draft-maps/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: draft.filename }),
        });
      } else {
        const historyItem = mapHistoryFiles.find((item) => item.filename === draft.filename);
        if (!historyItem?.id) {
          throw new Error("history item not found");
        }
        res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/map-layout-history/${historyItem.id}`, {
          method: "DELETE",
        });
      }
      const payload = (await res.json()) as { ok?: boolean; deleted?: boolean };
      if (!res.ok || !payload?.ok) {
        throw new Error("delete failed");
      }
      await Promise.allSettled([refreshDraftFiles(), refreshMapHistoryFiles()]);
      if (!draft.isDraftFile) {
        setMapHistoryNameOverrides((prev) => {
          if (!(draft.filename in prev)) return prev;
          const next = { ...prev };
          delete next[draft.filename];
          return next;
        });
      }
      const isLoadedDraft =
        currentLoadedDraftOption?.key === draft.key || (draft.isDraftFile && loadedDraftFilename === draft.filename);
      if (isLoadedDraft) {
        resetToMainMapCurrent(canonicalMapLayout);
        setSvgListTab("main");
        setStatusMessage(
          draft.isDraftFile
            ? "Loaded draft was deleted. Switched to Sandbox Layout - Current."
            : "Loaded history layout was deleted. Switched to Sandbox Layout - Current."
        );
        showToast(
          draft.isDraftFile
            ? "Loaded draft deleted. Sandbox Layout - Current loaded."
            : "Loaded history layout deleted. Sandbox Layout - Current loaded.",
          "info"
        );
      } else {
        setStatusMessage(draft.isDraftFile ? `Deleted draft: ${draft.filename}` : `Deleted history layout: ${draft.filename}`);
        showToast(draft.isDraftFile ? `Draft deleted: ${draft.filename}` : `History layout deleted: ${draft.filename}`, "danger");
      }
    } catch {
      setStatusMessage(
        draft.isDraftFile ? `Failed to delete draft: ${draft.filename}` : `Failed to delete history layout: ${draft.filename}`
      );
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
      const sourceItem = mapHistoryFiles.find((item) => item.filename === draft.filename);
      if (!sourceItem?.id) {
        showToast("History entry not found.", "danger");
        return;
      }
      try {
        const res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/map-layout-history/${sourceItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payload: sourceItem.payload,
            filename: sourceItem.filename,
            displayName: input,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (!res.ok || !payload?.ok) {
          throw new Error("rename-history failed");
        }
        await refreshMapHistoryFiles();
        setDraftToRename(null);
        setDraftRenameValue("");
        setDraftRenameError("");
        showToast(`History renamed: ${input}`, isLoadedTarget ? "info" : "success");
        setStatusMessage(`History entry renamed to ${input}.`);
      } catch {
        showToast("Failed to rename history entry.", "danger");
        setStatusMessage(`Failed to rename history entry: ${draft.filename}`);
      }
      return;
    }
    const sourceItem = draftFiles.find((item) => item.filename === draft.filename);
    if (!sourceItem?.id) {
      showToast("Draft not found.", "danger");
      return;
    }
    try {
      const saveRes = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/draft-maps/${sourceItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: sourceItem.payload,
          filename: sourceItem.filename,
          displayName: input,
        }),
      });
      const saveJson = (await saveRes.json().catch(() => ({}))) as { ok?: boolean; filename?: string };
      if (!saveRes.ok || !saveJson?.ok) {
        throw new Error("save-after-rename failed");
      }
      await refreshDraftFiles();
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
    if (currentLoadedDraftOption.key === CURRENT_SANDBOX_DRAFT_KEY) {
      const message = "Sandbox Layout - Current cannot be renamed.";
      setStatusMessage(message);
      showToast(message, "info");
      return;
    }
    setDraftToRename(currentLoadedDraftOption);
    setDraftRenameValue(currentLoadedDraftOption.draftId);
    setDraftRenameError("");
  };

  const deleteCurrentLoadedMap = () => {
    if (!currentLoadedDraftOption) {
      showToast("No loaded map entry to delete.", "info");
      return;
    }
    if (currentLoadedDraftOption.key === CURRENT_SANDBOX_DRAFT_KEY) {
      const message = "Sandbox Layout - Current cannot be deleted.";
      setStatusMessage(message);
      showToast(message, "info");
      return;
    }
    setDraftToDelete(currentLoadedDraftOption);
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
  const wingNameOptions = useMemo(() => {
    const options = new Set(WING_OPTIONS.map((wing) => formatWingName(wing)));
    sortedFloorNumbersFromLayouts(layoutsByFloor).forEach((floorNum) => {
      layoutsByFloor[floorNum]?.rooms.forEach((room) => {
        if (room.kind !== "wing_background") return;
        options.add(normalizeWingNameInput(room.wingName ?? "") ?? formatWingName(room.wing ?? "A"));
      });
    });
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [layoutsByFloor]);
  const filteredWingNameOptions = useMemo(() => {
    const query = wingNameDraft.trim().toLowerCase();
    if (!query) return wingNameOptions;
    return wingNameOptions.filter((option) => option.toLowerCase().includes(query));
  }, [wingNameDraft, wingNameOptions]);
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
  const selectableComponentOptions = useMemo(() => {
    const options = currentLayout.rooms.map((room) => ({
      id: room.id,
      label: componentPickerLabel(room),
      sortLabel: room.label?.text?.trim() || room.id,
    }));
    options.sort(
      (a, b) =>
        a.sortLabel.localeCompare(b.sortLabel, undefined, { numeric: true, sensitivity: "base" }) ||
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })
    );
    return options.map(({ id, label }) => ({ id, label }));
  }, [currentLayout.rooms]);
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
        cancelPolygonDraft();
      }
      if (e.key === "Enter" && tool === "polygon_room" && polygonDraft?.points?.length) {
        e.preventDefault();
        finishPolygonDraft();
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
  }, [
    activeFloor,
    activeSelectionIds,
    cancelPolygonDraft,
    copySelectedElements,
    finishPolygonDraft,
    isUiBlocked,
    pasteCopiedElements,
    polygonDraft?.points?.length,
    selectedRooms,
    tool,
    undoCount,
  ]);

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
  const currentLayoutSummary = useMemo(
    () => ({
      floorCount: visibleFloors.length,
      roomCount: Object.values(layoutsByFloor).reduce((sum, layout) => sum + (layout?.rooms.length ?? 0), 0),
      activeFloor,
    }),
    [activeFloor, layoutsByFloor, visibleFloors.length]
  );
  const assistantBaseConfig = useMemo<AutoGenerateConfig>(() => {
    if (lastAutoGenerateConfig) {
      return { ...lastAutoGenerateConfig };
    }

    const fallback = createDefaultAutoGenerateConfig();
    const layouts = Object.values(layoutsByFloor).filter(Boolean);
    const allRooms = layouts.flatMap((layout) => layout.rooms);
    const wingLetters = Array.from(
      new Set(
        allRooms
          .map((room) => room.wing)
          .filter((wing): wing is WingId => Boolean(wing))
      )
    );
    const wingCount = wingLetters.length
      ? Math.max(
          1,
          ...wingLetters.map((wing) => ["A", "B", "C", "D", "E"].indexOf(wing) + 1).filter((value) => value > 0)
        )
      : fallback.wingCount;
    const generatedRoomCount = allRooms.filter((room) => room.kind === "room").length;
    const roomsPerWing = wingCount > 0 && visibleFloors.length > 0
      ? Math.max(1, Math.min(30, Math.round(generatedRoomCount / Math.max(1, wingCount * visibleFloors.length))))
      : fallback.roomsPerWing;
    const hallwayRoom = allRooms.find((room) => (room.kind === "hallway" || room.kind === "bridge") && room.rect);
    const hallwayThickness = hallwayRoom?.rect
      ? Math.min(hallwayRoom.rect.w, hallwayRoom.rect.h)
      : fallback.hallwayThickness;

    return {
      ...fallback,
      width: currentLayout.viewBox.w || fallback.width,
      height: currentLayout.viewBox.h || fallback.height,
      floorCount: Math.max(1, visibleFloors.length),
      wingCount,
      roomsPerWing,
      roomScale: fallback.roomScale,
      density: roomsPerWing <= 5 ? "low" : roomsPerWing >= 10 ? "high" : "medium",
      includeBridges: allRooms.some((room) => room.kind === "bridge"),
      includeHallways: allRooms.some((room) => room.kind === "hallway"),
      includeWingBackgrounds: allRooms.some((room) => room.kind === "wing_background"),
      includeEntrance: allRooms.some((room) => room.kind === "entrance"),
      includeLounges: allRooms.some((room) => room.kind === "lounge"),
      hallwayThickness,
      wingLabelMode: fallback.wingLabelMode,
      wingRoomScaleOverrides: {},
    };
  }, [currentLayout.viewBox.h, currentLayout.viewBox.w, lastAutoGenerateConfig, layoutsByFloor, visibleFloors.length]);
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
  const selectedHallwayLayerState = useMemo(() => {
    if (!selectedRoom || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge")) {
      return { canSendToBack: false, canSendToFront: false };
    }
    const hallwayIndex = currentLayout.rooms.findIndex((room) => room.id === selectedRoom.id);
    if (hallwayIndex < 0) {
      return { canSendToBack: false, canSendToFront: false };
    }
    let firstMovableIndex = currentLayout.rooms.findIndex((room) => room.kind !== "wing_background");
    if (firstMovableIndex < 0) {
      firstMovableIndex = 0;
    }
    const lastMovableIndex = currentLayout.rooms.length - 1;
    return {
      canSendToBack: hallwayIndex > firstMovableIndex,
      canSendToFront: hallwayIndex < lastMovableIndex,
    };
  }, [currentLayout.rooms, selectedRoom]);

  useEffect(() => {
    setIdDraft(selectedRoom?.id ?? "");
    setLiveResizeDims(null);
  }, [selectedRoom?.id]);

  useEffect(() => {
    if (selectedRoom?.kind !== "wing_background") {
      setWingNameDraft("");
      setIsWingNameMenuOpen(false);
      return;
    }
    setWingNameDraft(normalizeWingNameInput(selectedRoom.wingName ?? "") ?? formatWingName(selectedRoom.wing ?? "A"));
  }, [selectedRoom?.id, selectedRoom?.kind, selectedRoom?.wing, selectedRoom?.wingName]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!wingNameComboRef.current?.contains(event.target as Node)) {
        setIsWingNameMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    const transformer = wingBackgroundTransformerRef.current;
    if (!transformer) return;
    const shouldAttach = Boolean(selectedRoom?.rect) && Boolean(selectedWingBackgroundNodeRef.current);
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
  }, [
    selectedRoom?.id,
    selectedRoom?.rect?.x,
    selectedRoom?.rect?.y,
    selectedRoom?.rect?.w,
    selectedRoom?.rect?.h,
    selectedRoomBounds?.height,
    selectedRoomBounds?.width,
    selectedRoomBounds?.x,
    selectedRoomBounds?.y,
  ]);

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
        const wing = prevRoom.wing ?? parseWingNameInput(prevRoom.wingName ?? "") ?? "A";
        const wingName = normalizeWingNameInput(prevRoom.wingName ?? "") ?? formatWingName(wing);
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

  const updateSelectedWingBackgroundNameDraft = (rawValue: string) => {
    if (!selectedRoom || selectedRoom.kind !== "wing_background") return;
    const normalizedWingName = normalizeWingNameInput(rawValue);
    updateRoom(selectedRoom.id, (prevRoom) => {
      const nextWing = parseWingNameInput(normalizedWingName ?? rawValue) ?? prevRoom.wing ?? "A";
      return {
        ...prevRoom,
        wing: nextWing,
        wingName: normalizedWingName ?? rawValue,
        label: {
          ...(prevRoom.label ?? roomLabelPosition(prevRoom)),
          text: wingBackgroundLabel(nextWing, normalizedWingName ?? rawValue),
        },
      };
    });
  };

  const commitSelectedWingBackgroundName = (rawValue: string) => {
    if (!selectedRoom || selectedRoom.kind !== "wing_background") return;
    const normalizedWingName = normalizeWingNameInput(rawValue) ?? formatWingName(selectedRoom.wing ?? "A");
    const nextWing = parseWingNameInput(normalizedWingName) ?? selectedRoom.wing ?? "A";
    updateRoom(selectedRoom.id, (prevRoom) => ({
      ...prevRoom,
      wing: nextWing,
      wingName: normalizedWingName,
      label: {
        ...(prevRoom.label ?? roomLabelPosition(prevRoom)),
        text: wingBackgroundLabel(nextWing, normalizedWingName),
      },
    }));
    setWingNameDraft(normalizedWingName);
  };

  const applyWingNameOption = (nextWingName: string) => {
    setWingNameDraft(nextWingName);
    commitSelectedWingBackgroundName(nextWingName);
    setIsWingNameMenuOpen(false);
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
        const nextPoints = points.map((p) => ({
          x: cx + (p.y - cy),
          y: cy - (p.x - cx),
        }));
        const nextPoly = { points: nextPoints };
        const nextLabelPosition = roomLabelPosition({ ...prevRoom, poly: nextPoly });
        return {
          ...prevRoom,
          poly: nextPoly,
          label: prevRoom.label
            ? { ...nextLabelPosition, text: prevRoom.label.text }
            : prevRoom.label,
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

  const commitSelectedRoomPolyBounds = (
    key: "x" | "y" | "w" | "h",
    rawValue: string
  ) => {
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
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.poly || prevRoom.poly.points.length < 2) return prevRoom;
      const lastPoint = prevRoom.poly.points[prevRoom.poly.points.length - 1];
      const firstPoint = prevRoom.poly.points[0];
      const midPoint = snapPoint({
        x: (lastPoint.x + firstPoint.x) / 2,
        y: (lastPoint.y + firstPoint.y) / 2,
      });
      const nextPoints = [...prevRoom.poly.points, midPoint];
      return {
        ...prevRoom,
        poly: { points: nextPoints },
        label: prevRoom.label
          ? { ...roomLabelPosition({ ...prevRoom, poly: { points: nextPoints } }), text: prevRoom.label.text }
          : prevRoom.label,
      };
    });
  };

  const removeSelectedPolygonVertex = () => {
    if (!selectedRoom?.poly || selectedRoom.poly.points.length <= 3) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.poly || prevRoom.poly.points.length <= 3) return prevRoom;
      const nextPoints = prevRoom.poly.points.slice(0, -1);
      return {
        ...prevRoom,
        poly: { points: nextPoints },
        label: prevRoom.label
          ? { ...roomLabelPosition({ ...prevRoom, poly: { points: nextPoints } }), text: prevRoom.label.text }
          : prevRoom.label,
      };
    });
  };

  const updateSelectedCorridorDimension = (dimension: "length" | "thickness", rawValue: string) => {
    if (!selectedRoom?.rect || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge")) return;
    if (rawValue.trim() === "") return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.rect || (prevRoom.kind !== "hallway" && prevRoom.kind !== "bridge")) return prevRoom;
      const isVertical = prevRoom.rect.h > prevRoom.rect.w;
      const nextRect = { ...prevRoom.rect };
      const nextValue = Math.max(GRID_SIZE / 2, snapToStep(numeric, HALLWAY_RESIZE_SNAP));
      if (dimension === "length") {
        if (isVertical) nextRect.h = nextValue;
        else nextRect.w = nextValue;
      } else if (isVertical) {
        nextRect.w = nextValue;
      } else {
        nextRect.h = nextValue;
      }
      return {
        ...prevRoom,
        rect: nextRect,
        label: prevRoom.label
          ? { ...roomLabelPosition({ ...prevRoom, rect: nextRect }), text: prevRoom.label.text }
          : prevRoom.label,
      };
    });
  };

  const straightenSelectedCorridor = () => {
    if (!selectedRoom?.rect || (selectedRoom.kind !== "hallway" && selectedRoom.kind !== "bridge")) return;
    updateRoom(selectedRoom.id, (prevRoom) => {
      if (!prevRoom.rect || (prevRoom.kind !== "hallway" && prevRoom.kind !== "bridge")) return prevRoom;
      const isVertical = prevRoom.rect.h >= prevRoom.rect.w;
      const thickness = Math.max(GRID_SIZE / 2, snapToStep(Math.min(prevRoom.rect.w, prevRoom.rect.h), HALLWAY_RESIZE_SNAP));
      const length = Math.max(GRID_SIZE / 2, snapToStep(Math.max(prevRoom.rect.w, prevRoom.rect.h), HALLWAY_RESIZE_SNAP));
      const nextRect = isVertical
        ? { ...prevRoom.rect, w: thickness, h: length }
        : { ...prevRoom.rect, w: length, h: thickness };
      return {
        ...prevRoom,
        rect: nextRect,
        label: prevRoom.label
          ? { ...roomLabelPosition({ ...prevRoom, rect: nextRect }), text: prevRoom.label.text }
          : prevRoom.label,
      };
    });
  };

  const clearSelectedRooms = () => {
    setSelection(null);
    setSelectedIds([]);
  };

  const activateTool = (nextTool: Tool) => {
    if (nextTool !== "select") {
      clearSelectedRooms();
    }
    if (nextTool !== "polygon_room") {
      setPolygonDraft(null);
    }
    if (nextTool === "polygon_room") {
      setDraftRoom(null);
    }
    setTool(nextTool);
  };

  const focusRoomInView = (room: LayoutRoom) => {
    const bounds = roomBounds(room);
    if (!bounds) return;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    setView((prev) => ({
      ...prev,
      x: viewport.width / 2 - centerX * prev.scale,
      y: viewport.height / 2 - centerY * prev.scale,
    }));
  };

  const selectComponentFromDropdown = (componentId: string) => {
    if (isUiBlocked) return;
    if (!componentId) {
      clearSelectedRooms();
      return;
    }
    if (tool !== "select") {
      setTool("select");
    }
    const room = currentLayout.rooms.find((candidate) => candidate.id === componentId);
    if (!room) return;
    setSelection(room.id);
    setSelectedIds([room.id]);
    focusRoomInView(room);
  };

  const handleRoomSelection = (id: string, additive = false) => {
    if (tool !== "select") {
      return;
    }
    if (!additive) {
      setSelection(id);
      setSelectedIds([id]);
      return;
    }
    if (selectedIds.includes(id)) {
      const nextIds = selectedIds.filter((selectedId) => selectedId !== id);
      if (!nextIds.length) {
        clearSelectedRooms();
        return;
      }
      setSelectedIds(nextIds);
      setSelection((prev) => {
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

  function finishPolygonDraft() {
    if (!polygonDraft?.points?.length) return;
    const nextRoom = polygonRoomFromPoints(
      activeFloor,
      "room",
      polygonDraft.points,
      makeDefaultLabel("room", currentLayout.rooms.length + 1)
    );
    if (!nextRoom) {
      showToast("Add at least three points for an irregular room.", "info");
      return;
    }
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

  function cancelPolygonDraft() {
    setPolygonDraft(null);
  }

  const getRoomStackingBounds = useCallback((rooms: LayoutRoom[]) => {
    let firstMovableIndex = rooms.findIndex((room) => room.kind !== "wing_background");
    if (firstMovableIndex < 0) {
      firstMovableIndex = 0;
    }
    const lastMovableIndex = rooms.length - 1;
    return { firstMovableIndex, lastMovableIndex };
  }, []);

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
    if (isUiBlocked) return;
    if (tool !== "select") {
      setTool("select");
    }
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
      clearSelectedRooms();
      return;
    }
    if (mouseButton !== 0) return;

    if (tool === "polygon_room") {
      const snapped = snapPoint(world);
      setPolygonDraft((prev) => {
        if (!prev) {
          return { points: [snapped], hover: snapped };
        }
        return { points: [...prev.points, snapped], hover: snapped };
      });
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

    if (tool === "polygon_room") {
      return;
    }

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

  const nudgeMapHorizontally = (deltaX: number) => {
    setView((prev) => ({ ...prev, x: prev.x + deltaX }));
  };

  const nudgeMapVertically = (deltaY: number) => {
    setView((prev) => ({ ...prev, y: prev.y + deltaY }));
  };

  const saveMainLayoutJsonBackupToUi = async (payload: CanonicalMapLayout): Promise<boolean> => {
    if (!SANDBOX_MAIN_LAYOUT_BACKUP_SAVE_URL) {
      return true;
    }
    try {
      const res = await fetchWithTimeout(
        SANDBOX_MAIN_LAYOUT_BACKUP_SAVE_URL,
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
          draftFiles.find((item) => item.filename === replacingFilename)?.displayName ??
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
        const deleteRes = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/draft-maps/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: replacingFilename }),
        });
        const deletePayload = await deleteRes.json().catch(() => ({} as { ok?: boolean }));
        if (!deleteRes.ok || !deletePayload?.ok) {
          throw new Error("Failed to replace existing draft file.");
        }
      }
      const res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/draft-maps/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft, displayName: retainedDraftId }),
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
            ? `Draft saved as ${payload.filename}. Oldest draft removed to keep max ${SANDBOX_DRAFT_LIMIT}.`
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

  const applyGeneratedLayouts = (
    generatedLayouts: Partial<Record<number, Layout>>,
    options?: {
      config?: AutoGenerateConfig | null;
      successMessage?: string;
      statusMessage?: string;
      commands?: Array<{ type: string; field: string; value: string }>;
    }
  ) => {
    try {
      const deleteCommands = (options?.commands ?? []).filter((command) => command.type === "deleteAllElements");
      const deleteByIdCommands = (options?.commands ?? []).filter((command) => command.type === "deleteRoomsById");
      const restoreWingBackgroundCommands = (options?.commands ?? []).filter(
        (command) => command.type === "restoreWingBackgroundsFromCanvas"
      );
      const addHallwayCommands = (options?.commands ?? []).filter((command) => command.type === "addHallwaysFromCanvas");
      const addRoomCommands = (options?.commands ?? []).filter((command) => command.type === "addRoomsFromCanvas");
      const resizeRoomCommands = (options?.commands ?? []).filter((command) => command.type === "resizeAllRoomsOnCanvas");
      const newLayouts: LayoutsByFloor =
        deleteCommands.length > 0 ||
        deleteByIdCommands.length > 0 ||
        restoreWingBackgroundCommands.length > 0 ||
        addHallwayCommands.length > 0 ||
        addRoomCommands.length > 0 ||
        resizeRoomCommands.length > 0
          ? cloneLayoutsByFloor(layoutsByFloor)
          : {};

      if (deleteCommands.length > 0) {
        const deleteKinds = new Set<LayoutRoomKind>();
        deleteCommands.forEach((command) => {
          const value = command.value?.toLowerCase();
          if (value === "room" || value === "hallway" || value === "lounge" || value === "wing_background") {
            deleteKinds.add(value);
          }
        });
        Object.keys(newLayouts).forEach((floorStr) => {
          const floor = Number(floorStr) as BuilderFloor;
          const layout = newLayouts[floor];
          if (!layout) return;
          newLayouts[floor] = {
            ...layout,
            rooms: layout.rooms.filter((room) => !deleteKinds.has(room.kind)),
          };
        });
      }

      if (deleteByIdCommands.length > 0) {
        const idsToDelete = new Set<string>();
        deleteByIdCommands.forEach((command) => {
          command.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .forEach((id) => idsToDelete.add(id));
        });
        Object.keys(newLayouts).forEach((floorStr) => {
          const floor = Number(floorStr) as BuilderFloor;
          const layout = newLayouts[floor];
          if (!layout) return;
          newLayouts[floor] = {
            ...layout,
            rooms: layout.rooms.filter((room) => !idsToDelete.has(room.id)),
          };
        });
      }

      if (restoreWingBackgroundCommands.length > 0) {
        Object.keys(newLayouts).forEach((floorStr) => {
          const floor = Number(floorStr) as BuilderFloor;
          const layout = newLayouts[floor];
          if (!layout) return;
          const restoredWingBackgrounds = deriveWingBackgroundRoomsForLayout(layout).map((room) => ({
            ...room,
            floor: floor as FloorId,
            id: `wing-background-${(room.wing ?? "a").toLowerCase()}-${floor}`,
          }));
          newLayouts[floor] = {
            ...layout,
            rooms: [
              ...layout.rooms.filter((room) => room.kind !== "wing_background"),
              ...restoredWingBackgrounds,
            ],
          };
        });
      }

      if (addHallwayCommands.length > 0) {
        Object.keys(newLayouts).forEach((floorStr) => {
          const floor = Number(floorStr) as BuilderFloor;
          const layout = newLayouts[floor];
          if (!layout) return;
          newLayouts[floor] = materializeHorizontalAutoHallways(layout, floor);
        });
      }

      if (addRoomCommands.length > 0) {
        addRoomCommands.forEach((command) => {
          const floor = Number.parseInt(command.field, 10) as BuilderFloor;
          const layout = newLayouts[floor];
          if (!layout) return;
          const requestedCount = Math.max(1, Number.parseInt(command.value, 10) || 1);
          const sourceRooms = layout.rooms.filter((room) => room.kind === "room" && room.rect);
          if (!sourceRooms.length) return;
          const existingIds = new Set(layout.rooms.map((room) => room.id));
          const workingRooms = [...layout.rooms];
          const additions: LayoutRoom[] = [];

          for (let index = 0; index < requestedCount; index += 1) {
            const sourceRoom = sourceRooms[index % sourceRooms.length];
            const offset = pickRoomCopyOffset(sourceRoom, workingRooms);
            const shiftedCopy = shiftRoomBy(sourceRoom, offset.dx, offset.dy);
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
            additions.push(nextRoom);
          }

          if (additions.length) {
            newLayouts[floor] = {
              ...layout,
              rooms: [...layout.rooms, ...additions],
            };
          }
        });
      }

      if (resizeRoomCommands.length > 0) {
        const scaleFactor = resizeRoomCommands
          .map((command) => Number.parseFloat(command.value))
          .find((value) => Number.isFinite(value) && value > 0);
        if (scaleFactor) {
          Object.keys(newLayouts).forEach((floorStr) => {
            const floor = Number(floorStr) as BuilderFloor;
            const layout = newLayouts[floor];
            if (!layout) return;
            newLayouts[floor] = resizeRoomsInLayout(layout, scaleFactor);
          });
        }
      } else if (
        deleteByIdCommands.length === 0 &&
        deleteCommands.length === 0 &&
        restoreWingBackgroundCommands.length === 0 &&
        addHallwayCommands.length === 0 &&
        addRoomCommands.length === 0 &&
        resizeRoomCommands.length === 0
      ) {
          Object.entries(generatedLayouts).forEach(([floorStr, layout]) => {
            if (!layout) return;
            const floor = Number(floorStr) as BuilderFloor;
            newLayouts[floor] = layout;
          });
      }

      const generatedFloors = Object.keys(newLayouts).map(Number).filter((value) => Number.isFinite(value)) as BuilderFloor[];
      if (!generatedFloors.length) {
        throw new Error("No generated floors");
      }

      applyLayoutChange(() => newLayouts, { recordHistory: true });
      const floorsAdded = generatedFloors.join(", ");
      setVisibleFloors(generatedFloors.sort((a, b) => a - b));
      const firstFloor = Math.min(...generatedFloors) as BuilderFloor;
      setActiveFloor(firstFloor);
      setSelection(null);
      setSelectedIds([]);
      setTool("select");
      applyLoadedMapView();
      if (options?.config) {
        setPreviousAutoGenerateConfig({ ...assistantBaseConfig });
        setLastAutoGenerateConfig(options.config);
      }
      setShowDraftsPopup(false);
      showToast(options?.successMessage ?? `Layout generated for floor(s): ${floorsAdded}`, "success");
      setStatusMessage(options?.statusMessage ?? `Layout auto-generated for floor(s): ${floorsAdded}`);
    } catch (error) {
      showToast("Failed to apply generated layout.", "danger");
      setStatusMessage("Failed to apply generated layout.");
    }
  };

  const handleLayoutGenerated = ({
    config,
    layouts,
  }: {
    config: AutoGenerateConfig;
    layouts: Partial<Record<number, Layout>>;
  }) => {
    applyGeneratedLayouts(layouts, { config });
  };

  const buildLocalAssistantPlan = useCallback(
    (
      prompt: string,
      baseConfig: AutoGenerateConfig
    ): {
      ok: boolean;
      reply: string;
      configPatch: Partial<AutoGenerateConfig>;
      baseConfig: AutoGenerateConfig;
      proposedConfig: AutoGenerateConfig;
      commands: Array<{ type: string; field: string; value: string }>;
      warnings: string[];
      assumptions: string[];
      requiresRegeneration: boolean;
    } | null => {
      const normalized = prompt.trim().toLowerCase();
      const addRoomsRequested =
        /\b(add|create|insert|put)\b/.test(normalized) &&
        /\brooms?\b/.test(normalized) &&
        !/\bhallways?\b/.test(normalized);
      const addHallwaysRequested =
        /\b(add|create|insert|put)\b/.test(normalized) &&
        /\bhallways?\b/.test(normalized);
      const roomResizeRequested =
        /\brooms?\b/.test(normalized) &&
        /\b(increase|enlarge|bigger|larger|expand|wider|taller)\b/.test(normalized) &&
        /\b(size|sizes?)\b/.test(normalized);
      const hallwayCleanupRequested =
        /\b(delete|remove)\b/.test(normalized) &&
        /\bhallways?\b/.test(normalized) &&
        /\b(misaligned|misplaced|overlapping|overlap|off|crooked|uneven|look misaligned|look misplaced)\b/.test(normalized);
      const removeWingBackgroundsRequested =
        /\b(delete|remove)\b/.test(normalized) &&
        /\b(gray|grey)\b/.test(normalized) &&
        /\b(box|boxes|background|backgrounds|slab|slabs)\b/.test(normalized);
      const restoreWingBackgroundRequested =
        /\b(gray|grey)\b/.test(normalized) &&
        /\b(box|boxes|background|backgrounds|slab|slabs)\b/.test(normalized) &&
        (
          /\b(each wing|every wing|all wings|on each wing|per wing|wing|wings)\b/.test(normalized) ||
          (/\b(put|place|wrap|enclose|surround|group)\b/.test(normalized) && /\b(room|rooms)\b/.test(normalized))
        );
      if (addRoomsRequested) {
        const activeLayout = layoutsByFloor[activeFloor];
        const roomTemplates = activeLayout?.rooms.filter((room) => room.kind === "room" && room.rect) ?? [];
        const requestedCount = parseRequestedRoomCount(normalized);
        const addableCount = roomTemplates.length ? requestedCount : 0;
        return {
          ok: true,
          reply: addableCount
            ? `I prepared ${addableCount} additional room${addableCount === 1 ? "" : "s"} on Floor ${activeFloor} without regenerating the layout.`
            : `There are no existing room templates on Floor ${activeFloor} to duplicate into additional rooms.`,
          configPatch: {},
          baseConfig,
          proposedConfig: baseConfig,
          commands: addableCount ? [{ type: "addRoomsFromCanvas", field: String(activeFloor), value: String(addableCount) }] : [],
          warnings: [],
          assumptions: [
            `Interpreted the request as duplicating existing room geometry on Floor ${activeFloor} rather than regenerating and replacing the full layout.`
          ],
          requiresRegeneration: false,
        };
      }
      if (addHallwaysRequested) {
        const floors = sortedFloorNumbersFromLayouts(layoutsByFloor);
        const hallwayCount = floors.reduce((total, floorNum) => {
          const layout = layoutsByFloor[floorNum];
          if (!layout) return total;
          const normalizedLayout = normalizeRoutingHallwayRooms(layout, floorNum as BuilderFloor);
          const existingIds = new Set(normalizedLayout.rooms.map((room) => room.id));
          return (
            total +
            deriveAutoHallwayOverlays(normalizedLayout, floorNum as BuilderFloor).filter((overlay) => !existingIds.has(overlay.id)).length
          );
        }, 0);
        return {
          ok: true,
          reply: hallwayCount
            ? `I prepared ${hallwayCount} hallway${hallwayCount === 1 ? "" : "s"} from the current layout geometry.`
            : "The current layout already has the expected generated hallways, so there are no new hallways to add.",
          configPatch: {},
          baseConfig,
          proposedConfig: baseConfig,
          commands: hallwayCount ? [{ type: "addHallwaysFromCanvas", field: "scope", value: "allVisibleFloors" }] : [],
          warnings: [],
          assumptions: [
            "Interpreted the request as generating hallway overlay rooms from the existing room arrangement on the current canvas rather than regenerating the full layout."
          ],
          requiresRegeneration: false,
        };
      }
      if (roomResizeRequested) {
        const scaleFactor = /\b(slightly|a little|a bit)\b/.test(normalized)
          ? 1.1
          : /\b(much|significantly|a lot)\b/.test(normalized)
            ? 1.25
            : 1.15;
        return {
          ok: true,
          reply: `I resized the current room boxes to ${Math.round(scaleFactor * 100)}% of their previous size without regenerating the layout.`,
          configPatch: {},
          baseConfig,
          proposedConfig: baseConfig,
          commands: [{ type: "resizeAllRoomsOnCanvas", field: "scaleFactor", value: String(scaleFactor) }],
          warnings: [],
          assumptions: [
            "Interpreted the request as enlarging the existing room rectangles on the current canvas rather than regenerating a new room layout."
          ],
          requiresRegeneration: false,
        };
      }
      if (removeWingBackgroundsRequested) {
        const wingBackgroundCount = sortedFloorNumbersFromLayouts(layoutsByFloor).reduce((total, floorNum) => {
          const layout = layoutsByFloor[floorNum];
          if (!layout) return total;
          return total + layout.rooms.filter((room) => room.kind === "wing_background").length;
        }, 0);
        return {
          ok: true,
          reply: wingBackgroundCount
            ? `I prepared ${wingBackgroundCount} gray background box${wingBackgroundCount === 1 ? "" : "es"} for removal.`
            : "There are no gray background boxes to remove.",
          configPatch: {},
          baseConfig,
          proposedConfig: baseConfig,
          commands: wingBackgroundCount ? [{ type: "deleteAllElements", field: "elementType", value: "wing_background" }] : [],
          warnings: [],
          assumptions: [
            "Interpreted gray boxes as wing background slabs on the current canvas and removed them directly without regenerating the layout."
          ],
          requiresRegeneration: false,
        };
      }
      if (restoreWingBackgroundRequested) {
        return {
          ok: true,
          reply: "I restored gray wing backgrounds for the wings visible in the current layout.",
          configPatch: {},
          baseConfig,
          proposedConfig: baseConfig,
          commands: [{ type: "restoreWingBackgroundsFromCanvas", field: "scope", value: "allVisibleFloors" }],
          warnings: [],
          assumptions: [
            "Interpreted the request as rebuilding wing background slabs from the current canvas geometry rather than regenerating the room layout."
          ],
          requiresRegeneration: false,
        };
      }

      if (!hallwayCleanupRequested) return null;

      const hallwayIds = findMisalignedHallwayIdsForLayouts(layoutsByFloor);
      const deletedCount = hallwayIds.length;
      return {
        ok: true,
        reply: deletedCount
          ? `I found ${deletedCount} hallway${deletedCount === 1 ? "" : "s"} that look overlapping or misaligned and prepared them for removal.`
          : "I checked the hallway geometry and did not find any hallways that look overlapping or misaligned enough to remove.",
        configPatch: {},
        baseConfig,
        proposedConfig: baseConfig,
        commands: deletedCount
          ? [{ type: "deleteRoomsById", field: "roomIds", value: hallwayIds.join(",") }]
          : [],
        warnings: [],
        assumptions: [
          "Interpreted overlapping or misaligned hallways as generated hallway strips that still expose routing ids as visible labels, are unusually small, have irregular hallway thickness, overlap other layout elements, or whose geometry no longer matches the expected hallway overlay for the surrounding layout."
        ],
        requiresRegeneration: false,
      };
    },
    [layoutsByFloor]
  );

  const resetToBlankNewMapInMemory = (): { viewBox: { w: number; h: number } } => {
    const blankCanonicalMapLayout = cloneCanonicalMapLayout(fallbackCanonicalLayout());
    const blankLayouts = createEmptyLayoutsFromCanonical(blankCanonicalMapLayout);
    const blankInitialLayouts: LayoutsByFloor = {
      1: cloneLayout(blankLayouts[1]),
    };
    setEditorBaseMapLayout(blankCanonicalMapLayout);
    applyLayoutChange(() => cloneLayoutsByFloor(blankInitialLayouts), { recordHistory: false });
    setVisibleFloors([1]);
    setActiveFloor(1);
    setSelection(null);
    setSelectedIds([]);
    setTool("select");
    setLastAutoGenerateConfig(null);
    applyLoadedMapView();
    undoStackRef.current = [];
    setUndoCount(0);
    setLoadedDraftFilename(null);
    setActiveDraftKey(CURRENT_SANDBOX_DRAFT_KEY);
    setDoorIndicatorsByFloor({});
    return { viewBox: { ...blankCanonicalMapLayout.viewBox } };
  };

  const saveAndLoadNewMapDraft = async (
    draftId: string,
    options?: { source?: string; note?: string }
  ): Promise<{ filename: string; deletedCount: number; viewBox: { w: number; h: number } } | null> => {
    const blankCanonicalMapLayout = cloneCanonicalMapLayout(fallbackCanonicalLayout());
    const blankLayouts = createEmptyLayoutsFromCanonical(blankCanonicalMapLayout);
    const blankInitialLayouts: LayoutsByFloor = {
      1: cloneLayout(blankLayouts[1]),
    };
    const createdAt = new Date().toISOString();
    const draft = buildSvgDraftFromLayouts(blankInitialLayouts, {
      draftId,
      createdAt,
      source: options?.source ?? "layout-config-new-map",
      note: options?.note ?? "Created as a blank building plan draft",
      baseMapLayout: blankCanonicalMapLayout,
    });

    const res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/draft-maps/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft, displayName: draftId }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      filename?: string;
      deleted?: string[];
    };
    if (!res.ok || !payload?.ok || typeof payload.filename !== "string" || !payload.filename.trim()) {
      return null;
    }

    await refreshDraftFiles();
    setEditorBaseMapLayout(blankCanonicalMapLayout);
    applyLayoutChange(() => cloneLayoutsByFloor(blankInitialLayouts), { recordHistory: false });
    setVisibleFloors([1]);
    setActiveFloor(1);
    setSelection(null);
    setSelectedIds([]);
    setTool("select");
    setLastAutoGenerateConfig(null);
    applyLoadedMapView();
    undoStackRef.current = [];
    setUndoCount(0);
    setLoadedDraftFilename(payload.filename);
    setActiveDraftKey(buildDraftOptionKey(payload.filename));
    setSvgListTab("drafts");
    setShowDraftsPopup(false);
    setHoveredDraftKey(null);
    setDoorIndicatorsByFloor({});

    const deletedCount = Array.isArray(payload.deleted) ? payload.deleted.length : 0;
    return { filename: payload.filename, deletedCount, viewBox: { ...blankCanonicalMapLayout.viewBox } };
  };

  const createNewMapDraft = async () => {
    if (isUiBlocked) return;
    const nextName = newMapName.trim();
    if (!nextName) {
      setNewMapError("Map name is required.");
      return;
    }
    const normalizedName = nextName.toLowerCase();
    const duplicate = allDraftOptions.some((item) => item.draftId.trim().toLowerCase() === normalizedName);
    if (duplicate) {
      const message = `Map name already exists: ${nextName}.`;
      setNewMapError(message);
      setStatusMessage(message);
      showToast(message, "danger");
      return;
    }

    setBlockingAction("save");
    try {
      const result = await saveAndLoadNewMapDraft(nextName);
      if (!result) {
        throw new Error("Failed to create new map draft.");
      }
      closeNewMapModal();

      if (result.deletedCount > 0) {
        setStatusMessage(`New map created: ${nextName}. Oldest draft removed to keep max ${SANDBOX_DRAFT_LIMIT}.`);
        showToast(`New map created: ${nextName}. Oldest draft removed.`, "info");
      } else {
        setStatusMessage(`New map created: ${nextName}.`);
        showToast(`New map created: ${nextName}`, "success");
      }
    } catch {
      const message = "Failed to create new map.";
      setNewMapError(message);
      setStatusMessage(message);
      showToast(message, "danger");
    } finally {
      setBlockingAction(null);
    }
  };

  const publishLayout = async () => {
    if (isUiBlocked) return;
    setBlockingAction("publish");
    showToast("Publishing sandbox layout...", "success");
    const nextMapLayout = buildMainLayoutJsonFromLayouts(layoutsByFloor, editorBaseMapLayout);

    try {
      const publishUrl = `${SANDBOX_SERVICE_BASE_URL}/map-layout/publish`;
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

      // Immediately load the exact layout we just published, preserving rotation on rect rooms.
      setCanonicalMapLayout(nextMapLayout);
      setEditorBaseMapLayout(cloneCanonicalMapLayout(nextMapLayout));
      applyLayoutChange((prev) => {
        const reloaded = mapLayoutToLayoutsByFloor(nextMapLayout);
        (Object.keys(reloaded) as unknown as BuilderFloor[]).forEach((floor) => {
          reloaded[floor].rooms.forEach((room) => {
            if (room.rect) {
              const prevRoom = prev[floor]?.rooms.find((r) => r.id === room.id);
              if (prevRoom?.rect?.rotation) {
                room.rect.rotation = prevRoom.rect.rotation;
              }
            }
          });
        });
        return reloaded;
      }, { recordHistory: false });
      applyLoadedMapView();
      undoStackRef.current = [];
      setUndoCount(0);
      setActiveDraftKey(CURRENT_SANDBOX_DRAFT_KEY);
      setLoadedDraftFilename(null);
      setSelection(null);

      localStorage.setItem(MAP_LAYOUT_REFRESH_PENDING_KEY, "1");
      setLoadedDraftFilename(null);
      setStatusMessage("Layout published successfully.");
      showToast("Sandbox layout published successfully.", "success");

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
        setStatusMessage("Failed to publish sandbox layout.");
        showToast("Failed to publish sandbox layout.", "danger");
      }
    } finally {
      setBlockingAction(null);
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
    <div className="layout-config-page sandbox-layout-config-page">
      <SandboxTopNavBar />
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
                    Sandbox Layout + History
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
                            draft.key === CURRENT_SANDBOX_DRAFT_KEY ? " is-main-current" : ""
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
                          (svgListTab === "main" && draft.key !== CURRENT_SANDBOX_DRAFT_KEY)) ? (
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
                        {((svgListTab === "drafts" && draft.isDraftFile) ||
                          (svgListTab === "main" && draft.key !== CURRENT_SANDBOX_DRAFT_KEY)) ? (
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
                <MDBBtn className="layout-action-btn" onClick={() => setIsLayoutGeneratorOpen(true)} disabled={loadingDraftKey !== null}>
                  AUTO-GENERATE LAYOUT
                </MDBBtn>
                <MDBBtn className="layout-action-btn layout-new-map-btn" onClick={openNewMapModal} disabled={loadingDraftKey !== null}>
                  ADD NEW MAP
                </MDBBtn>
                <MDBBtn className="layout-action-btn" onClick={() => setShowDraftsPopup(false)}>
                  Close
                </MDBBtn>
              </MDBModalFooter>
            </MDBModalContent>
          </MDBModalDialog>
        </MDBModal>
        <MDBModal open={isNewMapModalOpen} setOpen={() => closeNewMapModal()} tabIndex="-1">
          <MDBModalDialog centered>
            <MDBModalContent className="draft-rename-modal-content">
              <MDBModalHeader className="draft-rename-modal-header">
                <MDBModalTitle className="draft-rename-modal-title">
                  <i className="fas fa-map" aria-hidden="true" />
                  Create New Map
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-rename-modal-body">
                <p>Create a fresh blank map layout draft for a new building plan.</p>
                <input
                  type="text"
                  className="draft-rename-input"
                  value={newMapName}
                  onChange={(e) => {
                    setNewMapName(e.target.value);
                    if (newMapError) setNewMapError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void createNewMapDraft();
                    }
                  }}
                  placeholder="e.g. Engineering Building Plan"
                  autoFocus
                />
                {newMapError ? <div className="draft-rename-error">{newMapError}</div> : null}
              </MDBModalBody>
              <MDBModalFooter className="draft-rename-modal-footer">
                <MDBBtn color="secondary" className="draft-rename-cancel-btn" onClick={closeNewMapModal}>
                  Cancel
                </MDBBtn>
                <MDBBtn className="draft-rename-confirm-btn" onClick={() => void createNewMapDraft()}>
                  Create Map
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
                  {draftToDelete?.isDraftFile ? "Delete Draft Map" : "Delete Sandbox Layout History"}
                </MDBModalTitle>
              </MDBModalHeader>
              <MDBModalBody className="draft-delete-modal-body">
                {draftToDelete ? (
                  <p>
                    Delete <strong>{draftToDelete.filename}</strong> from the Sandbox map layouts list?
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
                  {draftToRename?.isDraftFile ? "Rename Sandbox Draft" : "Rename Sandbox Layout History"}
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
        <LayoutGeneratorModal
          isOpen={isLayoutGeneratorOpen}
          onClose={() => setIsLayoutGeneratorOpen(false)}
          onGenerate={handleLayoutGenerated}
        />
        <LayoutAssistantModal
          isOpen={isLayoutAssistantOpen}
          onClose={() => setIsLayoutAssistantOpen(false)}
          baseConfig={assistantBaseConfig}
          previousConfig={previousAutoGenerateConfig}
          currentLayoutSummary={currentLayoutSummary}
          onUndoRequest={() => {
            if (undoStackRef.current.length === 0) return false;
            undoLayoutChange();
            return true;
          }}
          buildLocalPlan={buildLocalAssistantPlan}
          onApplyPreview={({ config, layouts, reply, commands }) =>
            applyGeneratedLayouts(layouts, {
              config,
              commands,
              successMessage: "Assistant preview applied.",
              statusMessage: reply,
            })
          }
        />
        <section className="layout-config-toolbar">
          <div className="layout-config-title-wrap">
            <div className="layout-config-title-row">
              <div className="layout-config-title-meta">
                <h1 className="layout-config-ribbon-title">Sandbox Layout Builder</h1>
                <div
                  className="layout-config-loaded-badge"
                  title={`Loaded: ${currentLoadedMapMeta.displayName} (${currentLoadedMapMeta.filename})`}
                >
                  <span className="layout-config-loaded-tag">Loaded</span>
                  <span className="layout-config-loaded-details">
                    <span className="layout-config-loaded-name-row">
                      <span className="layout-config-loaded-name">{currentLoadedMapMeta.displayName}</span>
                      {currentLoadedDraftOption?.key !== CURRENT_SANDBOX_DRAFT_KEY ? (
                        <>
                          <button
                            type="button"
                            className="layout-config-loaded-edit-btn"
                            aria-label={`Rename ${currentLoadedMapMeta.displayName}`}
                            title={`Rename ${currentLoadedMapMeta.displayName}`}
                            onClick={renameCurrentLoadedMap}
                          >
                            <i className="fas fa-pen" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="layout-config-loaded-delete-btn"
                            aria-label={`Delete ${currentLoadedMapMeta.displayName}`}
                            title={`Delete ${currentLoadedMapMeta.displayName}`}
                            onClick={deleteCurrentLoadedMap}
                          >
                            <i className="fas fa-trash" aria-hidden="true" />
                          </button>
                        </>
                      ) : null}
                    </span>
                    <span className="layout-config-loaded-file-row">
                      <span className="layout-config-loaded-file">{currentLoadedMapMeta.filename}</span>
                    </span>
                  </span>
                </div>
              </div>
              <div className="layout-config-title-actions">
                <MDBBtn className="layout-action-btn layout-new-map-btn" onClick={openNewMapModal} disabled={isUiBlocked}>
                  NEW MAP
                </MDBBtn>
                <div className="layout-config-title-actions-stack">
                  <MDBBtn
                    className="layout-action-btn layout-auto-generate-btn"
                    onClick={() => setIsLayoutGeneratorOpen(true)}
                    disabled={isUiBlocked}
                  >
                    AUTO-GENERATE
                    <br />
                    LAYOUT
                  </MDBBtn>
                  <input
                    ref={referenceFileInputRef}
                    type="file"
                    accept="image/*,application/pdf,.pdf"
                    style={{ display: "none" }}
                    onChange={handleReferenceImageUpload}
                  />
                  <MDBBtn
                    className="layout-action-btn layout-upload-floorplan-btn"
                    onClick={() => referenceFileInputRef.current?.click()}
                    disabled={isUiBlocked}
                    title="Upload a 2D floor plan (DWG, DXF, PDF, DWF, BMP, JPG, PNG, TIFF) to auto-generate a new map."
                  >
                    UPLOAD FLOOR PLAN
                  </MDBBtn>
                </div>
                <MDBBtn
                  className="layout-action-btn layout-auto-generate-btn layout-layout-assistant-btn"
                  onClick={() => setIsLayoutAssistantOpen(true)}
                  disabled={isUiBlocked}
                >
                  LAYOUT
                  <br />
                  ASSISTANT
                </MDBBtn>
                <MDBBtn
                  className="layout-action-btn layout-open-drafts-btn"
                  onClick={openMapLayoutsModal}
                >
                  MAP LAYOUTS
                </MDBBtn>
                <MDBBtn className="layout-action-btn layout-save-btn" onClick={() => void saveLayout()} disabled={isUiBlocked}>
                  SAVE DRAFT
                </MDBBtn>
                <div className="layout-config-title-actions-stack">
                  <MDBBtn className="layout-action-btn layout-publish-btn" onClick={publishLayout} disabled={isUiBlocked}>
                    Publish
                  </MDBBtn>
                </div>
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
                        activateTool(toolKey);
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
                        activateTool(toolKey);
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
                  activateTool("select");
                }}
                title="Select mode"
              >
              <i className="fas fa-mouse-pointer" aria-hidden="true" />
              <span>SELECT</span>
            </MDBBtn>
            <MDBBtn
                className={`layout-action-btn layout-action-light-gray layout-toolbar-pan-btn${tool === "pan" ? " is-active" : ""}`}
                onClick={() => {
                  activateTool("pan");
                }}
                title="Pan mode"
              >
              <i className="fas fa-hand-paper" aria-hidden="true" />
              <span>PAN</span>
            </MDBBtn>
            {tool === "select" ? (
              <label
                className="layout-component-picker"
                aria-label={`Select a component on floor ${activeFloor}`}
                title={`Select and jump to a component on floor ${activeFloor}.`}
              >
                <span className="layout-component-picker__label">Component</span>
                <select
                  className="layout-component-picker__select"
                  value={selectedRoom?.id ?? ""}
                  onChange={(event) => {
                    selectComponentFromDropdown(event.target.value);
                  }}
                  disabled={isUiBlocked || !selectableComponentOptions.length}
                >
                  <option value="">
                    {selectableComponentOptions.length
                      ? `Select floor ${activeFloor} component...`
                      : `No components on floor ${activeFloor}`}
                  </option>
                  {selectableComponentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span className="layout-toolbar-pan-hint">Use mouse for zoom</span>
            {tool === "polygon_room" ? (
              <span className="layout-toolbar-pan-hint">Click to add points, double-click or press Enter to finish</span>
            ) : null}
            <div className="layout-tool-break" />
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
                  className={`layout-tool-btn layout-canvas-pan-btn${tool === "select" ? " is-active" : ""}`}
                  onClick={() => {
                    activateTool("select");
                  }}
                  title="Select mode for components"
                >
                  <i className="fas fa-mouse-pointer" aria-hidden="true" />
                  <span>SELECT</span>
                </MDBBtn>
                <MDBBtn
                  className={`layout-tool-btn layout-canvas-pan-btn${tool === "pan" ? " is-active" : ""}`}
                  onClick={() => {
                    activateTool("pan");
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
              dragDistance={6}
              onWheel={onWheel}
              onMouseDown={onStageMouseDown}
              onMouseMove={onStageMouseMove}
              onMouseUp={onStageMouseUp}
              onDblClick={() => {
                if (tool === "polygon_room" && polygonDraft?.points?.length) {
                  finishPolygonDraft();
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
                      listening={!isUiBlocked && tool === "select"}
                      onClick={() => {
                        if (tool !== "select") return;
                        selectAutoHallwayOverlay(overlay);
                      }}
                      onTap={() => {
                        if (tool !== "select") return;
                        selectAutoHallwayOverlay(overlay);
                      }}
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
                    const isInteractiveInSelectMode = !isUiBlocked && tool === "select";
                    if (room.rect) {
                      const isRotatable = room.kind === "room" || room.kind === "lounge" || room.kind === "stairs";
                      const visualRotation = (rotateStartRef.current?.roomId === room.id && rotationDraft !== null)
                        ? rotationDraft
                        : (room.rect.rotation ?? 0);
                      const rectCx = room.rect.x + room.rect.w / 2;
                      const rectCy = room.rect.y + room.rect.h / 2;

                      if (isRotatable) {
                        return (
                          <Group
                            key={room.id}
                            ref={isSelected ? selectedWingBackgroundNodeRef : undefined}
                            x={rectCx}
                            y={rectCy}
                            rotation={visualRotation}
                            draggable={isInteractiveInSelectMode && isSelected}
                            listening={isInteractiveInSelectMode}
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
                            {/* Hit area – also draggable when not yet selected */}
                            <Rect
                              x={-room.rect.w / 2 - COMPONENT_HIT_PADDING}
                              y={-room.rect.h / 2 - COMPONENT_HIT_PADDING}
                              width={room.rect.w + COMPONENT_HIT_PADDING * 2}
                              height={room.rect.h + COMPONENT_HIT_PADDING * 2}
                              cornerRadius={(room.rect.r ?? 8) + COMPONENT_HIT_PADDING}
                              fill="rgba(15, 23, 42, 0.001)"
                              strokeEnabled={false}
                              listening={true}
                            />
                            {/* Visual rect */}
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
                            {/* Label centered at group origin, rotates with the room */}
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
                          {isInteractiveInSelectMode ? (
                            <Rect
                              x={room.rect.x - COMPONENT_HIT_PADDING}
                              y={room.rect.y - COMPONENT_HIT_PADDING}
                              width={room.rect.w + COMPONENT_HIT_PADDING * 2}
                              height={room.rect.h + COMPONENT_HIT_PADDING * 2}
                              cornerRadius={(room.rect.r ?? 8) + COMPONENT_HIT_PADDING}
                              fill="rgba(15, 23, 42, 0.001)"
                              strokeEnabled={false}
                              draggable={isSelected}
                              listening={isInteractiveInSelectMode}
                              onDragEnd={(e) => {
                                if (!isSelected) return;
                                const nextX = snap(e.target.x() + COMPONENT_HIT_PADDING);
                                const nextY = snap(e.target.y() + COMPONENT_HIT_PADDING);
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
                              onClick={(evt) =>
                                handleRoomSelection(room.id, Boolean(evt.evt?.shiftKey || evt.evt?.ctrlKey || evt.evt?.metaKey))
                              }
                              onTap={() => handleRoomSelection(room.id)}
                            />
                          ) : null}
                          <Rect
                            ref={isSelected ? selectedWingBackgroundNodeRef : undefined}
                            x={room.rect.x}
                            y={room.rect.y}
                            width={room.rect.w}
                            height={room.rect.h}
                            cornerRadius={room.rect.r ?? 8}
                            fill={style.fill}
                            stroke={isSelected ? "#1d4ed8" : style.stroke}
                            strokeWidth={isSelected ? 3 : 2}
                            draggable={isInteractiveInSelectMode && isSelected}
                            listening={isInteractiveInSelectMode}
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
                                node.rotation(0);
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
                              text={room.wingName ?? (room.wing ? `Wing ${room.wing}` : "Wing")}
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
                          {isInteractiveInSelectMode ? (
                            <Line
                              points={polyToFlatPoints(room.poly.points)}
                              closed
                              fill="rgba(15, 23, 42, 0.001)"
                              stroke="rgba(15, 23, 42, 0.001)"
                              strokeWidth={1}
                              hitStrokeWidth={COMPONENT_HIT_STROKE_WIDTH}
                              draggable={isSelected}
                              listening={isInteractiveInSelectMode}
                              onDragEnd={(e) => {
                                if (!isSelected) return;
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
                          ) : null}
                          <Line
                            points={polyToFlatPoints(room.poly.points)}
                            closed
                            fill={style.fill}
                            stroke={isSelected ? "#1d4ed8" : style.stroke}
                            strokeWidth={isSelected ? 3 : 2}
                            draggable={isInteractiveInSelectMode && isSelected}
                            listening={isInteractiveInSelectMode}
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
                          {isInteractiveInSelectMode && isSelected
                            ? room.poly.points.map((point, pointIndex) => (
                                <Rect
                                  key={`${room.id}-vertex-${pointIndex}`}
                                  x={point.x - POLYGON_VERTEX_HIT_RADIUS}
                                  y={point.y - POLYGON_VERTEX_HIT_RADIUS}
                                  width={POLYGON_VERTEX_HIT_RADIUS * 2}
                                  height={POLYGON_VERTEX_HIT_RADIUS * 2}
                                  cornerRadius={999}
                                  fill="#ffffff"
                                  stroke="#2563eb"
                                  strokeWidth={2}
                                  draggable
                                  onDragEnd={(e) => {
                                    const nextX = snap(e.target.x() + POLYGON_VERTEX_HIT_RADIUS);
                                    const nextY = snap(e.target.y() + POLYGON_VERTEX_HIT_RADIUS);
                                    e.target.position({
                                      x: nextX - POLYGON_VERTEX_HIT_RADIUS,
                                      y: nextY - POLYGON_VERTEX_HIT_RADIUS,
                                    });
                                    updateRoom(room.id, (prevRoom) =>
                                      replaceRoomPolygonPoint(prevRoom, pointIndex, { x: nextX, y: nextY })
                                    );
                                  }}
                                />
                              ))
                            : null}
                        </Group>
                      );
                    }

                    return null;
                  })}

                  {(doorIndicatorsByFloor[activeFloor] ?? []).map((door, doorIndex) => (
                    <Line
                      key={`door-indicator-${doorIndex}`}
                      points={[door.x1, door.y1, door.x2, door.y2]}
                      stroke="#92400e"
                      strokeWidth={4}
                      lineCap="round"
                      dash={[6, 4]}
                      listening={false}
                    />
                  ))}

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

                  {/* Corner rotation handles for room / lounge / stairs */}
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
                    <span>Wing Name (Select or type new name)</span>
                    <div
                      ref={wingNameComboRef}
                      className={`layout-props-combobox${isWingNameMenuOpen ? " is-open" : ""}`}
                    >
                      <div className="layout-props-combobox-control">
                        <input
                          type="text"
                          role="combobox"
                          aria-expanded={isWingNameMenuOpen}
                          aria-controls="sandbox-layout-builder-wing-name-options"
                          aria-autocomplete="list"
                          value={wingNameDraft}
                          placeholder="Wing A"
                          onFocus={() => setIsWingNameMenuOpen(true)}
                          onChange={(e) => {
                            const nextValue = e.target.value;
                            setWingNameDraft(nextValue);
                            updateSelectedWingBackgroundNameDraft(nextValue);
                            setIsWingNameMenuOpen(true);
                          }}
                          onBlur={(e) => commitSelectedWingBackgroundName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              commitSelectedWingBackgroundName((e.target as HTMLInputElement).value);
                              setIsWingNameMenuOpen(false);
                            }
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              setIsWingNameMenuOpen(true);
                            }
                            if (e.key === "Escape") {
                              setIsWingNameMenuOpen(false);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="layout-props-combobox-toggle"
                          aria-label="Toggle wing name options"
                          aria-expanded={isWingNameMenuOpen}
                          onClick={() => setIsWingNameMenuOpen((prev) => !prev)}
                        >
                          <i className={`fas ${isWingNameMenuOpen ? "fa-chevron-up" : "fa-chevron-down"}`} aria-hidden="true" />
                        </button>
                      </div>
                      {isWingNameMenuOpen ? (
                        <div
                          id="sandbox-layout-builder-wing-name-options"
                          className="layout-props-combobox-menu"
                          role="listbox"
                        >
                          {filteredWingNameOptions.length ? (
                            filteredWingNameOptions.map((option) => (
                              <button
                                key={option}
                                type="button"
                                role="option"
                                className={`layout-props-combobox-option${option === wingNameDraft ? " is-active" : ""}`}
                                aria-selected={option === wingNameDraft}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => applyWingNameOption(option)}
                              >
                                {option}
                              </button>
                            ))
                          ) : (
                            <div className="layout-props-combobox-empty">No matching wings</div>
                          )}
                        </div>
                      ) : null}
                    </div>
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
                          disabled={isUiBlocked || !selectedHallwayLayerState.canSendToBack}
                        >
                          Send to Back
                        </button>
                        <button
                          type="button"
                          className="layout-tool-btn"
                          onClick={() => moveSelectedCorridorLayer("front")}
                          disabled={isUiBlocked || !selectedHallwayLayerState.canSendToFront}
                        >
                          Bring to Front
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>Corridor Length</span>
                      <div className="layout-props-dim-row">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(Math.max(selectedRoom.rect.w, selectedRoom.rect.h))}
                          onChange={(e) => updateSelectedCorridorDimension("length", e.target.value)}
                        />
                        <span className="layout-props-dim-hint">{pxToM(Math.max(selectedRoom.rect.w, selectedRoom.rect.h))}</span>
                      </div>
                    </label>
                    <label>
                      <span>Corridor Thickness</span>
                      <div className="layout-props-dim-row">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(Math.min(selectedRoom.rect.w, selectedRoom.rect.h))}
                          onChange={(e) => updateSelectedCorridorDimension("thickness", e.target.value)}
                        />
                        <span className="layout-props-dim-hint">{pxToM(Math.min(selectedRoom.rect.w, selectedRoom.rect.h))}</span>
                      </div>
                    </label>
                    <label>
                      <span>Thickness Presets</span>
                      <div className="layout-props-layer-actions">
                        {[30, 40, 50, 60].map((size) => (
                          <button
                            key={size}
                            type="button"
                            className={`layout-tool-btn${Math.round(Math.min(selectedRoom.rect!.w, selectedRoom.rect!.h)) === size ? " is-active" : ""}`}
                            onClick={() => updateSelectedCorridorDimension("thickness", String(size))}
                            disabled={isUiBlocked}
                          >
                            {size}px
                          </button>
                        ))}
                      </div>
                    </label>
                    <label>
                      <span>Length Presets</span>
                      <div className="layout-props-layer-actions">
                        {[80, 120, 200, 320].map((size) => (
                          <button
                            key={size}
                            type="button"
                            className={`layout-tool-btn${Math.round(Math.max(selectedRoom.rect!.w, selectedRoom.rect!.h)) === size ? " is-active" : ""}`}
                            onClick={() => updateSelectedCorridorDimension("length", String(size))}
                            disabled={isUiBlocked}
                          >
                            {size}px
                          </button>
                        ))}
                      </div>
                    </label>
                    <label>
                      <span>Circulation Cleanup</span>
                      <button type="button" className="layout-tool-btn" onClick={straightenSelectedCorridor}>
                        Straighten
                      </button>
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
                    onBlur={(e) =>
                      selectedRoom.rect
                        ? commitSelectedRoomRect("x", e.target.value)
                        : commitSelectedRoomPolyBounds("x", e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (selectedRoom.rect) {
                          commitSelectedRoomRect("x", (e.target as HTMLInputElement).value);
                        } else {
                          commitSelectedRoomPolyBounds("x", (e.target as HTMLInputElement).value);
                        }
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
                    onBlur={(e) =>
                      selectedRoom.rect
                        ? commitSelectedRoomRect("y", e.target.value)
                        : commitSelectedRoomPolyBounds("y", e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (selectedRoom.rect) {
                          commitSelectedRoomRect("y", (e.target as HTMLInputElement).value);
                        } else {
                          commitSelectedRoomPolyBounds("y", (e.target as HTMLInputElement).value);
                        }
                      }
                    }}
                    disabled={!selectedRoom.rect && !selectedRoom.poly}
                  />
                </label>
                <label>
                  <span>Width</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rectDraft.w}
                    onChange={(e) => setRectDraft((prev) => ({ ...prev, w: e.target.value }))}
                    onBlur={(e) =>
                      selectedRoom.rect
                        ? commitSelectedRoomRect("w", e.target.value)
                        : commitSelectedRoomPolyBounds("w", e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (selectedRoom.rect) {
                          commitSelectedRoomRect("w", (e.target as HTMLInputElement).value);
                        } else {
                          commitSelectedRoomPolyBounds("w", (e.target as HTMLInputElement).value);
                        }
                      }
                    }}
                    disabled={!selectedRoom.rect && !selectedRoom.poly}
                  />
                </label>
                <label>
                  <span>Height</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rectDraft.h}
                    onChange={(e) => setRectDraft((prev) => ({ ...prev, h: e.target.value }))}
                    onBlur={(e) =>
                      selectedRoom.rect
                        ? commitSelectedRoomRect("h", e.target.value)
                        : commitSelectedRoomPolyBounds("h", e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (selectedRoom.rect) {
                          commitSelectedRoomRect("h", (e.target as HTMLInputElement).value);
                        } else {
                          commitSelectedRoomPolyBounds("h", (e.target as HTMLInputElement).value);
                        }
                      }
                    }}
                    disabled={!selectedRoom.rect && !selectedRoom.poly}
                  />
                </label>
                {selectedRoom.poly?.points?.length ? (
                  <div className="layout-props-polygon-editor">
                    <div className="layout-props-measurements-title">Irregular Shape Points</div>
                    <div className="layout-props-layer-actions">
                      <button type="button" className="layout-tool-btn" onClick={addSelectedPolygonVertex}>
                        Add Vertex
                      </button>
                      <button
                        type="button"
                        className="layout-tool-btn"
                        onClick={removeSelectedPolygonVertex}
                        disabled={selectedRoom.poly.points.length <= 3}
                      >
                        Remove Last
                      </button>
                    </div>
                    {selectedRoom.poly.points.map((point, pointIndex) => (
                      <div
                        key={`${selectedRoom.id}-point-${pointIndex}-${point.x}-${point.y}`}
                        className="layout-props-polygon-point-row"
                      >
                        <span>P{pointIndex + 1}</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          defaultValue={String(point.x)}
                          onBlur={(e) => commitSelectedPolygonPoint(pointIndex, "x", e.target.value)}
                        />
                        <input
                          type="text"
                          inputMode="numeric"
                          defaultValue={String(point.y)}
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
      <SandboxFooter />
    </div>
  );
}
