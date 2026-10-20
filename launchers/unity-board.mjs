// Unity panel.
//
// Board mode (parent workspace):
//   j/k move, space focus/stash, enter open/resume, N fresh, p pause, s stop,
//   n item, P project, v items/projects, d delete, r rename, m move,
//   x exit workspace, ? help, q quit.
//
// Item/project mode (inside a tab):
//   j/k move, space toggle todo, a add, r rename, d delete,
//   g parent workspace, x pause tab, s stop session, ? help, q quit.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	addTodo,
	createItem,
	createProject,
	deleteItem,
	deleteProject,
	deleteTodo,
	getItem,
	getProject,
	listItems,
	listProjects,
	listTodos,
	moveItem,
	pauseAll,
	reconcileSessions,
	renameItem,
	renameProject,
	renameTodo,
	setSessionState,
	stopSession,
	syncSession,
	targetPaths,
	toggleTodo,
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
	console.error("usage: node unity-board.mjs <vault> [launcher] [--scope board|item|project] [--id id] [--parent index]");
	process.exit(1);
}

let scope = process.env.UNITY_SCOPE || "board";
let targetId = process.env.UNITY_ID || "";
let parentIndex = process.env.UNITY_PARENT || "";
for (let index = 4; index < process.argv.length; index += 1) {
	const value = process.argv[index];
	if (value === "--scope") scope = process.argv[++index] || scope;
	else if (value === "--id") targetId = process.argv[++index] || "";
	else if (value === "--parent") parentIndex = process.argv[++index] || "";
}
if (scope !== "board" && scope !== "item" && scope !== "project") scope = "board";
if (scope !== "board" && !targetId) {
	console.error("unity-board: --id is required for item/project scope");
	process.exit(1);
}
const isBoard = scope === "board";
const kind = scope === "project" ? "project" : "item";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ACCENT = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
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
let todoIndex = 0;
let todoStart = 0;
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
	return readState().items;
}

function projects() {
	return readState().projects;
}

function currentItem() {
	return items()[selected];
}

function currentProject() {
	return projects()[projectIndex];
}

function targetEntry() {
	try {
		return kind === "project" ? getProject(vault, targetId) : getItem(vault, targetId);
	} catch (error) {
		message = String(error?.message || error);
		return undefined;
	}
}

function targetTodos() {
	try {
		return listTodos(vault, kind, targetId);
	} catch {
		return [];
	}
}

function sessionLabel(entry) {
	if (!entry?.session) return "not started";
	return entry.sessionState === "running" ? "running" : "paused";
}

function sessionGlyph(entry) {
	if (!entry?.session) return " ";
	return entry.sessionState === "running" ? "●" : "⏸";
}

function sessionColor(entry) {
	if (!entry?.session) return DIM;
	return entry.sessionState === "running" ? GREEN : YELLOW;
}

function todoLabel(entry) {
	return entry?.todos?.total ? `☑ ${entry.todos.done}/${entry.todos.total}` : "";
}

function tmuxSession() {
	if (!process.env.TMUX) return "";
	const result = spawnSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

function windowNames() {
	if (!process.env.TMUX) return [];
	const session = tmuxSession();
	if (!session) return [];
	const result = spawnSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

function openKeys() {
	return windowNames()
		.map(name => {
			if (name.startsWith("i-")) return `item:${name.slice(2)}`;
			if (name.startsWith("p-")) return `project:${name.slice(2)}`;
			return "";
		})
		.filter(Boolean);
}

function windowName(targetScope, id) {
	return `${targetScope === "project" ? "p" : "i"}-${id}`;
}

function killWindow(name) {
	if (!process.env.TMUX || !name) return;
	spawn("tmux", ["kill-window", "-t", `:${name}`], { detached: true, stdio: "ignore" }).unref();
}

function killCurrentWindow() {
	if (!process.env.TMUX) return;
	spawn("tmux", ["kill-window", "-t", process.env.TMUX_PANE || ":."], { detached: true, stdio: "ignore" }).unref();
}

function killTargetWindow(targetScope, id) {
	const name = windowName(targetScope, id);
	if (windowNames().includes(name)) killWindow(name);
}

function returnToParent() {
	if (!process.env.TMUX) return;
	if (parentIndex) {
		spawnSync("tmux", ["select-window", "-t", `:${parentIndex}`], { stdio: "ignore" });
		return;
	}
	const target = windowNames().includes("main") ? ":main" : ":0";
	spawnSync("tmux", ["select-window", "-t", target], { stdio: "ignore" });
}

function openTarget(targetScope, id, fresh) {
	if (!launcher) return;
	const args = targetScope === "project" ? ["--project", id] : ["--item", id];
	if (fresh) args.push("--fresh");
	spawn("/bin/zsh", [launcher, ...args], { detached: true, stdio: "ignore" }).unref();
	message = `${fresh ? "fresh session" : "opened"} ${id}`;
}

function pauseTarget(targetScope, id, label, closeTab = false) {
	const entry = targetScope === "project" ? getProject(vault, id) : getItem(vault, id);
	if (!entry?.session) {
		message = `${label} has no session`;
		return;
	}
	syncSession(vault, targetScope, id);
	setSessionState(vault, targetScope, id, "paused");
	if (closeTab) killCurrentWindow();
	else killTargetWindow(targetScope, id);
	message = `paused ${label}`;
}

function stopTarget(targetScope, id, label) {
	stopSession(vault, targetScope, id);
	killTargetWindow(targetScope, id);
	message = `stopped ${label}`;
}

function exitWorkspace() {
	if (!process.env.TMUX) {
		message = "exit needs a tmux workspace";
		return;
	}
	pauseAll(vault);
	const session = tmuxSession();
	if (session) spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
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

function startInput(nextKind, initial = "", target = "") {
	mode = "input";
	inputKind = nextKind;
	inputTarget = target;
	input = initial;
}

function submit() {
	const value = input.trim();
	const inputKindNow = inputKind;
	const target = inputTarget;
	input = "";
	inputKind = "";
	inputTarget = "";
	mode = "list";
	if (!value) return;
	try {
		if (inputKindNow === "item") {
			const project = pendingProject || currentItem()?.project || "inbox";
			const item = createItem(vault, { title: value, project });
			selectedId = item.id;
			view = "items";
			message = `created ${item.id}`;
		} else if (inputKindNow === "project") {
			const project = createProject(vault, { title: value });
			projectIndex = projects().findIndex(entry => entry.id === project.id);
			view = "projects";
			message = `created ${project.id}`;
		} else if (inputKindNow === "rename-item") {
			renameItem(vault, target, value);
			message = `renamed ${target}`;
		} else if (inputKindNow === "rename-project") {
			renameProject(vault, target, value);
			message = `renamed ${target}`;
		} else if (inputKindNow === "move-item") {
			moveItem(vault, target, value === "inbox" ? "" : value);
			message = `moved ${target} → ${value}`;
		} else if (inputKindNow === "todo-add") {
			addTodo(vault, kind, targetId, value);
			todoIndex = Math.max(0, targetTodos().length - 1);
			message = "todo added";
		} else if (inputKindNow === "todo-rename") {
			renameTodo(vault, kind, targetId, Number(target), value);
			message = "todo renamed";
		}
	} catch (error) {
		message = String(error?.message || error);
	}
	pendingProject = "";
}

function doConfirm() {
	const action = confirm;
	confirm = null;
	if (!action) return;
	try {
		if (action.kind === "delete-item") {
			deleteItem(vault, action.id);
			message = `deleted ${action.id}`;
		} else if (action.kind === "delete-project") {
			deleteProject(vault, action.id);
			message = `deleted ${action.id}`;
		} else if (action.kind === "delete-todo") {
			deleteTodo(vault, kind, targetId, action.index);
			todoIndex = Math.max(0, todoIndex - 1);
			message = "todo deleted";
		} else if (action.kind === "stop") {
			stopTarget(action.scope, action.id, action.label);
		} else if (action.kind === "pause-tab") {
			pauseTarget(kind, targetId, action.label, true);
		} else if (action.kind === "exit") {
			exitWorkspace();
		}
	} catch (error) {
		message = String(error?.message || error);
	}
}

function requestDelete() {
	if (!isBoard) {
		const todo = targetTodos()[todoIndex];
		if (todo) confirm = { kind: "delete-todo", index: todoIndex, label: todo.text };
		return;
	}
	if (view === "items") {
		const item = currentItem();
		if (item) confirm = { kind: "delete-item", id: item.id, label: item.title };
	} else {
		const project = currentProject();
		if (project) confirm = { kind: "delete-project", id: project.id, label: project.title };
	}
}

function requestRename() {
	if (!isBoard) {
		const todo = targetTodos()[todoIndex];
		if (todo) startInput("todo-rename", todo.text, String(todoIndex));
		return;
	}
	if (view === "items") {
		const item = currentItem();
		if (item) startInput("rename-item", item.title, item.id);
	} else {
		const project = currentProject();
		if (project) startInput("rename-project", project.title, project.id);
	}
}

function requestMove() {
	if (!isBoard || view !== "items") return;
	const item = currentItem();
	if (item) startInput("move-item", item.project || "inbox", item.id);
}

function requestStop() {
	if (isBoard) {
		const entry = view === "items" ? currentItem() : currentProject();
		if (!entry) return;
		if (!entry.session) {
			message = `${entry.title} has no session`;
			return;
		}
		confirm = {
			kind: "stop",
			scope: view === "items" ? "item" : "project",
			id: entry.id,
			label: entry.title,
		};
		return;
	}
	const entry = targetEntry();
	if (!entry) return;
	if (!entry.session) {
		message = `${entry.title} has no session`;
		return;
	}
	confirm = { kind: "stop", scope: kind, id: entry.id, label: entry.title };
}

function requestPauseTab() {
	const entry = targetEntry();
	if (entry?.session) confirm = { kind: "pause-tab", label: entry.title };
	else message = "no session to pause";
}

function requestExit() {
	if (!process.env.TMUX) {
		message = "exit needs a tmux workspace";
		return;
	}
	confirm = { kind: "exit", label: "exit workspace (pauses all sessions)" };
}

function hintLines(columns = 80) {
	if (confirm) return ["", "y confirm · n / esc cancel"];
	if (mode === "input") return ["", "enter save · esc cancel · ctrl-w delete word"];
	if (help) return ["", "? close help"];
	if (isBoard) {
		if (view === "projects") {
			const project = currentProject();
			const lead = project?.session
				? `enter ${project.sessionState === "running" ? "show" : "resume"} project · p pause · s stop · N fresh`
				: "enter start project · N fresh";
			return [lead, "n new item here · P new project · v items · d delete · r rename · x exit · ? help"];
		}
		const item = currentItem();
		let lead = "n item · P project";
		if (item) {
			if (item.sessionState === "running") lead = "enter show · p pause · s stop · N fresh";
			else if (item.sessionState === "paused") lead = "enter resume · s stop · N fresh";
			else lead = "enter start · N fresh";
		}
		return [lead, "space focus/stash · d delete · m move · v projects · x exit · ? help"];
	}
	if (columns < 52) {
		return ["space toggle · a add · r rename", "j/k · o · g parent · x pause · s stop · ?"];
	}
	return [
		"space toggle · a add · r rename · d delete",
		"j/k move · o docs · g parent · x pause · s stop · ? help",
	];
}

function renderBoard(columns, rows, list, projectList) {
	if (selectedId) {
		const at = list.findIndex(item => item.id === selectedId);
		if (at >= 0) selected = at;
	}
	selected = Math.min(Math.max(0, selected), Math.max(0, list.length - 1));
	selectedId = list[selected]?.id || "";
	projectIndex = Math.min(Math.max(0, projectIndex), Math.max(0, projectList.length - 1));

	const focused = list.filter(item => item.status === "focus");
	const focusLabel = focused.length === 0 ? "—" : focused.length === 1 ? focused[0].title : `${focused.length} focused`;
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
		line(`FOCUS  ${focusLabel}`, columns, focused.length ? GREEN : DIM),
		line("─".repeat(columns), columns, DIM),
		line(`ITEMS  ${list.length}${view === "items" ? "  ←" : ""}`, columns, BOLD),
	];

	if (help) {
		output.push(line("  j/k ↑/↓   move", columns, DIM));
		output.push(line("  space     toggle focus / stash", columns, DIM));
		output.push(line("  enter     open / resume / start", columns, DIM));
		output.push(line("  N         fresh session with context", columns, DIM));
		output.push(line("  p / s     pause / stop session", columns, DIM));
		output.push(line("  n / P     new item / new project", columns, DIM));
		output.push(line("  v         switch items / projects", columns, DIM));
		output.push(line("  d / r / m delete / rename / move", columns, DIM));
		output.push(line("  x / q     exit workspace (pauses all)", columns, DIM));
		output.push(line("  [ ] Tab   tabs / next pane", columns, DIM));
		output.push(line("  u         update the runtime", columns, DIM));
		output.push(line("  ?         close help", columns, DIM));
	} else if (visible.length === 0) {
		output.push(line("  no items yet", columns, DIM));
	} else {
		for (let index = 0; index < visible.length; index += 1) {
			const item = visible[index];
			const isSelected = view === "items" && scroll + index === selected;
			const cursor = isSelected ? "▶" : " ";
			const mark = GLYPH[item.status] || "○";
			const session = sessionGlyph(item);
			const progress = todoLabel(item);
			const suffix = item.project ? `  ${item.project}` : "";
			const color = (isSelected ? "\x1b[7m" : "") + (COLOR[item.status] || "");
			output.push(line(`${cursor} ${mark} ${session} ${item.title}${suffix}${progress ? `  ${progress}` : ""}`, columns, color));
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
			const session = sessionGlyph(project);
			const progress = todoLabel(project);
			const itemsLabel = `${project.total} item${project.total === 1 ? "" : "s"}`;
			const color = isSelected ? "\x1b[7m" + ACCENT : DIM;
			output.push(
				line(
					`${cursor} ${session} ${project.title}  ${progress || "☑ 0/0"}  ${itemsLabel}`,
					columns,
					color,
				),
			);
		}
	}

	const [hintOne, hintTwo] = hintLines(columns);
	output.push(line("─".repeat(columns), columns, DIM));
	if (confirm) output.push(line(`${confirm.label}? y/n`, columns, RED));
	else if (mode === "input") {
		const label =
			{
				item: "new item",
				project: "new project",
				"rename-item": "rename item",
				"rename-project": "rename project",
				"move-item": "move item to project",
				"todo-add": "new todo",
				"todo-rename": "rename todo",
			}[inputKind] || "input";
		output.push(line(`> ${label}: ${input}█`, columns, ACCENT));
	} else output.push(line(message || hintOne, columns, message ? ACCENT : DIM));
	output.push(line(hintTwo, columns, DIM));

	while (output.length < rows) output.push("".padEnd(columns));
	process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
}

function renderTarget(columns, rows) {
	const entry = targetEntry();
	const todos = targetTodos();
	todoIndex = Math.min(Math.max(0, todoIndex), Math.max(0, todos.length - 1));
	const listRows = Math.max(3, rows - 11);
	if (todoIndex < todoStart) todoStart = todoIndex;
	if (todoIndex >= todoStart + listRows) todoStart = todoIndex - listRows + 1;
	const visible = todos.slice(todoStart, todoStart + listRows);

	if (!entry) {
		const output = [
			line(`UNITY  ${targetId}`, columns, BOLD + ACCENT),
			line(`${kind === "project" ? "PROJECT" : "ITEM"}  missing`, columns, RED),
			line("─".repeat(columns), columns, DIM),
			line("  the markdown file was removed or renamed", columns, DIM),
			line("", columns),
			line("g parent · q quit", columns, DIM),
		];
		while (output.length < rows) output.push("".padEnd(columns));
		process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
		return;
	}

	const status =
		kind === "project"
			? String(entry.status || "active")
			: entry.status === "focus" || entry.status === "active"
				? "focus"
				: "stash";
	const projectItems = kind === "project" ? items().filter(item => item.project === entry.id).length : 0;
	const meta =
		kind === "project"
			? `PROJECT  ${status}  ·  ${projectItems} items`
			: `ITEM  ${status}  ·  ${entry.project || "inbox"}`;
	const sessionState = sessionLabel(entry);
	const sessionGlyphValue = sessionGlyph(entry).trim() || "○";
	const sessionText = entry.session
		? `SESSION  ${sessionGlyphValue} ${sessionState}  ·  ${basename(String(entry.session))}`
		: "SESSION  ○ not started";
	const docsLabel = `${kind === "project" ? "projects" : "items"}/${targetId}/handoff.md · README.md`;

	const output = [
		line(`UNITY  ${entry.title}`, columns, BOLD + ACCENT),
		line(meta, columns, DIM),
		line(sessionText, columns, sessionColor(entry)),
		line(`DOCS  ${docsLabel}`, columns, DIM),
		line("─".repeat(columns), columns, DIM),
		line(`TODOS  ${todos.filter(todo => todo.done).length}/${todos.length}`, columns, BOLD),
	];

	if (help) {
		output.push(line("  j/k ↑/↓   move", columns, DIM));
		output.push(line("  space     toggle done", columns, DIM));
		output.push(line("  a         add todo", columns, DIM));
		output.push(line("  r         rename todo", columns, DIM));
		output.push(line("  d         delete todo (y/n)", columns, DIM));
		output.push(line("  o         open handoff.md", columns, DIM));
		output.push(line("  g         back to parent workspace", columns, DIM));
		output.push(line("  x / q     pause tab (keep session)", columns, DIM));
		output.push(line("  s         stop session (clear link)", columns, DIM));
		output.push(line("  [ ] Tab   tabs / next pane", columns, DIM));
		output.push(line("  ?         close help", columns, DIM));
	} else if (visible.length === 0) {
		output.push(line("  no todos yet — a to add", columns, DIM));
	} else {
		for (let index = 0; index < visible.length; index += 1) {
			const todo = visible[index];
			const isSelected = todoStart + index === todoIndex;
			const cursor = isSelected ? "▶" : " ";
			const box = todo.done ? "[x]" : "[ ]";
			const color = (isSelected ? "\x1b[7m" : "") + (todo.done ? DIM : "");
			output.push(line(`${cursor} ${box} ${todo.text}`, columns, color));
		}
	}

	const [hintOne, hintTwo] = hintLines(columns);
	output.push(line("─".repeat(columns), columns, DIM));
	if (confirm) output.push(line(`${confirm.label}? y/n`, columns, RED));
	else if (mode === "input") {
		const label = inputKind === "todo-add" ? "new todo" : "rename todo";
		output.push(line(`> ${label}: ${input}█`, columns, ACCENT));
	} else output.push(line(message || hintOne, columns, message ? ACCENT : DIM));
	output.push(line(hintTwo, columns, DIM));

	while (output.length < rows) output.push("".padEnd(columns));
	process.stdout.write(`\x1b[H${output.slice(0, rows).join("\n")}\x1b[0m`);
}

function render() {
	const columns = Math.max(24, process.stdout.columns || 60);
	const rows = Math.max(10, process.stdout.rows || 20);
	const { items: list, projects: projectList } = readState();
	if (isBoard) renderBoard(columns, rows, list, projectList);
	else renderTarget(columns, rows);
}

function move(delta) {
	if (!isBoard) {
		todoIndex = Math.max(0, todoIndex + delta);
		return;
	}
	if (view === "items") {
		selected = Math.max(0, selected + delta);
		selectedId = items()[selected]?.id || "";
	} else {
		projectIndex = Math.max(0, projectIndex + delta);
	}
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

function handleTargetKey(key) {
	switch (key) {
		case "q":
			requestPauseTab();
			break;
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
		case " ":
		case "\r":
		case "\n": {
			const todo = targetTodos()[todoIndex];
			if (todo) {
				toggleTodo(vault, kind, targetId, todoIndex);
				message = todo.done ? "todo reopened" : "todo done";
			}
			break;
		}
		case "a":
			startInput("todo-add");
			break;
		case "r":
			requestRename();
			break;
		case "d":
			requestDelete();
			break;
		case "o": {
			const docs = targetPaths(vault, kind, targetId);
			const opener = process.platform === "darwin" ? "open" : "xdg-open";
			spawn(opener, [docs.handoff], { detached: true, stdio: "ignore" }).unref();
			message = `opened ${basename(docs.handoff)}`;
			break;
		}
		case "g":
			returnToParent();
			break;
		case "x":
			requestPauseTab();
			break;
		case "s":
			requestStop();
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
		case "u":
			updateRuntime();
			break;
		default:
			break;
	}
}

function handleBoardKey(key) {
	switch (key) {
		case "q":
			requestExit();
			break;
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
		case "\r":
		case "\n": {
			if (key === " ") {
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
			if (view === "projects") {
				const project = currentProject();
				if (project) openTarget("project", project.id, false);
				break;
			}
			const item = currentItem();
			if (item) openTarget("item", item.id, false);
			break;
		}
		case "N": {
			const entry = view === "items" ? currentItem() : currentProject();
			if (entry) openTarget(view === "items" ? "item" : "project", entry.id, true);
			break;
		}
		case "p": {
			const entry = view === "items" ? currentItem() : currentProject();
			if (entry) pauseTarget(view === "items" ? "item" : "project", entry.id, entry.title);
			break;
		}
		case "s":
			requestStop();
			break;
		case "n": {
			const project = view === "projects" ? currentProject()?.id : currentItem()?.project;
			pendingProject = project || "inbox";
			startInput("item");
			break;
		}
		case "P":
			startInput("project");
			break;
		case "d":
			requestDelete();
			break;
		case "r":
			requestRename();
			break;
		case "m":
			requestMove();
			break;
		case "x":
			requestExit();
			break;
		case "g":
			returnToParent();
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
		case "u":
			updateRuntime();
			break;
		default:
			break;
	}
}

function handleKey(key) {
	if (key === "up") key = "\x1b[A";
	if (key === "down") key = "\x1b[B";
	if (confirm) {
		if (key === "y" || key === "Y") doConfirm();
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
			inputTarget = "";
		} else if (key.length === 1 && key >= " ") input += key;
		return;
	}
	if (isBoard) handleBoardKey(key);
	else handleTargetKey(key);
}

if (process.env.TMUX) reconcileSessions(vault, openKeys());

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
