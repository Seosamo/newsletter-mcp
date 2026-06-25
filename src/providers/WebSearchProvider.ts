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
  topic?: "general" | "news" | "finance";
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  includeRawContent?: boolean | "markdown" | "text";
};

type TavilySearchResponse = {
  results?: TavilySearchResult[];
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  published_date?: string;
  score?: number;
};

export class WebSearchProvider implements ContentProvider {
  readonly name = "tavily-search";
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
  private readonly topic: "general" | "news" | "finance";
  private readonly searchDepth: "basic" | "advanced" | "fast" | "ultra-fast";
  private readonly includeRawContent: boolean | "markdown" | "text";

  constructor(options: WebSearchProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "https://api.tavily.com/search";
    this.fetchFn = options.fetchFn ?? fetch;
    this.articleExtractor = options.articleExtractor ?? new HtmlArticleExtractor();
    this.maxResults = options.maxResults ?? 6;
    this.maxPagesToExtract = options.maxPagesToExtract ?? 3;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.extractHtml = options.extractHtml ?? true;
    this.allowedDomains = normalizeDomains(options.allowedDomains ?? []);
    this.blockedDomains = normalizeDomains(options.blockedDomains ?? []);
    this.topic = options.topic ?? "news";
    this.searchDepth = options.searchDepth ?? "basic";
    this.includeRawContent = options.includeRawContent ?? false;
  }

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    if (!this.apiKey) {
      return {
        items: [],
        warnings: ["Tavily search provider is disabled because TAVILY_API_KEY is not configured."]
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
      const publishedAt = extracted?.publishedAt ?? toDateOnly(result.published_date);
      if (publishedAt && !isWithinPeriod(publishedAt, input.period.start, input.period.end)) {
        continue;
      }

      const title = extracted?.title ?? cleanText(result.title) ?? result.title;
      const summary = firstNonEmpty([
        extracted?.description,
        cleanText(result.content),
        extracted?.text.slice(0, 280)
      ]) ?? title;
      const evidence = [
        summary,
        ...(result.raw_content ? [cleanText(result.raw_content)?.slice(0, 1200) ?? ""] : []),
        ...(extracted?.text ? [extracted.text.slice(0, 1200)] : [])
      ].filter(Boolean);
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
        sourceName: extracted?.sourceName ?? sourceNameFromUrl(result.url),
        publishedAt,
        interestTags: matchedInterests.length > 0 ? matchedInterests : input.interests,
        regions: matchedRegions,
        keywords: matchedKeywords.length > 0 ? matchedKeywords : input.keywords,
        evidence,
        sourceReliability: extracted ? 0.74 : 0.68
      });
    }

    return { items, warnings };
  }

  private async fetchSearchResults(
    query: string,
    input: ContentSearchInput,
    warnings: string[]
  ): Promise<TavilySearchResult[]> {
    const url = new URL(this.endpoint);
    const body = {
      query,
      search_depth: this.searchDepth,
      max_results: this.maxResults,
      topic: this.topic,
      start_date: input.period.start,
      end_date: input.period.end,
      include_answer: false,
      include_raw_content: this.includeRawContent,
      include_images: false,
      include_domains: this.allowedDomains.length > 0 ? this.allowedDomains : undefined,
      exclude_domains: this.blockedDomains.length > 0 ? this.blockedDomains : undefined
    };

    try {
      const response = await this.fetchFn(url.toString(), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        method: "POST",
        body: JSON.stringify(body),
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

      const responseBody = await response.json() as TavilySearchResponse;
      return (responseBody.results ?? []).slice(0, this.maxResults);
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
