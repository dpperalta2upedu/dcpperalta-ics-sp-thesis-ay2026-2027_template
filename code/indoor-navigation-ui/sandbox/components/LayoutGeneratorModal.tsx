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
  createDefaultAutoGenerateConfig,
  estimateGeneratedRooms,
  generateSmartLayouts,
  type AutoGenerateConfig,
  type BuildingProfile,
  type CorridorPattern,
  type DensityPreset,
} from "./layoutSmartBuilder";

interface LayoutGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (result: { config: AutoGenerateConfig; layouts: Partial<Record<FloorId, Layout>> }) => void;
}

const SIZE_PRESETS = {
  compact: { width: 1360, height: 820, label: "Compact" },
  standard: { width: 1768, height: 930, label: "Standard" },
  spacious: { width: 2240, height: 1120, label: "Spacious" },
} as const;

const PROFILE_CARDS: Array<{ value: BuildingProfile; title: string; description: string }> = [
  { value: "mixed", title: "Mixed Use", description: "A classroom wing, a lab wing, and an admin wing in one layout." },
  { value: "office", title: "Office", description: "Dense office wings with smaller rooms and consistent corridors." },
  { value: "laboratory", title: "Laboratory", description: "Larger rooms with cleaner, single-loaded access patterns." },
  { value: "academic", title: "Academic", description: "Classrooms on lower floors, teaching and faculty spaces above." },
];

const DENSITY_OPTIONS: Array<{ value: DensityPreset; label: string; hint: string }> = [
  { value: "low", label: "Low", hint: "Fewer rooms, more open space." },
  { value: "medium", label: "Medium", hint: "Balanced size and room count." },
  { value: "high", label: "High", hint: "More rooms packed into each wing." },
];

const PLACEMENT_OPTIONS: Array<{ value: CorridorPattern; label: string; hint: string }> = [
  { value: "double-loaded", label: "Double-loaded corridor", hint: "Rooms on both sides of a hallway." },
  { value: "single-loaded", label: "Single-loaded corridor", hint: "Rooms on one side of a hallway." },
  { value: "clustered", label: "Clustered block", hint: "Rooms grouped like labs or admin clusters." },
];

const chipStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 999,
  border: "1px solid #dbe3f0",
  background: "#fff",
  color: "#334155",
  fontWeight: 700,
  fontSize: 12,
};

const panelStyle: React.CSSProperties = {
  borderRadius: 18,
  border: "1px solid #dbe3f0",
  background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
  padding: 16,
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
  background: "#fff",
  fontSize: 14,
};

const rangeStyle: React.CSSProperties = {
  width: "100%",
  accentColor: "#06b6d4",
  cursor: "pointer",
  touchAction: "none",
};

export default function LayoutGeneratorModal({ isOpen, onClose, onGenerate }: LayoutGeneratorModalProps) {
  const [sizePreset, setSizePreset] = useState<keyof typeof SIZE_PRESETS>("standard");
  const [config, setConfig] = useState<AutoGenerateConfig>(() => ({
    ...createDefaultAutoGenerateConfig(),
    width: SIZE_PRESETS.standard.width,
    height: SIZE_PRESETS.standard.height,
  }));

  const estimatedRooms = useMemo(() => estimateGeneratedRooms(config), [config]);
  const floorsLabel = `${config.floorCount} floor${config.floorCount === 1 ? "" : "s"}`;
  const wingsLabel = `${config.wingCount} wing${config.wingCount === 1 ? "" : "s"}`;
  const roomsLabel = `${config.roomsPerWing} room${config.roomsPerWing === 1 ? "" : "s"} / wing`;

  const updateConfig = <K extends keyof AutoGenerateConfig>(field: K, value: AutoGenerateConfig[K]) => {
    setConfig((current) => ({ ...current, [field]: value }));
  };

  const stopRangeEventPropagation = (event: React.PointerEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  };

  const applySizePreset = (preset: keyof typeof SIZE_PRESETS) => {
    setSizePreset(preset);
    setConfig((current) => ({
      ...current,
      width: SIZE_PRESETS[preset].width,
      height: SIZE_PRESETS[preset].height,
    }));
  };

  const handleGenerate = () => {
    onGenerate({ config, layouts: generateSmartLayouts(config) });
    onClose();
  };

  return (
    <MDBModal tabIndex="-1" open={isOpen} setOpen={onClose} size="xl">
      <MDBModalDialog centered scrollable size="xl">
        <MDBModalContent>
          <MDBModalHeader style={{ background: "linear-gradient(90deg, #0f172a 0%, #1d4ed8 60%, #38bdf8 100%)", color: "#fff" }}>
            <MDBModalTitle style={{ fontSize: 22, fontWeight: 800 }}>Auto-Generate Layout</MDBModalTitle>
            <MDBBtn className="btn-close" color="none" onClick={onClose} style={{ filter: "invert(1)", cursor: "pointer" }} />
          </MDBModalHeader>
          <MDBModalBody style={{ maxHeight: "78vh", overflowY: "auto", background: "#eef4ff" }}>
            <div style={{ display: "grid", gap: 16 }}>
              <div style={panelStyle}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>Generate from intent</div>
                <div style={{ fontSize: 14, color: "#475569", marginTop: 4 }}>
                  Pick the kind of building you want, how dense it should feel, and how many wings and floors it needs. The generator will choose room sizing and corridor patterns for you.
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(320px, 1fr)", gap: 16 }}>
                <div style={{ display: "grid", gap: 16 }}>
                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Building Profile</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                      {PROFILE_CARDS.map((profile) => {
                        const isActive = config.profile === profile.value;
                        return (
                          <button
                            key={profile.value}
                            type="button"
                            onClick={() => updateConfig("profile", profile.value)}
                            style={{
                              textAlign: "left",
                              borderRadius: 16,
                              padding: 14,
                              border: isActive ? "2px solid #2563eb" : "1px solid #dbe3f0",
                              background: isActive ? "#eff6ff" : "#fff",
                            }}
                          >
                            <div style={{ fontWeight: 800, color: "#0f172a" }}>{profile.title}</div>
                            <div style={{ marginTop: 6, fontSize: 13, color: "#475569" }}>{profile.description}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Footprint</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                      {(Object.entries(SIZE_PRESETS) as Array<[keyof typeof SIZE_PRESETS, (typeof SIZE_PRESETS)[keyof typeof SIZE_PRESETS]]>).map(([key, preset]) => (
                        <button
                          key={key}
                          type="button"
                          style={{
                            ...chipStyle,
                            borderColor: sizePreset === key ? "#2563eb" : "#dbe3f0",
                            background: sizePreset === key ? "#dbeafe" : "#fff",
                            color: sizePreset === key ? "#1d4ed8" : "#334155",
                          }}
                          onClick={() => applySizePreset(key)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                      <div>
                        <label style={labelStyle}>Width</label>
                        <input type="number" min={1200} step={40} value={config.width} onChange={(e) => updateConfig("width", Number(e.target.value) || config.width)} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Height</label>
                        <input type="number" min={760} step={40} value={config.height} onChange={(e) => updateConfig("height", Number(e.target.value) || config.height)} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Floors</label>
                        <input
                          type="range"
                          min={1}
                          max={10}
                          step={1}
                          value={config.floorCount}
                          onChange={(e) => updateConfig("floorCount", Number(e.target.value))}
                          onPointerDown={stopRangeEventPropagation}
                          onMouseDown={stopRangeEventPropagation}
                          style={rangeStyle}
                        />
                        <div style={{ fontSize: 13, color: "#475569" }}>{floorsLabel}</div>
                      </div>
                      <div>
                        <label style={labelStyle}>Wings</label>
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={1}
                          value={config.wingCount}
                          onChange={(e) => updateConfig("wingCount", Number(e.target.value))}
                          onPointerDown={stopRangeEventPropagation}
                          onMouseDown={stopRangeEventPropagation}
                          style={rangeStyle}
                        />
                        <div style={{ fontSize: 13, color: "#475569" }}>{wingsLabel}</div>
                      </div>
                    </div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Room Count</div>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px", gap: 12, alignItems: "center" }}>
                      <input
                        type="range"
                        min={1}
                        max={30}
                        step={1}
                        value={config.roomsPerWing}
                        onChange={(e) => updateConfig("roomsPerWing", Number(e.target.value))}
                        onPointerDown={stopRangeEventPropagation}
                        onMouseDown={stopRangeEventPropagation}
                        style={rangeStyle}
                      />
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={config.roomsPerWing}
                        onChange={(e) => updateConfig("roomsPerWing", Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ fontSize: 13, color: "#475569", marginTop: 8 }}>{roomsLabel}</div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Density</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {DENSITY_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          style={{
                            display: "flex",
                            gap: 10,
                            borderRadius: 14,
                            padding: 12,
                            border: config.density === option.value ? "2px solid #2563eb" : "1px solid #dbe3f0",
                            background: config.density === option.value ? "#eff6ff" : "#fff",
                            cursor: "pointer",
                          }}
                        >
                          <input type="radio" checked={config.density === option.value} onChange={() => updateConfig("density", option.value)} />
                          <span>
                            <strong>{option.label}</strong>
                            <div style={{ fontSize: 13, color: "#475569" }}>{option.hint}</div>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Placement Pattern</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {PLACEMENT_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          style={{
                            display: "flex",
                            gap: 10,
                            borderRadius: 14,
                            padding: 12,
                            border: config.placementPattern === option.value ? "2px solid #2563eb" : "1px solid #dbe3f0",
                            background: config.placementPattern === option.value ? "#eff6ff" : "#fff",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            checked={config.placementPattern === option.value}
                            onChange={() => updateConfig("placementPattern", option.value)}
                          />
                          <span>
                            <strong>{option.label}</strong>
                            <div style={{ fontSize: 13, color: "#475569" }}>{option.hint}</div>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
                      <div>
                        <label style={labelStyle}>Horizontal Offset</label>
                        <input
                          type="number"
                          step={40}
                          value={config.offsetX}
                          onChange={(e) => updateConfig("offsetX", Number(e.target.value) || 0)}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Vertical Offset</label>
                        <input
                          type="number"
                          step={40}
                          value={config.offsetY}
                          onChange={(e) => updateConfig("offsetY", Number(e.target.value) || 0)}
                          style={inputStyle}
                        />
                      </div>
                    </div>
                  </div>

                </div>

                <div style={{ display: "grid", gap: 16 }}>
                  <div style={{ ...panelStyle, background: "#0f172a", color: "#e2e8f0" }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>Generation Summary</div>
                    <div style={{ fontSize: 14, color: "#cbd5e1", marginTop: 6 }}>
                      The current settings will create a {PROFILE_CARDS.find((item) => item.value === config.profile)?.title.toLowerCase()}-style building with about {estimatedRooms} elements.
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                      <span style={{ ...chipStyle, background: "rgba(59,130,246,0.18)", borderColor: "rgba(96,165,250,0.3)", color: "#dbeafe" }}>{floorsLabel}</span>
                      <span style={{ ...chipStyle, background: "rgba(59,130,246,0.18)", borderColor: "rgba(96,165,250,0.3)", color: "#dbeafe" }}>{wingsLabel}</span>
                      <span style={{ ...chipStyle, background: "rgba(59,130,246,0.18)", borderColor: "rgba(96,165,250,0.3)", color: "#dbeafe" }}>{roomsLabel}</span>
                      <span style={{ ...chipStyle, background: "rgba(59,130,246,0.18)", borderColor: "rgba(96,165,250,0.3)", color: "#dbeafe" }}>{config.density} density</span>
                      <span style={{ ...chipStyle, background: "rgba(59,130,246,0.18)", borderColor: "rgba(96,165,250,0.3)", color: "#dbeafe" }}>{config.placementPattern.replace("-", " ")}</span>
                    </div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 12 }}>Extras</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {([
                        ["includeWingBackgrounds", "Add wing backgrounds"],
                        ["includeBridges", "Add bridges between adjacent wings"],
                        ["includeEntrance", "Add a main entrance on Floor 1"],
                        ["includeLounges", "Add lounges where the profile expects them"],
                      ] as const).map(([field, label]) => (
                        <label key={field} style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, color: "#334155" }}>
                          <input type="checkbox" checked={config[field]} onChange={(e) => updateConfig(field, e.target.checked)} />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div style={panelStyle}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>Preview Notes</div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#475569", fontSize: 14 }}>
                      <li>Academic layouts favor double-loaded classroom corridors.</li>
                      <li>Office layouts increase room count with smaller office sizes.</li>
                      <li>Laboratory layouts use larger rooms, but the selected placement pattern now takes priority.</li>
                      <li>Mixed-use layouts keep their room mix while sharing one placement pattern and offset.</li>
                    </ul>
                  </div>
                </div>
              </div>
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
