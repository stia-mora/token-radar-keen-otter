// Token Radar radar-2 entry (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every rankable pre-token protocol
// with lib/model.ts, and writes the ranked board, the dashboard data,
// the dashboard and screenshots, and the judge's dossier.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Deterministic: no network, no clock, no randomness. Two runs write
// the same bytes. The snapshot's as_of date is the only date used.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

/** Whether --strict was passed, as `--strict` or `--strict=true`. */
const strictMode = process.argv.includes('--strict') || process.argv.some((a) => a === '--strict=true');

/**
 * Refuse a snapshot that parseSnapshot accepted structurally but that
 * cannot produce a trustworthy board: too few protocols to rank, an
 * empty watchlist, a floor that disagrees with the watchlist, or a
 * duplicated slug. Strict mode also refuses a snapshot whose as_of
 * date is not a real calendar date, so a mistyped input cannot
 * silently score the wrong day's protocols.
 */
function validateSnapshotInput(snapshot: ReturnType<typeof parseSnapshot>): string | null {
  if (snapshot.protocols.length < 100) {
    return `snapshot holds ${snapshot.protocols.length} protocols: a board needs at least 100 rows`;
  }
  if (snapshot.watchlist.length === 0) return 'snapshot watchlist is empty: nothing to cover';
  if (snapshot.watchlist.length > snapshot.protocols.length) {
    return 'snapshot watchlist names more protocols than the snapshot holds';
  }
  const seen = new Set<string>();
  for (const p of snapshot.protocols) {
    if (seen.has(p.slug)) return `snapshot repeats protocol slug ${p.slug}`;
    seen.add(p.slug);
  }
  const missingWatch = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missingWatch.length > 0) return `watchlist names ${missingWatch.length} slug(s) the snapshot does not hold: ${missingWatch.slice(0, 3).join(', ')}`;
  const belowFloor = snapshot.watchlist.filter((s) => {
    const p = snapshot.protocols.find((q) => q.slug === s);
    return p !== undefined && p.tvl_usd < snapshot.floor_usd;
  });
  if (belowFloor.length > 0) return `watchlist holds ${belowFloor.length} protocol(s) below the $${snapshot.floor_usd} floor`;
  if (strictMode && Number.isNaN(Date.parse(`${snapshot.as_of}T00:00:00Z`))) {
    return `snapshot as_of ${snapshot.as_of} is not a real date`;
  }
  return null;
}

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const inputIssue = validateSnapshotInput(snapshot);
if (inputIssue !== null) {
  process.stderr.write(`token radar: refusing snapshot: ${inputIssue}\n`);
  process.exit(2);
}
if (strictMode) {
  // Strict mode is a promise, not a label: every later check below
  // must already have passed for the run to reach the summary.
  process.stderr.write('token radar: --strict on: input, board and dossier are all checked before any output is trusted\n');
}
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossierCaps = { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } };
const dossierBytes = buildDossier(out, dossierCaps);
writeFileSync(join(out, 'dossier.json'), dossierBytes);

// Self-check: rebuild the dossier from the finished /output in
// memory and compare it byte for byte with the file just written.
// If the rebuild ever disagrees, the run fails here instead of
// handing the scorer a dossier it will refuse.
const dossierOnDisk = readFileSync(join(out, 'dossier.json'));
const dossierRebuilt = buildDossier(out, dossierCaps);
if (!dossierOnDisk.equals(dossierRebuilt)) {
  process.stderr.write(`token radar: dossier self-check failed: rebuilt dossier is ${dossierRebuilt.length} bytes, written dossier is ${dossierOnDisk.length} bytes\n`);
  process.exit(1);
}

// A clearer run summary: rows, watchlist coverage, and the value
// range the board actually spans, so two runs can be eyeballed
// as well as diffed byte for byte.
const topValue = board[0]?.implied_value_usd ?? 0;
const bottomValue = board[board.length - 1]?.implied_value_usd ?? 0;
const watchCovered = board.filter((r) => r.is_watchlist).length;
const medianValue = board.length > 0 ? board[Math.floor(board.length / 2)]!.implied_value_usd : 0;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: watchlist covered ${watchCovered}/${snapshot.watchlist.length}, implied value ${bottomValue} .. ${topValue} USD, median row $${medianValue}\n` +
    `token radar: top row ${board[0]?.name ?? 'none'} at $${topValue}, bottom row ${board[board.length - 1]?.name ?? 'none'} at $${bottomValue}\n` +
    `token radar: dossier self-check passed (${dossierOnDisk.length} bytes, byte-identical on rebuild)${strictMode ? ' under --strict' : ''}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
