import type {
  InterestTagSetting,
  NewsletterHistoryEntry,
  NewsletterTemplate,
  UserProfile
} from "../domain/types.js";

export interface NewsletterStorage {
  getProfile(userId: string): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<void>;
  listProfiles(): Promise<UserProfile[]>;

  listTemplates(): Promise<NewsletterTemplate[]>;
  getTemplate(templateId: string): Promise<NewsletterTemplate | null>;

  listUserCategorySettings(userId: string): Promise<InterestTagSetting[]>;
  upsertUserCategorySetting(userId: string, setting: InterestTagSetting): Promise<void>;

  saveHistory(entry: NewsletterHistoryEntry): Promise<void>;
  listHistory(userId: string, limit?: number): Promise<NewsletterHistoryEntry[]>;
  listHistoryUsers(): Promise<string[]>;
}
