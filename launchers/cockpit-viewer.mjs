import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const dir = process.argv[2];
const launcher = process.argv[3];
if (!dir) {
	console.error("usage: node cockpit-viewer.mjs <state-dir>");
	process.exit(1);
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ACCENT = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

let scroll = 0;
let state = readState();

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function readState() {
	const main = readJson(join(dir, "main.json")) ?? {
		title: "waiting for omp",
		goal: "",
		phase: "starting",
		now: "idle",
		timeline: [],
		todos: { done: 0, total: 0, items: [] },
		insights: { aim: "", alignment: { verdict: "unknown" }, next: [] },
		turns: 0,
		updated: Date.now(),
	};

	const agents = [];
	try {
		for (const name of readdirSync(join(dir, "agents"))) {
			if (!name.endsWith(".json")) continue;
			const agent = readJson(join(dir, "agents", name));
			if (agent) agents.push(agent);
		}
	} catch {
		// no agents yet
	}

	agents.sort((a, b) => {
		const rank = value => (value.status === "running" ? 0 : value.status === "idle" ? 1 : 2);
		return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
	});

	return { main, agents };
}

function width(value) {
	return [...value.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function fit(value, columns) {
	const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
	const chars = [...plain];
	if (chars.length <= columns) return plain + " ".repeat(columns - chars.length);
	return chars.slice(0, Math.max(0, columns - 1)).join("") + "…";
}

function line(value, columns, color = "") {
	return color + fit(value, columns) + RESET;
}

function age(seconds) {
	if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h`;
}

function time(at) {
	return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}

function render() {
	const columns = Math.max(24, process.stdout.columns || 100);
	const rows = Math.max(12, process.stdout.rows || 32);
	const main = state.main;
	const timeline = Array.isArray(main.timeline) ? main.timeline : [];
	const agentRows = Math.min(4, Math.max(0, state.agents.length));
	const fixed = 14 + agentRows;
	const timelineRows = Math.max(3, rows - fixed);
	const maxScroll = Math.max(0, timeline.length - timelineRows);
	scroll = Math.min(scroll, maxScroll);
	const end = timeline.length - scroll;
	const start = Math.max(0, end - timelineRows);
	const visible = timeline.slice(start, end);

	const output = [];
	output.push(line(`COCKPIT  ${main.title}`, columns, BOLD + ACCENT));
	output.push(line(`GOAL     ${main.goal || "—"}`, columns, DIM));
	output.push(line(`PHASE    ${main.phase || "—"}   ${main.now ? `NOW  ${main.now}` : ""}`, columns));
	output.push(line("─".repeat(columns), columns, DIM));

	const insight = main.insights ?? {};
	const aim = insight.aim || main.goal || "—";
	const verdict = insight.alignment?.verdict || "unknown";
	const why = insight.alignment?.why || "";
	const alignColor =
		verdict === "aligned" ? GREEN : verdict === "drifting" ? YELLOW : verdict === "off-track" ? RED : DIM;
	output.push(line("INSIGHT", columns, BOLD));
	output.push(line(`  aim    ${aim}`, columns, ACCENT));
	output.push(line(`  align  ${verdict}${why ? ` — ${why}` : ""}`, columns, alignColor));
	output.push(line(`  risk   ${insight.risk || "—"}`, columns, insight.risk ? RED : DIM));
	output.push(line(`  next   ${insight.next?.length ? insight.next.map((item, index) => `${index + 1}) ${item}`).join("  ") : "—"}`, columns, insight.next?.length ? ACCENT : DIM));

	output.push(line("─".repeat(columns), columns, DIM));
	output.push(line(`TIMELINE  ${timeline.length ? `${start + 1}-${end}/${timeline.length}` : "waiting for first prompt"}`, columns, BOLD));
	if (visible.length === 0) {
		output.push(line("  no work items yet", columns, DIM));
	} else {
		for (const item of visible) {
			const mark = item.state === "done" ? "✓" : item.state === "current" ? "▶" : "○";
			const color = item.state === "current" ? GREEN : item.state === "done" ? DIM : YELLOW;
			output.push(line(`  ${mark} ${time(item.at)}  ${item.label}`, columns, color));
		}
	}

	output.push(line("─".repeat(columns), columns, DIM));
	output.push(line(`AGENTS  ${state.agents.length ? `${state.agents.length} known` : "none"}`, columns, BOLD));
	if (state.agents.length === 0) {
		output.push(line("  no background agents", columns, DIM));
	} else {
		for (const agent of state.agents.slice(0, 4)) {
			const mark = agent.status === "running" ? "●" : "○";
			const color = agent.status === "running" ? GREEN : agent.status === "idle" ? YELLOW : DIM;
			const elapsed = age((Date.now() - Number(agent.since ?? Date.now())) / 1000);
			output.push(line(`  ${mark} ${agent.name}  ${agent.activity}  ${elapsed}`, columns, color));
		}
	}

	output.push(line("↑↓ scroll · n tab · f fork · Tab pane · q quit", columns, DIM));

	while (output.length < rows) output.push(" ".repeat(columns));
	process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
}

function spawnLauncher(args) {
	if (!launcher) return;
	if (process.platform === "win32") {
		spawn("cmd.exe", ["/c", "start", "", launcher, ...args], { detached: true, stdio: "ignore" }).unref();
		return;
	}
	spawn("/bin/zsh", [launcher, ...args], { detached: true, stdio: "ignore" }).unref();
}

function cleanup() {
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	process.exit(0);
}

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
process.stdin.setRawMode?.(true);
process.stdin.resume();

process.stdin.on("data", chunk => {
	let key = chunk.toString();
	if (key === "\x1bOA") key = "\x1b[A";
	if (key === "\x1bOB") key = "\x1b[B";
	if (key === "\x1bOC") key = "\x1b[C";
	if (key === "\x1bOD") key = "\x1b[D";
	if (key === "\t") {
		if (process.env.TMUX) spawn("tmux", ["select-pane", "-t", ":.+"], { stdio: "ignore" }).unref();
		return;
	}
	if (key === "n") {
		spawnLauncher([]);
		return;
	}
	if (key === "f" && state.main.sessionFile) {
		spawnLauncher(["--fork", state.main.sessionFile]);
		return;
	}
	if (key === "q" || key === "\u0003") {
		cleanup();
		return;
	}
	if (key === "\x1b[A") {
		scroll = Math.min(scroll + 1, Math.max(0, state.main.timeline.length - 1));
		render();
		return;
	}
	if (key === "\x1b[B") {
		scroll = Math.max(0, scroll - 1);
		render();
		return;
	}
	if (key === "\x1b[5~") {
		scroll = Math.min(scroll + 5, Math.max(0, state.main.timeline.length - 1));
		render();
		return;
	}
	if (key === "\x1b[6~") {
		scroll = Math.max(0, scroll - 5);
		render();
		return;
	}
	if (key === "\x1b[H") {
		scroll = Math.max(0, state.main.timeline.length - 1);
		render();
		return;
	}
	if (key === "\x1b[F") {
		scroll = 0;
		render();
	}
});

process.stdout.on("resize", render);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

setInterval(() => {
	state = readState();
	render();
}, 500);

render();
