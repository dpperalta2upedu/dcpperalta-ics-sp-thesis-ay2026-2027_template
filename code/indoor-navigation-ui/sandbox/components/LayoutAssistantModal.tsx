import { useEffect, useMemo, useState } from "react";
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
import { SANDBOX_SERVICE_BASE_URL } from "../sb_auth";
import { sandboxFetch } from "../sb_api";
import {
  createDefaultAutoGenerateConfig,
  generateSmartLayouts,
  type AutoGenerateConfig,
} from "./layoutSmartBuilder";
import type { FloorId, Layout } from "../../src/layout/layout.schema";

type PlannerResponse = {
  ok: boolean;
  reply: string;
  configPatch: Partial<AutoGenerateConfig>;
  baseConfig: AutoGenerateConfig;
  proposedConfig: AutoGenerateConfig;
  commands: Array<{ type: string; field: string; value: string }>;
  warnings: string[];
  assumptions: string[];
  requiresRegeneration: boolean;
};

type PreviewValidation = {
  errors: string[];
  warnings: string[];
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const ASSISTANT_CAPABILITY_GROUPS: Array<{
  verb: string;
  examples: string[];
}> = [
  {
    verb: "Add",
    examples: [
      "Add more rooms on Floor 1.",
      "Add a lounge near the classrooms.",
      "Add another floor with the same layout style.",
    ],
  },
  {
    verb: "Delete",
    examples: [
      "Delete all hallways.",
      "Delete all lounges.",
      "Remove the misplaced hallways.",
    ],
  },
  {
    verb: "Resize",
    examples: [
      "Increase room sizes.",
      "Make the rooms a little wider.",
      "Make the hallways thicker.",
    ],
  },
  {
    verb: "Rearrange",
    examples: [
      "Rearrange the rooms into a cleaner layout.",
      "Make the layout taller.",
      "Switch to a simpler corridor pattern.",
    ],
  },
  {
    verb: "Restore",
    examples: [
      "Put background gray on each wing.",
      "Restore the gray wing backgrounds.",
      "Revert the last change.",
    ],
  },
];

function shouldHandleLocallyAsUndo(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  if (/^\s*(undo|revert|restore)\s*$/.test(normalized)) return true;
  if (/\b(undo|revert|restore)\b/.test(normalized) && /\b(last|previous|recent)\b/.test(normalized)) return true;
  if (/\bbring back\b/.test(normalized) && /\b(room|rooms|change|changes|elements?)\b/.test(normalized)) return true;
  if (/\brestore\b/.test(normalized) && /\b(deleted|removed|lost)\b/.test(normalized)) return true;
  if (/\bundo\b/.test(normalized) && /\b(delete|deletion|remove|removed)\b/.test(normalized)) return true;

  return false;
}

function validateGeneratedLayouts(
  layouts: Partial<Record<FloorId, Layout>>,
  config: AutoGenerateConfig
): PreviewValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const rectsByFloor = new Map<number, Array<{ id: string; kind: string; x: number; y: number; w: number; h: number }>>();

  Object.entries(layouts).forEach(([floorKey, layout]) => {
    if (!layout) return;
    const floor = Number(floorKey);
    const floorRects: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number }> = [];
    layout.rooms.forEach((room) => {
      if (seenIds.has(room.id)) {
        errors.push(`Duplicate room id detected: ${room.id}`);
      }
      seenIds.add(room.id);
      if (!room.rect) return;
      const { x, y, w, h } = room.rect;
      if (w <= 0 || h <= 0) {
        errors.push(`${room.id} has a non-positive size.`);
      }
      if (x < 0 || y < 0 || x + w > config.width || y + h > config.height) {
        errors.push(`${room.id} falls outside the generated view bounds on floor ${floor}.`);
      }
      floorRects.push({ id: room.id, kind: room.kind, x, y, w, h });
    });
    rectsByFloor.set(floor, floorRects);
  });

  rectsByFloor.forEach((rects, floor) => {
    for (let index = 0; index < rects.length; index += 1) {
      const current = rects[index];
      if (current.kind === "wing_background" || current.kind === "bridge" || current.kind === "hallway") continue;
      for (let otherIndex = index + 1; otherIndex < rects.length; otherIndex += 1) {
        const other = rects[otherIndex];
        if (other.kind === "wing_background" || other.kind === "bridge" || other.kind === "hallway") continue;
        const overlapW = Math.min(current.x + current.w, other.x + other.w) - Math.max(current.x, other.x);
        const overlapH = Math.min(current.y + current.h, other.y + other.h) - Math.max(current.y, other.y);
        if (overlapW > 0 && overlapH > 0) {
          warnings.push(`Potential room overlap on floor ${floor}: ${current.id} and ${other.id}.`);
        }
      }
    }
  });

  return { errors, warnings };
}

function generateValidatedLayouts(config: AutoGenerateConfig): {
  config: AutoGenerateConfig;
  layouts: Partial<Record<FloorId, Layout>>;
  validation: PreviewValidation;
} {
  let candidateConfig = { ...config };
  let layouts = generateSmartLayouts(candidateConfig);
  let validation = validateGeneratedLayouts(layouts, candidateConfig);

  while (
    validation.errors.some((error) => error.includes("falls outside the generated view bounds")) &&
    candidateConfig.roomsPerWing > 1
  ) {
    candidateConfig = { ...candidateConfig, roomsPerWing: Math.max(1, candidateConfig.roomsPerWing - 1) };
    layouts = generateSmartLayouts(candidateConfig);
    validation = validateGeneratedLayouts(layouts, candidateConfig);
  }

  return { config: candidateConfig, layouts, validation };
}

export default function LayoutAssistantModal({
  isOpen,
  onClose,
  baseConfig,
  previousConfig,
  currentLayoutSummary,
  onApplyPreview,
  onUndoRequest,
  buildLocalPlan,
}: {
  isOpen: boolean;
  onClose: () => void;
  baseConfig: AutoGenerateConfig | null;
  previousConfig: AutoGenerateConfig | null;
  currentLayoutSummary: { floorCount: number; roomCount: number; activeFloor: number };
  onApplyPreview: (payload: {
    config: AutoGenerateConfig;
    layouts: Partial<Record<FloorId, Layout>>;
    reply: string;
    commands: Array<{ type: string; field: string; value: string }>;
  }) => void;
  onUndoRequest?: () => boolean;
  buildLocalPlan?: (prompt: string, baseConfig: AutoGenerateConfig) => PlannerResponse | null;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSamplePromptOpen, setIsSamplePromptOpen] = useState(false);
  const effectiveBaseConfig = useMemo(
    () => (baseConfig ? { ...baseConfig } : createDefaultAutoGenerateConfig()),
    [baseConfig]
  );

  useEffect(() => {
    if (!isOpen) return;
    setInput("");
    setMessages([]);
    setIsSamplePromptOpen(false);
  }, [isOpen]);

  const planningCurrentConfig = effectiveBaseConfig;
  const planningPreviousConfig = previousConfig ?? null;

  const handleUndoAndClose = () => {
    const undone = onUndoRequest?.() ?? false;
    if (undone) {
      onClose();
    }
    return undone;
  };

  const appendAssistantMessage = (text: string) => {
    setMessages((prev) => [...prev, { role: "assistant", text }]);
  };

  const applyPlan = (
    plan: PlannerResponse,
    layouts: Partial<Record<FloorId, Layout>>,
    validation: PreviewValidation
  ) => {
    if (validation.errors.length) {
      appendAssistantMessage(`Unable to apply change. Validation errors: ${validation.errors.join(" ")}`);
      return;
    }

    if (!Object.keys(layouts).length && plan.commands.length === 0) {
      appendAssistantMessage(`${plan.reply}\n\nThis request does not have any canvas changes to apply.`);
      return;
    }

    onApplyPreview({
      config: plan.proposedConfig,
      layouts,
      reply: plan.reply,
      commands: plan.commands,
    });

    const advisory = [
      plan.reply,
      validation.warnings.length ? `Warnings: ${validation.warnings.join(" ")}` : "",
      !Object.keys(layouts).length && plan.commands.length
        ? "Applied directly to the current canvas without regenerating the layout."
        : "Applied to the canvas.",
    ]
      .filter(Boolean)
      .join("\n\n");
    appendAssistantMessage(advisory);
    setInput("");
  };

  const submitPrompt = async () => {
    const prompt = input.trim();
    if (!prompt || isSubmitting) return;
    setMessages((prev) => [...prev, { role: "user", text: prompt }]);

    if (shouldHandleLocallyAsUndo(prompt)) {
      const undone = handleUndoAndClose();
      appendAssistantMessage(
        undone
          ? "Reverted the last canvas change without regenerating the layout."
          : "There is no earlier canvas change to revert."
      );
      setInput("");
      return;
    }

    const localPlan = buildLocalPlan?.(prompt, planningCurrentConfig) ?? null;
    if (localPlan) {
      const generated = localPlan.requiresRegeneration
        ? generateValidatedLayouts(localPlan.proposedConfig)
        : {
            config: localPlan.proposedConfig,
            layouts: {},
            validation: { errors: [], warnings: [] },
          };
      applyPlan({ ...localPlan, proposedConfig: generated.config }, generated.layouts, generated.validation);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await sandboxFetch(`${SANDBOX_SERVICE_BASE_URL}/layout-arranger/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          currentConfig: planningCurrentConfig,
          previousConfig: planningPreviousConfig,
          currentLayoutSummary,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as PlannerResponse | { detail?: string };
      if (!res.ok || !("ok" in payload) || !payload.ok) {
        const errorMessage = "detail" in payload && typeof payload.detail === "string" ? payload.detail : "Unable to plan layout changes.";
        appendAssistantMessage(errorMessage);
        return;
      }

      if (!payload.requiresRegeneration) {
        applyPlan(payload, {}, { errors: [], warnings: [] });
        return;
      }

      const generated = generateValidatedLayouts(payload.proposedConfig);
      applyPlan({ ...payload, proposedConfig: generated.config }, generated.layouts, generated.validation);
    } catch {
      appendAssistantMessage("Unable to reach the sandbox arranger service.");
    } finally {
      setIsSubmitting(false);
      setInput("");
    }
  };

  return (
    <>
      <MDBModal tabIndex="-1" open={isOpen} setOpen={onClose} size="lg">
        <MDBModalDialog centered size="lg" style={{ maxWidth: 760, width: "calc(100vw - 32px)" }}>
          <MDBModalContent
            style={{
              maxHeight: "calc(100vh - 48px)",
              height: "calc(100vh - 48px)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <MDBModalHeader style={{ background: "linear-gradient(90deg, #1f3b2f 0%, #166534 55%, #16a34a 100%)", color: "#fff" }}>
              <MDBModalTitle style={{ fontSize: 22, fontWeight: 800 }}>Layout Assistant</MDBModalTitle>
              <MDBBtn className="btn-close" color="none" onClick={onClose} style={{ filter: "invert(1)", cursor: "pointer" }} />
            </MDBModalHeader>
            <MDBModalBody
              style={{
                background: "#eef6f0",
                padding: 12,
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
              }}
            >
              <section style={{ display: "grid", gap: 8 }}>
                <div style={{ borderRadius: 18, border: "1px solid #d2e7d5", background: "#fff", padding: 14 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#14532d" }}>Conversation</div>
                    <MDBBtn
                      size="sm"
                      style={{
                        borderRadius: 999,
                        padding: "6px 10px",
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: "none",
                        background: "#2563eb",
                        border: "1px solid #1d4ed8",
                        color: "#fff",
                        boxShadow: "0 4px 10px rgba(37, 99, 235, 0.18)",
                      }}
                      onClick={handleUndoAndClose}
                    >
                      Revert Last Change
                    </MDBBtn>
                  </div>
                  <div style={{ display: "grid", gap: 8, minHeight: 240, paddingRight: 4 }}>
                    {messages.map((message, index) => (
                      <div
                        key={`${message.role}-${index}`}
                        style={{
                          borderRadius: 14,
                          padding: "10px 12px",
                          background: message.role === "assistant" ? "#f0fdf4" : "#eff6ff",
                          border: message.role === "assistant" ? "1px solid #bbf7d0" : "1px solid #bfdbfe",
                          color: "#0f172a",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        <strong style={{ display: "block", marginBottom: 4 }}>{message.role === "assistant" ? "Assistant" : "You"}</strong>
                        {message.text}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      data-gramm="false"
                      data-gramm_editor="false"
                      data-enable-grammarly="false"
                      placeholder="Example: Increase room sizes, add more rooms, make it taller, and label the gray boxes as Areas."
                      rows={3}
                      style={{
                        width: "100%",
                        borderRadius: 14,
                        border: "1px solid #cbd5e1",
                        padding: 10,
                        resize: "vertical",
                        fontSize: 14,
                      }}
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: "#475569" }}>
                        Current canvas: {currentLayoutSummary.roomCount} elements across {currentLayoutSummary.floorCount} floor(s).
                      </span>
                      {isSubmitting ? <span style={{ fontSize: 12, color: "#14532d", fontWeight: 700 }}>Applying...</span> : null}
                    </div>
                  </div>
                </div>
              </section>
            </MDBModalBody>
            <MDBModalFooter style={{ justifyContent: "space-between", gap: 12 }}>
              <MDBBtn
                color="light"
                onClick={() => setIsSamplePromptOpen(true)}
                style={{
                  borderRadius: 999,
                  padding: "8px 14px",
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "none",
                  border: "1px solid #bfdbfe",
                  color: "#1d4ed8",
                  background: "#eff6ff",
                }}
              >
                Sample Prompts
              </MDBBtn>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <MDBBtn color="secondary" onClick={onClose}>
                  Close
                </MDBBtn>
                <MDBBtn className="layout-action-btn layout-publish-btn" onClick={submitPrompt} disabled={isSubmitting || !input.trim()}>
                  Apply Change
                </MDBBtn>
              </div>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
      </MDBModal>
      <MDBModal tabIndex="-1" open={isSamplePromptOpen} setOpen={setIsSamplePromptOpen}>
        <MDBModalDialog centered style={{ maxWidth: 680, width: "calc(100vw - 32px)" }}>
          <MDBModalContent style={{ maxHeight: "calc(100vh - 48px)" }}>
            <MDBModalHeader style={{ background: "#eff6ff", color: "#0f172a" }}>
              <MDBModalTitle style={{ fontSize: 20, fontWeight: 800 }}>Sample Prompts</MDBModalTitle>
              <MDBBtn
                className="btn-close"
                color="none"
                onClick={() => setIsSamplePromptOpen(false)}
                style={{ cursor: "pointer" }}
              />
            </MDBModalHeader>
            <MDBModalBody
              style={{
                background: "#ffffff",
                padding: 18,
                maxHeight: "calc(100vh - 180px)",
                overflowY: "auto",
              }}
            >
              <div style={{ display: "grid", gap: 14 }}>
                <p style={{ margin: 0, fontSize: 14, color: "#334155" }}>
                  Use clear action verbs and describe the layout change you want. These are the usual requests the Layout Assistant handles best.
                </p>
                {ASSISTANT_CAPABILITY_GROUPS.map((group) => (
                  <section
                    key={group.verb}
                    style={{
                      border: "1px solid #dbeafe",
                      borderRadius: 16,
                      padding: 14,
                      background: "#f8fbff",
                    }}
                  >
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#14532d", marginBottom: 8 }}>{group.verb}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#0f172a", display: "grid", gap: 6 }}>
                      {group.examples.map((example) => (
                        <li key={example} style={{ fontSize: 14 }}>
                          {example}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </MDBModalBody>
            <MDBModalFooter style={{ justifyContent: "flex-end" }}>
              <MDBBtn color="secondary" onClick={() => setIsSamplePromptOpen(false)}>
                Close
              </MDBBtn>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
      </MDBModal>
    </>
  );
}
