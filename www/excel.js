'use strict';

/* ================================================================
   EXCEL SHEET – the accounts in the same layout as the hand-kept Excel:
   one row per day with Online, Cash, each person's daily cut, Expense,
   Profit (a live Excel formula) and what each owner paid from their own pocket.
   Extra sheets total it by week and by month.

   Computer: the chosen .xlsx file is rewritten a few seconds after every change.
   Phone: "Share Excel" makes the file when asked.
   Loaded before app.js; uses app.js globals only when its functions run.
   ================================================================ */

const excel = (() => {
  const MONEY = '"₹" #,##0.00';
  let libLoading = null, timer = null, writing = false;
  let status = { state: '', at: null };

  // the Excel library is big, so it is only loaded the first time a file is made
  function lib() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    libLoading = libLoading || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/exceljs.min.js';
      s.onload = () => res(window.ExcelJS);
      s.onerror = () => { libLoading = null; rej(new Error('The Excel part of the app is missing')); };
      document.head.appendChild(s);
    });
    return libLoading;
  }

  const cfg = () => Object.assign({ helpers: [], labels: {}, auto: true, path: '' }, S.settings.excel);
  async function setCfg(patch) { S.settings.excel = Object.assign(cfg(), patch); await save(); }

  const firstName = n => String(n || '').trim().split(/\s+/)[0] || '?';
  const label = (c, p) => (c.labels[p.id] || '').trim() || firstName(p.name);

  /* people with their own "Cut" column: owners who share the profit, plus the helpers ticked in Settings */
  function people() {
    const c = cfg();
    return [
      ...S.helpers.filter(h => c.helpers.includes(h.id)).map(h => ({ kind: 'helper', id: h.id, name: h.name, label: label(c, h) })),
      ...S.owners.filter(o => num(o.share) > 0).map(o => ({ kind: 'owner', id: o.id, name: o.name, label: label(c, o) }))
    ];
  }

  function dayValues(d, cols) {
    const sale = S.sales.find(s => s.date === d) || {};
    const own = new Set(cols.filter(p => p.kind === 'helper').map(p => p.id));
    const cuts = cols.map(p => p.kind === 'owner'
      ? sum(S.ownerTx.filter(t => t.type === 'withdraw' && t.ownerId === p.id && t.date === d), t => t.amount)
      : sum(S.helperTx.filter(t => t.type === 'bonus' && t.helperId === p.id && t.date === d), t => t.amount));
    const exps = S.expenses.filter(e => e.date === d);
    // Expense = every expense + bonuses of helpers without their own column + salaries paid that day
    const expense = sum(exps, e => e.amount)
      + sum(S.helperTx.filter(t => t.date === d && t.type === 'bonus' && !own.has(t.helperId)), t => t.amount)
      + sum(S.helperTx.filter(t => t.date === d && (t.type === 'salary' || t.type === 'advance')), t => t.amount);
    const pocket = cols.filter(p => p.kind === 'owner').map(p => sum(exps.filter(e => e.paidBy === p.id), e => e.amount));
    return { online: num(sale.online), cash: num(sale.cash), cuts, expense, pocket };
  }

  function dateRange() {
    const all = [...S.sales, ...S.expenses, ...S.helperTx, ...S.ownerTx].map(x => x.date).filter(Boolean).sort();
    if (!all.length) return [];
    const last = all[all.length - 1] > today() ? all[all.length - 1] : today();
    const out = [];
    for (let d = all[0]; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }

  const xlDate = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };

  function styleHeader(row) {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.alignment = { vertical: 'middle', wrapText: true };
    row.height = 30;
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC2410C' } }; });
  }
  function styleTotal(row) {
    row.font = { bold: true };
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7D7' } }; c.border = { top: { style: 'thin' } }; });
  }

  async function build() {
    const ExcelJS = await lib();
    const wb = new ExcelJS.Workbook();
    wb.creator = S.settings.name;
    wb.created = new Date();
    const cols = people();
    const owners = cols.filter(p => p.kind === 'owner');
    const days = dateRange();

    /* ---- Daily: the same columns as the hand-kept sheet ---- */
    const ws = wb.addWorksheet('Daily', { views: [{ state: 'frozen', ySplit: 1 }] });
    const head = ['Date', 'Online', 'Cash', ...cols.map(p => p.label + ' Cut'), 'Expense', 'Profit', ...owners.map(p => p.label + ' Expenses'), 'Total Expenses'];
    styleHeader(ws.addRow(head));
    const L = i => ws.getColumn(i + 1).letter; // 0-based column -> letter
    const iOnline = 1, iCash = 2, iCut0 = 3, iExp = 3 + cols.length, iProfit = iExp + 1, iPocket0 = iProfit + 1, iTotal = iPocket0 + owners.length;
    const totals = { online: 0, cash: 0, cuts: cols.map(() => 0), expense: 0, pocket: owners.map(() => 0) };
    for (const d of days) {
      const v = dayValues(d, cols);
      const r = ws.rowCount + 1;
      const profit = v.cash + v.online - v.expense - v.cuts.reduce((a, b) => a + b, 0);
      const pocketSum = v.pocket.reduce((a, b) => a + b, 0);
      const cutRefs = cols.map((p, i) => `${L(iCut0 + i)}${r}`);
      ws.addRow([
        xlDate(d), v.online, v.cash, ...v.cuts, v.expense,
        { formula: `(${L(iCash)}${r}+${L(iOnline)}${r})-(${[`${L(iExp)}${r}`, ...cutRefs].join('+')})`, result: profit },
        ...v.pocket,
        owners.length ? { formula: `SUM(${L(iPocket0)}${r}:${L(iPocket0 + owners.length - 1)}${r})`, result: pocketSum } : 0
      ]);
      totals.online += v.online; totals.cash += v.cash; totals.expense += v.expense;
      v.cuts.forEach((x, i) => { totals.cuts[i] += x; });
      v.pocket.forEach((x, i) => { totals.pocket[i] += x; });
    }
    if (days.length) {
      const last = ws.rowCount;
      const sumOf = (i, result) => ({ formula: `SUM(${L(i)}2:${L(i)}${last})`, result });
      const profitTotal = totals.cash + totals.online - totals.expense - totals.cuts.reduce((a, b) => a + b, 0);
      styleTotal(ws.addRow(['Total', sumOf(iOnline, totals.online), sumOf(iCash, totals.cash),
        ...totals.cuts.map((x, i) => sumOf(iCut0 + i, x)), sumOf(iExp, totals.expense), sumOf(iProfit, profitTotal),
        ...totals.pocket.map((x, i) => sumOf(iPocket0 + i, x)), sumOf(iTotal, totals.pocket.reduce((a, b) => a + b, 0))]));
    }
    ws.getColumn(1).numFmt = 'dd-mm-yyyy';
    ws.getColumn(1).width = 13;
    for (let i = 2; i <= head.length; i++) { ws.getColumn(i).numFmt = MONEY; ws.getColumn(i).width = 15; }
    ws.getCell('A1').numFmt = '@';
    ws.autoFilter = { from: 'A1', to: `${L(head.length - 1)}1` };

    /* ---- Weekly and Monthly totals (Monday–Sunday weeks) ---- */
    const summary = (name, keyOf, labelOf) => {
      const sh = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      styleHeader(sh.addRow([name === 'Weekly' ? 'Week' : 'Month', 'Online', 'Cash', 'Total earning', ...cols.map(p => p.label + ' Cut'), 'Expense', 'Profit']));
      const groups = new Map();
      for (const d of days) {
        const k = keyOf(d);
        const g = groups.get(k) || { online: 0, cash: 0, cuts: cols.map(() => 0), expense: 0 };
        const v = dayValues(d, cols);
        g.online += v.online; g.cash += v.cash; g.expense += v.expense;
        v.cuts.forEach((x, i) => { g.cuts[i] += x; });
        groups.set(k, g);
      }
      for (const [k, g] of groups) {
        const cutSum = g.cuts.reduce((a, b) => a + b, 0);
        sh.addRow([labelOf(k), g.online, g.cash, g.online + g.cash, ...g.cuts, g.expense, g.online + g.cash - g.expense - cutSum]);
      }
      sh.getColumn(1).width = 26;
      for (let i = 2; i <= 6 + cols.length; i++) { sh.getColumn(i).numFmt = MONEY; sh.getColumn(i).width = 15; }
    };
    summary('Weekly', weekStart, k => `${shortDate(k)} – ${shortDate(addDays(k, 6))}`);
    summary('Monthly', d => d.slice(0, 7), monthName);

    return wb.xlsx.writeBuffer();
  }

  const fileName = () => `${S.settings.name} ${today()}.xlsx`;

  /* ---------- computer: keep the chosen file up to date ---------- */

  async function writeNow() {
    const c = cfg();
    if (!native || !native.writeExcel || !c.auto || !c.path || writing) return;
    writing = true;
    try {
      const r = await native.writeExcel(c.path, new Uint8Array(await build()));
      status = r === 'ok' ? { state: 'ok', at: new Date() } : { state: r === 'locked' ? 'locked' : 'error', msg: r, at: status.at };
      // Excel keeps the file locked while it is open: try again in a minute
      if (r === 'locked') schedule(60000);
    } catch (e) {
      status = { state: 'error', msg: e.message, at: status.at };
    } finally { writing = false; }
    const card = document.getElementById('excelStatus');
    if (card) card.innerHTML = statusLine();
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(writeNow, ms); }
  function changed() { if (native && cfg().auto) schedule(5000); }

  async function start() {
    if (!native || !native.excelDefault) return;
    if (!cfg().path) { S.settings.excel = Object.assign(cfg(), { path: await native.excelDefault() }); await store.saveState(S); }
    schedule(3000);
  }

  function statusLine() {
    if (status.state === 'ok') return `<span class="pos">Updated at ${status.at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>`;
    if (status.state === 'locked') return '<span class="neg">The file is open in Excel, so it can\'t be updated right now. Close it in Excel and the app will update it within a minute.</span>';
    if (status.state === 'error') return `<span class="neg">Could not update the file: ${esc(status.msg)}</span>`;
    return '<span class="muted">Not written yet</span>';
  }

  /* ---------- Settings card ---------- */

  function card() {
    const c = cfg();
    const cols = people();
    const owners = S.owners.filter(o => num(o.share) > 0);
    const labelBox = p => `<input value="${esc(label(c, p))}" style="width:140px" title="Column name in Excel" ${onChange(el => setCfg({ labels: { ...c.labels, [p.id]: el.value.trim() } }).then(render))}>`;
    const helperRows = S.helpers.map(h => {
      const on = c.helpers.includes(h.id);
      return `<div class="xl-person"><label class="check"><input type="checkbox" ${on ? 'checked' : ''} ${onChange(el => setCfg({ helpers: el.checked ? [...c.helpers, h.id] : c.helpers.filter(x => x !== h.id) }).then(render))}> ${esc(h.name)}</label>
        ${on ? labelBox(h) + '<span class="muted">Cut</span>' : '<span class="muted">bonus goes into Expense</span>'}</div>`;
    }).join('');
    const download = async () => {
      toast('Making the Excel file…');
      try { await saveFile(new Blob([await build()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName()); }
      catch (e) { alert('Could not make the Excel file: ' + e.message); }
    };
    return `<div class="card"><h2>Excel sheet</h2>
      <p class="hint">The same layout as your own sheet: one row per day with Online, Cash, each person's cut, Expense, Profit, and what owners paid from their own pocket – plus weekly and monthly totals.</p>
      ${native ? `
      <label class="check" style="margin-bottom:8px"><input type="checkbox" ${c.auto ? 'checked' : ''} ${onChange(el => setCfg({ auto: el.checked }).then(() => { render(); if (el.checked) schedule(500); }))}> Keep this Excel file updated automatically</label>
      <div class="xl-path">${esc(c.path || '…')}</div>
      <div class="row" style="margin:8px 0">
        <button class="ghost" ${act(async () => { const p = await native.chooseExcel(c.path); if (p) { await setCfg({ path: p }); render(); schedule(300); } })}>Change location…</button>
        <button class="ghost" ${act(async () => { await writeNow(); const r = await native.openExcel(c.path); if (r) alert(r); })}>Open in Excel</button>
        <button class="ghost" ${act(download)}>Save a copy…</button>
      </div>
      <p id="excelStatus" style="margin:0 0 12px">${c.auto ? statusLine() : '<span class="muted">Automatic updates are off.</span>'}</p>`
      : `<div class="row" style="margin-bottom:12px"><button ${act(download)}>${isApp ? 'Share Excel file' : 'Download Excel file'}</button></div>`}
      <b class="muted" style="font-size:12px">Columns for each person's daily cut</b>
      <div class="xl-people">
        ${owners.map(o => `<div class="xl-person"><span class="check">${esc(o.name)} <span class="pill">owner</span></span>${labelBox(o)}<span class="muted">Cut · own expenses</span></div>`).join('')}
        ${helperRows}
      </div>
      <p class="hint" style="margin:8px 0 0">Owners' cut = what they take each day. Tick a helper to give their daily bonus its own column (like "Dad Cut"). Type in a box to change the column name. ${cols.length} cut column${cols.length === 1 ? '' : 's'} now.</p></div>`;
  }

  return { card, changed, start, build, _people: people };
})();
