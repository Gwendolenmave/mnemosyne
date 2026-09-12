import type {
  MemoryCandidateIntent,
  MuseComposition,
  MuseLensSignal,
  MuseName,
  RetrievalIntent,
  SessionSceneState,
} from "../domain/mythos.js";

function finiteUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Compose every supported lens above the activation floor. This is
 * deliberately not an argmax classifier: several Muses may remain active.
 */
export function composeMuseSignals(
  signals: readonly MuseLensSignal[],
  scene: SessionSceneState,
  composedAt: string,
  activationFloor = 0.1,
): MuseComposition {
  const byMuse = new Map<MuseName, MuseLensSignal>();
  for (const signal of signals) {
    const normalized: MuseLensSignal = {
      ...signal,
      weight: finiteUnit(signal.weight),
      confidence: finiteUnit(signal.confidence),
      tags: [...new Set(signal.tags.map((tag) => tag.trim()).filter(Boolean))],
    };
    const previous = byMuse.get(signal.muse);
    if (previous === undefined || normalized.weight > previous.weight) {
      byMuse.set(signal.muse, normalized);
    }
  }
  const active = [...byMuse.values()]
    .filter((signal) => signal.weight >= activationFloor)
    .sort((left, right) => right.weight - left.weight || left.muse.localeCompare(right.muse));
  return { active, scene: { ...scene }, composedAt };
}

export function retrievalIntentFromComposition(
  composition: MuseComposition,
  input: {
    query: string;
    domains?: readonly string[];
    sensitivityCeiling?: RetrievalIntent["sensitivityCeiling"];
    maxItems?: number;
    maxTokens?: number;
  },
): RetrievalIntent {
  return {
    query: input.query,
    scene: { ...composition.scene },
    activeMuses: composition.active.map((signal) => signal.muse),
    domains: [...new Set(input.domains ?? composition.active.flatMap((signal) => signal.tags))],
    sensitivityCeiling: input.sensitivityCeiling ?? "normal",
    budget: {
      maxItems: Math.max(0, Math.floor(input.maxItems ?? 8)),
      maxTokens: Math.max(0, Math.floor(input.maxTokens ?? 1200)),
    },
  };
}

export function memoryCandidateIntentFromComposition(
  composition: MuseComposition,
  input: MemoryCandidateIntent["source"] & { action?: MemoryCandidateIntent["action"] },
): MemoryCandidateIntent {
  return {
    source: {
      conversationId: input.conversationId,
      turnId: input.turnId,
      contentSha256: input.contentSha256,
    },
    scene: { ...composition.scene },
    activeMuses: composition.active.map((signal) => signal.muse),
    action: input.action ?? (composition.active.length > 0 ? "consider" : "decline"),
    hints: [...new Set(composition.active.flatMap((signal) => signal.tags))],
  };
}
