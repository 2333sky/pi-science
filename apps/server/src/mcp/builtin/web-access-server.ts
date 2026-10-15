import { prepareWebAccessConfig } from "../web-access-config.js";

// The upstream CLI loads configuration during module initialization. Set its
// directory before importing it, including when a connector binds another one.
process.env.PI_CODING_AGENT_DIR = await prepareWebAccessConfig();
const entry = import.meta.resolve("pi-web-access/dist/mcp-cli.js");
await import(entry);
