export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const repeatableValueOptions = new Set(config.repeatableValueOptions ?? []);
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
        if (repeatableValueOptions.has(key)) {
          options[key] = [...(options[key] ?? []), nextValue];
        } else {
          options[key] = nextValue;
        }
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
      if (repeatableValueOptions.has(key)) {
        options[key] = [...(options[key] ?? []), nextValue];
      } else {
        options[key] = nextValue;
      }
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (quote === "\"" && character === "\\" && (raw[index + 1] === "\"" || raw[index + 1] === "\\")) {
        current += raw[index + 1];
        index += 1;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\\") {
      if (raw[index + 1] === undefined) {
        current += "\\";
      } else {
        current += raw[index + 1];
        index += 1;
      }
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
  if (current) {
    tokens.push(current);
  }

  return tokens;
}
