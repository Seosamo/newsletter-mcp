import { listTools } from "../src/mcp/toolHandlers.js";

process.stdout.write(`${JSON.stringify(listTools(), null, 2)}\n`);
