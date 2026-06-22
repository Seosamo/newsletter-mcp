export const MIN_PROTOCOL_VERSION = "2025-03-26";
export const MAX_PROTOCOL_VERSION = "2025-11-25";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
] as const;

export function resolveProtocolVersionHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? MIN_PROTOCOL_VERSION;
  }
  return value ?? MIN_PROTOCOL_VERSION;
}

export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]);
}
