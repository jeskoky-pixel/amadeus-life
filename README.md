# amadeus-life

管理跨场景注意力、可调整的未来意图、活动调度、可选心跳与统一预算协调。

**当前状态：M0 QQ ↔ Life 最小接口草案。无运行时实现、安装包或正式发布，尚未完成平台联调。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P0。当前仓库为私有。

## 职责与边界

通过 QQ 的事件、排队和唤醒接口协作，不独立争抢 QQ 收发；到期重新考虑，不盲发旧台词。不依赖 State 或向量记忆运行。

基于官方 DSH 运行，不另建主 Agent 推理循环。人格统一由项目基础能力定义。需要受保护动作时不可绕过可信身份、数据范围与外发权限；可选模块未安装或故障时仅降级受影响能力。

## 模块约定

独立安装、升级、卸载，独立版本、测试和发布。后续必须声明能力、必要/可选依赖、契约兼容版本、健康状态与故障降级。目前这些契约仍待核实和确定，不声称已有可用接口。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [M0 模块边界](docs/M0.md)
- [QQ ↔ Life 契约草案](docs/contracts/qq-life-v0.1.md)
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

需求与验收关注：R-06、R-08、R-09、R-12、R-15、R-17；重点验收 A-06、A-11、A-14—A-16。

下一步：在 M0 与基础契约核实后，确定意图账本、事件接口、revision、取消与预算语义；优先用模拟时钟验证。

## 发布与隐私

尚无可用安装命令。许可证尚待明确，不因主仓库选择 MIT 而自动继承授权。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
