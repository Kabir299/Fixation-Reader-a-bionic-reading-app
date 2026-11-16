// Vercel serverless function behind the website's Discuss and Quiz features.
// It forwards the reader's request to an AI model with the site owner's key and
// streams the answer back as plain text, ending with "\u0000" + a JSON trailer.
//
// Provider: GEMINI_API_KEY set -> Google Gemini (free tier works).
//           otherwise ANTHROPIC_API_KEY set -> Claude.
import Anthropic from "@anthropic-ai/sdk";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const CLAUDE_QUICK_MODEL = process.env.CLAUDE_QUICK_MODEL || "claude-haiku-5-5";
const MAX_CHARS = 300_000; // total text per request (~75k tokens)
const MAX_MESSAGES = 60;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_10_MIN || 40);
// Claude models that accept the server-side refusal fallback (`fallbacks: "default"`).
const CLAUDE_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

const SYSTEM =
  "You are the study assistant built into Fixation Reader, a web app for reading books and documents. " +
  "The app sends you the text the reader is studying and says what to do with it. " +
  "Help only with reading, understanding and studying that text, in plain, friendly language.";
const JSON_RULE =
  " Your reply will be read by a program: reply with only the JSON value requested, with no text before or after it.";

// Best-effort per-IP limit. Each serverless instance keeps its own count, so this
// slows abuse rather than stopping it.
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

function validMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_MESSAGES) return null;
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" || !m.content.trim()) return null;
  }
  if (raw[0].role !== "user" || raw[raw.length - 1].role !== "user") return null;
  return raw.map((m) => ({ role: m.role, content: m.content }));
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---------------- Gemini (REST, streamGenerateContent over SSE) ---------------- */
async function streamGemini({ messages, json, quick, signal, write }) {
  // Gemini wants alternating user/model turns, so merge neighbours with the same role.
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n\n" + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  const generationConfig = {
    maxOutputTokens: json ? 16000 : 8000,
    thinkingConfig: { thinkingLevel: json && !quick ? "MEDIUM" : "LOW" },
  };
  if (json) generationConfig.responseMimeType = "application/json";

  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const url = `${base}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM + (json ? JSON_RULE : "") }] }, contents, generationConfig }),
    signal,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("gemini error", r.status, detail.slice(0, 500));
    if (r.status === 429) throw new ProviderError("rate_limited", "The free AI quota is used up for now. Try again later.");
    if (r.status === 400 || r.status === 401 || r.status === 403)
      throw new ProviderError(/API_KEY|PERMISSION|key/i.test(detail) ? "sampling_disabled" : "invalid_request", "The AI service rejected the request.");
    throw new ProviderError("upstream_error", "The AI service had a problem. Try again.");
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", wrote = false, finish = null, blocked = false;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const cand = chunk.candidates?.[0];
    for (const p of cand?.content?.parts || []) {
      if (p.thought || typeof p.text !== "string" || !p.text) continue;
      write(p.text);
      wrote = true;
    }
    if (cand?.finishReason) finish = cand.finishReason;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) handle(buf);
  if (!wrote && (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish || "")))
    throw new ProviderError("refused", "The AI declined this request.");
  return { truncated: finish === "MAX_TOKENS" };
}

/* ---------------- Claude (Anthropic SDK) ---------------- */
let anthropic;
async function streamClaude({ messages, json, quick, signal, write }) {
  anthropic ||= new Anthropic();
  const model = quick ? CLAUDE_QUICK_MODEL : CLAUDE_MODEL;
  // The first message carries the chapter text and stays the same for a whole
  // conversation, so cache it: follow-up questions re-read it at a tenth of the price.
  const apiMessages = messages.map((m, i) =>
    i === 0 && m.content.length > 4000
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
      : m,
  );
  const params = {
    model,
    max_tokens: json ? 16000 : 8000,
    system: SYSTEM + (json ? JSON_RULE : ""),
    messages: apiMessages,
    output_config: { effort: json && !quick ? "medium" : "low" },
  };
  if (CLAUDE_FALLBACK_MODELS.has(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = anthropic.beta.messages.stream(params, { signal });
  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") write(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new ProviderError("refused", "Claude declined this request.");
    return { truncated: final.stop_reason === "max_tokens" };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Anthropic.RateLimitError) throw new ProviderError("rate_limited", "Too many requests. Try again shortly.");
    if (err instanceof Anthropic.AuthenticationError) throw new ProviderError("sampling_disabled", "The AI key was rejected.");
    if (err instanceof Anthropic.BadRequestError) throw new ProviderError("invalid_request", "The AI service rejected the request.");
    if (err instanceof Anthropic.APIUserAbortError) throw new ProviderError("cancelled", "Stopped.");
    throw err;
  }
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { code: "invalid_request", message: "Use POST." });
  }
  if (!sameOrigin(req)) return sendJson(res, 403, { code: "not_granted", message: "Requests must come from this site." });
  const provider = process.env.GEMINI_API_KEY ? streamGemini : process.env.ANTHROPIC_API_KEY ? streamClaude : null;
  if (!provider) return sendJson(res, 503, { code: "sampling_disabled", message: "The AI service is not set up on this server." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) return sendJson(res, 429, { code: "rate_limited", message: "Too many requests. Try again in a few minutes." });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const messages = validMessages(body && body.messages);
  if (!messages) return sendJson(res, 400, { code: "invalid_request", message: "Malformed conversation." });
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_CHARS) return sendJson(res, 413, { code: "prompt_too_large", message: "That text is too long to send at once." });

  const ctl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ctl.abort();
  });
  let started = false;
  const write = (t) => {
    if (!started) {
      started = true;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
    }
    res.write(t);
  };

  let trailer;
  try {
    const { truncated } = await provider({ messages, json: body.json === true, quick: body.tier === "quick", signal: ctl.signal, write });
    trailer = { ok: true, truncated };
  } catch (err) {
    if (!(err instanceof ProviderError)) console.error("ai request failed:", err?.status, err?.message);
    const code = err instanceof ProviderError ? err.code : ctl.signal.aborted ? "cancelled" : "upstream_error";
    const message = err instanceof ProviderError ? err.message : "The AI service had a problem. Try again.";
    // Nothing streamed yet: answer with a proper status so the page shows the right message.
    if (!started) return sendJson(res, code === "rate_limited" ? 429 : code === "sampling_disabled" ? 503 : 502, { code, message });
    trailer = { ok: false, code, message };
  }
  if (!started) write("");
  if (!res.writableEnded) res.end("\u0000" + JSON.stringify(trailer));
}
