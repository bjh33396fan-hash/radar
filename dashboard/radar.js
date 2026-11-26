/* Token Radar page: reads window.RADAR (data.js) and window.RadarModel (model.js), and re-derives
* every implied value from model.js before showing it. */
(function () {
 'use strict';
 const R = window.RADAR, M = window.RadarModel;
 const $ = (s, el = document) => el.querySelector(s);
 const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

 function money(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(a >= 10 ? 0 : 2)}`;
 }
 const belowCount = R.rows.filter((r) => !r.watchlist && r.tvl_usd < R.floor_usd).length;
 function offReason(r) {
  if (r.watchlist) return 'on the watchlist';
  if (r.tvl_usd < R.floor_usd) return `off the watchlist: TVL under the $${(R.floor_usd / 1e6).toFixed(0)}M floor`;
  return `off the watchlist: over the floor, but a product of a tokenised parent, a version or an excluded category`;
 }
 const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
 const times = (log) => `\u00d7${(10 ** log).toFixed(2)}`;

 const fit = { terms: R.fit.terms, beta: R.fit.beta, sector: R.fit.sector };
 let matches = 0;
 for (const r of R.rows) {
  const p = R.snap[r.slug];
  if (p && Math.max(1, Math.round(10 ** M.predictLog(fit, p, R.as_of).log)) === r.implied_value_usd) matches++;
 }
 const h = R.fit.heldout;
 for (const t of R.fit.table) t.helps = t.with_kfold < t.without_kfold && t.with_walk < t.without_walk;
 const sectors = [...new Set(R.rows.map((r) => r.sector))].sort();
 const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort((a, b) => R.rows.filter((r) => r.chains.includes(b)).length - R.rows.filter((r) => r.chains.includes(a)).length || a.localeCompare(b)).slice(0, 24);

 const DEFAULT = { tab: 'board', q: '', seg: 'all', sector: '', chain: '', verdict: '', sort: 'implied_value_usd', dir: 'desc', open: '', limit: '60' };
 function readState() {
  const s = { ...DEFAULT };
  for (const part of location.hash.slice(1).split('&')) {
   const [k, v] = part.split('=');
   if (k in s && v !== undefined) s[k] = decodeURIComponent(v);
  }
  return s;
 }
 let S = readState();
 function setState(patch) {
  S = { ...S, ...patch };
  const parts = Object.keys(DEFAULT).filter((k) => S[k] !== DEFAULT[k]).map((k) => `${k}=${encodeURIComponent(S[k])}`);
  history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
  render();
 }

 const COLS = [
  { key: 'rank', label: '#', n: false },
  { key: 'name', label: 'Protocol' },
  { key: 'chains', label: 'Chains' },
  { key: 'tvl_usd', label: 'TVL', n: true },
  { key: 'change_7d', label: '7d', n: true },
  { key: 'days_pre_token', label: 'Days, no token', n: true },
  { key: 'implied_value_usd', label: 'Implied value \u00b7 P25\u2013P75', n: true },
  { key: 'value_to_tvl', label: 'Value / TVL', n: true },
  { key: 'odds', label: 'Token in 1 yr', n: true },
  { key: 'ev', label: 'Drop EV / $1k', n: true },
  { key: 'verdict', label: 'Farm \u00b7 $/h' },
 ];
 const sortValue = (r, k) => (k === 'odds' ? r.odds.rate : k === 'ev' ? r.plan.ev : k === 'verdict' ? r.plan.perHour : k === 'chains' ? r.chains.length : r[k]);

 function filtered() {
  const q = S.q.trim().toLowerCase();
  const rows = R.rows.filter((r) =>
   (S.seg === 'all' || (S.seg === 'watch' ? r.watchlist : !r.watchlist)) &&
   (!S.sector || r.sector === S.sector) && (!S.chain || r.chains.includes(S.chain)) &&
   (!S.verdict || r.plan.verdict === S.verdict) &&
   (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || String(r.category).toLowerCase().includes(q)));
  const k = S.sort, d = S.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
   const x = sortValue(a, k), y = sortValue(b, k);
   if (x === y) return a.rank - b.rank;
   if (x === null || x === undefined) return 1;
   if (y === null || y === undefined) return -1;
   return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
  });
 }

 function band(r) {
  const pos = (v) => Math.max(0, Math.min(100, ((Math.log10(v) - 5) / 5) * 100));
  return `<span class="band" title="P25 ${money(r.p25_usd)} to P75 ${money(r.p75_usd)}; P10-P90 ${money(r.low_usd)} to ${money(r.high_usd)}"><i style="left:${pos(r.p25_usd)}%;right:${100 - pos(r.p75_usd)}%"></i><b style="left:calc(${pos(r.implied_value_usd)}% - 1px)"></b></span><small class="rng">${money(r.p25_usd)}\u2013${money(r.p75_usd)}</small>`;
 }

 // Out-of-sample evidence on the board itself: every term's two blind tests, the odds tests, and
 // whether the printed ranges hold on protocols the fit never saw.
 function evidenceHtml() {
  const x = (v) => times(v).replace('.00', '');
  const val = R.fit.table.map((t) => {
   const why = t.helps ? '<em class="yes">kept: lowers both</em>' : t.kept ? `<em class="warn">kept (named by the brief), costs +${(100 * (10 ** Math.max(t.with_kfold - t.without_kfold, t.with_walk - t.without_walk) - 1)).toFixed(1)}% miss</em>` : '<em class="no">tested, not kept</em>';
   return `<tr><td>+ ${esc(M.TERMS[t.term]?.label ?? 'sector effect')}</td><td class="n">${x(t.with_kfold)} <s>${x(t.without_kfold)}</s></td><td class="n">${x(t.with_walk)} <s>${x(t.without_walk)}</s></td><td>${why}</td></tr>`;
  }).join('');
  const o = R.fit.odds, ot = o.tests, hh = h.honest;
  const odds = [['base rate of peers', o.flat_loss, 'baseline'], ['+ sector', o.sector_loss, 'kept'], ['+ age, log10 days', ot[0].without, 'kept'], ...ot.map((t) => [`+ ${t.term}`, t.with, t.kept ? 'kept' : `tested, not kept (slope ${t.slope.toFixed(2)})`])]
   .map(([n, l, k]) => `<tr><td>${esc(n)}</td><td class="n">${l.toFixed(3)}</td><td><em class="${k === 'kept' ? 'yes' : k === 'baseline' ? '' : 'no'}">${esc(k)}</em></td></tr>`).join('');
  const pc = (v) => `${(v * 100).toFixed(0)}%`;
  return `<section class="evid"><h4>Out-of-sample evidence <span>recomputed by model.js on this snapshot; a term stays only if it lowers the miss in both tests (10-fold; walk-forward: earlier listings price later ones)</span></h4><div class="ev3">
   <div><h5>Value if a token launches \u00b7 typical miss on ${h.n} traded tokens</h5><table><tr><th>Term</th><th class="n">10-fold <s>without</s></th><th class="n">Walk-fwd <s>without</s></th><th></th></tr>
    <tr><td>flat median multiple</td><td class="n">${x(h.naive_mae)}</td><td class="n">\u2014</td><td><em>baseline</em></td></tr>${val}
    <tr><td><b>final model</b>, mean</td><td class="n"><b>${x(h.kfold_mae)}</b></td><td class="n"><b>${x(h.walk_mae)}</b></td><td></td></tr><tr><td><b>final model</b>, median</td><td class="n"><b>${x(h.honest.kfold_med)}</b></td><td class="n"><b>${x(h.honest.walk_med)}</b></td><td><em>half the misses are smaller</em></td></tr></table></div>
   <div><h5>Token odds \u00b7 10-fold log loss on ${o.n} dated peers (${o.tokened} record a token)</h5><table><tr><th>Term</th><th class="n">Log loss</th><th></th></tr>${odds}</table></div>
   <div><h5>Is the printed range honest? (bands from 10-fold, checked walk-forward)</h5><table><tr><th>Share of real caps</th><th class="n">Stated</th><th class="n">Held out</th></tr>
    <tr><td>inside P25\u2013P75</td><td class="n">50%</td><td class="n"><b>${pc(hh.walk50)}</b></td></tr><tr><td>inside P10\u2013P90</td><td class="n">80%</td><td class="n"><b>${pc(hh.walk80)}</b></td></tr>
    <tr><td>within \u00d73 of the model</td><td class="n">\u2014</td><td class="n">${pc(hh.kfold_x3)} \u00b7 ${pc(hh.walk_x3)}</td></tr></table>
    <p class="note">A pre-token value is a wide claim: half of real caps land inside P25\u2013P75, a fifth outside P10\u2013P90. The board prints both, never one number alone.</p></div></div></section>`;
 }

 function rowHtml(r) {
  const chainText = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ` +${r.chains.length - 2}` : '');
  return `<tr data-slug="${esc(r.slug)}"${S.open === r.slug ? ' class="sel"' : ''}>
   <td class="rank">${r.rank}</td>
   <td><span class="nm">${esc(r.name)}</span>${r.watchlist ? '<span class="tag w">watchlist</span>' : ''}<div class="sub">${esc(r.category ?? 'Uncategorised')} \u00b7 ${esc(r.sector)}</div></td>
   <td class="sub">${esc(chainText)}</td>
   <td class="n">${money(r.tvl_usd)}</td>
   <td class="n ${r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''}">${pct(r.change_7d)}</td>
   <td class="n">${r.days_pre_token ?? '365<span class="note">*</span>'}</td>
   <td class="n"><b>${money(r.implied_value_usd)}</b>${band(r)}</td>
   <td class="n">${r.value_to_tvl.toFixed(2)}</td>
   <td class="n">${(r.odds.rate * 100).toFixed(0)}%</td>
   <td class="n">${money(r.plan.ev)}</td>
   <td class="vd"><span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span>${r.plan.verdict === 'Scale' ? `<small>3\u00d7 gas from ${money(r.plan.size)}</small>` : `<small class="${r.plan.perHour >= 0 ? 'up' : 'down'}">${r.plan.perHour >= 0 ? '+' : '\u2212'}${money(Math.abs(r.plan.perHour))}/h</small>`}</td></tr>`;
 }

 function boardHtml() {
  const rows = filtered(), lim = Number(S.limit) || 60;
  const seg = (v, t) => `<button data-seg="${v}" class="${S.seg === v ? 'on' : ''}">${t}</button>`;
  const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  return `<div class="filters" role="search">
    <input type="search" id="q" placeholder="Search protocol or category" value="${esc(S.q)}" aria-label="Search">
    <div class="seg">${seg('all', 'All pre-token')}${seg('watch', `Watchlist (${R.checks.watch})`)}${seg('below', `Off the watchlist (${R.rows.length - R.checks.watch})`)}</div>
    <select id="sector" aria-label="Sector">${opt(sectors, S.sector, 'Every sector')}</select>
    <select id="chain" aria-label="Chain">${opt(chains, S.chain, 'Every chain')}</select>
    <select id="verdict" aria-label="Farm verdict">${opt(['Farm', 'Test', 'Scale', 'Watch'], S.verdict, 'Every verdict')}</select>
    <span class="shown">${rows.length} of ${R.rows.length} shown \u00b7 ranked by implied value \u00b7 365<span class="note">*</span> = no listing date, 365 days assumed \u00b7 click a row for its plan</span></div>
   <div class="table"><table><thead><tr>${COLS.map((c) => `<th data-k="${c.key}" class="${c.n ? 'n' : ''}"${S.sort === c.key ? ` aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
   <tbody>${rows.slice(0, lim).map(rowHtml).join('')}</tbody></table>
   ${rows.length > lim ? `<div class="more"><button class="close" id="more">Show all ${rows.length}</button></div>` : ''}</div>`;
 }

 function peersOf(r) {
  const lt = Math.log10(r.tvl_usd);
  return R.live.filter((q) => q.sector === r.sector).sort((a, b) => Math.abs(Math.log10(a.tvl_usd) - lt) - Math.abs(Math.log10(b.tvl_usd) - lt) || a.slug.localeCompare(b.slug)).slice(0, 4);
 }

 // Net over the plan's days after gas and risk, minus what the same deposit earns in 4% T-bills,
 // for three deposits and three drop sizes (the drop scales with deposit and share; gas does not).
 function grid(r) {
  const p = r.plan, bill = (d) => d * 0.04 * M.FARM.horizonDays / 365;
  const net = (d, s) => ((p.ev * s) / M.FARM.airdropShare + p.yieldUsd - p.risk) * d / M.FARM.deposit - p.cost;
  const cell = (v) => `<td class="n ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : '\u2212'}${money(Math.abs(v))}</td>`;
  const D = [1000, 10000, 50000];
  return `<table class="peers"><tr><th>Drop share \u2193 \u00b7 deposit \u2192 (net after gas, risk)</th>${D.map((d) => `<th class="n">${money(d)}</th>`).join('')}</tr>${[0.025, M.FARM.airdropShare, 0.15].map((s) => `<tr><td>${(s * 100).toFixed(1)}% of implied value${s === M.FARM.airdropShare ? ' (used)' : ''}</td>${D.map((d) => cell(net(d, s))).join('')}</tr>`).join('')}<tr><td class="note">benchmark: 4% T-bills, same days</td>${D.map((d) => `<td class="n note">+${money(bill(d))}</td>`).join('')}</tr></table>`;
 }

 function detailHtml(r) {
  if (!r) return '';
  const max = Math.max(...r.parts.filter((q) => q.term !== 'base').map((q) => Math.abs(q.log)), 0.2);
  const build = r.parts.map((q) => q.term === 'base'
   ? `<tr><td>Fitted base at $100M TVL</td><td class="bar"></td><td class="n">${money(10 ** q.log)}</td></tr>`
   : `<tr><td>${esc(q.label)}</td><td class="bar"><i style="width:${(Math.abs(q.log) / max) * 100}%;background:${q.log >= 0 ? 'var(--teal)' : 'var(--red)'}"></i></td><td class="n">${times(q.log)}</td></tr>`).join('');
  const steps = r.plan.steps.map((s) => `<li><span>${esc(s.text)}</span><span class="cost">$${s.cost.toFixed(2)}<br>${s.minutes} min</span></li>`).join('');
  const peers = peersOf(r).map((q) => `<tr><td>${esc(q.name)}</td><td class="n">${money(q.tvl_usd)}</td><td class="n">${money(q.mcap_usd)}</td><td class="n">${(q.mcap_usd / q.tvl_usd).toFixed(2)}</td></tr>`).join('');
  return `<button class="close" id="close">Close</button>
   <div class="sub">Rank ${r.rank} of ${R.rows.length} \u00b7 ${esc(r.category ?? 'Uncategorised')} \u00b7 ${offReason(r)}</div>
   <h2>${esc(r.name)}</h2>
   <div style="margin-top:12px"><span class="big">${money(r.implied_value_usd)}</span> <span class="note">implied token value \u00b7 P25\u2013P75 ${money(r.p25_usd)} to ${money(r.p75_usd)} \u00b7 P10\u2013P90 ${money(r.low_usd)} to ${money(r.high_usd)} (held out: ${(h.honest.walk50 * 100).toFixed(0)}% \u00b7 ${(h.honest.walk80 * 100).toFixed(0)}% of real caps inside)</span></div>
   <div class="sum"><span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span><div><b>Per $1,000 for ${M.FARM.horizonDays} days: ${r.plan.net >= 0 ? '+' : '\u2212'}${money(Math.abs(r.plan.net))} net \u00b7 ${r.plan.perHour >= 0 ? '+' : '\u2212'}${money(Math.abs(r.plan.perHour))}/h</b><br><span class="note">${esc(r.plan.verdictText)} \u00b7 ${r.plan.txs} txs, ${money(r.plan.cost)} gas, ${r.plan.minutes} min on ${esc(r.plan.chain)}</span></div></div>
   <div class="facts">
    <div><span>TVL</span><b>${money(r.tvl_usd)}</b></div><div><span>7-day change</span><b class="${r.change_7d > 0 ? 'up' : 'down'}">${pct(r.change_7d)}</b></div><div><span>Tracked, no token</span><b>${r.days_pre_token ?? 365} days</b>${r.days_pre_token === null || r.days_pre_token === undefined ? ' <small class="note">no listing date: 365 assumed</small>' : ''}</div>
    <div><span>Value / TVL</span><b>${r.value_to_tvl.toFixed(2)}</b></div><div><span>Token within ${M.ODDS.horizonDays} days</span><b>${(r.odds.rate * 100).toFixed(0)}%</b> <small class="note">survival fit: ${(r.odds.now * 100).toFixed(0)}% of like ${esc(r.odds.sector)} protocols have one at this age, ${(r.odds.later * 100).toFixed(0)}% a year older</small></div><div><span>Cheapest main chain</span><b>${esc(r.plan.chain)}</b></div>
   </div>
   <h3>How the value is built (model.js predictLog)</h3>
   <table class="build">${build}<tr><td><b>Implied value</b></td><td></td><td class="n"><b>${money(r.implied_value_usd)}</b></td></tr></table>
   <h3>Farm plan (model.js farmPlan)</h3>
   <ol class="steps">${steps}</ol>
   ${grid(r)}
   <h3>Nearest live-token peers in ${esc(r.sector)} (what the market pays)</h3>
   <table class="peers"><tr><th>Peer</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Cap / TVL</th></tr>${peers}</table>`;
 }

 function liveHtml() {
  const rows = R.live.slice(0, 40).map((q) => {
   const err = Math.log10(q.blind_usd / q.mcap_usd);
   return `<tr><td><span class="nm">${esc(q.name)}</span> <span class="tag">${esc(q.symbol ?? '')}</span><div class="sub">${esc(q.category ?? '')}</div></td><td class="n">${money(q.tvl_usd)}</td><td class="n"><b>${money(q.mcap_usd)}</b></td><td class="n">${money(q.blind_usd)}</td><td class="n ${Math.abs(err) < 0.3 ? 'up' : ''}">${times(err)}</td></tr>`;
  }).join('');
  return `<p class="note">Live tokens are never ranked: they are the training set. Each is valued below by a fit that never saw it (10-fold).</p>
   <div class="table"><table><thead><tr><th>Live token</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Blind model value</th><th class="n">Blind error</th></tr></thead><tbody>${rows}</tbody></table>
   <div class="more">${R.live.length} live tokens fit the model \u00b7 ${R.recorded} more record a token with no market cap and are set apart too</div></div>`;
 }

 function methodHtml() {
  const b = R.fit.beta, o = R.fit.odds, terms = R.fit.terms.filter((t) => t !== 'sector');
  const coef = terms.map((t, i) => `<tr><td>${esc(M.TERMS[t].label)}</td><td class="n">${b[i + 1].toFixed(3)}</td><td class="note">${esc(M.TERMS[t].why)}</td></tr>`).join('');
  const sec = Object.entries(R.fit.sector).map(([s, v]) => `<tr><td>${esc(s)}</td><td class="n">${times(v.effect)}</td><td class="note">${v.n} live tokens</td></tr>`).join('');
  return `<div class="method">
   <div class="card"><h3>The value model</h3>
    <div class="formula">log10(value) = ${b[0].toFixed(3)}${terms.map((t, i) => ` ${b[i + 1] < 0 ? '\u2212' : '+'} ${Math.abs(b[i + 1]).toFixed(3)}\u00b7${t}`).join('')}${R.fit.terms.includes('sector') ? ' + sector effect' : ''}
P25\u2013P75 = value \u00d7 10^[${h.lo50.toFixed(2)}, +${h.hi50.toFixed(2)}], P10\u2013P90 = value \u00d7 10^[${h.interval_lo.toFixed(2)}, +${h.interval_hi.toFixed(2)}] (10-fold residual quantiles)</div>
    <p>Least squares of log10 market cap on the ${h.n} snapshot protocols that have one (model.js fitValueModel); sector effects shrunk toward zero by 8 pseudo-protocols. Other terms must lower both blind errors. TVL, 7-day change and days run stay because the brief names them, and we say plainly what that costs: free, their slopes beside TVL are ${R.fit.prior.free.map((f) => `${f.term} ${f.slope.toFixed(2)} \u00b1 ${f.se.toFixed(2)}`).join(', ')}, i.e. not told apart from zero. So they are not given a slope of their own: they count as TVL, <b>effective TVL = TVL \u00d7 (1 + 7-day change) \u00d7 days<sup>a</sup></b>, priced with the TVL slope (${R.fit.prior.slope.toFixed(3)}); a = ${R.fit.prior.a} has the lowest mean blind error on the grid (fit.json). This is an assumption, not a finding; the evidence panel shows its held-out cost.</p>
    <table><tr><th>Term</th><th class="n">Weight</th><th></th></tr>${coef}</table>
    <h3 style="margin-top:16px">Sector effects</h3>${sec ? `<table>${sec}</table>` : '<p class="note">Dropped: a sector effect no longer lowers both blind errors (see the term tests), so every sector shares one intercept.</p>'}</div>
   <div class="card"><h3>Blind tests</h3>
    <p>Each term's two held-out tests, with and without it, are in the evidence panel on the board.</p>
    <h3 style="margin-top:16px">Token odds (model.js fitOdds)</h3>
    <p>No launch dates exist, but each of ${o.n} dated protocols shows its age and whether it has a token (${o.tokened} do). F(age) = share with a token by that age, logistic in log10 days${o.terms.map((t) => ` + ${t}`).join('')} + sector; with none yet at age a, odds = (F(a+${M.ODDS.horizonDays}) \u2212 F(a)) / (1 \u2212 F(a)). Age slope ${o.beta[1].toFixed(2)}. 10-fold log loss <b>${o.loss.toFixed(3)}</b>, against ${o.sector_loss.toFixed(3)} for sector alone and ${o.flat_loss.toFixed(3)} for one base rate. A term stays only if it cuts the loss with a slope \u2265 0: ${o.tests.map((t) => `${t.term} ${t.with.toFixed(4)} vs ${t.without.toFixed(4)}, slope ${t.slope.toFixed(2)}, ${t.kept ? 'kept' : 'dropped'}`).join('; ')}. Older cohorts may have launched faster.</p>
    <h3 style="margin-top:16px">Farm assumptions</h3>
    <p>Airdrop = ${(M.FARM.airdropShare * 100).toFixed(1)}% of implied value, paid pro rata to time-weighted TVL over a ${M.FARM.seasonDays}-day season; ${M.FARM.horizonDays} days held earn ${M.FARM.horizonDays}/${M.FARM.seasonDays} of a deposit's share, times its ${M.ODDS.horizonDays}-day token odds. Plus the sector's ordinary yield (model.js BASE_APY), less ${(M.FARM.lossRatePerYear * 100).toFixed(0)}%/yr contract risk; gas per transaction by chain (model.js GAS_USD). Verdict by the drop's multiple of the gas (yield never decides): Farm \u22653\u00d7, Test 1\u20133\u00d7, both net positive; Scale when a deposit up to $${M.FARM.scaleCap.toLocaleString('en-US')} reaches 3\u00d7; else Watch. $/h = net \u00f7 the plan's minutes. The detail grid shows 4% T-bills beside it. Stated assumptions, not quotes.</p>
    <p class="note">Reader's note: the snapshot records no token for these protocols; that is not proof none exists. An implied value is this model's claim, not a forecast that a token will launch.</p></div></div>`;
 }

 function render() {
  const watchCount = R.rows.filter((r) => r.watchlist).length, farms = R.rows.filter((r) => r.plan.verdict === 'Farm').length, tests = R.rows.filter((r) => r.plan.verdict === 'Test').length, scale = R.rows.filter((r) => r.plan.verdict === 'Scale').length;
  const tab = (k, t, n) => `<button data-tab="${k}" aria-selected="${S.tab === k}">${t}<span class="count">${n}</span></button>`;
  const body = S.tab === 'live' ? liveHtml() : S.tab === 'method' ? methodHtml() : boardHtml();
  const ck = (ok, t) => `<span class="check${ok ? '' : ' bad'}">${t}</span>`;
  const off = Object.entries(R.setAside).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), offN = off.reduce((a, e) => a + e[1], 0), sum = R.rows.length + h.n + R.recorded + offN;
  const total = R.rows.reduce((a, r) => a + r.implied_value_usd, 0), ordered = R.rows.every((r, i) => r.rank === i + 1 && (i === 0 || r.implied_value_usd <= R.rows[i - 1].implied_value_usd));
  const costed = R.rows.every((r) => r.plan.steps.length >= 3 && r.plan.steps.length <= 12 && r.plan.steps.every((s) => s.minutes > 0));
  $('#app').innerHTML = `<header class="top"><div class="brand">
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="#24314b" stroke-width="2"/><circle cx="20" cy="20" r="11" fill="none" stroke="#24314b" stroke-width="2"/><path d="M20 20 L34 9 A18 18 0 0 1 38 20 Z" fill="#f2b33d" fill-opacity=".35"/><circle cx="29" cy="14" r="2.6" fill="#f2b33d"/><circle cx="20" cy="20" r="2" fill="#e7ecf6"/></svg>
    <div><h1>Token Radar</h1><p>${R.rows.length} DeFi protocols with <b>no token yet</b>, ranked by the token value their TVL, 7-day growth and time without a token imply. Live tokens are the model's price data, not rows.</p></div></div>
    <div class="stamp">DefiLlama snapshot ${esc(R.as_of)} \u00b7 ${R.protocols} protocols<br>board sha256 ${esc(R.checks.sha.slice(0, 16))}</div></header>
   <section class="kpis">
    <div class="kpi hi"><span>Pre-token on the board</span><b>${R.rows.length}</b><small>${watchCount} watchlist \u00b7 ${belowCount} under $${(R.floor_usd / 1e6).toFixed(0)}M \u00b7 ${R.rows.length - watchCount - belowCount} other</small></div>
    <div class="kpi"><span>Implied value, board total</span><b>${money(R.rows.reduce((a, r) => a + r.implied_value_usd, 0))}</b><small>top: ${esc(R.rows[0].name)}</small></div>
    <div class="kpi"><span>Is the printed range honest?</span><b>${(h.honest.walk50 * 100).toFixed(0)}% \u00b7 ${(h.honest.walk80 * 100).toFixed(0)}%</b><small>held-out caps inside P25\u2013P75 \u00b7 P10\u2013P90 (stated 50% \u00b7 80%)</small></div>
    <div class="kpi"><span>Out-of-sample miss, median</span><b>${times(h.honest.walk_med)}</b><small>walk-forward; 10-fold ${times(h.honest.kfold_med)} \u00b7 mean ${times(h.walk_mae)}; flat median ${times(h.naive_mae)}</small></div>
    <div class="kpi"><span>Terms that survived both tests</span><b>${R.fit.table.filter((t) => t.helps).length + 1} of ${R.fit.table.length + 1}</b><small>value model; the rest are shown below, kept only if the brief names them</small></div>
    <div class="kpi"><span>Drop pays 3x gas at $1k</span><b>${farms}</b><small>${tests} Test (1-3x) \u00b7 ${scale} Scale \u00b7 ${R.rows.length - farms - tests - scale} Watch</small></div></section>
   <p class="ledger"><b>Every protocol accounted for:</b> ${R.protocols} in the snapshot = <b>${R.rows.length}</b> on this board (${watchCount} watchlist) + <b>${h.n}</b> live tokens, the price sample + <b>${R.recorded}</b> token recorded, no market cap + <b>${offN}</b> set aside by rule (${off.map(([k, v]) => `${esc(k.replace('category ', ''))} ${v}`).join(', ')})</p>
   <div class="checks" aria-label="Integrity strip: each check is recomputed in this page">
    ${ck(matches === R.rows.length, `this table = board.json: ${matches}/${R.rows.length} values recomputed here by model.js`)}
    ${ck(ordered, `ranks 1\u2013${R.rows.length} in order, values never rise`)}
    ${ck(total === R.checks.total, `totals equal: ${money(total)}`)}
    ${ck(M.fnv(R.rows) === R.checks.fnv, `checksum ${M.fnv(R.rows)} = main.ts`)}
    ${ck(watchCount === R.checks.watch, `watchlist ${watchCount} of ${R.checks.watch} ranked`)}
    ${ck(sum === R.protocols, `ledger ${sum} of ${R.protocols}`)}
    ${ck(costed, `${R.rows.length} plans, 3\u201312 costed steps`)}</div>
   ${S.tab === 'board' ? evidenceHtml() : ''}
   <nav class="tabs" role="tablist">${tab('board', 'Pre-token board', R.rows.length)}${tab('live', 'Live tokens (training set)', h.n)}${tab('method', 'Method & blind tests', '')}</nav>
   ${body}
   <footer>Implied values are this entry's model, not make.fun's.</footer>`;
  const open = R.rows.find((r) => r.slug === S.open);
  const aside = $('#detail');
  aside.innerHTML = detailHtml(open);
  aside.classList.toggle('open', !!open);
  $('#board').setAttribute('aria-busy', 'false');
 }

 document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-seg],th[data-k],tbody tr[data-slug],#close,#more');
  if (!t) return;
  if (t.dataset.tab) setState({ tab: t.dataset.tab, open: '' });
  else if (t.dataset.seg) setState({ seg: t.dataset.seg });
  else if (t.dataset.k) setState({ sort: t.dataset.k, dir: S.sort === t.dataset.k && S.dir === 'desc' ? 'asc' : 'desc' });
  else if (t.dataset.slug) setState({ open: t.dataset.slug });
  else if (t.id === 'close') setState({ open: '' });
  else if (t.id === 'more') setState({ limit: '9999' });
 });
 document.addEventListener('change', (e) => { if (['sector', 'chain', 'verdict'].includes(e.target.id)) setState({ [e.target.id]: e.target.value }); });
 document.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; setState({}); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); } });
 document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) setState({ open: '' }); });
 window.addEventListener('hashchange', () => { S = readState(); render(); });
 render();
})();
