/** Normative contracts for Musagetes and the nine non-exclusive Muse lenses. */

export const MUSE_NAMES = [
  "Calliope",
  "Clio",
  "Erato",
  "Euterpe",
  "Melpomene",
  "Polyhymnia",
  "Terpsichore",
  "Thalia",
  "Urania",
] as const;

export type MuseName = (typeof MUSE_NAMES)[number];

export const MUSE_LENSES: Readonly<Record<MuseName, string>> = {
  Calliope: "narrative_au_continuity",
  Clio: "history_provenance_evidence",
  Erato: "love_desire_intimacy",
  Euterpe: "everyday_voice_rhythm",
  Melpomene: "distress_conflict_repair",
  Polyhymnia: "ritual_vows_identity_authority",
  Terpsichore: "embodiment_scene_motion",
  Thalia: "play_humour_teasing",
  Urania: "systems_abstraction_reasoning",
};

export interface SessionSceneState {
  mode: "ordinary" | "au" | "intimate";
  auId?: string;
  realm?: string;
  sessionId?: string;
}

export interface MuseLensSignal {
  muse: MuseName;
  /** Independent strength, not a probability and not an exclusive class. */
  weight: number;
  confidence: number;
  tags: readonly string[];
  traceId: string;
}

export interface MuseComposition {
  active: readonly MuseLensSignal[];
  scene: SessionSceneState;
  composedAt: string;
}

export interface RetrievalIntent {
  query: string;
  scene: SessionSceneState;
  activeMuses: readonly MuseName[];
  domains: readonly string[];
  sensitivityCeiling: "normal" | "sensitive" | "intimate";
  budget: { maxItems: number; maxTokens: number };
}

export interface MemoryCandidateIntent {
  source: { conversationId: string; turnId: string; contentSha256: string };
  scene: SessionSceneState;
  activeMuses: readonly MuseName[];
  action: "consider" | "review" | "decline";
  /** Category-only hints. Memory prose is authored in the governed proposal lane. */
  hints: readonly string[];
}

export interface MuseTraceEnvelope {
  kind: "muse_trace";
  traceId: string;
  muse: MuseName;
  recordedAt: string;
  metrics: Readonly<Record<string, number | string | boolean>>;
}

export function isMuseName(value: string): value is MuseName {
  return (MUSE_NAMES as readonly string[]).includes(value);
}

/** Muse traces are evaluation evidence and are forbidden as memory evidence. */
export function assertNotMuseTrace(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "muse_trace"
  ) {
    throw new TypeError("Muse traces cannot become memory evidence");
  }
}
