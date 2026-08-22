import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptBundle, PromptSection } from "../domain/types.js";

/**
 * Canonical runtime prompt library. prompts/ is the single authoritative,
 * user-authored source for Companion; contents are never rewritten,
 * summarized, or duplicated in code. All seven files are read exactly once
 * at startup and validated strictly. They are then compiled into
 * immutable static modules rather than one universal prefix:
 *
 *   - ordinary chat: identity and relationship open every variant; any
 *     active conditional modules follow (intimacy, then
 *     sensitive-context); response-style always closes. Stating the
 *     style rules last means they are read against everything above
 *     them rather than against the two files that happen to precede
 *     them — measured 2026-07-26 against the same files in both orders;
 *   - memory pipeline only: memory-policy — never part of ordinary
 *     chat generation calls, exposed through a dedicated accessor.
 */
export const PROMPT_ORDER: ReadonlyArray<{ name: string; file: string }> = [
  { name: "identity", file: "identity.md" },
  { name: "relationship", file: "relationship.md" },
  { name: "response-style", file: "response-style.md" },
  { name: "intimacy", file: "intimacy.md" },
  { name: "sensitive-context", file: "sensitive-context.md" },
  { name: "memory-policy", file: "memory-policy.md" },
  { name: "thin-bridge-contract", file: "thin-bridge-contract.md" },
];

export const THIN_BRIDGE_CONTRACT_NAME = "thin-bridge-contract";

/** Always-on ordinary-chat core, in required order. */
export const CHAT_CORE_NAMES = ["identity", "relationship", "response-style"] as const;

/** Stated before any conditional module. */
const CHAT_OPENING_NAMES = ["identity", "relationship"] as const;

/** Stated last in every variant, so it governs the modules above it. */
const CHAT_CLOSING_NAME = "response-style";

/** The four precompiled ordinary-chat variants. */
export type ChatVariantName =
  | "core"
  | "core+intimacy"
  | "core+sensitive-context"
  | "core+intimacy+sensitive-context";

export const CHAT_VARIANT_NAMES: readonly ChatVariantName[] = [
  "core",
  "core+intimacy",
  "core+sensitive-context",
  "core+intimacy+sensitive-context",
];

/** Section names composing each variant, in required inclusion order. */
const VARIANT_MEMBERSHIP: Readonly<Record<ChatVariantName, readonly string[]>> = {
  core: [...CHAT_OPENING_NAMES, CHAT_CLOSING_NAME],
  "core+intimacy": [...CHAT_OPENING_NAMES, "intimacy", CHAT_CLOSING_NAME],
  "core+sensitive-context": [...CHAT_OPENING_NAMES, "sensitive-context", CHAT_CLOSING_NAME],
  "core+intimacy+sensitive-context": [
    ...CHAT_OPENING_NAMES,
    "intimacy",
    "sensitive-context",
    CHAT_CLOSING_NAME,
  ],
};

export class PromptLoadError extends Error {
  constructor(
    message: string,
    readonly promptName: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PromptLoadError";
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Load all authority prompts from promptsDir in deterministic order.
 * Fails clearly — naming the exact file — if any required prompt is
 * missing, unreadable, empty, or not valid UTF-8. Contents pass through
 * byte-for-byte; recorded paths are repo-relative ("prompts/<file>").
 */
export function loadPromptBundle(promptsDir: string): PromptBundle {
  const sections: PromptSection[] = [];
  for (const { name, file } of PROMPT_ORDER) {
    const absolutePath = join(promptsDir, file);
    const relativePath = `prompts/${file}`;
    let raw: Buffer;
    try {
      raw = readFileSync(absolutePath);
    } catch {
      throw new PromptLoadError(
        `Required prompt "${name}" is missing or unreadable at ${relativePath}`,
        name,
        relativePath,
      );
    }
    let content: string;
    try {
      content = strictUtf8.decode(raw);
    } catch {
      throw new PromptLoadError(
        `Required prompt "${name}" at ${relativePath} is not valid UTF-8`,
        name,
        relativePath,
      );
    }
    if (content.trim().length === 0) {
      throw new PromptLoadError(
        `Required prompt "${name}" at ${relativePath} is empty`,
        name,
        relativePath,
      );
    }
    sections.push({
      name,
      path: relativePath,
      sha256: sha256Hex(content),
      content,
    });
  }
  return { sections };
}

/** One immutable precompiled ordinary-chat prompt variant. */
export interface CompiledPromptVariant {
  name: ChatVariantName;
  /** Included sections, in inclusion order. */
  sections: PromptSection[];
  /** Deterministic delimited static prefix, byte-identical for the process lifetime. */
  staticPrefix: string;
  /** Checksum of the complete static prefix (safe to log). */
  sha256: string;
  /** Total UTF-8 bytes of the included source files (safe to log). */
  totalBytes: number;
}

/**
 * The validated seven-file library: four precompiled ordinary-chat variants,
 * the memory-policy section, and the opt-in Thin Bridge overlay source.
 */
export interface PromptLibrary {
  /** All seven validated sections in canonical order (metadata source). */
  sections: PromptSection[];
  /** The four immutable ordinary-chat variants, compiled once. */
  variants: Readonly<Record<ChatVariantName, CompiledPromptVariant>>;
}

/**
 * Compile one ordered section list into its delimited static prefix.
 * Delimiters are fixed and deterministic so the compiled string stays
 * byte-identical across turns and restarts; file contents are embedded
 * verbatim between them.
 */
function compilePrefix(sections: PromptSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(
      `=== DELOS PROMPT AUTHORITY: ${section.name} (${section.path}) ===`,
      section.content.endsWith("\n") ? section.content.slice(0, -1) : section.content,
      `=== END PROMPT AUTHORITY: ${section.name} ===`,
      "",
    );
  }
  return parts.join("\n");
}

function compileVariant(name: ChatVariantName, allSections: PromptSection[]): CompiledPromptVariant {
  const sections = VARIANT_MEMBERSHIP[name].map((sectionName) => {
    const section = allSections.find((s) => s.name === sectionName);
    if (section === undefined) {
      throw new PromptLoadError(
        `Variant "${name}" requires prompt "${sectionName}" which was not loaded`,
        sectionName,
        `prompts/${sectionName}.md`,
      );
    }
    return section;
  });
  const staticPrefix = compilePrefix(sections);
  return {
    name,
    sections,
    staticPrefix,
    sha256: sha256Hex(staticPrefix),
    totalBytes: sections.reduce((sum, s) => sum + Buffer.byteLength(s.content, "utf8"), 0),
  };
}

/**
 * Compile the four ordinary-chat variants from validated sections. Pure:
 * the result depends only on the given sections, never on disk state.
 */
export function compileLibrarySections(sections: PromptSection[]): PromptLibrary {
  const variants = {} as Record<ChatVariantName, CompiledPromptVariant>;
  for (const name of CHAT_VARIANT_NAMES) {
    variants[name] = compileVariant(name, sections);
  }
  return { sections, variants };
}

/** Startup entry point: read once, validate, compile, retain in memory. */
export function compilePromptLibrary(promptsDir: string): PromptLibrary {
  return compileLibrarySections(loadPromptBundle(promptsDir).sections);
}

/**
 * Derive the tested P1.2 chat surface without mutating the base library.
 * Composition selects it only for the Codex conversational lane, so memory
 * governance and episode-summary prompts never inherit a chat transport rule.
 */
export function compileThinBridgePromptLibrary(library: PromptLibrary): PromptLibrary {
  const contract = library.sections.find((section) => section.name === THIN_BRIDGE_CONTRACT_NAME);
  if (contract === undefined) {
    throw new PromptLoadError(
      `Thin bridge requires prompt "${THIN_BRIDGE_CONTRACT_NAME}" which was not loaded`,
      THIN_BRIDGE_CONTRACT_NAME,
      "prompts/thin-bridge-contract.md",
    );
  }
  const variants = {} as Record<ChatVariantName, CompiledPromptVariant>;
  for (const name of CHAT_VARIANT_NAMES) {
    const base = library.variants[name];
    if (base.sections.some((section) => section.name === THIN_BRIDGE_CONTRACT_NAME)) {
      variants[name] = base;
      continue;
    }
    const sections = [...base.sections, contract];
    const staticPrefix = compilePrefix(sections);
    variants[name] = {
      name,
      sections,
      staticPrefix,
      sha256: sha256Hex(staticPrefix),
      totalBytes: sections.reduce(
        (sum, section) => sum + Buffer.byteLength(section.content, "utf8"),
        0,
      ),
    };
  }
  return { sections: library.sections, variants };
}

/** Conversation-mode shape consumed by variant selection (structural). */
export interface VariantSelectionMode {
  intimacyActive: boolean;
  sensitiveContextActive: boolean;
}

/**
 * Inverse of {@link selectVariantName}: recover the conversation mode a
 * recorded variant name implies. Used by restart restoration to resume the
 * exact mode a turn actually ran under, instead of re-inferring it from a
 * truncated tail. Returns null for an unrecognized name so a malformed or
 * future variant can never silently seed a mode.
 */
export function modeFromVariantName(name: string): VariantSelectionMode | null {
  if (!(CHAT_VARIANT_NAMES as readonly string[]).includes(name)) {
    return null;
  }
  return {
    intimacyActive: name.includes("intimacy"),
    sensitiveContextActive: name.includes("sensitive-context"),
  };
}

/** Deterministic mapping from conversation mode to static variant. */
export function selectVariantName(mode: VariantSelectionMode): ChatVariantName {
  if (mode.intimacyActive && mode.sensitiveContextActive) {
    return "core+intimacy+sensitive-context";
  }
  if (mode.intimacyActive) {
    return "core+intimacy";
  }
  if (mode.sensitiveContextActive) {
    return "core+sensitive-context";
  }
  return "core";
}

/**
 * Dedicated accessor for the memory pipeline. memory-policy.md is
 * validated at startup like every other prompt but is never injected
 * into ordinary chat generation; only memory retrieval, extraction,
 * consolidation, correction, or write workflows may consume it.
 */
export function getMemoryPolicySection(library: PromptLibrary): PromptSection {
  const section = library.sections.find((s) => s.name === "memory-policy");
  if (section === undefined) {
    throw new PromptLoadError(
      "memory-policy section missing from the compiled library",
      "memory-policy",
      "prompts/memory-policy.md",
    );
  }
  return section;
}

/**
 * Loggable description: variant names, included filenames, byte counts,
 * and checksums — never any prompt content.
 */
export function describePromptLibrary(library: PromptLibrary): string[] {
  const lines = library.sections.map(
    (s, i) =>
      `prompt[${i + 1}/${library.sections.length}] ${s.path} (${Buffer.byteLength(s.content, "utf8")} bytes)`,
  );
  for (const name of CHAT_VARIANT_NAMES) {
    const variant = library.variants[name];
    lines.push(
      `variant ${name}: [${variant.sections.map((s) => s.path).join(", ")}] ` +
        `${variant.totalBytes} bytes, sha256=${variant.sha256.slice(0, 16)}…`,
    );
  }
  const memoryPolicy = getMemoryPolicySection(library);
  lines.push(
    `memory-policy: ${memoryPolicy.path} (${Buffer.byteLength(memoryPolicy.content, "utf8")} bytes) — memory pipeline only, excluded from all chat variants`,
  );
  const bridge = library.sections.find((section) => section.name === THIN_BRIDGE_CONTRACT_NAME);
  if (bridge !== undefined) {
    lines.push(
      `thin-bridge overlay: ${bridge.path} (${Buffer.byteLength(bridge.content, "utf8")} bytes) - explicit chat composition only`,
    );
  }
  return lines;
}
