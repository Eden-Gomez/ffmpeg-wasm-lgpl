// Self-contained FFmpeg Web Worker, shared by every audio tool (lib/ffmpeg-client.ts).
// Runs the LGPL-only FFmpeg 5.1 WebAssembly core built from vendor/ffmpeg-lgpl/ and served
// from a content-hashed directory, passed in as ?core=/ffmpeg/<version>-<hash>/.
// The wasm is compiled once per worker; every job gets a FRESH module instance, so FFmpeg's
// process-global state (option tables, counters, open files) can never leak from one call
// into the next, and an instance's memory is released when the job ends.
//
// Two message shapes:
//  - single input (every existing tool): { id, inputData, inputName, outputName, ffmpegArgs, inputArgs?,
//                                          timeScale? }
//  - multi input (audio editor):         { id, inputs: [{ name, blob? | data? }], args, outputName,
//                                          stream?, progressDuration? }
// Out: { id, type: 'progress'|'log'|'chunk'|'download'|'done'|'error', ratio?, text?, bytes?, error?,
//        received?, total?, done? }
// 'download': bytes of ffmpeg-core.wasm received so far (first use; a load that finishes within
// 400 ms, i.e. from the cache, posts nothing). total is 0 when unknown.
/* global createFFmpegCore */

var PARAMS = new URLSearchParams(self.location.search);
var CORE_BASE = PARAMS.get('core') || '/ffmpeg/';
var WASM_BYTES = Number(PARAMS.get('wasmBytes')) || 0; // uncompressed size, from lib/ffmpeg-manifest.json
importScripts(CORE_BASE + 'ffmpeg-core.js');

var compiledPromise = null;
var totalDuration = 0; // seconds, parsed from FFmpeg stderr
var fixedDuration = 0; // seconds; when set (e.g. a trimmed output), progress is measured against it
var timeScale = 1; // output seconds per input second (e.g. 0.5 for a 2x speed-up)
var stderrBuf = []; // rolling log for the CURRENT call, so a failure can report the real cause
var currentId = null;

// Fetches the wasm and reports the bytes as they arrive ('download' messages, at most every
// 200 ms): on a slow connection the first-use download is the longest step of a job, and the
// page's stall watchdog must see it moving. The body is passed on as a stream, so
// compileStreaming still compiles while downloading.
function fetchCounted(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error('Could not download the audio engine (HTTP ' + res.status + ')');
    if (!res.body || typeof ReadableStream !== 'function') return res;
    // A compressed response's Content-Length counts compressed bytes; the reader yields
    // uncompressed ones. Use it only for an uncompressed response, else the known file size.
    var len = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
    var total = len || WASM_BYTES;
    var id = currentId;
    var reader = res.body.getReader();
    var got = 0;
    var t0 = performance.now();
    var lastPost = 0;
    var shown = false;
    function post(done) {
      var now = performance.now();
      if (!done && (now - t0 < 400 || now - lastPost < 200)) return;
      if (done && !shown) return;
      shown = true;
      lastPost = now;
      self.postMessage({ id: id, type: 'download', received: got, total: total, done: done });
    }
    var body = new ReadableStream({
      pull: function (ctrl) {
        return reader.read().then(function (r) {
          if (r.done) {
            post(true);
            ctrl.close();
            return;
          }
          got += r.value.byteLength;
          post(false);
          ctrl.enqueue(r.value);
        });
      },
      cancel: function (why) { return reader.cancel(why); },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
  });
}

function compileCore() {
  if (compiledPromise) return compiledPromise;
  var url = CORE_BASE + 'ffmpeg-core.wasm';
  compiledPromise = (typeof WebAssembly.compileStreaming === 'function'
    ? WebAssembly.compileStreaming(fetchCounted(url)).catch(function () {
        // e.g. a proxy serving the wrong Content-Type — fall back to a plain compile.
        return fetchCounted(url).then(function (r) { return r.arrayBuffer(); }).then(WebAssembly.compile);
      })
    : fetchCounted(url).then(function (r) { return r.arrayBuffer(); }).then(WebAssembly.compile)
  ).catch(function (err) {
    compiledPromise = null; // allow a retry on the next job (e.g. after a network blip)
    throw err;
  });
  return compiledPromise;
}

// -progress pipe:2 prints a block of key=value lines every 0.5 s. They are posted as logs
// (the page's stall watchdog counts them) but kept out of stderrBuf, so an error message
// still reports FFmpeg's real last words instead of the latest progress block.
var PROGRESS_LINE = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/;

function onStderr(text) {
  self.postMessage({ id: currentId, type: 'log', text: text });
  if (!PROGRESS_LINE.test(text)) {
    stderrBuf.push(text);
    if (stderrBuf.length > 200) stderrBuf.shift();
  }
  // Parse total duration  "  Duration: 00:03:25.12,"
  var dm = text.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (dm && !totalDuration) {
    totalDuration = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);
  }
  // Current time: "time=00:01:03.45" (stats line), or "out_time_us=63450000" (-progress pipe:2).
  var cur = -1;
  var tm = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
  if (tm) cur = parseInt(tm[1], 10) * 3600 + parseInt(tm[2], 10) * 60 + parseFloat(tm[3]);
  var um = text.match(/^out_time_us=(\d+)/);
  if (um) cur = parseInt(um[1], 10) / 1e6;
  var total = fixedDuration || totalDuration * timeScale;
  if (cur >= 0 && total > 0) {
    self.postMessage({ id: currentId, type: 'progress', ratio: Math.min(cur / total, 1) });
  }
}

function newInstance(compiled) {
  return new Promise(function (resolve, reject) {
    createFFmpegCore({
      locateFile: function (name) { return CORE_BASE + name; },
      print: function (text) { self.postMessage({ id: currentId, type: 'log', text: text }); },
      printErr: onStderr,
      instantiateWasm: function (imports, receive) {
        WebAssembly.instantiate(compiled, imports).then(function (inst) { receive(inst, compiled); }, reject);
        return {};
      },
    }).then(resolve, reject);
  });
}

function stderrTail() {
  var tail = stderrBuf.slice(-5).join(' | ').trim();
  return tail ? ': ' + tail : '';
}

// Jobs run strictly one after another. Two jobs posted back to back would otherwise
// interleave across the awaits below and share currentId/stderrBuf.
var queue = Promise.resolve();
self.onmessage = function (e) {
  var data = e.data;
  queue = queue.then(function () {
    return data.inputs ? runMulti(data) : runSingle(data);
  });
};

// ── File-backed inputs ──────────────────────────────────────────────────────
// A File/Blob is mounted as a read-only MEMFS node whose reads come straight from the
// Blob (FileReaderSync, 1 MB chunks, small LRU), so the input is never copied into wasm
// memory: a 60-min MP3 costs a few MB of cache instead of its full size.
var readError = null;

function mountBlob(m, name, blob) {
  var FS = m.FS;
  var CH = 1 << 20;
  var cache = [];
  var reader = new FileReaderSync();
  function chunk(i) {
    for (var c = 0; c < cache.length; c++) {
      if (cache[c].i === i) {
        var hit = cache[c];
        if (c) { cache.splice(c, 1); cache.unshift(hit); }
        return hit.u8;
      }
    }
    var start = i * CH;
    var end = Math.min(start + CH, blob.size);
    var ab;
    try {
      ab = reader.readAsArrayBuffer(blob.slice(start, end));
    } catch (err) {
      readError = err;
      throw new FS.ErrnoError(29); // EIO
    }
    if (ab.byteLength !== end - start) {
      readError = new Error('short read (' + ab.byteLength + ' of ' + (end - start) + ' bytes)');
      throw new FS.ErrnoError(29);
    }
    var u8 = new Uint8Array(ab);
    cache.unshift({ i: i, u8: u8 });
    if (cache.length > 8) cache.pop();
    return u8;
  }
  function copyOut(dst, offset, length, position) {
    var size = blob.size;
    if (position >= size) return 0;
    var n = Math.min(length, size - position);
    var done = 0;
    while (done < n) {
      var pos = position + done;
      var ci = Math.floor(pos / CH);
      var u8 = chunk(ci);
      var from = pos - ci * CH;
      var take = Math.min(n - done, u8.length - from);
      dst.set(u8.subarray(from, from + take), offset + done);
      done += take;
    }
    return n;
  }
  var node = FS.createFile('/', name, {}, true, false);
  Object.defineProperty(node, 'usedBytes', { get: function () { return blob.size; }, set: function () {} });
  var ops = {};
  Object.keys(node.stream_ops).forEach(function (k) { ops[k] = node.stream_ops[k]; });
  ops.read = function (stream, buffer, offset, length, position) {
    return copyOut(new Uint8Array(buffer.buffer, buffer.byteOffset), offset, length, position);
  };
  ops.write = function () { throw new FS.ErrnoError(63); }; // read-only
  ops.mmap = function () { throw new FS.ErrnoError(43); }; // not supported
  node.stream_ops = ops;
}

// Streamed output: writes are buffered and posted to the page in 1 MB chunks, so a long raw
// PCM output (the waveform pass, a range decode) is never held whole in wasm memory. Only
// for muxers that never seek back (raw s16le / f32le).
function mountSink(m, name, id) {
  var FS = m.FS;
  var CH = 1 << 20;
  var buf = new Uint8Array(CH);
  var fill = 0;
  var total = 0;
  function flush() {
    if (!fill) return;
    var out = buf.slice(0, fill).buffer;
    fill = 0;
    self.postMessage({ id: id, type: 'chunk', bytes: out }, [out]);
  }
  var node = FS.createFile('/', name, {}, true, true);
  Object.defineProperty(node, 'usedBytes', { get: function () { return total; }, set: function () {} });
  var ops = {};
  Object.keys(node.stream_ops).forEach(function (k) { ops[k] = node.stream_ops[k]; });
  ops.write = function (stream, buffer, offset, length, position) {
    if (position !== total) throw new FS.ErrnoError(70); // ESPIPE: a sink can't seek back
    var src = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    var done = 0;
    while (done < length) {
      var take = Math.min(length - done, CH - fill);
      buf.set(src.subarray(done, done + take), fill);
      fill += take;
      done += take;
      if (fill === CH) flush();
    }
    total += length;
    return length;
  };
  ops.mmap = function () { throw new FS.ErrnoError(43); };
  node.stream_ops = ops;
  return flush;
}

async function runMulti(data) {
  var id = data.id;
  currentId = id;
  totalDuration = 0;
  fixedDuration = data.progressDuration || 0;
  timeScale = 1;
  stderrBuf = [];
  readError = null;
  try {
    var m = await newInstance(await compileCore());
    for (var i = 0; i < data.inputs.length; i++) {
      var inp = data.inputs[i];
      if (inp.blob) mountBlob(m, inp.name, inp.blob);
      else m.FS.writeFile(inp.name, new Uint8Array(inp.data));
    }
    var flush = data.stream ? mountSink(m, data.outputName, id) : null;
    // FFmpeg's stats line ends in a carriage return, and the wasm console only flushes on a
    // newline, so stats never arrive while a job runs. -progress pipe:2 prints newline-terminated
    // out_time_us=… lines every 0.5 s instead: live progress, and a heartbeat for the
    // page's stall watchdog.
    var args = ['-nostdin', '-y', '-nostats', '-progress', 'pipe:2', '-probesize', '100M', '-analyzeduration', '100M']
      .concat(data.args)
      .concat([data.outputName]);
    var code = m.callMain(args);
    if (readError) {
      throw new Error('NotReadableError: ' + ((readError && readError.message) || String(readError)));
    }
    if (code !== 0) {
      console.error('FFmpeg failed (exit code ' + code + '). Command: ffmpeg ' + args.join(' ') + '\n' + stderrBuf.join('\n'));
      throw new Error('FFmpeg exited with code ' + code + stderrTail());
    }
    var buf = null;
    if (flush) {
      flush();
    } else {
      var out = m.FS.readFile(data.outputName);
      buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      out = null;
    }
    m = null; // drop the instance (and its whole wasm memory) before posting the result
    self.postMessage({ id: id, type: 'done', bytes: buf }, buf ? [buf] : []);
  } catch (err) {
    var message = (err && err.message) || String(err);
    if (readError && message.indexOf('NotReadableError') === -1) {
      message = 'NotReadableError: ' + ((readError && readError.message) || String(readError)) + ' (' + message + ')';
    }
    if (message.indexOf(stderrTail()) === -1) message += stderrTail();
    console.error('FFmpeg job failed:', message, '\nFull log:\n' + stderrBuf.join('\n'));
    self.postMessage({ id: id, type: 'error', error: message });
  }
}

async function runSingle(data) {
  var id = data.id;
  currentId = id;
  totalDuration = 0;
  fixedDuration = 0;
  timeScale = data.timeScale > 0 ? data.timeScale : 1;
  stderrBuf = [];

  try {
    var m = await newInstance(await compileCore());

    var inputBytes = new Uint8Array(data.inputData);
    m.FS.writeFile(data.inputName, inputBytes);

    // Verify the COMPLETE file made it into the WASM virtual FS before decoding — a
    // partial write here would look exactly like a truncated/corrupt input to FFmpeg
    // (e.g. "moov atom not found" on an MP4 whose index is written last). The caller
    // (readFileSafely() in lib/ffmpeg-client.ts) already validates the read itself, so
    // this is a second, independent check on the postMessage transfer + MEMFS write —
    // fail here too rather than let FFmpeg run on short data and blame the container.
    var writtenSize = m.FS.stat(data.inputName).size;
    if (writtenSize !== inputBytes.length) {
      throw new Error(
        'Internal error writing this file for processing (expected ' + inputBytes.length +
        ' bytes, wrote ' + writtenSize + '). Please try again.'
      );
    }
    inputBytes = null; // the MEMFS copy is the one FFmpeg reads; let the transfer buffer go

    // Input-side options (e.g. fast-seek -ss) must precede -i; everything the caller
    // passes in ffmpegArgs remains output-side.
    var inputArgs = data.inputArgs || [];
    // Generous probesize/analyzeduration: default (~5MB/5s) can under-probe real-world
    // MP4/MOV files with large moov atoms or unusual atom ordering, producing a low
    // format-detection score and, in the worst case, "Invalid data found when
    // processing input" even though the file itself is complete and valid.
    // -nostats -progress pipe:2: live progress and a stall-watchdog heartbeat (see runMulti).
    var args = ['-nostdin', '-y', '-nostats', '-progress', 'pipe:2', '-probesize', '100M', '-analyzeduration', '100M']
      .concat(inputArgs)
      .concat(['-i', data.inputName])
      .concat(data.ffmpegArgs)
      .concat([data.outputName]);

    // callMain returns FFmpeg's exit status (exit() inside FFmpeg unwinds back to here).
    var code = m.callMain(args);

    if (code !== 0) {
      console.error('FFmpeg failed (exit code ' + code + '). Command: ffmpeg ' + args.join(' ') + '\n' + stderrBuf.join('\n'));
      var fullStderr = stderrBuf.join('\n');
      if (/moov atom not found/i.test(fullStderr)) {
        throw new Error(
          "Couldn't read this video's file structure (moov atom not found). " +
          'The file (' + writtenSize + ' bytes written) may be incomplete or use an ' +
          'unsupported container variant — try re-exporting it (e.g. with a "faststart" MP4 remux) and try again.'
        );
      }
      // Surface the real reason, not just the exit code — the last few stderr lines
      // usually name the actual problem (unsupported codec, no audio stream, etc.).
      throw new Error('FFmpeg exited with code ' + code + stderrTail());
    }

    var out = m.FS.readFile(data.outputName);
    var buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    out = null;
    m = null; // drop the instance (and its whole wasm memory) before posting the result

    self.postMessage({ id: id, type: 'done', bytes: buf }, [buf]);
  } catch (err) {
    var message = (err && err.message) || String(err);
    // Errors thrown before/outside the exit-code check (e.g. a WASM out-of-memory
    // abort on a very large file) never went through the code!==0 branch above, so
    // they wouldn't otherwise carry the real ffmpeg stderr — attach it here too,
    // unless the message already includes it (the code!==0 throw above does).
    if (message.indexOf(stderrTail()) === -1) message += stderrTail();
    console.error('FFmpeg conversion failed:', message, '\nFull log:\n' + stderrBuf.join('\n'));
    self.postMessage({ id: id, type: 'error', error: message });
  }
}
