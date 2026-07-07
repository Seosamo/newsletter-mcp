import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import type {
  InterestTagSetting,
  NewsletterHistoryEntry,
  NewsletterTemplate,
  UserProfile
} from "../src/domain/types.js";
import { PostgresStorage } from "../src/storage/PostgresStorage.js";

describe("PostgresStorage", () => {
  it("persists profiles, templates, category settings, and history by user", async () => {
    const pool = new MemoryPgExecutor();
    const storage = new PostgresStorage({
      pool,
      schema: "newsletter",
      runMigrations: true
    });
    const profile = makeProfile("oauth-user", ["anime"]);
    const template = makeTemplate("weekly");
    const setting: InterestTagSetting = {
      label: "Anime",
      aliases: ["Animation"],
      keywords: ["anime"],
      sourceHints: [],
      weight: 1.2,
      updatedAt: "2026-07-07T00:00:00.000Z"
    };
    const firstHistory = makeHistory("draft-1", "oauth-user", "2026-07-07T10:00:00.000Z");
    const secondHistory = makeHistory("draft-2", "oauth-user", "2026-07-07T11:00:00.000Z");
    const otherHistory = makeHistory("draft-3", "other-user", "2026-07-07T12:00:00.000Z");

    await storage.saveProfile(profile);
    await storage.upsertTemplate(template);
    await storage.upsertUserCategorySetting("oauth-user", setting);
    await storage.saveHistory(firstHistory);
    await storage.saveHistory(secondHistory);
    await storage.saveHistory(otherHistory);

    await expect(storage.getProfile("oauth-user")).resolves.toEqual(profile);
    await expect(storage.listProfiles()).resolves.toEqual([profile]);
    await expect(storage.getTemplate("weekly")).resolves.toEqual(template);
    await expect(storage.listTemplates()).resolves.toEqual([template]);
    await expect(storage.listUserCategorySettings("oauth-user")).resolves.toEqual([setting]);
    await expect(storage.listHistory("oauth-user", 1)).resolves.toEqual([secondHistory]);
    await expect(storage.listHistoryUsers()).resolves.toEqual(["oauth-user", "other-user"]);
    expect(pool.sql.some((query) => query.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  });

  it("rejects unsafe schema identifiers", () => {
    expect(() => new PostgresStorage({
      connectionString: "postgres://example",
      schema: "public;drop table users"
    })).toThrow("Invalid Postgres identifier");
  });
});

class MemoryPgExecutor {
  readonly sql: string[] = [];
  private readonly profiles = new Map<string, unknown>();
  private readonly templates = new Map<string, unknown>();
  private readonly categorySettings = new Map<string, Map<string, unknown>>();
  private readonly history = new Map<string, NewsletterHistoryEntry>();

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    this.sql.push(sql);
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_profiles")) {
      this.profiles.set(String(params[0]), JSON.parse(String(params[1])));
      return result([]);
    }
    if (normalized.includes("SELECT profile") && normalized.includes("newsletter_profiles") && normalized.includes("WHERE user_id")) {
      const profile = this.profiles.get(String(params[0]));
      return result(profile ? [{ profile }] as T[] : []);
    }
    if (normalized.includes("SELECT profile") && normalized.includes("newsletter_profiles")) {
      return result([...this.profiles.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, profile]) => ({ profile }) as T));
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_templates")) {
      this.templates.set(String(params[0]), JSON.parse(String(params[1])));
      return result([]);
    }
    if (normalized.includes("SELECT template") && normalized.includes("newsletter_templates") && normalized.includes("WHERE template_id")) {
      const template = this.templates.get(String(params[0]));
      return result(template ? [{ template }] as T[] : []);
    }
    if (normalized.includes("SELECT template") && normalized.includes("newsletter_templates")) {
      return result([...this.templates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, template]) => ({ template }) as T));
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_category_settings")) {
      const userId = String(params[0]);
      const labelKey = String(params[1]);
      const settings = this.categorySettings.get(userId) ?? new Map<string, unknown>();
      settings.set(labelKey, JSON.parse(String(params[2])));
      this.categorySettings.set(userId, settings);
      return result([]);
    }
    if (normalized.includes("SELECT setting") && normalized.includes("newsletter_category_settings")) {
      const settings = this.categorySettings.get(String(params[0])) ?? new Map<string, unknown>();
      return result([...settings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, setting]) => ({ setting }) as T));
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_history")) {
      this.history.set(String(params[0]), JSON.parse(String(params[3])) as NewsletterHistoryEntry);
      return result([]);
    }
    if (normalized.includes("SELECT entry") && normalized.includes("newsletter_history")) {
      const limit = typeof params[1] === "number" ? params[1] : undefined;
      const entries = [...this.history.values()]
        .filter((entry) => entry.userId === params[0])
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
        .slice(0, limit);
      return result(entries.map((entry) => ({ entry }) as T));
    }
    if (normalized.includes("SELECT DISTINCT user_id") && normalized.includes("newsletter_history")) {
      return result([...new Set([...this.history.values()].map((entry) => entry.userId))]
        .sort()
        .map((user_id) => ({ user_id }) as T));
    }

    return result([]);
  }
}

function result<T extends object>(rows: T[]): QueryResult<T> {
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

function makeProfile(userId: string, interests: string[]): UserProfile {
  return {
    userId,
    interests,
    regions: [],
    preferredTone: "friendly",
    schedule: {
      frequency: "weekly",
      timezone: "Asia/Seoul"
    },
    excludedKeywords: [],
    formatPreference: {
      length: "medium",
      includeCommentary: true,
      includeRecommendations: true
    },
    updatedAt: "2026-07-07T00:00:00.000Z"
  };
}

function makeTemplate(templateId: string): NewsletterTemplate {
  return {
    templateId,
    name: "Weekly",
    sections: [
      { id: "top_stories", title: "Top", description: "Top stories", maxItems: 5 },
      { id: "key_dates", title: "Dates", description: "Key dates", maxItems: 5 },
      { id: "deep_dive", title: "Deep", description: "Deep dive", maxItems: 1 },
      { id: "recommendations", title: "Recs", description: "Recommendations", maxItems: 5 }
    ]
  };
}

function makeHistory(id: string, userId: string, generatedAt: string): NewsletterHistoryEntry {
  return {
    id,
    userId,
    userMessage: "make newsletter",
    structuredRequest: {
      interests: ["anime"],
      regions: [],
      period: {
        start: "2026-07-01",
        end: "2026-07-07"
      },
      tone: "friendly",
      templateId: "weekly"
    },
    generatedAt,
    draftSummary: {
      title: id,
      itemCount: 1,
      topSources: ["Example"]
    }
  };
}
