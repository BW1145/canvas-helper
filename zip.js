// Dependency-free ZIP writers (stored entries, UTF-8 filenames, CRC-32).
// The Blob writer serves small transcript archives; StreamingZipWriter writes
// videos directly to a seekable file without retaining their bodies in memory.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(bytes) {
  const crc = updateCrc(0xffffffff, bytes);
  return (crc ^ 0xffffffff) >>> 0;
}
function updateCrc(crc, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}
function header(size) {
  const bytes = new Uint8Array(size);
  return {bytes, view: new DataView(bytes.buffer)};
}

export function makeZip(files, date = new Date()) {
  if (files.length > 65535) throw new Error("压缩包文件数量过多。请分批下载。");
  const locals = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  for (const file of files) {
    if (!file.name || file.name.startsWith("/") || file.name.split("/").includes("..") || file.name.includes("\\")) throw new Error("无效的压缩包文件名。");
    const name = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error("文件过大。");
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(10, dosTime, true);
    local.view.setUint16(12, dosDate, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    locals.push(local.bytes, name, data);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(12, dosTime, true);
    central.view.setUint16(14, dosDate, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + data.length;
    if (offset + directorySize > 0xffffffff) throw new Error("压缩包超过 ZIP32 容量。");
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...locals, ...directory, end.bytes], {type: "application/zip"});
}

function fileNameBytes(name) {
  if (typeof name !== "string" || !name || name.startsWith("/") ||
      name.split("/").includes("..") || name.includes("\\") ||
      name.includes("\0") || /^[A-Za-z]:/.test(name)) {
    throw new Error("无效的压缩包文件名。");
  }
  const bytes = encoder.encode(name);
  if (bytes.length > 65535) throw new Error("压缩包文件名过长。");
  return bytes;
}

function requireSafeOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("压缩包已超过浏览器支持的文件大小。");
  }
  return value;
}

function setUint64(view, offset, value) {
  view.setBigUint64(offset, BigInt(requireSafeOffset(value)), true);
}

function abortError(signal) {
  if (signal?.reason?.name === "AbortError") return signal.reason;
  return new DOMException("下载已取消。", "AbortError");
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

// Interrupt a blocked stream read as well as checking between completed chunks.
function waitForRead(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", stop, {once: true});
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener("abort", stop);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    if (signal.aborted) stop();
  });
}

async function* chunksFrom(source, signal) {
  checkAbort(signal);
  if (typeof source === "string") {
    yield encoder.encode(source);
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) source = source.stream();
  if (source?.getReader) {
    const reader = source.getReader();
    let complete = false;
    try {
      for (;;) {
        checkAbort(signal);
        const {done, value} = await waitForRead(reader.read(), signal);
        checkAbort(signal);
        if (done) {
          complete = true;
          return;
        }
        yield value;
      }
    } finally {
      if (!complete) {
        // Cancellation must not wait for a remote source before rolling back.
        Promise.resolve(reader.cancel(signal?.aborted ? abortError(signal) : undefined)).catch(() => {});
      }
      reader.releaseLock();
    }
  }
  const iterator = source?.[Symbol.asyncIterator]?.() ?? source?.[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("压缩包文件内容必须是文本、字节或数据流。");
  let complete = false;
  try {
    for (;;) {
      checkAbort(signal);
      const {done, value} = await waitForRead(iterator.next(), signal);
      checkAbort(signal);
      if (done) {
        complete = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!complete && iterator.return) {
      Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}

/**
 * Write one ZIP64 archive directly to a FileSystemWritableFileStream-like sink.
 * Only the current source chunk and successful entry metadata stay in memory.
 * add() is transactional: a failed/cancelled entry is truncated out of the file.
 * Keep the writer object to resume a reopened file at a previous checkpoint.
 */
export class StreamingZipWriter {
  constructor(sink, date = new Date()) {
    this._checkSink(sink);
    this.sink = sink;
    this.offset = 0;
    this._contentOffset = 0;
    this._entries = [];
    this._busy = false;
    this._closed = false;
    this._needsResume = false;
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    this._dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    this._dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  }

  _checkSink(sink) {
    for (const method of ["write", "seek", "truncate", "close"]) {
      if (typeof sink?.[method] !== "function") throw new TypeError(`保存文件缺少 ${method} 操作。`);
    }
  }

  _checkReady() {
    if (this._busy) throw new Error("压缩包正在写入，请等待当前文件完成。");
    if (this._closed || this._needsResume) throw new Error("请重新打开保存文件后继续写入。");
  }

  async _write(bytes) {
    const next = requireSafeOffset(this.offset + bytes.byteLength);
    await this.sink.write(bytes);
    this.offset = next;
  }

  async _rewind(sink, offset) {
    await sink.truncate(offset);
    await sink.seek(offset);
  }

  get needsResume() {
    return this._needsResume;
  }

  checkpoint() {
    if (this._busy) throw new Error("请等待当前文件完成后保存检查点。");
    return {entries: this._entries.length, offset: this._contentOffset};
  }

  /** onProgress receives the cumulative uncompressed bytes of this entry. */
  async add(name, source, {signal, onProgress} = {}) {
    this._checkReady();
    checkAbort(signal);
    const nameBytes = fileNameBytes(name);
    const start = this.offset;
    this._busy = true;
    try {
      // Reserve ZIP64 sizes from the start because a response may omit its size.
      const local = header(30);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 45, true);
      local.view.setUint16(6, 0x0808, true); // UTF-8 + data descriptor.
      local.view.setUint16(10, this._dosTime, true);
      local.view.setUint16(12, this._dosDate, true);
      local.view.setUint32(18, 0xffffffff, true);
      local.view.setUint32(22, 0xffffffff, true);
      local.view.setUint16(26, nameBytes.length, true);
      local.view.setUint16(28, 20, true);
      const extra = header(20);
      extra.view.setUint16(0, 0x0001, true);
      extra.view.setUint16(2, 16, true);
      await this._write(local.bytes);
      await this._write(nameBytes);
      await this._write(extra.bytes);
      let size = 0;
      let crc = 0xffffffff;
      for await (const chunk of chunksFrom(source, signal)) {
        checkAbort(signal);
        if (!(chunk instanceof Uint8Array)) throw new TypeError("文件数据流包含非字节内容。");
        if (!chunk.byteLength) continue;
        size = requireSafeOffset(size + chunk.byteLength);
        crc = updateCrc(crc, chunk);
        // Await every disk write for bounded memory and write ordering.
        await this._write(chunk);
        checkAbort(signal);
        if (onProgress) await onProgress(size);
      }
      checkAbort(signal);
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = header(24);
      descriptor.view.setUint32(0, 0x08074b50, true);
      descriptor.view.setUint32(4, crc, true);
      setUint64(descriptor.view, 8, size);
      setUint64(descriptor.view, 16, size);
      await this._write(descriptor.bytes);
      checkAbort(signal);
      this._entries.push({name, nameBytes, size, crc, offset: start, endOffset: this.offset});
      this._contentOffset = this.offset;
      return {name, size, crc, offset: start};
    } catch (error) {
      try {
        await this._rewind(this.sink, start);
        this.offset = start;
      } catch (rollbackError) {
        this._needsResume = true;
        const failure = new AggregateError([error, rollbackError], "文件写入中断，请重新打开保存文件后重试。");
        failure.name = error?.name === "AbortError" ? "AbortError" : "ZipRollbackError";
        throw failure;
      }
      throw error;
    } finally {
      this._busy = false;
    }
  }

  /**
   * Reopen the SAME archive using createWritable({keepExistingData: true}).
   * A checkpoint before TXT/CSV lets the caller replace that tail after retries.
   * Previous local entries remain untouched; stale entries/central records go.
   */
  async resume(sink, checkpoint) {
    if (this._busy) throw new Error("压缩包正在写入，请等待当前文件完成。");
    this._checkSink(sink);
    const count = checkpoint?.entries;
    if (!Number.isInteger(count) || count < 0 || count > this._entries.length) {
      throw new Error("无效的压缩包检查点。");
    }
    const expected = count ? this._entries[count - 1].endOffset : 0;
    if (checkpoint.offset !== expected) throw new Error("压缩包检查点与现有文件不一致。");
    this._busy = true;
    this._needsResume = true;
    try {
      await this._rewind(sink, checkpoint.offset);
      this.sink = sink;
      this._entries.length = count;
      this.offset = checkpoint.offset;
      this._contentOffset = checkpoint.offset;
      this._closed = false;
      this._needsResume = false;
      return this;
    } finally {
      this._busy = false;
    }
  }

  async close() {
    this._checkReady();
    this._busy = true;
    const directoryOffset = this.offset;
    try {
      for (const entry of this._entries) {
        const central = header(46);
        central.view.setUint32(0, 0x02014b50, true);
        central.view.setUint16(4, 45, true);
        central.view.setUint16(6, 45, true);
        central.view.setUint16(8, 0x0808, true);
        central.view.setUint16(12, this._dosTime, true);
        central.view.setUint16(14, this._dosDate, true);
        central.view.setUint32(16, entry.crc, true);
        central.view.setUint32(20, 0xffffffff, true);
        central.view.setUint32(24, 0xffffffff, true);
        central.view.setUint16(28, entry.nameBytes.length, true);
        central.view.setUint16(30, 28, true);
        central.view.setUint32(42, 0xffffffff, true);
        const extra = header(28);
        extra.view.setUint16(0, 0x0001, true);
        extra.view.setUint16(2, 24, true);
        setUint64(extra.view, 4, entry.size);
        setUint64(extra.view, 12, entry.size);
        setUint64(extra.view, 20, entry.offset);
        await this._write(central.bytes);
        await this._write(entry.nameBytes);
        await this._write(extra.bytes);
      }
      const directorySize = this.offset - directoryOffset;
      const zip64Offset = this.offset;
      const zip64End = header(56);
      zip64End.view.setUint32(0, 0x06064b50, true);
      setUint64(zip64End.view, 4, 44);
      zip64End.view.setUint16(12, 45, true);
      zip64End.view.setUint16(14, 45, true);
      setUint64(zip64End.view, 24, this._entries.length);
      setUint64(zip64End.view, 32, this._entries.length);
      setUint64(zip64End.view, 40, directorySize);
      setUint64(zip64End.view, 48, directoryOffset);
      await this._write(zip64End.bytes);
      const locator = header(20);
      locator.view.setUint32(0, 0x07064b50, true);
      setUint64(locator.view, 8, zip64Offset);
      locator.view.setUint32(16, 1, true);
      await this._write(locator.bytes);
      const end = header(22);
      end.view.setUint32(0, 0x06054b50, true);
      end.view.setUint16(8, 0xffff, true);
      end.view.setUint16(10, 0xffff, true);
      end.view.setUint32(12, 0xffffffff, true);
      end.view.setUint32(16, 0xffffffff, true);
      await this._write(end.bytes);
      await this.sink.close();
      this._closed = true;
    } catch (error) {
      // Do not discard entry metadata: resume() can remove a partial directory.
      this._needsResume = true;
      throw error;
    } finally {
      this._busy = false;
    }
  }
}
