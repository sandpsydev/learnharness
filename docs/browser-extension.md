# LearnHarness Medical browser extension

A Manifest V3 extension for Chrome and Chromium browsers (Edge, Brave, Arc),
kept in `extension/`. It speaks only to the paired loopback API described in
[verify-api.md](verify-api.md). Run the matching app version to accept topic
citations that have titles and sections without URLs.

The page adapter uses the owner's 2026-10-29 inspection of the fresh screen,
answered conversation, and sources drawer. This implementation was tested only
against reconstructed local fixtures; no agent opened or read the live site.
The copy action bar is the best available completion signal, but it has not
been checked against a mid-answer capture. Manual copy/paste remains available.

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
  titles/sections or URLs (one per line) and the answer page URL, then choose **Send to LearnHarness**.
- **Send & ask next** returns this answer, then attempts the next queued question
  from the same learner action. A normal send starts no further query.
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

## Ask and return controls

Click **Ask in Expert AI** or use **Ctrl+Shift+L on Mac**, **Alt+Shift+L elsewhere**
(change it at `chrome://extensions/shortcuts` if it conflicts). The extension
focuses an existing Expert AI tab or opens a visible one. It starts a new
conversation, fills one prompt, submits it, and marks it asked in LearnHarness.
Before filling, it checks that the response mode reads **Standard** and asks
you to switch it yourself if needed. It never changes the dropdown. The learner must leave the tab and
window visible/focused during fill/send. Sign-in/access screens leave the item
queued and give the sign-in/university-network message. Visible welcome,
disclaimer or dosing popups ask you to close the popup and retry. The extension
waits up to ten seconds for the fresh screen and send button.

When a completed answer appears, **Send to LearnHarness** and **Send & ask next**
appear beside it. Nothing is returned until a real learner click. Only the current
question's tab/request can return its answer. During your Send click, it reads
the answer's sources drawer, opening it if needed and restoring its previous
open/closed state. Topic sources are sent by title and section; links and
PMIDs/DOIs are kept when present. It does not open individual source cards.
Inline source numbers are omitted because their mapping to drawer cards is
unknown. Drug names remain in the answer; suggested questions, source pills,
thinking details and disclaimers are excluded. If completion is not detected
within two minutes, a message points to manual paste-back without resubmitting.
A local binding and a mutation lock
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

## Local tests and first live try

`npm run lint`, `npm run typecheck`, and `npm test` cover the extension and its
local-only tests. The suite builds a temporary unpacked extension and checks
its assets. The fixtures under `tests/fixtures/extension/` reconstruct the
inspected structure with generic content; they contain no captured questions,
answers, source titles, conversation IDs, message IDs or nudge values. Tests
need no external network, accounts or keys.

For the learner's first live try, load the extension as above, choose a generic
queued question, and click **Ask in Expert AI**. Confirm a new conversation opens
in Standard mode with the exact prompt. Note whether **Send to LearnHarness**
appears before the answer has finished streaming; the copy-button completion
signal still needs that check. After reading the finished answer, send it and
confirm that the app receives its text plus source titles and sections. Try
sending with the sources drawer both closed and already open; its state should
be preserved. Use manual paste-back if the page layout differs. This live check
must be done by the learner, never by an AI browser agent.
