import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What each entry point exports at runtime. Adding a name here is a minor
 * release and removing one is a major, so the list is written down rather
 * than derived: a diff on this object is the thing a release has to explain.
 */
const SURFACE: Record<string, readonly string[]> = {
	"mycocepurus-smithii": [
		"Ledger",
		"MemoryStore",
		"MycocepurusError",
		"assertKey",
		"decide",
		"fingerprint",
		"storeAnything",
	],
	"mycocepurus-smithii/http": [
		"fingerprintRequest",
		"fromStored",
		"idempotent",
		"readKey",
		"statusFor",
		"toStored",
	],
};

function npm(args: string[], cwd: string): string {
	// npm sets npm_execpath when it runs us, which avoids the .cmd shim that
	// execFileSync cannot spawn on Windows without a shell.
	const cli = process.env.npm_execpath;
	if (cli !== undefined && cli.endsWith(".js")) {
		return execFileSync(process.execPath, [cli, ...args], {
			cwd,
			encoding: "utf8",
			timeout: 300_000,
		});
	}
	return execFileSync("npm", args, {
		cwd,
		encoding: "utf8",
		timeout: 300_000,
		shell: process.platform === "win32",
	});
}

const workspace = mkdtempSync(path.join(tmpdir(), "mycocepurus-artifact-"));
after(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const project = path.join(workspace, "consumer");
mkdirSync(project);
writeFileSync(
	path.join(project, "package.json"),
	`${JSON.stringify({ name: "mycocepurus-consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`
);

npm(["run", "build"], root);
const tarball =
	npm(["pack", "--pack-destination", workspace, "--silent"], root)
		.trim()
		.split("\n")
		.at(-1) ?? "";
npm(
	["install", "--no-audit", "--no-fund", "--no-package-lock", path.join(workspace, tarball)],
	project
);

const installed = path.join(project, "node_modules", "mycocepurus-smithii");

/** Runs ESM in the consumer project, so imports resolve the way a user's do. */
function inConsumer(source: string): { stdout: string; stderr: string } {
	const run = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			// The trailing exit runs once stdout has drained, so a timer or handle
			// left behind by an import fails the assertion below instead of keeping
			// this child alive until the timeout.
			"--eval",
			`${source}\nprocess.stdout.write("", () => { process.exit(0); });`,
		],
		{ cwd: project, encoding: "utf8", timeout: 60_000 }
	);
	assert.equal(
		run.status,
		0,
		`the consumer script failed:\n${run.stdout}\n${run.stderr}`
	);
	return { stdout: run.stdout, stderr: run.stderr };
}

test("the tarball carries every path the exports map points at, and no sources", () => {
	const manifest = JSON.parse(
		readFileSync(path.join(installed, "package.json"), "utf8")
	) as { exports: Record<string, string | Record<string, string>> };

	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		const targets = typeof entry === "string" ? [entry] : Object.values(entry);
		for (const target of targets) {
			assert.ok(
				existsSync(path.join(installed, target)),
				`exports["${subpath}"] points at ${target}, which the tarball does not carry`
			);
		}
	}

	for (const excluded of [
		"src",
		"tests",
		"guides",
		"index.ts",
		"http.ts",
		"tsconfig.json",
		"eslint.config.mjs",
		".github",
	]) {
		assert.ok(
			!existsSync(path.join(installed, excluded)),
			`${excluded} was published`
		);
	}
});

test("the built entry points export exactly the public surface", () => {
	const { stdout } = inConsumer(`
		const surface = {};
		for (const specifier of ${JSON.stringify(Object.keys(SURFACE))}) {
			surface[specifier] = Object.keys(await import(specifier)).sort();
		}
		console.log(JSON.stringify(surface));
	`);

	assert.deepEqual(
		JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"),
		Object.fromEntries(
			Object.entries(SURFACE).map(([specifier, names]) => [
				specifier,
				[...names].sort(),
			])
		)
	);
});

test("importing either entry point prints nothing and holds nothing open", () => {
	const { stdout, stderr } = inConsumer(`
		const before = process.getActiveResourcesInfo().sort();
		for (const specifier of ${JSON.stringify(Object.keys(SURFACE))}) {
			await import(specifier);
		}
		const held = process.getActiveResourcesInfo().sort();
		console.log(JSON.stringify({ before, held }));
	`);

	const lines = stdout.trim().split("\n");
	const { before, held } = JSON.parse(lines.at(-1) ?? "{}") as {
		before: string[];
		held: string[];
	};

	assert.deepEqual(
		held,
		before,
		"importing mycocepurus-smithii opened a handle or scheduled a timer"
	);
	assert.deepEqual(lines.slice(0, -1), [], "importing mycocepurus-smithii wrote to stdout");
	assert.equal(stderr, "", "importing mycocepurus-smithii wrote to stderr");
});

test("a ledger built from the tarball runs once, replays, and refuses as itself", () => {
	const { stdout } = inConsumer(`
		import { Ledger, MemoryStore, MycocepurusError, storeAnything } from "mycocepurus-smithii";
		import { idempotent, statusFor } from "mycocepurus-smithii/http";

		const ledger = new Ledger({
			store: new MemoryStore({ maxEntries: 4 }),
			retainFor: 60_000,
			leaseFor: 1_000,
			maxKeyLength: 64,
			shouldStore: storeAnything,
		});

		let calls = 0;
		const send = idempotent(ledger, async () => {
			calls += 1;
			return Response.json({ id: calls }, { status: 201 });
		}, {
			scope: () => "alice",
			refuse: (error) => new Response(error.code, { status: statusFor(error) }),
		});

		const request = () => new Request("https://api.example/payments", {
			method: "POST",
			headers: { "Idempotency-Key": '"k1"' },
			body: "{}",
		});
		const first = await send(request());
		const retry = await send(request());
		const bare = await send(new Request("https://api.example/payments", { method: "POST", body: "{}" }));

		let code;
		try {
			new MemoryStore({ maxEntries: 0 });
		} catch (error) {
			code = error instanceof MycocepurusError ? error.code : "not-ours";
		}

		console.log(JSON.stringify([calls, first.status, await retry.json(), bare.status, code]));
	`);

	assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]"), [
		1,
		201,
		{ id: 1 },
		400,
		"invalid-options",
	]);
});
