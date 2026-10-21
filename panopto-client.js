(() => {
  "use strict";
  const VERSION = "0.5.1";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const error = (code, message) => Object.assign(new Error(message), {code});
  const unwrap = (value) => {
    for (let i = 0; i < 3; i++) {
      if (value && typeof value === "object" && !Array.isArray(value) && "d" in value) value = value.d;
      else if (typeof value === "string") { try { value = JSON.parse(value); } catch { break; } }
      else break;
    }
    return value;
  };

  function checkServerError(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.ErrorCode !== undefined && data.ErrorCode !== null && ![0, "0", "", false].includes(data.ErrorCode)) {
      throw error("SERVER_ERROR", "Panopto 返回访问或会话错误，未保存该响应。");
    }
    if (data.Success === false || data.success === false) throw error("SERVER_ERROR", "Panopto 未完成字幕请求。");
  }

  function explicitDownloadDenied(data) {
    const keys = new Set([
      "allowcaptiondownload", "allowcaptionsdownload", "candownloadcaptions",
      "captiondownloadenabled", "captionsdownloadenabled", "enablecaptiondownload",
      "captioningenabledownloadinviewers", "allowtranscriptdownload", "candownloadtranscript"
    ]);
    for (const value of [data, data?.Delivery, data?.Settings, data?.Delivery?.Settings]) {
      if (!value || typeof value !== "object") continue;
      for (const [key, flag] of Object.entries(value)) {
        if (keys.has(key.replace(/[^a-z]/gi, "").toLowerCase()) && [false, "false", 0, "0"].includes(flag)) return true;
      }
    }
    return false;
  }

  async function request(url, options = {}, kind = "json") {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith("/Panopto/")) {
      throw error("BAD_TARGET", "拒绝请求课程站点以外的地址。");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await globalThis.fetch(target.href, {
        credentials: "include", cache: "no-store", redirect: "follow", ...options, signal: controller.signal
      });
      if (response.status === 401) throw error("AUTH_REQUIRED", "登录状态未被字幕接口接受。");
      if (response.status === 403) throw error("ACCESS_DENIED", "当前账户没有取得这份转录稿的权限。");
      if (response.status === 429) throw error("RATE_LIMIT", "Panopto 请求过于频繁，请稍后重试。");
      if (!response.ok) throw error("HTTP_ERROR", `字幕请求失败（HTTP ${response.status}）。`);
      const finalUrl = new URL(response.url || target.href, target.href);
      if (finalUrl.origin !== location.origin || /\/(?:Auth|Login|SignIn|SSO|SAML)(?:\/|\.|\?|$)/i.test(finalUrl.pathname)) {
        throw error("AUTH_REQUIRED", "请求进入了学校登录流程。");
      }
      const text = await response.text();
      if (!text.trim()) throw error("EMPTY_RESPONSE", "Panopto 返回了空白内容；可能需要重新建立登录状态。");
      if (/^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text) || /text\/html/i.test(response.headers.get("content-type") || "")) {
        throw error("HTML_RESPONSE", "返回的是网页或登录页面，未将其当作转录稿保存。");
      }
      if (kind === "text") {
        if (/[\u0000]/.test(text) || /^(?:video|audio|image)\//i.test(response.headers.get("content-type") || "")) {
          throw error("INVALID_RESPONSE", "下载内容不是文字字幕。");
        }
        return text.replace(/^\uFEFF/, "");
      }
      let json;
      try { json = unwrap(JSON.parse(text)); }
      catch { throw error("INVALID_RESPONSE", "字幕接口返回了无法识别的内容。"); }
      checkServerError(json);
      return json;
    } catch (cause) {
      if (cause.name === "AbortError") throw error("TIMEOUT", "字幕请求超过 25 秒，请重试。");
      if (typeof cause.code === "string") throw cause;
      throw error("NETWORK_ERROR", "浏览器未能完成字幕请求；可能与网络或内嵌页面登录有关。");
    } finally { clearTimeout(timer); }
  }

  const post = (fields) => request("/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    },
    body: new URLSearchParams(fields).toString()
  });

  function nativeCaptionLink(id) {
    const current = new URL(location.href);
    if (!/\/(?:Viewer|Embed)\.aspx$/i.test(current.pathname) || current.searchParams.get("id")?.toLowerCase() !== id.toLowerCase()) return null;
    for (const link of document.querySelectorAll("a[href]")) {
      const label = `${link.textContent || ""} ${link.getAttribute("title") || ""} ${link.getAttribute("aria-label") || ""}`;
      let url;
      try { url = new URL(link.getAttribute("href"), location.href); } catch { continue; }
      if (url.origin !== location.origin || !url.pathname.startsWith("/Panopto/")) continue;
      const handler = /\/Transcription\/GenerateSRT\.ashx$/i.test(url.pathname);
      const labeledDownload = /(?:download|下载)/i.test(label) && /(?:caption|transcript|字幕|转录|文字稿)/i.test(label);
      if (!handler && !labeledDownload) continue;
      const linkedId = url.searchParams.get("id");
      if (linkedId && UUID.test(linkedId) && linkedId.toLowerCase() !== id.toLowerCase()) continue;
      if (/\/(?:Viewer|Embed)\.aspx$/i.test(url.pathname)) continue;
      return url;
    }
    return null;
  }

  function rawTranscript(raw, method, language = "默认") {
    if (/\d+:\d{2}:\d{2}[,.]\d+\s*-->\s*\d+:\d{2}:\d{2}[,.]\d+/.test(raw)) {
      return {ok: true, kind: "srt", raw, language, method};
    }
    let isJson = false;
    try { JSON.parse(raw); isJson = true; } catch {}
    if (method === "native-link" && !isJson && !/^\s*<(?:\?xml|Error|Exception|form\b)/i.test(raw)) {
      return {ok: true, kind: "text", text: raw, language, method};
    }
    throw error("INVALID_RESPONSE", "响应中没有找到有效字幕时间码。");
  }

  async function getTranscript(id) {
    try {
      if (!UUID.test(id)) throw error("BAD_ID", "讲座编号无效。");
      if (location.protocol !== "https:" || !/(^|\.)panopto\.(com|eu)$/i.test(location.hostname)) {
        throw error("BAD_ORIGIN", "当前页面不是支持的 Panopto 站点。");
      }
      const native = nativeCaptionLink(id);
      let info;
      try { info = await post({deliveryId: id, isEmbed: "true", responseType: "json"}); }
      catch (cause) {
        if (native && !["ACCESS_DENIED", "DOWNLOAD_DISABLED", "RATE_LIMIT"].includes(cause.code)) {
          return rawTranscript(await request(native.href, {}, "text"), "native-link");
        }
        throw cause;
      }
      if (explicitDownloadDenied(info)) throw error("DOWNLOAD_DISABLED", "该讲座明确禁用了转录稿下载。");
      const delivery = info?.Delivery;
      if (!delivery || typeof delivery !== "object") throw error("INVALID_RESPONSE", "未能取得讲座信息。");
      const title = [delivery.SessionName, delivery.DisplayName, delivery.Name].find((x) => typeof x === "string" && x.trim()) || "";
      if (native) {
        try { return {...rawTranscript(await request(native.href, {}, "text"), "native-link"), title}; }
        catch (cause) {
          if (["ACCESS_DENIED", "DOWNLOAD_DISABLED", "RATE_LIMIT"].includes(cause.code)) throw cause;
        }
      }
      const available = delivery.AvailableCaptions;
      if (Array.isArray(available) && available.length === 0) throw error("NO_CAPTIONS", "该讲座没有可用的字幕轨道。");
      if (!Array.isArray(available)) throw error("UNKNOWN_CAPTIONS", "页面没有返回可识别的字幕语言列表。");
      const tracks = available.filter((track) => track && /^[A-Za-z0-9_-]{1,64}$/.test(String(track.Language ?? "")));
      tracks.sort((a, b) => Number(Boolean(b.IsDefault || b.IsPrimary)) - Number(Boolean(a.IsDefault || a.IsPrimary)));
      if (!tracks.length) throw error("UNKNOWN_CAPTIONS", "未能识别该讲座的字幕语言。");
      let lastError = null;
      for (const track of tracks.slice(0, 12)) {
        const language = String(track.DisplayName || track.LanguageName || track.Name || track.Language);
        try {
          const payload = await post({deliveryId: id, getCaptions: "true", language: String(track.Language), responseType: "json"});
          const list = Array.isArray(payload) ? payload : (payload?.Captions || payload?.captions);
          if (!Array.isArray(list)) throw error("INVALID_RESPONSE", "字幕接口没有返回字幕列表。");
          const cues = list.filter((item) => item && typeof item.Caption === "string" && item.Caption.trim()).map((item) => ({
            text: item.Caption,
            start: typeof item.Time === "number" ? item.Time : (typeof item.Time === "string" && item.Time.trim() ? Number(item.Time) : null),
            duration: typeof item.CaptionDuration === "number" ? item.CaptionDuration : (typeof item.CaptionDuration === "string" && item.CaptionDuration.trim() ? Number(item.CaptionDuration) : null)
          }));
          if (cues.length) return {ok: true, kind: "cues", cues, language, title, method: "player-captions"};
          lastError = error("EMPTY_CAPTIONS", "已找到字幕轨道，但未取得字幕文字。");
        } catch (cause) {
          lastError = cause;
          if (["AUTH_REQUIRED", "ACCESS_DENIED", "DOWNLOAD_DISABLED", "RATE_LIMIT"].includes(cause.code)) throw cause;
        }
      }
      // Use only a language returned by this session, not a guessed language ID.
      const selected = tracks[0];
      const url = new URL("/Panopto/Pages/Transcription/GenerateSRT.ashx", location.origin);
      url.searchParams.set("id", id);
      url.searchParams.set("language", String(selected.Language));
      try {
        return {...rawTranscript(await request(url.href, {}, "text"), "srt-handler", String(selected.Language)), title};
      } catch (cause) {
        // Empty 200 responses are kept distinct from sessions with no caption track.
        throw cause.code === "INVALID_RESPONSE" && lastError ? lastError : cause;
      }
    } catch (cause) {
      return {ok: false, code: cause.code || "UNEXPECTED_ERROR", message: cause.code ? cause.message : "读取转录稿时出现了未预期错误。"};
    }
  }

  function currentViewer(id) {
    const current = new URL(location.href);
    return /\/(?:Viewer|Embed)\.aspx$/i.test(current.pathname)
      && current.searchParams.get("id")?.toLowerCase() === id.toLowerCase();
  }

  function videoDownloadUrl(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().startsWith("#") || /[\u0000-\u001f\u007f]/.test(value)) return null;
    let url;
    try { url = new URL(value, location.href); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // This feature downloads existing files, not playback manifests or audio.
    if (/\.(?:m3u8|mpd|ism|isml|mp3|m4a|aac|wav|ogg|srt|vtt|txt|json|html?)(?:\/|$)/i.test(url.pathname)
      || /\/(?:Viewer|Embed|Login|SignIn)\.aspx$/i.test(url.pathname)
      || /^audio/i.test(url.searchParams.get("mediaTargetType") || "")) return null;
    const extension = url.pathname.match(/\.(mp4|m4v|webm|mov|mkv)$/i)?.[1].toLowerCase();
    if (!extension && !(url.origin === location.origin && /\/Panopto\/Podcast\/Download\//i.test(url.pathname))) return null;
    return {url: url.href, ...(extension ? {format: extension} : {})};
  }

  function nativeVideoDownload(id) {
    const result = {currentViewer: currentViewer(id), link: null, disabled: false};
    if (!result.currentViewer) return result;
    for (const link of document.querySelectorAll("a[href]")) {
      const label = `${link.textContent || ""} ${link.getAttribute("title") || ""} ${link.getAttribute("aria-label") || ""} ${link.getAttribute("id") || ""}`;
      const raw = link.getAttribute("href");
      let url;
      try { url = new URL(raw, location.href); } catch { continue; }
      if (/(?:caption|transcript|subtitle|字幕|转录|文字稿)/i.test(label) || /\/(?:Transcription|Captions?)\//i.test(url.pathname)) continue;
      const handler = url.origin === location.origin && /\/Panopto\/Podcast\/Download\//i.test(url.pathname);
      const labeledDownload = /(?:download|下载)/i.test(label) && /(?:video|podcast|视频|播客)/i.test(label);
      if (!handler && !labeledDownload) continue;
      if (/\.(?:mp3|m4a|aac|wav|ogg)$/i.test(url.pathname) || /(?:audio|音频)/i.test(label)
        || /^audio/i.test(url.searchParams.get("mediaTargetType") || "")) continue;
      const linkedId = url.searchParams.get("id") || url.searchParams.get("deliveryId") || url.searchParams.get("sessionId");
      if (linkedId && UUID.test(linkedId) && linkedId.toLowerCase() !== id.toLowerCase()) continue;
      if (link.getAttribute("disabled") !== null || link.getAttribute("aria-disabled") === "true"
        || /(?:^|\s)disabled(?:\s|$)/i.test(link.getAttribute("class") || "")
        || link.closest?.('[aria-disabled="true"], [disabled]')) {
        result.disabled = true;
        continue;
      }
      const candidate = videoDownloadUrl(raw);
      // For an external native link, require a recognizable standalone video file.
      if (!candidate || (!handler && !candidate.format)) continue;
      result.link = candidate;
      result.disabled = false;
      break;
    }
    return result;
  }

  function videoDownloadDenied(info) {
    // Panopto's session REST API uses Urls.DownloadUrl === "#" when downloads
    // are disabled for the current user. Never reconstruct a URL from the ID.
    if (typeof info?.Urls?.DownloadUrl === "string" && info.Urls.DownloadUrl.trim() === "#") return true;
    const flags = new Set(["allowvideodownload", "candownloadvideo", "videodownloadenabled", "allowpodcastdownload", "podcastdownloadenabled"]);
    for (const value of [info, info?.Settings, info?.Delivery, info?.Delivery?.Settings]) {
      if (!value || typeof value !== "object") continue;
      for (const [key, flag] of Object.entries(value)) {
        if (flags.has(key.replace(/[^a-z]/gi, "").toLowerCase()) && [false, "false", 0, "0"].includes(flag)) return true;
      }
    }
    return false;
  }

  async function getVideoDownload(id) {
    try {
      if (!UUID.test(id)) throw error("BAD_ID", "讲座编号无效。");
      if (location.protocol !== "https:" || !/(^|\.)panopto\.(com|eu)$/i.test(location.hostname)) {
        throw error("BAD_ORIGIN", "当前页面不是支持的 Panopto 站点。");
      }
      const native = nativeVideoDownload(id);
      let info;
      let apiError;
      try {
        info = await request(`/Panopto/api/v1/sessions/${encodeURIComponent(id)}`, {
          method: "GET", headers: {"Accept": "application/json"}
        });
      } catch (cause) { apiError = cause; }
      if (videoDownloadDenied(info) || native.disabled) {
        throw error("DOWNLOAD_DISABLED", "这期讲座没有对当前账户开放视频下载。");
      }
      if (info?.Id && String(info.Id).toLowerCase() !== id.toLowerCase()) {
        throw error("INVALID_RESPONSE", "视频接口返回了另一讲座的信息。");
      }
      const download = videoDownloadUrl(info?.Urls?.DownloadUrl);
      if (download) {
        return {ok: true, kind: "video", ...download, title: typeof info.Name === "string" ? info.Name : "", method: "session-api"};
      }
      // API access and the viewer's download action are separate: a REST 401/403
      // can still fall back to an existing native download link on this viewer.
      if (native.link && apiError?.code !== "RATE_LIMIT") {
        return {ok: true, kind: "video", ...native.link, method: "native-video-link"};
      }
      if (apiError) {
        const messages = {
          AUTH_REQUIRED: "视频信息接口需要已登录的播放器页面。",
          ACCESS_DENIED: "视频信息接口拒绝当前请求；需从播放器的下载入口读取。",
          RATE_LIMIT: "Panopto 请求过于频繁，请稍后重试。",
          HTML_RESPONSE: "视频信息请求返回了登录网页。",
          EMPTY_RESPONSE: "视频信息接口返回了空白内容。",
          TIMEOUT: "视频信息请求超过 25 秒，请重试。",
          NETWORK_ERROR: "浏览器未能完成视频信息请求。",
          INVALID_RESPONSE: "视频信息接口返回了无法识别的内容。",
          SERVER_ERROR: "Panopto 未完成视频信息请求。",
          HTTP_ERROR: "视频信息接口暂时不可用。"
        };
        if (apiError.code === "ACCESS_DENIED") throw error("VIDEO_API_ACCESS_DENIED", messages.ACCESS_DENIED);
        if (!native.currentViewer && ["HTTP_ERROR", "INVALID_RESPONSE", "SERVER_ERROR"].includes(apiError.code)) {
          throw error("VIDEO_VIEWER_REQUIRED", "需要加载这期讲座的播放器，读取视频下载入口。");
        }
        throw error(apiError.code || "NETWORK_ERROR", messages[apiError.code] || "读取视频信息时出现了错误。");
      }
      if (!native.currentViewer) throw error("VIDEO_VIEWER_REQUIRED", "需要加载这期讲座的播放器，读取视频下载入口。");
      throw error("NO_VIDEO_DOWNLOAD", "这期讲座没有提供可下载的视频文件。");
    } catch (cause) {
      return {ok: false, code: typeof cause.code === "string" ? cause.code : "UNEXPECTED_ERROR", message: cause.code ? cause.message : "读取视频下载入口时出现了未预期错误。"};
    }
  }

  globalThis.PanoptoBatchClient = Object.freeze({version: VERSION, getTranscript, getVideoDownload});
})();
