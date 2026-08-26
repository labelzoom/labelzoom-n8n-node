#!/usr/bin/env node
/**
 * Vendor the shared conformance fixtures from labelzoom-sdk into test/conformance/.
 *
 * The fixtures are the normative wire contract every LabelZoom client is held to,
 * and this node re-implements that contract by hand (n8n verification forbids
 * runtime dependencies, so it cannot just call @labelzoom/sdk). Running the same
 * fixtures is what keeps the two from drifting.
 *
 * A pinned copy rather than a git submodule: CI for a community node has to work
 * on fork pull requests with no credentials and no submodule init, and a fixture
 * change should be a reviewable diff in this repo rather than a silent pointer
 * move. `--check` re-syncs into a temp directory and fails if anything differs,
 * which is what CI runs.
 *
 *   node scripts/sync-conformance.mjs           # update the vendored copy
 *   node scripts/sync-conformance.mjs --check   # verify it is in sync (CI)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/labelzoom/labelzoom-sdk.git';
/** Bump deliberately, and review the fixture diff when you do. */
const REF = 'node/v1.0.0';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'test', 'conformance');
const check = process.argv.includes('--check');

function fetchInto(target) {
	const workdir = mkdtempSync(join(tmpdir(), 'labelzoom-conformance-'));
	try {
		execFileSync(
			'git',
			['clone', '--depth', '1', '--branch', REF, '--filter=blob:none', '--sparse', REPO, workdir],
			{ stdio: 'inherit' },
		);
		execFileSync('git', ['sparse-checkout', 'set', 'conformance'], { cwd: workdir, stdio: 'inherit' });
		const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();

		rmSync(target, { recursive: true, force: true });
		cpSync(join(workdir, 'conformance'), target, { recursive: true });

		const spec = JSON.parse(readFileSync(join(target, 'spec.json'), 'utf8'));
		writeFileSync(
			join(target, 'VENDORED.json'),
			`${JSON.stringify({ repo: REPO, ref: REF, commit, specVersion: spec.version }, null, 2)}\n`,
		);
		return { commit, specVersion: spec.version, caseCount: spec.caseCount };
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

if (check) {
	if (!existsSync(destination)) {
		console.error('test/conformance/ is missing. Run: npm run sync-conformance');
		process.exit(1);
	}
	const scratch = mkdtempSync(join(tmpdir(), 'labelzoom-conformance-check-'));
	try {
		const target = join(scratch, 'conformance');
		fetchInto(target);
		// diff -r exits non-zero on any difference, and prints what moved.
		try {
			execFileSync('diff', ['-r', destination, target], { stdio: 'inherit' });
		} catch {
			console.error(
				`\ntest/conformance/ has drifted from ${REF}. Run: npm run sync-conformance`,
			);
			process.exit(1);
		}
		console.log(`test/conformance/ matches labelzoom-sdk@${REF}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
} else {
	const { commit, specVersion, caseCount } = fetchInto(destination);
	console.log(`Vendored conformance spec ${specVersion} (${caseCount} cases) from ${REF} @ ${commit}`);
}
