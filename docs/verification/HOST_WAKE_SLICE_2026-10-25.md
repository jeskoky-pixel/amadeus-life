# Life 可信 Host wake 首段验收

日期：2026-10-25（Asia/Shanghai）。源码范围见 ADR 0003。测试只使用隔离 DSH Desktop 0.2.1-rc.3 与长期合成 Session；无真实平台动作。

## 代码关卡

Codex 在原 Creator 首稿上先补 3 项失败回归：跨 Session 的 admission 前伪证可误标 executed、前 500 条旧记录遮蔽未对账 wake、缺失 `ctx.on` 导致整个 Life 关闭。修复后又在真实隔离宿主发现普通 `ctx.get` 取不到 Session Controller，补可选 Cordis 注入失败回归；随后补服务撤销与异步 resolve/flush 竞态回归。均由原 cordis Creator 在同一会话返工。

最终独立运行 `node --test test/wake-host.test.js test/wake-ledger.test.js test/quality-gaps.test.js test/life-core.test.js test/revision.test.js`：85 pass / 0 fail / exit 0。`npm test` 五组分别 18、20、9、19、19 pass / 0 fail / exit 0。`git diff --check` 通过。失败 TAP 和复验 TAP 仅在主项目忽略目录，不公开原始会话内容。

## 真实隔离 DSH

1. 原 Creator 空闲时停止经 exe、userData、子进程路径核对的独立 Desktop；冷备份 profile patch 与 `life.sqlite`/WAL/SHM，校验哈希。临时 profile 只把 Host delivery 允许给一个既有合成 Session，间隔 10 分钟；私有探针只负责创建本地合成意图并触发受信任 service，未进入仓库包。
2. 首次真实 drive 返回 `unavailable`，原因 `sessionController.resolveAgent` 不可见，未投递。修正为 `ctx.inject(['sessionController','sessions'], ...)` 并重启后，空 ledger drive 返回 `ok` 且无投递。
3. 创建一条 2000 年到期的合成意图，真实 drive 返回一条 `admitted`，包含持久 wake ID 与消息 ID。Session 持久事件中，同一 ID 被 next-turn 队列接受，在第 2 个 turn 以 `source.kind='amadeus-life'` 消费，`turn/end.reason.kind='completed'`。该 turn 的工具调用仅有 `life_health`、`life_intent_list`、`life_intent_cancel`；模型选择取消合成意图，未调用外部平台工具。
4. 取消把意图修订为 2；`markWakeExecuted` 的旧 revision 守卫使 admitted wake 持久变为 `superseded`，`executed_turn_seq` 留空。这是保守记录，未伪称旧意图继续有效。它也暴露一个真实设计缺口：已消费并完成的唤醒与在该 turn 内失效的意图应分别留证，下一段需修正。
5. 重复 drive 与隔离 Desktop 重启后再次 drive 都返回零投递，wake attempts 仍为 1。最后按冷备份逐字节恢复原 profile patch，私有探针不再加载；Life bundle active，原 Creator Session 可读，SQLite schema 3 / integrity ok，原数据与本次合成记录均保留。

## 现存限制

只有管理员显式配置 allowlist 的到期意图可自动唤醒；默认关闭，尚无 idle 机会、统一 Persona、可信 Provider、完整注意力与预算。真实 Session 消费后若模型取消/改期，当前 wake 为 `superseded` 而非同时记录消费事实；崩溃窗口中的 admitted/uncertain 仍需证据对账。忙碌 Session 的 followup 语义由官方 API 和 fake Host 覆盖，尚未在真实忙碌 turn 下单独黑盒测试。未发布、部署或合并。
