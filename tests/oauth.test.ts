import { createServer, type Server as HttpServer } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { authenticateOAuthRequest, type OAuthOptions } from "../src/mcp/oauth.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("OAuth bearer authentication", () => {
  it("verifies a JWT access token with JWKS and extracts the configured user id claim", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const kid = "test-key";
    const jwksServer = await startJwksServer(publicKey, kid);
    const jwksUrl = serverUrl(jwksServer, "/jwks.json");
    const token = signJwt(privateKey, kid, {
      iss: "https://auth.example.test",
      aud: "https://newsletter.example.test/mcp",
      sub: "oauth-user-123",
      scope: "newsletter:read newsletter:write",
      exp: Math.floor(Date.now() / 1000) + 300
    });
    const request = mockRequest(`Bearer ${token}`);

    const auth = await authenticateOAuthRequest(request, oauthOptions({
      jwksUrl,
      requiredScopes: ["newsletter:read"]
    }));

    expect(auth.userId).toBe("oauth-user-123");
    expect(auth.scopes).toEqual(["newsletter:read", "newsletter:write"]);
  });

  it("rejects tokens whose audience does not match the MCP resource", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const jwksServer = await startJwksServer(publicKey, "wrong-audience-key");
    const token = signJwt(privateKey, "wrong-audience-key", {
      iss: "https://auth.example.test",
      aud: "https://other.example.test",
      sub: "oauth-user-123",
      exp: Math.floor(Date.now() / 1000) + 300
    });

    await expect(authenticateOAuthRequest(mockRequest(`Bearer ${token}`), oauthOptions({
      jwksUrl: serverUrl(jwksServer, "/jwks.json")
    }))).rejects.toThrow("JWT audience does not match configured audience.");
  });
});

function oauthOptions(overrides: Partial<OAuthOptions> = {}): OAuthOptions {
  return {
    enabled: true,
    issuer: "https://auth.example.test",
    audience: "https://newsletter.example.test/mcp",
    authorizationServers: ["https://auth.example.test"],
    resource: "https://newsletter.example.test/mcp",
    resourceMetadataUrl: "https://newsletter.example.test/.well-known/oauth-protected-resource/mcp",
    scopesSupported: ["newsletter:read", "newsletter:write"],
    requiredScopes: [],
    userIdClaim: "sub",
    allowedAlgorithms: ["RS256"],
    jwksCacheTtlMs: 300000,
    clockSkewSeconds: 60,
    ...overrides
  };
}

async function startJwksServer(publicKey: KeyObject, kid: string): Promise<HttpServer> {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const body = JSON.stringify({
    keys: [
      {
        ...jwk,
        kid,
        alg: "RS256",
        use: "sig"
      }
    ]
  });
  const server = createServer((req, res) => {
    if (req.url !== "/jwks.json") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  servers.push(server);
  return server;
}

function signJwt(privateKey: KeyObject, kid: string, payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64Url(signer.sign(privateKey))}`;
}

function mockRequest(authorization: string): Request {
  return {
    header(name: string) {
      return name.toLocaleLowerCase() === "authorization" ? authorization : undefined;
    }
  } as Request;
}

function serverUrl(server: HttpServer, path: string): string {
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Server is not listening.");
  }
  return `http://127.0.0.1:${address.port}${path}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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
