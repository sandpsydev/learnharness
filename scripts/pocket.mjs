/**
 * pocket.mjs — turn phone access on (Phase 8 "Pocket mode"; guide:
 * docs/pocket-mode.md). Run it with `npm run pocket`.
 *
 * What it does, in order:
 *   1. refuses to start while the desktop app (or another pocket server) is
 *      using the data folder — two servers must never write the same files;
 *   2. checks Tailscale is signed in and that nothing is exposing the app
 *      publicly (Funnel) — the tailnet is the security boundary, because
 *      browser mode has no login;
 *   3. starts the app in browser mode on 127.0.0.1 ONLY (never 0.0.0.0), on a
 *      fixed port, with the SAME data folder and keys as the desktop app;
 *   4. keeps the Mac awake while it runs (caffeinate);
 *   5. publishes it to the tailnet with `tailscale serve` (HTTPS, tailnet-only)
 *      and prints the phone link.
 * Ctrl+C undoes all of it: serve off, server stopped, Mac free to sleep, lock
 * released. Tailscale Serve only — this file never calls `tailscale funnel`.
 *
 * Everything outside the pure logic (processes, the network, the data folder)
 * comes in through `deps`, so tests drive the whole flow with fakes.
 */
import { execFile, execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { acquirePocketLock, desktopRunning, pidAlive } = require("../electron/pocket-lock.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fixed so the phone link never changes. Next to the extension API's 47615. */
export const DEFAULT_POCKET_PORT = 47616;
/** The only address the server ever binds. Not configurable, on purpose. */
export const BIND_HOST = "127.0.0.1";
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** A problem the owner can fix; the message is shown as-is. */
export class PocketError extends Error {}

// ─── pure helpers ──────────────────────────────────────────────────────────

/** The desktop app's user-data folder (Electron's userData for app name "LearnHarness"). */
export function desktopUserDataDir(platform, homedir) {
	if (platform !== "darwin") return null;
	return path.join(homedir, "Library", "Application Support", "LearnHarness");
}

export function parseArgs(argv) {
	const opts = { port: DEFAULT_POCKET_PORT, dataDir: null, tailscale: true, rebuild: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--no-tailscale") opts.tailscale = false;
		else if (arg === "--rebuild") opts.rebuild = true;
		else if (arg === "--port" || arg === "--data-dir") {
			const value = argv[++i];
			if (!value) throw new PocketError(`${arg} needs a value.`);
			if (arg === "--port") {
				const port = Number(value);
				if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new PocketError("--port must be a number from 1024 to 65535.");
				opts.port = port;
			} else opts.dataDir = path.resolve(value);
		} else throw new PocketError(`Unknown option: ${arg}. Run with --help to see the options.`);
	}
	return opts;
}

/** The environment the server runs with. Bind address and port are fixed here. */
export function serverEnv(baseEnv, { port, dataDir, authFile }) {
	const env = { ...baseEnv };
	// The desktop-only API lock stays a desktop thing; browser mode never carries it.
	delete env.LH_DESKTOP_SERVER;
	delete env.LH_DESKTOP_API_SECRET;
	delete env.LH_DEV_URL;
	return {
		...env,
		NODE_ENV: "production",
		HOSTNAME: BIND_HOST, // the server defaults to 0.0.0.0 — never
		PORT: String(port),
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
	};
}

export const serveTarget = (port) => `http://${BIND_HOST}:${port}`;

/**
 * Read `tailscale serve status --json`. `funnel`: anything is open to the public
 * internet. `conflict`: HTTPS 443 on this machine already serves something else.
 */
export function inspectServeConfig(json, dnsName, target) {
	let config;
	try {
		config = JSON.parse(json || "{}");
	} catch {
		return { funnel: false, conflict: false };
	}
	const funnel = Object.values(config?.AllowFunnel ?? {}).some(Boolean);
	const handlers = config?.Web?.[`${dnsName}:443`]?.Handlers ?? {};
	const conflict = Object.values(handlers).some((h) => h?.Proxy !== target);
	return { funnel, conflict };
}

/** The https link for the phone, from a Tailscale DNS name ("mac.tail1234.ts.net."). */
export const phoneLink = (dnsName, pathName = "/capture") => `https://${dnsName.replace(/\.$/, "")}${pathName}`;

// ─── the launcher ──────────────────────────────────────────────────────────

/**
 * Start phone access. Resolves to `{ stop }` once everything is up; throws a
 * PocketError (nothing left running) when it cannot start.
 */
export async function startPocket(opts, deps) {
	const { log } = deps;
	const userData = opts.dataDir ? path.dirname(opts.dataDir) : desktopUserDataDir(deps.platform, deps.homedir);
	if (!userData) throw new PocketError("Phone access is set up for the Mac. On another system, pass --data-dir <folder>.");
	const dataDir = opts.dataDir ?? path.join(userData, "data");
	const authFile = path.join(userData, "auth.json");

	// 1. One server per data folder.
	const desktopPid = desktopRunning(userData, deps.pidAlive, deps.readlink);
	if (desktopPid) {
		throw new PocketError("The LearnHarness desktop app is open. Quit it (LearnHarness menu → Quit), then run this again. While phone access is on, the Mac uses the link below instead of the app.");
	}
	if (!(await deps.portFree(opts.port))) {
		throw new PocketError(`Port ${opts.port} is already in use — phone access may already be running in another Terminal window.`);
	}

	// 2. Tailscale, before anything is started.
	let dnsName = null;
	if (opts.tailscale) {
		const status = await deps.tailscale(["status", "--json"]);
		if (status.code === "ENOENT") {
			throw new PocketError("Tailscale isn't installed on this Mac. Follow docs/pocket-mode.md, step 1 — or run with --no-tailscale to use the app in your browser on this Mac only.");
		}
		let parsed = null;
		try { parsed = JSON.parse(status.stdout); } catch { /* handled below */ }
		if (parsed?.BackendState !== "Running" || !parsed?.Self?.DNSName) {
			throw new PocketError("Tailscale isn't signed in and running. Open the Tailscale app on the Mac, sign in, then run this again (docs/pocket-mode.md, step 2).");
		}
		dnsName = String(parsed.Self.DNSName).replace(/\.$/, "");
		const serve = await deps.tailscale(["serve", "status", "--json"]);
		const found = inspectServeConfig(serve.stdout, dnsName, serveTarget(opts.port));
		if (found.funnel) {
			throw new PocketError("Tailscale Funnel is on for this Mac, which would put the app on the public internet. Turn it off with `tailscale funnel reset`, then run this again.");
		}
		if (found.conflict) {
			throw new PocketError("Tailscale Serve is already sharing something else on this Mac's HTTPS address. Turn that off first (`tailscale serve reset`), then run this again.");
		}
	}

	// 3. The built server (builds once; rebuilds after the app is updated).
	const entry = path.join(deps.rootDir, ".next", "standalone", "server.js");
	const stampFile = path.join(deps.rootDir, ".next", "pocket-build.json");
	const head = deps.gitHead();
	const stamped = (() => { try { return JSON.parse(fs.readFileSync(stampFile, "utf8")).head ?? null; } catch { return null; } })();
	if (opts.rebuild || !fs.existsSync(entry) || (head && stamped !== head)) {
		log("Building the app for phone access (a few minutes, first time and after each update)…");
		await deps.buildServer();
		if (head) {
			fs.mkdirSync(path.dirname(stampFile), { recursive: true });
			fs.writeFileSync(stampFile, JSON.stringify({ head, builtAt: new Date().toISOString() }));
		}
	}

	// 4. Take the data folder, then start the server.
	fs.mkdirSync(dataDir, { recursive: true });
	const lock = acquirePocketLock(dataDir, { pid: deps.pid, port: opts.port, startedAt: new Date().toISOString() }, deps.pidAlive);
	if (!lock.ok) {
		throw new PocketError(`Phone access is already running (process ${lock.holder?.pid ?? "unknown"}). Stop it first, or use its link.`);
	}
	const cleanups = [() => lock.release()];
	let stopped = false;
	const stop = () => {
		if (stopped) return Promise.resolve();
		stopped = true;
		return (async () => {
			for (const undo of cleanups.reverse()) {
				try { await undo(); } catch { /* best effort — keep undoing the rest */ }
			}
		})();
	};

	try {
		const server = deps.spawn(deps.execPath, [entry], {
			cwd: path.dirname(entry),
			env: serverEnv(deps.env, { port: opts.port, dataDir, authFile }),
			stdio: "inherit",
		});
		let exited = false;
		server.on("exit", () => { exited = true; });
		cleanups.push(() => { if (!exited) server.kill("SIGTERM"); });
		await deps.waitUntilUp(`http://${BIND_HOST}:${opts.port}/`, () => exited);

		// 5. Keep the Mac awake for as long as this runs.
		if (deps.platform === "darwin") {
			const awake = deps.spawn("caffeinate", ["-i", "-s", "-w", String(deps.pid)], { stdio: "ignore" });
			awake.on("error", () => log("Couldn't keep the Mac awake automatically — leave it plugged in and awake."));
			cleanups.push(() => awake.kill("SIGTERM"));
		}

		// 6. Share it on the tailnet only.
		let link = null;
		if (opts.tailscale) {
			const target = serveTarget(opts.port);
			const on = await deps.tailscale(["serve", "--bg", "--https=443", target]);
			if (on.code !== 0) throw new PocketError(`Tailscale Serve couldn't start: ${(on.stderr || on.stdout).trim() || "unknown error"}`);
			cleanups.push(() => deps.tailscale(["serve", "--https=443", target, "off"]));
			link = phoneLink(dnsName);
		}
		const macLink = `http://${BIND_HOST}:${opts.port}`;
		log("");
		log("Phone access is ON.");
		if (link) log(`  Phone link:  ${link}`);
		log(`  On this Mac: ${macLink}   (use this instead of the desktop app while it's on)`);
		log("  Press Ctrl+C here to turn it off.");
		return { stop, link, macLink, port: opts.port, dataDir, onExit: (fn) => server.on("exit", fn) };
	} catch (err) {
		await stop();
		throw err;
	}
}

// ─── real dependencies ─────────────────────────────────────────────────────

function portFree(port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, BIND_HOST, () => probe.close(() => resolve(true)));
	});
}

function waitUntilUp(url, hasExited, tries = 300) {
	return new Promise((resolve, reject) => {
		const attempt = (left) => {
			if (hasExited()) return reject(new PocketError("The app stopped while starting. Scroll up for its error message."));
			const req = http.get(url, (res) => { res.resume(); resolve(); });
			req.on("error", () => (left <= 0 ? reject(new PocketError(`The app never answered on ${url}.`)) : setTimeout(() => attempt(left - 1), 200)));
		};
		attempt(tries);
	});
}

function runOnce(command, args) {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** Run the tailscale CLI, from the PATH or the Mac app's bundled copy. */
async function tailscale(args) {
	let last = { code: "ENOENT", stdout: "", stderr: "" };
	for (const bin of TAILSCALE_BINARIES) {
		last = await runOnce(bin, args);
		if (last.code !== "ENOENT") return last;
	}
	return last;
}

function runInherit(command, args) {
	return new Promise((resolve, reject) => {
		const child = nodeSpawn(command, args, { cwd: ROOT, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new PocketError(`${command} ${args[0] ?? ""} failed (exit ${code}).`))));
	});
}

export function realDeps() {
	return {
		platform: process.platform,
		homedir: os.homedir(),
		env: process.env,
		pid: process.pid,
		execPath: process.execPath,
		rootDir: ROOT,
		pidAlive,
		readlink: fs.readlinkSync,
		portFree,
		spawn: nodeSpawn,
		tailscale,
		waitUntilUp,
		gitHead: () => {
			try {
				return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || null;
			} catch { return null; }
		},
		buildServer: async () => {
			await runInherit(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"]);
			// The build can drop a copy of the repo's own data/ folder into the output;
			// build-server.mjs refuses to continue while it's there. Drop the copy
			// (it lives under .next/standalone — the repo's data/ is not touched).
			fs.rmSync(path.join(ROOT, ".next", "standalone", "data"), { recursive: true, force: true });
			await runInherit(process.execPath, [path.join(ROOT, "scripts", "build-server.mjs")]);
		},
		log: (line) => console.log(line),
	};
}

const HELP = `Turn phone access on.

  npm run pocket [-- options]

Options:
  --no-tailscale    run the app in browser mode on this Mac only (no phone link)
  --port <number>   the local port (default ${DEFAULT_POCKET_PORT})
  --data-dir <dir>  use a different data folder (default: the desktop app's)
  --rebuild         rebuild the app even if it looks up to date
`;

async function main() {
	try {
		const opts = parseArgs(process.argv.slice(2));
		if (opts.help) return console.log(HELP);
		const pocket = await startPocket(opts, realDeps());
		let closing = false;
		const shutdown = async (code) => {
			if (closing) return;
			closing = true;
			console.log("\nTurning phone access off…");
			await pocket.stop();
			process.exit(code);
		};
		process.on("SIGINT", () => void shutdown(0));
		process.on("SIGTERM", () => void shutdown(0));
		pocket.onExit(() => void shutdown(1));
	} catch (err) {
		console.error(err instanceof PocketError ? `\n${err.message}\n` : err);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
