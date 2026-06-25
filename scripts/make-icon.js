'use strict';

// 生成したアイコン元画像（角丸スクエア＋周囲の余白）から、
// macOS 標準の .icns / .iconset を作る。
//
// Electron のレンダラ Canvas を使って処理する（追加依存なし）:
//   1) 元画像の角丸スクエア部分を正方形にセンタークロップ（周囲の余白を除去）
//   2) Apple グリッド比率に合わせてキャンバスへ配置し、角丸マスクを再適用
//   3) 各サイズの PNG を書き出し → iconutil で .icns 化
//
// 使い方:
//   npx electron scripts/make-icon.js <入力PNG> <出力iconsetディレクトリ>

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const INPUT = process.argv[2] || process.env.ICON_INPUT;
const OUTSET = process.argv[3] || process.env.ICON_ICONSET;

if (!INPUT || !OUTSET) {
  console.error('usage: electron make-icon.js <input.png> <output.iconset>');
  app.quit();
  process.exit(1);
}

// 元画像の「角丸スクエアの内側が占める割合」。元の角丸の縁＋余白を除くため内側を取る。
const CROP_RATIO = 0.6;
// Apple のアイコンは 1024 キャンバスに対し本体が約 824px（角丸あり）。
const CANVAS = 1024;
const CONTENT = 824;
const CORNER = CONTENT * 0.2237; // Apple の角丸半径比

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

function html(dataUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<canvas id="c"></canvas>
<script>
const SRC = ${JSON.stringify(dataUrl)};
const CROP_RATIO = ${CROP_RATIO};
const CANVAS = ${CANVAS}, CONTENT = ${CONTENT}, CORNER = ${CORNER};

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function buildBase() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // 1) センタークロップ（正方形）
      const side = Math.min(img.width, img.height) * CROP_RATIO;
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;

      // 2) 1024 キャンバスに角丸マスクで配置
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS; canvas.height = CANVAS;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, CANVAS, CANVAS);
      const off = (CANVAS - CONTENT) / 2;
      ctx.save();
      roundRectPath(ctx, off, off, CONTENT, CONTENT, CORNER);
      ctx.clip();
      ctx.drawImage(img, sx, sy, side, side, off, off, CONTENT, CONTENT);
      ctx.restore();
      resolve(canvas);
    };
    img.src = SRC;
  });
}

function resize(base, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, size, size);
  return c.toDataURL('image/png');
}

buildBase().then((base) => {
  const out = {};
  ${JSON.stringify(SIZES)}.forEach((s) => { out[s] = resize(base, s); });
  window.__icons = out;
  document.title = 'ICONS_READY';
});
</script></body></html>`;
}

app.whenReady().then(async () => {
  const buf = fs.readFileSync(INPUT);
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');

  const win = new BrowserWindow({
    width: 100, height: 100, show: false,
    webPreferences: { offscreen: false },
  });

  const tmpHtml = path.join(app.getPath('temp'), 'limitpeek-icon.html');
  fs.writeFileSync(tmpHtml, html(dataUrl), 'utf8');
  await win.loadFile(tmpHtml);

  // 描画完了待ち
  await new Promise((r) => setTimeout(r, 800));

  const icons = await win.webContents.executeJavaScript('window.__icons');

  fs.mkdirSync(OUTSET, { recursive: true });
  // iconset の命名規則に従って書き出し
  const map = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of map) {
    const b64 = icons[size].split(',')[1];
    fs.writeFileSync(path.join(OUTSET, name), Buffer.from(b64, 'base64'));
  }
  console.log('wrote iconset to', OUTSET);
  app.quit();
});
