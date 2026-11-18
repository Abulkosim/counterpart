// A scan of file content for things that look like credentials. A file that
// trips it is never shown to the model. It catches the common shapes: known
// token prefixes, private key blocks, credentials in URLs, and values assigned
// to names like "password", "secret" or "token". It cannot catch a secret with
// no recognisable shape, which is why only committed files the owner named are
// read in the first place.
//
// Every pattern has bounded repetition and the assignment check looks at a
// fixed window around each ":" or "=", so a crafted file cannot make the scan
// take quadratic time.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----/, "a private key"],
  [/\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,255}/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,255}/, "a GitLab token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,255}/, "a Slack token"],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,255}/, "a Slack webhook"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{16,255}/, "a Stripe key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,255}/, "an Anthropic key"],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,255}/, "an OpenAI-style key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bya29\.[0-9A-Za-z_-]{20,255}/, "a Google OAuth token"],
  [/"type"\s{0,10}:\s{0,10}"service_account"/, "a cloud service account file"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
  [/\bpypi-[A-Za-z0-9_-]{50,255}/, "a PyPI token"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, "a SendGrid key"],
  [/\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}/, "a signed token (JWT)"],
  [/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`]{1,64}:[^\s:/@"'`]{3,128}@[^\s/"'`]{1,255}/i, "a password in a URL"],
  [/\b(cpart-invite|CPART_PASSPHRASE)[:=]\s{0,5}\S{8,255}/, "a Counterpart invite or passphrase"],
  // A bearer token: long, with both letters and digits, so "Bearer <token>"
  // and "Bearer $TOKEN" in docs are not flagged.
  [/\bBearer\s{1,5}(?=[A-Za-z0-9._~+/-]{0,512}[0-9])(?=[A-Za-z0-9._~+/-]{0,512}[A-Za-z])[A-Za-z0-9._~+/-]{16,512}/, "a bearer token"],
];

const SECRET_NAME = /(secret|token|passw(or)?d|passwd|pwd|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret|credential)/i;
const NAME_BEFORE = /([A-Za-z0-9_.-]{1,80})["']?\s{0,5}$/;
const VALUE_AFTER = /^\s{0,5}(?:"([^"\n]{1,200})"|'([^'\n]{1,200})'|`([^`\n]{1,200})`|([^\s"'`,;)}\]]{1,200}))/;
const PLACEHOLDER = /^(x+|\*+|\.+|_+|-+|0+)$|your|example|placeholder|changeme|change_me|redacted|dummy|sample|<[^>]*>|\$\{|\{\{|%s|process\.env|os\.environ|getenv/i;
const CONFIG_NAME = /^\s{0,40}(?:export\s{1,5}|-\s{1,5})?["']?[A-Za-z0-9_.-]{1,80}["']?\s{0,5}$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

// Names for a password in particular. Any real value assigned to one counts,
// however short or plain: "password: s3cr3t" is still a password.
const PASSWORD_NAME = /(passw(or)?d|passwd|pwd|passphrase)/i;
// Words that follow "password:" in code and docs without being a password:
// type names, schema words, and words about the value.
const NOT_A_VALUE = /^(true|false|null|none|undefined|nil|string|str|number|int|integer|bytes|text|boolean|bool|any|unknown|object|optional|required|secret|hidden|masked|empty|omitted|redacted|sensitive|type|varchar|char)$/i;

// A value assigned to a name that says it is secret. Quoted literals are
// treated with suspicion: anything without spaces that is not a placeholder
// and has a digit or symbol, or is long. Unquoted values must also not look
// like code: no calls, no dotted references. For a password name the bar is
// lower: 4 characters or more, and quoted, or with a digit or symbol, or alone
// on a config line like "password: hunter" in YAML or an .env file.
function secretValue(v: string, quoted: boolean, password: boolean, configLine: boolean): boolean {
  if (PLACEHOLDER.test(v) || /\s/.test(v)) return false;
  if (!quoted && (/[()]/.test(v) || DOTTED.test(v) || NOT_A_VALUE.test(v) || /^[A-Za-z_$][\w$]*\[/.test(v))) return false;
  // A value that itself says password is a variable or a label: "password: newPassword".
  if (password && (PASSWORD_NAME.test(v) || v.startsWith("$"))) return false;
  if (password && v.length >= 4 && (quoted || configLine || /[0-9!@#$%^&*+=/?~|<>-]/.test(v))) return true;
  const letter = /[A-Za-z]/.test(v);
  const other = /[0-9!@#$%^&*+=/?~|<>-]/.test(v);
  if (quoted) return (v.length >= 6 && letter && other) || v.length >= 16;
  return v.length >= 8 && letter && /[0-9]/.test(v);
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
    for (let at = 0; at < l.length; at++) {
      const c = l.charCodeAt(at);
      if (c !== 58 && c !== 61) continue; // ":" or "="
      if (l[at + 1] === "=" || l[at + 1] === ">" || l[at - 1] === "=" || l[at - 1] === "!" || l[at + 1] === ":") continue;
      const name = NAME_BEFORE.exec(l.slice(Math.max(0, at - 86), at))?.[1];
      if (!name || !SECRET_NAME.test(name)) continue;
      const m = VALUE_AFTER.exec(l.slice(at + 1, at + 220));
      if (!m) continue;
      const quoted = m[4] === undefined;
      // Nothing else on the line but the name, the value and maybe a comment.
      const configLine = CONFIG_NAME.test(l.slice(0, at)) && /^\s*(#.*)?$/.test(l.slice(at + 1 + m[0].length));
      if (secretValue((m[1] ?? m[2] ?? m[3] ?? m[4])!, quoted, PASSWORD_NAME.test(name), configLine)) return { line: i + 1, what: `a value assigned to ${name.slice(0, 40)}` };
    }
  }
  return null;
}
