import { describe, expect, it } from "vitest";
import { resolveOAuthUrls } from "../src/config/oauthUrls.js";

describe("resolveOAuthUrls", () => {
  it("appends MCP and metadata paths to the single public base URL", () => {
    expect(resolveOAuthUrls({
      serverBaseUrl: "https://migration.playmcp-endpoint.kakaocloud.io/",
      endpointPath: "/mcp"
    })).toEqual({
      resource: "https://migration.playmcp-endpoint.kakaocloud.io/mcp",
      audience: "https://migration.playmcp-endpoint.kakaocloud.io/mcp",
      resourceMetadataUrl: "https://migration.playmcp-endpoint.kakaocloud.io/.well-known/oauth-protected-resource/mcp"
    });
  });

  it("keeps explicit compatibility overrides", () => {
    expect(resolveOAuthUrls({
      serverBaseUrl: "https://public.example",
      endpointPath: "custom/",
      resource: "https://override.example/resource",
      audience: "custom-audience",
      resourceMetadataUrl: "https://override.example/metadata"
    })).toEqual({
      resource: "https://override.example/resource",
      audience: "custom-audience",
      resourceMetadataUrl: "https://override.example/metadata"
    });
  });
});
