// 把 Node 行程裡的時間平移 FV_CLOCK_OFFSET_MS 毫秒（被拍系統的後端用；瀏覽器那邊用 capture.mjs 的 shiftClock）。
// 用法：node --require <工具>/lib/clock-shim.cjs app.js，或 NODE_OPTIONS="--require <路徑>"；沒設環境變數就什麼都不做。
const off = Number(process.env.FV_CLOCK_OFFSET_MS || 0);
if (off) {
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
}
