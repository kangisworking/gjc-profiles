/**
 * Does each profile (a) bind the models it claims, and (b) actually do work?
 *
 * This is a function test, not a cost benchmark. Per profile it runs the real
 * `gjc` binary on a task that text generation alone cannot fake — the agent must
 * read a file, count its lines, and write the answer to a second file.
 *
 * Two independent assertions per profile:
 *   BINDING  the session's `configured_model_chain` record with
 *            origin=profile-activation must equal the chain declared in
 *            models.yml, in order, thinking levels included. This is GJC's own
 *            runtime record, not a re-reading of the config.
 *   WORK     answer.txt must contain the correct line count.
 *
 * Uses real credentials and spends real quota. Never passes --default, so the
 * user's persisted default profile is untouched.
 *
 * Run: bun run tests/functional-smoke.ts [profile ...]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

const DEFAULT_PROFILES = ["claude-fast", "claude-max", "claude-ultra", "openai-fast", "openai-max", "openai-ultra"];
const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PROFILES;

/** Distinctive count so a guessed answer is unlikely to be correct. */
const LINE_COUNT = 37;
const TIMEOUT_MS = 420_000;
const SESSIONS = path.join(os.homedir(), ".gjc", "agent", "sessions");

const doc = YAML.parse(await Bun.file("models.yml").text()) as {
	profiles: Record<string, { model_mapping: Record<string, string | string[]> }>;
};

function expectedDefaultChain(profile: string): string[] {
	const value = doc.profiles?.[profile]?.model_mapping?.default;
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

/** The chain GJC itself recorded for the default role when the profile activated. */
function recordedChain(sessionId: string): string[] | undefined {
	let file: string | undefined;
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) file = full;
		}
	};
	try {
		walk(SESSIONS);
	} catch {
		return undefined;
	}
	if (!file) return undefined;
	let chain: string[] | undefined;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			// Last profile-activation wins: the persisted default profile activates
			// first, then --mpreset overrides it.
			if (e.type === "configured_model_chain" && e.role === "default" && e.origin === "profile-activation") {
				chain = e.entries as string[];
			}
		} catch {
			/* tolerate partial lines */
		}
	}
	return chain;
}

interface Result {
	profile: string;
	work: boolean;
	binding: boolean;
	answer: string;
	seconds: number;
	got: string;
	want: string;
	note: string;
}

async function runProfile(profile: string): Promise<Result> {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-smoke-${profile}-`));
	fs.writeFileSync(
		path.join(workdir, "input.txt"),
		Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
	);

	const started = Date.now();
	const proc = Bun.spawn({
		cmd: [
			"gjc",
			"--mpreset",
			profile,
			"-p",
			"Count the lines in input.txt in this directory, then write that number alone into a new file named answer.txt. answer.txt must contain only the digits, nothing else.",
		],
		cwd: workdir,
		env: process.env as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
	const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	clearTimeout(timer);
	const seconds = Math.round((Date.now() - started) / 1000);

	const answerPath = path.join(workdir, "answer.txt");
	const answer = fs.existsSync(answerPath) ? fs.readFileSync(answerPath, "utf8").trim() : "";
	const work = answer === String(LINE_COUNT);

	// Session id is the suffix of the project-local session state dir.
	let sessionId = "";
	try {
		const dir = fs.readdirSync(path.join(workdir, ".gjc")).find(d => d.startsWith("_session-"));
		if (dir) sessionId = dir.slice("_session-".length);
	} catch {
		/* no session state */
	}
	const got = sessionId ? (recordedChain(sessionId) ?? []) : [];
	const want = expectedDefaultChain(profile);
	const binding = got.length > 0 && got.length === want.length && got.every((e, i) => e === want[i]);

	fs.rmSync(workdir, { recursive: true, force: true });
	return {
		profile,
		work,
		binding,
		answer: answer || "-",
		seconds,
		got: got.join(" -> ") || "(none recorded)",
		want: want.join(" -> "),
		note: work ? "" : stderr.trim().split("\n").pop() || "no answer.txt produced",
	};
}

const results: Result[] = [];
for (const profile of profiles) {
	process.stdout.write(`running ${profile} ... `);
	const r = await runProfile(profile);
	console.log(
		`work=${r.work ? "PASS" : "FAIL"} binding=${r.binding ? "PASS" : "FAIL"} (${r.seconds}s)${r.note ? ` ${r.note}` : ""}`,
	);
	if (!r.binding) console.log(`    want: ${r.want}\n    got:  ${r.got}`);
	results.push(r);
}

console.log(`\n${"profile".padEnd(14)}${"work".padEnd(7)}${"binding".padEnd(10)}${"answer".padEnd(8)}sec`);
for (const r of results) {
	console.log(
		`${r.profile.padEnd(14)}${(r.work ? "PASS" : "FAIL").padEnd(7)}${(r.binding ? "PASS" : "FAIL").padEnd(10)}${r.answer.padEnd(8)}${r.seconds}`,
	);
}
console.log("\nresolved default chains recorded by GJC at profile activation:");
for (const r of results) console.log(`  ${r.profile.padEnd(14)}${r.got}`);

const failed = results.filter(r => !r.work || !r.binding);
console.log(
	`\nRESULT: ${failed.length === 0 ? `PASS - all ${results.length} profiles bound the intended models and completed the task` : `FAIL - ${failed.map(f => f.profile).join(", ")}`}`,
);
process.exit(failed.length === 0 ? 0 : 1);
