#!/usr/bin/env node
// Reports how an FFmpeg WebAssembly build was configured, without running it.
//   node tools/check-licence.mjs path/to/ffmpeg-core.wasm [more.wasm ...]
// FFmpeg embeds its configure line in the binary (it is what `ffmpeg -version` prints after
// "configuration:"), so this works for any build, single- or multi-threaded, any wrapper.
// Exit code: 0 = no GPL/nonfree flags, 1 = flags found, 2 = no configure line found.
import { readFileSync } from 'node:fs';

const FLAGS = ['--enable-gpl', '--enable-nonfree', '--enable-version3', '--enable-libx264',
  '--enable-libx265', '--enable-libfdk-aac', '--enable-libxvid', '--enable-libvidstab',
  '--enable-librubberband', '--enable-frei0r', '--enable-avisynth'];

let worst = 0;
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file).toString('latin1');
  const m = /--target-os=[\x20-\x7e]+/.exec(text) || /(?:^|\0)(--[a-z][\x20-\x7e]*--enable-[\x20-\x7e]+)/.exec(text);
  console.log(`\n${file}`);
  if (!m) { console.log('  no configure line found (stripped or not an FFmpeg build)'); worst = Math.max(worst, 2); continue; }
  const cfg = m[0].replace(/^\0/, '');
  console.log(`  configuration: ${cfg}`);
  const found = FLAGS.filter((f) => cfg.split(/\s+/).includes(f));
  const nonfree = found.includes('--enable-nonfree');
  const gpl = found.includes('--enable-gpl');
  const v3 = found.includes('--enable-version3');
  const licence = nonfree ? 'nonfree and unredistributable'
    : gpl ? (v3 ? 'GPL version 3 or later' : 'GPL version 2 or later')
    : (v3 ? 'LGPL version 3 or later' : 'LGPL version 2.1 or later');
  console.log(`  flags of interest: ${found.length ? found.join(' ') : '(none)'}`);
  console.log(`  licence FFmpeg's configure assigns to this configuration: ${licence}`);
  if (gpl || nonfree) worst = Math.max(worst, 1);
}
process.exit(worst);
