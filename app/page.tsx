import { Home } from "@/components/home";
import { PhoneHome } from "@/components/phone-home";
import { ResponsiveSwitch } from "@/components/phone";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default function HomePage() {
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin.
	const record = readSettingsRecord();
	// GRAPH RENDERING (owner, 2026-10-06): off = the home's main view is
	// the chains view. Resolved through the one core resolver (missing
	// section / absent key → factory default on); re-read per navigation.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	const configured = slotsConfigured(record?.models);
	// Pocket mode (Phase 8): below 640px the home is the phone's own screen;
	// from 640px up it is exactly the graph home it always was.
	return (
		<ResponsiveSwitch
			desktop={<Home initialConfigured={configured} rendering={rendering} />}
			phone={<PhoneHome initialConfigured={configured} />}
		/>
	);
}
