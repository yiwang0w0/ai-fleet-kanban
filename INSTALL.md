# INSTALL —— 给 AI 的安装步骤

用户对你说"帮我装 AI 舰队看板"时，照这一页做。只面向 Windows，命令按 PowerShell 写。
每一步都有能检查的结果：某一步失败就停下，把失败的那一行和它下面的"修法"告诉用户，不要绕过。

## 0 先弄清两件事

1. **任务在哪个文件夹里执行。** 必须是 git 仓库。用户说了就用那个；用户正在某个项目里和你对话，
   就用那个项目的根目录。用户只想先看看，就不设，以后再加（见「改配置」）。
2. **要不要让 Codex 也接活。** 只有用户提到 Codex 或 GPT 时才加 `--codex`。Codex 座席没有
   Claude 座席那样的路径封锁，只靠提示词约束，所以启用它要用户自己说。

## 1 检查环境

```powershell
node --version     # 需要 v24 或更高
git --version      # 需要 2.45 或更高
python --version   # 需要 3.9 或更高
claude --version   # Claude Code，执行任务的 CLI
```

缺什么装什么，装之前告诉用户要装什么：

- Node.js 24 LTS：`winget install OpenJS.NodeJS.LTS`
- Git：`winget install Git.Git`
- Python 3：`winget install Python.Python.3.12`
- Claude Code：按 Anthropic 官方安装说明装，装完运行一次 `claude` 完成登录

装完要开一个新的 PowerShell 窗口，新的 PATH 才生效。

## 2 下载

```powershell
cd $HOME
git clone https://github.com/yiwang0w0/ai-fleet-kanban
cd ai-fleet-kanban
```

用户没指定位置就放在主目录。不要放进要执行任务的项目里面。

## 3 生成配置

```powershell
$env:PYTHONUTF8 = "1"
node cli/setup.mjs --repo "D:\path\to\project"
```

需要 Codex 时在末尾加 `--codex`；用户只想先看看，就去掉 `--repo` 和它后面的路径。

setup 先体检，有 FAIL 就停下，按 FAIL 下面的修法处理后重跑。成功时会显示「执行线: Claude」
和接下来的命令。配置写在看板目录的 `fleet.config.json`，已经存在时不会覆盖。

带参数时直接用 `node`：PowerShell 里 `npm run setup -- --codex` 的 `--` 可能被吞掉，参数就丢了。

## 4 启动并打开

```powershell
npm run start:bg
npm run open
```

`start:bg` 在后台启动看板，返回时看板已经在应答；关掉 PowerShell 也不会停。
`open` 打开浏览器并自动连上，浏览器会记住这台电脑。没有自动打开时，把它打印的地址交给用户；
地址里的配对码 10 分钟内有效，只能用一次。

## 5 交给用户

告诉用户三件事：

1. 面板首页会提示「确认当前版本」。请用户本人点，看一眼版本号后确认。看板只运行用户确认过的代码，
   **不要**替用户运行 `python cli/board.py bless`。
2. 开始干活：在「全部任务」页上方的「自动拉取」一行，点 Claude 旁边的「启动」；然后在「目标」栏
   写下要做的事，点「加入并拆解」。
3. 停止用 `npm run stop`，再启动用 `npm run start:bg`。

## 平时用

| 想做的事 | 命令 |
|---|---|
| 停止 | `npm run stop`（有任务正在执行时会先拒绝；确定要停：`node cli/stop.mjs --force`） |
| 启动 | `npm run start:bg` |
| 换了浏览器、清了浏览器数据 | `npm run open` |
| 体检 | `npm run doctor` |
| 更新看板 | `git pull`，然后在面板顶部的横幅里点「更新到新代码」，它会先列出改动 |

## 改配置

配置文件是看板目录里的 `fleet.config.json`。改完 `port`、`repo`、`codex_cmd`、`codex_released`
要重启：`npm run stop`，再 `npm run start:bg`。加线不用重启。

- **换执行任务的文件夹**：设 `"repo": "D:/path/to/project"`（用 `/` 或 `\\`）。
- **启用 Codex**：加三项。

  ```json
  "codex_cmd": "C:/Users/<你>/AppData/Roaming/npm/node_modules/@openai/codex/.../codex.exe",
  "codex_released": true,
  ```

  并在 `lines` 里加一条：

  ```json
  { "id": "codex", "label": "Codex", "hint": "通用任务,由 Codex 执行",
    "role": { "seat": { "runtime": "codex", "model": "gpt-5.6-sol", "effort": "high" } } }
  ```

  `codex_cmd` 必须是原生的 `codex.exe` 绝对路径，不能是 `codex.cmd` 或 `codex.ps1`。用 npm 装的
  Codex，原生文件在 npm 全局目录的 `node_modules\@openai\` 下面；`npm run doctor` 找到它时会把路径打出来。
- **换端口**：设 `"port": 47900`（默认 47824）。

## 出问题

- `npm run start:bg` 说没起来：它会打印这次的日志；完整日志在 `core\.data\board.log`。
- `start:bg` 说已在运行，紧接着 `npm run open` 却说看板没有在运行：你所在的工具在每条命令结束时会结束它启动的
  所有进程。请用户自己开一个 PowerShell 窗口，进入看板目录运行 `npm start`，并让这个窗口一直开着。
- 端口被别的程序占用：换端口（见上），再 `npm run start:bg`。
- 面板显示要重新连接：`npm run open`。
- 想从头再来：`npm run stop`，然后 `node cli/reset.mjs --yes`。它只清运行数据，不动配置和仓库；
  之后要重新确认版本。

## 不要做的事

- 不替用户确认版本（bless），也不启用用户没要求的执行器。
- 不把 `core\.data\board_token` 的内容贴进聊天、网址或其他文件。
- 不手改 `core\.data\` 里的文件。
