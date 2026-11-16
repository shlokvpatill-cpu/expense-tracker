// Draws the Android launcher icons and splash screens. Run with: npx electron scripts/make-icons.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs'), path = require('path');

const res = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const ORANGE = '#c2410c';

// draws the logo (a bowl whose steam rises as growing bars) in white; s = size of the drawing area in px
// the same shapes as branding/final/logo-symbol.svg (big) and logo-symbol-small.svg (icons)
const MARK = 'M70 92A14 14 0 0 1 98 92V104A14 14 0 0 1 70 104ZM114 68A14 14 0 0 1 142 68V104A14 14 0 0 1 114 104ZM158 44A14 14 0 0 1 186 44V104A14 14 0 0 1 158 104ZM34 132H222A94 94 0 0 1 34 132Z';
const MARK_SMALL = 'M54 90A18 18 0 0 1 90 90V98A18 18 0 0 1 54 98ZM110 66A18 18 0 0 1 146 66V98A18 18 0 0 1 110 98ZM166 42A18 18 0 0 1 202 42V98A18 18 0 0 1 166 98ZM30 134H226A98 98 0 0 1 30 134Z';
const drawCup = `function drawCup(g, cx, cy, s) {
  const u = s / 256;
  g.save(); g.translate(cx - 128 * u, cy - 128 * u); g.scale(u, u);
  g.fillStyle = '#fff';
  g.fill(new Path2D(s < 200 ? '${MARK_SMALL}' : '${MARK}'));
  g.restore();
}`;

const page = `<html><body><canvas id=c></canvas><script>${drawCup}
function render(kind, w, h) {
  const c = document.getElementById('c'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (kind === 'legacy' || kind === 'round') {
    g.fillStyle = '${ORANGE}';
    g.beginPath();
    if (kind === 'round') g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); else g.roundRect(w * 0.04, h * 0.04, w * 0.92, h * 0.92, w * 0.2);
    g.fill();
    drawCup(g, w / 2, h / 2, w * 0.66);
  } else if (kind === 'foreground') {
    drawCup(g, w / 2, h / 2, w * 0.5);  // adaptive icons keep the middle 66% visible
  } else {                                // splash
    g.fillStyle = '${ORANGE}'; g.fillRect(0, 0, w, h);
    drawCup(g, w / 2, h / 2, Math.min(w, h) * 0.3);
  }
  return c.toDataURL('image/png');
}</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  let n = 0;
  for (const dir of fs.readdirSync(res)) {
    for (const [file, kind] of [['ic_launcher.png', 'legacy'], ['ic_launcher_round.png', 'round'], ['ic_launcher_foreground.png', 'foreground'], ['splash.png', 'splash']]) {
      const p = path.join(res, dir, file);
      if (!fs.existsSync(p)) continue;
      const { width, height } = nativeImage.createFromPath(p).getSize();
      const url = await win.webContents.executeJavaScript(`render(${JSON.stringify(kind)}, ${width}, ${height})`);
      fs.writeFileSync(p, Buffer.from(url.split(',')[1], 'base64'));
      n++;
    }
  }
  fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ORANGE}</color>\n</resources>\n`);
  console.log('drew', n, 'images');
  app.quit();
});
