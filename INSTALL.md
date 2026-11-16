# 安装与回退（0.2.5）

这是 Windows 上针对 DSH 0.2.2-rc.3 的本地适配源码；路径和依赖需要先审阅，不提供一键跨环境安装承诺。完整安装会修改当前用户的 desktop profile，必须先正常退出 DSH 并备份该 profile。不要以覆盖整份旧 profile 的方式回退后续插件。

## 前提

- 匹配版本的 DSH 桌面端，以及其 `resources/app/dsh/node_modules/@deepseek-ai` 宿主模块和原生 runner。
- Node 24.21.0（宿主验证版本）或 22.23.1（完整测试过的外部 CLI）；Windows PowerShell 5.1。
- 准备独立恢复库，确认路径权限和磁盘余量。菜单“备份重要应用数据”额外需要 Python 标准库环境。
- 想复现 Purge 共存测试时，安装匹配的 Purge 1.7.18；本仓库不下载或安装 Purge。

## 路径与依赖

1. 阅读 README 中的默认路径表，核对 `lib/index.js`、bundle、CLI 配置、恢复菜单、测试和 vendor 模块路径。它们不是全部由同一个配置项控制。
2. `recovery.config.json` 与 `cordis.patch.yml` 的恢复库设置保持一致。projectRecovery=true 时普通内容放在项目 .dsh-recovery，旧全局库保留数据并保存小型索引；回收脚本同时校验这两类明确事务路径。
3. `lib/vendor/sandbox-local.js` 中是原验收机器生成的绝对宿主模块引用。如果宿主路径不同，审阅 `scripts/prepare-vendor.mjs` 的 `host` 后生成副本；不要让生成器写入官方宿主文件。
4. 已附官方原始源码、许可证和完整性记录。仅在需要重新获取时审阅运行 `scripts/prepare-vendor.py`，其从 npm 精确版本下载并检查包完整性，不执行包脚本；核对来源后再生成模块副本。
5. `scripts/recovery-menu.ps1` 的中文源码使用 UTF-8 BOM，保持该编码以支持 Windows PowerShell 5.1。

更改路径或宿主版本后的安装，不属于冻结基线的原环境验证结果；应重新运行完整 Windows 测试和启动探针。

## 挂载 desktop profile

`scripts/install-local.mjs` 是一个需人工审阅的适配助手。它定位当前用户的 `.dsh/profiles/desktop`，读取现有 YAML 依赖，先备份 profile 的 package、lock 和 patch，再添加本地 `link:` 依赖及 bundle，通过 junction 挂载源码。已存在其他安装时拒绝直接覆盖；保留现有依赖和 profile patch。

确认目标 profile 和路径匹配、DSH 已退出，再用 Node 执行：

```powershell
node ./scripts/install-local.mjs
```

它不下载宿主依赖、不安装 Purge、不创建桌面快捷入口，也不负责跨版本迁移。输出的 `installation.json` 和 profile 备份只保留在本地。

启动 DSH 后调用 `recovery_status`，至少核实：

- `version: 0.2.5`、`active: true`、`startupError: null`。
- `shellConfinement: active`、`startupProbe.passed: true`。
- `hostVersion: 0.2.2-rc.3`、实际宿主 Node 及源码指纹。
- `projectRecovery: true`、`automaticRestore: true`；有效登记的项目库即使重启后尚未修改也可查询，projectVault 指向该工作区 .dsh-recovery，projectVaultState=ready。全新项目为 absent，不静默展示全局旧记录。
- `boundWorkspace` 为本会话实际绑定的工作区；改 shell/tools cwd 不代表改绑，换项目需从 GUI 选择工作区并新建会话。
- `recentSource=project`，记录各带 vaultRoot；status/list 来自同一持久项目来源。仅显式关闭 projectRecovery 的兼容模式显示 legacy-global。

projectRecovery=false 是旧全局备份模式的兼容设置，不提供自动恢复或测试目录豁免。默认安装应使用 true；不应靠关闭保护绕过测试失败。Python 临时目录兼容仅注入受监督子进程，不修改全局 Python。

界面能打开或插件显示 enabled 不足以证明原生沙箱已工作。先在专用测试项目验收，再用于真实任务。

## 回退

正常退出 DSH，按安装前备份核对，只移除本插件对应的 dependency、lock entry、bundle 和 junction；不要删除 junction 指向的源目录，也不要恢复整份旧 profile 覆盖后来新增的插件。恢复库、回收站、隔离区和审计全部保留。若不确定 profile 差异，先做副本并人工比较。
