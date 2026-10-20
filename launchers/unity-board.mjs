// Unity status board: create, rename, move, delete, and open items from the pane.
// Obsidian-backed. Keys: j/k move, space focus/stash, enter open,
// n item, p project, d delete, r rename, m move, v switch items/projects,
// [ ] tabs, Tab pane, ? help, q quit.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	createItem,
	createProject,
	deleteItem,
	deleteProject,
	listItems,
	listProjects,
	moveItem,
	renameItem,
	renameProject,
	updateItem,
} from "../lib/unity-store.mjs";

const vault = process.argv[2];
const launcher = process.argv[3];
const agentDir = launcher ? join(dirname(launcher), "..") : "";
let version = "";
if (agentDir) {
	try {
		version = readFileSync(join(agentDir, "VERSION"), "utf8").trim();
	} catch {
		version = "";
	}
}
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

const GLYPH = { focus: "▶", stash: "○" };
const COLOR = { focus: GREEN, stash: DIM };
const NEXT = { focus: "stash", stash: "focus" };

let view = "items";
let selected = 0;
let selectedId = "";
let projectIndex = 0;
let projectStart = 0;
let scroll = 0;
let mode = "list";
let input = "";
let inputKind = "";
let inputTarget = "";
let pendingProject = "";
let confirm = null;
let help = false;
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
		return { items: listItems(vault), projects: listProjects(vault) };
	} catch (error) {
		message = String(error?.message || error);
		return { items: [], projects: [] };
	}
}

function items() {
	try {
		return listItems(vault);
	} catch {
		return [];
	}
}

function projects() {
	try {
		return listProjects(vault);
	} catch {
		return [];
	}
}

function currentItem() {
	return items()[selected];
}

function currentProject() {
	return projects()[projectIndex];
}

function render() {
	const columns = Math.max(24, process.stdout.columns || 60);
	const rows = Math.max(10, process.stdout.rows || 20);
	const { items: list, projects: projectList } = readState();

	if (selectedId) {
		const at = list.findIndex(item => item.id === selectedId);
		if (at >= 0) selected = at;
	}
	selected = Math.min(Math.max(0, selected), Math.max(0, list.length - 1));
	selectedId = list[selected]?.id || "";
	projectIndex = Math.min(Math.max(0, projectIndex), Math.max(0, projectList.length - 1));

	const focusItem = list.find(item => item.status === "focus");
	const listRows = Math.max(3, rows - 11 - Math.min(projectList.length, 3));
	if (selected < scroll) scroll = selected;
	if (selected >= scroll + listRows) scroll = selected - listRows + 1;
	const visible = list.slice(scroll, scroll + listRows);

	const projectRows = 3;
	if (projectIndex < projectStart) projectStart = projectIndex;
	if (projectIndex >= projectStart + projectRows) projectStart = projectIndex - projectRows + 1;
	const visibleProjects = projectList.slice(projectStart, projectStart + projectRows);

	const output = [
		line(`UNITY  ${basename(vault)}${version ? `  v${version}` : ""}`, columns, BOLD + ACCENT),
		line(`FOCUS  ${focusItem ? focusItem.title : "—"}`, columns, focusItem ? GREEN : DIM),
		line("─".repeat(columns), columns, DIM),
		line(`ITEMS  ${list.length}${view === "items" ? "  ←" : ""}`, columns, BOLD),
	];

	if (help) {
		output.push(line("  j/k ↑/↓   move", columns, DIM));
		output.push(line("  space     toggle focus / stash", columns, DIM));
		output.push(line("  enter     open item (↻ resumes) / new item in project", columns, DIM));
		output.push(line("  v         switch items / projects", columns, DIM));
		output.push(line("  n / p     new item / new project", columns, DIM));
		output.push(line("  d         delete (asks y/n)", columns, DIM));
		output.push(line("  r / m     rename / move item", columns, DIM));
		output.push(line("  R         fresh session with context", columns, DIM));
		output.push(line("  x         close this tab", columns, DIM));
		output.push(line("  u         update the runtime", columns, DIM));
		output.push(line("  Ctrl-W    delete word while typing", columns, DIM));
		output.push(line("  [ ]       previous / next tab", columns, DIM));
		output.push(line("  Tab       next pane", columns, DIM));
		output.push(line("  ?         close help", columns, DIM));
	} else if (visible.length === 0) {
		output.push(line("  no items yet", columns, DIM));
	} else {
		for (let index = 0; index < visible.length; index += 1) {
			const item = visible[index];
			const isSelected = view === "items" && scroll + index === selected;
			const cursor = isSelected ? "▶" : " ";
			const mark = GLYPH[item.status] || "○";
			const resume = item.session ? "↻ " : "";
			const suffix = item.project ? `  ${item.project}` : "";
			const color = (isSelected ? "\x1b[7m" : "") + (COLOR[item.status] || "");
			output.push(line(`${cursor} ${mark} ${resume}${item.title}${suffix}`, columns, color));
		}
	}

	output.push(line("─".repeat(columns), columns, DIM));
	output.push(line(`PROJECTS  ${projectList.length}${view === "projects" ? "  ←" : ""}`, columns, BOLD));
	if (visibleProjects.length === 0) {
		output.push(line("  none", columns, DIM));
	} else {
		for (let index = 0; index < visibleProjects.length; index += 1) {
			const project = visibleProjects[index];
			const isSelected = view === "projects" && projectStart + index === projectIndex;
			const cursor = isSelected ? "▶" : " ";
			const color = isSelected ? "\x1b[7m" + ACCENT : DIM;
			output.push(line(`${cursor} ${project.title}  ${project.done}/${project.total}`, columns, color));
		}
	}

	output.push(line("─".repeat(columns), columns, DIM));
	if (confirm) {
		const question = confirm.kind === "tab" ? `close tab ${confirm.label}? y/n` : `delete ${confirm.label}? y/n`;
		output.push(line(question, columns, RED));
	} else if (mode === "input") {
		const label = {
			item: "new item",
			project: "new project",
			"rename-item": "rename item",
			"rename-project": "rename project",
			"move-item": "move item to project",
		}[inputKind] || "input";
		output.push(line(`> ${label}: ${input}█`, columns, ACCENT));
	} else {
		output.push(line(message || "j/k move · space focus/stash · enter open · v projects", columns, DIM));
		output.push(line("n item · p project · d delete · r rename · m move · u update · ? help · q", columns, DIM));
	}

	while (output.length < rows) output.push("".padEnd(columns));
	process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
}

function startInput(kind, initial = "", target = "") {
	mode = "input";
	inputKind = kind;
	inputTarget = target;
	input = initial;
}

function submit() {
	const value = input.trim();
	const kind = inputKind;
	input = "";
	inputKind = "";
	mode = "list";
	if (!value) return;
	try {
		if (kind === "item") {
			const project = pendingProject || currentItem()?.project || "inbox";
			const item = createItem(vault, { title: value, project });
			selectedId = item.id;
			view = "items";
			message = `created ${item.id}`;
		} else if (kind === "project") {
			const project = createProject(vault, { title: value });
			projectIndex = projects().findIndex(entry => entry.id === project.id);
			view = "projects";
			message = `created ${project.id}`;
		} else if (kind === "rename-item") {
			renameItem(vault, inputTarget, value);
			message = `renamed ${inputTarget}`;
		} else if (kind === "rename-project") {
			renameProject(vault, inputTarget, value);
			message = `renamed ${inputTarget}`;
		} else if (kind === "move-item") {
			moveItem(vault, inputTarget, value === "inbox" ? "" : value);
			message = `moved ${inputTarget} → ${value}`;
		}
	} catch (error) {
		message = String(error?.message || error);
	}
	pendingProject = "";
	inputTarget = "";
}

function doDelete() {
	if (!confirm) return;
	if (confirm.kind === "tab") {
		spawnSync("tmux", ["kill-window", "-t", process.env.TMUX_PANE || ":."], { stdio: "ignore" });
		return;
	}
	try {
		if (confirm.kind === "item") deleteItem(vault, confirm.id);
		else deleteProject(vault, confirm.id);
		message = `deleted ${confirm.id}`;
	} catch (error) {
		message = String(error?.message || error);
	}
	confirm = null;
}

function requestDelete() {
	if (view === "items") {
		const item = currentItem();
		if (item) confirm = { kind: "item", id: item.id, label: item.title };
	} else {
		const project = currentProject();
		if (project) confirm = { kind: "project", id: project.id, label: project.title };
	}
}

function updateRuntime() {
	if (!agentDir) {
		message = "no agent dir";
		return;
	}
	const updater = join(agentDir, "setup", "omp-unity-update.sh");
	if (!existsSync(updater)) {
		message = "updater missing; rerun the installer";
		return;
	}
	if (!process.env.TMUX) {
		message = "update needs a tmux workspace";
		return;
	}
	const quoted = `'${updater.replace(/'/g, `'\\''`)}'`;
	const command = `zsh ${quoted}; printf '\\nPress Enter to close.'; read -r`;
	const result = spawnSync("tmux", ["display-popup", "-E", "-w", "80%", "-h", "60%", "-T", "omp-unity update", command], { stdio: "ignore" });
	message = result.status === 0 ? "update finished; restart: tmux kill-session -t unity && omp" : "update failed";
}

function requestCloseTab() {
	if (!process.env.TMUX) {
		message = "close tab needs a tmux workspace";
		return;
	}
	const name = spawnSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE || "", "#{window_name}"], { encoding: "utf8" }).stdout.trim();
	confirm = { kind: "tab", id: "", label: name || "this tab" };
}

function requestRename() {
	if (view === "items") {
		const item = currentItem();
		if (item) startInput("rename-item", item.title, item.id);
	} else {
		const project = currentProject();
		if (project) startInput("rename-project", project.title, project.id);
	}
}

function requestMove() {
	if (view !== "items") return;
	const item = currentItem();
	if (item) startInput("move-item", item.project || "inbox", item.id);
}

function switchWindow(offset) {
	if (!process.env.TMUX) return;
	spawnSync("tmux", ["select-window", "-t", offset > 0 ? ":+" : ":-"], { stdio: "ignore" });
}

function cyclePane() {
	if (!process.env.TMUX) return;
	spawnSync("tmux", ["select-pane", "-t", ":.+"], { stdio: "ignore" });
}

function exit() {
	process.stdout.write("\x1b[?25h\x1b[?1049l");
	process.exit(0);
}

function move(delta) {
	if (view === "items") {
		selected = Math.max(0, selected + delta);
		selectedId = items()[selected]?.id || "";
	} else {
		projectIndex = Math.max(0, projectIndex + delta);
	}
}

function handleKey(key) {
	if (key === "up") key = "\x1b[A";
	if (key === "down") key = "\x1b[B";
	if (confirm) {
		if (key === "y" || key === "Y") doDelete();
		else if (key === "n" || key === "N" || key === "\x1b") confirm = null;
		return;
	}
	if (help) {
		if (key === "?" || key === "\x1b") help = false;
		return;
	}
	if (mode === "input") {
		if (key === "\r" || key === "\n") submit();
		else if (key === "\x7f" || key === "\x08") input = input.slice(0, -1);
		else if (key === "\x15") input = "";
		else if (key === "\x17") input = input.replace(/\s*\S+\s*$/, "");
		else if (key === "\x1b") {
			mode = "list";
			input = "";
			inputKind = "";
		} else if (key.length === 1 && key >= " ") input += key;
		return;
	}

	switch (key) {
		case "q":
		case "\x03":
			exit();
			break;
		case "\x1b[A":
		case "k":
			move(-1);
			break;
		case "\x1b[B":
		case "j":
			move(1);
			break;
		case "v":
			view = view === "items" ? "projects" : "items";
			break;
		case " ":
		case "s": {
			if (view !== "items") break;
			const item = currentItem();
			if (item) {
				const next = NEXT[item.status] || "stash";
				try {
					updateItem(vault, item.id, { status: next });
					message = `${item.id} → ${next}`;
				} catch (error) {
					message = String(error?.message || error);
				}
			}
			break;
		}
		case "\r":
		case "\n": {
			if (view === "projects") {
				const project = currentProject();
				if (project) {
					pendingProject = project.id;
					startInput("item");
				}
				break;
			}
			const item = currentItem();
			if (item && launcher) {
				spawn("/bin/zsh", [launcher, "--item", item.id], { detached: true, stdio: "ignore" }).unref();
				message = `opened ${item.title}`;
			}
			break;
		}
		case "n": {
			const project = view === "projects" ? currentProject()?.id : currentItem()?.project;
			pendingProject = project || "inbox";
			startInput("item");
			break;
		}
		case "p":
			startInput("project");
			break;
		case "d":
			requestDelete();
			break;
		case "r":
			requestRename();
			break;
		case "R": {
			const item = currentItem();
			if (item && launcher) {
				spawn("/bin/zsh", [launcher, "--item", item.id, "--fresh"], { detached: true, stdio: "ignore" }).unref();
				message = `fresh session for ${item.title}`;
			}
			break;
		}
		case "m":
			requestMove();
			break;
		case "x":
			requestCloseTab();
			break;
		case "u":
			updateRuntime();
			break;
		case "?":
			help = true;
			break;
		case "\t":
			cyclePane();
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
let pending = "";
function drainKeys() {
	while (pending.length) {
		if (pending.startsWith("\x1b[A") || pending.startsWith("\x1bOA")) {
			handleKey("up");
			pending = pending.slice(3);
		} else if (pending.startsWith("\x1b[B") || pending.startsWith("\x1bOB")) {
			handleKey("down");
			pending = pending.slice(3);
		} else if (pending.startsWith("\x1b")) {
			if (pending.length < 3) break;
			handleKey("\x1b");
			pending = pending.slice(1);
		} else {
			handleKey(pending[0]);
			pending = pending.slice(1);
		}
	}
}

process.stdin.on("data", chunk => {
	pending += chunk.toString("utf8");
	drainKeys();
	render();
});

process.stdout.on("resize", render);
process.on("SIGINT", exit);
process.on("SIGTERM", exit);

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
render();
setInterval(render, 500);
