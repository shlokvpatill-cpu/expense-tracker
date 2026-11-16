// Builds the Windows app: npm run build  ->  dist/v<version>/N.D. Patil Canteen-win32-x64
// Only the files listed here go into the app, whatever else is in the folder.
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const KEEP = ['main.js', 'preload.js', 'package.json', 'index.html', 'styles.css', 'sync.js', 'excel.js', 'app.js', 'vendor', 'icon.ico'];

(async () => {
  const { packager } = await import('@electron/packager');
  const out = await packager({
    dir: root,
    name: 'N.D. Patil Canteen',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist', 'v' + pkg.version),
    overwrite: true,
    icon: path.join(root, 'icon.ico'),   // the logo on the .exe, taskbar and desktop shortcut
    prune: false,
    // file paths arrive as "/name" or "/folder/name"; keep only the app's own files
    ignore: p => p !== '' && !KEEP.includes(p.split('/')[1])
  });
  console.log('Wrote new app to:', path.relative(root, out[0]));
})().catch(e => { console.error(e); process.exit(1); });
