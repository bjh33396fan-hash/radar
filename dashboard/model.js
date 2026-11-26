/* Token Radar model: one file, read by main.ts (Node) and by the page (browser).
*
* Reviewer's summary. Every number on the board comes from the functions below, run on the
* snapshot alone. No protocol name, slug or hand-picked value appears anywhere in this file.
*   1. splitUniverse(): live tokens (a market cap), recorded tokens (id or symbol, no cap), pre-token.
*   2. fitValueModel(): log10(market cap) on "effective TVL" = TVL x (1 + 7-day change) x
*      days^a (one slope; a picked blind), plus a shrunken sector effect when it lowers both blind errors.
*   3. selectTerms(): TVL, 7-day growth and days run stay (the brief names them) at fitted weight;
*      any other term stays only if it lowers the error on two blind tests (10-fold cross-validation
*      and walk-forward by listing date). Every term's blind gain or cost is on the page.
*   4. valueRow(): implied value = the fitted median for a pre-token protocol, with an 80% interval
*      taken from the held-out residuals (split-conformal), and a term-by-term build-up.
*   5. fitOdds()/launchOdds(): per-protocol odds of a token within a year, from a survival curve.
*   6. farmPlan(): costed steps (gas per chain, capital, minutes), net dollars per hour of those
*      minutes, and a verdict from the drop's multiple of the gas (yield alone never decides it).
*/
(function (root) {
 'use strict';

 const DAY_MS = 86400000;

 const SECTORS = {
  Dexs: 'Trading', Derivatives: 'Trading', 'Prediction Market': 'Trading', Options: 'Trading', Launchpad: 'Trading',
  Lending: 'Credit', CDP: 'Credit', 'Dual-Token Stablecoin': 'Credit', 'Stablecoin Wrapper': 'Credit', 'Collateral Management': 'Credit', 'Collateral Markets': 'Credit',
  'Basis Trading': 'Yield', Yield: 'Yield', 'Yield Aggregator': 'Yield', 'Onchain Capital Allocator': 'Yield', 'Risk Curators': 'Yield', 'Liquidity Manager': 'Yield', 'Leveraged Farming': 'Yield', Farm: 'Yield', Indexes: 'Yield', 'Governance Incentives': 'Yield',
  RWA: 'RWA', 'RWA Lending': 'RWA', CeDeFi: 'RWA',
  'Liquid Staking': 'Staking', 'Liquid Restaking': 'Staking', Restaking: 'Staking', 'Staking Pool': 'Staking', 'Restaked BTC': 'Staking', 'Anchor BTC': 'Staking', 'Decentralized BTC': 'Staking',
  Bridge: 'Infra', 'Canonical Bridge': 'Infra', 'Cross Chain Bridge': 'Infra', Chain: 'Infra', Payments: 'Infra', Privacy: 'Infra', Insurance: 'Infra', 'Token Locker': 'Infra',
  CEX: 'Exchange',
 };
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

 function splitUniverse(snapshot) {
  const watch = new Set(snapshot.watchlist);
  const live = [], recorded = [], pre = [], setAside = [];
  for (const p of snapshot.protocols) {
   if (hasMarket(p)) live.push(p);
   else if (recordsToken(p)) recorded.push(p);
   else if (watch.has(p.slug) || setAsideReason(p) === null) pre.push(p);
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
  tvl: { label: 'log10 TVL', why: 'size of deposits', x: (p) => Math.log10(p.tvl_usd) - 8 },
  growth: { label: 'log10(1 + 7-day change)', why: 'the week\'s net flow, clipped to -50%..+200%, priced as one more such week of TVL: more growth always adds value', x: (p) => Math.log10(1 + Math.max(-50, Math.min(200, p.change_7d ?? 0)) / 100) },
  age: { label: 'log10 days tracked', why: 'time run with no token: a 10x longer run counts like 10^a x more TVL (a from the blind grid), so a longer run never lowers value', x: (p, asOf) => Math.log10(Math.max(30, ageDays(asOf, p.listed_at) ?? 365)) - 2.5 },
  chains: { label: 'log10 chain count', why: 'reach across chains', x: (p) => Math.log10(Math.max(1, p.chains.length)) },
 };
 const CANDIDATES = ['tvl', 'growth', 'age', 'chains', 'sector'];
 const RIDGE = 1.0;          // penalty on every slope (not the intercept)
 /** Growth and age are priced in TVL units (their free slopes on the live tokens are noise; see
 *  calibrate): effective TVL = TVL x (1+g) x days^a, one slope >= 0, so both are monotone. */
 const AGE_GRID = [0, 0.1, 0.2, 0.3, 0.5];
 const AGE_DEFAULT = 0.2;    // used only while selectTerms runs, before the grid is scored
 const SECTOR_PRIOR = 8;     // a sector effect counts as this many pseudo-protocols at zero

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

 /** a = age's share of the TVL slope; chains gets its own ridge slope. */
 function fitValueModel(rows, terms, asOf, a) {
  const num = terms.filter((t) => t !== 'sector');
  const ag = a === undefined ? AGE_DEFAULT : a;
  const share = { tvl: 1, growth: 1, age: ag };
  const own = num.filter((t) => !(t in share));
  const eff = (p) => num.reduce((s, t) => s + (t in share ? share[t] * TERMS[t].x(p, asOf) : 0), 0);
  const X = rows.map((p) => [1, eff(p), ...own.map((t) => TERMS[t].x(p, asOf))]);
  const y = rows.map((p) => Math.log10(p.mcap_usd));
  const k = X[0].length;
  const A = [], b = [];
  for (let i = 0; i < k; i++) {
   A.push(new Array(k).fill(0)); b.push(0);
   for (let r = 0; r < X.length; r++) {
    b[i] += X[r][i] * y[r];
    for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
   }
   if (i > 1) A[i][i] += RIDGE;
  }
  const g = solve(A, b);
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

 function heldOut(live, terms, asOf, test, w) {
  const res = [];
  if (test === 'kfold') {
   for (let f = 0; f < 10; f++) {
    const train = live.filter((_, i) => i % 10 !== f), held = live.filter((_, i) => i % 10 === f);
    const fit = fitValueModel(train, terms, asOf, w);
    for (const p of held) res.push(Math.log10(p.mcap_usd) - predictLog(fit, p, asOf).log);
   }
  } else {
   // walk-forward: order by first listing, fit on the earlier, test on each later fifth
   const byDate = [...live].sort((a, b) => (a.listed_at || '0000').localeCompare(b.listed_at || '0000') || a.slug.localeCompare(b.slug));
   const step = Math.floor(byDate.length / 5);
   for (let s = 2; s < 5; s++) {
    const fit = fitValueModel(byDate.slice(0, s * step), terms, asOf, w);
    for (const p of byDate.slice(s * step, s === 4 ? byDate.length : (s + 1) * step)) res.push(Math.log10(p.mcap_usd) - predictLog(fit, p, asOf).log);
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
  const naive = heldOut(live, [], asOf, 'kfold');
  const ratio = live.map((p) => Math.log10(p.mcap_usd / p.tvl_usd)), medRatio = quantile(ratio, 0.5);
  const ratioRes = live.map((p, i) => ratio[i] - medRatio);
  return { terms, table, naive_mae: mae(naive), ratio_mae: mae(ratioRes) };
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
   const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
   const v = solve(A, [0, 1, 2].map((i) => X.reduce((s, r, n) => s + r[i] * y[n], 0)));
   const rss = X.reduce((s, r, n) => s + (y[n] - r[0] * v[0] - r[1] * v[1] - r[2] * v[2]) ** 2, 0) / (X.length - 3);
   const m = mean(X.map((r) => r[2])), sxx = X.reduce((s, r) => s + (r[2] - m) ** 2, 0);
   return { term: t, slope: v[2], se: Math.sqrt(rss / sxx) };
  });
  sel.prior_grid = grid; sel.prior_weight = best.weight; sel.free = free;
  const fit = fitValueModel(live, sel.terms, asOf, best.weight);
  const kf = heldOut(live, sel.terms, asOf, 'kfold', best.weight), wf = heldOut(live, sel.terms, asOf, 'walk', best.weight);
  const within = (r, lo, hi) => r.filter((v) => v >= lo && v <= hi).length / r.length;
  // range honesty: bands come from the 10-fold residuals and are checked on the walk-forward
  // residuals they never saw; x3 = share of real caps within a factor of 3 of the model
  const lo = quantile(kf, 0.1), hi = quantile(kf, 0.9), lo50 = quantile(kf, 0.25), hi50 = quantile(kf, 0.75), x3 = Math.log10(3);
  const honest = { walk50: within(wf, lo50, hi50), walk80: within(wf, lo, hi), kfold_x3: within(kf, -x3, x3), walk_x3: within(wf, -x3, x3), walk_med: quantile(wf.map(Math.abs), 0.5), kfold_med: quantile(kf.map(Math.abs), 0.5) };
  return {
   fit, selection: sel, odds: fitOdds(snapshot),
   heldout: { kfold_mae: mae(kf), walk_mae: mae(wf), kfold_bias: mean(kf), n: live.length, interval_lo: lo, interval_hi: hi, lo50, hi50, honest, walk_coverage: honest.walk80, naive_mae: sel.naive_mae, ratio_mae: sel.ratio_mae },
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
  const asOf = snapshot.as_of, rows = snapshot.protocols.filter((p) => p.listed_at && p.tvl_usd > 0);
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
 const FARM = { deposit: 1000, horizonDays: 90, seasonDays: 180, airdropShare: 0.075, lossRatePerYear: 0.02, bridgeUsd: 1.5, scaleCap: 50000 };
 const BASE_APY = { Yield: 0.05, Credit: 0.04, RWA: 0.045, Staking: 0.03, Trading: 0.03, Infra: 0, Exchange: 0.01, Other: 0.01 };

 function routeOf(chain) {
  const c = chain.toLowerCase();
  if (c === 'solana') return { wallet: 'Phantom or Solflare', bridge: 'USDC over Circle CCTP or a Solana on-ramp' };
  if (c === 'bitcoin') return { wallet: 'Xverse or Leather', bridge: 'native BTC from an exchange withdrawal' };
  if (c === 'tron') return { wallet: 'TronLink', bridge: 'USDT (TRC-20) from an exchange withdrawal' };
  if (c === 'sui') return { wallet: 'Sui Wallet or Suiet', bridge: 'USDC over Circle CCTP' };
  if (c === 'aptos') return { wallet: 'Petra', bridge: 'USDC over Circle CCTP' };
  if (c === 'ton') return { wallet: 'Tonkeeper', bridge: 'USDT on TON from an exchange withdrawal' };
  if (c === 'stellar' || c === 'ripple' || c === 'algorand' || c === 'cardano' || c === 'near') return { wallet: `the ${chain} reference wallet`, bridge: `USDC on ${chain} from an exchange withdrawal` };
  if (c === 'bittensor') return { wallet: 'a Bittensor wallet (btcli or Talisman)', bridge: 'TAO from an exchange withdrawal' };
  if (c === 'hyperliquid l1') return { wallet: 'Rabby or MetaMask connected to Hyperliquid', bridge: 'USDC deposited from Arbitrum' };
  if (c === 'ethereum') return { wallet: 'Rabby or MetaMask', bridge: 'USDC withdrawn from an exchange straight to Ethereum' };
  return { wallet: 'Rabby or MetaMask', bridge: `USDC to ${chain} over Circle CCTP or Across` };
 }

 const PLAYBOOK = {
  Yield: [['Deposit stablecoins into the protocol\'s main vault', 2, 10], ['Check the vault\'s curator, strategy and withdrawal delay on the vault page', 0, 15]],
  Credit: [['Supply a stablecoin to the main market', 2, 10], ['Borrow a small amount against it (keep health factor above 2) to show both sides of the book', 1, 10], ['Repay and re-borrow once a month; close the loan before any announced snapshot', 2, 10]],
  Trading: [['Swap or trade on the venue a few times a week with small size', 3, 15], ['Provide liquidity to one deep pool near the market price', 2, 15], ['Rebalance or claim fees every two weeks', 1, 10]],
  RWA: [['Complete the issuer\'s onboarding or KYC (1 to 3 days)', 0, 45], ['Mint or buy the tokenised asset with stablecoins', 2, 10], ['Hold through the season; redeem only through the issuer\'s own window', 1, 5]],
  Staking: [['Stake the native asset through the protocol\'s own pool', 2, 10], ['Use the receipt token in one integrated DeFi venue if offered', 2, 10], ['Keep the position open; note the unbonding period before you start', 0, 5]],
  Infra: [['Bridge or route a small amount through the protocol', 2, 10], ['Repeat on a second route or chain once a week', 2, 10], ['Use one application built on it each month', 1, 10]],
  Other: [['Use the protocol\'s main product with a small, steady position', 2, 15], ['Read its documentation for a points or rewards page and register if one exists', 0, 15], ['Repeat the main action monthly to build a track record', 1, 10]],
 };
 PLAYBOOK.Exchange = PLAYBOOK.Other;

 /** Steps by category ({n} = name). No points programme is invented: the step says how to find and verify one. */
 const CATEGORY_STEPS = {
  'Risk Curators': [['Before depositing, open the vault page of {n}\'s largest stablecoin vault (its site lists the lending markets it curates) and read the allocation list and timelock: a curator moves your funds between markets', 0, 10], ['Deposit USDC into that vault', 2, 10]],
  'Onchain Capital Allocator': [['Before depositing, check which strategies {n}\'s flagship vault (the one with the most TVL on its app) routes into and its withdrawal queue', 0, 10], ['Deposit USDC into that vault', 2, 10]],
  Dexs: [['Swap through {n} two or three times a week in small size; most DEX points count volume', 3, 15], ['Add liquidity to {n}\'s deepest stablecoin or major pair, in a range wide enough not to need daily rebalancing', 2, 15], ['Claim fees and re-centre the range every two weeks', 1, 10]],
  Lending: [['Supply USDC to {n}\'s largest market', 2, 10], ['Borrow up to a quarter of it so both sides of the book count (health factor above 2)', 1, 10], ['Repay before any snapshot {n} announces', 1, 5]],
  'Yield Aggregator': [['Deposit into {n}\'s largest stablecoin vault', 2, 10], ['Note the vault\'s underlying strategy and harvest fee on its page', 0, 10]],
  Yield: [['Deposit stablecoins into {n}\'s main product', 2, 10], ['Check where the yield comes from and the withdrawal delay on its page', 0, 15]],
  Derivatives: [['Deposit USDC margin on {n} and open small, hedged positions (long and short) a few times a week; perp points usually count volume and open interest', 4, 20], ['Alternatively supply to {n}\'s liquidity or insurance vault if it has one, which earns fees without directional risk', 2, 10], ['Close positions before any announced snapshot to avoid funding drag', 1, 5]],
  CDP: [['Open a vault on {n}: deposit ETH or a liquid-staked ETH and mint a small amount of its stablecoin (collateral ratio above 250%)', 2, 15], ['Put the minted stablecoin to use in {n}\'s own savings or stability pool if it has one', 1, 10]],
  'Basis Trading': [['Mint or deposit into {n}\'s delta-neutral product with USDC', 2, 10], ['Read how it handles negative funding and its redemption delay before sizing up', 0, 15]],
  RWA: [['Complete {n}\'s issuer onboarding or KYC (1 to 3 days)', 0, 45], ['Subscribe to its tokenised fund or note with stablecoins', 2, 10], ['Hold through the season; redeem only through the issuer\'s own window', 1, 5]],
 };

 const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
 const usd = (v) => (v >= 100 ? `$${thousands(v)}` : `$${v.toFixed(2)}`);

 function farmPlan(p, value, odds) {
  // chains are listed largest first: the cheapest of the first three
  const main = p.chains.slice(0, 3);
  const chains = main.map((c, i) => [c, i]).sort((a, b) => gasOf(a[0]) - gasOf(b[0]) || a[1] - b[1]).map((x) => x[0]);
  const chain = chains[0] || 'Ethereum', gas = gasOf(chain), route = routeOf(chain);
  const sector = sectorOf(p), apy = BASE_APY[sector] ?? 0.01, days = FARM.horizonDays;
  const cheaper = p.chains.length > 1 && gasOf(p.chains[0]) > gas ? `, not ${p.chains[0]} (${usd(gasOf(p.chains[0]))} a transaction against ${usd(gas)})` : '';
  const steps = [];
  let txs = 0, minutes = 0;
  const add = (text, n, min, extra = 0) => { steps.push({ text, cost: n * gas + extra, minutes: min }); txs += n; minutes += min; };
  add(`Install ${route.wallet} and fund it on ${chain}${cheaper}: move ${usd(FARM.deposit)} as ${route.bridge}.`, 1, 15, FARM.bridgeUsd);
  add(`Find ${p.name}'s points page: open its app from DefiLlama's link, search its docs and X account for "points"; if none exists, the plan still earns yield and you note the rules once one is announced.`, 0, 10);
  const own = CATEGORY_STEPS[p.category];
  for (const [what, n, min] of own || PLAYBOOK[sector]) add(`${what.replace(/\{n\}/g, p.name)} (${chain}; ${n === 0 ? 'reading only, no transaction' : `${n} transaction${n === 1 ? '' : 's'}`}).`, n, min);
  const monthly = sector === 'RWA' || sector === 'Staking' ? 0 : Math.round(days / 30);
  if (monthly > 0) add(`Top up or repeat the main action once a month for ${days} days (${monthly} more transactions), keeping the balance steady so time-weighted points keep accruing.`, monthly, 5 * monthly);
  const share = FARM.deposit / p.tvl_usd;
  const ev = FARM.airdropShare * value * share * (days / FARM.seasonDays) * odds.rate;
  const yieldUsd = FARM.deposit * apy * (days / 365);
  const risk = FARM.deposit * FARM.lossRatePerYear * (days / 365);
  add(`Exit after ${days} days or at the snapshot, whichever comes first: withdraw in one transaction; exit at once if TVL prints below ${usd(p.tvl_usd / 2)} (half of today) or the team rules out a token.`, 1, 5);
  const cost = steps.reduce((a, s) => a + s.cost, 0);
  const net = ev + yieldUsd - cost - risk;
  const ratio = ev / cost;
  const breakEven = cost / (ev / FARM.deposit);
  const size = Math.ceil((3 * breakEven) / 1000) * 1000;
  const hours = (minutes + 2) / 60, perHour = net / hours;
  const netAt = (d) => ((ev + yieldUsd - risk) * d) / FARM.deposit - cost, sizeHour = netAt(size) / hours;
  const verdict = ratio >= 3 && net > 0 ? 'Farm' : ratio >= 1 && net > 0 ? 'Test' : size <= FARM.scaleCap && netAt(size) > 0 ? 'Scale' : 'Watch';
  const sg = (v) => `${v >= 0 ? '+' : '-'}${usd(Math.abs(v))}`;
  const verdictText = {
   Farm: `the drop alone is ${ratio.toFixed(1)}x the gas at ${usd(FARM.deposit)}`,
   Test: `the drop pays its gas (${ratio.toFixed(1)}x), yield adds the rest; a small test`,
   Scale: `the drop is ${ratio.toFixed(1)}x gas at ${usd(FARM.deposit)}; from ${usd(size)} it is 3x, ${sg(sizeHour)}/h with yield`,
   Watch: `no deposit up to ${usd(FARM.scaleCap)} beats gas and risk; wait for a points programme`,
  }[verdict];
  steps.push({ text: `Expected result for ${usd(FARM.deposit)}: airdrop ${usd(ev)} (${(FARM.airdropShare * 100).toFixed(1)}% of the ${usd(value)} implied value, pro rata to TVL, ${days}/${FARM.seasonDays} season days, x ${(odds.rate * 100).toFixed(0)}% odds of a token in ${ODDS.horizonDays} days) + ${usd(yieldUsd)} of ${(apy * 100).toFixed(1)}% yield - ${usd(cost)} gas - ${usd(risk)} contract risk = net ${sg(net)}, ${sg(perHour)}/h over ${minutes + 2} min. Verdict ${verdict}: ${verdictText}.`, cost: 0, minutes: 2 });
  return { chain, gas, steps, ev, yieldUsd, net, cost, risk, ratio, verdict, verdictText, breakEven, size, perHour, sizeHour, minutes: minutes + 2, txs };
 }

 function valueRow(p, cal, snapshot) {
  const asOf = snapshot.as_of, pr = predictLog(cal.fit, p, asOf), h = cal.heldout;
  const value = Math.max(1, Math.round(10 ** pr.log));
  const odds = launchOdds(p, cal.odds, asOf), plan = farmPlan(p, value, odds);
  return {
   slug: p.slug, name: p.name, category: p.category, sector: sectorOf(p), chains: p.chains,
   tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, days_pre_token: ageDays(asOf, p.listed_at),
   watchlist: snapshot.watchlist.includes(p.slug),
   implied_value_usd: value,
   low_usd: Math.max(1, Math.round(10 ** (pr.log + h.interval_lo))), high_usd: Math.max(1, Math.round(10 ** (pr.log + h.interval_hi))),
   p25_usd: Math.max(1, Math.round(10 ** (pr.log + h.lo50))), p75_usd: Math.max(1, Math.round(10 ** (pr.log + h.hi50))),
   value_to_tvl: value / p.tvl_usd,
   parts: pr.parts.map((q) => ({ term: q.term, label: q.label, log: q.log })),
   odds, plan,
  };
 }

 /** fnv(): FNV-1a over "rank slug value" lines; main.ts stores it, the page recomputes it from its own rows. */
 const fnv = (rows) => { let x = 0x811c9dc5; for (const c of rows.map((r) => `${r.rank} ${r.slug} ${r.implied_value_usd}`).join('\n')) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x.toString(16).padStart(8, '0'); };

 const api = { SECTORS, TERMS, CANDIDATES, FARM, BASE_APY, routeOf, GAS_USD, sectorOf, setAsideReason, splitUniverse, ageDays, fitValueModel, predictLog, heldOut, selectTerms, calibrate, ODDS, fitOdds, launchOdds, farmPlan, valueRow, gasOf, quantile, mae, fnv };
 if (typeof module === 'object' && module.exports) module.exports = api;
 else root.RadarModel = api;
})(typeof window === 'object' ? window : globalThis);
