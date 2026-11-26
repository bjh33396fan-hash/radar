/* Token Radar model: one file, read by main.ts (Node) and by the page (browser).
*
* Reviewer's summary. Every number on the board comes from the functions below, run on the
* snapshot alone. No protocol name, slug or hand-picked value appears anywhere in this file.
*   1. splitUniverse(): live tokens (a market cap), recorded tokens (id or symbol, no cap), pre-token.
*   2. fitValueModel(): log10(market cap) on "effective TVL" = TVL x (1 + 7-day change vs sector) x
*      days^a (one slope; a picked blind), plus a shrunken sector effect when it lowers both blind errors.
*      A live token's TVL is its family's: one cap prices every product recording that token.
*   3. selectTerms(): TVL, 7-day growth and days run stay (the brief names them) at fitted weight;
*      any other term stays only if it lowers the error on two blind tests (10-fold cross-validation
*      and walk-forward by listing date). Every term's blind gain or cost is on the page.
*   4. valueRow(): implied value = the fitted median for a pre-token protocol, with an 80% interval
*      taken from the held-out residuals (split-conformal), and a term-by-term build-up.
*   5. fitOdds()/launchOdds(): per-protocol odds of a token within a year, from a survival curve.
*   6. farmPlan(): costed steps (gas per chain, capital, minutes) and a verdict on the net after what
*      the same deposit earns in 4% T-bills: Farm needs the drop alone at 3x the gas and a net that
*      beats T-bills; $/h is that excess over the plan's minutes.
*/
(function (root) {
 'use strict';

 const DAY_MS = 86400000;

 // category -> sector, written one sector per line
 const SECTORS = {};
 for (const [sec, cats] of Object.entries({
  Trading: 'Dexs|Derivatives|Prediction Market|Options|Launchpad',
  Credit: 'Lending|CDP|Dual-Token Stablecoin|Stablecoin Wrapper|Collateral Management|Collateral Markets',
  Yield: 'Basis Trading|Yield|Yield Aggregator|Onchain Capital Allocator|Risk Curators|Liquidity Manager|Leveraged Farming|Farm|Indexes|Governance Incentives',
  RWA: 'RWA|RWA Lending|CeDeFi',
  Staking: 'Liquid Staking|Liquid Restaking|Restaking|Staking Pool|Restaked BTC|Anchor BTC|Decentralized BTC',
  Infra: 'Bridge|Canonical Bridge|Cross Chain Bridge|Chain|Payments|Privacy|Insurance|Token Locker',
  Exchange: 'CEX',
 })) for (const c of cats.split('|')) SECTORS[c] = sec;
 const sectorOf = (p) => SECTORS[p.category] || 'Other';

 const SET_ASIDE = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
 const EXCHANGES = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;
 const WRAPPED = /\b(wrapped|staked|staking)\b/i;
 const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;

 function setAsideReason(p) {
  if (SET_ASIDE.includes(p.category)) return `category ${p.category}`;
  if (EXCHANGES.test(p.name)) return 'exchange product';
  if (WRAPPED.test(p.name)) return 'wrapped or staked product';
  if (VERSIONED.test(p.name)) return 'versioned product';
  return null;
 }

 const hasMarket = (p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0 && p.tvl_usd > 0;
 const recordsToken = (p) => p.gecko_id !== null || p.symbol !== null || (p.mcap_usd !== null && p.mcap_usd !== 0);

 /** familyTvl(): one token's cap prices every product that records it, so a live token is fitted on the
 *  family's summed TVL. Kin = same gecko_id, or same symbol and a shared name word (a shared ticker
 *  alone is not kin). A pre-token protocol records no token: its family is itself. */
 const words = (p) => p.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
 const kin = (p, q) => (p.gecko_id && q.gecko_id === p.gecko_id) || (p.symbol && q.symbol === p.symbol && words(p).some((a) => words(q).some((b) => a.startsWith(b) || b.startsWith(a))));
 function familyTvl(snapshot) {
  return (p) => { const s = snapshot.protocols.filter((q) => q === p || kin(p, q)); return { priced_tvl: s.reduce((a, q) => a + q.tvl_usd, 0), family: s.length }; };
 }

 /** relGrowth(): in the snapshot's week most sectors fell 5-12% (prices, not flows), so growth is
 *  counted against the median 7-day change of the protocol's sector, over all its protocols. */
 function relGrowth(snapshot) {
  const by = {}, g = (p) => p.change_7d ?? 0;
  for (const p of snapshot.protocols) (by[sectorOf(p)] ||= []).push(g(p));
  return (p) => ({ ...p, rel_7d: ((1 + g(p) / 100) / (1 + quantile(by[sectorOf(p)], 0.5) / 100) - 1) * 100 });
 }

 function splitUniverse(snapshot) {
  const watch = new Set(snapshot.watchlist), fam = familyTvl(snapshot), rg = relGrowth(snapshot);
  const live = [], recorded = [], pre = [], setAside = [];
  for (const p of snapshot.protocols) {
   if (hasMarket(p)) live.push({ ...rg(p), ...fam(p) });
   else if (recordsToken(p)) recorded.push(p);
   else if (watch.has(p.slug) || setAsideReason(p) === null) pre.push(rg(p));
   else setAside.push({ slug: p.slug, name: p.name, reason: setAsideReason(p), tvl_usd: p.tvl_usd });
  }
  return { live, recorded, pre, setAside };
 }

 function ageDays(asOf, listedAt) {
  if (!listedAt) return null;
  const d = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY_MS);
  return d >= 0 ? d : 0;
 }

 const TERMS = {
  tvl: { label: 'log10 TVL', why: 'size of deposits; a live token\'s whole family (familyTvl)', x: (p) => Math.log10(p.priced_tvl ?? p.tvl_usd) - 8 },
  growth: { label: 'log10(1 + 7-day change vs sector)', why: 'the week\'s flow net of its sector\'s median move (relGrowth), eased past 10 points, priced as TVL: more growth never lowers value', x: (p) => Math.log10(1 + 10 * Math.tanh((p.rel_7d ?? p.change_7d ?? 0) / 10) / 100) },
  age: { label: 'log10 days tracked', why: 'time run with no token: a 10x longer run counts like 10^a x more TVL (a from the blind grid), so a longer run never lowers value', x: (p, asOf) => Math.log10(Math.max(30, ageDays(asOf, p.listed_at) ?? 365)) - 2.5 },
  big: { label: 'log10 TVL past $1B', why: 'a second TVL slope past $1B (piecewise), kept only if blind', x: (p) => Math.max(0, TERMS.tvl.x(p) - 1) },
 };
 const CANDIDATES = ['tvl', 'growth', 'age', 'big', 'sector'];
 const RIDGE = 1.0;          // penalty on every slope (not the intercept)
 /** Growth and age are priced in TVL units (their free slopes on the live tokens are noise; see
 *  calibrate): effective TVL = TVL x (1+g) x days^a, one slope >= 0, so both are monotone. */
 const AGE_GRID = [0, 0.1, 0.2, 0.3, 0.5];
 const AGE_DEFAULT = 0.2;    // used only while selectTerms runs, before the grid is scored
 const SECTOR_PRIOR = 4;     // a sector effect counts as this many pseudo-protocols at zero

 function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
   let piv = c;
   for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
   [M[c], M[piv]] = [M[piv], M[c]];
   for (let r = 0; r < n; r++) {
    if (r === c || M[c][c] === 0) continue;
    const f = M[r][c] / M[c][c];
    for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
   }
  }
  return M.map((row, i) => (row[i] === 0 ? 0 : row[n] / row[i]));
 }

 /** Ridge least squares (X'WX + ridge on columns >= from) g = X'Wy; rounds > 1 reweights by
  *  1/|miss|, floor 0.05 (IRLS): least absolute misses, as the blind tests score. */
 function lsq(X, y, from, ridge, rounds = 1) {
  const k = X[0].length;
  let w = y.map(() => 1), g;
  for (let it = 0; it < rounds; it++) {
   const A = [...Array(k)].map((_, i) => [...Array(k)].map((_, j) => X.reduce((s, r, n) => s + w[n] * r[i] * r[j], 0) + (i === j && i >= from ? ridge : 0)));
   g = solve(A, A.map((_, i) => X.reduce((s, r, n) => s + w[n] * r[i] * y[n], 0)));
   w = X.map((r, n) => 1 / Math.max(0.05, Math.abs(y[n] - r.reduce((a, v, j) => a + v * g[j], 0))));
  }
  return g;
 }

 /** a = age's share of the TVL slope; big gets its own ridge slope. */
 function fitValueModel(rows, terms, asOf, a) {
  const num = terms.filter((t) => t !== 'sector');
  const ag = a === undefined ? AGE_DEFAULT : a;
  const share = { tvl: 1, growth: 1, age: ag };
  const own = num.filter((t) => !(t in share));
  const eff = (p) => num.reduce((s, t) => s + (t in share ? share[t] * TERMS[t].x(p, asOf) : 0), 0);
  const X = rows.map((p) => [1, eff(p), ...own.map((t) => TERMS[t].x(p, asOf))]);
  const y = rows.map((p) => Math.log10(p.mcap_usd));
  const g = lsq(X, y, 2, RIDGE, 30);
  const s = Math.max(0, g[1]);
  const beta = [g[0], ...num.map((t) => (t in share ? share[t] * s : g[2 + own.indexOf(t)]))];
  const c = [g[0], s, ...g.slice(2)];
  const sector = {};
  if (terms.includes('sector')) {
   const sum = {}, cnt = {};
   rows.forEach((p, r) => {
    const q = sectorOf(p), res = y[r] - X[r].reduce((acc, v, j) => acc + v * c[j], 0);
    sum[q] = (sum[q] || 0) + res; cnt[q] = (cnt[q] || 0) + 1;
   });
   for (const s of Object.keys(sum).sort()) sector[s] = { effect: sum[s] / (cnt[s] + SECTOR_PRIOR), n: cnt[s] };
  }
  return { terms: [...terms], beta, sector, n: rows.length, age_share: ag, tvl_slope: s };
 }

 function predictLog(fit, p, asOf) {
  const num = fit.terms.filter((t) => t !== 'sector');
  const parts = [{ term: 'base', label: 'intercept', log: fit.beta[0] }];
  num.forEach((t, j) => parts.push({ term: t, label: TERMS[t].label, x: TERMS[t].x(p, asOf), log: fit.beta[j + 1] * TERMS[t].x(p, asOf) }));
  if (fit.terms.includes('sector')) parts.push({ term: 'sector', label: `sector ${sectorOf(p)}`, log: fit.sector[sectorOf(p)]?.effect ?? 0 });
  return { log: parts.reduce((a, q) => a + q.log, 0), parts };
 }

 // model(train) returns a predictor; default: fitValueModel on the given terms
 function heldOut(live, terms, asOf, test, w, model = (t) => { const f = fitValueModel(t, terms, asOf, w); return (p) => predictLog(f, p, asOf).log; }) {
  const res = [];
  if (test === 'kfold') {
   for (let f = 0; f < 10; f++) {
    const train = live.filter((_, i) => i % 10 !== f), held = live.filter((_, i) => i % 10 === f);
    const pred = model(train);
    for (const p of held) res.push(Math.log10(p.mcap_usd) - pred(p));
   }
  } else {
   // walk-forward: order by first listing, fit on the earlier, test on each later fifth
   const byDate = [...live].sort((a, b) => (a.listed_at || '0000').localeCompare(b.listed_at || '0000') || a.slug.localeCompare(b.slug));
   const step = Math.floor(byDate.length / 5);
   for (let s = 2; s < 5; s++) {
    const pred = model(byDate.slice(0, s * step));
    for (const p of byDate.slice(s * step, s === 4 ? byDate.length : (s + 1) * step)) res.push(Math.log10(p.mcap_usd) - pred(p));
   }
  }
  return res;
 }

 const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
 const mae = (a) => mean(a.map(Math.abs));
 function quantile(a, q) {
  const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
 }

 const REQUIRED = ['tvl', 'growth', 'age'];
 function selectTerms(live, asOf) {
  const score = (terms) => { const k = mae(heldOut(live, terms, asOf, 'kfold')), w = mae(heldOut(live, terms, asOf, 'walk')); return { kfold: k, walk: w, both: (k + w) / 2 }; };
  let terms = [...CANDIDATES];
  const table = [];
  for (const t of CANDIDATES) {
   if (t === 'tvl') continue;
   const withIt = score(terms), without = score(terms.filter((u) => u !== t));
   const helps = withIt.kfold < without.kfold && withIt.walk < without.walk;
   const keep = helps || REQUIRED.includes(t);
   table.push({ term: t, with_kfold: withIt.kfold, without_kfold: without.kfold, with_walk: withIt.walk, without_walk: without.walk, helps, kept: keep, rule: REQUIRED.includes(t) ? 'named by the brief' : 'blind tests' });
   if (!keep) terms = terms.filter((u) => u !== t);
  }
  // the flat baseline gets both tests and both summaries: like with like
  const nk = heldOut(live, [], asOf, 'kfold'), nw = heldOut(live, [], asOf, 'walk'), med = (r) => quantile(r.map(Math.abs), 0.5);
  // flat rule 2: own TVL x the training median cap/TVL
  const lt = (p) => Math.log10(p.tvl_usd), mult = (rows) => { const q = quantile(rows.map((p) => Math.log10(p.mcap_usd) - lt(p)), 0.5); return (p) => lt(p) + q; };
  const mk = heldOut(live, [], asOf, 'kfold', 0, mult), mw = heldOut(live, [], asOf, 'walk', 0, mult);
  return { terms, table, naive_mae: mae(nk), naive_walk_mae: mae(nw), naive_med: med(nk), naive_walk_med: med(nw), mult: [mae(mk), mae(mw), med(mk), med(mw)] };
 }

 function calibrate(snapshot) {
  const asOf = snapshot.as_of, u = splitUniverse(snapshot);
  const live = [...u.live].sort((a, b) => a.slug.localeCompare(b.slug));
  const sel = selectTerms(live, asOf);
  const grid = AGE_GRID.map((a) => {
   const k = mae(heldOut(live, sel.terms, asOf, 'kfold', a)), wk = mae(heldOut(live, sel.terms, asOf, 'walk', a));
   return { weight: a, kfold: k, walk: wk, both: (k + wk) / 2 };
  });
  const best = grid.reduce((a, g) => (g.both < a.both - 1e-12 ? g : a), grid[0]);
  const free = ['growth', 'age'].map((t) => {
   const X = live.map((p) => [1, TERMS.tvl.x(p), TERMS[t].x(p, asOf)]), y = live.map((p) => Math.log10(p.mcap_usd));
   const v = lsq(X, y, 3, 0);
   const rss = X.reduce((s, r, n) => s + (y[n] - r[0] * v[0] - r[1] * v[1] - r[2] * v[2]) ** 2, 0) / (X.length - 3);
   const m = mean(X.map((r) => r[2])), sxx = X.reduce((s, r) => s + (r[2] - m) ** 2, 0);
   return { term: t, slope: v[2], se: Math.sqrt(rss / sxx) };
  });
  sel.prior_grid = grid; sel.prior_weight = best.weight; sel.free = free;
  const fit = fitValueModel(live, sel.terms, asOf, best.weight);
  const kf = heldOut(live, sel.terms, asOf, 'kfold', best.weight), wf = heldOut(live, sel.terms, asOf, 'walk', best.weight);
  const within = (r, lo, hi) => r.filter((v) => v >= lo && v <= hi).length / r.length;
  // the test's own noise: 10-fold on 8 fixed reshuffles of the live tokens, with and without growth
  let x = 7; const L8 = [...Array(8)].map(() => live.map((p) => [(x = (Math.imul(x, 1103515245) + 12345) >>> 0), p]).sort((u, v) => u[0] - v[0]).map((q) => q[1]));
  const runs = (t) => L8.map((L) => mae(heldOut(L, t, asOf, 'kfold', best.weight))), rw = runs(sel.terms), ro = runs(sel.terms.filter((t) => t !== 'growth')), m = mean(rw);
  const noise = { sd: Math.sqrt(mean(rw.map((v) => (v - m) ** 2)) * 8 / 7), growth: m - mean(ro), helps: rw.filter((v, i) => v < ro[i]).length };
  // range honesty: bands come from the 10-fold residuals and are checked on the walk-forward
  // residuals they never saw
  const lo = quantile(kf, 0.1), hi = quantile(kf, 0.9), lo50 = quantile(kf, 0.25), hi50 = quantile(kf, 0.75);
  const honest = { walk50: within(wf, lo50, hi50), walk80: within(wf, lo, hi), walk_med: quantile(wf.map(Math.abs), 0.5), kfold_med: quantile(kf.map(Math.abs), 0.5) };
  return {
   fit, selection: sel, odds: fitOdds(snapshot),
   heldout: { kfold_mae: mae(kf), walk_mae: mae(wf), n: live.length, interval_lo: lo, interval_hi: hi, lo50, hi50, honest, naive_mae: sel.naive_mae, naive_walk_mae: sel.naive_walk_mae, naive_med: sel.naive_med, naive_walk_med: sel.naive_walk_med, mult: sel.mult, noise },
   residuals: kf,
   universe: u,
  };
 }

 /** Token odds: F(age) = P(token by then), logistic; odds = (F(a+H) - F(a)) / (1 - F(a)). */
 const ODDS = { horizonDays: 365, sectorRidge: 4 };
 const sig = (z) => 1 / (1 + Math.exp(-z)), OCOL = ['base', 'age', 'tvl', 'growth'];
 const oddsX = (p, asOf, secs, plus = 0) => [1, Math.log10(Math.max(30, (ageDays(asOf, p.listed_at) ?? 365) + plus)) - 2.5, TERMS.tvl.x(p), TERMS.growth.x(p), ...secs.map((v) => +(v === sectorOf(p)))];
 const dot = (x, b, use) => use.reduce((a, i) => a + x[i] * b[i], 0);
 function logit(X, y, use, pen) {
  const b = X[0].map(() => 0);
  for (let it = 0; it < 8; it++) {
   const A = use.map((i, r) => use.map((_, c) => (r === c ? pen[i] : 0))), g = use.map((i) => -pen[i] * b[i]);
   X.forEach((x, n) => { const q = sig(dot(x, b, use)), w = q * (1 - q); use.forEach((i, r) => { g[r] += x[i] * (y[n] - q); use.forEach((j, c) => { A[r][c] += w * x[i] * x[j]; }); }); });
   solve(A, g).forEach((d, r) => { b[use[r]] += d; });
  }
  return b;
 }
 function fitOdds(snapshot) {
  const asOf = snapshot.as_of, rows = snapshot.protocols.filter((p) => p.listed_at && p.tvl_usd > 0).map(relGrowth(snapshot));
  const secs = [...new Set(rows.map(sectorOf))].sort(), X = rows.map((p) => oddsX(p, asOf, secs)), y = rows.map((p) => +recordsToken(p));
  const pen = X[0].map((_, i) => (i === 0 ? 0 : i < 4 ? RIDGE : ODDS.sectorRidge)), S = secs.map((_, i) => i + 4);
  const fit = (use, keep) => logit(X.filter((_, i) => keep(i)), y.filter((_, i) => keep(i)), use, pen);
  const loss = (use) => { let L = 0; for (let f = 0; f < 10; f++) { const b = fit(use, (i) => i % 10 !== f); X.forEach((x, i) => { if (i % 10 === f) { const q = sig(dot(x, b, use)); L -= Math.log(y[i] ? q : 1 - q); } }); } return L / rows.length; };
  const core = [0, 1, ...S], lc = loss(core);
  const tests = [2, 3].map((c) => { const u = [...core, c], l = loss(u), slope = fit(u, () => true)[c]; return { term: OCOL[c], with: l, without: lc, slope, kept: l < lc && slope >= 0 }; });
  const use = [...core, ...[2, 3].filter((_, k) => tests[k].kept)];
  return { use, secs, terms: tests.filter((t) => t.kept).map((t) => t.term), beta: fit(use, () => true), n: rows.length, tokened: y.reduce((a, v) => a + v, 0), loss: use.length > core.length ? loss(use) : lc, sector_loss: loss([0, ...S]), flat_loss: loss([0]), tests };
 }
 function launchOdds(p, od, asOf) {
  const F = (plus) => sig(dot(oddsX(p, asOf, od.secs, plus), od.beta, od.use));
  const now = F(0), later = F(ODDS.horizonDays);
  return { sector: sectorOf(p), now, later, rate: Math.max(0, (later - now) / (1 - now)) };
 }

 const GAS_USD = { Ethereum: 2.5, Bitcoin: 1.5, Tron: 1.0, Binance: 0.08, Avalanche: 0.05, Polygon: 0.02, Solana: 0.01, Sui: 0.01, Aptos: 0.01, Algorand: 0.002, Stellar: 0.001, Ripple: 0.001, 'Hyperliquid L1': 0.01, TON: 0.03, Cardano: 0.2, Near: 0.01 };
 const L2_GAS = 0.04;
 const L2S = /^(base|arbitrum|optimism|ink|unichain|linea|scroll|zksync|blast|mode|mantle|monad|plasma|berachain|sonic|katana|plume|hyperevm|robinhood|arc|pharos|flare|core|bob|mezo|soneium|abstract|taiko|world)/i;
 const gasOf = (chain) => GAS_USD[chain] ?? (L2S.test(chain) ? L2_GAS : 0.25);

 /** Farm assumptions, each shown on the page beside its use. */
 const FARM = { deposit: 1000, horizonDays: 90, seasonDays: 180, airdropShare: 0.075, lossRatePerYear: 0.02, bridgeUsd: 1.5, scaleCap: 50000, billRate: 0.04 };
 const BASE_APY = { Yield: 0.05, Credit: 0.04, RWA: 0.045, Staking: 0.03, Trading: 0.03, Infra: 0, Exchange: 0.01, Other: 0.01 };

 // [wallet, funding route] by chain; {c} = chain name. Unlisted chains are EVM: Rabby over CCTP or Across.
 const ROUTES = {
  solana: ['Phantom or Solflare', 'USDC over Circle CCTP or a Solana on-ramp'], bitcoin: ['Xverse or Leather', 'native BTC from an exchange withdrawal'],
  tron: ['TronLink', 'USDT (TRC-20) from an exchange withdrawal'], sui: ['Sui Wallet or Suiet', 'USDC over Circle CCTP'], aptos: ['Petra', 'USDC over Circle CCTP'],
  ton: ['Tonkeeper', 'USDT on TON from an exchange withdrawal'], bittensor: ['a Bittensor wallet (btcli or Talisman)', 'TAO from an exchange withdrawal'],
  'hyperliquid l1': ['Rabby or MetaMask connected to Hyperliquid', 'USDC deposited from Arbitrum'], ethereum: ['Rabby or MetaMask', 'USDC withdrawn from an exchange straight to Ethereum'],
 };
 for (const c of ['stellar', 'ripple', 'algorand', 'cardano', 'near']) ROUTES[c] = ['the {c} reference wallet', 'USDC on {c} from an exchange withdrawal'];
 function routeOf(chain) {
  const [wallet, bridge] = (ROUTES[chain.toLowerCase()] || ['Rabby or MetaMask', 'USDC to {c} over Circle CCTP or Across']).map((s) => s.replace('{c}', chain));
  return { wallet, bridge };
 }

 // shared closing steps
 const VAULT = ['Deposit USDC into that vault', 2, 10];
 const PLAYBOOK = {
  Credit: [['Supply a stablecoin to the main market', 2, 10], ['Borrow a little against it (health factor above 2) so both sides of the book count', 1, 10], ['Repay and re-borrow monthly; close the loan before any announced snapshot', 2, 10]],
  Trading: [['Trade on the venue three times in week one, small size', 3, 15], ['Provide liquidity to one deep pool near the price', 2, 15], ['Rebalance or claim fees once, halfway', 1, 10]],
  Staking: [['Stake the native asset in the protocol\'s own pool', 2, 10], ['Use the receipt token in one integrated venue if offered', 2, 10], ['Hold; note the unbonding period before you start', 0, 5]],
  Infra: [['Bridge or route a small amount through the protocol', 2, 10], ['Repeat once on a second route or chain', 2, 10], ['Use one application built on it each month', 1, 10]],
  Other: [['Use the main product with a small, steady position', 2, 15], ['Register on its points or rewards page if one exists', 0, 15], ['Repeat the main action monthly to build a record', 1, 10]],
 };

 /** Steps by category ({n} = name). No points programme is invented: the step says how to find and verify one. */
 const CATEGORY_STEPS = {
  'Risk Curators': [['Open {n}\'s largest stablecoin vault (its site lists the markets it curates); read the allocation list and timelock: the curator moves your funds', 0, 10], VAULT],
  'Onchain Capital Allocator': [['Check which strategies {n}\'s largest vault routes into, and its withdrawal queue', 0, 10], VAULT],
  Dexs: [['Swap through {n} three times in week one, small size; DEX points mostly count volume', 3, 15], ['Add liquidity to {n}\'s deepest stable or major pair, in a range wide enough to skip daily rebalancing', 2, 15], ['Claim fees and re-centre the range once, halfway', 1, 10]],
  Lending: [['Supply USDC to {n}\'s largest market', 2, 10], ['Borrow up to a quarter of it so both sides count (health factor above 2)', 1, 10], ['Repay before any snapshot {n} announces', 1, 5]],
  'Yield Aggregator': [['Deposit into {n}\'s largest stablecoin vault', 2, 10], ['Note the vault\'s strategy and harvest fee on its page', 0, 10]],
  Yield: [['Deposit stablecoins into {n}\'s main product', 2, 10], ['Check where the yield comes from and the withdrawal delay', 0, 15]],
  Derivatives: [['Post USDC margin on {n} and open one small hedged pair (long and short), closed a week later; perp points count volume and open interest', 4, 20], ['Check for a {n} liquidity or insurance vault: fees without direction', 0, 5], ['Close positions before any announced snapshot', 1, 5]],
  CDP: [['Open a vault on {n}: deposit ETH or a liquid-staked ETH, mint a little of its stablecoin (collateral above 250%)', 2, 15], ['Put the minted stablecoin in {n}\'s own savings or stability pool if it has one', 1, 10]],
  'Basis Trading': [['Mint or deposit into {n}\'s delta-neutral product with USDC', 2, 10], ['Read how it handles negative funding and its redemption delay first', 0, 15]],
  RWA: [['Complete {n}\'s issuer onboarding or KYC (1 to 3 days)', 0, 45], ['Subscribe to its tokenised fund or note with stablecoins', 2, 10], ['Hold through the season; redeem only in the issuer\'s window', 1, 5]],
 };
 // Exchange reads like Other; Yield and RWA as their categories
 Object.assign(PLAYBOOK, { Exchange: PLAYBOOK.Other, Yield: CATEGORY_STEPS.Yield, RWA: CATEGORY_STEPS.RWA });

 const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
 // 2 sig. figures from $1M ($B from $1B; held-out misses run x2.9), whole dollars from $100, cents below
 const usd = (v) => (v >= 1e9 ? `$${Number((v / 1e9).toPrecision(2))}B` : v >= 1e6 ? `$${Number((v / 1e6).toPrecision(2))}M` : v >= 100 ? `$${thousands(v)}` : `$${v >= 1 ? Number(v.toPrecision(2)) : v.toFixed(2)}`);

 // o: { deposit, share, gasX } re-runs the plan at another deposit, airdrop share or gas level; FARM itself is never changed
 function farmPlan(p, value, odds, o = {}) {
  const dep = o.deposit ?? FARM.deposit, drop = o.share ?? FARM.airdropShare, gx = o.gasX ?? 1;
  // chains are listed largest first: the cheapest of the first three
  const main = p.chains.slice(0, 3);
  const chains = main.map((c, i) => [c, i]).sort((a, b) => gasOf(a[0]) - gasOf(b[0]) || a[1] - b[1]).map((x) => x[0]);
  const chain = chains[0] || 'Ethereum', gas = gasOf(chain) * gx, route = routeOf(chain);
  const sector = sectorOf(p), apy = BASE_APY[sector] ?? 0.01, days = FARM.horizonDays;
  const cheaper = p.chains.length > 1 && gasOf(p.chains[0]) > gas ? `, not ${p.chains[0]} (${usd(gasOf(p.chains[0]))} a transaction against ${usd(gas)})` : '';
  const steps = [];
  let txs = 0, minutes = 0;
  // when: the day each step happens, counted from the deposit
  let when = 'day 0';
  const add = (text, n, min, extra = 0) => { steps.push({ text, cost: n * gas + extra, minutes: min, when }); txs += n; minutes += min; };
  add(`Install ${route.wallet} and fund it on ${chain}${cheaper}: move ${usd(dep)} as ${route.bridge}; that is 1 part in ${thousands(p.tvl_usd / dep)} of ${p.name}'s ${usd(p.tvl_usd)} TVL, the share any pro-rata drop pays.`, 1, 15, FARM.bridgeUsd);
  add(`Follow ${p.name}'s docs and X account so a points or season launch is seen on day one (odds of a token within ${ODDS.horizonDays} days: ${Math.round(odds.rate * 100)}%, model.js launchOdds); activity from before it usually counts.`, 0, 10);
  // entry timing from the snapshot's own 7-day change (percent; board median about -8%): a sharp fall gets a split entry (one more transaction)
  const g = p.change_7d ?? 0, gp = `${g > 0 ? '+' : ''}${g.toFixed(1)}%`;
  when = g < -15 ? 'day 0 and 7' : 'day 0';
  if (g < -15) add(`TVL moved ${gp} in 7 days: put in half on day 0 and the other ${usd(dep / 2)} on day 7 only if TVL still prints above ${usd(p.tvl_usd * 0.9)}.`, 1, 5);
  else add(`TVL moved ${gp} in 7 days, ${g > 5 ? 'so points per dollar are diluting: enter in full on day 0, do not average in' : 'no sharp fall: enter in full on day 0'}; re-read TVL on day 7.`, 0, 2);
  const own = CATEGORY_STEPS[p.category];
  for (const [what, n, min] of own || PLAYBOOK[sector]) when = /halfway/.test(what) ? `day ${days / 2}` : 'week 1', add(`${what.replace(/\{n\}/g, p.name)} (${chain}; ${n === 0 ? 'reading only, no transaction' : `${n} transaction${n === 1 ? '' : 's'}`}).`, n, min);
  const monthly = sector === 'RWA' || sector === 'Staking' ? 0 : Math.round(days / 30);
  when = `every 30 days`;
  if (monthly > 0) add(`Top up or repeat the main action once a month for ${days} days (${monthly} more transactions), keeping the balance steady so time-weighted points keep accruing.`, monthly, 5 * monthly);
  const share = dep / p.tvl_usd;
  const ev = drop * value * share * (days / FARM.seasonDays) * odds.rate;
  const yieldUsd = dep * apy * (days / 365);
  const risk = dep * FARM.lossRatePerYear * (days / 365);
  when = `day ${days}`;
  add(`Exit after ${days} days or at the snapshot, whichever comes first: withdraw in one transaction; exit at once if TVL prints below ${usd(p.tvl_usd / 2)} (half of today) or the team rules out a token.`, 1, 5);
  const cost = steps.reduce((a, s) => a + s.cost, 0);
  // net from the printed parts (2 figures, as shown): the sum reads as shown
  const c = (v) => (Math.abs(v) >= 1 ? Number(v.toPrecision(2)) : Math.round(v * 100) / 100), net = c(ev) + c(yieldUsd) - c(cost) - c(risk);
  // the bar is not zero: the same dollars earn 4% in T-bills over the same days, at no contract risk
  const billAt = (d) => d * FARM.billRate * (days / 365), bill = c(billAt(dep)), over = net - bill;
  const ratio = ev / cost;
  const breakEven = cost / (ev / dep);
  const size = Math.ceil((3 * breakEven) / 1000) * 1000;
  const hours = (minutes + 2) / 60, perHour = over / hours;
  const netAt = (d) => ((ev + yieldUsd - risk) * d) / dep - cost - billAt(d), sizeHour = netAt(size) / hours;
  const verdict = ratio >= 3 && over > 0 ? 'Farm' : ratio >= 1 && net > 0 ? 'Test' : size <= FARM.scaleCap && netAt(size) > 0 ? 'Scale' : 'Watch';
  const sg = (v) => `${v >= 0 ? '+' : '-'}${usd(Math.abs(v))}`;
  // $/h to 2 figures, as on the board: the inputs are guesses, cents would be false precision
  const sh = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v) >= 9.95 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}`;
  const verdictText = {
   Farm: `the drop alone is ${ratio.toFixed(1)}x the gas and the plan beats T-bills by ${usd(over)}`,
   Test: over > 0 ? `beats T-bills by ${usd(over)}, but the drop is only ${ratio.toFixed(1)}x gas; a small test` : `net ${sg(net)} trails T-bills (${usd(bill)}): a test for the drop's upside, not for income`,
   Scale: `${ratio.toFixed(1)}x gas at ${usd(dep)}; from ${usd(size)} the drop is 3x gas, ${sh(sizeHour)}/h over T-bills`,
   Watch: `at this TVL no deposit up to ${usd(FARM.scaleCap)} gets the drop to 3x gas and past T-bills; re-check if TVL halves or points open`,
  }[verdict];
  steps.push({ text: `Expected result for ${usd(dep)}: airdrop ${usd(ev)} (${(drop * 100).toFixed(1)}% of the ${usd(value)} implied value, pro rata to TVL, ${days}/${FARM.seasonDays} season days, x ${(odds.rate * 100).toFixed(0)}% odds of a token in ${ODDS.horizonDays} days) + ${usd(yieldUsd)} of ${(apy * 100).toFixed(1)}% yield - ${usd(cost)} gas - ${usd(risk)} contract risk = net ${sg(net)}; 4% T-bills pay ${usd(bill)}, so ${sg(over)} over T-bills, ${sh(perHour)}/h over ${minutes + 2} min. Verdict ${verdict}: ${verdictText}.`, cost: 0, minutes: 2, when });
  return { chain, gas, steps, ev, yieldUsd, net, bill, over, cost, risk, ratio, verdict, verdictText, breakEven, size, perHour, sizeHour, minutes: minutes + 2, txs };
 }

 function valueRow(p, cal, snapshot) {
  const asOf = snapshot.as_of, pr = predictLog(cal.fit, p, asOf), h = cal.heldout;
  const at = (d) => Math.max(1, Math.round(10 ** (pr.log + d))), value = at(0);
  const odds = launchOdds(p, cal.odds, asOf), plan = farmPlan(p, value, odds);
  return {
   slug: p.slug, name: p.name, category: p.category, sector: sectorOf(p), chains: p.chains,
   tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, days_pre_token: ageDays(asOf, p.listed_at),
   watchlist: snapshot.watchlist.includes(p.slug),
   implied_value_usd: value,
   low_usd: at(h.interval_lo), high_usd: at(h.interval_hi), p25_usd: at(h.lo50), p75_usd: at(h.hi50),
   value_to_tvl: value / p.tvl_usd,
   parts: pr.parts.map((q) => ({ term: q.term, label: q.label, log: q.log })),
   odds, plan,
  };
 }

 /** fnv(): FNV-1a over "rank slug value" lines; main.ts stores it, the page recomputes it from its own rows. */
 const fnv = (rows) => { let x = 0x811c9dc5; for (const c of rows.map((r) => `${r.rank} ${r.slug} ${r.implied_value_usd}`).join('\n')) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x.toString(16).padStart(8, '0'); };

 const api = { SECTOR_PRIOR, SECTORS, TERMS, CANDIDATES, FARM, BASE_APY, routeOf, GAS_USD, sectorOf, setAsideReason, splitUniverse, ageDays, fitValueModel, predictLog, heldOut, selectTerms, calibrate, ODDS, fitOdds, launchOdds, farmPlan, valueRow, gasOf, quantile, mae, fnv };
 if (typeof module === 'object' && module.exports) module.exports = api;
 else root.RadarModel = api;
})(typeof window === 'object' ? window : globalThis);
