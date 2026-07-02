import { randomUUID } from "node:crypto";
import { createDefaultProfile, DEFAULT_TEMPLATE_ID, DEFAULT_USER_ID } from "../domain/defaults.js";
import type {
  ContentSearchInput,
  GenerateNewsletterDraftInput,
  InterestTagSetting,
  NewsletterDraft,
  NewsletterEditorInstructions,
  NewsletterFormatPreference,
  NewsletterHistoryEntry,
  NewsletterOutline,
  NewsletterSectionId,
  NewsletterTemplate,
  RankedNewsletterItem,
  UserProfile
} from "../domain/types.js";
import type { ContentProvider } from "../providers/ContentProvider.js";
import type { NewsletterStorage } from "../storage/NewsletterStorage.js";
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
      period,
      excludedKeywords: profile.excludedKeywords
    };

    const providerResults = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          return await provider.search(searchInput);
        } catch (error) {
          return {
            items: [],
            warnings: [`${provider.name} failed: ${error instanceof Error ? error.message : String(error)}`]
          };
        }
      })
    );

    const collected = providerResults.flatMap((result) => result.items);
    warnings.push(...providerResults.flatMap((result) => result.warnings));

    const filtered = filterOldEvents(
      deduplicateItems(filterExcludedKeywords(collected, profile.excludedKeywords)),
      period
    );
    const ranked = capSelectedEvidenceBudget(
      rankItems(filtered, interests, regions, matchedSettings, period),
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

function mapSections(
  ranked: RankedNewsletterItem[],
  template: NewsletterTemplate,
  formatPreference: NewsletterFormatPreference
): Record<NewsletterSectionId, RankedNewsletterItem[]> {
  return {
    top_stories: takeBySection(ranked.filter((item) => item.type === "news"), template, "top_stories"),
    key_dates: takeBySection(ranked.filter((item) => item.type === "event"), template, "key_dates"),
    deep_dive: formatPreference.includeCommentary
      ? takeBySection(ranked.filter((item) => item.type === "news"), template, "deep_dive")
      : [],
    recommendations: formatPreference.includeRecommendations
      ? takeBySection(ranked.filter((item) => item.type === "recommendation"), template, "recommendations")
      : []
  };
}

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
    lengthRule
  ];
}

function takeBySection(
  items: RankedNewsletterItem[],
  template: NewsletterTemplate,
  sectionId: NewsletterSectionId
): RankedNewsletterItem[] {
  const limit = template.sections.find((section) => section.id === sectionId)?.maxItems ?? 5;
  return items.slice(0, limit);
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
