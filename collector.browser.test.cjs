/* Optional browser DOM fixtures: requires Playwright plus Chromium. No requests leave this test. */
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(require.resolve("playwright", {
  paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]
}));

const BASE = "https://example.au.panopto.com/Panopto/Pages/EmbeddedList.aspx?folderID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const idFor = n => "10000000-0000-0000-0000-" + String(n).padStart(12, "0");
const link = (n, title = "Lecture " + n) => `<a href="/Panopto/Pages/Viewer.aspx?id=${idFor(n)}">${title}</a>`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  let passed = 0;

  async function scan(html, base = BASE) {
    await page.setContent(html);
    await page.addScriptTag({ path: path.join(__dirname, "collector.js") });
    return page.evaluate(baseUrl => PanoptoCollector.scanDocument(document, baseUrl), base);
  }

  try {
    let result = await scan(`<title>Course recordings</title>
      ${Array.from({ length: 11 }, (_, i) => `<article class="session-card">
        <a href="/Panopto/Pages/Embed.aspx?id=${idFor(i + 1)}"><span>2:00:00</span></a>
        <h3 class="session-title">MUS 125 — Lecture ${i + 1}</h3>${link(i + 1)}
      </article>`).join("")}
      <footer class="pagination">每页结果数：
        <select aria-label="每页结果数"><option>10</option><option selected>25</option><option>50</option></select>
        <span>1–11 of 11</span><button aria-label="上一页" disabled>‹</button>
        <button aria-current="page">1</button><button aria-label="下一页" disabled>›</button>
      </footer>`);
    assert.equal(result.sessions.length, 11, "embed and viewer duplicates must collapse");
    assert.equal(result.sessions[0].title, "MUS 125 — Lecture 1", "use the card title rather than a duration");
    assert.equal(result.folderId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert.equal(result.pagination.total, 11);
    assert.equal(result.pagination.pageSize, 25, "read the selected option, not all option text");
    assert.equal(result.pagination.complete, true);
    assert.equal(result.pagination.hasNext, false);
    assert.equal(result.pagination.controlConflict, false);
    passed += 1;

    result = await scan(`<div id="${idFor(90)}">${idFor(91)}</div>
      <div data-id="${idFor(92)}" class="folder">Folder</div>
      <a href="/Panopto/Pages/Sessions/List.aspx?folderID=${idFor(93)}">Folder</a>
      <a href="/unrelated?id=${idFor(94)}">Unrelated link</a>
      <article class="session-card" hidden>${link(95)}</article>
      <div style="display:none">${link(96)}</div>
      <script type="application/json">{"sessionId":"${idFor(97)}"}</script>
      ${link(1)}`);
    assert.deepEqual(result.sessions.map(item => item.id), [idFor(1)], "ignore arbitrary UUIDs, hidden content, folder IDs and JSON state");
    assert.equal(result.pagination.complete, false, "missing pagination is not proof of completeness");
    passed += 1;

    result = await scan(`<article class="session-card" data-session-id="${idFor(1)}"><h3>Valid data card</h3></article>
      <article data-kind="session" data-id="${idFor(2)}"><h3>Second lecture</h3></article>
      <article data-kind="folder" data-id="${idFor(3)}"><h3>Not a lecture</h3></article>
      <div class="pagination"><span>1–2 of 20</span><button aria-label="Next page">›</button></div>`);
    assert.deepEqual(result.sessions.map(item => item.id), [idFor(1), idFor(2)]);
    assert.equal(result.sessions[0].confidence, "medium");
    assert.equal(result.pagination.hasNext, true);
    assert.equal(result.pagination.complete, false);
    assert.equal(await page.evaluate(() => PanoptoCollector.findNextPageControl(document).getAttribute("aria-label")), "Next page");
    passed += 1;

    result = await scan(`<title>Canvas course</title><div data-session-id="${idFor(5)}">Canvas application state</div>
      <iframe src="${BASE}" title="Panopto Video"></iframe>`, "https://canvas.example.edu/courses/125/external_tools/7");
    assert.equal(result.sessions.length, 0, "do not interpret Canvas app session attributes as lectures");
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].sameOrigin, false);
    assert.equal(result.folderId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    passed += 1;

    result = await scan(`${link(1)}<div class="pagination"><span>1–11 of 11</span></div>`);
    assert.equal(result.pagination.countMatchesRange, false);
    assert.equal(result.pagination.complete, false, "unloaded lecture cards must not be silently skipped");
    assert.ok(result.warnings.some(value => value.includes("应有 11 条")));
    passed += 1;

    result = await scan(`${link(1)}<div class="pagination"><span>1–1 of 2</span><button aria-label="Next page" disabled>›</button></div>`);
    assert.equal(result.pagination.controlConflict, true);
    assert.equal(await page.evaluate(() => PanoptoCollector.findNextPageControl(document)), null);
    passed += 1;

    result = await scan(`${link(1)}<a rel="next" href="/Panopto/Pages/Viewer.aspx?id=${idFor(2)}">Next</a>`);
    assert.equal(await page.evaluate(() => PanoptoCollector.findNextPageControl(document)), null, "do not treat player next-video links as pagination");
    passed += 1;

    const parsed = await page.evaluate(() => ({
      bad: PanoptoCollector.parseSessionUrl("https://example.test/?id=10000000-0000-0000-0000-000000000001"),
      short: PanoptoCollector.parseSessionUrl("https://example.test/Panopto/Pages/Viewer.aspx?id=10000000"),
      script: PanoptoCollector.parseSessionUrl("javascript:alert(1)"),
      good: PanoptoCollector.parseSessionUrl("https://example.test/Panopto/Pages/Embed.aspx?ID=ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF&auth=do-not-copy#t=1"),
      folder: PanoptoCollector.parseFolderId("https://example.test/Panopto/Pages/Sessions/List.aspx#folderID=%22ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF%22")
    }));
    assert.equal(parsed.bad, null);
    assert.equal(parsed.short, null);
    assert.equal(parsed.script, null);
    assert.equal(parsed.good.url, "https://example.test/Panopto/Pages/Viewer.aspx?id=abcdefab-abcd-abcd-abcd-abcdefabcdef");
    assert.equal(parsed.folder, "abcdefab-abcd-abcd-abcd-abcdefabcdef");
    passed += 1;

    console.log(`collector: ${passed} browser DOM scenarios passed`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
