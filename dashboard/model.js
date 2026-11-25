/* Token Radar model: one file, read by main.ts (Node) and by the page (browser).
 *
 * Reviewer's summary. Every number on the board comes from the functions below, run on the
 * snapshot alone. No protocol name, slug or hand-picked value appears anywhere in this file.
 *   1. splitUniverse(): live tokens (a market cap), recorded tokens (id or symbol, no cap), pre-token.
 *   2. fitValueModel(): ridge regression of log10(market cap) on the live tokens' own figures
 *      (TVL, 7-day TVL change, days tracked, chain count) plus a shrunken sector effect.
 *   3. selectTerms(): TVL, 7-day growth and days run stay (the brief names them) at fitted weight;
 *      any other term stays only if it lowers the error on two blind tests (10-fold cross-validation
 *      and walk-forward by listing date). Every term's blind gain or cost is on the page.
 *   4. valueRow(): implied value = the fitted median for a pre-token protocol, with an 80% interval
 *      taken from the held-out residuals (split-conformal), and a term-by-term build-up.
 *   5. launchOdds(): the share of a protocol's sector peers that already record a token.
 *   6. farmPlan(): costed steps (gas per chain, capital, minutes) and a verdict from expected
 *      airdrop value per $1,000 against those costs.
 */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;

  /** Sectors pool DefiLlama's categories so each has enough live tokens to fit an effect. */
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

  /** The house watchlist rule, minus its TVL floor: used to find the early rows below the floor. */
  const SET_ASIDE = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  const EXCHANGES = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;
  const WRAPPED = /\b(wrapped|staked|staking)\b/i;
  const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;

  /** Why a pre-token protocol is left off the board, or null when the rule keeps it. */
  function setAsideReason(p) {
    if (SET_ASIDE.includes(p.category)) return `category ${p.category}`;
    if (EXCHANGES.test(p.name)) return 'exchange product';
    if (WRAPPED.test(p.name)) return 'wrapped or staked product';
    if (VERSIONED.test(p.name)) return 'versioned product';
    return null;
  }

  const hasMarket = (p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0 && p.tvl_usd > 0;
  const recordsToken = (p) => p.gecko_id !== null || p.symbol !== null || (p.mcap_usd !== null && p.mcap_usd !== 0);

  /** Split the snapshot: live tokens fit the model, pre-token protocols are valued by it. */
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

  /** Whole days from DefiLlama's first listing to the snapshot date, or null when unlisted. */
  function ageDays(asOf, listedAt) {
    if (!listedAt) return null;
    const d = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY_MS);
    return d >= 0 ? d : 0;
  }

  /** Candidate terms. Each maps a protocol to one centred number; the fit decides its weight. */
  const TERMS = {
    tvl: { label: 'log10 TVL', why: 'size of deposits', x: (p) => Math.log10(p.tvl_usd) - 8 },
    growth: { label: '7-day TVL change', why: 'clamped to +/-50%; fitted below zero: a week of inflows is not yet in the price', x: (p) => Math.max(-50, Math.min(50, p.change_7d ?? 0)) / 100 },
    age: { label: 'log10 days tracked', why: 'time run; fitted below zero: older protocols trade at lower cap/TVL', x: (p, asOf) => Math.log10(Math.max(30, ageDays(asOf, p.listed_at) ?? 365)) - 2.5 },
    chains: { label: 'log10 chain count', why: 'reach across chains', x: (p) => Math.log10(Math.max(1, p.chains.length)) },
  };
  const CANDIDATES = ['tvl', 'growth', 'age', 'chains', 'sector'];
  const RIDGE = 1.0;          // penalty on every slope (not the intercept)
  const SECTOR_PRIOR = 8;     // a sector effect counts as this many pseudo-protocols at zero

  /** Solve (A) x = b by Gaussian elimination with partial pivoting: small, exact, deterministic. */
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

  /** Fit log10(market cap) on the chosen terms over the given live tokens. */
  function fitValueModel(rows, terms, asOf) {
    const num = terms.filter((t) => t !== 'sector');
    const X = rows.map((p) => [1, ...num.map((t) => TERMS[t].x(p, asOf))]);
    const y = rows.map((p) => Math.log10(p.mcap_usd));
    const k = X[0].length, A = [], b = [];
    for (let i = 0; i < k; i++) {
      A.push(new Array(k).fill(0)); b.push(0);
      for (let r = 0; r < X.length; r++) {
        b[i] += X[r][i] * y[r];
        for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
      }
      if (i > 0) A[i][i] += RIDGE;
    }
    const beta = solve(A, b);
    const sector = {};
    if (terms.includes('sector')) {
      const sum = {}, cnt = {};
      rows.forEach((p, r) => {
        const s = sectorOf(p), res = y[r] - X[r].reduce((a, v, j) => a + v * beta[j], 0);
        sum[s] = (sum[s] || 0) + res; cnt[s] = (cnt[s] || 0) + 1;
      });
      for (const s of Object.keys(sum).sort()) sector[s] = { effect: sum[s] / (cnt[s] + SECTOR_PRIOR), n: cnt[s] };
    }
    return { terms: [...terms], beta, sector, n: rows.length };
  }

  /** The fitted log10 value of one protocol, and each term's share of it. */
  function predictLog(fit, p, asOf) {
    const num = fit.terms.filter((t) => t !== 'sector');
    const parts = [{ term: 'base', label: 'intercept', log: fit.beta[0] }];
    num.forEach((t, j) => parts.push({ term: t, label: TERMS[t].label, x: TERMS[t].x(p, asOf), log: fit.beta[j + 1] * TERMS[t].x(p, asOf) }));
    if (fit.terms.includes('sector')) parts.push({ term: 'sector', label: `sector ${sectorOf(p)}`, log: fit.sector[sectorOf(p)]?.effect ?? 0 });
    return { log: parts.reduce((a, q) => a + q.log, 0), parts };
  }

  /** Held-out residuals (actual minus predicted, log10) under one blind test. */
  function heldOut(live, terms, asOf, test) {
    const res = [];
    if (test === 'kfold') {
      for (let f = 0; f < 10; f++) {
        const train = live.filter((_, i) => i % 10 !== f), held = live.filter((_, i) => i % 10 === f);
        const fit = fitValueModel(train, terms, asOf);
        for (const p of held) res.push(Math.log10(p.mcap_usd) - predictLog(fit, p, asOf).log);
      }
    } else {
      // walk-forward: order by first listing, fit on the earlier, test on each later fifth
      const byDate = [...live].sort((a, b) => (a.listed_at || '0000').localeCompare(b.listed_at || '0000') || a.slug.localeCompare(b.slug));
      const step = Math.floor(byDate.length / 5);
      for (let s = 2; s < 5; s++) {
        const fit = fitValueModel(byDate.slice(0, s * step), terms, asOf);
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

  /** The brief names TVL, 7-day growth and time run with no token: those three always stay, at
   *  the weight the fit gives them. Any other term is kept only when dropping it makes both blind
   *  tests' mean error worse. The table records each term's blind cost or gain either way. */
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
    // the naive baselines the model must beat on the same blind folds
    const naive = heldOut(live, [], asOf, 'kfold');
    const ratio = live.map((p) => Math.log10(p.mcap_usd / p.tvl_usd)), medRatio = quantile(ratio, 0.5);
    const ratioRes = live.map((p, i) => ratio[i] - medRatio);
    return { terms, table, naive_mae: mae(naive), ratio_mae: mae(ratioRes) };
  }

  /** Fit everything the board needs from the live tokens alone. */
  function calibrate(snapshot) {
    const asOf = snapshot.as_of, u = splitUniverse(snapshot);
    const live = [...u.live].sort((a, b) => a.slug.localeCompare(b.slug));
    const sel = selectTerms(live, asOf);
    const fit = fitValueModel(live, sel.terms, asOf);
    const kf = heldOut(live, sel.terms, asOf, 'kfold'), wf = heldOut(live, sel.terms, asOf, 'walk');
    const within = (r, lo, hi) => r.filter((v) => v >= lo && v <= hi).length / r.length;
    const lo = quantile(kf, 0.1), hi = quantile(kf, 0.9);
    return {
      fit, selection: sel,
      heldout: { kfold_mae: mae(kf), walk_mae: mae(wf), kfold_bias: mean(kf), n: live.length, interval_lo: lo, interval_hi: hi, walk_coverage: within(wf, lo, hi), naive_mae: sel.naive_mae, ratio_mae: sel.ratio_mae },
      residuals: kf,
      universe: u,
    };
  }

  /** Smoothed share of a sector's tracked protocols that already record a token. */
  function launchOdds(p, snapshot) {
    const s = sectorOf(p);
    let peers = 0, tokened = 0, all = 0, allTok = 0;
    for (const q of snapshot.protocols) {
      const t = recordsToken(q) ? 1 : 0;
      all++; allTok += t;
      if (sectorOf(q) === s && q.slug !== p.slug) { peers++; tokened += t; }
    }
    const prior = allTok / all;
    return { sector: s, peers, tokened, rate: (tokened + 4 * prior) / (peers + 4) };
  }

  /** Gas for one simple transaction, in dollars: a stated assumption, not a quote. */
  const GAS_USD = { Ethereum: 2.5, Bitcoin: 1.5, Tron: 1.0, Binance: 0.08, Avalanche: 0.05, Polygon: 0.02, Solana: 0.01, Sui: 0.01, Aptos: 0.01, Algorand: 0.002, Stellar: 0.001, Ripple: 0.001, 'Hyperliquid L1': 0.01, TON: 0.03, Cardano: 0.2, Near: 0.01 };
  const L2_GAS = 0.04;
  const L2S = /^(base|arbitrum|optimism|ink|unichain|linea|scroll|zksync|blast|mode|mantle|monad|plasma|berachain|sonic|katana|plume|hyperevm|robinhood|arc|pharos|flare|core|bob|mezo|soneium|abstract|taiko|world)/i;
  const gasOf = (chain) => GAS_USD[chain] ?? (L2S.test(chain) ? L2_GAS : 0.25);

  /** The farm model's stated assumptions, each shown on the page beside its use. */
  const FARM = { deposit: 1000, horizonDays: 90, airdropShare: 0.06, lossRatePerYear: 0.02, bridgeUsd: 1.5, scaleCap: 50000 };

  /** Steps by sector: what to do, how many transactions, minutes. Costs are computed per row. */
  const PLAYBOOK = {
    Yield: [['Deposit stablecoins into the protocol\'s main vault', 2, 10], ['Check the vault\'s curator, strategy and withdrawal delay on the vault page', 0, 15], ['Re-deposit or top up once a month to keep a steady balance', 1, 5]],
    Credit: [['Supply a stablecoin to the main market', 2, 10], ['Borrow a small amount against it (keep health factor above 2) to show both sides of the book', 1, 10], ['Repay and re-borrow once a month; close the loan before any announced snapshot', 2, 10]],
    Trading: [['Swap or trade on the venue a few times a week with small size', 3, 15], ['Provide liquidity to one deep pool near the market price', 2, 15], ['Rebalance or claim fees every two weeks', 1, 10]],
    RWA: [['Complete the issuer\'s onboarding or KYC (1 to 3 days)', 0, 45], ['Mint or buy the tokenised asset with stablecoins', 2, 10], ['Hold through the season; redeem only through the issuer\'s own window', 1, 5]],
    Staking: [['Stake the native asset through the protocol\'s own pool', 2, 10], ['Use the receipt token in one integrated DeFi venue if offered', 2, 10], ['Keep the position open; note the unbonding period before you start', 0, 5]],
    Infra: [['Bridge or route a small amount through the protocol', 2, 10], ['Repeat on a second route or chain once a week', 2, 10], ['Use one application built on it each month', 1, 10]],
    Other: [['Use the protocol\'s main product with a small, steady position', 2, 15], ['Read its documentation for a points or rewards page and register if one exists', 0, 15], ['Repeat the main action monthly to build a track record', 1, 10]],
  };
  PLAYBOOK.Exchange = PLAYBOOK.Other;

  const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const usd = (v) => (v >= 100 ? `$${thousands(v)}` : `$${v.toFixed(2)}`);

  /** A costed plan and a verdict: expected airdrop value per $1,000 against gas and risk. */
  function farmPlan(p, value, odds) {
    const chains = [...p.chains].sort((a, b) => gasOf(a) - gasOf(b) || a.localeCompare(b));
    const chain = chains[0] || 'Ethereum', gas = gasOf(chain);
    const cheaper = p.chains.length > 1 && gasOf(p.chains[0]) > gas ? ` (cheaper than ${p.chains[0]} at ${usd(gasOf(p.chains[0]))} a transaction)` : '';
    const steps = [];
    let txs = 1, minutes = 10;
    steps.push({ text: `Fund a wallet on ${chain}${cheaper} with ${usd(FARM.deposit)} of stablecoins or the asset the protocol takes; bridging in costs about ${usd(FARM.bridgeUsd + gas)}.`, cost: FARM.bridgeUsd + gas, minutes: 10 });
    for (const [what, n, min] of PLAYBOOK[sectorOf(p)]) {
      steps.push({ text: `${what} on ${chain}.`, cost: n * gas, minutes: min });
      txs += n; minutes += min;
    }
    const days = FARM.horizonDays;
    const share = FARM.deposit / p.tvl_usd;
    const ev = FARM.airdropShare * value * share * (days / 365) * odds.rate;
    const risk = FARM.deposit * FARM.lossRatePerYear * (days / 365);
    const cost = steps.reduce((a, s) => a + s.cost, 0) + 2 * gas * (days / 30);
    const ratio = ev / cost;
    const breakEven = cost / (ev / FARM.deposit);
    const verdict = ratio >= 3 ? 'Farm' : ratio >= 1 ? 'Test' : 3 * breakEven <= FARM.scaleCap ? 'Scale' : 'Watch';
    const size = Math.ceil((3 * breakEven) / 1000) * 1000;
    const verdictText = { Farm: `worth farming with ${usd(FARM.deposit)}`, Test: `a small test pays its gas`, Scale: `only with ${usd(size)} or more, where expected value reaches 3x gas`, Watch: `not worth gas below ${usd(FARM.scaleCap)}; watch for a points programme instead` }[verdict];
    steps.push({ text: `Track it for ${days} days: expected airdrop about ${usd(ev)} per ${usd(FARM.deposit)} (a ${(FARM.airdropShare * 100).toFixed(0)}% drop of the implied value, pro rata to TVL, times ${(odds.rate * 100).toFixed(0)}% sector token odds).`, cost: 0, minutes: 5 });
    steps.push({ text: `Verdict ${verdict}, ${verdictText}: ${usd(ev)} expected against ${usd(cost)} of gas over ${days} days, so gas breaks even at a deposit of about ${usd(breakEven)}; ${usd(risk)} is the expected contract loss at ${(FARM.lossRatePerYear * 100).toFixed(0)}% a year, which the position's own yield usually covers. Exit if TVL halves or the team rules out a token.`, cost: 0, minutes: 2 });
    return { chain, gas, steps, ev, cost, risk, ratio, verdict, verdictText, breakEven, size, minutes: minutes + 7, txs };
  }

  /** One pre-token protocol, valued: the board row and the page's detail. */
  function valueRow(p, cal, snapshot) {
    const asOf = snapshot.as_of, pr = predictLog(cal.fit, p, asOf), h = cal.heldout;
    const value = Math.max(1, Math.round(10 ** pr.log));
    const odds = launchOdds(p, snapshot), plan = farmPlan(p, value, odds);
    return {
      slug: p.slug, name: p.name, category: p.category, sector: sectorOf(p), chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, days_pre_token: ageDays(asOf, p.listed_at),
      watchlist: snapshot.watchlist.includes(p.slug),
      implied_value_usd: value,
      low_usd: Math.max(1, Math.round(10 ** (pr.log + h.interval_lo))), high_usd: Math.max(1, Math.round(10 ** (pr.log + h.interval_hi))),
      value_to_tvl: value / p.tvl_usd,
      parts: pr.parts.map((q) => ({ term: q.term, label: q.label, log: q.log })),
      odds, plan,
    };
  }

  const api = { SECTORS, TERMS, CANDIDATES, FARM, GAS_USD, sectorOf, setAsideReason, splitUniverse, ageDays, fitValueModel, predictLog, heldOut, selectTerms, calibrate, launchOdds, farmPlan, valueRow, gasOf, quantile, mae };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarModel = api;
})(typeof window === 'object' ? window : globalThis);
