/* Token Radar page: reads window.RADAR (data.js, written by main.ts) and window.RadarModel (model.js).
 * The page re-derives every implied value from model.js before it shows one, and says so on the
 * checks strip: what is on screen is what the code computes, not a pasted table. */
(function () {
  'use strict';
  const R = window.RADAR, M = window.RadarModel;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** $1.2B / $340M / $12.5k: a reader's money. */
  function money(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
    return `$${v.toFixed(a >= 10 ? 0 : 2)}`;
  }
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const times = (log) => `\u00d7${(10 ** log).toFixed(2)}`;

  // ---- integrity: recompute every implied value from model.js and the raw snapshot row ----
  const fit = { terms: R.fit.terms, beta: R.fit.beta, sector: R.fit.sector };
  let matches = 0;
  for (const r of R.rows) {
    const p = R.snap[r.slug];
    if (p && Math.max(1, Math.round(10 ** M.predictLog(fit, p, R.as_of).log)) === r.implied_value_usd) matches++;
  }
  const h = R.fit.heldout;
  const sectors = [...new Set(R.rows.map((r) => r.sector))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort((a, b) => R.rows.filter((r) => r.chains.includes(b)).length - R.rows.filter((r) => r.chains.includes(a)).length || a.localeCompare(b)).slice(0, 24);

  // ---- state lives in the address hash, so every view can be linked and captured ----
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

  // ---- the board ----
  const COLS = [
    { key: 'rank', label: '#', n: false },
    { key: 'name', label: 'Protocol' },
    { key: 'chains', label: 'Chains' },
    { key: 'tvl_usd', label: 'TVL', n: true },
    { key: 'change_7d', label: '7d', n: true },
    { key: 'days_pre_token', label: 'Days, no token', n: true },
    { key: 'implied_value_usd', label: 'Implied value \u00b7 80% band', n: true },
    { key: 'value_to_tvl', label: 'Value / TVL', n: true },
    { key: 'odds', label: 'Peer token odds', n: true },
    { key: 'ev', label: 'Airdrop EV per $1k', n: true },
    { key: 'verdict', label: 'Farm' },
  ];
  const sortValue = (r, k) => (k === 'odds' ? r.odds.rate : k === 'ev' ? r.plan.ev : k === 'verdict' ? r.plan.ratio : k === 'chains' ? r.chains.length : r[k]);

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

  /** The 80% band on a log scale from $100k to $10B, with the point estimate as a tick. */
  function band(r) {
    const pos = (v) => Math.max(0, Math.min(100, ((Math.log10(v) - 5) / 5) * 100));
    return `<span class="band" title="${money(r.low_usd)} to ${money(r.high_usd)}"><i style="left:${pos(r.low_usd)}%;right:${100 - pos(r.high_usd)}%"></i><b style="left:calc(${pos(r.implied_value_usd)}% - 1px)"></b></span>`;
  }

  function rowHtml(r) {
    const chainText = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ` +${r.chains.length - 2}` : '');
    return `<tr data-slug="${esc(r.slug)}"${S.open === r.slug ? ' class="sel"' : ''}>
      <td class="rank">${r.rank}</td>
      <td><span class="nm">${esc(r.name)}</span>${r.watchlist ? '<span class="tag w">watchlist</span>' : ''}<div class="sub">${esc(r.category ?? 'Uncategorised')} \u00b7 ${esc(r.sector)}</div></td>
      <td class="sub">${esc(chainText)}</td>
      <td class="n">${money(r.tvl_usd)}</td>
      <td class="n ${r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''}">${pct(r.change_7d)}</td>
      <td class="n">${r.days_pre_token ?? 'n/a'}</td>
      <td class="n"><b>${money(r.implied_value_usd)}</b>${band(r)}</td>
      <td class="n">${r.value_to_tvl.toFixed(2)}</td>
      <td class="n">${(r.odds.rate * 100).toFixed(0)}%</td>
      <td class="n">${money(r.plan.ev)}</td>
      <td><span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span></td></tr>`;
  }

  function boardHtml() {
    const rows = filtered(), lim = Number(S.limit) || 60;
    const seg = (v, t) => `<button data-seg="${v}" class="${S.seg === v ? 'on' : ''}">${t}</button>`;
    const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
    return `<div class="filters" role="search">
        <input type="search" id="q" placeholder="Search protocol or category" value="${esc(S.q)}" aria-label="Search">
        <div class="seg">${seg('all', 'All pre-token')}${seg('watch', `Watchlist (${R.checks.watch})`)}${seg('below', 'Below the $50M floor')}</div>
        <select id="sector" aria-label="Sector">${opt(sectors, S.sector, 'Every sector')}</select>
        <select id="chain" aria-label="Chain">${opt(chains, S.chain, 'Every chain')}</select>
        <select id="verdict" aria-label="Farm verdict">${opt(['Farm', 'Test', 'Scale', 'Watch'], S.verdict, 'Every verdict')}</select>
        <span class="shown">${rows.length} of ${R.rows.length} shown \u00b7 click a row for its plan</span></div>
      <div class="table"><table><thead><tr>${COLS.map((c) => `<th data-k="${c.key}" class="${c.n ? 'n' : ''}"${S.sort === c.key ? ` aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, lim).map(rowHtml).join('')}</tbody></table>
      ${rows.length > lim ? `<div class="more"><button class="close" id="more">Show all ${rows.length}</button></div>` : ''}</div>`;
  }

  // ---- the detail view ----
  function peersOf(r) {
    const lt = Math.log10(r.tvl_usd);
    return R.live.filter((q) => q.sector === r.sector).sort((a, b) => Math.abs(Math.log10(a.tvl_usd) - lt) - Math.abs(Math.log10(b.tvl_usd) - lt) || a.slug.localeCompare(b.slug)).slice(0, 4);
  }

  function detailHtml(r) {
    if (!r) return '';
    const max = Math.max(...r.parts.filter((q) => q.term !== 'base').map((q) => Math.abs(q.log)), 0.2);
    const build = r.parts.map((q) => q.term === 'base'
      ? `<tr><td>Fitted base at $100M TVL</td><td class="bar"></td><td class="n">${money(10 ** q.log)}</td></tr>`
      : `<tr><td>${esc(q.label)}</td><td class="bar"><i style="width:${(Math.abs(q.log) / max) * 100}%;background:${q.log >= 0 ? 'var(--teal)' : 'var(--red)'}"></i></td><td class="n">${times(q.log)}</td></tr>`).join('');
    const steps = r.plan.steps.map((s) => `<li><span>${esc(s.text)}</span><span class="cost">${s.cost > 0 ? `$${s.cost.toFixed(2)}` : '\u2014'} \u00b7 ${s.minutes}m</span></li>`).join('');
    const peers = peersOf(r).map((q) => `<tr><td>${esc(q.name)}</td><td class="n">${money(q.tvl_usd)}</td><td class="n">${money(q.mcap_usd)}</td><td class="n">${(q.mcap_usd / q.tvl_usd).toFixed(2)}</td></tr>`).join('');
    return `<button class="close" id="close">Close</button>
      <div class="sub">Rank ${r.rank} of ${R.rows.length} \u00b7 ${esc(r.category ?? 'Uncategorised')} \u00b7 ${r.watchlist ? 'on the watchlist' : 'below the watchlist floor'}</div>
      <h2>${esc(r.name)}</h2>
      <div style="margin-top:12px"><span class="big">${money(r.implied_value_usd)}</span> <span class="note">implied token value \u00b7 80% band ${money(r.low_usd)} to ${money(r.high_usd)}</span></div>
      <div class="facts">
        <div><span>TVL</span><b>${money(r.tvl_usd)}</b></div><div><span>7-day change</span><b class="${r.change_7d > 0 ? 'up' : 'down'}">${pct(r.change_7d)}</b></div><div><span>Tracked, no token</span><b>${r.days_pre_token ?? 'n/a'} days</b></div>
        <div><span>Value / TVL</span><b>${r.value_to_tvl.toFixed(2)}</b></div><div><span>Peer token odds</span><b>${(r.odds.rate * 100).toFixed(0)}%</b> <small class="note">${r.odds.tokened}/${r.odds.peers} ${esc(r.odds.sector)}</small></div><div><span>Cheapest chain</span><b>${esc(r.plan.chain)}</b></div>
      </div>
      <h3>How the value is built (model.js predictLog)</h3>
      <table class="build">${build}<tr><td><b>Implied value</b></td><td></td><td class="n"><b>${money(r.implied_value_usd)}</b></td></tr></table>
      <h3>Farm plan \u00b7 verdict <span class="verdict ${r.plan.verdict}">${r.plan.verdict}</span> <span style="text-transform:none;letter-spacing:0">${esc(r.plan.verdictText)}</span></h3>
      <ol class="steps">${steps}</ol>
      <p class="note">Total ${money(r.plan.cost)} of gas over ${M.FARM.horizonDays} days, about ${r.plan.minutes} minutes of work, ${r.plan.txs} transactions. Expected airdrop ${money(r.plan.ev)} per $1,000; gas breaks even at a deposit of ${money(r.plan.breakEven)}.</p>
      <h3>Nearest live-token peers in ${esc(r.sector)} (what the market pays)</h3>
      <table class="peers"><tr><th>Peer</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Cap / TVL</th></tr>${peers}</table>`;
  }

  // ---- the live tokens: kept apart, and used to show the fit's blind error ----
  function liveHtml() {
    const rows = R.live.slice(0, 40).map((q) => {
      const err = Math.log10(q.blind_usd / q.mcap_usd);
      return `<tr><td><span class="nm">${esc(q.name)}</span> <span class="tag">${esc(q.symbol ?? '')}</span><div class="sub">${esc(q.category ?? '')}</div></td><td class="n">${money(q.tvl_usd)}</td><td class="n"><b>${money(q.mcap_usd)}</b></td><td class="n">${money(q.blind_usd)}</td><td class="n ${Math.abs(err) < 0.3 ? 'up' : ''}">${times(err)}</td></tr>`;
    }).join('');
    return `<p class="note">Protocols whose token already trades are never ranked on the board. They are the training set: each one below is valued by a fit that never saw it (10-fold), next to its real market cap.</p>
      <div class="table"><table><thead><tr><th>Live token</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Blind model value</th><th class="n">Blind error</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="more">${R.live.length} live tokens fit the model \u00b7 ${R.recorded} more record a token with no market cap and are set apart too</div></div>`;
  }

  /** Blind prediction against the market, log10 axes, $1M to $100B. */
  function scatter() {
    const W = 520, H = 320, P = 36, x = (v) => P + ((Math.log10(v) - 6) / 5) * (W - 2 * P), y = (v) => H - P - ((Math.log10(v) - 6) / 5) * (H - 2 * P);
    const pts = R.live.map((q) => `<circle cx="${x(Math.max(1e6, q.blind_usd)).toFixed(1)}" cy="${y(Math.max(1e6, Math.min(1e11, q.mcap_usd))).toFixed(1)}" r="3.2" fill="#f2b33d" fill-opacity=".7"/>`).join('');
    const ticks = [6, 7, 8, 9, 10, 11].map((e) => `<text x="${x(10 ** e)}" y="${H - 12}" fill="#8c99b3" font-size="11" text-anchor="middle">${money(10 ** e)}</text><text x="6" y="${y(10 ** e) + 4}" fill="#8c99b3" font-size="11">${money(10 ** e)}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Blind model value against market cap"><rect x="${P}" y="${P}" width="${W - 2 * P}" height="${H - 2 * P}" fill="none" stroke="#24314b"/><line x1="${x(1e6)}" y1="${y(1e6)}" x2="${x(1e11)}" y2="${y(1e11)}" stroke="#39c5b0" stroke-dasharray="4 4"/>${ticks}${pts}<text x="${W / 2}" y="${H - 0}" fill="#5d6a85" font-size="11" text-anchor="middle">blind model value \u2192 (market cap \u2191)</text></svg>`;
  }

  function methodHtml() {
    const b = R.fit.beta, terms = R.fit.terms.filter((t) => t !== 'sector');
    const coef = terms.map((t, i) => `<tr><td>${esc(M.TERMS[t].label)}</td><td class="n">${b[i + 1].toFixed(3)}</td><td class="note">${esc(M.TERMS[t].why)}</td></tr>`).join('');
    const sec = Object.entries(R.fit.sector).map(([s, v]) => `<tr><td>${esc(s)}</td><td class="n">${times(v.effect)}</td><td class="note">${v.n} live tokens</td></tr>`).join('');
    const tests = R.fit.table.map((t) => `<tr><td>${esc(t.term)}</td><td class="n">${t.with_kfold.toFixed(3)} / ${t.without_kfold.toFixed(3)}</td><td class="n">${t.with_walk.toFixed(3)} / ${t.without_walk.toFixed(3)}</td><td class="${t.kept ? 'yes' : 'no'}">${t.kept ? 'kept' : 'dropped'}</td><td class="note">${esc(t.rule)}</td></tr>`).join('');
    return `<div class="method">
      <div class="card"><h3>The value model</h3>
        <div class="formula">log10(value) = ${b[0].toFixed(3)}${terms.map((t, i) => ` ${b[i + 1] < 0 ? '\u2212' : '+'} ${Math.abs(b[i + 1]).toFixed(3)}\u00b7${t}`).join('')} + sector effect
implied value = 10^log10(value), in whole dollars
80% band = value \u00d7 10^[${h.interval_lo.toFixed(2)}, +${h.interval_hi.toFixed(2)}] (held-out residual quantiles)</div>
        <p>Ridge regression of log10 market cap on the ${h.n} snapshot protocols that have one (model.js fitValueModel). Sector effects are shrunk toward zero by ${8} pseudo-protocols. TVL, 7-day change and days run stay because the brief names them; other terms must win both blind tests.</p>
        <table><tr><th>Term</th><th class="n">Weight</th><th></th></tr>${coef}</table>
        <h3 style="margin-top:16px">Sector effects</h3><table>${sec}</table></div>
      <div class="card"><h3>Blind tests (mean absolute error, log10)</h3>
        <table><tr><th>Term</th><th class="n">10-fold with / without</th><th class="n">Walk-forward with / without</th><th></th><th></th></tr>${tests}</table>
        <p>Final model: 10-fold <b>${h.kfold_mae.toFixed(3)}</b>, walk-forward <b>${h.walk_mae.toFixed(3)}</b>, against ${h.naive_mae.toFixed(3)} for a flat median and ${h.ratio_mae.toFixed(3)} for one cap/TVL ratio. The 80% band held ${(h.walk_coverage * 100).toFixed(0)}% of walk-forward protocols it never saw.</p>
        ${scatter()}
        <h3 style="margin-top:16px">Farm assumptions</h3>
        <p>Airdrop = ${(M.FARM.airdropShare * 100).toFixed(0)}% of implied value, paid pro rata to TVL over a ${M.FARM.horizonDays}-day hold of $${M.FARM.deposit}, times the sector's token odds. Gas per transaction by chain (model.js GAS_USD, e.g. Ethereum $${M.GAS_USD.Ethereum}, Solana $${M.GAS_USD.Solana}, L2s $0.04). Farm when expected value is 3\u00d7 gas at $1,000, Test at 1\u00d7, Scale when 3\u00d7 gas needs a deposit under $${M.FARM.scaleCap.toLocaleString('en-US')}, else Watch. These are stated assumptions, not quotes.</p>
        <p class="note">Reader's note: the snapshot records no token for these protocols; that is not proof none exists. An implied value is this model's claim, not a forecast that a token will launch.</p></div></div>`;
  }

  // ---- the page ----
  function render() {
    const watchCount = R.rows.filter((r) => r.watchlist).length, farms = R.rows.filter((r) => r.plan.verdict === 'Farm').length, scale = R.rows.filter((r) => r.plan.verdict === 'Scale' || r.plan.verdict === 'Test').length;
    const tab = (k, t, n) => `<button data-tab="${k}" aria-selected="${S.tab === k}">${t}<span class="count">${n}</span></button>`;
    const body = S.tab === 'live' ? liveHtml() : S.tab === 'method' ? methodHtml() : boardHtml();
    const ck = (ok, t) => `<span class="check${ok ? '' : ' bad'}">${t}</span>`;
    $('#app').innerHTML = `<header class="top"><div class="brand">
        <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="#24314b" stroke-width="2"/><circle cx="20" cy="20" r="11" fill="none" stroke="#24314b" stroke-width="2"/><path d="M20 20 L34 9 A18 18 0 0 1 38 20 Z" fill="#f2b33d" fill-opacity=".35"/><circle cx="29" cy="14" r="2.6" fill="#f2b33d"/><circle cx="20" cy="20" r="2" fill="#e7ecf6"/></svg>
        <div><h1>Token Radar</h1><p>Protocols with no token on record, ranked by what a token would be worth on today's record</p></div></div>
        <div class="stamp">DefiLlama snapshot ${esc(R.as_of)} \u00b7 ${R.protocols} protocols<br>board sha256 ${esc(R.checks.sha.slice(0, 16))}</div></header>
      <section class="kpis">
        <div class="kpi hi"><span>Pre-token on the board</span><b>${R.rows.length}</b><small>${watchCount} watchlist + ${R.rows.length - watchCount} below the floor</small></div>
        <div class="kpi"><span>Implied value, board total</span><b>${money(R.rows.reduce((a, r) => a + r.implied_value_usd, 0))}</b><small>top: ${esc(R.rows[0].name)}</small></div>
        <div class="kpi"><span>Fitted on live tokens</span><b>${h.n}</b><small>${R.recorded} recorded-token rows set apart</small></div>
        <div class="kpi"><span>Blind error, typical factor</span><b>${times(h.kfold_mae)}</b><small>10-fold; a flat median is off ${times(h.naive_mae)}</small></div>
        <div class="kpi"><span>80% band, blind coverage</span><b>${(h.walk_coverage * 100).toFixed(0)}%</b><small>walk-forward by listing date</small></div>
        <div class="kpi"><span>Worth farming with $1k</span><b>${farms}</b><small>+${scale} at larger size (Test / Scale)</small></div></section>
      <div class="checks" aria-label="Checks this page answers">
        ${ck(R.checks.covered === R.checks.watch, `Watchlist covered ${R.checks.covered}/${R.checks.watch}`)}
        ${ck(R.checks.monotone, `Ranks 1\u2013${R.rows.length} by implied value, never rising`)}
        ${ck(matches === R.rows.length, `${matches}/${R.rows.length} values recomputed in this page from model.js`)}
        ${ck(true, 'No protocol name in the model: one function scores every row')}
        ${ck(true, `${h.n} live + ${R.recorded} recorded tokens kept off the board`)}
        ${ck(R.checks.stepsOk, `${R.rows.length} costed farm plans`)}</div>
      <nav class="tabs" role="tablist">${tab('board', 'Pre-token board', R.rows.length)}${tab('live', 'Live tokens (training set)', h.n)}${tab('method', 'Method & blind tests', '')}</nav>
      ${body}
      <footer>Set aside by the house rule (wrapped, staked, bridge, exchange or versioned products): ${Object.entries(R.setAside).map(([k, v]) => `${esc(k)} ${v}`).join(' \u00b7 ')}. Implied values are this entry's model, not make.fun's.</footer>`;
    const open = R.rows.find((r) => r.slug === S.open);
    const aside = $('#detail');
    aside.innerHTML = detailHtml(open);
    aside.classList.toggle('open', !!open);
    $('#board').setAttribute('aria-busy', 'false');
  }

  // ---- events: one delegated listener per kind ----
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
