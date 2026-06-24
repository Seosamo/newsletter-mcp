import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiCatalogRepository } from "./catalog/ApiCatalogRepository.js";
import { ApiCatalogSelector } from "./catalog/ApiCatalogSelector.js";
import {
  MockEventProvider,
  MockNewsProvider,
  MockRecommendationProvider
} from "./providers/MockContentProviders.js";
import { PublicApiDomainProvider } from "./providers/PublicApiDomainProvider.js";
import { RssNewsProvider } from "./providers/RssNewsProvider.js";
import { HtmlArticleExtractor } from "./providers/HtmlArticleExtractor.js";
import { WebSearchProvider } from "./providers/WebSearchProvider.js";
import type { ContentProvider } from "./providers/ContentProvider.js";
import { startMcpServer } from "./mcp/server.js";
import { JsonFileStorage } from "./storage/JsonFileStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
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

if (process.env.BRAVE_SEARCH_API_KEY || process.env.ENABLE_WEB_SEARCH === "true") {
  providers.push(new WebSearchProvider({
    apiKey: process.env.BRAVE_SEARCH_API_KEY,
    endpoint: process.env.BRAVE_SEARCH_API_URL,
    maxResults: parseInteger(process.env.WEB_SEARCH_MAX_RESULTS, 6),
    maxPagesToExtract: parseInteger(process.env.WEB_SEARCH_MAX_PAGES_TO_EXTRACT, 3),
    timeoutMs: parseInteger(process.env.WEB_SEARCH_TIMEOUT_MS, 8000),
    extractHtml: process.env.WEB_SEARCH_EXTRACT_HTML !== "false",
    allowedDomains: parseCsv(process.env.WEB_SEARCH_ALLOWED_DOMAINS),
    blockedDomains: parseCsv(process.env.WEB_SEARCH_BLOCKED_DOMAINS),
    articleExtractor: new HtmlArticleExtractor({
      timeoutMs: parseInteger(process.env.HTML_EXTRACT_TIMEOUT_MS, 8000),
      maxTextChars: parseInteger(process.env.HTML_EXTRACT_MAX_TEXT_CHARS, 5000)
    })
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
