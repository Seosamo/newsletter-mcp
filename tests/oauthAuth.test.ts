import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateOAuthBearer } from "../src/mcp/oauthAuth.js";

let userInfoServer: Server | undefined;

afterEach(async () => {
  if (!userInfoServer) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    userInfoServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  userInfoServer = undefined;
});

describe("OAuth bearer authentication", () => {
  it("creates an internal user id from a valid userinfo response", async () => {
    const userInfoUrl = await startUserInfoServer();

    const auth = await authenticateOAuthBearer("valid-token", {
      enabled: true,
      issuer: "https://issuer.example",
      userInfoUrl,
      requiredScopes: ["profile"],
      userIdClaim: "id",
      emailClaim: "kakao_account.email",
      nameClaim: "properties.nickname"
    });

    expect(auth.userId).toMatch(/^oauth_[a-f0-9]{24}$/);
    expect(auth.issuer).toBe("https://issuer.example");
    expect(auth.subject).toBe("123456789");
    expect(auth.email).toBe("reader@example.com");
    expect(auth.name).toBe("Newsletter Reader");
  });

  it("rejects invalid opaque access tokens", async () => {
    const userInfoUrl = await startUserInfoServer();

    await expect(authenticateOAuthBearer("bad-token", {
      enabled: true,
      issuer: "https://issuer.example",
      userInfoUrl,
      requiredScopes: [],
      userIdClaim: "sub"
    })).rejects.toMatchObject({
      status: 401
    });
  });
});

async function startUserInfoServer(): Promise<string> {
  userInfoServer = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer valid-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      iss: "https://issuer.example",
      sub: "subject-123",
      id: 123456789,
      properties: {
        nickname: "Newsletter Reader"
      },
      kakao_account: {
        email: "reader@example.com"
      },
      scope: "openid profile"
    }));
  });

  await new Promise<void>((resolve) => {
    userInfoServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = userInfoServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected userinfo test server address.");
  }
  return `http://127.0.0.1:${address.port}/userinfo`;
}
