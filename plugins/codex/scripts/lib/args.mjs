export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;
  const stopAtFirstPositional = Boolean(config.stopAtFirstPositional);

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
      passthrough = stopAtFirstPositional;
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
      passthrough = stopAtFirstPositional;
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
    passthrough = stopAtFirstPositional;
  }

  return { options, positionals };
}

export function splitRawArgumentStringWithSpans(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let tokenStart = null;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      tokenStart ??= index;
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      tokenStart ??= index;
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStart !== null) {
        tokens.push({ value: current, start: tokenStart, end: index });
        current = "";
        tokenStart = null;
      }
      continue;
    }

    tokenStart ??= index;
    current += character;
  }

  if (escaping) current += "\\";
  if (tokenStart !== null) tokens.push({ value: current, start: tokenStart, end: raw.length });
  return tokens;
}

export function splitRawArgumentString(raw) {
  return splitRawArgumentStringWithSpans(raw).map((token) => token.value);
}
