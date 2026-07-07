import { Pool, type PoolConfig, type QueryResult } from "pg";
import type {
  InterestTagSetting,
  NewsletterHistoryEntry,
  NewsletterTemplate,
  UserProfile
} from "../domain/types.js";
import type { NewsletterStorage } from "./NewsletterStorage.js";

type PgExecutor = {
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  end?: () => Promise<void>;
};

export type PostgresStorageOptions = {
  connectionString?: string;
  schema?: string;
  ssl?: PoolConfig["ssl"];
  runMigrations?: boolean;
  pool?: PgExecutor;
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
    const result = await this.pool.query<{ profile: unknown }>(
      `SELECT profile FROM ${this.table("newsletter_profiles")} WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? asJson<UserProfile>(result.rows[0].profile) : null;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `
        INSERT INTO ${this.table("newsletter_profiles")} (user_id, profile, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()
      `,
      [profile.userId, JSON.stringify(profile)]
    );
  }

  async listProfiles(): Promise<UserProfile[]> {
    await this.ensureReady();
    const result = await this.pool.query<{ profile: unknown }>(
      `SELECT profile FROM ${this.table("newsletter_profiles")} ORDER BY user_id`
    );
    return result.rows.map((row) => asJson<UserProfile>(row.profile));
  }

  async listTemplates(): Promise<NewsletterTemplate[]> {
    await this.ensureReady();
    const result = await this.pool.query<{ template: unknown }>(
      `SELECT template FROM ${this.table("newsletter_templates")} ORDER BY template_id`
    );
    return result.rows.map((row) => asJson<NewsletterTemplate>(row.template));
  }

  async getTemplate(templateId: string): Promise<NewsletterTemplate | null> {
    await this.ensureReady();
    const result = await this.pool.query<{ template: unknown }>(
      `SELECT template FROM ${this.table("newsletter_templates")} WHERE template_id = $1`,
      [templateId]
    );
    return result.rows[0] ? asJson<NewsletterTemplate>(result.rows[0].template) : null;
  }

  async upsertTemplate(template: NewsletterTemplate): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `
        INSERT INTO ${this.table("newsletter_templates")} (template_id, template, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (template_id)
        DO UPDATE SET template = EXCLUDED.template, updated_at = NOW()
      `,
      [template.templateId, JSON.stringify(template)]
    );
  }

  async listUserCategorySettings(userId: string): Promise<InterestTagSetting[]> {
    await this.ensureReady();
    const result = await this.pool.query<{ setting: unknown }>(
      `
        SELECT setting
        FROM ${this.table("newsletter_category_settings")}
        WHERE user_id = $1
        ORDER BY label_key
      `,
      [userId]
    );
    return result.rows.map((row) => asJson<InterestTagSetting>(row.setting));
  }

  async upsertUserCategorySetting(userId: string, setting: InterestTagSetting): Promise<void> {
    await this.ensureReady();
    const labelKey = setting.label.trim().toLocaleLowerCase();
    await this.pool.query(
      `
        INSERT INTO ${this.table("newsletter_category_settings")} (user_id, label_key, setting, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (user_id, label_key)
        DO UPDATE SET setting = EXCLUDED.setting, updated_at = NOW()
      `,
      [userId, labelKey, JSON.stringify(setting)]
    );
  }

  async saveHistory(entry: NewsletterHistoryEntry): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `
        INSERT INTO ${this.table("newsletter_history")} (id, user_id, generated_at, entry)
        VALUES ($1, $2, $3::timestamptz, $4::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET user_id = EXCLUDED.user_id, generated_at = EXCLUDED.generated_at, entry = EXCLUDED.entry
      `,
      [entry.id, entry.userId, entry.generatedAt, JSON.stringify(entry)]
    );
  }

  async listHistory(userId: string, limit?: number): Promise<NewsletterHistoryEntry[]> {
    await this.ensureReady();
    const params: unknown[] = [userId];
    const limitClause = typeof limit === "number" ? "LIMIT $2" : "";
    if (typeof limit === "number") {
      params.push(limit);
    }
    const result = await this.pool.query<{ entry: unknown }>(
      `
        SELECT entry
        FROM ${this.table("newsletter_history")}
        WHERE user_id = $1
        ORDER BY generated_at DESC
        ${limitClause}
      `,
      params
    );
    return result.rows.map((row) => asJson<NewsletterHistoryEntry>(row.entry));
  }

  async listHistoryUsers(): Promise<string[]> {
    await this.ensureReady();
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM ${this.table("newsletter_history")} ORDER BY user_id`
    );
    return result.rows.map((row) => row.user_id);
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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_profiles")} (
        user_id TEXT PRIMARY KEY,
        profile JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_templates")} (
        template_id TEXT PRIMARY KEY,
        template JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_category_settings")} (
        user_id TEXT NOT NULL,
        label_key TEXT NOT NULL,
        setting JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, label_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("newsletter_history")} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        entry JSONB NOT NULL
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.ident(`${this.schemaName}_newsletter_history_user_generated_idx`)}
       ON ${this.table("newsletter_history")} (user_id, generated_at DESC)`
    );
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

function asJson<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}
