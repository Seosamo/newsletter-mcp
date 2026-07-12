import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthContext } from "./authContext.js";

export type OAuthAuthOptions = {
  enabled: boolean;
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  userInfoUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  requiredScopes: string[];
  userIdClaim: string;
  emailClaim?: string;
  nameClaim?: string;
};

export class OAuthAuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    readonly error = "invalid_token"
  ) {
    super(message);
  }
}

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateOAuthBearer(
  token: string,
  options: OAuthAuthOptions
): Promise<AuthContext> {
  if (!token) {
    throw new OAuthAuthError("Missing bearer token.", 401, "invalid_request");
  }

  if (isJwt(token) && options.jwksUrl) {
    return authenticateJwtBearer(token, options);
  }

  if (options.userInfoUrl) {
    return authenticateUserInfoBearer(token, options);
  }

  throw new OAuthAuthError("OAuth token validation is not configured.", 401, "invalid_token");
}

export function buildAuthorizationServerMetadata(options: OAuthAuthOptions, baseUrl: string | undefined) {
  const issuer = options.issuer ?? baseUrl?.replace(/\/+$/, "") ?? "https://example.invalid";
  return {
    issuer,
    authorization_endpoint: options.authorizationUrl ?? `${issuer}/authorize`,
    token_endpoint: options.tokenUrl ?? `${issuer}/token`,
    registration_endpoint: options.registrationUrl,
    jwks_uri: options.jwksUrl,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: options.requiredScopes.length > 0 ? options.requiredScopes : undefined
  };
}

function authenticateJwtBearer(token: string, options: OAuthAuthOptions): Promise<AuthContext> {
  const jwks = getRemoteJwks(options.jwksUrl!);
  return jwtVerify(token, jwks, {
    issuer: options.issuer,
    audience: options.audience
  })
    .then(({ payload }) => {
      assertRequiredScopes(payload, options.requiredScopes);
      return contextFromClaims(payload, options);
    })
    .catch((error) => {
      if (error instanceof OAuthAuthError) {
        throw error;
      }
      throw new OAuthAuthError(error instanceof Error ? error.message : String(error));
    });
}

async function authenticateUserInfoBearer(token: string, options: OAuthAuthOptions): Promise<AuthContext> {
  let response: Response;
  try {
    response = await fetch(options.userInfoUrl!, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    throw new OAuthAuthError(error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    throw new OAuthAuthError(`UserInfo request failed with status ${response.status}.`, response.status === 403 ? 403 : 401);
  }

  const claims = await response.json() as JWTPayload;
  assertRequiredScopes(claims, options.requiredScopes);
  return contextFromClaims(claims, options);
}

function contextFromClaims(claims: JWTPayload, options: OAuthAuthOptions): AuthContext {
  const subject = pickString(claims, [options.userIdClaim, "sub"]);
  if (!subject) {
    throw new OAuthAuthError(`OAuth token is missing ${options.userIdClaim} or sub claim.`);
  }

  const issuer = pickString(claims, ["iss"]) ?? options.issuer ?? "oauth";
  return {
    userId: oauthUserId(issuer, subject),
    issuer,
    subject,
    email: options.emailClaim ? pickString(claims, [options.emailClaim]) : pickString(claims, ["email"]),
    name: options.nameClaim ? pickString(claims, [options.nameClaim]) : pickString(claims, ["name"])
  };
}

function assertRequiredScopes(claims: JWTPayload, requiredScopes: string[]): void {
  if (requiredScopes.length === 0) {
    return;
  }

  const granted = new Set([
    ...parseScopes(claims.scope),
    ...parseScopes(claims.scp)
  ]);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new OAuthAuthError(`Missing required OAuth scopes: ${missing.join(", ")}`, 403, "insufficient_scope");
  }
}

function parseScopes(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
  }
  return [];
}

function pickString(claims: JWTPayload, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readClaimPath(claims, key);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readClaimPath(claims: JWTPayload, key: string): unknown {
  return key.split(".").reduce<unknown>((value, part) => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return (value as Record<string, unknown>)[part];
  }, claims);
}

function oauthUserId(issuer: string, subject: string): string {
  return `oauth_${createHash("sha256").update(`${issuer}:${subject}`).digest("hex").slice(0, 24)}`;
}

function getRemoteJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  remoteJwksCache.set(jwksUrl, jwks);
  return jwks;
}

function isJwt(token: string): boolean {
  return token.split(".").length === 3;
}
