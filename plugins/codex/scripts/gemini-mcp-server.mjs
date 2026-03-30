#!/usr/bin/env node

import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { renderCompanionOutput, runCompanionCommand } from "./lib/gemini-runtime.mjs";

const RAW_ARGS_SCHEMA = z.object({
  raw_args: z
    .string()
    .optional()
    .default("")
    .describe("Raw command-line arguments to forward to codex-companion verbatim.")
});

function registerCompanionTool(server, name, description, subcommand) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: RAW_ARGS_SCHEMA
    },
    async ({ raw_args = "" }) => {
      const result = runCompanionCommand({
        subcommand,
        workspacePath: process.cwd(),
        rawArgs: raw_args,
        env: process.env
      });
      return {
        content: [
          {
            type: "text",
            text: renderCompanionOutput(result)
          }
        ],
        isError: (result.status ?? 0) !== 0
      };
    }
  );
}

const server = new McpServer({
  name: "codex-companion",
  version: "1.0.0"
});

registerCompanionTool(
  server,
  "codex_setup",
  "Run the local Codex setup command for the active Gemini workspace.",
  "setup"
);
registerCompanionTool(
  server,
  "codex_review",
  "Run a local read-only Codex review for the active Gemini workspace.",
  "review"
);
registerCompanionTool(
  server,
  "codex_adversarial_review",
  "Run a local adversarial Codex review for the active Gemini workspace.",
  "adversarial-review"
);
registerCompanionTool(
  server,
  "codex_status",
  "Show local Codex job status for the active Gemini workspace.",
  "status"
);
registerCompanionTool(
  server,
  "codex_result",
  "Show the stored local Codex job result for the active Gemini workspace.",
  "result"
);
registerCompanionTool(
  server,
  "codex_cancel",
  "Cancel a local Codex job for the active Gemini workspace.",
  "cancel"
);

const transport = new StdioServerTransport();
await server.connect(transport);
