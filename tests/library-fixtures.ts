/**
 * Test fixtures for the PDF library (medical fork, Phase 6). Everything is
 * built from the FORMAT, never from real lecture content: a tiny hand-rolled
 * PDF writer (text pages, an optional painted image, an optional outline)
 * and a SlideScribe note laid out exactly as slidescribe/assemble.py writes
 * it (frontmatter keys, `## Slide N: title` sections with the template's
 * fields, ▶ / ⭐ / ⚠ / "(AI read — verify)" marks, "## Run notes").
 */

import type { LibraryEmbedder } from "../src/core/library.ts";
import { tokenize } from "../src/core/library.ts";

export interface FixturePage {
	/** One string per text line. */
	lines: string[];
	/** Paint one image on the page (counts as an image for the triage). */
	image?: boolean;
}

export interface FixtureOutline {
	title: string;
	/** 1-based target page. */
	page: number;
	children?: FixtureOutline[];
}

function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** A minimal valid PDF (Helvetica text, optional 2×2 RGB image, optional outline). */
export function makePdf(pages: FixturePage[], outline: FixtureOutline[] = []): Buffer {
	const hasImage = pages.some((p) => p.image);

	// Object numbers are fixed up front so references can point forward.
	const catalog = 1;
	const pagesRoot = 2;
	const font = 3;
	const image = hasImage ? 4 : 0;
	const first = hasImage ? 5 : 4;
	const pageObj = (i: number) => first + i * 2;
	const contentObj = (i: number) => first + i * 2 + 1;
	let next = first + pages.length * 2;

	// Outline objects (flattened with parent/sibling links).
	interface Flat { id: number; title: string; page: number; parent: number; prev: number; next: number; first: number; last: number; count: number }
	const flat: Flat[] = [];
	const outlineRoot = outline.length > 0 ? next++ : 0;
	const build = (items: FixtureOutline[], parent: number): number[] => {
		const ids = items.map(() => next++);
		items.forEach((item, k) => {
			const f: Flat = { id: ids[k]!, title: item.title, page: item.page, parent, prev: ids[k - 1] ?? 0, next: ids[k + 1] ?? 0, first: 0, last: 0, count: 0 };
			flat.push(f);
			if (item.children?.length) {
				const kids = build(item.children, f.id);
				f.first = kids[0]!;
				f.last = kids[kids.length - 1]!;
				f.count = kids.length;
			}
		});
		return ids;
	};
	const topIds = outline.length > 0 ? build(outline, outlineRoot) : [];

	const slots: string[] = [];
	slots[catalog] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R${outlineRoot ? ` /Outlines ${outlineRoot} 0 R` : ""} >>`;
	slots[pagesRoot] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	slots[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	if (image) slots[image] = "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\nÿ\u0000\u0000\u0000ÿ\u0000\u0000\u0000ÿÿÿ\u0000\nendstream";
	pages.forEach((p, i) => {
		const resources = `<< /Font << /F1 ${font} 0 R >>${p.image ? ` /XObject << /Im0 ${image} 0 R >>` : ""} >>`;
		slots[pageObj(i)] = `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentObj(i)} 0 R >>`;
		const text = p.lines.map((line, k) => `BT /F1 12 Tf 50 ${740 - k * 18} Td (${esc(line)}) Tj ET`).join("\n");
		const stream = `${p.image ? "q 100 0 0 100 400 600 cm /Im0 Do Q\n" : ""}${text}`;
		slots[contentObj(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	if (outlineRoot) {
		slots[outlineRoot] = `<< /Type /Outlines /First ${topIds[0]} 0 R /Last ${topIds[topIds.length - 1]} 0 R /Count ${flat.length} >>`;
		for (const f of flat) {
			slots[f.id] =
				`<< /Title (${esc(f.title)}) /Parent ${f.parent} 0 R${f.prev ? ` /Prev ${f.prev} 0 R` : ""}${f.next ? ` /Next ${f.next} 0 R` : ""}` +
				`${f.first ? ` /First ${f.first} 0 R /Last ${f.last} 0 R /Count ${f.count}` : ""} /Dest [${pageObj(f.page - 1)} 0 R /Fit] >>`;
		}
	}

	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < slots.length; id++) {
		offsets[id] = out.length;
		out += `${id} 0 obj\n${slots[id]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${slots.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < slots.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${slots.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

// ─── SlideScribe note ────────────────────────────────────────────────────────

export interface FixtureSlide {
	n: number;
	title: string;
	takeaway: string;
	onSlide: string;
	explained: string;
	keyTerms?: string;
	stressed?: string;
}

const LEGEND = "▶ time in recording (P2 = part 2) · ⭐ lecturer stressed · ⚠ check · (AI read — verify)";

/** A note in the shape slidescribe/assemble.py writes. */
export function makeSlideScribeNote(opts: {
	title?: string;
	course?: string;
	sourcePdf?: string;
	slides: FixtureSlide[];
	extra?: string;
	slideCount?: number;
}): string {
	const title = opts.title ?? "Fixture Lecture 3 - Test Topic";
	const front = [
		"---",
		`title: "${title}"`,
		`course: "${opts.course ?? "Fixture Course"}"`,
		'lecturer: "Dr Example"',
		'date: "2026-01-01"',
		`source_pdf: "${opts.sourcePdf ?? "fixture-lecture.pdf"}"`,
		"parts: 1",
		`slide_count: ${opts.slideCount ?? opts.slides.length}`,
		'generated_at: "2026-01-02 03:04"',
		"engines:",
		'  stt: "whisper"',
		'  fixer: "codex"',
		'  writer: "writer-model"',
		"tags: [slidescribe]",
		"---",
	].join("\n");
	const sections = opts.slides.map((s) =>
		[
			`## Slide ${s.n}: ${s.title}`,
			`▶ P1 0${s.n}:00${s.stressed ? " · ⭐ Lecturer stressed this" : ""}`,
			`**Takeaway:** ${s.takeaway}`,
			`**On the slide:** ${s.onSlide}`,
			...(s.stressed ? [`**Lecturer stressed:** ${s.stressed}`] : []),
			`**Explained:** ${s.explained}`,
			`**Key terms:** ${s.keyTerms ?? "alpha · beta"}`,
			`**Links:** → Slide ${s.n === 1 ? 2 : 1} (related)`,
		].join("\n"),
	);
	const body = [front, `# ${title}`, `*${LEGEND}*`, sections.join("\n\n")];
	if (opts.extra) body.push(`## Extra from the lecture\n### Q&A ▶ P1 59:00\n- ${opts.extra}`);
	body.push("## Run notes\n- Nothing to flag.");
	return body.join("\n\n") + "\n";
}

// ─── a deterministic fake embedder (no model, no network) ────────────────────

/** Bag-of-words hashed into 64 dims, unit length: texts sharing words are
 *  near each other, which is all the search tests need. */
export function fakeEmbedder(model = "fake-embedder-v1"): LibraryEmbedder & { calls: number } {
	const dim = 64;
	const embed = (text: string): Float32Array => {
		const v = new Float32Array(dim);
		for (const t of tokenize(text)) {
			let h = 2166136261;
			for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
			v[h % dim]! += 1;
		}
		let n = 0;
		for (const x of v) n += x * x;
		n = Math.sqrt(n) || 1;
		return v.map((x) => x / n);
	};
	const e = {
		model,
		dim,
		calls: 0,
		async ready() {},
		async embedPassages(texts: string[]) {
			e.calls++;
			return texts.map(embed);
		},
		async embedQuery(text: string) {
			e.calls++;
			return embed(text);
		},
	};
	return e;
}
