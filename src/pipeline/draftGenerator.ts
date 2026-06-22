import { randomUUID } from "node:crypto";
import { createDefaultProfile, DEFAULT_TEMPLATE_ID } from "../domain/defaults.js";
import type {
  ContentSearchInput,
  GenerateNewsletterDraftInput,
  InterestTagSetting,
  NewsletterDraft,
  NewsletterFormatPreference,
  NewsletterHistoryEntry,
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
    const profile = (await this.storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId, now);
    const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
    const template = await this.resolveTemplate(templateId);
    const settings = await this.storage.listUserCategorySettings(input.userId);

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
      userId: input.userId,
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
    const ranked = rankItems(filtered, interests, regions, matchedSettings, period);
    const sections = mapSections(ranked, template, formatPreference);
    const selectedItems = Object.values(sections).flat();

    if (selectedItems.length === 0) {
      warnings.push("No content items matched the request after filtering and ranking.");
    }

    const generatedAt = now.toISOString();
    const draft: NewsletterDraft = {
      draftId: `draft_${randomUUID()}`,
      title: buildTitle(interests),
      metadata: {
        userId: input.userId,
        userMessage: input.userMessage,
        interests,
        regions,
        period,
        tone,
        templateId,
        generatedAt
      },
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

function takeBySection(
  items: RankedNewsletterItem[],
  template: NewsletterTemplate,
  sectionId: NewsletterSectionId
): RankedNewsletterItem[] {
  const limit = template.sections.find((section) => section.id === sectionId)?.maxItems ?? 5;
  return items.slice(0, limit);
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
