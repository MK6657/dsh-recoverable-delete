# 0.2.2 专用样本验收

## 升级后的只读核对

已通过的核心删除/恢复动作无需为字段修复反复重做。可先只调用 recovery_status，然后 recovery_list：

- 已登记且有效的项目库在重启后即应显示 projectVaultState=ready、实际 projectVault 和 recentSource=project；状态前 10 条应与列表前缀一致，记录带 vaultRoot。
- 真正尚无项目库时应为 absent、projectVault=null、recent=[]；不出现全局旧记录，也不因查询创建目录或任务登记。
- receiptIndex.state=readable 仅说明索引可读。恢复结果看 lastRestore.status 与 audit.state；未恢复为 null，输出相对路径优先 relativePath。restoreQuery/relative_path 是保留的兼容别名。
- 若库缺失/未登记/不完整/不可读，按 projectVaultState 诊断，不靠改 cwd 或关闭保护“修复”。

## 需要功能验收时：现有会话专用样本

先调用 recovery_status，确认 version=0.2.2、projectRecovery=true、automaticRestore=true、启动探针通过，并读取 boundWorkspace。它才是本会话的项目边界，不以 shell workdir、working_directory 或子任务参数 cwd 代替。

可直接发给 DSH：

> 先调用 recovery_status，报告 boundWorkspace。仅在这个目录里新建一个不存在的、带随机后缀的专用验收子目录。不要修改任何已有真实文件，不修改插件，不碰账号、会话或备份库，也不通过改 cwd 或派子任务扩大范围。
> 1. 用 write 新建 restore-me.txt，内容为专用测试文字，记录原字节或哈希。对它调用 recoverable_delete，再用返回 ID 调用 recoverable_restore。核对原内容恢复、audit.state=complete。
> 2. 新建 conflict.txt，保存旧内容；删除后用 write 在原路径写入 NEW CONTENT MUST STAY，再调用 recoverable_restore。核对 conflictCopy=true、原路径保持新内容，旧内容在返回的副本里。
> 3. 调用 recovery_create_temp，仅在返回的新目录写入可重建测试输出，再用 recoverable_delete 清理。应为 recycled-no-backup；对此记录请求 restore 应拒绝，不能假称有内容备份。普通 test/tmp 文件名不构成豁免。
> 4. 调用 recovery_list，总结每条相关记录的 ID、原路径、status、lastRestore.status、restoreDestination 和 audit.state；也保留每次 restore 返回值做对照。未恢复记录的恢复字段应为 null，不能把原删除 status 当成恢复结论。
> 5. 测试后保留冲突副本和普通验收样本供用户核对，不清空回收站或备份，不反复删除恢复。

同一目录里新建的普通验收样本仍有内容备份；只有 recovery_create_temp 登记的可丢弃目录享有精确清理免备份。测试程序内部临时清理不逐条拦截，不保证全部进回收站。

## 使用事先准备的外部固定目录

如果要使用另一目录里的现成验收样本，需要人先在 GUI 将该目录添加为工作区，并在该工作区新建会话。新会话先检查 recovery_status.boundWorkspace 与目标项目完全一致，再开始删除。

不能靠 shell workdir、working_directory、subagent 的 cwd 参数让已有父会话改绑。如果没有 GUI 操作条件，停止对外部样本的修改，采用上面的当前会话专用样本方案；不要绕过保护或不断换解释器试探。

## 结果含义

- status 是原删除/备份事件状态，例如 recycled；最近恢复在 lastRestore 中。
- restoreDestination 是最近持久收据中的目标；audit.state=complete 说明那次恢复的审计已完成，不保证目标后来没有被再次修改或清理。
- restored-audit-pending 表示文件已恢复但审计待补记，交由人工菜单选 5 核验，不重复恢复。
- incomplete 表示事务没有完整成功收据；receiptIndex.state=partial（旧别名 restoreQuery.state=partial）表示部分收据无法读取，不得推断“全部审计完成”。

## 人工恢复与旧版兼容

从资源管理器双击 DSH-Recovery.cmd，菜单修订 3，选 2，按原路径和 ID 找到记录并输入数字编号。原路径为空时可直接回车；已有内容则另存副本。成功为 status=restored、audit.state=complete；退出选 0。

菜单在 DSH agent/集成终端中拒绝启动是预期行为。模型自动恢复使用 recoverable_restore，不能直接运行恢复 CLI。旧库、账号/应用数据恢复继续人工处理。
