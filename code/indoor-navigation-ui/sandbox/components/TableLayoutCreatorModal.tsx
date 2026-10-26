import { useMemo, useState } from "react";
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
import type { FloorId, Layout } from "../../src/layout/layout.schema";
import {
  buildLayoutsFromTableBatches,
  createDefaultTableBatch,
  type CorridorPattern,
  type RoomSizePreset,
  type SmartRoomKind,
  type TableBatchConfig,
} from "./layoutSmartBuilder";

interface TableLayoutCreatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (layouts: Partial<Record<FloorId, Layout>>) => void;
}

const ROOM_TYPE_OPTIONS: Array<{ value: SmartRoomKind; label: string }> = [
  { value: "room", label: "Room" },
  { value: "lounge", label: "Lounge" },
  { value: "stairs", label: "Stairs" },
  { value: "entrance", label: "Entrance" },
];

const SIZE_OPTIONS: Array<{ value: RoomSizePreset; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "lab", label: "Lab" },
];

const PATTERN_OPTIONS: Array<{ value: CorridorPattern; label: string; hint: string }> = [
  { value: "double-loaded", label: "Double-loaded corridor", hint: "Rooms on both sides of a hallway." },
  { value: "single-loaded", label: "Single-loaded corridor", hint: "Rooms on one side of a hallway." },
  { value: "clustered", label: "Clustered block", hint: "Rooms grouped like labs or admin clusters." },
];

const QUICK_TEMPLATES: Array<{ label: string; factory: () => TableBatchConfig }> = [
  {
    label: "Academic Wing",
    factory: () => ({
      ...createDefaultTableBatch(),
      roomNamePrefix: "Classroom",
      roomIdPrefix: "A1",
      count: 10,
      sizePreset: "large",
      pattern: "double-loaded",
    }),
  },
  {
    label: "Office Wing",
    factory: () => ({
      ...createDefaultTableBatch(),
      roomNamePrefix: "Office",
      roomIdPrefix: "B2",
      wing: "B",
      floor: 2,
      count: 12,
      sizePreset: "small",
      pattern: "double-loaded",
    }),
  },
  {
    label: "Lab Wing",
    factory: () => ({
      ...createDefaultTableBatch(),
      roomNamePrefix: "Laboratory",
      roomIdPrefix: "C1",
      wing: "C",
      count: 5,
      sizePreset: "lab",
      pattern: "single-loaded",
      includeLounge: false,
    }),
  },
];

const FLOOR_OPTIONS: FloorId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const WING_OPTIONS: TableBatchConfig["wing"][] = ["A", "B", "C", "D", "E"];

const cardStyle: React.CSSProperties = {
  border: "1px solid #dbe3f0",
  borderRadius: 16,
  padding: 16,
  background: "linear-gradient(180deg, #ffffff 0%, #f7faff 100%)",
  boxShadow: "0 12px 28px rgba(15, 23, 42, 0.08)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "#1f2937",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #cbd5e1",
  fontSize: 14,
  background: "#fff",
};

const softButtonStyle: React.CSSProperties = {
  borderRadius: 999,
  padding: "8px 14px",
  border: "1px solid #bfd5ff",
  background: "#eff6ff",
  color: "#1d4ed8",
  fontWeight: 700,
  fontSize: 12,
};

function toNumber(value: string, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export default function TableLayoutCreatorModal({ isOpen, onClose, onGenerate }: TableLayoutCreatorModalProps) {
  const [batches, setBatches] = useState<TableBatchConfig[]>([createDefaultTableBatch()]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? batches[0] ?? null,
    [batches, selectedBatchId]
  );

  const roomEstimate = useMemo(
    () =>
      batches.reduce(
        (sum, batch) => sum + batch.count + Number(batch.includeHallway) + Number(batch.includeStairs) + Number(batch.includeLounge),
        0
      ),
    [batches]
  );

  const updateBatch = <K extends keyof TableBatchConfig>(id: string, field: K, value: TableBatchConfig[K]) => {
    setBatches((current) =>
      current.map((batch) => {
        if (batch.id !== id) return batch;
        return { ...batch, [field]: value };
      })
    );
  };

  const addBatch = (factory?: () => TableBatchConfig) => {
    const batch = factory ? factory() : createDefaultTableBatch();
    const nextBatch = { ...batch, id: `${batch.id}-${Date.now()}` };
    setBatches((current) => [...current, nextBatch]);
    setSelectedBatchId(nextBatch.id);
  };

  const duplicateBatch = (id: string) => {
    const match = batches.find((batch) => batch.id === id);
    if (!match) return;
    const duplicate = {
      ...match,
      id: `batch-${Date.now()}`,
      startNumber: match.startNumber + match.count,
      offsetY: match.offsetY + 80,
    };
    setBatches((current) => [...current, duplicate]);
    setSelectedBatchId(duplicate.id);
  };

  const removeBatch = (id: string) => {
    setBatches((current) => current.filter((batch) => batch.id !== id));
    setSelectedBatchId((current) => (current === id ? null : current));
  };

  const handleGenerate = () => {
    setError("");
    if (!batches.length) {
      setError("Add at least one batch before generating.");
      return;
    }

    const invalidBatch = batches.find((batch) => !batch.roomNamePrefix.trim() || !batch.roomIdPrefix.trim() || batch.count < 1);
    if (invalidBatch) {
      setError("Each batch needs a room name, room ID prefix, and at least one room.");
      return;
    }

    onGenerate(buildLayoutsFromTableBatches(batches));
    onClose();
  };

  return (
    <MDBModal tabIndex="-1" open={isOpen} setOpen={onClose} size="xl">
      <MDBModalDialog size="xl" centered scrollable>
        <MDBModalContent>
          <MDBModalHeader style={{ background: "linear-gradient(90deg, #1d4ed8 0%, #0ea5e9 100%)", color: "#fff" }}>
            <MDBModalTitle style={{ fontSize: 22, fontWeight: 800 }}>Smart Table Layout Creator</MDBModalTitle>
            <MDBBtn className="btn-close" color="none" onClick={onClose} style={{ filter: "invert(1)", cursor: "pointer" }} />
          </MDBModalHeader>
          <MDBModalBody style={{ maxHeight: "78vh", overflowY: "auto", background: "#f3f7ff" }}>
            <div style={{ display: "grid", gap: 16 }}>
              <div style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>Build by wing, not by coordinates</div>
                    <div style={{ fontSize: 14, color: "#475569", marginTop: 4 }}>
                      Add batches like classrooms, offices, or labs. The builder places them on-grid with hallways, stairs, and lounges automatically.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" style={softButtonStyle} onClick={() => addBatch()}>
                      Add Blank Batch
                    </button>
                    {QUICK_TEMPLATES.map((template) => (
                      <button key={template.label} type="button" style={softButtonStyle} onClick={() => addBatch(template.factory)}>
                        {template.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.1fr) minmax(320px, 1fr)", gap: 16 }}>
                <div style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>Batch List</div>
                    <div style={{ fontSize: 13, color: "#475569" }}>{roomEstimate} elements estimated</div>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {batches.map((batch, index) => {
                      const isActive = batch.id === selectedBatch?.id;
                      return (
                        <button
                          key={batch.id}
                          type="button"
                          onClick={() => setSelectedBatchId(batch.id)}
                          style={{
                            textAlign: "left",
                            borderRadius: 14,
                            padding: 14,
                            border: isActive ? "2px solid #2563eb" : "1px solid #dbe3f0",
                            background: isActive ? "#eff6ff" : "#fff",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontWeight: 800, color: "#0f172a" }}>
                                {index + 1}. {batch.roomNamePrefix} Batch
                              </div>
                              <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                                Floor {batch.floor}, Wing {batch.wing}, {batch.count} rooms, {batch.pattern.replace("-", " ")}
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button type="button" style={softButtonStyle} onClick={(event) => { event.stopPropagation(); duplicateBatch(batch.id); }}>
                                Duplicate
                              </button>
                              {batches.length > 1 ? (
                                <button
                                  type="button"
                                  style={{ ...softButtonStyle, background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    removeBatch(batch.id);
                                  }}
                                >
                                  Remove
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={cardStyle}>
                  {selectedBatch ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>Batch Settings</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                        <div>
                          <label style={labelStyle}>Floor</label>
                          <select value={selectedBatch.floor} onChange={(e) => updateBatch(selectedBatch.id, "floor", Number(e.target.value) as FloorId)} style={inputStyle}>
                            {FLOOR_OPTIONS.map((floor) => (
                              <option key={floor} value={floor}>
                                Floor {floor}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle}>Wing</label>
                          <select value={selectedBatch.wing} onChange={(e) => updateBatch(selectedBatch.id, "wing", e.target.value as TableBatchConfig["wing"])} style={inputStyle}>
                            {WING_OPTIONS.map((wing) => (
                              <option key={wing} value={wing}>
                                Wing {wing}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle}>Room Type</label>
                          <select value={selectedBatch.roomType} onChange={(e) => updateBatch(selectedBatch.id, "roomType", e.target.value as SmartRoomKind)} style={inputStyle}>
                            {ROOM_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={labelStyle}>Size</label>
                          <select value={selectedBatch.sizePreset} onChange={(e) => updateBatch(selectedBatch.id, "sizePreset", e.target.value as RoomSizePreset)} style={inputStyle}>
                            {SIZE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                        <div>
                          <label style={labelStyle}>Room Name Prefix</label>
                          <input value={selectedBatch.roomNamePrefix} onChange={(e) => updateBatch(selectedBatch.id, "roomNamePrefix", e.target.value)} style={inputStyle} placeholder="Classroom" />
                        </div>
                        <div>
                          <label style={labelStyle}>Room ID Prefix</label>
                          <input value={selectedBatch.roomIdPrefix} onChange={(e) => updateBatch(selectedBatch.id, "roomIdPrefix", e.target.value)} style={inputStyle} placeholder="A1" />
                        </div>
                        <div>
                          <label style={labelStyle}>Room Count</label>
                          <input type="number" min={1} max={40} value={selectedBatch.count} onChange={(e) => updateBatch(selectedBatch.id, "count", toNumber(e.target.value, selectedBatch.count))} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Start Number</label>
                          <input type="number" min={1} max={999} value={selectedBatch.startNumber} onChange={(e) => updateBatch(selectedBatch.id, "startNumber", toNumber(e.target.value, selectedBatch.startNumber))} style={inputStyle} />
                        </div>
                      </div>

                      <div>
                        <label style={labelStyle}>Placement Pattern</label>
                        <div style={{ display: "grid", gap: 8 }}>
                          {PATTERN_OPTIONS.map((option) => (
                            <label
                              key={option.value}
                              style={{
                                display: "flex",
                                gap: 10,
                                padding: 12,
                                borderRadius: 12,
                                border: selectedBatch.pattern === option.value ? "2px solid #2563eb" : "1px solid #dbe3f0",
                                background: selectedBatch.pattern === option.value ? "#eff6ff" : "#fff",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="radio"
                                checked={selectedBatch.pattern === option.value}
                                onChange={() => updateBatch(selectedBatch.id, "pattern", option.value)}
                              />
                              <span>
                                <strong>{option.label}</strong>
                                <div style={{ fontSize: 13, color: "#475569" }}>{option.hint}</div>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                        <div>
                          <label style={labelStyle}>Horizontal Offset</label>
                          <input type="number" step={40} value={selectedBatch.offsetX} onChange={(e) => updateBatch(selectedBatch.id, "offsetX", toNumber(e.target.value, selectedBatch.offsetX))} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Vertical Offset</label>
                          <input type="number" step={40} value={selectedBatch.offsetY} onChange={(e) => updateBatch(selectedBatch.id, "offsetY", toNumber(e.target.value, selectedBatch.offsetY))} style={inputStyle} />
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {(["includeHallway", "includeStairs", "includeLounge"] as const).map((field) => (
                          <label key={field} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: "#334155" }}>
                            <input type="checkbox" checked={selectedBatch[field]} onChange={(e) => updateBatch(selectedBatch.id, field, e.target.checked)} />
                            {field === "includeHallway" ? "Add hallway" : field === "includeStairs" ? "Add stairs" : "Add lounge"}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "#475569" }}>Select a batch to edit its settings.</div>
                  )}
                </div>
              </div>

              <div style={{ ...cardStyle, background: "#0f172a", color: "#e2e8f0" }}>
                <div style={{ fontSize: 16, fontWeight: 800 }}>What this will generate</div>
                <div style={{ marginTop: 6, fontSize: 14, color: "#cbd5e1" }}>
                  Batches are positioned by wing automatically, then offset if needed. Room numbering continues from each batch's start number, and each batch can add its own hallway, stairs, and lounge.
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {batches.map((batch) => (
                    <span key={batch.id} style={{ padding: "8px 12px", borderRadius: 999, background: "rgba(59, 130, 246, 0.18)", fontSize: 13 }}>
                      Floor {batch.floor} / Wing {batch.wing}: {batch.roomNamePrefix} x{batch.count}
                    </span>
                  ))}
                </div>
              </div>

              {error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
            </div>
          </MDBModalBody>
          <MDBModalFooter>
            <MDBBtn color="secondary" onClick={onClose}>
              Cancel
            </MDBBtn>
            <MDBBtn color="primary" onClick={handleGenerate}>
              Generate Layout
            </MDBBtn>
          </MDBModalFooter>
        </MDBModalContent>
      </MDBModalDialog>
    </MDBModal>
  );
}
