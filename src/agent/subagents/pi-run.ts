import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "../models.ts";
import { usageWasAdmitted } from "../subscription-request-cycle.ts";
import { providerEventObserver } from "../provider-events.ts";
import type { ModelRole } from "../../../config.ts";

/**
 * The shared sub-agent runner (docs/pi-engine-swap.md §6): one helper every
 * background agent (researcher, demo-builder, visual-maker, extractor,
 * auditor) runs on — a stateless pi Agent built per call, driven to
 * completion, with the seams the job runner and the money channel need.
 *
 * Error semantics mirror the old ToolLoopAgent.generate: provider/loop
 * failures THROW (pi encodes them in the stream; this helper surfaces
 * them), and an abort throws an AbortError so every existing
 * `signal.aborted` early-return keeps working unchanged.
 */

export interface SubagentRunOptions {
	/** The role whose engine (model + thinking level) this run uses. */
	role: ModelRole;
	/** Test seam: a scripted engine replaces the role's production one. */
	engine?: PiEngine;
	systemPrompt: string;
	/** Initial transcript (continuation semantics: ends user / toolResult). */
	messages?: AgentMessage[];
	/** Fresh-run prompt text (mutually exclusive with a continuation). */
	prompt?: string;
	/** Max model calls (the old stepCountIs safety net). */
	maxTurns: number;
	/** Abort mid-model-call (the real-kill semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	/** Activity line per tool execution (job record progress). */
	onToolStart?: (toolName: string, args: unknown) => void;
	/** Per completed assistant message (extraction's step log). */
	onAssistantMessage?: (message: AssistantMessage, step: number) => void;
	/** Extra stop rule (extractor: stop after a clean submit). */
	shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
	/** Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream
	 *  events append to data/debug/provider-events/<chatId>.jsonl (context
	 *  "job:<role>"). Absent or env-off → no observer. */
	chatId?: string;
	/** Opt-in step-limit rescue (researcher only). When the loop is stopped
	 *  by `maxTurns` while the model still wanted to call tools — so it never
	 *  wrote its final answer — make ONE more model call with no tools,
	 *  prompted by this instruction, so it must answer from what it already
	 *  gathered. Absent → the loop just ends at the cap, as before. The extra
	 *  call is the only one beyond `maxTurns`. */
	wrapUp?: { instruction: string };
}

export interface SubagentRunResult {
	/** The messages this run added (assistant + tool results). */
	newMessages: AgentMessage[];
	/** The final assistant text (the deliverable). */
	text: string;
	/** True when `text` came from the tool-less wrap-up call (the loop hit
	 *  its step limit before the model wrote its own final answer). */
	wrappedUp: boolean;
}

export function subagentEngine(role: ModelRole, override?: PiEngine): PiEngine {
	// BYOK (owner, 2026-09-22): no factory pins — the override is the only
	// real path (the runner injects settings-resolved engines); a missed
	// injection hits the honest thrower in models.ts instead of a guess.
	return override ?? piEngineFor(role);
}

export async function runSubagent(tools: AgentTool<any, any>[], opts: SubagentRunOptions): Promise<SubagentRunResult> {
	const engine = subagentEngine(opts.role, opts.engine);
	let turns = 0;
	// Set when the maxTurns cap (not shouldStop, not a natural finish) ended
	// the loop on a message that still carried tool calls.
	let cappedMidWork = false;
	// One unsaved conversation per invocation, stable through every turn
	// (the wrap-up call reuses it so a Claude Code process held for the
	// loop's last tool calls is recognised — and retired — by that call).
	const sessionId = randomUUID();
	// Debug recorder (owner, 2026-10-04): raw provider events per job run.
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, `job:${opts.role}`) : undefined;
	const buildAgent = (agentTools: AgentTool<any, any>[], messages: AgentMessage[], finishTurn: AgentOptions["finishTurn"]) =>
		new Agent({
			identity: APP_IDENTITY,
			sessionId,
			initialState: {
				systemPrompt: opts.systemPrompt,
				model: engine.model,
				thinkingLevel: engine.level,
				tools: agentTools,
				messages,
			},
			streamFn: engine.streamFn,
			...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
			finishTurn,
		});
	// 0.87.1: shouldStopAfterTurn → finishTurn (same call point; "end"
	// exits before the steering poll, exactly the old boolean-true).
	const agent = buildAgent(tools, opts.messages ?? [], (turn) => {
		turns++;
		if (opts.shouldStop?.(turn.message, turn.toolResults) === true) return { action: "end" };
		if (turns >= opts.maxTurns) {
			cappedMidWork = turn.message.stopReason === "toolUse" && turn.message.content.some((c) => c.type === "toolCall");
			return { action: "end" };
		}
		return undefined;
	});

	let running = agent;
	const onAbort = () => running.abort();
	opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

	const before = opts.messages?.length ?? 0;
	let step = 0;
	let errorMessage: string | undefined;
	let aborted = false;

	const listen = (target: Agent) => target.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "message_end":
				if ((event.message as { role?: string }).role === "assistant") {
					const m = event.message as AssistantMessage;
					if (m.stopReason === "aborted") {
						// The call was cancelled — no completed step, no billed
						// usage (the abort path asserts zero steps).
						aborted = true;
						break;
					}
					if (!usageWasAdmitted(m.usage)) { if (m.stopReason === "error") errorMessage = m.errorMessage; break; }
					step++;
					opts.onUsage?.(m.usage);
					opts.onAssistantMessage?.(m, step);
					if (m.stopReason === "error") errorMessage = m.errorMessage;
				}
				break;
			case "tool_execution_start":
				opts.onToolStart?.(event.toolName, event.args);
				break;
		}
	});
	const settle = () => {
		if (aborted || opts.abortSignal?.aborted) {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		}
		if (errorMessage !== undefined) throw new Error(errorMessage);
	};
	// 0.87.1: drop the seeded leading SystemMessage (transcript rework —
	// see ui-stream's settleWith) before slicing past the input count, or
	// the seed displaces the slice and the last INPUT message leaks in.
	const added = (from: Agent) =>
		from.state.messages.filter((m) => (m as { role?: string }).role !== "system").slice(before);
	const finalText = (messages: AgentMessage[]) => {
		const assistants = messages.filter((m) => (m as { role?: string }).role === "assistant") as AssistantMessage[];
		const last = assistants[assistants.length - 1];
		return last
			? last.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
			: "";
	};

	let wrapMessages: AgentMessage[] | undefined;
	try {
		listen(agent);
		if (opts.prompt !== undefined) await agent.prompt({
			role: "user",
			content: opts.prompt,
			timestamp: Date.now(),
		});
		else await agent.continue();
		settle();

		if (opts.wrapUp && cappedMidWork) {
			// Step limit hit mid-research: one last call with NO tools. A fresh
			// agent with an empty toolset (the transcript's tool declarations
			// live on its leading system message, which a continuation would
			// keep), the same transcript, and the wrap-up instruction as the
			// new user turn — so both the pi engines and the Claude Code CLI
			// engine see a tool-less request.
			const history = agent.state.messages.filter((m) => (m as { role?: string }).role !== "system");
			const wrap = buildAgent([], history, () => ({ action: "end" }));
			running = wrap;
			listen(wrap);
			await wrap.prompt({ role: "user", content: opts.wrapUp.instruction, timestamp: Date.now() });
			settle();
			wrapMessages = added(wrap);
		}
	} finally {
		opts.abortSignal?.removeEventListener("abort", onAbort);
	}

	const newMessages = added(agent);
	const wrapText = wrapMessages ? finalText(wrapMessages.slice(newMessages.length)) : "";
	// A wrap-up that wrote nothing leaves today's outcome untouched.
	if (wrapMessages && wrapText.trim()) return { newMessages: wrapMessages, text: wrapText, wrappedUp: true };
	return { newMessages, text: finalText(newMessages), wrappedUp: false };
}
