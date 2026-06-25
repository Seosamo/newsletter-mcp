import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentItem, ContentProviderResult, ContentSearchInput } from "../src/domain/types.js";
import { loadEnvFile } from "../src/config/loadEnv.js";
import { ExternalMcpSearchProvider } from "../src/providers/ExternalMcpSearchProvider.js";
import { WebSearchProvider } from "../src/providers/WebSearchProvider.js";

loadEnvFile(path.resolve(process.cwd(), ".env"));

const describeLiveComparison = process.env.RUN_SEARCH_COMPARISON === "true" ? describe : describe.skip;

describeLiveComparison("live generic search provider comparison", () => {
  it("compares Tavily and external Google MCP against the same query", async () => {
    assertLiveComparisonConfig();

    const input = makeInput();
    const maxResults = parseInteger(process.env.SEARCH_COMPARISON_MAX_RESULTS, 8);

    const tavily = new WebSearchProvider({
      apiKey: process.env.TAVILY_API_KEY,
      endpoint: process.env.TAVILY_SEARCH_API_URL,
      maxResults,
      maxPagesToExtract: 0,
      extractHtml: process.env.SEARCH_COMPARISON_EXTRACT_HTML === "true",
      topic: parseTavilyTopic(process.env.TAVILY_SEARCH_TOPIC),
      searchDepth: parseTavilySearchDepth(process.env.TAVILY_SEARCH_DEPTH),
      includeRawContent: parseTavilyRawContent(process.env.TAVILY_INCLUDE_RAW_CONTENT)
    });

    const externalMcpSearchUsesGeneric = Boolean(firstEnv("EXTERNAL_MCP_SEARCH_COMMAND"));
    const googleMcp = new ExternalMcpSearchProvider({
      command: firstEnv("EXTERNAL_MCP_SEARCH_COMMAND", "NOAPI_GOOGLE_SEARCH_COMMAND"),
      args: parseCommandArgs(searchEnv(externalMcpSearchUsesGeneric, "ARGS")),
      cwd: searchEnv(externalMcpSearchUsesGeneric, "CWD"),
      toolName: searchEnv(externalMcpSearchUsesGeneric, "TOOL_NAME") ?? defaultExternalMcpToolName(externalMcpSearchUsesGeneric),
      queryParameter: searchEnv(externalMcpSearchUsesGeneric, "QUERY_PARAM") ?? "query",
      maxResultsParameter: searchEnv(externalMcpSearchUsesGeneric, "MAX_RESULTS_PARAM") ?? defaultExternalMcpMaxResultsParameter(externalMcpSearchUsesGeneric),
      regionParameter: searchEnv(externalMcpSearchUsesGeneric, "REGION_PARAM"),
      maxResults,
      timeoutMs: parseInteger(firstEnv("EXTERNAL_MCP_SEARCH_TIMEOUT_MS", "WEB_SEARCH_TIMEOUT_MS"), 20_000)
    });

    const [tavilyResult, googleResult] = await Promise.all([
      tavily.search(input),
      googleMcp.search(input)
    ]);

    const report = buildComparisonReport(input, tavilyResult, googleResult);
    console.info(formatComparisonReport(report));

    expect(
      tavilyResult.items.length + googleResult.items.length,
      [
        "Both generic search providers returned no items.",
        `Query: ${report.query}`,
        `Period: ${report.period}`,
        `Tavily warnings: ${tavilyResult.warnings.join(" | ") || "(none)"}`,
        `Google MCP warnings: ${googleResult.warnings.join(" | ") || "(none)"}`,
        "Try SEARCH_COMPARISON_QUERY with broader wording, TAVILY_SEARCH_TOPIC=general, or an empty date range."
      ].join("\n")
    ).toBeGreaterThan(0);
  }, 60_000);
});

type ComparisonReport = {
  query: string;
  period: string;
  tavily: ProviderSummary;
  googleMcp: ProviderSummary;
  overlapUrls: string[];
  tavilyOnlyUrls: string[];
  googleOnlyUrls: string[];
};

type ProviderSummary = {
  count: number;
  warnings: string[];
  topDomains: Array<{ domain: string; count: number }>;
  topItems: Array<{ title: string; url?: string; sourceName?: string; date?: string }>;
};

function assertLiveComparisonConfig(): void {
  const missing: string[] = [];
  if (!process.env.TAVILY_API_KEY) {
    missing.push("TAVILY_API_KEY");
  }
  if (!firstEnv("EXTERNAL_MCP_SEARCH_COMMAND", "NOAPI_GOOGLE_SEARCH_COMMAND")) {
    missing.push("EXTERNAL_MCP_SEARCH_COMMAND or NOAPI_GOOGLE_SEARCH_COMMAND");
  }
  if (missing.length > 0) {
    throw new Error(
      [
        `Missing live search comparison configuration: ${missing.join(", ")}`,
        "Set RUN_SEARCH_COMPARISON=true plus Tavily and external Google MCP settings before running this test."
      ].join("\n")
    );
  }
}

function makeInput(): ContentSearchInput {
  const period = defaultPeriod();
  const query = process.env.SEARCH_COMPARISON_QUERY?.trim() || "latest Japan economy news";
  return {
    userId: "search-comparison",
    interests: [query],
    regions: [],
    keywords: [],
    sourceHints: [],
    excludedKeywords: parseCsv(process.env.SEARCH_COMPARISON_EXCLUDED_KEYWORDS, []),
    period: {
      start: process.env.SEARCH_COMPARISON_START ?? period.start,
      end: process.env.SEARCH_COMPARISON_END ?? period.end
    }
  };
}

function buildComparisonReport(
  input: ContentSearchInput,
  tavily: ContentProviderResult,
  googleMcp: ContentProviderResult
): ComparisonReport {
  const tavilyUrls = normalizedUrlSet(tavily.items);
  const googleUrls = normalizedUrlSet(googleMcp.items);
  const overlapUrls = [...tavilyUrls].filter((url) => googleUrls.has(url)).sort();

  return {
    query: input.interests[0] ?? "",
    period: `${input.period.start} ~ ${input.period.end}`,
    tavily: summarizeProvider(tavily),
    googleMcp: summarizeProvider(googleMcp),
    overlapUrls,
    tavilyOnlyUrls: [...tavilyUrls].filter((url) => !googleUrls.has(url)).sort(),
    googleOnlyUrls: [...googleUrls].filter((url) => !tavilyUrls.has(url)).sort()
  };
}

function summarizeProvider(result: ContentProviderResult): ProviderSummary {
  return {
    count: result.items.length,
    warnings: result.warnings,
    topDomains: topDomains(result.items),
    topItems: result.items.slice(0, 8).map((item) => ({
      title: item.title,
      url: item.url,
      sourceName: item.sourceName,
      date: item.publishedAt ?? item.eventDate
    }))
  };
}

function formatComparisonReport(report: ComparisonReport): string {
  return [
    "",
    "=== Search Provider Comparison ===",
    `Query: ${report.query}`,
    `Period: ${report.period}`,
    report.tavily.count === 0 || report.googleMcp.count === 0
      ? "Note: a provider returning 0 items can be a valid comparison result. Check warnings, query wording, topic, and date filters."
      : "Note: both providers returned at least one item.",
    "",
    formatProviderSummary("Tavily", report.tavily),
    "",
    formatProviderSummary("External Google MCP", report.googleMcp),
    "",
    `Overlap URLs (${report.overlapUrls.length}):`,
    ...formatUrlList(report.overlapUrls),
    "",
    `Tavily-only URLs (${report.tavilyOnlyUrls.length}):`,
    ...formatUrlList(report.tavilyOnlyUrls),
    "",
    `Google-MCP-only URLs (${report.googleOnlyUrls.length}):`,
    ...formatUrlList(report.googleOnlyUrls)
  ].join("\n");
}

function formatProviderSummary(label: string, summary: ProviderSummary): string {
  return [
    `${label}: ${summary.count} items`,
    `Warnings: ${summary.warnings.join(" | ") || "(none)"}`,
    `Top domains: ${summary.topDomains.map((item) => `${item.domain}(${item.count})`).join(", ") || "(none)"}`,
    ...summary.topItems.map((item, index) => {
      const meta = [item.sourceName, item.date].filter(Boolean).join(" / ");
      return `${index + 1}. ${item.title}${meta ? ` [${meta}]` : ""}${item.url ? `\n   ${item.url}` : ""}`;
    })
  ].join("\n");
}

function formatUrlList(urls: string[]): string[] {
  return urls.length > 0 ? urls.slice(0, 10).map((url) => `- ${url}`) : ["- (none)"];
}

function normalizedUrlSet(items: ContentItem): never;
function normalizedUrlSet(items: ContentItem[]): Set<string>;
function normalizedUrlSet(items: ContentItem | ContentItem[]): Set<string> | never {
  if (!Array.isArray(items)) {
    throw new Error("normalizedUrlSet expects an array");
  }
  return new Set(items.map((item) => item.url).filter((url): url is string => Boolean(url)).map(normalizeUrl));
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function topDomains(items: ContentItem[]): Array<{ domain: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.url) {
      continue;
    }
    const domain = sourceDomain(item.url);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain))
    .slice(0, 5);
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return parsed.length > 0 ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function searchEnv(usesGeneric: boolean, suffix: string): string | undefined {
  const genericKey = `EXTERNAL_MCP_SEARCH_${suffix}`;
  const noApiKey = `NOAPI_GOOGLE_SEARCH_${suffix}`;
  return usesGeneric ? firstEnv(genericKey, noApiKey) : firstEnv(noApiKey, genericKey);
}

function defaultExternalMcpToolName(usesGeneric: boolean): string {
  return usesGeneric ? "search" : "google_search";
}

function defaultExternalMcpMaxResultsParameter(usesGeneric: boolean): string {
  return usesGeneric ? "maxResults" : "num_results";
}

function parseCommandArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Search comparison command args JSON must be an array of strings.");
    }
    return parsed;
  }
  return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
}

function parseTavilyTopic(value: string | undefined): "general" | "news" | "finance" {
  return value === "general" || value === "finance" ? value : "news";
}

function parseTavilySearchDepth(value: string | undefined): "basic" | "advanced" | "fast" | "ultra-fast" {
  return value === "advanced" || value === "fast" || value === "ultra-fast" ? value : "basic";
}

function parseTavilyRawContent(value: string | undefined): boolean | "markdown" | "text" {
  if (value === "markdown" || value === "text") {
    return value;
  }
  return value === "true";
}

function defaultPeriod(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return {
    start: toDateOnly(start),
    end: toDateOnly(end)
  };
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
