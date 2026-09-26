// Zero-dependency echo server for preview debugging. Serves on 5173.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

let hits = 0;
createServer((req, res) => {
  hits++;
  const info = {
    n: hits,
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
  };
  appendFileSync("/tmp/echo-hits.log", JSON.stringify(info) + "\n");
  if ((req.url ?? "").startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(info, null, 2));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO OK</title></head>
<body style="font-family:system-ui;padding:2rem;background:#0b0b0f;color:#eee">
<h1 style="font-size:2.5rem;color:#f59e0b">ECHO OK ✓</h1>
<p>If you can read this, the preview proxy works and your request reached the container.</p>
<p>Request #${hits} at ${info.time}</p>
<p>Your User-Agent:</p><pre style="white-space:pre-wrap;background:#18181b;padding:1rem;border-radius:.5rem">${info.headers["user-agent"] ?? "?"}</p>
<p>Host header:</p><pre style="white-space:pre-wrap;background:#18181b;padding:1rem;border-radius:.5rem">${info.headers.host ?? "?"}</pre>
<p><a href="/" style="color:#f59e0b">reload</a></p>
</body></html>`);
}).listen(5173, () => console.log("echo on 5173"));
