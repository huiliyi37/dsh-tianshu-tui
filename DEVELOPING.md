# dsh-tui 独立基线仓 — 开发说明

> 目录内自包含启动方式（`./scripts/dev.sh`；Windows 用 `node scripts/dev.mjs`）、当前环境快照与踩坑记录见 [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md)。

本仓库是 dsh 公开版插件的独立基线仓，当前含两个独立插件：
`@huiliyi37/dsh-tianshu-tui`（终端 UI，本仓根部）与 `@deepseek-ai/dsh-vision-ask`（视觉副驾：
会话图片注册表 + ask_image 工具，`vision-ask/` 子目录，将来可整体拆独立仓）。

## 来源

- 代码源自 DeepSeek Harness 内部开发版 `packages/tui/tui`，经 P1 适配移植为公开版可插拔
  bundle 形态（见 `docs/PUBLISH-PLAN.md` 与 git 历史首条提交）。
- 渲染核心移植自天枢 / Tianshu-Tui（Apache-2.0，公开上游），来源与修改声明见
  `SOURCE-MAP.md` 与 `NOTICE`。
- vision-ask 移植自 opencode-tui 的 image-registry / ask-image / vision-service
  （Apache-2.0 上游），设计决策与溯源见 `vision-ask/docs/` 与包内注释。

## 结构

```
src/                插件源码（tui-runner 入口见 src/index.ts）
tests/              vitest 测试套件（app.spec.ts 黑盒 + 装配测试等）
docs/               内部文档（RELEASE.md 发版手册；PUBLISH-PLAN.md 历史筹备；projection-layer.md 等）
cordis.patch.yml    bundle patch：`dsh plugin add` 装配层
package.json        包清单（@huiliyi37/dsh-tianshu-tui；发版见 docs/RELEASE.md）
tsdown.config.ts    打包配置（lib/types/*.js → lib/index.js + lib/invariant.js）
vision-ask/         独立插件 @deepseek-ai/dsh-vision-ask（自有 package.json/tsconfig/src/tests）
lsp/                独立插件源码（@deepseek-ai/dsh-lsp，已迁出为社区独立仓 omdsh-dev/dsh-lsp；
                    TUI 展示桥探测顺序：社区插件服务 → 官方 ctx.lsp seam（getDiagnostics
                    适配）→ 内置桥降级）
```

## 依赖前提

peerDependencies 指向宿主相关 `@deepseek-ai/dsh-*`（精确 `0.2.2-rc.3`）与 `@deepseek-ai/cordis`（`~4.1.0`）。
官方核心包与 CLI 的 npm `latest` / `next` 标签均指向 `0.2.2-rc.3`。`pnpm install`、`tsc`、`vitest` 可在能解析这些 peer 的环境运行（公开版
monorepo 工作区：`pnpm exec tsc -b packages/tui/tui`、`pnpm vitest run packages/tui/tui/tests`）。
vision-ask 的附件引用均为 type-only：行为测试可在任一解析 dsh-llm/dsh-tools 的
工作区运行（`vitest run vision-ask/tests/`）；类型面在公开版环境复核。

## 构建

```sh
npm run typecheck   # tsc --noEmit（src + tests）
npm run build       # 两段：tsc -p tsconfig.build.json（src → lib/types/*.js+.d.ts）→ tsdown（lib/types → lib/index.js + lib/invariant.js）
npm test            # vitest run tests/
# vision-ask（独立 tsconfig/打包）
tsc -p vision-ask/tsconfig.json --noEmit
```

**不要只跑裸 `tsdown`**：它的 entry 是 `lib/types/*.js`（tsc 产物），跳过 tsc 会把旧产物重新打包成新旧混合的 bundle（docs/PUBLISH-PLAN.md 已记录该坑）。

## 发布

发版按 [docs/RELEASE.md](docs/RELEASE.md)（主仓 + `omdsh-dev` fork 双推、npm `--tag latest`）。

- 主仓：https://github.com/huiliyi37/dsh-tianshu-tui（remote `github`）
- 组织 fork：https://github.com/omdsh-dev/dsh-tianshu-tui（remote `omdsh`）
- `origin` 是本地 bundle，不要推

历史筹备清单：`docs/PUBLISH-PLAN.md`（已过期）。
