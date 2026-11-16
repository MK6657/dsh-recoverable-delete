# 0.2.0 专用样本验收

先确认 recovery_status 显示 version=0.2.0、projectRecovery=true、automaticRestore=true、启动探针通过。普通工作区是具体测试项目，不能是磁盘根或用户根。

## 模型自行恢复

准备一个新建专用样本文件，让模型对其调用 recoverable_delete（说明原因），然后使用返回 ID 调用 recoverable_restore（说明误删原因）。原位置应还原，status=restored、audit.state=complete；项目 .dsh-recovery 内有对应清单与去重对象。

再测冲突：删除另一个样本后，在原路径创建内容不同的文件。调用 recoverable_restore 应返回 conflictCopy=true 和 .dsh-recovered 下的新副本，原路径的新内容保持不变。其他任务不能恢复该记录，不需要用真实账号数据验证。

## 可信临时测试输出

调用 recovery_create_temp，说明用途；只在返回的新目录内创建可重建测试输出，再调用 recoverable_delete 清理。应返回 recycled-no-backup，恢复目录没有为这批输出保存内容对象。这里不存真实数据的唯一副本或测试源码。

显式临时清理走回收站；测试程序自己在内部创建并删除的临时文件不逐条拦截，不保证全部进回收站。此类产物应可重新生成。

## 人工恢复和旧版兼容

先确保安装路径正确、插件状态和启动探针通过。选择一个新建的专用测试项目，放入一个普通文件和一个含文件的目录，记录其内容或 SHA-256。不要使用真实账号库、会话或配置做删除样本。

在 DSH 中要求只对这两个精确样本路径调用 `recoverable_delete`，默认走回收站，并返回恢复记录 ID。确认原位置消失、记录为 recycled 或有明确隔离状态，备份仍完整。

从 Windows 资源管理器双击根目录 `DSH-Recovery.cmd`：

1. 开头应显示“菜单修订 3”。选择 `2`；旧全局库和登记的项目库都能列出。
2. 列表每条独立显示 `[编号]`、完整原路径、记录 ID；根据样本原路径选择数字编号。
3. 原位置为空时，目标路径直接回车，恢复到显示的原位置。
4. 检查 `status: restored`、`audit.state: complete`，再用相同步骤恢复另一个样本。
5. 核对原始内容/哈希和目录结构。已有目标时不会覆盖，菜单默认另存副本。
6. 黄色审计待补记表示文件已恢复，选 `5` 核验补记，不重复恢复。结束输入 `0`。

菜单在 DSH agent 或其集成终端中拒绝启动是预期行为。模型自动恢复只能通过 recoverable_restore 工具完成，不能直接运行恢复 CLI。
