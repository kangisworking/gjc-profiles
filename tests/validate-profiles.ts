/**
 * Static profile validation. No API calls, no quota, no provider traffic.
 *
 * Cross-checks every selector in models.yml against the live GJC catalog
 * (`gjc --list-models`) and asserts:
 *   1. the model exists in that provider's catalog
 *   2. the requested thinking level is one the model actually supports
 *   3. no selector escapes the profile's own `required_providers`
 *      (this is what keeps a `claude-*` profile from silently calling OpenAI)
 *
 * Run: bun run tests/validate-profiles.ts [models.yml]
 */
import * as YAML from "yaml";

const target = process.argv[2] ?? "models.yml";

const listing = Bun.spawnSync({ cmd: ["gjc", "--list-models"], stdout: "pipe", stderr: "pipe" });
const catalogText = listing.stdout.toString();
if (!catalogText.trim()) {
	console.error("Could not read the GJC catalog via `gjc --list-models`.");
	console.error(listing.stderr.toString().trim());
	process.exit(2);
}

/** provider/modelId -> supported thinking levels */
const catalog = new Map<string, Set<string>>();
for (const line of catalogText.split("\n")) {
	const m = /^(\S+)\s+(\S+)\s+[\d.]+[KM]\s+[\d.]+[KM]\s+(\S+)\s+(yes|no)\s*$/.exec(line);
	if (!m) continue;
	catalog.set(`${m[1]}/${m[2]}`, new Set(m[3] === "-" ? [] : m[3].split(",")));
}
if (catalog.size === 0) {
	console.error("Parsed zero catalog rows; the `gjc --list-models` output format may have changed.");
	process.exit(2);
}

const doc = YAML.parse(await Bun.file(target).text()) as {
	profiles?: Record<string, { required_providers?: string[]; model_mapping?: Record<string, string | string[]> }>;
};
const profiles = doc.profiles ?? {};

const problems: string[] = [];
let selectorCount = 0;

for (const [name, def] of Object.entries(profiles)) {
	const required = def.required_providers ?? [];
	const mapping = def.model_mapping ?? {};
	if (Object.keys(mapping).length === 0) problems.push(`${name}: empty model_mapping`);

	for (const [role, value] of Object.entries(mapping)) {
		const chain = Array.isArray(value) ? value : [value];
		if (chain.length === 0) problems.push(`${name}.${role}: empty chain`);
		if (new Set(chain).size !== chain.length) problems.push(`${name}.${role}: duplicate entries in chain`);

		for (const selector of chain) {
			selectorCount++;
			const sep = selector.lastIndexOf(":");
			const hasLevel = sep > selector.indexOf("/");
			const modelKey = hasLevel ? selector.slice(0, sep) : selector;
			const level = hasLevel ? selector.slice(sep + 1) : undefined;

			const levels = catalog.get(modelKey);
			if (!levels) {
				problems.push(`${name}.${role}: "${selector}" is not in the catalog`);
				continue;
			}
			if (level && !levels.has(level)) {
				problems.push(
					`${name}.${role}: "${selector}" uses thinking level "${level}"; supported: ${[...levels].join(",") || "none"}`,
				);
			}
			const provider = modelKey.slice(0, modelKey.indexOf("/"));
			if (provider && required.length > 0 && !required.includes(provider)) {
				problems.push(`${name}.${role}: "${selector}" leaves required_providers [${required.join(", ")}]`);
			}
		}
	}
}

const profileNames = Object.keys(profiles);
console.log(`${target}: ${profileNames.length} profiles, ${selectorCount} selectors checked against ${catalog.size} catalog models\n`);
for (const [name, def] of Object.entries(profiles)) {
	const chains = Object.values(def.model_mapping ?? {}).map(v => (Array.isArray(v) ? v.length : 1));
	const chained = chains.filter(n => n > 1).length;
	console.log(
		`  ${name.padEnd(16)} providers=[${(def.required_providers ?? []).join(",")}] roles=${chains.length} chained-roles=${chained}`,
	);
}

if (problems.length > 0) {
	console.log(`\n${problems.length} problem(s):`);
	for (const p of problems) console.log(`  - ${p}`);
	process.exit(1);
}
console.log("\nRESULT: PASS - every selector exists, every thinking level is supported, no provider escapes its profile");
