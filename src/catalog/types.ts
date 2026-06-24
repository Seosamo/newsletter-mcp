import type { Period } from "../domain/types.js";

export type ApiCatalogSource = "kr" | "global" | "seed";

export type ApiCatalogEntry = {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  auth: string;
  https: "Yes" | "No" | "Unknown";
  cors: "Yes" | "No" | "Unknown";
  source: ApiCatalogSource;
  keywords: string[];
  connectorId?: string;
};

export type ApiCatalogFile = {
  generatedAt: string;
  sources: string[];
  entries: ApiCatalogEntry[];
};

export type ApiConnectorSelectionInput = {
  userId: string;
  interests: string[];
  regions: string[];
  keywords?: string[];
  period?: Period;
};

export type ApiConnectorRecommendation = {
  entry: ApiCatalogEntry;
  score: number;
  reasons: string[];
  supported: boolean;
  callable: boolean;
  requiresConfig: string[];
};
