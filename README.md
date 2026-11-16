# DSH Recoverable Delete

为 DeepSeek Harness 的文件误操作提供可恢复路径，兼顾使用 Purge 的 Windows 开发环境。

**当前开发版本为 0.2.6，菜单修订 3；已发布的 `v0.1.3` 标签保留原冻结基线。** 这是固定宿主版本和目录布局的 Windows 本地适配项目，不是开箱即用的跨平台插件，也不是系统级防删软件。

## 当前版本能做什么

| 操作 | 处理方式 |
| --- | --- |
| `recoverable_delete` 或可解析的精确 `rm` / `Remove-Item` | 项目 `.dsh-recovery` 内仅备份目标，校验后优先回收站，失败则同盘隔离 |
| `write` / `edit` / `apply_patch` 等已有文件修改 | 修改前保存原件；补丁删除也可从备份恢复 |
| 可精确解析的单条 PowerShell 内容/属性写入 | 仅备份目标原件 |
| 无法确定目标的修改类脚本 | 仍保留去重工作区检查点，排除恢复库及登记的可丢弃临时目录；失败不执行 |
| 账号、会话、凭据、恢复库、插件源码等受保护路径 | 拒绝相应的删除/修改，检查父目录和路径链接 |
| 人工恢复 | 从独立恢复菜单选择单条记录，校验内容后恢复；已有目标不覆盖 |
| `recoverable_restore` | 本任务限定自动恢复；冲突另存，检查点必须指定具体相对路径 |
| `recovery_create_temp` | 插件新建空的测试临时目录，其精确删除只走回收站，不保存内容副本 |
| 审计故障 | 写目标前预检；恢复已完成但最终审计失败时明确返回待补记状态 |

备份对象、原路径/原因/任务归属清单、审计与恢复事务分开存储；不自动清空回收站、隔离区或历史备份。重复内容只存一个对象；复杂脚本的工作区兜底仍可能产生首次全项目备份，不能描述成“所有 shell 都精准备份”。

自动恢复通过专用工具执行，不放开恢复 CLI 或整个恢复库的写权限。宿主会话 ID 及已登记父子关系确定任务归属，跨重启保持。原位置有内容或某级父路径已变成文件时恢复到 `.dsh-recovered` 副本目录，不自动覆盖；同一记录/选择 30 分钟内最多自动恢复 3 次（失败也计数）；重复尝试会返回 previousAttempts 和提醒。账号/应用会话、其他任务、链接、任意外部目标不开放自动恢复。直接在 agent 内运行 CLI `restore/reconcile` 仍拒绝。

详细设计、空间预算和 Python 测试兼容性见 [DESIGN-0.2.0.md](DESIGN-0.2.0.md)。

0.2.1 补充：`recovery_status.boundWorkspace` 明确报告会话绑定的工作区。shell workdir、working_directory 或子任务参数 cwd 不作为改绑授权；以宿主会话和状态返回为准。验收默认在该目录下创建全新专用样本；固定的外部测试目录需要人先在 GUI 添加工作区并新建会话。

0.2.2 修正重启后的状态来源：status/list 共用持久项目登记和任务范围查询，不依赖内存缓存，不静默回落到全局旧记录。查询不创建目录、登记任务、改 ACL 或运行项目 canary。`projectVaultState` 明确区分 ready/absent/unregistered/missing/incomplete/unavailable；每条记录带 vaultRoot，recentSource 标明 project 或 legacy-global。全新项目尚未建立库时，projectVault=null 且 recent=[] 是明确的 absent 状态。

0.2.4 收紧只读免备份条件：仅接受已知读取命令组成的字面量管道，括号、内嵌命令、变量展开、脚本块和方法调用不继承外层命令的只读身份。固定的 `(字面量读取管道).Count` 单独验证后允许；未知表达式先做检查点，明确的内嵌删除仍拒绝。带输出文件或执行 helper 选项的 Git/rg 也不免检查点。这是受监督命令的保守判定，不能代替对任意脚本逐文件拦截。

0.2.4 的恢复事务新增 phase、stagingPath、targetPublished、error/errorCode。正常捕获的发布前失败记为 failed，保留暂存数据和原备份；发布后元数据未完成记为 published-incomplete，不假称未写入。崩溃遗留 prepared 与发布中未知状态仍需人工核验。reconcile 不会把失败事务之后另行创建的同内容文件认证成该次恢复；已发布但未完成的事务需内容及属性核对通过。旧 prepared 收据保留，不自动改写历史。

0.2.5 补充：仅在 Format-Table / Format-List / Select-Object 的开头属性位置允许简单的 `Name,Length` 或 `-Property Name, Length` 列表，仍拒绝将一般逗号数组、计算属性或内嵌表达式视为只读。读取恢复库和普通项目均不会因此产生无谓检查点。未知恢复 ID 返回 RECOVERY_RECORD_NOT_FOUND；缺失、损坏或不可读元数据返回 RECOVERY_RECORD_UNAVAILABLE，不向模型输出内部控制库路径，也不伪称备份一定存在；这些前置失败不消耗恢复次数、不创建恢复事务。权限和任务范围规则不变。

检查点保存的是对应命令执行前的文件内容，不包含该时刻之后新建的文件。选择不存在的相对路径会明确解释这个时间边界。拒绝消息保留具体原因和对应工具指引，移除通用 Operation stopped 及与当前拒绝无关的原生补丁说明；简单目标不存在与复杂删除被拒绝仍有不同原因，删除与恢复也使用不同的后续指引。

0.2.6 为恢复错误的说明文字和 JSON 详情加上显式空行，即使界面直接拼接文本块也保持分段；error meta 中的结构化字段不变。

`lastCheckpoint` 是当前插件进程最近一次受监督 shell 备份步骤得到的记录 ID，可能是目标快照或工作区检查点；它不汇总原生 write/edit 等工具的全部备份，也不是历史检查点列表。启动时、或该备份目标原本不存在时可为 null，原历史仍在。判断某条命令是否新增备份，应在没有并发任务时对比前后 recovery_list 的 ID、kind、at 和 reason，结合该条工具调用结果；lastCheckpoint 不变或列表返回 50 条都不能单独证明没有新增记录。最近列表有窗口及任务范围限制，reason 也只是描述，不能单独证明执行结果。

检查点在命令执行前保存；命令报错或非零退出后仍保留。失败命令可能已经修改部分文件，不能仅凭退出码把备份标成 unused 或自动清理。需要时按记录和相对路径恢复旧字节，保留当前成果及冲突副本。

## 适配和实测环境

| 项目 | 已验证范围 |
| --- | --- |
| 系统 | Windows，本地文件系统、Windows 回收站及原生 ACL runner |
| DeepSeek Harness | `0.2.2-rc.3`，关键宿主包精确检查 |
| Purge | `dsh-purge-community 1.7.18` 共存验证；本项目不附带 Purge |
| Node.js | `24.21.0` 与 `22.23.1`，各运行完整测试套件 |
| 恢复菜单 | Windows PowerShell 5.1 与 PowerShell 7 的多记录选择和默认路径恢复 |

宿主 Node 与 shell 中 `node -v` 可以不同。状态工具会报告实际宿主 Node、版本、启动探针和已加载源码指纹。其他宿主版本不属于已验收范围；不要仅改版本检查来强行加载。

## “完全权限”和 Purge

即使界面选了“完全权限”，**被本插件监督的模型 shell 仍运行在工作区写入边界内**。这是保护的一部分，不能理解为模型可任意写全盘。

本插件不修改 Purge 源码、提示词、强化段、重试配置或权限菜单；对受监督 shell 使用独立的精确版本官方沙箱副本，不沿用 Purge 的沙箱直通。其他 Purge 功能的保留不等于没有兼容性限制：项目外缓存、持久终端、任意外部写入、改权限及复杂删除可能受到限制。

首次使用工作区时，脚本保存原 ACL，并为同一个目录所有者补足原生 runner 需要的权限。不会给 Everyone 或其他账号新增权限。只选择当前用户拥有的具体项目目录，不选择磁盘根或整个用户目录。

## 安装前先核对目录

本基线保留了验收机器的非个人目录布局，以免把发布整理变成未经验证的功能重构：

| 默认路径 | 用途/相关文件 |
| --- | --- |
| `D:/DeepSeek_dsh_win/resources/app/dsh` | 宿主模块；`lib/index.js`、vendor 生成器、集成测试 |
| `D:/DeepSeek_dsh_win/resources/runtime/primary-runtime/dependencies/node/bin/node.exe` | 恢复菜单使用的 Node |
| `D:/dsh-recovery-vault` | 旧版/重要应用备份与受保护的小型项目和任务索引；旧数据保留 |
| 项目 `.dsh-recovery` | 新项目的去重内容、清单、审计、隔离和恢复事务 |
| `D:/dsh-recovery-tests` | 专用测试样本、启动探针 |
| `D:/dsh-restoration-acceptance` | 原路径已有内容时的恢复副本目录 |
| `D:/ProjectRuntimes/python311/Scripts/python.exe` | 重要应用备份菜单项的默认 Python |
| 当前用户的 `.dsh/profiles/desktop` | 本地安装助手及 Purge 集成测试使用的 profile |

`recovery.config.json` 供 CLI 使用；`cordis.patch.yml` 供插件 bundle 使用。不是所有路径都能通过单一配置文件覆盖。回收脚本仅接受 `dsh-recovery-vault/entries` 或 `.dsh-recovery/entries` 中的明确删除事务。

安装步骤和迁移核对表见 [INSTALL.md](INSTALL.md)。先备份 profile；宿主退出后再修改安装。**不要在正在使用的 profile 中直接运行安装脚本试错。** 该助手只适用于已存在、结构匹配的 desktop profile，不会安装宿主、Purge 或其他缺失依赖。

本仓库没有在根目录声明一套可通过 `npm install` 获得的完整宿主依赖。运行时依赖来自匹配版本的 DSH 安装；vendor 文件里的绝对模块引用也需要与该安装对应。

## 日常删除与恢复

让模型用 `recoverable_delete` 并提供精确路径。`recovery_status` 应显示 `active: true`、`shellConfinement: active`、`startupProbe.passed: true`；启动失败时先排查，不关闭保护来继续删除。

在 Windows 资源管理器中双击仓库根目录的 **DSH-Recovery.cmd**，或自行创建指向它的桌面入口。不要让 DSH agent 或其集成终端代启动恢复菜单。

1. 菜单应显示“菜单修订 3”。选 `2`，按完整原路径和记录 ID 找到目标；列表汇总旧库与已登记项目。
2. 输入 `[No]` 对应数字；恢复路径直接回车使用显示的默认位置。
3. 原位置已有内容时，菜单默认选择独立恢复目录；底层拒绝覆盖。
4. 成功结果为 `status: restored`、`audit.state: complete`。
5. 出现 `restored-audit-pending` 时文件已经恢复；不要重复恢复，选 `5` 核验并补记审计。

CLI 也可由人在 DSH 外使用：

```powershell
node ./bin/recover.mjs list
node ./bin/recover.mjs doctor
node ./bin/recover.mjs restore RECORD_ID --to 'D:/recovered-copy'
node ./bin/recover.mjs reconcile
```

模型内精确 `list` / `doctor` 由插件代理应答。`recovery_list` 返回当前任务的项目记录；`recoverable_restore` 只接收 ID、原因和可选的检查点相对路径，不接收任意目标。菜单修订 3 保留 PowerShell 5.1 多记录修复并支持项目库；CLI 拒绝多个 ID。免备份测试产物需要重新生成或人工从 Windows 回收站还原。

`recovery_list` 和 status.recent 返回最近恢复的 `restoreDestination`、`audit` 和 `lastRestore`；未恢复时为 null。原 `status` 继续表示删除/备份状态，最近一次恢复尝试状态在 `lastRestore.status`，可能为 restored、restored-audit-pending、failed 或 incomplete。`targetPublished=false` 表示该次尝试没有发布最终目标，暂存副本仍可能存在；null 表示旧收据或中断事务无法确定，不能解释成“没写入”。完整收据证明那次恢复曾完成，不证明目标后来未变。`receiptIndex.state=readable/partial` 只描述收据索引可读性，绝不表示“已恢复”；旧 restoreQuery 为兼容别名。输出相对路径优先使用 `lastRestore.relativePath`，旧 relative_path 别名保留，恢复工具输入仍兼容原 relative_path 参数。

同一时点，status.recent 是 list.recent 的前 10 条，list 最多返回 50 条。0.2.3 新增 recentLimit（该入口的上限）与 recentCount（本次实际返回条数），两者均不是历史总条数；数量不同不代表记录丢失。该语义和 receiptIndex 的优先级同时写入工具说明及模型提示。拒绝消息中的 recoverable_delete 指引只出现一次。顶层 vaultRoot 仍是全局控制/旧归档库，当前记录来源看 recentSource、projectVault 和每条记录的 vaultRoot。bytes 是逻辑数据量，不表示这条记录新增多少磁盘占用。

## 测试、证据与安全边界

在已准备好上述环境的 Windows 机器运行：

```powershell
node --test test/recovery.test.mjs test/harness.test.mjs
```

套件会创建专用样本，实际执行回收站、同盘隔离、恢复、ACL 沙箱与宿主工具管线测试；完整集成测试还需要本机 Purge。不是纯 mock，也不适合直接在普通 GitHub runner 上宣称“全套通过”。测试不会自动清空历史样本或回收站。详见 [VALIDATION.md](VALIDATION.md) 和 [USER-ACCEPTANCE.md](USER-ACCEPTANCE.md)。

完整套件应由人在 DSH agent 外的独立进程运行；不要为了让模型沙箱执行宿主集成测试而放开权限。只调用 status/list 是字段核对，不等于完整恢复功能回归。

0.1.3 冻结版曾通过 Node 22/24 各 45 项测试和用户手动恢复验收。0.2.0 新增验证单独记录于 VALIDATION.md，不把旧证据当作新功能验证。原始账号快照、会话、审计、恢复记录和个人路径证据不公开。

这不是文件系统内核驱动。Windows 官方 ACL enforcement 为 `partial`；其他宿主插件绕开工具直接写文件、外部程序、鼠标操作或恶意破坏插件不能由本项目完整接管。执行前快照也不包含脚本执行期间刚创建又删除的文件。不同命令的恢复路径不同，**不是所有删除都被重定向到回收站**。

默认单次检查点上限为 100,000 个对象 / 5 GiB；项目内容对象另有默认 2 GiB 存储预算，新增副本后至少保留 64 MiB 空间。隔离原件、清单和审计不计入这项对象预算，实际目录可能更大。删除累计预算仍在受保护的全局索引中跨项目计算。预算不足会停止相应操作，不自动删旧备份；同盘副本不能覆盖磁盘损坏。

菜单的“备份重要应用数据”会读取本机 Codex、DSH、CockpitTools、Magpie 等目录，SQLite 使用备份 API。它不自动运行、没有计划任务；输出可能含账号和凭据，必须只保留在受限本地存储，不要提交或上传。恢复数据库先另存核对，再关闭对应应用后按其方式导入。

## 冻结基线与后续计划

`v0.1.3` 保留原已验收基线（菜单修订 2）。[SOURCE-BASELINE.json](SOURCE-BASELINE.json) 的哈希仅描述该历史标签，不能用来认定 0.2.0 修改后的文件仍与旧版相同。新版本在独立开发分支验证，标签不移动。

0.2.0 已实现有限自动恢复、项目本地存储和可信临时目录回收。仍未实现：

- 任意复杂脚本的逐文件写入前拦截；当前保留工作区检查点兜底。
- 用户逐目标授权的备份退役流程。

## 许可证

本项目采用 [MIT](LICENSE)。独立沙箱来自 DeepSeek 的 `@deepseek-ai/dsh-sandbox-local@0.2.2-rc.3`；保留了[官方许可证](lib/vendor/DeepSeek-LICENSE.txt)、原始源码和[来源/完整性记录](lib/vendor/provenance.json)。项目是第三方本地适配，与 DeepSeek 官方无隶属关系。
