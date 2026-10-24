# amadeus-life 交接

## 最新检查点：可信 Host 到期唤醒首段（2026-10-25）

- 原 cordis Creator 实现管理员显式启用、Session allowlist、官方 `resolveAgent → followup → sessions.flush` 的 Life Host adapter；Codex 的跨 Session 伪证、500 行旧 wake 遮蔽、缺失事件监听、可选服务注入及服务撤销竞态回归均经同一 Creator 会话定点返工。独立标准 `node --test` 为 85/85，`npm test` 全部通过。
- 真正的隔离 DSH Desktop 验收：先冷备份 profile 与 SQLite，仅临时允许已有合成 Session；首次发现普通 `ctx.get` 拿不到 Host 服务，修正为 Cordis 可选 `ctx.inject` 后真实投递成功。wake 先为 admitted；Session 持久日志含 `amadeus-life` 来源、匹配 message/wake ID、第 2 个 completed turn。模型只调用 `life_health`、`life_intent_list`、`life_intent_cancel`，自主取消该合成意图，无真实平台外发。取消使 wake 保守变 `superseded`；这证明真实消费但当前 ledger 未记 `executed`，消费与意图失效的区分需下一段修复。重复 drive 和重启均未重投。最后逐字节恢复原隔离 profile patch、撤销私有探针加载，原 Session/Workspace/SQLite 保留。见 [Host 首段验收](docs/verification/HOST_WAKE_SLICE_2026-10-25.md)。
- 包仍标 0.1.0，当前只具备显式受控的到期意图唤醒，不含 idle、完整预算、统一身份、Provider 或 v1.0 十场景；继续原 Creator 会话迭代，不把此首段称为 v1.0 完成。

## 最新检查点：SQLite v3 wake ledger（2026-10-25）

- 原 cordis Creator 会话完成 v2→v3 增量迁移与 `intent_due` 持久 wake ledger；Codex 独立审查发现并先复现三项缺口（过期 admitted 状态回滚、非法 Session 形状候选饥饿、已确认本地事件仍可领取），同一 Creator 会话定点返工并增加 admission 竞争回归。`node --test test/wake-ledger.test.js test/quality-gaps.test.js test/life-core.test.js test/revision.test.js` 为 66/66，`npm test` 各文件 18+20+9+19 项通过，退出码均 0。
- 在独立 Desktop 停止且原会话空闲后，已对原 `life.sqlite`、WAL、SHM 做本机忽略目录的冷备份并逐文件校验哈希；启动同一隔离 Desktop 后，真实开发库从 v2 到 v3，`PRAGMA integrity_check=ok`，9 意图、4 事件、8 活动与租约仍在。不可变业务字段与冷备份逐行摘要一致。原 Creator Session 可恢复，Life bundle active；无生产操作或真实平台外发。详见 [v3 验收](docs/verification/WAKE_LEDGER_V3_2026-10-25.md)。
- `wake_requests` 目前只是可信持久准备、领取、准入与记录接口；尚未接入 Host 自动投递或真实 Session 执行证据。包版本仍 0.1.0；下一段实现 Host adapter，不能把本次 ledger 验收称为 Life 0.2.0 或 v1.0 完成。

## 最新检查点：0.1.0 四项质量修复（2026-10-25）

- 原 cordis Creator 会话继续完成主要实现；失败回归独立提交 `889be0a`，修复独立提交 `92fc18b`。Codex 审查中补充了多活动/单焦点和合法单向关联回归并交回同一会话返工。
- `node --test test/quality-gaps.test.js test/life-core.test.js test/revision.test.js`：47/47 通过，exit 0；`npm test` 同样通过。原 29 项仍通过。详见 [质量修复验收](docs/verification/QUALITY_FIX_2026-10-25.md)。
- 真实隔离 DSH 中服务与 9 工具加载、停用/启用、卸载/重装均通过；强制重启后持久意图保留，运行活动进入 `unknown`，不伪造完成。临时诊断探针已移除；原 Session、Workspace、SQLite 和开发包保留。
- 包仍为 0.1.0，SQLite schema 2。尚无真正 DSH 自动唤醒、可信 Provider 回执协议、统一 Persona、注意力调度或预算；这些属于已授权的连续 Life v1.0 开发，下一步先形成 0.2.0 架构和真实 Session Controller 接入任务。下文旧交接记录是修复前状态，不覆盖此检查点。
- 后续隔离 Host API 探针已证实：无人工新输入的 `sessionController.prompt` 能实际触发完成 turn，但来源记为 `user`；按官方 Schedule 范式构造完整 user-role 消息，以 `amadeus-life` 来源、wakeId、`resolveAgent → followup → sessions.flush` 可持久投递并完成 turn。初次探针遗漏 `role`/`id` 导致一个合成测试 Session 的 turn 失败，该 Session 原样保留；修正后新长期测试 Session 成功。私有探针已卸载。Life 代码尚未接入此能力，下一步是持久 wake ledger、权限/预算/过期检查和真实适配。主仓 `docs/verification/LIFE_HOST_WAKE_SMOKE_2026-10-25.md` 记录边界。

日期：2026-10-25。状态：0.1.0 开发版核心已验收；尚未发布 release、npm 包或部署生产。

## 当前能做什么

SQLite schema v2 保存意图与活动；支持 revision CAS、改期/取消、有界时钟 tick、持久复查 outbox、scope 隔离、部分可信证据检查（存在下述缺口）、单运行时 lease、明确存储错误与生命周期清理。

9 个模型工具已在真实 DSH 注册并调用。没有 QQ、Memory、State 或其他身体也能运行。到期只产生本地引用事件，不自动调用模型、唤醒会话或发送消息。

## 实际开发与验证

- 独立官方 DSH Desktop 0.2.1-rc.3，Workspace 为 Amadeus Life Development。
- Creator 确实为 cordis，模型 deepseek-official / deepseek-flash，High；官方 1017 标签匹配已核实。
- 会话 session-fa594d5f-9c84-4e51-aca1-f8ba8a3ee621；主要实现与两轮具体修复均复用此会话，无子 Agent。
- Codex 独立执行 node --test test/life-core.test.js test/revision.test.js：29 passed / 0 failed，exit 0。npm test 同样通过。
- 真实 DSH 安装、禁用/启用、卸载/重装及独立开发进程强制重启后的持久恢复通过；9 个工具按生命周期撤销/恢复，原 Creator 实际创建、修改、取消、读取意图成功。
- 原有 QQ Bridge、SnowLuma、生产 DSH 配置、登录资料与个人记忆均未修改；无真实平台发送。

## 本地入口

- 项目正常克隆：主项目 plugins/amadeus-life/。
- 活跃开发实例连接的独立克隆：主项目 private/life-development/workspace/amadeus-life/。
- 独立 DSH_HOME / Electron 数据、认证、原始日志和临时探针保留在主项目被忽略的 private/life-development/，不得整体上传。临时探针已卸载清理，Life 保留安装供继续开发。
- 分支 codex/life-core；远端 https://github.com/jeskoky-pixel/amadeus-life 。

## 文档与证据

- docs/INSTALL.md：实际安装/配置接口与公共服务语义。
- docs/verification/REPORT.md：审查、测试、集成、预算与限制。
- docs/verification/creator-and-runtime.json：实际 Creator/模型/工作空间、用量和集成阶段。
- docs/verification/source-manifest.json：被验证源码的内容哈希；最终 SHA 见 PR/交付消息。
- docs/adr/0001-life-runtime.md：为何研究 Schedule/Jobs 后选本地事务 outbox 与轻量 tick。

## 下一步及限制

1. 先以原 Creator 会话补齐 0.1.0 的四项质量缺口，先失败回归再修复，Codex 独立复测与真实开发宿主启停。完成后再规划 0.2.0，并持续朝 Life v1.0 迭代；不要把本地 outbox 当成已完成自动生活或外发。
2. 未来 provider 在执行前重新检查 scope、revision 与最新授权；模型不得自行提供可信证据或授权字段。
3. 更多故障点、多进程/多机器压力与真实平台能力另行验证。本轮只验证合成数据和独立开发环境。
4. 插件许可证仍待拥有者明确，不自动继承主仓库 MIT；private=true 是 npm 防误发设置，GitHub 仓库保持公开。

生产环境保护和仅开发 Life 的边界继续有效。

## 账号切换交接（2026-10-25 实查）

- 当前分支 `codex/life-core`；[PR #2](https://github.com/jeskoky-pixel/amadeus-life/pull/2)（codex/life-core，未合并）；[PR #1](https://github.com/jeskoky-pixel/amadeus-life/pull/1)（codex/m0-baseline，未合并）。交接前功能基线 `46064e0856fc980ddd2d3e10e5d46afa94e3862c`；本轮只更新交接/证据脱敏文档，源码未改。最新文档 SHA 用 `git log -1 --format=%H` 查询。
- 原测试在交接轮独立重跑：29 passed / 0 failed，Node 22.23.2；既有测试并未覆盖全部下述漏洞。
- Codex 已在独立临时数据库复现：`running → completed` 接受 `trustedEvidence:false` 与伪造引用；跨 scope 的 intentId 和 relatedActivityId 以及不存在 intentId 均被接受；公开 close 后即使调用旧 dispose，同进程重开仍 runtime_lease_held；2026-02-30 被归一化为 03-02。ADR 写 schema=1，源码常量为 2。**尚未修复，不得宣称可信 Provider 边界完整。**
- 问题位置、影响边界、回归验收与后续任务：[QUALITY_GAPS.md](docs/verification/QUALITY_GAPS.md)。本轮没有执行此前要求的修复任务，也没有向 DSH 派发新任务。
- 原 Creator 会话可读取：`session-fa594d5f-9c84-4e51-aca1-f8ba8a3ee621`，workspace `cde4653e-bea0-4285-b098-059003a3714c`；cordis / deepseek-official / deepseek-flash / high，workspace-write / never；5 轮 completed，82 steps，收件箱与用户问题为空。未新增有费模型请求测试账号切换。
- 共享契约为 QQ/Life `0.1-draft`，不是运行时总线兼容承诺。SQLite schema=2 与包 0.1.0 是不同版本轴。
- 必读主仓库 [唯一接手入口](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/NEXT_CODEX_START.md)、[DSH 开发协议](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/DSH_DEVELOPMENT.md)。本机恢复见主项目忽略的 `private/handoff/`，不要公开其中内容。
- 不新建整个项目、不丢弃旧会话/数据库、不动生产 SnowLuma/QQ/DSH，不用 Computer Use，不自动 merge/release。授权自动唤醒、Provider、跨会话身份与预算在质量修复后规划；其他插件不在当前开发范围。
