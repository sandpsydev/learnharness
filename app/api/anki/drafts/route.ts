/**
 * Anki card drafts (docs/medical-spec.md Phase 5).
 *
 * POST /api/anki/drafts   body {origin: {kind:"session",chatId} | {kind:"nodes",nodeIds} | {kind:"library",ref}}
 *   Starts drafting cards in the background and answers at once with the
 *   draft ({status:"generating"}); poll GET /api/anki/drafts/[id]. Asked again
 *   for an origin that is still being drafted, it answers that draft.
 * GET  /api/anki/drafts?originKey=…   the drafts (newest first), optionally of one origin.
 */
import { anki } from "@/src/server";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		const origin = typeof body === "object" && body !== null ? (body as { origin?: unknown }).origin : undefined;
		const out = await anki.start(origin);
		if (!out.ok) return Response.json({ error: out.error, code: out.code }, { status: out.status });
		return Response.json({ draft: out.draft, reused: out.reused });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		console.error("[anki] start failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}

export async function GET(request: Request) {
	const originKey = new URL(request.url).searchParams.get("originKey") ?? undefined;
	return Response.json({ drafts: anki.list(originKey) });
}
