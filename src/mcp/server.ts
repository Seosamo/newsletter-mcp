import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import { ApiCatalogSelector } from "../catalog/ApiCatalogSelector.js";
import { NewsletterDraftGenerator } from "../pipeline/draftGenerator.js";
import type { ContentProvider } from "../providers/ContentProvider.js";
import type { NewsletterStorage } from "../storage/NewsletterStorage.js";
import { validateHttpSecurity } from "./httpSecurity.js";
import {
  authenticateOAuthRequest,
  protectedResourceMetadata,
  respondOAuthError,
  type AuthenticatedUser,
  type OAuthOptions
} from "./oauth.js";
import { isSupportedProtocolVersion, resolveProtocolVersionHeader } from "./protocolVersion.js";
import { listResourceTemplates, listResources, readResource } from "./resources.js";
import { callTool, listTools } from "./toolHandlers.js";

export type HttpMcpServerOptions = {
  host: string;
  port: number;
  endpointPath: string;
  publicBaseUrl?: string;
  allowedOrigins: string[];
  authToken?: string;
  oauth?: OAuthOptions;
};

export async function startMcpServer(
  storage: NewsletterStorage,
  providers: ContentProvider[],
  apiCatalogSelector: ApiCatalogSelector,
  options: HttpMcpServerOptions
): Promise<HttpServer> {
  assertRemoteConfiguration(options);
  const app = createMcpExpressApp({ host: options.host });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      name: "chat-newsletter-mcp",
      transport: "streamable-http",
      authentication: options.oauth?.enabled
        ? {
            mode: "oauth",
            resource: options.oauth.resource,
            userIdClaim: options.oauth.userIdClaim
          }
        : options.authToken
          ? { mode: "shared-token" }
          : { mode: "none" },
      endpoint: options.publicBaseUrl
        ? `${options.publicBaseUrl.replace(/\/+$/, "")}${options.endpointPath}`
        : options.endpointPath
    });
  });
  registerOAuthMetadataRoutes(app, options);

  app.post(options.endpointPath, async (req: Request, res: Response) => {
    const validation = await validateRequest(req, res, options);
    if (!validation.ok) {
      return;
    }

    const server = createServer(storage, providers, apiCatalogSelector, validation.auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get(options.endpointPath, async (req: Request, res: Response) => {
    const validation = await validateRequest(req, res, options);
    if (!validation.ok) {
      return;
    }
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  app.delete(options.endpointPath, async (req: Request, res: Response) => {
    const validation = await validateRequest(req, res, options);
    if (!validation.ok) {
      return;
    }
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(options.port, options.host, () => {
      const endpoint = options.publicBaseUrl
        ? `${options.publicBaseUrl.replace(/\/+$/, "")}${options.endpointPath}`
        : `http://${options.host}:${options.port}${options.endpointPath}`;
      console.error(`MCP Streamable HTTP server listening at ${endpoint}`);
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}

function createServer(
  storage: NewsletterStorage,
  providers: ContentProvider[],
  apiCatalogSelector: ApiCatalogSelector,
  auth?: AuthenticatedUser
): Server {
  const server = new Server(
    {
      name: "chat-newsletter-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        resources: {},
        tools: {}
      }
    }
  );
  const generator = new NewsletterDraftGenerator(storage, providers);

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(
        storage,
        generator,
        apiCatalogSelector,
        request.params.name,
        request.params.arguments ?? {},
        auth
      );
    } catch (error) {
      console.error(`Tool call failed: ${request.params.name}`, error);
      return {
        content: [
          {
            type: "text",
            text: formatToolError(request.params.name, error)
          }
        ],
        isError: true
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources(storage, auth));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => listResourceTemplates());
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return readResource(storage, request.params.uri, auth);
  });

  return server;
}

function formatToolError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "## Tool Call Failed",
    "",
    `- **Tool**: \`${toolName}\``,
    `- **Error**: ${message || "Unknown error"}`,
    "",
    "Check the server logs for stack trace details."
  ].join("\n");
}

type RequestValidationResult = {
  ok: true;
  auth?: AuthenticatedUser;
} | {
  ok: false;
};

async function validateRequest(
  req: Request,
  res: Response,
  options: HttpMcpServerOptions
): Promise<RequestValidationResult> {
  const protocolVersion = resolveProtocolVersionHeader(req.headers["mcp-protocol-version"]);
  const initializeProtocolVersion = getInitializeProtocolVersion(req.body);
  const unsupportedVersion = !isSupportedProtocolVersion(protocolVersion)
    ? protocolVersion
    : initializeProtocolVersion && !isSupportedProtocolVersion(initializeProtocolVersion)
      ? initializeProtocolVersion
      : undefined;

  if (unsupportedVersion) {
    respondUnsupportedProtocolVersion(res, unsupportedVersion);
    return { ok: false };
  }

  const oauthEnabled = options.oauth?.enabled === true;
  if (!validateHttpSecurity(req, res, {
    authToken: oauthEnabled ? undefined : options.authToken,
    allowedOrigins: options.allowedOrigins
  })) {
    return { ok: false };
  }

  if (!oauthEnabled || !options.oauth) {
    return { ok: true };
  }

  try {
    return {
      ok: true,
      auth: await authenticateOAuthRequest(req, options.oauth)
    };
  } catch (error) {
    respondOAuthError(res, options.oauth, error);
    return { ok: false };
  }
}

function getInitializeProtocolVersion(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    body.method === "initialize" &&
    "params" in body &&
    typeof body.params === "object" &&
    body.params !== null &&
    "protocolVersion" in body.params &&
    typeof body.params.protocolVersion === "string"
  ) {
    return body.params.protocolVersion;
  }
  return undefined;
}

function respondUnsupportedProtocolVersion(res: Response, requested: string): void {
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32602,
      message: "Unsupported MCP protocol version.",
      data: {
        supported: ["2025-03-26", "2025-06-18", "2025-11-25"],
        requested
      }
    },
    id: null
  });
}

function assertRemoteConfiguration(options: HttpMcpServerOptions): void {
  if (options.oauth?.enabled) {
    if (options.oauth.authorizationServers.length === 0) {
      throw new Error("OAUTH_AUTHORIZATION_SERVERS or OAUTH_ISSUER is required when OAuth is enabled.");
    }
    if (!options.oauth.jwksUrl && !options.oauth.issuer) {
      throw new Error("OAUTH_JWKS_URL or OAUTH_ISSUER is required when OAuth is enabled.");
    }
  }

  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (!options.publicBaseUrl) {
    return;
  }

  if (!/^https:\/\/[^/]+/i.test(options.publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS public URL when set in production.");
  }
}

function registerOAuthMetadataRoutes(
  app: ReturnType<typeof createMcpExpressApp>,
  options: HttpMcpServerOptions
): void {
  if (!options.oauth?.enabled) {
    return;
  }

  const metadata = protectedResourceMetadata(options.oauth);
  const rootPath = "/.well-known/oauth-protected-resource";
  const endpointPath = `${rootPath}${options.endpointPath === "/" ? "" : options.endpointPath}`;
  const handler = (_req: Request, res: Response) => {
    res.json(metadata);
  };

  app.get(rootPath, handler);
  if (endpointPath !== rootPath) {
    app.get(endpointPath, handler);
  }
}
