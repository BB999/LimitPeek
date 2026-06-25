'use strict';

// assets/icon.png から Windows 用の assets/icon.ico を生成する。
// 複数解像度(16/24/32/48/64/128/256)を束ねた .ico を作る。
//
// 使い方:
//   npm install --no-save png-to-ico   # 初回のみ（devDep には残さない使い捨て）
//   node scripts/make-win-icon.js
//
// macOS には .ico 生成の標準ツールが無いため、sips でサイズ別 PNG を作り
// png-to-ico で束ねる。ImageMagick がある環境なら `magick` でも作れる。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.png');
const OUT = path.join(ROOT, 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('source not found:', SRC);
    process.exit(1);
  }

  let pngToIco;
  try {
    const mod = require('png-to-ico');
    pngToIco = typeof mod === 'function' ? mod : mod.default; // CJS/ESM 両対応
  } catch {
    console.error('png-to-ico が無い。先に `npm install --no-save png-to-ico` を実行して。');
    process.exit(1);
  }
  if (typeof pngToIco !== 'function') {
    console.error('png-to-ico の形が想定外（関数でない）');
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limitpeek-ico-'));
  const files = SIZES.map((s) => {
    const p = path.join(tmp, `icon_${s}.png`);
    // macOS の sips でリサイズ。他 OS では各自 PNG を用意する想定。
    execFileSync('sips', ['-z', String(s), String(s), SRC, '--out', p], { stdio: 'ignore' });
    return p;
  });

  pngToIco(files)
    .then((buf) => {
      fs.writeFileSync(OUT, buf);
      console.log('wrote', OUT, `(${buf.length} bytes)`);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    })
    .catch((e) => {
      console.error('ico generation failed:', e && e.message);
      process.exit(1);
    });
}

main();
