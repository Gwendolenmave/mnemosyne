/**
 * Word segmentation shared by indexing (adapter side) and querying
 * (Anamnesis). One function, one behavior: FTS text is pre-segmented with
 * Intl.Segmenter so two-character Chinese terms, English terms, and mixed
 * queries all match under the plain unicode61 tokenizer.
 */

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });

/** Space-joined, lowercased word segmentation for both index and query. */
export function segmentForSearch(text: string): string {
  const tokens: string[] = [];
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike === true) {
      const token = part.segment.trim();
      if (token.length > 0) {
        tokens.push(token.toLowerCase());
      }
    }
  }
  return tokens.join(" ");
}
