/**
 * Pocket mode's launcher (scripts/pocket.mjs) and its lock. Every process and
 * Tailscale call is a fake: nothing here starts a server, runs Tailscale,
 * touches network or sleep settings, or reads the owner's real data folder.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	BIND_HOST,
	DEFAULT_POCKET_PORT,
	PocketError,
	desktopUserDataDir,
	inspectServeConfig,
	parseArgs,
	phoneLink,
	serverEnv,
	startPocket,
} from "../scripts/pocket.mjs";

const require = createRequire(import.meta.url);
const lock = require("../electron/pocket-lock.cjs");

let tmp: string;
let userData: string;
let dataDir: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pocket-"));
	userData = path.join(tmp, "Library", "Application Support", "LearnHarness");
	dataDir = path.join(userData, "data");
	fs.mkdirSync(path.join(tmp, "repo", ".next", "standalone"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "repo", ".next", "standalone", "server.js"), "");
	fs.writeFileSync(path.join(tmp, "repo", ".next", "pocket-build.json"), JSON.stringify({ head: "abc" }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TAILSCALE_OK = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." } });

interface Calls { spawns: { cmd: string; args: string[]; env?: Record<string, string> }[]; tailscale: string[][]; logs: string[]; kills: string[]; built: number }

function fakeDeps(over: Record<string, unknown> = {}) {
	const calls: Calls = { spawns: [], tailscale: [], logs: [], kills: [], built: 0 };
	const deps = {
		platform: "darwin",
		homedir: tmp,
		env: { HOSTNAME: "0.0.0.0", LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "x".repeat(64), PATH: "/usr/bin" } as Record<string, string>,
		pid: process.pid,
		execPath: "/fake/node",
		rootDir: path.join(tmp, "repo"),
		pidAlive: (pid: number) => pid === process.pid,
		readlink: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); },
		portFree: async () => true,
		spawn: (cmd: string, args: string[], o: { env?: Record<string, string> }) => {
			calls.spawns.push({ cmd, args, env: o?.env });
			const child = new EventEmitter() as EventEmitter & { kill: (s: string) => void };
			child.kill = (s) => calls.kills.push(`${cmd}:${s}`);
			return child;
		},
		tailscale: async (args: string[]) => {
			calls.tailscale.push(args);
			if (args[0] === "status") return { code: 0, stdout: TAILSCALE_OK, stderr: "" };
			if (args[0] === "serve" && args[1] === "status") return { code: 0, stdout: "{}", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
		waitUntilUp: async () => {},
		gitHead: () => "abc",
		buildServer: async () => { calls.built++; },
		log: (line: string) => calls.logs.push(line),
		...over,
	};
	return { deps, calls };
}
const opts = (extra = {}) => ({ ...parseArgs([]), ...extra });
const refusal = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => e instanceof PocketError && re.test(e.message));

describe("pocket launcher: bind address", () => {
	it("binds 127.0.0.1 on the fixed port, whatever the inherited environment says", async () => {
		const { deps, calls } = fakeDeps();
		const pocket = await startPocket(opts(), deps);
		const server = calls.spawns.find((s) => s.cmd === "/fake/node")!;
		assert.equal(server.env!.HOSTNAME, "127.0.0.1", "never 0.0.0.0");
		assert.equal(BIND_HOST, "127.0.0.1");
		assert.equal(server.env!.PORT, String(DEFAULT_POCKET_PORT));
		assert.equal(server.env!.NODE_ENV, "production");
		assert.equal(server.env!.LH_DATA_DIR, dataDir);
		assert.equal(server.env!.LH_AUTH_FILE, path.join(userData, "auth.json"));
		assert.equal(server.env!.LH_DESKTOP_SERVER, undefined, "browser mode carries no desktop API lock");
		assert.equal(server.env!.LH_DESKTOP_API_SECRET, undefined);
		await pocket.stop();
	});

	it("has no way to choose a bind address", () => {
		assert.throws(() => parseArgs(["--host", "0.0.0.0"]), PocketError);
		assert.throws(() => parseArgs(["--hostname=0.0.0.0"]), PocketError);
		assert.equal(serverEnv({ HOSTNAME: "0.0.0.0" }, { port: 1, dataDir: "/d", authFile: "/a" }).HOSTNAME, "127.0.0.1");
	});

	it("parses --port and rejects nonsense", () => {
		assert.equal(parseArgs(["--port", "50000"]).port, 50000);
		assert.throws(() => parseArgs(["--port", "80"]), PocketError);
		assert.throws(() => parseArgs(["--port"]), PocketError);
	});

	it("shares the app only on the tailnet, with Serve (never Funnel), and prints the phone link", async () => {
		const { deps, calls } = fakeDeps();
		const pocket = await startPocket(opts(), deps);
		assert.deepEqual(calls.tailscale.at(-1), ["serve", "--bg", "--https=443", `http://127.0.0.1:${DEFAULT_POCKET_PORT}`]);
		assert.ok(!calls.tailscale.some((a) => a.includes("funnel")), "funnel is never called");
		assert.equal(pocket.link, "https://mac.tail1234.ts.net/capture");
		assert.ok(calls.logs.some((l) => l.includes("https://mac.tail1234.ts.net/capture")));
		assert.equal(phoneLink("a.b.ts.net."), "https://a.b.ts.net/capture");
		await pocket.stop();
	});

	it("keeps the Mac awake while running and undoes everything on stop", async () => {
		const { deps, calls } = fakeDeps();
		const pocket = await startPocket(opts(), deps);
		const awake = calls.spawns.find((s) => s.cmd === "caffeinate")!;
		assert.deepEqual(awake.args, ["-i", "-s", "-w", String(process.pid)]);
		assert.ok(fs.existsSync(lock.lockPath(dataDir)));
		await pocket.stop();
		assert.deepEqual(calls.tailscale.at(-1), ["serve", "--https=443", `http://127.0.0.1:${DEFAULT_POCKET_PORT}`, "off"]);
		assert.ok(calls.kills.includes("caffeinate:SIGTERM") && calls.kills.includes("/fake/node:SIGTERM"));
		assert.ok(!fs.existsSync(lock.lockPath(dataDir)), "lock released");
	});

	it("--no-tailscale runs browser mode on this Mac only", async () => {
		const { deps, calls } = fakeDeps();
		const pocket = await startPocket(opts({ tailscale: false }), deps);
		assert.equal(calls.tailscale.length, 0);
		assert.equal(pocket.link, null);
		await pocket.stop();
	});
});

describe("pocket launcher: refusals", () => {
	it("refuses while the desktop app is running", async () => {
		fs.mkdirSync(userData, { recursive: true });
		const { deps, calls } = fakeDeps({ readlink: () => `host-${process.pid}` });
		await refusal(startPocket(opts(), deps), /desktop app is open/);
		assert.equal(calls.spawns.length, 0, "nothing was started");
		assert.ok(!fs.existsSync(lock.lockPath(dataDir)));
	});

	it("goes ahead when the desktop app's lock is stale (its process is gone)", async () => {
		const { deps } = fakeDeps({ readlink: () => "host-999999", pidAlive: (pid: number) => pid === process.pid });
		await (await startPocket(opts(), deps)).stop();
	});

	it("refuses while another pocket server holds the data folder", async () => {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(lock.lockPath(dataDir), JSON.stringify({ pid: 4242, port: DEFAULT_POCKET_PORT }));
		const { deps, calls } = fakeDeps({ pidAlive: (pid: number) => pid === 4242 || pid === process.pid });
		await refusal(startPocket(opts(), deps), /already running \(process 4242\)/);
		assert.equal(calls.spawns.length, 0);
		assert.equal(lock.pocketRunning(dataDir, () => true).pid, 4242, "the other server's lock is untouched");
	});

	it("replaces a stale pocket lock", async () => {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(lock.lockPath(dataDir), JSON.stringify({ pid: 4242, port: 1 }));
		const { deps } = fakeDeps();
		const pocket = await startPocket(opts(), deps);
		assert.equal(lock.pocketRunning(dataDir)?.pid, process.pid);
		await pocket.stop();
	});

	it("refuses when the port is taken", async () => {
		const { deps, calls } = fakeDeps({ portFree: async () => false });
		await refusal(startPocket(opts(), deps), /already in use/);
		assert.equal(calls.spawns.length, 0);
	});

	it("refuses when Tailscale is missing, signed out, or Funnel is on", async () => {
		await refusal(startPocket(opts(), fakeDeps({ tailscale: async () => ({ code: "ENOENT", stdout: "", stderr: "" }) }).deps), /isn't installed/);
		await refusal(startPocket(opts(), fakeDeps({ tailscale: async () => ({ code: 1, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" }) }).deps), /isn't signed in/);
		const funnel = JSON.stringify({ AllowFunnel: { "mac.tail1234.ts.net:443": true } });
		const { deps, calls } = fakeDeps({
			tailscale: async (args: string[]) => ({ code: 0, stdout: args[0] === "status" ? TAILSCALE_OK : funnel, stderr: "" }),
		});
		await refusal(startPocket(opts(), deps), /Funnel is on/);
		assert.equal(calls.spawns.length, 0);
	});

	it("undoes the lock when the server never comes up", async () => {
		const { deps } = fakeDeps({ waitUntilUp: async () => { throw new PocketError("never answered"); } });
		await refusal(startPocket(opts(), deps), /never answered/);
		assert.ok(!fs.existsSync(lock.lockPath(dataDir)));
	});

	it("on a platform other than the Mac, asks for --data-dir", async () => {
		await refusal(startPocket(opts(), fakeDeps({ platform: "linux" }).deps), /--data-dir/);
	});
});

describe("pocket launcher: build and data folder", () => {
	it("builds when the app isn't built or the code changed, not otherwise", async () => {
		const up = fakeDeps();
		await (await startPocket(opts(), up.deps)).stop();
		assert.equal(up.calls.built, 0, "up to date → no build");
		const changed = fakeDeps({ gitHead: () => "def" });
		await (await startPocket(opts(), changed.deps)).stop();
		assert.equal(changed.calls.built, 1);
		assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "repo", ".next", "pocket-build.json"), "utf8")).head, "def");
	});

	it("uses the desktop app's data folder by default", () => {
		assert.equal(desktopUserDataDir("darwin", "/Users/x"), "/Users/x/Library/Application Support/LearnHarness");
		assert.equal(desktopUserDataDir("linux", "/home/x"), null);
	});
});

describe("Tailscale serve status", () => {
	const target = "http://127.0.0.1:47616";
	it("spots Funnel and a conflicting Serve, ignores our own", () => {
		assert.equal(inspectServeConfig("{}", "m.ts.net", target).funnel, false);
		assert.equal(inspectServeConfig('{"AllowFunnel":{"m.ts.net:443":true}}', "m.ts.net", target).funnel, true);
		assert.equal(inspectServeConfig('{"AllowFunnel":{"m.ts.net:443":false}}', "m.ts.net", target).funnel, false);
		const other = '{"Web":{"m.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}';
		assert.equal(inspectServeConfig(other, "m.ts.net", target).conflict, true);
		const ours = `{"Web":{"m.ts.net:443":{"Handlers":{"/":{"Proxy":"${target}"}}}}}`;
		assert.equal(inspectServeConfig(ours, "m.ts.net", target).conflict, false);
		assert.deepEqual(inspectServeConfig("not json", "m.ts.net", target), { funnel: false, conflict: false });
	});
});

describe("pocket lock", () => {
	it("is exclusive, releasable, and the desktop check reads Chromium's SingletonLock", () => {
		const a = lock.acquirePocketLock(dataDir, { pid: 10, port: 1 }, () => true);
		assert.equal(a.ok, true);
		const b = lock.acquirePocketLock(dataDir, { pid: 11, port: 1 }, () => true);
		assert.equal(b.ok, false);
		assert.equal(b.holder.pid, 10);
		a.release();
		assert.equal(lock.pocketRunning(dataDir, () => true), null);
		assert.equal(lock.desktopRunning(userData, () => true, () => "my-mac.local-777"), 777);
		assert.equal(lock.desktopRunning(userData, () => false, () => "my-mac.local-777"), null);
		assert.equal(lock.desktopRunning(userData, () => true, () => { throw new Error("none"); }), null);
	});

	it("the desktop shell checks the lock before starting its server", () => {
		const main = fs.readFileSync(path.join(import.meta.dirname, "..", "electron", "main.cjs"), "utf8");
		assert.ok(main.indexOf("pocketRunning(DATA_DIR())") > 0 && main.indexOf("pocketRunning(DATA_DIR())") < main.indexOf("starting server:"));
	});
});
