// Small CLI used by the shell launcher. Prints one value, exits non-zero on miss.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addRegistryEntry,
	addTodo,
	createItem,
	createProject,
	deleteTodo,
	getItem,
	getProject,
	initVault,
	linkSkills,
	listItems,
	listProjects,
	listTodos,
	pauseAll,
	paths,
	readDoc,
	reconcileSessions,
	renameTodo,
	setSessionState,
	stopSession,
	syncSession,
	syncSessions,
	targetPaths,
	toggleTodo,
	updateItem,
	updateProject,
} from "./unity-store.mjs";

const [command, vault, ...args] = process.argv.slice(2);

function out(value = "") {
	process.stdout.write(String(value));
}

function takeFlag(name) {
	const at = args.indexOf(name);
	if (at < 0) return false;
	args.splice(at, 1);
	return true;
}

const isProject = takeFlag("--project");
const withSession = takeFlag("--with-session");
const kind = isProject ? "project" : "item";
const target = args[0] || "";
const readTarget = () => (isProject ? getProject(vault, target) : getItem(vault, target));

function recentSession(file) {
	if (!file) return "";
	try {
		const lines = readFileSync(String(file), "utf8").trim().split("\n").slice(-80);
		const messages = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				const message = parsed?.message;
				if (!message || !["user", "assistant"].includes(message.role)) continue;
				const text = Array.isArray(message.content)
					? message.content.filter(part => part?.type === "text").map(part => part.text).join(" ")
					: String(message.content || "");
				if (text.trim()) messages.push(`${message.role}: ${text.replace(/\s+/g, " ").trim().slice(0, 220)}`);
			} catch {
				// ignore non-message lines
			}
		}
		return messages.slice(-4).join("\n");
	} catch {
		return "";
	}
}

function todoLines(todos) {
	if (!todos.length) return "";
	return `Todos:\n${todos.map(todo => `- [${todo.done ? "x" : " "}] ${todo.text}`).join("\n")}\n`;
}

function prose(body) {
	const lines = [];
	let inTodos = false;
	for (const line of String(body || "").split("\n")) {
		if (/^##\s+Todos\s*$/i.test(line)) {
			inTodos = true;
			continue;
		}
		if (inTodos && /^##\s+/.test(line)) inTodos = false;
		if (!inTodos) lines.push(line);
	}
	return lines.join(" ").replace(/\s+/g, " ").trim();
}

try {
	switch (command) {
		case "init":
			initVault(vault);
			break;
		case "items":
			for (const item of listItems(vault)) {
				out(
					`${item.id}\t${item.status}\t${item.project}\t${item.sessionState || "-"}\t${item.todos.done}/${item.todos.total}\t${item.title}\n`,
				);
			}
			break;
		case "projects":
			for (const project of listProjects(vault)) {
				out(
					`${project.id}\t${project.status}\t${project.sessionState || "-"}\t${project.todos.done}/${project.todos.total}\t${project.total}\t${project.title}\n`,
				);
			}
			break;
		case "item": {
			const item = getItem(vault, target);
			if (!item) process.exit(1);
			out(`${item.status}\t${item.session || ""}\t${item.sessionState || ""}\t${item.todos.done}/${item.todos.total}\t${item.title}\n`);
			break;
		}
		case "project": {
			const project = getProject(vault, target);
			if (!project) process.exit(1);
			const total = listItems(vault).filter(item => item.project === project.id).length;
			out(
				`${project.status || "active"}\t${project.session || ""}\t${project.sessionState || ""}\t${project.todos.done}/${project.todos.total}\t${total}\t${project.title}\n`,
			);
			break;
		}
		case "session":
			out(readTarget()?.session || "");
			break;
		case "session-state":
			out(`${setSessionState(vault, kind, target, args[1] || "")}\n`);
			break;
		case "session-clear":
			out(`${stopSession(vault, kind, target)}\n`);
			break;
		case "status":
			if (isProject) updateProject(vault, target, { status: args[1] });
			else updateItem(vault, target, { status: args[1] });
			break;
		case "new":
			out(`${createItem(vault, { title: target, project: args[1] || "" }).id}\n`);
			break;
		case "new-project":
			out(`${createProject(vault, { title: target }).id}\n`);
			break;
		case "prompt": {
			const entry = readTarget();
			if (!entry) process.exit(1);
			const status = isProject ? String(entry.status || "active") : entry.status === "focus" || entry.status === "active" ? "focus" : "stash";
			const todos = listTodos(vault, kind, target);
			const previous = withSession ? recentSession(entry.session) : "";
			const statePaths = targetPaths(vault, kind, target);
			const handoff = readDoc(statePaths.handoff);
			const handoffText = prose(handoff.body).slice(0, 600);
			const stateLines =
				`State: ${statePaths.state}\n` +
				`Handoff: ${statePaths.handoff}\n` +
				`Docs: ${statePaths.readme}\n` +
				(handoffText ? `Handoff notes: ${handoffText}\n` : "");
			if (isProject) {
				const items = listItems(vault)
					.filter(item => item.project === entry.id)
					.map(item => `- [${item.status}] ${item.title}${item.sessionState ? ` (session ${item.sessionState})` : ""}`)
					.join("\n");
				const notes = prose(entry.body).slice(0, 700);
				out(
					`Unity project: "${entry.title}" (id: ${entry.id}, status: ${status})\n` +
						`Project file: ${entry.file}\n` +
						stateLines +
						(notes ? `Project notes: ${notes}\n` : "") +
						todoLines(todos) +
						(items ? `Items in this project:\n${items}\n` : "") +
						(previous ? `Recent session:\n${previous}\n` : "") +
						"Read the project file and handoff, work on this project, and keep handoff.md and the todos current.\n",
				);
				break;
			}
			const project = entry.project || "";
			let projectLine = "Project: inbox";
			if (project) {
				const doc = readDoc(join(paths(vault).projects, `${project}.md`));
				const title = doc.data.title || project;
				const notes = String(doc.body || "").replace(/\s+/g, " ").trim().slice(0, 240);
				projectLine = `Project: ${title} (${project})${notes ? ` — ${notes}` : ""}`;
			}
			const body = prose(entry.body).slice(0, 700);
			const siblings = listItems(vault)
				.filter(other => other.project === project && other.id !== entry.id)
				.slice(0, 8)
				.map(other => `- [${other.status}] ${other.title}`)
				.join("\n");
			out(
				`Unity item: "${entry.title}" (id: ${entry.id}, status: ${status})\n` +
					`${projectLine}\n` +
					`Item file: ${entry.file}\n` +
					stateLines +
					(body ? `Item notes: ${body}\n` : "") +
					todoLines(todos) +
					(siblings ? `Other items in this project:\n${siblings}\n` : "") +
					(previous ? `Recent session:\n${previous}\n` : "") +
					"Read the item file and handoff, work on this, and keep handoff.md and the todos current.\n",
			);
			break;
		}
		case "todo-list":
			for (const todo of listTodos(vault, kind, target)) {
				out(`${todo.done ? "x" : " "}\t${todo.text}\n`);
			}
			break;
		case "todo-add":
			out(`${addTodo(vault, kind, target, args[1] || "")}\n`);
			break;
		case "todo-toggle":
			out(`${toggleTodo(vault, kind, target, Number(args[1]))}\n`);
			break;
		case "todo-rename":
			out(`${renameTodo(vault, kind, target, Number(args[1]), args[2] || "")}\n`);
			break;
		case "todo-delete":
			out(`${deleteTodo(vault, kind, target, Number(args[1]))}\n`);
			break;
		case "sync-session":
			out(`${syncSession(vault, kind, target)}\n`);
			break;
		case "sync-sessions":
			out(`${syncSessions(vault)}\n`);
			break;
		case "pause-all":
			out(`${pauseAll(vault)}\n`);
			break;
		case "reconcile":
			out(`${reconcileSessions(vault, args.slice(1))}\n`);
			break;
		case "registry-skill":
			addRegistryEntry(vault, "skills", { name: target, path: args[1] });
			break;
		case "registry-repo":
			addRegistryEntry(vault, "repos", { name: target, url: args[1] });
			break;
		case "link-skills":
			for (const linked of linkSkills(vault, target)) out(`${linked}\n`);
			break;
		default:
			process.stderr.write(
				"usage: unity-cli.mjs <init|items|projects|item|project|session|session-state|session-clear|sync-session|sync-sessions|status|new|new-project|prompt|todo-list|todo-add|todo-toggle|todo-rename|todo-delete|pause-all|reconcile> <vault> ...\n",
			);
			process.exit(2);
	}
} catch (error) {
	process.stderr.write(`${error?.message || error}\n`);
	process.exit(1);
}
