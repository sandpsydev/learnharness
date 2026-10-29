/**
 * The capture inbox (Phase 8 Pocket mode): short text notes to teach from later.
 * GET  /api/captures?status=open|done — newest first; no status = all.
 * POST /api/captures {text} — save one. TEXT ONLY (owner decision: no photos
 *   or files, for patient privacy): the body must be JSON with exactly a
 *   `text` field; anything else is refused (see core/captures.ts).
 */
import { parseCaptureBody } from "@/src/core";
import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const status = new URL(req.url).searchParams.get("status");
	if (status !== null && status !== "open" && status !== "done") {
		return Response.json({ error: 'status must be "open" or "done"' }, { status: 400 });
	}
	return Response.json({ captures: stores.captureStore.list(status ?? undefined) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		return Response.json({ error: "Captures are text only — send JSON." }, { status: 415 });
	}
	const parsed = parseCaptureBody(await req.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return Response.json({ capture: stores.captureStore.add(parsed.text) }, { status: 201 });
}
