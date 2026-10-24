# amadeus-life

管理跨场景注意力、可调整的未来意图、活动调度、可选心跳与统一预算协调。

**当前状态：0.1.0 开发版 Life v1.0 能力在现有工作树实现，SQLite schema v8；137 项确定性测试通过。真实隔离 DSH 的 idle/无用户输入和模型工具选择已通过；v7→v8 真实开发库冷迁移也已通过。付费能力仅有受信任的本地预留账本，真实平台与支付未验收。尚未发布 release，未连接任何真实平台或支付 Provider。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。仓库已于 2026-10-25 根据用户要求公开，便于网页端审阅。

## 职责与边界

未来通过 QQ 的事件、排队和唤醒接口协作；本版只产生本地重新考虑事件，不独立争抢 QQ 收发，也不盲发旧台词。不依赖 State 或向量记忆运行。

基于官方 DSH 运行，不另建主 Agent 推理循环。本版本只管理“什么时候值得重新思考”：不发送消息、不调用模型、不自动执行外部动作、不读取私聊历史。需要受保护动作时必须有可信授权适配器；未配置时一律拒绝。

## 已实现能力

- **意图**：创建/读取/列表/更新/取消；`id`、`revision`、`createdAt`、`updatedAt`、`reviewAt`、`status`、`description`、`contextScope`、`authorizationRef`、可选 `relatedActivityId`。
- **活动**：`pending`、`running`、`paused`、`stopping`、`completed`、`failed`、`cancelled`、`unknown`，带明确转换表与 revision CAS；v6 增加 `priority`、`checkpointRef`、`resourceLease`、`deadlineAt`。
- **身份**：Persona / Scene / Session / Principal / Data Scope 分离；管理员可信绑定与 revision；private 场景默认隔离，shared 场景需显式 `scene_shares` 授权；撤销绑定使旧 wake 失效、关联活动转 unknown。
- **Idle 心跳**：管理员显式启用并绑定目标 Session；持久安静窗口、活跃度、单窗口去重、安静时段、Host allowlist/预算/崩溃对账共用；tick 本身不调用模型，idle 只提供休息或静默的机会，不发送消息。
- **统一预算**：持久 `budget_scopes` 原子预留自主 wake/模型调用、估算 token、成本与活动并发名额；耗尽时延迟自主工作并保存原因，不阻断普通聊天或现有活动读取/取消；默认关闭、无硬编码日常配额。活动并发按 Session/Persona/global 有效上限在活动 INSERT 的同一 SQLite 临界区检查，无 resource 不能绕过；`pending/running/paused/stopping/unknown` 占用，终态释放。
- **付费能力预留接口（无实际付费 Provider）**：受信任 `reserveCost/settleCost/releaseCost` 按 scope 与 cost_limit 原子预留/结算/释放 cost 单位；幂等键防重复预留，未知结果保持占用，负数和重复结算拒绝；模型不可调用，不触发付款。
- **Activity Provider**：受信任 `describe/start/status/cancel`（可选 `pause/resume/checkpoint/reconcile`）契约；内置确定性的 `LocalVirtualProvider` 跑完整生命周期；Provider 崩溃/无响应进入 unknown，不能由模型证据或超时自证完成。`resource_lease` 由 SQLite 部分唯一索引原子互斥，终止状态释放。
- **模型可实际选择活动（默认关闭）**：管理员启用 `activityTools.enabled` 后新增 `life_activity_start/status/pause/resume/cancel/finish`。owner scope、Persona、Scene、principal、授权修订全部从当前 Session binding 派生；模型只提供目的/优先级/资源/截止时间与期望结果，不能选 Provider、身份或 trusted evidence；完成/失败引用只由 Provider 返回。默认仍只有原九个工具。
- **注意力优先**：真实用户 `user/message` 到达时，同 Session 长活动优先让位：Provider 支持则暂停并保存 checkpoint，不支持则保守 `unknown`；不取消、不销毁、不把旧结果发往随机会话，之后可按原 scope/revision/授权恢复。
- **共享只读视图（默认关闭）**：`sharedRead.enabled` 后 `life_shared_read` 从调用者 binding 推导可见场景；只显示自己的场景或显式 shared+grant 的场景，跨场景描述省略，authorization/principal 永不返回；撤销立即失效。
- **真实用量归账**：自主 turn 的官方 `assistant/message.data.usage` 按 Session+seq 幂等写入 `usage_events` 并累加到预算 token；无 usage 字段时健康显示 `usage_unknown`，保留保守预留，不宣称真实结算。
- **到期复查**：注入时钟 + 有界 tick，每个意图 revision 原子产生一个本地 reconsideration 事件；重复 tick、重启与多连接不会重复领取。
- **持久化**：`node:sqlite` + WAL + `BEGIN IMMEDIATE` + 唯一约束 + revision CAS；schema v8 为 v2–v7 的增量迁移；损坏或未知 schema 明确报错，绝不替换为空库。
- **单运行时所有权**：适配器持有 SQLite lease；第二个仍在运行的适配器以明确健康状态失败关闭，不会执行启动恢复；只有持有者可释放；仅当记录的 PID 可证已死时才接管陈旧 lease。
- **模块解耦**：运行时不 import 任何 QQ、Memory、State、Browser、Bilibili、Android、Games 或其他插件内部代码；源码 import 审计见测试 T10/T11。

## 安装（尚未在本会话执行）

本仓库不修改任何 DSH profile。Codex 审查通过后，由安装者使用 Harness 的 `plugin_manager` `install_bundle`，target 为本目录（或打包后的目录）绝对路径；不要手写 profile 的 `package.json` / `cordis.patch.yml`。

- 包：`@amadeus/life`，`type: module`，无运行时依赖、无安装脚本。
- Bundle patch：`cordis.patch.yml` 插入 `amadeus-life` 行。
- 未声明 license；许可证待定，不因主仓库选择 MIT 而自动继承授权。

## 配置

行 `config` 全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `databasePath` | `$DSH_HOME/amadeus-life/life.sqlite`（无 `DSH_HOME` 时 `~/.dsh/...`） | SQLite 账本绝对路径 |
| `tickIntervalMs` | `1000` | 心跳间隔；`0` 关闭自动 tick，仍可手动 `tickNow()` |
| `maxReviewBatch` | `20` | 单次 tick 最多处理的到期意图数 |
| `wakeDelivery` | 关闭 | 管理员显式启用、Session allowlist、间隔/单次上限；Host wake 默认关闭 |
| `idle` | 关闭 | `enabled`、`targetSessionId`（须在 allowlist）、`windowMs`、`quietAfterActivityMs`、可选 UTC `quietStartHour`/`quietEndHour` |
| `wakeBudget` | 关闭 | `enabled`、`windowMs`、`wakeLimit`、`tokenLimit`、`costLimit`、`activityLimit`、`estimatedTokens`；启用后为每个 allowlist scope 建立持久预算；仅配置 `activityLimit` 也可单独启用活动并发上限 |
| `activityTools` | 关闭 | `enabled`；启用后注册本地虚拟 Provider 的六个模型工具，仍要求活动 Session 有有效 binding |
| `sharedRead` | 关闭 | `enabled`；启用后注册只读 `life_shared_read`，仅按 binding 和显式 grant 返回 |

`tickIntervalMs` 的定时器会 `unref()`，dispose 时清除并关闭数据库。

## 服务与工具

- Host 服务 `ctx.life`：既有意图/活动/事件/wake 证据方法，以及 v1.0 trusted 方法 `createPersona`、`createScene`、`bindSession`、`grantSceneShare`、`revokeSessionBinding`、`allocateIdleWake`、`noteSessionActivity`、`configureBudget`、`getBudget`、`consumeWakeBudget`、`recordTokenUsage`、`reserveCost`、`settleCost`、`releaseCost`、`getCostReservation`、`registerActivityProvider`、`startActivity`、`pauseActivity`、`resumeActivity`、`checkpointActivity`、`cancelActivity`、`reconcileActivity`。这些方法不注册为模型工具。
- 模型工具默认仍为 9 个：`life_intent_create`、`life_intent_get`、`life_intent_list`、`life_intent_update`、`life_intent_cancel`、`life_activity_record`、`life_activity_get`、`life_activity_transition`、`life_health`。启用 `activityTools` 后增加 `life_activity_start/status/pause/resume/cancel/finish` 六个受控工具；启用 `sharedRead` 后增加 `life_shared_read`。新工具不接受 `scope/personaId/sceneId/principalId/providerId/trustedEvidence/evidenceRefs` 等越权字段，身份与 owner scope 从当前 Session binding 派生。
- 默认关闭意味着不注册新工具、不投递 idle、不启动 Provider；管理员显式启用后仍不会真实外发平台消息。
- 参数边界由适配器强制执行（DSH 原生 `tools.register` 不校验 JSON Schema）：每个工具只允许其声明字段，`scope`、`ownerScope`、`contextScope`、`authorizationRef`、`trustedEvidence` 等保留字段与未知字段一律 `LIFE_VALIDATION` 拒绝；`life_intent_update` 只显式复制 `description`/`reviewAt`/`relatedActivityId`，不会把模型参数展开到授权字段上。
- 事件：每次 tick 产生的事件通过 `ctx.emit('life/reconsideration', event)` 发布；payload 只含引用（`eventId`、`intentId`、`intentRevision`、`reviewAt`、`contextScope`、`relatedActivityId`、`delivery: 'local-only'`），不含意图描述、授权引用或待发送文本。授权方可通过 `getIntent` 读取描述。

## 事件与完成语义

- 每个 `(intentId, revision)` 最多一个 reconsideration 事件；改期/修改增加 revision 并使旧 pending 事件失效，取消使该意图的 pending 事件全部失效。
- `acknowledgeEvent` 只表示本地已读，不表示外部动作已执行或完成。
- 活动 `completed` 必须带 `evidenceRefs`；超时、轮询、取消请求都不会被记为完成。
- 活动取消：`pending → cancelled` 是安全的本地记录（尚未开始）；`running`/`paused` 只进入 `stopping`；`unknown` 保持 `unknown`。`stopping`/`unknown → cancelled` 以及 `unknown → completed` 必须带可信 provider 边界的证据（`trustedEvidence`），模型工具参数、`note` 或自行声明的证据不能自证外部已停止。
- 取消后的迟到完成结果返回 `LIFE_STALE_RESULT`，不恢复意图。
- 插件启动时，lease 持有者会把上一所有者遗留的 `running`/`stopping` 活动标为 `unknown`（revision +1），等待显式对账；不会被自动记为完成或重放。第二个存活适配器不会执行该恢复。
- 本地记录、provider 确认与外部完成是不同事实；当前没有安装真实外部 provider，外部动作默认拒绝。

## 存储与降级

- 已存在文件先做 `integrity_check`、`schema_version` 与必需表校验；损坏、未知版本或缺表都会抛 `LIFE_STORAGE`，不删除或替换已有库。
- 启动失败时插件仍以 `life` 服务存在，`getHealth()` 返回 `state: 'unavailable'`，其他方法明确失败；不崩溃宿主，也不伪造空状态。
- 同一数据库的第二个存活适配器以 `state: 'degraded'` / `reason: 'runtime_lease_held'` 失败关闭，不读取、不写入、不恢复；释放后新适配器才可接管。
- tick 失败使健康状态变为 `degraded` 并记录 `lastTickError`；后续 tick 成功才恢复。
- dispose：清除定时器、释放 lease、关闭数据库；释放只对持有该 lease 的实例生效，重复 close 安全。

## 测试

```powershell
npm test
node test/life-v1.test.js
```

当前结果：137 个确定性测试全部通过（quality-gaps 18、life-core 20、revision 9、wake-ledger 19、wake-host 28、wake-consumption 24、life-v1 15、v1-budget 4）。覆盖 v2→v8/v3→v8/v4→v8/v5→v8/v6→v8/v7→v8 迁移与回滚、Host 消费证据与重启对账、身份隔离/撤销、idle 资格与投递、预算边界、虚拟 Provider 生命周期与崩溃、资源互斥、用户消息优先暂停、共享只读视图、官方 usage 幂等归账、意图关联/撤权竞态、迟到 Provider 结果、活动并发与付费预留。十场景映射见 [V1_TEN_SCENARIOS](docs/verification/V1_TEN_SCENARIOS.md)。Codex 已在标准 runner 执行 `node --test test/*.test.js`，137/137 通过；`npm test` 八组全通过。Creator 沙箱曾出现过 `spawn EPERM`。



## 已知限制（未验收部分）

- 独立真实 DSH Desktop 0.2.1-rc.3 已验证无用户输入 idle、模型调用受控本地 Provider 工具、插件停启与恢复，以及 v7→v8 开发库冷迁移。活动并发与付费预留在真实开发库上尚无外部 Provider 验收；确定性并发/边界测试已通过。
- 事件仅本地 outbox 发布；Host wake 仅在管理员显式启用并配置 allowlist/预算时投递，仍不发送平台消息。
- 未接入真实外部 Activity Provider、平台发送器、付款或发布流程；`LocalVirtualProvider` 仅用于确定性本地验证。新活动/共享工具默认关闭。
- token 仅接受官方 `assistant/message.data.usage`；缺失时显示 `usage_unknown` 并保留保守预留，不宣称真实成本结算。活动并发/付费预留接口未接真实支付 Provider；多进程真实竞争与平台验收未完成。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [运行时 ADR](docs/adr/0001-life-runtime.md)：API 调研、存储/定时/事件/降级决策。
- [v1 身份/idle/Provider ADR](docs/adr/0006-life-v1-identity-idle-budget-provider.md)
- [v8 活动并发/付费预留 ADR](docs/adr/0007-activity-concurrency-paid-reservation.md)
- [M0 模块边界](docs/M0.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

## 发布与隐私

安装与配置见 [docs/INSTALL.md](docs/INSTALL.md)，完整验收见 [docs/verification/REPORT.md](docs/verification/REPORT.md)。许可证尚待明确。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
