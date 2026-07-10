import { readFile } from "node:fs/promises";
import type { ApiCatalogEntry, ApiCatalogFile } from "./types.js";
import { DEFAULT_API_CATALOG_ENTRIES } from "./defaultApiCatalog.js";

export type ApiCatalogRepositoryOptions = {
  includeExternalCatalog?: boolean;
};

export class ApiCatalogRepository {
  private readonly includeExternalCatalog: boolean;

  constructor(
    private readonly catalogPath: string,
    options: ApiCatalogRepositoryOptions = {}
  ) {
    this.includeExternalCatalog = options.includeExternalCatalog ?? true;
  }

  async listEntries(): Promise<ApiCatalogEntry[]> {
    if (!this.includeExternalCatalog) {
      return DEFAULT_API_CATALOG_ENTRIES;
    }
    try {
      const raw = await readFile(this.catalogPath, "utf8");
      const parsed = JSON.parse(raw) as ApiCatalogFile;
      return Array.isArray(parsed.entries) ? parsed.entries : DEFAULT_API_CATALOG_ENTRIES;
    } catch {
      return DEFAULT_API_CATALOG_ENTRIES;
    }
  }
}
