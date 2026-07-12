import { createHash } from "node:crypto";
import type { ApiCatalogEntry, ApiConnectorRecommendation } from "../catalog/types.js";
import { ApiCatalogSelector, type ConnectorConfigState } from "../catalog/ApiCatalogSelector.js";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../domain/types.js";
import type { ContentProvider } from "./ContentProvider.js";
import type { FetchLike } from "./HtmlArticleExtractor.js";

type PublicApiDomainProviderOptions = {
  catalogEntries: ApiCatalogEntry[];
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  maxConnectors?: number;
  timeoutMs?: number;
};

type DomainConnectorAdapter = {
  id: string;
  label: string;
  requiredEnv: string[];
  isConfigured(): boolean;
  search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]>;
};

export class PublicApiDomainProvider implements ContentProvider {
  readonly name = "public-api-domain";
  private readonly adapters: Map<string, DomainConnectorAdapter>;
  private readonly selector: ApiCatalogSelector;
  private readonly maxConnectors: number;

  constructor(options: PublicApiDomainProviderOptions) {
    const env = options.env ?? process.env;
    const fetchFn = options.fetchFn ?? fetch;
    const timeoutMs = options.timeoutMs ?? 8000;
    const adapters = [
      new TourApiAdapter(env, fetchFn, timeoutMs),
      new CultureInfoAdapter(env, fetchFn, timeoutMs),
      new EventbriteAdapter(env, fetchFn, timeoutMs),
      new TicketmasterAdapter(env, fetchFn, timeoutMs),
      new KmaWeatherAdapter(env, fetchFn, timeoutMs),
      new OpenAqAdapter(env, fetchFn, timeoutMs)
    ];

    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.selector = new ApiCatalogSelector(options.catalogEntries, buildConnectorConfigState(adapters));
    this.maxConnectors = options.maxConnectors ?? 3;
  }

  getConnectorConfigState(): ConnectorConfigState {
    return buildConnectorConfigState([...this.adapters.values()]);
  }

  async search(input: ContentSearchInput): Promise<ContentProviderResult> {
    const recommendations = this.selector
      .select({
        userId: input.userId,
        interests: input.interests,
        regions: input.regions,
        keywords: input.keywords,
        period: input.period
      }, 10)
      .filter((recommendation) => recommendation.callable);

    const warnings: string[] = [];
    const items: ContentItem[] = [];

    for (const recommendation of recommendations.slice(0, this.maxConnectors)) {
      const connectorId = recommendation.entry.connectorId;
      if (!connectorId) {
        continue;
      }

      const adapter = this.adapters.get(connectorId);
      if (!adapter) {
        continue;
      }

      try {
        items.push(...await adapter.search(input, recommendation));
      } catch (error) {
        warnings.push(`${adapter.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { items, warnings };
  }
}

export function buildConnectorConfigState(adapters: DomainConnectorAdapter[]): ConnectorConfigState {
  return Object.fromEntries(adapters.map((adapter) => [
    adapter.id,
    adapter.isConfigured() ? [] : adapter.requiredEnv
  ]));
}

abstract class BaseJsonAdapter implements DomainConnectorAdapter {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly requiredEnv: string[];

  constructor(
    protected readonly env: NodeJS.ProcessEnv,
    protected readonly fetchFn: FetchLike,
    protected readonly timeoutMs: number
  ) {}

  isConfigured(): boolean {
    return this.requiredEnv.every((key) => Boolean(this.env[key]));
  }

  protected async fetchJson(url: URL, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.fetchFn(url.toString(), {
      headers: {
        accept: "application/json",
        ...headers
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }

    if (!response.json) {
      throw new Error("response did not expose a JSON reader");
    }

    return response.json();
  }

  protected toContentItems(
    apiName: string,
    rawItems: unknown[],
    input: ContentSearchInput,
    recommendation: ApiConnectorRecommendation,
    type: ContentItem["type"] = "event"
  ): ContentItem[] {
    return rawItems.slice(0, 10).map((raw, index) => {
      const title = pickString(raw, ["title", "name", "eventName", "fstvlNm", "addr1", "contenttitle"]) ??
        `${apiName} item ${index + 1}`;
      const summary = pickString(raw, ["description", "summary", "overview", "eventDescription", "addr2", "content"]) ??
        recommendation.entry.description;
      const url = pickString(raw, ["url", "link", "eventUrl", "homepage", "firstimage", "contenturl"]);
      const date = toDateOnly(pickString(raw, [
        "start",
        "start.local",
        "start.utc",
        "startDate",
        "eventStartDate",
        "eventstartdate",
        "dates.start.localDate",
        "dates.start.dateTime",
        "datetime",
        "created"
      ]));

      return {
        id: contentId(apiName, url ?? title),
        type,
        title: cleanText(title),
        summary: cleanText(summary),
        url,
        sourceName: apiName,
        publishedAt: type === "news" ? date : undefined,
        eventDate: type === "event" ? date : undefined,
        interestTags: input.interests,
        regions: input.regions,
        keywords: input.keywords,
        evidence: [cleanText(summary)],
        sourceReliability: 0.78
      };
    });
  }

  abstract search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]>;
}

class TourApiAdapter extends BaseJsonAdapter {
  readonly id = "tourapi";
  readonly label = "Korea Tourism Organization TourAPI";
  readonly requiredEnv = ["TOUR_API_KEY"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.TOUR_API_BASE_URL ?? "https://apis.data.go.kr/B551011/KorService2/searchKeyword2");
    url.searchParams.set("serviceKey", this.env.TOUR_API_KEY ?? "");
    url.searchParams.set("MobileOS", "ETC");
    url.searchParams.set("MobileApp", "ChatNewsletterMCP");
    url.searchParams.set("_type", "json");
    url.searchParams.set("numOfRows", "10");
    url.searchParams.set("keyword", buildQuery(input));
    const body = await this.fetchJson(url);
    return this.toContentItems(this.label, extractArray(body, ["response.body.items.item", "items", "data"]), input, recommendation, "event");
  }
}

class CultureInfoAdapter extends BaseJsonAdapter {
  readonly id = "culture_info";
  readonly label = "Korea Culture Information API";
  readonly requiredEnv = ["CULTURE_INFO_API_URL", "CULTURE_INFO_API_KEY"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.CULTURE_INFO_API_URL ?? "");
    url.searchParams.set("serviceKey", this.env.CULTURE_INFO_API_KEY ?? "");
    url.searchParams.set("keyword", buildQuery(input));
    const body = await this.fetchJson(url);
    return this.toContentItems(this.label, extractArray(body, ["response.body.items.item", "items", "data", "result"]), input, recommendation, "event");
  }
}

class EventbriteAdapter extends BaseJsonAdapter {
  readonly id = "eventbrite";
  readonly label = "Eventbrite";
  readonly requiredEnv = ["EVENTBRITE_TOKEN"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.EVENTBRITE_API_URL ?? "https://www.eventbriteapi.com/v3/events/search/");
    url.searchParams.set("q", buildQuery(input));
    if (input.regions[0]) url.searchParams.set("location.address", input.regions[0]);
    url.searchParams.set("start_date.range_start", `${input.period.start}T00:00:00Z`);
    url.searchParams.set("start_date.range_end", `${input.period.end}T23:59:59Z`);
    const body = await this.fetchJson(url, { authorization: `Bearer ${this.env.EVENTBRITE_TOKEN}` });
    return this.toContentItems(this.label, extractArray(body, ["events", "data"]), input, recommendation, "event");
  }
}

class TicketmasterAdapter extends BaseJsonAdapter {
  readonly id = "ticketmaster";
  readonly label = "Ticketmaster Discovery API";
  readonly requiredEnv = ["TICKETMASTER_API_KEY"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.TICKETMASTER_API_URL ?? "https://app.ticketmaster.com/discovery/v2/events.json");
    url.searchParams.set("apikey", this.env.TICKETMASTER_API_KEY ?? "");
    url.searchParams.set("keyword", buildQuery(input));
    url.searchParams.set("startDateTime", `${input.period.start}T00:00:00Z`);
    url.searchParams.set("endDateTime", `${input.period.end}T23:59:59Z`);
    const body = await this.fetchJson(url);
    return this.toContentItems(this.label, extractArray(body, ["_embedded.events", "events", "data"]), input, recommendation, "event");
  }
}

class KmaWeatherAdapter extends BaseJsonAdapter {
  readonly id = "kma_weather";
  readonly label = "Korea Meteorological Administration Forecast API";
  readonly requiredEnv = ["KMA_API_URL", "KMA_API_KEY"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.KMA_API_URL ?? "");
    url.searchParams.set("serviceKey", this.env.KMA_API_KEY ?? "");
    url.searchParams.set("keyword", buildQuery(input));
    const body = await this.fetchJson(url);
    return this.toContentItems(this.label, extractArray(body, ["response.body.items.item", "items", "data"]), input, recommendation, "news");
  }
}

class OpenAqAdapter extends BaseJsonAdapter {
  readonly id = "openaq";
  readonly label = "OpenAQ";
  readonly requiredEnv = ["OPENAQ_API_KEY"];

  async search(input: ContentSearchInput, recommendation: ApiConnectorRecommendation): Promise<ContentItem[]> {
    const url = new URL(this.env.OPENAQ_API_URL ?? "https://api.openaq.org/v3/latest");
    url.searchParams.set("limit", "10");
    if (input.regions[0]) url.searchParams.set("city", input.regions[0]);
    const body = await this.fetchJson(url, { "x-api-key": this.env.OPENAQ_API_KEY ?? "" });
    return this.toContentItems(this.label, extractArray(body, ["results", "data"]), input, recommendation, "news");
  }
}

function buildQuery(input: ContentSearchInput): string {
  return [...new Set([...input.interests, ...input.regions, ...input.keywords].map((value) => value.trim()).filter(Boolean))]
    .slice(0, 10)
    .join(" ");
}

function extractArray(value: unknown, paths: string[]): unknown[] {
  for (const path of paths) {
    const result = getPath(value, path);
    if (Array.isArray(result)) {
      return result;
    }
  }
  return [];
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  for (const key of keys) {
    const result = getPath(value, key);
    if (typeof result === "string" && result.trim()) {
      return result;
    }
    if (typeof result === "object" && result !== null) {
      const text = (result as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  }
  return undefined;
}

function cleanText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
