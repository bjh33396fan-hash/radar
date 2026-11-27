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
if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
return `$${v.toFixed(a >= 10 ? 0 : 2)}`;
}
const belowCount = R.rows.filter((r) => !r.watchlist && r.tvl_usd < R.floor_usd).length;
function offReason(r) {
if (r.watchlist) return 'on the watchlist';
if (r.tvl_usd < R.floor_usd) return `off the watchlist: TVL under the $${(R.floor_usd / 1e6).toFixed(0)}M floor`;
return `off the watchlist: over the floor, but a parent's product, a version or an excluded category`;
}
const sm = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`, pc = (v) => `${(v * 100).toFixed(0)}%`;
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const times = (log) => `×${(10 ** log).toFixed(2)}`;

const fit = { terms: R.fit.terms, beta: R.fit.beta, sector: R.fit.sector };
let matches = 0;
for (const r of R.rows) {
const p = R.snap[r.slug];
if (p && Math.max(1, Math.round(10 ** M.predictLog(fit, p, R.as_of).log)) === r.implied_value_usd) matches++;
}
const h = R.fit.heldout;
for (const t of R.fit.table) t.helps = t.with_kfold < t.without_kfold && t.with_walk < t.without_walk;
const sectors = [...new Set(R.rows.map((r) => r.sector))].sort();

const DEFAULT = { tab: 'board', q: '', seg: 'all', sector: '', verdict: '', sort: 'implied_value_usd', dir: 'desc', open: '', limit: '60', dep: '10000', share: '0.075', cmp: '' };
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

const COLS = [['rank', '#'], ['name', 'Protocol'], ['chains', 'Chains'], ['tvl_usd', 'TVL', 1], ['change_7d', '7d', 1], ['days_pre_token', 'Days, no token', 1], ['implied_value_usd', 'Implied value · P25–P75', 1], ['value_to_tvl', 'Value / TVL', 1], ['odds', 'Token in 1 yr', 1], ['ev', 'Drop EV', 1], ['verdict', 'Farm · $/h vs T-bill']].map(([key, label, n]) => ({ key, label, n }));
// CSV: the rows shown, as filtered and sorted
const EXP = ['rank', 'slug', 'name', 'sector', 'tvl_usd', 'change_7d', 'days_pre_token', 'implied_value_usd', 'p25_usd', 'p75_usd'];
const flat = (r) => ({ ...Object.fromEntries(EXP.map((k) => [k, r[k] ?? null])), odds: r.odds.rate, verdict: r.plan.verdict, over_tbill_usd: +r.plan.over.toFixed(2), per_hour_usd: +r.plan.perHour.toFixed(2) });
function save() {
const rows = filtered().map(flat), q = (v) => (typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v ?? '');
const text = [Object.keys(rows[0]).join(','), ...rows.map((o) => Object.values(o).map(q).join(','))].join('\n');
const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = 'token-radar.csv'; a.click();
}
const sortValue = (r, k) => (k === 'odds' ? r.odds.rate : k === 'ev' ? r.plan.ev : k === 'verdict' ? r.plan.perHour : k === 'chains' ? r.chains.length : r[k]);

function filtered() {
const q = S.q.trim().toLowerCase();
const rows = R.rows.filter((r) =>
(S.seg === 'all' || (S.seg === 'watch' ? r.watchlist : !r.watchlist)) &&
(!S.sector || r.sector === S.sector) &&
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
return `<span class="band"><i style="left:${pos(r.p25_usd)}%;right:${100 - pos(r.p75_usd)}%"></i><b style="left:calc(${pos(r.implied_value_usd)}% - 1px)"></b></span><small class="rng">${money(r.p25_usd)}–${money(r.p75_usd)}</small>`;
}

// evidence: each term's two blind tests, and whether the ranges hold
function evidenceHtml() {
const x = (v) => times(v).replace('.00', ''), f1 = (l) => `${l < 0 ? '−' : '+'}${Math.abs(100 * (10 ** l - 1)).toFixed(1)}%`;
// one evidence row: label, 10-fold, walk-forward, note
const tr = (a, k, w, n = '') => `<tr><td>${a}</td><td class="n">${k}</td><td class="n">${w}</td><td>${n}</td></tr>`, B = '<em>baseline</em>';
const val = R.fit.table.map((t) => {
const why = t.helps ? '<em class="yes">kept: lowers both</em>' : t.kept ? `<em class="warn">kept (named by the brief): ${f1(Math.max(t.with_kfold - t.without_kfold, t.with_walk - t.without_walk))} on one split; ${f1(h.noise.growth)} over 8 reshuffles (${h.noise.helps}/8 lower), noise ±${f1(h.noise.sd).slice(1)}</em>` : '<em class="no">tested, not kept</em>';
return tr(`+ ${esc(M.TERMS[t.term]?.label ?? 'sector effect')}`, `${x(t.with_kfold)} <s>${x(t.without_kfold)}</s>`, `${x(t.with_walk)} <s>${x(t.without_walk)}</s>`, why);
}).join('');
const hh = h.honest, beta = (t) => R.fit.beta[R.fit.terms.indexOf(t) + 1], bt = beta('tvl'), ba = beta('age');
// best plans by excess over T-bills; why the biggest values farm worst
const top = R.rows.filter((r) => r.plan.over > 0).sort((a, b) => b.plan.perHour - a.plan.perHour).slice(0, 5), r0 = R.rows[0];
const farm = top.map((r) => `<tr data-slug="${esc(r.slug)}"><td><span class="nm">${esc(r.name)}</span> <small class="note">${r.plan.verdict}</small><div class="sub">${r.plan.txs} tx, ${money(r.plan.cost)} gas, ${r.plan.minutes} min</div></td><td class="n">${money(r.tvl_usd)}</td><td class="n">${money(r.plan.ev)}</td><td class="n up">${sm(r.plan.over)} · ${sm(r.plan.perHour)}/h</td></tr>`).join('');
return `<section class="evid"><h4>Out-of-sample evidence <span>recomputed by model.js; other terms stay only if both blind tests improve (walk-forward: earlier listings price later)</span></h4><div class="ev3">
<div><h5>Value if a token launches · typical miss on ${h.n} traded tokens</h5><table><tr><th>Term</th><th class="n">10-fold <s>without</s></th><th class="n">Walk-fwd <s>without</s></th><th></th></tr>
${tr('flat median cap, mean · median', `${x(h.naive_mae)} · ${x(h.naive_med)}`, `${x(h.naive_walk_mae)} · ${x(h.naive_walk_med)}`, B)}${tr('one cap/TVL multiple, mean · median', `${x(h.mult[0])} · ${x(h.mult[2])}`, `${x(h.mult[1])} · ${x(h.mult[3])}`, B)}${val}
${tr('<b>final model</b>, mean · median', `<b>${x(h.kfold_mae)} · ${x(hh.kfold_med)}</b>`, `<b>${x(h.walk_mae)} · ${x(hh.walk_med)}</b>`, `ranges hold: ${pc(hh.walk50)} in P25–P75, ${pc(hh.walk80)} in P10–P90`)}${tr(`same misses, the ${h.like.n} board-type tokens`, `${x(h.like.kfold_mae)} · ${x(h.like.kfold_med)}`, `${x(h.like.walk_mae)} · ${x(h.like.walk_med)}`, 'no bridge, staking, CEX or wrapper: the kinds the board ranks')}</table>
<p class="note">Big misses are caps far from TVL (near zero on a large TVL): nothing in the snapshot predicts them, hence ranges.</p></div>
<div><h5>Start here: where ${dep$()} for ${M.FARM.horizonDays} days beats 4% T-bills</h5><table><tr><th>Protocol</th><th class="n">TVL</th><th class="n">Drop EV</th><th class="n">Over T-bills</th></tr>${farm}</table>
<p class="note">Why the top says Watch: under $1B, value grows as TVL<sup>${bt.toFixed(2)}</sup>, so a 10× larger protocol is worth ${(10 ** bt).toFixed(1)}× more but ${(10 ** (1 - bt)).toFixed(1)}× less per dollar deposited. ${esc(r0.name)}: ${dep$()} is 1 part in ${money(r0.tvl_usd / M.FARM.deposit).slice(1)} of its TVL, a ${money(r0.plan.ev)} drop against ${money(r0.plan.bill)} in T-bills. No listing date: 365 days assumed; a doubling of days moves value only ×${(10 ** (ba * Math.log10(2))).toFixed(2)}.</p></div></div></section>`;
}

function rowHtml(r) {
const chainText = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ` +${r.chains.length - 2}` : '');
return `<tr data-slug="${esc(r.slug)}"${S.open === r.slug ? ' class="sel"' : ''}>
<td class="rank">${r.rank}<button class="cb${S.cmp.split(',').includes(r.slug) ? ' on' : ''}" data-cmp="${esc(r.slug)}" aria-label="Compare">+</button></td>
<td><span class="nm">${esc(r.name)}</span>${r.watchlist ? '<span class="tag w">watchlist</span>' : ''}<div class="sub">${esc(r.category ?? 'Uncategorised')} · ${esc(r.sector)}</div></td>
<td class="sub">${esc(chainText)}</td>
<td class="n">${money(r.tvl_usd)}</td>
<td class="n ${r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''}">${pct(r.change_7d)}</td>
<td class="n">${r.days_pre_token ?? '365<span class="note">*</span>'}</td>
<td class="n"><b>${money(r.implied_value_usd)}</b>${band(r)}</td>
<td class="n">${r.value_to_tvl.toFixed(2)}</td>
<td class="n">${pc(r.odds.rate)}</td>
<td class="n">${money(r.plan.ev)}</td>
<td class="vd"><span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span>${r.plan.verdict === 'Scale' ? `<small>3× gas from ${money(r.plan.size)}</small>` : `<small class="${r.plan.perHour >= 0 ? 'up' : 'down'}">${sm(r.plan.perHour)}/h</small>`}</td></tr>`;
}

// sandbox: farmPlan re-runs every plan (board.json: $10,000, 7.5%)
const base = R.rows.map((r) => r.plan), dep$ = () => `$${M.FARM.deposit.toLocaleString('en-US')}`;
let planned = '10000|0.075';
function replan() {
if (`${S.dep}|${S.share}` === planned) return;
const d = Number(S.dep) || 10000, sh = Number(S.share) || 0.075; planned = `${S.dep}|${S.share}`; M.FARM.deposit = d; M.FARM.airdropShare = sh;
R.rows.forEach((r, i) => { r.plan = d === 10000 && sh === 0.075 ? base[i] : M.farmPlan(R.snap[r.slug], r.implied_value_usd, r.odds, base[i]); });
}

// two rows picked with + beside the rank, side by side
function cmpHtml() {
const [a, b] = S.cmp.split(',').map((s) => R.rows.find((r) => r.slug === s));
if (!a || !b) return '';
const part = (r, t) => times(r.parts.find((q) => q.term === t)?.log ?? 0);
const L = [['TVL', (r) => money(r.tvl_usd)], ['7-day change', (r) => pct(r.change_7d)], ['Days, no token', (r) => r.days_pre_token ?? '365*'],
...a.parts.filter((q) => q.term !== 'base').map((q) => [q.term === 'sector' ? 'sector effect' : esc(q.label), (r) => part(r, q.term)]),
['Implied value · P25–P75', (r) => `<b>${money(r.implied_value_usd)}</b> · ${money(r.p25_usd)}–${money(r.p75_usd)}`], ['Token in 1 yr', (r) => pc(r.odds.rate)],
['Drop EV · gas', (r) => `${money(r.plan.ev)} · ${money(r.plan.cost)}`],
['Over T-bills · $/h', (r) => `${sm(r.plan.over)} · ${sm(r.plan.perHour)}/h`], ['Verdict', (r) => `<span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span>`]];
const h = Math.ceil(L.length / 2), hd = `<tr><th></th><th class="n">#${a.rank} ${esc(a.name)}</th><th class="n">#${b.rank} ${esc(b.name)}</th></tr>`;
return `<div class="cmp card"><h3>Compare (predictLog, farmPlan) <button class="close" data-cmp="">Clear</button></h3><div class="cmp2">${[L.slice(0, h), L.slice(h)].map((l) => `<table class="peers">${hd}${l.map(([k, f]) => `<tr><td>${k}</td><td class="n">${f(a)}</td><td class="n">${f(b)}</td></tr>`).join('')}</table>`).join('')}</div></div>`;
}

function boardHtml() {
const rows = filtered(), lim = Number(S.limit) || 60;
const seg = (v, t) => `<button data-seg="${v}" class="${S.seg === v ? 'on' : ''}">${t}</button>`;
const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
return `<div class="filters" role="search">
<input type="search" id="q" placeholder="Search protocol or category" value="${esc(S.q)}" aria-label="Search">
<div class="seg">${seg('all', 'All pre-token')}${seg('watch', `Watchlist (${R.checks.watch})`)}${seg('below', `Off the watchlist (${R.rows.length - R.checks.watch})`)}</div>
<select id="sector" aria-label="Sector">${opt(sectors, S.sector, 'Every sector')}</select>
<select id="verdict" aria-label="Farm verdict">${opt(['Farm', 'Test', 'Scale', 'Watch'], S.verdict, 'Every verdict')}</select>
<select id="dep" aria-label="Deposit">${[1000, 10000, 50000].map((d) => `<option value="${d}"${String(d) === S.dep ? ' selected' : ''}>Deposit $${d.toLocaleString('en-US')}</option>`).join('')}</select>
<select id="share" aria-label="Airdrop share of implied value">${['0.025', '0.075', '0.15'].map((v) => `<option value="${v}"${v === S.share ? ' selected' : ''}>Drop share ${+(v * 100).toFixed(1)}%</option>`).join('')}</select>
<button class="close" id="csv">CSV</button>
<span class="shown">${rows.length} of ${R.rows.length} shown · ranked by <b>${esc(COLS.find((c) => c.key === S.sort)?.label ?? S.sort)}</b> ${S.share !== '0.075' ? `· <b>sandbox: drop share ${+(S.share * 100).toFixed(1)}%</b> (board.json uses 7.5%) ` : ''}· 365<span class="note">*</span> = no listing date, 365 days assumed · click a row for its plan</span></div>
${cmpHtml()}<div class="table"><table><thead><tr>${COLS.map((c) => `<th data-k="${c.key}" class="${c.n ? 'n' : ''}"${S.sort === c.key ? ` aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
<tbody>${rows.slice(0, lim).map(rowHtml).join('')}</tbody></table>
${rows.length > lim ? `<div class="more"><button class="close" id="more">Show all ${rows.length}</button></div>` : ''}</div>`;
}

// peers on family TVL; a cap over 50x TVL is left out as hype
const pt = (q) => q.priced_tvl ?? q.tvl_usd;
function peersOf(r) {
const lt = Math.log10(r.tvl_usd), gap = (q) => Math.abs(Math.log10(pt(q)) - lt);
return R.live.filter((q) => q.sector === r.sector && q.mcap_usd <= 50 * pt(q)).sort((a, b) => gap(a) - gap(b) || a.slug.localeCompare(b.slug)).slice(0, 4);
}

// net after gas and risk, 3 deposits x 3 drop shares (the drop scales; gas does not)
function grid(r) {
const p = r.plan, bill = (d) => d * M.FARM.billRate * M.FARM.horizonDays / 365;
const net = (d, s) => ((p.ev * s) / M.FARM.airdropShare + p.yieldUsd - p.risk) * d / M.FARM.deposit - p.cost;
const cell = (v) => `<td class="n ${v >= 0 ? 'up' : 'down'}">${sm(v)}</td>`;
const D = [1000, 10000, 50000];
return `<table class="peers"><tr><th>Drop share ↓ · deposit → (net after gas, risk)</th>${D.map((d) => `<th class="n">${money(d)}</th>`).join('')}</tr>${[0.025, 0.075, 0.15].map((s) => `<tr><td>${(s * 100).toFixed(1)}% of implied value${s === M.FARM.airdropShare ? ' (used)' : ''}</td>${D.map((d) => cell(net(d, s))).join('')}</tr>`).join('')}<tr><td class="note">benchmark: 4% T-bills, same days</td>${D.map((d) => `<td class="n note">+${money(bill(d))}</td>`).join('')}</tr></table>`;
}

function detailHtml(r) {
if (!r) return '';
const max = Math.max(...r.parts.filter((q) => q.term !== 'base').map((q) => Math.abs(q.log)), 0.2);
const build = r.parts.filter((q) => q.log || q.term === 'base').map((q) => q.term === 'base'
? `<tr><td>Fitted base at $100M TVL</td><td class="bar"></td><td class="n">${money(10 ** q.log)}</td></tr>`
: `<tr><td>${esc(q.label)}</td><td class="bar"><i style="width:${(Math.abs(q.log) / max) * 100}%;background:${q.log >= 0 ? 'var(--teal)' : 'var(--red)'}"></i></td><td class="n">${times(q.log)}</td></tr>`).join('');
const steps = r.plan.steps.map((s) => `<li><span><b class="tg">${s.tag}</b> ${esc(s.text)}<span class="bdg"><i>COST $${s.cost.toFixed(2)} ${s.n ? `(${s.n} tx at $${r.plan.gas.toFixed(2)} on ${esc(r.plan.chain)}${s.tag === 'SETUP' ? ` + $${M.FARM.bridgeUsd.toFixed(2)} bridge` : ''})` : '(no transaction)'}</i><i>TIME ${s.minutes} min hands-on</i><i>${s.when}</i></span></span></li>`).join('');
const peers = peersOf(r).map((q) => `<tr><td>${esc(q.name)}</td><td class="n">${money(pt(q))}</td><td class="n">${money(q.mcap_usd)}</td><td class="n">${(q.mcap_usd / pt(q)).toFixed(2)}</td></tr>`).join('');
return `<button class="close" id="close">Close</button>
<div class="sub">Rank ${r.rank} of ${R.rows.length} · ${esc(r.category ?? 'Uncategorised')} · ${offReason(r)}</div>
<h2>${esc(r.name)}</h2>
<div style="margin-top:12px"><span class="big">${money(r.implied_value_usd)}</span> <span class="note">implied token value · P25–P75 ${money(r.p25_usd)} to ${money(r.p75_usd)} · P10–P90 ${money(r.low_usd)} to ${money(r.high_usd)} (held out: ${pc(h.honest.walk50)} · ${pc(h.honest.walk80)} of real caps inside)</span></div>
<div class="dcols"><div>
<div class="sum"><span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span><div><b>Per ${dep$()} for ${M.FARM.horizonDays} days: ${sm(r.plan.net)} net, T-bills ${money(r.plan.bill)} · ${sm(r.plan.over)} over T-bills, ${sm(r.plan.perHour)}/h</b><br><span class="note">${esc(r.plan.verdictText)} · ${r.plan.txs} txs, ${money(r.plan.cost)} gas, ${r.plan.minutes} min on ${esc(r.plan.chain)}</span></div></div>
<div class="facts">
<div><span>TVL</span><b>${money(r.tvl_usd)}</b></div><div><span>7-day change</span><b class="${r.change_7d > 0 ? 'up' : 'down'}">${pct(r.change_7d)}</b></div><div><span>Tracked, no token</span><b>${r.days_pre_token ?? 365} days</b>${r.days_pre_token === null || r.days_pre_token === undefined ? ' <small class="note">no listing date: 365 assumed</small>' : ''}</div>
<div><span>Token within ${M.ODDS.horizonDays} days</span><b>${pc(r.odds.rate)}</b> <small class="note">survival fit: ${pc(r.odds.now)} of like ${esc(r.odds.sector)} protocols have one at this age, ${pc(r.odds.later)} a year older</small></div>
</div>
<h3>How the value is built (model.js predictLog)</h3>
<table class="build">${build}<tr><td><b>Implied value</b></td><td></td><td class="n"><b>${money(r.implied_value_usd)}</b></td></tr></table>
<h3>Nearest live-token peers in ${esc(r.sector)} (what the market pays; caps over 50× TVL left out)</h3>
<table class="peers"><tr><th>Peer</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Cap / TVL</th></tr>${peers}</table>
</div><div>
<h3>Farm plan (model.js farmPlan)</h3>
<ol class="steps">${steps}</ol>
${grid(r)}
</div></div>`;
}

function liveHtml() {
const rows = R.live.slice(0, 40).map((q) => {
const err = Math.log10(q.blind_usd / q.mcap_usd);
return `<tr><td><span class="nm">${esc(q.name)}</span> <span class="tag">${esc(q.symbol ?? '')}</span><div class="sub">${esc(q.category ?? '')}</div></td><td class="n">${money(q.tvl_usd)}${q.family > 1 ? `<div class="sub">${q.family} products: ${money(q.priced_tvl)}</div>` : ''}</td><td class="n"><b>${money(q.mcap_usd)}</b></td><td class="n">${money(q.blind_usd)}</td><td class="n ${Math.abs(err) < 0.3 ? 'up' : ''}">×${(10 ** Math.abs(err)).toFixed(Math.abs(err) < 1 ? 1 : 0)} ${err < 0 ? 'under' : 'over'}</td></tr>`;
}).join('');
// 128 blind values against caps they never saw; dashed = the P10-P90 band
const lg = (v) => Math.log10(Math.max(v, 1e4)), X = (v) => 48 + (lg(v) - 4) * 62, Y = (v) => 300 - (lg(v) - 4) * 44;
const dots = R.live.map((q) => `<circle cx="${X(q.blind_usd).toFixed(1)}" cy="${Y(q.mcap_usd).toFixed(1)}" r="3"><title>${esc(q.name)}</title></circle>`).join('');
const ln = (d, c) => `<line x1="${X(1e5)}" y1="${Y(10 ** (5 + d))}" x2="${X(1e10)}" y2="${Y(10 ** (10 + d))}" class="${c}"/>`;
const ex = (e) => `$${10 ** (e % 3)}${'kMB'[(e / 3 | 0) - 1]}`, ax = [5, 6, 7, 8, 9, 10].map((e) => `<text x="${X(10 ** e)}" y="318">${ex(e)}</text><text x="34" y="${Y(10 ** e) + 4}" text-anchor="end">${ex(e)}</text>`).join('');
const inside = R.live.filter((q) => { const d = lg(q.mcap_usd) - lg(q.blind_usd); return d >= h.interval_lo && d <= h.interval_hi; }).length;
const plot = `<figure class="plot"><svg viewBox="0 0 440 326" role="img" aria-label="Blind model value against market cap">${ax}${ln(0, 'eq')}${ln(h.interval_lo, 'bd')}${ln(h.interval_hi, 'bd')}<g class="dots">${dots}</g></svg>
<figcaption>Blind model value (x) against the market cap (y), ${R.live.length} live tokens: on the solid line the model is exact; ${inside} of ${R.live.length} (${pc(inside / R.live.length)}) fall between the dashed P10–P90 lines; the band was set on these 10-fold misses, so the honest check is the walk-forward ${pc(h.honest.walk80)} on top.</figcaption></figure>`;
return `${plot}<p class="note">Live tokens are the training set, never ranked. Each is valued by a fit that never saw it (10-fold); a token on several products (same gecko_id, or symbol and name word) is fitted on their summed TVL.</p>
<div class="table"><table><thead><tr><th>Live token</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Blind model value</th><th class="n">Blind error</th></tr></thead><tbody>${rows}</tbody></table>
<div class="more">${R.live.length} live tokens fit · ${R.recorded} with a token but no cap set apart</div></div>`;
}

function methodHtml() {
const b = R.fit.beta, o = R.fit.odds, terms = R.fit.terms.filter((t) => t !== 'sector');
const coef = terms.map((t, i) => `<tr><td>${esc(M.TERMS[t].label)}</td><td class="n">${b[i + 1].toFixed(3)}</td><td class="note">${esc(M.TERMS[t].why)}</td></tr>`).join('');
return `<div class="method">
<div class="card"><h3>The value model</h3>
<div class="formula">P25–P75 = value × 10^[${h.lo50.toFixed(2)}, +${h.hi50.toFixed(2)}], P10–P90 = value × 10^[${h.interval_lo.toFixed(2)}, +${h.interval_hi.toFixed(2)}] (10-fold residual quantiles)</div>
<p>Least absolute misses on ${h.n} market caps (fitValueModel); extra terms stay only if both blind errors fall. Growth and days run are priced as TVL, <b>effective TVL = TVL × (1 + 7-day change vs sector median) × days<sup>a</sup></b>, at the TVL slope (${R.fit.prior.slope.toFixed(3)}; a = ${R.fit.prior.a}, lowest blind error): free, their slopes are ${R.fit.prior.free.map((f) => `${f.term} ${f.slope.toFixed(2)} ± ${f.se.toFixed(2)}`).join(', ')}, noise.</p>
<table><tr><th>Term</th><th class="n">Weight</th><th></th></tr>${coef}</table>
<p class="note">Sector effects (shrunk toward zero): ${Object.entries(R.fit.sector).map(([k, v]) => `${esc(k)} ${times(v.effect)}`).join(' · ')}.</p></div>
<div class="card"><h3>Token odds (model.js fitOdds)</h3>
<p>${o.n} dated protocols, ${o.tokened} with a token. F(age) = share tokened by that age, logistic in log10 days${o.terms.map((t) => ` + ${t}`).join('')} + sector; untokened at age a, odds = (F(a+${M.ODDS.horizonDays}) − F(a)) / (1 − F(a)). Age slope ${o.beta[1].toFixed(2)}.</p>
<h3 style="margin-top:16px">Farm assumptions</h3>
<p>Airdrop = ${(M.FARM.airdropShare * 100).toFixed(1)}% of implied value, pro rata to TVL, ${M.FARM.horizonDays}/${M.FARM.seasonDays} season days, times the odds; plus BASE_APY yield, less ${pc(M.FARM.lossRatePerYear)}/yr risk and GAS_USD gas; bar: 4% T-bills. Rules: farmPlan. Assumptions, not quotes.</p>
<p class="note">No token in the snapshot is not proof none exists; a value is this model's claim, not a forecast.</p></div></div>`;
}

// the model in one line, each weight with its bootstrap s.d.
function formulaHtml() {
const b = R.fit.beta, bt = h.boot, nt = R.fit.terms.filter((t) => t !== 'sector'), big = nt.indexOf('big'), fx = Object.entries(R.fit.sector).map(([k, v]) => [k, 10 ** v.effect]).sort((u, v) => u[1] - v[1]);
const pm = (v, e) => `${v.toFixed(2)}<small>±${e.toFixed(2)}</small>`;
return `<p class="formula1"><b>Implied value</b> = ${money(10 ** b[0])} × (effective TVL ÷ $100M)<sup>${pm(R.fit.prior.slope, bt.slope)}</sup>${big >= 0 ? ` × (TVL ÷ $1B)<sup>${pm(b[big + 1], bt.big)}</sup> past $1B` : ''} × sector factor (×${fx[0][1].toFixed(2)} ${esc(fx[0][0])} … ×${fx[fx.length - 1][1].toFixed(2)} ${esc(fx[fx.length - 1][0])}); effective TVL = TVL × (1 + 7-day change vs sector) × (days ÷ 316)<sup>${R.fit.prior.a}</sup>. Fitted on the ${h.n} live caps by fitValueModel; ± = s.d. over ${bt.refits} bootstrap refits.</p>`;
}

function render() {
replan();
const watchCount = R.rows.filter((r) => r.watchlist).length, farms = R.rows.filter((r) => r.plan.verdict === 'Farm').length;
const tab = (k, t, n) => `<button data-tab="${k}" aria-selected="${S.tab === k}">${t}<span class="count">${n}</span></button>`;
const body = S.tab === 'live' ? liveHtml() : S.tab === 'method' ? methodHtml() : boardHtml();
const kpi = (t, b, s, hi = '') => `<div class="kpi${hi}"><span>${t}</span><b>${b}</b><small>${s}</small></div>`;
const ck = (ok, t) => `<span class="check${ok ? '' : ' bad'}">${t}</span>`;
const off = Object.entries(R.setAside).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), offN = off.reduce((a, e) => a + e[1], 0), sum = R.rows.length + h.n + R.recorded + offN;
const total = R.rows.reduce((a, r) => a + r.implied_value_usd, 0), ordered = R.rows.every((r, i) => r.rank === i + 1 && (i === 0 || r.implied_value_usd <= R.rows[i - 1].implied_value_usd));
const costed = R.rows.every((r) => r.plan.steps.length >= 3 && r.plan.steps.length <= 12 && r.plan.steps.every((s) => s.minutes > 0));
$('#app').innerHTML = `<header class="top"><div class="brand">
<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="#24314b" stroke-width="2"/><path d="M20 20 L34 9 A18 18 0 0 1 38 20 Z" fill="#f2b33d" fill-opacity=".35"/><circle cx="29" cy="14" r="2.6" fill="#f2b33d"/></svg>
<div><h1>Token Radar</h1><p>${R.rows.length} DeFi protocols with <b>no token yet</b>, ranked by the token value their TVL, 7-day growth and time without a token imply. Live tokens are the model's price data, not rows.</p></div></div>
<div class="stamp">DefiLlama snapshot ${esc(R.as_of)} · ${R.protocols} protocols<br>board sha256 ${esc(R.checks.sha.slice(0, 16))}</div></header>
<section class="kpis">
${kpi('Pre-token on the board', `${R.rows.length}`, `${watchCount} watchlist · ${belowCount} under $${(R.floor_usd / 1e6).toFixed(0)}M · ${R.rows.length - watchCount - belowCount} other`, ' hi')}
${kpi('Implied value, board total', `${money(total)}`, `top: ${esc(R.rows[0].name)}`)}
${kpi('Is the printed range honest?', `${pc(h.honest.walk50)} · ${pc(h.honest.walk80)}`, `held-out caps inside P25–P75 · P10–P90 (stated 50% · 80%)`)}
${kpi('Out-of-sample miss, median', `${times(h.honest.walk_med)}`, `walk-forward, all ${h.n}; ${times(h.like.walk_med)} on the ${h.like.n} board-type tokens · 10-fold ${times(h.honest.kfold_med)} · flat cap ${times(h.naive_walk_med)}`)}
${kpi(`Farm at ${dep$()}, ${+(M.FARM.airdropShare * 100).toFixed(1)}% drop: 3x gas, beats T-bills`, `${farms}`, `${['Test', 'Scale', 'Watch'].map((v) => `${R.rows.filter((x) => x.plan.verdict === v).length} ${v}`).join(' · ')}`)}</section>
${formulaHtml()}
<p class="ledger"><b>Every protocol accounted for:</b> ${R.protocols} in the snapshot = <b>${R.rows.length}</b> on this board (${watchCount} watchlist) + <b>${h.n}</b> live tokens, the price sample + <b>${R.recorded}</b> token recorded, no market cap + <b>${offN}</b> set aside by rule (${off.map(([k, v]) => `${esc(k.replace('category ', ''))} ${v}`).join(', ')})</p>
<div class="checks" aria-label="Integrity strip: each check is recomputed in this page">
${ck(matches === R.rows.length, `${matches}/${R.rows.length} values recomputed here = board.json`)}
${ck(ordered, `ranks 1–${R.rows.length} in order, values never rise`)}
${ck(total === R.checks.total, `totals equal: ${money(total)}`)}
${ck(M.fnv(R.rows) === R.checks.fnv, `checksum ${M.fnv(R.rows)} = main.ts`)}
${ck(watchCount === R.checks.watch, `watchlist ${watchCount} of ${R.checks.watch} ranked`)}
${ck(sum === R.protocols, `ledger ${sum} of ${R.protocols}`)}
${ck(costed, `${R.rows.length} plans, 3–12 costed steps`)}</div>
${S.tab === 'board' ? evidenceHtml() : ''}
<nav class="tabs" role="tablist">${tab('board', 'Pre-token board', R.rows.length)}${tab('live', 'Live tokens (training set)', h.n)}${tab('method', 'Method & blind tests', '')}</nav>
${body}
`;
const open = R.rows.find((r) => r.slug === S.open);
const aside = $('#detail');
aside.innerHTML = detailHtml(open);
aside.classList.toggle('open', !!open);
$('#board').setAttribute('aria-busy', 'false');
}

document.addEventListener('click', (e) => {
const t = e.target.closest('[data-cmp],[data-tab],[data-seg],th[data-k],tr[data-slug],#close,#more,#csv');
if (!t) return;
const c = t.dataset.cmp;
if (c !== undefined) setState({ cmp: c ? [...S.cmp.split(',').filter((x) => x && x !== c), c].slice(-2).join(',') : '' });
else if (t.dataset.tab) setState({ tab: t.dataset.tab, open: '' });
else if (t.dataset.seg) setState({ seg: t.dataset.seg });
else if (t.dataset.k) setState({ sort: t.dataset.k, dir: S.sort === t.dataset.k && S.dir === 'desc' ? 'asc' : 'desc' });
else if (t.dataset.slug) setState({ open: t.dataset.slug });
else if (t.id === 'close') setState({ open: '' });
else if (t.id === 'more') setState({ limit: '9999' });
else save();
});
document.addEventListener('change', (e) => { if (['sector', 'verdict', 'dep', 'share'].includes(e.target.id)) setState({ [e.target.id]: e.target.value }); });
document.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; setState({}); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) setState({ open: '' }); });
window.addEventListener('hashchange', () => { S = readState(); render(); });
render();
})();
