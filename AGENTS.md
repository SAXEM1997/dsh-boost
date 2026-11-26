# dsh-boost — 仓库约定

DSH 插件，给 DSH agent 提供 token 效率优化：工具回执投影（截断 + 定位符 + spill）、确定性参数绑定与守卫、影子期准入。设计与发布说明见 `README.md` / `README.en.md` / `docs/RELEASE.md`。

## Agent skills

### Issue tracker

Issue 在 GitHub（`SAXEM1997/dsh-boost`），用 `gh` CLI；`origin` 是内网 GitLab 镜像，不承接 issue。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范角色，标签字符串即角色名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## 交付流程

- **改动一律走 PR**：`main` 受保护、禁止直接 push。每项改动开一个分支 + PR，squash merge。
- **一个 PR 一件事**：PR 标题就是发版说明里的那一行。一个 PR 里塞进两件互不相关的事，发版时只能写成两行里选一行，或者写成一行半。
- **例外只有两类**：发布流水线自身的修复（`.github/workflows/`、`docs/releases/`、`docs/RELEASE.md` §6）、以及必须立刻上的热修。两者都要事后补一条 issue 记账，说明为什么绕过了 PR。
- **打 tag 前 `main` 的 CI 必须是绿的**：`release.yml` 自己会再跑一遍门，但那条门是「打出去的字节对不对」，不是「这次合并能不能进」。红着的 `main` 上打 tag，等于把红灯记到发布账上。

## 工程约定

- **常驻文档只写当前状态与稳定规则**，变更历史进 `CHANGELOG.md`，git 历史为最终账本。
- **零静态宿主 import**：`dist/` 不得静态 import `@deepseek-ai/*`；客户端产物只允许通过 `require` 解析宿主平台模块。
- **发布门**：`npm run ci && npm run verify:package` 必须绿；门本身要有能失败的负例。
- **错误码是契约**：新增/改名要同步 `docs/RELEASE.md` 的码表（唯一权威表），并在 `README.md`、`README.en.md` 里按需补一句用户可见的后果。README 不复制整张表：同一张表三处手抄必然漂移，而码表是操作者唯一能查的地方。
- **变换必须只追加**：投影与替换只能改**尚未进入历史**的回执，绝不改已经发出过的消息；且必须能只凭输入复现同一串字节。重渲染出不同字节会静默作废 provider 的前缀缓存（缓存命中约占输入的 97%），代价远大于一次投影省下的量。`test/projection-determinism.test.ts` 钉这条，不要放宽它。
