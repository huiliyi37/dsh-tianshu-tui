# dsh-tianshu-tui 本地自包含开发环境

> 本文档记录本仓库（`@huiliyi37/dsh-tianshu-tui`）的目录内自包含启动方式、当前环境信息与踩坑记录，供后续开发留存。2026-08-16 建立。

## 一、每天怎么用

```sh
./scripts/dev.sh        # 一条命令启动 TUI（全离线，含 API key；macOS/Linux）
node scripts/dev.mjs    # 同等逻辑的跨平台入口（Windows 主入口；vendor 缺失时自动从 npx 缓存重建）
```

启动成功标志：欢迎页出现 `dsh-tianshu-tui` 品牌，状态行 `API Key ✓ · Git ✓`。`Ctrl+Q` 或 `/exit` 退出。

改了 `src/` 后：先 `npm run build`（两段：tsc → tsdown）再启动。

## 二、结构说明（本仓库目录内）

```
dsh-tui/                        本仓库
├── scripts/dev.sh              启动脚本（入库）
├── vendor/dsh-runtime/        官方 CLI 依赖树，342M（gitignore，不进仓库）
│   └── node_modules/@deepseek-ai/dsh/lib/bin.js   宿主 CLI 入口（0.1.1-rc.2）
├── .dsh-dev/                  本地开发 profile 家目录（gitignore），DSH_HOME 指向这里
│   └── profiles/tui/          装配结果：bundles = [@deepseek-ai/dsh-base, @huiliyi37/dsh-tianshu-tui]
│       └── node_modules/      本插件以 link: 指向本仓库根（build 后即时生效）
└── .pnpm-store/               pnpm 共享缓存 235M（gitignore，可删，删后需重装配）
```

关键环境变量：
- `DSH_HOME=$ROOT/.dsh-dev` —— profile 家目录隔离，**不碰**全局 `~/.dsh`
- `DEEPSEEK_API_KEY` —— 环境变量已有则优先；否则 dev.sh 自动加载 `~/.dsh/.env`（机器级配置位，key 不进仓库）

## 三、首次装配与重建

首次运行 `dev.sh` 自动装配（需网络一次）：

```sh
node vendor/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile tui add "@deepseek-ai/dsh-base@0.1.1-rc.2" "link:$ROOT"
```

- 机制：`dsh plugin add` = 在 profile 目录跑 `pnpm <args>` + reconcile `dsh.profile.bundles`；profile 模块解析 fallback 到 CLI 安装锚点，所以运行时所有 `@deepseek-ai/*` 从 vendor 树解析。
- 换机器/清掉 vendor 后重建（pnpm 平铺安装，与 npx/npm 布局一致）：
  ```sh
  mkdir -p /tmp/dsh-rt && cd /tmp/dsh-rt && echo '{"name":"dsh-rt","private":true}' > package.json \
    && printf 'node-linker=hoisted\n' > .npmrc && pnpm add @deepseek-ai/dsh@0.1.1-rc.2
  mkdir -p vendor/dsh-runtime && cp -R /tmp/dsh-rt/node_modules vendor/dsh-runtime/node_modules
  ```
  （CLI 须与 dsh-base 同线：0.1.2-alpha 线移除了 `installSettingsSection`，配 base 0.1.1-rc.2 会在 plugin tree 加载时报 `dsh-settings` 导出名缺失；pnpm 默认布局是 .pnpm 软链树，必须 `node-linker=hoisted` 才能平铺拷贝）
- 跨平台替代：`node scripts/dev.mjs` 在 vendor 缺失时自动定位 npx 缓存并拷贝
  （POSIX `~/.npm/_npx`、Windows `%LocalAppData%\npm-cache\_npx`），无需手工 cp；
  上述 cp 命令仅适用于 POSIX 手工路径。注意 npx 缓存若是无版本运行所得可能落在
  别的线（如 0.1.2-alpha），与本仓库依赖线不符时会启动即崩——以本节版本为准。

## 四、当前环境信息快照（2026-08-16）

| 项 | 值 |
|---|---|
| 本仓库路径 | `/Users/banxia/app/deepseek-tui/dsh-tui` |
| 包名/版本 | `@huiliyi37/dsh-tianshu-tui` 0.1.2-rc.7（npm 已发布） |
| 宿主 CLI | `@deepseek-ai/dsh` 0.1.1-rc.2（须与 dsh-base 同线；0.1.2-alpha 线已移除 `installSettingsSection`，与 base 0.1.1-rc.2 不兼容） |
| 官方生态 base | `@deepseek-ai/dsh-base` 0.1.1-rc.2（npm `next` 标签） |
| Node / pnpm | v24.1.0 / pnpm v10.32.1（PATH 有） |
| API key 配置位 | `~/.dsh/.env` 的 `DEEPSEEK_API_KEY`（dev.sh 自动加载） |
| git remote | `github` → huiliyi37/dsh-tianshu-tui；`omdsh` → omdsh-dev fork；`origin` 本地 bundle 勿推 |

## 五、同机三个"TUI"项目区分（易混淆）

| 项目 | 包名/版本 | 宿主 | 启动 | 与本仓库关系 |
|---|---|---|---|---|
| **本仓库** | `@huiliyi37/dsh-tianshu-tui` 0.1.2-rc.7 | 官方 CLI `@deepseek-ai/dsh`（npm `next` 标签 rc.7） | `./scripts/dev.sh` | — |
| oh-my-tianshu | `@huiliyi37/dsh-tui` 0.2.1（内嵌于 tianshu-public） | tianshu-public 源码 CLI（`@huiliyi37/*` 0.2.x 平行生态） | `~/.local/bin/omts` | 同源分叉，独立演进 |
| 旧快照 | `@deepseek-ai/dsh-root` 0.0.1（staging-20260809T152743Z） | 自身源码树 1.5G | 原 PATH 入口 `~/.local/bin/dsh` **已删** | 私人快照，入口已清 |

注意：`@huiliyi37/dsh-base`（0.2.x，peer `@huiliyi37/cordis`）是 oh-my-tianshu 生态的 base，**不是**本插件装配用的 `@deepseek-ai/dsh-base`。两套生态 scope 不同，勿混装。

## 六、常用开发命令

```sh
npm run typecheck        # tsc --noEmit（src + vision-ask）
npm test                 # vitest run（tests/ + vision-ask）
npm run build            # tsc -p tsconfig.build.json → tsdown（勿只跑裸 tsdown）
./scripts/dev.sh         # 启动 TUI
```

## 七、踩坑记录

1. **拷贝层级**：`cp -R <npx缓存>/node_modules vendor/dsh-runtime` 在目标不存在时会把内容平铺（缺 `node_modules` 层），Node bare-specifier 解析失败（`ERR_MODULE_NOT_FOUND`）。正确目标：`vendor/dsh-runtime/node_modules`。
2. **PATH 旧 dsh**：`~/.local/bin/dsh` 曾指向 0.0.1 旧快照（8月9日已按确认删除符号链接，1.5G staging 未动）。不要恢复它来当入口；统一用 `./scripts/dev.sh`。
3. **pnpm 忽略原生模块 build script**：首次装配警告 `node-pty`/`koffi`/`protobufjs` 等被忽略（pnpm 安全默认）。TUI 显示层不依赖，启动正常；若将来要 pty/原生能力，在 `.dsh-dev/profiles/tui` 里 `pnpm approve-builds`。
4. **首次装配需要网络**（从 npm 拉 `@deepseek-ai/dsh-base` 一次）；之后全离线。想彻底离线可把 dsh-base 也 vendor 后用 `link:` 装配。
5. **`.pnpm-store` 可删**（235M 共享缓存），但会连带 profile 内链接失效，需重新 `plugin add`。
6. **key 加载顺序**：环境变量 → `~/.dsh/.env`；不要把 key 写进仓库文件或文档。
