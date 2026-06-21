// Validate JS MP3 reframing + decode against 1 (3).avi (the failing file).
const fs = require("fs"), path = require("path");
require(path.resolve(__dirname, "..", "lib", "libav-6.8.8.0-divx-mp3-avi.js"));
const AVI = path.resolve(__dirname, "..", "1 (3).avi");

function mp3FrameLength(buf, i) {
  if (i + 4 > buf.length) return -1;
  const b1 = buf[i + 1];
  if (buf[i] !== 0xFF || (b1 & 0xE0) !== 0xE0) return -1;
  const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3;
  if (ver === 1 || layer !== 1) return -1; // we only handle MPEG1/2/2.5 Layer III
  const b2 = buf[i + 2];
  const brIdx = (b2 >> 4) & 0xF, srIdx = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return -1;
  const br1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const br2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sr1 = [44100,48000,32000,0], sr2 = [22050,24000,16000,0], sr25 = [11025,12000,8000,0];
  let kbps, sr;
  if (ver === 3) { kbps = br1[brIdx]; sr = sr1[srIdx]; }
  else if (ver === 2) { kbps = br2[brIdx]; sr = sr2[srIdx]; }
  else { kbps = br2[brIdx]; sr = sr25[srIdx]; }
  if (!kbps || !sr) return -1;
  const coeff = (ver === 3) ? 144 : 72;
  const sz = Math.floor(coeff * kbps * 1000 / sr) + pad;
  return sz > 0 ? sz : -1;
}

function reframe(stream) {
  const frames = [];
  let i = 0;
  while (i + 4 <= stream.length) {
    const sz = mp3FrameLength(stream, i);
    if (sz <= 0) { i++; continue; }
    if (i + sz > stream.length) break;
    frames.push(stream.subarray(i, i + sz));
    i += sz;
  }
  const residual = (i < stream.length) ? new Uint8Array(stream.subarray(i)) : null;
  return { frames, residual };
}

(async () => {
  const libav = await LibAV.LibAV({ noworker: true });
  await libav.writeFile("in.avi", new Uint8Array(fs.readFileSync(AVI)));
  const [fmt, streams] = await libav.ff_init_demuxer_file("in.avi");
  const a = streams.find(s => s.codec_type === 1);
  const acp = await libav.AVStream_codecpar(a.ptr);
  const [, actx, apkt, aframe] = await libav.ff_init_decoder(a.codec_id, { codecpar: acp, time_base: [a.time_base_num, a.time_base_den] });
  const rpkt = await libav.av_packet_alloc();

  let residual = null;
  let decodedFrames = 0, decodedSamples = 0, errors = 0;
  let minS = 1, maxS = -1, frameSizes = new Set();

  for (let loop = 0; loop < 40; loop++) {
    const [res, packs] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 1 << 18 });
    const ap = packs[a.index];
    if (ap && ap.length) {
      // concatenate
      let total = residual ? residual.length : 0;
      for (const p of ap) total += p.data.length;
      const stream = new Uint8Array(total);
      let off = 0;
      if (residual) { stream.set(residual, 0); off = residual.length; }
      for (const p of ap) { stream.set(p.data, off); off += p.data.length; }
      const { frames, residual: newRes } = reframe(stream);
      residual = newRes;
      // decode each frame
      for (const f of frames) frameSizes.add(f.length);
      try {
        const frs = await libav.ff_decode_multi(actx, apkt, aframe,
          frames.map(f => ({ data: f })));
        for (const f of frs) {
          decodedFrames++; decodedSamples += f.nb_samples;
          const L = new Int16Array(f.data[0].buffer, f.data[0].byteOffset, f.nb_samples);
          for (let i = 0; i < L.length; i++) { const s = L[i] / 32768; if (s < minS) minS = s; if (s > maxS) maxS = s; }
        }
      } catch (e) { errors++; if (errors <= 3) console.log("  decode err:", e.message); }
    }
    if (res === libav.AVERROR_EOF) break;
  }
  console.log("frame sizes seen:", [...frameSizes].sort((a, b) => a - b).join(","));
  console.log(`decoded frames=${decodedFrames} samples=${decodedSamples} => ${decodedSamples / 44100}s`);
  console.log(`errors=${errors}  floatRange=[${minS.toFixed(3)},${maxS.toFixed(3)}]`);
  console.log(decodedFrames > 100 && errors === 0 && maxS > 0.01 ? "REFRAME_OK" : "REFRAME_FAIL");
  process.exit(decodedFrames > 100 && errors === 0 ? 0 : 1);
})().catch(e => { console.error("ERR", e); process.exit(2); });
