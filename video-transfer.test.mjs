import assert from "node:assert/strict";
import {test} from "node:test";
import {fetchVideoStream} from "./video-transfer.js";

const source = "https://school.hosted.panopto.com/Panopto/Podcast/Download/lecture.mp4?token=private";
const ownOrigin = "chrome-extension://testextension";
const cdn = "https://media.example-cdn.test/lecture.mp4?signature=private";

async function fixture(run, {granted = true, observer = true} = {}) {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const listeners = new Set();
  const checks = [];
  const api = {
    runtime: {getURL: () => `${ownOrigin}/`},
    tabs: {getCurrent: async () => ({id: 31})},
    permissions: {contains: async (permission) => {
      checks.push(permission);
      return typeof granted === "function" ? granted(permission) : granted;
    }}
  };
  if (observer) api.webRequest = {onBeforeRedirect: {
    addListener: (listener, filter) => {
      assert.deepEqual(filter, {urls: ["https://*/*"], types: ["xmlhttprequest"]});
      listeners.add(listener);
    },
    removeListener: (listener) => listeners.delete(listener)
  }};
  globalThis.chrome = api;
  const emit = (details = {}) => {
    for (const listener of listeners) listener({initiator: ownOrigin, tabId: 31, type: "xmlhttprequest", url: source, requestId: "request-1", redirectUrl: cdn, ...details});
  };
  try { await run({emit, checks, listeners, api}); }
  finally {
    assert.equal(listeners.size, 0, "every transfer removes its redirect observer");
    if (oldChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
}

test("returns the original unread stream and carries browser credentials", async () => {
  await fixture(async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "video/mp4", "content-length": "3"}});
    globalThis.fetch = async (url, options) => {
      assert.equal(url, source);
      assert.equal(options.credentials, "include");
      assert.equal(options.redirect, "follow");
      return response;
    };
    const result = await fetchVideoStream(source);
    assert.equal(result.stream, response.body);
    assert.equal(result.stream.locked, false);
    assert.equal(response.bodyUsed, false);
    assert.equal(result.totalBytes, 3);
  }, {observer: false});
});

test("a failed redirect to a missing host permission returns only the exact origin", async () => {
  await fixture(async ({emit, checks}) => {
    globalThis.fetch = async () => { emit(); throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchVideoStream(source), (error) => {
      assert.equal(error.code, "VIDEO_HOST_PERMISSION");
      assert.equal(error.permissionOrigin, "https://media.example-cdn.test/*");
      assert.doesNotMatch(error.message, /signature|private|token/);
      return true;
    });
    assert.deepEqual(checks, [{origins: ["https://media.example-cdn.test/*"]}]);
  }, {granted: false});
});

test("ignores other initiators, tabs, URLs, request IDs and resource types", async () => {
  await fixture(async ({emit, checks}) => {
    globalThis.fetch = async () => {
      emit({initiator: "https://school.hosted.panopto.com"});
      emit({tabId: 99});
      emit({url: source.replace("lecture", "unrelated")});
      emit({type: "media"});
      emit({requestId: "our-request", redirectUrl: "https://school.hosted.panopto.com/next.mp4"});
      emit({requestId: "foreign-request"});
      throw new TypeError("Network disconnected");
    };
    await assert.rejects(fetchVideoStream(source), {code: "VIDEO_NETWORK_ERROR"});
    assert.deepEqual(checks, [{origins: ["https://school.hosted.panopto.com/*"]}]);
  });
});

test("follows the same request ID across permitted intermediate redirects", async () => {
  await fixture(async ({emit, checks}) => {
    globalThis.fetch = async () => {
      emit({redirectUrl: "https://media.example-cdn.test/redirect"});
      emit({url: "https://media.example-cdn.test/redirect", redirectUrl: "https://storage.example-cdn.test/movie.mp4?signed=yes"});
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(fetchVideoStream(source), {code: "VIDEO_HOST_PERMISSION", permissionOrigin: "https://storage.example-cdn.test/*"});
    assert.deepEqual(checks, [{origins: ["https://storage.example-cdn.test/*"]}]);
  }, {granted: false});
});

test("an already permitted CDN network failure does not request permission", async () => {
  await fixture(async ({emit}) => {
    globalThis.fetch = async () => { emit(); throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchVideoStream(source), {code: "VIDEO_NETWORK_ERROR"});
  });
});

test("successful natural CORS responses never trigger a permission check", async () => {
  await fixture(async ({emit, checks}) => {
    globalThis.fetch = async () => { emit(); return new Response(new Uint8Array([1]), {headers: {"content-type": "application/octet-stream"}}); };
    const result = await fetchVideoStream(source);
    assert.equal(result.totalBytes, null);
    assert.equal(checks.length, 0);
    await result.stream.cancel();
  }, {granted: false});
});

test("preserves AbortError and ignores permission hints after cancellation", async () => {
  await fixture(async ({emit, checks}) => {
    const aborted = new DOMException("Stopped", "AbortError");
    globalThis.fetch = async () => { emit(); throw aborted; };
    await assert.rejects(fetchVideoStream(source), (error) => error === aborted);
    assert.equal(checks.length, 0);
    const controller = new AbortController();
    controller.abort(aborted);
    await assert.rejects(fetchVideoStream(source, {signal: controller.signal}), (error) => error === aborted);
  }, {granted: false});
});

test("rejects HTTP errors, missing bodies, zero length and non-video responses", async () => {
  const cases = [
    [new Response("denied", {status: 403}), "VIDEO_HTTP_ERROR"],
    [new Response(null, {status: 204}), "VIDEO_EMPTY_RESPONSE"],
    [new Response(new Uint8Array(), {headers: {"content-type": "video/mp4", "content-length": "0"}}), "VIDEO_EMPTY_RESPONSE"],
    [new Response(new Uint8Array([1]), {status: 206, headers: {"content-type": "video/mp4"}}), "VIDEO_PARTIAL_RESPONSE"],
    ...["text/html", "text/plain", "application/json", "application/xml", "application/vnd.apple.mpegurl", "application/dash+xml", "audio/mp4", "video/mp2t"].map((type) => [new Response("invalid", {headers: {"content-type": type}}), "VIDEO_INVALID_RESPONSE"])
  ];
  for (const [response, code] of cases) {
    await fixture(async ({checks}) => {
      globalThis.fetch = async () => response;
      await assert.rejects(fetchVideoStream(source), {code});
      assert.equal(checks.length, 0, "HTTP/MIME errors are not permission failures");
      if (response.body) assert.equal(response.bodyUsed, true, "unused error bodies are cancelled");
    });
  }
});

test("encoded responses and missing lengths do not claim an uncompressed size", async () => {
  await fixture(async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1]), {headers: {"content-type": "video/mp4", "content-length": "20", "content-encoding": "gzip"}});
    const result = await fetchVideoStream(source);
    assert.equal(result.totalBytes, null);
    await result.stream.cancel();
  });
});

test("does not request a non-HTTPS redirect origin", async () => {
  await fixture(async ({emit, checks}) => {
    globalThis.fetch = async () => { emit({redirectUrl: "http://media.example-cdn.test/movie.mp4"}); throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchVideoStream(source), {code: "VIDEO_NETWORK_ERROR"});
    assert.equal(checks.length, 0);
  }, {granted: false});
});
