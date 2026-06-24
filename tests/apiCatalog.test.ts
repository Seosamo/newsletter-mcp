import { describe, expect, it } from "vitest";
import { ApiCatalogSelector } from "../src/catalog/ApiCatalogSelector.js";
import { parseApiCatalogMarkdown } from "../src/catalog/apiCatalogParser.js";
import type { ApiCatalogEntry } from "../src/catalog/types.js";
import { PublicApiDomainProvider } from "../src/providers/PublicApiDomainProvider.js";
import type { FetchLike } from "../src/providers/HtmlArticleExtractor.js";

describe("API catalog parser and selector", () => {
  it("parses markdown table entries into catalog records", () => {
    const markdown = [
      "### Events",
      "| API | Description | Auth | HTTPS | CORS |",
      "| :--- | --- | :---: | :---: | :---: |",
      "| [Eventbrite](https://www.eventbrite.com/platform/api/) | Event discovery API | `OAuth` | Yes | Unknown |"
    ].join("\n");

    const entries = parseApiCatalogMarkdown(markdown, "global");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "Eventbrite",
      category: "events",
      auth: "OAuth",
      https: "Yes",
      cors: "Unknown",
      connectorId: "eventbrite"
    });
  });

  it("ranks relevant cultural and tourism APIs for exhibition interests", () => {
    const selector = new ApiCatalogSelector(makeCatalogEntries(), {
      tourapi: ["TOUR_API_KEY"],
      eventbrite: ["EVENTBRITE_TOKEN"]
    });

    const recommendations = selector.select({
      userId: "default",
      interests: ["exhibition", "tourism"],
      regions: ["Seoul"],
      keywords: ["museum"]
    });

    expect(recommendations[0].entry.connectorId).toBe("tourapi");
    expect(recommendations[0].supported).toBe(true);
    expect(recommendations[0].callable).toBe(false);
    expect(recommendations[0].requiresConfig).toEqual(["TOUR_API_KEY"]);
  });

  it("marks configured event connectors as callable", () => {
    const selector = new ApiCatalogSelector(makeCatalogEntries(), {
      eventbrite: []
    });

    const recommendations = selector.select({
      userId: "default",
      interests: ["event"],
      regions: ["Tokyo"],
      keywords: ["conference"]
    });

    const eventbrite = recommendations.find((item) => item.entry.connectorId === "eventbrite");
    expect(eventbrite?.callable).toBe(true);
  });
});

describe("PublicApiDomainProvider", () => {
  it("normalizes configured domain connector results into ContentItem records", async () => {
    const provider = new PublicApiDomainProvider({
      catalogEntries: makeCatalogEntries().filter((entry) => entry.connectorId === "eventbrite"),
      env: {
        EVENTBRITE_TOKEN: "test-token"
      },
      fetchFn: fakeEventbriteFetch
    });

    const result = await provider.search({
      userId: "default",
      interests: ["event"],
      regions: ["Seoul"],
      keywords: ["conference"],
      sourceHints: [],
      excludedKeywords: [],
      period: {
        start: "2026-06-17",
        end: "2026-06-24"
      }
    });

    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: "event",
      title: "Seoul AI Conference",
      sourceName: "Eventbrite",
      eventDate: "2026-06-21",
      interestTags: ["event"]
    });
  });

  it("skips supported connectors when required configuration is missing", async () => {
    const provider = new PublicApiDomainProvider({
      catalogEntries: makeCatalogEntries().filter((entry) => entry.connectorId === "eventbrite"),
      env: {},
      fetchFn: fakeEventbriteFetch
    });

    const result = await provider.search({
      userId: "default",
      interests: ["event"],
      regions: ["Seoul"],
      keywords: ["conference"],
      sourceHints: [],
      excludedKeywords: [],
      period: {
        start: "2026-06-17",
        end: "2026-06-24"
      }
    });

    expect(result.items).toEqual([]);
    expect(result.warnings[0]).toContain("EVENTBRITE_TOKEN");
  });
});

const fakeEventbriteFetch: FetchLike = async (url, init) => {
  expect(url).toContain("eventbriteapi.com");
  expect(init?.headers).toMatchObject({
    authorization: "Bearer test-token"
  });
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        events: [
          {
            name: { text: "Seoul AI Conference" },
            description: { text: "A conference for AI builders in Seoul." },
            url: "https://example.com/events/seoul-ai",
            start: { local: "2026-06-21T10:00:00" }
          }
        ]
      };
    },
    async text() {
      return "";
    }
  };
};

function makeCatalogEntries(): ApiCatalogEntry[] {
  return [
    {
      id: "tourapi",
      name: "Korea Tourism Organization TourAPI",
      category: "culture-tourism",
      description: "Tourist attractions, festivals, exhibitions, and travel information.",
      url: "https://api.visitkorea.or.kr",
      auth: "apiKey",
      https: "Yes",
      cors: "Unknown",
      source: "seed",
      keywords: ["tourism", "exhibition", "festival", "museum"],
      connectorId: "tourapi"
    },
    {
      id: "eventbrite",
      name: "Eventbrite",
      category: "events",
      description: "Event discovery API for events, venues, and organizers.",
      url: "https://www.eventbrite.com/platform/api/",
      auth: "OAuth",
      https: "Yes",
      cors: "Unknown",
      source: "seed",
      keywords: ["event", "conference", "venue"],
      connectorId: "eventbrite"
    }
  ];
}
