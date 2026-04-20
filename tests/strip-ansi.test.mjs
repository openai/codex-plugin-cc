import test from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../plugins/codex/scripts/lib/app-server.mjs";

// ── CSI sequences ────────────────────────────────────────────────────────────

test("stripAnsi: CSI — color/SGR codes", () => {
  assert.equal(stripAnsi("\x1b[0m"), "");
  assert.equal(stripAnsi("\x1b[1;32m"), "");
  assert.equal(stripAnsi("\x1b[38;5;196m"), "");
});

test("stripAnsi: CSI — bracketed paste mode (the original bug)", () => {
  assert.equal(stripAnsi("\x1b[?2004h"), "");
  assert.equal(stripAnsi("\x1b[?2004l"), "");
});

test("stripAnsi: CSI — bracketed paste data wrapper ~", () => {
  // ESC[200~ and ESC[201~ wrap pasted content; ~ is 0x7E (max final byte)
  assert.equal(stripAnsi("\x1b[200~"), "");
  assert.equal(stripAnsi("\x1b[201~"), "");
});

test("stripAnsi: CSI — modifyOtherKeys (> parameter byte)", () => {
  // > is 0x3E, valid CSI parameter byte per ECMA-48, missed by [0-9;?]
  assert.equal(stripAnsi("\x1b[>4;2m"), "");
  assert.equal(stripAnsi("\x1b[>4;0m"), "");
});

test("stripAnsi: CSI — mode strings with < = > parameter bytes", () => {
  // < = 0x3C, = = 0x3D, > = 0x3E — all valid parameter bytes
  assert.equal(stripAnsi("\x1b[<1;2M"), "");  // mouse event
  assert.equal(stripAnsi("\x1b[=2h"), "");
  assert.equal(stripAnsi("\x1b[>1m"), "");
});

test("stripAnsi: CSI — with intermediate bytes", () => {
  // Space (0x20) is an intermediate byte; e.g. ECMA-48 nF sequences
  assert.equal(stripAnsi("\x1b[ q"), "");   // cursor shape
  assert.equal(stripAnsi("\x1b[!p"), "");   // soft reset
});

test("stripAnsi: CSI — cursor movement and erase", () => {
  assert.equal(stripAnsi("\x1b[2J"), "");   // erase screen
  assert.equal(stripAnsi("\x1b[H"), "");    // cursor home
  assert.equal(stripAnsi("\x1b[1;1H"), ""); // cursor position
  assert.equal(stripAnsi("\x1b[2K"), "");   // erase line
});

// ── OSC sequences ────────────────────────────────────────────────────────────

test("stripAnsi: OSC — terminal title with BEL terminator", () => {
  assert.equal(stripAnsi("\x1b]0;My Terminal\x07"), "");
});

test("stripAnsi: OSC — terminal title with ST terminator", () => {
  assert.equal(stripAnsi("\x1b]0;My Terminal\x1b\\"), "");
});

test("stripAnsi: OSC — shell integration sequences (iTerm2/kitty)", () => {
  assert.equal(stripAnsi("\x1b]133;A\x07"), "");
  assert.equal(stripAnsi("\x1b]133;D;0\x07"), "");
});

test("stripAnsi: OSC — hyperlinks", () => {
  assert.equal(stripAnsi("\x1b]8;params;uri\x07"), "");
});

// ── String sequences (DCS / SOS / PM / APC) ──────────────────────────────────

test("stripAnsi: DCS — device control string (ESC P ... ST)", () => {
  assert.equal(stripAnsi("\x1bPfoo=bar\x1b\\"), "");
});

test("stripAnsi: APC — application program command (ESC _ ... ST)", () => {
  // Used by some terminal emulators (e.g. Kitty) for metadata
  assert.equal(stripAnsi("\x1b_Gfoo\x1b\\"), "");
});

test("stripAnsi: PM — privacy message (ESC ^ ... ST)", () => {
  assert.equal(stripAnsi("\x1b^hello\x1b\\"), "");
});

test("stripAnsi: SOS — start of string (ESC X ... ST)", () => {
  assert.equal(stripAnsi("\x1bXdata\x1b\\"), "");
});

// ── Simple / nF escapes ──────────────────────────────────────────────────────

test("stripAnsi: simple — Fp sequences (0x30–0x3F final)", () => {
  // ESC 7 = save cursor (0x37), ESC 8 = restore cursor (0x38)
  assert.equal(stripAnsi("\x1b7"), "");
  assert.equal(stripAnsi("\x1b8"), "");
  // ESC = (0x3D) = application keypad, ESC > (0x3E) = normal keypad
  assert.equal(stripAnsi("\x1b="), "");
  assert.equal(stripAnsi("\x1b>"), "");
});

test("stripAnsi: simple — Fe sequences (0x40–0x5F final)", () => {
  // ESC c = full reset (0x63 actually Fs), ESC M = reverse index (0x4D Fe)
  assert.equal(stripAnsi("\x1bM"), "");   // reverse index
  assert.equal(stripAnsi("\x1bE"), "");   // next line (NEL)
  assert.equal(stripAnsi("\x1bD"), "");   // index
});

test("stripAnsi: simple — Fs sequences (0x60–0x7E final)", () => {
  assert.equal(stripAnsi("\x1bc"), "");   // RIS (full reset)
});

test("stripAnsi: simple — nF with intermediate bytes", () => {
  // ESC space F = 7-bit controls (intermediate 0x20, final 0x46)
  assert.equal(stripAnsi("\x1b F"), "");
  assert.equal(stripAnsi("\x1b G"), "");
});

// ── Lone ESC fallback ────────────────────────────────────────────────────────

test("stripAnsi: lone ESC — bare ESC byte stripped", () => {
  assert.equal(stripAnsi("\x1b"), "");
});

test("stripAnsi: lone ESC — ESC followed by unknown byte stripped", () => {
  // ESC + DEL (0x7F) — not a valid final byte, lone ESC fallback handles ESC
  // 0x7F is not in [\x30-\x7e] so simple escape won't match it, ESC fallback strips ESC
  const result = stripAnsi("\x1b\x7f");
  assert.ok(!result.includes("\x1b"), "ESC should be stripped");
});

// ── Mixed content ────────────────────────────────────────────────────────────

test("stripAnsi: preserves valid JSON around escape sequences", () => {
  const line = '\x1b[?2004h{"id":1,"method":"initialize","params":{}}\x1b[?2004l';
  assert.equal(stripAnsi(line), '{"id":1,"method":"initialize","params":{}}');
});

test("stripAnsi: multiple sequences in one line", () => {
  const line = "\x1b[0m\x1b[1;32mhello\x1b[0m";
  assert.equal(stripAnsi(line), "hello");
});

test("stripAnsi: OSC title + CSI color + text", () => {
  const line = "\x1b]0;zsh\x07\x1b[1;34msome text\x1b[0m";
  assert.equal(stripAnsi(line), "some text");
});

test("stripAnsi: plain JSON passes through unchanged", () => {
  const json = '{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}';
  assert.equal(stripAnsi(json), json);
});

test("stripAnsi: empty string", () => {
  assert.equal(stripAnsi(""), "");
});

test("stripAnsi: string with no escape sequences", () => {
  const s = "hello world 123 !@#";
  assert.equal(stripAnsi(s), s);
});
