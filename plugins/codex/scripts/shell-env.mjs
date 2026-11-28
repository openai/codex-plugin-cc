import { Parser, Language } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm";
import bashWasm from "tree-sitter-bash/tree-sitter-bash.wasm";

let language;

function unsupportedExport() {
  return new Error("Cannot update CLAUDE_ENV_FILE: unsupported assignment to a managed variable; file left unchanged.");
}

function assignmentName(node) {
  return node.childForFieldName("name")?.text;
}

function onlyGeneratedExports(root, updates) {
  // In the hook's literal-only files every command succeeds, so duplicates need no no-op.
  // Other shell programs retain a ':' statement to preserve observable command status.
  return root.children.every((node) => node.type === "comment" || (
    node.type === "declaration_command" && node.namedChildCount === 1 &&
    updates.has(assignmentName(node.namedChildren[0])) &&
    /^export [A-Za-z_][A-Za-z0-9_]*='(?:[^']|'"'"')*'$/.test(node.text)
  ));
}

async function createParser() {
  if (!language) {
    await Parser.init({ wasmBinary: runtimeWasm });
    language = await Language.load(bashWasm);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

function parseChecked(parser, contents) {
  const tree = parser.parse(contents);
  if (!tree || tree.rootNode.hasError) {
    tree?.delete();
    throw new Error("Cannot update CLAUDE_ENV_FILE: unsupported or invalid Bash syntax; file left unchanged.");
  }
  return tree;
}

function commandRemovalEnd(contents, command) {
  const suffix = contents.slice(command.endIndex);
  // Consume a following separator, keeping comments and adjacent commands intact.
  const separator = suffix.match(/^[ \t]*(?:;|\r?\n)/);
  return command.endIndex + (separator?.[0].length ?? 0);
}

/** Update plain exports in the parent shell, preserving every unrelated source range. */
export async function updateShellExports(contents, entries, shellEscape) {
  const updates = new Map(entries);
  const seen = new Set();
  const edits = [];
  const parser = await createParser();
  let tree;
  try {
    tree = parseChecked(parser, contents);
    const compactDuplicates = onlyGeneratedExports(tree.rootNode, updates);
    for (const statement of tree.rootNode.namedChildren) {
      // Background commands execute in a child shell, including redirected commands.
      if (statement.nextSibling?.type === "&") {
        continue;
      }
      const command = statement.type === "redirected_statement"
        ? statement.childForFieldName("body") : statement;
      if (!command) continue;
      if (command.type === "unset_command" && command.namedChildren.some((argument) => {
        const name = argument.text.replace(/^(['"])([A-Za-z_][A-Za-z0-9_]*)\1$/, "$2");
        return updates.has(name);
      })) {
        throw unsupportedExport();
      }
      if (command.type === "variable_assignment" || command.type === "variable_assignments") {
        const assignments = command.type === "variable_assignment" ? [command] : command.namedChildren;
        if (assignments.some((argument) => updates.has(assignmentName(argument)))) {
          throw unsupportedExport();
        }
      }
      if (command.type !== "declaration_command") {
        continue;
      }
      const argumentsList = command.namedChildren;
      const touchesManaged = argumentsList.some((argument) =>
        updates.has(argument.type === "variable_assignment" ? assignmentName(argument) : argument.text));
      if (command.firstChild?.type !== "export" || argumentsList.some((argument) =>
        argument.type !== "variable_assignment" && argument.type !== "variable_name")) {
        if (touchesManaged) throw unsupportedExport();
        continue;
      }
      const commandEdits = [];
      let removed = 0;
      for (const argument of argumentsList) {
        if (argument.type !== "variable_assignment") {
          continue;
        }
        const name = assignmentName(argument);
        if (!updates.has(name)) {
          continue;
        }
        if (argument.children.find((child) => !child.isNamed)?.type !== "=") {
          throw unsupportedExport();
        }
        const duplicate = seen.has(name);
        commandEdits.push({
          start: argument.startIndex,
          end: argument.endIndex,
          text: duplicate ? "" : `${name}=${shellEscape(updates.get(name))}`
        });
        if (duplicate) removed += 1;
        seen.add(name);
      }
      if (removed > 0 && removed === command.namedChildCount) {
        // Retain success status and redirections in scripts that contain other shell commands.
        const remove = statement === command && compactDuplicates;
        edits.push({
          start: command.startIndex,
          end: remove ? commandRemovalEnd(contents, command) : command.endIndex,
          text: remove ? "" : ":"
        });
      } else {
        edits.push(...commandEdits);
      }
    }
    // Tree-sitter's web binding supplies JS string offsets, including non-ASCII source.
    let updated = contents;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    }
    for (const [name, value] of updates) {
      if (!seen.has(name)) {
        if (updated && !updated.endsWith("\n")) updated += "\n";
        updated += `export ${name}=${shellEscape(value)}\n`;
      }
    }
    const checked = parseChecked(parser, updated);
    checked.delete();
    return updated;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
