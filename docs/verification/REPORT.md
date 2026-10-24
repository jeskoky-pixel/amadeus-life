# T-010 Life 核心验收

> 2026-10-25 补充：四项后发现的质量缺口已修复并独立验收，现行全套为 47/47。详见 [质量修复验收](QUALITY_FIX_2026-10-25.md) 与 [缺口历史](QUALITY_GAPS.md)。以下 29 项、五轮 Creator 和初次安装记录保留为原阶段证据，不代表最终测试总数。

> 2026-10-25 交接复查发现四项尚未修复的质量缺口，见 [QUALITY_GAPS.md](QUALITY_GAPS.md)。下列 29 项测试和宿主集成是既有范围的事实，不能证明可信完成、关联或公开 close 边界完整。

日期：2026-10-25（Asia/Shanghai）。结论：本轮最小 Life 核心通过审查、29 项自动化测试及隔离真实 DSH 集成验证。尚未实现自动唤醒适配器或任何真实平台外发。

## 开发环境与执行方式

- 官方 DSH Desktop / CLI：0.2.1-rc.3；独立 DSH_HOME、Electron userData 和 Life Git 克隆，不是生产工作空间，也不是 headless 开发。
- Workspace：Amadeus Life Development；精确路径见 creator-and-runtime.json。
- 会话：session-fa594d5f-9c84-4e51-aca1-f8ba8a3ee621；5 轮均以持久 turn/end completed 结束，同一会话完成启动、实现、两次返工和真实工具检查。
- 真实 preset：cordis。依据为 session/create 返回及 session/projections，而非 worker 自述。
- 实际 Provider / Route：deepseek-official / deepseek-flash，High。官方模型目录为 DeepSeek-V4.1-Flash，与安装版官方 1017 标签匹配规则一致；目录不暴露不可变后端 build ID，不伪造额外版本证明。
- 权限：Workspace Write / approval never。没有改为 Full Access。安装由监督方调用已认证的正式 Plugin Manager API 完成，不要求开发 Agent 提升权限。
- 用户要求停止 Computer Use 后，后续操作全部通过后台正式接口和命令完成。

## 已实现

意图 CRUD / revision CAS、活动状态机、注入时钟与有界 tick、每意图版本唯一的持久 outbox、SQLite WAL 与事务、重启对账、单运行时 lease、作用域隔离、明确存储错误、Cordis 生命周期和 9 个模型工具。无 QQ / Memory / State / Browser 等插件也能运行。

到期只产生本地、只含引用的 reconsideration 事件；不写固定台词、不调用模型、不发送消息。外部动作默认拒绝；真实 provider 停止/完成确认不得由模型参数自行声明。意图变化使旧 pending 事件失效，未完成活动重启后为 unknown。

## 审查与返工

1. 首稿独立测试 20/20 通过，但审查未接受：未知活动取消、重复运行时恢复、事件内容与健康信息隔离、真实并发及启动失败清理存在缺口。
2. 原会话修订后 28/28。随后 Codex 直接复现模型额外 scope 参数覆盖可信会话范围并写入他人意图的漏洞。JSON Schema 提示不等于执行时鉴权，故再次拒绝。
3. 原会话补上执行边界的参数白名单、保留字段拒绝和显式可修改字段复制，复现被 LIFE_VALIDATION 拒绝，受害意图内容/revision 不变。最终 29/29 通过。

Codex 未替换主要实现；仅补充包的 Node 最低版本、忽略规则、验收/安装文档，以及私有集成探针。所有主要实现与针对性修复由同一个 DSH Creator 执行。

## 实际测试

```text
node --test test/life-core.test.js test/revision.test.js
npm test
```

独立 Node 22.23.2：最终 29 passed，0 failed，exit 0；覆盖 T01—T14 和必要的权限、转换、lease、资源清理回归。T07 除两连接测试外，使用 barrier 同步的双 worker_threads 实际并发竞争同一 SQLite 库，总计只有一个有效事件。线程是测试执行器，不是模型子 Agent。

Creator 的 Windows 文件沙箱会拒绝 node --test runner 的子进程 spawn；worker 实际使用 node test/life-core.test.js / node test/revision.test.js 运行同样 node:test 套件。监督方另在普通进程独立执行标准 runner，未因沙箱限制跳过测试或提升开发权限。

## 真实 DSH 加载与恢复

通过正式 pluginManager.installBundle(本地目录, {enabled:true}) 安装，pnpm exit 0，application=applied，Life fiber active。通过真实 Cordis ctx.life 与真实工具注册表验证，未使用假 Context 代替集成：

- 创建/修改意图、scope 拒绝、到期事件、去重、默认拒绝外部动作、虚拟活动失败状态均通过。
- 禁用 bundle 后 ctx.life 不存在，9 个工具全部撤销；重新启用后意图仍在，遗留运行活动为 unknown。
- 核对独立 Desktop 的 PID / userData 后仅强制终止该开发进程树并重启；数据库、Workspace 和原 Creator 会话仍可恢复，旧活动未被标成完成，未自动重放外部操作。
- 实际移除 bundle 后服务与工具消失；重新安装 application=applied，持久状态仍在。
- 原 Creator 会话真实调用 life_health → life_intent_create → life_intent_update → life_intent_cancel → life_intent_get，5 次均无错误，最终 revision=3、status=cancelled。
- 临时私有诊断插件已撤下，探针 dispose 已确认；Life 保留安装在独立开发环境中。该探针不进入本发布包。

最初管理器提示开发配置中的权限默认组合不匹配；仅在独立配置中显式声明 Workspace Write / never 的默认 preset 后消除。后续禁用、启用、卸载、重装均返回 warnings=[]。生产 DSH 配置未改。

## 可观察预算与证据

creator-and-runtime.json 记录实际会话 tokenUsage、模型步骤、持续时间、工具结果、修改范围和各集成阶段。初始实现 40 步、首次修订 21 步、权限修订 6 步；包括两次启动/工具检查共 82 步，无模型子代理。

记录的是供应商返回的 token 用量，不把缓存输入当免费，也不以猜测价格声称实际扣费；货币金额未读取账单核实。Life 空 tick 不发起推理请求。

测试使用合成数据。凭据、连接 Cookie、原始推理/会话日志、生产文件与个人记忆不进入仓库。源码哈希见 source-manifest.json；最终 commit SHA 位于 PR 和交付消息，不在提交内部写自己的 SHA。

## 限制与下一步

- 当前是本地 Life 核心。自动且获授权地唤醒 DSH 会话、外部 provider 和运行预算适配尚未实现；Schedule / Jobs 的调研与取舍见 ADR 0001。
- Host 插件是受信任的进程内代码；没有给模型增加任意宿主读取/网络权限，不宣称已经通过通用宿主隐私的对抗隔离验收。
- 测试了并发线程与真实进程重启，未做多机器/多进程压力、全部崩溃点故障矩阵或真实 QQ 等平台联调。
- 插件许可证仍待项目拥有者决定，package private=true 仅防止意外 npm 发布，GitHub 仓库本身公开。没有自动发布软件包或部署生产。
