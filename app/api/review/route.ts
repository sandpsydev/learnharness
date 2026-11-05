/**
 * Review mode (medical fork): illness scripts written into the Obsidian vault.
 *
 * GET  /api/review   the panel's state: the scripts written (each up to date or
 *   out of date, with why), the illness list's age, the vault check, and the
 *   current or last run's progress.
 * POST /api/review   one of
 *   { action: "write", illness: "acute pancreatitis" }   write (or refresh) one script
 *   { action: "write-all" }   write a script for every illness in the graph, one at a
 *                             time, skipping those already up to date
 *   { action: "stop" }        stop after cancelling the script in progress
 *   { action: "dismiss" }     clear a finished run's result
 * A run goes on in the background and answers at once; the panel polls GET for
 * progress. Config refusals use the same 503 envelopes as the other model features.
 */
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";
import { reviewService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ status: reviewService.status() });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { action?: unknown; illness?: unknown } | null;
	try {
		switch (body?.action) {
			case "write":
			case "write-all": {
				const outcome = body.action === "write" ? reviewService.writeOne(body.illness) : reviewService.writeAll();
				if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
				return Response.json({ status: outcome.status });
			}
			case "stop": {
				const outcome = reviewService.stop();
				return Response.json({ status: outcome.ok ? outcome.status : reviewService.status() });
			}
			case "dismiss":
				return Response.json({ status: reviewService.clearResult() });
			default:
				return Response.json({ error: 'Body must be {"action":"write"|"write-all"|"stop"|"dismiss"}' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		console.error("[review] failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
