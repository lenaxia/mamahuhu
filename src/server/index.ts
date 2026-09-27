import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { makeApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const data = process.env.DATA_DIR ?? "./data";
mkdirSync(`${data}/photos`, { recursive: true });

const { app } = await makeApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[mamahuhu] listening on http://0.0.0.0:${info.port}`);
});

process.on("SIGTERM", () => process.exit(0));
