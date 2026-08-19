/**
 * Local intent parser — regex-based command matching with phonetic fallback.
 *
 * Works without a backend. Parses the STT transcript into a structured
 * intent that can be executed locally (open app, open URL, search, etc.)
 *
 * 3-TIER RESOLUTION: All "open <app>" commands are sent to Rust as
 * `open_app` intents. The Rust command_executor resolves them in order:
 *   Tier 1: Is the app already running? → Focus its window
 *   Tier 2: Is the app installed? → Launch the native app
 *   Tier 3: Is there a URL fallback? → Open in browser
 *   Tier 4: Not found → Speak error
 *
 * PHONETIC MATCHING: If the STT transcript contains a word that sounds like
 * a known app name (e.g. "gamail" → "gmail"), the phonetic matcher corrects
 * it before sending to Rust. This handles mispronunciations and accents
 * without requiring any model training.
 *
 * If no local intent matches, returns {action:"unknown"} so the caller
 * can fall through to the remote backend (if available).
 */

export type Intent =
  | { action: "open_app"; target: string }
  | { action: "open_url"; target: string; url: string }
  | { action: "search"; query: string }
  | { action: "unknown"; raw: string };

/**
 * Apps that have a known URL fallback. The Rust command_executor also
 * has this list — it's duplicated here so the frontend can still send
 * `open_url` directly if needed (e.g. for explicit "open website" commands).
 */
const URL_MAP: Record<string, string> = {
  gmail: "https://mail.google.com",
  "google mail": "https://mail.google.com",
  youtube: "https://www.youtube.com",
  "you tube": "https://www.youtube.com",
  github: "https://github.com",
  "git hub": "https://github.com",
  twitter: "https://twitter.com",
  x: "https://x.com",
  facebook: "https://facebook.com",
  instagram: "https://instagram.com",
  reddit: "https://reddit.com",
  linkedin: "https://linkedin.com",
  whatsapp: "https://web.whatsapp.com",
  "whatsapp web": "https://web.whatsapp.com",
  spotify: "https://open.spotify.com",
  netflix: "https://netflix.com",
  amazon: "https://amazon.com",
  "google drive": "https://drive.google.com",
  "google docs": "https://docs.google.com",
  "google sheets": "https://sheets.google.com",
  "google slides": "https://slides.google.com",
  "google maps": "https://maps.google.com",
  "google calendar": "https://calendar.google.com",
  "google translate": "https://translate.google.com",
  "google photos": "https://photos.google.com",
  "google news": "https://news.google.com",
  "google meet": "https://meet.google.com",
  "google chat": "https://chat.google.com",
  "google play": "https://play.google.com",
  "google play store": "https://play.google.com",
  "play store": "https://play.google.com",
  "app store": "https://apps.apple.com",
  "mac app store": "https://apps.apple.com",
  chatgpt: "https://chat.openai.com",
  "chat gpt": "https://chat.openai.com",
  "open ai": "https://chat.openai.com",
  openai: "https://chat.openai.com",
  claude: "https://claude.ai",
  figma: "https://figma.com",
  notion: "https://notion.so",
  slack: "https://slack.com",
  discord: "https://discord.com/app",
  twitch: "https://twitch.tv",
  "stack overflow": "https://stackoverflow.com",
  stackoverflow: "https://stackoverflow.com",
  wikipedia: "https://wikipedia.org",
  chat: "https://chat.google.com",
  maps: "https://maps.google.com",
  translate: "https://translate.google.com",
  "my drive": "https://drive.google.com",
  calendar: "https://calendar.google.com",
};

// ─── Phonetic matching (DoubleMetaphone) ───────────────────────────────────
//
// When Whisper mishears a word (e.g. "gamail" instead of "gmail"), the
// phonetic matcher corrects it. DoubleMetaphone converts words to their
// phonetic root codes — words that sound the same get the same code.
//
// Example: "gmail" → "KML", "gamail" → "KML" → match!
//
// This is a compact implementation of Lawrence Philips' Double Metaphone
// algorithm. No external dependency needed.

/**
 * Stop words — common verbs, prepositions, and everyday English words that
 * should NEVER be corrected to app names by the phonetic matcher.
 * Without this, "open" matches "openai" phonetically (both → "APN").
 */
const PHONETIC_STOP_WORDS = new Set([
  // Command verbs
  "open", "close", "launch", "start", "run", "stop", "play", "pause",
  "search", "find", "show", "hide", "bring", "fire", "shut", "turn",
  "set", "get", "go", "put", "take", "make", "give", "send", "tell",
  // Common English words that sound like app names
  "up", "down", "in", "out", "on", "off", "to", "for", "the", "a", "an",
  "my", "your", "this", "that", "it", "is", "and", "or", "not", "do",
  "me", "we", "he", "she", "all", "can", "will", "new", "now", "please",
  "ok", "hey", "hi", "yes", "no", "maybe", "just", "very", "well",
  // Commonly confused with app names
  "check", "tab", "page", "window", "app", "site", "web", "mail",
]);

/** Known app names for phonetic matching. Keys are canonical names. */
const KNOWN_APPS: string[] = [
  "gmail", "youtube", "github", "google", "chrome", "brave", "firefox",
  "twitter", "instagram", "facebook", "reddit", "linkedin", "whatsapp",
  "netflix", "amazon", "wikipedia", "twitch", "spotify", "discord",
  "slack", "notion", "figma", "chatgpt", "claude", "gemini",
  "drive", "docs", "sheets", "slides", "maps", "calendar", "translate",
  "photos", "meet", "chat", "notepad", "calculator", "explorer",
  "terminal", "powershell", "paint", "settings", "outlook", "word",
  "excel", "powerpoint", "vscode", "code", "steam", "zoom", "teams",
  "skype", "telegram", "edge", "opera", "safari", "blender", "unity",
  "docker", "postman", "obs", "vlc",
];

/** Multi-word app names that should be matched as phrases. */
const KNOWN_PHRASES: string[] = [
  "google mail", "you tube", "git hub", "whatsapp web", "google drive",
  "google docs", "google sheets", "google slides", "google maps",
  "google calendar", "google translate", "google photos", "google news",
  "google meet", "google chat", "google play", "play store", "app store",
  "mac app store", "chat gpt", "open ai", "stack overflow", "visual studio code",
  "file explorer", "command prompt", "task manager", "control panel",
  "windows terminal", "google gemini",
];

/** Pre-computed metaphone codes for known apps (built once on module load). */
const APP_PHONETIC_INDEX: Map<string, string[]> = new Map(
  [...KNOWN_APPS, ...KNOWN_PHRASES].map((app) => [app, doubleMetaphone(app)]),
);

/**
 * Correct a single word to the closest known app name using phonetic matching.
 * Returns the corrected word, or the original if no match is close enough.
 */
function phoneticCorrectWord(word: string): string {
  if (!word || word.length < 2) return word;
  // Never correct common English words — they aren't app names.
  if (PHONETIC_STOP_WORDS.has(word.toLowerCase())) return word;
  const codes = doubleMetaphone(word);
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [app, appCodes] of APP_PHONETIC_INDEX) {
    // Compare all code combinations (primary×primary, primary×secondary, etc.)
    for (const code of codes) {
      for (const appCode of appCodes) {
        if (!code || !appCode) continue;
        if (code === appCode) {
          // Exact phonetic match — prefer shorter app names (closer to the word)
          const score = word.length === app.length ? 3 : 2;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = app;
          }
        } else if (code.length > 1 && appCode.length > 1) {
          // Partial match — first 2 chars of metaphone code match
          if (code.substring(0, 2) === appCode.substring(0, 2)) {
            // Also check Levenshtein distance for extra confidence
            const dist = levenshtein(word, app);
            if (dist <= 2 && dist < word.length / 2) {
              const score = 1;
              if (score > bestScore) {
                bestScore = score;
                bestMatch = app;
              }
            }
          }
        }
      }
    }
  }

  // Only correct if we found a confident match (score >= 2 = exact phonetic match)
  if (bestMatch && bestScore >= 2) {
    return bestMatch;
  }
  return word;
}

/**
 * Correct a phrase (possibly multi-word) to the closest known app name.
 * Tries multi-word phrase matching first, then word-by-word correction.
 */
function phoneticCorrectPhrase(phrase: string): string {
  const trimmed = phrase.trim().toLowerCase();

  // 1. Try exact match first (most common case — Whisper got it right)
  if (APP_PHONETIC_INDEX.has(trimmed)) {
    return trimmed;
  }

  // 2. Try multi-word phrase phonetic match
  const phraseCodes = doubleMetaphone(trimmed);
  for (const [app, appCodes] of APP_PHONETIC_INDEX) {
    if (app.includes(" ")) {
      for (const code of phraseCodes) {
        for (const appCode of appCodes) {
          if (code && appCode && code === appCode) {
            return app;
          }
        }
      }
    }
  }

  // 3. Try word-by-word correction
  const words = trimmed.split(/\s+/);
  let anyCorrected = false;
  const correctedWords = words.map((w) => {
    const cw = phoneticCorrectWord(w);
    if (cw !== w) {
      console.log(`[NEXUS] phonetic match: "${w}" → "${cw}"`);
      anyCorrected = true;
    }
    return cw;
  });

  if (anyCorrected) {
    const result = correctedWords.join(" ");
    // Check if the corrected phrase is a known multi-word app
    if (APP_PHONETIC_INDEX.has(result)) {
      return result;
    }
    return result;
  }

  return trimmed;
}

// ─── Double Metaphone algorithm (Lawrence Philips, 2000) ───────────────────
// Compact implementation — converts words to phonetic root codes.
// Words that sound the same produce the same code, regardless of spelling.

function doubleMetaphone(word: string): string[] {
  const w = word.toUpperCase().replace(/[^A-Z]/g, "");
  if (w.length === 0) return ["", ""];

  const primary: string[] = [];
  const secondary: string[] = [];
  let current = 0;
  const length = w.length;

  // Handle silent initials
  if (w.match(/^(GN|KN|PN|WR|PS)/)) {
    current = 1;
  }

  // Handle 'X' at start → 'S'
  if (w[0] === "X") {
    add("S");
    add("Z");
    current = 1;
  }

  while (current < length && (primary.length < 4 || secondary.length < 4)) {
    const c = w[current];
    const prev = current > 0 ? w[current - 1] : "";
    const next = current + 1 < length ? w[current + 1] : "";
    const next2 = current + 2 < length ? w[current + 2] : "";

    switch (c) {
      case "A":
      case "E":
      case "I":
      case "O":
      case "U":
      case "Y":
        if (current === 0) { add("A"); }
        current++;
        break;

      case "B":
        add("P");
        current += (c === "B" && next === "B") ? 2 : 1;
        break;

      case "C":
        if (current > 0 && w.slice(current, current + 2) === "CH") {
          add("X");
          current += 2;
        } else if (current > 0 && w.slice(current, current + 2) === "CI") {
          add("S");
          current += 2;
        } else if (current > 0 && w.slice(current, current + 2) === "CE") {
          add("S");
          current += 2;
        } else if (w.slice(current, current + 3) === "CIA") {
          add("X");
          current += 3;
        } else if (next === "H") {
          add("X");
          current += 2;
        } else if (next === "I" || next === "E" || next === "Y") {
          add("S");
          current += 2;
        } else {
          add("K");
          current += 1;
        }
        break;

      case "D":
        if (next === "G" && (next2 === "I" || next2 === "E" || next2 === "Y")) {
          add("J");
          current += 3;
        } else {
          add("T");
          current += (next === "D") ? 2 : 1;
        }
        break;

      case "F":
        add("F");
        current += (next === "F") ? 2 : 1;
        break;

      case "G":
        if (next === "H" && current > 0 && !isVowel(prev)) {
          add("K");
          current += 2;
        } else if (next === "H" && current + 2 < length && !isVowel(next2)) {
          add("K");
          current += 2;
        } else if (current > 0 && w.slice(current, current + 2) === "GN") {
          add("N");
          current += 2;
        } else if (next === "I" || next === "E" || next === "Y") {
          add("J");
          current += 2;
        } else {
          add("K");
          current += (next === "G") ? 2 : 1;
        }
        break;

      case "H":
        if (current === 0 && isVowel(next)) {
          add("H");
          current += 2;
        } else if (current > 0 && !isVowel(prev)) {
          add("H");
          current += 1;
        } else {
          current += 1;
        }
        break;

      case "J":
        add("J");
        current += (next === "J") ? 2 : 1;
        break;

      case "K":
        add("K");
        current += (next === "K") ? 2 : 1;
        break;

      case "L":
        add("L");
        current += (next === "L") ? 2 : 1;
        break;

      case "M":
        add("M");
        current += (next === "M") ? 2 : 1;
        break;

      case "N":
        add("N");
        current += (next === "N") ? 2 : 1;
        break;

      case "P":
        if (next === "H") {
          add("F");
          current += 2;
        } else {
          add("P");
          current += (next === "P") ? 2 : 1;
        }
        break;

      case "Q":
        add("K");
        current += (next === "Q") ? 2 : 1;
        break;

      case "R":
        add("R");
        current += (next === "R") ? 2 : 1;
        break;

      case "S":
        if (next === "H") {
          add("X");
          current += 2;
        } else if (next === "I" && (next2 === "O" || next2 === "A")) {
          add("X");
          current += 3;
        } else {
          add("S");
          current += (next === "S") ? 2 : 1;
        }
        break;

      case "T":
        if (next === "H") {
          add("0"); // 'TH' → theta
          current += 2;
        } else if (next === "I" && (next2 === "O" || next2 === "A")) {
          add("X");
          current += 3;
        } else {
          add("T");
          current += (next === "T") ? 2 : 1;
        }
        break;

      case "V":
        add("F");
        current += (next === "V") ? 2 : 1;
        break;

      case "W":
      case "Y":
        if (current === 0 && isVowel(next)) {
          add("A");
        }
        current += 1;
        break;

      case "X":
        add("K");
        add("S");
        current += (next === "X") ? 2 : 1;
        break;

      case "Z":
        add("S");
        current += (next === "Z") ? 2 : 1;
        break;

      default:
        current += 1;
        break;
    }
  }

  function add(c: string) {
    if (primary.length < 4) primary.push(c);
    if (secondary.length < 4) secondary.push(c);
  }

  function isVowel(ch: string): boolean {
    return "AEIOUY".includes(ch);
  }

  const p = primary.join("");
  const s = secondary.join("");
  return [p, s === p ? "" : s];
}

/** Levenshtein edit distance — used as a secondary check for phonetic matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

/**
 * Parse a transcript into a structured intent.
 *
 * @param transcript - The STT transcript text (e.g. "open gmail")
 * @returns A structured Intent, or {action:"unknown"} if no match
 */
export function parseIntent(transcript: string): Intent {
  const text = transcript.trim().toLowerCase().replace(/\s+/g, " ");

  // --- "open <something>" ---
  // Matches: "open gmail", "open notepad", "open calculator", "open youtube"
  // All "open" commands go through the 3-tier resolution in Rust:
  //   running → installed → browser fallback → not found
  const openMatch = text.match(
    /^(?:open|launch|start|run|fire up|bring up)\s+(.+)$/i,
  );
  if (openMatch) {
    const target = openMatch[1].trim();

    // Strip trailing "app" or "application" — "open gmail app" → "gmail"
    const cleaned = target.replace(/\s+(?:app|application)$/i, "");

    // PHONETIC CORRECTION: If Whisper misheard the app name (e.g. "gamail"
    // instead of "gmail"), correct it using DoubleMetaphone matching.
    // This runs AFTER regex matching but BEFORE sending to Rust, so the
    // Rust resolver receives the canonical app name.
    const corrected = phoneticCorrectPhrase(cleaned);
    if (corrected !== cleaned) {
      console.log(`[NEXUS] phonetic correction: "${cleaned}" → "${corrected}"`);
    }

    // All "open" commands go to Rust as open_app.
    // Rust handles: running check → installed check → URL fallback.
    return { action: "open_app", target: corrected };
  }

  // --- "go to <url>" / "visit <url>" / "browse to <url>" ---
  // These are explicit URL commands — send directly as open_url.
  const urlMatch = text.match(
    /^(?:go\s+to|visit|browse\s+to|navigate\s+to)\s+(.+)$/i,
  );
  if (urlMatch) {
    const target = urlMatch[1].trim();
    const url = URL_MAP[target];
    if (url) {
      return { action: "open_url", target, url };
    }
    // If it looks like a URL, use it directly
    if (target.includes(".") && !target.includes(" ")) {
      const fullUrl = target.startsWith("http") ? target : `https://${target}`;
      return { action: "open_url", target, url: fullUrl };
    }
    // Otherwise treat as app name
    return { action: "open_app", target };
  }

  // --- "search for <query>" ---
  // Matches: "search for cats", "google cats", "look up cats"
  const searchMatch = text.match(
    /^(?:search\s+for|search|google|look\s+up|find\s+me|find)\s+(.+)$/i,
  );
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return {
      action: "search",
      query,
    };
  }

  // --- No local intent matched ---
  return { action: "unknown", raw: transcript };
}
