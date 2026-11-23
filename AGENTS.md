# dsh-boost — 仓库约定

DSH 插件，给 DSH agent 提供 token 效率优化：工具回执投影（截断 + 定位符 + spill）、确定性参数绑定与守卫、影子期准入。设计与发布说明见 `README.md` / `README.en.md` / `docs/RELEASE.md`。

## Agent skills

### Issue tracker

Issue 在 GitHub（`SAXEM1997/dsh-boost`），用 `gh` CLI；`origin` 是内网 GitLab 镜像，不承接 issue。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范角色，标签字符串即角色名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## 工程约定

- **常驻文档只写当前状态与稳定规则**，变更历史进 `CHANGELOG.md`，git 历史为最终账本。
- **零静态宿主 import**：`dist/` 不得静态 import `@deepseek-ai/*`；客户端产物只允许通过 `require` 解析宿主平台模块。
- **发布门**：`npm run ci && npm run verify:package` 必须绿；门本身要有能失败的负例。
- **错误码是契约**：新增/改名要同步 `README.md`、`README.en.md`、`docs/RELEASE.md` 三处码表。
- **变换必须只追加**：投影与替换只能改**尚未进入历史**的回执，绝不改已经发出过的消息；且必须能只凭输入复现同一串字节。重渲染出不同字节会静默作废 provider 的前缀缓存（缓存命中约占输入的 97%），代价远大于一次投影省下的量。`test/projection-determinism.test.ts` 钉这条，不要放宽它。
