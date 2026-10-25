# Life 0.1.0 质量修复验收

日期：2026-10-25（Asia/Shanghai）。范围：仅独立 Life 开发克隆与隔离 DSH Desktop；未接触生产实例、真实平台或其他插件。

## 可复现证据

- 失败回归提交 `889be0a`：`node --test test/quality-gaps.test.js` 为 14 tests、3 pass、11 fail、exit 1。覆盖伪造 running 完成、缺失/跨 scope 关联、公开 close 遗留 lease、日期滚动与 ADR 版本。
- 修复提交 `92fc18b`：Creator 在原 `cordis` 会话实现主要源码，同会话完成两轮 Codex 指定返工。Codex 补了多活动/单焦点与合法单向关联用例。最终 `node --test test/quality-gaps.test.js test/life-core.test.js test/revision.test.js` 为 47 pass、0 fail、exit 0；`npm test` 分别 18、20、9 pass，exit 0。所有自动化用例使用临时合成 SQLite 库。
- 完成状态按真实 Session projection 为 9 轮均有 response、116 model steps，`cordis`、`deepseek-official/deepseek-flash`、High、Workspace Write。此处只记录执行摘要，不公开会话原始内容或凭据。

## 行为结论

1. `running/unknown → completed` 需要非空引用和受信任宿主证据标记；模型工具无法自行设定可信标记，拒绝时状态、revision 和 evidence 不变。取消意图的迟到结果仍优先报 `LIFE_STALE_RESULT`。当前没有真实 Activity Provider，宿主标记只是本阶段边界。
2. 新建/修改意图及记录活动检查关联存在、同 scope、取消与冲突关系，事务失败不产生部分写入。一个意图可关联多项活动，`relatedActivityId` 是可选单值焦点。历史损坏或跨 scope 关联不自动改写，危险完成路径保守拒绝。
3. `ctx.life.close()` 与 Host dispose 共用幂等清理，释放 timer、精确所有者 lease 和 SQLite 句柄；同进程重新启用有回归测试。
4. 日期按 UTC 毫秒格式和实际日历往返校验，拒绝 2 月 30 日、非闰年日期与 24:00 等滚动；ADR 与源码均为 `schema_version = 2`，没有因文档修正而迁移数据。

## 真实隔离 DSH

- 官方 Desktop / CLI 0.2.1-rc.3，Plugin Manager `application=applied`。启用时真实 Cordis service 存在且 9 个工具已注册，schema 2、health ok。禁用和卸载后服务/工具均撤销，重新启用和安装后恢复且持久状态仍在。
- 受控私有探针在开发 DB 中创建合成意图及运行活动。强制终止经 PID、可执行文件与独立 userData 核验的开发进程树，重启后意图仍存在，活动为 `unknown`，9 工具恢复。未执行外部平台动作。
- 首次恢复探针显示一条 `running`：探针自身在重启时重放了尚留在私有命令文件中的 `smoke`，新建了第二条活动；原活动已为 `unknown`。清除该命令并再次强制重启后，恢复探针通过，所有旧运行活动均为 `unknown`。这是验收脚本的重放问题，不能记作第一次通过；私有原始结果保留本机。诊断探针随后移除，Life 保持安装启用，原 Creator 会话与数据库保留。

## 边界

此验收只证明 0.1.0 质量修复及本地生命周期。自动唤醒 DSH、Provider 回执、统一生活身份、注意力和预算尚未实现；不把受控虚拟测试等同真实 QQ 或其他平台体验。插件独立许可仍未决定，未发布、部署或合并 PR。
