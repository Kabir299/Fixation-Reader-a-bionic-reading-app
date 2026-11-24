// Vercel serverless function: fetches a free public-domain EPUB from Project Gutenberg for the "Find books" window.
// Gutenberg's file servers don't allow browsers on other sites to download directly, so this relays the file.
// POST { pg: "1342" } -> application/epub+zip
// Only Gutenberg book numbers are accepted, and only Gutenberg's own hosts are contacted.
const HOSTS = ["https://www.gutenberg.org", "https://gutenberg.pglaf.org"];
const MAX_BYTES = 4_200_000; // Vercel responses top out at about 4.5 MB
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.BOOK_RATE_LIMIT_PER_10_MIN || 30);
const UA = "FixationReader/1.0 (+https://fixation-reader.vercel.app)";

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Download one candidate file; returns a Buffer, "too_big", or null.
async function tryFetch(url) {
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  } catch {
    return null;
  }
  if (!r.ok || !r.body) return null;
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) {
    r.body.cancel().catch(() => {});
    return "too_big";
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > MAX_BYTES) return "too_big";
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return null;
  }
  const buf = Buffer.concat(chunks);
  return buf.subarray(0, 2).toString("ascii") === "PK" ? buf : null; // an EPUB is a zip file
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { code: "invalid_request", message: "Use POST." });
  }
  if (!sameOrigin(req)) return sendJson(res, 403, { code: "not_granted", message: "Requests must come from this site." });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) return sendJson(res, 429, { code: "rate_limited", message: "Too many downloads. Try again in a few minutes." });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const id = String(body?.pg ?? "");
  if (!/^\d{1,6}$/.test(id)) return sendJson(res, 400, { code: "invalid_request", message: "Send a Project Gutenberg book number." });

  // Prefer the edition with pictures; fall back to the smaller one if it is too big or missing.
  const names = [`pg${id}-images-3.epub`, `pg${id}.epub`];
  let tooBig = false;
  for (const name of names) {
    for (const host of HOSTS) {
      const out = await tryFetch(`${host}/cache/epub/${id}/${name}`);
      if (out === "too_big") {
        tooBig = true;
        break; // same file on the mirror is just as big; try the smaller edition
      }
      if (out) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/epub+zip");
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
        return res.end(out);
      }
    }
  }
  if (tooBig) return sendJson(res, 413, { code: "too_big", message: "This book is too large to add from here. Download it from Project Gutenberg and drop the file in." });
  return sendJson(res, 502, { code: "upstream_error", message: "Project Gutenberg didn't send the book. Try again in a minute." });
}
