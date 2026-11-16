'use strict';

/* Desktop shell for the canteen app.
   All data is kept as plain files in  Documents\N.D. Patil Canteen Data :
     data.json        – every entry
     bills\           – attached bill photos / PDFs
     auto-backups\    – a copy of data.json for each of the last 30 days    */

const { app, BrowserWindow, ipcMain, shell, Menu, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.CANTEEN_DATA_DIR || path.join(app.getPath('documents'), 'N.D. Patil Canteen Data');
const STATE_FILE = path.join(DATA_DIR, 'data.json');
const BILLS_DIR = path.join(DATA_DIR, 'bills');
const AUTO_DIR = path.join(DATA_DIR, 'auto-backups');
const KEEP_AUTO = 30;

for (const d of [DATA_DIR, BILLS_DIR, AUTO_DIR]) fs.mkdirSync(d, { recursive: true });
// a test run with its own data folder must not clash with the copy in daily use
if (process.env.CANTEEN_DATA_DIR) app.setPath('userData', path.join(DATA_DIR, '_profile'));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ids come from the app itself, but never let one escape the bills folder
const billPath = id => {
  if (!/^[a-z0-9]+$/i.test(String(id))) throw new Error('Bad file id');
  return path.join(BILLS_DIR, id);
};

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function autoBackup() {
  if (!fs.existsSync(STATE_FILE)) return;
  const target = path.join(AUTO_DIR, `data-${today()}.json`);
  if (fs.existsSync(target)) return;
  fs.copyFileSync(STATE_FILE, target);
  const old = fs.readdirSync(AUTO_DIR).filter(f => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(KEEP_AUTO);
  for (const f of old) fs.unlinkSync(path.join(AUTO_DIR, f));
}

ipcMain.handle('state:load', () => (fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null));
ipcMain.handle('state:save', (e, json) => { autoBackup(); writeAtomic(STATE_FILE, json); });
ipcMain.handle('file:put', (e, id, bytes) => { writeAtomic(billPath(id), Buffer.from(bytes)); });
ipcMain.handle('file:get', (e, id) => {
  const p = billPath(id);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
});
ipcMain.handle('file:delete', (e, id) => { const p = billPath(id); if (fs.existsSync(p)) fs.unlinkSync(p); });
ipcMain.handle('file:clear', () => { for (const f of fs.readdirSync(BILLS_DIR)) fs.unlinkSync(path.join(BILLS_DIR, f)); });
ipcMain.handle('data:path', () => DATA_DIR);
ipcMain.handle('data:open', () => shell.openPath(DATA_DIR));
// cloud sync sign-in: kept in the app's own profile folder, not with the data (which gets copied to pen drives)
const cloudFile = () => path.join(app.getPath('userData'), 'cloud.json');
ipcMain.handle('cloud:load', () => (fs.existsSync(cloudFile()) ? fs.readFileSync(cloudFile(), 'utf8') : null));
ipcMain.handle('cloud:save', (e, json) => { writeAtomic(cloudFile(), json); });
// Excel copy of the accounts, rewritten by the app after changes.
// While the file is open in Excel, Windows locks it: report that instead of failing.
const excelDefault = () => process.env.CANTEEN_DATA_DIR
  ? path.join(DATA_DIR, 'N.D. Patil Canteen (app).xlsx')
  : path.join(app.getPath('desktop'), 'N.D. Patil Canteen (app).xlsx');
ipcMain.handle('excel:default', () => excelDefault());
ipcMain.handle('excel:write', (e, file, bytes) => {
  if (!/\.xlsx$/i.test(String(file))) return 'Only .xlsx files can be written';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, Buffer.from(bytes));
    return 'ok';
  } catch (err) {
    try { fs.unlinkSync(file + '.tmp'); } catch (e2) { /* nothing left over */ }
    return ['EBUSY', 'EPERM', 'EACCES'].includes(err.code) ? 'locked' : err.message;
  }
});
ipcMain.handle('excel:choose', async (e, current) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Where should the Excel file be kept?', defaultPath: current || excelDefault(),
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }]
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('excel:open', (e, file) => (/\.xlsx$/i.test(String(file)) ? shell.openPath(file) : 'Not an Excel file'));
// keeps the window's title bar in step with the app's light / dark choice
ipcMain.handle('theme:set', (e, t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; });

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'N.D. Patil Canteen',
    backgroundColor: '#f4f5f7',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
  // never navigate away from the app or open new windows
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
}

if (!app.requestSingleInstanceLock()) {
  // a second copy writing the same data file could lose entries
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'Open data folder', click: () => shell.openPath(DATA_DIR) }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }] }
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', err => dialog.showErrorBox('Error', String(err && err.stack || err)));
}
