
import fs from "node:fs";
import path from "node:path";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}
function removeStale(lockFile, staleMs) {
  try {
    const stat = fs.statSync(lockFile);
    const pid = Number.parseInt(fs.readFileSync(lockFile, "utf8").split(":", 1)[0], 10);
    if (Number.isFinite(pid) && processAlive(pid)) return false;
    if (!Number.isFinite(pid) && Date.now() - stat.mtimeMs <= staleMs) return false;
    fs.unlinkSync(lockFile); return true;
  } catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}
export async function withFileLock(lockFile, options = {}, action) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const staleMs = options.staleMs ?? 30_000;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lockFile, "wx", 0o600); fs.writeFileSync(fd, token, "utf8"); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (removeStale(lockFile, staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock at ${lockFile}.`);
      await sleep(options.retryMs ?? 25);
    }
  }
  try { return await action(); }
  finally {
    try { fs.closeSync(fd); } finally {
      try { if (fs.readFileSync(lockFile, "utf8") === token) fs.unlinkSync(lockFile); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}
