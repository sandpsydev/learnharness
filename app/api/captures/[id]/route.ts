/**
 * PATCH  /api/captures/[id] {status: "open" | "done"} — mark done (or reopen).
 * DELETE /api/captures/[id] — remove a capture.
 */
import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

const CAPTURE_ID = /^cp_[a-z0-9]+_[a-f0-9]{8}$/;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!CAPTURE_ID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { status?: unknown } | null;
	if (body?.status !== "open" && body?.status !== "done") {
		return Response.json({ error: 'status must be "open" or "done"' }, { status: 400 });
	}
	const capture = stores.captureStore.update(id, { status: body.status });
	if (!capture) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ capture });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!CAPTURE_ID.test(id) || !stores.captureStore.remove(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}
