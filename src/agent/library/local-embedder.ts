/**
 * THE LOCAL EMBEDDER (medical fork, Phase 6): a small sentence-embedding
 * model that runs on the learner's own machine — no API key, no cost, no
 * network after the one-time download of its files.
 *
 *   model     BAAI bge-small-en-v1.5, int8 ONNX export (Xenova/bge-small-en-v1.5)
 *   size      ~34 MB weights + ~0.7 MB tokenizer
 *   license   MIT
 *   runtime   onnxruntime-node (native, Apple-silicon fast) + @huggingface/tokenizers (pure JS)
 *
 * The files are fetched once from a PINNED Hugging Face revision, checked
 * against known SHA-256 hashes, and cached under data/models/. After that the
 * embedder never touches the network. If the download is impossible (offline
 * on first use) `ready()` throws an honest error and the caller falls back to
 * keyword-only search — embeddings are an enhancement, never a gate.
 *
 * bge conventions: CLS-token pooling, L2-normalised output, and queries (not
 * passages) are prefixed with an instruction so short questions match long
 * passages.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import type { LibraryEmbedder } from "../../core/library.ts";

export const EMBEDDING_MODEL = {
	/** Stored with every vector set; changing the model changes this id. */
	id: "bge-small-en-v1.5-int8",
	name: "bge-small-en-v1.5 (int8)",
	repo: "Xenova/bge-small-en-v1.5",
	revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
	license: "MIT",
	dim: 384,
	sizeMb: 35,
	files: [
		{
			path: "onnx/model_quantized.onnx",
			bytes: 34014426,
			sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
		},
		{
			path: "tokenizer.json",
			bytes: 711396,
			sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
		},
		{
			path: "tokenizer_config.json",
			bytes: 366,
			sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
		},
	],
} as const;

export interface ModelFile {
	path: string;
	bytes: number;
	sha256: string;
}

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const MAX_TOKENS = 512;
const BATCH = 8;

export function defaultModelDir(): string {
	// The model dir is a runtime data path, never part of the build trace.
	return path.join(/*turbopackIgnore: true*/ PATHS.models, EMBEDDING_MODEL.id);
}

/** Are all the model files on disk with the expected sizes? */
export function modelFilesPresent(dir: string = defaultModelDir()): boolean {
	return EMBEDDING_MODEL.files.every((f) => {
		try {
			return fs.statSync(path.join(dir, f.path)).size === f.bytes;
		} catch {
			return false;
		}
	});
}

// The slice of onnxruntime-node this module uses (a fake stands in for it in tests).
export interface OrtTensorLike {
	data: ArrayLike<number> | BigInt64Array | Float32Array;
	dims: readonly number[];
}
export interface OrtLike {
	InferenceSession: {
		create(modelPath: string, options?: Record<string, unknown>): Promise<{
			inputNames: readonly string[];
			outputNames: readonly string[];
			run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
		}>;
	};
	Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

export interface TokenizerLike {
	encode(text: string): { ids: number[] };
}

export interface LocalEmbedderOptions {
	/** Where the model files live (default data/models/<id>). */
	dir?: string;
	/** Injected for tests; default is the global fetch. */
	fetch?: typeof fetch;
	/** Injected for tests: stand-in manifest (default is EMBEDDING_MODEL.files). */
	files?: readonly ModelFile[];
	/** Injected for tests; default loads onnxruntime-node lazily. */
	loadRuntime?: () => Promise<OrtLike>;
	/** Injected for tests; default builds a Tokenizer from the model dir. */
	loadTokenizer?: (dir: string) => Promise<TokenizerLike>;
}

/** Download any missing/short model file into `dir`, hash-checked. */
export async function ensureModelFiles(
	dir: string,
	fetchImpl: typeof fetch,
	onStatus?: (message: string) => void,
	files: readonly ModelFile[] = EMBEDDING_MODEL.files,
): Promise<void> {
	let have = 0;
	const total = files.reduce((n, f) => n + f.bytes, 0);
	for (const f of files) {
		const target = path.join(dir, f.path);
		try {
			if (fs.statSync(target).size === f.bytes) {
				have += f.bytes;
				continue;
			}
		} catch {
			/* missing: download below */
		}
		const url = `https://huggingface.co/${EMBEDDING_MODEL.repo}/resolve/${EMBEDDING_MODEL.revision}/${f.path}`;
		let response: Response;
		try {
			response = await fetchImpl(url);
		} catch (err) {
			throw new Error(`couldn't download the search model — are you offline? (${err instanceof Error ? err.message : String(err)})`);
		}
		if (!response.ok || !response.body) throw new Error(`couldn't download the search model (HTTP ${response.status} for ${f.path})`);
		const hash = crypto.createHash("sha256");
		const parts: Uint8Array[] = [];
		let got = 0;
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			hash.update(value);
			got += value.byteLength;
			onStatus?.(`Downloading the search model (one time, ~${EMBEDDING_MODEL.sizeMb} MB): ${Math.round(((have + got) / total) * 100)}%`);
		}
		if (got !== f.bytes || hash.digest("hex") !== f.sha256) {
			throw new Error(`the downloaded search model file ${f.path} failed its integrity check — try again`);
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, Buffer.concat(parts));
		fs.renameSync(tmp, target);
		have += f.bytes;
	}
}

function l2normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (const x of v) sum += x * x;
	const norm = Math.sqrt(sum) || 1;
	return v.map((x) => x / norm);
}

/** Truncate to the model window, keeping the closing [SEP] token. */
export function truncateIds(ids: number[]): number[] {
	return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!];
}

export function createLocalEmbedder(options: LocalEmbedderOptions = {}): LibraryEmbedder {
	const dir = options.dir ?? defaultModelDir();
	const fetchImpl = options.fetch ?? fetch;
	let session: Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>> | null = null;
	let ort: OrtLike | null = null;
	let tokenizer: TokenizerLike | null = null;
	let loading: Promise<void> | null = null;

	async function load(onStatus?: (message: string) => void): Promise<void> {
		await ensureModelFiles(dir, fetchImpl, onStatus, options.files);
		onStatus?.("Loading the search model…");
		ort = options.loadRuntime ? await options.loadRuntime() : ((await import("onnxruntime-node")) as unknown as OrtLike);
		tokenizer = options.loadTokenizer
			? await options.loadTokenizer(dir)
			: await (async () => {
					const { Tokenizer } = await import("@huggingface/tokenizers");
					const json = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf-8"));
					const config = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf-8"));
					return new Tokenizer(json, config) as TokenizerLike;
				})();
		session = await ort.InferenceSession.create(path.join(dir, "onnx", "model_quantized.onnx"), {
			// Leave the machine usable while a textbook indexes.
			intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
			graphOptimizationLevel: "all",
		});
	}

	async function embedBatch(texts: string[]): Promise<Float32Array[]> {
		if (!session || !ort || !tokenizer) throw new Error("the search model isn't loaded");
		const encoded = texts.map((t) => truncateIds(tokenizer!.encode(t).ids));
		const width = Math.max(...encoded.map((ids) => ids.length));
		const ids = new BigInt64Array(texts.length * width);
		const mask = new BigInt64Array(texts.length * width);
		encoded.forEach((row, r) => {
			row.forEach((id, c) => {
				ids[r * width + c] = BigInt(id);
				mask[r * width + c] = 1n;
			});
		});
		const dims = [texts.length, width];
		const feeds: Record<string, unknown> = {
			input_ids: new ort.Tensor("int64", ids, dims),
			attention_mask: new ort.Tensor("int64", mask, dims),
		};
		if (session.inputNames.includes("token_type_ids")) {
			feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(texts.length * width), dims);
		}
		const out = await session.run(feeds);
		const hidden = out[session.outputNames[0]!]!;
		const [, seq, dim] = hidden.dims as [number, number, number];
		const data = hidden.data as Float32Array;
		// CLS pooling: the first token's vector of each row.
		return texts.map((_, r) => l2normalize(Float32Array.from(data.subarray(r * seq * dim, r * seq * dim + dim))));
	}

	return {
		model: EMBEDDING_MODEL.id,
		dim: EMBEDDING_MODEL.dim,

		ready(onStatus) {
			if (session) return Promise.resolve();
			// One load at a time; a failure clears so the next call can retry.
			loading ??= load(onStatus).catch((err) => {
				loading = null;
				throw err;
			});
			return loading;
		},

		async embedPassages(texts) {
			if (!session) await this.ready();
			const out: Float32Array[] = [];
			for (let i = 0; i < texts.length; i += BATCH) out.push(...(await embedBatch(texts.slice(i, i + BATCH))));
			return out;
		},

		async embedQuery(text) {
			if (!session) await this.ready();
			return (await embedBatch([QUERY_PREFIX + text]))[0]!;
		},
	};
}
