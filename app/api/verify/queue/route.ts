/**
 * GET /api/verify/queue — the Expert AI questions that are waiting, for the
 * phone's VIEW-ONLY list (Pocket mode, Phase 8). Read only on purpose: this
 * file exports no way to ask, answer or dismiss anything. Asking Expert AI
 * stays at the Mac, through the Chrome extension, on the extension's own
 * loopback API. Like every /api route it sits behind the desktop guard
 * (proxy.ts).
 */

import { queueSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ queue: queueSnapshot() }, { headers: { "Cache-Control": "no-store" } });
}
