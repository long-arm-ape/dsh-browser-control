// 「导航要不要等、等到哪一步」实测：跑真实扩展代码，配一台会演导航的假 Chrome。
//
// 契约（upstream issue #19 的三条）：
//   1. waitUntil 是**显式选项**，默认仍是 load（不改变现存调用的行为）；
//   2. "新文档到达"由 CDP 的 Page.frameNavigated 判定 —— 同站重定向回到同一地址时，
//      「地址变了」这条启发式会等满预算，事件不会；
//   3. 回执如实：waitUntil / readyState / waitedMs 都要带回给模型，且 nav 与 tabs.open
//      共用**同一份**等待器（别在两个命令里各写一份）。
import { bootBackground } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const OLD = "https://old.test/page";
const TARGET = "https://new.test/dest";

async function setup({ nav = "load", readyState = "complete", url = OLD } = {}) {
  const { model, ctx } = await bootBackground();
  const tabId = model.addTab(1, url);
  model.nav = nav;
  model.loadDelayMs = 150;
  model.slowStartMs = 400;
  model.dbg.results["Runtime.evaluate"] = (params) => {
    const ex = String(params?.expression ?? "");
    if (ex.includes("document.readyState")) return { result: { value: readyState } };
    if (ex.includes("location.href")) return { result: { value: model.page.url } };
    if (ex.includes("document.title")) return { result: { value: model.page.title } };
    if (ex.includes("document.body")) return { result: { value: "" } };
    return { result: { value: null } };
  };
  return { model, ctx, tabId };
}

/** 像 Chrome 那样派发一个主框架到达事件（子框架不算到达）。 */
function fireArrival(model, tabId, url) {
  const listeners = model.dbg.listeners.onEvent ?? [];
  for (const fn of listeners) {
    try { fn({ tabId }, "Page.frameNavigated", { frame: { url, parentId: undefined } }); } catch { /* 单个监听器异常不该影响别的 */ }
  }
}

/* 1 —— none：立刻返回，不等加载；回执写明口径 */
{
  const { model, ctx, tabId } = await setup({ nav: "stale" });
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "none" });
  const ms = Date.now() - started;
  check("none：立刻返回（<300ms）", ms < 300, `${ms}ms`);
  check("none：口径如实回报", out.waitUntil === "none", JSON.stringify(out));
  check("none：不等就不报 loadPending（不假装也不知道）", out.loadPending === undefined, JSON.stringify(out));
}

/* 2 —— commit：同站重定向回到同一地址，事件一到就回（这是地址启发式的死穴） */
{
  const { model, ctx, tabId } = await setup({ nav: "stale", url: OLD });
  model.tabs.get(tabId).status = "loading";
  const started = Date.now();
  const pending = ctx.cmdNav({ tabId, url: TARGET, waitUntil: "commit", timeoutMs: 6000 });
  await new Promise((r) => setTimeout(r, 60));
  fireArrival(model, tabId, OLD); // 重定向回到 OLD：地址没变
  const out = await pending;
  const ms = Date.now() - started;
  check("commit：事件到达即回（<1500ms，不靠地址变化）", ms < 1500, `${ms}ms`);
  check("commit：口径如实回报", out.waitUntil === "commit", JSON.stringify(out));
  check("commit：文档到位但页面仍在加载 ⇒ pageLoading（不是 loadPending）", out.pageLoading === true && out.loadPending === undefined, JSON.stringify(out));
}

/* 3 —— commit：一直没有到达事件 ⇒ 等到预算为止，并如实报 loadPending */
{
  const { ctx, tabId } = await setup({ nav: "stale" });
  const started = Date.now();
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "commit", timeoutMs: 600 });
  const ms = Date.now() - started;
  check("commit：没有到达事件 ⇒ 等到预算（≥500ms）", ms >= 500, `${ms}ms`);
  check("commit：超时如实报 loadPending", out.loadPending === true, JSON.stringify(out));
}

/* 4 —— domcontentloaded：到达后 DOM 可用即回，并把 readyState 带回来 */
{
  const { model, ctx, tabId } = await setup({ nav: "stale", readyState: "interactive" });
  model.tabs.get(tabId).status = "loading";
  const started = Date.now();
  const pending = ctx.cmdNav({ tabId, url: TARGET, waitUntil: "domcontentloaded", timeoutMs: 4000 });
  await new Promise((r) => setTimeout(r, 60));
  fireArrival(model, tabId, TARGET);
  const out = await pending;
  const ms = Date.now() - started;
  check("domcontentloaded：DOM 可用即回（<1500ms）", ms < 1500, `${ms}ms`);
  check("domcontentloaded：readyState 如实回报", out.readyState === "interactive", JSON.stringify(out));
  check("domcontentloaded：还没 complete ⇒ pageLoading", out.pageLoading === true && out.loadPending === undefined, JSON.stringify(out));
}

/* 5 —— 默认口径仍是 load：不带 waitUntil 时行为与以前一致 */
{
  const { ctx, tabId } = await setup({ nav: "load" });
  const out = await ctx.cmdNav({ tabId, url: TARGET });
  check("默认口径是 load", out.waitUntil === "load", JSON.stringify(out));
  check("默认口径：正常加载不带 loadPending", out.loadPending === undefined, JSON.stringify(out));
  check("默认口径：回报 waitedMs", typeof out.waitedMs === "number" && out.waitedMs >= 0, JSON.stringify(out));
}

/* 6 —— tabs.open 共用同一份等待器（同样的口径字段、同样按事件判到达） */
{
  const { model, ctx } = await setup({ nav: "stale" });
  const started = Date.now();
  const pending = ctx.cmdTabsOpen({ url: TARGET, waitUntil: "commit", timeoutMs: 6000, group: false });
  await new Promise((r) => setTimeout(r, 80));
  const created = model.nextTabId - 1;
  fireArrival(model, created, TARGET);
  const out = await pending;
  const ms = Date.now() - started;
  check("tabs.open：共用等待器（事件到达即回，<1500ms）", ms < 1500, `${ms}ms`);
  check("tabs.open：口径如实回报", out.waitUntil === "commit", JSON.stringify(out));
  check("tabs.open：回报 waitedMs", typeof out.waitedMs === "number", JSON.stringify(out));
}

/* 7 —— 非法口径回落 load（写错不该变慢或报错） */
{
  const { ctx, tabId } = await setup({ nav: "load" });
  const out = await ctx.cmdNav({ tabId, url: TARGET, waitUntil: "whenever" });
  check("非法 waitUntil ⇒ 回落 load", out.waitUntil === "load", JSON.stringify(out));
}

console.log(fails === 0 ? "\n结论：等待口径与到达判据全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
