'use strict';

/* ================================================================
   CLOUD SYNC – the computer and the phone share the same accounts.
   Uses a free Supabase project (see CLOUD-SETUP.md).

   Every entry (an expense, a payment, one day's sales, …) is one row of
   the canteen_records table. Each device keeps a short fingerprint of the
   version it last synced, so it sends only what changed on it and takes
   only what changed elsewhere. If the same entry was changed on both
   devices since the last sync, the device that syncs later wins.
   Bill photos go to the private "bills" storage bucket and are fetched
   on the other device the first time they are opened.

   Loaded before app.js; it uses app.js globals (S, store, render, act …)
   only when its functions are called.
   ================================================================ */

const cloud = (() => {
  const CFG_KEY = 'ndp-cloud';
  const LIST_KINDS = ['owners', 'helpers', 'vendors', 'customers', 'items', 'itemSales', 'expenses',
    'vendorPayments', 'helperTx', 'ownerTx', 'creditTx', 'files'];
  const LOCAL_SETTINGS = ['theme', 'lastBackup', 'hideHints']; // each device keeps its own
  const PAGE = 1000, BATCH = 400;

  // connection details stay on this device only (never in backups). The sign-in token changes
  // every hour, so it is written to a file straight away – a power cut must not sign the app out.
  let cfg = {};
  let running = null, again = false, timer = null, renderWaiting = false;
  let status = { state: 'off', msg: '', at: null };
  const phoneFile = { path: 'cloud.json', directory: 'DATA', encoding: 'utf8' };
  let writing = Promise.resolve();

  async function load() {
    try {
      if (native && native.loadCloud) { cfg = JSON.parse(await native.loadCloud()) || {}; return; }
      if (isApp) { cfg = JSON.parse((await plugin('Filesystem').readFile(phoneFile)).data) || {}; return; }
      cfg = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
    } catch (e) {
      cfg = {}; // not signed in on this device yet
    }
  }
  function writeCfg() {
    const json = JSON.stringify(cfg);
    // one write at a time, so an older token can never overwrite a newer one
    writing = writing.then(() => {
      if (native && native.saveCloud) return native.saveCloud(json);
      if (isApp) return plugin('Filesystem').writeFile({ ...phoneFile, data: json });
      localStorage.setItem(CFG_KEY, json);
    }).catch(e => console.warn('could not save sign-in', e));
  }
  const on = () => !!(cfg.url && cfg.key && cfg.refresh);

  /* ---------- fingerprints ---------- */

  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function hash(str) { // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const fp = data => hash(stable(data));

  function sharedSettings() {
    const o = Object.assign({}, S.settings);
    for (const k of LOCAL_SETTINGS) delete o[k];
    return o;
  }

  /* every syncable entry, as "kind/key" -> {kind, key, data} */
  function records() {
    const m = new Map();
    for (const kind of LIST_KINDS) for (const r of S[kind] || []) if (r && r.id) m.set(kind + '/' + r.id, { kind, key: r.id, data: r });
    for (const s of S.sales) if (s && s.date) m.set('sales/' + s.date, { kind: 'sales', key: s.date, data: s });
    m.set('settings/main', { kind: 'settings', key: 'main', data: sharedSettings() });
    return m;
  }

  /* put an entry from the cloud into S (data null = it was deleted) */
  function apply(kind, key, data) {
    if (kind === 'settings') {
      if (!data) return;
      const next = Object.assign(defaultState().settings, data);
      for (const k of LOCAL_SETTINGS) if (S.settings[k] !== undefined) next[k] = S.settings[k];
      S.settings = next;
      return;
    }
    if (kind !== 'sales' && !LIST_KINDS.includes(kind)) return; // made by a newer version of the app
    const idf = kind === 'sales' ? 'date' : 'id';
    const arr = S[kind];
    const i = arr.findIndex(r => r && r[idf] === key);
    if (data) { if (i >= 0) arr[i] = data; else arr.push(data); }
    else if (i >= 0) arr.splice(i, 1);
  }

  /* ---------- talking to Supabase ---------- */

  async function req(path, opt = {}, retry = true) {
    const headers = Object.assign({ apikey: cfg.key }, opt.headers || {});
    if (opt.auth !== false) headers.Authorization = 'Bearer ' + cfg.access;
    let res;
    try {
      res = await fetch(cfg.url + path, { method: opt.method || 'GET', headers, body: opt.body });
    } catch (e) {
      const err = new Error('No internet connection');
      err.offline = true;
      throw err;
    }
    if (res.status === 401 && opt.auth !== false && retry) { await refreshToken(true); return req(path, opt, false); }
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try { const j = await res.json(); msg = j.error_description || j.msg || j.message || j.error || msg; } catch (e) { /* not json */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function takeSession(j) {
    cfg.access = j.access_token;
    cfg.refresh = j.refresh_token;
    cfg.exp = Date.now() + (j.expires_in || 3600) * 1000;
    writeCfg();
  }

  let refreshing = null;
  function refreshToken(force) {
    if (!force && cfg.access && cfg.exp - 90000 > Date.now()) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await req('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: cfg.refresh })
        }, false);
        takeSession(await res.json());
      } catch (e) {
        if (!e.offline && (e.status === 400 || e.status === 401 || e.status === 403)) {
          cfg.refresh = null; cfg.access = null; writeCfg();
          e.signedOut = true;
          e.message = 'Signed out – please sign in again in Settings';
        }
        throw e;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  async function pull(since) {
    const rows = [];
    for (let off = 0; ; off += PAGE) {
      let q = `/rest/v1/canteen_records?select=kind,key,data,deleted,updated_at&order=updated_at.asc,kind.asc,key.asc&limit=${PAGE}&offset=${off}`;
      if (since) q += '&updated_at=gte.' + encodeURIComponent(since);
      const page = await (await req(q)).json();
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  const upsert = rows => req('/rest/v1/canteen_records?on_conflict=kind,key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });

  const billPath = id => '/storage/v1/object/bills/' + encodeURIComponent(id);
  const uploadBill = (id, blob) => req(billPath(id), {
    method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' }, body: blob
  });

  async function download(id, type) {
    if (!on()) return null;
    try {
      await refreshToken();
      const b = await (await req('/storage/v1/object/authenticated/bills/' + encodeURIComponent(id))).blob();
      return new Blob([b], { type: type || b.type });
    } catch (e) {
      return null;
    }
  }

  /* ---------- the sync itself ---------- */

  function sync() {
    if (!on() || !S) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus('syncing');
      try {
        await refreshToken();
        if (!S.sync || S.sync.url !== cfg.url) S.sync = { url: cfg.url, cursor: null, hashes: {} };
        const meta = S.sync, hashes = meta.hashes;
        const setHash = (id, h) => { if (h) hashes[id] = h; else delete hashes[id]; };
        const first = !meta.cursor;
        let dirty = false, changed = false, cursor = meta.cursor;

        // 1. take what changed on the other devices (with a 2-minute overlap, repeats are harmless)
        const rows = await pull(meta.cursor ? new Date(Date.parse(meta.cursor) - 120000).toISOString() : null);
        const local = records();
        for (const r of rows) {
          if (!cursor || r.updated_at > cursor) cursor = r.updated_at;
          const id = r.kind + '/' + r.key;
          const theirs = r.deleted ? null : fp(r.data);
          const mine = local.has(id) ? fp(local.get(id).data) : null;
          if (theirs === mine) { if (hashes[id] !== (theirs || undefined)) { setHash(id, theirs); dirty = true; } continue; }
          // changed here as well since the last sync: keep this device's version, it is sent below.
          // On the very first sync of a device the cloud copy wins instead.
          if (!first && mine !== (hashes[id] || null)) continue;
          apply(r.kind, r.key, r.deleted ? null : r.data);
          if (r.kind === 'files' && r.deleted) store.deleteFile(r.key).catch(() => {});
          setHash(id, theirs);
          changed = dirty = true;
        }
        if (cursor !== meta.cursor) { meta.cursor = cursor; dirty = true; }

        // 2. send what changed on this device
        const now = records();
        const out = [];
        for (const [id, rec] of now) {
          const h = fp(rec.data);
          if (hashes[id] !== h) out.push({ id, h, row: { kind: rec.kind, key: rec.key, data: rec.data, deleted: false } });
        }
        for (const id of Object.keys(hashes)) {
          if (now.has(id)) continue;
          const i = id.indexOf('/');
          out.push({ id, h: null, row: { kind: id.slice(0, i), key: id.slice(i + 1), data: null, deleted: true } });
        }
        for (let i = 0; i < out.length; i += BATCH) {
          const part = out.slice(i, i + BATCH);
          // a new bill's photo goes up before its entry, so other devices never see a bill without a file
          for (const x of part) {
            if (x.row.kind === 'files' && !x.row.deleted && !hashes[x.id]) {
              const b = await store.getFile(x.row.key, x.row.data.type);
              if (b) await uploadBill(x.row.key, b);
            }
          }
          await upsert(part.map(x => x.row));
          for (const x of part) {
            setHash(x.id, x.h);
            if (x.row.kind === 'files' && x.row.deleted) req(billPath(x.row.key), { method: 'DELETE' }).catch(() => {});
          }
          dirty = true;
        }
        if (dirty) await store.saveState(S);
        setStatus('ok');
        if (changed) { refreshView(); remindersChanged(); excel.changed(); }
      } catch (e) {
        console.warn('sync:', e);
        setStatus(e.offline ? 'offline' : e.signedOut ? 'signin' : 'error', e.message);
      } finally {
        running = null;
        if (again) { again = false; schedule(1500); }
      }
    })();
    return running;
  }

  /* re-draw the page with the new data, but not under the user's fingers */
  function refreshView() {
    const a = document.activeElement;
    const typing = a && a.closest && a.closest('#view') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
    if (document.querySelector('.modal') || typing) { renderWaiting = true; return; }
    renderWaiting = false;
    render();
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(auto, ms); }
  // never pull new data in while a popup form is open; try again shortly
  function auto() { if (document.querySelector('.modal')) schedule(3000); else sync(); }

  /* ---------- status badge ---------- */

  function setStatus(state, msg = '') {
    status = { state, msg, at: state === 'ok' ? new Date() : status.at };
    badge();
  }
  function ago(d) {
    if (!d) return '';
    const s = Math.round((Date.now() - d) / 1000);
    return s < 50 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }
  function badge() {
    const el = document.getElementById('syncBtn');
    if (!el) return;
    const st = on() ? status.state : cfg.url ? 'signin' : 'off';
    el.hidden = st === 'off';
    el.className = 'ghost sm sync-btn ' + st;
    el.textContent = { syncing: '☁ Syncing…', ok: '☁ Synced', waiting: '☁ Saving…', offline: '☁ Offline', error: '☁ Sync problem', signin: '☁ Sign in', off: '' }[st];
    el.title = st === 'ok' ? 'Last synced ' + ago(status.at) + ' – tap to sync now'
      : st === 'offline' ? 'No internet. Your entries are safe on this device and will sync when you are back online.'
      : status.msg || 'Cloud sync';
  }

  /* ---------- public ---------- */

  function changed() {
    if (!on()) return;
    if (status.state !== 'syncing') setStatus('waiting');
    schedule(4000);
  }

  function start() {
    badge();
    if (on()) sync();
    setInterval(() => { if (on() && !running) auto(); }, 120000);
    setInterval(() => { badge(); if (renderWaiting) refreshView(); }, 5000);
    document.addEventListener('focusout', () => setTimeout(() => { if (renderWaiting) refreshView(); }, 400));
    window.addEventListener('online', () => on() && schedule(500));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && on()) schedule(500); });
    document.getElementById('syncBtn').addEventListener('click', async () => {
      if (!on()) { location.hash = 'settings'; return; }
      await sync();
      toast(status.state === 'ok' ? 'All synced' : status.msg || 'Could not sync');
    });
  }

  async function signIn(url, key, email, password) {
    url = url.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/\s]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('The project URL should look like https://abcd.supabase.co');
    let res;
    try {
      res = await fetch(url + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: key.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password })
      });
    } catch (e) { throw new Error('Could not reach the project. Check the internet and the project URL.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error_description || j.msg || j.message || 'Sign-in failed');
    cfg = { url, key: key.trim(), email: email.trim() };
    takeSession(j);
    await sync();
    if (status.state !== 'ok') throw new Error(status.msg || 'Signed in, but the first sync failed');
  }

  function signOut() {
    cfg.access = null; cfg.refresh = null;
    writeCfg();
    setStatus('off');
  }

  /* Settings page card */
  function card() {
    if (!on()) {
      const k = reg(async form => {
        const v = n => form.elements[n].value;
        toast('Signing in…');
        await signIn(v('url'), v('key'), v('email'), v('password'));
        toast('Signed in – everything is synced');
        render();
      });
      return `<div class="card"><h2>Cloud sync (phone + computer)</h2>
        <p class="hint">Sign in with the same account on the computer and the phone, and both will show the same accounts. First-time setup steps are in <b>CLOUD-SETUP.md</b> in the app folder.</p>
        ${cfg.url && !cfg.refresh ? '<div class="alert warn">You are signed out. Sign in again to keep syncing – nothing on this device was lost.</div>' : ''}
        <form data-submit="${k}" class="row">
          <div class="field wide"><label>Project URL</label><input name="url" value="${esc(cfg.url || '')}" placeholder="https://abcd.supabase.co" required autocomplete="off" autocapitalize="off"></div>
          <div class="field wide"><label>Publishable / anon key</label><input name="key" value="${esc(cfg.key || '')}" placeholder="sb_publishable_… or eyJ…" required autocomplete="off" autocapitalize="off"></div>
          <div class="field"><label>Email</label><input name="email" type="email" value="${esc(cfg.email || '')}" required autocapitalize="off"></div>
          <div class="field"><label>Password</label><input name="password" type="password" required></div>
          <button type="submit">Sign in &amp; sync</button>
        </form></div>`;
    }
    const st = status.state;
    const line = st === 'ok' ? `Last synced ${ago(status.at)}` : st === 'syncing' ? 'Syncing now…' : st === 'waiting' ? 'Saving your latest changes…'
      : st === 'offline' ? 'No internet right now – entries are kept on this device and sync when you are back online.' : esc(status.msg || '');
    return `<div class="card"><h2>Cloud sync (phone + computer)<span class="spacer"></span><span class="pill ${st === 'ok' ? 'good' : st === 'error' ? 'bad' : 'warn'}">On</span></h2>
      <p>Signed in as <b>${esc(cfg.email)}</b>.</p>
      <p class="muted">${line}</p>
      <p class="hint" style="margin:0 0 12px">Entries sync a few seconds after you save and every 2 minutes whenever there is internet. Bill photos are uploaded too, and are downloaded on the other device when you open them.</p>
      <div class="row">
        <button ${act(async () => { await sync(); toast(status.state === 'ok' ? 'All synced' : status.msg || 'Could not sync'); render(); })}>Sync now</button>
        <button class="ghost" ${act(() => { if (confirm('Sign out of cloud sync on this device?\n\nThe data stays on this device; it just stops syncing.')) { signOut(); render(); } })}>Sign out</button>
      </div></div>`;
  }

  return { load, on, sync, changed, start, card, download, signOut, _records: records, _fp: fp };
})();
