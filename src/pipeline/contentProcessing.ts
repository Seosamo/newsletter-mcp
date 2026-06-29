import type {
  ContentItem,
  InterestTagSetting,
  Period,
  RankedNewsletterItem,
  SourceRef
} from "../domain/types.js";
import { dayDistance } from "./dates.js";

export function filterExcludedKeywords(items: ContentItem[], excludedKeywords: string[]): ContentItem[] {
  const normalizedExcluded = excludedKeywords.map((keyword) => keyword.trim().toLocaleLowerCase()).filter(Boolean);
  if (normalizedExcluded.length === 0) {
    return items;
  }

  return items.filter((item) => {
    const searchable = [
      item.title,
      item.summary,
      ...item.keywords,
      ...item.evidence
    ].join(" ").toLocaleLowerCase();
    return !normalizedExcluded.some((keyword) => searchable.includes(keyword));
  });
}

export function filterOldEvents(items: ContentItem[], period: Period): ContentItem[] {
  return items.filter((item) => item.type !== "event" || !item.eventDate || item.eventDate >= period.start);
}

export function deduplicateItems(items: ContentItem[]): ContentItem[] {
  const seen = new Set<string>();
  const deduped: ContentItem[] = [];

  for (const item of items) {
    const key = item.url ? normalizeUrl(item.url) : normalizeTitle(item.title);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export function rankItems(
  items: ContentItem[],
  interests: string[],
  regions: string[],
  settings: InterestTagSetting[],
  period: Period
): RankedNewsletterItem[] {
  return items
    .map((item) => toRankedItem(item, interests, regions, settings, period))
    .sort((left, right) => right.importanceScore - left.importanceScore);
}

export function buildSourceRefs(items: RankedNewsletterItem[]): SourceRef[] {
  const bySource = new Map<string, SourceRef>();
  for (const item of items) {
    const sourceName = item.sourceName ?? "Unknown Source";
    const existing = bySource.get(sourceName);
    if (existing) {
      existing.itemIds.push(item.id);
      if (!existing.sourceUrl && item.sourceUrl) {
        existing.sourceUrl = item.sourceUrl;
      }
    } else {
      bySource.set(sourceName, {
        sourceName,
        sourceUrl: item.sourceUrl,
        itemIds: [item.id]
      });
    }
  }
  return [...bySource.values()];
}

function toRankedItem(
  item: ContentItem,
  interests: string[],
  regions: string[],
  settings: InterestTagSetting[],
  period: Period
): RankedNewsletterItem {
  const interestScore = scoreInterestMatch(item, interests);
  const recencyScore = scoreRecency(item, period);
  const reliabilityScore = clamp(item.sourceReliability ?? 0.7, 0, 1);
  const regionScore = scoreRegionMatch(item, regions);
  const weightScore = scoreTagWeight(item, settings);
  const recommendationScore = item.type === "recommendation" ? 1 : 0.5;

  const rawScore =
    interestScore * 0.35 +
    recencyScore * 0.25 +
    reliabilityScore * 0.15 +
    regionScore * 0.1 +
    weightScore * 0.1 +
    recommendationScore * 0.05;

  const importanceScore = Math.round(rawScore * 100);
  const date = item.eventDate ?? item.publishedAt;
  const selectedEvidence = item.evidence.filter((evidence) => evidence.startsWith("[Page chunk "));

  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    type: item.type,
    interestTags: item.interestTags,
    region: item.regions[0],
    date,
    sourceName: item.sourceName,
    sourceUrl: item.url,
    importanceScore,
    rankingReason: buildRankingReason({
      interestScore,
      recencyScore,
      regionScore,
      weightScore,
      item,
      selectedEvidenceCount: selectedEvidence.length
    }),
    evidence: item.evidence,
    selectedEvidence
  };
}

function scoreInterestMatch(item: ContentItem, interests: string[]): number {
  if (interests.length === 0) {
    return 0.5;
  }
  const searchable = `${item.title} ${item.summary} ${item.interestTags.join(" ")}`.toLocaleLowerCase();
  return interests.some((interest) => searchable.includes(interest.toLocaleLowerCase())) ? 1 : 0.2;
}

function scoreRecency(item: ContentItem, period: Period): number {
  const date = item.eventDate ?? item.publishedAt;
  if (!date) {
    return 0.5;
  }
  const span = Math.max(dayDistance(period.start, period.end), 1);
  const ageFromEnd = Math.max(dayDistance(date, period.end), 0);
  return clamp(1 - ageFromEnd / span, 0.2, 1);
}

function scoreRegionMatch(item: ContentItem, regions: string[]): number {
  if (regions.length === 0) {
    return 0.5;
  }
  const searchable = `${item.title} ${item.summary} ${item.regions.join(" ")}`.toLocaleLowerCase();
  return regions.some((region) => searchable.includes(region.toLocaleLowerCase())) ? 1 : 0.2;
}

function scoreTagWeight(item: ContentItem, settings: InterestTagSetting[]): number {
  const matchingWeights = settings
    .filter((setting) => {
      const settingLabels = [setting.label, ...setting.aliases].map((value) => value.toLocaleLowerCase());
      return item.interestTags.some((tag) => settingLabels.includes(tag.toLocaleLowerCase()));
    })
    .map((setting) => setting.weight);
  if (matchingWeights.length === 0) {
    return 0.5;
  }
  return clamp(Math.max(...matchingWeights) / 2, 0, 1);
}

function buildRankingReason(input: {
  interestScore: number;
  recencyScore: number;
  regionScore: number;
  weightScore: number;
  item: ContentItem;
  selectedEvidenceCount: number;
}): string {
  const reasons = [];
  if (input.interestScore >= 0.9) {
    reasons.push("관심 태그와 직접 일치");
  }
  if (input.recencyScore >= 0.8) {
    reasons.push("요청 기간 기준 최신성 높음");
  }
  if (input.regionScore >= 0.9) {
    reasons.push("선호 지역과 연결");
  }
  if (input.weightScore > 0.5) {
    reasons.push("사용자 태그 가중치 반영");
  }
  if (input.item.type === "recommendation") {
    reasons.push("추천 섹션 적합");
  }
  if (input.selectedEvidenceCount > 0) {
    reasons.push("본문 chunk에서 query 관련 근거 발견");
  }
  return reasons.length > 0 ? reasons.join(", ") : "기본 랭킹 기준에 따라 포함";
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLocaleLowerCase();
  } catch {
    return url.trim().toLocaleLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
