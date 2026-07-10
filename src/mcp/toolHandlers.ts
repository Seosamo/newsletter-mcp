import { z } from "zod";
import type { ApiConnectorRecommendation } from "../catalog/types.js";
import { ApiCatalogSelector } from "../catalog/ApiCatalogSelector.js";
import { recommendSourcePreferences, type SourceRecommendation } from "../catalog/sourceCatalog.js";
import { createDefaultProfile, DEFAULT_TEMPLATE_ID, DEFAULT_USER_ID } from "../domain/defaults.js";
import type { InterestTagSetting, NewsletterDraft, NewsletterEditorInstructions, NewsletterFormatPreference, NewsletterHistoryEntry, NewsletterOutline, NewsletterSectionId, NewsletterSectionTemplate, NewsletterTemplate, RankedNewsletterItem, SourcePreference, SourceRef, UserProfile, UserSchedule } from "../domain/types.js";
import { NewsletterDraftGenerator } from "../pipeline/draftGenerator.js";
import type { NewsletterStorage } from "../storage/NewsletterStorage.js";
import type { AuthenticatedUser } from "./oauth.js";
import {
  mergeSourcePreferences,
  normalizeSourceLinks,
  normalizeSourcePreferences
} from "../sources/sourcePreferences.js";
import { parsePreferenceMessage } from "../preferences/preferenceParser.js";

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

const SERVICE_NAME_FIXED = "Chat Newsletter MCP(\uCC44\uD305 \uB274\uC2A4\uB808\uD130 MCP)";

export function listTools() {
  return {
    tools: [
      toolDefinition({
        name: "get_user_profile",
        description: `Retrieves a user's newsletter preference profile from ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("Get User Profile"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true)
        }, [])
      }),
      toolDefinition({
        name: "update_user_preferences",
        description: `Creates or patches a user's chat-derived newsletter preferences in ${SERVICE_NAME_FIXED}. Always pass the original utterance as sourceMessage. Put extracted topics in patch.interests (for example, "난 미국 주식 뉴스레터를 받고 싶어" becomes ["주식", "미국 주식"]); the server also parses sourceMessage as a fallback.`,
        annotations: writeAnnotation("Update User Preferences"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true),
          patch: profilePatchInputSchema(),
          sourceMessage: stringSchema("Optional original user message.", true)
        }, [])
      }),
      toolDefinition({
        name: "list_newsletter_templates",
        description: `Lists available newsletter templates from ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("List Newsletter Templates"),
        inputSchema: objectSchema({}, [])
      }),
      toolDefinition({
        name: "get_newsletter_template",
        description: `Retrieves a newsletter template by id from ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("Get Newsletter Template"),
        inputSchema: objectSchema({
          templateId: stringSchema("Template id.")
        }, ["templateId"])
      }),
      toolDefinition({
        name: "upsert_newsletter_template",
        description: `Creates or updates a reusable newsletter writing template in ${SERVICE_NAME_FIXED}.`,
        annotations: writeAnnotation("Upsert Newsletter Template"),
        inputSchema: objectSchema({
          templateId: stringSchema("Template id."),
          name: stringSchema("Template display name."),
          template: newsletterTemplateInputSchema()
        }, ["templateId", "name", "template"])
      }),
      toolDefinition({
        name: "list_user_category_settings",
        description: `Lists a user's dynamic interest tag settings from ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("List User Category Settings"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true)
        }, [])
      }),
      toolDefinition({
        name: "upsert_user_category_setting",
        description: `Creates or replaces metadata for one user-defined interest tag in ${SERVICE_NAME_FIXED}.`,
        annotations: writeAnnotation("Upsert User Category Setting"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true),
          setting: {
            type: "object",
            additionalProperties: true
          }
        }, ["setting"])
      }),
      toolDefinition({
        name: "list_newsletter_history",
        description: `Lists recently generated newsletter drafts for a user from ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("List Newsletter History"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true),
          limit: {
            type: "number",
            description: "Maximum history entries to return."
          }
        }, [])
      }),
      toolDefinition({
        name: "generate_newsletter_draft",
        description: `Generates a structured newsletter draft from chat-derived preferences using ${SERVICE_NAME_FIXED}. Explicit preference statements in userMessage are also saved to the user's profile, even if update_user_preferences was not called first. During first-time onboarding, ask about preferred sources before calling this tool when no source preferences are saved.`,
        annotations: openWorldWriteAnnotation("Generate Newsletter Draft"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Defaults to default when omitted.", true),
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
        }, ["userMessage"])
      }),
      toolDefinition({
        name: "recommend_api_connectors",
        description: `Recommends public API connector and preferred content source candidates for user interests using ${SERVICE_NAME_FIXED}.`,
        annotations: readOnlyAnnotation("Recommend API Connectors"),
        inputSchema: objectSchema({
          userId: stringSchema("User identifier. Ignored when OAuth authentication is active.", true),
          interests: arrayStringSchema("Free-form user interest tags.", true),
          regions: arrayStringSchema("Preferred regions.", true),
          keywords: arrayStringSchema("Additional search keywords.", true),
          period: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" }
            }
          }
        }, [])
      })
    ]
  };
}

export async function callTool(
  storage: NewsletterStorage,
  generator: NewsletterDraftGenerator,
  apiCatalogSelector: ApiCatalogSelector,
  name: string,
  args: unknown,
  auth?: AuthenticatedUser
): Promise<ToolResult> {
  const scopedArgs = applyAuthenticatedUser(name, args, auth);
  switch (name) {
    case "get_user_profile": {
      const input = userIdSchema.parse(scopedArgs);
      const profile = (await storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId);
      return textResult(formatProfile(profile));
    }
    case "update_user_preferences": {
      const input = updatePreferencesSchema.parse(scopedArgs);
      const existing = (await storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId);
      const profile = mergeProfile(existing, mergeParsedPreferencePatch(input.patch, input.sourceMessage));
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
    case "upsert_newsletter_template": {
      const input = upsertNewsletterTemplateSchema.parse(args);
      await storage.upsertTemplate(input);
      return textResult(`## Newsletter Template Updated\n\n${formatTemplate(input)}`);
    }
    case "list_user_category_settings": {
      const input = userIdSchema.parse(scopedArgs);
      const settings = await storage.listUserCategorySettings(input.userId);
      const body = settings.map(formatCategorySetting).join("\n\n---\n\n");
      return textResult(`## Category Settings for \`${input.userId}\`\n\n${body || "_No category settings found._"}`);
    }
    case "upsert_user_category_setting": {
      const input = upsertCategorySettingSchema.parse(scopedArgs);
      await storage.upsertUserCategorySetting(input.userId, input.setting);
      return textResult(`## Category Setting Updated\n\n${formatCategorySetting(input.setting)}`);
    }
    case "list_newsletter_history": {
      const input = listHistorySchema.parse(scopedArgs);
      const history = await storage.listHistory(input.userId, input.limit);
      const body = history.map(formatHistoryEntry).join("\n\n---\n\n");
      return textResult(`## Newsletter History for \`${input.userId}\`\n\n${body || "_No history found._"}`);
    }
    case "generate_newsletter_draft": {
      const input = generateDraftSchema.parse(scopedArgs);
      const draft = await generator.generate(await persistPreferencesFromGeneration(storage, input));
      return textResult(formatDraft(draft));
    }
    case "recommend_api_connectors": {
      const input = recommendApiConnectorsSchema.parse(scopedArgs);
      return textResult(formatApiConnectorRecommendations(
        input.userId,
        apiCatalogSelector.select(input, 8),
        recommendSourcePreferences(input, 8)
      ));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const USER_SCOPED_TOOLS = new Set([
  "get_user_profile",
  "update_user_preferences",
  "list_user_category_settings",
  "upsert_user_category_setting",
  "list_newsletter_history",
  "generate_newsletter_draft",
  "recommend_api_connectors"
]);

function applyAuthenticatedUser(name: string, args: unknown, auth?: AuthenticatedUser): unknown {
  if (!auth || !USER_SCOPED_TOOLS.has(name)) {
    return args;
  }
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return {
      ...args,
      userId: auth.userId
    };
  }
  return {
    userId: auth.userId
  };
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
    `- **Format**: ${fmt.length}, edition: ${fmt.edition ?? "(not set)"}, commentary: ${fmt.includeCommentary ? "yes" : "no"}, recommendations: ${fmt.includeRecommendations ? "yes" : "no"}`,
    `- **Excluded Keywords**: ${profile.excludedKeywords.join(", ") || "(none)"}`,
    `- **Source Preferences**: ${formatSourcePreferenceSummary(profile.sourcePreferences)}`,
    `- **Updated**: ${profile.updatedAt}`,
    "",
    formatProfileOnboardingGuidance(profile)
  ].filter(Boolean).join("\n");
}

function formatProfileOnboardingGuidance(profile: UserProfile): string {
  const missing: string[] = [];
  if (profile.interests.length === 0) {
    missing.push("interests");
  }
  if (!profile.sourcePreferences || profile.sourcePreferences.length === 0) {
    missing.push("preferred sources");
  }
  if (!profile.formatPreference.edition) {
    missing.push("newsletter edition");
  }

  if (missing.length === 0) {
    return [
      "## Onboarding Guidance for LLM Client",
      "",
      "- Profile is ready for newsletter generation.",
      "- If the user asks for a draft, call `generate_newsletter_draft` with the current profile defaults."
    ].join("\n");
  }

  const nextSteps = [];
  if (profile.interests.length === 0) {
    nextSteps.push("- Ask the user which newsletter topics or categories they care about before generating a draft.");
  }
  if (profile.interests.length > 0 && (!profile.sourcePreferences || profile.sourcePreferences.length === 0)) {
    nextSteps.push("- Before generating the first draft, ask whether the user has preferred sources or sites for these topics.");
    nextSteps.push("- Call `recommend_api_connectors` with the saved interests to show recommended sources, then ask the user to choose sources or paste site/RSS links.");
    nextSteps.push("- Save selected source links with `update_user_preferences.patch.sourceLinks` or category-specific links with `upsert_user_category_setting.setting.sourceLinks`.");
    nextSteps.push("- If the user says they do not care about sources, proceed with general search.");
  }
  if (!profile.formatPreference.edition) {
    nextSteps.push("- Ask which newsletter edition the user prefers: morning, lunch, or evening.");
    nextSteps.push("- Save the selected edition with `update_user_preferences.patch.formatPreference.edition` before generating recurring drafts.");
  }

  return [
    "## Onboarding Guidance for LLM Client",
    "",
    `- Missing or unset preferences: ${missing.join(", ")}.`,
    ...nextSteps
  ].join("\n");
}

function formatTemplate(template: NewsletterTemplate): string {
  const sections = template.sections
    .map(s => `  - **${s.id}** (${s.title}): max ${s.maxItems} items`)
    .join("\n");
  const details = [
    template.description ? `- **Description**: ${template.description}` : "",
    template.outputLanguage ? `- **Output Language**: ${template.outputLanguage}` : "",
    template.outputFormat ? `- **Output Format**: ${template.outputFormat}` : "",
    template.audience ? `- **Audience**: ${template.audience}` : "",
    formatList("Style Guide", template.styleGuide),
    formatList("Layout Guide", template.layoutGuide),
    formatList("Source Policy", template.sourcePolicy),
    formatList("Forbidden Rules", template.forbiddenRules),
    formatSectionInstructions(template.sectionInstructions)
  ].filter(Boolean);
  return [
    `### ${template.name} (\`${template.templateId}\`)`,
    "",
    ...details,
    details.length > 0 ? "" : "",
    "**Sections:**",
    sections
  ].join("\n");
}

function formatList(title: string, values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return "";
  }
  return [`- **${title}**:`, ...values.map((value) => `  - ${value}`)].join("\n");
}

function formatSectionInstructions(instructions: Partial<Record<NewsletterSectionId, string>> | undefined): string {
  if (!instructions || Object.keys(instructions).length === 0) {
    return "";
  }
  return [
    "- **Section Instructions**:",
    ...Object.entries(instructions).map(([sectionId, instruction]) => `  - **${sectionId}**: ${instruction}`)
  ].join("\n");
}

function formatCategorySetting(setting: InterestTagSetting): string {
  return [
    `### ${setting.label}`,
    "",
    `- **Aliases**: ${setting.aliases.join(", ") || "(none)"}`,
    `- **Keywords**: ${setting.keywords.join(", ") || "(none)"}`,
    `- **Source Hints**: ${setting.sourceHints.join(", ") || "(none)"}`,
    `- **Source Preferences**: ${formatSourcePreferenceSummary(setting.sourcePreferences)}`,
    `- **Weight**: ${setting.weight}`,
    `- **Updated**: ${setting.updatedAt}`,
  ].join("\n");
}

function formatSourcePreferenceSummary(preferences: SourcePreference[] | undefined): string {
  if (!preferences || preferences.length === 0) {
    return "(none)";
  }
  return preferences
    .map((preference) => {
      const targets = [...preference.domains, ...preference.rssUrls].slice(0, 3).join(", ");
      return targets ? `${preference.label} (${targets})` : preference.label;
    })
    .join("; ");
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
    return [
      `${i + 1}. **${link}** (score: ${item.importanceScore})`,
      indentBlock(item.summary, "   "),
      item.imageUrl ? `   _Representative Image_: ${item.imageUrl}` : "",
      formatSelectedEvidence(item.selectedEvidence ?? []),
      formatRelatedSources(item.relatedSources ?? []),
      item.comparisonGroupReason ? `   _Comparison: ${item.comparisonGroupReason}_` : "",
      meta ? `   _${meta}_` : "",
      `   _Reason: ${item.rankingReason}_`
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [`### ${title}`, "", ...itemLines].join("\n");
}

function formatSelectedEvidence(evidence: string[]): string {
  if (evidence.length === 0) {
    return "";
  }
  const lines = evidence
    .slice(0, 2)
    .map((item) => `   - ${truncateText(item, 700)}`);
  return ["   **Evidence:**", ...lines].join("\n");
}

function formatRelatedSources(sources: NonNullable<RankedNewsletterItem["relatedSources"]>): string {
  if (sources.length === 0) {
    return "";
  }
  const lines = sources.slice(0, 4).flatMap((source, index) => {
    const link = source.sourceUrl ? `[${source.title}](${source.sourceUrl})` : source.title;
    const meta = [source.sourceName, source.date].filter(Boolean).join(" - ");
    const evidence = (source.selectedEvidence && source.selectedEvidence.length > 0
      ? source.selectedEvidence
      : source.evidence
    ).slice(0, 1);
    return [
      `   ${index + 1}. ${link}${meta ? ` (${meta})` : ""}`,
      ...evidence.map((item) => `      - ${truncateText(item, 500)}`)
    ];
  });
  return ["   **Related Sources for Comparison:**", ...lines].join("\n");
}

function indentBlock(text: string, prefix: string): string {
  return text.split(/\r?\n/).map((line) => line ? `${prefix}${line}` : "").join("\n");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trim()}…` : normalized;
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
  return [
    header,
    formatEditorInstructions(draft.editorInstructions),
    formatNewsletterOutline(draft.outline),
    "---",
    "## Draft Data",
    sectionsText,
    sourcesText
  ].filter(Boolean).join("\n\n") + formatWarnings(warnings);
}

function formatNewsletterOutline(outline: NewsletterOutline): string {
  if (outline.groups.length === 0) {
    return [
      "## Newsletter Outline",
      "",
      "_No outline items._"
    ].join("\n");
  }

  const lines = outline.groups.flatMap((group) => {
    const groupLines = [
      `${outline.leadPrefix} ${group.label}`,
      group.leadTitle ?? "(대표 항목 없음)"
    ];
    if (group.leadImageUrl) {
      groupLines.push(`대표 이미지: ${group.leadImageUrl}`);
    }
    if (group.briefTitles.length > 0) {
      groupLines.push(`${outline.briefPrefix} ${group.label}`);
      groupLines.push(...group.briefTitles);
    }
    return groupLines;
  });

  return [
    "## Newsletter Outline",
    "",
    `${outline.title} ${outline.introEmoji}`,
    "",
    ...lines
  ].join("\n");
}

function formatEditorInstructions(instructions: NewsletterEditorInstructions): string {
  return [
    "## AI Editing Instructions",
    "",
    `- **Output Language**: ${instructions.outputLanguage}`,
    `- **Output Format**: ${instructions.outputFormat}`,
    `- **Tone**: ${instructions.tone}`,
    `- **Length**: ${instructions.length}`,
    instructions.edition ? `- **Edition**: ${instructions.edition}` : "",
    formatEditionPlan(instructions.editionPlan),
    instructions.audience ? `- **Audience**: ${instructions.audience}` : "",
    formatList("Layout Guide", instructions.layoutGuide),
    formatList("Style Guide", instructions.styleGuide),
    formatSectionInstructions(instructions.sectionInstructions),
    formatList("Source Policy", instructions.sourcePolicy),
    formatList("Forbidden Rules", instructions.forbiddenRules)
  ].filter(Boolean).join("\n");
}

function formatEditionPlan(plan: NewsletterEditorInstructions["editionPlan"]): string {
  if (!plan) {
    return "";
  }
  return [
    "- **Edition Plan**:",
    `  - Label: ${plan.label}`,
    `  - Long topics: ${plan.longTopicCount}`,
    `  - Multi-source long topics: ${plan.multiSourceTopicCount}`,
    `  - Short articles: ${plan.shortArticleCount}`,
    ...plan.instructions.map((instruction) => `  - ${instruction}`)
  ].join("\n");
}

function formatApiConnectorRecommendations(
  userId: string,
  recommendations: ApiConnectorRecommendation[],
  sourceRecommendations: SourceRecommendation[]
): string {
  const apiBody = recommendations.length === 0
    ? "_No relevant public API candidates were found._"
    : recommendations.map((recommendation, index) => {
    const { entry } = recommendation;
    const status = recommendation.callable
      ? "callable"
      : recommendation.supported
        ? "supported, needs configuration"
        : "candidate only";
    const requiredConfig = recommendation.requiresConfig.length > 0
      ? recommendation.requiresConfig.join(", ")
      : "none";

    return [
      `${index + 1}. **[${entry.name}](${entry.url})**`,
      `   - Category: ${entry.category}`,
      `   - Catalog source: ${entry.source}`,
      `   - Auth: ${entry.auth} | HTTPS: ${entry.https} | CORS: ${entry.cors}`,
      `   - Status: ${status}`,
      `   - Required config: ${requiredConfig}`,
      `   - Score: ${recommendation.score}`,
      `   - Reason: ${recommendation.reasons.join("; ") || "catalog match"}`
    ].join("\n");
  }).join("\n\n");

  return [
    `## API Connector Recommendations for \`${userId}\``,
    "",
    apiBody,
    "",
    formatSourceRecommendations(sourceRecommendations)
  ].join("\n\n");
}

function formatSourceRecommendations(recommendations: SourceRecommendation[]): string {
  if (recommendations.length === 0) {
    return [
      "## Recommended Sources",
      "",
      "_No relevant preferred source candidates were found._"
    ].join("\n");
  }

  const body = recommendations.map((recommendation, index) => {
    const { source } = recommendation;
    return [
      `${index + 1}. **${source.label}**`,
      `   - Description: ${recommendation.description}`,
      `   - Domains: ${source.domains.join(", ") || "none"}`,
      `   - RSS: ${source.rssUrls.join(", ") || "none"}`,
      `   - Query hints: ${source.queryHints.join(", ") || "none"}`,
      "   - Callable: yes",
      `   - Score: ${recommendation.score}`,
      `   - Reason: ${recommendation.reasons.join("; ") || "source catalog match"}`
    ].join("\n");
  });

  return [
    "## Recommended Sources",
    "",
    ...body
  ].join("\n\n");
}

const userIdSchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID))
});

const templateIdSchema = z.object({
  templateId: z.string().min(1)
});

const newsletterSectionIdSchema = z.enum(["top_stories", "key_dates", "deep_dive", "recommendations"]);

const newsletterSectionTemplateSchema = z.object({
  id: newsletterSectionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  maxItems: z.number().int().positive().optional()
});

const newsletterTemplatePayloadSchema = z.object({
  description: z.string().optional(),
  outputLanguage: z.string().min(1).default("ko"),
  outputFormat: z.string().min(1).default("markdown"),
  audience: z.string().optional(),
  styleGuide: z.array(z.string()).default([]),
  layoutGuide: z.array(z.string()).default([]),
  sourcePolicy: z.array(z.string()).default([]),
  forbiddenRules: z.array(z.string()).default([]),
  sectionInstructions: z.record(newsletterSectionIdSchema, z.string()).default({}),
  sections: z.array(newsletterSectionTemplateSchema).optional()
});

const upsertNewsletterTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1),
  template: newsletterTemplatePayloadSchema
}).transform(({ templateId, name, template }): NewsletterTemplate => ({
  templateId: templateId.trim(),
  name: name.trim(),
  description: template.description?.trim(),
  outputLanguage: template.outputLanguage.trim(),
  outputFormat: template.outputFormat.trim(),
  audience: template.audience?.trim(),
  styleGuide: normalizeList(template.styleGuide),
  layoutGuide: normalizeList(template.layoutGuide),
  sourcePolicy: normalizeList(template.sourcePolicy),
  forbiddenRules: normalizeList(template.forbiddenRules),
  sectionInstructions: normalizeSectionInstructions(template.sectionInstructions),
  sections: mergeTemplateSections(template.sections)
}));

const schedulePatchSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
  timezone: z.string().min(1).optional(),
  preferredDay: z.string().optional(),
  preferredTime: z.string().optional()
});

const formatPatchSchema = z.object({
  length: z.enum(["short", "medium", "long"]).optional(),
  edition: z.enum(["morning", "lunch", "evening"]).optional(),
  includeCommentary: z.boolean().optional(),
  includeRecommendations: z.boolean().optional()
});

const sourcePreferenceInputSchema = z.object({
  label: z.string().optional(),
  domains: z.array(z.string()).default([]),
  rssUrls: z.array(z.string()).default([]),
  queryHints: z.array(z.string()).default([]),
  weight: z.number().min(0).max(2).default(1.25),
  enabled: z.boolean().default(true)
});

const profilePatchSchema = z.object({
  interests: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  preferredTone: z.enum(["casual", "professional", "friendly", "analytical"]).optional(),
  schedule: schedulePatchSchema.optional(),
  excludedKeywords: z.array(z.string()).optional(),
  formatPreference: formatPatchSchema.optional(),
  sourcePreferences: z.array(sourcePreferenceInputSchema).optional(),
  sourceLinks: z.array(z.string()).optional()
});

const updatePreferencesSchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID)),
  patch: profilePatchSchema.default({}),
  sourceMessage: z.string().optional()
}).refine((input) => Object.keys(input.patch).length > 0 || Boolean(input.sourceMessage?.trim()), {
  message: "patch or sourceMessage is required"
});

const categorySettingSchema = z.object({
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  sourceHints: z.array(z.string()).default([]),
  sourcePreferences: z.array(sourcePreferenceInputSchema).default([]),
  sourceLinks: z.array(z.string()).default([]),
  weight: z.number().min(0).max(2).default(1),
  updatedAt: z.string().optional()
}).transform((setting): InterestTagSetting => ({
  label: setting.label,
  aliases: normalizeList(setting.aliases),
  keywords: normalizeList(setting.keywords),
  sourceHints: normalizeList(setting.sourceHints),
  sourcePreferences: mergeSourcePreferences(
    normalizeSourcePreferences(setting.sourcePreferences),
    normalizeSourceLinks(setting.sourceLinks)
  ),
  weight: setting.weight,
  updatedAt: setting.updatedAt ?? new Date().toISOString()
}));

const upsertCategorySettingSchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID)),
  setting: categorySettingSchema
});

const listHistorySchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID)),
  limit: z.number().int().positive().optional()
});

const periodSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1)
});

const generateDraftSchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID)),
  userMessage: z.string().min(1),
  interests: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  period: periodSchema.optional(),
  tone: z.enum(["casual", "professional", "friendly", "analytical"]).optional(),
  format: formatPatchSchema.optional(),
  templateId: z.string().default(DEFAULT_TEMPLATE_ID).optional()
});

function defaultBlankString(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const recommendApiConnectorsSchema = z.object({
  userId: z.preprocess(defaultBlankString, z.string().min(1).default(DEFAULT_USER_ID)),
  interests: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  period: periodSchema.optional()
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
  const sourcePatch = mergeSourcePreferences(
    normalizeSourcePreferences(patch.sourcePreferences),
    normalizeSourceLinks(patch.sourceLinks)
  );
  const nextSourcePreferences = sourcePatch.length > 0
    ? mergeSourcePreferences(normalizeSourcePreferences(profile.sourcePreferences), sourcePatch)
    : normalizeSourcePreferences(profile.sourcePreferences);

  return {
    ...profile,
    interests: patch.interests ? normalizeList(patch.interests) : profile.interests,
    regions: patch.regions ? normalizeList(patch.regions) : profile.regions,
    preferredTone: patch.preferredTone ?? profile.preferredTone,
    schedule: nextSchedule,
    excludedKeywords: patch.excludedKeywords ? normalizeList(patch.excludedKeywords) : profile.excludedKeywords,
    formatPreference: nextFormat,
    sourcePreferences: nextSourcePreferences,
    updatedAt: new Date().toISOString()
  };
}

function mergeParsedPreferencePatch(
  patch: z.infer<typeof profilePatchSchema>,
  sourceMessage: string | undefined
): z.infer<typeof profilePatchSchema> {
  const parsed = parsePreferenceMessage(sourceMessage);
  return {
    ...patch,
    interests: patch.interests === undefined
      ? parsed.interests.length > 0 ? parsed.interests : undefined
      : patch.interests.length === 0 ? [] : normalizeList([...parsed.interests, ...patch.interests]),
    regions: patch.regions === undefined
      ? parsed.regions.length > 0 ? parsed.regions : undefined
      : patch.regions.length === 0 ? [] : normalizeList([...parsed.regions, ...patch.regions])
  };
}

async function persistPreferencesFromGeneration(
  storage: NewsletterStorage,
  input: z.infer<typeof generateDraftSchema>
): Promise<z.infer<typeof generateDraftSchema>> {
  const parsed = parsePreferenceMessage(input.userMessage);
  if (parsed.interests.length === 0 && parsed.regions.length === 0) {
    return input;
  }

  const existing = (await storage.getProfile(input.userId)) ?? createDefaultProfile(input.userId);
  const requestInterests = normalizeList([...parsed.interests, ...(input.interests ?? [])]);
  const requestRegions = normalizeList([...parsed.regions, ...(input.regions ?? [])]);
  const profile = mergeProfile(existing, {
    interests: normalizeList([...existing.interests, ...requestInterests]),
    regions: normalizeList([...existing.regions, ...requestRegions])
  });
  await storage.saveProfile(profile);

  return {
    ...input,
    interests: input.interests ?? requestInterests,
    regions: input.regions ?? requestRegions
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

function profilePatchInputSchema() {
  return {
    type: "object",
    description: "Structured preference fields extracted from the user's message. Omitted fields keep their current values.",
    additionalProperties: false,
    properties: {
      interests: arrayStringSchema("Interest tags, ordered from broad to specific. Example: ['주식', '미국 주식'].", true),
      regions: arrayStringSchema("Preferred geographic regions.", true),
      preferredTone: {
        type: "string",
        enum: ["casual", "professional", "friendly", "analytical"]
      },
      schedule: {
        type: "object",
        additionalProperties: false,
        properties: {
          frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
          timezone: stringSchema("IANA timezone, for example Asia/Seoul.", true),
          preferredDay: stringSchema("Preferred delivery day.", true),
          preferredTime: stringSchema("Preferred delivery time.", true)
        }
      },
      excludedKeywords: arrayStringSchema("Keywords to exclude.", true),
      formatPreference: {
        type: "object",
        additionalProperties: false,
        properties: {
          length: { type: "string", enum: ["short", "medium", "long"] },
          edition: { type: "string", enum: ["morning", "lunch", "evening"] },
          includeCommentary: { type: "boolean" },
          includeRecommendations: { type: "boolean" }
        }
      },
      sourcePreferences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            domains: arrayStringSchema("Preferred source domains.", true),
            rssUrls: arrayStringSchema("Preferred RSS URLs.", true),
            queryHints: arrayStringSchema("Search hints.", true),
            weight: { type: "number" },
            enabled: { type: "boolean" }
          }
        }
      },
      sourceLinks: arrayStringSchema("Preferred website or RSS links.", true)
    }
  };
}

function newsletterTemplateInputSchema() {
  return {
    type: "object",
    description: "Structured newsletter writing template parsed by the LLM client.",
    additionalProperties: false,
    properties: {
      description: stringSchema("Template description.", true),
      outputLanguage: stringSchema("Output language, for example ko.", true),
      outputFormat: stringSchema("Output format, for example markdown.", true),
      audience: stringSchema("Target reader audience.", true),
      styleGuide: arrayStringSchema("Writing style rules.", true),
      layoutGuide: arrayStringSchema("Desired newsletter layout order.", true),
      sourcePolicy: arrayStringSchema("Source and citation rules.", true),
      forbiddenRules: arrayStringSchema("Rules the final editor must not violate.", true),
      sectionInstructions: {
        type: "object",
        description: "Per-section writing instructions keyed by top_stories, key_dates, deep_dive, recommendations.",
        additionalProperties: { type: "string" }
      },
      sections: {
        type: "array",
        description: "Optional section limits and labels. Missing sections fall back to defaults.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              enum: ["top_stories", "key_dates", "deep_dive", "recommendations"]
            },
            title: { type: "string" },
            description: { type: "string" },
            maxItems: { type: "number" }
          },
          required: ["id", "title", "description"]
        }
      }
    }
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

function mergeTemplateSections(overrides: NewsletterSectionTemplate[] | undefined): NewsletterSectionTemplate[] {
  const byId = new Map<NewsletterSectionId, NewsletterSectionTemplate>(
    defaultTemplateSections().map((section) => [section.id, section])
  );
  for (const override of overrides ?? []) {
    byId.set(override.id, {
      id: override.id,
      title: override.title.trim(),
      description: override.description.trim(),
      maxItems: override.maxItems
    });
  }
  return defaultTemplateSections().map((section) => byId.get(section.id) ?? section);
}

function defaultTemplateSections(): NewsletterSectionTemplate[] {
  return [
    { id: "top_stories", title: "오늘 주요 소식", description: "요청 기간 안에서 가장 중요한 소식 후보", maxItems: 5 },
    { id: "key_dates", title: "주요 일정", description: "다가오는 일정, 행사, 마감일 후보", maxItems: 5 },
    { id: "deep_dive", title: "상세 해설", description: "LLM이 자세히 풀어쓸 만한 핵심 주제 후보", maxItems: 2 },
    { id: "recommendations", title: "관련 행사/장소/도서 추천", description: "사용자 취향과 연결되는 추천 콘텐츠 후보", maxItems: 5 }
  ];
}

function normalizeSectionInstructions(
  instructions: Partial<Record<NewsletterSectionId, string>>
): Partial<Record<NewsletterSectionId, string>> {
  return Object.fromEntries(
    Object.entries(instructions)
      .map(([key, value]) => [key, value.trim()])
      .filter((entry): entry is [NewsletterSectionId, string] => Boolean(entry[1]))
  );
}
