# 维护约束

- 先读 README.md、INSTALL.md、VALIDATION.md；这是 DSH 0.2.2-rc.3 的 Windows 本地适配基线。
- 用户目标是误操作可恢复，并保留 Purge 常用功能。不要将工具管线保护宣称为内核级或全盘保证。
- 任何删除/恢复测试只使用新建专用样本，不使用真实账号、会话、密钥、插件配置。测试目录不能指向磁盘根或用户根。
- 修改/安装前备份；备份失败不降级永久删除。恢复不覆盖已有目标，默认保留全部恢复记录。
- 不自动清空恢复库、隔离区或回收站；不要向模型提供清空接口。
- 不修改 Purge 源码或全局补丁，不绕过启动探针、版本校验和 guard；宿主升级必须重新验证。
- 修改后使用 DSH 自带 Node 24 运行 `--test test/recovery.test.mjs test/harness.test.mjs`，每个 JS/MJS 分别做语法检查。另有 PowerShell 脚本时检查语法和 BOM；菜单兼容 Windows PowerShell 5.1。
- 真实回收站、ACL runner 和宿主验证要明确记录；缺少环境不能用 mock 通过替代，不应在通用 CI 上伪造完整验收。
- 原始应用快照、凭据、个人路径、审计和运行记录只保存在受限本地目录，不提交 Git。
- 保留官方 DeepSeek MIT 许可证、原始 sandbox 源码及 provenance；重新生成时核对精确版本和包完整性。
- SOURCE-BASELINE.json 记录冻结版一致性，后续功能变化应更新版本和验证记录；不要把未来计划写成当前能力。
