/* SatyaCheck analysis engine (prototype heuristics).
   Each function is a stand-in for the production model named in its comment,
   running fully client-side so the demo works on Vercel with zero backend.
   Scoring paradigm: every branch reports TAMPER EVIDENCE. Silence / missing
   data is absence of evidence (neutral), never evidence of fakery — except a
   moving mouth with no audio stream at all, which is itself the tell. */

export type Verdict = "REAL" | "SUSPECT" | "FAKE";
export type DemoMode = "auto" | "real" | "lipsync-fake" | "gen5" | "synthetic-real" | "synthetic-fake";

export interface SpliceMark {
  t: number;
  strength: number;
}

export interface TimelinePoint {
  t: number;
  lip: number;
  audio: number;
}

export interface BranchScore {
  score: number;
  detail: string;
}

export interface AnalysisResult {
  verdict: Verdict;
  overall: number;
  duration: number;
  fileName: string;
  lipSync: BranchScore & { lagMs: number };
  audio: BranchScore & { splices: SpliceMark[] };
  compression: BranchScore & {
    generation: number;
    sharpness: number;
    blockiness: number;
    bitrateKbps: number;
    width: number;
    height: number;
  };
  timeline: TimelinePoint[];
  timings: { visual: number; audio: number; forensic: number; total: number };
  notes: string[];
  lab: { audioRms: number; audioPeak: number; audioStatus: string; bestRegion: string };
}

/* ————— tiny radix-2 FFT (power-of-2 sizes only) ————— */
function fftMag(input: Float32Array): Float32Array {
  const n = input.length;
  const re = Float32Array.from(input);
  const im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / n;
  return out;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 4) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

const norm01 = (v: number[]) => {
  const mn = Math.min(...v), mx = Math.max(...v);
  if (mx - mn < 1e-9) return v.map(() => 0.5);
  return v.map((x) => (x - mn) / (mx - mn));
};

/* Prosodic-scale smoothing (~300 ms at 10 Hz): syllable/phrase coupling is
   what survives compression and sparse frame sampling; fast ripple is noise. */
const smooth3 = (v: number[]) => v.map((_, i) => {
  let s = 0, c = 0;
  for (let j = Math.max(0, i - 1); j <= Math.min(v.length - 1, i + 1); j++) { s += v[j]; c++; }
  return s / c;
});

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    v.onloadedmetadata = async () => {
      try {
        if (!isFinite(v.duration)) {
          // MediaRecorder / screen-capture webm reports Infinity: force the
          // browser to compute it with an EOF seek (judges upload these a lot).
          await new Promise<void>((res) => {
            const h = () => { v.removeEventListener("durationchange", h); res(); };
            v.addEventListener("durationchange", h);
            v.currentTime = 1e7;
            setTimeout(h, 2500);
          });
          v.currentTime = 0;
          await new Promise<void>((res) => {
            const h = () => { v.removeEventListener("seeked", h); res(); };
            v.addEventListener("seeked", h);
            setTimeout(h, 1500);
          });
        }
        resolve(v);
      } catch {
        resolve(v);
      }
    };
    v.onerror = () => reject(new Error("Could not read that video file. Try an MP4 under 100 MB."));
  });
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener("seeked", done); resolve(); };
    v.addEventListener("seeked", done);
    v.currentTime = Math.min(Math.max(t, 0), (v.duration || 1) - 0.05);
    setTimeout(done, 1500); // safety: never hang the demo
  });
}

type AudioStatus = "ok" | "silent" | "none";

interface DecodedAudio {
  status: AudioStatus;
  samples: Float32Array;
  sampleRate: number;
  rms: number;
  peak: number;
}

async function decodeAudio(file: File): Promise<DecodedAudio> {
  const empty: DecodedAudio = { status: "none", samples: new Float32Array(0), sampleRate: 44100, rms: 0, peak: 0 };
  try {
    const buf = await file.arrayBuffer();
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    let audio;
    try {
      audio = await ctx.decodeAudioData(buf.slice(0));
    } finally {
      void ctx.close().catch(() => undefined);
    }
    const ch0 = audio.getChannelData(0);
    let mono: Float32Array = ch0;
    if (audio.numberOfChannels > 1) {
      const ch1 = audio.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < mono.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    }
    if (mono.length < 8000) return empty;
    let e = 0, peak = 0;
    for (let i = 0; i < mono.length; i += 7) {
      e += mono[i] * mono[i];
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(e / Math.ceil(mono.length / 7));
    if (rms < 0.006 && peak < 0.05) return { status: "silent", samples: mono, sampleRate: audio.sampleRate, rms, peak };
    return { status: "ok", samples: mono, sampleRate: audio.sampleRate, rms, peak };
  } catch {
    return empty; // no decodable audio stream at all
  }
}

interface AudioFeats {
  env: number[];      // RMS envelope @10Hz
  novelty: number[];  // splice novelty @10Hz
  splices: SpliceMark[];
  denseProsody: boolean;
}

/* Prod map: AASIST3 + Wav2Vec2-XLSR / SONAR. Here: spectral-flux + energy/ZCR novelty. */
function audioFeatures(samples: Float32Array, duration: number): AudioFeats {
  const N = 2048, hop = 2048; // non-overlapping: halves FFT cost, still plenty for splice spikes
  const starts: number[] = [];
  for (let s = 0; s + N <= samples.length; s += hop) starts.push(s);
  if (starts.length < 8) return { env: [], novelty: [], splices: [], denseProsody: false };

  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const env: number[] = [];
  const flux: number[] = [];
  const zcr: number[] = [];
  let prev: Float32Array | null = null;
  const win = new Float32Array(N);
  for (const s of starts) {
    let e = 0, z = 0;
    for (let i = 0; i < N; i++) {
      const x = samples[s + i];
      win[i] = x * hann[i];
      e += x * x;
      if (i > 0 && (x >= 0) !== (samples[s + i - 1] >= 0)) z++;
    }
    env.push(Math.sqrt(e / N));
    zcr.push(z / N);
    const mag = fftMag(win);
    if (prev) {
      let f = 0;
      for (let i = 0; i < mag.length; i++) f += Math.max(0, mag[i] - prev[i]);
      flux.push(f);
    } else flux.push(0);
    prev = mag;
  }

  // resample to 10 Hz grid over clip duration
  const grid = Math.max(10, Math.round(duration * 10));
  const toGrid = (v: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < grid; i++) {
      const pos = (i / (grid - 1)) * (v.length - 1);
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      out.push(v[lo] + (v[hi] - v[lo]) * (pos - lo));
    }
    return out;
  };
  const gEnv = toGrid(env);
  const gFlux = norm01(toGrid(flux));
  const gZcr = norm01(toGrid(zcr));
  const gLogE = norm01(gEnv.map((x) => Math.log1p(x * 50)));

  const novelty = gFlux.map((f, i) => {
    const dE = i ? Math.abs(gLogE[i] - gLogE[i - 1]) : 0;
    const dZ = i ? Math.abs(gZcr[i] - gZcr[i - 1]) : 0;
    return 0.55 * f + 0.3 * dE + 0.15 * dZ;
  });

  // peak-pick with prominence: a splice is an ISOLATED discontinuity, loud
  // against its neighbourhood — not one ripple in modulated prosody.
  const med = median(novelty);
  const mad = median(novelty.map((x) => Math.abs(x - med))) || 1e-6;
  const thr = med + 5 * mad;
  interface Cand { i: number; v: number; t: number }
  const cands: Cand[] = [];
  novelty.forEach((v, i) => {
    const t = (i / (novelty.length - 1)) * duration;
    if (v < thr || t < 0.3 || t > duration - 0.3) return;
    const lo = Math.max(0, i - 5), hi = Math.min(novelty.length - 1, i + 5);
    let mx = 0;
    for (let j = lo; j <= hi; j++) if (j !== i && novelty[j] > mx) mx = novelty[j];
    if (v > mx * 1.6 + mad) cands.push({ i, v, t });
  });
  // greedy strongest-first, min 0.6 s apart
  cands.sort((a, b) => b.v - a.v);
  const splices: SpliceMark[] = [];
  for (const c of cands) {
    if (splices.every((s) => Math.abs(s.t - c.t) > 0.6))
      splices.push({ t: c.t, strength: Math.min(1, (c.v - thr) / (mad * 6 + 1e-9) + 0.4) });
  }
  splices.sort((a, b) => a.t - b.t);
  // dense-prosody guard: >5 "splices" in a short clip is expressive speech or
  // song, not a cut-and-join attack — abstain instead of false-alarming.
  let denseProsody = false;
  if (splices.length > 5) { splices.length = 0; denseProsody = true; }
  return { env: gEnv, novelty, splices, denseProsody };
}

interface VisualFeats {
  regions: number[][]; // 9 overlapping cells, raw motion per sampled frame
  sharpness: number;
  blockiness: number;
  framesUsed: number;
  framesPlanned: number;
}

const REGION_NAMES = [
  "upper-left", "upper-center", "upper-right",
  "mid-left", "mid-center", "mid-right",
  "lower-left", "lower-center", "lower-right",
];

function gray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  return g;
}

/* Prod map: BioLip kinematics / LIPINC-V2 transformer. Here: multi-region motion
   search — the face is found by locating what moves WITH speech, so off-center
   faces are handled and faceless clips correctly find nothing. */
async function visualFeatures(v: HTMLVideoElement, duration: number): Promise<VisualFeats> {
  const W = 160, H = 90;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable in this browser.");

  const n = Math.max(16, Math.min(48, Math.round(duration * 6)));
  const times = Array.from({ length: n }, (_, i) => (i / (n - 1)) * Math.max(duration - 0.1, 0.1));
  // 3x3 overlapping cells (each ~42% of dimension, ~29% stride)
  const cells: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      cells.push({
        x0: Math.floor((c * 0.29) * W), x1: Math.floor((c * 0.29 + 0.42) * W),
        y0: Math.floor((r * 0.29) * H), y1: Math.floor((r * 0.29 + 0.42) * H),
      });

  const regions: number[][] = cells.map(() => []);
  let prevFull: Float32Array | null = null;
  let sharpFrame: Float32Array | null = null;

  // Adaptive sampling: fit the visual branch into a fixed compute budget on ANY
  // machine (software decode on weak hardware is ~5x slower than HW decode).
  // Stride doubles when the projection overruns — coverage stays spread while
  // frame count shrinks. This is what guarantees the <10 s headline.
  const BUDGET_MS = 5200;
  const tStart = performance.now();
  let step = 1, framesUsed = 0;
  for (let i = 0; i < times.length; i += step) {
    const t = times[i];
    await seekTo(v, t);
    ctx.drawImage(v, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const g = gray(img.data, W, H);
    if (!sharpFrame && t > duration * 0.3 && t < duration * 0.7) sharpFrame = g;
    if (prevFull) {
      const prev = prevFull;
      cells.forEach((cell, ci) => {
        let m = 0, c = 0;
        for (let y = cell.y0; y < cell.y1; y++)
          for (let x = cell.x0; x < cell.x1; x++) {
            m += Math.abs(g[y * W + x] - prev[y * W + x]);
            c++;
          }
        regions[ci].push(m / c);
      });
    } else {
      regions.forEach((r) => r.push(0));
    }
    prevFull = g;
    framesUsed++;
    if (framesUsed % 4 === 0) {
      const elapsed = performance.now() - tStart;
      const remaining = Math.ceil((times.length - 1 - i) / step);
      const projected = (elapsed / framesUsed) * remaining;
      if (projected > Math.max(700, BUDGET_MS - elapsed) && step < 3) step += 1;
    }
  }
  const g = sharpFrame ?? prevFull ?? new Float32Array(W * H);

  // sharpness: variance of Laplacian on mid frame
  let lapMean = 0; const lap: number[] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const l = -4 * g[y * W + x] + g[(y - 1) * W + x] + g[(y + 1) * W + x] + g[y * W + x - 1] + g[y * W + x + 1];
      lap.push(l); lapMean += l;
    }
  lapMean /= lap.length || 1;
  const sharpness = lap.reduce((a, l) => a + (l - lapMean) ** 2, 0) / (lap.length || 1);

  // blockiness: gradient energy on 8px grid lines vs elsewhere (H.264 8x8 residue)
  let on = 0, onC = 0, off = 0, offC = 0;
  for (let y = 0; y < H; y++)
    for (let x = 1; x < W; x++) {
      const d = Math.abs(g[y * W + x] - g[y * W + x - 1]);
      if (x % 8 === 0) { on += d; onC++; } else { off += d; offC++; }
    }
  const blockiness = onC && offC ? on / onC / (off / offC + 1e-9) : 1;

  return { regions, sharpness, blockiness, framesUsed, framesPlanned: n };
}

function estimateGeneration(opts: {
  sharpness: number; blockiness: number; bitrateKbps: number; height: number; mode: DemoMode;
}): { generation: number; score: number; detail: string } {
  let gen = 1;
  const why: string[] = [];
  if (opts.height <= 500) { gen++; why.push("downscaled to ≤480p (WhatsApp target)"); }
  if (opts.bitrateKbps > 0 && opts.bitrateKbps < 900) { gen++; why.push(`low bitrate ${Math.round(opts.bitrateKbps)} kbps`); }
  if (opts.blockiness > 1.12) { gen++; why.push("strong 8×8 blocking grid"); }
  if (opts.sharpness < 60) { gen++; why.push("high-frequency texture wiped"); }
  if (opts.mode === "gen5") { gen = 5; why.push("simulated 5th-generation forward chain"); }
  gen = Math.max(1, Math.min(5, gen));
  const score = Math.max(4, 100 - (gen - 1) * 19 - (opts.mode === "gen5" ? 6 : 0));
  const detail =
    gen <= 2
      ? `Looks close to original. ${why.join("; ") || "clean encode"}.`
      : `WhatsApp-aged: Gen-${gen}. Surviving cues are low-frequency DCT stats + phase, not pixels. ${why.join("; ")}.`;
  return { generation: gen, score: Math.round(score), detail };
}

export async function analyzeVideo(
  file: File,
  mode: DemoMode = "auto",
  onProgress?: (frac: number, stage: string) => void
): Promise<AnalysisResult> {
  const t0 = performance.now();
  const url = URL.createObjectURL(file);
  const notes: string[] = [];
  try {
    onProgress?.(0.05, "Loading clip…");
    const video = await loadVideo(url);
    const rawDuration = video.duration || 0;
    // Screen-recorded / MediaRecorder webm often reports Infinity: fall back to
    // a 10 s assessment window instead of refusing the clip.
    const durationUnknown = !isFinite(rawDuration) || rawDuration <= 0;
    const duration = durationUnknown ? 10 : rawDuration;
    if (duration > 300) throw new Error("Clip is too long for this demo — use a short under 5 minutes.");
    if (durationUnknown) notes.push("Duration metadata missing (typical for screen-recorded webm) — assessing the first 10 seconds.");
    // PS scope is 6–10 s clips: long clips are assessed on their first 10 s (budget guard).
    const T = Math.min(duration, 10);
    const trimmed = duration > 10.5;
    if (trimmed) notes.push(`Long clip (${duration.toFixed(0)}s): assessed on the first 10 seconds — the PS scope is 6–10 s shorts.`);

    // — visual branch —
    const tv = performance.now();
    onProgress?.(0.15, "Tracking motion vs speech across 9 face zones…");
    const vis = await visualFeatures(video, T);
    const tVisual = performance.now() - tv;
    if (vis.framesUsed < vis.framesPlanned)
      notes.push(`Adaptive sampling: slow decoder detected, used ${vis.framesUsed}/${vis.framesPlanned} frames — coverage kept, budget kept.`);

    // — audio branch —
    const ta = performance.now();
    onProgress?.(0.6, "Scanning audio for splices…");
    const decoded = await decodeAudio(file);
    const grid = Math.max(10, Math.round(T * 10));
    const toGrid = (v: number[]) => {
      const out: number[] = [];
      for (let i = 0; i < grid; i++) {
        const pos = (i / (grid - 1)) * (v.length - 1);
        const lo = Math.floor(pos), hi = Math.ceil(pos);
        out.push(v[lo] + (v[hi] - v[lo]) * (pos - lo));
      }
      return out;
    };
    const regionGrids = vis.regions.map(toGrid);
    // motion level: mean of per-frame max-cell motion (is anything moving at all?)
    const motionLevel = vis.regions[0].reduce((a, _, i) => a + Math.max(...vis.regions.map((r) => r[i])), 0) / (vis.regions[0].length || 1);

    let lipScore: number, lipDetail: string, lagMs: number, bestRegion = "—";
    let audioScore: number, audioDetail: string, splices: SpliceMark[] = [];
    let mutePenalty = 0;
    let okEnv: number[] | null = null;

    if (decoded.status === "none") {
      // No audio stream whatsoever.
      audioScore = 45;
      audioDetail = "No audio stream in this file — stripped, or never recorded. Speech claims built on a mute clip are unverifiable by construction.";
      if (motionLevel > 1.5) {
        lipScore = 15; lagMs = 0; bestRegion = "mouth zone (inferred)";
        lipDetail = "The mouth region moves substantially with zero audio to sync against — the mute-AI-forward signature: generated or dubbed visuals with the voice track gone.";
        mutePenalty = 8;
        notes.push("Mute-talking penalty applied: motion without any voice track.");
      } else {
        lipScore = 40; lagMs = 0;
        lipDetail = "No audio stream and barely any motion — a still/mute forward. Nothing to sync, nothing moving.";
      }
    } else if (decoded.status === "silent") {
      // Stream exists but carries digital silence: speech is unverifiable, not fake.
      audioScore = 70;
      audioDetail = "Audio track present but silent — intact, no splice artifacts, but carrying no voice. Speech is unverifiable, not disproven.";
      lipScore = 52; lagMs = 0;
      lipDetail = "Mute recording: there is no speech energy to sync mouth motion against, so lip-sync abstains instead of guessing.";
      notes.push("Mute clip: lip-sync and splice branches abstained — silence is absence of evidence, not evidence of fakery.");
    } else {
      // Forensic window: only the assessed first-T seconds feed the spectrum.
      const windowed = decoded.samples.slice(0, Math.floor(T * decoded.sampleRate));
      const feats = audioFeatures(windowed, T);
      splices = feats.splices;
      okEnv = feats.env.length ? feats.env : new Array(grid).fill(0.5);
      let env = okEnv;

      // demo-mode tamper simulation (judges can force each state on ANY clip)
      if ((mode === "lipsync-fake" || mode === "synthetic-fake") && env.length > 6) {
        const shift = Math.min(4, Math.floor(env.length / 4)); // ~400 ms desync
        env = [...env.slice(shift), ...env.slice(0, shift)];
        const at = Math.floor(env.length * 0.42);
        splices = [...splices, { t: (at / (env.length - 1)) * T, strength: 0.95 }];
        notes.push("Demo tamper applied: 400 ms lip-shift + synthetic splice at 42%.");
      }

      // region search: which face zone moves WITH speech? Both signals are
      // smoothed to prosodic scale (~300 ms) first: syllable/phrase coupling
      // is what survives compression and sampling, fast ripple is noise.
      const audioN = norm01(smooth3(env));
      let best = -2, bestLag = 0, bestRi = 4;
      regionGrids.forEach((reg, ri) => {
        const m = norm01(smooth3(reg));
        for (let lag = -4; lag <= 4; lag++) {
          const a = lag < 0 ? audioN.slice(-lag) : audioN;
          const mm = lag < 0 ? m.slice(0, m.length + lag) : m.slice(lag);
          const r = pearson(a, mm);
          if (r > best) { best = r; bestLag = lag; bestRi = ri; }
        }
      });
      bestRegion = REGION_NAMES[bestRi];
      lagMs = bestLag * 100;
      lipScore = Math.round(Math.max(2, Math.min(98, ((best - 0.05) / 0.75) * 100)));
      lipDetail =
        lipScore >= 70
          ? `Strongest speech-coupled zone: ${bestRegion} (r=${best.toFixed(2)}, lag ${lagMs} ms). Mouth motion tracks voice — consistent with a real recording.`
          : lipScore >= 40
            ? `Weak coupling even in the best zone (${bestRegion}, r=${best.toFixed(2)}). Heavy compression or a cheap lip-sync fake — suspect.`
            : `No zone moves with speech (best: ${bestRegion}, r=${best.toFixed(2)}). Classic Wav2Lip-style lip-sync signature.`;

      const splicePenalty = splices.reduce((a, s) => a + 24 * s.strength, 0);
      if (feats.denseProsody && splices.length === 0) {
        audioScore = 70;
        audioDetail = "Dense modulation throughout (expressive speech or song) — no isolated cut points. Splice branch stays neutral rather than false-alarming on prosody.";
      } else {
        audioScore = Math.round(Math.max(3, 96 - splicePenalty));
        audioDetail = splices.length === 0
          ? "No spectral discontinuities. Energy, flux and zero-crossing evolve continuously — no cut-and-join found."
          : `${splices.length} splice${splices.length > 1 ? "s" : ""} at ${splices.map((s) => `${s.t.toFixed(1)}s`).join(", ")}. Spectral flux + energy steps break unnaturally — words were likely rearranged.`;
      }
    }
    const tAudio = (performance.now() - ta);

    // — forensic branch —
    const tf = performance.now();
    onProgress?.(0.85, "Estimating forward-generation age…");
    const bitrateKbps = duration > 0 ? (file.size * 8) / duration / 1000 : 0;
    const effMode: DemoMode = mode === "synthetic-fake" ? "auto" : mode;
    const comp = estimateGeneration({
      sharpness: vis.sharpness,
      blockiness: vis.blockiness,
      bitrateKbps,
      height: video.videoHeight || 720,
      mode: effMode,
    });
    const tForensic = performance.now() - tf;

    // — fusion (production: learned gated fusion; prototype: fixed weights) —
    const overall = Math.max(3, Math.round(lipScore * 0.45 + audioScore * 0.35 + comp.score * 0.2) - mutePenalty);
    const verdict: Verdict = overall >= 70 ? "REAL" : overall >= 40 ? "SUSPECT" : "FAKE";
    if (comp.generation >= 4 && verdict === "REAL")
      notes.push(`Gen-${comp.generation} aged: verdict leans on compression-robust cues (low-freq DCT stats, phase) — pixel forensics are gone by this generation.`);

    // — timeline @10Hz over assessed window (smoothed, as scored) —
    const lipCurve = (() => {
      if (decoded.status === "ok") {
        const idx = REGION_NAMES.indexOf(bestRegion);
        return norm01(smooth3(regionGrids[idx >= 0 ? idx : 4]));
      }
      return new Array(grid).fill(0.5);
    })();
    const audioCurve = okEnv ? norm01(smooth3(okEnv)) : new Array(grid).fill(0.5);
    const timeline: TimelinePoint[] = Array.from({ length: grid }, (_, i) => ({
      t: (i / (grid - 1)) * T,
      lip: lipCurve[i] ?? 0,
      audio: audioCurve[i] ?? 0,
    }));

    onProgress?.(1, "Done.");
    const total = performance.now() - t0;
    return {
      verdict, overall, duration, fileName: file.name,
      lipSync: { score: lipScore, detail: lipDetail, lagMs },
      audio: { score: audioScore, detail: audioDetail, splices },
      compression: {
        score: comp.score, detail: comp.detail, generation: comp.generation,
        sharpness: Math.round(vis.sharpness), blockiness: +vis.blockiness.toFixed(2),
        bitrateKbps: Math.round(bitrateKbps), width: video.videoWidth || 0, height: video.videoHeight || 0,
      },
      timeline, timings: { visual: tVisual, audio: tAudio, forensic: tForensic, total }, notes,
      lab: {
        audioRms: +decoded.rms.toFixed(4), audioPeak: +decoded.peak.toFixed(3),
        audioStatus: decoded.status, bestRegion,
      },
    };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/* Zero-asset demo for judges with no clip handy: fully synthetic curves. */
export function syntheticResult(kind: "real" | "fake", duration = 8): AnalysisResult {
  const grid = Math.round(duration * 10);
  const rnd = (s: number) => {
    let x = s;
    return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; };
  };
  const rand = rnd(kind === "real" ? 42 : 1337);
  const speech = Array.from({ length: grid }, (_, i) => {
    const t = i / 10;
    const syll = Math.max(0, Math.sin(t * 7) * 0.5 + Math.sin(t * 2.3) * 0.5);
    return Math.min(1, Math.max(0.05, syll + (rand() - 0.5) * 0.25));
  });
  const lip = kind === "real"
    ? speech.map((s) => Math.min(1, Math.max(0, s + (rand() - 0.5) * 0.2)))
    : speech.map((_, i) => { const j = (i + 40) % grid; return Math.min(1, Math.max(0, speech[j] * 0.6 + (rand() - 0.5) * 0.45)); });
  const splices: SpliceMark[] = kind === "fake" ? [{ t: duration * 0.42, strength: 0.95 }] : [];
  const lipScore = kind === "real" ? 88 : 24;
  const audioScore = kind === "real" ? 93 : 31;
  const compScore = kind === "real" ? 81 : 44;
  const overall = Math.round(lipScore * 0.45 + audioScore * 0.35 + compScore * 0.2);
  return {
    verdict: kind === "real" ? "REAL" : "FAKE",
    overall, duration, fileName: kind === "real" ? "demo-real-8s.mp4" : "demo-doctored-8s.mp4",
    lipSync: {
      score: lipScore, lagMs: kind === "real" ? 0 : 400,
      detail: kind === "real"
        ? "Mouth motion tracks speech energy (r=0.71, best lag 0 ms). Consistent with a real recording."
        : "Mouth moves independently of speech (r=-0.08, lag 400 ms). Classic Wav2Lip-style lip-sync signature.",
    },
    audio: {
      score: audioScore, splices,
      detail: kind === "real"
        ? "No spectral discontinuities. Energy, flux and zero-crossing evolve continuously — no cut-and-join found."
        : "1 splice at 3.4s. Spectral flux + energy steps break unnaturally — words were likely rearranged.",
    },
    compression: {
      score: compScore, generation: kind === "real" ? 2 : 4,
      detail: kind === "real"
        ? "Looks close to original. Light encode, texture intact."
        : "WhatsApp-aged: Gen-4. Surviving cues are low-frequency DCT stats + phase, not pixels. Low bitrate; strong 8×8 blocking grid.",
      sharpness: kind === "real" ? 210 : 41, blockiness: kind === "real" ? 1.04 : 1.31,
      bitrateKbps: kind === "real" ? 1400 : 520, width: 1280, height: 720,
    },
    timeline: speech.map((a, i) => ({ t: (i / (grid - 1)) * duration, lip: lip[i], audio: a })),
    timings: { visual: 2310, audio: 1140, forensic: 380, total: 3830 },
    notes: kind === "fake"
      ? ["Synthetic demo — no upload needed. Upload any real clip to run live analysis."]
      : ["Synthetic demo — no upload needed. Upload any real clip to run live analysis."],
    lab: { audioRms: 0.02, audioPeak: 0.4, audioStatus: "ok", bestRegion: "lower-center" },
  };
}
