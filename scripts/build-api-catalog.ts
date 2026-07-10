import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogFile } from "../src/catalog/apiCatalogParser.js";

const SOURCES = [
  {
    url: "https://raw.githubusercontent.com/yybmion/public-apis-4Kr/main/README.md",
    source: "kr" as const
  },
  {
    url: "https://raw.githubusercontent.com/yybmion/public-apis-4Kr/main/GLOBAL_PUBLIC_APIS_KR.md",
    source: "global" as const
  }
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outputPath = path.join(projectRoot, "data", "apiCatalog.json");

if (process.env.ENABLE_GITHUB_API_CATALOG !== "true") {
  throw new Error(
    "GitHub API catalog fetching is disabled. Set ENABLE_GITHUB_API_CATALOG=true to refresh it explicitly."
  );
}

const inputs = await Promise.all(SOURCES.map(async (source) => {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source.url}: ${response.status}`);
  }
  return {
    ...source,
    markdown: await response.text()
  };
}));

const catalog = buildCatalogFile(inputs);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

console.log(`Wrote ${catalog.entries.length} API catalog entries to ${outputPath}`);
