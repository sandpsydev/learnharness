/**
 * The Obsidian copy (medical fork): where Settings reads and nudges it.
 *
 * GET  /api/obsidian   the status: the vault folder, whether the live copy is idle, waiting,
 *   syncing or stuck (and why), the last run's counts, and a suggested folder.
 * POST /api/obsidian   { action: "sync" } write the notes now instead of waiting for the next
 *   change — the same sync the live copy runs. The vault folder itself is set through
 *   PUT /api/settings/obsidian.
 */
import { obsidianSync } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ status: obsidianSync.status() });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "sync") return Response.json({ error: 'Body must be {"action":"sync"}' }, { status: 400 });
	return Response.json({ status: obsidianSync.run() });
}
