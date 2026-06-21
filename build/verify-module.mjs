// Verifies pure helpers exported by the browser ESM without adding package.json.
import fs from "node:fs";
import path from "node:path";

const modulePath = path.resolve("src", "avi-player.js");
const source = fs.readFileSync(modulePath, "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const { computeFrameRate, computeStreamDuration, mp3FrameLength } = mod.__testing;

const fps = computeFrameRate({ time_base_num: 100, time_base_den: 2997 });
const normalizedDuration = computeStreamDuration({ duration: 146.01267934601267, time_base_num: 100, time_base_den: 2997 }, fps);
const tickDuration = computeStreamDuration({ duration: 2997, time_base_num: 100, time_base_den: 2997 }, fps);
const mp3Size = mp3FrameLength(Uint8Array.from([0xff, 0xfb, 0x90, 0x64]), 0);

const ok = Math.abs(fps - 29.97) < 0.0001 &&
  Math.abs(normalizedDuration - 146.01267934601267) < 0.000001 &&
  Math.abs(tickDuration - 100) < 0.000001 &&
  mp3Size === 417;

console.log(`fps=${fps.toFixed(3)} normalizedDuration=${normalizedDuration.toFixed(3)} tickDuration=${tickDuration.toFixed(3)} mp3Size=${mp3Size}`);
console.log(ok ? "MODULE_VERIFY_OK" : "MODULE_VERIFY_FAIL");
process.exit(ok ? 0 : 1);
