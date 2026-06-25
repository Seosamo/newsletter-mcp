import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvLine } from "../src/config/loadEnv.js";

const tempDirs: string[] = [];
const envKeysToRestore = new Map<string, string | undefined>();

afterEach(async () => {
  for (const [key, value] of envKeysToRestore) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  envKeysToRestore.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadEnvFile", () => {
  it("parses dotenv-style key value lines", () => {
    expect(parseEnvLine("TAVILY_API_KEY=tvly-test")).toEqual({
      key: "TAVILY_API_KEY",
      value: "tvly-test"
    });
    expect(parseEnvLine("PORT=3000 # local port")).toEqual({
      key: "PORT",
      value: "3000"
    });
    expect(parseEnvLine("export WEB_SEARCH_PROVIDER=\"all\"")).toEqual({
      key: "WEB_SEARCH_PROVIDER",
      value: "all"
    });
    expect(parseEnvLine("# comment")).toBeUndefined();
  });

  it("loads missing values without overriding existing environment variables", async () => {
    rememberEnv("NEWSLETTER_ENV_TEST_EXISTING");
    rememberEnv("NEWSLETTER_ENV_TEST_NEW");
    process.env.NEWSLETTER_ENV_TEST_EXISTING = "from-shell";
    delete process.env.NEWSLETTER_ENV_TEST_NEW;

    const dir = await mkdtemp(path.join(tmpdir(), "newsletter-env-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, [
      "NEWSLETTER_ENV_TEST_EXISTING=from-file",
      "NEWSLETTER_ENV_TEST_NEW=\"from file\""
    ].join("\n"));

    loadEnvFile(envPath);

    expect(process.env.NEWSLETTER_ENV_TEST_EXISTING).toBe("from-shell");
    expect(process.env.NEWSLETTER_ENV_TEST_NEW).toBe("from file");
  });
});

function rememberEnv(key: string): void {
  if (!envKeysToRestore.has(key)) {
    envKeysToRestore.set(key, process.env[key]);
  }
}
