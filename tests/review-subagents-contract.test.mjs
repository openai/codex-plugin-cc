import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.join(ROOT, "plugins", "codex", "scripts", "lib", "agent-templates");
const EXECUTABLE_FENCE_INFOS = new Set([
  "",
  "bash",
  "cmd",
  "command",
  "console",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "shell",
  "terminal",
  "zsh"
]);

const TEMPLATES = [
  {
    name: "codex-review",
    file: "codex-review.md",
    invocation:
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --invoker claude-subagent --'
  },
  {
    name: "codex-adversarial-review",
    file: "codex-adversarial-review.md",
    invocation:
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --invoker claude-subagent --'
  }
];

function readTemplate(file) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, file), "utf8");
}

function getFrontMatter(source) {
  const match = /^---\n(?<frontMatter>[\s\S]*?)\n---\n/.exec(source);
  assert.ok(match, "template must start with front matter");
  return match.groups.frontMatter;
}

function getFenceBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(?: {0,3})(?<fence>`{3,}|~{3,})(?<info>[^\n]*)$/.exec(lines[index]);
    if (!open) {
      continue;
    }

    const openerFence = open.groups.fence;
    const openerChar = openerFence[0];
    const openerLength = openerFence.length;
    const contentLines = [];

    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex += 1) {
      const close = /^(?: {0,3})(?<fence>`{3,}|~{3,})[ \t]*$/.exec(lines[closeIndex]);
      if (
        close &&
        close.groups.fence[0] === openerChar &&
        close.groups.fence.length >= openerLength
      ) {
        blocks.push({
          info: open.groups.info.trimEnd(),
          content: contentLines.join("\n")
        });
        index = closeIndex;
        break;
      }
      contentLines.push(lines[closeIndex]);
    }
  }

  return blocks;
}

function getFenceInfoLanguage(info) {
  const normalizedInfo = info.trim().toLowerCase();
  return normalizedInfo === "" ? "" : normalizedInfo.split(/\s+/, 1)[0];
}

function getShellFenceBlocks(source) {
  return getFenceBlocks(source).filter((block) =>
    EXECUTABLE_FENCE_INFOS.has(getFenceInfoLanguage(block.info))
  );
}

function assertSingleExactHelperShellFence(source, invocation) {
  const shellBlocks = getShellFenceBlocks(source);
  assert.equal(shellBlocks.length, 1);
  assert.equal(shellBlocks[0].content.trim(), invocation);
}

// These strings are load-bearing: subagents must stay Bash-only foreground
// wrappers, and the literal helper invocation must keep the Claude subagent
// invoker marker pinned.
for (const template of TEMPLATES) {
  test(`${template.name} template preserves the review subagent contract`, () => {
    const source = readTemplate(template.file);
    const frontMatter = getFrontMatter(source);

    const toolsLines = [...frontMatter.matchAll(/^tools:\s*(?<tools>.*)$/gm)].map((match) =>
      match.groups.tools.trim()
    );
    assert.deepEqual(toolsLines, ["Bash"]);
    assert.doesNotMatch(frontMatter, /^allowed-tools:/m);
    assert.match(frontMatter, /^description: Use ONLY when explicitly asked/m);

    assert.doesNotMatch(source, /--background|--wait/);

    const sourceWithoutAllowedRegions = source
      .replace(/^tools:\s*Bash[ \t]*$/gm, "")
      .replace(/^```(?:text|output|console|shell-output)[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");
    assert.doesNotMatch(sourceWithoutAllowedRegions, /NotebookEdit|Read|Grep|Edit|Write/);

    assertSingleExactHelperShellFence(source, template.invocation);
  });
}

test("review subagent helper invocations place a sentinel after the invoker", () => {
  for (const template of TEMPLATES) {
    const source = readTemplate(template.file);
    const helperLine = getShellFenceBlocks(source)[0].content.trim();
    const invokerMarker = "--invoker claude-subagent";
    const markerIndex = helperLine.indexOf(invokerMarker);
    const afterInvoker = helperLine.slice(markerIndex + invokerMarker.length);

    assert.notEqual(markerIndex, -1);
    assert.match(afterInvoker, /^ --(?: |$)/);
  }
});

function syntheticTemplateWithExtraFence(extraFence) {
  return [
    "---",
    "tools: Bash",
    "---",
    "",
    "```shell",
    TEMPLATES[0].invocation,
    "```",
    "",
    extraFence,
    ""
  ].join("\n");
}

for (const testCase of [
  {
    name: "second triple-backtick bash fence",
    extraFence: "```bash\necho extra\n```"
  },
  {
    name: "second four-backtick bash fence",
    extraFence: "````bash\ncat README.md\n````"
  },
  {
    name: "second bash fence with longer closing run",
    extraFence: "```bash\ncat /etc/passwd\n`````"
  },
  {
    name: "second zsh fence",
    extraFence: "```zsh\necho pwned\n```"
  },
  {
    name: "second bare fence",
    extraFence: "```\nrm -rf /\n```"
  },
  {
    name: "second tilde bash fence",
    extraFence: "~~~bash\ncat /etc/passwd\n~~~"
  },
  {
    name: "second nine-backtick bash fence",
    extraFence: "`````````bash\nrm -rf /\n`````````"
  },
  {
    name: "second tilde zsh fence",
    extraFence: "~~~zsh\necho leak\n~~~"
  }
]) {
  test(`review subagent contract rejects ${testCase.name}`, () => {
    const invocation = TEMPLATES[0].invocation;
    const source = syntheticTemplateWithExtraFence(testCase.extraFence);

    assert.throws(() => assertSingleExactHelperShellFence(source, invocation), {
      name: "AssertionError"
    });
  });
}
