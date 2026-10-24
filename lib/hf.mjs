// HyperFrames 構圖的共用零件：裝置外框裡的錄影、標註框、進出場動畫，以及「標註框還在、畫面卻換了」的檢查。
// 構圖腳本（影片專案的 compose/build.mjs）import 這裡，產生各鏡的 HTML 與 GSAP 時間軸字串。
//
//   import { CALLOUT_CSS, callout, calloutIn, calloutOut, checkCallouts, screenClip } from '<工具>/lib/hf.mjs';
//
// 標註框的規則（references/compose.md「標註」）：
// - 粗（1080p 上 7 px）、暖色、外加白色內框與光暈，淺色與深色畫面都看得到。
// - 出現時：框外變暗（聚光）、框從大縮到位、再脈動兩下；可帶一個短標籤說「看這裡的什麼」。
// - 旁白念到時出現；畫面要換（錄影裡下一次點擊生效）之前一定先收掉——checkCallouts 會擋。
const r2 = (n) => Math.round(n * 100) / 100;

export const CALLOUT_CSS = `
  .co { position: absolute; opacity: 0; pointer-events: none; z-index: 20; }
  .co .co-dim { position: absolute; inset: 0; border-radius: 16px; box-shadow: 0 0 0 4000px rgba(12,18,17,0.42); opacity: 0; }
  .co .co-ring { position: absolute; inset: 0; border-radius: 16px; border: 7px solid #F08C00; box-shadow: inset 0 0 0 3px rgba(255,255,255,0.95), 0 0 0 3px rgba(255,255,255,0.95), 0 0 28px 6px rgba(240,140,0,0.55); }
  .co .co-pulse { position: absolute; inset: -4px; border-radius: 20px; border: 6px solid #F08C00; opacity: 0; }
  .co .co-label { position: absolute; white-space: nowrap; padding: 8px 20px; border-radius: 12px; background: #F08C00; color: #fff; font-size: 30px; font-weight: 700; letter-spacing: 0.02em; box-shadow: 0 6px 18px rgba(0,0,0,0.25); }
`;

/**
 * 錄影座標（CSS 像素）上的框，換算到畫面座標。
 * rect：螢幕在畫面上的位置 { x, y, w, h }；src：錄影的 CSS 大小 { w, h }；box：錄影上的框 { x, y, w, h }。
 * zoom（選用）：與 screenClip 相同的放大設定，框會跟著放大後的位置。
 * label：短標籤；labelAt：'top'（預設）| 'bottom' | 'left' | 'right'。dim：要不要聚光（同一時間只開一個）。
 */
export function callout(id, rect, src, box, { label = '', labelAt = 'top', dim = true, zoom = null, pad = 8 } = {}) {
  let { x, y, w, h } = box;
  let sx = rect.w / src.w;
  let sy = rect.h / src.h;
  let ox = rect.x;
  let oy = rect.y;
  if (zoom) {
    const t = zoomTransform(rect, zoom);
    ox += t.tx;
    oy += t.ty;
    sx *= zoom.scale;
    sy *= zoom.scale;
  }
  const L = r2(ox + x * sx - pad);
  const T = r2(oy + y * sy - pad);
  const W = r2(w * sx + pad * 2);
  const H = r2(h * sy + pad * 2);
  const pos = { top: `left:0; bottom:calc(100% + 14px);`, bottom: `left:0; top:calc(100% + 14px);`, left: `right:calc(100% + 16px); top:0;`, right: `left:calc(100% + 16px); top:0;` }[labelAt];
  return `    <div id="${id}" class="co" style="left:${L}px; top:${T}px; width:${W}px; height:${H}px;">${dim ? '<div class="co-dim"></div>' : ''}<div class="co-ring"></div><div class="co-pulse"></div>${label ? `<div class="co-label" style="${pos}">${label}</div>` : ''}</div>`;
}

/** 標註進場：聚光 0.3 秒、框從 1.18 倍縮到位（回彈）、脈動兩下 */
export function calloutIn(sel, t) {
  return [
    `    tl.set("${sel}", { opacity: 1 }, ${r2(t)});`,
    `    tl.fromTo("${sel} .co-dim", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, ${r2(t)});`,
    `    tl.fromTo("${sel} .co-ring", { scale: 1.18, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(2.2)" }, ${r2(t)});`,
    `    tl.fromTo("${sel} .co-label", { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power3.out" }, ${r2(t + 0.15)});`,
    `    tl.fromTo("${sel} .co-pulse", { scale: 1, opacity: 0.9 }, { scale: 1.12, opacity: 0, duration: 0.6, ease: "power2.out", repeat: 1, repeatDelay: 0.15 }, ${r2(t + 0.4)});`,
  ].join('\n');
}

/** 標註收場（0.2 秒淡出）；t 要早於畫面換掉的時間 */
export function calloutOut(sel, t) {
  return `    tl.to("${sel}", { opacity: 0, duration: 0.2, ease: "power2.in" }, ${r2(t)});`;
}

/** 放大設定 { scale, cx, cy, src } → 外層的平移量（把錄影上 (cx, cy) 帶到螢幕中央，不露出邊） */
export function zoomTransform(rect, zoom) {
  const sx = rect.w / zoom.src.w;
  const sy = rect.h / zoom.src.h;
  const tx = Math.min(0, Math.max(rect.w - rect.w * zoom.scale, rect.w / 2 - zoom.cx * sx * zoom.scale));
  const ty = Math.min(0, Math.max(rect.h - rect.h * zoom.scale, rect.h / 2 - zoom.cy * sy * zoom.scale));
  return { tx: r2(tx), ty: r2(ty) };
}

/**
 * 裝置外框裡的一段錄影。rect 是螢幕在畫面上的位置；kind 'tablet' | 'monitor'；
 * start／duration 是場景內秒數，mediaStart 是錄影裡的秒數；zoom 見 zoomTransform（不動的放大，不做晃動的推拉）。
 */
export function screenClip({ id, file, rect, kind = 'tablet', start, duration, mediaStart, zoom, dir = 'assets/captures' }) {
  const pad = kind === 'tablet' ? 22 : 14;
  let wrap = ' style="position:absolute; inset:0;"';
  if (zoom) {
    const { tx, ty } = zoomTransform(rect, zoom);
    wrap = ` style="position:absolute; inset:0; transform-origin:0 0; transform:translate(${tx}px, ${ty}px) scale(${zoom.scale});"`;
  }
  return `    <div class="frame-${kind}" style="left:${rect.x - pad}px; top:${rect.y - pad}px;">
      <div class="screen" style="width:${rect.w}px; height:${rect.h}px;">
        <div${wrap}><video id="${id}" class="clip" src="${dir}/${file}.mp4" muted playsinline data-start="${r2(start)}" data-duration="${r2(duration)}" data-media-start="${r2(Math.max(0, mediaStart))}"></video></div>
      </div>
    </div>`;
}

/**
 * 檢查標註框有沒有「畫面已經換了還掛著」：
 * items：[{ id, clip（錄影的 .json 內容）, mediaFrom, mediaTo }]，mediaFrom／mediaTo 是標註顯示期間對應的錄影秒數。
 * 錄影裡每一個 tap 標記的 click（真的點下去、畫面開始換的時間）不能落在 (mediaFrom, mediaTo + 0.1) 之間；
 * 標記 kind 為 'change' 的（例：新紀錄進來）也一樣。有問題就丟錯，列出哪個框、哪一次點擊。
 */
export function checkCallouts(items) {
  const bad = [];
  for (const it of items) {
    for (const m of it.clip.marks ?? []) {
      const t = m.kind === 'tap' ? m.click : m.kind === 'change' ? m.at : null;
      if (t === null || t === undefined) continue;
      if (t > it.mediaFrom && t < it.mediaTo + 0.1) bad.push(`${it.id}：錄影第 ${r2(it.mediaFrom)}–${r2(it.mediaTo)} 秒顯示，但「${m.label}」在第 ${r2(t)} 秒讓畫面換了`);
    }
  }
  if (bad.length) throw new Error(`標註框跨過了畫面切換：\n${bad.join('\n')}`);
}

/** 常用的進場動畫（t 是場景內秒數） */
export const anim = {
  blurIn: (sel, t, d = 0.35) => `    tl.fromTo("${sel}", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: ${d}, ease: "expo.out" }, ${r2(t)});`,
  fadeIn: (sel, t, d = 0.4) => `    tl.fromTo("${sel}", { opacity: 0 }, { opacity: 1, duration: ${d}, ease: "power2.out" }, ${r2(t)});`,
  fadeOut: (sel, t, d = 0.2) => `    tl.to("${sel}", { opacity: 0, duration: ${d}, ease: "power2.in" }, ${r2(t)});`,
  riseIn: (sel, t, d = 0.5) => `    tl.fromTo("${sel}", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: ${d}, ease: "power4.out" }, ${r2(t)});`,
};
