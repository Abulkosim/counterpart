// Pairing with a short code such as 7-cider-otter. The number names a
// short-lived mailbox on the relay (the nameplate). The two words are the
// password for a CPace run (pake.ts) between the person who made the code
// (the inviter, CPace initiator) and the person who typed it (the joiner,
// responder). The relay carries the messages and learns nothing it could use:
// whoever does not know the words gets one guess per run, and each side runs
// at most once per code.
//
// Messages, all canonical JSON:
//   a     inviter -> joiner   { v, k: "a", sid, y, ad }        sid: 16 random bytes; ad: the inviter's credential
//   b     joiner  -> inviter  { v, k: "b", y, ad, tag }        ad: the joiner's credential; tag: joiner's confirmation
//   c     inviter -> joiner   { v, k: "c", tag, box }          tag: inviter's confirmation; box: the invite, sealed
//   fail  either way          { v, k: "fail", why }            not authenticated: it can only end a run
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { b64u, concat, unb64u, utf8 } from "./bytes.ts";
import { canonicalBytes, canonicalize, parseCanonical } from "./canonical.ts";
import { isObject, isStr, onlyKeys } from "./check.ts";
import { type DeviceCredential, verifyCredential } from "./identity.ts";
import { type CpaceSide, confirmTag, cpaceFinish, cpaceStart, lvCat, macKey, tagsEqual } from "./pake.ts";
import { WORDS } from "./wordlist.ts";

export const NAMEPLATE_MAX = 9999;
export const PAIR_BODY_MAX = 4096; // characters in one message
const CI_LABEL = "counterpart/pair/v1";
const BOX_INFO = "counterpart/pair/box/v1";

const wordSet = new Set(WORDS);

export interface PairCode {
  nameplate: number;
  words: [string, string];
  relay?: string; // given when the code carried @relay
}

export const randomWords = (): [string, string] => [WORDS[randomInt(WORDS.length)]!, WORDS[randomInt(WORDS.length)]!];
export const formatCode = (nameplate: number, words: readonly string[]): string => `${nameplate}-${words.join("-")}`;

// The relay part of a code to send. A wss address with nothing but a host (and
// perhaps a port or path) is written without its scheme. Anything else is
// written in full, so reading it back gives exactly the same string.
export function relayHint(relay: string): string {
  if (relay.startsWith("wss://")) {
    const short = relay.slice("wss://".length);
    if (relayFromHint(short) === relay && !short.includes("@")) return short;
  }
  return relay;
}
export const relayFromHint = (hint: string): string => (hint.includes("://") ? hint : `wss://${hint}`);

export const codeWithRelay = (nameplate: number, words: readonly string[], relay: string): string => `${formatCode(nameplate, words)}@${relayHint(relay)}`;

// True when `s` looks like a short code, so the caller knows which parser's
// error to show. It does not mean the words are right.
export const looksLikeCode = (s: string): boolean => /^\s*[0-9]{1,4}[-\s]+[A-Za-z]/.test(s) && !s.startsWith("cpart-invite:");

// "7-cider-otter", "7 cider otter", "7-Cider-Otter@relay.example.com".
// A misspelt word is refused here, before anything is sent, so a typo never
// costs the code.
export function parseCode(input: string): PairCode {
  const s = input.trim();
  const at = s.indexOf("@");
  const codePart = (at < 0 ? s : s.slice(0, at)).toLowerCase();
  const parts = codePart.split(/[-\s]+/).filter(Boolean);
  if (parts.length !== 3 || !/^[0-9]{1,4}$/.test(parts[0]!)) throw new Error("a code is a number and two words, like 7-cider-otter");
  const nameplate = Number(parts[0]);
  if (nameplate < 1 || nameplate > NAMEPLATE_MAX) throw new Error("the number in a code is between 1 and 9999");
  const words = [parts[1]!, parts[2]!] as [string, string];
  for (const w of words) if (!wordSet.has(w)) throw new Error(`"${w.replace(/[^a-z]/g, "?")}" is not one of the code words. Check the spelling`);
  const out: PairCode = { nameplate, words };
  if (at >= 0) {
    const hint = s.slice(at + 1);
    if (!/^[\x21-\x7e]{1,512}$/.test(hint)) throw new Error("the relay after @ has spaces or characters that cannot be shown");
    out.relay = relayFromHint(hint);
  }
  return out;
}

// ---- messages

export type PairMsg =
  | { v: 1; k: "a"; sid: string; y: string; ad: string }
  | { v: 1; k: "b"; y: string; ad: string; tag: string }
  | { v: 1; k: "c"; tag: string; box: string }
  | { v: 1; k: "fail"; why: PairFailure };

// Why a run ended. Each has one sentence a person reads (pairFailureText).
export type PairFailure = "wrong-code" | "bad-message" | "not-confirmed" | "own-code" | "refused";
const FAILURES: PairFailure[] = ["wrong-code", "bad-message", "not-confirmed", "own-code", "refused"];

const b64 = (s: unknown, bytes: number): s is string => {
  try {
    return typeof s === "string" && unb64u(s).length === bytes;
  } catch {
    return false;
  }
};

export const encodePairMsg = (m: PairMsg): string => canonicalize(m);

export function parsePairMsg(body: unknown): PairMsg {
  if (typeof body !== "string" || body.length > PAIR_BODY_MAX) throw new Error("pair: message too large");
  const x = parseCanonical(utf8(body));
  if (!isObject(x) || x.v !== 1) throw new Error("pair: shape");
  if (x.k === "a" && onlyKeys(x, ["v", "k", "sid", "y", "ad"]) && b64(x.sid, 16) && b64(x.y, 32) && isStr(x.ad, 1, 2048)) return x as PairMsg;
  if (x.k === "b" && onlyKeys(x, ["v", "k", "y", "ad", "tag"]) && b64(x.y, 32) && isStr(x.ad, 1, 2048) && b64(x.tag, 64)) return x as PairMsg;
  if (x.k === "c" && onlyKeys(x, ["v", "k", "tag", "box"]) && b64(x.tag, 64) && isStr(x.box, 40, 3000)) return x as PairMsg;
  if (x.k === "fail" && onlyKeys(x, ["v", "k", "why"]) && FAILURES.includes(x.why as PairFailure)) return x as PairMsg;
  throw new Error("pair: fields");
}

// ---- what both sides bind

// Channel identifier: the relay both sides use and the nameplate. Neither is
// secret, and a relay that lies about either makes the keys differ.
const pairCi = (relay: string, nameplate: number): Uint8Array => lvCat(utf8(CI_LABEL), utf8(relay), utf8(String(nameplate)));
const prs = (words: readonly string[]): Uint8Array => utf8(words.join("-"));

type Role = "inviter" | "joiner";
// Associated data: the sender's role and device credential, which carries its
// root key. Both go into the transcript, so the key each side ends with is
// bound to both people's keys.
export const pairAd = (role: Role, credential: DeviceCredential): Uint8Array => canonicalBytes({ v: 1, role, credential });

function readAd(ad: string, role: Role, now: number): { bytes: Uint8Array; credential: DeviceCredential } {
  const bytes = unb64u(ad);
  const x = parseCanonical(bytes);
  if (!isObject(x) || !onlyKeys(x, ["v", "role", "credential"]) || x.v !== 1 || x.role !== role) throw new Error(`pair: expected the ${role}'s details`);
  return { bytes, credential: verifyCredential(x.credential, now) };
}

// The confirmed key seals the existing invite: the same credential and
// single-use token a `cpart-invite:` string carries.
function boxKey(isk: Uint8Array, sid: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", isk, sid, utf8(BOX_INFO), 32));
}
function seal(key: Buffer, plaintext: Uint8Array): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(utf8(BOX_INFO), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return b64u(concat(nonce, ct, c.getAuthTag()));
}
function unseal(key: Buffer, box: string): Uint8Array {
  const b = unb64u(box);
  if (b.length < 12 + 16 + 1) throw new Error("pair: box too short");
  const d = createDecipheriv("chacha20-poly1305", key, b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(utf8(BOX_INFO), { plaintextLength: b.length - 12 - 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
}

export type PairStep<T> = { ok: true } & T | { ok: false; why: PairFailure; detail: string };
const no = (why: PairFailure, detail: string): { ok: false; why: PairFailure; detail: string } => ({ ok: false, why, detail });

export interface PairSetup {
  relay: string;
  nameplate: number;
  words: readonly string[];
  credential: DeviceCredential; // my own device credential
  now?: () => number;
}

// The inviter's side. It answers at most one "b": after that the run is over,
// whatever the outcome, so whoever does not know the words gets one guess.
export class InviterRun {
  private s: PairSetup;
  private sid = new Uint8Array(randomBytes(16));
  private me: CpaceSide;
  private ad: Uint8Array;
  private used = false;

  constructor(s: PairSetup) {
    this.s = s;
    this.me = cpaceStart(prs(s.words), pairCi(s.relay, s.nameplate), this.sid);
    this.ad = pairAd("inviter", s.credential);
  }

  first(): PairMsg {
    return { v: 1, k: "a", sid: b64u(this.sid), y: b64u(this.me.share), ad: b64u(this.ad) };
  }

  // On success `finish` seals what the joiner needs (the long invite string)
  // and returns the last message.
  answer(m: PairMsg): PairStep<{ peer: DeviceCredential; finish: (invite: string) => PairMsg }> {
    if (this.used) return no("refused", "this code has already been answered once");
    this.used = true;
    if (m.k !== "b") return no("bad-message", "expected the joiner's first message");
    let peer: { bytes: Uint8Array; credential: DeviceCredential };
    try {
      peer = readAd(m.ad, "joiner", (this.s.now ?? Date.now)());
    } catch (e) {
      return no("bad-message", (e as Error).message);
    }
    if (peer.credential.rootKey === this.s.credential.rootKey) return no("own-code", "that is your own code");
    const isk = cpaceFinish(this.me, "initiator", this.sid, this.ad, unb64u(m.y), peer.bytes);
    if (!isk) return no("bad-message", "the joiner's share is not a valid group element");
    const mk = macKey(this.sid, isk);
    if (!tagsEqual(unb64u(m.tag), confirmTag(mk, unb64u(m.y), peer.bytes))) return no("wrong-code", "the joiner did not prove it knows the code");
    const key = boxKey(isk, this.sid);
    const tag = b64u(confirmTag(mk, this.me.share, this.ad));
    return { ok: true, peer: peer.credential, finish: (invite) => ({ v: 1, k: "c", tag, box: seal(key, canonicalBytes({ invite })) }) };
  }
}

// The joiner's side. It answers at most one "a" and accepts at most one "c".
export class JoinerRun {
  private s: PairSetup;
  private ad: Uint8Array;
  private state: "start" | "answered" | "over" = "start";
  private sid: Uint8Array | null = null;
  private peer: { bytes: Uint8Array; credential: DeviceCredential; share: Uint8Array } | null = null;
  private isk: Uint8Array | null = null;

  constructor(s: PairSetup) {
    this.s = s;
    this.ad = pairAd("joiner", s.credential);
  }

  answer(m: PairMsg): PairStep<{ reply: PairMsg; peer: DeviceCredential }> {
    if (this.state !== "start") return no("refused", "this code has already been tried once");
    this.state = "over";
    if (m.k !== "a") return no("bad-message", "expected the inviter's first message");
    let peer: { bytes: Uint8Array; credential: DeviceCredential };
    try {
      peer = readAd(m.ad, "inviter", (this.s.now ?? Date.now)());
    } catch (e) {
      return no("bad-message", (e as Error).message);
    }
    if (peer.credential.rootKey === this.s.credential.rootKey) return no("own-code", "that is your own code");
    const sid = unb64u(m.sid);
    const me = cpaceStart(prs(this.s.words), pairCi(this.s.relay, this.s.nameplate), sid);
    const share = unb64u(m.y);
    const isk = cpaceFinish(me, "responder", sid, this.ad, share, peer.bytes);
    if (!isk) return no("bad-message", "the inviter's share is not a valid group element");
    this.sid = sid;
    this.isk = isk;
    this.peer = { ...peer, share };
    this.state = "answered";
    const tag = confirmTag(macKey(sid, isk), me.share, this.ad);
    return { ok: true, peer: peer.credential, reply: { v: 1, k: "b", y: b64u(me.share), ad: b64u(this.ad), tag: b64u(tag) } };
  }

  // Checks the inviter's confirmation and opens the invite it sealed.
  finish(m: PairMsg): PairStep<{ invite: string; peer: DeviceCredential }> {
    if (this.state !== "answered") return no("refused", "not waiting for a confirmation");
    this.state = "over";
    if (m.k !== "c") return no("bad-message", "expected the inviter's confirmation");
    const { sid, isk, peer } = this;
    if (!sid || !isk || !peer) return no("refused", "not waiting for a confirmation");
    if (!tagsEqual(unb64u(m.tag), confirmTag(macKey(sid, isk), peer.share, peer.bytes))) return no("not-confirmed", "the other side did not prove it knows the code");
    let invite: unknown;
    try {
      const x = parseCanonical(unseal(boxKey(isk, sid), m.box));
      if (!isObject(x) || !onlyKeys(x, ["invite"]) || !isStr(x.invite, 1, 2048)) throw new Error("shape");
      invite = x.invite;
    } catch {
      return no("bad-message", "the sealed invite could not be opened");
    }
    return { ok: true, invite: invite as string, peer: peer.credential };
  }
}

export function pairFailureText(why: PairFailure, side: Role): string {
  switch (why) {
    case "wrong-code":
      return side === "inviter" ? "Someone tried a wrong code. Nothing was paired, and this code no longer works." : "The code did not match. Nothing was paired, and this code no longer works.";
    case "not-confirmed":
      return "The other side could not prove it knows the code. Nothing was paired.";
    case "own-code":
      return "That is your own code. Nothing was paired.";
    case "bad-message":
      return "A pairing message was malformed or tampered with. Nothing was paired.";
    case "refused":
      return "The other side ended the pairing. Nothing was paired.";
  }
}
