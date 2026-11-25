// Runs the freshly built core under Node and writes what the binary reports about itself:
// version + configure line, licence, and its component lists. One fresh instance per call,
// exactly like the browser worker.
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const createFFmpegCore = require(path.join(out, 'ffmpeg-core.js'));

async function run(args) {
  const lines = [];
  const m = await createFFmpegCore({ print: (t) => lines.push(t), printErr: (t) => lines.push(t) });
  const code = m.callMain(['-hide_banner', ...args]);
  return { code, text: lines.join('\n') };
}

(async () => {
  const report = {};
  for (const [k, args] of Object.entries({
    version: ['-version'], buildconf: ['-buildconf'], license: ['-L'],
    decoders: ['-decoders'], encoders: ['-encoders'], demuxers: ['-demuxers'],
    muxers: ['-muxers'], filters: ['-filters'],
  })) {
    const r = await run(args);
    report[k] = r.text;
    fs.writeFileSync(path.join(out, `${k}.txt`), r.text + '\n');
  }
  const cfg = report.version;
  const bad = ['--enable-gpl', '--enable-nonfree', '--enable-version3', 'libx264', 'libx265', 'libfdk'];
  const found = bad.filter((b) => cfg.includes(b));
  if (found.length) { console.error('FORBIDDEN configure flags present:', found); process.exit(1); }
  const lic = report.license.replace(/\s+/g, ' ');
  if (!lic.includes('GNU Lesser General Public License') || lic.includes('GNU General Public License as published')) {
    console.error('licence is not LGPL:', report.license); process.exit(1);
  }
  // Functional check: encode 1 s of generated tone (a WAV built here; lavfi lives in the
  // disabled libavdevice) to every output format the site offers.
  const sr = 44100, n = sr, wav = Buffer.alloc(44 + n * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 4, 28); wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 16000); wav.writeInt16LE(v, 44 + i * 4); wav.writeInt16LE(v, 46 + i * 4); }
  for (const [ext, codec] of [['mp3', ['-c:a', 'libmp3lame', '-q:a', '2']], ['wav', ['-c:a', 'pcm_s16le']], ['m4a', ['-c:a', 'aac', '-b:a', '192k']], ['aac', ['-c:a', 'aac', '-b:a', '192k']], ['ogg', ['-c:a', 'libvorbis', '-q:a', '5']], ['flac', ['-c:a', 'flac']]]) {
    const lines = [];
    const m = await createFFmpegCore({ print: (t) => lines.push(t), printErr: (t) => lines.push(t) });
    m.FS.writeFile('in.wav', wav);
    const code = m.callMain(['-hide_banner', '-i', 'in.wav', ...codec, 'out.' + ext]);
    const size = code === 0 ? m.FS.stat('out.' + ext).size : 0;
    if (code !== 0 || size < 1000) { console.error(`encode ${ext} failed (code ${code})\n` + lines.slice(-5).join('\n')); process.exit(1); }
    console.log(`encode ${ext}: ok, ${size} bytes`);
  }
  console.log(cfg.split('\n').slice(0, 3).join('\n'));
  console.log('licence:', report.license.split('\n')[0]);
})();
