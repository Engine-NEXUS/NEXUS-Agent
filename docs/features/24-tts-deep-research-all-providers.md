# NEXUS TTS — Deep Research: All Free TTS Providers (2026)

> **Question:** What TTS providers offer free, unlimited voices for NEXUS (5 users, 250 calls/day, ~2.25M chars/month)?
> **Date:** 2026-08-30
> **Status:** Research complete — 10 providers analyzed

---

## TL;DR — Ranked Recommendations

| Rank | Provider | Free limit | Permanent? | Voices | Quality | API? | Best for NEXUS? |
|------|----------|-----------|------------|--------|---------|------|-----------------|
| 1 | **Kokoro (self-hosted)** | **Unlimited** | ✅ Forever (Apache 2.0) | 54 | Excellent | ✅ | ✅ **Best — truly free forever** |
| 2 | **Fish Audio `s2.1-pro-free`** | Unlimited (Fair Use) | ⚠️ Through Aug 31 | 83 langs, cloning | Excellent | ✅ | ✅ Best hosted option |
| 3 | **Google Cloud TTS** | 4M Standard + 1M WaveNet/mo | ✅ Permanent | 700+ | Very Good | ✅ | ✅ Covers 5 users easily |
| 4 | **Amazon Polly** | 5M Standard/mo (permanent) | ✅ Standard permanent | 100+ | Good | ✅ | ✅ Huge free tier |
| 5 | **Piper (self-hosted)** | **Unlimited** | ✅ Forever (GPL-3.0) | 100+ | Good | ✅ | ⚠️ CPU-only, lower quality |
| 6 | **Azure TTS** | 500K chars/mo | ✅ Permanent | 500+ | Very Good | ✅ | ❌ Too small for 5 users |
| 7 | **Hugging Face Inference** | Rate-limited (~few hundred/hr) | ✅ Permanent | Varies | Varies | ✅ | ⚠️ Unreliable for production |
| 8 | **Coqui XTTS-v2 (self-hosted)** | **Unlimited** | ⚠️ Non-commercial | Cloning | Excellent | ✅ | ⚠️ Non-commercial license |
| 9 | **ElevenLabs** | 10K chars/mo | ✅ Permanent | 29 | Excellent | ❌ Free = no API | ❌ Useless without paid |
| 10 | **TTSMaker** | Unlimited (attribution) | ✅ Permanent | Limited | Fair | ✅ | ⚠️ Attribution required |

---

## 1. Kokoro-82M — Self-Hosted, Truly Free Forever ⭐ TOP PICK

**The only option that is genuinely free forever with no limits, no API dependency, and commercial use allowed.**

| Feature | Value |
|---------|-------|
| License | **Apache 2.0** (full commercial use) |
| Parameters | 82M (tiny — runs on CPU) |
| Voices | **54 voices** across 8 languages |
| Languages | English (US/UK), Chinese, Japanese, Spanish, French, Hindi, Italian, Portuguese |
| Cost | **$0 forever** |
| Limits | **None** — unlimited characters, unlimited calls |
| Quality | Comparable to much larger models (StyleTTS 2 architecture) |
| Latency | Sub-second on CPU, near-instant on GPU |
| Voice cloning | No (but 54 pre-built voices) |
| Self-host | Yes — Docker image available ([Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), 5,370 stars) |

### Why Kokoro is the best choice for NEXUS

1. **Apache 2.0 = commercial use allowed, no restrictions, no attribution required**
2. **82M params = runs on CPU** — no GPU needed, no cloud dependency
3. **54 voices** — enough variety for 5 users (each can pick their own voice)
4. **Unlimited** — no character caps, no rate limits, no "fair use" policy
5. **Docker-ready** — [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) provides an OpenAI-compatible API server
6. **Offline** — works without internet, no API key, no signup

### Kokoro voice list (selection)

| Voice | Gender | Accent | Style |
|-------|--------|--------|-------|
| `af_heart` | Female | American | Warm, natural |
| `af_bella` | Female | American | Bright |
| `af_sky` | Female | American | Calm |
| `am_adam` | Male | American | Professional |
| `am_michael` | Male | American | Deep |
| `bf_emma` | Female | British | Refined |
| `bf_isla` | Female | British | Soft |
| `bm_george` | Male | British | Authoritative |
| `bm_lewis` | Male | British | Casual |
| `ff_siwis` | Female | French | Natural |
| `ef_dora` | Female | Spanish | Natural |
| ... | ... | ... | 54 total |

### Integration with NEXUS

Kokoro-FastAPI is OpenAI-compatible:
```
POST http://localhost:8880/v1/audio/speech
{
  "model": "kokoro",
  "input": "On it, sir.",
  "voice": "bm_george"
}
→ Returns MP3/WAV audio
```

NEXUS could either:
- **A) Bundle Kokoro as a sidecar** (like the STT server) — runs locally on the user's machine
- **B) Self-host on a small VPS** — $5/month VPS handles all 5 users
- **C) Use a hosted Kokoro API** — [rekam.ai](https://www.rekam.ai/m/kokoro) offers free Kokoro TTS online

### Kokoro quality benchmark

From the HuggingFace model card:
> "Despite its lightweight architecture, it delivers comparable quality to larger models while being significantly faster and more cost-efficient."

Word Error Rate (WER) benchmarks from Kokoro-FastAPI:
- `af_heart` (English): WER 0.000 (perfect)
- `bf_emma` (English UK): WER 0.111
- `ef_dora` (Spanish): WER 0.000
- `ff_siwis` (French): WER 0.000

---

## 2. Fish Audio `s2.1-pro-free` — Best Hosted Free Option

(Already covered in detail in doc 23)

| Feature | Value |
|---------|-------|
| Cost | $0 (free period through Aug 31, 2026) |
| Limits | No hard cap (Fair Use) |
| Voices | 83 languages, voice cloning included |
| Quality | State-of-the-art (same as paid `s2.1-pro`) |
| Latency | ~100ms TTFA with streaming |
| API | Full REST + WebSocket streaming |
| Commercial | Allowed (<$1M ARR) |

**Risk:** Free period has been extended twice but is not contractually permanent. If it ends, paid tier is $15/M bytes (~$34/month for 5 users).

---

## 3. Google Cloud TTS — Generous Permanent Free Tier

| Feature | Value |
|---------|-------|
| Free tier | **4M Standard chars/mo + 1M WaveNet chars/mo** (permanent, resets monthly) |
| Total free | **5M chars/month** combined |
| Your usage | 2.25M chars/month → **only 45% of free tier used** |
| Voices | **700+ voices** across 40+ languages |
| Quality | WaveNet = very good, Neural2 = excellent, Chirp3-HD = state-of-the-art |
| Price after free | $4/1M (Standard & WaveNet), $16/1M (Neural2) |
| API | Full REST + gRPC, SSML support |
| Commercial | ✅ Full commercial use |
| Credit card | Required to sign up (but won't be charged under free tier) |

### Google Cloud TTS for 5 NEXUS users

```
5 users × 250 calls/day × 300 chars = 2.25M chars/month
Free tier: 5M chars/month
Usage: 45% of free tier → ✅ Plenty of headroom
```

**BUT:** Each user needs their own Google Cloud account (or share one account). If shared:
- 2.25M chars from one account = still under 5M free tier ✅
- But Google requires a credit card on file (won't charge under free tier)
- Each user can create their own free Google Cloud account → 5 × 5M = 25M chars/month total

### Google Cloud TTS voices (selection)

| Voice | Type | Gender | Language |
|-------|------|--------|----------|
| `en-US-Wavenet-D` | WaveNet | Male | American |
| `en-US-Wavenet-A` | WaveNet | Male | American |
| `en-US-Wavenet-C` | WaveNet | Female | American |
| `en-US-Wavenet-F` | WaveNet | Female | American |
| `en-GB-Wavenet-B` | WaveNet | Male | British |
| `en-GB-Wavenet-A` | WaveNet | Female | British |
| `en-AU-Wavenet-B` | WaveNet | Male | Australian |
| ... | ... | ... | 700+ total |

### Why Google Cloud TTS is a strong option

1. **5M chars/month free is more than enough** for 5 users
2. **700+ voices** — massive variety
3. **Permanent free tier** — not time-limited (unlike Polly's neural voices)
4. **SSML support** — pitch, rate, volume, emphasis control
5. **WaveNet at $4/1M** (was $16, dropped in early 2026) — cheapest quality option if you exceed free tier
6. **Well-documented REST API** — easy to integrate

### Drawbacks

1. **Requires Google Cloud account + credit card** (even for free tier)
2. **Not truly unlimited** — 5M chars/month cap (but enough for your usage)
3. **Cloud dependency** — needs internet, Google could change pricing
4. **Standard voices sound robotic** — use WaveNet for good quality

---

## 4. Amazon Polly — Largest Permanent Free Tier

| Feature | Value |
|---------|-------|
| Free tier (Standard) | **5M chars/month — PERMANENT, no expiry** |
| Free tier (Neural) | 1M chars/month — first 12 months only |
| Free tier (Generative) | 100K chars/month — first 12 months only |
| Your usage | 2.25M chars/month → **45% of Standard free tier** |
| Voices | 100+ voices across 60+ languages |
| Quality | Standard = basic, Neural = good, Generative = excellent |
| Price after free | $4/1M (Standard), $16/1M (Neural), $30/1M (Generative) |
| API | AWS SDK (Python, Node, Java, Go, Rust) |
| Commercial | ✅ Full commercial use |
| Credit card | Required (AWS account) |

### Amazon Polly for 5 NEXUS users

```
5 users × 250 calls/day × 300 chars = 2.25M chars/month
Free tier (Standard): 5M chars/month → ✅ 45% used, plenty of headroom
```

**Standard voices are permanent free** — this is the largest permanent free tier among cloud providers. But Standard voices sound noticeably less natural than Neural.

### Polly voices (selection)

| Voice | Type | Gender | Language |
|-------|------|--------|----------|
| `Brian` | Neural | Male | British |
| `Joanna` | Neural | Female | American |
| `Matthew` | Neural | Male | American |
| `Salli` | Neural | Female | American |
| `Russell` | Standard | Male | Australian |
| `Amy` | Standard | Female | British |
| ... | ... | ... | 100+ total |

### Why Polly is a strong option

1. **5M Standard chars/month is permanent** (not 12-month limited)
2. **100+ voices** — good variety
3. **SSML support** — full prosody control
4. **$200 free credits** for new AWS accounts (covers Neural voices for months)

### Drawbacks

1. **Standard voices sound robotic** — you'd want Neural, but that's only free for 12 months
2. **AWS account complexity** — IAM, regions, billing setup is heavier than Google
3. **After 12 months**, Neural costs $16/1M (2.25M × $16 = $36/month for 5 users)
4. **Credit card required**

---

## 5. Piper — Self-Hosted, Unlimited, CPU-Fast

| Feature | Value |
|---------|-------|
| License | GPL-3.0 (OHF-Voice/piper1-gpl fork) |
| Cost | **$0 forever** |
| Limits | **None** — unlimited |
| Voices | **100+ voices** across 30+ languages |
| Quality | Good (VITS architecture, 22.05 kHz medium tier) |
| Latency | **Real-time on CPU** (RTF 0.192 = 5× faster than audio length) |
| Hardware | **CPU only** — no GPU needed, runs on Raspberry Pi 4 |
| Voice cloning | No (but 100+ pre-trained voices) |
| Self-host | Yes — `pip install piper-tts` or binary download |

### Piper for NEXUS

Piper is the **fastest** self-hosted option — it runs in real-time on CPU, even on a Raspberry Pi. For NEXUS, you could:
- Bundle Piper as a sidecar (like the STT server)
- 100+ voices means each user can have a unique voice
- Zero latency (local), zero cost, zero internet dependency

### Piper voice quality tiers

| Tier | Sample rate | Model size | Quality | Speed |
|------|-------------|------------|---------|-------|
| `x_low` | 16 kHz | ~15 MB | Telephony | Fastest |
| `low` | 16 kHz | ~30 MB | Basic | Very fast |
| `medium` | 22.05 kHz | ~60 MB | **Good (recommended)** | Real-time on CPU |
| `high` | 22.05 kHz | ~100 MB | Better | Slightly slower |

### Best Piper English voices (from community ranking)

| Voice | Quality | Gender | Notes |
|-------|---------|--------|-------|
| `en_US-libritts-high` | High | Multi-speaker | Audiobook-grade |
| `en_US-lessac-medium` | Medium | Female | Natural, recommended default |
| `en_US-ryan-medium` | Medium | Male | Clear, professional |
| `en_US-ljspeech-medium` | Medium | Female | Classic TTS voice |
| `en_US-sam-medium` | Medium | Male | Deep |
| `en_GB-alan-medium` | Medium | Male | British |
| `en_GB-jenny_dioco-medium` | Medium | Female | British |

### Why Piper is a strong option

1. **Truly unlimited** — no caps, no fair use, no API key
2. **CPU-only** — no GPU needed, perfect for laptops
3. **100+ voices** — massive variety
4. **Real-time on CPU** — 0.54s for a short sentence on a Pi 5
5. **Offline** — no internet needed

### Drawbacks

1. **GPL-3.0 license** — if NEXUS is closed-source, this creates licensing issues (Apache 2.0 Kokoro doesn't)
2. **Quality is "good" not "excellent"** — noticeably below Kokoro, Fish Audio, ElevenLabs
3. **No voice cloning** — you're limited to the 100+ pre-trained voices
4. **Requires bundling** — need to ship Piper + voice models with NEXUS

---

## 6. Azure TTS — Good Quality, Small Free Tier

| Feature | Value |
|---------|-------|
| Free tier | **500K chars/month** (permanent) |
| Your usage | 2.25M chars/month → **4.5× over free tier** ❌ |
| Voices | **500+ neural voices** across 140+ languages |
| Quality | Very Good (Neural), Excellent (Neural HD) |
| Price after free | $16/1M (Neural), $22/1M (Neural HD) |
| SSML | Best in class — speaking styles (cheerful, sad, whisper) |

### Why Azure doesn't work for 5 users

500K chars/month covers only ~1,667 calls — less than 1 day of usage for 5 people. You'd pay $16/1M for the remaining 1.75M chars = **$28/month**. Not terrible, but Google (5M free) and Polly (5M free) are much better deals.

---

## 7. Hugging Face Inference API — Free but Rate-Limited

| Feature | Value |
|---------|-------|
| Free tier | ~few hundred requests/hour (rate-limited) |
| Models | Bark, SpeechT5, MMS-TTS, and many community models |
| Quality | Varies by model (Bark = excellent, MMS = basic) |
| API | `InferenceClient.text_to_speech()` |
| Commercial | Depends on model license |

### Why Hugging Face is risky for production

1. **Rate limits are vague** — "few hundred requests per hour" with no hard number
2. **Not designed for production** — HF explicitly says "for testing and evaluation"
3. **No SLA** — could be throttled or unavailable
4. **Bark is slow** — generates non-speech sounds (laughs, sighs) which is cool but unpredictable

### Could work as a fallback, not a primary provider.

---

## 8. Coqui XTTS-v2 — Self-Hosted Voice Cloning

| Feature | Value |
|---------|-------|
| License | **Coqui Public Model License (CPML) — NON-COMMERCIAL** |
| Cost | $0 (non-commercial only) |
| Feature | **Zero-shot voice cloning** (6-10s reference audio) |
| Languages | 17 |
| Quality | Excellent |
| Hardware | 4-8 GB GPU VRAM recommended (CPU works but slow) |

### Why Coqui doesn't work for NEXUS

1. **Non-commercial license** — NEXUS is a product, CPML prohibits commercial use
2. **Needs GPU** — 4-8 GB VRAM, not practical for all users
3. **CPU inference is slow** — several seconds per sentence

---

## 9. ElevenLabs — Already Covered (doc 23)

Free tier: 10K chars/month, **no API access on free plan**. Useless for NEXUS without $5/mo Starter.

---

## 10. TTSMaker — Free with Attribution

| Feature | Value |
|---------|-------|
| Free tier | Unlimited (with attribution) |
| Voices | Limited selection |
| Quality | Fair |
| Attribution | Must credit TTSMaker in output |

### Why TTSMaker doesn't work for NEXUS

Attribution requirement means NEXUS would need to say "Powered by TTSMaker" — not suitable for a voice assistant.

---

## Comparison Matrix — All 10 Providers

| Provider | Free chars/mo | Permanent? | Voices | Quality | API | Commercial | Self-host? | Your fit (2.25M/mo) |
|----------|--------------|------------|--------|---------|-----|------------|------------|---------------------|
| **Kokoro** | ∞ | ✅ Apache 2.0 | 54 | Excellent | ✅ | ✅ | ✅ CPU | ✅ Perfect |
| **Fish Audio Free** | ∞ (Fair Use) | ⚠️ Aug 31 | ∞ (cloning) | Excellent | ✅ | ✅ | ❌ | ✅ Perfect |
| **Google Cloud** | 5M | ✅ Permanent | 700+ | Very Good | ✅ | ✅ | ❌ | ✅ 45% of free |
| **Amazon Polly** | 5M (Standard) | ✅ Standard perm. | 100+ | Good | ✅ | ✅ | ❌ | ✅ 45% of free |
| **Piper** | ∞ | ✅ GPL-3.0 | 100+ | Good | ✅ | ⚠️ GPL | ✅ CPU | ✅ Perfect |
| **Azure** | 500K | ✅ Permanent | 500+ | Very Good | ✅ | ✅ | ❌ | ❌ 4.5× over |
| **Hugging Face** | Rate-limited | ✅ Permanent | Varies | Varies | ✅ | Varies | ❌ | ⚠️ Unreliable |
| **Coqui XTTS** | ∞ | ❌ Non-commercial | Cloning | Excellent | ✅ | ❌ | ✅ GPU | ❌ License |
| **ElevenLabs** | 10K | ✅ Permanent | 29 | Excellent | ❌ Free | ❌ Free | ❌ | ❌ No API |
| **TTSMaker** | ∞ | ✅ Permanent | Limited | Fair | ✅ | ⚠️ Attribution | ❌ | ⚠️ Attribution |

---

## Recommended Strategy for NEXUS — Multi-Tier Fallback

Instead of picking one provider, NEXUS should use a **tiered fallback chain**:

```
User speaks → NEXUS responds → TTS:

1st: Kokoro (self-hosted, local)     ← Always available, $0, unlimited
     ↓ (if Kokoro server not running)
2nd: Fish Audio s2.1-pro-free        ← Free API, excellent quality, cloning
     ↓ (if Fish Audio throttled/down)
3rd: Google Cloud TTS (WaveNet)      ← 5M chars/mo free, 700+ voices
     ↓ (if Google quota exceeded)
4th: Web Speech API (browser)        ← Always available, offline, basic quality
```

### Why this strategy is best

1. **Kokoro as primary** = zero cost, zero latency, zero dependency, unlimited
2. **Fish Audio as secondary** = best hosted quality, voice cloning, free
3. **Google Cloud as tertiary** = massive voice variety, permanent free tier
4. **Web Speech as last resort** = always works, no setup needed

### Each user can choose their preferred voice from ANY tier

- User 1: Kokoro `bm_george` (British butler)
- User 2: Fish Audio custom cloned voice
- User 3: Google Cloud `en-US-Wavenet-D` (American male)
- User 4: Kokoro `af_heart` (American female)
- User 5: Piper `en_US-ryan-medium` (if bundled)

---

## Implementation Plan (when approved)

### Phase 1: Add Kokoro as primary TTS (1-2 hours)

1. Add `kokoro-tts` as a sidecar (like the STT server) OR use a hosted Kokoro API
2. Add `playKokoro()` function in `ttsPlayer.ts`
3. Add Kokoro voices to `CURATED_VOICES`
4. Make Kokoro the default provider

**Option A — Bundle Kokoro-FastAPI as sidecar:**
```yaml
# docker-compose.yml or sidecar script
services:
  kokoro-tts:
    image: remsky/kokoro-fastapi:latest
    ports: ["8880:8880"]
```

**Option B — Use hosted Kokoro API (rekam.ai or self-hosted VPS):**
```typescript
async function playKokoro(text: string, voice: string, onEnd?: () => void) {
  const response = await fetch("http://localhost:8880/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "kokoro", input: text, voice }),
  });
  const blob = await response.blob();
  return playAudioUrl(URL.createObjectURL(blob), onEnd);
}
```

### Phase 2: Add Google Cloud TTS (30 minutes)

1. Add `playGoogleCloudTTS()` function in `ttsPlayer.ts`
2. Add Google Cloud voices to `CURATED_VOICES`
3. User provides their own Google Cloud API key in settings

```typescript
async function playGoogleCloudTTS(text: string, voiceId: string, apiKey: string) {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "en-US", name: voiceId },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
      }),
    }
  );
  const data = await response.json();
  const audio = `data:audio/mp3;base64,${data.audioContent}`;
  return playAudioUrl(audio);
}
```

### Phase 3: Switch Fish Audio to free model (1 minute)

Change `model: "s2.1-pro"` → `model: "s2.1-pro-free"` in `ttsPlayer.ts`

### Phase 4: Update fallback chain (15 minutes)

Update `speak()` function to try providers in order:
```typescript
export async function speak(text: string, onEnd?: () => void) {
  // 1. Try Kokoro (local, free, unlimited)
  if (await tryKokoro(text, onEnd)) return;
  // 2. Try Fish Audio Free (hosted, free)
  if (await tryFishAudio(text, onEnd)) return;
  // 3. Try Google Cloud (5M free chars/mo)
  if (await tryGoogleCloud(text, onEnd)) return;
  // 4. Fall back to Web Speech (always available)
  return playWebSpeech(text, CURATED_VOICES[0], onEnd);
}
```

### Phase 5: Update Settings/Setup (30 minutes)

- Add provider selection (Kokoro / Fish Audio / Google Cloud / Web Speech)
- Add API key fields for each provider
- Add voice picker with preview for each provider
- Default: Kokoro (if running) → Fish Audio Free → Google Cloud → Web Speech

---

## File Changes Summary

| File | Phase | Change |
|------|-------|--------|
| `frontend/src/audio/ttsPlayer.ts` | 1 | Add `playKokoro()`, Kokoro voices |
| `frontend/src/audio/ttsPlayer.ts` | 2 | Add `playGoogleCloudTTS()`, Google voices |
| `frontend/src/audio/ttsPlayer.ts` | 3 | Fish Audio `s2.1-pro` → `s2.1-pro-free` |
| `frontend/src/audio/ttsPlayer.ts` | 4 | Update `speak()` with tiered fallback |
| `frontend/src/audio/ttsPlayer.ts` | 4 | Remove hardcoded Gemini key |
| `frontend/src/settings/SettingsApp.tsx` | 5 | Add provider/voice selection UI |
| `frontend/src/setup/SetupApp.tsx` | 5 | Add TTS provider setup step |
| `src-tauri/src/commands.rs` | 5 | Add Google Cloud API key to settings struct |
| `src-tauri/src/commands.rs` | 5 | Add Kokoro server URL to settings |

---

## Final Recommendation

**For truly free forever with no limits: Kokoro (self-hosted) is the answer.**

- Apache 2.0 license = commercial use, no restrictions
- 82M params = runs on CPU, no GPU needed
- 54 voices across 8 languages
- Unlimited characters, unlimited calls
- No API key, no signup, no credit card
- Can be bundled as a sidecar or hosted on a $5/mo VPS

**For best quality with free hosted API: Fish Audio `s2.1-pro-free`**

- Same model as paid tier
- Voice cloning included
- ~100ms TTFA with streaming
- Free through Aug 31 (likely to continue)

**For massive voice variety with permanent free tier: Google Cloud TTS**

- 700+ voices, 40+ languages
- 5M chars/month free (permanent)
- WaveNet quality at $4/1M if you exceed free tier

**Best strategy: Use all three in a fallback chain.** Kokoro as primary (free, local, unlimited), Fish Audio as secondary (best quality), Google Cloud as tertiary (voice variety). Web Speech as last resort.
