export type NewsletterTone = "casual" | "professional" | "friendly" | "analytical";

export type NewsletterFrequency = "daily" | "weekly" | "monthly";

export type NewsletterLength = "short" | "medium" | "long";

export type NewsletterFormatPreference = {
  length: NewsletterLength;
  includeCommentary: boolean;
  includeRecommendations: boolean;
};

export type UserSchedule = {
  frequency: NewsletterFrequency;
  timezone: string;
  preferredDay?: string;
  preferredTime?: string;
};

export type UserProfile = {
  userId: string;
  interests: string[];
  regions: string[];
  preferredTone: NewsletterTone;
  schedule: UserSchedule;
  excludedKeywords: string[];
  formatPreference: NewsletterFormatPreference;
  updatedAt: string;
};

export type InterestTagSetting = {
  label: string;
  aliases: string[];
  keywords: string[];
  sourceHints: string[];
  weight: number;
  updatedAt: string;
};

export type NewsletterSectionId =
  | "top_stories"
  | "key_dates"
  | "deep_dive"
  | "recommendations";

export type NewsletterSectionTemplate = {
  id: NewsletterSectionId;
  title: string;
  description: string;
  maxItems?: number;
};

export type NewsletterTemplate = {
  templateId: string;
  name: string;
  description?: string;
  outputLanguage?: string;
  outputFormat?: string;
  audience?: string;
  styleGuide?: string[];
  layoutGuide?: string[];
  sourcePolicy?: string[];
  forbiddenRules?: string[];
  sectionInstructions?: Partial<Record<NewsletterSectionId, string>>;
  sections: NewsletterSectionTemplate[];
};

export type NewsletterEditorInstructions = {
  outputLanguage: string;
  outputFormat: string;
  tone: NewsletterTone;
  length: NewsletterLength;
  audience?: string;
  sectionOrder: NewsletterSectionId[];
  layoutGuide: string[];
  styleGuide: string[];
  sectionInstructions: Partial<Record<NewsletterSectionId, string>>;
  sourcePolicy: string[];
  forbiddenRules: string[];
};

export type NewsletterOutlineGroup = {
  label: string;
  leadItemId?: string;
  leadTitle?: string;
  leadImageUrl?: string;
  briefItemIds: string[];
  briefTitles: string[];
};

export type NewsletterOutline = {
  title: string;
  leadPrefix: string;
  briefPrefix: string;
  introEmoji: string;
  quoteEmoji: string;
  groups: NewsletterOutlineGroup[];
};

export type ContentType = "news" | "event" | "recommendation";

export type ContentItem = {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  url?: string;
  sourceName?: string;
  imageUrl?: string;
  imageAlt?: string;
  publishedAt?: string;
  eventDate?: string;
  interestTags: string[];
  regions: string[];
  keywords: string[];
  evidence: string[];
  sourceReliability?: number;
};

export type ContentSearchInput = {
  userId: string;
  interests: string[];
  regions: string[];
  keywords: string[];
  sourceHints: string[];
  period: Period;
  excludedKeywords: string[];
};

export type ContentProviderResult = {
  items: ContentItem[];
  warnings: string[];
};

export type Period = {
  start: string;
  end: string;
};

export type GenerateNewsletterDraftInput = {
  userId?: string;
  userMessage: string;
  interests?: string[];
  regions?: string[];
  period?: Period;
  tone?: NewsletterTone;
  format?: Partial<NewsletterFormatPreference>;
  templateId?: string;
};

export type RankedNewsletterItem = {
  id: string;
  title: string;
  summary: string;
  type: ContentType;
  interestTags: string[];
  region?: string;
  date?: string;
  sourceName?: string;
  sourceUrl?: string;
  imageUrl?: string;
  imageAlt?: string;
  importanceScore: number;
  rankingReason: string;
  evidence: string[];
  selectedEvidence?: string[];
};

export type NewsletterDraft = {
  draftId: string;
  title: string;
  metadata: {
    userId: string;
    userMessage: string;
    interests: string[];
    regions: string[];
    period: Period;
    tone: NewsletterTone;
    templateId: string;
    generatedAt: string;
  };
  editorInstructions: NewsletterEditorInstructions;
  outline: NewsletterOutline;
  sections: Record<NewsletterSectionId, RankedNewsletterItem[]>;
  sources: SourceRef[];
  warnings: string[];
};

export type SourceRef = {
  sourceName: string;
  sourceUrl?: string;
  itemIds: string[];
};

export type NewsletterHistoryEntry = {
  id: string;
  userId: string;
  userMessage: string;
  structuredRequest: {
    interests: string[];
    regions: string[];
    period: Period;
    tone: NewsletterTone;
    templateId: string;
  };
  generatedAt: string;
  draftSummary: {
    title: string;
    itemCount: number;
    topSources: string[];
  };
};
