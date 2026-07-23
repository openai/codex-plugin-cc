import process from "node:process";

/**
 * Read Claude Code hook stdin JSON with a hard deadline.
 *
 * `fs.readFileSync(0)` blocks until EOF. On Windows, Claude Code sometimes
 * leaves the write end open after sending the payload, so Stop hooks hang
 * until the external hook timeout (see #530). Prefer this timed reader.
 *
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
export function readHookInput(timeoutMs = 5000) {
  if (process.stdin.isTTY) {
    return Promise.resolve({});
  }

  return new Promise((resolve) => {
    let raw = "";
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      try {
        process.stdin.pause();
      } catch {
        // ignore
      }

      const text = String(value ?? "").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    };

    const timer = setTimeout(() => finish(raw), timeoutMs);
    const onData = (chunk) => {
      raw += chunk;
    };
    const onEnd = () => finish(raw);
    const onError = () => finish(raw);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
