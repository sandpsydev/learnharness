/**
 * Capture inbox (medical fork, Phase 8 "Pocket mode"): short text notes the
 * learner jots down on the ward — a question or a topic — to teach from later
 * at the Mac. Text only (owner decision: no photo or file attachments, for
 * patient privacy), so a record has no field for anything but words.
 */

export type CaptureStatus = "open" | "done";

export interface CaptureItem {
	id: string;
	/** The question or topic, as typed. Plain text. */
	text: string;
	status: CaptureStatus;
	createdAt: string;
	updatedAt: string;
	/** The teaching session started from this capture, once there is one. */
	chatId?: string;
}

/** Longest capture the store accepts (characters). A question or topic, not an essay. */
export const MAX_CAPTURE_CHARS = 2000;
