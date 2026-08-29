# Tier 3 Testing Strategy

> How to verify that the Tier 3 command classifiers work correctly,
> don't produce false positives, and deliver the expected latency
> improvement without breaking the existing STT fallback path.

---

## 1. Test Categories

| Category | What it tests | Priority |
|----------|--------------|----------|
| **Functional** | Command detected → correct intent → action executed | P0 |
| **Latency** | Wake-to-action time < 500ms for known commands | P0 |
| **False positives** | Random speech doesn't trigger commands | P0 |
| **Cross-command** | "open youtube" doesn't trigger "open gmail" | P0 |
| **Fallback** | Unknown commands still work via STT | P1 |
| **Resource** | RAM/CPU within expected bounds | P1 |
| **Edge cases** | Silence, noise, partial phrases | P2 |
| **Regression** | Existing wake word + STT + app launch still work | P0 |

---

## 2. Functional Tests

### Test 2.1: Known command — app already running

**Steps:**
1. Open YouTube in browser
2. Say "NEXUS" (wake word)
3. Wait for wake confirmation
4. Say "open youtube"

**Expected:**
- Command classifier fires within ~200ms
- YouTube window is focused (not a new window)
- "Ok sir." is spoken
- No STT server call (check logs for absence of STT request)

**Pass criteria:**
- YouTube window comes to foreground
- Log shows: `Tier 3: command detected → CommandIntent { action: "open_app", target: "youtube" }`
- Log does NOT show: `sending audio to local STT`

### Test 2.2: Known command — app not running

**Steps:**
1. Close all YouTube/Brave windows
2. Say "NEXUS"
3. Say "open youtube"

**Expected:**
- Command classifier fires
- YouTube is launched (new window or browser tab)
- "Ok sir." is spoken

**Pass criteria:**
- YouTube opens in a new window/tab
- Log shows command detection + app launch

### Test 2.3: Known command — URL fallback

**Steps:**
1. Uninstall any YouTube app (if applicable)
2. Say "NEXUS"
3. Say "open figma" (assuming no Figma desktop app installed)

**Expected:**
- Command classifier fires
- Figma opens in default browser as URL fallback
- "Ok sir." is spoken

**Pass criteria:**
- Browser opens https://figma.com
- Log shows: `Tier 3: command detected` → `URL fallback: https://figma.com`

### Test 2.4: Unknown command — STT fallback

**Steps:**
1. Say "NEXUS"
2. Say "what's the weather today" (not a trained command)

**Expected:**
- No command classifier fires
- Falls back to STT
- STT transcribes the query
- Query is sent to backend or handled locally

**Pass criteria:**
- Log shows: STT request sent, transcript received
- Log does NOT show: `Tier 3: command detected`
- Response is spoken via TTS

### Test 2.5: Each trained command

**Steps:**
For each of the 10 trained commands:
1. Say "NEXUS"
2. Say the command phrase

**Expected:**
- Correct command classifier fires
- Correct app/url is focused/launched/opened

**Commands to test:**
| # | Phrase | Expected action |
|---|--------|----------------|
| 1 | "open youtube" | Focus/launch YouTube |
| 2 | "open gmail" | Focus/launch Gmail |
| 3 | "open chrome" | Focus/launch Chrome |
| 4 | "open notepad" | Focus/launch Notepad |
| 5 | "open calculator" | Focus/launch Calculator |
| 6 | "open spotify" | Focus/launch Spotify |
| 7 | "open discord" | Focus/launch Discord |
| 8 | "open github" | Focus/launch GitHub |
| 9 | "open vscode" | Focus/launch VS Code |
| 10 | "open figma" | Focus/launch Figma |

---

## 3. Latency Tests

### Test 3.1: Wake-to-action latency (known command)

**Steps:**
1. Start NEXUS with logging enabled
2. Say "NEXUS" then "open youtube" in one fluid motion
3. Note the time when YouTube window appears
4. Check logs for timestamps

**Expected:**
- Total latency < 500ms from end of speech to window focus

**Measurement points:**
```
T0: OWW command classifier fires (log: "Tier 3: command detected")
T1: Tauri event emitted (log: "emitting command-detected event")
T2: Frontend receives event (log: "Tier 3 command detected: open_app → youtube")
T3: execute_command invoked
T4: App focused/launched
```

**Pass criteria:**
- T4 - T0 < 500ms
- T0 - (end of speech) < 200ms

### Test 3.2: Comparison with STT fallback

**Steps:**
1. Say "NEXUS" then "open youtube" → measure latency (Tier 3 path)
2. Disable Tier 3 (empty command_intents.json)
3. Say "NEXUS" then "open youtube" → measure latency (STT path)
4. Compare

**Expected:**
- Tier 3 path: < 500ms
- STT path: > 2000ms (even with tuned config)

### Test 3.3: Multiple commands in sequence

**Steps:**
1. Say "NEXUS" → "open youtube"
2. Immediately say "NEXUS" → "open gmail"
3. Immediately say "NEXUS" → "open notepad"

**Expected:**
- Each command fires correctly
- Refractory period (2s) doesn't block the next command
- Each action completes in < 500ms

---

## 4. False Positive Tests

### Test 4.1: Silence

**Steps:**
1. Start NEXUS
2. Remain silent for 5 minutes
3. Check logs for any command detections

**Expected:**
- Zero command detections
- Zero wake detections (unless "nexus" is heard)

**Pass criteria:**
- No `Tier 3: command detected` in logs

### Test 4.2: Background conversation

**Steps:**
1. Start NEXUS
2. Have a 5-minute conversation about random topics (not commands)
3. Check logs for any false command detections

**Expected:**
- Zero command detections
- Maybe some wake-word false positives (acceptable if < 1/hour)

### Test 4.3: Similar-sounding phrases

**Steps:**
1. Say each of these (NOT preceded by "NEXUS"):
   - "open you too"
   - "open gee mail"
   - "open note book"
   - "open spot if i"
   - "open this cord"

**Expected:**
- No command should fire (these are adversarial negatives)
- If any fires, that model needs retraining with more negatives

**Pass criteria:**
- Zero false positives for adversarial negatives

### Test 4.4: Partial phrases

**Steps:**
1. Say (without "NEXUS" prefix):
   - "open" (just the verb)
   - "youtube" (just the noun)
   - "open you" (partial phrase)

**Expected:**
- No command should fire (too short / incomplete)

---

## 5. Cross-Command Discrimination Tests

### Test 5.1: "open youtube" doesn't trigger other commands

**Steps:**
1. Say "NEXUS" → "open youtube"
2. Check that ONLY `open_youtube` classifier fired

**Expected:**
- Log shows: `Tier 3: command detected → CommandIntent { action: "open_app", target: "youtube" }`
- Log does NOT show any other command detection

### Test 5.2: All 10 commands — one at a time

**Steps:**
For each of the 10 commands:
1. Say "NEXUS" → [command phrase]
2. Verify only the correct classifier fired
3. Verify the correct app/url was opened

**Pass criteria:**
- 10/10 correct detections
- 0/10 false detections of other commands

---

## 6. Fallback Path Tests

### Test 6.1: STT fallback works when no command matches

**Steps:**
1. Say "NEXUS" → "search for cats on youtube"

**Expected:**
- No command classifier fires ("search for" is not a trained command)
- STT fallback activates
- Transcript is parsed by intent parser
- Search action is executed

### Test 6.2: STT fallback works when command_intents.json is empty

**Steps:**
1. Replace `command_intents.json` with `{}`
2. Restart NEXUS
3. Say "NEXUS" → "open youtube"

**Expected:**
- Log shows: `Tier 3: no command classifiers found`
- Falls back to STT path
- STT transcribes "open youtube"
- Intent parser matches "open" pattern
- YouTube is focused/launched

### Test 6.3: Backend unavailable + no command match

**Steps:**
1. Stop the backend server
2. Say "NEXUS" → "what time is it"

**Expected:**
- No command classifier fires
- STT fallback activates
- Backend unavailable → local intent parser used
- "unknown" intent → "Didn't catch that, sir."

---

## 7. Resource Tests

### Test 7.1: RAM before/after loading command classifiers

**Steps:**
1. Start NEXUS with empty `command_intents.json` → measure RAM
2. Stop NEXUS
3. Populate `command_intents.json` with 10 models
4. Start NEXUS → measure RAM
5. Compare

**Expected:**
- RAM increase < 30 MB for 10 command models

**Measurement:**
```powershell
Get-Process -Name nexus |
  Select-Object @{N='WorkingSet(MB)';E={[math]::Round($_.WorkingSet64/1MB, 1)}}
```

### Test 7.2: CPU usage during idle

**Steps:**
1. Start NEXUS with 10 command classifiers loaded
2. Let it idle for 5 minutes (no wake word, no commands)
3. Measure CPU usage

**Expected:**
- CPU usage < 5% (OWW pipeline + 10 classifiers on 80ms chunks)

### Test 7.3: CPU usage during command detection

**Steps:**
1. Say "NEXUS" → "open youtube"
2. Measure CPU during detection

**Expected:**
- Brief CPU spike < 10% for ~80ms (classifier inference)
- No sustained CPU usage (unlike Whisper's 27s at 100%)

---

## 8. Regression Tests

### Test 8.1: Wake word still works

**Steps:**
1. Say "NEXUS" (without any command)

**Expected:**
- Wake word detected
- Overlay appears
- NEXUS starts listening
- STT path activates (no command to detect)

### Test 8.2: Hotkey still works

**Steps:**
1. Press Ctrl+Shift+Space

**Expected:**
- Same behavior as wake word
- Overlay appears, NEXUS listens

### Test 8.3: App launch still works via STT

**Steps:**
1. Empty `command_intents.json`
2. Say "NEXUS" → "open youtube"

**Expected:**
- STT transcribes "open youtube"
- Intent parser creates `{action: "open_app", target: "youtube"}`
- YouTube is focused/launched
- Same behavior as before Tier 3 was added

### Test 8.4: Speaker verification still works

**Steps:**
1. Enroll a voice profile
2. Say "NEXUS" (as enrolled user)
3. Say "NEXUS" (as different user)

**Expected:**
- Enrolled user: wake accepted
- Different user: wake rejected (if profile is enforced)

---

## 9. Test Execution Checklist

### Pre-test setup

- [ ] NEXUS compiled with latest code (`cargo check` passes)
- [ ] Frontend compiles (`tsc --noEmit` passes)
- [ ] Command models trained and placed in `resources/oww/commands/`
- [ ] `command_intents.json` populated with 10 commands
- [ ] STT server running (for fallback tests)
- [ ] Logging enabled (RUST_LOG=info or debug)

### Functional tests

- [ ] Test 2.1: Known command — app running → focus
- [ ] Test 2.2: Known command — app not running → launch
- [ ] Test 2.3: Known command — URL fallback
- [ ] Test 2.4: Unknown command — STT fallback
- [ ] Test 2.5: All 10 commands tested individually

### Latency tests

- [ ] Test 3.1: Wake-to-action < 500ms
- [ ] Test 3.2: Comparison with STT path
- [ ] Test 3.3: Multiple commands in sequence

### False positive tests

- [ ] Test 4.1: 5 minutes silence → 0 detections
- [ ] Test 4.2: 5 minutes conversation → 0 detections
- [ ] Test 4.3: Adversarial negatives → 0 detections
- [ ] Test 4.4: Partial phrases → 0 detections

### Cross-command tests

- [ ] Test 5.1: "open youtube" → only youtube fires
- [ ] Test 5.2: All 10 commands → correct classifier each time

### Fallback tests

- [ ] Test 6.1: Unknown command → STT fallback
- [ ] Test 6.2: Empty command_intents.json → STT fallback
- [ ] Test 6.3: Backend unavailable → local handling

### Resource tests

- [ ] Test 7.1: RAM increase < 30 MB
- [ ] Test 7.2: Idle CPU < 5%
- [ ] Test 7.3: Detection CPU < 10%

### Regression tests

- [ ] Test 8.1: Wake word works
- [ ] Test 8.2: Hotkey works
- [ ] Test 8.3: STT app launch works (empty commands)
- [ ] Test 8.4: Speaker verification works

---

## 10. Cross-References

- [11-testing-strategy.md](./11-testing-strategy.md) — Original wake-word testing strategy
- [14-model-validation-results.md](./14-model-validation-results.md) — Wake-word validation results
- [15-tier3-command-classifiers.md](./15-tier3-command-classifiers.md) — Tier 3 architecture
- [17-tier3-resource-analysis.md](./17-tier3-resource-analysis.md) — Resource analysis
