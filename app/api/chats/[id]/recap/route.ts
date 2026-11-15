/**
 * Session recap (medical fork): one Obsidian review note per teaching session.
 *
 * GET  /api/chats/:id/recap   what the Session recap button shows: the vault
 *   check, the run in progress (or its error), and the recap already written
 *   with where its note is and an obsidian:// link to open it.
 * POST /api/chats/:id/recap   one of
 *   { action: "write" }     write the recap, or rewrite it from the whole session
 *   { action: "stop" }      cancel the run in progress
 *   { action: "dismiss" }   clear a finished run's result
 * A run goes on in the background and answers at once; the button polls GET.
 * It only ever starts from a click: each recap is one model call. Config
 * refusals use the same 503 envelopes as the other model features.
 */
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";
import { getChat, recapService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ status: recapService.status(id) });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	try {
		switch (body?.action) {
			case "write": {
				const outcome = recapService.write(id);
				if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
				return Response.json({ status: outcome.status });
			}
			case "stop": {
				const outcome = recapService.stop(id);
				return Response.json({ status: outcome.ok ? outcome.status : recapService.status(id) });
			}
			case "dismiss":
				return Response.json({ status: recapService.clearResult(id) });
			default:
				return Response.json({ error: 'Body must be {"action":"write"|"stop"|"dismiss"}' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		console.error("[recap] failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
