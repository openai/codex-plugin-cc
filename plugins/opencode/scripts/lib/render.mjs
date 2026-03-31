export function renderSetupReport(report) {
  const lines = [
    "# OpenCode Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- opencode: ${report.opencode.detail}`,
    ""
  ];

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(result) {
  if (result.stdout) {
    return result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`;
  }
  if (result.stderr) {
    return `OpenCode error:\n${result.stderr}\n`;
  }
  return "OpenCode did not return any output.\n";
}

export function renderStatusReport(report) {
  const lines = ["# OpenCode Status", ""];

  if (report.running.length > 0) {
    lines.push("Active jobs:");
    for (const job of report.running) {
      lines.push(`- ${job.id} | ${job.status} | ${job.title ?? "task"} | ${job.summary ?? ""}`);
    }
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      lines.push(`- ${job.id} | ${job.status} | ${job.title ?? "task"} | ${job.summary ?? ""}`);
    }
    lines.push("");
  }

  if (report.running.length === 0 && report.recent.length === 0) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobResult(job, storedJob) {
  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }
  if (storedJob?.result?.stdout) {
    return storedJob.result.stdout.endsWith("\n") ? storedJob.result.stdout : `${storedJob.result.stdout}\n`;
  }

  const lines = [
    `# ${job.title ?? "OpenCode Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.sessionId) {
    lines.push(`Session: ${job.sessionId}`);
  }
  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else {
    lines.push("", "No captured result for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  return [
    "# OpenCode Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ].join("\n");
}
