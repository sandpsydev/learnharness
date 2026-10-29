"use strict";

/**
 * Pocket mode's "one server per data folder" lock (Phase 8). Two LearnHarness
 * servers must never write the same data folder at once, and there are exactly
 * two ways to run one on the Mac: the desktop app, and the pocket launcher
 * (scripts/pocket.mjs). Each refuses to start while the other is running:
 *
 *   - the launcher refuses while the desktop app is up (desktopRunning: the
 *     app holds Chromium's SingletonLock in its user-data folder);
 *   - the desktop app refuses while the launcher is up (pocketRunning: the
 *     launcher holds <data folder>/pocket.lock, a file naming its process).
 *
 * A lock whose process has died is stale and is simply replaced. Plain CJS so
 * both the Electron main process and the launcher can load it.
 */

const fs = require("node:fs");
const path = require("node:path");

const LOCK_NAME = "pocket.lock";

const lockPath = (dataDir) => path.join(dataDir, LOCK_NAME);

/** True when a process with this id exists (EPERM = exists, not ours). */
function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

function readLock(dataDir) {
	try {
		const info = JSON.parse(fs.readFileSync(lockPath(dataDir), "utf8"));
		return Number.isInteger(info?.pid) ? info : null;
	} catch {
		return null;
	}
}

/** The live pocket server holding this data folder ({pid, port, startedAt}), or null. */
function pocketRunning(dataDir, alive = pidAlive) {
	const info = readLock(dataDir);
	return info && alive(info.pid) ? info : null;
}

/**
 * Take the lock. `{ok: true, release}` or `{ok: false, holder}` when a live
 * process already holds it. A dead holder's lock is removed and retaken.
 */
function acquirePocketLock(dataDir, info, alive = pidAlive) {
	const file = lockPath(dataDir);
	fs.mkdirSync(dataDir, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify(info), { flag: "wx", mode: 0o600 });
			return {
				ok: true,
				release() {
					// Only remove a lock that is still ours.
					if (readLock(dataDir)?.pid === info.pid) fs.rmSync(file, { force: true });
				},
			};
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			const holder = pocketRunning(dataDir, alive);
			if (holder) return { ok: false, holder };
			fs.rmSync(file, { force: true }); // stale (or unreadable): replace it
		}
	}
	return { ok: false, holder: readLock(dataDir) };
}

/**
 * The desktop app's process id when it is running, else null. Chromium (so
 * Electron) keeps a SingletonLock symlink named "<host>-<pid>" in the app's
 * user-data folder — the folder ABOVE the data folder — for as long as it runs.
 */
function desktopRunning(userDataDir, alive = pidAlive, readlink = fs.readlinkSync) {
	let target;
	try {
		target = readlink(path.join(userDataDir, "SingletonLock"));
	} catch {
		return null;
	}
	const pid = Number(/-(\d+)$/.exec(String(target))?.[1]);
	return alive(pid) ? pid : null;
}

module.exports = { LOCK_NAME, lockPath, pidAlive, pocketRunning, acquirePocketLock, desktopRunning };
