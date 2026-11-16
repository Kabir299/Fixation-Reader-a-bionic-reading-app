# Fixation Reader

A reading website: upload a PDF, EPUB, Word or text file and read it with bold word starts, a pacer, read-aloud, flash reading, highlights and notes. Discuss, Quiz and the AI voices use Google Gemini (a free key works); Claude is supported as an alternative.

Live: https://fixation-reader.vercel.app

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | The whole website (one page). Books are stored in each visitor's own browser. |
| `api/ai.js` | Serverless function for Discuss and Quiz. Uses Gemini when `GEMINI_API_KEY` is set, otherwise Claude when `ANTHROPIC_API_KEY` is set. |
| `api/tts.js` | Serverless function for the AI voices (Gemini text-to-speech), about a paragraph per request. |
| `vercel.json` | Tells Vercel to serve `public/` and run the functions. |
| `dev-server.mjs` | Local preview: set a key in your shell, `npm run dev`, open http://localhost:3000 |

## Deploying changes

```
npx vercel --prod
```

## Keys and settings (Vercel project, Settings, Environment Variables)

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | none | Free key from https://aistudio.google.com/apikey. Turns on Discuss, Quiz and AI voices. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model for Discuss and Quiz. |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` | Model for the AI voices. |
| `TTS_DISABLED` | unset | Set to `1` to hide AI voices (for example, to save quota). |
| `ANTHROPIC_API_KEY` | none | Use Claude instead of Gemini for Discuss and Quiz (only when no Gemini key is set). |
| `RATE_LIMIT_PER_10_MIN` / `TTS_RATE_LIMIT_PER_10_MIN` | 40 / 150 | Per-visitor request limits. |

After changing a variable, run `npx vercel --prod` so the change takes effect.

## Free-tier notes

- Gemini's free tier has a small daily quota (third-party trackers report about 500 requests a day for Flash-Lite), shared by everyone using the site. When it runs out, Discuss and Quiz show "quota used up" and the AI voice switches to a device voice until the quota resets (midnight Pacific).
- AI voices use about one request per paragraph, so they spend quota fastest.
- On Google's free tier, the text you send may be used to improve Google's products. Don't put private documents through Discuss, Quiz or AI voices on a free key.
