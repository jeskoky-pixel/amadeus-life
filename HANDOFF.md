# amadeus-life 交接

日期：2026-10-25。状态：0.1.0 开发版核心已验收；尚未发布 release、npm 包或部署生产。

## 当前能做什么

SQLite schema v2 保存意图与活动；支持 revision CAS、改期/取消、有界时钟 tick、持久复查 outbox、scope 隔离、可信证据边界、单运行时 lease、明确存储错误与生命周期清理。

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

1. 接入经过授权的 DSH 唤醒/事件消费适配器；不要把本地 outbox 当成已完成自动生活或外发。
2. 未来 provider 在执行前重新检查 scope、revision 与最新授权；模型不得自行提供可信证据或授权字段。
3. 更多故障点、多进程/多机器压力与真实平台能力另行验证。本轮只验证合成数据和独立开发环境。
4. 插件许可证仍待拥有者明确，不自动继承主仓库 MIT；private=true 是 npm 防误发设置，GitHub 仓库保持公开。

生产环境保护和仅开发 Life 的边界继续有效。
