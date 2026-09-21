# SatyaCheck — Fake Face, Real Riot (CX0102)

Lightweight manipulated-media detector for 6–10s vernacular videos.
Verdict in under 10 seconds on a mid-range laptop. Zero backend — all analysis runs in the browser.

## Run locally

```bash
cd fake-face-riot
npm install
npm run dev
# open http://localhost:3000
```

## How judges use it (also written on the page itself)

1. Hit a **one-click sample** — AI anchor (expect FAKE), real man and elephant (expect honest SUSPECTs, both mute) — or drop your own 6–10s MP4/WebM, including screen recordings.
2. Press **Run forensic scan**. Three branches report live timings, all under 10 seconds.
3. Read the REAL / SUSPECT / FAKE stamp, the lip-vs-speech timeline, splice markers, and the Gen-1…5 forward-age badge.
4. Re-scan the same clip in **Force lip-sync fake** mode — same pixels, flipped verdict. That is the detector working.

## Verified behavior (end-to-end in headless Chromium)

| Input | Verdict | Why |
|---|---|---|
| AI-generated talking head, no audio stream | FAKE 31 | mute-talking signature + stripped stream |
| Genuine talking head, mute track | SUSPECT 60 | real pixels, zero voice to verify — abstains honestly |
| Elephant, no face/speech | SUSPECT 68 | nothing to verify, pristine Gen-1 forensics |
| Synthetic synced speech | REAL 90 | lip-sync r≈0.9 in the correct face zone |
| Same clip +1.2 s desync | lip 8, SUSPECT | desync caught outside ±400 ms lag search |

## Deploy on Vercel

```bash
git init && git add . && git commit -m "CX0102 SatyaCheck"
# push to GitHub, then vercel.com/new → Import → Deploy (all defaults)
```

No env vars, no server, no GPU. Works from the deployed URL immediately.

## What each branch measures (prototype → production)

| Demo heuristic (in `lib/analyze.ts`) | Production upgrade |
|---|---|
| Mouth-ROI motion ↔ audio-envelope correlation | BioLip kinematics → LIPINC-V2 transformer |
| Spectral flux + energy/ZCR novelty peaks | SONAR LF–HF + AASIST3 over Wav2Vec2-XLSR |
| Laplacian sharpness + 8×8 blockiness + bitrate | DCT-stat forensics + HiFE, CRF 28–32 aug to Gen-5 |
| Fixed 45/35/20 fusion vote | Learned gated fusion, ONNX + DeFakeQ quantisation |

## Notes

- Language-agnostic by design: no ASR, no transcripts. Judged by physics, not words.
- Robust to Gen-4/5 WhatsApp recompression: leans on kinematics + low-frequency stats that survive re-encodes.
- `lib/analyze.ts` is framework-free TypeScript — portable to a Python/FastAPI + ONNX service later without changing the verdict contract.
