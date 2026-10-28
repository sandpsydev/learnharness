# LearnHarness Medical browser extension

A Manifest V3 extension for Chrome and Chromium browsers (Edge, Brave, Arc),
kept in `extension/`. It speaks only to the paired loopback API described in
[verify-api.md](verify-api.md). No app-side API changes are needed.

**Expert AI page controls are not live-verified.** This build never opened,
fetched, read, or automated the live site. The page adapter uses deliberately
unverified placeholders; automatic submission will fail closed until the owner
inspects the logged-in page and updates `extension/expert-page.ts`. The manual
copy/paste route and selection capture work independently of that adapter.

## Load it in Chrome

1. In the repository, run `npm ci` (if needed), then `npm run extension:build`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   and select this repository's `dist/extension` folder.
3. Pin **LearnHarness Medical** in the toolbar. Open its **Settings**.
4. In the running LearnHarness app, open **Settings → Providers → Browser
   extension → Pairing details**. Copy the address and pairing token into the
   extension settings. Save, then choose **Test saved connection**.
5. Open the toolbar popup. The teacher's questions appear in the queue. Read each
   prompt before sending; never send personal data or patient identifiers.

Rebuild and click **Reload** on the extension card after changing source code.
Reload any already-open Expert AI tab to update its content script. No store
upload or paid account/key is needed. Equivalent extension pages in Edge and
Brave also support loading unpacked extensions; Arc uses Chrome's extension UI.

## Use it now: manual fallback and highlights

- Choose **Copy prompt / manual return** on a queue item. It becomes the current
  question and its exact prompt goes to the clipboard. In your own visible,
  logged-in Expert AI tab, start **New conversation**, keep **Standard**, paste,
  and submit yourself. Paste the completed answer into the popup, add reference
  URLs (one per line) and the answer page URL, then choose **Send to LearnHarness**.
- **Send & ask next** returns this answer, then attempts the next queued question
  from the same learner action. With the placeholder adapter, it copies that next
  prompt and offers the manual route. A normal send starts no further query.
- Select text on a guideline, paper, or browser PDF, right-click, then choose
  **Send to LearnHarness**. The context menu passes only the selected text, page
  URL and title. It uses `activeTab`; it does not inject a content script into
  other pages or read the whole document. The app routes it to the most recently
  active teaching session. Start a teaching session first.
- Some PDF viewers and restricted pages do not expose a selection context menu.
  Use **Send a highlight or PDF passage manually** in the popup and provide the
  original HTTP(S) URL. Local `file:` and browser-internal URLs are not accepted
  by the app API; use the document's original web URL.
- If LearnHarness is closed or a send fails, the evidence is kept in browser
  session storage for retry and copied to the clipboard where possible. Reopen
  the popup to restore it. Session storage survives extension-worker sleep but
  clears on browser restart, extension reload/update, or disable. Save a copy
  before doing those things. The token/settings alone persist in local storage;
  they do not sync through Chrome.
- **Release current question** clears the local binding and saved return draft.
  It does not dismiss or delete the app queue entry. Copy any unsent answer first.
  Use it after closing a question tab or to deliberately retry an uncertain send.

## Ask/return controls after owner verification

Click **Ask in Expert AI** or use **Ctrl+Shift+L on Mac**, **Alt+Shift+L elsewhere**
(change it at `chrome://extensions/shortcuts` if it conflicts). The extension
focuses an existing Expert AI tab or opens a visible one. It starts a new
conversation, fills one prompt, submits it, and marks it asked in LearnHarness.
It never changes the response-mode dropdown. The learner must leave the tab and
window visible/focused during fill/send. Sign-in/access screens leave the item
queued and give the sign-in/university-network message.

When a completed answer appears, **Send to LearnHarness** and **Send & ask next**
appear beside it. Nothing is returned until a real learner click. Only the current
question's tab/request can return its answer. A local binding and a mutation lock
prevent overlapping questions, duplicate clicks and stale-answer returns. A lost
submission acknowledgement is treated as uncertain and never automatically
retried. An API failure after successful submission leaves the binding intact;
return the answer manually rather than submitting the prompt again.

There are no background queries, queue polling, hidden site tabs, login handling,
mode changes, AI-agent browser actions, or remote extension code. The optional
hidden clipboard document contains only the text being copied; it never loads
an external page. All app fetches, including highlights, originate in the service
worker with the Bearer token. Page scripts never receive that token, and the
extension does not accept external messages.

## Tests and the later owner step

`npm run lint`, `npm run typecheck`, and `npm test` cover extension source and its
local-only tests. `npm run extension:build` bundles five entry points and copies
the manifest, HTML and CSS into ignored `dist/extension`. The test suite also
builds a temporary extension and checks that its entry points and assets exist.
No browser account, live site, API key, or network connection is used in tests.

`tests/fixtures/extension/expert-ai.html` is a fictional minimal page based only
on the spec's written screenshot description. It is not captured site HTML.
Tests exercise fresh-conversation order, unchanged mode, missing/access/hidden
controls, completed-answer/reference extraction, one-at-a-time state, next-item
chaining, offline recovery, manual return, pairing and highlights.

The owner-present inspection is a separate held step. Its seam is
`extension/expert-page.ts`: replace and verify the question box, new-conversation
control, submit arrow, answer/completion markers, references, access detection,
and fresh-conversation readiness signals there. Confirm the textarea input events
against the actual UI. Keep the content-script match restricted to
`https://ai.uptodate.com/*`. Do not use an AI agent to perform that inspection.
