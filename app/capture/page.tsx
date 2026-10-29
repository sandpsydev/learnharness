import { CapturePage } from "@/components/capture-page";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

export default function Page() {
	return <CapturePage initialConfigured={slotsConfigured(readSettingsRecord()?.models)} />;
}
