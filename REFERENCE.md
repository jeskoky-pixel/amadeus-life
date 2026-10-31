# Amadeus Life 1.2.1（发行候选）

预构建 DSH Bundle 已在官方 DSH Desktop `0.2.1-rc.3` 附带运行时的隔离 Profile 中验证安装和升级。公开 npm 与市场收录尚未执行。普通用户的安装、升级、卸载和数据保留步骤见 [v1.2 安装说明](docs/INSTALL_V1_2.md)、[升级政策](docs/UPGRADE_POLICY.md) 和 [数据迁移](docs/DATA_MIGRATION.md)。

Amadeus Life 是 DeepSeek Harness 的独立生活调度插件。它帮你记住待办意图，在合适的时间提醒 DSH 重新思考，并管理活动、注意力和自主运行预算。

> 历史基线：1.1.0 经 [PR #4](https://github.com/jeskoky-pixel/amadeus-life/pull/4) 合并，四插件联合验收见 [历史报告](https://github.com/jeskoky-pixel/amadeus-qq/blob/main/docs/verification/FOUR_PLUGIN_V11_JOINT_2026-10-28.md)。

## 使用者可以做什么

- 在 DSH 设置中打开 **Amadeus Life**，按首次配置向导选择预设，并在工作区页绑定官方 DSH Workspace。
- 在 **工作区** 页选择官方 DSH Workspace；成员由 Workspace Registry 的可信 Session 归属决定，新成员自动纳入。绑定本身不扩大自主唤醒，需管理员显式启用；支持继承/仅被动/独立计划/完全停用四种会话规则。
- 创建、查看、修改和取消未来意图；到期时由本地心跳与授权唤醒机制重新考虑，而不是直接对外发送消息。
- 管理活动的启动、暂停、恢复、取消与状态；内置本地虚拟 Provider 可安全演示完整流程。真实外部动作需要另行接入可信 Provider。
- 设定安静时段、注意力让位、活动并发、模型调用与成本预算；在运行状态页查看阻止或延迟的原因。
- 通过 GUI 查看健康状态、创建备份，并在重启后恢复隔离 SQLite 数据。

日常设置使用 DSH 原生页面，不需要手动改数据库。安装、配置、升级及回滚步骤见 [用户指南](docs/USER_GUIDE.md) 与 [安装说明](docs/INSTALL.md)。Life 可单独安装；State 和 Memory 是可选协作插件。

**验证状态：209/209 项确定性测试通过。1.0.0 已在独立 DSH Desktop 完成产品化验收；1.0.1 在隔离官方 DSH/QQ 环境完成受控外发唤醒验证（[公开报告](docs/verification/QQ_EXTERNAL_WAKE_2026-10-27.md)）：仅一次授权私有 Scene 的 `qq_send_message` 调用与一次 opt-in 关闭后的零发送对照，不代表普遍自主性或长期可靠性。生产部署、付款与生产平台发送未验收。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。仓库已于 2026-10-25 根据用户要求公开，便于网页端审阅。

## 职责与边界

未来通过 QQ 的事件、排队和唤醒接口协作；本版只产生本地重新考虑事件，不独立争抢 QQ 收发，也不盲发旧台词。不依赖 State 或向量记忆运行。

基于官方 DSH 运行，不另建主 Agent 推理循环。Life 自身只管理“什么时候值得重新思考”：不发送平台消息、不调用模型、不自动执行外部动作、不读取私聊历史。需要受保护动作时必须有可信授权适配器；未配置时一律拒绝。唯一例外是管理员显式配置的外发提示 opt-in：只改变 wake prompt，实际发送仍由下游 QQ 工具与 Scene 授权决定。

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
- **共享只读视图（默认关闭）**：`sharedRead.enabled` 后 `life_shared_read` 从调用者 binding 推导可见场景；只显示自己的场景或显式 shared+grant 的场景，跨场景描述、dataScope、checkpoint/resource 与内部引用省略，authorization/principal 永不返回；撤销立即失效。
- **单屏首次运行**：`scripts/life-setup.mjs` 生成 core/autonomous/activity 完整配置；autonomous/activity 含默认关闭的显式 `bootstrap`，首次加载创建一个稳定 Persona、每个 allowlist Session 一个 private Scene 与 binding，同配置重启幂等且不增 revision；已有不同 binding 时 fail closed，不覆盖历史。`--out` 只创建新文件。
- **真实用量归账**：自主 turn 的官方 `assistant/message.data.usage` 按 Session+seq 幂等写入 `usage_events` 并累加到预算 token；无 usage 字段时健康显示 `usage_unknown`，保留保守预留，不宣称真实结算。
- **到期复查**：注入时钟 + 有界 tick，每个意图 revision 原子产生一个本地 reconsideration 事件；重复 tick、重启与多连接不会重复领取。
- **持久化**：`node:sqlite` + WAL + `BEGIN IMMEDIATE` + 唯一约束 + revision CAS；schema v10 为 v2–v9 的增量迁移；损坏或未知 schema 明确报错，绝不替换为空库。
- **单运行时所有权**：适配器持有 SQLite lease；第二个仍在运行的适配器以明确健康状态失败关闭，不会执行启动恢复；只有持有者可释放；仅当记录的 PID 可证已死时才接管陈旧 lease。
- **模块解耦**：运行时不 import 任何 QQ、Memory、State、Browser、Bilibili、Android、Games 或其他插件内部代码；源码 import 审计见测试 T10/T11。
- **原生 DSH 设置页**：`dsh.client` 加载 `./client`，在 Settings 左侧注册 **Amadeus Life**；所有 24 个 Config 字段均为 volatile，满足 DSH `dsh-settings` 的表单投影/`whileServed` 契约；同时注册 `plugins.row.config` 配置页和 `plugins.detail.section` 基础配置卡。页面提供总览、首次配置向导（Core/Autonomous/Local Activity）、Session allowlist/binding 管理、意图、活动、预算与诊断。页面通过 owner-authenticated same-origin `/api/amadeus-life` 访问宿主，不直连 SQLite；配置保存/取消/恢复默认/冲突使用同一 Config Schema 与 Config Forms。字段为重启生效：保存后重启/重载插件才改变调度与工具，页面明确提示，不伪装即时生效。
- **产品化交付**：版本 `1.1.0`；`npm run build` 生成 `lib/client.js`，`npm run package` 生成 `dist/amadeus-life-1.1.0.tgz`、SHA-256 与包元数据。安装、升级、备份/回滚见用户指南。

## 安装

本仓库不修改任何 DSH profile。v1.2 候选使用 Plugin Manager / `plugin_manager` 安装**版本化预构建包** `amadeus-life-1.2.1.tgz`；不要手写 profile 的 `package.json` / `cordis.patch.yml`。升级时使用新版本包，安装后核对版本与数据路径，再重启/重载插件。

- 包：`@fg-lab/amadeus-life`，`type: module`，无运行时依赖、无安装脚本。
- Bundle patch：`cordis.patch.yml` 插入 `amadeus-life` 行。
- 本仓库经所有者确认采用 [MIT 许可证](LICENSE)；v1.2 发行包使用公开 npm Scope `@fg-lab`，并保留固定版本 GitHub Release 安装源。

## 配置

行 `config` 全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `databasePath` | `$DSH_HOME/amadeus-life/life.sqlite` | SQLite 账本绝对路径；留空使用默认路径，修改需重启 |
| `tickIntervalMs` / `maxReviewBatch` | `1000` / `20` | Host tick 与每次到期复查上限；`0` 关闭自动 tick |
| `wakeDeliveryEnabled` / `allowedSessionIds` | 关闭 / `[]` | 自主 Host wake 与合法 Session allowlist；默认关闭 |
| `externalMessageSessionIds` | `[]` | 外发提示 opt-in：必须是 `allowedSessionIds` 的子集；仅持久化模型工具来源 intent 的 wake 获得可考虑使用外部工具的提示，idle/管理员意图保持非发送提示；实际外发由 QQ Scene Guard 决定 |
| `wakeIntervalSeconds` / `maxPerDrive` | `60` / `1` | 低频检查节拍与单次投递上限 |
| `idleEnabled` / `idleTargetSessionId` | 关闭 / 空 | 空闲机会及目标（须在 allowlist） |
| `idleWindowMinutes` / `quietAfterActivityMinutes` | `30` / `5` | idle 窗口与活动后安静期 |
| `quietStartHour` / `quietEndHour` | `-1` / `-1` | UTC 安静时段；两者同时设置或同时 `-1` |
| `wakeBudgetEnabled` / `wakeLimit` | 关闭 / `20` | 统一持久预算与每窗口 wake 上限 |
| `wakeWindowHours` / `tokenLimit` / `costLimit` | `24` / `0` / `0` | 预算窗口；0 表示未设置 token/cost 上限 |
| `activityLimit` | `0` | 同时活动上限；0 关闭 |
| `activityToolsEnabled` | 关闭 | 六个本地虚拟 Provider 活动工具 |
| `sharedReadEnabled` | 关闭 | 只读 `life_shared_read`，按 binding/grant 返回 |
| `bootstrapEnabled` / `bootstrapPersonaName` | 关闭 / `Amadeus` | 首次创建稳定 Persona、每 Session private Scene/binding；冲突 fail closed |

这些扁平字段是 DSH Config Forms / Plugin Manager 的管理员入口。旧的程序化嵌套配置（如 `wakeDelivery.allowedSessionIds`）仍为兼容性接受，但不应作为管理员配置方式。

`tickIntervalMs` 的定时器会 `unref()`，dispose 时清除并关闭数据库。

## 服务与工具

- Host 服务 `ctx.life`：既有意图/活动/事件/wake 证据方法，以及 v1.0 trusted 方法 `createPersona`、`createScene`、`bindSession`、`grantSceneShare`、`revokeSessionBinding`、`allocateIdleWake`、`noteSessionActivity`、`configureBudget`、`getBudget`、`consumeWakeBudget`、`recordTokenUsage`、`reserveCost`、`settleCost`、`releaseCost`、`getCostReservation`、`registerActivityProvider`、`startActivity`、`pauseActivity`、`resumeActivity`、`checkpointActivity`、`cancelActivity`、`reconcileActivity`。这些方法不注册为模型工具。
- 模型工具默认仍为 9 个：`life_intent_create`、`life_intent_get`、`life_intent_list`、`life_intent_update`、`life_intent_cancel`、`life_activity_record`、`life_activity_get`、`life_activity_transition`、`life_health`。启用 `activityTools` 后增加 `life_activity_start/status/pause/resume/cancel/finish` 六个受控工具；启用 `sharedRead` 后增加 `life_shared_read`。新工具不接受 `scope/personaId/sceneId/principalId/providerId/trustedEvidence/evidenceRefs` 等越权字段，身份与 owner scope 从当前 Session binding 派生。
- 默认关闭意味着不注册新工具、不投递 idle、不启动 Provider。默认所有 wake 都提示禁止外发，idle wake 即使配置了 opt-in 也始终禁止。管理员可在扁平字段 `externalMessageSessionIds`（默认 `[]`，必须是 `allowedSessionIds` 的子集）中显式列出 Session。仅这些 Session 内、且持久化当前 intent 具有模型工具来源（`authorizationRef` = `life-tool:session:<targetSessionId>`）的 intent wake，才会在 prompt 中获准考虑使用现有外部工具；Host 读取持久化 intent，而不是 wake 行或 binding 字符串。管理员创建的 intent 仍禁止外发。该字段只改变 wake prompt，本身不授予 QQ 权限；下游 QQ Scene allowlist 与工具权限仍是最终授权。
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

当前结果：209 个确定性测试全部通过（quality-gaps 18、life-core 20、revision 9、wake-ledger 19、wake-host 37、wake-consumption 26、life-v1 15、v1-budget 9、final-hardening 8、setup-script 4、bootstrap 6、productization 12、backup 7、workspace 13、migration 4、privacy 2）。覆盖 v2→v10 的增量迁移与回滚、Workspace 可信成员/晚加入/撤权/旧 allowlist 不扩大、四种会话模式、独立预算与重启持久化、Host 消费证据与重启对账、身份隔离/撤销、idle 资格与投递、预算边界与共享 Persona/global token 预留、虚拟 Provider 生命周期与崩溃、资源互斥、用户消息优先暂停、共享只读视图、活动并发、付费预留、Session 撤销隔离、Provider 权限、重绑禁止、wakeId 幂等、外发 opt-in 的持久化工具 intent provenance 与失败关闭、首次运行 bootstrap、Config Schema/Forms/客户端注册、表单保存/取消/冲突、重复注册幂等/卸载清理、owner-auth HTTP、admin intent/activity/attention 权限、SQLite 一致快照/原子恢复/预检回滚、包清单。十场景映射记录保留在仓库内，不随安装包分发。Creator 沙箱的 `node --test` 仍有 runner `spawn EPERM` 限制；`npm test` 与直接测试文件通过。



## 已知限制（未验收部分）

- 独立真实 DSH Desktop 0.2.1-rc.3 已验证无用户输入 idle、模型调用受控本地 Provider 工具、插件停启与恢复，以及 v7→v8 开发库冷迁移。v8→v9 真实隔离开发库冷备份、迁移与恢复已通过；真实 v9 无输入唤醒、本地虚拟活动、旧工具拒绝、预算拒绝、身份重绑拒绝和首次预设启动也已通过。外部 Provider 与实际付费仍未验收。
- 事件仅本地 outbox 发布；Host wake 仅在管理员显式启用并配置 allowlist/预算时投递。Life 自身仍不发送平台消息；1.0.1 的 `externalMessageSessionIds` opt-in 只改变 wake prompt，实际调用仍受下游 QQ 工具与 Scene 授权约束，且目前只验证过一次隔离场景，不代表普遍自主性或长期可靠性。
- 未接入真实外部 Activity Provider、平台发送器、付款或发布流程；`LocalVirtualProvider` 仅用于确定性本地验证。新活动/共享工具默认关闭。
- token 仅接受官方 `assistant/message.data.usage`；缺失时显示 `usage_unknown` 并保留保守预留，不宣称真实成本结算。活动并发/付费预留接口未接真实支付 Provider；多进程真实竞争与平台验收未完成。

## 开发入口

- [单屏设置](docs/SETUP.md)：三种预设、Session 选择/allowlist、admin 绑定、健康错误与 Advanced。
- [用户指南](docs/USER_GUIDE.md)：安装、DSH 设置页、首次向导、保存/重启、备份与限制。
- [升级/回滚](docs/UPGRADE.md)、[SQLite 备份/恢复](docs/BACKUP.md)、[构建打包](docs/BUILD.md)、[发行说明](docs/RELEASE_NOTES.md)。
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

仓库内的 HANDOFF、ADR、研究记录和验收证据保留给开发/审查使用，不随安装包分发；安装包只包含运行代码、用户文档、备份/构建脚本、locale、图标和 patch。

## 发布与隐私

安装与配置见 [单屏设置](docs/SETUP.md) 与 [INSTALL](docs/INSTALL.md)。本仓库采用 [MIT 许可证](LICENSE)，v1.2 使用公开 npm Scope `@fg-lab`；GitHub Release、npm 实际发布和市场收录以发行验收报告为准。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
