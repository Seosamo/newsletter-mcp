import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApiCatalogSelector } from "../src/catalog/ApiCatalogSelector.js";
import { startMcpServer } from "../src/mcp/server.js";
import { JsonFileStorage } from "../src/storage/JsonFileStorage.js";

const tempDirs: string[] = [];
const originalNodeEnv = process.env.NODE_ENV;

afterEach(async () => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP server production configuration", () => {
  it("starts in production without PUBLIC_BASE_URL for platform-assigned endpoints", async () => {
    process.env.NODE_ENV = "production";
    const server = await startTestServer();

    await closeServer(server);
  });

  it("rejects non-HTTPS PUBLIC_BASE_URL values in production", async () => {
    process.env.NODE_ENV = "production";

    await expect(startTestServer("http://example.com")).rejects.toThrow(
      "PUBLIC_BASE_URL must be an HTTPS public URL when set in production."
    );
  });
});

async function startTestServer(publicBaseUrl?: string): Promise<HttpServer> {
  const dir = await mkdtemp(path.join(tmpdir(), "newsletter-mcp-server-"));
  tempDirs.push(dir);
  return startMcpServer(new JsonFileStorage(dir), [], new ApiCatalogSelector([]), {
    host: "127.0.0.1",
    port: 0,
    endpointPath: "/mcp",
    publicBaseUrl,
    allowedOrigins: []
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
