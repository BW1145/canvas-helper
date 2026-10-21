"use strict";

// Offline integration checks for the page-side client. Every request is mocked;
// these tests cannot reach a real school, Panopto session, or browser account.
const test = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "panopto-client.js"), "utf8");
const ORIGIN = "https://offline-example.panopto.com";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const INFO_PATH = "/Panopto/Pages/Viewer/DeliveryInfo.aspx";
const VIEWER_PATH = `/Panopto/Pages/Viewer.aspx?id=${SESSION_ID}`;
const NATIVE_PATH = `/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${SESSION_ID}&language=English_GBR`;
const SRT = "1\n00:00:01,000 --> 00:00:03,000\nExisting lecture caption.\n";

function info(tracks, extraDelivery = {}) {
  return {
    ErrorCode: 0,
    Delivery: {
      SessionName: "Offline lecture fixture",
      AvailableCaptions: tracks,
      ...extraDelivery
    }
  };
}

function anchor(href, label = "Download transcript", attributes = {}) {
  return {
    textContent: label,
    getAttribute(name) {
      return name === "href" ? href : (attributes[name] ?? null);
    }
  };
}

function createHarness({steps, links = [], currentPath, expireTimer = false}) {
  const calls = [];
  const mockErrors = [];
  const timers = new Set();
  const context = {
    URL,
    URLSearchParams,
    AbortController,
    DOMException,
    location: new URL(currentPath || "/Panopto/Pages/Sessions/List.aspx", ORIGIN),
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, "a[href]");
        return links;
      }
    },
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, expireTimer ? 0 : milliseconds);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
      clearTimeout(timer);
    },
    async fetch(value, options) {
      const url = new URL(value);
      const call = {
        url,
        options,
        fields: new URLSearchParams(options.body || "")
      };
      const index = calls.push(call) - 1;
      const step = steps[index];
      try {
        assert.ok(step, `Unexpected request ${index + 1}: ${url.pathname}`);
        assert.equal(url.origin, ORIGIN, "Requests must stay on the same Panopto origin");
        assert.equal(options.credentials, "include", "Use the current browser session");
        if (step.path) assert.equal(url.pathname, step.path);
        if (step.check) step.check(call);
      } catch (cause) {
        // The production client intentionally catches fetch failures. Preserve
        // assertion errors outside it so a bad mock request cannot pass a test.
        mockErrors.push(cause);
        throw cause;
      }
      if (step.abort) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener("abort", abort, {once: true});
        });
      }
      const status = step.status ?? 200;
      const contentType = step.contentType || (step.json !== undefined ? "application/json" : "text/plain");
      return {
        ok: status >= 200 && status < 300,
        status,
        url: step.finalUrl || url.href,
        headers: {get: name => name.toLowerCase() === "content-type" ? contentType : null},
        text: async () => step.json !== undefined ? JSON.stringify(step.json) : String(step.text ?? "")
      };
    }
  };
  vm.runInNewContext(source, context, {filename: "panopto-client.js"});
  return {
    calls,
    async run(method = "getTranscript") {
      let result;
      try {
        result = await context.PanoptoBatchClient[method](SESSION_ID);
      } finally {
        // Never leave a 25-second timer behind if a regression breaks cleanup.
        const uncleared = timers.size;
        for (const timer of timers) clearTimeout(timer);
        assert.equal(uncleared, 0, "Every request must clear its timeout");
      }
      assert.equal(mockErrors.length, 0, mockErrors.map(error => error.message).join("\n"));
      assert.equal(calls.length, steps.length, "The expected requests must all run, with no extra probes");
      // VM objects have a different prototype; normalize only for assertions.
      return JSON.parse(JSON.stringify(result));
    }
  };
}

function expectFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length);
  for (const field of ["raw", "text", "cues", "kind"]) {
    assert.equal(Object.hasOwn(result, field), false, `Failure must not expose a successful ${field} payload`);
  }
}

for (const language of ["English_GBR", 17]) {
  test(`uses the session's returned caption language (${language}) and preserves caption data`, async () => {
    const harness = createHarness({steps: [
      {
        path: INFO_PATH,
        check({options, fields}) {
          assert.equal(options.method, "POST");
          assert.match(options.headers["Content-Type"], /^application\/x-www-form-urlencoded/);
          assert.equal(fields.get("deliveryId"), SESSION_ID);
          assert.equal(fields.get("responseType"), "json");
          assert.equal(fields.has("getCaptions"), false);
        },
        json: info([
          {Language: "French_FRA", DisplayName: "Other track"},
          {Language: language, DisplayName: "Course language", IsDefault: true}
        ])
      },
      {
        path: INFO_PATH,
        check({fields}) {
          assert.equal(fields.get("deliveryId"), SESSION_ID);
          assert.equal(fields.get("getCaptions"), "true");
          assert.equal(fields.get("language"), String(language));
        },
        json: [
          {Caption: "[Music]", Time: 0, CaptionDuration: 1.25},
          {Caption: "Repeat this. Repeat this.", Time: "1.25", CaptionDuration: "2.5"},
          {Caption: "   ", Time: 4, CaptionDuration: 1},
          {Time: 5, CaptionDuration: 1}
        ]
      }
    ]});
    const result = await harness.run();
    assert.equal(result.ok, true);
    assert.equal(result.kind, "cues");
    assert.equal(result.language, "Course language");
    assert.equal(result.title, "Offline lecture fixture");
    assert.deepEqual(result.cues, [
      {text: "[Music]", start: 0, duration: 1.25},
      {text: "Repeat this. Repeat this.", start: 1.25, duration: 2.5}
    ]);
  });
}

test("metadata 403 stops without trying a native link", async () => {
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(NATIVE_PATH)],
    steps: [{path: INFO_PATH, status: 403, text: "Access denied"}]
  });
  expectFailure(await harness.run(), "ACCESS_DENIED");
});

test("caption 403 stops before another track or the SRT handler", async () => {
  const harness = createHarness({steps: [
    {path: INFO_PATH, json: info([{Language: "English_GBR"}, {Language: "French_FRA"}])},
    {path: INFO_PATH, status: 403, text: "Access denied"}
  ]});
  expectFailure(await harness.run(), "ACCESS_DENIED");
});

test("an explicit disabled-download flag stops even with a native link and captions", async () => {
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(NATIVE_PATH)],
    steps: [{path: INFO_PATH, json: info(
      [{Language: "English_GBR"}],
      {Settings: {AllowTranscriptDownload: false}}
    )}]
  });
  expectFailure(await harness.run(), "DOWNLOAD_DISABLED");
});

test("HTTP 200 with a blank body is not a successful transcript or a no-captions result", async () => {
  const harness = createHarness({steps: [{path: INFO_PATH, text: "\uFEFF \r\n\t"}]});
  expectFailure(await harness.run(), "EMPTY_RESPONSE");
});

for (const contentType of ["text/html; charset=utf-8", "text/plain"]) {
  test(`rejects a login HTML document served as ${contentType}`, async () => {
    const harness = createHarness({steps: [{
      path: INFO_PATH,
      contentType,
      text: '<!doctype html><html><body><form action="/login">Sign in</form></body></html>'
    }]});
    expectFailure(await harness.run(), "HTML_RESPONSE");
  });
}

test("an empty AvailableCaptions list reports no captions without guessing language IDs", async () => {
  const harness = createHarness({steps: [{path: INFO_PATH, json: info([])}]});
  expectFailure(await harness.run(), "NO_CAPTIONS");
});

test("an existing native download link still succeeds when metadata is empty", async () => {
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(NATIVE_PATH)],
    steps: [
      {path: INFO_PATH, text: ""},
      {
        path: "/Panopto/Pages/Transcription/GenerateSRT.ashx",
        check({url}) {
          assert.equal(url.searchParams.get("id"), SESSION_ID);
          assert.equal(url.searchParams.get("language"), "English_GBR");
        },
        text: SRT
      }
    ]
  });
  const result = await harness.run();
  assert.equal(result.ok, true);
  assert.equal(result.kind, "srt");
  assert.equal(result.method, "native-link");
  assert.equal(result.raw, SRT);
});

test("a native TXT transcript beginning with [Music] remains valid text", async () => {
  const transcript = "[Music]\nWelcome to the lecture.\n";
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(NATIVE_PATH)],
    steps: [
      {path: INFO_PATH, json: info([{Language: "English_GBR"}])},
      {path: "/Panopto/Pages/Transcription/GenerateSRT.ashx", text: transcript}
    ]
  });
  const result = await harness.run();
  assert.equal(result.ok, true);
  assert.equal(result.kind, "text");
  assert.equal(result.method, "native-link");
  assert.equal(result.text, transcript);
});

test("native-link fallback does not save HTML as a transcript", async () => {
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(NATIVE_PATH)],
    steps: [
      {path: INFO_PATH, text: ""},
      {
        path: "/Panopto/Pages/Transcription/GenerateSRT.ashx",
        contentType: "text/html",
        text: '<form action="/login">Sign in to continue.</form>'
      }
    ]
  });
  expectFailure(await harness.run(), "HTML_RESPONSE");
});

test("a real DOMException AbortError is mapped to TIMEOUT, not its legacy numeric code 20", async () => {
  assert.equal(new DOMException("Timed out", "AbortError").code, 20);
  const harness = createHarness({
    expireTimer: true,
    steps: [{path: INFO_PATH, abort: true}]
  });
  expectFailure(await harness.run(), "TIMEOUT");
});

const VIDEO_API_PATH = `/Panopto/api/v1/sessions/${SESSION_ID}`;
const VIDEO_PATH = `/Panopto/Podcast/Download/${SESSION_ID}.mp4?mediaTargetType=videoPodcast`;
const videoInfo = (downloadUrl, extra = {}) => ({Id: SESSION_ID, Name: "Video fixture", Urls: {DownloadUrl: downloadUrl}, ...extra});

test("video uses the official session URL exactly, retains signed query values, and never fetches video bytes", async () => {
  const downloadUrl = "https://media.example.test/courses/lecture.mp4?signature=a%2Bb%2Fc&expires=12345&token=x%3Dy";
  const harness = createHarness({steps: [{
    path: VIDEO_API_PATH,
    check({options, fields}) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(fields.size, 0);
    },
    json: videoInfo(downloadUrl)
  }]});
  assert.deepEqual(await harness.run("getVideoDownload"), {
    ok: true, kind: "video", url: downloadUrl, format: "mp4", title: "Video fixture", method: "session-api"
  });
});

test("the video client can resolve a fresh URL a second time in the same page", async () => {
  const steps = [{path: VIDEO_API_PATH, json: videoInfo(`${ORIGIN}${VIDEO_PATH}&token=first`)}];
  const harness = createHarness({steps});
  assert.match((await harness.run("getVideoDownload")).url, /token=first$/);
  steps.push({path: VIDEO_API_PATH, json: videoInfo(`${ORIGIN}${VIDEO_PATH}&token=second`)});
  assert.match((await harness.run("getVideoDownload")).url, /token=second$/);
});

test("an explicit disabled video download overrides an existing native link", async () => {
  for (const data of [videoInfo("#"), videoInfo(VIDEO_PATH, {Settings: {VideoDownloadEnabled: false}})]) {
    const harness = createHarness({
      currentPath: VIEWER_PATH,
      links: [anchor(VIDEO_PATH, "Download podcast")],
      steps: [{path: VIDEO_API_PATH, json: data}]
    });
    expectFailure(await harness.run("getVideoDownload"), "DOWNLOAD_DISABLED");
  }
});

test("a disabled native video control is respected", async () => {
  const harness = createHarness({
    currentPath: VIEWER_PATH,
    links: [anchor(VIDEO_PATH, "Download video", {"aria-disabled": "true"})],
    steps: [{path: VIDEO_API_PATH, json: videoInfo(VIDEO_PATH)}]
  });
  expectFailure(await harness.run("getVideoDownload"), "DOWNLOAD_DISABLED");
});

for (const httpStatus of [401, 403]) {
  test(`video REST ${httpStatus} can use the current viewer's existing native download link`, async () => {
    const harness = createHarness({
      currentPath: VIEWER_PATH,
      links: [anchor(NATIVE_PATH), anchor(VIDEO_PATH, "Download podcast")],
      steps: [{path: VIDEO_API_PATH, status: httpStatus, text: "API unavailable"}]
    });
    assert.deepEqual(await harness.run("getVideoDownload"), {
      ok: true, kind: "video", url: `${ORIGIN}${VIDEO_PATH}`, format: "mp4", method: "native-video-link"
    });
  });
}

test("video API authentication and access errors stay distinct from disabled video downloads", async () => {
  for (const [httpStatus, code] of [[401, "AUTH_REQUIRED"], [403, "VIDEO_API_ACCESS_DENIED"]]) {
    const harness = createHarness({steps: [{path: VIDEO_API_PATH, status: httpStatus, text: "API unavailable"}]});
    expectFailure(await harness.run("getVideoDownload"), code);
  }
});

test("a missing API video URL requests the target viewer once, then reports no download if no native link exists", async () => {
  for (const [currentPath, code] of [["/Panopto/Pages/Sessions/List.aspx", "VIDEO_VIEWER_REQUIRED"], [VIEWER_PATH, "NO_VIDEO_DOWNLOAD"]]) {
    const harness = createHarness({currentPath, steps: [{path: VIDEO_API_PATH, json: videoInfo(null)}]});
    expectFailure(await harness.run("getVideoDownload"), code);
  }
});

test("video fallback ignores another lecture's viewer, caption links, audio, and streaming manifests", async () => {
  const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const mixedLinks = [
    anchor(NATIVE_PATH),
    anchor(`/Panopto/Podcast/Download/${SESSION_ID}.mp3`, "Download audio podcast"),
    anchor("https://media.example.test/play.m3u8", "Download video"),
    anchor(`${ORIGIN}${VIDEO_PATH}&id=${otherId}`, "Download video")
  ];
  const harness = createHarness({currentPath: VIEWER_PATH, links: mixedLinks, steps: [{path: VIDEO_API_PATH, json: videoInfo(null)}]});
  expectFailure(await harness.run("getVideoDownload"), "NO_VIDEO_DOWNLOAD");
  const wrongViewer = createHarness({
    currentPath: `/Panopto/Pages/Viewer.aspx?id=${otherId}`,
    links: [anchor(VIDEO_PATH, "Download video")],
    steps: [{path: VIDEO_API_PATH, json: videoInfo(null)}]
  });
  expectFailure(await wrongViewer.run("getVideoDownload"), "VIDEO_VIEWER_REQUIRED");
});

test("video rejects unsafe, non-video, and playback URLs from metadata without guessing an alternative", async () => {
  for (const value of ["javascript:alert(1)", "http://media.example.test/video.mp4", "https://user:pass@media.example.test/video.mp4", "/", VIEWER_PATH, "https://media.example.test/play.m3u8", "https://media.example.test/captions.srt"]) {
    const harness = createHarness({currentPath: VIEWER_PATH, steps: [{path: VIDEO_API_PATH, json: videoInfo(value)}]});
    expectFailure(await harness.run("getVideoDownload"), "NO_VIDEO_DOWNLOAD");
  }
});

test("video rejects a different session returned by the metadata API", async () => {
  const harness = createHarness({steps: [{path: VIDEO_API_PATH, json: videoInfo(VIDEO_PATH, {Id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"})}]});
  expectFailure(await harness.run("getVideoDownload"), "INVALID_RESPONSE");
});

test("video metadata login HTML and empty responses retain useful retry reasons", async () => {
  for (const [text, code] of [["<html><body>Log in</body></html>", "HTML_RESPONSE"], ["", "EMPTY_RESPONSE"]]) {
    const harness = createHarness({steps: [{path: VIDEO_API_PATH, text}]});
    expectFailure(await harness.run("getVideoDownload"), code);
  }
});
