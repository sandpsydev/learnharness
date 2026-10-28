/**
 * The local embedder (agent/library/local-embedder.ts) WITHOUT the weights:
 * the download is exercised through an injected fetch with tiny stand-in
 * files, the model through a fake onnxruntime + tokenizer. A live test with
 * the real model runs only when LH_LIVE_EMBED_DIR points at a downloaded
 * model directory (skipped in CI — tests never download model weights).
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	createLocalEmbedder,
	EMBEDDING_MODEL,
	ensureModelFiles,
	modelFilesPresent,
	truncateIds,
	type OrtLike,
} from "../src/agent/library/local-embedder.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-embedder-"));
}

/** Tiny stand-ins with the manifest's names (real sizes/hashes can't match). */
function fakeManifest() {
	const bodies = EMBEDDING_MODEL.files.map((f) => ({ path: f.path, body: Buffer.from(`stand-in for ${f.path}`) }));
	return bodies.map((b) => ({ path: b.path, bytes: b.body.byteLength, sha256: crypto.createHash("sha256").update(b.body).digest("hex"), body: b.body }));
}

describe("model manifest", () => {
	it("pins an exact revision, a license, and a hash for every file", () => {
		assert.match(EMBEDDING_MODEL.revision, /^[0-9a-f]{40}$/);
		assert.equal(EMBEDDING_MODEL.license, "MIT");
		assert.equal(EMBEDDING_MODEL.dim, 384);
		for (const f of EMBEDDING_MODEL.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
	});

	it("modelFilesPresent is false for an empty directory", () => {
		assert.equal(modelFilesPresent(tmp()), false);
	});
});

describe("native runtime payload", () => {
	it("onnxruntime-node loads on this platform (the binding is installed, no weights needed)", async () => {
		const ort = await import("onnxruntime-node");
		const t = new ort.Tensor("float32", new Float32Array(4), [2, 2]);
		assert.deepEqual([...t.dims], [2, 2]);
	});

	it("the Next build keeps it external and traces this platform's binding", async () => {
		const { default: nextConfig } = await import("../next.config.ts");
		assert.ok(nextConfig.serverExternalPackages?.includes("onnxruntime-node"));
		const includes = nextConfig.outputFileTracingIncludes!["*"]!;
		assert.ok(includes.includes(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/**/*`));
		assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", "node_modules", "onnxruntime-node", "bin", "napi-v6", process.platform, process.arch)));
	});
});

describe("ensureModelFiles", () => {
	it("downloads missing files from the pinned revision, verifies the hash, then goes quiet", async () => {
		const dir = tmp();
		const files = fakeManifest();
		const urls: string[] = [];
		const fetchImpl = (async (url: string) => {
			urls.push(url);
			const hit = files.find((f) => url.endsWith(`/${f.path}`))!;
			return new Response(hit.body);
		}) as unknown as typeof fetch;
		const status: string[] = [];
		await ensureModelFiles(dir, fetchImpl, (m) => status.push(m), files);
		assert.equal(urls.length, files.length);
		assert.ok(urls.every((u) => u.startsWith(`https://huggingface.co/${EMBEDDING_MODEL.repo}/resolve/${EMBEDDING_MODEL.revision}/`)));
		assert.ok(status.some((s) => /Downloading the search model/.test(s)));
		for (const f of files) assert.deepEqual(fs.readFileSync(path.join(dir, f.path)), f.body);
		// Second call: everything is on disk — no network at all.
		await ensureModelFiles(dir, (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch, undefined, files);
	});

	it("rejects a file whose hash is wrong and leaves nothing behind", async () => {
		const dir = tmp();
		const files = fakeManifest();
		const fetchImpl = (async () => new Response(Buffer.from("tampered bytes!!"))) as unknown as typeof fetch;
		await assert.rejects(() => ensureModelFiles(dir, fetchImpl, undefined, files), /integrity check/);
		assert.equal(fs.existsSync(path.join(dir, files[0]!.path)), false);
	});

	it("says 'offline' plainly when the network is unreachable", async () => {
		const dir = tmp();
		const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
		await assert.rejects(() => ensureModelFiles(dir, fetchImpl, undefined, fakeManifest()), /are you offline\?/);
	});

	it("reports an HTTP failure", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
		await assert.rejects(() => ensureModelFiles(tmp(), fetchImpl, undefined, fakeManifest()), /HTTP 503/);
	});
});

describe("embedding with a fake runtime", () => {
	/** Fake onnxruntime: hidden state = [row, token] encoded so CLS pooling is checkable. */
	function fakeOrt(seen: { dims: number[][]; masks: bigint[][] }): OrtLike {
		const dim = 4;
		return {
			Tensor: class {
				constructor(public type: string, public data: BigInt64Array, public dims: number[]) {}
			} as never,
			InferenceSession: {
				async create() {
					return {
						inputNames: ["input_ids", "attention_mask", "token_type_ids"],
						outputNames: ["last_hidden_state"],
						async run(feeds: Record<string, unknown>) {
							const ids = feeds.input_ids as { data: BigInt64Array; dims: number[] };
							const mask = feeds.attention_mask as { data: BigInt64Array };
							seen.dims.push(ids.dims);
							seen.masks.push([...mask.data]);
							const [batch, seq] = ids.dims as [number, number];
							const data = new Float32Array(batch * seq * dim);
							for (let r = 0; r < batch; r++) {
								// CLS vector of row r points along axis (first token id) % dim, scaled by 5.
								data[r * seq * dim + Number(ids.data[r * seq]) % dim] = 5;
								// Non-CLS tokens carry a decoy that pooling must ignore.
								for (let t = 1; t < seq; t++) data[(r * seq + t) * dim] = 99;
							}
							return { last_hidden_state: { data, dims: [batch, seq, dim] } };
						},
					};
				},
			},
		};
	}
	const tokenizer = { encode: (t: string) => ({ ids: [101 + (t.length % 3), ...Array.from({ length: t.split(" ").length }, () => 7), 102] }) };

	async function ready(seen: { dims: number[][]; masks: bigint[][] }) {
		const dir = tmp();
		const files = fakeManifest();
		for (const f of files) {
			fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
			fs.writeFileSync(path.join(dir, f.path), f.body);
		}
		return createLocalEmbedder({
			dir,
			files,
			loadRuntime: async () => fakeOrt(seen),
			loadTokenizer: async () => tokenizer,
			fetch: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch,
		});
	}

	it("CLS-pools, normalises to unit length, pads a batch, and masks the padding", async () => {
		const seen = { dims: [] as number[][], masks: [] as bigint[][] };
		const embedder = await ready(seen);
		const [a, b] = await embedder.embedPassages(["one two", "one two three four five"]);
		assert.equal(a!.length, 4);
		for (const v of [a!, b!]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6, "unit length");
		assert.ok(a!.some((x) => x > 0.99), "pooled from the CLS row, not the decoy tokens");
		assert.deepEqual(seen.dims[0], [2, 7], "one batch, padded to the longest row (5 words + CLS + SEP)");
		const row0 = seen.masks[0]!.slice(0, 7);
		assert.deepEqual(row0, [1n, 1n, 1n, 1n, 0n, 0n, 0n], "the shorter row's padding is masked out");
	});

	it("embeds in batches of 8 and prefixes queries only", async () => {
		const seen = { dims: [] as number[][], masks: [] as bigint[][] };
		const embedder = await ready(seen);
		const texts = Array.from({ length: 20 }, (_, i) => `passage ${i}`);
		assert.equal((await embedder.embedPassages(texts)).length, 20);
		assert.deepEqual(seen.dims.map((d) => d[0]), [8, 8, 4]);
		const q = await embedder.embedQuery("what blocks NKCC2?");
		assert.equal(q.length, 4);
	});

	it("a failed load can be retried (the failure is not cached)", async () => {
		const dir = tmp();
		let attempts = 0;
		const embedder = createLocalEmbedder({
			dir,
			files: fakeManifest(),
			fetch: (async () => { attempts++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
		});
		await assert.rejects(() => embedder.ready(), /offline/);
		await assert.rejects(() => embedder.ready(), /offline/);
		assert.equal(attempts, 2);
	});

	it("truncateIds keeps the window and the closing SEP token", () => {
		const long = Array.from({ length: 600 }, (_, i) => (i === 599 ? 102 : 5));
		const out = truncateIds(long);
		assert.equal(out.length, 512);
		assert.equal(out[511], 102);
		assert.deepEqual(truncateIds([101, 5, 102]), [101, 5, 102]);
	});
});

const LIVE = process.env.LH_LIVE_EMBED_DIR;
describe("live model (only with LH_LIVE_EMBED_DIR)", { skip: !LIVE }, () => {
	it("ranks the matching passage first with the real weights", async () => {
		const embedder = createLocalEmbedder({ dir: LIVE!, files: EMBEDDING_MODEL.files.map((f) => ({ ...f })) });
		const docs = [
			"Loop diuretics such as furosemide block the Na-K-2Cl cotransporter in the thick ascending limb.",
			"Insulin lowers blood glucose by promoting glucose uptake into muscle and fat.",
			"Aortic stenosis causes a crescendo-decrescendo systolic murmur radiating to the carotids.",
		];
		const vectors = await embedder.embedPassages(docs);
		const q = await embedder.embedQuery("which drug blocks the NKCC2 transporter?");
		const scores = vectors.map((v) => v.reduce((s, x, i) => s + x * q[i]!, 0));
		assert.equal(scores.indexOf(Math.max(...scores)), 0);
	});
});
