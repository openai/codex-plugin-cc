import test from "node:test";
import assert from "node:assert/strict";

import { cleanProtocolLine } from "../plugins/codex/scripts/lib/jsonl.mjs";

test("cleanProtocolLine returns null for empty / whitespace lines", () => {
  assert.equal(cleanProtocolLine(""), null);
  assert.equal(cleanProtocolLine("   "), null);
  assert.equal(cleanProtocolLine("\t\r\n"), null);
});

test("cleanProtocolLine returns null for non-string input", () => {
  assert.equal(cleanProtocolLine(undefined), null);
  assert.equal(cleanProtocolLine(null), null);
  assert.equal(cleanProtocolLine(42), null);
});

test("cleanProtocolLine passes through plain JSON object lines unchanged", () => {
  assert.equal(cleanProtocolLine('{"id":1,"result":{}}'), '{"id":1,"result":{}}');
  assert.equal(cleanProtocolLine('  {"a":1}  '), '{"a":1}');
});

test("cleanProtocolLine passes through plain JSON array lines unchanged", () => {
  assert.equal(cleanProtocolLine('[1,2,3]'), '[1,2,3]');
});

test("cleanProtocolLine strips bracketed-paste-mode ANSI prefix (issue #23)", () => {
  assert.equal(
    cleanProtocolLine('\x1b[?2004h{"id":1}'),
    '{"id":1}'
  );
  assert.equal(
    cleanProtocolLine('{"id":1}\x1b[?2004l'),
    '{"id":1}'
  );
});

test("cleanProtocolLine strips CSI sequences whose final byte is not a letter", () => {
  // Bracketed-paste content markers use `~` as the final byte. A
  // letter-only CSI final pattern (`[a-zA-Z]`) misses them and the
  // surrounding JSON would be incorrectly dropped by the first-char
  // guard. ECMA-48's CSI grammar allows any final byte in 0x40..0x7E.
  assert.equal(
    cleanProtocolLine('\x1b[200~{"id":1}\x1b[201~'),
    '{"id":1}'
  );
  // Other non-letter finals at the boundaries of the 0x40..0x7E range.
  assert.equal(cleanProtocolLine('\x1b[@{"id":1}'), '{"id":1}'); // 0x40
  assert.equal(cleanProtocolLine('\x1b[`{"id":1}'), '{"id":1}'); // 0x60
});

test("cleanProtocolLine strips OSC window-title sequences", () => {
  assert.equal(
    cleanProtocolLine('\x1b]0;some title\x07{"id":1}'),
    '{"id":1}'
  );
});

test("cleanProtocolLine strips SGR color codes", () => {
  assert.equal(
    cleanProtocolLine('\x1b[1;31m{"id":1}\x1b[0m'),
    '{"id":1}'
  );
});

test("cleanProtocolLine drops CP-950 mojibake of Windows taskkill SUCCESS", () => {
  // Raw bytes from `taskkill /T /F` on a zh-TW (Big5 / CP-950) Windows
  // system: `成功: PID 為 1234 (PID 為 5678 的子處理程序) 的處理程序已終止。`
  // When read off codex.exe's stdout pipe under Node's UTF-8 decoder, the
  // invalid CP-950 high bytes become U+FFFD replacement characters.
  const mojibake = "���\\: PID �� 1234 (PID �� 5678 ���l�B�z�{��)";
  assert.equal(cleanProtocolLine(mojibake), null);
});

test("cleanProtocolLine drops the literal U+FFFD prefix that triggered the original bug", () => {
  // This is the smallest reproducer of the production failure: the parser
  // saw `Unexpected token '�', "���\: PID "...` and tore the connection
  // down. After this guard the line is silently skipped.
  assert.equal(cleanProtocolLine("���\\: PID 1234"), null);
});

test("cleanProtocolLine drops other non-JSON garbage (shell prompts, plain text)", () => {
  assert.equal(cleanProtocolLine("PS C:\\> "), null);
  assert.equal(cleanProtocolLine("user@host:~$ "), null);
  assert.equal(cleanProtocolLine("warning: something happened"), null);
  // Note: anything whose first non-whitespace character is `[` (e.g. an
  // ANSI-stripped bracket-log timestamp like `[2026-05-09T...]`) is NOT
  // dropped by this guard — it looks like a JSON array. Such lines still
  // reach JSON.parse and surface as a real protocol error, which is the
  // desired behaviour: the guard only drops lines that cannot possibly
  // be JSONL.
});

test("cleanProtocolLine forwards a malformed but JSON-shaped line for the parser to reject", () => {
  // Lines that DO start with `{` or `[` are returned even if they are not
  // strictly valid JSON. The caller will then surface a real protocol
  // error via JSON.parse. This is the desired behaviour: the guard only
  // drops lines that cannot possibly be JSONL.
  assert.equal(cleanProtocolLine('{"id":1,'), '{"id":1,');
  assert.equal(cleanProtocolLine('[1,2,'), '[1,2,');
});
