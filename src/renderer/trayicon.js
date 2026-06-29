'use strict';

// メニューバー用の画像を Canvas で合成する。
// レイアウト: [Claudeロゴ] 17%  [Codexロゴ] 22%
// ロゴと文字は単色で描き、テンプレート画像としてメニューバーの明暗に追従させる。
//
// main から render-tray イベントで { items, scale } を受け取り、
// 描画結果(dataURL)を tray-image で返す。

const SIZE = 14;        // ロゴの論理サイズ(px)
const FONT_PX = 13;     // 文字サイズ
const GAP_LOGO_TXT = 3; // ロゴ↔文字
const GAP_GROUP = 10;   // グループ間
const PAD_X = 2;        // 左右余白

// 各セグメント [バー][数字] のペアを描く。バーは数字の左。
const GAP_BAR_TXT = 3;  // バー↔数字
const GAP_SEG = 8;      // セグメント間(both のとき [5hバー 5h数字] ↔ [7dバー 7d数字])
const BAR_W = 14;       // バー長(横)
const BAR_H = 11;       // バー高(文字並みの太さ)
const BAR_R = 3;        // バー角丸

// 使用率(0..100)に応じたバー色。ポップアップと同一閾値: 50%黄 / 90%赤。
function barColor(pct) {
  if (pct >= 90) return '#ff5c5c';
  if (pct >= 50) return '#ffb84d';
  return '#4f9dff';
}

let claudeImg = null;
let codexImg = null;
let logoColor = null; // 現在ロゴを塗っている色（変わったら再ロード）

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// SVG を単色(color)で塗った data URL を作る。テンプレート化しないので色は自前管理。
function svgDataUrl(rawSvg, color) {
  const painted = rawSvg.replace('<svg ', `<svg fill="${color}" `);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(painted);
}

async function ensureLogos(svgs, color) {
  if (claudeImg && codexImg && logoColor === color) return;
  logoColor = color;
  claudeImg = await loadImage(svgDataUrl(svgs.claude, color));
  codexImg = await loadImage(svgDataUrl(svgs.codex, color));
}

// 角丸の矩形パスを引く（fillStyle は呼び出し側で設定）
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

async function render({ items, scale, svgs, pulse, fg }) {
  const fgColor = fg || '#000000';
  await ensureLogos(svgs, fgColor);
  const pulseScale = pulse || { claude: 1, codex: 1 };

  const ratio = scale || 2; // Retina
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  ctx.font = `600 ${FONT_PX}px -apple-system, system-ui, sans-serif`;

  // 1セグメント = [バー(pct!=null のとき)][数字(text非空のとき)] の幅。
  // バーのみ/数字のみ/両方 すべてに対応。両方あるときだけ間にギャップを入れる。
  const segW = (seg) => {
    const hasBar = seg.pct != null;
    const txtW = seg.text ? Math.ceil(ctx.measureText(seg.text).width) : 0;
    const gap = hasBar && txtW ? GAP_BAR_TXT : 0;
    return (hasBar ? BAR_W : 0) + gap + txtW;
  };
  const itemInnerW = (it) => {
    const segs = it.segs || [];
    let w = 0;
    segs.forEach((seg, i) => {
      w += segW(seg);
      if (i < segs.length - 1) w += GAP_SEG;
    });
    return w;
  };

  // まず合計幅を測る
  let width = PAD_X;
  const layout = [];
  items.forEach((it, i) => {
    const logoW = it.logo ? SIZE : 0;
    const inner = (logoW ? logoW + GAP_LOGO_TXT : 0) + itemInnerW(it);
    layout.push({ ...it, logoW, x: width });
    width += inner;
    if (i < items.length - 1) width += GAP_GROUP;
  });
  width += PAD_X;

  const H = 22; // メニューバー論理高さ
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(H * ratio);
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, H);

  ctx.font = `600 ${FONT_PX}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const midY = H / 2;
  const barY = midY - BAR_H / 2;

  layout.forEach((it) => {
    let cx = it.x;
    if (it.logo) {
      const img = it.logo === 'claude' ? claudeImg : codexImg;
      if (img) {
        const y = (H - SIZE) / 2;
        // パルス: ロゴ枠(SIZE×SIZE)の中心を基準に拡縮する。
        // レイアウト幅は等倍のままなので、文字位置はパルスでガタつかない。
        const s = pulseScale[it.logo] || 1;
        if (s === 1) {
          ctx.drawImage(img, cx, y, SIZE, SIZE);
        } else {
          const drawn = SIZE * s;
          const dx = cx + (SIZE - drawn) / 2;
          const dy = y + (SIZE - drawn) / 2;
          ctx.drawImage(img, dx, dy, drawn, drawn);
        }
      }
      cx += SIZE + GAP_LOGO_TXT;
    }

    // 各セグメント: バー(数字の左) → 数字。バーのみ/数字のみ にも対応。
    (it.segs || []).forEach((seg, si) => {
      if (si > 0) cx += GAP_SEG;
      const hasBar = seg.pct != null;
      const hasTxt = !!seg.text;
      if (hasBar) {
        const pct = seg.pct;
        const w = Math.max(0, Math.min(100, pct)) / 100 * BAR_W;
        // トラック（前景色を薄く）
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = fgColor;
        roundRect(ctx, cx, barY, BAR_W, BAR_H, BAR_R);
        ctx.fill();
        // フィル（閾値色）
        ctx.globalAlpha = 1;
        if (w > 0) {
          ctx.fillStyle = barColor(pct);
          roundRect(ctx, cx, barY, w, BAR_H, BAR_R);
          ctx.fill();
        }
        cx += BAR_W + (hasTxt ? GAP_BAR_TXT : 0);
      }
      if (hasTxt) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = fgColor;
        ctx.fillText(seg.text, cx, midY + 0.5);
        cx += Math.ceil(ctx.measureText(seg.text).width);
      }
    });
  });

  const dataUrl = canvas.toDataURL('image/png');
  window.api.sendTrayImage({ dataUrl, width: Math.round(width), height: H });
}

window.api.onRenderTray((payload) => {
  render(payload).catch((e) => console.log('tray render error: ' + (e && e.message)));
});
window.api.trayReady();
