# 0.1.0 质量缺口交接

2026-10-25，对功能提交 46064e0856fc980ddd2d3e10e5d46afa94e3862c 实查。本次 Handoff 不修改源代码，不代替下一轮失败回归/修复。29/29 旧测试通过不能证明以下边界正确。先前 REPORT/交付卡是历史验证结果，可信证据与生命周期完整性结论须受本页修正。

| 项目 | 当前源码与实际复现 | 影响与接手验收 |
| --- | --- | --- |
| 伪造完成 | core.js:520—533 只对 unknown→completed 要求 trustedEvidence；running→completed 仅非空引用。临时 core 的 trustedEvidence:false + invented 引用成功 completed。index.js:492 工具固定 false，仍挡不住该路径；模型工具端到端回归待补 | 不代表已有外部执行成功，却允许把自述记作完成。先写运行态模型 execute 失败回归，要求拒绝且 revision/status/evidence 不变；可信 host Provider 路径应有正例。不要让模型填写可信字段。此轮不实现外部活动系统。 |
| 关联完整性 | createIntent core.js:193、updateIntent:301、recordActivity:413 仅校验字符串；实测跨 scope 两向关联与不存在 intentId 被接受 | 不会因此直接获得读写受害意图权限；transitionActivity:534 却查询关联意图取消状态，存在跨 scope 状态耦合。先测 foreign/missing/cancelled 关联、create/update/record 失败原子性、同 scope 正例；不得夸大成已证实跨 scope 直接改写。实际状态影响还须回归复现。 |
| 公开 close 遗留 lease | index.js:294 close 仅 core.close，完整 dispose:300 才 release。实测 close→原 dispose→同进程 apply 返回 degraded/runtime_lease_held | 补公开 close 的幂等完整清理与 timer/handle/lease 释放回归，验证同进程重新启用；之后在真实隔离 DSH 检查启停，不能仅用假 Context。 |
| 日期与 ADR | model.js:128 Date.parse 接受 2026-02-30 并输出 03-02；ADR 0001 写 schema=1，model.js 常量=2 | 补非法日/月/闰年/24:00 等失败与合法闰年正例，拒绝静默滚动；同步 ADR 为实际 schema 2，并更新其过时“未验证真实加载”说明，不凭文档触发不必要迁移。 |

复现仅使用全新合成 SQLite 数据库，不接触运行中的 Life 或生产系统。脚本/结果保留主项目 private/handoff/repro-current.mjs、defect-reproduction.json；不可整目录上传。关联影响与工具完成路径尚需正式失败测试，不能把 core 复现等同已完成全部工具端验收。

后续必须使用原 cordis Creator 会话完成主要实现：先提交/保存覆盖漏洞的失败测试结果，再修复；Codex 独立复跑全套测试、审查 diff，真实开发 DSH load/disable/enable/uninstall/reinstall 与 close 恢复检查；更新现有 Life PR #2 与主项目 PR #2。禁止改生产或提前实现 QQ/外部活动系统。质量完成后单独规划 0.2.0 的可信唤醒、Provider、统一身份与预算，再持续推进 Life v1.0。
