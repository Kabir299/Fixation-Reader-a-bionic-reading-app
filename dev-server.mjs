// Local preview: serves public/ and runs the api/ functions like Vercel does.
// Usage: set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in your shell, then `npm run dev` and open http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/ai.js";
import ttsHandler from "./api/tts.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT || 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const fn = url.pathname === "/api/ai" ? handler : url.pathname === "/api/tts" ? ttsHandler : null;
    if (fn) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = raw;
      }
      return fn(req, res);
    }
    const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Fixation Reader on http://localhost:${PORT}`));
