// Unity status board: focus, items, projects. Obsidian-backed.
// Keys: j/k or arrows move, space/s cycle status, enter opens the item,
// f sets focus, n/p create item/project, [ ] switch workspace tabs, q quits.

import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import {
	createItem,
	createProject,
	getFocus,
	listItems,
	listProjects,
	setFocus,
	updateItem,
} from "../lib/unity-store.mjs";

const vault = process.argv[2];
const launcher = process.argv[3];
if (!vault) {
	console.error("usage: node unity-board.mjs <vault> [launcher]");
	process.exit(1);
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ACCENT = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const GLYPH = { todo: "○", active: "▶", blocked: "!", done: "✓" };
const COLOR = { todo: DIM, active: GREEN, blocked: RED, done: DIM };
const NEXT = { todo: "active", active: "done", done: "blocked", blocked: "todo" };

let selected = 0;
let selectedId = "";
let scroll = 0;
let mode = "list";
let input = "";
let message = "";

function fit(value, columns) {
	const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
	const chars = [...plain];
	if (chars.length <= columns) return plain + " ".repeat(columns - chars.length);
	return chars.slice(0, Math.max(0, columns - 1)).join("") + "…";
}

function line(value, columns, color = "") {
	return color + fit(value, columns) + RESET;
}

function readState() {
	try {
		return { items: listItems(vault), projects: listProjects(vault), focus: getFocus(vault) };
	} catch (error) {
		message = String(error?.message || error);
		return { items: [], projects: [], focus: "" };
	}
}

function render() {
	const columns = Math.max(24, process.stdout.columns || 60);
	const rows = Math.max(10, process.stdout.rows || 20);
	const { items, projects, focus } = readState();
	if (selectedId) {
		const at = items.findIndex(item => item.id === selectedId);
		if (at >= 0) selected = at;
	}
	selected = Math.min(Math.max(0, selected), Math.max(0, items.length - 1));
	selectedId = items[selected]?.id || "";
	const focusItem = items.find(item => item.id === focus);

	const listRows = Math.max(3, rows - 9 - Math.min(projects.length, 3));
	if (selected < scroll) scroll = selected;
	if (selected >= scroll + listRows) scroll = selected - listRows + 1;
	const visible = items.slice(scroll, scroll + listRows);

	const output = [
		line(`UNITY  ${basename(vault)}`, columns, BOLD + ACCENT),
		line(`FOCUS  ${focusItem ? `[${focusItem.status}] ${focusItem.title}` : "— (f to set)"}`, columns, focusItem ? "" : DIM),
		line("─".repeat(columns), columns, DIM),
		line(`ITEMS  ${items.length}`, columns, BOLD),
	];
	if (visible.length === 0) {
		output.push(line("  no items yet", columns, DIM));
	} else {
		for (let index = 0; index < visible.length; index += 1) {
			const item = visible[index];
			const cursor = scroll + index === selected ? "▶" : " ";
			const mark = GLYPH[item.status] || "○";
			const suffix = item.project ? `  ${item.project}` : "";
			output.push(line(`${cursor} ${mark} ${item.title}${suffix}`, columns, COLOR[item.status] || ""));
		}
	}

	output.push(line("─".repeat(columns), columns, DIM));
	output.push(line(`PROJECTS  ${projects.length}`, columns, BOLD));
	for (const project of projects.slice(0, 3)) {
		output.push(line(`  ${project.title}  ${project.done}/${project.total}`, columns, DIM));
	}
	if (projects.length === 0) output.push(line("  none", columns, DIM));

	output.push(line("─".repeat(columns), columns, DIM));
	output.push(
		line(
			mode === "input"
				? `> ${mode === "item" ? "new item" : "new project"}: ${input}`
				: message || "n item · p project · space status · enter open · f focus · [ ] tabs · q quit",
			columns,
			mode === "input" ? ACCENT : DIM,
		),
	);

	while (output.length < rows) output.push("".padEnd(columns));
	process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
}

function selectedItem(items = listItems(vault)) {
	return items[selected];
}

function submit(kind) {
	const value = input.trim();
	input = "";
	mode = "list";
	if (!value) return;
	try {
		if (kind === "item") {
			const project = selectedItem()?.project || "";
			const item = createItem(vault, { title: value, project });
			selectedId = item.id;
			message = `created ${item.id}`;
		} else {
			const project = createProject(vault, { title: value });
			message = `created ${project.id}`;
		}
	} catch (error) {
		message = String(error?.message || error);
	}
}

function switchWindow(offset) {
	if (!process.env.TMUX) return;
	spawnSync("tmux", ["select-window", "-t", offset > 0 ? ":+" : ":-"], { stdio: "ignore" });
}

function exit() {
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	process.exit(0);
}

function handleKey(key) {
	if (mode !== "list") {
		const kind = mode;
		if (key === "\r" || key === "\n") {
			submit(kind);
			return;
		}
		if (key === "\x7f") {
			input = input.slice(0, -1);
			return;
		}
		if (key === "\x1b") {
			mode = "list";
			input = "";
			return;
		}
		if (key.length === 1 && key >= " ") input += key;
		return;
	}

	switch (key) {
		case "q":
		case "\x03":
			exit();
			break;
		case "\x1b[A":
		case "k":
			selected = Math.max(0, selected - 1);
			break;
		case "\x1b[B":
		case "j":
			selected += 1;
			break;
		case " ":
		case "s": {
			const item = selectedItem();
			if (item) {
				const next = NEXT[item.status] || "todo";
				try {
					updateItem(vault, item.id, { status: next });
					message = `${item.id} → ${next}`;
				} catch (error) {
					message = String(error?.message || error);
				}
			}
			break;
		}
		case "f": {
			const item = selectedItem();
			if (item) {
				try {
					setFocus(vault, item.id);
					message = `focus → ${item.title}`;
				} catch (error) {
					message = String(error?.message || error);
				}
			}
			break;
		}
		case "\r":
		case "\n": {
			const item = selectedItem();
			if (item && launcher) {
				spawn("/bin/zsh", [launcher, "--item", item.id], { detached: true, stdio: "ignore" }).unref();
				message = `opened ${item.title}`;
			}
			break;
		}
		case "n":
			mode = "item";
			input = "";
			break;
		case "p":
			mode = "project";
			input = "";
			break;
		case "[":
			switchWindow(-1);
			break;
		case "]":
			switchWindow(1);
			break;
		default:
			break;
	}
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", chunk => {
	const text = chunk.toString("utf8");
	for (let index = 0; index < text.length; ) {
		const rest = text.slice(index);
		if (rest.startsWith("\x1b[A")) {
			handleKey("\x1b[A");
			index += 3;
		} else if (rest.startsWith("\x1b[B")) {
			handleKey("\x1b[B");
			index += 3;
		} else {
			handleKey(text[index]);
			index += 1;
		}
	}
});

process.stdout.on("resize", render);
process.on("SIGINT", exit);
process.on("SIGTERM", exit);

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
render();
setInterval(render, 500);
