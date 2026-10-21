// Runs in the extension dashboard, where granted host permissions apply to fetch.
// Video bytes remain in the response stream; the ZIP writer consumes them on disk.
function transferError(code, message, extra = {}) {
  return Object.assign(new Error(message), {code, ...extra});
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("已停止视频下载。", "AbortError");
}

function notVideoPath(url) {
  return /\.(?:m3u8|mpd|ism|isml|mp3|m4a|aac|wav|ogg|srt|vtt|txt|json|xml|html?)(?:\/|$)/i.test(url.pathname)
    || /\/(?:Viewer|Embed|Login|SignIn)\.aspx$/i.test(url.pathname);
}

function videoContentType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  // Object stores can omit Content-Type or use a generic download MIME type.
  if (!type) return true;
  if (/^video\//.test(type)) return !/(?:mpegurl|mp2t)/.test(type);
  return new Set([
    "application/octet-stream", "binary/octet-stream", "application/mp4",
    "application/x-matroska", "application/download", "application/x-download",
    "application/force-download"
  ]).has(type);
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Release any unread response. */ }
}

/**
 * Fetch one native Panopto video download without buffering its body.
 * Only an actual requested/redirected HTTPS origin can become a permission hint.
 * The caller requests that permission from its own user-gesture handler.
 */
export async function fetchVideoStream(value, {signal} = {}) {
  throwIfAborted(signal);
  const initial = httpsUrl(value);
  if (!initial || notVideoPath(initial)) {
    throw transferError("VIDEO_INVALID_URL", "视频下载地址不是可保存的视频文件。");
  }

  const extension = globalThis.chrome;
  let latestTarget = initial;
  let requestId = null;
  let expectedTabId = null;
  let observer = null;
  const event = extension?.webRequest?.onBeforeRedirect;
  const ownOrigin = extension?.runtime?.getURL?.("")?.replace(/\/$/, "");

  if (event?.addListener && ownOrigin) {
    try {
      const tab = await extension.tabs?.getCurrent?.();
      if (Number.isInteger(tab?.id)) expectedTabId = tab.id;
    } catch { /* Initiator + exact URL/request ID still isolate this transfer. */ }
    throwIfAborted(signal);
    observer = (details) => {
      if (details.initiator !== ownOrigin || details.type !== "xmlhttprequest") return;
      // Some extension-origin requests have no tab association (tabId === -1).
      if (expectedTabId !== null && details.tabId >= 0 && details.tabId !== expectedTabId) return;
      if (requestId === null) {
        if (details.url !== initial.href || !details.requestId) return;
        requestId = details.requestId;
      } else if (details.requestId !== requestId) return;
      // Never retain signed URLs outside this active transfer or expose them in errors.
      latestTarget = httpsUrl(details.redirectUrl);
    };
    // A filter grants no host access. Chrome exposes only already granted hosts;
    // the checks above narrow those events to this dashboard's current request.
    event.addListener(observer, {urls: ["https://*/*"], types: ["xmlhttprequest"]});
  }

  try {
    let response;
    try {
      response = await fetch(initial.href, {credentials: "include", redirect: "follow", signal});
    } catch (cause) {
      if (cause?.name === "AbortError") throw cause;
      throwIfAborted(signal);
      // Let already queued onBeforeRedirect notifications reach this page.
      await new Promise((resolve) => setTimeout(resolve, 0));
      throwIfAborted(signal);
      if (cause instanceof TypeError && latestTarget && extension?.permissions?.contains) {
        const permissionOrigin = `${latestTarget.origin}/*`;
        let granted = null;
        try { granted = await extension.permissions.contains({origins: [permissionOrigin]}); } catch { /* Treat unknown permission state as a network failure. */ }
        throwIfAborted(signal);
        if (granted === false) {
          throw transferError("VIDEO_HOST_PERMISSION", "需要读取视频下载站点。点击“重试失败”授权后继续。", {permissionOrigin});
        }
      }
      throw transferError("VIDEO_NETWORK_ERROR", "视频下载连接失败，请重试。");
    }

    throwIfAborted(signal);
    let error = null;
    if (!response.ok) {
      error = transferError("VIDEO_HTTP_ERROR", `视频下载请求失败（HTTP ${response.status}）。`);
    } else if (response.status === 206) {
      error = transferError("VIDEO_PARTIAL_RESPONSE", "下载站点返回了视频片段，请重试获取完整视频。");
    } else if (response.url && (!httpsUrl(response.url) || notVideoPath(httpsUrl(response.url)))) {
      error = transferError("VIDEO_INVALID_RESPONSE", "下载站点返回了网页、音频或播放清单，没有返回视频文件。");
    } else if (!videoContentType(response.headers.get("content-type"))) {
      error = transferError("VIDEO_INVALID_RESPONSE", "下载站点返回了网页、音频或播放清单，没有返回视频文件。");
    } else if (!response.body || typeof response.body.getReader !== "function") {
      error = transferError("VIDEO_EMPTY_RESPONSE", "下载站点没有返回视频内容。");
    }

    const length = response.headers.get("content-length");
    const lengthValue = length !== null && /^\d+$/.test(length.trim()) ? Number(length) : null;
    if (!error && lengthValue === 0) error = transferError("VIDEO_EMPTY_RESPONSE", "下载站点返回了空视频文件。");
    if (error) {
      await cancelBody(response);
      throw error;
    }
    const encoding = response.headers.get("content-encoding");
    const totalBytes = Number.isSafeInteger(lengthValue) && lengthValue > 0 && (!encoding || encoding.toLowerCase() === "identity") ? lengthValue : null;
    return {stream: response.body, totalBytes};
  } finally {
    if (observer) event.removeListener(observer);
  }
}
