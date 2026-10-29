import { QuickPractice } from "@/components/phone-practice";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

/** Quick practice — the phone's short A–E round (Pocket mode, Phase 8). */
export default function Page() {
	return <QuickPractice initialConfigured={slotsConfigured(readSettingsRecord()?.models)} />;
}
