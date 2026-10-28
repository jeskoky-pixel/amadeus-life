# Amadeus Life v1.1.0 隔离验收

日期：2026-10-28。对象：`@amadeus/life` 开发分支 `codex/life-v1-1-workspace`。所有操作在独立 DSH Desktop、独立数据目录与开发数据库中完成；生产 DSH、QQ、NapCat、State/Memory 仓库未修改。

## 结论

v1.1.0 的工作区绑定、会话规则、调度边界、控制台和迁移路径已达到开发 PR 验收条件。自主唤醒在验收结束时保持关闭，测试 Session 规则恢复为“仅被动参与”。此报告不代表外部 Provider、真实 QQ 外发或生产部署验收。

## 真实 Desktop 与持久化

- 隔离 DSH Desktop 实际加载 `@amadeus/life` 1.1.0，插件健康为 `ok`。重启后控制台卡片样式、八页导航和工作区绑定仍在。
- 通过 GUI 绑定官方 DSH Workspace。当前和新建的工作区 Session 显示在规则页；新 Session 自动取得同一 Life Persona 身份绑定，并可在意图创建表单中选择。工作区外 Session 未自动纳入。
- GUI 保存“独立计划”的 Wake、Token、活动并发与安静时段参数，重启后读取值一致；随后恢复测试 Session 为“仅被动参与”。
- GUI 创建 `SYNTHETIC_LIFE_V1_1_GUI_QA` 意图；修复 Owner 编辑/取消端点的 revision 传递和更新映射后，再次重启并通过 GUI 取消。状态从 `active` 变为 `cancelled`，历史行保留。
- 活动中心真实显示本地虚拟 Provider 的 `paused`、`unknown`、`completed`、`failed` 记录及可用操作；数据与诊断、预算与注意力、自主唤醒、身份与工作区等页面按功能分区。截图：[总览](life-v1.1-desktop-overview.png)、[会话规则](life-v1.1-desktop-rule.png)。截图已移除隔离 Session/Workspace ID。

## 自动验收

`npm test`：209/209 通过，0 失败。覆盖旧版能力、Workspace 当前/新增/移除成员、四种模式、全局与独立预算、Host wake 拒绝与幂等、Owner API、GUI 意图编辑/取消、v9→v10 备份/迁移/恢复和包隐私。`npm run build`、`npm run verify:package`、`git diff --check` 均通过。包白名单共 33 个文件。

## 升级与回滚

SQLite v10 增量加入 `life_workspace` 与 `session_rules`。旧 v2–v9 数据库在迁移前通过 SQLite 一致快照备份并校验；失败则拒绝迁移。旧 allowlist 在绑定 Workspace 时不自动扩大；只有管理员明确启用工作区自主唤醒后，继承/独立规则才获得相应资格。回滚前停止插件，按 [升级说明](../UPGRADE.md) 使用迁移前快照恢复；不要用 v1.0 程序直接打开 v10 数据库。

## 原型差异与仍需实机验证

- 参考原型的浅色卡片和八页信息架构已用于独立 Life 设置界面；当前承载于 DSH 原生插件设置页，未另起 Web 服务。恢复数据库仍由停机命令行流程完成，GUI 只负责创建和列出备份，避免在线覆盖正在使用的数据库。
- 活动页面保留状态与基本控制；Checkpoint、资源租约和 Provider 细节主要通过现有 Host/诊断数据与操作接口查看，尚未做到原型级逐项可视化。
- 外部活动 Provider、实际付费、真实 QQ 外发、无 State 插件时的独立 Desktop 安装，以及多进程并发竞争尚未实机验证。State 缺席、QQ 外发权限边界和跨会话资源互斥由确定性测试覆盖，不能代替真实平台结论。
