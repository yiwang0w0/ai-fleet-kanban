# 仓库映射与固定提交内容

本模块为 T07.01 和 T07.03 提供本机仓库登记、基线核对和实际字节读取。两台电脑可以在不同盘符/路径，用同一个项目内 repo_id 和批准的完整提交标识定位交付基础。看板自身 sourceGate 的 code_root 仍用于治理代码核验，与任务仓库分开。

## 登记与身份

本机管理者显式提供 mapping_id、project_id、repo_id、仓库根、实际 Git 可执行文件及 SHA-256、基础提交和允许读取的文件/目录。根必须是实际非裸仓库的顶层目录。程序保留规范根路径、Git common directory、对象格式及固定 Git 摘要；公开查询只返回仓库标识、允许路径和批准基线，不返回本机路径或程序位置。

同一节点 epoch、项目、repo_id 只有一个映射。相同请求精确重放返回原记录，不能用新请求静默改路径。登记、初始基线和审计同事务提交；增加基线也必须经本机管理命令并原子记录。当前没有原地迁移映射路径的接口。每项目当前代次最多 100 个映射，每映射最多 1000 个批准基线；历史不删除。

恢复副本激活前不能使用仓库登记；激活后旧 epoch 的映射仍保留，但不可继续捕获内容。操作员必须重新核对当前本机路径、Git 和基线，再登记新映射。列表标注 identity_current，不把旧路径自动当成新设备路径。未来不兼容 schema 拒绝读取和迁移。

这里的“批准基线”只表示本机允许用该提交作为任务基础，不是看板治理源码 accepted_rev，也不代表任务验收。repo_id 的两端对应关系由各端本机管理者明确登记；本模块不根据远端 URL 自动克隆或发现仓库。

## 内容读取合同

调用者指定已登记 repo_id、批准 base_commit、完整 commit 和明确的相对文件列表。提交标识只接受当前对象格式的完整小写 SHA-1 或 SHA-256，不接受 HEAD、分支、标签对象或任意 revision 表达式。交付提交必须能沿经逐项哈希核验的父链到达批准基线；缺少对象或无继承关系拒绝，不自动 fetch。

Git 使用固定程序路径、过滤后的环境和固定参数，禁用 lazy fetch、replacement refs、外部传输、可选锁及 fsmonitor。Windows 固定实际 bin/git.exe，拒绝 cmd/git.exe 启动器。最低要求 Git for Windows 2.45.0；[Git 2.45 官方发布说明](https://raw.githubusercontent.com/git/git/v2.45.0/Documentation/RelNotes/2.45.0.txt)记录了 --no-lazy-fetch 的引入。固定程序通过 SHA-256 检查后，再探测版本与该选项；旧版本返回 GIT_TOO_OLD，未知版本返回 GIT_VERSION_UNVERIFIED，缺少选项返回 GIT_CAPABILITY_UNAVAILABLE，均早于仓库对象读取和登记。成功探测仅按已复核的程序路径与摘要在当前进程缓存，程序摘要仍在每次 gitPin 时重新检查。读取不 checkout，不调用 textconv/smudge，不使用工作目录中同名文件的内容。因此本机未提交修改和换行转换不会混入交付。

读取原始 commit、tree、blob 对象，按 Git 对象格式重新计算内容地址。每条选定文件路径经过的目录对象及提交父链都验证，不能仅信任 ls-tree 的对象名。实际文件另计算 SHA-256 和字节数，作为后续内容传输依据；损坏对象即使放在正确对象文件名下仍拒绝。

路径必须为 NFC、UTF-8、规范相对路径。禁止绝对路径、反斜杠、盘符/流、父目录跳转、空段、控制字符、Windows 设备名和 Git 元数据保留名（.git 及 git~1 等短名）；普通 git/ 目录允许读取；同时检查选中文件及目录前缀的大小写冲突。只接受 Git 普通文件模式 100644 / 100755，允许零字节文件。符号链接、穿越链接、子模块和 LFS 指针不充当实际产物。

| 范围 | 限制 |
| --- | --- |
| 本机允许读取范围 | 1–32 个精确文件或以 / 结尾的目录前缀 |
| 本次选择 | 1–256 个文件 |
| 内容 | 每文件最多 8 MiB，总计最多 32 MiB |
| 相对路径 | 最多 1024 UTF-8 字节、32 段，每段最多 240 字节 |
| 目录遍历 | 选定路径涉及的目录对象合计最多 10000 项 |
| 提交遍历 | 最多 1000 个祖先提交，每提交最多 128 个父提交 |
| Git 读取 | 一次读取器总期限 30 秒，单条命令最多 10 秒 |

返回 repository_content_snapshot 清单，绑定项目、repo_id、对象格式、基础/交付 commit 和 tree；文件条目包含相对路径、mode、blob_oid、size、sha256。清单规范摘要和实际 Buffer 内容同时返回可信本机调用者。它尚不是与 result/task/run 绑定的持久交付包，调用者仍须完成持久化及关联，不能只拿摘要声明文件送达。


文件内容使用 [Git cat-file 批量协议](https://git-scm.com/docs/git-cat-file)读取：先对去重对象 ID 执行 batch-check，严格校验返回顺序、类型和规范大小；按每条逻辑文件计算总量，相同 blob 被多个路径引用也不会免除大小额度。确认整次请求未超限后，再按最多 128 个文件、16 MiB 逻辑内容分批读取原始 blob。

每个批次严格匹配对象 ID、blob 类型、长度、二进制内容边界及结束换行，重新计算 Git 对象哈希；截断、多余输出、被替换字节和 LFS 指针均拒绝。单批内相同 blob 只传一次，交付给各文件的 Buffer 独立，避免调用者修改一个文件时影响另一个。原始提交与路径上的目录对象仍逐项验证，禁止隐式 fetch、filters、textconv 和替换对象的设置保持有效；总期限仍为 30 秒，单命令最多 10 秒。

选择性 capture 只读取明确允许的文件；完整工作区 snapshot 则必须保持批准提交的全部目录树。工作区池另需 allow_full_history_copy 授权，不能把产物 allowlist 当成稀疏检出配置。若范围外存在无法安全物化的符号链接或子模块，完整 snapshot 明确拒绝，不能静默漏掉它们后声称工作区等于批准提交。稀疏工作区不在当前合同内。

## 本机 CLI

~~~text
node cli/repository.mjs register --db <DB绝对路径> --config-file <登记JSON绝对路径>
node cli/repository.mjs approve-base --db <DB> --mapping <UUID> --base <完整提交ID>
node cli/repository.mjs get --db <DB> --project demo --repo app
node cli/repository.mjs list --db <DB> --project demo
node cli/repository.mjs manifest --db <DB> --project demo --repo app --base <批准提交> --commit <交付提交> --paths-file <文件列表JSON绝对路径>
~~~

登记 JSON 模板（尖括号内容须用本机实测值替换）：

~~~json
{
  "mapping_id": "<本次登记UUID>",
  "project_id": "demo",
  "repo_id": "app",
  "root": "<本机仓库绝对路径>",
  "git": {"path": "<实际Git程序绝对路径>", "sha256": "<程序SHA-256>"},
  "base_commit": "<本机批准的完整提交ID>",
  "paths": ["src/", "docs/", "package.json"]
}
~~~

paths-file 内容为相对文件名 JSON 数组。manifest 命令读取并校验实际内容，只向 stdout 输出清单及摘要；明确返回 content_captured=true、content_persisted=false、transferred=false、accepted=false，不在宿主工作区提取文件。命令失败退出码为 1，不自动调用模型、修复仓库或切换分支。

## MCP 与后续

coordinate / observe 只能使用 get_repository(project_id, repo_id) 和 list_repositories(project_id, limit)，每次核对项目范围。MCP 不提供登记路径、批准基线或读取文件内容的入口；这些能力保留在可信本机管理层。工具查询只描述登记记录，不能用来宣称当前 Git 对象仍存在；实际捕获时会再次核验。

实际临时 Git 仓库测试覆盖双路径同内容、未提交修改、权限与幂等、损坏 commit/tree/blob、父链、高位字节伪装、特殊文件、路径别名、SHA-256 仓库、禁止隐式获取、容量、独立进程竞争、CLI/MCP 和真实备份激活。最终测试与源码摘要见 repository-evidence.json。

下一步是独立任务工作区、将捕获字节绑定实际 result/task/run 并持久保存、分块续传与接收复核，以及隔离环境中的独立验证。工作区不是 OS 沙箱，Git 固定摘要也不代替恶意程序隔离。来源正向验收、关系退役与父任务推进须等这些证据接通后实施。当前没有声称跨电脑传输了文件或完成 G07。

Git 行为参考官方 [git 通用选项](https://git-scm.com/docs/git) 与 [git-cat-file 原始对象读取](https://git-scm.com/docs/git-cat-file)。本机验证 Git 2.54.0.windows.1；其他安装须实际支持并通过上述读取合同，不能沿用未核验的版本结论。

Windows 路径核验使用原生长路径解析与文件系统设备/目录标识。同一目录的 8.3 短路径和长路径可以登记、精确重放及读取；真实子目录仍拒绝。该修正已由本机实际短路径夹具验证，准确提交的跨平台结果见证据记录。
