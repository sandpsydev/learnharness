/**
 * Runs once when the server boots (Next's instrumentation hook). It starts
 * the loopback API the browser extension talks to — a separate listener on a
 * fixed local port, because the app's own server takes a random port in the
 * desktop build (see src/server/verify-api.ts for the why and the guard).
 */
export async function register() {
	// Node only (the edge runtime has no sockets), and never under tests,
	// which start their own listener on an ephemeral port.
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test") return;
	const { startVerifyApi } = await import("./src/server/verify-api.ts");
	await startVerifyApi();
	// The Obsidian copy (medical fork): watches the graph and keeps the vault in step.
	const { startObsidianSync } = await import("./src/server/obsidian.ts");
	startObsidianSync();
	// Placement (medical fork): keeps every fact placed in the outline, in the background.
	const { startPlacement } = await import("./src/server/placement.ts");
	startPlacement();
	// Drug facts (medical fork): one-time, resumable upgrade of existing drug facts to the pharmacology type.
	const { startPharmacologyBackfill } = await import("./src/server/pharmacology-backfill.ts");
	startPharmacologyBackfill();
}
