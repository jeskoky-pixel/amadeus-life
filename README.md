# amadeus-life

管理跨场景注意力、可调整的未来意图、活动调度、可选心跳与统一预算协调。

**当前状态：0.1.0 开发版 Life 核心已通过审查、29 项自动化测试和隔离真实 DSH Desktop 的安装、启停、卸载重装与进程重启恢复验证。尚未发布 release，未连接任何真实平台。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。仓库已于 2026-10-25 根据用户要求公开，便于网页端审阅。

## 职责与边界

未来通过 QQ 的事件、排队和唤醒接口协作；本版只产生本地重新考虑事件，不独立争抢 QQ 收发，也不盲发旧台词。不依赖 State 或向量记忆运行。

基于官方 DSH 运行，不另建主 Agent 推理循环。本版本只管理“什么时候值得重新思考”：不发送消息、不调用模型、不自动执行外部动作、不读取私聊历史。需要受保护动作时必须有可信授权适配器；未配置时一律拒绝。

## 已实现能力

- **意图**：创建/读取/列表/更新/取消；`id`、`revision`、`createdAt`、`updatedAt`、`reviewAt`、`status`、`description`、`contextScope`、`authorizationRef`、可选 `relatedActivityId`。
- **活动**：`pending`、`running`、`paused`、`stopping`、`completed`、`failed`、`cancelled`、`unknown`，带明确转换表与 revision CAS。
- **到期复查**：注入时钟 + 有界 tick，每个意图 revision 原子产生一个本地 reconsideration 事件；重复 tick、重启与多连接不会重复领取。
- **持久化**：`node:sqlite` + WAL + `BEGIN IMMEDIATE` + 唯一约束 + revision CAS；schema v2；损坏或未知 schema 明确报错，绝不替换为空库。
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

`tickIntervalMs` 的定时器会 `unref()`，dispose 时清除并关闭数据库。

## 服务与工具

- Host 服务 `ctx.life`：`createIntent`、`getIntent`、`listIntents`、`updateIntent`、`cancelIntent`、`recordActivity`、`getActivity`、`listActivities`、`transitionActivity`、`requestCancelActivity`、`tickNow`、`listOutbox`、`acknowledgeEvent`、`requestExternalAction`、`getHealth`、`close`。
- 模型工具 9 个：`life_intent_create`、`life_intent_get`、`life_intent_list`、`life_intent_update`、`life_intent_cancel`、`life_activity_record`、`life_activity_get`、`life_activity_transition`、`life_health`。工具的作用域与授权来源由工具执行上下文中的会话 ID 推导，**不接受模型传入的 scope/authorization**。
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
node test/life-core.test.js
node test/revision.test.js
```

当前结果：29 个测试全部通过（基础 20 个：T01–T14 + 转换表、作用域隔离、有界批量、适配器/dispose、启动降级、重启恢复；修订 9 个：未知/暂停取消与可信证据、模型工具不可自证取消、恶意参数越权、双适配器 lease、陈旧 PID 接管、setup 失败清理、隐私与 scope、worker 线程并发），使用固定时钟、虚拟活动与独立存储连接，无真实 sleep。

说明：`node --test` 在本 Desktop 的 Windows 文件沙箱下会因 runner 子进程 `spawn EPERM` 失败；直接执行测试文件会在同一进程内运行 `node:test` 套件，测试内容不变。worker 线程并发测试在本沙箱内可运行；若外部环境拒绝线程，应如实报告为未运行。

## 已知限制（未验收部分）

- 已在独立真实 DSH Desktop 0.2.1-rc.3 加载、禁用/启用、卸载/重装及进程重启验证；其他 DSH 版本未验证。
- 事件仅本地 outbox 发布，不会自动唤醒 DSH 会话或外发。
- 未接入 Schedule / Jobs（原因见 `docs/adr/0001-life-runtime.md`）；未实现跨进程压力测试、预算或真实平台适配器。
- 未验证 QQ / NapCat / 设备 / 发布流程；当前无 release 与契约兼容版本承诺。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [运行时 ADR](docs/adr/0001-life-runtime.md)：API 调研、存储/定时/事件/降级决策。
- [M0 模块边界](docs/M0.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

## 发布与隐私

安装与配置见 [docs/INSTALL.md](docs/INSTALL.md)，完整验收见 [docs/verification/REPORT.md](docs/verification/REPORT.md)。许可证尚待明确。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
