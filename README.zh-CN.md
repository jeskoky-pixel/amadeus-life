# Amadeus Life

<img src="assets/market-icon.png" width="80" alt="Amadeus life logo">

[English](README.md) · [详细配置参考](REFERENCE.md)

工作区级自主活动、意图与唤醒预算。

目标发行包：**`@fg-lab/amadeus-life@1.2.1`**。已验证的官方 DSH Desktop 基线：**0.2.1-rc.3**。许可证：MIT。

## 当前发行状态

已发布 **1.2.1**：[GitHub Release](https://github.com/jeskoky-pixel/amadeus-life/releases/tag/v1.2.1) · [npm](https://www.npmjs.com/package/@fg-lab/amadeus-life)。请安装固定版本；发行包校验值见 Release。后续源码修改不代表该版本安装包发生变化。

## 能帮你做什么

- 在绑定的工作区中保存意图与活动记录，追踪计划和已完成的事情。
- 设置受预算、限流和执行边界约束的唤醒规则，在启用投递前检查活动历史。
- 识别可信普通会话和 QQ 会话，包括支持的旧 Session ID；不接管 QQ 即时连续聊天。
- 在专属 DSH 原生设置面板中管理规则、查看状态与历史。

示例：记录待跟进意图，为已授权工作区设置有预算上限的唤醒规则，再检查活动页中的投递结果与预算消耗。

Life 是调度插件，不是独立大模型。外部操作仍需对应工具和授权；与其他四插件的可选联动不会额外授予权限。规则和目标确认前应保持唤醒投递关闭。

## 安装与首次配置

使用官方 DSH 插件管理器将预构建 `.tgz` 安装到所需 Profile，无需手工构建源码。按[安装说明](docs/INSTALL_V1_2.md)操作，不要手工改写正在运行的 Profile。

在 DSH 原生设置中绑定工作区、配置规则与预算，再显式启用唤醒投递。

其他 Amadeus 插件均为可选联动，按需要分别安装。

## 界面

![Amadeus Life 界面](assets/screenshots/overview.png)

截图展示已有界面，不表示本轮所有真实平台能力均已通过。具体限制请阅读配置参考和验收报告。

## 升级与回滚

升级前备份用户数据。程序、持久数据和恢复备份分开保存。禁用停止功能；卸载默认保留外部数据。回退旧程序不能自动撤销数据库迁移。

- [升级政策](docs/UPGRADE_POLICY.md)
- [数据迁移与恢复](docs/DATA_MIGRATION.md)
- [发行检查清单](docs/RELEASE_CHECKLIST.md)
- [完整配置与限制](REFERENCE.md)

[项目主页](https://github.com/jeskoky-pixel/Amadeus-dsh) · [MIT 许可证](LICENSE)
