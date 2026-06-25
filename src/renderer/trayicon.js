'use strict';

// メニューバー用の画像を Canvas で合成する。
// レイアウト: [Claudeロゴ] 17%  [Codexロゴ] 22%
// ロゴと文字は単色で描き、テンプレート画像としてメニューバーの明暗に追従させる。
//
// main から render-tray イベントで { items, scale } を受け取り、
// 描画結果(dataURL)を tray-image で返す。

const SIZE = 18;        // ロゴの論理サイズ(px)
const FONT_PX = 13;     // 文字サイズ
const GAP_LOGO_TXT = 3; // ロゴ↔文字
const GAP_GROUP = 10;   // グループ間
const PAD_X = 2;        // 左右余白

let claudeImg = null;
let codexImg = null;
let logoColor = null; // ロゴ画像を焼いた色。色が変われば再ロードする。

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// SVG を単色で塗った data URL を作る。
//   mac : 黒で塗り、main 側でテンプレート化して明暗追従。
//   Win : テーマに応じた色(白/黒)を直接焼き込む。
function svgDataUrl(rawSvg, color) {
  const painted = rawSvg.replace('<svg ', `<svg fill="${color}" `);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(painted);
}

async function ensureLogos(svgs, color) {
  // 前景色が変わったら（Windows のテーマ切替など）ロゴを塗り直す。
  if (logoColor !== color) {
    claudeImg = null;
    codexImg = null;
    logoColor = color;
  }
  if (!claudeImg) claudeImg = await loadImage(svgDataUrl(svgs.claude, color));
  if (!codexImg) codexImg = await loadImage(svgDataUrl(svgs.codex, color));
}

async function render({ items, scale, svgs, fg, template }) {
  // fg 未指定（旧 main 互換）なら黒。
  const color = fg || '#000000';
  await ensureLogos(svgs, color);

  const ratio = scale || 2; // Retina
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  const FONT = `600 ${FONT_PX}px -apple-system, system-ui, "Segoe UI", sans-serif`;
  ctx.font = FONT;

  // まず合計幅を測る
  let width = PAD_X;
  const layout = [];
  items.forEach((it, i) => {
    const txt = it.text;
    const txtW = Math.ceil(ctx.measureText(txt).width);
    const logoW = it.logo ? SIZE : 0;
    const inner = (logoW ? logoW + GAP_LOGO_TXT : 0) + txtW;
    layout.push({ ...it, txtW, logoW, x: width });
    width += inner;
    if (i < items.length - 1) width += GAP_GROUP;
  });
  width += PAD_X;

  const H = 22; // メニューバー論理高さ
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(H * ratio);
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, H);

  ctx.font = FONT;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  const midY = H / 2;

  layout.forEach((it) => {
    let cx = it.x;
    if (it.logo) {
      const img = it.logo === 'claude' ? claudeImg : codexImg;
      if (img) {
        const y = (H - SIZE) / 2;
        ctx.drawImage(img, cx, y, SIZE, SIZE);
      }
      cx += SIZE + GAP_LOGO_TXT;
    }
    ctx.fillText(it.text, cx, midY + 0.5);
  });

  const dataUrl = canvas.toDataURL('image/png');
  window.api.sendTrayImage({ dataUrl, width: Math.round(width), height: H });
}

window.api.onRenderTray((payload) => {
  render(payload).catch((e) => console.log('tray render error: ' + (e && e.message)));
});
window.api.trayReady();
