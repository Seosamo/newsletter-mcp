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

  it("exposes OAuth protected resource metadata when OAuth is enabled", async () => {
    const server = await startTestServer("https://newsletter.example.test", {
      enabled: true,
      issuer: "https://auth.example.test",
      audience: "https://newsletter.example.test/mcp",
      jwksUrl: "https://auth.example.test/jwks.json",
      authorizationServers: ["https://auth.example.test"],
      resource: "https://newsletter.example.test/mcp",
      resourceMetadataUrl: "https://newsletter.example.test/.well-known/oauth-protected-resource/mcp",
      scopesSupported: ["newsletter:read"],
      requiredScopes: ["newsletter:read"],
      userIdClaim: "sub",
      allowedAlgorithms: ["RS256"],
      jwksCacheTtlMs: 300000,
      clockSkewSeconds: 60
    });

    const response = await fetch(`${serverUrl(server)}/.well-known/oauth-protected-resource/mcp`);
    const metadata = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({
      resource: "https://newsletter.example.test/mcp",
      resource_name: "Chat Newsletter MCP",
      authorization_servers: ["https://auth.example.test"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["newsletter:read"]
    });

    const healthResponse = await fetch(`${serverUrl(server)}/health`);
    const health = await healthResponse.json() as Record<string, unknown>;
    expect(health).toMatchObject({
      authentication: {
        mode: "oauth",
        resource: "https://newsletter.example.test/mcp",
        userIdClaim: "sub"
      }
    });

    await closeServer(server);
  });
});

async function startTestServer(
  publicBaseUrl?: string,
  oauth?: Parameters<typeof startMcpServer>[3]["oauth"]
): Promise<HttpServer> {
  const dir = await mkdtemp(path.join(tmpdir(), "newsletter-mcp-server-"));
  tempDirs.push(dir);
  return startMcpServer(new JsonFileStorage(dir), [], new ApiCatalogSelector([]), {
    host: "127.0.0.1",
    port: 0,
    endpointPath: "/mcp",
    publicBaseUrl,
    allowedOrigins: [],
    oauth
  });
}

function serverUrl(server: HttpServer): string {
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Server is not listening.");
  }
  return `http://127.0.0.1:${address.port}`;
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
