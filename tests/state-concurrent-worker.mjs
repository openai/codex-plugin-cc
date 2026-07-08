import { upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const cwd = process.argv[2];
const workerId = process.argv[3];
const jobCount = Number(process.argv[4] ?? 0);

for (let index = 0; index < jobCount; index += 1) {
  upsertJob(cwd, {
    id: `worker-${workerId}-job-${index}`,
    status: "running",
    title: `Worker ${workerId} job ${index}`
  });
}
