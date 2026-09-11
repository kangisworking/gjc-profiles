/**
 * Do the non-default roles actually route to the models the profile assigns?
 *
 * `default` is proven by functional-smoke.ts, but `executor` / `planner` /
 * `architect` / `critic` only bind when GJC really delegates. This probe forces a
 * delegation and then reads GJC's own subagent records.
 *
 * Evidence used (all produced by GJC, not re-read from config):
 *   - subagent session files carry `configured_model_chain` with origin=subagent
 *   - the project-local token log carries per-turn rows tagged with subagentId,
 *     agent and the model that actually served that turn
 *
 * Spends real quota. Never passes --default.
 *
 * Run: bun run tests/delegation-probe.ts [profile ...]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

const DEFAULT_PROFILES = ["claude-fast", "claude-max", "claude-ultra", "openai-fast", "openai-max", "openai-ultra"];
const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PROFILES;
const TIMEOUT_MS = 600_000;
const SESSIONS = path.join(os.homedir(), ".gjc", "agent", "sessions");

const doc = YAML.parse(await Bun.file("models.yml").text()) as {
	profiles: Record<string, { model_mapping: Record<string, string | string[]> }>;
};

function expectedChain(profile: string, role: string): string[] {
	const value = doc.profiles?.[profile]?.model_mapping?.[role];
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

/** Directory that holds the parent session file plus one file per subagent. */
function sessionDir(sessionId: string): string | undefined {
	let found: string | undefined;
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.includes(sessionId)) found = full;
				else walk(full);
			}
		}
	};
	try {
		walk(SESSIONS);
	} catch {
		/* none */
	}
	return found;
}

function subagentChains(dir: string): string[][] {
	const chains: string[][] = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e.type === "configured_model_chain" && e.origin === "subagent") chains.push(e.entries as string[]);
			} catch {
				/* tolerate partial lines */
			}
		}
	}
	return chains;
}

interface Result {
	profile: string;
	delegated: boolean;
	matched: boolean;
	chains: string[];
	subagentModels: string[];
	want: string;
	seconds: number;
}

async function runProfile(profile: string): Promise<Result> {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-deleg-${profile}-`));
	fs.writeFileSync(path.join(workdir, "input.txt"), Array.from({ length: 21 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");

	const started = Date.now();
	const proc = Bun.spawn({
		cmd: [
			"gjc",
			"--mpreset",
			profile,
			"-p",
			"Use the task tool to launch exactly one executor subagent. That subagent must count the lines in input.txt in this directory and write the number alone into answer.txt. Do not do the counting yourself; delegate it.",
		],
		cwd: workdir,
		env: process.env as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
	await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	clearTimeout(timer);
	const seconds = Math.round((Date.now() - started) / 1000);

	// Per-turn rows tagged with the subagent that produced them.
	const subagentModels: string[] = [];
	try {
		const root = path.join(workdir, ".gjc");
		const walk = (dir: string): string[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
				const full = path.join(dir, e.name);
				return e.isDirectory() ? walk(full) : e.name === "token-log.jsonl" ? [full] : [];
			});
		for (const file of walk(root)) {
			for (const line of fs.readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const e = JSON.parse(line);
					if (e.subagentId && e.subagentId !== "root") subagentModels.push(`${e.agent ?? e.subagentId}:${e.model}`);
				} catch {
					/* tolerate partial lines */
				}
			}
		}
	} catch {
		/* best effort */
	}

	let sessionId = "";
	try {
		const dir = fs.readdirSync(path.join(workdir, ".gjc")).find(d => d.startsWith("_session-"));
		if (dir) sessionId = dir.slice("_session-".length);
	} catch {
		/* none */
	}
	const dir = sessionId ? sessionDir(sessionId) : undefined;
	const chains = dir ? subagentChains(dir) : [];

	fs.rmSync(workdir, { recursive: true, force: true });

	const want = expectedChain(profile, "executor");
	const flat = chains.map(c => c.join(" -> "));
	// The binding contract is that executor turns are served by a model from the
	// executor chain. Token-log rows name the model that actually served the turn,
	// which is stronger evidence than a configured chain record.
	const allowed = new Set(want.map(entry => entry.replace(/^[^/]+\//, "").replace(/:[^:]*$/, "")));
	const servedModels = subagentModels.map(s => s.slice(s.indexOf(":") + 1));
	const matched =
		(servedModels.length > 0 && servedModels.every(m => allowed.has(m))) || flat.some(c => c === want.join(" -> "));
	return {
		profile,
		delegated: chains.length > 0 || subagentModels.length > 0,
		matched,
		chains: [...new Set(flat)],
		subagentModels: [...new Set(subagentModels)],
		want: want.join(" -> "),
		seconds,
	};
}

const results: Result[] = [];
for (const profile of profiles) {
	process.stdout.write(`running ${profile} ... `);
	const r = await runProfile(profile);
	console.log(`delegated=${r.delegated ? "yes" : "NO"} executor-match=${r.matched ? "PASS" : "FAIL"} (${r.seconds}s)`);
	results.push(r);
}

console.log("\nexecutor role, intended vs what GJC recorded for the subagent:");
for (const r of results) {
	console.log(`  ${r.profile}`);
	console.log(`    want: ${r.want}`);
	console.log(`    got:  ${r.chains.join(" | ") || "(no subagent chain recorded)"}`);
	if (r.subagentModels.length > 0) console.log(`    turns: ${r.subagentModels.join(", ")}`);
}

const failed = results.filter(r => !r.matched);
console.log(
	`\nRESULT: ${failed.length === 0 ? `PASS - every profile routed its executor subagent to the assigned chain` : `FAIL - ${failed.map(f => f.profile).join(", ")}`}`,
);
process.exit(failed.length === 0 ? 0 : 1);
