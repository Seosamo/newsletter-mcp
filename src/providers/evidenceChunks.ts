import type { ContentItem, ContentSearchInput } from "../domain/types.js";

export type PageTextChunk = {
  index: number;
  total: number;
  text: string;
};

export function chunkPageText(text: string, options: { maxChars: number; overlapChars?: number }): PageTextChunk[] {
  const normalized = cleanText(text);
  if (!normalized) {
    return [];
  }

  const maxChars = Math.max(50, options.maxChars);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? 0, maxChars - 1));
  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(start + maxChars, normalized.length);
    const end = hardEnd < normalized.length
      ? findChunkBoundary(normalized, start, hardEnd)
      : hardEnd;
    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks.map((chunk, index) => ({
    index,
    total: chunks.length,
    text: chunk
  }));
}

export function selectRelevantPageChunks(
  chunks: PageTextChunk[],
  input: ContentSearchInput,
  maxChunks: number
): PageTextChunk[] {
  if (maxChunks <= 0 || chunks.length === 0) {
    return [];
  }
  if (chunks.length <= maxChunks) {
    return chunks;
  }

  const terms = buildEvidenceTerms(input);
  const scored = chunks.map((chunk) => ({
    chunk,
    score: scoreChunk(chunk.text, terms)
  }));
  const hasRelevantChunk = scored.some((item) => item.score > 0);

  return scored
    .sort((left, right) => {
      if (hasRelevantChunk && right.score !== left.score) {
        return right.score - left.score;
      }
      return left.chunk.index - right.chunk.index;
    })
    .slice(0, maxChunks)
    .map((item) => item.chunk)
    .sort((left, right) => left.index - right.index);
}

export function appendSelectedEvidenceChunks(item: ContentItem, chunks: PageTextChunk[]): ContentItem {
  if (chunks.length === 0) {
    return item;
  }

  return {
    ...item,
    evidence: uniqueStrings([...item.evidence, ...chunks.map(formatSelectedPageChunk)]),
    sourceReliability: Math.max(item.sourceReliability ?? 0.62, 0.7)
  };
}

export function formatSelectedPageChunk(chunk: PageTextChunk): string {
  return `[Page chunk ${chunk.index + 1}/${chunk.total}] ${chunk.text}`;
}

function buildEvidenceTerms(input: ContentSearchInput): string[] {
  const raw = [
    ...input.interests,
    ...input.regions,
    ...input.keywords,
    input.period.start,
    input.period.end,
    input.period.start.slice(0, 4),
    input.period.end.slice(0, 4)
  ];
  const phrases = raw.map((value) => value.trim()).filter((value) => value.length >= 2);
  const tokens = phrases
    .flatMap((value) => value.split(/[^\p{L}\p{N}]+/u))
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
  return uniqueStrings([...phrases, ...tokens]).map((value) => value.toLocaleLowerCase());
}

function scoreChunk(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const normalized = text.toLocaleLowerCase();
  return terms.reduce((score, term) => score + countOccurrences(normalized, term), 0);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function findChunkBoundary(text: string, start: number, hardEnd: number): number {
  const minEnd = start + Math.floor((hardEnd - start) * 0.6);
  const sentenceBoundary = text.lastIndexOf(". ", hardEnd);
  if (sentenceBoundary >= minEnd) {
    return sentenceBoundary + 1;
  }

  const whitespaceBoundary = text.lastIndexOf(" ", hardEnd);
  if (whitespaceBoundary >= minEnd) {
    return whitespaceBoundary;
  }

  return hardEnd;
}

function cleanText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
