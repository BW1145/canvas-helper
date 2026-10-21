/*
 * Read-only DOM discovery for the Panopto transcript extension.
 * This classic script intentionally uses neither network requests nor storage.
 * A document scan describes the loaded DOM, not an entire server-side folder.
 */
(function installPanoptoCollector(global) {
  "use strict";

  const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const UUID_RE = new RegExp("^" + UUID_PATTERN + "$", "i");
  const VIEWER_PATH_RE = /\/Panopto\/Pages\/(Viewer|Embed)\.aspx\/?$/i;
  const PANOPTO_PATH_RE = /\/Panopto(?:\/|$)/i;
  const CARD_SELECTOR = [
    "[data-session-id]", "[data-sessionid]", "[data-delivery-id]", "[data-deliveryid]",
    '[data-type="session"]', '[data-kind="session"]',
    '[class~="session"]', '[class*="session-card" i]', '[class*="session-tile" i]',
    '[class*="session-list-item" i]', '[class*="sessionlistitem" i]',
    '[class*="video-card" i]', '[class*="video-tile" i]', '[class*="video-item" i]',
    '[role="listitem"]', "article", "li", "tr"
  ].join(",");
  const TITLE_SELECTOR = [
    "[data-session-title]", "[data-session-name]", "[data-delivery-name]",
    '[class*="session-title" i]', '[class*="session-name" i]',
    '[class*="video-title" i]', '[class*="delivery-name" i]',
    '[data-testid*="session-title" i]'
  ].join(",");
  const PAGINATION_SELECTOR = [
    '[class*="paginat" i]', '[id*="paginat" i]', '[class*="paging" i]',
    '[id*="paging" i]', '[class*="pager" i]', '[id*="pager" i]',
    '[class*="page-info" i]', '[class*="page-count" i]', '[class*="result-count" i]',
    '[class*="results-count" i]', '[id*="resultCount" i]',
    '[aria-label*="pagination" i]', '[aria-label*="分页"]',
    '[role="navigation"]', '[role="status"]', "footer"
  ].join(",");
  const NEXT_RE = /^(?:next(?:\s+page)?|下一页|下页|后一页|次へ|次のページ|›|»|❯|→)$/i;
  const PREVIOUS_RE = /^(?:prev(?:ious)?(?:\s+page)?|上一页|上页|前一页|前へ|前のページ|‹|«|❮|←)$/i;
  const GENERIC_TITLE_RE = /^(?:panopto(?:\s+video)?|video|session|lecture|thumbnail|play(?:\s+(?:video|session))?|watch(?:\s+(?:video|session))?|view(?:\s+(?:video|session))?|open(?:\s+(?:video|session))?|details|more|播放|观看|查看|详情|更多|缩略图|视频|讲座|新窗口打开)$/i;

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try { return Array.from(root.querySelectorAll(selector)); } catch (_) { return []; }
  }

  function text(value, limit) {
    return String(value || "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim().slice(0, limit || 600);
  }

  function attr(element, name) {
    return element && typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  }

  function urlOf(value, baseUrl) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const parsed = new URL(value, baseUrl);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
    } catch (_) { return null; }
  }

  function normalizeId(value) {
    if (typeof value !== "string") return null;
    let candidate = value.trim();
    // Panopto folder fragments sometimes wrap the folder ID in quotes.
    for (let i = 0; i < 2; i += 1) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch (_) { break; }
    }
    candidate = candidate.replace(/^["'{]|["'}]$/g, "");
    return UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
  }

  function parameter(params, names) {
    if (!params) return null;
    for (const [name, value] of params.entries()) {
      if (names.includes(name.toLowerCase())) return value;
    }
    return null;
  }

  function parseSessionUrl(value, baseUrl) {
    const parsed = urlOf(value, baseUrl);
    if (!parsed || !VIEWER_PATH_RE.test(parsed.pathname)) return null;
    const id = normalizeId(parameter(parsed.searchParams, ["id"]));
    if (!id) return null;
    const viewer = new URL(parsed.href);
    viewer.pathname = viewer.pathname.replace(/(?:Viewer|Embed)\.aspx\/?$/i, "Viewer.aspx");
    viewer.search = "";
    viewer.hash = "";
    viewer.searchParams.set("id", id);
    return { id, url: viewer.href, launchUrl: parsed.href, origin: viewer.origin, kind: /\/Embed\.aspx\/?$/i.test(parsed.pathname) ? "embed" : "viewer" };
  }

  function parseFolderId(value, baseUrl) {
    const parsed = urlOf(value, baseUrl);
    if (!parsed || !PANOPTO_PATH_RE.test(parsed.pathname)) return null;
    const queryId = normalizeId(parameter(parsed.searchParams, ["folderid"]));
    if (queryId) return queryId;
    const fragment = parsed.hash.replace(/^#\??/, "");
    try { return normalizeId(parameter(new URLSearchParams(fragment), ["folderid"])); } catch (_) { return null; }
  }

  function elementIsVisible(element) {
    if (!element) return false;
    const win = element.ownerDocument && element.ownerDocument.defaultView;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || attr(node, "aria-hidden") === "true") return false;
      if (win && typeof win.getComputedStyle === "function") {
        const style = win.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      } else if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(attr(node, "style") || "")) {
        return false;
      }
    }
    return true;
  }

  function meaningfulTitle(value) {
    let candidate = text(value, 350);
    candidate = candidate.replace(/^(?:play|watch|view|open)\s*[:：]\s*/i, "").replace(/^(?:播放|观看|查看)\s*[:：]\s*/, "");
    if (!candidate || GENERIC_TITLE_RE.test(candidate) || /^\d{1,3}:\d{2}(?::\d{2})?$/.test(candidate) || UUID_RE.test(candidate)) return null;
    return candidate;
  }

  function closestCard(element) {
    if (!element || typeof element.closest !== "function") return element;
    return element.closest(CARD_SELECTOR) || element;
  }

  function findTitle(element, doc, isCurrentPage, baseUrl) {
    const candidates = [];
    const add = (value, score) => {
      const title = meaningfulTitle(value);
      if (title) candidates.push({ title, score });
    };
    const card = closestCard(element);
    for (const node of Array.from(new Set([element, card]))) {
      if (!node) continue;
      add(attr(node, "data-session-title"), 120);
      add(attr(node, "data-session-name"), 120);
      add(attr(node, "data-delivery-name"), 120);
    }
    for (const node of queryAll(card, TITLE_SELECTOR).slice(0, 5)) {
      add(attr(node, "title"), 112);
      add(attr(node, "data-session-title"), 112);
      add(attr(node, "data-session-name"), 112);
      add(node.textContent, 110);
    }
    if (element) {
      add(attr(element, "title"), 100);
      if (element.tagName === "A") add(element.textContent, 98);
      add(attr(element, "aria-label"), 75);
    }
    for (const node of queryAll(card, 'h1,h2,h3,h4,h5,[role="heading"],[class~="title"],.detail-title').slice(0, 5)) {
      add(node.textContent, 95);
    }
    for (const node of queryAll(card, 'a[href]').slice(0, 10)) {
      // Only another link to the same lecture should supply its title.
      const cardSession = parseSessionUrl(attr(element, "href") || "", baseUrl);
      const siblingSession = parseSessionUrl(attr(node, "href") || "", baseUrl);
      if (siblingSession && (!cardSession || siblingSession.id === cardSession.id)) {
        add(attr(node, "title"), 90);
        add(node.textContent, 88);
      }
    }
    for (const node of queryAll(element, "img[alt]").slice(0, 3)) add(attr(node, "alt"), 55);
    if (isCurrentPage) {
      for (const node of queryAll(doc, '.session-title,.session-name,[data-session-title],h1').slice(0, 3)) add(node.textContent, 90);
      add(doc.title, 50);
    }
    candidates.sort((a, b) => b.score - a.score || b.title.length - a.title.length);
    return candidates[0] || { title: "", score: 0 };
  }

  function isDisabled(element) {
    for (let node = element, level = 0; node && level < 3; node = node.parentElement, level += 1) {
      if (node.disabled || attr(node, "disabled") !== null || attr(node, "aria-disabled") === "true") return true;
      if (/(?:^|\s)(?:disabled|is-disabled|ui-state-disabled)(?:\s|$)/i.test(attr(node, "class") || "")) return true;
    }
    return false;
  }

  function paginationRoots(doc) {
    return queryAll(doc, PAGINATION_SELECTOR).filter(elementIsVisible);
  }

  function controlDirection(element, inPagination) {
    const rel = (attr(element, "rel") || "").toLowerCase().split(/\s+/);
    if (inPagination && rel.includes("next")) return "next";
    if (inPagination && (rel.includes("prev") || rel.includes("previous"))) return "previous";
    const values = [attr(element, "aria-label"), attr(element, "title"), text(element.textContent, 120)].filter(Boolean).map(value => text(value, 120));
    const nextMatches = values.some(value => NEXT_RE.test(value));
    const previousMatches = values.some(value => PREVIOUS_RE.test(value));
    // A generic "Next" outside pagination may be a player control.
    if (inPagination) {
      if (nextMatches && !previousMatches) return "next";
      if (previousMatches && !nextMatches) return "previous";
    } else {
      if (values.some(value => /^(?:next\s+page|下一页|下页|后一页)$/i.test(value))) return "next";
      if (values.some(value => /^(?:prev(?:ious)?\s+page|上一页|上页|前一页)$/i.test(value))) return "previous";
    }
    if (inPagination) {
      const identity = [attr(element, "id"), attr(element, "class"), attr(element, "data-testid")].filter(Boolean).join(" ");
      if (/(?:^|[\s_-])(?:page[\s_-]?)?next(?:[\s_-]|$)|nextPage|next-page|pageNext/i.test(identity)) return "next";
      if (/(?:^|[\s_-])(?:page[\s_-]?)?prev(?:ious)?(?:[\s_-]|$)|previousPage|prevPage|previous-page|pagePrev/i.test(identity)) return "previous";
    }
    return null;
  }

  function paginationControls(doc, roots) {
    const results = { next: [], previous: [] };
    const candidates = queryAll(doc, 'a[href],button,[role="button"],[role="link"],[tabindex][aria-label],[tabindex][title],input[type="button"]');
    for (const element of candidates) {
      if (!elementIsVisible(element)) continue;
      const inPagination = roots.some(root => root === element || root.contains(element));
      const direction = controlDirection(element, inPagination);
      if (direction) results[direction].push(element);
    }
    return results;
  }

  function describeControl(element, baseUrl) {
    if (!element) return null;
    const rawHref = attr(element, "href");
    const parsed = urlOf(rawHref, baseUrl);
    return {
      tag: String(element.tagName || "").toLowerCase(),
      id: attr(element, "id") || null,
      label: text(attr(element, "aria-label") || attr(element, "title") || element.textContent, 120),
      href: parsed ? parsed.href : null,
      disabled: isDisabled(element)
    };
  }

  function parseRange(value) {
    const source = text(value, 1200);
    let match = source.match(/(?:^|[^\d])([\d,]+)\s*[\-–—−]\s*([\d,]+)\s*(?:of|out\s+of|\/|共(?:有)?)\s*([\d,]+)(?:\s*(?:条|项|个))?/i);
    if (!match) match = source.match(/(?:显示\s*)?(?:第\s*)?([\d,]+)\s*(?:至|到)\s*([\d,]+)\s*(?:条|项|个)?\s*[,，/]?\s*共\s*([\d,]+)/);
    if (!match) return null;
    const values = match.slice(1, 4).map(part => Number(part.replace(/,/g, "")));
    const [rangeStart, rangeEnd, total] = values;
    if (!values.every(Number.isSafeInteger) || rangeStart < 0 || rangeEnd < rangeStart || total < rangeEnd || (rangeStart === 0 && total !== 0)) return null;
    return { rangeStart, rangeEnd, total, rangeText: match[0].trim() };
  }

  function readPageSize(roots) {
    for (const root of roots) {
      const rootText = text(root.textContent, 1200);
      for (const control of queryAll(root, 'select,[role="combobox"],input[type="number"]')) {
        const label = text([attr(control, "aria-label"), attr(control, "title"), attr(control, "name"), attr(control, "id")].filter(Boolean).join(" "), 200);
        const hasPageSizeLabel = /(?:per[\s_-]*page|page[\s_-]*size|每页)/i.test(label) || /(?:per\s+page|每页)/i.test(rootText);
        if (!hasPageSizeLabel) continue;
        const rawValue = "value" in control ? control.value : attr(control, "aria-valuenow") || control.textContent;
        if (!/^\d{1,4}$/.test(text(rawValue, 20))) continue;
        const value = Number(rawValue);
        if (value > 0 && value <= 1000) return value;
      }
      const match = rootText.match(/(?:results?|items?|rows?|videos?|sessions?)\s+per\s+page\s*[:：]?\s*(\d{1,4})|每页(?:结果数|结果|条数|数量|显示)?\s*[:：]?\s*(\d{1,4})/i);
      if (match) {
        const value = Number(match[1] || match[2]);
        if (value > 0 && value <= 1000) return value;
      }
    }
    return null;
  }

  function readPagination(doc, baseUrl, sessions) {
    const roots = paginationRoots(doc);
    const controls = paginationControls(doc, roots);
    const nextElement = controls.next.find(element => !isDisabled(element)) || controls.next[0] || null;
    const previousElement = controls.previous.find(element => !isDisabled(element)) || controls.previous[0] || null;
    const ranges = roots.map(root => parseRange(root.textContent)).filter(Boolean);
    const distinctRanges = Array.from(new Map(ranges.map(range => [[range.rangeStart, range.rangeEnd, range.total].join(":"), range])).values());
    const range = distinctRanges.length === 1 ? distinctRanges[0] : null;
    const pageSize = readPageSize(roots);
    let currentPage = null;
    for (const root of roots) {
      for (const element of queryAll(root, '[aria-current="page"],[class~="active"],[class~="current"],[class~="selected"]')) {
        const value = text(element.textContent, 30);
        if (/^\d{1,5}$/.test(value) && Number(value) > 0) { currentPage = Number(value); break; }
      }
      if (currentPage !== null) break;
    }
    if (currentPage === null && range && pageSize && range.rangeStart > 0) currentPage = Math.floor((range.rangeStart - 1) / pageSize) + 1;
    const rangeHasNext = range ? range.rangeEnd < range.total : null;
    const rangeHasPrevious = range ? range.rangeStart > 1 : null;
    const next = describeControl(nextElement, baseUrl);
    const previous = describeControl(previousElement, baseUrl);
    const hasNext = rangeHasNext !== null ? rangeHasNext : next ? !next.disabled : null;
    const hasPrevious = rangeHasPrevious !== null ? rangeHasPrevious : previous ? !previous.disabled : null;
    const expectedOnPage = range ? (range.total === 0 ? 0 : range.rangeEnd - range.rangeStart + 1) : null;
    const countMatchesRange = expectedOnPage !== null ? sessions.length === expectedOnPage : null;
    const allOnCurrentPage = range ? (range.total === 0 || range.rangeStart === 1 && range.rangeEnd === range.total) : null;
    return {
      rangeStart: range ? range.rangeStart : null,
      rangeEnd: range ? range.rangeEnd : null,
      total: range ? range.total : null,
      pageSize,
      currentPage,
      hasNext,
      hasPrevious,
      next,
      previous,
      rangeText: range ? range.rangeText : null,
      loadedSessionCount: sessions.length,
      expectedOnPage,
      countMatchesRange,
      allOnCurrentPage,
      // Only an explicit full range with the same distinct session count confirms completeness.
      complete: allOnCurrentPage === true && countMatchesRange === true,
      confidence: distinctRanges.length > 1 ? "conflicting" : range ? "high" : next || previous || pageSize ? "medium" : "none",
      scope: "current-document-loaded-dom",
      controlConflict: Boolean(range && (next && rangeHasNext === next.disabled || previous && rangeHasPrevious === previous.disabled))
    };
  }

  function safeDocumentHref(doc) {
    try { return doc && doc.location && doc.location.href || global.location && global.location.href || ""; } catch (_) { return ""; }
  }

  function scanDocument(doc, baseUrl) {
    doc = doc || global.document;
    baseUrl = baseUrl || safeDocumentHref(doc);
    const pageUrl = urlOf(baseUrl, baseUrl);
    const href = pageUrl ? pageUrl.href : String(baseUrl || "");
    const origin = pageUrl ? pageUrl.origin : null;
    const warnings = [];
    const sessionsById = new Map();
    const folderIds = new Set();
    const frames = [];
    const inPanopto = Boolean(pageUrl && PANOPTO_PATH_RE.test(pageUrl.pathname));
    const currentFolder = parseFolderId(href, href);
    if (currentFolder) folderIds.add(currentFolder);

    function addSession(parsed, element, source, confidence, isCurrentPage) {
      if (!parsed) return;
      const found = findTitle(element, doc, isCurrentPage, href);
      const key = parsed.origin + ":" + parsed.id;
      const existing = sessionsById.get(key);
      if (existing) {
        if (found.score > existing.titleScore) { existing.title = found.title; existing.titleScore = found.score; }
        if (confidence === "high") existing.confidence = "high";
        if (!existing.sources.includes(source)) existing.sources.push(source);
        return;
      }
      sessionsById.set(key, {
        id: parsed.id,
        url: parsed.url,
        launchUrl: parsed.launchUrl || parsed.url,
        title: found.title,
        titleScore: found.score,
        confidence,
        sources: [source]
      });
    }

    for (const anchor of queryAll(doc, "a[href]")) {
      if (!elementIsVisible(anchor)) continue;
      const parsed = parseSessionUrl(attr(anchor, "href"), href);
      if (parsed) addSession(parsed, anchor, parsed.kind + "-link", "high", false);
    }

    for (const iframe of queryAll(doc, "iframe[src]")) {
      const frameUrl = urlOf(attr(iframe, "src"), href);
      if (!frameUrl || !PANOPTO_PATH_RE.test(frameUrl.pathname)) continue;
      const frameFolder = parseFolderId(frameUrl.href, href);
      const frameSession = parseSessionUrl(frameUrl.href, href);
      if (frameFolder) folderIds.add(frameFolder);
      frames.push({
        url: frameUrl.href,
        origin: frameUrl.origin,
        pathname: frameUrl.pathname,
        folderId: frameFolder,
        sessionId: frameSession ? frameSession.id : null,
        sameOrigin: frameUrl.origin === origin
      });
      if (frameSession && elementIsVisible(iframe)) addSession(frameSession, iframe, "iframe-" + frameSession.kind, "high", false);
    }

    // Data attributes are considered only inside an actual Panopto document.
    // UUIDs in arbitrary text, element IDs, folder rows, or app session state are ignored.
    if (inPanopto) {
      const dataSelector = [
        "[data-session-id]", "[data-sessionid]", "[data-delivery-id]", "[data-deliveryid]",
        '[data-type="session"][data-id]', '[data-kind="session"][data-id]',
        '[class~="session"][data-id]', '[class*="session-card" i][data-id]',
        '[class*="session-tile" i][data-id]'
      ].join(",");
      for (const element of queryAll(doc, dataSelector)) {
        if (!elementIsVisible(element)) continue;
        const id = ["data-session-id", "data-sessionid", "data-delivery-id", "data-deliveryid", "data-id"].map(name => normalizeId(attr(element, name))).find(Boolean);
        if (!id) continue;
        const viewer = new URL("/Panopto/Pages/Viewer.aspx", origin);
        viewer.searchParams.set("id", id);
        addSession({ id, url: viewer.href, origin }, element, "session-data-attribute", "medium", false);
      }
      const pageSession = parseSessionUrl(href, href);
      if (pageSession) addSession(pageSession, null, "current-" + pageSession.kind, "high", true);
      // Only explicitly named folder attributes are inspected; links to other folders are not treated as the current folder.
      const markedFolders = queryAll(doc, '[data-folder-id][aria-current="page"],[data-folderid][aria-current="page"],body[data-folder-id],body[data-folderid],[data-current-folder-id]');
      for (const element of markedFolders) {
        const id = ["data-current-folder-id", "data-folder-id", "data-folderid"].map(name => normalizeId(attr(element, name))).find(Boolean);
        if (id) folderIds.add(id);
      }
    }

    const sessions = Array.from(sessionsById.values()).map(session => {
      const { titleScore, ...result } = session;
      result.title = result.title || "未识别标题的讲座 " + result.id.slice(0, 8);
      result.titleConfidence = titleScore >= 85 ? "high" : titleScore ? "medium" : "missing";
      return result;
    });
    const pagination = readPagination(doc, href, sessions);
    if (!sessions.length) warnings.push(frames.length ? "讲座列表位于 Panopto 嵌入框架中；还需要扫描该框架。" : "当前文档未识别到讲座链接或明确的讲座数据属性。");
    if (pagination.confidence === "conflicting") warnings.push("检测到不一致的分页范围，无法确认课程总数。");
    if (pagination.expectedOnPage !== null && pagination.countMatchesRange === false) warnings.push("页面显示本页应有 " + pagination.expectedOnPage + " 条，但只识别到 " + sessions.length + " 条独立讲座；请等待列表加载或检查页面结构。");
    if (pagination.hasNext === true) warnings.push("当前文件夹还有下一页；本次扫描只包含当前文档中已加载的讲座。");
    if (pagination.total === null && sessions.length) warnings.push("未找到可确认的总数；目前仅识别了当前文档中已加载的讲座。");
    if (pagination.controlConflict) warnings.push("分页范围与翻页按钮状态不一致；请等待页面加载完成后重新扫描。");
    if (folderIds.size > 1) warnings.push("当前文档出现多个文件夹标识，未自动选择其中一个。");
    if (sessions.some(session => session.titleConfidence === "missing")) warnings.push("部分讲座标题未能从卡片中读取，暂以讲座编号命名。");
    return {
      origin,
      href,
      title: text(doc && doc.title, 350),
      folderId: folderIds.size === 1 ? Array.from(folderIds)[0] : null,
      sessions,
      pagination,
      frames,
      warnings
    };
  }

  function findNextPageControl(doc) {
    doc = doc || global.document;
    const controls = paginationControls(doc, paginationRoots(doc)).next.filter(element => !isDisabled(element));
    // Ambiguous controls require the caller to inspect rather than click an arbitrary one.
    if (controls.length === 1) return controls[0];
    if (controls.length > 1) {
      const descriptions = controls.map(element => [attr(element, "href") || "", attr(element, "aria-label") || attr(element, "title") || text(element.textContent, 120)].join("|"));
      if (new Set(descriptions).size === 1) return controls[0];
    }
    return null;
  }

  global.PanoptoCollector = Object.freeze({
    version: "1.0.0",
    scanDocument,
    parseSessionUrl,
    parseFolderId,
    findNextPageControl
  });
})(globalThis);
