import { createPublicKey, createVerify } from "node:crypto";
import type { Request, Response } from "express";

export type AuthenticatedUser = {
  userId: string;
  claims: Record<string, unknown>;
  scopes: string[];
};

export type OAuthOptions = {
  enabled: boolean;
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  authorizationServers: string[];
  resource: string;
  resourceMetadataUrl: string;
  scopesSupported: string[];
  requiredScopes: string[];
  userIdClaim: string;
  allowedAlgorithms: string[];
  jwksCacheTtlMs: number;
  clockSkewSeconds: number;
};

export class OAuthAuthenticationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 401,
    readonly oauthError = "invalid_token"
  ) {
    super(message);
    this.name = "OAuthAuthenticationError";
  }
}

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type Jwks = {
  keys: JsonWebKeyRecord[];
};

type JsonWebKeyRecord = Record<string, unknown> & {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
};

type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

const jwksCache = new Map<string, CachedValue<Jwks>>();
const discoveryCache = new Map<string, CachedValue<string>>();

export async function authenticateOAuthRequest(
  req: Request,
  options: OAuthOptions
): Promise<AuthenticatedUser> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new OAuthAuthenticationError("Bearer access token is required.", 401, "invalid_token");
  }

  return validateJwtAccessToken(token, options);
}

export function respondOAuthError(
  res: Response,
  options: OAuthOptions,
  error: unknown
): void {
  const authError = error instanceof OAuthAuthenticationError
    ? error
    : new OAuthAuthenticationError("OAuth authentication failed.");
  const challengeParams = [
    `resource_metadata="${escapeHeaderValue(options.resourceMetadataUrl)}"`,
    options.requiredScopes.length > 0 ? `scope="${escapeHeaderValue(options.requiredScopes.join(" "))}"` : "",
    `error="${escapeHeaderValue(authError.oauthError)}"`,
    `error_description="${escapeHeaderValue(authError.message)}"`
  ].filter(Boolean);

  res
    .status(authError.statusCode)
    .set("WWW-Authenticate", `Bearer ${challengeParams.join(", ")}`)
    .json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: authError.statusCode === 403 ? "Forbidden." : "Unauthorized.",
        data: {
          oauthError: authError.oauthError,
          errorDescription: authError.message
        }
      },
      id: null
    });
}

export function protectedResourceMetadata(options: OAuthOptions): Record<string, unknown> {
  return {
    resource: options.resource,
    resource_name: "Chat Newsletter MCP",
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: options.scopesSupported
  };
}

async function validateJwtAccessToken(token: string, options: OAuthOptions): Promise<AuthenticatedUser> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  const algorithm = header.alg;
  if (!algorithm || !options.allowedAlgorithms.includes(algorithm)) {
    throw new OAuthAuthenticationError(`Unsupported JWT algorithm: ${algorithm ?? "(missing)"}.`);
  }

  const jwksUrl = await resolveJwksUrl(options);
  const jwks = await fetchJwks(jwksUrl, options.jwksCacheTtlMs);
  const key = selectJwk(jwks, header);
  verifyJwtSignature(signingInput, signature, key, algorithm);
  validateJwtClaims(payload, options);

  const userId = getClaimByPath(payload, options.userIdClaim);
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new OAuthAuthenticationError(`Required user id claim is missing: ${options.userIdClaim}.`);
  }

  return {
    userId: userId.trim(),
    claims: payload,
    scopes: extractScopes(payload)
  };
}

function extractBearerToken(req: Request): string | undefined {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function decodeJwt(token: string): {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new OAuthAuthenticationError("Access token must be a signed JWT.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonPart<JwtHeader>(encodedHeader, "JWT header");
  const payload = parseJsonPart<Record<string, unknown>>(encodedPayload, "JWT payload");
  return {
    header,
    payload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: base64UrlDecode(encodedSignature)
  };
}

function parseJsonPart<T>(encoded: string, label: string): T {
  try {
    return JSON.parse(base64UrlDecode(encoded).toString("utf8")) as T;
  } catch {
    throw new OAuthAuthenticationError(`Invalid ${label}.`);
  }
}

async function resolveJwksUrl(options: OAuthOptions): Promise<string> {
  if (options.jwksUrl) {
    return options.jwksUrl;
  }
  if (!options.issuer) {
    throw new OAuthAuthenticationError("OAuth issuer or JWKS URL is required.");
  }

  const cached = discoveryCache.get(options.issuer);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  for (const url of authorizationServerMetadataUrls(options.issuer)) {
    const response = await fetch(url);
    if (!response.ok) {
      continue;
    }
    const metadata = await response.json() as Record<string, unknown>;
    if (typeof metadata.jwks_uri === "string" && metadata.jwks_uri.length > 0) {
      discoveryCache.set(options.issuer, {
        value: metadata.jwks_uri,
        expiresAt: now + options.jwksCacheTtlMs
      });
      return metadata.jwks_uri;
    }
  }

  throw new OAuthAuthenticationError("Could not discover OAuth JWKS URL from issuer.");
}

function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const pathname = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  if (pathname && pathname !== "/") {
    return [
      `${origin}/.well-known/oauth-authorization-server${pathname}`,
      `${origin}/.well-known/openid-configuration${pathname}`,
      `${origin}${pathname}/.well-known/openid-configuration`
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`
  ];
}

async function fetchJwks(url: string, cacheTtlMs: number): Promise<Jwks> {
  const cached = jwksCache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new OAuthAuthenticationError(`Could not fetch JWKS: HTTP ${response.status}.`);
  }
  const jwks = await response.json() as Jwks;
  if (!Array.isArray(jwks.keys)) {
    throw new OAuthAuthenticationError("Invalid JWKS document.");
  }
  jwksCache.set(url, {
    value: jwks,
    expiresAt: now + cacheTtlMs
  });
  return jwks;
}

function selectJwk(jwks: Jwks, header: JwtHeader): JsonWebKeyRecord {
  const candidates = jwks.keys.filter((key) => {
    if (header.kid && key.kid !== header.kid) {
      return false;
    }
    if (key.alg && header.alg && key.alg !== header.alg) {
      return false;
    }
    return key.kty === "RSA" && (!key.use || key.use === "sig");
  });

  const key = candidates[0];
  if (!key) {
    throw new OAuthAuthenticationError("No matching JWT signing key found.");
  }
  return key;
}

function verifyJwtSignature(
  signingInput: string,
  signature: Buffer,
  jwk: JsonWebKeyRecord,
  algorithm: string
): void {
  const verifyAlgorithm = jwtAlgorithmToNodeAlgorithm(algorithm);
  const publicKey = createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]);
  const verifier = createVerify(verifyAlgorithm);
  verifier.update(signingInput);
  verifier.end();

  if (!verifier.verify(publicKey, signature)) {
    throw new OAuthAuthenticationError("JWT signature verification failed.");
  }
}

function jwtAlgorithmToNodeAlgorithm(algorithm: string): string {
  if (algorithm === "RS256") {
    return "RSA-SHA256";
  }
  if (algorithm === "RS384") {
    return "RSA-SHA384";
  }
  if (algorithm === "RS512") {
    return "RSA-SHA512";
  }
  throw new OAuthAuthenticationError(`Unsupported JWT algorithm: ${algorithm}.`);
}

function validateJwtClaims(payload: Record<string, unknown>, options: OAuthOptions): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds;

  if (typeof payload.exp !== "number" || nowSeconds > payload.exp + skew) {
    throw new OAuthAuthenticationError("JWT is expired or missing exp.");
  }
  if (typeof payload.nbf === "number" && nowSeconds + skew < payload.nbf) {
    throw new OAuthAuthenticationError("JWT is not valid yet.");
  }
  if (options.issuer && payload.iss !== options.issuer) {
    throw new OAuthAuthenticationError("JWT issuer does not match configured issuer.");
  }
  if (options.audience && !audienceMatches(payload.aud, options.audience)) {
    throw new OAuthAuthenticationError("JWT audience does not match configured audience.");
  }

  const grantedScopes = new Set(extractScopes(payload));
  const missingScopes = options.requiredScopes.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) {
    throw new OAuthAuthenticationError(
      `Missing required OAuth scope(s): ${missingScopes.join(", ")}.`,
      403,
      "insufficient_scope"
    );
  }
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") {
    return aud === expected;
  }
  if (Array.isArray(aud)) {
    return aud.includes(expected);
  }
  return false;
}

function getClaimByPath(claims: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, claims);
}

function extractScopes(payload: Record<string, unknown>): string[] {
  if (typeof payload.scope === "string") {
    return payload.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }
  if (Array.isArray(payload.scp)) {
    return payload.scp.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
