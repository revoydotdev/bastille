#!/usr/bin/env node
/**
 * Codegen: read data/registry.json and emit the `StoreId` string-literal union
 * into both server/src/price/model.ts and web/src/types.ts.
 *
 * The codegen approach is build-time codegen (not runtime resolution):
 * the JSON file is the source of truth, and a single pass rewrites the
 * `StoreId` line in each TS file, sandwiched between two structural markers
 * (`// codegen:registry:open` / `// codegen:registry:close`). The rest of each
 * file is untouched. `npm run build` (server + web) and `npm test` invoke
 * this script before tsc, so the union in TS is always in lockstep with
 * data/registry.json.
 *
 * Why build-time codegen rather than a runtime `as const` lookup: the web
 * bundle is `tsc -b && vite build` and ships no JSON loader; the server's
 * downstream consumers expect `StoreId` to be a closed string-literal union,
 * not the widened `string` that a runtime lookup would produce. Generating
 * the union keeps every existing `Record<StoreId, string>` (e.g.
 * web/src/components/bits.tsx) narrow and exhaustively typed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const REGISTRY = process.env.BASTILLE_REGISTRY_PATH
  ? resolve(process.env.BASTILLE_REGISTRY_PATH)
  : resolve(REPO, 'data/registry.json');
const SERVER_TYPES = resolve(REPO, 'server/src/price/model.ts');
const WEB_TYPES = resolve(REPO, 'web/src/types.ts');
const MARKER_OPEN = '// codegen:registry:open';
const MARKER_CLOSE = '// codegen:registry:close';

function emitUnion(ids) {
  if (ids.length === 0) {
    throw new Error(`codegen: ${REGISTRY} has zero enabled sources; refusing to emit an empty StoreId union`);
  }
  const members = ids.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(' | ');
  return `export type StoreId = ${members};`;
}

function rewrite(file, unionLine) {
  if (!existsSync(file)) {
    throw new Error(`codegen: target file missing: ${file}`);
  }
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const openIdx = lines.findIndex((l) => l.includes(MARKER_OPEN));
  const closeIdx = lines.findIndex(
    (l, i) => i > openIdx && l.includes(MARKER_CLOSE),
  );
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    throw new Error(
      `codegen: ${file} must contain both '${MARKER_OPEN}' and '${MARKER_CLOSE}' markers`,
    );
  }
  const before = lines.slice(0, openIdx + 1);
  const after = lines.slice(closeIdx);
  const next = [...before, unionLine, ...after].join('\n');
  if (next === src) return false;
  writeFileSync(file, next);
  return true;
}

function main() {
  if (!existsSync(REGISTRY)) {
    throw new Error(`codegen: registry file not found at ${REGISTRY}`);
  }
  const cfg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.sources)) {
    throw new Error(`codegen: ${REGISTRY} must be an object with a "sources" array`);
  }
  const ids = cfg.sources
    .filter((s) => s && s.enabled !== false && typeof s.id === 'string' && s.id.length > 0)
    .map((s) => s.id);
  const union = emitUnion(ids);

  const touched = [
    [SERVER_TYPES, rewrite(SERVER_TYPES, union)],
    [WEB_TYPES, rewrite(WEB_TYPES, union)],
  ];
  for (const [f, changed] of touched) {
    process.stdout.write(`codegen: ${f} ${changed ? 'rewritten' : 'unchanged'}\n`);
  }
  process.stdout.write(`codegen: emitted StoreId union with ${ids.length} sources: ${ids.join(', ')}\n`);
}

main();