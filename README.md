# DSH Recoverable Delete

为 DeepSeek Harness 的文件误操作提供可恢复路径，兼顾使用 Purge 的 Windows 开发环境。

**这是已在一台 Windows 机器验收的 0.1.3 源码基线，包含“菜单修订 2”。它仍是固定版本、固定目录布局的本地适配项目，不是开箱即用的跨平台插件，也不是系统级防删软件。**

## 当前版本能做什么

| 操作 | 处理方式 |
| --- | --- |
| `recoverable_delete` 或可解析的精确 `rm` / `Remove-Item` | 校验独立备份后优先送 Windows 回收站；回收站失败则使用同盘隔离区 |
| `write` / `edit` / `apply_patch` 等已有文件修改 | 修改前保存原件；补丁删除也可从备份恢复 |
| 其他需要执行的修改类 shell 命令 | 执行前保存工作区检查点，内容按哈希去重；检查点失败则不执行 |
| 账号、会话、凭据、恢复库、插件源码等受保护路径 | 拒绝相应的删除/修改，检查父目录和路径链接 |
| 人工恢复 | 从独立恢复菜单选择单条记录，校验内容后恢复；已有目标不覆盖 |
| 审计故障 | 写目标前预检；恢复已完成但最终审计失败时明确返回待补记状态 |

备份对象、路径对应清单、操作审计和恢复事务分开存储；不自动清空回收站、隔离区或历史备份。重复内容只存一个对象，但工作区检查点仍可能扫描完整项目。

**当前不允许模型自行恢复。** `restore` / `reconcile` 等修改型恢复命令在 DSH agent 环境中会提前拒绝。恢复由人在 DSH 外启动菜单完成。

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
| `D:/dsh-recovery-vault` | 恢复库；bundle、CLI 配置及辅助脚本 |
| `D:/dsh-recovery-tests` | 专用测试样本、启动探针 |
| `D:/dsh-restoration-acceptance` | 原路径已有内容时的恢复副本目录 |
| `D:/ProjectRuntimes/python311/Scripts/python.exe` | 重要应用备份菜单项的默认 Python |
| 当前用户的 `.dsh/profiles/desktop` | 本地安装助手及 Purge 集成测试使用的 profile |

`recovery.config.json` 供 CLI 使用；`cordis.patch.yml` 供插件 bundle 使用。不是所有路径都能通过单一配置文件覆盖。特别是 `scripts/recycle.ps1` 要求恢复库路径包含 `dsh-recovery-vault/entries`，不要随意改名后假设回收站路径仍工作。

安装步骤和迁移核对表见 [INSTALL.md](INSTALL.md)。先备份 profile；宿主退出后再修改安装。**不要在正在使用的 profile 中直接运行安装脚本试错。** 该助手只适用于已存在、结构匹配的 desktop profile，不会安装宿主、Purge 或其他缺失依赖。

本仓库没有在根目录声明一套可通过 `npm install` 获得的完整宿主依赖。运行时依赖来自匹配版本的 DSH 安装；vendor 文件里的绝对模块引用也需要与该安装对应。

## 日常删除与恢复

让模型用 `recoverable_delete` 并提供精确路径。`recovery_status` 应显示 `active: true`、`shellConfinement: active`、`startupProbe.passed: true`；启动失败时先排查，不关闭保护来继续删除。

在 Windows 资源管理器中双击仓库根目录的 **DSH-Recovery.cmd**，或自行创建指向它的桌面入口。不要让 DSH agent 或其集成终端代启动恢复菜单。

1. 选 `2`，按每条记录的完整原路径和记录 ID 找到目标。
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

模型内的精确 `list` / `doctor` 命令由插件只读代理应答，不能据此推断模型获得了 CLI 恢复权限。菜单修订 2 修复了 PowerShell 5.1 合并 JSON 数组的问题，并显示每条独立记录；CLI 拒绝一次传入多个记录 ID。

## 测试、证据与安全边界

在已准备好上述环境的 Windows 机器运行：

```powershell
node --test test/recovery.test.mjs test/harness.test.mjs
```

套件会创建专用样本，实际执行回收站、同盘隔离、恢复、ACL 沙箱与宿主工具管线测试；完整集成测试还需要本机 Purge。不是纯 mock，也不适合直接在普通 GitHub runner 上宣称“全套通过”。测试不会自动清空历史样本或回收站。详见 [VALIDATION.md](VALIDATION.md) 和 [USER-ACCEPTANCE.md](USER-ACCEPTANCE.md)。

本地原版已通过 Node 22/24 各 45 项测试，以及用户桌面菜单的文件/目录手动恢复和哈希、审计核对。发布副本另行验证，结果单独记录；原始账号快照、会话、审计、恢复记录和机器路径证据不公开。

这不是文件系统内核驱动。Windows 官方 ACL enforcement 为 `partial`；其他宿主插件绕开工具直接写文件、外部程序、鼠标操作或恶意破坏插件不能由本项目完整接管。执行前快照也不包含脚本执行期间刚创建又删除的文件。不同命令的恢复路径不同，**不是所有删除都被重定向到回收站**。

默认单次检查点上限为 100,000 个对象 / 5 GiB；删除另有会话和 profile 累计预算。备份失败、变化中源文件、损坏对象、危险路径等场景会停止相应操作，不能降级为永久删除。同一磁盘上的恢复副本不等于独立介质备份。

菜单的“备份重要应用数据”会读取本机 Codex、DSH、CockpitTools、Magpie 等目录，SQLite 使用备份 API。它不自动运行、没有计划任务；输出可能含账号和凭据，必须只保留在受限本地存储，不要提交或上传。恢复数据库先另存核对，再关闭对应应用后按其方式导入。

## 冻结基线与后续计划

`v0.1.3` 记录当前已验收版本（菜单修订 2）。运行核心、严格恢复 CLI、恢复菜单及第三方沙箱与已安装基线逐字节比对；[SOURCE-BASELINE.json](SOURCE-BASELINE.json) 提供哈希和发布整理差异。

以下仅为后续讨论，**本版本尚未实现**：

- 本任务限定的 agent 自主恢复与冲突处理。
- 项目内恢复目录和精准增量备份，减少修改类 shell 的完整工作区检查点。
- 可信专用测试产物免备份、直接走回收站。
- 用户逐目标授权的备份退役流程。

## 许可证

本项目采用 [MIT](LICENSE)。独立沙箱来自 DeepSeek 的 `@deepseek-ai/dsh-sandbox-local@0.2.2-rc.3`；保留了[官方许可证](lib/vendor/DeepSeek-LICENSE.txt)、原始源码和[来源/完整性记录](lib/vendor/provenance.json)。项目是第三方本地适配，与 DeepSeek 官方无隶属关系。
