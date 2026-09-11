/**
 * Deterministic fallback-chain probe. Burns zero real provider quota.
 *
 * Stands up a local OpenAI-compatible server exposing two models:
 *   - `always-429`  always answers HTTP 429 (rate limit)
 *   - `healthy`     answers a normal completion
 *
 * It then points a throwaway GJC_AGENT_DIR at a models.yml whose profile chains
 * `[fixture/always-429, fixture/healthy]`, runs the real `gjc` binary in print
 * mode, and asserts that the reply came from `healthy` — i.e. the chain actually
 * descended on a request-time 429 instead of failing the turn.
 *
 * Run: bun run tests/fallback-probe.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKER = "FALLBACK_PROBE_OK";
const hits: string[] = [];

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({
				object: "list",
				data: ["always-429", "healthy"].map(id => ({ id, object: "model", owned_by: "fixture" })),
			});
		}
		const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
		const model = body.model ?? "unknown";
		hits.push(model);
		if (model.includes("always-429")) {
			return Response.json(
				{ error: { message: "Rate limit reached for requests", type: "rate_limit_error", code: "rate_limit_exceeded" } },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		}
		if (!body.stream) {
			return Response.json({
				id: "chatcmpl-probe",
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, message: { role: "assistant", content: MARKER }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		const created = Math.floor(Date.now() / 1000);
		const frame = (delta: Record<string, unknown>, finish: string | null) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-probe",
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		const sse =
			frame({ role: "assistant", content: "" }, null) +
			frame({ content: MARKER }, null) +
			frame({}, "stop") +
			`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
			"data: [DONE]\n\n";
		return new Response(sse, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
		});
	},
});

// GJC resolves its agent dir as <HOME>/<GJC_CONFIG_DIR>/agent, and GJC_CONFIG_DIR
// is only a home-relative NAME. Isolation therefore has to go through HOME.
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fallback-probe-"));
const agentDir = path.join(probeHome, ".gjc", "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
	path.join(agentDir, "models.yml"),
	`providers:
  fixture:
    baseUrl: http://127.0.0.1:${server.port}/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: always-429
        name: Always 429
        contextWindow: 32768
        maxTokens: 4096
      - id: healthy
        name: Healthy
        contextWindow: 32768
        maxTokens: 4096
profiles:
  fallback-probe:
    required_providers: [fixture]
    model_mapping:
      default: [fixture/always-429, fixture/healthy]
`,
);

console.log(`fixture server: http://127.0.0.1:${server.port}`);
console.log(`agent dir:      ${agentDir}\n`);

// A GJC session exports GJC_CODING_AGENT_DIR (and friends) to its children, which
// would drag the probe back onto the real config. Strip every GJC_* inheritance.
const cleanEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GJC_") && !key.startsWith("PI_CONFIG")),
) as Record<string, string>;

// Must be async: Bun.spawnSync blocks this process's event loop, which would stop
// the fixture server above from ever answering and deadlock the probe.
const proc = Bun.spawn({
	cmd: ["gjc", "--mpreset", "fallback-probe", "-p", "Reply with exactly: ping"],
	env: { ...cleanEnv, HOME: probeHome, USERPROFILE: probeHome },
	stdout: "pipe",
	stderr: "pipe",
});

const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
await proc.exited;
console.log("--- gjc stdout ---\n" + stdout.trim());
if (stderr.trim()) console.log("--- gjc stderr ---\n" + stderr.trim());

const bad429 = hits.filter(m => m.includes("always-429")).length;
const good = hits.filter(m => m === "healthy").length;
console.log(`\n--- upstream hits ---\nalways-429: ${bad429}\nhealthy:    ${good}\nsequence:   ${hits.join(" -> ") || "(none)"}`);

server.stop(true);

const descended = bad429 > 0 && good > 0 && stdout.includes(MARKER);
console.log(
	`\nRESULT: ${descended ? "PASS - chain descended past the 429 entry and answered from the healthy entry" : "FAIL - chain did not descend; see output above"}`,
);
process.exit(descended ? 0 : 1);
