# Pocket mode — using LearnHarness from your phone

Pocket mode lets you jot down questions on the ward from your phone, and teach from them at home on the Mac. The Mac does all the work; your phone is just a window onto it. Everything stays on your own devices, it costs nothing, and only you can reach it.

Plan: [`medical-spec.md`](medical-spec.md), Phase 8. The phone side has the **capture inbox**, **quick practice**, phone-sized **sessions** (including Explain my miss) and a view-only **Expert AI queue**.

## What you need (one time)

You need the Mac you study on, your phone, and a free Tailscale account. Tailscale makes a private network, called a *tailnet*, that contains only your own devices. Your phone talks to your Mac over it, and nobody else can.

### 1. Install Tailscale on the Mac

1. Go to <https://tailscale.com/download> and download Tailscale for macOS (or install it from the Mac App Store).
2. Open it. A small icon appears at the top of the screen (the menu bar).
3. Click the icon, then **Log in**. Sign in with an account you already have (Google, Microsoft, Apple or GitHub all work). **Remember which one you choose.**
4. If it asks to add a VPN configuration or enable a system extension, allow it. That is how Tailscale connects.

### 2. Install Tailscale on your phone

1. Install **Tailscale** from the App Store (iPhone) or Google Play (Android).
2. Open it and sign in with **the same account** you used on the Mac. The same account is what puts the two devices on the same private network.
3. Turn the switch on. You should see your Mac listed as a device.

### 3. Turn on HTTPS for your tailnet

Tailscale gives your Mac a private web address that starts with `https://`. HTTPS needs one setting, switched on once:

1. On the Mac (or any computer) open <https://login.tailscale.com/admin/dns> and sign in.
2. Under **HTTPS Certificates**, click **Enable HTTPS** and accept.

That's the last setup step.

## Turning phone access on

1. **Quit the LearnHarness desktop app** if it's open (menu **LearnHarness → Quit**). The Mac and the phone must use the *same single copy* of the app, so that your chats and your graph are never written by two copies at once. The command refuses to start while the desktop app is open, and the desktop app refuses to open while phone access is on.
2. Open **Terminal** and go to the LearnHarness folder, then run:

   ```bash
   npm run pocket
   ```

   The first time (and again after each update of the app) it spends a few minutes building the app. After that it starts in seconds.
3. When it says **Phone access is ON**, it prints two links:
   - the **phone link**, `https://<your-mac>.<something>.ts.net/capture`;
   - a **link for this Mac**, `http://127.0.0.1:47616`.
4. Leave that Terminal window open. The Mac stays awake while it runs. Keep the Mac plugged in and the lid open (a closed laptop lid still puts it to sleep).

While phone access is on, **use the Mac link in your browser instead of the desktop app.** Same data and same sign-in as the desktop app. If you're not signed in to ChatGPT in the browser yet, do it once in **Settings**.

## Opening it on your phone

1. Make sure the Tailscale app on your phone is **on**.
2. Open the phone link in your phone's browser. Tip: use **Share → Add to Home Screen** to get an icon.
3. Type a question or topic in the box and tap **Save for tonight**, or **Save & start now** to begin a teaching session right away. The phone keyboard's microphone key dictates for you.

At the Mac, your saved items show on the home screen under **Tonight's questions**. Tap **Start session** to teach from one, **Done** when finished with it, or the bin to delete it. Starting a session marks the question done.

## What's on the phone

A bar at the bottom has three tabs. On a phone-sized screen the sidebar is hidden; use the back arrow at the top of a session to return home.

- **Home:** the capture box, **Tonight's questions**, **New teaching session**, **Explain my miss**, and **Continue** (your recent sessions, newest first).
- **Practice:** tap one or more organ systems (or none for everything), then **Start a 5-question round**. You get short A–E questions drawn from your own notes; tap an answer, then submit. A system's chip is greyed out until you have notes tagged with it.
- **Expert AI:** the questions waiting to be asked. It's only for looking: asking happens on the Mac, in Chrome.

Setting up your models is a Mac job, so the phone says so instead of opening settings.

## Turning it off

Click the Terminal window and press **Ctrl+C**. That switches off the phone link, stops the app, and lets the Mac sleep again. Now you can open the desktop app as usual.

## Is it safe?

- **Only your devices can reach it.** The app is shared with *Tailscale Serve*, which works only inside your tailnet. The command never uses *Funnel*, which would put it on the public internet, and it refuses to start if Funnel is already on. The app itself has no password, so the tailnet is the lock: **don't invite other people to your tailnet, and don't share devices that are signed in to it.**
- **Nothing is open on your home network either.** The app listens on the Mac itself only (`127.0.0.1`), never on the wider network.
- **Captures are text only.** There's no way to attach a photo or file, deliberately. The box reminds you: **no patient identifiers** — no names, hospital numbers or dates of birth. Write the clinical question, not the patient.
- **Your data stays on your Mac.** The phone is only a screen. Models still run on your ChatGPT Plus plan, with no extra cost, and Tailscale's free personal plan is enough.

## What stays on the Mac

Asking Expert AI (the Chrome extension), the Anki review panel, importing PDFs and SlideScribe notes, the knowledge-graph view, and Settings. Do those at the Mac.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The LearnHarness desktop app is open" | Quit the desktop app (LearnHarness → Quit) and run the command again. |
| "Phone access is already running" or "Port … is already in use" | It's on in another Terminal window. Use that one, or press Ctrl+C there first. If you're sure nothing is running, delete the file `pocket.lock` in the data folder (`~/Library/Application Support/LearnHarness/data`). |
| "Tailscale isn't installed" or "isn't signed in" | Redo step 1 on the Mac, and make sure the menu-bar icon says you're connected. |
| "Funnel is on" | Run `tailscale funnel reset` in Terminal, then run the command again. |
| Phone says it can't connect | Check the Tailscale app on the phone is on, the phone is signed in to the **same account**, and the Terminal window on the Mac is still running. |
| The desktop app says "Phone access is on" | Phone access is running. Stop it with Ctrl+C in its Terminal window, then open the app. |

Want the app on the Mac only, with no phone link? Run `npm run pocket -- --no-tailscale`.
