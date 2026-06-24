import { describe, expect, it } from "vitest";
import type { ContentSearchInput } from "../src/domain/types.js";
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
    expect(result.warnings[0]).toContain("BRAVE_SEARCH_API_KEY");
  });
});

const fakeSearchFetch: FetchLike = async (url) => {
  expect(url).toContain("api.search.brave.com");
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        web: {
          results: [
            {
              title: "Japan visa fees rise",
              url: "https://example.com/news/japan",
              description: "Japan announced a visa fee hike.",
              profile: { name: "Example News" }
            }
          ]
        }
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
