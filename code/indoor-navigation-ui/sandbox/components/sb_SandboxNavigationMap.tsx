import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import "../../src/assets/navigation_map.css";
import WrapText from "../../src/assets/WrapText";
import {
  MAIN_ENTRANCE,
  WING_A_1F_OFFSET,
  WING_A_2F_OFFSET,
  WING_A_3F_OFFSET,
  WING_B_1F_OFFSET,
  WING_B_2F_OFFSET,
  WING_B_3F_OFFSET,
  WING_C_1F_OFFSET,
  WING_C_2F_OFFSET,
  WING_C_3F_OFFSET,
  WING_BACKGROUND_RECTS,
  WING_BRIDGE_1F,
  WING_BRIDGE_BC_1F,
  WING_BRIDGE_BC_2F,
  WING_BRIDGE_BC_3F,
  WING_BRIDGE_2F,
  WING_BRIDGE_3F,
} from "../sb_map_constants";
import {
  MAIN_ENTRANCE_ID,
  MAIN_ENTRANCE_NAME,
  SPACE_TYPE_BRIDGE,
  SPACE_TYPE_ENTRANCE,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_ROOM,
  SPACE_TYPE_STAIRS,
} from "../../src/constants/space_constants";
import type { Space } from "../../src/types/models";

type FloorRoutes = Record<string, string>;

type RouteSegment = { floor: number; d: string };
type RouteProp =
  | string
  | RouteSegment[]
  | { segments: RouteSegment[] }
  | null
  | undefined;

function normalizeSegments(route: RouteProp): RouteSegment[] {
  if (!route) return [];
  if (typeof route === "string") return [{ floor: -1, d: route }];

  if (Array.isArray(route)) {
    return route.filter(
      (x: any) => x && typeof x.floor === "number" && typeof x.d === "string"
    );
  }

  if (typeof route === "object" && Array.isArray((route as any).segments)) {
    return (route as any).segments.filter(
      (x: any) => x && typeof x.floor === "number" && typeof x.d === "string"
    );
  }

  return [];
}

function floorKeysSorted(fr: FloorRoutes): number[] {
  return Object.keys(fr)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function ordinalFloorLabel(floorNum: number): string {
  if (floorNum === 1) return "1st Floor";
  if (floorNum === 2) return "2nd Floor";
  if (floorNum === 3) return "3rd Floor";
  return `Floor ${floorNum}`;
}

function detectWingFromIdentifiers(space: Space): "A" | "B" | "C" | null {
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

  if (
    id.includes("wingb") ||
    hasIdToken("b") ||
    hasNameToken("B") ||
    /\bwing b\b/i.test(name)
  ) {
    return "B";
  }

  if (
    id.includes("winga") ||
    hasIdToken("a") ||
    hasNameToken("A") ||
    /\bwing a\b/i.test(name)
  ) {
    return "A";
  }

  return null;
}

function spaceHasPoly(space: Space): boolean {
  return Boolean(space.poly?.points && space.poly.points.length >= 3);
}

function spaceCenter(space: Space): { x: number; y: number } {
  if (spaceHasPoly(space)) {
    const points = space.poly!.points;
    const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
  }
  return { x: space.x + space.width / 2, y: space.y + space.height / 2 };
}

function spacePathD(space: Space): string {
  if (!spaceHasPoly(space)) return "";
  return `M ${space.poly!.points.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`;
}

export default function SandboxNavigationMap({
  route,
  destination,
  origin,
  floor = 1,
  onFloorChange,
  onRoomSelectAsCurrentLocation,
  floorRoutes = {},
  focusWingRequestWing = null,
  focusWingRequestToken = null,
}: {
  route: RouteProp;
  destination: string;
  origin?: string;
  floor?: number;
  onFloorChange?: (nextFloor: number) => void;
  onRoomSelectAsCurrentLocation?: (roomName: string) => void;
  floorRoutes?: FloorRoutes;
  focusWingRequestWing?: "A" | "B" | "C" | null;
  focusWingRequestToken?: number | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const routePathRef = useRef<SVGPathElement | null>(null);
  const segments = useMemo(() => normalizeSegments(route), [route]);
  const orderedRouteFloors = useMemo(() => {
    if (!segments.length) return [];
    const ordered = segments
      .map((s) => s.floor)
      .filter((f) => Number.isFinite(f));
    return Array.from(new Set(ordered));
  }, [segments]);
  const manualFloorRef = useRef(false);

  const requestFloorChange = (nextFloor: number) => {
    manualFloorRef.current = true;
    if (!focusedWing) {
      const target = getWingFocusCenter("C", nextFloor);
      setFocusedWing("C");
      animateViewBoxTo(target.x - viewBox.w / 2, target.y - viewBox.h / 2);
    }
    onFloorChange?.(nextFloor);
  };

  // ---------------- VIEWBOX / PAN / ZOOM ----------------
  const INITIAL_VIEWBOX = { x: -116, y: 0, w: 1316, h: 620 };
  const FULL_BUILDING_VIEWBOX = { x: -24, y: -332, w: 1768, h: 930 };
  const WING_BC_VIEWBOX = { x: 156, y: -246, w: 1380, h: 436 };
  const PAN_DRAG_THRESHOLD_PX = 8;
  const ROOM_HIT_PADDING = 12;
  const [viewBox, setViewBox] = useState(INITIAL_VIEWBOX);

  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panPointerIdRef = useRef<number | null>(null);
  const panGesturePrimedRef = useRef(false);
  const [focusedWing, setFocusedWing] = useState<"A" | "B" | "C" | null>(null);
  const wingFocusAnimRef = useRef<number | null>(null);
  const pendingResetFitFloorRef = useRef<number | null>(null);
  const routeFloorsWithData = useMemo(() => {
    const floorsFromSegments = segments
      .filter(
        (s) =>
          Number.isFinite(s.floor) &&
          s.floor > 0 &&
          typeof s.d === "string" &&
          s.d.trim().length > 0
      )
      .map((s) => s.floor);
    const floorsFromMap = floorKeysSorted(floorRoutes || {}).filter((f) => {
      const d = floorRoutes?.[String(f)];
      return typeof d === "string" && d.trim().length > 0;
    });
    return Array.from(new Set([...floorsFromSegments, ...floorsFromMap])).sort(
      (a, b) => a - b
    );
  }, [segments, floorRoutes]);
  const classifyWingFromPoint = useCallback(
    (x: number, y: number): "A" | "B" | "C" | null => {
      if (y >= 302) return "A";
      if (y >= -8 && y <= 260) return "B";
      if (y <= -56 && x >= 380) return "C";
      return null;
    },
    []
  );
  const getRoutePathForFloor = useCallback(
    (routeFloor: number) => {
      const dFromMap = floorRoutes?.[String(routeFloor)];
      const dFromSegments =
        segments.find(
          (s) =>
            s.floor === routeFloor &&
            typeof s.d === "string" &&
            s.d.trim().length > 0
        )?.d ?? "";
      if (typeof dFromMap === "string" && dFromMap.trim().length > 0) {
        return dFromMap;
      }
      if (typeof dFromSegments === "string" && dFromSegments.trim().length > 0) {
        return dFromSegments;
      }
      if (
        segments.length === 1 &&
        segments[0].floor === -1 &&
        typeof segments[0].d === "string" &&
        segments[0].d.trim().length > 0
      ) {
        return segments[0].d;
      }
      return "";
    },
    [floorRoutes, segments]
  );
  const getWingsFromPathD = useCallback(
    (d: string) => {
      if (!d) return [] as Array<"A" | "B" | "C">;
      try {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        const len = path.getTotalLength();
        if (!Number.isFinite(len) || len <= 0) return [] as Array<"A" | "B" | "C">;
        const wings = new Set<"A" | "B" | "C">();
        const step = 10;
        for (let i = 0; i <= len; i += step) {
          const pt = path.getPointAtLength(i);
          const wing = classifyWingFromPoint(pt.x, pt.y);
          if (wing) wings.add(wing);
        }
        const endPt = path.getPointAtLength(len);
        const endWing = classifyWingFromPoint(endPt.x, endPt.y);
        if (endWing) wings.add(endWing);
        return Array.from(wings);
      } catch {
        return [] as Array<"A" | "B" | "C">;
      }
    },
    [classifyWingFromPoint]
  );
  const getEndWingFromPathD = useCallback(
    (d: string): "A" | "B" | "C" | null => {
      if (!d) return null;
      try {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        const len = path.getTotalLength();
        if (!Number.isFinite(len) || len <= 0) return null;
        const endPt = path.getPointAtLength(len);
        return classifyWingFromPoint(endPt.x, endPt.y);
      } catch {
        return null;
      }
    },
    [classifyWingFromPoint]
  );
  const singleFloorRouteWings = useMemo(() => {
    if (routeFloorsWithData.length !== 1) return [] as Array<"A" | "B" | "C">;
    const singleFloor = routeFloorsWithData[0];
    const d = getRoutePathForFloor(singleFloor);
    return getWingsFromPathD(d);
  }, [routeFloorsWithData, getRoutePathForFloor, getWingsFromPathD]);
  const isWingBCSingleFloorRoute = useMemo(() => {
    if (routeFloorsWithData.length !== 1 || singleFloorRouteWings.length !== 2) {
      return false;
    }
    return (
      singleFloorRouteWings.includes("B") &&
      singleFloorRouteWings.includes("C")
    );
  }, [routeFloorsWithData, singleFloorRouteWings]);
  const shouldResetZoomForTwoWingSingleFloorRoute = useMemo(
    () =>
      routeFloorsWithData.length === 1 &&
      singleFloorRouteWings.length === 2 &&
      !isWingBCSingleFloorRoute,
    [routeFloorsWithData, singleFloorRouteWings, isWingBCSingleFloorRoute]
  );
  const shouldShowFullBuildingForSingleFloorRoute = useMemo(
    () =>
      routeFloorsWithData.length === 1 &&
      singleFloorRouteWings.length === 0 &&
      !shouldResetZoomForTwoWingSingleFloorRoute &&
      !isWingBCSingleFloorRoute,
    [
      routeFloorsWithData,
      singleFloorRouteWings,
      shouldResetZoomForTwoWingSingleFloorRoute,
      isWingBCSingleFloorRoute,
    ]
  );

  const fitRouteView = () => {
    const shouldPanToWingBForWingCMultiFloorRoute =
      routeFloorsWithData.length > 1 && originIsWingC && destinationIsWingB;
    const shouldPanToWingCForMultiFloorDestination =
      routeFloorsWithData.length > 1 &&
      destinationIsWingC &&
      !shouldPanToWingBForWingCMultiFloorRoute;
    const shouldNudgeUpForWingCMultiFloorOrigin =
      routeFloorsWithData.length > 1 &&
      (originIsWingC || shouldPanToWingCForMultiFloorDestination);
    const wingCMultiFloorYOffset = shouldNudgeUpForWingCMultiFloorOrigin
      ? 180
      : 0;

    if (isWingBCSingleFloorRoute) {
      setViewBox(WING_BC_VIEWBOX);
      return;
    }

    if (shouldResetZoomForTwoWingSingleFloorRoute) {
      setViewBox(INITIAL_VIEWBOX);
      return;
    }

    if (shouldShowFullBuildingForSingleFloorRoute) {
      setViewBox(FULL_BUILDING_VIEWBOX);
      return;
    }

    const path = routePathRef.current;
    if (!path) {
      const fallbackY = shouldPanToWingBForWingCMultiFloorRoute
        ? 145 - INITIAL_VIEWBOX.h / 2
        : shouldPanToWingCForMultiFloorDestination
        ? -215 - INITIAL_VIEWBOX.h / 2 + wingCMultiFloorYOffset
        : INITIAL_VIEWBOX.y + wingCMultiFloorYOffset;
      const fallbackX = shouldPanToWingBForWingCMultiFloorRoute
        ? 578 - INITIAL_VIEWBOX.w / 2
        : shouldPanToWingCForMultiFloorDestination
        ? 1065 - INITIAL_VIEWBOX.w / 2
        : INITIAL_VIEWBOX.x;
      setViewBox({
        ...INITIAL_VIEWBOX,
        x: fallbackX,
        y: fallbackY,
      });
      return;
    }
    try {
      const box = path.getBBox();
      const padding = 48;
      const minW = 420;
      const minH = 260;
      const w = Math.max(minW, box.width + padding * 2);
      const h = Math.max(minH, box.height + padding * 2);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      let targetCenterX = cx;
      let targetCenterY = cy;
      if (shouldPanToWingBForWingCMultiFloorRoute) {
        const len = path.getTotalLength();
        const endPt = path.getPointAtLength(len);
        const biasToDestination = 0.75;
        targetCenterX = cx + (endPt.x - cx) * biasToDestination;
        targetCenterY = cy + (endPt.y - cy) * biasToDestination;
      } else if (shouldPanToWingCForMultiFloorDestination) {
        const wingCCenterX = 1065;
        const wingCCenterY = -215;
        const biasToWingC = 0.7;
        targetCenterX = cx + (wingCCenterX - cx) * biasToWingC;
        targetCenterY = cy + (wingCCenterY - cy) * biasToWingC;
      }
      setViewBox({
        x: targetCenterX - w / 2,
        y: targetCenterY - h / 2 + wingCMultiFloorYOffset,
        w,
        h,
      });
    } catch {
      const fallbackY = shouldPanToWingBForWingCMultiFloorRoute
        ? 145 - INITIAL_VIEWBOX.h / 2
        : shouldPanToWingCForMultiFloorDestination
        ? -215 - INITIAL_VIEWBOX.h / 2 + wingCMultiFloorYOffset
        : INITIAL_VIEWBOX.y + wingCMultiFloorYOffset;
      const fallbackX = shouldPanToWingBForWingCMultiFloorRoute
        ? 578 - INITIAL_VIEWBOX.w / 2
        : shouldPanToWingCForMultiFloorDestination
        ? 1065 - INITIAL_VIEWBOX.w / 2
        : INITIAL_VIEWBOX.x;
      setViewBox({
        ...INITIAL_VIEWBOX,
        x: fallbackX,
        y: fallbackY,
      });
    }
  };

  useEffect(() => {
    if (!shouldShowFullBuildingForSingleFloorRoute) return;
    setFocusedWing(null);
    setPanOffset({ x: 0, y: 0 });
    setViewBox(FULL_BUILDING_VIEWBOX);
  }, [shouldShowFullBuildingForSingleFloorRoute, route, floorRoutes, floor]);

  useEffect(() => {
    if (!isWingBCSingleFloorRoute) return;
    setFocusedWing(null);
    setPanOffset({ x: 0, y: 0 });
    setViewBox(WING_BC_VIEWBOX);
  }, [isWingBCSingleFloorRoute, route, floorRoutes, floor]);

  useEffect(() => {
    if (!shouldResetZoomForTwoWingSingleFloorRoute) return;
    setFocusedWing(null);
    setPanOffset({ x: 0, y: 0 });
    setViewBox(INITIAL_VIEWBOX);
  }, [shouldResetZoomForTwoWingSingleFloorRoute, route, floorRoutes, floor]);

  const resetMapToRouteView = () => {
    const destinationRouteFloor =
      destinationFloorFromName !== null &&
      Number.isFinite(destinationFloorFromName) &&
      ((typeof floorRoutes?.[String(destinationFloorFromName)] === "string" &&
        floorRoutes[String(destinationFloorFromName)].trim().length > 0) ||
        segments.some(
          (s) =>
            s.floor === destinationFloorFromName &&
            typeof s.d === "string" &&
            s.d.trim().length > 0
        ))
        ? destinationFloorFromName
        : null;
    const routeFloorsFromSegments = orderedRouteFloors.filter((f) =>
      Number.isFinite(f)
    );
    const routeFloorsFromMap = floorKeysSorted(floorRoutes || {});
    const targetRouteFloor =
      destinationRouteFloor !== null
        ? destinationRouteFloor
        : routeFloorsFromSegments.length > 0
        ? routeFloorsFromSegments[routeFloorsFromSegments.length - 1]
        : routeFloorsFromMap.length > 0
        ? routeFloorsFromMap[routeFloorsFromMap.length - 1]
        : null;

    if (wingFocusAnimRef.current !== null) {
      window.cancelAnimationFrame(wingFocusAnimRef.current);
      wingFocusAnimRef.current = null;
    }

    setFocusedWing(null);
    setPanOffset({ x: 0, y: 0 });
    manualFloorRef.current = false;

    if (
      targetRouteFloor !== null &&
      Number.isFinite(targetRouteFloor) &&
      targetRouteFloor !== floor
    ) {
      pendingResetFitFloorRef.current = targetRouteFloor;
      setViewBox(INITIAL_VIEWBOX);
      onFloorChange?.(targetRouteFloor);
      return;
    }

    fitRouteView();
  };

  const resetZoom = () => {
    if (wingFocusAnimRef.current !== null) {
      window.cancelAnimationFrame(wingFocusAnimRef.current);
      wingFocusAnimRef.current = null;
    }
    pendingResetFitFloorRef.current = null;
    setFocusedWing(null);
    setPanOffset({ x: 0, y: 0 });
    setIsPanning(false);
    if (isWingBCSingleFloorRoute) {
      setViewBox(WING_BC_VIEWBOX);
      return;
    }
    if (shouldShowFullBuildingForSingleFloorRoute) {
      setViewBox(FULL_BUILDING_VIEWBOX);
      return;
    }
    setViewBox(INITIAL_VIEWBOX);
  };

  useEffect(() => {
    const pendingFloor = pendingResetFitFloorRef.current;
    if (pendingFloor === null || floor !== pendingFloor) return;
    pendingResetFitFloorRef.current = null;
    window.requestAnimationFrame(() => fitRouteView());
  }, [floor]);

  const zoomIn = () =>
    setViewBox((v) => ({ ...v, w: v.w * 0.9, h: v.h * 0.9 }));

  const zoomOut = () =>
    setViewBox((v) => ({ ...v, w: v.w * 1.1, h: v.h * 1.1 }));

  const animateViewBoxTo = (targetX: number, targetY: number, duration = 420) => {
    if (wingFocusAnimRef.current !== null) {
      window.cancelAnimationFrame(wingFocusAnimRef.current);
      wingFocusAnimRef.current = null;
    }
    const startX = viewBox.x - panOffset.x;
    const startY = viewBox.y - panOffset.y;
    const startW = viewBox.w;
    const startH = viewBox.h;
    const start = performance.now();
    setPanOffset({ x: 0, y: 0 });
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const raw = Math.min(1, (now - start) / duration);
      const t = ease(raw);
      setViewBox({
        x: startX + (targetX - startX) * t,
        y: startY + (targetY - startY) * t,
        w: startW,
        h: startH,
      });
      if (raw < 1) {
        wingFocusAnimRef.current = window.requestAnimationFrame(step);
      } else {
        wingFocusAnimRef.current = null;
      }
    };
    wingFocusAnimRef.current = window.requestAnimationFrame(step);
  };

  const getWingFocusCenter = useCallback(
    (wing: "A" | "B" | "C", targetFloor = floor) => {
      if (wing === "A") {
        const wingASpaces = getWingASpacesForFloor(targetFloor);
        const wingARooms = getOverlayRightEdgeRooms(wingASpaces);
        const bridgeSpaces = getBridgeSpacesForFloor(targetFloor);
        const wingABorderRect = getWingABorderRect(
          wingASpaces,
          wingARooms,
          bridgeSpaces.ab
        );
        if (wingABorderRect) {
          return {
            x: wingABorderRect.x + wingABorderRect.width / 2,
            y: wingABorderRect.y + wingABorderRect.height / 2,
          };
        }
      }
      if (wing === "B") {
        const wingBSpaces = getWingBSpacesForFloor(targetFloor);
        const wingBRooms = getOverlayRightEdgeRooms(wingBSpaces);
        const wingBBorderRect = getWingBBorderRect(wingBSpaces, wingBRooms);
        if (wingBBorderRect) {
          return {
            x: wingBBorderRect.x + wingBBorderRect.width / 2,
            y: wingBBorderRect.y + wingBBorderRect.height / 2,
          };
        }
      }
      if (wing === "C") {
        const wingCSpaces = getWingCSpacesForFloor(targetFloor);
        const wingCRooms = getOverlayRightEdgeRooms(wingCSpaces);
        const wingCBorderRect = getWingCBorderRect(wingCSpaces, wingCRooms);
        if (wingCBorderRect) {
          return {
            x: wingCBorderRect.x + wingCBorderRect.width / 2,
            y: wingCBorderRect.y + wingCBorderRect.height / 2,
          };
        }
      }
      const wingCenterByKey: Record<"A" | "B" | "C", { x: number; y: number }> = {
        A: { x: (20 + 1135) / 2, y: 435 },
        B: { x: (20 + 1135) / 2, y: 125 },
        C: { x: (400 + 1730) / 2 + 90, y: -60 },
      };
      return wingCenterByKey[wing];
    },
    [floor]
  );

  const focusWing = (wing: "A" | "B" | "C") => {
    const target = getWingFocusCenter(wing);
    setFocusedWing(wing);
    animateViewBoxTo(target.x - viewBox.w / 2, target.y - viewBox.h / 2);
  };

  const lastExternalWingFocusTokenRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (wingFocusAnimRef.current !== null) {
        window.cancelAnimationFrame(wingFocusAnimRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setFocusedWing(null);
  }, [route, floorRoutes, origin, destination]);

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;

    // Zoom by default so trackpads feel responsive in production.
    // Horizontal wheel or Shift+wheel still pans when finer movement is needed.
    if (!e.ctrlKey && !e.metaKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      const panX = (e.shiftKey ? e.deltaY : e.deltaX) * scaleX * 0.6;
      const panY = e.deltaY * scaleY * 0.6;
      setViewBox((v) => ({
        ...v,
        x: v.x + panX,
        y: v.y + panY,
      }));
      return;
    }

    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
    const svgX = e.clientX - rect.left;
    const svgY = e.clientY - rect.top;

    const px = viewBox.x + svgX * scaleX;
    const py = viewBox.y + svgY * scaleY;

    const newW = viewBox.w * zoomFactor;
    const newH = viewBox.h * zoomFactor;

    setViewBox({
      x: px - (px - viewBox.x) * zoomFactor,
      y: py - (py - viewBox.y) * zoomFactor,
      w: newW,
      h: newH,
    });
  }

  function resetPanGesture() {
    panPointerIdRef.current = null;
    panGesturePrimedRef.current = false;
    setPanOffset({ x: 0, y: 0 });
    setIsPanning(false);
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType !== "mouse") {
      e.preventDefault();
    }
    panPointerIdRef.current = e.pointerId;
    panGesturePrimedRef.current = true;
    setPanStart({ x: e.clientX, y: e.clientY });
    setPanOffset({ x: 0, y: 0 });
    setIsPanning(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!panGesturePrimedRef.current || panPointerIdRef.current !== e.pointerId) return;
    const svg = svgRef.current;
    if (!svg) return;

    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    const distance = Math.hypot(dx, dy);

    if (!isPanning && distance < PAN_DRAG_THRESHOLD_PX) {
      return;
    }

    if (!isPanning) {
      setIsPanning(true);
    }

    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;

    setPanOffset({ x: dx * scaleX, y: dy * scaleY });
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (panPointerIdRef.current !== e.pointerId) return;

    e.currentTarget.releasePointerCapture?.(e.pointerId);

    if (!isPanning) {
      resetPanGesture();
      return;
    }

    setViewBox((v) => ({
      x: v.x - panOffset.x,
      y: v.y - panOffset.y,
      w: v.w,
      h: v.h,
    }));

    resetPanGesture();
  }

  const effectiveViewBox = {
    x: viewBox.x - panOffset.x,
    y: viewBox.y - panOffset.y,
    w: viewBox.w,
    h: viewBox.h,
  };

  // ---------------- FLOOR AUTO SWITCH ----------------
  useEffect(() => {
    if (!onFloorChange) return;

    const floors = floorKeysSorted(floorRoutes || {});
    if (floors.length <= 1) return;

    if (floorRoutes?.[String(floor)]) return;

    if (manualFloorRef.current) return;

    onFloorChange(floors[floors.length - 1]); // destination floor
  }, [floorRoutes, floor, onFloorChange]);

  useEffect(() => {
    manualFloorRef.current = false;
  }, [route, floorRoutes]);

  // ---------------- FLOOR SWITCH HINT ----------------
  const [floorHint, setFloorHint] = useState<string | null>(null);
  const [multiThumbCloseHint, setMultiThumbCloseHint] = useState<string | null>(
    null
  );
  const floorHintPrevRef = useRef<number>(floor);
  const prevAnyThumbZoomActiveRef = useRef<boolean>(false);
  const multiThumbCloseHintTimerRef = useRef<number | null>(null);
  const transitionPrevRef = useRef<number>(floor);
  const TRANSITION_MS = 900;
  const transitionTimerRef = useRef<number | null>(null);
  const transitionWrapRef = useRef<HTMLDivElement | null>(null);
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const [transition, setTransition] = useState<{
    from: number;
    to: number;
    active: boolean;
  } | null>(null);
  const [thumbPos, setThumbPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [thumbDrag, setThumbDrag] = useState<{
    active: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    pointerId: number | null;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    pointerId: null,
  });
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [thumbZoomDisabled, setThumbZoomDisabled] = useState<boolean>(false);
  const [thumbZoomed, setThumbZoomed] = useState<boolean>(false);
  const [thumbZoomClosing, setThumbZoomClosing] = useState<boolean>(false);
  const thumbDragRef = useRef(thumbDrag);
  const thumbWasDragRef = useRef<boolean>(false);
  const thumbAutoCloseTimerRef = useRef<number | null>(null);
  const thumbFoldTimerRef = useRef<number | null>(null);

  const [showMultiOverview, setShowMultiOverview] = useState<boolean>(true);
  const [show3DModal, setShow3DModal] = useState<boolean>(false);
  const [show2DModal, setShow2DModal] = useState<boolean>(false);
  const modal2dSvgRef = useRef<SVGSVGElement | null>(null);
  const [modal2dViewBox, setModal2dViewBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [isModal2dPanning, setIsModal2dPanning] = useState<boolean>(false);
  const [modal2dPanStart, setModal2dPanStart] = useState({ x: 0, y: 0 });
  const [modal2dPanOffset, setModal2dPanOffset] = useState({ x: 0, y: 0 });
  const lastMultiKeyRef = useRef<string>("");
  const modelPanXRef = useRef<number>(0);
  const threeWrapRef = useRef<HTMLDivElement | null>(null);
  const [multiThumbPos, setMultiThumbPos] = useState<
    Record<number, { x: number; y: number }>
  >({});
  const [multiThumbDrag, setMultiThumbDrag] = useState<{
    active: boolean;
    floor: number | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    pointerId: number | null;
  }>({
    active: false,
    floor: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    pointerId: null,
  });
  const [multiThumbZoomDisabled, setMultiThumbZoomDisabled] = useState<
    Record<number, boolean>
  >({});
  const [multiThumbZoomedFloor, setMultiThumbZoomedFloor] = useState<
    number | null
  >(null);
  const [multiThumbZoomClosingFloor, setMultiThumbZoomClosingFloor] = useState<
    number | null
  >(null);
  const multiThumbDragRef = useRef(multiThumbDrag);
  const multiThumbRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const multiThumbWasDragRef = useRef<boolean>(false);
  const multiThumbAutoCloseTimerRef = useRef<number | null>(null);
  const multiThumbFoldTimerRef = useRef<number | null>(null);

  useEffect(() => {
    thumbDragRef.current = thumbDrag;
  }, [thumbDrag]);

  useEffect(() => {
    multiThumbDragRef.current = multiThumbDrag;
  }, [multiThumbDrag]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = thumbDragRef.current;
      if (!drag.active || e.pointerId !== drag.pointerId) return;
      const container = mapWrapRef.current;
      const containerRect = container?.getBoundingClientRect();
      const rect = thumbRef.current?.getBoundingClientRect();
      if (!containerRect || !rect) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        thumbWasDragRef.current = true;
      }
      const nextX = drag.origX + dx;
      const nextY = drag.origY + dy;

      const maxX = containerRect.width - rect.width;
      const maxY = containerRect.height - rect.height;

      const minX = Math.min(0, maxX);
      const minY = Math.min(0, maxY);
      const maxClampX = Math.max(0, maxX);
      const maxClampY = Math.max(0, maxY);

      const clampedX = Math.max(minX, Math.min(maxClampX, nextX));
      const clampedY = Math.max(minY, Math.min(maxClampY, nextY));

      setThumbPos({ x: clampedX, y: clampedY });
    };

    const handleUp = (e: PointerEvent) => {
      const drag = thumbDragRef.current;
      if (!drag.active || e.pointerId !== drag.pointerId) return;
      setThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = multiThumbDragRef.current;
      if (!drag.active || e.pointerId !== drag.pointerId || drag.floor === null)
        return;
      const container = mapWrapRef.current;
      const containerRect = container?.getBoundingClientRect();
      const rect = multiThumbRefs.current[drag.floor]?.getBoundingClientRect();
      if (!containerRect || !rect) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        multiThumbWasDragRef.current = true;
      }
      const nextX = drag.origX + dx;
      const nextY = drag.origY + dy;

      const maxX = containerRect.width - rect.width;
      const maxY = containerRect.height - rect.height;

      const minX = Math.min(0, maxX);
      const minY = Math.min(0, maxY);
      const maxClampX = Math.max(0, maxX);
      const maxClampY = Math.max(0, maxY);

      const clampedX = Math.max(minX, Math.min(maxClampX, nextX));
      const clampedY = Math.max(minY, Math.min(maxClampY, nextY));

      setMultiThumbPos((prev) => ({
        ...prev,
        [drag.floor!]: { x: clampedX, y: clampedY },
      }));
    };

    const handleUp = (e: PointerEvent) => {
      const drag = multiThumbDragRef.current;
      if (!drag.active || e.pointerId !== drag.pointerId) return;
      setMultiThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
      if (drag.floor !== null) {
        setMultiThumbZoomDisabled((prev) => ({
          ...prev,
          [drag.floor!]: false,
        }));
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  useEffect(() => {
    if (floor === floorHintPrevRef.current) return;

    const direction = floor > floorHintPrevRef.current ? "up" : "down";
    setFloorHint(`Going ${direction} Floor ${floor}`);

    const t = window.setTimeout(() => setFloorHint(null), 2200);
    floorHintPrevRef.current = floor;

    return () => window.clearTimeout(t);
  }, [floor]);

  // ---------------- ROUTE FOR CURRENT FLOOR ----------------
  const getDForFloor = (f: number) => {
    const fr = floorRoutes?.[String(f)];
    if (typeof fr === "string" && fr.trim()) return fr;

    const seg = segments.find((s) => s.floor === f);
    if (seg?.d) return seg.d;

    if (segments.length === 1 && segments[0].floor === -1) return segments[0].d;

    return "";
  };
  const normalizeSpaceKey = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokensFromSpaceKey = (value: string) =>
    normalizeSpaceKey(value).split(" ").filter(Boolean);
  const extractAuditoriumNumber = (value: string) => {
    const normalized = normalizeSpaceKey(value);
    const direct = normalized.match(/\bauditorium\s*b?\s*([0-9]+)f?\b/);
    if (direct) return Number(direct[1]);
    const compact = normalized.match(/\bauditorium([0-9]+)\b/);
    if (compact) return Number(compact[1]);
    return null;
  };
  const findSpaceMatchForFloor = (targetFloor: number, key: string): Space | null => {
    if (!key) return null;
    const currentSpaces = getSpacesForFloor(targetFloor);
    const exact =
      currentSpaces.find((s) => s.id.toLowerCase() === key) ||
      currentSpaces.find((s) => s.name.toLowerCase() === key) ||
      null;
    if (exact) return exact;

    const normalizedKey = normalizeSpaceKey(key);
    const wantsAuditorium = normalizedKey.includes("auditorium");
    const requestedAuditoriumNumber = extractAuditoriumNumber(normalizedKey);
    if (wantsAuditorium && requestedAuditoriumNumber !== null) {
      const auditoriumMatch =
        currentSpaces.find((s) => {
          const name = normalizeSpaceKey(s.name);
          const id = normalizeSpaceKey(s.id);
          if (!name.includes("auditorium") && !id.includes("auditorium")) {
            return false;
          }
          const num = extractAuditoriumNumber(`${name} ${id}`);
          return num === requestedAuditoriumNumber;
        }) || null;
      if (auditoriumMatch) return auditoriumMatch;
    }

    const tokens = tokensFromSpaceKey(key);
    if (!tokens.length) return null;
    return (
      currentSpaces.find((s) => {
        const name = normalizeSpaceKey(s.name);
        const id = normalizeSpaceKey(s.id);
        return tokens.every((t) => name.includes(t) || id.includes(t));
      }) || null
    );
  };
  const getPathEndPointFromD = (d: string): { x: number; y: number } | null => {
    if (!d) return null;
    try {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      const len = path.getTotalLength();
      if (!Number.isFinite(len) || len <= 0) return null;
      const pt = path.getPointAtLength(len);
      return { x: pt.x, y: pt.y };
    } catch {
      return null;
    }
  };
  const getDestinationFocusTargetForFloor = (
    targetFloor: number
  ): { x: number; y: number; wing: "A" | "B" | "C" | null } | null => {
    const destinationKey = destination?.trim().toLowerCase() ?? "";
    const destinationSpace = destinationKey
      ? findSpaceMatchForFloor(targetFloor, destinationKey)
      : null;
    if (destinationSpace) {
      const x = destinationSpace.x + destinationSpace.width / 2;
      const y = destinationSpace.y + destinationSpace.height / 2;
      return { x, y, wing: classifyWingFromPoint(x, y) };
    }
    const destinationPathForFloor = getRoutePathForFloor(targetFloor);
    const endPt = getPathEndPointFromD(destinationPathForFloor);
    if (!endPt) return null;
    return { x: endPt.x, y: endPt.y, wing: classifyWingFromPoint(endPt.x, endPt.y) };
  };

  const dForFloor = useMemo(
    () => getDForFloor(floor),
    [floorRoutes, floor, segments]
  );

  const nextFloorHint = useMemo(() => {
    if (orderedRouteFloors.length) {
      const currentIdx = orderedRouteFloors.indexOf(floor);
      if (currentIdx === -1) return null;
      if (currentIdx >= orderedRouteFloors.length - 1) return null;
      return orderedRouteFloors[currentIdx + 1];
    }

    const floorsFromRoutes = floorKeysSorted(floorRoutes || {});
    if (!floorsFromRoutes.length) return null;
    const currentIdx = floorsFromRoutes.indexOf(floor);
    if (currentIdx === -1) return null;
    if (currentIdx >= floorsFromRoutes.length - 1) return null;
    return floorsFromRoutes[currentIdx + 1];
  }, [orderedRouteFloors, floor, floorRoutes]);

  const getSpacesForFloor = (f: number) => {
    if (f === 1) {
      return [
        ...WING_C_1F_OFFSET,
        WING_BRIDGE_BC_1F,
        ...WING_A_1F_OFFSET,
        WING_BRIDGE_1F,
        ...WING_B_1F_OFFSET,
      ];
    }
    if (f === 2) {
      return [...WING_C_2F_OFFSET, WING_BRIDGE_BC_2F, ...WING_A_2F_OFFSET, WING_BRIDGE_2F, ...WING_B_2F_OFFSET];
    }
    return [...WING_C_3F_OFFSET, WING_BRIDGE_BC_3F, ...WING_A_3F_OFFSET, WING_BRIDGE_3F, ...WING_B_3F_OFFSET];
  };
  const getWingBSpacesForFloor = (f: number): Space[] => {
    if (f === 1) return WING_B_1F_OFFSET;
    if (f === 2) return WING_B_2F_OFFSET;
    return WING_B_3F_OFFSET;
  };
  const getWingASpacesForFloor = (f: number): Space[] => {
    if (f === 1) return WING_A_1F_OFFSET;
    if (f === 2) return WING_A_2F_OFFSET;
    return WING_A_3F_OFFSET;
  };
  const getWingCSpacesForFloor = (f: number): Space[] => {
    if (f === 1) return WING_C_1F_OFFSET;
    if (f === 2) return WING_C_2F_OFFSET;
    return WING_C_3F_OFFSET;
  };
  const getExplicitWingBackgroundsForFloor = (f: number) =>
    WING_BACKGROUND_RECTS[f as 1 | 2 | 3] ?? {};
  const hasWingBackgroundRect = (
    rect?: { x: number; y: number; width: number; height: number } | null
  ): boolean => Boolean(rect && rect.width > 0 && rect.height > 0);
  const hasVisibleWingContentForFloor = (
    f: number,
    wing: "A" | "B" | "C"
  ): boolean => {
    const spaces =
      wing === "A"
        ? getWingASpacesForFloor(f)
        : wing === "B"
          ? getWingBSpacesForFloor(f)
          : getWingCSpacesForFloor(f);
    return (
      spaces.length > 0 ||
      hasWingBackgroundRect(getExplicitWingBackgroundsForFloor(f)[wing])
    );
  };
  const hasVisibleFloorContent = (f: number): boolean =>
    hasVisibleWingContentForFloor(f, "A") ||
    hasVisibleWingContentForFloor(f, "B") ||
    hasVisibleWingContentForFloor(f, "C");
  const getOverlayRightEdgeRooms = (spaces: Space[]): Space[] => {
    const baseRooms = spaces.filter((s) => s.type === SPACE_TYPE_ROOM);
    return baseRooms.length ? baseRooms : spaces;
  };
  const getBridgeSpacesForFloor = (f: number): { ab: Space; bc: Space } => {
    if (f === 1) return { ab: WING_BRIDGE_1F, bc: WING_BRIDGE_BC_1F };
    if (f === 2) return { ab: WING_BRIDGE_2F, bc: WING_BRIDGE_BC_2F };
    return { ab: WING_BRIDGE_3F, bc: WING_BRIDGE_BC_3F };
  };
  const getRenderedHallwaySpaces = (spacesForFloor: Space[]): Space[] =>
    spacesForFloor
      .filter((space) => space.type === "hallway")
      .sort((a, b) => {
        const aArea = a.width * a.height;
        const bArea = b.width * b.height;
        if (aArea !== bArea) return bArea - aArea;
        return a.id.localeCompare(b.id);
      });
  const isHallMarkerSpace = (space: Space): boolean =>
    space.type === SPACE_TYPE_HALLWAY;
  const getZoneRectFromSpaces = (
    spacesForZone: Space[],
    pads?: { left?: number; right?: number; top?: number; bottom?: number },
    rightEdgeSpaces?: Space[]
  ): { x: number; y: number; width: number; height: number } | null => {
    if (!spacesForZone.length) return null;
    const leftPad = pads?.left ?? 20;
    const rightPad = pads?.right ?? 20;
    const topPad = pads?.top ?? 18;
    const bottomPad = pads?.bottom ?? 18;
    const minX = Math.min(...spacesForZone.map((s) => s.x));
    const minY = Math.min(...spacesForZone.map((s) => s.y));
    const maxXSource =
      rightEdgeSpaces && rightEdgeSpaces.length > 0 ? rightEdgeSpaces : spacesForZone;
    const maxX = Math.max(...maxXSource.map((s) => s.x + s.width));
    const maxY = Math.max(...spacesForZone.map((s) => s.y + s.height));
    return {
      x: minX - leftPad,
      y: minY - topPad,
      width: maxX - minX + leftPad + rightPad,
      height: maxY - minY + topPad + bottomPad,
    };
  };
  const getCenteredViewBoxFromSpaces = (
    spacesForZone: Space[],
    pads?: { left?: number; right?: number; top?: number; bottom?: number }
  ): { x: number; y: number; w: number; h: number } | null => {
    if (!spacesForZone.length) return null;
    const leftPad = pads?.left ?? 20;
    const rightPad = pads?.right ?? 20;
    const topPad = pads?.top ?? 18;
    const bottomPad = pads?.bottom ?? 18;
    const minX = Math.min(...spacesForZone.map((s) => s.x));
    const minY = Math.min(...spacesForZone.map((s) => s.y));
    const maxX = Math.max(...spacesForZone.map((s) => s.x + s.width));
    const maxY = Math.max(...spacesForZone.map((s) => s.y + s.height));
    const totalArea = spacesForZone.reduce((sum, s) => sum + s.width * s.height, 0);
    const fallbackCenterX = (minX + maxX) / 2;
    const fallbackCenterY = (minY + maxY) / 2;
    const centerX =
      totalArea > 0
        ? spacesForZone.reduce((sum, s) => sum + (s.x + s.width / 2) * s.width * s.height, 0) /
          totalArea
        : fallbackCenterX;
    const centerY =
      totalArea > 0
        ? spacesForZone.reduce((sum, s) => sum + (s.y + s.height / 2) * s.width * s.height, 0) /
          totalArea
        : fallbackCenterY;
    const halfWidth = Math.max(centerX - minX + leftPad, maxX - centerX + rightPad);
    const halfHeight = Math.max(centerY - minY + topPad, maxY - centerY + bottomPad);
    return {
      x: centerX - halfWidth,
      y: centerY - halfHeight,
      w: halfWidth * 2,
      h: halfHeight * 2,
    };
  };
  const getWingCZoneRectFromAnchors = (
    wingCSpaces: Space[],
    pads?: { left?: number; right?: number; top?: number; bottom?: number },
    bridgeBC?: Space | null
  ): { x: number; y: number; width: number; height: number } | null => {
    if (!wingCSpaces.length) return null;
    const base = getZoneRectFromSpaces(wingCSpaces, pads);
    if (!base) return null;
    const lower = (s: Space) => `${s.id} ${s.name}`.toLowerCase();
    const ibmAnchor =
      wingCSpaces.find((s) => lower(s).includes("ibm room")) ??
      wingCSpaces.find((s) => lower(s).includes("ibm-room")) ??
      null;
    const reflectionAnchor =
      wingCSpaces.find((s) => lower(s).includes("reflection pool")) ??
      wingCSpaces.find((s) => lower(s).includes("reflection-pool")) ??
      wingCSpaces.find((s) => lower(s).includes("vacant c")) ??
      wingCSpaces.find((s) => lower(s).includes("vacant-c")) ??
      null;
    if (!ibmAnchor || !reflectionAnchor) return base;
    const left = Math.min(ibmAnchor.x, reflectionAnchor.x);
    const right = Math.max(ibmAnchor.x + ibmAnchor.width, reflectionAnchor.x + reflectionAnchor.width);
    const maxYFromBridge = bridgeBC ? bridgeBC.y - 36 : base.y + base.height;
    const constrainedMaxY = Math.min(base.y + base.height, maxYFromBridge);
    return {
      x: left,
      y: base.y,
      width: right - left,
      height: Math.max(1, constrainedMaxY - base.y),
    };
  };
  const getWingCBorderRect = (
    wingCSpaces: Space[],
    wingCRooms: Space[],
    borderPad = 20
  ): { x: number; y: number; width: number; height: number } | null => {
    const xSource = wingCRooms.length ? wingCRooms : wingCSpaces;
    const ySource = wingCSpaces.length ? wingCSpaces : xSource;
    if (!xSource.length || !ySource.length) return null;
    const ibmRoom1ForTopBorder =
      wingCSpaces.find((s) => `${s.id} ${s.name}`.toLowerCase().includes("ibm room 1")) ??
      wingCSpaces.find((s) => `${s.id} ${s.name}`.toLowerCase().includes("ibm-room1")) ??
      null;
    const topY = ibmRoom1ForTopBorder
      ? ibmRoom1ForTopBorder.y
      : Math.min(...ySource.map((s) => s.y));
    const leftStairs =
      wingCSpaces
        .filter((s) => s.type === SPACE_TYPE_STAIRS)
        .sort((a, b) => a.x - b.x)[0] ?? null;
    const minX = leftStairs
      ? Math.min(leftStairs.x, ...xSource.map((s) => s.x))
      : Math.min(...xSource.map((s) => s.x));
    const maxX = Math.max(...xSource.map((s) => s.x + s.width));
    const maxY = Math.max(...ySource.map((s) => s.y + s.height));
    return {
      x: minX - borderPad,
      y: topY - borderPad,
      width: maxX - minX + borderPad * 2,
      height: maxY - topY + borderPad * 2,
    };
  };
  const getWingBorderRect = (
    wingSpaces: Space[],
    wingRooms: Space[],
    borderPad = 20
  ): { x: number; y: number; width: number; height: number } | null => {
    const xSource = wingRooms.length ? wingRooms : wingSpaces;
    const ySource = wingSpaces.length ? wingSpaces : xSource;
    if (!xSource.length || !ySource.length) return null;
    const minX = Math.min(...xSource.map((s) => s.x));
    const maxX = Math.max(...xSource.map((s) => s.x + s.width));
    const minY = Math.min(...ySource.map((s) => s.y));
    const maxY = Math.max(...ySource.map((s) => s.y + s.height));
    return {
      x: minX - borderPad,
      y: minY - borderPad,
      width: maxX - minX + borderPad * 2,
      height: maxY - minY + borderPad * 2,
    };
  };
  const getWingABorderRect = (
    wingASpaces: Space[],
    wingARooms: Space[],
    bridgeAB?: Space | null,
    borderPad = 20
  ): { x: number; y: number; width: number; height: number } | null => {
    const base = getWingBorderRect(wingASpaces, wingARooms, borderPad);
    if (!base) return null;
    const lower = (s: Space) => `${s.id} ${s.name}`.toLowerCase();
    const museumA104 =
      wingASpaces.find((s) => lower(s).includes("museum and display room a104")) ??
      wingASpaces.find((s) => lower(s).includes("museum-and-display-room-a104")) ??
      null;
    const bridgeBottomY = bridgeAB ? bridgeAB.y + bridgeAB.height + borderPad : null;
    const museumBottomY = museumA104 ? museumA104.y + museumA104.height + borderPad : null;
    const bottomY =
      bridgeBottomY ??
      museumBottomY ??
      (base.y + base.height);
    return {
      x: base.x,
      y: base.y,
      width: base.width,
      height: Math.max(1, bottomY - base.y),
    };
  };
  const getWingBBorderRect = (
    wingBSpaces: Space[],
    wingBRooms: Space[],
    borderPad = 12
  ): { x: number; y: number; width: number; height: number } | null => {
    const base = getWingBorderRect(wingBSpaces, wingBRooms, borderPad);
    if (!base) return null;
    const lower = (s: Space) => `${s.id} ${s.name}`.toLowerCase();
    const auditoriumB1 =
      wingBSpaces.find((s) => lower(s).includes("auditorium b1")) ??
      wingBSpaces.find((s) => lower(s).includes("wingb-auditorium1")) ??
      null;
    if (!auditoriumB1) return base;
    const verticalExtra = 8;
    const extraRightPad = 96;
    const topY = auditoriumB1.y - verticalExtra - borderPad;
    const maxY = base.y + base.height + verticalExtra;
    const rightStairs =
      wingBSpaces
        .filter((s) => s.type === SPACE_TYPE_STAIRS)
        .sort((a, b) => (b.x + b.width) - (a.x + a.width))[0] ?? null;
    const rightEdge = rightStairs
      ? Math.max(base.x + base.width - borderPad, rightStairs.x + rightStairs.width + extraRightPad)
      : base.x + base.width - borderPad;
    return {
      x: base.x,
      y: topY,
      width: Math.max(1, rightEdge - base.x + borderPad),
      height: Math.max(1, maxY - topY),
    };
  };
  const spaces = getSpacesForFloor(floor);
  const layoutSignature = useMemo(() => {
    const summarize = (items: Space[]) =>
      items
        .map((s) => `${s.id}:${s.x},${s.y},${s.width},${s.height}`)
        .sort()
        .join("|");
    return [
      summarize(WING_A_1F_OFFSET),
      summarize(WING_A_2F_OFFSET),
      summarize(WING_A_3F_OFFSET),
      summarize(WING_B_1F_OFFSET),
      summarize(WING_B_2F_OFFSET),
      summarize(WING_B_3F_OFFSET),
      summarize(WING_C_1F_OFFSET),
      summarize(WING_C_2F_OFFSET),
      summarize(WING_C_3F_OFFSET),
      `${WING_BRIDGE_1F.x},${WING_BRIDGE_1F.y},${WING_BRIDGE_1F.width},${WING_BRIDGE_1F.height}`,
      `${WING_BRIDGE_2F.x},${WING_BRIDGE_2F.y},${WING_BRIDGE_2F.width},${WING_BRIDGE_2F.height}`,
      `${WING_BRIDGE_3F.x},${WING_BRIDGE_3F.y},${WING_BRIDGE_3F.width},${WING_BRIDGE_3F.height}`,
      `${WING_BRIDGE_BC_1F.x},${WING_BRIDGE_BC_1F.y},${WING_BRIDGE_BC_1F.width},${WING_BRIDGE_BC_1F.height}`,
      `${WING_BRIDGE_BC_2F.x},${WING_BRIDGE_BC_2F.y},${WING_BRIDGE_BC_2F.width},${WING_BRIDGE_BC_2F.height}`,
      `${WING_BRIDGE_BC_3F.x},${WING_BRIDGE_BC_3F.y},${WING_BRIDGE_BC_3F.width},${WING_BRIDGE_BC_3F.height}`,
    ].join("||");
  }, [
    WING_A_1F_OFFSET,
    WING_A_2F_OFFSET,
    WING_A_3F_OFFSET,
    WING_B_1F_OFFSET,
    WING_B_2F_OFFSET,
    WING_B_3F_OFFSET,
    WING_C_1F_OFFSET,
    WING_C_2F_OFFSET,
    WING_C_3F_OFFSET,
    WING_BRIDGE_1F,
    WING_BRIDGE_2F,
    WING_BRIDGE_3F,
    WING_BRIDGE_BC_1F,
    WING_BRIDGE_BC_2F,
    WING_BRIDGE_BC_3F,
  ]);
  const wingCRoomIds = useMemo(
    () =>
      new Set(
        [...WING_C_1F_OFFSET, ...WING_C_2F_OFFSET, ...WING_C_3F_OFFSET]
          .filter((s) => s.type === SPACE_TYPE_ROOM)
          .map((s) => s.id)
      ),
    [layoutSignature]
  );
  const wingBRoomIds = useMemo(
    () =>
      new Set(
        [...WING_B_1F_OFFSET, ...WING_B_2F_OFFSET, ...WING_B_3F_OFFSET]
          .filter((s) => s.type === SPACE_TYPE_ROOM)
          .map((s) => s.id)
      ),
    [layoutSignature]
  );
  const mainEntranceCenter = useMemo(() => {
    const entrance = getSpacesForFloor(1).find((s) => s.id === MAIN_ENTRANCE_ID);
    if (!entrance) return MAIN_ENTRANCE;
    return {
      x: entrance.x + entrance.width / 2,
      y: entrance.y + entrance.height / 2,
    };
  }, []);

  const originPoint = useMemo(() => {
    if (!origin) return null;
    const originKey = origin.trim().toLowerCase();
    if (!originKey) return null;

    if (
      originKey === MAIN_ENTRANCE_NAME.toLowerCase() ||
      originKey === SPACE_TYPE_ENTRANCE
    ) {
      return mainEntranceCenter;
    }

    return null;
  }, [origin, mainEntranceCenter]);
  const originIsMainEntrance = useMemo(() => {
    const key = origin?.trim().toLowerCase() ?? "";
    if (!key) return false;
    if (
      key === MAIN_ENTRANCE_NAME.toLowerCase() ||
      key === MAIN_ENTRANCE_ID.toLowerCase() ||
      key === SPACE_TYPE_ENTRANCE
    ) {
      return true;
    }
    return key.includes("main entrance");
  }, [origin]);
  useEffect(() => {
    if (!focusWingRequestWing || focusWingRequestToken === null) return;
    if (lastExternalWingFocusTokenRef.current === focusWingRequestToken) return;
    lastExternalWingFocusTokenRef.current = focusWingRequestToken;
    setPanOffset({ x: 0, y: 0 });
    if (focusWingRequestWing === "C") {
      // Reset-search view: nudge Wing C a bit lower and to the right.
      const target = getWingFocusCenter("C");
      const resetNudgeX = 50;
      const resetNudgeY = -100;
      setFocusedWing("C");
      animateViewBoxTo(
        target.x + resetNudgeX - viewBox.w / 2,
        target.y + resetNudgeY - viewBox.h / 2
      );
      return;
    }
    focusWing(focusWingRequestWing);
  }, [
    floor,
    getWingFocusCenter,
    focusWingRequestWing,
    focusWingRequestToken,
    viewBox.h,
    viewBox.w,
  ]);

  const originFloorFromName = useMemo(() => {
    if (!origin) return null;
    const key = origin.trim().toLowerCase();
    if (!key) return null;

    const explicitFloor =
      key.match(/\b([123])\s*f\b/) || key.match(/\bfloor\s*([123])\b/);
    if (explicitFloor) {
      const floorNum = Number(explicitFloor[1]);
      if (Number.isFinite(floorNum)) return floorNum;
    }

    if (key === MAIN_ENTRANCE_NAME.toLowerCase() || key === SPACE_TYPE_ENTRANCE)
      return 1;
    if (key.includes("chem lab") || key.includes("chemical lab")) return 1;

    const matchesFloor = (spaces: typeof WING_A_1F_OFFSET) =>
      spaces.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );

    const on1f =
      matchesFloor(WING_A_1F_OFFSET) ||
      matchesFloor(WING_B_1F_OFFSET) ||
      matchesFloor(WING_C_1F_OFFSET);
    if (on1f) return 1;

    const on2f =
      matchesFloor(WING_A_2F_OFFSET) ||
      matchesFloor(WING_B_2F_OFFSET) ||
      matchesFloor(WING_C_2F_OFFSET);
    if (on2f) return 2;

    const on3f =
      matchesFloor(WING_A_3F_OFFSET) ||
      matchesFloor(WING_B_3F_OFFSET) ||
      matchesFloor(WING_C_3F_OFFSET);
    if (on3f) return 3;

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const compact = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const tokens = normalize(key).split(" ").filter(Boolean);
    if (!tokens.length) return null;

    const fuzzyMatch = (spaces: typeof WING_A_1F_OFFSET) =>
      spaces.some((s) => {
        const name = normalize(s.name);
        const id = normalize(s.id);
        return tokens.every((t) => name.includes(t) || id.includes(t));
      });

    if (
      fuzzyMatch(WING_A_1F_OFFSET) ||
      fuzzyMatch(WING_B_1F_OFFSET) ||
      fuzzyMatch(WING_C_1F_OFFSET)
    ) {
      return 1;
    }
    if (
      fuzzyMatch(WING_A_2F_OFFSET) ||
      fuzzyMatch(WING_B_2F_OFFSET) ||
      fuzzyMatch(WING_C_2F_OFFSET)
    ) {
      return 2;
    }
    if (
      fuzzyMatch(WING_A_3F_OFFSET) ||
      fuzzyMatch(WING_B_3F_OFFSET) ||
      fuzzyMatch(WING_C_3F_OFFSET)
    ) {
      return 3;
    }

    const compactKey = compact(key);
    if (!compactKey) return null;

    const compactMatch = (spaces: typeof WING_A_1F_OFFSET) =>
      spaces.some((s) => {
        const name = compact(s.name);
        const id = compact(s.id);
        return name === compactKey || id === compactKey;
      });

    if (
      compactMatch(WING_A_1F_OFFSET) ||
      compactMatch(WING_B_1F_OFFSET) ||
      compactMatch(WING_C_1F_OFFSET)
    ) {
      return 1;
    }
    if (
      compactMatch(WING_A_2F_OFFSET) ||
      compactMatch(WING_B_2F_OFFSET) ||
      compactMatch(WING_C_2F_OFFSET)
    ) {
      return 2;
    }
    if (
      compactMatch(WING_A_3F_OFFSET) ||
      compactMatch(WING_B_3F_OFFSET) ||
      compactMatch(WING_C_3F_OFFSET)
    ) {
      return 3;
    }

    return null;
  }, [origin]);

  const destinationFloorFromName = useMemo(() => {
    if (!destination) return null;
    const key = destination.trim().toLowerCase();
    if (!key) return null;

    const explicitFloor =
      key.match(/\b([123])\s*f\b/) || key.match(/\bfloor\s*([123])\b/);
    if (explicitFloor) {
      const floorNum = Number(explicitFloor[1]);
      if (Number.isFinite(floorNum)) return floorNum;
    }

    if (key === MAIN_ENTRANCE_NAME.toLowerCase() || key === SPACE_TYPE_ENTRANCE)
      return 1;
    if (key.includes("chem lab") || key.includes("chemical lab")) return 1;

    const matchesFloor = (floorSpaces: typeof WING_A_1F_OFFSET) =>
      floorSpaces.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );

    const on1f =
      matchesFloor(WING_A_1F_OFFSET) ||
      matchesFloor(WING_B_1F_OFFSET) ||
      matchesFloor(WING_C_1F_OFFSET);
    if (on1f) return 1;

    const on2f =
      matchesFloor(WING_A_2F_OFFSET) ||
      matchesFloor(WING_B_2F_OFFSET) ||
      matchesFloor(WING_C_2F_OFFSET);
    if (on2f) return 2;

    const on3f =
      matchesFloor(WING_A_3F_OFFSET) ||
      matchesFloor(WING_B_3F_OFFSET) ||
      matchesFloor(WING_C_3F_OFFSET);
    if (on3f) return 3;

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const compact = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const tokens = normalize(key).split(" ").filter(Boolean);
    if (!tokens.length) return null;

    const fuzzyMatch = (floorSpaces: typeof WING_A_1F_OFFSET) =>
      floorSpaces.some((s) => {
        const name = normalize(s.name);
        const id = normalize(s.id);
        return tokens.every((t) => name.includes(t) || id.includes(t));
      });

    if (
      fuzzyMatch(WING_A_1F_OFFSET) ||
      fuzzyMatch(WING_B_1F_OFFSET) ||
      fuzzyMatch(WING_C_1F_OFFSET)
    ) {
      return 1;
    }
    if (
      fuzzyMatch(WING_A_2F_OFFSET) ||
      fuzzyMatch(WING_B_2F_OFFSET) ||
      fuzzyMatch(WING_C_2F_OFFSET)
    ) {
      return 2;
    }
    if (
      fuzzyMatch(WING_A_3F_OFFSET) ||
      fuzzyMatch(WING_B_3F_OFFSET) ||
      fuzzyMatch(WING_C_3F_OFFSET)
    ) {
      return 3;
    }

    const compactKey = compact(key);
    if (!compactKey) return null;

    const compactMatch = (floorSpaces: typeof WING_A_1F_OFFSET) =>
      floorSpaces.some((s) => {
        const name = compact(s.name);
        const id = compact(s.id);
        return name === compactKey || id === compactKey;
      });

    if (
      compactMatch(WING_A_1F_OFFSET) ||
      compactMatch(WING_B_1F_OFFSET) ||
      compactMatch(WING_C_1F_OFFSET)
    ) {
      return 1;
    }
    if (
      compactMatch(WING_A_2F_OFFSET) ||
      compactMatch(WING_B_2F_OFFSET) ||
      compactMatch(WING_C_2F_OFFSET)
    ) {
      return 2;
    }
    if (
      compactMatch(WING_A_3F_OFFSET) ||
      compactMatch(WING_B_3F_OFFSET) ||
      compactMatch(WING_C_3F_OFFSET)
    ) {
      return 3;
    }

    return null;
  }, [destination]);

  const destinationIsWingC = useMemo(() => {
    if (!destination) return false;
    const key = destination.trim().toLowerCase();
    if (!key) return false;

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const compact = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const tokens = normalize(key).split(" ").filter(Boolean);

    if (tokens.includes("wing") && tokens.includes("c")) return true;

    const exactMatch = WING_C_1F_OFFSET.some(
      (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
    ) ||
      WING_C_2F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      WING_C_3F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (exactMatch) return true;

    if (tokens.length) {
      const fuzzyMatch = (spaces: typeof WING_C_1F_OFFSET) =>
        spaces.some((s) => {
          const name = normalize(s.name);
          const id = normalize(s.id);
          return tokens.every((t) => name.includes(t) || id.includes(t));
        });
      if (
        fuzzyMatch(WING_C_1F_OFFSET) ||
        fuzzyMatch(WING_C_2F_OFFSET) ||
        fuzzyMatch(WING_C_3F_OFFSET)
      ) {
        return true;
      }
    }

    const compactKey = compact(key);
    if (!compactKey) return false;
    const compactMatch = (spaces: typeof WING_C_1F_OFFSET) =>
      spaces.some((s) => {
        const name = compact(s.name);
        const id = compact(s.id);
        return name === compactKey || id === compactKey;
      });
    return (
      compactMatch(WING_C_1F_OFFSET) ||
      compactMatch(WING_C_2F_OFFSET) ||
      compactMatch(WING_C_3F_OFFSET)
    );
  }, [destination]);
  const destinationIsWingB = useMemo(() => {
    if (!destination) return false;
    const key = destination.trim().toLowerCase();
    if (!key) return false;

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const tokens = normalize(key).split(" ").filter(Boolean);

    if (tokens.includes("wing") && tokens.includes("b")) return true;

    const exactMatch =
      WING_B_1F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      WING_B_2F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      WING_B_3F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (exactMatch) return true;

    if (tokens.length) {
      const fuzzyMatch = (spaces: typeof WING_B_1F_OFFSET) =>
        spaces.some((s) => {
          const name = normalize(s.name);
          const id = normalize(s.id);
          return tokens.every((t) => name.includes(t) || id.includes(t));
        });
      if (
        fuzzyMatch(WING_B_1F_OFFSET) ||
        fuzzyMatch(WING_B_2F_OFFSET) ||
        fuzzyMatch(WING_B_3F_OFFSET)
      ) {
        return true;
      }
    }

    const compactKey = compact(key);
    if (!compactKey) return false;
    const compactMatch = (spaces: typeof WING_B_1F_OFFSET) =>
      spaces.some((s) => {
        const name = compact(s.name);
        const id = compact(s.id);
        return name === compactKey || id === compactKey;
      });
    return (
      compactMatch(WING_B_1F_OFFSET) ||
      compactMatch(WING_B_2F_OFFSET) ||
      compactMatch(WING_B_3F_OFFSET)
    );
  }, [destination]);
  const originIsWingC = useMemo(() => {
    if (!origin) return false;
    const key = origin.trim().toLowerCase();
    if (!key) return false;

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const tokens = normalize(key).split(" ").filter(Boolean);

    if (tokens.includes("wing") && tokens.includes("c")) return true;

    const exactMatch =
      WING_C_1F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      WING_C_2F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      WING_C_3F_OFFSET.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (exactMatch) return true;

    if (tokens.length) {
      const fuzzyMatch = (spaces: typeof WING_C_1F_OFFSET) =>
        spaces.some((s) => {
          const name = normalize(s.name);
          const id = normalize(s.id);
          return tokens.every((t) => name.includes(t) || id.includes(t));
        });
      if (
        fuzzyMatch(WING_C_1F_OFFSET) ||
        fuzzyMatch(WING_C_2F_OFFSET) ||
        fuzzyMatch(WING_C_3F_OFFSET)
      ) {
        return true;
      }
    }

    const compactKey = compact(key);
    if (!compactKey) return false;
    const compactMatch = (spaces: typeof WING_C_1F_OFFSET) =>
      spaces.some((s) => {
        const name = compact(s.name);
        const id = compact(s.id);
        return name === compactKey || id === compactKey;
      });
    return (
      compactMatch(WING_C_1F_OFFSET) ||
      compactMatch(WING_C_2F_OFFSET) ||
      compactMatch(WING_C_3F_OFFSET)
    );
  }, [origin]);

  const [routeEndPoint, setRouteEndPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [routeStartPoint, setRouteStartPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const path = routePathRef.current;
    if (!path || !dForFloor) {
      setRouteStartPoint(null);
      setRouteEndPoint(null);
      return;
    }

    try {
      const len = path.getTotalLength();
      const startPt = path.getPointAtLength(0);
      const pt = path.getPointAtLength(len);
      setRouteStartPoint({ x: startPt.x, y: startPt.y });
      setRouteEndPoint({ x: pt.x, y: pt.y });
    } catch {
      setRouteStartPoint(null);
      setRouteEndPoint(null);
    }
  }, [dForFloor, floor]);

  const nearestStairsCenter = useMemo(() => {
    if (!routeEndPoint) return null;
    const stairs = spaces.filter((s) => s.type === SPACE_TYPE_STAIRS);
    if (!stairs.length) return null;

    let best = null as { x: number; y: number; dist2: number } | null;
    for (const s of stairs) {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const dx = cx - routeEndPoint.x;
      const dy = cy - routeEndPoint.y;
      const dist2 = dx * dx + dy * dy;
      if (!best || dist2 < best.dist2) {
        best = { x: cx, y: cy, dist2 };
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }, [routeEndPoint, spaces]);

  // ---------------- FLOOR TRANSITION ----------------
  useEffect(() => {
    const prev = transitionPrevRef.current;
    if (floor === prev) return;

    setTransition({ from: prev, to: floor, active: false });
    window.requestAnimationFrame(() => {
      // Force a reflow so the "from" styles apply before we flip to "active".
      if (transitionWrapRef.current) {
        void transitionWrapRef.current.offsetHeight;
      }
      setTransition((t) => (t ? { ...t, active: true } : t));
    });

    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      setTransition(null);
    }, TRANSITION_MS);

    transitionPrevRef.current = floor;
  }, [floor]);

  const lastDestinationWingFocusKeyRef = useRef<string>("");
  useEffect(() => {
    if (show3DModal) return;
    const hasAnyRouteData =
      routeFloorsWithData.length > 0 ||
      segments.some((s) => typeof s.d === "string" && s.d.trim().length > 0);
    if (!hasAnyRouteData) return;
    // Respect explicit floor selections from the Current Floor & Wing panel.
    if (manualFloorRef.current) return;

    const explicitDestinationFloor =
      destinationFloorFromName !== null &&
      Number.isFinite(destinationFloorFromName)
        ? destinationFloorFromName
        : null;
    const destinationRouteFloor =
      explicitDestinationFloor !== null
        ? explicitDestinationFloor
        : routeFloorsWithData.length > 0
        ? routeFloorsWithData[routeFloorsWithData.length - 1]
        : floor;

    const routeKeyBase = `${destination
      .trim()
      .toLowerCase()}|${routeFloorsWithData.join(",")}|${destinationRouteFloor}`;
    if (floor !== destinationRouteFloor) {
      if (!onFloorChange) return;
      const floorSwitchKey = `${routeKeyBase}|switch|from:${floor}`;
      if (lastDestinationWingFocusKeyRef.current === floorSwitchKey) return;
      lastDestinationWingFocusKeyRef.current = floorSwitchKey;
      manualFloorRef.current = false;
      onFloorChange(destinationRouteFloor);
      return;
    }

    const destinationAnchor = getDestinationFocusTargetForFloor(destinationRouteFloor);
    const destinationPathForFloor = getRoutePathForFloor(destinationRouteFloor);
    const destinationWingFromPath = getEndWingFromPathD(destinationPathForFloor);
    const destinationWing: "A" | "B" | "C" =
      destinationAnchor?.wing ??
      destinationWingFromPath ??
      (destinationIsWingC ? "C" : destinationIsWingB ? "B" : "A");

    const pathSignature = destinationPathForFloor
      ? destinationPathForFloor.slice(-64)
      : "none";
    const anchorSignature = destinationAnchor
      ? `${Math.round(destinationAnchor.x)},${Math.round(destinationAnchor.y)}`
      : "no-anchor";
    const focusKey = `${routeKeyBase}|focus|${destinationWing}|${pathSignature}|${anchorSignature}`;
    if (lastDestinationWingFocusKeyRef.current === focusKey) return;
    lastDestinationWingFocusKeyRef.current = focusKey;

    setPanOffset({ x: 0, y: 0 });
    setFocusedWing(destinationWing);
    if (destinationAnchor) {
      animateViewBoxTo(
        destinationAnchor.x - viewBox.w / 2,
        destinationAnchor.y - viewBox.h / 2
      );
      return;
    }
    focusWing(destinationWing);
  }, [
    destination,
    destinationFloorFromName,
    destinationIsWingB,
    destinationIsWingC,
    floor,
    getDestinationFocusTargetForFloor,
    getEndWingFromPathD,
    getRoutePathForFloor,
    onFloorChange,
    routeFloorsWithData,
    segments,
    show3DModal,
    viewBox.h,
    viewBox.w,
  ]);

  const renderFloorSvg = (
    f: number,
    opts?: {
      interactive?: boolean;
      withRouteRef?: boolean;
      viewBoxOverride?: { x: number; y: number; w: number; h: number };
      className?: string;
      showMotion?: boolean;
      motionDuration?: string;
      svgKey?: string;
      overlayFloor?: number;
      contentTranslateY?: number;
      svgRef?: React.Ref<SVGSVGElement>;
      onWheel?: (e: React.WheelEvent<SVGSVGElement>) => void;
      onMouseDown?: (e: React.MouseEvent<SVGSVGElement>) => void;
      onMouseMove?: (e: React.MouseEvent<SVGSVGElement>) => void;
      onMouseUp?: (e: React.MouseEvent<SVGSVGElement>) => void;
      onMouseLeave?: (e: React.MouseEvent<SVGSVGElement>) => void;
    }
  ) => {
    const showMotion = opts?.showMotion ?? true;
    const motionDuration = opts?.motionDuration ?? "9s";
    const currentSpaces = getSpacesForFloor(f);
    const hasRouteForThisFloor =
      Boolean(floorRoutes?.[String(f)]?.trim()) ||
      segments.some((s) => s.floor === f && s.d && s.d.trim());
    const dForThisFloor = hasRouteForThisFloor ? getDForFloor(f) : "";
    const originKey = origin?.trim().toLowerCase() ?? "";
    const destKey = destination?.trim().toLowerCase() ?? "";
    const originSpaceForFloor = originKey
      ? findSpaceMatchForFloor(f, originKey)
      : null;

    const destinationSpaceForFloor = destKey
      ? findSpaceMatchForFloor(f, destKey)
      : null;

    const originPointForFloor = f === 1 ? originPoint : null;
    const useRouteEndPoint =
      opts?.withRouteRef && hasRouteForThisFloor ? routeEndPoint : null;
    const bridgeOverlaySpaces = currentSpaces.filter((s) => s.type === SPACE_TYPE_BRIDGE);
    const vb = opts?.viewBoxOverride ?? effectiveViewBox;

    const overlayFloor = opts?.overlayFloor ?? f;
    const zoneRectPads = { left: 0, right: 0, top: 0, bottom: 0 };
    const wingASpaces = getWingASpacesForFloor(overlayFloor);
    const wingBSpaces = getWingBSpacesForFloor(overlayFloor);
    const wingCSpaces = getWingCSpacesForFloor(overlayFloor);
    const bridgeSpaces = getBridgeSpacesForFloor(overlayFloor);
    const wingARooms = getOverlayRightEdgeRooms(wingASpaces);
    const wingBRooms = getOverlayRightEdgeRooms(wingBSpaces);
    const wingCRooms = getOverlayRightEdgeRooms(wingCSpaces);
    const wingAZoneRect = getZoneRectFromSpaces(wingASpaces, zoneRectPads, wingARooms);
    const wingBZoneRect = getZoneRectFromSpaces(wingBSpaces, zoneRectPads, wingBRooms);
    const wingCZoneRect =
      getWingCZoneRectFromAnchors(wingCSpaces, zoneRectPads, bridgeSpaces.bc) ??
      getZoneRectFromSpaces(wingCSpaces, zoneRectPads, wingCRooms);
    const hallwaySpaces = getRenderedHallwaySpaces(currentSpaces);
    const wingLabelWidth = 160;
    const wingLabelHeight = 26;
    const wingABorderTemplateSpaces = wingASpaces;
    const wingABorderTemplateRooms = wingARooms;
    const wingABorderRectBase = getWingABorderRect(
      wingABorderTemplateSpaces,
      wingABorderTemplateRooms,
      bridgeSpaces.ab
    );
    const wingBBorderTemplateSpaces = wingBSpaces;
    const wingBBorderTemplateRooms = wingBRooms;
    const wingBBorderBaseRect = getWingBBorderRect(
      wingBBorderTemplateSpaces,
      wingBBorderTemplateRooms
    );
    const wingBBorderRectBase = wingBBorderBaseRect;
    const wingCBorderTemplateSpaces = wingCSpaces;
    const wingCBorderTemplateRooms = wingCRooms;
    const wingCBorderRectBase = getWingCBorderRect(
      wingCBorderTemplateSpaces,
      wingCBorderTemplateRooms
    );
    const svgClassName = opts?.className ?? "map-svg";
    const applyWingVerticalPad2D =
      svgClassName === "map-svg" ||
      svgClassName.includes("map-svg--thumb") ||
      svgClassName.includes("map-svg--modal2d");
    const wingMainTopPad = applyWingVerticalPad2D ? 8 : 0;
    const wingMainBottomPad = applyWingVerticalPad2D ? 8 : 0;
    const wingABorderRect =
      wingABorderRectBase && (wingMainTopPad > 0 || wingMainBottomPad > 0)
        ? {
            ...wingABorderRectBase,
            y: wingABorderRectBase.y - wingMainTopPad,
            height: wingABorderRectBase.height + wingMainTopPad + wingMainBottomPad,
          }
        : wingABorderRectBase;
    const wingBBorderRect =
      wingBBorderRectBase && (wingMainTopPad > 0 || wingMainBottomPad > 0)
        ? {
            ...wingBBorderRectBase,
            y: wingBBorderRectBase.y - wingMainTopPad,
            height: wingBBorderRectBase.height + wingMainTopPad + wingMainBottomPad,
          }
        : wingBBorderRectBase;
    const wingCBorderRect =
      wingCBorderRectBase && (wingMainTopPad > 0 || wingMainBottomPad > 0)
        ? {
            ...wingCBorderRectBase,
            y: wingCBorderRectBase.y - wingMainTopPad,
            height: wingCBorderRectBase.height + wingMainTopPad + wingMainBottomPad,
          }
        : wingCBorderRectBase;
    const explicitWingBackgrounds =
      (overlayFloor === 2 || overlayFloor === 3 ? WING_BACKGROUND_RECTS[overlayFloor] : WING_BACKGROUND_RECTS[1]) ?? {};
    const resolvedWingABorderRect = explicitWingBackgrounds.A
      ? {
          x: explicitWingBackgrounds.A.x,
          y: explicitWingBackgrounds.A.y,
          width: explicitWingBackgrounds.A.width,
          height: explicitWingBackgrounds.A.height,
        }
      : wingABorderRect;
    const resolvedWingBBorderRect = explicitWingBackgrounds.B
      ? {
          x: explicitWingBackgrounds.B.x,
          y: explicitWingBackgrounds.B.y,
          width: explicitWingBackgrounds.B.width,
          height: explicitWingBackgrounds.B.height,
        }
      : wingBBorderRect;
    const resolvedWingCBorderRect = explicitWingBackgrounds.C
      ? {
          x: explicitWingBackgrounds.C.x,
          y: explicitWingBackgrounds.C.y,
          width: explicitWingBackgrounds.C.width,
          height: explicitWingBackgrounds.C.height,
        }
      : wingCBorderRect;
    const wingLabelInsetX = 12;
    const wingLabelInsetY = 8;
    const getWingLabelPlacement = (
      rect: { x: number; y: number; width: number; height: number } | null,
      anchor: "top" | "bottom",
      fallback: { x: number; y: number },
      customInsetY?: number
    ) => {
      if (!rect) return fallback;
      const maxX = rect.x + rect.width - wingLabelWidth - wingLabelInsetX;
      const insetY = customInsetY ?? wingLabelInsetY;
      return {
        x: Math.min(maxX, rect.x + wingLabelInsetX),
        y:
          anchor === "top"
            ? rect.y + insetY
            : rect.y + rect.height - wingLabelHeight - insetY,
      };
    };
    const svgClass = opts?.className ?? "map-svg";
    const isMainMapSvg = svgClass === "map-svg";
    const isModal2dSvg = svgClass.includes("map-svg--modal2d");
    const isThumbnailSvg = svgClass.includes("map-svg--thumb");
    const mainMapLowerLeftInsetY = -18;
    const useBottomWingLabels = isMainMapSvg || isModal2dSvg || isThumbnailSvg;
    const wingAMainMapHeightReduction =
      isMainMapSvg && f === 1 && !explicitWingBackgrounds.A ? 100 : 0;
    const wingARenderRect = resolvedWingABorderRect
      ? {
          ...resolvedWingABorderRect,
          height: Math.max(1, resolvedWingABorderRect.height - wingAMainMapHeightReduction),
        }
      : null;
    const wingBMainMapLeftExtra =
      isMainMapSvg && f === 1 && !explicitWingBackgrounds.B ? 18 : 0;
    const wingBMainMapRightExtra =
      isMainMapSvg && f === 1 && !explicitWingBackgrounds.B ? 96 : 0;
    const wingBRenderRect = resolvedWingBBorderRect
      ? {
          ...resolvedWingBBorderRect,
          x: resolvedWingBBorderRect.x - wingBMainMapLeftExtra,
          width:
            resolvedWingBBorderRect.width +
            wingBMainMapLeftExtra +
            wingBMainMapRightExtra,
        }
      : null;
    const wingBLabelAnchor = useBottomWingLabels ? "bottom" : "top";
    const wingBLabel = getWingLabelPlacement(
      wingBRenderRect,
      wingBLabelAnchor,
      { x: (wingBZoneRect?.x ?? 0) + 16, y: (wingBZoneRect?.y ?? -8) + 18 },
      wingBLabelAnchor === "bottom" ? mainMapLowerLeftInsetY : undefined
    );
    const wingCLabelAnchor = useBottomWingLabels ? "bottom" : "top";
    const wingCLabel = getWingLabelPlacement(
      resolvedWingCBorderRect,
      wingCLabelAnchor,
      { x: (wingCZoneRect?.x ?? 380) + 16, y: (wingCZoneRect?.y ?? -308) + 18 },
      wingCLabelAnchor === "bottom" ? mainMapLowerLeftInsetY : undefined
    );
    const showWingALabel = hasVisibleWingContentForFloor(f, "A");
    const showWingBLabel = hasVisibleWingContentForFloor(f, "B");
    const showWingCLabel = hasVisibleWingContentForFloor(f, "C");
    const wingALabelAnchor = useBottomWingLabels ? "bottom" : "top";
    const wingALabel = getWingLabelPlacement(
      wingARenderRect,
      wingALabelAnchor,
      {
        x: (wingAZoneRect?.x ?? 0) + 16,
        y: (wingAZoneRect?.y ?? 302) + (wingAZoneRect?.height ?? 272) - 40,
      },
      wingALabelAnchor === "bottom" ? mainMapLowerLeftInsetY : undefined
    );
    const showCurrentFloorBadge =
      opts?.interactive !== false && (opts?.className ?? "map-svg") === "map-svg";
    const floorBadgeX = vb.x + 16;
    const floorBadgeY = vb.y + 12;
    const floorBadgeW = 146;
    const floorBadgeH = 22;

    return (
      <svg
        key={opts?.svgKey}
        ref={opts?.svgRef ?? (opts?.withRouteRef ? svgRef : undefined)}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        className={opts?.className ?? "map-svg"}
        onWheel={
          opts?.onWheel ??
          (opts?.interactive === false ? undefined : handleWheel)
        }
        onPointerDown={opts?.interactive === false || opts?.onMouseDown ? undefined : handlePointerDown}
        onPointerMove={opts?.interactive === false || opts?.onMouseMove ? undefined : handlePointerMove}
        onPointerUp={opts?.interactive === false || opts?.onMouseUp ? undefined : handlePointerUp}
        onPointerCancel={opts?.interactive === false ? undefined : handlePointerUp}
        onMouseDown={opts?.onMouseDown}
        onMouseMove={opts?.onMouseMove}
        onMouseUp={opts?.onMouseUp}
        onMouseLeave={opts?.onMouseLeave}
      >
        <defs>
          <g id="route-arrow-shape">
            <path d="M -12 -6 L 0 0 L -12 6 Z" fill="#2563eb" />
          </g>
        </defs>
        {showCurrentFloorBadge && (
          <g>
            <rect
              x={floorBadgeX}
              y={floorBadgeY}
              width={floorBadgeW}
              height={floorBadgeH}
              rx={6}
              ry={6}
              fill="rgba(15, 23, 42, 0.4)"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={1}
            />
            <text
              x={floorBadgeX + floorBadgeW / 2}
              y={floorBadgeY + floorBadgeH / 2 + 0.5}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{
                fill: "#ffffff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.4,
              }}
            >
              {`Current: ${ordinalFloorLabel(floor)}`}
            </text>
          </g>
        )}
        <g transform={opts?.contentTranslateY ? `translate(0 ${opts.contentTranslateY})` : undefined}>
        {wingARenderRect && (
          <>
            <rect
              x={wingARenderRect.x}
              y={wingARenderRect.y}
              width={wingARenderRect.width}
              height={wingARenderRect.height}
              rx={10}
              ry={10}
              className="wing-a-floor-fill"
            />
            <rect
              x={wingARenderRect.x}
              y={wingARenderRect.y}
              width={wingARenderRect.width}
              height={wingARenderRect.height}
              rx={10}
              ry={10}
              className="wing-a-floor-border"
            />
          </>
        )}
        {wingBRenderRect && (
          <>
            <rect
              x={wingBRenderRect.x}
              y={wingBRenderRect.y}
              width={wingBRenderRect.width}
              height={wingBRenderRect.height}
              rx={10}
              ry={10}
              className="wing-b-floor-fill"
            />
            <rect
              x={wingBRenderRect.x}
              y={wingBRenderRect.y}
              width={wingBRenderRect.width}
              height={wingBRenderRect.height}
              rx={10}
              ry={10}
              className="wing-b-floor-border"
            />
          </>
        )}
        {resolvedWingCBorderRect && (
          <>
            <rect
              x={resolvedWingCBorderRect.x}
              y={resolvedWingCBorderRect.y}
              width={resolvedWingCBorderRect.width}
              height={resolvedWingCBorderRect.height}
              rx={10}
              ry={10}
              className="wing-c-floor-fill"
            />
            <rect
              x={resolvedWingCBorderRect.x}
              y={resolvedWingCBorderRect.y}
              width={resolvedWingCBorderRect.width}
              height={resolvedWingCBorderRect.height}
              rx={10}
              ry={10}
              className="wing-c-floor-border"
            />
          </>
        )}
        
        {/* WALKWAYS */}
        <g className="walkways">
          {hallwaySpaces.map((space) => (
            <rect
              key={`walkway-${space.id}`}
              x={space.x}
              y={space.y}
              width={space.width}
              height={space.height}
              rx={8}
              ry={8}
              className="walkway-shape"
            />
          ))}
        </g>

        {/* Floor label removed */}

        {/* SPACES */}
        {currentSpaces.map((space) => {
          if (isHallMarkerSpace(space)) return null;
          const isOrigin =
            originSpaceForFloor &&
            (space.id === originSpaceForFloor.id ||
              space.name === originSpaceForFloor.name);
          const isDestination =
            destinationSpaceForFloor &&
            (space.id === destinationSpaceForFloor.id ||
              space.name === destinationSpaceForFloor.name);
          const isClassroom = space.name.toLowerCase().includes("classroom");
          const inferredWing = space.type === SPACE_TYPE_ROOM ? detectWingFromIdentifiers(space) : null;
          const isWingB =
            space.type === SPACE_TYPE_ROOM &&
            (wingBRoomIds.has(space.id) ||
              space.id === "stock-room-1f" ||
              inferredWing === "B");
          const isWingC =
            space.type === SPACE_TYPE_ROOM &&
            !isWingB &&
            (wingCRoomIds.has(space.id) || inferredWing === "C");
          const isWingA = space.type === SPACE_TYPE_ROOM && !isWingB && !isWingC;
          const isIcsMegaHall = space.id === "ics-mega-hall";
          const shouldShowSpaceLabel = space.type !== SPACE_TYPE_BRIDGE;
          const center = spaceCenter(space);
          const poly = spaceHasPoly(space);
          return (
          <g
            key={space.id}
            className={`space-group ${space.type}${
              isClassroom ? " classroom" : ""
            }`}
          >
              {opts?.interactive !== false && space.type === SPACE_TYPE_ROOM ? (
                <rect
                  x={space.x - ROOM_HIT_PADDING}
                  y={space.y - ROOM_HIT_PADDING}
                  width={space.width + ROOM_HIT_PADDING * 2}
                  height={space.height + ROOM_HIT_PADDING * 2}
                  rx={8}
                  ry={8}
                  fill="rgba(15, 23, 42, 0.001)"
                  pointerEvents="all"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRoomSelectAsCurrentLocation?.(space.name);
                  }}
                />
              ) : null}
              {poly ? (
                <path
                  d={spacePathD(space)}
                  onMouseDown={
                    opts?.interactive === false || space.type !== SPACE_TYPE_ROOM
                      ? undefined
                      : (e) => e.stopPropagation()
                  }
                  onClick={
                    opts?.interactive === false || space.type !== SPACE_TYPE_ROOM
                      ? undefined
                      : (e) => {
                          e.stopPropagation();
                          onRoomSelectAsCurrentLocation?.(space.name);
                        }
                  }
                  className={`space ${space.type} ${
                    space.passable ? "passable" : ""
                  }${isOrigin ? " origin-space" : ""}${
                    isDestination ? " destination-space" : ""
                  }${isWingB ? " wing-b" : ""}${
                    isWingC ? " wing-c" : ""
                  }${
                    isClassroom ? " classroom" : ""
                  }`}
                />
              ) : (
                <rect
                  x={space.x}
                  y={space.y}
                  width={space.width}
                  height={space.height}
                  rx={space.type === SPACE_TYPE_LOUNGE ? 20 : space.type === SPACE_TYPE_ENTRANCE ? 10 : 8}
                  ry={space.type === SPACE_TYPE_LOUNGE ? 20 : space.type === SPACE_TYPE_ENTRANCE ? 10 : 8}
                  onMouseDown={
                    opts?.interactive === false || space.type !== SPACE_TYPE_ROOM
                      ? undefined
                      : (e) => e.stopPropagation()
                  }
                  onClick={
                    opts?.interactive === false || space.type !== SPACE_TYPE_ROOM
                      ? undefined
                      : (e) => {
                          e.stopPropagation();
                          onRoomSelectAsCurrentLocation?.(space.name);
                        }
                  }
                  className={`space ${space.type} ${
                    space.passable ? "passable" : ""
                  }${isOrigin ? " origin-space" : ""}${
                    isDestination ? " destination-space" : ""
                  }${isWingB ? " wing-b" : ""}${
                    isWingC ? " wing-c" : ""
                  }${
                    isClassroom ? " classroom" : ""
                  }`}
                />
              )}

            {space.type === SPACE_TYPE_STAIRS && (
              <path
                d={`M ${space.x + 6} ${space.y + space.height - 8}
                      h 8 v -8 h 8 v -8 h 8 v -8`}
                fill="none"
                stroke="#37474f"
                strokeWidth="2"
              />
            )}

            {shouldShowSpaceLabel ? (
              <text
                className={`space-label${isWingB ? " wing-b" : ""}${
                  isWingC ? " wing-c" : ""
                }${isWingA ? " wing-a" : ""
                }`}
              >
                <WrapText
                  text={space.name}
                  x={center.x}
                  y={center.y}
                  maxCharsPerLine={isIcsMegaHall ? 20 : 8}
                  lineHeight={isIcsMegaHall ? 10 : 12}
                />
              </text>
            ) : null}
          </g>
        );
        })}

        <g className="bridge-overlay-top">
          {bridgeOverlaySpaces.map((space) => (
            <g key={`bridge-overlay-${space.id}`}>
              <rect
                x={space.x}
                y={space.y}
                width={space.width}
                height={space.height}
                rx={8}
                ry={8}
                className="space bridge bridge-overlay-top-rect"
              />
            </g>
          ))}
        </g>

        {/* ROUTE */}
        {hasRouteForThisFloor && dForThisFloor && (
          <path
            ref={opts?.withRouteRef ? routePathRef : undefined}
            d={dForThisFloor}
            fill="none"
            stroke="#2563eb"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="route"
          />
        )}
        {hasRouteForThisFloor && dForThisFloor && showMotion && (
          <g>
            <use href="#route-arrow-shape" />
            <animateMotion
              dur={motionDuration}
              begin="0s"
              repeatCount="indefinite"
              rotate="auto"
              path={dForThisFloor}
            />
          </g>
        )}
        {hasRouteForThisFloor &&
          dForThisFloor &&
          useRouteEndPoint &&
          nearestStairsCenter &&
          typeof nextFloorHint === "number" &&
          f === floor && (
            <path
              d={`M ${useRouteEndPoint.x} ${useRouteEndPoint.y} L ${nearestStairsCenter.x} ${nearestStairsCenter.y}`}
              fill="none"
              stroke="#2563eb"
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="route"
            />
          )}

        {showWingBLabel && (
          <g>
            <rect
              x={wingBLabel.x}
              y={wingBLabel.y}
              width={wingLabelWidth}
              height={wingLabelHeight}
              rx={10}
              ry={10}
              fill="rgba(30,41,59,0.45)"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1}
            />
            <text
              x={wingBLabel.x + wingLabelWidth / 2}
              y={wingBLabel.y + 13}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{
                fill: "#fff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {`${ordinalFloorLabel(f)} - Wing B`}
            </text>
          </g>
        )}
        {showWingCLabel && (
          <g>
            <rect
              x={wingCLabel.x}
              y={wingCLabel.y}
              width={wingLabelWidth}
              height={wingLabelHeight}
              rx={10}
              ry={10}
              fill="rgba(30,41,59,0.45)"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1}
            />
            <text
              x={wingCLabel.x + wingLabelWidth / 2}
              y={wingCLabel.y + 13}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{
                fill: "#fff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {`${ordinalFloorLabel(f)} - Wing C`}
            </text>
          </g>
        )}
        {showWingALabel && (
          <g>
            <rect
              x={wingALabel.x}
              y={wingALabel.y}
              width={wingLabelWidth}
              height={wingLabelHeight}
              rx={10}
              ry={10}
              fill="rgba(30,41,59,0.45)"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1}
            />
            <text
              x={wingALabel.x + wingLabelWidth / 2}
              y={wingALabel.y + 13}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{
                fill: "#fff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              {`${ordinalFloorLabel(f)} - Wing A`}
            </text>
          </g>
        )}

        <line
          x1={0}
          y1={300}
          x2={1200}
          y2={300}
          className="wing-divider"
        />
        <line
          x1={0}
          y1={-8}
          x2={1635}
          y2={-8}
          className="wing-divider"
        />

        {/* ORIGIN PULSE */}
        {(() => {
          const hasPulseTarget =
            routeStartPoint ||
            useRouteEndPoint ||
            originSpaceForFloor ||
            originPointForFloor;
          if (!hasPulseTarget) return null;
          const isStairsOnlyRoute =
            hasRouteForThisFloor &&
            !originSpaceForFloor &&
            !destinationSpaceForFloor &&
            Boolean(nearestStairsCenter);
          const markerPoint = isStairsOnlyRoute && useRouteEndPoint
            ? useRouteEndPoint
            : hasRouteForThisFloor && routeStartPoint
            ? routeStartPoint
            : originIsMainEntrance && f === 1
            ? mainEntranceCenter
            : originPointForFloor
            ? originPointForFloor
            : originSpaceForFloor
            ? {
                x: originSpaceForFloor.x + originSpaceForFloor.width / 2,
                y: originSpaceForFloor.y + originSpaceForFloor.height / 2,
              }
            : null;
          if (!markerPoint) return null;
          return (
            <g
              className={`you-are-here${
                isStairsOnlyRoute ? " stairs-route" : ""
              }`}
            >
            <circle
              cx={markerPoint.x}
              cy={markerPoint.y}
              r="8"
              className="dot"
            />
            <circle
              cx={markerPoint.x}
              cy={markerPoint.y}
              r="16"
              className="pulse"
            />
            </g>
          );
        })()}
        </g>

      </svg>
    );
  };

  // ---------------- RENDER ----------------
  const multiFloor = useMemo(() => {
    if (orderedRouteFloors.length > 1) return true;
    const floors = floorKeysSorted(floorRoutes || {});
    return floors.length > 1;
  }, [orderedRouteFloors, floorRoutes]);

  const hasRouteDataFor3D = useMemo(() => {
    const hasFloorRoute = Object.values(floorRoutes || {}).some(
      (d) => typeof d === "string" && d.trim().length > 0
    );
    const hasSegmentRoute = segments.some(
      (s) => typeof s.d === "string" && s.d.trim().length > 0
    );
    return hasFloorRoute || hasSegmentRoute;
  }, [floorRoutes, segments]);

  const originFloor = useMemo(() => {
    if (originFloorFromName !== null) return originFloorFromName;
    if (orderedRouteFloors.length) return orderedRouteFloors[0];
    const floors = floorKeysSorted(floorRoutes || {});
    return floors.length ? floors[0] : null;
  }, [originFloorFromName, orderedRouteFloors, floorRoutes]);
  const getThumbnailViewBoxForFloor = (targetFloor: number) =>
    getCenteredViewBoxFromSpaces(getSpacesForFloor(targetFloor), {
      left: 36,
      right: 36,
      top: 40,
      bottom: 52,
    }) ?? INITIAL_VIEWBOX;
  const getModal2dViewBoxForFloor = (targetFloor: number) =>
    getCenteredViewBoxFromSpaces(getSpacesForFloor(targetFloor), {
      left: 20,
      right: 20,
      top: 24,
      bottom: 44,
    }) ?? getThumbnailViewBoxForFloor(targetFloor);
  const getThumbnailZoomViewBoxForFloor = (targetFloor: number) => {
    const fittedBounds = getZoneRectFromSpaces(getSpacesForFloor(targetFloor), {
      left: 12,
      right: 12,
      top: 20,
      bottom: 28,
    });
    return fittedBounds
      ? {
          x: fittedBounds.x,
          y: fittedBounds.y,
          w: fittedBounds.width,
          h: fittedBounds.height,
        }
      : getThumbnailViewBoxForFloor(targetFloor);
  };
  const originThumbViewBox =
    originFloor !== null ? getThumbnailViewBoxForFloor(originFloor) : INITIAL_VIEWBOX;
  const destination2DViewFloor = useMemo(() => {
    if (destinationFloorFromName !== null) return destinationFloorFromName;
    if (orderedRouteFloors.length) {
      return orderedRouteFloors[orderedRouteFloors.length - 1];
    }
    const floors = floorKeysSorted(floorRoutes || {});
    if (floors.length) return floors[floors.length - 1];
    return floor;
  }, [destinationFloorFromName, orderedRouteFloors, floorRoutes, floor]);
  const modal2dBaseViewBox = useMemo(
    () => getModal2dViewBoxForFloor(destination2DViewFloor),
    [destination2DViewFloor, layoutSignature]
  );
  const effectiveModal2dViewBox = modal2dViewBox
    ? {
        x: modal2dViewBox.x - modal2dPanOffset.x,
        y: modal2dViewBox.y - modal2dPanOffset.y,
        w: modal2dViewBox.w,
        h: modal2dViewBox.h,
      }
    : modal2dBaseViewBox;

  useEffect(() => {
    if (!show2DModal) return;
    setModal2dViewBox(modal2dBaseViewBox);
    setModal2dPanOffset({ x: 0, y: 0 });
    setIsModal2dPanning(false);
  }, [show2DModal, modal2dBaseViewBox]);

  function handleModal2dMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsModal2dPanning(true);
    setModal2dPanStart({ x: e.clientX, y: e.clientY });
  }

  function handleModal2dMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!isModal2dPanning || !modal2dViewBox) return;
    const svg = modal2dSvgRef.current;
    if (!svg) return;

    const dx = e.clientX - modal2dPanStart.x;
    const dy = e.clientY - modal2dPanStart.y;
    const rect = svg.getBoundingClientRect();
    const scaleX = modal2dViewBox.w / rect.width;
    const scaleY = modal2dViewBox.h / rect.height;

    setModal2dPanOffset({ x: dx * scaleX, y: dy * scaleY });
  }

  function commitModal2dPan() {
    if (!isModal2dPanning || !modal2dViewBox) return;
    setModal2dViewBox((prev) =>
      prev
        ? {
            x: prev.x - modal2dPanOffset.x,
            y: prev.y - modal2dPanOffset.y,
            w: prev.w,
            h: prev.h,
          }
        : prev
    );
    setModal2dPanOffset({ x: 0, y: 0 });
    setIsModal2dPanning(false);
  }

  const overviewFloors = useMemo(() => {
    const floors = new Set<number>();
    floorKeysSorted(floorRoutes || {}).forEach((f) => {
      if (Number.isFinite(f) && f > 0) floors.add(f);
    });
    orderedRouteFloors.forEach((f) => {
      if (Number.isFinite(f) && f > 0) floors.add(f);
    });
    if (!floors.size && hasRouteDataFor3D && Number.isFinite(floor) && floor > 0) {
      floors.add(floor);
    }
    if (!floors.size) {
      [1, 2, 3].forEach((candidateFloor) => {
        if (hasVisibleFloorContent(candidateFloor)) {
          floors.add(candidateFloor);
        }
      });
    }
    if (!floors.size) {
      floors.add(1);
    }
    return Array.from(floors)
      .filter((f) => Number.isFinite(f) && f > 0 && hasVisibleFloorContent(f))
      .sort((a, b) => a - b);
  }, [orderedRouteFloors, floorRoutes, hasRouteDataFor3D, floor, layoutSignature]);

  const destinationWingLabel = useMemo(() => {
    const key = destination?.trim().toLowerCase() ?? "";
    if (!key) return null;
    if (destinationIsWingC) return "Wing C";
    if (destinationIsWingB) return "Wing B";
    return "Wing A";
  }, [destination, destinationIsWingB, destinationIsWingC]);

  const showMultiThumbCloseDestinationHint = useCallback(() => {
    if (!multiFloor) return;
    const wingLabel = destinationWingLabel ?? "Destination Wing";
    const floorLabel = ordinalFloorLabel(destination2DViewFloor);
    if (multiThumbCloseHintTimerRef.current !== null) {
      window.clearTimeout(multiThumbCloseHintTimerRef.current);
    }
    setMultiThumbCloseHint(`Destination: ${floorLabel} ${wingLabel}`);
    multiThumbCloseHintTimerRef.current = window.setTimeout(() => {
      setMultiThumbCloseHint(null);
      multiThumbCloseHintTimerRef.current = null;
    }, 2500);
  }, [multiFloor, overviewFloors.length, destinationWingLabel, destination2DViewFloor]);

  useEffect(() => {
    const isAnyThumbZoomActive =
      multiFloor &&
      ((overviewFloors.length <= 2 && (thumbZoomed || thumbZoomClosing)) ||
        (overviewFloors.length > 2 &&
          (multiThumbZoomedFloor !== null || multiThumbZoomClosingFloor !== null)));
    if (prevAnyThumbZoomActiveRef.current && !isAnyThumbZoomActive) {
      showMultiThumbCloseDestinationHint();
    }
    prevAnyThumbZoomActiveRef.current = isAnyThumbZoomActive;
  }, [
    multiFloor,
    overviewFloors.length,
    thumbZoomed,
    thumbZoomClosing,
    multiThumbZoomedFloor,
    multiThumbZoomClosingFloor,
    showMultiThumbCloseDestinationHint,
  ]);

  const floorsFor3D = useMemo(() => {
    const routedFloors = overviewFloors
      .filter((f) => Number.isFinite(f) && f > 0)
      .sort((a, b) => a - b);
    if (routedFloors.length > 0) return routedFloors;
    if (Number.isFinite(floor) && floor > 0) return [floor];
    return [1];
  }, [overviewFloors, floor]);

  const canUse3DView = useMemo(() => floorsFor3D.length > 0, [floorsFor3D]);

  const samplePathPoints = (d: string, step = 12) => {
    if (!d) return [];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    const len = path.getTotalLength();
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= len; i += step) {
      const pt = path.getPointAtLength(i);
      pts.push({ x: pt.x, y: pt.y });
    }
    return pts;
  };

  const overviewThumbFloors = useMemo(() => {
    if (overviewFloors.length === 3) {
      if (originFloor !== null && overviewFloors.includes(originFloor)) {
        const nearestOther = overviewFloors
          .filter((f) => f !== originFloor)
          .sort((a, b) => Math.abs(a - originFloor) - Math.abs(b - originFloor))[0];
        return nearestOther !== undefined ? [originFloor, nearestOther] : [originFloor];
      }
      return [1, 2];
    }
    return overviewFloors.filter((f) => f >= 2);
  }, [overviewFloors, originFloor]);
  const activeMultiThumbFloor = multiThumbZoomedFloor ?? multiThumbZoomClosingFloor;

  useEffect(() => {
    if (overviewFloors.length > 2) {
      setShowMultiOverview(true);
    }
  }, [overviewFloors.length]);

  useEffect(() => {
    if (!canUse3DView) {
      setShow3DModal(false);
      lastMultiKeyRef.current = "";
      return;
    }
    if (!hasRouteDataFor3D) {
      lastMultiKeyRef.current = "";
      return;
    }
    const key = JSON.stringify({ route, floorRoutes });
    if (key !== lastMultiKeyRef.current) {
      setShow3DModal(true);
      lastMultiKeyRef.current = key;
    }
  }, [canUse3DView, hasRouteDataFor3D, multiFloor, route, floorRoutes]);

  useEffect(() => {
    if (show3DModal) modelPanXRef.current = 0;
  }, [show3DModal]);

  const THUMB_PREVIEW_MS = 2500;
  const THUMB_FOLD_MS = 420;
  const clearThumbTimers = () => {
    if (thumbAutoCloseTimerRef.current !== null) {
      window.clearTimeout(thumbAutoCloseTimerRef.current);
      thumbAutoCloseTimerRef.current = null;
    }
    if (thumbFoldTimerRef.current !== null) {
      window.clearTimeout(thumbFoldTimerRef.current);
      thumbFoldTimerRef.current = null;
    }
  };
  const clearMultiThumbTimers = () => {
    if (multiThumbAutoCloseTimerRef.current !== null) {
      window.clearTimeout(multiThumbAutoCloseTimerRef.current);
      multiThumbAutoCloseTimerRef.current = null;
    }
    if (multiThumbFoldTimerRef.current !== null) {
      window.clearTimeout(multiThumbFoldTimerRef.current);
      multiThumbFoldTimerRef.current = null;
    }
  };
  const scheduleThumbLeafClose = () => {
    clearThumbTimers();
    thumbAutoCloseTimerRef.current = window.setTimeout(() => {
      setThumbZoomClosing(true);
      thumbFoldTimerRef.current = window.setTimeout(() => {
        setThumbZoomClosing(false);
        setThumbZoomed(false);
      }, THUMB_FOLD_MS);
    }, THUMB_PREVIEW_MS);
  };
  const scheduleMultiThumbLeafClose = (
    targetFloor: number,
    onClosed?: () => void
  ) => {
    clearMultiThumbTimers();
    multiThumbAutoCloseTimerRef.current = window.setTimeout(() => {
      setMultiThumbZoomClosingFloor(targetFloor);
      multiThumbFoldTimerRef.current = window.setTimeout(() => {
        setMultiThumbZoomClosingFloor((prev) =>
          prev === targetFloor ? null : prev
        );
        setMultiThumbZoomedFloor((prev) => (prev === targetFloor ? null : prev));
        onClosed?.();
      }, THUMB_FOLD_MS);
    }, THUMB_PREVIEW_MS);
  };

  useEffect(() => {
    return () => {
      clearThumbTimers();
      clearMultiThumbTimers();
      if (multiThumbCloseHintTimerRef.current !== null) {
        window.clearTimeout(multiThumbCloseHintTimerRef.current);
        multiThumbCloseHintTimerRef.current = null;
      }
    };
  }, []);

  const closeThumbnailZoomOverlay = () => {
    clearThumbTimers();
    clearMultiThumbTimers();
    setThumbZoomClosing(false);
    setThumbZoomed(false);
    setMultiThumbZoomClosingFloor(null);
    setMultiThumbZoomedFloor(null);
  };

  const close3DModal = () => {
    setShow3DModal(false);
    if (!multiFloor || originFloor === null) return;

    if (overviewFloors.length <= 2) {
      setThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
      setThumbZoomDisabled(false);
      setThumbZoomClosing(false);
      setThumbZoomed(true);
      scheduleThumbLeafClose();
      return;
    }

    setShowMultiOverview(true);
    setMultiThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
    setMultiThumbZoomDisabled((prev) => ({ ...prev, [originFloor]: false }));
    setMultiThumbZoomClosingFloor(null);
    const fallbackFloor =
      overviewThumbFloors.find((f) => f === originFloor) ??
      overviewThumbFloors[0] ??
      null;
    setMultiThumbZoomedFloor(fallbackFloor);
    if (fallbackFloor !== null) {
      const fallbackIdx = overviewThumbFloors.indexOf(fallbackFloor);
      const nextFloor =
        (fallbackIdx >= 0 && fallbackIdx + 1 < overviewThumbFloors.length
          ? overviewThumbFloors[fallbackIdx + 1]
          : overviewThumbFloors.find((f) => f !== fallbackFloor)) ?? null;
      scheduleMultiThumbLeafClose(fallbackFloor, () => {
        if (nextFloor === null) return;
        setMultiThumbZoomedFloor(nextFloor);
        scheduleMultiThumbLeafClose(nextFloor);
      });
    }
  };
  const close2DModal = () => {
    setShow2DModal(false);
  };

  useEffect(() => {
    if (!show3DModal) return;
    const wrap = threeWrapRef.current;
    if (!wrap) return;

    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfff9de);

    const camera = new THREE.PerspectiveCamera(42, width / height, 1, 5000);
    camera.position.set(0, 180, 260);
    camera.lookAt(0, -22, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    wrap.innerHTML = "";
    wrap.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 1.15);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.55);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.95);
    dir.position.set(120, 220, 140);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-160, 140, -120);
    scene.add(fill);

    const group = new THREE.Group();
    scene.add(group);

    const scale = 0.26;
    const cx = INITIAL_VIEWBOX.w / 2;
    const cy = INITIAL_VIEWBOX.h / 2;
    const floorGap = 38;

    const roomHeight = 6;
    const hallwayHeight = 0.35;
    const materials = {
      room: new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.88,
      }),
      roomWingB: new THREE.MeshStandardMaterial({
        color: 0xbfdbfe,
        transparent: true,
        opacity: 0.88,
      }),
      roomWingC: new THREE.MeshStandardMaterial({
        color: 0xa7f3d0,
        transparent: true,
        opacity: 0.84,
      }),
      roomTop: new THREE.MeshStandardMaterial({ color: 0xf8fafc }),
      roomOutline: new THREE.LineBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.55,
      }),
      lounge: new THREE.MeshStandardMaterial({ color: 0xd6dde8 }),
      stairs: new THREE.MeshStandardMaterial({ color: 0xcfc7bf }),
      bridge: new THREE.MeshStandardMaterial({ color: 0xd8b78d }),
      entrance: new THREE.MeshStandardMaterial({ color: 0xf87171 }),
      entranceFront: new THREE.MeshStandardMaterial({ color: 0xb91c1c }),
      wingAFloor: new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        transparent: true,
        opacity: 0.7,
      }),
      wingBFloor: new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        transparent: true,
        opacity: 0.7,
      }),
      wingCFloor: new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        transparent: true,
        opacity: 0.7,
      }),
      origin: new THREE.MeshStandardMaterial({ color: 0x166534 }),
      destination: new THREE.MeshStandardMaterial({ color: 0x1e3a8a }),
      hallway: new THREE.MeshStandardMaterial({ color: 0xd8b4b4 }),
      hallwayVertical: new THREE.MeshStandardMaterial({ color: 0xd8b4b4 }),
    };
    const wingBRoomIds3D = new Set(
      [...WING_B_1F_OFFSET, ...WING_B_2F_OFFSET, ...WING_B_3F_OFFSET]
        .filter((space) => space.type === SPACE_TYPE_ROOM)
        .map((space) => space.id)
    );
    const wingCRoomIds3D = new Set(
      [...WING_C_1F_OFFSET, ...WING_C_2F_OFFSET, ...WING_C_3F_OFFSET]
        .filter((space) => space.type === SPACE_TYPE_ROOM)
        .map((space) => space.id)
    );

    const originKey = origin?.trim().toLowerCase() ?? "";
    const destKey = destination?.trim().toLowerCase() ?? "";
    const DESTINATION_WING_BRIGHTNESS_MULTIPLIER = 1.55;
    let destinationSpotlightConfig:
      | {
          x: number;
          y: number;
          z: number;
          roomHeight: number;
        }
      | null = null;
    const normalizeKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokensFrom = (value: string) =>
      normalizeKey(value).split(" ").filter(Boolean);
    const findSpaceMatch = (spaces: any[], key: string) => {
      if (!key) return null;
      const exact =
        spaces.find((s) => s.id.toLowerCase() === key) ||
        spaces.find((s) => s.name.toLowerCase() === key) ||
        null;
      if (exact) return exact;

      const normalizedKey = normalizeKey(key);
      const extractAuditoriumNumber = (value: string) => {
        const normalized = normalizeKey(value);
        const direct = normalized.match(/\bauditorium\s*b?\s*([0-9]+)f?\b/);
        if (direct) return Number(direct[1]);
        const compact = normalized.match(/\bauditorium([0-9]+)\b/);
        if (compact) return Number(compact[1]);
        return null;
      };
      const wantsAuditorium = normalizedKey.includes("auditorium");
      const requestedAuditoriumNumber = extractAuditoriumNumber(normalizedKey);
      if (wantsAuditorium && requestedAuditoriumNumber !== null) {
        const auditoriumMatch =
          spaces.find((s) => {
            const name = normalizeKey(s.name);
            const id = normalizeKey(s.id);
            if (!name.includes("auditorium") && !id.includes("auditorium")) {
              return false;
            }
            const num = extractAuditoriumNumber(`${name} ${id}`);
            return num === requestedAuditoriumNumber;
          }) || null;
        if (auditoriumMatch) return auditoriumMatch;
      }

      const tokens = tokensFrom(key);
      if (!tokens.length) return null;
      return (
        spaces.find((s) => {
          const name = normalizeKey(s.name);
          const id = normalizeKey(s.id);
          return tokens.every((t) => name.includes(t) || id.includes(t));
        }) || null
      );
    };

    const addHallwayRect = (floorY: number, hallwaySpace: Space) => {
      if (hallwaySpace.width <= 0 || hallwaySpace.height <= 0) return;
      const geo = new THREE.BoxGeometry(
        hallwaySpace.width * scale,
        hallwayHeight,
        hallwaySpace.height * scale
      );
      const hallwayMat =
        hallwaySpace.height > hallwaySpace.width
          ? materials.hallwayVertical
          : materials.hallway;
      const mesh = new THREE.Mesh(geo, hallwayMat);
      mesh.position.set(
        (hallwaySpace.x + hallwaySpace.width / 2 - cx) * scale,
        floorY + hallwayHeight / 2,
        (hallwaySpace.y + hallwaySpace.height / 2 - cy) * scale
      );
      group.add(mesh);
    };

    const createLabelSprite = (
      text: string,
      color = "#0f172a",
      options?: { fontWeight?: number; strokeColor?: string; strokeWidth?: number }
    ) => {
      const canvas = document.createElement("canvas");
      const fontSize = 58;
      const fontWeight = options?.fontWeight ?? 700;
      const padX = 56;
      const padY = 30;
      const measureCtx = canvas.getContext("2d");
      if (!measureCtx) return null;
      measureCtx.font = `${fontWeight} ${fontSize}px Arial, sans-serif`;
      const textWidth = Math.ceil(measureCtx.measureText(text).width);

      canvas.width = Math.max(360, textWidth + padX * 2);
      canvas.height = Math.max(120, fontSize + padY * 2);

      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255,255,255,0.58)";
      const pad = 12;
      const w = canvas.width - pad * 2;
      const h = canvas.height - pad * 2;
      const r = 14;
      ctx.beginPath();
      ctx.moveTo(pad + r, pad);
      ctx.lineTo(pad + w - r, pad);
      ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
      ctx.lineTo(pad + w, pad + h - r);
      ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
      ctx.lineTo(pad + r, pad + h);
      ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
      ctx.lineTo(pad, pad + r);
      ctx.quadraticCurveTo(pad, pad, pad + r, pad);
      ctx.closePath();
      ctx.fill();
      ctx.font = `${fontWeight} ${fontSize}px Arial, sans-serif`;
      if (options?.strokeColor && options?.strokeWidth) {
        ctx.strokeStyle = options.strokeColor;
        ctx.lineWidth = options.strokeWidth;
        ctx.lineJoin = "round";
        ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
      }
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      const widthScale = Math.min(76, Math.max(24, canvas.width / 16));
      const heightScale = Math.min(18, Math.max(7, canvas.height / 15));
      sprite.scale.set(widthScale, heightScale, 1);
      (sprite as any).userData = { labelTexture: texture };
      return sprite;
    };
    const createFloorTextMesh = (text: string, color = "#0f172a") => {
      const canvas = document.createElement("canvas");
      const fontSize = 42;
      const padX = 27;
      const padY = 18;
      const measureCtx = canvas.getContext("2d");
      if (!measureCtx) return null;
      measureCtx.font = `700 ${fontSize}px Arial, sans-serif`;
      const textWidth = Math.ceil(measureCtx.measureText(text).width);

      canvas.width = Math.max(360, textWidth + padX * 2);
      canvas.height = Math.max(120, fontSize + padY * 2);

      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `700 ${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);

      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      const planeWidth = 42;
      const planeHeight = (canvas.height / canvas.width) * planeWidth;
      const geo = new THREE.PlaneGeometry(planeWidth, planeHeight);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 18;
      return mesh;
    };
    const createFloorCornerLabelMesh = (text: string, color = "#0f172a") => {
      const canvas = document.createElement("canvas");
      const fontSize = 44;
      const padX = 24;
      const padY = 14;
      const measureCtx = canvas.getContext("2d");
      if (!measureCtx) return null;
      measureCtx.font = `700 ${fontSize}px Arial, sans-serif`;
      const textWidth = Math.ceil(measureCtx.measureText(text).width);

      canvas.width = Math.max(320, textWidth + padX * 2);
      canvas.height = Math.max(96, fontSize + padY * 2);

      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `700 ${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);

      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      const planeWidth = 34;
      const planeHeight = (canvas.height / canvas.width) * planeWidth;
      const geo = new THREE.PlaneGeometry(planeWidth, planeHeight);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 17;
      return mesh;
    };

    const stairsByFloor = new Map<number, { key: string; x: number; z: number }[]>();
    const floorYByFloor = new Map<number, number>();
    const normalizeStairsKey = (id: string) =>
      id.replace(/-(?:1|2|3)f\b/g, "").toLowerCase();

    const destMatches = floorsFor3D
      .map((floorNum) => {
        const spaces = getSpacesForFloor(floorNum);
        const match = destKey ? findSpaceMatch(spaces, destKey) : null;
        const hasRoute =
          Boolean(floorRoutes?.[String(floorNum)]?.trim()) ||
          segments.some((s) => s.floor === floorNum && s.d && s.d.trim());
        return match ? { floorNum, match, hasRoute } : null;
      })
      .filter(Boolean) as { floorNum: number; match: any; hasRoute: boolean }[];

    let destFloor: number | null = null;
    let destSpaceId: string | null = null;
    let destinationWing3D: "A" | "B" | "C" | null = null;
    const getDestinationWingForSpace3D = (space: Space): "A" | "B" | "C" => {
      const inferredWing = detectWingFromIdentifiers(space);
      if (inferredWing === "B" || inferredWing === "C") return inferredWing;
      if (wingBRoomIds3D.has(space.id) || space.id === "stock-room-1f") {
        return "B";
      }
      if (wingCRoomIds3D.has(space.id)) return "C";
      return "A";
    };
    const createDestinationWingFloorMaterial = (
      baseMaterial: THREE.MeshStandardMaterial
    ) => {
      const material = baseMaterial.clone();
      material.color.copy(
        baseMaterial.color
          .clone()
          .multiplyScalar(DESTINATION_WING_BRIGHTNESS_MULTIPLIER)
      );
      material.emissive.copy(baseMaterial.color.clone().multiplyScalar(0.12));
      material.emissiveIntensity = 0.28;
      material.opacity = Math.min(0.82, (baseMaterial.opacity ?? 1) * 1.08);
      material.transparent = true;
      return material;
    };
    if (destMatches.length) {
      const withRoute = destMatches.find((m) => m.hasRoute);
      const pick = withRoute ?? destMatches[destMatches.length - 1];
      destFloor = pick.floorNum;
      destSpaceId = pick.match.id;
      destinationWing3D = getDestinationWingForSpace3D(pick.match);
    }

    floorsFor3D.forEach((floorNum, idx) => {
      const y = idx * floorGap;
      floorYByFloor.set(floorNum, y);

      const wingASpaces = getWingASpacesForFloor(floorNum);
      const wingBSpaces = getWingBSpacesForFloor(floorNum);
      const wingCSpaces = getWingCSpacesForFloor(floorNum);
      const bridgeSpaces = getBridgeSpacesForFloor(floorNum);
      const wingARooms = getOverlayRightEdgeRooms(wingASpaces);
      const wingBRooms = getOverlayRightEdgeRooms(wingBSpaces);
      const wingCRooms = getOverlayRightEdgeRooms(wingCSpaces);
      const wingABorderTemplateSpaces = wingASpaces;
      const wingABorderTemplateRooms = wingARooms;
      const wingABorderRect3DBase = getWingABorderRect(
        wingABorderTemplateSpaces,
        wingABorderTemplateRooms,
        bridgeSpaces.ab
      );
      const wingBBorderTemplateSpaces = wingBSpaces;
      const wingBBorderTemplateRooms = wingBRooms;
      const wingBBorderBaseRect3D = getWingBBorderRect(
        wingBBorderTemplateSpaces,
        wingBBorderTemplateRooms
      );
      const wingBBorderRect3DBase = wingBBorderBaseRect3D;
      const wingCBorderTemplateSpaces = wingCSpaces;
      const wingCBorderTemplateRooms = wingCRooms;
      const wingCBorderRect3DBase = getWingCBorderRect(
        wingCBorderTemplateSpaces,
        wingCBorderTemplateRooms
      );
      const explicitWingBackgrounds3D =
        (floorNum === 2 || floorNum === 3 ? WING_BACKGROUND_RECTS[floorNum] : WING_BACKGROUND_RECTS[1]) ??
        {};
      const wing3DTopPad = 8;
      const wing3DBottomPad = 8;
      const inferredWingABorderRect3D =
        wingABorderRect3DBase
          ? {
              ...wingABorderRect3DBase,
              y: wingABorderRect3DBase.y - wing3DTopPad,
              height: wingABorderRect3DBase.height + wing3DTopPad + wing3DBottomPad,
            }
          : null;
      const inferredWingBBorderRect3D =
        wingBBorderRect3DBase
          ? {
              ...wingBBorderRect3DBase,
              y: wingBBorderRect3DBase.y - wing3DTopPad,
              height: wingBBorderRect3DBase.height + wing3DTopPad + wing3DBottomPad,
            }
          : null;
      const inferredWingCBorderRect3D =
        wingCBorderRect3DBase
          ? {
              ...wingCBorderRect3DBase,
              y: wingCBorderRect3DBase.y - wing3DTopPad,
              height: wingCBorderRect3DBase.height + wing3DTopPad + wing3DBottomPad,
            }
          : null;
      const wingABorderRect3D = explicitWingBackgrounds3D.A
        ? {
            x: explicitWingBackgrounds3D.A.x,
            y: explicitWingBackgrounds3D.A.y,
            width: explicitWingBackgrounds3D.A.width,
            height: explicitWingBackgrounds3D.A.height,
          }
        : inferredWingABorderRect3D;
      const wingBBorderRect3D = explicitWingBackgrounds3D.B
        ? {
            x: explicitWingBackgrounds3D.B.x,
            y: explicitWingBackgrounds3D.B.y,
            width: explicitWingBackgrounds3D.B.width,
            height: explicitWingBackgrounds3D.B.height,
          }
        : inferredWingBBorderRect3D;
      const wingCBorderRect3D = explicitWingBackgrounds3D.C
        ? {
            x: explicitWingBackgrounds3D.C.x,
            y: explicitWingBackgrounds3D.C.y,
            width: explicitWingBackgrounds3D.C.width,
            height: explicitWingBackgrounds3D.C.height,
          }
        : inferredWingCBorderRect3D;
      const spacesForFloor = getSpacesForFloor(floorNum);
      const hallwaySpaces3D = getRenderedHallwaySpaces(spacesForFloor);
      hallwaySpaces3D.forEach((hallwaySpace) => {
        addHallwayRect(y, hallwaySpace);
      });

      if (wingABorderRect3D) {
        const wingAFloorMaterial =
          destinationWing3D === "A" && destFloor === floorNum
            ? createDestinationWingFloorMaterial(materials.wingAFloor)
            : materials.wingAFloor;
        const wingAFloorFill = new THREE.Mesh(
          new THREE.PlaneGeometry(
            wingABorderRect3D.width * scale,
            wingABorderRect3D.height * scale
          ),
          wingAFloorMaterial
        );
        wingAFloorFill.rotation.x = -Math.PI / 2;
        wingAFloorFill.position.set(
          (wingABorderRect3D.x + wingABorderRect3D.width / 2 - cx) * scale,
          y + 0.22,
          (wingABorderRect3D.y + wingABorderRect3D.height / 2 - cy) * scale
        );
        group.add(wingAFloorFill);
      }
      if (wingBBorderRect3D) {
        const wingBFloorMaterial =
          destinationWing3D === "B" && destFloor === floorNum
            ? createDestinationWingFloorMaterial(materials.wingBFloor)
            : materials.wingBFloor;
        const wingBFloorFill = new THREE.Mesh(
          new THREE.PlaneGeometry(
            wingBBorderRect3D.width * scale,
            wingBBorderRect3D.height * scale
          ),
          wingBFloorMaterial
        );
        wingBFloorFill.rotation.x = -Math.PI / 2;
        wingBFloorFill.position.set(
          (wingBBorderRect3D.x + wingBBorderRect3D.width / 2 - cx) * scale,
          y + 0.22,
          (wingBBorderRect3D.y + wingBBorderRect3D.height / 2 - cy) * scale
        );
        group.add(wingBFloorFill);
      }
      if (wingCBorderRect3D) {
        const wingCFloorMaterial =
          destinationWing3D === "C" && destFloor === floorNum
            ? createDestinationWingFloorMaterial(materials.wingCFloor)
            : materials.wingCFloor;
        const wingCFloorFill = new THREE.Mesh(
          new THREE.PlaneGeometry(
            wingCBorderRect3D.width * scale,
            wingCBorderRect3D.height * scale
          ),
          wingCFloorMaterial
        );
        wingCFloorFill.rotation.x = -Math.PI / 2;
        wingCFloorFill.position.set(
          (wingCBorderRect3D.x + wingCBorderRect3D.width / 2 - cx) * scale,
          y + 0.22,
          (wingCBorderRect3D.y + wingCBorderRect3D.height / 2 - cy) * scale
        );
        group.add(wingCFloorFill);
      }

      const floorLabel = createFloorCornerLabelMesh(ordinalFloorLabel(floorNum));
      if (floorLabel && floorNum !== 1) {
        const labelMapX = 305;
        const labelMapY = INITIAL_VIEWBOX.h - 24;
        floorLabel.position.set(
          (labelMapX - cx) * scale,
          y + 0.08,
          (labelMapY - cy) * scale
        );
        group.add(floorLabel);
      }
      const getWingLabelPlacement = (rect: { x: number; y: number; width: number; height: number } | null) => {
        if (!rect) return null;
        const centerX = rect.x + rect.width / 2;
        const labelY = rect.y + Math.min(Math.max(rect.height * 0.34, 64), rect.height - 44);
        const floorGap = Math.max(64, Math.min(rect.width * 0.16, 150));
        return { centerX, labelY, floorGap };
      };
      const wingALabelPlacement = getWingLabelPlacement(wingABorderRect3D);
      const wingAFloorLabel = createFloorTextMesh("Wing A", "#0f172a");
      const wingALabelElevation = y + 0.3;
      if (wingAFloorLabel && wingALabelPlacement && hasVisibleWingContentForFloor(floorNum, "A")) {
        wingAFloorLabel.rotation.z = 0;
        wingAFloorLabel.scale.set(0.7, 0.7, 1);
        wingAFloorLabel.position.set(
          (wingALabelPlacement.centerX - cx) * scale,
          wingALabelElevation,
          (wingALabelPlacement.labelY - cy) * scale
        );
        group.add(wingAFloorLabel);
      }
      const wingAFloorLevelLabel = createFloorTextMesh(
        ordinalFloorLabel(floorNum),
        "#0f172a"
      );
      if (wingAFloorLevelLabel && wingALabelPlacement && hasVisibleWingContentForFloor(floorNum, "A")) {
        wingAFloorLevelLabel.rotation.z = 0;
        wingAFloorLevelLabel.scale.set(0.64, 0.64, 1);
        wingAFloorLevelLabel.position.set(
          ((wingALabelPlacement.centerX + wingALabelPlacement.floorGap) - cx) * scale,
          wingALabelElevation,
          (wingALabelPlacement.labelY - cy) * scale
        );
        group.add(wingAFloorLevelLabel);
      }
      const wingBLabelPlacement = getWingLabelPlacement(wingBBorderRect3D);
      const wingBFloorLabel = createFloorTextMesh("Wing B", "#0f172a");
      const wingBLabelElevation = y + 0.3;
      if (wingBFloorLabel && wingBLabelPlacement && hasVisibleWingContentForFloor(floorNum, "B")) {
        wingBFloorLabel.rotation.z = 0;
        wingBFloorLabel.scale.set(0.7, 0.7, 1);
        wingBFloorLabel.position.set(
          (wingBLabelPlacement.centerX - cx) * scale,
          wingBLabelElevation,
          (wingBLabelPlacement.labelY - cy) * scale
        );
        group.add(wingBFloorLabel);
      }
      const wingBFloorLevelLabel = createFloorTextMesh(
        ordinalFloorLabel(floorNum),
        "#0f172a"
      );
      if (wingBFloorLevelLabel && wingBLabelPlacement && hasVisibleWingContentForFloor(floorNum, "B")) {
        wingBFloorLevelLabel.rotation.z = 0;
        wingBFloorLevelLabel.scale.set(0.64, 0.64, 1);
        wingBFloorLevelLabel.position.set(
          ((wingBLabelPlacement.centerX + wingBLabelPlacement.floorGap) - cx) * scale,
          wingBLabelElevation,
          (wingBLabelPlacement.labelY - cy) * scale
        );
        group.add(wingBFloorLevelLabel);
      }
      const wingCLabelPlacement = getWingLabelPlacement(wingCBorderRect3D);
      const wingCFloorLabel = createFloorTextMesh("Wing C", "#0f172a");
      const wingCLabelElevation = y + 0.3;
      if (wingCFloorLabel && wingCLabelPlacement && hasVisibleWingContentForFloor(floorNum, "C")) {
        wingCFloorLabel.rotation.z = 0;
        wingCFloorLabel.scale.set(0.7, 0.7, 1);
        wingCFloorLabel.position.set(
          (wingCLabelPlacement.centerX - cx) * scale,
          wingCLabelElevation,
          (wingCLabelPlacement.labelY - cy) * scale
        );
        group.add(wingCFloorLabel);
      }
      const wingCFloorLevelLabel = createFloorTextMesh(
        ordinalFloorLabel(floorNum),
        "#0f172a"
      );
      if (wingCFloorLevelLabel && wingCLabelPlacement && hasVisibleWingContentForFloor(floorNum, "C")) {
        wingCFloorLevelLabel.rotation.z = 0;
        wingCFloorLevelLabel.scale.set(0.64, 0.64, 1);
        wingCFloorLevelLabel.position.set(
          ((wingCLabelPlacement.centerX + wingCLabelPlacement.floorGap) - cx) * scale,
          wingCLabelElevation,
          (wingCLabelPlacement.labelY - cy) * scale
        );
        group.add(wingCFloorLevelLabel);
      }

      const d = getDForFloor(floorNum);
      if (d) {
        const pts = samplePathPoints(d, 10);
        const trimRouteStartToDoor = (routePts: { x: number; y: number }[]) => {
          if (routePts.length < 2) return routePts;
          const startPt = routePts[0];
          const startRoom = spacesForFloor.find(
            (s) =>
              s.type === SPACE_TYPE_ROOM &&
              !s.passable &&
              startPt.x >= s.x &&
              startPt.x <= s.x + s.width &&
              startPt.y >= s.y &&
              startPt.y <= s.y + s.height
          );
          if (!startRoom) return routePts;
          const isInStartRoom = (p: { x: number; y: number }) =>
            p.x >= startRoom.x &&
            p.x <= startRoom.x + startRoom.width &&
            p.y >= startRoom.y &&
            p.y <= startRoom.y + startRoom.height;
          const firstOutsideIdx = routePts.findIndex(
            (p, idx) => idx > 0 && !isInStartRoom(p)
          );
          return firstOutsideIdx > 0 ? routePts.slice(firstOutsideIdx) : routePts;
        };
        const visiblePts = trimRouteStartToDoor(pts);
        if (visiblePts.length > 1) {
          const start = visiblePts[0];
          const sx = (start.x - cx) * scale;
          const sz = (start.y - cy) * scale;

          const dotGeo = new THREE.SphereGeometry(2.2, 16, 16);
          const dotMat = new THREE.MeshStandardMaterial({
            color: 0x10b981,
            emissive: 0x065f46,
            emissiveIntensity: 0.6,
          });
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.set(sx, y + 3, sz);
          group.add(dot);

          const ringGeo = new THREE.RingGeometry(2.8, 4.8, 32);
          const ringMat = new THREE.MeshBasicMaterial({
            color: 0x34d399,
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide,
          });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(sx, y + 2.8, sz);
          group.add(ring);

          (ring as any).userData = { pulse: 1, baseOpacity: 0.6 };

          const routePoints = visiblePts.map(
            (p) =>
              new THREE.Vector3((p.x - cx) * scale, y + 2, (p.y - cy) * scale)
          );
          if (routePoints.length > 1) {
            const routeCurve = new THREE.CatmullRomCurve3(routePoints);
            const routeUnderlay = new THREE.Mesh(
              new THREE.TubeGeometry(
                routeCurve,
                Math.max(24, routePoints.length * 2),
                2.2,
                12,
                false
              ),
              new THREE.MeshStandardMaterial({
                color: 0x3b82f6,
                emissive: 0x2563eb,
                emissiveIntensity: 0.75,
                transparent: true,
                opacity: 0.72,
              })
            );
            group.add(routeUnderlay);

            const routeGeo = new THREE.BufferGeometry().setFromPoints(routePoints);
            const routeMat = new THREE.LineDashedMaterial({
              color: 0xbfdbfe,
              dashSize: 3.6,
              gapSize: 2.0,
              linewidth: 12,
              toneMapped: false,
              depthTest: true,
              depthWrite: true,
            });
            const routeLine = new THREE.Line(routeGeo, routeMat);
            routeLine.computeLineDistances();
            routeLine.position.y = 2.25;
            (routeLine as any).userData = { routeDash: true, speed: 0.22 };
            group.add(routeLine);

            const routeGlowMat = new THREE.LineDashedMaterial({
              color: 0x60a5fa,
              dashSize: 3.6,
              gapSize: 2.0,
              transparent: true,
              opacity: 0.5,
              blending: THREE.AdditiveBlending,
              depthTest: true,
              depthWrite: false,
            });
            const routeGlowLine = new THREE.Line(routeGeo.clone(), routeGlowMat);
            routeGlowLine.computeLineDistances();
            routeGlowLine.position.y = 2.25;
            (routeGlowLine as any).userData = { routeDash: true, speed: 0.22 };
            group.add(routeGlowLine);

            const pathArrow = new THREE.Mesh(
              new THREE.ConeGeometry(1.8, 5.2, 14),
              new THREE.MeshStandardMaterial({
                color: 0x1e3a8a,
                emissive: 0x1e40af,
                emissiveIntensity: 0.9,
                depthTest: false,
                depthWrite: false,
              })
            );
            const startP = routeCurve.getPointAt(0);
            pathArrow.position.copy(startP);
            pathArrow.renderOrder = 22;
            (pathArrow as any).userData = {
              routePathArrow: true,
              curve: routeCurve,
              t: 0,
              speed: 0.0026,
            };
            group.add(pathArrow);
          }
        }
      }

      const originSpaceForFloor = originKey
        ? findSpaceMatch(spacesForFloor, originKey)
        : null;
      const destSpaceForFloor =
        destKey && destFloor === floorNum
          ? findSpaceMatch(spacesForFloor, destKey)
          : null;
      const stairsForFloor: { key: string; x: number; z: number }[] = [];
      spacesForFloor.forEach((s) => {
        if (isHallMarkerSpace(s)) return;
        const isDestination3D =
          Boolean(destSpaceId && destSpaceForFloor && s.id === destSpaceId);
        const isOrigin3D = Boolean(
          originSpaceForFloor && s.id === originSpaceForFloor.id
        );
        const inferredWing3D = s.type === SPACE_TYPE_ROOM ? detectWingFromIdentifiers(s) : null;
        const isWingBRoom3D =
          s.type === SPACE_TYPE_ROOM &&
          (wingBRoomIds3D.has(s.id) ||
            s.id === "stock-room-1f" ||
            inferredWing3D === "B");
        const isWingCRoom3D =
          s.type === SPACE_TYPE_ROOM && !isWingBRoom3D && (wingCRoomIds3D.has(s.id) || inferredWing3D === "C");
        const isMainEntrance3D = s.id === MAIN_ENTRANCE_ID;
        const baseMat =
          isDestination3D
            ? materials.destination
            : isOrigin3D
            ? materials.origin
            : isMainEntrance3D
            ? materials.entrance
            : isWingBRoom3D
            ? materials.roomWingB
            : isWingCRoom3D
            ? materials.roomWingC
            : (materials as any)[s.type] ?? materials.room;
        const mat = isDestination3D
          ? (baseMat as THREE.MeshStandardMaterial).clone()
          : baseMat;
        if (isDestination3D) {
          (mat as THREE.MeshStandardMaterial).emissive = new THREE.Color(
            0x111111
          );
          (mat as THREE.MeshStandardMaterial).emissiveIntensity = 0.2;
        }
        const elementHeight =
          s.type === SPACE_TYPE_LOUNGE ||
          s.type === SPACE_TYPE_STAIRS ||
          s.type === SPACE_TYPE_BRIDGE ||
          s.type === SPACE_TYPE_ENTRANCE
            ? 2.6
            : roomHeight;
        const isPolyRoom = spaceHasPoly(s);
        const geo = isPolyRoom
          ? (() => {
              const shape = new THREE.Shape(
                s.poly!.points.map(
                  (point) => new THREE.Vector2((point.x - cx) * scale, (cy - point.y) * scale)
                )
              );
              const extruded = new THREE.ExtrudeGeometry(shape, {
                depth: elementHeight,
                bevelEnabled: false,
              });
              extruded.rotateX(-Math.PI / 2);
              return extruded;
            })()
          : new THREE.BoxGeometry(
              s.width * scale,
              elementHeight,
              s.height * scale
            );
        const mesh = new THREE.Mesh(geo, mat);
        if (isDestination3D) {
          (mesh as any).userData = {
            roomBlink: true,
            blinkPhase: 0,
          };
        }
        const center = spaceCenter(s);
        const centerX = center.x;
        const centerY = center.y;
        if (isPolyRoom) {
          mesh.position.set(0, y, 0);
        } else {
          mesh.position.set(
            (centerX - cx) * scale,
            y + elementHeight / 2,
            (centerY - cy) * scale
          );
        }
        if (isDestination3D) {
          destinationSpotlightConfig = {
            x: (centerX - cx) * scale,
            y: y + elementHeight / 2,
            z: (centerY - cy) * scale,
            roomHeight: elementHeight,
          };
        }
        group.add(mesh);
        if (s.type === SPACE_TYPE_ROOM && !isPolyRoom) {
          const roomColor = new THREE.Color(
            ((mat as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xffffff)).getHex()
          );
          roomColor.multiplyScalar(0.78);
          const frontMat = new THREE.MeshStandardMaterial({
            color: roomColor.getHex(),
          });
          const frontPanel = new THREE.Mesh(
            new THREE.BoxGeometry(
              Math.max(0.8, s.width * scale - 0.25),
              Math.max(0.8, elementHeight - 0.25),
              0.18
            ),
            frontMat
          );
          frontPanel.position.set(
            (centerX - cx) * scale,
            y + elementHeight / 2,
            (centerY - cy) * scale + (s.height * scale) / 2 - 0.1
          );
          group.add(frontPanel);
        }
        if (isMainEntrance3D) {
          const frontPanel = new THREE.Mesh(
            new THREE.BoxGeometry(
              Math.max(0.8, s.width * scale - 0.25),
              Math.max(0.8, elementHeight - 0.25),
              0.18
            ),
            materials.entranceFront
          );
          frontPanel.position.set(
            (centerX - cx) * scale,
            y + elementHeight / 2,
            (centerY - cy) * scale + (s.height * scale) / 2 - 0.1
          );
          group.add(frontPanel);
        }
        if (s.type === SPACE_TYPE_STAIRS) {
          const stairCapW = Math.max(1.1, (s.width * scale) * 0.42);
          const stairCapD = Math.max(1.1, (s.height * scale) * 0.42);
          const stairCap = new THREE.Mesh(
            new THREE.BoxGeometry(stairCapW, 0.55, stairCapD),
            new THREE.MeshStandardMaterial({ color: 0xb8b0a8 })
          );
          stairCap.position.set(
            (centerX - cx) * scale,
            y + elementHeight + 0.275,
            (centerY - cy) * scale
          );
          group.add(stairCap);

          const stairCap2 = new THREE.Mesh(
            new THREE.BoxGeometry(stairCapW * 0.8, 0.43, stairCapD * 0.8),
            new THREE.MeshStandardMaterial({ color: 0xd9d2cb })
          );
          stairCap2.position.set(
            (centerX - cx) * scale + stairCapW * 0.2,
            y + elementHeight + 0.81,
            (centerY - cy) * scale + stairCapD * 0.2
          );
          group.add(stairCap2);
        }
        if (s.type === SPACE_TYPE_ROOM && !isOrigin3D && !isDestination3D) {
          if (isPolyRoom) {
            const topShape = new THREE.Shape(
              s.poly!.points.map(
                (point) => new THREE.Vector2((point.x - cx) * scale, (cy - point.y) * scale)
              )
            );
            const topMesh = new THREE.Mesh(
              new THREE.ShapeGeometry(topShape),
              materials.roomTop
            );
            topMesh.rotation.x = -Math.PI / 2;
            topMesh.position.set(0, y + elementHeight + 0.03, 0);
            group.add(topMesh);

            const outlinePoints = s.poly!.points.map(
              (point) => new THREE.Vector3((point.x - cx) * scale, y + elementHeight + 0.06, (point.y - cy) * scale)
            );
            const outline = new THREE.LineLoop(
              new THREE.BufferGeometry().setFromPoints(outlinePoints),
              materials.roomOutline
            );
            group.add(outline);
          } else {
          const topInset = 0.9;
          const topW = Math.max(1, s.width * scale - topInset);
          const topH = Math.max(1, s.height * scale - topInset);
          const topMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(topW, topH),
            materials.roomTop
          );
          topMesh.rotation.x = -Math.PI / 2;
          topMesh.position.set(
            (centerX - cx) * scale,
            y + elementHeight + 0.03,
            (centerY - cy) * scale
          );
          group.add(topMesh);

          const halfW = topW / 2;
          const halfH = topH / 2;
          const outline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(-halfW, 0, -halfH),
              new THREE.Vector3(halfW, 0, -halfH),
              new THREE.Vector3(halfW, 0, halfH),
              new THREE.Vector3(-halfW, 0, halfH),
            ]),
            materials.roomOutline
          );
          outline.position.set(
            (centerX - cx) * scale,
            y + elementHeight + 0.06,
            (centerY - cy) * scale
          );
          group.add(outline);
          }
        }
        if (isOrigin3D || isDestination3D) {
          const labelColor = "#000000";
          const label = createLabelSprite(
            `${s.name}`,
            labelColor,
            { fontWeight: 900, strokeColor: "#000000", strokeWidth: 1.4 }
          );
          if (label) {
            label.position.set(
              (centerX - cx) * scale,
              y + elementHeight + 8,
              (centerY - cy) * scale
            );
            group.add(label);
          }
        }
        if (isMainEntrance3D) {
          const floorText = createFloorTextMesh(MAIN_ENTRANCE_NAME, "#0f172a");
          if (floorText) {
            const besideX = (centerX - cx) * scale + (s.width * scale) / 2 + 24;
            floorText.position.set(besideX, y + 0.08, (centerY - cy) * scale);
            group.add(floorText);
          }
        }
        if (s.type === SPACE_TYPE_STAIRS) {
          stairsForFloor.push({
            key: normalizeStairsKey(s.id),
            x: (centerX - cx) * scale,
            z: (centerY - cy) * scale,
          });
        }
      });
      stairsByFloor.set(floorNum, stairsForFloor);

      // 3D overlay is now derived from current room geometry only, so published
      // layout edits are reflected without hardcoded hallway/floor coordinates.
    });

    const spotlightConfig = destinationSpotlightConfig as
      | {
          x: number;
          y: number;
          z: number;
          roomHeight: number;
        }
      | null;
    if (spotlightConfig) {
      const destinationSpotTarget = new THREE.Object3D();
      destinationSpotTarget.position.set(
        spotlightConfig.x,
        spotlightConfig.y,
        spotlightConfig.z
      );
      group.add(destinationSpotTarget);

      const destinationSpotlight = new THREE.SpotLight(
        0xffeb3b,
        95,
        185,
        0.22,
        0.25,
        1.35
      );
      destinationSpotlight.position.set(
        spotlightConfig.x,
        spotlightConfig.y + spotlightConfig.roomHeight + 44,
        spotlightConfig.z
      );
      destinationSpotlight.target = destinationSpotTarget;
      destinationSpotlight.castShadow = false;
      group.add(destinationSpotlight);
    }

    const addStairsConnector = (
      x: number,
      z: number,
      yFrom: number,
      yTo: number
    ) => {
      const height = Math.abs(yTo - yFrom);
      const mid = (yFrom + yTo) / 2;
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(1.8, 1.8, height, 14),
        new THREE.MeshStandardMaterial({
          color: 0x1e3a8a,
          emissive: 0x1e40af,
          emissiveIntensity: 0.55,
        })
      );
      cyl.position.set(x, mid, z);
      group.add(cyl);

      const arrowGeo = new THREE.ConeGeometry(2.3, 6.4, 18);
      const arrowMat = new THREE.MeshStandardMaterial({
        color: 0x1e3a8a,
        emissive: 0x1e40af,
        emissiveIntensity: 1.2,
        depthTest: false,
        depthWrite: false,
      });
      const makeArrow = (offset: number) => {
        const startY = yFrom + offset;
        const endY = yTo;
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.position.set(x + 3.5, startY, z);
        arrow.renderOrder = 20;
        (arrow as any).userData = {
          arrow: true,
          startY,
          endY,
          speed: 0.25,
        };
        const dir = endY > startY ? 1 : -1;
        arrow.rotation.x = dir > 0 ? 0 : Math.PI;
        group.add(arrow);
      };
      makeArrow(3);
    };

    const floorsAsc = [...floorsFor3D].sort((a, b) => a - b);
    const stairKeysForFloor = new Map<
      number,
      { startKey: string | null; endKey: string | null }
    >();
    const routeEndpointsForFloor = new Map<
      number,
      { start: { x: number; y: number } | null; end: { x: number; y: number } | null }
    >();
    floorsAsc.forEach((floorNum) => {
      const d = getDForFloor(floorNum);
      const pts = d ? samplePathPoints(d, 10) : [];
      const stairs = stairsByFloor.get(floorNum) || [];
      const nearestStairKey = (pt: { x: number; y: number } | null) => {
        if (!pt || !stairs.length) return null;
        let bestKey: string | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        stairs.forEach((s) => {
          const sx = s.x / scale + cx;
          const sz = s.z / scale + cy;
          const dx = sx - pt.x;
          const dz = sz - pt.y;
          const dist2 = dx * dx + dz * dz;
          if (dist2 < bestDist) {
            bestDist = dist2;
            bestKey = s.key;
          }
        });
        return bestKey;
      };
      if (!pts.length) {
        routeEndpointsForFloor.set(floorNum, { start: null, end: null });
        stairKeysForFloor.set(floorNum, { startKey: null, endKey: null });
        return;
      }
      const startPt = pts[0];
      const endPt = pts[pts.length - 1];
      routeEndpointsForFloor.set(floorNum, { start: startPt, end: endPt });
      stairKeysForFloor.set(floorNum, {
        startKey: nearestStairKey(startPt),
        endKey: nearestStairKey(endPt),
      });
    });

    const transitionDirByPair = new Map<string, 1 | -1>();
    if (orderedRouteFloors.length > 1) {
      for (let i = 0; i < orderedRouteFloors.length - 1; i++) {
        const a = orderedRouteFloors[i];
        const b = orderedRouteFloors[i + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
        const lower = Math.min(a, b);
        const upper = Math.max(a, b);
        const dir: 1 | -1 = b > a ? 1 : -1;
        transitionDirByPair.set(`${lower}-${upper}`, dir);
      }
    }
    const inferredDestFloorFor3D =
      destinationFloorFromName !== null
        ? destinationFloorFromName
        : Number.isFinite(floor)
        ? floor
        : null;
    let globalRouteDir: 1 | -1 | 0 = 0;
    if (
      originFloorFromName !== null &&
      inferredDestFloorFor3D !== null &&
      originFloorFromName !== inferredDestFloorFor3D
    ) {
      globalRouteDir = inferredDestFloorFor3D > originFloorFromName ? 1 : -1;
    } else if (orderedRouteFloors.length > 1) {
      const first = orderedRouteFloors[0];
      const last = orderedRouteFloors[orderedRouteFloors.length - 1];
      if (Number.isFinite(first) && Number.isFinite(last) && first !== last) {
        globalRouteDir = last > first ? 1 : -1;
      }
    }

    for (let i = 0; i < floorsAsc.length - 1; i++) {
      const lower = floorsAsc[i];
      const upper = floorsAsc[i + 1];
      const yLower = floorYByFloor.get(lower);
      const yUpper = floorYByFloor.get(upper);
      if (yLower === undefined || yUpper === undefined) continue;
      const lowerStairs = stairsByFloor.get(lower) || [];
      const upperStairs = stairsByFloor.get(upper) || [];
      const pairKey = `${lower}-${upper}`;
      const pairDir = transitionDirByPair.get(pairKey) ?? 0;
      const dir = (pairDir || globalRouteDir || 1) as 1 | -1;
      const lowerKeys = stairKeysForFloor.get(lower) ?? {
        startKey: null,
        endKey: null,
      };
      const upperKeysByDir = stairKeysForFloor.get(upper) ?? {
        startKey: null,
        endKey: null,
      };
      const lowerKey = dir > 0 ? lowerKeys.endKey : lowerKeys.startKey;
      const upperKey = dir > 0 ? upperKeysByDir.startKey : upperKeysByDir.endKey;
      const upperKeys = new Set(upperStairs.map((u) => u.key));
      const commonKeys = lowerStairs
        .map((s) => s.key)
        .filter((k) => upperKeys.has(k));
      if (!commonKeys.length) continue;

      let pairAnchorKey: string | null = null;
      const lowerEndpoints = routeEndpointsForFloor.get(lower) ?? {
        start: null,
        end: null,
      };
      const upperEndpoints = routeEndpointsForFloor.get(upper) ?? {
        start: null,
        end: null,
      };
      const lowerAnchor = dir > 0 ? lowerEndpoints.end : lowerEndpoints.start;
      const upperAnchor = dir > 0 ? upperEndpoints.start : upperEndpoints.end;
      if (lowerAnchor && upperAnchor) {
        let bestScore = Number.POSITIVE_INFINITY;
        commonKeys.forEach((k) => {
          const ls = lowerStairs.find((s) => s.key === k);
          const us = upperStairs.find((s) => s.key === k);
          if (!ls || !us) return;
          const lsx = ls.x / scale + cx;
          const lsz = ls.z / scale + cy;
          const usx = us.x / scale + cx;
          const usz = us.z / scale + cy;
          const dLower =
            (lsx - lowerAnchor.x) * (lsx - lowerAnchor.x) +
            (lsz - lowerAnchor.y) * (lsz - lowerAnchor.y);
          const dUpper =
            (usx - upperAnchor.x) * (usx - upperAnchor.x) +
            (usz - upperAnchor.y) * (usz - upperAnchor.y);
          const score = dLower + dUpper;
          if (score < bestScore) {
            bestScore = score;
            pairAnchorKey = k;
          }
        });
      }

      const preferredKey =
        pairAnchorKey
          ? pairAnchorKey
          : lowerKey && upperKey && lowerKey === upperKey && upperKeys.has(lowerKey)
          ? lowerKey
          : lowerKey && upperKeys.has(lowerKey)
          ? lowerKey
          : upperKey && commonKeys.includes(upperKey)
          ? upperKey
          : commonKeys[0];
      if (!preferredKey) continue;

      const lowerMatch = lowerStairs.find((s) => s.key === preferredKey);
      if (!lowerMatch) continue;

      if (dir > 0) {
        addStairsConnector(lowerMatch.x, lowerMatch.z, yLower + 2, yUpper + 2);
      } else {
        addStairsConnector(lowerMatch.x, lowerMatch.z, yUpper + 2, yLower + 2);
      }
    }

    // Always start from a consistent, user-facing angle.
    const baseRotationY = -0.55;
    const baseRotationX = -0.35;

    // Keep the whole model centered in the canvas regardless of route/floor mix.
    const bounds = new THREE.Box3().setFromObject(group);
    const center = bounds.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -center.y, -center.z);

    group.rotation.y = baseRotationY;
    group.rotation.x = baseRotationX;
    const baseGroupPosition = group.position.clone();

    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let dragMode: "rotate" | "pan" = "rotate";
    let manualYaw = 0;
    let manualPitch = 0;
    let manualPanX = 0;

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // Left drag = rotate. Right/middle drag = pan left/right.
      dragMode = e.button === 1 || e.button === 2 ? "pan" : "rotate";
      renderer.domElement.setPointerCapture?.(e.pointerId);
      renderer.domElement.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dragMode === "pan") {
        manualPanX += dx * 0.14;
      } else {
        manualYaw += dx * 0.005;
        manualPitch += dy * 0.005;
        manualPitch = Math.max(-1.75, Math.min(0.45, manualPitch));
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      renderer.domElement.releasePointerCapture?.(e.pointerId);
      renderer.domElement.style.cursor = "grab";
    };

    renderer.domElement.style.cursor = "grab";
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerUp);

    let raf = 0;
    const render = () => {
      const autoYaw = isDragging ? 0 : Math.sin(Date.now() * 0.0012) * 0.2;
      group.rotation.y = baseRotationY + manualYaw + autoYaw;
      group.rotation.x = baseRotationX + manualPitch;
      group.position.set(
        baseGroupPosition.x + manualPanX + modelPanXRef.current,
        baseGroupPosition.y,
        baseGroupPosition.z
      );
      group.traverse((obj) => {
        const data = (obj as any).userData;
        if (data && data.pulse) {
          data.pulse += 0.05;
          const s = 1 + Math.sin(data.pulse) * 0.25;
          obj.scale.set(s, s, s);
          if ((obj as THREE.Mesh).material) {
            const mat = (obj as THREE.Mesh).material as THREE.Material;
            if ("opacity" in mat) {
              (mat as THREE.MeshBasicMaterial).opacity =
                data.baseOpacity * (0.7 + 0.3 * Math.sin(data.pulse));
            }
          }
        }
        if (data && data.arrow) {
          const dir = data.endY > data.startY ? 1 : -1;
          obj.position.y += data.speed * dir;
          if (
            (dir > 0 && obj.position.y > data.endY) ||
            (dir < 0 && obj.position.y < data.endY)
          ) {
            obj.position.y = data.startY;
          }
        }
        if (data && data.roomBlink) {
          const phase = Date.now() * 0.006 + (data.blinkPhase ?? 0);
          const pulse = 0.55 + 0.45 * (Math.sin(phase) + 1) / 2;
          const meshObj = obj as THREE.Mesh;
          const mat = meshObj.material as THREE.MeshStandardMaterial;
          if (mat && "emissiveIntensity" in mat) {
            mat.emissiveIntensity = 0.2 + pulse * 0.9;
          }
        }
        if (data && data.routeDash) {
          const mat = (obj as THREE.Line).material as THREE.LineDashedMaterial & {
            dashOffset?: number;
          };
          if (typeof mat.dashOffset === "number") {
            mat.dashOffset -= data.speed;
          }
        }
        if (data && data.routePathArrow) {
          data.t = (data.t + data.speed) % 1;
          const curve = data.curve as THREE.CatmullRomCurve3;
          const p = curve.getPointAt(data.t);
          const tangent = curve.getTangentAt(data.t).normalize();
          obj.position.copy(p);
          const dir = new THREE.Vector3(tangent.x, 0, tangent.z).normalize();
          if (dir.lengthSq() > 0.0001) {
            obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          }
        }
      });
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    render();

    const handleResize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerUp);
      cancelAnimationFrame(raf);
      renderer.dispose();
      scene.traverse((obj) => {
        const anyObj = obj as any;
        if (anyObj.geometry) {
          anyObj.geometry.dispose();
        }
        if (anyObj.material) {
          const mat = anyObj.material;
          if (Array.isArray(mat)) {
            mat.forEach((m) => {
              if ((m as any).map?.dispose) (m as any).map.dispose();
              m.dispose();
            });
          } else {
            if ((mat as any).map?.dispose) (mat as any).map.dispose();
            mat.dispose?.();
          }
        }
        if (anyObj.userData?.labelTexture?.dispose) {
          anyObj.userData.labelTexture.dispose();
        }
      });
      Object.values(materials).forEach((m) => m.dispose());
      if (wrap.contains(renderer.domElement)) {
        wrap.removeChild(renderer.domElement);
      }
    };
  }, [show3DModal, floorsFor3D, route, floorRoutes, origin, destination, floor, layoutSignature]);

  return (
    <div className="map-stage" style={{ width: "100%", height: "100%" }}>
      <div className="zoom-controls">
        <button onClick={zoomIn}>+</button>
        <button onClick={zoomOut}>-</button>
        <button
          onClick={resetZoom}
          className="reset"
          title="Reset zoom"
          aria-label="Reset zoom"
        >
          {"\u27f3"}
        </button>
      </div>
      <div
        className={`map-wrapper${
          thumbZoomed || multiThumbZoomedFloor !== null ? " is-dim" : ""
        }`}
        style={{ position: "relative" }}
        ref={mapWrapRef}
      >
        {/* Floor switch hint */}
        {floorHint && (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "6px 12px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.75)",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              zIndex: 5,
              pointerEvents: "none",
            }}
          >
            {floorHint}
          </div>
        )}
        {multiThumbCloseHint && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              padding: "10px 18px",
              borderRadius: 12,
              background: "rgba(15, 23, 42, 0.86)",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 800,
              letterSpacing: 0.2,
              zIndex: 10000,
              pointerEvents: "none",
              boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
              textAlign: "center",
              maxWidth: "80%",
            }}
          >
            {multiThumbCloseHint}
          </div>
        )}

        <div className="floor-transition" ref={transitionWrapRef}>
          {transition ? (
            <>
              <div className="floor-sizer">
                {renderFloorSvg(transition.to, {
                  interactive: false,
                  withRouteRef: false,
                  overlayFloor: transition.to,
                })}
              </div>
              <div
                className={`floor-layer floor-out${
                  transition.active ? " is-animating" : ""
                }`}
              >
                {renderFloorSvg(transition.from, {
                  interactive: false,
                  withRouteRef: false,
                  overlayFloor: transition.from,
                })}
              </div>
              <div
                className={`floor-layer floor-in${
                  transition.active ? " is-animating" : ""
                }`}
              >
                {renderFloorSvg(transition.to, {
                  interactive: true,
                  withRouteRef: true,
                  overlayFloor: transition.to,
                })}
              </div>
            </>
          ) : (
            renderFloorSvg(floor, { interactive: true, withRouteRef: true, overlayFloor: floor })
          )}
        </div>

        {multiFloor && originFloor !== null && overviewFloors.length <= 2 && (
          <div
            ref={thumbRef}
            className={`floor-thumbnail${
              thumbDrag.active ? " is-dragging" : ""
            }${thumbZoomDisabled ? " no-zoom" : ""}`}
            onPointerLeave={() => {
              setThumbZoomDisabled(false);
            }}
            onClick={() => {
              if (thumbWasDragRef.current) {
                thumbWasDragRef.current = false;
                return;
              }
              if (thumbZoomDisabled || thumbDrag.active) return;
              clearThumbTimers();
              setThumbZoomClosing(false);
              setThumbZoomed(true);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              const container = mapWrapRef.current;
              const containerRect = container?.getBoundingClientRect();
              const rect = thumbRef.current?.getBoundingClientRect();
              if (!rect || !containerRect) return;
              thumbWasDragRef.current = false;
              setThumbZoomDisabled(true);
              setThumbZoomed(false);
              const currentX =
                thumbPos?.x ?? rect.left - (containerRect?.left ?? 0);
              const currentY =
                thumbPos?.y ?? rect.top - (containerRect?.top ?? 0);
              (e.currentTarget as HTMLDivElement).setPointerCapture(
                e.pointerId
              );
              setThumbDrag({
                active: true,
                startX: e.clientX,
                startY: e.clientY,
                origX: currentX,
                origY: currentY,
                pointerId: e.pointerId,
              });
            }}
            onPointerMove={(e) => {
              if (!thumbDrag.active || e.pointerId !== thumbDrag.pointerId)
                return;
              e.preventDefault();
            }}
            onPointerUp={(e) => {
              if (e.pointerId !== thumbDrag.pointerId) return;
              setThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
              setThumbZoomDisabled(false);
            }}
            onPointerCancel={(e) => {
              if (e.pointerId !== thumbDrag.pointerId) return;
              setThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
              setThumbZoomDisabled(false);
            }}
          >
            <div className="floor-thumbnail__label">
              {ordinalFloorLabel(originFloor)} Origin
            </div>
            <button
              className="floor-thumbnail__reset"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setThumbPos(null);
                setThumbZoomDisabled(false);
                setThumbDrag((s) => ({ ...s, active: false, pointerId: null }));
              }}
              type="button"
              aria-label="Reset thumbnail position"
              title="Reset thumbnail"
            >
              ↻
            </button>
                {renderFloorSvg(originFloor, {
                  interactive: false,
                  withRouteRef: false,
                  viewBoxOverride: originThumbViewBox,
                  className: "map-svg map-svg--thumb",
                  showMotion: true,
                  motionDuration: "8s",
                  svgKey: `thumb-single-${originFloor}-${layoutSignature}`,
                })}
          </div>
        )}
        {multiFloor &&
          originFloor !== null &&
          overviewFloors.length <= 2 &&
          (thumbZoomed || thumbZoomClosing) &&
          !thumbDrag.active && (
          <div
            className="thumbnail-zoom-backdrop"
            onClick={closeThumbnailZoomOverlay}
          />
        )}
        {overviewFloors.length > 2 &&
          showMultiOverview &&
          (multiThumbZoomedFloor !== null || multiThumbZoomClosingFloor !== null) &&
          !multiThumbDrag.active && (
            <div
              className="thumbnail-zoom-backdrop"
              onClick={closeThumbnailZoomOverlay}
            />
        )}
        {multiFloor &&
          originFloor !== null &&
          overviewFloors.length <= 2 &&
          (thumbZoomed || thumbZoomClosing) &&
          !thumbDrag.active && (
          <div
            className={`floor-thumbnail-zoomed${
              thumbZoomClosing ? " is-folding" : ""
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="floor-thumbnail__label">
              {ordinalFloorLabel(originFloor)} Origin
            </div>
            {renderFloorSvg(originFloor, {
              interactive: false,
              withRouteRef: false,
              viewBoxOverride: getThumbnailZoomViewBoxForFloor(originFloor),
              className: "map-svg map-svg--thumb",
              showMotion: true,
              motionDuration: "8s",
              svgKey: `thumb-zoom-single-${originFloor}-${layoutSignature}`,
            })}
          </div>
        )}
        {hasRouteDataFor3D &&
          overviewFloors.length > 2 &&
          overviewThumbFloors.length > 0 &&
          showMultiOverview && (
          <div className="floor-thumbnail-group">
            {overviewThumbFloors.map((f) => (
              <div
                key={`overview-${f}`}
                ref={(node) => {
                  multiThumbRefs.current[f] = node;
                }}
                className={`floor-thumbnail floor-thumbnail--multi${
                  multiThumbDrag.active && multiThumbDrag.floor === f
                    ? " is-dragging"
                    : ""
                }${multiThumbZoomDisabled[f] ? " no-zoom" : ""}`}
                onPointerLeave={() => {
                  setMultiThumbZoomDisabled((prev) => ({ ...prev, [f]: false }));
                }}
                onPointerEnter={() => {
                  setMultiThumbZoomDisabled((prev) => ({ ...prev, [f]: false }));
                }}
                onClick={() => {
                  if (multiThumbWasDragRef.current) {
                    multiThumbWasDragRef.current = false;
                    return;
                  }
                  if (multiThumbZoomDisabled[f] || multiThumbDrag.active) return;
                  clearMultiThumbTimers();
                  setMultiThumbZoomClosingFloor(null);
                  setMultiThumbZoomedFloor(f);
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === "mouse" && e.button !== 0) return;
                  const container = mapWrapRef.current;
                  const containerRect = container?.getBoundingClientRect();
                  const rect = multiThumbRefs.current[f]?.getBoundingClientRect();
                  if (!rect || !containerRect) return;
                  multiThumbWasDragRef.current = false;
                  setMultiThumbZoomDisabled((prev) => ({ ...prev, [f]: true }));
                  setMultiThumbZoomedFloor(null);
                  const currentX =
                    multiThumbPos[f]?.x ?? rect.left - (containerRect?.left ?? 0);
                  const currentY =
                    multiThumbPos[f]?.y ?? rect.top - (containerRect?.top ?? 0);
                  (e.currentTarget as HTMLDivElement).setPointerCapture(
                    e.pointerId
                  );
                  setMultiThumbDrag({
                    active: true,
                    floor: f,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: currentX,
                    origY: currentY,
                    pointerId: e.pointerId,
                  });
                }}
                onPointerMove={(e) => {
                  if (
                    !multiThumbDrag.active ||
                    e.pointerId !== multiThumbDrag.pointerId
                  )
                    return;
                  e.preventDefault();
                }}
                onPointerUp={(e) => {
                  if (e.pointerId !== multiThumbDrag.pointerId) return;
                  setMultiThumbDrag((s) => ({
                    ...s,
                    active: false,
                    pointerId: null,
                  }));
                  setMultiThumbZoomDisabled((prev) => ({ ...prev, [f]: false }));
                }}
                onPointerCancel={(e) => {
                  if (e.pointerId !== multiThumbDrag.pointerId) return;
                  setMultiThumbDrag((s) => ({
                    ...s,
                    active: false,
                    pointerId: null,
                  }));
                  setMultiThumbZoomDisabled((prev) => ({ ...prev, [f]: false }));
                }}
              >
                <div className="floor-thumbnail__label">
                  {originFloor === f
                    ? `${ordinalFloorLabel(f)} Origin`
                    : ordinalFloorLabel(f)}
                </div>
                <button
                  className="floor-thumbnail__reset"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMultiThumbPos((prev) => {
                      const next = { ...prev };
                      delete next[f];
                      return next;
                    });
                    setMultiThumbZoomDisabled((prev) => ({
                      ...prev,
                      [f]: false,
                    }));
                    setMultiThumbDrag((s) => ({
                      ...s,
                      active: false,
                      pointerId: null,
                    }));
                  }}
                  type="button"
                  aria-label={`Reset floor ${f} thumbnail position`}
                  title="Reset thumbnail"
                >
                  ↻
                </button>
                {renderFloorSvg(f, {
                  interactive: false,
                  withRouteRef: false,
                  viewBoxOverride: getThumbnailViewBoxForFloor(f),
                  className: "map-svg map-svg--thumb map-svg--thumb-mini",
                  showMotion: true,
                  motionDuration: "8s",
                  svgKey: `thumb-multi-${f}-${layoutSignature}`,
                })}
              </div>
            ))}
          </div>
        )}
        {hasRouteDataFor3D &&
          overviewFloors.length > 2 &&
          showMultiOverview &&
          (multiThumbZoomedFloor !== null || multiThumbZoomClosingFloor !== null) &&
          !multiThumbDrag.active && (
            <div
              className={`floor-thumbnail-zoomed floor-thumbnail-zoomed--multi${
                multiThumbZoomClosingFloor !== null ? " is-folding" : ""
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className={`floor-thumbnail__label${
                  activeMultiThumbFloor === originFloor
                    ? " is-origin-floor"
                    : ""
                }${
                  activeMultiThumbFloor === 2
                    ? " is-floor-2"
                    : ""
                }`}
              >
                {originFloor !== null && activeMultiThumbFloor === originFloor
                  ? `${ordinalFloorLabel(originFloor)} Origin`
                  : activeMultiThumbFloor !== null
                  ? ordinalFloorLabel(activeMultiThumbFloor)
                  : ""}
              </div>
              {renderFloorSvg(activeMultiThumbFloor!, {
                interactive: false,
                withRouteRef: false,
                viewBoxOverride: getThumbnailZoomViewBoxForFloor(activeMultiThumbFloor!),
                className: "map-svg map-svg--thumb map-svg--thumb-mini",
                showMotion: true,
                motionDuration: "8s",
                svgKey: `thumb-zoom-multi-${activeMultiThumbFloor}-${layoutSignature}`,
              })}
            </div>
          )}

        {onFloorChange && (
          <div
            className="map-floor-wing-controls"
            style={{
              position: "absolute",
              top: 12,
              right: "calc((100% - min(100%, 1100px)) / 2 - 200px)",
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: 6,
              width: 190,
              padding: "6px 10px",
              borderRadius: 10,
              background: "rgba(191, 219, 254, 0.95)",
              boxShadow: "0 6px 18px rgba(0,0,0,0.12)",
              zIndex: 6,
            }}
          >
            <span className="map-floor-wing-controls__title" style={{ fontWeight: 700, fontSize: 12, marginLeft: 40 }}>
              Current Floor & Wing
            </span>
            <button
              type="button"
              onClick={resetMapToRouteView}
              title="Reset map to route view"
              aria-label="Reset map to route view"
              className="map-floor-wing-controls__reset"
              style={{
                position: "absolute",
                top: 6,
                left: 8,
                width: 24,
                height: 24,
                border: "none",
                borderRadius: 999,
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                background: "#e5e7eb",
                color: "#111827",
                lineHeight: 1,
              }}
            >
              ↺
            </button>
            <div className="map-floor-wing-controls__row" style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button
                onClick={() => requestFloorChange(1)}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: floor === 1 ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                1F
              </button>
              <button
                onClick={() => requestFloorChange(2)}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: floor === 2 ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                2F
              </button>
              <button
                onClick={() => requestFloorChange(3)}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: floor === 3 ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                3F
              </button>
            </div>
            <div className="map-floor-wing-controls__row" style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => focusWing("A")}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: focusedWing === "A" ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                WA
              </button>
              <button
                onClick={() => focusWing("B")}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: focusedWing === "B" ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                WB
              </button>
              <button
                onClick={() => focusWing("C")}
                style={{
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  background: focusedWing === "C" ? "#3b71ca" : "#bdbdbd",
                  color: "#fff",
                }}
              >
                WC
              </button>
            </div>
          </div>
        )}

        {typeof nextFloorHint === "number" && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "8px 14px",
              borderRadius: 999,
              background: "rgba(59,113,202,0.95)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              zIndex: 6,
              pointerEvents: "none",
              boxShadow: "0 8px 20px rgba(0,0,0,0.18)",
            }}
          >
            Proceed to Floor {nextFloorHint}
          </div>
        )}

        <div className="zoom-controls zoom-controls--legacy" aria-hidden="true">
          <button onClick={zoomIn}>＋</button>
          <button onClick={zoomOut}>－</button>
          <button
            onClick={resetZoom}
            className="reset"
            title="Reset zoom"
            aria-label="Reset zoom"
          >
            ⟳
          </button>
        </div>

        {canUse3DView && !show3DModal && (
          <button
            type="button"
            className="view-3d-trigger"
            onClick={() => {
              setShow2DModal(false);
              setShow3DModal(true);
            }}
          >
            3D View
          </button>
        )}
        {canUse3DView && !show3DModal && !show2DModal && (
          <button
            type="button"
            className="view-2d-trigger"
            onClick={() => {
              setShow3DModal(false);
              setShow2DModal(true);
            }}
          >
            2D Full View
          </button>
        )}

        {show2DModal && (
          <div className="modal-2d__backdrop" onClick={close2DModal}>
            <div className="modal-2d" onClick={(e) => e.stopPropagation()}>
              <div className="modal-2d__header">
                <div className="modal-2d__title">
                  {ordinalFloorLabel(destination2DViewFloor)} Destination
                </div>
                <button
                  type="button"
                  className="modal-2d__close"
                  onClick={close2DModal}
                  aria-label="Close 2D view"
                >
                  X
                </button>
              </div>
              <div className="modal-2d__content">
                {renderFloorSvg(destination2DViewFloor, {
                  interactive: false,
                  withRouteRef: false,
                  viewBoxOverride: effectiveModal2dViewBox,
                  className: `map-svg map-svg--modal2d${isModal2dPanning ? " is-panning" : ""}`,
                  svgKey: `modal2d-${destination2DViewFloor}-${layoutSignature}`,
                  svgRef: modal2dSvgRef,
                  onMouseDown: handleModal2dMouseDown,
                  onMouseMove: handleModal2dMouseMove,
                  onMouseUp: () => commitModal2dPan(),
                  onMouseLeave: () => commitModal2dPan(),
                })}
              </div>
            </div>
          </div>
        )}

        {show3DModal && (
          <div
            className="modal-3d__backdrop"
            onClick={close3DModal}
          >
            <div className="modal-3d" onClick={(e) => e.stopPropagation()}>
              <div className="modal-3d__header">
                <div className="modal-3d__hint">
                  Drag to rotate. Use the arrows to move left or right.
                </div>
                <button
                  type="button"
                  className="modal-3d__close"
                  onClick={close3DModal}
                  aria-label="Close 3D view"
                >
                  X
                </button>
              </div>
              <div className="modal-3d__canvas-wrap">
                <div className="modal-3d__overlay-controls">
                  <div className="modal-3d__legend" aria-hidden="true">
                    <div className="modal-3d__legend-item">
                      <span className="modal-3d__legend-swatch modal-3d__legend-swatch--origin" />
                      <span>Origin</span>
                    </div>
                    <div className="modal-3d__legend-item">
                      <span className="modal-3d__legend-swatch modal-3d__legend-swatch--destination" />
                      <span>Destination</span>
                    </div>
                  </div>
                  <div className="modal-3d__pan-controls modal-3d__pan-controls--legend">
                    <button
                      type="button"
                      className="modal-3d__pan-btn"
                      title="Move map left"
                      aria-label="Move map left"
                      onClick={() => {
                        modelPanXRef.current -= 16;
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="modal-3d__pan-btn"
                      title="Move map right"
                      aria-label="Move map right"
                      onClick={() => {
                        modelPanXRef.current += 16;
                      }}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="modal-3d__pan-reset"
                      title="Reset map position"
                      aria-label="Reset map position"
                      onClick={() => {
                        modelPanXRef.current = 0;
                      }}
                    >
                      ↺
                    </button>
                  </div>
                </div>
                <div className="modal-3d__canvas" ref={threeWrapRef} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



