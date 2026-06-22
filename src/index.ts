import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MockEventProvider,
  MockNewsProvider,
  MockRecommendationProvider
} from "./providers/MockContentProviders.js";
import { RssNewsProvider } from "./providers/RssNewsProvider.js";
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
const providers = [
  new MockNewsProvider(),
  new MockEventProvider(),
  new MockRecommendationProvider(),
  new RssNewsProvider()
];
await startMcpServer(storage, providers, {
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
