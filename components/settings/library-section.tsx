"use client";
/**
 * The Library section (medical fork, Phase 6): import PDFs (slides,
 * textbooks) and SlideScribe lecture notes, watch them index, remove them.
 *
 * - PDFs are COPIED into the app's data dir by the server, one index per
 *   book, so moving or renaming the originals never breaks a citation.
 * - Per PDF, at import: "text only" (fast, free) or "ChatGPT vision describes
 *   image-heavy pages" (slower, uses the ChatGPT Plus quota).
 * - "Import SlideScribe note": pick the lecture's .md; if its PDF isn't
 *   picked too, the section asks for the file the note names (`source_pdf`).
 * - A progress bar per book while it indexes; the list polls once a second
 *   only while something is indexing.
 * - "Make Anki cards…" on a ready book: pick a section (an outline entry or a
 *   page range, at most 60 pages) and the Anki review panel drafts cards from it.
 *
 * The view is presentational (LibraryView) so render tests pin its markup;
 * LibrarySection owns the fetches.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { tocSectionPages, type AnkiOrigin, type LibraryBook, type LibraryListing } from "@/src/core";
import { AnkiDialog } from "@/components/anki-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── pure helpers (exported for tests) ───────────────────────────────────────

/** What the progress bar says. */
export function progressLabel(book: Pick<LibraryBook, "progress">): string {
	const p = book.progress;
	if (!p) return "Indexing…";
	if (p.message) return p.message;
	const counts = p.total > 0 ? ` ${p.done} / ${p.total}` : "";
	switch (p.phase) {
		case "queued":
			return "Waiting for its turn…";
		case "reading":
			return `Reading pages${counts}`;
		case "describing":
			return `ChatGPT is describing image-heavy pages${counts}`;
		case "embedding":
			return `Building the search index${counts}`;
		case "finishing":
			return "Finishing…";
	}
}

export function progressPercent(book: Pick<LibraryBook, "progress">): number {
	const p = book.progress;
	if (!p || p.total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** One line of facts about a ready book. */
export function bookFacts(book: LibraryBook): string {
	const parts: string[] = [];
	if (book.kind === "slidescribe") {
		parts.push("Lecture note");
		if (book.course) parts.push(book.course);
		parts.push(`${book.note?.slideCount ?? book.pageCount} slides`);
	} else {
		parts.push(`${book.pageCount} pages`);
		if (book.mode === "vision") parts.push(`${book.visionPages.length} images described`);
		if (book.toc.length > 0) parts.push(`${book.toc.length} outline entries`);
	}
	if (book.status === "ready") parts.push(book.embeddings ? "keyword + meaning search" : "keyword search only");
	return parts.join(" · ");
}

/** Split a picked file list into the SlideScribe note and the PDF(s). */
export function splitPicked(files: readonly File[]): { note?: File; pdfs: File[] } {
	const note = files.find((f) => /\.(md|markdown)$/i.test(f.name));
	return { ...(note ? { note } : {}), pdfs: files.filter((f) => /\.pdf$/i.test(f.name)) };
}

// ─── the view ────────────────────────────────────────────────────────────────

export interface PendingPdf {
	file: File;
	mode: "text" | "vision";
}

export interface LibraryViewProps {
	listing: LibraryListing | null;
	loadError?: string | null;
	pending: PendingPdf[];
	/** A SlideScribe note waiting for its PDF, with the file name it names. */
	needsPdf?: { noteName: string; expectedName: string } | null;
	busy?: boolean;
	message?: string | null;
	onPickPdfs: () => void;
	onPickNote: () => void;
	onPickNotePdf: () => void;
	onCancelNote: () => void;
	onModeChange: (index: number, mode: "text" | "vision") => void;
	onDropPending: (index: number) => void;
	onImport: () => void;
	onRemove: (book: LibraryBook) => void;
	onRetry: (book: LibraryBook, action: "reindex" | "embed") => void;
	/** Open the Anki review panel for a section of a ready book (absent = no Anki action). */
	onMakeCards?: (book: LibraryBook, pages: string) => void;
}

/**
 * "Make Anki cards…" for one ready book (medical spec Phase 5, trigger c):
 * collapsed to a link; open, it takes an outline section or a page range.
 */
export function BookAnkiControl({ book, onMakeCards }: { book: LibraryBook; onMakeCards: (pages: string) => void }) {
	const [open, setOpen] = useState(false);
	const [pages, setPages] = useState("");
	const unit = book.kind === "slidescribe" ? "slides" : "pages";
	if (!open) {
		return (
			<button type="button" className="self-start text-xs underline" data-testid={`library-anki-${book.id}`} onClick={() => setOpen(true)}>
				Make Anki cards…
			</button>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid={`library-anki-form-${book.id}`}>
			{book.toc.length > 0 && (
				<select
					aria-label="Outline section"
					className="max-w-[16rem] rounded-sm border border-border bg-background px-1.5 py-1 text-xs"
					value=""
					onChange={(e) => {
						if (e.target.value !== "") setPages(tocSectionPages(book.toc, Number(e.target.value), book.pageCount));
					}}
				>
					<option value="">Pick an outline section…</option>
					{book.toc.map((entry, i) => (
						<option key={i} value={i}>
							{"\u00a0\u00a0".repeat(entry.depth)}
							{entry.title} (p.{entry.page})
						</option>
					))}
				</select>
			)}
			<input
				aria-label={`Which ${unit}`}
				data-testid={`library-anki-pages-${book.id}`}
				className="w-32 rounded-sm border border-border bg-background px-2 py-1 text-xs"
				placeholder={`${unit}, e.g. 12-20`}
				value={pages}
				onChange={(e) => setPages(e.target.value)}
			/>
			<Button type="button" size="sm" data-testid={`library-anki-go-${book.id}`} disabled={pages.trim() === ""} onClick={() => onMakeCards(pages.trim())}>
				Draft cards
			</Button>
			<button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
				Cancel
			</button>
		</div>
	);
}

const MODE_TEXT = "Text only — fast and free";
const MODE_VISION = "ChatGPT vision describes image-heavy pages — slower, uses your ChatGPT Plus quota";

export function LibraryView(props: LibraryViewProps) {
	const { listing, pending } = props;
	const vision = listing?.vision;
	return (
		<div data-testid="library-section" className="flex flex-col gap-4">
			<p className="text-xs text-muted-foreground">
				Add your slides and textbooks once. They&apos;re copied into this app, so moving or renaming the originals never breaks a citation, and the tutor can search them and cite{" "}
				<span className="font-ui">book p.N</span>.
				{listing && (
					<>
						{" "}
						Search runs on a small model that works offline on this Mac ({listing.embeddingModel.name}, ~{listing.embeddingModel.sizeMb} MB, {listing.embeddingModel.license} license;{" "}
						{listing.embeddingModel.downloaded ? "already downloaded" : "downloaded once, the first time a book is indexed"}).
					</>
				)}
			</p>

			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" size="sm" data-testid="library-add-pdfs" disabled={props.busy} onClick={props.onPickPdfs}>
					Add PDFs…
				</Button>
				<Button type="button" variant="outline" size="sm" data-testid="library-add-note" disabled={props.busy} onClick={props.onPickNote}>
					Import SlideScribe note…
				</Button>
			</div>

			{props.message && (
				<p role="status" data-testid="library-message" className="text-xs text-muted-foreground">
					{props.message}
				</p>
			)}

			{props.needsPdf && (
				<div data-testid="library-needs-pdf" className="flex flex-col gap-2 rounded-sm border border-border px-3 py-2">
					<p className="text-xs">
						<span className="font-ui">{props.needsPdf.noteName}</span> needs its PDF
						{props.needsPdf.expectedName ? (
							<>
								: <span className="font-ui">{props.needsPdf.expectedName}</span>
							</>
						) : null}
						. Pick it to finish the import.
					</p>
					<div className="flex gap-2">
						<Button type="button" size="sm" data-testid="library-pick-note-pdf" onClick={props.onPickNotePdf}>
							Pick the PDF…
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={props.onCancelNote}>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{pending.length > 0 && (
				<div data-testid="library-pending" className="flex flex-col gap-3 rounded-sm border border-border px-3 py-3">
					<p className="text-xs uppercase tracking-widest text-muted-foreground">Ready to import</p>
					{pending.map((p, i) => (
						<fieldset key={`${p.file.name}-${i}`} className="flex flex-col gap-1.5" data-testid={`library-pending-${i}`}>
							<legend className="flex w-full items-center justify-between gap-2 text-sm">
								<span className="min-w-0 truncate font-ui">{p.file.name}</span>
								<button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => props.onDropPending(i)}>
									Remove
								</button>
							</legend>
							<label className="flex items-start gap-2 text-xs">
								<input type="radio" name={`mode-${i}`} checked={p.mode === "text"} onChange={() => props.onModeChange(i, "text")} data-testid={`library-mode-text-${i}`} />
								<span>{MODE_TEXT}</span>
							</label>
							<label className={cn("flex items-start gap-2 text-xs", vision && !vision.available && "opacity-50")}>
								<input
									type="radio"
									name={`mode-${i}`}
									checked={p.mode === "vision"}
									disabled={!vision?.available}
									onChange={() => props.onModeChange(i, "vision")}
									data-testid={`library-mode-vision-${i}`}
								/>
								<span>
									{MODE_VISION}
									{vision && !vision.available && vision.reason ? <span className="block text-muted-foreground/80">Not available: {vision.reason}</span> : null}
								</span>
							</label>
						</fieldset>
					))}
					<div className="flex gap-2">
						<Button type="button" size="sm" data-testid="library-import" disabled={props.busy} onClick={props.onImport}>
							{props.busy ? "Importing…" : pending.length === 1 ? "Import" : `Import ${pending.length} PDFs`}
						</Button>
					</div>
				</div>
			)}

			{props.loadError && (
				<p role="alert" className="text-xs text-red-500">
					{props.loadError}
				</p>
			)}

			{listing && listing.books.length === 0 && !props.loadError && (
				<p data-testid="library-empty" className="text-xs text-muted-foreground/80">
					No books yet.
				</p>
			)}

			<ul className="flex flex-col gap-2" data-testid="library-books">
				{listing?.books.map((book) => (
					<li key={book.id} data-testid={`library-book-${book.id}`} className="flex flex-col gap-1.5 rounded-sm border border-border px-3 py-2">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="truncate text-sm">{book.title}</p>
								<p className="text-xs text-muted-foreground/80">{book.status === "indexing" ? (book.kind === "slidescribe" ? "Lecture note" : `${book.pageCount} pages`) : bookFacts(book)}</p>
							</div>
							<button
								type="button"
								className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
								data-testid={`library-remove-${book.id}`}
								onClick={() => props.onRemove(book)}
							>
								{book.status === "indexing" ? "Cancel" : "Remove"}
							</button>
						</div>

						{book.status === "indexing" && (
							<div className="flex flex-col gap-1">
								<div
									role="progressbar"
									aria-label={`Indexing ${book.title}`}
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={progressPercent(book)}
									className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
								>
									<div className="h-full bg-muted-foreground transition-[width]" style={{ width: `${progressPercent(book)}%` }} />
								</div>
								<p className="text-xs text-muted-foreground/80" data-testid={`library-progress-${book.id}`}>
									{progressLabel(book)}
								</p>
							</div>
						)}

						{book.status === "error" && (
							<div className="flex items-center justify-between gap-3">
								<p role="alert" className="text-xs text-red-500">
									{book.error ?? "Indexing failed."}
								</p>
								<button type="button" className="shrink-0 text-xs underline" data-testid={`library-retry-${book.id}`} onClick={() => props.onRetry(book, "reindex")}>
									Retry
								</button>
							</div>
						)}

						{book.notice && (
							<p className="text-xs text-amber-600 dark:text-amber-400" data-testid={`library-notice-${book.id}`}>
								{book.notice}
							</p>
						)}

						{book.status === "ready" && props.onMakeCards && (
							<BookAnkiControl book={book} onMakeCards={(pages) => props.onMakeCards?.(book, pages)} />
						)}

						{book.status === "ready" && !book.embeddings && (
							<button type="button" className="self-start text-xs underline" data-testid={`library-embed-${book.id}`} onClick={() => props.onRetry(book, "embed")}>
								Retry search model
							</button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

// ─── the section (fetches + file pickers) ────────────────────────────────────

interface ImportReply {
	results?: Array<{ fileName: string; ok: boolean; error?: string }>;
	error?: string;
	needsPdf?: { expectedName: string; noteTitle: string };
	book?: LibraryBook;
}

export function LibrarySection() {
	const [listing, setListing] = useState<LibraryListing | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingPdf[]>([]);
	const [note, setNote] = useState<{ file: File; expectedName: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [ankiOrigin, setAnkiOrigin] = useState<AnkiOrigin | null>(null);
	const pdfInput = useRef<HTMLInputElement | null>(null);
	const noteInput = useRef<HTMLInputElement | null>(null);
	const notePdfInput = useRef<HTMLInputElement | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/library", { cache: "no-store" });
			if (!res.ok) throw new Error(`status ${res.status}`);
			setListing((await res.json()) as LibraryListing);
			setLoadError(null);
		} catch {
			setLoadError("The library couldn't be loaded — refresh to retry.");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Poll only while something is indexing.
	const indexing = listing?.books.some((b) => b.status === "indexing") ?? false;
	useEffect(() => {
		if (!indexing) return;
		const t = setInterval(() => void refresh(), 1000);
		return () => clearInterval(t);
	}, [indexing, refresh]);

	async function readReply(res: Response): Promise<ImportReply> {
		return (await res.json().catch(() => ({ error: `The server answered ${res.status}.` }))) as ImportReply;
	}

	async function importPdfs() {
		if (pending.length === 0 || busy) return;
		setBusy(true);
		setMessage(null);
		try {
			const form = new FormData();
			for (const p of pending) {
				form.append("files", p.file);
				form.append("mode", p.mode);
			}
			const reply = await readReply(await fetch("/api/library/import", { method: "POST", body: form }));
			const failed = (reply.results ?? []).filter((r) => !r.ok);
			setPending([]);
			setMessage(
				reply.error
					? reply.error
					: failed.length > 0
						? failed.map((r) => `${r.fileName}: ${r.error}`).join("\n")
						: "Imported — indexing has started.",
			);
		} catch (err) {
			setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
			void refresh();
		}
	}

	async function importNote(noteFile: File, pdf?: File) {
		setBusy(true);
		setMessage(null);
		try {
			const form = new FormData();
			form.append("note", noteFile);
			if (pdf) form.append("pdf", pdf);
			const res = await fetch("/api/library/slidescribe", { method: "POST", body: form });
			const reply = await readReply(res);
			if (res.status === 422 && reply.needsPdf) {
				setNote({ file: noteFile, expectedName: reply.needsPdf.expectedName });
			} else if (!res.ok) {
				setNote(null);
				setMessage(reply.error ?? "The note couldn't be imported.");
			} else {
				setNote(null);
				setMessage("Imported — indexing has started.");
			}
		} catch (err) {
			setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
			void refresh();
		}
	}

	async function act(book: LibraryBook, action: "reindex" | "embed") {
		await fetch(`/api/library/${book.id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action }),
		}).catch(() => undefined);
		void refresh();
	}

	async function remove(book: LibraryBook) {
		await fetch(`/api/library/${book.id}`, { method: "DELETE" }).catch(() => undefined);
		void refresh();
	}

	return (
		<>
			<input
				ref={pdfInput}
				type="file"
				accept="application/pdf,.pdf"
				multiple
				hidden
				data-testid="library-pdf-input"
				onChange={(e) => {
					const files = Array.from(e.target.files ?? []);
					e.target.value = "";
					setMessage(null);
					setPending((prev) => [...prev, ...splitPicked(files).pdfs.map((file) => ({ file, mode: "text" as const }))]);
				}}
			/>
			<input
				ref={noteInput}
				type="file"
				accept=".md,.markdown,text/markdown,application/pdf,.pdf"
				multiple
				hidden
				data-testid="library-note-input"
				onChange={(e) => {
					const { note: noteFile, pdfs } = splitPicked(Array.from(e.target.files ?? []));
					e.target.value = "";
					if (!noteFile) {
						setMessage("Pick the SlideScribe .md note (you can pick its PDF in the same step).");
						return;
					}
					void importNote(noteFile, pdfs[0]);
				}}
			/>
			<input
				ref={notePdfInput}
				type="file"
				accept="application/pdf,.pdf"
				hidden
				data-testid="library-note-pdf-input"
				onChange={(e) => {
					const pdf = e.target.files?.[0];
					e.target.value = "";
					if (pdf && note) void importNote(note.file, pdf);
				}}
			/>
			<LibraryView
				listing={listing}
				loadError={loadError}
				pending={pending}
				needsPdf={note ? { noteName: note.file.name, expectedName: note.expectedName } : null}
				busy={busy}
				message={message}
				onPickPdfs={() => pdfInput.current?.click()}
				onPickNote={() => noteInput.current?.click()}
				onPickNotePdf={() => notePdfInput.current?.click()}
				onCancelNote={() => setNote(null)}
				onModeChange={(index, mode) => setPending((prev) => prev.map((p, i) => (i === index ? { ...p, mode } : p)))}
				onDropPending={(index) => setPending((prev) => prev.filter((_, i) => i !== index))}
				onImport={() => void importPdfs()}
				onRemove={(book) => void remove(book)}
				onRetry={(book, action) => void act(book, action)}
				onMakeCards={(book, pages) => setAnkiOrigin({ kind: "library", bookId: book.id, pages })}
			/>
			<AnkiDialog origin={ankiOrigin} onClose={() => setAnkiOrigin(null)} />
		</>
	);
}
