import TopNavBar from "./TopNavBar";
import Footer from "./Footer";
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import "../assets/home.css";
import physicalSciencesBuildingImg from "../assets/physical-sciences-building-2-upscaled.jpeg";
import {
  refreshMapLayoutAfterPublishIfNeeded,
  WING_A_1F_OFFSET,
  WING_A_2F_OFFSET,
  WING_A_3F_OFFSET,
  WING_B_1F_OFFSET,
  WING_B_2F_OFFSET,
  WING_B_3F_OFFSET,
  WING_C_1F_OFFSET,
  WING_C_2F_OFFSET,
  WING_C_3F_OFFSET,
} from "../constants/map_constants";
import {
  MAIN_ENTRANCE_NAME,
  SPACE_TYPE_BRIDGE,
  SPACE_TYPE_ENTRANCE,
  SPACE_TYPE_HALLWAY,
  SPACE_TYPE_LOUNGE,
  SPACE_TYPE_STAIRS,
} from "../constants/space_constants";
import {
  MDBBtn,
  MDBCol,
  MDBContainer,
  MDBInput,
  MDBRow,
  // MDBCard,
  MDBModal,
  MDBModalDialog,
  MDBModalContent,
  MDBModalHeader,
  MDBModalTitle,
  MDBModalBody,
  MDBModalFooter,
  MDBTabs,
  MDBTabsItem,
  MDBTabsLink,
  MDBTabsContent,
} from "mdb-react-ui-kit";
import type { Message } from "../types/models";
import { SERVICE_BASE_URL } from "../utils/auth";

const NavigationMap = lazy(() => import("./NavigationMap"));

type RouteSegment = { floor: number; d: string };
type RouteProp =
  | string
  | RouteSegment[]
  | {
      segments: RouteSegment[];
      autoFloor?: boolean;
      destinationFloor?: number;
    }
  | null;

type FloorRoutes = Record<string, string>;
type OriginSuggestion = {
  key: string;
  name: string;
  roomId: string;
  wing: string;
  floor: number;
  type?: string;
};

type WingRoomKey = "1A" | "1B" | "1C" | "2A" | "2B" | "2C" | "3A" | "3B" | "3C";
type RoomsByWingFloor = Record<WingRoomKey, any[]>;
const isValidFloor = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 3;
const isDestinationSelectableSpace = (space?: {
  id?: string;
  name?: string;
  type?: string;
}): boolean => {
  const id = String(space?.id ?? "").trim().toLowerCase();
  const name = String(space?.name ?? "").trim().toLowerCase();
  if (!name) return false;
  if (
    space?.type === SPACE_TYPE_STAIRS ||
    space?.type === SPACE_TYPE_LOUNGE ||
    space?.type === SPACE_TYPE_BRIDGE ||
    space?.type === SPACE_TYPE_ENTRANCE ||
    space?.type === SPACE_TYPE_HALLWAY
  ) {
    return false;
  }
  return !id.includes("hallway") && !name.includes("hallway");
};

export default function Home() {
  const [, setMessage] = useState<Message>();
  const [fromInput, setFromInput] = useState<string>(MAIN_ENTRANCE_NAME);
  const [toInput, setToInput] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [destinationFloor, setDestinationFloor] = useState<number | null>(null);
  const [originForRoute, setOriginForRoute] = useState<string>("");

  // Floor
  const [floor, setFloor] = useState<number>(1);

  // Route (string OR multi-floor)
  const [route, setRoute] = useState<RouteProp>(null);

  // Per-floor routes coming from backend: floor_routes: { "1": "...", "2": "..." }
  const [floorRoutes, setFloorRoutes] = useState<FloorRoutes>({});

  const [hasSearched, setHasSearched] = useState<boolean>(false);
  const [showMap, setShowMap] = useState<boolean>(false);
  const [mapVisible, setMapVisible] = useState<boolean>(false);
  const [roomsModalOpen, setRoomsModalOpen] = useState<boolean>(false);
  const [roomsModalTarget, setRoomsModalTarget] =
    useState<"origin" | "destination">("destination");
  const [roomsTab, setRoomsTab] = useState<string>("1f");
  const [roomListSearch, setRoomListSearch] = useState<string>("");
  const [toastVisible, setToastVisible] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>(
    "Please enter a destination before searching."
  );
  const [toastVariant, setToastVariant] = useState<
    "info" | "error" | "origin" | "destination"
  >("info");
  const [showCurrentLocationHint, setShowCurrentLocationHint] =
    useState<boolean>(false);
  const [showDestinationHint, setShowDestinationHint] = useState<boolean>(false);
  const [showOriginSuggestions, setShowOriginSuggestions] =
    useState<boolean>(false);
  const [originSuggestionIndex, setOriginSuggestionIndex] = useState<number>(-1);
  const [selectedOriginRoomId, setSelectedOriginRoomId] = useState<string>("");
  const [selectedDestinationRoomId, setSelectedDestinationRoomId] =
    useState<string>("");
  const [showDestinationSuggestions, setShowDestinationSuggestions] =
    useState<boolean>(false);
  const [destinationSuggestionIndex, setDestinationSuggestionIndex] =
    useState<number>(-1);
  const [mapResetKey, setMapResetKey] = useState<number>(0);
  const [mapFocusWingRequestToken, setMapFocusWingRequestToken] =
    useState<number | null>(null);
  const [mapLayoutVersion, setMapLayoutVersion] = useState<number>(0);
  const [confirmDestinationAsOriginOpen, setConfirmDestinationAsOriginOpen] =
    useState<boolean>(false);
  const [pendingDestinationAsOrigin, setPendingDestinationAsOrigin] =
    useState<string>("");
  const toastTimerRef = useRef<number | null>(null);
  const hasRefreshedLayoutOnFirstSearchRef = useRef<boolean>(false);
  const [roomsByWingFloor, setRoomsByWingFloor] = useState<RoomsByWingFloor | null>(null);

  const normalizeRoomKey = (value?: string): string =>
    (value ?? "").trim().toLowerCase();
  const roomNameById = useRef<Map<string, string>>(new Map());
  const wingA1Rooms = roomsByWingFloor?.["1A"] ?? WING_A_1F_OFFSET;
  const wingB1Rooms = roomsByWingFloor?.["1B"] ?? WING_B_1F_OFFSET;
  const wingC1Rooms = roomsByWingFloor?.["1C"] ?? WING_C_1F_OFFSET;
  const wingA2Rooms = roomsByWingFloor?.["2A"] ?? WING_A_2F_OFFSET;
  const wingB2Rooms = roomsByWingFloor?.["2B"] ?? WING_B_2F_OFFSET;
  const wingC2Rooms = roomsByWingFloor?.["2C"] ?? WING_C_2F_OFFSET;
  const wingA3Rooms = roomsByWingFloor?.["3A"] ?? WING_A_3F_OFFSET;
  const wingB3Rooms = roomsByWingFloor?.["3B"] ?? WING_B_3F_OFFSET;
  const wingC3Rooms = roomsByWingFloor?.["3C"] ?? WING_C_3F_OFFSET;
  const totalRoomsCount =
    wingA1Rooms.length +
    wingB1Rooms.length +
    wingC1Rooms.length +
    wingA2Rooms.length +
    wingB2Rooms.length +
    wingC2Rooms.length +
    wingA3Rooms.length +
    wingB3Rooms.length +
    wingC3Rooms.length;

  const loadRoomsFromService = async (): Promise<boolean> => {
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
        const floors = payload?.floors;
        if (!floors || typeof floors !== "object") continue;
        const next: RoomsByWingFloor = {
          "1A": Array.isArray(floors?.["1"]?.wings?.A) ? floors["1"].wings.A : [],
          "1B": Array.isArray(floors?.["1"]?.wings?.B) ? floors["1"].wings.B : [],
          "1C": Array.isArray(floors?.["1"]?.wings?.C) ? floors["1"].wings.C : [],
          "2A": Array.isArray(floors?.["2"]?.wings?.A) ? floors["2"].wings.A : [],
          "2B": Array.isArray(floors?.["2"]?.wings?.B) ? floors["2"].wings.B : [],
          "2C": Array.isArray(floors?.["2"]?.wings?.C) ? floors["2"].wings.C : [],
          "3A": Array.isArray(floors?.["3"]?.wings?.A) ? floors["3"].wings.A : [],
          "3B": Array.isArray(floors?.["3"]?.wings?.B) ? floors["3"].wings.B : [],
          "3C": Array.isArray(floors?.["3"]?.wings?.C) ? floors["3"].wings.C : [],
        };
        setRoomsByWingFloor(next);
        return true;
      } catch {
        // Try next endpoint.
      }
    }
    return false;
  };

  useEffect(() => {
    void (async () => {
      const hydratedRooms = await loadRoomsFromService();
      const refreshed = await refreshMapLayoutAfterPublishIfNeeded(true);
      if (refreshed || hydratedRooms) {
        hasRefreshedLayoutOnFirstSearchRef.current = true;
        setMapLayoutVersion((v) => v + 1);
        setMapResetKey((k) => k + 1);
      }
    })();
  }, []);

  useEffect(() => {
    if (!roomsModalOpen || totalRoomsCount > 0) return;
    void (async () => {
      const hydratedRooms = await loadRoomsFromService();
      if (hydratedRooms) {
        setMapLayoutVersion((v) => v + 1);
        setMapResetKey((k) => k + 1);
      }
    })();
  }, [roomsModalOpen, totalRoomsCount]);

  useEffect(() => {
    const allSpaces = [
      ...wingA1Rooms,
      ...wingA2Rooms,
      ...wingA3Rooms,
      ...wingB1Rooms,
      ...wingB2Rooms,
      ...wingB3Rooms,
      ...wingC1Rooms,
      ...wingC2Rooms,
      ...wingC3Rooms,
    ];
    const next = new Map<string, string>();
    allSpaces.forEach((s) => {
      next.set(normalizeRoomKey(s.id), s.name);
    });
    roomNameById.current = next;
  }, [mapLayoutVersion, roomsByWingFloor]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const toDisplayLocation = (value?: string): string => {
    const raw = (value ?? "").trim();
    if (!raw) return "";
    return roomNameById.current.get(normalizeRoomKey(raw)) ?? raw;
  };

  const getDestinationFloorFromName = (name?: string): number | null => {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (!key) return null;

    const on1f =
      wingA1Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingB1Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingC1Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (on1f) return 1;

    const on2f =
      wingA2Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingB2Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingC2Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (on2f) return 2;

    const on3f =
      wingA3Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingB3Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      ) ||
      wingC3Rooms.some(
        (s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key
      );
    if (on3f) return 3;

    return null;
  };

  const getOrderedRouteFloors = (r: RouteProp): number[] => {
    if (!r) return [];
    if (Array.isArray(r)) {
      return r.map((s) => s.floor).filter(Number.isFinite);
    }
    if (typeof r === "object" && Array.isArray((r as any).segments)) {
      return (r as any).segments
        .map((s: any) => s.floor)
        .filter(Number.isFinite);
    }
    return [];
  };

  const autoFloorTimersRef = useRef<number[]>([]);
  const lastAutoKeyRef = useRef<string>("");
  const selectedDestinationName = destination.trim() || toInput.trim();
  const allOriginSuggestions = useMemo<OriginSuggestion[]>(() => {
    const grouped = [
      { rooms: wingA1Rooms, wing: "Wing A", floor: 1 },
      { rooms: wingA2Rooms, wing: "Wing A", floor: 2 },
      { rooms: wingA3Rooms, wing: "Wing A", floor: 3 },
      { rooms: wingB1Rooms, wing: "Wing B", floor: 1 },
      { rooms: wingB2Rooms, wing: "Wing B", floor: 2 },
      { rooms: wingB3Rooms, wing: "Wing B", floor: 3 },
      { rooms: wingC1Rooms, wing: "Wing C", floor: 1 },
      { rooms: wingC2Rooms, wing: "Wing C", floor: 2 },
      { rooms: wingC3Rooms, wing: "Wing C", floor: 3 },
    ];
    const suggestions: OriginSuggestion[] = [];
    grouped.forEach(({ rooms, wing, floor }) => {
      rooms.forEach((space: any) => {
        const roomName = String(space?.name ?? "").trim();
        const roomId = String(space?.id ?? "").trim();
        if (!roomName) return;
        suggestions.push({
          key: `${normalizeRoomKey(roomId || roomName)}-${wing}-${floor}`,
          name: roomName,
          roomId: roomId || roomName,
          wing,
          floor,
          type: String(space?.type ?? ""),
        });
      });
    });
    return suggestions.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      const byWing = a.wing.localeCompare(b.wing);
      if (byWing !== 0) return byWing;
      return a.floor - b.floor;
    });
  }, [mapLayoutVersion, roomsByWingFloor]);
  const maxOriginSuggestions = 12;
  const totalOriginSuggestionMatches = useMemo(() => {
    const query = fromInput.trim().toLowerCase();
    if (!query) return 0;
    return allOriginSuggestions.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.roomId.toLowerCase().includes(query)
    ).length;
  }, [allOriginSuggestions, fromInput]);
  const totalDestinationSuggestionMatches = useMemo(() => {
    const query = toInput.trim().toLowerCase();
    if (!query) return 0;
    return allOriginSuggestions.filter(
      (item) =>
        isDestinationSelectableSpace({
          id: item.roomId,
          name: item.name,
          type: item.type,
        }) &&
        (item.name.toLowerCase().includes(query) ||
          item.roomId.toLowerCase().includes(query))
    ).length;
  }, [allOriginSuggestions, toInput]);
  const filteredOriginSuggestions = useMemo(() => {
    const query = fromInput.trim().toLowerCase();
    if (!query) return [];
    const startsWith = allOriginSuggestions.filter(
      (item) =>
        item.name.toLowerCase().startsWith(query) ||
        item.roomId.toLowerCase().startsWith(query)
    );
    const contains = allOriginSuggestions.filter(
      (item) =>
        !item.name.toLowerCase().startsWith(query) &&
        !item.roomId.toLowerCase().startsWith(query) &&
        (item.name.toLowerCase().includes(query) ||
          item.roomId.toLowerCase().includes(query))
    );
    return [...startsWith, ...contains].slice(0, maxOriginSuggestions);
  }, [allOriginSuggestions, fromInput]);
  const filteredDestinationSuggestions = useMemo(() => {
    const query = toInput.trim().toLowerCase();
    if (!query) return [];
    const startsWith = allOriginSuggestions.filter(
      (item) =>
        isDestinationSelectableSpace({
          id: item.roomId,
          name: item.name,
          type: item.type,
        }) &&
        (item.name.toLowerCase().startsWith(query) ||
          item.roomId.toLowerCase().startsWith(query))
    );
    const contains = allOriginSuggestions.filter(
      (item) =>
        isDestinationSelectableSpace({
          id: item.roomId,
          name: item.name,
          type: item.type,
        }) &&
        !item.name.toLowerCase().startsWith(query) &&
        !item.roomId.toLowerCase().startsWith(query) &&
        (item.name.toLowerCase().includes(query) ||
          item.roomId.toLowerCase().includes(query))
    );
    return [...startsWith, ...contains].slice(0, maxOriginSuggestions);
  }, [allOriginSuggestions, toInput]);

  const sendMessage = async (
    destinationOverride?: string,
    options?: { skipFromUpdate?: boolean; fromOverride?: string }
  ): Promise<void> => {
    const preferredOrigin = fromInput.trim() || originForRoute.trim();
    const fallbackOriginForLanding =
      !showMap && !preferredOrigin && toInput.trim()
        ? MAIN_ENTRANCE_NAME
        : "";
    const effectiveFromInput =
      preferredOrigin || fallbackOriginForLanding || MAIN_ENTRANCE_NAME;
    const originText = (options?.fromOverride ?? effectiveFromInput).trim();
    const destinationText = (destinationOverride ?? toInput).trim();
    if (!destinationText) return;
    if (!options?.skipFromUpdate && originText) {
      setFromInput(toDisplayLocation(originText));
    }
    setOriginForRoute(originText);
    if (!hasSearched) {
      setHasSearched(true);
      setShowMap(true);
    }

    let jsonData: any = null;
    try {
      if (!hasRefreshedLayoutOnFirstSearchRef.current) {
        const refreshed = await refreshMapLayoutAfterPublishIfNeeded(true);
        if (refreshed) {
          hasRefreshedLayoutOnFirstSearchRef.current = true;
          setMapLayoutVersion((v) => v + 1);
          setMapResetKey((k) => k + 1);
        }
      }

      const res = await fetch(`${SERVICE_BASE_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: originText,
          destination: destinationText,
        }),
      });
      const rawBody = await res.text();
      let data: any = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        data = rawBody;
      }

      if (data && typeof data.reply === "string") {
        setMessage({ text: data.reply });
        try {
          jsonData = JSON.parse(data.reply);
        } catch {
          // If reply isn't JSON, just show message and don't break UI
          setRoute(null);
          setFloorRoutes({});
          setDestination("");
          return;
        }
      } else {
        jsonData = data;
      }

      if (!res.ok) {
        const backendError =
          (jsonData &&
            typeof jsonData.error === "string" &&
            jsonData.error.trim()) ||
          (typeof data === "string" && data.trim()) ||
          `Unable to process request (${res.status}).`;
        showToast(backendError, 3000, "error");
        setRoute(null);
        setFloorRoutes({});
        setDestination("");
        return;
      }
    } catch (err: unknown) {
      const details = err instanceof Error && err.message ? ` (${err.message})` : "";
      showToast(`Unable to connect to the server.${details}`, 3000, "error");
      setRoute(null);
      setFloorRoutes({});
      setDestination("");
      return;
    }

    if (jsonData && typeof jsonData.error === "string" && jsonData.error.trim()) {
      showToast(jsonData.error, 3000, "error");
      setRoute(null);
      setFloorRoutes({});
      setDestination("");
      return;
    }

    // NORMAL ROUTE
    const nextDestination = jsonData.destination ?? "";
    setDestination(nextDestination);

    // Store per-floor routes from backend
    const fr: FloorRoutes = jsonData.floor_routes ?? {};
    setFloorRoutes(fr);

    // Keep overall route too (optional)
    setRoute(jsonData.route ?? null);

    // Destination floor hint (if provided by backend)
    const nextDestFloor =
      Number(jsonData.destination_floor ?? jsonData.destinationFloor) ||
      Number((jsonData.route && (jsonData.route as any).destinationFloor) ?? NaN);
    const inferredDestFloor = getDestinationFloorFromName(nextDestination);
    const finalDestFloor = isValidFloor(nextDestFloor)
      ? nextDestFloor
      : inferredDestFloor;
    setDestinationFloor(isValidFloor(finalDestFloor) ? finalDestFloor : null);

  };

  useEffect(() => {
    if (autoFloorTimersRef.current.length) {
      autoFloorTimersRef.current.forEach((t) => window.clearTimeout(t));
      autoFloorTimersRef.current = [];
    }

    const autoKey = JSON.stringify({ route, floorRoutes });
    if (lastAutoKeyRef.current === autoKey) return;
    lastAutoKeyRef.current = autoKey;

    const orderedFloors = getOrderedRouteFloors(route);
    const hasOrderedFloors = orderedFloors.length > 0;

    if (destinationFloor !== null && isValidFloor(destinationFloor)) {
      setFloor(destinationFloor);
      return;
    }

    if (hasOrderedFloors) {
      const uniqueOrderedFloors = Array.from(
        new Set(orderedFloors.filter((value) => isValidFloor(value)))
      );
      if (!uniqueOrderedFloors.length) return;

      // Stay on destination floor
      setFloor(uniqueOrderedFloors[uniqueOrderedFloors.length - 1]);
    } else {
      // Fallback: choose destination from floor_routes if no ordered segments exist
      const floors = Object.keys(floorRoutes)
        .map((k) => Number(k))
        .filter((value) => isValidFloor(value));
      const sorted = floors.sort((a, b) => a - b);
      if (sorted.length) {
        setFloor(sorted[sorted.length - 1]);
      }
    }

    return () => {
      if (autoFloorTimersRef.current.length) {
        autoFloorTimersRef.current.forEach((t) => window.clearTimeout(t));
        autoFloorTimersRef.current = [];
      }
    };
  }, [route, floorRoutes, destinationFloor]);

  useEffect(() => {
    if (!roomsModalOpen) return;
    const destFloor = getDestinationFloorFromName(selectedDestinationName);
    if (destFloor && Number.isFinite(destFloor)) {
      setRoomsTab(`${destFloor}f`);
    }
  }, [roomsModalOpen, selectedDestinationName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearchClick();
  };
  const showToast = (
    messageText: string = "Please enter a destination before searching.",
    durationMs: number = 3000,
    variant: "info" | "error" | "origin" | "destination" = "info"
  ) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(messageText);
    setToastVariant(variant);
    setToastVisible(true);
    toastTimerRef.current = window.setTimeout(() => {
      setToastVisible(false);
      toastTimerRef.current = null;
    }, durationMs);
  };

  const ensureLandingOriginDefault = (): string => {
    const preferredOrigin = fromInput.trim() || originForRoute.trim();
    if (!showMap && !preferredOrigin) {
      setFromInput(MAIN_ENTRANCE_NAME);
      setOriginForRoute(MAIN_ENTRANCE_NAME);
      return MAIN_ENTRANCE_NAME;
    }
    return preferredOrigin;
  };

  const handleSearchClick = () => {
    if (!toInput.trim()) {
      showToast();
      return;
    }
    setMapFocusWingRequestToken(null);
    const normalizedOrigin = ensureLandingOriginDefault() || MAIN_ENTRANCE_NAME;
    sendMessage(toInput.trim(), {
      fromOverride: normalizedOrigin,
    });
  };

  const handleRoomSetAsCurrentLocation = (roomName: string) => {
    const next = roomName.trim();
    if (!next) return;
    setFromInput(next);
    setOriginForRoute(next);
    setSelectedOriginRoomId("");
    showToast("Setting as Origin", 1600, "origin");
  };

  const handleOriginRoomListClick = () => {
    setRoomsModalTarget("origin");
    setRoomListSearch("");
    setRoomsModalOpen(true);
  };

  const openDestinationRoomList = () => {
    ensureLandingOriginDefault();
    setRoomsModalTarget("destination");
    setRoomListSearch("");
    setRoomsModalOpen(true);
  };

  const handleDestinationRoomListClick = () => {
    const candidate = toInput.trim();
    if (showMap && candidate) {
      setPendingDestinationAsOrigin(candidate);
      setConfirmDestinationAsOriginOpen(true);
      return;
    }
    openDestinationRoomList();
  };

  const closeDestinationAsOriginConfirm = () => {
    setConfirmDestinationAsOriginOpen(false);
    setPendingDestinationAsOrigin("");
  };

  const confirmDestinationAsNewOrigin = () => {
    const next = pendingDestinationAsOrigin.trim();
    if (next) {
      setFromInput(next);
      setOriginForRoute(next);
      setSelectedOriginRoomId("");
      showToast("Setting as Origin", 1600, "origin");
    }
    closeDestinationAsOriginConfirm();
    openDestinationRoomList();
  };

  const skipDestinationAsNewOrigin = () => {
    closeDestinationAsOriginConfirm();
    openDestinationRoomList();
  };

  const handleCurrentLocationFieldFocus = () => {
    setShowCurrentLocationHint(true);
    setShowOriginSuggestions(true);
  };

  const handleCurrentLocationFieldBlur = () => {
    setShowCurrentLocationHint(false);
    setShowOriginSuggestions(false);
    setOriginSuggestionIndex(-1);
    if (!showMap && !fromInput.trim()) {
      setFromInput(MAIN_ENTRANCE_NAME);
      setOriginForRoute(MAIN_ENTRANCE_NAME);
      setSelectedOriginRoomId("");
    }
  };

  const selectOriginSuggestion = (suggestion: OriginSuggestion) => {
    const next = suggestion.name.trim();
    if (!next) return;
    setFromInput(next);
    setOriginForRoute(next);
    setSelectedOriginRoomId(suggestion.roomId);
    setShowOriginSuggestions(false);
    setOriginSuggestionIndex(-1);
  };

  const handleDestinationFieldFocus = () => {
    setShowDestinationHint(true);
    setShowDestinationSuggestions(true);
  };

  const handleDestinationFieldBlur = () => {
    setShowDestinationHint(false);
    setShowDestinationSuggestions(false);
    setDestinationSuggestionIndex(-1);
  };

  const selectDestinationSuggestion = (suggestion: OriginSuggestion) => {
    const next = suggestion.name.trim();
    if (!next) return;
    setToInput(next);
    setSelectedDestinationRoomId(suggestion.roomId);
    setShowDestinationSuggestions(false);
    setDestinationSuggestionIndex(-1);
  };

  const handleResetSearch = () => {
    setMessage(undefined);
    setFromInput(MAIN_ENTRANCE_NAME);
    setToInput(MAIN_ENTRANCE_NAME);
    setDestination(MAIN_ENTRANCE_NAME);
    setDestinationFloor(1);
    setOriginForRoute(MAIN_ENTRANCE_NAME);
    setFloor(1);
    setRoute(null);
    setFloorRoutes({});
    setHasSearched(true);
    setShowMap(true);
    setMapVisible(true);
    setRoomsModalOpen(false);
    setRoomsModalTarget("destination");
    setRoomsTab("1f");
    setSelectedOriginRoomId("");
    setSelectedDestinationRoomId("");
    setToastVisible(false);
    setShowOriginSuggestions(false);
    setOriginSuggestionIndex(-1);
    setShowDestinationSuggestions(false);
    setDestinationSuggestionIndex(-1);
    setMapFocusWingRequestToken(Date.now());
    setMapResetKey((k) => k + 1);
  };

  if (showMap && !mapVisible) {
    window.requestAnimationFrame(() => setMapVisible(true));
  }

  const cleanRooms = (rooms: any[]) =>
    rooms
      .filter((room) => isDestinationSelectableSpace(room))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const renderWingGroup = (
    label: string,
    rooms: any[],
    options?: { selectedKey?: string; exactRoomId?: string }
  ) => (
    <div className="rooms-wing-group">
      <div className="rooms-wing-title">{label}</div>
      {(roomListSearch.trim()
        ? rooms.filter((room) => {
            const query = roomListSearch.trim().toLowerCase();
            const roomName = String(room?.name ?? "").toLowerCase();
            const roomId = String(room?.id ?? "").toLowerCase();
            return roomName.includes(query) || roomId.includes(query);
          })
        : rooms
      ).length ? (
        <div className="rooms-wing-grid">
          {(roomListSearch.trim()
            ? rooms.filter((room) => {
                const query = roomListSearch.trim().toLowerCase();
                const roomName = String(room?.name ?? "").toLowerCase();
                const roomId = String(room?.id ?? "").toLowerCase();
                return roomName.includes(query) || roomId.includes(query);
              })
            : rooms
          )
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((room) => {
              const selectedKey = options?.selectedKey ?? "";
              const exactRoomId = normalizeRoomKey(options?.exactRoomId);
              const isSelected =
                !!exactRoomId && normalizeRoomKey(room.id) === exactRoomId;
              const destinationIsSelected =
                !exactRoomId &&
                !!selectedKey &&
                [normalizeRoomKey(room.id), normalizeRoomKey(room.name)].includes(
                  selectedKey
                );
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => {
                    if (roomsModalTarget === "origin") {
                      setFromInput(room.name);
                      setOriginForRoute(room.name);
                      setSelectedOriginRoomId(room.id);
                      showToast("Setting as Origin", 1600, "origin");
                    } else {
                      setToInput(room.name);
                      setSelectedDestinationRoomId(room.id);
                      showToast("Setting as Destination", 1600, "destination");
                    }
                    setRoomsModalOpen(false);
                    if (roomsModalTarget === "destination") {
                      const currentOrigin =
                        ensureLandingOriginDefault() || MAIN_ENTRANCE_NAME;
                      sendMessage(room.name, {
                        fromOverride: currentOrigin,
                      });
                    }
                  }}
                  className={`rooms-room-chip${
                    isSelected || destinationIsSelected ? " is-selected" : ""
                  }`}
                >
                  {room.name}
                </button>
              );
            })}
        </div>
      ) : (
        <div className="rooms-wing-empty">
          No rooms available.
        </div>
      )}
    </div>
  );

  return (
    <>
      <header style={{ marginBottom: 0 }}>
        <TopNavBar />
      </header>

      <main className={`landing-main${!showMap ? " landing-main--with-sidebar" : ""}`}>
        {/* <MDBCard>
          <MDBContainer className="p-3">
            {message && <span>{message.text}</span>}
          </MDBContainer>
        </MDBCard> */}

        {!showMap && (
          <aside className="landing-howto-shell">
            <h2 className="landing-howto-title">How It Works</h2>
            <div className="landing-howto-list">
              <div className="landing-howto-step">
                <span className="landing-howto-badge landing-howto-badge--origin">1</span>
                <div className="landing-howto-icon landing-howto-icon--origin">
                  <i className="fas fa-map-marker-alt" aria-hidden="true" />
                </div>
                <div className="landing-howto-text">
                  <div className="landing-howto-step-title">Set your origin</div>
                  <p className="landing-howto-step-desc">
                    Start from Main Entrance, type any room, or pick one
                    from the Room List.
                  </p>
                </div>
              </div>

              <div className="landing-howto-step">
                <span className="landing-howto-badge landing-howto-badge--destination">2</span>
                <div className="landing-howto-icon landing-howto-icon--destination">
                  <i className="fas fa-flag-checkered" aria-hidden="true" />
                </div>
                <div className="landing-howto-text">
                  <div className="landing-howto-step-title">Choose your destination</div>
                  <p className="landing-howto-step-desc">
                    Enter the room you want to reach, or browse rooms by
                    floor using the Room List.
                  </p>
                </div>
              </div>

              <div className="landing-howto-step">
                <span className="landing-howto-badge landing-howto-badge--search">3</span>
                <div className="landing-howto-icon landing-howto-icon--search">
                  <i className="fas fa-diamond-turn-right" aria-hidden="true" />
                </div>
                <div className="landing-howto-text">
                  <div className="landing-howto-step-title">Get clear directions</div>
                  <p className="landing-howto-step-desc">
                    Tap Search to see a step-by-step path drawn on the
                    interactive floor map.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        )}

        <div className="landing-main-content">
        <MDBContainer
          className={`p-3 landing-search-panel${!showMap ? " is-landing" : ""}`}
        >
          <section className={`landing-search-surface${!showMap ? " is-landing" : ""}`}>
            {!showMap && (
              <div className="landing-page-intro">
                <h1 className="landing-page-title landing-page-title-pill">
                  Find Your Way Around Physical Sciences Building
                </h1>
                <p className="landing-page-subtitle">
                  Search a destination and get clear indoor directions by floor.
                </p>
              </div>
            )}
            <form onSubmit={handleSubmit}>
              <MDBRow className="d-flex justify-content-center align-items-end">
                <MDBCol md="4" start className="landing-field-col">
                  <div>
                    <div className="landing-field-header-row landing-field-header-row--destination">
                      <div className="landing-compact-field-title landing-compact-field-title--current">
                        Origin
                      </div>
                      <MDBBtn
                        type="button"
                        size="sm"
                        className="landing-btn-roomlist-mini"
                        color="info"
                        onClick={handleOriginRoomListClick}
                      >
                        Room List
                      </MDBBtn>
                    </div>
                    <div style={{ position: "relative" }}>
                      {showCurrentLocationHint && (
                        <div
                          style={{
                            position: "absolute",
                            top: -30,
                            left: 0,
                            zIndex: 2,
                            background: "#1f2937",
                            color: "#fff",
                            padding: "4px 8px",
                            borderRadius: 10,
                            fontSize: 12,
                            whiteSpace: "nowrap",
                            boxShadow: "0 4px 10px rgba(0,0,0,0.18)",
                          }}
                        >
                          Type room name or choose from Room List
                        </div>
                      )}
                      <MDBInput
                        label=""
                        type="text"
                        value={fromInput}
                        onChange={(e) => {
                          setFromInput(e.target.value);
                          setShowCurrentLocationHint(false);
                          setSelectedOriginRoomId("");
                          setShowOriginSuggestions(true);
                          setOriginSuggestionIndex(-1);
                        }}
                        onFocus={handleCurrentLocationFieldFocus}
                        onClick={handleCurrentLocationFieldFocus}
                        onBlur={handleCurrentLocationFieldBlur}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                          if (!filteredOriginSuggestions.length) return;
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setShowOriginSuggestions(true);
                            setOriginSuggestionIndex((prev) =>
                              prev >= filteredOriginSuggestions.length - 1 ? 0 : prev + 1
                            );
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setShowOriginSuggestions(true);
                            setOriginSuggestionIndex((prev) =>
                              prev <= 0 ? filteredOriginSuggestions.length - 1 : prev - 1
                            );
                          } else if (e.key === "Enter" && originSuggestionIndex >= 0) {
                            e.preventDefault();
                            selectOriginSuggestion(
                              filteredOriginSuggestions[originSuggestionIndex]
                            );
                          } else if (e.key === "Escape") {
                            setShowOriginSuggestions(false);
                            setOriginSuggestionIndex(-1);
                          }
                        }}
                      />
                      {showOriginSuggestions &&
                        fromInput.trim() &&
                        filteredOriginSuggestions.length > 0 && (
                          <div
                            className="origin-suggestions-dropdown origin-suggestions-dropdown-origin"
                            role="listbox"
                          >
                            {filteredOriginSuggestions.map((suggestion, index) => (
                              <button
                                key={suggestion.key}
                                type="button"
                                role="option"
                                aria-selected={index === originSuggestionIndex}
                                className={`origin-suggestion-item origin-suggestion-item-origin${
                                  index === originSuggestionIndex ? " is-active" : ""
                                }`}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  selectOriginSuggestion(suggestion);
                                }}
                              >
                                <span className="origin-suggestion-main">
                                  {suggestion.name}
                                </span>
                              </button>
                            ))}
                            {totalOriginSuggestionMatches >
                              filteredOriginSuggestions.length && (
                              <div className="origin-suggestion-footer">
                                Showing top {filteredOriginSuggestions.length} of{" "}
                                {totalOriginSuggestionMatches} matches
                              </div>
                            )}
                          </div>
                        )}
                      {fromInput && (
                        <button
                          type="button"
                          onClick={() => {
                            setFromInput("");
                            setSelectedOriginRoomId("");
                          }}
                          aria-label="Clear origin"
                          title="Clear"
                          style={{
                            position: "absolute",
                            right: 10,
                            top: "50%",
                            transform: "translateY(-50%)",
                            border: "none",
                            background: "#e5e7eb",
                            width: 22,
                            height: 22,
                            borderRadius: "999px",
                            fontSize: 12,
                            cursor: "pointer",
                            color: "#2563eb",
                            padding: 0,
                            lineHeight: 1,
                          }}
                        >
                          X
                        </button>
                      )}
                    </div>
                  </div>
                </MDBCol>

                <MDBCol md="4" start className="landing-field-col">
                  <div>
                    <div className="landing-field-header-row">
                      <div className="landing-compact-field-title landing-compact-field-title--destination">
                        Destination
                      </div>
                      <MDBBtn
                        type="button"
                        size="sm"
                        className="landing-btn-roomlist-mini"
                        color="info"
                        onClick={handleDestinationRoomListClick}
                      >
                        Room List
                      </MDBBtn>
                    </div>
                    <div style={{ position: "relative" }}>
                      {showDestinationHint && (
                        <div
                          style={{
                            position: "absolute",
                            top: -30,
                            left: 0,
                            zIndex: 2,
                            background: "#1f2937",
                            color: "#fff",
                            padding: "4px 8px",
                            borderRadius: 10,
                            fontSize: 12,
                            whiteSpace: "nowrap",
                            boxShadow: "0 4px 10px rgba(0,0,0,0.18)",
                          }}
                        >
                          Type room name or choose from Room List
                        </div>
                      )}
                      <MDBInput
                        label=""
                        type="text"
                        value={toInput}
                        onChange={(e) => {
                          setToInput(e.target.value);
                          setShowDestinationHint(false);
                          setSelectedDestinationRoomId("");
                          setShowDestinationSuggestions(true);
                          setDestinationSuggestionIndex(-1);
                        }}
                        onFocus={handleDestinationFieldFocus}
                        onClick={handleDestinationFieldFocus}
                        onBlur={handleDestinationFieldBlur}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                          if (!filteredDestinationSuggestions.length) return;
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setShowDestinationSuggestions(true);
                            setDestinationSuggestionIndex((prev) =>
                              prev >= filteredDestinationSuggestions.length - 1 ? 0 : prev + 1
                            );
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setShowDestinationSuggestions(true);
                            setDestinationSuggestionIndex((prev) =>
                              prev <= 0 ? filteredDestinationSuggestions.length - 1 : prev - 1
                            );
                          } else if (
                            e.key === "Enter" &&
                            destinationSuggestionIndex >= 0
                          ) {
                            e.preventDefault();
                            selectDestinationSuggestion(
                              filteredDestinationSuggestions[destinationSuggestionIndex]
                            );
                          } else if (e.key === "Escape") {
                            setShowDestinationSuggestions(false);
                            setDestinationSuggestionIndex(-1);
                          }
                        }}
                      />
                      {showDestinationSuggestions &&
                        toInput.trim() &&
                        filteredDestinationSuggestions.length > 0 && (
                          <div
                            className="origin-suggestions-dropdown origin-suggestions-dropdown-destination"
                            role="listbox"
                          >
                            {filteredDestinationSuggestions.map((suggestion, index) => (
                              <button
                                key={`${suggestion.key}-destination`}
                                type="button"
                                role="option"
                                aria-selected={index === destinationSuggestionIndex}
                                className={`origin-suggestion-item origin-suggestion-item-destination${
                                  index === destinationSuggestionIndex ? " is-active" : ""
                                }`}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  selectDestinationSuggestion(suggestion);
                                }}
                              >
                                <span className="origin-suggestion-main">
                                  {suggestion.name}
                                </span>
                              </button>
                            ))}
                            {totalDestinationSuggestionMatches >
                              filteredDestinationSuggestions.length && (
                              <div className="origin-suggestion-footer">
                                Showing top {filteredDestinationSuggestions.length} of{" "}
                                {totalDestinationSuggestionMatches} matches
                              </div>
                            )}
                          </div>
                        )}
                      {toInput && (
                        <button
                          type="button"
                          onClick={() => {
                            setToInput("");
                            setSelectedDestinationRoomId("");
                          }}
                          aria-label="Clear destination"
                          title="Clear"
                          style={{
                            position: "absolute",
                            right: 10,
                            top: "50%",
                            transform: "translateY(-50%)",
                            border: "none",
                            background: "#e5e7eb",
                            width: 22,
                            height: 22,
                            borderRadius: "999px",
                            fontSize: 12,
                            cursor: "pointer",
                            color: "#2563eb",
                            padding: 0,
                            lineHeight: 1,
                          }}
                        >
                          X
                        </button>
                      )}
                    </div>
                  </div>
                </MDBCol>

                <MDBCol size="auto" className="pe-1 landing-search-btn-col">
                  <MDBBtn className="mb-2 landing-btn-primary" onClick={handleSearchClick}>
                    SEARCH
                  </MDBBtn>
                </MDBCol>
                <MDBCol size="auto" className="ps-1 landing-reset-btn-col">
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                    {showMap && (
                      <MDBBtn
                        className="mb-2 landing-btn-reset-icon"
                        onClick={handleResetSearch}
                        title="Reset search"
                        aria-label="Reset search"
                      >
                        <i className="fas fa-rotate-left" aria-hidden="true" />
                      </MDBBtn>
                    )}
                  </div>
                </MDBCol>

              </MDBRow>
            </form>
            {!showMap && (
              <div className="landing-search-footer">
                <div className="landing-search-hint">
                  Type room name or choose from Room List.
                </div>
              </div>
            )}
          </section>
        </MDBContainer>

        {!showMap && (
          <div className="landing-hero-image-shell">
            <img
              src={physicalSciencesBuildingImg}
              alt="Physical Sciences Building"
              className="landing-hero-image"
            />
          </div>
        )}
        </div>
      </main>

      <MDBModal
        className="rooms-modal"
        open={roomsModalOpen}
        onClose={() => {
          setRoomsModalOpen(false);
          setRoomListSearch("");
        }}
        tabIndex={-1}
      >
        <MDBModalDialog scrollable size="lg" className="rooms-modal-dialog">
          <MDBModalContent className="rooms-modal-content">
            <MDBModalHeader className="rooms-modal-header">
              <MDBModalTitle className="rooms-modal-title">
                {roomsModalTarget === "origin"
                  ? "Choose Origin - Rooms By Floor"
                  : "Choose Destination - Rooms By Floor"}
              </MDBModalTitle>
              <MDBBtn
                type="button"
                className="rooms-modal-close rooms-modal-close-text"
                onClick={() => {
                  setRoomsModalOpen(false);
                  setRoomListSearch("");
                }}
              >
                X
              </MDBBtn>
            </MDBModalHeader>
            <MDBModalBody className="rooms-modal-body">
              <MDBTabs className="mb-3 rooms-tabs">
                <MDBTabsItem>
                  <MDBTabsLink
                    onClick={() => setRoomsTab("1f")}
                    active={roomsTab === "1f"}
                    className={`rooms-tab-link${roomsTab === "1f" ? " active" : ""}`}
                  >
                    1st Floor
                  </MDBTabsLink>
                </MDBTabsItem>
                <MDBTabsItem>
                  <MDBTabsLink
                    onClick={() => setRoomsTab("2f")}
                    active={roomsTab === "2f"}
                    className={`rooms-tab-link${roomsTab === "2f" ? " active" : ""}`}
                  >
                    2nd Floor
                  </MDBTabsLink>
                </MDBTabsItem>
                <MDBTabsItem>
                  <MDBTabsLink
                    onClick={() => setRoomsTab("3f")}
                    active={roomsTab === "3f"}
                    className={`rooms-tab-link${roomsTab === "3f" ? " active" : ""}`}
                  >
                    3rd Floor
                  </MDBTabsLink>
                </MDBTabsItem>
                <div className="rooms-tab-search-wrap">
                  <input
                    type="text"
                    className="rooms-tab-search-input"
                    placeholder="Search room..."
                    value={roomListSearch}
                    onChange={(e) => setRoomListSearch(e.target.value)}
                    aria-label={
                      roomsModalTarget === "origin"
                        ? "Search origin rooms"
                        : "Search destination rooms"
                    }
                  />
                  {roomListSearch && (
                    <button
                      type="button"
                      className="rooms-tab-search-clear"
                      onClick={() => setRoomListSearch("")}
                      aria-label="Clear room search"
                      title="Clear"
                    >
                      X
                    </button>
                  )}
                </div>
              </MDBTabs>
              <MDBTabsContent>
                {roomsTab === "1f" && (
                  <>
                    {renderWingGroup("Wing A", cleanRooms(wingA1Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                    {renderWingGroup(
                      "Wing B",
                      cleanRooms(wingB1Rooms),
                      {
                        selectedKey: "",
                        exactRoomId:
                          roomsModalTarget === "origin"
                            ? selectedOriginRoomId
                            : selectedDestinationRoomId,
                      }
                    )}
                    {renderWingGroup("Wing C", cleanRooms(wingC1Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                  </>
                )}
                {roomsTab === "2f" && (
                  <>
                    {renderWingGroup("Wing A", cleanRooms(wingA2Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                    {renderWingGroup(
                      "Wing B",
                      cleanRooms(wingB2Rooms),
                      {
                        selectedKey: "",
                        exactRoomId:
                          roomsModalTarget === "origin"
                            ? selectedOriginRoomId
                            : selectedDestinationRoomId,
                      }
                    )}
                    {renderWingGroup("Wing C", cleanRooms(wingC2Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                  </>
                )}
                {roomsTab === "3f" && (
                  <>
                    {renderWingGroup("Wing A", cleanRooms(wingA3Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                    {renderWingGroup(
                      "Wing B",
                      cleanRooms(wingB3Rooms),
                      {
                        selectedKey: "",
                        exactRoomId:
                          roomsModalTarget === "origin"
                            ? selectedOriginRoomId
                            : selectedDestinationRoomId,
                      }
                    )}
                    {renderWingGroup("Wing C", cleanRooms(wingC3Rooms), {
                      selectedKey: "",
                      exactRoomId:
                        roomsModalTarget === "origin"
                          ? selectedOriginRoomId
                          : selectedDestinationRoomId,
                    })}
                  </>
                )}
              </MDBTabsContent>
            </MDBModalBody>
            <MDBModalFooter className="rooms-modal-footer">
              <MDBBtn
                className="rooms-modal-close-btn"
                onClick={() => {
                  setRoomsModalOpen(false);
                  setRoomListSearch("");
                }}
              >
                Close
              </MDBBtn>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
        </MDBModal>

      <MDBModal
        open={confirmDestinationAsOriginOpen}
        onClose={closeDestinationAsOriginConfirm}
        tabIndex={-1}
      >
        <MDBModalDialog centered className="confirm-location-modal-dialog">
          <MDBModalContent className="confirm-location-modal-content">
            <MDBModalHeader className="confirm-location-modal-header">
              <MDBModalTitle className="confirm-location-modal-title">
                Confirm New Origin
              </MDBModalTitle>
            </MDBModalHeader>
            <MDBModalBody className="confirm-location-modal-body">
              Set{" "}
              <strong className="confirm-location-modal-destination">
                {pendingDestinationAsOrigin || "this destination"}
              </strong>{" "}
              as New Origin?
            </MDBModalBody>
            <MDBModalFooter className="confirm-location-modal-footer">
              <MDBBtn
                className="confirm-location-modal-btn-no"
                onClick={skipDestinationAsNewOrigin}
              >
                No
              </MDBBtn>
              <MDBBtn
                className="confirm-location-modal-btn-ok"
                onClick={confirmDestinationAsNewOrigin}
              >
                Yes
              </MDBBtn>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
      </MDBModal>

      {showMap && (
        <main className="landing-visual-wrap map-active">
          <div className="landing-map-shell" style={{ opacity: mapVisible ? 1 : 0, transition: "opacity 300ms ease" }}>
            <div
              style={{
                maxWidth: 1200,
                margin: "0 auto 8px",
                fontSize: 12,
                color: "#333",
              }}
            >
            </div>
            <Suspense
              fallback={
                <div
                  style={{
                    maxWidth: 1200,
                    margin: "0 auto",
                    height: 420,
                    borderRadius: 4,
                    background:
                      "linear-gradient(120deg, #f1f5f9 0%, #e2e8f0 100%)",
                  }}
                />
              }
            >
              <NavigationMap
                key={mapResetKey}
                route={route}
                destination={destination}
                origin={originForRoute || fromInput}
                floor={floor}
                onFloorChange={setFloor}
                onRoomSelectAsCurrentLocation={handleRoomSetAsCurrentLocation}
                floorRoutes={floorRoutes}
                focusWingRequestWing="C"
                focusWingRequestToken={mapFocusWingRequestToken}
              />
            </Suspense>
          </div>
        </main>
      )}

      <footer>
        <Footer />
      </footer>

      {toastVisible && (
        <div
          className="landing-toast"
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            background:
              toastVariant === "error"
                ? "linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)"
                : toastVariant === "destination"
                  ? "linear-gradient(135deg, #0f1f52 0%, #1e3a8a 55%, #1e40af 100%)"
                : toastVariant === "origin"
                  ? "linear-gradient(135deg, #166534 0%, #15803d 55%, #16a34a 100%)"
                  : "linear-gradient(135deg, #1f2937 0%, #111827 100%)",
            color: "#fff",
            padding: "14px 20px",
            borderRadius: 14,
            fontSize: 16,
            fontWeight: 700,
            boxShadow:
              toastVariant === "error"
                ? "0 14px 34px rgba(127, 29, 29, 0.45)"
                : toastVariant === "destination"
                  ? "0 14px 34px rgba(15, 23, 66, 0.55)"
                : toastVariant === "origin"
                  ? "0 14px 34px rgba(20, 83, 45, 0.45)"
                  : "0 12px 28px rgba(17, 24, 39, 0.48)",
            border:
              toastVariant === "error"
                ? "1px solid rgba(254, 202, 202, 0.22)"
                : toastVariant === "destination"
                  ? "1px solid rgba(191, 219, 254, 0.28)"
                : toastVariant === "origin"
                  ? "1px solid rgba(187, 247, 208, 0.35)"
                  : "1px solid rgba(255, 255, 255, 0.14)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            zIndex: 9999,
            maxWidth: "95vw",
            letterSpacing: 0.25,
            lineHeight: 1.25,
            display: "flex",
            alignItems: "center",
            gap: 10,
            animation: "toastPopIn 220ms ease-out",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 9,
              height: 9,
              borderRadius: "999px",
              background:
                toastVariant === "error"
                  ? "#fecaca"
                  : toastVariant === "destination"
                    ? "#bfdbfe"
                    : toastVariant === "origin"
                    ? "#86efac"
                    : "#d1d5db",
              boxShadow: "0 0 0 3px rgba(255,255,255,0.14)",
              flexShrink: 0,
            }}
          />
          <span>{toastMessage}</span>
        </div>
      )}
    </>
  );
}










