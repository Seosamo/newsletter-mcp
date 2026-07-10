import { randomUUID } from "node:crypto";
import { createDefaultProfile, DEFAULT_TEMPLATE_ID, DEFAULT_USER_ID } from "../domain/defaults.js";
import type {
  ContentSearchInput,
  GenerateNewsletterDraftInput,
  InterestTagSetting,
  NewsletterDraft,
  NewsletterEdition,
  NewsletterEditionPlan,
  NewsletterEditorInstructions,
  NewsletterFormatPreference,
  NewsletterHistoryEntry,
  NewsletterOutline,
  NewsletterSectionId,
  NewsletterTemplate,
  RankedNewsletterItem,
  SourcePreference,
  UserProfile
} from "../domain/types.js";
import type { ContentProvider } from "../providers/ContentProvider.js";
import type { NewsletterStorage } from "../storage/NewsletterStorage.js";
import {
  mergeSourcePreferences,
  normalizeSourcePreferences,
  sourcePreferencesFromHints
} from "../sources/sourcePreferences.js";
import {
  buildSourceRefs,
  deduplicateItems,
  filterExcludedKeywords,
  filterOldEvents,
  rankItems
} from "./contentProcessing.js";
import { computeDefaultPeriod } from "./dates.js";

export class NewsletterDraftGenerator {
  constructor(
    private readonly storage: NewsletterStorage,
    private readonly providers: ContentProvider[],
    private readonly now: () => Date = () => new Date()
  ) {}

  async generate(input: GenerateNewsletterDraftInput): Promise<NewsletterDraft> {
    const now = this.now();
    const userId = normalizeUserId(input.userId);
    const profile = (await this.storage.getProfile(userId)) ?? createDefaultProfile(userId, now);
    const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
    const template = await this.resolveTemplate(templateId);
    const settings = await this.storage.listUserCategorySettings(userId);

    const interests = normalizeList(input.interests ?? profile.interests);
    const regions = normalizeList(input.regions ?? profile.regions);
    const period = input.period ?? computeDefaultPeriod(profile.schedule.frequency, now);
    const tone = input.tone ?? profile.preferredTone;
    const formatPreference = {
      ...profile.formatPreference,
      ...input.format
    };
    const matchedSettings = matchSettings(interests, settings);
    const keywords = buildKeywords(interests, matchedSettings);
    const sourceHints = [...new Set(matchedSettings.flatMap((setting) => setting.sourceHints))];
    const globalSourcePreferences = normalizeSourcePreferences(profile.sourcePreferences);
    const sourcePreferences = buildSourcePreferences(globalSourcePreferences, matchedSettings, sourceHints);
    const warnings: string[] = [];

    if (interests.length === 0) {
      warnings.push("No interests were provided and the user profile has no default interests.");
    }

    const searchInput: ContentSearchInput = {
      userId,
      interests,
      regions,
      keywords,
      sourceHints,
      sourcePreferences,
      period,
      excludedKeywords: profile.excludedKeywords
    };
    const searchInputs = buildSearchInputs(searchInput, interests, settings, globalSourcePreferences);

    const providerResults = await Promise.all(
      this.providers.flatMap((provider) =>
        searchInputs.map(async (providerInput) => {
          try {
            return await provider.search(providerInput);
          } catch (error) {
            return {
              items: [],
              warnings: [`${provider.name} failed for ${formatSearchInputLabel(providerInput)}: ${error instanceof Error ? error.message : String(error)}`]
            };
          }
        })
      )
    );

    const collected = providerResults.flatMap((result) => result.items);
    warnings.push(...providerResults.flatMap((result) => result.warnings));

    const filtered = filterOldEvents(
      deduplicateItems(filterExcludedKeywords(collected, profile.excludedKeywords)),
      period
    );
    const ranked = capSelectedEvidenceBudget(
      rankItems(filtered, interests, regions, matchedSettings, period, sourcePreferences),
      8
    );
    const sections = mapSections(ranked, template, formatPreference);
    const selectedItems = Object.values(sections).flat();

    if (selectedItems.length === 0) {
      warnings.push("No content items matched the request after filtering and ranking.");
    }

    const generatedAt = now.toISOString();
    const title = buildTitle(interests);
    const draft: NewsletterDraft = {
      draftId: `draft_${randomUUID()}`,
      title,
      metadata: {
        userId,
        userMessage: input.userMessage,
        interests,
        regions,
        period,
        tone,
        templateId,
        edition: formatPreference.edition,
        generatedAt
      },
      editorInstructions: buildEditorInstructions(template, tone, formatPreference),
      outline: buildNewsletterOutline(title, sections),
      sections,
      sources: buildSourceRefs(selectedItems),
      warnings
    };

    await this.storage.saveHistory(toHistoryEntry(draft));
    return draft;
  }

  private async resolveTemplate(templateId: string): Promise<NewsletterTemplate> {
    const explicitTemplate = await this.storage.getTemplate(templateId);
    if (explicitTemplate) {
      return explicitTemplate;
    }

    const [firstTemplate] = await this.storage.listTemplates();
    if (firstTemplate) {
      return firstTemplate;
    }

    throw new Error(`Newsletter template not found: ${templateId}`);
  }
}

function normalizeUserId(userId: string | undefined): string {
  return userId?.trim() || DEFAULT_USER_ID;
}

function capSelectedEvidenceBudget(items: RankedNewsletterItem[], maxSelectedEvidence: number): RankedNewsletterItem[] {
  let remaining = maxSelectedEvidence;
  return items.map((item) => {
    const selectedEvidence = item.selectedEvidence ?? [];
    if (selectedEvidence.length === 0) {
      return item;
    }

    const keptSelectedEvidence = selectedEvidence.slice(0, Math.max(remaining, 0));
    remaining -= keptSelectedEvidence.length;
    const nonPageEvidence = item.evidence.filter((evidence) => !evidence.startsWith("[Page chunk "));

    return {
      ...item,
      selectedEvidence: keptSelectedEvidence,
      evidence: [...nonPageEvidence, ...keptSelectedEvidence],
      rankingReason: keptSelectedEvidence.length > 0
        ? item.rankingReason
        : removeRankingReason(item.rankingReason, "본문 chunk에서 query 관련 근거 발견")
    };
  });
}

function removeRankingReason(reason: string, target: string): string {
  const keptReasons = reason
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== target);
  return keptReasons.length > 0 ? keptReasons.join(", ") : "기본 랭킹 기준에 따라 포함";
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function matchSettings(interests: string[], settings: InterestTagSetting[]): InterestTagSetting[] {
  const normalizedInterests = new Set(interests.map((interest) => interest.toLocaleLowerCase()));
  return settings.filter((setting) => {
    const candidates = [setting.label, ...setting.aliases].map((value) => value.toLocaleLowerCase());
    return candidates.some((candidate) => normalizedInterests.has(candidate));
  });
}

function buildKeywords(interests: string[], settings: InterestTagSetting[]): string[] {
  return [
    ...new Set([
      ...interests,
      ...settings.flatMap((setting) => [setting.label, ...setting.aliases, ...setting.keywords])
    ])
  ].filter(Boolean);
}

function buildSearchInputs(
  baseInput: ContentSearchInput,
  interests: string[],
  settings: InterestTagSetting[],
  globalSourcePreferences: SourcePreference[]
): ContentSearchInput[] {
  if (interests.length <= 1) {
    return [baseInput];
  }

  const perInterestInputs = interests.map((interest) => {
    const matchedSettings = matchSettings([interest], settings);
    const sourceHints = [...new Set(matchedSettings.flatMap((setting) => setting.sourceHints))];
    return {
      ...baseInput,
      interests: [interest],
      keywords: buildKeywords([interest], matchedSettings),
      sourceHints,
      sourcePreferences: buildSourcePreferencesFromParts(
        globalSourcePreferences,
        matchedSettings,
        sourceHints
      )
    };
  });

  return [baseInput, ...perInterestInputs];
}

function buildSourcePreferences(
  globalPreferences: SourcePreference[],
  settings: InterestTagSetting[],
  sourceHints: string[]
): SourcePreference[] {
  return buildSourcePreferencesFromParts(
    globalPreferences,
    settings,
    sourceHints
  );
}

function buildSourcePreferencesFromParts(
  globalPreferences: SourcePreference[],
  settings: InterestTagSetting[],
  sourceHints: string[]
): SourcePreference[] {
  return mergeSourcePreferences(
    globalPreferences,
    ...settings.map((setting) => normalizeSourcePreferences(setting.sourcePreferences)),
    sourcePreferencesFromHints(sourceHints)
  );
}

function formatSearchInputLabel(input: ContentSearchInput): string {
  return input.interests.length > 0 ? input.interests.join("/") : "combined request";
}

function mapSections(
  ranked: RankedNewsletterItem[],
  template: NewsletterTemplate,
  formatPreference: NewsletterFormatPreference
): Record<NewsletterSectionId, RankedNewsletterItem[]> {
  const editionPlan = resolveEditionPlan(formatPreference.edition);
  const shortLimit = editionPlan?.shortArticleCount;
  const newsItems = ranked.filter((item) => item.type === "news");

  return {
    top_stories: takeBySection(newsItems, template, "top_stories", shortLimit),
    key_dates: takeBySection(ranked.filter((item) => item.type === "event"), template, "key_dates"),
    deep_dive: formatPreference.includeCommentary
      ? buildDeepDiveItems(newsItems, template, editionPlan)
      : [],
    recommendations: formatPreference.includeRecommendations
      ? takeBySection(ranked.filter((item) => item.type === "recommendation"), template, "recommendations")
      : []
  };
}

function buildDeepDiveItems(
  newsItems: RankedNewsletterItem[],
  template: NewsletterTemplate,
  editionPlan: NewsletterEditionPlan | undefined
): RankedNewsletterItem[] {
  if (!editionPlan || editionPlan.multiSourceTopicCount === 0) {
    const limit = editionPlan
      ? editionPlan.longTopicCount + editionPlan.multiSourceTopicCount
      : undefined;
    return takeBySection(newsItems, template, "deep_dive", limit);
  }

  const multiSourceItems = buildMultiSourceComparisonItems(newsItems, editionPlan.multiSourceTopicCount);
  const groupedIds = new Set(multiSourceItems.flatMap((item) => [
    item.id.replace(/::multi_source$/, ""),
    ...(item.relatedSources ?? []).map((related) => related.id)
  ]));
  const standardItems = takeBySection(
    newsItems.filter((item) => !groupedIds.has(item.id)),
    template,
    "deep_dive",
    editionPlan.longTopicCount
  );
  const totalLimit = editionPlan.longTopicCount + editionPlan.multiSourceTopicCount;
  const combined = [...standardItems, ...multiSourceItems];

  if (combined.length >= totalLimit) {
    return combined.slice(0, totalLimit);
  }

  const usedIds = new Set(combined.flatMap((item) => [
    item.id.replace(/::multi_source$/, ""),
    ...(item.relatedSources ?? []).map((related) => related.id)
  ]));
  const fillers = newsItems
    .filter((item) => !usedIds.has(item.id))
    .slice(0, totalLimit - combined.length);

  return [...combined, ...fillers];
}

type TopicGroup = {
  items: RankedNewsletterItem[];
  score: number;
};

function buildMultiSourceComparisonItems(
  newsItems: RankedNewsletterItem[],
  count: number
): RankedNewsletterItem[] {
  if (count <= 0) {
    return [];
  }

  const tokenCache = new Map<string, Set<string>>();
  const groups: RankedNewsletterItem[][] = [];

  for (const item of newsItems) {
    const tokens = topicTokens(item, tokenCache);
    if (tokens.size < 2) {
      continue;
    }

    let bestGroup: RankedNewsletterItem[] | undefined;
    let bestScore = 0;
    for (const group of groups) {
      const groupScore = Math.max(
        ...group.map((existing) => topicSimilarity(tokens, topicTokens(existing, tokenCache)))
      );
      if (groupScore > bestScore) {
        bestScore = groupScore;
        bestGroup = group;
      }
    }

    if (bestGroup && bestScore >= 0.45) {
      bestGroup.push(item);
    } else {
      groups.push([item]);
    }
  }

  const candidates = groups
    .map((items): TopicGroup | undefined => {
      const distinctSources = countDistinctSources(items);
      if (items.length < 2 || distinctSources < 2) {
        return undefined;
      }
      return {
        items,
        score: average(items.map((item) => item.importanceScore)) + distinctSources * 8 + items.length * 2
      };
    })
    .filter((group): group is TopicGroup => Boolean(group))
    .sort((left, right) => right.score - left.score);

  const usedIds = new Set<string>();
  const comparisonItems: RankedNewsletterItem[] = [];

  for (const group of candidates) {
    const available = group.items.filter((item) => !usedIds.has(item.id));
    const uniqueItems = uniqueItemsBySource(available);
    if (uniqueItems.length < 2) {
      continue;
    }

    const [representative, ...related] = uniqueItems;
    const relatedSources = related.slice(0, 4).map(toRelatedSourceItem);
    const sourceCount = countDistinctSources([representative, ...relatedSources]);
    comparisonItems.push({
      ...representative,
      id: `${representative.id}::multi_source`,
      importanceScore: Math.min(100, representative.importanceScore + Math.min(sourceCount * 2, 8)),
      rankingReason: appendRankingReason(
        representative.rankingReason,
        `multi-source comparison: ${sourceCount} sources`
      ),
      relatedSources,
      comparisonGroupReason: `Grouped same topic across ${sourceCount} distinct sources for the evening edition.`
    });

    for (const item of uniqueItems) {
      usedIds.add(item.id);
    }

    if (comparisonItems.length >= count) {
      break;
    }
  }

  return comparisonItems;
}

function toRelatedSourceItem(item: RankedNewsletterItem) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    date: item.date,
    imageUrl: item.imageUrl,
    imageAlt: item.imageAlt,
    importanceScore: item.importanceScore,
    rankingReason: item.rankingReason,
    evidence: item.evidence,
    selectedEvidence: item.selectedEvidence
  };
}

function topicTokens(item: RankedNewsletterItem, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(item.id);
  if (cached) {
    return cached;
  }

  const tokens = new Set(
    `${item.title} ${item.summary}`
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => token.trim())
      .filter((token) => token.length >= 2 && !TOPIC_STOP_WORDS.has(token)) ?? []
  );
  cache.set(item.id, tokens);
  return tokens;
}

function topicSimilarity(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  if (intersection < 2) {
    return 0;
  }
  const smallerSize = Math.max(Math.min(left.size, right.size), 1);
  const unionSize = Math.max(new Set([...left, ...right]).size, 1);
  const overlap = intersection / smallerSize;
  const jaccard = intersection / unionSize;
  return Math.max(overlap, jaccard);
}

function uniqueItemsBySource<T extends { sourceName?: string; sourceUrl?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = sourceKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function countDistinctSources(items: Array<{ sourceName?: string; sourceUrl?: string }>): number {
  return new Set(items.map(sourceKey)).size;
}

function sourceKey(item: { sourceName?: string; sourceUrl?: string }): string {
  if (item.sourceUrl) {
    try {
      return new URL(item.sourceUrl).hostname.replace(/^www\./, "").toLocaleLowerCase();
    } catch {
      // Fall through to source name.
    }
  }
  return (item.sourceName ?? "unknown").trim().toLocaleLowerCase();
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function appendRankingReason(reason: string, addition: string): string {
  return reason ? `${reason}, ${addition}` : addition;
}

const TOPIC_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "this",
  "that",
  "into",
  "over",
  "about",
  "after",
  "before",
  "news",
  "update",
  "analysis",
  "report",
  "summary",
  "item",
  "said",
  "says",
  "will",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had"
]);

function buildNewsletterOutline(
  title: string,
  sections: Record<NewsletterSectionId, RankedNewsletterItem[]>
): NewsletterOutline {
  const groups = new Map<string, RankedNewsletterItem[]>();
  const seenItemIds = new Set<string>();

  for (const sectionId of sectionOrder()) {
    for (const item of sections[sectionId]) {
      if (seenItemIds.has(item.id)) {
        continue;
      }
      seenItemIds.add(item.id);
      const label = outlineLabel(item, sectionId);
      groups.set(label, [...(groups.get(label) ?? []), item]);
    }
  }

  return {
    title: `${title} 목차`,
    leadPrefix: "❙",
    briefPrefix: " ❙ 간추린",
    introEmoji: "☀️",
    quoteEmoji: "💬",
    groups: [...groups.entries()].map(([label, items]) => {
      const [lead, ...briefs] = items;
      return {
        label,
        leadItemId: lead?.id,
        leadTitle: lead?.title,
        leadImageUrl: lead?.imageUrl,
        briefItemIds: briefs.map((item) => item.id),
        briefTitles: briefs.map((item) => item.title)
      };
    })
  };
}

function outlineLabel(item: RankedNewsletterItem, sectionId: NewsletterSectionId): string {
  const [firstTag] = item.interestTags.map((tag) => tag.trim()).filter(Boolean);
  if (firstTag) {
    return firstTag;
  }
  if (item.type === "event") {
    return "일정";
  }
  if (item.type === "recommendation") {
    return "추천";
  }
  return sectionTitle(sectionId);
}

function buildEditorInstructions(
  template: NewsletterTemplate,
  tone: UserProfile["preferredTone"],
  formatPreference: NewsletterFormatPreference
): NewsletterEditorInstructions {
  return {
    outputLanguage: template.outputLanguage ?? "ko",
    outputFormat: template.outputFormat ?? "markdown",
    tone,
    length: formatPreference.length,
    edition: formatPreference.edition,
    editionPlan: resolveEditionPlan(formatPreference.edition),
    audience: template.audience,
    sectionOrder: template.sections.map((section) => section.id),
    layoutGuide: template.layoutGuide ?? template.sections.map((section) => section.title),
    styleGuide: [
      ...defaultStyleGuide(formatPreference),
      "뉴스레터 시작단에는 outline을 기반으로 목차를 먼저 제공한다.",
      "목차 대분류는 `❙ {카테고리}` 형식을 사용하고, 짧은 소식 묶음은 ` ❙ 간추린 {카테고리}` 형식을 사용한다.",
      "상단 인트로나 독자 질문/콜아웃에는 ☀️와 💬 이모지를 사용할 수 있지만 과도하게 반복하지 않는다.",
      ...(template.styleGuide ?? [])
    ],
    sectionInstructions: {
      ...Object.fromEntries(template.sections.map((section) => [section.id, section.description])),
      ...(template.sectionInstructions ?? {})
    },
    sourcePolicy: [
      "서버가 제공한 item, evidence, sourceUrl, date만 근거로 사용한다.",
      "각 주요 소식에는 가능하면 출처 링크를 유지한다.",
      "representativeImageUrl 또는 imageUrl이 있으면 대표 이미지 후보로 사용할 수 있다.",
      "evidence에 없는 사실, 날짜, 링크, 수치를 새로 만들지 않는다.",
      ...(template.sourcePolicy ?? [])
    ],
    forbiddenRules: [
      "[Page chunk x/y] 라벨은 최종 뉴스레터에 그대로 노출하지 않는다.",
      "확인되지 않은 사실을 추측으로 보강하지 않는다.",
      "빈 섹션을 억지로 채우지 않는다.",
      ...(template.forbiddenRules ?? [])
    ]
  };
}

function defaultStyleGuide(formatPreference: NewsletterFormatPreference): string[] {
  const lengthRule = formatPreference.length === "short"
    ? "짧고 압축적으로 작성한다."
    : formatPreference.length === "long"
      ? "맥락과 의미를 충분히 설명하되 근거 없는 확장은 하지 않는다."
      : "핵심 맥락을 간결하게 설명한다.";
  return [
    "최종 뉴스레터는 독자가 바로 읽을 수 있는 완성된 문장으로 작성한다.",
    lengthRule,
    ...editionStyleGuide(formatPreference.edition)
  ];
}

function takeBySection(
  items: RankedNewsletterItem[],
  template: NewsletterTemplate,
  sectionId: NewsletterSectionId,
  overrideLimit?: number
): RankedNewsletterItem[] {
  const limit = overrideLimit ?? template.sections.find((section) => section.id === sectionId)?.maxItems ?? 5;
  return items.slice(0, limit);
}

function resolveEditionPlan(edition: NewsletterEdition | undefined): NewsletterEditionPlan | undefined {
  if (!edition) {
    return undefined;
  }

  const plans: Record<NewsletterEdition, NewsletterEditionPlan> = {
    morning: {
      label: "아침용",
      longTopicCount: 1,
      shortArticleCount: 3,
      multiSourceTopicCount: 0,
      instructions: [
        "장문 top topic 1개를 먼저 배치한다.",
        "단문 기사는 2~3개만 간결하게 제공한다.",
        "출근 전 빠르게 읽을 수 있도록 전체 문장을 짧게 유지한다."
      ]
    },
    lunch: {
      label: "점심용",
      longTopicCount: 2,
      shortArticleCount: 5,
      multiSourceTopicCount: 0,
      instructions: [
        "장문 topic 2개를 중심으로 맥락과 의미를 설명한다.",
        "단문 기사는 최대 5개까지 제공한다.",
        "점심시간에 훑고 한두 주제를 깊게 읽을 수 있게 구성한다."
      ]
    },
    evening: {
      label: "저녁용",
      longTopicCount: 2,
      shortArticleCount: 5,
      multiSourceTopicCount: 1,
      instructions: [
        "장문 topic 2개를 충분히 설명한다.",
        "추가 장문 topic 1개는 같은 이슈에 대해 여러 출처의 관점을 비교한다.",
        "단문 기사는 최대 5개까지 제공한다.",
        "하루를 정리하는 느낌으로 배경, 파장, 다음 체크포인트를 포함한다."
      ]
    }
  };

  return plans[edition];
}

function editionStyleGuide(edition: NewsletterEdition | undefined): string[] {
  const plan = resolveEditionPlan(edition);
  if (!plan) {
    return [];
  }
  return [
    `뉴스레터 에디션은 ${plan.label}이다.`,
    `장문 topic ${plan.longTopicCount + plan.multiSourceTopicCount}개, 단문 기사 최대 ${plan.shortArticleCount}개를 기준으로 편집한다.`,
    ...plan.instructions
  ];
}

function sectionOrder(): NewsletterSectionId[] {
  return ["top_stories", "key_dates", "deep_dive", "recommendations"];
}

function sectionTitle(sectionId: NewsletterSectionId): string {
  return {
    top_stories: "오늘 주요 소식",
    key_dates: "주요 일정",
    deep_dive: "상세 해설",
    recommendations: "관련 추천"
  }[sectionId];
}

function buildTitle(interests: string[]): string {
  if (interests.length === 0) {
    return "맞춤 뉴스레터 초안";
  }
  return `${interests.join("/")} 뉴스레터 초안`;
}

function toHistoryEntry(draft: NewsletterDraft): NewsletterHistoryEntry {
  const selectedItems = Object.values(draft.sections).flat();
  return {
    id: draft.draftId,
    userId: draft.metadata.userId,
    userMessage: draft.metadata.userMessage,
    structuredRequest: {
      interests: draft.metadata.interests,
      regions: draft.metadata.regions,
      period: draft.metadata.period,
      tone: draft.metadata.tone,
      templateId: draft.metadata.templateId
    },
    generatedAt: draft.metadata.generatedAt,
    draftSummary: {
      title: draft.title,
      itemCount: selectedItems.length,
      topSources: draft.sources.map((source) => source.sourceName).slice(0, 5)
    }
  };
}
