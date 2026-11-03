// 复现：`nav` 等待预算耗尽后还有两段带预算的后置探针，而插件侧给桥的余量只有 +2s。
//
// 判据（全部在本仓库自带的假件上量，不是真机）：
//   扩展侧 cmdNav 从开始到返回 = budget + (卡住的后置探针总时长)
//   插件侧桥 ceiling        = budget + BRIDGE_MARGIN_MS(2000)
// 若第一项 > 第二项，模型看到的就是 `command_timeout`（effectState=unknown，
// 「可能已经落地」），而不是这条命令本来精心准备的 `loadPending: true` + 诚实的 waitedMs。
//
// 后置探针（extension/background.js cmdNav 里，都在 withBudget(…, 2000) 之内）：
//   location.href          2s
//   document.body.innerText 2s（只在落到 chrome-error: 时跑）
//   document.readyState     2s（probeReadyState）
//
// 「导航卡在提交前让 CDP 闭嘴」不是假设——extension/background.js:905-910 的注释
// 就是同一件事的实测记录（无上限探针让 nav 在 15s 预算下挂过 >40s）。
//
// 跑法：node verify/repro_nav_headroom.mjs
import { bootBackground } from "./ext_harness.mjs";

// src/index.ts:47
const BRIDGE_MARGIN_MS = 2_000;
const READY_STATE_PROBE_MS = 2_000;
const HREF_PROBE_MS = 2_000;
const ERROR_TEXT_PROBE_MS = 2_000;

const OLD = "https://old.test/page";
const TARGET = "https://new.test/dest";

async function measureTabsOpen({ label, tier, timeoutMs, hangProbes }) {
  const { model, ctx, sandbox } = await bootBackground();
  model.addTab(1, OLD);
  model.nav = "hang";
  if (hangProbes) {
    const real = sandbox.chrome.debugger.sendCommand;
    sandbox.chrome.debugger.sendCommand = (target, method, params, cb) => {
      if (method === "Runtime.evaluate") return new Promise(() => {});
      return real(target, method, params, cb);
    };
  }
  const budget = timeoutMs ?? (tier === "load" ? 15_000 : 4_000);
  const params = { url: TARGET, waitUntil: tier, group: false, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const started = Date.now();
  const out = await ctx.cmdTabsOpen(params);
  const elapsed = Date.now() - started;
  const ceiling = budget + BRIDGE_MARGIN_MS;
  console.log(
    `${elapsed > ceiling ? "DEFECT " : "ok     "} ${label}\n` +
      `        budget=${budget}  bridge ceiling=${ceiling}  cmdTabsOpen returned at ${elapsed}ms` +
      `  (over by ${Math.max(0, elapsed - ceiling)}ms)\n` +
      `        receipt: loadPending=${out.loadPending} waitedMs=${out.waitedMs} readyState=${out.readyState ?? "(omitted)"}`,
  );
  return { label, budget, ceiling, elapsed, over: elapsed - ceiling };
}

async function measure({ label, tier, timeoutMs, hangProbes }) {
  const { model, ctx, sandbox } = await bootBackground();
  const tabId = model.addTab(1, OLD);
  // "hang"：tabs.update 之后一直 loading、永不提交、不发任何 CDP 事件
  // ⇒ 到达等待器只能等满预算（不是 1.2s 宽限那条路）
  model.nav = "hang";

  if (hangProbes) {
    const real = sandbox.chrome.debugger.sendCommand;
    sandbox.chrome.debugger.sendCommand = (target, method, params, cb) => {
      if (method === "Runtime.evaluate") return new Promise(() => {}); // CDP 永不回
      return real(target, method, params, cb);
    };
  }

  const budget = timeoutMs ?? (tier === "load" ? 15_000 : 4_000);
  const params = { tabId, url: TARGET, waitUntil: tier, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const started = Date.now();
  const out = await ctx.cmdNav(params);
  const elapsed = Date.now() - started;
  const ceiling = budget + BRIDGE_MARGIN_MS;

  const receipt = [
    `loadPending=${out.loadPending}`,
    `waitedMs=${out.waitedMs}`,
    `waitUntil=${out.waitUntil}`,
    `readyState=${out.readyState ?? "(omitted)"}`,
  ].join(" ");

  console.log(
    `${elapsed > ceiling ? "DEFECT " : "ok     "} ${label}\n` +
      `        budget=${budget}  bridge ceiling=${ceiling}  cmdNav returned at ${elapsed}ms` +
      `  (over by ${Math.max(0, elapsed - ceiling)}ms)\n` +
      `        receipt: ${receipt}`,
  );

  return { label, budget, ceiling, elapsed, over: elapsed - ceiling, out };
}

const results = [];
results.push(
  await measure({ label: "control  commit 800ms，探针正常（CDP 回得快）", tier: "commit", timeoutMs: 800, hangProbes: false }),
);
results.push(
  await measure({ label: "hang     commit 800ms，探针卡住（CDP 对 Runtime.evaluate 闭嘴）", tier: "commit", timeoutMs: 800, hangProbes: true }),
);
results.push(
  await measure({ label: "hang     commit 默认 4000ms，探针卡住", tier: "commit", timeoutMs: undefined, hangProbes: true }),
);
results.push(
  await measureTabsOpen({ label: "hang     tabs.open commit 800ms，探针卡住（对照：tabs.open 只有一个后置探针）", tier: "commit", timeoutMs: 800, hangProbes: true }),
);
results.push(
  await measure({ label: "hang     load 默认 15000ms，探针卡住（默认档也要量，别推断）", tier: "load", timeoutMs: undefined, hangProbes: true }),
);

console.log("\n=== 结论 ===");
const worst = Math.max(...results.map((r) => r.over));
const probeCost = HREF_PROBE_MS + READY_STATE_PROBE_MS;
for (const r of results) {
  console.log(
    `${r.elapsed > r.ceiling ? "过线" : "未过"}  ${r.label}  elapsed=${r.elapsed} ceiling=${r.ceiling} over=${r.over}ms`,
  );
}
console.log(
  `\n最差超出 ${worst}ms。cmdNav 后置探针单次最多 ${probeCost}ms（未落错误页）/ ${probeCost + ERROR_TEXT_PROBE_MS}ms（落 chrome-error:，再多 2s）；cmdTabsOpen 只有 readyState 一个探针，最多 ${READY_STATE_PROBE_MS}ms。`,
);
console.log(`候选修法 A：桥 ceiling = Math.max(8_000, budget + ${probeCost + ERROR_TEXT_PROBE_MS})`);
console.log(`候选修法 B：扩展侧后置探针共享命令的死线（每个探针预算 = 剩余预算），cmdNav 永不超出 budget，现余量就够`);

// 假件里有 setInterval/tick 定时器，不等它们自然排空
process.exit(0);
