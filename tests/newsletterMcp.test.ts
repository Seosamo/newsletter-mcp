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
import { NewsletterDraftGenerator } from "../src/pipeline/draftGenerator.js";
import { isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocolVersion.js";
import { listTools } from "../src/mcp/toolHandlers.js";
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
