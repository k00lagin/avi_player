"use strict";

const DEFAULT_LIBAV_URL = "lib/libav-6.8.8.0-divx-mp3-avi.js";

const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;
const AV_SAMPLE_FMT_U8 = 0;
const AV_SAMPLE_FMT_S16 = 1;
const AV_SAMPLE_FMT_S32 = 2;
const AV_SAMPLE_FMT_FLT = 3;
const AV_SAMPLE_FMT_DBL = 4;
const AV_SAMPLE_FMT_U8P = 5;
const AV_SAMPLE_FMT_S16P = 6;
const AV_SAMPLE_FMT_S32P = 7;
const AV_SAMPLE_FMT_FLTP = 8;
const AV_SAMPLE_FMT_DBLP = 9;
const AVSEEK_FLAG_BACKWARD = 1;

let libavScriptPromise = null;

export function createAviPlayer(options) {
  return new AviPlayer(options);
}

export class AviPlayer {
  constructor(options = {}) {
    if (!options.canvas) throw new Error("AviPlayer requires a canvas option.");

    this.canvas = options.canvas;
    this.ctx2d = this.canvas.getContext("2d", { alpha: false });
    this.libavUrl = options.libavUrl || DEFAULT_LIBAV_URL;
    this.callbacks = {
      onStatus: options.onStatus || (() => {}),
      onMetadata: options.onMetadata || (() => {}),
      onTimeUpdate: options.onTimeUpdate || (() => {}),
      onEnded: options.onEnded || (() => {}),
      onError: options.onError || (() => {}),
    };

    this.libav = null;
    this.fileBytes = null;
    this.state = {
      ready: false,
      loaded: false,
      playing: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
      sampleRate: 0,
      audioChannels: 0,
      fileName: "",
    };

    this.res = {
      fmt_ctx: 0,
      streams: [],
      vi: -1,
      ai: -1,
      vctx: 0,
      vpkt: 0,
      vframe: 0,
      actx: 0,
      apkt: 0,
      aframe: 0,
      rpkt: 0,
    };

    this.vBaseTime = 0;
    this.aBaseTime = 0;
    this.audioResidual = null;
    this.vQueue = [];
    this.audioFeeds = [];
    this.audioCtx = null;
    this.gainNode = null;
    this.audioDisabled = false;
    this.activeSources = new Set();
    this.mediaStart = 0;
    this.wallStart = 0;
    this.eof = false;
    this.seekRequest = null;
    this.pumpPromise = null;
    this.pumping = false;
    this.generation = 0;
    this.rafId = 0;
    this.destroyed = false;

    this.setVolume(options.volume ?? 1);
  }

  async init() {
    if (this.state.ready) return;
    this._emitStatus("Loading decoder");
    await loadLibav(this.libavUrl);
    this.libav = await window.LibAV.LibAV();
    this.state.ready = true;
    this._emitStatus("Decoder ready", "ok");
  }

  async open(file, name = "") {
    if (!file) throw new Error("No AVI file provided.");
    if (!this.state.ready) await this.init();

    await this._resetPlayback(true);
    this.destroyed = false;
    const gen = ++this.generation;
    this._emitStatus("Reading file");

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.fileBytes = bytes;
      if (!this._isGeneration(gen)) return;

      await this.libav.writeFile("in.avi", bytes);
      this._emitStatus("Probing container");
      const [fmt_ctx, streams] = await this.libav.ff_init_demuxer_file("in.avi");
      if (!this._isGeneration(gen)) {
        await this.libav.avformat_close_input_js(fmt_ctx).catch(() => {});
        return;
      }

      this.res.fmt_ctx = fmt_ctx;
      this.res.streams = streams;
      this.res.vi = -1;
      this.res.ai = -1;
      for (const stream of streams) {
        if (stream.codec_type === AVMEDIA_TYPE_VIDEO && this.res.vi === -1) this.res.vi = stream.index;
        else if (stream.codec_type === AVMEDIA_TYPE_AUDIO && this.res.ai === -1) this.res.ai = stream.index;
      }
      if (this.res.vi === -1) throw new Error("No video stream found.");

      const vstream = streams[this.res.vi];
      const astream = this.res.ai >= 0 ? streams[this.res.ai] : null;
      const vcp = await this.libav.AVStream_codecpar(vstream.ptr);
      const [, vctx, vpkt, vframe] = await this.libav.ff_init_decoder(
        vstream.codec_id,
        { codecpar: vcp, time_base: getTimeBase(vstream) },
      );
      this.res.vctx = vctx;
      this.res.vpkt = vpkt;
      this.res.vframe = vframe;

      let sampleRate = 0;
      let audioChannels = 0;
      if (astream) {
        const acp = await this.libav.AVStream_codecpar(astream.ptr);
        const [, actx, apkt, aframe] = await this.libav.ff_init_decoder(
          astream.codec_id,
          { codecpar: acp, time_base: getTimeBase(astream) },
        );
        this.res.actx = actx;
        this.res.apkt = apkt;
        this.res.aframe = aframe;
        sampleRate = await this.libav.AVCodecContext_sample_rate(actx);
        audioChannels = await this.libav.AVCodecContext_channels(actx);
        if (!sampleRate) sampleRate = 44100;
      }
      this.res.rpkt = await this.libav.av_packet_alloc();

      const width = await this.libav.AVCodecContext_width(vctx);
      const height = await this.libav.AVCodecContext_height(vctx);
      const fps = computeFrameRate(vstream);
      const duration = await this._computeDuration(fmt_ctx, vstream, fps);

      this.canvas.width = width;
      this.canvas.height = height;
      this.vBaseTime = 0;
      this.aBaseTime = 0;
      this.mediaStart = 0;
      this.wallStart = 0;
      this.audioResidual = null;
      this.audioDisabled = false;
      this.vQueue.length = 0;
      this.audioFeeds.length = 0;
      this.eof = false;
      this.seekRequest = null;

      Object.assign(this.state, {
        loaded: true,
        playing: false,
        ended: false,
        currentTime: 0,
        duration,
        width,
        height,
        fps,
        hasAudio: !!astream,
        sampleRate,
        audioChannels,
        fileName: name || file.name || "",
      });

      this.callbacks.onMetadata(this.getState());
      this._emitTime();
      this._emitStatus("Ready", "ok");
      this._startPump(gen);
      this._startRaf();
    } catch (error) {
      await this._resetPlayback(true);
      this._emitError(error);
      throw error;
    }
  }

  async play() {
    if (!this.state.loaded) return;
    this._ensureAudioGraph();
    if (this.audioCtx) {
      await this._resumeAudioContext();
    }
    this.mediaStart = this.state.currentTime;
    this.wallStart = this.state.hasAudio && !this.audioDisabled && this.audioCtx ? this.audioCtx.currentTime : performance.now();
    this.state.playing = true;
    this.state.ended = false;
    this._emitStatus("Playing");
    this._scheduleAudio();
    this._emitTime();
  }

  pause() {
    if (!this.state.loaded || !this.state.playing) return;
    const t = this._currentMediaTime();
    this.state.currentTime = t;
    this.state.playing = false;
    this._stopActiveSources();
    if (this.audioCtx) {
      try { this.audioCtx.suspend(); } catch (_) {}
    }
    this._queueSeek(t, { silent: true });
    this._emitStatus("Paused");
    this._emitTime();
  }

  async toggle() {
    if (!this.state.loaded) return;
    if (this.state.ended) await this.seek(0);
    if (this.state.playing) this.pause();
    else await this.play();
  }

  async seek(seconds) {
    if (!this.state.loaded) return;
    const target = this._clampTime(seconds);
    await this._queueSeek(target, { silent: false });
  }

  setVolume(value) {
    const next = Math.min(1, Math.max(0, Number(value) || 0));
    this.volume = next;
    if (this.gainNode) this.gainNode.gain.value = next;
  }

  getState() {
    return Object.freeze({ ...this.state });
  }

  async destroy() {
    this.destroyed = true;
    await this._resetPlayback(true);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.state.ready = false;
  }

  async _computeDuration(fmt_ctx, vstream, fps) {
    let duration = 0;
    try {
      const du = Number(await this.libav.AVFormatContext_duration(fmt_ctx));
      if (Number.isFinite(du) && du > 0) duration = du / 1e6;
    } catch (_) {}
    if (!duration) duration = computeStreamDuration(vstream, fps);
    return duration || 0;
  }

  _startPump(gen) {
    if (this.pumpPromise) return;
    this.pumping = true;
    this.pumpPromise = this._pumpLoop(gen).finally(() => {
      this.pumping = false;
      this.pumpPromise = null;
    });
  }

  async _stopPump() {
    this.pumping = false;
    this.generation++;
    const pump = this.pumpPromise;
    if (pump) await pump.catch(() => {});
  }

  async _pumpLoop(gen) {
    const frameDur = this.state.fps > 0 ? 1 / this.state.fps : 1 / 29.97;
    while (this.pumping && this._isGeneration(gen) && this.res.fmt_ctx) {
      if (this.seekRequest) {
        const req = this.seekRequest;
        this.seekRequest = null;
        try {
          await this._doSeek(req.time, gen, req.silent);
          req.resolve();
        } catch (error) {
          req.reject(error);
        }
      }
      if (!this._isGeneration(gen)) return;

      const now = this._currentMediaTime();
      if (this.vQueue.length > 120) { await sleep(20); continue; }
      if (this.vBaseTime - now > 3.0) { await sleep(20); continue; }
      const queueAudio = this.state.hasAudio && !this.audioDisabled;
      if (queueAudio && this.aBaseTime - now > 2.5) { await sleep(20); continue; }

      if (this.eof) {
        if (this.vQueue.length === 0 && (!this.state.hasAudio || (this.audioFeeds.length === 0 && this._audioDone()))) {
          if (!this.state.ended) this._onEnd();
        }
        await sleep(60);
        continue;
      }

      try {
        const [res, packs] = await this.libav.ff_read_frame_multi(this.res.fmt_ctx, this.res.rpkt, { limit: 1 << 19 });
        if (!this._isGeneration(gen)) return;
        if (packs[this.res.vi] && packs[this.res.vi].length) await this._decodeVideo(packs[this.res.vi], frameDur, gen);
        if (queueAudio && packs[this.res.ai] && packs[this.res.ai].length) await this._decodeAudio(packs[this.res.ai], gen);
        if (res === this.libav.AVERROR_EOF) await this._flushDecoders(frameDur, gen);
      } catch (error) {
        if (!this._isGeneration(gen)) return;
        this._emitStatus("Decode error: " + (error.message || error), "err");
        this._emitError(error);
        await sleep(120);
      }
      await sleep(0);
    }
  }

  async _decodeVideo(packets, frameDur, gen, minTime = -Infinity) {
    const frames = await this.libav.ff_decode_multi(this.res.vctx, this.res.vpkt, this.res.vframe, packets, { copyoutFrame: "video" });
    if (!this._isGeneration(gen)) return;
    for (const frame of frames) {
      const mediaTime = this.vBaseTime;
      if (mediaTime >= minTime) this.vQueue.push({ t: mediaTime, image: frameToImageData(frame, this.ctx2d, this.state.width, this.state.height) });
      this.vBaseTime += frameDur;
    }
  }

  async _decodeAudio(packets, gen, minTime = -Infinity, schedule = true) {
    const frames = reframeMp3Packets(packets, this.audioResidual);
    this.audioResidual = frames.residual;
    if (!frames.frames.length) return;
    const decoded = await this.libav.ff_decode_multi(
      this.res.actx,
      this.res.apkt,
      this.res.aframe,
      frames.frames.map((data) => ({ data })),
    );
    if (!this._isGeneration(gen)) return;
    for (const frame of decoded) this._feedAudio(frame, minTime);
    if (schedule) this._scheduleAudio();
  }

  async _flushDecoders(frameDur, gen) {
    this.eof = true;
    try {
      const vf = await this.libav.ff_decode_multi(this.res.vctx, this.res.vpkt, this.res.vframe, [], { copyoutFrame: "video", fin: true });
      if (!this._isGeneration(gen)) return;
      for (const frame of vf) {
        this.vQueue.push({ t: this.vBaseTime, image: frameToImageData(frame, this.ctx2d, this.state.width, this.state.height) });
        this.vBaseTime += frameDur;
      }
      if (this.state.hasAudio) {
        const af = await this.libav.ff_decode_multi(this.res.actx, this.res.apkt, this.res.aframe, [], { fin: true });
        if (!this._isGeneration(gen)) return;
        for (const frame of af) this._feedAudio(frame);
        this.audioResidual = null;
        this._scheduleAudio();
      }
    } catch (_) {}
  }

  _feedAudio(frame, minTime = -Infinity) {
    const data = audioFrameToFloat(frame, this.state.sampleRate);
    if (!data || data.nb === 0) return;
    const mediaTime = this.aBaseTime;
    if (mediaTime + data.nb / data.rate >= minTime) {
      this.audioFeeds.push({ mediaTime, channels: data.channels, nb: data.nb, rate: data.rate });
    }
    this.aBaseTime += data.nb / data.rate;
  }

  _ensureAudioGraph() {
    if (!this.state.hasAudio || this.audioCtx || this.audioDisabled) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      this.audioDisabled = true;
      return;
    }
    try {
      this.audioCtx = new AudioContextCtor();
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.audioCtx.destination);
    } catch (_) {
      this.audioCtx = null;
      this.gainNode = null;
      this.audioDisabled = true;
    }
  }

  _scheduleAudio() {
    if (!this.state.hasAudio || this.audioDisabled || !this.audioCtx || !this.state.playing) return;
    const nowMedia = this._currentMediaTime();
    const lookahead = 1.0;
    while (this.audioFeeds.length && this.audioFeeds[0].mediaTime <= nowMedia + lookahead) {
      const audio = this.audioFeeds.shift();
      try {
        const buffer = this.audioCtx.createBuffer(audio.channels.length, audio.nb, audio.rate);
        for (let c = 0; c < audio.channels.length; c++) buffer.getChannelData(c).set(audio.channels[c]);
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        source.onended = () => {
          this.activeSources.delete(source);
          try { source.disconnect(); } catch (_) {}
        };
        this.activeSources.add(source);
        let scheduleAt = this.wallStart + (audio.mediaTime - this.mediaStart);
        if (scheduleAt < this.audioCtx.currentTime) scheduleAt = this.audioCtx.currentTime;
        source.start(scheduleAt);
      } catch (error) {
        this._emitStatus("Audio schedule error: " + (error.message || error), "err");
      }
    }
  }

  _stopActiveSources() {
    for (const source of this.activeSources) {
      try { source.onended = null; } catch (_) {}
      try { source.stop(0); } catch (_) {}
      try { source.disconnect(); } catch (_) {}
    }
    this.activeSources.clear();
  }

  _audioDone() {
    if (!this.audioCtx) return true;
    return this.audioCtx.currentTime - this.wallStart >= (this.aBaseTime - this.mediaStart) - 0.01;
  }

  _startRaf() {
    if (this.rafId) return;
    const tick = () => {
      this._presentFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _presentFrame() {
    if (!this.state.loaded) return;
    if (this.vQueue.length) {
      const now = this._currentMediaTime();
      while (this.vQueue.length >= 2 && this.vQueue[1].t <= now) this.vQueue.shift();
      const cur = this.vQueue[0];
      if (cur && cur.t <= now + 0.05) this.ctx2d.putImageData(cur.image, 0, 0);
    }

    const now = this._currentMediaTime();
    if (Number.isFinite(now)) {
      this.state.currentTime = now;
      this._emitTime();
    }
    this._scheduleAudio();
  }

  _currentMediaTime() {
    if (!this.state.playing) return this.state.currentTime;
    if (this.state.hasAudio && !this.audioDisabled && this.audioCtx) {
      return this.mediaStart + Math.max(0, this.audioCtx.currentTime - this.wallStart);
    }
    return this.mediaStart + (performance.now() - this.wallStart) / 1000;
  }

  _queueSeek(time, options = {}) {
    if (!this.state.loaded || !this.res.fmt_ctx) {
      this.state.currentTime = time;
      this._emitTime();
      return Promise.resolve();
    }
    if (this.seekRequest) this.seekRequest.resolve();
    return new Promise((resolve, reject) => {
      this.seekRequest = { time, silent: !!options.silent, resolve, reject };
    });
  }

  async _doSeek(time, gen, silent) {
    if (!this._isGeneration(gen) || !this.res.fmt_ctx) return;
    const wasPlaying = this.state.playing;
    this._stopActiveSources();
    let nativeSeekOk = false;
    try {
      if (typeof this.libav.avformat_seek_file === "function") {
        const us = Math.max(0, Math.round(time * 1000000));
        const ret = await this.libav.avformat_seek_file(this.res.fmt_ctx, -1, Math.max(0, us - 1000000), us, us + 1000000, AVSEEK_FLAG_BACKWARD);
        nativeSeekOk = ret >= 0;
      } else if (typeof this.libav.av_seek_frame === "function") {
        const ret = await this.libav.av_seek_frame(this.res.fmt_ctx, -1, Math.max(0, Math.round(time * 1000000)), AVSEEK_FLAG_BACKWARD);
        nativeSeekOk = ret >= 0;
      }
      if (typeof this.libav.avcodec_flush_buffers === "function") {
        await this.libav.avcodec_flush_buffers(this.res.vctx);
        if (this.state.hasAudio) await this.libav.avcodec_flush_buffers(this.res.actx);
      }
    } catch (error) {
      this._emitStatus("Seek failed: " + (error.message || error), "err");
    }

    if (!this._isGeneration(gen)) return;
    this.vQueue.length = 0;
    this.audioFeeds.length = 0;
    this.eof = false;
    this.state.ended = false;
    this.vBaseTime = time;
    this.aBaseTime = time;
    this.state.currentTime = time;
    this.mediaStart = time;
    this.audioResidual = null;
    this.audioDisabled = false;

    if (!nativeSeekOk) {
      if (time > 0) {
        await this._linearSeek(time, gen);
      } else {
        await this._reopenResources(gen);
        this.vQueue.length = 0;
        this.audioFeeds.length = 0;
        this.audioResidual = null;
        this.vBaseTime = 0;
        this.aBaseTime = 0;
      }
    }

    if (this.audioCtx && !this.audioDisabled) {
      if (wasPlaying) {
        await this._resumeAudioContext();
        this.wallStart = this.audioDisabled ? performance.now() : this.audioCtx.currentTime;
      } else {
        try { await this.audioCtx.suspend(); } catch (_) {}
      }
    } else {
      this.wallStart = performance.now();
    }
    if (!silent) this._emitStatus(time === 0 ? "Restarted" : "Seeked");
    if (wasPlaying) this._scheduleAudio();
    this._emitTime();
  }

  async _linearSeek(time, gen) {
    if (!this.fileBytes) return;
    const frameDur = this.state.fps > 0 ? 1 / this.state.fps : 1 / 29.97;
    await this._reopenResources(gen);
    if (!this._isGeneration(gen)) return;

    this.vQueue.length = 0;
    this.audioFeeds.length = 0;
    this.audioResidual = null;
    this.vBaseTime = 0;
    this.aBaseTime = 0;

    const minVideoTime = Math.max(0, time - frameDur);
    const minAudioTime = Math.max(0, time - 0.05);
    while (this._isGeneration(gen) && this.res.fmt_ctx) {
      if (this.vBaseTime >= time && (!this.state.hasAudio || this.audioDisabled || this.aBaseTime >= time)) break;
      const [res, packs] = await this.libav.ff_read_frame_multi(this.res.fmt_ctx, this.res.rpkt, { limit: 1 << 19 });
      if (!this._isGeneration(gen)) return;
      if (packs[this.res.vi] && packs[this.res.vi].length) await this._decodeVideo(packs[this.res.vi], frameDur, gen, minVideoTime);
      if (this.state.hasAudio && !this.audioDisabled && packs[this.res.ai] && packs[this.res.ai].length) await this._decodeAudio(packs[this.res.ai], gen, minAudioTime, false);
      if (res === this.libav.AVERROR_EOF) {
        this.eof = true;
        break;
      }
      if (this.vQueue.length > 30 && (!this.state.hasAudio || this.audioDisabled || this.audioFeeds.length > 10)) break;
      await sleep(0);
    }
  }

  async _reopenResources(gen) {
    await this._freeResources();
    if (!this._isGeneration(gen)) return;
    await this.libav.writeFile("in.avi", this.fileBytes);
    const [fmt_ctx, streams] = await this.libav.ff_init_demuxer_file("in.avi");
    if (!this._isGeneration(gen)) {
      await this.libav.avformat_close_input_js(fmt_ctx).catch(() => {});
      return;
    }

    this.res.fmt_ctx = fmt_ctx;
    this.res.streams = streams;
    this.res.vi = -1;
    this.res.ai = -1;
    for (const stream of streams) {
      if (stream.codec_type === AVMEDIA_TYPE_VIDEO && this.res.vi === -1) this.res.vi = stream.index;
      else if (stream.codec_type === AVMEDIA_TYPE_AUDIO && this.res.ai === -1) this.res.ai = stream.index;
    }
    const vstream = streams[this.res.vi];
    const astream = this.res.ai >= 0 ? streams[this.res.ai] : null;
    const vcp = await this.libav.AVStream_codecpar(vstream.ptr);
    const [, vctx, vpkt, vframe] = await this.libav.ff_init_decoder(
      vstream.codec_id,
      { codecpar: vcp, time_base: getTimeBase(vstream) },
    );
    this.res.vctx = vctx;
    this.res.vpkt = vpkt;
    this.res.vframe = vframe;

    if (astream) {
      const acp = await this.libav.AVStream_codecpar(astream.ptr);
      const [, actx, apkt, aframe] = await this.libav.ff_init_decoder(
        astream.codec_id,
        { codecpar: acp, time_base: getTimeBase(astream) },
      );
      this.res.actx = actx;
      this.res.apkt = apkt;
      this.res.aframe = aframe;
    }
    this.res.rpkt = await this.libav.av_packet_alloc();
  }

  async _freeResources() {
    try {
      if (this.res.vctx) await this.libav.ff_free_decoder(this.res.vctx, this.res.vpkt, this.res.vframe).catch(() => {});
      if (this.res.actx) await this.libav.ff_free_decoder(this.res.actx, this.res.apkt, this.res.aframe).catch(() => {});
      if (this.res.fmt_ctx) await this.libav.avformat_close_input_js(this.res.fmt_ctx).catch(() => {});
    } catch (_) {}
    this.res = {
      fmt_ctx: 0,
      streams: [],
      vi: -1,
      ai: -1,
      vctx: 0,
      vpkt: 0,
      vframe: 0,
      actx: 0,
      apkt: 0,
      aframe: 0,
      rpkt: 0,
    };
  }

  async _resetPlayback(freeResources) {
    await this._stopPump();
    this._stopActiveSources();
    if (this.audioCtx) {
      try { await this.audioCtx.close(); } catch (_) {}
      this.audioCtx = null;
      this.gainNode = null;
    }
    this.vQueue.length = 0;
    this.audioFeeds.length = 0;
    this.audioResidual = null;
    this.seekRequest = null;
    this.eof = false;
    this.vBaseTime = 0;
    this.aBaseTime = 0;
    this.mediaStart = 0;
    this.wallStart = 0;

    if (freeResources && this.libav) {
      await this._freeResources();
    } else {
      this.res = {
        fmt_ctx: 0,
        streams: [],
        vi: -1,
        ai: -1,
        vctx: 0,
        vpkt: 0,
        vframe: 0,
        actx: 0,
        apkt: 0,
        aframe: 0,
        rpkt: 0,
      };
    }

    Object.assign(this.state, {
      loaded: false,
      playing: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
      sampleRate: 0,
      audioChannels: 0,
      fileName: "",
    });
  }

  _onEnd() {
    this.state.currentTime = this._currentMediaTime();
    this.state.playing = false;
    this.state.ended = true;
    this._stopActiveSources();
    this._emitStatus("Ended", "ok");
    this.callbacks.onEnded(this.getState());
  }

  _clampTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return this.state.duration > 0 ? Math.min(this.state.duration, value) : value;
  }

  _isGeneration(gen) {
    return !this.destroyed && this.generation === gen;
  }

  _emitStatus(message, level = "") {
    this.callbacks.onStatus(message, level);
  }

  _emitTime() {
    this.callbacks.onTimeUpdate(this.getState());
  }

  _emitError(error) {
    this.callbacks.onError(error, this.getState());
  }

  async _resumeAudioContext() {
    if (!this.audioCtx || this.audioDisabled) return;
    try {
      const resumed = await Promise.race([
        this.audioCtx.resume().then(() => true),
        sleep(250).then(() => false),
      ]);
      if (!resumed && this.audioCtx.state !== "running") {
        this.audioDisabled = true;
        this.audioFeeds.length = 0;
        this._stopActiveSources();
      }
    } catch (_) {}
  }
}

async function loadLibav(url) {
  if (window.LibAV) {
    setLibavBase(url);
    return;
  }
  if (!libavScriptPromise) {
    libavScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => {
        setLibavBase(url);
        resolve();
      };
      script.onerror = () => reject(new Error("Could not load " + url));
      document.head.appendChild(script);
    });
  }
  await libavScriptPromise;
}

function setLibavBase(url) {
  if (window.LibAV && !window.LibAV.base) {
    window.LibAV.base = url.substring(0, url.lastIndexOf("/") + 1);
  }
}

function getTimeBase(stream) {
  if (Array.isArray(stream.time_base)) return stream.time_base;
  return [stream.time_base_num || 1, stream.time_base_den || 1];
}

export function computeFrameRate(stream) {
  const avg = rational(stream.avg_frame_rate_num, stream.avg_frame_rate_den);
  if (avg) return avg;
  const rate = rational(stream.r_frame_rate_num, stream.r_frame_rate_den);
  if (rate) return rate;
  if (Array.isArray(stream.avg_frame_rate)) {
    const r = rational(stream.avg_frame_rate[0], stream.avg_frame_rate[1]);
    if (r) return r;
  }
  if (Array.isArray(stream.r_frame_rate)) {
    const r = rational(stream.r_frame_rate[0], stream.r_frame_rate[1]);
    if (r) return r;
  }
  return rational(stream.time_base_den, stream.time_base_num) || 0;
}

export function computeStreamDuration(stream, fps = 0) {
  const duration = Number(stream.duration);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isInteger(duration)) return duration;

  const tb = getTimeBase(stream);
  if (tb[0] > 0 && tb[1] > 0) return duration * tb[0] / tb[1];
  if (fps > 0) return duration / fps;
  return 0;
}

function rational(num, den) {
  const n = Number(num);
  const d = Number(den);
  return Number.isFinite(n) && Number.isFinite(d) && n > 0 && d > 0 ? n / d : 0;
}

function reframeMp3Packets(packets, residual) {
  let total = residual ? residual.length : 0;
  for (const packet of packets) total += packet.data ? packet.data.length : 0;
  const stream = new Uint8Array(total);
  let offset = 0;
  if (residual) {
    stream.set(residual, 0);
    offset = residual.length;
  }
  for (const packet of packets) {
    if (packet.data && packet.data.length) {
      stream.set(packet.data, offset);
      offset += packet.data.length;
    }
  }

  const frames = [];
  let i = 0;
  while (i + 4 <= stream.length) {
    const size = mp3FrameLength(stream, i);
    if (size <= 0) {
      i++;
      continue;
    }
    if (i + size > stream.length) break;
    frames.push(new Uint8Array(stream.subarray(i, i + size)));
    i += size;
  }
  return {
    frames,
    residual: i < stream.length ? new Uint8Array(stream.subarray(i)) : null,
  };
}

export function mp3FrameLength(buf, i) {
  if (i + 4 > buf.length) return -1;
  const b1 = buf[i + 1];
  if (buf[i] !== 0xFF || (b1 & 0xE0) !== 0xE0) return -1;
  const ver = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (ver === 1 || layer !== 1) return -1;
  const b2 = buf[i + 2];
  const brIdx = (b2 >> 4) & 0xF;
  const srIdx = (b2 >> 2) & 3;
  const pad = (b2 >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return -1;
  const br1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const br2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const sr1 = [44100, 48000, 32000, 0];
  const sr2 = [22050, 24000, 16000, 0];
  const sr25 = [11025, 12000, 8000, 0];
  let kbps;
  let sr;
  if (ver === 3) {
    kbps = br1[brIdx];
    sr = sr1[srIdx];
  } else if (ver === 2) {
    kbps = br2[brIdx];
    sr = sr2[srIdx];
  } else {
    kbps = br2[brIdx];
    sr = sr25[srIdx];
  }
  if (!kbps || !sr) return -1;
  const coeff = ver === 3 ? 144 : 72;
  const size = Math.floor(coeff * kbps * 1000 / sr) + pad;
  return size > 0 ? size : -1;
}

function frameToImageData(frame, ctx2d, fallbackWidth, fallbackHeight) {
  const w = frame.width || fallbackWidth;
  const h = frame.height || fallbackHeight;
  const data = frame.data;
  const layout = frame.layout;
  const yO = layout[0].offset;
  const yS = layout[0].stride;
  const uO = layout[1].offset;
  const uS = layout[1].stride;
  const vO = layout[2].offset;
  const vS = layout[2].stride;
  const image = ctx2d.createImageData(w, h);
  const out32 = new Uint32Array(image.data.buffer);
  for (let y = 0; y < h; y++) {
    const yRow = yO + y * yS;
    const uvRow = y >> 1;
    const uRow = uO + uvRow * uS;
    const vRow = vO + uvRow * vS;
    let out = y * w;
    for (let x = 0; x < w; x++) {
      const Y = data[yRow + x];
      const U = data[uRow + (x >> 1)];
      const V = data[vRow + (x >> 1)];
      const c = Y - 16;
      const d = U - 128;
      const e = V - 128;
      const r = (298 * c + 409 * e + 128) >> 8;
      const g = (298 * c - 100 * d - 208 * e + 128) >> 8;
      const b = (298 * c + 516 * d + 128) >> 8;
      out32[out++] = 0xff000000 |
        (clampByte(b) << 16) |
        (clampByte(g) << 8) |
        clampByte(r);
    }
  }
  return image;
}

function audioFrameToFloat(frame, fallbackRate) {
  const fmt = frame.format;
  const nb = frame.nb_samples;
  const ch = frame.channels || 1;
  const planes = frame.data;
  if (!planes || !planes.length || !nb) return null;

  const planar = fmt === AV_SAMPLE_FMT_U8P ||
    fmt === AV_SAMPLE_FMT_S16P ||
    fmt === AV_SAMPLE_FMT_S32P ||
    fmt === AV_SAMPLE_FMT_FLTP ||
    fmt === AV_SAMPLE_FMT_DBLP;
  const out = [];

  if (planar) {
    for (let c = 0; c < ch; c++) out.push(convertAudioPlane(planes[c], fmt, nb, 0, 1));
  } else {
    const plane = planes[0];
    for (let c = 0; c < ch; c++) out.push(convertAudioPlane(plane, fmt, nb, c, ch));
  }

  return { channels: out, nb, rate: frame.sample_rate || fallbackRate || 44100, ch };
}

function convertAudioPlane(plane, fmt, count, offset, stride) {
  const out = new Float32Array(count);
  if (fmt === AV_SAMPLE_FMT_FLTP || fmt === AV_SAMPLE_FMT_FLT) {
    const view = new Float32Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) out[i] = view[i * stride + offset];
  } else if (fmt === AV_SAMPLE_FMT_DBLP || fmt === AV_SAMPLE_FMT_DBL) {
    const view = new Float64Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) out[i] = view[i * stride + offset];
  } else if (fmt === AV_SAMPLE_FMT_S16P || fmt === AV_SAMPLE_FMT_S16) {
    const view = new Int16Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) out[i] = view[i * stride + offset] / 32768;
  } else if (fmt === AV_SAMPLE_FMT_S32P || fmt === AV_SAMPLE_FMT_S32) {
    const view = new Int32Array(plane.buffer, plane.byteOffset, count * stride);
    for (let i = 0; i < count; i++) out[i] = view[i * stride + offset] / 2147483648;
  } else if (fmt === AV_SAMPLE_FMT_U8P || fmt === AV_SAMPLE_FMT_U8) {
    for (let i = 0; i < count; i++) out[i] = (plane[i * stride + offset] - 128) / 128;
  } else {
    throw new Error("Unsupported audio sample format: " + fmt);
  }
  return out;
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __testing = {
  computeFrameRate,
  computeStreamDuration,
  mp3FrameLength,
};
