#!/usr/bin/env python3
# Vendor the gitleaks rule set (MIT, Copyright (c) 2019 Zachary Rice,
# https://github.com/gitleaks/gitleaks) as data for the outbound guard, and
# extract its test fixtures for the guard's corpus.
#
#   python3 -I scripts/guard-vendor-gitleaks.py <gitleaks source dir> <version>
#
# Reads config/gitleaks.toml and cmd/generate/config/rules/*.go. Runs nothing
# from that directory: the Go files are parsed as text. Writes
#   packages/daemon/src/guard-data/gitleaks-rules.json
#   packages/daemon/test/guard-corpus/gitleaks-fixtures.json
# Regexes are converted from Go (RE2) syntax to JavaScript. Rules that only
# match file paths are left out: a message has no path.
#
# Needs python3 and a gitleaks source checkout. No network.

import json
import os
import random
import re
import sys
import tomllib

try:
    import re._parser as sre_parse  # Python 3.11+
    import re._constants as sre_c
except ImportError:  # pragma: no cover
    import sre_parse
    import sre_constants as sre_c

SRC, VERSION = sys.argv[1], sys.argv[2]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

POSIX = {
    "alnum": "a-zA-Z0-9", "alpha": "a-zA-Z", "digit": "0-9", "upper": "A-Z", "lower": "a-z",
    "xdigit": "0-9a-fA-F", "space": r"\s", "punct": r"!-\/:-@\[-`{-~", "print": r"\x20-\x7e", "word": r"\w",
}


def group_end(src, i):
    """Index of the ')' closing the group that contains position i, or len(src)."""
    depth = 0
    in_class = False
    j = i
    while j < len(src):
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
        elif c == "[":
            in_class = True
            if src[j + 1:j + 2] == "^":
                j += 1
            if src[j + 1:j + 2] == "]":
                j += 1
        elif c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return j
            depth -= 1
        j += 1
    return len(src)


def split_top(src):
    """Split a pattern at its top-level '|'."""
    parts, depth, in_class, j, start = [], 0, False, 0, 0
    while j < len(src):
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
        elif c == "[":
            in_class = True
            if src[j + 1:j + 2] == "^":
                j += 1
            if src[j + 1:j + 2] == "]":
                j += 1
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "|" and depth == 0:
            parts.append(src[start:j])
            start = j + 1
        j += 1
    parts.append(src[start:])
    return parts


def go_to_js(src):
    flags = set()
    # A flag group at the very start applies to the whole pattern.
    m = re.match(r"^\(\?([imsU]+)\)", src)
    if m:
        for f in m.group(1):
            if f == "U":
                raise ValueError("ungreedy flag")
            flags.add(f)
        src = src[m.end():]
    out = []
    i = 0
    in_class = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            n = src[i + 1] if i + 1 < len(src) else ""
            if n == "z":
                out.append("$")
            elif n == "A":
                out.append("^")
            elif n == "x" and src[i + 2:i + 3] == "{":
                end = src.index("}", i)
                out.append("\\u%04x" % int(src[i + 3:end], 16))
                i = end + 1
                continue
            elif n == "Q":
                end = src.find("\\E", i)
                lit = src[i + 2:end if end >= 0 else len(src)]
                out.append(re.sub(r"([\\^$.|?*+()\[\]{}/-])", r"\\\1", lit))
                i = (end + 2) if end >= 0 else len(src)
                continue
            elif n in "pP":
                raise ValueError("unicode class")
            else:
                out.append(src[i:i + 2])
            i += 2
            continue
        if in_class:
            if src.startswith("[:", i):
                end = src.index(":]", i)
                name = src[i + 2:end]
                out.append(POSIX[name])
                i = end + 2
                continue
            if c == "]":
                in_class = False
            out.append(c)
            i += 1
            continue
        if c == "[":
            in_class = True
            out.append(c)
            i += 1
            if src[i:i + 1] == "^":
                out.append("^")
                i += 1
            if src[i:i + 1] == "]":
                out.append("\\]")
                i += 1
            continue
        if src.startswith("(?P<", i):
            out.append("(?<")
            i += 4
            continue
        m = re.match(r"\(\?([ims]+)\)", src[i:])
        if m:
            # In Go a flag set in the middle lasts to the end of the enclosing
            # group, across later alternatives too: X(?i)Y|Z is X(?i:Y)|(?i:Z).
            end = group_end(src, i + m.end())
            branches = split_top(src[i + m.end():end])
            out.append("|".join("(?%s:%s)" % (m.group(1), go_to_js(b)[0]) for b in branches))
            i = end
            continue
        out.append(c)
        i += 1
    return "".join(out), "".join(sorted(flags))


def convert_rules():
    with open(os.path.join(SRC, "config/gitleaks.toml"), "rb") as f:
        cfg = tomllib.load(f)

    def conv(rx):
        s, fl = go_to_js(rx)
        return {"source": s, "flags": fl}

    def allow(a):
        out = {}
        if a.get("regexes"):
            out["regexes"] = [conv(r) for r in a["regexes"]]
        if a.get("stopwords"):
            out["stopwords"] = a["stopwords"]
        out["target"] = a.get("regexTarget", "secret")
        out["condition"] = a.get("condition", "OR")
        # A message has no path. A path-only list never applies, nor does one
        # that needs a path match AND something else. With OR the rest applies.
        if a.get("paths") and (out["condition"] == "AND" or (not a.get("regexes") and not a.get("stopwords"))):
            return None
        if a.get("commits") and out["condition"] == "AND":
            return None
        if not a.get("regexes") and not a.get("stopwords"):
            return None
        return out

    rules, skipped = [], []
    for r in cfg["rules"]:
        if "regex" not in r:
            skipped.append({"id": r["id"], "why": "matches file paths only"})
            continue
        if "path" in r:
            skipped.append({"id": r["id"], "why": "applies to one kind of file path only"})
            continue
        try:
            rx = conv(r["regex"])
        except Exception as e:  # noqa: BLE001
            skipped.append({"id": r["id"], "why": "regex not convertible: %s" % e})
            continue
        out = {"id": r["id"], "description": r.get("description", ""), "regex": rx["source"], "flags": rx["flags"]}
        if r.get("secretGroup"):
            out["secretGroup"] = r["secretGroup"]
        if r.get("entropy"):
            out["entropy"] = r["entropy"]
        if r.get("keywords"):
            out["keywords"] = [k.lower() for k in r["keywords"]]
        lists = [x for x in (allow(a) for a in r.get("allowlists", [])) if x]
        if lists:
            out["allowlists"] = lists
        rules.append(out)
    glob = cfg.get("allowlist", {})
    data = {
        "source": "gitleaks %s, config/gitleaks.toml" % VERSION,
        "url": "https://github.com/gitleaks/gitleaks",
        "license": "MIT License, Copyright (c) 2019 Zachary Rice",
        "note": "Generated by scripts/guard-vendor-gitleaks.py. Regexes converted from Go RE2 syntax to JavaScript. Do not edit by hand.",
        "allowlist": {"regexes": [conv(x) for x in glob.get("regexes", [])], "stopwords": glob.get("stopwords", [])},
        "rules": rules,
        "skipped": skipped,
    }
    return data


# ---- fixtures: a small evaluator for the Go that builds each rule's samples ----

TOKEN = re.compile(r"""
    (?P<ws>\s+) | (?P<lc>//[^\n]*) | (?P<bc>/\*.*?\*/)
  | (?P<raw>`[^`]*`) | (?P<str>"(?:\\.|[^"\\\n])*")
  | (?P<ell>\.\.\.) | (?P<op>:=|[=+(){}\[\],:;*&.])
  | (?P<id>[A-Za-z_][A-Za-z0-9_]*) | (?P<num>[0-9]+) | (?P<other>.)
""", re.S | re.X)


def go_string(tok):
    if tok.startswith("`"):
        return tok[1:-1]
    body = tok[1:-1]
    return bytes(body, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8", "replace")


def tokens(src):
    out = []
    for m in TOKEN.finditer(src):
        k = m.lastgroup
        if k in ("ws", "lc", "bc"):
            continue
        out.append((k, m.group()))
    return out


class Unknown(Exception):
    pass


rng = random.Random(20261117)


def regen(pattern):
    flags = 0
    if pattern.startswith("(?i)"):
        pattern = pattern[4:]
    tree = sre_parse.parse(pattern, flags)

    def gen(items):
        s = []
        for op, av in items:
            s.append(one(op, av))
        return "".join(s)

    def pick_class(av):
        chars = []
        neg = False
        for op, a in av:
            if op == sre_c.NEGATE:
                neg = True
            elif op == sre_c.LITERAL:
                chars.append(chr(a))
            elif op == sre_c.RANGE:
                chars.extend(chr(x) for x in range(a[0], a[1] + 1))
            elif op == sre_c.CATEGORY:
                chars.extend(cat(a))
        if neg:
            allc = [chr(x) for x in range(0x21, 0x7f)]
            chars = [c for c in allc if c not in chars]
        # Upstream writes classes like [0-9A-Za-z\\-_], which parse as a range
        # from backslash to underscore but are meant as "letters, digits, - and _".
        # The secrets they generate have no backslash, so ours do not either.
        if any(c.isalnum() for c in chars):
            chars = [c for c in chars if c not in "\\]^["] or chars
        return rng.choice(chars)

    def cat(a):
        if a == sre_c.CATEGORY_DIGIT:
            return list("0123456789")
        if a == sre_c.CATEGORY_WORD:
            return list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
        if a == sre_c.CATEGORY_SPACE:
            return [" "]
        return list("abcdefghijklmnopqrstuvwxyz")

    def one(op, av):
        if op == sre_c.LITERAL:
            return chr(av)
        if op == sre_c.NOT_LITERAL:
            return "x" if chr(av) != "x" else "y"
        if op == sre_c.ANY:
            return rng.choice("abcdefghijklmnopqrstuvwxyz0123456789")
        if op == sre_c.IN:
            return pick_class(av)
        if op in (sre_c.MAX_REPEAT, sre_c.MIN_REPEAT, getattr(sre_c, "POSSESSIVE_REPEAT", None)):
            lo, hi, sub = av
            hi = min(hi, lo + 10) if hi != sre_c.MAXREPEAT else lo + 10
            return "".join(gen(sub) for _ in range(rng.randint(lo, hi)))
        if op == sre_c.SUBPATTERN:
            return gen(av[-1])
        if op == sre_c.BRANCH:
            return gen(rng.choice(av[1]))
        if op in (sre_c.AT,):
            return ""
        if op == sre_c.CATEGORY:
            return rng.choice(cat(av))
        raise Unknown("regen op %s" % op)

    return gen(tree)


HELPERS = {
    "utils.Numeric": lambda n: "[0-9]{%s}" % n,
    "utils.Hex": lambda n: "[a-f0-9]{%s}" % n,
    "utils.AlphaNumeric": lambda n: "[a-z0-9]{%s}" % n,
    "utils.AlphaNumericExtendedShort": lambda n: "[a-z0-9_-]{%s}" % n,
    "utils.AlphaNumericExtended": lambda n: "[a-z0-9=_\\-]{%s}" % n,
    "utils.AlphaNumericExtendedLong": lambda n: "[a-z0-9\\/=_\\+\\-]{%s}" % n,
    "utils.Hex8_4_4_4_12": lambda: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
}


def sample_templates():
    with open(os.path.join(SRC, "cmd/generate/config/utils/generate.go")) as f:
        src = f.read()
    start = src.index("samples := map[string]string{")
    end = src.index("replacer :=", start)
    toks = tokens(src[start:end])
    out = []
    for i, (k, v) in enumerate(toks):
        if k in ("str", "raw") and i + 1 < len(toks) and toks[i + 1][1] == ":":
            nxt = toks[i + 2]
            if nxt[0] in ("str", "raw"):
                out.append(go_string(nxt[1]))
    return out


TEMPLATES = None


def samples(identifier, secret):
    return [t.replace("{i}", identifier).replace("{I}", identifier.upper()).replace("{s}", secret) for t in TEMPLATES]


class Parser:
    def __init__(self, toks, env):
        self.t = toks
        self.i = 0
        self.env = env

    def peek(self, k=0):
        return self.t[self.i + k] if self.i + k < len(self.t) else ("eof", "")

    def take(self, v=None):
        tok = self.peek()
        if v is not None and tok[1] != v:
            raise Unknown("expected %s got %s" % (v, tok[1]))
        self.i += 1
        return tok

    def expr(self):
        v = self.term()
        while self.peek()[1] == "+":
            self.take()
            w = self.term()
            if not isinstance(v, str) or not isinstance(w, str):
                raise Unknown("+ on non-strings")
            v = v + w
        return v

    def name(self):
        parts = [self.take()[1]]
        while self.peek()[1] == "." and self.peek(1)[0] == "id":
            self.take()
            parts.append(self.take()[1])
        return ".".join(parts)

    def args(self):
        self.take("(")
        out = []
        while self.peek()[1] != ")":
            v = self.expr()
            if self.peek()[1] == "...":
                self.take()
                out.extend(v)
            else:
                out.append(v)
            if self.peek()[1] == ",":
                self.take()
        self.take(")")
        return out

    def term(self):
        k, v = self.peek()
        if k in ("str", "raw"):
            self.take()
            return go_string(v)
        if v == "[":
            self.take("[")
            self.take("]")
            if self.name() != "string":
                raise Unknown("slice type")
            return self.slice()
        if k == "id" and v == "map":
            self.take()
            self.take("[")
            self.name()
            self.take("]")
            self.name()
            return self.mapvals()
        if k == "id":
            n = self.name()
            if self.peek()[1] == "(":
                a = self.args()
                return self.call(n, a)
            if n in self.env:
                return self.env[n]
            raise Unknown("variable %s" % n)
        raise Unknown("term %s" % v)

    def slice(self):
        self.take("{")
        out = []
        while self.peek()[1] != "}":
            out.append(self.expr())
            if self.peek()[1] == ",":
                self.take()
        self.take("}")
        return out

    def mapvals(self):
        self.take("{")
        out = []
        while self.peek()[1] != "}":
            self.expr()
            self.take(":")
            out.append(self.expr())
            if self.peek()[1] == ",":
                self.take()
        self.take("}")
        return out

    def call(self, n, a):
        if n == "append":
            base = a[0] if isinstance(a[0], list) else [a[0]]
            return base + [x for x in a[1:]]
        if n == "utils.GenerateSampleSecrets":
            return samples(a[0], a[1])
        if n == "utils.GenerateSampleSecret":
            return '%s_api_token = "%s"' % (a[0], a[1])
        if n == "secrets.NewSecret":
            return regen(a[0])
        if n in HELPERS:
            return HELPERS[n](*a)
        if n == "strings.ToUpper":
            return a[0].upper()
        if n == "strings.ToLower":
            return a[0].lower()
        if n == "strings.Repeat":
            return a[0] * int(a[1])
        raise Unknown("call %s" % n)


def func_bodies(src):
    for m in re.finditer(r"func (\w+)\(\) \*config\.Rule \{", src):
        i = m.end()
        depth = 1
        toks = []
        for t in TOKEN.finditer(src, i):
            k = t.lastgroup
            if k in ("ws", "lc", "bc"):
                continue
            v = t.group()
            if v == "{":
                depth += 1
            elif v == "}":
                depth -= 1
                if depth == 0:
                    break
            toks.append((k, v))
        yield m.group(1), toks


def statements(toks):
    """Split a token list into top-level statements, at newlines lost, so by assignments."""
    i = 0
    while i < len(toks):
        if toks[i][0] == "id" and i + 1 < len(toks) and toks[i + 1][1] in (":=", "="):
            yield i
        i += 1


def extract_fixtures():
    rules_dir = os.path.join(SRC, "cmd/generate/config/rules")
    out = []
    for fn in sorted(os.listdir(rules_dir)):
        if not fn.endswith(".go") or fn.endswith("_test.go"):
            continue
        with open(os.path.join(rules_dir, fn)) as f:
            src = f.read()
        for fname, toks in func_bodies(src):
            rid = None
            for j, (k, v) in enumerate(toks):
                if v == "RuleID" and toks[j + 1][1] == ":":
                    nxt = toks[j + 2]
                    if nxt[0] in ("str", "raw"):
                        rid = go_string(nxt[1])
                    break
            if not rid:
                continue
            env = {}
            failed = []
            for start in statements(toks):
                var = toks[start][1]
                p = Parser(toks, env)
                p.i = start + 2
                try:
                    env[var] = p.expr()
                except (Unknown, ValueError, IndexError, KeyError, re.error) as e:
                    if var in ("tps", "fps"):
                        failed.append("%s: %s" % (var, e))
            tps = [x for x in env.get("tps", []) if isinstance(x, str)]
            fps = [x for x in env.get("fps", []) if isinstance(x, str)]
            if tps or fps or failed:
                out.append({"rule": rid, "tps": tps, "fps": fps, **({"unparsed": failed} if failed else {})})
    return out


def main():
    global TEMPLATES
    TEMPLATES = sample_templates()
    rules = convert_rules()
    rp = os.path.join(OUT, "packages/daemon/src/guard-data/gitleaks-rules.json")
    os.makedirs(os.path.dirname(rp), exist_ok=True)
    with open(rp, "w") as f:
        json.dump(rules, f, indent=1, ensure_ascii=False)
        f.write("\n")
    fx = extract_fixtures()
    fp = os.path.join(OUT, "packages/daemon/test/guard-corpus/gitleaks-fixtures.json")
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w") as f:
        json.dump({
            "source": "gitleaks %s, cmd/generate/config/rules/*.go" % VERSION,
            "license": "MIT License, Copyright (c) 2019 Zachary Rice",
            "note": "True and false positives each rule is validated against upstream. Random parts regenerated here with a fixed seed. Generated by scripts/guard-vendor-gitleaks.py.",
            "fixtures": fx,
        }, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("rules %d, skipped %d, fixture rules %d, tps %d, fps %d, unparsed statements %d" % (
        len(rules["rules"]), len(rules["skipped"]), len(fx), sum(len(x["tps"]) for x in fx), sum(len(x["fps"]) for x in fx),
        sum(len(x.get("unparsed", [])) for x in fx)))


main()
