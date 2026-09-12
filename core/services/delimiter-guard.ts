/**
 * Boundary integrity for Delos-generated prompt sections (T-SAN-01).
 *
 * Delos frames every context block with a line-leading `=== NAME ===`
 * delimiter. Two independent risks follow from that convention:
 *
 *  1. OUTBOUND — a single-turn print-mode model can continue past its own
 *     reply and echo the input framing. chat-service cuts the reply at the
 *     first such marker; {@link isDelosSectionHeaderLine} supplies the
 *     structural test so the guard no longer depends on an enumerated list
 *     staying in sync with every block author.
 *
 *  2. INBOUND — persisted dialogue text is re-injected into later contexts
 *     verbatim. Text that itself begins a line with `=== …` would then read
 *     as a genuine Delos section boundary, letting stored data open or close
 *     a prompt section. {@link neutralizeSectionDelimiters} removes that
 *     capability structurally: the payload is preserved for the reader, but
 *     it can no longer present as framing.
 *
 * This is deliberately STRUCTURAL, not a phrase table: the decision is made
 * from line position and delimiter shape, never from a growing vocabulary of
 * known block names.
 */

/**
 * Delos section-header shape: line-leading `===`, a SHOUTING name, and no
 * lowercase words before the first delimiter run. Matching is anchored to a
 * line start so ordinary prose containing "===" mid-sentence is untouched.
 *
 * Requiring at least four uppercase-or-space characters after `=== ` keeps
 * ordinary markdown rules ("====", "=== 3 ===") out of the match.
 */
const SECTION_HEADER_LINE = /^[ \t]*===[ \t]+[A-Z][A-Z0-9 _/&'()-]{3,}/;

/** True when one line reads as a Delos-minted section header/footer. */
export function isDelosSectionHeaderLine(line: string): boolean {
  return SECTION_HEADER_LINE.test(line);
}

/**
 * Index of the first line that reads as a Delos section header, or -1.
 * Returns a character offset into `text` (start of that line), so callers
 * can cut a model reply exactly where the echoed framing begins.
 */
export function findFirstSectionHeaderOffset(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (isDelosSectionHeaderLine(line)) {
      return offset;
    }
    offset += line.length + 1; // +1 for the consumed "\n"
  }
  return -1;
}

/**
 * Zero-width word joiner inserted after the first "=" of a line-leading
 * delimiter run. It is invisible to a reader, keeps the text semantically
 * identical, and breaks the literal `=== ` token so the line can no longer
 * be parsed — by a model or by this guard — as section framing.
 */
const NEUTRALIZER = "⁠";

/**
 * Make stored text safe to re-inject inside a delimited context block.
 * Only line-leading delimiter runs are altered; content is otherwise
 * byte-identical, and text with no such line is returned unchanged.
 */
export function neutralizeSectionDelimiters(text: string): string {
  if (!text.includes("===")) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => (/^[ \t]*={3,}/.test(line) ? line.replace(/=/, `=${NEUTRALIZER}`) : line))
    .join("\n");
}

/** True when neutralization would change the text (audit/assert helper). */
export function hasSectionDelimiterLine(text: string): boolean {
  return text.split("\n").some((line) => /^[ \t]*={3,}/.test(line));
}
