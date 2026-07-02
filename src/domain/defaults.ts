import type {
  NewsletterFormatPreference,
  NewsletterTone,
  UserProfile,
  UserSchedule
} from "./types.js";

export const DEFAULT_TEMPLATE_ID = "default_weekly";

export const DEFAULT_USER_ID = "default";

export const DEFAULT_TONE: NewsletterTone = "friendly";

export const DEFAULT_SCHEDULE: UserSchedule = {
  frequency: "weekly",
  timezone: "Asia/Seoul"
};

export const DEFAULT_FORMAT: NewsletterFormatPreference = {
  length: "medium",
  includeCommentary: true,
  includeRecommendations: true
};

export function createDefaultProfile(userId: string, now = new Date()): UserProfile {
  return {
    userId,
    interests: [],
    regions: [],
    preferredTone: DEFAULT_TONE,
    schedule: DEFAULT_SCHEDULE,
    excludedKeywords: [],
    formatPreference: DEFAULT_FORMAT,
    updatedAt: now.toISOString()
  };
}
