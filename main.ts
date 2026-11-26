// Token Radar (token-radar-01): Node 22, standard library only, no network, no clock, no randomness.
//
// Reads the sealed snapshot, fits the value model on the protocols whose token already trades
// (dashboard/model.js, the same file the page runs), values every pre-token protocol, and writes:
//   /output/board.json          the ranked board the gate checks
//   /output/data.js             the page's dataset (window.RADAR), beside dashboard/
//   /output/dashboard/          index.html, radar.css, radar.js, model.js and fit.json (the fit's record)
//   /output/screenshots/        the three captures handed in with the repository
//   /output/dossier.json        what the judge reads, written last by the vendored make.fun library
//
// Outside the grader: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const M = require('./dashboard/model.js');

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1]! : fallback;
}
const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const asOf: string = snapshot.as_of;

// 1. Fit on the live tokens, with both blind tests.
const cal = M.calibrate(snapshot);
const { live, recorded, pre, setAside } = cal.universe;

// 2. Value every pre-token protocol; rank by implied value, ties by TVL then slug.
const valued = pre.map((p: any) => M.valueRow(p, cal, snapshot));
valued.sort((a: any, b: any) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));
valued.forEach((r: any, i: number) => { r.rank = i + 1; });

const board = valued.map((r: any) => ({
  slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied_value_usd,
  interval_80_usd: [r.low_usd, r.high_usd], interval_50_usd: [r.p25_usd, r.p75_usd], category: r.category, chains: r.chains,
  tvl_usd: r.tvl_usd, change_7d: r.change_7d, days_pre_token: r.days_pre_token, watchlist: r.watchlist,
  farm_verdict: r.plan.verdict, farm_verdict_text: r.plan.verdictText,
  farm_cost_usd: Math.round(r.plan.cost * 100) / 100, farm_minutes: r.plan.minutes, airdrop_ev_per_1k_usd: Math.round(r.plan.ev * 100) / 100,
  farm_usd_per_hour: Math.round(r.plan.perHour * 100) / 100, // net per $1k / (minutes / 60)
  farm_steps: r.plan.steps.map((s: any) => `${s.text} Cost about $${s.cost.toFixed(2)}, ${s.minutes} min.`),
}));

// 3. The gate's own checks, run here so the page can show them answered.
const watch: string[] = snapshot.watchlist;
const onBoard = new Set(board.map((r: any) => r.slug));
const covered = watch.filter((s) => onBoard.has(s)).length;
const monotone = board.every((r: any, i: number) => i === 0 || r.implied_value_usd <= board[i - 1].implied_value_usd);
const stepsOk = board.every((r: any) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s: string) => s.trim().length >= 20 && s.trim().length <= 600));
const distinct = new Set(board.map((r: any) => r.implied_value_usd)).size;
if (covered !== watch.length || !monotone || !stepsOk || board.length < 100 || distinct < 2) {
  process.stderr.write(`token radar: board fails its own check (covered ${covered}/${watch.length}, monotone ${monotone}, steps ${stepsOk}, rows ${board.length})\n`);
  process.exit(1);
}
const boardJson = `${JSON.stringify({ model: 'radar-fit-1', as_of: asOf, rows: board })}\n`;
const boardSha = createHash('sha256').update(boardJson).digest('hex');

// 4. Held-out predictions for the calibration chart: each live token predicted by a fit that never saw it.
const liveSorted = [...live].sort((a: any, b: any) => a.slug.localeCompare(b.slug));
const blind: Record<string, number> = {};
for (let f = 0; f < 10; f++) {
  const fit = M.fitValueModel(liveSorted.filter((_: any, i: number) => i % 10 !== f), cal.fit.terms, asOf, cal.fit.age_share);
  liveSorted.forEach((p: any, i: number) => { if (i % 10 === f) blind[p.slug] = M.predictLog(fit, p, asOf).log; });
}
const liveRows = liveSorted.map((p: any) => ({
  slug: p.slug, name: p.name, category: p.category, sector: M.sectorOf(p), chains: p.chains, tvl_usd: p.tvl_usd,
  change_7d: p.change_7d, mcap_usd: p.mcap_usd, symbol: p.symbol,
  fitted_usd: Math.round(10 ** M.predictLog(cal.fit, p, asOf).log), blind_usd: Math.round(10 ** blind[p.slug]!),
})).sort((a: any, b: any) => b.mcap_usd - a.mcap_usd || a.slug.localeCompare(b.slug));

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const fitRecord = {
  fitted_on: live.length,
  terms: cal.fit.terms,
  coefficients: Object.fromEntries(['intercept', ...cal.fit.terms.filter((t: string) => t !== 'sector')].map((t, i) => [t, round(cal.fit.beta[i])])),
  sector_effects: Object.fromEntries(Object.entries(cal.fit.sector).map(([s, v]: [string, any]) => [s, { log10: round(v.effect), n: v.n }])),
  term_tests: cal.selection.table.map((t: any) => ({ term: t.term, kept: t.kept, kfold_with: round(t.with_kfold), kfold_without: round(t.without_kfold), walk_with: round(t.with_walk), walk_without: round(t.without_walk) })),
  growth_and_age: { tvl_slope: round(cal.fit.tvl_slope), age_share_a: cal.selection.prior_weight, chosen_by: 'lowest mean blind error', free_slopes_beside_tvl: cal.selection.free.map((s: any) => ({ term: s.term, slope: round(s.slope), se: round(s.se) })) },
  held_out: { kfold_mae_log10: round(cal.heldout.kfold_mae), walk_forward_mae_log10: round(cal.heldout.walk_mae), naive_median_mae_log10: round(cal.heldout.naive_mae), median_ratio_mae_log10: round(cal.heldout.ratio_mae), interval_80_log10: [round(cal.heldout.interval_lo), round(cal.heldout.interval_hi)], p25_p75_log10: [round(cal.heldout.lo50), round(cal.heldout.hi50)], held_out_inside_50: round(cal.heldout.honest.walk50), held_out_inside_80: round(cal.heldout.honest.walk80) },
  board: { rows: board.length, watchlist_covered: `${covered}/${watch.length}`, sha256: boardSha, fnv: M.fnv(board) },
  ledger: `${snapshot.protocols.length} = ${board.length} board + ${live.length} live + ${recorded.length} recorded + ${setAside.length} set aside (${board.length + live.length + recorded.length + setAside.length === snapshot.protocols.length ? 'adds up' : 'MISMATCH'})`,
  token_odds: { horizon_days: M.ODDS.horizonDays, fitted_on: cal.odds.n, with_token: cal.odds.tokened, kfold_log_loss: round(cal.odds.loss), sector_alone: round(cal.odds.sector_loss), base_rate: round(cal.odds.flat_loss), tests: cal.odds.tests.map((t: any) => `${t.term}: ${round(t.with)} vs ${round(t.without)}, slope ${round(t.slope, 2)}, ${t.kept ? 'kept' : 'dropped'}`) },
};

const radar = {
  as_of: asOf, source: snapshot.source, floor_usd: snapshot.floor_usd, protocols: snapshot.protocols.length,
  fit: { terms: cal.fit.terms, beta: cal.fit.beta, sector: cal.fit.sector, heldout: cal.heldout, table: cal.selection.table, odds: cal.odds, prior: { a: cal.selection.prior_weight, slope: cal.fit.tvl_slope, grid: cal.selection.prior_grid, free: cal.selection.free } },
  record: fitRecord,
  checks: { covered, watch: watch.length, monotone, stepsOk, rows: board.length, distinct, sha: boardSha, total: board.reduce((a: number, r: any) => a + r.implied_value_usd, 0), fnv: M.fnv(board) },
  rows: valued.map((r: any) => ({ ...r, plan: { ...r.plan, steps: r.plan.steps } })),
  live: liveRows,
  recorded: recorded.length,
  setAside: setAside.reduce((a: Record<string, number>, r: any) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {}),
  snap: Object.fromEntries(pre.map((p: any) => [p.slug, p])),
};

// 5. Write the outputs. The dossier is last: the scorer rebuilds it from /output and compares bytes.
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), boardJson);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const names = existsSync(from) ? readdirSync(from).filter((n) => !n.startsWith('.') && statSync(join(from, n)).isFile()).sort() : [];
  for (const n of names) copyFileSync(join(from, n), join(to, n));
  return names;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// two levels of line breaks, leaf records on one line: readable, and lighter on the judge's 64 KB
const fitLines = (v: any, pad: string): string => {
  if (v === null || typeof v !== 'object' || pad.length >= 2) return JSON.stringify(v);
  const items = Array.isArray(v) ? v.map((x) => `${pad} ${fitLines(x, pad + ' ')}`) : Object.entries(v).map(([k, x]) => `${pad} ${JSON.stringify(k)}: ${fitLines(x, pad + ' ')}`);
  return Array.isArray(v) ? `[\n${items.join(',\n')}\n${pad}]` : `{\n${items.join(',\n')}\n${pad}}`;
};
writeFileSync(join(out, 'dashboard', 'fit.json'), `${fitLines(fitRecord, '')}\n`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3\n`);
  process.exit(1);
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(`token radar: ${snapshot.protocols.length} protocols; fitted on ${live.length} live tokens (blind MAE ${cal.heldout.kfold_mae.toFixed(3)} log10); ${board.length} pre-token rows, watchlist ${covered}/${watch.length}; board sha256 ${boardSha.slice(0, 16)}\n`);
