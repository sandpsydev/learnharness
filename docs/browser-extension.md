# LearnHarness Medical browser extension

A Manifest V3 extension for Chrome and Chromium browsers (Edge, Brave, Arc),
kept in `extension/`. It speaks only to the paired loopback API described in
[verify-api.md](verify-api.md). Run the matching app version to accept topic
citations that have titles and sections without URLs.

The page adapter uses the owner's 2026-10-29 and 2026-10-30 inspections of the
fresh screen, answered conversation and sources layouts. The owner confirmed
that Send appears only after the answer finishes in the manual loop. This
implementation is tested against reconstructed generic fixtures only; no agent
opened or read the live site. Manual copy/paste remains available.

## Load it in Chrome

1. In the repository, run `npm ci` (if needed), then `npm run extension:build`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   and select this repository's `dist/extension` folder.
3. Pin **LearnHarness Medical** in the toolbar. Open its **Settings**.
4. In the running LearnHarness app, open **Settings → Providers → Browser
   extension → Pairing details**. Copy the address and pairing token into the
   extension settings. Automatic mode defaults on. Save, then choose **Test saved
   connection**. Turn automatic mode off before saving if you want only manual use.
5. Queued tutor questions are now asked and returned automatically. The popup
   still shows the queue, manual controls and any pause notice. Never queue
   personal data or patient identifiers.

Rebuild and click **Reload** on the extension card after changing source code.
Reload already-open Expert AI tabs to update their content scripts. An
automatic question left over from before the reload is settled by the worker
without that (see "When an attempt's outcome is lost"). No store
upload or paid account/key is needed. Equivalent extension pages in Edge and
Brave support loading unpacked extensions; Arc uses Chrome's extension UI.

## Automatic mode

The owner approved automatic asking and return on 2026-10-30. Chrome alarms
check the paired local queue once a minute even with the popup closed, waking
the MV3 worker when necessary. Completed answers also notify the worker so they
can return promptly. One question runs at a time, in a normal Chrome window of its
own that the extension opens unfocused (`focused: false`), so it does not take
over the tab you are reading. It cannot be a background tab: Expert AI only
enables Send in a page the browser shows, and a background tab is hidden. Leave
that window open; it may sit behind your other windows. Automatic runs never
activate a tab and never choose a learner-owned conversation. The exception to
"never takes focus": Chrome treats a managed window that is minimized, or on
macOS completely covered by another window, as hidden, and Expert AI will not
enable Send for a hidden page. So before filling, if the page reports itself
hidden, the worker restores the window if it is minimized, focuses it, and waits
up to about five seconds for the page to become visible. Focus stays on the
managed window until Send has been pressed, and is then handed straight back to
the window you were using (so the managed window may cover or flash over your
work for the few seconds of a fill, and not while it waits for the answer). A
page that is already visible is never focused. Likewise, Expert AI's editor
ignores typed text in a window that does not have focus, so if the plain fill is
ignored the page asks the worker for focus for the fill alone. Both only happen
for the managed window and the current automatic question. Subsequent
questions reuse that managed window, starting a fresh conversation each time. If
you close it, the next question opens a new one. A managed page left over from an
older version as a background tab is moved into a window of its own.
The response mode must already read **Standard**; the dropdown is never changed.
Only the screened queue item's prompt is filled, with an additional identifier
check before automatic sending. No other page or app text is sent as a prompt.

The completed answer and its source titles/sections are returned through the
existing app API without a learner click. The app keeps its current notice and
next-turn hand-off. Collection uses the existing copy-action-bar completion
signal and sources controls; it does not open individual source cards.

A page that is still loading or redirecting (for example through a sign-in
address) is given up to 30 seconds to reach Expert AI's start screen before
anything is filled; the extension only calls the window signed out when the page
really shows a sign-in screen, and says "still loading" when it simply was not
ready. Every page failure names the step that failed (finding the question box,
starting a new conversation, inserting the text, enabling Send), never a generic
sign-in message.

Sign-in/access screens, open pop-ups, page failures, missing completion after
two minutes, and answer-delivery failures pause automatic mode. If the app is
closed before any question starts, only the local queue check retries on later
alarms, so launching the app after Chrome needs no popup click. The toolbar
shows **!**; open the popup for the plain-language reason. An attempt that
never pressed Send, whether or not the prompt was already typed in, leaves the
app question queued, clears the typed draft and the local binding, and pauses
with the page's own reason. A hidden managed page (window minimized or
completely covered) is restored and brought forward first, as described above, so
this is not a pause reason in normal use. Only if the page still is not visible
after that attempt (about five seconds), automatic mode stops without filling
anything and says the page is hidden; it does not ask you to sign in. Un-minimize
or uncover the window and save settings to resume. Nothing is left to release.
Reading a finished answer does not need the window to be visible; if a read
fails while the page is hidden, the window is brought forward once for that read
and focus is handed straight back, instead of pausing. The
extension never signs in, dismisses a site pop-up, or resubmits a question that
may have been sent. Fix the page or connection yourself, then open extension
Settings and save with automatic mode on to resume.

### Recording Send before it is pressed

Just before the page clicks Send it asks the worker to write a durable marker
for that request (`sending`, kept in `chrome.storage.local` beside the attempt).
The click happens only if the marker was accepted. So an attempt with no marker
provably never pressed Send, however it was cut off: an extension reload or
browser restart, a page reload or redirect that replaces the content script, or
a worker restart. For an automatic question the worker then settles it itself
without consulting the page: the attempt is dropped, the question stays queued
and automatic mode asks it again. In the same step the worker refuses any later
marker for that request, so a page script that outlived the decision cannot
press Send for a question that already went back to the queue.

This retry is allowed once per question. If the same question is cut off before
Send a second time, automatic mode pauses with a message saying nothing was sent
and why; saving settings or releasing resets the count. If a marker exists, the
click may or may not have happened, and the rules below apply unchanged. An
attempt saved by an older version of the extension has no way to show it was
unsent, so it also keeps the uncertain pause until you release it.

### When an attempt's outcome is lost

A worker cut off mid-attempt, a browser restart or an extension reload can leave
an automatic question whose outcome is unknown. If its Send marker was never
written, it is settled without the page, as above. Otherwise the next automatic check looks
at its managed tab instead of pausing straight away. If the tab was loaded
before the extension reloaded, the worker adds its own `content.js` to that tab
once, using the `scripting` permission on Expert AI pages only. The page then
decides, from what it shows:

- **Sent:** the prompt text appears in the conversation (outside the composer,
  ignoring whitespace). The extension marks the question asked in the app,
  collects the finished answer as usual and never submits again.
- **Not sent:** the prompt is still in the start screen's composer and no
  answer exists. The draft is cleared, the question goes back to the queue and
  automatic asking continues, in the same tab. If the same page problem
  repeats, that new attempt pauses cleanly as described above, so this cannot
  loop.
- **Neither can be proved** (tab closed or navigated away, an empty page, a page
  that is still working): automation pauses as before. The popup keeps the first,
  specific reason (for example, "Switch Expert AI to Standard") alongside the
  note that the tab could not prove it, and saving settings does not replace it
  with a generic message. Check the tab, then return the answer manually or
  release the question. Saving settings with automatic mode on checks the tab
  again.

A question you took over manually (Copy prompt, manual Ask) is never probed or
released automatically; after a restart it still pauses automation for review.

Uncheck **Automatically ask queued Expert AI questions and return finished
answers** in extension Settings and save to stop automatic work. Manual
controls remain available. Saving pairing addresses or the token still requires
releasing the current question first; the automatic switch can be changed while
an answer is pending. Settings changes share the mutation lock, so an action
already filling, sending or collecting must finish first. Turning automatic
mode back on resumes a pending completed answer without resubmitting it.

## Manual asking, return and highlights

- **Ask in Expert AI**, or **Ctrl+Shift+L on Mac**, **Alt+Shift+L elsewhere**,
  focuses an existing Expert AI tab or opens a visible one, starts a new
  conversation, fills the prompt and submits. If it chooses the managed tab,
  that tab becomes manual and later automatic questions get a separate window.
  Manual fill/send requires the tab
  and window to stay visible/focused. Shortcut settings are at
  `chrome://extensions/shortcuts`. Each question still requires Standard mode.
- **Copy prompt / manual return** binds a queue item and copies its exact prompt.
  This takes manual control of that question until return or release.
  In your own logged-in Expert AI tab, start **New conversation**, keep
  **Standard**, paste and submit yourself. Paste the completed answer into the
  popup, add source titles/sections or URLs (one per line) and the answer page
  URL, then choose **Send to LearnHarness**.
- When a completed answer appears in a bound tab, **Send to LearnHarness** and
  **Send & ask next** remain available. Manual Send requires a real learner click
  in the visible, focused tab. Only the current tab/request can return its answer.
  **Send & ask next** sends this answer, then manually asks the next question.
  A normal manual send starts no query itself; automatic mode may discover the
  next queued item at its next alarm.
- Sources are read from the right pane or bottom drawer, opening it if necessary
  and restoring its previous state. Topic titles and sections are sent; links
  and PMIDs/DOIs are kept when present. Inline source numbers are omitted because
  their mapping to cards is unknown. Drug names remain; suggested questions,
  source pills, thinking details and disclaimers are excluded.
- Select text on a guideline, paper or browser PDF, right-click, then choose
  **Send to LearnHarness**. Only selected text, page URL and title are sent.
  Other pages have no injected content script; the whole document is not read.
  Highlights go to the most recently active teaching session.
- For restricted pages/PDF viewers, use **Send a highlight or PDF passage
  manually** in the popup with the original HTTP(S) URL. Local `file:` and
  browser-internal URLs are not accepted.
- Failed answers are retained for retry before network I/O. Manual failures also
  attempt to copy evidence to the clipboard; automatic runs leave your clipboard
  alone. Reopen the popup to restore saved evidence. Active bindings, managed tab
  IDs and recovery drafts survive worker sleep in browser session storage.
  Recovery drafts and tab IDs clear on browser restart, extension reload/update
  or disable, so save unsent evidence first. An active-question guard persists
  locally: after losing session state, it restores the question as uncertain.
  A manual question pauses automation for review with no trusted tab ID. An
  automatic one keeps its last tab ID only as a place to look; the page itself
  must show the prompt before anything is trusted (see above). This also
  protects a submitted question whose app entry still says queued. Settings,
  token and the guard stay in this profile and do not sync through Chrome.
- **Release current question** clears the local binding, return draft and pause.
  It leaves the app queue entry unchanged. Copy unsent evidence first. Automatic
  mode can then select queued entries again; turn it off before releasing if
  you want to remain in manual control.

All mutations share a lock. Lost submission acknowledgement after filling is
uncertain and never automatically retried. The hidden clipboard document only
contains text being copied and loads no external page. App fetches originate
in the worker with the Bearer token. Content scripts never get the token, and
external messages are not accepted. No remote extension code is loaded.

## Local tests and first live automatic run

`npm run lint`, `npm run typecheck`, and `npm test` cover the extension and
local-only fixtures, including a temporary unpacked build. Fixtures contain
only generic reconstructed content, with no captured questions, answers,
source titles or conversation IDs. Tests need no accounts, keys or live site.

The owner should check this first live automatic run:

1. Rebuild, reload the extension and page scripts, pair it and enable automatic
   mode. Keep the popup closed. Queue two generic management questions.
2. Stay in the study tab (also try focusing another window). Within about a
   minute, a separate Chrome window should open behind or beside your own, start
   a new Standard conversation, fill the exact first prompt and submit once,
   without stealing focus or changing any conversation already open in your own tab.
3. Confirm that streaming finishes before automatic return, that the app shows
   **Expert AI answer received**, and that the next tutor turn gets the answer
   plus source titles/sections. Check both right-pane and bottom-drawer layouts
   when available. The second question should follow in its own fresh conversation.
4. Leave the popup closed long enough for the worker to sleep, then queue another
   question. Confirm it still runs. Repeat with the managed window unfocused, again after closing it (a new one opens),
   again with it completely covered by another window, and again minimized: the
   question should still be filled and sent, the window should come forward only for
   that, and focus should return to the window you were using.
5. Test signed-out access or a site pop-up: nothing should fill or submit, the
   question should stay queued, and **!** plus a clear popup notice should appear.
   Sign in/close the pop-up yourself and save settings to resume.
6. Turn automatic mode off: queued prompts and completed pending answers should
   wait. Try manual Ask, Copy prompt/manual return, Send and a highlight. Turn
   automatic mode on again to resume. A pending answer must not resubmit its prompt.
7. If the tab fails after submission, confirm it pauses and never submits again.
   Check the tab and use manual return before releasing anything uncertain.
8. After installing a new extension build over a stuck pause, reload the
   extension and wait up to a minute without clicking anything. The leftover
   question should be re-asked, or its answer collected, or (if the tab cannot
   prove it) the pause should name the original reason.

These live checks must be done by the owner; the implementation agent must
never open, fetch, automate or read the live Expert AI site.
