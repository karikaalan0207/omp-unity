// Unity store: Obsidian-backed focus, items, projects, and registry.
// Plain markdown + YAML frontmatter. Node builtins only.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const STATUS = ["focus", "stash"];
const RANK = { focus: 0, stash: 1 };
const normalizeStatus = value => (value === "focus" || value === "active" ? "focus" : "stash");

const REGISTRY = `# Unity registry (edit in Obsidian).
# Extra skill directories are linked into ~/.omp/agent/skills by the bootstrap.
skills: []
# Repos the workspace can open. \`path\` is an absolute directory.
repos: []
`;

export function nowIso() {
	return new Date().toISOString();
}

export function slugify(value) {
	const slug = String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "item";
}

export function parseDoc(text) {
	if (!text.startsWith("---")) return { data: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: text };
	const head = text.slice(text.indexOf("\n", 3) + 1, end);
	const body = text.slice(end + 4).replace(/^\r?\n/, "");
	const data = {};
	for (const line of head.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if (value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map(part => part.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
		} else {
			value = value.replace(/^["']|["']$/g, "");
		}
		data[match[1]] = value;
	}
	return { data, body };
}

export function stringifyDoc(data, body) {
	const lines = Object.entries(data)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`);
	return `---\n${lines.join("\n")}\n---\n\n${(body || "").replace(/^\n+/, "")}`;
}

function readText(file, fallback = "") {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return fallback;
	}
}

const TODO_RE = /^(\s*)([-*])\s+\[([ xX])\]\s+(.*)$/;

export function parseTodos(body) {
	const lines = String(body || "").split("\n");
	const todos = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(TODO_RE);
		if (!match) continue;
		todos.push({ index, text: match[4].trim(), done: match[3].toLowerCase() === "x" });
	}
	return todos;
}

function todoSummary(body) {
	const todos = parseTodos(body);
	return { done: todos.filter(todo => todo.done).length, total: todos.length };
}

function sessionStateOf(session, doc) {
	const value = String(doc.session_state || "");
	if (value === "stopped") return "stopped";
	if (!session) return "";
	if (value === "running" || value === "paused") return value;
	return "paused";
}

function targetDirPath(vault, kind, id) {
	return join(kind === "project" ? paths(vault).projects : paths(vault).items, slugify(id));
}

function portableRelative(kind, id) {
	return join("Unity", kind === "project" ? "projects" : "items", slugify(id), "session.jsonl");
}

export function portableSession(vault, kind, id) {
	return join(vault, portableRelative(kind, id));
}

export function targetPaths(vault, kind, id) {
	const dir = targetDirPath(vault, kind, id);
	return {
		dir,
		state: join(dir, "state.yml"),
		handoff: join(dir, "handoff.md"),
		readme: join(dir, "README.md"),
		session: join(dir, "session.jsonl"),
	};
}

function sessionFor(vault, kind, doc) {
	if (String(doc.session_state || "") === "stopped") return "";
	const local = String(doc.session_local || "");
	if (local && existsSync(local)) return local;
	const raw = String(doc.session || "");
	if (raw) {
		const candidate = raw.startsWith("/") ? raw : join(vault, raw);
		if (existsSync(candidate)) return candidate;
	}
	const portable = portableSession(vault, kind, doc.id);
	if (existsSync(portable)) return portable;
	const legacy = join(paths(vault).sessions, `${kind === "project" ? "project" : "item"}-${slugify(doc.id)}.jsonl`);
	if (existsSync(legacy)) return legacy;
	return "";
}

function targetFile(vault, kind, id) {
	const p = ensure(vault);
	const dir = kind === "project" ? p.projects : p.items;
	return join(dir, `${slugify(id)}.md`);
}

function readTarget(vault, kind, id) {
	const { data, body } = readDoc(targetFile(vault, kind, id));
	if (!Object.keys(data).length) return undefined;
	return { id: slugify(id), ...data, body };
}

function writeTarget(vault, kind, id, data, body) {
	writeFileSync(targetFile(vault, kind, id), stringifyDoc(data, body), "utf8");
}

function editBody(vault, kind, id, edit) {
	const target = readTarget(vault, kind, id);
	if (!target) return undefined;
	const { body: current, ...data } = target;
	const body = edit(String(current || ""), target);
	writeTarget(vault, kind, id, { ...data, updated: nowIso() }, body);
	const updated = readTarget(vault, kind, id);
	if (updated) ensureTargetFiles(vault, kind, updated);
	return target.id;
}

function yamlValue(value) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return '""';
	if (!/[:#\[\]{},&*!|>'"%@`]/.test(text)) return text;
	return JSON.stringify(text);
}

function stateYaml(kind, doc, body, session) {
	const todos = parseTodos(body);
	const status = kind === "item" ? normalizeStatus(doc.status) : String(doc.status || "active");
	const lines = [
		`id: ${yamlValue(doc.id)}`,
		`kind: ${kind}`,
		`title: ${yamlValue(doc.title || doc.id)}`,
		`status: ${yamlValue(status)}`,
	];
	if (kind === "item") lines.push(`project: ${yamlValue(doc.project || "")}`);
	lines.push(
		`session: ${yamlValue(session ? portableRelative(kind, doc.id) : "")}`,
		`session_state: ${yamlValue(sessionStateOf(session, doc))}`,
		`todos_done: ${todos.filter(todo => todo.done).length}`,
		`todos_total: ${todos.length}`,
		`next: ${yamlValue(todos.find(todo => !todo.done)?.text || "")}`,
		`updated: ${yamlValue(doc.updated || nowIso())}`,
	);
	return `${lines.join("\n")}\n`;
}

function handoffMeta(kind, doc, body) {
	const todos = parseTodos(body);
	return {
		id: doc.id,
		kind,
		title: doc.title || doc.id,
		status: kind === "item" ? normalizeStatus(doc.status) : String(doc.status || "active"),
		session_state: "",
		todos: `${todos.filter(todo => todo.done).length}/${todos.length}`,
		next: todos.find(todo => !todo.done)?.text || "",
		updated: doc.updated || nowIso(),
	};
}

function refreshHandoffTitle(body, title) {
	const lines = String(body || "").split("\n");
	const at = lines.findIndex(line => /^#\s+Handoff\s+—\s+/.test(line));
	if (at >= 0) lines[at] = `# Handoff — ${title}`;
	return lines.join("\n");
}

function refreshHandoffNext(body, next) {
	const lines = String(body || "").split("\n");
	const at = lines.findIndex(line => /^##\s+Next step\s*$/i.test(line));
	if (at < 0) return body;
	let end = at + 1;
	while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
	const section = lines.slice(at + 1, end);
	const auto = section.some(line => line.trim() === "<!-- unity:auto -->");
	const placeholder = section.some(line => /Define the first concrete step|_No progress recorded yet_/.test(line));
	if (!auto && !placeholder) return body;
	lines.splice(at + 1, end - at - 1, "", "<!-- unity:auto -->", `- [ ] ${next || "Define the first concrete step."}`, "");
	return lines.join("\n");
}

function ensureTargetFiles(vault, kind, doc) {
	const id = slugify(doc.id);
	const p = targetPaths(vault, kind, id);
	const title = String(doc.title || id);
	const body = String(doc.body || "");
	const session = sessionFor(vault, kind, { ...doc, id });
	mkdirSync(p.dir, { recursive: true });

	const state = stateYaml(kind, { ...doc, id }, body, session);
	if (!existsSync(p.state) || readText(p.state) !== state) writeFileSync(p.state, state, "utf8");

	if (!existsSync(p.readme)) {
		writeFileSync(
			p.readme,
			`# ${title}\n\nHuman-readable documentation for this ${kind}. Keep architecture, decisions, and anything another person or device needs to continue the work here.\n\n- Handoff: [handoff.md](handoff.md)\n- Machine state: [state.yml](state.yml)\n- Transcript: [session.jsonl](session.jsonl) (when present)\n`,
			"utf8",
		);
	}

	const next = parseTodos(body).find(todo => !todo.done)?.text || "Define the first concrete step.";
	if (!existsSync(p.handoff)) {
		writeFileSync(
			p.handoff,
			stringifyDoc(
				{ ...handoffMeta(kind, { ...doc, id }, body), session_state: sessionStateOf(session, doc) },
				`# Handoff — ${title}\n\n## Current state\n\n_No progress recorded yet._\n\n## Next step\n\n<!-- unity:auto -->\n- [ ] ${next}\n\n## Decisions and notes\n`,
			),
			"utf8",
		);
	} else {
		const handoff = readDoc(p.handoff);
		const meta = { ...handoffMeta(kind, { ...doc, id }, body), session_state: sessionStateOf(session, doc) };
		const content = stringifyDoc(
			{ ...handoff.data, ...meta },
			refreshHandoffNext(refreshHandoffTitle(handoff.body || `# Handoff — ${title}\n`, title), next),
		);
		if (readText(p.handoff) !== content) writeFileSync(p.handoff, content, "utf8");
	}

	if (session && !existsSync(p.session)) {
		try {
			copyFileSync(session, p.session);
		} catch {
			// The next pause/sync retries.
		}
	}
}

export function paths(vault) {
	const root = join(vault, "Unity");
	return {
		root,
		items: join(root, "items"),
		projects: join(root, "projects"),
		sessions: join(root, "sessions"),
		board: join(root, "board.md"),
		registry: join(root, "registry.yml"),
	};
}

export function ensure(vault) {
	const p = paths(vault);
	for (const dir of [p.items, p.projects, p.sessions]) mkdirSync(dir, { recursive: true });
	if (!existsSync(p.board)) {
		writeFileSync(p.board, stringifyDoc({ updated: nowIso() }, "# Unity board\n"), "utf8");
	} else {
		// Focus is per-item; drop the legacy board-level pointer.
		const board = readDoc(p.board);
		if (board.data.focus !== undefined) {
			const data = { ...board.data };
			delete data.focus;
			writeFileSync(p.board, stringifyDoc({ ...data, updated: nowIso() }, board.body || "# Unity board\n"), "utf8");
		}
	}
	if (!existsSync(p.registry)) writeFileSync(p.registry, REGISTRY, "utf8");
	return p;
}

export function readDoc(file) {
	const { data, body } = parseDoc(readText(file));
	return { data, body, file };
}

function docs(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith(".md") && !name.startsWith("."))
		.map(name => {
			const id = basename(name, ".md");
			const { data, body, file } = readDoc(join(dir, name));
			return { id, ...data, body, file };
		});
}

export function listItems(vault) {
	const p = ensure(vault);
	return docs(p.items)
		.map(item => {
			const session = sessionFor(vault, "item", item);
			const entry = {
				id: item.id,
				title: String(item.title || item.id),
				status: normalizeStatus(item.status),
				project: String(item.project || ""),
				session,
				sessionState: sessionStateOf(session, item),
				todos: todoSummary(item.body),
				updated: String(item.updated || ""),
			};
			ensureTargetFiles(vault, "item", item);
			return entry;
		})
		.sort((a, b) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1) || b.updated.localeCompare(a.updated));
}

export function listProjects(vault) {
	const p = ensure(vault);
	const items = listItems(vault);
	return docs(p.projects)
		.map(project => {
			const own = items.filter(item => item.project === project.id);
			const session = sessionFor(vault, "project", project);
			const entry = {
				id: project.id,
				title: String(project.title || project.id),
				status: String(project.status || "active"),
				total: own.length,
				focus: own.filter(item => item.status === "focus").length,
				session,
				sessionState: sessionStateOf(session, project),
				todos: todoSummary(project.body),
			};
			ensureTargetFiles(vault, "project", project);
			return entry;
		})
		.sort((a, b) => a.title.localeCompare(b.title));
}

export function getItem(vault, id) {
	const file = join(paths(vault).items, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	const entry = { id: slugify(id), ...data, body, file };
	const session = sessionFor(vault, "item", entry);
	ensureTargetFiles(vault, "item", entry);
	return {
		...entry,
		session,
		sessionState: sessionStateOf(session, entry),
		todos: todoSummary(body),
	};
}

export function getProject(vault, id) {
	const file = join(paths(vault).projects, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	const entry = { id: slugify(id), ...data, body, file };
	const session = sessionFor(vault, "project", entry);
	ensureTargetFiles(vault, "project", entry);
	return {
		...entry,
		session,
		sessionState: sessionStateOf(session, entry),
		todos: todoSummary(body),
	};
}

export function updateProject(vault, id, patch) {
	const p = ensure(vault);
	const file = join(p.projects, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	const next = { ...data, ...patch, updated: nowIso() };
	const nextBody = body || `# ${next.title || id}\n`;
	writeFileSync(file, stringifyDoc(next, nextBody), "utf8");
	const entry = { id: slugify(id), ...next, body: nextBody };
	ensureTargetFiles(vault, "project", entry);
	return entry;
}

export function createItem(vault, { title, project = "" }) {
	const p = ensure(vault);
	const base = slugify(title);
	let id = base;
	for (let n = 2; existsSync(join(p.items, `${id}.md`)); n += 1) id = `${base}-${n}`;
	const stamp = nowIso();
	const body = `# ${title}\n\n[Handoff](${id}/handoff.md) · [Docs](${id}/README.md)\n\n## Todos\n`;
	writeFileSync(
		join(p.items, `${id}.md`),
		stringifyDoc({ id, title, status: "stash", project, created: stamp, updated: stamp }, body),
		"utf8",
	);
	const entry = { id, title, status: "stash", project, session: "", updated: stamp, body };
	ensureTargetFiles(vault, "item", entry);
	return entry;
}

export function updateItem(vault, id, patch) {
	const p = ensure(vault);
	const file = join(p.items, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	const next = { ...data, ...patch, updated: nowIso() };
	const nextBody = body || `# ${next.title || id}\n`;
	writeFileSync(file, stringifyDoc(next, nextBody), "utf8");
	const entry = { id: slugify(id), ...next, body: nextBody };
	ensureTargetFiles(vault, "item", entry);
	return entry;
}

export function createProject(vault, { title }) {
	const p = ensure(vault);
	const base = slugify(title);
	let id = base;
	for (let n = 2; existsSync(join(p.projects, `${id}.md`)); n += 1) id = `${base}-${n}`;
	const stamp = nowIso();
	const body = `# ${title}\n\n[Handoff](${id}/handoff.md) · [Docs](${id}/README.md)\n\n## Todos\n`;
	writeFileSync(
		join(p.projects, `${id}.md`),
		stringifyDoc({ id, title, status: "active", created: stamp, updated: stamp }, body),
		"utf8",
	);
	const entry = { id, title, status: "active", body };
	ensureTargetFiles(vault, "project", entry);
	return entry;
}

export function initVault(vault) {
	const p = ensure(vault);
	// Materialize per-target state/docs for existing vaults.
	listItems(vault);
	listProjects(vault);
	syncSessions(vault);
	return { vault, ...p };
}

// Minimal registry reader/writer for the YAML subset we emit.
export function readRegistry(vault) {
	const text = readFileSync(paths(vault).registry, "utf8");
	const sections = { skills: [], repos: [] };
	let current = "";
	let entry;
	for (const line of text.split(/\r?\n/)) {
		if (/^skills:/.test(line)) {
			current = "skills";
			entry = undefined;
			continue;
		}
		if (/^repos:/.test(line)) {
			current = "repos";
			entry = undefined;
			continue;
		}
		if (!current) continue;
		const named = line.match(/^\s*-\s*name:\s*(.+)$/);
		if (named) {
			entry = { name: named[1].trim() };
			sections[current].push(entry);
			continue;
		}
		const field = line.match(/^\s*(path|url):\s*(.+)$/);
		if (field && entry) entry[field[1]] = field[2].trim();
	}
	return sections;
}

export function addRegistryEntry(vault, kind, { name, path, url }) {
	const file = ensure(vault).registry;
	const line = `  - name: ${name}\n${path ? `    path: ${path}\n` : ""}${url ? `    url: ${url}\n` : ""}`;
	let text = readFileSync(file, "utf8");
	if (new RegExp(`^${kind}:`, "m").test(text)) {
		text = text.replace(new RegExp(`^${kind}:.*$`, "m"), `${kind}:\n${line.trimEnd()}`);
	} else {
		text = `${text.trimEnd()}\n${kind}:\n${line}`;
	}
	writeFileSync(file, text, "utf8");
}

export function linkSkills(vault, skillsDir) {
	mkdirSync(skillsDir, { recursive: true });
	const linked = [];
	for (const skill of readRegistry(vault).skills) {
		if (!skill.name || !skill.path || !existsSync(skill.path)) continue;
		const dest = join(skillsDir, slugify(skill.name));
		if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) continue;
		try {
			rmSync(dest, { recursive: true, force: true });
			symlinkSync(skill.path, dest, "dir");
			linked.push(`${skill.name} -> ${skill.path}`);
		} catch {
			// A broken link must not abort the bootstrap.
		}
	}
	return linked;
}


export function deleteItem(vault, id) {
	const p = ensure(vault);
	const slug = slugify(id);
	try {
		unlinkSync(join(p.items, `${slug}.md`));
	} catch {
		return false;
	}
	rmSync(targetDirPath(vault, "item", slug), { recursive: true, force: true });
	return true;
}

export function deleteProject(vault, id) {
	const p = ensure(vault);
	const slug = slugify(id);
	try {
		unlinkSync(join(p.projects, `${slug}.md`));
	} catch {
		return false;
	}
	for (const item of listItems(vault)) {
		if (item.project === slug) updateItem(vault, item.id, { project: "" });
	}
	rmSync(targetDirPath(vault, "project", slug), { recursive: true, force: true });
	return true;
}

export function renameItem(vault, id, title) {
	return Boolean(updateItem(vault, id, { title }));
}

export function renameProject(vault, id, title) {
	return Boolean(updateProject(vault, id, { title }));
}

export function moveItem(vault, id, project) {
	return Boolean(updateItem(vault, id, { project }));
}

export function listTodos(vault, kind, id) {
	const target = readTarget(vault, kind, id);
	return target ? parseTodos(target.body) : [];
}

export function addTodo(vault, kind, id, text) {
	const value = String(text || "").trim();
	if (!value) return undefined;
	return editBody(vault, kind, id, body => {
		const lines = body.replace(/\s+$/, "").split("\n");
		const heading = lines.findIndex(line => /^##\s+Todos\s*$/i.test(line));
		if (heading === -1) {
			if (lines.length && lines[lines.length - 1] !== "") lines.push("");
			lines.push("## Todos", `- [ ] ${value}`);
		} else {
			let insert = heading + 1;
			for (let index = heading + 1; index < lines.length; index += 1) {
				if (/^##\s+/.test(lines[index])) break;
				if (TODO_RE.test(lines[index])) insert = index + 1;
			}
			lines.splice(insert, 0, `- [ ] ${value}`);
		}
		return `${lines.join("\n")}\n`;
	});
}

export function toggleTodo(vault, kind, id, index) {
	const todo = listTodos(vault, kind, id)[index];
	if (!todo) return false;
	return Boolean(
		editBody(vault, kind, id, body => {
			const lines = body.split("\n");
			const match = lines[todo.index]?.match(TODO_RE);
			if (!match) return body;
			const box = match[3].toLowerCase() === "x" ? " " : "x";
			lines[todo.index] = `${match[1]}${match[2]} [${box}] ${match[4]}`;
			return lines.join("\n");
		}),
	);
}

export function renameTodo(vault, kind, id, index, text) {
	const value = String(text || "").trim();
	const todo = listTodos(vault, kind, id)[index];
	if (!value || !todo) return false;
	return Boolean(
		editBody(vault, kind, id, body => {
			const lines = body.split("\n");
			const match = lines[todo.index]?.match(TODO_RE);
			if (!match) return body;
			lines[todo.index] = `${match[1]}${match[2]} [${match[3]}] ${value}`;
			return lines.join("\n");
		}),
	);
}

export function deleteTodo(vault, kind, id, index) {
	const todo = listTodos(vault, kind, id)[index];
	if (!todo) return false;
	return Boolean(
		editBody(vault, kind, id, body => {
			const lines = body.split("\n");
			if (!TODO_RE.test(lines[todo.index] || "")) return body;
			lines.splice(todo.index, 1);
			return lines.join("\n");
		}),
	);
}

export function setSessionState(vault, kind, id, state) {
	const patch = { session_state: state || "" };
	return kind === "project" ? Boolean(updateProject(vault, id, patch)) : Boolean(updateItem(vault, id, patch));
}

export function syncSession(vault, kind, id) {
	const target = readTarget(vault, kind, id);
	if (!target) return "";
	const source = sessionFor(vault, kind, { ...target, id: slugify(id) });
	if (!source) {
		if ((target.session || target.session_local) && String(target.session_state || "") !== "stopped") {
			const patch = { session: "", session_local: "", session_state: "" };
			if (kind === "project") updateProject(vault, id, patch);
			else updateItem(vault, id, patch);
		}
		return "";
	}
	const dest = portableSession(vault, kind, id);
	const relative = portableRelative(kind, id);
	mkdirSync(paths(vault).sessions, { recursive: true });
	if (source !== dest) copyFileSync(source, dest);
	const local = source === dest ? "" : source;
	if (String(target.session || "") !== relative || String(target.session_local || "") !== local) {
		const patch = { session: relative, session_local: local };
		if (kind === "project") updateProject(vault, id, patch);
		else updateItem(vault, id, patch);
	}
	return dest;
}

export function syncSessions(vault) {
	let count = 0;
	for (const [kind, dir] of [
		["item", paths(vault).items],
		["project", paths(vault).projects],
	]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".md")) continue;
			if (syncSession(vault, kind, basename(name, ".md"))) count += 1;
		}
	}
	return count;
}

export function stopSession(vault, kind, id) {
	const patch = { session: "", session_local: "", session_state: "stopped" };
	return kind === "project" ? Boolean(updateProject(vault, id, patch)) : Boolean(updateItem(vault, id, patch));
}

export function pauseAll(vault) {
	let count = 0;
	for (const [kind, dir] of [
		["item", paths(vault).items],
		["project", paths(vault).projects],
	]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".md")) continue;
			const target = readTarget(vault, kind, basename(name, ".md"));
			if (target?.session_state === "running") {
				if (syncSession(vault, kind, target.id)) setSessionState(vault, kind, target.id, "paused");
				count += 1;
			}
		}
	}
	return count;
}

export function reconcileSessions(vault, open) {
	const live = new Set(open || []);
	let count = 0;
	for (const [kind, dir] of [
		["item", paths(vault).items],
		["project", paths(vault).projects],
	]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".md")) continue;
			const target = readTarget(vault, kind, basename(name, ".md"));
			if (target?.session_state !== "running") continue;
			if (live.has(`${kind}:${target.id}`)) continue;
			if (syncSession(vault, kind, target.id)) setSessionState(vault, kind, target.id, "paused");
			count += 1;
		}
	}
	return count;
}
