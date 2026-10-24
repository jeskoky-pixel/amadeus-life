# Life SQLite v3 wake ledger 验收

日期：2026-10-25（Asia/Shanghai）。范围是 `intent_due` wake 的持久状态和 v2→v3 迁移；没有自动模型唤醒。

## 回归与修复

Codex 在 Creator 首稿上新增 C8/B5/C9，`node --test test/wake-ledger.test.js` 稳定为 14 pass / 3 fail / exit 1。问题分别是事务内抛错回滚 superseded、宽松 GLOB 的无效候选占满 LIMIT、已 acknowledged 的事件还能 claim。原 cordis Creator 在同一会话返工，并补 C10 验证本地确认与 admission 的竞争。Codex 独立审查改动后执行：

- `node --test test/wake-ledger.test.js test/quality-gaps.test.js test/life-core.test.js test/revision.test.js`：66 pass / 0 fail / exit 0。
- `npm test`：四个文件分别 18、20、9、19 pass，全部 exit 0。
- `git diff --check`：exit 0。

失败基线和复验 TAP 只保存在主项目忽略的 `private/handoff/`，不上传模型日志、数据库或认证。

## 真实隔离 DSH 迁移

原 Creator Session 空闲后，停止经进程路径与 `userData` 双重核对的独立 Desktop。冷备份原 `life.sqlite`、WAL、SHM 到本机忽略目录，逐文件哈希一致。备份中 `schema_version=2`、`integrity_check=ok`，有 9 intents、4 intent_events、8 activities、1 runtime lease。

启动同一隔离 Desktop 并恢复连接后，原 Creator Session 仍为 cordis / deepseek-official / deepseek-flash / High，队列空且可读；Life bundle active。原数据库为 `schema_version=3`、`integrity_check=ok`，9 intents、4 intent_events、8 activities、1 runtime lease、0 wake_requests。意图、事件、活动的不可变业务字段与冷备份逐行摘要一致。冷备份及比较脚本留在被忽略的本机目录。

## 剩余边界

此关卡不证明真实 DSH Session 投递、turn 完成、崩溃窗口对账、预算、idle wake 或跨场景身份。`markWakeExecuted` 目前是供未来可信 Host adapter 调用的记录入口，真实 Session 证据由下一纵切验证。SQLite `node:sqlite` 在当前 Node 22.23.2 仍为实验 API；生产不部署。
