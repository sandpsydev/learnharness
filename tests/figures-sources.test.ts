/**
 * Real figures — the guarded fetcher, the session cache and the source parsers,
 * all against local fixtures (tests/fixtures/figures). No live fetching.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PNG } from "./figure-fixtures.ts";
import { figureImageAllowed, figureSourceById, figureSourceForPage } from "../src/core/figures.ts";
import { findCachedFigure, figureKey, readCachedFigure, removeChatFigures, writeCachedFigure } from "../src/agent/figures/cache.ts";
import { IMAGE_MAX_BYTES, fetchFigureImage, fetchFigureText } from "../src/agent/figures/fetch.ts";
import {
	parseCommonsResults,
	parseEuropePmcFigures,
	parseEuropePmcResults,
	parsePageImages,
	pageCandidateFromHit,
	radiopaediaSearchLink,
	readFigurePage,
	searchCommons,
} from "../src/agent/figures/sources.ts";

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "figures", name), "utf-8");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

type Route = Response | ((url: string, init?: RequestInit) => Response | Promise<Response>);
/** A fake network: exact-URL routes; anything unrouted is a failure the test should not reach. */
function fakeFetch(routes: Record<string, Route>, log: string[] = []): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		log.push(url);
		const route = routes[url];
		if (!route) throw new Error(`unrouted fetch: ${url}`);
		return typeof route === "function" ? route(url, init) : route.clone();
	}) as typeof fetch;
}

const ok = (body: BodyInit, type: string): Response => new Response(body, { status: 200, headers: { "content-type": type } });
const allowAll = (): boolean => true;

describe("guarded fetch", () => {
	it("reads a picture by its own bytes, not by the header the server sent", async () => {
		const f = fakeFetch({ "https://upload.wikimedia.org/a.png": ok(PNG, "text/html"), "https://upload.wikimedia.org/b.png": ok("<html>not an image</html>", "image/png") });
		const good = await fetchFigureImage("https://upload.wikimedia.org/a.png", { allow: allowAll, fetchImpl: f });
		assert.ok(good.ok);
		assert.equal(good.ok && good.mime, "image/png");
		const bad = await fetchFigureImage("https://upload.wikimedia.org/b.png", { allow: allowAll, fetchImpl: f });
		assert.ok(!bad.ok && bad.reason === "not-an-image");
	});

	it("accepts jpeg too", async () => {
		const f = fakeFetch({ "https://upload.wikimedia.org/a.jpg": ok(JPEG, "image/jpeg") });
		const got = await fetchFigureImage("https://upload.wikimedia.org/a.jpg", { allow: allowAll, fetchImpl: f });
		assert.equal(got.ok && got.mime, "image/jpeg");
	});

	it("refuses anything that is not plain https, and never calls the network for it", async () => {
		const log: string[] = [];
		const f = fakeFetch({}, log);
		for (const url of ["http://upload.wikimedia.org/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA", "https://user:pw@upload.wikimedia.org/a.png", "ftp://x/y"]) {
			const got = await fetchFigureImage(url, { allow: allowAll, fetchImpl: f });
			assert.ok(!got.ok && got.reason === "bad-url", url);
		}
		assert.deepEqual(log, []);
	});

	it("checks the allow rule on every redirect hop, so a listed site cannot bounce us elsewhere", async () => {
		const log: string[] = [];
		const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
		const f = fakeFetch(
			{
				"https://upload.wikimedia.org/start.png": redirect("https://upload.wikimedia.org/final.png"),
				"https://upload.wikimedia.org/final.png": ok(PNG, "image/png"),
				"https://upload.wikimedia.org/bounce.png": redirect("https://evil.example/steal.png"),
				"https://upload.wikimedia.org/downgrade.png": redirect("http://upload.wikimedia.org/plain.png"),
			},
			log,
		);
		const allow = (u: URL) => u.hostname === "upload.wikimedia.org";
		const followed = await fetchFigureImage("https://upload.wikimedia.org/start.png", { allow, fetchImpl: f });
		assert.ok(followed.ok && followed.finalUrl === "https://upload.wikimedia.org/final.png");
		const bounced = await fetchFigureImage("https://upload.wikimedia.org/bounce.png", { allow, fetchImpl: f });
		assert.ok(!bounced.ok && bounced.reason === "disallowed");
		assert.ok(!log.includes("https://evil.example/steal.png"), "the off-list host was never contacted");
		const downgraded = await fetchFigureImage("https://upload.wikimedia.org/downgrade.png", { allow, fetchImpl: f });
		assert.ok(!downgraded.ok && downgraded.reason === "bad-url");
	});

	it("stops reading at the byte limit, whatever Content-Length claims", async () => {
		const big = new Uint8Array(IMAGE_MAX_BYTES + 10).fill(1);
		big.set(PNG);
		const f = fakeFetch({
			"https://upload.wikimedia.org/huge.png": ok(big, "image/png"),
			"https://upload.wikimedia.org/declared.png": new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(IMAGE_MAX_BYTES + 1) } }),
		});
		const huge = await fetchFigureImage("https://upload.wikimedia.org/huge.png", { allow: allowAll, fetchImpl: f });
		assert.ok(!huge.ok && huge.reason === "too-large");
		const declared = await fetchFigureImage("https://upload.wikimedia.org/declared.png", { allow: allowAll, fetchImpl: f });
		assert.ok(!declared.ok && declared.reason === "too-large");
	});

	it("reports a site that refuses automated reads as blocked, not as an error to retry", async () => {
		const f = fakeFetch({ "https://radiopaedia.org/cases/x": new Response("", { status: 406 }), "https://radiopaedia.org/cases/y": new Response("", { status: 403 }), "https://radiopaedia.org/cases/z": new Response("", { status: 404 }) });
		for (const [url, reason] of [["x", "blocked"], ["y", "blocked"], ["z", "http"]] as const) {
			const got = await fetchFigureText(`https://radiopaedia.org/cases/${url}`, { allow: allowAll, fetchImpl: f });
			assert.ok(!got.ok && got.reason === reason, url);
		}
	});

	it("sends no cookies or credentials and an honest user agent", async () => {
		let seen: RequestInit | undefined;
		const f = fakeFetch({ "https://upload.wikimedia.org/a.png": (_u, init) => ((seen = init), ok(PNG, "image/png")) });
		await fetchFigureImage("https://upload.wikimedia.org/a.png", { allow: allowAll, fetchImpl: f });
		assert.equal(seen?.credentials, "omit");
		assert.equal(seen?.redirect, "manual");
		const headers = new Headers(seen?.headers);
		assert.match(headers.get("user-agent") ?? "", /^LearnHarness\//);
		assert.equal(headers.get("cookie"), null);
		assert.equal(headers.get("authorization"), null);
	});

	it("times out instead of hanging", async () => {
		const f = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
		const got = await fetchFigureText("https://commons.wikimedia.org/x", { allow: allowAll, fetchImpl: f, signal: AbortSignal.timeout(20) });
		assert.ok(!got.ok);
	});
});

describe("session cache", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-figures-"));
	after(() => fs.rmSync(root, { recursive: true, force: true }));
	const chat = "chat_abc123_def456";

	it("writes once, finds it by key whatever its type, and serves the same bytes", () => {
		const key = figureKey("image", "https://upload.wikimedia.org/a.png");
		assert.equal(findCachedFigure(root, chat, key), null);
		const written = writeCachedFigure(root, chat, key, "image/png", PNG);
		assert.equal(written.file, `${key}.png`);
		const found = findCachedFigure(root, chat, key);
		assert.equal(found?.mime, "image/png");
		assert.deepEqual([...found!.bytes], [...PNG]);
		assert.equal(readCachedFigure(root, chat, written.file)?.mime, "image/png");
		assert.equal(fs.readdirSync(path.join(root, chat)).filter((f) => f.endsWith(".tmp")).length, 0, "no half-written files left");
	});

	it("only ever names a cache key under a chat folder", () => {
		assert.equal(readCachedFigure(root, "../chat_abc123_def456", "0123456789abcdef01234567.png"), null);
		assert.equal(readCachedFigure(root, chat, "../../etc/passwd"), null);
		assert.equal(readCachedFigure(root, chat, "0123456789abcdef01234567.svg"), null);
		assert.throws(() => writeCachedFigure(root, "not-a-chat", figureKey("x"), "image/png", PNG));
	});

	it("is removed with the session", () => {
		removeChatFigures(root, chat);
		assert.equal(fs.existsSync(path.join(root, chat)), false);
	});
});

describe("Wikimedia Commons", () => {
	it("lists picture files with their own licence, author and description; skips svg, off-list hosts", () => {
		const found = parseCommonsResults(JSON.parse(fixture("commons-search.json")));
		assert.deepEqual(found.map((c) => c.title), ["Apical pneumothorax shown on CT and chest X-ray.png", "Pneumothorax unfree.jpg"]);
		const [first, second] = found;
		assert.equal(first!.licence?.label, "CC BY-SA 4.0");
		assert.equal(first!.author, "Jane Roe");
		assert.equal(first!.description, "Apical pneumothorax on CT and chest X-ray & a left first rib fracture");
		assert.equal(first!.pageUrl, "https://commons.wikimedia.org/wiki/File:Apical_pneumothorax_shown_on_CT_and_chest_X-ray.png");
		assert.ok(figureImageAllowed(figureSourceById("commons")!, first!.imageUrl!));
		assert.equal(second!.licence, null, "fair use is not a reusable licence: link only");
	});

	it("searches through the guarded fetch", async () => {
		const log: string[] = [];
		const f = fakeFetch({}, log);
		const routed = ((url: string, init?: RequestInit) => {
			log.push(url);
			assert.ok(url.startsWith("https://commons.wikimedia.org/w/api.php?"));
			assert.equal(new URL(url).searchParams.get("gsrsearch"), "pneumothorax chest x-ray");
			return Promise.resolve(ok(fixture("commons-search.json"), "application/json"));
		}) as unknown as typeof fetch;
		void f;
		const out = await searchCommons("pneumothorax chest x-ray", { fetchImpl: routed });
		assert.ok(out.ok && out.candidates.length === 2);
		const failed = await searchCommons("x", { fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
		assert.ok(!failed.ok && failed.reason === "blocked");
	});
});

describe("Europe PMC", () => {
	it("keeps open-access articles that have a PMC id, with the licence the record states", () => {
		const found = parseEuropePmcResults(JSON.parse(fixture("europepmc-search.json")));
		assert.deepEqual(found.map((c) => c.pageUrl), ["https://europepmc.org/article/PMC/13676449", "https://europepmc.org/article/PMC/13726339", "https://europepmc.org/article/PMC/13000001"]);
		assert.deepEqual(found.map((c) => c.licence?.label ?? null), ["CC BY", "CC BY-NC-ND", null]);
		assert.equal(found[0]!.kind, "page");
	});

	it("lists an article's figures with captions, and refuses unsafe file names", () => {
		const figs = parseEuropePmcFigures(fixture("europepmc-fulltext.xml"), "PMC13676449", "Spontaneous Pneumothorax", { label: "CC BY" });
		assert.equal(figs.length, 2);
		assert.equal(figs[0]!.imageUrl, "https://europepmc.org/articles/PMC13676449/bin/cureus-0018-f1.jpg");
		assert.equal(figs[0]!.description, "Chest radiograph showing a left apical pneumothorax (arrow).");
		assert.equal(figs[0]!.title, "Spontaneous Pneumothorax — Figure 1");
		assert.ok(figureImageAllowed(figureSourceById("europepmc")!, figs[0]!.imageUrl!));
	});
});

describe("atlas and case pages", () => {
	it("reads the licence the page states and lists its allowed pictures only", () => {
		const source = figureSourceById("dermnet")!;
		const page = parsePageImages(fixture("atlas-page.html"), "https://dermnetnz.org/topics/psoriasis", source);
		assert.equal(page.title, "Plaque psoriasis");
		assert.equal(page.licence?.label, "CC BY-NC-ND 3.0");
		assert.deepEqual(
			page.images.map((i) => i.imageUrl),
			["https://dermnetnz.org/assets/Uploads/psoriasis-plaque.jpg", "https://dermnetnz.org/assets/Uploads/psoriasis-elbow.jpg"],
			"og:image first, then figures; logo, other hosts and thumbnails dropped",
		);
		assert.equal(page.images[1]!.description, "Silvery scale on an erythematous plaque");
		assert.ok(page.images.every((i) => i.licence?.label === "CC BY-NC-ND 3.0"));
	});

	it("a page that states no licence yields pictures with none: link only", () => {
		const page = parsePageImages(fixture("atlas-page-nolicence.html"), "https://librepathology.org/wiki/Pemphigus", figureSourceById("librepathology")!);
		assert.equal(page.licence, null);
		assert.ok(page.images.length >= 1 && page.images.every((i) => i.licence === null));
	});

	it("never opens a journal or PathologyOutlines page", async () => {
		const log: string[] = [];
		const f = fakeFetch({}, log);
		for (const url of ["https://www.nejm.org/doi/full/10.1056/NEJMicm1", "https://www.pathologyoutlines.com/topic/x.html"]) {
			const out = await readFigurePage(url, { fetchImpl: f });
			assert.ok(!out.ok && out.reason === "disallowed", url);
		}
		const off = await readFigurePage("https://example.com/", { fetchImpl: f });
		assert.ok(!off.ok && off.reason === "disallowed");
		assert.deepEqual(log, []);
	});

	it("a blocked case page (Radiopaedia answers 406 to automated reads) falls back to a link", async () => {
		const f = fakeFetch({ "https://radiopaedia.org/cases/pneumothorax": new Response("", { status: 406 }) });
		const out = await readFigurePage("https://radiopaedia.org/cases/pneumothorax", { fetchImpl: f });
		assert.ok(!out.ok && out.reason === "blocked");
	});

	it("turns a search hit into a page candidate only for an allowed site", () => {
		const hit = { title: "Pneumothorax | Radiology Reference Article", url: "https://radiopaedia.org/articles/pneumothorax#section", snippet: "A <b>pneumothorax</b> is…" };
		const c = pageCandidateFromHit(hit, "radiopaedia");
		assert.equal(c?.pageUrl, "https://radiopaedia.org/articles/pneumothorax");
		assert.equal(c?.description, "A pneumothorax is…");
		assert.equal(pageCandidateFromHit(hit, "dermnet"), null, "wrong source asked for");
		assert.equal(pageCandidateFromHit({ ...hit, url: "https://example.com/x" }), null);
		assert.equal(pageCandidateFromHit({ ...hit, url: "http://radiopaedia.org/x" }), null);
		assert.equal(figureSourceForPage(radiopaediaSearchLink("tension pneumothorax").pageUrl!)?.id, "radiopaedia");
	});
});
