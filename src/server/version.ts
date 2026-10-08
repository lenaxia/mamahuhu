import { createRequire } from "node:module";
import { resolve } from "node:path";

/**
 * App version from package.json. Resolved from the CWD (workspace root in dev,
 * /app in the Docker image — package.json is COPYed there), NOT from
 * import.meta.url: esbuild bundles this file into dist/server.js, which breaks
 * source-relative paths at runtime (the v0.5.0 crashloop).
 */
const req = createRequire(import.meta.url);
export const APP_VERSION: string = (req(resolve(process.cwd(), "package.json")) as { version: string }).version;
