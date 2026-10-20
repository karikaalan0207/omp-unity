// Small CLI used by the shell launcher. Prints one value, exits non-zero on miss.

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
			const project = item.project || "inbox";
			const body = String(item.body || "").replace(/\s+/g, " ").trim().slice(0, 300);
			out(
				`You are working on the Unity item "${item.title}" (id: ${item.id}, project: ${project}, status: ${item.status}).\n` +
					`Item file: ${item.file}.\n` +
					(body ? `Notes: ${body}\n` : "") +
					"Work on this item. Update its status/session when done.\n",
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
