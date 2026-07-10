import { Pool, type PoolConfig, type QueryResult } from "pg";
import type {
  InterestTagSetting,
  NewsletterHistoryEntry,
  NewsletterTemplate,
  SourcePreference,
  UserProfile
} from "../domain/types.js";
import type { NewsletterStorage } from "./NewsletterStorage.js";

type PgClient = {
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};

type PgExecutor = {
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect?: () => Promise<PgClient>;
  end?: () => Promise<void>;
};

export type PostgresStorageOptions = {
  connectionString?: string;
  schema?: string;
  ssl?: PoolConfig["ssl"];
  runMigrations?: boolean;
  pool?: PgExecutor;
};

type ProfileRow = {
  user_id: string;
  preferred_tone: UserProfile["preferredTone"];
  schedule_frequency: UserProfile["schedule"]["frequency"];
  schedule_timezone: string;
  schedule_preferred_day: string | null;
  schedule_preferred_time: string | null;
  format_length: UserProfile["formatPreference"]["length"];
  format_edition: UserProfile["formatPreference"]["edition"] | null;
  include_commentary: boolean;
  include_recommendations: boolean;
  updated_at: Date | string;
};

type SourcePreferenceRow = {
  label: string;
  domains: string[];
  rss_urls: string[];
  query_hints: string[];
  weight: number | string;
  enabled: boolean;
};

type CategorySettingRow = {
  label: string;
  label_key: string;
  aliases: string[];
  keywords: string[];
  source_hints: string[];
  weight: number | string;
  updated_at: Date | string;
};

type TemplateRow = {
  template_id: string;
  name: string;
  description: string | null;
  output_language: string | null;
  output_format: string | null;
  audience: string | null;
  style_guide: string[];
  layout_guide: string[];
  source_policy: string[];
  forbidden_rules: string[];
};

type TemplateSectionRow = {
  id: NewsletterTemplate["sections"][number]["id"];
  title: string;
  description: string;
  max_items: number | null;
  instruction: string | null;
};

type HistoryRow = {
  id: string;
  user_id: string;
  user_message: string;
  interests: string[];
  regions: string[];
  period_start: Date | string;
  period_end: Date | string;
  tone: NewsletterHistoryEntry["structuredRequest"]["tone"];
  template_id: string;
  generated_at: Date | string;
  title: string;
  item_count: number;
  top_sources: string[];
};

export class PostgresStorage implements NewsletterStorage {
  private readonly pool: PgExecutor;
  private readonly schemaName: string;
  private readonly runMigrations: boolean;
  private migration?: Promise<void>;

  constructor(options: PostgresStorageOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error("PostgresStorage requires a connectionString or pool.");
    }

    this.schemaName = validateIdentifier(options.schema ?? "public");
    this.runMigrations = options.runMigrations ?? true;
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString,
      ssl: options.ssl
    });
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    await this.ensureReady();
    const result = await this.pool.query<ProfileRow>(
      `SELECT * FROM ${this.table("newsletter_profiles")} WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? this.hydrateProfile(result.rows[0]) : null;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    await this.ensureReady();
    await this.withTransaction(async (db) => {
      await db.query(
        `
          INSERT INTO ${this.table("newsletter_profiles")} (
            user_id, preferred_tone, schedule_frequency, schedule_timezone,
            schedule_preferred_day, schedule_preferred_time, format_length,
            format_edition, include_commentary, include_recommendations, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
          ON CONFLICT (user_id) DO UPDATE SET
            preferred_tone = EXCLUDED.preferred_tone,
            schedule_frequency = EXCLUDED.schedule_frequency,
            schedule_timezone = EXCLUDED.schedule_timezone,
            schedule_preferred_day = EXCLUDED.schedule_preferred_day,
            schedule_preferred_time = EXCLUDED.schedule_preferred_time,
            format_length = EXCLUDED.format_length,
            format_edition = EXCLUDED.format_edition,
            include_commentary = EXCLUDED.include_commentary,
            include_recommendations = EXCLUDED.include_recommendations,
            updated_at = EXCLUDED.updated_at
        `,
        [
          profile.userId,
          profile.preferredTone,
          profile.schedule.frequency,
          profile.schedule.timezone,
          profile.schedule.preferredDay ?? null,
          profile.schedule.preferredTime ?? null,
          profile.formatPreference.length,
          profile.formatPreference.edition ?? null,
          profile.formatPreference.includeCommentary,
          profile.formatPreference.includeRecommendations,
          profile.updatedAt
        ]
      );
      await this.replaceProfileValues(db, "newsletter_profile_interests", "interest_key", "interest", profile.userId, profile.interests);
      await this.replaceProfileValues(db, "newsletter_profile_regions", "region_key", "region", profile.userId, profile.regions);
      await this.replaceProfileValues(db, "newsletter_profile_excluded_keywords", "keyword_key", "keyword", profile.userId, profile.excludedKeywords);
      await this.replaceProfileSources(db, profile.userId, profile.sourcePreferences ?? []);
    });
  }

  async listProfiles(): Promise<UserProfile[]> {
    await this.ensureReady();
    const result = await this.pool.query<ProfileRow>(
      `SELECT * FROM ${this.table("newsletter_profiles")} ORDER BY user_id`
    );
    return Promise.all(result.rows.map((row) => this.hydrateProfile(row)));
  }

  async listTemplates(): Promise<NewsletterTemplate[]> {
    await this.ensureReady();
    const result = await this.pool.query<TemplateRow>(
      `SELECT * FROM ${this.table("newsletter_templates")} ORDER BY template_id`
    );
    return Promise.all(result.rows.map((row) => this.hydrateTemplate(row)));
  }

  async getTemplate(templateId: string): Promise<NewsletterTemplate | null> {
    await this.ensureReady();
    const result = await this.pool.query<TemplateRow>(
      `SELECT * FROM ${this.table("newsletter_templates")} WHERE template_id = $1`,
      [templateId]
    );
    return result.rows[0] ? this.hydrateTemplate(result.rows[0]) : null;
  }

  async upsertTemplate(template: NewsletterTemplate): Promise<void> {
    await this.ensureReady();
    await this.withTransaction(async (db) => {
      await db.query(
        `
          INSERT INTO ${this.table("newsletter_templates")} (
            template_id, name, description, output_language, output_format, audience,
            style_guide, layout_guide, source_policy, forbidden_rules, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::text[], $10::text[], NOW())
          ON CONFLICT (template_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            output_language = EXCLUDED.output_language,
            output_format = EXCLUDED.output_format,
            audience = EXCLUDED.audience,
            style_guide = EXCLUDED.style_guide,
            layout_guide = EXCLUDED.layout_guide,
            source_policy = EXCLUDED.source_policy,
            forbidden_rules = EXCLUDED.forbidden_rules,
            updated_at = NOW()
        `,
        [
          template.templateId,
          template.name,
          template.description ?? null,
          template.outputLanguage ?? null,
          template.outputFormat ?? null,
          template.audience ?? null,
          template.styleGuide ?? [],
          template.layoutGuide ?? [],
          template.sourcePolicy ?? [],
          template.forbiddenRules ?? []
        ]
      );
      await db.query(`DELETE FROM ${this.table("newsletter_template_sections")} WHERE template_id = $1`, [template.templateId]);
      for (const [position, section] of template.sections.entries()) {
        await db.query(
          `
            INSERT INTO ${this.table("newsletter_template_sections")} (
              template_id, section_id, title, description, max_items, instruction, position
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            template.templateId,
            section.id,
            section.title,
            section.description,
            section.maxItems ?? null,
            template.sectionInstructions?.[section.id] ?? null,
            position
          ]
        );
      }
    });
  }

  async listUserCategorySettings(userId: string): Promise<InterestTagSetting[]> {
    await this.ensureReady();
    const result = await this.pool.query<CategorySettingRow>(
      `SELECT * FROM ${this.table("newsletter_category_settings")} WHERE user_id = $1 ORDER BY label_key`,
      [userId]
    );
    return Promise.all(result.rows.map(async (row) => {
      const sourcePreferences = await this.loadCategorySources(userId, row.label_key);
      return {
        label: row.label,
        aliases: row.aliases ?? [],
        keywords: row.keywords ?? [],
        sourceHints: row.source_hints ?? [],
        ...(sourcePreferences.length > 0 ? { sourcePreferences } : {}),
        weight: Number(row.weight),
        updatedAt: toIsoString(row.updated_at)
      };
    }));
  }

  async upsertUserCategorySetting(userId: string, setting: InterestTagSetting): Promise<void> {
    await this.ensureReady();
    const labelKey = normalizeKey(setting.label);
    await this.withTransaction(async (db) => {
      await db.query(
        `
          INSERT INTO ${this.table("newsletter_category_settings")} (
            user_id, label_key, label, aliases, keywords, source_hints, weight, updated_at
          ) VALUES ($1, $2, $3, $4::text[], $5::text[], $6::text[], $7, $8::timestamptz)
          ON CONFLICT (user_id, label_key) DO UPDATE SET
            label = EXCLUDED.label,
            aliases = EXCLUDED.aliases,
            keywords = EXCLUDED.keywords,
            source_hints = EXCLUDED.source_hints,
            weight = EXCLUDED.weight,
            updated_at = EXCLUDED.updated_at
        `,
        [userId, labelKey, setting.label, setting.aliases, setting.keywords, setting.sourceHints, setting.weight, setting.updatedAt]
      );
      await db.query(
        `DELETE FROM ${this.table("newsletter_category_source_preferences")} WHERE user_id = $1 AND category_label_key = $2`,
        [userId, labelKey]
      );
      for (const [position, preference] of (setting.sourcePreferences ?? []).entries()) {
        await this.insertSourcePreference(db, "newsletter_category_source_preferences", [userId, labelKey], preference, position);
      }
    });
  }

  async saveHistory(entry: NewsletterHistoryEntry): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `
        INSERT INTO ${this.table("newsletter_history")} (
          id, user_id, user_message, interests, regions, period_start, period_end,
          tone, template_id, generated_at, title, item_count, top_sources
        ) VALUES (
          $1, $2, $3, $4::text[], $5::text[], $6::date, $7::date,
          $8, $9, $10::timestamptz, $11, $12, $13::text[]
        )
        ON CONFLICT (id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          user_message = EXCLUDED.user_message,
          interests = EXCLUDED.interests,
          regions = EXCLUDED.regions,
          period_start = EXCLUDED.period_start,
          period_end = EXCLUDED.period_end,
          tone = EXCLUDED.tone,
          template_id = EXCLUDED.template_id,
          generated_at = EXCLUDED.generated_at,
          title = EXCLUDED.title,
          item_count = EXCLUDED.item_count,
          top_sources = EXCLUDED.top_sources
      `,
      [
        entry.id,
        entry.userId,
        entry.userMessage,
        entry.structuredRequest.interests,
        entry.structuredRequest.regions,
        entry.structuredRequest.period.start,
        entry.structuredRequest.period.end,
        entry.structuredRequest.tone,
        entry.structuredRequest.templateId,
        entry.generatedAt,
        entry.draftSummary.title,
        entry.draftSummary.itemCount,
        entry.draftSummary.topSources
      ]
    );
  }

  async listHistory(userId: string, limit?: number): Promise<NewsletterHistoryEntry[]> {
    await this.ensureReady();
    const params: unknown[] = [userId];
    const limitClause = typeof limit === "number" ? "LIMIT $2" : "";
    if (typeof limit === "number") {
      params.push(limit);
    }
    const result = await this.pool.query<HistoryRow>(
      `
        SELECT * FROM ${this.table("newsletter_history")}
        WHERE user_id = $1
        ORDER BY generated_at DESC
        ${limitClause}
      `,
      params
    );
    return result.rows.map(toHistoryEntry);
  }

  async listHistoryUsers(): Promise<string[]> {
    await this.ensureReady();
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM ${this.table("newsletter_history")} ORDER BY user_id`
    );
    return result.rows.map((row) => row.user_id);
  }

  private async hydrateProfile(row: ProfileRow): Promise<UserProfile> {
    const [interests, regions, excludedKeywords, sourcePreferences] = await Promise.all([
      this.loadProfileValues("newsletter_profile_interests", "interest", row.user_id),
      this.loadProfileValues("newsletter_profile_regions", "region", row.user_id),
      this.loadProfileValues("newsletter_profile_excluded_keywords", "keyword", row.user_id),
      this.loadProfileSources(row.user_id)
    ]);
    return {
      userId: row.user_id,
      interests,
      regions,
      preferredTone: row.preferred_tone,
      schedule: {
        frequency: row.schedule_frequency,
        timezone: row.schedule_timezone,
        ...(row.schedule_preferred_day ? { preferredDay: row.schedule_preferred_day } : {}),
        ...(row.schedule_preferred_time ? { preferredTime: row.schedule_preferred_time } : {})
      },
      excludedKeywords,
      formatPreference: {
        length: row.format_length,
        includeCommentary: row.include_commentary,
        includeRecommendations: row.include_recommendations,
        ...(row.format_edition ? { edition: row.format_edition } : {})
      },
      ...(sourcePreferences.length > 0 ? { sourcePreferences } : {}),
      updatedAt: toIsoString(row.updated_at)
    };
  }

  private async hydrateTemplate(row: TemplateRow): Promise<NewsletterTemplate> {
    const result = await this.pool.query<TemplateSectionRow>(
      `
        SELECT section_id AS id, title, description, max_items, instruction
        FROM ${this.table("newsletter_template_sections")}
        WHERE template_id = $1
        ORDER BY position
      `,
      [row.template_id]
    );
    const sectionInstructions = Object.fromEntries(result.rows
      .filter((section) => Boolean(section.instruction))
      .map((section) => [section.id, section.instruction as string]));
    return {
      templateId: row.template_id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.output_language ? { outputLanguage: row.output_language } : {}),
      ...(row.output_format ? { outputFormat: row.output_format } : {}),
      ...(row.audience ? { audience: row.audience } : {}),
      ...((row.style_guide?.length ?? 0) > 0 ? { styleGuide: row.style_guide } : {}),
      ...((row.layout_guide?.length ?? 0) > 0 ? { layoutGuide: row.layout_guide } : {}),
      ...((row.source_policy?.length ?? 0) > 0 ? { sourcePolicy: row.source_policy } : {}),
      ...((row.forbidden_rules?.length ?? 0) > 0 ? { forbiddenRules: row.forbidden_rules } : {}),
      ...(Object.keys(sectionInstructions).length > 0 ? { sectionInstructions } : {}),
      sections: result.rows.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        ...(section.max_items === null ? {} : { maxItems: Number(section.max_items) })
      }))
    };
  }

  private async loadProfileValues(table: string, valueColumn: string, userId: string): Promise<string[]> {
    const result = await this.pool.query<Record<string, string>>(
      `SELECT ${this.ident(valueColumn)} FROM ${this.table(table)} WHERE user_id = $1 ORDER BY position`,
      [userId]
    );
    return result.rows.map((row) => row[valueColumn]);
  }

  private async loadProfileSources(userId: string): Promise<SourcePreference[]> {
    const result = await this.pool.query<SourcePreferenceRow>(
      `SELECT label, domains, rss_urls, query_hints, weight, enabled FROM ${this.table("newsletter_profile_source_preferences")} WHERE user_id = $1 ORDER BY position`,
      [userId]
    );
    return result.rows.map(toSourcePreference);
  }

  private async loadCategorySources(userId: string, labelKey: string): Promise<SourcePreference[]> {
    const result = await this.pool.query<SourcePreferenceRow>(
      `SELECT label, domains, rss_urls, query_hints, weight, enabled FROM ${this.table("newsletter_category_source_preferences")} WHERE user_id = $1 AND category_label_key = $2 ORDER BY position`,
      [userId, labelKey]
    );
    return result.rows.map(toSourcePreference);
  }

  private async replaceProfileValues(
    db: PgExecutor,
    table: string,
    keyColumn: string,
    valueColumn: string,
    userId: string,
    values: string[]
  ): Promise<void> {
    await db.query(`DELETE FROM ${this.table(table)} WHERE user_id = $1`, [userId]);
    for (const [position, value] of values.entries()) {
      await db.query(
        `INSERT INTO ${this.table(table)} (user_id, ${this.ident(keyColumn)}, ${this.ident(valueColumn)}, position) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, ${this.ident(keyColumn)}) DO UPDATE SET ${this.ident(valueColumn)} = EXCLUDED.${this.ident(valueColumn)}, position = EXCLUDED.position`,
        [userId, normalizeKey(value), value, position]
      );
    }
  }

  private async replaceProfileSources(db: PgExecutor, userId: string, sources: SourcePreference[]): Promise<void> {
    await db.query(`DELETE FROM ${this.table("newsletter_profile_source_preferences")} WHERE user_id = $1`, [userId]);
    for (const [position, preference] of sources.entries()) {
      await this.insertSourcePreference(db, "newsletter_profile_source_preferences", [userId], preference, position);
    }
  }

  private async insertSourcePreference(
    db: PgExecutor,
    table: "newsletter_profile_source_preferences" | "newsletter_category_source_preferences",
    ownerParams: string[],
    preference: SourcePreference,
    position: number
  ): Promise<void> {
    const isCategory = table === "newsletter_category_source_preferences";
    const ownerColumns = isCategory ? "user_id, category_label_key" : "user_id";
    const offsets = ownerParams.length;
    await db.query(
      `
        INSERT INTO ${this.table(table)} (
          ${ownerColumns}, label_key, label, domains, rss_urls, query_hints, weight, enabled, position
        ) VALUES (
          ${ownerParams.map((_, index) => `$${index + 1}`).join(", ")},
          $${offsets + 1}, $${offsets + 2}, $${offsets + 3}::text[], $${offsets + 4}::text[],
          $${offsets + 5}::text[], $${offsets + 6}, $${offsets + 7}, $${offsets + 8}
        )
        ON CONFLICT (${ownerColumns}, label_key) DO UPDATE SET
          label = EXCLUDED.label,
          domains = EXCLUDED.domains,
          rss_urls = EXCLUDED.rss_urls,
          query_hints = EXCLUDED.query_hints,
          weight = EXCLUDED.weight,
          enabled = EXCLUDED.enabled,
          position = EXCLUDED.position
      `,
      [
        ...ownerParams,
        normalizeKey(preference.label),
        preference.label,
        preference.domains,
        preference.rssUrls,
        preference.queryHints,
        preference.weight,
        preference.enabled,
        position
      ]
    );
  }

  private async withTransaction(work: (db: PgExecutor) => Promise<void>): Promise<void> {
    if (!this.pool.connect) {
      await work(this.pool);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.runMigrations) {
      return;
    }
    this.migration ??= this.migrate();
    await this.migration;
  }

  private async migrate(): Promise<void> {
    const schema = this.ident(this.schemaName);
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

    const legacyColumns = new Map([
      ["newsletter_profiles", "profile"],
      ["newsletter_templates", "template"],
      ["newsletter_category_settings", "setting"],
      ["newsletter_history", "entry"]
    ]);
    for (const [table, jsonColumn] of legacyColumns) {
      if (await this.hasColumn(table, jsonColumn)) {
        const legacyTable = `${table}_json_legacy`;
        if (!await this.hasTable(legacyTable)) {
          await this.pool.query(`ALTER TABLE ${this.table(table)} RENAME TO ${this.ident(legacyTable)}`);
        }
      }
    }

    await this.createNormalizedTables();
    await this.backfillLegacyTables();
    await this.createIndexes();
  }

  private async createNormalizedTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profiles")} (
        user_id TEXT PRIMARY KEY,
        preferred_tone TEXT NOT NULL,
        schedule_frequency TEXT NOT NULL,
        schedule_timezone TEXT NOT NULL,
        schedule_preferred_day TEXT,
        schedule_preferred_time TEXT,
        format_length TEXT NOT NULL,
        format_edition TEXT,
        include_commentary BOOLEAN NOT NULL,
        include_recommendations BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profile_interests")} (
        user_id TEXT NOT NULL REFERENCES ${this.table("newsletter_profiles")}(user_id) ON DELETE CASCADE,
        interest_key TEXT NOT NULL,
        interest TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, interest_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profile_regions")} (
        user_id TEXT NOT NULL REFERENCES ${this.table("newsletter_profiles")}(user_id) ON DELETE CASCADE,
        region_key TEXT NOT NULL,
        region TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, region_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profile_excluded_keywords")} (
        user_id TEXT NOT NULL REFERENCES ${this.table("newsletter_profiles")}(user_id) ON DELETE CASCADE,
        keyword_key TEXT NOT NULL,
        keyword TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, keyword_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profile_source_preferences")} (
        user_id TEXT NOT NULL REFERENCES ${this.table("newsletter_profiles")}(user_id) ON DELETE CASCADE,
        label_key TEXT NOT NULL,
        label TEXT NOT NULL,
        domains TEXT[] NOT NULL DEFAULT '{}',
        rss_urls TEXT[] NOT NULL DEFAULT '{}',
        query_hints TEXT[] NOT NULL DEFAULT '{}',
        weight DOUBLE PRECISION NOT NULL,
        enabled BOOLEAN NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, label_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_templates")} (
        template_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        output_language TEXT,
        output_format TEXT,
        audience TEXT,
        style_guide TEXT[] NOT NULL DEFAULT '{}',
        layout_guide TEXT[] NOT NULL DEFAULT '{}',
        source_policy TEXT[] NOT NULL DEFAULT '{}',
        forbidden_rules TEXT[] NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_template_sections")} (
        template_id TEXT NOT NULL REFERENCES ${this.table("newsletter_templates")}(template_id) ON DELETE CASCADE,
        section_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        max_items INTEGER,
        instruction TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (template_id, section_id)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_category_settings")} (
        user_id TEXT NOT NULL,
        label_key TEXT NOT NULL,
        label TEXT NOT NULL,
        aliases TEXT[] NOT NULL DEFAULT '{}',
        keywords TEXT[] NOT NULL DEFAULT '{}',
        source_hints TEXT[] NOT NULL DEFAULT '{}',
        weight DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, label_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_category_source_preferences")} (
        user_id TEXT NOT NULL,
        category_label_key TEXT NOT NULL,
        label_key TEXT NOT NULL,
        label TEXT NOT NULL,
        domains TEXT[] NOT NULL DEFAULT '{}',
        rss_urls TEXT[] NOT NULL DEFAULT '{}',
        query_hints TEXT[] NOT NULL DEFAULT '{}',
        weight DOUBLE PRECISION NOT NULL,
        enabled BOOLEAN NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, category_label_key, label_key),
        FOREIGN KEY (user_id, category_label_key)
          REFERENCES ${this.table("newsletter_category_settings")}(user_id, label_key) ON DELETE CASCADE
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_history")} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        interests TEXT[] NOT NULL DEFAULT '{}',
        regions TEXT[] NOT NULL DEFAULT '{}',
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        tone TEXT NOT NULL,
        template_id TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        title TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        top_sources TEXT[] NOT NULL DEFAULT '{}'
      )
    `);
  }

  private async backfillLegacyTables(): Promise<void> {
    if (await this.hasTable("newsletter_profiles_json_legacy")) {
      const legacy = this.table("newsletter_profiles_json_legacy");
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_profiles")} (
          user_id, preferred_tone, schedule_frequency, schedule_timezone,
          schedule_preferred_day, schedule_preferred_time, format_length,
          format_edition, include_commentary, include_recommendations, updated_at
        )
        SELECT
          user_id,
          COALESCE(profile->>'preferredTone', 'friendly'),
          COALESCE(profile->'schedule'->>'frequency', 'weekly'),
          COALESCE(profile->'schedule'->>'timezone', 'Asia/Seoul'),
          NULLIF(profile->'schedule'->>'preferredDay', ''),
          NULLIF(profile->'schedule'->>'preferredTime', ''),
          COALESCE(profile->'formatPreference'->>'length', 'medium'),
          NULLIF(profile->'formatPreference'->>'edition', ''),
          COALESCE((profile->'formatPreference'->>'includeCommentary')::boolean, true),
          COALESCE((profile->'formatPreference'->>'includeRecommendations')::boolean, true),
          updated_at
        FROM ${legacy}
        ON CONFLICT (user_id) DO NOTHING
      `);
      await this.backfillProfileList(legacy, "interests", "newsletter_profile_interests", "interest_key", "interest");
      await this.backfillProfileList(legacy, "regions", "newsletter_profile_regions", "region_key", "region");
      await this.backfillProfileList(legacy, "excludedKeywords", "newsletter_profile_excluded_keywords", "keyword_key", "keyword");
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_profile_source_preferences")} (
          user_id, label_key, label, domains, rss_urls, query_hints, weight, enabled, position
        )
        SELECT
          p.user_id,
          lower(trim(source.value->>'label')),
          source.value->>'label',
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'domains', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'rssUrls', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'queryHints', '[]'::jsonb))),
          COALESCE((source.value->>'weight')::double precision, 1.25),
          COALESCE((source.value->>'enabled')::boolean, true),
          source.ordinality - 1
        FROM ${legacy} p
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.profile->'sourcePreferences', '[]'::jsonb)) WITH ORDINALITY AS source(value, ordinality)
        WHERE NULLIF(trim(source.value->>'label'), '') IS NOT NULL
        ON CONFLICT (user_id, label_key) DO NOTHING
      `);
      await this.pool.query(`DROP TABLE ${legacy}`);
    }

    if (await this.hasTable("newsletter_templates_json_legacy")) {
      const legacy = this.table("newsletter_templates_json_legacy");
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_templates")} (
          template_id, name, description, output_language, output_format, audience,
          style_guide, layout_guide, source_policy, forbidden_rules, updated_at
        )
        SELECT
          template_id,
          template->>'name',
          NULLIF(template->>'description', ''),
          NULLIF(template->>'outputLanguage', ''),
          NULLIF(template->>'outputFormat', ''),
          NULLIF(template->>'audience', ''),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(template->'styleGuide', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(template->'layoutGuide', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(template->'sourcePolicy', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(template->'forbiddenRules', '[]'::jsonb))),
          updated_at
        FROM ${legacy}
        ON CONFLICT (template_id) DO NOTHING
      `);
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_template_sections")} (
          template_id, section_id, title, description, max_items, instruction, position
        )
        SELECT
          t.template_id,
          section.value->>'id',
          section.value->>'title',
          section.value->>'description',
          NULLIF(section.value->>'maxItems', '')::integer,
          NULLIF(t.template->'sectionInstructions'->>(section.value->>'id'), ''),
          section.ordinality - 1
        FROM ${legacy} t
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.template->'sections', '[]'::jsonb)) WITH ORDINALITY AS section(value, ordinality)
        ON CONFLICT (template_id, section_id) DO NOTHING
      `);
      await this.pool.query(`DROP TABLE ${legacy}`);
    }

    if (await this.hasTable("newsletter_category_settings_json_legacy")) {
      const legacy = this.table("newsletter_category_settings_json_legacy");
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_category_settings")} (
          user_id, label_key, label, aliases, keywords, source_hints, weight, updated_at
        )
        SELECT
          user_id,
          label_key,
          setting->>'label',
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(setting->'aliases', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(setting->'keywords', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(setting->'sourceHints', '[]'::jsonb))),
          COALESCE((setting->>'weight')::double precision, 1),
          updated_at
        FROM ${legacy}
        ON CONFLICT (user_id, label_key) DO NOTHING
      `);
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_category_source_preferences")} (
          user_id, category_label_key, label_key, label, domains, rss_urls, query_hints, weight, enabled, position
        )
        SELECT
          c.user_id,
          c.label_key,
          lower(trim(source.value->>'label')),
          source.value->>'label',
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'domains', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'rssUrls', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(source.value->'queryHints', '[]'::jsonb))),
          COALESCE((source.value->>'weight')::double precision, 1.25),
          COALESCE((source.value->>'enabled')::boolean, true),
          source.ordinality - 1
        FROM ${legacy} c
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.setting->'sourcePreferences', '[]'::jsonb)) WITH ORDINALITY AS source(value, ordinality)
        WHERE NULLIF(trim(source.value->>'label'), '') IS NOT NULL
        ON CONFLICT (user_id, category_label_key, label_key) DO NOTHING
      `);
      await this.pool.query(`DROP TABLE ${legacy}`);
    }

    if (await this.hasTable("newsletter_history_json_legacy")) {
      const legacy = this.table("newsletter_history_json_legacy");
      await this.pool.query(`
        INSERT INTO ${this.table("newsletter_history")} (
          id, user_id, user_message, interests, regions, period_start, period_end,
          tone, template_id, generated_at, title, item_count, top_sources
        )
        SELECT
          id,
          user_id,
          COALESCE(entry->>'userMessage', ''),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry->'structuredRequest'->'interests', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry->'structuredRequest'->'regions', '[]'::jsonb))),
          (entry->'structuredRequest'->'period'->>'start')::date,
          (entry->'structuredRequest'->'period'->>'end')::date,
          entry->'structuredRequest'->>'tone',
          entry->'structuredRequest'->>'templateId',
          generated_at,
          entry->'draftSummary'->>'title',
          (entry->'draftSummary'->>'itemCount')::integer,
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry->'draftSummary'->'topSources', '[]'::jsonb)))
        FROM ${legacy}
        ON CONFLICT (id) DO NOTHING
      `);
      await this.pool.query(`DROP TABLE ${legacy}`);
    }
  }

  private async backfillProfileList(
    legacyTable: string,
    jsonField: string,
    targetTable: string,
    keyColumn: string,
    valueColumn: string
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.table(targetTable)} (user_id, ${this.ident(keyColumn)}, ${this.ident(valueColumn)}, position)
      SELECT p.user_id, lower(trim(item.value)), item.value, item.ordinality - 1
      FROM ${legacyTable} p
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.profile->${sqlLiteral(jsonField)}, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
      WHERE trim(item.value) <> ''
      ON CONFLICT (user_id, ${this.ident(keyColumn)}) DO NOTHING
    `);
  }

  private async createIndexes(): Promise<void> {
    const definitions = [
      ["newsletter_profile_interest_key_idx", "newsletter_profile_interests", "interest_key"],
      ["newsletter_profile_region_key_idx", "newsletter_profile_regions", "region_key"],
      ["newsletter_profile_excluded_keyword_key_idx", "newsletter_profile_excluded_keywords", "keyword_key"],
      ["newsletter_history_user_generated_idx", "newsletter_history", "user_id, generated_at DESC"]
    ];
    for (const [index, table, columns] of definitions) {
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.ident(`${this.schemaName}_${index}`)} ON ${this.table(table)} (${columns})`);
    }
    const ginDefinitions = [
      ["newsletter_profile_source_domains_gin_idx", "newsletter_profile_source_preferences", "domains"],
      ["newsletter_category_aliases_gin_idx", "newsletter_category_settings", "aliases"],
      ["newsletter_category_keywords_gin_idx", "newsletter_category_settings", "keywords"],
      ["newsletter_category_source_domains_gin_idx", "newsletter_category_source_preferences", "domains"],
      ["newsletter_history_interests_gin_idx", "newsletter_history", "interests"],
      ["newsletter_history_regions_gin_idx", "newsletter_history", "regions"]
    ];
    for (const [index, table, column] of ginDefinitions) {
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.ident(`${this.schemaName}_${index}`)} ON ${this.table(table)} USING GIN (${this.ident(column)})`);
    }
  }

  private async hasTable(tableName: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists`,
      [this.schemaName, tableName]
    );
    return result.rows[0]?.exists === true;
  }

  private async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS exists`,
      [this.schemaName, tableName, columnName]
    );
    return result.rows[0]?.exists === true;
  }

  private table(name: string): string {
    return `${this.ident(this.schemaName)}.${this.ident(name)}`;
  }

  private ident(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}

function validateIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid Postgres identifier: ${value}`);
  }
  return value;
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDateString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function toSourcePreference(row: SourcePreferenceRow): SourcePreference {
  return {
    label: row.label,
    domains: row.domains ?? [],
    rssUrls: row.rss_urls ?? [],
    queryHints: row.query_hints ?? [],
    weight: Number(row.weight),
    enabled: row.enabled
  };
}

function toHistoryEntry(row: HistoryRow): NewsletterHistoryEntry {
  return {
    id: row.id,
    userId: row.user_id,
    userMessage: row.user_message,
    structuredRequest: {
      interests: row.interests ?? [],
      regions: row.regions ?? [],
      period: {
        start: toDateString(row.period_start),
        end: toDateString(row.period_end)
      },
      tone: row.tone,
      templateId: row.template_id
    },
    generatedAt: toIsoString(row.generated_at),
    draftSummary: {
      title: row.title,
      itemCount: Number(row.item_count),
      topSources: row.top_sources ?? []
    }
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
