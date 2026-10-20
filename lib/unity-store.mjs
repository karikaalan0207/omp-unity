// Unity store: Obsidian-backed focus, items, projects, and registry.
// Plain markdown + YAML frontmatter. Node builtins only.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const STATUS = ["todo", "active", "blocked", "done"];
const RANK = { active: 0, todo: 1, blocked: 2, done: 3 };

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
	if (!existsSync(p.board)) writeFileSync(p.board, stringifyDoc({ focus: "", updated: nowIso() }, "# Unity board\n"), "utf8");
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
		.map(item => ({
			id: item.id,
			title: String(item.title || item.id),
			status: STATUS.includes(item.status) ? item.status : "todo",
			project: String(item.project || ""),
			session: String(item.session || ""),
			updated: String(item.updated || ""),
		}))
		.sort((a, b) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1) || b.updated.localeCompare(a.updated));
}

export function listProjects(vault) {
	const p = ensure(vault);
	const items = listItems(vault);
	return docs(p.projects)
		.map(project => {
			const own = items.filter(item => item.project === project.id);
			return {
				id: project.id,
				title: String(project.title || project.id),
				status: String(project.status || "active"),
				total: own.length,
				done: own.filter(item => item.status === "done").length,
			};
		})
		.sort((a, b) => a.title.localeCompare(b.title));
}

export function getItem(vault, id) {
	const file = join(paths(vault).items, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	return { id: slugify(id), ...data, body, file };
}

export function getFocus(vault) {
	const board = readDoc(paths(vault).board);
	return String(board.data.focus || "");
}

export function setFocus(vault, id) {
	const p = ensure(vault);
	const board = readDoc(p.board);
	const data = { ...board.data, focus: id || "", updated: nowIso() };
	writeFileSync(p.board, stringifyDoc(data, board.body || "# Unity board\n"), "utf8");
}

export function createItem(vault, { title, project = "" }) {
	const p = ensure(vault);
	const base = slugify(title);
	let id = base;
	for (let n = 2; existsSync(join(p.items, `${id}.md`)); n += 1) id = `${base}-${n}`;
	const stamp = nowIso();
	writeFileSync(
		join(p.items, `${id}.md`),
		stringifyDoc(
			{ id, title, status: "todo", project, session: "", created: stamp, updated: stamp },
			`# ${title}\n\n`,
		),
		"utf8",
	);
	return { id, title, status: "todo", project, session: "", updated: stamp };
}

export function updateItem(vault, id, patch) {
	const p = ensure(vault);
	const file = join(p.items, `${slugify(id)}.md`);
	const { data, body } = readDoc(file);
	if (!Object.keys(data).length) return undefined;
	const next = { ...data, ...patch, updated: nowIso() };
	writeFileSync(file, stringifyDoc(next, body || `# ${next.title || id}\n`), "utf8");
	return { id: slugify(id), ...next };
}

export function createProject(vault, { title }) {
	const p = ensure(vault);
	const base = slugify(title);
	let id = base;
	for (let n = 2; existsSync(join(p.projects, `${id}.md`)); n += 1) id = `${base}-${n}`;
	const stamp = nowIso();
	writeFileSync(
		join(p.projects, `${id}.md`),
		stringifyDoc({ id, title, status: "active", created: stamp, updated: stamp }, `# ${title}\n\n`),
		"utf8",
	);
	return { id, title, status: "active" };
}

export function initVault(vault) {
	const p = ensure(vault);
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
