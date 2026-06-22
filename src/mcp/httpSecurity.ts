import type { Request, Response } from "express";

type HttpSecurityOptions = {
  authToken?: string;
  allowedOrigins: string[];
};

export function validateHttpSecurity(req: Request, res: Response, options: HttpSecurityOptions): boolean {
  if (!validateOrigin(req, res, options.allowedOrigins)) {
    return false;
  }

  if (!validateAuth(req, res, options.authToken)) {
    return false;
  }

  return true;
}

function validateOrigin(req: Request, res: Response, allowedOrigins: string[]): boolean {
  const origin = req.header("origin");
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  res.status(403).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Forbidden: invalid Origin header."
    },
    id: null
  });
  return false;
}

function validateAuth(req: Request, res: Response, authToken?: string): boolean {
  if (!authToken) {
    return true;
  }

  const bearer = req.header("authorization");
  const custom = req.header("x-mcp-auth");
  const expectedBearer = `Bearer ${authToken}`;
  if (bearer === expectedBearer || custom === authToken) {
    return true;
  }

  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Unauthorized: valid bearer token or X-MCP-Auth header is required."
    },
    id: null
  });
  return false;
}
