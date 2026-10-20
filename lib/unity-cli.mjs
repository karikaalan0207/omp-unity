// Small CLI used by the shell launcher. Prints one value, exits non-zero on miss.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createItem,
	createProject,
	getFocus,
	getItem,
	addRegistryEntry,
	initVault,
	linkSkills,
	listItems,
	listProjects,
	paths,
	readDoc,
	setFocus,
	updateItem,
} from "./unity-store.mjs";

const [command, vault, ...args] = process.argv.slice(2);

function out(value = "") {
	process.stdout.write(String(value));
}

try {
	switch (command) {
		case "init":
			initVault(vault);
			break;
		case "items":
			for (const item of listItems(vault)) {
				out(`${item.id}\t${item.status}\t${item.project}\t${item.title}\n`);
			}
			break;
		case "projects":
			for (const project of listProjects(vault)) {
				out(`${project.id}\t${project.status}\t${project.done}/${project.total}\n`);
			}
			break;
		case "item": {
			const item = getItem(vault, args[0]);
			if (!item) process.exit(1);
			out(`${item.status}\t${item.session || ""}\t${item.title}\n`);
			break;
		}
		case "session":
			out(getItem(vault, args[0])?.session || "");
			break;
		case "session-clear":
			updateItem(vault, args[0], { session: "" });
			break;
		case "status":
			updateItem(vault, args[0], { status: args[1] });
			break;
		case "new":
			out(`${createItem(vault, { title: args[0], project: args[1] || "" }).id}\n`);
			break;
		case "project":
			out(`${createProject(vault, { title: args[0] }).id}\n`);
			break;
		case "focus":
			out(getFocus(vault));
			break;
		case "focus-set":
			setFocus(vault, args[0]);
			break;
		case "prompt": {
			const item = getItem(vault, args[0]);
			if (!item) process.exit(1);
			const status = item.status === "focus" || item.status === "active" ? "focus" : "stash";
			const project = item.project || "";
			let projectLine = "Project: inbox";
			if (project) {
				const doc = readDoc(join(paths(vault).projects, `${project}.md`));
				const title = doc.data.title || project;
				const notes = String(doc.body || "").replace(/\s+/g, " ").trim().slice(0, 240);
				projectLine = `Project: ${title} (${project})${notes ? ` — ${notes}` : ""}`;
			}
			const body = String(item.body || "").replace(/\s+/g, " ").trim().slice(0, 700);
			const siblings = listItems(vault)
				.filter(other => other.project === project && other.id !== item.id)
				.slice(0, 8)
				.map(other => `- [${other.status}] ${other.title}`)
				.join("\n");
			let previous = "";
			if (args.includes("--with-session") && item.session) {
				try {
					const lines = readFileSync(String(item.session), "utf8").trim().split("\n").slice(-80);
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
					previous = messages.slice(-4).join("\n");
				} catch {
					previous = "";
				}
			}
			out(
				`Unity item: "${item.title}" (id: ${item.id}, status: ${status})\n` +
					`${projectLine}\n` +
					`Item file: ${item.file}\n` +
					(body ? `Item notes: ${body}\n` : "") +
					(siblings ? `Other items in this project:\n${siblings}\n` : "") +
					(previous ? `Recent session:\n${previous}\n` : "") +
					"Read the item file, work on this, and update its status when done.\n",
			);
			break;
		}
		case "registry-skill":
			addRegistryEntry(vault, "skills", { name: args[0], path: args[1] });
			break;
		case "registry-repo":
			addRegistryEntry(vault, "repos", { name: args[0], url: args[1] });
			break;
		case "link-skills":
			for (const linked of linkSkills(vault, args[0])) out(`${linked}\n`);
			break;
		default:
			process.stderr.write("usage: unity-cli.mjs <init|items|projects|item|session|status|new|project|focus|focus-set> <vault> ...\n");
			process.exit(2);
	}
} catch (error) {
	process.stderr.write(`${error?.message || error}\n`);
	process.exit(1);
}
