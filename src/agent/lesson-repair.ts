import { createAssistantMessageEventStream, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { markUnadmittedUsage } from "./subscription-request-cycle.ts";
import { LESSON_REPAIR_FAILED_TEXT, MAX_LESSON_REPAIR_REQUESTS } from "./visible-teaching.ts";

/** Per invocation, not persisted: a refusal gets at most three repair requests.
 * Empty/thinking-only repairs must continue; exhaustion produces a visible retry
 * notice without another model call or a question. The last request's signal
 * also closes our own held Claude MCP process when we replace its continuation.
 */
export class LessonRepair {
	pending = false;
	private requests = 0;
	private previous: AbortController | undefined;

	reset(): void {
		this.pending = false;
		this.requests = 0;
	}

	wrap(streamFn: StreamFunction): StreamFunction {
		return (model, context, options) => {
			if (this.pending && this.requests >= MAX_LESSON_REPAIR_REQUESTS) {
				this.previous?.abort();
				this.pending = false;
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text", text: LESSON_REPAIR_FAILED_TEXT }], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				markUnadmittedUsage(message.usage);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: LESSON_REPAIR_FAILED_TEXT, partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: LESSON_REPAIR_FAILED_TEXT, partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			}
			if (this.pending) this.requests++;
			this.previous = new AbortController();
			const signal = options?.signal ? AbortSignal.any([options.signal, this.previous.signal]) : this.previous.signal;
			return streamFn(model, context, { ...options, signal });
		};
	}
}
