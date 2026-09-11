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
/** Every non-default role. These bind only when GJC actually delegates to them. */
const ROLES = ["executor", "planner", "architect", "critic"] as const;
const TIMEOUT_MS = 900_000;
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

interface RoleResult {
	role: string;
	want: string;
	got: string[];
	ran: boolean;
	ok: boolean;
}

interface Result {
	profile: string;
	delegated: boolean;
	matched: boolean;
	roles: RoleResult[];
	chains: string[];
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
			"Make exactly four separate task tool calls, one per agent type, in this order: executor, then planner, then architect, then critic. Each call launches exactly one subagent whose entire assignment is to read input.txt in this directory and report how many lines it has. Do not read input.txt yourself and do not skip any of the four agent types.",
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

	// The binding contract: each role's turns are served by a model from that
	// role's chain. Token-log rows name the model that actually served the turn,
	// which is stronger evidence than a configured chain record.
	const bare = (entry: string) => entry.replace(/^[^/]+\//, "").replace(/:[^:]*$/, "");
	const served = new Map<string, Set<string>>();
	for (const row of subagentModels) {
		const agent = row.slice(0, row.indexOf(":"));
		const model = row.slice(row.indexOf(":") + 1);
		if (!served.has(agent)) served.set(agent, new Set());
		served.get(agent)?.add(model);
	}
	const roles = ROLES.map(role => {
		const want = expectedChain(profile, role);
		const allowed = new Set(want.map(bare));
		const got = [...(served.get(role) ?? [])];
		return {
			role,
			want: want.join(" -> "),
			got,
			ran: got.length > 0,
			ok: got.length > 0 && got.every(m => allowed.has(m)),
		};
	});
	return {
		profile,
		delegated: subagentModels.length > 0,
		matched: roles.every(r => r.ok),
		roles,
		chains: [...new Set(chains.map(c => c.join(" -> ")))],
		seconds,
	};
}

const results: Result[] = [];
for (const profile of profiles) {
	process.stdout.write(`running ${profile} ... `);
	const r = await runProfile(profile);
	const ran = r.roles.filter(x => x.ran).length;
	console.log(`roles-exercised=${ran}/${ROLES.length} match=${r.matched ? "PASS" : "FAIL"} (${r.seconds}s)`);
	results.push(r);
}

console.log("\nper-role routing, intended chain vs the model that actually served the subagent turns:");
for (const r of results) {
	console.log(`  ${r.profile}`);
	for (const role of r.roles) {
		const status = !role.ran ? "NOT EXERCISED" : role.ok ? "ok" : "MISMATCH";
		console.log(`    ${role.role.padEnd(10)}${status.padEnd(15)}served=${role.got.join(",") || "-"}`);
		if (!role.ok) console.log(`    ${"".padEnd(10)}want=${role.want}`);
	}
}

const failed = results.filter(r => !r.matched);
const unexercised = results.flatMap(r => r.roles.filter(x => !x.ran).map(x => `${r.profile}.${x.role}`));
if (unexercised.length > 0) console.log(`\nnot exercised (no subagent turns recorded): ${unexercised.join(", ")}`);
console.log(
	`\nRESULT: ${failed.length === 0 ? `PASS - every exercised role was served by its assigned chain` : `FAIL - ${failed.map(f => f.profile).join(", ")}`}`,
);
process.exit(failed.length === 0 ? 0 : 1);
