# Extension API (v1)

The local API the LearnHarness browser extension (`med-extension`) talks to. It is how the Expert AI question queue gets out of the app and how answers and highlighted text get back in. Code: `src/server/verify-api.ts` (transport + guard), `src/server/verify.ts` (what each call does), `src/core/contracts/verify.ts` (shapes). Spec: `docs/medical-spec.md`, "UpToDate Expert AI loop".

**The line this API keeps:** the app never queries UpToDate. Every question is run by the extension, one at a time, from the learner's click, in the learner's own logged-in Expert AI tab. This API only hands out the questions and takes the answers back.

## Where it listens

A separate listener on **`http://127.0.0.1:47615`** — loopback only, never the network. (The app's own server takes a random port in the desktop build, so it cannot be used.) Override the port with `LH_VERIFY_PORT`. If the port is taken (a second LearnHarness is running) the API is simply off for that instance; `GET /v1/ping` fails from the extension's side, and Settings says so.

The extension's config needs two values: the **address** above and the **pairing token**. Both are shown in LearnHarness → Settings → Providers → *Browser extension* → *Pairing details* (`GET /api/verify/pairing` on the app's own server feeds that panel). The token is made once and kept in `<data dir>/verify/pairing.json` (mode 0600). `LH_VERIFY_TOKEN` overrides it.

## The guard

Every request passes all of these, in order. A web page the learner has open can fail every one of them.

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding) — else `403 bad_host`.
2. **Origin**, when the browser sends one, must be a browser-extension origin, `chrome-extension://<32 letters a–p>` (Chrome, Edge, Brave and Arc all use it) — else `403 bad_origin`. Set `LH_EXTENSION_ORIGIN=chrome-extension://<id>` in the app's environment to accept exactly one extension id. Requests with no `Origin` (e.g. `curl`) are judged by the token alone.
3. **`Authorization: Bearer <pairing token>`** on every call except `GET /v1/ping` — else `401 unauthorized`.
4. **`Content-Type: application/json`** on every POST — else `415`.
5. Bodies are capped at 256 KB (`413`).

Preflight (`OPTIONS`) is answered only for extension origins. **Make the calls from the extension's service worker** (with `host_permissions` for `http://127.0.0.1/*`), not from a content script: a content script runs with the *page's* origin and is refused by rule 2, which is the point.

## Errors

Every error is JSON: `{ "ok": false, "error": { "code": "...", "message": "..." } }`. `code` is one of `bad_host`, `bad_origin`, `unauthorized`, `unsupported_media_type`, `invalid` (400), `not_found` (404), `conflict` (409), `too_large`, `internal`. `message` is plain English fit to show the learner.

## Endpoints

All responses are JSON with `ok: true` on success.

### `GET /v1/ping` — no token needed

Is the app up, and is this extension paired?

```json
{ "ok": true, "app": "learnharness", "apiVersion": 1, "authenticated": true }
```

`authenticated: false` means the token is missing or wrong — send the learner to Settings. Check `apiVersion`; this document describes `1`.

### `GET /v1/queue`

The questions waiting to be run, oldest first — `queued` ones, then any `asked` ones the learner may want to re-run (a closed tab, say). Across all sessions.

```json
{
  "ok": true,
  "items": [
    {
      "id": "vq_mgx1k2_ab12cd34",
      "chatId": "chat_…",
      "chatTitle": "Heart failure",
      "prompt": "A man in his late fifties with HFrEF …",
      "status": "queued",
      "createdAt": "2026-10-29T08:00:00.000Z"
    }
  ]
}
```

`prompt` is complete and self-contained: paste it as-is into a fresh Expert AI conversation. It contains no patient identifiers (the app refuses to queue any that look like one — but still treat the text as the learner's to review before it is sent).

### `POST /v1/queue/:id/asked`

The extension has filled the prompt into the page (the learner clicked). Marks the item `asked`. No body needed (`{}`).

```json
{ "ok": true, "id": "vq_…", "status": "asked" }
```

`404` unknown id; `409` it is already answered or dismissed.

### `POST /v1/queue/:id/answer`

The learner pressed *Send to LearnHarness* next to the answer.

```json
{
  "text": "The answer text, as shown on the page …",
  "references": [
    { "title": "Heidenreich PA, et al. 2022 AHA/ACC/HFSA guideline …", "url": "https://doi.org/10.1161/CIR.0000000000001063" }
  ],
  "sourceUrl": "https://ai.uptodate.com/…"
}
```

- `text` — required, 1–60 000 characters.
- `references` — optional, up to 100 of `{ url, title? }`; `url` must be `http(s)`.
- `sourceUrl` — optional, the page it came from.

Reply (the answer is stored before this returns):

```json
{ "ok": true, "id": "vq_…", "status": "answered", "next": { "id": "vq_…", "chatId": "…", "chatTitle": "…", "prompt": "…", "status": "queued", "createdAt": "…" } }
```

`next` is the next `queued` question (or `null`) — the same session's first, then the oldest anywhere — this is what makes **Send & ask next** one keypress: send the answer, then immediately fill `next.prompt`, then call `/asked` for it. `409` if it was already answered (a double click is harmless: the first answer stands).

What the app does next, in the background (the extension need not wait): checks every PMID/DOI in the text and reference links against PubMed, then gives the teacher the answer, the references and that check so it can compare with what it taught, correct what differs, cite "UpToDate Expert AI, [date]" and offer the key points for Anki.

### `POST /v1/queue/:id/dismiss`

The learner skipped the question. Marks it `dismissed`; same reply shape as `/answer` (with `next`). `409` if already answered.

### `POST /v1/highlights`

Highlighted text from any page ("Send to LearnHarness" on a guideline, a paper, a PDF in the browser).

```json
{
  "text": "The highlighted passage …",
  "url": "https://www.nice.org.uk/guidance/ng106",
  "title": "Chronic heart failure in adults — NICE",
  "references": [{ "title": "…", "url": "https://…" }],
  "chatId": "chat_…"
}
```

- `text` — required, 1–20 000 characters. `url` — required, `http(s)`.
- `title`, `references` — optional, as above.
- `chatId` — optional. Without it the highlight goes to the **most recently active teaching session**. With no sessions at all the reply is `409` ("start one in LearnHarness first").

```json
{ "ok": true, "id": "vh_…", "chatId": "chat_…" }
```

The teacher receives the text as evidence from that page and cites it by title and URL.

## Notes for the extension

- Ask exactly one question at a time and only from a learner action; never from a background or hidden tab.
- The queue can change while the extension is open (the teacher appends mid-session): re-fetch `GET /v1/queue` when the popup opens and after each send.
- If the Expert AI page shows a sign-in or access screen, do nothing and leave the item `queued` (do not call `/asked`).
- Calls may fail because the app is closed. Treat any network error as "LearnHarness is not running" and keep the answer on the clipboard as the spec's fallback.
- Stability: additive changes (new optional fields) keep `apiVersion` at 1; anything breaking bumps it.
