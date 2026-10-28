/**
 * GET /api/verify/pairing — what the learner needs to connect the browser
 * extension: the local API's address and the pairing token (shown in
 * Settings → Browser extension). This route sits behind the same desktop
 * guard as every /api route (proxy.ts); the extension's own API
 * (src/server/verify-api.ts) is a separate loopback listener.
 */

import { extensionLastSeen, pairingToken, verifyApiHandle } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const handle = verifyApiHandle();
	return Response.json(
		{
			running: handle !== null,
			port: handle?.port ?? null,
			address: handle ? `http://127.0.0.1:${handle.port}` : null,
			token: pairingToken(),
			extensionLastSeen: extensionLastSeen(),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
