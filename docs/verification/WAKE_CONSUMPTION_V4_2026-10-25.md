# Life SQLite v4 wake 消费证据验收

日期：2026-10-25（Asia/Shanghai）。范围为持久消费/turn-end 证据和 v3→v4 迁移；Host adapter 尚未调用新接口。详见 ADR 0004。

原 cordis Creator 在同一会话实现可信 `recordWakeConsumed`、`recordWakeTurnEnd` 与只读 `getWakeConsumption`，保存 Session/message/turn/event seq、消费时有效性和完成原因；原 9 模型工具不变。确定性测试包括消费后同 turn 取消仍可留完成证据、消费前取消不可执行、无消费不得结束、错误/冲突坐标拒绝、非 completed 不执行、v2/v3 迁移保留/回滚/重开。Codex 独立执行 `node --test test/wake-consumption.test.js test/wake-host.test.js test/wake-ledger.test.js test/quality-gaps.test.js test/life-core.test.js test/revision.test.js`：100 pass / 0 fail / exit 0。`npm test` 六组分别 18、20、9、19、19、15 pass / 0 fail / exit 0，`git diff --check` 通过。

真实隔离 DSH Desktop 验收：确认原 Creator 空闲，核对进程归属后停止独立实例；冷备份原 `life.sqlite`/WAL/SHM 并逐文件校验哈希。备份 schema 3、integrity ok。重启同一实例后真实库 schema 4、integrity ok，原 10 intents、5 intent_events、8 activities、1 wake_requests、1 runtime_lease 保留；意图/事件/活动不可变字段及 wake 全行逐行摘要与备份一致，新 `wake_consumption` 为 0 行。原 Creator Session 可读、Life bundle active、私有 Host 探针未加载，生产未动。备份与比较脚本仅留本机忽略目录。

限制：Host adapter 仍使用 v3 的 `markWakeExecuted` 路径，新 v4 证据 API 还未接真实 `session/event`，所以本关卡不声称解决上轮实际合成 turn 取消后的记录缺口。若重启后才看到旧 Session 事件而无法证明消费瞬间意图状态，只能保守保存消费/完成事实，不得猜测 `validAtConsumption=true`。下一段实现实时记录和崩溃对账。包仍为 0.1.0，未发布或部署。
