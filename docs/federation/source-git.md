# 治理代码的固定 Git 与事务边界

seven-module/H11：createSourceGate 接受显式 git: {path, sha256}，复用仓库模块的 gitPin 与 gitEnvironment。每次执行前核对摘要，使用固定绝对路径、最小环境和禁用 fsmonitor 的参数，不从 PATH 启动 Git，不继承 GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_*。

现有 CLI 可在验收文件旁放置同名附加 .git.json 文件，例如 accepted-rev.git.json；其中只有 path 和 sha256，路径应指向实际 bin/git.exe。格式或摘要错误时拒绝启动，不退回其他 Git。代码调用显式 git 参数优先于此文件。

未提供显式固定值或配置文件时，Windows 仅尝试标准 Program Files/Git/bin/git.exe，启动时计算并固定摘要。非标准安装必须使用上述配置。默认摘要是启动观察，不代表人工已批准该二进制；需要跨重启固定批准值时应提供配置文件。程序运行期间更换配置文件不会替换已经固定的命令。

治理回执包含 code_root、tree、git 路径及摘要。prepareDispatch 与 authorizeLaunch 的 Git 子进程检查都在写事务之前完成；写事务内重新读取当前任务、代次、角色、预算与启动状态，并比较领取时的治理回执。没有把事务外检查当作任务授权。旧版本 prepared 回执缺少 git 绑定，升级后不能直接启动；应先通过既有 abandon 管理出口处理，再按当前代码准备，不自动迁移运行或重试已启动任务。

这仍是启动时加载树与当前仓库状态的核验，不声称对治理目录提供操作系统级隔离，也不证明所有运行中的旧进程已加载新代码。Git 版本不同本身不会令相同对象哈希失去可比性。

本批同时修复了 CI #143 暴露的结束任务处理：任务上报后编辑应在 RUN_EXPIRED 拒绝；runner 先拒绝已消费/结束的启动许可，再检查可能已经清理的凭据文件，重复启动稳定返回 LAUNCH_NOT_AVAILABLE。

定向证据见 [本批记录](workspace-source-evidence.json)。
