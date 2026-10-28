/**
 * One Anki draft.
 *
 * GET    → {draft}                       (404 unknown)
 * PUT    → body {cards: [...]}           replaces the draft's cards with the panel's edits
 * DELETE → discards the draft (stops its run if it is still drafting)
 */
import { anki } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
	const { id } = await ctx.params;
	const draft = anki.get(id);
	if (!draft) return Response.json({ error: "No such draft.", code: "not_found" }, { status: 404 });
	return Response.json({ draft });
}

export async function PUT(request: Request, ctx: Ctx) {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const out = anki.saveCards(id, body);
	if (!out.ok) return Response.json({ error: out.error, code: out.code }, { status: out.status });
	return Response.json({ draft: out.draft });
}

export async function DELETE(_req: Request, ctx: Ctx) {
	const { id } = await ctx.params;
	if (!anki.discard(id)) return Response.json({ error: "No such draft.", code: "not_found" }, { status: 404 });
	return Response.json({ ok: true });
}
