// Vercel serverless function: natural "AI voice" read-aloud using Gemini text-to-speech.
// GET  -> { available, voices }     (the page asks once, to decide whether to offer AI voices)
// POST { text, voice } -> audio/wav (one paragraph or so at a time)
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts";
const VOICES = ["Kore", "Aoede", "Leda", "Zephyr", "Charon", "Puck", "Orus", "Fenrir"];
const STYLE = process.env.TTS_STYLE || "calm, warm audiobook narration at a natural, unhurried pace";
const MAX_TEXT = 1500;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.TTS_RATE_LIMIT_PER_10_MIN || 150);

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
// Find the last {type:"audio", data:"..."} block anywhere in the response.
function findAudio(node) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "audio" && typeof n.data === "string") found = n;
    Object.values(n).forEach(walk);
  };
  walk(node);
  return found;
}
// Raw 16-bit mono PCM -> WAV, for when the API returns headerless audio/l16.
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export default async function handler(req, res) {
  const available = !!process.env.GEMINI_API_KEY && process.env.TTS_DISABLED !== "1";
  if (req.method === "GET") return sendJson(res, 200, { available, voices: available ? VOICES : [] });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { code: "invalid_request", message: "Use GET or POST." });
  }
  if (!sameOrigin(req)) return sendJson(res, 403, { code: "not_granted", message: "Requests must come from this site." });
  if (!available) return sendJson(res, 503, { code: "unavailable", message: "AI voices are not set up on this server." });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) return sendJson(res, 429, { code: "rate_limited", message: "Too many AI voice requests. Try again in a few minutes." });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const voice = VOICES.includes(body?.voice) ? body.voice : VOICES[0];
  if (!text || text.length > MAX_TEXT) return sendJson(res, 400, { code: "invalid_request", message: "Send between 1 and 1500 characters." });

  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  let r;
  try {
    r = await fetch(`${base}/v1beta/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
  } catch (e) {
    console.error("tts fetch failed", e?.message);
    return sendJson(res, 502, { code: "upstream_error", message: "The voice service could not be reached." });
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("tts error", r.status, detail.slice(0, 500));
    if (r.status === 429) return sendJson(res, 429, { code: "rate_limited", message: "The free AI voice quota is used up for now." });
    if (r.status === 400 || r.status === 403 || r.status === 404)
      return sendJson(res, 503, { code: "unavailable", message: "AI voices aren't available with this API key." });
    return sendJson(res, 502, { code: "upstream_error", message: "The voice service had a problem." });
  }
  const audio = findAudio(await r.json().catch(() => null));
  if (!audio) return sendJson(res, 502, { code: "upstream_error", message: "The voice service returned no audio." });
  let bytes = Buffer.from(audio.data, "base64");
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") bytes = pcmToWav(bytes);
  res.statusCode = 200;
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  res.end(bytes);
}
