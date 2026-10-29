/**
 * Pasted / dropped screenshots (Phase 7 — Explain my miss), end to end and
 * offline: Cmd+V of an image in the chat box, or dropping an image in a plain
 * browser, POSTs the bytes to the real /api/attachments route (called
 * directly, no network), the image lands in the data dir, and its path is
 * attached as a quoted file-path chip. The read tool then returns the saved
 * file as a model-visible image.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createCanvas } from "@napi-rs/canvas";

// The data-dir seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-image-attach-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const route = await import("../app/api/attachments/route.ts");
const { saveImageAttachment, MAX_ATTACHMENT_BYTES } = await import("../src/server/attachments.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { PathInput } = await import("../components/path-input.tsx");
const { FilePathDropZone } = await import("../components/file-path-drop-zone.tsx");
const { Composer } = await import("../components/composer.tsx");
const { imageFilesOf, saveImageFiles } = await import("../components/image-attach.ts");
const { readPathInput } = await import("../components/path-input-dom.ts");
const { quoteFilePath, parseFilePaths } = await import("../src/core/file-paths.ts");

function png(width = 8, height = 8): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}
const imageFile = (name = "Screenshot.png", bytes: Uint8Array = png(), type = "image/png") => new File([bytes as BlobPart], name, { type });
const attachmentsDir = path.join(TMP_DATA, "attachments");
const saved = () => (fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : []);

/** The real route behind a fetch double — no network, the actual handler. */
const routeFetch = (async (url: string, init?: RequestInit) => {
	assert.equal(String(url), "/api/attachments");
	return route.POST(new Request(`http://localhost${url}`, { method: "POST", headers: init?.headers, body: init?.body as BodyInit }));
}) as typeof fetch;

describe("saving an image into the data dir", () => {
	it("writes a pasted PNG under data/attachments and returns a rooted path", () => {
		const result = saveImageAttachment(png());
		assert.ok(result.ok);
		assert.ok(result.path.startsWith(attachmentsDir + path.sep), "inside the data dir");
		assert.match(path.basename(result.path), /^pasted-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
		assert.deepEqual(fs.readFileSync(result.path), png());
		assert.doesNotThrow(() => quoteFilePath(result.path), "the path can ride in a message as a chip");
	});

	it("decides the type from the bytes, not the name or the claimed type", () => {
		const text = saveImageAttachment(new TextEncoder().encode("not an image at all"));
		assert.ok(!text.ok && text.status === 415);
		assert.match(text.error, /PNG, JPEG, GIF, WebP or BMP/);
	});

	it("refuses an empty or oversized image with a clear reason", () => {
		const empty = saveImageAttachment(new Uint8Array());
		assert.ok(!empty.ok && empty.status === 400);
		const big = saveImageAttachment(new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
		assert.ok(!big.ok && big.status === 413);
		assert.match(big.error, /larger than 10 MB/);
	});

	it("POST /api/attachments: 200 with a path, then the file is there; non-images get 415", async () => {
		const before = saved().length;
		const ok = await route.POST(new Request("http://localhost/api/attachments", { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array(png()) }));
		assert.equal(ok.status, 200);
		const { path: file } = (await ok.json()) as { path: string };
		assert.equal(fs.existsSync(file), true);
		assert.equal(saved().length, before + 1);

		const bad = await route.POST(new Request("http://localhost/api/attachments", { method: "POST", body: "hello" }));
		assert.equal(bad.status, 415);
		assert.equal(saved().length, before + 1, "nothing saved for a refused upload");

		const tooBig = await route.POST(new Request("http://localhost/api/attachments", {
			method: "POST", headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) }, body: new Uint8Array(png()),
		}));
		assert.equal(tooBig.status, 413);
	});

	it("the saved screenshot reaches the model: the read tool returns it as an image", async () => {
		const result = saveImageAttachment(png(16, 16));
		assert.ok(result.ok);
		const out = await readTool.execute("read-1", { path: result.path });
		const details = JSON.stringify(out);
		assert.match(details, /Read image file \[image\/png\]/);
		assert.match(details, /"mimeType":"image\/png"/);
	});
});

describe("client helpers", () => {
	it("imageFilesOf keeps image files only", () => {
		const files = [imageFile("a.png"), new File(["x"], "notes.pdf", { type: "application/pdf" }), imageFile("b.jpg", png(), "image/jpeg")];
		assert.deepEqual(imageFilesOf(files).map((f) => f.name), ["a.png", "b.jpg"]);
		assert.deepEqual(imageFilesOf(null), []);
	});

	it("saveImageFiles returns paths in order and the first failure's reason", async () => {
		const result = await saveImageFiles([imageFile("a.png"), imageFile("bad.png", new TextEncoder().encode("nope")), imageFile("c.png")], routeFetch);
		assert.equal(result.paths.length, 2);
		assert.match(result.error ?? "", /PNG, JPEG/);
		assert.deepEqual(await saveImageFiles([], routeFetch), { paths: [] });
		const offline = await saveImageFiles([imageFile()], (async () => { throw new TypeError("offline"); }) as typeof fetch);
		assert.deepEqual(offline.paths, []);
		assert.match(offline.error ?? "", /Couldn’t attach that image/);
	});
});

// ─── the chat box and the drop zone, in a synthetic DOM ───────────────────────

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture({ desktop = false } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		// The component code calls plain fetch: point it at the real route.
		fetch: routeFetch,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", { configurable: true, value: desktop ? { getPathForFile: () => "" } : undefined });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	let value = "";
	function Harness() {
		return <FilePathDropZone>
			<PathInput data-testid="editor" pasteImages onAttachError={(m) => { errors.push(m); }} value={value} onValueChange={(v) => { value = v; draw(); }} />
			<div data-testid="content">Content</div>
		</FilePathDropZone>;
	}
	const errors: string[] = [];
	function draw() { root.render(<Harness />); }
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>('[data-testid="editor"]')!;
	async function paste(files: File[], text = "") {
		editor.focus();
		const event = Object.assign(new win.Event("paste", { bubbles: true, cancelable: true }), {
			clipboardData: { getData: (type: string) => (type === "text/plain" ? text : ""), files },
		});
		await act(async () => { editor.dispatchEvent(event); });
		// The upload is async: let the route answer, then React settle.
		await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
		return event;
	}
	async function drop(files: File[]) {
		editor.focus();
		const dataTransfer = {
			types: ["Files"],
			files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
			items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) })),
			dropEffect: "none",
		};
		const event = Object.assign(new win.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer });
		await act(async () => { doc.querySelector('[data-testid="content"]')!.dispatchEvent(event); });
		await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
		return event;
	}
	return { doc, editor, errors, paste, drop,
		get value() { return value; },
		get status() { return doc.querySelector('[role="status"]')?.textContent ?? ""; } };
}

describe("Cmd+V in the chat box", () => {
	it("saves a pasted screenshot into the data dir and attaches its path as a chip", async () => {
		const before = saved().length;
		const f = await fixture();
		const event = await f.paste([imageFile()]);
		assert.equal(event.defaultPrevented, true);
		assert.equal(saved().length, before + 1, "the image landed in data/attachments");
		const parts = parseFilePaths(f.value).filter((p) => p.kind === "path");
		assert.equal(parts.length, 1);
		const attached = (parts[0] as { path: string }).path;
		assert.ok(attached.startsWith(attachmentsDir + path.sep));
		assert.equal(fs.existsSync(attached), true);
		assert.equal(readPathInput(f.editor), f.value);
		assert.ok(f.doc.querySelector('[aria-label^="' + attachmentsDir + '"]'), "rendered as a file-path chip");
		assert.deepEqual(f.errors, []);
	});

	it("text on the clipboard always wins over an image", async () => {
		const before = saved().length;
		const f = await fixture();
		await f.paste([imageFile()], "A 58-year-old man presents with chest pain");
		assert.equal(saved().length, before, "no upload when there is text");
		assert.equal(f.value, "A 58-year-old man presents with chest pain");
	});

	it("tells the learner when the image can't be attached, and leaves the draft alone", async () => {
		const f = await fixture();
		await f.paste([imageFile("fake.png", new TextEncoder().encode("not really a png"))]);
		assert.equal(f.value, "");
		assert.equal(f.errors.length, 1);
		assert.match(f.errors[0]!, /PNG, JPEG, GIF, WebP or BMP/);
	});

	it("the chat composer shows that reason above the input", async () => {
		const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [name, next] of Object.entries({
			React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
			Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: routeFetch,
		})) {
			previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
		}
		Object.assign(doc, { getSelection: () => ({ anchorNode: null, focusNode: null, setBaseAndExtent() {} }), oninput: null });
		const { createRoot } = await import("react-dom/client");
		const root = createRoot(doc.getElementById("root")!);
		try {
			await act(async () => root.render(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />));
			const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
			const event = Object.assign(new win.Event("paste", { bubbles: true, cancelable: true }), {
				clipboardData: { getData: () => "", files: [imageFile("x.png", new TextEncoder().encode("no"))] },
			});
			await act(async () => { editor.dispatchEvent(event); });
			await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
			assert.match(doc.querySelector('[data-testid="attach-notice"]')?.textContent ?? "", /PNG, JPEG, GIF, WebP or BMP/);
		} finally {
			await act(async () => root.unmount());
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete (globalThis as Record<string, unknown>)[name];
			}
		}
	});
});

describe("dropping a screenshot", () => {
	it("in a plain browser the image is saved into the data dir and attached", async () => {
		const before = saved().length;
		const f = await fixture({ desktop: false });
		const event = await f.drop([imageFile("Screen Shot 2026.png")]);
		assert.equal(event.defaultPrevented, true);
		assert.equal(saved().length, before + 1);
		const parts = parseFilePaths(f.value).filter((p) => p.kind === "path");
		assert.equal(parts.length, 1);
		assert.ok((parts[0] as { path: string }).path.startsWith(attachmentsDir + path.sep));
		assert.equal(f.status, "", "success is silent");
	});

	it("in a plain browser a non-image drop keeps the desktop-only notice and saves nothing", async () => {
		const before = saved().length;
		const f = await fixture({ desktop: false });
		await f.drop([new File(["%PDF"], "notes.pdf", { type: "application/pdf" })]);
		assert.equal(saved().length, before);
		assert.match(f.status, /only be attached in the desktop app/);
		assert.equal(f.value, "");
	});

	it("in the desktop app the dropped file keeps its own path (upstream behaviour, nothing is copied)", async () => {
		const before = saved().length;
		const f = await fixture({ desktop: true });
		// getPathForFile returns "" for this synthetic file → no path, no upload.
		await f.drop([imageFile()]);
		assert.equal(saved().length, before, "desktop drops are attached by path, never uploaded");
		assert.match(f.status, /No local file paths were available/);
	});
});
