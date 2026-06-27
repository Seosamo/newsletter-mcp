import { describe, expect, it } from "vitest";
import type { ContentSearchInput } from "../src/domain/types.js";
import { ExternalMcpSearchProvider, selectTemporaryMiddleChunks, type ExternalMcpToolCall, type PageTextChunk } from "../src/providers/ExternalMcpSearchProvider.js";
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
      publishedAt: "2026-06-22",
      interestTags: ["Japan"],
      regions: ["Japan"]
    });
    expect(result.items[0].evidence.join(" ")).toContain("inbound travelers");
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
                  "Middle chunk says semiconductor demand increased exports.",
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
    expect(result.items[0].summary).toContain("Selected page chunks:");
    expect(result.items[0].summary).toContain("[Page chunk 2/3] Middle chunk says semiconductor demand increased exports.");
    expect(result.items[0].summary).not.toContain("Opening context only");
    expect(result.items[0].evidence.join(" ")).toContain("semiconductor demand");
    expect(result.items[0].sourceReliability).toBeGreaterThanOrEqual(0.7);
  });

  it("temporarily selects the middle page chunks", () => {
    const chunks: PageTextChunk[] = Array.from({ length: 5 }, (_, index) => ({
      index,
      total: 5,
      text: `chunk-${index}`
    }));

    expect(selectTemporaryMiddleChunks(chunks, 1).map((chunk) => chunk.index)).toEqual([2]);
    expect(selectTemporaryMiddleChunks(chunks, 2).map((chunk) => chunk.index)).toEqual([1, 2]);
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
