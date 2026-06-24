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
      endpoint: options.publicBaseUrl
        ? `${options.publicBaseUrl.replace(/\/+$/, "")}${options.endpointPath}`
        : options.endpointPath
    });
  });

  app.post(options.endpointPath, async (req: Request, res: Response) => {
    if (!validateRequest(req, res, options)) {
      return;
    }

    const server = createServer(storage, providers, apiCatalogSelector);
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

  app.get(options.endpointPath, (req: Request, res: Response) => {
    if (!validateRequest(req, res, options)) {
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

  app.delete(options.endpointPath, (req: Request, res: Response) => {
    if (!validateRequest(req, res, options)) {
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
  apiCatalogSelector: ApiCatalogSelector
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
    return callTool(storage, generator, apiCatalogSelector, request.params.name, request.params.arguments ?? {});
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources(storage));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => listResourceTemplates());
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return readResource(storage, request.params.uri);
  });

  return server;
}

function validateRequest(req: Request, res: Response, options: HttpMcpServerOptions): boolean {
  const protocolVersion = resolveProtocolVersionHeader(req.headers["mcp-protocol-version"]);
  const initializeProtocolVersion = getInitializeProtocolVersion(req.body);
  const unsupportedVersion = !isSupportedProtocolVersion(protocolVersion)
    ? protocolVersion
    : initializeProtocolVersion && !isSupportedProtocolVersion(initializeProtocolVersion)
      ? initializeProtocolVersion
      : undefined;

  if (unsupportedVersion) {
    respondUnsupportedProtocolVersion(res, unsupportedVersion);
    return false;
  }

  return validateHttpSecurity(req, res, {
    authToken: options.authToken,
    allowedOrigins: options.allowedOrigins
  });
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
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (!options.publicBaseUrl || !/^https:\/\/[^/]+/i.test(options.publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS public URL in production.");
  }
}
