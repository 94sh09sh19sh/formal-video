// 操作畫面錄製：用 DevTools 協定逐格擷取（比 Playwright 內建錄影清楚），每格帶時間戳，
// 結束後依實際間隔組成固定幀率的 mp4。
// 兩種擷取法：
//   screenshot（預設）：連續 Page.captureScreenshot，照 deviceScaleFactor 輸出（1280×800 ×1.5 → 1920×1200），約 25 fps
//   screencast：Page.startScreencast，畫面有變才送格、較省 CPU，但無頭模式下只給 CSS 像素大小
//
// 不直接 import Playwright：影片專案自己裝 playwright-core（版本跟著專案走），把 page 傳進來即可。
//
//   import { chromium } from 'playwright-core';
//   import { createRecorder, installCursor, tap } from '<工具>/lib/capture.mjs';
//   const page = await context.newPage();
//   await installCursor(page);                 // 畫面上的游標與按壓圈（要在 goto 之前）
//   const rec = await createRecorder(page, { outDir: 'captures/shot5-patient' });
//   await rec.start();
//   await tap(page, page.getByRole('button', { name: '我需要協助' }), { rec, label: '按求助', at: 3.2 });
//   const clip = await rec.stop();             // { mp4, start, end, frames, marks }
//
// 時間怎麼排：先有旁白時間表（build/narration.json），用 lib/narration.mjs 查「念到某個詞」的時間，
// 換算成錄影裡的秒數傳給 tap 的 at——觀眾看到按壓的那一刻就是旁白念到的那一刻，合成時不必再剪接對時。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 畫面上的游標：平常不出現；tap() 時先出現、滑到目標、按壓（縮小＋擴散圈），等觀眾看清楚了才真的點下去。
 * 只加在被錄的瀏覽器裡，不動被錄的程式。size 是 CSS 像素（deviceScaleFactor 1.5 時錄出來約 1.5 倍）。
 */
export async function installCursor(page, { color = 'rgba(37, 99, 235, 0.62)', size = 46 } = {}) {
  await page.addInitScript(
    ({ color, size }) => {
      let el = null;
      let ring = null;
      let hideTimer = 0;
      const base = { position: 'fixed', left: '0px', top: '0px', width: `${size}px`, height: `${size}px`, marginLeft: `${-size / 2}px`, marginTop: `${-size / 2}px`, borderRadius: '50%', pointerEvents: 'none' };
      const ensure = () => {
        if (el && el.isConnected) return;
        el = document.createElement('div');
        el.setAttribute('data-fv-cursor', '');
        Object.assign(el.style, base, { background: color, border: '4px solid rgba(255,255,255,0.95)', boxShadow: '0 2px 10px rgba(0,0,0,0.35)', zIndex: 2147483647, opacity: '0' });
        ring = document.createElement('div');
        Object.assign(ring.style, base, { border: `5px solid ${color}`, zIndex: 2147483646, opacity: '0' });
        document.documentElement.append(ring, el);
      };
      const place = (node, x, y) => { node.style.left = `${x}px`; node.style.top = `${y}px`; };
      window.__fvCursor = {
        /** 出現在 (fromX, fromY)，ms 毫秒內滑到 (x, y) */
        glide(fromX, fromY, x, y, ms) {
          ensure();
          clearTimeout(hideTimer);
          el.style.transition = 'none';
          place(el, fromX, fromY);
          el.style.transform = 'scale(1)';
          void el.offsetWidth;
          el.style.transition = `opacity 160ms ease-out, transform 140ms ease-out, left ${ms}ms cubic-bezier(.3,.7,.2,1), top ${ms}ms cubic-bezier(.3,.7,.2,1)`;
          el.style.opacity = '1';
          place(el, x, y);
        },
        /** 按壓：游標縮小、擴散一圈；之後停在原處，hideAfter 毫秒後淡出 */
        press(hideAfter) {
          ensure();
          el.style.transform = 'scale(0.72)';
          place(ring, parseFloat(el.style.left), parseFloat(el.style.top));
          ring.animate([{ opacity: 0.9, transform: 'scale(0.8)' }, { opacity: 0, transform: 'scale(2.6)' }], { duration: 650, easing: 'ease-out' });
          setTimeout(() => { el.style.transform = 'scale(1)'; }, 260);
          hideTimer = setTimeout(() => { el.style.opacity = '0'; }, hideAfter);
        },
      };
    },
    { color, size },
  );
}

/** 舊名。舊版只在點下去的同一格畫圈，觀眾看到圈時畫面已經換了；現在一律先按壓、後生效 */
export const tapMarks = installCursor;

const lastPos = new WeakMap();

/**
 * 點一下，而且讓觀眾先看到再發生：游標滑過去（glide 秒）→ 按壓（記標記）→ lead 秒後才真的點。
 * target：Playwright locator 或 { x, y }（CSS 像素）。
 * at：要觀眾「看到按壓」的錄影秒數（rec.at 會等到那時候）；不給就馬上做。
 * 回傳 { press, click }（錄影秒數）。標記寫成 { label, at: press, click, kind: 'tap' }；合成時畫面在 click 之後才會換。
 */
export async function tap(page, target, { rec, label, at, lead = 0.45, glide = 0.4, hideAfter = 900 } = {}) {
  let x;
  let y;
  if (typeof target.boundingBox === 'function') {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`tap：找不到「${label ?? '目標'}」的位置`);
    x = box.x + box.width / 2;
    y = box.y + box.height / 2;
  } else ({ x, y } = target);
  const vp = page.viewportSize();
  const from = lastPos.get(page) ?? { x: Math.min(vp.width - 40, x + 140), y: Math.min(vp.height - 40, y + 110) };
  if (rec && at !== undefined) await rec.at(at - glide, label);
  await page.evaluate(([fx, fy, tx, ty, ms]) => window.__fvCursor?.glide(fx, fy, tx, ty, ms), [from.x, from.y, x, y, Math.round(glide * 1000)]);
  await sleep(glide * 1000);
  await page.evaluate((ms) => window.__fvCursor?.press(ms), hideAfter);
  const press = rec ? rec.now() : 0;
  await sleep(lead * 1000);
  await page.mouse.click(x, y);
  const click = rec ? rec.now() : 0;
  lastPos.set(page, { x, y });
  if (rec && label) rec.mark(label, { at: press, click, kind: 'tap' });
  return { press, click };
}

/**
 * 被拍系統的時間跟著真實時間走、現在又不適合錄（例：午夜跨日、畫面時鐘顯示凌晨）時，把瀏覽器裡的時間平移 offsetMs。
 * 後端要平移同樣的量：Node 行程加 `--require <工具>/lib/clock-shim.cjs` 並設 FV_CLOCK_OFFSET_MS。在 newPage 之前對 context 呼叫。
 * 資料庫或 ORM 自己填的時間（例：Prisma @default(now())）不會跟著平移，這種系統不要用（references/capture.md）。
 */
export async function shiftClock(context, offsetMs) {
  if (!offsetMs) return;
  await context.addInitScript((off) => {
    const RealDate = Date;
    class ShiftedDate extends RealDate {
      constructor(...a) {
        if (a.length === 0) super(RealDate.now() + off);
        else super(...a);
      }
      static now() {
        return RealDate.now() + off;
      }
    }
    globalThis.Date = ShiftedDate;
  }, offsetMs);
}

const sessions = new WeakMap();
// 帶 clip.scale 的擷取做完，Chrome 會把頁面的 deviceScaleFactor 模擬重設回 1；倍率在第一次建錄影器時記下來，之後都用它
const scales = new WeakMap();

/**
 * 建一個錄影器。outDir 每次 start 會清空。
 * 選項：mode（screenshot｜screencast）、fps（輸出幀率，預設 30）、quality（JPEG 品質，預設 92）、ffmpeg（執行檔路徑）。
 */
export async function createRecorder(page, { outDir, mode = 'screenshot', fps = 30, quality = 92, ffmpeg = process.env.FV_FFMPEG || 'ffmpeg' }) {
  const dir = resolve(outDir);
  // 同一頁只開一個 DevTools 連線：第二個連線的擷取會丟掉 deviceScaleFactor（實測錄成 1280×800）
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  if (!scales.has(page)) scales.set(page, await page.evaluate(() => window.devicePixelRatio));
  const cdp = sessions.get(page);
  let frames = [];
  let recording = false;
  let startedAt = 0;
  let loop = null;

  const save = (data, t) => {
    const file = join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t });
  };

  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // 先回 ack，瀏覽器才會送下一格
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    save(data, metadata.timestamp ?? Date.now() / 1000);
  });

  return {
    async start() {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      frames = [];
      recording = true;
      startedAt = Date.now() / 1000;
      if (mode === 'screenshot') {
        // deviceScaleFactor 不一定反映在擷取結果上；用 clip.scale 明確要求以 dpr 倍率算圖。
        // clip 是文件座標，頁面捲動過就要跟著目前可見範圍的左上角（每格問一次 getLayoutMetrics）
        const vp = page.viewportSize();
        const dpr = scales.get(page);
        loop = (async () => {
          while (recording) {
            const t = Date.now() / 1000;
            const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
            const v = m?.cssVisualViewport ?? { pageX: 0, pageY: 0 };
            const clip = { x: v.pageX, y: v.pageY, width: vp.width, height: vp.height, scale: dpr };
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true, clip, captureBeyondViewport: false }).catch(() => ({}));
            if (data && recording) save(data, t);
          }
        })();
        return startedAt;
      }
      const vp = page.viewportSize();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality, everyNthFrame: 1,
        maxWidth: Math.round(vp.width * dpr), maxHeight: Math.round(vp.height * dpr),
      });
      return startedAt;
    },
    /** 錄影開始到現在的秒數 */
    now() {
      return Date.now() / 1000 - startedAt;
    },
    /** 等到錄影第 t 秒；已經過了就馬上回來，晚超過 0.15 秒時印警告（前一步太久或系統反應慢，畫面會比旁白晚） */
    async at(t, what = '') {
      const late = this.now() - t;
      if (late < 0) await sleep(-late * 1000);
      else if (late > 0.15) console.warn(`  ⚠ ${dir}：「${what}」晚了 ${late.toFixed(2)} 秒（排在第 ${t.toFixed(2)} 秒）`);
      return Math.max(0, late);
    },
    /** 標一個時間點（例如「新紀錄進來」），合成時拿來對齊。extra 可帶 at（不給就是現在）、click、kind。 */
    mark(label, extra = {}) {
      const r3 = (n) => Math.round(n * 1000) / 1000;
      const m = { ...extra, label, at: r3(extra.at ?? this.now()) };
      if (m.click !== undefined) m.click = r3(m.click);
      (this.marks ??= []).push(m);
      return m.at;
    },
    async stop() {
      const endedAt = Date.now() / 1000;
      if (mode === 'screenshot') {
        recording = false;
        await loop;
      } else {
        await cdp.send('Page.stopScreencast').catch(() => {});
        // 等最後幾格寫完
        await new Promise((r) => setTimeout(r, 300));
        recording = false;
      }
      if (frames.length === 0) throw new Error(`沒有錄到任何畫面：${dir}`);
      // 畫面沒變時 screencast 不送新格；第一格補到開始、最後一格撐到結束
      const lines = ['ffconcat version 1.0'];
      for (let i = 0; i < frames.length; i++) {
        const from = i === 0 ? startedAt : frames[i].t;
        const to = i + 1 < frames.length ? frames[i + 1].t : endedAt;
        lines.push(`file '${frames[i].file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        lines.push(`duration ${Math.max(0.001, to - from).toFixed(4)}`);
      }
      lines.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`);
      const list = join(dir, 'frames.ffconcat');
      writeFileSync(list, lines.join('\n'));
      const mp4 = `${dir}.mp4`;
      const res = spawnSync(
        ffmpeg,
        ['-v', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', list, '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv,format=yuv420p`,
          // JPEG 是全範圍色彩，不轉成一般影片的有限範圍，瀏覽器播放時顏色會跑掉或整片不顯示
          '-color_range', 'tv', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', mp4],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) throw new Error(`組影片失敗：${res.stderr}`);
      const meta = { mp4, start: startedAt, end: endedAt, seconds: endedAt - startedAt, frames: frames.length, marks: this.marks ?? [] };
      writeFileSync(`${dir}.json`, JSON.stringify(meta, null, 1));
      this.marks = [];
      return meta;
    },
  };
}
