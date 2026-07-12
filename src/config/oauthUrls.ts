export type OAuthUrlOptions = {
  serverBaseUrl: string;
  endpointPath: string;
  resource?: string;
  audience?: string;
  resourceMetadataUrl?: string;
};

export function resolveOAuthUrls(options: OAuthUrlOptions): {
  resource: string;
  audience: string;
  resourceMetadataUrl: string;
} {
  const serverBaseUrl = trimTrailingSlashes(options.serverBaseUrl);
  const endpointPath = normalizeEndpointPath(options.endpointPath);
  const resource = options.resource ?? `${serverBaseUrl}${endpointPath}`;

  return {
    resource,
    audience: options.audience ?? resource,
    resourceMetadataUrl: options.resourceMetadataUrl ??
      `${serverBaseUrl}/.well-known/oauth-protected-resource${endpointPath === "/" ? "" : endpointPath}`
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}
