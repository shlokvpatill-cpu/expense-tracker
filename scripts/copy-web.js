// Copies the app's web files into www/, which Capacitor packs into the Android app.
// The phone copy also loads Capacitor's core script, which gives the page the phone features
// (files, share sheet, back button, status bar).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of ['styles.css', 'sync.js', 'excel.js', 'app.js']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.mkdirSync(path.join(out, 'vendor'));
fs.copyFileSync(path.join(root, 'vendor', 'exceljs.min.js'), path.join(out, 'vendor', 'exceljs.min.js'));
fs.copyFileSync(path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), path.join(out, 'capacitor.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!html.includes('<script src="sync.js"></script>')) throw new Error('index.html: sync.js script tag not found');
fs.writeFileSync(path.join(out, 'index.html'), html.replace('<script src="sync.js"></script>', '<script src="capacitor.js"></script>\n  <script src="sync.js"></script>'));
console.log('copied web files to www/');
