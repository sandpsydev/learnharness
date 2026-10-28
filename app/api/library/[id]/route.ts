/**
 * DELETE /api/library/[id] — remove a book (stops its indexing, deletes the
 * library's copy of the PDF and the index).
 * POST   /api/library/[id] — {action: "reindex" | "embed"}: index a failed or
 * interrupted book again, or build only its meaning index again (the local
 * search model couldn't be downloaded the first time).
 */
import { library, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^bk_[a-z0-9]+$/.test(id) || !library.remove(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^bk_[a-z0-9]+$/.test(id) || !stores.libraryStore.getBook(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "reindex" && body?.action !== "embed") {
		return Response.json({ error: 'action must be "reindex" or "embed"' }, { status: 400 });
	}
	const book = body.action === "reindex" ? library.reindex(id) : library.embed(id);
	return Response.json({ book });
}
