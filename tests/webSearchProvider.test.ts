import { describe, expect, it } from "vitest";
import type { ContentSearchInput } from "../src/domain/types.js";
import { ExternalMcpSearchProvider, type ExternalMcpToolCall } from "../src/providers/ExternalMcpSearchProvider.js";
import { selectRelevantPageChunks, type PageTextChunk } from "../src/providers/evidenceChunks.js";
import { extractArticleFromHtml, HtmlArticleExtractor, type FetchLike } from "../src/providers/HtmlArticleExtractor.js";
import { WebSearchProvider } from "../src/providers/WebSearchProvider.js";

describe("WebSearchProvider", () => {
  it("extracts basic article metadata and text from HTML", () => {
    const article = extractArticleFromHtml("https://example.com/news/japan", `
      <html>
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="Japan visa fees rise" />
          <meta name="description" content="Authorities announced a visa fee hike." />
          <meta property="og:image" content="/images/japan-visa.jpg" />
          <meta property="article:published_time" content="2026-06-22T03:45:51Z" />
        </head>
        <body>
          <script>ignored()</script>
          <article>
            <h1>Japan visa fees rise</h1>
            <p>Japan announced changes to visa fees for inbound travelers.</p>
          </article>
        </body>
      </html>
    `);

    expect(article.title).toBe("Japan visa fees rise");
    expect(article.description).toBe("Authorities announced a visa fee hike.");
    expect(article.imageUrl).toBe("https://example.com/images/japan-visa.jpg");
    expect(article.publishedAt).toBe("2026-06-22");
    expect(article.text).toContain("Japan announced changes to visa fees");
  });

  it("converts search results and extracted HTML into content items", async () => {
    const provider = new WebSearchProvider({
      apiKey: "test-key",
      maxResults: 2,
      maxPagesToExtract: 1,
      fetchFn: fakeSearchFetch,
      articleExtractor: new HtmlArticleExtractor({ fetchFn: fakeArticleFetch })
    });

    const result = await provider.search(makeInput());

    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: "news",
      title: "Japan visa fees rise",
      sourceName: "example.com",
      imageUrl: "https://cdn.example.com/japan-visa.jpg",
      imageAlt: "Japan visa fees rise",
      publishedAt: "2026-06-22",
      interestTags: ["Japan"],
      regions: ["Japan"]
    });
    expect(result.items[0].evidence.join(" ")).toContain("inbound travelers");
  });

  it("keeps only relevant HTML body chunks as evidence for long articles", async () => {
    const provider = new WebSearchProvider({
      apiKey: "test-key",
      maxResults: 2,
      maxPagesToExtract: 1,
      pageChunkMaxChars: 160,
      pageChunkOverlapChars: 0,
      maxSelectedChunksPerPage: 1,
      maxSelectedChunksTotal: 1,
      fetchFn: fakeSearchFetch,
      articleExtractor: new HtmlArticleExtractor({ fetchFn: fakeLongArticleFetch, maxTextChars: 5000 })
    });

    const result = await provider.search(makeInput());

    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].summary).toContain("Japan announced changes to visa fees");
    expect(result.items[0].summary).not.toContain("Japan visa policy details appear here");
    expect(result.items[0].evidence.filter((item) => item.startsWith("[Page chunk "))).toHaveLength(1);
    expect(result.items[0].evidence.join(" ")).toContain("Japan visa policy details appear here");
    expect(result.items[0].evidence.join(" ")).not.toContain("Unrelated opening background repeats");
  });

  it("keeps snippet-based items when HTML extraction fails", async () => {
    const provider = new WebSearchProvider({
      apiKey: "test-key",
      maxResults: 2,
      maxPagesToExtract: 1,
      fetchFn: fakeSearchFetch,
      articleExtractor: new HtmlArticleExtractor({ fetchFn: failingArticleFetch })
    });

    const result = await provider.search(makeInput());

    expect(result.items).toHaveLength(1);
    expect(result.items[0].summary).toBe("Japan announced a visa fee hike.");
    expect(result.items[0].evidence).toEqual(["Japan announced a visa fee hike."]);
    expect(result.warnings.some((warning) => warning.includes("HTML extraction failed"))).toBe(true);
  });

  it("searches preferred domains first and falls back to general Tavily results", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = new WebSearchProvider({
      apiKey: "test-key",
      maxResults: 2,
      maxPagesToExtract: 0,
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(body);
        const includeDomains = body.include_domains as string[] | undefined;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: includeDomains?.includes("openai.com")
                ? [
                    {
                      title: "OpenAI platform update",
                      url: "https://openai.com/blog/platform",
                      content: "OpenAI released a platform update.",
                      published_date: "2026-06-22"
                    }
                  ]
                : [
                    {
                      title: "General AI market update",
                      url: "https://example.com/ai-market",
                      content: "AI market news from a general source.",
                      published_date: "2026-06-22"
                    }
                  ]
            };
          },
          async text() {
            return "";
          }
        };
      }
    });

    const result = await provider.search({
      ...makeInput(),
      interests: ["AI"],
      regions: [],
      keywords: ["AI"],
      sourcePreferences: [
        {
          label: "OpenAI Blog",
          domains: ["openai.com"],
          rssUrls: [],
          queryHints: ["site:openai.com"],
          weight: 1.5,
          enabled: true
        }
      ]
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      include_domains: ["openai.com"]
    });
    expect(String(calls[0].query)).toContain("site:openai.com");
    expect(calls[1].include_domains).toBeUndefined();
    expect(result.items.map((item) => item.sourceName)).toEqual(["openai.com", "example.com"]);
  });

  it("returns a warning instead of searching when no API key is configured", async () => {
    const provider = new WebSearchProvider({
      apiKey: undefined,
      fetchFn: fakeSearchFetch,
      articleExtractor: new HtmlArticleExtractor({ fetchFn: fakeArticleFetch })
    });

    const result = await provider.search(makeInput());

    expect(result.items).toEqual([]);
    expect(result.warnings[0]).toContain("TAVILY_API_KEY");
  });

  it("converts external MCP search results into content items", async () => {
    const calls: ExternalMcpToolCall[] = [];
    const provider = new ExternalMcpSearchProvider({
      command: "node",
      args: ["fake-search-server.js"],
      toolName: "google_search",
      queryParameter: "q",
      maxResultsParameter: "limit",
      maxResults: 2,
      toolCaller: async (call) => {
        calls.push(call);
        return {
          structuredContent: {
            results: [
              {
                title: "Japan economy update",
                url: "https://example.com/news/economy",
                snippet: "Japan economy data improved this week.",
                source: "Example Search"
              }
            ]
          }
        };
      }
    });

    const result = await provider.search(makeInput());

    expect(calls[0]).toMatchObject({
      command: "node",
      args: ["fake-search-server.js"],
      toolName: "google_search",
      toolArgs: {
        q: "Japan visa",
        limit: 2
      }
    });
    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Japan economy update",
      sourceName: "Example Search",
      interestTags: ["Japan"]
    });
  });

  it("runs preferred external MCP queries before general fallback queries", async () => {
    const calls: ExternalMcpToolCall[] = [];
    const provider = new ExternalMcpSearchProvider({
      command: "node",
      args: ["fake-search-server.js"],
      toolName: "google_search",
      queryParameter: "q",
      maxResultsParameter: "limit",
      maxResults: 2,
      toolCaller: async (call) => {
        calls.push(call);
        const query = String(call.toolArgs.q);
        return {
          structuredContent: {
            results: query.includes("site:openai.com")
              ? [
                  {
                    title: "OpenAI platform update",
                    url: "https://openai.com/blog/platform",
                    snippet: "OpenAI released a platform update.",
                    source: "OpenAI Blog"
                  }
                ]
              : [
                  {
                    title: "General AI update",
                    url: "https://example.com/ai",
                    snippet: "General AI news.",
                    source: "Example Search"
                  }
                ]
          }
        };
      }
    });

    const result = await provider.search({
      ...makeInput(),
      interests: ["AI"],
      regions: [],
      keywords: ["AI"],
      sourcePreferences: [
        {
          label: "OpenAI Blog",
          domains: ["openai.com"],
          rssUrls: [],
          queryHints: ["site:openai.com"],
          weight: 1.5,
          enabled: true
        }
      ]
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].toolArgs.q).toBe("AI site:openai.com");
    expect(calls[1].toolArgs.q).toBe("AI");
    expect(result.items.map((item) => item.sourceName)).toEqual(["OpenAI Blog", "Example Search"]);
  });

  it("passes configured noapi result limits and parses noapi text output", async () => {
    const calls: ExternalMcpToolCall[] = [];
    const provider = new ExternalMcpSearchProvider({
      command: "noapi-google-search-mcp",
      toolName: "google_search",
      maxResultsParameter: "num_results",
      maxResults: 6,
      toolCaller: async (call) => {
        calls.push(call);
        return {
          content: [
            {
              type: "text",
              text: [
                "Google Search Results for: Japan economy",
                "",
                "1. Japan economy grows",
                " URL: https://example.com/economy",
                " Japan economy data improved this week."
              ].join("\n")
            }
          ]
        };
      }
    });

    const result = await provider.search(makeInput());

    expect(calls[0].toolArgs).toMatchObject({
      query: "Japan visa",
      num_results: 6
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Japan economy grows",
      url: "https://example.com/economy",
      summary: "Japan economy data improved this week."
    });
  });

  it("enriches noapi search results with visited page content", async () => {
    const calls: ExternalMcpToolCall[] = [];
    const provider = new ExternalMcpSearchProvider({
      command: "noapi-google-search-mcp",
      toolName: "google_search",
      maxResultsParameter: "num_results",
      maxResults: 2,
      visitPageToolName: "visit_page",
      maxPagesToVisit: 1,
      pageChunkMaxChars: 80,
      pageChunkOverlapChars: 0,
      maxSelectedChunksPerPage: 1,
      maxSelectedChunksTotal: 1,
      toolCaller: async (call) => {
        calls.push(call);
        if (call.toolName === "visit_page") {
          return {
            content: [
              {
                type: "text",
                text: [
                  "Opening context only gives background for readers.",
                  "Middle chunk says Japan visa policy details changed for travelers.",
                  "Closing context only covers market reactions."
                ].join(" ")
              }
            ]
          };
        }
        return {
          structuredContent: {
            results: [
              {
                title: "Japan economy update",
                url: "https://example.com/news/economy",
                snippet: "Japan economy data improved this week.",
                source: "Example Search"
              }
            ]
          }
        };
      }
    });

    const result = await provider.search(makeInput());

    expect(calls.map((call) => call.toolName)).toEqual(["google_search", "visit_page"]);
    expect(calls[1].toolArgs).toEqual({
      url: "https://example.com/news/economy"
    });
    expect(result.warnings).toEqual([]);
    expect(result.items[0].summary).toContain("Japan economy data improved this week.");
    expect(result.items[0].summary).not.toContain("Selected page chunks:");
    expect(result.items[0].summary).not.toContain("Middle chunk says Japan visa policy");
    expect(result.items[0].evidence.join(" ")).toContain("[Page chunk ");
    expect(result.items[0].evidence.join(" ")).toContain("Middle chunk says Japan visa policy details changed");
    expect(result.items[0].summary).not.toContain("Opening context only");
    expect(result.items[0].sourceReliability).toBeGreaterThanOrEqual(0.7);
  });

  it("records a warning and keeps search result links when noapi page visits fail", async () => {
    const provider = new ExternalMcpSearchProvider({
      command: "noapi-google-search-mcp",
      toolName: "google_search",
      maxResultsParameter: "num_results",
      maxResults: 1,
      visitPageToolName: "visit_page",
      maxPagesToVisit: 1,
      toolCaller: async (call) => {
        if (call.toolName === "visit_page") {
          throw new Error("visit failed");
        }
        return {
          structuredContent: {
            results: [
              {
                title: "Japan economy update",
                url: "https://example.com/news/economy",
                snippet: "Japan economy data improved this week.",
                source: "Example Search"
              }
            ]
          }
        };
      }
    });

    const result = await provider.search(makeInput());

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Japan economy update",
      url: "https://example.com/news/economy"
    });
    expect(result.warnings.some((warning) => warning.includes("page visit failed"))).toBe(true);
  });

  it("selects chunks with the strongest query relevance", () => {
    const chunks: PageTextChunk[] = Array.from({ length: 5 }, (_, index) => ({
      index,
      total: 5,
      text: index === 3
        ? "This chunk mentions Japan visa updates, Japan travel, and visa policy details."
        : `chunk-${index} only has generic background.`
    }));

    expect(selectRelevantPageChunks(chunks, makeInput(), 1).map((chunk) => chunk.index)).toEqual([3]);
  });
});

const fakeSearchFetch: FetchLike = async (url, init) => {
  expect(url).toContain("api.tavily.com/search");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toMatchObject({
    authorization: "Bearer test-key",
    "content-type": "application/json"
  });
  expect(JSON.parse(String(init?.body))).toMatchObject({
    query: "Japan visa",
    max_results: 2,
    topic: "news",
    start_date: "2026-06-15",
    end_date: "2026-06-23"
  });
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        results: [
          {
            title: "Japan visa fees rise",
            url: "https://example.com/news/japan",
            content: "Japan announced a visa fee hike.",
            published_date: "2026-06-22"
          }
        ]
      };
    },
    async text() {
      return "";
    }
  };
};

const fakeArticleFetch: FetchLike = async (url) => {
  expect(url).toBe("https://example.com/news/japan");
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        return name.toLocaleLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
      }
    },
    async text() {
      return `
        <html>
          <head>
            <meta property="og:title" content="Japan visa fees rise" />
            <meta name="description" content="Japan announced changes to visa fees for inbound travelers." />
            <meta property="og:image" content="https://cdn.example.com/japan-visa.jpg" />
            <meta property="article:published_time" content="2026-06-22T03:45:51Z" />
          </head>
          <body>
            <article>
              <p>Japan announced changes to visa fees for inbound travelers.</p>
            </article>
          </body>
        </html>
      `;
    }
  };
};

const fakeLongArticleFetch: FetchLike = async (url) => {
  expect(url).toBe("https://example.com/news/japan");
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        return name.toLocaleLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
      }
    },
    async text() {
      return `
        <html>
          <head>
            <meta property="og:title" content="Japan visa fees rise" />
            <meta name="description" content="Japan announced changes to visa fees for inbound travelers." />
            <meta property="og:image" content="https://cdn.example.com/japan-visa.jpg" />
            <meta property="article:published_time" content="2026-06-22T03:45:51Z" />
          </head>
          <body>
            <article>
              <p>Unrelated opening background repeats with general tourism notes and market commentary.</p>
              <p>More unrelated opening background repeats with general tourism notes and market commentary.</p>
              <p>Japan visa policy details appear here. Japan visa applications and inbound traveler fees are the main update.</p>
              <p>Closing material covers reactions, unrelated exchange rates, and broad travel context.</p>
            </article>
          </body>
        </html>
      `;
    }
  };
};

const failingArticleFetch: FetchLike = async () => ({
  ok: false,
  status: 503,
  statusText: "Service Unavailable",
  async text() {
    return "";
  }
});

function makeInput(): ContentSearchInput {
  return {
    userId: "default",
    interests: ["Japan"],
    regions: ["Japan"],
    keywords: ["Japan", "visa"],
    sourceHints: [],
    excludedKeywords: [],
    period: {
      start: "2026-06-15",
      end: "2026-06-23"
    }
  };
}
