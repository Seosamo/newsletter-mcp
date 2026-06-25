import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiCatalogRepository } from "./catalog/ApiCatalogRepository.js";
import { ApiCatalogSelector } from "./catalog/ApiCatalogSelector.js";
import { loadEnvFile } from "./config/loadEnv.js";
import {
  MockEventProvider,
  MockNewsProvider,
  MockRecommendationProvider
} from "./providers/MockContentProviders.js";
import { PublicApiDomainProvider } from "./providers/PublicApiDomainProvider.js";
import { RssNewsProvider } from "./providers/RssNewsProvider.js";
import { HtmlArticleExtractor } from "./providers/HtmlArticleExtractor.js";
import { ExternalMcpSearchProvider } from "./providers/ExternalMcpSearchProvider.js";
import { WebSearchProvider } from "./providers/WebSearchProvider.js";
import type { ContentProvider } from "./providers/ContentProvider.js";
import { startMcpServer } from "./mcp/server.js";
import { JsonFileStorage } from "./storage/JsonFileStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

loadEnvFile(path.resolve(process.cwd(), ".env"));

const dataDir = process.env.NEWSLETTER_MCP_DATA_DIR ?? path.join(projectRoot, "data");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const endpointPath = process.env.MCP_ENDPOINT_PATH ?? "/mcp";
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const allowedOrigins = parseCsv(process.env.ALLOWED_ORIGINS);
const authToken = process.env.NEWSLETTER_MCP_AUTH_TOKEN;

const storage = new JsonFileStorage(dataDir);
const catalogEntries = await new ApiCatalogRepository(path.join(dataDir, "apiCatalog.json")).listEntries();
const providers: ContentProvider[] = [];

const domainProvider = new PublicApiDomainProvider({
  catalogEntries,
  env: process.env,
  maxConnectors: parseInteger(process.env.DOMAIN_CONNECTOR_MAX_CONNECTORS, 3),
  timeoutMs: parseInteger(process.env.DOMAIN_CONNECTOR_TIMEOUT_MS, 8000)
});
const apiCatalogSelector = new ApiCatalogSelector(catalogEntries, domainProvider.getConnectorConfigState());

if (process.env.ENABLE_DOMAIN_CONNECTORS !== "false") {
  providers.push(domainProvider);
}

providers.push(new RssNewsProvider());

if (shouldEnableProvider("tavily", Boolean(process.env.TAVILY_API_KEY) || process.env.ENABLE_TAVILY_SEARCH === "true" || process.env.ENABLE_WEB_SEARCH === "true")) {
  providers.push(new WebSearchProvider({
    apiKey: process.env.TAVILY_API_KEY,
    endpoint: process.env.TAVILY_SEARCH_API_URL,
    maxResults: parseInteger(process.env.WEB_SEARCH_MAX_RESULTS, 6),
    maxPagesToExtract: parseInteger(process.env.WEB_SEARCH_MAX_PAGES_TO_EXTRACT, 3),
    timeoutMs: parseInteger(process.env.WEB_SEARCH_TIMEOUT_MS, 8000),
    extractHtml: process.env.WEB_SEARCH_EXTRACT_HTML !== "false",
    allowedDomains: parseCsv(process.env.WEB_SEARCH_ALLOWED_DOMAINS),
    blockedDomains: parseCsv(process.env.WEB_SEARCH_BLOCKED_DOMAINS),
    topic: parseTavilyTopic(process.env.TAVILY_SEARCH_TOPIC),
    searchDepth: parseTavilySearchDepth(process.env.TAVILY_SEARCH_DEPTH),
    includeRawContent: parseTavilyRawContent(process.env.TAVILY_INCLUDE_RAW_CONTENT),
    articleExtractor: new HtmlArticleExtractor({
      timeoutMs: parseInteger(process.env.HTML_EXTRACT_TIMEOUT_MS, 8000),
      maxTextChars: parseInteger(process.env.HTML_EXTRACT_MAX_TEXT_CHARS, 5000)
    })
  }));
}

if (shouldEnableProvider(
  "external_mcp",
  Boolean(firstEnv("EXTERNAL_MCP_SEARCH_COMMAND", "NOAPI_GOOGLE_SEARCH_COMMAND")) ||
    process.env.ENABLE_EXTERNAL_MCP_SEARCH === "true" ||
    process.env.ENABLE_NOAPI_GOOGLE_SEARCH === "true"
)) {
  const externalMcpSearchUsesGeneric = Boolean(firstEnv("EXTERNAL_MCP_SEARCH_COMMAND"));
  providers.push(new ExternalMcpSearchProvider({
    command: firstEnv("EXTERNAL_MCP_SEARCH_COMMAND", "NOAPI_GOOGLE_SEARCH_COMMAND"),
    args: parseCommandArgs(searchEnv(externalMcpSearchUsesGeneric, "ARGS")),
    cwd: searchEnv(externalMcpSearchUsesGeneric, "CWD"),
    toolName: searchEnv(externalMcpSearchUsesGeneric, "TOOL_NAME") ?? defaultExternalMcpToolName(externalMcpSearchUsesGeneric),
    queryParameter: searchEnv(externalMcpSearchUsesGeneric, "QUERY_PARAM") ?? "query",
    maxResultsParameter: searchEnv(externalMcpSearchUsesGeneric, "MAX_RESULTS_PARAM") ?? defaultExternalMcpMaxResultsParameter(externalMcpSearchUsesGeneric),
    regionParameter: searchEnv(externalMcpSearchUsesGeneric, "REGION_PARAM"),
    maxResults: parseInteger(searchEnv(externalMcpSearchUsesGeneric, "MAX_RESULTS") ?? firstEnv("WEB_SEARCH_MAX_RESULTS"), 6),
    timeoutMs: parseInteger(firstEnv("EXTERNAL_MCP_SEARCH_TIMEOUT_MS", "WEB_SEARCH_TIMEOUT_MS"), 10000)
  }));
}

if (process.env.ENABLE_MOCK_PROVIDERS !== "false") {
  providers.push(
    new MockNewsProvider(),
    new MockEventProvider(),
    new MockRecommendationProvider()
  );
}

await startMcpServer(storage, providers, apiCatalogSelector, {
  host,
  port,
  endpointPath,
  publicBaseUrl,
  allowedOrigins,
  authToken
});

function parseCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
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

function shouldEnableProvider(providerName: "tavily" | "external_mcp", configured: boolean): boolean {
  const mode = (process.env.WEB_SEARCH_PROVIDER ?? "all").trim().toLocaleLowerCase();
  if (mode === "none" || mode === "false" || mode === "off") {
    return false;
  }
  if (mode === "all" || mode === "both") {
    return configured;
  }
  if (providerName === "tavily") {
    return configured && ["tavily", "web", "web_search"].includes(mode);
  }
  return configured && ["external_mcp", "mcp", "noapi", "noapi_google", "noapi_google_search"].includes(mode);
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
      throw new Error("External MCP search args JSON must be an array of strings.");
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
