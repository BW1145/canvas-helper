export function createMaterialsSource(tabId) {
  return async (method, args, signal) => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("请从 Canvas 课程总览打开课程资料。");
    if (signal?.aborted) throw new DOMException("已停止读取。", "AbortError");
    const task = (async () => {
      await chrome.scripting.executeScript({target: {tabId}, world: "ISOLATED", files: ["materials-client.js"]});
      if (signal?.aborted) throw new DOMException("已停止读取。", "AbortError");
      const results = await chrome.scripting.executeScript({target: {tabId}, world: "ISOLATED", func: async (name, values) => {
        const client = globalThis.CanvasMaterialsClient;
        return client && ["catalog", "moduleItems", "pageLinks", "file"].includes(name) ? await client[name](...values) : {ok: false, code: "CLIENT_MISSING", message: "Canvas 页面已刷新，请重新读取资料。"};
      }, args: [method, args]});
      const result = results[0]?.result;
      if (!result?.ok) throw Object.assign(new Error(result?.message || "课程资料读取失败，请刷新。"), {code: result?.code});
      return result;
    })().catch(cause => {
      if (cause.code || cause.name === "AbortError") throw cause;
      throw new Error("请保持原 Canvas 标签页打开，并确认登录后重试。");
    });
    return await new Promise((resolve, reject) => {
      const stop = () => reject(new DOMException("已停止读取。", "AbortError"));
      signal?.addEventListener("abort", stop, {once: true});
      task.then(resolve, reject).finally(() => signal?.removeEventListener("abort", stop));
      if (signal?.aborted) stop();
    });
  };
}
