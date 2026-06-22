import { z } from "zod";
import { createDefaultProfile, DEFAULT_TEMPLATE_ID } from "../domain/defaults.js";
import type { InterestTagSetting, NewsletterDraft, NewsletterFormatPreference, NewsletterHistoryEntry, NewsletterTemplate, RankedNewsletterItem, SourceRef, UserProfile, UserSchedule } from "../domain/types.js";
import { NewsletterDraftGenerator } from "../pipeline/draftGenerator.js";
import type { NewsletterStorage } from "../storage/NewsletterStorage.js";

type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type ToolAnnotation = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
};

const SERVICE_NAME = "Chat Newsletter MCP(채팅 뉴스레터 MCP)";

export function listTools() {
  return {
    tools: [
      toolDefinition({
        name: "get_user_profile",
        description: `Retrieves a user's newsletter preference profile from ${SERVICE_NAME}.`,
        annotations: readOnlyAnnotation("Get User Profile"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier.")
        }, ["userId"])
      }),
      toolDefinition({
        name: "update_user_preferences",
        description: `Creates or patches a user's chat-derived newsletter preferences in ${SERVICE_NAME}.`,
        annotations: writeAnnotation("Update User Preferences"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier."),
          patch: {
            type: "object",
            description: "Partial preference update parsed by the LLM client.",
            additionalProperties: true
          },
          sourceMessage: stringSchema("Optional original user message.", true)
        }, ["userId", "patch"])
      }),
      toolDefinition({
        name: "list_newsletter_templates",
        description: `Lists available newsletter templates from ${SERVICE_NAME}.`,
        annotations: readOnlyAnnotation("List Newsletter Templates"),
        inputSchema: objectSchema({}, [])
      }),
      toolDefinition({
        name: "get_newsletter_template",
        description: `Retrieves a newsletter template by id from ${SERVICE_NAME}.`,
        annotations: readOnlyAnnotation("Get Newsletter Template"),
        inputSchema: objectSchema({
          templateId: stringSchema("Template id.")
        }, ["templateId"])
      }),
      toolDefinition({
        name: "list_user_category_settings",
        description: `Lists a user's dynamic interest tag settings from ${SERVICE_NAME}.`,
        annotations: readOnlyAnnotation("List User Category Settings"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier.")
        }, ["userId"])
      }),
      toolDefinition({
        name: "upsert_user_category_setting",
        description: `Creates or replaces metadata for one user-defined interest tag in ${SERVICE_NAME}.`,
        annotations: writeAnnotation("Upsert User Category Setting"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier."),
          setting: {
            type: "object",
            additionalProperties: true
          }
        }, ["userId", "setting"])
      }),
      toolDefinition({
        name: "list_newsletter_history",
        description: `Lists recently generated newsletter drafts for a user from ${SERVICE_NAME}.`,
        annotations: readOnlyAnnotation("List Newsletter History"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier."),
          limit: {
            type: "number",
            description: "Maximum history entries to return."
          }
        }, ["userId"])
      }),
      toolDefinition({
        name: "generate_newsletter_draft",
        description: `Generates a structured newsletter draft from chat-derived preferences using ${SERVICE_NAME}.`,
        annotations: openWorldWriteAnnotation("Generate Newsletter Draft"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier."),
          userMessage: stringSchema("Original user chat message."),
          interests: arrayStringSchema("Free-form user interest tags.", true),
          regions: arrayStringSchema("Preferred regions.", true),
          period: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" }
            }
          },
          tone: {
            type: "string",
            enum: ["casual", "professional", "friendly", "analytical"]
          },
          format: {
            type: "object",
            additionalProperties: true
          },
          templateId: stringSchema("Template id.", true)
        }, ["userId", "userMessage"])
      }),
      toolDefinition({
        name: "generate_final_newsletter",
        description: `Generates a structured draft and renders the final newsletter with the configured LLM provider using ${SERVICE_NAME}.`,
        annotations: openWorldWriteAnnotation("Generate Final Newsletter"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier."),
          userMessage: stringSchema("Original user chat message."),
          interests: arrayStringSchema("Free-form user interest tags.", true),
          regions: arrayStringSchema("Preferred regions.", true),
          period: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" }
            }
          },
          tone: {
            type: "string",
            enum: ["casual", "professional", "friendly", "analytical"]
          },
          format: {
            type: "object",
            additionalProperties: true
          },
          templateId: stringSchema("Template id.", true),
          outputFormat: {
            type: "string",
            enum: ["markdown", "html", "plain_text"],
            description: "Final newsletter output format."
          },
          model: stringSchema("Optional LLM model override.", true)
        }, ["userId", "userMessage"])
      })
    ]
  };
}

export async function callTool(
  storage: NewsletterStorage,
  generator: NewsletterDraftGenerator,
  name: string,
  args: unknown
): Promise<ToolResult> {
  switch (name) {
    case "get_user_profile": {
      const input = userIdSchema.parse(args);
      const profile = (await storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId);
      return textResult(formatProfile(profile));
    }
    case "update_user_preferences": {
      const input = updatePreferencesSchema.parse(args);
      const existing = (await storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId);
      const profile = mergeProfile(existing, input.patch);
      await storage.saveProfile(profile);
      const header = input.sourceMessage ? `_Based on: "${input.sourceMessage}"_\n\n` : "";
      return textResult(`${header}${formatProfile(profile)}`);
    }
    case "list_newsletter_templates": {
      const templates = await storage.listTemplates();
      const body = templates.map(formatTemplate).join("\n\n---\n\n");
      return textResult(`## Newsletter Templates\n\n${body || "_No templates found._"}`);
    }
    case "get_newsletter_template": {
      const input = templateIdSchema.parse(args);
      const template = await storage.getTemplate(input.templateId);
      if (!template) {
        throw new Error(`Newsletter template not found: ${input.templateId}`);
      }
      return textResult(formatTemplate(template));
    }
    case "list_user_category_settings": {
      const input = userIdSchema.parse(args);
      const settings = await storage.listUserCategorySettings(input.userId);
      const body = settings.map(formatCategorySetting).join("\n\n---\n\n");
      return textResult(`## Category Settings for \`${input.userId}\`\n\n${body || "_No category settings found._"}`);
    }
    case "upsert_user_category_setting": {
      const input = upsertCategorySettingSchema.parse(args);
      await storage.upsertUserCategorySetting(input.userId, input.setting);
      return textResult(`## Category Setting Updated\n\n${formatCategorySetting(input.setting)}`);
    }
    case "list_newsletter_history": {
      const input = listHistorySchema.parse(args);
      const history = await storage.listHistory(input.userId, input.limit);
      const body = history.map(formatHistoryEntry).join("\n\n---\n\n");
      return textResult(`## Newsletter History for \`${input.userId}\`\n\n${body || "_No history found._"}`);
    }
    case "generate_newsletter_draft": {
      const input = generateDraftSchema.parse(args);
      const draft = await generator.generate(input);
      return textResult(formatDraft(draft));
    }
    case "generate_final_newsletter": {
      const input = generateFinalNewsletterSchema.parse(args);
      const draft = await generator.generate(input);
      return textResult(formatDraft(draft));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function textResult(markdown: string): ToolResult {
  return { content: [{ type: "text", text: markdown }] };
}

function formatWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return "\n\n" + warnings.map(w => `> **Warning:** ${w}`).join("\n");
}

function formatProfile(profile: UserProfile): string {
  const { schedule, formatPreference: fmt } = profile;
  const scheduleStr = [
    schedule.frequency,
    `(${schedule.timezone})`,
    schedule.preferredDay,
    schedule.preferredTime,
  ].filter(Boolean).join(" ");
  return [
    `## User Profile: \`${profile.userId}\``,
    "",
    `- **Interests**: ${profile.interests.join(", ") || "(none)"}`,
    `- **Regions**: ${profile.regions.join(", ") || "(none)"}`,
    `- **Tone**: ${profile.preferredTone}`,
    `- **Schedule**: ${scheduleStr}`,
    `- **Format**: ${fmt.length}, commentary: ${fmt.includeCommentary ? "yes" : "no"}, recommendations: ${fmt.includeRecommendations ? "yes" : "no"}`,
    `- **Excluded Keywords**: ${profile.excludedKeywords.join(", ") || "(none)"}`,
    `- **Updated**: ${profile.updatedAt}`,
  ].join("\n");
}

function formatTemplate(template: NewsletterTemplate): string {
  const sections = template.sections
    .map(s => `  - **${s.id}** (${s.title}): max ${s.maxItems} items`)
    .join("\n");
  return [`### ${template.name} (\`${template.templateId}\`)`, "", "**Sections:**", sections].join("\n");
}

function formatCategorySetting(setting: InterestTagSetting): string {
  return [
    `### ${setting.label}`,
    "",
    `- **Aliases**: ${setting.aliases.join(", ") || "(none)"}`,
    `- **Keywords**: ${setting.keywords.join(", ") || "(none)"}`,
    `- **Source Hints**: ${setting.sourceHints.join(", ") || "(none)"}`,
    `- **Weight**: ${setting.weight}`,
    `- **Updated**: ${setting.updatedAt}`,
  ].join("\n");
}

function formatHistoryEntry(entry: NewsletterHistoryEntry): string {
  const { structuredRequest: req, draftSummary: summary } = entry;
  return [
    `### ${summary.title}`,
    `\`${entry.id}\``,
    "",
    `- **Generated**: ${entry.generatedAt}`,
    `- **Items**: ${summary.itemCount}`,
    `- **Interests**: ${req.interests.join(", ") || "(none)"}`,
    `- **Period**: ${req.period.start} ~ ${req.period.end}`,
    `- **Top Sources**: ${summary.topSources.join(", ") || "(none)"}`,
    ...(entry.userMessage ? [`- **Message**: "${entry.userMessage}"`] : []),
  ].join("\n");
}

const SECTION_TITLES: Record<string, string> = {
  top_stories: "오늘 주요 소식",
  key_dates: "주요 일정",
  deep_dive: "상세 해설",
  recommendations: "관련 행사/장소/도서 추천",
};

function formatDraftSection(sectionId: string, items: RankedNewsletterItem[]): string {
  const title = SECTION_TITLES[sectionId] ?? sectionId;
  if (items.length === 0) return `### ${title}\n\n_No items._`;
  const itemLines = items.map((item, i) => {
    const link = item.sourceUrl ? `[${item.title}](${item.sourceUrl})` : item.title;
    const meta = [item.sourceName, item.date].filter(Boolean).join(" · ");
    return [`${i + 1}. **${link}** (score: ${item.importanceScore})`, `   ${item.summary}`, meta ? `   _${meta}_` : ""]
      .filter(Boolean)
      .join("\n");
  });
  return [`### ${title}`, "", ...itemLines].join("\n");
}

function formatDraftSources(sources: SourceRef[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map(s => (s.sourceUrl ? `- [${s.sourceName}](${s.sourceUrl})` : `- ${s.sourceName}`));
  return ["### Sources", "", ...lines].join("\n");
}

function formatDraft(draft: NewsletterDraft): string {
  const { metadata: meta, sections, sources, warnings } = draft;
  const header = [
    `## ${draft.title}`,
    "",
    `**Draft ID**: \`${draft.draftId}\`  `,
    `**Period**: ${meta.period.start} ~ ${meta.period.end}  `,
    `**Tone**: ${meta.tone} | **Template**: \`${meta.templateId}\`  `,
    `**Generated**: ${meta.generatedAt}`,
  ].join("\n");
  const sectionIds = ["top_stories", "key_dates", "deep_dive", "recommendations"] as const;
  const sectionsText = sectionIds
    .map(id => formatDraftSection(id, sections[id]))
    .join("\n\n---\n\n");
  const sourcesText = formatDraftSources(sources);
  return [header, "---", sectionsText, sourcesText].filter(Boolean).join("\n\n") + formatWarnings(warnings);
}

const userIdSchema = z.object({
  userId: z.string().min(1)
});

const templateIdSchema = z.object({
  templateId: z.string().min(1)
});

const schedulePatchSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
  timezone: z.string().min(1).optional(),
  preferredDay: z.string().optional(),
  preferredTime: z.string().optional()
});

const formatPatchSchema = z.object({
  length: z.enum(["short", "medium", "long"]).optional(),
  includeCommentary: z.boolean().optional(),
  includeRecommendations: z.boolean().optional()
});

const profilePatchSchema = z.object({
  interests: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  preferredTone: z.enum(["casual", "professional", "friendly", "analytical"]).optional(),
  schedule: schedulePatchSchema.optional(),
  excludedKeywords: z.array(z.string()).optional(),
  formatPreference: formatPatchSchema.optional()
});

const updatePreferencesSchema = z.object({
  userId: z.string().min(1),
  patch: profilePatchSchema,
  sourceMessage: z.string().optional()
});

const categorySettingSchema = z.object({
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  sourceHints: z.array(z.string()).default([]),
  weight: z.number().min(0).max(2).default(1),
  updatedAt: z.string().optional()
}).transform((setting): InterestTagSetting => ({
  ...setting,
  updatedAt: setting.updatedAt ?? new Date().toISOString()
}));

const upsertCategorySettingSchema = z.object({
  userId: z.string().min(1),
  setting: categorySettingSchema
});

const listHistorySchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().positive().optional()
});

const periodSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1)
});

const generateDraftSchema = z.object({
  userId: z.string().min(1),
  userMessage: z.string().min(1),
  interests: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  period: periodSchema.optional(),
  tone: z.enum(["casual", "professional", "friendly", "analytical"]).optional(),
  format: formatPatchSchema.optional(),
  templateId: z.string().default(DEFAULT_TEMPLATE_ID).optional()
});

const generateFinalNewsletterSchema = generateDraftSchema.extend({
  outputFormat: z.enum(["markdown", "html", "plain_text"]).optional(),
  model: z.string().min(1).optional()
});

function mergeProfile(profile: UserProfile, patch: z.infer<typeof profilePatchSchema>): UserProfile {
  const nextSchedule: UserSchedule = {
    ...profile.schedule,
    ...patch.schedule
  };
  const nextFormat: NewsletterFormatPreference = {
    ...profile.formatPreference,
    ...patch.formatPreference
  };

  return {
    ...profile,
    interests: patch.interests ? normalizeList(patch.interests) : profile.interests,
    regions: patch.regions ? normalizeList(patch.regions) : profile.regions,
    preferredTone: patch.preferredTone ?? profile.preferredTone,
    schedule: nextSchedule,
    excludedKeywords: patch.excludedKeywords ? normalizeList(patch.excludedKeywords) : profile.excludedKeywords,
    formatPreference: nextFormat,
    updatedAt: new Date().toISOString()
  };
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringSchema(description: string, optional = false) {
  return optional
    ? { type: "string", description }
    : { type: "string", description };
}

function arrayStringSchema(description: string, _optional = false) {
  return {
    type: "array",
    description,
    items: { type: "string" }
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function toolDefinition(input: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotation;
}) {
  return input;
}

function readOnlyAnnotation(title: string): ToolAnnotation {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true
  };
}

function writeAnnotation(title: string): ToolAnnotation {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false
  };
}

function openWorldWriteAnnotation(title: string): ToolAnnotation {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false
  };
}
