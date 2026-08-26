#!/usr/bin/env node
// Validates the conformance fixture set. Run with `node conformance/lint.mjs`.
//
// This guards the fixtures themselves, not the SDKs. The SDK-side guarantee -- that every
// language actually executes every case -- is enforced by each runner asserting
// `executed == spec.cases - skips[lang]`. See docs/CONFORMANCE.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..');
const KINDS = ['request', 'response', 'retry', 'validation', 'typecheck'];

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const spec = readJson(join(ROOT, 'spec.json'));

// ---------------------------------------------------------------- discover cases
const onDisk = [];
for (const kind of KINDS) {
  const dir = join(ROOT, 'cases', kind);
  if (!existsSync(dir)) {
    fail('spec.json', `missing case directory cases/${kind}`);
    continue;
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) {
      fail(`cases/${kind}/${file}`, 'non-JSON file in a case directory');
      continue;
    }
    onDisk.push(`${kind}/${file.slice(0, -5)}`);
  }
}
onDisk.sort();

// ------------------------------------------------- spec.json agrees with the disk
const declared = new Set(spec.cases);
for (const id of onDisk) {
  if (!declared.has(id)) fail('spec.json', `case exists on disk but is not listed: ${id}`);
}
for (const id of spec.cases) {
  if (!onDisk.includes(id)) fail('spec.json', `case is listed but has no file: ${id}`);
}
if (spec.caseCount !== spec.cases.length) {
  fail('spec.json', `caseCount ${spec.caseCount} != cases.length ${spec.cases.length}`);
}

// ------------------------------------------------------------- per-case validation
const KNOWN_KINDS = new Set(spec.errorKinds);

for (const id of onDisk) {
  const [kind, name] = id.split('/');
  const c = readJson(join(ROOT, 'cases', kind, `${name}.json`));

  if (c.id !== id) fail(id, `id field is "${c.id}" but the path implies "${id}"`);
  if (!c.given) fail(id, 'missing "given"');
  if (!c.expect) fail(id, 'missing "expect"');
  if (!c.note) fail(id, 'missing "note" -- every case must say which rule it pins and why');

  const e = c.expect ?? {};

  // Header maps must be lowercase: runners compare case-insensitively, and a mixed-case
  // key in a fixture silently reads as "this assertion is case-sensitive".
  for (const field of ['headers', 'headersMatch', 'headersNotMatch']) {
    for (const k of Object.keys(e[field] ?? {})) {
      if (k !== k.toLowerCase()) {
        fail(id, `expect.${field} key "${k}" must be lowercase`);
      }
    }
  }
  for (const k of e.headersAbsent ?? []) {
    if (k !== k.toLowerCase()) fail(id, `expect.headersAbsent entry "${k}" must be lowercase`);
  }

  // A literal query string is a flake waiting to happen: JSON key order differs per
  // language (Go randomizes map iteration) and percent-encoding differs per stdlib.
  if ('query' in e && typeof e.query === 'string') {
    fail(id, 'expect.query must not be a literal string -- use queryJson for structural comparison');
  }

  if (e.error?.kind && !KNOWN_KINDS.has(e.error.kind)) {
    fail(id, `unknown error kind "${e.error.kind}" (not in spec.errorKinds)`);
  }

  switch (kind) {
    case 'request':
      if (!e.method) fail(id, 'request case must expect a method');
      if (!e.path && !e.url) fail(id, 'request case must expect a path or url');
      if (e.path && !e.path.startsWith('/api/v2/convert/')) {
        fail(id, `unexpected path "${e.path}"`);
      }
      // B2 is the rule most likely to be silently regressed, so pin it hard.
      if (e.headers && 'accept' in e.headers && e.headers.accept !== '*/*') {
        fail(id, `expect.headers.accept is "${e.headers.accept}"; rule B2 requires */* ` +
                 '(an exact media type 406s for gif/bmp/jpeg targets)');
      }
      break;
    case 'response':
      if (c.given.status === undefined) fail(id, 'response case must supply given.status');
      if (!e.result && !e.error) fail(id, 'response case must expect a result or an error');
      break;
    case 'retry':
      if (!Array.isArray(c.given.responses)) fail(id, 'retry case must supply given.responses[]');
      if (typeof e.attempts !== 'number') fail(id, 'retry case must expect an attempt count');
      if (!Array.isArray(e.sleepsSeconds)) fail(id, 'retry case must expect sleepsSeconds[]');
      else if (e.attempts !== undefined && e.sleepsSeconds.length !== e.attempts - 1) {
        fail(id, `sleepsSeconds has ${e.sleepsSeconds.length} entries but attempts is ` +
                 `${e.attempts}; there is exactly one sleep between attempts`);
      }
      break;
    case 'validation':
      if (!e.validationError) fail(id, 'validation case must expect a validationError');
      if (e.requestsSent !== 0) {
        fail(id, 'validation case must assert requestsSent === 0 -- local validation ' +
                 'must not reach the network');
      }
      break;
    case 'typecheck':
      if (!c.given.snippet) fail(id, 'typecheck case must supply given.snippet');
      if (e.compileError !== true) fail(id, 'typecheck case must expect compileError: true');
      break;
  }
}

// --------------------------------------------------------------------- skip files
for (const file of readdirSync(join(ROOT, 'skips')).sort()) {
  const lang = file.replace(/\.json$/, '');
  const doc = readJson(join(ROOT, 'skips', file));
  if (doc.language !== lang) fail(`skips/${file}`, `language "${doc.language}" != filename`);
  for (const skip of doc.skips ?? []) {
    if (!declared.has(skip.id)) {
      fail(`skips/${file}`, `skips unknown case "${skip.id}"`);
    }
    // An unexplained skip is how a conformance suite quietly becomes decorative.
    if (!skip.reason || !skip.reason.trim()) {
      fail(`skips/${file}`, `skip "${skip.id}" has no reason`);
    }
  }
}

// ------------------------------------------------------- repo-wide metadata guards
// These two drifted before and are cheap to pin. See docs/API_CONTRACT.md A3 and the
// license decision in the Phase 0 PR description.
const MANIFESTS = [
  'dotnet/src/LabelZoom.Sdk/LabelZoom.Sdk.csproj',
  'node/package.json',
  'python/pyproject.toml',
];
for (const rel of MANIFESTS) {
  const p = join(REPO, rel);
  if (!existsSync(p)) continue; // added progressively, phase by phase
  const text = readFileSync(p, 'utf8');
  if (/BSD-3-Clause/.test(text)) {
    fail(rel, 'declares BSD-3-Clause; this project is MIT (see LICENSE)');
  }
}

// Some packaging formats cannot reference a license outside their own directory: building
// a Python wheel from an sdist has no parent directory to reach into, so python/ carries a
// copy. A copy that drifts is worse than no copy at all, so it is pinned here.
const rootLicense = readFileSync(join(REPO, 'LICENSE'), 'utf8');
for (const dir of ['dotnet', 'node', 'java', 'python', 'php', 'go', 'ruby']) {
  const copy = join(REPO, dir, 'LICENSE');
  if (!existsSync(copy)) continue;
  if (readFileSync(copy, 'utf8') !== rootLicense) {
    fail(`${dir}/LICENSE`, 'differs from the repository LICENSE; the copy exists only because ' +
                           'the packaging format cannot reach the original, so it must match it');
  }
}

const LEGACY_HOSTS = /\b(?:api|www)\.labelzoom\.net\b/;
const scan = (dir, rel = '') => {
  for (const entry of readdirSync(join(REPO, dir, rel), { withFileTypes: true })) {
    const next = join(rel, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'bin', 'obj', '.git', 'dist'].includes(entry.name)) continue;
      scan(dir, next);
    } else if (/\.(cs|ts|js|mjs|java|py|php|go|rb|json|md)$/.test(entry.name)) {
      const text = readFileSync(join(REPO, dir, next), 'utf8');
      if (LEGACY_HOSTS.test(text)) {
        fail(join(dir, next), 'references a legacy host (api/www.labelzoom.net); ' +
                              'rule A3 requires api.labelzoom.com');
      }
    }
  }
};
// docs/ is deliberately excluded: API_CONTRACT.md has to name the legacy hosts in
// order to forbid them.
for (const dir of ['dotnet', 'node', 'java', 'python', 'php', 'go', 'ruby', 'samples']) {
  if (existsSync(join(REPO, dir))) scan(dir);
}

// ------------------------------------------------------------------------- report
if (errors.length) {
  console.error(`conformance lint FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`conformance lint OK -- ${onDisk.length} cases, spec version ${spec.version}`);
