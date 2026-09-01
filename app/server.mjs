// Minimal static server. MediaPipe needs correct MIME types for .wasm and .mjs,
// which Python's http.server does not provide.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";

// resolve() so ROOT and the joined path use the same separators on Windows
const ROOT = resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const PORT = process.env.PORT || 8742;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".wasm": "application/wasm",
  ".bin": "application/octet-stream", ".tflite": "application/octet-stream",
  ".task": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const file = resolve(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const info = await stat(file);
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

// A single bad request should never take the whole server down. Without these
// an unexpected throw kills the process and the page simply stops loading.
process.on("uncaughtException", err => console.error("[ignored]", err.message));
process.on("unhandledRejection", err => console.error("[ignored]", err));

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`
Port ${PORT} is already in use - the app is probably already running.`);
    console.error(`Open http://localhost:${PORT} , or free the port with:`);
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`
  bodycomp app running`);
  console.log(`  open  http://localhost:${PORT}`);
  console.log(`
  Leave this window open. Ctrl+C to stop.
`);
});
