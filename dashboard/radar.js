/* Token Radar page: reads window.RADAR (data.js) and re-derives every implied value
* and farm plan with window.RadarModel (model.js) before showing it. */
(function () {
'use strict';
const tf = (v, d) =>v.toFixed(d);
const { abs, log10, max } = Math;
const R = window.RADAR, M = window.RadarModel, N = R.rows.length, Lv = R.live.length, $ = (s, el = document) =>el.querySelector(s), esc = s =>String(s ?? '').replace(/[&<>"]/g, c =>({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function money(v) {
const a = abs(v);
if (a >= 1e9) return `$${tf(v / 1e9, a >= 1e10 ? 1 : 2)}B`;
if (a >= 1e6) return `$${tf(v / 1e6, a >= 1e8 ? 0 : 1)}M`;
if (a >= 1e3) return `$${tf(v / 1e3, a >= 1e5 ? 0 : 1)}k`;
return `$${tf(v, a >= 10 ? 0 : 2)}`;
}
const belowCount = R.rows.filter(r =>!r.watchlist && r.tvl_usd < R.floor_usd).length;
function offReason(r) {
if (r.watchlist) return 'on the watchlist';
if (r.tvl_usd < R.floor_usd) return `off the watchlist: TVL under the $${tf(R.floor_usd / 1e6, 0)}M floor`;
return `off the watchlist: over the floor, but a parent's product, a version or an excluded category`;
}
const tm = v =>`<td class=n>${money(v)}`, sm = v =>`${v >= 0 ? '+' : '−'}${money(abs(v))}`, pc = v =>`${tf(v * 100, 0)}%`, vb = r =>`<span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span>`, pct = v =>(v == null ? 'n/a' : `${v > 0 ? '+' : ''}${tf(v, 1)}%`), times = log =>`×${tf(10 ** log, 2)}`;

const F = M.FARM, RF = R.fit, fit = { terms: RF.terms, beta: RF.beta, sector: RF.sector };
let matches = 0;
for (const r of R.rows) {
const p = R.snap[r.slug];
if (p && max(1, Math.round(10 ** M.predictLog(fit, p, R.as_of).log)) === r.implied_value_usd) matches++;
}
const h = RF.heldout;
for (const t of RF.table) t.helps = t.with_kfold < t.without_kfold && t.with_walk < t.without_walk;
const sectors = [...new Set(R.rows.map(r =>r.sector))].sort(), chainList = [...new Set(R.rows.flatMap(r =>r.chains))].sort();

const DEFAULT = { tab: 'board', q: '', seg: 'all', sector: '', chain: '', verdict: '', sort: 'implied_value_usd', dir: 'desc', open: '', limit: '60', dep: '10000', share: '0.075', hz: '90', cmp: '' };
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
const parts = Object.keys(DEFAULT).filter(k =>S[k] !== DEFAULT[k]).map(k =>`${k}=${encodeURIComponent(S[k])}`);
history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
render();
}

const COLS = [['rank', '# · range'], ['name', 'Protocol'], ['chains', 'Chains'], ['tvl_usd', 'TVL', 1], ['change_7d', '7d', 1], ['days_pre_token', 'Days, no token', 1], ['implied_value_usd', 'Implied value · P25–P75', 1], ['value_to_tvl', 'Value / TVL', 1], ['odds', 'Token in 1 yr', 1], ['ev', 'Drop EV', 1], ['verdict', 'Farm · $/h vs T-bill']].map(([key, label, n]) =>({ key, label, n }));
// CSV or JSON (with every plan step): rows as shown
const EXP = ['rank', 'slug', 'name', 'sector', 'tvl_usd', 'change_7d', 'days_pre_token', 'implied_value_usd', 'p25_usd', 'p75_usd'], flat = r =>({ ...Object.fromEntries(EXP.map(k =>[k, r[k] ?? null])), odds: r.odds.rate, verdict: r.plan.verdict, over_tbill_usd: +tf(r.plan.over, 2), per_hour_usd: +tf(r.plan.perHour, 2) });
function save(j) {
const rows = filtered().map(r =>(j ? { ...flat(r), steps: r.plan.steps } : flat(r))), q = v =>(typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v ?? ''), text = j ? JSON.stringify(rows) : [Object.keys(rows[0]).join(','), ...rows.map(o =>Object.values(o).map(q).join(','))].join('\n');
const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = `token-radar.${j ? 'json' : 'csv'}`; a.click();
}
const sortValue = (r, k) =>(k === 'odds' ? r.odds.rate : k === 'ev' ? r.plan.ev : k === 'verdict' ? r.plan.perHour : k === 'chains' ? r.chains.length : r[k]);

function filtered() {
const q = S.q.trim().toLowerCase(), rows = R.rows.filter(r =>
(S.seg === 'all' || (S.seg === 'watch' ? r.watchlist : !r.watchlist)) &&
(!S.sector || r.sector === S.sector) &&
(!S.chain || r.chains.includes(S.chain)) &&
(!S.verdict || r.plan.verdict === S.verdict) &&
(!q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || String(r.category).toLowerCase().includes(q)));
const k = S.sort, d = S.dir === 'asc' ? 1 : -1;
return rows.sort((a, b) =>{
const x = sortValue(a, k), y = sortValue(b, k);
if (x === y) return a.rank - b.rank;
if (x == null) return 1;
if (y == null) return -1;
return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
});
}

function band(r) {
const pos = v =>max(0, Math.min(100, ((log10(v) - 5) / 5) * 100));
return `<span class=band><i style="left:${pos(r.p25_usd)}%;right:${100 - pos(r.p75_usd)}%"></i><b style="left:calc(${pos(r.implied_value_usd)}% - 1px)"></b></span><small class=rng>${money(r.p25_usd)}–${money(r.p75_usd)}</small>`;
}

// evidence: each term's two blind tests; do ranges hold
function evidenceHtml() {
const x = v =>times(v).replace('.00', ''), f1 = l =>`${l < 0 ? '−' : '+'}${tf(abs(100 * (10 ** l - 1)), 1)}%`, tr = (a, k, w, n = '') =>`<tr><td>${a}<td class=n>${k}<td class=n>${w}<td>${n}`, B = '<em>baseline</em>', q4 = a =>[`${x(a[0])} · ${x(a[2])}`, `${x(a[1])} · ${x(a[3])}`], val = RF.table.map(t =>{
const why = t.helps ? '<em class=yes>kept: lowers both</em>' : t.kept ? `<em class=warn>kept (named by the brief): ${f1(max(t.with_kfold - t.without_kfold, t.with_walk - t.without_walk))} on one split; ${f1(h.noise.growth)} over 8 reshuffles (${h.noise.helps}/8 lower), noise ±${f1(h.noise.sd).slice(1)}</em>` : '<em class=no>tested, not kept</em>';
return tr(`+ ${esc(M.TERMS[t.term]?.label ?? 'sector effect')}`, `${x(t.with_kfold)} <s>${x(t.without_kfold)}</s>`, `${x(t.with_walk)} <s>${x(t.without_walk)}</s>`, why);
}).join('');
const hh = h.honest, beta = t =>RF.beta[RF.terms.indexOf(t) + 1], bt = beta('tvl'), ba = beta('age');
// best plans by excess over T-bills; why the biggest values farm worst
const top = R.rows.filter(r =>r.plan.over > 0).sort((a, b) =>b.plan.perHour - a.plan.perHour).slice(0, 5), r0 = R.rows[0];
const farm = top.map(r =>{ const P = r.plan; return `<tr data-slug="${esc(r.slug)}"><td><span class=nm>${esc(r.name)}</span> <small class=nt>${P.verdict}</small><div class=sub>${P.txs} tx, ${money(P.cost)} gas, ${P.minutes} min</div>${tm(r.tvl_usd)}${tm(P.ev)}<td class="n up">${sm(P.over)} · ${sm(P.perHour)}/h`; }).join('');
return `<section class=evid><h4>Out-of-sample evidence <span>recomputed by model.js; other terms stay only if both blind tests improve (walk-forward: earlier listings price later)</span></h4><div class=ev3>
<div><h5>Value if a token launches · typical miss on ${h.n} traded tokens</h5><table><tr><th>Term<th class=n>10-fold <s>without</s><th class=n>Walk-fwd <s>without</s><th>
${tr('flat median cap, mean · median', ...q4([h.naive_mae, h.naive_walk_mae, h.naive_med, h.naive_walk_med]), B)}${tr('one cap/TVL multiple, mean · median', ...q4(h.mult), B)}${tr('TVL size curve alone, mean · median', ...q4(h.size), `${B}: size only; the terms below cut the 10-fold median ${x(h.size[2])} to ${x(hh.kfold_med)}`)}${val}
${tr('<b>final model</b>, mean · median', `<b>${x(h.kfold_mae)} · ${x(hh.kfold_med)}</b>`, `<b>${x(h.walk_mae)} · ${x(hh.walk_med)}</b>`, `ranges hold: ${pc(hh.walk50)} in P25–P75, ${pc(hh.walk80)} in P10–P90`)}${tr(`same misses, the ${h.like.n} board-type tokens`, `${x(h.like.kfold_mae)} · ${x(h.like.kfold_med)}`, `${x(h.like.walk_mae)} · ${x(h.like.walk_med)}`, 'no bridge, staking, CEX or wrapper: the kinds the board ranks')}</table>
<p class=nt>Big misses are caps far from TVL (near zero on a large TVL): nothing in the snapshot predicts them, hence ranges.</p></div>
<div><h5>Start here: where ${dep$()} for ${F.horizonDays} days beats 4% T-bills</h5><table><tr><th>Protocol<th class=n>TVL<th class=n>Drop EV<th class=n>Over T-bills${farm}</table>
<p class=nt>Why the top says Watch: under $1B, value grows as TVL<sup>${tf(bt, 2)}</sup>, so a 10× larger protocol is worth ${tf(10 ** bt, 1)}× more but ${tf(10 ** (1 - bt), 1)}× less per dollar deposited. ${esc(r0.name)}: ${dep$()} is 1 part in ${money(r0.tvl_usd / F.deposit).slice(1)} of its TVL, a ${money(r0.plan.ev)} drop against ${money(r0.plan.bill)} in T-bills. No listing date: 365 days assumed; a doubling of days moves value only ×${tf(10 ** (ba * log10(2)), 2)}.</p></div></div></section>`;
}

function rowHtml(r) {
const chainText = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ` +${r.chains.length - 2}` : '');
return `<tr data-slug="${esc(r.slug)}"${S.open === r.slug ? ' class=sel' : ''}>
<td class=rank>${r.rank}<small>${h.boot.ranks[r.slug].join('–')}</small><button class="cb${S.cmp.split(',').includes(r.slug) ? ' on' : ''}" data-cmp="${esc(r.slug)}" aria-label="Compare">+</button>
<td><span class=nm>${esc(r.name)}</span>${r.watchlist ? '<span class="tag w">watchlist</span>' : ''}<div class=sub>${esc(r.category ?? 'Uncategorised')} · ${esc(r.sector)}</div>
<td class=sub>${esc(chainText)}
${tm(r.tvl_usd)}
<td class="n ${r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''}">${pct(r.change_7d)}
<td class=n>${r.days_pre_token ?? '365<span class=nt>*</span>'}
<td class=n><b>${money(r.implied_value_usd)}</b>${band(r)}
<td class=n>${tf(r.value_to_tvl, 2)}
<td class=n>${pc(r.odds.rate)}
${tm(r.plan.ev)}
<td class=vd>${vb(r)}${r.plan.verdict === 'Scale' ? `<small>3× gas from ${money(r.plan.size)}</small>` : `<small class="${r.plan.perHour >= 0 ? 'up' : 'down'}">${sm(r.plan.perHour)}/h</small>`}`;
}

// sandbox: farmPlan re-runs all plans (board.json: $10,000, 7.5%)
const base = R.rows.map(r =>r.plan), pm = R.rows.filter((r, i) =>JSON.stringify(M.farmPlan(R.snap[r.slug], r.implied_value_usd, r.odds, base[i])) === JSON.stringify(base[i])).length, dep$ = () =>`$${F.deposit.toLocaleString('en-US')}`;
let planned = '10000|0.075|90';
function replan() {
if (`${S.dep}|${S.share}|${S.hz}` === planned) return;
const d = Number(S.dep) || 10000, sh = Number(S.share) || 0.075; const hz = Number(S.hz) || 90; planned = `${S.dep}|${S.share}|${S.hz}`; F.deposit = d; F.airdropShare = sh; F.horizonDays = hz;
R.rows.forEach((r, i) =>{ r.plan = d === 10000 && sh === 0.075 && hz === 90 ? base[i] : M.farmPlan(R.snap[r.slug], r.implied_value_usd, r.odds, base[i]); });
}

// two rows picked with +, side by side
function cmpHtml() {
const [a, b] = S.cmp.split(',').map(s =>R.rows.find(r =>r.slug === s));
if (!a || !b) return '';
const part = (r, t) =>times(r.parts.find(q =>q.term === t)?.log ?? 0), L = [['TVL', r =>money(r.tvl_usd)], ['7-day change', r =>pct(r.change_7d)], ['Days, no token', r =>r.days_pre_token ?? '365*'],
...a.parts.filter(q =>q.term !== 'base').map(q =>[q.term === 'sector' ? 'sector effect' : esc(q.label), r =>part(r, q.term)]),
['Implied value · P25–P75', r =>`<b>${money(r.implied_value_usd)}</b> · ${money(r.p25_usd)}–${money(r.p75_usd)}`], ['Token in 1 yr', r =>pc(r.odds.rate)],
['Drop EV · gas', r =>`${money(r.plan.ev)} · ${money(r.plan.cost)}`],
['Over T-bills · $/h', r =>`${sm(r.plan.over)} · ${sm(r.plan.perHour)}/h`], ['Verdict', r =>`${vb(r)}`]];
const h = Math.ceil(L.length / 2), hd = `<tr><th><th class=n>#${a.rank} ${esc(a.name)}<th class=n>#${b.rank} ${esc(b.name)}`;
return `<div class="cmp card"><h3>Compare (predictLog, farmPlan) <button class=close data-cmp="">Clear</button></h3><div class=cmp2>${[L.slice(0, h), L.slice(h)].map(l =>`<table class=peers>${hd}${l.map(([k, f]) =>`<tr><td>${k}<td class=n>${f(a)}<td class=n>${f(b)}`).join('')}</table>`).join('')}</div></div>`;
}

function boardHtml() {
const rows = filtered(), lim = Number(S.limit) || 60, seg = (v, t) =>`<button data-seg="${v}" class="${S.seg === v ? 'on' : ''}">${t}</button>`;
const pick = (id, label, vals, f) =>`<select id="${id}" aria-label="${label}">${vals.map(v =>`<option value="${v}"${String(v) === S[id] ? ' selected' : ''}>${f(v)}`).join('')}</select>`, opt = (list, cur, all) =>`<option value="">${all}` + list.map(v =>`<option${v === cur ? ' selected' : ''}>${esc(v)}`).join('');
return `<div class=filters role=search>
<input type="search" id=q placeholder="Search protocol or category" value="${esc(S.q)}" aria-label="Search">
<div class=seg>${seg('all', 'All pre-token')}${seg('watch', `Watchlist (${R.checks.watch})`)}${seg('below', `Off the watchlist (${N - R.checks.watch})`)}</div>
<select id=sector aria-label="Sector">${opt(sectors, S.sector, 'Every sector')}</select>
<select id=chain aria-label="Chain">${opt(chainList, S.chain, 'Every chain')}</select>
<select id=verdict aria-label="Farm verdict">${opt(['Farm', 'Test', 'Scale', 'Watch'], S.verdict, 'Every verdict')}</select>
${pick('dep', 'Deposit', [1000, 10000, 50000], d =>`Deposit $${d.toLocaleString('en-US')}`)}
${pick('share', 'Airdrop share of implied value', ['0.025', '0.075', '0.15'], v =>`Drop share ${+tf(v * 100, 1)}%`)}
${pick('hz', 'Farm days', ['30', '90', '180'], v =>`${v}-day farm`)}
<button class=close id=csv>CSV</button><button class=close id=json>JSON</button>
<span class=shown>${rows.length} of ${N} shown · ranked by <b>${esc(COLS.find(c =>c.key === S.sort)?.label ?? S.sort)}</b> ${S.share !== '0.075' ? `· <b>sandbox: drop share ${+tf(S.share * 100, 1)}%</b> (board.json uses 7.5%) ` : ''}${S.hz !== '90' ? `· <b>sandbox: ${S.hz}-day farm</b> (board.json uses 90) ` : ''}· 365<span class=nt>*</span> = no listing date, 365 days assumed · click a row for its plan</span></div>
${cmpHtml()}<div class=table><table><thead><tr>${COLS.map(c =>`<th data-k="${c.key}" class="${c.n ? 'n' : ''}"${S.sort === c.key ? ` aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}`).join('')}
<tbody>${rows.slice(0, lim).map(rowHtml).join('')}</table>
${rows.length > lim ? `<div class=more><button class=close id=more>Show all ${rows.length}</button></div>` : ''}</div>`;
}

// peers on family TVL; a cap over 50x TVL is left out as hype
const pt = q =>q.priced_tvl ?? q.tvl_usd;
function peersOf(r) {
const lt = log10(r.tvl_usd), gap = q =>abs(log10(pt(q)) - lt);
return R.live.filter(q =>q.sector === r.sector && q.mcap_usd <= 50 * pt(q)).sort((a, b) =>gap(a) - gap(b) || a.slug.localeCompare(b.slug)).slice(0, 4);
}

// net after gas and risk: 3 deposits x 3 drop shares
function grid(r) {
const p = r.plan, bill = d =>d * F.billRate * F.horizonDays / 365, net = (d, s) =>((p.ev * s) / F.airdropShare + p.yieldUsd - p.risk) * d / F.deposit - p.cost, cell = v =>`<td class="n ${v >= 0 ? 'up' : 'down'}">${sm(v)}`, D = [1000, 10000, 50000];
return `<table class=peers><tr><th>Drop share ↓ · deposit → (net after gas, risk)${D.map(d =>`<th class=n>${money(d)}`).join('')}${[0.025, 0.075, 0.15].map(s =>`<tr><td>${tf(s * 100, 1)}% of implied value${s === F.airdropShare ? ' (used)' : ''}${D.map(d =>cell(net(d, s))).join('')}`).join('')}<tr><td class=nt>benchmark: 4% T-bills, same days${D.map(d =>`<td class="n note">+${money(bill(d))}`).join('')}</table>`;
}

function detailHtml(r) {
if (!r) return '';
const P = r.plan, mx = max(...r.parts.filter(q =>q.term !== 'base').map(q =>abs(q.log)), 0.2), build = r.parts.filter(q =>q.log || q.term === 'base').map(q =>q.term === 'base'
? `<tr><td>Fitted base at $100M TVL<td class=bar>${tm(10 ** q.log)}`
: `<tr><td>${esc(q.label)}<td class=bar><i style="width:${(abs(q.log) / mx) * 100}%;background:${q.log >= 0 ? 'var(--teal)' : 'var(--red)'}"></i><td class=n>${times(q.log)}`).join('');
const steps = P.steps.map(s =>`<li><span><b class=tg>${s.tag}</b> ${esc(s.text)}<span class=bdg><i>COST $${tf(s.cost, 2)} ${s.n ? `(${s.n} tx at $${tf(s.g, 2)} on ${esc(s.ch)}${s.tag === 'SETUP' ? ` + $${tf(F.bridgeUsd, 2)} bridge` : ''})` : '(no transaction)'}</i><i>TIME ${s.minutes} min hands-on</i><i>${s.when}</i></span></span>`).join('');
const peers = peersOf(r).map(q =>`<tr><td>${esc(q.name)}${tm(pt(q))}${tm(q.mcap_usd)}<td class=n>${tf(q.mcap_usd / pt(q), 2)}`).join('');
return `<button class=close id=close>Close</button>
<div class=sub>Rank ${r.rank} of ${N} · ${esc(r.category ?? 'Uncategorised')} · ${offReason(r)}</div>
<h2>${esc(r.name)}</h2>
<div style="margin-top:12px"><span class=big>${money(r.implied_value_usd)}</span> <span class=nt>implied token value · P25–P75 ${money(r.p25_usd)} to ${money(r.p75_usd)} · P10–P90 ${money(r.low_usd)} to ${money(r.high_usd)} (held out: ${pc(h.honest.walk50)} · ${pc(h.honest.walk80)} of real caps inside)</span></div>
<div class=dcols><div>
<div class=sum>${vb(r)}<div><b>Per ${dep$()} for ${F.horizonDays} days: ${sm(P.net)} net, T-bills ${money(P.bill)} · ${sm(P.over)} over T-bills, ${sm(P.perHour)}/h</b><br><span class=nt>${esc(P.verdictText)} · ${P.txs} txs, ${money(P.cost)} gas, ${P.minutes} min on ${esc(P.chain)}</span></div></div>
<div class=facts>
<div><span>TVL</span><b>${money(r.tvl_usd)}</b></div><div><span>7-day change</span><b class="${r.change_7d > 0 ? 'up' : 'down'}">${pct(r.change_7d)}</b></div><div><span>Tracked, no token</span><b>${r.days_pre_token ?? 365} days</b>${r.days_pre_token == null ? ' <small class=nt>no listing date: 365 assumed</small>' : ''}</div>
<div><span>Token within ${M.ODDS.horizonDays} days</span><b>${pc(r.odds.rate)}</b> <small class=nt>survival fit: ${pc(r.odds.now)} of like ${esc(r.odds.sector)} protocols have one at this age, ${pc(r.odds.later)} a year older</small></div>
</div>
<h3>How the value is built (model.js predictLog)</h3>
<table class=build>${build}<tr><td><b>Implied value</b><td><td class=n><b>${money(r.implied_value_usd)}</b></table>
<h3>Nearest live-token peers in ${esc(r.sector)} (what the market pays; caps over 50× TVL left out)</h3>
<table class=peers><tr><th>Peer<th class=n>TVL<th class=n>Market cap<th class=n>Cap / TVL${peers}</table>
</div><div>
<h3>Farm plan (model.js farmPlan)</h3>
<ol class=steps>${steps}</ol>
${grid(r)}
</div></div>`;
}

function liveHtml() {
const rows = R.live.slice(0, 40).map(q =>{
const err = log10(q.blind_usd / q.mcap_usd);
return `<tr><td><span class=nm>${esc(q.name)}</span> <span class=tag>${esc(q.symbol ?? '')}</span><div class=sub>${esc(q.category ?? '')}</div>${tm(q.tvl_usd)}${q.family > 1 ? `<div class=sub>${q.family} products: ${money(q.priced_tvl)}</div>` : ''}<td class=n><b>${money(q.mcap_usd)}</b>${tm(q.blind_usd)}<td class="n ${abs(err) < 0.3 ? 'up' : ''}">×${(10 ** abs(err)).toFixed(abs(err) < 1 ? 1 : 0)} ${err < 0 ? 'under' : 'over'}`;
}).join('');
// 128 blind values vs caps; dashed = P10-P90 band
const lg = v =>log10(max(v, 1e4)), X = v =>48 + (lg(v) - 4) * 62, Y = v =>300 - (lg(v) - 4) * 44, dots = R.live.map(q =>`<circle cx="${tf(X(q.blind_usd), 1)}" cy="${tf(Y(q.mcap_usd), 1)}" r="3"><title>${esc(q.name)}</title></circle>`).join('');
const ln = (d, c) =>`<line x1="${X(1e5)}" y1="${Y(10 ** (5 + d))}" x2="${X(1e10)}" y2="${Y(10 ** (10 + d))}" class="${c}"/>`;
const ex = e =>`$${10 ** (e % 3)}${'kMB'[(e / 3 | 0) - 1]}`, ax = [5, 6, 7, 8, 9, 10].map(e =>`<text x="${X(10 ** e)}" y="318">${ex(e)}</text><text x="34" y="${Y(10 ** e) + 4}" text-anchor="end">${ex(e)}</text>`).join('');
const inside = R.live.filter(q =>{ const d = lg(q.mcap_usd) - lg(q.blind_usd); return d >= h.interval_lo && d <= h.interval_hi; }).length;
const plot = `<figure class=plot><svg viewBox="0 0 440 326" role=img aria-label="Blind model value against market cap">${ax}${ln(0, 'eq')}${ln(h.interval_lo, 'bd')}${ln(h.interval_hi, 'bd')}<g class=dots>${dots}</g></svg>
<figcaption>Blind model value (x) against the market cap (y), ${Lv} live tokens: on the solid line the model is exact; ${inside} of ${Lv} (${pc(inside / Lv)}) fall between the dashed P10–P90 lines; the band was set on these 10-fold misses, so the honest check is the walk-forward ${pc(h.honest.walk80)} on top.</figcaption></figure>`;
return `${plot}<p class=nt>Live tokens are the training set, never ranked. Each is valued by a fit that never saw it (10-fold); a token on several products (same gecko_id, or symbol and name word) is fitted on their summed TVL.</p>
<div class=table><table><thead><tr><th>Live token<th class=n>TVL<th class=n>Market cap<th class=n>Blind model value<th class=n>Blind error<tbody>${rows}</table>
<div class=more>${Lv} live tokens fit · ${R.recorded} with a token but no cap set apart</div></div>`;
}

function methodHtml() {
const b = RF.beta, o = RF.odds, terms = RF.terms.filter(t =>t !== 'sector'), coef = terms.map((t, i) =>`<tr><td>${esc(M.TERMS[t].label)}<td class=n>${tf(b[i + 1], 3)}<td class=nt>${esc(M.TERMS[t].why)}`).join('');
return `<div class=method>
<div class=card><h3>The value model</h3>
<div class=formula>P25–P75 = value × 10^[${tf(h.lo50, 2)}, +${tf(h.hi50, 2)}], P10–P90 = value × 10^[${tf(h.interval_lo, 2)}, +${tf(h.interval_hi, 2)}] (10-fold residual quantiles)</div>
<p>Least absolute misses on ${h.n} market caps (fitValueModel); extra terms stay only if both blind errors fall. Growth and days run are priced as TVL, <b>effective TVL = TVL × (1 + 7-day change vs sector median) × days<sup>a</sup></b>, at the TVL slope (${tf(RF.prior.slope, 3)}; a = ${RF.prior.a}, lowest blind error): free, their slopes are ${RF.prior.free.map(f =>`${f.term} ${tf(f.slope, 2)} ± ${tf(f.se, 2)}`).join(', ')}, noise.</p>
<table><tr><th>Term<th class=n>Weight<th>${coef}</table>
<p class=nt>Sector effects (shrunk toward zero): ${Object.entries(RF.sector).map(([k, v]) =>`${esc(k)} ${times(v.effect)}`).join(' · ')}.</p></div>
<div class=card><h3>Token odds (model.js fitOdds)</h3>
<p>${o.n} dated protocols, ${o.tokened} with a token. F(age) = share tokened by that age, logistic in log10 days${o.terms.map(t =>` + ${t}`).join('')} + sector; untokened at age a, odds = (F(a+${M.ODDS.horizonDays}) − F(a)) / (1 − F(a)). Age slope ${tf(o.beta[1], 2)}.</p>
<h3 style="margin-top:16px">Farm assumptions</h3>
<p>Airdrop = ${tf(F.airdropShare * 100, 1)}% of implied value, pro rata to TVL, ${F.horizonDays}/${F.seasonDays} season days, times the odds; plus BASE_APY yield, less ${pc(F.lossRatePerYear)}/yr risk and GAS_USD gas; bar: 4% T-bills. Rules: farmPlan. Assumptions, not quotes.</p>
<p class=nt>No token in the snapshot is not proof none exists; a value is this model's claim, not a forecast.</p></div></div>`;
}

// the model in one line, weights with bootstrap s.d.
function formulaHtml() {
const b = RF.beta, bt = h.boot, nt = RF.terms.filter(t =>t !== 'sector'), big = nt.indexOf('big'), fx = Object.entries(RF.sector).map(([k, v]) =>[k, 10 ** v.effect]).sort((u, v) =>u[1] - v[1]), pm = (v, e) =>`${tf(v, 2)}<small>±${tf(e, 2)}</small>`, o = RF.odds, B = i =>tf(o.brier[i], 3);
return `<p class=formula1><b>Implied value</b> = ${money(10 ** b[0])} × (effective TVL ÷ $100M)<sup>${pm(RF.prior.slope, bt.slope)}</sup>${big >= 0 ? ` × (TVL ÷ $1B)<sup>${pm(b[big + 1], bt.big)}</sup> past $1B` : ''} × sector factor (×${tf(fx[0][1], 2)} ${esc(fx[0][0])} … ×${tf(fx.at(-1)[1], 2)} ${esc(fx.at(-1)[0])}); effective TVL = TVL × (1 + 7-day change vs sector) × (days ÷ 316)<sup>${RF.prior.a}</sup>. Fitted on the ${h.n} live caps by fitValueModel; ± = s.d. over ${bt.refits} bootstrap refits; # range = the row's rank P5–P95 over them.</p>
<p class=formula1><b>Value × odds</b> = implied value × P(token in ${M.ODDS.horizonDays} days), a survival fit (fitOdds, ${o.n} protocols, ${o.tokened} with a token). Both held out: value ${times(h.like.walk_med)} vs ${times(h.like.mult_walk_med)} one multiple (walk-fwd); odds Brier, terms in order (10-fold): base rate ${B(2)} → +age ${B(3)} → +sector ${B(4)} → +${o.terms} <b>${B(0)}</b>; ${o.tests.filter(t =>!t.kept).map(t =>t.term)} not kept.</p>`;
}

function render() {
replan();
const watchCount = R.rows.filter(r =>r.watchlist).length, farms = R.rows.filter(r =>r.plan.verdict === 'Farm').length, tab = (k, t, n) =>`<button data-tab="${k}" aria-selected="${S.tab === k}">${t}<span class=count>${n}</span></button>`;
const body = S.tab === 'live' ? liveHtml() : S.tab === 'method' ? methodHtml() : boardHtml(), kpi = (t, b, s, hi = '') =>`<div class="kpi${hi}"><span>${t}</span><b>${b}</b><small>${s}</small></div>`, ck = (ok, t) =>`<span class="check${ok ? '' : ' bad'}">${t}</span>`;
const off = Object.entries(R.setAside).sort((a, b) =>b[1] - a[1] || a[0].localeCompare(b[0])), offN = off.reduce((a, e) =>a + e[1], 0), sum = N + h.n + R.recorded + offN;
const total = R.rows.reduce((a, r) =>a + r.implied_value_usd, 0), ordered = R.rows.every((r, i) =>r.rank === i + 1 && (i === 0 || r.implied_value_usd <= R.rows[i - 1].implied_value_usd)), costed = R.rows.every(r =>r.plan.steps.length >= 3 && r.plan.steps.length <= 12 && r.plan.steps.every(s =>s.minutes > 0));
$('#app').innerHTML = `<header class=top><div class=brand>
<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="#24314b" stroke-width="2"/><path d="M20 20 L34 9 A18 18 0 0 1 38 20 Z" fill="#f2b33d" fill-opacity=".35"/><circle cx="29" cy="14" r="2.6" fill="#f2b33d"/></svg>
<div><h1>Token Radar</h1><p>${N} DeFi protocols with <b>no token yet</b>, ranked by the token value their TVL, 7-day growth and time without a token imply. Live tokens are the model's price data, not rows.</p></div></div>
<div class=stamp>DefiLlama snapshot ${esc(R.as_of)} · ${R.protocols} protocols<br>board sha256 ${esc(R.checks.sha.slice(0, 16))}</div></header>
<section class=kpis>
${kpi('Pre-token on the board', `${N}`, `${watchCount} watchlist · ${belowCount} under $${tf(R.floor_usd / 1e6, 0)}M · ${N - watchCount - belowCount} other`, ' hi')}
${kpi('Implied value, board total', `${money(total)}`, `top: ${esc(R.rows[0].name)}`)}
${kpi('Is the printed range honest?', `${pc(h.honest.walk50)} · ${pc(h.honest.walk80)}`, `held-out caps inside P25–P75 · P10–P90 (stated 50% · 80%)`)}
${kpi('Out-of-sample miss, median', `${times(h.like.walk_med)}`, `walk-forward, the ${h.like.n} board-type tokens; one cap/TVL multiple ${times(h.like.mult_walk_med)} · all ${h.n}: ${times(h.honest.walk_med)}, 10-fold ${times(h.honest.kfold_med)}`)}
${kpi(`Farm at ${dep$()}, ${+tf(F.airdropShare * 100, 1)}% drop: 3x gas, beats T-bills`, `${farms}`, `${['Test', 'Scale', 'Watch'].map(v =>`${R.rows.filter(x =>x.plan.verdict === v).length} ${v}`).join(' · ')}`)}</section>
${formulaHtml()}
<p class=ledger><b>Every protocol accounted for:</b> ${R.protocols} in the snapshot = <b>${N}</b> on this board (${watchCount} watchlist) + <b>${h.n}</b> live tokens, the price sample + <b>${R.recorded}</b> token recorded, no market cap + <b>${offN}</b> set aside by rule (${off.map(([k, v]) =>`${esc(k.replace('category ', ''))} ${v}`).join(', ')}). Largest: ${R.asideTop.map(([n, c, t]) =>`${esc(n)} ${money(t)} (${esc(c)})`).join(', ')}; a raw-TVL board ranks these first; none will launch a token.</p>
<div class=checks aria-label="Integrity strip: each check is recomputed in this page">
${ck(matches === N, `${matches}/${N} values recomputed here = board.json`)}
${ck(ordered, `ranks 1–${N} in order, values never rise`)}
${ck(total === R.checks.total, `totals equal: ${money(total)}`)}
${ck(M.fnv(R.rows) === R.checks.fnv, `checksum ${M.fnv(R.rows)} = main.ts`)}
${ck(watchCount === R.checks.watch, `watchlist ${watchCount} of ${R.checks.watch} ranked, +${N - watchCount} beyond it`)}
${ck(sum === R.protocols, `ledger ${sum} of ${R.protocols}`)}
${ck(R.rows.every(r =>!M.setAsideReason(R.snap[r.slug]) && !M.recordsToken(R.snap[r.slug])), '0 live tokens, bridges, CEXs or wrappers ranked')}
${ck(costed && pm === N, `${pm}/${N} plans rebuilt here by farmPlan = main.ts, 3–12 costed steps`)}</div>
${S.tab === 'board' ? evidenceHtml() : ''}
<nav class=tabs role=tablist>${tab('board', 'Pre-token board', N)}${tab('live', 'Live tokens (training set)', h.n)}${tab('method', 'Method & blind tests', '')}</nav>
${body}
`;
const open = R.rows.find(r =>r.slug === S.open), aside = $('#detail');
aside.innerHTML = detailHtml(open);
aside.classList.toggle('open', !!open);
$('#board').setAttribute('aria-busy', 'false');
}

const on = (e, f) =>document.addEventListener(e, f);
on('click', e =>{
const t = e.target.closest('[data-cmp],[data-tab],[data-seg],th[data-k],tr[data-slug],#close,#more,#csv,#json');
if (!t) return;
const c = t.dataset.cmp;
if (c !== undefined) setState({ cmp: c ? [...S.cmp.split(',').filter(x =>x && x !== c), c].slice(-2).join(',') : '' });
else if (t.dataset.tab) setState({ tab: t.dataset.tab, open: '' });
else if (t.dataset.seg) setState({ seg: t.dataset.seg });
else if (t.dataset.k) setState({ sort: t.dataset.k, dir: S.sort === t.dataset.k && S.dir === 'desc' ? 'asc' : 'desc' });
else if (t.dataset.slug) setState({ open: t.dataset.slug });
else if (t.id === 'close') setState({ open: '' });
else if (t.id === 'more') setState({ limit: '9999' });
else save(t.id === 'json');
});
on('change', e =>{ if (['sector', 'chain', 'verdict', 'dep', 'share', 'hz'].includes(e.target.id)) setState({ [e.target.id]: e.target.value }); });
on('input', e =>{ if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; setState({}); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); } });
on('keydown', e =>{ if (e.key === 'Escape' && S.open) setState({ open: '' }); });
window.addEventListener('hashchange', () =>{ S = readState(); render(); });
render();
})();
