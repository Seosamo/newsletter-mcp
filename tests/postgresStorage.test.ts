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
    expect(pool.sql.some((query) => query.includes("newsletter_profile_interests"))).toBe(true);
    expect(pool.sql.some((query) => query.includes("USING GIN"))).toBe(true);
    expect(pool.sql.some((query) => /\b(?:profile|template|setting|entry)\s+JSONB\b/i.test(query))).toBe(false);
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
  private readonly profiles = new Map<string, Record<string, unknown>>();
  private readonly profileLists = {
    newsletter_profile_interests: new Map<string, Array<{ value: string; position: number }>>(),
    newsletter_profile_regions: new Map<string, Array<{ value: string; position: number }>>(),
    newsletter_profile_excluded_keywords: new Map<string, Array<{ value: string; position: number }>>()
  };
  private readonly profileSources = new Map<string, Array<Record<string, unknown>>>();
  private readonly templates = new Map<string, Record<string, unknown>>();
  private readonly templateSections = new Map<string, Array<Record<string, unknown>>>();
  private readonly categorySettings = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly categorySources = new Map<string, Array<Record<string, unknown>>>();
  private readonly history = new Map<string, Record<string, unknown>>();

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    this.sql.push(sql);
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.includes("information_schema.")) {
      return result([{ exists: false }] as T[]);
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_profiles")) {
      this.profiles.set(String(params[0]), {
        user_id: params[0],
        preferred_tone: params[1],
        schedule_frequency: params[2],
        schedule_timezone: params[3],
        schedule_preferred_day: params[4],
        schedule_preferred_time: params[5],
        format_length: params[6],
        format_edition: params[7],
        include_commentary: params[8],
        include_recommendations: params[9],
        updated_at: params[10]
      });
      return result([]);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_profiles") && normalized.includes("WHERE user_id")) {
      const profile = this.profiles.get(String(params[0]));
      return result(profile ? [profile as T] : []);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_profiles")) {
      return result([...this.profiles.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, profile]) => profile as T));
    }

    const profileList = Object.entries(this.profileLists).find(([table]) => normalized.includes(table));
    if (profileList) {
      const [, valuesByUser] = profileList;
      if (normalized.startsWith("DELETE")) {
        valuesByUser.delete(String(params[0]));
        return result([]);
      }
      if (normalized.startsWith("INSERT")) {
        const values = valuesByUser.get(String(params[0])) ?? [];
        values.push({ value: String(params[2]), position: Number(params[3]) });
        valuesByUser.set(String(params[0]), values);
        return result([]);
      }
      if (normalized.startsWith("SELECT")) {
        const valueColumn = profileList[0] === "newsletter_profile_interests"
          ? "interest"
          : profileList[0] === "newsletter_profile_regions" ? "region" : "keyword";
        return result((valuesByUser.get(String(params[0])) ?? [])
          .sort((left, right) => left.position - right.position)
          .map((item) => ({ [valueColumn]: item.value }) as T));
      }
    }

    if (normalized.includes("newsletter_profile_source_preferences")) {
      if (normalized.startsWith("DELETE")) {
        this.profileSources.delete(String(params[0]));
        return result([]);
      }
      if (normalized.startsWith("INSERT")) {
        const sources = this.profileSources.get(String(params[0])) ?? [];
        sources.push({
          label: params[2], domains: params[3], rss_urls: params[4], query_hints: params[5],
          weight: params[6], enabled: params[7], position: params[8]
        });
        this.profileSources.set(String(params[0]), sources);
        return result([]);
      }
      if (normalized.startsWith("SELECT")) {
        return result((this.profileSources.get(String(params[0])) ?? [])
          .sort((left, right) => Number(left.position) - Number(right.position)) as T[]);
      }
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_templates")) {
      this.templates.set(String(params[0]), {
        template_id: params[0], name: params[1], description: params[2], output_language: params[3],
        output_format: params[4], audience: params[5], style_guide: params[6], layout_guide: params[7],
        source_policy: params[8], forbidden_rules: params[9]
      });
      return result([]);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_templates") && normalized.includes("WHERE template_id")) {
      const template = this.templates.get(String(params[0]));
      return result(template ? [template as T] : []);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_templates")) {
      return result([...this.templates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, template]) => template as T));
    }
    if (normalized.includes("newsletter_template_sections")) {
      if (normalized.startsWith("DELETE")) {
        this.templateSections.delete(String(params[0]));
        return result([]);
      }
      if (normalized.startsWith("INSERT")) {
        const sections = this.templateSections.get(String(params[0])) ?? [];
        sections.push({
          id: params[1], title: params[2], description: params[3], max_items: params[4],
          instruction: params[5], position: params[6]
        });
        this.templateSections.set(String(params[0]), sections);
        return result([]);
      }
      if (normalized.startsWith("SELECT")) {
        return result((this.templateSections.get(String(params[0])) ?? [])
          .sort((left, right) => Number(left.position) - Number(right.position)) as T[]);
      }
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_category_settings")) {
      const userId = String(params[0]);
      const labelKey = String(params[1]);
      const settings = this.categorySettings.get(userId) ?? new Map<string, Record<string, unknown>>();
      settings.set(labelKey, {
        label_key: labelKey, label: params[2], aliases: params[3], keywords: params[4],
        source_hints: params[5], weight: params[6], updated_at: params[7]
      });
      this.categorySettings.set(userId, settings);
      return result([]);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_category_settings")) {
      const settings = this.categorySettings.get(String(params[0])) ?? new Map<string, Record<string, unknown>>();
      return result([...settings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, setting]) => setting as T));
    }
    if (normalized.includes("newsletter_category_source_preferences")) {
      const ownerKey = `${String(params[0])}\u0000${String(params[1])}`;
      if (normalized.startsWith("DELETE")) {
        this.categorySources.delete(ownerKey);
        return result([]);
      }
      if (normalized.startsWith("INSERT")) {
        const sources = this.categorySources.get(ownerKey) ?? [];
        sources.push({
          label: params[3], domains: params[4], rss_urls: params[5], query_hints: params[6],
          weight: params[7], enabled: params[8], position: params[9]
        });
        this.categorySources.set(ownerKey, sources);
        return result([]);
      }
      if (normalized.startsWith("SELECT")) {
        return result((this.categorySources.get(ownerKey) ?? [])
          .sort((left, right) => Number(left.position) - Number(right.position)) as T[]);
      }
    }

    if (normalized.includes("INSERT INTO") && normalized.includes("newsletter_history")) {
      this.history.set(String(params[0]), {
        id: params[0], user_id: params[1], user_message: params[2], interests: params[3], regions: params[4],
        period_start: params[5], period_end: params[6], tone: params[7], template_id: params[8],
        generated_at: params[9], title: params[10], item_count: params[11], top_sources: params[12]
      });
      return result([]);
    }
    if (normalized.includes("SELECT *") && normalized.includes("newsletter_history")) {
      const limit = typeof params[1] === "number" ? params[1] : undefined;
      const entries = [...this.history.values()]
        .filter((entry) => entry.user_id === params[0])
        .sort((left, right) => String(right.generated_at).localeCompare(String(left.generated_at)))
        .slice(0, limit);
      return result(entries as T[]);
    }
    if (normalized.includes("SELECT DISTINCT user_id") && normalized.includes("newsletter_history")) {
      return result([...new Set([...this.history.values()].map((entry) => String(entry.user_id)))]
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
