export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export const CODEX_PLUGIN_ARGS_ENV = "CODEX_PLUGIN_CC_ARGS";

/**
 * Reads extra codex CLI arguments from the CODEX_PLUGIN_CC_ARGS environment
 * variable and returns them as an argv array. These are prepended to every
 * codex invocation (e.g. `codex -c model_provider=my-provider app-server`),
 * letting users force global config overrides without editing config.toml.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function getCodexPassthroughArgs(env = process.env) {
  const raw = env?.[CODEX_PLUGIN_ARGS_ENV];
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return splitRawArgumentString(raw);
}

// Inside double quotes a backslash is only special before these characters
// (POSIX); before anything else it stays literal, so `"C:\work\repo"` is kept
// intact while `"a\"b"` still escapes the inner quote.
const DOUBLE_QUOTE_ESCAPABLE = new Set(["\"", "\\", "$", "`"]);

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let doubleQuoteEscaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    // Inside single quotes everything is literal (POSIX semantics), including
    // backslashes — so a Windows path like 'C:\work\repo' survives intact.
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === "\"") {
      if (doubleQuoteEscaping) {
        current += DOUBLE_QUOTE_ESCAPABLE.has(character) ? character : `\\${character}`;
        doubleQuoteEscaping = false;
        continue;
      }
      if (character === "\\") {
        doubleQuoteEscaping = true;
        continue;
      }
      if (character === "\"") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (doubleQuoteEscaping) {
    current += "\\";
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
