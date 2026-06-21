// Validates the player's pure conversion logic against real decoded data.
const path = require("path"), fs = require("fs");
const LIB = path.resolve(__dirname, "..", "lib", "libav-6.8.8.0-divx-mp3-avi.js");
process.chdir(path.dirname(LIB));
require(LIB);
const AVI = path.resolve(__dirname, "..", "1.avi");

const AV_SAMPLE_FMT_S16P = 6, AV_SAMPLE_FMT_FLTP = 8;
function convPlane(plane, fmt, count, offset, stride) {
  const fl = new Float32Array(count);
  if (fmt === AV_SAMPLE_FMT_FLTP) {
    const v = new Float32Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) fl[i] = v[i * stride + offset];
  } else if (fmt === AV_SAMPLE_FMT_S16P) {
    const v = new Int16Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) fl[i] = v[i * stride + offset] / 32768;
  }
  return fl;
}
function audioFrameToFloat(f) {
  const fmt = f.format, nb = f.nb_samples, ch = f.channels || 1;
  const planes = f.data; const out = [];
  const planar = (fmt === AV_SAMPLE_FMT_S16P || fmt === AV_SAMPLE_FMT_FLTP);
  if (planar) for (let c = 0; c < ch; c++) out.push(convPlane(planes[c], fmt, nb, 0, 1));
  else for (let c = 0; c < ch; c++) out.push(convPlane(planes[0], fmt, nb, c, ch));
  return out;
}

(async () => {
  const libav = await LibAV.LibAV({ noworker: true });
  await libav.writeFile("in.avi", new Uint8Array(fs.readFileSync(AVI)));
  const [fmt, streams] = await libav.ff_init_demuxer_file("in.avi");
  const v = streams.find(s => s.codec_type === 0), a = streams.find(s => s.codec_type === 1);
  const vcp = await libav.AVStream_codecpar(v.ptr);
  const [, vctx, vpkt, vframe] = await libav.ff_init_decoder(v.codec_id, { codecpar: vcp, time_base: [v.time_base_num, v.time_base_den] });
  const acp = await libav.AVStream_codecpar(a.ptr);
  const [, actx, apkt, aframe] = await libav.ff_init_decoder(a.codec_id, { codecpar: acp, time_base: [a.time_base_num, a.time_base_den] });
  const rpkt = await libav.av_packet_alloc();

  let vf = null, af = null;
  while (!vf || !af) {
    const [res, packs] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 1 << 19 });
    if (!vf && packs[v.index] && packs[v.index].length) {
      const frs = await libav.ff_decode_multi(vctx, vpkt, vframe, packs[v.index], { copyoutFrame: "video" });
      if (frs.length) vf = frs[0];
    }
    if (!af && packs[a.index] && packs[a.index].length) {
      const frs = await libav.ff_decode_multi(actx, apkt, aframe, packs[a.index]);
      if (frs.length) af = frs[0];
    }
    if (res === libav.AVERROR_EOF) break;
  }

  // --- video YUV420P -> RGBA (BT.601) and sanity-check ---
  const w = vf.width, h = vf.height, lay = vf.layout, data = vf.data;
  const yO = lay[0].offset, yS = lay[0].stride;
  const uO = lay[1].offset, uS = lay[1].stride;
  const vO = lay[2].offset, vS = lay[2].stride;
  const rgba = Buffer.alloc(w * h * 4);
  let nonblack = 0, rmin = 255, rmax = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const Y = data[yO + y * yS + x];
      const U = data[uO + (y >> 1) * uS + (x >> 1)];
      const V = data[vO + (y >> 1) * vS + (x >> 1)];
      const c = Y - 16, d = U - 128, e = V - 128;
      let r = (298 * c + 409 * e + 128) >> 8; r = r < 0 ? 0 : r > 255 ? 255 : r;
      let g = (298 * c - 100 * d - 208 * e + 128) >> 8; g = g < 0 ? 0 : g > 255 ? 255 : g;
      let b = (298 * c + 516 * d + 128) >> 8; b = b < 0 ? 0 : b > 255 ? 255 : b;
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      if (r + g + b > 24) nonblack++;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
    }
  }
  console.log(`VIDEO: ${w}x${h}  RGBA bytes=${rgba.length}  nonblack=${((nonblack / (w * h)) * 100).toFixed(1)}%  Rrange=[${rmin},${rmax}]`);
  fs.writeFileSync(path.resolve(__dirname, "frame0.rgba"), rgba);
  console.log("  wrote build/frame0.rgba (raw RGBA, viewable e.g. in ffmpeg/ImageMagick)");

  // --- audio S16P -> float sanity-check ---
  const ch = audioFrameToFloat(af);
  let amin = 1, amax = -1, azero = 0;
  for (const plane of ch) for (let i = 0; i < plane.length; i++) {
    const s = plane[i]; if (s < amin) amin = s; if (s > amax) amax = s; if (s === 0) azero++;
  }
  const total = ch[0].length * ch.length;
  console.log(`AUDIO: fmt=${af.format} planes=${ch.length} nb=${af.nb_samples}  floatRange=[${amin.toFixed(3)},${amax.toFixed(3)}]  zeros=${((azero/total)*100).toFixed(1)}%`);

  const ok = w === 640 && h === 480 && nonblack > w * h * 0.05 && amax > 0.01 && ch.length === 2;
  console.log(ok ? "VERIFY_OK" : "VERIFY_FAIL");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("ERR", e); process.exit(2); });
