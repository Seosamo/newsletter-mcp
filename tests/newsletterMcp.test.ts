import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContentItem,
  ContentProviderResult,
  ContentSearchInput,
  InterestTagSetting,
  NewsletterTemplate,
  UserProfile
} from "../src/domain/types.js";
import { ApiCatalogSelector } from "../src/catalog/ApiCatalogSelector.js";
import { NewsletterDraftGenerator } from "../src/pipeline/draftGenerator.js";
import { isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocolVersion.js";
import { listResources, readResource } from "../src/mcp/resources.js";
import { callTool, listTools } from "../src/mcp/toolHandlers.js";
import type { ContentProvider } from "../src/providers/ContentProvider.js";
import {
  MockEventProvider,
  MockNewsProvider,
  MockRecommendationProvider
} from "../src/providers/MockContentProviders.js";
import { RssNewsProvider } from "../src/providers/RssNewsProvider.js";
import { JsonFileStorage } from "../src/storage/JsonFileStorage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("chat-based newsletter MCP MVP", () => {
  it("stores and retrieves free-form user interests and category settings", async () => {
    const storage = await createStorage({
      profiles: [],
      categorySettings: {}
    });
    const profile = makeProfile("user-free", {
      interests: ["희귀 취미", "도시 산책"],
      regions: ["서울"]
    });
    const setting: InterestTagSetting = {
      label: "희귀 취미",
      aliases: ["개인 관심사"],
      keywords: ["롱테일 키워드"],
      sourceHints: [],
      weight: 1.4,
      updatedAt: "2026-06-22T00:00:00.000Z"
    };

    await storage.saveProfile(profile);
    await storage.upsertUserCategorySetting(profile.userId, setting);

    await expect(storage.getProfile(profile.userId)).resolves.toMatchObject({
      userId: "user-free",
      interests: ["희귀 취미", "도시 산책"]
    });
    await expect(storage.listUserCategorySettings(profile.userId)).resolves.toEqual([setting]);
  });

  it("generates a structured draft with all template sections from chat-derived tags", async () => {
    const storage = await createStorage({
      profiles: [makeProfile("default")],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new MockNewsProvider(), new MockEventProvider(), new MockRecommendationProvider()],
      () => new Date("2026-06-22T00:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "default",
      userMessage: "이번 주 애니메이션/일본 뉴스레터 만들어줘",
      interests: ["애니메이션", "일본"],
      regions: ["일본"],
      period: {
        start: "2026-06-15",
        end: "2026-06-22"
      }
    });

    expect(draft.metadata.userMessage).toBe("이번 주 애니메이션/일본 뉴스레터 만들어줘");
    expect(draft.metadata.interests).toEqual(["애니메이션", "일본"]);
    expect(draft.sections.top_stories.length).toBeGreaterThan(0);
    expect(draft.sections.key_dates.length).toBeGreaterThan(0);
    expect(draft.sections.deep_dive.length).toBeGreaterThan(0);
    expect(draft.sections.recommendations.length).toBeGreaterThan(0);
    expect(draft.sources.length).toBeGreaterThan(0);
    expect(draft.editorInstructions).toMatchObject({
      outputLanguage: "ko",
      outputFormat: "markdown",
      tone: "friendly",
      length: "medium"
    });
    expect(draft.editorInstructions.styleGuide.join(" ")).toContain("❙ {카테고리}");
    expect(draft.editorInstructions.styleGuide.join(" ")).toContain("☀️와 💬");
    expect(draft.editorInstructions.sourcePolicy.join(" ")).toContain("evidence에 없는 사실");
    expect(draft.outline).toMatchObject({
      leadPrefix: "❙",
      briefPrefix: " ❙ 간추린",
      introEmoji: "☀️",
      quoteEmoji: "💬"
    });
    expect(draft.outline.groups.length).toBeGreaterThan(0);
    expect(draft.outline.groups[0].leadTitle).toBeTruthy();

    const history = await storage.listHistory("default");
    expect(history).toHaveLength(1);
    expect(history[0].userMessage).toBe("이번 주 애니메이션/일본 뉴스레터 만들어줘");
    expect(history[0].structuredRequest.interests).toEqual(["애니메이션", "일본"]);
  });

  it("falls back to profile interests, regions, tone, and weekly period when request fields are missing", async () => {
    const storage = await createStorage({
      profiles: [
        makeProfile("profile-defaults", {
          interests: ["도시 산책"],
          regions: ["서울"],
          preferredTone: "analytical"
        })
      ],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new MockNewsProvider(), new MockEventProvider(), new MockRecommendationProvider()],
      () => new Date("2026-06-22T12:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "profile-defaults",
      userMessage: "이번 주 뉴스레터 만들어줘"
    });

    expect(draft.metadata.interests).toEqual(["도시 산책"]);
    expect(draft.metadata.regions).toEqual(["서울"]);
    expect(draft.metadata.tone).toBe("analytical");
    expect(draft.metadata.period).toEqual({
      start: "2026-06-15",
      end: "2026-06-22"
    });
  });

  it("searches once with all interests and once per requested interest", async () => {
    const storage = await createStorage({
      profiles: [makeProfile("multi-interest")],
      categorySettings: {}
    });
    const provider = new RecordingProvider();
    const generator = new NewsletterDraftGenerator(
      storage,
      [provider],
      () => new Date("2026-06-22T00:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "multi-interest",
      userMessage: "애니메이션/경제/도서 뉴스레터 만들어줘",
      interests: ["애니메이션", "경제", "도서"],
      regions: ["일본"],
      period: {
        start: "2026-06-15",
        end: "2026-06-22"
      }
    });

    expect(provider.calls.map((call) => call.interests)).toEqual([
      ["애니메이션", "경제", "도서"],
      ["애니메이션"],
      ["경제"],
      ["도서"]
    ]);
    expect(provider.calls.every((call) => call.regions[0] === "일본")).toBe(true);
    expect(draft.metadata.interests).toEqual(["애니메이션", "경제", "도서"]);
    expect(draft.sections.top_stories.map((item) => item.title)).toEqual([
      "검색 결과: 애니메이션/경제/도서",
      "검색 결과: 애니메이션",
      "검색 결과: 경제",
      "검색 결과: 도서"
    ]);
  });

  it("filters excluded keywords and deduplicates equivalent URLs", async () => {
    const storage = await createStorage({
      profiles: [
        makeProfile("filters", {
          interests: ["테스트"],
          excludedKeywords: ["blocked"]
        })
      ],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new StaticProvider([
        makeContentItem("clean", "Clean 테스트 item", "https://example.com/a?utm=1"),
        makeContentItem("duplicate", "Duplicate 테스트 item", "https://example.com/a#duplicate"),
        makeContentItem("blocked", "blocked 테스트 item", "https://example.com/b")
      ])],
      () => new Date("2026-06-22T00:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "filters",
      userMessage: "테스트 뉴스레터 만들어줘"
    });

    expect(draft.sections.top_stories).toHaveLength(1);
    expect(draft.sections.top_stories[0].title).toBe("Clean 테스트 item");
  });

  it("keeps draft generation successful when RSS collection fails", async () => {
    const storage = await createStorage({
      profiles: [makeProfile("rss-user", { interests: ["rss-test"] })],
      categorySettings: {
        "rss-user": [
          {
            label: "rss-test",
            aliases: [],
            keywords: ["rss-test"],
            sourceHints: ["http://127.0.0.1:9/rss.xml"],
            weight: 1,
            updatedAt: "2026-06-22T00:00:00.000Z"
          }
        ]
      }
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new RssNewsProvider()],
      () => new Date("2026-06-22T00:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "rss-user",
      userMessage: "rss-test 뉴스레터 만들어줘"
    });

    expect(draft.warnings.some((warning) => warning.includes("RSS provider failed"))).toBe(true);
    expect(draft.draftId).toMatch(/^draft_/);
  });

  it("caps selected page evidence chunks across a generated draft", async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...makeContentItem(`chunked-${index}`, `Japan visa item ${index}`, `https://example.com/item-${index}`),
      evidence: [
        `Japan visa item ${index} snippet`,
        `[Page chunk 1/1] Japan visa body evidence ${index}`
      ]
    }));
    const storage = await createStorage({
      profiles: [
        makeProfile("evidence-budget", {
          interests: ["Japan"],
          regions: ["Japan"],
          formatPreference: {
            length: "medium",
            includeCommentary: false,
            includeRecommendations: false
          }
        })
      ],
      templates: [
        {
          templateId: "evidence_budget",
          name: "Evidence Budget",
          sections: [
            { id: "top_stories", title: "오늘 주요 소식", description: "주요 소식", maxItems: 12 },
            { id: "key_dates", title: "주요 일정", description: "일정", maxItems: 5 },
            { id: "deep_dive", title: "상세 해설", description: "상세 해설", maxItems: 0 },
            { id: "recommendations", title: "관련 행사/장소/도서 추천", description: "추천", maxItems: 0 }
          ]
        }
      ],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new StaticProvider(items)],
      () => new Date("2026-06-22T00:00:00.000Z")
    );

    const draft = await generator.generate({
      userId: "evidence-budget",
      userMessage: "Japan visa newsletter",
      templateId: "evidence_budget",
      period: {
        start: "2026-06-15",
        end: "2026-06-23"
      }
    });
    const selectedEvidence = Object.values(draft.sections)
      .flat()
      .flatMap((item) => item.selectedEvidence ?? []);

    expect(draft.sections.top_stories).toHaveLength(12);
    expect(selectedEvidence).toHaveLength(8);
    expect(draft.sections.top_stories[0].rankingReason).toContain("본문 chunk에서 query 관련 근거 발견");
    expect(draft.sections.top_stories[8].selectedEvidence).toEqual([]);
    expect(draft.sections.top_stories[8].rankingReason).not.toContain("본문 chunk에서 query 관련 근거 발견");
  });

  it("upserts and retrieves custom newsletter templates through MCP tools", async () => {
    const storage = await createStorage({
      profiles: [],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(storage, [], () => new Date("2026-06-22T00:00:00.000Z"));
    const selector = new ApiCatalogSelector([]);

    const updateResult = await callTool(storage, generator, selector, "upsert_newsletter_template", {
      templateId: "my_weekly_brief",
      name: "My Weekly Brief",
      template: {
        description: "짧고 읽기 쉬운 주간 브리프",
        outputLanguage: "ko",
        outputFormat: "markdown",
        audience: "일본 애니메이션과 문화 트렌드에 관심 있는 일반 독자",
        styleGuide: ["친근하지만 과장하지 않는다.", "문장은 짧게 쓴다."],
        layoutGuide: ["제목", "3줄 요약", "오늘 주요 소식", "출처"],
        sourcePolicy: ["각 주요 소식에는 출처 링크를 유지한다."],
        forbiddenRules: ["Page chunk 라벨을 최종 뉴스레터에 노출하지 않는다."],
        sectionInstructions: {
          top_stories: "중요도 순으로 최대 5개를 쓴다."
        }
      }
    });
    const saved = await storage.getTemplate("my_weekly_brief");
    const getResult = await callTool(storage, generator, selector, "get_newsletter_template", {
      templateId: "my_weekly_brief"
    });

    expect(updateResult.content[0].text).toContain("Newsletter Template Updated");
    expect(saved).toMatchObject({
      templateId: "my_weekly_brief",
      name: "My Weekly Brief",
      audience: "일본 애니메이션과 문화 트렌드에 관심 있는 일반 독자",
      styleGuide: ["친근하지만 과장하지 않는다.", "문장은 짧게 쓴다."],
      sectionInstructions: {
        top_stories: "중요도 순으로 최대 5개를 쓴다."
      }
    });
    expect(saved?.sections.map((section) => section.id)).toEqual([
      "top_stories",
      "key_dates",
      "deep_dive",
      "recommendations"
    ]);
    expect(getResult.content[0].text).toContain("Style Guide");
    expect(getResult.content[0].text).toContain("중요도 순으로 최대 5개를 쓴다.");
  });

  it("uses custom template rules in AI editing instructions for generated drafts", async () => {
    const customTemplate: NewsletterTemplate = {
      templateId: "my_weekly_brief",
      name: "My Weekly Brief",
      outputLanguage: "ko",
      outputFormat: "markdown",
      audience: "일본 애니메이션과 문화 트렌드에 관심 있는 일반 독자",
      styleGuide: ["친근하지만 과장하지 않는다.", "각 항목은 핵심 맥락을 2문장 이내로 설명한다."],
      layoutGuide: ["제목", "3줄 요약", "오늘 주요 소식", "출처"],
      sourcePolicy: ["각 주요 소식에는 출처 링크를 유지한다."],
      forbiddenRules: ["Page chunk 라벨을 최종 뉴스레터에 노출하지 않는다."],
      sectionInstructions: {
        top_stories: "중요도 순으로 최대 5개를 쓴다."
      },
      sections: [
        { id: "top_stories", title: "오늘 주요 소식", description: "주요 소식", maxItems: 5 },
        { id: "key_dates", title: "주요 일정", description: "일정", maxItems: 5 },
        { id: "deep_dive", title: "상세 해설", description: "상세 해설", maxItems: 2 },
        { id: "recommendations", title: "관련 행사/장소/도서 추천", description: "추천", maxItems: 5 }
      ]
    };
    const storage = await createStorage({
      profiles: [
        makeProfile("template-user", {
          interests: ["Japan"],
          regions: ["Japan"],
          preferredTone: "analytical",
          formatPreference: {
            length: "short",
            includeCommentary: true,
            includeRecommendations: true
          }
        })
      ],
      templates: [customTemplate],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [
        new StaticProvider([
          {
            ...makeContentItem("japan", "Japan anime policy update", "https://example.com/japan"),
            interestTags: ["경제"],
            imageUrl: "https://example.com/images/japan.png",
            imageAlt: "Japan anime policy update"
          },
          {
            ...makeContentItem("japan-brief", "Japan anime market brief", "https://example.com/japan-brief"),
            interestTags: ["경제"]
          }
        ])
      ],
      () => new Date("2026-06-22T00:00:00.000Z")
    );
    const selector = new ApiCatalogSelector([]);

    const draft = await generator.generate({
      userId: "template-user",
      userMessage: "Japan newsletter",
      templateId: "my_weekly_brief",
      period: {
        start: "2026-06-15",
        end: "2026-06-23"
      }
    });
    const toolResult = await callTool(storage, generator, selector, "generate_newsletter_draft", {
      userId: "template-user",
      userMessage: "Japan newsletter",
      templateId: "my_weekly_brief",
      period: {
        start: "2026-06-15",
        end: "2026-06-23"
      }
    });

    expect(draft.editorInstructions).toMatchObject({
      outputLanguage: "ko",
      outputFormat: "markdown",
      tone: "analytical",
      length: "short",
      audience: "일본 애니메이션과 문화 트렌드에 관심 있는 일반 독자"
    });
    expect(draft.editorInstructions.styleGuide).toContain("친근하지만 과장하지 않는다.");
    expect(draft.editorInstructions.layoutGuide).toEqual(["제목", "3줄 요약", "오늘 주요 소식", "출처"]);
    expect(draft.editorInstructions.sectionInstructions.top_stories).toBe("중요도 순으로 최대 5개를 쓴다.");
    expect(draft.outline.groups[0]).toMatchObject({
      label: "경제",
      leadTitle: "Japan anime policy update",
      leadImageUrl: "https://example.com/images/japan.png",
      briefTitles: ["Japan anime market brief"]
    });
    expect(toolResult.content[0].text).toContain("## AI Editing Instructions");
    expect(toolResult.content[0].text).toContain("친근하지만 과장하지 않는다.");
    expect(toolResult.content[0].text).toContain("## Newsletter Outline");
    expect(toolResult.content[0].text).toContain("❙ 경제");
    expect(toolResult.content[0].text).toContain(" ❙ 간추린 경제");
    expect(toolResult.content[0].text).toContain("대표 이미지: https://example.com/images/japan.png");
    expect(toolResult.content[0].text).toContain("_Representative Image_: https://example.com/images/japan.png");
    expect(toolResult.content[0].text).toContain("## Draft Data");
  });

  it("defaults newsletter draft generation to the default user when userId is omitted", async () => {
    const storage = await createStorage({
      profiles: [makeProfile("default", { interests: ["Japan"] })],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new StaticProvider([makeContentItem("default-japan", "Default Japan item", "https://example.com/default-japan")])],
      () => new Date("2026-06-22T00:00:00.000Z")
    );
    const selector = new ApiCatalogSelector([]);

    const result = await callTool(storage, generator, selector, "generate_newsletter_draft", {
      userMessage: "Japan newsletter",
      interests: ["Japan"],
      period: {
        start: "2026-06-15",
        end: "2026-06-23"
      }
    });

    const history = await storage.listHistory("default");
    expect(result.content[0].text).toContain("Default Japan item");
    expect(history).toHaveLength(1);
    expect(history[0].userId).toBe("default");
  });

  it("uses authenticated OAuth user id instead of tool-supplied userId", async () => {
    const storage = await createStorage({
      profiles: [
        makeProfile("oauth-user", { interests: ["Auth Topic"] }),
        makeProfile("attacker", { interests: ["Wrong Topic"] })
      ],
      categorySettings: {}
    });
    const generator = new NewsletterDraftGenerator(
      storage,
      [new StaticProvider([makeContentItem("auth-topic", "Auth Topic item", "https://example.com/auth-topic")])],
      () => new Date("2026-06-22T00:00:00.000Z")
    );
    const selector = new ApiCatalogSelector([]);
    const auth = {
      userId: "oauth-user",
      claims: { sub: "oauth-user" },
      scopes: []
    };

    await callTool(storage, generator, selector, "update_user_preferences", {
      userId: "attacker",
      patch: {
        regions: ["Seoul"]
      }
    }, auth);
    const result = await callTool(storage, generator, selector, "generate_newsletter_draft", {
      userId: "attacker",
      userMessage: "Make my newsletter",
      period: {
        start: "2026-06-15",
        end: "2026-06-23"
      }
    }, auth);

    await expect(storage.getProfile("oauth-user")).resolves.toMatchObject({
      regions: ["Seoul"]
    });
    await expect(storage.getProfile("attacker")).resolves.toMatchObject({
      regions: []
    });
    await expect(storage.listHistory("oauth-user")).resolves.toHaveLength(1);
    await expect(storage.listHistory("attacker")).resolves.toHaveLength(0);
    expect(result.content[0].text).toContain("Auth Topic item");
  });

  it("limits user resources to the authenticated OAuth user", async () => {
    const storage = await createStorage({
      profiles: [
        makeProfile("oauth-user"),
        makeProfile("other-user")
      ],
      categorySettings: {}
    });
    const auth = {
      userId: "oauth-user",
      claims: { sub: "oauth-user" },
      scopes: []
    };

    const resources = await listResources(storage, auth);
    const resourceText = JSON.stringify(resources);

    expect(resourceText).toContain("oauth-user");
    expect(resourceText).not.toContain("other-user");
    await expect(readResource(storage, "newsletter://profiles/other-user", auth)).rejects.toThrow(
      "Authenticated user cannot access another user's newsletter resource."
    );
  });

  it("accepts only MCP protocol versions in the required supported range", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2025-03-26", "2025-06-18", "2025-11-25"]);
    expect(isSupportedProtocolVersion("2025-03-26")).toBe(true);
    expect(isSupportedProtocolVersion("2025-06-18")).toBe(true);
    expect(isSupportedProtocolVersion("2025-11-25")).toBe(true);
    expect(isSupportedProtocolVersion("2024-11-05")).toBe(false);
    expect(isSupportedProtocolVersion("2026-01-01")).toBe(false);
  });

  it("does not expose server or tool names containing the forbidden brand string", () => {
    const forbidden = new RegExp(["ka", "ka", "o"].join(""), "i");
    expect("chat-newsletter-mcp").not.toMatch(forbidden);
    for (const tool of listTools().tools) {
      expect(tool.name).not.toMatch(forbidden);
    }
  });

  it("does not expose search provider internals as direct tools", () => {
    const toolNames = listTools().tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("search_web");
    expect(toolNames).not.toContain("google_search");
    expect(toolNames).not.toContain("ocr_image");
    expect(toolNames).not.toContain("fetch_emails");
    expect(toolNames).not.toContain("upload_to_s3");
  });

  it("exposes tool metadata that satisfies integration policy constraints", () => {
    const tools = listTools().tools;
    const toolNames = tools.map((tool) => tool.name);
    const serviceName = "Chat Newsletter MCP(채팅 뉴스레터 MCP)";
    const validToolName = /^[A-Za-z0-9_-]{1,128}$/;
    const expectedServiceName = "Chat Newsletter MCP(\uCC44\uD305 \uB274\uC2A4\uB808\uD130 MCP)";

    expect(tools.length).toBeGreaterThanOrEqual(3);
    expect(tools.length).toBeLessThanOrEqual(10);
    expect(new Set(toolNames).size).toBe(toolNames.length);

    for (const tool of tools) {
      expect(tool.name).toMatch(validToolName);
      expect(tool.description.length).toBeLessThanOrEqual(1024);
      expect(tool.description).toContain(expectedServiceName);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean)
        })
      );
    }
  });
});

class StaticProvider implements ContentProvider {
  readonly name = "static";

  constructor(private readonly items: ContentItem[]) {}

  async search(_input: ContentSearchInput): Promise<ContentProviderResult> {
    return {
      items: this.items,
      warnings: []
    };
  }
}

class RecordingProvider implements ContentProvider {
  readonly name = "recording";
  readonly calls: ContentSearchInput[] = [];

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    this.calls.push(input);
    const label = input.interests.join("/") || "empty";
    return {
      items: [
        {
          id: `recording-${this.calls.length}`,
          type: "news",
          title: `검색 결과: ${label}`,
          summary: `${label} 검색 결과 요약`,
          url: `https://example.com/${encodeURIComponent(label)}`,
          sourceName: "Recording Provider",
          publishedAt: input.period.end,
          interestTags: input.interests,
          regions: input.regions,
          keywords: input.keywords,
          evidence: [`${label} evidence`],
          sourceReliability: 0.8
        }
      ],
      warnings: []
    };
  }
}

async function createStorage(input: {
  profiles?: UserProfile[];
  templates?: NewsletterTemplate[];
  categorySettings?: Record<string, InterestTagSetting[]>;
}) {
  const dir = await mkdtemp(path.join(tmpdir(), "newsletter-mcp-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "profiles.json"), JSON.stringify({ profiles: input.profiles ?? [] }, null, 2));
  await writeFile(
    path.join(dir, "templates.json"),
    JSON.stringify({ templates: input.templates ?? [defaultTemplate()] }, null, 2)
  );
  await writeFile(
    path.join(dir, "categorySettings.json"),
    JSON.stringify({ settings: input.categorySettings ?? {} }, null, 2)
  );
  await writeFile(path.join(dir, "history.json"), JSON.stringify({ history: [] }, null, 2));
  return new JsonFileStorage(dir);
}

function makeProfile(userId: string, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId,
    interests: [],
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
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides
  };
}

function defaultTemplate(): NewsletterTemplate {
  return {
    templateId: "default_weekly",
    name: "Default Weekly Newsletter",
    sections: [
      { id: "top_stories", title: "오늘 주요 소식", description: "주요 소식", maxItems: 5 },
      { id: "key_dates", title: "주요 일정", description: "일정", maxItems: 5 },
      { id: "deep_dive", title: "상세 해설", description: "상세 해설", maxItems: 2 },
      { id: "recommendations", title: "관련 행사/장소/도서 추천", description: "추천", maxItems: 5 }
    ]
  };
}

function makeContentItem(id: string, title: string, url: string): ContentItem {
  return {
    id,
    type: "news",
    title,
    summary: `${title} summary`,
    url,
    sourceName: "Static Source",
    publishedAt: "2026-06-22",
    interestTags: ["테스트"],
    regions: [],
    keywords: ["테스트"],
    evidence: [`${title} evidence`],
    sourceReliability: 0.8
  };
}
