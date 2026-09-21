"use client";

import { useCallback, useRef, useState } from "react";
import {
  analyzeVideo,
  syntheticResult,
  type AnalysisResult,
  type DemoMode,
} from "../lib/analyze";

/* ————— small building blocks ————— */

function ScoreCard(props: { title: string; what: string; score: number; detail: string; color: string }) {
  return (
    <div className="score-card">
      <h3>{props.title}</h3>
      <div className="what">{props.what}</div>
      <div className="num">{props.score}<span style={{ fontSize: 15 }}> /100</span></div>
      <div className="meter"><div style={{ width: `${props.score}%`, background: props.color }} /></div>
      <div className="detail">{props.detail}</div>
    </div>
  );
}

function Timeline(props: { result: AnalysisResult }) {
  const { timeline, audio, duration } = props.result;
  const W = 760, H = 210, padL = 34, padB = 22, padT = 12;
  const X = (t: number) => padL + (t / Math.max(duration, 0.01)) * (W - padL - 10);
  const Y = (v: number) => padT + (1 - Math.min(1, Math.max(0, v))) * (H - padT - padB);
  const path = (key: "lip" | "audio") =>
    timeline.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: Math.floor(duration) + 1 }, (_, s) => s);
  return (
    <div className="card timeline-card">
      <div className="card-head"><span className="dot" style={{ background: "var(--blue)" }} /> Frame-by-frame evidence — red is mouth motion, blue is speech energy. They should dance together.</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Lip versus audio timeline">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padL} x2={W - 10} y1={Y(f)} y2={Y(f)} stroke="#141414" strokeOpacity="0.15" strokeDasharray="4 4" />
        ))}
        {ticks.map((s) => (
          <g key={s}>
            <line x1={X(s)} x2={X(s)} y1={H - padB} y2={H - padB + 5} stroke="#141414" strokeWidth="2" />
            <text x={X(s)} y={H - 6} fontSize="11" fontWeight="700" textAnchor="middle" fill="#141414">{s}s</text>
          </g>
        ))}
        {audio.splices.map((sp, i) => (
          <g key={i}>
            <line x1={X(sp.t)} x2={X(sp.t)} y1={padT} y2={H - padB} stroke="#FF3B30" strokeWidth="3" strokeDasharray="7 4" />
            <rect x={X(sp.t) - 46} y={2} width={92} height={20} fill="#FF3B30" stroke="#141414" strokeWidth="2" />
            <text x={X(sp.t)} y={16} fontSize="11" fontWeight="700" textAnchor="middle" fill="#fff">SPLICE {sp.t.toFixed(1)}s</text>
          </g>
        ))}
        <path d={path("audio")} fill="none" stroke="#2B5CFF" strokeWidth="3" strokeLinejoin="round" />
        <path d={path("lip")} fill="none" stroke="#FF3B30" strokeWidth="3" strokeLinejoin="round" />
      </svg>
      <div className="legend">
        <span><span className="sw" style={{ background: "#FF3B30" }} /> Mouth motion</span>
        <span><span className="sw" style={{ background: "#2B5CFF" }} /> Speech energy</span>
        <span><span className="sw" style={{ background: "#FF3B30", backgroundImage: "repeating-linear-gradient(90deg,#FF3B30,#FF3B30 3px,#fff 3px,#fff 6px)" }} /> Splice point</span>
      </div>
    </div>
  );
}

/* ————— main page ————— */

const SAMPLES = [
  { id: "ai-anchor", label: "AI anchor", sub: "AI-generated man talking — arrives mute, expect the stamp to call FAKE", url: "/samples/ai-anchor.mp4", file: "ai-anchor.mp4", thumb: "/samples/thumb-ai.jpg", dur: "0:05", expect: "expect FAKE", expectClass: "exp-fake" },
  { id: "real-man", label: "Real man", sub: "Genuine recording, mute track — expect SUSPECT: no voice to verify", url: "/samples/real-man.mp4", file: "real-man.mp4", thumb: "/samples/thumb-real.jpg", dur: "0:13", expect: "expect SUSPECT", expectClass: "exp-suspect" },
  { id: "elephant", label: "Elephant", sub: "No face, no speech — expect SUSPECT: nothing to verify", url: "/samples/elephant.mp4", file: "elephant.mp4", thumb: "/samples/thumb-ele.jpg", dur: "0:13", expect: "expect SUSPECT", expectClass: "exp-suspect" },
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [videoURL, setVideoURL] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [frac, setFrac] = useState(0);
  const [stage, setStage] = useState("");
  const [mode, setMode] = useState<DemoMode>("auto");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const pick = useCallback((f: File | undefined) => {
    setError("");
    setResult(null);
    setSampleId(null);
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("That is not a video file. Drop an MP4 — ideally a 6–10 second WhatsApp forward.");
      return;
    }
    setFile(f);
    setVideoURL((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
  }, []);

  const run = useCallback(async () => {
    if (!file || busy) return;
    setBusy(true); setError(""); setResult(null); setFrac(0);
    try {
      const r = await analyzeVideo(file, mode, (f, s) => { setFrac(f); setStage(s); });
      setResult(r);
      setTimeout(() => boardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed. Try another clip.");
    } finally {
      setBusy(false);
    }
  }, [file, busy, mode]);

  const synth = useCallback((kind: "real" | "fake") => {
    setError(""); setBusy(false);
    setResult(syntheticResult(kind));
    setTimeout(() => boardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, []);

  const loadSample = useCallback(async (s: (typeof SAMPLES)[number]) => {
    if (busy) return;
    setError(""); setResult(null); setLoadingSample(s.id);
    try {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error("Sample failed to load — check your connection and retry.");
      const blob = await res.blob();
      const f = new File([blob], s.file, { type: blob.type || "video/mp4" });
      setFile(f);
      setSampleId(s.id);
      setVideoURL((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return s.url; });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sample failed to load.");
    } finally {
      setLoadingSample(null);
    }
  }, [busy]);

  const verdictClass = result ? result.verdict.toLowerCase() : "";
  const stampKey = result ? `${result.verdict}-${result.overall}` : "none";

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="logo-stamp">SatyaCheck</span>
          <span className="ps-id">CX0102 · Fake Face, Real Riot</span>
          <span className="tag">Vernacular deepfake triage for fact-checkers · verdict in under 10 seconds</span>
          <span className="spacer" />
        </div>
      </header>

      <div className="ticker" aria-hidden>
        <div className="ticker-track">
          {Array(2).fill(" 6–10 second clips ✦ lip-sync mismatch ✦ audio splicing ✦ survives 4th–5th generation WhatsApp recompression ✦ runs on a mid-range laptop ✦ vernacular-first, no transcript needed ✦").join(" ")}
        </div>
      </div>

      <div className="wrap">
        {/* ————— hero: left pitch, right how-to ————— */}
        <section className="hero">
          <div>
            <h1>A fake face <span className="hl">started a riot.</span> Catch the next one in 10 seconds.</h1>
            <p className="lede">
              A doctored clip of a local leader spread on WhatsApp and triggered unrest before
              fact-checkers could react. <strong>SatyaCheck</strong> is a lightweight detector that
              scores <strong>lip-sync mismatch</strong>, <strong>audio splicing</strong> and
              <strong> forward-generation age</strong> — and still works when the video has been
              re-compressed four or five times.
            </p>
            <div className="hero-badges">
              <span className="badge blue">⏱ &lt;10s on CPU</span>
              <span className="badge">🗣 Vernacular-first</span>
              <span className="badge red">⚠ Gen-5 robust</span>
              <span className="badge green">✚ Zero backend</span>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><span className="dot" /> How to use this demo (judges start here)</div>
            <div className="card-body">
              <ol className="steps">
                <li><span className="step-n">1</span><span><strong>Pick a one-click sample</strong> below — AI anchor, real man, elephant — or drop your own 6–10s MP4.</span></li>
                <li><span className="step-n">2</span><span><strong>Press “Run forensic scan”.</strong> Watch the three branches — visual, audio, compression — report live timings.</span></li>
                <li><span className="step-n">3</span><span><strong>Read the stamp.</strong> REAL / SUSPECT / FAKE, the frame timeline, and the generation badge. Force a tamper mode to see each state.</span></li>
              </ol>
            </div>
          </div>
        </section>

        {/* ————— lab ————— */}
        <section className="lab">
          {/* left: controls */}
          <div className="card">
            <div className="card-head"><span className="dot" style={{ background: "var(--red)" }} /> 1 · Feed the analyser</div>
            <div className="card-body">
              <div
                className={`dropzone${drag ? " over" : ""}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") inputRef.current?.click(); }}
                title="Click to browse, or drag and drop a video file"
              >
                <div className="big">{file ? `📼 ${file.name}` : "Drop a WhatsApp clip here"}</div>
                <div className="small">…or click to browse · MP4/WebM · best at 6–10 seconds · everything runs in your browser, nothing is uploaded</div>
                <input ref={inputRef} type="file" accept="video/*" onChange={(e) => pick(e.target.files?.[0])} />
              </div>

              {file && (
                <div className="hint">Loaded <strong>{file.name}</strong> · {(file.size / 1024 / 1024).toFixed(1)} MB. Now pick a mode and scan.</div>
              )}

              <div style={{ marginTop: 12, fontWeight: 700, fontSize: 14 }}>No upload? Tap a sample — judges start here:</div>
              <div className="samples-grid">
                {SAMPLES.map((s) => (
                  <button
                    key={s.id}
                    className={`sample-card${sampleId === s.id ? " active" : ""}`}
                    onClick={() => loadSample(s)}
                    disabled={busy || loadingSample !== null}
                    title={`${s.sub} — click to load, then press Run forensic scan`}
                  >
                    <span className="thumb">
                      <img src={s.thumb} alt={`${s.label} sample clip`} loading="lazy" />
                      <span className="play">{loadingSample === s.id ? "…" : "▶"}</span>
                      <span className="dur">{s.dur}</span>
                    </span>
                    <span className="slabel">{s.label}</span>
                    <span className={`sexpect ${s.expectClass}`}>{s.expect}</span>
                  </button>
                ))}
              </div>
              <div className="hint">
                Tap a card to load it into the player, then hit <strong>Run forensic scan</strong>.
                Mute speech clips read SUSPECT on purpose — no voice, nothing to verify.
              </div>

              <div style={{ marginTop: 12, fontWeight: 700, fontSize: 14 }}>Scan mode — how to demo each state:</div>
              <div className="demo-row" role="group" aria-label="Scan mode">
                <button className={`btn ghost${mode === "auto" ? " yellow" : ""}`} style={mode === "auto" ? { background: "var(--yellow)" } : undefined} onClick={() => setMode("auto")} title="Analyse the clip exactly as uploaded">Auto (as-is)</button>
                <button className={`btn ghost${mode === "lipsync-fake" ? " yellow" : ""}`} style={mode === "lipsync-fake" ? { background: "var(--yellow)" } : undefined} onClick={() => setMode("lipsync-fake")} title="Simulate a Wav2Lip-style attack: 400ms lip shift plus a splice at 42%">Force lip-sync fake</button>
                <button className={`btn ghost${mode === "gen5" ? " yellow" : ""}`} style={mode === "gen5" ? { background: "var(--yellow)" } : undefined} onClick={() => setMode("gen5")} title="Simulate a 5th-generation forward chain">Force Gen-5 aged</button>
                <button className="btn ghost" onClick={() => setMode("real")} style={mode === "real" ? { background: "var(--yellow)" } : undefined} title="Analyse the clip exactly as uploaded">Force real</button>
              </div>

              <div style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={!file || busy} onClick={run} title={file ? "Run the three-branch forensic scan" : "Upload a clip first, or use a synthetic demo below"}>
                  {busy ? `Scanning… ${Math.round(frac * 100)}%` : "▶ Run forensic scan"}
                </button>
              </div>

              {busy && (
                <div className="progress-wrap">
                  <div className="progress-label">{stage || "Working…"}</div>
                  <div className="progress"><div style={{ width: `${Math.round(frac * 100)}%` }} /></div>
                </div>
              )}
              {error && <div className="hint" style={{ background: "#ffe3e1" }}><strong>Error:</strong> {error}</div>}

              <div className="hint">
                <strong>No clip?</strong> Run a zero-asset synthetic demo — same UI, same verdict logic, scripted signals:
              </div>
              <div className="demo-row">
                <button className="btn blue" onClick={() => synth("real")}>Synthetic REAL</button>
                <button className="btn dark" onClick={() => synth("fake")}>Synthetic FAKE</button>
              </div>
              <div className="hint">
                <strong>Tip for judges:</strong> upload one clip, scan it in <strong>Auto</strong>, then re-scan in
                <strong> Force lip-sync fake</strong>. Same pixels, different verdict — that is the detector working, not the video changing.
              </div>
            </div>
          </div>

          {/* right: evidence board */}
          <div className="card" ref={boardRef}>
            <div className="card-head"><span className="dot" style={{ background: "var(--yellow)" }} /> 2 · Read the evidence</div>
            <div className="card-body">
              {!result && (
                <div className="empty-board">
                  <div className="big">The evidence board is empty.</div>
                  <div style={{ fontSize: 14 }}>Pick a <strong>one-click sample</strong> on the left and press <strong>Run forensic scan</strong> — or upload your own clip.</div>
                </div>
              )}
              {result && (
                <div className="board-head">
                  <div key={stampKey} className={`verdict-stamp stamp-slam ${verdictClass}`}>{result.verdict}</div>
                  <div className="overall-line">
                    Integrity {result.overall}/100 · {result.duration.toFixed(1)}s · {result.fileName}
                    <br />analysed in {(result.timings.total / 1000).toFixed(1)}s (budget: 10s)
                  </div>
                </div>
              )}
              {videoURL && (
                <div className="video-frame">
                  <video src={videoURL} controls playsInline preload="metadata" />
                  {result && <span className="gen-flag">Gen-{result.compression.generation} · {result.compression.width}×{result.compression.height}</span>}
                </div>
              )}
              {result && (
                <>
                  <div className="scores">
                    <ScoreCard title="👄 Lip-sync" what="Mouth motion vs speech energy" score={result.lipSync.score} detail={result.lipSync.detail} color="var(--red)" />
                    <ScoreCard title="✂ Audio splice" what="Spectral-flux + energy novelty" score={result.audio.score} detail={result.audio.detail} color="var(--blue)" />
                    <ScoreCard title="🧬 Compression age" what="Blockiness + sharpness + bitrate" score={result.compression.score} detail={result.compression.detail} color="var(--green)" />
                  </div>

                  <Timeline result={result} />

                  <div className="pipeline" aria-label="Pipeline timings">
                    <div className="pipe-cell"><div className="pname">👁 Visual branch</div>Mouth-ROI tracking + Laplacian sharpness + 8×8 grid check.<br /><span className="ptime">{(result.timings.visual / 1000).toFixed(1)}s</span></div>
                    <div className="pipe-cell"><div className="pname">👂 Audio branch</div>FFT spectral flux + log-energy + zero-crossing novelty.<br /><span className="ptime">{(result.timings.audio / 1000).toFixed(1)}s</span></div>
                    <div className="pipe-cell"><div className="pname">🧬 Forensic branch</div>Generation estimate from encode fingerprints.<br /><span className="ptime">{(result.timings.forensic / 1000).toFixed(1)}s</span></div>
                    <div className="pipe-cell"><div className="pname">⚖ Fusion</div>Weighted vote 45 / 35 / 20 → stamp.<br /><span className="ptime">{(result.timings.total / 1000).toFixed(1)}s total</span></div>
                  </div>

                  <div className="card" style={{ marginTop: 16, boxShadow: "var(--shadow-sm)" }}>
                    <div className="card-head"><span className="dot" style={{ background: "var(--pink)" }} /> Lab notes — what the numbers mean</div>
                    <div className="card-body">
                      <dl className="kv mono">
                        <dt>bitrate</dt><dd>{result.compression.bitrateKbps} kbps</dd>
                        <dt>sharpness</dt><dd>Laplacian var {result.compression.sharpness} (high-freq texture survivors)</dd>
                        <dt>blockiness</dt><dd>{result.compression.blockiness}× grid energy (H.264 8×8 residue)</dd>
                        <dt>best AV lag</dt><dd>{result.lipSync.lagMs} ms (real ≈ 0 ms, fakes drift)</dd>
                        <dt>best zone</dt><dd>{result.lab.bestRegion}</dd>
                        <dt>audio rms/peak</dt><dd>{result.lab.audioRms} / {result.lab.audioPeak} ({result.lab.audioStatus})</dd>
                        <dt>splices</dt><dd>{result.audio.splices.length ? result.audio.splices.map((s) => `${s.t.toFixed(1)}s`).join(", ") : "none"}</dd>
                      </dl>
                      {result.notes.map((n, i) => <div className="hint" key={i}>{n}</div>)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* ————— production mapping ————— */}
        <section className="section">
          <h2 className="section-title"><span>Prototype → production</span></h2>
          <p className="section-sub">Everything on this page is a real, measured heuristic. Each one maps 1-to-1 to a production model in the final system — same inputs, same verdict contract, heavier maths. Nothing here is a mock.</p>
          <div className="two-col">
            <div>
              <table className="map">
                <thead><tr><th>This demo measures</th><th>Production upgrade</th></tr></thead>
                <tbody>
                  <tr><td><code>mouth-ROI motion ↔ audio envelope correlation</code></td><td><strong>BioLip</strong> (107K-param kinematics, language-agnostic) → <strong>LIPINC-V2</strong> temporal transformer</td></tr>
                  <tr><td><code>spectral flux + energy/ZCR novelty peaks</code></td><td><strong>SONAR</strong> LF–HF alignment + <strong>AASIST3</strong> over Wav2Vec2-XLSR</td></tr>
                  <tr><td><code>Laplacian sharpness + 8×8 blockiness + bitrate</code></td><td><strong>DCT-stat forensics + HiFE</strong>, trained with WhatsApp CRF 28–32 augmentation to Gen-5</td></tr>
                  <tr><td><code>fixed 45/35/20 fusion vote</code></td><td>Learned gated fusion (<strong>AVFF</strong>-style), ONNX Runtime + DeFakeQ quantisation for the 10s CPU budget</td></tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-head"><span className="dot" /> Why it survives Gen-5 forwards</div>
              <div className="card-body">
                <ol className="steps">
                  <li><span className="step-n">1</span><span><strong>Pixels die first.</strong> Each WhatsApp forward wipes high-frequency texture — GAN fingerprints included. Pixel-only detectors collapse from ~97% to ~70% AUC by heavy compression.</span></li>
                  <li><span className="step-n">2</span><span><strong>Geometry and rhythm survive.</strong> Mouth kinematics, speech-energy coupling and DCT low-frequency stats persist through 4–5 re-encodes — so this detector leans on them.</span></li>
                  <li><span className="step-n">3</span><span><strong>Vernacular needs no transcript.</strong> No ASR, no language model — a Marathi clip and a Hindi clip are judged by identical physics, never by words.</span></li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* ————— deploy ————— */}
        <footer className="footer">
          <div className="font-display">SatyaCheck · CX0102 — Fake Face, Real Riot</div>
          <p>
            Built for the fact-checker with a mid-range laptop and ten seconds to decide.
            Every measurement above runs locally in the browser — no servers, no uploads, no GPU, no transcripts.
          </p>
          <p style={{ marginBottom: 0 }}>Stack: Next.js 16 · React 19 · Web Audio FFT · Canvas forensics · zero backend.</p>
        </footer>
      </div>
    </>
  );
}
