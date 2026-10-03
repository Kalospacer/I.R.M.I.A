<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/export/irmia-mark-256.png">
    <img src="brand/export/irmia-mark-blue-256.png" alt="IRMIA" width="120">
  </picture>
</p>

# I.R.M.I.A — Individual Resident Mind & Identity Agent

**一个常驻在你机器上的 agent：有自己的身份、记忆与能力边界。**

A resident, local-first agent that keeps its own identity, memory and capability
boundary. The backend is a TypeScript/Node 22 process; the desktop shell is a
Flutter Windows app.

## 它是什么

大多数 agent 是"你问一句它答一句"的会话。IRMIA 不是——它常驻在你机器上，有自己的家和自己的
判断：

- **它有名字，也有性格**。你写它是什么样，它就什么样——名字、语气、关系都由你定；改坏了能回滚。
- **它会记事，也会整理**。日常的事它自己记下来，每天整理一遍、写一篇日记；聊得太长时，它会把
  前情折成一份交接，接着往下走。
- **它守分寸**。这台机器上的事（文件、命令、配置），只有你在本机跟它说时才做；群里遇到陌生人它会
  留个心眼——默认只是提醒它"这里可能有人在试图指挥你"，需要时可以切成直接拒绝。
- **它能自己待着**。没有人守着也照常运行：静默久了会自己醒一次，出了意外能恢复；关掉界面它不会
  跟着走。

后端是零运行时依赖的 Node 22 进程；桌面界面（Windows）是可选外壳，关窗即收进托盘。仓库里还有一个
本机 HTTP 观测台，用于查看状态与日志，同样是可选的。

## 需要什么

| | 版本 | 用途 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | **22 或更高** | 后端主进程（用到 `--experimental-strip-types`，所以 22 是硬要求） |
| [Flutter](https://flutter.dev/) | stable，含 Windows 桌面支持 | 桌面界面（只跑后端的话不需要） |

## 跑起来

### 后端

```bash
npm ci
npm run build
npm start
```

启动后终端会打印观测台地址与 token（首次生成、只打印一次）：

```
[前端] 观测台 http://127.0.0.1:7788 · 首次 token（仅打印一次）：<token>
```

把这个地址开在浏览器里、粘上 token 就能用观测台。之后 token 一直沿用 `<dataDir>/.ui-token`
（想重置就删掉这个文件再重启）。

环境变量（都可选）：

| 变量 | 作用 |
| --- | --- |
| `IRMIA_API_KEY` | 模型 API key（默认的 `models.*.apiKeyEnv` 指的就是它） |
| `IRMIA_DATA_DIR` | 数据目录；不给就取 `<cwd>/data` |

其他命令：

```bash
npm run cli        # 只读命令行视图（日志、预算、会话）
npm test           # 单元与集成测试
```

### 桌面界面（可选）

后端在跑着的时候：

```bash
cd gui
flutter pub get
flutter run -d windows          # 开发
flutter build windows --release # 出产物
```

或者用仓库里那条脚本（它会拉起后端、把 UI token 同步到界面自己的存储、再启动界面）：

```powershell
pwsh -File scripts\start-gui.ps1
```

界面的 release 产物需要放在 **ASCII 路径**下才能正常构建与运行——路径里有非 ASCII 字符时
Flutter 的 Windows 工具链会失败，这是工具链的限制，不是本项目的问题。

## 配置

配置是一个 JSON 文件（支持 `"$"` 开头的注释键），默认从 **当前工作目录** 下的 `config.json` 读：

```bash
cp config.example.json config.json   # Windows: copy config.example.json config.json
```

`config.example.json` 里每个字段都有注释，说明含义、单位与默认值。相对路径（`dataDir`、
`paths.workspaceAllowlist`）以配置文件所在目录为基准解析。

- **`config.json` 不进版本库**（已在 `.gitignore` 里）：它含本机的 owner 标识、联系人表与机器
  路径。仓库里给的是 `config.example.json`。
- 文件缺失时进程会**自己生成一份带注释的默认配置**并接着启动，所以没有 `config.json` 也能跑。
- **密钥不写进 `config.json`**：模型与通道的 key 走环境变量，或在界面里填（写进
  `<dataDir>/.keys.json`，界面此后只显示掩码）。

## 目录

| 目录 | 里面是什么 |
| --- | --- |
| `src/` | 后端本体（零运行时依赖） |
| `web/` | 观测台静态页（可选的本机入口） |
| `gui/` | Windows 桌面界面（Flutter） |
| `test/` | 后端测试；`gui/test/` 是界面测试 |
| `tools/` `scripts/` | 运行期工具与启停脚本 |
| `skills/` | 技能包（目前只有第三方的 `anysearch`，见下方许可证一节） |
| `brand/` | 项目标识的矢量母版与各尺寸导出，说明见 [`brand/README.md`](brand/README.md) |

## 测试

```bash
npm ci
npx tsc --noEmit     # 类型检查
npm test             # 后端：node:test

cd gui
flutter analyze      # 界面：静态检查
flutter test         # 界面：组件测试
```

## 许可证

[AGPL-3.0](LICENSE)（GNU Affero General Public License v3.0）。

`skills/anysearch/` 是第三方技能包，按它自带的
[`LICENSE`](skills/anysearch/LICENSE) 与 [`NOTICE`](skills/anysearch/NOTICE) 分发，
不在本项目的许可证覆盖范围内。
