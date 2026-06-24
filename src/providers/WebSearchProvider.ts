import { createHash } from "node:crypto";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../domain/types.js";
import type { ContentProvider } from "./ContentProvider.js";
import { type FetchLike, HtmlArticleExtractor } from "./HtmlArticleExtractor.js";

type WebSearchProviderOptions = {
  apiKey?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  articleExtractor?: HtmlArticleExtractor;
  maxResults?: number;
  maxPagesToExtract?: number;
  timeoutMs?: number;
  extractHtml?: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  profile?: {
    name?: string;
  };
};

export class WebSearchProvider implements ContentProvider {
  readonly name = "web-search";
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly fetchFn: FetchLike;
  private readonly articleExtractor: HtmlArticleExtractor;
  private readonly maxResults: number;
  private readonly maxPagesToExtract: number;
  private readonly timeoutMs: number;
  private readonly extractHtml: boolean;
  private readonly allowedDomains: string[];
  private readonly blockedDomains: string[];

  constructor(options: WebSearchProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
    this.fetchFn = options.fetchFn ?? fetch;
    this.articleExtractor = options.articleExtractor ?? new HtmlArticleExtractor();
    this.maxResults = options.maxResults ?? 6;
    this.maxPagesToExtract = options.maxPagesToExtract ?? 3;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.extractHtml = options.extractHtml ?? true;
    this.allowedDomains = normalizeDomains(options.allowedDomains ?? []);
    this.blockedDomains = normalizeDomains(options.blockedDomains ?? []);
  }

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    if (!this.apiKey) {
      return {
        items: [],
        warnings: ["Web search provider is disabled because BRAVE_SEARCH_API_KEY is not configured."]
      };
    }

    const query = buildQuery(input);
    if (!query) {
      return {
        items: [],
        warnings: ["Web search provider skipped because no query terms were available."]
      };
    }

    const warnings: string[] = [];
    const searchResults = await this.fetchSearchResults(query, input, warnings);
    const items: ContentItem[] = [];

    for (const [index, result] of searchResults.entries()) {
      if (!result.url || !result.title || !isHttpUrl(result.url)) {
        continue;
      }
      if (!this.isDomainAllowed(result.url)) {
        continue;
      }

      const extracted = this.extractHtml && index < this.maxPagesToExtract
        ? await this.tryExtract(result.url, warnings)
        : undefined;
      const publishedAt = extracted?.publishedAt ?? toDateOnly(result.age);
      if (publishedAt && !isWithinPeriod(publishedAt, input.period.start, input.period.end)) {
        continue;
      }

      const title = extracted?.title ?? cleanText(result.title) ?? result.title;
      const summary = firstNonEmpty([
        extracted?.description,
        cleanText(result.description),
        extracted?.text.slice(0, 280)
      ]) ?? title;
      const evidence = [
        summary,
        ...(extracted?.text ? [extracted.text.slice(0, 1200)] : [])
      ];
      const searchable = `${title} ${summary} ${extracted?.text ?? ""}`.toLocaleLowerCase();
      const matchedInterests = input.interests.filter((interest) => searchable.includes(interest.toLocaleLowerCase()));
      const matchedKeywords = input.keywords.filter((keyword) => searchable.includes(keyword.toLocaleLowerCase()));
      const matchedRegions = input.regions.filter((region) => searchable.includes(region.toLocaleLowerCase()));

      items.push({
        id: contentId(result.url),
        type: "news",
        title,
        summary,
        url: result.url,
        sourceName: extracted?.sourceName ?? result.profile?.name ?? sourceNameFromUrl(result.url),
        publishedAt,
        interestTags: matchedInterests.length > 0 ? matchedInterests : input.interests,
        regions: matchedRegions,
        keywords: matchedKeywords.length > 0 ? matchedKeywords : input.keywords,
        evidence,
        sourceReliability: extracted ? 0.72 : 0.66
      });
    }

    return { items, warnings };
  }

  private async fetchSearchResults(
    query: string,
    input: ContentSearchInput,
    warnings: string[]
  ): Promise<BraveSearchResult[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.maxResults));
    url.searchParams.set("freshness", freshnessForPeriod(input.period.start, input.period.end));

    try {
      const response = await this.fetchFn(url.toString(), {
        headers: {
          accept: "application/json",
          "x-subscription-token": this.apiKey ?? ""
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        warnings.push(`Web search failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);
        return [];
      }
      if (!response.json) {
        warnings.push("Web search failed because the response did not expose a JSON reader.");
        return [];
      }

      const body = await response.json() as BraveSearchResponse;
      return (body.web?.results ?? []).slice(0, this.maxResults);
    } catch (error) {
      warnings.push(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async tryExtract(url: string, warnings: string[]) {
    try {
      return await this.articleExtractor.extract(url);
    } catch (error) {
      warnings.push(`HTML extraction failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private isDomainAllowed(url: string): boolean {
    const hostname = sourceNameFromUrl(url).toLocaleLowerCase();
    if (this.blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return false;
    }
    if (this.allowedDomains.length === 0) {
      return true;
    }
    return this.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  }
}

function buildQuery(input: ContentSearchInput): string {
  return unique([
    ...input.interests,
    ...input.regions,
    ...input.keywords
  ])
    .slice(0, 12)
    .join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function freshnessForPeriod(start: string, end: string): "pd" | "pw" | "pm" | "py" {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
  const days = Number.isNaN(startMs) || Number.isNaN(endMs)
    ? 30
    : Math.max(Math.round((endMs - startMs) / 86_400_000), 1);

  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  return "py";
}

function contentId(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function cleanText(value: string | undefined): string | undefined {
  return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0);
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function sourceNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
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

function normalizeDomains(domains: string[]): string[] {
  return domains
    .map((domain) => domain.trim().toLocaleLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}
