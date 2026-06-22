import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  InterestTagSetting,
  NewsletterHistoryEntry,
  NewsletterTemplate,
  UserProfile
} from "../domain/types.js";
import type { NewsletterStorage } from "./NewsletterStorage.js";

type ProfilesFile = {
  profiles: UserProfile[];
};

type TemplatesFile = {
  templates: NewsletterTemplate[];
};

type CategorySettingsFile = {
  settings: Record<string, InterestTagSetting[]>;
};

type HistoryFile = {
  history: NewsletterHistoryEntry[];
};

export class JsonFileStorage implements NewsletterStorage {
  constructor(private readonly dataDir: string) {}

  async getProfile(userId: string): Promise<UserProfile | null> {
    const data = await this.readJson<ProfilesFile>("profiles.json", { profiles: [] });
    return data.profiles.find((profile) => profile.userId === userId) ?? null;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const data = await this.readJson<ProfilesFile>("profiles.json", { profiles: [] });
    const index = data.profiles.findIndex((existing) => existing.userId === profile.userId);
    if (index >= 0) {
      data.profiles[index] = profile;
    } else {
      data.profiles.push(profile);
    }
    await this.writeJson("profiles.json", data);
  }

  async listProfiles(): Promise<UserProfile[]> {
    const data = await this.readJson<ProfilesFile>("profiles.json", { profiles: [] });
    return data.profiles;
  }

  async listTemplates(): Promise<NewsletterTemplate[]> {
    const data = await this.readJson<TemplatesFile>("templates.json", { templates: [] });
    return data.templates;
  }

  async getTemplate(templateId: string): Promise<NewsletterTemplate | null> {
    const templates = await this.listTemplates();
    return templates.find((template) => template.templateId === templateId) ?? null;
  }

  async listUserCategorySettings(userId: string): Promise<InterestTagSetting[]> {
    const data = await this.readJson<CategorySettingsFile>("categorySettings.json", { settings: {} });
    return data.settings[userId] ?? [];
  }

  async upsertUserCategorySetting(userId: string, setting: InterestTagSetting): Promise<void> {
    const data = await this.readJson<CategorySettingsFile>("categorySettings.json", { settings: {} });
    const settings = data.settings[userId] ?? [];
    const targetLabel = setting.label.trim().toLocaleLowerCase();
    const index = settings.findIndex((existing) => existing.label.trim().toLocaleLowerCase() === targetLabel);
    if (index >= 0) {
      settings[index] = setting;
    } else {
      settings.push(setting);
    }
    data.settings[userId] = settings;
    await this.writeJson("categorySettings.json", data);
  }

  async saveHistory(entry: NewsletterHistoryEntry): Promise<void> {
    const data = await this.readJson<HistoryFile>("history.json", { history: [] });
    data.history.push(entry);
    await this.writeJson("history.json", data);
  }

  async listHistory(userId: string, limit?: number): Promise<NewsletterHistoryEntry[]> {
    const data = await this.readJson<HistoryFile>("history.json", { history: [] });
    const entries = data.history
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  }

  async listHistoryUsers(): Promise<string[]> {
    const data = await this.readJson<HistoryFile>("history.json", { history: [] });
    return [...new Set(data.history.map((entry) => entry.userId))];
  }

  private async readJson<T>(fileName: string, fallback: T): Promise<T> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isMissingFileError(error)) {
        await this.writeJson(fileName, fallback);
        return fallback;
      }
      throw error;
    }
  }

  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, fileName);
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
