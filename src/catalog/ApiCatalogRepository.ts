import { readFile } from "node:fs/promises";
import type { ApiCatalogEntry, ApiCatalogFile } from "./types.js";
import { DEFAULT_API_CATALOG_ENTRIES } from "./defaultApiCatalog.js";

export class ApiCatalogRepository {
  constructor(private readonly catalogPath: string) {}

  async listEntries(): Promise<ApiCatalogEntry[]> {
    try {
      const raw = await readFile(this.catalogPath, "utf8");
      const parsed = JSON.parse(raw) as ApiCatalogFile;
      return Array.isArray(parsed.entries) ? parsed.entries : DEFAULT_API_CATALOG_ENTRIES;
    } catch {
      return DEFAULT_API_CATALOG_ENTRIES;
    }
  }
}
