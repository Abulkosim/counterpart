// A scan of file content for things that look like credentials. A file that
// trips it is never shown to the model. It catches the common shapes: known
// token prefixes, private key blocks, credentials in URLs, and long random
// values assigned to names like "secret" or "token". It cannot catch a secret
// with no recognisable shape, which is why only committed files the owner
// named are read in the first place.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, "a private key"],
  [/\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "a GitLab token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/, "a Slack webhook"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/, "a Stripe key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/, "an OpenAI-style key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, "a Google OAuth token"],
  [/"type"\s*:\s*"service_account"/, "a cloud service account file"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
  [/\bpypi-[A-Za-z0-9_-]{50,}/, "a PyPI token"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, "a SendGrid key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed token (JWT)"],
  [/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`]{1,64}:[^\s:/@"'`]{3,128}@[^\s/"'`]+/i, "a password in a URL"],
  [/\b(cpart-invite|CPART_PASSPHRASE)[:=]\s*\S{8,}/, "a Counterpart invite or passphrase"],
];

// name = "value" where the name says secret and the value looks random.
const ASSIGNED = /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_\-.~]{16,})/gi;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// Values that are plainly not secrets: placeholders, references to other
// variables, identifiers made only of letters and underscores.
function looksRandom(v: string): boolean {
  if (/^(x+|\*+|\.+|_+|-+)$/i.test(v)) return false;
  if (/^(process\.env|env\.|os\.environ|getenv|config\.|settings\.|self\.|this\.)/i.test(v)) return false;
  if (/^[A-Za-z_]+$/.test(v)) return false; // a word or an identifier, not a key
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return entropy(v) >= 3.5;
}

export interface SecretHit {
  line: number;
  what: string;
}

// The first thing in `text` that looks like a credential, or null.
export function findSecret(text: string): SecretHit | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    for (const [re, what] of PATTERNS) if (re.test(l)) return { line: i + 1, what };
    for (const m of l.matchAll(ASSIGNED)) if (looksRandom(m[2]!)) return { line: i + 1, what: `a value assigned to ${m[1]!.slice(0, 40)}` };
  }
  return null;
}
