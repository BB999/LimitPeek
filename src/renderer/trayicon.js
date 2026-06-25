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

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// SVG を単色(黒)で塗ったテンプレートにするため、data URL を fill 指定付きで作る。
function svgDataUrl(rawSvg) {
  // fill を currentColor 化 → 黒で塗る（テンプレート化は main 側で行う）
  const black = rawSvg.replace('<svg ', '<svg fill="#000000" ');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(black);
}

async function ensureLogos(svgs) {
  if (!claudeImg) claudeImg = await loadImage(svgDataUrl(svgs.claude));
  if (!codexImg) codexImg = await loadImage(svgDataUrl(svgs.codex));
}

async function render({ items, scale, svgs }) {
  await ensureLogos(svgs);

  const ratio = scale || 2; // Retina
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  ctx.font = `600 ${FONT_PX}px -apple-system, system-ui, sans-serif`;

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

  ctx.font = `600 ${FONT_PX}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = '#000000';
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
