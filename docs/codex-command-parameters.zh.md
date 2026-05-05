# Codex Claude Code 插件命令参数速查

本文总结 `codex-plugin-cc` 提供的 Claude Code slash commands 及其参数。

## 命令总览

| 命令 | 用途 | 是否会修改文件 |
| --- | --- | --- |
| `/codex:setup` | 检查 Codex CLI 是否可用、是否已登录，并可开关 stop-time review gate | 不会 |
| `/codex:review` | 对当前工作区或分支差异运行普通 Codex review | 不会 |
| `/codex:adversarial-review` | 对实现方案、设计取舍和风险做挑战式 review | 不会 |
| `/codex:rescue` | 把调查、计划、review 结果修复或实现任务委托给 Codex | 默认可能会 |
| `/codex:status` | 查看当前仓库里的 Codex 任务状态 | 不会 |
| `/codex:result` | 查看已完成任务的最终输出 | 不会 |
| `/codex:cancel` | 取消正在运行的后台 Codex 任务 | 不会修改代码 |

## `/codex:setup`

```text
/codex:setup [--enable-review-gate|--disable-review-gate]
```

检查本机 Codex CLI 是否已安装、是否已认证。如果缺少 Codex 且 npm 可用，Claude Code 会询问是否安装 `@openai/codex`。

| 参数 | 含义 |
| --- | --- |
| `--enable-review-gate` | 启用 stop-time review gate。Claude 停止前会触发 Codex review，发现问题时阻止结束 |
| `--disable-review-gate` | 关闭 stop-time review gate |

限制：

- `--enable-review-gate` 和 `--disable-review-gate` 不能同时使用。

示例：

```text
/codex:setup
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

## `/codex:review`

```text
/codex:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
```

运行普通 Codex code review。这个命令只做 review，不会修复问题、应用 patch 或修改文件。

| 参数 | 含义 |
| --- | --- |
| `--wait` | 前台等待 review 完成 |
| `--background` | 后台运行 review，之后用 `/codex:status` 和 `/codex:result` 查看 |
| `--base <ref>` | review 当前分支相对某个 git ref 的差异，例如 `main` |
| `--scope auto` | 自动选择 review 目标。工作区有改动时 review working tree，否则 review 当前分支相对默认分支的差异 |
| `--scope working-tree` | review 当前工作区改动，包括 staged、unstaged、untracked |
| `--scope branch` | review 当前分支相对默认分支的差异 |

限制：

- 不支持额外 focus text。
- 不支持 staged-only 或 unstaged-only review。
- 如果需要自定义关注点，用 `/codex:adversarial-review`。

示例：

```text
/codex:review
/codex:review --background
/codex:review --base main
/codex:review --scope working-tree --wait
```

## `/codex:adversarial-review`

```text
/codex:adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]
```

运行挑战式 review。它关注实现方向、设计取舍、隐藏假设和真实场景下的失败模式，不只是找代码缺陷。这个命令也是只读的，不会改文件。

| 参数 | 含义 |
| --- | --- |
| `--wait` | 前台等待 review 完成 |
| `--background` | 后台运行 review |
| `--base <ref>` | review 当前分支相对某个 git ref 的差异 |
| `--scope auto` | 自动选择 review 目标 |
| `--scope working-tree` | review 当前工作区改动 |
| `--scope branch` | review 当前分支相对默认分支的差异 |
| `focus ...` | 额外关注点，例如缓存设计、并发、回滚、权限边界等 |

限制：

- 不支持 `--scope staged` 或 `--scope unstaged`。
- 与 `/codex:review` 使用相同的 review 目标选择逻辑。

示例：

```text
/codex:adversarial-review
/codex:adversarial-review --base main challenge the caching and retry design
/codex:adversarial-review --background look for race conditions and rollback risks
```

## `/codex:rescue`

```text
/codex:rescue [--background|--wait] [--resume|--fresh] [--from-review <review-job-id|session-id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [task ...]
```

把一个调查、计划、review 结果修复或实现任务转交给 Codex。`rescue` 更像是“委托 Codex 接手这个问题”，不是把 Claude Code 的内部状态完整迁移给 Codex。

| 参数 | 含义 |
| --- | --- |
| `--background` | 后台运行 Codex 任务 |
| `--wait` | 前台等待 Codex 任务完成 |
| `--resume` | 继续当前或最近的 Codex rescue 线程 |
| `--fresh` | 强制开启新的 Codex 线程 |
| `--from-review <id>` | 从已完成的 review job id 或 Codex session id 生成修复任务 |
| `--model <model>` | 指定 Codex 使用的模型，例如 `gpt-5.4-mini` |
| `--model spark` | `spark` 是简写，会映射到 `gpt-5.3-codex-spark` |
| `--effort none` | 不使用额外推理强度 |
| `--effort minimal` | 最小推理强度 |
| `--effort low` | 低推理强度 |
| `--effort medium` | 中等推理强度 |
| `--effort high` | 高推理强度 |
| `--effort xhigh` | 最高推理强度 |
| `task ...` | 要 Codex 做的任务描述 |

行为要点：

- 默认会倾向于 write-capable Codex run，也就是 Codex 可能修改文件。
- `--from-review` 默认要求 Codex 对 review findings 做最小安全修复；如果 review 没有实质问题，Codex 应简短验证并避免无意义改动。
- 单独传一个看起来像 review id 的参数，例如 `/codex:rescue review-abc123`，等价于 `/codex:rescue --from-review review-abc123`。
- 如果只想要 plan、分析或诊断，需要在任务描述里明确写 `read-only`、`plan only`、`do not edit files`，或中文“只分析，不要修改文件”。
- `--resume` 和 `--fresh` 不能表达同一个意图；需要二选一。
- 如果不传 `--model` 或 `--effort`，Codex 使用默认选择。

示例：

```text
/codex:rescue --fresh investigate why tests are failing
/codex:rescue --background --model spark fix the failing login test
/codex:rescue --resume implement the previous plan
/codex:rescue --from-review review-abc123
/codex:rescue --from-review thr_review_session fix only the high severity finding
/codex:rescue --fresh --effort high read-only plan only: design the refactor, do not edit files
```

## `/codex:status`

```text
/codex:status [job-id] [--wait] [--timeout-ms <ms>] [--all]
```

查看当前仓库里运行中和近期的 Codex jobs。

| 参数 | 含义 |
| --- | --- |
| `job-id` | 查看某个具体 job 的详细状态 |
| `--wait` | 等待指定 job 结束后再返回 |
| `--timeout-ms <ms>` | 配合 `--wait` 使用，设置最长等待时间，单位毫秒 |
| `--all` | 显示更多历史 jobs，而不只显示默认范围 |

限制：

- `--wait` 需要配合 `job-id` 使用。

示例：

```text
/codex:status
/codex:status --all
/codex:status task-abc123
/codex:status task-abc123 --wait --timeout-ms 300000
```

## `/codex:result`

```text
/codex:result [job-id]
```

查看已完成 job 的最终输出。输出可能包含 review 结论、发现的问题、文件路径、行号、artifact、下一步命令等。

| 参数 | 含义 |
| --- | --- |
| `job-id` | 指定要查看结果的 job。不传时通常查看最近的可用结果 |

示例：

```text
/codex:result
/codex:result task-abc123
```

## `/codex:cancel`

```text
/codex:cancel [job-id]
```

取消一个正在运行的后台 Codex job。

| 参数 | 含义 |
| --- | --- |
| `job-id` | 指定要取消的 job。不传时会尝试取消当前可取消的 job |

示例：

```text
/codex:cancel
/codex:cancel task-abc123
```

## 常见组合

只让 Codex 出 plan，不改文件：

```text
/codex:rescue --fresh read-only plan only: analyze the repo and propose an implementation plan. Do not edit files.
```

让 Codex 后台实现任务：

```text
/codex:rescue --background --fresh implement the requested feature and run relevant tests
```

查看后台任务：

```text
/codex:status
```

等待某个任务结束：

```text
/codex:status task-abc123 --wait --timeout-ms 300000
```

查看最终结果：

```text
/codex:result task-abc123
```

## Runtime 内部参数

插件底层脚本还支持一些内部或命令包装层使用的参数，例如 `--json`、`--cwd`、`--prompt-file`、`--write`、`--resume-last`、`--poll-interval-ms`。日常在 Claude Code 里使用 slash commands 时通常不需要直接使用它们。

公开 slash commands 里最重要的是：

- 用 `/codex:review` 和 `/codex:adversarial-review` 做只读 review。
- 用 `/codex:rescue` 委托 Codex 做调查、计划或实现。
- 用 `/codex:status`、`/codex:result`、`/codex:cancel` 管理后台任务。
