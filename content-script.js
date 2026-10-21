(() => {
  "use strict";
  const register = () => chrome.runtime.sendMessage({type: "PBT_FRAME_READY"}).catch(() => {});
  register();

  const fingerprint = () => globalThis.PanoptoCollector.scanDocument().sessions.map((x) => x.id).sort().join(",");
  const firstPageControl = () => {
    const roots = [...document.querySelectorAll('[class*="paginat" i],[id*="paginat" i],[class*="pager" i],[id*="pager" i],[class*="paging" i],[aria-label*="分页"]')];
    const controls = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('button,a[href],[role="button"]')]))];
    const candidates = controls.filter((node) => {
      if (node.disabled || node.getAttribute("aria-disabled") === "true" || node.closest('[hidden],[aria-hidden="true"],.disabled,.ui-state-disabled')) return false;
      if (!node.getClientRects().length) return false;
      const labels = [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent?.trim()];
      return labels.some((label) => /^(?:first(?:\s+page)?|第一页|首页|1)$/i.test(label || ""));
    });
    return candidates[0] || null;
  };
  const waitForChangedList = async (before) => {
    const started = Date.now();
    let previous = "";
    let unchangedSince = 0;
    while (Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const next = fingerprint();
      if (next && next !== before) {
        if (next === previous && Date.now() - unchangedSince >= 700) {
          return {ok: true, scan: globalThis.PanoptoCollector.scanDocument()};
        }
        if (next !== previous) unchangedSince = Date.now();
        previous = next;
      }
    }
    return {ok: false, code: "PAGINATION_TIMEOUT", message: "点击下一页后，未检测到新的讲座列表。"};
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "PBT_REGISTER") { register(); respond({ok: true}); }
    if (message?.type === "PBT_SCAN") {
      try { respond({ok: true, scan: globalThis.PanoptoCollector.scanDocument()}); }
      catch { respond({ok: false, message: "读取讲座列表失败。请刷新课程页后重试。"}); }
    }
    if (message?.type === "PBT_NEXT_PAGE" || message?.type === "PBT_FIRST_PAGE") {
      const control = message.type === "PBT_FIRST_PAGE" ? firstPageControl() : globalThis.PanoptoCollector.findNextPageControl(document);
      if (!control) { respond({ok: false, code: "NO_NEXT", message: "未找到可用的下一页按钮。"}); return; }
      const before = fingerprint();
      control.click();
      waitForChangedList(before).then(respond).catch(() => respond({ok: false, message: "翻页失败。"}));
      return true;
    }
  });
})();
