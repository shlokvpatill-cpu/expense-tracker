'use strict';

/* ================================================================
   N.D. Patil Canteen – Accounts
   Offline app. All data lives in this browser's IndexedDB.
   Use Settings → Backup regularly.
   ================================================================ */

const DB_NAME = 'ndp-canteen';
const DB_VER = 1;
let idb = null;
let S = null; // whole app state (everything except file blobs)

const DEFAULT_CATEGORIES = [
  'Groceries & Raw Material', 'Vegetables', 'Meat and Fish', 'Chapati, Pav & Bhakri', 'Milk & Dairy',
  'Cold Drinks & Beverages', 'Gas / Fuel', 'Electricity', 'Water', 'Rent', 'Repairs & Maintenance',
  'Kitchen Utensils & Equipment', 'Packaging', 'Cleaning', 'License Renewal', 'Transport', 'Miscellaneous'
];

function defaultState() {
  return {
    version: 1,
    settings: { name: 'N.D. Patil Canteen', categories: DEFAULT_CATEGORIES.slice(), lastBackup: null },
    owners: [],         // {id, name, share}
    helpers: [],        // {id, name, phone, salary, from, till}
    vendors: [],        // {id, name, phone, note}
    customers: [],      // {id, name, phone, note}
    items: [],          // {id, name, price}
    sales: [],          // {date, cash, online, note}  – one per day
    itemSales: [],      // {id, date, itemId, name, qty, rate}
    expenses: [],       // {id, date, category, desc, amount, vendorId, paidBy, validTill, note, files[]}
    vendorPayments: [], // {id, date, vendorId, amount, paidBy, mode, note, expenseId}
    helperTx: [],       // {id, date, helperId, type: bonus|advance|salary, amount, month, note}
    ownerTx: [],        // {id, date, ownerId, type: withdraw|share|reimburse, amount, month, note}
    creditTx: [],       // {id, date, customerId, type: credit|payment, amount, mode, note}
    files: []           // {id, name, type, size, date, title, category, link:{type,id}}
  };
}

/* ---------------- storage ----------------
   In the desktop app (window.canteenDesktop from preload.js) data is saved as
   files in Documents\N.D. Patil Canteen Data. Opened in a plain browser, it
   falls back to the browser's IndexedDB.                                    */

const native = window.canteenDesktop || null;
// the Android app (Capacitor) – data stays in its IndexedDB, files are shared out through the share sheet
const isApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (isApp) document.documentElement.classList.add('app');
// phone features (Filesystem, Share, App, SystemBars) – each registered once, on first use
const pluginCache = {};
const plugin = name => (pluginCache[name] = pluginCache[name] || window.Capacitor.registerPlugin(name));

const store = native ? {
  init: async () => {},
  loadState: async () => { const t = await native.loadState(); return t ? JSON.parse(t) : null; },
  saveState: st => native.saveState(JSON.stringify(st)),
  putFile: async (id, blob) => native.putFile(id, new Uint8Array(await blob.arrayBuffer())),
  getFile: async (id, type) => { const b = await native.getFile(id); return b ? new Blob([b], { type }) : null; },
  deleteFile: id => native.deleteFile(id),
  clearFiles: () => native.clearFiles()
} : {
  init: async () => { idb = await openDB(); if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); },
  loadState: () => idbReq('kv', 'readonly', s => s.get('state')),
  saveState: st => idbReq('kv', 'readwrite', s => s.put(st, 'state')),
  putFile: (id, blob) => idbReq('files', 'readwrite', s => s.put({ id, blob })),
  getFile: async id => { const rec = await idbReq('files', 'readonly', s => s.get(id)); return rec ? rec.blob : null; },
  deleteFile: id => idbReq('files', 'readwrite', s => s.delete(id)),
  clearFiles: () => idbReq('files', 'readwrite', s => s.clear())
};

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbReq(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = idb.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

async function save() {
  await store.saveState(S);
  cloud.changed();
  remindersChanged();
  excel.changed();
}

async function loadState() {
  const st = await store.loadState();
  const base = defaultState();
  if (!st) return base;
  // fill any collections added in later versions
  for (const k of Object.keys(base)) if (st[k] === undefined) st[k] = base[k];
  st.settings = Object.assign(base.settings, st.settings);
  return st;
}

async function compressImage(file) {
  if (!file.type.startsWith('image/') || file.size < 350000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) {
    return file;
  }
}

async function addFiles(fileList, meta) {
  const ids = [];
  for (const f of fileList) {
    const blob = await compressImage(f);
    const id = uid();
    await store.putFile(id, blob);
    S.files.push({
      id, name: f.name, type: blob.type || f.type, size: blob.size,
      date: meta.date || today(), title: meta.title || f.name, category: meta.category || 'Other',
      link: meta.link || null, added: new Date().toISOString()
    });
    ids.push(id);
  }
  return ids;
}

async function getBlob(id) {
  const f = find(S.files, id);
  let b = await store.getFile(id, f ? f.type : '');
  // a bill added on the other device: fetch it from the cloud once and keep it here
  if (!b && f && cloud.on()) {
    b = await cloud.download(id, f.type);
    if (b) await store.putFile(id, b);
  }
  return b;
}

async function deleteFiles(ids) {
  if (!ids || !ids.length) return;
  for (const id of ids) {
    // while "Undo" is offered, the photo itself is kept; it goes when the offer ends
    if (pendingFileDeletes) { pendingFileDeletes.push(id); continue; }
    await store.deleteFile(id);
    if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
  }
  S.files = S.files.filter(f => !ids.includes(f.id));
  for (const e of S.expenses) if (e.files) e.files = e.files.filter(x => !ids.includes(x));
}

/* ---------------- utils ---------------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const thisMonth = () => today().slice(0, 7);
const addDays = (s, n) => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthEnd = ym => `${ym}-${pad(daysInMonth(ym))}`;
const fmtDate = s => s ? new Date(s + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const fmtDay = s => new Date(s + 'T00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = ym => new Date(ym + '-01T00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const monthShort = ym => new Date(ym + '-01T00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
const num = v => +v || 0;
const sum = (arr, f) => arr.reduce((a, x) => a + num(f(x)), 0);
const round2 = n => Math.round(n * 100) / 100;

function money(n) {
  n = round2(num(n));
  // paise only matter on small amounts; big totals read better in whole rupees
  const s = '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
  return n < 0 ? '-' + s : s;
}
function shortMoney(n) {
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (a >= 1e3) return sign + '₹' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return sign + '₹' + Math.round(a);
}
const signCls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const byDateDesc = (a, b) => -byDate(a, b);
const find = (arr, id) => arr.find(x => x.id === id);
const nameOf = (arr, id, fallback = '—') => { const x = find(arr, id); return x ? x.name : fallback; };

/* hand a file to the user: a download on the computer, the share sheet on the phone
   (save to Drive / Files, send on WhatsApp, open in a PDF viewer…) */
async function saveFile(blob, name) {
  if (isApp) {
    const Filesystem = plugin('Filesystem'), Share = plugin('Share');
    const data = (await blobToDataURL(blob)).split(',')[1];
    const r = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
    try { await Share.share({ title: name, files: [r.uri] }); } catch (e) { /* share sheet closed */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------------- event plumbing ----------------
   act(fn)     -> attribute string for click handlers
   onSubmit()  -> attribute string for form submit handlers
   onChange()  -> attribute string for change handlers           */

let handlers = {};
let hN = 0;
const reg = fn => { const k = 'h' + (++hN); handlers[k] = fn; return k; };
const act = fn => `data-act="${reg(fn)}"`;
const onChange = fn => `data-change="${reg(fn)}"`;
const onInput = fn => `data-input="${reg(fn)}"`;

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && handlers[el.dataset.act]) { e.preventDefault(); handlers[el.dataset.act](el, e); }
});
/* clickable rows and tiles (not real buttons) can be reached with Tab and opened with Enter or Space */
const NATIVE_CLICK = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
function enhanceClickables(root) {
  // filter boxes write their label next to the box: tie the two together
  root.querySelectorAll('.field > label:not([for])').forEach(l => {
    const c = l.nextElementSibling;
    if (!c || !['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName) || c.type === 'file') return;
    if (!c.id) c.id = 'fld' + (++fieldN);
    l.htmlFor = c.id;
  });
  root.querySelectorAll('[data-act]').forEach(el => {
    if (NATIVE_CLICK.includes(el.tagName) || el.hasAttribute('tabindex')) return;
    el.tabIndex = 0;
    // a table row stays a row (it has its own Edit / ✕ buttons inside); tiles become buttons
    if (el.tagName !== 'TR') el.setAttribute('role', 'button');
  });
}
document.addEventListener('keydown', e => {
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.dataset && el.dataset.act && !NATIVE_CLICK.includes(el.tagName)) {
    e.preventDefault();
    el.click();
  }
});
document.addEventListener('submit', async e => {
  const el = e.target.closest('[data-submit]');
  if (!el || !handlers[el.dataset.submit]) return;
  e.preventDefault();
  const btn = el.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try { await handlers[el.dataset.submit](el); }
  catch (err) { console.error(err); alert('Could not save: ' + err.message); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && handlers[el.dataset.change]) handlers[el.dataset.change](el, e);
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el && handlers[el.dataset.input]) handlers[el.dataset.input](el, e);
});
document.addEventListener('keydown', e => {
  const modalForm = document.querySelector('.modal form[data-submit]');
  if (e.key === 'Escape' && document.querySelector('.modal')) { e.preventDefault(); requestClose(); return; }
  // Ctrl+Enter saves whatever form is open in the popup
  if (e.key === 'Enter' && e.ctrlKey && modalForm) { e.preventDefault(); modalForm.requestSubmit(); return; }
  // Ctrl+1 … Ctrl+9, Ctrl+0 open the pages in the order of the side menu
  if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key) && !document.querySelector('.modal')) {
    const links = [...document.querySelectorAll('#nav a')];
    const a = links[e.key === '0' ? 9 : +e.key - 1];
    if (a) { e.preventDefault(); location.hash = a.getAttribute('href').slice(1); }
    return;
  }
  // Ctrl+E adds expenses (for the day open on Daily Entry, otherwise today); Ctrl+N is the page's own "+ Add" button
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'e' || e.key === 'E') && !document.querySelector('.modal')) {
    e.preventDefault();
    bulkExpenseModal({ date: currentRoute === 'daily' ? UI.date : today() });
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N') && !document.querySelector('.modal')) {
    const add = { daily: () => bulkExpenseModal({ date: UI.date }), expenses: () => expenseModal(), vendors: () => vendorModal(), helpers: () => helperModal(),
      owners: () => ownerModal(), credit: () => customerModal(), items: () => itemModal(), bills: () => uploadDocModal() }[currentRoute];
    if (add) { e.preventDefault(); add(); }
    return;
  }
  // Alt+← / Alt+→ moves between days on the Daily Entry page
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && currentRoute === 'daily' && !document.querySelector('.modal')) {
    e.preventDefault();
    UI.date = addDays(UI.date, e.key === 'ArrowLeft' ? -1 : 1);
    render();
  }
});
// clicking anywhere on a date box opens the calendar, not just the small icon
document.addEventListener('click', e => {
  const el = e.target;
  if (el.tagName === 'INPUT' && (el.type === 'date' || el.type === 'month') && !el.disabled && el.showPicker) {
    try { el.showPicker(); } catch (err) { /* already open */ }
  }
});
// stop the mouse wheel from silently changing an amount while scrolling the page
document.addEventListener('wheel', e => {
  const el = document.activeElement;
  if (el && el.type === 'number' && e.target === el) el.blur();
}, { passive: true });
// phone photo / file buttons show how many files were picked
document.addEventListener('change', e => {
  const lbl = e.target.closest && e.target.closest('.file-pick');
  if (!lbl) return;
  const n = e.target.files.length;
  lbl.classList.toggle('has', n > 0);
  lbl.firstChild.textContent = lbl.firstChild.textContent.replace(/ \(\d+\)$/, '') + (n ? ` (${n})` : '');
});
// remember that something was typed in a popup, so it is not closed by accident
document.addEventListener('input', e => {
  const m = e.target.closest && e.target.closest('.modal');
  if (m) m.dataset.dirty = '1';
});

/* ---------------- forms ---------------- */

let fieldN = 0;
function fieldHTML(f) {
  const v = f.value == null ? '' : f.value;
  // each box gets an id so its label is linked to it (tapping the label focuses the box, screen readers read it)
  const id = 'fld' + (++fieldN);
  const req = (f.required ? 'required' : '') + ` id="${id}"`;
  if (f.type === 'checkbox') return `<div class="field ${f.cls || ''}"><label class="check"><input type="checkbox" name="${f.name}" id="${id}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>
    ${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</div>`;
  let input;
  if (f.type === 'select') {
    input = `<select name="${f.name}" ${req}>${f.options.map(o =>
      `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
  } else if (f.type === 'file') {
    input = isApp
      ? `<div class="row" style="gap:8px"><label class="btn ghost file-pick">📷 Take photo<input type="file" name="${f.name}" accept="image/*" capture="environment" hidden></label>
         <label class="btn ghost file-pick">🖼️ Choose files<input type="file" name="${f.name}" multiple accept="image/*,application/pdf" hidden></label></div>`
      : `<input type="file" name="${f.name}" id="${id}" multiple accept="image/*,application/pdf">`;
  } else if (f.type === 'money') {
    input = `<input type="number" name="${f.name}" value="${esc(v)}" step="any" min="0" inputmode="decimal" placeholder="${esc(f.placeholder || '0')}" ${f.enterNext ? 'data-enter-next' : ''} ${req}>`;
  } else {
    const t = f.type || 'text';
    input = `<input type="${t}" name="${f.name}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${t === 'number' ? 'step="any" inputmode="decimal"' : ''} ${t === 'tel' ? 'inputmode="tel" autocomplete="tel"' : ''} ${t === 'text' ? 'autocomplete="off"' : ''} ${req}>`;
  }
  // file pickers on the phone are two buttons, so their label is not tied to one box
  const forAttr = f.type === 'file' && isApp ? '' : ` for="${id}"`;
  return `<div class="field ${f.cls || ''}"><label${forAttr}>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}</div>`;
}

function readForm(form, fields) {
  const o = {};
  for (const f of fields) {
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'checkbox') o[f.name] = el.checked;
    else if (f.type === 'file') o[f.name] = (el.files ? [el] : [...el]).flatMap(x => [...x.files]); // phone has a camera box too
    else if (f.type === 'money' || f.type === 'number') o[f.name] = f.raw ? el.value.trim() : num(el.value);
    else o[f.name] = el.value.trim();
  }
  return o;
}

/* Inline (one-line) form. flowKey links it to formFlow[flowKey] (see below). */
function inlineForm(fields, submitLabel, onSave, flowKey) {
  const k = reg(async form => {
    const d = readForm(form, fields);
    if (await onSave(d, form) === false) return;
    if (flowKey) resumeAfterRender = { key: flowKey, d };
    render();
  });
  return `<form class="row" data-submit="${k}" ${flowKey ? `data-form="${flowKey}"` : ''}>${fields.map(fieldHTML).join('')}
    <button type="submit">${esc(submitLabel)}</button></form>`;
}

/* ---------- typing flow ----------
   Picking from a list jumps to the next box, so a form can be filled without the mouse.
   A form can also have a formFlow entry: pick(select, form) runs when something is picked
   (e.g. fill in that person's usual amount) and resume(form, saved) runs after "Add",
   once the page is redrawn (e.g. move on to the next person).                       */
const formFlow = {};
let resumeAfterRender = null;

function nextField(el) {
  const els = [...el.form.elements].filter(x => !x.disabled && x.type !== 'hidden' && x.offsetParent !== null);
  return els[els.indexOf(el) + 1];
}
function focusField(el) {
  if (!el) return;
  el.focus();
  if (el.tagName === 'INPUT' && el.select) el.select();
}
// arrow keys / typing letters on a closed list change it one step at a time: don't jump away then
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' && e.key !== 'Enter' && e.key !== 'Tab') e.target.dataset.kbAt = Date.now();
  // Enter on a list, or on a box marked enterNext (e.g. Cash), moves on instead of saving
  if (e.key === 'Enter' && !e.ctrlKey && e.target.form && !e.target.closest('.bulk-row') &&
      (e.target.tagName === 'SELECT' || e.target.hasAttribute('data-enter-next'))) {
    e.preventDefault();
    focusField(nextField(e.target));
    return;
  }
  // in a popup form, Enter goes to the next box; on the last box it saves
  const t = e.target;
  if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && t.tagName === 'INPUT' && t.form && t.closest('.modal') && !t.closest('.bulk-row') &&
      !['checkbox', 'radio', 'file', 'submit', 'button'].includes(t.type)) {
    const n = nextField(t);
    if (n && n.tagName !== 'BUTTON' && n.type !== 'file') { e.preventDefault(); focusField(n); }
  }
}, true);
document.addEventListener('change', e => {
  const el = e.target;
  if (el.tagName !== 'SELECT' || !el.form || el.dataset.change || el.closest('.bulk-row')) return;
  const flow = formFlow[el.form.dataset.form];
  if (flow && flow.pick) flow.pick(el, el.form);
  if (Date.now() - (+el.dataset.kbAt || 0) < 400) return;
  focusField(nextField(el));
});
// clicking into an amount selects it, so typing replaces the old number
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el.tagName === 'INPUT' && el.type === 'number') setTimeout(() => { try { el.select(); } catch (err) { /* not selectable */ } });
});

// move the cursor to another part of the page (the next section of Daily Entry)
function goTo(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  focusField(el);
  return true;
}

function resumeFlow() {
  if (!resumeAfterRender) return;
  const r = resumeAfterRender;
  resumeAfterRender = null;
  const form = document.querySelector(`form[data-form="${r.key}"]`);
  const flow = formFlow[r.key];
  if (form && flow && flow.resume) flow.resume(form, r.d);
}

/* a "person + amount" form that remembers each person's last amount and, after Add,
   moves to the next person who has no entry yet that day */
function personFlow(key, idField, lastAmount, doneToday, people, whenAllDone) {
  const fill = (form, id) => { const a = lastAmount(id); form.elements.amount.value = a || ''; };
  formFlow[key] = {
    pick: (sel, form) => { if (sel.name === idField) fill(form, sel.value); },
    resume: (form, saved) => {
      const done = doneToday();
      const ids = people.map(p => p.id);
      const start = ids.indexOf(saved[idField]);
      const next = [...ids.slice(start + 1), ...ids.slice(0, Math.max(start, 0))].find(id => !done.has(id));
      if (!next) { toast('Everyone is done for today'); if (whenAllDone) whenAllDone(); return; }
      form.elements[idField].value = next;
      fill(form, next);
      focusField(form.elements.amount);
    }
  };
  // when the page opens, start at the first person who has no entry yet
  const first = people.find(p => !doneToday().has(p.id));
  return first ? { id: first.id, amount: lastAmount(first.id) || '' } : { id: people[0] && people[0].id, amount: '' };
}

/* ---------------- modal ---------------- */

function openModal(html, size) {
  const cls = size === true ? 'big' : size || '';
  document.getElementById('modalRoot').innerHTML =
    `<div class="modal-bg"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const modal = document.querySelector('#modalRoot .modal');
  const h = modal.querySelector('h3');
  if (h) { h.id = 'modalTitle'; modal.setAttribute('aria-labelledby', 'modalTitle'); }
  enhanceClickables(modal);
  const first = document.querySelector('.modal input:not([type=file]):not([type=date]), .modal select');
  if (first) first.focus();
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
function requestClose() {
  const m = document.querySelector('.modal');
  if (m && m.dataset.dirty && !confirm('Close without saving? What you typed will be lost.')) return;
  closeModal();
}

function formModal({ title, fields, submit = 'Save', onSave, after, note = '' }) {
  const k = reg(async form => {
    const d = readForm(form, fields);
    if (await onSave(d, form) === false) return;
    closeModal();
    toast('Saved');
    render();
    if (after) after();
  });
  openModal(`<h3>${esc(title)}</h3>${note}
    <form data-submit="${k}"><div class="row">${fields.map(fieldHTML).join('')}</div>
    <div class="actions"><button type="button" class="ghost" ${act(requestClose)}>Cancel</button>
    <button type="submit">${esc(submit)}</button></div></form>`);
}

/* ---------- delete with Undo ----------
   Deleting happens straight away, with an "Undo" button for a few seconds instead of an
   "Are you sure?" question. Undo puts back only what the delete removed, so anything
   entered in the meantime is kept. */
let pendingFileDeletes = null, undoOffer = null;
const LIST_KEYS = ['owners', 'helpers', 'vendors', 'customers', 'items', 'sales', 'itemSales', 'expenses',
  'vendorPayments', 'helperTx', 'ownerTx', 'creditTx', 'files'];
const recKey = x => x.id || x.date;
async function endUndoOffer() {
  const o = undoOffer;
  if (!o) return;
  undoOffer = null;
  clearTimeout(o.timer);
  if (o.el.isConnected) o.el.remove();
  // the offer is over: now the bill photos of deleted entries really go
  const keep = new Set(S.files.map(f => f.id));
  for (const id of o.files) if (!keep.has(id)) {
    await store.deleteFile(id);
    if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
  }
}
async function undoable(what, fn, after) {
  await endUndoOffer();
  const before = {};
  for (const k of LIST_KEYS) before[k] = JSON.parse(JSON.stringify(S[k] || []));
  pendingFileDeletes = [];
  try { await fn(); } finally { var files = pendingFileDeletes; pendingFileDeletes = null; }
  await save();
  render();
  if (after) after();
  const el = document.createElement('div');
  el.className = 'toast undo';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>Deleted ${esc(what)}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'link'; btn.textContent = 'Undo';
  btn.addEventListener('click', async () => {
    if (!undoOffer || undoOffer.el !== el) return;
    undoOffer.files = []; // nothing to remove: it is all coming back
    for (const k of LIST_KEYS) {
      const now = S[k] || (S[k] = []);
      const byKey = new Map(now.map(x => [recKey(x), x]));
      for (const old of before[k]) {
        const cur = byKey.get(recKey(old));
        if (!cur) now.push(old);
        else if (JSON.stringify(cur) !== JSON.stringify(old)) Object.assign(cur, old); // e.g. a bill list that lost a photo
      }
    }
    await endUndoOffer();
    await save();
    render();
    if (after) after();
    toast('Put back');
  });
  el.appendChild(btn);
  document.querySelectorAll('.toast').forEach(t => t.remove());
  document.body.appendChild(el);
  undoOffer = { el, files, timer: setTimeout(endUndoOffer, 8000) };
}
const confirmDel = (what, fn, after) => undoable(what, fn, after);

/* ---------------- option lists ---------------- */

const catOptions = () => S.settings.categories.map(c => ({ value: c, label: c }));
const vendorOptions = (blank = '— Not a vendor bill —') =>
  [{ value: '', label: blank }, ...S.vendors.slice().sort((a, b) => a.name.localeCompare(b.name)).map(v => ({ value: v.id, label: v.name }))];
const paidByOptions = () => [{ value: 'business', label: 'Business money (counter / bank)' },
  ...S.owners.map(o => ({ value: o.id, label: `${o.name}'s own pocket` }))];
const ownerOptions = () => S.owners.map(o => ({ value: o.id, label: o.name }));
const helperOptions = () => S.helpers.map(h => ({ value: h.id, label: h.name }));
const customerOptions = () => S.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ value: c.id, label: c.name }));
const modeOptions = () => [{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'Online / UPI' }];
const paidByLabel = p => p === 'business' || !p ? 'Business' : nameOf(S.owners, p, 'Owner') + ' (pocket)';

/* ================================================================
   CALCULATIONS
   ================================================================ */

const helperActiveInMonth = (h, ym) => (!h.from || h.from.slice(0, 7) <= ym) && (!h.till || h.till.slice(0, 7) >= ym);
/* Salary is a cost on the day it is actually paid (salary or advance),
   not spread over the days of the month. */
const salaryPaid = (from, to) => sum(S.helperTx.filter(t => (t.type === 'salary' || t.type === 'advance') && t.date >= from && t.date <= to), t => t.amount);

function figures(from, to) {
  const inR = d => d >= from && d <= to;
  const sales = S.sales.filter(s => inR(s.date));
  const cash = sum(sales, s => s.cash);
  const online = sum(sales, s => s.online);
  // an old balance a customer owed before the app is not a sale of that day
  const credit = sum(S.creditTx.filter(t => t.type === 'credit' && !t.opening && inR(t.date)), t => t.amount);
  const creditRecv = sum(S.creditTx.filter(t => t.type === 'payment' && inR(t.date)), t => t.amount);
  const exps = S.expenses.filter(e => inR(e.date));
  const expenses = sum(exps, e => e.amount);
  const byCat = {};
  for (const e of exps) byCat[e.category] = (byCat[e.category] || 0) + num(e.amount);
  const bonus = sum(S.helperTx.filter(t => t.type === 'bonus' && inR(t.date)), t => t.amount);
  const salary = salaryPaid(from, to);
  const business = cash + online + credit;
  const net = business - expenses - bonus - salary;
  const withdrawals = S.ownerTx.filter(t => t.type === 'withdraw' && inR(t.date));
  const withdrawn = sum(withdrawals, t => t.amount);
  return { cash, online, credit, creditRecv, business, expenses, byCat, bonus, salary, net, withdrawn, withdrawals, days: sales.length };
}
const dayFigures = d => figures(d, d);
const monthFigures = ym => figures(ym + '-01', monthEnd(ym));

function ownerShares(ym) {
  const f = monthFigures(ym);
  const remaining = f.net - f.withdrawn;
  return {
    f, remaining,
    rows: S.owners.map(o => {
      const drawn = sum(f.withdrawals.filter(t => t.ownerId === o.id), t => t.amount);
      const share = remaining * num(o.share) / 100;
      const sharePaid = sum(S.ownerTx.filter(t => t.type === 'share' && t.ownerId === o.id && t.month === ym), t => t.amount);
      return { o, drawn, share, sharePaid, shareDue: share - sharePaid, total: drawn + share };
    })
  };
}

function vendorBalance(vid) {
  const billed = sum(S.expenses.filter(e => e.vendorId === vid), e => e.amount);
  const pays = S.vendorPayments.filter(p => p.vendorId === vid);
  const paid = sum(pays, p => p.amount);
  return { billed, paid, pending: billed - paid };
}

function ownerPocket(oid) {
  const exps = S.expenses.filter(e => e.paidBy === oid && !e.vendorId);
  const vpays = S.vendorPayments.filter(p => p.paidBy === oid);
  const spent = sum(exps, e => e.amount) + sum(vpays, p => p.amount);
  const repaid = sum(S.ownerTx.filter(t => t.type === 'reimburse' && t.ownerId === oid), t => t.amount);
  return { spent, repaid, unpaid: spent - repaid, exps, vpays };
}

function customerBalance(cid) {
  const tx = S.creditTx.filter(t => t.customerId === cid);
  const credit = sum(tx.filter(t => t.type === 'credit'), t => t.amount);
  const paid = sum(tx.filter(t => t.type === 'payment'), t => t.amount);
  const lastPay = tx.filter(t => t.type === 'payment').sort(byDateDesc)[0];
  return { credit, paid, pending: credit - paid, lastPay, count: tx.length };
}

function helperMonth(h, ym) {
  const tx = S.helperTx.filter(t => t.helperId === h.id);
  const salary = helperActiveInMonth(h, ym) ? num(h.salary) : 0;
  const bonus = sum(tx.filter(t => t.type === 'bonus' && t.date.startsWith(ym)), t => t.amount);
  const paid = sum(tx.filter(t => t.type !== 'bonus' && (t.month || t.date.slice(0, 7)) === ym), t => t.amount);
  return { salary, bonus, paid, due: salary - paid };
}

/* ================================================================
   CHART
   ================================================================ */

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

const PROFIT = '#16a34a', LOSS = '#dc2626';
let chartN = 0;

/* Line chart. points: [{label, short, values:[...]}]; series: [{name, color, signed}]
   A "signed" series is drawn green above zero and red below it. */
const phone = window.matchMedia('(max-width: 760px)');
// touch screens have no hover: tapping a point on a graph shows its figures
document.addEventListener('click', e => {
  const r = e.target.closest && e.target.closest('.chart [data-tip]');
  if (r && (isApp || phone.matches)) toast(r.dataset.tip);
});

function lineChart(points, series, { height = 240 } = {}) {
  if (!points.length) return '<div class="empty">No data yet</div>';
  // on a phone the chart is drawn narrower, so the labels stay readable
  const small = phone.matches;
  const W = small ? 400 : 780, H = height, pl = small ? 46 : 58, pr = small ? 10 : 14, pt = 12, pb = 30;
  const all = points.flatMap(p => p.values);
  let max = Math.max(0, ...all), min = Math.min(0, ...all);
  if (max === min) max = 1000;
  const step = niceStep((max - min) / 4);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const y = v => pt + (max - v) / (max - min) * (H - pt - pb);
  const n = points.length, span = W - pl - pr;
  const x = i => n === 1 ? pl + span / 2 : pl + i * span / (n - 1);
  const y0 = y(0), id = 'ch' + (++chartN);
  let out = `<defs><clipPath id="${id}p"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>
    <clipPath id="${id}n"><rect x="0" y="${y0}" width="${W}" height="${H - y0}"/></clipPath></defs>`;
  for (let v = min; v <= max + step / 2; v += step) {
    out += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'ax-zero' : 'ax-grid'}" />
      <text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" class="ax-text">${shortMoney(v)}</text>`;
  }
  series.forEach((s, si) => {
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.values[si]).toFixed(1)}`).join(' ');
    if (s.signed) {
      const area = `${line} L${x(n - 1).toFixed(1)},${y0} L${x(0).toFixed(1)},${y0} Z`;
      out += `<path d="${area}" fill="${PROFIT}" opacity=".13" clip-path="url(#${id}p)"/>
        <path d="${area}" fill="${LOSS}" opacity=".13" clip-path="url(#${id}n)"/>
        <path d="${line}" fill="none" stroke="${PROFIT}" stroke-width="2.2" stroke-linejoin="round" clip-path="url(#${id}p)"/>
        <path d="${line}" fill="none" stroke="${LOSS}" stroke-width="2.2" stroke-linejoin="round" clip-path="url(#${id}n)"/>`;
    } else {
      out += `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    }
    if (n <= 62) {
      points.forEach((p, i) => {
        const v = p.values[si];
        out += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 31 ? 2 : 3}" fill="${s.signed ? (v >= 0 ? PROFIT : LOSS) : s.color}"/>`;
      });
    }
  });
  // one invisible column per point, so hovering anywhere near it shows its values
  const colW = n === 1 ? span : span / (n - 1);
  points.forEach((p, i) => {
    const tip = [p.label, ...series.map((s, si) => `${s.name}: ${money(p.values[si])}`)].join('\n');
    out += `<rect x="${(x(i) - colW / 2).toFixed(1)}" y="${pt}" width="${colW.toFixed(1)}" height="${H - pt - pb}" fill="transparent" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  });
  const every = Math.ceil(n / (small ? 6 : 12));
  points.forEach((p, i) => {
    // the last label is right-aligned so it is not cut off at the edge
    const anchor = n > 1 && i === n - 1 ? 'end' : 'middle';
    if (i % every === 0) out += `<text x="${(anchor === 'end' ? x(i) + 4 : x(i)).toFixed(1)}" y="${H - 10}" text-anchor="${anchor}" font-size="11" class="ax-text">${esc(p.short || p.label)}</text>`;
  });
  const legend = `<div class="legend">${series.map(s => s.signed
    ? `<span><i style="background:${PROFIT}"></i>Profit</span><span><i style="background:${LOSS}"></i>Loss</span>`
    : `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(', '))} chart">${out}</svg>${legend}`;
}

const weekStart = d => addDays(d, -((new Date(d + 'T00:00').getDay() + 6) % 7)); // Monday
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5) + 1;
const shortDate = d => new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const dayLabel = d => new Date(d + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const autoGroup = (from, to) => { const n = daysBetween(from, to); return n <= 62 ? 'day' : n <= 400 ? 'week' : 'month'; };

/* Figures for each day / week / month between two dates, ready for a chart or a table. */
function periodPoints(from, to, group, value = f => [round2(f.net)]) {
  const pts = [];
  const push = (a, b, label, short) => { const f = figures(a, b); pts.push({ from: a, to: b, date: a, label, short, f, values: value(f) }); };
  if (group === 'day') {
    const oneMonth = from.slice(0, 7) === to.slice(0, 7);
    for (let d = from; d <= to; d = addDays(d, 1)) push(d, d, dayLabel(d), oneMonth ? String(+d.slice(8)) : shortDate(d));
  } else if (group === 'week') {
    for (let s = weekStart(from); s <= to; s = addDays(s, 7)) {
      const a = s < from ? from : s, e = addDays(s, 6), b = e > to ? to : e;
      push(a, b, `${fmtDate(a)} – ${fmtDate(b)}`, shortDate(a));
    }
  } else {
    for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = addMonths(ym, 1)) {
      const a = ym + '-01' < from ? from : ym + '-01', b = monthEnd(ym) > to ? to : monthEnd(ym);
      push(a, b, monthName(ym), monthShort(ym));
    }
  }
  return pts;
}

/* ================================================================
   UI STATE + ROUTER
   ================================================================ */

const UI = {
  date: today(),
  month: thisMonth(),
  expFilter: { cat: '', paidBy: '', vendor: '', q: '' },
  billFilter: { cat: '', q: '' },
  expPeriod: newPeriod(),
  vendorPeriod: newPeriod(),
  creditPeriod: newPeriod(),
  itemPeriod: newPeriod(),
  billPeriod: newPeriod('all'),
  itemDate: today(),
  reportYear: String(new Date().getFullYear()),
  ownerMonth: thisMonth(),
  helperMonth: thisMonth(),
  rep: { mode: 'month', week: today(), from: addDays(today(), -29), to: today(), group: 'auto', show: 'profit' }
};

const ROUTES = {
  dashboard: ['Dashboard', pageDashboard],
  daily: ['Daily Entry', pageDaily],
  expenses: ['Expenses', pageExpenses],
  vendors: ['Vendors', pageVendors],
  helpers: ['Helpers', pageHelpers],
  owners: ['Owners', pageOwners],
  credit: ['Customer Credit', pageCredit],
  items: ['Item Sales', pageItems],
  bills: ['Bills & Documents', pageBills],
  reports: ['Profit Reports', pageReports],
  settings: ['Settings & Backup', pageSettings]
};

let currentRoute = '';
function setTools(html) { document.getElementById('pageTools').innerHTML = html; }

function render() {
  const r = ROUTES[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  if (r !== currentRoute) { currentRoute = r; if (!document.querySelector('.modal')) { handlers = {}; } window.scrollTo(0, 0); }
  const [title, fn] = ROUTES[r];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('brandName').textContent = S.settings.name;
  applyTheme();
  document.title = S.settings.name + ' – ' + title;
  setTools('');
  document.getElementById('view').innerHTML = fn();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + r));
  document.getElementById('sidebar').classList.remove('open');
  document.body.classList.toggle('daybar-on', r === 'daily');
  enhanceClickables(document.querySelector('.main'));
  loadThumbs();
  // Daily Entry: start typing straight away in Cash (not on phones, where it would pop up the keyboard)
  if (r !== 'daily') UI.focusedDay = null;
  else if (UI.focusedDay !== UI.date && !isApp && !phone.matches && !document.querySelector('.modal') && !resumeAfterRender) {
    UI.focusedDay = UI.date;
    focusField(document.querySelector('form[data-form=sales] [name=cash]'));
  }
  resumeFlow();
}

/* theme: 'system' follows Windows, or 'light' / 'dark' */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (S.settings.theme || 'light') === 'system' ? darkQuery.matches : S.settings.theme === 'dark';
let appliedTheme = null;
function applyTheme() {
  const t = S.settings.theme || 'light';
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.toggle('hide-hints', !!S.settings.hideHints);
  if (t !== appliedTheme && native && native.setTheme) native.setTheme(t);
  appliedTheme = t;
  // window / browser bar colour matches the page background of the theme in use
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? '#111418' : '#f4f5f7';
  // phone status bar: dark icons on the light theme, light icons on the dark theme
  if (isApp) plugin('SystemBars').setStyle({ style: isDark() ? 'DARK' : 'LIGHT' }).catch(() => {});
}
async function setTheme(t) {
  S.settings.theme = t;
  applyTheme();
  await save();
  render();
}
darkQuery.addEventListener('change', () => { if (S) applyTheme(); });

window.addEventListener('hashchange', render);
// side menu shows its Ctrl+number shortcut (computer only)
if (!isApp) document.querySelectorAll('#nav a').forEach((a, i) => { if (i < 10) a.insertAdjacentHTML('beforeend', `<span class="key">Ctrl+${(i + 1) % 10}</span>`); });
document.getElementById('menuBtn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
// tapping outside the open menu on a phone closes it
document.addEventListener('click', e => {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('open') && !sb.contains(e.target) && !e.target.closest('#menuBtn')) sb.classList.remove('open');
});

// Android back button: close the popup or menu first, then go back a page, then leave the app
if (isApp) {
  plugin('App').addListener('backButton', () => {
    const sb = document.getElementById('sidebar');
    if (document.querySelector('.modal')) requestClose();
    else if (sb.classList.contains('open')) sb.classList.remove('open');
    else if (currentRoute !== 'dashboard') { if (history.length > 1) history.back(); else location.hash = 'dashboard'; }
    else plugin('App').exitApp();
  });
}

/* shared bits */
function monthPicker(value, onPick) {
  return `<div class="row no-print">
    <button class="ghost" aria-label="Previous month" ${act(() => onPick(addMonths(value, -1)))}>‹</button>
    <input type="month" aria-label="Month" value="${value}" style="width:160px" ${onChange(el => el.value && onPick(el.value))}>
    <button class="ghost" aria-label="Next month" ${act(() => onPick(addMonths(value, 1)))}>›</button></div>`;
}

/* a warning strip with a ✕; closing it hides that warning on this device for the rest of the day */
const hiddenNotices = (() => { try { return JSON.parse(localStorage.getItem('ndp-hidden-notices')) || {}; } catch (e) { return {}; } })();
function notice(id, cls, html) {
  if (hiddenNotices[id] === today()) return '';
  return `<div class="alert ${cls}"><span>${html}</span><button class="alert-x" title="Hide for today" aria-label="Close" ${act(() => {
    hiddenNotices[id] = today();
    for (const k of Object.keys(hiddenNotices)) if (hiddenNotices[k] !== today()) delete hiddenNotices[k];
    try { localStorage.setItem('ndp-hidden-notices', JSON.stringify(hiddenNotices)); } catch (e) { /* storage blocked */ }
    render();
  })}>✕</button></div>`;
}

function stat(label, value, cls = '', sub = '') {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function fileChips(ids) {
  if (!ids || !ids.length) return '';
  return `<div class="chips">${ids.map(id => {
    const f = find(S.files, id);
    return f ? `<button class="chip" ${act(() => viewFile(id))}>📎 ${esc(f.name.length > 18 ? f.name.slice(0, 16) + '…' : f.name)}</button>` : '';
  }).join('')}</div>`;
}

function table(headers, rows, emptyMsg = 'Nothing here yet') {
  const th = headers.map(h => typeof h === 'string' ? `<th>${h}</th>` : `<th class="${h.cls || ''}">${h.t}</th>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows.length ? rows.join('')
    : `<tr><td colspan="${headers.length}" class="empty">${emptyMsg}</td></tr>`}</tbody></table></div>`;
}

/* ================================================================
   DASHBOARD
   ================================================================ */

function pageDashboard() {
  const t = today(), ym = thisMonth();
  const d = dayFigures(t);
  const m = figures(ym + '-01', t);
  const vendorList = S.vendors.map(v => ({ v, pending: vendorBalance(v.id).pending })).filter(x => x.pending > 0).sort((a, b) => b.pending - a.pending);
  const vendorPending = sum(vendorList, x => x.pending);
  const owing = owingCustomers();
  const creditPending = sum(owing, x => x.pending);
  const ownerUnpaid = sum(S.owners, o => Math.max(0, ownerPocket(o.id).unpaid));
  const dueHelpers = S.helpers.map(h => helperMonth(h, ym)).filter(x => x.due > 0);
  const helperDue = sum(dueHelpers, x => x.due);
  const saleToday = S.sales.find(s => s.date === t);
  const expsToday = S.expenses.filter(e => e.date === t).length;
  const goDaily = () => { UI.date = t; location.hash = 'daily'; };
  const names = list => list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /* --- today: the one big number, then where the money came from and went --- */
  const costs = d.expenses + d.bonus + d.salary;
  const margin = d.business > 0 ? Math.round(d.net / d.business * 100) : null;
  const seg = (parts, total) => parts.filter(p => p[1] > 0)
    .map(([, v, c]) => `<i style="width:${(v / total * 100).toFixed(2)}%;background:${c}"></i>`).join('');
  const legend = parts => parts.filter(p => p[1] > 0).map(([l, v, c]) => `<span style="--c:${c}">${l} ${money(v)}</span>`).join('');
  const income = [['Cash', d.cash, '#0f766e'], ['Online', d.online, '#14b8a6'], ['Credit', d.credit, '#f59e0b']];
  const spent = [['Expenses', d.expenses, '#c2410c'], ['Helper bonus', d.bonus, '#fdba74'], ['Salaries', d.salary, '#9a3412']];
  const scale = Math.max(d.business, costs);
  const flow = scale > 0 ? `<div class="flow" aria-hidden="true">
      ${d.business > 0 ? `<div class="flow-bar" style="width:${(d.business / scale * 100).toFixed(2)}%">${seg(income, d.business)}</div>
      <div class="flow-legend">${legend(income)}</div>` : ''}
      ${costs > 0 ? `<div class="flow-bar" style="margin-top:10px;width:${(costs / scale * 100).toFixed(2)}%">${seg(spent, costs)}</div>
      <div class="flow-legend">${legend(spent)}</div>` : ''}
    </div>` : `<p class="hero-sub">Nothing entered for today yet.</p>`;

  const quick = `<div class="quick">
      <button ${act(goDaily)}><b>Today's entry</b><small>${saleToday ? 'Sales ✓' : 'Sales not entered'} · ${plural(expsToday, 'expense')}</small></button>
      <button class="ghost" ${act(() => bulkExpenseModal({ date: t }))}><b>+ Add expense</b><small>${isApp ? 'With bill photo' : '<span class="kbd-hint">Ctrl+E · </span>With bill photo'}</small></button>
      <button class="ghost" ${act(() => { location.hash = 'credit'; })}><b>Credit payment</b><small>${owing.length ? `${plural(owing.length, 'customer')} owe` : 'Nobody owes'}</small></button>
      <button class="ghost" ${act(() => { location.hash = 'vendors'; })}><b>Pay a vendor</b><small>${vendorList.length ? `${plural(vendorList.length, 'vendor')} pending` : 'All paid'}</small></button>
    </div>`;

  /* --- one list of everything that needs doing --- */
  const todo = [];
  const item = (tone, what, sub, amt, label, fn) => todo.push(`<li><span class="dot" style="--c:var(--${tone})"></span>
      <span class="what">${what}${sub ? `<small>${sub}</small>` : ''}</span>${amt ? `<span class="amt ${tone === 'bad' ? 'neg' : ''}">${amt}</span>` : ''}
      <button class="link go" ${act(fn)}>${label} →</button></li>`);
  if (!S.owners.length) item('warn', 'Set up the canteen', 'Add owners and their profit share %, then helpers, vendors and menu items', '', 'Start', () => { location.hash = 'owners'; });
  if (!saleToday) item('warn', "Today's sales are not entered yet", '', '', 'Enter now', goDaily);
  for (const l of licenseAlerts()) item(l.days < 0 ? 'bad' : 'warn', `${/licen[cs]e/i.test(l.desc) ? '' : 'License: '}${esc(l.desc)} ${l.days < 0 ? 'has expired' : l.days === 0 ? 'expires today' : `expires in ${plural(l.days, 'day')}`}`,
    `Valid till ${fmtDate(l.validTill)}`, '', 'Renew', () => expenseModal(null, { category: 'License Renewal' }));
  if (vendorPending > 0) item('bad', 'Pending to vendors', esc(names(vendorList.map(x => x.v.name))), money(vendorPending), 'Pay', () => { location.hash = 'vendors'; });
  if (creditPending > 0) item('warn', 'Customer credit to collect', `${plural(owing.length, 'customer')} · ${esc(names(owing.map(x => x.c.name)))}`, money(creditPending), 'View', () => { location.hash = 'credit'; });
  if (ownerUnpaid > 0) item('warn', 'Owed to owners (paid from pocket)', '', money(ownerUnpaid), 'View', () => { location.hash = 'owners'; });
  if (helperDue > 0) item('warn', 'Helper salary due this month', plural(dueHelpers.length, 'helper'), money(helperDue), 'View', () => { location.hash = 'helpers'; });
  const hasData = S.sales.length + S.expenses.length > 0;
  const lb = S.settings.lastBackup;
  const backupDays = lb ? Math.floor((Date.now() - new Date(lb)) / 864e5) : null;
  if (hasData && (backupDays == null || backupDays > 7)) item('warn', lb ? `No backup for ${backupDays} days` : 'No backup taken yet', '', '', 'Back up', () => { location.hash = 'settings'; });

  /* --- week and month in three numbers each --- */
  const ws = weekStart(t);
  const w = figures(ws, t);
  const periodCard = (title, x, onOpen) => `<div class="card"><h2>${title}<span class="spacer"></span>
      <button class="sm ghost" ${act(onOpen)}>Details</button></h2>
    <div class="period">
      <div><div class="label">Business</div><div class="value">${money(x.business)}</div><div class="sub">${plural(x.days, "day")} entered</div></div>
      <div><div class="label">All costs</div><div class="value">${money(x.expenses + x.bonus + x.salary)}</div><div class="sub">incl. salaries ${money(x.salary)}</div></div>
      <div><div class="label">Net profit</div><div class="value ${x.net >= 0 ? 'good' : 'bad'}">${money(x.net)}</div><div class="sub">before owners' cut</div></div>
      <div><div class="label">Left after owners</div><div class="value ${x.net - x.withdrawn >= 0 ? '' : 'bad'}">${money(x.net - x.withdrawn)}</div><div class="sub">Owners took ${money(x.withdrawn)}</div></div>
    </div></div>`;
  const pts = periodPoints(addDays(t, -29), t, 'day');

  return `<div class="card">
    <div class="hero">
      <div class="hero-main">
        <div class="eyebrow">Today · ${fmtDay(t)} · net profit so far</div>
        <div class="hero-num ${d.net >= 0 ? 'good' : 'bad'}" data-testid="today-net">${money(d.net)}</div>
        <div class="hero-sub" data-testid="today-sub">Business <b>${money(d.business)}</b> − costs <b>${money(costs)}</b>${margin != null ? ` · ${margin}% margin` : ''}</div>
        <div class="hero-sub" data-testid="today-left">Owners took <b>${money(d.withdrawn)}</b> · <b class="${d.net - d.withdrawn < 0 ? 'neg' : ''}">${money(d.net - d.withdrawn)}</b> left in the business</div>
        ${flow}
      </div>
      ${quick}
    </div></div>
  <div class="grid g2">
    <div class="card"><h2>Needs attention</h2>
      ${todo.length ? `<ul class="todo">${todo.join('')}</ul>` : '<div class="empty">All clear ✓ Nothing needs doing right now.</div>'}</div>
    <div>
      ${periodCard(`This week · from ${shortDate(ws)}`, w, () => { UI.rep.mode = 'week'; UI.rep.week = t; location.hash = 'reports'; })}
      ${periodCard(`This month · ${monthName(ym)}`, m, () => { UI.rep.mode = 'month'; UI.month = ym; location.hash = 'reports'; })}
    </div>
  </div>
  <div class="card"><h2>Net profit – last 30 days<span class="spacer"></span><a href="#reports" class="btn ghost sm">Full reports</a></h2>
    ${lineChart(pts, [{ name: 'Net profit', signed: true }])}</div>`;
}

function licenseAlerts() {
  const latest = {};
  for (const e of S.expenses) {
    if (!e.validTill) continue;
    const key = (e.desc || e.category).toLowerCase();
    if (!latest[key] || latest[key].validTill < e.validTill) latest[key] = e;
  }
  const t = today();
  return Object.values(latest)
    .map(e => ({ desc: e.desc || e.category, validTill: e.validTill, days: Math.round((new Date(e.validTill + 'T00:00') - new Date(t + 'T00:00')) / 864e5) }))
    .filter(l => l.days <= 30)
    .sort((a, b) => a.days - b.days);
}

/* ================================================================
   DAILY ENTRY
   ================================================================ */

function pageDaily() {
  const date = UI.date;
  const go = d => { UI.date = d; render(); };
  setTools(`<button class="ghost" title="Previous day (Alt + ←)" ${act(() => go(addDays(date, -1)))}>‹ Prev</button>
    <input type="date" aria-label="Day" value="${date}" style="width:160px" ${onChange(el => el.value && go(el.value))}>
    <button class="ghost" title="Next day (Alt + →)" ${act(() => go(addDays(date, 1)))}>Next ›</button>
    ${date !== today() ? `<button class="ghost" ${act(() => go(today()))}>Today</button>` : ''}`);

  const sale = S.sales.find(s => s.date === date) || {};
  const f = dayFigures(date);

  // sales form
  const saleFields = [
    { name: 'cash', label: 'Cash received from customers', type: 'money', value: sale.cash || '', enterNext: true },
    { name: 'online', label: 'Online / UPI received', type: 'money', value: sale.online || '' },
    { name: 'note', label: 'Note', value: sale.note || '', cls: 'wide' }
  ];
  // Cash → Enter → Online → Enter saves; then the cursor goes to the next thing to fill in
  const saleForm = inlineForm(saleFields, sale.date ? 'Update sales' : 'Save sales', async d => {
    let s = S.sales.find(x => x.date === date);
    if (!s) { s = { date }; S.sales.push(s); }
    Object.assign(s, d);
    await save(); toast('Sales saved');
  }, 'sales');
  formFlow.sales = { resume: () => goTo('.item-grid input') || goTo('form[data-form=bonus] [name=amount]') };

  // item quantities
  const dayItems = S.itemSales.filter(x => x.date === date);
  const qtyOf = id => { const r = dayItems.find(x => x.itemId === id); return r ? r.qty : ''; };
  const itemsTotal = sum(dayItems, x => x.qty * x.rate);
  const itemsK = reg(async form => {
    S.itemSales = S.itemSales.filter(x => x.date !== date);
    for (const it of S.items) {
      const q = num(form.elements['q_' + it.id].value);
      // items whose price changes daily are saved at the price typed for today
      const p = form.elements['p_' + it.id];
      const rate = p && num(p.value) > 0 ? num(p.value) : itemRateOn(it, date).rate;
      if (q > 0) S.itemSales.push({ id: uid(), date, itemId: it.id, name: it.name, qty: q, rate });
    }
    await save(); toast('Item sales saved');
    resumeAfterRender = { key: 'items' };
    render();
  });
  formFlow.items = { resume: () => goTo('form[data-form=bonus] [name=amount]') };
  const itemsCard = S.items.length ? `
    <form data-submit="${itemsK}" data-form="items">
      <div class="item-grid">${S.items.map((it, i) => {
        const last = i === S.items.length - 1;
        if (!it.dailyPrice) return `<label class="item-cell ${qtyOf(it.id) ? 'has' : ''}">
        <span class="nm">${esc(it.name)}<small>${money(itemRateOn(it, date).rate)}</small></span>
        <input type="number" min="0" step="any" inputmode="decimal" name="q_${it.id}" value="${qtyOf(it.id)}" placeholder="0" ${last ? '' : 'data-enter-next'}></label>`;
        // price changes daily: ask today's price, filled in with the last one used
        const r = itemRateOn(it, date), saved = r.from === date;
        return `<div class="item-cell daily ${qtyOf(it.id) ? 'has' : ''}">
        <span class="nm">${esc(it.name)}<small>${saved ? "today's price" : r.from ? `last ${fmtDate(r.from)}` : 'menu price'} · changes daily</small></span>
        <input type="number" min="0" step="any" inputmode="decimal" name="q_${it.id}" value="${qtyOf(it.id)}" placeholder="Qty" aria-label="${esc(it.name)} quantity" data-enter-next>
        <span class="rate"><span aria-hidden="true">₹</span><input type="number" min="0" step="any" inputmode="decimal" name="p_${it.id}" value="${r.rate || ''}" placeholder="Price"
          aria-label="${esc(it.name)} price today" title="Price today" ${last ? '' : 'data-enter-next'}></span></div>`;
      }).join('')}</div>
      <div class="row" style="margin-top:10px;justify-content:space-between">
        <span class="muted">Items value: <b>${money(itemsTotal)}</b>${f.cash + f.online > 0 ? ` · Cash + Online: <b>${money(f.cash + f.online)}</b>` : ''}</span>
        <button type="submit">Save item quantities</button></div></form>`
    : `<div class="empty">Add your menu items on the <a href="#items">Item Sales</a> page first.</div>`;

  // expenses of the day
  const exps = S.expenses.filter(e => e.date === date);
  const expRows = exps.map(e => `<tr>
    <td>${esc(e.category)}${e.vendorId ? `<br><span class="pill accent">${esc(nameOf(S.vendors, e.vendorId))}</span>` : ''}</td>
    <td>${esc(e.desc)}${fileChips(e.files)}</td><td>${esc(paidByLabel(e.paidBy))}</td>
    <td class="num">${money(e.amount)}</td>
    <td class="num"><button class="link" ${act(() => expenseModal(e))}>Edit</button><button class="link del" aria-label="Delete" title="Delete" ${act(() => deleteExpense(e))}>✕</button></td></tr>`);
  if (exps.length) expRows.push(`<tr class="total"><td colspan="3">Total</td><td class="num">${money(f.expenses)}</td><td></td></tr>`);

  // helper bonuses
  const bonuses = S.helperTx.filter(t => t.date === date && t.type === 'bonus');
  const working = S.helpers.filter(h => (!h.from || h.from <= date) && (!h.till || h.till >= date));
  const lastBonus = hid => { const t = S.helperTx.filter(x => x.type === 'bonus' && x.helperId === hid && x.date <= date).sort(byDateDesc)[0]; return t ? t.amount : ''; };
  const bonusStart = personFlow('bonus', 'helperId', lastBonus,
    () => new Set(S.helperTx.filter(t => t.date === date && t.type === 'bonus').map(t => t.helperId)), working.length ? working : S.helpers,
    () => goTo('form[data-form=withdraw] [name=amount]'));
  const bonusForm = S.helpers.length ? inlineForm([
    { name: 'helperId', label: 'Helper', type: 'select', value: bonusStart.id, options: [...helperOptions(), ...(working.length > 1 ? [{ value: '*', label: `All working helpers (${working.length})` }] : [])] },
    { name: 'amount', label: 'Bonus (each)', type: 'money', required: true, cls: 'small', value: bonusStart.amount },
    { name: 'note', label: 'Note' }
  ], 'Add bonus', async d => {
    if (!d.amount) return false;
    const ids = d.helperId === '*' ? working.map(h => h.id) : [d.helperId];
    for (const helperId of ids) S.helperTx.push({ id: uid(), date, type: 'bonus', month: date.slice(0, 7), ...d, helperId });
    await save();
  }, 'bonus') : `<div class="empty">Add helpers on the <a href="#helpers">Helpers</a> page.</div>`;
  const bonusRows = bonuses.map(b => `<tr><td>${esc(nameOf(S.helpers, b.helperId))}</td><td>${esc(b.note)}</td>
    <td class="num">${money(b.amount)}</td><td class="num"><button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this bonus', () => { S.helperTx = S.helperTx.filter(x => x !== b); }))}>✕</button></td></tr>`);

  // owner withdrawals
  const wds = S.ownerTx.filter(t => t.date === date && t.type === 'withdraw');
  const lastTaken = oid => { const t = S.ownerTx.filter(x => x.type === 'withdraw' && x.ownerId === oid && x.date <= date).sort(byDateDesc)[0]; return t ? t.amount : ''; };
  // owners with no profit share (e.g. a savings account) are not part of the daily round
  const sharers = S.owners.filter(o => num(o.share) > 0);
  const wdStart = personFlow('withdraw', 'ownerId', lastTaken,
    () => new Set(S.ownerTx.filter(t => t.date === date && t.type === 'withdraw').map(t => t.ownerId)), sharers.length ? sharers : S.owners,
    () => goTo('form[data-form=credit] [name=customerId]'));
  const wdForm = S.owners.length ? inlineForm([
    { name: 'ownerId', label: 'Owner', type: 'select', value: wdStart.id, options: ownerOptions() },
    { name: 'amount', label: 'Amount taken', type: 'money', required: true, cls: 'small', value: wdStart.amount },
    { name: 'note', label: 'Note' }
  ], 'Add', async d => {
    if (!d.amount) return false;
    S.ownerTx.push({ id: uid(), date, type: 'withdraw', month: date.slice(0, 7), ...d });
    await save();
  }, 'withdraw') : `<div class="empty">Add owners on the <a href="#owners">Owners</a> page.</div>`;
  const wdRows = wds.map(w => `<tr><td>${esc(nameOf(S.owners, w.ownerId))}</td><td>${esc(w.note)}</td>
    <td class="num">${money(w.amount)}</td><td class="num"><button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this entry', () => { S.ownerTx = S.ownerTx.filter(x => x !== w); }))}>✕</button></td></tr>`);

  // customer credit
  const ctx = S.creditTx.filter(t => t.date === date && !t.opening);
  const creditForm = S.customers.length ? inlineForm([
    { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions() },
    { name: 'type', label: 'Type', type: 'select', options: [{ value: 'credit', label: 'Took on credit' }, { value: 'payment', label: 'Paid back' }] },
    { name: 'amount', label: 'Amount', type: 'money', required: true, cls: 'small' },
    { name: 'mode', label: 'Paid by', type: 'select', options: modeOptions(), cls: 'small' },
    { name: 'note', label: 'Note' }
  ], 'Add', async d => {
    if (!d.amount) return false;
    S.creditTx.push({ id: uid(), date, ...d });
    await save();
  }, 'credit') : `<div class="empty">Add regular customers on the <a href="#credit">Customer Credit</a> page.</div>`;
  // after adding, start the next entry at the customer box
  formFlow.credit = { resume: form => form.elements.customerId.focus() };
  const creditRows = ctx.map(t => `<tr><td>${esc(nameOf(S.customers, t.customerId))}</td>
    <td>${t.type === 'credit' ? '<span class="pill bad">Credit</span>' : `<span class="pill good">Paid (${t.mode})</span>`} ${esc(t.note)}</td>
    <td class="num">${money(t.amount)}</td><td class="num" style="white-space:nowrap"><button class="link" ${act(() => creditTxModal(t.customerId, t.type, null, t))}>Edit</button>
      <button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this entry', () => { S.creditTx = S.creditTx.filter(x => x !== t); }))}>✕</button></td></tr>`);

  const kept = f.net - f.withdrawn;

  /* progress strip: which parts of the day are filled in, and the next one to do */
  const totalQty = sum(dayItems, x => x.qty);
  const steps = [
    { k: 'sales', n: 1, label: 'Sales', done: !!sale.date, info: sale.date ? money(f.cash + f.online) : '' },
    { k: 'items', n: 2, label: 'Items', done: dayItems.length > 0, info: dayItems.length ? String(totalQty) : '', skip: !S.items.length },
    { k: 'expenses', n: 3, label: 'Expenses', done: exps.length > 0, info: exps.length ? String(exps.length) : '' },
    { k: 'bonus', n: 4, label: 'Helper bonus', done: bonuses.length > 0, info: bonuses.length ? money(f.bonus) : '', skip: !S.helpers.length },
    { k: 'withdraw', n: 5, label: 'Owners took', done: wds.length > 0, info: wds.length ? money(f.withdrawn) : '', skip: !S.owners.length },
    { k: 'credit', n: 6, label: 'Credit', done: ctx.length > 0, info: ctx.length ? String(ctx.length) : '', skip: !S.customers.length }
  ];
  const next = steps.find(x => !x.done && !x.skip);
  const st = {};
  for (const x of steps) st[x.k] = x;
  const jump = k => goTo(`#step-${k} :is(input:not([type=file]), select, button)`);
  const strip = `<nav class="steps no-print" aria-label="Sections of the day">${steps.map(x =>
    `<button type="button" class="step ${x.done ? 'done' : x === next ? 'now' : ''}" ${x === next ? 'aria-current="step"' : ''} ${act(() => jump(x.k))}>
      <span class="n" aria-hidden="true">${x.done ? '✓' : x.n}</span>${x.label}${x.done ? '<span class="sr-only"> (done)</span>' : ''}${x.info ? ` <small>${x.info}</small>` : ''}</button>`).join('')}</nav>`;
  const head = (k, title, tools = '') => {
    const x = st[k];
    return `<h2><span class="n ${x.done ? 'done' : ''}" aria-hidden="true" ${x === next ? 'style="background:var(--accent);color:#fff"' : ''}>${x.done ? '✓' : x.n}</span>${title}${tools}</h2>`;
  };
  const card = (k, inner) => `<div class="card ${st[k] === next ? 'now' : ''}" id="step-${k}">${inner}</div>`;
  const copy = () => copyText(daySummaryText(date, f));

  return `${strip}
  <div class="grid g2">
    <div>
      ${card('sales', `${head('sales', 'Sales of the day')}
        <p class="hint">Enter only today's sales. Money received from credit customers paying old dues goes in Credit (6).</p>
        ${saleForm}`)}
      ${card('items', `${head('items', 'Items sold')}${itemsCard}`)}
      ${card('expenses', `${head('expenses', 'Expenses', `<span class="spacer"></span>
        <button class="sm" ${act(() => expenseModal(null, { date }))}>+ Add expense / bill</button>`)}
        ${table(['Category', 'Details', 'Paid from', { t: 'Amount', cls: 'num' }, ''], expRows, 'No expenses for this day')}`)}
    </div>
    <div>
      <div class="card summary" id="daySummary">
        <div class="summary-head"><span><span class="muted" style="font-size:12px">Net profit · ${fmtDate(date)}</span><br>
          <span class="hero-num ${f.net >= 0 ? 'good' : 'bad'}">${money(f.net)}</span></span>
          <button class="sm ghost" title="Copy as text to paste in WhatsApp" ${act(copy)}>⧉ Copy for WhatsApp</button></div>
        <div class="split"><span>Cash sales</span><b>${money(f.cash)}</b></div>
        <div class="split"><span>Online sales</span><b>${money(f.online)}</b></div>
        <div class="split"><span>Credit sales (udhaar)</span><b>${money(f.credit)}</b></div>
        <div class="split"><span><b>Total business</b></span><b>${money(f.business)}</b></div>
        <div class="split"><span>− Expenses</span><span>${money(f.expenses)}</span></div>
        <div class="split"><span>− Helper bonuses</span><span>${money(f.bonus)}</span></div>
        ${f.salary ? `<div class="split"><span>− Salaries paid today</span><span>${money(f.salary)}</span></div>` : ''}
        <div class="split"><span>− Taken by owners today</span><span>${money(f.withdrawn)}</span></div>
        <div class="split"><span>Left in business</span><b class="${signCls(kept)}">${money(kept)}</b></div>
        ${f.creditRecv ? `<div class="split muted"><span>Old credit collected today</span><span>${money(f.creditRecv)}</span></div>` : ''}
      </div>
      ${card('bonus', `${head('bonus', 'Helper daily bonus')}${bonusForm}
        ${bonuses.length ? table(['Helper', 'Note', { t: 'Amount', cls: 'num' }, ''], bonusRows) : ''}`)}
      ${card('withdraw', `${head('withdraw', 'Amount taken by owners')}${wdForm}
        ${wds.length ? table(['Owner', 'Note', { t: 'Amount', cls: 'num' }, ''], wdRows) : ''}`)}
      ${card('credit', `${head('credit', 'Customer credit')}${creditForm}
        ${ctx.length ? table(['Customer', 'Type', { t: 'Amount', cls: 'num' }, ''], creditRows) : ''}`)}
    </div>
  </div>
  <div class="daybar no-print">
    <button type="button" class="what" ${act(() => document.getElementById('daySummary').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }))}>
      <small>Net profit ${date === today() ? 'today' : fmtDate(date)} · tap for summary</small><b class="${signCls(f.net)}">${money(f.net)}</b></button>
    <button type="button" class="ghost sm" aria-label="Copy day summary for WhatsApp" ${act(copy)}>⧉ Copy</button>
  </div>`;
}

function daySummaryText(date, f) {
  const lines = [
    `*${S.settings.name}* – ${fmtDay(date)}`,
    `Cash sales: ${money(f.cash)}`,
    `Online sales: ${money(f.online)}`,
    f.credit ? `Credit sales: ${money(f.credit)}` : '',
    `*Total business: ${money(f.business)}*`,
    `Expenses: ${money(f.expenses)}`,
    f.bonus ? `Helper bonus: ${money(f.bonus)}` : '',
    f.salary ? `Salaries paid: ${money(f.salary)}` : '',
    `*Net profit: ${money(f.net)}*`,
    f.withdrawn ? `Taken by owners: ${money(f.withdrawn)}` : '',
    f.creditRecv ? `Old credit collected: ${money(f.creditRecv)}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  toast('Copied – paste it in WhatsApp');
}

/* ================================================================
   EXPENSES
   ================================================================ */

/* Saves one new expense; a vendor bill also records what was paid right away
   (paidNow: '' = paid in full, 0 = fully on credit). */
async function createExpense(d, files, paidNow) {
  const x = { id: uid(), files: [], ...d };
  S.expenses.push(x);
  if (x.vendorId) {
    const paid = paidNow === '' || paidNow == null ? num(x.amount) : num(paidNow);
    if (paid > 0) S.vendorPayments.push({ id: uid(), date: x.date, vendorId: x.vendorId, amount: paid, paidBy: x.paidBy, mode: '', note: 'Paid with bill', expenseId: x.id });
  }
  if (files && files.length) {
    x.files = await addFiles(files, { date: x.date, title: x.desc || x.category, category: x.category, link: { type: 'expense', id: x.id } });
  }
  return x;
}

const narrow = window.matchMedia('(max-width: 1000px)'); // column headings are hidden on small screens
const rowFiles = row => [...row.querySelectorAll('[data-f="files"]')].flatMap(i => [...i.files]);

/* Multi-row entry: type every expense of the day in one go and save them together. */
/* ---------- automatic category ----------
   Typing a description picks its category: first from how the same thing was filed before
   ("Chapati (350)" and "chapati 300" count as the same thing), then from common words.
   Choosing a category by hand in a row always wins over the guess. */
const CATEGORY_WORDS = [
  ['Meat and Fish', /mutton|chicken|fish|surmai|rawas|bangda|pomfret|prawn|kolambi|bombil|mackerel|keema|meat/],
  ['Chapati, Pav & Bhakri', /\bpav\b|chapati|roti|bhakri|bhakari|bread|\bbuns?\b/],
  ['Milk & Dairy', /milk|doodh|chaas|curd|dahi|paneer|butter|ghee|cream|cheese/],
  ['Cold Drinks & Beverages', /pepsi|coke|cola|sprite|thums|oxycool|soda|kokam|juice|water bottle|bisleri|coffee|chai patti|tea powder/],
  ['Vegetables', /bhaji|vegetable|sabzi|onion|kanda|potato|batata|popato|poptato|tomato|garlic|lasun|ginger|adrak|lemon|coconut|mirchi|chil+i|coriander|kothimbir|methi|palak|cabbage|carrot|peas|capsicum|cucumber|brinjal/],
  ['Gas / Fuel', /\bgas\b|cylinder|petrol|diesel|kerosene|charcoal|\bcoal\b/],
  ['Electricity', /electricity|light bill|mseb|msedcl|adani elec|tata power/],
  ['Water', /water tanker|water bill|tanker/],
  ['Rent', /\brent\b/],
  ['Repairs & Maintenance', /repair|fixing|plumber|electrician|carpenter|servicing|charger|mixer|cooker|fridge|freezer|\bfan\b/],
  ['Kitchen Utensils & Equipment', /thermos|tawa|utensil|vessel|bhagona|kadai|steel plate|ladle|knife|\bspoons?\b|tongs/],
  ['Packaging', /parcel|packing|packaging|container|carry bag|paper dish|paper glass|use and throw|cutlery|\bfoil\b|butter paper|tissue/],
  ['Cleaning', /cleaning|washing powder|detergent|soap|handwash|phenyl|harpic|broom|\bmop\b|scrub|dish ?wash|\bvim\b/],
  ['License Renewal', /licen[cs]e|fssai|renewal|permit/],
  ['Transport', /transport|tempo|\bauto\b|rickshaw|delivery charge|courier/],
  ['Groceries & Raw Material', /\boil\b|\brice\b|atta|maida|rava|besan|\bdal\b|salt|sugar|masala|spice|haldi|jeera|farsan|snacks|\beggs?\b|blinkit|zepto|dmart|grocery|kirana/]
];
const descKey = d => String(d || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/\b\d+(\.\d+)?\s*(kg|kgs|g|gm|gms|l|ltr|litre|liter|ml|pcs|pc|box|boxes|cans?|nos?|x)?\b/g, ' ')
  .replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
// the quantity written in a description: "Chapati (350)", "(50x13)", "8L Milk", "Chicken 18kg", "Chapati 50 pcs"
function qtyIn(desc) {
  const d = String(desc || '').toLowerCase();
  let m = d.match(/\(\s*(\d+(?:\.\d+)?)\s*(?:x\s*\d+(?:\.\d+)?)?\s*\)/);
  if (m && +m[1] > 0) return { qty: +m[1], unit: '' };
  m = d.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|l|ltr|litre|liter)\b/);
  if (m && +m[1] > 0) return { qty: +m[1], unit: m[2].startsWith('k') ? 'kg' : 'l' };
  m = d.match(/\b(\d+(?:\.\d+)?)\s*(?:pcs|pc|nos)?\b/);
  if (m && +m[1] > 0) return { qty: +m[1], unit: '' };
  return null;
}

function guessCategory(desc) {
  const d = String(desc || '').trim().toLowerCase(), k = descKey(desc), cats = S.settings.categories;
  if (!k) return '';
  const past = S.expenses.filter(e => cats.includes(e.category) && e.category !== 'Miscellaneous').sort(byDateDesc);
  const same = past.find(e => (e.desc || '').trim().toLowerCase() === d) || past.find(e => descKey(e.desc) === k);
  if (same) return same.category;
  const hit = CATEGORY_WORDS.find(([c, re]) => cats.includes(c) && re.test(d));
  return hit ? hit[0] : '';
}

function bulkExpenseModal(preset = {}) {
  const LICENSE = 'License Renewal';
  const recent = S.expenses.slice().sort(byDateDesc);
  const lastByDesc = {};
  for (const e of recent) { const k = (e.desc || '').trim().toLowerCase(); if (k && !lastByDesc[k]) lastByDesc[k] = e; }
  const lastByVendor = {};
  for (const e of recent) if (e.vendorId && !lastByVendor[e.vendorId]) lastByVendor[e.vendorId] = e;
  const opts = (list, val) => list.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(val || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

  const rowHTML = (r = {}) => {
    const cat = r.category || preset.category || S.settings.categories[0];
    const vendor = r.vendorId != null ? r.vendorId : preset.vendorId || '';
    return `<div class="bulk-row ${cat === LICENSE ? 'license' : ''}">
      <select data-f="category" title="Category">${opts(catOptions(), cat)}</select>
      <input data-f="desc" aria-label="Description" list="descList" placeholder="Description (e.g. 20 L milk)" value="${esc(r.desc || '')}" autocomplete="off">
      <input data-f="amount" aria-label="Amount" type="number" min="0" step="any" inputmode="decimal" placeholder="₹ Amount" value="${esc(r.amount || '')}">
      <select data-f="vendorId" title="Vendor">${opts(vendorOptions('— No vendor —'), vendor)}</select>
      <input data-f="paidNow" aria-label="Paid now" type="number" min="0" step="any" inputmode="decimal" placeholder="${narrow.matches ? 'Paid now: full' : 'Full'}" title="Paid to vendor now – blank = full amount, 0 = on credit" ${vendor ? '' : 'disabled'}>
      <select data-f="paidBy" title="Paid from">${opts(paidByOptions().map(o => ({ value: o.value, label: o.value === 'business' ? 'Business money' : o.label })), r.paidBy || preset.paidBy || 'business')}</select>
      <label class="file-btn" title="Attach bill photo / PDF" data-icon="📎">📎<input data-f="files" type="file" multiple accept="image/*,application/pdf" hidden></label>
      ${isApp ? '<label class="file-btn" title="Take a photo of the bill" data-icon="📷">📷<input data-f="files" type="file" accept="image/*" capture="environment" hidden></label>' : ''}
      <button type="button" class="row-del" aria-label="Remove row" title="Remove row" data-del>✕</button>
      <div class="bulk-extra">License / renewal valid till <input data-f="validTill" aria-label="Valid till" type="date" value="${esc(r.validTill || '')}"></div>
      <div class="bulk-note" data-note aria-live="polite"></div>
    </div>`;
  };

  /* how things are usually bought: the quantity written in the description ("Chapati (350)", "8L Milk",
     "Chicken 18kg") and the amount give a rate per piece / litre / kg, learned from past entries */
  const usual = {};
  for (const e of recent) {
    const key = descKey(e.desc), q = qtyIn(e.desc), a = num(e.amount);
    if (!key) continue;
    const u = usual[key] || (usual[key] = { key, n: 0, recent: 0, samples: [], unit: '', last: e, withQty: 0 });
    u.n++;
    if (e.date >= addDays(today(), -30)) u.recent++;
    if (q && a > 0) { u.withQty++; if (u.samples.length < 15) u.samples.push({ qty: q.qty, rate: a / q.qty }); if (!u.unit) u.unit = q.unit; }
  }
  // the rate of past buys of a similar size: a big daily order of 400 chapatis is cheaper per piece
  // than a top-up of 30, so each is compared with buys of its own size
  const usualRate = (key, qty) => {
    const u = usual[key];
    if (!u || !u.samples.length) return null;
    let near = u.samples.filter(s => s.qty >= qty / 2 && s.qty <= qty * 2);
    if (!near.length) near = u.samples.slice().sort((a, b) => Math.abs(Math.log(a.qty / qty)) - Math.abs(Math.log(b.qty / qty))).slice(0, 3);
    const r = near.map(s => s.rate).sort((a, b) => a - b);
    return { rate: r[Math.floor(r.length / 2)], unit: u.unit };
  };
  const perUnit = (rate, unit) => `${money(rate)} ${unit === 'kg' ? 'per kg' : unit === 'l' ? 'per litre' : 'each'}`;
  // one-tap buttons for what is bought most often lately
  const frequent = Object.values(usual).filter(u => u.recent >= 2).sort((a, b) => b.recent - a.recent).slice(0, 10);
  const nameOfUsual = u => u.last.desc.replace(/\(.*?\)/g, '').replace(/\b\d+(\.\d+)?\s*(kg|kgs|l|ltr|litre|liter|pcs|pc|box|boxes)?\b/gi, '').replace(/\s+/g, ' ').trim().replace(/^./, c => c.toUpperCase()) || u.key;

  const k = reg(async form => {
    const date = form.elements.date.value;
    const rows = [...form.querySelectorAll('.bulk-row')];
    const filled = [];
    let bad = false;
    for (const row of rows) {
      const g = f => row.querySelector(`[data-f="${f}"]`);
      const amount = num(g('amount').value), desc = g('desc').value.trim();
      const files = rowFiles(row);
      row.classList.remove('err');
      if (!amount && !desc && !files.length) continue;
      if (!amount) { row.classList.add('err'); bad = true; continue; }
      filled.push({ d: { date, category: g('category').value, desc, amount, vendorId: g('vendorId').value, paidBy: g('paidBy').value, validTill: g('category').value === LICENSE ? g('validTill').value : '', note: '' }, files, paidNow: g('paidNow').value.trim() });
    }
    if (bad) { alert('Enter the amount for the rows marked in red (or clear them).'); return; }
    if (!filled.length) { alert('Type at least one expense.'); return; }
    // the same thing at the same amount on the same day is usually entered twice by mistake
    const sameKey = x => (descKey(x.desc) || String(x.category).toLowerCase()) + '|' + num(x.amount);
    const seen = new Set(S.expenses.filter(e => e.date === date).map(sameKey)), dupes = [];
    for (const r of filled) { const key = sameKey(r.d); if (seen.has(key)) dupes.push(`${r.d.desc || r.d.category} ${money(r.d.amount)}`); seen.add(key); }
    if (dupes.length && !confirm(`Already entered for ${fmtDate(date)}:\n\n${dupes.join('\n')}\n\nAdd ${dupes.length === 1 ? 'it' : 'them'} again?`)) return;
    for (const r of filled) await createExpense(r.d, r.files, r.paidNow);
    await save();
    closeModal();
    toast(filled.length === 1 ? 'Expense saved' : `${filled.length} expenses saved`);
    render();
    if (preset.after) preset.after();
  });

  const descs = Object.values(lastByDesc).slice(0, 300).map(e => `<option value="${esc(e.desc)}">`).join('');
  openModal(`<h3>Add expenses</h3>
    <form data-submit="${k}">
      <div class="row" style="margin-bottom:12px">
        <div class="field" style="flex:0 0 180px"><label>Date (for all rows)</label><input type="date" name="date" value="${esc(preset.date || today())}" required></div>
        <span style="flex:1"></span>
        <button type="button" class="ghost" data-copy>↺ Copy last day's expenses</button>
      </div>
      ${frequent.length ? `<div class="quick-add"><span class="muted">Usual:</span>${frequent.map((u, i) =>
        `<button type="button" class="chip" data-usual="${i}" title="${u.withQty ? 'Adds a row – type the quantity in the brackets' : 'Adds a row with the last amount'}">${esc(nameOfUsual(u))}</button>`).join('')}</div>` : ''}
      <div class="bulk-head"><span>Category</span><span>Description</span><span>Amount</span><span>Vendor</span><span>Paid now</span><span>Paid from</span><span>Bill</span><span></span></div>
      <div id="bulkRows">${rowHTML()}${rowHTML()}${rowHTML()}</div>
      <datalist id="descList">${descs}</datalist>
      <div class="bulk-foot">
        <button type="button" class="ghost" data-add>+ Add row</button>
        <span class="hint kbd-hint" style="margin:0"><kbd>Enter</kbd> description → amount → next row · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> save all · the category is picked from the description</span>
        <span class="bulk-total" id="bulkTotal">Total ₹0</span>
      </div>
      <div class="actions"><button type="button" class="ghost" ${act(requestClose)}>Cancel</button><button type="submit">Save all</button></div>
    </form>`, 'xl');

  const modal = document.querySelector('.modal');
  const rowsEl = document.getElementById('bulkRows');
  const field = (row, f) => row.querySelector(`[data-f="${f}"]`);
  const addRow = (r, focus) => {
    rowsEl.insertAdjacentHTML('beforeend', rowHTML(r));
    const row = rowsEl.lastElementChild;
    if (focus) field(row, 'desc').focus();
    return row;
  };
  const isEmpty = row => !field(row, 'amount').value && !field(row, 'desc').value.trim() && !rowFiles(row).length;
  const updateTotal = () => {
    const t = sum([...rowsEl.children], r => field(r, 'amount').value);
    document.getElementById('bulkTotal').textContent = 'Total ' + money(t);
  };
  const onVendor = row => {
    const v = field(row, 'vendorId').value;
    field(row, 'paidNow').disabled = !v;
    if (!v) field(row, 'paidNow').value = '';
    if (v && lastByVendor[v] && !row.dataset.catTouched) setCategory(row, lastByVendor[v].category);
  };
  const setCategory = (row, c) => {
    if (S.settings.categories.includes(c)) field(row, 'category').value = c;
    row.classList.toggle('license', field(row, 'category').value === LICENSE);
  };
  field(rowsEl.firstElementChild, 'desc').focus();

  // amount = quantity × the usual rate; a short note when a typed amount is well off the usual rate
  const note = (row, text, warn) => { const n = row.querySelector('[data-note]'); n.textContent = text || ''; n.classList.toggle('warn', !!warn); };
  const rateCheck = row => {
    const desc = field(row, 'desc').value, a = num(field(row, 'amount').value), q = qtyIn(desc), u = q && usualRate(descKey(desc), q.qty);
    if (!q || !u || !a) { note(row, ''); return; }
    const r = a / q.qty, diff = (r - u.rate) / u.rate;
    note(row, Math.abs(diff) >= 0.15 ? `${perUnit(r, u.unit)} – usually ${perUnit(u.rate, u.unit)} (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%)` : '', true);
  };
  const smartAmount = row => {
    const desc = field(row, 'desc').value, amt = field(row, 'amount'), q = qtyIn(desc), u = q && usualRate(descKey(desc), q.qty);
    if (!q || !u) { if (amt.dataset.auto) note(row, ''); return; }
    if (!amt.value || amt.dataset.auto) {
      amt.value = Math.round(q.qty * u.rate);
      amt.dataset.auto = '1';
      updateTotal();
      note(row, `${q.qty} × ${perUnit(u.rate, u.unit)} (usual rate) – change the amount if it was different`);
    } else rateCheck(row);
  };
  rowsEl.addEventListener('input', e => {
    const row = e.target.closest('.bulk-row'), f = e.target.dataset.f;
    if (f === 'desc') smartAmount(row);
    if (f === 'amount') { delete e.target.dataset.auto; rateCheck(row); }
  });
  // "Usual" buttons: add a row for something bought often, with its category and vendor
  const quick = modal.querySelector('.quick-add');
  if (quick) quick.addEventListener('click', e => {
    const b = e.target.closest('[data-usual]');
    if (!b) return;
    const u = frequent[+b.dataset.usual], last = u.last;
    const row = [...rowsEl.children].find(isEmpty) || addRow();
    if (row === rowsEl.lastElementChild) addRow(); // keep an empty row at the end
    if (last.vendorId && find(S.vendors, last.vendorId)) { field(row, 'vendorId').value = last.vendorId; onVendor(row); }
    if (!row.dataset.catTouched) setCategory(row, last.category);
    const d = field(row, 'desc');
    if (u.withQty) {
      // the quantity changes every time: the cursor waits inside the brackets
      d.value = nameOfUsual(u) + ' ()';
      d.focus();
      d.setSelectionRange(d.value.length - 1, d.value.length - 1);
    } else {
      d.value = nameOfUsual(u);
      const a = field(row, 'amount');
      a.value = num(last.amount);
      a.dataset.auto = '1';
      updateTotal();
      a.focus(); a.select();
    }
    modal.dataset.dirty = '1';
  });

  rowsEl.addEventListener('input', e => {
    const row = e.target.closest('.bulk-row');
    if (e.target.dataset.f === 'desc' && !row.dataset.catTouched) {
      const g = guessCategory(e.target.value);
      if (g) setCategory(row, g);
    }
    // always keep one empty row at the bottom, ready to type in
    if (row === rowsEl.lastElementChild && !isEmpty(row)) addRow();
    if (e.target.dataset.f === 'amount') updateTotal();
  });
  rowsEl.addEventListener('change', e => {
    const row = e.target.closest('.bulk-row'), f = e.target.dataset.f;
    if (f === 'category') { row.dataset.catTouched = '1'; setCategory(row, e.target.value); }
    if (f === 'vendorId') onVendor(row);
    if (f === 'files') {
      const n = e.target.files.length, lbl = e.target.parentElement;
      lbl.classList.toggle('has', n > 0);
      lbl.firstChild.textContent = lbl.dataset.icon + (n ? n : '');
      modal.dataset.dirty = '1';
      if (row === rowsEl.lastElementChild && n) addRow();
    }
    if (f === 'desc') {
      const past = lastByDesc[e.target.value.trim().toLowerCase()];
      if (past) {
        if (!row.dataset.catTouched) setCategory(row, past.category);
        if (!field(row, 'vendorId').value && past.vendorId && find(S.vendors, past.vendorId)) { field(row, 'vendorId').value = past.vendorId; onVendor(row); }
        if (!field(row, 'amount').value) field(row, 'amount').placeholder = 'last ' + money(past.amount);
      }
    }
  });
  rowsEl.addEventListener('click', e => {
    if (!e.target.closest('[data-del]')) return;
    e.target.closest('.bulk-row').remove();
    if (!rowsEl.children.length || !isEmpty(rowsEl.lastElementChild)) addRow();
    updateTotal();
  });
  rowsEl.addEventListener('keydown', e => {
    // Enter: description → its amount → the next row's description (never saves the form)
    if (e.key !== 'Enter' || e.ctrlKey || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const row = e.target.closest('.bulk-row');
    if (e.target.dataset.f === 'desc') { const a = field(row, 'amount'); a.focus(); a.select(); return; }
    const next = row.nextElementSibling || addRow();
    field(next, 'desc').focus();
  });
  modal.querySelector('[data-add]').addEventListener('click', () => addRow(null, true));
  modal.querySelector('[data-copy]').addEventListener('click', () => {
    const date = modal.querySelector('[name=date]').value || today();
    const prev = S.expenses.filter(e => e.date < date).map(e => e.date).sort().pop();
    if (!prev) { toast('No earlier expenses to copy'); return; }
    [...rowsEl.children].forEach(r => { if (isEmpty(r)) r.remove(); });
    for (const e of S.expenses.filter(x => x.date === prev)) {
      const row = addRow({ category: e.category, desc: e.desc, amount: e.amount, vendorId: find(S.vendors, e.vendorId) ? e.vendorId : '', paidBy: e.paidBy });
      row.dataset.catTouched = '1';
    }
    addRow();
    modal.dataset.dirty = '1';
    updateTotal();
    toast(`Copied expenses of ${fmtDate(prev)} – change amounts as needed`);
  });
}

function expenseModal(e, preset = {}) {
  if (!e) { bulkExpenseModal(preset); return; }
  const isNew = !e;
  const v = e || Object.assign({ date: today(), category: S.settings.categories[0], paidBy: 'business' }, preset);
  const fields = [
    { name: 'date', label: 'Date', type: 'date', value: v.date, required: true },
    { name: 'category', label: 'Category', type: 'select', options: catOptions(), value: v.category },
    { name: 'desc', label: 'Description (e.g. 20kg rice, fridge repair, FSSAI license)', value: v.desc, cls: 'wide' },
    { name: 'amount', label: 'Amount', type: 'money', value: v.amount, required: true },
    { name: 'vendorId', label: 'Vendor (if bought from a vendor)', type: 'select', options: vendorOptions(), value: v.vendorId || '' }
  ];
  if (isNew) fields.push({ name: 'paidNow', label: 'Paid to vendor now (blank = full, 0 = on credit)', type: 'money', raw: true, placeholder: 'Full amount' });
  fields.push(
    { name: 'paidBy', label: 'Paid from', type: 'select', options: paidByOptions(), value: v.paidBy },
    { name: 'validTill', label: 'Valid till (licenses / renewals)', type: 'date', value: v.validTill },
    { name: 'note', label: 'Note', value: v.note, cls: 'wide' },
    { name: 'bills', label: 'Attach bill photos / PDFs', type: 'file', cls: 'wide' }
  );
  const existing = e && e.files && e.files.length ? `<p class="hint" style="margin:0 0 10px">Already attached: ${fileChips(e.files)}</p>` : '';
  formModal({
    title: isNew ? 'Add expense' : 'Edit expense',
    note: existing,
    fields,
    after: preset.after,
    onSave: async d => {
      const files = d.bills; delete d.bills;
      const paidNow = d.paidNow; delete d.paidNow;
      let x = e;
      if (isNew) {
        x = { id: uid(), files: [], ...d };
        S.expenses.push(x);
        if (x.vendorId) {
          const paid = paidNow === '' || paidNow == null ? num(x.amount) : num(paidNow);
          if (paid > 0) S.vendorPayments.push({ id: uid(), date: x.date, vendorId: x.vendorId, amount: paid, paidBy: x.paidBy, mode: '', note: 'Paid with bill', expenseId: x.id });
        }
      } else {
        const linked = S.vendorPayments.find(p => p.expenseId === x.id);
        if (linked) {
          if (num(linked.amount) === num(x.amount)) linked.amount = d.amount;
          linked.paidBy = d.paidBy; linked.date = d.date;
          if (!d.vendorId) S.vendorPayments = S.vendorPayments.filter(p => p !== linked); else linked.vendorId = d.vendorId;
        }
        Object.assign(x, d);
      }
      if (files.length) {
        const ids = await addFiles(files, { date: x.date, title: x.desc || x.category, category: x.category, link: { type: 'expense', id: x.id } });
        x.files = [...(x.files || []), ...ids];
      }
      await save();
    }
  });
}

function deleteExpense(e) {
  confirmDel(`expense "${e.desc || e.category}" of ${money(e.amount)}${e.files && e.files.length ? ' and its attached bills' : ''}`, async () => {
    await deleteFiles(e.files || []);
    S.vendorPayments = S.vendorPayments.filter(p => p.expenseId !== e.id);
    S.expenses = S.expenses.filter(x => x !== e);
  });
}

function pageExpenses() {
  const F = UI.expFilter, r = periodRange(UI.expPeriod);
  setTools(`<button ${act(() => expenseModal())}>+ Add expense</button>`);
  const inR = S.expenses.filter(e => inPeriod(r, e.date));
  let list = inR.slice();
  const monthTotal = sum(list, e => e.amount);
  if (F.cat) list = list.filter(e => e.category === F.cat);
  if (F.paidBy) list = list.filter(e => (e.paidBy || 'business') === F.paidBy);
  if (F.vendor) list = list.filter(e => e.vendorId === F.vendor);
  if (F.q) { const q = F.q.toLowerCase(); list = list.filter(e => ((e.desc || '') + ' ' + (e.note || '')).toLowerCase().includes(q)); }
  list.sort(byDateDesc);

  const byCat = {};
  for (const e of inR) byCat[e.category] = (byCat[e.category] || 0) + num(e.amount);
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, a]) =>
    `<tr class="clickable" ${act(() => { UI.expFilter.cat = c; render(); })}><td>${esc(c)}</td><td class="num">${money(a)}</td><td class="num muted">${monthTotal ? Math.round(a / monthTotal * 100) : 0}%</td></tr>`);

  const sel = (key, opts, label) => `<div class="field"><label>${label}</label><select ${onChange(el => { F[key] = el.value; render(); })}>
    <option value="">All</option>${opts.map(o => `<option value="${esc(o.value)}" ${F[key] === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;

  const rows = list.map(e => `<tr>
    <td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td>
    <td>${esc(e.desc)}${e.note ? `<br><small class="muted">${esc(e.note)}</small>` : ''}${e.validTill ? `<br><span class="pill warn">valid till ${fmtDate(e.validTill)}</span>` : ''}${fileChips(e.files)}</td>
    <td>${e.vendorId ? esc(nameOf(S.vendors, e.vendorId)) : ''}</td><td>${esc(paidByLabel(e.paidBy))}</td>
    <td class="num">${money(e.amount)}</td>
    <td class="num"><button class="link" ${act(() => expenseModal(e))}>Edit</button><button class="link del" aria-label="Delete" title="Delete" ${act(() => deleteExpense(e))}>✕</button></td></tr>`);
  if (list.length) rows.push(`<tr class="total"><td colspan="5">Total (${list.length} entries)</td><td class="num">${money(sum(list, e => e.amount))}</td><td></td></tr>`);

  return `${periodPicker(UI.expPeriod)}
    <div class="stats">
      ${stat('Total expenses', money(monthTotal), 'accent', `${inR.length} entries`)}
      ${stat('Repairs & maintenance', money(byCat['Repairs & Maintenance'] || 0))}
      ${stat('License renewals', money(byCat['License Renewal'] || 0))}
      ${stat('Vendor bills', money(sum(inR.filter(e => e.vendorId), e => e.amount)))}
    </div>
    <div class="grid g3" style="grid-template-columns:2fr 1fr">
      <div class="card"><h2>${r.title}</h2>
        <div class="row no-print" style="margin-bottom:12px">
          ${sel('cat', catOptions(), 'Category')}
          ${sel('paidBy', paidByOptions().map(o => ({ value: o.value, label: paidByLabel(o.value) })), 'Paid from')}
          ${sel('vendor', vendorOptions().slice(1), 'Vendor')}
          <div class="field"><label>Search</label><input type="search" aria-label="Search" autocomplete="off" value="${esc(F.q)}" placeholder="Search details" ${onChange(el => { F.q = el.value.trim(); render(); })}></div>
          ${F.cat || F.paidBy || F.vendor || F.q ? `<button class="ghost" ${act(() => { UI.expFilter = { cat: '', paidBy: '', vendor: '', q: '' }; render(); })}>Clear</button>` : ''}
        </div>
        ${table(['Date', 'Category', 'Details', 'Vendor', 'Paid from', { t: 'Amount', cls: 'num' }, ''], rows, 'No expenses found')}</div>
      <div class="card"><h2>By category</h2>
        ${table(['Category', { t: 'Amount', cls: 'num' }, { t: '%', cls: 'num' }], catRows, 'No expenses')}</div>
    </div>`;
}

/* ================================================================
   VENDORS
   ================================================================ */

function vendorModal(v) {
  formModal({
    title: v ? 'Edit vendor' : 'Add vendor',
    fields: [
      { name: 'name', label: 'Vendor name', value: v && v.name, required: true },
      { name: 'phone', label: 'Phone', value: v && v.phone },
      { name: 'note', label: 'Supplies / note (e.g. vegetables, gas)', value: v && v.note, cls: 'wide' }
    ],
    onSave: async d => { if (v) Object.assign(v, d); else S.vendors.push({ id: uid(), ...d }); await save(); }
  });
}

function vendorPaymentModal(vid, after) {
  const bal = vendorBalance(vid);
  formModal({
    title: 'Pay ' + nameOf(S.vendors, vid),
    note: `<p class="hint" style="margin:0 0 12px">Pending right now: <b>${money(bal.pending)}</b></p>`,
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Amount paid', type: 'money', value: bal.pending > 0 ? round2(bal.pending) : '', required: true },
      { name: 'mode', label: 'Mode', type: 'select', options: modeOptions() },
      { name: 'paidBy', label: 'Paid from', type: 'select', options: paidByOptions() },
      { name: 'note', label: 'Note', cls: 'wide' }
    ],
    after,
    onSave: async d => { if (!d.amount) return false; S.vendorPayments.push({ id: uid(), vendorId: vid, ...d }); await save(); }
  });
}

function vendorLedger(vid) {
  const v = find(S.vendors, vid);
  if (!v) return;
  const reopen = () => vendorLedger(vid);
  const entries = [
    ...S.expenses.filter(e => e.vendorId === vid).map(e => ({ date: e.date, kind: 'bill', amount: num(e.amount), ref: e, text: e.desc || e.category })),
    ...S.vendorPayments.filter(p => p.vendorId === vid).map(p => ({ date: p.date, kind: 'pay', amount: num(p.amount), ref: p, text: [p.mode, p.note, p.paidBy && p.paidBy !== 'business' ? paidByLabel(p.paidBy) : ''].filter(Boolean).join(' · ') }))
  ].sort((a, b) => byDate(a, b) || (a.kind === 'bill' ? -1 : 1));
  let bal = 0;
  const rows = entries.map(x => {
    bal += x.kind === 'bill' ? x.amount : -x.amount;
    const del = x.kind === 'pay' ? `<button class="link del" aria-label="Delete" title="Delete" ${act(() => undoable('payment of ' + money(x.amount), () => { S.vendorPayments = S.vendorPayments.filter(p => p !== x.ref); }, reopen))}>✕</button>` : '';
    return `<tr><td>${fmtDate(x.date)}</td><td>${x.kind === 'bill' ? '<span class="pill bad">Bill</span>' : '<span class="pill good">Payment</span>'} ${esc(x.text)}${x.kind === 'bill' ? fileChips(x.ref.files) : ''}</td>
      <td class="num">${x.kind === 'bill' ? money(x.amount) : ''}</td><td class="num">${x.kind === 'pay' ? money(x.amount) : ''}</td>
      <td class="num"><b>${money(bal)}</b></td><td class="num">${del}</td></tr>`;
  }).reverse();
  const b = vendorBalance(vid);
  openModal(`<h3>${esc(v.name)} ${v.phone ? `<span class="muted" style="font-weight:400">· ${esc(v.phone)}</span>` : ''}</h3>
    <div class="stats">${stat('Total bills', money(b.billed))}${stat('Total paid', money(b.paid))}${stat('Pending', money(b.pending), b.pending > 0 ? 'bad' : 'good')}</div>
    <div class="row" style="margin-bottom:10px">
      <button ${act(() => vendorPaymentModal(vid, reopen))}>Record payment</button>
      <button class="ghost" ${act(() => expenseModal(null, { vendorId: vid, after: reopen }))}>+ Add bill</button>
      <span class="spacer" style="flex:1"></span><button class="ghost" ${act(closeModal)}>Close</button></div>
    ${table(['Date', 'Details', { t: 'Bill', cls: 'num' }, { t: 'Paid', cls: 'num' }, { t: 'Balance', cls: 'num' }, ''], rows, 'No bills or payments yet')}`, true);
}

function pageVendors() {
  setTools(`<button ${act(() => vendorModal())}>+ Add vendor</button>`);
  const r = periodRange(UI.vendorPeriod);
  const list = S.vendors.map(v => ({ v, ...vendorBalance(v.id),
    month: sum(S.expenses.filter(e => e.vendorId === v.id && inPeriod(r, e.date)), e => e.amount),
    paidIn: sum(S.vendorPayments.filter(p => p.vendorId === v.id && inPeriod(r, p.date)), p => p.amount) }))
    .sort((a, b) => b.pending - a.pending);
  const rows = list.map(x => `<tr class="clickable" ${act(() => vendorLedger(x.v.id))}>
    <td><b>${esc(x.v.name)}</b>${x.v.note ? `<br><small class="muted">${esc(x.v.note)}</small>` : ''}</td><td>${esc(x.v.phone)}</td>
    <td class="num">${money(x.month)}</td><td class="num">${money(x.paidIn)}</td><td class="num muted">${money(x.billed)}</td><td class="num muted">${money(x.paid)}</td>
    <td class="num"><b class="${x.pending > 0 ? 'neg' : ''}">${money(x.pending)}</b></td>
    <td class="num"><button class="link" ${act((el, ev) => { ev.stopPropagation(); vendorModal(x.v); })}>Edit</button>
      <button class="link del" aria-label="Delete" title="Delete" ${act((el, ev) => { ev.stopPropagation(); deleteVendor(x.v); })}>✕</button></td></tr>`);
  if (list.length) rows.push(`<tr class="total"><td colspan="2">Total</td><td class="num">${money(sum(list, x => x.month))}</td><td class="num">${money(sum(list, x => x.paidIn))}</td><td class="num">${money(sum(list, x => x.billed))}</td><td class="num">${money(sum(list, x => x.paid))}</td><td class="num">${money(sum(list, x => x.pending))}</td><td></td></tr>`);
  return `${periodPicker(UI.vendorPeriod)}
    <div class="stats">
      ${stat('Bills in period', money(sum(list, x => x.month)), 'accent', r.title)}
      ${stat('Paid in period', money(sum(list, x => x.paidIn)))}
      ${stat('Pending now (all time)', money(sum(list, x => Math.max(0, x.pending))), sum(list, x => x.pending) > 0 ? 'bad' : '')}
    </div>
    <div class="card"><h2>All vendors</h2>
    <p class="hint">Click a vendor to see every bill and payment and to record a payment. Add vendor bills from the Expenses page or Daily Entry by choosing the vendor.</p>
    ${table(['Vendor', 'Phone', { t: 'Bills in period', cls: 'num' }, { t: 'Paid in period', cls: 'num' }, { t: 'All bills', cls: 'num' }, { t: 'All paid', cls: 'num' }, { t: 'Pending', cls: 'num' }, ''], rows, 'No vendors yet – add your first vendor')}</div>`;
}

function deleteVendor(v) {
  if (S.expenses.some(e => e.vendorId === v.id) || S.vendorPayments.some(p => p.vendorId === v.id)) {
    alert('This vendor has bills or payments recorded. Delete those first, or keep the vendor.');
    return;
  }
  confirmDel('vendor ' + v.name, () => { S.vendors = S.vendors.filter(x => x !== v); });
}

/* ================================================================
   HELPERS (STAFF)
   ================================================================ */

function helperModal(h) {
  formModal({
    title: h ? 'Edit helper' : 'Add helper',
    fields: [
      { name: 'name', label: 'Name', value: h && h.name, required: true },
      { name: 'phone', label: 'Phone', value: h && h.phone },
      { name: 'salary', label: 'Monthly salary', type: 'money', value: h && h.salary, required: true },
      { name: 'from', label: 'Working from', type: 'date', value: (h && h.from) || today() },
      { name: 'till', label: 'Left on (leave blank if working)', type: 'date', value: h && h.till }
    ],
    onSave: async d => { if (h) Object.assign(h, d); else S.helpers.push({ id: uid(), ...d }); await save(); }
  });
}

function helperTxModal(h, type) {
  const ym = UI.helperMonth;
  const m = helperMonth(h, ym);
  const fields = [
    { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
    { name: 'amount', label: 'Amount', type: 'money', required: true, value: type === 'salary' && m.due > 0 ? m.due : '' }
  ];
  if (type !== 'bonus') {
    fields.push({ name: 'type', label: 'Payment type', type: 'select', value: type, options: [{ value: 'salary', label: 'Salary' }, { value: 'advance', label: 'Advance' }] });
    fields.push({ name: 'month', label: 'Counts toward salary of', type: 'month', value: ym, required: true });
  }
  fields.push({ name: 'note', label: 'Note', cls: 'wide' });
  formModal({
    title: (type === 'bonus' ? 'Daily bonus – ' : 'Pay salary – ') + h.name,
    note: type !== 'bonus' ? `<p class="hint" style="margin:0 0 12px">${monthName(ym)}: salary ${money(m.salary)}, already paid ${money(m.paid)}, due <b>${money(m.due)}</b></p>` : '',
    fields,
    onSave: async d => {
      if (!d.amount) return false;
      S.helperTx.push({ id: uid(), helperId: h.id, type, month: d.month || d.date.slice(0, 7), ...d });
      await save();
    }
  });
}

function pageHelpers() {
  const ym = UI.helperMonth;
  setTools(`${monthPicker(ym, m => { UI.helperMonth = m; render(); })}<button ${act(() => helperModal())}>+ Add helper</button>`);
  const rows = S.helpers.map(h => {
    const m = helperMonth(h, ym);
    const active = helperActiveInMonth(h, ym);
    return `<tr>
      <td><b>${esc(h.name)}</b> ${active ? '' : '<span class="pill">not working this month</span>'}<br><small class="muted">${esc(h.phone || '')} ${h.from ? '· since ' + fmtDate(h.from) : ''}${h.till ? ' · left ' + fmtDate(h.till) : ''}</small></td>
      <td class="num">${money(m.salary)}</td><td class="num">${money(m.bonus)}</td><td class="num">${money(m.salary + m.bonus)}</td>
      <td class="num">${money(m.paid)}</td><td class="num"><b class="${m.due > 0 ? 'neg' : ''}">${money(m.due)}</b></td>
      <td class="num" style="white-space:nowrap">
        <button class="sm ghost" ${act(() => helperTxModal(h, 'bonus'))}>+ Bonus</button>
        <button class="sm" ${act(() => helperTxModal(h, 'salary'))}>Pay</button>
        <button class="link" ${act(() => helperModal(h))}>Edit</button>
        <button class="link del" aria-label="Delete" title="Delete" ${act(() => deleteHelper(h))}>✕</button></td></tr>`;
  });
  const ms = S.helpers.map(h => helperMonth(h, ym));
  if (S.helpers.length) rows.push(`<tr class="total"><td>Total</td><td class="num">${money(sum(ms, m => m.salary))}</td><td class="num">${money(sum(ms, m => m.bonus))}</td><td class="num">${money(sum(ms, m => m.salary + m.bonus))}</td><td class="num">${money(sum(ms, m => m.paid))}</td><td class="num">${money(sum(ms, m => m.due))}</td><td></td></tr>`);

  const tx = S.helperTx.filter(t => t.type === 'bonus' ? t.date.startsWith(ym) : (t.month || t.date.slice(0, 7)) === ym).sort(byDateDesc);
  const txRows = tx.map(t => `<tr><td>${fmtDate(t.date)}</td><td>${esc(nameOf(S.helpers, t.helperId))}</td>
    <td><span class="pill ${t.type === 'bonus' ? 'accent' : t.type === 'advance' ? 'warn' : 'good'}">${t.type}</span> ${esc(t.note)}</td>
    <td class="num">${money(t.amount)}</td><td class="num"><button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this entry', () => { S.helperTx = S.helperTx.filter(x => x !== t); }))}>✕</button></td></tr>`);

  return `<div class="card"><h2>Salary sheet · ${monthName(ym)}</h2>
    <p class="hint">Bonus is paid daily and added to the day's expenses. Salary and advances are counted against the month you choose when paying. "Due" = monthly salary − paid.</p>
    ${table(['Helper', { t: 'Monthly salary', cls: 'num' }, { t: 'Bonuses', cls: 'num' }, { t: 'Total earned', cls: 'num' }, { t: 'Salary paid', cls: 'num' }, { t: 'Salary due', cls: 'num' }, ''], rows, 'No helpers yet')}</div>
    <div class="card"><h2>Payments &amp; bonuses · ${monthName(ym)}</h2>
    ${table(['Date', 'Helper', 'Type', { t: 'Amount', cls: 'num' }, ''], txRows, 'No entries this month')}</div>`;
}

function deleteHelper(h) {
  if (S.helperTx.some(t => t.helperId === h.id)) {
    alert(`${h.name} has payments recorded. To stop counting their salary, edit the helper and set the "Left on" date instead.`);
    return;
  }
  confirmDel('helper ' + h.name, () => { S.helpers = S.helpers.filter(x => x !== h); });
}

/* ================================================================
   OWNERS
   ================================================================ */

function ownerModal(o) {
  formModal({
    title: o ? 'Edit owner' : 'Add owner',
    fields: [
      { name: 'name', label: 'Owner name', value: o && o.name, required: true },
      { name: 'share', label: 'Share of month-end profit (%)', type: 'number', value: o ? o.share : '', required: true }
    ],
    onSave: async d => { if (o) Object.assign(o, d); else S.owners.push({ id: uid(), ...d }); await save(); }
  });
}

function ownerTxModal(type, ownerId, preset = {}) {
  const titles = { withdraw: 'Amount taken from daily profit', share: 'Pay month-end profit share', reimburse: 'Repay owner for pocket expenses' };
  const fields = [
    { name: 'ownerId', label: 'Owner', type: 'select', options: ownerOptions(), value: ownerId },
    { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
    { name: 'amount', label: 'Amount', type: 'money', value: preset.amount, required: true }
  ];
  if (type === 'share') fields.push({ name: 'month', label: 'Profit share for month', type: 'month', value: preset.month || UI.ownerMonth, required: true });
  fields.push({ name: 'note', label: 'Note', cls: 'wide' });
  formModal({
    title: titles[type], fields,
    onSave: async d => {
      if (!d.amount) return false;
      S.ownerTx.push({ id: uid(), type, month: d.month || d.date.slice(0, 7), ...d });
      await save();
    }
  });
}

function pageOwners() {
  setTools(`<button ${act(() => ownerModal())}>+ Add owner</button>`);
  const totalShare = sum(S.owners, o => o.share);
  const ym = UI.ownerMonth;
  const sh = ownerShares(ym);

  const ownerRows = S.owners.map(o => `<tr><td><b>${esc(o.name)}</b></td><td class="num">${num(o.share)}%</td>
    <td class="num"><button class="link" ${act(() => ownerModal(o))}>Edit</button><button class="link del" aria-label="Delete" title="Delete" ${act(() => deleteOwner(o))}>✕</button></td></tr>`);

  // pocket expenses
  const pocketCards = S.owners.map(o => {
    const p = ownerPocket(o.id);
    return `<div class="stat"><div class="label">${esc(o.name)} – spent from own pocket</div>
      <div class="value">${money(p.spent)}</div>
      <div class="sub">Repaid ${money(p.repaid)} · <b class="${p.unpaid > 0 ? 'neg' : 'pos'}">Unpaid ${money(p.unpaid)}</b></div>
      <div class="row" style="margin-top:8px"><button class="sm" ${act(() => expenseModal(null, { paidBy: o.id }))}>+ Pocket expense</button>
      <button class="sm ghost" ${act(() => ownerTxModal('reimburse', o.id, { amount: p.unpaid > 0 ? round2(p.unpaid) : '' }))}>Repay</button></div></div>`;
  }).join('');

  const pocketEntries = S.owners.flatMap(o => {
    const p = ownerPocket(o.id);
    return [
      ...p.exps.map(e => ({ date: e.date, o, kind: 'spent', amount: e.amount, text: `${e.category}${e.desc ? ' – ' + e.desc : ''}`, files: e.files })),
      ...p.vpays.map(v => ({ date: v.date, o, kind: 'spent', amount: v.amount, text: 'Paid vendor ' + nameOf(S.vendors, v.vendorId) })),
      ...S.ownerTx.filter(t => t.type === 'reimburse' && t.ownerId === o.id).map(t => ({ date: t.date, o, kind: 'repaid', amount: t.amount, text: t.note || 'Repaid by business', ref: t }))
    ];
  }).sort(byDateDesc).slice(0, 60);
  const pocketRows = pocketEntries.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.o.name)}</td>
    <td>${x.kind === 'spent' ? '<span class="pill bad">Spent</span>' : '<span class="pill good">Repaid</span>'} ${esc(x.text)}${fileChips(x.files)}</td>
    <td class="num">${money(x.amount)}</td>
    <td class="num">${x.ref ? `<button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this repayment', () => { S.ownerTx = S.ownerTx.filter(t => t !== x.ref); }))}>✕</button>` : ''}</td></tr>`);

  // drawings & share
  const shareRows = sh.rows.map(r => `<tr><td><b>${esc(r.o.name)}</b> <span class="muted">(${num(r.o.share)}%)</span></td>
    <td class="num">${money(r.drawn)}</td><td class="num">${money(r.share)}</td><td class="num"><b>${money(r.total)}</b></td>
    <td class="num">${money(r.sharePaid)}</td><td class="num"><b class="${r.shareDue > 0 ? 'neg' : ''}">${money(r.shareDue)}</b></td>
    <td class="num"><button class="sm" ${act(() => ownerTxModal('share', r.o.id, { amount: r.shareDue > 0 ? round2(r.shareDue) : '', month: ym }))}>Pay share</button></td></tr>`);

  const txList = S.ownerTx.filter(t => t.type !== 'reimburse' && (t.type === 'share' ? t.month === ym : t.date.startsWith(ym))).sort(byDateDesc);
  const txRows = txList.map(t => `<tr><td>${fmtDate(t.date)}</td><td>${esc(nameOf(S.owners, t.ownerId))}</td>
    <td>${t.type === 'withdraw' ? '<span class="pill accent">Daily withdrawal</span>' : '<span class="pill good">Month-end share</span>'} ${esc(t.note)}</td>
    <td class="num">${money(t.amount)}</td><td class="num"><button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('this entry', () => { S.ownerTx = S.ownerTx.filter(x => x !== t); }))}>✕</button></td></tr>`);

  return `${S.owners.length && Math.abs(totalShare - 100) > 0.01 ? notice('shares', 'warn', `Owner shares add up to ${totalShare}% – they should add up to 100%.`) : ''}
  <div class="grid g3" style="grid-template-columns:1fr 2fr">
    <div class="card"><h2>Owners &amp; profit share</h2>
      ${table(['Owner', { t: 'Share', cls: 'num' }, ''], ownerRows, 'Add the owners first')}</div>
    <div class="card"><h2>Money spent from owners' own pockets</h2>
      <p class="hint">Any expense entered with "Paid from: owner's own pocket" shows here. Record a repayment when the business pays them back.</p>
      <div class="stats" style="margin:0">${pocketCards || '<div class="empty">No owners yet</div>'}</div></div>
  </div>
  <div class="card"><h2>Drawings &amp; month-end profit share<span class="spacer"></span>${monthPicker(ym, m => { UI.ownerMonth = m; render(); })}</h2>
    <div class="stats">
      ${stat('Net profit of the month', money(sh.f.net), sh.f.net >= 0 ? 'good' : 'bad')}
      ${stat('Taken daily by owners', money(sh.f.withdrawn))}
      ${stat('Profit left at month end', money(sh.remaining), sh.remaining >= 0 ? 'accent' : 'bad', 'Shared as per owner %')}
    </div>
    ${sh.remaining < 0 ? notice('overdrawn-' + ym, 'bad', `Owners have taken more than the month's net profit by ${money(-sh.remaining)}. Their share shows as negative (to be adjusted).`) : ''}
    ${thisMonth() === ym ? `<p class="hint">This month is still running – the share will change until the month ends.</p>` : ''}
    ${S.owners.length ? `<div class="row no-print" style="margin-bottom:12px"><button class="ghost" ${act(() => ownerTxModal('withdraw', S.owners[0].id))}>+ Record amount taken</button></div>` : ''}
    ${table(['Owner', { t: 'Taken daily', cls: 'num' }, { t: 'Month-end share', cls: 'num' }, { t: 'Total for owner', cls: 'num' }, { t: 'Share paid', cls: 'num' }, { t: 'Share to pay', cls: 'num' }, ''], shareRows, 'No owners yet')}
    <h2 style="margin-top:18px">Entries · ${monthName(ym)}</h2>
    ${table(['Date', 'Owner', 'Type', { t: 'Amount', cls: 'num' }, ''], txRows, 'No withdrawals this month')}</div>
  <div class="card"><h2>Pocket expenses &amp; repayments (latest 60)</h2>
    ${table(['Date', 'Owner', 'Details', { t: 'Amount', cls: 'num' }, ''], pocketRows, 'No pocket expenses yet')}</div>`;
}

function deleteOwner(o) {
  const used = S.ownerTx.some(t => t.ownerId === o.id) || S.expenses.some(e => e.paidBy === o.id) || S.vendorPayments.some(p => p.paidBy === o.id);
  if (used) { alert(`${o.name} has entries recorded and cannot be deleted. You can set their share to 0% instead.`); return; }
  confirmDel('owner ' + o.name, () => { S.owners = S.owners.filter(x => x !== o); });
}

/* ================================================================
   CUSTOMER CREDIT
   ================================================================ */

/* what a customer already owed before they were added to the app – kept as one
   credit entry marked "opening", which is not counted as that day's sales */
const openingEntry = cid => S.creditTx.find(t => t.customerId === cid && t.opening);

function customerModal(c) {
  const open = c && openingEntry(c.id);
  formModal({
    title: c ? 'Edit customer' : 'Add regular customer',
    fields: [
      { name: 'name', label: 'Customer name', value: c && c.name, required: true },
      { name: 'phone', label: 'Phone', type: 'tel', value: c && c.phone },
      { name: 'owes', label: 'Already owes (optional)', type: 'money', raw: true, value: open ? open.amount : '', placeholder: '0' },
      { name: 'note', label: 'Note (e.g. works at, room no.)', value: c && c.note, cls: 'wide' }
    ],
    onSave: async d => {
      const owes = num(d.owes); delete d.owes;
      if (owes < 0) { alert('The amount owed cannot be negative.'); return false; }
      let x = c;
      if (x) Object.assign(x, d); else S.customers.push(x = { id: uid(), ...d });
      const o = openingEntry(x.id);
      if (owes > 0 && o) o.amount = owes;
      else if (owes > 0) S.creditTx.push({ id: uid(), customerId: x.id, type: 'credit', opening: true, date: today(), amount: owes, note: 'Old balance (before the app)' });
      else if (o) S.creditTx = S.creditTx.filter(t => t !== o);
      await save();
    }
  });
}

/* add a credit / payment, or edit an existing entry t */
function creditTxModal(cid, type, after, t) {
  const b = customerBalance(cid);
  const fields = [
    { name: 'date', label: 'Date', type: 'date', value: t ? t.date : today(), required: true },
    { name: 'amount', label: 'Amount', type: 'money', required: true, value: t ? t.amount : type === 'payment' && b.pending > 0 ? round2(b.pending) : '' }
  ];
  if (type === 'payment') fields.push({ name: 'mode', label: 'Paid by', type: 'select', options: modeOptions(), value: t && t.mode });
  fields.push({ name: 'note', label: type === 'credit' ? 'What was taken' : 'Note', cls: 'wide', value: t && t.note });
  const who = nameOf(S.customers, cid);
  formModal({
    title: t ? `Edit ${type === 'credit' ? 'credit' : 'payment'} – ${who}` : (type === 'credit' ? 'Give credit to ' : 'Payment from ') + who,
    note: `<p class="hint" style="margin:0 0 12px">Pending right now: <b>${money(b.pending)}</b></p>`,
    fields, after,
    onSave: async d => {
      if (!d.amount) return false;
      if (t) Object.assign(t, d); else S.creditTx.push({ id: uid(), customerId: cid, type, ...d });
      await save();
    }
  });
}

function customerLedger(cid) {
  const c = find(S.customers, cid);
  if (!c) return;
  const reopen = () => customerLedger(cid);
  let bal = 0;
  const rows = S.creditTx.filter(t => t.customerId === cid).sort((a, b) => byDate(a, b) || (a.type === 'credit' ? -1 : 1)).map(t => {
    bal += t.type === 'credit' ? num(t.amount) : -num(t.amount);
    const label = t.opening ? '<span class="pill warn">Old balance</span>' : t.type === 'credit' ? '<span class="pill bad">Credit taken</span>' : `<span class="pill good">Paid · ${esc(t.mode || '')}</span>`;
    return `<tr><td>${fmtDate(t.date)}</td><td>${label} ${t.opening ? '' : esc(t.note)}</td>
      <td class="num">${t.type === 'credit' ? money(t.amount) : ''}</td><td class="num">${t.type === 'payment' ? money(t.amount) : ''}</td>
      <td class="num"><b>${money(bal)}</b></td>
      <td class="num" style="white-space:nowrap"><button class="link" ${act(() => creditTxModal(cid, t.type, reopen, t))}>Edit</button>
        <button class="link del" aria-label="Delete" title="Delete" ${act(() => undoable('entry of ' + money(t.amount), () => { S.creditTx = S.creditTx.filter(x => x !== t); }, reopen))}>✕</button></td></tr>`;
  }).reverse();
  const b = customerBalance(cid);
  openModal(`<h3>${esc(c.name)} ${c.phone ? `<span class="muted" style="font-weight:400">· ${esc(c.phone)}</span>` : ''}</h3>
    <div class="stats">${stat('Total credit taken', money(b.credit))}${stat('Total paid', money(b.paid))}${stat('Left to pay', money(b.pending), b.pending > 0 ? 'bad' : 'good')}</div>
    <div class="row" style="margin-bottom:10px">
      <button ${act(() => creditTxModal(cid, 'payment', reopen))}>Record payment</button>
      <button class="ghost" ${act(() => creditTxModal(cid, 'credit', reopen))}>+ Give credit</button>
      <span style="flex:1"></span><button class="ghost" ${act(closeModal)}>Close</button></div>
    ${table(['Date', 'Details', { t: 'Credit', cls: 'num' }, { t: 'Paid', cls: 'num' }, { t: 'Balance', cls: 'num' }, ''], rows, 'No entries yet')}`, true);
}

function pageCredit() {
  setTools(`<button ${act(() => customerModal())}>+ Add customer</button>`);
  const r = periodRange(UI.creditPeriod);
  const inR = S.creditTx.filter(t => !t.opening && inPeriod(r, t.date));
  const list = S.customers.map(c => ({ c, ...customerBalance(c.id),
    givenIn: sum(inR.filter(t => t.customerId === c.id && t.type === 'credit'), t => t.amount),
    paidIn: sum(inR.filter(t => t.customerId === c.id && t.type === 'payment'), t => t.amount) })).sort((a, b) => b.pending - a.pending);
  const rows = list.map(x => `<tr class="clickable" ${act(() => customerLedger(x.c.id))}>
    <td><b>${esc(x.c.name)}</b>${x.c.note ? `<br><small class="muted">${esc(x.c.note)}</small>` : ''}</td><td>${esc(x.c.phone)}</td>
    <td class="num">${money(x.givenIn)}</td><td class="num">${money(x.paidIn)}</td>
    <td class="num muted">${money(x.credit)}</td><td class="num muted">${money(x.paid)}</td>
    <td class="num"><b class="${x.pending > 0 ? 'neg' : ''}">${money(x.pending)}</b></td>
    <td>${x.lastPay ? `${fmtDate(x.lastPay.date)} · ${money(x.lastPay.amount)}` : '<span class="muted">never</span>'}</td>
    <td class="num" style="white-space:nowrap"><button class="sm" ${act((el, ev) => { ev.stopPropagation(); creditTxModal(x.c.id, 'payment'); })}>Payment</button>
      <button class="sm ghost" ${act((el, ev) => { ev.stopPropagation(); creditTxModal(x.c.id, 'credit'); })}>+ Credit</button>
      <button class="link" ${act((el, ev) => { ev.stopPropagation(); customerModal(x.c); })}>Edit</button>
      <button class="link del" aria-label="Delete" title="Delete" ${act((el, ev) => { ev.stopPropagation(); deleteCustomer(x.c); })}>✕</button></td></tr>`);
  const pending = sum(list, x => Math.max(0, x.pending));
  return `${periodPicker(UI.creditPeriod)}
    <div class="stats">
      ${stat('Total to collect', money(pending), pending > 0 ? 'bad' : '')}
      ${stat('Customers with dues', String(list.filter(x => x.pending > 0).length))}
      ${stat('Credit given', money(sum(inR.filter(t => t.type === 'credit'), t => t.amount)), '', r.title)}
      ${stat('Collected', money(sum(inR.filter(t => t.type === 'payment'), t => t.amount)), '', r.title)}
    </div>
    <div class="card"><h2>Regular customers</h2>
    <p class="hint">Click a customer to see every credit and payment with dates and the running balance.</p>
    ${table(['Customer', 'Phone', { t: 'Credit in period', cls: 'num' }, { t: 'Paid in period', cls: 'num' }, { t: 'All credit', cls: 'num' }, { t: 'All paid', cls: 'num' }, { t: 'Left to pay', cls: 'num' }, 'Last payment', ''], rows, 'No customers yet')}</div>`;
}

function deleteCustomer(c) {
  if (S.creditTx.some(t => t.customerId === c.id)) { alert(`${c.name} has credit entries recorded. Delete those first.`); return; }
  confirmDel('customer ' + c.name, () => { S.customers = S.customers.filter(x => x !== c); });
}

/* ================================================================
   ITEM SALES
   ================================================================ */

function itemModal(it) {
  formModal({
    title: it ? 'Edit menu item' : 'Add menu item',
    fields: [
      { name: 'name', label: 'Item name', value: it && it.name, required: true },
      { name: 'price', label: 'Selling price', type: 'money', value: it && it.price, required: true },
      { name: 'dailyPrice', type: 'checkbox', value: it && it.dailyPrice, cls: 'wide',
        label: 'Price changes every day (e.g. fish, at market price)',
        hint: "Daily Entry will ask for today's price, filled in with the last price you used. The selling price above is used until then." }
    ],
    onSave: async d => { if (it) Object.assign(it, d); else S.items.push({ id: uid(), ...d }); await save(); }
  });
}

/* the price an item sells at on a day: what was saved for that day, else the last price used before it
   (for items whose price changes daily), else the menu price */
function itemRateOn(it, date) {
  const past = S.itemSales.filter(x => x.itemId === it.id && x.date <= date && num(x.rate) > 0).sort(byDateDesc)[0];
  if (past && (past.date === date || it.dailyPrice)) return { rate: num(past.rate), from: past.date };
  return { rate: num(it.price), from: null };
}

function itemSummary(list) {
  const map = {};
  for (const x of list) {
    const k = x.itemId;
    if (!map[k]) map[k] = { name: x.name, qty: 0, amount: 0, days: new Set() };
    map[k].qty += num(x.qty);
    map[k].amount += num(x.qty) * num(x.rate);
    map[k].days.add(x.date);
    const cur = find(S.items, k);
    if (cur) map[k].name = cur.name;
  }
  return Object.values(map).sort((a, b) => b.amount - a.amount);
}

function pageItems() {
  const d = UI.itemDate, r = periodRange(UI.itemPeriod);
  const go = v => { UI.itemDate = v; render(); };
  setTools(`<button class="ghost" ${act(() => go(addDays(d, -1)))}>‹</button>
    <input type="date" aria-label="Day" value="${d}" style="width:160px" ${onChange(el => el.value && go(el.value))}>
    <button class="ghost" ${act(() => go(addDays(d, 1)))}>›</button>
    <button ${act(() => { UI.date = d; location.hash = 'daily'; })}>Enter quantities</button>`);

  const day = itemSummary(S.itemSales.filter(x => x.date === d));
  const dayRows = day.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.qty}</td><td class="num">${money(r.qty ? r.amount / r.qty : 0)}</td><td class="num">${money(r.amount)}</td></tr>`);
  if (day.length) dayRows.push(`<tr class="total"><td>Total</td><td class="num">${sum(day, r => r.qty)}</td><td></td><td class="num">${money(sum(day, r => r.amount))}</td></tr>`);

  const mon = itemSummary(S.itemSales.filter(x => inPeriod(r, x.date)));
  const monTotal = sum(mon, r => r.amount);
  const monRows = mon.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.qty}</td><td class="num">${r.days.size}</td>
    <td class="num">${(r.qty / Math.max(1, r.days.size)).toFixed(1)}</td><td class="num">${money(r.amount)}</td>
    <td class="num muted">${monTotal ? Math.round(r.amount / monTotal * 100) : 0}%</td></tr>`);

  const menuRows = S.items.map(it => `<tr><td>${esc(it.name)}${it.dailyPrice ? ' <span class="pill warn">price changes daily</span>' : ''}</td>
    <td class="num">${it.dailyPrice ? (() => { const r = itemRateOn(it, today()); return `${money(r.rate)}${r.from ? `<br><small class="muted">last used ${fmtDate(r.from)}</small>` : ''}`; })() : money(it.price)}</td>
    <td class="num"><button class="link" ${act(() => itemModal(it))}>Edit</button>
    <button class="link del" aria-label="Delete" title="Delete" ${act(() => confirmDel('menu item ' + it.name, () => { S.items = S.items.filter(x => x !== it); }))}>✕</button></td></tr>`);

  return `${periodPicker(UI.itemPeriod)}
  <div class="grid g2">
    <div>
      <div class="card"><h2>Items sold · ${fmtDay(d)}</h2>
        ${table(['Item', { t: 'Qty', cls: 'num' }, { t: 'Rate', cls: 'num' }, { t: 'Amount', cls: 'num' }], dayRows, 'No item quantities entered for this day')}</div>
      <div class="card"><h2>Summary · ${r.title}</h2>
        ${table(['Item', { t: 'Total qty', cls: 'num' }, { t: 'Days sold', cls: 'num' }, { t: 'Avg / day', cls: 'num' }, { t: 'Amount', cls: 'num' }, { t: '%', cls: 'num' }], monRows, 'No item sales in this period')}</div>
    </div>
    <div class="card"><h2>Menu items<span class="spacer"></span><button class="sm" ${act(() => itemModal())}>+ Add item</button></h2>
      <p class="hint">Changing a price affects only new entries; past days keep the price they were saved with.</p>
      ${table(['Item', { t: 'Price', cls: 'num' }, ''], menuRows, 'No menu items yet')}</div>
  </div>`;
}

/* ================================================================
   BILLS & DOCUMENTS
   ================================================================ */

const urlCache = {};
async function fileURL(id) {
  if (urlCache[id]) return urlCache[id];
  const b = await getBlob(id);
  if (!b) return null;
  return (urlCache[id] = URL.createObjectURL(b));
}

async function loadThumbs() {
  for (const el of document.querySelectorAll('[data-thumb]')) {
    const id = el.dataset.thumb;
    el.removeAttribute('data-thumb');
    const url = await fileURL(id);
    if (url && el.isConnected) el.innerHTML = `<img src="${url}" alt="">`;
  }
}

async function viewFile(id) {
  const f = find(S.files, id);
  if (!f) return;
  const url = await fileURL(id);
  if (!url) { alert('File data not found.'); return; }
  const linked = f.link && f.link.type === 'expense' ? find(S.expenses, f.link.id) : null;
  // the phone's web view cannot show PDFs inside the app, so they open through the share sheet
  const body = f.type.startsWith('image/') ? `<img class="preview" src="${url}" alt="">`
    : f.type === 'application/pdf' && !isApp ? `<iframe class="preview" src="${url}"></iframe>`
    : `<p class="muted">${isApp ? 'Tap <b>Open / share</b> to view this file in another app.' : 'Preview not available.'}</p>`;
  openModal(`<h3>${esc(f.title || f.name)}</h3>
    <p class="hint" style="margin:0 0 10px">${fmtDate(f.date)} · ${esc(f.category)} · ${(f.size / 1024).toFixed(0)} KB
      ${linked ? ` · linked to expense of ${money(linked.amount)}` : ''}</p>
    ${body}
    <div class="actions"><button class="danger" ${act(() => {
      closeModal();
      undoable('file "' + (f.title || f.name) + '"', () => deleteFiles([id]));
    })}>Delete file</button>
    <button class="ghost" ${act(async () => saveFile(await getBlob(id), f.name))}>${isApp ? 'Open / share' : 'Download'}</button>
    <button ${act(closeModal)}>Close</button></div>`, true);
}

function uploadDocModal() {
  formModal({
    title: 'Upload bill / document',
    fields: [
      { name: 'title', label: 'Title (e.g. FSSAI license 2026, Shop Act)', required: true, cls: 'wide' },
      { name: 'category', label: 'Category', type: 'select', options: [...['License / Certificate', 'Bill', 'Agreement', 'Warranty', 'Other'], ...S.settings.categories].map(c => ({ value: c, label: c })) },
      { name: 'date', label: 'Date', type: 'date', value: today() },
      { name: 'files', label: 'Files', type: 'file', cls: 'wide' }
    ],
    onSave: async d => {
      if (!d.files.length) { alert('Choose at least one file.'); return false; }
      await addFiles(d.files, { title: d.title, category: d.category, date: d.date });
      await save();
    }
  });
}

function pageBills() {
  const F = UI.billFilter;
  setTools(`<button ${act(uploadDocModal)}>+ Upload document</button>`);
  let list = S.files.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (F.cat) list = list.filter(f => f.category === F.cat);
  const r = periodRange(UI.billPeriod);
  list = list.filter(f => inPeriod(r, f.date));
  if (F.q) { const q = F.q.toLowerCase(); list = list.filter(f => (f.title + ' ' + f.name).toLowerCase().includes(q)); }
  const cats = [...new Set(S.files.map(f => f.category))].sort();
  const totalKB = sum(S.files, f => f.size) / 1024;
  const cards = list.map(f => `<div class="file-card">
    <div class="thumb" ${act(() => viewFile(f.id))} ${f.type.startsWith('image/') ? `data-thumb="${f.id}"` : ''}>${f.type === 'application/pdf' ? '📄' : '🖼️'}</div>
    <div class="meta"><b title="${esc(f.title)}">${esc(f.title || f.name)}</b>
      <span class="muted">${fmtDate(f.date)}</span><br><span class="pill">${esc(f.category)}</span></div></div>`).join('');
  return `${periodPicker(UI.billPeriod, { all: true })}
  <div class="card">
    <p class="hint">Bills attached to expenses appear here automatically. Upload licenses, agreements and other papers with the button above.</p>
    <div class="row no-print" style="margin-bottom:14px">
      <div class="field"><label>Category</label><select ${onChange(el => { F.cat = el.value; render(); })}><option value="">All</option>
        ${cats.map(c => `<option ${F.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label>Search</label><input type="search" aria-label="Search" autocomplete="off" value="${esc(F.q)}" placeholder="Title or file name" ${onChange(el => { F.q = el.value.trim(); render(); })}></div>
      ${F.cat || F.q || UI.billPeriod.mode !== 'all' ? `<button class="ghost" ${act(() => { UI.billFilter = { cat: '', q: '' }; UI.billPeriod = newPeriod('all'); render(); })}>Clear</button>` : ''}
    </div>
    <p class="muted" style="margin:0 0 10px">${list.length} file(s) shown · ${S.files.length} total · ${totalKB > 1024 ? (totalKB / 1024).toFixed(1) + ' MB' : totalKB.toFixed(0) + ' KB'} stored</p>
    ${list.length ? `<div class="files">${cards}</div>` : '<div class="empty">No files yet</div>'}</div>`;
}

/* ================================================================
   PROFIT REPORTS
   ================================================================ */

/* the period the reports page is showing: a week, a month, or any two dates */
/* ---------- period picker: Weekly / Monthly / Custom range (and All time where it fits) ----------
   Each page keeps its own period, so changing it on one page does not change another. */
function newPeriod(mode = 'month') { return { mode, week: today(), from: addDays(today(), -29), to: today(), month: thisMonth() }; }
function periodRange(P) {
  if (P.mode === 'all') return { from: '0000-01-01', to: '9999-12-31', title: 'All time' };
  if (P.mode === 'week') {
    const s = weekStart(P.week), e = addDays(s, 6);
    return { from: s, to: e, title: `Week of ${fmtDate(s)} – ${fmtDate(e)}` };
  }
  if (P.mode === 'custom') {
    const a = P.from <= P.to ? P.from : P.to, b = P.from <= P.to ? P.to : P.from;
    return { from: a, to: b, title: `${fmtDate(a)} – ${fmtDate(b)}` };
  }
  return { from: P.month + '-01', to: monthEnd(P.month), title: monthName(P.month) };
}
const inPeriod = (r, d) => d >= r.from && d <= r.to;
function periodPicker(P, { all = false } = {}) {
  const tab = (m, label) => `<button class="${P.mode === m ? 'on' : ''}" ${P.mode === m ? 'aria-pressed="true"' : 'aria-pressed="false"'} ${act(() => { P.mode = m; render(); })}>${label}</button>`;
  let nav = '';
  if (P.mode === 'week') {
    const s = weekStart(P.week);
    nav = `<button class="ghost" aria-label="Previous week" ${act(() => { P.week = addDays(s, -7); render(); })}>‹</button>
      <input type="date" aria-label="Week" value="${s}" style="width:160px" title="Pick any day of the week" ${onChange(el => { if (el.value) { P.week = el.value; render(); } })}>
      <button class="ghost" aria-label="Next week" ${act(() => { P.week = addDays(s, 7); render(); })}>›</button>
      ${weekStart(today()) !== s ? `<button class="ghost" ${act(() => { P.week = today(); render(); })}>This week</button>` : ''}`;
  } else if (P.mode === 'custom') {
    const t = today();
    const quick = [
      ['Last 7 days', addDays(t, -6), t], ['Last 30 days', addDays(t, -29), t], ['Last 3 months', addDays(t, -90), t],
      ['This year', t.slice(0, 4) + '-01-01', t], ['Last 12 months', addMonths(t.slice(0, 7), -11) + '-01', t]
    ];
    nav = `<div class="field" style="flex:0 0 160px"><label>From</label><input type="date" value="${P.from}" ${onChange(el => { if (el.value) { P.from = el.value; render(); } })}></div>
      <div class="field" style="flex:0 0 160px"><label>To</label><input type="date" value="${P.to}" ${onChange(el => { if (el.value) { P.to = el.value; render(); } })}></div>
      <div class="field" style="flex:0 0 170px"><label>Quick pick</label><select ${onChange(el => { const q = quick[+el.value]; if (q) { P.from = q[1]; P.to = q[2]; render(); } })}>
        <option value="">Choose…</option>${quick.map((q, i) => `<option value="${i}" ${P.from === q[1] && P.to === q[2] ? 'selected' : ''}>${q[0]}</option>`).join('')}</select></div>`;
  } else if (P.mode === 'month') {
    nav = monthPicker(P.month, m => { P.month = m; render(); });
  }
  return `<div class="card no-print" style="padding:12px 16px"><div class="row">
    <div class="tabs" style="margin:0" role="group" aria-label="Period">${tab('week', 'Weekly')}${tab('month', 'Monthly')}${tab('custom', 'Custom range')}${all ? tab('all', 'All time') : ''}</div>
    <span style="flex:1"></span>${nav}</div></div>`;
}

function reportRange() {
  const R = UI.rep;
  if (R.mode === 'week') {
    const s = weekStart(R.week), e = addDays(s, 6);
    return { from: s, to: e, title: `Week of ${fmtDate(s)} – ${fmtDate(e)}` };
  }
  if (R.mode === 'custom') {
    const a = R.from <= R.to ? R.from : R.to, b = R.from <= R.to ? R.to : R.from;
    return { from: a, to: b, title: `${fmtDate(a)} – ${fmtDate(b)}` };
  }
  return { from: UI.month + '-01', to: monthEnd(UI.month), title: monthName(UI.month) };
}

function reportControls() {
  const R = UI.rep;
  const setMode = m => { R.mode = m; render(); };
  const tab = (m, label) => `<button class="${R.mode === m ? 'on' : ''}" ${act(() => setMode(m))}>${label}</button>`;
  let nav;
  if (R.mode === 'week') {
    const s = weekStart(R.week);
    nav = `<button class="ghost" title="Previous week" ${act(() => { R.week = addDays(s, -7); render(); })}>‹</button>
      <input type="date" aria-label="Week" value="${s}" style="width:160px" title="Pick any day of the week" ${onChange(el => { if (el.value) { R.week = el.value; render(); } })}>
      <button class="ghost" title="Next week" ${act(() => { R.week = addDays(s, 7); render(); })}>›</button>
      ${weekStart(today()) !== s ? `<button class="ghost" ${act(() => { R.week = today(); render(); })}>This week</button>` : ''}`;
  } else if (R.mode === 'custom') {
    const t = today();
    const quick = [
      ['Last 7 days', addDays(t, -6), t], ['Last 30 days', addDays(t, -29), t], ['Last 3 months', addDays(t, -90), t],
      ['This year', t.slice(0, 4) + '-01-01', t], ['Last 12 months', addDays(addMonths(t.slice(0, 7), -11) + '-01', 0), t]
    ];
    nav = `<div class="field" style="flex:0 0 160px"><label>From</label><input type="date" value="${R.from}" ${onChange(el => { if (el.value) { R.from = el.value; render(); } })}></div>
      <div class="field" style="flex:0 0 160px"><label>To</label><input type="date" value="${R.to}" ${onChange(el => { if (el.value) { R.to = el.value; render(); } })}></div>
      <div class="field" style="flex:0 0 170px"><label>Quick pick</label><select ${onChange(el => { const q = quick[+el.value]; if (q) { R.from = q[1]; R.to = q[2]; render(); } })}>
        <option value="">Choose…</option>${quick.map((q, i) => `<option value="${i}" ${R.from === q[1] && R.to === q[2] ? 'selected' : ''}>${q[0]}</option>`).join('')}</select></div>`;
  } else {
    nav = monthPicker(UI.month, m => { UI.month = m; render(); });
  }
  return `<div class="card no-print" style="padding:12px 16px"><div class="row">
    <div class="tabs" style="margin:0">${tab('week', 'Weekly')}${tab('month', 'Monthly')}${tab('custom', 'Custom range')}</div>
    <span style="flex:1"></span>${nav}</div></div>`;
}

function pageReports() {
  if (!isApp) setTools(`<button class="ghost" ${act(() => window.print())}>Print</button>`);
  const R = UI.rep;
  const rg = reportRange();
  const ym = UI.month;
  // future days have no sales yet, so the graph and tables stop at today
  const upto = rg.to > today() ? today() : rg.to;
  const hasDays = rg.from <= upto;
  const f = figures(rg.from, hasDays ? upto : rg.from);
  const sh = R.mode === 'month' ? ownerShares(ym) : null;
  const group = R.group === 'auto' ? autoGroup(rg.from, upto) : R.group;
  const all = R.show === 'all';
  const pts = hasDays ? periodPoints(rg.from, upto, group, all ? x => [round2(x.business), round2(x.expenses + x.bonus + x.salary), round2(x.net)] : undefined) : [];
  const chartSeries = all
    ? [{ name: 'Business', color: '#ea580c' }, { name: 'Costs', color: '#64748b' }, { name: 'Net profit', signed: true }]
    : [{ name: 'Net profit', signed: true }];
  const dayCount = hasDays ? daysBetween(rg.from, upto) : 0;
  const groupWord = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[group];

  const plRows = [
    ['Cash sales', f.cash], ['Online sales', f.online], ['Credit sales (udhaar)', f.credit]
  ].map(([l, v]) => `<tr><td>${l}</td><td class="num">${money(v)}</td></tr>`);
  plRows.push(`<tr class="total"><td>Total business</td><td class="num">${money(f.business)}</td></tr>`);
  for (const [c, a] of Object.entries(f.byCat).sort((a, b) => b[1] - a[1])) plRows.push(`<tr><td>− ${esc(c)}</td><td class="num">${money(a)}</td></tr>`);
  plRows.push(`<tr><td>− Helper salaries paid</td><td class="num">${money(f.salary)}</td></tr>`);
  plRows.push(`<tr><td>− Helper bonuses</td><td class="num">${money(f.bonus)}</td></tr>`);
  plRows.push(`<tr class="total"><td>Net profit</td><td class="num ${signCls(f.net)}">${money(f.net)}</td></tr>`);
  plRows.push(`<tr><td>− Taken daily by owners</td><td class="num">${money(f.withdrawn)}</td></tr>`);
  if (sh) {
    plRows.push(`<tr class="total"><td>Left for month-end share</td><td class="num ${signCls(sh.remaining)}">${money(sh.remaining)}</td></tr>`);
    for (const r of sh.rows) plRows.push(`<tr><td>&nbsp;&nbsp;${esc(r.o.name)} (${num(r.o.share)}%)</td><td class="num">${money(r.share)}</td></tr>`);
  } else {
    plRows.push(`<tr class="total"><td>Left in business</td><td class="num ${signCls(f.net - f.withdrawn)}">${money(f.net - f.withdrawn)}</td></tr>`);
  }

  // clicking a row opens that day, or zooms into that week / month
  const openPoint = p => {
    if (group === 'day') { UI.date = p.date; location.hash = 'daily'; return; }
    if (group === 'week') { R.mode = 'week'; R.week = p.from; } else { R.mode = 'month'; UI.month = p.from.slice(0, 7); }
    render();
  };
  const dayRows = pts.filter(p => p.f.business || p.f.expenses || p.f.bonus).map(p => `<tr class="clickable" ${act(() => openPoint(p))}>
    <td style="white-space:nowrap">${group === 'day' ? new Date(p.date + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', weekday: 'short' }) : esc(p.label)}</td><td class="num">${money(p.f.cash)}</td><td class="num">${money(p.f.online)}</td><td class="num">${money(p.f.credit)}</td>
    <td class="num">${money(p.f.business)}</td><td class="num">${money(p.f.expenses + p.f.bonus + p.f.salary)}</td>
    <td class="num"><b class="${signCls(p.f.net)}">${money(p.f.net)}</b></td><td class="num">${money(p.f.withdrawn)}</td></tr>`);

  // yearly
  const year = UI.reportYear;
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`).filter(m => m <= thisMonth());
  const ydata = months.map(m => ({ m, f: monthFigures(m) }));
  const ypts = ydata.map(x => ({ label: monthName(x.m), short: monthShort(x.m), values: [round2(x.f.net)] }));
  const ypts2 = ydata.map(x => ({ label: monthName(x.m), short: monthShort(x.m), values: [round2(x.f.business), round2(x.f.expenses + x.f.bonus + x.f.salary)] }));
  const yRows = ydata.map(x => `<tr class="clickable" ${act(() => { UI.month = x.m; R.mode = 'month'; render(); window.scrollTo(0, 0); })}><td>${monthName(x.m)}</td>
    <td class="num">${money(x.f.business)}</td><td class="num">${money(x.f.expenses + x.f.bonus + x.f.salary)}</td>
    <td class="num"><b class="${signCls(x.f.net)}">${money(x.f.net)}</b></td><td class="num">${money(x.f.withdrawn)}</td></tr>`);
  if (ydata.length) {
    const t = k => sum(ydata, x => k(x.f));
    yRows.push(`<tr class="total"><td>Year total</td><td class="num">${money(t(f => f.business))}</td><td class="num">${money(t(f => f.expenses + f.bonus + f.salary))}</td><td class="num">${money(t(f => f.net))}</td><td class="num">${money(t(f => f.withdrawn))}</td></tr>`);
  }
  const years = [...new Set([...S.sales.map(s => s.date.slice(0, 4)), String(new Date().getFullYear())])].sort().reverse();

  const sel = (val, options, onPick, name) => `<select style="width:auto" aria-label="${name}" ${onChange(el => onPick(el.value))}>${options.map(([v, l]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const chartTools = `<span class="no-print row" style="gap:6px;font-weight:400">
    ${sel(R.show, [['profit', 'Net profit'], ['all', 'Business, costs & profit']], v => { R.show = v; render(); }, 'Show on chart')}
    ${sel(R.group, [['auto', 'Auto'], ['day', 'By day'], ['week', 'By week'], ['month', 'By month']], v => { R.group = v; render(); }, 'Group chart')}</span>`;

  return `${reportControls()}
    <div class="stats">
      ${stat('Business', money(f.business), '', `Cash ${money(f.cash)} · Online ${money(f.online)}`)}
      ${stat('All expenses', money(f.expenses + f.bonus + f.salary))}
      ${stat('Net profit', money(f.net), f.net >= 0 ? 'good' : 'bad', dayCount ? `Avg ${money(f.net / dayCount)} / day` : '')}
      ${stat('Profit margin', f.business ? Math.round(f.net / f.business * 100) + '%' : '—')}
      ${stat('Taken by owners', money(f.withdrawn))}
      ${stat('Left after owners', money(f.net - f.withdrawn), f.net - f.withdrawn >= 0 ? 'accent' : 'bad', 'Net profit − owners’ cut')}
    </div>
    <div class="card"><h2>${groupWord} ${all ? 'business, costs &amp; profit' : 'net profit'} · ${esc(rg.title)}<span class="spacer"></span>${chartTools}</h2>
      ${hasDays ? lineChart(pts, chartSeries, { height: 260 }) : '<div class="empty">This period has not started yet</div>'}</div>
    <div class="grid g3" style="grid-template-columns:1fr 2fr">
      <div class="card"><h2>Profit &amp; loss · ${esc(rg.title)}</h2>${table(['', { t: 'Amount', cls: 'num' }], plRows)}</div>
      <div class="card"><h2>${group === 'day' ? 'Day by day' : group === 'week' ? 'Week by week' : 'Month by month'}</h2>
        ${table([group === 'day' ? 'Date' : group === 'week' ? 'Week' : 'Month', { t: 'Cash', cls: 'num' }, { t: 'Online', cls: 'num' }, { t: 'Credit', cls: 'num' }, { t: 'Business', cls: 'num' }, { t: 'Costs', cls: 'num' }, { t: 'Net', cls: 'num' }, { t: 'Owners took', cls: 'num' }], dayRows, 'No entries in this period')}</div>
    </div>
    <div class="card"><h2>Year ${year}<span class="spacer"></span>
      <select style="width:110px" class="no-print" aria-label="Year" ${onChange(el => { UI.reportYear = el.value; render(); })}>${years.map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></h2>
      <div class="grid g2">
        <div><b class="muted">Monthly net profit</b>${lineChart(ypts, [{ name: 'Net profit', signed: true }])}</div>
        <div><b class="muted">Business vs costs</b>${lineChart(ypts2, [{ name: 'Business', color: '#ea580c' }, { name: 'Costs', color: '#64748b' }])}</div>
      </div>
      ${table(['Month', { t: 'Business', cls: 'num' }, { t: 'Costs', cls: 'num' }, { t: 'Net profit', cls: 'num' }, { t: 'Owners took daily', cls: 'num' }], yRows)}</div>`;
}

/* ================================================================
   SETTINGS & BACKUP
   ================================================================ */

function blobToDataURL(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}
function dataURLToBlob(u) {
  const [head, body] = u.split(',');
  const type = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function exportBackup() {
  toast('Preparing backup…');
  const blobs = {};
  for (const f of S.files) { const b = await getBlob(f.id); if (b) blobs[f.id] = await blobToDataURL(b); }
  S.settings.lastBackup = new Date().toISOString();
  await save();
  const data = JSON.stringify({ app: 'ndp-canteen', exported: S.settings.lastBackup, state: S, blobs });
  await saveFile(new Blob([data], { type: 'application/json' }), `canteen-backup-${today()}.json`);
  render();
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { alert('This is not a valid backup file.'); return; }
  if (!data || data.app !== 'ndp-canteen' || !data.state) { alert('This is not a backup from this app.'); return; }
  if (!confirm(`Restore backup from ${new Date(data.exported).toLocaleString('en-IN')}?\n\nALL current data in this app will be replaced.`)) return;
  await store.clearFiles();
  for (const [id, u] of Object.entries(data.blobs || {})) await store.putFile(id, dataURLToBlob(u));
  for (const k of Object.keys(urlCache)) { URL.revokeObjectURL(urlCache[k]); delete urlCache[k]; }
  // keep this device's sync bookkeeping, so the restored data replaces the cloud copy too
  const syncMeta = S.sync;
  S = data.state;
  S.sync = syncMeta;
  const base = defaultState();
  for (const k of Object.keys(base)) if (S[k] === undefined) S[k] = base[k];
  await save();
  toast('Backup restored');
  render();
}

function exportCSV() {
  const rows = [['Date', 'Type', 'Category', 'Details', 'Vendor / Person', 'Paid from', 'Amount']];
  for (const s of S.sales) {
    if (s.cash) rows.push([s.date, 'Sale', 'Cash', s.note || '', '', '', s.cash]);
    if (s.online) rows.push([s.date, 'Sale', 'Online', s.note || '', '', '', s.online]);
  }
  for (const e of S.expenses) rows.push([e.date, 'Expense', e.category, e.desc || '', e.vendorId ? nameOf(S.vendors, e.vendorId) : '', paidByLabel(e.paidBy), e.amount]);
  for (const p of S.vendorPayments) rows.push([p.date, 'Vendor payment', '', p.note || '', nameOf(S.vendors, p.vendorId), paidByLabel(p.paidBy), p.amount]);
  for (const t of S.helperTx) rows.push([t.date, 'Helper ' + t.type, t.month || '', t.note || '', nameOf(S.helpers, t.helperId), '', t.amount]);
  for (const t of S.ownerTx) rows.push([t.date, 'Owner ' + t.type, t.month || '', t.note || '', nameOf(S.owners, t.ownerId), '', t.amount]);
  for (const t of S.creditTx) rows.push([t.date, t.opening ? 'Customer old balance' : t.type === 'credit' ? 'Customer credit' : 'Credit payment', t.mode || '', t.note || '', nameOf(S.customers, t.customerId), '', t.amount]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  saveFile(new Blob(['﻿' + csv], { type: 'text/csv' }), `canteen-all-entries-${today()}.csv`);
}

function pageSettings() {
  const general = inlineForm([{ name: 'name', label: 'Canteen name', value: S.settings.name, required: true, cls: 'wide' }], 'Save', async d => {
    S.settings.name = d.name; await save(); toast('Saved');
  });
  const restoreK = onChange(el => { if (el.files[0]) importBackup(el.files[0]); el.value = ''; });
  const lb = S.settings.lastBackup;
  return `<div class="grid g2">
    <div>
      ${cloud.card()}
      <div class="card"><h2>Backup &amp; restore</h2>
        ${native ? `<p>All data is saved as files in <b>${esc(dataPath)}</b>. The app also keeps an automatic copy for each of the last 30 days in its <i>auto-backups</i> folder.</p>
        <p><b>Once a week, download a backup</b> (or copy the whole data folder) to a pen drive or Google Drive, so your accounts are safe even if this computer breaks.</p>
        <div class="row" style="margin-bottom:12px"><button class="ghost" ${act(() => native.openDataFolder())}>Open data folder</button></div>`
    : isApp ? `<p>All data is saved on this phone${cloud.on() ? ' and copied to the cloud' : ''}. ${cloud.on() ? 'If the phone is lost, sign in on the new phone and everything comes back.' : '<b>Turn on cloud sync above, or take a backup every week</b> – if the app is uninstalled, a backup is the only way to get the data back.'}</p>`
    : `<p>All data is saved inside this browser on this computer. <b>Take a backup at least once a week</b> and keep the file on a pen drive, Google Drive or WhatsApp to yourself.
        If the browser data is cleared, a backup is the only way to get it back.</p>`}
        <p class="muted">Last backup: ${lb ? new Date(lb).toLocaleString('en-IN') : 'never'}</p>
        <div class="row">
          <button ${act(exportBackup)}>Download backup</button>
          <label class="btn ghost">Restore from backup<input type="file" ${isApp ? '' : 'accept=".json,application/json"'} hidden ${restoreK}></label>
          <button class="ghost" ${act(exportCSV)}>Export all entries (Excel CSV)</button>
        </div>
        <p class="hint" style="margin-top:12px">To move to a new computer: download a backup here, open the app there, and restore it.</p></div>
      <div class="card"><h2>General</h2>${general}
        <div class="field" style="margin-top:14px"><label>Theme</label>
          <div class="tabs" style="margin:0">${[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', isApp ? '📱 Same as phone' : '🖥️ Same as Windows']].map(([v, l]) =>
            `<button class="${(S.settings.theme || 'light') === v ? 'on' : ''}" ${act(() => setTheme(v))}>${l}</button>`).join('')}</div></div>
        ${isApp ? '' : `<label class="check" style="margin-top:14px"><input type="checkbox" ${S.settings.hideHints ? '' : 'checked'} ${onChange(async el => { S.settings.hideHints = !el.checked; applyTheme(); await save(); render(); })}>
          Show keyboard shortcut hints (in the side menu and while adding expenses)</label>`}
        ${isApp ? '' : `<div class="shortcuts"><b>Keyboard shortcuts</b>
          <span><kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>0</kbd></span><span>open a page (in the order of the side menu)</span>
          <span><kbd>Ctrl</kbd>+<kbd>E</kbd></span><span>add expenses</span>
          <span><kbd>Ctrl</kbd>+<kbd>N</kbd></span><span>the page's "+ Add" button</span>
          <span><kbd>Enter</kbd></span><span>next box; on the last box it saves</span>
          <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span><span>save a popup form from any box</span>
          <span><kbd>Esc</kbd></span><span>close a popup</span>
          <span><kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd></span><span>previous / next day on Daily Entry</span>
          <span><kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd></span><span>next / previous box</span>
          <span><kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd></span><span>bigger / smaller text</span></div>`}</div>
      ${reminderCard()}
      <div class="card"><h2>Danger zone</h2>
        <p class="muted">Delete everything in the app (take a backup first).</p>
        <button class="danger" ${act(() => formModal({
          title: 'Erase all data',
          note: `<p class="hint" style="margin:0 0 12px">Every entry and attached bill will be deleted. Take a backup first.${cloud.on() ? ' <b>Cloud sync is on, so this also erases the data on your other devices.</b>' : ''}</p>`,
          fields: [{ name: 'confirm', label: 'Type DELETE to confirm', required: true, cls: 'wide' }],
          submit: 'Erase everything',
          onSave: async d => {
            if (d.confirm !== 'DELETE') { alert('Type DELETE in capital letters to confirm.'); return false; }
            await store.clearFiles();
            const syncMeta = S.sync;
            S = defaultState(); S.sync = syncMeta; await save();
          }
        }))}>Erase all data</button></div>
    </div>
    <div>${categoriesCard()}${excel.card()}</div>
  </div>`;
}

/* ---------- reminders: who still owes us money ----------
   Computer: a Windows notification at the chosen time while the app is open
   (or as soon as it is opened after that time). Phone: a notification scheduled
   with Android, so it comes even when the app is closed; its text is refreshed
   every time something is saved.                                          */

const reminderSettings = () => Object.assign({ freq: 'daily', time: '10:00' }, S.settings.reminders);

function owingCustomers() {
  return S.customers.map(c => ({ c, ...customerBalance(c.id) })).filter(x => x.pending >= 1).sort((a, b) => b.pending - a.pending);
}

function reminderMessage() {
  const list = owingCustomers();
  if (!list.length) return null;
  const total = sum(list, x => x.pending);
  const names = list.slice(0, 3).map(x => `${x.c.name} ${money(x.pending)}`).join(', ');
  return {
    title: `${money(total)} to collect from ${list.length} customer${list.length === 1 ? '' : 's'}`,
    body: names + (list.length > 3 ? ` and ${list.length - 3} more` : '')
  };
}

const REMINDER_ID = 7001;
let phoneReminderTimer = null;
async function schedulePhoneReminder() {
  const LN = plugin('LocalNotifications');
  const r = reminderSettings(), msg = reminderMessage();
  try {
    await LN.cancel({ notifications: [{ id: REMINDER_ID }] });
    if (r.freq === 'off' || !msg) return;
    let perm = await LN.checkPermissions();
    if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') perm = await LN.requestPermissions();
    if (perm.display !== 'granted') return;
    const [hour, minute] = r.time.split(':').map(Number);
    await LN.schedule({ notifications: [{
      id: REMINDER_ID, title: msg.title, body: msg.body,
      schedule: { on: r.freq === 'weekly' ? { weekday: 2, hour, minute } : { hour, minute }, allowWhileIdle: true }
    }] });
  } catch (e) { console.warn('reminder', e); }
}

function reminderDue() {
  const r = reminderSettings();
  if (r.freq === 'off') return false;
  const now = new Date();
  if (r.freq === 'weekly' && now.getDay() !== 1) return false;
  const [h, m] = r.time.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

function showDesktopReminder(force) {
  const msg = reminderMessage();
  if (!msg || !('Notification' in window)) return false;
  let last = '';
  try { last = localStorage.getItem('ndp-reminded') || ''; } catch (e) { /* storage blocked */ }
  if (!force && (last === today() || !reminderDue())) return false;
  const go = () => {
    const n = new Notification(msg.title, { body: msg.body });
    n.onclick = () => { window.focus(); location.hash = 'credit'; };
    try { localStorage.setItem('ndp-reminded', today()); } catch (e) { /* storage blocked */ }
  };
  if (Notification.permission === 'granted') go();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => p === 'granted' && go());
  return true;
}

function startReminders() {
  if (isApp) {
    schedulePhoneReminder();
    plugin('LocalNotifications').addListener('localNotificationActionPerformed', () => { location.hash = 'credit'; });
    return;
  }
  showDesktopReminder();
  setInterval(() => showDesktopReminder(), 60000);
}

// after any save, the phone's scheduled reminder gets the latest amounts
function remindersChanged() {
  if (!isApp) return;
  clearTimeout(phoneReminderTimer);
  phoneReminderTimer = setTimeout(schedulePhoneReminder, 3000);
}

function reminderCard() {
  const r = reminderSettings();
  const list = owingCustomers();
  const set = async patch => { S.settings.reminders = Object.assign(reminderSettings(), patch); await save(); render(); };
  return `<div class="card"><h2>Payment reminders</h2>
    <p class="hint">A notification listing the customers who still owe money${isApp ? ', even when the app is closed' : ' (shown while the app is open, or when you next open it)'}.</p>
    <div class="row">
      <div class="field"><label>Remind me</label><select ${onChange(el => set({ freq: el.value }))}>
        ${[['daily', 'Every day'], ['weekly', 'Every Monday'], ['off', 'Never']].map(([v, l]) => `<option value="${v}" ${r.freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>At</label><input type="time" value="${esc(r.time)}" ${r.freq === 'off' ? 'disabled' : ''} ${onChange(el => el.value && set({ time: el.value }))}></div>
      <button class="ghost" ${act(() => {
        if (!list.length) { toast('Nobody owes anything right now'); return; }
        if (isApp) {
          const LN = plugin('LocalNotifications'), msg = reminderMessage();
          LN.requestPermissions().then(p => p.display === 'granted'
            ? LN.schedule({ notifications: [{ id: REMINDER_ID + 1, title: msg.title, body: msg.body, schedule: { at: new Date(Date.now() + 1500) } }] })
            : alert('Notifications are turned off for this app in the phone settings.'));
        } else if (!showDesktopReminder(true)) alert('Notifications are not available here.');
      })}>Show now</button>
    </div>
    <p class="muted" style="margin:10px 0 0">${list.length ? `Right now: ${esc(reminderMessage().title)}.` : 'Right now nobody owes anything, so no reminder will be shown.'}</p></div>`;
}

/* ---------- expense categories: one row each, rename in place ---------- */

function categoriesCard() {
  const cats = S.settings.categories;
  const used = {};
  for (const e of S.expenses) used[e.category] = (used[e.category] || 0) + 1;
  const addK = reg(async form => {
    const name = form.elements.cat.value.trim();
    if (!name) return;
    if (cats.some(c => c.toLowerCase() === name.toLowerCase())) { alert(`"${name}" is already in the list.`); return; }
    cats.push(name);
    await save(); toast('Category added'); render();
  });
  const rows = cats.map((c, i) => `<div class="cat-row">
      <span class="cat-move"><button class="link" aria-label="Move up" title="Move up" ${i ? act(() => moveCategory(i, -1)) : 'disabled'}>▲</button><button class="link" aria-label="Move down" title="Move down" ${i < cats.length - 1 ? act(() => moveCategory(i, 1)) : 'disabled'}>▼</button></span>
      <input value="${esc(c)}" aria-label="Category name" title="Type to rename" ${onChange(el => renameCategory(c, el.value))}>
      <span class="pill" title="Expenses in this category">${used[c] || 0}</span>
      <button class="link del" aria-label="Remove category" title="Remove from the list" ${act(() => removeCategory(c))}>✕</button></div>`).join('');
  return `<div class="card"><h2>Expense categories<span class="spacer"></span><span class="muted" style="font-weight:400;font-size:12px">${cats.length} categories</span></h2>
    <form class="row" style="margin-bottom:12px" data-submit="${addK}">
      <input name="cat" aria-label="New category" autocomplete="off" placeholder="New category, e.g. Pest control…" required style="flex:1;width:auto">
      <button type="submit">+ Add</button></form>
    <div class="cat-list">${rows}</div>
    <p class="hint" style="margin:10px 0 0">Type in a box to rename – past expenses move to the new name too. The number is how many expenses use it. ▲▼ set the order in the expense form.</p></div>`;
}

async function renameCategory(old, name) {
  name = name.trim();
  const cats = S.settings.categories;
  if (!name || name === old) { render(); return; }
  if (cats.some(c => c !== old && c.toLowerCase() === name.toLowerCase())) { alert(`"${name}" is already in the list.`); render(); return; }
  cats[cats.indexOf(old)] = name;
  let n = 0;
  for (const e of S.expenses) if (e.category === old) { e.category = name; n++; }
  await save();
  toast(n ? `Renamed – ${n} expense${n === 1 ? '' : 's'} updated` : 'Renamed');
  render();
}

async function removeCategory(c) {
  const cats = S.settings.categories;
  if (cats.length === 1) { alert('Keep at least one category.'); return; }
  const n = S.expenses.filter(e => e.category === c).length;
  if (!confirm(n ? `Remove "${c}" from the list?\n\nIts ${n} past expense${n === 1 ? '' : 's'} keep this name; it just won't be offered for new expenses.` : `Remove "${c}" from the list?`)) return;
  S.settings.categories = cats.filter(x => x !== c);
  await save(); toast('Removed'); render();
}

async function moveCategory(i, d) {
  const cats = S.settings.categories;
  [cats[i], cats[i + d]] = [cats[i + d], cats[i]];
  await save(); render();
}

/* ================================================================
   START
   ================================================================ */

let dataPath = '';

(async function init() {
  try {
    await store.init();
    if (native) dataPath = await native.dataPath();
    S = await loadState();
    await cloud.load();
    render();
    cloud.start();
    startReminders();
    excel.start();
  } catch (e) {
    console.error(e);
    document.getElementById('view').innerHTML = native
      ? `<div class="alert bad">Could not read the data file: ${esc(e.message)}. Daily copies are kept in the auto-backups folder inside Documents\\N.D. Patil Canteen Data.</div>`
      : `<div class="alert bad">Could not open the app's storage: ${esc(e.message)}. Please open this file in Google Chrome or Microsoft Edge.</div>`;
  }
})();
