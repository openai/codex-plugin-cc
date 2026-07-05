# Codex Plugin Test Execution Records
# Run one at a time. Updated manually.

test_results = [
    {
        "test_file": "tests/broker-endpoint.test.mjs",
        "command": "node --test tests/broker-endpoint.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "createBrokerEndpoint uses Unix sockets on non-Windows",
            "createBrokerEndpoint uses named pipes on Windows"
        ],
        "tests_failed": [],
        "duration_ms": 172.593
    },
    {
        "test_file": "tests/bump-version.test.mjs",
        "command": "node --test tests/bump-version.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "bump-version updates every release manifest",
            "bump-version check mode reports stale metadata"
        ],
        "tests_failed": [],
        "duration_ms": 552.3207
    },
    {
        "test_file": "tests/commands.test.mjs",
        "command": "node --test tests/commands.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "review command uses AskUserQuestion and background Bash while staying review-only",
            "adversarial review command uses AskUserQuestion and background Bash while staying review-only",
            "continue is not exposed as a user-facing command",
            "rescue command absorbs continue semantics",
            "transfer, result, and cancel commands are exposed as deterministic runtime entrypoints",
            "internal docs use task terminology for rescue runs",
            "hooks keep session-end cleanup and stop gating enabled",
            "setup command can offer Codex install and still points users to codex login"
        ],
        "tests_failed": [],
        "duration_ms": 183.063
    },
    {
        "test_file": "tests/git.test.mjs",
        "command": "node --test tests/git.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "resolveReviewTarget prefers working tree when repo is dirty",
            "resolveReviewTarget falls back to branch diff when repo is clean",
            "resolveReviewTarget honors explicit base overrides",
            "resolveReviewTarget requires an explicit base when no default branch can be inferred",
            "collectReviewContext keeps inline diffs for tiny adversarial reviews",
            "collectReviewContext skips untracked directories in working tree review",
            "collectReviewContext falls back to lightweight context for larger adversarial reviews",
            "collectReviewContext falls back to lightweight context for oversized single-file diffs",
            "collectReviewContext keeps untracked file content in lightweight working tree context"
        ],
        "tests_skipped": [
            "collectReviewContext skips broken untracked symlinks instead of crashing"
        ],
        "tests_failed": [],
        "duration_ms": 28943.959
    },
    {
        "test_file": "tests/process.test.mjs",
        "command": "node --test tests/process.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "terminateProcessTree uses taskkill on Windows",
            "terminateProcessTree treats missing Windows processes as already stopped"
        ],
        "tests_failed": [],
        "duration_ms": 165.4144
    },
    {
        "test_file": "tests/render.test.mjs",
        "command": "node --test tests/render.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "renderReviewResult degrades gracefully when JSON is missing required review fields",
            "renderStoredJobResult prefers rendered output for structured review jobs"
        ],
        "tests_failed": [],
        "duration_ms": 142.3464
    },
    {
        "test_file": "tests/state.test.mjs",
        "command": "node --test tests/state.test.mjs",
        "status": "PASS",
        "tests_passed": [
            "resolveStateDir uses a temp-backed per-workspace directory",
            "resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided",
            "saveState prunes dropped job artifacts when indexed jobs exceed the cap"
        ],
        "tests_failed": [],
        "duration_ms": 31785.7201
    },
    {
        "test_file": "tests/runtime.test.mjs",
        "command": "node --test tests/runtime.test.mjs",
        "status": "PARTIAL_PASS",
        "tests_passed": [
            "session start hook exports the Claude session id, transcript path, and plugin data dir",
            "task logs subagent reasoning and messages with a subagent prefix",
            "task waits for the main thread to complete before returning the final result",
            "task ignores later subagent messages when choosing the final returned output",
            "task can finish after subagent work even if the parent turn/completed event is missing",
            "task using the shared broker still completes when Codex spawns subagents",
            "cancel stops an active background job and marks it cancelled",
            "cancel without a job id ignores active jobs from other Claude sessions",
            "cancel with a job id can still target an active job from another Claude session"
        ],
        "tests_failed": [
            "4 resource/event loop timeout-related tests failed on 32-bit Windows concurrency"
        ],
        "duration_ms": 536342.3297
    }
]
