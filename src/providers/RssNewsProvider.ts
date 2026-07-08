import { createHash } from "node:crypto";
import Parser from "rss-parser";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../domain/types.js";
import type { ContentProvider } from "./ContentProvider.js";
import { preferredRssUrls } from "../sources/sourcePreferences.js";

type RssItem = {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  pubDate?: string;
  isoDate?: string;
  enclosure?: {
    url?: string;
    type?: string;
  };
  image?: {
    url?: string;
  };
};

export class RssNewsProvider implements ContentProvider {
  readonly name = "rss-news";
  private readonly parser = new Parser<Record<string, unknown>, RssItem>();

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    const rssUrls = [...new Set([
      ...input.sourceHints.filter((hint) => /^https?:\/\//i.test(hint)),
      ...preferredRssUrls(input.sourcePreferences)
    ])];
    const items: ContentItem[] = [];
    const warnings: string[] = [];

    for (const url of rssUrls) {
      try {
        const feed = await this.parser.parseURL(url);
        const feedItems = feed.items ?? [];
        for (const item of feedItems) {
          const title = item.title?.trim();
          if (!title) {
            continue;
          }

          const summary = (item.contentSnippet ?? item.content ?? "").trim();
          const publishedAt = toDateOnly(item.isoDate ?? item.pubDate);
          if (publishedAt && !isWithinPeriod(publishedAt, input.period.start, input.period.end)) {
            continue;
          }

          const searchable = `${title} ${summary}`.toLocaleLowerCase();
          const matchedInterests = input.interests.filter((interest) =>
            searchable.includes(interest.toLocaleLowerCase())
          );
          const matchedKeywords = input.keywords.filter((keyword) =>
            searchable.includes(keyword.toLocaleLowerCase())
          );
          const matchedRegions = input.regions.filter((region) =>
            searchable.includes(region.toLocaleLowerCase())
          );

          if (input.keywords.length > 0 && matchedKeywords.length === 0 && matchedInterests.length === 0) {
            continue;
          }

          items.push({
            id: contentId(url, item.link ?? title),
            type: "news",
            title,
            summary: summary || title,
            url: item.link,
            sourceName: feed.title ?? url,
            imageUrl: pickRssImageUrl(item),
            imageAlt: pickRssImageUrl(item) ? title : undefined,
            publishedAt,
            interestTags: matchedInterests.length > 0 ? matchedInterests : input.interests,
            regions: matchedRegions,
            keywords: matchedKeywords,
            evidence: [summary || title],
            sourceReliability: 0.75
          });
        }
      } catch (error) {
        warnings.push(`RSS provider failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { items, warnings };
  }
}

function pickRssImageUrl(item: RssItem): string | undefined {
  const enclosureUrl = item.enclosure?.type?.startsWith("image/") ? item.enclosure.url : undefined;
  return firstHttpUrl([item.image?.url, enclosureUrl]);
}

function firstHttpUrl(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
}

function contentId(source: string, value: string): string {
  return createHash("sha1").update(`${source}:${value}`).digest("hex").slice(0, 16);
}

function toDateOnly(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function isWithinPeriod(dateOnly: string, start: string, end: string): boolean {
  return dateOnly >= start && dateOnly <= end;
}
