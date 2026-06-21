// Smoke test: load the custom libav.js variant in node, demux 1.avi,
// decode a few DivX frames + MP3 frames. Confirms the build decodes our files.
const path = require("path");
const fs = require("fs");

const LIB = path.resolve(__dirname, "..", "lib", "libav-6.8.8.0-divx-mp3-avi.js");
process.chdir(path.dirname(LIB));
require(LIB);

const AVI = samplePath("1.avi");

function samplePath(name) {
  const direct = path.resolve(__dirname, "..", name);
  if (fs.existsSync(direct)) return direct;
  return path.resolve(__dirname, "..", "test files", name);
}

function timeBase(stream) {
  return [stream.time_base_num || 1, stream.time_base_den || 1];
}

(async () => {
  const t0 = Date.now();
  console.log("loading libav.js...");
  const libav = await LibAV.LibAV({ noworker: true });
  console.log("loaded in", Date.now() - t0, "ms; mode=", libav.libavjsMode);

  const bytes = new Uint8Array(fs.readFileSync(AVI));
  console.log("avi bytes:", bytes.length);
  await libav.writeFile("in.avi", bytes);

  const [fmt, streams] = await libav.ff_init_demuxer_file("in.avi");
  console.log("streams:", streams.length);
  let v = null, a = null;
  for (const s of streams) {
    console.log("  stream", s.index, "type", s.codec_type, "codec_id", s.codec_id);
    if (s.codec_type === 0 && !v) v = s;
    else if (s.codec_type === 1 && !a) a = s;
  }
  if (!v) throw new Error("no video stream");

  const vcp = await libav.AVStream_codecpar(v.ptr);
  const [, vctx, vpkt, vframe] = await libav.ff_init_decoder(
    v.codec_id, { codecpar: vcp, time_base: timeBase(v) });
  console.log("video decoder ready; tb=", timeBase(v));

  let actx = null, apkt = null, aframe = null;
  if (a) {
    const acp = await libav.AVStream_codecpar(a.ptr);
    [, actx, apkt, aframe] = await libav.ff_init_decoder(
      a.codec_id, { codecpar: acp, time_base: timeBase(a) });
    const rate = await libav.AVCodecContext_sample_rate(actx);
    const ch = await libav.AVCodecContext_channels(actx);
    console.log("audio decoder ready; tb=", timeBase(a), "rate=", rate, "ch=", ch);
  }

  const rpkt = await libav.av_packet_alloc();
  let vDecoded = 0, aDecoded = 0, firstVideoFrame = null;
  const targetV = 5, targetA = 1;
  while (vDecoded < targetV || (a && aDecoded < targetA)) {
    const [res, packs] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 1 << 20 });
    if (packs[v.index] && packs[v.index].length) {
      const frs = await libav.ff_decode_multi(vctx, vpkt, vframe, packs[v.index], { copyoutFrame: "video" });
      for (const f of frs) {
        vDecoded++;
        if (!firstVideoFrame) firstVideoFrame = f;
        if (vDecoded <= 5) console.log(`  video frame ${vDecoded}: ${f.width}x${f.height} fmt=${f.format} pts=${f.pts}`);
      }
    }
    if (a && packs[a.index] && packs[a.index].length) {
      const frs = await libav.ff_decode_multi(actx, apkt, aframe, packs[a.index]);
      for (const f of frs) {
        aDecoded++;
        if (aDecoded <= 2)
          console.log(`  audio frame ${aDecoded}: fmt=${f.format} nb=${f.nb_samples} rate=${f.sample_rate} ch=${f.channels} pts=${f.pts}`);
      }
    }
    if (res === libav.AVERROR_EOF) break;
  }

  console.log(`\nRESULT: decoded ${vDecoded} video frames, ${aDecoded} audio frames in ${Date.now() - t0}ms`);
  if (firstVideoFrame && firstVideoFrame.width && firstVideoFrame.height) {
    console.log("first video frame dimensions:", firstVideoFrame.width, "x", firstVideoFrame.height, "format", firstVideoFrame.format);
    console.log("SMOKE_TEST_OK");
  } else {
    console.log("SMOKE_TEST_FAIL no video frame decoded");
    process.exit(1);
  }
})().catch(e => { console.error("SMOKE_TEST_ERROR", e); process.exit(2); });
