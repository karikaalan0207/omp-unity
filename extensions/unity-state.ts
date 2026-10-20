import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type TimelineItem = {
	at: number;
	label: string;
	state: "done" | "current" | "next";
};

type CockpitState = {
	title: string;
	goal: string;
	phase: string;
	now: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	timeline: TimelineItem[];
	todos: { done: number; total: number; next?: string; items: { label: string; done: boolean }[] };
	insights: {
		aim?: string;
		alignment?: { verdict: "aligned" | "drifting" | "off-track" | "unknown"; why?: string };
		risk?: string;
		next: string[];
		summary?: string;
		updated?: number;
	};
	running: boolean;
	turns: number;
	updated: number;
};

type AgentState = {
	id: string;
	name: string;
	parentId?: string;
	status: "running" | "idle" | "done";
	activity: string;
	since: number;
	updated: number;
};

const cockpitDir = process.env.OMP_COCKPIT_DIR;
const mainFile = cockpitDir ? join(cockpitDir, "main.json") : undefined;
const agentsDir = cockpitDir ? join(cockpitDir, "agents") : undefined;
const unityVault = process.env.UNITY_VAULT;
const unityItem = process.env.UNITY_ITEM;

// Best-effort: write the live omp session back into the Obsidian item.
function touchUnityItem(patch: Record<string, string>): void {
	if (!unityVault || !unityItem) return;
	try {
		const file = join(unityVault, "Unity", "items", `${unityItem.replace(/[^a-zA-Z0-9_.-]/g, "")}.md`);
		const text = readFileSync(file, "utf8");
		if (!text.startsWith("---")) return;
		const end = text.indexOf("\n---", 3);
		if (end === -1) return;
		const head = text
			.slice(text.indexOf("\n", 3) + 1, end)
			.split(/\r?\n/)
			.filter(Boolean);
		const body = text.slice(end + 4);
		for (const [key, value] of Object.entries({ ...patch, updated: new Date().toISOString() })) {
			if (!value) continue;
			const at = head.findIndex(line => line.startsWith(`${key}:`));
			const next = `${key}: ${value}`;
			if (at >= 0) head[at] = next;
			else head.push(next);
		}
		writeFileSync(file, `---\n${head.join("\n")}\n---${body}`, "utf8");
	} catch {
		// Item tracking is best-effort.
	}
}

function writeJson(file: string, value: unknown): void {
	try {
		writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
	} catch {
		// Cockpit state is best-effort; a failed write must not affect the session.
	}
}

function summarizeArgs(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	// Tool args are an object at the dispatcher boundary; read only string fields.
	const record = args as Record<string, unknown>;
	const preferred =
		toolName === "bash"
			? "command"
			: toolName === "read" || toolName === "edit" || toolName === "write"
				? "path"
				: toolName === "grep" || toolName === "glob"
					? "pattern"
					: toolName === "task"
						? "description"
						: toolName === "todo"
							? "action"
							: undefined;

	let value = preferred ? record[preferred] : undefined;
	if (typeof value !== "string") {
		for (const candidate of Object.values(record)) {
			if (typeof candidate === "string") {
				value = candidate;
				break;
			}
		}
	}
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, 90);
}

function parseTodos(content: readonly { type: string; text?: string }[]): {
	done: number;
	total: number;
	next?: string;
	items: { label: string; done: boolean }[];
} | undefined {
	const text = content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n");
	if (!text) return undefined;

	const items: { label: string; done: boolean }[] = [];
	for (const line of text.split("\n")) {
		const checked = line.match(/^\s*[-*]\s*\[([xX ])\]\s*(.+)$/);
		if (checked) {
			items.push({ label: checked[2].trim(), done: checked[1].toLowerCase() === "x" });
		}
	}
	if (items.length > 0) {
		const done = items.filter(item => item.done).length;
		const next = items.find(item => !item.done)?.label;
		return { done, total: items.length, next, items };
	}

	const summary = text.match(/(\d+)\s*\/\s*(\d+)/);
	if (summary) return { done: Number(summary[1]), total: Number(summary[2]), items: [] };
	return undefined;
}

export default function cockpitState(pi: ExtensionAPI): void {
	if (!mainFile || !agentsDir) return;
	mkdirSync(agentsDir, { recursive: true });

	const state: CockpitState = {
		title: "session",
		goal: "",
		phase: "starting",
		now: "idle",
		sessionId: "",
		cwd: "",
		timeline: [],
		todos: { done: 0, total: 0, items: [] },
		insights: { next: [] },
		running: false,
		turns: 0,
		updated: Date.now(),
	};

	const writeMain = (): void => {
		state.title = pi.getSessionName() ?? state.title;
		state.updated = Date.now();
		writeJson(mainFile, state);
	};

	let insightBusy = false;
	let lastInsightTurn = 0;

	const maybeInsights = (ctx: ExtensionContext): void => {
		if (insightBusy) return;
		// First insight after the first answer, then every three turns.
		if (lastInsightTurn > 0 && state.turns - lastInsightTurn < 3) return;
		lastInsightTurn = state.turns;
		if (!ctx.runEphemeralTurn) {
			state.insights.aim = state.insights.aim || state.goal || state.title;
			state.insights.alignment = { verdict: "unknown", why: "insight turn unavailable" };
			state.insights.risk = state.todos.next ? `Next: ${state.todos.next}` : "No explicit next step.";
			state.insights.next = state.todos.next ? [state.todos.next] : ["Define the next concrete step."];
			state.insights.updated = Date.now();
			writeMain();
			return;
		}
		insightBusy = true;
		const context = [
			`Aim: ${state.insights.aim || state.goal || state.title}`,
			`Goal: ${state.goal || state.title}`,
			`Phase: ${state.phase}`,
			`Now: ${state.now}`,
			`Turns: ${state.turns}`,
			`Todos: ${state.todos.done}/${state.todos.total}${state.todos.next ? ` next=${state.todos.next}` : ""}`,
			"Timeline:",
			...state.timeline.slice(-12).map(item => `- [${item.state}] ${item.label}`),
		].join("\n");

		void ctx
			.runEphemeralTurn({
				promptText: [
					"You are the user's chief of staff. The aim is the north star: what the user is trying to achieve.",
					"Judge whether the current action (Now and the latest timeline item) moves toward that aim, and how.",
					"Return only strict JSON with keys: aim (string), alignment (object: verdict aligned|drifting|off-track, why string), phase (string), now (string), risk (string), next (string array, max 3).",
					"aim: one stable sentence; keep it unless the session clearly redefines the goal.",
					"alignment.why: name the link or the drift in concrete terms.",
					"next: nudging actions that move the current work back onto the aim.",
					"Each string must be under 14 words. No markdown, no code fences.",
					context,
				].join("\n"),
				tools: false,
				maxTokens: 400,
			})
			.then(result => {
				const block = result.replyText.match(/\{[\s\S]*\}/)?.[0];
				if (!block) return;
				const parsed: unknown = JSON.parse(block);
				if (typeof parsed !== "object" || parsed === null) return;
				const record = parsed as Record<string, unknown>;
				if (typeof record.phase === "string") state.phase = record.phase.trim().slice(0, 120);
				if (typeof record.now === "string") state.now = record.now.trim().slice(0, 120);
				if (typeof record.aim === "string" && record.aim.trim()) {
					state.insights.aim = record.aim.trim().slice(0, 140);
				}
				const alignment = record.alignment;
				if (typeof alignment === "object" && alignment !== null) {
					const pair = alignment as Record<string, unknown>;
					const raw = typeof pair.verdict === "string" ? pair.verdict.trim().toLowerCase() : "";
					const verdict: "aligned" | "drifting" | "off-track" | "unknown" =
						raw === "aligned" || raw === "drifting" || raw === "off-track" ? raw : "unknown";
					const why = typeof pair.why === "string" ? pair.why.trim().slice(0, 160) : "";
					state.insights.alignment = why ? { verdict, why } : { verdict };
				}
				if (typeof record.risk === "string") state.insights.risk = record.risk.trim().slice(0, 160);
				if (Array.isArray(record.next)) {
					state.insights.next = record.next
						.filter((item): item is string => typeof item === "string")
						.map(item => item.trim().slice(0, 120))
						.slice(0, 3);
				}
				if (!state.insights.aim) state.insights.aim = state.goal || state.title;
				state.insights.updated = Date.now();
				writeMain();
			})
			.catch(() => {})
			.finally(() => {
				insightBusy = false;
			});
	};

	let subState: AgentState | undefined;
	const writeSub = (): void => {
		if (!subState) return;
		subState.updated = Date.now();
		const file = join(agentsDir, `${subState.id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
		writeJson(file, subState);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			subState = {
				id: ctx.agent.id,
				name: ctx.agent.name,
				parentId: ctx.agent.parentId,
				status: "running",
				activity: "starting",
				since: Date.now(),
				updated: Date.now(),
			};
			writeSub();
			return;
		}
		state.sessionId = ctx.sessionManager.getSessionId();
		state.sessionFile = ctx.sessionManager.getSessionFile();
		state.cwd = ctx.cwd;
		state.title = pi.getSessionName() ?? "session";
		state.running = false;
		state.now = "idle";
		touchUnityItem({
			status: "active",
			session: ctx.sessionManager.getSessionFile() || "",
		});
		writeMain();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.status = "done";
				subState.activity = "done";
				writeSub();
			}
			return;
		}
		state.running = false;
		state.now = "idle";
		writeMain();
	});

	pi.on("input", (event, ctx) => {
		const text = event.text.replace(/\s+/g, " ").trim();
		if (!text) return;
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.activity = `steering: ${text.slice(0, 80)}`;
				subState.since = Date.now();
				writeSub();
			}
			return;
		}
		const last = state.timeline[state.timeline.length - 1];
		if (last?.state === "current") last.state = "done";
		state.timeline.push({ at: Date.now(), label: text.slice(0, 120), state: "current" });
		if (state.timeline.length > 40) state.timeline.shift();
		if (!state.goal) state.goal = text.slice(0, 120);
		state.now = "thinking";
		if (!state.insights.updated) state.phase = "working";
		writeMain();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.status = "running";
				subState.activity = "thinking";
				subState.since = Date.now();
				writeSub();
			}
			return;
		}
		state.running = true;
		state.now = "working";
		writeMain();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.status = "idle";
				subState.activity = "idle";
				writeSub();
			}
			return;
		}
		state.running = false;
		state.now = "idle";
		if (!state.insights.updated) state.phase = "idle";
		writeMain();
		maybeInsights(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.status = "running";
				subState.activity = "thinking";
				subState.since = Date.now();
				writeSub();
			}
			return;
		}
		state.turns += 1;
		writeMain();
	});

	pi.on("message_end", (_event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		writeMain();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const detail = event.intent?.trim() || summarizeArgs(event.toolName, event.args);
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.status = "running";
				subState.activity = `${event.toolName}${detail ? ` · ${detail}` : ""}`;
				subState.since = Date.now();
				writeSub();
			}
			return;
		}
		state.now = `${event.toolName}${detail ? ` · ${detail}` : ""}`;
		writeMain();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			if (subState) {
				subState.activity = event.isError ? "tool failed" : "thinking";
				writeSub();
			}
			return;
		}
		state.now = state.running ? "working" : "idle";
		writeMain();
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind === "sub" || event.toolName !== "todo") return;
		const todos = parseTodos(event.content);
		if (todos) {
			state.todos = todos;
			writeMain();
		}
	});

	pi.on("before_subagent_spawn", event => {
		state.now = `spawning ${event.agent || "agent"}`;
		writeMain();
	});
}
