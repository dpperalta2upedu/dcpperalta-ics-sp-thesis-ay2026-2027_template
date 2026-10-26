import type { Layout, LayoutPoint, LayoutRoom, LayoutRoomKind, WingId } from "./layout.schema";

type Style = {
  fill: string;
  stroke: string;
};

const ROOM_STYLE_BY_KIND: Record<LayoutRoomKind, Style> = {
  room: { fill: "#f8fafc", stroke: "#334155" },
  lounge: { fill: "#dbeafe", stroke: "#1d4ed8" },
  stairs: { fill: "#ede9fe", stroke: "#6d28d9" },
  elevator: { fill: "#fef9c3", stroke: "#a16207" },
  hallway: { fill: "#fee2e2", stroke: "#b91c1c" },
  bridge: { fill: "#ffedd5", stroke: "#c2410c" },
  entrance: { fill: "#fecaca", stroke: "#991b1b" },
  wing_background: { fill: "#cbd5e1", stroke: "#94a3b8" },
};

export const ROOM_STYLE_BY_WING: Record<WingId, Style> = {
  A: { fill: "#fdf6d4", stroke: "#fbdc70" },
  B: { fill: "#dbeafe", stroke: "#60a5fa" },
  C: { fill: "#dcfce7", stroke: "#86efac" },
  D: { fill: "#fae8ff", stroke: "#d946ef" },
  E: { fill: "#ffe4e6", stroke: "#fb7185" },
};

const escapeXml = (raw: string): string =>
  raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function roomStyle(kind: LayoutRoomKind, wing?: WingId, fillOverride?: string): Style {
  if (kind === "room") {
    const base = ROOM_STYLE_BY_WING[wing ?? "A"];
    return fillOverride ? { ...base, fill: fillOverride } : base;
  }
  return ROOM_STYLE_BY_KIND[kind];
}

export function polyToFlatPoints(points: LayoutPoint[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

export function roomLabelPosition(room: LayoutRoom): LayoutPoint {
  if (room.label) {
    return { x: room.label.x, y: room.label.y };
  }
  if (room.rect) {
    return {
      x: room.rect.x + room.rect.w / 2,
      y: room.rect.y + room.rect.h / 2,
    };
  }
  const points = room.poly?.points ?? [];
  if (!points.length) return { x: 0, y: 0 };
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function roomToSvg(room: LayoutRoom): string {
  const style = roomStyle(room.kind, room.wing, room.fill);
  const labelText = room.label?.text ?? room.id;
  const label = roomLabelPosition(room);

  const rotationAttr = room.rect?.rotation ? ` data-rotation="${room.rect.rotation}"` : "";
  const shape = room.rect
    ? `<rect x="${room.rect.x}" y="${room.rect.y}" width="${room.rect.w}" height="${room.rect.h}" rx="${room.rect.r ?? 8}" ry="${room.rect.r ?? 8}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2"${rotationAttr} />`
    : room.poly
    ? `<path d="M ${room.poly.points.map((point) => `${point.x} ${point.y}`).join(" L ")} Z" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2" />`
    : "";

  const labelSvg =
    room.kind === "wing_background"
      ? ""
      : `<text x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Tahoma, sans-serif" font-size="12" fill="#0f172a">${escapeXml(
          labelText
        )}</text>`;
  const wingAttr = room.wing ? ` data-wing="${room.wing}"` : "";
  const wingNameAttr = room.wingName?.trim() ? ` data-wing-name="${escapeXml(room.wingName.trim())}"` : "";

  return `<g data-room-id="${escapeXml(room.id)}" data-kind="${room.kind}"${wingAttr}${wingNameAttr}>${shape}${labelSvg}</g>`;
}

export function layoutToSvg(layout: Layout): string {
  const svgRooms = layout.rooms.map(roomToSvg).join("");
  const scaleAttr = layout.metersPerCell != null ? ` data-meters-per-cell="${layout.metersPerCell}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.viewBox.w} ${layout.viewBox.h}" data-layout-version="${layout.version}" data-layout-units="${layout.units}"${scaleAttr}>${svgRooms}</svg>`;
}
