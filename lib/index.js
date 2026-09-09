import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { Session, SessionId, SessionLogOffset, foldRequestHeader } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import stringWidth from "string-width";
import { eastAsianWidthType } from "get-east-asian-width";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { fallbackSessionTitle, foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import { structuredPatch } from "diff";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
//#region lib/types/self-update.js
/**
* 启动时对照 npm `latest`，把 profile 里的本包升到新版本。
* 已加载的模块不会热替换——更新落盘后需重启才生效。
*
* @module @huiliyi37/dsh-tianshu-tui/self-update
*/
/** 与 package.json name 对齐；profile 依赖键、npm 包名都用它。 */
const TUI_PACKAGE = "@huiliyi37/dsh-tianshu-tui";
/** 更新检查磁盘缓存 TTL：1h——每次启动都打 registry 没必要，24h 又会让
*  装好新版本的用户一整天看不到更新提示（上游 updater 同款权衡）。 */
const UPDATE_CACHE_TTL_MS = 36e5;
/** 缓存落在本包 home（与自定义主题根 ~/.dsh-tui 同处，不污染 profile 目录）。 */
function defaultUpdateCachePath() {
	return join(homedir(), ".dsh-tui", "update-cache.json");
}
/** registry / dist-tag / 范围：视为 npm 安装。git 与本地路径不是。 */
function isNpmVersionSpec(spec) {
	return !/^(github:|git\+|file:|link:|workspace:|https?:)/.test(spec);
}
/** CI、vitest、显式开关下不联网。 */
function shouldCheckForUpdate(env) {
	if (env["DSH_TUI_SKIP_UPDATE"] === "1" || env["DSH_TUI_SKIP_UPDATE"] === "true") return false;
	if (env.CI === "true" || env.CI === "1") return false;
	if (env.VITEST === "true" || env.VITEST === "1") return false;
	return true;
}
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
/**
* 从本包安装目录向上找 profile（含 `dsh.profile` 或对本包的 dependencies）。
* 跳过本包自己的 package.json。
*/
function findProfileDir(startDir) {
	let dir = startDir;
	for (let i = 0; i < 16; i++) {
		const pkg = readJson(join(dir, "package.json"));
		if (pkg !== void 0 && pkg.name !== "@huiliyi37/dsh-tianshu-tui" && (pkg.dsh?.profile !== void 0 || pkg.dependencies?.["@huiliyi37/dsh-tianshu-tui"] !== void 0)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
/** 读本包 version（向上找 name === TUI_PACKAGE 的 package.json）。 */
function readOwnVersion(startDir) {
	let dir = startDir;
	for (let i = 0; i < 8; i++) {
		const pkg = readJson(join(dir, "package.json"));
		if (pkg?.name === "@huiliyi37/dsh-tianshu-tui" && typeof pkg.version === "string") return pkg.version;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
function readInstallSpec(profileDir) {
	return readJson(join(profileDir, "package.json"))?.dependencies?.[TUI_PACKAGE];
}
function planSelfUpdate(input) {
	if (!shouldCheckForUpdate(input.env)) return {
		action: "skip",
		reason: input.env.CI !== void 0 || input.env.VITEST !== void 0 ? "ci" : "env"
	};
	if (input.profileDir === void 0) return {
		action: "skip",
		reason: "no-profile"
	};
	if (input.installSpec === void 0 || !isNpmVersionSpec(input.installSpec)) return {
		action: "skip",
		reason: "not-npm"
	};
	if (input.latest === null || input.latest === "") return {
		action: "skip",
		reason: "no-latest"
	};
	if (input.latest === input.currentVersion) return {
		action: "skip",
		reason: "same"
	};
	return {
		action: "update",
		latest: input.latest
	};
}
/** registry 基址链：官方源 → 国内镜像（npmmirror，完整 npm REST 镜像）。
*  #43：registry.npmjs.org 直连不通的网络下，单源 3s 超时让启动检查恒失败。 */
const UPDATE_REGISTRY_FALLBACKS = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
/** 自定义 registry 链（逗号分隔多个；优先生效）——私有源/代理场景。 */
const UPDATE_REGISTRY_ENV = "DSH_TUI_UPDATE_REGISTRY";
/** 解析 registry 尝试链：DSH_TUI_UPDATE_REGISTRY 覆盖 > 官方 + npmmirror。 */
function npmRegistryCandidates(env = process.env) {
	const custom = env[UPDATE_REGISTRY_ENV];
	if (custom !== void 0 && custom.trim() !== "") {
		const list = custom.split(",").map((s) => s.trim()).filter((s) => s !== "");
		if (list.length > 0) return list;
	}
	return [...UPDATE_REGISTRY_FALLBACKS];
}
async function fetchLatestFromRegistry(baseUrl, packageName, timeoutMs, fetchImpl) {
	const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/${packageName.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) return null;
	const body = await res.json();
	return typeof body.version === "string" ? body.version : null;
}
/**
* 逐源查 latest：任一源拿到版本即返回——官方源超时/不可达时回退镜像。
* 单源失败（超时/网络错/非 200）不中断链；全部源都网络错则抛最后一个错误
* （保持启动「自更新失败」warning 语义，#43 之前行为）。全部源 200 但无
* version → null（no-latest 静默跳过）。
*/
async function fetchNpmLatest(packageName = TUI_PACKAGE, timeoutMs = 3e3, opts = {}) {
	const registries = opts.registries ?? npmRegistryCandidates();
	const fetchImpl = opts.fetchImpl ?? fetch;
	let lastError;
	let sawError = false;
	for (const baseUrl of registries) try {
		const version = await fetchLatestFromRegistry(baseUrl, packageName, timeoutMs, fetchImpl);
		if (version !== null) return version;
	} catch (err) {
		sawError = true;
		lastError = err;
	}
	if (sawError) throw lastError;
	return null;
}
/** 读缓存；缺失/损坏/形状不对 → null（容错：缓存坏不挡更新检查）。 */
function readUpdateCache(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw.timestamp === "number" && typeof raw.latest === "string") return {
			timestamp: raw.timestamp,
			latest: raw.latest
		};
		return null;
	} catch {
		return null;
	}
}
/** 原子写缓存（tmp + rename）；失败静默（缓存只是优化，不是正确性依赖）。 */
function writeUpdateCache(path, latest, now) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({
			timestamp: now,
			latest
		})}\n`);
		renameSync(tmp, path);
	} catch {}
}
/** 缓存是否仍新鲜（age < TTL；时钟回拨到写入前视为新鲜）。 */
function isCacheFresh(cache, now, ttlMs = UPDATE_CACHE_TTL_MS) {
	return now - cache.timestamp < ttlMs;
}
/**
* 带缓存的 latest 获取：新鲜缓存直接用（零联网）；否则打 registry 并回写。
* 网络失败 → null（不回退旧值：旧值会让离线场景触发注定失败的安装尝试）。
*/
async function fetchLatestWithCache(input) {
	const cached = readUpdateCache(input.cachePath);
	if (cached !== null && isCacheFresh(cached, input.now)) return cached.latest;
	const fetched = await (input.fetchNet ?? fetchNpmLatest)();
	if (fetched !== null && fetched !== "") writeUpdateCache(input.cachePath, fetched, input.now);
	return fetched;
}
/**
* 按 profile 锁文件探测包管理器（安装历史的确定性证据）：
* pnpm-lock.yaml → pnpm；package-lock.json → npm；yarn.lock → yarn；
* node_modules/.package-lock.json（npm v7+ 隐藏锁文件）→ npm；
* 均无 → 默认 pnpm（历史行为；npm install 会重写 pnpm symlink 布局，更糟）。
*/
function detectPackageManager(profileDir) {
	if (existsSync(join(profileDir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(profileDir, "package-lock.json"))) return "npm";
	if (existsSync(join(profileDir, "yarn.lock"))) return "yarn";
	if (existsSync(join(profileDir, "node_modules", ".package-lock.json"))) return "npm";
	return "pnpm";
}
/** 包管理器 → 安装调用。win32 经 cmd.exe /d /c 派发（.cmd 不能不经 shell 启动，
*  DEP0190 约束保持：shell:false + args 数组）。 */
function installCommandFor(pm, latest) {
	const spec = `${TUI_PACKAGE}@${latest}`;
	const sub = pm === "npm" ? "install" : "add";
	const label = `${pm} ${sub}`;
	return process.platform === "win32" ? {
		command: process.env.ComSpec ?? "cmd.exe",
		args: [
			"/d",
			"/c",
			pm,
			sub,
			spec
		],
		label
	} : {
		command: pm,
		args: [sub, spec],
		label
	};
}
function installNpmVersion(latest, profileDir, timeoutMs = 6e4) {
	const { command, args, label } = installCommandFor(detectPackageManager(profileDir), latest);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: profileDir,
			stdio: "ignore",
			windowsHide: true
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error(`${label} timed out`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`${label} exited ${code ?? "null"}`));
		});
	});
}
/**
* 对照 npm latest；需要时在 profile 里安装。失败不抛（启动不能被更新拖死）。
*/
async function runSelfUpdate(opts = {}) {
	const env = opts.env ?? process.env;
	const startDir = opts.startDir ?? process.cwd();
	const profileDir = opts.profileDir ?? findProfileDir(startDir);
	const currentVersion = opts.currentVersion ?? readOwnVersion(startDir) ?? "";
	const installSpec = opts.installSpec ?? (profileDir === void 0 ? void 0 : readInstallSpec(profileDir));
	try {
		const plan = planSelfUpdate({
			env,
			currentVersion,
			profileDir,
			installSpec,
			latest: opts.fetchLatest !== void 0 ? await opts.fetchLatest() : await fetchLatestWithCache({
				cachePath: opts.cachePath ?? defaultUpdateCachePath(),
				now: opts.now?.() ?? Date.now()
			})
		});
		if (plan.action === "skip") return { kind: "noop" };
		if (profileDir === void 0) return { kind: "noop" };
		await (opts.install ?? installNpmVersion)(plan.latest, profileDir);
		return {
			kind: "updated",
			version: plan.latest
		};
	} catch (err) {
		return {
			kind: "failed",
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function updateNoticeText(version) {
	return `插件已更新到 ${version}。输入 /changelog 查看本次更新内容；/restart 立即生效（或 Ctrl+Q 退出后重新启动 dsh）`;
}
/** 失败提示里的手动更新命令包名（app 侧文案引用）。 */
const updateNoticePackage = TUI_PACKAGE;
/** 更新后将自动重启（autoRestartOnUpdate）时的提示。 */
function autoRestartNoticeText(version) {
	return `插件已更新到 ${version}，正在自动重启…`;
}
/**
* 只查不装的更新检查（/update 命令数据源）。绕过 DSH_TUI_SKIP_UPDATE——
* 用户显式要求检查时不尊重"不想联网"开关；CI/vitest 环境防御性跳过
* （测试隔离靠 fetchNet 注入，此守卫只兜底误配置）。失败不抛（回显用）。
*/
async function checkForUpdate(opts = {}) {
	const env = opts.env ?? process.env;
	if (env.CI === "true" || env.CI === "1" || env.VITEST === "true") return {
		kind: "failed",
		error: "CI/测试环境跳过更新检查"
	};
	let current;
	try {
		const own = opts.currentVersion ?? readOwnVersion(process.cwd());
		if (own === void 0) return {
			kind: "failed",
			error: "无法读取本包版本"
		};
		current = own;
	} catch (err) {
		return {
			kind: "failed",
			error: err instanceof Error ? err.message : String(err)
		};
	}
	try {
		const latest = await fetchLatestWithCache({
			cachePath: opts.cachePath ?? defaultUpdateCachePath(),
			now: opts.now ?? Date.now(),
			...opts.fetchNet === void 0 ? {} : { fetchNet: opts.fetchNet }
		});
		if (latest === null) return {
			kind: "failed",
			error: "无法获取 npm latest（网络失败或注册表无响应）"
		};
		if (latest === current) return {
			kind: "current",
			current
		};
		return {
			kind: "latest",
			latest,
			current
		};
	} catch (err) {
		return {
			kind: "failed",
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
/**
* 解析 CHANGELOG.md：按 `## [version] - date` 标题切块（Keep a Changelog 风格）。
* 标题行以 `## [` 开头（`## [Unreleased]` 无日期也识别）；`#` 与空行归入当前块。
* @param text - CHANGELOG.md 全文。
* @returns 按文件顺序的条目数组；无版本块返回空数组。
*/
function parseChangelog(text) {
	const entries = [];
	let current = null;
	for (const line of text.split("\n")) {
		const m = /^## \[([^\]]+)\](?: - ([\d-]+))?$/.exec(line.trim());
		if (m !== null) {
			current = {
				version: m[1],
				date: m[2] ?? null,
				body: ""
			};
			entries.push(current);
			continue;
		}
		if (current !== null) current.body += `${line}\n`;
	}
	return entries;
}
/**
* 读本包 CHANGELOG.md（从 startDir 向上找包根；npm 包内与开发仓库均可命中）。
* @param startDir - 起始目录（import.meta.url 所在目录）。
* @returns 文件全文；缺失返回 null。
*/
function readOwnChangelog(startDir) {
	let dir = startDir;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "CHANGELOG.md");
		if (existsSync(candidate)) return readFileSync(candidate, "utf-8");
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
/**
* changelog 正文轻量简化（scrollback 纯文本展示）：markdown 链接收成文本、
* 粗体标记剥除、列表前缀保留。行内其余内容原样。
* @param body - 原始条目正文。
* @returns 简化后的正文（逐行）。
*/
function simplifyChangelogMarkdown(body) {
	const out = [];
	for (const line of body.split("\n")) {
		if (line.trim() === "") {
			out.push("");
			continue;
		}
		const stripped = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
		out.push(stripped);
	}
	return out;
}
//#endregion
//#region lib/types/restart.js
/**
* 进程重启原语：以与当前进程相同的命令行（process.argv）重新启动，
* 继承同一终端（stdio inherit）。供 /restart 命令与启动自更新后的
* 自动重启使用——TUI 是 dsh 宿主的插件，重启宿主进程 = 重放宿主 argv。
*
* POSIX 上 detached（子进程成为新会话 leader）：父进程退出时子进程
* 不会收到终端的 SIGHUP，也因脱离控制终端而不触发后台读 TTY 的
* SIGTTIN；继承的 TTY fd 仍可正常读写（raw mode 是终端设备属性）。
* Windows 上不用 detached（会另开控制台窗口），stdio 继承 +
* windowsHide 让子进程继续占用同一控制台。
*
* 注：本模块是 tui-runner 内部原语（index.ts 装配层使用），不是公共 API——
* 不提供 package exports 子路径，请勿按 @huiliyi37/dsh-tianshu-tui/restart 导入。
*/
/**
* 尝试以相同命令重启当前进程。
*
* resolve true = 新进程已成功启动（'spawn' 事件，exec 完成）——调用方
* 应随后退出当前进程，让新进程接管终端；resolve false = 无法启动
* （argv 无效 / spawn error 如 ENOENT）。不等待新进程退出——成功后
* unref，父进程随时可 exit。
*/
function spawnSelfRestart(options = {}) {
	const argv = options.argv ?? process.argv;
	if (argv.length < 2 || argv[0] === "") return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(argv[0], argv.slice(1), {
			stdio: "inherit",
			detached: process.platform !== "win32",
			windowsHide: true
		});
		child.once("spawn", () => {
			if (settled) return;
			settled = true;
			child.unref();
			resolve(true);
		});
		child.once("error", () => {
			if (settled) return;
			settled = true;
			resolve(false);
		});
	});
}
/** 全部内置主题调色板（名字 → 定义）；消费方经 theme.ts 的 buildTheme/THEMES 使用。 */
const THEME_PALETTES = {
	pastel: {
		background: "dark",
		description: "温和粉彩。二次元风格启发，高对比、低饱和度多色卡。",
		truecolor: {
			primary: "#a8e6cf",
			secondary: "#d4a5f5",
			success: "#d0f0a8",
			warning: "#ffe0a3",
			error: "#ff9aa2",
			dim: "#8585a0",
			pulseQuiet: "#4a4a5a",
			pulseActive: "#a8e6cf",
			pulseAlert: "#ff9aa2"
		},
		fallback: {
			primary: "cyan",
			secondary: "magenta",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		}
	},
	cyberpunk: {
		background: "dark",
		description: "赛博朋克。霓虹极高对比，酷炫亮眼。",
		truecolor: {
			primary: "#48c6e2",
			secondary: "#c4a3ff",
			success: "#4ade80",
			warning: "#fbbf24",
			error: "#e27585",
			dim: "#9494b8",
			pulseQuiet: "#2f3048",
			pulseActive: "#48c6e2",
			pulseAlert: "#e27585"
		},
		fallback: {
			primary: "cyan",
			secondary: "magenta",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		}
	},
	observatory: {
		background: "dark",
		description: "五色星辰。传统五行配色体系，天玑星君玄灰底色。",
		truecolor: {
			primary: "#7c78f2",
			secondary: "#a78bfa",
			success: "#34d399",
			warning: "#f59e0b",
			error: "#f87171",
			dim: "#8da0b8",
			pulseQuiet: "#334155",
			pulseActive: "#7c78f2",
			pulseAlert: "#f87171"
		},
		fallback: {
			primary: "blue",
			secondary: "magenta",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		}
	},
	midnight: {
		background: "dark",
		description: "GitHub 暗黑风格。极简中性灰度，高度清晰。",
		truecolor: {
			primary: "#58a6ff",
			secondary: "#b0b8c4",
			success: "#3fb950",
			warning: "#d29922",
			error: "#f85149",
			dim: "#8b949e",
			pulseQuiet: "#3d4450",
			pulseActive: "#58a6ff",
			pulseAlert: "#f85149"
		},
		overrides: {
			userColor: "#e6edf3",
			assistantColor: "#e6edf3"
		},
		fallback: {
			primary: "blue",
			secondary: "white",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "white",
			assistantColor: "white"
		}
	},
	starfield: {
		background: "dark",
		description: "星空星座。Rivet 原生星图美学，天蓝主星与星云紫辅色。",
		truecolor: {
			primary: "#8ab4ff",
			secondary: "#c9a9ff",
			success: "#7ee7c7",
			warning: "#ffd479",
			error: "#ff8a9b",
			dim: "#959dbe",
			pulseQuiet: "#2b3052",
			pulseActive: "#8ab4ff",
			pulseAlert: "#ff8a9b"
		},
		overrides: {
			userColor: "#e8ecf8",
			assistantColor: "#c9a9ff",
			muted: "#aab4d4"
		},
		fallback: {
			primary: "blue",
			secondary: "magenta",
			success: "cyan",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "white",
			assistantColor: "magenta"
		}
	},
	tianshu: {
		background: "dark",
		description: "玄夜墨色。95% 墨灰，配以星金主色与朱砂用户印，沉稳低调。",
		truecolor: {
			primary: "#dfb282",
			secondary: "#a49ac7",
			success: "#75a399",
			warning: "#d1914a",
			error: "#bd5f7a",
			dim: "#8a8fa0",
			pulseQuiet: "#3a3d4a",
			pulseActive: "#dfb282",
			pulseAlert: "#d86459",
			toolShell: "#a0a3b0",
			toolEdit: "#a49ac7"
		},
		overrides: {
			userColor: "#d86459",
			assistantColor: "#d2d5dd",
			muted: "#adb2bf",
			systemColor: "#adb2bf"
		},
		fallback: {
			primary: "yellowBright",
			secondary: "magenta",
			success: "cyan",
			warning: "yellow",
			error: "redBright",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "yellowBright",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "red",
			assistantColor: "white"
		}
	},
	claude: {
		background: "dark",
		description: "Claude Code 官方 TUI 经典调色盘移植。橘黄经典。",
		truecolor: {
			primary: "#d77757",
			secondary: "#af87ff",
			success: "#4eba65",
			warning: "#ffc107",
			error: "#ff6b80",
			dim: "#767676",
			pulseQuiet: "#888888",
			pulseActive: "#d77757",
			pulseAlert: "#ff6b80"
		},
		overrides: {
			userColor: "#d77757",
			assistantColor: "#d9d9d9",
			muted: "#999999"
		},
		fallback: {
			primary: "redBright",
			secondary: "magentaBright",
			success: "greenBright",
			warning: "yellowBright",
			error: "redBright",
			dim: "white",
			pulseQuiet: "white",
			pulseActive: "redBright",
			pulseAlert: "redBright"
		},
		fallbackOverrides: {
			userColor: "redBright",
			assistantColor: "white"
		}
	},
	ziwei: {
		background: "dark",
		description: "帝星紫微。朱砂红标记点缀帝星紫，富含中国星图古典美学韵味。",
		truecolor: {
			primary: "#c9b8ff",
			secondary: "#8ab4ff",
			success: "#7ee7c7",
			warning: "#ffd479",
			error: "#ff8a9b",
			dim: "#868ba8",
			pulseQuiet: "#3a3d4a",
			pulseActive: "#c9b8ff",
			pulseAlert: "#d4453a",
			toolShell: "#8ab4ff",
			toolEdit: "#c9b8ff",
			toolTest: "#7ee7c7",
			toolDelegate: "#ffd479"
		},
		overrides: {
			userColor: "#d4453a",
			assistantColor: "#c9b8ff",
			muted: "#9aa2b1"
		},
		fallback: {
			primary: "magenta",
			secondary: "blue",
			success: "cyan",
			warning: "yellow",
			error: "redBright",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "magenta",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "red",
			assistantColor: "magenta",
			muted: "white"
		}
	},
	slate: {
		background: "dark",
		description: "冷静板岩灰。单一冷静 Teal 主色，无彩色结构，低眩光长久不累。",
		truecolor: {
			primary: "#56b6c2",
			secondary: "#7aa2cf",
			success: "#7fb88a",
			warning: "#d6a35c",
			error: "#e08891",
			dim: "#848d9c",
			pulseQuiet: "#39414f",
			pulseActive: "#56b6c2",
			pulseAlert: "#e08891",
			toolShell: "#7aa2cf",
			toolEdit: "#6fb3ab",
			toolTest: "#7fb88a",
			toolDelegate: "#d6a35c"
		},
		overrides: {
			userColor: "#e2e6ec",
			assistantColor: "#c4c9d2",
			muted: "#8b93a3"
		},
		fallback: {
			primary: "cyan",
			secondary: "blue",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "white",
			assistantColor: "white",
			muted: "gray"
		}
	},
	dawn: {
		background: "dark",
		description: "启明星晨曦调。青蓝边框、暖金标题、雾灰正文，贴近 Tianshu 启动画面。",
		truecolor: {
			primary: "#58d6f5",
			secondary: "#d8a15c",
			success: "#7bbf98",
			warning: "#e5763a",
			error: "#e58e98",
			dim: "#8f9aaa",
			pulseQuiet: "#2b3340",
			pulseActive: "#58d6f5",
			pulseAlert: "#e58e98"
		},
		overrides: {
			userColor: "#ffb454",
			assistantColor: "#dce3ea",
			muted: "#8f9aaa",
			systemColor: "#8f9aaa"
		},
		fallback: {
			primary: "cyan",
			secondary: "yellow",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "yellowBright",
			assistantColor: "white",
			muted: "gray"
		}
	},
	antigravity: {
		background: "dark",
		description: "Codex 风格。天青色冷调 Accent，亮灰结构文本，现代而克制。",
		truecolor: {
			primary: "#5aa9ff",
			secondary: "#8ab4ff",
			success: "#43c463",
			warning: "#e0a93a",
			error: "#f76b6b",
			dim: "#9093a0",
			pulseQuiet: "#2a2a32",
			pulseActive: "#5aa9ff",
			pulseAlert: "#f76b6b",
			toolShell: "#7aa2cf",
			toolEdit: "#6fb3ab",
			toolTest: "#43c463",
			toolDelegate: "#e0a93a"
		},
		overrides: {
			userColor: "#d8e2ee",
			assistantColor: "#c4c9d2",
			muted: "#989aa6"
		},
		fallback: {
			primary: "blue",
			secondary: "cyan",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "cyanBright",
			assistantColor: "white",
			muted: "gray"
		}
	},
	cobalt: {
		background: "dark",
		description: "钴蓝·冷调中性 (默认风格)。oklch 调和，明度梯度清晰，视觉极度舒适。",
		truecolor: {
			primary: "#6ab8ff",
			secondary: "#7dacbf",
			success: "#58cbb4",
			warning: "#d4b44c",
			error: "#ed7665",
			dim: "#8693a0",
			pulseQuiet: "#30363d",
			pulseActive: "#6ab8ff",
			pulseAlert: "#ed7665",
			toolShell: "#5f97c5",
			toolEdit: "#65b9ca",
			toolTest: "#58cbb4",
			toolDelegate: "#d4b44c"
		},
		overrides: {
			userColor: "#fbbf24",
			assistantColor: "#c9cfd6",
			muted: "#9ca5b3"
		},
		fallback: {
			primary: "blue",
			secondary: "cyan",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "yellowBright",
			assistantColor: "white",
			muted: "gray"
		}
	},
	graphite: {
		background: "dark",
		description: "石墨冰青 (专业默认)。中性灰阶 + 单一冰青 accent，低饱和语义色，长时间编码不疲劳。",
		truecolor: {
			primary: "#7cc4e8",
			secondary: "#8b98ab",
			success: "#7fbf8e",
			warning: "#d9b36c",
			error: "#e07a6f",
			dim: "#828d9c",
			pulseQuiet: "#2f3540",
			pulseActive: "#7cc4e8",
			pulseAlert: "#e07a6f",
			toolShell: "#7ba7c9",
			toolEdit: "#8b98ab",
			toolTest: "#7fbf8e",
			toolDelegate: "#d9b36c"
		},
		overrides: {
			userColor: "#e0aa53",
			assistantColor: "#c8cdd6",
			muted: "#9aa4b0",
			systemColor: "#8b95a1"
		},
		fallback: {
			primary: "cyan",
			secondary: "blue",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "cyan",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "yellowBright",
			assistantColor: "white",
			muted: "gray"
		}
	},
	gemini: {
		background: "dark",
		description: "Gemini 风格。结合星云微光渐变 (冷靛蓝与星云紫) 与极光薄荷，极具科技美感。",
		truecolor: {
			primary: "#818cf8",
			secondary: "#c084fc",
			success: "#34d399",
			warning: "#fbbf24",
			error: "#f43f5e",
			dim: "#8b8ea9",
			pulseQuiet: "#2a2b3d",
			pulseActive: "#818cf8",
			pulseAlert: "#f43f5e",
			toolShell: "#7dd3fc",
			toolEdit: "#c084fc",
			toolTest: "#34d399",
			toolDelegate: "#fbbf24"
		},
		overrides: {
			userColor: "#e0e7ff",
			assistantColor: "#c4c9d2",
			muted: "#9497a6"
		},
		fallback: {
			primary: "blueBright",
			secondary: "magentaBright",
			success: "cyanBright",
			warning: "yellowBright",
			error: "redBright",
			dim: "gray",
			pulseQuiet: "gray",
			pulseActive: "blueBright",
			pulseAlert: "redBright"
		},
		fallbackOverrides: {
			userColor: "white",
			assistantColor: "white",
			muted: "gray"
		}
	},
	paper: {
		background: "light",
		description: "纸白亮色。面向白底/浅色终端，全语义色加深降亮，靛蓝 accent。",
		truecolor: {
			primary: "#1d4ed8",
			secondary: "#0e7490",
			success: "#15803d",
			warning: "#a16207",
			error: "#b91c1c",
			dim: "#6b7280",
			pulseQuiet: "#d1d5db",
			pulseActive: "#1d4ed8",
			pulseAlert: "#b91c1c",
			toolShell: "#1e6091",
			toolEdit: "#0e7490",
			toolTest: "#15803d",
			toolDelegate: "#a16207"
		},
		overrides: {
			userColor: "#1f2937",
			assistantColor: "#374151",
			muted: "#4b5563",
			systemColor: "#4b5563"
		},
		fallback: {
			primary: "blue",
			secondary: "cyan",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "black",
			pulseQuiet: "black",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "black",
			assistantColor: "black",
			muted: "black"
		}
	},
	"light-ansi": {
		background: "light",
		description: "亮色 ANSI。16 色纯净版，跟随终端自身配色方案，亮背景友好。",
		truecolor: {
			primary: "#0550ae",
			secondary: "#8250df",
			success: "#116329",
			warning: "#7d4e00",
			error: "#a40e26",
			dim: "#57606a",
			pulseQuiet: "#d0d7de",
			pulseActive: "#0550ae",
			pulseAlert: "#a40e26"
		},
		overrides: {
			userColor: "#24292f",
			assistantColor: "#24292f",
			muted: "#57606a",
			systemColor: "#57606a"
		},
		fallback: {
			primary: "blue",
			secondary: "magenta",
			success: "green",
			warning: "yellow",
			error: "red",
			dim: "black",
			pulseQuiet: "black",
			pulseActive: "blue",
			pulseAlert: "red"
		},
		fallbackOverrides: {
			userColor: "black",
			assistantColor: "black",
			muted: "black"
		}
	}
};
//#endregion
//#region lib/types/theme.js
/**
* 主题系统 — 语义 token 解析层。
*
* 两段式架构（2026-07 重构）：
* - theme-palettes.ts: 调色板定义（语义 token → 颜色值 + background/description 元数据）
* - theme.ts（本文件）: palette → RivetTheme 解析、主题切换、自定义主题注册表
*
* 颜色深度分档（渲染端 ansi.ts 消化）：
* - level >= 2: truecolor 轨（hex；level 2 由 fg() 现场量化为 xterm-256）
* - level <= 1: fallback 轨（chalk 命名色 → 基础 16 色 SGR）
*
* 自定义主题：~/.rivet/themes/*.json 经 theme-custom.ts 加载后注册到本模块，
* 以 `custom:<name>` 引用。语义 token 局部覆盖，缺省继承 base 主题。
*/
/** 内置主题名列表（非空元组，供 /theme 补全与 config schema 枚举）。 */
const THEME_NAMES = Object.keys(THEME_PALETTES);
function makeToolColor(c) {
	return (name) => {
		switch (name) {
			case "bash":
			case "grep":
			case "glob":
			case "read_file":
			case "read_section":
			case "read_policy":
			case "semantic_search":
			case "repo_map":
			case "repo_graph":
			case "inspect_project":
			case "related_tests":
			case "file_info":
			case "ls": return c.toolShell ?? c.primary;
			case "edit_file":
			case "write_file":
			case "hash_edit":
			case "apply_patch": return c.toolEdit ?? c.secondary;
			case "run_tests": return c.toolTest ?? c.success;
			case "delegate_task":
			case "delegate_batch": return c.toolDelegate ?? c.warning;
			default: return c.toolShell ?? c.dim;
		}
	};
}
function makeContextColor(c) {
	return (pct) => {
		if (pct >= .88) return c.error;
		if (pct >= .75) return c.warning;
		return c.dim;
	};
}
function buildTheme(colors, overrides, auxiliaryDefault = "#9aa2b1") {
	return {
		...colors,
		muted: overrides?.muted ?? auxiliaryDefault,
		userColor: overrides?.userColor ?? colors.primary,
		assistantColor: overrides?.assistantColor ?? colors.secondary,
		systemColor: overrides?.systemColor ?? auxiliaryDefault,
		brandColor: overrides?.brandColor ?? colors.primary,
		toolColor: makeToolColor(colors),
		contextColor: makeContextColor(colors)
	};
}
function buildEntry(def) {
	return {
		truecolor: buildTheme(def.truecolor, def.overrides),
		fallback: buildTheme(def.fallback, def.fallbackOverrides, def.fallback.dim),
		background: def.background,
		description: def.description
	};
}
/** 全部内置主题（palette 定义解析为双轨 ThemeEntry）。 */
const THEMES = Object.fromEntries(Object.entries(THEME_PALETTES).map(([name, def]) => [name, buildEntry(def)]));
const customThemes = /* @__PURE__ */ new Map();
/**
* 注册自定义主题（不含 `custom:` 前缀的裸名）。覆盖同名旧注册。
* @param name - 裸名（引用时加 `custom:` 前缀）。
* @param input - 主题输入（未知 base 名回退按 background 选默认）。
*/
function registerCustomTheme(name, input) {
	const background = input.background ?? "dark";
	const baseName = input.base && input.base in THEME_PALETTES ? input.base : background === "light" ? "paper" : "cobalt";
	const baseDef = THEME_PALETTES[baseName];
	const colors = {
		...baseDef.truecolor,
		...input.colors
	};
	const overrides = {
		...baseDef.overrides,
		...input.overrides
	};
	customThemes.set(name, {
		truecolor: buildTheme(colors, overrides),
		fallback: buildTheme(baseDef.fallback, baseDef.fallbackOverrides, baseDef.fallback.dim),
		background,
		description: input.description ?? `Custom theme (base: ${baseName})`
	});
}
/**
* 已注册的自定义主题裸名列表（不含 `custom:` 前缀）。
* @returns 裸名数组（注册顺序）。
*/
function listCustomThemes() {
	return [...customThemes.keys()];
}
/** 清空自定义主题注册表（测试用）。 */
function clearCustomThemes() {
	customThemes.clear();
}
/**
* 解析主题条目：内置名或 `custom:<name>`。未知名返回 undefined。
* @param name - 主题引用名。
* @returns 主题条目；未知名返回 undefined。
*/
function resolveThemeEntry(name) {
	if (name.startsWith("custom:")) return customThemes.get(name.slice(7));
	return THEMES[name];
}
let activeTheme = "graphite";
/**
* 切换主题。接受内置名或 `custom:<name>`；未知名 no-op 并返回 false。
* @param name - 主题引用名。
* @returns 是否切换成功。
*/
function setTheme(name) {
	if (!resolveThemeEntry(name)) return false;
	activeTheme = name;
	return true;
}
/**
* 当前激活的主题引用名（内置名或 `custom:<name>`）。
* @returns 主题引用名。
*/
function getActiveThemeName() {
	return activeTheme;
}
/**
* 当前主题面向的终端背景。
* @returns 背景明暗（激活主题不可解析时落 'dark'）。
*/
function getActiveThemeBackground() {
	return resolveThemeEntry(activeTheme)?.background ?? "dark";
}
/**
* 当前激活主题按色深分档解析：level >= 2 走 truecolor 轨，否则 fallback 轨。
* @param colorLevel - 颜色能力等级（缺省 chalk.level）。
* @returns 解析后的主题（激活名不可解析时落 cobalt）。
*/
function getTheme(colorLevel) {
	const level = colorLevel ?? chalk.level;
	const entry = resolveThemeEntry(activeTheme) ?? THEMES.cobalt;
	return level >= 2 ? entry.truecolor : entry.fallback;
}
//#endregion
//#region lib/types/engine/ansi.js
/**
* T9 ANSI 转义序列工具库。
*
* 提供两个层次的 API：
* 1. 原始转义序列常量 — 直接拼接到输出字符串中
* 2. 类型安全的构建器函数 — 防止参数注入
*
* 参照：ECMA-48 / ISO 6429 标准，VT100/VT220 兼容。
*/
/** ANSI 转义序列原始常量。直接用模板字面量拼接到输出字符串。 */
const ANSI = {
	/** 保存当前光标位置 */
	SAVE_CURSOR: "\x1B[s",
	/** 恢复之前保存的光标位置 */
	RESTORE_CURSOR: "\x1B[u",
	/** 从光标处擦除到行尾 (Erase to End of Line) */
	ERASE_LINE_END: "\x1B[0K",
	/** 擦除整行 (Erase Entire Line) */
	ERASE_LINE: "\x1B[2K",
	/** 从光标处擦除到屏幕末尾 (Erase to End of Screen) */
	ERASE_SCREEN_END: "\x1B[0J",
	/** 擦除整个屏幕 (Erase Entire Screen) */
	ERASE_SCREEN: "\x1B[2J",
	/** 进入 alternate screen buffer（全屏 overlay 用） */
	ALT_SCREEN_ON: "\x1B[?1049h",
	/** 退出 alternate screen buffer，恢复主屏 */
	ALT_SCREEN_OFF: "\x1B[?1049l",
	/**
	* 开始同步输出（CSI 2026 / DECSET 2026）。
	* 终端会缓冲后续输出，直到 END_SYNC 才一次性原子刷新 → 防止增量重绘撕裂/闪烁。
	* 不支持的终端会静默忽略此私有模式（无副作用）。
	*/
	BEGIN_SYNC: "\x1B[?2026h",
	/** 结束同步输出，原子刷新本帧。 */
	END_SYNC: "\x1B[?2026l",
	/** 启用 bracketed paste（DECSET 2004：粘贴文本被 200~/201~ 包裹，
	不触发按键） */
	BRACKETED_PASTE_ON: "\x1B[?2004h",
	/** 关闭 bracketed paste（退出时恢复终端默认） */
	BRACKETED_PASTE_OFF: "\x1B[?2004l",
	/** 隐藏光标 */
	HIDE_CURSOR: "\x1B[?25l",
	/** 显示光标 */
	SHOW_CURSOR: "\x1B[?25h",
	/**
	* DECSCUSR：光标形状设为稳态竖条（不闪）。
	* 终端原生光标闪烁会叠加在应用自管的 DECTCEM 翻转上，导致闪烁频率不稳、
	* 静止光标也在闪——输入类 overlay 激活期间统一切到稳态竖条，
	* 闪烁节奏完全由应用控制。竖条画在字符格左缘，天然落在格子边界上。
	*/
	CURSOR_STEADY_BAR: "\x1B[6 q",
	/** DECSCUSR：光标形状恢复终端默认（退出 overlay 时写）。 */
	CURSOR_SHAPE_DEFAULT: "\x1B[0 q",
	/** 重置所有 SGR 属性 */
	RESET: "\x1B[0m",
	/** 粗体 */
	BOLD: "\x1B[1m",
	/** 细体/暗色 */
	DIM: "\x1B[2m",
	/** 斜体 */
	ITALIC: "\x1B[3m",
	/** 下划线 */
	UNDERLINE: "\x1B[4m",
	/** 闪烁（慢） */
	BLINK: "\x1B[5m",
	/** 反色 */
	REVERSE: "\x1B[7m",
	/** 删除线 */
	STRIKETHROUGH: "\x1B[9m"
};
/**
* 将光标向上移动 n 行。
* @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
* @returns CUU 转义序列
*/
function cursorUp(n) {
	return `\x1B[${Math.max(1, Math.floor(n))}A`;
}
/**
* 将光标向下移动 n 行。
* @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
* @returns CUD 转义序列
*/
function cursorDown(n) {
	return `\x1B[${Math.max(1, Math.floor(n))}B`;
}
/**
* 将光标向右移动 n 列。
* @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
* @returns CUF 转义序列
*/
function cursorForward(n) {
	return `\x1B[${Math.max(1, Math.floor(n))}C`;
}
/**
* 将光标向左移动 n 列。
* @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
* @returns CUB 转义序列
*/
function cursorBack(n) {
	return `\x1B[${Math.max(1, Math.floor(n))}D`;
}
/**
* 移动光标到绝对位置 (row, col)。1-based。
* @param row - 目标行（1-based）；非正/非整数值被钳到 ≥1 的整数
* @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
* @returns CUP 转义序列
*/
function cursorTo(row, col) {
	return `\x1B[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(col))}H`;
}
/**
* 移动光标到第 col 列（保持当前行）。1-based。
* @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
* @returns CHA 转义序列
*/
function cursorToCol(col) {
	return `\x1B[${Math.max(1, Math.floor(col))}G`;
}
/**
* hex 颜色字符串 → RGB 元组。
* 支持 `#rgb`、`#rrggbb` 格式。无法解析时（含 chalk 命名色）返回 null——
* 调用方以此区分 truecolor 轨主题 token 与 16 色轨命名色（shimmer 降级判定）。
* @param hex - hex 颜色字符串（`#rgb` / `#rrggbb`）。
* @returns `[r, g, b]`（0-255）；无法解析时 null。
*/
function hexToRgb(hex) {
	const match = hex.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!match) return null;
	const h = match[1];
	/* v8 ignore next -- 正则 ^#(...)$ 匹配成功时捕获组必存在；noUncheckedIndexedAccess 收窄防御 */
	if (h === void 0) return null;
	if (h.length === 3) {
		/* v8 ignore next -- h.length === 3 时下标 0/1/2 恒存在；noUncheckedIndexedAccess 收窄防御 */
		const r = h[0] ?? "", g = h[1] ?? "", b = h[2] ?? "";
		return [
			parseInt(r + r, 16),
			parseInt(g + g, 16),
			parseInt(b + b, 16)
		];
	}
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16)
	];
}
/**
* chalk 命名色 → 基础 16 色 SGR 前景码。
* fallback 主题轨（theme-palettes.ts）用命名色表达 16 色语义；此前 fg() 只认
* hex，命名色被静默丢弃成无色 —— 现在映射为标准 30-37/90-97。
*/
const NAMED_FG_CODES = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	gray: 90,
	grey: 90,
	blackBright: 90,
	redBright: 91,
	greenBright: 92,
	yellowBright: 93,
	blueBright: 94,
	magentaBright: 95,
	cyanBright: 96,
	whiteBright: 97
};
/**
* RGB → xterm-256 最近邻索引（256 色中间档量化）。
* 候选双轨取最优：6×6×6 色立方（16-231，分量档 0/95/135/175/215/255）
* 与 24 级灰阶（232-255，8+10i）。距离用 RGB 欧氏平方（对量化到 256 档足够）。
* @param r - 红色分量（0-255）
* @param g - 绿色分量（0-255）
* @param b - 蓝色分量（0-255）
* @returns xterm-256 调色板索引（16-255）
*/
function rgbToXterm256(r, g, b) {
	const toCubeIdx = (v) => {
		if (v < 48) return 0;
		if (v < 115) return 1;
		return Math.min(5, Math.floor((v - 35) / 40));
	};
	const CUBE = [
		0,
		95,
		135,
		175,
		215,
		255
	];
	const ci = toCubeIdx(r), gi = toCubeIdx(g), bi = toCubeIdx(b);
	/* v8 ignore next -- toCubeIdx 返回 0..5 恒在 CUBE（长 6）界内；noUncheckedIndexedAccess 收窄防御 */
	const cr = CUBE[ci] ?? 0, cg = CUBE[gi] ?? 0, cb = CUBE[bi] ?? 0;
	const cubeDist = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
	const gray = Math.round((r + g + b) / 3);
	const gi24 = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)));
	const gv = 8 + 10 * gi24;
	return (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2 < cubeDist ? 232 + gi24 : 16 + 36 * ci + 6 * gi + bi;
}
/** 当前是否应量化到 256 色（chalk 检测到 256 色但非 truecolor 终端）。 */
function use256() {
	return chalk.level === 2;
}
/** 标准 ANSI16 调色板 RGB（与 NAMED_FG_CODES 码序一致：30-37、90-97）。 */
const ANSI16_RGB = [
	[
		0,
		0,
		0
	],
	[
		205,
		0,
		0
	],
	[
		0,
		205,
		0
	],
	[
		205,
		205,
		0
	],
	[
		0,
		0,
		238
	],
	[
		205,
		0,
		205
	],
	[
		0,
		205,
		205
	],
	[
		229,
		229,
		229
	],
	[
		127,
		127,
		127
	],
	[
		255,
		0,
		0
	],
	[
		0,
		255,
		0
	],
	[
		255,
		255,
		0
	],
	[
		92,
		92,
		255
	],
	[
		255,
		0,
		255
	],
	[
		0,
		255,
		255
	],
	[
		255,
		255,
		255
	]
];
/** 码序 → chalk 命名色（与 NAMED_FG_CODES 互逆）。 */
const ANSI16_NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"blackBright",
	"redBright",
	"greenBright",
	"yellowBright",
	"blueBright",
	"magentaBright",
	"cyanBright",
	"whiteBright"
];
/**
* RGB → 最近 ANSI16 chalk 命名色（2:4:3 感知加权；16 色档像素画近似用，
* 调色板变更无需手维护近似表——whale-star level 1 轨）。
* @param r - 红色分量（0-255）
* @param g - 绿色分量（0-255）
* @param b - 蓝色分量（0-255）
* @returns chalk 命名色（NAMED_FG_CODES 覆盖的 16 色之一）
*/
function rgbToAnsi16Name(r, g, b) {
	let best = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < ANSI16_RGB.length; i++) {
		/* v8 ignore next -- 常量表长 16，下标 0..15 恒在界内；noUncheckedIndexedAccess 收窄防御 */
		const c = ANSI16_RGB[i] ?? [
			0,
			0,
			0
		];
		const d = 2 * (r - c[0]) ** 2 + 4 * (g - c[1]) ** 2 + 3 * (b - c[2]) ** 2;
		if (d < bestDist) {
			best = i;
			bestDist = d;
		}
	}
	/* v8 ignore next -- 常量表长 16，best ∈ 0..15 恒在界内 */
	return ANSI16_NAMES[best] ?? "white";
}
/** 纯函数：给定 env 是否请求无色（便于测试注入）。 */
function noColorRequested(env = process.env) {
	const v = env.NO_COLOR;
	return v !== void 0 && v !== "";
}
let colorSuppressed = noColorRequested();
/* v8 ignore next -- 测试环境不设 NO_COLOR；生产设了才走本行 */
if (colorSuppressed) chalk.level = 0;
/**
* 测试/显式覆写无色开关（只翻本模块旗标；不回改 chalk.level——生产路径由
* 模块加载时的初始化统一压制）。测试用后应复原。
*/
function setColorSuppressed(v) {
	colorSuppressed = v;
}
/** 当前是否压制颜色输出（NO_COLOR 已显式请求时 fg/bg 输出空串）。 */
function isColorSuppressed() {
	return colorSuppressed;
}
/**
* 设置前景色。接受 hex（`#a8e6cf`）或 chalk 命名色（`cyan`/`redBright`）。
* hex 在 truecolor 终端发 38;2，在 256 色终端（chalk.level === 2）量化为 38;5；
* 命名色发基础 16 色码。无法解析时返回 ''（无着色）。NO_COLOR 请求时恒返回 ''。
* @param colorValue - hex 颜色字符串或 chalk 命名色
* @returns SGR 前景色序列；无法解析或无色模式时为空字符串
*/
function fg(colorValue) {
	if (colorSuppressed) return "";
	const rgb = hexToRgb(colorValue);
	if (!rgb) {
		const code = NAMED_FG_CODES[colorValue];
		return code === void 0 ? "" : `\x1B[${code}m`;
	}
	if (use256()) return `\x1B[38;5;${rgbToXterm256(rgb[0], rgb[1], rgb[2])}m`;
	return `\x1B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
/**
* 设置背景色。接受 hex 或 chalk 命名色（命名色码 +10 为背景码）。
* 降级规则同 fg()。
* @param colorValue - hex 颜色字符串或 chalk 命名色
* @returns SGR 背景色序列；无法解析时为空字符串
*/
function bg(colorValue) {
	if (colorSuppressed) return "";
	const rgb = hexToRgb(colorValue);
	if (!rgb) {
		const code = NAMED_FG_CODES[colorValue];
		return code === void 0 ? "" : `\x1B[${code + 10}m`;
	}
	if (use256()) return `\x1B[48;5;${rgbToXterm256(rgb[0], rgb[1], rgb[2])}m`;
	return `\x1B[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
/**
* 用 ANSI 前景色 + 可选 SGR 属性包裹文本。
* 始终以 ANSI.RESET 结尾，防止颜色泄露。
* @param text - 要着色的文本
* @param fgHex - 前景色（hex 或 chalk 命名色，同 fg()）
* @param opts - 可选 SGR 属性（bold/dim/italic/underline）
* @returns 着色后的字符串（末尾带 RESET）
*/
function color(text, fgHex, opts) {
	let prefix = fg(fgHex);
	if (opts?.bold) prefix += ANSI.BOLD;
	if (opts?.dim) prefix += ANSI.DIM;
	if (opts?.italic) prefix += ANSI.ITALIC;
	if (opts?.underline) prefix += ANSI.UNDERLINE;
	return `${prefix}${text}${ANSI.RESET}`;
}
/**
* OSC 52 写系统剪贴板（终端支持时；不支持者无害忽略——内部剪贴板 Alt+Y 兜底）。
* 剪贴选区/复制后由 app 在渲染循环 drain 写出。
* @param text - 要写入剪贴板的文本（内部 base64 编码，控制字符无注入风险）
* @returns OSC 52 转义序列
*/
function osc52Clipboard(text) {
	return `\x1B]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}
let hyperlinkOverride = null;
/**
* 测试/配置钩子：强制开/关超链接（null 恢复自动检测）。
* @param value - true 强制开、false 强制关、null 恢复自动检测
*/
function setHyperlinksEnabled(value) {
	hyperlinkOverride = value;
}
/**
* OSC 8 支持启发式检测。终端无标准能力查询协议，按主流终端约定判断：
* - 环境开关优先：`RIVET_HYPERLINKS=0/1`、`FORCE_HYPERLINK`
* - 已知支持的 TERM_PROGRAM：iTerm2 / WezTerm / VS Code / Hyper / ghostty / Tabby
* - kitty（TERM 前缀）、VTE ≥ 0.50（GNOME Terminal 系）、Windows Terminal（WT_SESSION）
* - tmux/screen 与 dumb 终端保守降级（tmux 需 passthrough 配置，默认关闭）
* @param env - 参与检测的环境变量集合（默认 process.env，可注入用于测试）
* @returns 终端是否支持 OSC 8 超链接
*/
function detectHyperlinkSupport(env = process.env) {
	if (env.RIVET_HYPERLINKS === "0") return false;
	if (env.RIVET_HYPERLINKS === "1" || env.FORCE_HYPERLINK) return true;
	const term = env.TERM ?? "";
	if (term === "dumb" || !process.stdout.isTTY) return false;
	if (env.TMUX || term.startsWith("screen")) return false;
	const program = env.TERM_PROGRAM ?? "";
	if ([
		"iTerm.app",
		"WezTerm",
		"vscode",
		"Hyper",
		"ghostty",
		"Tabby"
	].includes(program)) return true;
	if (term.startsWith("xterm-kitty")) return true;
	if (env.WT_SESSION) return true;
	const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
	if (Number.isFinite(vte) && vte >= 5e3) return true;
	return false;
}
let detectedSupport = null;
function hyperlinksSupported() {
	if (hyperlinkOverride !== null) return hyperlinkOverride;
	if (detectedSupport === null) detectedSupport = detectHyperlinkSupport();
	return detectedSupport;
}
/**
* 把文本包装为 OSC 8 可点击超链接；不支持的终端返回纯文本（零污染降级）。
* url 中的控制字符会被剥离（OSC 序列注入防护）。
* @param text - 链接显示文本
* @param url - 链接目标；控制字符剥离后为空时返回纯文本
* @returns OSC 8 序列包裹的文本，或降级后的纯文本
*/
function hyperlink(text, url) {
	if (!hyperlinksSupported()) return text;
	const safeUrl = url.replace(/[\x00-\x1F\x7F]/g, "");
	if (!safeUrl) return text;
	return `\x1B]8;;${safeUrl}\x07${text}\x1B]8;;\x07`;
}
/**
* 文件路径 → file:// 超链接（相对路径基于 cwd 归一为绝对路径）。
* @param text - 链接显示文本
* @param filePath - 文件路径（绝对或相对）
* @param cwd - 相对路径的基准目录（默认 process.cwd()）
* @returns OSC 8 file:// 超链接，或降级后的纯文本
*/
function fileLink(text, filePath, cwd = process.cwd()) {
	return hyperlink(text, `file://${filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`}`);
}
let imageProtocolOverride = null;
/**
* 测试/配置钩子：强制指定图片协议（null 恢复自动检测）。
* @param value - 强制使用的协议；null 恢复自动检测
*/
function setImageProtocol(value) {
	imageProtocolOverride = value;
}
/**
* 内联图片协议启发式检测，与 detectHyperlinkSupport 同构：
* - 环境开关优先：`RIVET_IMAGES=0/off` 关闭，`kitty`/`iterm2` 强制指定
* - kitty 协议：kitty（TERM 前缀）、ghostty、WezTerm、Warp、Konsole
* - iTerm2 协议：iTerm.app
* - tmux/screen 与 dumb 终端保守降级（图形序列需 passthrough，默认关闭）
* @param env - 参与检测的环境变量集合（默认 process.env，可注入用于测试）
* @param isTTY - stdout 是否为 TTY（缺省取 process.stdout.isTTY）
* @returns 检测到的图片协议；不支持时为 'none'
*/
function detectImageProtocol(env = process.env, isTTY = process.stdout.isTTY) {
	const override = env.RIVET_IMAGES?.toLowerCase();
	if (override === "0" || override === "off" || override === "none") return "none";
	if (override === "kitty" || override === "iterm2") return override;
	const term = env.TERM ?? "";
	if (term === "dumb" || !isTTY) return "none";
	if (env.TMUX || term.startsWith("screen")) return "none";
	const program = env.TERM_PROGRAM ?? "";
	if (program === "iTerm.app") return "iterm2";
	if (term.startsWith("xterm-kitty")) return "kitty";
	if ([
		"ghostty",
		"WezTerm",
		"WarpTerminal",
		"konsole"
	].includes(program)) return "kitty";
	if (env.KONSOLE_VERSION) return "kitty";
	return "none";
}
let detectedImageProtocol = null;
/**
* 当前生效的图片协议（带缓存 + override 钩子）。
* @returns override 优先，否则首次调用时检测并缓存的协议
*/
function imageProtocol() {
	if (imageProtocolOverride !== null) return imageProtocolOverride;
	if (detectedImageProtocol === null) detectedImageProtocol = detectImageProtocol();
	return detectedImageProtocol;
}
/** 查询光标位置。终端会通过 stdin 返回 `\x1B[row;colR`。 */
const QUERY_CURSOR_POS = "\x1B[6n";
/** 查询终端尺寸（备用方案）。某些终端不支持 stdout.columns。 */
const QUERY_TERMINAL_SIZE = "\x1B[18t";
/** 名义背景（覆盖常见终端深浅背景的典型值）。 */
/** 名义背景（对应主题声明 background 档位的代表值）。 */
const NOMINAL_BG = {
	dark: "#202124",
	light: "#fafafa"
};
/** sRGB 通道线性化（WCAG 2.x 公式）。 */
function linearizeChannel(v) {
	const s = v / 255;
	return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
}
/**
* hex 颜色的 WCAG 相对亮度（0 近黑 ~ 1 近白）。
* @param hex - `#rgb` / `#rrggbb`；无法解析返回 null。
*/
function relativeLuminance(hex) {
	const rgb = hexToRgb(hex);
	if (rgb === null) return null;
	return .2126 * linearizeChannel(rgb[0]) + .7152 * linearizeChannel(rgb[1]) + .0722 * linearizeChannel(rgb[2]);
}
/**
* 两色对比度比（1.0 同色 ~ 21.0 黑白）；任一色无法解析返回 null。
*/
function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	if (la === null || lb === null) return null;
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + .05) / (lo + .05);
}
/**
* 校验前景色集合对主题声明背景的可读性。自定义主题只覆盖前景 token，真实
* 终端背景未知，因此用声明档位的名义背景近似；< 3.0（WCAG AA 大文本）判低对比。
* 非 hex 值（chalk 命名色等）跳过——16 色轨语义由内置主题维护，不在此校验。
* @param colors - token → 颜色值。
* @param declaredBg - 主题声明的背景档位（缺省 dark）。
* @returns 问题列表（保持输入键序；全部可读时为空）。
*/
function validateThemeContrast(colors, declaredBg = "dark") {
	const nominal = NOMINAL_BG[declaredBg];
	const issues = [];
	for (const [token, value] of Object.entries(colors)) {
		if (!value.startsWith("#")) continue;
		const ratio = contrastRatio(value, nominal);
		if (ratio === null) continue;
		if (ratio < 3) issues.push({
			token,
			value,
			ratio
		});
	}
	return issues;
}
//#endregion
//#region lib/types/theme-custom.js
/**
* 用户自定义主题加载 — `~/.dsh-tui/themes/*.json`。
*
* 文件格式（语义 token 局部覆盖，缺省继承 base 主题）：
* ```json
* {
*   "base": "cobalt",
*   "background": "dark",
*   "description": "My theme",
*   "colors": { "primary": "#ff8800", "toolEdit": "#88ccff" },
*   "overrides": { "userColor": "#ffffff" }
* }
* ```
* 文件名（去 .json）即主题名，引用方式 `custom:<name>`。
* 单个文件解析失败只跳过该文件（警告走 onWarning 回调/stderr 出口），不影响其他主题与启动。
*/
/** 默认自定义主题根目录（`~/.dsh-tui`；源 `rivetHome()` 为天枢路径，移植时改为本包路径）。 */
function defaultThemesRoot() {
	return join(homedir(), ".dsh-tui");
}
/**
* 自定义主题目录。
* @param base - 根目录（测试注入）；缺省 `~/.dsh-tui`。
* @returns `<base>/themes` 路径。
*/
function customThemesDir(base) {
	return join(base ?? defaultThemesRoot(), "themes");
}
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const COLOR_KEYS = [
	"primary",
	"secondary",
	"success",
	"warning",
	"error",
	"dim",
	"pulseQuiet",
	"pulseActive",
	"pulseAlert",
	"toolShell",
	"toolEdit",
	"toolTest",
	"toolDelegate"
];
const OVERRIDE_KEYS = [
	"userColor",
	"assistantColor",
	"muted",
	"systemColor"
];
function pickHexFields(raw, keys) {
	const out = {};
	if (typeof raw !== "object" || raw === null) return out;
	for (const key of keys) {
		const v = raw[key];
		if (typeof v === "string" && HEX_RE.test(v)) out[key] = v;
	}
	return out;
}
/**
* 解析单个自定义主题 JSON → CustomThemeInput。结构非法返回 null。
* @param text - 主题文件的原始 JSON 文本。
* @returns 过滤掉非法字段后的主题输入；JSON 或顶层结构非法时为 null。
*/
function parseCustomThemeJson(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw;
	const input = {};
	if (typeof obj.base === "string" && obj.base in THEME_PALETTES) input.base = obj.base;
	if (obj.background === "dark" || obj.background === "light") input.background = obj.background;
	if (typeof obj.description === "string") input.description = obj.description;
	input.colors = pickHexFields(obj.colors, COLOR_KEYS);
	input.overrides = pickHexFields(obj.overrides, OVERRIDE_KEYS);
	return input;
}
/** 主题名合法性：字母数字、连字符、下划线（避免 `custom:` 引用歧义/路径注入）。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
/**
* 扫描并注册全部自定义主题。返回成功注册的裸名列表。
* 目录不存在 → 空列表（不是错误）。
* 解析失败/低对比警告：onWarning 注入时路由给回调（TUI 装配收集后落 scrollback），
* 缺省写 process.stderr（pre-TUI / 独立调用保持可见）。
* @param baseDir - 根目录（测试注入）；缺省 `~/.dsh-tui`。
* @param onWarning - 警告收集回调；缺省写 stderr（`[theme] ` 前缀，对齐历史文案）。
* @returns 成功注册的主题裸名（不含 `custom:` 前缀）。
*/
function loadCustomThemes(baseDir, onWarning) {
	const dir = customThemesDir(baseDir);
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const warn = (message) => {
		if (onWarning !== void 0) onWarning(message);
		else process.stderr.write(`[theme] ${message}\n`);
	};
	const loaded = [];
	for (const file of files) {
		const name = basename(file, ".json");
		if (!NAME_RE.test(name)) continue;
		try {
			const input = parseCustomThemeJson(readFileSync(join(dir, file), "utf8"));
			if (!input) {
				warn(`skip invalid custom theme: ${file}`);
				continue;
			}
			const issues = validateThemeContrast({
				...input.colors,
				...input.overrides
			}, input.background ?? "dark");
			if (issues.length > 0) warn(`low contrast in ${file}: ${issues.map((i) => `${i.token}(${i.value} ×${i.ratio.toFixed(1)})`).join(", ")}`);
			registerCustomTheme(name, input);
			loaded.push(name);
		} catch {
			warn(`failed to read custom theme: ${file}`);
		}
	}
	return loaded;
}
/**
* 当前生效主题导出为自定义主题模板（/theme export；P1）。
* 全量 dump truecolor ColorSet + overrides，base 取内置同名或按背景朝向回退；
* 写盘成功后就地注册（当场 `/theme custom:<name>` 可用），编辑文件后重启生效。
* @param nameArg - 目标主题裸名（缺省 `exported-<当前名>`）；非法字符净化为 `-`。
* @param baseDir - 根目录（测试注入）；缺省 `~/.dsh-tui`。
* @returns 回显消息（成功含路径；失败含原因）。
*/
function exportCurrentTheme(nameArg, baseDir) {
	const active = getActiveThemeName();
	const name = (nameArg ?? `exported-${active.replace(/^custom:/, "")}`).replace(/[^A-Za-z0-9_-]/g, "-");
	if (name === "") return "导出失败：主题名净化后为空";
	const theme = getTheme();
	const template = {
		base: Object.hasOwn(THEME_PALETTES, active) ? active : getActiveThemeBackground() === "light" ? "paper" : "graphite",
		description: `exported from ${active} @ ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
		colors: {
			primary: theme.primary,
			secondary: theme.secondary,
			success: theme.success,
			warning: theme.warning,
			error: theme.error,
			dim: theme.dim,
			pulseQuiet: theme.pulseQuiet,
			pulseActive: theme.pulseActive,
			pulseAlert: theme.pulseAlert
		},
		overrides: {
			userColor: theme.userColor,
			assistantColor: theme.assistantColor,
			muted: theme.muted,
			systemColor: theme.systemColor
		}
	};
	const dir = customThemesDir(baseDir);
	const file = join(dir, `${name}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`);
	} catch (err) {
		return `导出失败：${err instanceof Error ? err.message : String(err)}`;
	}
	const parsed = parseCustomThemeJson(JSON.stringify(template));
	if (parsed) registerCustomTheme(name, parsed);
	return `主题模板已导出: ${file}（可用 /theme custom:${name}；编辑文件后重启生效）`;
}
//#endregion
//#region lib/types/git-status.js
/**
* git 仓库状态探测 — top bar 分支段与 footer ●N 的数据源（C4：自 ui/app.ts 提取）。
*
* 全部静默降级：非仓库 / git 缺失 / 命令失败 → 各自的「无值」形态，
* 绝不因 git 探测阻塞或打扰 TUI。execFileSync 可注入（测试密封）。
*
* @module @huiliyi37/dsh-tianshu-tui/git-status
*/
function defaultExec$1() {
	return (args) => execFileSync("git", args, {
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		encoding: "utf-8",
		timeout: 2e3,
		windowsHide: true
	});
}
/** 检测 cwd 是否为 git 仓库（静默，失败返回 false）。 */
function isGitRepo(exec = defaultExec$1()) {
	try {
		exec(["rev-parse", "--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
}
/**
* 读取当前 git 分支（C4 概念稿 A top bar；attach 时一次，静默）。
* detached HEAD 或非仓库返回 undefined（不渲染分支段）。
*/
function gitBranch(exec = defaultExec$1()) {
	try {
		const out = exec([
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		]).trim();
		return out === "" || out === "HEAD" ? void 0 : out;
	} catch {
		return;
	}
}
/**
* git 未提交改动文件数（`git status --short` 非空行计数；footer ●N 数据源）。
* 非仓库/命令失败返回 0（静默降级，同 gitBranch）。
*/
function gitDirtyCount(exec = defaultExec$1()) {
	try {
		return exec(["status", "--short"]).split("\n").filter((l) => l.trim() !== "").length;
	} catch {
		return 0;
	}
}
//#endregion
//#region lib/types/prefs.js
/**
* 本地偏好持久化层 — ~/.dsh-tui/prefs.json（theme/density/preset/常驻面板/glance/footerInfo/notifyOs）。
*
* 设计约束：
* - 容错优先：损坏/缺失/未知 key 静默降级为空偏好（缺省 = 现行为），绝不阻塞启动。
* - 原子写：tmp + rename（同 update-cache 模式），写失败 best-effort 静默。
* - 测试密封门：VITEST 环境默认不落真实 home（沿 self-update 的 env 判定先例）；
*   显式传 path（测试 tmp 目录）时才启用读写。
*
* @module @huiliyi37/dsh-tianshu-tui/prefs
*/
/** glance 可隐藏段（model/stalled 为身份/告警段，永不可隐藏）。 */
const GLANCE_HIDEABLE_SEGMENTS = [
	"effort",
	"cache",
	"context",
	"tokens",
	"elapsed",
	"cost"
];
/** 常驻监控面板（可持久化显隐；config/skills 等模态面板不持久化）。 */
const PERSISTED_PANELS = ["subagents", "workflow"];
/** 输入区信息密度档位（footerInfo）：full 两行 / compact 仅状态行 / off 全关。 */
const FOOTER_INFO_LEVELS = [
	"full",
	"compact",
	"off"
];
/** 欢迎页风格档位：blue 新版蓝鲸抱星（默认）/ star 紫鲸举星 / retro 复古小鲸鱼。 */
const WELCOME_STYLES = [
	"blue",
	"star",
	"retro"
];
function defaultPrefsPath() {
	return join(homedir(), ".dsh-tui", "prefs.json");
}
function isHideableSegment(v) {
	return typeof v === "string" && GLANCE_HIDEABLE_SEGMENTS.includes(v);
}
/** 解析偏好文本：非法 JSON / 非对象 / 字段形状不对 → 逐项丢弃，永不抛。 */
function parsePrefs(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null) return {};
	const obj = raw;
	const prefs = {};
	if (typeof obj.theme === "string" && obj.theme !== "") prefs.theme = obj.theme;
	if (typeof obj.preset === "string" && obj.preset !== "") prefs.preset = obj.preset;
	if (typeof obj.compactMode === "boolean") prefs.compactMode = obj.compactMode;
	if (typeof obj.onboarded === "boolean") prefs.onboarded = obj.onboarded;
	if (typeof obj.footerInfo === "string" && FOOTER_INFO_LEVELS.includes(obj.footerInfo)) prefs.footerInfo = obj.footerInfo;
	if (typeof obj.notifyOs === "boolean") prefs.notifyOs = obj.notifyOs;
	if (typeof obj.ghostSuggest === "boolean") prefs.ghostSuggest = obj.ghostSuggest;
	if (typeof obj.welcomeStyle === "string" && WELCOME_STYLES.includes(obj.welcomeStyle)) prefs.welcomeStyle = obj.welcomeStyle;
	if (typeof obj.scrollbackMaxLines === "number" && Number.isInteger(obj.scrollbackMaxLines) && obj.scrollbackMaxLines >= 1) prefs.scrollbackMaxLines = obj.scrollbackMaxLines;
	if (typeof obj.vimEnabled === "boolean") prefs.vimEnabled = obj.vimEnabled;
	if (typeof obj.vimInsertRemaps === "object" && obj.vimInsertRemaps !== null && !Array.isArray(obj.vimInsertRemaps)) {
		const remaps = {};
		for (const [key, value] of Object.entries(obj.vimInsertRemaps)) if (value === "esc" && [...key].length === 2) remaps[key] = "esc";
		if (Object.keys(remaps).length > 0) prefs.vimInsertRemaps = remaps;
	}
	if (typeof obj.panels === "object" && obj.panels !== null) {
		const p = obj.panels;
		const panels = {};
		for (const k of PERSISTED_PANELS) if (typeof p[k] === "boolean") panels[k] = p[k];
		if (Object.keys(panels).length > 0) prefs.panels = panels;
	}
	if (typeof obj.glance === "object" && obj.glance !== null) {
		const g = obj.glance;
		if (Array.isArray(g.hideSegments)) {
			const segs = g.hideSegments.filter(isHideableSegment);
			if (segs.length > 0) prefs.glance = { hideSegments: segs };
		}
	}
	return prefs;
}
/** 读偏好；缺失/损坏 → 空偏好。 */
function readPrefs(path) {
	try {
		return parsePrefs(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}
/** 原子写偏好（tmp + rename）；失败静默（偏好是优化不是正确性依赖）。 */
function writePrefs(path, prefs) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {}
}
/**
* 测试密封门：VITEST 下默认不读写真实 home——显式 path（测试 tmp）优先，
* 其次 env 未设 VITEST（生产），否则 null（禁用）。
* 调用方以 `resolvePrefsPath(explicit)` 归一：undefined+VITEST → null。
*/
function prefsEnabled(explicitPath) {
	if (explicitPath !== void 0) return explicitPath;
	const env = process.env;
	if (env.VITEST === "true" || env.VITEST === "1") return null;
	return defaultPrefsPath();
}
//#endregion
//#region lib/types/input-history.js
/**
* 输入历史持久化 — ~/.dsh-tui/input-history.json（上游 Tianshu history.ts 模式移植）。
*
* 语义（对本仓内存态的持久化版，去重更强）：
* - trim 后空串 no-op；对全列表去重（重复提交浮到头部）；上限 MAX_INPUT_HISTORY。
* - 追加 = 进程内串行队列 + 每次重读合并再原子写：快速连续提交不丢条目；
*   多进程并发按 last-writer-wins（原子写保证文件永不损坏，仅可能互相覆盖）。
* - 容错：损坏/缺失 → 空历史；写失败静默（历史是优化不是正确性依赖）。
* - 隐私注记（docs/configuration.md）：文件内容为用户输入原文，删文件即清空。
*
* @module @huiliyi37/dsh-tianshu-tui/input-history
*/
const MAX_INPUT_HISTORY = 1e3;
function defaultInputHistoryPath() {
	return join(homedir(), ".dsh-tui", "input-history.json");
}
/** 读历史；缺失/损坏/非字符串数组 → 空历史。 */
function loadInputHistory(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!Array.isArray(raw)) return [];
		return raw.filter((v) => typeof v === "string").slice(0, MAX_INPUT_HISTORY);
	} catch {
		return [];
	}
}
/** 原子写历史。 */
function saveInputHistory(path, history) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {}
}
/** 提交后的下一份历史（纯函数）：trim、空串 no-op、全列表去重、限长。 */
function nextHistoryAfterSubmit(history, entry) {
	const trimmed = entry.trim();
	if (trimmed === "") return [...history];
	return [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_INPUT_HISTORY);
}
/**
* fish 式历史建议（ghost）：最近一条以 value 为前缀的历史条目的剩余部分。
* 历史按最近在前排列，首个匹配即最近条目；等长（无剩余）与剩余部分含换行
* 的条目跳过（ghost 只渲染在光标行尾，多行建议无意义）。空 value → null。
*/
function historyGhostSuffix(history, value) {
	if (value === "") return null;
	for (const entry of history) {
		if (entry.length <= value.length || !entry.startsWith(value)) continue;
		if (entry.includes("\n", value.length)) continue;
		return entry.slice(value.length);
	}
	return null;
}
let appendQueue = Promise.resolve();
/**
* 追加一条输入历史（异步，不阻塞调用方——提交路径延迟敏感）。
* 每次都重读文件再合并：多会话/多进程下的最新文件状态优先，本进程新条目置顶。
*/
function appendInputHistory(path, entry) {
	const pending = appendQueue.then(() => {
		saveInputHistory(path, nextHistoryAfterSubmit(loadInputHistory(path), entry));
	});
	appendQueue = pending.catch(() => {});
	return pending;
}
/** 测试密封门（同 prefs.ts）：VITEST 下默认 null，显式 path 优先。 */
function inputHistoryEnabled(explicitPath) {
	if (explicitPath !== void 0) return explicitPath;
	const env = process.env;
	if (env.VITEST === "true" || env.VITEST === "1") return null;
	return defaultInputHistoryPath();
}
//#endregion
//#region lib/types/ring-buffer.js
/**
* 创建定容环形缓冲。
* @param cap - 容量上限（满后覆盖最旧项）。
* @returns 新的 RingBuffer 实例。
*/
function createRingBuffer(cap) {
	const buf = new Array(cap);
	let head = 0;
	let count = 0;
	return {
		push(item) {
			buf[(head + count) % cap] = item;
			if (count < cap) count++;
			else head = (head + 1) % cap;
		},
		items() {
			const result = [];
			for (let i = 0; i < count; i++) {
				const item = buf[(head + i) % cap];
				/* v8 ignore next -- count 内的槽位必被 push 填过，恒非 undefined；noUncheckedIndexedAccess 收窄防御 */
				if (item !== void 0) result.push(item);
			}
			return result;
		},
		clear() {
			head = 0;
			count = 0;
		},
		drain(n) {
			const drained = Math.min(n, count);
			const result = [];
			for (let i = 0; i < drained; i++) {
				const item = buf[(head + i) % cap];
				/* v8 ignore next -- drain 只取 count 内的槽位，必被 push 填过；noUncheckedIndexedAccess 收窄防御 */
				if (item !== void 0) result.push(item);
			}
			head = (head + drained) % cap;
			count -= drained;
			return result;
		},
		get size() {
			return count;
		}
	};
}
//#endregion
//#region lib/types/engine/commit-engine.js
/**
* T9 CommitEngine — 将已确定的格式化内容写入终端 scrollback。
*
* 核心原则：
* - 只做 append-only `stdout.write()`，不跟踪已写入内容的位置。
* - 进入 scrollback 的内容不可被擦除、不可被重绘。
* - 替代 Ink 的 `<Static>` 组件语义，但无需 high-water index 追踪。
*
* 与现有的 `committed-log.ts` 的关系：
* - `committed-log.ts` 作为数据层保留（LogEntry 存储 + dedup），
*   CommitEngine 是其消费端——将 LogEntry 格式化后写入 stdout。
* - 阶段 1 会提取格式化函数，届时 CommitEngine 调用这些函数。
*/
/** Scrollback buffer 默认行数上限（长会话防内存无限增长）。 */
const DEFAULT_SCROLLBACK_MAX_LINES = 1e3;
/**
* append-only 提交引擎：把已确定内容写入终端 scrollback，同时在内存
* RingBuffer 里保留最近 N 行供 pager overlay 读取。写入后不可擦除、不可重绘。
*/
var CommitEngine = class {
	stdout;
	flush;
	/**
	* Scrollback buffer: 累积所有已提交文本，供 pager overlay 读取。
	* 使用 RingBuffer 封顶——长会话下无界 string[] 会持续增长，
	* 超过上限后最旧条目被自动丢弃（保留最近的，匹配 pager 实际可见范围）。
	*/
	buffer;
	constructor(options) {
		this.stdout = options.stdout;
		this.flush = options.flush ?? false;
		const cap = options.scrollbackMaxLines ?? DEFAULT_SCROLLBACK_MAX_LINES;
		this.buffer = createRingBuffer(Math.max(1, cap));
	}
	/**
	* 返回 scrollback 完整文本（各条目以换行符连接，封顶后只含最近 N 条）。
	* @returns 换行符连接的 scrollback 文本
	*/
	getContent() {
		return this.buffer.items().join("\n");
	}
	/**
	* 将一条已提交条目写入终端 scrollback。
	*
	* 写入策略：完整的 ANSI 行 + 换行符。终端驱动负责将已显示内容
	* 推入 scrollback buffer。
	*
	* 即使 live region 在底部显示，此写入也发生在 live region 的
	* 重绘区域之前（cursor save 之前），因此天然按时间顺序排列。
	* @param entry - 待写入条目（ansi 优先于 text；自动补齐末尾换行）
	*/
	write(entry) {
		let content = entry.ansi ?? entry.text;
		if (!content.endsWith("\n")) content += "\n";
		if (entry.trailingNewline) content += "\n";
		this.buffer.push(content.trimEnd());
		this.stdout.write(content);
	}
	/**
	* 批量写入多条已提交条目。
	* 在同一帧中连续写入，减少系统调用次数。
	* @param entries - 按顺序写入的条目列表
	*/
	writeBatch(entries) {
		let buf = "";
		for (const entry of entries) {
			const content = entry.ansi ?? entry.text;
			const line = content + (content.endsWith("\n") ? "" : "\n") + (entry.trailingNewline ? "\n" : "");
			this.buffer.push(line.trimEnd());
			buf += line;
		}
		this.stdout.write(buf);
	}
	/**
	* 写入原始 ANSI 字符串（不追加换行）。
	* 用于需要精确控制格式的场景（如分隔线、缩进）。
	* 注意：不进入 scrollback buffer，pager 读不到此内容。
	* @param ansi - 原样写入 stdout 的字符串
	*/
	writeRaw(ansi) {
		this.stdout.write(ansi);
	}
	/**
	* 清空 scrollback buffer（/clear 命令）。只重置内部 buffer（后续
	* getContent()/pager 读取与写入位置）；已显示的行由调用方经
	* ANSI.ERASE_SCREEN + 光标回顶擦除（见 TuiApp 的 clearScrollback）。
	*/
	reset() {
		this.buffer.clear();
	}
	/**
	* 写入一条水平分隔线。
	* 宽度 = 终端列数 或 指定宽度。
	* @param width - 分隔线宽度（列数）；缺省取 stdout.columns
	*/
	writeSeparator(width) {
		const w = width ?? this.stdout.columns;
		this.stdout.write(`${ANSI.DIM}${"─".repeat(w)}${ANSI.RESET}\n`);
	}
	/**
	* 确保输出已刷新到终端。
	*/
	drain() {
		if (this.flush) {}
	}
};
//#endregion
//#region lib/types/term-caps.js
/**
* 终端能力探测 — Windows legacy conhost（经典控制台）识别与降级开关。
*
* 背景：PowerShell/cmd 直启的经典 conhost（非 Windows Terminal）配中文点阵
* 字体时，East-Asian Ambiguous 字符与 GBK 框线字符均按 2 列渲染，且大量
* Unicode 字形（✶ ◐ ╭ ❯…）缺失显示为 tofu。LiveEngine 的相对光标回顶依赖
* 逐行宽度估算，估算与实际渲染错位 → 回顶欠擦 → 旧帧逐帧堆叠进 scrollback。
* 本模块提供判定信号，width.ts / 字形降级据此选择保守档。
*/
/**
* 是否运行在 Windows legacy conhost（经典控制台）。
* 启发式（supports-hyperlinks 等库同款）：win32 且无任何现代终端标记——
* Windows Terminal 设 WT_SESSION、VS Code 设 TERM_PROGRAM、ConEmu 设
* ConEmuANSI、mintty/Git Bash 设 TERM。全无 → 经典 conhost。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @param platform - 平台标识（测试注入用，缺省 process.platform）。
* @returns 是否为经典 conhost。
*/
function isLegacyWindowsConsole(env = process.env, platform = process.platform) {
	if (platform !== "win32") return false;
	if (env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI) return false;
	if (env.TERM) return false;
	return true;
}
/** 已知支持 OSC52 系统剪贴板写入的终端程序（TERM_PROGRAM 白名单）。 */
const OSC52_TERM_PROGRAMS = /* @__PURE__ */ new Set([
	"iTerm.app",
	"WezTerm",
	"kitty",
	"Hyper",
	"vscode"
]);
/**
* 是否支持 OSC52（写系统剪贴板）。
* 启发式：TERM_PROGRAM 白名单命中 → 支持；Apple Terminal 显式排除
* （macOS Terminal.app 不写 OSC52，即使 TERM 是 xterm 兼容）；VTE 系
* （gnome-terminal 等设 VTE_VERSION）与 GNU screen（设 STY）不支持；
* 内核 VT（TERM=linux）无剪贴板概念。其余按 TERM 兼容性
* （xterm/screen/tmux 系大多支持）。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 是否支持 OSC52。
*/
function supportsOsc52(env = process.env) {
	const prog = env.TERM_PROGRAM;
	if (prog === "Apple_Terminal") return false;
	if (prog !== void 0 && OSC52_TERM_PROGRAMS.has(prog)) return true;
	if (env.VTE_VERSION !== void 0) return false;
	if (env.STY !== void 0) return false;
	const term = env.TERM ?? "";
	if (term === "linux") return false;
	return /(^|-)xterm|screen|tmux/i.test(term);
}
/**
* locale 是否 CJK（zh/ja/ko 前缀）。env 显式值与 Intl（OS locale）任一命中即
* 判定 CJK——与上游 Tianshu-Tui 语义一致。仅 env 优先会把「中文 Windows 配
* 英文 LANG」（MSYS 直跑 bash.exe 常见）错判为 non-CJK，导致 legacy conhost
* 宽度档位误选、逐行宽度估算错位。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 是否为 CJK locale。
*/
function isCjkLocale(env = process.env) {
	const candidates = [
		env.LC_ALL ?? "",
		env.LC_CTYPE ?? "",
		env.LANG ?? ""
	];
	try {
		candidates.push(new Intl.DateTimeFormat().resolvedOptions().locale ?? "");
	} catch {}
	return candidates.some((l) => /^(zh|ja|ko)/i.test(l.trim()));
}
let legacyCjkCache = null;
/**
* legacy conhost 且 CJK 环境（宽度 full 档的触发条件）。进程内缓存一次。
* @returns 是否命中 legacy CJK conhost。
*/
function isLegacyCjkConsole() {
	if (legacyCjkCache === null) legacyCjkCache = isLegacyWindowsConsole() && isCjkLocale();
	return legacyCjkCache;
}
let asciiGlyphCache = null;
/**
* 是否使用 ASCII 安全字形（spinner/thinking/工具卡的月相、星形等装饰字形）。
* 原有门槛 chalk.level<3 保留；legacy conhost 无条件降级（字形缺失 + 宽度
* 不可预测，与颜色能力无关）。env `RIVET_ASCII_UI=0/1` 显式覆盖。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 是否降级为 ASCII 字形。
*/
function useAsciiGlyphs(env = process.env) {
	if (env.RIVET_ASCII_UI === "1") return true;
	if (env.RIVET_ASCII_UI === "0") return false;
	if (asciiGlyphCache === null)
 /* v8 ignore next -- 测试进程非 TTY，chalk.level<3 恒短路；右侧为高色深终端专属场景 */
	asciiGlyphCache = chalk.level < 3 || isLegacyWindowsConsole();
	return asciiGlyphCache;
}
let asciiBorderCache = null;
/**
* 是否使用 ASCII 边框（输入框 chrome）。与字形开关分离：低色深终端
* （tmux/screen 的 chalk.level 2）渲染 Unicode 框线完全正常，边框降级只在
* 框线宽度不可预测的 legacy conhost 触发。env `RIVET_ASCII_UI=0/1` 显式覆盖。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 是否降级为 ASCII 边框。
*/
function useAsciiBorders(env = process.env) {
	if (env.RIVET_ASCII_UI === "1") return true;
	if (env.RIVET_ASCII_UI === "0") return false;
	if (asciiBorderCache === null) asciiBorderCache = isLegacyWindowsConsole();
	return asciiBorderCache;
}
/** 测试钩子：重置探测缓存。 */
function resetTermCapsCache() {
	legacyCjkCache = null;
	asciiGlyphCache = null;
	asciiBorderCache = null;
}
/**
* 终端是否支持 kitty 键盘增强协议（progressive enhancement：应用推送 flag 后
* 终端才以 CSI u 上报修饰键——Ctrl+Enter 的 CSI 13;5u 只有推送 flag 1 后可达）。
* 启发式白名单：kitty（TERM 前缀 / KITTY_WINDOW_ID / TERM_PROGRAM）、ghostty、
* foot、contour 原生支持应用推送；WezTerm 默认忽略推送（需用户开启
* enable_kitty_keyboard，env 不可知）故不入列——其已开启用户走
* RIVET_KITTY_KEYBOARD=1 显式覆盖。tmux/screen（TMUX/STY）透传取决于版本与
* extended-keys 配置，保守排除。env `RIVET_KITTY_KEYBOARD=0/1` 显式覆盖。
* 判定只决定「推送与否 + keymap 行显隐」：不支持的终端忽略推送序列、永不回
* CSI u，ctrl_return 天然静默（无错误输入路由）。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 是否支持 kitty 键盘增强推送。
*/
function supportsKittyKeyboard(env = process.env) {
	if (env.RIVET_KITTY_KEYBOARD === "1") return true;
	if (env.RIVET_KITTY_KEYBOARD === "0") return false;
	if (env.TMUX !== void 0 || env.STY !== void 0) return false;
	if (env.KITTY_WINDOW_ID !== void 0) return true;
	const prog = env.TERM_PROGRAM ?? "";
	if (prog === "kitty" || prog === "ghostty") return true;
	const term = env.TERM ?? "";
	return /^xterm-kitty|^xterm-ghostty|^foot|^contour/.test(term);
}
/**
* kitty 键盘增强推送序列（flag 1 = 消歧义位：Ctrl/Alt+Enter 等以 CSI u 上报，
* 普通可打印键与无修饰 Enter/Tab/Backspace 保持传统字节）。不支持的终端返回
* ''（序列本就会被忽略，但零写出更干净）；与 dispose 的 pop 同源判定。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 推送序列或不支持时的空串。
*/
function kittyKeyboardPushSeq(env = process.env) {
	return supportsKittyKeyboard(env) ? "\x1B[>1u" : "";
}
/**
* kitty 键盘增强弹出序列（退出时恢复终端键盘编码；与 push 成对）。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 弹出序列或不支持时的空串。
*/
function kittyKeyboardPopSeq(env = process.env) {
	return supportsKittyKeyboard(env) ? "\x1B[<u" : "";
}
//#endregion
//#region lib/types/width.js
/**
* 显示宽度度量 — 解决 string-width 的窄宽假设与终端实际渲染的错位。
*
* 背景：`string-width` 把 East-Asian **Ambiguous** 字符（如 `—` `…` `↑↓` `·`）
* 一律按 1 列计；但很多终端（尤其 CJK 环境/字体）把这些符号按 2 列渲染。
* LiveEngine 据 string-width 估算每行占几个显示行（`rowsForLine`），低估后
* 相对光标回顶量不足 → 旧帧顶部泄漏进 scrollback（输入框重影/重叠）。
*
* 关键陷阱：Unicode 把 **box-drawing / block**（U+2500–U+259F，如 `─ │ ╭ █`）
* 也归为 ambiguous，但 xterm 系终端普遍按 **1 列** 渲染它们。若把所有 ambiguous
* 当宽，会把输入框边框算成双宽 → over-erase 反噬 scrollback。因此 wide 模式只对
* **非 box/block 的 ambiguous 符号** 叠加 +1 宽度增量。
*
* 但 Windows legacy conhost（GBK 中文字体）连框线字符也按 **2 列** 渲染——
* wide 档在那里仍会低估边框行宽度 → 折行 → 回顶欠擦。为此增设 **full 档**：
* box/block 一并 +1。三档语义：
* - narrow：= string-width（默认，xterm 系）
* - wide：非 box/block 的 ambiguous +1（CJK xterm 终端）
* - full：所有 ambiguous 含 box/block +1（legacy CJK conhost，自动探测默认）
*
* 度量建立在 `string-width` 之上（继承其对 emoji/ZWJ/组合符/控制符的正确处理），
* narrow 模式与 string-width 完全一致（零回归）。
*/
const ANSI_RE$1 = /\x1B(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
/** 黏附匹配（按位置）用于截断时识别转义序列。 */
const ANSI_STICKY = /\x1B(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1B]*(?:\x07|\x1B\\))/y;
const RESET$3 = "\x1B[0m";
const OSC8_OPEN_RE = /\x1B\]8;[^\x07\x1B]*(?:\x07|\x1B\\)/g;
/** box-drawing（U+2500–257F）与 block elements（U+2580–259F）：终端均按 1 列渲染。 */
function isBoxOrBlock(cp) {
	return cp >= 9472 && cp <= 9631;
}
/** 一个 code point 在 wide/full 模式下相对 string-width 的额外宽度（0 或 1）。 */
function ambiguousExtraForCp(cp) {
	if (isBoxOrBlock(cp)) return ambiguousWidthMode() === "full" ? 1 : 0;
	return eastAsianWidthType(cp) === "ambiguous" ? 1 : 0;
}
/** 去掉 ANSI 后逐 code point 累计的 ambiguous 额外宽度。 */
function ambiguousExtra(plain) {
	let extra = 0;
	for (const ch of plain) {
		const cp = ch.codePointAt(0);
		/* v8 ignore next -- for-of 迭代的单个字符必有值；noUncheckedIndexedAccess 收窄防御 */
		if (cp === void 0) continue;
		extra += ambiguousExtraForCp(cp);
	}
	return extra;
}
let detectedModeCache = null;
/**
* 宽度模式：env `RIVET_AMBIGUOUS_WIDTH` 显式值优先（narrow/wide/full），
* 未设时按终端探测——legacy CJK conhost（GBK 字体连框线都按 2 列渲染）
* 默认 full，其余平台默认 narrow（与历史行为一致）。
* @returns 生效的宽度档位（探测结果进程内缓存）。
*/
function ambiguousWidthMode() {
	const env = (process.env.RIVET_AMBIGUOUS_WIDTH ?? "").toLowerCase();
	if (env === "wide") return "wide";
	if (env === "full") return "full";
	if (env === "narrow") return "narrow";
	if (detectedModeCache === null) detectedModeCache = isLegacyCjkConsole() ? "full" : "narrow";
	return detectedModeCache;
}
/**
* 兼容旧布尔口径：wide 或 full 均视为启用（消费方只区分「是否加宽」）。
* @returns 是否启用 ambiguous 加宽。
*/
function ambiguousWideEnabled() {
	return ambiguousWidthMode() !== "narrow";
}
/** 测试钩子：重置探测缓存。 */
function resetWidthModeCache() {
	detectedModeCache = null;
}
/**
* 按显示宽度断行（ANSI 安全：转义序列原样保留、不计宽；不吞字符）。
* 已在预算内的整段返回单行。每行从当前字符重新累积宽度——调用方若需
* 每行带固定前缀（如说话人导轨），应把前缀宽度计入 max 或逐行拼装。
* @param text - 待断行文本（可含 ANSI）。
* @param max - 每行最大显示宽度。
* @param opts - 宽度度量选项（透传 displayWidth）。
* @returns 断行结果（不包含换行符的行数组）。
*/
function wrapToDisplayWidth(text, max, opts = {}) {
	if (max <= 0) return [];
	const wide = opts.ambiguousAsWide ?? ambiguousWideEnabled();
	const lines = [];
	let current = "";
	let w = 0;
	let i = 0;
	let sawAnsi = false;
	while (i < text.length) {
		ANSI_STICKY.lastIndex = i;
		const m = ANSI_STICKY.exec(text);
		if (m && m.index === i) {
			current += m[0];
			i += m[0].length;
			sawAnsi = true;
			continue;
		}
		const cp = text.codePointAt(i);
		/* v8 ignore next -- i 恒 < text.length，codePointAt 必有值；noUncheckedIndexedAccess 收窄防御 */
		if (cp === void 0) break;
		const ch = String.fromCodePoint(cp);
		let cw = stringWidth(ch);
		if (wide) cw += ambiguousExtraForCp(cp);
		if (w + cw > max && w > 0) {
			lines.push(sawAnsi ? `${current}\u001b[0m` : current);
			current = "";
			w = 0;
			sawAnsi = false;
			continue;
		}
		current += ch;
		w += cw;
		i += ch.length;
	}
	lines.push(current);
	return lines;
}
/**
* 文本的显示宽度（已忽略 ANSI 转义）。
* @param text - 待度量文本（可含 ANSI）。
* @param opts - 宽度度量选项。
* @returns 显示宽度（列数）。
*/
function displayWidth(text, opts = {}) {
	const plain = text.replace(ANSI_RE$1, "");
	const base = stringWidth(plain);
	if (!(opts.ambiguousAsWide ?? ambiguousWideEnabled())) return base;
	return base + ambiguousExtra(plain);
}
/** 单字符宽度缓存条目上限（超出整体清空——常见文档字符集远小于此）。 */
const CHAR_WIDTH_CACHE_LIMIT = 2e4;
/** narrow 档（不加宽）单字符宽度缓存：code point → cell 数。 */
const charWidthCacheNarrow = /* @__PURE__ */ new Map();
/** wide/full 档（加宽）单字符宽度缓存：code point → cell 数。 */
const charWidthCacheWide = /* @__PURE__ */ new Map();
/**
* 单个 code point 的显示宽度（= displayWidth(ch) 的结果缓存版）。
*
* 热路径专用：输入框折行对每个字符调用一次宽度度量，而 string-width
* 每次调用都新建 Intl.Segmenter 并跑若干 Unicode 属性正则（单字符 ~0.1ms）。
* 长草稿（万级字符）下逐字符直调 displayWidth 会让每次按键渲染上百毫秒
* （10 万字符草稿 ~1.3s；缓存后 ~10ms，天枢 2026-08-17 长文本优化同源）。
* 按字符缓存后热路径退化为 Map 命中（~0.1µs）；两档（加宽/不加宽）分开缓存
* ——同字符在不同档位下宽度不同。只缓存结果、不改算法，宽度与 displayWidth
* 逐字符求和恒等（折行点不因缓存漂移）。
*
* @param ch - 单个 code point（1–2 个 UTF-16 code unit；多 code point 串
*   会得到与 displayWidth 不一致的结果，调用方须按 code point 迭代）。
* @param ambiguousAsWide - 是否按加宽档位度量（与 displayWidth 同口径）。
* @returns 显示宽度（cell 数）。
*/
function charDisplayWidth(ch, ambiguousAsWide) {
	const cache = ambiguousAsWide ? charWidthCacheWide : charWidthCacheNarrow;
	const hit = cache.get(ch);
	if (hit !== void 0) return hit;
	const w = displayWidth(ch, { ambiguousAsWide });
	if (cache.size >= CHAR_WIDTH_CACHE_LIMIT) cache.clear();
	cache.set(ch, w);
	return w;
}
/** 测试钩子：清空单字符宽度缓存。 */
function resetCharWidthCache() {
	charWidthCacheNarrow.clear();
	charWidthCacheWide.clear();
}
/**
* 按显示宽度截断（ANSI 安全：转义序列原样保留、不计宽；截断发生时补一个 RESET
* 防止颜色泄漏到后续行）。已在预算内则原样返回。
* @param text - 待截断文本（可含 ANSI）。
* @param max - 最大显示宽度（<=0 返回空串）。
* @param opts - 宽度度量选项。
* @returns 截断结果（含 ANSI 时补 RESET，OSC 8 链接被切开时先补闭合）。
*/
function truncateToDisplayWidth(text, max, opts = {}) {
	if (max <= 0) return "";
	if (displayWidth(text, opts) <= max) return text;
	const wide = opts.ambiguousAsWide ?? ambiguousWideEnabled();
	let out = "";
	let w = 0;
	let i = 0;
	let sawAnsi = false;
	while (i < text.length) {
		ANSI_STICKY.lastIndex = i;
		const m = ANSI_STICKY.exec(text);
		if (m && m.index === i) {
			out += m[0];
			i += m[0].length;
			sawAnsi = true;
			continue;
		}
		const cp = text.codePointAt(i);
		/* v8 ignore next -- i 恒 < text.length，codePointAt 必有值；noUncheckedIndexedAccess 收窄防御 */
		if (cp === void 0) break;
		const ch = String.fromCodePoint(cp);
		let cw = stringWidth(ch);
		if (wide) cw += ambiguousExtraForCp(cp);
		if (w + cw > max) break;
		out += ch;
		w += cw;
		i += ch.length;
	}
	if (!sawAnsi) return out;
	const oscSeqs = out.match(OSC8_OPEN_RE) ?? [];
	const lastOsc = oscSeqs[oscSeqs.length - 1];
	return lastOsc !== void 0 && !/^\x1B\]8;;(?:\x07|\x1B\\)$/.test(lastOsc) ? out + "\x1B]8;;\x07\x1B[0m" : out + RESET$3;
}
//#endregion
//#region lib/types/engine/live-budget.js
/**
* live 区动态段预算：Working 行封顶、欢迎首帧只裁不垫、高水位只涨不缩、
* 空闲 ticker 跳过组装的 key / spinner 判定。纯函数，不碰 stdout。
*/
/**
* 溢出裁剪 + 定高垫高：把 `[0, chromeStart)` 限制在恰好 `budget` display rows。
* `budget <= 0` 且垫行：原样返回。`pad: false`：只裁不垫；budget 0 丢掉动态段。
*/
function padDynamicRegion(lines, chromeStart, budget, rowsForLine = () => 1, options) {
	const pad = options?.pad !== false;
	if (budget <= 0 && pad) return {
		lines: lines.slice(),
		chromeStart
	};
	const dynamic = lines.slice(0, chromeStart);
	const chrome = lines.slice(chromeStart);
	const cap = Math.max(0, budget);
	let rows = 0;
	for (const line of dynamic) rows += rowsForLine(line.text);
	let dropUntil = 0;
	while (rows > cap && dropUntil < dynamic.length) {
		const dropped = dynamic[dropUntil];
		if (dropped === void 0) break;
		rows -= rowsForLine(dropped.text);
		dropUntil++;
	}
	const kept = dynamic.slice(dropUntil);
	const padCount = pad ? Math.max(0, cap - rows) : 0;
	const padding = Array.from({ length: padCount }, () => ({ text: "" }));
	return {
		lines: [
			...kept,
			...padding,
			...chrome
		],
		chromeStart: kept.length + padCount
	};
}
/** live 区行上限：随终端高度收缩，封顶 28、下限 4。 */
function liveMaxRowsFor(rows) {
	return Math.max(4, Math.min(28, (rows || 24) - 1));
}
/** Working 行封顶：给 chrome 留位。 */
function workingRowsCap(terminalRows, chromeRows) {
	return Math.max(0, liveMaxRowsFor(terminalRows) - Math.max(0, chromeRows));
}
/**
* 动态段预算：高水位只涨不缩。skipPad 按 min(动态行, ceiling) 裁且不改高水位。
*/
function nextDynamicBudget(highWater, dynamicRows, ceiling, skipPad, freezeHighWater = false) {
	if (skipPad) return {
		budget: Math.min(Math.max(0, dynamicRows), Math.max(0, ceiling)),
		highWater
	};
	if (ceiling <= 0) return {
		budget: 0,
		highWater: 0
	};
	const budget = Math.min(ceiling, Math.max(highWater, dynamicRows));
	if (freezeHighWater) return {
		budget,
		highWater: Math.min(ceiling, highWater)
	};
	return {
		budget,
		highWater: budget
	};
}
/** live 区同时展示的进行中工具卡数量上限。 */
const LIVE_TOOL_CARD_MAX = 3;
/** snapshot 面 + chrome 面合成一帧 idle key（换行分隔，避免字段粘连）。 */
function liveIdleKey(parts) {
	return `${parts.snapshotKey}\n${parts.chromeKey}`;
}
/** 同 key 且无 spinner 才跳过；首帧 prevKey 为空、有转圈、key 变都必须组装。 */
function shouldSkipIdleAssemble(opts) {
	return !opts.hasSpinner && opts.prevKey === opts.nextKey;
}
/** 任一转圈源为真：ticker 才推进 tick，空闲帧不改 key。 */
function liveHasSpinner(flags) {
	return flags.agentRunning || flags.activityRunning || flags.pendingTools || flags.reasoningLive;
}
/** 把当前控制面折成 idle key；flush/batcher 路径不读此结果做跳过。 */
function assembleIdleKey(src) {
	return liveIdleKey({
		snapshotKey: [
			src.agentStatus,
			src.activity.map((item) => `${item.id}:${item.status}:${item.lastTool ?? ""}:${item.toolCalls ?? 0}:${item.tokensUsed ?? 0}`).join("|"),
			src.pendingCallIds.join(","),
			src.activityBandEnabled ? "1" : "0",
			src.compactMode ? "1" : "0",
			`${src.rows}x${src.columns}`,
			src.panelFlags,
			src.btwActive ? "btw" : "",
			src.taskNotice,
			String(src.gitDirty),
			src.apiKeyReady ? "1" : "0",
			String(src.reasoningChars),
			src.reasoningExpanded ? "1" : "0",
			String(src.streamPeekChars)
		].join("\n"),
		chromeKey: [
			src.inputValue,
			src.questionPending ? "1" : "0",
			src.approvalPending ? "1" : "0",
			src.approvalTool,
			src.alwaysApprove ? "1" : "0",
			src.newlineMode ? "1" : "0",
			src.slashKey
		].join("\n")
	});
}
//#endregion
//#region lib/types/engine/live-engine.js
/**
* T9 LiveEngine — 管理终端底部动态区域（live region）的增量重绘。
*
* 核心机制：
* - 在渲染 live region 之前，用 `cursor save` 保存滚动位置。
* - 渲染时：上移到 live region 起始行 → 逐行擦除 + 重写 → 恢复光标。
* - live region 永远只占底部 N 行（通常 5-20 行），远小于终端高度。
* - streaming 内容由 BlockStreamWriter 控制，超出的部分已经 commit 到 scrollback。
*
* **Display-row awareness**: 所有行数追踪使用 visual display rows（wrapping-aware），
* 而非 logical line count。一个 200 字符的行在 80 列终端占 3 display rows。
* cursorUp / erase / lastDisplayRows 全部基于 display rows，防止 wrap 行导致
* cursor 定位偏差 → ghost 行 / 重复渲染。
*
* 与 Ink 的区别：
* - Ink 在 live region >= terminal rows 时执行 `\x1B[2J` 全屏清屏，
*   LiveEngine 永远不会触发全屏清屏——live region 被严格限制在底部。
*/
/**
* 终端底部动态区域（live region）的增量重绘引擎。
* 行数追踪全部基于 wrapping-aware display rows；渲染后光标常驻区域末行
* （cursor-resident 协议），并以 CPR 探针自愈外来写入污染。
*/
var LiveEngine = class LiveEngine {
	stdout;
	maxRows;
	/** 上一帧渲染的 display rows（wrapping-aware）。用于计算上移量。 */
	lastDisplayRows = 0;
	/** lineCache 渲染时的终端宽度。resize 检测：宽度变了说明屏上内容已被 reflow。 */
	lastColumns = 0;
	/** 是否已执行过首次渲染（用于判断是否需要 save cursor） */
	hasRendered = false;
	/** live region 行缓存：每行的原始文本（不含 ANSI）用于 diff */
	lineCache = [];
	/**
	* ambiguous 宽度模式缓存。`ambiguousWideEnabled()` 每次读 `process.env` 并做
	* 字符串比较，而一帧渲染里 rowsForLine 被调数十次（countDisplayRows / canDiff /
	* buildDiff / reconcileWidth），重复读 env 是无谓开销。该值在一次进程中基本不变，
	* 惰性读取一次后缓存即可。
	*/
	ambiguousWideCache = null;
	onProbeRequest;
	onPolluted;
	/** 最近一次确认的驻停位置（CPR 响应，1-based）。null = 未建立基线。 */
	cprBaseline = null;
	/** 已发出探针但未收到响应（带超时自愈，防终端不应答导致探针停摆）。 */
	cprProbePending = false;
	lastCprProbeMs = 0;
	/** 污染标记：下一帧 render 跳过 H2 短路/diff，走恢复重铺。 */
	polluted = false;
	/** 最近一次探针响应的光标行（恢复路径的爬升上限——绝不爬出视口顶）。 */
	cprReportRow = 1;
	parkedRowsUp = 0;
	parkedCol = null;
	/** 发 CPR 探针那一刻的驻停记账——响应按它折算区域末行，防 caret 移动误判污染。 */
	probeParked = null;
	hardwareCursorVisible = process.env.RIVET_TUI_HARDWARE_CURSOR === "1";
	/** 探针最小间隔：渲染每帧都可能触发，防探针风暴。 */
	static CPR_PROBE_MIN_INTERVAL_MS = 1e3;
	/** 探针响应超时：超过即允许重发（兼容不应答 DSR 的环境）。 */
	static CPR_PROBE_TIMEOUT_MS = 5e3;
	/** ambiguous 宽度模式（缓存 process.env 读取）。 */
	ambiguousWide() {
		if (this.ambiguousWideCache === null) this.ambiguousWideCache = ambiguousWideEnabled();
		return this.ambiguousWideCache;
	}
	constructor(options) {
		this.stdout = options.stdout;
		this.maxRows = options.maxRows ?? 20;
		if (options.onProbeRequest !== void 0) this.onProbeRequest = options.onProbeRequest;
		if (options.onPolluted !== void 0) this.onPolluted = options.onPolluted;
	}
	/**
	* 暂停 CPR 污染检测，并禁止 render/clear 写 stdout。
	* overlay（picker/pager 等）激活期间光标在 alt screen，CPR 响应的位置不代表
	* 主屏 live region；若照常比对会误判污染并触发 renderLive 把主屏帧写进 alt
	* screen（picker 残影泄漏回主会话的根因）。即便上层漏跳过 renderLive，引擎
	* 层也不得改写 alt screen，且不得把主屏 lastDisplayRows 清零（否则退出后
	* 会当空区再 append 一份 live 区）。
	* 调用方应在 overlay 激活时 suppress，退出时 resume（并作废基线等下一帧重建）。
	*/
	probeSuppressed = false;
	/** overlay 激活：暂停探针发送与污染判定，render/clear 不再写屏。 */
	suppressProbe() {
		this.probeSuppressed = true;
		this.cprProbePending = false;
		this.cprBaseline = null;
	}
	/** overlay 退出：恢复检测；基线作废，下一帧/探针重新建立，避免跨 alt screen 误判。 */
	resumeProbe() {
		this.probeSuppressed = false;
		this.cprBaseline = null;
	}
	/**
	* 请求发一次 CPR 探针（受节流与 pending 去重；无 onProbeRequest 时 no-op）。
	* 调用点：render 结束（帧后驻停基线）+ 空闲期定时器（检出 idle 污染）。
	* overlay 激活期间不发（见 suppressProbe）。
	*/
	requestProbe() {
		if (this.probeSuppressed) return;
		if (!this.onProbeRequest) return;
		const now = Date.now();
		if (this.cprProbePending && now - this.lastCprProbeMs < LiveEngine.CPR_PROBE_TIMEOUT_MS) return;
		if (!this.cprProbePending && now - this.lastCprProbeMs < LiveEngine.CPR_PROBE_MIN_INTERVAL_MS) return;
		this.cprProbePending = true;
		this.lastCprProbeMs = now;
		this.probeParked = {
			rowsUp: this.parkedRowsUp,
			col: this.parkedCol
		};
		this.onProbeRequest();
	}
	/**
	* 喂入一条 CPR 响应（row/col 1-based，来自 InputHandler 的 onCpr）。
	* 首个响应建立驻停基线；后续响应与基线比对——偏离说明光标被外来写入移动，
	* 标记污染并回调 onPolluted（由调用方触发重渲染走恢复路径）。
	* @param row - 光标行（1-based）
	* @param col - 光标列（1-based）
	*/
	noteCpr(row, col) {
		this.cprProbePending = false;
		if (this.probeSuppressed) return;
		this.cprReportRow = row;
		const probe = this.probeParked;
		if (probe && probe.rowsUp !== this.parkedRowsUp) return;
		const regionEndRow = row + (probe?.rowsUp ?? 0);
		const compareCol = probe?.col == null;
		if (!this.hasRendered || this.lastDisplayRows === 0) {
			this.cprBaseline = {
				row: regionEndRow,
				col
			};
			return;
		}
		if (!this.cprBaseline) {
			this.cprBaseline = {
				row: regionEndRow,
				col
			};
			return;
		}
		if (this.cprBaseline.row !== regionEndRow || compareCol && this.cprBaseline.col !== col) {
			this.polluted = true;
			this.cprBaseline = {
				row: regionEndRow,
				col
			};
			this.onPolluted?.();
			return;
		}
		this.cprBaseline = {
			row: regionEndRow,
			col
		};
	}
	/**
	* 更新 live region 行上限（终端 resize 时调用）。
	* maxRows 若大于终端高度，全量重写的 cursorUp 回顶量会超出屏幕导致错位，
	* 因此调用方应传入高度感知的值（如 `min(28, rows - 1)`）。
	* @param n - 新行上限；非正/非整数值被钳到 ≥1 的整数
	*/
	setMaxRows(n) {
		this.maxRows = Math.max(1, Math.floor(n));
	}
	/** 单个 logical line 占用的 display rows（wrapping-aware）。 */
	rowsForLine(text) {
		const width = this.stdout.columns || 80;
		if (width <= 0) return 1;
		const dw = displayWidth(text, { ambiguousAsWide: this.ambiguousWide() });
		if (dw === 0) return 1;
		return Math.ceil(dw / width);
	}
	/** 一组 LiveRegionLine 占用的总 display rows。 */
	countDisplayRows(lines) {
		let total = 0;
		for (const line of lines) total += this.rowsForLine(line.text);
		return total;
	}
	/**
	* 输入行归一化（2026-07-21 输入框重影修复）。
	*
	* LiveRegionLine 的契约是「单逻辑行」，但上游内容偶发携带嵌入换行——已证实的
	* 泄漏链：worker 多行 summary（review 门 evidence 用 `\n` 拼接）→
	* `progressLine: summary.slice(0, 80)` → FleetRegistry.activity → 舰队面板活动行。
	* 带 `\n` 的行在屏上占多个显示行，而 rowsForLine 基于 displayWidth
	* （string-width 剥控制符，`\n` 计 0 宽）按 1 行计 → lastDisplayRows 低于屏上
	* 实际行数 → 下一帧 cursorUp 回顶不足 → 旧帧顶部（输入框头行+边框）残留进
	* scrollback，正是「输入框重影叠屏」的形态。
	*
	* 处理：`\n` 展开为独立行；`\r`/`\t` 替换为空格（同样是 string-width 计 0 宽
	* 但终端会移动光标/跳列的字符）。内容侧净化（progressSnippet）是第一道防线，
	* 这里是引擎层兜底——任何未来新增的内容路径都不能再破坏行数追踪。
	*/
	normalizeLines(lines) {
		let dirty = false;
		for (const l of lines) if (l.text.includes("\n") || l.text.includes("\r") || l.text.includes("	")) {
			dirty = true;
			break;
		}
		if (!dirty) return lines;
		const out = [];
		for (const l of lines) {
			const cleaned = l.text.replace(/[\r\t]/g, " ");
			if (!cleaned.includes("\n")) {
				out.push(cleaned === l.text ? l : {
					...l,
					text: cleaned
				});
				continue;
			}
			for (const seg of cleaned.split("\n")) out.push({
				...l,
				text: seg
			});
		}
		return out;
	}
	/**
	* resize 协调：终端宽度变化时，已绘制的 live region 内容会被终端按新宽 reflow，
	* 其占用的 display rows 随之改变。但 `lastDisplayRows` 是上一帧在**旧宽度**下数的，
	* 若直接用于 `moveToTop`，cursorUp 量与屏上实际行数不符 → 回顶欠/过 → 旧帧顶部
	* 残留进 scrollback（多份不同宽度的 chrome/面板叠屏，见 resize 回归测试）。
	*
	* 修复：检测到宽度变化时，按**当前宽度**从 `lineCache` 重算 `lastDisplayRows`，
	* 使其与终端 reflow 后的屏上行数一致，再做相对回顶。
	*/
	reconcileWidth() {
		const currentColumns = this.stdout.columns || 80;
		if (this.hasRendered && this.lastDisplayRows > 0 && currentColumns !== this.lastColumns) this.lastDisplayRows = this.countDisplayRows(this.lineCache.map((text) => ({ text })));
		this.lastColumns = currentColumns;
	}
	/**
	* 渲染 live region（cursor-resident 协议，对标 aider mdstream / ink createIncremental）。
	*
	* 核心不变量：
	* - 渲染后光标**常驻 live region 最后一行末尾**（尾行不写 `\n`）。
	*   这避免了在终端底部因尾行换行触发滚屏 → 杜绝"贴底每帧滚动"的卡顿。
	* - 增量重绘用**相对光标移动**（cursorUp/cursorDown）回到区域顶，不使用
	*   SAVE/RESTORE 绝对光标——内容滚动后绝对坐标会失效错位。
	* - **行级 diff**：结构未变（行数 + 单显示行）时只重写变化的行，跳过未变行（少闪）。
	* - 整帧用 CSI 2026 同步输出包裹，原子刷新防撕裂。
	*
	* @param lines - 要显示的行（含 ANSI 格式化）
	* @param opts - reservedTail：超预算截断时恒保留的尾部行数（chrome 保护）
	*/
	render(lines, opts) {
		if (this.probeSuppressed) return;
		const bounded = this.applyRowBudget(this.normalizeLines(lines), opts?.reservedTail);
		const parking = this.computeParking(bounded);
		if (this.polluted) {
			this.polluted = false;
			this.reconcileWidth();
			const newDisplayRows = this.countDisplayRows(bounded);
			let body;
			if (this.hasRendered && this.lastDisplayRows > 0) {
				const climb = Math.min(Math.max(0, this.lastDisplayRows - 1 - this.parkedRowsUp), Math.max(0, this.cprReportRow - 1));
				body = (climb > 0 ? cursorUp(climb) : "") + "\r" + ANSI.ERASE_SCREEN_END + this.buildAppend(bounded);
			} else body = this.buildAppend(bounded);
			this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + body + this.buildParkSeq(parking) + ANSI.END_SYNC);
			this.lastDisplayRows = newDisplayRows;
			this.lineCache = bounded.map((l) => l.text);
			this.hasRendered = true;
			this.lastColumns = this.stdout.columns || 80;
			this.cprBaseline = null;
			this.setParked(parking);
			this.requestProbe();
			return;
		}
		const currentColumns = this.stdout.columns || 80;
		if (this.hasRendered && this.lastDisplayRows > 0 && currentColumns === this.lastColumns && bounded.length === this.lineCache.length && bounded.every((l, i) => l.text === this.lineCache[i])) {
			if (parking) this.reparkIfChanged(parking);
			return;
		}
		const widthChanged = this.hasRendered && this.lastDisplayRows > 0 && currentColumns !== this.lastColumns;
		this.reconcileWidth();
		const newDisplayRows = this.countDisplayRows(bounded);
		if (!this.hasRendered || this.lastDisplayRows === 0) {
			this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + this.buildAppend(bounded) + this.buildParkSeq(parking) + ANSI.END_SYNC);
			this.lastDisplayRows = newDisplayRows;
			this.lineCache = bounded.map((l) => l.text);
			this.hasRendered = true;
			this.cprBaseline = null;
			this.setParked(parking);
			this.requestProbe();
			return;
		}
		const prevDisplayRows = this.lastDisplayRows;
		const canDiff = !widthChanged && bounded.length === this.lineCache.length && bounded.every((l, i) => {
			const cached = this.lineCache[i];
			return cached !== void 0 && this.rowsForLine(l.text) === this.rowsForLine(cached);
		});
		const climbRows = prevDisplayRows - this.parkedRowsUp;
		const body = canDiff ? this.buildDiff(bounded, climbRows) : this.buildFullRewrite(bounded, climbRows);
		this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + body + this.buildParkSeq(parking) + ANSI.END_SYNC);
		this.lastDisplayRows = newDisplayRows;
		this.lineCache = bounded.map((l) => l.text);
		if (newDisplayRows !== prevDisplayRows) this.cprBaseline = null;
		this.setParked(parking);
		this.requestProbe();
	}
	/** 从 bounded 行里找 caret 标记行，算驻停点（距末行 display rows + 0-based 列）。 */
	computeParking(bounded) {
		const idx = bounded.findIndex((l) => l.caretCol != null);
		if (idx < 0) return null;
		let rowsUp = 0;
		for (let i = idx + 1; i < bounded.length; i++) {
			const line = bounded[i];
			if (line === void 0) continue;
			rowsUp += this.rowsForLine(line.text);
		}
		const caretLine = bounded[idx];
		if (caretLine === void 0 || caretLine.caretCol == null) return null;
		return {
			rowsUp,
			col: caretLine.caretCol
		};
	}
	/** 帧末驻停序列：末行尾 → caret 坐标（默认驻停但保持隐藏；env 仅控制可见性）。 */
	buildParkSeq(parking) {
		let seq = "";
		if (parking) {
			if (parking.rowsUp > 0) seq += cursorUp(parking.rowsUp);
			seq += cursorToCol(parking.col + 1);
		}
		if (this.hardwareCursorVisible) seq += parking ? ANSI.SHOW_CURSOR : ANSI.HIDE_CURSOR;
		return seq;
	}
	/** 更新驻停记账（须在 requestProbe 前调用——探针按它折算响应坐标）。 */
	setParked(parking) {
		this.parkedRowsUp = parking?.rowsUp ?? 0;
		this.parkedCol = parking?.col ?? null;
	}
	/** H2 路径专用：行未变、caret 变了 → 只发重定位序列（不重绘任何文字）。 */
	reparkIfChanged(parking) {
		if (this.parkedRowsUp === parking.rowsUp && this.parkedCol === parking.col) return;
		let seq = "";
		const delta = parking.rowsUp - this.parkedRowsUp;
		if (delta > 0) seq += cursorUp(delta);
		else if (delta < 0) seq += cursorDown(-delta);
		seq += cursorToCol(parking.col + 1);
		this.stdout.write(ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR + seq + (this.hardwareCursorVisible ? ANSI.SHOW_CURSOR : "") + ANSI.END_SYNC);
		this.setParked(parking);
		this.requestProbe();
	}
	/**
	* 行预算：内容超过 maxRows 时，**优先保留尾部 chrome**（GlanceBar + 输入框 + 提示），
	* 截断的是中段 dynamic（streaming tail / 工具输出）的较早部分。
	*
	* **预算按 display rows 计量**（非行数）：窄窗口下长正文/长输入折行后，
	* 行数 ≤ maxRows 也可能整帧超出终端高度——全量重写越过屏幕底部触发滚动，
	* 回顶量与屏上实际布局错位，旧帧正文残留并叠印在 chrome 之下
	* （小窗口打字时正文"泄露"到输入框底下的根因）。不变量：整帧恒 ≤ maxRows
	* display rows（= min(28, rows-1)），重写永不越底。
	*
	* - 全帧 display rows ≤ maxRows：全部保留。
	* - 未指定 reservedTail：按预算保留前若干行。
	* - 指定 reservedTail：尾部 N 行恒保留；剩余预算从 dynamic 段尾部回填。
	*   若 chrome 本身已超 maxRows，仍全部显示——宁可超行，也不能让输入框消失。
	*/
	applyRowBudget(lines, reservedTail) {
		if (this.countDisplayRows(lines) <= this.maxRows) return lines.slice();
		if (reservedTail === void 0 || reservedTail <= 0) {
			const kept = [];
			let rows = 0;
			for (const line of lines) {
				const r = this.rowsForLine(line.text);
				if (rows + r > this.maxRows) break;
				kept.push(line);
				rows += r;
			}
			return kept;
		}
		const tail = Math.min(reservedTail, lines.length);
		const tailLines = lines.slice(lines.length - tail);
		const tailRows = this.countDisplayRows(tailLines);
		const budget = this.maxRows - tailRows;
		if (budget <= 0) return tailLines.slice();
		const dynamic = lines.slice(0, lines.length - tail);
		const kept = [];
		let rows = 0;
		for (let i = dynamic.length - 1; i >= 0; i--) {
			const line = dynamic[i];
			if (line === void 0) continue;
			const r = this.rowsForLine(line.text);
			if (rows + r > budget) break;
			kept.unshift(line);
			rows += r;
		}
		return [...kept, ...tailLines];
	}
	/** Append 路径：行间 `\n`，尾行不带 `\n`（光标常驻最后一行末尾）。 */
	buildAppend(bounded) {
		let out = "";
		for (const [i, line] of bounded.entries()) {
			out += line.text;
			if (i < bounded.length - 1) out += "\n";
		}
		return out;
	}
	/** 相对光标回到 live region 顶部显示行（光标当前在最后一个显示行）。 */
	moveToTop(prevDisplayRows) {
		return prevDisplayRows > 1 ? cursorUp(prevDisplayRows - 1) : "";
	}
	/**
	* 全量重写：回顶 → 擦到屏幕末（覆盖旧的所有显示行，含 wrap）→ 重写全部行。
	* 尾行不带 `\n`，光标停在最后一行末尾。
	*/
	buildFullRewrite(bounded, prevDisplayRows) {
		let out = this.moveToTop(prevDisplayRows);
		out += "\r" + ANSI.ERASE_SCREEN_END;
		for (const [i, line] of bounded.entries()) {
			out += line.text;
			if (i < bounded.length - 1) out += "\n";
		}
		return out;
	}
	/**
	* 行级 diff（结构未变 + 每行 wrap 高度未变时调用，见 canDiff）：
	* 回顶后逐行处理——变化行清除其全部显示行后重写；未变行只按显示行数 cursorDown 跳过。
	* 不写任何 `\n`（cursorDown 在底行会被 clamp，不触发滚屏）。
	*
	* 光标步进不变量：每次迭代开始时光标位于「逻辑行 i 的首个显示行」，
	* 处理结束时（cursorDown 之前）位于「逻辑行 i 的最后一个显示行」，
	* 再 cursorDown(1) 进入下一逻辑行首行。变化行与未变行两条分支都满足该不变量。
	*/
	buildDiff(bounded, prevDisplayRows) {
		let out = this.moveToTop(prevDisplayRows);
		for (const [i, line] of bounded.entries()) {
			const text = line.text;
			const rows = this.rowsForLine(text);
			out += "\r";
			if (this.lineCache[i] !== text) {
				out += ANSI.ERASE_LINE;
				for (let k = 1; k < rows; k++) out += cursorDown(1) + "\r" + ANSI.ERASE_LINE;
				if (rows > 1) out += cursorUp(rows - 1);
				out += text;
			} else if (rows > 1) out += cursorDown(rows - 1);
			if (i < bounded.length - 1) out += cursorDown(1);
		}
		return out;
	}
	/**
	* 清空 live region（擦除但不回滚 scrollback）。
	* 用于流式输出完成、切换到新 turn 时。
	*
	* 光标常驻协议下，光标在最后一个显示行——回顶后擦到屏幕末，光标停在
	* 区域起始处。后续 append/commit 从这里开始写，干净无空白带。
	*/
	clear() {
		if (this.probeSuppressed) return;
		this.reconcileWidth();
		if (this.lastDisplayRows === 0) return;
		this.stdout.write(ANSI.HIDE_CURSOR + this.moveToTop(this.lastDisplayRows - this.parkedRowsUp) + "\r" + ANSI.ERASE_SCREEN_END);
		this.lastDisplayRows = 0;
		this.lineCache = [];
		this.setParked(null);
		this.polluted = false;
	}
	/**
	* 擦除 live region 并把光标停在其起始行——为向 scrollback commit 内容腾位。
	*
	* 正确的 mid-stream commit 协议：
	*   live.clearForCommit() → commit.write(...) → live.render(...)
	*
	* cursor-resident 协议下与 clear() 行为一致（光标都回到区域起始处）。
	*/
	clearForCommit() {
		this.clear();
	}
	/**
	* 渲染单行动态文本（如 streaming 行、thinking 指示器）。
	* 简化版：擦除上一帧内容 → 写入新内容。
	* @param text - 该行的 ANSI 格式化文本
	*/
	renderLine(text) {
		this.render([{ text }]);
	}
	/** 重置渲染状态（用于 rewind 等需要全量重绘的场景） */
	reset() {
		this.lastDisplayRows = 0;
		this.lineCache = [];
		this.hasRendered = false;
		this.setParked(null);
	}
};
//#endregion
//#region lib/types/engine/write-batcher.js
/**
* T9 WriteBatcher — 渲染帧合并器（microtask 合并 + 16ms 帧节流）。
*
* 替代 Ink 的 RenderBatcher（依赖 React 调度），直接将多次 render 调用
* 合并为一次 LiveEngine.render()。
*
* 策略（2026-07-24 P2，对标 pi-tui MIN_RENDER_INTERVAL_MS=16）：
* - 距上次 flush ≥16ms：microtask 刷新（leading edge，低延迟路径不变）。
* - 距上次 flush <16ms：setTimeout(剩余) 尾沿（trailing edge）——高吞吐
*   小 delta（流式 token / IME 整段上屏）下帧率封顶 ~60fps，渲染成本从
*   「每事件圈一帧」降为恒定上限；窗口内多次 schedule 合并为一帧。
* - flushNow()：critical 路径（提交/commit/phase 切换）同步穿透，不受
*   节流限制，并作废排队的 microtask 与定时器。
*
* BlockStreamWriter.onBlock → WriteBatcher.flush() → LiveEngine.render()
*
* 健壮性：onFlush 在 microtask/定时器中执行，若直接抛出会变成 unhandled
* rejection 崩进程。故 flush 用 try/catch 包裹，错误交给 onError（默认
* 记录到 stderr 但不中断 TUI），保证一次渲染异常不会让整个终端崩溃。
*/
/** 帧最小间隔（~60fps 上限）。 */
const MIN_FRAME_INTERVAL_MS = 16;
/**
* 渲染帧合并器：schedule() 的多次调用合并为一次 onFlush（microtask 或 16ms
* 尾沿），flushNow() 同步穿透。onFlush 抛错交给 onError（默认写 stderr），
* 不会中断 TUI 进程。
*/
var WriteBatcher = class {
	pending = false;
	generation = 0;
	lastFlushAt = 0;
	timer = null;
	onFlush;
	onError;
	constructor(onFlush, onError) {
		this.onFlush = onFlush;
		this.onError = onError ?? ((err) => {
			try {
				process.stderr.write(`WriteBatcher flush error: ${String(err)}\n`);
			} catch {}
		});
	}
	/** 请求刷新：距上次 flush ≥16ms 走 microtask，否则 16ms 尾沿（窗口内合并）。 */
	schedule() {
		if (this.pending) return;
		this.pending = true;
		const wait = 16 - (Date.now() - this.lastFlushAt);
		if (wait <= 0) {
			const generation = this.generation;
			Promise.resolve().then(() => {
				if (!this.pending || generation !== this.generation) return;
				this.pending = false;
				this.runFlush();
			});
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.pending) return;
			this.pending = false;
			this.runFlush();
		}, wait);
		this.timer.unref();
	}
	/** Immediately flush once and invalidate any previously queued microtask/timer. */
	flushNow() {
		this.generation++;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending = false;
		this.runFlush();
	}
	runFlush() {
		this.lastFlushAt = Date.now();
		try {
			this.onFlush();
		} catch (err) {
			this.onError(err);
		}
	}
};
//#endregion
//#region lib/types/engine/input-handler.js
/**
* T9 InputHandler — 统一键盘输入处理（替代 Ink 的 useInput hooks）。
*
* 核心功能：
* - 设置 stdin raw mode，逐字节读取
* - 解析 UTF-8 字符 + ANSI escape sequences（方向键、功能键等）
* - 支持多种输入模式：normal / input / overlay / vim
* - 分发按键事件到注册的处理器
*
* 按键类型分类（参考 Node.js readline + Ink 的 keypress 解析）：
* - 可打印字符（UTF-8）：直接分发
* - 控制字符（Ctrl+A..Z, Tab, Enter, Escape, Backspace）
* - ANSI escape sequences（方向键、Home/End、PgUp/PgDn、F1-F12）
* - 鼠标事件（SGR mouse protocol）— 暂不处理
*/
/** Bracketed paste 标记（DEC 2004） */
const PASTE_START = "\x1B[200~";
const PASTE_END = "\x1B[201~";
/**
* 尚未收完的 CPR 响应形状：`\x1B[66`、`\x1B[66;`、`\x1B[66;1`（缺结尾的 `R`）。
*
* CPR 是终端对 DSR `\x1B[6n` 探针的自动回吐，不是用户按键。它一旦被超时兜底
* 腰斩，剩余部分不该退化成可打印字符——那会让 `[66;` 这样的残片出现在输入框里。
* 完整体由 parseInput 的 CPR 分支正常消费，这里只管被截断的半截。
*/
const CPR_PARTIAL_RE = /^\x1B\[\d+(;\d*)?$/;
/**
* Ctrl+key 的 ASCII 范围：Ctrl+A = 0x01 .. Ctrl+Z = 0x1A
* 以及一些特殊控制字符。
*/
const CTRL_CODES = {
	1: "ctrl_a",
	2: "ctrl_b",
	3: "ctrl_c",
	4: "ctrl_d",
	5: "ctrl_e",
	6: "ctrl_f",
	8: "ctrl_h",
	9: "tab",
	10: "ctrl_j",
	11: "ctrl_k",
	12: "ctrl_l",
	13: "return",
	14: "ctrl_n",
	15: "ctrl_o",
	16: "ctrl_p",
	17: "ctrl_q",
	18: "ctrl_r",
	19: "ctrl_s",
	20: "ctrl_t",
	21: "ctrl_u",
	22: "ctrl_v",
	23: "ctrl_w",
	24: "ctrl_x",
	25: "ctrl_y",
	26: "ctrl_z",
	29: "ctrl_]",
	30: "ctrl_.",
	31: "ctrl_minus",
	27: "escape",
	127: "backspace"
};
const ANSI_ESCAPE_MAP = {
	"[A": "up",
	"[B": "down",
	"[C": "right",
	"[D": "left",
	"[H": "home",
	"[F": "end",
	"[2~": "insert",
	"[3~": "delete",
	"[5~": "pageup",
	"[6~": "pagedown",
	"OP": "f1",
	"OQ": "f2",
	"OR": "f3",
	"OS": "f4",
	"[15~": "f5",
	"[17~": "f6",
	"[18~": "f7",
	"[19~": "f8",
	"[20~": "f9",
	"[21~": "f10",
	"[23~": "f11",
	"[24~": "f12",
	"[Z": "shift_tab"
};
/**
* 统一键盘输入处理器：构造时把 stdin 置为 raw mode 并接管 data 事件，
* 解析 UTF-8 字符 / ANSI 转义序列 / bracketed paste / CPR 响应后分发给
* 注册的处理器。用完必须调用 dispose() 恢复终端默认行为。
*/
var InputHandler = class {
	stdin;
	mode;
	handlers = /* @__PURE__ */ new Map();
	pasteHandlers = /* @__PURE__ */ new Set();
	/** CPR（cursor position report）处理器：终端对 DSR `\x1B[6n` 的响应
	*  `\x1B[{row};{col}R` 不是按键，单独走这个通道（LiveEngine 自愈用）。 */
	cprHandlers = /* @__PURE__ */ new Set();
	escapeTimeoutMs;
	partialSequenceTimeoutMs;
	escapeTimer = null;
	/** 当为 true 时，单独的 ESC 字节立即派发为 escape，不等待超时。
	*  用于 overlay 激活场景，避免 ESC 关闭/退出有 40ms 可感知延迟。 */
	escapeImmediate = false;
	pasteActive = false;
	pasteBuffer = "";
	/**
	* 跨 chunk 不完整代理对缓冲：上游（stdin）可能把同一 UTF-16 代理对的两个
	* code unit 拆到两个 `data` 事件里（高强度输入 + 终端流量控制时偶发）。
	* 若不缓冲，第一段被当成"可打印字符"派发，char 字段就是孤立的
	* high-surrogate `\uD83D`——输入框会显示成豆腐方块，emoji 簇不可用。
	* 这里在 handleData 入口预拼，在派发前剥离尾部 high-surrogate。
	*/
	pendingData = "";
	/**
	* 跨 chunk 输入字节缓冲。ESC 序列、bracketed paste 起止标记都可能被拆到
	* 多个 `data` 事件里；保留未处理完的尾部，等待后续字节完整后再派发。
	*/
	inputBuffer = "";
	constructor(options) {
		this.stdin = options.stdin;
		this.mode = options.mode ?? "input";
		this.escapeTimeoutMs = options.escapeTimeoutMs ?? 80;
		this.partialSequenceTimeoutMs = options.partialSequenceTimeoutMs ?? 500;
		if (this.stdin.isTTY) try {
			this.stdin.setRawMode(true);
		} catch {}
		this.stdin.resume();
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (data) => {
			this.handleData(data);
		});
	}
	/**
	* 注册按键处理器。
	* @param event - 按键名（KeyName）、`'*'` 通配、或 `mode:keyName` 模式限定形式
	* @param handler - 命中时调用的处理器
	* @returns 取消注册的函数
	*/
	onKey(event, handler) {
		let set = this.handlers.get(event);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.handlers.set(event, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}
	/**
	* 注册所有按键的处理器（通配符）。
	* @param handler - 每个按键事件都会调用的处理器
	* @returns 取消注册的函数
	*/
	onAnyKey(handler) {
		return this.onKey("*", handler);
	}
	/**
	* 注册 bracketed paste 处理器（一次性收到整段粘贴文本，已规范化换行）。
	* @param handler - 接收整段粘贴文本的处理器
	* @returns 取消注册的函数
	*/
	onPaste(handler) {
		this.pasteHandlers.add(handler);
		return () => {
			this.pasteHandlers.delete(handler);
		};
	}
	/**
	* 注册 CPR 处理器（终端光标位置报告，row/col 为 1-based）。
	* @param handler - 接收 row/col 的处理器
	* @returns 取消注册的函数
	*/
	onCpr(handler) {
		this.cprHandlers.add(handler);
		return () => {
			this.cprHandlers.delete(handler);
		};
	}
	/**
	* 切换输入模式（影响 `mode:keyName` 形式处理器的路由）。
	* @param mode - 新的输入模式
	*/
	setMode(mode) {
		this.mode = mode;
	}
	/**
	* 获取当前输入模式。
	* @returns 当前输入模式
	*/
	getMode() {
		return this.mode;
	}
	/**
	* 设置单独 ESC 字节是否立即派发。
	* overlay 激活时设为 true，避免 ESC 关闭/退出等待超时。
	* @param immediate - true 立即派发孤立 ESC；false 恢复超时判定
	*/
	setEscapeImmediate(immediate) {
		this.escapeImmediate = immediate;
	}
	/** 关闭 raw mode，恢复终端默认行为。 */
	dispose() {
		if (this.escapeTimer) {
			clearTimeout(this.escapeTimer);
			this.escapeTimer = null;
		}
		this.pendingData = "";
		this.inputBuffer = "";
		this.stdin.removeAllListeners("data");
		if (this.stdin.isTTY) try {
			this.stdin.setRawMode(false);
		} catch {}
		this.stdin.pause();
		this.handlers.clear();
		this.pasteHandlers.clear();
		this.cprHandlers.clear();
	}
	handleData(data) {
		if (this.pendingData) {
			data = this.pendingData + data;
			this.pendingData = "";
		}
		if (data.length > 0) {
			const lastCode = data.charCodeAt(data.length - 1);
			if (lastCode >= 55296 && lastCode <= 56319) {
				this.pendingData = data.slice(-1);
				data = data.slice(0, -1);
				if (!data) return;
			}
		}
		this.inputBuffer += data;
		if (this.escapeTimer) {
			clearTimeout(this.escapeTimer);
			this.escapeTimer = null;
		}
		this.processInputBuffer();
	}
	/**
	* 从缓冲区起始位置连续派发普通按键，直到遇到不完整序列或缓冲区末尾。
	* 返回实际消费的字节数。
	*/
	dispatchKeys(buf) {
		let i = 0;
		while (i < buf.length) {
			const parsed = this.parseInput(buf.slice(i));
			if (parsed.consumed === 0) break;
			if (parsed.key) {
				if (parsed.key.name === "return" && i + parsed.consumed < buf.length) parsed.key.inline = true;
				this.dispatch(parsed.key);
			}
			i += parsed.consumed;
		}
		return i;
	}
	/** 处理跨 chunk 缓冲的输入缓冲区，按 paste → ESC 序列 → 普通字符优先级解析。 */
	processInputBuffer() {
		while (this.inputBuffer.length > 0) {
			if (this.pasteActive) {
				const endIdx = this.inputBuffer.indexOf(PASTE_END);
				if (endIdx !== -1) {
					this.pasteBuffer += this.inputBuffer.slice(0, endIdx);
					const text = this.pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
					this.pasteActive = false;
					this.pasteBuffer = "";
					for (const handler of this.pasteHandlers) handler(text);
					this.inputBuffer = this.inputBuffer.slice(endIdx + 6);
					continue;
				}
				const partial = getPartialSuffix(this.inputBuffer, PASTE_END);
				if (partial > 0) {
					this.pasteBuffer += this.inputBuffer.slice(0, -partial);
					this.inputBuffer = this.inputBuffer.slice(-partial);
					break;
				}
				this.pasteBuffer += this.inputBuffer;
				this.inputBuffer = "";
				break;
			}
			const startIdx = this.inputBuffer.indexOf(PASTE_START);
			if (startIdx !== -1) {
				const prefix = this.inputBuffer.slice(0, startIdx);
				const consumed = this.dispatchKeys(prefix);
				if (consumed < prefix.length) {
					this.inputBuffer = this.inputBuffer.slice(consumed);
					break;
				}
				this.inputBuffer = this.inputBuffer.slice(startIdx + 6);
				this.pasteActive = true;
				this.pasteBuffer = "";
				continue;
			}
			const partialStart = getPartialSuffix(this.inputBuffer, PASTE_START);
			if (partialStart > 0) {
				const prefixLen = this.inputBuffer.length - partialStart;
				const consumed = this.dispatchKeys(this.inputBuffer.slice(0, prefixLen));
				this.inputBuffer = this.inputBuffer.slice(consumed);
				break;
			}
			const consumed = this.dispatchKeys(this.inputBuffer);
			this.inputBuffer = this.inputBuffer.slice(consumed);
			break;
		}
		if (this.inputBuffer === "\x1B" && !this.pasteActive) {
			if (this.escapeImmediate) {
				this.inputBuffer = "";
				this.dispatch({
					raw: "\x1B",
					char: "",
					name: "escape",
					ctrl: false,
					meta: false,
					shift: false
				});
			} else this.escapeTimer = setTimeout(() => {
				this.escapeTimer = null;
				if (this.inputBuffer === "\x1B" && !this.pasteActive) {
					this.inputBuffer = "";
					this.dispatch({
						raw: "\x1B",
						char: "",
						name: "escape",
						ctrl: false,
						meta: false,
						shift: false
					});
				}
			}, this.escapeTimeoutMs);
		} else if (!this.pasteActive && (this.inputBuffer.startsWith("\x1B[") || this.inputBuffer.startsWith("\x1BO"))) {
			const flushPartial = () => {
				if (this.pasteActive || !this.inputBuffer.startsWith("\x1B[") && !this.inputBuffer.startsWith("\x1BO")) return;
				if (CPR_PARTIAL_RE.test(this.inputBuffer)) {
					this.inputBuffer = "";
					return;
				}
				this.dispatch({
					raw: "\x1B",
					char: "",
					name: "unknown",
					ctrl: false,
					meta: false,
					shift: false
				});
				this.inputBuffer = this.inputBuffer.slice(1);
				this.processInputBuffer();
			};
			if (this.escapeImmediate) flushPartial();
			else if (!this.escapeTimer) this.escapeTimer = setTimeout(() => {
				this.escapeTimer = null;
				flushPartial();
			}, this.partialSequenceTimeoutMs);
		}
	}
	/** 把按键分发到 name / 通配 / mode 前缀三类处理器。 */
	dispatch(key) {
		const nameSet = this.handlers.get(key.name);
		if (nameSet) for (const handler of nameSet) handler(key);
		const wildSet = this.handlers.get("*");
		if (wildSet) for (const handler of wildSet) handler(key);
		const modeSet = this.handlers.get(`${this.mode}:${key.name}`);
		if (modeSet) for (const handler of modeSet) handler(key);
	}
	/**
	* 解析 data 首部的一个按键事件 + 实际消费的 code unit 数。
	*
	* 返回 { key: null, consumed: 0 } 表示"等后续字节"（孤 ESC 字节、跨 chunk
	* 的 CSI/SS3 序列）；否则 key 非 null，consumed 告诉调用方已消费的字节数。
	*/
	parseInput(data) {
		if (data.length === 0) return {
			key: null,
			consumed: 0
		};
		if (data.startsWith("\x1B")) {
			if (data.length === 1) return {
				key: null,
				consumed: 0
			};
			const csiMatch = data.match(/^\x1B\[[0-9;:]*[A-Za-z~]/);
			if (csiMatch) {
				const seq = csiMatch[0];
				const cprMatch = seq.match(/^\x1B\[(\d+);(\d+)R$/);
				if (cprMatch) {
					for (const handler of this.cprHandlers) handler(Number(cprMatch[1]), Number(cprMatch[2]));
					return {
						key: null,
						consumed: seq.length
					};
				}
				const enhanced = decodeEnhancedKey(seq);
				if (enhanced !== null) {
					if ("skip" in enhanced) return {
						key: null,
						consumed: seq.length
					};
					return {
						key: {
							raw: seq,
							char: enhanced.char,
							name: enhanced.name,
							ctrl: enhanced.ctrl,
							meta: enhanced.meta,
							shift: enhanced.shift
						},
						consumed: seq.length
					};
				}
				const name = this.resolveEscapeSequence(seq);
				const meta = seq.includes(";3") || seq.includes(";4");
				const shift = seq.includes(";2") || name === "shift_tab";
				return {
					key: {
						raw: seq,
						char: "",
						name: name ?? "unknown",
						ctrl: false,
						meta,
						shift
					},
					consumed: seq.length
				};
			}
			const ss3Match = data.match(/^\x1BO[A-Za-z]/);
			if (ss3Match) {
				const seq = ss3Match[0];
				return {
					key: {
						raw: seq,
						char: "",
						name: this.resolveEscapeSequence(seq) ?? "unknown",
						ctrl: false,
						meta: false,
						shift: false
					},
					consumed: seq.length
				};
			}
			if (data.length >= 2 && data[1] !== "[" && data[1] !== "O") {
				const char = data[1];
				if (char === void 0) return {
					key: null,
					consumed: 0
				};
				if (char === "\r") return {
					key: {
						raw: data.slice(0, 2),
						char: "",
						name: "return",
						ctrl: false,
						meta: true,
						shift: false
					},
					consumed: 2
				};
				const ctrlName = CTRL_CODES[char.charCodeAt(0)];
				if (ctrlName !== void 0) return {
					key: {
						raw: data.slice(0, 2),
						char: "",
						name: ctrlName,
						ctrl: false,
						meta: true,
						shift: false
					},
					consumed: 2
				};
				const isUpper = char >= "A" && char <= "Z";
				return {
					key: {
						raw: data.slice(0, 2),
						char,
						name: "unknown",
						ctrl: false,
						meta: true,
						shift: isUpper
					},
					consumed: 2
				};
			}
			if (/^\x1B(\[([0-9;:]*)|O)$/.test(data)) return {
				key: null,
				consumed: 0
			};
			return {
				key: {
					raw: "\x1B",
					char: "",
					name: "unknown",
					ctrl: false,
					meta: false,
					shift: false
				},
				consumed: 1
			};
		}
		const code = data.codePointAt(0);
		if (code === void 0) return {
			key: null,
			consumed: 0
		};
		if (code <= 31 || code === 127) {
			const name = CTRL_CODES[code] ?? "unknown";
			return {
				key: {
					raw: data.slice(0, 1),
					char: "",
					name,
					ctrl: code <= 31 && code !== 9 && code !== 10 && code !== 13,
					meta: false,
					shift: false
				},
				consumed: 1
			};
		}
		const charLen = code > 65535 ? 2 : 1;
		const char = data.slice(0, charLen);
		return {
			key: {
				raw: char,
				char,
				name: char === " " ? "space" : "unknown",
				ctrl: false,
				meta: false,
				shift: char !== char.toLowerCase() && char !== char.toUpperCase() ? false : char === char.toUpperCase() && char.toLowerCase() !== char.toUpperCase()
			},
			consumed: charLen
		};
	}
	resolveEscapeSequence(seq) {
		const body = seq.slice(1);
		const direct = ANSI_ESCAPE_MAP[body];
		if (direct) return direct;
		const modifyOtherKeysMatch = body.match(/^\[(\d+);(\d+)u$/);
		if (modifyOtherKeysMatch) {
			const code = Number(modifyOtherKeysMatch[1]);
			if (code === 13) return "return";
			if (code === 9) return "shift_tab";
		}
		const modMatch = body.match(/^\[(\d+);(\d+)([A-H~])$/);
		if (modMatch) {
			const suffix = `[${modMatch[3]}`;
			const baseName = ANSI_ESCAPE_MAP[suffix];
			if (baseName) return baseName;
		}
		const prefixMatch = body.match(/^\[(\d+)([~])$/);
		if (prefixMatch) {
			const suffix = `[${prefixMatch[2]}`;
			const baseName = ANSI_ESCAPE_MAP[suffix];
			if (baseName) return baseName;
		}
		return null;
	}
};
/**
* Kitty CSI u / xterm modifyOtherKeys：功能键、Ctrl+字母、带修饰的可打印键
* （天枢 59d00152 同步）。Kitty 协议形如 `CSI code:shifted;base:layout;
* mod:event u`——event 3 是 release（按下+释放不误算两次 Ctrl+C），冒号段
* 跳过；xterm 形如 `CSI 27;mod;code~`。
*/
function decodeEnhancedKey(seq) {
	const body = seq.startsWith("\x1B") ? seq.slice(1) : seq;
	const kitty = body.match(/^\[(\d+)(?::[^;]*)?(?:;(\d+)(?::(\d+))?)?(?:;(\d+))?(?:;[^u]*)?u$/);
	if (kitty !== null) {
		if ((kitty[3] !== void 0 ? Number(kitty[3]) : kitty[4] !== void 0 ? Number(kitty[4]) : 1) === 3) return { skip: true };
		return enhancedKeyFromCode(Number(kitty[1]), kitty[2] === void 0 ? 1 : Number(kitty[2]));
	}
	const xterm = body.match(/^\[27;(\d+);(\d+)~$/);
	if (xterm !== null) return enhancedKeyFromCode(Number(xterm[2]), Number(xterm[1]));
	return null;
}
/**
* Kitty 修饰键：1 + shift + alt*2 + ctrl*4。flag 1 下 Ctrl+C 是 code 99（'c'）
* + mod 5。Ctrl+字母与控制码映射到既有 ctrl_* 名；Ctrl+Enter（code 13 +
* ctrl 位，如 CSI 13;5u）映射为 ctrl_return（Shift+Enter 等不含 ctrl 位的
* 修饰 Enter 仍是 return，shift/meta 位经返回值保留）；带修饰的可打印键保留
* char（Alt+数字等场景由上层消费）。
*/
function enhancedKeyFromCode(code, mod) {
	const bits = Math.max(0, mod - 1);
	const shift = (bits & 1) !== 0;
	const meta = (bits & 2) !== 0;
	const ctrl = (bits & 4) !== 0;
	let name = null;
	let char = "";
	if (code === 27) name = "escape";
	else if (code === 13) name = ctrl ? "ctrl_return" : "return";
	else if (code === 9) name = shift ? "shift_tab" : "tab";
	else if (code === 127 || code === 8) name = "backspace";
	else if (ctrl && code >= 97 && code <= 122) name = CTRL_CODES[code - 96] ?? "unknown";
	else if (ctrl && code >= 65 && code <= 90) name = CTRL_CODES[code - 64] ?? "unknown";
	else if (code >= 1 && code <= 26) name = CTRL_CODES[code] ?? "unknown";
	else if (ctrl && code === 46) name = "ctrl_.";
	else if (ctrl && (code === 45 || code === 95)) name = "ctrl_minus";
	else if (ctrl && code === 93) name = "ctrl_]";
	else if (ctrl && code === 91) name = "escape";
	if (name === null && code >= 32 && code !== 127) {
		char = String.fromCodePoint(code);
		name = char === " " ? "space" : "unknown";
	}
	if (name === null) return null;
	return {
		name,
		ctrl,
		meta,
		shift,
		char
	};
}
/** 返回 `buf` 后缀中是 `marker` 前缀的最长长度（0 表示没有）。
*  用于 bracketed paste 起止标记跨 chunk 时保留不完整尾部。 */
function getPartialSuffix(buf, marker) {
	const max = Math.min(marker.length - 1, buf.length);
	for (let len = max; len > 0; len--) if (buf.endsWith(marker.slice(0, len))) return len;
	return 0;
}
/** 记录 → 序列列表（app 层传 `remapSequences(prefs.vimInsertRemaps)` 即可）。 */
function remapSequences(remaps) {
	if (!remaps) return [];
	return Object.entries(remaps).filter(([seq, action]) => action === "esc" && [...seq].length === 2).map(([seq]) => seq);
}
/** insert 模式两键序列缓冲状态机（每 InputLine 一个；vim 关闭时恒不构造）。 */
var InsertRemapper = class {
	seqs;
	heads;
	pending = null;
	constructor(sequences) {
		this.seqs = sequences.filter((s) => [...s].length === 2);
		this.heads = new Set(this.seqs.map((s) => [...s][0] ?? ""));
	}
	/**
	* 字符 ch 已插入后调用（cursorAfter = 插入后的光标位）。
	* 返回数字 = 命中序列：值为缓冲首字符的起始偏移，调用方应回删该字符、
	* markInsertDirty、退出 insert（刚插入的 ch 由调用方一并删除）。
	* 返回 null = 正常输入；ch 为某序列首字符时记为缓冲。
	*/
	onChar(ch, cursorAfter, now) {
		const p = this.pending;
		this.pending = null;
		if (p !== null && cursorAfter === p.cursor + ch.length && now - p.at <= 1e3 && this.seqs.includes(p.ch + ch)) return p.cursor - p.ch.length;
		if (this.heads.has(ch)) this.pending = {
			ch,
			cursor: cursorAfter,
			at: now
		};
		return null;
	}
	/** 模式切换 / 提交 / 清空时失效缓冲（光标连续性已防误删，此处兜底）。 */
	reset() {
		this.pending = null;
	}
};
//#endregion
//#region lib/types/engine/vim-input.js
/**
* T9 VimInput — 输入行 vim 键位引擎（issue #51）。
*
* 键位对标（外部竞品基准，2026-08-27）：
* - Claude Code interactive-mode 的 Vim 模式表（主基准）：
*   h j k l Space / w e b W B E / 0 $ ^ / gg G / f F t T ; , /
*   x X dd D dw de db cc C cw ce cb s S yy Y yw ye yb p P J u . 、
*   文本对象 iw aw iW aW；数字前缀 count；visual v/V 及同族 motion 与操作。
* - Gemini CLI vi 基线：Esc 进 NORMAL、基础导航与行首尾（真子集，自动覆盖）。
*
* 有意偏差（CC 有、本输入框不做）：>< 缩进、引号/括号文本对象、m 标记、
* 块选择 Ctrl+V、宏 q、寄存器切换 "。'/' 不做行内搜索而是打开历史搜索 overlay
* （对齐 CC「/ = 反向历史搜索」注记）。`.` 重放覆盖本引擎产生的全部变更命令；
* insert 段记录「进入步骤 + 连续键入文本」，出现删除/粘贴等破坏性插入即放弃记录。
*
* 架构：纯状态机 + 注入宿主面（VimHost）。引擎只认「缓冲值 + 光标 + 少量突变
* 原语」；undo 快照由 host.spliceRange 统一记录，`.` 重放闭包复用同一条管线
* （重放即普通编辑，天然可再撤销）。词类扫描走 code-point 粒度（\w/CJK 均 BMP），
* 单字符增删与横向移动使用宿主 grapheme 步进（折叠粘贴标记保持原子）。
*/
/**
* 词类口径：word = \w + CJK（与 input-line WORD_CHAR_RE 一致——中文 prompt 连续
* 段视为词而非标点）；big-word 模式把 punct 并入 word（只区分 space/non-space）。
*/
const WORD_CHAR_RE$1 = /^(?:\w|[一-鿿㐀-䶿豈-﫿぀-ヿ가-힯])$/u;
function classOfCp(cp, big) {
	if (cp === "" || /\s/u.test(cp)) return "space";
	if (big) return "word";
	return WORD_CHAR_RE$1.test(cp) ? "word" : "punct";
}
var VimInput = class {
	host;
	count = 0;
	pendingOp = null;
	awaitG = false;
	awaitFind = null;
	awaitReplace = false;
	/** 文本对象二级等待：操作符后的 i|a 已敲入，等对象字母 w/W。 */
	awaitObjectOuter = null;
	/** 操作符等待下的 gg 二段键。 */
	awaitOperatorG = false;
	lastFind = null;
	dotSteps = null;
	replaying = false;
	insertPrefix = null;
	insertText = "";
	insertOk = false;
	constructor(host) {
		this.host = host;
	}
	/** 运行时关停 vim 键位时复位全部 pending 态（防止半截解析吞后续按键）。 */
	reset() {
		this.count = 0;
		this.pendingOp = null;
		this.awaitG = false;
		this.awaitFind = null;
		this.awaitReplace = false;
		this.awaitObjectOuter = null;
		this.awaitOperatorG = false;
		this.insertPrefix = null;
		this.insertOk = false;
		this.insertText = "";
		this.dotSteps = null;
	}
	handleNormal(name, ch, ctrl) {
		if (name === "escape") return this.cancelPending();
		if (this.awaitReplace) {
			this.awaitReplace = false;
			if (!isPrintable(ch)) return "none";
			const n = Math.max(1, this.takeCount());
			return this.recordAndRun([() => {
				this.replaceUnderCursor(ch, n);
			}]);
		}
		if (this.awaitFind !== null) {
			const m = this.awaitFind;
			this.awaitFind = null;
			if (!isPrintable(ch)) return "none";
			const n = Math.max(1, this.takeCount());
			const find = {
				m,
				ch
			};
			this.lastFind = find;
			const op = this.pendingOp;
			if (op !== null) {
				this.pendingOp = null;
				return this.finishOpFind(op, find, n);
			}
			return this.finishFind(find, n);
		}
		if (this.awaitObjectOuter !== null) return this.resolveObject(ch);
		if (this.pendingOp !== null) return this.continueOperator(ch);
		if (this.awaitG) {
			this.awaitG = false;
			if (ch !== "g") return "none";
			return this.lineJump(Math.max(1, this.takeCount()) - 1);
		}
		if (/^[1-9]$/.test(ch)) {
			this.count = Math.min(this.count * 10 + Number(ch), 9999);
			return "none";
		}
		switch (name) {
			case "left":
			case "ctrl_b": return this.nav(() => this.hGraphN(-1));
			case "right":
			case "ctrl_f": return this.nav(() => this.hGraphN(1));
			case "home": return this.nav(() => this.jumpTo(this.lineStart(this.cursor())));
			case "end": return this.nav(() => this.jumpTo(this.lineEndPos(this.cursor())));
			case "up": return this.edgeNav("prev", -1);
			case "down": return this.edgeNav("next", 1);
			case "backspace": return this.deleteChars(Math.max(1, this.takeCount()), true);
			case "delete": return this.deleteChars(Math.max(1, this.takeCount()), false);
		}
		if (name.startsWith("ctrl_")) switch (name) {
			case "ctrl_r": return this.changedIf(() => {
				this.host.redoOnce();
			});
			case "ctrl_z":
			case "ctrl_minus": return this.changedIf(() => {
				this.host.undoOnce();
			});
			case "ctrl_n": return this.historyFallbackResult("next");
			case "ctrl_p": return this.historyFallbackResult("prev");
			default: return "none";
		}
		const key = ch === " " ? " " : ch;
		switch (key) {
			case "u": return this.changedIf(() => {
				this.host.undoOnce();
			});
			case "U": return this.recordAndRun([() => {
				this.transformLine((seg) => seg.toUpperCase());
			}]);
			case "~": return this.recordAndRun([() => {
				this.toggleCaseChar();
			}]);
			case "/":
				this.cancelPending();
				this.host.openHistorySearch();
				return "none";
			case " ":
			case "l": return this.nav(() => this.hGraphN(1));
			case "h": return this.nav(() => this.hGraphN(-1));
			case "j": return this.edgeNav("next", 1);
			case "k": return this.edgeNav("prev", -1);
			case "w": return this.countChain((off) => this.fwdWord(off, false));
			case "W": return this.countChain((off) => this.fwdWord(off, true));
			case "b": return this.countChain((off) => this.backWord(off, false));
			case "B": return this.countChain((off) => this.backWord(off, true));
			case "e": return this.countChain((off) => this.fwdWordEnd(off, false));
			case "E": return this.countChain((off) => this.fwdWordEnd(off, true));
			case "f":
			case "F":
			case "t":
			case "T":
				this.awaitFind = key;
				return "none";
			case ";": return this.repeatFind(false);
			case ",": return this.repeatFind(true);
			case "g":
				this.awaitG = true;
				return "none";
			case "G": {
				const nLine = Math.max(1, this.takeCount());
				if (nLine > 1) return this.lineJump(nLine - 1);
				return this.nav(() => this.jumpTo(this.value().length));
			}
			case "0": return this.nav(() => this.jumpTo(this.lineStart(this.cursor())));
			case "^": return this.nav(() => this.jumpTo(this.firstNonBlank()));
			case "$": return this.dollarMotion();
			case "i": return this.enterInsertFrom([]);
			case "I": return this.enterInsertFrom([() => {
				this.jumpTo(this.firstNonBlank());
			}]);
			case "a": return this.enterInsertFrom([() => {
				this.jumpTo(this.host.nextGrapheme(this.cursor()));
			}]);
			case "A": return this.enterInsertFrom([() => {
				this.jumpTo(this.lineEndPos(this.cursor()));
			}]);
			case "o": return this.openRelative(1);
			case "O": return this.openRelative(-1);
			case "r":
				this.awaitReplace = true;
				return "none";
			case "x": return this.deleteChars(Math.max(1, this.takeCount()), false);
			case "X": return this.deleteChars(Math.max(1, this.takeCount()), true);
			case "D": return this.toLineEndDeleteOrChange("d");
			case "C": return this.toLineEndDeleteOrChange("c");
			case "s": return this.substituteChars();
			case "S": return this.changeLines(this.takeCount());
			case "d":
			case "c":
			case "y":
				this.pendingOp = key;
				return "none";
			case "Y": return this.linewiseYank(this.takeCount());
			case "v":
				this.host.beginVisual(false);
				return "handled";
			case "V":
				this.host.beginVisual(true);
				return "handled";
			case "J": return this.joinLines(Math.max(1, Math.max(1, this.takeCount()) - 1));
			case "p": return this.pasteRegister(this.takeCount(), true);
			case "P": return this.pasteRegister(this.takeCount(), false);
			case ".": return this.replayDot();
			default: return "none";
		}
	}
	handleVisual(name, ch, _ctrl) {
		if (name === "escape") {
			this.host.exitVisual("normal");
			return "handled";
		}
		if (this.awaitReplace) {
			this.awaitReplace = false;
			if (!isPrintable(ch)) return "none";
			return this.visualReplaceWith(ch);
		}
		if (this.awaitFind !== null) {
			const m = this.awaitFind;
			this.awaitFind = null;
			if (!isPrintable(ch)) return "none";
			const n = Math.max(1, this.takeCount());
			const r = this.resolveFind(this.cursor(), {
				m,
				ch
			}, n);
			if (r === null) return "none";
			return this.nav(() => this.jumpTo(r.cursorPos));
		}
		if (/^[1-9]$/.test(ch)) {
			this.count = Math.min(this.count * 10 + Number(ch), 9999);
			return "none";
		}
		if (this.awaitG) {
			this.awaitG = false;
			if (ch === "g") return this.vExtend(0);
			return "none";
		}
		switch (name) {
			case "left": return this.nav(() => this.vExtend(this.host.prevGrapheme(this.cursor())));
			case "right": return this.nav(() => this.vExtend(this.host.nextGrapheme(this.cursor())));
			case "up": return this.vMove(-1);
			case "down": return this.vMove(1);
			case "home": return this.nav(() => this.vExtend(0));
			case "end": return this.nav(() => this.vExtend(this.value().length));
			case "ctrl_z":
			case "ctrl_minus": return this.changedIf(() => {
				this.host.undoOnce();
			});
			case "ctrl_y": return this.changedIf(() => {
				this.host.redoOnce();
			});
		}
		const key = ch === " " ? " " : ch;
		switch (key) {
			case "h": return this.nav(() => this.vExtend(this.host.prevGrapheme(this.cursor())));
			case " ":
			case "l": return this.nav(() => this.vExtend(this.host.nextGrapheme(this.cursor())));
			case "j": return this.vMove(1);
			case "k": return this.vMove(-1);
			case "w": return this.vChainExtend((off) => this.fwdWord(off, false));
			case "W": return this.vChainExtend((off) => this.fwdWord(off, true));
			case "b": return this.vChainExtend((off) => this.backWord(off, false));
			case "B": return this.vChainExtend((off) => this.backWord(off, true));
			case "e": return this.vChainExtend((off) => this.fwdWordEnd(off, false));
			case "E": return this.vChainExtend((off) => this.fwdWordEnd(off, true));
			case "^": return this.nav(() => this.vExtend(this.firstNonBlank()));
			case "$": return this.nav(() => this.vExtend(this.lineEndPos(this.cursor())));
			case "0": return this.nav(() => this.vExtend(this.lineStart(this.cursor())));
			case "g":
				this.awaitG = true;
				return "none";
			case "f":
			case "F":
			case "t":
			case "T":
				this.awaitFind = key;
				return "none";
			case ";": return this.repeatFind(false);
			case ",": return this.repeatFind(true);
			case "V":
				if (!this.host.isLinewiseVisual()) {
					this.host.exitVisual("normal");
					this.host.beginVisual(true);
				}
				return "handled";
			case "v":
				if (this.host.isLinewiseVisual()) {
					this.host.exitVisual("normal");
					this.host.beginVisual(false);
					return "handled";
				}
				this.host.exitVisual("normal");
				return "handled";
			case "o":
				this.host.swapVisualEnds();
				return "handled";
			case "d":
			case "x": return this.visualCut("normal");
			case "c":
			case "s": return this.visualCut("insert");
			case "y": return this.visualYank(false);
			case "Y": return this.visualYank(true);
			case "p": return this.visualPaste();
			case "U": return this.visualTransform((seg) => seg.toUpperCase());
			case "u": return this.visualTransform((seg) => seg.toLowerCase());
			case "~": return this.visualTransform((seg) => [...seg].map(flipCaseCp).join(""));
			case "J": return this.visualJoin();
			case "r":
				this.awaitReplace = true;
				return "none";
			default: return "none";
		}
	}
	/** insert 模式里每次顺序键入回调（累积 `.` 材料）。 */
	captureTyping(ch) {
		if (this.insertPrefix !== null && this.insertOk) this.insertText += ch;
	}
	/** insert 模式里任何非顺序改动（删除/粘贴/补全）→ `.` 保真失败，放弃记录。 */
	markInsertDirty() {
		this.insertOk = false;
	}
	/** Esc 离开 insert 时封口：前缀步骤 + 文本段落合成一条 `.` 记录。 */
	finalizeInsertRepeat() {
		if (this.replaying) return;
		const prefix = this.insertPrefix;
		this.insertPrefix = null;
		if (!this.insertOk || prefix === null) return;
		const text = this.insertText;
		this.insertText = "";
		if (text === "" && prefix.length === 0) return;
		this.dotSteps = [
			...prefix,
			() => {
				if (text !== "") this.host.spliceRange(this.host.cursor(), this.host.cursor(), text, "replace");
			},
			() => {
				this.host.setModeNormal();
			}
		];
	}
	value() {
		return this.host.value();
	}
	cursor() {
		return this.host.cursor();
	}
	splitCache = null;
	linesCache = [];
	lines() {
		const v = this.value();
		if (this.splitCache !== v) {
			this.linesCache = v.split("\n");
			this.splitCache = v;
		}
		return this.linesCache;
	}
	lineIndexOf(pos) {
		const v = this.value();
		let idx = 0;
		let searchFrom = 0;
		for (;;) {
			const nl = v.indexOf("\n", searchFrom);
			if (nl === -1 || nl >= pos) break;
			idx++;
			searchFrom = nl + 1;
		}
		return idx;
	}
	lineStart(pos) {
		const prevNl = this.value().lastIndexOf("\n", Math.max(0, pos - 1));
		return pos === 0 ? 0 : prevNl === -1 ? 0 : prevNl + 1;
	}
	lineEndPos(pos) {
		const ln = this.lineIndexOf(pos);
		const seg = this.lines()[ln] ?? "";
		return this.lineStart(pos) + seg.length;
	}
	firstNonBlank() {
		const m = (this.lines()[this.lineIndexOf(this.cursor())] ?? "").match(/\S/);
		const start = this.lineStart(this.cursor());
		return m === null ? start : start + (m.index ?? 0);
	}
	jumpTo(pos) {
		this.host.moveCursor(clamp(pos, this.value().length));
	}
	nav(action) {
		action();
		return "handled";
	}
	changedIf(action) {
		action();
		return "handled";
	}
	lineJump(idx) {
		const clamped = clamp(idx, this.lines().length - 1);
		let offset = 0;
		const lines = this.lines();
		for (let i = 0; i < clamped; i++) offset += (lines[i]?.length ?? 0) + 1;
		this.jumpTo(offset);
		return "handled";
	}
	takeCount() {
		const c = this.count;
		this.count = 0;
		return Math.max(1, c);
	}
	/** Esc：清空全部待续解析态（不产生可感知变化）。 */
	cancelPending() {
		this.count = 0;
		this.pendingOp = null;
		this.awaitG = false;
		this.awaitFind = null;
		this.awaitReplace = false;
		this.awaitObjectOuter = null;
		this.awaitOperatorG = false;
		return "none";
	}
	hGraphN(steps) {
		let pos = this.cursor();
		for (let i = 0; i < Math.abs(steps); i++) pos = steps > 0 ? this.host.nextGrapheme(pos) : this.host.prevGrapheme(pos);
		this.jumpTo(pos);
	}
	classP(pos, big) {
		const cp = this.value().codePointAt(pos);
		return cp === void 0 ? "space" : classOfCp(String.fromCodePoint(cp), big);
	}
	/** w/W：下一词簇词首（EOF 夹紧；相对起点无进展则原地）。 */
	fwdWord(from, big) {
		const len = this.value().length;
		if (from >= len) return from;
		const cls = this.classP(from, big);
		let p = this.stepNextRaw(from);
		while (p < len && this.classP(p, big) === cls) p = this.stepNextRaw(p);
		while (p < len && this.classP(p, big) === "space") p = this.stepNextRaw(p);
		return p;
	}
	stepNextRaw(pos) {
		const v = this.value();
		if (pos >= v.length) return pos;
		const cp = v.codePointAt(pos);
		return pos + (cp !== void 0 && cp > 65535 ? 2 : 1);
	}
	/** b/B：上一词簇词首（含「从词簇内部跳回簇首」）。 */
	backWord(from, big) {
		if (from <= 0) return 0;
		const p = this.rawPrev(from);
		if (p <= 0) return 0;
		const cls = this.classP(from, big);
		if (cls !== "space") {
			let head = from;
			while (head > 0) {
				const pv = this.rawPrev(head);
				if (this.classP(pv, big) !== cls) break;
				head = pv;
			}
			if (head < from) return head;
			let q = rawPrevPos(this.value(), from);
			while (q > 0 && this.classP(q, big) === "space") q = rawPrevPos(this.value(), q);
			if (this.classP(q, big) === "space") return 0;
			let head2 = q;
			const cls2 = this.classP(q, big);
			while (head2 > 0) {
				const pv = rawPrevPos(this.value(), head2);
				if (this.classP(pv, big) !== cls2) break;
				head2 = pv;
			}
			return head2;
		}
		let q2 = p;
		while (q2 > 0 && this.classP(q2, big) === "space") q2 = rawPrevPos(this.value(), q2);
		if (this.classP(q2, big) === "space") return 0;
		let head3 = q2;
		const cls3 = this.classP(q2, big);
		while (head3 > 0) {
			const pv = rawPrevPos(this.value(), head3);
			if (this.classP(pv, big) !== cls3) break;
			head3 = pv;
		}
		return head3;
	}
	rawPrev(pos) {
		return rawPrevPos(this.value(), pos);
	}
	/** e/E：词尾字符（所在簇尚未尽则当簇尾；已到簇尾则下一非空簇尾）。 */
	fwdWordEnd(from, big) {
		const len = this.value().length;
		if (from >= len) return from;
		const cls = this.classP(from, big);
		let t = from;
		while (true) {
			const nx = this.stepNextRaw(t);
			if (nx >= len || this.classP(nx, big) !== cls) break;
			t = nx;
		}
		if (t !== from) return t;
		let q = this.stepNextRaw(from);
		while (q < len && this.classP(q, big) === "space") q = this.stepNextRaw(q);
		if (q >= len) return from;
		const cls2 = this.classP(q, big);
		let tail = q;
		while (true) {
			const nx = this.stepNextRaw(tail);
			if (nx >= len || this.classP(nx, big) !== cls2) break;
			tail = nx;
		}
		return tail;
	}
	countChain(step) {
		const n = this.takeCount();
		const start = this.cursor();
		let from = start;
		for (let i = 0; i < n; i++) {
			const nxt = step(from);
			if (nxt === from) break;
			from = nxt;
		}
		if (from === start) return "none";
		return this.nav(() => this.jumpTo(from));
	}
	vChainExtend(step) {
		const n = this.takeCount();
		let from = this.cursor();
		for (let i = 0; i < n; i++) {
			const nxt = step(from);
			if (nxt === from) break;
			from = nxt;
		}
		return this.nav(() => {
			this.jumpTo(from);
		});
	}
	dollarMotion() {
		let n = this.takeCount();
		let pos = this.lineEndPos(this.cursor());
		const len = this.value().length;
		while (--n > 0 && pos < len) pos = this.lineEndPos(Math.min(pos + 1, len));
		return this.nav(() => this.jumpTo(pos));
	}
	/** 行边缘 j/k → 单行草稿翻历史兜底（对齐 CC）。 */
	edgeNav(fallbackDir, delta) {
		if (this.moveLineClamped(delta)) return "handled";
		if (this.lines().length === 1) return this.historyFallbackResult(fallbackDir);
		return "none";
	}
	moveLineClamped(delta) {
		const v = this.value();
		const pos = this.cursor();
		const before = v.slice(0, pos);
		const col = before.length - (before.lastIndexOf("\n") + 1);
		const lines = this.lines();
		const ln = this.lineIndexOf(pos);
		const target = clamp(ln + delta, lines.length - 1);
		if (target === ln) return false;
		let destStart = 0;
		for (let i = 0; i < target; i++) destStart += (lines[i]?.length ?? 0) + 1;
		const bounds = boundaries(lines[target] ?? "");
		const colIdx = Math.min(col, bounds.length - 2);
		const dest = destStart + (bounds[colIdx] ?? 0);
		if (dest === pos) return false;
		this.jumpTo(dest);
		return true;
	}
	vMove(delta) {
		return this.moveLineClamped(delta) ? "handled" : "none";
	}
	historyFallbackResult(dir) {
		return this.host.historyFallback(dir) ? "handled" : "none";
	}
	/**
	* 逻辑行内第 times 次命中解析。
	* cursorPos = 独立跳转落点（t 落目标前一格、T 落后一格）；
	* winStart/winEnd = 操作符删除窗口：f/F 连目标字符一起吞（through），
	* t/T 停在相邻格不吞。找不到返回 null（原地不动）。
	*/
	resolveFind(from, find, times) {
		const base = this.lineStart(from);
		const seg = this.lines()[this.lineIndexOf(from)] ?? "";
		const rel = clamp(from - base, seg.length);
		const forward = find.m === "f" || find.m === "t";
		const hits = [];
		if (forward) {
			let p = seg.indexOf(find.ch, rel + 1);
			while (p !== -1) {
				hits.push(p);
				p = seg.indexOf(find.ch, p + 1);
			}
		} else {
			let p = seg.lastIndexOf(find.ch, rel - 1);
			while (p !== -1) {
				hits.push(p);
				p = seg.lastIndexOf(find.ch, p - 1);
			}
		}
		const nth = hits[Math.min(times - 1, hits.length - 1)];
		if (nth === void 0) return null;
		const x = base + nth;
		const width = clusterWidth(this.value(), x);
		let cursorPos = x;
		if (find.m === "t") cursorPos -= 1;
		if (find.m === "T") cursorPos += width;
		if (cursorPos < base || cursorPos > this.lineEndPos(from)) return null;
		const through = find.m === "f" || find.m === "F";
		const edgeExclusive = forward ? through ? x + width : x : through ? x : x + width;
		return {
			cursorPos,
			winStart: Math.min(from, edgeExclusive),
			winEnd: Math.max(from, edgeExclusive)
		};
	}
	/** 独立跳转路径的 find 解析。 */
	finishFind(find, n) {
		const r = this.resolveFind(this.cursor(), find, n);
		if (r === null) return "none";
		return this.nav(() => this.jumpTo(r.cursorPos));
	}
	/** 操作符挂载的 find：对 [winStart,winEnd) 应用 d/c/y。 */
	finishOpFind(op, find, n) {
		const r = this.resolveFind(this.cursor(), find, n);
		if (r === null) return "none";
		if (r.winStart >= r.winEnd) return "none";
		const text = this.value().slice(r.winStart, r.winEnd);
		if (text === "") return "none";
		this.host.setRegister(text);
		if (op === "y") {
			this.host.moveCursor(r.winStart);
			return "handled";
		}
		this.host.spliceRange(r.winStart, r.winEnd, "", "delete");
		if (op === "c") this.host.enterInsert(void 0);
		return "handled";
	}
	repeatFind(reverse) {
		const lf = this.lastFind;
		if (lf === null) return "none";
		const flipped = reverse ? invertFind(lf) : lf;
		const n = Math.max(1, this.takeCount());
		return this.finishFind(flipped, n);
	}
	continueOperator(ch) {
		const op = this.pendingOp;
		if (op === null) return "none";
		if (/^[0-9]$/.test(ch)) {
			this.count = Math.min(this.count * 10 + Number(ch), 9999);
			return "none";
		}
		if (ch === op) {
			this.pendingOp = null;
			const n = this.takeCount();
			switch (op) {
				case "y": return this.linewiseYank(n);
				case "c": return this.changeLines(n);
				case "d": return this.linewiseDelete(n);
				default: return "none";
			}
		}
		if (ch === "i" || ch === "a") {
			this.awaitObjectOuter = ch === "a";
			return "none";
		}
		if (ch === "f" || ch === "F" || ch === "t" || ch === "T") {
			this.awaitFind = ch;
			return "none";
		}
		if (this.awaitOperatorG) {
			this.awaitOperatorG = false;
			if (ch !== "g") return "none";
			return this.opLinewise(op, "top");
		}
		if (ch === "g") {
			this.awaitOperatorG = true;
			return "none";
		}
		if (ch === "G") return this.opLinewise(op, "bottom");
		if (ch === ";" || ch === ",") {
			const lf = this.lastFind;
			if (lf === void 0 || lf === null) return "none";
			const flipped = ch === "," ? invertFind(lf) : lf;
			const n = Math.max(1, this.takeCount());
			this.pendingOp = null;
			return this.finishOpFind(op, flipped, n);
		}
		this.pendingOp = null;
		const span = this.opSpan(op, ch);
		if (span === null) return "none";
		return this.applySpanCommand(op, span.start, span.end, span.incl);
	}
	/**
	* 操作符 × 行级终点（dG/y2G/cgg 族）：光标行与目标行取并集后交给既有
	* 行级窗口命令——复用 dd/cc 的 EOF/换行收边逻辑，避免第三套实现。
	*/
	opLinewise(op, direction) {
		this.pendingOp = null;
		this.awaitOperatorG = false;
		const n = Math.max(1, this.count);
		this.count = 0;
		const lines = this.lines();
		const fromLn = this.lineIndexOf(this.cursor());
		const hadCount = this.count > 0;
		let toLnRaw;
		if (!hadCount) toLnRaw = direction === "top" ? 0 : lines.length - 1;
		else toLnRaw = direction === "top" ? fromLn - (n - 1) : fromLn + (n - 1);
		const toLn = Math.max(0, Math.min(toLnRaw, lines.length - 1));
		const lo = Math.min(fromLn, toLn);
		let dest = 0;
		for (let i = 0; i < lo; i++) dest += (lines[i]?.length ?? 0) + 1;
		this.jumpTo(dest);
		switch (op) {
			case "y": return this.linewiseYank(Math.abs(toLn - fromLn) + 1);
			case "c": return this.changeLines(Math.abs(toLn - fromLn) + 1);
			case "d": return this.linewiseDelete(Math.abs(toLn - fromLn) + 1);
			default: return "none";
		}
	}
	opSpan(op, key) {
		const n = Math.max(1, this.count);
		this.count = 0;
		switch (key) {
			case "w": return this.chainSpan(n, (off) => this.fwdWord(off, false), false, op === "c");
			case "W": return this.chainSpan(n, (off) => this.fwdWord(off, true), false, op === "c");
			case "b": return this.chainBack(n, (off) => this.backWord(off, false));
			case "B": return this.chainBack(n, (off) => this.backWord(off, true));
			case "e": return this.chainSpan(n, (off) => this.fwdWordEnd(off, false), true, false);
			case "E": return this.chainSpan(n, (off) => this.fwdWordEnd(off, true), true, false);
			case "h":
			case "left": {
				let pos = this.cursor();
				for (let i = 0; i < n; i++) {
					const nxt = this.host.prevGrapheme(pos);
					if (nxt === pos) break;
					pos = nxt;
				}
				return {
					start: pos,
					end: this.cursor(),
					incl: false
				};
			}
			case "l":
			case "right": {
				let pos = this.cursor();
				for (let i = 0; i < n; i++) {
					const nxt = this.host.nextGrapheme(pos);
					if (nxt === pos) break;
					pos = nxt;
				}
				return {
					start: this.cursor(),
					end: pos,
					incl: false
				};
			}
			case "0": return {
				start: this.cursor(),
				end: this.lineStart(this.cursor()),
				incl: false
			};
			case "^": return {
				start: this.cursor(),
				end: this.firstNonBlank(),
				incl: false
			};
			case "$": return {
				start: this.cursor(),
				end: this.lineEndPos(this.cursor()),
				incl: false
			};
			case "gg": return {
				start: this.cursor(),
				end: 0,
				incl: false
			};
			case "G": return {
				start: this.cursor(),
				end: this.value().length,
				incl: false
			};
			default: return null;
		}
	}
	/** 多步链式区间；cw 特判 == ce（词上单跳改写）。 */
	chainSpan(n, step, inclusive, isChangeWord) {
		const start = this.cursor();
		let from = start;
		for (let i = 0; i < n; i++) {
			const nxt = step(from);
			if (nxt === from) break;
			from = nxt;
		}
		if (isChangeWord && n === 1 && !/\s/u.test(this.value()[from - 1] ?? "") && this.classP(start, false) !== "space" && from === this.fwdWord(start, false)) return {
			start,
			end: this.fwdWordEnd(start, false),
			incl: true
		};
		return {
			start,
			end: from,
			incl: inclusive
		};
	}
	/** 反向 motion 链（db/3dB）：起点固定光标，终点为链式回退结果。 */
	chainBack(n, step) {
		let from = this.cursor();
		for (let i = 0; i < n; i++) {
			const nxt = step(from);
			if (nxt === from) break;
			from = nxt;
		}
		return {
			start: from,
			end: this.cursor(),
			incl: false
		};
	}
	resolveObject(ch) {
		const outer = this.awaitObjectOuter;
		this.awaitObjectOuter = null;
		if (outer === null) return "none";
		if (ch !== "w" && ch !== "W") return "none";
		const op = this.pendingOp;
		this.pendingOp = null;
		if (op === null) return "none";
		const span = objectSpan(this.value(), this.cursor(), ch === "W", outer);
		if (span === null) return "none";
		return this.applySpanCommand(op, span.start, span.end, false);
	}
	applySpanCommand(op, start, end, incl) {
		const v = this.value();
		const s = clamp(start, v.length);
		const e = clamp(end + (incl ? clusterWidth(v, end) : 0), v.length);
		if (s >= e) return "none";
		const text = v.slice(s, e);
		if (text === "") return "none";
		this.host.setRegister(text);
		if (op === "y") {
			this.host.moveCursor(s);
			return "handled";
		}
		this.host.spliceRange(s, e, "", "delete");
		if (op === "c") this.host.enterInsert(void 0);
		return "handled";
	}
	linewiseWindow(nRaw) {
		const v = this.value();
		const lines = this.lines();
		const ln = this.lineIndexOf(this.cursor());
		const cnt = Math.max(1, Math.min(Math.max(1, nRaw), lines.length - ln));
		const s = this.lineStart(this.cursor());
		let endAll = s;
		for (let i = 0; i < cnt; i++) endAll += (lines[ln + i]?.length ?? 0) + 1;
		endAll = Math.min(endAll, v.length);
		return {
			start: s,
			endAll,
			cnt,
			ln
		};
	}
	linewiseDelete(nRaw) {
		return this.recordAndRun([() => {
			const win = this.linewiseWindow(nRaw);
			if (win === null) return;
			const reg = `${this.lines().slice(win.ln, win.ln + win.cnt).join("\n")}\n`;
			this.host.setRegister(reg);
			const winStart = win.endAll >= this.value().length && win.start > 0 ? win.start - 1 : win.start;
			this.host.spliceRange(winStart, win.endAll, "", "delete", winStart);
		}]);
	}
	/**
	* cc/S：清空 n 行内容、寄存器行级化、落回行首进 insert。
	* 窗口 = 各行内容与其间换行（末行自身换行/EOF 结构保留）——多行 cc 收敛为
	* 单一空白编辑位，与 vim 行为一致。
	*/
	changeLines(nRaw) {
		return this.enterInsertFrom([() => {
			const lines = this.lines();
			const ln = this.lineIndexOf(this.cursor());
			const cnt = Math.max(1, Math.min(Math.max(1, nRaw), lines.length - ln));
			this.host.setRegister(`${lines.slice(ln, ln + cnt).join("\n")}\n`);
			const s = this.lineStartOfLine(ln);
			const lastIdx = ln + cnt - 1;
			const e = this.lineStartOfLine(lastIdx) + (lines[lastIdx]?.length ?? 0);
			if (e > s) this.host.spliceRange(s, e, "", "replace", s);
			else this.jumpTo(s);
		}]);
	}
	lineStartOfLine(ln) {
		const lines = this.lines();
		let off = 0;
		for (let i = 0; i < Math.min(ln, lines.length); i++) off += (lines[i]?.length ?? 0) + 1;
		return off;
	}
	linewiseYank(nRaw) {
		const win = this.linewiseWindow(nRaw);
		if (win === null) return "handled";
		const all = this.lines();
		this.host.setRegister(`${all.slice(win.ln, win.ln + win.cnt).join("\n")}\n`);
		return "handled";
	}
	replaceUnderCursor(ch, count) {
		const covered = [];
		let pos = this.cursor();
		const v = this.value();
		for (let i = 0; i < count && pos < v.length; i++) {
			const nxt = this.host.nextGrapheme(pos);
			if (v.slice(pos, nxt).includes("\n")) break;
			covered.push([pos, nxt]);
			pos = nxt;
		}
		const first = covered[0];
		const last = covered[covered.length - 1];
		if (first === void 0 || last === void 0) return;
		this.host.spliceRange(first[0], last[1], ch.repeat(covered.length), "replace", first[0]);
	}
	toggleCaseChar() {
		const cur = this.cursor();
		const v = this.value();
		if (cur >= v.length) return;
		const nxt = this.host.nextGrapheme(cur);
		const unit = v.slice(cur, nxt);
		if (unit.includes("\n")) return;
		this.host.spliceRange(cur, nxt, [...unit].map(flipCaseCp).join(""), "replace", cur);
	}
	transformLine(fn) {
		const s = this.lineStart(this.cursor());
		const e = this.lineEndPos(this.cursor());
		if (s === e) return;
		this.host.spliceRange(s, e, fn(this.value().slice(s, e)), "replace", s);
	}
	deleteChars(count, leftward) {
		return this.recordAndRun([() => {
			const cur = this.cursor();
			let pos = cur;
			for (let i = 0; i < count; i++) {
				const nxt = leftward ? this.host.prevGrapheme(pos) : this.host.nextGrapheme(pos);
				if (nxt === pos) break;
				pos = nxt;
			}
			if (pos === cur) return;
			if (leftward) this.host.spliceRange(pos, cur, "", "delete", pos);
			else this.host.spliceRange(cur, pos, "", "delete");
		}]);
	}
	substituteChars() {
		const n = this.takeCount();
		return this.enterInsertFrom([() => {
			const v = this.value();
			let pos = this.cursor();
			for (let i = 0; i < n && pos < v.length; i++) pos = this.host.nextGrapheme(pos);
			if (pos > this.cursor()) this.host.spliceRange(this.cursor(), pos, "", "delete");
		}]);
	}
	toLineEndDeleteOrChange(kind) {
		const run = [() => {
			const e = this.lineEndPos(this.cursor());
			const cur = this.cursor();
			if (e <= cur) return;
			const v = this.value();
			this.host.setRegister(v.slice(cur, e));
			this.host.spliceRange(cur, e, "", "delete");
		}];
		if (kind === "d") return this.recordAndRun(run);
		return this.enterInsertFrom(run);
	}
	openRelative(dir) {
		return this.enterInsertFrom([() => {
			const v = this.value();
			if (dir === 1) {
				const eol = this.lineEndPos(this.cursor());
				const lastWithoutNl = eol >= v.length;
				const insertAt = lastWithoutNl ? v.length : eol + 1;
				this.host.spliceRange(insertAt, insertAt, "\n", "replace", insertAt + (lastWithoutNl ? 1 : 0));
			} else {
				const s = this.lineStart(this.cursor());
				this.host.spliceRange(s, s, "\n", "replace", s);
			}
		}]);
	}
	joinLines(joins) {
		return this.recordAndRun([() => {
			for (let round = 0; round < joins; round++) {
				const v = this.value();
				const lines = this.lines();
				const ln = this.lineIndexOf(this.cursor());
				const nextSeg = lines[ln + 1];
				if (nextSeg === void 0) return;
				const curSeg = lines[ln] ?? "";
				const e = this.lineStart(this.cursor()) + curSeg.length;
				const stripped = nextSeg.replace(/^[ \t]+/, "");
				const joiner = curSeg === "" || /[ \t]$/.test(curSeg) ? "" : " ";
				const windowEnd = Math.min(e + 1 + nextSeg.length, v.length);
				this.host.spliceRange(e, windowEnd, joiner + stripped, "replace", e + joiner.length);
			}
		}]);
	}
	pasteRegister(count, after) {
		const reg = this.host.register();
		if (reg === "") return "none";
		const linewise = reg.endsWith("\n");
		const body = stripTrailingNl(reg);
		const repeatedBody = count > 1 ? body.repeat(count) : body;
		return this.recordAndRun([() => {
			const v = this.value();
			const cur = this.cursor();
			if (linewise) {
				if (after) {
					const eol = this.lineEndPos(cur);
					if (eol >= v.length) this.host.spliceRange(v.length, v.length, `\n${repeatedBody}`, "replace", v.length + 1);
					else this.host.spliceRange(eol + 1, eol + 1, `${repeatedBody}\n`, "replace", eol + 1);
				} else {
					const s = this.lineStart(cur);
					this.host.spliceRange(s, s, `${repeatedBody}\n`, "replace", s);
				}
				return;
			}
			const at = after ? this.host.nextGrapheme(cur) : cur;
			this.host.spliceRange(at, at, repeatedBody, "replace", at);
		}]);
	}
	recordAndRun(steps) {
		if (!this.replaying) this.dotSteps = [...steps];
		for (const f of steps) f();
		return "handled";
	}
	replayDot() {
		const steps = this.dotSteps;
		if (steps === null) return "none";
		this.replaying = true;
		try {
			for (const f of steps) f();
		} finally {
			this.replaying = false;
		}
		return "handled";
	}
	enterInsertFrom(prefix) {
		this.insertPrefix = [...prefix];
		this.insertText = "";
		this.insertOk = true;
		this.dotSteps = null;
		this.host.enterInsert(prefix.length > 0 ? () => {
			for (const f of prefix) f();
		} : void 0);
		return "handled";
	}
	/**
	* visual 选区消费窗口：charwise 按 vim「两端所在字符都含」补格；
	* linewise 直接用宿主对齐结果。无选区返回 null。
	*/
	selSpan() {
		const sel = this.host.selection();
		if (sel === null) return null;
		let lo = Math.min(sel.start, sel.end);
		let hi = Math.max(sel.start, sel.end);
		if (!sel.linewise && sel.anchor !== this.cursor()) {
			const v = this.value();
			hi = Math.min(v.length, hi + clusterWidth(v, hi));
		}
		return {
			start: lo,
			end: hi,
			linewise: sel.linewise
		};
	}
	vExtend(target) {
		const t = clamp(target, this.value().length);
		if (t === this.cursor()) return "none";
		this.host.moveCursor(t);
		return "handled";
	}
	visualCut(to) {
		const sel = this.selSpan();
		if (sel === null) return "none";
		const text = this.value().slice(sel.start, sel.end);
		this.host.setRegister(sel.linewise ? ensureTrailingNl(stripTrailingNl(text)) : text);
		this.host.exitVisual(to);
		if (sel.linewise && to === "insert") {
			const keep = text.endsWith("\n") ? "\n" : "";
			this.host.spliceRange(sel.start, sel.end, keep, "replace", sel.start);
		} else this.host.spliceRange(sel.start, sel.end, "", "delete", sel.start);
		return "handled";
	}
	visualYank(forceLinewise) {
		const sel = this.selSpan();
		if (sel === null) return "none";
		const text = this.value().slice(sel.start, sel.end);
		const linewise = forceLinewise || sel.linewise;
		this.host.setRegister(linewise ? ensureTrailingNl(stripTrailingNl(text)) : text);
		const anchor = linewise ? this.lineStart(sel.start) : sel.start;
		this.host.exitVisual("normal");
		this.host.moveCursor(anchor);
		return "handled";
	}
	visualPaste() {
		const reg = this.host.register();
		if (reg === "") return "none";
		const sel = this.selSpan();
		if (sel === null) return "none";
		const linewisePaste = reg.endsWith("\n");
		const body = stripTrailingNl(reg);
		this.host.exitVisual(linewisePaste ? "normal" : "normal");
		if (linewisePaste) {
			this.host.spliceRange(sel.start, sel.end, sel.linewise ? `${body}\n` : `${body}\n`, "replace", sel.start);
			return "handled";
		}
		this.host.spliceRange(sel.start, sel.end, body, "replace", sel.start);
		return "handled";
	}
	visualReplaceWith(ch) {
		const sel = this.selSpan();
		if (sel === null) return "none";
		const seg = this.value().slice(sel.start, sel.end);
		let out = "";
		let mutated = false;
		for (const unit of graphemesOf(seg)) {
			if (unit.includes("\n")) {
				out += unit;
				continue;
			}
			out += ch.repeat([...unit].length);
			mutated = true;
		}
		if (!mutated) return "none";
		this.host.exitVisual("normal");
		this.host.spliceRange(sel.start, sel.end, out, "replace", sel.start);
		return "handled";
	}
	visualTransform(fn) {
		const sel = this.selSpan();
		if (sel === null) return "none";
		const seg = this.value().slice(sel.start, sel.end);
		this.host.exitVisual("normal");
		this.host.spliceRange(sel.start, sel.end, fn(seg), "replace", sel.start);
		return "handled";
	}
	visualJoin() {
		const sel = this.selSpan();
		if (sel === null || !sel.linewise) return "none";
		const block = this.value().slice(sel.start, sel.end).split("\n").map((l) => l.trim()).filter((l) => l !== "");
		this.host.exitVisual("normal");
		this.host.spliceRange(sel.start, sel.end, block.join(" "), "replace", sel.start);
		return "handled";
	}
};
function isPrintable(ch) {
	return ch.length > 0 && !/[\x00-\x1F\x7F]/.test(ch);
}
function flipCaseCp(cp) {
	return cp === cp.toUpperCase() ? cp.toLowerCase() : cp.toUpperCase();
}
function clamp(pos, len) {
	return Math.max(0, Math.min(pos, len));
}
function ensureTrailingNl(s) {
	return s.endsWith("\n") ? s : `${s}\n`;
}
function stripTrailingNl(s) {
	return s.endsWith("\n") ? s.slice(0, -1) : s;
}
function clusterWidth(v, pos) {
	if (pos < 0 || pos >= v.length) return 0;
	const cp = v.codePointAt(pos);
	return cp === void 0 ? 1 : cp > 65535 ? 2 : 1;
}
function rawPrevPos(v, pos) {
	if (pos <= 0) return pos;
	const cp = v.codePointAt(pos - 1);
	if (cp !== void 0 && cp > 65535 && pos >= 2) {
		const lead = v.codePointAt(pos - 2);
		if (lead !== void 0 && lead > 65535) return pos - 2;
	}
	return pos - 1;
}
/** text-object 词簇解析：iw/iW × aw/aW（光标在空白上时选空白簇）。 */
function objectSpan(v, pos, big, outer) {
	const len = v.length;
	if (pos >= len) return null;
	const clsAt = (p) => {
		const cp = v.codePointAt(p);
		return cp === void 0 ? "space" : classOfCp(String.fromCodePoint(cp), big);
	};
	const stepFwd = (p) => {
		const cp = v.codePointAt(p);
		return Math.min(p + (cp !== void 0 && cp > 65535 ? 2 : 1), len);
	};
	let s = pos;
	const cls = clsAt(pos);
	while (s > 0 && clsAt(rawPrevPos(v, s)) === cls) s = rawPrevPos(v, s);
	let e = pos;
	while (true) {
		const nx = stepFwd(e);
		if (nx >= len || clsAt(nx) !== cls) break;
		e = nx;
	}
	const endExcl = stepFwd(e);
	if (!outer) return {
		start: s,
		end: endExcl
	};
	let ws = endExcl;
	while (ws < len && clsAt(ws) === "space") ws = stepFwd(ws);
	if (ws > endExcl) return {
		start: s,
		end: ws
	};
	let ws2 = s;
	while (ws2 > 0 && clsAt(rawPrevPos(v, ws2)) === "space") ws2 = rawPrevPos(v, ws2);
	return {
		start: ws2,
		end: endExcl
	};
}
function invertFind(f) {
	const m = {
		f: "F",
		F: "f",
		t: "T",
		T: "t"
	}[f.m];
	return m === void 0 ? f : {
		m,
		ch: f.ch
	};
}
/** 光标列对齐用的边界数组（含 0 与末尾；多行安全降级按 code-point 切分）。 */
function boundaries(seg) {
	try {
		const segger = new Intl.Segmenter(void 0, { granularity: "grapheme" });
		const bounds = [0];
		for (const part of segger.segment(seg)) bounds.push(part.index + part.segment.length);
		return bounds;
	} catch {
		const bounds = [0];
		let i = 0;
		while (i < seg.length) {
			const cp = seg.codePointAt(i);
			const w = cp === void 0 ? 1 : cp > 65535 ? 2 : 1;
			bounds.push(i + w);
			i += w;
		}
		return bounds;
	}
}
function graphemesOf(seg) {
	try {
		const segger = new Intl.Segmenter(void 0, { granularity: "grapheme" });
		const out = [];
		for (const part of segger.segment(seg)) out.push(part.segment);
		return out;
	} catch {
		const out = [];
		let i = 0;
		while (i < seg.length) {
			const cp = seg.codePointAt(i);
			const w = cp === void 0 ? 1 : cp > 65535 ? 2 : 1;
			out.push(seg.slice(i, i + w));
			i += w;
		}
		return out;
	}
}
//#endregion
//#region lib/types/engine/input-line.js
/**
* T9 InputLine — 纯 TypeScript 类，替代 base-text-input.tsx / input.tsx。
*
* 管理输入文本缓冲区、光标位置、历史、Vim 模式。
* 零 React/Ink 依赖。通过回调通知外部变化。
*
* 核心能力：
* - 字符输入 + 多字节 UTF-8 支持
* - 光标移动（左右/home/end/词级）
* - 删除（backspace/delete/词级删除）
* - 历史导航（上下键）
* - 行内编辑（Ctrl+A/E/U/K/W）
* - Vim 模式（Normal/Insert）
* - Tab 补全接口
* - 粘贴支持
*/
/**
* 输入框可视行上限：长草稿不占满整屏。
* @param rows - 终端行数。
* @returns 至少 3、至多 16，约 `rows / 3`。
*/
function inputViewportMaxLines(rows) {
	return Math.max(3, Math.min(16, Math.floor(Math.max(1, rows) / 3)));
}
/** Grapheme 分段器（Node 22+）。用于按用户感知字符（CJK/emoji/ZWJ 簇）步进光标。
* WSL/Alpine 中若 Node.js 运行时缺少 ICU 数据，Intl.Segmenter 会抛出。
* 降级到按 code-point 分割（仍正确处理多字节 UTF-8，但不支持 ZWJ emoji 簇）。 */
let graphemeSegmenter = null;
try {
	graphemeSegmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
} catch {
	graphemeSegmenter = null;
}
const GRAPHEME_SEGMENTER = graphemeSegmenter;
/** CJK 统一表意/扩展A/兼容/假名/谚文——与 \w 一起视为 word 字符。
*  不复用 prevWordStart 的 /\w/ 口径：它把整段中文当非词，连续中文输入
*  会被错分为一堆独立单元。 */
const WORD_CHAR_RE = /^(?:\w|[一-鿿㐀-䶿豈-﫿぀-ヿ가-힯])$/;
function classifyInsert(ch) {
	if (/^\s$/.test(ch)) return "insert-space";
	if (WORD_CHAR_RE.test(ch)) return "insert-word";
	return "insert-other";
}
const UNDO_STACK_MAX = 200;
/** 快照滞留总字符上限（≈2M UTF-16 code units）：200 单元 × 极端大 buffer
* （多次 100KB+ 粘贴）的滞留内存长尾防护——超限时逐出最旧单元。 */
const UNDO_TOTAL_CHARS_MAX = 2e6;
/** 触发折叠的阈值（行数 或 字符数）。 */
const PASTE_FOLD_MIN_LINES = 100;
const PASTE_FOLD_MIN_CHARS = 1e4;
/** 标记串形态（grapheme 原子化 / 提交展开 / 渲染着色共用）。 */
const PASTE_MARKER_RE = /\[paste #(\d+) \+\d+ lines?\]/g;
/** 返回字符串中所有 grapheme 边界的 code-unit 偏移（含 0 与末尾）。 */
function graphemeBoundaries(value) {
	const bounds = [0];
	if (GRAPHEME_SEGMENTER) for (const seg of GRAPHEME_SEGMENTER.segment(value)) bounds.push(seg.index + seg.segment.length);
	else {
		let i = 0;
		while (i < value.length) {
			const cp = value.codePointAt(i);
			if (cp === void 0) {
				bounds.push(i);
				i++;
				continue;
			}
			bounds.push(i + (cp > 65535 ? 2 : 1));
			i += cp > 65535 ? 2 : 1;
		}
	}
	return bounds;
}
function inputDisplayWidth(text, ambiguousAsWide) {
	return displayWidth(text, { ambiguousAsWide });
}
/** vim insert 光标竖线（#55）：ASCII 档（legacy conhost）退化为 `|`。 */
function insertBarGlyph() {
	return useAsciiGlyphs() ? "|" : "▏";
}
function pushWrappedSegment(out, segment, prefix, maxContentWidth, cursorOffset, ambiguousAsWide, caretCol, segAbsStart, sel, bar = false) {
	const barGlyph = bar ? insertBarGlyph() : "";
	const barWidth = bar ? inputDisplayWidth(barGlyph, ambiguousAsWide) : 0;
	let current = "";
	let currentWidth = 0;
	let currentHasCursor = false;
	let offset = 0;
	let inSel = false;
	const flush = () => {
		out.push({
			text: `${prefix}${current}${inSel ? ANSI.RESET : ""}`,
			cursor: currentHasCursor
		});
		current = inSel ? ANSI.REVERSE : "";
		currentWidth = 0;
		currentHasCursor = false;
	};
	for (const ch of segment) {
		const absOff = (segAbsStart ?? 0) + offset;
		if (sel && inSel && absOff === sel.end) {
			current += ANSI.RESET;
			inSel = false;
		}
		if (sel && !inSel && absOff === sel.start) {
			current += ANSI.REVERSE;
			inSel = true;
		}
		const atCaret = cursorOffset !== null && offset === cursorOffset;
		const chWidth = Math.max(1, charDisplayWidth(ch, ambiguousAsWide));
		if (currentWidth > 0 && currentWidth + chWidth + barWidth > maxContentWidth) flush();
		if (atCaret) {
			if (caretCol) caretCol.value = currentWidth;
			currentHasCursor = true;
			if (bar) {
				current += barGlyph;
				currentWidth += barWidth;
			} else current += inSel ? ch : `${ANSI.REVERSE}${ch}${ANSI.RESET}`;
		} else current += ch;
		currentWidth += chWidth;
		offset += ch.length;
	}
	if (cursorOffset !== null && cursorOffset === segment.length) {
		const absOff = (segAbsStart ?? 0) + offset;
		if (sel && inSel && absOff === sel.end) {
			current += ANSI.RESET;
			inSel = false;
		}
		if (sel && !inSel && absOff === sel.start) {
			current += ANSI.REVERSE;
			inSel = true;
		}
		const glyph = bar ? barGlyph : "█";
		const markerWidth = inputDisplayWidth(glyph, ambiguousAsWide);
		if (currentWidth > 0 && currentWidth + markerWidth > maxContentWidth) flush();
		if (caretCol) caretCol.value = currentWidth;
		current += glyph;
		currentWidth += markerWidth;
		currentHasCursor = true;
	}
	if (currentWidth > 0 || currentHasCursor || segment.length === 0) flush();
}
/** ghost 预览的 dim 样式（终端原生 dim，不依赖主题）。 */
const GHOST_DIM_OPEN = "\x1B[2m";
const GHOST_DIM_CLOSE = "\x1B[22m";
/**
* 在 wrap 后的光标行按列位置插入 dim ghost，并把行宽截到 maxWidth。
* 行文本不含 ANSI（调用方保证无选区）；ghost 按剩余空间截断。
* @param line - wrap 后的光标行文本（prefix + 片段）。
* @param col - 光标列（含 prefix，列 = 字符位置）。
* @param ghost - ghost 文本。
* @param maxWidth - 目标行宽。
* @returns 插入 ghost 并截断后的行。
*/
function insertGhost(line, col, ghost, maxWidth) {
	const prefix = line.slice(0, col);
	const rest = line.slice(col);
	const avail = maxWidth - displayWidth(prefix) - displayWidth(rest);
	if (avail <= 0) return line;
	let shown = "";
	for (const ch of ghost) {
		if (displayWidth(shown + ch) > avail) break;
		shown += ch;
	}
	return `${prefix}${GHOST_DIM_OPEN}${shown}${GHOST_DIM_CLOSE}${rest}`;
}
function wrapInputLines(value, cursor, maxWidth, sel, bar = false) {
	const ambiguousAsWide = ambiguousWideEnabled();
	const visual = [];
	const logicalLines = value.split("\n");
	const prefixWidth = inputDisplayWidth("❯ ", ambiguousAsWide);
	const maxContentWidth = Math.max(1, maxWidth - prefixWidth);
	let cursorLine = 0;
	let cursorCol = prefixWidth;
	let absoluteOffset = 0;
	for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex++) {
		const logicalLine = logicalLines[lineIndex];
		if (logicalLine === void 0) continue;
		const lineStart = absoluteOffset;
		const lineEnd = lineStart + logicalLine.length;
		const cursorInLine = cursor >= lineStart && cursor <= lineEnd;
		const prefix = cursorInLine ? "❯ " : "  ";
		const beforeCount = visual.length;
		const caretCol = { value: 0 };
		pushWrappedSegment(visual, logicalLine, prefix, maxContentWidth, cursorInLine ? cursor - lineStart : null, ambiguousAsWide, caretCol, lineStart, sel, bar);
		if (cursorInLine) {
			const found = visual.findIndex((line, idx) => idx >= beforeCount && line.cursor);
			cursorLine = found >= 0 ? found : beforeCount;
			cursorCol = prefixWidth + caretCol.value;
		}
		absoluteOffset = lineEnd + 1;
	}
	return {
		lines: visual.map((line) => line.text),
		cursorLine,
		cursorCol
	};
}
/** 在升序边界数组中找严格小于 cursor 的最大下标（光标左侧最近边界）。二分 O(log n)。 */
function boundaryBefore(bounds, cursor) {
	let lo = 0, hi = bounds.length - 1, ans = 0;
	while (lo <= hi) {
		const mid = lo + hi >>> 1;
		const b = bounds[mid];
		if (b === void 0) break;
		if (b < cursor) {
			ans = b;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}
/** 在升序边界数组中找严格大于 cursor 的最小下标（光标右侧最近边界）。二分 O(log n)。 */
function boundaryAfter(bounds, cursor) {
	let lo = 0, hi = bounds.length - 1;
	while (lo < hi) {
		const mid = lo + hi >>> 1;
		const b = bounds[mid];
		if (b === void 0) break;
		if (b > cursor) hi = mid;
		else lo = mid + 1;
	}
	const b = bounds[lo];
	if (b === void 0) return -1;
	return b > cursor ? b : -1;
}
/** 剔除落在 `[paste #N …]` 标记内部的边界（端点保留）——标记成为原子编辑单位。 */
function atomicPasteMarkerBounds(value, bounds) {
	const spans = [];
	for (const m of value.matchAll(new RegExp(PASTE_MARKER_RE.source, "g"))) {
		const matched = m[0];
		spans.push([m.index, m.index + matched.length]);
	}
	if (spans.length === 0) return bounds;
	return bounds.filter((b) => !spans.some(([s, e]) => b > s && b < e));
}
/** 视窗裁剪：返回可见行 + 光标行在【返回数组内】的下标（硬件光标归位需要）。 */
function viewportWithCaret(lines, cursorLine, maxLines) {
	if (maxLines === void 0 || lines.length <= maxLines) return {
		lines,
		caretLine: Math.min(Math.max(cursorLine, 0), lines.length - 1)
	};
	const max = Math.max(1, Math.floor(maxLines));
	const cursor = Math.min(Math.max(cursorLine, 0), lines.length - 1);
	const cursorText = lines[cursor];
	if (cursorText === void 0) return {
		lines: [],
		caretLine: 0
	};
	if (max === 1) return {
		lines: [cursorText],
		caretLine: 0
	};
	if (max === 2) return cursor < lines.length - 1 ? {
		lines: [cursorText, `… 下 ${lines.length - cursor - 1} 行`],
		caretLine: 0
	} : {
		lines: [`… 上 ${cursor} 行`, cursorText],
		caretLine: 1
	};
	const hasAbove = cursor > 0;
	const hasBelow = cursor < lines.length - 1;
	const contentSlots = Math.max(1, max - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0));
	const minStart = hasAbove ? 1 : 0;
	const maxStart = hasBelow ? Math.max(minStart, lines.length - 1 - contentSlots) : Math.max(minStart, lines.length - contentSlots);
	const centeredStart = cursor - Math.floor(contentSlots / 2);
	const start = Math.min(Math.max(centeredStart, minStart), maxStart);
	const visible = lines.slice(start, start + contentSlots);
	return {
		lines: [
			...hasAbove ? [`… 上 ${start} 行`] : [],
			...visible,
			...hasBelow ? [`… 下 ${lines.length - (start + contentSlots)} 行`] : []
		],
		caretLine: (hasAbove ? 1 : 0) + (cursor - start)
	};
}
/**
* 纯 TypeScript 输入行状态机：管理文本缓冲区、光标、历史、选区、undo/redo、
* 图片附件与 Vim 模式，零 React/Ink 依赖。按键经 handleKey 进入，
* 状态变化通过构造时注入的回调通知外部。
*/
var InputLine = class {
	_value;
	_cursor;
	_placeholder;
	_history;
	_historyIdx;
	_vimEnabled;
	_vimMode;
	_maxLength;
	/** 手工换行：Enter 插入 \\n 而不是提交（粘贴流结束的 return 仍提交）。 */
	_newlineMode = false;
	/** 最近一次 displayLines 的折行宽度；↑↓/PgUp 按视觉行移动。 */
	_wrapWidth;
	/** 最近一次 displayLines 的可视行上限；PageUp/Down 按此翻页。 */
	_maxDisplayLines;
	/** 图片附件 data URL 列表 */
	_images = [];
	/** Grapheme 边界缓存（按 value 失效）。光标移动不改 value，命中缓存省去 O(n) 分段。 */
	_graphemeCache = null;
	onChangeCallback;
	onSubmitCallback;
	onTabCompleteCallback;
	onImagesChangeCallback;
	onOpenHistorySearchCallback;
	/** vim 键位引擎（issue #51）：normal/visual 按键与 `.` 重放状态都收敛在这里。 */
	_vim = null;
	/** insert 两键序列→Esc 状态机（仅 vim 构造时有前缀才存在；见 insert-remap.ts）。 */
	_remapper = null;
	/** undo 栈（改前快照）。submit 后清空——上一条输入的文本不得被下一条撤销复活。 */
	_undoStack = [];
	/** 栈内快照滞留的总字符数（配合 UNDO_TOTAL_CHARS_MAX 防护内存长尾）。 */
	_undoChars = 0;
	/** redo 栈（undo 目标态快照）。任何新编辑（recordUndo）清空——redo 分支失效。 */
	_redoStack = [];
	_redoChars = 0;
	/** 当前未封口单元 kind（仅 insert-word 参与合并）。 */
	_undoOpen = null;
	/** 合并继续时光标应处的位置（插入点右缘）；不符即封口。 */
	_undoExpectCursor = -1;
	/** 翻历史前的在输草稿（P1-2 shell 式往返恢复）。 */
	_draft = null;
	/** 折叠粘贴原文旁路：标记序号 → 原文。提交时展开还原（expandPastes）。 */
	_pastes = /* @__PURE__ */ new Map();
	_pasteSeq = 0;
	/** 非 bracketed paste 终端的粘贴流累积：内联 return 的行内容（不含换行），
	*  流结束（普通 return）时按 \n 合并为一次提交。bracketed paste 整段经
	*  onPaste 到达、不触发累积；Vim normal 的 return 同样走合并（一致性）。 */
	_inlinePasteLines = [];
	/** 粘贴流合并提交：累积行 + 当前行并为一次多行提交；无累积行则原样提交。 */
	submitFlushingPasteLines(submitted, submittedImages) {
		if (this._inlinePasteLines.length > 0) {
			const merged = [...this._inlinePasteLines, submitted].join("\n");
			this._inlinePasteLines = [];
			this.onSubmitCallback?.(merged, submittedImages);
			return {
				type: "submit",
				value: merged,
				images: submittedImages
			};
		}
		this.onSubmitCallback?.(submitted, submittedImages);
		return {
			type: "submit",
			value: submitted,
			images: submittedImages
		};
	}
	/** 选区锚点（shift+方向键设定）；null = 无选区。选区 = [min(anchor,cursor), max)。 */
	_selAnchor = null;
	/** vim visual linewise 标记（V 进入时为 true，v 进入/退出 visual 时复位）。 */
	_visualLineWise = false;
	/** 内部剪贴板（Alt+Y yank / vim p）；系统剪贴板经 OSC52（_clipboardOut → app drain）。 */
	_clipboard = "";
	/** 待 app 写出 OSC52 的剪贴文本（takeClipboardOut 取走后清空）。 */
	_clipboardOut = null;
	/** ghost 预览文本（slash 菜单选中命令的补全剩余/参数占位）；null = 不显示。 */
	_ghost = null;
	constructor(options = {}) {
		this._value = options.value ?? "";
		this._cursor = this._value.length;
		this._placeholder = options.placeholder ?? "";
		this._history = options.history ?? [];
		this._historyIdx = -1;
		this._vimEnabled = options.vimEnabled ?? false;
		this._remapper = (options.insertRemapSequences?.length ?? 0) > 0 ? new InsertRemapper(options.insertRemapSequences ?? []) : null;
		this._vimMode = "insert";
		this._maxLength = options.maxLength ?? 1e5;
		this._images = options.images ?? [];
		if (options.onChange !== void 0) this.onChangeCallback = options.onChange;
		if (options.onSubmit !== void 0) this.onSubmitCallback = options.onSubmit;
		if (options.onTabComplete !== void 0) this.onTabCompleteCallback = options.onTabComplete;
		if (options.onImagesChange !== void 0) this.onImagesChangeCallback = options.onImagesChange;
		if (options.onOpenHistorySearch !== void 0) this.onOpenHistorySearchCallback = options.onOpenHistorySearch;
	}
	/** 当前文本值。 */
	get value() {
		return this._value;
	}
	/** 光标位置（buffer code-unit 偏移）。 */
	get cursor() {
		return this._cursor;
	}
	/** 当前 Vim 模式（vimEnabled 为 false 时恒为 insert）。 */
	get vimMode() {
		return this._vimMode;
	}
	/** Vim 键位是否启用。 */
	get vimEnabled() {
		return this._vimEnabled;
	}
	/** 占位符文本（value 为空时显示）。 */
	get placeholder() {
		return this._placeholder;
	}
	/**
	* 运行时替换空输入占位提示（如 Ctrl+C 连按退出的临时提示）。
	* @param value - 新占位符文本。
	*/
	setPlaceholder(value) {
		this._placeholder = value;
	}
	/** 手工换行模式：Enter 插入换行；粘贴流（非 bracketed paste）结束时并入草稿不提交。 */
	get newlineMode() {
		return this._newlineMode;
	}
	/**
	* 开关手工换行模式。
	* @param enabled - true 时普通 Enter 插入 \\n。
	*/
	setNewlineMode(enabled) {
		this._newlineMode = enabled;
	}
	/** 图片附件 data URL 列表（防御性拷贝）。 */
	get images() {
		return [...this._images];
	}
	/**
	* 启用/停用 vim 键位。停用或启用时都复位到 insert 模式，避免残留 normal 态吞字符；
	* 引擎 pending 解析态一并清空（半截 count/操作符不得跨开关滞留）。
	* @param enabled - 是否启用 vim 键位
	*/
	setVimEnabled(enabled) {
		this._vimEnabled = enabled;
		this._vimMode = "insert";
		this._visualLineWise = false;
		this.collapseSelection();
		this._remapper?.reset();
		if (this._vim !== null) this._vim.reset();
	}
	/** visual 模式是否为 linewise（V 进入；charwise v 为 false）。渲染 `-- VISUAL LINE --` 用。 */
	get visualLineWise() {
		return this._vimMode === "visual" && this._visualLineWise;
	}
	/**
	* 多行渲染：返回输入框的显示行数组。
	* - 空值时显示 placeholder（首行）
	* - 光标行以 `❯ ` 前缀标识（高亮行），其余行缩进对齐
	* - 光标位置以 `█` 标记
	* - 当 maxWidth 给出时，长逻辑行按显示宽度软换行，避免前文被水平视窗遮盖。
	*   maxLines 仍按光标所在视觉行裁剪，保证正在编辑的位置始终可见。
	* @param options - 视窗裁剪参数（maxLines/maxWidth）
	* @returns 输入框显示行数组
	*/
	displayLines(options = {}) {
		return this.displayLinesWithCaret(options).lines;
	}
	/**
	* displayLines + 光标 cell 坐标（2026-07-23 IME 硬件光标归位）。
	*
	* 返回的 caret 是「光标格左缘」位置（#50 反色光标：行中为反色原字符格，行尾为块 █）：line 为返回数组下标，
	* col 为 0-based cell 数（含 `❯ ` 前缀，按 ambiguousAsWide 口径度量，
	* 与 renderInputRow/rowsForLine 同尺）。调用方把硬件光标搬到该行该列，
	* 终端 IME 候选窗即锚定在输入框内（自绘光标终端不可见）。
	* @param options - 视窗裁剪参数（maxLines/maxWidth）
	* @returns 显示行数组 + 光标 cell 坐标（line 为数组下标，col 为 0-based cell）
	*/
	displayLinesWithCaret(options = {}) {
		if (options.maxWidth !== void 0) this._wrapWidth = options.maxWidth;
		if (options.maxLines !== void 0) this._maxDisplayLines = options.maxLines;
		const ambiguousAsWide = ambiguousWideEnabled();
		const prefixWidth = inputDisplayWidth("❯ ", ambiguousAsWide);
		const vimInsert = this._vimEnabled && this._vimMode === "insert";
		const barGlyph = vimInsert ? insertBarGlyph() : "█";
		if (!this._value) return {
			lines: [`❯ ${barGlyph}${this._placeholder}`],
			caret: {
				line: 0,
				col: prefixWidth
			}
		};
		const ghostActive = this._ghost !== null && this._ghost !== "" && this._cursor === this._value.length && this.selectionRange === null;
		const before = this._value.slice(0, this._cursor);
		const cursorLine = before.split("\n").length - 1;
		const cursorCol = before.length - (before.lastIndexOf("\n") + 1);
		if (options.maxWidth !== void 0) {
			const wrapped = wrapInputLines(this._value, this._cursor, options.maxWidth, this.selectionRange, vimInsert);
			const view = viewportWithCaret(wrapped.lines, wrapped.cursorLine, options.maxLines);
			if (ghostActive) {
				const lines = [...view.lines];
				const cursorLineText = lines[view.caretLine];
				if (cursorLineText !== void 0) lines[view.caretLine] = insertGhost(cursorLineText, wrapped.cursorCol + 1, this._ghost ?? "", options.maxWidth);
				return {
					lines,
					caret: {
						line: view.caretLine,
						col: wrapped.cursorCol
					}
				};
			}
			return {
				lines: view.lines,
				caret: {
					line: view.caretLine,
					col: wrapped.cursorCol
				}
			};
		}
		const ghostSuffix = ghostActive ? `${GHOST_DIM_OPEN}${this._ghost}${GHOST_DIM_CLOSE}` : "";
		const view = viewportWithCaret(this._value.split("\n").map((line, i) => {
			const isCursorLine = i === cursorLine;
			const prefix = isCursorLine ? "❯ " : "  ";
			if (!isCursorLine) return `${prefix}${line}`;
			const chUnder = line[cursorCol];
			const caretCell = chUnder === void 0 ? "█" : `${ANSI.REVERSE}${chUnder}${ANSI.RESET}`;
			return `${prefix}${vimInsert ? `${line.slice(0, cursorCol)}${barGlyph}${line.slice(cursorCol)}` : `${line.slice(0, cursorCol)}${caretCell}${line.slice(cursorCol + 1)}`}${ghostSuffix}`;
		}), cursorLine, options.maxLines);
		const col = prefixWidth + inputDisplayWidth(before.slice(before.lastIndexOf("\n") + 1), ambiguousAsWide);
		return {
			lines: view.lines,
			caret: {
				line: view.caretLine,
				col
			}
		};
	}
	/**
	* 设置 ghost 预览文本（显示在光标后、dim 色；不影响值/光标/宽度计算）。
	* 幂等：相同文本不触发重渲染状态变化。
	* @param text - ghost 文本；null 关闭。
	*/
	setGhost(text) {
		this._ghost = text;
	}
	/**
	* 设置值（外部更新用）。覆盖式写入（粘贴/补全/审批填充等）记为独立 undo 单元。
	* @param value - 新文本值（超过 maxLength 截断）
	* @param cursor - 新光标位置（钳到值长度内）；缺省置于末尾
	*/
	setValue(value, cursor) {
		this.noteVimInsertEdit();
		this.recordUndo("replace");
		this._value = value.slice(0, this._maxLength);
		this._cursor = cursor !== void 0 ? Math.min(cursor, this._value.length) : this._value.length;
		this.onChangeCallback?.(this._value, this._cursor);
	}
	/**
	* 追加文本到末尾，光标移到追加内容之后。
	* @param text - 要追加的文本
	*/
	append(text) {
		this.setValue(this._value + text, this._value.length + text.length);
	}
	/**
	* 在光标处插入文本（用于 bracketed paste），光标移动到插入内容之后。
	* 命中折叠阈值的长粘贴收纳为原子标记 `[paste #N +M lines]`（原文旁路存储）。
	* @param text - 要插入的文本；空串为 no-op
	*/
	insertText(text) {
		if (!text) return;
		const lineCount = text.split("\n").length;
		if (lineCount > PASTE_FOLD_MIN_LINES || text.length > PASTE_FOLD_MIN_CHARS) {
			const id = ++this._pasteSeq;
			this._pastes.set(id, text);
			const marker = `[paste #${id} +${lineCount} ${lineCount === 1 ? "line" : "lines"}]`;
			this.insertText(marker);
			return;
		}
		const before = this._value.slice(0, this._cursor);
		const after = this._value.slice(this._cursor);
		const next = (before + text + after).slice(0, this._maxLength);
		const cursor = Math.min(before.length + text.length, next.length);
		this.setValue(next, cursor);
	}
	/**
	* 提交前把折叠粘贴标记还原为原文（用户手输的同名标记无原文则原样保留）。
	* @param text - 可能含粘贴标记的文本
	* @returns 标记展开后的文本
	*/
	expandPastes(text) {
		if (this._pastes.size === 0) return text;
		return text.replace(PASTE_MARKER_RE, (m, id) => this._pastes.get(Number(id)) ?? m);
	}
	/**
	* 添加图片附件（data URL）。
	* @param dataUrl - 图片 data URL
	*/
	addImage(dataUrl) {
		this._images.push(dataUrl);
		this.onImagesChangeCallback?.([...this._images]);
	}
	/**
	* 移除指定索引的图片附件；越界索引为 no-op。
	* @param index - 要移除的附件下标
	*/
	removeImage(index) {
		if (index < 0 || index >= this._images.length) return;
		this._images.splice(index, 1);
		this.onImagesChangeCallback?.([...this._images]);
	}
	/** 清空图片附件。 */
	clearImages() {
		if (this._images.length === 0) return;
		this._images = [];
		this.onImagesChangeCallback?.([]);
	}
	/**
	* 图片占位摘要，用于 ANSI 渲染。
	* @param maxWidth - 摘要最大宽度；超宽时截断加省略号
	* @returns 摘要行数组；无附件时为空数组
	*/
	imageSummary(maxWidth) {
		if (this._images.length === 0) return [];
		const hint = this._value.length === 0 ? " · Alt+⌫ 移除末张" : "";
		const label = `📎 ${this._images.length} image${this._images.length > 1 ? "s" : ""}${hint}`;
		if (!maxWidth || label.length <= maxWidth) return [label];
		return [label.slice(0, maxWidth - 1) + "…"];
	}
	/**
	* 设置历史记录（最新的在前，供上下键导航）。
	* @param history - 历史条目列表
	*/
	setHistory(history) {
		this._history = history;
	}
	/** 选区范围（start<end，buffer code-unit 偏移）；无选区或锚点=光标时 null。
	*  vim visual linewise（V）时对齐整行：start=起始行行首，end=结束行行尾——
	*  删除/复制/高亮自动行级化。 */
	get selectionRange() {
		if (this._selAnchor === null || this._selAnchor === this._cursor) return null;
		let start = Math.min(this._selAnchor, this._cursor);
		let end = Math.max(this._selAnchor, this._cursor);
		if (this._vimMode === "visual" && this._visualLineWise) {
			start = this._value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
			const nl = this._value.indexOf("\n", end);
			end = nl === -1 ? this._value.length : nl + 1;
		}
		return {
			start,
			end
		};
	}
	/**
	* 取走待 OSC52 写出的剪贴文本（app 渲染循环 drain），取走后清空。
	* @returns 待写出的剪贴文本；无待写内容时为 null
	*/
	takeClipboardOut() {
		const t = this._clipboardOut;
		this._clipboardOut = null;
		return t;
	}
	collapseSelection() {
		this._selAnchor = null;
	}
	/** Shift+←/→/Home/End：锚定（首次）并移动光标扩展选区。 */
	extendSelection(name) {
		if (this._selAnchor === null) this._selAnchor = this._cursor;
		this.sealUndo();
		switch (name) {
			case "left":
				this._cursor = this.prevGrapheme();
				break;
			case "right":
				this._cursor = this.nextGrapheme();
				break;
			case "home":
				this._cursor = 0;
				break;
			case "end": this._cursor = this._value.length;
		}
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** Backspace/Delete（有选区）：删除选区（独立 undo 单元）。 */
	deleteSelection() {
		this.noteVimInsertEdit();
		const r = this.selectionRange;
		if (!r) return null;
		this.recordUndo("delete");
		this._value = this._value.slice(0, r.start) + this._value.slice(r.end);
		this._cursor = r.start;
		this.collapseSelection();
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** Ctrl+K（有选区）：剪切选区 → 内部剪贴板 + OSC52 drain。 */
	cutSelection() {
		this.noteVimInsertEdit();
		const r = this.selectionRange;
		if (!r) return null;
		this._clipboard = this._value.slice(r.start, r.end);
		this._clipboardOut = this._clipboard;
		return this.deleteSelection();
	}
	/** Alt+W：复制选区 → 内部剪贴板 + OSC52 drain（不删除，复制后折叠选区）。 */
	copySelection() {
		const r = this.selectionRange;
		if (!r) return null;
		this._clipboard = this._value.slice(r.start, r.end);
		this._clipboardOut = this._clipboard;
		this.collapseSelection();
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** Alt+Y：yank 内部剪贴板（直插不走粘贴折叠；setValue 记 undo）。 */
	yankClipboard() {
		this.noteVimInsertEdit();
		if (!this._clipboard) return null;
		const before = this._value.slice(0, this._cursor);
		const after = this._value.slice(this._cursor);
		this.setValue(before + this._clipboard + after, before.length + this._clipboard.length);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/**
	* 处理按键：按全局键 → 选区 → vim 模式 → insert 模式的优先级路由。
	* @param name - 按键语义名称（InputHandler 的 KeyName）
	* @param char - 可打印字符；控制键为 ''
	* @param ctrl - Ctrl 是否按下
	* @param meta - Alt/Meta 是否按下
	* @param shift - Shift 是否按下
	* @param inline - 该 return 后同一输入缓冲还有后续字节（非 bracketed paste
	*   终端的粘贴流行分隔；见 InputHandler KeyPress.inline）。
	* @returns 产生的事件（change/submit/tab/history）；按键未引起变化时为 null
	*/
	handleKey(name, char, ctrl, meta, shift = false, inline = false) {
		if (name === "return" && (shift || meta)) return this.insertChar("\n");
		if (name === "return") {
			if (this._value.slice(0, this._cursor).endsWith("\\")) {
				this.recordUndo("replace");
				const before = this._value.slice(0, this._cursor - 1);
				const after = this._value.slice(this._cursor);
				this._value = before + "\n" + after;
				this._cursor = before.length + 1;
				this.onChangeCallback?.(this._value, this._cursor);
				return {
					type: "change",
					value: this._value,
					cursor: this._cursor
				};
			}
			if (this._newlineMode && !inline) {
				if (this._inlinePasteLines.length > 0) {
					const merged = [...this._inlinePasteLines, this.expandPastes(this._value)].join("\n");
					this._inlinePasteLines = [];
					this.setValue(merged + "\n", merged.length + 1);
					return {
						type: "change",
						value: this._value,
						cursor: this._cursor
					};
				}
				return this.insertChar("\n");
			}
			const submitted = this.expandPastes(this._value);
			const submittedImages = [...this._images];
			this.clearAfterSubmit();
			this.onImagesChangeCallback?.([]);
			if (inline) {
				this._inlinePasteLines.push(submitted);
				return {
					type: "change",
					value: "",
					cursor: 0
				};
			}
			return this.submitFlushingPasteLines(submitted, submittedImages);
		}
		if (name === "ctrl_j") return this.insertChar("\n");
		if (name === "tab" && !ctrl) {
			this.onTabCompleteCallback?.();
			return { type: "tab" };
		}
		if (this._vimEnabled && this._vimMode === "visual") return this.ensureVim().handleVisual(name, char, ctrl) === "handled" ? {
			type: "change",
			value: this._value,
			cursor: this._cursor
		} : null;
		if (shift && !ctrl && !meta && (name === "left" || name === "right" || name === "home" || name === "end")) return this.extendSelection(name);
		if (meta && char === "w") return this.copySelection();
		if (meta && char === "y") return this.yankClipboard();
		if (ctrl && name === "ctrl_k" && this.selectionRange) return this.cutSelection();
		if (!ctrl && !meta && (name === "backspace" || name === "delete") && this.selectionRange) return this.deleteSelection();
		this.collapseSelection();
		if (this._vimEnabled && this._vimMode === "normal") return this.ensureVim().handleNormal(name, char, ctrl) === "handled" ? {
			type: "change",
			value: this._value,
			cursor: this._cursor
		} : null;
		if (name === "ctrl_r") {
			this.onOpenHistorySearchCallback?.();
			return null;
		}
		if (meta) switch (name) {
			case "left": return this.moveWordLeft();
			case "right": return this.moveWordRight();
			case "backspace": return this.deleteWordBack();
			case "delete": return this.deleteWordForward();
			default: return null;
		}
		switch (name) {
			case "escape":
				if (this._vimEnabled) {
					if (this._vim !== null) this._vim.finalizeInsertRepeat();
					this.sealUndo();
					this._vimMode = "normal";
					return {
						type: "change",
						value: this._value,
						cursor: this._cursor
					};
				}
				break;
			case "backspace":
			case "ctrl_h": return this.backspace();
			case "delete": return this.deleteForward();
			case "left": return this.moveLeft();
			case "right": return this.moveRight();
			case "home": return this.moveHome();
			case "end": return this.moveEnd();
			case "up": return this.moveUpOrHistory();
			case "down": return this.moveDownOrHistory();
			case "pageup": return this.movePage(-1);
			case "pagedown": return this.movePage(1);
		}
		if (ctrl) {
			switch (name) {
				case "ctrl_a": return this.moveHome();
				case "ctrl_e": return this.moveEnd();
				case "ctrl_u": return this.deleteToStart();
				case "ctrl_k": return this.deleteToEnd();
				case "ctrl_w": return this.deleteWordBack();
				case "ctrl_d": return this.deleteForward();
				case "ctrl_b": return this.moveLeft();
				case "ctrl_f": return this.moveRight();
				case "ctrl_n": return this.historyNext();
				case "ctrl_p": return this.historyPrev();
				case "ctrl_minus":
				case "ctrl_z": return this.undo();
				case "ctrl_y": return this.redo();
			}
			return null;
		}
		if (char && char.length > 0) return this.insertChar(char);
		return null;
	}
	/**
	* 改值前记录 undo 单元（改前快照）。仅 insert-word 在光标连续时合并
	* （不新增单元）；其余 kind 每次独立成元。kind 切换即自然封口。
	*/
	recordUndo(kind) {
		this._redoStack = [];
		this._redoChars = 0;
		if (!(kind === "insert-word" && this._undoOpen === kind && this._undoExpectCursor === this._cursor)) {
			this._undoStack.push({
				value: this._value,
				cursor: this._cursor,
				kind
			});
			this._undoChars += this._value.length;
			while (this._undoStack.length > UNDO_STACK_MAX || this._undoChars > UNDO_TOTAL_CHARS_MAX) {
				const dropped = this._undoStack.shift();
				if (!dropped) break;
				this._undoChars -= dropped.value.length;
			}
		}
		this._undoOpen = kind;
		this._undoExpectCursor = -1;
	}
	/** 纯光标移动/模式切换：封口袋前单元（不产生新单元）。 */
	sealUndo() {
		this._undoOpen = null;
		this._undoExpectCursor = -1;
	}
	/** fish 式撤销：弹出最近单元恢复 {value, cursor}。Ctrl+- / Ctrl+Z。 */
	undo() {
		this.noteVimInsertEdit();
		const unit = this._undoStack.pop();
		this.sealUndo();
		if (!unit) return null;
		this._undoChars -= unit.value.length;
		this._redoStack.push({
			value: this._value,
			cursor: this._cursor,
			kind: unit.kind
		});
		this._redoChars += this._value.length;
		while (this._redoStack.length > UNDO_STACK_MAX || this._redoChars > UNDO_TOTAL_CHARS_MAX) {
			const dropped = this._redoStack.shift();
			if (!dropped) break;
			this._redoChars -= dropped.value.length;
		}
		this._value = unit.value;
		this._cursor = Math.min(unit.cursor, this._value.length);
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** 重做：恢复最近一次 undo 前的状态。Ctrl+Y。 */
	redo() {
		this.noteVimInsertEdit();
		const unit = this._redoStack.pop();
		this.sealUndo();
		if (!unit) return null;
		this._redoChars -= unit.value.length;
		this._undoStack.push({
			value: this._value,
			cursor: this._cursor,
			kind: unit.kind
		});
		this._undoChars += this._value.length;
		this._value = unit.value;
		this._cursor = Math.min(unit.cursor, this._value.length);
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/**
	* 提交后重置缓冲：清空文本、归零光标、复位历史游标、清空图片附件。
	* 不触发 onChangeCallback —— submit 路径自己负责后续渲染，
	* 避免在 submit 回调里又触发一次 change 渲染造成竞态。
	*/
	clearAfterSubmit() {
		this._value = "";
		this._cursor = 0;
		this._historyIdx = -1;
		this._images = [];
		this._remapper?.reset();
		this._undoStack = [];
		this._undoChars = 0;
		this._redoStack = [];
		this._redoChars = 0;
		this.sealUndo();
		this._draft = null;
		this._pastes.clear();
		this._selAnchor = null;
		this._visualLineWise = false;
	}
	insertChar(ch) {
		if (this._value.length >= this._maxLength) return null;
		const vimInsert = this._vimEnabled && this._vimMode === "insert";
		if (vimInsert && this._vim !== null) this._vim.captureTyping(ch);
		const kind = classifyInsert(ch);
		this.recordUndo(kind);
		const before = this._value.slice(0, this._cursor);
		const after = this._value.slice(this._cursor);
		this._value = before + ch + after;
		this._cursor += ch.length;
		if (vimInsert && this._remapper !== null) {
			const cutFrom = this._remapper.onChar(ch, this._cursor, Date.now());
			if (cutFrom !== null) {
				if (this._vim !== null) this._vim.markInsertDirty();
				this._value = this._value.slice(0, cutFrom) + this._value.slice(this._cursor);
				this._cursor = cutFrom;
				this._vimMode = "normal";
				this.recordUndo("delete");
				this.onChangeCallback?.(this._value, this._cursor);
				return {
					type: "change",
					value: this._value,
					cursor: this._cursor
				};
			}
		}
		if (kind === "insert-word") this._undoExpectCursor = this._cursor;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	backspace() {
		this.noteVimInsertEdit();
		if (this._cursor <= 0) return null;
		this.recordUndo("delete");
		const left = this._value.slice(0, this._cursor);
		const mentionTail = left.match(/@(?:file|folder|symbol|codebase):(?:"[^"]+"|[^\s]+)\s?$/);
		const nextCh = this._value[this._cursor] ?? "";
		if (mentionTail && (nextCh === "" || /\s/.test(nextCh))) {
			const start = this._cursor - mentionTail[0].length;
			this._value = left.slice(0, start) + this._value.slice(this._cursor);
			this._cursor = start;
			this.onChangeCallback?.(this._value, this._cursor);
			return {
				type: "change",
				value: this._value,
				cursor: this._cursor
			};
		}
		const start = this.prevGrapheme();
		const before = this._value.slice(0, start);
		const after = this._value.slice(this._cursor);
		this._value = before + after;
		this._cursor = start;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	deleteForward() {
		this.noteVimInsertEdit();
		if (this._cursor >= this._value.length) return null;
		this.recordUndo("delete");
		const end = this.nextGrapheme();
		const before = this._value.slice(0, this._cursor);
		const after = this._value.slice(end);
		this._value = before + after;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	deleteToStart() {
		this.noteVimInsertEdit();
		const { line } = this.getLineCol(this._cursor);
		const start = this.absolutePos(line, 0);
		if (this._cursor <= start) return null;
		this.recordUndo("delete");
		this._value = this._value.slice(0, start) + this._value.slice(this._cursor);
		this._cursor = start;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	deleteToEnd() {
		this.noteVimInsertEdit();
		const lines = this._value.split("\n");
		const { line } = this.getLineCol(this._cursor);
		const end = this.absolutePos(line, (lines[line] ?? "").length);
		if (this._cursor >= end) return null;
		this.recordUndo("delete");
		this._value = this._value.slice(0, this._cursor) + this._value.slice(end);
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	deleteWordBack() {
		this.noteVimInsertEdit();
		if (this._cursor <= 0) return null;
		this.recordUndo("delete");
		const start = this.prevWordStart();
		const before = this._value.slice(0, start);
		const after = this._value.slice(this._cursor);
		this._value = before + after;
		this._cursor = start;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	deleteWordForward() {
		this.noteVimInsertEdit();
		if (this._cursor >= this._value.length) return null;
		this.recordUndo("delete");
		const end = this.nextWordEnd();
		const before = this._value.slice(0, this._cursor);
		const after = this._value.slice(end);
		this._value = before + after;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	moveLeft() {
		if (this._cursor <= 0) return null;
		this.sealUndo();
		this._cursor = this.prevGrapheme();
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	moveRight() {
		if (this._cursor >= this._value.length) return null;
		this.sealUndo();
		this._cursor = this.nextGrapheme();
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** insert 模式里的非顺序改动（删除/粘贴/补全/历史跳转）→ `.` 放弃保真记录。 */
	noteVimInsertEdit() {
		if (this._vimEnabled && this._vimMode === "insert" && this._vim !== null) this._vim.markInsertDirty();
	}
	/** 光标左侧最近的 grapheme 边界。 */
	prevGrapheme() {
		return this.prevGraphemeAt(this._cursor);
	}
	/** 光标右侧最近的 grapheme 边界。 */
	nextGrapheme() {
		return this.nextGraphemeAt(this._cursor);
	}
	/** 任意位置起左移一步的 grapheme 边界（vim 引擎宿主面用）。 */
	prevGraphemeAt(pos) {
		if (pos <= 0) return 0;
		return boundaryBefore(this.graphemeBounds(), pos);
	}
	/** 任意位置起右移一步的 grapheme 边界。 */
	nextGraphemeAt(pos) {
		if (pos >= this._value.length) return this._value.length;
		const b = boundaryAfter(this.graphemeBounds(), pos);
		return b < 0 ? this._value.length : b;
	}
	/** 当前 value 的 grapheme 边界（按 value 缓存，纯光标移动命中缓存）。
	*  折叠粘贴标记为原子单位：标记内部的边界被剔除，光标/删除整体越过。 */
	graphemeBounds() {
		if (this._graphemeCache?.value === this._value) return this._graphemeCache.bounds;
		let bounds = graphemeBoundaries(this._value);
		if (this._pastes.size > 0) bounds = atomicPasteMarkerBounds(this._value, bounds);
		this._graphemeCache = {
			value: this._value,
			bounds
		};
		return bounds;
	}
	moveHome() {
		const { line } = this.getLineCol(this._cursor);
		const pos = this.absolutePos(line, 0);
		if (pos === this._cursor) return null;
		this.sealUndo();
		this._cursor = pos;
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	moveEnd() {
		const lines = this._value.split("\n");
		const { line } = this.getLineCol(this._cursor);
		const pos = this.absolutePos(line, (lines[line] ?? "").length);
		if (pos === this._cursor) return null;
		this.sealUndo();
		this._cursor = pos;
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	moveWordLeft() {
		const start = this.prevWordStart();
		if (start === this._cursor) return null;
		this.sealUndo();
		this._cursor = start;
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	moveWordRight() {
		const end = this.nextWordEnd();
		if (end === this._cursor || end >= this._value.length && this._cursor === this._value.length) return null;
		this.sealUndo();
		this._cursor = end;
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	/** 当前光标的（行,列），列以 grapheme 计（CJK/emoji/组合簇不被拆开）。 */
	getLineCol(pos) {
		const parts = this._value.slice(0, pos).split("\n");
		const last = parts[parts.length - 1];
		return {
			line: parts.length - 1,
			col: last === void 0 ? 0 : graphemeBoundaries(last).length - 1
		};
	}
	/** 由（行,grapheme 列）还原 code-unit 偏移，col 超出行长则贴到行尾。 */
	posFromLineCol(line, col) {
		const lines = this._value.split("\n");
		const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
		let pos = 0;
		for (let i = 0; i < clampedLine; i++) {
			const l = lines[i];
			if (l === void 0) break;
			pos += l.length + 1;
		}
		const last = lines[clampedLine];
		if (last !== void 0) {
			const bounds = graphemeBoundaries(last);
			pos += bounds[Math.min(Math.max(0, col), bounds.length - 1)] ?? 0;
		}
		return pos;
	}
	/** 逻辑行 `line` 内 code-unit 偏移 → 整段 buffer 偏移。 */
	absolutePos(line, offset) {
		const lines = this._value.split("\n");
		let pos = 0;
		const last = Math.min(Math.max(line, 0), Math.max(0, lines.length - 1));
		for (let i = 0; i < last; i++) pos += (lines[i]?.length ?? 0) + 1;
		const logical = lines[last] ?? "";
		return pos + Math.min(Math.max(0, offset), logical.length);
	}
	/**
	* 按显示宽度把一行切成视觉行起点（不含自绘 █）。
	* @param logical - 一条逻辑行（不含换行符）。
	* @param maxContentWidth - 去掉 `❯ ` 前缀后的内容列数。
	*/
	visualRowStarts(logical, maxContentWidth) {
		const starts = [0];
		if (logical.length === 0) return starts;
		const ambiguousAsWide = ambiguousWideEnabled();
		const bounds = graphemeBoundaries(logical);
		let width = 0;
		for (let g = 0; g < bounds.length - 1; g++) {
			const start = bounds[g];
			const end = bounds[g + 1];
			if (start === void 0 || end === void 0) continue;
			const cw = Math.max(1, inputDisplayWidth(logical.slice(start, end), ambiguousAsWide));
			if (width > 0 && width + cw > maxContentWidth) {
				starts.push(start);
				width = cw;
			} else width += cw;
		}
		return starts;
	}
	/** 全部逻辑行展开后的视觉行（start/end 为该逻辑行内偏移）。 */
	collectVisualRows() {
		const maxContent = Math.max(1, (this._wrapWidth ?? 80) - 2);
		const lines = this._value.split("\n");
		const rows = [];
		for (let i = 0; i < lines.length; i++) {
			const logical = lines[i] ?? "";
			const starts = this.visualRowStarts(logical, maxContent);
			for (let s = 0; s < starts.length; s++) {
				const start = starts[s] ?? 0;
				const end = s + 1 < starts.length ? starts[s + 1] ?? logical.length : logical.length;
				rows.push({
					line: i,
					start,
					end
				});
			}
		}
		return rows;
	}
	/**
	* 在软折行与逻辑行之间移动。单视觉行且无换行时交给历史上翻。
	* @param delta - 负上正下；越界夹到两端（不翻历史）。
	*/
	tryMoveVisual(delta) {
		const rows = this.collectVisualRows();
		if (!(rows.length > 1 || this._value.includes("\n"))) return "history";
		const { line } = this.getLineCol(this._cursor);
		const colOffset = this._cursor - this.absolutePos(line, 0);
		let idx = 0;
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			if (row === void 0) continue;
			if (row.line < line || row.line === line && row.start <= colOffset) idx = r;
		}
		const targetIdx = Math.min(rows.length - 1, Math.max(0, idx + delta));
		if (targetIdx === idx) return "edge";
		const current = rows[idx];
		const dest = rows[targetIdx];
		if (current === void 0 || dest === void 0) return "edge";
		this.sealUndo();
		if (dest.line !== current.line) {
			const { col } = this.getLineCol(this._cursor);
			this._cursor = this.posFromLineCol(dest.line, col);
			return "moved";
		}
		const destOffset = Math.min(dest.end, dest.start + Math.max(0, colOffset - current.start));
		this._cursor = this.absolutePos(dest.line, destOffset);
		return "moved";
	}
	/** Up：有折行或多行时上移视觉行，否则取上一条历史。 */
	moveUpOrHistory() {
		const result = this.tryMoveVisual(-1);
		if (result === "history") return this.historyPrev();
		if (result === "moved") return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
		return null;
	}
	/** Down：有折行或多行时下移视觉行，否则取下一条历史。 */
	moveDownOrHistory() {
		const result = this.tryMoveVisual(1);
		if (result === "history") return this.historyNext();
		if (result === "moved") return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
		return null;
	}
	/** PageUp/PageDown：按最近一次视窗行数翻页；单行短草稿不翻历史。 */
	movePage(direction) {
		const jump = Math.max(1, (this._maxDisplayLines ?? 8) - 2) * direction;
		if (this.tryMoveVisual(jump) === "moved") return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
		return null;
	}
	historyPrev() {
		if (this._history.length === 0) return null;
		this.recordUndo("replace");
		if (this._historyIdx === -1) {
			this._draft = this._value;
			this._historyIdx = 0;
		} else if (this._historyIdx < this._history.length - 1) this._historyIdx++;
		else {
			this.sealUndo();
			return null;
		}
		this._value = this._history[this._historyIdx] ?? "";
		this._cursor = this._value.length;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	historyNext() {
		if (this._historyIdx < 0) return null;
		this.recordUndo("replace");
		if (this._historyIdx === 0) {
			this._historyIdx = -1;
			this._value = this._draft ?? "";
			this._draft = null;
		} else {
			this._historyIdx--;
			this._value = this._history[this._historyIdx] ?? "";
		}
		this._cursor = this._value.length;
		this.onChangeCallback?.(this._value, this._cursor);
		return {
			type: "change",
			value: this._value,
			cursor: this._cursor
		};
	}
	ensureVim() {
		if (this._vim !== null) return this._vim;
		const host = {
			value: () => this._value,
			cursor: () => this._cursor,
			moveCursor: (pos) => {
				this.sealUndo();
				this._cursor = Math.max(0, Math.min(pos, this._value.length));
			},
			spliceRange: (start, end, replacement, kind, cursorAfter) => {
				const s = Math.max(0, Math.min(start, this._value.length));
				const e = Math.max(s, Math.min(end, this._value.length));
				this.recordUndo(kind);
				this._value = this._value.slice(0, s) + replacement + this._value.slice(e);
				this._cursor = Math.max(0, Math.min(cursorAfter ?? s + replacement.length, this._value.length));
				this.onChangeCallback?.(this._value, this._cursor);
			},
			setRegister: (text) => {
				this._clipboard = text;
			},
			register: () => this._clipboard,
			undoOnce: () => this.undo() !== null,
			redoOnce: () => this.redo() !== null,
			nextGrapheme: (pos) => this.nextGraphemeAt(pos),
			prevGrapheme: (pos) => this.prevGraphemeAt(pos),
			beginVisual: (linewise) => {
				this.sealUndo();
				this._selAnchor = this._cursor;
				this._visualLineWise = linewise;
				this._vimMode = "visual";
			},
			exitVisual: (to) => {
				this.collapseSelection();
				this._visualLineWise = false;
				this._vimMode = to === "insert" ? "insert" : "normal";
			},
			selection: () => {
				const r = this.selectionRange;
				if (r === null) return null;
				return {
					...r,
					linewise: this._vimMode === "visual" && this._visualLineWise,
					anchor: this._selAnchor ?? r.start
				};
			},
			swapVisualEnds: () => {
				if (this._selAnchor !== null) {
					const tmp = this._selAnchor;
					this._selAnchor = this._cursor;
					this._cursor = tmp;
				}
			},
			isLinewiseVisual: () => this._vimMode === "visual" && this._visualLineWise,
			enterInsert: (prepare) => {
				if (prepare !== void 0) prepare();
				this._vimMode = "insert";
			},
			setModeNormal: () => {
				this._vimMode = "normal";
			},
			openHistorySearch: () => {
				this.onOpenHistorySearchCallback?.();
			},
			historyFallback: (dir) => (dir === "prev" ? this.historyPrev() : this.historyNext()) !== null
		};
		this._vim = new VimInput(host);
		return this._vim;
	}
	prevWordStart() {
		if (this._cursor <= 0) return 0;
		let i = this._cursor - 1;
		while (i > 0 && !/\w/.test(this._value[i] ?? "")) i--;
		while (i > 0 && /\w/.test(this._value[i - 1] ?? "")) i--;
		return i;
	}
	nextWordEnd() {
		if (this._cursor >= this._value.length) return this._value.length;
		let i = this._cursor;
		while (i < this._value.length && !/\w/.test(this._value[i] ?? "")) i++;
		if (i >= this._value.length) return this._cursor;
		while (i < this._value.length && /\w/.test(this._value[i] ?? "")) i++;
		return i;
	}
};
//#endregion
//#region lib/types/completion/file-completer.js
/**
* Adapted for the dsh-tui port seam (Apache License 2.0, section 4(b)):
* upstream source .rivet/tui-source/tui/file-completer.ts, Copyright
* 2025-2026 Tianshu Contributors, licensed under the Apache License, Version
* 2.0 (see LICENSE and NOTICE). Modified: relocated src/tui/ → src/completion/;
* `resolveFileCompletion` (Tab 协调入口) is dsh-owned, added for Phase 6.3.
*/
/**
* Tab 补全的 `@` 触发后从光标前最近 `@` 起的非空白 token。
* token 内的 emoji/CJK 不会被切碎——正则用 `[^\s]` 锁住空白边界，
* 让用户粘贴「@🎯 目标.md」或「@中文 路径.md」类带表情符号/中文的
* 路径请求走完整个 token，再交由 `getCompletions` 走 git ls-files 过滤。
* @param text - 输入框当前完整文本。
* @param cursorPos - 光标位置（token 只在光标前查找）。
* @returns `@` 后的 token（可为空串）；光标前无 `@` token 时为 null。
*/
function extractAtToken(text, cursorPos) {
	return text.slice(0, cursorPos).match(/@([^\s]*)$/)?.[1] ?? null;
}
const GIT_LS_FILES_TIMEOUT_MS = 500;
/**
* 走 `git ls-files` 拿补全候选（前缀命中优先，其次短路径优先）。
*
* 非 git 目录 / 命令失败 / 超时 → 静默返回 []，**不抛错**：
* @-补全是输入便利功能，不应污染主流程；上层也只把候选列表当作
* 「建议」，空候选就当普通 @-token 提交给 agent。
* @param partial - 已输入的路径片段（大小写不敏感子串匹配）。
* @param cwd - git 仓库工作目录。
* @param limit - 候选上限。
* @param timeoutMs - git ls-files 超时毫秒数（缺省 500ms，见上方权衡）。
* @returns 匹配的仓库相对路径列表；失败/超时静默返回 []。
*/
function getCompletions(partial, cwd, limit, timeoutMs = GIT_LS_FILES_TIMEOUT_MS) {
	try {
		const output = execFileSync("git", [
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard"
		], {
			cwd,
			encoding: "utf-8",
			timeout: timeoutMs,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const lower = partial.toLowerCase();
		return output.trim().split(/\r?\n/).filter(Boolean).filter((f) => f.toLowerCase().includes(lower)).sort((a, b) => {
			return (a.toLowerCase().startsWith(lower) ? 0 : 1) - (b.toLowerCase().startsWith(lower) ? 0 : 1) || a.length - b.length;
		}).slice(0, limit);
	} catch {
		return [];
	}
}
/**
* 把选中的候选回填到输入：光标前最近 `@` 起替换为规范形 `@file:` 引用
* （含空格路径加引号），并附一个尾随空格。
* @param text - 输入框当前完整文本。
* @param cursorPos - 光标位置。
* @param completion - 选中的仓库相对路径。
* @returns 回填后的文本与新光标位置（落在尾随空格之后）。
*/
function applyCompletion(text, cursorPos, completion) {
	const before = text.slice(0, cursorPos);
	const after = text.slice(cursorPos);
	const atIdx = before.lastIndexOf("@");
	const mention = completion.includes(" ") ? `@file:"${completion}" ` : `@file:${completion} `;
	return {
		text: before.slice(0, atIdx) + mention + after,
		cursor: atIdx + mention.length
	};
}
/**
* dsh 新增（Phase 6.3）：Tab 补全协调入口。
*
* 仅当光标前存在 `@` 路径 token（路径片段，可含 / . emoji/CJK）时才接管
* Tab：返回 token 与候选；无 token 或无候选返回 null，Tab 保持原行为。
* 与 slash 轮协调：slash 分支在输入以 `/` 开头时优先，@ token 条件天然
* 隔离二者，互不重叠。
* @param input - 输入框当前完整文本。
* @param cursor - 光标位置。
* @param cwd - git 仓库工作目录。
* @param limit - 候选上限（缺省 8）。
* @param timeoutMs - git ls-files 超时（缺省 500ms，产品即时性权衡）；
*   测试/慢速环境可显式放宽。
* @returns token 与候选列表；无 token 或无候选时为 null（Tab 保持原行为）。
*/
function resolveFileCompletion(input, cursor, cwd, limit = 8, timeoutMs = GIT_LS_FILES_TIMEOUT_MS) {
	const token = extractAtToken(input, cursor);
	if (token === null) return null;
	const candidates = getCompletions(token, cwd, limit, timeoutMs);
	if (candidates.length === 0) return null;
	return {
		token,
		candidates
	};
}
//#endregion
//#region lib/types/engine/input-controller.js
/** MRU 列表长度上限（超出丢弃最旧）。 */
const SLASH_MRU_MAX = 10;
/**
* Input state manager — holds the 6 input-related state fields extracted from
* TuiApp (W-B5). Input event handling (onAnyKey, onSubmit), key routing, slash
* command processing, and tab completion logic stay in TuiApp; this class only
* manages the state values.
*/
var InputController = class {
	/** slash 命令列表（外部注入，提示 + Tab 补全用） */
	slashCommands = [];
	/** slash hint 当前选中项索引（输入以 / 开头时，Tab 补全目标） */
	slashSelectedIdx = 0;
	/** slash 命令菜单状态（输入变化经 refreshSlash 更新；app.ts 渲染与键路由消费）。 */
	slashMenu = {
		open: false,
		query: "",
		matches: [],
		selected: 0
	};
	/** 最近使用命令名（最新在前，上限 SLASH_MRU_MAX；匹配排序 MRU 优先）。 */
	slashMru = [];
	/** 光标前 @ token 的文件补全状态（Tab 循环）；null = 未在补全中。 */
	fileCompletion = null;
	/**
	* 记录一次命令执行（MRU 排序数据源）：去重前移、超上限截断尾部。
	* @param name - 命令名（不含 / 前缀）。
	*/
	recordSlashUse(name) {
		this.slashMru = [name, ...this.slashMru.filter((n) => n !== name)].slice(0, 10);
	}
	/**
	* 输入变化时刷新 slash 菜单：
	* - 完整命令名 + 尾空格（参数模式，如 `/theme `）且命令带 argsHint → 菜单
	*   保持打开显示该命令，输入行 ghost 提示参数占位（app.ts 消费）。
	* - 以 / 开头且有匹配命令 → 打开并保持选择（carry：query 不变时按命令名
	*   找回选中项）；无匹配或非 / 输入 → 关闭。
	* @param value - 输入行当前文本。
	*/
	refreshSlash(value) {
		if (!value.startsWith("/")) {
			this.closeSlash();
			return;
		}
		const query = value.slice(1);
		const argMatch = /^(\S+) $/.exec(query);
		if (argMatch !== null) {
			const cmdName = argMatch[1];
			const cmd = this.slashCommands.find((c) => c.name === cmdName);
			if (cmd !== void 0 && cmd.argsHint !== void 0) {
				this.slashMenu = {
					open: true,
					query,
					matches: [cmd],
					selected: 0
				};
				return;
			}
		}
		const prev = this.slashMenu;
		const matches = this.suggestMatches(query);
		if (matches.length === 0) {
			this.closeSlash();
			return;
		}
		this.slashMenu = {
			open: true,
			query,
			matches,
			selected: prev.open && prev.query === query ? this.carrySelection(prev, matches) : 0
		};
	}
	/** 关闭 slash 菜单（保持 matches 供渲染兜底，open 置 false）。 */
	closeSlash() {
		this.slashMenu.open = false;
	}
	/**
	* 移动菜单选择（↑↓；环绕）。
	* @param delta - 步长（-1 / +1）。
	*/
	moveSlashSelection(delta) {
		const m = this.slashMenu;
		if (!m.open || m.matches.length === 0) return;
		m.selected = (m.selected + delta + m.matches.length) % m.matches.length;
	}
	/**
	* 滚动菜单选择（PageUp/Down；两端 clamp 不环绕）。
	* @param delta - 步长（±maxRows 由调用方给定）。
	*/
	scrollSlashSelection(delta) {
		const m = this.slashMenu;
		if (!m.open || m.matches.length === 0) return;
		m.selected = Math.max(0, Math.min(m.matches.length - 1, m.selected + delta));
	}
	/**
	* 匹配：前缀优先 + 子串兜底（均按注册顺序稳定排序）。
	* @param query - 去 / 前缀的查询（空串 = 全量列表）。
	* @returns 匹配条目。
	*/
	suggestMatches(query) {
		const rank = this.mruRank();
		const sortByMru = (entries) => [...entries].sort((a, b) => (rank.get(b.name) ?? 0) - (rank.get(a.name) ?? 0));
		if (query === "") return sortByMru(this.slashCommands);
		const q = query.toLowerCase();
		const prefix = [];
		const substring = [];
		for (const c of this.slashCommands) {
			const name = c.name.toLowerCase();
			if (name.startsWith(q)) prefix.push(c);
			else if (name.includes(q)) substring.push(c);
		}
		return [...sortByMru(prefix), ...sortByMru(substring)];
	}
	/** MRU 排名表：最近使用得分最高（未使用 0 分）。 */
	mruRank() {
		const rank = /* @__PURE__ */ new Map();
		for (let i = 0; i < this.slashMru.length; i++) {
			const name = this.slashMru[i];
			/* v8 ignore next -- 循环内下标恒在界内；noUncheckedIndexedAccess 防御 */
			if (name === void 0) continue;
			rank.set(name, this.slashMru.length - i);
		}
		return rank;
	}
	/**
	* query 未变时按命令名找回上一选中项（输入变化不重置选择）。
	* @param prev - 上一菜单状态（open 且 query 相同）。
	* @param matches - 新匹配列表。
	* @returns 选中项下标（找不到回 0）。
	*/
	carrySelection(prev, matches) {
		const prevName = prev.matches[prev.selected]?.name;
		/* v8 ignore next -- open=true 时 matches 恒非空且 selected 由 move/scroll 钳制；防御分支 */
		if (prevName === void 0) return 0;
		const idx = matches.findIndex((m) => m.name === prevName);
		return idx >= 0 ? idx : 0;
	}
	/**
	* Tab 补全驱动（Phase 6.3）：首次 Tab 解析光标前 @ token 的候选并应用
	* 首项；再次 Tab 在候选间循环（唯一候选直接应用且不进入循环）。
	* 无 @ token 或无候选返回 null——Tab 保持原行为，由调用方决定是否消费。
	* @param value - 输入行当前文本。
	* @param cursor - 光标位置（code-unit 偏移）。
	* @param cwd - 补全基目录（git ls-files 执行目录）。
	* @param limit - 候选数量上限（默认 8）。
	* @param timeoutMs - git ls-files 超时（缺省 500ms 产品权衡；测试可放宽）。
	* @returns 要应用到输入行的 { text, cursor }；无可补全返回 null。
	*/
	tabComplete(value, cursor, cwd, limit = 8, timeoutMs) {
		if (this.fileCompletion !== null && this.fileCompletion.candidates.length > 1) {
			const fc = this.fileCompletion;
			fc.idx = (fc.idx + 1) % fc.candidates.length;
			const next = fc.candidates[fc.idx];
			/* v8 ignore next -- idx 取模后必在界内；守卫仅为 noUncheckedIndexedAccess 逃生 */
			if (next === void 0) return null;
			return applyCompletion(fc.baseText, fc.baseCursor, next);
		}
		const resolved = resolveFileCompletion(value, cursor, cwd, limit, timeoutMs);
		if (resolved === null) return null;
		this.fileCompletion = {
			baseText: value,
			baseCursor: cursor,
			candidates: resolved.candidates,
			idx: 0
		};
		const first = resolved.candidates[0];
		/* v8 ignore next -- resolveFileCompletion 保证 candidates 非空；守卫仅为 noUncheckedIndexedAccess 逃生 */
		if (first === void 0) return null;
		const applied = applyCompletion(value, cursor, first);
		if (resolved.candidates.length === 1) this.fileCompletion = null;
		return applied;
	}
	/** 输入历史（最新在前，submit 时更新 + 持久化） */
	inputHistory = [];
	/** 空闲时空输入 Ctrl+C 连按退出的时间窗（ms）。 */
	static EXIT_WINDOW_MS = 2e3;
	/** Ctrl+C double-press window start timestamp (ms), 0 = inactive */
	ctrlCPendingSince = 0;
	/** ESC double-press: last ESC timestamp (ms), 0 = inactive */
	lastEscAt = 0;
};
//#endregion
//#region lib/types/engine/resize-handler.js
/**
* T9 ResizeHandler — 终端 resize 事件的防抖处理。
*
* trailing-edge debounce（默认 150ms）合并连发的 resize 事件，settle 后回调一次。
*
* **scrollback 不受影响的前提**：resize 时只重绘 live region；但终端会把已绘的
* live 内容按新宽度 reflow，其占用行数随之变化。LiveEngine.render()/clear() 内的
* reconcileWidth() 检测到宽度变化时按新宽从 lineCache 重算行数再相对回顶，
* 否则旧帧顶部会残留进 scrollback（多份不同宽度的 chrome/面板叠屏）。
* 这条 reflow 协调是 resize 正确性的关键 —— 改 LiveEngine 回顶逻辑时务必保留。
*
* **事件来源**：Node tty WriteStream 自身监听 SIGWINCH 并转成 'resize' 事件，
* 但在部分多路复用器（tmux/screen 某些配置）、CI/pty 等环境下该转发不生效，
* 收不到任何 resize 通知。故叠加一个低频轮询兜底（pollMs，默认 300ms），
* 比对 columns/rows 缓存值，变化即触发防抖回调。事件 + 轮询双保险，谁先到都行。
*/
/**
* 终端 resize 防抖处理器：'resize' 事件 + 低频轮询双来源，合并进同一条
* trailing-edge debounce 通道，settle 后尺寸确有变化才回调。用完调用 dispose()。
*/
var ResizeHandler = class {
	stdout;
	debounceMs;
	timer = null;
	callback = null;
	currentCols;
	currentRows;
	/** 轮询兜底定时器。 */
	pollTimer = null;
	constructor(options) {
		this.stdout = options.stdout;
		this.debounceMs = options.debounceMs ?? 150;
		this.currentCols = this.stdout.columns;
		this.currentRows = this.stdout.rows;
		const pollMs = options.pollMs ?? 300;
		if (pollMs > 0) {
			this.pollTimer = setInterval(() => {
				this.poll();
			}, pollMs);
			this.pollTimer.unref();
		}
	}
	/**
	* 注册 resize 回调。每个 ResizeHandler 只有一个回调。
	* 多次调用会替换之前的回调。
	* @param callback - 尺寸变化时调用的回调
	*/
	onResize(callback) {
		this.callback = callback;
		this.stdout.on("resize", this.handleResize);
	}
	/**
	* 获取当前终端尺寸（直读 stdout，不经防抖缓存）。
	* @returns 当前列数与行数
	*/
	getSize() {
		return {
			cols: this.stdout.columns,
			rows: this.stdout.rows
		};
	}
	/** 移除 resize 监听 */
	dispose() {
		this.stdout.removeListener("resize", this.handleResize);
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.callback = null;
	}
	handleResize = () => {
		this.scheduleCallback();
	};
	/** 轮询兜底：尺寸变化时触发防抖（与事件来源共用同一条 debounce 通道）。 */
	poll() {
		const cols = this.stdout.columns;
		const rows = this.stdout.rows;
		if (cols !== this.currentCols || rows !== this.currentRows) this.scheduleCallback();
	}
	/** 防抖回调：settle 后比对尺寸，变化才通知 callback。 */
	scheduleCallback() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			const cols = this.stdout.columns;
			const rows = this.stdout.rows;
			if (cols !== this.currentCols || rows !== this.currentRows) {
				this.currentCols = cols;
				this.currentRows = rows;
				this.callback?.(cols, rows);
			}
		}, this.debounceMs);
	}
};
//#endregion
//#region lib/types/block-stream-writer.js
const DEFAULT_CONFIG = {
	minChars: 100,
	maxChars: 200,
	idleMs: 180,
	maxBufferSize: 65536
};
/** 句末标点（中英文）。拆成数组用 lastIndexOf 逐个定位，避免逐字符 includes 的 O(n²)。 */
const SENTENCE_ENDS = [
	"。",
	"！",
	"？",
	".",
	"!",
	"?",
	"；",
	";"
];
/**
* 把流式文本按语义边界（段落 > 句末 > 空白）聚合成块再回调 onBlock：
* 达到 maxChars 强制切分，静默 idleMs 后冲刷剩余。缓冲受
* maxBufferSize 硬上限约束，peek() 可读未发出的活尾。
*/
var BlockStreamWriter = class {
	buffer = "";
	idleTimer = null;
	sending = Promise.resolve();
	config;
	onBlock;
	hasEmitted = false;
	constructor(config, onBlock) {
		this.config = {
			...DEFAULT_CONFIG,
			...config
		};
		this.onBlock = onBlock;
	}
	/**
	* 追加一段流式文本；达到切分条件时同步发出块。空串为 no-op。
	* @param chunk - 新到的文本片段。
	*/
	push(chunk) {
		if (!chunk) return;
		this.buffer += chunk;
		this.enforceBufferLimit();
		this.resetIdleTimer();
		this.checkEmit();
	}
	/** 立即把缓冲余量作为最后一块发出并等待发送完成；空缓冲为 no-op。 */
	async flush() {
		this.clearIdleTimer();
		if (!this.buffer) return;
		const text = this.buffer;
		this.buffer = "";
		this.enqueue(text);
		await this.sending;
	}
	/** Drop buffered text WITHOUT emitting. Used when a stale run never
	*  finalized (e.g. abort, maxTurns exhaustion) and a new run is starting —
	*  flushing here would paint the previous run's leftover text into the
	*  new run's output. */
	discard() {
		this.clearIdleTimer();
		this.buffer = "";
	}
	/**
	* The text received but not yet emitted as a block — i.e. the live tail.
	* Structurally bounded by maxChars/maxBufferSize, so it stays small enough
	* to render in the live region without exceeding the viewport (真凶②).
	* @returns 已接收但尚未成块发出的缓冲文本。
	*/
	peek() {
		return this.buffer;
	}
	resetIdleTimer() {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.flush().catch((error) => {
				console.error("BlockStreamWriter idle flush failed:", error);
			});
		}, this.config.idleMs);
	}
	clearIdleTimer() {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
	checkEmit() {
		const minChars = this.hasEmitted ? this.config.minChars : 15;
		if (this.buffer.length < minChars) return;
		this.hasEmitted = true;
		if (this.buffer.length >= this.config.maxChars) {
			const pos = this.findBreakPoint(this.buffer, this.config.maxChars);
			const block = this.buffer.slice(0, pos);
			this.buffer = this.buffer.slice(pos);
			this.enqueue(block);
			if (this.buffer.length >= this.config.maxChars) this.checkEmit();
			return;
		}
		const paraIdx = this.buffer.lastIndexOf("\n\n");
		if (paraIdx !== -1 && paraIdx >= Math.floor(this.config.minChars * .5)) {
			const block = this.buffer.slice(0, paraIdx + 2);
			this.buffer = this.buffer.slice(paraIdx + 2);
			this.enqueue(block);
			return;
		}
		const sentIdx = this.findSentenceEnd(this.buffer);
		if (sentIdx !== -1) {
			const block = this.buffer.slice(0, sentIdx + 1);
			this.buffer = this.buffer.slice(sentIdx + 1);
			this.enqueue(block);
		}
	}
	enforceBufferLimit() {
		if (this.buffer.length <= this.config.maxBufferSize) return;
		while (this.buffer.length > this.config.maxBufferSize) {
			const pos = this.findBreakPoint(this.buffer, Math.min(this.config.maxChars, this.buffer.length));
			/* v8 ignore next 1 -- maxChars>0 时 findBreakPoint 恒返回 >0，Math.min 的 maxChars 分支结构性不可达 */
			const cut = pos > 0 ? pos : Math.min(this.config.maxChars > 0 ? this.config.maxChars : 1, this.buffer.length);
			const block = this.buffer.slice(0, cut);
			this.buffer = this.buffer.slice(cut);
			this.enqueue(block);
		}
	}
	findBreakPoint(text, maxPos) {
		const para = text.lastIndexOf("\n\n", maxPos);
		if (para !== -1 && para > Math.floor(maxPos * .3)) return para + 2;
		const nl = text.lastIndexOf("\n", maxPos);
		if (nl !== -1 && nl > Math.floor(maxPos * .3)) return nl + 1;
		const sp = text.lastIndexOf(" ", maxPos);
		if (sp !== -1 && sp > Math.floor(maxPos * .3)) return sp + 1;
		return maxPos;
	}
	findSentenceEnd(text) {
		let last = -1;
		for (const end of SENTENCE_ENDS) {
			const idx = text.lastIndexOf(end);
			if (idx > last) last = idx;
		}
		return last;
	}
	enqueue(text) {
		this.onBlock(text);
	}
};
//#endregion
//#region lib/types/format/hidden-lines.js
/**
* 长输出塌缩标记 —— 对标 Claude Code 的 `─── ✂ N lines hidden ───`。
*
* 此前各处自行拼字符串，同一语义出现过四种写法（`… +N more lines`、
* `… +N earlier lines`、`… +N 行`、`... N lines hidden ...`），用户在同一屏里
* 会看到不同形态的「还有内容没显示」。统一到一个可辨识的水平标记：它跨越整行、
* 带剪刀符，一眼能与正文区分开。
*/
/** 标记两侧的规则线长度（显示列）。 */
const RULE = 3;
/**
* 生成塌缩标记文本（不含颜色）。
*
* @param count 被隐藏的行数
* @param variant `hidden` 为中部省略，`earlier` 为上文省略（错误输出保留尾部时用）
* @returns 形如 `─── ✂ 已隐藏 N 行 ───` 的标记文本（ascii 轨用 `-`/`--`）。
*/
function hiddenLinesMarker(count, variant = "hidden") {
	const ascii = useAsciiGlyphs();
	const scissors = ascii ? "--" : "✂";
	const rule = (ascii ? "-" : "─").repeat(RULE);
	return `${rule} ${scissors} ${variant === "earlier" ? `已隐藏上文 ${count} 行` : `已隐藏 ${count} 行`} ${rule}`;
}
//#endregion
//#region lib/types/format/diff.js
/**
* 格式化函数 — diff 输出（基础版，直移 .rivet/tui-source/tui/format/diff.ts）。
*
* 源出 .rivet/tui-source/tui/format/diff.ts（Apache-2.0 来源，见
* LICENSE/NOTICE/SOURCE-MAP.md）。本文件与源保持一致（本地依赖
* hidden-lines.ts 已存在），未做裁剪。
*/
const DEFAULT_MAX_LINES$1 = 50;
/**
* 从 diff 文本提取统计：添加行数、删除行数、hunk 数。
* @param content - unified diff 文本（+++/--- 文件头不计入增删）。
* @returns adds/dels/hunks 计数。
*/
function computeDiffStats(content) {
	const lines = content.split("\n");
	let adds = 0;
	let dels = 0;
	let hunks = 0;
	for (const line of lines) {
		if (line.startsWith("@@")) {
			hunks++;
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			adds++;
			continue;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			dels++;
			continue;
		}
	}
	return {
		adds,
		dels,
		hunks
	};
}
/**
* 启发式检测文本是否为 unified diff 内容。
* 前 20 行内计 diff 信号（diff --git / 文件头 / hunk 头）；有 hunk 头且
* 存在 +/- 行即判真，否则要求信号 ≥ 2。
* @param text - 待检测文本。
* @returns 判定为 diff 内容时 true。
*/
function isDiffContent(text) {
	let diffSignals = 0;
	let hasHunk = false;
	const lines = text.split("\n");
	for (const line of lines.slice(0, 20)) {
		if (!line) continue;
		if (/^diff --git/.test(line)) {
			diffSignals += 2;
			continue;
		}
		if (/^(---|\+\+\+)\s/.test(line)) {
			diffSignals++;
			continue;
		}
		if (/^@@[^@]+@@/.test(line)) {
			hasHunk = true;
			diffSignals++;
			continue;
		}
	}
	if (hasHunk && /^[-+]/m.test(text)) return true;
	return diffSignals >= 2;
}
/** 从 hunk 头解析起始行号。`@@ -a,b +c,d @@` → { old: a, new: c }。 */
function parseHunkStart(line) {
	const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!m) return null;
	return {
		old: Number(m[1]),
		new: Number(m[2])
	};
}
/**
* 为每一行计算行号 gutter 标签（不含着色）。
* 有 hunk 头才有行号语义：add/context 显示新文件行号，del 显示旧文件行号。
* 无 hunk 的裸 +/- 片段返回 null（不加 gutter）。
*/
function computeLineNumbers(allLines) {
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	let sawHunk = false;
	const labels = [];
	for (const line of allLines) {
		const type = classifyLine(line);
		if (type === "hunk") {
			const start = parseHunkStart(line);
			if (start) {
				oldNo = start.old;
				newNo = start.new;
				inHunk = true;
				sawHunk = true;
			}
			labels.push(null);
			continue;
		}
		if (!inHunk || type === "meta" || type === "header") {
			labels.push(null);
			continue;
		}
		if (type === "add") {
			labels.push(String(newNo));
			newNo++;
			continue;
		}
		if (type === "del") {
			labels.push(String(oldNo));
			oldNo++;
			continue;
		}
		labels.push(String(newNo));
		oldNo++;
		newNo++;
	}
	return sawHunk ? labels : null;
}
/**
* 格式化 diff 为 ANSI 行数组。
*
* 颜色映射：
* - 添加行 (+): theme.success (绿)
* - 删除行 (-): theme.error (红)
* - hunk header (@@): theme.secondary
* - 文件头 (---/+++): theme.warning
* - 上下文行: theme.muted
* - meta (diff --git 等): theme.dim
* @param input - diff 文本与可选行数上限（超限时头尾各留一半 + 隐藏标记）。
* @param theme - 当前主题。
* @returns ANSI 行数组：`diff: +N −M` 摘要头 + 染色内容行（有 hunk 时附行号 gutter）。
*/
function formatDiff(input, theme) {
	const maxLines = input.maxLines ?? DEFAULT_MAX_LINES$1;
	const allLines = input.content.split("\n");
	const stats = computeDiffStats(input.content);
	const lineNumbers = computeLineNumbers(allLines);
	const gutterWidth = lineNumbers ? Math.max(3, ...lineNumbers.filter((l) => l !== null).map((l) => l.length)) : 0;
	const truncated = allLines.length > maxLines;
	const headCount = Math.floor(maxLines / 2);
	const rows = allLines.map((line, i) => ({
		line,
		label: lineNumbers?.[i] ?? null
	}));
	const displayRows = truncated ? [
		...rows.slice(0, headCount),
		{
			line: hiddenLinesMarker(allLines.length - maxLines),
			label: null
		},
		...rows.slice(-headCount)
	] : rows;
	const lines = [];
	lines.push(color(`diff: +${stats.adds} −${stats.dels}${truncated ? ` (${allLines.length} total, showing ${maxLines})` : ""}`, theme.secondary));
	for (const row of displayRows) {
		const type = classifyLine(row.line);
		const lineColor = getDiffColor(type, theme);
		let rendered = color(row.line, lineColor);
		if (type === "header") {
			const filePath = extractHeaderPath(row.line);
			if (filePath) rendered = fileLink(rendered, filePath);
		}
		if (lineNumbers) {
			const gutter = color(`${(row.label ?? "").padStart(gutterWidth)}│`, theme.dim);
			lines.push(`${gutter}${rendered}`);
		} else lines.push(rendered);
	}
	return lines;
}
/** 从 ---/+++ 文件头提取路径（剥 a// b/ 前缀；/dev/null 与时间戳后缀跳过）。 */
function extractHeaderPath(line) {
	const m = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
	if (!m) return null;
	const group = m[1];
	/* v8 ignore next -- 正则 ^.+$ 匹配成功时捕获组必存在；noUncheckedIndexedAccess 收窄防御 */
	if (group === void 0) return null;
	/* v8 ignore next -- split('\t') 恒返回非空数组，?? 右侧不可达；noUncheckedIndexedAccess 收窄防御 */
	let p = group.split("	")[0] ?? "";
	p = p.trim();
	if (p === "/dev/null") return null;
	if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
	return p || null;
}
function classifyLine(line) {
	if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("old ") || line.startsWith("rename ") || line.startsWith("similarity ")) return "meta";
	if (line.startsWith("---") || line.startsWith("+++")) return "header";
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	return "context";
}
function getDiffColor(type, theme) {
	switch (type) {
		case "add": return theme.success;
		case "del": return theme.error;
		case "hunk": return theme.secondary;
		case "header": return theme.warning;
		case "meta": return theme.dim;
		case "context": return theme.muted;
	}
}
/**
* 单行 diff 分类 → 主题色。供 formatCodeBlock 渲染内嵌 diff 段复用，
* 与 formatDiff 的行分类着色保持一致（+ 绿 − 红 @@ 次色 头 warning）。
* @param line - 单行 diff 文本。
* @param theme - 当前主题。
* @returns 该行对应主题色。
*/
function diffLineColor(line, theme) {
	return getDiffColor(classifyLine(line), theme);
}
//#endregion
//#region lib/types/pi/latex-to-unicode.js
var _a;
function parseCssColorToRgb(spec) {
	const s = spec.trim();
	const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.exec(s);
	if (hexMatch) {
		const h = hexMatch[1] ?? "";
		if (h.length === 3) {
			const r = h[0] ?? "", g = h[1] ?? "", b = h[2] ?? "";
			return {
				r: parseInt(r + r, 16),
				g: parseInt(g + g, 16),
				b: parseInt(b + b, 16)
			};
		}
		return {
			r: parseInt(h.slice(0, 2), 16),
			g: parseInt(h.slice(2, 4), 16),
			b: parseInt(h.slice(4, 6), 16)
		};
	}
	const fnMatch = /^rgba?\(\s*([^)]+)\)$/i.exec(s);
	if (fnMatch) {
		const parts = (fnMatch[1] ?? "").split(/[,\s]+/).filter((p) => p.length > 0);
		if (parts.length >= 3) {
			const r = parseFloat(parts[0] ?? "");
			const g = parseFloat(parts[1] ?? "");
			const b = parseFloat(parts[2] ?? "");
			if ([
				r,
				g,
				b
			].every((v) => Number.isFinite(v))) return {
				r: clampByte(r),
				g: clampByte(g),
				b: clampByte(b)
			};
		}
	}
	return null;
}
function rgbToAnsi256({ r, g, b }) {
	if (r === g && g === b) {
		if (r < 8) return "\x1B[38;5;0m";
		if (r > 248) return "\x1B[38;5;15m";
		return `\x1b[38;5;${Math.round((r - 8) / 247 * 24) + 232}m`;
	}
	return `\x1b[38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}m`;
}
function rgbToAnsi16m({ r, g, b }) {
	return `\x1b[38;2;${r};${g};${b}m`;
}
function bunColorShim(spec, format) {
	const rgb = parseCssColorToRgb(spec);
	if (rgb === null) return null;
	if (format === "css") return spec;
	if (format === "{rgb}") return rgb;
	if (format === "ansi-256") return rgbToAnsi256(rgb);
	return rgbToAnsi16m(rgb);
}
const SUPERSCRIPT = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	".": "·",
	" ": " ",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	ε: "ᵋ",
	θ: "ᶿ",
	ι: "ᶥ",
	φ: "ᵠ",
	χ: "ᵡ"
};
const SUBSCRIPT = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	" ": " ",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ"
};
const PRIMES = [
	"",
	"′",
	"″",
	"‴",
	"⁗"
];
const VULGAR = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/7": "⅐",
	"1/8": "⅛",
	"3/8": "⅜",
	"5/8": "⅝",
	"7/8": "⅞",
	"1/9": "⅑",
	"1/10": "⅒",
	"0/3": "↉"
};
const NOT_MAP = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≡": "≢",
	"∃": "∄",
	"≤": "≰",
	"≥": "≱",
	"≈": "≉",
	"≅": "≇",
	"∼": "≁",
	"≃": "≄",
	"∣": "∤",
	"∥": "∦",
	"≺": "⊀",
	"≻": "⊁",
	"⊑": "⋢",
	"⊒": "⋣"
};
const ACCENTS = {
	hat: "̂",
	widehat: "̂",
	check: "̌",
	widecheck: "̌",
	tilde: "̃",
	widetilde: "̃",
	acute: "́",
	grave: "̀",
	dot: "̇",
	ddot: "̈",
	dddot: "⃛",
	ddddot: "⃜",
	breve: "̆",
	bar: "̄",
	vec: "⃗",
	overrightarrow: "⃗",
	overleftarrow: "⃖",
	mathring: "̊",
	overline: "̅",
	underline: "̲",
	underbar: "̲"
};
const FUNCTIONS = {
	sin: true,
	cos: true,
	tan: true,
	cot: true,
	sec: true,
	csc: true,
	sinh: true,
	cosh: true,
	tanh: true,
	coth: true,
	arcsin: true,
	arccos: true,
	arctan: true,
	arccot: true,
	arcsec: true,
	arccsc: true,
	sech: true,
	csch: true,
	ln: true,
	log: true,
	lg: true,
	exp: true,
	lim: true,
	limsup: true,
	liminf: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	dim: true,
	ker: true,
	hom: true,
	arg: true,
	deg: true,
	gcd: true,
	lcm: true,
	Pr: true,
	argmax: true,
	argmin: true,
	sgn: true,
	tr: true,
	rank: true,
	diag: true,
	var: true,
	cov: true,
	median: true,
	mod: true
};
const FONTS = {
	mathbf: "bold",
	boldsymbol: "bolditalic",
	bm: "bolditalic",
	pmb: "bold",
	mathbb: "doublestruck",
	Bbb: "doublestruck",
	mathds: "doublestruck",
	mathbbm: "doublestruck",
	mathcal: "script",
	mathscr: "boldscript",
	mathfrak: "fraktur",
	mathbfscr: "boldscript",
	mathbfcal: "boldscript",
	mathbffrak: "boldfraktur",
	mathfrakbold: "boldfraktur",
	mathsf: "sans",
	mathsfit: "sansitalic",
	mathsfbf: "sansbold",
	mathbfsf: "sansbold",
	mathsfbfit: "sansbolditalic",
	mathbfsfit: "sansbolditalic",
	mathtt: "mono",
	mathit: "italic",
	mathbfit: "bolditalic",
	textbf: "bold",
	textit: "italic",
	texttt: "mono",
	textsf: "sans"
};
const TEXT_COMMANDS = {
	text: true,
	textrm: true,
	textnormal: true,
	textup: true,
	textmd: true,
	textsc: true,
	textsl: true,
	emph: true,
	mathrm: true,
	mathnormal: true,
	mbox: true,
	hbox: true
};
const PLANES = {
	bold: {
		upper: 119808,
		lower: 119834,
		digit: 120782
	},
	italic: {
		upper: 119860,
		lower: 119886
	},
	bolditalic: {
		upper: 119912,
		lower: 119938
	},
	script: {
		upper: 119964,
		lower: 119990
	},
	boldscript: {
		upper: 120016,
		lower: 120042
	},
	fraktur: {
		upper: 120068,
		lower: 120094
	},
	doublestruck: {
		upper: 120120,
		lower: 120146,
		digit: 120792
	},
	boldfraktur: {
		upper: 120172,
		lower: 120198
	},
	sans: {
		upper: 120224,
		lower: 120250,
		digit: 120802
	},
	sansbold: {
		upper: 120276,
		lower: 120302,
		digit: 120812
	},
	sansitalic: {
		upper: 120328,
		lower: 120354
	},
	sansbolditalic: {
		upper: 120380,
		lower: 120406
	},
	mono: {
		upper: 120432,
		lower: 120458,
		digit: 120822
	}
};
const ALPHA_HOLES = {
	"italic:h": "ℎ",
	"script:B": "ℬ",
	"script:E": "ℰ",
	"script:F": "ℱ",
	"script:H": "ℋ",
	"script:I": "ℐ",
	"script:L": "ℒ",
	"script:M": "ℳ",
	"script:R": "ℛ",
	"script:e": "ℯ",
	"script:g": "ℊ",
	"script:o": "ℴ",
	"fraktur:C": "ℭ",
	"fraktur:H": "ℌ",
	"fraktur:I": "ℑ",
	"fraktur:R": "ℜ",
	"fraktur:Z": "ℨ",
	"doublestruck:C": "ℂ",
	"doublestruck:H": "ℍ",
	"doublestruck:N": "ℕ",
	"doublestruck:P": "ℙ",
	"doublestruck:Q": "ℚ",
	"doublestruck:R": "ℝ",
	"doublestruck:Z": "ℤ"
};
const ENV_DELIMS = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	tabular: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	"cases*": ["{", ""],
	dcases: ["{", ""],
	"dcases*": ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
	aligned: ["", ""],
	"aligned*": ["", ""],
	alignedat: ["", ""],
	"alignedat*": ["", ""],
	align: ["", ""],
	"align*": ["", ""],
	alignat: ["", ""],
	"alignat*": ["", ""],
	split: ["", ""],
	gathered: ["", ""],
	equation: ["", ""],
	"equation*": ["", ""]
};
const SYMBOLS = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	digamma: "ϝ",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	iiiint: "⨌",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	bigcap: "⋂",
	bigcup: "⋃",
	bigsqcup: "⨆",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigodot: "⨀",
	bigoplus: "⨁",
	bigotimes: "⨂",
	biguplus: "⨄",
	Cap: "⋒",
	Cup: "⋓",
	bigstar: "★",
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "∙",
	cdot: "⋅",
	cdotp: "·",
	centerdot: "·",
	cap: "∩",
	cup: "∪",
	uplus: "⊎",
	sqcap: "⊓",
	sqcup: "⊔",
	vee: "∨",
	wedge: "∧",
	land: "∧",
	lor: "∨",
	setminus: "∖",
	smallsetminus: "∖",
	wr: "≀",
	amalg: "⨿",
	diamond: "⋄",
	Diamond: "◇",
	bigtriangleup: "△",
	bigtriangledown: "▽",
	triangleleft: "◁",
	triangleright: "▷",
	lhd: "⊲",
	rhd: "⊳",
	unlhd: "⊴",
	unrhd: "⊵",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	dagger: "†",
	ddagger: "‡",
	boxplus: "⊞",
	boxtimes: "⊠",
	boxdot: "⊡",
	boxminus: "⊟",
	ltimes: "⋉",
	rtimes: "⋊",
	leftthreetimes: "⋋",
	rightthreetimes: "⋌",
	curlyvee: "⋎",
	curlywedge: "⋏",
	barwedge: "⊼",
	veebar: "⊻",
	doublebarwedge: "⩞",
	circledast: "⊛",
	circledcirc: "⊚",
	circleddash: "⊝",
	divideontimes: "⋇",
	dotplus: "∔",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	ll: "≪",
	gg: "≫",
	neq: "≠",
	ne: "≠",
	equiv: "≡",
	doteq: "≐",
	sim: "∼",
	simeq: "≃",
	approx: "≈",
	approxeq: "≊",
	cong: "≅",
	propto: "∝",
	asymp: "≍",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	subsetneq: "⊊",
	supsetneq: "⊋",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	in: "∈",
	ni: "∋",
	owns: "∋",
	notin: "∉",
	mid: "∣",
	nmid: "∤",
	parallel: "∥",
	nparallel: "∦",
	perp: "⊥",
	vdash: "⊢",
	dashv: "⊣",
	models: "⊨",
	vDash: "⊨",
	Vdash: "⊩",
	bowtie: "⋈",
	smile: "⌣",
	frown: "⌢",
	between: "≬",
	lessgtr: "≶",
	gtrless: "≷",
	leqslant: "⩽",
	geqslant: "⩾",
	lesssim: "≲",
	gtrsim: "≳",
	lessapprox: "⪅",
	gtrapprox: "⪆",
	leqq: "≦",
	geqq: "≧",
	lneq: "⪇",
	gneq: "⪈",
	lneqq: "≨",
	gneqq: "≩",
	nleq: "≰",
	ngeq: "≱",
	nless: "≮",
	ngtr: "≯",
	nsubseteq: "⊈",
	nsupseteq: "⊉",
	nsim: "≁",
	ncong: "≇",
	triangleq: "≜",
	coloneqq: "≔",
	eqqcolon: "≕",
	risingdotseq: "≓",
	fallingdotseq: "≒",
	circeq: "≗",
	eqcirc: "≖",
	precsim: "≾",
	succsim: "≿",
	precapprox: "⪷",
	succapprox: "⪸",
	curlyeqprec: "⋞",
	curlyeqsucc: "⋟",
	Subset: "⋐",
	Supset: "⋑",
	subseteqq: "⫅",
	supseteqq: "⫆",
	subsetneqq: "⫋",
	supsetneqq: "⫌",
	Vvdash: "⊪",
	shortmid: "∣",
	shortparallel: "∥",
	pitchfork: "⋔",
	leftarrow: "←",
	gets: "←",
	rightarrow: "→",
	to: "→",
	leftrightarrow: "↔",
	Leftarrow: "⇐",
	Rightarrow: "⇒",
	Leftrightarrow: "⇔",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	Updownarrow: "⇕",
	mapsto: "↦",
	longmapsto: "⟼",
	hookleftarrow: "↩",
	hookrightarrow: "↪",
	leftharpoonup: "↼",
	rightharpoonup: "⇀",
	leftharpoondown: "↽",
	rightharpoondown: "⇁",
	rightleftharpoons: "⇌",
	longleftarrow: "⟵",
	longrightarrow: "⟶",
	longleftrightarrow: "⟷",
	Longleftarrow: "⟸",
	Longrightarrow: "⟹",
	Longleftrightarrow: "⟺",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	nleftarrow: "↚",
	nrightarrow: "↛",
	leadsto: "⇝",
	rightsquigarrow: "⇝",
	leftrightsquigarrow: "↭",
	twoheadrightarrow: "↠",
	twoheadleftarrow: "↞",
	leftrightharpoons: "⇋",
	rightleftarrows: "⇄",
	leftrightarrows: "⇆",
	leftleftarrows: "⇇",
	rightrightarrows: "⇉",
	upuparrows: "⇈",
	downdownarrows: "⇊",
	circlearrowleft: "↺",
	circlearrowright: "↻",
	curvearrowleft: "↶",
	curvearrowright: "↷",
	dashleftarrow: "⇠",
	dashrightarrow: "⇢",
	Lleftarrow: "⇚",
	Rrightarrow: "⇛",
	leftarrowtail: "↢",
	rightarrowtail: "↣",
	looparrowleft: "↫",
	looparrowright: "↬",
	multimap: "⊸",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	emptyset: "∅",
	varnothing: "∅",
	neg: "¬",
	lnot: "¬",
	top: "⊤",
	bot: "⊥",
	angle: "∠",
	measuredangle: "∡",
	sphericalangle: "∢",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	hbar: "ℏ",
	hslash: "ℏ",
	ell: "ℓ",
	imath: "ı",
	jmath: "ȷ",
	wp: "℘",
	Re: "ℜ",
	Im: "ℑ",
	mho: "℧",
	complement: "∁",
	surd: "√",
	flat: "♭",
	natural: "♮",
	sharp: "♯",
	clubsuit: "♣",
	diamondsuit: "♦",
	heartsuit: "♥",
	spadesuit: "♠",
	clubs: "♣",
	diamonds: "♦",
	hearts: "♥",
	spades: "♠",
	therefore: "∴",
	because: "∵",
	checkmark: "✓",
	maltese: "✠",
	dag: "†",
	ddag: "‡",
	S: "§",
	P: "¶",
	copyright: "©",
	circledR: "®",
	pounds: "£",
	yen: "¥",
	euro: "€",
	degree: "°",
	prime: "′",
	backprime: "‵",
	colon: ":",
	semicolon: ";",
	neper: "₪",
	square: "□",
	Box: "□",
	blacksquare: "■",
	lozenge: "◊",
	blacklozenge: "⧫",
	triangle: "△",
	blacktriangle: "▴",
	blacktriangledown: "▾",
	blacktriangleleft: "◂",
	blacktriangleright: "▸",
	diagup: "╱",
	diagdown: "╲",
	backepsilon: "϶",
	Game: "⅁",
	eth: "ð",
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	hdots: "…",
	mathellipsis: "…",
	dotsc: "…",
	dotsb: "⋯",
	dotsm: "⋯",
	dotsi: "⋯",
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lbrace: "{",
	rbrace: "}",
	lbrack: "[",
	rbrack: "]",
	vert: "|",
	Vert: "‖",
	lvert: "|",
	rvert: "|",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	slash: "/",
	ulcorner: "⌜",
	urcorner: "⌝",
	llcorner: "⌞",
	lrcorner: "⌟",
	lmoustache: "⎰",
	rmoustache: "⎱",
	lgroup: "⟮",
	rgroup: "⟯",
	bracevert: "⎪",
	Reals: "ℝ",
	Complex: "ℂ",
	Natural: "ℕ",
	Integer: "ℤ",
	Rational: "ℚ"
};
/** Map every code point of `text` through `table`; null if any is unmappable. */
function mapAll(text, table) {
	let out = "";
	for (const ch of text) {
		const mapped = table[ch];
		if (mapped === void 0) return null;
		out += mapped;
	}
	return out;
}
/** Number of Unicode code points (not UTF-16 units) in `s`. */
function codePointLength(s) {
	let n = 0;
	for (const _ of s) n++;
	return n;
}
/** Style a single ASCII letter/digit via the math alphanumeric block. */
function styleAlnum(ch, style) {
	const hole = ALPHA_HOLES[`${style}:${ch}`];
	if (hole) return hole;
	const plane = PLANES[style];
	const code = ch.charCodeAt(0);
	if (code >= 65 && code <= 90) return String.fromCodePoint(plane.upper + (code - 65));
	if (code >= 97 && code <= 122) return String.fromCodePoint(plane.lower + (code - 97));
	if (code >= 48 && code <= 57 && plane.digit !== void 0) return String.fromCodePoint(plane.digit + (code - 48));
	return ch;
}
/** Identity, or math-alphanumeric styling when a font style is active. */
function styleChar(ch, style) {
	if (style === null) return ch;
	const code = ch.charCodeAt(0);
	return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 ? styleAlnum(ch, style) : ch;
}
/** Append a combining mark after each non-space base glyph (accents/radicals). */
function applyCombining(text, mark) {
	let out = "";
	for (const ch of text) out += ch === " " ? ch : ch + mark;
	return out;
}
/** Light unescape for text-mode content (`\&` → `&`, `~` → space). */
function unescapeText(s) {
	return s.replace(/\\([&%$#_{}\s])/g, "$1").replace(/~/g, " ");
}
const ANSI_FG_RESET = "\x1B[39m";
const ANSI_BG_RESET = "\x1B[49m";
const LATEX_NAMED_COLORS = {
	black: "#000000",
	blue: "#0000ff",
	brown: "#a52a2a",
	cyan: "#00ffff",
	darkgray: "#404040",
	darkgrey: "#404040",
	gray: "#808080",
	green: "#00ff00",
	grey: "#808080",
	lightgray: "#c0c0c0",
	lightgrey: "#c0c0c0",
	lime: "#00ff00",
	magenta: "#ff00ff",
	olive: "#808000",
	orange: "#ffa500",
	pink: "#ffc0cb",
	purple: "#800080",
	red: "#ff0000",
	teal: "#008080",
	violet: "#ee82ee",
	white: "#ffffff",
	yellow: "#ffff00"
};
function colorFormat() {
	return "ansi-256";
}
function clamp01(n) {
	if (n <= 0) return 0;
	if (n >= 1) return 1;
	return n;
}
function clampByte(n) {
	if (n <= 0) return 0;
	if (n >= 255) return 255;
	return Math.round(n);
}
function cssRgb(rgb) {
	return `rgb(${clampByte(rgb.r)}, ${clampByte(rgb.g)}, ${clampByte(rgb.b)})`;
}
function parseNumber(raw) {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed.endsWith("%") ? Number(trimmed.slice(0, -1)) / 100 : trimmed);
	return Number.isFinite(value) ? value : null;
}
function parseColorComponents(spec, expected) {
	const parts = spec.split(/[,\s]+/u).map((part) => part.trim()).filter(Boolean);
	if (parts.length !== expected) return null;
	const values = [];
	for (const part of parts) {
		const value = parseNumber(part);
		if (value === null) return null;
		values.push(value);
	}
	return values;
}
function rgbFromUnit(values) {
	if (values.length !== 3) return null;
	return cssRgb({
		r: clamp01(values[0] ?? 0) * 255,
		g: clamp01(values[1] ?? 0) * 255,
		b: clamp01(values[2] ?? 0) * 255
	});
}
function rgbFromByte(values) {
	if (values.length !== 3) return null;
	return cssRgb({
		r: values[0] ?? 0,
		g: values[1] ?? 0,
		b: values[2] ?? 0
	});
}
function rgbFromCmyk(values) {
	if (values.length !== 4) return null;
	const c = clamp01(values[0] ?? 0);
	const m = clamp01(values[1] ?? 0);
	const y = clamp01(values[2] ?? 0);
	const k = clamp01(values[3] ?? 0);
	return cssRgb({
		r: 255 * (1 - c) * (1 - k),
		g: 255 * (1 - m) * (1 - k),
		b: 255 * (1 - y) * (1 - k)
	});
}
function rgbFromHsv(values, hueScale) {
	if (values.length !== 3) return null;
	const h = (values[0] ?? 0) * hueScale % 360 / 60;
	const s = clamp01(values[1] ?? 0);
	const v = clamp01(values[2] ?? 0);
	const c = v * s;
	const x = c * (1 - Math.abs(h % 2 - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 1) {
		r = c;
		g = x;
	} else if (h < 2) {
		r = x;
		g = c;
	} else if (h < 3) {
		g = c;
		b = x;
	} else if (h < 4) {
		g = x;
		b = c;
	} else if (h < 5) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	return cssRgb({
		r: (r + m) * 255,
		g: (g + m) * 255,
		b: (b + m) * 255
	});
}
function rgbFromWave(spec) {
	const wavelength = parseNumber(spec);
	if (wavelength === null || wavelength < 380 || wavelength > 780) return null;
	let r = 0;
	let g = 0;
	let b = 0;
	if (wavelength < 440) {
		r = -(wavelength - 440) / 60;
		b = 1;
	} else if (wavelength < 490) {
		g = (wavelength - 440) / 50;
		b = 1;
	} else if (wavelength < 510) {
		g = 1;
		b = -(wavelength - 510) / 20;
	} else if (wavelength < 580) {
		r = (wavelength - 510) / 70;
		g = 1;
	} else if (wavelength < 645) {
		r = 1;
		g = -(wavelength - 645) / 65;
	} else r = 1;
	const factor = wavelength < 420 ? .3 + .7 * (wavelength - 380) / 40 : wavelength > 700 ? .3 + .7 * (780 - wavelength) / 80 : 1;
	return cssRgb({
		r: r * factor * 255,
		g: g * factor * 255,
		b: b * factor * 255
	});
}
function normalizeCssColor(spec, allowMix) {
	const trimmed = spec.trim();
	if (trimmed === "") return null;
	if (allowMix && trimmed.includes("!")) {
		const mixed = resolveMixedColor(trimmed);
		if (mixed !== null) return mixed;
	}
	const named = LATEX_NAMED_COLORS[trimmed] ?? LATEX_NAMED_COLORS[trimmed.toLowerCase()];
	if (named !== void 0) return named;
	if (bunColorShim(trimmed, "css") !== null) return trimmed;
	const lower = trimmed.toLowerCase();
	return lower !== trimmed && bunColorShim(lower, "css") !== null ? lower : null;
}
function resolveModeledColor(model, spec) {
	const trimmedModel = model.trim();
	if (trimmedModel === "" || trimmedModel === "named") return normalizeCssColor(spec, true);
	if (trimmedModel === "HTML" || trimmedModel === "Html" || trimmedModel === "html") {
		const hex = spec.trim().replace(/^#/u, "");
		return /^[0-9A-Fa-f]{3,8}$/u.test(hex) ? `#${hex}` : null;
	}
	if (trimmedModel === "wave") return rgbFromWave(spec);
	const lower = trimmedModel.toLowerCase();
	if (trimmedModel === "RGB") return rgbFromByte(parseColorComponents(spec, 3) ?? []);
	if (lower === "rgb") return rgbFromUnit(parseColorComponents(spec, 3) ?? []);
	if (lower === "cmyk") return rgbFromCmyk(parseColorComponents(spec, 4) ?? []);
	if (lower === "gray" || lower === "grey") {
		const value = parseColorComponents(spec, 1)?.[0];
		if (value === void 0) return null;
		const byte = clamp01(trimmedModel === "Gray" || trimmedModel === "Grey" ? value / 15 : value) * 255;
		return cssRgb({
			r: byte,
			g: byte,
			b: byte
		});
	}
	if (lower === "hsb" || lower === "hsv") {
		const values = parseColorComponents(spec, 3);
		if (values === null) return null;
		return rgbFromHsv(values, trimmedModel === "Hsb" || trimmedModel === "HSV" ? 1 : 360);
	}
	return normalizeCssColor(spec, true);
}
function resolveLatexColor(model, spec) {
	const unescaped = unescapeText(spec).trim();
	if (unescaped === "") return null;
	return model === null ? normalizeCssColor(unescaped, true) : resolveModeledColor(model, unescaped);
}
function resolveMixedColor(spec) {
	const parts = spec.split("!");
	if (parts.length < 2) return null;
	const first = normalizeCssColor(parts[0] ?? "", false);
	if (first === null) return null;
	let current = bunColorShim(first, "{rgb}");
	if (current === null) return null;
	for (let i = 1; i < parts.length; i += 2) {
		const percent = parseNumber(parts[i] ?? "");
		if (percent === null) return null;
		const nextColor = normalizeCssColor(parts[i + 1] ?? "white", false);
		if (nextColor === null) return null;
		const next = bunColorShim(nextColor, "{rgb}");
		if (next === null) return null;
		const t = clamp01(percent / 100);
		current = {
			r: current.r * t + next.r * (1 - t),
			g: current.g * t + next.g * (1 - t),
			b: current.b * t + next.b * (1 - t)
		};
	}
	return cssRgb(current);
}
function ansiColor(model, spec) {
	const css = resolveLatexColor(model, spec);
	if (css === null) return null;
	const foreground = bunColorShim(css, colorFormat());
	if (foreground === null || !foreground.startsWith("\x1B[38;")) return null;
	return {
		foreground,
		background: foreground.replace("\x1B[38;", "\x1B[48;")
	};
}
function restoreAnsi(text, fromForeground, toForeground, fromBackground, toBackground) {
	if (fromForeground !== toForeground && fromForeground !== null) text += toForeground ?? ANSI_FG_RESET;
	if (fromBackground !== toBackground && fromBackground !== null) text += toBackground ?? ANSI_BG_RESET;
	return text;
}
function toSuperscript(text, group) {
	if (text === "") return "";
	const mapped = mapAll(text, SUPERSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `^(${text})` : `^${text}`;
}
function toSubscript(text, group) {
	if (text === "") return "";
	const mapped = mapAll(text, SUBSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `_(${text})` : `_${text}`;
}
const BIG_DELIM = /^(?:[bB]igg?|[bB]igg?[lrm])$/;
const EXTENSIBLE_ARROWS = {
	xleftarrow: "←",
	xrightarrow: "→",
	xleftrightarrow: "↔",
	xLeftarrow: "⇐",
	xRightarrow: "⇒",
	xLeftrightarrow: "⇔",
	xhookleftarrow: "↩",
	xhookrightarrow: "↪",
	xtwoheadleftarrow: "↞",
	xtwoheadrightarrow: "↠",
	xmapsto: "↦",
	xrightharpoonup: "⇀",
	xrightharpoondown: "⇁",
	xleftharpoonup: "↼",
	xleftharpoondown: "↽",
	xrightleftharpoons: "⇌",
	xleftrightharpoons: "⇋"
};
var LatexParser = class {
	#s;
	#i = 0;
	#foreground = null;
	#background = null;
	constructor(src) {
		this.#s = src;
	}
	render() {
		return restoreAnsi(this.parse(null, false), this.#foreground, null, this.#background, null);
	}
	/** Parse a run until end-of-input, or until `}` when `stopAtBrace`. */
	parse(style, stopAtBrace) {
		let out = "";
		while (this.#i < this.#s.length) {
			if (this.#s[this.#i] === "}") {
				if (stopAtBrace) break;
				this.#i++;
				continue;
			}
			out += this.#node(style);
		}
		return out;
	}
	#node(style) {
		const c = this.#s[this.#i];
		if (c === void 0) return "";
		switch (c) {
			case "\\": return this.#command(style);
			case "{": return this.#group(style);
			case "^":
				this.#i++;
				return this.#script(style, true);
			case "_":
				this.#i++;
				return this.#script(style, false);
			case "$":
				this.#i++;
				return "";
			case "~":
				this.#i++;
				return " ";
			case "&":
				this.#i++;
				return "  ";
			case "'": {
				let k = 0;
				while (this.#s[this.#i] === "'") {
					k++;
					this.#i++;
				}
				return k <= 4 ? PRIMES[k] ?? "" : PRIMES[1].repeat(k);
			}
			case "%": {
				const nl = this.#s.indexOf("\n", this.#i);
				this.#i = nl === -1 ? this.#s.length : nl + 1;
				return "";
			}
			default:
				this.#i++;
				return styleChar(c, style);
		}
	}
	#command(style) {
		this.#i++;
		if (this.#i >= this.#s.length) return "";
		const c = this.#s[this.#i] ?? "";
		if (!/[A-Za-z]/.test(c)) {
			this.#i++;
			switch (c) {
				case "\\": return "\n";
				case "{":
				case "}":
				case "$":
				case "%":
				case "&":
				case "#":
				case "_":
				case " ":
				case ".": return c;
				case ",":
				case ":":
				case ";":
				case ">": return " ";
				case "!": return "";
				case "/": return "";
				case "|": return "‖";
				case "(":
				case ")":
				case "[":
				case "]": return "";
				default: return c;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
			name += this.#s[this.#i] ?? "";
			this.#i++;
		}
		if (this.#s[this.#i] === "*") this.#i++;
		return this.#applyCommand(name, style);
	}
	#applyCommand(name, style) {
		const font = FONTS[name];
		if (font) return this.#argument(font).text;
		if (TEXT_COMMANDS[name]) return unescapeText(this.#rawArgument());
		if (name === "operatorname") return unescapeText(this.#rawArgument()) + this.#spaceBeforeArg();
		const accent = ACCENTS[name];
		if (accent) return applyCombining(this.#argument(style).text, accent);
		if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
			const num = this.#argument(style);
			const den = this.#argument(style);
			return this.#fraction(num, den);
		}
		if (name === "genfrac") {
			const left = this.#argument(style).text;
			const right = this.#argument(style).text;
			this.#rawArgument();
			this.#rawArgument();
			const num = this.#argument(style);
			const den = this.#argument(style);
			return left + this.#fraction(num, den) + right;
		}
		if (name === "binom" || name === "dbinom" || name === "tbinom") {
			const n = this.#argument(style);
			const k = this.#argument(style);
			return `C(${n.text}, ${k.text})`;
		}
		if (name === "sqrt") return this.#sqrt(style);
		if (name === "not") {
			const arg = this.#argument(style);
			return NOT_MAP[arg.text] ?? applyCombining(arg.text, "̸");
		}
		if (name === "overset" || name === "stackrel") return this.#scriptedAbove(style);
		if (name === "underset") return this.#scriptedBelow(style);
		if (name === "prescript") return this.#prescript(style);
		const arrow = EXTENSIBLE_ARROWS[name];
		if (arrow !== void 0) return this.#extensibleArrow(style, arrow);
		if (name === "boxed" || name === "fbox") return `[${this.#argument(style).text}]`;
		if (name === "overbrace") return `⏞(${this.#argument(style).text})`;
		if (name === "underbrace") return `⏟(${this.#argument(style).text})`;
		if (name === "overbracket") return `⎴(${this.#argument(style).text})`;
		if (name === "underbracket") return `⎵(${this.#argument(style).text})`;
		if (name === "overparen") return `⏜(${this.#argument(style).text})`;
		if (name === "underparen") return `⏝(${this.#argument(style).text})`;
		if (name === "cancel") return applyCombining(this.#argument(style).text, "̸");
		if (name === "bcancel") return applyCombining(this.#argument(style).text, "⃥");
		if (name === "xcancel") return applyCombining(applyCombining(this.#argument(style).text, "̸"), "⃥");
		if (name === "sout") return applyCombining(this.#argument(style).text, "̶");
		if (name === "substack") return this.#argument(style).text.replace(NEWLINES, ",");
		if (name === "left" || name === "right" || name === "middle") return this.#delimiter(style);
		if (BIG_DELIM.test(name)) return this.#delimiter(style);
		if (name === "begin") return this.#environment(style);
		if (name === "end") {
			this.#rawArgument();
			return "";
		}
		if (name === "bmod") return " mod ";
		if (name === "pmod") return `(mod ${this.#argument(style).text})`;
		if (name === "pod") return `(${this.#argument(style).text})`;
		if (name === "tag") return `(${this.#argument(style).text})`;
		if (name === "label") {
			this.#rawArgument();
			return "";
		}
		if (name === "ref" || name === "eqref") return `(${unescapeText(this.#rawArgument())})`;
		if (name === "url") return unescapeText(this.#rawArgument());
		if (name === "href") {
			this.#rawArgument();
			return this.#argument(style).text;
		}
		if (name === "textcolor") return this.#scopedForeground(this.#readAnsiColor(), style);
		if (name === "colorbox") return this.#scopedBackground(this.#readAnsiColor(), style);
		if (name === "fcolorbox") return this.#fcolorbox(style);
		if (name === "color") return this.#setForeground();
		if (name === "normalcolor") {
			const previous = this.#foreground;
			this.#foreground = null;
			return previous === null ? "" : ANSI_FG_RESET;
		}
		if (name === "phantom" || name === "hphantom") return " ".repeat(codePointLength(this.#argument(style).text));
		if (name === "vphantom") {
			this.#argument(style);
			return "";
		}
		if (FUNCTIONS[name]) return name + this.#spaceBeforeArg();
		const symbol = SYMBOLS[name];
		if (symbol !== void 0) return symbol;
		switch (name) {
			case "displaystyle":
			case "textstyle":
			case "scriptstyle":
			case "scriptscriptstyle":
			case "limits":
			case "nolimits":
			case "nonumber":
			case "notag":
			case "quad": return name === "quad" ? "  " : "";
			case "qquad": return "    ";
			case "thinspace":
			case "enspace":
			case "medspace":
			case "thickspace":
			case "space": return " ";
			case "negthinspace":
			case "negmedspace":
			case "negthickspace": return "";
		}
		return name;
	}
	#group(style) {
		this.#i++;
		const outerForeground = this.#foreground;
		const outerBackground = this.#background;
		const inner = this.parse(style, true);
		const innerForeground = this.#foreground;
		const innerBackground = this.#background;
		if (this.#s[this.#i] === "}") this.#i++;
		this.#foreground = outerForeground;
		this.#background = outerBackground;
		return restoreAnsi(inner, innerForeground, outerForeground, innerBackground, outerBackground);
	}
	#readAnsiColor() {
		return ansiColor(this.#optionalRawArgument(), this.#rawArgument());
	}
	#setForeground() {
		const color = this.#readAnsiColor();
		if (color === null) return "";
		this.#foreground = color.foreground;
		return color.foreground;
	}
	#scopedForeground(color, style) {
		const outerForeground = this.#foreground;
		if (color === null) return this.#argument(style).text;
		this.#foreground = color.foreground;
		const arg = this.#argument(style).text;
		const innerForeground = this.#foreground;
		this.#foreground = outerForeground;
		return color.foreground + restoreAnsi(arg, innerForeground, outerForeground, this.#background, this.#background);
	}
	#scopedBackground(color, style) {
		const outerBackground = this.#background;
		if (color === null) return this.#argument(style).text;
		this.#background = color.background;
		const arg = this.#argument(style).text;
		const innerBackground = this.#background;
		this.#background = outerBackground;
		return color.background + restoreAnsi(arg, this.#foreground, this.#foreground, innerBackground, outerBackground);
	}
	#fcolorbox(style) {
		const frameModel = this.#optionalRawArgument();
		const frame = ansiColor(frameModel, this.#rawArgument());
		const background = ansiColor(this.#optionalRawArgument() ?? frameModel, this.#rawArgument());
		const body = this.#scopedBackground(background, style);
		if (frame === null) return `[${body}]`;
		return `${frame.foreground}[${this.#foreground ?? ANSI_FG_RESET}${body}${frame.foreground}]${this.#foreground ?? ANSI_FG_RESET}`;
	}
	/** Read one argument: a `{…}` group, a single command, or a single char. */
	#argument(style) {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === void 0) return {
			text: "",
			group: false
		};
		if (c === "{") {
			this.#i++;
			const inner = this.parse(style, true);
			if (this.#s[this.#i] === "}") this.#i++;
			return {
				text: inner,
				group: true
			};
		}
		if (c === "\\") return {
			text: this.#command(style),
			group: false
		};
		if (c === "^" || c === "_") {
			this.#i++;
			return {
				text: this.#script(style, c === "^"),
				group: false
			};
		}
		this.#i++;
		return {
			text: styleChar(c, style),
			group: false
		};
	}
	/** Read a raw (unparsed) argument, returning its literal source text. */
	#rawArgument() {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "{") {
			const c = this.#s[this.#i];
			if (c === void 0) return "";
			if (c === "\\") {
				let t = "\\";
				this.#i++;
				if (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) while (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
					t += this.#s[this.#i] ?? "";
					this.#i++;
				}
				else {
					t += this.#s[this.#i] ?? "";
					this.#i++;
				}
				return t;
			}
			this.#i++;
			return c;
		}
		this.#i++;
		let depth = 1;
		let out = "";
		while (this.#i < this.#s.length && depth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					this.#i++;
					break;
				}
			}
			out += c ?? "";
			this.#i++;
		}
		return out;
	}
	#script(style, sup) {
		const arg = this.#argument(style);
		return sup ? toSuperscript(arg.text, arg.group) : toSubscript(arg.text, arg.group);
	}
	#wrapFrac(arg) {
		return arg.group && codePointLength(arg.text) > 1 ? `(${arg.text})` : arg.text;
	}
	#fraction(num, den) {
		const vulgar = VULGAR[`${num.text}/${den.text}`];
		if (vulgar) return vulgar;
		return `${this.#wrapFrac(num)}/${this.#wrapFrac(den)}`;
	}
	#scriptedAbove(style) {
		const above = this.#argument(style);
		return this.#argument(style).text + toSuperscript(above.text, true);
	}
	#scriptedBelow(style) {
		const below = this.#argument(style);
		return this.#argument(style).text + toSubscript(below.text, true);
	}
	#prescript(style) {
		const sup = this.#argument(style);
		const sub = this.#argument(style);
		const base = this.#argument(style);
		return toSuperscript(sup.text, true) + toSubscript(sub.text, true) + base.text;
	}
	#extensibleArrow(style, arrow) {
		const below = this.#optionalArgument(style);
		return arrow + toSuperscript(this.#argument(style).text, true) + (below ? toSubscript(below.text, true) : "");
	}
	#delimiter(style) {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === void 0) return "";
		if (c === ".") {
			this.#i++;
			return "";
		}
		if (c !== "\\") {
			this.#i++;
			return styleChar(c, style);
		}
		this.#i++;
		if (this.#i >= this.#s.length) return "";
		const d = this.#s[this.#i] ?? "";
		if (!/[A-Za-z]/.test(d)) {
			this.#i++;
			switch (d) {
				case ".": return "";
				case "{": return "{";
				case "}": return "}";
				case "|": return "‖";
				default: return d;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
			name += this.#s[this.#i] ?? "";
			this.#i++;
		}
		return SYMBOLS[name] ?? name;
	}
	#optionalArgument(style) {
		const source = this.#optionalRawArgument();
		if (source === null) return null;
		return {
			text: new _a(source).parse(style, false),
			group: true
		};
	}
	#optionalRawArgument() {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "[") return null;
		this.#i++;
		let bracketDepth = 1;
		let braceDepth = 0;
		let out = "";
		while (this.#i < this.#s.length && bracketDepth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") braceDepth++;
			else if (c === "}" && braceDepth > 0) braceDepth--;
			else if (braceDepth === 0 && c === "[") bracketDepth++;
			else if (braceDepth === 0 && c === "]") {
				bracketDepth--;
				if (bracketDepth === 0) {
					this.#i++;
					break;
				}
			}
			out += c ?? "";
			this.#i++;
		}
		return out;
	}
	#sqrt(style) {
		while (this.#s[this.#i] === " ") this.#i++;
		let radical = "√";
		const index = this.#optionalArgument(style)?.text;
		if (index !== void 0) radical = index === "2" ? "√" : index === "3" ? "∛" : index === "4" ? "∜" : `${toSuperscript(index, true)}√`;
		const radicand = this.#argument(style).text;
		return radical + (codePointLength(radicand) > 1 ? `(${radicand})` : radicand);
	}
	#environment(style) {
		const env = this.#rawArgument().trim();
		if (env === "array" || env === "tabular" || env === "array*" || env === "tabular*" || env === "alignedat" || env === "alignedat*" || env === "alignat" || env === "alignat*" || env === "gatheredat") {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument();
		}
		let body = "";
		while (this.#i < this.#s.length) {
			if (this.#s.startsWith("\\end", this.#i)) {
				this.#i += 4;
				this.#rawArgument();
				break;
			}
			body += this.#node(style);
		}
		body = body.trim();
		if (env === "cases" || env === "cases*" || env === "dcases" || env === "dcases*" || env === "rcases" || env === "drcases") body = body.replace(/[ \t]*\n+[ \t]*/g, "; ").replace(/ {3,}/g, "  ");
		const delims = ENV_DELIMS[env];
		return delims ? delims[0] + body + delims[1] : body;
	}
	/** A separator space when the next glyph is alphanumeric or a command. */
	#spaceBeforeArg() {
		const c = this.#s[this.#i];
		if (c === void 0) return "";
		return /[A-Za-z0-9\\]/.test(c) ? " " : "";
	}
};
_a = LatexParser;
/**
* Convert a bare LaTeX math fragment (no surrounding `$`/`\(` delimiters) to its
* best-effort Unicode rendering. Unknown commands degrade to their bare name;
* `\\` becomes a newline. Always returns a string (never throws).
* @param src - 不带定界符的 LaTeX 数学片段。
* @returns 尽力而为的 Unicode 渲染结果；空串或非字符串输入原样返回。
*/
function latexToUnicode(src) {
	if (typeof src !== "string" || src.length === 0) return src;
	return new LatexParser(src).render();
}
const NEWLINES = /\n+/g;
const BARE_MATH_LINE_COMMAND = /\\(?:operatorname|frac|dfrac|tfrac|cfrac|genfrac|sqrt|sum|prod|coprod|int|iint|iiint|lim|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|phi|varphi|pi|omega|infty|partial|nabla|forall|exists|mathbb|mathcal|mathscr|mathbf|mathrm|left|right|begin|phantom|hphantom|vphantom|cdots|ldots|dots|to|rightarrow|leftarrow|leq|geq|neq|times|cdot|overline|underline|vec|hat|bar|textcolor|color|normalcolor|colorbox|fcolorbox)\b/;
const BARE_MATH_ENVIRONMENTS = /* @__PURE__ */ new Set([
	"matrix",
	"smallmatrix",
	"pmatrix",
	"bmatrix",
	"Bmatrix",
	"vmatrix",
	"Vmatrix",
	"cases",
	"dcases",
	"rcases",
	"drcases",
	"aligned",
	"alignedat",
	"align",
	"alignat",
	"split",
	"gathered",
	"gatheredat",
	"gather",
	"multline",
	"equation",
	"eqnarray",
	"array",
	"subarray"
]);
/**
* True when `env` is a math environment safe to auto-render without `$`/`\[`
* delimiters. The trailing `*` of starred variants (`align*`, `equation*`) is
* ignored; text-mode environments (`tabular`, `itemize`, …) return false.
* @param env - `\begin{…}` 中的环境名（可带尾部 `*`）。
* @returns 属于可裸渲染数学环境时为 true。
*/
function isBareMathEnvironment(env) {
	return BARE_MATH_ENVIRONMENTS.has(env.endsWith("*") ? env.slice(0, -1) : env);
}
function renderBareMathInText(text) {
	let out = "";
	let i = 0;
	for (;;) {
		const begin = text.indexOf("\\begin{", i);
		if (begin === -1) return out + renderBareMathLines(text.slice(i));
		const envStart = begin + 7;
		const envEnd = text.indexOf("}", envStart);
		if (envEnd === -1) return out + renderBareMathLines(text.slice(i));
		const env = text.slice(envStart, envEnd);
		const closeToken = `\\end{${env}}`;
		const close = text.indexOf(closeToken, envEnd + 1);
		if (close === -1) {
			out += renderBareMathLines(text.slice(i, envEnd + 1));
			i = envEnd + 1;
			continue;
		}
		const blockEnd = close + closeToken.length;
		if (!isBareMathEnvironment(env)) {
			out += renderBareMathLines(text.slice(i, begin)) + text.slice(begin, blockEnd);
			i = blockEnd;
			continue;
		}
		const lineStart = text.lastIndexOf("\n", begin - 1) + 1;
		const prefix = text.slice(lineStart, begin);
		let start = prefix.includes("\\") || prefix.includes("=") ? lineStart : begin;
		if (start === begin && prefix.trim() === "" && lineStart > 0) {
			const previousLineEnd = lineStart - 1;
			const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
			const previousLine = text.slice(previousLineStart, previousLineEnd);
			if (/[=([{]\s*$/.test(previousLine)) start = previousLineStart;
		}
		out += renderBareMathLines(text.slice(i, start));
		out += latexToUnicode(text.slice(start, blockEnd)).replace(NEWLINES, " ");
		i = blockEnd;
	}
}
function renderBareMathLines(text) {
	let out = "";
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		out += shouldRenderBareMathLine(line) ? latexToUnicode(line).replace(NEWLINES, " ") : line;
		if (i !== text.length) out += "\n";
		lineStart = i + 1;
	}
	return out;
}
function shouldRenderBareMathLine(line) {
	const trimmed = line.trim();
	if (trimmed === "" || !trimmed.includes("\\")) return false;
	const env = /\\(?:begin|end)\{([^}]*)\}/.exec(trimmed);
	if (env && !isBareMathEnvironment(env[1] ?? "")) return false;
	if (!BARE_MATH_LINE_COMMAND.test(trimmed)) return false;
	return trimmed.startsWith("\\") || /[=<>^_{}&]/.test(trimmed);
}
/**
* Scan prose for math spans — `$$…$$`, `\[…\]` (display) and `$…$`, `\(…\)`
* (inline) — and replace each with its Unicode rendering, leaving everything
* else verbatim. Newlines inside a span collapse to spaces so the result stays
* single-line-safe.
*
* Inline `$…$` uses pandoc's anti-currency heuristics: the opener must not be
* followed by whitespace, the closer must not be preceded by whitespace nor
* followed by a digit, and `\$` is treated as a literal dollar — so "$5 and
* $10" is left untouched.
* @param text - 可能含数学 span 的原始 prose 文本。
* @returns 数学 span 就地替换为 Unicode 渲染后的文本；其余内容原样保留。
*/
function renderMathInText(text) {
	if (typeof text !== "string" || text.length === 0) return text;
	if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[") && !text.includes("\\begin") && !BARE_MATH_LINE_COMMAND.test(text)) return text;
	const conv = (inner) => latexToUnicode(inner).replace(NEWLINES, " ");
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\\") {
			const d = text[i + 1];
			if (d === "\\") {
				out += "\\\\";
				i += 2;
				continue;
			}
			if (d === "(") {
				const close = text.indexOf("\\)", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "[") {
				const close = text.indexOf("\\]", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "$") {
				out += "$";
				i += 2;
				continue;
			}
			out += c;
			i++;
			continue;
		}
		if (c === "$") {
			if (text[i + 1] === "$") {
				const close = text.indexOf("$$", i + 2);
				if (close !== -1 && text.slice(i + 2, close).trim().length > 0) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
				out += "$$";
				i += 2;
				continue;
			}
			const close = inlineMathSpanEnd(text, i);
			if (close !== -1) {
				out += conv(text.slice(i + 1, close));
				i = close + 1;
				continue;
			}
			out += "$";
			i++;
			continue;
		}
		out += c ?? "";
		i++;
	}
	return renderBareMathInText(out);
}
/**
* Index of the `$` that closes an inline math span opened at `open` (the index
* of the opening `$`), or -1 when the run is not inline math. Applies pandoc's
* anti-currency heuristics: the opener must not be followed by whitespace, the
* closer must not be preceded by whitespace nor followed by a digit, `\$` is a
* literal dollar, and the span may not span a newline. Shared by
* `renderMathInText` and the markdown math tokenizer so the rule has one home.
* @param text - 被扫描的完整文本。
* @param open - 开头 `$` 在 `text` 中的索引。
* @returns 闭合 `$` 的索引；不构成行内数学 span 时返回 -1。
*/
function inlineMathSpanEnd(text, open) {
	const after = text[open + 1];
	if (after === void 0 || after === " " || after === "	" || after === "\n" || after === "$") return -1;
	for (let j = open + 1; j < text.length; j++) {
		const ch = text[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === "\n") return -1;
		if (ch === "$") {
			const prev = text[j - 1];
			if (prev === " " || prev === "	") return -1;
			const next = text[j + 1];
			if (next !== void 0 && next >= "0" && next <= "9") continue;
			return text.slice(open + 1, j).trim().length > 0 ? j : -1;
		}
	}
	return -1;
}
//#endregion
//#region lib/types/pi/latex-block.js
const BAR = "─";
const FRAC_COMMANDS = {
	frac: true,
	dfrac: true,
	tfrac: true,
	cfrac: true
};
const DISPLAY_ROW_ENVIRONMENTS = {
	equation: true,
	eqnarray: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	flalign: true,
	split: true,
	gather: true,
	gathered: true,
	gatheredat: true,
	multline: true,
	displaymath: true,
	math: true
};
function spaces(n) {
	return n > 0 ? " ".repeat(n) : "";
}
/** Pad `line` on the right to `width` visible columns. */
function padRight(line, width) {
	return line + spaces(width - displayWidth(line));
}
/** Pad `line` symmetrically (left-biased) to `width` visible columns. */
function center$1(line, width) {
	const extra = width - displayWidth(line);
	if (extra <= 0) return line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}
/** A single rendered string (possibly multi-line) as a baseline-centered box. */
function textBox(text) {
	const raw = text.split("\n");
	let width = 0;
	for (const line of raw) width = Math.max(width, displayWidth(line));
	return {
		lines: raw.map((line) => padRight(line, width)),
		baseline: raw.length - 1 >> 1,
		width
	};
}
/** Place boxes side by side, aligning their baselines. */
function hconcat(boxes) {
	if (boxes.length === 1) return boxes[0] ?? textBox("");
	let above = 0;
	let below = 0;
	for (const b of boxes) {
		above = Math.max(above, b.baseline);
		below = Math.max(below, b.lines.length - 1 - b.baseline);
	}
	const height = above + below + 1;
	const lines = [];
	let width = 0;
	for (const b of boxes) width += b.width;
	for (let row = 0; row < height; row++) {
		let line = "";
		for (const b of boxes) {
			const local = row - (above - b.baseline);
			line += local >= 0 && local < b.lines.length ? b.lines[local] ?? "" : spaces(b.width);
		}
		lines.push(line);
	}
	return {
		lines,
		baseline: above,
		width
	};
}
/** Stack `num` over `den`, separated by a bar; the bar becomes the baseline. */
function fracBox(num, den) {
	const width = Math.max(num.width, den.width) + 2;
	return {
		lines: [
			...num.lines.map((line) => center$1(line, width)),
			BAR.repeat(width),
			...den.lines.map((line) => center$1(line, width))
		],
		baseline: num.lines.length,
		width
	};
}
/** Stack boxes vertically (left-aligned), e.g. the rows of an aligned block. */
function vconcat(boxes) {
	if (boxes.length === 1) return boxes[0] ?? textBox("");
	let width = 0;
	for (const b of boxes) width = Math.max(width, b.width);
	const lines = [];
	for (const b of boxes) for (const line of b.lines) lines.push(padRight(line, width));
	return {
		lines,
		baseline: lines.length - 1 >> 1,
		width
	};
}
/** Read a balanced `{…}` beginning at `i` (which must point at `{`). */
function readBraceGroup(src, i) {
	let depth = 0;
	let out = "";
	let j = i;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") {
			out += c + (src[j + 1] ?? "");
			j++;
			continue;
		}
		if (c === "{") {
			depth++;
			if (depth > 1) out += c;
			continue;
		}
		if (c === "}") {
			depth--;
			if (depth === 0) {
				j++;
				break;
			}
			out += c;
			continue;
		}
		out += c ?? "";
	}
	return {
		text: out,
		end: j
	};
}
/**
* Read one fraction argument: a `{…}` group, a single char, or a `\command`
* together with its attached `[…]`/`{…}` arguments (or whole `\begin…\end`
* block), so e.g. `\frac\sqrt{a}{b}` reads `\sqrt{a}` as the numerator.
*/
function readArg(src, i) {
	while (src[i] === " ") i++;
	if (i >= src.length) return {
		text: "",
		end: i
	};
	const ch = src[i];
	if (ch === void 0) return {
		text: "",
		end: i
	};
	if (ch === "{") return readBraceGroup(src, i);
	if (ch !== "\\") return {
		text: ch,
		end: i + 1
	};
	let j = i + 1;
	let name = "";
	while (/[A-Za-z]/.test(src[j] ?? "")) {
		name += src[j] ?? "";
		j++;
	}
	if (name === "begin") {
		const env = consumeEnvironment(src, i);
		if (env) return env;
	}
	if (!name) return {
		text: src.slice(i, i + 2),
		end: i + 2
	};
	let end = j;
	while (src[end] === "[" || src[end] === "{") if (src[end] === "{") end = readBraceGroup(src, end).end;
	else {
		const close = src.indexOf("]", end);
		end = close === -1 ? src.length : close + 1;
	}
	return {
		text: src.slice(i, end),
		end
	};
}
/** Locate a `\begin{env}…\end{env}` block (balanced) starting at the backslash. */
function readEnvironment(src, start) {
	let i = start + 6;
	while (src[i] === " ") i++;
	if (src[i] !== "{") return null;
	const nameGroup = readBraceGroup(src, i);
	let k = nameGroup.end;
	let depth = 1;
	let bodyEnd = src.length;
	while (k < src.length && depth > 0) {
		if (src.startsWith("\\begin", k)) {
			depth++;
			k += 6;
			continue;
		}
		if (src.startsWith("\\end", k)) {
			depth--;
			if (depth === 0) bodyEnd = k;
			k += 4;
			while (src[k] === " ") k++;
			if (src[k] === "{") k = readBraceGroup(src, k).end;
			if (depth === 0) break;
			continue;
		}
		k++;
	}
	return {
		env: nameGroup.text.trim(),
		bodyStart: nameGroup.end,
		bodyEnd,
		end: k
	};
}
/** The full `\begin{env}…\end{env}` substring as an inline run. */
function consumeEnvironment(src, start) {
	const env = readEnvironment(src, start);
	return env ? {
		text: src.slice(start, env.end),
		end: env.end
	} : null;
}
/** Split an environment body on top-level `\\` row breaks (depth-aware). */
function splitRows(body) {
	const rows = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < body.length) {
		if (body.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (body.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = body[i];
		if (c === "\\") {
			if (body[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				rows.push(body.slice(last, i));
				i += 2;
				while (body[i] === " ") i++;
				if (body[i] === "[") {
					const close = body.indexOf("]", i);
					i = close === -1 ? body.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2;
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		i++;
	}
	rows.push(body.slice(last));
	return rows;
}
/**
* Render a `\begin{env}…\end{env}` block. Expression "wrapper" environments
* (`equation`, `align`, `gather`, …) have their rows parsed so fractions stack;
* grid/structure environments (matrix/array/cases) render flat via
* `latexToUnicode`.
*/
function parseEnvironment(src, start) {
	const env = readEnvironment(src, start);
	if (env === null) return null;
	const base = env.env.endsWith("*") ? env.env.slice(0, -1) : env.env;
	if (!DISPLAY_ROW_ENVIRONMENTS[base]) return {
		box: textBox(latexToUnicode(src.slice(start, env.end))),
		end: env.end
	};
	let bodyStart = env.bodyStart;
	if (base === "alignat" || base === "alignedat" || base === "gatheredat") {
		let p = bodyStart;
		while (src[p] === " " || src[p] === "\n") p++;
		if (src[p] === "{") bodyStart = readBraceGroup(src, p).end;
	}
	const rows = splitRows(src.slice(bodyStart, env.bodyEnd)).map((row) => row.trim()).filter((row) => row !== "").map((row) => parseExpr(row));
	return {
		box: rows.length > 0 ? vconcat(rows) : textBox(""),
		end: env.end
	};
}
/** Append a script (`^`/`_`) and its argument to the inline run verbatim. */
function readScript(src, i) {
	let out = src[i] ?? "";
	i++;
	while (src[i] === " ") {
		const sp = src[i];
		if (sp === void 0) break;
		out += sp;
		i++;
	}
	if (src[i] === "{") {
		const group = readBraceGroup(src, i);
		return {
			text: `${out}{${group.text}}`,
			end: group.end
		};
	}
	if (src[i] === "\\") {
		let j = i + 1;
		if (/[A-Za-z]/.test(src[j] ?? "")) while (/[A-Za-z]/.test(src[j] ?? "")) j++;
		else j++;
		return {
			text: out + src.slice(i, j),
			end: j
		};
	}
	if (i < src.length) {
		const ch = src[i];
		if (ch !== void 0) return {
			text: out + ch,
			end: i + 1
		};
	}
	return {
		text: out,
		end: i
	};
}
/**
* Parse a math fragment into a layout box, stacking top-level fractions (and
* fractions nested inside other fractions' arguments). Non-fraction runs —
* including scripts, roots, environments, and command arguments — are gathered
* into inline strings and rendered through `latexToUnicode`.
*/
function parseExpr(src) {
	const boxes = [];
	let inline = "";
	const flush = () => {
		if (inline) {
			boxes.push(textBox(latexToUnicode(inline)));
			inline = "";
		}
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			let j = i + 1;
			let name = "";
			while (j < src.length) {
				const ch = src[j];
				if (ch === void 0 || !/[A-Za-z]/.test(ch)) break;
				name += ch;
				j++;
			}
			if (name && FRAC_COMMANDS[name]) {
				flush();
				const num = readArg(src, j);
				const den = readArg(src, num.end);
				boxes.push(fracBox(parseExpr(num.text), parseExpr(den.text)));
				i = den.end;
				continue;
			}
			if (name === "begin") {
				const env = parseEnvironment(src, i);
				if (env) {
					flush();
					boxes.push(env.box);
					i = env.end;
					continue;
				}
			}
			if (!name) {
				inline += `\\${src[j] ?? ""}`;
				i = j + 1;
				continue;
			}
			inline += `\\${name}`;
			i = j;
			while (src[i] === "[" || src[i] === "{") if (src[i] === "{") {
				const group = readBraceGroup(src, i);
				inline += `{${group.text}}`;
				i = group.end;
			} else {
				const close = src.indexOf("]", i);
				const end = close === -1 ? src.length : close + 1;
				inline += src.slice(i, end);
				i = end;
			}
			continue;
		}
		if (c === "^" || c === "_") {
			const script = readScript(src, i);
			inline += script.text;
			i = script.end;
			continue;
		}
		if (c === "{") {
			const group = readBraceGroup(src, i);
			flush();
			boxes.push(parseExpr(group.text));
			i = group.end;
			continue;
		}
		inline += c ?? "";
		i++;
	}
	flush();
	if (boxes.length === 0) return textBox("");
	return hconcat(boxes);
}
/** Split on top-level `\n` row separators (outside braces and environments). */
function splitLines(src) {
	const lines = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (src.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "\n" && braceDepth === 0 && envDepth === 0) {
			lines.push(src.slice(last, i));
			last = i + 1;
		}
		i++;
	}
	lines.push(src.slice(last));
	return lines;
}
/**
* Render a display LaTeX math fragment to lines, stacking `\frac` vertically.
* Top-level source newlines become vertical rows (so a `lhs =` line stays above
* its block); each row stacks fractions via `parseExpr`. Inline math should use
* `latexToUnicode` instead — fractions there stay single-line.
* @param src - display 数学的 LaTeX 源（不带 `$$`/`\[` 定界符）。
* @returns 渲染后的行数组（去除首尾空行）；空输入返回空数组。
*/
function latexToBlock(src) {
	if (typeof src !== "string" || src.trim() === "") return [];
	const rows = splitLines(src.trim()).map((line) => line.trim()).filter((line) => line !== "").map((line) => parseExpr(line));
	if (rows.length === 0) return [];
	let lines = vconcat(rows).lines;
	while (lines.length > 1) {
		const last = lines[lines.length - 1];
		if (last === void 0 || last.trim() !== "") break;
		lines = lines.slice(0, -1);
	}
	while (lines.length > 1) {
		const first = lines[0];
		if (first === void 0 || first.trim() !== "") break;
		lines = lines.slice(1);
	}
	return lines;
}
//#endregion
//#region lib/types/format/markdown.js
/**
* T9 纯 ANSI Markdown 格式化器。
*
* 从 `markdown-render.tsx` 提取：所有解析逻辑（parseBlocks、parseInline、
* highlightLine、guessLang、keywordsForLang）保持不变，只将 React 渲染函数
* 替换为纯 ANSI 字符串构建器。
*
* 零 React/Ink 依赖。输出为 ANSI 格式化字符串数组（每行一个元素）。
*/
const JS_KEYWORDS = /* @__PURE__ */ new Set([
	"const",
	"let",
	"var",
	"function",
	"return",
	"if",
	"else",
	"for",
	"while",
	"class",
	"new",
	"this",
	"import",
	"export",
	"from",
	"default",
	"async",
	"await",
	"try",
	"catch",
	"throw",
	"typeof",
	"instanceof",
	"switch",
	"case",
	"break",
	"continue",
	"interface",
	"type",
	"enum",
	"extends",
	"implements",
	"readonly",
	"true",
	"false",
	"null",
	"undefined",
	"void",
	"delete",
	"in",
	"of",
	"as"
]);
const PY_KEYWORDS = /* @__PURE__ */ new Set([
	"def",
	"class",
	"return",
	"if",
	"elif",
	"else",
	"for",
	"while",
	"import",
	"from",
	"as",
	"try",
	"except",
	"finally",
	"raise",
	"with",
	"yield",
	"lambda",
	"pass",
	"break",
	"continue",
	"and",
	"or",
	"not",
	"in",
	"is",
	"True",
	"False",
	"None",
	"self",
	"async",
	"await",
	"print"
]);
const GO_KEYWORDS = /* @__PURE__ */ new Set([
	"func",
	"return",
	"if",
	"else",
	"for",
	"range",
	"var",
	"const",
	"type",
	"struct",
	"interface",
	"package",
	"import",
	"defer",
	"go",
	"chan",
	"select",
	"case",
	"switch",
	"default",
	"break",
	"continue",
	"map",
	"nil",
	"true",
	"false",
	"err",
	"make",
	"append"
]);
const RUST_KEYWORDS = /* @__PURE__ */ new Set([
	"fn",
	"let",
	"mut",
	"pub",
	"struct",
	"enum",
	"impl",
	"trait",
	"mod",
	"use",
	"return",
	"if",
	"else",
	"for",
	"while",
	"loop",
	"match",
	"self",
	"Self",
	"true",
	"false",
	"Some",
	"None",
	"Ok",
	"Err",
	"async",
	"await",
	"move",
	"where",
	"type",
	"const",
	"static",
	"ref",
	"as",
	"in"
]);
const BASH_KEYWORDS = /* @__PURE__ */ new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"do",
	"done",
	"case",
	"esac",
	"function",
	"return",
	"exit",
	"echo",
	"export",
	"source",
	"alias",
	"local",
	"readonly",
	"set",
	"unset",
	"true",
	"false"
]);
const CPP_KEYWORDS = /* @__PURE__ */ new Set([
	"alignas",
	"alignof",
	"and",
	"and_eq",
	"asm",
	"auto",
	"bitand",
	"bitor",
	"bool",
	"break",
	"case",
	"catch",
	"char",
	"class",
	"compl",
	"concept",
	"const",
	"const_cast",
	"continue",
	"default",
	"delete",
	"do",
	"double",
	"else",
	"enum",
	"explicit",
	"export",
	"extern",
	"false",
	"float",
	"for",
	"friend",
	"goto",
	"if",
	"inline",
	"int",
	"long",
	"mutable",
	"namespace",
	"new",
	"noexcept",
	"not",
	"nullptr",
	"operator",
	"or",
	"private",
	"protected",
	"public",
	"reinterpret_cast",
	"return",
	"short",
	"signed",
	"sizeof",
	"static",
	"static_cast",
	"struct",
	"switch",
	"template",
	"this",
	"throw",
	"true",
	"try",
	"typedef",
	"typename",
	"union",
	"unsigned",
	"using",
	"virtual",
	"void",
	"volatile",
	"while"
]);
const SQL_KEYWORDS = /* @__PURE__ */ new Set([
	"select",
	"insert",
	"update",
	"delete",
	"from",
	"where",
	"join",
	"left",
	"right",
	"inner",
	"outer",
	"on",
	"group",
	"by",
	"order",
	"having",
	"limit",
	"offset",
	"create",
	"table",
	"alter",
	"drop",
	"index",
	"view",
	"into",
	"values",
	"set",
	"and",
	"or",
	"not",
	"in",
	"is",
	"null",
	"true",
	"false",
	"as",
	"distinct",
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"union",
	"all",
	"any",
	"exists",
	"like",
	"between",
	"case",
	"when",
	"then",
	"else",
	"end"
]);
const RUBY_KEYWORDS = /* @__PURE__ */ new Set([
	"alias",
	"and",
	"begin",
	"break",
	"case",
	"class",
	"def",
	"do",
	"else",
	"elsif",
	"end",
	"ensure",
	"false",
	"for",
	"if",
	"in",
	"module",
	"next",
	"nil",
	"not",
	"or",
	"redo",
	"rescue",
	"retry",
	"return",
	"self",
	"super",
	"then",
	"true",
	"undef",
	"unless",
	"until",
	"when",
	"while",
	"yield"
]);
const PHP_KEYWORDS = /* @__PURE__ */ new Set([
	"abstract",
	"and",
	"array",
	"as",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"declare",
	"default",
	"do",
	"echo",
	"else",
	"elsif",
	"extends",
	"final",
	"finally",
	"fn",
	"for",
	"foreach",
	"function",
	"global",
	"if",
	"implements",
	"include",
	"instanceof",
	"interface",
	"isset",
	"list",
	"match",
	"namespace",
	"new",
	"or",
	"print",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"switch",
	"throw",
	"trait",
	"try",
	"unset",
	"use",
	"var",
	"while",
	"yield",
	"true",
	"false",
	"null"
]);
const DOCKERFILE_KEYWORDS = /* @__PURE__ */ new Set([
	"from",
	"run",
	"cmd",
	"label",
	"expose",
	"env",
	"add",
	"copy",
	"entrypoint",
	"volume",
	"user",
	"workdir",
	"arg",
	"onbuild",
	"stopsignal",
	"healthcheck",
	"shell"
]);
/**
* 语言名（含常见别名）→ 高亮关键字配置。
* @param lang - 语言名或别名（如 ts/py/golang），大小写不敏感。
* @returns 匹配的关键字配置；不认识的语言返回 null（不高亮）。
*/
function keywordsForLang(lang) {
	const l = lang.toLowerCase();
	if (l === "typescript" || l === "ts" || l === "javascript" || l === "js" || l === "jsx" || l === "tsx") return { keywords: JS_KEYWORDS };
	if (l === "python" || l === "py") return { keywords: PY_KEYWORDS };
	if (l === "go" || l === "golang") return { keywords: GO_KEYWORDS };
	if (l === "rust" || l === "rs") return { keywords: RUST_KEYWORDS };
	if (l === "bash" || l === "sh" || l === "shell" || l === "zsh") return { keywords: BASH_KEYWORDS };
	if (l === "c" || l === "cpp" || l === "cc" || l === "h" || l === "hpp") return { keywords: CPP_KEYWORDS };
	if (l === "java") return { keywords: /* @__PURE__ */ new Set([
		"abstract",
		"assert",
		"boolean",
		"break",
		"byte",
		"case",
		"catch",
		"char",
		"class",
		"const",
		"continue",
		"default",
		"do",
		"double",
		"else",
		"enum",
		"extends",
		"final",
		"finally",
		"float",
		"for",
		"goto",
		"if",
		"implements",
		"import",
		"instanceof",
		"int",
		"interface",
		"long",
		"native",
		"new",
		"package",
		"private",
		"protected",
		"public",
		"return",
		"short",
		"static",
		"super",
		"switch",
		"synchronized",
		"this",
		"throw",
		"throws",
		"transient",
		"try",
		"void",
		"volatile",
		"while",
		"true",
		"false",
		"null"
	]) };
	if (l === "sql") return {
		keywords: SQL_KEYWORDS,
		caseInsensitive: true
	};
	if (l === "ruby" || l === "rb") return { keywords: RUBY_KEYWORDS };
	if (l === "php") return { keywords: PHP_KEYWORDS };
	if (l === "dockerfile" || l === "docker") return {
		keywords: DOCKERFILE_KEYWORDS,
		caseInsensitive: true
	};
	return null;
}
function getSynColors(theme) {
	return {
		keyword: theme?.primary ?? "#d7dce3",
		type: theme?.secondary ?? "#b0b8c4",
		func: theme?.secondary ?? "#b0b8c4",
		string: theme?.muted ?? "#9aa2b1",
		number: theme?.muted ?? "#9aa2b1",
		punct: theme?.dim ?? "#6e7681",
		comment: theme?.dim ?? "#6e7681"
	};
}
/**
* 单行行内 Markdown 分词：**bold**、*em*、`code`、[text](url) → Segment 序列。
* 未闭合的分隔符按普通文本处理（不吞字符）。
* @param text - 单行文本（不含换行）。
* @returns 顺序覆盖整行的 Segment 数组。
*/
function parseInline(text) {
	const segments = [];
	let i = 0;
	let buf = "";
	const flush = () => {
		if (buf) {
			segments.push({ text: buf });
			buf = "";
		}
	};
	while (i < text.length) {
		if (text[i] === "*" && text[i + 1] === "*" || text[i] === "_" && text[i + 1] === "_") {
			const delim = text.slice(i, i + 2);
			const end = text.indexOf(delim, i + 2);
			if (end !== -1) {
				flush();
				segments.push({
					text: text.slice(i + 2, end),
					bold: true
				});
				i = end + 2;
				continue;
			}
		}
		if (text[i] === "*" && text[i + 1] !== "*" && (i === 0 || text[i - 1] !== "*")) {
			const end = text.indexOf("*", i + 1);
			if (end !== -1 && text[end + 1] !== "*" && (end === 0 || text[end - 1] !== "*")) {
				flush();
				segments.push({
					text: text.slice(i + 1, end),
					italic: true
				});
				i = end + 1;
				continue;
			}
		}
		if (text[i] === "_" && text[i + 1] !== "_" && (i === 0 || /[a-zA-Z]/.test(text[i - 1] ?? ""))) {
			const end = text.indexOf("_", i + 1);
			if (end !== -1 && text[end + 1] !== "_") {
				flush();
				segments.push({
					text: text.slice(i + 1, end),
					italic: true
				});
				i = end + 1;
				continue;
			}
		}
		if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end !== -1) {
				flush();
				segments.push({
					text: text.slice(i + 1, end),
					code: true
				});
				i = end + 1;
				continue;
			}
		}
		if (text[i] === "[") {
			const textEnd = text.indexOf("]", i + 1);
			if (textEnd !== -1 && text[textEnd + 1] === "(") {
				const urlEnd = text.indexOf(")", textEnd + 2);
				if (urlEnd !== -1) {
					flush();
					const href = text.slice(textEnd + 2, urlEnd).trim();
					segments.push({
						text: text.slice(i + 1, textEnd),
						underline: true,
						...href ? { href } : {}
					});
					i = urlEnd + 1;
					continue;
				}
			}
		}
		buf += text[i] ?? "";
		i++;
	}
	flush();
	return segments;
}
/**
* 多行 Markdown 块级解析：代码围栏、$$/\[ 数学块、标题、hr、引用、列表、
* 表格与段落。未闭合的代码围栏/数学块收集到文末。
* @param text - 完整 Markdown 文本（可多行）。
* @returns 按出现序的 Block 数组。
*/
function parseBlocks(text) {
	const lines = text.split("\n");
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === void 0) break;
		if (line.startsWith("```")) {
			const language = line.slice(3).trim();
			const codeLines = [];
			i++;
			while (i < lines.length) {
				const l = lines[i];
				if (l === void 0 || l.startsWith("```")) break;
				codeLines.push(l);
				i++;
			}
			blocks.push({
				type: "code",
				...language ? { language } : {},
				content: codeLines.join("\n")
			});
			i++;
			continue;
		}
		if (line.startsWith("$$") || line.startsWith("\\[")) {
			const opener = line.startsWith("$$") ? "$$" : "\\[";
			const closer = line.startsWith("$$") ? "$$" : "\\]";
			if (line.endsWith(closer) && line.length > opener.length) {
				const body = line.slice(opener.length, line.length - closer.length);
				blocks.push({
					type: "math",
					content: body
				});
				i++;
				continue;
			}
			const bodyLines = [];
			i++;
			while (i < lines.length) {
				const l = lines[i];
				if (l === void 0 || l.includes(closer)) break;
				bodyLines.push(l);
				i++;
			}
			if (i < lines.length) {
				const closeLine = lines[i] ?? "";
				const closeIdx = closeLine.indexOf(closer);
				if (closeIdx > 0) bodyLines.push(closeLine.slice(0, closeIdx));
				i++;
			}
			blocks.push({
				type: "math",
				content: bodyLines.join("\n")
			});
			continue;
		}
		const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
		if (headerMatch) {
			blocks.push({
				type: "header",
				level: (headerMatch[1] ?? "").length,
				content: headerMatch[2] ?? ""
			});
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			blocks.push({
				type: "hr",
				content: ""
			});
			i++;
			continue;
		}
		if (line.startsWith("> ")) {
			const quoteLines = [];
			while (i < lines.length) {
				const q = lines[i];
				if (q === void 0 || !q.startsWith("> ")) break;
				quoteLines.push(q.slice(2));
				i++;
			}
			blocks.push({
				type: "blockquote",
				content: quoteLines.join("\n")
			});
			continue;
		}
		if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
			const items = [];
			while (i < lines.length) {
				const item = lines[i];
				if (item === void 0 || !/^(\s*[-*]\s|\s*\d+\.\s)/.test(item)) break;
				items.push(item.replace(/^\s*[-*]\s|\s*\d+\.\s/, ""));
				i++;
			}
			blocks.push({
				type: "list",
				content: items.join("\n"),
				items
			});
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1] ?? "")) {
			const tableLines = [];
			while (i < lines.length) {
				const t = lines[i];
				if (t === void 0 || !t.includes("|")) break;
				tableLines.push(t);
				i++;
			}
			blocks.push({
				type: "table",
				content: tableLines.join("\n")
			});
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const paraLines = [];
		while (i < lines.length) {
			const p = lines[i];
			if (p === void 0 || p.trim() === "" || p.startsWith("#") || p.startsWith("```") || p.startsWith("> ") || /^(\s*[-*]\s)/.test(p)) break;
			paraLines.push(p);
			i++;
		}
		if (paraLines.length > 0) blocks.push({
			type: "paragraph",
			content: paraLines.join("\n")
		});
		else {
			blocks.push({
				type: "paragraph",
				content: line
			});
			i++;
		}
	}
	return blocks;
}
/**
* 单行代码语法高亮：字符串/数字/关键字/类型名/函数调用/标点/注释分段着色。
* @param line - 单行代码文本。
* @param keywords - 语言关键字集合；null 时整行按普通文本返回（不高亮）。
* @param caseInsensitive - 关键字匹配是否大小写不敏感（SQL/Dockerfile）。
* @param theme - 当前主题；缺省时回退硬编码色。
* @returns 顺序覆盖整行的 Segment 数组（带 color 标记）。
*/
function highlightLine(line, keywords, caseInsensitive = false, theme) {
	if (!keywords) return [{ text: line }];
	const SYN = getSynColors(theme);
	const segments = [];
	const commentIdx = line.indexOf("//");
	const hashCommentIdx = line.indexOf("#");
	let effectiveCommentIdx = -1;
	if (commentIdx !== -1 && (hashCommentIdx === -1 || commentIdx < hashCommentIdx)) effectiveCommentIdx = commentIdx;
	else if (hashCommentIdx !== -1) effectiveCommentIdx = hashCommentIdx;
	const effectiveLine = effectiveCommentIdx !== -1 ? line.slice(0, effectiveCommentIdx) : line;
	const commentPart = effectiveCommentIdx !== -1 ? line.slice(effectiveCommentIdx) : "";
	const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\w+\b|\s+|[^\s\w]+)/g;
	let match;
	while ((match = re.exec(effectiveLine)) !== null) {
		const token = match[0];
		if (/^\s+$/.test(token)) {
			segments.push({ text: token });
			continue;
		}
		if (/^["'`]/.test(token)) {
			segments.push({
				text: token,
				color: SYN.string
			});
			continue;
		}
		if (/^[^\s\w]+$/.test(token)) {
			segments.push({
				text: token,
				color: SYN.punct
			});
			continue;
		}
		const matchToken = caseInsensitive ? token.toLowerCase() : token;
		if (keywords.has(matchToken)) segments.push({
			text: token,
			color: SYN.keyword,
			bold: true
		});
		else if (/^\d[\d._]*$/.test(token)) segments.push({
			text: token,
			color: SYN.number
		});
		else if (/^[A-Z][a-zA-Z0-9]*$/.test(token)) segments.push({
			text: token,
			color: SYN.type
		});
		else if (effectiveLine[match.index + token.length] === "(") segments.push({
			text: token,
			color: SYN.func
		});
		else segments.push({ text: token });
	}
	if (commentPart) segments.push({
		text: commentPart,
		color: SYN.comment
	});
	return segments;
}
/**
* 从代码文本前 500 字符启发式猜测语言（typescript/python/go/rust/bash）。
* @param text - 代码文本。
* @returns 猜中的语言名；无法判定返回 undefined。
*/
function guessLang(text) {
	const sample = text.slice(0, 500);
	if (/\bimport\b.*\bfrom\b|export\s+(default|const|function)|=>\s*[{(]|:\s*(string|number|boolean)\b/.test(sample)) return "typescript";
	if (/\bdef\b|\bclass\b.*:$|import\s+\w+/m.test(sample)) return "python";
	if (/\bfunc\b|\bpackage\b\s+\w+|:=/.test(sample)) return "go";
	if (/\bfn\b|\blet\s+mut\b|\bimpl\b/.test(sample)) return "rust";
	if (/^#!/.test(sample) || /\bfi\b|\bdone\b|\besac\b/.test(sample)) return "bash";
}
/**
* 快速判定文本是否含 Markdown/数学/链接语法（决定 formatMarkdown 是否走完整解析）。
* @param text - 待检测文本。
* @returns 含任一 Markdown 信号（强调/代码/标题/列表/引用/hr/数学分隔符/链接）时 true。
*/
function hasMarkdown(text) {
	return text.includes("**") || text.includes("`") || text.includes("```") || /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text) || /^>\s/m.test(text) || /^(-{3,}|\*{3,}|_{3,})\s*$/m.test(text) || /\$[^\s$]/.test(text) || text.includes("$$") || text.includes("\\[") || text.includes("\\(") || /\[[^\]]+\]\([^)]+\)/.test(text);
}
const NUMBERED_LINE_RE = /^\s*\d+│/;
function formatSegment(seg, theme) {
	let s = seg.text;
	const opts = {
		...seg.bold !== void 0 ? { bold: seg.bold } : {},
		...seg.italic !== void 0 ? { italic: seg.italic } : {},
		...seg.underline !== void 0 ? { underline: seg.underline } : {},
		...seg.dimmed !== void 0 ? { dim: seg.dimmed } : {}
	};
	const fgHex = seg.color ?? (seg.code ? theme.secondary : "");
	if (seg.color || seg.code || seg.bold || seg.italic || seg.underline || seg.dimmed) s = color(seg.code ? ` ${seg.text} ` : seg.text, fgHex, opts);
	if (seg.href) s = hyperlink(s, seg.href);
	return s;
}
function formatInlineToAnsi(segments, theme) {
	return segments.map((seg) => formatSegment(seg, theme)).join("");
}
/**
* 1. 尝试检测并格式化 Git Commit 提交标签行
* 示例: "95454cd0  — 5 files, +70/-4。"
* @param line - 待检测的单行文本（保留前导缩进）。
* @param theme - 当前主题（hash/分隔符/增删计数分色）。
* @returns 命中提交行格式时返回染色后的行；否则 null（调用方走普通渲染）。
*/
function tryFormatGitCommitLine(line, theme) {
	const indent = /^\s*/.exec(line)?.[0] ?? "";
	const trimmed = line.trim();
	const match = /^(?:commit\s+)?([0-9a-f]{7,40})\s+(—|-|:)\s+(.*)$/i.exec(trimmed);
	if (!match) return null;
	const [, hash, sep, rest] = match;
	if (!/\b\d+\s+files?|\+\d+|-\d+|insertions?|deletions?/i.test(rest)) return null;
	return `${indent}${color(`⎇ ${hash}`, theme.secondary, {
		bold: true,
		underline: true
	})}${color(` ${sep} `, theme.dim)}${rest.replace(/\+(\d+)/g, color("+$1", theme.success, { bold: true })).replace(/-(\d+)/g, color("-$1", theme.error, { bold: true })).replace(/(\d+)(\s+files?)/g, color("$1$2", theme.assistantColor))}`;
}
/**
* 2. 高亮行首的代码序号（如 ①-⑩ / ❶-❿ / 1. 2. 等）
* @param renderedLine - 已渲染的行（可含 ANSI；只改写行首序号段）。
* @param theme - 当前主题（序号用 warning 色加粗）。
* @returns 行首命中序号时返回改写后的行；否则原样返回。
*/
function highlightCodeLineNumber(renderedLine, theme) {
	const circleMatch = /^(\s*)([①②③④⑤⑥⑦⑧⑨⑩❶❷❸❹❺❻❼❽❾❿])(\s*.*)$/.exec(renderedLine);
	if (circleMatch) {
		const [, indent, num, rest] = circleMatch;
		return `${indent}${color(num, theme.warning, { bold: true })}${rest}`;
	}
	const digitMatch = /^(\s*)(\d+[.)])(\s+.*)$/.exec(renderedLine);
	if (digitMatch) {
		const [, indent, num, rest] = digitMatch;
		return `${indent}${color(num, theme.warning, { bold: true })}${rest}`;
	}
	return renderedLine;
}
function formatCodeBlock(language, content, _columns, theme) {
	const lines = content.split("\n");
	const langConfig = language ? keywordsForLang(language) : null;
	const keywords = langConfig?.keywords ?? null;
	const caseInsensitive = langConfig?.caseInsensitive ?? false;
	const langLower = language?.toLowerCase();
	const isDiffBlock = langLower === "diff" || langLower === "patch" || isDiffContent(content);
	const MAX_CODE_LINES = 60;
	const truncated = lines.length > MAX_CODE_LINES;
	const visible = truncated ? lines.slice(0, MAX_CODE_LINES) : lines;
	const result = [];
	const label = language || "code";
	let labelDisplay = label;
	if (label === "code" || label === "- code -" || label === "bash") labelDisplay = `‹/› ${label.replace(/^-?\s*code\s*-?$/i, "CODE")}`;
	else labelDisplay = `‹/› ${label.toUpperCase()}`;
	result.push(color(`╴ ${labelDisplay} ╴`, theme.secondary, { bold: true }));
	for (const line of visible) {
		if (isDiffBlock) {
			result.push(color(line, diffLineColor(line, theme)));
			continue;
		}
		const gitFormatted = tryFormatGitCommitLine(line, theme);
		if (gitFormatted) {
			result.push(gitFormatted);
			continue;
		}
		const ansiLine = formatInlineToAnsi(highlightLine(line, keywords, caseInsensitive, theme), theme);
		result.push(highlightCodeLineNumber(ansiLine, theme));
	}
	if (truncated) result.push(color(hiddenLinesMarker(lines.length - MAX_CODE_LINES), theme.muted));
	return result;
}
function formatBlock(block, columns, theme) {
	const result = [];
	switch (block.type) {
		case "header": {
			const level = block.level ?? 1;
			const colors = [
				theme.primary,
				void 0,
				void 0,
				theme.secondary,
				theme.secondary,
				theme.secondary
			];
			const glyph = [
				"▌",
				"▌",
				"",
				"",
				"",
				""
			][level - 1] ?? "";
			const headerColor = colors[level - 1];
			const text = glyph ? `${glyph} ${block.content}` : block.content;
			result.push(headerColor ? color(text, headerColor, { bold: true }) : color(text, theme.assistantColor, { bold: true }));
			break;
		}
		case "code":
			result.push(...formatCodeBlock(block.language, block.content, columns, theme));
			break;
		case "math": {
			const mathLines = latexToBlock(block.content);
			if (mathLines.length === 0) result.push(color(latexToUnicode(block.content), theme.assistantColor));
			else for (const ml of mathLines) result.push(color(ml, theme.assistantColor));
			break;
		}
		case "list": {
			const items = block.items ?? block.content.split("\n");
			for (const item of items) {
				const itemAnsi = formatInlineToAnsi(parseInline(item), theme);
				result.push(`${color("◇", theme.secondary)} ${highlightCodeLineNumber(itemAnsi, theme)}`);
			}
			break;
		}
		case "blockquote":
			result.push(`${color("▎", theme.secondary)} ${color(block.content, theme.muted, { italic: true })}`);
			break;
		case "hr":
			result.push(color("─".repeat(Math.max(20, columns - 4)), theme.dim));
			break;
		case "table": {
			const dataLines = block.content.split("\n").filter((l) => !/^\|?[\s-:|]+\|?$/.test(l.trim()));
			for (let i = 0; i < dataLines.length; i++) {
				const line = dataLines[i];
				if (line === void 0) continue;
				result.push(i === 0 ? color(line, theme.secondary, { bold: true }) : line);
			}
			break;
		}
		default: {
			const lines = block.content.split("\n");
			for (const line of lines) {
				const gitFormattedLine = tryFormatGitCommitLine(line, theme);
				if (gitFormattedLine) result.push(gitFormattedLine);
				else {
					const formatted = color(formatInlineToAnsi(parseInline(renderMathInText(line)), theme), theme.assistantColor);
					result.push(highlightCodeLineNumber(formatted, theme));
				}
			}
			break;
		}
	}
	return result;
}
/**
* 将 Markdown 文本格式化为 ANSI 行数组。
*
* 这是 `Markdown` React 组件的纯 ANSI 替代。
* 零 React/Ink 依赖。
* @param input - 文本、可选语言提示与终端宽度。
* @param theme - 当前主题。
* @returns ANSI 行数组；空文本返回空数组。
*/
function formatMarkdown(input, theme) {
	if (!input.text) return [];
	const result = [];
	if (!hasMarkdown(input.text) && NUMBERED_LINE_RE.test(input.text)) {
		const lang = input.language ?? guessLang(input.text);
		const langConfig = lang ? keywordsForLang(lang) : null;
		const keywords = langConfig?.keywords ?? null;
		const caseInsensitive = langConfig?.caseInsensitive ?? false;
		for (const line of input.text.split("\n")) {
			const pipeIdx = line.indexOf("│");
			if (pipeIdx === -1) {
				result.push(line);
				continue;
			}
			const gutter = line.slice(0, pipeIdx + 1);
			const segs = highlightLine(line.slice(pipeIdx + 1), keywords, caseInsensitive, theme);
			result.push(`${color(gutter, theme.dim)}${formatInlineToAnsi(segs, theme)}`);
		}
		return result;
	}
	if (!hasMarkdown(input.text)) for (const line of input.text.split("\n")) {
		const gitFormatted = tryFormatGitCommitLine(line, theme);
		if (gitFormatted) result.push(gitFormatted);
		else result.push(highlightCodeLineNumber(line, theme));
	}
	else {
		const blocks = parseBlocks(input.text);
		for (const block of blocks) result.push(...formatBlock(block, input.columns, theme));
	}
	for (let i = result.length - 1; i >= 0; i--) {
		const lineStr = result[i];
		if (!lineStr) continue;
		const plainLine = lineStr.replace(/\u001b\[[0-9;]*m/g, "").trim();
		if (!plainLine) continue;
		if (/[？?]\s*$/.test(plainLine) && !plainLine.includes("⚡")) result[i] = `${color("⚡", theme.warning, { bold: true })} ${lineStr}`;
		break;
	}
	return result;
}
//#endregion
//#region lib/types/live-tail-cap.js
/** Display rows a single logical line occupies at the given width (wrapping-aware). */
function rowsFor(line, width) {
	if (width <= 0) return 1;
	return Math.max(1, Math.ceil(displayWidth(line, { ambiguousAsWide: ambiguousWideEnabled() }) / width));
}
/**
* 多行文本在给定宽度下占的显示行总数（折行感知；空行也计 1 行）。
* @param text - 待度量文本（按 `\n` 分行）。
* @param width - 终端宽度（<=0 时每逻辑行按 1 行计）。
* @returns 显示行总数。
*/
function displayRowsForText(text, width) {
	return text.split("\n").reduce((total, line) => total + rowsFor(line, width), 0);
}
const OMITTED_PREFIX = "… ";
const OMITTED_PREFIX_NARROW = "…";
function charWidth(ch) {
	return displayWidth(ch, { ambiguousAsWide: ambiguousWideEnabled() });
}
function takeTailByDisplayWidth(line, maxDisplayWidth) {
	if (maxDisplayWidth <= 0) return "";
	const chars = Array.from(line);
	let width = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i];
		/* v8 ignore next -- Array.from 结果无稀疏位；noUncheckedIndexedAccess 收窄防御 */
		if (ch === void 0) continue;
		const nextWidth = width + charWidth(ch);
		if (nextWidth > maxDisplayWidth) break;
		width = nextWidth;
		start = i;
	}
	return chars.slice(start).join("");
}
function takeTailByDisplayRows(line, width, rows) {
	/* v8 ignore next -- 唯一调用方 capLiveTail 保证 remaining>0 才进入，此分支不可达 */
	if (rows <= 0) return "";
	/* v8 ignore next -- width<=0 时 rowsFor 恒 1、remaining 恒 0，partial-fit 永不发生 */
	if (width <= 0) return line;
	return takeTailByDisplayWidth(line, rows * width);
}
function markOmittedHead(line, width) {
	if (width <= 0) return `${OMITTED_PREFIX}${line}`;
	const prefix = width > charWidth(OMITTED_PREFIX) ? OMITTED_PREFIX : OMITTED_PREFIX_NARROW;
	return `${prefix}${takeTailByDisplayWidth(line, Math.max(0, rowsFor(line, width) * width - charWidth(prefix)))}`;
}
/**
* Cap the live tail to the last `maxRows` DISPLAY rows (wrapping-aware).
*
* The live (redrawn) region must never exceed the viewport, or Ink's relative
* cursor-up erase clamps at the viewport top and the terminal scrolls/duplicates
* every frame (真凶②). The bound must be in DISPLAY rows, not logical lines or
* chars (R6): a line wider than the terminal wraps to multiple rows.
*
* This only trims the redrawn live region. Committed content already lives in
* native scrollback (full, scrollable, searchable) — nothing here hides it.
*
* @param text - live 区全文（按 `\n` 分行）。
* @param width - 终端宽度（折行成本按此计算）。
* @param maxRows - 显示行上限（<=0 返回空串）。
* @returns 裁到上限内的尾部文本；发生裁剪时首行加省略号前缀。
*/
function capLiveTail(text, width, maxRows) {
	if (maxRows <= 0) return "";
	const lines = text.split("\n");
	let rows = 0;
	let omitted = false;
	const kept = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		/* v8 ignore next -- split 结果无稀疏位；noUncheckedIndexedAccess 收窄防御 */
		if (line === void 0) continue;
		const cost = rowsFor(line, width);
		if (rows + cost > maxRows) {
			const remaining = maxRows - rows;
			if (remaining > 0) kept.unshift(takeTailByDisplayRows(line, width, remaining));
			omitted = true;
			break;
		}
		rows += cost;
		kept.unshift(line);
	}
	if (omitted && kept.length > 0) {
		const first = kept[0];
		/* v8 ignore next -- kept.length>0 保证 kept[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
		if (first !== void 0) kept[0] = markOmittedHead(first, width);
	}
	return kept.join("\n");
}
/** A line that opens/closes a fenced code block (``` at column 0). */
function isFenceLine(line) {
	return line.startsWith("```");
}
/**
* Like capLiveTail, but markdown-fence-aware for the LIVE streaming tail.
*
* The live view renders the tail through the markdown block parser, which pairs
* ``` fences greedily (1st = open, 2nd = close, …). A raw tail slice can begin
* INSIDE a code block — then the tail's first ``` is really the block's CLOSER,
* but the parser reads it as an OPENER and boxes the following PROSE in a stray
* "code" frame (real code ends up outside the box; the offset is the tell). It
* flickers as the window slides each delta → "occasional code box around prose".
*
* Fix: count fences in the dropped head (everything above the visible tail). If
* odd, the tail starts inside a code block, so prepend a synthetic ``` opener
* that pairs with the inherited closer and realigns every fence after it. We
* reserve one row for that opener so the result still fits maxRows.
*
* Operates on the FULL accumulated text (not a pre-slice) so the fence count is
* correct; it only walks the trailing maxRows worth of lines for the visible
* region, so cost stays bounded regardless of total reply length.
*
* @param fullText - 累积的完整流式文本（不能是预切片，否则围栏计数会错）。
* @param width - 终端宽度。
* @param maxRows - 显示行上限（<=0 返回空串；需补合成开栏时为其保留一行）。
* @returns 裁剪后的尾部文本，必要时前置合成 ``` 开栏。
*/
function capLiveTailMarkdownSafe(fullText, width, maxRows) {
	if (maxRows <= 0) return "";
	const lines = fullText.split("\n");
	let rows = 0;
	let firstKept = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		/* v8 ignore next -- split 结果无稀疏位；noUncheckedIndexedAccess 收窄防御 */
		if (line === void 0) continue;
		const cost = rowsFor(line, width);
		if (rows + cost > maxRows) break;
		rows += cost;
		firstKept = i;
	}
	let fences = 0;
	for (let i = 0; i < firstKept; i++) {
		const line = lines[i];
		/* v8 ignore next -- split 结果无稀疏位；noUncheckedIndexedAccess 收窄防御 */
		if (line === void 0) continue;
		if (isFenceLine(line)) fences++;
	}
	const startsInsideCode = fences % 2 === 1;
	const capped = capLiveTail(lines.slice(firstKept >= lines.length ? lines.length - 1 : firstKept).join("\n"), width, startsInsideCode ? Math.max(1, maxRows - 1) : maxRows);
	return startsInsideCode ? "```\n" + capped : capped;
}
//#endregion
//#region lib/types/engine/stream-renderer.js
/**
* T9 StreamRenderer — 流式 Markdown 增量渲染（Claude Code StreamingMarkdown 模型）。
*
* 职责：
* - 接收 BlockStreamWriter 吐出的节流文本块，累积到 pending 缓冲区。
* - 在「最后一个稳定的顶层 block 边界」切分：空行结束的段落、闭合的 ``` 围栏。
* - 稳定前缀立即经 formatMarkdown 渲染后 commit 到 scrollback（不可回退）。
* - 尾部不完整 block 留在 pending，由 live 区以原始文本渲染（display-width
*   aware tail-cap，避免 CJK 宽字符截断错位）。
* - 围栏代码块流式期间不解析高亮（防闪烁）：未闭合的 ``` 内容停留在 pending，
*   闭合后整块作为稳定前缀高亮 commit。
*
* 数据流：
*   onTextDelta → BlockStreamWriter（节流）→ StreamRenderer.push
*     ├── 稳定 block → formatMarkdown → commit(scrollback)
*     └── 尾部不完整 block → getLiveTail → LiveEngine 底部重绘
*/
/**
* 找到文本中最后一个稳定的顶层 block 边界（fence-aware）。
*
* 边界定义（均为「该行结尾、含换行符」的 offset）：
* - 围栏外的空行（段落/列表/标题等 block 在空行处结束）
* - 闭合的 ``` 围栏行（整个代码块完整，可安全高亮）
*
* 围栏内部的空行不算边界（代码块未闭合时不可切分）。
* 最后一行（可能无尾随换行、仍在增长）永不参与判定。
*
* @param text - 累积中的流式 Markdown 文本
* @returns 切割 offset；0 表示尚无稳定边界
*/
function findStableBoundary(text) {
	let inFence = false;
	let lastBoundary = 0;
	let offset = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		if (line === void 0) continue;
		const lineEnd = offset + line.length + 1;
		if (line.startsWith("```")) {
			inFence = !inFence;
			if (!inFence) lastBoundary = lineEnd;
		} else if (!inFence && line.trim() === "") lastBoundary = lineEnd;
		offset = lineEnd;
	}
	return lastBoundary;
}
/**
* 流式 Markdown 增量渲染器：累积文本块，在稳定 block 边界切分——
* 稳定前缀经 formatMarkdown 渲染后 commit 到 scrollback（带 LRU 渲染缓存），
* 尾部不完整 block 留在 pending 由 live 区以原始文本展示。
*/
var StreamRenderer = class StreamRenderer {
	static CACHE_MAX_ENTRIES = 64;
	static CACHE_MAX_TEXT = 16384;
	pending = "";
	committedAny = false;
	options;
	stableCache = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	/** 是否已有任何内容 commit 到 scrollback（用于 header 等一次性输出判定） */
	get hasCommitted() {
		return this.committedAny;
	}
	/** 是否持有任何内容（pending 或已 commit） */
	get hasContent() {
		return this.committedAny || this.pending.length > 0;
	}
	/** 当前未 commit 的尾部文本 */
	get pendingText() {
		return this.pending;
	}
	/**
	* 累积流式文本块；出现稳定边界时立即渲染并 commit 稳定前缀。
	* @param chunk - 新到达的文本块；空串为 no-op
	* @returns 本次是否同步 commit 了稳定前缀
	*/
	push(chunk) {
		if (!chunk) return false;
		this.pending += chunk;
		const cut = findStableBoundary(this.pending);
		if (cut > 0) {
			const stable = this.pending.slice(0, cut);
			this.pending = this.pending.slice(cut);
			return this.commitText(stable);
		}
		return false;
	}
	/**
	* 流结束：把剩余 pending 全部渲染 commit。
	* @returns 本轮是否输出过任何内容
	*/
	finalize() {
		if (this.pending.trim().length > 0) this.commitText(this.pending);
		this.pending = "";
		const had = this.committedAny;
		this.committedAny = false;
		return had;
	}
	/** 丢弃所有状态（abort 场景） */
	reset() {
		this.pending = "";
		this.committedAny = false;
	}
	/**
	* live 区尾部行：原始文本（不做 markdown 解析，防未闭合围栏闪烁），
	* display-width aware 截断到 maxRows 显示行。
	*
	* `extraTail` 为尚未吐块的最新缓冲（BlockStreamWriter.peek()）——拼在
	* pending 之后一起截断，使最新 token 逐字可见（打字机节奏），无需等 blockWriter
	* 吐块。截断对合并文本整体生效，保证不超视口 / CJK 宽度正确。
	* @param maxRows - 尾部显示行上限
	* @param extraTail - 尚未吐块的最新缓冲（BlockStreamWriter.peek()）
	* @returns 截断后的尾部行数组；无尾部内容时为空数组
	*/
	getLiveTailLines(maxRows, extraTail = "") {
		const tail = this.pending + extraTail;
		if (!tail) return [];
		const capped = capLiveTailMarkdownSafe(tail, this.options.getColumns(), maxRows);
		return capped ? capped.split("\n") : [];
	}
	commitText(text) {
		const trimmed = text.replace(/\n+$/, "");
		if (!trimmed.trim()) return false;
		const columns = this.options.getColumns();
		const cacheable = Buffer.byteLength(trimmed, "utf8") <= StreamRenderer.CACHE_MAX_TEXT;
		const language = trimmed.startsWith("```") ? trimmed.slice(3).split(/\s|\n/, 1)[0] ?? "" : "";
		const key = cacheable ? `${columns}\0${this.options.getThemeKey()}\0${language}\0${trimmed}` : void 0;
		let ansi = key === void 0 ? void 0 : this.stableCache.get(key);
		if (ansi !== void 0 && key !== void 0) {
			this.stableCache.delete(key);
			this.stableCache.set(key, ansi);
			this.options.onCacheResult?.(true);
			this.options.perfMonitor?.recordCache(true);
		} else {
			if (key !== void 0) {
				this.options.onCacheResult?.(false);
				this.options.perfMonitor?.recordCache(false);
			}
			const render = () => formatMarkdown({
				text: trimmed,
				columns
			}, this.options.getTheme());
			const rendered = this.options.perfMonitor?.measure("formatMarkdown", render) ?? render();
			if (rendered.length === 0) return false;
			ansi = rendered.join("\n");
			if (key !== void 0) {
				this.stableCache.set(key, ansi);
				if (this.stableCache.size > StreamRenderer.CACHE_MAX_ENTRIES) {
					const oldest = this.stableCache.keys().next().value;
					if (oldest !== void 0) this.stableCache.delete(oldest);
				}
			}
		}
		this.options.commit(ansi);
		this.committedAny = true;
		return true;
	}
};
//#endregion
//#region lib/types/engine/perf-monitor.js
/**
* TUI 渲染性能监控：按采样点计时（p50/p99/max）+ 事件循环延迟直方图 + 缓存命中率。
* 未启用（--debug-perf / RIVET_DEBUG_TELEMETRY=1 之外）时所有操作为 no-op 零开销。
*/
const SAMPLE_NAMES = [
	"renderLive",
	"delta",
	"formatMarkdown",
	"flush"
];
const NS_PER_MS = 1e6;
const MAX_RETAINED_SAMPLES = 4096;
function roundMs(value) {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
function emptyStats() {
	return {
		count: 0,
		p50Ms: 0,
		p99Ms: 0,
		maxMs: 0
	};
}
/**
* 判断性能监控是否应启用：`--debug-perf` 命令行开关或 `RIVET_DEBUG_TELEMETRY=1`。
* @param args - 命令行参数（默认 process.argv.slice(2)，可注入用于测试）
* @param env - 环境变量集合（默认 process.env，可注入用于测试）
* @returns 应启用监控时为 true
*/
function isTuiPerfEnabled(args = process.argv.slice(2), env = process.env) {
	return args.includes("--debug-perf") || env.RIVET_DEBUG_TELEMETRY === "1";
}
/**
* TUI 性能监控器。enabled=false 时不分配采样存储、不开直方图，
* 所有记录方法直通返回；enabled=true 时每个采样点保留最近 4096 条样本。
* 用完调用 stop() 关闭事件循环直方图。
*/
var TuiPerfMonitor = class {
	/** 监控是否启用（构造时确定，不可变）。 */
	enabled;
	now;
	histogram;
	samples;
	counts;
	maxima;
	cacheHits = 0;
	cacheMisses = 0;
	lastLoopLag = {
		p99Ms: 0,
		maxMs: 0
	};
	lastLoopLagAt = Number.NEGATIVE_INFINITY;
	stopped = false;
	constructor(options) {
		this.enabled = options.enabled;
		this.now = options.now ?? (() => performance.now());
		if (!this.enabled) return;
		this.samples = {
			renderLive: [],
			delta: [],
			formatMarkdown: [],
			flush: []
		};
		this.counts = {
			renderLive: 0,
			delta: 0,
			formatMarkdown: 0,
			flush: 0
		};
		this.maxima = {
			renderLive: 0,
			delta: 0,
			formatMarkdown: 0,
			flush: 0
		};
		this.histogram = (options.createHistogram ?? (() => monitorEventLoopDelay({ resolution: 20 })))();
		this.histogram.enable();
	}
	/**
	* 计时执行一个同步操作并记录耗时（操作抛错时仍记录，异常原样上抛）。
	* @param name - 采样点名称
	* @param operation - 被计时的同步操作
	* @returns operation 的返回值
	*/
	measure(name, operation) {
		if (!this.enabled) return operation();
		const start = this.now();
		try {
			return operation();
		} finally {
			this.record(name, this.now() - start);
		}
	}
	/**
	* 记录一次外部测得的耗时（负值钳为 0；超出保留上限时逐出最旧样本）。
	* @param name - 采样点名称
	* @param durationMs - 耗时（毫秒）
	*/
	record(name, durationMs) {
		if (!this.enabled || !this.samples || !this.counts || !this.maxima) return;
		const value = Math.max(0, durationMs);
		const retained = this.samples[name];
		if (retained.length >= MAX_RETAINED_SAMPLES) retained.shift();
		retained.push(value);
		this.counts[name]++;
		this.maxima[name] = Math.max(this.maxima[name], value);
	}
	/**
	* 记录一次缓存命中/未命中。
	* @param hit - true 计命中，false 计未命中
	*/
	recordCache(hit) {
		if (!this.enabled) return;
		if (hit) this.cacheHits++;
		else this.cacheMisses++;
	}
	/**
	* 读取事件循环延迟统计（带最小采样间隔的缓存；采样后重置直方图窗口）。
	* @param minIntervalMs - 两次真实采样的最小间隔（默认 1000ms），间隔内返回缓存值
	* @returns 最近窗口的延迟统计；未启用时为上次缓存（初始全 0）
	*/
	getLoopLagWindow(minIntervalMs = 1e3) {
		if (!this.enabled || !this.histogram) return this.lastLoopLag;
		const now = this.now();
		if (now - this.lastLoopLagAt < minIntervalMs) return this.lastLoopLag;
		this.lastLoopLag = this.sampleLoopLag();
		this.lastLoopLagAt = now;
		return this.lastLoopLag;
	}
	/**
	* 汇总全部采样点的统计快照（p50/p99 基于保留样本，count/max 为全程累计）。
	* @returns 性能快照；未启用监控时为 undefined
	*/
	summary() {
		if (!this.enabled || !this.samples || !this.counts || !this.maxima) return void 0;
		const stats = {};
		for (const name of SAMPLE_NAMES) {
			const retained = [...this.samples[name]].sort((a, b) => a - b);
			if (retained.length === 0) {
				stats[name] = emptyStats();
				continue;
			}
			const percentile = (p) => retained[Math.max(0, Math.ceil(p * retained.length) - 1)] ?? 0;
			stats[name] = {
				count: this.counts[name],
				p50Ms: roundMs(percentile(.5)),
				p99Ms: roundMs(percentile(.99)),
				maxMs: roundMs(this.maxima[name])
			};
		}
		return {
			kind: "perf-summary",
			samples: stats,
			cache: {
				hits: this.cacheHits,
				misses: this.cacheMisses
			},
			loopLag: this.sampleLoopLag()
		};
	}
	/** 关闭事件循环直方图（幂等；未启用监控时为 no-op）。 */
	stop() {
		if (!this.histogram || this.stopped) return;
		this.histogram.disable();
		this.stopped = true;
	}
	sampleLoopLag() {
		if (!this.histogram) return this.lastLoopLag;
		const snapshot = {
			p99Ms: roundMs(this.histogram.percentile(99) / NS_PER_MS),
			maxMs: roundMs(this.histogram.max / NS_PER_MS)
		};
		this.histogram.reset();
		return snapshot;
	}
};
//#endregion
//#region lib/types/engine/image-tool.js
/**
* 系统图像工具共享执行器 — 平台感知的候选命令构造与 fallback 执行、临时目录管理，
* 供 image-attach（缩放）与 term-image（格式转换）两条路径共用，
* 避免两套超时/清理策略漂移。
*
* 候选顺序按平台区分（见 toPngCandidates / resizeCandidates）：
* - darwin/linux：sips（macOS 内置，Linux 上不存在会自然失败进 fallback）
*   → ImageMagick v7（magick）→ v6（convert）。
* - win32：magick → PowerShell + System.Drawing 兜底。不含 sips（不存在），
*   也不含 convert——避免撞名系统工具 C:\Windows\System32\convert.exe
*   （FAT→NTFS 转换）；PowerShell 为 Windows 自带，覆盖未装 ImageMagick 的场景。
*   注意 System.Drawing 不支持 WebP（无 WebP 编解码器）——win32 未装 ImageMagick
*   时 WebP 转换必然失败：所有候选跑完返回 null，调用方退回文本占位。失败
*   不再是静默的：全部候选失败且 RIVET_DEBUG 非空时向 stderr 打一行调试输出
*   （见 runImageTool 末尾）。
*
* 临时目录约定：每次转换一个 `rivet-imgtool-*` 独立目录，finally 中删除；
* 进程崩溃/SIGKILL 残留由下一次转换时的惰性清扫兜底（mtime 超过 1 小时即删）。
*/
const execFileAsync$2 = promisify(execFile);
/** 转换临时目录的名称前缀（惰性清扫按此前缀识别残留目录）。 */
const IMAGE_TEMP_DIR_PREFIX = "rivet-imgtool-";
/** 残留目录惰性清扫阈值。 */
const STALE_MS = 36e5;
/** PowerShell 单引号字符串字面量：内部 ' 翻倍转义。 */
function psQuote(path) {
	return `'${path.replace(/'/g, "''")}'`;
}
/** PowerShell 兜底命令：inbox powershell.exe + System.Drawing，-Command 执行脚本。 */
function powershellCommand(script) {
	return {
		bin: "powershell",
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		]
	};
}
/**
* 「任意格式 → PNG」转换候选命令（首个成功即采用）。
* darwin/linux：sips → magick → convert；win32：magick → PowerShell
* （convert 会撞名系统工具 convert.exe，sips 不存在，均排除）。
* @param inPath - 输入图片路径（任意受支持格式）
* @param outPath - PNG 输出路径
* @param platform - 目标平台（默认 process.platform，可注入用于测试）
* @returns 按优先级排列的候选命令列表
*/
function toPngCandidates(inPath, outPath, platform = process.platform) {
	if (platform === "win32") return [{
		bin: "magick",
		args: [inPath, `png:${outPath}`]
	}, powershellCommand(`\$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; \$img=\$null; try { $img=[System.Drawing.Image]::FromFile(${psQuote(inPath)}); $img.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png) } finally { if (\$img) { \$img.Dispose() } }`)];
	return [
		{
			bin: "sips",
			args: [
				"-s",
				"format",
				"png",
				inPath,
				"--out",
				outPath
			]
		},
		{
			bin: "magick",
			args: [inPath, `png:${outPath}`]
		},
		{
			bin: "convert",
			args: [inPath, `png:${outPath}`]
		}
	];
}
/**
* 「等比缩放到长边 ≤ maxEdge 并输出 PNG」候选命令（首个成功即采用）。
* darwin/linux：sips → magick → convert；win32：magick → PowerShell。
* @param inPath - 输入图片路径
* @param outPath - PNG 输出路径
* @param maxEdge - 长边像素上限（仅超限时缩小，保持宽高比）
* @param platform - 目标平台（默认 process.platform，可注入用于测试）
* @returns 按优先级排列的候选命令列表
*/
function resizeCandidates(inPath, outPath, maxEdge, platform = process.platform) {
	if (platform === "win32") {
		const script = [
			"$ErrorActionPreference='Stop'",
			"Add-Type -AssemblyName System.Drawing",
			"$img=$null;$bmp=$null;$g=$null",
			"try {",
			`$img=[System.Drawing.Image]::FromFile(${psQuote(inPath)})`,
			`$scale=[Math]::Min(1.0,${maxEdge}/[Math]::Max($img.Width,$img.Height))`,
			"$w=[int][Math]::Max(1,[Math]::Round($img.Width*$scale))",
			"$h=[int][Math]::Max(1,[Math]::Round($img.Height*$scale))",
			"$bmp=New-Object System.Drawing.Bitmap($w,$h)",
			"$g=[System.Drawing.Graphics]::FromImage($bmp)",
			"$g.DrawImage($img,0,0,$w,$h)",
			`$bmp.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png)`,
			"} finally {",
			"if ($g) { $g.Dispose() }",
			"if ($bmp) { $bmp.Dispose() }",
			"if ($img) { $img.Dispose() }",
			"}"
		].join(";");
		return [{
			bin: "magick",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				outPath
			]
		}, powershellCommand(script)];
	}
	return [
		{
			bin: "sips",
			args: [
				"-Z",
				String(maxEdge),
				"-s",
				"format",
				"png",
				inPath,
				"--out",
				outPath
			]
		},
		{
			bin: "magick",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				outPath
			]
		},
		{
			bin: "convert",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				outPath
			]
		}
	];
}
/**
* 「等比缩放到长边 ≤ maxEdge 并以 JPEG 质量 quality 输出」候选命令（首个成功即采用）。
* 用于发送管线的降级压缩链（image-attach）：PNG 源第一级保透明输出 PNG，
* 其余格式及降级档一律转 JPEG——同时完成「provider 支持格式」转码
* （BMP/TIFF 等不在 provider 白名单内）。`>` 修饰符 / sips -Z 保证只缩不放。
* @param inPath - 输入图片路径
* @param outPath - JPEG 输出路径
* @param maxEdge - 长边像素上限（仅超限时缩小，保持宽高比）
* @param quality - JPEG 质量 0-100（sips formatOptions / magick -quality）
* @param platform - 目标平台（默认 process.platform，可注入用于测试）
* @returns 按优先级排列的候选命令列表
*/
function resizeJpegCandidates(inPath, outPath, maxEdge, quality, platform = process.platform) {
	if (platform === "win32") {
		const script = [
			"$ErrorActionPreference='Stop'",
			"Add-Type -AssemblyName System.Drawing",
			"$img=$null;$bmp=$null;$g=$null",
			"try {",
			`$img=[System.Drawing.Image]::FromFile(${psQuote(inPath)})`,
			`$scale=[Math]::Min(1.0,${maxEdge}/[Math]::Max($img.Width,$img.Height))`,
			"$w=[int][Math]::Max(1,[Math]::Round($img.Width*$scale))",
			"$h=[int][Math]::Max(1,[Math]::Round($img.Height*$scale))",
			"$bmp=New-Object System.Drawing.Bitmap($w,$h)",
			"$g=[System.Drawing.Graphics]::FromImage($bmp)",
			"$g.DrawImage($img,0,0,$w,$h)",
			"$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
			"$params=New-Object System.Drawing.Imaging.EncoderParameters(1)",
			`$params.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,${quality})`,
			`$bmp.Save(${psQuote(outPath)},$codec,$params)`,
			"} finally {",
			"if ($g) { $g.Dispose() }",
			"if ($bmp) { $bmp.Dispose() }",
			"if ($img) { $img.Dispose() }",
			"}"
		].join(";");
		return [{
			bin: "magick",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				"-quality",
				String(quality),
				`jpg:${outPath}`
			]
		}, powershellCommand(script)];
	}
	return [
		{
			bin: "sips",
			args: [
				"-s",
				"format",
				"jpeg",
				"-s",
				"formatOptions",
				String(quality),
				"-Z",
				String(maxEdge),
				inPath,
				"--out",
				outPath
			]
		},
		{
			bin: "magick",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				"-quality",
				String(quality),
				`jpg:${outPath}`
			]
		},
		{
			bin: "convert",
			args: [
				inPath,
				"-resize",
				`${maxEdge}x${maxEdge}>`,
				"-quality",
				String(quality),
				`jpg:${outPath}`
			]
		}
	];
}
/** PNG 文件签名（magic bytes）。 */
const PNG_SIGNATURE = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
/** 完整 IEND chunk：length 0 + 'IEND' + CRC（内容固定）。 */
const PNG_IEND_CHUNK = Buffer.from([
	0,
	0,
	0,
	0,
	73,
	69,
	78,
	68,
	174,
	66,
	96,
	130
]);
/**
* PNG 完整性校验：signature（8 字节）+ 首个 chunk 是长度 13 的 IHDR
* （宽高均为正整数）+ 文件末尾 12 字节为完整 IEND chunk。
* 防「工具 exit 0 但只写出签名/截断 PNG」被当成可渲染图片。
* @param buf - 待校验的文件内容
* @returns 通过完整性校验时为 true
*/
function isCompletePng(buf) {
	if (buf.length < 45) return false;
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
	if (buf.readUInt32BE(8) !== 13) return false;
	if (buf.toString("latin1", 12, 16) !== "IHDR") return false;
	if (buf.readUInt32BE(16) === 0 || buf.readUInt32BE(20) === 0) return false;
	return buf.subarray(buf.length - PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK);
}
/**
* 依序尝试候选命令，首个产出有效 PNG 的候选返回其内容 Buffer；全部失败返回 null。
*
* 候选级隔离：每个候选把「执行 + 读回 + 校验」作为一体化尝试——先删除
* outputPath（不存在则忽略），再 execFile 要求 exit 0，readFile 读回后以
* isCompletePng 校验完整性（签名 + IHDR + IEND，截断 PNG 不算数）。
* 先删残片是为了避免前一候选留下的非空输出被后一候选
* （exit 0 但没写文件）误判为自己的产出。
*
* 全部失败时若 RIVET_DEBUG 非空，向 stderr 打一行带原因的调试输出
* （哪个工具、什么错误），避免静默降级不可观测。
*
* 注意：硬编码 PNG 校验的前提是两个调用方（toPngCandidates / resizeCandidates）
* 的产出都是 PNG；未来若接入其他输出格式需放宽此校验。
* @param candidates - 依序尝试的候选命令
* @param outputPath - 各候选约定写出的 PNG 路径（每次尝试前先删残片）
* @param timeoutMs - 单个候选的执行超时（默认 15000ms）
* @returns 首个有效 PNG 的内容；全部候选失败返回 null
*/
async function runImageTool(candidates, outputPath, timeoutMs = 15e3) {
	let lastFailure = null;
	for (const { bin, args } of candidates) try {
		await rm(outputPath, { force: true });
		await execFileAsync$2(bin, args, {
			timeout: timeoutMs,
			windowsHide: true
		});
		const out = await readFile(outputPath);
		if (isCompletePng(out)) return out;
		lastFailure = `${bin}: exit 0 但未产出完整 PNG`;
	} catch (err) {
		lastFailure = `${bin}: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (lastFailure && process.env["RIVET_DEBUG"]) console.error(`[image-tool] 全部 ${candidates.length} 个候选失败，最后一次：${lastFailure}`);
	return null;
}
/**
* 创建本次转换的独立临时目录，并顺手触发惰性清扫（fire-and-forget）。
* @returns 新建临时目录的绝对路径
*/
async function makeImageTempDir() {
	sweepStaleImageTempDirs().catch(() => {});
	return mkdtemp(join(tmpdir(), IMAGE_TEMP_DIR_PREFIX));
}
/**
* 删除转换临时目录；失败静默。
* @param dir - makeImageTempDir 返回的目录路径
*/
async function removeImageTempDir(dir) {
	await rm(dir, {
		recursive: true,
		force: true
	}).catch(() => {});
}
/**
* 清扫超过 1 小时的残留临时目录（进程中断的兜底回收）。
* @param now - 判定陈旧的基准时间戳（默认 Date.now()，可注入用于测试）
*/
async function sweepStaleImageTempDirs(now = Date.now()) {
	let entries;
	try {
		entries = await readdir(tmpdir());
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith("rivet-imgtool-")) continue;
		const full = join(tmpdir(), entry);
		try {
			if (now - (await stat(full)).mtimeMs > STALE_MS) await rm(full, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
//#endregion
//#region lib/types/engine/image-attach.js
/**
* TUI image attachment loader — turns an on-disk image path into a base64 data URL
* suitable for the vision model pipeline.
*
* Terminals can only bracketed-paste text, so users paste an image file path; this
* module reads the file, validates the format, and adaptively compresses it so the
* payload stays under the server cap while the resolution stays as high as possible.
*
* 自适应压缩（对齐 opencode-tui desktop 的 compressImageSafe 语义，Node 侧以系统
* 工具实现）：只在超限时压缩；压缩是三级渐进，每级从原图重新编码（不链式再压，
* 避免累积失真）：
*   1. 长边 ≤ maxEdge（默认 1568）：PNG 源保透明输出 PNG，其余格式转 JPEG 0.82
*      （同时完成 provider 白名单转码，BMP/TIFF 等不再原样外发）；
*   2. 仍超限 → JPEG 0.55 同分辨率；
*   3. 仍超限 → 长边 ≤ 1024 + JPEG 0.55。
* 所有档位只缩不放（sips -Z / magick `>` 语义），小图原样发送。
* 压缩成功后可零工具解析出实际宽高（PNG IHDR / JPEG SOF），供气泡展示。
*/
/** Provider cap: 3.5 MB decoded per image。对齐宿主 attachment-local 单图准入
*  默认（rc.8 由 5MB 收紧至 3.5MB，含 base64 膨胀后仍在 5MB 路由检查内）——
*  本地预算高于准入会让原样放行的图被附件存储拒绝。 */
const MAX_IMAGE_BYTES = Math.floor(3670016);
/** Long-edge clamp. 1568px keeps token cost bounded while staying legible. */
const MAX_EDGE = 1568;
/** Max number of images per prompt (matches desktop Composer). */
const MAX_IMAGES = 4;
/** JPEG quality for the first compression tier. */
const JPEG_QUALITY = 82;
/** Fallback JPEG quality when the first tier's output still exceeds the cap. */
const FALLBACK_QUALITY = 55;
/** Fallback long edge when quality reduction alone is not enough. */
const FALLBACK_EDGE = 1024;
const IMAGE_MIMES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".bmp": "image/bmp"
};
let _runner = null;
/** 注入/清除测试 runner（null 恢复真实 runImageTool）。 */
function setImageToolRunner(runner) {
	_runner = runner;
}
/** 执行候选命令链：测试注入优先，否则走真实系统工具。 */
function runCandidates(candidates, outputPath) {
	return _runner ? _runner(candidates, outputPath) : runImageTool(candidates, outputPath);
}
/**
* 从图片头部解析宽高（零工具调用）：PNG 读 IHDR（偏移 16/20，big-endian），
* JPEG 扫描 SOF0/1/2 段标记（排除 DHT/DAC/JPG 干扰标记）。解析失败返回 null
* （不阻塞发送——宽高只是展示信息）。
* @param buf - 图片内容（至少包含头部）
* @param mime - 图片 MIME（决定解析分支）
* @returns 宽高；无法解析返回 null
*/
function probeImageSize(buf, mime) {
	if (mime === "image/png") {
		if (buf.length < 24) return null;
		const width = buf.readUInt32BE(16);
		const height = buf.readUInt32BE(20);
		if (width === 0 || height === 0) return null;
		return {
			width,
			height
		};
	}
	if (mime === "image/jpeg") {
		let i = 2;
		while (i + 8 < buf.length) {
			if (buf[i] !== 255) {
				i += 1;
				continue;
			}
			const marker = buf[i + 1];
			if (marker === void 0) return null;
			if (marker === 216 || marker === 217 || marker === 1 || marker === 255) {
				i += 2;
				continue;
			}
			const len = buf.readUInt16BE(i + 2);
			if (len < 2 || i + 2 + len > buf.length) return null;
			if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
				if (len < 8) return null;
				const height = buf.readUInt16BE(i + 5);
				const width = buf.readUInt16BE(i + 7);
				if (width === 0 || height === 0) return null;
				return {
					width,
					height
				};
			}
			i += 2 + len;
		}
		return null;
	}
	return null;
}
/** 按 keepPng/maxEdge/quality 生成候选并执行，返回首个产出；工具全部失败返回 null。 */
async function tryCompress(inPath, dir, keepPng, maxEdge, quality) {
	const outPath = join(dir, keepPng ? "out.png" : "out.jpg");
	return runCandidates(keepPng ? resizeCandidates(inPath, outPath, maxEdge) : resizeJpegCandidates(inPath, outPath, maxEdge, quality), outPath);
}
/**
* 三级自适应压缩，直到字节 ≤ maxBytes。每级从原图重编码。
* @returns 命中预算的输出与格式；无可用图像工具（候选全部失败）返回 null。
* @throws 有工具但三级全部超限——错误带最后一级的实际大小。
*/
async function compressToBudget(absolutePath, dir, maxEdge, maxBytes, sourceMime) {
	const attempts = [
		{
			keepPng: sourceMime === "image/png",
			edge: maxEdge,
			quality: 82
		},
		{
			keepPng: false,
			edge: maxEdge,
			quality: 55
		},
		{
			keepPng: false,
			edge: Math.min(maxEdge, FALLBACK_EDGE),
			quality: 55
		}
	];
	let last = null;
	for (const attempt of attempts) {
		const out = await tryCompress(absolutePath, dir, attempt.keepPng, attempt.edge, attempt.quality);
		if (out === null) return null;
		last = out;
		if (out.length <= maxBytes) return {
			buf: out,
			mime: attempt.keepPng ? "image/png" : "image/jpeg"
		};
	}
	const mb = ((last?.length ?? 0) / 1048576).toFixed(1);
	throw new Error(`图片压缩后仍超过上限（${mb} MB），请改用更小的源图`);
}
/**
* 仅按 magic bytes 识别 MIME；不识别即返回 null。
* 不做扩展名 fallback——真实图片（png/jpeg/webp/gif/tiff/bmp）都有可靠 magic，
* 任意内容改名 .png 不应进入转码流程。保留 filePath 参数仅为兼容既有调用签名。
* @param buf - 文件内容（至少前 12 字节参与识别）
* @param _filePath - 未使用；仅为兼容既有调用签名保留
* @returns 识别出的 MIME；无法识别返回 null
*/
function detectImageMime(buf, _filePath) {
	if (buf.length >= 8) {
		if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
		if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
		if (buf.length >= 12 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) return "image/webp";
		if (buf[0] === 71 && buf[1] === 73 && buf[2] === 70) return "image/gif";
		if (buf[0] === 73 && buf[1] === 73 && buf[2] === 42 && buf[3] === 0 || buf[0] === 77 && buf[1] === 77 && buf[2] === 0 && buf[3] === 42) return "image/tiff";
		if (buf[0] === 66 && buf[1] === 77) return "image/bmp";
	}
	return null;
}
/**
* 按文件扩展名判断文本是否像受支持的图片路径（仅粗筛，真实格式以 magic bytes 为准）。
* @param text - 待判断的路径文本（首尾空白会被忽略）
* @returns 扩展名命中受支持图片格式时为 true
*/
function looksLikeImagePath(text) {
	return extname(text.trim()).toLowerCase() in IMAGE_MIMES;
}
/** 组装附件：data URL + 头部解析宽高（解析失败省略宽高，不阻塞发送）。 */
function toAttachment(buf, mime, name) {
	const size = probeImageSize(buf, mime);
	return {
		dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
		mime,
		name,
		...size === null ? {} : {
			width: size.width,
			height: size.height
		}
	};
}
/**
* Load an image from disk and return it as a base64 data URL.
*
* - Validates format by magic bytes (no extension fallback).
* - Rejects unsupported formats.
* - If the decoded file exceeds maxBytes, adaptively compresses it: 1568px
*   (PNG keeps transparency) → JPEG 0.55 → 1024px + 0.55, never upscaling.
* @param absolutePath - 图片文件的绝对路径
* @param options - maxBytes/maxEdge 上限覆盖
* @returns 图片附件（data URL + MIME + 文件名 + 压缩后的宽高）；格式不支持抛错
* @throws 无可用图像工具，或压缩后仍超限（错误信息区分两种原因）
*/
async function loadImageAttachment(absolutePath, options = {}) {
	const maxBytes = options.maxBytes ?? 3670016;
	const maxEdge = options.maxEdge ?? 1568;
	const raw = await readFile(absolutePath);
	const mime = detectImageMime(raw, absolutePath);
	if (!mime) throw new Error(`Unsupported image format: ${absolutePath}`);
	if (raw.length <= maxBytes) return toAttachment(raw, mime, basename(absolutePath));
	const dir = await makeImageTempDir();
	try {
		const result = await compressToBudget(absolutePath, dir, maxEdge, maxBytes, mime);
		if (result === null) throw new Error("Image too large and no image tool produced output. Install an image tool (sips on macOS, ImageMagick on Linux/Windows) to compress.");
		return toAttachment(result.buf, result.mime, basename(absolutePath));
	} finally {
		await removeImageTempDir(dir);
	}
}
/**
* 剪贴板位图的附件化入口：与文件路径走同一条预算管线。
*
* 修复的缺口：剪贴板路径原先直接拼 dataUrl，不做过限压缩——超限大图能挂上
* （📎 有显示）却在提交时被 normalizeSubmitImages 静默丢弃。此处把位图落临时
* 文件后复用 {@link loadImageAttachment} 的全部语义（magic 校验、原样直发、
* 三级自适应压缩），两条入口不再分叉。
* @param buf - 剪贴板位图字节。
* @param name - 附件名（显示与诊断用，如 `clipboard.png`）。
* @param options - maxBytes/maxEdge 上限覆盖。
* @returns 图片附件（超限时为压缩后的 data URL）。
* @throws 格式不支持、无可用图像工具，或压缩后仍超限（错误信息区分原因）。
*/
async function loadClipboardImageAttachment(buf, name, options = {}) {
	const mime = detectImageMime(buf, name);
	if (mime === null) throw new Error(`Unsupported image format: ${name}`);
	const maxBytes = options.maxBytes ?? 3670016;
	if (buf.length <= maxBytes) return toAttachment(buf, mime, name);
	const dir = await makeImageTempDir();
	try {
		const ext = Object.entries(IMAGE_MIMES).find(([, value]) => value === mime)?.[0] ?? ".png";
		const source = join(dir, `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
		await writeFile(source, buf);
		const result = await compressToBudget(source, dir, options.maxEdge ?? 1568, maxBytes, mime);
		if (result === null) throw new Error("Image too large and no image tool produced output. Install an image tool (sips on macOS, ImageMagick on Linux/Windows) to compress.");
		return toAttachment(result.buf, result.mime, name);
	} finally {
		await removeImageTempDir(dir);
	}
}
//#endregion
//#region lib/types/engine/clipboard-image.js
/**
* Clipboard image reader — reads image data from the system clipboard.
*
* 平台 shell 命令路径（osascript / wl-paste / xclip / PowerShell）+ 测试注入点。
* opencode-tui 上游的 native（@mariozechner/clipboard）路径未移植：dsh 未声明该
* 依赖，动态导入恒失败只会留下死代码；未来引入依赖时按 git 历史恢复即可。
*
* 可测试性设计：setClipboardReader() 注入 mock（单元测试）；tryShellClipboard()
* 接受可注入的 execFile/platform/readFile/tmpdir/randomUUID（shell 路径测试）。
*/
const execFileAsync$1 = promisify(execFile);
/**
* 读系统剪贴板图片；无图或读取失败返回 null（调用方据此 fallback 到文本）。
* 优先测试注入 reader，否则走平台 shell 命令链。
* @returns 剪贴板图片；无图/失败/不支持时为 null
*/
async function readImageFromClipboard() {
	return tryShellClipboard();
}
/**
* 读系统剪贴板文本（Ctrl+V 无图时的 fallback；部分终端不经 bracketed paste
* 传递粘贴文本）。各平台优先 pbpaste / wl-paste / xclip / PowerShell。
* @returns 剪贴板文本；无工具或失败时 null
*/
async function readTextFromClipboard() {
	const pf = process.platform;
	try {
		if (pf === "darwin") return (await execFileAsync$1("pbpaste", [], {
			timeout: 5e3,
			maxBuffer: 1048576,
			windowsHide: true
		})).stdout;
		if (pf === "linux") try {
			return (await execFileAsync$1("wl-paste", [], {
				timeout: 5e3,
				maxBuffer: 1048576,
				windowsHide: true
			})).stdout;
		} catch {
			return (await execFileAsync$1("xclip", [
				"-selection",
				"clipboard",
				"-o"
			], {
				timeout: 5e3,
				maxBuffer: 1048576,
				windowsHide: true
			})).stdout;
		}
		if (pf === "win32") return (await execFileAsync$1("powershell", [
			"-NoProfile",
			"-Command",
			"Get-Clipboard"
		], {
			timeout: 5e3,
			maxBuffer: 1048576,
			windowsHide: true
		})).stdout;
	} catch {}
	return null;
}
/**
* 平台 shell 剪贴板读图链：darwin osascript / linux wl-paste+xclip / win32
* PowerShell。任一步失败静默降级到下一个平台分支；全部失败返回 null。
* @param opts - 注入参数（缺省用真实 execFile/平台/fs/os）
* @returns 剪贴板图片；不可用时 null
*/
async function tryShellClipboard(opts) {
	const ef = opts?.execFile ?? (async (bin, args) => {
		const r = await execFileAsync$1(bin, args, {
			timeout: 15e3,
			maxBuffer: 52428800,
			encoding: "latin1",
			windowsHide: true
		});
		return {
			stdout: r.stdout,
			stderr: r.stderr
		};
	});
	const pf = opts?.platform ?? process.platform;
	const rf = opts?.readFile ?? (async (p) => {
		const raw = await readFile(p);
		return Buffer.from(raw);
	});
	const td = opts?.tmpdir ?? tmpdir();
	const uuid = opts?.randomUUID ?? randomUUID;
	try {
		if (pf === "darwin") return await tryMacOSClipboard(ef, rf, td, uuid);
		if (pf === "linux") return await tryLinuxClipboard(ef);
		if (pf === "win32") return await tryWindowsClipboard(ef, rf, td, uuid);
	} catch {}
	return null;
}
async function tryMacOSClipboard(ef, rf, td, uuid) {
	let info;
	try {
		info = (await ef("osascript", ["-e", "clipboard info"])).stdout;
	} catch {
		return null;
	}
	if (!info.includes("«class PNG»") && !info.includes("«class jp2»") && !info.includes("TIFF picture") && !info.includes("GIF picture")) return null;
	let imageClass = "«class PNG»";
	if (info.includes("«class PNG»")) imageClass = "«class PNG»";
	else if (info.includes("TIFF picture")) imageClass = "TIFF picture";
	else if (info.includes("GIF picture")) imageClass = "GIF picture";
	const tmpPath = `${td}/rivet-clip-${uuid()}.png`;
	try {
		await ef("osascript", [
			"-e",
			`set theFile to (open for access POSIX file "${tmpPath}" with write permission)`,
			"-e",
			"set eof of theFile to 0",
			"-e",
			`write (the clipboard as ${imageClass}) to theFile`,
			"-e",
			"close access theFile"
		]);
		const buf = await rf(tmpPath);
		if (buf.length === 0) return null;
		const mime = detectImageMime(buf, "clipboard.png");
		if (mime === "image/tiff" || mime === "image/bmp") {
			const pngBuf = await convertToPng(tmpPath, ef, td, uuid);
			if (pngBuf) return bufToClipboardImage(pngBuf, "clipboard.png");
		}
		return bufToClipboardImage(buf, "clipboard.png");
	} catch {
		return null;
	} finally {
		await unlink(tmpPath).catch(() => {});
	}
}
async function tryLinuxClipboard(ef) {
	for (const [bin, args] of [["wl-paste", ["-t", "image/png"]], ["xclip", [
		"-selection",
		"clipboard",
		"-t",
		"image/png",
		"-o"
	]]]) try {
		const r = await ef(bin, args);
		if (!r.stdout || r.stdout.length === 0) continue;
		const buf = Buffer.from(r.stdout, "latin1");
		if (buf.length === 0) continue;
		return bufToClipboardImage(buf, "clipboard.png");
	} catch {}
	return null;
}
async function tryWindowsClipboard(ef, rf, td, uuid) {
	const tmpPath = `${td}\\rivet-clip-${uuid()}.png`;
	try {
		await ef("powershell", [
			"-NoProfile",
			"-Command",
			`
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }
else { exit 1 }
`.trim()
		]);
		const buf = await rf(tmpPath);
		if (buf.length === 0) return null;
		return bufToClipboardImage(buf, "clipboard.png");
	} catch {
		return null;
	} finally {
		await unlink(tmpPath).catch(() => {});
	}
}
/** TIFF/BMP 经 macOS sips 转 PNG；失败返回 null。 */
async function convertToPng(srcPath, ef, td, uuid) {
	if (process.platform !== "darwin") return null;
	const pngPath = `${td}/rivet-clip-${uuid()}.png`;
	try {
		await ef("sips", [
			"-s",
			"format",
			"png",
			srcPath,
			"--out",
			pngPath
		]);
		const { readFile } = await import("node:fs/promises");
		const pngBuf = await readFile(pngPath);
		return pngBuf.length > 0 ? pngBuf : null;
	} catch {
		return null;
	} finally {
		const { unlink } = await import("node:fs/promises");
		await unlink(pngPath).catch(() => {});
	}
}
function bufToClipboardImage(buf, name) {
	const mime = detectImageMime(buf, name) ?? "image/png";
	return {
		dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
		mime,
		name,
		source: mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : "image"
	};
}
//#endregion
//#region lib/types/startup-defaults.js
/**
* startup-defaults — 会话应用 vs 启动默认的纯函数面。
*
* 选择器 Enter / 带参命令 = 仅本会话；选择器 S / 末尾 default = 写启动默认。
* 回显必须点名「本会话」或「启动默认」，避免用户分不清。
*
* @module @huiliyi37/dsh-tianshu-tui/startup-defaults
*/
/** 剥末尾 default 标志：`/theme paper default` → rest=paper persist=true。 */
function splitDefaultFlag(text) {
	const trimmed = text.trim();
	if (trimmed === "") return {
		rest: "",
		persist: false
	};
	if (trimmed === "default") return {
		rest: "",
		persist: true
	};
	if (trimmed.endsWith(" default")) return {
		rest: trimmed.slice(0, -8).trim(),
		persist: true
	};
	return {
		rest: trimmed,
		persist: false
	};
}
const SESSION_HINT = {
	theme: "/theme default",
	model: "/model default",
	effort: "/effort default",
	density: "/density default",
	preset: "/preset default",
	vim: "/vim default"
};
const SESSION_VERB = {
	theme: (value) => `主题已切换: ${value}`,
	model: (value) => `模型已切换: ${value}`,
	effort: (value) => `推理等级已设为 ${value}`,
	density: (value) => `已切换为${value}`,
	preset: (value) => `已切换为 ${value}`,
	vim: (value) => `vim 键位已${value === "off" ? "关闭" : "开启"}: ${value}`
};
const DEFAULT_LABEL = {
	theme: "主题",
	model: "模型",
	effort: "推理等级",
	density: "密度",
	preset: "预设",
	vim: "vim 键位"
};
/** 仅本会话回显：点名本会话 + 如何写默认。 */
function echoSessionOnly(kind, value) {
	const hint = kind === "density" || kind === "preset" ? SESSION_HINT[kind] : `选择器按 S 或 ${SESSION_HINT[kind]}`;
	return `${SESSION_VERB[kind](value)}（仅本会话）。${hint} 可设为启动默认`;
}
/** /effort 选择：auto 清除 reasoningEffort。 */
function effortSelection(base, level) {
	return level === "auto" ? {
		provider: base.provider,
		model: base.model
	} : {
		provider: base.provider,
		model: base.model,
		reasoningEffort: level
	};
}
/** 写启动默认回显：主题说重启，其余说新会话。 */
function echoSavedDefault(kind, value) {
	const when = kind === "theme" || kind === "density" || kind === "vim" ? "重启后仍生效" : "新会话起始生效";
	return `已设为默认${DEFAULT_LABEL[kind]}：${value}（${when}）`;
}
//#endregion
//#region lib/types/adapter/preset-join.js
/**
* preset-join — 在 agents.create / resume 的 setup 里加入官方预设面。
*
* 不 import dsh-agent-presets：经 reflect.get 读花名册。无服务则跳过
* （单测 / 未装配宿主）。生产 bundle 会挂上 agent-presets。
*
* @module @huiliyi37/dsh-tianshu-tui/adapter/preset-join
*/
/** 从 host ctx 取花名册；无 mount 视为未装配。 */
function presetJoinFacet(ctx) {
	const raw = ctx.reflect?.get("agentPresets", false);
	if (raw == null || typeof raw !== "object") return void 0;
	const facet = raw;
	if (typeof facet.mount !== "function") return void 0;
	return facet;
}
/** create/resume 未指定预设时的缺省 id（#48：与 bundle patch 的 config.default 对齐；旧装配/旧 host 忽略该键时由插件侧兜底）。 */
const DEFAULT_PRESET_ID = "standard";
function mountId(preferredId, mode) {
	if (preferredId !== void 0 && preferredId !== "") return preferredId;
	return mode === "child" ? void 0 : DEFAULT_PRESET_ID;
}
/**
* 按模式加入预设面。无花名册 skipped。
* create/resume：mount（未指定 id 时缺省 {@link DEFAULT_PRESET_ID}）。
* child：先 composeFrom，父未 join 再 mount。
*/
async function joinPreset(input) {
	const { facet, agentCtx, mode } = input;
	if (facet == null) return { skipped: true };
	if (mode === "child" && input.parentCtx !== void 0 && typeof facet.composeFrom === "function") {
		const inherited = facet.composeFrom(agentCtx, input.parentCtx);
		if (inherited !== void 0 && inherited !== "") return {
			skipped: false,
			id: inherited
		};
	}
	return {
		skipped: false,
		id: (await facet.mount(agentCtx, mountId(input.preferredId, mode))).id
	};
}
/** newSession setup：mount prefs/default；失败回 warn，不阻断铸造。 */
async function joinCreateOrWarn(ctx, agentCtx, preferredId, warn) {
	const facet = presetJoinFacet(ctx);
	if (facet === void 0) {
		warn("⚠ agent-presets 未装配：本会话没有工具面。请重跑安装命令更新装配（dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui）");
		return;
	}
	try {
		return (await joinPreset({
			facet,
			agentCtx,
			mode: "create",
			preferredId
		})).id;
	} catch (error) {
		warn(`⚠ 启动默认预设未生效: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
/** resume setup：按日志折出的 id mount。 */
async function joinResume(ctx, agentCtx, preferredId) {
	await joinPreset({
		facet: presetJoinFacet(ctx),
		agentCtx,
		mode: "resume",
		preferredId
	});
}
//#endregion
//#region lib/types/adapter/agent-scope-service.js
/**
* agent-scope-service — isolate 服务优先从当前 agent 的预设面读。
*
* 官方 standard 把 compact / planMode / workflowEngine 放进 isolate realm，
* host reflect.get 为 undefined。有花名册时走 serviceFor(agent, name)。
*
* @module @huiliyi37/dsh-tianshu-tui/adapter/agent-scope-service
*/
/** 读名为 name 的服务：agent isolate → host reflect。 */
function serviceForAgent(host, agent, name) {
	if (agent != null) {
		const isolated = (host.reflect?.get("agentPresets", false))?.serviceFor?.(agent, name);
		if (isolated !== void 0) return isolated;
	}
	return host.reflect?.get(name, false);
}
/** 按当前会话 id 取 agent，再读 isolate/host 服务。 */
function scopedService(host, sessionId, name) {
	return serviceForAgent(host, sessionId === null || host.agents === void 0 ? void 0 : host.agents.get(sessionId), name);
}
//#endregion
//#region lib/types/preset-surface.js
/**
* preset-surface — agent 预设展示面的纯投影（只读，不写回）。
*
* 数据源全部是日志事实：
* - preset 名：session.header.agentPreset（创建/初始值）+ `agent-preset/selected`
*   事件（blank 窗口切换值），等价宿主 dsh-agent-presets 的 resolveSessionPreset。
* - wire 工具面：`request/header` 快照是「最近一次请求实际使用的工具 schema」
*   （含 preset 过滤器作用后的最终面），经官方 `foldRequestHeader` 折叠。
*
* 纪律：本模块不重放任何 preset 插件的私有晋升逻辑（decidePromotion 是
* (日志 × 配置 × 代码版本) 的函数，配置与版本不在日志里）；只展示日志中
* 已经存在的事实，compaction 剪除后自然降级（无记录 ≠ 零值）。
*
* @module @deepseek-ai/dsh-tianshu-tui/preset-surface
*/
/**
* 会话当前 preset id：尾向找最后一个 `agent-preset/selected` 切换值，
* 无则回落 header 的创建值（官方 resolveSessionPreset 的等价 fold）。
* @param headerAgentPreset - session.header.agentPreset（创建值）。
* @param events - 会话事件日志（log 顺序）；undefined（无日志句柄）按无记录处理。
* @returns 当前 preset id；无任何记录返回 undefined。
*/
function resolvePresetId(headerAgentPreset, events) {
	if (events === void 0) return headerAgentPreset;
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event === void 0) continue;
		if (event.type === "agent-preset/selected") {
			const data = event.data;
			if (typeof data.agentPreset === "string" && data.agentPreset !== "") return data.agentPreset;
		}
	}
	return headerAgentPreset;
}
/**
* 最近一次请求的 wire 工具名集合（`request/header` 快照；含 preset 过滤器
* 作用后的最终面）。无 request/header 事件（尚未发请求）返回 undefined。
* @param events - 会话事件日志（log 顺序）；undefined（无日志句柄）按无快照处理。
* @returns 工具名数组（保持 schema 顺序）；无快照为 undefined。
*/
function wireToolNames(events) {
	if (events === void 0) return void 0;
	return foldRequestHeader(events)?.tools?.map((tool) => tool.name);
}
/**
* wire 工具面的展示文本：`[bash, str_replace_editor]` 形式。
* @param names - wireToolNames 的输出。
* @returns 方括号列表文本；undefined → undefined。
*/
function formatWireSurface(names) {
	if (names === void 0) return void 0;
	return `[${names.join(", ")}]`;
}
/**
* wire 工具面的保守阶段标签——只描述「最近一次请求的实际工具面形态」，
* 不宣称 preset 插件内部状态（晋升与否由插件决定，本模块无从读取）。
* @param names - wireToolNames 的输出。
* @returns 阶段标签；无法判定时 undefined。
*/
function wirePhaseLabel(names) {
	if (names === void 0 || names.length === 0) return void 0;
	const set = new Set(names);
	if ((set.has("bash") || set.has("pwsh") || set.has("powershell")) && set.has("str_replace_editor") && set.size === 2) return "锚定面";
	if (set.has("run_code")) return "PTC 面";
}
//#endregion
//#region lib/types/engine/route-key.js
/**
* provider/model 路由键解析（模型选择器行 value 与 /model 实参的同一文法）。
*
* 只按**首个**斜杠分割：模型 id 自身可含 `/`（OpenRouter 风格 id 如
* `stealth/ox-alpha`），而 provider 路由键不含。
*
* @module @deepseek-ai/dsh-tianshu-tui/engine/route-key
*/
/**
* 解析 `provider/model` 组合路由键。
* @param value - 组合键字符串。
* @returns 解析结果；任一侧为空（无斜杠、斜杠在首尾）时为 undefined。
*/
function parseRouteKey(value) {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash >= value.length - 1) return void 0;
	return {
		provider: value.slice(0, slash),
		model: value.slice(slash + 1)
	};
}
//#endregion
//#region lib/types/picker.js
/**
* picker — 交互式选择器 overlay（Issue #31：主题/模型/会话切换用上下键选择）。
*
* 纯状态机 + 渲染 + 控制器，与 command-palette 同构（OverlayRenderer 契约）。
* 打开时注入条目与确认回调；↑/↓ 移动、PageUp/PageDown 翻页、Enter 确认、
* S 设为默认（可选）、Esc/q 关闭。当前值条目带 ● 标记（current），启动默认
* 带 ★（isDefault），选中项 ▶ 高亮。
*
* 滚动窗口跟随选中（主题/模型/会话选择器均展示全部条目，↑/↓ 浏览）。
*
* @module @deepseek-ai/dsh-tianshu-tui/picker
*/
/** 分组头不可选。 */
function isPickerSelectable(item) {
	return item !== void 0 && item.header !== true;
}
/**
* 从 `from` 起找最近可选项（先下后上）；全是头时退回夹紧后的 from。
*/
function firstSelectableIndex(items, from = 0) {
	if (items.length === 0) return 0;
	const start = Math.max(0, Math.min(from, items.length - 1));
	for (let i = start; i < items.length; i++) if (isPickerSelectable(items[i])) return i;
	for (let i = start - 1; i >= 0; i--) if (isPickerSelectable(items[i])) return i;
	return start;
}
/**
* 按可选项跳 `delta` 步（头不计步）；到顶/底停在最近可选项。
*/
function nextSelectableIndex(items, from, delta) {
	if (items.length === 0) return 0;
	if (delta === 0) return firstSelectableIndex(items, from);
	const step = delta > 0 ? 1 : -1;
	const hops = Math.abs(delta);
	let i = Math.max(0, Math.min(from, items.length - 1));
	let moved = 0;
	while (moved < hops) {
		const next = i + step;
		if (next < 0 || next >= items.length) break;
		i = next;
		if (isPickerSelectable(items[i])) moved++;
	}
	return isPickerSelectable(items[i]) ? i : firstSelectableIndex(items, i);
}
/** 初始状态（关闭、选中 0、空标题）。 */
function emptyPickerState() {
	return {
		open: false,
		selected: 0,
		title: ""
	};
}
/**
* 折叠一个事件进入选择器状态（纯函数）：open 重置选中、move 在 [0, count-1]
* 内夹紧（0 条时选中归 0）。
* @param state - 当前状态。
* @param event - 输入事件。
* @returns 新状态。
*/
function applyPickerEvent(state, event) {
	switch (event.type) {
		case "open": return {
			...state,
			open: true,
			selected: 0,
			title: event.title
		};
		case "close": return {
			...state,
			open: false
		};
		case "move": {
			const maxIndex = Math.max(0, event.count - 1);
			const next = state.selected + event.delta;
			return {
				...state,
				selected: Math.max(0, Math.min(next, maxIndex))
			};
		}
	}
}
/**
* overlay 渲染：标题 + 条目（选中 ▶ 高亮、当前 ● 标记、宽度截断）+ 底部
* 键位提示；滚动窗口跟随选中。
* @param state - 选择器状态（取 title/selected）。
* @param items - 全部条目。
* @param width - 可用显示宽度（条目按此截断）。
* @param height - 可用行数（头尾各占一行，其余给条目窗口）。
* @param theme - 主题（取语义色）。
* @returns 渲染行数组（含 ANSI）。
*/
function renderPicker(state, items, width, height, theme, opts) {
	const lines = [color(state.title, theme.brandColor, { bold: true })];
	if (items.length === 0) lines.push(color("（无选项）", theme.muted));
	else {
		const bodyHeight = Math.max(1, height - 2);
		const sel = Math.max(0, Math.min(state.selected, items.length - 1));
		const start = Math.max(0, sel - bodyHeight + 1);
		const window = items.slice(start, start + bodyHeight);
		for (let i = 0; i < window.length; i++) {
			const item = window[i];
			/* v8 ignore next 1 -- unreachable: window 来自 items.slice()，元素恒非 undefined */
			if (item === void 0) continue;
			if (item.header === true) {
				lines.push(color(truncate$3(item.label, width), theme.muted));
				continue;
			}
			const isSel = start + i === sel;
			const marker = `${item.current === true ? " ●" : ""}${item.isDefault === true ? " ★" : ""}`;
			const clipped = truncate$3(`${isSel ? "▶ " : "  "}${item.label}${marker}`, width);
			lines.push(isSel ? color(clipped, theme.primary, { bold: true }) : color(clipped, theme.dim));
		}
	}
	const footer = opts?.saveDefault === true ? "↑↓ 选择 · Enter 应用（本会话） · S 设为默认 · Esc 关闭" : "↑↓ 选择 · Enter 确认 · Esc 关闭";
	lines.push(color(footer, theme.muted));
	return lines;
}
function truncate$3(text, width) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > width) break;
		out += ch;
	}
	return out;
}
/**
* 选择器控制器：open/close/move/commit，实现 OverlayRenderer 契约。
* 条目与确认回调在 open 时注入（每次打开重建）。
*/
var PickerController = class {
	state = emptyPickerState();
	items = [];
	onCommit = null;
	onPreview = null;
	onCancel = null;
	onSaveDefault = null;
	getTheme;
	constructor(opts) {
		this.getTheme = opts.getTheme;
	}
	/** 选择器是否打开。 */
	isOpen() {
		return this.state.open;
	}
	/**
	* 打开选择器：注入条目、确认回调与可选预览/取消回调，选中可指定（缺省 0）。
	* @param title - 面板标题。
	* @param items - 条目列表。
	* @param commit - 确认回调（Enter 时以选中条目调用）。
	* @param selectedIndex - 初始选中下标（缺省 0）。
	* @param hooks - 可选：onPreview（选中变化时调用，实时预览）；
	*   onCancel（Esc/q 关闭时调用，还原预览）；
	*   onSaveDefault（S 设为默认，确认路径不走 onCancel）。
	*/
	open(title, items, commit, selectedIndex, hooks) {
		this.items = [...items];
		this.onCommit = commit;
		this.onPreview = hooks?.onPreview ?? null;
		this.onCancel = hooks?.onCancel ?? null;
		this.onSaveDefault = hooks?.onSaveDefault ?? null;
		this.state = applyPickerEvent(this.state, {
			type: "open",
			title
		});
		const target = firstSelectableIndex(this.items, selectedIndex ?? 0);
		if (target !== this.state.selected) this.state = {
			...this.state,
			selected: target
		};
	}
	/** 关闭选择器（Esc/q 路径；触发 onCancel 还原预览；保留条目，下次 open 重建）。 */
	close() {
		const cancel = this.onCancel;
		this.onCancel = null;
		this.onCommit = null;
		this.onPreview = null;
		this.onSaveDefault = null;
		this.state = applyPickerEvent(this.state, { type: "close" });
		if (cancel !== null) cancel();
	}
	/**
	* 移动选中项（夹紧在条目范围内）；选中变化时触发 onPreview（实时预览）。
	* @param delta - 移动量（负上正下）。
	*/
	move(delta) {
		const next = nextSelectableIndex(this.items, this.state.selected, delta);
		this.state = {
			...this.state,
			selected: next
		};
		const item = this.selected;
		if (item !== void 0 && this.onPreview !== null) this.onPreview(item);
	}
	/** 当前选中条目（越界返回 undefined）。 */
	get selected() {
		return this.items[this.state.selected];
	}
	/** 当前条目数。 */
	get count() {
		return this.items.length;
	}
	/**
	* 确认当前选中项：以选中条目调用注入的确认回调并关闭；无选中或未注入
	* 回调时不动作。确认路径不触发 onCancel（预览已由确认落定，无需还原）。
	*/
	commit() {
		const item = this.selected;
		if (!isPickerSelectable(item)) return;
		const cb = this.onCommit;
		this.onCancel = null;
		this.onCommit = null;
		this.onPreview = null;
		this.onSaveDefault = null;
		this.state = applyPickerEvent(this.state, { type: "close" });
		if (cb !== null) cb(item);
	}
	/** 是否注入了 S 设为默认钩子（键路由据此决定是否消费 s/S）。 */
	canSaveDefault() {
		return this.onSaveDefault !== null;
	}
	/**
	* 键位路由（scroll-pager 范式收敛；装配方只做 activate/deactivate/rerender）：
	* Esc/Ctrl+C/q → close（触发 onCancel 还原预览）；↑↓/jk 移动、PageUp/PageDown
	* 翻页 → handled；Enter commit → close；s/S 仅在注入 onSaveDefault 时
	* saveDefault → close（否则吞掉不动作——与原装配方分支门控一致）；
	* 其余键吞掉（overlay 独占焦点）。
	* @param name - 按键名。
	* @param char - 可打印字符（控制键为 ''）。
	* @returns close = 请求关闭；handled = 已消费。
	*/
	handleKey(name, char) {
		if (name === "escape" || name === "ctrl_c" || char === "q") {
			this.close();
			return "close";
		}
		if (name === "up" || char === "k") {
			this.move(-1);
			return "handled";
		}
		if (name === "down" || char === "j") {
			this.move(1);
			return "handled";
		}
		if (name === "pageup") {
			this.move(-10);
			return "handled";
		}
		if (name === "pagedown") {
			this.move(10);
			return "handled";
		}
		if (name === "return") {
			this.commit();
			return "close";
		}
		if ((char === "s" || char === "S") && this.canSaveDefault()) {
			this.saveDefault();
			return "close";
		}
		return "handled";
	}
	/**
	* 设为启动默认：以选中条目调用 onSaveDefault 并关闭；无钩子或无选中时
	* 不动作（选择器保持打开）。确认路径不触发 onCancel。
	*/
	saveDefault() {
		if (this.onSaveDefault === null) return;
		const item = this.selected;
		if (!isPickerSelectable(item)) return;
		const cb = this.onSaveDefault;
		this.onCancel = null;
		this.onCommit = null;
		this.onPreview = null;
		this.onSaveDefault = null;
		this.state = applyPickerEvent(this.state, { type: "close" });
		cb(item);
	}
	/**
	* OverlayRenderer 契约：render(width, height) → string[]。
	* @param width - 可用显示宽度。
	* @param height - 可用行数。
	* @returns 渲染行数组（含 ANSI）。
	*/
	render(width, height) {
		return renderPicker(this.state, this.items, width, height, this.getTheme(), { saveDefault: this.onSaveDefault !== null });
	}
};
//#endregion
//#region lib/types/ui/startup-pickers.js
/**
* startup-pickers — /model /theme /effort 选择器：Enter 本会话、S 写默认。
*
* @module @huiliyi37/dsh-tianshu-tui/ui/startup-pickers
*/
/** 打开模型选择器：Enter 热切本会话，S 写宿主默认。 */
async function openModelPicker(host) {
	const { overlay, picker } = host;
	if (overlay === null || picker === null) return;
	if (host.llm === void 0) {
		host.echoWarn("⚠ llm 服务不可用（未装配 llm 插件），模型选择器不可用", "/key 配置");
		return;
	}
	const currentKey = host.current === void 0 ? null : `${host.current.provider}/${host.current.model}`;
	const savedKey = host.savedKey ?? null;
	const items = [];
	let selectedIndex = 0;
	for (const provider of host.llm.listProviders()) {
		const models = await host.llm.listModels(provider.id).catch(() => []);
		for (const model of models) {
			const key = `${provider.id}/${model.id}`;
			const item = {
				label: key === currentKey ? `${key}（当前）` : key,
				value: key,
				current: key === currentKey,
				isDefault: key === savedKey
			};
			if (key === currentKey) selectedIndex = items.length;
			items.push(item);
		}
	}
	if (items.length === 0) {
		host.echoWarn("⚠ 无可用模型（llm 目录为空），模型选择器不可用", "/key 配置");
		return;
	}
	const apply = (item, persist) => {
		const selection = parseRouteKey(item.value);
		if (selection === void 0) return;
		if (persist) host.applyDefault(selection);
		const hot = host.applySession(selection);
		const label = `${selection.provider}/${selection.model}`;
		host.commit(persist ? hot ? echoSavedDefault("model", label) : `${echoSavedDefault("model", label)}（当前会话不可热切）` : hot ? echoSessionOnly("model", label) : `模型已切换: ${label}（当前会话不可热切）。选择器按 S 或 /model default 可设为启动默认`);
	};
	picker.open("选择模型", items, (item) => {
		apply(item, false);
	}, selectedIndex, { onSaveDefault: (item) => {
		apply(item, true);
	} });
	overlay.activate("picker");
}
/** 打开主题选择器：预览即生效；Enter 不落盘，S 写 prefs。 */
function openThemePicker(host) {
	const { overlay, picker } = host;
	if (overlay === null || picker === null) return;
	const prev = getActiveThemeName();
	const allNames = [...THEME_NAMES, ...listCustomThemes().map((n) => `custom:${n}`)];
	const items = allNames.map((name) => ({
		label: name === prev ? `${name}（当前）` : name,
		value: name,
		current: name === prev,
		isDefault: name === host.savedTheme
	}));
	const selectedIndex = Math.max(0, allNames.indexOf(prev));
	const finish = (name, persist) => {
		if (persist) host.applyDefault(name);
		else setTheme(name);
		overlay.deactivate();
		host.rerenderHistory();
		host.commit(persist ? echoSavedDefault("theme", name) : echoSessionOnly("theme", name));
		host.flushLiveRender();
	};
	picker.open("选择主题", items, (item) => {
		finish(item.value, false);
	}, selectedIndex, {
		onPreview: (item) => {
			setTheme(item.value);
		},
		onCancel: () => {
			setTheme(prev);
		},
		onSaveDefault: (item) => {
			finish(item.value, true);
		}
	});
	overlay.activate("picker");
}
const EFFORT_ITEMS = [
	"off",
	"high",
	"max",
	"auto"
];
/** 打开推理等级选择器。 */
function openEffortPicker(host) {
	const { overlay, picker } = host;
	if (overlay === null || picker === null) return;
	const current = host.currentEffort ?? "auto";
	const saved = host.savedEffort ?? "auto";
	const items = EFFORT_ITEMS.map((level) => ({
		label: level === current ? `${level}（当前）` : level,
		value: level,
		current: level === current,
		isDefault: level === saved
	}));
	const selectedIndex = Math.max(0, EFFORT_ITEMS.indexOf(current));
	picker.open("选择推理等级", items, (item) => {
		host.apply(item.value, false);
	}, selectedIndex, { onSaveDefault: (item) => {
		host.apply(item.value, true);
	} });
	overlay.activate("picker");
}
//#endregion
//#region lib/types/engine/term-image.js
/**
* 终端内联图片渲染 — 把 data URL 图片准备/编码为 kitty / iTerm2 图形协议序列。
*
* 协议事实（与 detectImageProtocol 配套）：
* - kitty APC：`\x1B_G<control>;<base64 payload>\x1B\\`，仅支持 RGB/RGBA/PNG 载荷
*   （f=100 = PNG），非 PNG 需先转码。base64 必须按 ≤4096 字节分块，除末块外
*   长度须为 4 的倍数，用 m=1/0 标记。q=2 抑制终端响应，避免污染 stdin 解析。
*   同时给 c（列）和 r（行）时终端把图片缩放进该单元格矩形（保持宽高比），
*   放置后光标下移 r 行、停在图片右缘列——几何有界、位置确定，这是 live 区
*   锚点安全的前提；调用方随后输出 `\r` 回到行首。
* - iTerm2 OSC 1337：`\x1B]1337;File=inline=1;width=N;height=M:<base64>\x07`，
*   直接支持 png/jpeg/gif/webp，宽高以单元格计，preserveAspectRatio=1 下
*   图片适配进宽高超框，绘制后光标停在图片末行右缘；调用方随后输出 `\r\n`
*   把光标移到图片下方行首。
* 两种序列都会被不支持的终端静默忽略，因此检测失误的最坏结果是图片不显示。
*
* 安全边界：data URL 载荷在编码前必须通过严格 base64 校验（RFC 4648 字母表 +
* 合法 padding + 非空 + 长度 4 对齐），否则载荷里的 BEL/ESC/ST 可以提前终止
* OSC/APC 序列并向终端注入任意控制序列。
*/
/** kitty 协议单块 base64 上限（协议规定 ≤4096 且除末块外须为 4 的倍数）。 */
const KITTY_CHUNK = 4096;
/**
* 估算字符 cell 高宽比（≈2，主流等宽字体）。
* 只用于把 kitty 的 r 收紧到图片实际需要行数；估错只会留白或轻微缩放，
* 不影响正确性（光标移动行数以我们给出的 r 为准，与图片内容无关）。
*/
const CELL_ASPECT$1 = 2;
/** 编码白名单：两种协议合计可直接/可转换展示的 MIME。 */
const SUPPORTED_MIMES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/tiff",
	"image/bmp"
]);
const MIME_EXTS = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/tiff": ".tiff",
	"image/bmp": ".bmp"
};
/** RFC 4648 base64（标准字母表 + 合法 padding）。 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/**
* 解析并校验 data URL → { mime, b64 }。
* 拒绝：非 data URL、非白名单 MIME、空载荷、含控制字符/非法字符的载荷、
* 非法 padding、长度非 4 对齐、解码后超过 MAX_IMAGE_BYTES。
* @param dataUrl - `data:<mime>;base64,<payload>` 形式的字符串
* @returns 小写 MIME 与已校验的 base64 载荷；任一校验失败返回 null
*/
function parseImageDataUrl(dataUrl) {
	const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
	if (!m || m[1] === void 0 || m[2] === void 0) return null;
	const mime = m[1].toLowerCase();
	if (!SUPPORTED_MIMES.has(mime)) return null;
	const b64 = m[2];
	if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	if (b64.length * 3 / 4 - padding > 3670016) return null;
	return {
		mime,
		b64
	};
}
/** 从 PNG base64 解出 IHDR 宽高（解码前 33 字节即可）；非法 PNG 返回 null。 */
function pngDimensions(pngB64) {
	const head = Buffer.from(pngB64.slice(0, 44), "base64");
	if (head.length < 24 || head[0] !== 137 || head[1] !== 80 || head[2] !== 78 || head[3] !== 71) return null;
	const width = head.readUInt32BE(16);
	const height = head.readUInt32BE(20);
	if (width <= 0 || height <= 0) return null;
	return {
		width,
		height
	};
}
/**
* 非 PNG 转码为 PNG base64（kitty 协议只接受 PNG 容器）。
* 走共享图像工具执行器的平台感知候选（见 toPngCandidates），每次转换独立
* 临时目录；全部失败返回 null，调用方降级为文本占位。
*/
async function ensurePngBase64(mime, b64) {
	if (mime === "image/png") return b64;
	const dir = await makeImageTempDir();
	const inPath = join(dir, `in${MIME_EXTS[mime] ?? ".img"}`);
	const outPath = join(dir, "out.png");
	try {
		await writeFile(inPath, Buffer.from(b64, "base64"));
		const png = await runImageTool(toPngCandidates(inPath, outPath), outPath);
		if (!png) return null;
		return png.toString("base64");
	} finally {
		await removeImageTempDir(dir);
	}
}
/**
* data URL → 已备图片（慢速部分：校验 + 必要的 PNG 转码）。
* 在 commit 前异步完成；编码（快速、与终端尺寸相关）留到写入时进行，
* 使转码期间的终端 resize 不会用过期宽度编码。
* 返回 null 表示无法准备，调用方保持文本占位。
* @param dataUrl - 图片 data URL（经 parseImageDataUrl 校验）
* @param protocol - 目标终端图形协议（kitty 需 PNG，必要时转码）
* @returns 已备图片材料；校验或转码失败返回 null
*/
async function prepareTermImage(dataUrl, protocol) {
	const parsed = parseImageDataUrl(dataUrl);
	if (!parsed) return null;
	if (protocol === "iterm2" && (parsed.mime === "image/png" || parsed.mime === "image/jpeg" || parsed.mime === "image/gif" || parsed.mime === "image/webp")) return { b64: parsed.b64 };
	const png = await ensurePngBase64(parsed.mime, parsed.b64);
	if (!png) return null;
	const dims = pngDimensions(png);
	return dims ? {
		b64: png,
		pixelWidth: dims.width,
		pixelHeight: dims.height
	} : { b64: png };
}
/**
* iTerm2 OSC 1337 内联图片序列。宽高以单元格计，图片按比例适配进超框。
* @param b64 - 图片 base64 载荷（png/jpeg/gif/webp，须已通过校验）
* @param cols - 超框宽度（单元格列数）
* @param maxRows - 超框高度（单元格行数）
* @returns OSC 1337 转义序列（末尾不含换行）
*/
function encodeIterm2Image(b64, cols, maxRows) {
	return `\x1B]1337;File=inline=1;width=${cols};height=${maxRows};preserveAspectRatio=1:${b64}\x07`;
}
/**
* kitty APC 图形序列（f=100 PNG，分块直传，c×r 有界单元格矩形）。
* @param b64Png - PNG 图片的 base64 载荷（协议只接受 PNG 容器）
* @param cols - 放置矩形宽度（单元格列数）
* @param rows - 放置矩形高度（单元格行数）
* @returns 分块拼接的 APC 序列；空载荷返回 ''
*/
function encodeKittyImage(b64Png, cols, rows) {
	const chunks = [];
	for (let i = 0; i < b64Png.length; i += KITTY_CHUNK) chunks.push(b64Png.slice(i, i + KITTY_CHUNK));
	if (chunks.length === 0) return "";
	return chunks.map((chunk, i) => {
		const more = i < chunks.length - 1 ? 1 : 0;
		return `\x1B_G${i === 0 ? `a=T,f=100,q=2,c=${cols},r=${rows},m=${more}` : `q=2,m=${more}`};${chunk}\x1B\\`;
	}).join("");
}
/**
* 已备图片 → 终端图形序列。cols/maxRows 应在写入当刻取最新终端尺寸。
* kitty 用像素尺寸把 r 收紧到实际需要行数（受 maxRows 封顶），
* 拿不到尺寸时退回 maxRows（宁可留白，几何必须有界）。
* 序列末尾不含换行，由调用方控制光标。
* @param image - prepareTermImage 产出的已备图片
* @param protocol - 目标终端图形协议
* @param cols - 可用宽度（单元格列数，下限 10）
* @param maxRows - 高度上限（单元格行数，下限 1）
* @returns 终端图形序列；kitty 空载荷时为 ''
*/
function encodeTermImage(image, protocol, cols, maxRows) {
	const width = Math.max(10, cols);
	const rowCap = Math.max(1, maxRows);
	if (protocol === "iterm2") return encodeIterm2Image(image.b64, width, rowCap);
	let rows = rowCap;
	if (image.pixelWidth && image.pixelHeight) rows = Math.min(rowCap, Math.max(1, Math.ceil(image.pixelHeight / image.pixelWidth * (width / CELL_ASPECT$1))));
	return encodeKittyImage(image.b64, width, rows);
}
let prepareOverride = null;
/**
* 测试钩子：替换 prepare 实现（null 恢复真实实现）。
* @param fn - 替代的 prepare 实现；null 恢复真实实现
*/
function setTermImagePreparer(fn) {
	prepareOverride = fn;
}
/**
* app 层统一入口：走注入点后的 prepare。
* @param dataUrl - 图片 data URL
* @param protocol - 目标终端图形协议
* @returns 已备图片材料；无法准备时为 null
*/
async function prepareTermImageForCommit(dataUrl, protocol) {
	return (prepareOverride ?? prepareTermImage)(dataUrl, protocol);
}
//#endregion
//#region lib/types/adapter/transcript.js
/**
* Read-only transcript projection: derives a TUI-facing conversation view from
* the session log. The session log is the authoritative fact source; this
* module never appends to it and invents no new event vocabulary — every
* projected fact traces to one {@link SessionEvent} of the canonical
* {@link SessionEventMap}.
*
* Two layers: a pure, immutable fold (`emptyTranscript` / `applyTranscriptEvent`)
* that is trivially unit-testable, and a live subscription wrapper
* (`createTranscript`) that replays the session's existing log and then folds
* every `session/event` publication for that session.
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/transcript
*/
/**
* An empty transcript view for `sessionId`, before any event is folded.
* @param sessionId - 视图所属的会话 id。
* @returns 空消息/空工具、turn 与 seq 均为 -1 的初始视图。
*/
function emptyTranscript(sessionId) {
	return {
		sessionId,
		messages: [],
		streaming: void 0,
		tools: [],
		turn: -1,
		firstInTurnTime: void 0,
		seq: -1
	};
}
/** Fold the text-bearing blocks of a message's content into one display string. */
function foldText(content) {
	let out = "";
	for (const block of content) if (block.type === "text") out += block.text;
	return out;
}
/** Fold the reasoning blocks of a message's content into one display string (kept apart from text). */
function foldReasoning(content) {
	let out = "";
	for (const block of content) if (block.type === "reasoning") out += block.text;
	return out;
}
/**
* Fold one committed session event into the derived view. Returns a NEW view.
* @param view - 折叠前的视图（不被就地修改）。
* @param event - 已提交的会话事件。
* @returns 折叠后的新视图；与投影无关的事件只推进 seq 水位。
*/
function applyTranscriptEvent(view, event) {
	const base = {
		...view,
		seq: event.seq
	};
	switch (event.type) {
		case "user/message": {
			const row = {
				seq: event.seq,
				time: event.time,
				kind: "user",
				turn: view.turn,
				step: void 0,
				text: foldText(event.data.content),
				reasoning: "",
				event
			};
			return {
				...base,
				messages: [...base.messages, row],
				...base.firstInTurnTime === void 0 ? { firstInTurnTime: event.time } : {}
			};
		}
		case "assistant/chunk": {
			const { turn, step, chunk } = event.data;
			const text = chunk.type === "text-delta" ? chunk.text : "";
			const reasoning = chunk.type === "reasoning-delta" ? chunk.text : "";
			const current = base.streaming;
			const streaming = current !== void 0 && current.turn === turn && current.step === step ? {
				...current,
				text: current.text + text,
				reasoning: current.reasoning + reasoning
			} : {
				turn,
				step,
				text,
				reasoning
			};
			return {
				...base,
				streaming
			};
		}
		case "assistant/message": {
			const { turn, step, message } = event.data;
			const row = {
				seq: event.seq,
				time: event.time,
				kind: "assistant",
				turn,
				step,
				text: foldText(message.content),
				reasoning: foldReasoning(message.content),
				event
			};
			const streaming = base.streaming !== void 0 && base.streaming.turn === turn && base.streaming.step === step ? void 0 : base.streaming;
			return {
				...base,
				messages: [...base.messages, row],
				streaming,
				...row.turn === base.turn && base.firstInTurnTime === void 0 ? { firstInTurnTime: event.time } : {}
			};
		}
		case "tool/call": {
			const { callId, name, arguments: raw, turn, step } = event.data;
			const tool = {
				callId,
				name,
				arguments: raw,
				turn,
				step,
				seq: event.seq,
				time: event.time,
				result: void 0,
				error: void 0
			};
			return {
				...base,
				tools: [...base.tools, tool]
			};
		}
		case "tool/result": {
			const { toolCallId: callId } = event.data.message.content[0];
			const tools = base.tools.map((tool) => {
				if (tool.callId !== callId) return tool;
				return {
					...tool,
					result: event,
					...event.data.error === void 0 ? {} : { error: event.data.error }
				};
			});
			return {
				...base,
				tools
			};
		}
		case "turn/start": return {
			...base,
			turn: event.data.turn,
			firstInTurnTime: void 0
		};
		default: return base;
	}
}
/**
* Create a live transcript projection for one session.
* @param ctx - any context of the app; used to subscribe to `session/event`.
* @param session - the live session whose log is projected. Its existing
*   `events` are folded at creation (replay); later appends arrive via the
*   `session/event` firehose, filtered by session id.
* @returns the live projection; call `dispose()` to detach its subscription.
*/
function createTranscript(ctx, session) {
	let view = emptyTranscript(session.id);
	for (const event of session.snapshotEvents()) view = applyTranscriptEvent(view, event);
	const handler = (owner, event) => {
		if (owner.id !== session.id) return;
		view = applyTranscriptEvent(view, event);
	};
	const dispose = ctx.on("session/event", handler);
	return {
		get view() {
			return view;
		},
		dispose() {
			dispose();
		}
	};
}
//#endregion
//#region lib/types/adapter/tool-view.js
/**
* presenter 桥 — 把 harness 工具声明的渲染意图（ToolDefinition.presentCall /
* presentResult）软降级地解析给 TUI 渲染层。
*
* 镜像 apiproxy `viewFor` 的消费模式（packages/host/apiproxy）：presenter
* 是 args 的纯函数，live 结算与 resume replay 走同一条桥；tools 服务缺失、
* 工具未注册、参数 JSON 不可解析、presenter 抛错——一律降级为「无意图」，
* 渲染层回落 formatToolCard 文本折叠。展示层失败绝不中断会话流。
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/tool-view
*/
/**
* 解析一次工具调用的渲染意图（presentCall + 可选 presentResult）。
* @param tools - tools 服务面；缺失（服务未装配）时直接降级。
* @param request - 调用事实（名字、原始参数、可选已结算结果）。
* @returns 解析出的渲染意图；任何失败路径返回空对象（软降级）。
*/
function resolveToolViews(tools, request) {
	if (tools === void 0) return {};
	const definition = tools.get(request.name);
	if (definition === void 0) return {};
	try {
		const args = JSON.parse(request.argumentsRaw);
		const call = definition.presentCall?.(args);
		const result = request.result === void 0 ? void 0 : definition.presentResult?.(args, {
			content: request.result.content,
			isError: request.result.isError,
			...request.result.meta === void 0 ? {} : { meta: request.result.meta }
		});
		return {
			...call === void 0 ? {} : { call },
			...result === void 0 ? {} : { result }
		};
	} catch {
		return {};
	}
}
//#endregion
//#region lib/types/adapter/live.js
/**
* Live agent projection: derives a TUI-facing view of one agent's live state
* from the `agent/*` event stream (`agent/status`, `agent/inbox/*`,
* `agent/error`, `agent/disposed`). No new event vocabulary is invented and no
* state is written back — the events are the fact source, this is a projection.
*
* Two layers mirror the transcript module: a pure fold (`emptyLiveState` /
* `applyLiveEvent`) and a live subscription wrapper (`trackAgent`).
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/live
*/
/**
* An empty live state for `id`, with no event yet folded.
* @param id - 被追踪的 agent/会话 id。
* @returns idle、空 inbox、live=true 的初始状态。
*/
function emptyLiveState(id) {
	return {
		id,
		status: "idle",
		inbox: [],
		lastError: void 0,
		live: true,
		activity: void 0
	};
}
/** Remove a message by identity from the pending inbox list. */
function withoutMessage(inbox, id) {
	return inbox.filter((message) => message.id !== id);
}
/**
* Fold one agent-scoped event into the derived state. Returns a NEW state.
* @param state - the previous derived state.
* @param event - one discriminated agent event: status, inbox mutation,
*   tool activity, error, or disposal. Payloads for other agents are filtered
*   by the caller.
* @returns the folded state.
*/
function applyLiveEvent(state, event) {
	switch (event.type) {
		case "status": return event.status === "running" ? {
			...state,
			status: event.status,
			lastError: void 0
		} : {
			...state,
			status: event.status
		};
		case "inbox-inserted": return {
			...state,
			inbox: [...state.inbox, event.message]
		};
		case "inbox-claimed":
		case "inbox-discarded": return {
			...state,
			inbox: withoutMessage(state.inbox, event.messageId)
		};
		case "tool-call": return {
			...state,
			activity: {
				callId: event.callId,
				name: event.name,
				arguments: event.arguments,
				turn: event.turn,
				step: event.step
			}
		};
		case "tool-result": return state.activity?.callId === event.callId ? {
			...state,
			activity: void 0
		} : state;
		case "error": return {
			...state,
			lastError: {
				turn: event.turn,
				step: event.step,
				error: event.error
			}
		};
		case "disposed": return {
			...state,
			live: false
		};
	}
}
/**
* Track one agent's live state. Seeds from the registry when the agent is
* already live; thereafter folds every matching `agent/*` event. The caller
* owns the agent handle it may hold — this projection never disposes it.
* @param ctx - any context of the app; used to subscribe to `agent/*` events
*   (globally dispatched, so events are filtered by agent id here).
* @param id - the agent/session id to track.
* @returns the live projection; call `dispose()` to detach.
*/
function trackAgent(ctx, id) {
	const seeded = ctx.agents.get(id);
	let state = {
		...emptyLiveState(id),
		status: seeded?.status ?? "idle",
		live: seeded !== void 0,
		inbox: seeded === void 0 ? [] : [...seeded.inbox.nextTurn, ...seeded.inbox.nextStep]
	};
	const onStatus = ({ agent, status }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, {
			type: "status",
			status
		});
	};
	const onInserted = ({ agent, message }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, {
			type: "inbox-inserted",
			message
		});
	};
	const onClaimed = ({ agent, message }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, {
			type: "inbox-claimed",
			messageId: message.id
		});
	};
	const onDiscarded = ({ agent, message }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, {
			type: "inbox-discarded",
			messageId: message.id
		});
	};
	const onError = ({ agent, turn, step, error }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, {
			type: "error",
			turn,
			step,
			error
		});
	};
	const onDisposed = ({ agent }) => {
		if (agent.id !== id) return;
		state = applyLiveEvent(state, { type: "disposed" });
	};
	const onSessionEvent = (owner, event) => {
		if (owner.id !== id) return;
		switch (event.type) {
			case "tool/call":
				state = applyLiveEvent(state, {
					type: "tool-call",
					turn: event.data.turn,
					step: event.data.step,
					callId: event.data.callId,
					name: event.data.name,
					arguments: event.data.arguments
				});
				break;
			case "tool/result": state = applyLiveEvent(state, {
				type: "tool-result",
				callId: event.data.message.source.callId
			});
		}
	};
	const disposers = [
		ctx.on("agent/status", onStatus),
		ctx.on("agent/inbox/inserted", onInserted),
		ctx.on("agent/inbox/claimed", onClaimed),
		ctx.on("agent/inbox/discarded", onDiscarded),
		ctx.on("agent/error", onError),
		ctx.on("agent/disposed", onDisposed),
		ctx.on("session/event", onSessionEvent)
	];
	return {
		get state() {
			return state;
		},
		dispose() {
			for (const dispose of disposers) dispose();
		}
	};
}
//#endregion
//#region lib/types/adapter/send.js
/**
* TUI output control surface: turns user intent into driver input through the
* {@link Agent} public interface. A handle-created agent is driven through the
* handle the TUI itself owns; a switched-to session is driven through the bare
* agent returned by `ctx.agents.get(id)` and is NEVER disposed here (only the
* handle holder — the structural owner — may tear an agent down). This module
* writes no session events directly: `followup`/`steer`/`inject` submit inbox
* input that the agent loop logs through its own durable channels.
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/send
*/
/** 解析 data URL（`data:<mediaType>;base64,<bytes>`）为 attachment 保存入参。 */
function parseImageDataUrl$1(dataUrl) {
	const match = /^data:([a-zA-Z0-9./+-]+);base64,(.+)$/.exec(dataUrl);
	if (match === null) throw new Error(`无法解析图片 data URL（缺 base64 载荷）：${dataUrl.slice(0, 40)}…`);
	const mediaType = match[1];
	const payload = match[2];
	if (mediaType === void 0 || payload === void 0) throw new Error(`无法解析图片 data URL（分组缺失）：${dataUrl.slice(0, 40)}…`);
	if (![
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	].includes(mediaType)) throw new Error(`不支持的图片 media type：${mediaType}`);
	return {
		data: Buffer.from(payload, "base64"),
		mediaType
	};
}
/** Build an identified text-only user message (synchronous fast path). */
function toUserMessageSync(text) {
	return createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: { kind: "user" }
	});
}
/**
* Build an identified user message from plain TUI input text + optional image
* attachments. Images arrive as data URLs (paste/attach pipeline) and are
* durably committed through the attachment service before the message is
* published, so the message content carries only the stable reference.
* @param ctx - context exposing `ctx.attachments` (fails loud when absent).
* @param text - the prompt text.
* @param images - optional image data URLs, committed in order.
* @returns the identified user message with attachment-backed image blocks.
*/
async function toUserMessage(ctx, text, images) {
	if (images === void 0 || images.length === 0) return toUserMessageSync(text);
	const content = [{
		type: "text",
		text
	}];
	const attachments = ctx.reflect.get("attachments", false);
	if (attachments === void 0) throw new Error("图片发送需要 attachments 服务（attachment-local 未装配）");
	for (const dataUrl of images) {
		const attachment = await attachments.saveImage(parseImageDataUrl$1(dataUrl));
		content.push({
			type: "image",
			attachment
		});
	}
	return createUserMessage({
		content,
		source: { kind: "user" }
	});
}
/**
* Build controls for an agent the caller OWNS through a handle. The handle
* itself is intentionally not exposed here — disposal stays with the holder
* (`handle.dispose()`); this surface only drives the agent.
* @param handle - the owned handle returned by `ctx.agents.create`/`resume`.
* @returns the drive-only control surface over `handle.agent`.
*/
function controlsFromHandle(handle) {
	return controlsFromAgent(handle.agent);
}
/**
* Build controls for a bare agent the caller does NOT own. Never disposes the
* agent: teardown of a switched-to session belongs to its structural owner.
* @param agent - a bare agent, e.g. from `ctx.agents.get(id)`.
* @returns the drive-only control surface over the agent.
*/
function controlsFromAgent(agent) {
	return {
		followup: (text, images) => {
			if (images === void 0 || images.length === 0) {
				agent.followup(toUserMessageSync(text));
				return Promise.resolve();
			}
			return toUserMessage(agent.ctx, text, images).then((message) => {
				agent.followup(message);
			});
		},
		steer: (text) => {
			agent.steer(toUserMessageSync(text));
		},
		inject: (text) => {
			agent.inject(toUserMessageSync(text));
		},
		cancel: (cause, options) => {
			if (options === void 0) agent.cancel(cause);
			else agent.cancel(cause, options);
		},
		whenIdle: () => agent.whenIdle()
	};
}
/**
* Resolve controls for a live agent by session id through the registry, for
* session switching. The returned surface drives the bare agent and never
* disposes it (non-owner semantics).
* @param ctx - any context exposing `ctx.agents`.
* @param id - the shared agent/session id to look up.
* @returns controls for the live agent, or `undefined` when none is registered.
*/
function controlsFromRegistry(ctx, id) {
	const agent = ctx.agents.get(id);
	return agent === void 0 ? void 0 : controlsFromAgent(agent);
}
/**
* 计算一个会话在 `/session list` 中的展示标题。
* 纯函数、同步、无副作用：fold 官方标题事件 → 确定性 fallback → 「新对话」。
* @param events - 会话事件日志（live 或持久化重放）。
* @returns 展示标题（恒非空）。
*/
/**
* 从事件日志折叠展示标题（官方标题 fold → 首条真人消息确定性 fallback）。
* @param events - 会话事件日志（live 或持久化重放）。
* @returns 展示标题；无任何可用来源时 undefined。
*/
function titleFromEvents(events) {
	const folded = foldSessionTitle(events);
	if (folded !== void 0) return folded.title;
	/* v8 ignore next -- firstUserMessageText 恒返回 string | undefined */
	const first = firstUserMessageText(events);
	if (first === void 0) return void 0;
	return fallbackSessionTitle(first, 5, 40);
}
/**
* 首条真人消息文本（collectSessionTitleMessages 的本地同语义折叠：rc.1 起
* dsh-session-title 不再公开该导出）。过滤 user/message 且 source.kind==='user'，
* 文本块按行拼接，全空白跳过。
*/
function firstUserMessageText(events) {
	for (const event of events) {
		if (event.type !== "user/message" || event.data.source.kind !== "user") continue;
		const text = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text.trim().length === 0) continue;
		return text;
	}
}
/**
* 计算一个会话在 `/session list` 中的展示标题。
* 纯函数、同步、无副作用：seed 边界后的自有标题 → 全量 fold → 确定性
* fallback → 「新对话」。
* @param events - 会话事件日志（live 或持久化重放）。
* @returns 展示标题（恒非空）。
*/
function sessionTitleFor(events) {
	const boundary = events.findLastIndex((event) => event.type === "session/end-seed");
	if (boundary >= 0) {
		const own = titleFromEvents(events.slice(boundary + 1));
		if (own !== void 0) return own;
	}
	return titleFromEvents(events) ?? "新对话";
}
//#endregion
//#region lib/types/adapter/sessions.js
/**
* Session management surface: listing, lookup, forking, history loading, and
* teardown flushing. The session log is the authoritative fact source — this
* module only READS logs and the live store; it never appends events and never
* disposes agents (a handle's teardown belongs to its holder).
*
* 唯一例外：`clearEmptySessionArtifact` 会删除一个「没有任何内容」的会话的
* 持久化 artifact——启动复用（同 id 换 cwd）要求旧目录下的空 artifact 消失，
* 否则后端以 duplicate id / id collision 拒绝。删除对象经调用方确认无任何
* 聊天内容，且仅此一处（写操作不落在事件日志上）。
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/sessions
*/
/** 经注入代理读取可选的 sessionPersistence 服务（未装配返回 undefined）。 */
function persistenceFacet(ctx) {
	return ctx.reflect !== void 0 ? ctx.reflect.get("sessionPersistence", false) : ctx.get("sessionPersistence");
}
function toSummary(header) {
	return {
		id: header.id,
		version: header.version,
		createdAt: header.createdAt,
		cwd: header.cwd,
		parentSession: header.parentSession,
		agentPreset: header.agentPreset
	};
}
/**
* List known sessions, newest first. Persisted sessions come from
* `ctx.sessionPersistence` (metadata-only listing) when that service is
* configured; otherwise the live in-memory store's headers are used.
* @param ctx - any context exposing `ctx.sessions` and optionally
*   `ctx.sessionPersistence`.
* @returns one summary per known session, ordered by `createdAt` descending.
*/
async function listSessions(ctx) {
	const persistence = persistenceFacet(ctx);
	return (persistence !== void 0 ? await persistence.list() : ctx.sessions.list().map((session) => session.header)).map((header) => {
		const summary = toSummary(header);
		const live = ctx.sessions.get(header.id);
		if (live !== void 0) {
			const preset = resolvePresetId(summary.agentPreset, live.snapshotEvents());
			if (preset !== void 0) return {
				...summary,
				agentPreset: preset
			};
		}
		return summary;
	}).sort((a, b) => b.createdAt - a.createdAt);
}
/**
* Resolve the live session object for an id.
* @param ctx - any context exposing `ctx.sessions`.
* @param id - the session id to look up.
* @returns the live session, or `undefined` when not in the live store.
*/
function getSession(ctx, id) {
	return ctx.sessions.get(id);
}
/**
* Fork a live session at an optional boundary, creating a live child session.
* @param ctx - any context exposing `ctx.sessions`.
* @param source - the fork source: a live session or its store id.
* @param boundary - optional contiguous boundary seq; defaults to a safe point.
* @param childSessionId - optional child identity; the store generates one when absent.
* @returns the created live child session.
*/
/**
* /fork /branch 的 create seed：官方 persistence.prepare 禁止对 live 会话
* resume，所以分叉必须走 agents.create({ seed, meta })，不能 sessions.fork 后再
* resume。seed 必须是不落在 open turn 里的完整前缀（SessionStore.fork 同款）；
* 回合未结束时响亮失败，不静默裁剪（与 /btw 的 completedTurnSeed 不同）。
* @param events - 源会话事件日志。
* @returns 可直接交给 agents.create 的 seed。
*/
function liveForkSeed(events) {
	let open = false;
	for (const event of events) if (event.type === "turn/start") open = true;
	else if (event.type === "turn/end") open = false;
	if (open) throw new Error("当前会话回合未结束，无法分叉");
	return events;
}
/**
* 组装 agents.create 的 fork 参数（seed + 血缘 meta）。
* @param parent - 源 live 会话。
* @param fallbackCwd - header.cwd 缺失时的工作区（启动目录）。
*/
function forkAgentSpec(parent, fallbackCwd, parentSessionId = parent.id) {
	const seed = liveForkSeed(parent.snapshotEvents());
	return {
		seed,
		meta: {
			cwd: parent.header.cwd ?? fallbackCwd,
			parentSession: parentSessionId,
			isSeeded: seed.length > 0
		},
		inheritedEventCount: SessionLogOffset(seed.length)
	};
}
/**
* Load a session's event log for display. A live session's in-process log is
* authoritative (it includes events not yet flushed); a persisted-only session
* is loaded through `ctx.sessionPersistence.inspect` when available.
* @param ctx - any context exposing `ctx.sessions` and optionally
*   `ctx.sessionPersistence`.
* @param id - the session whose log is requested.
* @returns the immutable event log, or an empty array when the session is unknown.
*/
async function loadHistory(ctx, id) {
	const live = ctx.sessions.get(id);
	if (live !== void 0) return live.snapshotEvents();
	const persistence = persistenceFacet(ctx);
	if (persistence !== void 0) try {
		return (await persistence.inspect(id)).events;
	} catch {
		return [];
	}
	return [];
}
/**
* 启动复用候选：最近（createdAt 降序第一个）没有任何聊天内容的会话——
* 标题折叠为「新对话」（无标题事件且无真人消息；会话 title 服务首 prompt
* cadence 生成，标题存在即内容存在）。读取失败（corrupt/消失）的会话跳过，
* 绝不冒险复用——artifact 清理只针对确认无内容的会话。
*
* 只扫描最近 {@link REUSE_SCAN_LIMIT} 个会话：候选空会话几乎总是上次启动
* 遗留（列表头部），无界扫描会逐个 readFrom 全量事件日志，拖慢启动。
* @param ctx - any context exposing `ctx.sessions` and optionally
*   `ctx.sessionPersistence`.
* @returns 最近空会话的摘要；无候选返回 undefined。
*/
async function findMostRecentEmptySession(ctx) {
	const summaries = await listSessions(ctx);
	for (const summary of summaries.slice(0, 15)) {
		const events = await loadHistoryStrict(ctx, summary.id);
		if (events !== null && sessionTitleFor(events) === "新对话") return summary;
	}
}
/**
* 严格读事件日志（复用扫描专用）：live 走内存；持久化走 readFrom（detached
* 物理读，不碰 preparation 缓存——inspect 会给该身份建档，随后同 id 的
* agents.create 会被协调器判 "persisted state already owns this identity"）。
* 读取失败（corrupt/消失/无 readFrom 能力）返回 null 而非空数组——空数组会被
* 折叠成「新对话」，导致不可读会话被误判为无内容而进入复用/清理路径。
*/
async function loadHistoryStrict(ctx, id) {
	const live = ctx.sessions.get(id);
	if (live !== void 0) return live.snapshotEvents();
	const persistence = persistenceFacet(ctx);
	if (persistence === void 0 || persistence.readFrom === void 0) return null;
	try {
		return (await persistence.readFrom(id, 0)).events;
	} catch {
		return null;
	}
}
/**
* 清掉一个已确认无内容会话的旧持久化 artifact（跨 cwd 复用前调用）。
*
* 后端（JSONL）以 `<root>/<projectKey(cwd)>/<id>/` 组织 artifact；同 id 留在
* 两个项目目录会让 list 报 duplicate、跨 cwd create 被判 id collision。删除
* 整目录（含后端可能的会话本地附属文件）后，同 id 才能在启动目录重新
* materialize。无物化记录（惰性后端未写盘）视为已清理。
* @param ctx - any context exposing optional `ctx.sessionPersistence`.
* @param summary - 目标空会话摘要（id + 原 cwd）。
* @returns 可以安全复用为 true；无 locate 能力或删除失败为 false
*   （调用方应退回全新 id，避免启动被后端 collision 拒绝）。
*/
async function clearEmptySessionArtifact(ctx, summary) {
	const persistence = persistenceFacet(ctx);
	if (persistence === void 0 || persistence.locate === void 0) return false;
	let headers;
	try {
		headers = await persistence.list();
	} catch {
		return false;
	}
	const header = headers.find((h) => h.id === summary.id && h.cwd === summary.cwd);
	if (header === void 0) return true;
	const location = persistence.locate(header);
	if (location === void 0) return false;
	try {
		await rm(dirname(location.path), {
			recursive: true,
			force: true
		});
		return true;
	} catch {
		return false;
	}
}
/**
* Flush every live session to durable storage — the teardown checkpoint.
* Each flush dispatches the awaited `session/flush` durability barrier through
* `ctx.sessions.flush`; persistence plugins drain their buffers there.
* @param ctx - any context exposing `ctx.sessions`.
* @returns after every live session's flush has settled; the first listener
*   failure propagates.
*/
async function flushAll(ctx) {
	for (const session of ctx.sessions.list()) await ctx.sessions.flush(session);
}
//#endregion
//#region lib/types/controllers/session-manager.js
/**
* SessionManager — 多会话 side conversation 快照层（P3）。
*
* 会话快照从 live store 派生（不重复存储）：ctx.sessions.list() 是权威来源
* （AgentRegistry 多 agent 并存 + SessionStore 多 session 天然支持），本层只
* 做「session → 投影元数据」的派生与状态查询。tab 栏渲染消费 list()。
*
* 会话生命周期归属：agent 由 agent-loop factory 持有（TuiApp 切换时经
* detachProjections({ keepHandle: true }) 让渡所有权给 registry）；本层不
* 创建/销毁会话——退出时由 factory 统一 teardown。
*
* @module @deepseek-ai/dsh-tianshu-tui/controllers/session-manager
*/
/**
* resume 模型定路：持久化 request header 优先（跨重启续模），无 header
* （从未成功发起请求的会话）才落 agentDefaultModel 当前选择。
* @param persisted - 目标会话的持久化路由段；undefined = 无 header。
* @param fallback - 缺省选择的惰性取值（仅无持久化路由时调用，避免多余读取）。
* @returns resume 使用的模型选择。
*/
function resumeModelSelection(persisted, fallback) {
	if (persisted === void 0) return fallback();
	return {
		provider: persisted.provider,
		model: persisted.model,
		...persisted.reasoningEffort === void 0 ? {} : { reasoningEffort: persisted.reasoningEffort }
	};
}
/** 多会话快照层：从 live store（ctx.sessions/ctx.agents）派生投影元数据，不持有会话生命周期。 */
var SessionManager = class {
	ctx;
	constructor(ctx) {
		this.ctx = ctx;
	}
	/**
	* 全部 live 会话的投影快照（live store 派生；按创建序）。
	* @returns 每个 live 会话一条 SessionSnapshot。
	*/
	list() {
		const sessions = this.ctx.sessions.list();
		const snapshots = [];
		for (const session of sessions) snapshots.push({
			id: session.id,
			status: this.ctx.agents.get(session.id)?.status ?? "idle",
			messageCount: session.snapshotEvents().length
		});
		return snapshots;
	}
	/**
	* 某会话的 agent 状态（无 live agent 视为 idle）。
	* @param id - 会话 id。
	* @returns 'running' 或 'idle'。
	*/
	statusOf(id) {
		return this.ctx.agents.get(id)?.status ?? "idle";
	}
};
//#endregion
//#region lib/types/adapter/fork-agent.js
/**
* 用户面 /fork /branch：用 agents.create({ seed, meta }) 铸 child，
* 避免 sessions.fork 后再 resume 触发「cannot prepare session while it is live」。
*
* @module @deepseek-ai/dsh-tianshu-tui/adapter/fork-agent
*/
/**
* 从父会话铸一个带历史的 child agent（create 失败不改父会话）。
* @param ctx - 提供 agents.create / agentDefaultModel。
* @param parent - 源 live 会话。
* @param parentSessionId - 血缘 id（当前活跃会话，不一定等于 parent.id）。
* @param fallbackCwd - header.cwd 缺失时的工作区。
*/
async function createForkedAgent(ctx, parent, parentSessionId, fallbackCwd) {
	const spec = forkAgentSpec(parent, fallbackCwd, parentSessionId);
	const persisted = parent.requestHeader()?.config;
	const selection = resumeModelSelection(persisted, () => ctx.agentDefaultModel.currentSelection());
	const ref = {
		current: selection,
		assembled: void 0
	};
	const childId = SessionId(`session-${randomUUID()}`);
	return {
		childId,
		handle: await ctx.agents.create({
			sessionId: childId,
			seed: spec.seed,
			meta: spec.meta,
			inheritedEventCount: spec.inheritedEventCount,
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: async (agentCtx) => {
				installModelSelection(agentCtx, ref);
				const parentAgent = ctx.agents.get(parentSessionId);
				await joinPreset({
					facet: presetJoinFacet(ctx),
					agentCtx,
					mode: "child",
					parentCtx: parentAgent?.ctx
				});
			}
		}),
		ref
	};
}
//#endregion
//#region lib/types/theme-detect.js
/**
* 终端背景明暗检测 — `theme: "auto"` 支撑。
*
* 检测链（先到先得）：
* 1. OSC 11 查询终端背景色（`ESC ] 11 ; ? BEL`）——现代终端（iTerm2/kitty/
*    WezTerm/Windows Terminal/Ghostty…）会回 `ESC ] 11 ; rgb:RRRR/GGGG/BBBB`，
*    按感知亮度判明暗。500ms 超时。
* 2. COLORFGBG 环境变量兜底（rxvt 系约定 `<fg>;<bg>`，bg 7/15 视为亮）。
* 3. 全部失败 → 'dark'（终端世界的保守默认）。
*
* 内部按需临时开 raw mode 并 resume 读响应，结束后把 raw mode 与暂停/流动
* 状态恢复为进入时的原状——TUI 已接管 stdin 时也可安全调用。
* 非 TTY（管道/CI）直接走 env 兜底。
*/
/**
* 解析 OSC 11 响应中的 rgb 载荷 → 感知亮度 [0,1]。无法解析返回 null。
* @param response - 终端回包原文（含 `rgb:RRRR/GGGG/BBBB` 片段）。
* @returns BT.601 感知亮度；无 rgb 载荷返回 null。
*/
function parseOsc11Luminance(response) {
	const m = response.match(/rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/);
	if (!m) return null;
	const norm = (s) => parseInt(s, 16) / (16 ** s.length - 1);
	/* v8 ignore next -- match 成功必有 3 组捕获，?? 右侧为 noUncheckedIndexedAccess 收窄防御 */
	const r = norm(m[1] ?? ""), g = norm(m[2] ?? ""), b = norm(m[3] ?? "");
	return .299 * r + .587 * g + .114 * b;
}
/**
* COLORFGBG 兜底解析（如 "15;0" / "0;15" / "12;8"）。无法判断返回 null。
* @param env - COLORFGBG 环境变量值（取末段为 bg 索引）。
* @returns 明暗判定；缺失或非数字 bg 返回 null。
*/
function parseColorFgBg(env) {
	if (!env) return null;
	const parts = env.split(";");
	const bgRaw = parts[parts.length - 1]?.trim();
	if (!bgRaw || !/^\d+$/.test(bgRaw)) return null;
	const bgIndex = Number(bgRaw);
	return bgIndex === 7 || bgIndex === 15 ? "light" : "dark";
}
/**
* 检测终端背景明暗。见模块头注释的检测链。
* 任何异常（raw mode 失败、流关闭…）都吞掉并落到兜底，绝不让主题检测拦死启动。
* @param opts - 超时与流/env 注入选项。
* @returns 明暗判定（检测链全部失败落 'dark'）。
*/
async function detectTerminalBackground(opts = {}) {
	/* v8 ignore next -- 全部调用方（含测试）均显式注入 opts.stdin，?? 右侧为契约兜底 */
	const stdin = opts.stdin ?? process.stdin;
	/* v8 ignore next -- 同上：opts.stdout 恒显式注入 */
	const stdout = opts.stdout ?? process.stdout;
	/* v8 ignore next -- 同上：opts.env 恒显式注入 */
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? 500;
	const fallback = () => parseColorFgBg(env.COLORFGBG) ?? "dark";
	if (!stdin.isTTY || !stdout.isTTY) return fallback();
	const wasRaw = stdin.isRaw;
	const wasPaused = stdin.isPaused();
	try {
		return await new Promise((resolve) => {
			let buffer = "";
			let done = false;
			const finish = (value) => {
				/* v8 ignore next -- 首次 finish 即 off 监听并 clearTimeout，运行时至多调用一次，done 恒 false */
				if (done) return;
				done = true;
				clearTimeout(timer);
				stdin.off("data", onData);
				try {
					if (!wasRaw) stdin.setRawMode(false);
				} catch {}
				if (wasPaused) stdin.pause();
				resolve(value);
			};
			const onData = (chunk) => {
				buffer += chunk.toString("latin1");
				if (/\]11;.*(\x07|\x1B\\)/.test(buffer)) {
					const lum = parseOsc11Luminance(buffer);
					finish(lum === null ? null : lum > .5 ? "light" : "dark");
				}
			};
			const timer = setTimeout(() => {
				finish(null);
			}, timeoutMs);
			try {
				if (!wasRaw) stdin.setRawMode(true);
				stdin.resume();
				stdin.on("data", onData);
				stdout.write("\x1B]11;?\x07");
			} catch {
				finish(null);
			}
		}) ?? fallback();
	} catch {
		return fallback();
	}
}
/**
* auto 主题的默认落点：dark → graphite，light → paper。
* @param background - 终端背景明暗。
* @returns 对应主题名。
*/
function autoThemeFor(background) {
	return background === "light" ? "paper" : "graphite";
}
//#endregion
//#region lib/types/format/user-message.js
/**
* T9 格式化函数 — 用户消息与转向消息共用「说话人导轨」制式。
*
* 源出 .rivet/tui-source/tui/format/user-message.ts（Apache-2.0 来源，见
* LICENSE/NOTICE/SOURCE-MAP.md）。本文件为 dsh-tui 移植的基础版，无天枢耦合。
*
* 渲染结构（导轨制式，marker + 颜色承担说话人识别）：
* ▌ 消息首行             (markerColor + bold 导轨；regular 中性正文)
* ▌ 消息后续行           (同一导轨；regular 中性正文)
* ▌                       (空行只保留导轨)
*
* 说话人：
* - user：marker `❯`/`▌` + userColor（formatUserMessage）
* - steer：marker `>>`/`➤` + warning（formatSteerMessage，见 steer-message.ts）
*/
/**
* 消息时间戳 → `[HH:MM]` 显示段（本地时区）。
* @param ms - Unix epoch 毫秒。
* @returns 形如 `[14:32]` 的显示文本。
*/
function formatTimestamp(ms) {
	const d = new Date(ms);
	return `[${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}]`;
}
/**
* 渲染一条「说话人导轨」消息：markerColor+bold 导轨前缀 + 中性正文。
* 首行与正文同行；后续行维持同一导轨，空行只保留导轨。
* 正文按 width 折叠（导轨前缀宽度计入每行预算；CJK 宽字符按显示宽度度量）。
* 提供 timestamp 且正文宽度足够时，首行最后一块后附 `[HH:MM]`（宽度预算
* 从首行折叠扣除，窄宽隐藏不破版）。
* @param input - 文本、宽度、marker 与 markerColor。
* @param theme - 当前主题（正文用 assistantColor 中性色；时间戳用 secondary）。
* @returns 渲染行数组（每行含导轨前缀）。
*/
function formatRailedMessage(input, theme) {
	const lines = [];
	const prefix = color(input.marker, input.markerColor, { bold: true });
	const railWidth = displayWidth(input.marker) + 1;
	const bodyWidth = Math.max(0, input.width - railWidth);
	const stampText = input.timestamp !== void 0 && bodyWidth >= 12 ? ` ${color(formatTimestamp(input.timestamp), theme.secondary)}` : "";
	const stampWidth = displayWidth(stampText);
	for (const [index, contentLine] of input.content.split("\n").entries()) {
		if (contentLine.trim().length === 0) {
			lines.push(prefix);
			continue;
		}
		if (bodyWidth <= 0) {
			lines.push(`${prefix} ${color(contentLine, theme.assistantColor)}`);
			continue;
		}
		const chunks = wrapToDisplayWidth(contentLine, index === 0 ? Math.max(1, bodyWidth - stampWidth) : bodyWidth);
		for (const [chunkIndex, chunk] of chunks.entries()) {
			const stamp = index === 0 && chunkIndex === 0 ? stampText : "";
			lines.push(`${prefix} ${color(chunk, theme.assistantColor)}${stamp}`);
		}
	}
	return lines;
}
/**
* 渲染用户消息为 scrollback 行：userColor `❯`/`▌` 导轨 + 中性正文。
* @param input - 用户消息文本与宽度。
* @param theme - 当前主题（marker 用 userColor）。
* @returns 渲染行数组（每行含导轨前缀）。
*/
function formatUserMessage(input, theme) {
	const marker = useAsciiGlyphs() ? ">" : "▌";
	return formatRailedMessage({
		...input,
		marker,
		markerColor: theme.userColor
	}, theme);
}
//#endregion
//#region lib/types/format/steer-message.js
/**
* T9 格式化函数 — 转向消息（中轮 steer，marker 与颜色区分 user）。
*
* 渲染结构与 user-message 同一导轨制式（说话人识别靠 marker + 颜色）：
* - marker：`➤`（truecolor 轨）/ `>>`（ascii 轨），warning 色 + bold
* - 正文：assistantColor 中性色（同 user 正文层级）
*
* @module @deepseek-ai/dsh-tianshu-tui/format/steer-message
*/
/**
* 渲染转向消息为 scrollback 行：warning 色 `➤`/`>>` 导轨 + 中性正文，
* 与 user 消息（`▌`/`❯` + userColor）在 marker 与颜色上区分。
* @param input - 转向文本与宽度。
* @param theme - 当前主题（marker 用 warning 色）。
* @returns 渲染行数组（每行含导轨前缀）。
*/
function formatSteerMessage(input, theme) {
	const marker = chalk.level < 3 ? ">>" : "➤";
	return formatRailedMessage({
		...input,
		marker,
		markerColor: theme.warning
	}, theme);
}
//#endregion
//#region lib/types/braille-spinner.js
const FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
/**
* Smooth braille spinner frame for a monotonically increasing tick index (S16).
* @param tick - 单调递增的帧计数（负值也安全，双取模回卷）。
* @returns 当前帧的盲文字符。
*/
function brailleSpinnerFrame(tick) {
	const idx = (tick % FRAMES.length + FRAMES.length) % FRAMES.length;
	/* v8 ignore next -- 双取模后 idx 恒在 [0, FRAMES.length) 界内；noUncheckedIndexedAccess 收窄防御 */
	return FRAMES[idx] ?? "";
}
const CIRCLE_FRAMES = [
	"◐",
	"◓",
	"◑",
	"◒"
];
/**
* Rotating circle spinner frame for a monotonically increasing tick index.
* @param tick - 单调递增的帧计数（负值也安全，双取模回卷）。
* @returns 当前帧的月相圆圈字符。
*/
function circleSpinnerFrame(tick) {
	const idx = (tick % CIRCLE_FRAMES.length + CIRCLE_FRAMES.length) % CIRCLE_FRAMES.length;
	/* v8 ignore next -- 双取模后 idx 恒在 [0, CIRCLE_FRAMES.length) 界内；noUncheckedIndexedAccess 收窄防御 */
	return CIRCLE_FRAMES[idx] ?? "";
}
//#endregion
//#region lib/types/format/live-card.js
/**
* 活区共享卡片 chrome — 工具卡、委派树与后台任务行的同一套 header/body。
*
* 状态形与 `formatToolCardHeader` 对齐：进行中 `⠋`、成功 `›`、失败 `✗`、
* 待答 `?`。正文第一行 `⎿  `，续行三空格。header suffix 从右往左丢，title
* 最后截。进行中可带 body（第二行）；空闲/已结束只留标题行，提供 theme 时
* title 涂 muted。无 theme 时输出纯文本（委派树单测不传 theme）。
*
* 不处理行选中、鼠标 hit-rect，也不合并 /tasks 与 /subagents。
*
* @module @huiliyi37/dsh-tui/format/live-card
*/
/** 卡片 body 首行前缀（与工具卡 ⎿ 同一常量）。 */
const LIVE_CARD_BODY_FIRST = "⎿  ";
const ASCII_SPIN = [
	"-",
	"\\",
	"|",
	"/"
];
/**
* 活区卡片状态形。
* @param status - running / success / error / question。
* @param opts - ascii 降级与可选 spinner 帧。
* @returns 单列（或 ascii 单字节）状态字形。
*/
function liveCardGlyph(status, opts) {
	const ascii = opts?.ascii === true;
	switch (status) {
		case "question": return "?";
		case "error": return ascii ? "x" : "✗";
		case "success": return "›";
		case "running":
			if (opts?.tick !== void 0) {
				if (ascii) {
					const idx = (opts.tick % ASCII_SPIN.length + ASCII_SPIN.length) % ASCII_SPIN.length;
					return ASCII_SPIN[idx] ?? "-";
				}
				return brailleSpinnerFrame(opts.tick);
			}
			return ascii ? "-" : "⠋";
	}
}
/**
* 组装一张活区卡：header（glyph + title + suffix）+ 可选 ⎿ body。
* @param input - 状态形、标题、可选 suffix/body 与宽度。
* @returns 纯文本或带 muted/dim ANSI 的行数组（至少一行 header）。
*/
function formatLiveCard(input) {
	const indent = input.indent ?? "";
	const title = input.dim === true && input.theme !== void 0 ? color(input.title, input.theme.muted) : input.title;
	const header = assembleLiveCardSuffixes(`${indent}${input.glyph} ${title}`, input.suffixes ?? [], input.width);
	const bodyLines = input.body ?? [];
	if (bodyLines.length === 0) return [header];
	return [header, ...indentLiveCardBody(bodyLines, indent, input.theme, input.width)];
}
/**
* 缩进卡片 body：首行 `⎿  `（有 theme 时 dim），续行三空格。
* @param bodyLines - 已是调用方着色后的正文（或纯文本）。
* @param indent - 整卡缩进前缀。
* @param theme - 可选；提供时只给首行前缀涂 dim。
* @param width - 可选截断预算；缺省不截。
* @returns 带前缀的 body 行。
*/
function indentLiveCardBody(bodyLines, indent, theme, width) {
	return bodyLines.map((line, i) => {
		const prefix = i === 0 ? LIVE_CARD_BODY_FIRST : "   ";
		const out = `${indent}${theme !== void 0 && i === 0 ? color(prefix, theme.dim) : prefix}${line}`;
		return width === void 0 ? out : truncateToLiveWidth(out, width);
	});
}
/**
* 行 + 后缀：后缀从右往左丢弃，剩余整体再截断（title 最后才被截）。
* @param line - 已含 indent/glyph/title 的 header。
* @param suffixes - 按保留优先级从左到右。
* @param width - 列预算。
* @returns 不超过 width 的单行。
*/
function assembleLiveCardSuffixes(line, suffixes, width) {
	let out = line;
	for (const suffix of suffixes) {
		const candidate = `${out} · ${suffix}`;
		if (displayWidth(candidate) > width - 1) break;
		out = candidate;
	}
	return truncateToLiveWidth(out, width);
}
/**
* 按显示宽度截断（仅截断时尾部补 …；极端窄宽退化为 …）。
* @param text - 可含 ANSI；宽度按剥色后的显示列。
* @param max - 列预算。
* @returns displayWidth ≤ max 的字符串。
*/
function truncateToLiveWidth(text, max) {
	if (max <= 1) return "…";
	if (displayWidth(text) <= max) return text;
	return `${truncateToDisplayWidth(text, max - 1)}…`;
}
//#endregion
//#region lib/types/truncation-marker.js
/**
* 折叠/截断提示的单一事实来源。
*
* 渲染端（tool-card / collapsed-*）产出这些标记，scrollback pager 解析端
* （scrollback-transcript.ts）反向识别它们来判定「这条消息被截断过、可展开」。
* 两边各写各的字符串会在文案调整时静默失联——pager 的展开入口消失而没有任何报错，
* 所以放在这里共享。
*/
/**
* 折叠 N 行的提示：`… +25 行`（纯计数，不带展开快捷键——ctrl+o 已被占用且无消费端）。
* @param omitted - 被折叠的行/项数。
* @param unit - 计数单位（缺省「行」；diff 场景可传「行 diff」等）。
* @returns 截断计数提示行。
*/
function truncationHint(omitted, unit = "行") {
	return `… +${omitted} ${unit}`;
}
/**
* 截断标记识别。生产端形态统一锚 `… +N 行` 计数，展开提示可选（兼容
* /resume 载入旧会话里的 `… +25 行 · ctrl+o 展开` 与历史英文
* `… +N lines [Ctrl+O]`，不认会让旧会话的展开入口失效）。
*/
const TRUNCATION_MARKER_RE = /…\s*\+\s*\d+\s*行(?:\s*·\s*ctrl\+o\s*展开)?|…\s*\+\s*\d+\s*行 diff|…\s*\+\s*\d+\s*lines\s*\[Ctrl\+O\]/i;
//#endregion
//#region lib/types/format/tool-meta.js
/**
* 工具元数据基础版 — tool-card 渲染的辅助函数合体。
*
* 源出 .rivet/tui-source/tui/ 的 tool-family.ts / tool-label.ts /
* tool-elapsed.ts / tool-domain.ts（Apache-2.0 来源，见 LICENSE/NOTICE/
* SOURCE-MAP.md）。本文件为 dsh-tui 移植的基础版：保留 tool-card 渲染所
* 需的最小契约（family 判定、标题参数摘要、耗时格式化、委派工具识别），
* 去掉天枢特有的星域映射与浏览器调试工具分支。
*/
const TOOL_MAP = {
	read_file: {
		family: "read",
		verb: "read"
	},
	glob: {
		family: "find",
		verb: "find"
	},
	grep: {
		family: "find",
		verb: "search"
	},
	bash: {
		family: "run",
		verb: "run"
	},
	run_code: {
		family: "run",
		verb: "run"
	},
	str_replace_editor: {
		family: "write",
		verb: "patch"
	},
	edit_file: {
		family: "write",
		verb: "patch"
	},
	write_file: {
		family: "write",
		verb: "write"
	},
	apply_patch: {
		family: "write",
		verb: "patch"
	},
	run_tests: {
		family: "run",
		verb: "test"
	},
	delegate_task: {
		family: "run",
		verb: "delegate"
	},
	delegate_batch: {
		family: "run",
		verb: "batch"
	},
	web_fetch: {
		family: "read",
		verb: "fetch"
	},
	inspect_project: {
		family: "find",
		verb: "inspect"
	},
	repo_map: {
		family: "find",
		verb: "map"
	},
	semantic_search: {
		family: "find",
		verb: "search"
	},
	ask_user_question: {
		family: "other",
		verb: "ask"
	}
};
const DEFAULT = {
	family: "other",
	verb: "tool"
};
/**
* 工具家族元数据；未知名工具落 other/tool。
* @param toolName - 工具名（模型原样产出）。
* @returns 家族与标题动词。
*/
function getToolFamily(toolName) {
	return TOOL_MAP[toolName] ?? DEFAULT;
}
/** 截断辅助：超长文本尾部加省略号。 */
function truncate$2(s, max) {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/** unknown → 文本：string 原样；number/boolean 用 String；对象/null/undefined → ''（防 [object Object]）。 */
function textOf(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
/** 路径 basename（POSIX/Windows 分隔符都认）。 */
function pathBasename(value) {
	return textOf(value).replace(/^.*[/\\]/, "");
}
/**
* 工具的主参数摘要（不含动词前缀）——供 `● Verb(arg)` 卡片标题使用。
* 基础版只摘录最常用的参数字段；未知工具返回空串。
* @param name - 工具名（决定摘录哪个参数字段）。
* @param input - 工具输入参数（模型产出的已解析 JSON 对象）。
* @returns 截断后的主参数摘要；未知工具返回空串。
*/
function toolArgSummary(name, input) {
	switch (name) {
		case "read_file":
		case "write_file":
		case "edit_file": return truncate$2(pathBasename(input.file_path ?? input.path), 45);
		case "bash":
 /* v8 ignore next -- split('\n') 恒返回非空数组，[0] 恒存在；noUncheckedIndexedAccess 收窄防御 */
		return truncate$2(textOf(input.command).split("\n")[0] ?? "", 55);
		case "run_code": return truncate$2((textOf(input.code).split("\n")[0] ?? "") || textOf(input.description), 55);
		case "grep":
		case "glob":
		case "semantic_search": return truncate$2(textOf(input.pattern), 35);
		case "delegate_task": return truncate$2(textOf(input.objective), 50);
		case "delegate_batch": return `${Array.isArray(input.tasks) ? input.tasks.length : "?"} tasks`;
		case "web_fetch": return truncate$2(textOf(input.url), 50);
		default: return "";
	}
}
/**
* 容错解析 tool/call 的 arguments JSON（模型产出，wire 边界必须运行时校验）。
* 解析失败/非对象返回 undefined——卡片显示纯动词标题。
* @param raw - 模型产出的原始 arguments JSON 字符串。
* @returns 解析出的对象；空串/非对象/解析失败为 undefined。
*/
function parseToolArguments(raw) {
	if (!raw) return void 0;
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* 精确耗时（Claude Code 风）：<1s → `123ms`，<60s → `1.5s`，否则 `1m05s`。
* @param ms - 毫秒耗时；负数按 0。
* @returns 人类可读的耗时文本。
*/
function formatElapsed$1(ms) {
	if (ms < 1e3) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
	const mins = Math.floor(ms / 6e4);
	const secs = Math.round(ms % 6e4 / 1e3);
	return `${mins}m${String(secs).padStart(2, "0")}s`;
}
//#endregion
//#region lib/types/format/tool-family.js
/**
* 工具家族着色分类 — Phase 7.2。
*
* 与 tool-meta.ts 的 `getToolFamily`（read/write/run/find/other，服务于
* 截断/展开策略与 diff 分支）并存但不重叠：本模块的家族只决定标题着色，
* 是纯投影的「工具名 → 功能域」映射，不产生、不写回任何事件。
*
* 五色家族（任务规格）：文件操作蓝 / shell 黄 / 搜索绿 / 编辑紫 / 网络青。
* 家族映射到主题的语义 token（而非硬编码 hex）——跨主题与 16 色 fallback
* 轨都稳定，色相随主题漂移是设计内的（同 makeToolColor 的惯例）。
*/
/** 工具名 → 着色家族映射。未列出的工具落 `other`（dim）。 */
const FAMILY_MAP = {
	read_file: "file",
	read_section: "file",
	write_file: "file",
	edit_file: "file",
	glob: "file",
	repo_map: "file",
	repo_graph: "file",
	inspect_project: "file",
	file_info: "file",
	ls: "file",
	bash: "shell",
	run_code: "shell",
	grep: "search",
	ast_grep: "search",
	semantic_search: "search",
	related_tests: "search",
	apply_patch: "edit",
	hash_edit: "edit",
	str_replace: "edit",
	str_replace_editor: "edit",
	web_fetch: "network",
	web_search: "network"
};
/**
* 工具名 → 着色家族；未知名工具落 `other`。
* @param toolName - 工具名（模型原样产出）。
* @returns 着色家族标签。
*/
function getToolColorFamily(toolName) {
	return FAMILY_MAP[toolName] ?? "other";
}
/** 家族 → 语义色 token 解析（纯投影）。 */
function familyToToken(family, theme) {
	switch (family) {
		case "file": return theme.primary;
		case "shell": return theme.warning;
		case "search": return theme.success;
		case "edit": return theme.secondary;
		case "network": return theme.toolShell ?? theme.primary;
		default: return theme.dim;
	}
}
/**
* 工具家族的标题配色（ANSI 色值）。
* @param toolName - 工具名（模型原样产出）。
* @param theme - 当前主题（RivetTheme 结构满足 FamilyTheme 最小契约）；家族经语义 token 映射，跨主题稳定。
* @returns 家族色的色值字符串（hex 或 fallback 命名色）。
*/
function toolFamilyColor(toolName, theme) {
	return familyToToken(getToolColorFamily(toolName), theme);
}
//#endregion
//#region lib/types/format/tool-card.js
/**
* 工具卡片渲染（基础版）— Claude Code 风格折叠卡片。
*
* 源出 .rivet/tui-source/tui/format/tool-card.ts（Apache-2.0 来源，见
* LICENSE/NOTICE/SOURCE-MAP.md）。本文件为 dsh-tui 移植的基础版：
* 保留 header/bullet 状态形色、diff 检测分支、read 族头尾预览、截断提示
* 与 live 进行中卡片；去掉天枢特有的 browser_debug 分级着色、委派任务
* 流式预览与星域映射（见反目标：不做 worker/星域面板）。
*
* 渲染结构：
*   › Run(npm test) (1.2s)
*     ⎿  前 4 行输出
*        … +25 行
*
* - 状态形色双通道：› 成功绿 / ✗ 失败红 / ⠋ 进行中 dim / ? 待答黄
*/
/** 宽度口径：与 LiveEngine.rowsForLine 一致。工具输出（git diff/代码/日志）
*  常含 `— … │ →` 等 ambiguous 符号 + CJK，按 .length 截断会低估列宽。 */
const WIDE$1 = { ambiguousAsWide: true };
const DEFAULT_MAX_LINES = 4;
const READ_HEAD_LINES = 3;
const READ_TAIL_LINES = 5;
const DIFF_MAX_LINES = 20;
/**
* 按工具家族给不同默认展开高度。
* @param toolName - 工具名（家族判定经 getToolFamily）。
* @returns 折叠态默认显示的输出行数上限。
*/
function getDefaultMaxLines(toolName) {
	switch (getToolFamily(toolName).family) {
		case "run": return 8;
		case "find": return 6;
		case "write": return DIFF_MAX_LINES;
		case "read": return 8;
		default: return DEFAULT_MAX_LINES;
	}
}
/**
* 标题动词：family verb 首字母大写（Run/Read/Patch/Write/Search/Find…）。
* @param toolName - 工具名（家族判定经 getToolFamily）。
* @returns 首字母大写的标题动词。
*/
function toolTitleVerb(toolName) {
	const verb = getToolFamily(toolName).verb;
	return verb.charAt(0).toUpperCase() + verb.slice(1);
}
/**
* 标题行文本（无色）：`Run(npm test)` 或 `Read(foo.ts)`。
* @param toolName - 工具名（决定标题动词）。
* @param toolInput - 工具输入参数（经 toolArgSummary 摘录主参数）。
* @param rawPath - 原始文件路径；无参数摘要时回退取其 basename。
* @returns 有参数摘要时 `Verb(arg)`，否则仅动词。
*/
function toolCardTitle(toolName, toolInput, rawPath) {
	const verb = toolTitleVerb(toolName);
	let arg = toolInput ? toolArgSummary(toolName, toolInput) : "";
	/* v8 ignore next -- split('/') 恒返回非空数组，pop() 恒有值；noUncheckedIndexedAccess 收窄防御 */
	if (!arg && rawPath) arg = rawPath.split("/").pop() ?? rawPath;
	return arg ? `${verb}(${arg})` : verb;
}
/**
* 缩进工具卡 body 行：第一行 `⎿  `（dim 着色），后续行对齐缩进。
* formatToolCard 与 presenter 卡（tool-view-card.ts）共用的卡片体语汇。
* @param bodyLines - 已着色的 body 行。
* @param indent - 卡片整体缩进前缀（工具链树形层级）。
* @param theme - 当前主题。
* @returns 缩进后的行数组。
*/
function indentToolBody(bodyLines, indent, theme) {
	return indentLiveCardBody(bodyLines, indent, theme);
}
/**
* 工具卡标题行：`› Verb(arg) (1.2s)` 形态，bullet 形色双通道（16 色终端
* 与红绿色觉障碍下「成功/失败」不能只靠颜色）。
* @param input - 标题文本与状态。
* @param theme - 当前主题（状态形色与家族着色取语义 token）。
* @returns 单行 ANSI 标题。
*/
function formatToolCardHeader(input, theme) {
	const { toolName, title, isError = false, streaming = false, elapsedMs, indent = "", badge } = input;
	const isQuestion = toolName === "ask_user_question";
	const useAscii = useAsciiGlyphs();
	const bulletColor = isError ? theme.error : isQuestion ? theme.warning : streaming ? theme.dim : theme.success;
	const bulletGlyph = liveCardGlyph(isError ? "error" : isQuestion ? "question" : streaming ? "running" : "success", { ascii: useAscii });
	const tColor = isQuestion ? theme.warning : toolFamilyColor(toolName, theme);
	let header = `${indent}${color(bulletGlyph, bulletColor)} ${color(title, tColor, { bold: true })}`;
	if (streaming) header += ` ${color("…", theme.dim)}`;
	else if (elapsedMs !== void 0) header += ` ${color(`(${formatElapsed$1(elapsedMs)})`, theme.muted)}`;
	if (badge !== void 0) header += ` ${badge}`;
	return header;
}
/**
* 格式化工具卡片为 ANSI 行数组（›/⎿ 结构）。
* @param input - 工具名、输出内容与折叠/展开等渲染选项。
* @param theme - 当前主题（状态形色与家族着色取语义 token）。
* @returns ANSI 行数组：标题行 + 按截断策略折叠的 body 行。
*/
function formatToolCard(input, theme) {
	const { toolName, content, isError = false, depth = 0, rawPath, elapsedMs, streaming = false, toolInput, expanded = false } = input;
	const family = getToolFamily(toolName);
	const indent = depth > 0 ? "  ".repeat(depth) : "";
	const isQuestion = toolName === "ask_user_question";
	const lines = [formatToolCardHeader({
		toolName,
		title: toolCardTitle(toolName, toolInput, rawPath),
		isError,
		streaming,
		...elapsedMs === void 0 ? {} : { elapsedMs },
		indent
	}, theme)];
	const trimmed = content.replace(/\n+$/, "");
	if (!trimmed) {
		lines.push(`${indent}${color(LIVE_CARD_BODY_FIRST, theme.dim)}${color("(无输出)", theme.muted)}`);
		return lines;
	}
	if (family.family === "write" && isDiffContent(trimmed)) {
		const stats = computeDiffStats(trimmed);
		const changeCount = stats.adds + stats.dels;
		if (changeCount <= 10 || expanded) {
			const diffLines = formatDiff({
				content: trimmed,
				maxLines: Number.MAX_SAFE_INTEGER
			}, theme);
			lines.push(...indentToolBody(diffLines, indent, theme));
		} else {
			const summary = `⎿ ${stats.hunks > 0 ? `${stats.hunks} 处修改` : `${changeCount} 行修改`} (+${stats.adds} −${stats.dels})`;
			lines.push(`${indent}${color(LIVE_CARD_BODY_FIRST, theme.dim)}${color(summary, theme.muted)}`);
		}
		return lines;
	}
	const contentLines = trimmed.split("\n");
	const totalLines = contentLines.length;
	const maxLines = input.maxLines ?? getDefaultMaxLines(toolName);
	const bodyColor = isError ? theme.error : isQuestion ? theme.warning : theme.muted;
	const renderLine = (l) => color(l, bodyColor);
	if (expanded || isQuestion || totalLines <= maxLines) {
		lines.push(...indentToolBody(contentLines.map(renderLine), indent, theme));
		if (rawPath && !expanded)
 /* v8 ignore next -- split('/') 恒返回非空数组，pop() 恒有值；noUncheckedIndexedAccess 收窄防御 */
		lines.push(`${indent}   ${color(`raw: ${rawPath.split("/").pop() ?? rawPath}`, theme.muted)}`);
		return lines;
	}
	if (family.family === "read") {
		const head = contentLines.slice(0, READ_HEAD_LINES);
		const tail = contentLines.slice(-5);
		const omitted = totalLines - READ_HEAD_LINES - READ_TAIL_LINES;
		const body = [
			...head.map(renderLine),
			color(truncationHint(omitted), theme.secondary),
			...tail.map(renderLine)
		];
		lines.push(...indentToolBody(body, indent, theme));
		return lines;
	}
	const head = contentLines.slice(0, maxLines);
	const omitted = totalLines - maxLines;
	const body = [...head.map(renderLine), color(truncationHint(omitted), theme.secondary)];
	lines.push(...indentToolBody(body, indent, theme));
	return lines;
}
/**
* live 区进行中工具的渲染：dim `⠋` 标题行 + 末 N 行输出（⎿ 缩进）。
* @param input - 工具名、流式输出 tail、耗时与终端列数等。
* @param theme - 当前主题。
* @returns ANSI 行数组：标题行 + tailLines 行（compact 模式仅标题行）。
*/
function formatToolCardLive(input, theme) {
	const title = input.title ?? toolCardTitle(input.toolName, input.toolInput);
	let header = `${color(liveCardGlyph("running", {
		ascii: useAsciiGlyphs(),
		...input.tick === void 0 ? {} : { tick: input.tick }
	}), theme.dim)} ${color(title, toolFamilyColor(input.toolName, theme), { bold: true })}`;
	if (input.elapsedMs !== void 0 && input.elapsedMs >= 1e3) header += ` ${color(`(${formatElapsed$1(input.elapsedMs)})`, theme.muted)}`;
	const lines = [header];
	if (input.compact === true) return lines;
	if (input.expanded === true && input.toolInput !== void 0 && Object.keys(input.toolInput).length > 0) {
		const argsText = JSON.stringify(input.toolInput);
		lines.push(`${color(LIVE_CARD_BODY_FIRST, theme.dim)}${color(truncateToDisplayWidth(argsText, Math.max(10, input.columns - 6)), theme.muted)}`);
	}
	const tailRows = input.outputTailLines ?? (() => {
		const tail = (input.outputTail ?? "").replace(/\n+$/, "");
		return tail ? tail.split("\n") : void 0;
	})();
	const tailCount = Math.max(0, input.tailLines ?? 3);
	const maxWidth = Math.max(10, input.columns - 3);
	const tailLines = [];
	if (tailCount > 0 && tailRows && tailRows.length > 0) {
		const shown = tailRows.slice(-tailCount).map((l) => {
			const ellW = displayWidth("…", WIDE$1);
			return color(displayWidth(l, WIDE$1) > maxWidth ? `${truncateToDisplayWidth(l, maxWidth - ellW, WIDE$1)}…` : l, theme.muted);
		});
		tailLines.push(...indentToolBody(shown, "", theme));
	}
	if (tailCount > 0 && tailLines.length === 0) tailLines.push(`${color(LIVE_CARD_BODY_FIRST, theme.dim)}${color("…", theme.dim)}`);
	while (tailLines.length < tailCount) tailLines.unshift("   ");
	lines.push(...tailLines);
	return lines;
}
//#endregion
//#region lib/types/format/tool-view-card.js
/**
* presenter 卡渲染 — 消费 harness 工具声明的结构化渲染意图
* （dsh-tools presentation.ts 的 ToolCallView/ToolResultView），把 diff /
* terminal 卡渲染为 ANSI 行；generic 与其余卡型（search/read/web，二批
* 结构化）回落 formatToolCard 的文本折叠。
*
* 与 formatToolCard 的关系：本模块是「结构化意图优先」的分派层——意图
* 缺失（工具无 presenter / 桥软降级）时整体回落文本卡；标题行与 body
* 缩进语汇（formatToolCardHeader / indentToolBody）两者共用。
*
* diff 卡不渲染行号 gutter：FileDiff 不携带原始行号（fs 的逐 hunk meta
* 已剥掉 hunk 起点），伪造 1 起的行号会误导，+/− 前缀是诚实的双通道。
*/
/** diff 上下文行数（与 fs 工具 meta 的逐 hunk 上下文口径一致）。 */
const DIFF_CONTEXT_LINES = 3;
/** 折叠阈值：增删行合计超过此数折叠为统计行（与 formatToolCard diff 嗅探分支同口径）。 */
const DIFF_FOLD_CHANGES = 10;
/** 单个 FileDiff 正文行数上限（折叠态；与 tool-card write 族 DIFF_MAX_LINES 同口径）。 */
const DIFF_MAX_BODY_LINES = 20;
/** terminal 卡标题里命令的截断长度（与 toolArgSummary 的 bash 口径一致）。 */
const COMMAND_TITLE_MAX = 55;
/** structuredPatch 一个 hunk 的行 → DiffRow（`\ No newline` 标注是补丁元信息，剥掉）。 */
function hunkRows(lines) {
	const rows = [];
	for (const line of lines) {
		if (line.startsWith("\\")) continue;
		const text = line.slice(1);
		if (line.startsWith("+")) rows.push({
			kind: "add",
			text
		});
		else if (line.startsWith("-")) rows.push({
			kind: "del",
			text
		});
		else rows.push({
			kind: "ctx",
			text
		});
	}
	return rows;
}
/** 一个 FileDiff 的行序列：纯新建全为 add；否则 Myers（structuredPatch）逐 hunk，hunk 间插 gap。 */
function fileDiffRows(diff) {
	if (diff.oldText === null) return diff.newText.replace(/\n$/, "").split("\n").map((text) => ({
		kind: "add",
		text
	}));
	const patch = structuredPatch(diff.path, diff.path, diff.oldText, diff.newText, void 0, void 0, { context: DIFF_CONTEXT_LINES });
	const rows = [];
	for (const hunk of patch.hunks) {
		if (rows.length > 0) rows.push({
			kind: "gap",
			text: ""
		});
		rows.push(...hunkRows(hunk.lines));
	}
	return rows;
}
/**
* 多个 FileDiff 的增删统计（折叠阈值与统计行数据源）。
* @param diffs - presenter 产出的文件级 diff 列表。
* @returns 增/删行计数。
*/
function fileDiffStats(diffs) {
	let adds = 0;
	let dels = 0;
	for (const diff of diffs) for (const row of fileDiffRows(diff)) if (row.kind === "add") adds++;
	else if (row.kind === "del") dels++;
	return {
		adds,
		dels
	};
}
/**
* 渲染一个结构化 {@link FileDiff} 为着色行数组：`+` 绿 / `-` 红 /
* 上下文 muted，hunk 间以 dim `⋯` 分隔；新建文件（oldText null）全为
* 添加行。审批预览（permission-diff.ts）与结算卡共用此渲染。
* @param diff - 单文件 diff（oldText null = 新建/覆盖，无前像可比）。
* @param options - 行数上限。
* @param theme - 当前主题。
* @returns ANSI 行数组；old/new 相同（无 hunk）时为空数组。
*/
function renderFileDiff(diff, options, theme) {
	const rows = fileDiffRows(diff);
	const render = (row) => {
		switch (row.kind) {
			case "add": return color(`+ ${row.text}`, theme.success);
			case "del": return color(`- ${row.text}`, theme.error);
			case "ctx": return color(`  ${row.text}`, theme.muted);
			case "gap": return color("⋯", theme.dim);
		}
	};
	const rendered = rows.map(render);
	const maxLines = options.maxLines;
	if (maxLines === void 0 || rendered.length <= maxLines) return rendered;
	const head = Math.floor(maxLines / 2);
	return [
		...rendered.slice(0, head),
		color(hiddenLinesMarker(rendered.length - maxLines), theme.secondary),
		...rendered.slice(rendered.length - (maxLines - head))
	];
}
/** 超长截断（显示语义同 toolArgSummary）。 */
function clip(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** diff 结算卡：标题 + 红绿正文（大改动折叠为统计行）。 */
function diffCard(input, view, theme) {
	const toolInput = parseToolArguments(input.argumentsRaw);
	const title = view.title ?? input.callView?.title ?? toolCardTitle(input.toolName, toolInput);
	const lines = [formatToolCardHeader({
		toolName: input.toolName,
		title,
		isError: input.isError,
		...input.elapsedMs === void 0 ? {} : { elapsedMs: input.elapsedMs }
	}, theme)];
	const { adds, dels } = fileDiffStats(view.diffs);
	const statsLine = color(`${view.diffs.length} 处修改 (+${adds} −${dels})`, theme.muted);
	if (input.compact === true || input.expanded !== true && adds + dels > DIFF_FOLD_CHANGES) {
		lines.push(...indentToolBody([statsLine], "", theme));
		return lines;
	}
	const multiPath = new Set(view.diffs.map((d) => d.path)).size > 1;
	const body = [];
	for (const diff of view.diffs) {
		if (body.length > 0) body.push(color("⋯", theme.dim));
		if (multiPath) body.push(color(diff.path, theme.warning));
		body.push(...renderFileDiff(diff, input.expanded === true ? {} : { maxLines: DIFF_MAX_BODY_LINES }, theme));
	}
	if (body.length === 0) body.push(color("(无变更)", theme.muted));
	lines.push(...indentToolBody(body, "", theme));
	return lines;
}
/** terminal 结算卡：命令标题 + exit/signal 徽标 + cwd 头 + 折叠输出体。 */
function terminalCard(input, view, theme) {
	const toolInput = parseToolArguments(input.argumentsRaw);
	const command = view.title ?? (input.callView?.card === "terminal" ? input.callView.title : void 0);
	const title = command === void 0 ? toolCardTitle(input.toolName, toolInput) : `${toolTitleVerb(input.toolName)}(${clip(command.split("\n")[0] ?? command, COMMAND_TITLE_MAX)})`;
	const badge = view.signal !== void 0 ? color(`[${view.signal}]`, theme.warning) : view.exitCode !== void 0 && view.exitCode !== 0 ? color(`[exit ${view.exitCode}]`, theme.error) : void 0;
	const lines = [formatToolCardHeader({
		toolName: input.toolName,
		title,
		isError: input.isError,
		...input.elapsedMs === void 0 ? {} : { elapsedMs: input.elapsedMs },
		...badge === void 0 ? {} : { badge }
	}, theme)];
	if (input.compact === true) return lines;
	const body = [];
	if (input.callView?.card === "terminal" && input.callView.cwd !== void 0) body.push(color(`cwd: ${input.callView.cwd}`, theme.dim));
	const output = (view.output ?? input.content).replace(/\n+$/, "");
	const bodyColor = input.isError ? theme.error : theme.muted;
	if (!output) body.push(color("(无输出)", theme.muted));
	else {
		const rows = output.split("\n");
		const maxLines = getDefaultMaxLines(input.toolName);
		if (input.expanded === true || rows.length <= maxLines) body.push(...rows.map((row) => color(row, bodyColor)));
		else {
			body.push(...rows.slice(0, maxLines).map((row) => color(row, bodyColor)));
			body.push(color(truncationHint(rows.length - maxLines), theme.secondary));
		}
	}
	lines.push(...indentToolBody(body, "", theme));
	return lines;
}
/** GenericResultView 的 content 块折叠为显示文本（text 块拼接；无 text 块回落 undefined）。 */
function foldViewContent(view) {
	if (view.content === void 0) return void 0;
	const text = view.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	return text === "" ? void 0 : text;
}
/**
* 结算工具卡总入口：按 presentResult 意图分派 diff / terminal 结构化卡；
* generic 与其余卡型（search/read/web 二批结构化）回落 formatToolCard
* 文本折叠（generic 的 content 块覆盖模型面文本）。
* @param input - 调用事实 + 渲染意图（桥产物，可全缺省）。
* @param theme - 当前主题。
* @returns ANSI 行数组（标题行 + 卡片体）。
*/
function formatToolViewCard(input, theme) {
	const view = input.resultView;
	if (view !== void 0) {
		if (view.card === "diff") return diffCard(input, view, theme);
		if (view.card === "terminal") return terminalCard(input, view, theme);
	}
	const override = view?.card === "generic" ? foldViewContent(view) : void 0;
	const toolInput = parseToolArguments(input.argumentsRaw);
	return formatToolCard({
		toolName: input.toolName,
		content: override ?? input.content,
		isError: input.isError,
		...toolInput === void 0 ? {} : { toolInput },
		...input.elapsedMs === void 0 ? {} : { elapsedMs: input.elapsedMs },
		...input.expanded === void 0 ? {} : { expanded: input.expanded }
	}, theme);
}
/** 亮度插值量化档数：限制每帧的转义段数（≤ 档数 + 1 段）。 */
const MIX_STEPS = 7;
/** RGB 元组 → `#rrggbb`。 */
function rgbToHex(rgb) {
	const part = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
	return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}
/**
* 两个 hex 颜色的线性插值。
* @param a - 起点色（hex）。
* @param b - 终点色（hex）。
* @param t - 插值系数（0 = a，1 = b；范围外截断）。
* @returns 插值后的 `#rrggbb`；任一输入不可解析时原样返回 `a`。
*/
function mixHex(a, b, t) {
	const ra = hexToRgb(a);
	const rb = hexToRgb(b);
	if (ra === null || rb === null) return a;
	const k = Math.max(0, Math.min(1, t));
	return rgbToHex([
		ra[0] + (rb[0] - ra[0]) * k,
		ra[1] + (rb[1] - ra[1]) * k,
		ra[2] + (rb[2] - ra[2]) * k
	]);
}
/**
* 光带高亮色派生：base 向白色混合 ~65%（GIF 光带的提亮感），不硬编码
* GIF 原色以保持主题一致性。
* @param base - 基色（主题语义 token）。
* @returns 提亮后的 hex；base 不可解析（16 色轨）时原样返回。
*/
function shimmerHighlight(base) {
	return mixHex(base, "#ffffff", .65);
}
/**
* 渲染一帧 shimmer 行：光带中心随 tick 从文本左侧 band 列外扫到右侧
* band 列外（进出场与 GIF 的循环「熄灭」帧一致），带内字符按与中心的
* 显示列距离做余弦衰减插值。
* @param input - 文本、tick 与颜色参数。
* @returns 单行 ANSI 串（末尾 RESET）；base/highlight 任一不可解析时
*   降级为静态 base 色整行。
*/
function shimmerLine(input) {
	const base = hexToRgb(input.base);
	const highlight = hexToRgb(input.highlight);
	if (base === null || highlight === null) return color(input.text, input.base);
	const period = Math.max(1, input.periodTicks ?? 15);
	const band = Math.max(1, input.bandCols ?? 6);
	const cols = displayWidth(input.text);
	const center = (input.tick % period + period) % period / period * (cols + 2 * band) - band;
	let out = "";
	let col = 0;
	let lastSeq = "";
	for (const ch of input.text) {
		const w = displayWidth(ch);
		const mid = col + w / 2;
		col += w;
		const dist = Math.abs(mid - center);
		const raw = dist >= band ? 0 : .5 * (1 + Math.cos(Math.PI * dist / band));
		const t = Math.round(raw * MIX_STEPS) / MIX_STEPS;
		const seq = fg(rgbToHex([
			base[0] + (highlight[0] - base[0]) * t,
			base[1] + (highlight[1] - base[1]) * t,
			base[2] + (highlight[2] - base[2]) * t
		]));
		if (seq !== lastSeq) {
			out += seq;
			lastSeq = seq;
		}
		out += ch;
	}
	return `${out}${ANSI.RESET}`;
}
/**
* 推理尾巴随终端高度缩放：矮窗不少于 {@link REASONING_TAIL_LINES}，
* 高窗不超过 {@link REASONING_ROWS_MAX}。按显示行预算，避免长句 wrap 撑破定高视口。
*/
function reasoningTailBudget(rows) {
	return Math.max(3, Math.min(6, Math.floor((rows || 24) / 6)));
}
/** 宽度口径：与 tool-card / LiveEngine.rowsForLine 一致（CJK + ambiguous 按宽）。 */
const WIDE = { ambiguousAsWide: true };
/** 思考头行 glyph（Claude Code 视觉词汇）。 */
const HEADER_GLYPH$1 = "✻";
/** 头行文本（无色）：`✻ 思考中… (3.2s)` / `✻ 思考 (3.2s) · 12 行`。 */
function headerText(active, elapsedMs, lineCount) {
	const label = active ? "思考中…" : "思考";
	const elapsed = elapsedMs === void 0 ? "" : ` (${formatElapsed$1(elapsedMs)})`;
	const lines = lineCount === void 0 ? "" : ` · ${lineCount} 行`;
	return `${HEADER_GLYPH$1} ${label}${elapsed}${lines}`;
}
/** 非空逻辑行数（折叠头行的隐藏内容提示；空文本 0）。 */
function contentLineCount(text) {
	return text.split("\n").filter((line) => line.trim() !== "").length;
}
/**
* 自尾部收取 wrap 后的显示行，使总数不超过 budget。
* 长句先按列宽切开再取尾，避免一整段逻辑行撑破 3–6 行定高。
*/
function tailWithinRows(textLines, budget, width) {
	const limit = Math.max(1, budget);
	const col = Math.max(10, width);
	const wrapped = [];
	for (const line of textLines) {
		const parts = wrapToDisplayWidth(line, col, WIDE);
		if (parts.length === 0) wrapped.push("");
		else wrapped.push(...parts);
	}
	return wrapped.slice(-limit);
}
/**
* live 区流式推理段：shimmer 头行 +（非展开时）尾 N 行暗色推理文本
* （N = {@link FormatReasoningLiveInput.maxRows}，缺省 {@link REASONING_TAIL_LINES}；
* wrap 后按显示行封顶）。展开时渲染全部推理行。
* @param input - 推理文本、tick、耗时与终端列数。
* @param theme - 当前主题（头行基色取 primary；16 色轨自动静态降级）。
* @returns ANSI 行数组：头行 +（非紧凑时）尾巴/全文行。
*/
function formatReasoningLive(input, theme) {
	const lines = [shimmerLine({
		text: headerText(true, input.elapsedMs !== void 0 && input.elapsedMs >= 1e3 ? input.elapsedMs : void 0),
		tick: input.tick,
		base: theme.primary,
		highlight: shimmerHighlight(theme.primary)
	})];
	if (input.compact === true) return lines;
	const trimmed = input.text.replace(/\n+$/, "");
	if (!trimmed) return lines;
	const maxWidth = Math.max(10, input.columns - 3);
	const logical = trimmed.split("\n");
	const budget = Math.max(1, input.maxRows ?? 3);
	const rows = input.expanded === true ? logical : tailWithinRows(logical, budget, maxWidth);
	for (const row of rows) lines.push(`  ${color(row, theme.dim, { italic: true })}`);
	return lines;
}
/**
* 结算推理块（scrollback 落底形态）：静态头行（shimmer 冻结为 dim，与
* GIF 循环的「熄灭」帧一致）。默认折叠——只落头行（含隐藏行数提示），
* 正文经 expanded 展开渲染（对标竞品：思考默认收起，按需查看全文）。
* @param input - 推理全文、总耗时与折叠/展开/紧凑开关。
* @param theme - 当前主题。
* @returns ANSI 行数组：头行 +（expanded 且非 compact 时）全文行；空文本仅头行。
*/
function formatReasoningBlock(input, theme) {
	const lineCount = contentLineCount(input.text);
	const lines = [color(headerText(false, input.elapsedMs, lineCount === 0 ? void 0 : lineCount), theme.dim, { italic: true })];
	if (input.compact === true || input.expanded !== true) return lines;
	const trimmed = input.text.replace(/\n+$/, "");
	if (!trimmed) return lines;
	for (const row of trimmed.split("\n")) lines.push(row === "" ? "" : `  ${color(row, theme.muted, { italic: true })}`);
	return lines;
}
//#endregion
//#region lib/types/actions/registry.js
/**
* actions/registry — 动作注册表：match + 同域键位冲突校验 + confirmMs 双击布防。
*
* - match：注册序返回首个「绑定命中且 when 通过」的动作（同键多动作靠 when
*   与注册序分流，如 Esc 的打断/关面板/双击 rewind 三连）。
* - 冲突校验（对标 Codex validate_conflicts）：同 context + 键位重叠 +
*   双方均无 when 守卫 → 登记即抛错（无守卫的同键重复必是笔误）。
* - confirmMs 布防：双击确认窗口的布防时间戳集中在此（原 app.ts 的
*   ctrlCPendingSince / escRewindPendingSince 两个散字段）；sweepConfirms
*   在每次键路由入口清扫——非触发键到达即撤防（对齐原「非同键打断」语义）。
*
* @module @deepseek-ai/dsh-tianshu-tui/actions/registry
*/
/** 双击 Esc 触发 rewind 的确认窗口（ms；对齐 Claude Code Esc+Esc 时间回溯）。 */
const REWIND_DOUBLE_ESC_MS = 1e3;
/** 空闲 Ctrl+C 连按退出的确认窗口（ms；「再按 Ctrl+C 退出」提示同源）。 */
const EXIT_WINDOW_MS = 2e3;
/** 绑定命中判定：给定字段全部相等（缺省字段不约束——{name:'up'} 不区分 meta）。 */
function matchesBinding(binding, key) {
	if (binding.name !== void 0 && key.name !== binding.name) return false;
	if (binding.char !== void 0 && key.char !== binding.char) return false;
	if (binding.meta !== void 0 && key.meta !== binding.meta) return false;
	return true;
}
/**
* 两绑定是否可能命中同一个键：name/char/meta 双方都指定的字段须一致；
* 一方指定 name 另一方指定 char 的交叉情形，仅当 name 为 'unknown'（可打印
* 字符的到达名）时才可能同键命中——具体控制名（ctrl_n 等）到达时 char 恒为
* ''，与 char 绑定不可能同键到达。
*/
function bindingsOverlap(a, b) {
	if (a.name !== void 0 && b.name !== void 0 && a.name !== b.name) return false;
	if (a.char !== void 0 && b.char !== void 0 && a.char !== b.char) return false;
	if (a.meta !== void 0 && b.meta !== void 0 && a.meta !== b.meta) return false;
	if (a.name !== void 0 && b.char !== void 0 && a.name !== "unknown") return false;
	if (b.name !== void 0 && a.char !== void 0 && b.name !== "unknown") return false;
	return true;
}
/**
* 同域键位冲突校验：同 context（缺省 global）+ 键位重叠 + 双方均无 when 守卫
* → 抛错。任一方有 when 视为有意的优先级分流（运行时按注册序消解），放行。
* @param actions - 待校验动作表。
* @throws 发现冲突时抛出携带双方 id 的错误。
*/
function validateActionConflicts(actions) {
	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		/* v8 ignore next -- 下标恒在界内；noUncheckedIndexedAccess 防御 */
		if (a === void 0) continue;
		for (let j = i + 1; j < actions.length; j++) {
			const b = actions[j];
			/* v8 ignore next -- 同上 */
			if (b === void 0) continue;
			if ((a.context ?? "global") !== (b.context ?? "global")) continue;
			if (a.when !== void 0 || b.when !== void 0) continue;
			if (a.keys.some((ka) => b.keys.some((kb) => bindingsOverlap(ka, kb)))) throw new Error(`action 键位冲突: ${a.id} 与 ${b.id}（同域同键且均无 when 守卫）`);
		}
	}
}
/**
* 动作注册表：登记（含冲突校验）、按键匹配、confirmMs 双击布防。
* 动作表只读消费（list/get 给投影层）；布防状态随键路由演进。
*/
var ActionRegistry = class {
	actions = [];
	/** confirmMs 布防时间戳（action id → armed at；缺失 = 未布防）。 */
	confirms = /* @__PURE__ */ new Map();
	constructor(actions = []) {
		for (const action of actions) this.register(action);
	}
	/**
	* 登记动作：同 id 重复或引入同域键位冲突即抛错（构造期 fails loud）。
	* @param action - 动作条目。
	*/
	register(action) {
		if (this.actions.some((a) => a.id === action.id)) throw new Error(`action id 重复: ${action.id}`);
		validateActionConflicts([...this.actions, action]);
		this.actions.push(action);
	}
	/** 全部动作（注册序；keymap/footer 投影数据源）。 */
	list() {
		return this.actions;
	}
	/** 按 id 取动作（confirmMs 窗口查询与投影锚点用）。 */
	get(id) {
		return this.actions.find((a) => a.id === id);
	}
	/**
	* 键位匹配：注册序首个「绑定命中且 when 通过」的动作；无命中返回 null。
	* @param key - 按键事件。
	* @param ctx - when 守卫读取的操作面。
	* @param opts - 相位/作用域过滤。
	*/
	match(key, ctx, opts) {
		for (const action of this.actions) {
			if (opts?.phase !== void 0 && (action.phase ?? "main") !== opts.phase) continue;
			if (opts?.context !== void 0 && (action.context ?? "global") !== opts.context) continue;
			if (!action.keys.some((binding) => matchesBinding(binding, key))) continue;
			if (action.when !== void 0 && !action.when(ctx)) continue;
			return action;
		}
		return null;
	}
	/**
	* 双击布防清扫（每次键路由入口调用）：非某 confirmMs 动作触发键的键到达
	* → 撤防该动作（对齐原「任何非 Ctrl+C 键清 ctrlCPendingSince」语义）。
	* @param key - 本次到达的按键。
	*/
	sweepConfirms(key) {
		for (const action of this.actions) {
			if (action.confirmMs === void 0) continue;
			if (!action.keys.some((binding) => matchesBinding(binding, key))) this.confirms.delete(action.id);
		}
	}
	/** 布防（首次触发记录时间戳）。 */
	confirmArm(id, now) {
		this.confirms.set(id, now);
	}
	/**
	* 窗口内已布防（窗口取自动作定义的 confirmMs；动作缺失或未声明窗口恒 false）。
	* @returns true = 本次为窗口内第二次触发。
	*/
	confirmWithin(id, now) {
		const since = this.confirms.get(id);
		const windowMs = this.get(id)?.confirmMs;
		if (since === void 0 || windowMs === void 0) return false;
		return now - since < windowMs;
	}
	/** 撤防。 */
	confirmDisarm(id) {
		this.confirms.delete(id);
	}
	/** 布防时间戳（「再按 Ctrl+C 退出」提示行数据源）；未布防为 0。 */
	confirmSince(id) {
		return this.confirms.get(id) ?? 0;
	}
};
//#endregion
//#region lib/types/actions/builtin-actions.js
/**
* actions/builtin-actions — 内置键位动作表（TuiApp.handleKey 原 if 链的动作化）。
*
* 每条动作对应原 handleKey 的一段分支，相位（phase）对齐原分支的相对位置：
* - early（overlay 委派之前）：空 Enter 工具卡、shift_tab 三态循环、ctrl_n/s/q、
*   ctrl_p 命令面板、ctrl_. 快捷键面板、ctrl_f 历史搜索。
* - main（阻塞上下文轮询之后）：esc 三连（打断 > 关 inspect > 双击 rewind 布防）、
*   ctrl_c（打断/清空/双击退出）、ctrl_o 推理展开、editorKey 外部编辑器、
*   ctrl_t 转向、ctrl_return 插队（cancel-and-send）、ctrl_v 粘贴。
* - tail（slash 菜单与 inspect 上下文键之后）：空 Tab 命令菜单、Alt+Backspace
*   删附件、↑↓ 排队取回/历史透传。
* approval 域（y/p/t/a/n/f/esc）只经 approval 阻塞上下文轮询，不参与常规 match。
*
* run 只经 ActionContext 触达 TuiApp（装配件在 ui/app.ts）；本模块不 import app。
*
* @module @deepseek-ai/dsh-tianshu-tui/actions/builtin-actions
*/
/**
* 内置动作表（注册序即 match 优先级）。keymap 投影行序由 keymapOrder 承担
* （10/20/130/160/180/190 留给 keymap-panel 的输入层静态补充行）。
* @param options - 装配选项（editorKey）。
* @returns 动作数组（喂 ActionRegistry）。
*/
function createBuiltinActions(options) {
	return [
		{
			id: "tool.toggle-latest",
			keys: [{ name: "return" }],
			when: (ctx) => ctx.inputEmpty() && ctx.hasPendingToolCard(),
			phase: "early",
			category: "工具",
			hint: "展开/收起最新工具卡",
			keymapHidden: true,
			run: (ctx) => {
				ctx.toggleLatestToolCard();
			}
		},
		{
			id: "mode.cycle",
			keys: [{ name: "shift_tab" }],
			phase: "early",
			category: "模式",
			hint: "模式循环 normal→plan→always-approve",
			keymapOrder: 150,
			run: (ctx) => {
				ctx.cycleMode();
			}
		},
		{
			id: "session.new",
			keys: [{ name: "ctrl_n" }],
			phase: "early",
			category: "会话",
			hint: "新会话",
			keymapOrder: 30,
			run: (ctx) => {
				ctx.newSession();
			}
		},
		{
			id: "session.restore",
			keys: [{ name: "ctrl_s" }],
			phase: "early",
			category: "会话",
			hint: "恢复最近会话",
			keymapOrder: 40,
			run: (ctx) => {
				ctx.restoreRecentSession();
			}
		},
		{
			id: "app.quit",
			keys: [{ name: "ctrl_q" }],
			phase: "early",
			category: "会话",
			hint: "退出",
			keymapOrder: 50,
			run: (ctx) => {
				ctx.requestExit();
			}
		},
		{
			id: "palette.toggle",
			keys: [{ name: "ctrl_p" }],
			phase: "early",
			category: "面板",
			hint: "命令面板",
			keymapOrder: 60,
			run: (ctx) => {
				ctx.togglePalette();
			}
		},
		{
			id: "keymap.toggle",
			keys: [{ name: "ctrl_." }],
			phase: "early",
			category: "面板",
			hint: "快捷键面板",
			keymapOrder: 70,
			run: (ctx) => {
				ctx.toggleKeymap();
			}
		},
		{
			id: "search.toggle",
			keys: [{ name: "ctrl_f" }],
			when: (ctx) => !ctx.paletteOpen(),
			phase: "early",
			category: "面板",
			hint: "历史搜索（Enter 确认后 n/N 跳转）",
			keysLabel: "Ctrl+F / Ctrl+R",
			keymapOrder: 80,
			run: (ctx) => {
				ctx.toggleHistorySearch();
			}
		},
		{
			id: "session.abort",
			keys: [{ name: "escape" }],
			when: (ctx) => !ctx.slashMenuOpen() && ctx.isRunning(),
			category: "会话",
			hint: "打断当前回合",
			keymapHidden: true,
			run: (ctx) => {
				ctx.abort();
			}
		},
		{
			id: "inspect.close",
			keys: [{ name: "escape" }],
			when: (ctx) => !ctx.slashMenuOpen() && ctx.inspectAny(),
			category: "面板",
			hint: "关闭检查面板",
			keymapHidden: true,
			footerHint: "esc 关闭",
			run: (ctx) => {
				ctx.inspectClose();
				ctx.confirmDisarm("session.rewind");
			}
		},
		{
			id: "session.rewind",
			keys: [{ name: "escape" }],
			when: (ctx) => !ctx.slashMenuOpen() && !ctx.inspectAny() && !ctx.vimNormalEsc() && !ctx.inAbortGrace(Date.now()),
			confirmMs: REWIND_DOUBLE_ESC_MS,
			category: "会话",
			hint: "取消/关闭检查面板（空闲双击 rewind）",
			keymapOrder: 200,
			run: (ctx) => {
				const now = Date.now();
				if (ctx.confirmWithin("session.rewind", now)) {
					ctx.confirmDisarm("session.rewind");
					ctx.rewindSession();
					return true;
				}
				ctx.confirmArm("session.rewind", now);
				ctx.flushLive();
				return false;
			}
		},
		{
			id: "app.interrupt",
			keys: [{ name: "ctrl_c" }],
			confirmMs: EXIT_WINDOW_MS,
			category: "会话",
			hint: "打断当前回合（空闲双击退出）",
			keymapOrder: 140,
			run: (ctx) => {
				const now = Date.now();
				ctx.markCtrlC(now);
				if (ctx.hasExit && ctx.confirmWithin("app.interrupt", now)) {
					ctx.confirmDisarm("app.interrupt");
					ctx.requestExit();
					return;
				}
				if (ctx.isRunning()) {
					ctx.abort();
					if (ctx.hasExit) ctx.confirmArm("app.interrupt", now);
					else ctx.confirmDisarm("app.interrupt");
					ctx.flushLive();
					return;
				}
				if (ctx.inputEmpty() && ctx.hasExit) {
					ctx.confirmArm("app.interrupt", now);
					ctx.flushLive();
					return;
				}
				if (!ctx.inputEmpty()) {
					ctx.clearInput();
					if (ctx.hasExit) ctx.confirmArm("app.interrupt", now);
					ctx.flushLive();
					return;
				}
				ctx.confirmDisarm("app.interrupt");
				ctx.abort();
			}
		},
		{
			id: "reasoning.toggle",
			keys: [{ name: "ctrl_o" }],
			when: (ctx) => ctx.hasReasoning(),
			category: "面板",
			hint: "展开/收起推理块",
			keymapOrder: 90,
			run: (ctx) => {
				ctx.toggleReasoning();
			}
		},
		{
			id: "editor.open",
			keys: [{ name: options.editorKey }],
			category: "输入",
			hint: "外部编辑器",
			keymapOrder: 100,
			run: (ctx) => {
				ctx.openExternalEditor();
			}
		},
		{
			id: "input.steer",
			keys: [{ name: "ctrl_t" }],
			category: "会话",
			hint: "中轮转向",
			keymapOrder: 110,
			run: (ctx) => {
				ctx.steerInput();
			}
		},
		{
			id: "input.cancel-and-send",
			keys: [{ name: "ctrl_return" }],
			when: (ctx) => ctx.isRunning() && !ctx.inputEmpty(),
			category: "会话",
			hint: "打断并立即发送（插队）",
			keysLabel: "Ctrl+Enter",
			keymapOrder: 115,
			requiresKittyKeyboard: true,
			run: (ctx) => {
				ctx.cancelAndSend();
			}
		},
		{
			id: "input.paste-image",
			keys: [{ name: "ctrl_v" }],
			category: "输入",
			hint: "粘贴剪贴板图片/文本",
			keymapOrder: 120,
			run: (ctx) => {
				ctx.pasteClipboard();
			}
		},
		{
			id: "palette.open-menu",
			keys: [{ name: "tab" }],
			when: (ctx) => ctx.inputEmpty(),
			phase: "tail",
			category: "面板",
			hint: "命令菜单",
			keymapHidden: true,
			run: (ctx) => {
				ctx.openPaletteMenu();
			}
		},
		{
			id: "attachment.remove-last",
			keys: [{
				name: "backspace",
				meta: true
			}],
			when: (ctx) => ctx.inputEmpty() && ctx.hasImages(),
			phase: "tail",
			category: "输入",
			hint: "移除末张附件",
			keymapHidden: true,
			run: (ctx) => {
				ctx.removeLastImage();
			}
		},
		{
			id: "history.recall-queued",
			keys: [{ name: "up" }],
			when: (ctx) => ctx.inputEmpty() && ctx.hasQueuedSubmits(),
			phase: "tail",
			category: "输入",
			hint: "取回排队提交",
			keymapHidden: true,
			run: (ctx) => {
				ctx.recallQueuedSubmit();
			}
		},
		{
			id: "history.navigate",
			keys: [{ name: "up" }, { name: "down" }],
			phase: "tail",
			category: "输入",
			hint: "输入历史（菜单打开时为选择；运行中排队时 ↑ 取回队首）",
			keysLabel: "↑/↓",
			keymapOrder: 170,
			run: (ctx, key) => {
				ctx.passHistoryKey(key);
			}
		},
		{
			id: "input.accept-ghost",
			keys: [{ name: "right" }],
			when: (ctx) => ctx.ghostAcceptable(),
			phase: "tail",
			category: "输入",
			hint: "接受历史建议",
			keymapHidden: true,
			run: (ctx) => {
				ctx.acceptGhost();
			}
		},
		{
			id: "approval.allow",
			keys: [{ char: "y" }, { char: "Y" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "允许一次",
			footerHint: "y 允许",
			run: (ctx) => {
				ctx.settleApproval("allowed-once");
			}
		},
		{
			id: "approval.allow-prefix",
			keys: [{ char: "p" }, { char: "P" }],
			when: (ctx) => ctx.approvalPending() && ctx.approvalCommandPrefix() !== null,
			context: "approval",
			category: "工具",
			hint: "此命令前缀不再问",
			footerHint: "p 此命令不再问",
			run: (ctx) => {
				ctx.approveCommandPrefix();
			}
		},
		{
			id: "approval.allow-tool",
			keys: [{ char: "t" }, { char: "T" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "本会话放行此工具",
			footerHint: "t 记住此工具",
			run: (ctx) => {
				ctx.approveToolSession();
			}
		},
		{
			id: "approval.always",
			keys: [{ char: "a" }, { char: "A" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "本会话全部放行",
			footerHint: "a 全放行",
			run: (ctx) => {
				ctx.approveAlways();
			}
		},
		{
			id: "approval.reject",
			keys: [{ char: "n" }, { char: "N" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "拒绝",
			footerHint: "n 拒绝",
			run: (ctx) => {
				ctx.settleApproval("rejected");
			}
		},
		{
			id: "approval.reject-feedback",
			keys: [{ char: "f" }, { char: "F" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "拒绝并说明",
			footerHint: "f 拒绝并说明",
			run: (ctx) => {
				ctx.startApprovalFeedback();
			}
		},
		{
			id: "approval.cancel",
			keys: [{ name: "escape" }, { name: "ctrl_c" }],
			when: (ctx) => ctx.approvalPending(),
			context: "approval",
			category: "工具",
			hint: "取消审批",
			footerHint: "esc 取消",
			run: (ctx) => {
				ctx.settleApproval("cancelled");
			}
		}
	];
}
//#endregion
//#region lib/types/actions/projections.js
/**
* actions/projections — 展示面投影：keymap 条目 / footer 提示段从动作表生成。
*
* 键位提示的三份事实源收敛为动作表后的消费端：
* - projectKeymapEntries：global 域 + keymapOrder 非缺省 + 非 keymapHidden 的
*   动作投影为 keymap 行，与输入层静态补充行（Enter 提交、Ctrl+U 等 InputLine
*   内部键位——不经 action registry 路由）按 order 归并。
* - projectApprovalHints / projectInspectHints：footer 上下文提示段
*   （approval 域动作按注册序取 footerHint）。
*
* @module @deepseek-ai/dsh-tianshu-tui/actions/projections
*/
/** 键位列展示名（keymap 用）：语义名 → 惯用写法。 */
const KEY_LABELS = {
	return: "Enter",
	escape: "Esc",
	tab: "Tab",
	backspace: "Backspace",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	shift_tab: "Shift+Tab",
	space: "Space"
};
/**
* 单绑定展示名：ctrl_n → Ctrl+N、ctrl_. → Ctrl+.、up → ↑；char 绑定取字符本身；
* meta 约束加 Alt+ 前缀。
* @param binding - 键位绑定。
* @returns keymap 键位列文本。
*/
function keyBindingLabel(binding) {
	let base;
	if (binding.name !== void 0) {
		const known = KEY_LABELS[binding.name];
		if (known !== void 0) base = known;
		else if (binding.name.startsWith("ctrl_")) base = `Ctrl+${binding.name.slice(5).toUpperCase()}`;
		else base = binding.name;
	} else base = binding.char ?? "?";
	return binding.meta === true ? `Alt+${base}` : base;
}
/** 动作键位列缺省展示：多绑定以 / 连接（↑/↓）。 */
function keyBindingsLabel(keys) {
	return keys.map(keyBindingLabel).join("/");
}
/**
* keymap 面板条目投影：动作表（global 域、keymapOrder 非缺省、非 keymapHidden）
* 与输入层静态补充行按 order 归并排序。requiresKittyKeyboard 的动作按 caps
* 过滤——终端不支持 kitty 键盘增强时该行隐身（键位本不可达，展示即死键）。
* @param actions - 动作表（registry.list()）。
* @param extra - 输入层静态补充行（带 order 对齐原表序）。
* @param caps - 终端能力面（缺省视为不支持 kitty 键盘增强 → 门控行隐身）。
* @returns 归并排序后的 keymap 条目。
*/
function projectKeymapEntries(actions, extra = [], caps = {}) {
	const rows = [...extra];
	for (const action of actions) {
		if (action.keymapHidden === true || action.keymapOrder === void 0) continue;
		if ((action.context ?? "global") !== "global") continue;
		if (action.requiresKittyKeyboard === true && caps.kittyKeyboard !== true) continue;
		rows.push({
			order: action.keymapOrder,
			keys: action.keysLabel ?? keyBindingsLabel(action.keys),
			action: action.hint
		});
	}
	rows.sort((a, b) => a.order - b.order);
	return rows.map(({ keys, action }) => ({
		keys,
		action
	}));
}
/**
* footer 审批挂起提示段：approval 域动作按注册序投影 footerHint（无 footerHint
* 的动作不进 footer）。传入 ctx 时按各动作 when 守卫过滤——p 键「此命令不再问」
* 仅在前缀可提（bash 类工具）的挂起上出现；审批卡键位行也消费本投影（同源）。
* @param actions - 动作表（registry.list()）。
* @param ctx - 动作执行上下文（缺省不过滤 when，投影静态全集）。
* @returns 提示段文本数组。
*/
function projectApprovalHints(actions, ctx) {
	const hints = [];
	for (const action of actions) {
		if (action.context !== "approval" || action.footerHint === void 0) continue;
		if (ctx !== void 0 && action.when !== void 0 && !action.when(ctx)) continue;
		hints.push(action.footerHint);
	}
	return hints;
}
/**
* footer 检查面板提示段：inspect.close 动作的 footerHint + 静态「/ 命令」尾段
* （/ 斜杠命令不是键位动作，提示文本不入动作表）。
* @param actions - 动作表（registry.list()）。
* @returns 提示段文本数组。
*/
function projectInspectHints(actions) {
	return [actions.find((a) => a.id === "inspect.close")?.footerHint ?? "esc 关闭", "/ 命令"];
}
//#endregion
//#region lib/types/format/keymap-panel.js
/**
* 快捷键面板（grok-build Ctrl+. 键位清单弹层移植）。
*
* 纯函数层：keymapEntries 由 action registry（actions/builtin-actions）投影
* 生成 + 输入层静态补充行（Enter 提交、Ctrl+U 等 InputLine 内部键位不经
* registry 路由）归并，kitty 键盘增强才可达的键位按终端能力（env）过滤——
* 键位提示单一事实来源是动作表。renderKeymapPanel 把条目渲染为两列对齐行
* （键位左列 + 动作右列），窄宽降级为单列紧凑行、超宽截断不破版。TuiApp 把
* 它注册为 overlay 渲染器，Ctrl+. 触发进出。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/keymap-panel
*/
/**
* 输入层静态补充行（InputLine/slash 菜单内部键位，不经 action registry 路由；
* order 与动作表的 keymapOrder 归并对齐原表序）。
*/
const INPUT_LAYER_ROWS = [
	{
		order: 10,
		keys: "Enter",
		action: "发送"
	},
	{
		order: 20,
		keys: "Shift+Enter",
		action: "换行（或 \\+Enter 续行）"
	},
	{
		order: 130,
		keys: "Ctrl+U",
		action: "删除到行首"
	},
	{
		order: 160,
		keys: "Tab",
		action: "@-路径补全 / 接受 slash 选中项"
	},
	{
		order: 180,
		keys: "PageUp/PageDown",
		action: "slash 菜单翻页"
	},
	{
		order: 190,
		keys: "Alt+W",
		action: "复制选区到系统剪贴板（OSC52）"
	}
];
/**
* 当前实现的完整快捷键表（新增键位时在 actions/builtin-actions 登记，面板自动跟随）。
* 与 README 快捷键表同源维护；审批卡的 y/N/a/Ctrl+C 为上下文键位（context:
* 'approval'，由审批卡自带提示承担），不在此列。kitty 键盘增强才可达的键位
* （requiresKittyKeyboard，如 Ctrl+Enter）按终端能力过滤——不支持的终端行隐身。
* 渲染期现取（不作模块级缓存）：终端能力读 env，显式注入便于测试确定性。
* @param env - 环境变量（测试注入用，缺省 process.env）。
* @returns 归并排序后的 keymap 条目。
*/
function keymapEntries(env = process.env) {
	return projectKeymapEntries(createBuiltinActions({ editorKey: "ctrl_e" }), INPUT_LAYER_ROWS, { kittyKeyboard: supportsKittyKeyboard(env) });
}
/** 键位列宽：最长键位 + 2 列间隔。 */
function keyColumnWidth(entries) {
	let max = 0;
	for (const entry of entries) {
		const w = displayWidth(entry.keys);
		if (w > max) max = w;
	}
	return max + 2;
}
/**
* 渲染快捷键面板为行数组：标题 + 两列对齐条目。
* 宽度不足时动作列按剩余宽度截断；极端窄宽（连键位列都放不下）降级为
* 紧凑单列 `键位 动作`（不截断键位，动作截断）。
* @param width - 终端列数。
* @param env - 环境变量（终端能力行过滤用，缺省 process.env）。
* @returns ANSI 行数组（无着色——overlay 面板由上层统一取色）。
*/
function renderKeymapPanel(width, env = process.env) {
	const entries = keymapEntries(env);
	const rows = ["快捷键", ""];
	if (width < 12) return rows;
	const keyCol = keyColumnWidth(entries);
	const actionBudget = Math.max(1, width - keyCol - 1);
	for (const entry of entries) {
		if (keyCol >= width) {
			const compact = ` ${entry.keys} ${entry.action}`;
			rows.push(compact.slice(0, width));
			continue;
		}
		const padded = ` ${entry.keys}${" ".repeat(keyCol - displayWidth(entry.keys))}`;
		const action = displayWidth(entry.action) > actionBudget ? truncateByWidth$5(entry.action, actionBudget) : entry.action;
		rows.push(`${padded}${action}`);
	}
	return rows;
}
/** 按显示宽度截断字符串（尾部补 …）。 */
function truncateByWidth$5(text, max) {
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}
//#endregion
//#region lib/types/format/export.js
/**
* /export 会话导出渲染（纯函数，Cordis-free）：session events → Markdown 文本。
* 数据源是会话日志（权威事件流）——导出完整内容（无折叠/截断的渲染视图缺陷）；
* 工具结果超长按 5000 字符截断并附标记。同输入恒同输出（可测）。
* @module @deepseek-ai/dsh-tianshu-tui/format/export
*/
/** 工具结果文本截断上限。 */
const TOOL_RESULT_CAP = 5e3;
/** 抽取消息的文本块（text + reasoning 分离）。 */
function messageText(message) {
	let text = "";
	let reasoning = "";
	for (const block of message.content) switch (block.type) {
		case "text":
			text += block.text;
			break;
		case "reasoning": reasoning += block.text;
	}
	return {
		text,
		reasoning
	};
}
/** 截断超长文本（保留头部 + 尾部 + 标记）。 */
function truncate$1(text, cap) {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n…+${text.length - cap} 字符`;
}
/** 渲染一条工具结果消息（ToolResultMessage 的 content 是 ToolResultBlock 元组）。 */
function renderToolResult(message) {
	return truncate$1(message.content.flatMap((block) => block.type === "tool-result" ? block.content : []).filter((block) => block.type === "text").map((block) => block.text).join(""), TOOL_RESULT_CAP);
}
/**
* 把会话事件渲染为可分享的 Markdown 转录。
* @param events - 会话事件日志（权威数据源）。
* @param meta - 导出头信息。
* @returns 完整 Markdown 文本。
*/
function renderSessionExport(events, meta) {
	const lines = [];
	lines.push(`# Session export — ${meta.sessionId}`);
	if (meta.cwd !== void 0 && meta.cwd !== "") lines.push(`工作区: ${meta.cwd}`);
	lines.push("");
	let count = 0;
	for (const event of events) switch (event.type) {
		case "user/message": {
			const { text } = messageText(event.data);
			if (text !== "") {
				lines.push("## 用户", "", text, "");
				count++;
			}
			break;
		}
		case "assistant/message": {
			const { text, reasoning } = messageText(event.data.message);
			const toolCalls = event.data.message.content.filter((block) => block.type === "tool-call").map((block) => `${block.name}(${block.arguments})`);
			if (text === "" && reasoning === "" && toolCalls.length === 0) break;
			lines.push("## Assistant", "");
			if (reasoning !== "") lines.push(`> 推理: ${reasoning}`, "");
			if (text !== "") lines.push(text, "");
			for (const call of toolCalls) lines.push(`工具调用: \`${call}\``);
			lines.push("");
			count++;
			break;
		}
		case "tool/result": {
			const text = renderToolResult(event.data.message);
			if (text !== "") {
				lines.push("## 工具结果", "", text, "");
				count++;
			}
			break;
		}
	}
	if (count === 0) lines.push("（无消息）");
	return lines.join("\n");
}
//#endregion
//#region lib/types/turn-summary.js
const EMPTY_FAMILY$1 = () => ({
	file: 0,
	shell: 0,
	search: 0,
	edit: 0,
	network: 0,
	other: 0
});
/**
* 空轮级统计（全零计数）。
* @param turn - 轮号。
* @returns 初始统计状态。
*/
function emptyTurnSummary(turn) {
	return {
		turn,
		calls: [],
		toolCount: 0,
		failedCount: 0,
		totalElapsedMs: 0,
		byFamily: EMPTY_FAMILY$1()
	};
}
/**
* 折叠 SessionEvent：tool/call 计数 + 家族分类；tool/result 计时 + 失败计数。
* turn/start 重置为该轮的空统计；未配对的 tool/result 与其余事件不改变状态。
* @param state - 当前统计状态。
* @param event - 会话事件。
* @returns 新统计状态。
*/
function applyTurnEvent(state, event) {
	switch (event.type) {
		case "tool/call": {
			const { callId, name } = event.data;
			const family = getToolColorFamily(name);
			return {
				...state,
				calls: [...state.calls, {
					callId,
					name,
					family,
					startedAt: event.time
				}],
				toolCount: state.toolCount + 1,
				byFamily: {
					...state.byFamily,
					[family]: state.byFamily[family] + 1
				}
			};
		}
		case "tool/result": {
			const source = event.data.message.source;
			const record = state.calls.find((c) => c.callId === source.callId);
			if (record === void 0) return state;
			const failed = event.data.error !== void 0;
			const elapsedMs = Math.max(0, event.time - record.startedAt);
			return {
				...state,
				calls: state.calls.map((c) => c.callId === source.callId ? {
					...c,
					failed,
					elapsedMs: Math.max(0, event.time - c.startedAt)
				} : c),
				failedCount: state.failedCount + (failed ? 1 : 0),
				totalElapsedMs: state.totalElapsedMs + elapsedMs
			};
		}
		case "turn/start": return emptyTurnSummary(event.data.turn);
		default: return state;
	}
}
//#endregion
//#region lib/types/summary-state.js
const EMPTY_FAMILY = () => ({
	file: 0,
	shell: 0,
	search: 0,
	edit: 0,
	network: 0,
	other: 0
});
/**
* 全零初始状态。
* @param sessionId - 汇总所属的会话 id。
* @returns 各计数为 0、无进行中轮的初始 SummaryState。
*/
function emptySummaryState(sessionId) {
	return {
		sessionId,
		totalTurns: 0,
		totalToolCalls: 0,
		totalElapsedMs: 0,
		currentTurn: {
			toolCount: 0,
			failedCount: 0,
			byFamily: EMPTY_FAMILY(),
			startTime: void 0,
			elapsedMs: 0,
			callTimes: /* @__PURE__ */ new Map()
		},
		lastCompleted: void 0,
		byFamily: EMPTY_FAMILY()
	};
}
function addFamily(target, family) {
	target[family] += 1;
}
/**
* 折叠一条会话事件：turn/start 重置轮内计数，tool/call 与 tool/result
* 累计调用/失败/耗时，turn/end 把轮内快照并入会话累计；其余事件原样返回。
* @param state - 当前汇总状态（不被就地修改）。
* @param event - 会话事件。
* @returns 折叠后的新状态；与本投影无关的事件返回原 state。
*/
function applySummaryEvent(state, event) {
	switch (event.type) {
		case "turn/start": return {
			...state,
			currentTurn: {
				...state.currentTurn,
				toolCount: 0,
				failedCount: 0,
				byFamily: EMPTY_FAMILY(),
				startTime: event.time,
				elapsedMs: 0,
				callTimes: /* @__PURE__ */ new Map()
			}
		};
		case "tool/call": {
			const { callId, name } = event.data;
			const byFamily = { ...state.currentTurn.byFamily };
			addFamily(byFamily, getToolColorFamily(name));
			const callTimes = new Map(state.currentTurn.callTimes);
			callTimes.set(callId, event.time);
			return {
				...state,
				currentTurn: {
					...state.currentTurn,
					toolCount: state.currentTurn.toolCount + 1,
					byFamily,
					callTimes
				}
			};
		}
		case "tool/result": {
			const source = event.data.message.source;
			const callTime = state.currentTurn.callTimes.get(source.callId);
			if (callTime === void 0) return state;
			const elapsed = Math.max(0, event.time - callTime);
			const callTimes = new Map(state.currentTurn.callTimes);
			callTimes.delete(source.callId);
			const failed = event.data.error !== void 0;
			return {
				...state,
				currentTurn: {
					...state.currentTurn,
					failedCount: state.currentTurn.failedCount + (failed ? 1 : 0),
					elapsedMs: state.currentTurn.elapsedMs + elapsed,
					callTimes
				}
			};
		}
		case "turn/end": {
			if (state.currentTurn.startTime === void 0) return state;
			const summary = {
				toolCount: state.currentTurn.toolCount,
				failedCount: state.currentTurn.failedCount,
				byFamily: { ...state.currentTurn.byFamily }
			};
			const byFamily = {
				file: state.byFamily.file + summary.byFamily.file,
				shell: state.byFamily.shell + summary.byFamily.shell,
				search: state.byFamily.search + summary.byFamily.search,
				edit: state.byFamily.edit + summary.byFamily.edit,
				network: state.byFamily.network + summary.byFamily.network,
				other: state.byFamily.other + summary.byFamily.other
			};
			return {
				...state,
				totalTurns: state.totalTurns + 1,
				totalToolCalls: state.totalToolCalls + summary.toolCount,
				totalElapsedMs: state.totalElapsedMs + state.currentTurn.elapsedMs,
				byFamily,
				lastCompleted: {
					turn: event.data.turn,
					summary
				},
				currentTurn: {
					...state.currentTurn,
					toolCount: 0,
					failedCount: 0,
					byFamily: EMPTY_FAMILY(),
					startTime: void 0,
					elapsedMs: 0,
					callTimes: /* @__PURE__ */ new Map()
				}
			};
		}
		default: return state;
	}
}
/**
* 重放事件数组为聚合状态。
* @param sessionId - 汇总所属的会话 id。
* @param events - 按序重放的会话事件。
* @returns 从空状态依次折叠全部事件后的 SummaryState。
*/
function summarizeSession(sessionId, events) {
	let state = emptySummaryState(sessionId);
	for (const event of events) state = applySummaryEvent(state, event);
	return state;
}
/** 默认动词池（思考/分析/检索…；池首恒为「思考中」——reducedMotion 冻结词）。 */
const DEFAULT_SPINNER_VERBS = [
	"思考中",
	"分析中",
	"推理中",
	"检索中",
	"整理中",
	"写作中",
	"沉思中",
	"琢磨中",
	"推敲中",
	"酝酿中",
	"腌制中",
	"翻炒中",
	"施法中",
	"缝合中"
];
/**
* 人类可读耗时：<60s 纯秒；否则 分+秒；负数按 0。
* @param ms - 毫秒耗时。
* @returns 形如 `42s` 或 `2m 5s` 的文本。
*/
function formatElapsedHuman(ms) {
	const s = Math.max(0, Math.floor(ms / 1e3));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}
/**
* 按 elapsed 时间片取动词（纯函数）；reducedMotion 冻结为池首；空池回退默认池首。
* @param elapsedMs - 已耗时（毫秒）；同一 VERB_ROTATE_MS 时间片内取同一词。
* @param verbs - 动词池；空数组回退默认池。
* @param reduced - 减少动效：恒取池首。
* @returns 当前时间片的动词。
*/
function verbForElapsed(elapsedMs, verbs, reduced = false) {
	const pool = verbs.length > 0 ? verbs : DEFAULT_SPINNER_VERBS;
	const first = pool[0];
	if (first === void 0) return "思考中";
	if (reduced) return first;
	return pool[Math.floor(elapsedMs / 4e3) % pool.length] ?? first;
}
//#endregion
//#region lib/types/format/turn-summary.js
/**
* Turn 结束统计摘要（format/turn-summary.ts）— 纯渲染。
*
* 行结构：`turn N · trail · 读X 改Y · ✓Z · elapsed`。
* trail 按 phase 顺序用 glyph 连接；窄宽时从尾部 drop 次要段。
* ascii 入参决定 trail glyph；任何宽度下不破版。
*/
const GLYPHS = {
	thinking: {
		box: "◐",
		ascii: "o"
	},
	streaming: {
		box: "▸",
		ascii: ">"
	},
	tool: {
		box: "●",
		ascii: "*"
	},
	verifying: {
		box: "✓",
		ascii: "v"
	},
	done: {
		box: "◆",
		ascii: "!"
	}
};
function truncateTo$5(text, columns) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/**
* turn 结束统计摘要单行渲染：`turn N · trail · 读X 改Y · ✓Z · elapsed`。
* 窄宽从尾部渐进 drop 次要段，最终仅剩 turn 段时按宽度截断。
* @param input - turn 序号、阶段轨迹、读改计数与宽度等。
* @param theme - 当前主题（整行 dim 色）。
* @returns 单元素 ANSI 行数组，显示宽度 ≤ input.width。
*/
function formatTurnSummary(input, theme) {
	const width = input.width;
	const ascii = input.ascii === true;
	const parts = [`turn ${input.turnNumber}`];
	const trail = input.segments.length > 0 ? input.segments.map((s) => ascii ? GLYPHS[s].ascii : GLYPHS[s].box).join(" → ") : void 0;
	if (trail !== void 0) parts.push(trail);
	parts.push(`读${input.filesRead} 改${input.filesModified}`);
	if (input.verifiedCount !== void 0 && input.verifiedCount > 0) parts.push(`${ascii ? "v" : "✓"}${input.verifiedCount}`);
	if (input.elapsedMs !== void 0) parts.push(formatElapsedHuman(input.elapsedMs));
	const dim = (s) => color(s, theme.dim);
	const dropTail = (list) => list.slice(0, -1);
	let list = parts;
	for (;;) {
		const joined = list.join(" · ");
		if (displayWidth(joined) <= width) return [dim(joined)];
		if (list.length <= 1) return [dim(truncateTo$5(joined, width))];
		list = dropTail(list);
	}
}
//#endregion
//#region lib/types/format/glance-bar.js
/**
* metrics 一行条（format/glance-bar.ts）— 纯渲染。
*
* segment 组装：预设短名 / model / effort / 缓存% / 上下文%+占用条（近满 ⚠）/ ◧ tokens / elapsed / $cost / #turn / 停滞。
* 窄宽先摘占用条再 drop 尾部次要段；极窄截断 model 段；任何宽度下不破版。
*/
/**
* token 计数紧凑显示：<1000 原样；<1M 用 `k`（非整时留 1 位小数）；否则 `M` 留 2 位。
* @param n - token 数。
* @returns 紧凑计数文本。
*/
function formatTokenCount(n) {
	if (n < 1e3) return String(n);
	if (n < 1e6) {
		const v = n / 1e3;
		return Number.isInteger(v) ? `${v}k` : `${v.toFixed(1)}k`;
	}
	return `${(n / 1e6).toFixed(2)}M`;
}
/**
* 上下文占用条：ratio 为已用比例，空格即剩余预算。
* @param ratio - 已用 / 窗口；越界夹紧到 [0, 1]。
* @param ascii - true 时用 `[====----]`，避免 block 字符。
*/
function formatContextBar(ratio, ascii = false) {
	const filled = Math.round(Math.min(1, Math.max(0, ratio)) * 8);
	const empty = 8 - filled;
	if (ascii) return `[${"=".repeat(filled)}${"-".repeat(empty)}]`;
	return `${"▓".repeat(filled)}${"░".repeat(empty)}`;
}
/**
* 状态段组装（纯函数）：身份/状态类段——预设短名 / model / effort / 停滞。
* 行 1 状态行的右侧段数据源；effort 可隐藏，其余为身份/告警段不可隐藏。
* @param input - metrics 输入；仅组装已提供的段。
* @returns 无色段文本列表，按固定顺序。
*/
function glanceStatusSegments(input) {
	const hidden = new Set(input.hideSegments ?? []);
	const segs = [];
	if (input.preset !== void 0 && input.preset !== "") segs.push(input.preset);
	if (input.modelName !== void 0) segs.push(input.modelName);
	if (input.effort !== void 0 && !hidden.has("effort")) segs.push(`◎${input.effort}`);
	if (input.stalled) segs.push("停滞");
	return segs;
}
/**
* 指标段组装（纯函数）：指标类段——缓存% / 上下文%+占用条 / tokens / elapsed / cost / turn。
* 行 2 指标行的数据源；与 glanceBarSegments 中对应段逐字一致。
* @param input - metrics 输入；仅组装已提供的段（cost 有值即显示；turn 只在 density full 档）。
* @returns 无色段文本列表，按固定顺序。
*/
function glanceMetricsSegments(input) {
	const hidden = new Set(input.hideSegments ?? []);
	const segs = [];
	if (input.cacheHitRate !== void 0 && !hidden.has("cache")) segs.push(`缓存 ${Math.round(input.cacheHitRate * 100)}%`);
	if (input.contextRatio !== void 0 && !hidden.has("context")) {
		const label = `${input.contextRatio >= .95 ? "⚠" : ""}上下文 ${Math.round(input.contextRatio * 100)}%`;
		segs.push(input.contextBar === false ? label : `${label} ${formatContextBar(input.contextRatio, input.ascii === true)}`);
	}
	if (input.tokens !== void 0 && !hidden.has("tokens")) {
		const t = `${formatTokenCount(input.tokens.used)}/${formatTokenCount(input.tokens.max)}`;
		segs.push(input.ascii ? `[${t}]` : `◧ ${t}`);
	}
	if (input.elapsedMs !== void 0 && !hidden.has("elapsed")) segs.push(formatElapsedHuman(input.elapsedMs));
	if (input.cost !== void 0 && !hidden.has("cost")) segs.push(`$${input.cost}`);
	if (input.density === "full") {
		if (input.turnCount !== void 0) segs.push(`#${input.turnCount}`);
	}
	return segs;
}
/**
* 行 2 指标行渲染（分层 footer 的 metrics 行）：仅指标段，渐进 drop 次要段。
* 上下文段最保底（对齐 kimi-code Line 2 的 context 语义），cache 先于 context 丢；
* 与 formatGlanceBar 同策略但没有 model 保底——全删空即不渲染（返回空）。
* @param input - metrics 输入（width ≤ 0 或缺省时不渲染）。
* @param theme - 当前主题（整行 primary 色，与指标段既有配色一致）。
* @returns 单行 live 区内容；无可渲染内容返回空数组。
*/
function formatGlanceMetricsLine(input, theme) {
	const width = input.width ?? 0;
	if (width <= 0) return [];
	let current = {
		...input,
		width
	};
	for (;;) {
		const segs = glanceMetricsSegments(current);
		if (segs.length === 0) return [];
		const text = segs.join(" · ");
		if (displayWidth(text) <= width) return [{ text: color(text, theme.primary) }];
		const next = { ...current };
		if (next.elapsedMs !== void 0) delete next.elapsedMs;
		else if (next.cost !== void 0) delete next.cost;
		else if (next.turnCount !== void 0) delete next.turnCount;
		else if (next.tokens !== void 0) delete next.tokens;
		else if (next.cacheHitRate !== void 0) delete next.cacheHitRate;
		else if (next.contextBar !== false && next.contextRatio !== void 0) next.contextBar = false;
		else if (next.contextRatio !== void 0) delete next.contextRatio;
		else return [];
		current = next;
	}
}
//#endregion
//#region lib/types/format/activity-band.js
/**
* activity-band — 统一活动带（CC 对标：活跃进度收敛为输入轨上方的高度封顶固定带）。
* 回流自 tianshu-public（上游 src/format/activity-band.ts）。
*
* `foldActivityItems` 把三类活跃活动（subagent 运行项 / workflow run / 后台任务）
* 折叠为统一 `ActivityItem[]`（新 `startedAt` 在前）；`formatActivityBand` 渲染为
* 封顶带：分组计数头 + 每 item 恒 1 行 + 仅最新活跃 subagent 一条 `⎿` 子行 +
* 常驻入口尾行。纯函数层：同一输入恒返回同一行序列，无 I/O、无时钟副作用
* （`now`/`tick` 经 opts 注入）。完成项（done/failed）不进带——它们塌成一行
* commit 进 scrollback（format/subagent-line 与 workflow/end 摘要承担）。
*
* 高度约束（防跳）：计数头 ≤1 行、item 行 ≤ maxRows、`⎿` 子行 ≤1 行（仅最新
* 活跃 subagent）、入口尾行恒 1 行——带高只随「活跃 item 数」变化，数字原地
* 更新不换行。
*
* @module dsh-tui/format/activity-band
*/
/** 分组计数头字形。 */
const HEADER_GLYPH = "◐";
/** 类别 → 计数头/文案名。 */
const KIND_NAMES = {
	subagent: "子代理",
	workflow: "工作流",
	task: "后台任务"
};
/** 类别渲染顺序（计数头与折叠排序共用）。 */
const KIND_ORDER = [
	"subagent",
	"workflow",
	"task"
];
/** 未折叠时的常驻入口尾行（详情视图入口提示）。 */
const ENTRY_PLAIN = "/workflow 管理 · /subagents 树";
/** 折叠时的尾行：超封顶计数 + /workflow 入口。 */
const ENTRY_FOLDED = (n) => `└ …(+${n}) /workflow 管理`;
/** 无 lastTool 但有投影源且零工具调用时的子行文案。 */
const INITIALIZING = "Initializing…";
/**
* 折叠三类活跃活动为统一活动项（仅 running；新 startedAt 在前，缺省垫底）。
* @param input - subagent 运行项 / workflow run / 活跃后台任务。
* @returns 统一活动项数组（running 项，startedAt 降序）。
*/
function foldActivityItems(input) {
	const items = [];
	for (const run of input.subagentRuns) items.push({
		id: run.runId,
		kind: "subagent",
		label: run.label,
		status: "running",
		...run.startedAt === void 0 ? {} : { startedAt: run.startedAt },
		...run.progress === void 0 ? {} : {
			toolCalls: run.progress.toolCalls,
			tokensUsed: run.progress.tokensUsed,
			...run.progress.lastTool === void 0 ? {} : { lastTool: run.progress.lastTool }
		}
	});
	for (const run of input.workflowRuns) items.push({
		id: run.id,
		kind: "workflow",
		label: run.description === "" ? `[${run.name}]` : `[${run.name}] ${run.description}`,
		status: "running",
		...run.startedAt === void 0 ? {} : { startedAt: run.startedAt },
		...run.phase === null ? {} : { phase: run.phase },
		agents: run.agentCount
	});
	for (const task of input.tasks) items.push({
		id: task.id,
		kind: "task",
		label: `${task.kind}: ${task.label}`,
		status: "running",
		...task.startedAt === void 0 ? {} : { startedAt: task.startedAt }
	});
	return items.sort((a, b) => (b.startedAt ?? Number.NEGATIVE_INFINITY) - (a.startedAt ?? Number.NEGATIVE_INFINITY));
}
/**
* 渲染统一活动带：分组计数头（活跃 >1 时）+ 每 item 恒 1 行 + 仅最新活跃
* subagent 一条 `⎿` 子行 + 常驻入口尾行。done/failed 项跳过；超 maxRows 折叠
* 为 `+N` 尾行（新 startedAt 优先——折叠排序已保证）。空输入/无 running 项
* 返回空数组（不渲染带）。
* @param items - 统一活动项（foldActivityItems 输出或等价形状）。
* @param opts - 行宽、封顶、墙钟、帧与主题。
* @returns 面板行数组（计数头 ≤1 + item ≤maxRows + 子行 ≤1 + 尾行 1）。
*/
function formatActivityBand(items, opts) {
	const active = items.filter((item) => item.status === "running");
	if (active.length === 0) return [];
	const rows = [];
	if (active.length > 1) rows.push(truncateToLiveWidth(formatHeader(active), opts.width));
	const maxRows = Math.max(1, opts.maxRows);
	const shown = active.slice(0, maxRows);
	const newestSubagentIdx = active.findIndex((item) => item.kind === "subagent");
	for (let i = 0; i < shown.length; i++) {
		const item = shown[i];
		if (item === void 0) continue;
		rows.push(projectItemRow(item, opts));
		if (i === newestSubagentIdx) {
			const subline = projectSubagentSubline(item, opts);
			if (subline !== null) rows.push(subline);
		}
	}
	const entry = active.length > shown.length ? ENTRY_FOLDED(active.length - shown.length) : ENTRY_PLAIN;
	rows.push(dim(entry, opts));
	return rows;
}
/** 分组计数头：`◐ N 子代理 · M 工作流 · K 后台任务`（零计数组省略）。 */
function formatHeader(items) {
	const parts = [];
	for (const kind of KIND_ORDER) {
		const count = items.filter((item) => item.kind === kind).length;
		if (count > 0) parts.push(`${count} ${KIND_NAMES[kind]}`);
	}
	return `${HEADER_GLYPH} ${parts.join(" · ")}`;
}
/** 单个活动项行：glyph + label + 统计段（后缀从右往左丢，label 最后截）。 */
function projectItemRow(item, opts) {
	const theme = opts.theme;
	const glyph = item.kind === "subagent" ? liveCardGlyph("running", {
		...opts.tick === void 0 ? {} : { tick: opts.tick },
		...opts.ascii === void 0 ? {} : { ascii: opts.ascii }
	}) : item.kind === "workflow" ? "⏳" : "›";
	const base = theme === void 0 ? `${glyph} ${item.label}` : `${color(glyph, theme.primary)} ${item.label}`;
	const suffixes = [];
	if (item.kind === "subagent") {
		const toolCalls = item.toolCalls;
		if (toolCalls !== void 0 && toolCalls > 0) suffixes.push(`${toolCalls} 工具`);
		const tokensUsed = item.tokensUsed;
		if (tokensUsed !== void 0 && tokensUsed > 0) suffixes.push(`${formatTokenCount(tokensUsed)} tok`);
	} else if (item.kind === "workflow") {
		if (item.phase !== void 0) suffixes.push(item.phase);
		const agents = item.agents;
		if (agents !== void 0 && agents > 0) suffixes.push(`${agents} 个 agent`);
	}
	const startedAt = item.startedAt;
	const now = opts.now;
	if (startedAt !== void 0 && now !== void 0) suffixes.push(formatElapsedHuman(Math.max(0, now - startedAt)));
	return assembleLiveCardSuffixes(base, theme === void 0 ? suffixes : suffixes.map((suffix) => color(suffix, theme.muted)), opts.width);
}
/**
* 最新活跃 subagent 的 `⎿` 子行：有 lastTool → 最近工具；无 lastTool 但
* 投影源存在且零工具调用 → Initializing…；无投影源 → null（不渲染）。
* @param item - 最新活跃 subagent 项。
* @param opts - 行宽与主题。
* @returns 子行（dim）或 null。
*/
function projectSubagentSubline(item, opts) {
	if (item.lastTool !== void 0) return dim(`⎿ ${item.lastTool}`, opts);
	if (item.toolCalls === 0) return dim(`⎿ ${INITIALIZING}`, opts);
	return null;
}
/** 尾行/子行涂 dim（无主题时纯文本）。 */
function dim(text, opts) {
	return truncateToLiveWidth(opts.theme === void 0 ? text : color(text, opts.theme.dim), opts.width);
}
//#endregion
//#region lib/types/format/subagent-line.js
/**
* subagent 对话流状态行（format/subagent-line.ts）— 纯渲染
* （grok scrollback/blocks/subagent.rs 移植，dsh 精简版）。
*
* 运行中：live 区动态行 `⠋ 子代理 <label>`（braille spinner 帧随 tick 变化；
* 活动带启用时由 format/activity-band 统一渲染，本函数保留为逃生门散行回退）；
* 终态：提交 scrollback 的静态行 `✓ {label} · {N 工具} · {X tok} · 43s`
* （completed）、`◌ …`（aborted）、`✗ … (error)`（error/max-tokens/refusal
* 及 merge-extensible 未知 reason；统计段零值/缺失省略——CC 对标单行格式）。
* 宽度守恒、ascii 降级。
*/
function truncateTo$4(text, columns) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/**
* 渲染运行中状态行：`⠋ 子代理 <label>`（live 区动态帧；活动带逃生门回退）。
* @param input - 宽度、标签与帧计数。
* @param theme - 当前主题（整行 primary）。
* @returns 单行 ANSI；宽度守恒。
*/
function formatSubagentRunning(input, theme) {
	return [color(truncateTo$4(`${input.ascii === true ? "*" : brailleSpinnerFrame(input.tick ?? 0)} 子代理 ${input.label}`, input.width), theme.primary)];
}
/**
* 渲染终态状态行：`✓/◌/✗ {label} · {N 工具} · {X tok} · {耗时}[ (reason)]`
* （提交 scrollback）。completed → ✓ success；aborted → ◌ muted；其余
* （error/max-tokens/refusal/未知）→ ✗ error 且带 reason 后缀（completed/
* aborted 无后缀）。统计段零值/缺失省略；窄宽时尾部（reason → 耗时 → 统计
* 段 → label）先被截断。
* @param input - 宽度、标签、耗时、终止原因与可选统计段。
* @param theme - 当前主题（状态标记着色；其余 muted）。
* @returns 单行 ANSI；宽度守恒（label 截断优先于 reason 后缀）。
*/
function formatSubagentDone(input, theme) {
	const { width, label, elapsedMs, stopReason } = input;
	const mark = stopReason === "completed" ? "✓" : stopReason === "aborted" ? "◌" : "✗";
	const markColor = stopReason === "completed" ? theme.success : stopReason === "aborted" ? theme.muted : theme.error;
	const reason = stopReason === "completed" || stopReason === "aborted" ? "" : ` (${stopReason})`;
	const segments = [];
	const toolCalls = input.stats?.toolCalls;
	if (toolCalls !== void 0 && toolCalls > 0) segments.push(`${toolCalls} 工具`);
	const tokensUsed = input.stats?.tokensUsed;
	if (tokensUsed !== void 0 && tokensUsed > 0) segments.push(`${formatTokenCount(tokensUsed)} tok`);
	segments.push(formatElapsedHuman(elapsedMs));
	const text = `${mark} ${label}${segments.length > 0 ? ` · ${segments.join(" · ")}` : ""}${reason}`;
	return `${color(mark, markColor)}${color(truncateTo$4(text.slice(1), Math.max(0, width - displayWidth(mark))), theme.muted)}`;
}
//#endregion
//#region lib/types/format/task-panel.js
/**
* 任务窗格（grok-build /tasks 面板移植）。
*
* 纯函数层：projectTaskPanel 把 sessionProjections 注册表的任务投影
* （全量快照或 null）投影为面板行。null = 从未写过任务（面板不渲染）；
* 空数组 = 已清空（渲染占位）。TuiApp 消费注册表的任务单元，/tasks 命令
* 切换显隐，行渲染进 live 区。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/task-panel
*/
/** 面板标题行。 */
const TITLE$5 = "📋 任务";
/** 状态 → 标记符号。 */
function statusMark$1(status) {
	if (status === "completed") return "[x]";
	if (status === "in_progress") return "⏳";
	return "[ ]";
}
/**
* 投影任务快照为面板行。
* @param tasks - 任务全量快照；null（从未写入）→ 空数组（不渲染面板）。
* @param width - 终端列数（行截断预算，含标题）。
* @returns 面板行数组（含标题与空态占位；null 输入返回空数组）。
*/
function projectTaskPanel(tasks, width) {
	if (tasks === null) return [];
	const rows = [TITLE$5];
	if (tasks.length === 0) {
		rows.push("（无任务）");
		return rows;
	}
	for (const task of tasks) rows.push(truncateToLiveWidth(` ${statusMark$1(task.status)} ${task.content}`, Math.max(1, width)));
	return rows;
}
//#endregion
//#region lib/types/format/todos-panel.js
/**
* todos 紧凑待办面板（/todos）。
*
* 纯函数层：projectTodosPanel 把保留的 todos 投影快照折叠为输入轨上方的
* 待办行——与 /status 的完整 checklist、/tasks 窗格同源不同呈现。
* 有进行中/待办时默认列出条目（进行中置顶，最多 5 条）；全完成或空仍一行。
* /todos all 同样排序、不封 5 条。输入 null = 会话从未写入（空态占位）；
* 空数组 = 模型已清空清单（完成态）。turn/start 把投影清成 null 的黏滞
* 语义由 app 层承担，本模块只面对折叠后的输入。
*
* @module @huiliyi37/dsh-tianshu-tui/format/todos-panel
*/
/** 面板标题前缀。 */
const TITLE$4 = "📋 待办";
/** 默认态条目上限（超出留折叠尾行）。 */
const DEFAULT_ITEM_CAP = 5;
const STATUS_RANK = {
	in_progress: 0,
	pending: 1,
	completed: 2
};
/** 状态 → 明细行标记（对齐 /tasks checkbox 语汇）。 */
function statusMark(status) {
	if (status === "completed") return "[x]";
	if (status === "in_progress") return "⏳";
	return "[ ]";
}
/** 计数头：标题 + 三态计数（条目已列出时不再重复当前项）。 */
function countHeader(todos, width) {
	const counts = {
		completed: 0,
		in_progress: 0,
		pending: 0
	};
	for (const todo of todos) counts[todo.status]++;
	return truncateToLiveWidth(`${TITLE$4} ✓${counts.completed} ⏳${counts.in_progress} □${counts.pending}`, width);
}
function sortedTodos(todos) {
	return [...todos].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
}
function hasOpenWork(todos) {
	for (const todo of todos) if (todo.status === "in_progress" || todo.status === "pending") return true;
	return false;
}
function appendItems(rows, items, width) {
	for (const todo of items) rows.push(truncateToLiveWidth(` ${statusMark(todo.status)} ${todo.content}`, width));
}
/**
* 投影保留的待办快照为紧凑面板行。
* @param todos - 保留的待办全量快照；null（会话从未写入）→ 空态占位行，
*   空数组（已清空）→ 完成态行。
* @param opts - 宽度与是否看全表。
* @returns 面板行（空/全完成恒 1 行；有未完成项 = 计数头 + 条目 + 可选折叠行）。
*/
function projectTodosPanel(todos, opts) {
	const width = Math.max(1, opts.width);
	if (todos === null) return [truncateToLiveWidth(`${TITLE$4} ·（尚无待办）`, width)];
	if (todos.length === 0) return [truncateToLiveWidth(`${TITLE$4} · 全部完成 ✓`, width)];
	const rows = [countHeader(todos, width)];
	if (!opts.expanded && !hasOpenWork(todos)) return rows;
	const ranked = sortedTodos(todos);
	if (opts.expanded || ranked.length <= DEFAULT_ITEM_CAP) {
		appendItems(rows, ranked, width);
		return rows;
	}
	appendItems(rows, ranked.slice(0, 4), width);
	rows.push(`└ …(+${ranked.length - 4})`);
	return rows;
}
//#endregion
//#region lib/types/status-panel.js
/**
* /status 状态面板（grok-build goal_detail 面板移植，纯函数层）。
*
* projectStatusPanel 把 goal/todos/plan 三个投影快照渲染为面板行：
* 目标段（状态标签 + objective + 轮次 + 阻塞原因）、任务段（复用
* task-panel 三态行）、计划模式段（active/pending 徽标）。null 快照 =
* 从未写入（该段不渲染）；空数组 = 已清空（任务段渲染占位）。TuiApp 消费
* sessionProjections 的 goal/todos/plan 单元，/status 命令切换显隐，行
* 渲染进 live 区（接线在 ui/app.ts 与 registry.ts，由其他维度独占）。
*
* @module @deepseek-ai/dsh-tianshu-tui/status-panel
*/
/** status_label 映射（参照 grok-build goal_detail：状态 → (文本, 颜色, 阶段)）。 */
const STATUS_LABELS = {
	active: {
		text: "进行中",
		color: "green",
		stage: "active"
	},
	paused: {
		text: "已暂停",
		color: "yellow",
		stage: "paused"
	},
	blocked: {
		text: "已阻塞",
		color: "red",
		stage: "blocked"
	},
	complete: {
		text: "已完成",
		color: "blue",
		stage: "complete"
	}
};
/** 目标段标题行。 */
const GOAL_TITLE = "◆ 目标";
/** 计划段徽标前缀。 */
const PLAN_TITLE = "📐 计划";
/** 会话汇总段标题行（summary-state 投影：TUI 本地 fold，不经宿主投影总线）。 */
const SESSION_TITLE = "Σ 会话";
/**
* 状态 → (文本, 颜色, 阶段) 三元组映射（grok-build status_label 模式）。
* @param phase - goal 投影单元的状态阶段。
* @returns 状态文本、语义色名与阶段标识。
*/
function goalStatusLabel(phase) {
	return STATUS_LABELS[phase];
}
/**
* 投影 goal/todos/plan 快照为 /status 面板行。
* @param goal - goal 投影快照；null（从未写入）→ 目标段不渲染。
* @param todos - 任务快照；null → 任务段不渲染，空数组 → 渲染占位。
* @param plan - plan 投影快照；null → 计划段不渲染。
* @param opts - 渲染选项（含行截断宽度预算与可选会话汇总段）。
* @returns 面板行数组（段按目标/任务/计划/会话顺序拼接）。
*/
function projectStatusPanel(goal, todos, plan, opts) {
	const rows = [];
	if (goal !== null) rows.push(...projectGoalSection(goal, opts.width));
	rows.push(...projectTaskPanel(todos, Math.max(1, opts.width)));
	if (plan !== null) rows.push(...projectPlanSection(plan, opts.width));
	rows.push(...projectSessionSection(opts.sessionTotals ?? null, opts.width));
	return rows;
}
/** 目标段：状态行 + objective + 轮次 + 阻塞原因。 */
function projectGoalSection(goal, width) {
	const rows = [];
	const label = goalStatusLabel(goal.goal.phase);
	rows.push(truncateByWidth$4(`${GOAL_TITLE} · ${label.text}`, width));
	rows.push(truncateByWidth$4(goal.goal.objective, width));
	rows.push(truncateByWidth$4(`↻ 轮次 ${goal.roundsStarted}/${goal.goal.maxGoalRounds}`, width));
	if (goal.goal.phase === "blocked" && goal.goal.blockedReason !== void 0) rows.push(truncateByWidth$4(`🚧 ${goal.goal.blockedReason.message}`, width));
	return rows;
}
/** 计划段：active/pending 徽标单行。 */
function projectPlanSection(plan, width) {
	const mode = plan.active ? "进行中" : "关闭";
	const pending = plan.pending === true ? " · 待生效" : "";
	return [truncateByWidth$4(`${PLAN_TITLE} · ${mode}${pending}`, width)];
}
/** 会话汇总段：`Σ 会话 · 回合 N · 工具 M · 耗时 X` 单行；无已完成轮时不渲染。 */
function projectSessionSection(totals, width) {
	if (totals === null || totals.turns === 0) return [];
	const parts = [`${SESSION_TITLE} · 回合 ${totals.turns}`, `工具 ${totals.toolCalls}`];
	if (totals.elapsedMs > 0) parts.push(formatElapsedHuman(totals.elapsedMs));
	return [truncateByWidth$4(parts.join(" · "), width)];
}
/** 按显示宽度截断字符串（仅发生截断时尾部补 …；极端窄宽退化为 …）。 */
function truncateByWidth$4(text, max) {
	if (max <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/session-label.js
/**
* session-label — 会话 id 的显示短标签。
*
* SessionId 形如 `session-<uuid>`：直接 `slice(0, 8)` 恰好截出常量前缀
* `session-`，所有展示位（tab 标签、欢迎页可恢复列表、委派树回退、对话流
* subagent 标签）都会退化为无区分度的空壳。统一经此 helper 剥离前缀后再
* 截断；非 `session-` 形态的 id（历史/外部形状）行为不变（取前 8 位）。
*
* @module @deepseek-ai/dsh-tianshu-tui/session-label
*/
/** `session-` 前缀的长度（8）——与短标签长度相同，正是空壳病灶的来源。 */
const SESSION_ID_PREFIX = "session-";
/**
* 会话 id → 8 位显示短标签（剥离 `session-` 前缀后截断）。
* @param id - 会话 id（`session-<uuid>` 或其他形状）。
* @returns 8 位短标签；空 id 返回空串。
*/
function shortSessionLabel(id) {
	return (id.startsWith(SESSION_ID_PREFIX) ? id.slice(8) : id).slice(0, 8);
}
//#endregion
//#region lib/types/delegation-panel.js
/**
* 委派树面板（grok-build tasks_pane 分组行移植，纯函数层）。
*
* projectDelegationTree 把 listDescendants 的树条目投影为活区卡：标题行 +
* 每层一张卡。depth 驱动缩进。状态形与工具卡同一套（进行中 ⠋ / 成功 › /
* 失败 ✗）；mode 标记（one-shot ▶ / continuable ↻）留在 title。进行中且有
* 活动时第二行 `⎿` 承载 activity / token / 工具计数；耗时与终态词留在
* header suffix。空闲或已结束只留标题行。label 缺失回退 id 前 8 位短哈希。
* diagnostic 条目渲染警示行（不吞异常、不伪造 activity/mode）。空 entries
* 返回空数组。旧宿主条目无 progress/timing 时由 live-panels 合并投影后再传入。
*
* @module @huiliyi37/dsh-tianshu-tui/delegation-panel
*/
const TITLE$3 = "🌳 委派";
function modeMark(mode) {
	return mode === "continuable" ? "↻" : "▶";
}
function reasonLabel(reason) {
	if (reason === "corrupt") return "损坏";
	if (reason === "unavailable") return "不可用";
	return "不支持";
}
function shortHash(id) {
	return shortSessionLabel(id);
}
function formatSettled(ms) {
	return `${(ms / 1e3).toFixed(1)}s`;
}
function liveSettled(timing, now) {
	if (timing.active !== void 0 && now !== void 0) return timing.settledMs + Math.max(0, now - timing.active.since);
	return timing.settledMs;
}
function activityText(progress) {
	if (progress.lastTool === void 0) return "";
	return progress.toolInFlight ? `Running: ${progress.lastTool}` : `Done: ${progress.lastTool}`;
}
function tokensText(progress) {
	if (progress.tokensUsed <= 0) return "";
	return `${formatTokenCount(progress.tokensUsed)} tok`;
}
function toolsText(progress) {
	if (progress.toolCalls <= 0) return "";
	return `${progress.toolCalls} 工具`;
}
function terminalText(progress) {
	switch (progress.lastTurnEnd) {
		case "completed": return "✓ 已完成";
		case "aborted": return "◌ 已中断";
		case "error": return "✗ 出错";
		case "max-tokens": return "✗ 达上限";
		case "blocked": return "⏸ 阻塞";
		case "interrupted": return "◌ 中断";
		default: return "";
	}
}
/** 投影委派树为面板行。 */
function projectDelegationTree(entries, opts) {
	if (entries.length === 0) return [];
	const rows = [truncateToLiveWidth(TITLE$3, opts.width)];
	for (const entry of entries) rows.push(...renderEntry(entry, opts));
	return rows;
}
/** 投影活跃外部 run 为面板行。 */
function projectExternalRunSection(entries, opts) {
	if (entries.length === 0) return [];
	const rows = [truncateToLiveWidth("⤷ 外部子代理", opts.width)];
	for (const entry of entries) {
		const suffixes = [];
		if (entry.startedAt !== void 0 && opts.now !== void 0) suffixes.push(formatSettled(Math.max(0, opts.now - entry.startedAt)));
		rows.push(...formatLiveCard({
			glyph: liveCardGlyph("running"),
			title: `${entry.label ?? shortHash(entry.id)} · ${entry.provider}`,
			suffixes,
			width: opts.width,
			...opts.theme === void 0 ? {} : { theme: opts.theme }
		}));
	}
	return rows;
}
function isErrorTurn(kind) {
	return kind === "error" || kind === "aborted" || kind === "interrupted";
}
function renderEntry(entry, opts) {
	const indent = "  ".repeat(Math.max(0, entry.depth));
	if (entry.kind === "diagnostic") return [truncateToLiveWidth(`${indent}⚠ ${reasonLabel(entry.reason)} ${shortHash(entry.id)}`, opts.width)];
	const { progress, timing } = entry;
	const title = `${modeMark(entry.mode)} ${entry.label ?? shortHash(entry.id)}`;
	const finished = entry.activity === "inactive" || progress?.lastTurnEnd !== void 0;
	const inFlight = progress?.running === void 0 ? progress?.toolInFlight === true : progress.running;
	const activity = progress === void 0 ? "" : activityText(progress);
	const terminal = progress === void 0 ? "" : terminalText(progress);
	const status = inFlight ? "running" : isErrorTurn(progress?.lastTurnEnd) ? "error" : "success";
	const suffixes = [];
	if (finished && terminal !== "") suffixes.push(terminal);
	if (timing !== void 0) suffixes.push(formatSettled(liveSettled(timing, opts.now)));
	const bodyParts = [];
	if (!finished && progress !== void 0 && (inFlight || activity !== "")) {
		if (activity !== "") bodyParts.push(activity);
		const tokens = tokensText(progress);
		if (tokens !== "") bodyParts.push(tokens);
		const tools = toolsText(progress);
		if (tools !== "") bodyParts.push(tools);
	}
	return formatLiveCard({
		glyph: liveCardGlyph(status),
		title,
		suffixes,
		...bodyParts.length > 0 ? { body: [bodyParts.join(" · ")] } : {},
		width: opts.width,
		indent,
		dim: finished,
		...opts.theme === void 0 ? {} : { theme: opts.theme }
	});
}
//#endregion
//#region lib/types/workflow-panel.js
/**
* workflow-panel — 工作流运行态面板（grok workflows.rs render_list/roster 移植，纯函数层）。
*
* projectWorkflow 把多个 run 的运行态视图投影为面板行：
* - 列表行：状态字形 + badge + objective + meta（phases/agents/elapsed），cancelled 整行 DIM 置灰；
* - 展开行：opts.expanded 命中的 run 追加 roster（label + phase + 状态）；
* - 终态汇总：消费 stopReason/agentsStarted（grok 的死字段我们消费），error 消息可选进汇总行。
* 数据面形状结构兼容 workflow 包 types.ts（WorkflowRunInfo 字段名 id；WorkflowAgentEndInfo
* 追加 outcome；WorkflowResultInfo 无 value），纯函数层不跨包依赖、无 I/O。
*
* @module @deepseek-ai/dsh-tianshu-tui/workflow-panel
*/
/** 面板标题行。 */
const TITLE$2 = "📜 工作流";
/** 空态占位行。 */
const EMPTY$1 = "（暂无工作流）";
/** 置灰（细体/暗色）转义序列：cancelled 列表行整行包裹。 */
const DIM$1 = "\x1B[2m";
/** SGR 重置转义序列。 */
const RESET$2 = "\x1B[0m";
/** 运行中字形（result 未结算）。 */
const RUNNING_GLYPH = "⏳";
/** 终态原因 → 列表行状态字形。 */
const RUN_GLYPHS = {
	completed: "✓",
	cancelled: "⊘",
	error: "✗"
};
/** 终态原因 → 汇总行文本。 */
const STOP_TEXTS = {
	completed: "已完成",
	cancelled: "已取消",
	error: "出错"
};
/** 结算方式 → roster 行状态文本。 */
const OUTCOME_TEXTS = {
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消"
};
/**
* run 的状态字形：未结算 → ⏳；否则按终态原因映射。
* @param view - run 运行态视图。
* @returns 状态字形。
*/
function runGlyph(view) {
	const reason = view.result?.stopReason;
	return reason === void 0 ? RUNNING_GLYPH : RUN_GLYPHS[reason];
}
/**
* 毫秒 → 人类可读时长（45s / 1m20s / 2h1m）。
* @param ms - 毫秒数。
* @returns 格式化时长。
*/
function formatElapsed(ms) {
	const s = Math.floor(ms / 1e3);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}
/**
* 单个 run 的列表行：字形 + [badge] + objective + meta（phases/agents/elapsed）。
* cancelled 的 run 整行（截断后）DIM 包裹置灰。
* @param view - run 运行态视图。
* @param width - 行截断预算。
* @returns 列表行（可能含 ANSI）。
*/
function projectListRow$1(view, width) {
	const meta = [];
	if (view.info.meta.phases !== void 0) meta.push(`${view.info.meta.phases.length} 阶段`);
	meta.push(`${view.agents.length} 个 agent`);
	if (view.elapsedMs !== void 0) meta.push(formatElapsed(view.elapsedMs));
	const cut = truncateByWidth$3(`${runGlyph(view)} [${view.info.meta.name}] ${view.info.meta.description} · ${meta.join(" · ")}`, width);
	return view.result?.stopReason === "cancelled" ? `${DIM$1}${cut}${RESET$2}` : cut;
}
/**
* 展开行：roster 每行「序号. label · phase · 状态」（phase 缺省跳过）。
* @param view - run 运行态视图。
* @param width - 行截断预算。
* @returns roster 行数组（无 agent 时为空数组）。
*/
function projectRosterRows(view, opts) {
	const rows = [];
	for (const agent of view.agents) {
		const phase = agent.phase === void 0 ? "" : ` · ${agent.phase}`;
		const child = opts.childState?.get(agent.childId);
		const childPart = child === void 0 ? "" : ` · ⤷ ${child.running ? "⏳ " : ""}${child.label}`;
		rows.push(truncateByWidth$3(`  ├ ${agent.seq}. ${agent.label}${phase} · ${OUTCOME_TEXTS[agent.outcome]}${childPart}`, opts.width));
	}
	return rows;
}
/**
* 脚本叙述行（workflow/log 回放）：缩进 + 截断；logs 缺省/空数组不渲染。
* @param view - run 运行态视图。
* @param width - 行截断预算。
* @returns 叙述行数组（无 logs 时为空数组）。
*/
function projectLogRows(view, width) {
	const logs = view.logs;
	if (logs === void 0 || logs.length === 0) return [];
	return logs.map((line) => truncateByWidth$3(`  ⤷ ${line}`, width));
}
/**
* 终态汇总行：消费 stopReason/agentsStarted，error 消息可选。
* @param view - run 运行态视图。
* @param width - 行截断预算。
* @returns 汇总行数组（run 未结算时为空数组）。
*/
function projectResultRow(view, width) {
	const result = view.result;
	if (result === void 0) return [];
	const errorPart = result.error === void 0 ? "" : ` · ${result.error}`;
	return [truncateByWidth$3(`  └ 终态：${STOP_TEXTS[result.stopReason]}${errorPart} · 启动 ${result.agentsStarted} 个 agent`, width)];
}
/**
* 投影多个 run 的运行态视图为面板行（标题 + 列表行 + 展开的 roster/终态汇总）。
* @param runs - run 视图数组；空数组 → 标题 + 空态占位。
* @param opts - 面板选项（行宽 + 展开集合）。
* @returns 面板行数组。
*/
function projectWorkflow(runs, opts) {
	const rows = [TITLE$2];
	if (runs.length === 0) {
		rows.push(EMPTY$1);
		return rows;
	}
	const expanded = opts.expanded;
	for (const view of runs) {
		rows.push(projectListRow$1(view, opts.width));
		if (expanded !== void 0 && expanded.includes(view.info.id)) {
			rows.push(...projectLogRows(view, opts.width));
			rows.push(...projectRosterRows(view, opts));
			rows.push(...projectResultRow(view, opts.width));
		}
	}
	return rows;
}
/** 按显示宽度截断字符串（仅发生截断时尾部补 …；极端窄宽退化为 …）。 */
function truncateByWidth$3(text, max) {
	if (max <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/config-panel.js
/**
* /config 设置面板（纯函数层，T3.2）。
*
* projectConfigPanel 把终端偏好 + 宿主投影渲染为面板行：
* - 终端段（可选 tui）：系统通知开关；缺省不渲染（旧投影无此字段）。
* - 宿主设置段：每个命名空间一行（ns + 值 + secrets 脱敏标记）——值以
*   unknown 流动，null/undefined 渲染 —，object 紧凑 JSON；secret 槽用 🔒
*   标记。空数组不渲染该段。
* - 权限预设选择器：选项名从投影动态取，当前值 ✓、其余 ○；仅 'custom'
*   保留字——currentValue 为 custom 而选项缺失时补一行。permission 为
*   null 时不渲染。
* - 凭据徽章：ref + 已配置/未配置 + source + 可写/只读；writable 为
*   false 时整行 DIM 置灰。空数组不渲染该段。
* - 底栏：有 tui 时提示 n 切换 / 环境变量锁定。
*
* @module @deepseek-ai/dsh-tianshu-tui/config-panel
*/
/** 面板标题行。 */
const TITLE$1 = "⚙ 配置";
/** 终端偏好段标题。 */
const TUI_TITLE = "◆ 终端";
/** 宿主设置段标题。 */
const SETTINGS_TITLE = "◆ 宿主设置";
/** 权限预设段标题。 */
const PERMISSION_TITLE = "◆ 权限预设";
/** 凭据段标题。 */
const CREDENTIALS_TITLE = "◆ 凭据";
/** 底栏：可切换。 */
const HINT_TOGGLE = "n 通知 · d 密度 · Esc 关闭";
/** 底栏：环境变量锁定。 */
const HINT_LOCKED = "n 锁定 · d 密度 · Esc 关闭";
/** 置灰（细体/暗色）转义序列：只读凭据行整行包裹。 */
const DIM = "\x1B[2m";
/** SGR 重置转义序列。 */
const RESET$1 = "\x1B[0m";
/** 当前选中选项标记。 */
const CHECK = "✓";
/** 非当前选项标记。 */
const CIRCLE = "○";
/** 已配置徽章。 */
const CONFIGURED = "● 已配置";
/** 未配置徽章。 */
const UNCONFIGURED = "○ 未配置";
/** 权限预设唯一保留字：派生自 knob 组合、不在预设表中的当前值。 */
const CUSTOM = "custom";
/**
* 投影终端偏好 + 宿主三段为 /config 面板行。
* 空宿主段不渲染；有 tui 时终端段置顶、底栏提示切换键。
*/
function projectConfigPanel(projection, opts) {
	const rows = [truncateByWidth$2(TITLE$1, opts.width)];
	if (projection.tui !== void 0) rows.push(...projectTuiSection(projection.tui, opts.width));
	rows.push(...projectSettingsSection(projection.settings, opts.width));
	if (projection.permission !== null) rows.push(...projectPermissionSection(projection.permission, opts.width));
	rows.push(...projectCredentialsSection(projection.credentials, opts.width));
	if (projection.tui !== void 0) {
		const hint = projection.tui.notifyLocked ? HINT_LOCKED : HINT_TOGGLE;
		rows.push(truncateByWidth$2(hint, opts.width));
	}
	return rows;
}
/** 终端段：系统通知 + 可选紧凑渲染。 */
function projectTuiSection(tui, width) {
	const mark = tui.notifyOs ? "●" : CIRCLE;
	const state = tui.notifyLocked ? "关（DSH_TUI_SKIP_NOTIFY）" : tui.notifyOs ? "开" : "关";
	const rows = [truncateByWidth$2(TUI_TITLE, width), truncateByWidth$2(`  ${mark} 系统通知 · ${state}`, width)];
	if (tui.compactMode !== void 0) {
		const dMark = tui.compactMode ? "●" : CIRCLE;
		rows.push(truncateByWidth$2(`  ${dMark} 紧凑渲染 · ${tui.compactMode ? "开" : "关"}`, width));
	}
	return rows;
}
/** 宿主设置段：空数组不渲染。 */
function projectSettingsSection(settings, width) {
	if (settings.length === 0) return [];
	const rows = [truncateByWidth$2(SETTINGS_TITLE, width)];
	for (const desc of settings) rows.push(truncateByWidth$2(`  ${desc.ns} · ${formatValue(desc.value)}${secretMark(desc.secrets)}`, width));
	return rows;
}
/**
* unknown 值 → 显示文本。string/number/boolean 直出；object/array 紧凑
* JSON；symbol/function/bigint 顶层值属于数据违约（JSON-shaped 契约不可
* 达），回退显示类型名防渲染崩溃。
* @param value - 设置命名空间的当前解析值。
* @returns 显示文本（null/undefined → —）。
*/
function formatValue(value) {
	if (value === void 0 || value === null) return "—";
	switch (typeof value) {
		case "string": return value;
		case "number": return String(value);
		case "boolean": return String(value);
		case "symbol":
		case "function":
		case "bigint": return typeof value;
		default: return JSON.stringify(value);
	}
}
/**
* secrets 脱敏标记：无槽/空数组 → 无标记；有已脱敏值 → 计数标记；仅空槽 → 槽位标记。
* @param secrets - schema 声明的 secret 槽（redactSecrets 后的描述符携带）。
* @returns 行内脱敏标记后缀（无槽时为空串）。
*/
function secretMark(secrets) {
	if (secrets === void 0 || secrets.length === 0) return "";
	const set = secrets.filter((s) => s.set).length;
	return set > 0 ? ` 🔒 ${set} 密钥已脱敏` : " 🔒 密钥槽";
}
/** 权限预设段：段标题 + 每个选项一行（当前 ✓ / 其余 ○）；custom 保留字缺失时补行。 */
function projectPermissionSection(permission, width) {
	const rows = [truncateByWidth$2(PERMISSION_TITLE, width)];
	const options = [...permission.options];
	if (permission.currentValue === CUSTOM && !options.some((opt) => opt.value === CUSTOM)) options.push({
		value: CUSTOM,
		name: CUSTOM
	});
	for (const opt of options) {
		const mark = opt.value === permission.currentValue ? CHECK : CIRCLE;
		rows.push(truncateByWidth$2(`  ${mark} ${opt.name}`, width));
	}
	return rows;
}
/** 凭据段：空数组不渲染。 */
function projectCredentialsSection(credentials, width) {
	if (credentials.length === 0) return [];
	const rows = [truncateByWidth$2(CREDENTIALS_TITLE, width)];
	for (const cred of credentials) rows.push(projectCredentialRow(cred, width));
	return rows;
}
/**
* 单个凭据徽章行：ref + 已配置/未配置 + source + 可写/只读；writable 为
* false 时整行（截断后）DIM 置灰。
* @param cred - 凭据信息。
* @param width - 行截断预算。
* @returns 徽章行（只读时含 ANSI）。
*/
function projectCredentialRow(cred, width) {
	const configured = cred.configured ? CONFIGURED : UNCONFIGURED;
	const source = cred.source === void 0 ? "" : ` · ${cred.source}`;
	const writable = cred.writable ? "可写" : "只读";
	const row = truncateByWidth$2(`  ${cred.ref} ${configured}${source} · ${writable}`, width);
	return cred.writable ? row : `${DIM}${row}${RESET$1}`;
}
/** 按显示宽度截断字符串（仅发生截断时尾部补 …；极端窄宽退化为 …）。 */
function truncateByWidth$2(text, max) {
	if (max <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/ui/inspect-panels.js
/**
* inspect-panels — 检查类 live 面板（/config /skills /status /lsp /tasks）
* 互斥开闭与键语义。监控类面板（todos/subagents/workflow）不在此列。
*
* @module @huiliyi37/dsh-tianshu-tui/ui/inspect-panels
*/
/** 打开 which；open=false 时五项全关。 */
function exclusiveInspect(which, open) {
	return {
		config: open && which === "config",
		skills: open && which === "skills",
		status: open && which === "status",
		lsp: open && which === "lsp",
		tasks: open && which === "tasks"
	};
}
function anyInspectOpen(flags) {
	return flags.config || flags.skills || flags.status || flags.lsp || flags.tasks;
}
function inspectKeyAction(input) {
	if (input.name === "escape" && anyInspectOpen(input.flags)) return { type: "close" };
	if (!input.empty || !input.vimInsert) return null;
	if (input.flags.config && (input.char === "n" || input.char === "N")) return { type: "notify" };
	if (input.flags.config && (input.char === "d" || input.char === "D")) return { type: "density" };
	if (input.flags.skills) {
		if (input.name === "up" || input.char === "k") return {
			type: "skills-move",
			delta: -1
		};
		if (input.name === "down" || input.char === "j") return {
			type: "skills-move",
			delta: 1
		};
	}
	return null;
}
/** 检查面板底栏；窄宽截断。 */
function inspectHint(width, extras = []) {
	const text = [...extras, "Esc 关闭"].join(" · ");
	if (width <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > width - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/skill-panel.js
/**
* 技能浏览面板（skill 数据面移植，纯函数层，T3.3）。
*
* projectSkillPanel 把 SkillSummary 形状的快照投影为面板行：
* - 列表行：每个 skill 一行「name · description · 来源标记」——来源标记按
*   SkillSource 已知值映射短标签（项目 .dsh / 项目 AGENTS / 运行时 / 用户
*   .dsh / 用户 AGENTS / 自定义 / 内置），未知来源回退渲染原值；
* - 选中详情：opts.selected 命中的 skill 在其列表行后追加一行
*   「└ provider · 调用形态 · whenToUse」（whenToUse 缺省时省略该段）——
*   调用形态由 invocation.modelInvocable/userInvocable 组合推导
*   （模型+用户可调 / 仅模型可调 / 仅用户可调 / 不可调），selected 未命中
*   或缺省不渲染详情行。
* 数据面形状结构兼容 @deepseek-ai/dsh-skill 的 SkillSummary（纯函数层只消费
* name/description/whenToUse/invocation/source/provider；resourceBase 不参与
* 渲染），skills/change 无 payload 事件、刷新靠重查，面板层只消费 list 快照
* 投影。空列表渲染标题 + 空态占位；每行按显示宽度截断（仅截断时补 …，
* 极端窄宽退化为 … 不抛错）。TuiApp 消费技能快照与 /skills 命令切换显隐
* （接线由其他维度独占）。
*
* @module @deepseek-ai/dsh-tianshu-tui/skill-panel
*/
/** 面板标题行。 */
const TITLE = "🧭 技能";
/** 空态占位行。 */
const EMPTY = "（暂无技能）";
/** 已知 SkillSource → 短标签；未知来源回退渲染原值。 */
const SOURCE_LABELS = {
	"project-dsh": "项目 .dsh",
	"project-agents": "项目 AGENTS",
	runtime: "运行时",
	"user-dsh": "用户 .dsh",
	"user-agents": "用户 AGENTS",
	custom: "自定义",
	bundled: "内置"
};
/**
* 投影技能快照为面板行（标题 + 列表行 + 命中的选中详情行）。
* @param skills - skill 摘要数组；空数组 → 标题 + 空态占位。
* @param opts - 面板选项（行宽预算 + 可选选中名）。
* @returns 面板行数组。
*/
function projectSkillPanel(skills, opts) {
	const rows = [TITLE];
	if (skills.length === 0) {
		rows.push(EMPTY);
		return rows;
	}
	for (const skill of skills) {
		rows.push(truncateByWidth$1(projectListRow(skill), opts.width));
		if (skill.name === opts.selected) rows.push(truncateByWidth$1(projectDetailRow(skill), opts.width));
	}
	return rows;
}
/** 单个 skill 列表行：name · description · 来源标记。 */
function projectListRow(skill) {
	return `  ${skill.name} · ${skill.description} · ${sourceLabel(skill.source)}`;
}
/** 来源标记：已知 SkillSource 映射短标签，未知值回退原值。 */
function sourceLabel(source) {
	return SOURCE_LABELS[source] ?? source;
}
/** 选中详情行：└ provider · 调用形态 · whenToUse（whenToUse 缺省省略）。 */
function projectDetailRow(skill) {
	const whenToUse = skill.whenToUse === void 0 ? "" : ` · ${skill.whenToUse}`;
	return `  └ ${skill.provider} · ${invocationText(skill.invocation)}${whenToUse}`;
}
/** 调用形态文本：由 modelInvocable/userInvocable 组合推导；双不可调也渲染不吞。 */
function invocationText(invocation) {
	const { modelInvocable, userInvocable } = invocation;
	if (modelInvocable && userInvocable) return "模型+用户可调";
	if (modelInvocable) return "仅模型可调";
	if (userInvocable) return "仅用户可调";
	return "不可调";
}
/** 按显示宽度截断字符串（仅发生截断时尾部补 …；极端窄宽退化为 …）。 */
function truncateByWidth$1(text, max) {
	if (max <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/format/lsp-diagnostics.js
/**
* lsp-diagnostics — LSP 诊断的展示纯函数（工具卡徽标 + /lsp 面板段）。
*
* 纯函数层：输入诊断视图数组/分组视图，输出 ANSI 行；无 I/O、无时钟。
* severity 映射与 LSP 语义一致：1 Error / 2 Warning / 3 Info / 4 Hint，
* 语义色名（error/warning/info）由接线层映射主题色（同 tool-status 模式）。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/lsp-diagnostics
*/
/** 单文件诊断徽标（工具卡标题行注入；无诊断返回 null 不渲染）。 */
function lspBadgeText(diags) {
	if (diags === void 0 || diags.length === 0) return null;
	const errors = diags.filter((d) => d.severity === 1).length;
	const warnings = diags.filter((d) => d.severity === 2).length;
	const others = diags.length - errors - warnings;
	const parts = [];
	if (errors > 0) parts.push(`${errors}错`);
	if (warnings > 0) parts.push(`${warnings}警`);
	if (others > 0) parts.push(`${others}提示`);
	return parts.join(" ");
}
/** severity → 语义色名（接线层映射主题色）。 */
function lspSeverityColorName(severity) {
	switch (severity) {
		case 1: return "error";
		case 2: return "warning";
		default: return "info";
	}
}
/**
* 按文件分组（保持输入顺序，不跨文件重排）。
* @param entries - 全量诊断视图（可能来自多个文件）。
* @returns 文件分组列表；空输入返回 []。
*/
function groupLspDiagnostics(entries) {
	const order = [];
	const byFile = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		let list = byFile.get(entry.file);
		if (list === void 0) {
			list = [];
			byFile.set(entry.file, list);
			order.push(entry.file);
		}
		list.push(entry);
	}
	return order.map((file) => ({
		file,
		diags: byFile.get(file) ?? []
	}));
}
/** 单条诊断行：`line:col · message`（severity 着色）。 */
function lspDiagnosticLine(diag, theme) {
	const colorName = lspSeverityColorName(diag.severity);
	const themeColor = colorName === "error" ? theme.error : colorName === "warning" ? theme.warning : theme.muted;
	const loc = color(`${diag.line}:${diag.character}`, theme.dim);
	const message = diag.message.replace(/\s+/g, " ").trim();
	const budget = Math.max(20, 72);
	const text = displayWidth(message) > budget ? Array.from(message).reduce((acc, ch) => {
		if (displayWidth(acc + ch) > 71) return acc;
		return acc + ch;
	}, "") + "…" : message;
	return `${loc} ${color("·", theme.muted)} ${color(text, themeColor)}`;
}
/**
* /lsp 面板段行序列：每组「文件头行 + 诊断行」；空输入 → 空态行。
* @param groups - 按文件分组的诊断。
* @param theme - 主题（着色）。
* @param available - 是否至少一个语言 server 可用（区分空态文案）。
* @returns 面板行（ANSI 文本；组合器按需包装）。
*/
function projectLspPanel(groups, theme, available) {
	const rows = [];
	if (groups.length === 0) {
		rows.push(color(available ? "（无 LSP 诊断）" : "（LSP server 未安装——诊断不可用）", theme.muted));
		return rows;
	}
	for (const group of groups) {
		rows.push(color(`◆ ${group.file}`, theme.primary, { bold: true }));
		for (const diag of group.diags) rows.push(`  ${lspDiagnosticLine(diag, theme)}`);
	}
	return rows;
}
//#endregion
//#region lib/types/render/live-panels.js
/**
* live-panels — renderLive 的 8 面板段纯函数（Wave 2 提取）。
*
* renderLive 每帧把 TuiApp 读取的字段子集组装为 LiveSnapshot（render/
* live-snapshot.ts），交给本模块的 8 个纯函数（(snapshot) => string[]）
* 渲染面板行；组合器负责 { text } 包装与 theme 着色、非面板段（提问/审批/
* 流利度/流式尾巴/工具卡/输入行）直渲染。面板是纯函数：同一 snapshot 恒返回
* 同一行序列，无 I/O、无时钟、无副作用——taskNotice 的「渲染后清空」副作用
* 由组合器承担。
*
* 每个面板复用既有 project* 纯函数（format/task-panel、format/todos-panel、
* status-panel、delegation-panel、workflow-panel、config-panel、skill-panel、
* format/lsp-diagnostics、format/glance-bar），本模块只做「snapshot → 既有面
* 板函数输入」的适配与顺序编排，不重复实现渲染逻辑。依赖方向保持 app.ts →
* render/ 单向。
*
* @module @deepseek-ai/dsh-tianshu-tui/render/live-panels
*/
/** 后台任务快照 → 活区卡状态形（running ⠋ / completed › / 其余 ✗）。 */
function taskSnapshotStatus(status) {
	if (status === "running") return "running";
	if (status === "completed") return "success";
	return "error";
}
/**
* 渲染 glance 段：状态行 + 错误行。
* 状态/错误行为纯文本（组合器按需着色）。metrics 行自 C4 概念稿 C 起移出
* glance 面板——由 renderLive 在输入行下方常驻渲染（三行底部区），避免
* 顶部/底部双份。
* @param snapshot - 当前帧快照。
* @returns 面板行数组（状态行恒存在；错误行按数据追加）。
*/
function renderGlancePanel(snapshot) {
	const rows = [];
	if (snapshot.glanceStatus !== null) rows.push(snapshot.glanceStatus);
	if (snapshot.glanceError !== null) rows.push(snapshot.glanceError);
	return rows;
}
/**
* 渲染任务面板：任务窗格（projectTaskPanel） + 后台任务区（taskSnapshots
* 逐行）。面板隐藏 → 空数组；taskItems 为 null（服务缺失/未写入）→ 窗格不
* 渲染，后台任务区独立渲染（与 renderLive 现状同语义）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组（窗格行在前，后台任务区行在后）。
*/
function renderTasksPanel(snapshot) {
	if (!snapshot.taskPanelVisible) return [];
	const rows = [];
	rows.push(...projectTaskPanel(snapshot.taskItems, snapshot.cols));
	for (const t of snapshot.taskSnapshots) {
		const running = t.status === "running";
		const detail = t.detail;
		rows.push(...formatLiveCard({
			glyph: liveCardGlyph(taskSnapshotStatus(t.status)),
			title: t.label,
			...running || detail === void 0 ? {} : { suffixes: [detail] },
			...running && detail !== void 0 ? { body: [detail] } : {},
			width: snapshot.cols,
			dim: !running,
			theme: snapshot.theme
		}));
	}
	if (rows.length > 0) rows.push(inspectHint(snapshot.cols));
	return rows;
}
/**
* 渲染 /config 设置面板（终端通知 + 宿主设置/权限/凭据）。面板隐藏或
* 投影为 null（尚未刷新）→ 空数组。settings 契约是数组；违约形状（非数组，
* 如单对象）归一为 descriptor 数组再渲染，避免 for...of 对非迭代对象抛错。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderConfigPanel(snapshot) {
	if (!snapshot.configPanelVisible) return [];
	if (snapshot.configProjection === null) return [];
	const projection = snapshot.configProjection;
	const settings = Array.isArray(projection.settings) ? projection.settings : Object.entries(projection.settings).map(([ns, value]) => ({
		ns,
		value
	}));
	return projectConfigPanel({
		...projection,
		settings,
		permission: projection.permission ?? null
	}, { width: snapshot.cols });
}
/**
* 渲染 todos 紧凑待办面板（/todos）：有未完成项时列出条目（进行中置顶，
* 默认最多 5 条）；全完成仍一行。面板隐藏 → 空数组。数据源是保留快照
* （turn/start 清空不回退——黏滞语义在 app.ts，本函数保持纯呈现）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderTodosPanel(snapshot) {
	if (!snapshot.todosPanelVisible) return [];
	return projectTodosPanel(snapshot.todosItems, {
		width: snapshot.cols,
		expanded: snapshot.todosExpanded
	});
}
/**
* 渲染 /skills 技能面板（标题 + 列表行 + 命中的选中详情行）。面板隐藏 →
* 空数组；空列表渲染标题 + 空态占位（由 projectSkillPanel 承担）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderSkillsPanel(snapshot) {
	if (!snapshot.skillsPanelVisible) return [];
	const rows = projectSkillPanel(snapshot.skillItems, {
		width: snapshot.cols,
		...snapshot.skillSelected === void 0 ? {} : { selected: snapshot.skillSelected }
	});
	if (snapshot.skillItems.length > 0) rows.push(inspectHint(snapshot.cols, ["↑↓ 详情"]));
	else rows.push(inspectHint(snapshot.cols));
	return rows;
}
/**
* 渲染 /subagents 委派树面板（标题 + 每层委派一行）。面板隐藏或 entries 为
* null（服务缺失/未预取）→ 空数组（降级不渲染）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderDelegationPanel(snapshot) {
	if (!snapshot.subagentsPanelVisible) return [];
	if (snapshot.delegationEntries === null) return [];
	const opts = {
		width: snapshot.cols,
		...snapshot.now === void 0 ? {} : { now: snapshot.now },
		theme: snapshot.theme
	};
	const rows = projectDelegationTree(mergeDelegationProjections(snapshot.delegationEntries, snapshot.subagentIdentities, snapshot.subagentTimings), opts);
	rows.push(...projectExternalRunSection(snapshot.externalRuns, opts));
	return rows;
}
/** 旧宿主旁路 Map 合并进条目；条目自带 progress/timing 不覆盖。 */
function mergeDelegationProjections(entries, identities, timings) {
	return entries.map((entry) => {
		if (entry.kind !== "child") return entry;
		const identity = identities.get(entry.id);
		const timing = entry.timing ?? timings.get(entry.id);
		const label = identity?.label ?? entry.label;
		return {
			...entry,
			mode: identity?.mode ?? entry.mode,
			...label === void 0 ? {} : { label },
			...timing === void 0 ? {} : { timing }
		};
	});
}
/** 委派树 → workflow roster childState。 */
function childStateFromEntries(entries) {
	if (entries === null) return void 0;
	const map = /* @__PURE__ */ new Map();
	for (const entry of entries) if (entry.kind === "child") map.set(entry.id, {
		label: entry.label ?? shortSessionLabel(entry.id),
		running: entry.activity === "running"
	});
	return map;
}
/**
* 渲染 /workflow 运行态面板（列表行 + 展开的叙述/roster + 终态汇总）。面板隐藏 → 空数组。
* projectWorkflow 只消费 meta.name；本适配层把 run id 注入列表行
* （meta.description 追加 "(id)" 后缀；name 已是 id 时不重复），使 run 标识
* 在面板可见且不破坏 [name] 徽标形态。
* 展开集合：运行中 run（result 未结算）自动展开——叙述行与 roster 是运行期
* 唯一可见面，折叠会让 workflow/log 消费无处呈现。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderWorkflowPanel(snapshot) {
	if (!snapshot.workflowPanelVisible) return [];
	const runs = snapshot.workflowRuns.map(withVisibleRunId);
	return projectWorkflow(runs, {
		width: snapshot.cols,
		expanded: runs.filter((run) => run.result === void 0).map((run) => run.info.id),
		childState: childStateFromEntries(snapshot.delegationEntries)
	});
}
/** 使 run id 在列表行可见：meta.description 追加 "(id)" 后缀（name 已是 id 时不重复）。 */
function withVisibleRunId(run) {
	if (run.info.meta.name === run.info.id) return run;
	const idSuffix = `(${run.info.id})`;
	const description = run.info.meta.description === "" ? idSuffix : `${run.info.meta.description} ${idSuffix}`;
	return {
		...run,
		info: {
			...run.info,
			meta: {
				...run.info.meta,
				description
			}
		}
	};
}
/**
* 渲染 /status 状态面板（目标段 + 任务段 + 计划段 + 会话汇总段）。面板隐藏 →
* 空数组。todos 为 null 时任务段渲染「（无任务）」占位（区别于 goal/plan 为
* null 时对应段不渲染的语义——todos null = 已清空/未写入，面板打开即展示
* 任务区）。会话段数据源是 TUI 本地 summary-state fold（不依赖宿主投影总线，
* turns 为 0 时该段不渲染）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderStatusPanel(snapshot) {
	if (!snapshot.statusPanelVisible) return [];
	const rows = projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, {
		width: snapshot.cols,
		sessionTotals: snapshot.sessionTotals
	});
	rows.push(inspectHint(snapshot.cols));
	return rows;
}
/**
* 渲染 /lsp 诊断面板（按文件分组的诊断列表；severity 着色）。面板隐藏 →
* 空数组。空诊断列表渲染空态行（区分「无诊断」与「server 未安装」）。
* @param snapshot - 当前帧快照。
* @returns 面板行数组。
*/
function renderLspPanel(snapshot) {
	if (!snapshot.lspPanelVisible) return [];
	const rows = projectLspPanel(groupLspDiagnostics(snapshot.lspDiagnostics), snapshot.theme, snapshot.lspAvailable);
	rows.push(inspectHint(snapshot.cols));
	return rows;
}
/**
* 活动带：只消费 snapshot 已 fold 的 activityItems。关闭或无 running → 零行。
* 关带时的散行逃生门仍由组合器走 renderActivitySection({ enabled: false })。
*/
function renderActivityBand(snapshot) {
	if (!snapshot.activityBandEnabled) return [];
	return formatActivityBand(snapshot.activityItems, {
		width: snapshot.cols,
		maxRows: snapshot.activityBandMaxRows,
		now: snapshot.now ?? 0,
		tick: snapshot.tick,
		theme: snapshot.theme
	});
}
//#endregion
//#region lib/types/ui/activity-flow.js
/**
* activity-flow — 子代理/工作流活动带的纯装配面。
*
* 把 TuiApp 缓存 fold 成活动带、完成行摘要、委派树合并与外部 run 读取。
* 不碰渲染引擎、不订阅事件；缺宿主面（subagentProgress / activeExternalRuns）
* 时对应段为空，不抛。
*
* @module @huiliyi37/dsh-tianshu-tui/ui/activity-flow
*/
/** 委派快照切片（identities/timings 旁路 + 外部 run / now）。 */
function delegationSnapshotSlice(input) {
	return {
		subagentsPanelVisible: input.subagentsPanelVisible,
		delegationEntries: input.delegationEntries,
		subagentIdentities: input.projectionCache?.subagent ?? /* @__PURE__ */ new Map(),
		subagentTimings: input.projectionCache?.subagentTiming ?? /* @__PURE__ */ new Map(),
		externalRuns: input.externalRuns,
		now: input.now
	};
}
/** 运行中 workflow 缓存 → 面板视图。 */
function runningWorkflowView(state, now) {
	return {
		info: {
			id: state.id,
			meta: state.meta
		},
		agents: state.agents.map((a) => ({
			seq: a.seq,
			label: a.label,
			childId: a.childId ?? "",
			outcome: a.outcome ?? "completed"
		})),
		elapsedMs: now - state.startedAt,
		...state.logs.length === 0 ? {} : { logs: [...state.logs] }
	};
}
/** 运行中 + 已结算 workflow → 面板视图。 */
function foldWorkflowViews(running, completed, now) {
	const views = [];
	for (const state of running) views.push(runningWorkflowView(state, now));
	views.push(...completed);
	return views;
}
/** workflow/end 折叠为带 result 的视图。 */
function settleWorkflowView(state, result, now) {
	return {
		...runningWorkflowView(state, now),
		result: {
			stopReason: result.stopReason,
			...result.error === void 0 ? {} : { error: result.error },
			agentsStarted: state.agents.length
		}
	};
}
/** end 时取走 child 统计（无缓存 → undefined）。 */
function takeChildStats(childProgress, childId) {
	const progress = childProgress.get(childId);
	childProgress.delete(childId);
	return progress === void 0 ? void 0 : {
		toolCalls: progress.toolCalls,
		tokensUsed: progress.tokensUsed
	};
}
/** 子会话投影：缓存 progress / 重拉树。无关 key 早退。 */
function noteForeignProjection(input, state, refreshTree) {
	if (input.key !== "subagentProgress" && input.key !== "subagentTiming") return false;
	let isRunningChild = false;
	if (input.key === "subagentProgress") {
		for (const run of state.subagentRuns) if (run.childId === input.sessionId) {
			isRunningChild = true;
			break;
		}
	}
	let treeHasChild = false;
	if (input.panelVisible && state.delegationEntries !== null) {
		for (const entry of state.delegationEntries) if (entry.kind === "child" && entry.id === input.sessionId) {
			treeHasChild = true;
			break;
		}
	}
	const hit = classifyForeignProjection({
		key: input.key,
		value: input.value,
		panelVisible: input.panelVisible,
		treeHasChild,
		isRunningChild
	});
	if (hit.cacheProgress !== null) state.childProgress.set(input.sessionId, hit.cacheProgress);
	if (hit.refreshTree) refreshTree();
	return hit.cacheProgress !== null;
}
/** 投影总线的 subagentProgress 值结构校验。 */
function isSubagentProgressValue(value) {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	return typeof v.toolCalls === "number" && typeof v.tokensUsed === "number" && typeof v.toolInFlight === "boolean";
}
/** 子会话投影变更：是否缓存 progress、是否重拉委派树。 */
function classifyForeignProjection(input) {
	return {
		cacheProgress: input.key === "subagentProgress" && input.isRunningChild ? isSubagentProgressValue(input.value) ? input.value : null : null,
		refreshTree: input.panelVisible && (input.key === "subagentProgress" || input.key === "subagentTiming") && input.treeHasChild
	};
}
/** 三类缓存 → 活动带 items。 */
function foldActivityFromCaches(input) {
	const subagentRuns = [];
	for (const [runId, run] of input.subagentRuns) {
		const progress = input.childProgress.get(run.childId);
		subagentRuns.push({
			runId,
			label: run.label,
			startedAt: run.startedAt,
			...progress === void 0 ? {} : { progress: {
				toolCalls: progress.toolCalls,
				tokensUsed: progress.tokensUsed,
				...progress.lastTool === void 0 ? {} : { lastTool: progress.lastTool }
			} }
		});
	}
	const workflowRuns = [];
	for (const state of input.workflowRuns) workflowRuns.push({
		id: state.id,
		name: state.meta.name,
		description: state.meta.description,
		phase: state.phase,
		agentCount: state.agents.length,
		startedAt: state.startedAt
	});
	const tasks = [];
	for (const t of input.tasks) if (t.status === "running" || t.status === "stopping") tasks.push({
		id: t.id,
		kind: t.kind,
		label: t.label,
		startedAt: t.startedAt
	});
	return foldActivityItems({
		subagentRuns,
		workflowRuns,
		tasks
	});
}
/** 活动带或逃生门散行（关带时不 fold）。 */
function renderActivitySection(input) {
	if (!input.enabled) {
		const rows = [];
		for (const [, run] of input.subagentRuns) rows.push(...formatSubagentRunning({
			width: input.width,
			label: run.label,
			tick: input.tick
		}, input.theme));
		return rows;
	}
	return formatActivityBand(foldActivityFromCaches({
		subagentRuns: input.subagentRuns,
		childProgress: input.childProgress,
		workflowRuns: input.workflowRuns,
		tasks: input.tasks
	}), {
		width: input.width,
		maxRows: input.maxRows,
		now: input.now,
		tick: input.tick,
		theme: input.theme
	});
}
/** workflow 结束摘要（已着色）。 */
function formatWorkflowSummary(view, theme) {
	const reason = view.result?.stopReason;
	const mark = reason === "completed" ? "✓" : reason === "cancelled" ? "⊘" : "✗";
	const markColor = reason === "completed" ? theme.success : reason === "cancelled" ? theme.muted : theme.error;
	const description = view.info.meta.description === "" ? `[${view.info.meta.name}]` : `[${view.info.meta.name}] ${view.info.meta.description}`;
	const elapsed = view.elapsedMs === void 0 ? "" : ` · ${formatElapsedHuman(view.elapsedMs)}`;
	return `${color(mark, markColor)}${color(` ${description} · ${view.agents.length} 个 agent${elapsed}`, theme.muted)}`;
}
/** 可选 activeExternalRuns；缺失或抛错 → 空数组。 */
function readExternalRuns(facet) {
	if (facet?.activeExternalRuns === void 0) return [];
	try {
		const rows = facet.activeExternalRuns();
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}
/** workflow 事件的订阅、运行/终态双缓存与视图折叠（渲染消费方经只读入口读取）。 */
var WorkflowSurfaceController = class {
	opts;
	running = /* @__PURE__ */ new Map();
	completed = /* @__PURE__ */ new Map();
	currentDisposer = null;
	constructor(opts) {
		this.opts = opts;
	}
	/** 运行中 run 数（子代理完成通知门槛据此静默）。 */
	get runningCount() {
		return this.running.size;
	}
	/** 运行中缓存视图（foldWorkflowViews / renderActivitySection 消费）。 */
	runningViews() {
		return this.running.values();
	}
	/** 已折叠终态视图（/workflow 面板渲染运行中 + 已完成）。 */
	completedViews() {
		return this.completed.values();
	}
	/**
	* 订阅六事件：先释放上一轮订阅再清运行态缓存（语义与提取前一致：
	* 重挂载即重新收集进行中的 run；终态缓存不清理）。
	* @param subscribe - 按事件名收窄 handler 的订阅函数（app 侧 `(e, cb) => ctx.on(e, cb)`）。
	* @returns 本轮订阅的整体 disposer（app.dispose 与下次 attach 前调用）。
	*/
	attach(subscribe) {
		this.currentDisposer?.();
		this.running.clear();
		const disposers = [
			subscribe("workflow/start", (info) => {
				const meta = info.meta;
				this.running.set(info.id, {
					id: info.id,
					meta: {
						name: meta?.name ?? info.id,
						description: meta?.description ?? "",
						...meta?.phases === void 0 ? {} : { phases: meta.phases }
					},
					startedAt: Date.now(),
					phase: null,
					agents: [],
					logs: []
				});
				this.opts.flushLive();
			}),
			subscribe("workflow/phase", (info, title) => {
				const run = this.running.get(info.id);
				if (run !== void 0) {
					run.phase = title;
					this.opts.schedule();
				}
			}),
			subscribe("workflow/log", (info, message) => {
				const run = this.running.get(info.id);
				if (run !== void 0) {
					run.logs.push(message);
					if (run.logs.length > 20) run.logs.splice(0, run.logs.length - 20);
					this.opts.schedule();
				}
			}),
			subscribe("workflow/agent-start", (info, agent) => {
				const run = this.running.get(info.id);
				if (run !== void 0) {
					run.agents.push({
						seq: agent.seq,
						label: agent.label,
						childId: agent.childId ?? ""
					});
					this.opts.schedule();
				}
			}),
			subscribe("workflow/agent-end", (info, agent) => {
				const slot = this.running.get(info.id)?.agents.find((a) => a.seq === agent.seq);
				if (slot !== void 0) {
					slot.outcome = agent.outcome;
					this.opts.schedule();
				}
			}),
			subscribe("workflow/end", (info, result) => {
				const run = this.running.get(info.id);
				if (run !== void 0) {
					const view = settleWorkflowView(run, result, Date.now());
					this.running.delete(info.id);
					this.completed.set(info.id, view);
					this.opts.onCompleted(view, run.meta.name);
				}
			})
		];
		this.currentDisposer = () => {
			for (const d of disposers) d();
		};
		return this.currentDisposer;
	}
	/** 释放当前订阅（不清缓存：dispose 后仍可读终态视图渲染收尾帧）。 */
	detach() {
		this.currentDisposer?.();
		this.currentDisposer = null;
	}
};
//#endregion
//#region lib/types/controllers/delegation-surface.js
/**
* DelegationSurfaceController — 子代理委派域的订阅与缓存（T2.1，提取自 ui/app.ts）。
*
* 两条数据流：委派树（listDescendants 预取 + subagent/start|end 重拉 → /subagents
* 面板与活动带）与对话流运行行（runId 缓存 → live 运行行 + end 终态卡）。
* 本模块不碰渲染与通知：终态数据经 opts.onRunFinished 交还宿主
* （formatSubagentDone + commitToScrollback + os-notify 在 app 侧）。
*
* - attach(sessionId, subscribe)：先释放旧订阅再清全部缓存，随后立即预取一次树。
* - refresh(sessionId)：externalRuns 同步 + listDescendants 异步预取（失败置空重绘，
*   否则旧树滞留到 120ms ticker 自愈；与 then 分支对称调度）。
* - handleForeignProjection(input, opts)：他会话 subagentProgress/Timing 投影的
*   入口——缓存进度、判定是否刷新树，返回是否需要重绘。
*
* @module @huiliyi37/dsh-tianshu-tui/controllers/delegation-surface
*/
/** 委派树的订阅、双缓存（树 + 运行行）与他 会话投影入口（渲染消费方经只读入口读取）。 */
var DelegationSurfaceController = class {
	opts;
	treeEntries = null;
	runs = /* @__PURE__ */ new Map();
	progress = /* @__PURE__ */ new Map();
	externalRunEntries = [];
	currentDisposer = null;
	constructor(opts) {
		this.opts = opts;
	}
	/** 委派树缓存（null = 服务缺失/尚未预取；面板据此降级空态）。 */
	get entries() {
		return this.treeEntries;
	}
	/** 对话流运行中子代理条目（renderActivitySection 消费 runId → run 键值对）。 */
	runningEntries() {
		return this.runs.entries();
	}
	/** 子会话进度缓存只读视图（活动带渲染；写入仅经 handleForeignProjection）。 */
	progressView() {
		return this.progress;
	}
	/** 外部运行条目（delegationSnapshotSlice 消费）。 */
	externalRuns() {
		return this.externalRunEntries;
	}
	/**
	* 订阅 start|end 双事件（各两处 handler：树刷新 + 运行行），先释放上一轮
	* 再清全部缓存，并按传入会话立即预取一次树。
	* @returns 本轮订阅的整体 disposer（app.dispose 与下次 attach 前调用）。
	*/
	attach(sessionId, subscribe) {
		this.currentDisposer?.();
		this.treeEntries = null;
		this.runs.clear();
		this.progress.clear();
		this.externalRunEntries = [];
		const disposers = [
			subscribe("subagent/start", () => {
				this.refresh(sessionId);
			}),
			subscribe("subagent/end", () => {
				this.refresh(sessionId);
			}),
			subscribe("subagent/start", (info) => {
				this.runs.set(info.runId, {
					label: this.label(info.id),
					startedAt: Date.now(),
					childId: info.id
				});
				this.opts.schedule();
			}),
			subscribe("subagent/end", (info) => {
				const run = this.runs.get(info.runId);
				if (run === void 0) return;
				this.runs.delete(info.runId);
				this.opts.onRunFinished({
					label: run.label,
					elapsedMs: Date.now() - run.startedAt,
					stopReason: info.stopReason,
					stats: takeChildStats(this.progress, run.childId)
				});
			})
		];
		this.currentDisposer = () => {
			for (const d of disposers) d();
		};
		this.refresh(sessionId);
		return this.currentDisposer;
	}
	/** 释放当前订阅（不清缓存：dispose 后仍可读终态渲染收尾帧）。 */
	detach() {
		this.currentDisposer?.();
		this.currentDisposer = null;
	}
	/**
	* 对话流运行行的显示标签：委派树缓存命中 label 用之，否则 id 短哈希兜底。
	*/
	label(id) {
		for (const e of this.treeEntries ?? []) if (e.kind === "child" && e.id === id) return e.label ?? shortSessionLabel(id);
		return shortSessionLabel(id);
	}
	/**
	* 预取委派树（async）：服务缺失置 null 降级；externalRuns 同步刷新。
	* 失败同样置空 + 重绘（否则滞留旧树直到 120ms ticker 自愈）。
	*/
	refresh(sessionId) {
		const subagents = this.opts.getService();
		if (subagents === void 0) {
			this.treeEntries = null;
			this.externalRunEntries = [];
			return;
		}
		this.externalRunEntries = readExternalRuns(subagents);
		this.opts.schedule();
		subagents.listDescendants(sessionId).then((entries) => {
			if (this.opts.isDisposed()) return;
			this.treeEntries = entries;
			this.opts.schedule();
		}).catch(() => {
			if (this.opts.isDisposed()) return;
			this.treeEntries = null;
			this.opts.schedule();
		});
	}
	/**
	* 他会话 subagentProgress/subagentTiming 投影入口：缓存进度、必要时重拉树。
	* @returns 是否发生状态变化（宿主据此决定是否 renderBatcher.schedule）。
	*/
	handleForeignProjection(input, opts) {
		return noteForeignProjection({
			sessionId: input.sessionId,
			key: input.key,
			value: input.value,
			panelVisible: opts.panelVisible
		}, {
			childProgress: this.progress,
			subagentRuns: this.runs.values(),
			delegationEntries: this.treeEntries
		}, () => {
			this.refresh(opts.rootSessionId);
		});
	}
};
//#endregion
//#region lib/types/engine/image-preview.js
/**
* 半块字符图片预览 — 把 data URL 图片降采样为 `▀`（上色前景 + 下色背景）
* 的真彩 ANSI 文本行。任意终端可用：不依赖 kitty/iTerm2 图形协议，是纯文本，
* 因此 live 区重绘天然擦除（无图形协议的残影治理问题），也是无协议终端上
* 用户气泡图片的回退渲染路径（见 app.commitUserPrompt）。
* 回流自 tianshu-public（上游 src/engine/image-preview.ts）。
*
* 像素解码走 sharp（懒加载）：原生模块缺失或解码失败返回 null，调用方降级
* 为纯文本占位——预览是装饰性能力，不构成发送路径的前置条件。
*/
/** 字符 cell 高宽比（≈2，与 term-image 同一估计）。 */
const CELL_ASPECT = 2;
/** 主题未给气泡底色时的透明像素合成底色（中性暗色，明暗终端都可读）。 */
const NEUTRAL_PREVIEW_BACKGROUND = {
	r: 20,
	g: 20,
	b: 26
};
/**
* `#rrggbb` → RGB；用于把主题 truecolor 底色喂给预览合成。
* @param hex - 六位十六进制颜色字符串（带 # 前缀）
* @returns RGB 分量；格式不符返回 null
*/
function hexToRgb$1(hex) {
	const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
	if (!m || m[1] === void 0) return null;
	const n = Number.parseInt(m[1], 16);
	return {
		r: n >> 16 & 255,
		g: n >> 8 & 255,
		b: n & 255
	};
}
/**
* `▀` 是 East Asian Width Ambiguous：宽模式终端里占 2 格且我们的 displayWidth
* 计 2 格。预算列数折半，使预览的显示宽度与行数计量在两种模式下都成立。
*/
function gridCols(maxCols) {
	return Math.max(1, Math.floor(maxCols / (ambiguousWideEnabled() ? 2 : 1)));
}
/**
* data URL → 半块字符预览。网格按图片宽高比适配进 maxCols×maxRows 超框
* （cell 按 2:1 估计），正常情况不裁切；极端纵横比被上限截断时按剩余高度
* 反推列数（fit 语义，cover 兜底取整误差）。
* @param dataUrl - 图片 data URL（经 parseImageDataUrl 同规则校验）
* @param opts - maxCols/maxRows 网格上限；background 透明像素合成底色（RGB）
* @returns 渲染结果；校验失败、sharp 不可用或解码失败返回 null
*/
async function renderHalfBlockPreview(dataUrl, opts) {
	const parsed = parseImageDataUrl(dataUrl);
	if (!parsed) return null;
	let sharp;
	try {
		({default: sharp} = await import("sharp"));
	} catch {
		return null;
	}
	try {
		const input = sharp(Buffer.from(parsed.b64, "base64"), { failOn: "none" });
		const meta = await input.metadata();
		const width = meta.width;
		const height = meta.height;
		if (width <= 0 || height <= 0) return null;
		const cols = gridCols(Math.max(1, Math.min(opts.maxCols, Math.max(width, 8))));
		let rows = Math.max(1, Math.round(cols * height / (width * CELL_ASPECT)));
		let fitCols = cols;
		if (rows > opts.maxRows) {
			rows = opts.maxRows;
			fitCols = Math.max(1, Math.round(rows * CELL_ASPECT * width / height));
		}
		return {
			lines: halfBlockLines(await input.resize(fitCols, rows * CELL_ASPECT, {
				fit: "cover",
				kernel: "nearest"
			}).flatten({ background: opts.background }).removeAlpha().raw().toBuffer(), fitCols, rows),
			cols: fitCols,
			rows
		};
	} catch {
		return null;
	}
}
/**
* RGB 原始像素 → 半块行。每行游程合并同色段（纯色截图的字节数量级下降）。
* @param pixels - RGB 三通道行优先缓冲（cols×rows×2 像素）
* @param cols - 网格列数
* @param rows - 网格行数（每行上下两个像素行）
* @returns ANSI 文本行数组
*/
function halfBlockLines(pixels, cols, rows) {
	const lines = [];
	for (let y = 0; y < rows; y++) {
		let line = "";
		let runFg = -1;
		let runBg = -1;
		let runLen = 0;
		for (let x = 0; x < cols; x++) {
			const top = (y * 2 * cols + x) * 3;
			const bottom = ((y * 2 + 1) * cols + x) * 3;
			const fg = pixels.readUInt8(top) << 16 | pixels.readUInt8(top + 1) << 8 | pixels.readUInt8(top + 2);
			const bg = pixels.readUInt8(bottom) << 16 | pixels.readUInt8(bottom + 1) << 8 | pixels.readUInt8(bottom + 2);
			if (fg === runFg && bg === runBg) {
				runLen += 1;
				continue;
			}
			line = appendRun(line, runFg, runBg, runLen);
			runFg = fg;
			runBg = bg;
			runLen = 1;
		}
		line = appendRun(line, runFg, runBg, runLen);
		lines.push(line + "\x1B[0m");
	}
	return lines;
}
/** 追加一段同色 ▀ 游程（首个游程 runLen=0 时原样返回）。 */
function appendRun(line, fg, bg, runLen) {
	if (runLen === 0) return line;
	return line + `\x1B[38;2;${fg >> 16 & 255};${fg >> 8 & 255};${fg & 255}m\x1B[48;2;${bg >> 16 & 255};${bg >> 8 & 255};${bg & 255}m` + "▀".repeat(runLen);
}
//#endregion
//#region lib/types/controllers/commit-surface.js
/**
* CommitSurface — 滚动区提交写入域（C4 第二波，自 ui/app.ts 抽出）。
*
* 职责：所有进 scrollback 的写入编舞——
* - 原子提交（输入框闪烁根修，34a3e07）：BEGIN_SYNC 包裹「清 live 区 → 写
*   scrollback → 同步重绘」，END_SYNC 收口；窗内 LiveEngine.render 自带的
*   嵌套 begin 按 CSI 2026 语义忽略、其 end 释放点恰是完整新帧写完之时。
* - overlay 激活（alt screen）期的暂存队列：条目与图片序列同队保序，退出后
*   按同一协议补写主屏。
* - 用户气泡：正文 + 📎 附件行 + 识图能力三态提示；图形协议终端异步 prepare
*   终端图片并按同一写窗口协议追加，无协议终端降级半块字符预览。
*
* 不拥有：LiveEngine/CommitEngine 生命周期（构造注入）、渲染调度（经
* {@link CommitSurfaceDeps.flushRender} 穿透 WriteBatcher.flushNow）、overlay
* 本体（经 {@link CommitSurfaceDeps.isOverlayActive} 判定）、vision 配置态
* （经 {@link CommitSurfaceDeps.vision} 读取——app 侧 resolveVisionBridge 会
* 原地改写桥状态，必须每次回调取新值）。
*
* @module @huiliyi37/dsh-tianshu-tui/controllers/commit-surface
*/
/**
* 滚动区提交写入域。方法名对齐语义：text 文本条目、raw 原始序列、
* userPrompt 用户气泡（含图片链路）、flushDeferred 补写暂存。
*/
var CommitSurface = class {
	live;
	commit;
	stdout;
	deps;
	deferred = [];
	constructor(deps) {
		this.live = deps.live;
		this.commit = deps.commit;
		this.stdout = deps.stdout;
		this.deps = deps;
	}
	/**
	* 原子提交编舞（输入框闪烁根修，2026-08-27）：BEGIN_SYNC 包裹
	* 「清 live 区 → 写 scrollback → 同步重绘」，END_SYNC 收口。
	*
	* 旧序里 clearForCommit 同步直写擦掉整个 live 区（含待办卡/输入轨/footer），
	* 重绘却交给 WriteBatcher 的 16ms 尾沿——每个段落/思考块落底后屏幕上真实缺席
	* 一帧 chrome，推理期段边界密集即呈现为「输入框消失几帧又出现」。三步收敛进
	* 同一轮事件循环后间隙只剩写入耗时；再包 CSI 2026 同步窗把它对终端合成器也
	* 隐藏。窗内 LiveEngine.render 自带的嵌套 begin 按 CSI 2026 语义忽略、其 end
	* 的释放点恰是整幅新帧写完之时，擦除中间态不再有任何显示窗口。
	*/
	atomic(writeScrollback) {
		this.stdout.write(ANSI.BEGIN_SYNC);
		try {
			this.live.clearForCommit();
			writeScrollback();
			this.deps.flushRender();
		} finally {
			this.stdout.write(ANSI.END_SYNC);
		}
	}
	/** 文本条目写入。overlay 激活时只入队，退出 alt screen 后按同一协议补写。 */
	text(entry) {
		if (this.deps.isOverlayActive()) {
			this.deferred.push(entry);
			return;
		}
		this.atomic(() => {
			this.commit.write(entry);
		});
	}
	/** 原始 ANSI 序列写入（终端图片图形序列等）。overlay 语义同 {@link text}。 */
	raw(seq) {
		if (this.deps.isOverlayActive()) {
			this.deferred.push({ raw: seq });
			return;
		}
		this.atomic(() => {
			this.commit.writeRaw(seq);
		});
	}
	/** overlay 退出后把暂存条目按 mid-stream 协议写入主屏 scrollback。 */
	flushDeferred() {
		const pending = this.deferred;
		if (pending.length === 0) return;
		this.deferred = [];
		this.atomic(() => {
			for (const entry of pending) {
				this.live.clearForCommit();
				if ("raw" in entry) this.commit.writeRaw(entry.raw);
				else this.commit.write(entry);
			}
		});
	}
	/**
	* 用户气泡提交：正文 + 图片附件行 + 识图能力提示（vision 三态文案）。
	* 有图且终端支持图形协议时，图片在气泡提交后异步 prepare（本地转码，
	* 毫秒级，先于任何网络往返的 assistant 输出）并以同一写窗口协议追加
	* 图形序列——物理上图片位于所属气泡下方、先于后续流式输出；prepare
	* 失败静默降级为纯文本气泡。
	* @param content - 用户消息正文（已 mention 展开）
	* @param images - 图片 data URL 列表（已 normalize；可省略）
	*/
	userPrompt(content, images) {
		const protocol = imageProtocol();
		const withImages = images !== void 0 && images.length > 0 && protocol !== "none";
		this.text({
			text: this.userBubbleLines(content, images),
			trailingNewline: true
		});
		if (images !== void 0 && images.length > 0 && protocol === "none") this.halfBlockImages(images);
		if (!withImages) return;
		(async () => {
			let prepared = [];
			try {
				for (const dataUrl of images.slice(0, 4)) {
					const img = await prepareTermImageForCommit(dataUrl, protocol);
					if (img) prepared.push(img);
				}
			} catch {
				prepared = [];
			}
			if (prepared.length === 0) return;
			const cols = Math.max(10, this.stdout.columns - 4);
			const maxRows = Math.max(5, Math.min(40, (this.stdout.rows || 24) - 6));
			let seq = "";
			for (const img of prepared) {
				const s = encodeTermImage(img, protocol, cols, maxRows);
				if (s) seq += s + (protocol === "kitty" ? "\r" : "\r\n");
			}
			if (!seq) return;
			this.raw(seq);
		})();
	}
	/**
	* 无图形协议终端的气泡图片回退：半块字符预览写进 scrollback（与图形路径
	* 同编舞——先清 live 区再 writeRaw，写完立即重绘）。解码失败返回 null 已在
	* 渲染器内吞并，此处无需再兜——静默降级为纯文本气泡（📎 行已随正文写入）。
	* @param images - 图片 data URL 列表（与气泡一致，封顶 MAX_IMAGES）
	*/
	async halfBlockImages(images) {
		const cols = Math.max(10, this.stdout.columns - 4);
		const blocks = [];
		for (const dataUrl of images.slice(0, 4)) {
			const preview = await renderHalfBlockPreview(dataUrl, {
				maxCols: cols,
				maxRows: 16,
				background: this.deps.previewBackground()
			});
			if (preview) blocks.push(preview.lines.join("\r\n"));
		}
		if (blocks.length === 0) return;
		this.raw(blocks.join("\r\n") + "\r\n");
	}
	/** 用户气泡正文（含 📎 附件行与识图能力提示）。 */
	userBubbleLines(content, images) {
		const theme = this.deps.getTheme();
		const hasImages = images !== void 0 && images.length > 0;
		let imageNote = "";
		if (hasImages) {
			imageNote = `\n${color(`📎 ${images.length} image${images.length > 1 ? "s" : ""} attached`, theme.muted)}`;
			const vision = this.deps.vision();
			if (!vision.supportsVision) {
				if (vision.bridgeEnabled) {
					const src = vision.bridgeSource === "auto" ? "（自动选用的视觉模型）" : "";
					imageNote += `\n${color(`🖼 主模型不识图，将经识图桥${src}生成图片描述后发送`, theme.muted)}`;
				} else imageNote += `\n${color("⚠ 当前模型不支持识图，且无可用识图桥，图片未发送。请在配置中指定识图模型。", theme.warning)}`;
			}
		}
		return formatUserMessage({
			content: content.trim() + imageNote,
			width: this.stdout.columns
		}, theme).join("\n");
	}
};
//#endregion
//#region lib/types/controllers/attachment-preview.js
/**
* attachment-preview — composer 附件缩略图维护（自 ui/app.ts C4 提取）。
*
* 附件列表变化时重算最后一张的半块预览。sharp 异步解码毫秒级，完成后回调
* 触发一次重绘；代际号丢弃迟到结果（快速增删/提交清空后不再挂出过期图片）。
* 渲染失败置 null——计数行仍在，预览是装饰性增强。
*/
var AttachmentPreviewController = class {
	preview = null;
	epoch = 0;
	opts;
	constructor(opts) {
		this.opts = opts;
	}
	/** 当前预览 ANSI 行（无附件/解码失败为空数组——渲染不占位）。 */
	get lines() {
		return this.preview?.lines ?? [];
	}
	/**
	* 附件列表变化 → 重算最后一张的半块预览。
	* @param images - 变化后的附件 data URL 列表
	*/
	async refresh(images) {
		const last = images[images.length - 1];
		if (last === void 0) {
			this.preview = null;
			return;
		}
		if (this.preview?.dataUrl === last) return;
		const epoch = ++this.epoch;
		const preview = await renderHalfBlockPreview(last, {
			maxCols: Math.max(8, Math.min(30, this.opts.getColumns() - 6)),
			maxRows: 10,
			background: this.background()
		});
		if (epoch !== this.epoch) return;
		this.preview = preview === null ? null : {
			dataUrl: last,
			lines: preview.lines
		};
		this.opts.onChanged();
	}
	/** 预览合成底色：本仓主题无气泡底色键（userMsgBg），统一用中性暗色（明暗终端都可读）。 */
	background() {
		const bg = this.opts.getBackground();
		if (bg === void 0) return NEUTRAL_PREVIEW_BACKGROUND;
		return hexToRgb$1(bg) ?? NEUTRAL_PREVIEW_BACKGROUND;
	}
};
//#endregion
//#region lib/types/format/error-recovery.js
/**
* agent 错误 → 恢复指引尾注（format/error-recovery.ts）——纯函数，可单测。
*
* 模式识别表（顺序即优先级，先命中先返回）：
* - 401 / unauthorized / 鉴权                          → /key 重新配置
* - context overflow / context length / too long / 长度 → /compact 压缩上下文
* - timeout / timed out / 网络 / ECONN（ECONNREFUSED 等）→ ↑ 收回重发
* - 兜底                                                → Esc 打断 · ↑ 重发 · /session 换会话
*/
/**
* 识别 agent 错误文本，返回恢复操作指引（echoWarn hint 尾注的数据源）。
* @param message - 错误全文（大小写不敏感；鉴权/超长/超时三族 + 兜底）。
* @returns 一行可操作的恢复指引。
*/
function errorRecoveryHint(message) {
	const m = message.toLowerCase();
	if (m.includes("401") || m.includes("unauthorized") || m.includes("鉴权")) return "/key 重新配置";
	if (m.includes("context overflow") || m.includes("context length") || m.includes("too long") || m.includes("长度")) return "/compact 压缩上下文";
	if (m.includes("timeout") || m.includes("timed out") || m.includes("网络") || m.includes("econn")) return "↑ 收回重发";
	return "Esc 打断 · ↑ 重发 · /session 换会话";
}
/**
* 警告行 + 可选恢复指引尾随行的着色组装（echoWarn 与 renderLive 错误落底共用）：
* 警告走 warning 色，尾随行 dim 色 `  ↳ <hint>`（缩进对齐既有「  · 」多行指引风格）。
* @param text - 警告正文（可多行）。
* @param hint - 恢复指引；undefined 时只有警告行。
* @param theme - 取 warning/dim 两色。
* @returns 着色后的 1-2 行 ANSI 文本。
*/
function formatWarnWithHint(text, hint, theme) {
	const head = color(text, theme.warning);
	return hint === void 0 ? head : `${head}\n${color(`  ↳ ${hint}`, theme.dim)}`;
}
//#endregion
//#region lib/types/controllers/error-announcer.js
/**
* error-announcer — agent 错误落底 + 恢复指引 + 错误后回填（自 ui/app.ts 提取）。
*
* 三件事：
* ① glance 完整错误文本以「新错误」出现时落底 scrollback 一次（diff 去重，
*    附 errorRecoveryHint 指引尾注）——同错误逐帧重读不重复落底；
* ② 记录最近一条已投递的用户消息（lastSubmitted；回流自 Tianshu Harness
*    807686a02 的 lastSubmittedText 生命周期：投递时记录、成功 settle 清）；
* ③ 新错误出现且输入行为空时回填该消息——错误时刻可行动：改一下就能重发，
*    以 dim 提示行告知「可能未被完整处理」。已有草稿不抢写；一次错误只
*    回填一次（取走即清，防重入双份）。
*
* 与 Tianshu 原版的差异：dsh-tui 无 abort 独立回填路径，故 abort 不清底料
* （后续错误仍可回填）；slash 命令不记入（调用方只在文本投递路径 record）。
*/
/** 回填告知行（dim；commit 由装配方着色上下文决定）。 */
const REFILL_NOTE = "↩ 上一条消息可能未被完整处理——已回填输入框，编辑后回车重发";
var ErrorAnnouncer = class {
	lastText = null;
	lastSubmitted = null;
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/** 文本投递路径调用（slash 命令不记；排队消息在 flush 投递时记）。 */
	recordSubmitted(text) {
		this.lastSubmitted = text;
	}
	/** 成功 settle（非中止 turn/end）清底料——成功后错误不回填旧消息。 */
	clearSubmitted() {
		this.lastSubmitted = null;
	}
	/**
	* followup 投递失败（本地 catch 路径，B1）：失败警告 + 恢复提示落底，
	* 输入行空时回填失败文本。与 announce 的区别：失败原因在本地通道而非
	* glance 错误流；若 lastSubmitted 即该文本则一并消费——防后续 glance
	* 错误对同文二次回填。
	* @param text - 投递失败的消息文本（回填底料）。
	* @param errorMessage - 本地错误信息（catch 原样）。
	* @param inputEmpty - 输入行是否为空（false 不抢写草稿）。
	* @param label - 警告前缀（排队投递失败传「排队消息发送失败」）。
	*/
	notifyDeliveryFailure(text, errorMessage, inputEmpty, label = "消息发送失败") {
		const hint = inputEmpty ? "已回填输入框，编辑后回车重发" : "↑ 从历史取回后重发";
		this.deps.commit(formatWarnWithHint(`⚠ ${label}: ${errorMessage}`, hint, this.deps.getTheme()));
		if (inputEmpty) {
			if (this.lastSubmitted === text) this.lastSubmitted = null;
			this.deps.refillInput(text);
		}
	}
	/**
	* renderLive 逐帧调用；仅「新错误文本」动作（重入安全）。
	* @param errorFull - glance 完整错误文本；null = 当前无错误。
	* @param inputEmpty - 输入行是否为空（false 不抢写草稿）。
	*/
	announce(errorFull, inputEmpty) {
		if (errorFull === null || errorFull === this.lastText) return;
		this.lastText = errorFull;
		this.deps.commit(formatWarnWithHint(errorFull, errorRecoveryHint(errorFull), this.deps.getTheme()));
		const last = this.lastSubmitted;
		if (inputEmpty && last !== null) {
			this.lastSubmitted = null;
			this.deps.commit(REFILL_NOTE);
			this.deps.refillInput(last);
		}
	}
	/** 会话切换/卸载复位：错误去重指针不跨会话（底料随切会话清空语义归调用方）。 */
	reset() {
		this.lastText = null;
	}
};
//#endregion
//#region lib/types/controllers/submit-queue.js
/**
* submit-queue — 运行中提交的本地排队（对标 CC 排队消息；↑ 取回队首）。
*
* 宿主 followup 通道本身是数组 FIFO（agent inbox 逐轮消费，rc.2/alpha.1 一致），
* 且宿主 inbox 其实有公开的 remove(messageId)/replace(...)（dsh-agent
* lib/types/inbox.d.ts）与 cancel(cause, { keepInbox })（runtime-types.d.ts）——
* 排队仍放在 TUI 侧是取舍而非被迫：① ↑ 取回是纯本地操作，不惊动宿主（无需
* 经 messageId 与宿主 inbox 对账）；② 排队期图片以 data URL 暂存本地，投递时
* 才走 attachments 持久化管线（提前入宿主会提前持久化）；③ 语义简单——running
* 期间的 Enter 进本地队列（输入轨上方立即可见），turn/end 按序投递 followup
* （与立即发送的宿主消费时机等价：都在下一轮边界）；中断不清队（保留用户意图）。
* 中轮即时纠偏仍走 /steer、Ctrl+T（宿主 alpha.1 的 queue/steer 双模式亦作此
* 区分）；Ctrl+Enter 插队（cancel-and-send，先打断再发）见文末 cancelAndSendInput。
*/
var SubmitQueueController = class {
	items = [];
	/** 入队（保持提交顺序）。 */
	push(text, images) {
		this.items.push({
			text,
			images
		});
	}
	/** 当前队列长度。 */
	size() {
		return this.items.length;
	}
	/** 只读快照（渲染用）。 */
	peekAll() {
		return this.items;
	}
	/** 取回队首（最旧一条）回输入行。 */
	takeFirst() {
		return this.items.shift();
	}
	/** turn/end 全量取出（按提交顺序投递）。 */
	drain() {
		const out = this.items;
		this.items = [];
		return out;
	}
	/** 切会话清空（调用方负责回显丢弃提示）。 */
	clear() {
		this.items = [];
	}
};
/**
* 排队展示行：`⏳ N 条排队 · 最旧一条（↑ 取回）`，超宽截断。
* @param cols - 终端列数。
* @param items - 只读队列快照。
*/
function formatQueueLine(cols, items) {
	const first = items[0];
	const head = first === void 0 ? "" : ` · ${first.text.replace(/\s+/g, " ")}`;
	return truncateToDisplayWidth(`⏳ ${items.length} 条排队${head}（↑ 取回）`, Math.max(10, cols - 2));
}
/**
* Ctrl+Enter 插队（cancel-and-send）：打断当前回合并把输入行草稿立即发出去。
* 与 Ctrl+T steer 的区别：steer 不打断在途 step（下一轮边界才被消费），
* cancel-and-send 先 cancel（keepInbox——宿主 inbox 里未消费的 steer/排队残留
* 保留），等 whenIdle 落定后再走正常提交路径——此时 agent 已 idle，handleSubmit
* 直发 followup，本地队列里更老的消息排在其后投递（「插队」语义）。先取草稿
* 快照再清空输入行（与 steerInput 同款先清后送）；whenIdle 是 quiescence 语义
* 只 resolve 不 reject——故设超时兜底（见 CANCEL_AND_SEND_IDLE_TIMEOUT_MS）。
* 空白草稿（动作 when 已挡空串，此处挡纯空白）不插队。
* @param deps - 装配依赖（输入行 / 控制面 / 打断 / 提交）。
*/
function cancelAndSendInput(deps) {
	const text = deps.input.value;
	const images = deps.input.images.length > 0 ? deps.input.images : void 0;
	if (text.trim() === "" && images === void 0) return;
	deps.input.setValue("");
	if (images !== void 0) deps.input.clearImages();
	deps.abort();
	const idle = deps.controls?.whenIdle();
	if (idle === void 0) {
		deps.submit(text, images);
		return;
	}
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		deps.input.setValue(text, text.length);
	}, deps.idleTimeoutMs ?? 3e4);
	idle.then(() => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		deps.submit(text, images);
	});
}
/** 缺省目标：DeepSeek 官方路由（向后兼容无参 open 与首启自动引导）。 */
const DEEPSEEK_KEY_TARGET = {
	provider: "deepseek-official",
	displayName: "DeepSeek",
	ref: "DEEPSEEK_API_KEY",
	probe: probeDeepSeekKey
};
/**
* 输入行掩码：≤8 字符全显 •；>8 字符显示固定 `••••…` + 末 4 位明文。
* @param value - 当前输入的明文（不落盘、不入日志）。
* @returns 掩码后的显示文本。
*/
function maskKeyInput(value) {
	if (value.length <= 8) return "•".repeat(value.length);
	return `••••…${value.slice(-4)}`;
}
/**
* 真实探测：GET {baseURL}/models（baseURL = DEEPSEEK_BASE_URL ?? 官方端点，
* 3s 超时）。key 只进 Authorization 头；任何网络/超时异常折叠为 unknown。
* @param key - 待验证的 API key 明文。
* @returns 探测三分类。
*/
async function probeDeepSeekKey(key) {
	const baseURL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
	try {
		const res = await fetch(`${baseURL}/models`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(3e3)
		});
		if (res.status === 401 || res.status === 403) return "invalid";
		return res.ok ? "ok" : "unknown";
	} catch {
		return "unknown";
	}
}
/**
* API Key 设置对话框控制器：纯状态机 + 渲染（OverlayRenderer 契约），I/O
* （describe/set/probe）经构造/open 注入。装配方负责 activate/deactivate 与
* 键路由；wantsClose() 为 true 时装配方 deactivate。
*/
var KeyDialogController = class {
	phase = "input";
	value = "";
	error = null;
	credentials;
	target = DEEPSEEK_KEY_TARGET;
	openFlag = false;
	closeRequested = false;
	getTheme;
	onChange;
	onSaved;
	/** 构造期探测覆盖（测试注入）；目标自带探测之上优先。 */
	probeOverride;
	constructor(opts) {
		this.getTheme = opts.getTheme;
		if (opts.onChange !== void 0) this.onChange = opts.onChange;
		if (opts.onSaved !== void 0) this.onSaved = opts.onSaved;
		this.probeOverride = opts.probe;
	}
	/**
	* 对话框是否打开（装配方 deactivate 时经 onDeactivate 置假）。
	* @returns 打开返回 true。
	*/
	isOpen() {
		return this.openFlag;
	}
	/**
	* 打开对话框并重置状态；凭据服务缺席进降级指引态，否则 describe 预检
	* （writable=false＝进程环境遮蔽 → 说明态）。describe 抛错（面不匹配）时
	* 进入输入态——写不通会在 set 时暴露真实错误（最早可判定处 fails loud）。
	* @param credentials - 凭据服务最小面；undefined = 服务缺席。
	* @param target - 本次配置的供应商目标；缺省 DeepSeek（首启引导与既有调用）。
	*/
	async open(credentials, target) {
		this.credentials = credentials;
		this.target = target ?? DEEPSEEK_KEY_TARGET;
		this.value = "";
		this.error = null;
		this.openFlag = true;
		this.closeRequested = false;
		if (credentials === void 0) {
			this.phase = "unavailable";
			return;
		}
		try {
			const info = await credentials.describe(this.target.ref);
			if (!this.isOpen()) return;
			this.phase = info.writable === false ? "blocked" : "input";
		} catch {
			if (!this.isOpen()) return;
			this.phase = "input";
		}
		this.onChange?.();
	}
	/**
	* 处理按键（装配方在 overlay 激活时全量转发；本方法总是消费）。
	* 输入态：字符/退格编辑、Enter 提交（空值不提交）、Esc/Ctrl+C 取消；
	* confirm-unknown 态：Enter 强存、Esc/Ctrl+C 取消；终态说明态：Enter/Esc 关闭；
	* 瞬时态（probing/saving）：Esc/Ctrl+C 关闭（迟到结果按 openFlag 守卫丢弃），其余忽略。
	* 返回 'close' 时同时置 wantsClose（装配方 deactivate；统一返回词表后
	* 装配方直接消费返回值，wantsClose 保留给既有调用面/测试）。
	* @param name - 按键名（return/escape/backspace/ctrl_c 等）。
	* @param char - 可打印字符（控制键为 ''）。
	* @returns close = 请求关闭；handled = 已消费。
	*/
	handleKey(name, char) {
		if (!this.openFlag) return "handled";
		switch (this.phase) {
			case "input":
				if (name === "escape" || name === "ctrl_c") this.closeRequested = true;
				else if (name === "return") {
					if (this.value !== "") this.submit();
				} else if (name === "backspace") {
					this.value = this.value.slice(0, -1);
					this.error = null;
				} else if (char !== "") {
					this.value += char;
					this.error = null;
				}
				break;
			case "confirm-unknown":
				if (name === "return") this.persist(this.value);
				else if (name === "escape" || name === "ctrl_c") this.closeRequested = true;
				break;
			case "probing":
			case "saving":
				if (name === "escape" || name === "ctrl_c") this.closeRequested = true;
				break;
			case "saved":
			case "blocked":
			case "unavailable": if (name === "return" || name === "escape" || name === "ctrl_c") this.closeRequested = true;
		}
		return this.closeRequested ? "close" : "handled";
	}
	/**
	* bracketed paste / Ctrl+V 文本落地：只进输入态；Key 是单行令牌，
	* 剥掉全部空白字符（粘贴来源可能带换行/空格）。
	* @param text - 终端/剪贴板传来的粘贴文本。
	*/
	pasteText(text) {
		if (!this.openFlag || this.phase !== "input") return;
		this.value += text.replace(/\s+/g, "");
		this.error = null;
	}
	/**
	* 装配方查询：用户已请求关闭（Esc/Ctrl+C/终态 Enter）——deactivate overlay。
	* @returns 请求关闭返回 true。
	*/
	wantsClose() {
		return this.closeRequested;
	}
	/** OverlayRenderer 契约：失活时关旗标，迟到的探测/落盘结果不再改状态。 */
	onDeactivate() {
		this.openFlag = false;
	}
	/** 提交：探测三分类——invalid 回输入态带错误，unknown 进确认态，ok 直接落盘。 */
	submit() {
		const key = this.value;
		this.phase = "probing";
		this.error = null;
		Promise.resolve().then(() => (this.probeOverride ?? this.target.probe)(key)).then((result) => {
			if (!this.openFlag || this.phase !== "probing") return;
			if (result === "invalid") {
				this.phase = "input";
				this.error = "Key 无效（401/403），请检查后重试";
				this.onChange?.();
				return;
			}
			if (result === "unknown") {
				this.phase = "confirm-unknown";
				this.onChange?.();
				return;
			}
			this.persist(key);
		}, () => {
			if (!this.openFlag || this.phase !== "probing") return;
			this.phase = "confirm-unknown";
			this.onChange?.();
		});
	}
	/** 落盘：set 成功进成功态并回调 onSaved（即使用户中途 Esc 关闭，写已提交也要刷新就绪标志）；失败回输入态带 message。 */
	async persist(key) {
		const credentials = this.credentials;
		if (credentials === void 0) return;
		this.phase = "saving";
		this.onChange?.();
		try {
			await credentials.set(this.target.ref, key);
			await this.target.afterSave?.();
		} catch (err) {
			if (!this.openFlag) return;
			this.phase = "input";
			this.error = err instanceof Error ? err.message : String(err);
			this.onChange?.();
			return;
		}
		this.onSaved?.();
		if (!this.openFlag) return;
		this.phase = "saved";
		this.onChange?.();
	}
	/**
	* OverlayRenderer 契约：render(width, height) → string[]。内容短而静态，
	* 高度不参与（对齐 keymap 静态面板）；每行 ANSI 安全截断到 width。
	* @param width - 可用显示宽度。
	* @param _height - 可用行数（本对话框不使用）。
	* @returns 渲染行数组（含 ANSI）。
	*/
	render(width, _height) {
		const theme = this.getTheme();
		const lines = [color(`设置 ${this.target.displayName} API Key`, theme.brandColor, { bold: true })];
		switch (this.phase) {
			case "blocked":
				lines.push("");
				lines.push(color(`进程环境已提供 ${this.target.ref}，文件写入不会生效（环境变量优先）。`, theme.warning));
				lines.push(color("请 unset 后重试，或改用环境变量管理。", theme.muted));
				lines.push("");
				lines.push(color("Enter / Esc 关闭", theme.muted));
				break;
			case "unavailable":
				lines.push("");
				lines.push(color(`当前部署无凭据存储，请设置环境变量 ${this.target.ref}。`, theme.warning));
				lines.push("");
				lines.push(color("Enter / Esc 关闭", theme.muted));
				break;
			case "saved":
				lines.push("");
				lines.push(color("✓ 已保存并生效，无需重启。", theme.success));
				lines.push("");
				lines.push(color("Enter / Esc 关闭", theme.muted));
				break;
			default:
				lines.push(color(`用于 ${this.target.displayName} API 请求认证。`, theme.muted));
				lines.push(color("保存到 $DSH_HOME/.credentials.yaml（0600）；进程环境同名变量优先。", theme.muted));
				lines.push("");
				lines.push(color(`Key: ${maskKeyInput(this.value)}`, theme.primary));
				if (this.phase === "probing") lines.push(color("正在验证 Key…", theme.muted));
				if (this.phase === "saving") lines.push(color("正在保存…", theme.muted));
				if (this.phase === "confirm-unknown") lines.push(color("⚠ 无法验证 Key（网络错误或超时）。", theme.warning));
				if (this.error !== null) lines.push(color(`✗ ${this.error}`, theme.error));
				lines.push("");
				lines.push(color(this.phase === "confirm-unknown" ? "Enter 仍要保存 · Esc 取消" : "Enter 提交 · Esc 取消", theme.muted));
		}
		return lines.map((line) => truncateToDisplayWidth(line, width));
	}
};
//#endregion
//#region lib/types/ui/key-wizard.js
/**
* key-wizard — /key 供应商选择步骤的纯函数层：目录 → 带状态的 picker 条目、
* 供应商 → 凭据引用的解析次序。I/O（describe/settings/凭据）全部在装配方
* （app.ts 的 openKeyDialog 流程）里；本模块只做可单测的形状决定。
* 回流自 tianshu-public（上游 src/ui/key-wizard.ts）。
*
* @module dsh-tui/key-wizard
*/
/**
* 从供应商路由派生缺省凭据引用：大写、非 `[A-Z0-9]` 连串折叠为单个 `_`、
* 后缀 `_API_KEY`。与 web 模型页（packages/client/ui-models store.ts 的
* deriveKeyRef）同一规则的双侧实现——规则由两侧测试钉死，改动必须同步
* （TUI 不引入 client 包依赖，presentation 层各自持有最小面）。
* @param provider - 供应商路由 id。
* @returns POSIX 变量名形状的凭据引用。
*/
function deriveKeyRef(provider) {
	return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
/**
* 供应商 → 本次落盘引用的解析次序：profile 显式声明的 `apiKeyEnv` 优先
* （组合层下发的 openrouter profile 就带着 OPENROUTER_API_KEY），未声明再
* 派生。profile 由装配方从 settings.describe 读出传入——纯函数不做 I/O。
* @param provider - 供应商路由 id。
* @param profileApiKeyEnv - 已解析 profile 的 apiKeyEnv（无 profile 或未声明为 undefined）。
* @returns 凭据引用。
*/
function resolveKeyRef(provider, profileApiKeyEnv) {
	return profileApiKeyEnv !== void 0 && profileApiKeyEnv.length > 0 ? profileApiKeyEnv : deriveKeyRef(provider);
}
/**
* 构建 /key 供应商 picker 条目：默认供应商置首带 ●（current），已配置 key
* 的条目 label 后缀 ` ✓`（PickerItem 无描述行，状态内联进 label）；其余按
* 目录声明序。空目录返回空数组（装配方负责降级文案）。
* @param directory - 可配置供应商目录。
* @param configured - 各供应商引用的 describe 结果（configured 标志）。
* @param defaultProvider - 当前默认模型所在的供应商路由；undefined = 无默认不置首。
* @returns picker 条目（value = 供应商路由 id）。
*/
function buildProviderItems(directory, configured, defaultProvider) {
	const items = [];
	const defaultEntry = defaultProvider === void 0 ? void 0 : directory.find((entry) => entry.provider === defaultProvider);
	const emit = (entry, current) => {
		const suffix = configured.get(entry.provider) === true ? " ✓" : "";
		items.push({
			label: `${entry.displayName}${suffix}`,
			value: entry.provider,
			...current ? { current: true } : {}
		});
	};
	if (defaultEntry !== void 0) emit(defaultEntry, true);
	for (const entry of directory) {
		if (entry === defaultEntry) continue;
		emit(entry, false);
	}
	return items;
}
//#endregion
//#region lib/types/ui/key-flow.js
/**
* key-flow — /key 供应商密钥配置的装配层（提取自上游 tianshu-public
* TuiApp 的 openKeyDialog 系列，2026-08 回流）。上游这些方法是 TuiApp
* 实例私有方法；本仓按棘轮约束（ui/app.ts 只降不升）提取为独立模块，
* TuiApp 仅保留 deps 注入与 overlay 注册。
*
* 分层：key-wizard（纯函数目录/引用决策）→ key-dialog（状态机+渲染）→
* 本模块（装配：reflect 现取 llm/credentials/settings seam、供应商 picker
* 链式开窗、探测分派、保存后 profile 激活、首启引导）。
*
* @module dsh-tui/key-flow
*/
/**
* /key 供应商密钥配置装配控制器。方法语义与上游 TuiApp 同名方法一致：
* - openKeyDialog：llm 配置目录可用时先开供应商 picker（默认供应商 ● 置首、
*   已配置 ✓ 后缀），选中后链到参数化的 key 对话框；目录缺席降级 DeepSeek 直开。
* - openCredentialFromConfig：/config 凭据字段编辑入口（向导后段）。
* - maybeAutoOpenKeyDialog：首启引导（TTY 缺 key 自动弹一次，run 级守护）。
*/
var KeyFlow = class {
	/** 首启引导守护：本 run 已自动弹过一次 key 对话框（restore 等后续流程不再重复弹）。 */
	keyPromptShown = false;
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* /key：供应商密钥配置向导。llm 配置目录可用时先开供应商 picker（默认
	* 供应商 ● 置首、已配置 ✓ 后缀），选中后链到参数化的 key 对话框（掩码
	* 输入 + 探测 + 落盘）；目录缺席（无 llm seam/测试装配）降级为 DeepSeek
	* 直开。凭据服务经 reflect.get 现取（缺席时对话框给降级指引）。
	*/
	async openKeyDialog() {
		const { overlay, keyDialog, picker } = this.deps;
		if (this.deps.isDisposed()) return;
		if (overlay === null || keyDialog === null) return;
		if (overlay.activeId() === "key-dialog") return;
		const credentials = this.deps.reflect.get("credentials", false);
		const directory = this.keyWizardDirectory();
		if (picker === null || directory.length === 0) {
			await this.openKeyDialogForEntry(void 0, credentials);
			return;
		}
		const sections = this.readResolvedSettingsSections();
		const configured = /* @__PURE__ */ new Map();
		for (const entry of directory) {
			const ref = resolveKeyRef(entry.provider, this.profileApiKeyEnv(sections, entry));
			if (credentials === void 0) break;
			const isConfigured = await credentials.describe(ref).then((info) => info.configured, () => false);
			if (this.deps.isDisposed()) return;
			configured.set(entry.provider, isConfigured);
		}
		const defaultProvider = this.defaultModelProvider();
		picker.open("选择供应商（配置 API 密钥）", buildProviderItems(directory, configured, defaultProvider), (item) => {
			const entry = directory.find((candidate) => candidate.provider === item.value);
			if (entry === void 0) return;
			queueMicrotask(() => {
				this.openKeyDialogForEntry(entry, credentials);
			});
		}, 0);
		overlay.activate("picker");
	}
	/**
	* 打开参数化 key 对话框；entry 缺省即 DeepSeek 缺省目标（首启引导与降级）。
	* pi-ai 路由的 profile 未声明 apiKeyEnv 时挂 afterSave：保存后补写
	* `{providers: {<route>: {apiKeyEnv}}}`——路由即刻注册，/model 立即可选
	* （与 web 模型页的写入形状一致）；settings 缺席则只存 key 不激活。
	* @param entry - 目录条目；undefined = DeepSeek 缺省目标。
	* @param credentials - 凭据服务最小面；undefined = 服务缺席（对话框降级指引）。
	*/
	async openKeyDialogForEntry(entry, credentials) {
		const { overlay, keyDialog } = this.deps;
		if (this.deps.isDisposed()) return;
		if (overlay === null || keyDialog === null) return;
		if (overlay.activeId() === "key-dialog") return;
		const sections = this.readResolvedSettingsSections();
		const namedEnv = entry === void 0 ? void 0 : this.profileApiKeyEnv(sections, entry);
		const target = entry === void 0 ? DEEPSEEK_KEY_TARGET : {
			provider: entry.provider,
			displayName: entry.displayName,
			ref: resolveKeyRef(entry.provider, namedEnv),
			probe: this.keyProbeFor(entry),
			...namedEnv === void 0 && entry.settingsPath.length > 0 && this.settingsMutationFacet() !== void 0 ? { afterSave: () => this.activateRouteProfile(entry) } : {}
		};
		await keyDialog.open(credentials, target);
		if (this.deps.isDisposed()) return;
		overlay.activate("key-dialog");
	}
	/**
	* 凭据字段编辑：从 /config 进该供应商的 /key 对话框（向导后段）。
	* 目录中找不到该供应商（目录已变更）时走 onConfigEntryMissing 回调。
	* @param provider - 供应商路由 id。
	*/
	async openCredentialFromConfig(provider) {
		const entry = this.keyWizardDirectory().find((candidate) => candidate.provider === provider);
		const credentials = this.deps.reflect.get("credentials", false);
		if (entry === void 0) {
			this.deps.onConfigEntryMissing?.();
			return;
		}
		await this.openKeyDialogForEntry(entry, credentials);
	}
	/**
	* 首启引导：交互终端（TTY）缺 API key 时自动打开一次设置对话框（Esc 可跳过）。
	* 挂载点在欢迎渲染/会话就绪之后（attach 尾；apiKeyReady 已由
	* prepareWelcome 刷新）；keyPromptShown 做 run 级守护，
	* restore/重进等后续流程不再重复弹；非 TTY（测试/管道）不弹交互对话框。
	*/
	maybeAutoOpenKeyDialog() {
		if (this.deps.autoPrompt === false) return;
		if (this.deps.isDisposed() || this.keyPromptShown || this.deps.apiKeyReady()) return;
		if (!this.deps.stdinIsTTY()) return;
		this.keyPromptShown = true;
		this.openKeyDialog();
	}
	/** llm 配置目录（llm seam 缺席或面不含该法时为空数组——降级 DeepSeek 直开）。 */
	keyWizardDirectory() {
		const llm = this.deps.reflect.get("llm", false);
		if (llm === void 0 || typeof llm.listConfigurableProviders !== "function") return [];
		return llm.listConfigurableProviders().filter((entry) => entry.provider.length > 0).map((entry) => ({
			provider: entry.provider,
			displayName: entry.displayName,
			settingsNs: entry.settingsNs,
			settingsPath: entry.settingsPath
		}));
	}
	/** settings 服务最小面（describe/mutate；缺席时向导只存 key 不做 profile 激活）。 */
	settingsMutationFacet() {
		return this.deps.reflect.get("settings", false);
	}
	/** 读取 settings 各命名空间的已解析值（ns 对象原样保留供 mutate 回传）。 */
	readResolvedSettingsSections() {
		const sections = /* @__PURE__ */ new Map();
		const settings = this.settingsMutationFacet();
		if (settings === void 0) return sections;
		try {
			for (const descriptor of settings.describe()) sections.set(String(descriptor.ns), descriptor.value);
		} catch {}
		return sections;
	}
	/**
	* 目录条目在已解析 settings 段里的 `apiKeyEnv`（组合层下发的 openrouter
	* profile 就带着 OPENROUTER_API_KEY）；llm-deepseek 段经 schema 缺省解析
	* 为 DEEPSEEK_API_KEY。无 profile/未声明返回 undefined（落派生规则）。
	*/
	profileApiKeyEnv(sections, entry) {
		const section = sections.get(entry.settingsNs);
		if (section === null || typeof section !== "object") return void 0;
		let profile = section;
		for (const key of entry.settingsPath) {
			if (profile === null || typeof profile !== "object") return void 0;
			profile = profile[key];
		}
		const named = profile === null || typeof profile !== "object" ? void 0 : profile.apiKeyEnv;
		return typeof named === "string" && named.length > 0 ? named : void 0;
	}
	/**
	* 供应商探测实现：llm-deepseek 段用既有官方端点探测；其余走 llm 发现探针
	* （带草稿 key 即真鉴权：2xx → ok，AUTH/INVALID_CREDENTIAL → invalid，
	* 其余含网络错 → unknown）。llm seam 缺席按 unknown（无法证伪，可强存）。
	*/
	keyProbeFor(entry) {
		if (entry.settingsNs === "llm-deepseek") return probeDeepSeekKey;
		return async (key) => {
			const llm = this.deps.reflect.get("llm", false);
			if (llm === void 0 || typeof llm.discoverModels !== "function") return "unknown";
			try {
				await llm.discoverModels(entry.settingsNs, {
					provider: entry.provider,
					apiKey: key
				});
				return "ok";
			} catch (error) {
				const code = error.code;
				return code === "AUTH" || code === "INVALID_CREDENTIAL" ? "invalid" : "unknown";
			}
		};
	}
	/** 保存 key 后激活路由：写入最小 profile（settingsPath 非空 = pi-ai 路由）。 */
	async activateRouteProfile(entry) {
		const settings = this.settingsMutationFacet();
		if (settings === void 0) return;
		await settings.mutate(entry.settingsNs, [{
			op: "set",
			path: [...entry.settingsPath, "apiKeyEnv"],
			value: resolveKeyRef(entry.provider, void 0)
		}]);
	}
	/** 当前默认模型所在的供应商路由（agent-default-model 缺席时无默认）。 */
	defaultModelProvider() {
		try {
			return this.deps.agentDefaultModel?.currentSelection?.().provider;
		} catch {
			return;
		}
	}
};
//#endregion
//#region lib/types/question-panel.js
/**
* 结构化提问面板（user-questions 数据面移植，纯函数层）。
*
* projectQuestionPanel 把 AskUserQuestionRequest 形状的提问投影为面板行：
* 标题行 + 每个 question 一块。两种渲染形态：
* - 通用选项面板：header 分隔行（可选）+ ❓ 问题行（multiSelect 尾缀
*   「（多选）」）+ detail 缩进行（可选）+ 编号选项行（「n. label」，
*   option.description 二级缩进）；
* - plan-review 决策卡：🧭 问题行 + detail 缩进行（计划正文）+ 选项行按
*   intent.approve 分类——命中的 label 标 ✓ 且 BOLD 高亮（批准项），其余
*   标 ✗（否决项）；approve 不命中任何选项时全部按否决渲染（不吞异常、
*   不伪造批准）；multiSelect 在决策卡形态不追加多选标记（裁决为单选）。
* 数据面形状结构兼容 @deepseek-ai/dsh-user-questions 的
* AskUserQuestionRequest/AskUserQuestionItem（intent 唯一 kind
* 'plan-review' 带 approve: string），纯函数层不跨包依赖、无 I/O。
* 空 questions 返回仅标题行；每行按显示宽度截断（仅截断时补 …，
* 极端窄宽退化为 … 不抛错）。TuiApp 消费 user-questions 提供方的
* request 快照（接线由其他维度独占）。
*
* @module @deepseek-ai/dsh-tianshu-tui/question-panel
*/
const UNICODE_GLYPHS$1 = {
	title: "❓ 提问",
	question: "❓",
	plan: "🧭",
	approve: "✓",
	reject: "✗",
	recommend: "❯"
};
const ASCII_GLYPHS$1 = {
	title: "? 提问",
	question: "?",
	plan: ">",
	approve: "+",
	reject: "x",
	recommend: ">"
};
/** 当前终端应使用的字形档（❓/🧭 是彩色 emoji，GBK conhost 下豆腐）。 */
function questionGlyphs() {
	return useAsciiGlyphs() ? ASCII_GLYPHS$1 : UNICODE_GLYPHS$1;
}
/** 多选标记（尾缀在通用问题行）。 */
const MULTI_MARK = "（多选）";
/** 粗体（与 engine/ansi.ts 的 ANSI.BOLD 一致；纯函数层不跨模块依赖）。 */
const BOLD = "\x1B[1m";
/** SGR 重置转义序列。 */
const RESET = "\x1B[0m";
/**
* 投影提问请求为面板行（标题 + 每个 question 一块，按输入顺序）。
* @param request - 提问请求（只消费 questions 字段）。
* @param opts - 面板选项（行宽预算）。
* @returns 面板行数组（空 questions → 仅标题行）。
*/
function projectQuestionPanel(request, opts) {
	const rows = [questionGlyphs().title];
	for (const item of request.questions) rows.push(...projectQuestion(item, opts.width, opts.theme));
	return rows;
}
/** 渲染单个 question 块（header + 问题行 + detail + 选项行；形态由 intent 决定）。 */
function projectQuestion(item, width, theme) {
	const rows = [];
	const g = questionGlyphs();
	if (item.header !== void 0) rows.push(truncateByWidth(`── ${item.header} ──`, width));
	const intent = item.intent;
	if (intent?.kind === "plan-review") {
		rows.push(truncateByWidth(`${g.plan} ${item.question}`, width));
		if (item.detail !== void 0) rows.push(...projectDetail(item.detail, width));
		rows.push(...projectPlanOptions(item.options, intent.approve, width, theme));
		rows.push(...projectPlanSeparator(width, theme));
		rows.push(...projectPlanKeyHints(item, width));
		return rows;
	}
	const multiMark = item.multiSelect === true ? MULTI_MARK : "";
	rows.push(truncateByWidth(`${g.question} ${item.question}${multiMark}`, width));
	if (item.detail !== void 0) rows.push(...projectDetail(item.detail, width));
	rows.push(...projectOptionList(item.options, width));
	return rows;
}
/** detail 按行拆分，每行渲染为一级缩进行（plan-review 卡中为计划正文）。 */
function projectDetail(detail, width) {
	return detail.split(/\r?\n/).map((line) => truncateByWidth(`  ${line}`, width));
}
/** plan-review 卡选项行：approve 命中 ✓ + BOLD 高亮；theme 提供时升 ❯ 前缀 + success 着色。 */
function projectPlanOptions(options, approve, width, theme) {
	if (options === void 0) return [];
	const rows = [];
	options.forEach((opt, i) => {
		const isApprove = opt.label === approve;
		const g = questionGlyphs();
		const mark = isApprove ? g.approve : g.reject;
		const cut = truncateByWidth(`  ${isApprove && theme !== void 0 ? `${g.recommend} ` : ""}${mark} ${i + 1}. ${opt.label}`, width);
		if (isApprove && theme !== void 0) rows.push(`${BOLD}${color(cut, theme.success)}${RESET}`);
		else rows.push(isApprove ? `${BOLD}${cut}${RESET}` : cut);
	});
	return rows;
}
/** 决策区分隔线（正文/选项与键位提示的分界；theme 提供时启用——回流 b15e90428）。 */
function projectPlanSeparator(width, theme) {
	if (theme === void 0) return [];
	return [color(`  ${"─".repeat(Math.max(4, width - 4))}`, theme.dim)];
}
/** plan-review 卡 key hints：数字键选选项（编号 1-based），f 反馈，Esc/Ctrl+C 取消。 */
function projectPlanKeyHints(item, width) {
	const approve = item.intent?.approve;
	const approveIdx = item.options?.findIndex((o) => o.label === approve);
	const keepIdx = item.options?.findIndex((o, i) => i !== approveIdx && o.label !== approve);
	const hints = [];
	if (approveIdx !== void 0 && approveIdx >= 0) hints.push(`[${approveIdx + 1}] ${item.options?.[approveIdx]?.label ?? ""}`);
	if (keepIdx !== void 0 && keepIdx >= 0) hints.push(`[${keepIdx + 1}] ${item.options?.[keepIdx]?.label ?? ""}`);
	hints.push("[f] 反馈修改", "[Esc]/[Ctrl+C] 取消");
	return [truncateByWidth(`  ${hints.join("  ")}`, width)];
}
/** 通用选项行：编号 + label，description 二级缩进。 */
function projectOptionList(options, width) {
	if (options === void 0) return [];
	const rows = [];
	options.forEach((opt, i) => {
		rows.push(truncateByWidth(`  ${i + 1}. ${opt.label}`, width));
		if (opt.description !== void 0) rows.push(truncateByWidth(`    ${opt.description}`, width));
	});
	return rows;
}
/** 按显示宽度截断字符串（仅发生截断时尾部补 …；极端窄宽退化为 …）。 */
function truncateByWidth(text, max) {
	if (max <= 1) return "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = displayWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return w < displayWidth(text) ? `${out}…` : out;
}
//#endregion
//#region lib/types/lsp/rpc.js
function encodeMessage(msg) {
	const body = JSON.stringify(msg);
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
const CRLFCRLF = Buffer.from("\r\n\r\n");
function decodeMessages(input) {
	const messages = [];
	const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
	let offset = 0;
	while (true) {
		const headerEnd = buf.indexOf(CRLFCRLF, offset);
		if (headerEnd === -1) break;
		const header = buf.subarray(offset, headerEnd).toString("utf8");
		const lengthMatch = /^Content-Length: (\d+)/m.exec(header);
		if (!lengthMatch) {
			offset = headerEnd + 4;
			continue;
		}
		const contentLength = parseInt(lengthMatch[1], 10);
		const bodyStart = headerEnd + 4;
		if (buf.length - bodyStart < contentLength) break;
		const body = buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
		try {
			messages.push(JSON.parse(body));
		} catch {}
		offset = bodyStart + contentLength;
	}
	return {
		messages,
		rest: buf.subarray(offset).toString("utf8")
	};
}
function createRpcClient(readable, writable) {
	let nextId = 1;
	const pending = /* @__PURE__ */ new Map();
	const notificationHandlers = /* @__PURE__ */ new Map();
	let buffer = Buffer.alloc(0);
	readable.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		const { messages, rest } = decodeMessages(buffer);
		buffer = Buffer.from(rest, "utf8");
		for (const msg of messages) if ("id" in msg && "result" in msg && !("method" in msg)) {
			const p = pending.get(msg.id);
			if (p) {
				pending.delete(msg.id);
				p.resolve(msg.result);
			}
		} else if ("id" in msg && "error" in msg && !("method" in msg)) {
			const p = pending.get(msg.id);
			if (p) {
				pending.delete(msg.id);
				p.reject(new Error(msg.error.message));
			}
		} else if ("method" in msg && !("id" in msg)) {
			const handlers = notificationHandlers.get(msg.method);
			if (handlers) for (const h of handlers) h(msg.params ?? {});
		}
	});
	return {
		request(method, params) {
			return new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, {
					resolve,
					reject
				});
				const msg = {
					jsonrpc: "2.0",
					id,
					method,
					params
				};
				writable.write(encodeMessage(msg));
			});
		},
		notify(method, params) {
			const msg = {
				jsonrpc: "2.0",
				method,
				params
			};
			writable.write(encodeMessage(msg));
		},
		onNotification(method, handler) {
			const existing = notificationHandlers.get(method);
			if (existing) existing.push(handler);
			else notificationHandlers.set(method, [handler]);
		},
		dispose() {
			pending.clear();
			notificationHandlers.clear();
			readable.removeAllListeners("data");
		}
	};
}
//#endregion
//#region lib/types/lsp/manager.js
/** Absolute filesystem path for a possibly-relative file, rooted at cwd.
*  Cross-platform: handles Windows drive-letter absolute paths correctly. */
function absFromCwd$1(filePath, cwd) {
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}
/** Build an LSP file:// URI for a path. Uses pathToFileURL so Windows yields the
*  required `file:///C:/...` form (not the invalid `file://C:\...`). */
function fileToUri(filePath, cwd) {
	return pathToFileURL(absFromCwd$1(filePath, cwd)).href;
}
/** Convert an LSP file:// URI back to a cwd-relative, forward-slash path. */
function uriToRelPath(uri, cwd) {
	let abs;
	try {
		abs = fileURLToPath(uri);
	} catch {
		abs = uri.replace(/^file:\/\/\/?/, "");
	}
	const rel = relative(cwd, abs);
	return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs).split("\\").join("/");
}
function languageId(filePath) {
	if (filePath.endsWith(".tsx")) return "typescriptreact";
	if (filePath.endsWith(".ts")) return "typescript";
	if (filePath.endsWith(".jsx")) return "javascriptreact";
	return "javascript";
}
function createLspManager(spawnFn, cwd) {
	let rpc = null;
	let proc = null;
	let capabilities = null;
	let ready = false;
	const openedDocs = /* @__PURE__ */ new Set();
	/** T4: diagnostic cache keyed by URI, populated from publishDiagnostics notifications. */
	const diagnosticCache = /* @__PURE__ */ new Map();
	/**
	* Ensure the document is opened in the LSP server.
	* Uses a dummy text because TypeScript language server reads from disk
	* and does not rely on the text content from didOpen.
	* Caches opened URIs — only sends didOpen + waits on first access.
	*/
	async function ensureDocument(filePath) {
		if (!rpc) return;
		const uri = fileToUri(filePath, cwd);
		if (openedDocs.has(uri)) return;
		openedDocs.add(uri);
		try {
			rpc.notify("textDocument/didOpen", { textDocument: {
				uri,
				languageId: languageId(filePath),
				version: 1,
				text: ""
			} });
			await new Promise((r) => setTimeout(r, 100));
		} catch {}
	}
	return {
		async initialize() {
			try {
				const child = spawnFn();
				proc = child;
				const stdin = proc.stdin;
				const stdout = proc.stdout;
				if (proc.stderr) proc.stderr.on("data", () => {});
				const procDied = new Promise((_, reject) => {
					child.on("error", (err) => {
						ready = false;
						reject(err);
					});
					child.on("close", () => {
						ready = false;
						reject(/* @__PURE__ */ new Error("lsp server exited before initialize"));
					});
				});
				rpc = createRpcClient(stdout, stdin);
				capabilities = (await Promise.race([rpc.request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(cwd).href,
					capabilities: { textDocument: {
						definition: { linkSupport: false },
						references: {}
					} }
				}), procDied])).capabilities;
				rpc.notify("initialized", {});
				rpc.onNotification("textDocument/publishDiagnostics", (rawParams) => {
					const params = rawParams;
					if (params?.uri) diagnosticCache.set(params.uri, params.diagnostics ?? []);
				});
				await new Promise((r) => setTimeout(r, 200));
				ready = true;
			} catch {
				ready = false;
				try {
					proc?.kill();
				} catch {}
				proc = null;
				rpc = null;
			}
		},
		isReady() {
			return ready;
		},
		supportsDefinition() {
			return capabilities?.definitionProvider === true;
		},
		supportsReferences() {
			return capabilities?.referencesProvider === true;
		},
		async gotoDefinition(filePath, line, character) {
			if (!rpc || !ready) return [];
			try {
				await ensureDocument(filePath);
				const result = await rpc.request("textDocument/definition", {
					textDocument: { uri: fileToUri(filePath, cwd) },
					position: {
						line: line - 1,
						character
					}
				});
				if (!result) return [];
				return (Array.isArray(result) ? result : [result]).map((loc) => ({
					...loc,
					uri: uriToRelPath(loc.uri, cwd)
				}));
			} catch {
				return [];
			}
		},
		async findReferences(filePath, line, character) {
			if (!rpc || !ready) return [];
			try {
				await ensureDocument(filePath);
				const result = await rpc.request("textDocument/references", {
					textDocument: { uri: fileToUri(filePath, cwd) },
					position: {
						line: line - 1,
						character
					},
					context: { includeDeclaration: false }
				});
				if (!result) return [];
				return (Array.isArray(result) ? result : []).map((loc) => ({
					...loc,
					uri: uriToRelPath(loc.uri, cwd)
				}));
			} catch {
				return [];
			}
		},
		changeFile(filePath) {
			if (!rpc || !ready) return;
			const uri = fileToUri(filePath, cwd);
			if (!openedDocs.has(uri)) return;
			try {
				rpc.notify("textDocument/didChange", {
					textDocument: {
						uri,
						version: Date.now()
					},
					contentChanges: [{ text: "" }]
				});
			} catch {}
		},
		async getFileDiagnostics(filePath, timeoutMs = 2e3) {
			if (!rpc || !ready) return [];
			const absPath = absFromCwd$1(filePath, cwd);
			const uri = fileToUri(filePath, cwd);
			try {
				if (capabilities?.diagnosticProvider) {
					const result = await Promise.race([rpc.request("textDocument/diagnostic", { textDocument: { uri } }), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
					if (result?.items) return result.items;
				}
				await ensureDocument(filePath);
				let fileText = "";
				try {
					const { readFileSync } = await import("node:fs");
					fileText = readFileSync(absPath, "utf-8");
				} catch {}
				diagnosticCache.delete(uri);
				rpc.notify("textDocument/didChange", {
					textDocument: {
						uri,
						version: Date.now()
					},
					contentChanges: [{ text: fileText }]
				});
				await new Promise((resolve) => {
					const start = Date.now();
					const check = () => {
						if (diagnosticCache.has(uri) || Date.now() - start > timeoutMs) resolve();
						else setTimeout(check, 50);
					};
					check();
				});
				return diagnosticCache.get(uri) ?? [];
			} catch {
				return [];
			}
		},
		dispose() {
			ready = false;
			try {
				rpc?.dispose();
			} catch {}
			try {
				proc?.kill();
			} catch {}
			proc = null;
			rpc = null;
		}
	};
}
//#endregion
//#region lib/types/lsp/server-registry.js
/**
* LSP server registry — maps file extensions to language servers and detects
* which are installed, so the agent gets go-to-definition / diagnostics for
* many languages instead of TypeScript only.
*
* Pure + injectable (`which` is passed in) so selection logic is unit-testable
* without the servers actually being installed.
*/
/**
* Known servers, ordered by extension specificity. TypeScript is launched via
* `npx -y` (matching the prior behavior) so it is always considered available.
*/
const LSP_SERVERS = [
	{
		id: "typescript",
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		command: "npx",
		args: [
			"-y",
			"typescript-language-server",
			"--stdio"
		],
		languageId: "typescript",
		alwaysAvailable: true
	},
	{
		id: "pyright",
		extensions: [".py", ".pyi"],
		command: "pyright-langserver",
		args: ["--stdio"],
		languageId: "python"
	},
	{
		id: "gopls",
		extensions: [".go"],
		command: "gopls",
		args: [],
		languageId: "go"
	},
	{
		id: "rust-analyzer",
		extensions: [".rs"],
		command: "rust-analyzer",
		args: [],
		languageId: "rust"
	},
	{
		id: "clangd",
		extensions: [
			".c",
			".h",
			".cpp",
			".cc",
			".cxx",
			".hpp",
			".hh"
		],
		command: "clangd",
		args: [],
		languageId: "cpp"
	},
	{
		id: "jdtls",
		extensions: [".java"],
		command: "jdtls",
		args: [],
		languageId: "java"
	}
];
function defaultWhich(bin) {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
			stdio: [
				"ignore",
				"ignore",
				"ignore"
			],
			timeout: 800,
			windowsHide: true
		});
		return true;
	} catch {
		return false;
	}
}
function extOf(filePath) {
	const i = filePath.lastIndexOf(".");
	return i >= 0 ? filePath.slice(i).toLowerCase() : "";
}
/** The server def that handles a given extension, or null. */
function serverDefForExt(ext) {
	const e = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
	return LSP_SERVERS.find((s) => s.extensions.includes(e)) ?? null;
}
function isServerAvailable(def, which = defaultWhich) {
	if (def.alwaysAvailable) return true;
	return which(def.binary ?? def.command);
}
/** The available server for a file, or null when unsupported / not installed. */
function serverForFile(filePath, which = defaultWhich) {
	const def = serverDefForExt(extOf(filePath));
	if (!def) return null;
	return isServerAvailable(def, which) ? def : null;
}
/** All servers installed on this machine (for diagnostics / readiness checks). */
function availableServers(which = defaultWhich) {
	return LSP_SERVERS.filter((s) => isServerAvailable(s, which));
}
//#endregion
//#region lib/types/lsp/multi-manager.js
/**
* Multi-language LSP manager（移植自天枢 Tianshu src/lsp/multi-manager.ts，
* Apache-2.0；spawn 路径简化：dsh-tui 是纯 Node 进程，弃上游 spawnHidden /
* resolve-node-cli 桌面 bundle 适配，用 node:child_process spawn 直连）。
*
* Wraps the single-server `createLspManager` and routes each request to the
* language server matching the file's extension, lazily spawning + initializing
* each server on first use. This gives polyglot go-to-definition / diagnostics
* (pyright / gopls / rust-analyzer / clangd / jdtls / typescript-language-server)
* behind the existing single `LspManager` interface.
*/
/**
* Default spawn for LSP servers: plain child_process.spawn (non-win32).
* Windows 上 npx 与 npm 全局装的 langserver 都是 .cmd，不经 shell 直接
* spawn 抛 EINVAL（CVE-2024-27980 后行为）——win32 经 ComSpec（cmd.exe）
* /d /c 以 argv 数组显式派发，同 self-update 的包管理器派发；shell 保持
* false，避开 DEP0190 弃用警告渲染进 TUI。command/args 均来自仓内
* server-registry 固定表，无用户输入，无注入面。
*/
function defaultLspSpawn(def, cwd, spawnFn = spawn) {
	const isWin = process.platform === "win32";
	return spawnFn(isWin ? process.env.ComSpec ?? "cmd.exe" : def.command, isWin ? [
		"/d",
		"/c",
		def.command,
		...def.args
	] : def.args, {
		cwd,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	});
}
function createMultiLspManager(cwd, opts = {}) {
	const which = opts.which ?? defaultWhich;
	const spawnFor = opts.spawnFor ?? ((def, c) => defaultLspSpawn(def, c));
	const managers = /* @__PURE__ */ new Map();
	let availableCache = null;
	const getAvailable = () => {
		if (availableCache === null) availableCache = availableServers(which);
		return availableCache;
	};
	const ensure = async (def) => {
		let entry = managers.get(def.id);
		if (!entry) {
			const mgr = createLspManager(() => spawnFor(def, cwd), cwd);
			entry = {
				mgr,
				ready: mgr.initialize().catch(() => {})
			};
			managers.set(def.id, entry);
		}
		await entry.ready;
		return entry.mgr.isReady() ? entry.mgr : null;
	};
	const resolve = (filePath) => serverForFile(filePath, which);
	return {
		async initialize() {},
		isReady() {
			return getAvailable().length > 0;
		},
		supportsDefinition() {
			return getAvailable().length > 0;
		},
		supportsReferences() {
			return getAvailable().length > 0;
		},
		async gotoDefinition(filePath, line, character) {
			const def = resolve(filePath);
			if (!def) return [];
			const mgr = await ensure(def);
			return mgr ? mgr.gotoDefinition(filePath, line, character) : [];
		},
		async findReferences(filePath, line, character) {
			const def = resolve(filePath);
			if (!def) return [];
			const mgr = await ensure(def);
			return mgr ? mgr.findReferences(filePath, line, character) : [];
		},
		changeFile(filePath) {
			const def = resolve(filePath);
			if (!def) return;
			ensure(def).then((mgr) => mgr?.changeFile(filePath)).catch(() => {});
		},
		async getFileDiagnostics(filePath, timeoutMs) {
			const def = resolve(filePath);
			if (!def) return [];
			const mgr = await ensure(def);
			return mgr ? mgr.getFileDiagnostics(filePath, timeoutMs) : [];
		},
		dispose() {
			for (const { mgr } of managers.values()) try {
				mgr.dispose();
			} catch {}
			managers.clear();
		}
	};
}
//#endregion
//#region lib/types/lsp/lsp-bridge.js
/**
* LspBridge — TUI 侧本地语言服务桥（展示层缓存 + 懒生命周期）。
*
* 职责：把「agent 触碰文件」翻译成一次异步诊断拉取，并把结果缓存为
* 渲染层可同步读取的视图。与既有平台桥同构（clipboard-image / external-editor
* 的本地进程交互先例）：不进会话事件、不发明事件类型、不注册任何 prompt/
* 工具/上下文面——诊断是 TUI 私有展示状态，随 TuiApp dispose 全部销毁。
*
* 触发策略：
* - 懒启动：首个匹配扩展名的文件才 spawn 对应语言 server（multi-manager 路由）；
* - per-file in-flight 合并 + 5s 新鲜度冷却（高频工具步进不刷屏）；
* - 扩展名无 server / server 未安装 → 一次标记 unsupported（渲染层回显 ⚠）；
* - 拉取超时（timeoutMs，缺省 2000ms）静默返回空，下次 touch 重拉。
*
* @module @deepseek-ai/dsh-tianshu-tui/lsp/lsp-bridge
*/
/**
* 把官方 `ctx.lsp` 服务适配为 {@link LspDiagnosticSource}（TUI 桥消费面）。
* 诊断走官方 seam 的 `getDiagnostics` 操作（与模型工具面 lsp 工具共享同一
* provider/server 集）；超时用 AbortSignal.timeout 交官方 query 取消；错误
* （无 provider / 不支持 / 超时）一律静默返回空。所有权归官方服务——适配器
* 的 dispose 是 no-op（TUI 不销毁宿主服务）。
* @param service - 官方 ctx.lsp 服务（结构类型）。
* @param workspaceRoot - 官方 seam 的 workspaceRoot（会话 cwd）。
* @returns TUI 桥可直接消费的诊断源。
*/
function officialLspSource(service, workspaceRoot) {
	return {
		getDiagnostics(path, timeoutMs) {
			return service.query({
				operation: "getDiagnostics",
				filePath: path,
				workspaceRoot
			}, AbortSignal.timeout(timeoutMs)).then((result) => result.kind === "diagnostics" ? result.diagnostics ?? [] : []).catch(() => []);
		},
		isAvailable: () => true,
		dispose: () => {}
	};
}
/**
* 诊断源选择（纯函数，任务6对齐，2026-08-27）：按装配形态择源——
* 1. 社区/伴生形状（直接暴露 getDiagnostics 函数）→ 直接采纳；
* 2. 官方 seam 形状（只有 query）→ **能力门控**：仅当服务声明
*    `operations` 清单且包含 `getDiagnostics` 时才采纳为诊断源。seam 0.6.x
*    只暴露导航四操作、无 getDiagnostics 也无 JSON-RPC 逃生口——盲目采纳会让
*    seam 源顶掉内置 multi-manager，而其 query 恒报结构化不可用 → `/lsp`
*    面板永久空（真回归）。未声明即回落内置桥；将来官方 seam 增补诊断操作并
*    在 `operations` 里声明时自动恢复采纳。
* @param lspService - reflect.get('lsp') 读到的服务（可为 undefined）。
* @param workspaceRoot - 官方 seam 的 workspaceRoot（会话 cwd）。
*/
function selectDiagnosticSource(lspService, workspaceRoot) {
	const svc = lspService;
	if (svc === void 0) return { kind: "builtin" };
	if (typeof svc.getDiagnostics === "function") return {
		kind: "service",
		source: svc
	};
	if (typeof svc.query === "function") {
		const ops = svc.operations;
		if (Array.isArray(ops) && ops.includes("getDiagnostics")) return {
			kind: "service",
			source: officialLspSource(svc, workspaceRoot)
		};
	}
	return { kind: "builtin" };
}
/** 同文件重拉冷却（毫秒）：高频工具步进不刷屏。 */
const FRESH_MS = 5e3;
/** 绝对化路径（相对路径以 cwd 为基准）。 */
function absFromCwd(path, cwd) {
	return isAbsolute(path) ? path : resolve(cwd, path);
}
/** cwd 相对展示路径（Windows 反斜杠归一；相对解析失败回退绝对路径）。 */
function relDisplay(path, cwd) {
	const rel = relative(cwd, path);
	return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path).split("\\").join("/");
}
/** LSP 诊断 → 展示视图（行列 0-based → 1-based）。 */
function toView(diag, file) {
	return {
		file,
		line: diag.range.start.line + 1,
		character: diag.range.start.character + 1,
		severity: diag.severity,
		message: diag.message
	};
}
function createLspBridge(options) {
	const cwd = options.cwd;
	const timeoutMs = options.timeoutMs ?? 2e3;
	const which = options.which ?? defaultWhich;
	const source = options.source;
	const manager = source === void 0 ? createMultiLspManager(cwd, {
		...options.which === void 0 ? {} : { which: options.which },
		...options.spawnFor === void 0 ? {} : { spawnFor: options.spawnFor }
	}) : null;
	/** 拉取实现：外部源 → 服务；否则内置 manager。 */
	const fetchDiagnostics = (abs, ms) => {
		return source !== null && source !== void 0 ? Promise.resolve(source.getDiagnostics(abs, ms)) : manager !== null ? manager.getFileDiagnostics(abs, ms) : Promise.resolve([]);
	};
	/** 展示视图缓存：absPath → { diags, at }（含空数组：已拉取无诊断）。 */
	const cache = /* @__PURE__ */ new Map();
	/** in-flight 合并集。 */
	const inflight = /* @__PURE__ */ new Set();
	/** 确定无诊断来源的路径（扩展名不支持 / server 未安装）。 */
	const unsupportedPaths = /* @__PURE__ */ new Set();
	/** dispose 后所有操作失效（不再 spawn / 拉取）。 */
	let disposed = false;
	let update = null;
	const pull = (abs, display) => {
		(async () => {
			try {
				const diags = await fetchDiagnostics(abs, timeoutMs);
				cache.set(abs, {
					diags: diags.map((d) => toView(d, display)),
					at: Date.now()
				});
			} catch {} finally {
				inflight.delete(abs);
				update?.();
			}
		})();
	};
	return {
		touchFile(path) {
			if (disposed) return;
			const abs = absFromCwd(path, cwd);
			if (inflight.has(abs)) return;
			const cached = cache.get(abs);
			if (cached !== void 0 && Date.now() - cached.at < FRESH_MS) return;
			if (unsupportedPaths.has(abs)) return;
			if (serverForFile(abs, which) === null) {
				unsupportedPaths.add(abs);
				update?.();
				return;
			}
			inflight.add(abs);
			pull(abs, relDisplay(abs, cwd));
		},
		diagnosticsFor(path) {
			return cache.get(absFromCwd(path, cwd))?.diags;
		},
		entries() {
			const out = [];
			for (const { diags } of cache.values()) out.push(...diags);
			return out;
		},
		unsupported(path) {
			return unsupportedPaths.has(absFromCwd(path, cwd));
		},
		isAvailable() {
			return source !== void 0 ? source.isAvailable() : manager !== null && manager.isReady();
		},
		onUpdate(cb) {
			update = cb;
		},
		dispose() {
			disposed = true;
			if (manager !== null) manager.dispose();
			cache.clear();
			unsupportedPaths.clear();
			inflight.clear();
			update = null;
		}
	};
}
//#endregion
//#region lib/types/statusline.js
/**
* 可脚本化 statusline — 对齐 Claude Code statusLine 协议的字段子集。
*
* config `ui.statusLine.command` 指定用户脚本；每次刷新把会话状态 JSON 写入
* 脚本 stdin，取 stdout 首行渲染在输入框上方的独立行。
*
* 协议 payload（CC 字段子集 + rivet 扩展）：
* ```json
* {
*   "session_id": "…",
*   "model": { "display_name": "deepseek-v4" },
*   "workspace": { "current_dir": "/path/to/project" },
*   "git": { "branch": "main" },
*   "context": { "ratio": 0.42, "estimated_tokens": 54000, "max_tokens": 128000 },
*   "cost": { "total_yuan": 0.1234 },
*   "turn": 7
* }
* ```
*
* 安全/稳态约束：
* - 节流（默认 3s）+ 单飞（前一次未返回则跳过本次）
* - 超时 kill（默认 2s），脚本失败/超时保留上一次输出（不闪断）
* - 输出截断到 300 字符、去掉换行——渲染层再按终端宽度 clamp
*/
/**
* 用户脚本 statusline 执行器：节流 + 单飞 + 超时 kill；输出经 `onUpdate`
* 推送（截断 300 字符、取 stdout 首行）。失败/超时静默保留上一次输出。
*/
var StatusLineRunner = class {
	onUpdate;
	command;
	intervalMs;
	timeoutMs;
	lastRunMs = 0;
	inFlight = false;
	lastOutput = null;
	constructor(config, onUpdate) {
		this.onUpdate = onUpdate;
		this.command = config.command;
		this.intervalMs = config.intervalMs ?? 3e3;
		this.timeoutMs = config.timeoutMs ?? 2e3;
	}
	/** 当前缓存的 statusline 文本（脚本 stdout 首行）。 */
	get current() {
		return this.lastOutput;
	}
	/**
	* 请求刷新。节流 + 单飞；实际执行时把 payload JSON 写入脚本 stdin。
	* 失败/超时静默保留上一次输出。
	* @param payload - 写入脚本 stdin 的会话状态。
	*/
	refresh(payload) {
		const now = Date.now();
		if (this.inFlight || now - this.lastRunMs < this.intervalMs) return;
		this.lastRunMs = now;
		this.inFlight = true;
		let child;
		try {
			child = spawn(this.command, {
				shell: true,
				stdio: [
					"pipe",
					"pipe",
					"ignore"
				],
				windowsHide: true
			});
		} catch {
			this.inFlight = false;
			return;
		}
		let stdout = "";
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.inFlight = false;
			const firstLine = stdout.split("\n")[0]?.trim() ?? "";
			if (firstLine) {
				this.lastOutput = firstLine.slice(0, 300);
				this.onUpdate(this.lastOutput);
			}
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			settle();
		}, this.timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => {
			settle();
		});
		child.on("close", () => {
			settle();
		});
		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {}
	}
};
/**
* 空工作流视图：尚未收到任何 turn 事件，处于理解阶段。
* @param sessionId - 归属会话 id。
* @returns 初始视图（turn = -1，无活动）。
*/
function emptyWorkflowView(sessionId) {
	return {
		sessionId,
		phase: "understand",
		turn: -1,
		activity: void 0
	};
}
/**
* 工具名 → 工作流阶段。未知名工具返回 undefined（不改变当前阶段）。
* 分类依据：读/搜 → 调研；写/改/执行 → 实施；测试 → 验证。
* @param toolName - 工具名。
* @returns 推断阶段；未知工具返回 undefined。
*/
function inferPhaseFromTool(toolName) {
	switch (toolName) {
		case "read_file":
		case "grep":
		case "glob":
		case "diff":
		case "semantic_search":
		case "web_fetch":
		case "repo_map":
		case "inspect_project": return "research";
		case "edit_file":
		case "write_file":
		case "apply_patch":
		case "bash": return "implement";
		case "run_tests": return "verify";
		default: return;
	}
}
/**
* Fold 一个 session 事件进入工作流视图（纯函数，返回新视图）。
* turn/start 重置为理解；todo/write → 拆解；turn/end(completed) → 收尾；
* tool/call 投影阶段与活动。其余事件（chunk/assistant 等）不改变视图。
* @param view - 当前视图。
* @param event - 会话事件。
* @returns 新视图。
*/
function applyWorkflowEvent(view, event) {
	switch (event.type) {
		case "turn/start": return {
			...view,
			phase: "understand",
			turn: event.data.turn,
			activity: void 0
		};
		case "tool/call": {
			const phase = inferPhaseFromTool(event.data.name);
			return {
				...view,
				phase: phase ?? view.phase,
				activity: {
					name: event.data.name,
					arguments: event.data.arguments,
					turn: event.data.turn,
					step: event.data.step
				}
			};
		}
		case "todo/write": return {
			...view,
			phase: "decompose"
		};
		case "turn/end": return event.data.reason.kind === "completed" ? {
			...view,
			phase: "wrapup",
			activity: void 0
		} : view;
		default: return view;
	}
}
const PHASE_LABELS = {
	understand: "理解",
	research: "调研",
	decompose: "拆解",
	implement: "实施",
	verify: "验证",
	wrapup: "收尾"
};
/** 授权/模式徽标后缀：[plan…] / [plan] / [auto] / [preset] / [yolo] / [ask]。
*  注意：approvalPolicy 'never'（宿主 user-approval 写入）的语义是「自动拒绝
*  所有需审批的操作」（宿主 decide() 返回 rejected），并非放行——[yolo] 是
*  宿主 policy 词汇的展示，不代表「全放行」；TUI 全放行是 always-approve
*  （[auto] 徽标，allowed-once 短路）。 */
function formatStatusSuffix(planActive = false, planPending = false, alwaysApprove = false, approvalPolicy = null, permissionPreset = null) {
	const badge = planPending ? " [plan…]" : planActive ? " [plan]" : "";
	const auto = alwaysApprove ? " [auto]" : "";
	const preset = permissionPreset !== null ? ` [${permissionPreset}]` : "";
	return `${badge}${auto}${preset}${preset === "" && approvalPolicy !== null ? approvalPolicy === "never" ? " [yolo]" : " [ask]" : ""}`;
}
/**
* 渲染 statusline：`阶段 · 工具名`，无活动时仅阶段；后缀为授权/模式徽标。
* @param view - 工作流视图。
* @param planActive - plan 模式已生效（渲染 [plan]）。
* @param planPending - plan 切换待请求边界落地（渲染 [plan…]，优先于 planActive）。
* @param alwaysApprove - always-approve 生效（渲染 [auto]）。
* @param approvalPolicy - approval/policy 折叠值；null = 未记录不显示徽标。
* @param permissionPreset - permission/preset 折叠值；非 null 时压过 approvalPolicy 徽标。
* @returns statusline 文本。
*/
function formatStatusLine(view, planActive = false, planPending = false, alwaysApprove = false, approvalPolicy = null, permissionPreset = null) {
	const phase = PHASE_LABELS[view.phase];
	const suffix = formatStatusSuffix(planActive, planPending, alwaysApprove, approvalPolicy, permissionPreset);
	return view.activity === void 0 ? `${phase}${suffix}` : `${phase}${suffix} · ${view.activity.name}`;
}
/**
* 自包含 statusline：订阅 `agent/status` + 本 session 的 `session/event`，
* 折叠出工作流阶段与实时工具活动，每次变更经 `onUpdate` 推送渲染文本。
* 不依赖 ui/app.ts 喂数据——事件即事实源，纯投影。
*/
var WorkflowStatusLine = class {
	view;
	planState = {
		active: false,
		pending: false
	};
	alwaysApprove = false;
	/** 会话内最后一条 approval/policy 折叠值（null = 未记录，默认 ask 语义不显示徽标）。 */
	approvalPolicy = null;
	/** 会话内最后一条 permission/preset 折叠值（permission 服务装配时；null = 未记录）。 */
	permissionPreset = null;
	/** agent 是否不在 running。收尾相位在 idle 时不占状态行（否则 ◆ 收尾一直挂着像卡住）。 */
	agentIdle = true;
	lastText = null;
	onUpdate;
	disposers;
	constructor(ctx, sessionId, onUpdate) {
		this.view = emptyWorkflowView(sessionId);
		this.onUpdate = onUpdate;
		const onStatus = (_payload) => {
			if (_payload.agent.id !== sessionId) return;
			this.agentIdle = _payload.status !== "running";
			this.emit();
		};
		const onSessionEvent = (owner, event) => {
			if (owner.id !== sessionId) return;
			this.view = applyWorkflowEvent(this.view, event);
			if (event.type === "approval/policy") this.approvalPolicy = event.data.policy;
			else if (event.type === "permission/preset") this.permissionPreset = event.data.preset;
			this.emit();
		};
		this.disposers = [ctx.on("agent/status", onStatus), ctx.on("session/event", onSessionEvent)];
	}
	/**
	* T1.4 + A1：设置 plan 徽标态（plan 投影的 active/pending）。数据由装配方
	* （ui/app.ts 的投影总线）提供，本类不订阅 plan 投影。
	* pending=true 表示有切换意图待请求边界落地（轮内 /plan），渲染 [plan…]。
	* 相同状态幂等不推送。
	* @param state - plan 投影的 active/pending 态。
	*/
	setPlanState(state) {
		if (this.planState.active === state.active && this.planState.pending === state.pending) return;
		this.planState = {
			active: state.active,
			pending: state.pending
		};
		this.emit();
	}
	/**
	* C3 项 4：always-approve 徽标态（Shift+Tab 循环第三态）。数据由装配方
	* （ui/app.ts 的 cycleMode）提供，本类不持有策略。相同状态幂等不推送。
	* @param active - always-approve 是否生效。
	*/
	setAlwaysApprove(active) {
		if (this.alwaysApprove === active) return;
		this.alwaysApprove = active;
		this.emit();
	}
	/** 当前缓存的 statusline 文本；无事件时 null。 */
	get current() {
		return this.lastText;
	}
	emit() {
		if (this.agentIdle && this.view.phase === "wrapup") {
			const suffix = formatStatusSuffix(this.planState.active, this.planState.pending, this.alwaysApprove, this.approvalPolicy, this.permissionPreset);
			if (suffix === "") {
				if (this.lastText !== null) {
					this.lastText = null;
					this.onUpdate(null);
				}
				return;
			}
			const text = suffix.trim();
			if (this.lastText !== text) {
				this.lastText = text;
				this.onUpdate(text);
			}
			return;
		}
		const text = formatStatusLine(this.view, this.planState.active, this.planState.pending, this.alwaysApprove, this.approvalPolicy, this.permissionPreset);
		this.lastText = text;
		this.onUpdate(text);
	}
	/** 解绑两个订阅；幂等。 */
	dispose() {
		for (const dispose of this.disposers) dispose();
	}
};
//#endregion
//#region lib/types/restore-session.js
const DAY_MS = 864e5;
/**
* 相对时间：<60s 刚刚 / <1h N 分钟前 / <24h N 小时前 / <7d N 天前 / ≥7d 日期。
* @param createdAt - 会话创建时间戳（毫秒）。
* @param now - 当前时间戳（毫秒）。
* @returns 相对时间文本（≥7 天为 `YYYY-MM-DD`）。
*/
function formatSessionAge(createdAt, now) {
	const diff = now - createdAt;
	if (diff < 6e4) return "刚刚";
	if (diff < 36e5) return `${Math.floor(diff / 6e4)} 分钟前`;
	if (diff < DAY_MS) return `${Math.floor(diff / 36e5)} 小时前`;
	if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
	const d = new Date(createdAt);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 分组输出顺序：近 → 远。 */
const SESSION_AGE_GROUP_ORDER = [
	"today",
	"yesterday",
	"week",
	"earlier"
];
const SESSION_AGE_GROUP_LABEL = {
	today: "今天",
	yesterday: "昨天",
	week: "本周",
	earlier: "更早"
};
/** 本地日 00:00（与分组同一日界）。 */
function startOfLocalDay(ts) {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
/**
* 按本地日历把会话分到今天 / 昨天 / 本周 / 更早。
* 本周 = 2–6 天前；未来时间（时钟偏移）归今天。
*/
function sessionAgeGroup(createdAt, now) {
	const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(createdAt)) / DAY_MS);
	if (dayDiff <= 0) return "today";
	if (dayDiff === 1) return "yesterday";
	if (dayDiff < 7) return "week";
	return "earlier";
}
/** 分组中文标签。 */
function sessionAgeGroupLabel(group) {
	return SESSION_AGE_GROUP_LABEL[group];
}
/**
* 按今天→昨天→本周→更早分桶；空桶省略；组内保持输入顺序。
*/
function groupSessionsByAge(rows, now) {
	const buckets = /* @__PURE__ */ new Map();
	for (const group of SESSION_AGE_GROUP_ORDER) buckets.set(group, []);
	for (const row of rows) buckets.get(sessionAgeGroup(row.createdAt, now)).push(row);
	const out = [];
	for (const group of SESSION_AGE_GROUP_ORDER) {
		const items = buckets.get(group) ?? [];
		if (items.length === 0) continue;
		out.push({
			group,
			label: sessionAgeGroupLabel(group),
			items
		});
	}
	return out;
}
/**
* 会话选择器条目：每组先不可选头（`今天 · N`），再会话行。
* 当前会话只靠 `current`（●），标签不再写「（当前）」。
*/
function buildSessionPickerItems(rows, opts) {
	const items = [];
	let selectedIndex = 0;
	for (const bucket of groupSessionsByAge(rows, opts.now)) {
		items.push({
			label: `${bucket.label} · ${bucket.items.length}`,
			value: `header:${bucket.group}`,
			header: true
		});
		for (const row of bucket.items) {
			const current = row.id === opts.activeId;
			if (current) selectedIndex = items.length;
			items.push({
				label: `#${shortSessionLabel(row.id)} · ${row.title} · ${formatSessionAge(row.createdAt, opts.now)}`,
				value: row.id,
				current
			});
		}
	}
	return {
		items,
		selectedIndex
	};
}
/**
* `/session list` 旧版打印：分组头 + `id · 标题 · ISO`。
*/
function formatSessionListLines(rows, now) {
	const out = [];
	for (const bucket of groupSessionsByAge(rows, now)) {
		out.push(`${bucket.label} · ${bucket.items.length}`);
		for (const row of bucket.items) out.push(`${row.id} · ${row.title} · ${new Date(row.createdAt).toISOString()}`);
	}
	return out;
}
//#endregion
//#region lib/types/format/doctor-report.js
/**
* 收集终端诊断报告。
* @param cols 终端列数
* @param rows 终端行数
* @param background 终端背景色
* @param env 环境变量（默认 process.env）
* @returns 检查结果列表（可修复项带 fixId）。
*/
function collectDoctorReport(cols, rows, background, env = process.env) {
	const checks = [{
		name: "终端尺寸",
		status: "ok",
		value: `${cols}×${rows}`
	}, {
		name: "终端背景",
		status: "ok",
		value: background
	}];
	const hyperlink = detectHyperlinkSupport(env);
	checks.push({
		name: "超链接",
		status: hyperlink ? "ok" : "warn",
		value: hyperlink ? "✓" : "不支持"
	});
	const imageProtocol = detectImageProtocol(env);
	checks.push({
		name: "图片协议",
		status: imageProtocol !== "none" ? "ok" : "info",
		value: imageProtocol
	});
	const legacy = isLegacyWindowsConsole(env);
	checks.push({
		name: "终端兼容",
		status: legacy ? "warn" : "ok",
		value: legacy ? "遗留模式（功能受限）" : "现代终端"
	});
	const tcLevel = globalThis.chalkLevel ?? 3;
	checks.push({
		name: "True Color",
		status: tcLevel >= 3 ? "ok" : "warn",
		value: tcLevel >= 3 ? "✓ 16M 色" : `仅 ${tcLevel === 2 ? "256 色" : "16 色"}`
	});
	const inTmux = Boolean(env.TMUX);
	checks.push({
		name: "剪贴板",
		status: inTmux ? "warn" : "ok",
		value: inTmux ? "tmux 内（需 set-clipboard on）" : "直接终端",
		...inTmux ? { fixId: 1 } : {}
	});
	if ((env.TERM ?? "").toLowerCase().includes("kitty") && imageProtocol === "none") checks.push({
		name: "kitty 图片",
		status: "warn",
		value: "dcs-passthrough 未开启",
		fixId: 2
	});
	return checks;
}
/** 可修复项清单（与 DoctorCheck.fixId 对应）。 */
const DOCTOR_FIXES = [{
	id: 1,
	title: "tmux 剪贴板配置",
	guidance: "echo 'set-option -s set-clipboard on' >> ~/.tmux.conf  # 允许 tmux 使用系统剪贴板"
}, {
	id: 2,
	title: "kitty dcs-passthrough",
	guidance: "echo 'term_features all' >> ~/.config/kitty/kitty.conf  # 启用 DCS 透传（图片协议需要）"
}];
/**
* 获取修复指引文本。
* @param fixId - 修复项 id（DoctorCheck.fixId）。
* @returns 标题 + 指引文本；未知 id 返回 null。
*/
function getDoctorFixGuidance(fixId) {
	const fix = DOCTOR_FIXES.find((f) => f.id === fixId);
	if (fix === void 0) return null;
	return `[${fix.id}] ${fix.title}\n\n${fix.guidance}`;
}
//#endregion
//#region lib/types/preset-catalog.js
const BY_ID = new Map([
	{
		id: "standard",
		short: "标准",
		name: "标准模式",
		capability: "完整编码 Agent：改文件、Shell、检索、网页、Skills、计划、目标、子代理、工作流",
		tools: "bash · 编辑 · 检索 · web · skills · 计划 · 目标 · 子代理 · 工作流"
	},
	{
		id: "ptc",
		short: "PTC",
		name: "PTC 模式",
		capability: "标准能力 + PTC：用一个 TypeScript 程序组合多步工具",
		tools: "标准工具面 + run_code（PTC SDK）"
	},
	{
		id: "minimal",
		short: "极简",
		name: "极简模式",
		capability: "少干扰双工具编码面，适合评测与只要 shell + 改文件的任务",
		tools: "bash · str_replace_editor"
	},
	{
		id: "cordis",
		short: "创造",
		name: "创造模式",
		capability: "标准能力 + 做自定义 preset：运行时检查、插件实验、创作指导",
		tools: "标准工具面 + 运行时检查 · 插件实验 · preset 创作"
	}
].map((b) => [b.id, b]));
/** 用户口误 / 旧文档别名 → 官方目录 id（rc.1 起 Code Mode 正式更名 PTC mode）。 */
const ALIASES = {
	code: "ptc",
	creative: "cordis",
	creator: "cordis"
};
/** 把用户输入折成花名册 id（已知别名才改，其余原样）。 */
function resolveShippedPresetId(id) {
	return ALIASES[id] ?? id;
}
/** 按 id 或别名取展示目录；未知 id 返回 undefined。 */
function shippedPresetBlurb(id) {
	return BY_ID.get(resolveShippedPresetId(id));
}
/** footer / 顶栏短名；未知 id 原样。 */
function presetShortLabel(id) {
	return shippedPresetBlurb(id)?.short ?? id;
}
/**
* /preset 列表的两行补充：能力 + 工具。
* 官方 description 优先作能力行；没有再用目录。未知 id 只回官方 description。
*/
function presetListDetails(id, officialDescription) {
	const blurb = shippedPresetBlurb(id);
	const capability = officialDescription !== void 0 && officialDescription !== "" ? officialDescription : blurb?.capability;
	return {
		...capability === void 0 ? {} : { capability },
		...blurb === void 0 ? {} : { tools: blurb.tools }
	};
}
/** 从 host + 当前会话读 live 预设短名（无 join / 无会话 → undefined）。 */
function livePresetShort(host, sessionId) {
	if (sessionId === null || host.agents === void 0) return void 0;
	const agent = host.agents.get(sessionId);
	if (agent === void 0) return void 0;
	const id = (host.reflect?.get("agentPresets", false))?.composedPreset?.(agent.ctx);
	return id === void 0 || id === "" ? void 0 : presetShortLabel(id);
}
//#endregion
//#region lib/types/commands/model-validate.js
/**
* /model 目录校验与一键别名（回流 tianshu 8cc0cbe589）。
*
* 分级遵守 llm 目录的 advisory 契约（types.d.ts「catalog membership is
* advisory, not request validation」——目录缺失不得变成请求拒绝）：
* - provider 未注册（权威事实，请求注定派发失败）→ 硬拒绝并列已注册路由
* - 目录非空而模型在目录外 → 硬拒绝 + 至多三条就近建议（不自动纠错）
* - 目录为空（adapter 未通告/通告失败）无法证伪 → 放行；llm 未装配 → 跳过校验
*
* @module @deepseek-ai/dsh-tianshu-tui/commands/model-validate
*/
/**
* /model 一键切换别名（TUI 便捷层）：展开为已注册的 deepseek-official
* 路由 + 官方 wire 模型 id。官方 API 没有 spark 模型名，也没有
* deepseek-spark provider；别名只是 flash/pro 的快捷写法。
*/
const SPARK_ALIASES = {
	"spark-flash": {
		provider: "deepseek-official",
		model: "deepseek-v4-flash"
	},
	"spark-pro": {
		provider: "deepseek-official",
		model: "deepseek-v4-pro"
	}
};
/**
* /model 的就近建议：大小写不敏感的精确 → 前缀 → 子串匹配，去重封顶 3 个。
* 只做提示，不做自动纠错（纠错会掩盖 advisory 目录的边界）。
* @param input - 用户输入的模型名。
* @param catalogIds - 目标 provider 通告目录里的模型 id 列表。
* @returns 相近模型 id（catalog 原序），无相近时为空数组。
*/
function suggestModels(input, catalogIds) {
	const needle = input.toLowerCase();
	const exact = catalogIds.filter((id) => id.toLowerCase() === needle);
	const prefix = catalogIds.filter((id) => id.toLowerCase().startsWith(needle));
	const substring = catalogIds.filter((id) => id.toLowerCase().includes(needle));
	return [.../* @__PURE__ */ new Set([
		...exact,
		...prefix,
		...substring
	])].slice(0, 3);
}
/**
* 目录分级校验：通过返回 null；拒绝返回完整回显行（点名当前选择，不切换）。
* @param llm - llm 目录服务（reflect.get 动态获取）；undefined = 未装配，跳过校验。
* @param next - 待保存的目标路由。
* @param current - 当前生效路由（拒绝时点名）。
* @returns 拒绝回显行；null = 校验通过（或无法证伪/跳过）。
*/
async function validateModelSelection(llm, next, current) {
	if (llm === void 0) return null;
	const providers = llm.listProviders().map((provider) => provider.id);
	if (!providers.includes(next.provider)) return `⚠ 未知 provider: ${next.provider}（已注册: ${providers.join(" / ") || "无"}）——未切换，当前仍是 ${current.provider}/${current.model}`;
	const catalog = await llm.listModels(next.provider).catch(() => []);
	if (catalog.length > 0 && !catalog.some((model) => model.id === next.model)) {
		const suggestions = suggestModels(next.model, catalog.map((model) => model.id));
		const hint = suggestions.length > 0 ? `（你是否想用 ${suggestions.map((id) => `${next.provider}/${id}`).join(" / ")}？）` : `（可用 ${catalog.length} 个，/model 无参打开选择器）`;
		return `⚠ ${next.provider} 没有模型 ${next.model}${hint}——未切换，当前仍是 ${current.provider}/${current.model}`;
	}
	return null;
}
//#endregion
//#region lib/types/commands/startup-commands.js
/**
* startup-commands — /theme /model /effort /preset：会话应用 vs 启动默认。
*
* 带参无 default = 仅本会话；末尾 default / 选择器 S = 写启动默认。
*
* @module @huiliyi37/dsh-tianshu-tui/commands/startup-commands
*/
/** /model 的 effort 白名单（llm 三档：off / high / max）。 */
const EFFORT_LEVELS = [
	"off",
	"high",
	"max"
];
/** 花名册已有该 id 则原样；否则折官方别名（ptc→code）。 */
function listedId(presets, raw) {
	if (presets.some((p) => p.id === raw)) return raw;
	return resolveShippedPresetId(raw);
}
function echoModel(persist, hot, label) {
	if (persist) return hot ? echoSavedDefault("model", label) : `${echoSavedDefault("model", label)}（当前会话不可热切）`;
	return hot ? echoSessionOnly("model", label) : `模型已切换: ${label}（当前会话不可热切）。选择器按 S 或 /model default 可设为启动默认`;
}
function echoEffort(persist, hot, label) {
	if (persist) return hot ? echoSavedDefault("effort", label) : `${echoSavedDefault("effort", label)}（当前会话不可热切）`;
	return hot ? echoSessionOnly("effort", label) : `推理等级已设为 ${label}（当前会话不可热切）。选择器按 S 或 /effort default 可设为启动默认`;
}
function createThemeCommand(deps) {
	return {
		name: "theme",
		category: "配置",
		description: "切换主题（Enter/带参=本会话；S 或末尾 default=启动默认；auto/export 子命令）",
		argsHint: "<name>|auto|export [name]|default",
		run: ({ text, echo }) => {
			const { rest, persist } = splitDefaultFlag(text);
			if (rest === "" && persist) {
				const current = getActiveThemeName();
				deps.onThemeApplied(current);
				echo(echoSavedDefault("theme", current));
				return;
			}
			if (rest === "") {
				deps.openThemePicker();
				return;
			}
			if (rest === "auto") {
				deps.applyThemeAuto(persist);
				return;
			}
			if (rest === "export" || rest.startsWith("export ")) {
				echo(deps.exportTheme(rest.slice(6).trim() || void 0));
				return;
			}
			if (setTheme(rest)) {
				if (persist) deps.onThemeApplied(rest);
				deps.onThemeChanged?.();
				echo(persist ? echoSavedDefault("theme", rest) : echoSessionOnly("theme", rest));
			} else echo(`未知主题: ${rest}。可用: ${THEME_NAMES.join(", ")} / custom:<name>`);
		}
	};
}
function createModelCommand(deps) {
	return {
		name: "model",
		category: "配置",
		description: "查看或切换模型（带参=本会话；S 或末尾 default=启动默认；spark-flash / spark-pro 映射官方 flash / pro）",
		argsHint: "[provider/model | spark-flash | spark-pro] [effort] [default]",
		run: async ({ text, echo, ctx }) => {
			const facet = ctx.agentDefaultModel;
			if (facet === void 0) {
				echo("⚠ agent-default-model 服务不可用");
				return;
			}
			const current = facet.currentSelection();
			const { rest, persist } = splitDefaultFlag(text);
			if (rest === "" && persist) {
				await facet.saveSelection(current);
				echo(echoSavedDefault("model", `${current.provider}/${current.model}`));
				return;
			}
			if (rest === "") {
				deps.openModelPicker();
				return;
			}
			const [target = "", effortRaw] = rest.split(/\s+/);
			if (effortRaw !== void 0 && !EFFORT_LEVELS.includes(effortRaw)) {
				echo(`⚠ 不支持的 effort: ${effortRaw}（可用: off / high / max）`);
				return;
			}
			const aliased = SPARK_ALIASES[target];
			const input = aliased === void 0 ? target : `${aliased.provider}/${aliased.model}`;
			const routed = parseRouteKey(input);
			const next = routed === void 0 ? {
				provider: current.provider,
				model: input
			} : routed;
			const invalid = await validateModelSelection(ctx.reflect.get("llm", false), next, current);
			if (invalid !== null) {
				echo(invalid);
				return;
			}
			const selection = effortRaw === void 0 ? next : {
				...next,
				reasoningEffort: effortRaw
			};
			if (persist) await facet.saveSelection(selection);
			const hot = deps.switchLiveModel(selection);
			const effortPart = effortRaw === void 0 ? "" : ` (effort: ${effortRaw})`;
			echo(echoModel(persist, hot, `${selection.provider}/${selection.model}${effortPart}`));
		}
	};
}
function createEffortCommand(deps) {
	return {
		name: "effort",
		category: "配置",
		description: "设置推理等级（带参=本会话；S 或末尾 default=启动默认；auto 回模型默认）",
		argsHint: "[off|high|max|auto|default]",
		run: async ({ text, echo, ctx }) => {
			const facet = ctx.agentDefaultModel;
			if (facet === void 0) {
				echo("⚠ agent-default-model 服务不可用");
				return;
			}
			const current = facet.currentSelection();
			const { rest, persist } = splitDefaultFlag(text);
			if (rest === "" && persist) {
				await facet.saveSelection(current);
				echo(echoSavedDefault("effort", current.reasoningEffort ?? "auto"));
				return;
			}
			if (rest === "") {
				deps.openEffortPicker();
				return;
			}
			if (rest === "auto") {
				const selection = {
					provider: current.provider,
					model: current.model
				};
				if (persist) await facet.saveSelection(selection);
				echo(echoEffort(persist, deps.switchLiveModel(selection), "auto"));
				return;
			}
			if (!EFFORT_LEVELS.includes(rest)) {
				echo(`⚠ 不支持的推理等级: ${rest}（可用: off / high / max / auto）`);
				return;
			}
			const selection = {
				provider: current.provider,
				model: current.model,
				reasoningEffort: rest
			};
			if (persist) await facet.saveSelection(selection);
			echo(echoEffort(persist, deps.switchLiveModel(selection), rest));
		}
	};
}
function createPresetCommand(deps) {
	return {
		name: "preset",
		category: "配置",
		description: "查看/切换 agent 预设（带参=本会话；末尾 default=启动默认；仅空白会话可换）",
		argsHint: "[id] [default]",
		run: async ({ text, echo, ctx }) => {
			const facet = ctx.reflect.get("agentPresets", false);
			if (facet === void 0) {
				echo("⚠ agent-presets 服务不可用（host 未装配 agent 预设）");
				return;
			}
			const { rest, persist } = splitDefaultFlag(text);
			if (rest === "" && persist) {
				const agent = deps.currentAgent();
				const current = agent === null ? void 0 : facet.composedPreset?.(agent.ctx);
				if (current === void 0) {
					echo("⚠ 当前无预设可设为启动默认");
					return;
				}
				deps.persistPresetDefault(current);
				echo(echoSavedDefault("preset", current));
				return;
			}
			if (rest === "") {
				const presets = await facet.list();
				const agent = deps.currentAgent();
				const current = agent === null ? void 0 : facet.composedPreset?.(agent.ctx);
				const saved = deps.currentDefaultPreset();
				echo(`agent 预设 (${presets.length}):`);
				for (const preset of presets) {
					echo(` ${preset.id === current ? "*" : " "}${preset.id === saved ? "★" : " "}${preset.name ?? preset.id} (${preset.id})`);
					const details = presetListDetails(preset.id, preset.description);
					if (details.capability !== void 0) echo(`    ${details.capability}`);
					if (details.tools !== void 0) echo(`    工具: ${details.tools}`);
				}
				let currentLine = current === void 0 ? "当前: 未装配（host 默认）" : `当前: ${current} · ${presetShortLabel(current)}`;
				if (saved !== void 0) currentLine += ` · 启动默认: ${saved}`;
				if (agent !== null) {
					const wire = wireToolNames(agent.session.snapshotEvents());
					const surface = formatWireSurface(wire);
					if (surface !== void 0) {
						const phase = wirePhaseLabel(wire);
						currentLine += ` · wire: ${surface}${phase === void 0 ? "" : `（${phase}）`}`;
					}
				}
				echo(currentLine);
				return;
			}
			const agent = deps.currentAgent();
			if (agent === null) {
				echo("当前无会话，无法切换预设");
				return;
			}
			if (!deps.isBlankSession()) {
				echo("⚠ 会话已产生内容，无法切换预设（仅空白会话可换；新会话默认仍用当前预设）");
				return;
			}
			try {
				const wanted = listedId(await facet.list(), rest);
				const preset = await facet.recompose(agent.ctx, wanted);
				agent.session.append("agent-preset/selected", { agentPreset: preset.id });
				if (persist) deps.persistPresetDefault(preset.id);
				const label = `${preset.name ?? preset.id} (${preset.id})`;
				echo(persist ? echoSavedDefault("preset", label) : echoSessionOnly("preset", label));
			} catch (error) {
				echo(`切换失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}
//#endregion
//#region lib/types/commands/registry.js
/**
* Phase 6.1 Slash 命令系统 — Cordis 服务式命令注册表与内置命令。
*
* 职责划分：
* - `resolveSlashCommand`：纯函数最小唯一前缀解析（/ 前缀检测、歧义/未知 → null）。
* - `SlashCommandRegistry`：实例化命令注册表（register/list/get/unregister/resolve/hint），
*   由 TuiApp 持有（this.slash）；/help 经 BuiltinCommandDeps.listCommands 注入取用。
*   （头注释曾写「经 ctx.provide('tui.commands') 暴露」——该 provide 从未实现，
*   外部插件扩展命令的通道是设计意图，未落地；直接访问 ctx.tui 会触发 Cordis
*   注入代理 "without inject" 抛错，见 #36。）
* - `createBuiltinCommands`：内置命令工厂（/theme /session /clear /compact；/steer 由
*   TuiApp 直接复用既有入口，注册表只保留其名字参与前缀解析与提示）。
*
* dsh 纪律：命令执行只改 UI 状态（主题/滚动区/会话切换）或调用既有服务，不写回 session
* log、不发明事件类型。命令文本经 `/` 前缀在输入层分流，未知命令回显提示而非提交给 agent。
*
* @module @deepseek-ai/dsh-tianshu-tui/commands
*/
/**
* 内置命令名（解析 + 提示的单一事实来源；描述/argsHint 见 createBuiltinCommands）。
* 含 /steer：TuiApp 复用既有 handleSteer 入口，此处只参与前缀匹配。
* /status 同款：注册表只声明名字参与前缀解析/提示，实际显隐切换 handler 由
* TuiApp 经 register 接线（见 ui/app.ts）。
* /subagents、/workflow、/tasks 的命令定义在 createBuiltinCommands（deps 注入
* TuiApp 的显隐切换）；/status、/todos 保持 TuiApp 内注册（/todos：无参显隐 +
* all 明细展开，数据源为 todos 投影保留快照）。
*/
const BUILTIN_COMMAND_NAMES = [
	"theme",
	"session",
	"fork",
	"branch",
	"clear",
	"scroll",
	"compact",
	"steer",
	"model",
	"effort",
	"key",
	"login",
	"preset",
	"tasks",
	"density",
	"glance",
	"info",
	"changelog",
	"goal",
	"status",
	"todos",
	"subagents",
	"workflow",
	"config",
	"skills",
	"rewind",
	"btw",
	"doctor",
	"mcp",
	"remember",
	"memory",
	"export",
	"exit",
	"restart",
	"update",
	"yolo",
	"help",
	"cost",
	"vim",
	"welcome"
];
/**
* 最小唯一前缀解析：`/` 前缀 + 命令名 `startsWith` 匹配。
* 歧义（多命令同前缀）或未知名返回 null——不猜命令。
* @param input - 输入行原始文本。
* @param commands - 命令名集合（字符串或带 name 的对象，registry 实例与静态名表共用）。
* @returns 命中的命令与剥离后的参数文本；无匹配返回 null。
*/
function resolveSlashCommand(input, commands) {
	if (!input.startsWith("/")) return null;
	const spaceIdx = input.indexOf(" ");
	const token = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
	const rest = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1).trim();
	if (token === "") return null;
	const nameOf = (c) => typeof c === "string" ? c : c.name;
	const matches = commands.filter((c) => nameOf(c).startsWith(token));
	if (matches.length !== 1) return null;
	const match = matches[0];
	/* v8 ignore next -- length===1 保证 [0] 必有值；noUncheckedIndexedAccess 收窄防御 */
	if (match === void 0) return null;
	return {
		command: { name: nameOf(match) },
		text: rest
	};
}
/**
* 命令注册表——register/unregister/list/get/resolve/hint。
* 同名 register 覆盖旧命令；空名或含空格的命令名 register 抛错。
* 实例经 `ctx.provide('tui.commands', registry)` 暴露为 Cordis 服务。
*/
var SlashCommandRegistry = class {
	commands = /* @__PURE__ */ new Map();
	/**
	* 注册（或覆盖同名）命令。
	* @param command - 命令定义；空名或含空格的名字抛错。
	*/
	register(command) {
		if (command.name === "" || command.name.includes(" ")) throw new Error(`invalid slash command name: ${JSON.stringify(command.name)}`);
		this.commands.set(command.name, command);
	}
	/**
	* 反注册命令；不存在时 no-op。
	* @param name - 命令名（不含 / 前缀）。
	*/
	unregister(name) {
		this.commands.delete(name);
	}
	/**
	* 按注册顺序列出全部命令。
	* @returns 命令数组（注册顺序）。
	*/
	list() {
		return [...this.commands.values()];
	}
	/**
	* 按名取命令；未注册返回 undefined。
	* @param name - 命令名（不含 / 前缀，精确匹配）。
	* @returns 命中的命令；未注册为 undefined。
	*/
	get(name) {
		return this.commands.get(name);
	}
	/**
	* 最小唯一前缀解析（委托 resolveSlashCommand，用实例注册表）。
	* @param input - 输入行原始文本。
	* @returns 命中的命令与参数文本；未知/歧义/非 slash 输入为 null。
	*/
	resolve(input) {
		const parsed = resolveSlashCommand(input, this.list());
		/* v8 ignore next -- resolveSlashCommand 只在命令存在时返回对象，get 必命中；双查防御 */
		if (parsed === null) return null;
		const command = this.commands.get(parsed.command.name);
		/* v8 ignore next -- 同上：parsed 来自本注册表命令名，get 恒非 undefined；双查防御 */
		if (command === void 0) return null;
		return {
			command,
			text: parsed.text
		};
	}
	/**
	* 内联提示：输入以 / 开头且有匹配命令时返回提示行；否则 null。
	* 展示在 live 区输入行上方（最小内联提示，不启用 overlay-engine 全屏面板）。
	* @param input - 输入行原始文本。
	* @returns 一行 `命令: /a /b …` 提示；无匹配为 null。
	*/
	hint(input) {
		if (!input.startsWith("/")) return null;
		const token = input.slice(1);
		if (token === "") return null;
		const matches = this.list().filter((c) => c.name.startsWith(token));
		if (matches.length === 0) {
			if (token.includes("/") || token.includes(".") || token.includes(" ")) return null;
			return "无匹配命令（Enter 提交查看相近建议）";
		}
		return `命令: ${matches.map((c) => `/${c.name}${c.argsHint === void 0 ? "" : ` ${c.argsHint}`}`).join("   ")}`;
	}
};
/**
* 装配内置命令（/theme /session /clear /compact）。
* /steer 不在此列——TuiApp 复用既有 handleSteer 入口。
* @param deps - TuiApp 私有能力。
* @returns 内置命令数组（含描述/argsHint，供注册表与提示使用）。
*/
function createBuiltinCommands(deps) {
	return [
		createThemeCommand(deps),
		{
			name: "session",
			category: "会话",
			description: "会话管理：new 新建，list 列出，switch 切换",
			argsHint: "new|list|switch <id>",
			run: async ({ text, echo, ctx }) => {
				/* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
				const sub = text.split(/\s+/)[0] ?? "";
				if (sub === "") {
					deps.openSessionPicker();
					return;
				}
				if (sub === "new") {
					echo(`已新建会话: ${await deps.newSession()}`);
					return;
				}
				if (sub === "list") {
					const rows = await listSessions(ctx);
					if (rows.length === 0) {
						echo("（当前无会话）");
						return;
					}
					const titled = [];
					for (const row of rows) {
						const events = await loadHistory(ctx, row.id);
						titled.push({
							id: row.id,
							createdAt: row.createdAt,
							title: sessionTitleFor(events)
						});
					}
					for (const line of formatSessionListLines(titled, Date.now())) echo(line);
					return;
				}
				if (sub === "switch") {
					const id = text.slice(sub.length).trim();
					if (id === "") {
						echo("用法: /session switch <id>（/session list 查看 id）");
						return;
					}
					await deps.switchSession(id);
					echo(`已切换会话: ${id}`);
					return;
				}
				echo("用法: /session new|list|switch <id>");
			}
		},
		{
			name: "fork",
			category: "会话",
			description: "分叉当前会话（复制历史到新会话并切换）",
			argsHint: "[directive]",
			run: async ({ text, echo }) => {
				const directive = text.trim();
				echo(`已分叉会话: ${directive === "" ? await deps.forkSession() : await deps.forkSession({ directive })}`);
			}
		},
		{
			name: "rewind",
			category: "面板",
			description: "回退到一条用户消息（C3 项 3：会话截断 + 可选文件回退）",
			argsHint: "",
			run: ({ echo }) => {
				if (!deps.rewindSession()) echo("⚠ 当前无可回退的会话");
			}
		},
		{
			name: "branch",
			category: "会话",
			description: "分叉当前会话（/fork 别名）",
			run: async ({ echo }) => {
				echo(`已分叉会话: ${await deps.forkSession()}`);
			}
		},
		createModelCommand(deps),
		{
			name: "key",
			category: "认证",
			description: "配置模型供应商 API 密钥（选择供应商 → 掩码输入 + 联网验证；保存即生效）",
			run: () => {
				deps.openKeyDialog();
			}
		},
		{
			name: "login",
			category: "认证",
			description: "配置模型供应商 API 密钥（/key 别名）",
			run: () => {
				deps.openKeyDialog();
			}
		},
		{
			name: "update",
			category: "系统",
			description: "检查插件更新（对照 npm latest；发现新版提示手动更新命令）",
			run: async ({ echo }) => {
				const result = await deps.checkForUpdate();
				if (result.kind === "latest") echo(`发现新版本 ${result.latest}（当前 ${result.current}）。手动更新：npx -y @deepseek-ai/dsh plugin --profile tui add ${TUI_PACKAGE}@latest；或重启后自动更新`);
				else if (result.kind === "current") echo(`已是最新版本（${result.current}）`);
				else echo(`⚠ 更新检查失败：${result.error}`);
			}
		},
		createEffortCommand(deps),
		createPresetCommand(deps),
		{
			name: "clear",
			category: "会话",
			description: "清空当前会话滚动区并收起命令面板",
			run: ({ echo }) => {
				deps.clearScrollback();
				echo("已清空当前会话滚动区");
			}
		},
		{
			name: "scroll",
			category: "会话",
			description: "分页查看会话转录（滚动 / 搜索 / n·N 跳转）",
			run: () => {
				deps.openScrollPager();
			}
		},
		{
			name: "compact",
			category: "会话",
			description: "压缩当前会话（需 compact 服务）",
			run: async ({ text: _text, echo, ctx, sessionId }) => {
				const agent = sessionId === null ? void 0 : ctx.agents.get(sessionId);
				const compact = serviceForAgent(ctx, agent, "compact");
				if (compact === void 0) {
					echo("⚠ compact 服务不可用（未加载 compact 插件）");
					return;
				}
				if (sessionId === null) {
					echo("⚠ 当前无会话");
					return;
				}
				const session = ctx.sessions.get(sessionId);
				if (session === void 0) {
					echo("⚠ 会话不存在");
					return;
				}
				echo(await compact.compactIfNeeded({
					session,
					options: agent?.options ?? {}
				}, "pressure", new AbortController().signal) === null ? "无需压缩（或无可压缩范围）" : "压缩完成");
			}
		},
		{
			name: "goal",
			category: "面板",
			description: "目标管理：查看/创建/暂停/恢复/完成/阻塞（需 goal 服务）",
			argsHint: "[create <objective>|pause|resume|complete|block]",
			run: ({ text, echo, ctx, sessionId }) => {
				const goals = ctx.reflect.get("goals", false);
				if (goals === void 0) {
					echo("⚠ goal 服务不可用（未加载 goal 插件）");
					return;
				}
				if (sessionId === null) {
					echo("⚠ 当前无会话");
					return;
				}
				const agent = ctx.agents.get(sessionId);
				if (agent === void 0) {
					echo("⚠ 会话不存在");
					return;
				}
				/* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
				const verb = text.split(/\s+/)[0] ?? "";
				const rest = verb === "" ? "" : text.slice(verb.length).trim();
				if (verb === "") {
					const view = goals.get(agent);
					if (view === void 0) {
						echo("（当前无目标）");
						return;
					}
					echo(formatGoalView(view));
					return;
				}
				if (verb === "create") {
					if (rest === "") {
						echo("用法: /goal create <objective>");
						return;
					}
					const view = goals.create(agent, { objective: rest });
					echo(`目标已创建: ${view.objective}（phase: ${view.phase}）`);
					return;
				}
				if (![
					"pause",
					"resume",
					"complete",
					"block"
				].includes(verb)) {
					echo("用法: /goal [create <objective>|pause|resume|complete|block]");
					return;
				}
				const current = goals.get(agent);
				if (current === void 0) {
					echo("（当前无目标，无法执行该操作）");
					return;
				}
				const ref = {
					id: current.id,
					revision: current.revision
				};
				if (verb === "pause") {
					echo(`目标已暂停: ${goals.pause(agent, ref).objective}`);
					return;
				}
				if (verb === "resume") {
					const view = goals.resume(agent, ref);
					echo(`目标已恢复: ${view.objective}（phase: ${view.phase}）`);
					return;
				}
				if (verb === "complete") {
					echo(`目标已完成: ${goals.complete(agent, ref).objective}`);
					return;
				}
				/* v8 ignore next -- MUTATIONS 过滤 + 前三 if 提前 return，此处 verb 恒为 'block'，false 侧不可达 */
				if (verb === "block") {
					echo(`目标已阻塞: ${goals.block(agent, ref, {
						code: "user-requested",
						message: rest === "" ? "blocked by user via /goal" : rest
					}).objective}`);
					return;
				}
			}
		},
		{
			name: "tasks",
			category: "面板",
			description: "任务窗格：无参切换；kill <id> 终止后台任务",
			argsHint: "[kill <id>]",
			run: ({ text, echo, ctx }) => {
				/* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
				const sub = text.split(/\s+/)[0] ?? "";
				if (sub === "kill") {
					const id = text.slice(sub.length).trim();
					if (id === "") {
						echo("用法: /tasks kill <id>");
						return;
					}
					const tasks = ctx.reflect.get("tasks", false);
					if (tasks === void 0) {
						echo("⚠ tasks 服务不可用（未加载 tasks 插件）");
						return;
					}
					echo(tasks.kill(id) === "already-finished" ? `任务已结束: ${id}` : `已请求终止任务: ${id}`);
					return;
				}
				if (sub !== "") {
					echo("用法: /tasks [kill <id>]");
					return;
				}
				deps.toggleTaskPanel();
			}
		},
		{
			name: "subagents",
			category: "面板",
			description: "切换委派树面板（subagent 层级投影）",
			run: () => {
				deps.toggleSubagentsPanel();
			}
		},
		{
			name: "workflow",
			category: "面板",
			description: "切换 workflow 运行中面板",
			run: () => {
				deps.toggleWorkflowPanel();
			}
		},
		{
			name: "btw",
			category: "会话",
			description: "侧问：向后台 agent 提问（不中断当前对话）",
			argsHint: "<question>",
			run: async ({ text, echo }) => {
				const question = text.trim();
				if (question === "") {
					echo("用法: /btw <question>");
					return;
				}
				if (!await deps.askBtw(question)) echo("⚠ 当前无会话或已有挂起的侧问");
			}
		},
		{
			name: "remember",
			category: "会话",
			description: "保存一条项目记忆（写入 .dsh/memory/global.md）",
			argsHint: "<text>",
			run: async ({ text, echo, ctx }) => {
				const memory = ctx.reflect.get("memory", false);
				if (memory === void 0) {
					echo("⚠ memory 服务不可用（未加载 memory 插件）");
					return;
				}
				const content = text.trim();
				if (content === "") {
					echo("用法: /remember <text>");
					return;
				}
				echo(`已保存记忆: ${(await memory.save({
					text: content,
					scope: "global",
					tags: [],
					source: "user"
				})).id}`);
			}
		},
		{
			name: "memory",
			category: "会话",
			description: "打开记忆浏览器；delete <id> 直接删除",
			argsHint: "[delete <id>]",
			run: async ({ text, echo, ctx }) => {
				const memory = ctx.reflect.get("memory", false);
				if (memory === void 0) {
					echo("⚠ memory 服务不可用（未加载 memory 插件）");
					return;
				}
				/* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
				const sub = text.split(/\s+/)[0] ?? "";
				if (sub === "delete") {
					const id = text.slice(sub.length).trim();
					if (id === "") {
						echo("用法: /memory delete <id>");
						return;
					}
					await memory.delete(id);
					echo(`已删除记忆: ${id}`);
					return;
				}
				if (sub !== "") {
					echo("用法: /memory [delete <id>]");
					return;
				}
				if (!await deps.openMemoryBrowser()) echo("⚠ 无法打开记忆浏览器");
			}
		},
		{
			name: "doctor",
			category: "系统",
			description: "终端诊断：检测终端能力并输出报告；fix <id> 查看修复指引",
			argsHint: "[fix <id>]",
			run: ({ text, echo }) => {
				const sub = text.trim();
				if (sub.startsWith("fix")) {
					const idStr = sub.slice(3).trim();
					const id = Number(idStr);
					if (Number.isNaN(id) || idStr === "") {
						echo("用法: /doctor fix <id>");
						return;
					}
					const guidance = getDoctorFixGuidance(id);
					if (guidance === null) {
						echo(`未知修复项: ${id}`);
						return;
					}
					echo(guidance);
					return;
				}
				if (sub !== "") {
					echo("用法: /doctor [fix <id>]");
					return;
				}
				const cols = process.stdout.columns;
				const rows = process.stdout.rows;
				const checks = collectDoctorReport(cols, rows, process.env.COLORFGBG !== void 0 ? "已检测" : "未检测");
				echo("终端诊断报告:");
				for (const c of checks) {
					const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "ℹ";
					const fixTag = c.fixId !== void 0 ? ` [修复 ${c.fixId}]` : "";
					echo(`  ${icon} ${c.name}: ${c.value}${fixTag}`);
				}
				const fixable = checks.filter((c) => c.fixId !== void 0);
				if (fixable.length > 0) {
					echo("");
					echo("可修复项:");
					for (const c of fixable) {
						const id = c.fixId;
						if (id === void 0) continue;
						const fix = getDoctorFixGuidance(id);
						if (fix !== null) echo(`  [${id}] ${fix.split("\n")[0]}`);
					}
					echo("运行 /doctor fix <id> 查看详细修复指引");
				}
			}
		},
		{
			name: "mcp",
			category: "系统",
			description: "MCP 状态：列出已连接 server 与工具数；tools <name> 查看工具清单",
			argsHint: "[tools <server>]",
			run: ({ text, echo, ctx }) => {
				const table = ctx.reflect.get("mcp.status", false);
				if (table === void 0 || table.size === 0) {
					echo("⚠ 无 MCP server 连接（检查 cordis.yml 中 mcp-client 插件配置）");
					return;
				}
				const sub = text.trim();
				if (sub.startsWith("tools")) {
					const target = sub.slice(5).trim();
					if (target === "") {
						echo("用法: /mcp tools <server>");
						return;
					}
					const status = table.get(target);
					if (status === void 0) {
						echo(`未知 MCP server: ${target}。可用: ${[...table.keys()].join(", ")}`);
						return;
					}
					const names = status.listToolNames().sort();
					echo(`${target} (${names.length} 工具):`);
					for (const name of names) echo(`  ${name}`);
					return;
				}
				if (sub !== "") {
					echo("用法: /mcp [tools <server>]");
					return;
				}
				const servers = [...table.values()].sort((a, b) => a.serverName.localeCompare(b.serverName));
				echo(`MCP servers (${servers.length}):`);
				for (const s of servers) echo(`  ${s.serverName}: ${s.getToolCount()} 工具`);
			}
		},
		{
			name: "export",
			category: "会话",
			description: "导出当前会话转录为 Markdown 文件（T3）",
			argsHint: "[path]",
			run: async ({ text, echo }) => {
				const path = text.trim() === "" ? void 0 : text.trim();
				echo(`会话已导出: ${await deps.exportTranscript(path)}`);
			}
		},
		{
			name: "exit",
			category: "会话",
			description: "退出 TUI（与 Ctrl+Q 相同）",
			run: () => {
				deps.requestExit();
			}
		},
		{
			name: "restart",
			category: "会话",
			description: "重启当前 dsh 进程（同命令重新启动；插件更新后无需手动重跑）",
			run: () => {
				deps.requestRestart();
			}
		},
		{
			name: "yolo",
			category: "配置",
			description: "全放行模式：审批不再逐项询问（on 开启 / off 关闭；等价 Shift+Tab 进 always-approve）",
			argsHint: "on|off",
			run: ({ text, echo }) => {
				const arg = text.trim().toLowerCase();
				if (arg === "off" || arg === "0" || arg === "false") {
					deps.setYoloMode(false);
					echo("全放行模式已关闭（恢复逐项审批）");
					return;
				}
				if (arg !== "" && arg !== "on" && arg !== "1" && arg !== "true") {
					echo("用法: /yolo [on|off]（缺省 on；off 关闭全放行）");
					return;
				}
				deps.setYoloMode(true);
				echo("全放行模式已开启：后续审批请求自动放行（/yolo off 关闭，退出会话复位）");
			}
		},
		{
			name: "help",
			category: "系统",
			description: "列出全部命令与用法（/help <cmd> 查看单条详情）",
			argsHint: "[cmd]",
			run: ({ text, echo }) => {
				const all = deps.listCommands();
				const target = text.trim();
				if (target !== "") {
					const command = all.find((c) => c.name === target);
					if (command === void 0) {
						echo(`未知命令: /${target}（/help 查看全部命令）`);
						return;
					}
					echo(`/${command.name}${command.argsHint === void 0 ? "" : ` ${command.argsHint}`} — ${command.description}`);
					return;
				}
				deps.openCommandPalette();
				echo("命令面板已打开：分组浏览 + 过滤（/help <cmd> 查看单条详情）");
			}
		},
		{
			name: "cost",
			category: "系统",
			description: "当前会话累计用量与成本估算（按模型分桶）",
			argsHint: "",
			run: ({ echo }) => {
				for (const line of deps.sessionCostReport()) echo(line);
			}
		}
	];
}
/** 渲染一行当前目标（/goal 无参视图）。 */
function formatGoalView(view) {
	return `目标: ${view.objective}（phase: ${view.phase}，rounds: ${view.roundsStarted}/${view.maxGoalRounds}）`;
}
/**
* 未知命令的相近建议（闭环引导）：编辑距离命中（≤ 2 且 ≤ 输入长度一半——
* 短输入只信前缀，防 /st 误建议 btw/cost），其次公共前缀 ≥ 2。
* 歧义前缀（如 /st → steer/status）与笔误（如 /glans → glance）都能命中；
* 无相近命令返回空数组（调用方回退「/help 查看全部」引导）。
* @param input - 完整 slash 输入（含 / 前缀；大小写不敏感）。
* @param commands - 命令列表。
* @param limit - 建议条数上限（缺省 3）。
* @returns 建议命令（匹配度升序；距离相同时短名优先）。
*/
function suggestCommands(input, commands, limit = 3) {
	const name = input.replace(/^\//, "").trim().toLowerCase();
	if (name === "") return [];
	const scored = [];
	for (const cmd of commands) {
		const d = levenshteinDistance(name, cmd.name);
		const prefix = commonPrefixLength(name, cmd.name);
		if (d <= 2 && d <= Math.floor(name.length / 2)) scored.push({
			cmd,
			score: d
		});
		else if (prefix >= 2) scored.push({
			cmd,
			score: 3
		});
	}
	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		if (a.cmd.name.length !== b.cmd.name.length) return a.cmd.name.length - b.cmd.name.length;
		return a.cmd.name.localeCompare(b.cmd.name);
	});
	return scored.slice(0, limit).map((s) => s.cmd);
}
/** 编辑距离（经典 DP；len 乘积空间，命令名短小足够）。 */
function levenshteinDistance(a, b) {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const curr = [i, ...Array(n)];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[n];
}
/** 最长公共前缀长度。 */
function commonPrefixLength(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}
//#endregion
//#region lib/types/format/pricing.js
/**
* pricing — 模型 → $/MTok 定价表与成本估算（纯函数，无 I/O）。
*
* 数据源：usage 折叠（TokenUsage）只给 token 数，不给金额——成本是展示层
* 估算，内置官方档位定价表（flash = chat 档 / pro = reasoner 档，2025 公开价）。
* 未知模型返回 undefined：诚实降级（同缓存% 未报不显示 0% 的语义）。
*
* @module @deepseek-ai/dsh-tianshu-tui/pricing
*/
/** 内置定价表；key = wire 模型 id（spark 别名展开后的 deepseek-v4-*）。 */
const MODEL_PRICES = {
	"deepseek-v4-flash": {
		input: .27,
		output: 1.1,
		cacheRead: .07
	},
	"deepseek-v4-pro": {
		input: .55,
		output: 2.19,
		cacheRead: .14
	}
};
/**
* 估算一次请求的美元成本（四舍五入到分）。
* billed 输入 = inputTokens + cacheRead + cacheWrite（缓存写按未命中输入价计）。
* @param modelName - wire 模型 id；不在定价表返回 undefined。
* @param usage - TokenUsage（DISJOINT 计数，与 glanceMetrics 同源）。
* @returns 成本（美元）；模型未知或 token 全零返回 undefined。
*/
function estimateCost(modelName, usage) {
	const price = MODEL_PRICES[modelName];
	if (price === void 0) return void 0;
	if (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= 0 && usage.outputTokens <= 0) return void 0;
	const cost = (usage.inputTokens * price.input + (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) + (usage.cacheWriteTokens ?? 0) * price.input + usage.outputTokens * price.output) / 1e6;
	return Math.round(cost * 100) / 100;
}
//#endregion
//#region lib/types/format/session-cost.js
/**
* session-cost — 会话成本汇总(纯函数;Claude Code /cost 形态)。
*
* 数据源:assistant/message 事件的 usage(TokenUsage,每次请求计量)按模型
* 分桶累计;模型 key 取最近一次 request/header 的 config.model(wire id)。
* 成本估算复用 pricing.ts(未知模型不猜价);token 计数复用 formatTokenCount。
*
* @module @deepseek-ai/dsh-tianshu-tui/session-cost
*/
/** 空桶(缺省值)。 */
function emptyBucket(model) {
	return {
		model,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0
	};
}
/**
* 累加一次请求计量进桶(纯函数;usage 的缓存字段缺省按 0)。
* @param bucket - 现有桶(undefined → 以 usage 建桶)。
* @param usage - 本次请求的 TokenUsage。
* @returns 新桶。
*/
function accumulateUsage(bucket, usage, model = "unknown") {
	const base = bucket ?? emptyBucket(model);
	return {
		...base,
		inputTokens: base.inputTokens + usage.inputTokens,
		cacheReadTokens: base.cacheReadTokens + (usage.cacheReadTokens ?? 0),
		cacheWriteTokens: base.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
		outputTokens: base.outputTokens + usage.outputTokens,
		reasoningTokens: base.reasoningTokens + (usage.reasoningTokens ?? 0)
	};
}
/**
* 渲染会话成本报告行:标题 + 每模型明细(输入/缓存读/写/输出/推理/$)+ 合计。
* 空桶列表 → 占位提示行。
* @param buckets - 各模型累计桶(顺序 = 传入序,建议按首次出现序)。
* @returns 报告行数组(纯文本,无 ANSI)。
*/
function formatSessionCostReport(buckets) {
	const rows = ["会话成本统计"];
	if (buckets.length === 0) {
		rows.push("（本会话尚无用量数据）");
		return rows;
	}
	let totalInput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalOutput = 0;
	let totalCost = 0;
	for (const bucket of buckets) {
		const usage = {
			inputTokens: bucket.inputTokens,
			outputTokens: bucket.outputTokens,
			cacheReadTokens: bucket.cacheReadTokens,
			cacheWriteTokens: bucket.cacheWriteTokens,
			reasoningTokens: bucket.reasoningTokens
		};
		const cost = estimateCost(bucket.model, usage);
		if (cost !== void 0) totalCost += cost;
		const parts = [`· ${bucket.model}`];
		if (bucket.inputTokens > 0 || bucket.cacheReadTokens > 0 || bucket.cacheWriteTokens > 0) {
			const input = [`输入 ${formatTokenCount(bucket.inputTokens)}`];
			if (bucket.cacheReadTokens > 0) input.push(`缓存读 ${formatTokenCount(bucket.cacheReadTokens)}`);
			if (bucket.cacheWriteTokens > 0) input.push(`写 ${formatTokenCount(bucket.cacheWriteTokens)}`);
			parts.push(input.join(" · "));
		}
		if (bucket.outputTokens > 0) parts.push(`输出 ${formatTokenCount(bucket.outputTokens)}`);
		if (bucket.reasoningTokens > 0) parts.push(`推理 ${formatTokenCount(bucket.reasoningTokens)}`);
		if (cost !== void 0) parts.push(`$${cost}`);
		rows.push(parts.join(" — "));
		totalInput += bucket.inputTokens;
		totalCacheRead += bucket.cacheReadTokens;
		totalCacheWrite += bucket.cacheWriteTokens;
		totalOutput += bucket.outputTokens;
	}
	const total = [`合计:输入 ${formatTokenCount(totalInput)}`];
	if (totalCacheRead > 0) total.push(`缓存读 ${formatTokenCount(totalCacheRead)}`);
	if (totalCacheWrite > 0) total.push(`写 ${formatTokenCount(totalCacheWrite)}`);
	total.push(`输出 ${formatTokenCount(totalOutput)}`);
	if (totalCost > 0) total.push(`$${Math.round(totalCost * 100) / 100}`);
	rows.push(total.join(" · "));
	return rows;
}
//#endregion
//#region lib/types/ui/render.js
/**
* 转录渲染 — 把 adapter/transcript 的 TranscriptView 投影渲染为终端行。
*
* 纯函数层：输入 TranscriptView + RivetTheme + 终端宽度（+ 可选 presenter
* 意图解析器），输出 ANSI 行数组。零 IO、零全局状态，便于单测；TuiApp
* 装配层只负责把这些行送进 CommitEngine / LiveEngine。
*
* 消息 → 行映射：
* - user → formatUserMessage（▌ 导轨）
* - assistant → 思考块（reasoning 折叠，暗色）+ formatMarkdown 正文
* - tool/call+result 配对 → formatToolViewCard（presenter 意图优先，
*   diff/terminal 结构化卡；无意图回落 formatToolCard 文本折叠）
*
* 顺序契约：renderTranscript 按事件 seq 交错消息与工具卡（卡插在其
* `tool/call` 事件的位置）——与 live 路径的逐事件提交产出同一顺序，
* resume 回放与实时会话渲染一致。
*/
/**
* 从配对的 `tool/result` 事件提取模型面显示文本与错误标记。
* live 结算提交（app.ts）与 resume 回放（renderToolRows）共用同一提取。
* @param result - 配对的 tool/result 事件。
* @returns tool-result 块内 text 块折叠文本 + 错误标记（事件 error 或块级 isError）。
*/
function toolResultText(result) {
	let content = "";
	const first = result.data.message.content[0];
	if (first !== void 0 && first.type === "tool-result" && first.content !== void 0) content = first.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	const isError = result.data.error !== void 0 || first?.isError === true;
	return {
		content,
		isError
	};
}
/**
* #39：注入型 user 行的摘要 chip 渲染。
* - `skill-invocation`（用户显式技能调用，host 经 agent/pre-step 注入）→ `🧭 使用技能: <name>`
* - `skill-catalog`（技能目录更新注入）→ `🧭 技能目录已更新（N 项）`
* - 其余（含 source 缺失/未知形状）→ null（按普通用户行渲染）。
* 防御读取：TranscriptMessage.event 可能是任意 SessionEvent（resume 回放/
* 测试替身），形状不符一律回落普通渲染，不抛错。
* @param message - 转录行（event 为权威事实）。
* @param theme - 当前主题（chip 用 muted 色弱化）。
* @returns chip 行；非注入型/形状未知返回 null。
*/
function renderInjectedChip(message, theme) {
	const event = message.event;
	if (event.type !== "user/message") return null;
	const source = event.data?.source;
	if (source === void 0) return null;
	const kind = source.kind;
	if (kind === "skill-invocation") {
		const name = source.name;
		return {
			ansi: color(typeof name === "string" && name !== "" ? `🧭 使用技能: ${name}` : "🧭 使用技能", theme.muted),
			kind: "system"
		};
	}
	if (kind === "skill-catalog") {
		const count = Array.isArray(source.entries) ? source.entries.length : null;
		return {
			ansi: color(count === null ? "🧭 技能目录已更新" : `🧭 技能目录已更新（${count} 项）`, theme.muted),
			kind: "system"
		};
	}
	return null;
}
/**
* 渲染一条完成的 user/assistant 消息为终端行。
* assistant 消息先渲染思考块（reasoning 折叠，暗色斜体），再渲染 markdown
* 正文——与 live 路径「思考落底在正文前」的提交顺序一致。
* @param message - TranscriptView.messages 中的一条。
* @param theme - 当前主题。
* @param columns - 终端列数（markdown 换行度量）。
* @param options - 紧凑模式等渲染选项。
* @returns ANSI 行数组。
*/
function renderMessageRows(message, theme, columns, options = {}) {
	if (message.kind === "user") {
		const inject = renderInjectedChip(message, theme);
		if (inject !== null) return [inject];
		if (isRuntimeContextRow(message)) return [];
		const content = stripSystemReminders(message.text);
		if (content === "") return [];
		return formatUserMessage({
			content,
			width: columns,
			timestamp: message.time
		}, theme).map((ansi) => ({
			ansi,
			kind: "user"
		}));
	}
	const rows = [];
	if (message.reasoning !== "") rows.push(...formatReasoningBlock({
		text: message.reasoning,
		...options.compact === void 0 ? {} : { compact: options.compact }
	}, theme).map((ansi) => ({
		ansi,
		kind: "assistant"
	})));
	rows.push(...formatMarkdown({
		text: message.text,
		columns
	}, theme).map((ansi) => ({
		ansi,
		kind: "assistant"
	})));
	return rows;
}
/**
* #40：runtime context 快照行判定——harness agent-loop 把动态上下文以
* `user/message` + source `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt',
* form: 'snapshot', sections }` 注入会话日志（deepseek-harness
* packages/core/agent-loop/src/runtime-context.ts）。按 source 判定而非
* 内容正则：措辞变化/非英文环境都稳定。全 unknown 防御读取，形状不符
* 一律 false（回落普通渲染，不抛错）。
* @param message - 转录行（event 为权威事实）。
* @returns 是否 runtime context 快照行。
*/
function isRuntimeContextRow(message) {
	const event = message.event;
	if (event.type !== "user/message") return false;
	const source = event.data?.source;
	return source?.kind === "plugin" && source.form === "snapshot";
}
/** #40：遗留 <system-reminder> 标签文本（历史回放中的旧注入）从显示中剥离。
*  只处理结构化标签（闭合对存在才剥离），不动普通用户文本。 */
function stripSystemReminders(text) {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}
/**
* 渲染一条工具调用（call → result 配对）为卡片行。
* 已结算：presenter 意图分派 diff/terminal 结构化卡（意图缺省回落文本
* 折叠）；进行中（无 result）：保留 formatToolCard 流式态。
* @param tool - TranscriptView.tools 中的一条。
* @param theme - 当前主题。
* @param options - presenter 意图、展开与紧凑选项。
* @returns ANSI 行数组。
*/
function renderToolRows(tool, theme, options = {}) {
	const result = tool.result;
	if (result === void 0) {
		const args = parseToolArguments(tool.arguments);
		return formatToolCard({
			toolName: tool.name,
			content: "",
			...args === void 0 ? {} : { toolInput: args },
			streaming: true,
			...options.expanded === void 0 ? {} : { expanded: options.expanded }
		}, theme).map((ansi) => ({
			ansi,
			kind: "tool"
		}));
	}
	const { content, isError } = toolResultText(result);
	const views = options.resolveViews?.(tool) ?? {};
	return formatToolViewCard({
		toolName: tool.name,
		argumentsRaw: tool.arguments,
		content,
		isError,
		...views.call === void 0 ? {} : { callView: views.call },
		...views.result === void 0 ? {} : { resultView: views.result },
		elapsedMs: Math.max(0, result.time - tool.time),
		...options.expanded === void 0 ? {} : { expanded: options.expanded },
		...options.compact === void 0 ? {} : { compact: options.compact }
	}, theme).map((ansi) => ({
		ansi,
		kind: "tool"
	}));
}
/**
* 渲染整个 transcript 到 scrollback 的完整行序列。
* 消息与工具卡按事件 seq 交错（两个来源各自按 seq 有序，双指针归并）：
* assistant 正文（seq 于 assistant/message）先于其 step 的工具卡
* （seq 于 tool/call）——与 live 提交顺序（文本 → 卡）一致。
* @param view - 当前 transcript 投影。
* @param theme - 当前主题。
* @param columns - 终端列数。
* @param options - presenter 意图解析器与紧凑/展开选项。
* @returns 有序 RenderedRow 数组。
*/
function renderTranscript(view, theme, columns, options = {}) {
	const rows = [];
	const messages = view.messages;
	const tools = view.tools;
	let mi = 0;
	let ti = 0;
	while (mi < messages.length || ti < tools.length) {
		const message = messages[mi];
		const tool = tools[ti];
		if (tool === void 0 || message !== void 0 && message.seq <= tool.seq) {
			/* v8 ignore next -- 循环条件保证两指针至少一个未尽；tool undefined 时 message 必存在 */
			if (message === void 0) break;
			rows.push(...renderMessageRows(message, theme, columns, options));
			mi++;
		} else {
			rows.push(...renderToolRows(tool, theme, options));
			ti++;
		}
	}
	return rows;
}
//#endregion
//#region lib/types/command-palette.js
/** 分组渲染顺序（稳定排序；表外组名追加到尾部）。 */
const PALETTE_GROUP_ORDER = [
	"会话",
	"配置",
	"认证",
	"面板",
	"技能",
	"其他"
];
/**
* 初始面板状态（关闭、空查询、选中第 0 项）。
* @returns 初始状态。
*/
function emptyPaletteState() {
	return {
		open: false,
		query: "",
		selected: 0
	};
}
/**
* SlashCommand → 面板条目（分组取命令注册时携带的 category；未标注归「其他」）。
* @param commands - 注册表命令列表。
* @returns 面板条目（argsHint 缺省时不带该字段；group 恒有值）。
*/
function toPaletteEntries(commands) {
	return commands.map((c) => ({
		name: c.name,
		description: c.description,
		group: c.category ?? "其他",
		...c.argsHint === void 0 ? {} : { argsHint: c.argsHint }
	}));
}
function isSubsequence(query, name) {
	let i = 0;
	for (const ch of name) {
		if (ch === query[i]) i++;
		if (i === query.length) return true;
	}
	return i === query.length;
}
/**
* 模糊过滤：名称/描述子串 + 名称子序列；前缀优先排序；大小写不敏感。
* @param entries - 全部条目。
* @param query - 查询串（trim 后为空则返回全部）。
* @returns 过滤排序后的条目。
*/
function filterPalette(entries, query) {
	const q = query.trim().toLowerCase();
	if (!q) return [...entries];
	const hit = [];
	const tail = [];
	for (const e of entries) {
		const name = e.name.toLowerCase();
		const desc = e.description.toLowerCase();
		if (name.startsWith(q)) hit.push(e);
		else if (name.includes(q) || desc.includes(q) || isSubsequence(q, name)) tail.push(e);
	}
	return [...hit, ...tail];
}
/**
* 过滤后可见条目（selected 指向过滤列表下标）。
* @param state - 面板状态（取 query）。
* @param entries - 全部条目。
* @returns 过滤后条目。
*/
function paletteVisibleEntries(state, entries) {
	return filterPalette(entries, state.query);
}
/**
* 折叠一个事件进入面板状态（纯函数）：open 重置查询与选中、type 追加字符并
* 归零选中、move 在 [0, count-1] 内夹紧移动。
* @param state - 当前状态。
* @param event - 输入事件。
* @returns 新状态。
*/
function applyPaletteEvent(state, event) {
	switch (event.type) {
		case "open": return {
			...state,
			open: true,
			query: "",
			selected: 0
		};
		case "close": return {
			...state,
			open: false
		};
		case "type": return {
			...state,
			query: state.query + event.char,
			selected: 0
		};
		case "backspace": return {
			...state,
			query: state.query.slice(0, -1)
		};
		case "move": {
			const maxIndex = Math.max(0, event.count - 1);
			const next = state.selected + event.delta;
			return {
				...state,
				selected: Math.max(0, Math.min(next, maxIndex))
			};
		}
	}
}
/**
* 回填文本：`/name `（含尾随空格，用户续写参数）。
* @param entry - 选中条目。
* @returns 回填到输入框的文本。
*/
function paletteCommitText(entry) {
	return `/${entry.name} `;
}
/**
* overlay 渲染：头 + 条目（选中 ▶ 高亮、宽度截断）+ 底部键位提示；滚动窗口跟随选中。
* @param state - 面板状态。
* @param entries - 全部条目（内部按 query 过滤）。
* @param width - 可用显示宽度（条目按此截断）。
* @param height - 可用行数（头尾各占一行，其余给条目窗口）。
* @param theme - 主题（取语义色）。
* @returns 渲染行数组（含 ANSI）。
*/
function renderCommandPalette(state, entries, width, height, theme) {
	const visible = filterPalette(entries, state.query);
	const lines = [color("命令面板", theme.brandColor, { bold: true })];
	if (visible.length === 0) lines.push(color("无匹配", theme.muted));
	else {
		const bodyHeight = Math.max(1, height - 2);
		const sel = Math.max(0, Math.min(state.selected, visible.length - 1));
		const rows = [];
		const byGroup = /* @__PURE__ */ new Map();
		for (let i = 0; i < visible.length; i++) {
			const g = visible[i].group ?? "其他";
			const list = byGroup.get(g);
			if (list === void 0) byGroup.set(g, [i]);
			else list.push(i);
		}
		const groups = [];
		for (const g of PALETTE_GROUP_ORDER) if (byGroup.has(g)) groups.push(g);
		for (const g of byGroup.keys()) if (!groups.includes(g)) groups.push(g);
		for (const g of groups) {
			rows.push({
				kind: "header",
				text: g
			});
			for (const i of byGroup.get(g)) rows.push({
				kind: "entry",
				index: i,
				entry: visible[i]
			});
		}
		const selRow = rows.findIndex((r) => r.kind === "entry" && r.index === sel);
		const start = Math.max(0, selRow - bodyHeight + 1);
		for (const row of rows.slice(start, start + bodyHeight)) {
			if (row.kind === "header") {
				lines.push(color(truncate(`── ${row.text} ──`, width), theme.muted));
				continue;
			}
			const isSel = row.index === sel;
			const label = `/${row.entry.name}${row.entry.argsHint !== void 0 ? ` ${row.entry.argsHint}` : ""}`;
			const text = isSel ? `▶ ${label}` : `  ${label}`;
			lines.push(isSel ? color(truncate(text, width), theme.primary, { bold: true }) : color(truncate(text, width), theme.dim));
		}
	}
	lines.push(color("Enter 执行 · Esc 关闭", theme.muted));
	return lines;
}
function truncate(text, width) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > width) break;
		out += ch;
	}
	return out;
}
/** Ctrl+P 面板控制器：open/toggle/type/move/commit，实现 OverlayRenderer 契约。 */
var CommandPalette = class {
	state = emptyPaletteState();
	getCommands;
	getSkills;
	getTheme;
	/** 确认模式：true = execute（Enter 直接执行 `/name`）；false = backfill（回填 `/name `）。 */
	executeMode = false;
	/** Enter commit 结果暂存（handleKey 路径；装配方 takeCommit 取走后清空）。 */
	pendingCommit = null;
	constructor(opts) {
		this.getCommands = opts.getCommands;
		this.getSkills = opts.getSkills;
		this.getTheme = opts.getTheme;
	}
	/**
	* 面板是否打开。
	* @returns 开合状态。
	*/
	isOpen() {
		return this.state.open;
	}
	/**
	* 打开面板（重置查询与选中）。
	* @param execute - true 为 execute 模式（Enter 直接执行 `/name`，Tab 命令菜单用）；
	*                  缺省 false 为 backfill 模式（Ctrl+P 命令面板，回填 `/name `）。
	*/
	open(execute = false) {
		this.executeMode = execute;
		this.state = applyPaletteEvent(this.state, { type: "open" });
	}
	/** 关闭面板（保留查询，下次 open 时重置）。 */
	close() {
		this.state = applyPaletteEvent(this.state, { type: "close" });
	}
	/** 开合切换。 */
	toggle() {
		if (this.state.open) this.close();
		else this.open();
	}
	/**
	* 追加查询字符（选中归零）。
	* @param char - 输入字符。
	*/
	type(char) {
		this.state = applyPaletteEvent(this.state, {
			type: "type",
			char
		});
	}
	/**
	* 移动选中项（在过滤后列表范围内夹紧）。
	* @param delta - 移动量（负上正下）。
	*/
	move(delta) {
		this.state = applyPaletteEvent(this.state, {
			type: "move",
			delta,
			count: this.paletteVisible().length
		});
	}
	/** 当前查询串。 */
	get query() {
		return this.state.query;
	}
	/** 过滤后可见条目（命令 + #39 技能条目；命令现取自 getCommands，技能现取自 getSkills）。 */
	get entries() {
		return this.paletteVisible();
	}
	/** 全部条目：命令（toPaletteEntries）+ 技能（可选数据源，缺省空）。 */
	allEntries() {
		return [...toPaletteEntries(this.getCommands()), ...this.getSkills?.() ?? []];
	}
	/**
	* 过滤后可见条目。
	* @returns 过滤后条目。
	*/
	paletteVisible() {
		return paletteVisibleEntries(this.state, this.allEntries());
	}
	/**
	* 提交选中项：返回条目 + 文本 + 确认模式；无选中返回 null。
	* execute 模式文本为 `/name`（无尾随空格，调用方直接执行）；backfill 模式
	* 为 `/name `（含尾随空格，调用方回填输入框续写参数）。
	* @returns 条目与文本/模式；选中越界（如无匹配）返回 null。
	*/
	commit() {
		const entry = this.paletteVisible()[this.state.selected];
		if (entry === void 0) return null;
		return this.executeMode ? {
			entry,
			text: `/${entry.name}`,
			execute: true
		} : {
			entry,
			text: paletteCommitText(entry),
			execute: false
		};
	}
	/**
	* 键位路由（scroll-pager 范式收敛；装配方只做 deactivate/rerender 与
	* takeCommit 分流）：Esc/Ctrl+C → close（不提交、不回填输入行——真机 A6
	* 修复语义）；Enter → commit 暂存 + close；↑/↓ 移动选中；其余可打印字符
	* 进查询。Backspace 维持吞掉不删（装配方历史路由语义——query 只增不减）。
	* @param name - 按键名。
	* @param char - 可打印字符（控制键为 ''）。
	* @returns close = 请求关闭；handled = 已消费。
	*/
	handleKey(name, char) {
		if (name === "escape" || name === "ctrl_c") {
			this.close();
			return "close";
		}
		if (name === "return") {
			this.pendingCommit = this.commit();
			this.close();
			return "close";
		}
		if (name === "up" || name === "down") {
			this.move(name === "up" ? -1 : 1);
			return "handled";
		}
		if (char !== "") {
			this.type(char);
			return "handled";
		}
		return "handled";
	}
	/**
	* 取走最近一次 Enter 的 commit 结果（无选中时为 null）；取后清空。
	* 装配方据此分流：execute 直接执行 `/name`；backfill 回填 `/name ` 输入框。
	* @returns commit 结果；无（Esc 关闭/无匹配）为 null。
	*/
	takeCommit() {
		const committed = this.pendingCommit;
		this.pendingCommit = null;
		return committed;
	}
	/**
	* OverlayRenderer 契约：render(width, height) → string[]。
	* @param width - 可用显示宽度。
	* @param height - 可用行数。
	* @returns 渲染行数组（含 ANSI）。
	*/
	render(width, height) {
		return renderCommandPalette(this.state, this.allEntries(), width, height, this.getTheme());
	}
};
//#endregion
//#region lib/types/controllers/skill-surface.js
/**
* SkillSurfaceController — #39 用户技能调用展示面（从 ui/app.ts 提取）。
*
* 持有技能快照（ctx.skills.list 经 reflect 读取；服务缺失/reject → 空数组）
* 与 userInvocable 过滤，把「注册表命令 + userInvocable 技能」合并投影为
* slash 菜单数据源（InputController.slashCommands），并记录技能手势 MRU。
*
* 纯展示层边界（ADAPTER.md）：不注册任何注入面——技能调用由 host 的
* tool-skill agent/pre-step 手势完成（消息中 `/name` token → 注入 skill 体），
* 本控制器只负责让技能在输入面可见、提交路由不被误判为未知命令。
*
* 副作用注入（不 import app.ts、不碰渲染）：
* - getService(name)：可选服务读取（ctx.reflect.get，skills 缺失 → undefined）。
* - listCommandHints()：注册表命令的提示条目现取（slash.list().map(toSlashHint)）。
* - setSlashEntries(entries)：合并投影写回（inputController.slashCommands 赋值）。
* - scheduleRender()：快照刷新后的重绘调度（renderBatcher.schedule）。
* - isDisposed()：异步 resolve 竞态守卫（app.dispose 后不再写状态）。
* - recordSlashUse(name)：技能手势 MRU 记录（inputController.recordSlashUse）。
* - onEvent(event, cb)：宿主事件订阅（ctx.on；attach 订阅 / dispose 解绑）。
*
* @module @deepseek-ai/dsh-tianshu-tui/controllers/skill-surface
*/
/** #39：userInvocable 技能 → InputController 提示条目的投影（🧭 标记区分技能与命令）。 */
function toSkillHint(skill) {
	return {
		name: skill.name,
		description: `🧭 ${skill.description}`
	};
}
/** #39：userInvocable 技能 → 命令面板条目（PaletteEntry 形状兼容，🧭 标记，归「技能」组）。 */
function toSkillEntry(skill) {
	return {
		name: skill.name,
		description: `🧭 ${skill.description}`,
		group: "技能"
	};
}
/**
* 技能展示面状态机：快照缓存 + userInvocable 过滤 + slash 菜单投影 + 手势 MRU。
* 生命周期：构造（空快照）→ refresh()（attach / skills/change / /skills 面板）→
* app.dispose 后不再写状态（isDisposed 守卫）。
*/
var SkillSurfaceController = class {
	items = [];
	getService;
	listCommandHints;
	getSessionCwd;
	setSlashEntries;
	scheduleRender;
	isDisposed;
	recordSlashUse;
	onEvent;
	/** skills/change 订阅 disposer（attach 订阅 / dispose 解绑；重复 attach 先解绑旧 disposer）。 */
	eventDisposer = null;
	/** /skills 面板选中下标（↑↓ 详情；刷新后钳制）。 */
	selectedIndex = 0;
	constructor(options) {
		this.getService = options.getService;
		this.listCommandHints = options.listCommandHints;
		this.getSessionCwd = options.getSessionCwd;
		this.setSlashEntries = options.setSlashEntries;
		this.scheduleRender = options.scheduleRender;
		this.isDisposed = options.isDisposed;
		this.recordSlashUse = options.recordSlashUse;
		this.onEvent = options.onEvent;
	}
	/** attach 接线：订阅 skills/change（目录变更 → 刷新）+ 首刷一次（技能在
	*  首次输入前就绪，不再只有 /skills 命令触发）。 */
	attach() {
		this.eventDisposer?.();
		this.eventDisposer = this.onEvent("skills/change", () => {
			this.refresh();
		});
		this.refresh();
	}
	/** dispose 解绑订阅（防止 dispose 后事件回调泄漏）。 */
	dispose() {
		this.eventDisposer?.();
		this.eventDisposer = null;
	}
	/**
	* 刷新技能快照（ctx.skills.list；服务缺失/list reject → 空数组）。
	* resolve 后同步重新投影 slash 菜单条目（#39），并调度重绘。
	*/
	refresh() {
		const skills = this.getService("skills");
		if (skills === void 0) {
			this.items = [];
			this.clampSelected();
			this.refreshEntries();
			return;
		}
		const cwd = this.getSessionCwd?.();
		skills.list(cwd === void 0 ? void 0 : { cwd }).then((items) => {
			/* v8 ignore next -- dispose 后 promise 才 resolve 的场景无法在同步测试中构造 */
			if (this.isDisposed()) return;
			this.items = items;
			this.clampSelected();
			this.refreshEntries();
			this.scheduleRender();
		}).catch(() => {
			/* v8 ignore next -- 同上：dispose 后 reject 的竞态守卫 */
			if (this.isDisposed()) return;
			this.items = [];
			this.clampSelected();
			this.refreshEntries();
		});
	}
	/** 当前选中技能名（空列表 → undefined）。 */
	selectedName() {
		return this.items[this.selectedIndex]?.name;
	}
	/** 移动选中；越界钳制。返回是否变化。 */
	moveSelected(delta) {
		if (this.items.length === 0) return false;
		const next = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		return true;
	}
	clampSelected() {
		if (this.items.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, this.items.length - 1);
	}
	/** 全部技能快照（/skills 浏览面板数据源；空数组 = 无技能或未加载）。 */
	all() {
		return this.items;
	}
	/** userInvocable 技能（slash 菜单/命令面板数据源过滤）。
	*  本地最小谓词（invocation.userInvocable），不运行时 import dsh-skill。 */
	userInvocable() {
		return this.items.filter((s) => s.invocation.userInvocable);
	}
	/** userInvocable 技能 → 命令面板条目（PaletteEntry 形状兼容，🧭 标记）。 */
	paletteEntries() {
		return this.userInvocable().map(toSkillEntry);
	}
	/** 重新投影 slash 提示数据源 = 注册表命令 + userInvocable 技能（🧭 标记）。
	*  调用点：构造、技能快照刷新后、命令注册后。 */
	refreshEntries() {
		this.setSlashEntries([...this.listCommandHints(), ...this.userInvocable().map(toSkillHint)]);
	}
	/** 技能手势 MRU：输入以 / 开头且首 token 命中 userInvocable 技能时记录
	*  （slash 菜单下次打开技能条目排前）。命令优先语义不变——命令名在
	*  runSlash 侧记录；同名/同前缀冲突时命令通道先行，不落到此处。 */
	recordGesture(input) {
		if (!input.startsWith("/")) return;
		const firstToken = input.split(/\s+/)[0]?.slice(1) ?? "";
		if (firstToken === "") return;
		if (this.userInvocable().some((s) => s.name === firstToken)) this.recordSlashUse(firstToken);
	}
};
//#endregion
//#region lib/types/engine/overlay-engine.js
/**
* T9 OverlayEngine — 管理全屏覆盖层的 alternate screen buffer 切换。
*
* 核心机制：
* - 进入 overlay 时：`\x1B[?1049h` 切换到 alternate screen buffer
* - overlay 内：全屏逐行渲染，用 `cursorTo(1,1)` 定位到顶部
* - 退出 overlay 时：`\x1B[?1049l` 恢复主屏，scrollback 完整无损
*
* Surface 路由逻辑复用现有的 `src/tui/surface/router.ts`（纯逻辑，零依赖）。
* OverlayEngine 只负责终端 buffer 切换和渲染调度。
*
* 支持的 overlay 类型（对应现有 Surface）：
* - Starmap (星图) — 星君/星域总览
* - Cockpit (座舱) — 运行时状态仪表盘
* - Chronicle (编年史) — 会话回放
* - Pager — 分页查看器
* - CommandPalette — 命令面板
*/
/**
* 全屏覆盖层引擎：管理 alternate screen buffer 的进出与 overlay 渲染调度
* （固定网格行级 diff + CSI 2026 原子刷新）。退出后主屏 scrollback 完整无损。
*/
var OverlayEngine = class {
	stdout;
	getSize;
	onEnterAltScreen;
	onExitAltScreen;
	active = null;
	renderers = /* @__PURE__ */ new Map();
	inAltScreen = false;
	/** 上一帧屏上每行内容（权威缓存），用于行级 diff。空 = 需全量重绘。 */
	lastFrame = [];
	lastCols = 0;
	lastRows = 0;
	constructor(options) {
		this.stdout = options.stdout;
		this.getSize = options.getSize;
		if (options.onEnterAltScreen !== void 0) this.onEnterAltScreen = options.onEnterAltScreen;
		if (options.onExitAltScreen !== void 0) this.onExitAltScreen = options.onExitAltScreen;
	}
	/**
	* 注册一个 overlay 渲染器。
	* 通常在模块初始化时调用。
	* @param id - overlay 标识（同名注册覆盖旧渲染器）
	* @param renderer - 该 overlay 的渲染器
	*/
	register(id, renderer) {
		this.renderers.set(id, renderer);
	}
	/**
	* 取消注册；若该 overlay 正活跃，先停用（退出 alt screen）。
	* @param id - 要移除的 overlay 标识
	*/
	unregister(id) {
		if (this.active === id) this.deactivate();
		this.renderers.delete(id);
	}
	/**
	* 激活指定 overlay。
	* - 如果已有活跃 overlay，先停用旧的再激活新的（切换不退出 alt screen）。
	* - 自动进入 alternate screen buffer。
	* @param id - 要激活的 overlay 标识
	* @returns 激活成功为 true；id 未注册时为 false（不改变当前状态）
	*/
	activate(id) {
		const renderer = this.renderers.get(id);
		if (!renderer) return false;
		if (this.active !== null) {
			this.renderers.get(this.active)?.onDeactivate?.();
			this.active = null;
			this.resetFrameCache();
		}
		this.active = id;
		this.enterAltScreen();
		this.resetFrameCache();
		renderer.onActivate?.();
		this.render();
		return true;
	}
	/** 停用当前活跃的 overlay，恢复主屏。 */
	deactivate() {
		if (this.active === null) return;
		this.deactivateInternal();
	}
	/** 重新渲染当前 overlay（如 resize 后）。 */
	rerender() {
		if (this.active === null) return;
		this.render();
	}
	/**
	* 当前是否在 overlay 中。
	* @returns 有活跃 overlay 时为 true
	*/
	isActive() {
		return this.active !== null;
	}
	/**
	* 当前活跃的 overlay ID。
	* @returns 活跃 overlay 标识；无活跃 overlay 时为 null
	*/
	activeId() {
		return this.active;
	}
	enterAltScreen() {
		if (this.inAltScreen) return;
		this.stdout.write(ANSI.ALT_SCREEN_ON);
		this.stdout.write(ANSI.HIDE_CURSOR);
		this.inAltScreen = true;
		this.onEnterAltScreen?.();
	}
	exitAltScreen() {
		if (!this.inAltScreen) return;
		this.stdout.write(ANSI.CURSOR_SHAPE_DEFAULT);
		this.stdout.write(ANSI.SHOW_CURSOR);
		this.stdout.write(ANSI.ALT_SCREEN_OFF);
		this.inAltScreen = false;
		this.onExitAltScreen?.();
	}
	deactivateInternal() {
		const id = this.active;
		if (id === null) return;
		this.renderers.get(id)?.onDeactivate?.();
		this.active = null;
		this.resetFrameCache();
		this.exitAltScreen();
	}
	resetFrameCache() {
		this.lastFrame = [];
		this.lastCols = 0;
		this.lastRows = 0;
	}
	render() {
		const activeId = this.active;
		if (activeId === null) return;
		const renderer = this.renderers.get(activeId);
		if (!renderer) return;
		const { cols, rows } = this.getSize();
		const lines = renderer.render(cols, rows);
		const desired = new Array(rows);
		for (let i = 0; i < rows; i++) {
			const line = lines[i];
			desired[i] = i < lines.length && line !== void 0 ? line : "";
		}
		const cacheValid = this.lastFrame.length === rows && cols === this.lastCols && rows === this.lastRows;
		let body;
		if (!cacheValid) {
			let out = cursorTo(1, 1);
			for (let i = 0; i < rows; i++) {
				out += ANSI.ERASE_LINE + (desired[i] ?? "");
				if (i < rows - 1) out += "\n";
			}
			body = out;
		} else {
			let out = "";
			for (let i = 0; i < rows; i++) {
				if (desired[i] === this.lastFrame[i]) continue;
				out += cursorTo(i + 1, 1) + ANSI.ERASE_LINE + (desired[i] ?? "");
			}
			body = out;
		}
		this.lastFrame = desired;
		this.lastCols = cols;
		this.lastRows = rows;
		const caretPos = renderer.caret ? renderer.caret(cols, rows) : void 0;
		if (body.length === 0 && caretPos === void 0) return;
		if (body.length > 0) this.stdout.write(ANSI.BEGIN_SYNC + body + ANSI.END_SYNC);
		if (caretPos !== void 0) this.stdout.write(caretPos ? cursorTo(caretPos.row, caretPos.col) + ANSI.CURSOR_STEADY_BAR + ANSI.SHOW_CURSOR : ANSI.HIDE_CURSOR);
	}
};
//#endregion
//#region lib/types/engine/overlay-controller.js
/**
* OverlayController — overlay 生命周期 + CPR suppress/resume 协调。
*
* 直通 OverlayEngine 的 register/unregister/activate/deactivate/rerender；
* 在进入/退出 alt screen 时自动调用 LiveEngine 的 suppressProbe()/resumeProbe()，
* 把「overlay 激活期间暂停主屏污染检测」这一协调固化在装配点，调用方不会忘记。
* 不暂停则 CPR 探针会把「光标在 overlay 里」误判为主屏污染，触发 renderLive
* 把主屏帧写进 alt screen（picker 残影泄漏回主会话的根因）。
*
* 无 overlay 注册时零输出，不改变主屏行为——只是把未来 overlay 的生命周期
* 与 CPR 协调收敛到单一装配点。
*
* @module @deepseek-ai/dsh-tianshu-tui/engine/overlay-controller
*/
/**
* overlay 生命周期协调器：直通 OverlayEngine，并在进入/退出 alt screen 时
* 自动暂停/恢复 LiveEngine 的 CPR 污染检测（防主屏帧写进 alt screen）。
*/
var OverlayController = class {
	engine;
	constructor(options) {
		this.engine = new OverlayEngine({
			stdout: options.stdout,
			getSize: options.getSize,
			onEnterAltScreen: () => {
				options.live.suppressProbe();
				options.onOverlayChange?.(true);
			},
			onExitAltScreen: () => {
				options.live.resumeProbe();
				options.onOverlayChange?.(false);
			}
		});
	}
	/**
	* 注册一个 overlay 渲染器（通常模块初始化时调用）。
	* @param id - overlay 标识
	* @param renderer - 该 overlay 的渲染器
	*/
	register(id, renderer) {
		this.engine.register(id, renderer);
	}
	/**
	* 取消注册；若该 overlay 正活跃，先停用。
	* @param id - 要移除的 overlay 标识
	*/
	unregister(id) {
		this.engine.unregister(id);
	}
	/**
	* 激活指定 overlay（自动进入 alt screen 并暂停主屏污染检测）。
	* @param id - 要激活的 overlay 标识
	* @returns 激活成功为 true；id 未注册时为 false
	*/
	activate(id) {
		return this.engine.activate(id);
	}
	/** 停用当前活跃 overlay，恢复主屏并恢复污染检测。 */
	deactivate() {
		this.engine.deactivate();
	}
	/** 重新渲染当前 overlay（如 resize 后）。 */
	rerender() {
		this.engine.rerender();
	}
	/**
	* 当前是否在 overlay 中。
	* @returns 有活跃 overlay 时为 true
	*/
	isActive() {
		return this.engine.isActive();
	}
	/**
	* 当前活跃的 overlay ID。
	* @returns 活跃 overlay 标识；无活跃 overlay 时为 null
	*/
	activeId() {
		return this.engine.activeId();
	}
};
//#endregion
//#region lib/types/engine/metrics-glance-controller.js
/**
* MetricsGlanceController — 底部 glance 数据收集与刷新节流（Phase 5.3 数据基础）。
*
* 把 ui/app.ts 原先内联在 renderLive 里的状态行回退派生与错误行格式化收敛为
* 纯函数（deriveGlanceStatus / deriveGlanceError / deriveGlance），控制器把它们
* 包进「窗口内合并、窗口末重算」的节流。数据全部来自既有 LiveAgentState 与
* statusLine 投影，不发明事件类型。
*
* 节流语义：
* - 首次 refresh 恒同步重算（构造后立即可读，不依赖时钟）。
* - 窗口内（throttleMs，默认 16ms 一帧）重复 refresh 合并到窗口末重算一次；
*   窗口外 refresh 同步重算。重收集成本被节流封顶，状态行/错误行新鲜度 ≤ 一帧。
* - 数据实际变化时经 onChange 推送（未变化不推送，避免重绘风暴）。
*
* @module @deepseek-ai/dsh-tianshu-tui/engine/metrics-glance-controller
*/
/**
* 状态行派生：工作流投影优先，否则 agent 状态回退（复刻 TuiApp 旧装配）。
* running 回退为轮换动词（verbForElapsed 按 elapsed 时间片取词；elapsed 缺省
* 0 = 池首「思考中」）。空闲态返回 null（不渲染不占位）：空闲提示已由 footer
* 承载，状态行只在「有事发生」（运行中/已停止/投影文本）时出现。
* @param statusText - WorkflowStatusLine.current；null = 无投影。
* @param live - live agent 状态；undefined = 未挂载。
* @param elapsedMs - 当前回合已耗时（毫秒；动词轮换时间片数据源）。
* @returns 状态行纯文本；空闲 null。
*/
function deriveGlanceStatus(statusText, live, elapsedMs = 0) {
	if (statusText !== null) return statusText;
	if (live === void 0 || live.live) return live?.status === "running" ? `● ${verbForElapsed(elapsedMs, DEFAULT_SPINNER_VERBS)}` : null;
	return "✗ 已停止";
}
/**
* 错误行派生：glyph（ascii 降级）+ 首行截断至 cols-2（复刻 TuiApp 旧装配）。
* @param live - live agent 状态；无 lastError 或未挂载时返回 null。
* @param columns - 终端列数。
* @returns 错误行纯文本；无错误 null。
*/
function deriveGlanceError(live, columns) {
	if (live?.lastError === void 0) return null;
	const raw = live.lastError.error;
	const message = raw instanceof Error ? raw.message : String(raw);
	return `${useAsciiGlyphs() ? "x" : "✗"} ${truncateToDisplayWidth(message.split("\n")[0] ?? "", columns - 2)}`;
}
/**
* 完整错误文本派生（多行、不截断）：scrollback 落底数据源。Error 实例取
* message，其余 String 化——与 {@link deriveGlanceError} 同一归一口径。
* @param live - live agent 状态；无 lastError 或未挂载时返回 null。
* @returns 完整错误文本；无错误 null。
*/
function deriveGlanceErrorFull(live) {
	if (live?.lastError === void 0) return null;
	const raw = live.lastError.error;
	return raw instanceof Error ? raw.message : String(raw);
}
/**
* 整帧 glance 派生（状态行 + 错误行 + 完整错误文本一次计算）。
* @param statusText - WorkflowStatusLine.current；null = 无投影
* @param live - live agent 状态；undefined = 未挂载
* @param columns - 终端列数（错误首行截断度量）
* @param elapsedMs - 当前回合已耗时（毫秒；running 回退的动词轮换数据源）
* @returns 状态行 + 错误行数据
*/
function deriveGlance(statusText, live, columns, elapsedMs = 0) {
	return {
		status: deriveGlanceStatus(statusText, live, elapsedMs),
		error: deriveGlanceError(live, columns),
		errorFull: deriveGlanceErrorFull(live)
	};
}
/**
* 底部 glance 数据收集 + 刷新节流控制器。
* renderLive 每帧调用 refresh() 后读 current()：窗口内读缓存（零重收集），
* 窗口外同步重算——收集成本与渲染节奏解耦。
*/
var MetricsGlanceController = class {
	cache;
	computed = false;
	lastComputeAt = 0;
	/** idle→running 跃迁观测时间（running 回退动词轮换的 elapsed 数据源；非 running 复位）。 */
	runningSince = null;
	timer = null;
	throttleMs;
	options;
	constructor(options) {
		this.options = options;
		this.throttleMs = options.throttleMs ?? 16;
		this.cache = deriveGlance(null, void 0, 80);
	}
	/**
	* 当前缓存的 glance 数据（renderLive 每帧读取；新鲜度 ≤ 节流窗口）。
	* @returns 最近一次重算的 glance 数据
	*/
	current() {
		return this.cache;
	}
	/**
	* 请求刷新。首次恒同步重算；此后窗口内合并到窗口末、窗口外同步重算。
	* 数据实际变化时经 onChange 推送。
	*/
	refresh() {
		if (this.timer !== null) return;
		if (!this.computed) {
			this.compute();
			return;
		}
		const wait = this.throttleMs - (Date.now() - this.lastComputeAt);
		if (wait <= 0) {
			this.compute();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.compute();
		}, wait);
		this.timer.unref();
	}
	/** 清空待执行定时器（幂等）。 */
	dispose() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
	compute() {
		this.lastComputeAt = Date.now();
		const first = !this.computed;
		const live = this.options.getLiveState();
		if (live?.status === "running") {
			if (this.runningSince === null) this.runningSince = this.lastComputeAt;
		} else this.runningSince = null;
		const next = deriveGlance(this.options.getStatusText(), live, this.options.getColumns(), this.runningSince === null ? 0 : this.lastComputeAt - this.runningSince);
		const changed = first || next.status !== this.cache.status || next.error !== this.cache.error || next.errorFull !== this.cache.errorFull;
		this.cache = next;
		this.computed = true;
		if (changed) this.options.onChange?.(next);
	}
};
function asString(value) {
	return typeof value === "string" ? value : null;
}
/** bash 类工具名（command 参数为 shell 命令串；已核 dsh-tool-bash 实为 'bash'）。 */
const SHELL_TOOL_NAMES = /* @__PURE__ */ new Set(["bash"]);
/** 是否 bash 类工具（p 键前缀与命令预览只对这类工具启用）。 */
function isShellTool(toolName) {
	return SHELL_TOOL_NAMES.has(toolName);
}
/**
* 原始参数 JSON → command 字段（非 bash 类工具/解析失败/非串/空串 → null）。
* @param toolName - 工具名（transcript tool.name）。
* @param argumentsJson - 原始参数 JSON 字符串。
*/
function extractShellCommand(toolName, argumentsJson) {
	if (!isShellTool(toolName)) return null;
	let parsed;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const command = asString(parsed.command);
	if (command === null || command.trim() === "") return null;
	return command;
}
/** shell 命令 → 首 token 前缀（`npm test` → `npm`；`git status` → `git`；空串 → null）。 */
function commandPrefixOf(command) {
	const first = command.trim().split(/\s+/)[0];
	return first === void 0 || first === "" ? null : first;
}
/**
* 审批请求 → transcript 里的工具调用（callId 关联；无 callId/找不到 → undefined）。
* @param req - 待决审批请求。
* @param view - 当前会话 transcript 投影（未 attach 时 undefined）。
*/
function findApprovalToolCall(req, view) {
	const callId = req.callId;
	if (callId === void 0) return void 0;
	return view?.tools.findLast((t) => t.callId === callId);
}
/**
* 审批请求 → 命令前缀（controller 短路/p 键守卫注入用）：callId 查 transcript →
* command 首 token；非 bash 类/查不到/解析失败 → null。
*/
function commandPrefixForRequest(req, view) {
	const toolCall = findApprovalToolCall(req, view);
	if (toolCall === void 0) return null;
	const command = extractShellCommand(toolCall.name, toolCall.arguments);
	return command === null ? null : commandPrefixOf(command);
}
/** 危险命令模式（审批卡标注用——只展示警示，不拦截）。 */
const DANGER_PATTERNS = [
	{
		pattern: /\brm\s+(?:-\w+\s+)*-\w*[rR]\w*/,
		label: "rm 递归删除"
	},
	{
		pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
		label: "远程脚本管道执行"
	},
	{
		pattern: /\(\s*\)\s*\{\s*:\|:&\s*\}/,
		label: "fork 炸弹"
	},
	{
		pattern: /\bmkfs(?:\.\w+)?\b/,
		label: "文件系统格式化"
	},
	{
		pattern: /\bdd\b[^|&;]*\bof=\/dev\//,
		label: "dd 覆写块设备"
	}
];
/**
* 标注命令中的危险模式（命中标签数组，无命中空数组）。展示层警示，不改变审批语义。
* @param command - shell 命令串。
*/
function detectDangerPatterns(command) {
	return DANGER_PATTERNS.filter((d) => d.pattern.test(command)).map((d) => d.label);
}
/** bash 类预览：`$ 命令首行` + 危险模式标注行（有多行命令时省略微标）。 */
function formatCommandPreview(command, theme) {
	const trimmed = command.trim();
	const firstLine = trimmed.split("\n")[0] ?? "";
	const more = trimmed.includes("\n") ? " …" : "";
	const lines = [color(`$ ${truncateToDisplayWidth(firstLine, 72)}${more}`, theme.warning)];
	const dangers = detectDangerPatterns(command);
	if (dangers.length > 0) lines.push(color(`⚠ 危险模式：${dangers.join(" · ")}`, theme.error));
	return lines;
}
/**
* 从编辑类工具参数提取 old/new 文本对。
* str_replace_editor 的 str_replace 用 old_str/new_str；edit_file 用
* old_string/new_string（宿主侧工具，兼容提取）。
*/
function extractReplacePair(args) {
	return {
		path: asString(args.path),
		oldText: asString(args.old_str) ?? asString(args.old_string),
		newText: asString(args.new_str) ?? asString(args.new_string)
	};
}
/** write 类预览：path + 前 N 行内容（create/write_file）。 */
function formatWritePreview(path, content, theme) {
	const head = content.split("\n").slice(0, 4);
	const lines = [`${path} 新文件内容预览:`];
	for (const line of head) lines.push(`  ${line}`);
	if (content.split("\n").length > 4) {
		const muted = theme.muted;
		lines.push(muted === void 0 ? "  …" : `  …（共 ${content.split("\n").length} 行）`);
	}
	return lines;
}
/** old/new 替换对 → 路径统计头 + renderFileDiff 行（结算卡同一渲染）。 */
function formatReplaceDiff(path, oldText, newText, theme) {
	const diff = {
		path,
		oldText,
		newText
	};
	const { adds, dels } = fileDiffStats([diff]);
	return [color(`${path} (+${adds} −${dels})`, theme.warning), ...renderFileDiff(diff, { maxLines: 12 }, theme)];
}
/**
* 格式化审批 diff 为 ANSI 行数组；非编辑/非 bash 类工具或参数不可解析返回 null。
* - str_replace_editor str_replace / edit_file：old/new → renderFileDiff
*   （±3 context，与结算工具卡共用渲染——所批即所见）
* - str_replace_editor create / write_file：path + 前 4 行预览（无 old）
* - bash 类工具：`$ 命令首行` 预览 + 危险模式标注（只展示警示不拦截）
* - 其他工具：null（无替换/命令语义不渲染）
* @param input - 待审批工具调用的名与原始参数 JSON。
* @param theme - 当前主题（diff 染色透传 renderFileDiff）。
* @returns diff/预览的 ANSI 行数组；不可渲染时 null（调用方不占位）。
*/
function formatPermissionDiff(input, theme) {
	if (isShellTool(input.toolName)) {
		const command = extractShellCommand(input.toolName, input.arguments);
		return command === null ? null : formatCommandPreview(command, theme);
	}
	let parsed;
	try {
		parsed = JSON.parse(input.arguments);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const args = parsed;
	if (input.toolName === "str_replace_editor") {
		if (args.command === "str_replace") {
			const { path, oldText, newText } = extractReplacePair(args);
			if (path === null || oldText === null || newText === null) return null;
			if (oldText === newText) return null;
			return formatReplaceDiff(path, oldText, newText, theme);
		}
		if (args.command === "create") {
			const path = asString(args.path);
			const content = asString(args.file_text);
			if (path === null || content === null) return null;
			return formatWritePreview(path, content, theme);
		}
		return null;
	}
	if (input.toolName === "write_file") {
		const path = asString(args.path);
		const content = asString(args.content) ?? asString(args.file_text);
		if (path === null || content === null) return null;
		return formatWritePreview(path, content, theme);
	}
	if (input.toolName === "edit_file") {
		const { path, oldText, newText } = extractReplacePair(args);
		if (path === null || oldText === null || newText === null) return null;
		if (oldText === newText) return null;
		return formatReplaceDiff(path, oldText, newText, theme);
	}
	return null;
}
//#endregion
//#region lib/types/box-chars.js
/**
* 线框字符集与框体几何 —— 输入框、首屏欢迎框等「圆角盒」的单一事实源。
*
* 拆出来的原因是**等宽契约**：首屏欢迎框必须与输入框逐列咬合（左右边线同列、
* 总宽相同），否则两个框上下叠在一起时会错位。宽度公式若在 app.ts 与
* welcome.ts 各写一份，改其中一处就会静默破坏对齐——放这里共享。
*/
/**
* 输入框线框字符集（按 separator 主题）。纯字面量，提升到模块级避免 renderLive
* 每帧重建对象字面量。getInputChrome 据此缓存着色后的 leftBar/rightBar/botBorder。
*/
const INPUT_BOX_CHARS = {
	thin: {
		tl: "╭",
		tr: "╮",
		bl: "╰",
		br: "╯",
		h: "─",
		v: "│",
		m: "┬"
	},
	thick: {
		tl: "┏",
		tr: "┓",
		bl: "┗",
		br: "┛",
		h: "━",
		v: "┃",
		m: "┳"
	},
	dots: {
		tl: "╭",
		tr: "╮",
		bl: "╰",
		br: "╯",
		h: "┄",
		v: "┊",
		m: "┬"
	},
	/** Kimi Code 风格：圆角 thin 字面 + 顶框内嵌模型名标签。字面量与 thin 一致。 */
	kimi: {
		tl: "╭",
		tr: "╮",
		bl: "╰",
		br: "╯",
		h: "─",
		v: "│",
		m: "┬"
	},
	/**
	* legacy conhost 降级档：GBK 点阵字体把框线字符按 2 列渲染（或缺字形出
	* tofu），边框行实际宽度超过 cols → 折行 → LiveEngine 回顶欠擦 → 输入框
	* 逐帧重影。ASCII 字符宽度确定为 1 列，任何字体/代码页下都不折行。
	*/
	ascii: {
		tl: "+",
		tr: "+",
		bl: "+",
		br: "+",
		h: "-",
		v: "|",
		m: "+"
	}
};
/**
* 按 separator 取线框字符集，未知 separator 回退到 thin。返回值确定非空。
* legacy conhost（useAsciiBorders）下无条件走 ascii 档——该开关进程内恒定
* （term-caps 缓存），getInputChrome 的 memo key 无需包含它。
* @param separator - separator 主题名（thin/thick/dots/kimi）。
* @returns 对应的线框字符集；未知名回退 thin，ASCII 降级档优先。
*/
function boxCharsFor(separator) {
	if (useAsciiBorders()) return INPUT_BOX_CHARS.ascii;
	switch (separator) {
		case "thick": return INPUT_BOX_CHARS.thick;
		case "dots": return INPUT_BOX_CHARS.dots;
		case "kimi": return INPUT_BOX_CHARS.kimi;
		default: return INPUT_BOX_CHARS.thin;
	}
}
/**
* 框内内容区宽度（不含 `│ ` 与 ` │`）。首屏欢迎框与输入框共用，保证等宽。
*
* 硬约束：框体外宽 = inner + 4（`│ ` + inner + ` │`）必须 ≤ columns，否则
* 右边线折到下一行。故 inner 上限 = columns - 4。
*
* - columns >= 26：`columns - 6`（在上限内再留 2 列呼吸）—— 正常终端。
*   单调性约束：不因切入呼吸档而低于 columns=25 时的宽度（21），26–27 列为
*   平台期，28 列起恢复呼吸增长。
* - columns < 26：`columns - 4`（框体顶满，外宽 = columns，贴右边界不超出）
* - 下限 0：columns < 4 时框体无法成立，返回 0 让上层降级（极罕见）
*
* 此前固定下限 20 会让 < 26 列终端的框体外宽(24)超出边界、右边线折行。
* @param columns - 终端列数。
* @returns 内容区宽度（列），下限 0，随列数单调不减。
*/
function boxInnerWidth(columns) {
	if (columns >= 26) return Math.max(21, columns - 6);
	return Math.max(0, columns - 4);
}
/**
* 框体外宽（含左右边线）。顶/底框 = tl + h×(inner+2) + tr，
* 内容行 = `│ ` + inner + ` │`，两者恒等于 inner + 4。
* @param columns - 终端列数。
* @returns 框体外宽（列），恒为 boxInnerWidth(columns) + 4。
*/
function boxOuterWidth(columns) {
	return boxInnerWidth(columns) + 4;
}
//#endregion
//#region lib/types/format/approval-card.js
/**
* 审批卡（format/approval-card.ts）— 纯渲染。
*
* 形态对齐输入轨：上下圆角横线、左右不封。标题嵌在顶轨，diff 体在中间，
* 底行是键位提示。键位行由动作表投影段动态生成（approvalKeyHintLine：
* 'y 允许' → '[y] 允许'，p 段仅在前缀可提时出现）；f 键反馈输入态时
* 键位行下追加反馈提示行。小窗口 compact 只保留提示行（diff 仍由
* formatPermissionDiff 产出，调用方决定是否传入）。
*/
/**
* 键位提示段 → 审批卡键位行：首 token 加方括号（'y 允许' → '[y] 允许'）。
* 段来源是 approval 域动作的 footerHint 投影（actions/projections；footer 同源）。
* @param segments - 投影提示段（注册序即决策梯度序）。
*/
function approvalKeyHintLine(segments) {
	return segments.map((seg) => {
		const space = seg.indexOf(" ");
		return space === -1 ? `[${seg}]` : `[${seg.slice(0, space)}] ${seg.slice(space + 1)}`;
	}).join(" ");
}
/** 键位行缺省提示段（调用方未投影动作表时的兜底；与 approval 域动作 footerHint 同源对齐）。 */
const DEFAULT_KEY_HINT_SEGMENTS = [
	"y 允许",
	"t 记住此工具",
	"a 全放行",
	"n 拒绝",
	"f 拒绝并说明",
	"esc 取消"
];
/**
* 圆角轨包裹一块 live 内容（审批卡 / 提问卡共用）。
* @param columns - 外宽。
* @param title - 顶轨内嵌标题（纯文本）。
* @param body - 已着色的内容行。
* @param borderColor - 轨线颜色。
* @returns 顶轨 + body + 底轨；columns < 4 时仅 body。
*/
function formatRailsBlock(columns, title, body, borderColor) {
	if (columns < 4) {
		const cap = Math.max(1, columns);
		return body.map((line) => truncateToDisplayWidth(line, cap));
	}
	const chars = boxCharsFor("thin");
	const inner = Math.max(0, columns - 2);
	const maxLabel = Math.max(1, inner - 3);
	const label = title === "" ? "" : ` ${truncateToDisplayWidth(title, maxLabel)} `;
	const fill = Math.max(0, inner - 1 - displayWidth(label));
	const top = color(`${chars.tl}${chars.h}${label}${chars.h.repeat(fill)}${chars.tr}`, borderColor);
	const bottom = color(`${chars.bl}${chars.h.repeat(inner)}${chars.br}`, borderColor);
	return [
		top,
		...body.map((line) => truncateToDisplayWidth(line, columns)),
		bottom
	];
}
/**
* 渲染审批卡：顶轨「审批 · 工具名」+ 提示/diff + 键位 + 底轨。
* @param input - 列数、工具名、可选原因/diff/键位段/反馈态、是否紧凑。
* @param theme - 当前主题（轨线与提示用 warning）。
* @returns ANSI 行数组；columns ≤ 0 返回空数组。
*/
function formatApprovalCard(input, theme) {
	if (input.columns <= 0) return [];
	const why = input.reason === void 0 || input.reason === "" ? "" : `（${input.reason}）`;
	const diff = input.diffLines;
	const hasDiff = diff !== void 0 && diff !== null && diff.length > 0;
	const blind = hasDiff ? "" : "（diff 不可见）";
	const prompt = color(`⚠ 允许执行 ${input.toolName}？${why}${blind}`, theme.warning);
	const hints = color(approvalKeyHintLine(input.keyHintSegments ?? DEFAULT_KEY_HINT_SEGMENTS), theme.muted);
	const body = [prompt];
	if (hasDiff && input.compact !== true) for (const line of diff) body.push(line);
	body.push(hints);
	if (input.feedback === true) body.push(color("📝 说明拒绝原因（Enter 提交反馈 / Esc 返回选项）", theme.muted));
	return formatRailsBlock(input.columns, `审批 · ${input.toolName}`, body, theme.warning);
}
//#endregion
//#region lib/types/format/highlight.js
/**
* highlight — 搜索命中子串高亮（A2，#55 同族细节）。
*
* ANSI 感知：转义序列不参与匹配（查询词不会命中 SGR 码内部），命中位置经
* plain 投影映射回原始串后原位包裹——/scroll 等含 ANSI 的行原样保留转义。
* 大小写口径由调用方传（与搜索本身的 smart-case 一致）。
*
* @module @huiliyi37/dsh-tianshu-tui/highlight
*/
/** 转义序列正则：CSI 或 OSC（BEL/ST 双终结）。 */
const ESC_RE = /(\x1B\[[0-9;?]*[a-zA-Z]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\))/;
/** smart-case 口径：查询含大写 → 精确匹配（搜索与高亮共用同一判定）。 */
function isSmartCaseSensitive(query) {
	return /[A-Z]/.test(query);
}
/**
* 在 line 中找出 query 的全部出现并原位包裹。
* query 为空或无命中时原样返回；line 可含 ANSI（转义段零宽跳过、不参与匹配）。
*/
function highlightQuery(line, query, opts) {
	if (query === "") return line;
	const sensitive = opts.sensitive === true;
	const plainToRaw = [];
	let plain = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1B") {
			const m = ESC_RE.exec(line.slice(i));
			if (m !== null) {
				i += m[1].length;
				continue;
			}
		}
		plainToRaw[plain.length] = i;
		plain += line[i];
		i += 1;
	}
	const hay = sensitive ? plain : plain.toLowerCase();
	const needle = sensitive ? query : query.toLowerCase();
	if (needle === "") return line;
	const pieces = [];
	let plainPos = 0;
	let rawPos = 0;
	while (true) {
		const hit = hay.indexOf(needle, plainPos);
		if (hit === -1) break;
		const startRaw = plainToRaw[hit] ?? line.length;
		const endPlain = hit + needle.length;
		const endRaw = endPlain >= plainToRaw.length ? line.length : plainToRaw[endPlain] ?? line.length;
		pieces.push(line.slice(rawPos, startRaw), opts.wrap(line.slice(startRaw, endRaw)));
		rawPos = endRaw;
		plainPos = endPlain;
	}
	pieces.push(line.slice(rawPos));
	return pieces.join("");
}
//#endregion
//#region lib/types/format/history-search-overlay.js
/**
* C2 项 2：历史搜索 overlay — 全屏 alt-screen 内 smart-case 搜索对话历史。
*
* 设计决策（C2 文档）：
* - 不引入 Worker（DSH 单会话规模小，主线程同步搜索够）
* - 数据源：transcript.view.messages（adapter 事件投影，消费 text 字段）
* - smart-case：查询含大写 → 精确匹配；否则大小写不敏感
* - 输入实时搜索（type 即重算），n/N 循环跳转，Esc 退出
*
* 两阶段输入（#55）：编辑段（默认）所有可打印字符——含 n/N/p/P——都进 query
* （此前 n/N 被跳转快捷键劫持，搜索词打不出这两个字母）；Enter 确认查询后进入
* 跳转段（n/N 下一个、p/P 上一个、Enter 回编辑段、可打印字符回编辑段续输）。
* 搜索对象是会话历史（scrollback 消息快照），搜索栏文案显式标注防误解。
*/
/** smart-case：查询含大写字母 → 精确匹配；否则不敏感（高亮共用 highlight 模块口径）。 */
const hasUpper = isSmartCaseSensitive;
/** 历史搜索 overlay：smart-case 子串搜索对话历史，两阶段输入（编辑/跳转，见模块注释）。 */
var HistorySearchOverlay = class {
	query = "";
	matches = [];
	current = 0;
	messages = [];
	/** 跳转段（Enter 确认查询后）：n/N/p/P 循环跳匹配；false = 编辑段（全字符进 query）。 */
	jumping = false;
	theme;
	constructor(theme) {
		this.theme = theme ?? getTheme();
	}
	/** 当前是否处于跳转段（Enter 确认后）。 */
	isJumping() {
		return this.jumping;
	}
	/**
	* 装配方提供消息快照（transcript.view.messages）；重复设置重算搜索。
	* @param messages - 可搜索的消息快照。
	*/
	setMessages(messages) {
		this.messages = messages;
		this.research();
	}
	/**
	* 输入字符：累积进 query 并实时搜索。
	* @param char - 追加到 query 的可打印字符。
	*/
	type(char) {
		this.query += char;
		this.research();
	}
	/** 退格：删末字符并重算。 */
	backspace() {
		this.query = this.query.slice(0, -1);
		this.research();
	}
	/** 清空查询（overlay 关闭时调用）。 */
	clear() {
		this.query = "";
		this.matches = [];
		this.current = 0;
		this.jumping = false;
	}
	/** 下一个匹配（循环）。 */
	goNext() {
		if (this.matches.length === 0) return;
		this.current = (this.current + 1) % this.matches.length;
	}
	/** 上一个匹配（循环）。 */
	goPrev() {
		if (this.matches.length === 0) return;
		this.current = (this.current - 1 + this.matches.length) % this.matches.length;
	}
	/**
	* 当前匹配数。
	* @returns 命中的消息条数。
	*/
	matchCount() {
		return this.matches.length;
	}
	/**
	* 当前匹配的消息索引；无匹配返回 -1。
	* @returns messages 数组下标，或 -1。
	*/
	currentIndex() {
		/* v8 ignore next -- current 经 % matches.length 归一化恒在界内（goNext/goPrev），索引必有值 */
		return this.matches.length === 0 ? -1 : this.matches[this.current] ?? -1;
	}
	research() {
		this.current = 0;
		if (this.query === "") {
			this.matches = [];
			return;
		}
		const sensitive = hasUpper(this.query);
		const q = sensitive ? this.query : this.query.toLowerCase();
		this.matches = [];
		for (let i = 0; i < this.messages.length; i++) {
			const message = this.messages[i];
			/* v8 ignore next -- 数组元素由装配方构造，无 undefined；noUncheckedIndexedAccess 防御 */
			if (message === void 0) continue;
			if ((sensitive ? message.text : message.text.toLowerCase()).includes(q)) this.matches.push(i);
		}
	}
	/**
	* 键位路由（scroll-pager 范式收敛），两阶段（#55）：
	* - 编辑段（默认）：Backspace 退格；Enter 确认查询进跳转段（有匹配时）；
	*   其余可打印字符——含 n/N/p/P——进 query（搜索词不再被跳转键劫持）。
	* - 跳转段：n/N 下一个、p/P 上一个；Enter/Backspace/可打印字符回编辑段
	*   （可打印字符顺带追加进 query，输入不过夜）。
	* Esc/Ctrl+C 两段恒为 close。
	*/
	handleKey(name, char) {
		if (name === "escape" || name === "ctrl_c") return "close";
		if (this.jumping) {
			if (name === "return") {
				this.jumping = false;
				return "handled";
			}
			if (name === "backspace") {
				this.jumping = false;
				this.backspace();
				return "handled";
			}
			if (char === "n" || char === "N") {
				this.goNext();
				return "handled";
			}
			if (char === "p" || char === "P") {
				this.goPrev();
				return "handled";
			}
			if (char !== "") {
				this.jumping = false;
				this.type(char);
				return "handled";
			}
			return "handled";
		}
		if (name === "backspace") {
			this.backspace();
			return "handled";
		}
		if (name === "return") {
			if (this.matches.length > 0) this.jumping = true;
			return "handled";
		}
		if (char !== "") {
			this.type(char);
			return "handled";
		}
		return "handled";
	}
	render(width, height) {
		const theme = this.theme;
		const rows = [];
		const counter = this.matches.length > 0 ? `  ${this.current + 1}/${this.matches.length}` : "";
		if (this.jumping) rows.push(color(`/ ${this.query}  [跳转]${counter}`, theme.secondary));
		else {
			const queryText = this.query === "" ? "输入关键词搜索会话历史…" : this.query;
			rows.push(color(`/ ${queryText}${this.query === "" ? "" : "▌"}${counter}`, theme.secondary));
		}
		const bodyHeight = Math.max(1, height - 2);
		const start = this.currentIndex() >= 0 ? this.currentIndex() : 0;
		const contentWidth = Math.max(10, width - 2);
		let used = 0;
		for (let i = start; i < this.messages.length; i++) {
			if (used >= bodyHeight) break;
			const message = this.messages[i];
			/* v8 ignore next -- 数组元素由装配方构造，无 undefined；noUncheckedIndexedAccess 防御 */
			if (message === void 0) continue;
			const isMatch = this.matches.includes(i);
			const line = truncateToDisplayWidth(message.text === "" ? "(空消息)" : message.text, contentWidth);
			const body = isMatch && this.query !== "" ? highlightQuery(line, this.query, {
				sensitive: isSmartCaseSensitive(this.query),
				wrap: (s) => `${ANSI.REVERSE}${s}${ANSI.RESET}`
			}) : line;
			rows.push(isMatch ? color(`▸ ${body}`, theme.success) : `  ${body}`);
			used++;
		}
		rows.push(color(this.jumping ? "n/N 下一个/上一个 · p/P 上一个 · Enter 重新编辑 · Esc 退出" : "输入即过滤 · Enter 确认后 n/N 跳转 · Esc 退出", theme.muted));
		return rows;
	}
	/* v8 ignore next -- 空实现：消息快照由装配方在激活时 setMessages，无自有语句可覆盖 */
	onActivate() {}
	onDeactivate() {
		this.clear();
	}
};
//#endregion
//#region lib/types/scrollback-transcript.js
/**
* Scrollback transcript parser — turns CommitEngine text into message-level units
* for the `/scroll` (pager) overlay search and expansion.
*
* 预留：/scroll overlay 未接线——parseScrollbackTranscript 当前无消费端，仅登记 API。
*
* 解析策略（保守启发式）：
* - 按行扫描，识别消息起始标记。
* - 用户消息：行首（去 ANSI 后）为 `▌` 或 `❯`。
* - 工具结果：行首（去 ANSI 后）为工具卡 bullet 之一（`›` 成功 / `✗` 失败 /
*   `⠋` 进行中 / `?` 待答 / `●` live 卡）。
* - 其余连续行归为一个 assistant/system 块。
* - 截断检测：交给 truncation-marker.ts 的共享正则（同时认中文与历史英文标记）。
*/
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s) {
	return s.replace(ANSI_RE, "");
}
const TOOL_BULLETS = [
	"●",
	"›",
	"✗",
	"⠋",
	"? "
];
function detectRole(strippedFirstLine) {
	const trimmed = strippedFirstLine.trimStart();
	if (trimmed.startsWith("▌") || trimmed.startsWith("❯")) return "user";
	if (TOOL_BULLETS.some((b) => trimmed.startsWith(b))) return "tool";
	if (trimmed.startsWith("┌─") || trimmed.startsWith("╭─")) return "system";
	return null;
}
function isTruncatedMessage(lines) {
	return lines.some((line) => TRUNCATION_MARKER_RE.test(stripAnsi(line)));
}
function makeSummary(_role, firstLine) {
	const stripped = stripAnsi(firstLine).trimStart();
	if (stripped.length > 80) return stripped.slice(0, 79) + "…";
	return stripped;
}
/**
* 解析 scrollback 内容为消息列表。
* @param content - CommitEngine 累积的 scrollback 全文（可含 ANSI）。
* @returns 消息列表（空白内容返回空数组）。
*/
function parseScrollbackTranscript(content) {
	if (!content.trim()) return [];
	const allLines = content.split("\n");
	const messages = [];
	let currentStart = 0;
	let currentRole = "assistant";
	let currentLines = [];
	function flush(end) {
		if (currentLines.length === 0) return;
		const firstLine = currentLines[0];
		/* v8 ignore next 1 -- unreachable: currentLines.length > 0 已在上方守卫，firstLine 恒有值 */
		if (firstLine === void 0) return;
		messages.push({
			startLine: currentStart,
			endLine: end,
			role: currentRole,
			summary: makeSummary(currentRole, firstLine),
			lines: currentLines,
			isTruncated: isTruncatedMessage(currentLines),
			rawContent: currentLines.map(stripAnsi).join("\n").toLowerCase()
		});
	}
	for (let i = 0; i < allLines.length; i++) {
		/* v8 ignore next 1 -- unreachable: split('\n') 数组无 hole，i < length 时 allLines[i] 恒非 undefined */
		const line = allLines[i] ?? "";
		const role = detectRole(stripAnsi(line));
		if (role !== null) {
			flush(i);
			currentStart = i;
			currentRole = role;
			currentLines = [line];
		} else currentLines.push(line);
	}
	flush(allLines.length);
	return messages;
}
/**
* 在消息列表中搜索 query（大小写不敏感）。
* @param messages - 消息列表。
* @param query - 查询串（trim 后为空返回空数组）。
* @returns 匹配的消息索引数组（升序）。
*/
function searchTranscript(messages, query) {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const matches = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message !== void 0 && message.rawContent.includes(q)) matches.push(i);
	}
	return matches;
}
/**
* 找到下一个匹配索引，循环（末尾之后绕回首个匹配）。
* @param messages - 消息列表。
* @param current - 当前消息索引。
* @param query - 查询串。
* @returns 下一个匹配索引；无匹配返回 current。
*/
function findNextMatch(messages, current, query) {
	const matches = searchTranscript(messages, query);
	if (matches.length === 0) return current;
	const first = matches[0];
	/* v8 ignore next 1 -- unreachable: matches.length > 0 已在上方守卫，first 恒有值 */
	if (first === void 0) return current;
	return matches.find((idx) => idx > current) ?? first;
}
/**
* 找到上一个匹配索引，循环（开头之前绕回最后匹配）。
* @param messages - 消息列表。
* @param current - 当前消息索引。
* @param query - 查询串。
* @returns 上一个匹配索引；无匹配返回 current。
*/
function findPrevMatch(messages, current, query) {
	const matches = searchTranscript(messages, query);
	if (matches.length === 0) return current;
	const last = matches[matches.length - 1];
	/* v8 ignore next 1 -- unreachable: matches.length > 0 已在上方守卫，last 恒有值 */
	if (last === void 0) return current;
	return [...matches].reverse().find((idx) => idx < current) ?? last;
}
/**
* 估算某条消息在 overlay 中占多少显示行（粗略，折行按显示宽度向上取整）。
* @param message - 消息。
* @param columns - 终端列数（<1 按 1 处理）。
* @returns 估算显示行数（每逻辑行至少 1 行）。
*/
function estimateMessageRows(message, columns) {
	let rows = 0;
	for (const line of message.lines) {
		const w = displayWidth(line);
		rows += Math.max(1, Math.ceil(w / Math.max(1, columns)));
	}
	return rows;
}
/**
* 计算从第一条消息到指定消息起始处的累计显示行数。
* @param messages - 消息列表。
* @param targetIndex - 目标消息索引（不含自身；越界时累计到列表末尾）。
* @param columns - 终端列数。
* @returns 累计显示行数。
*/
function cumulativeRowsToMessage(messages, targetIndex, columns) {
	let rows = 0;
	for (let i = 0; i < targetIndex && i < messages.length; i++) {
		const message = messages[i];
		/* v8 ignore next 1 -- unreachable: i < messages.length 保证 message 恒非 undefined */
		if (message === void 0) continue;
		rows += estimateMessageRows(message, columns);
	}
	return rows;
}
//#endregion
//#region lib/types/format/scroll-pager-overlay.js
/**
* /scroll 分页查看器 overlay — scrollback-transcript 解析器的消费端。
*
* 全屏 alt-screen 内按消息单元浏览 CommitEngine 已提交的 scrollback 全文：
* ↑↓/PgUp/PgDn/Ctrl+U/Ctrl+D 滚动、g/G 首尾、输入实时子串搜索、n/N 循环跳转、
* Esc 退出。渲染按逻辑行窗口化（超宽行截断到终端宽度），ANSI 原样保留。
* 键位路由收敛在本类 handleKey，装配方（TuiApp）只做 activate/deactivate。
*/
var ScrollPagerOverlay = class {
	messages = [];
	/** 扁平化后的逻辑行（ANSI 原样）与每行所属消息索引。 */
	rows = [];
	rowMessage = [];
	/** 每条消息的首行行号（跳转落点）。 */
	messageStartRow = [];
	scrollRow = 0;
	query = "";
	matches = [];
	current = 0;
	/** render 时缓存的可视行数，PgUp/PgDn 与 clamp 用；首帧前取保守缺省。 */
	bodyHeight = 20;
	theme;
	constructor(theme) {
		this.theme = theme ?? getTheme();
	}
	/**
	* 装配方提供 scrollback 全文快照（CommitEngine.getContent()）；重复设置重解析。
	*/
	setContent(content) {
		this.messages = parseScrollbackTranscript(content);
		this.rows = [];
		this.rowMessage = [];
		this.messageStartRow = [];
		for (let mi = 0; mi < this.messages.length; mi++) {
			const message = this.messages[mi];
			if (message === void 0) continue;
			this.messageStartRow.push(this.rows.length);
			for (const line of message.lines) {
				this.rows.push(line);
				this.rowMessage.push(mi);
			}
		}
		this.research();
		this.clampScroll();
	}
	type(char) {
		this.query += char;
		this.research();
	}
	backspace() {
		this.query = this.query.slice(0, -1);
		this.research();
	}
	/** 清空搜索态（overlay 关闭时调用）；内容与滚动位置保留。 */
	clear() {
		this.query = "";
		this.matches = [];
		this.current = 0;
	}
	matchCount() {
		return this.matches.length;
	}
	scrollUp(n = 1) {
		this.scrollRow = Math.max(0, this.scrollRow - n);
	}
	scrollDown(n = 1) {
		this.scrollRow = Math.min(this.maxScroll(), this.scrollRow + n);
	}
	pageUp() {
		this.scrollUp(this.bodyHeight);
	}
	pageDown() {
		this.scrollDown(this.bodyHeight);
	}
	toTop() {
		this.scrollRow = 0;
	}
	toBottom() {
		this.scrollRow = this.maxScroll();
	}
	goNext() {
		if (this.matches.length === 0) return;
		const from = this.matches[this.current] ?? this.anchorMessage();
		this.jumpTo(findNextMatch(this.messages, from, this.query));
	}
	goPrev() {
		if (this.matches.length === 0) return;
		const from = this.matches[this.current] ?? this.anchorMessage();
		this.jumpTo(findPrevMatch(this.messages, from, this.query));
	}
	/**
	* 键位路由：返回 'close' 请求关闭，其余一律视为已消费。
	* 可打印字符进 query；n/N、p/P 循环跳匹配；↑↓/jk 行滚、PgUp/PgDn/Ctrl+U/Ctrl+D
	* 页滚；g/G（Home/End）首尾。
	*/
	handleKey(name, char) {
		if (name === "escape" || name === "ctrl_c") return "close";
		if (name === "backspace") {
			this.backspace();
			return "handled";
		}
		if (char === "n" || char === "N") {
			this.goNext();
			return "handled";
		}
		if (char === "p" || char === "P") {
			this.goPrev();
			return "handled";
		}
		switch (name) {
			case "up":
			case "k":
				this.scrollUp();
				return "handled";
			case "down":
			case "j":
				this.scrollDown();
				return "handled";
			case "pageup":
				this.pageUp();
				return "handled";
			case "pagedown":
				this.pageDown();
				return "handled";
			case "home":
				this.toTop();
				return "handled";
			case "end":
				this.toBottom();
				return "handled";
		}
		if (name === "ctrl_u") {
			this.pageUp();
			return "handled";
		}
		if (name === "ctrl_d") {
			this.pageDown();
			return "handled";
		}
		if (char === "g") {
			this.toTop();
			return "handled";
		}
		if (char === "G") {
			this.toBottom();
			return "handled";
		}
		if (char !== "") {
			this.type(char);
			return "handled";
		}
		return "handled";
	}
	render(width, height) {
		const theme = this.theme;
		this.bodyHeight = Math.max(1, height - 2);
		this.clampScroll();
		const rows = [];
		const counter = this.matches.length > 0 ? `  ${this.current + 1}/${this.matches.length}` : "";
		const queryText = this.query === "" ? "搜索或滚动（Esc 退出）" : this.query;
		const position = `${this.scrollRow + 1}-${Math.min(this.rows.length, this.scrollRow + this.bodyHeight)}/${this.rows.length}`;
		rows.push(color(`/scroll ${queryText}${this.query === "" ? "" : "▌"}${counter}  ↕${position}`, theme.secondary));
		const currentMatch = this.matches.length > 0 ? this.matches[this.current] : void 0;
		for (let r = this.scrollRow; r < Math.min(this.rows.length, this.scrollRow + this.bodyHeight); r++) {
			const line = this.rows[r];
			if (line === void 0) continue;
			const mi = this.rowMessage[r];
			const isCurrent = currentMatch !== void 0 && mi === currentMatch;
			const isMatchRow = this.matches.includes(mi);
			let text = truncateToDisplayWidth(line, Math.max(10, width - 2));
			if (isMatchRow && this.query !== "") text = highlightQuery(text, this.query, {
				sensitive: isSmartCaseSensitive(this.query),
				wrap: (s) => `${ANSI.REVERSE}${s}${ANSI.RESET}`
			});
			rows.push(isCurrent ? color(`▸ ${text}`, theme.success) : `  ${text}`);
		}
		rows.push(color("↑↓/PgUp/PgDn 滚动 · n/N 匹配跳转 · g/G 首尾 · Esc 退出", theme.muted));
		return rows;
	}
	onActivate() {}
	onDeactivate() {
		this.clear();
	}
	maxScroll() {
		return Math.max(0, this.rows.length - this.bodyHeight);
	}
	clampScroll() {
		this.scrollRow = Math.min(Math.max(0, this.scrollRow), this.maxScroll());
	}
	/** 当前视窗顶行所在的消息索引（空内容为 0）。 */
	anchorMessage() {
		return this.rowMessage[this.scrollRow] ?? 0;
	}
	/** 跳到匹配消息（视窗顶行贴住消息首行），current 对齐到 matches 中的位置。 */
	jumpTo(messageIndex) {
		if (this.matches.length === 0) return;
		const pos = this.matches.indexOf(messageIndex);
		this.current = pos >= 0 ? pos : this.current;
		const start = this.messageStartRow[messageIndex];
		if (start !== void 0) {
			this.scrollRow = start;
			this.clampScroll();
		}
	}
	research() {
		this.matches = searchTranscript(this.messages, this.query);
		this.current = 0;
		const first = this.matches[0];
		if (first !== void 0) {
			const start = this.messageStartRow[first];
			if (start !== void 0) {
				this.scrollRow = start;
				this.clampScroll();
			}
		}
	}
};
//#endregion
//#region lib/types/format/rewind-overlay.js
/**
* C3 项 3：rewind overlay — 双阶段回退面板（用户检查点 → 回退粒度）。
*
* 阶段 1（list）：展示用户检查点（turn/text/seq），↑↓/j k 移动，Enter 选中目标。
* 阶段 2（mode）：convo（仅截断会话）/ code（仅文件回退）/ both（两者）。
* 执行回调由装配方提供（TuiApp.rewindSession 接 FileHistory + SessionStore）。
* 键位路由收敛在本类 handleKey（统一返回词表 'close'|'handled'）：list/done
* 阶段的 Esc 与任意阶段的 Ctrl+C → close；mode 的 Esc 回到 list。
*
* 数据源：装配方过滤后的用户检查点（TranscriptMessage：seq/turn/text）。
*/
const MODE_LABELS = {
	convo: "只截断会话（保留文件）",
	code: "只回退文件（保留会话）",
	both: "会话 + 文件都回退"
};
const MODE_KEYS = [
	{
		key: "1",
		mode: "convo"
	},
	{
		key: "2",
		mode: "code"
	},
	{
		key: "3",
		mode: "both"
	}
];
/** 双阶段回退面板：消息列表选目标 → 粒度选择 → 执行 → 结果展示（纯状态机 + 渲染，零 I/O）。 */
var RewindOverlay = class {
	messages = [];
	/** 阶段：list → mode → executing → done；null = 未激活。 */
	phase = null;
	selected = 0;
	mode = null;
	result = null;
	theme;
	executor = null;
	onSettled;
	constructor(theme, options) {
		this.theme = theme ?? getTheme();
		this.onSettled = options?.onSettled ?? null;
	}
	/**
	* 装配方提供检查点快照 + 执行回调；重复设置重置状态。
	* @param messages - 用户检查点快照（过滤后的 transcript 行）。
	* @param executor - 用户确认后执行回退的回调。
	*/
	setMessages(messages, executor) {
		this.messages = messages;
		this.executor = executor;
		this.phase = "list";
		this.selected = Math.max(0, messages.length - 1);
		this.mode = null;
		this.result = null;
	}
	/**
	* 当前选中的 seq；无消息返回 -1。
	* @returns 选中消息的 seq，或 -1。
	*/
	selectedSeq() {
		const m = this.messages[this.selected];
		return m === void 0 ? -1 : m.seq;
	}
	/**
	* done 阶段（结果已显示；handleKey 对任意键返回 close）。
	* @returns 处于 done 阶段时 true。
	*/
	isDone() {
		return this.phase === "done";
	}
	/**
	* list 阶段（handleKey 对 Esc 返回 close；mode 阶段 Esc 先回到 list）。
	* @returns 处于 list 阶段时 true。
	*/
	isListPhase() {
		return this.phase === "list";
	}
	/**
	* 键位路由（scroll-pager 范式收敛——Esc/Ctrl+C 关闭判定收进类内，装配方
	* 只做 deactivate/rerender）：Ctrl+C 任意阶段 → close；list 阶段 ↑↓/jk
	* 移动、Enter 进粒度选择、Esc → close；mode 阶段 1/2/3 执行、Esc 回 list；
	* done 阶段任意键 → close；executing 吞掉全部键。
	* @param name - 按键名（up/down/return/escape/ctrl_c 等）。
	* @param char - 可打印字符（j/k 移动，1/2/3 选粒度）。
	* @returns close = 请求关闭（装配方 deactivate）；handled = 已消费。
	*/
	handleKey(name, char) {
		if (name === "ctrl_c") return "close";
		if (this.phase === "list") {
			if (name === "escape") return "close";
			if (name === "up" || char === "k") {
				this.selected = Math.max(0, this.selected - 1);
				return "handled";
			}
			if (name === "down" || char === "j") {
				this.selected = Math.min(this.messages.length - 1, this.selected + 1);
				return "handled";
			}
			if (name === "return") {
				if (this.selectedSeq() >= 0) this.phase = "mode";
				return "handled";
			}
			return "handled";
		}
		if (this.phase === "mode") {
			if (char === "1" || char === "2" || char === "3") {
				this.mode = MODE_KEYS.find((k) => k.key === char)?.mode ?? null;
				this.run();
				return "handled";
			}
			if (name === "escape") {
				this.phase = "list";
				return "handled";
			}
			return "handled";
		}
		return this.phase === "done" ? "close" : "handled";
	}
	/** 执行回退（mode 阶段选中后）。 */
	async run() {
		const executor = this.executor;
		const mode = this.mode;
		const atSeq = this.selectedSeq();
		if (executor === null || mode === null || atSeq < 0) return;
		this.phase = "executing";
		try {
			this.result = await executor(mode, atSeq);
		} catch (error) {
			this.result = {
				filesChanged: -1,
				error: error instanceof Error ? error.message : String(error)
			};
		}
		this.phase = "done";
		try {
			this.onSettled?.();
		} catch {}
	}
	render(width, height) {
		if (this.phase === null) return [];
		const theme = this.theme;
		const title = color("⟲ rewind 回退", theme.secondary);
		const contentWidth = Math.max(1, width - 2);
		const bodyBudget = Math.max(0, height - 2);
		if (this.phase === "list") {
			const body = [];
			let selectedRow = 0;
			let lastTurn = -1;
			this.messages.forEach((m, i) => {
				if (m.turn !== lastTurn) {
					body.push(color(`── turn ${m.turn} ──`, theme.muted));
					lastTurn = m.turn;
				}
				if (i === this.selected) selectedRow = body.length;
				const isSel = i === this.selected;
				const line = truncateToDisplayWidth(`${m.kind === "user" ? "❯" : "✦"} ${formatElapsedHuman(Date.now() - m.time)} 前 ${m.text.replace(/\n/g, " ")}`, contentWidth - 2);
				body.push(isSel ? color(`▸ ${line}`, theme.success) : `  ${color(line, theme.dim)}`);
			});
			const start = windowStart$1(selectedRow, body.length, bodyBudget);
			return [
				title,
				...body.slice(start, start + bodyBudget),
				color("↑↓/j k 选检查点 · Enter 选粒度 · Esc 取消", theme.muted)
			];
		}
		if (this.phase === "mode") return [
			title,
			...[color(`回退到 seq ${this.selectedSeq()}，选择粒度：`, theme.primary), ...MODE_KEYS.map(({ key, mode }) => `  ${key}. ${MODE_LABELS[mode]}`)].slice(0, bodyBudget),
			color("1/2/3 确认 · Esc 返回列表或取消", theme.muted)
		];
		if (this.phase === "executing") return [title, color("回退执行中…", theme.muted)];
		const r = this.result;
		const hint = color("任意键关闭", theme.muted);
		if (r === null) return [
			title,
			color("回退已取消", theme.muted),
			hint
		];
		if (r.filesChanged < 0) return [
			title,
			color(`回退失败：${r.error ?? "未知错误"}`, theme.error),
			hint
		];
		const skippedNote = r.filesSkipped !== void 0 && r.filesSkipped > 0 ? `（${r.filesSkipped} 个文件因快照缺失未回退）` : "";
		return [
			title,
			color(`回退完成：${r.filesChanged} 个文件${skippedNote}${r.truncatedTo === void 0 ? "" : `，会话截断到 seq ${r.truncatedTo}`}`, theme.success),
			hint
		];
	}
};
/**
* 把选中行留在 `budget` 行窗口内；窗口比内容短时贴底对齐选中行。
* @param selectedRow - 选中行在完整 body 中的下标。
* @param length - body 总行数。
* @param budget - 可渲染行数。
* @returns 窗口起点。
*/
function windowStart$1(selectedRow, length, budget) {
	if (length <= budget) return 0;
	const start = Math.max(0, selectedRow - budget + 1);
	return start + budget > length ? Math.max(0, length - budget) : start;
}
/**
* 装配方用：从 transcript 视图挑出可回退的用户检查点——真人用户说过的非空
* `user/message`；插件注入（source.kind = 'plugin'）与空文本行不算。
* @param messages - transcript 视图消息（adapter/transcript 投影）。
* @returns 传给 {@link RewindOverlay.setMessages} 的检查点列表。
*/
function collectUserRewindCheckpoints(messages) {
	return messages.filter((message) => message.kind === "user" && message.text !== "" && message.event.type === "user/message" && message.event.data.source.kind === "user");
}
//#endregion
//#region lib/types/external-editor.js
/**
* external-editor — 外部编辑器集成（Phase 6.4）。
*
* Ctrl+E（可配 editorKey；ctrl+o 已恢复为推理展开）把当前输入行内容写入
* 临时文件，spawn `$VISUAL || $EDITOR` 打开编辑，保存退出后内容回填输入框。
* 纯 Node API，零依赖。
*
* 移植自 .rivet/tui-source/tui/external-editor.ts（Apache-2.0；SOURCE-MAP.md）。
* 差异：源引用的 ../platform.js getDefaultEditor 未随移植源落地，此处内联
* （VISUAL/EDITOR 优先，缺省 vi / notepad@win32）。
*
* @module @deepseek-ai/dsh-tianshu-tui/external-editor
*/
/**
* 平台缺省编辑器（VISUAL/EDITOR 均未设置时）。
* @returns win32 为 notepad，其余平台为 vi。
*/
function getDefaultEditor() {
	return process.platform === "win32" ? "notepad" : "vi";
}
/**
* 编辑器命令：VISUAL 优先，其次 EDITOR，最后平台缺省。
* @param env - 环境变量来源（测试可注入；缺省 process.env）。
* @returns 要 spawn 的编辑器命令。
*/
function getEditorCommand(env = process.env) {
	return env["VISUAL"] || env["EDITOR"] || getDefaultEditor();
}
/**
* 把初始内容写入一次性临时文件（目录 mkdtemp，文件 RIVET_INPUT.md）。
* @param content - 写入的初始内容。
* @returns 临时文件的绝对路径。
*/
function createTempFile(content) {
	const dir = mkdtempSync(join(tmpdir(), "rivet-edit-"));
	const path = join(dir, "RIVET_INPUT.md");
	writeFileSync(path, content);
	return path;
}
/**
* 读取编辑结果并清理临时目录（文件与 mkdtemp 目录一并删除；失败 best-effort）。
* @param path - createTempFile 返回的临时文件路径。
* @returns 文件内容（utf-8）。
*/
function readAndCleanup(path) {
	const content = readFileSync(path, "utf-8");
	try {
		rmSync(dirname(path), {
			recursive: true,
			force: true
		});
	} catch {}
	return content;
}
/**
* 打开编辑器编辑 initialContent，返回内容与异常原因。
* 编辑器命令可注入（测试）；缺省走 getEditorCommand()。
* Windows 上 .cmd/.bat 编辑器（如 `code.cmd`）不经 shell 无法直接 spawn
* （EINVAL），回退经 cmd.exe /d /c 显式派发——args 作为 argv 传递，不触发
* DEP0190 弃用警告（shell:true + args 组合）；编辑器命令是用户配置的可信
* 字符串，命令名与文件路径均无 shell 元字符拼接风险。
* 编辑器异常终止（status !== 0 且有 error）时 content 为 null、error 携带
* spawn 原因；status 非 0 但无 error（编辑器被信号终止但文件已保存）仍读回内容。
* @param initialContent - 预填进编辑器的初始内容。
* @param editor - 编辑器命令（测试注入）；缺省走 getEditorCommand()。
* @returns 内容与异常原因（内容为 null 当且仅当编辑器启动/执行异常）。
*/
function openInEditorDetailed(initialContent, editor) {
	const path = createTempFile(initialContent);
	const command = editor ?? getEditorCommand();
	let result = spawnSync(command, [path], {
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error?.code === "EINVAL" && process.platform === "win32") result = spawnSync(process.env.ComSpec ?? "cmd.exe", [
		"/d",
		"/c",
		command,
		path
	], {
		stdio: "inherit",
		windowsHide: true
	});
	if (result.status !== 0 && result.error) {
		try {
			rmSync(dirname(path), {
				recursive: true,
				force: true
			});
		} catch {}
		return {
			content: null,
			error: result.error.message
		};
	}
	return {
		content: readAndCleanup(path),
		error: null
	};
}
//#endregion
//#region lib/types/format/fluency-policy.js
/**
* fluency-policy — 流利度策略（9d 移植，ActivityPhase 适配本包 5 值）。
*
* 从信号（phase/silentMs/outputRate/resultLength/contextPressure/isError/
* isApproval/consecutiveRoutine）推出渲染策略：visibility（normal/quiet/
* inspect/stress）、foldRoutine、coalesceMs、stale 提示。
*
* 移植自 .rivet/tui-source/tui/fluency-policy.ts（Apache-2.0；SOURCE-MAP.md）。
* 差异：本包 ActivityPhase 为 idle/tool/waiting/thinking/streaming 五值，
* 源的 analyzing/mcp/compacting/preflight 档位及其分支已删除。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/fluency-policy
*/
const HIGH_VOLUME_RESULT_LENGTH = 5e4;
const HIGH_OUTPUT_RATE = 5e4;
const PHASE_STALE_TIERS = {
	thinking: [
		3e4,
		9e4,
		18e4
	],
	streaming: [
		15e3,
		6e4,
		12e4
	],
	tool: [
		45e3,
		9e4,
		18e4
	],
	waiting: [
		15e3,
		6e4,
		12e4
	],
	idle: [
		15e3,
		6e4,
		12e4
	]
};
/** 按阶段分档的等待提示。到 action 档会明确告诉用户可以 Ctrl+C——长等待里
*  「还活着吗 / 我能做什么」是唯一真正要回答的两个问题。
*
*  由 TuiApp.renderLive 的 spinner 区直接消费。
* @param phase - 当前活动相位（决定分档阈值与文案）。
* @param silentMs - 静默时长（毫秒）。
* @returns 达到 info/warn/action 档时返回提示与级别；未达 info 档返回 null。 */
function getPhaseStaleMessage(phase, silentMs) {
	const [info, warn, action] = PHASE_STALE_TIERS[phase] ?? PHASE_STALE_TIERS.streaming;
	const sec = Math.round(silentMs / 1e3);
	const min = Math.round(silentMs / 6e4);
	if (silentMs >= action) {
		if (phase === "thinking") return {
			message: `Long think — Ctrl+C to stop (${min}m)`,
			level: "action"
		};
		if (phase === "tool") return {
			message: `Tool may be stuck — Ctrl+C (${min}m)`,
			level: "action"
		};
		return {
			message: `No response — Ctrl+C to interrupt (${min}m)`,
			level: "action"
		};
	}
	if (silentMs >= warn) {
		if (phase === "thinking") return {
			message: `Collecting context... ${min}m`,
			level: "warn"
		};
		if (phase === "tool") return {
			message: `Tool running long... ${min}m`,
			level: "warn"
		};
		return {
			message: `Still waiting... ${min}m`,
			level: "warn"
		};
	}
	if (silentMs >= info) {
		if (phase === "thinking") return {
			message: `Thinking deeply... ${sec}s`,
			level: "info"
		};
		if (phase === "tool") return {
			message: `Executing tools... ${sec}s`,
			level: "info"
		};
		return {
			message: `Waiting for response... ${sec}s`,
			level: "info"
		};
	}
	return null;
}
/**
* 从信号推出渲染策略。优先级：错误/审批（恒 inspect）> 高上下文压力
* （stress + 聚合）> 长静默（inspect + stale 提示）> 大结果/高输出速率
* （inspect + 折叠）> 连续例行（quiet）> normal。
* @param signals - 当前信号快照。
* @returns 命中的首个策略档位。
*/
function computeFluencyPolicy(signals) {
	if (signals.isError) return {
		visibility: "inspect",
		foldRoutine: false,
		coalesceMs: 0
	};
	if (signals.isApproval) return {
		visibility: "inspect",
		foldRoutine: false,
		coalesceMs: 0
	};
	if (signals.contextPressure >= .8) return {
		visibility: "stress",
		foldRoutine: true,
		coalesceMs: 1e3 + Math.round(signals.contextPressure * 2e3)
	};
	if (signals.silentMs >= 15e3 && signals.inFlight !== false) {
		const stale = getPhaseStaleMessage(signals.phase, signals.silentMs);
		if (stale) return {
			visibility: "inspect",
			foldRoutine: false,
			coalesceMs: 0,
			staleMessage: stale.message,
			staleLevel: stale.level
		};
	}
	if (signals.resultLength >= HIGH_VOLUME_RESULT_LENGTH || signals.outputRate >= HIGH_OUTPUT_RATE) return {
		visibility: "inspect",
		foldRoutine: true,
		coalesceMs: 1e3
	};
	if (signals.consecutiveRoutine >= 4) return {
		visibility: "quiet",
		foldRoutine: true,
		coalesceMs: 500
	};
	return {
		visibility: "normal",
		foldRoutine: false,
		coalesceMs: 0
	};
}
/** 连续例行事件计数器：非例行事件即清零，连续 ≥4 次触发折叠。 */
var RoutineCounter = class {
	_count = 0;
	/** 当前连续例行事件计数。 */
	get count() {
		return this._count;
	}
	/**
	* 记录一个事件：例行则累加，非例行则清零。
	* @param isRoutine - 该事件是否例行。
	*/
	record(isRoutine) {
		this._count = isRoutine ? this._count + 1 : 0;
	}
	/** 清零计数。 */
	reset() {
		this._count = 0;
	}
	/** 是否应折叠例行事件（连续 ≥4 次）。 */
	get shouldFold() {
		return this._count >= 4;
	}
};
//#endregion
//#region lib/types/fluency-hook.js
/**
* fluency-hook — 流利度追踪器（9d 移植）。
*
* FluencyTracker 消费工具事件流（tool/call、tool/result、agent 阶段、
* turn 边界），维护连续 routine 计数 / 输出速率 / 静默时长等信号，
* getPolicy() 折叠为渲染策略（见 format/fluency-policy.ts）。
*
* 移植自 .rivet/tui-source/tui/fluency-hook.ts（Apache-2.0；SOURCE-MAP.md）。
* 差异：ActivityPhase 适配本包五值；contextPressure 由装配层喂入
* （0..1，TUI 无 token 数据源时保持 0）。
*
* @module @deepseek-ai/dsh-tianshu-tui/fluency-hook
*/
const ROUTINE_TOOLS = /* @__PURE__ */ new Set([
	"read_file",
	"grep",
	"glob",
	"inspect_project",
	"repo_map",
	"related_tests",
	"recall",
	"diff"
]);
/**
* 流利度追踪器：消费工具/阶段/回合事件，维护连续 routine 计数、
* 输出速率、静默时长等信号，供 getPolicy() 折叠为渲染策略。
*/
var FluencyTracker = class {
	routine = new RoutineCounter();
	lastEventAt = Date.now();
	contextPressure = 0;
	lastIsError = false;
	lastIsApproval = false;
	phase = "idle";
	outputRate = 0;
	resultLength = 0;
	/** 是否有请求在途（turn/start 置位，turn/end 复位）。false 时静默提示不触发。 */
	inFlight = false;
	/**
	* 判定一次工具调用是否算 routine（只读检索类且未出错）。
	* @param name - 工具名。
	* @param isError - 该次调用是否出错；出错一律不算 routine。
	* @returns 属于 routine 工具集且未出错时为 true。
	*/
	isRoutineTool(name, isError) {
		if (isError) return false;
		return ROUTINE_TOOLS.has(name);
	}
	/**
	* 记录一次工具结果：更新 routine 计数、输出速率与错误/审批标记，阶段切到 tool。
	* @param event - 工具结果事件。
	*/
	recordToolResult(event) {
		const now = Date.now();
		const elapsedSeconds = Math.max((now - this.lastEventAt) / 1e3, 1);
		this.routine.record(this.isRoutineTool(event.name, event.isError));
		this.outputRate = event.resultLength / elapsedSeconds;
		this.resultLength = event.resultLength;
		this.lastEventAt = now;
		this.lastIsError = event.isError;
		this.lastIsApproval = false;
		this.phase = "tool";
		this.inFlight = true;
	}
	/** 记录一次审批交互：置审批标记并清零连续 routine 计数。 */
	recordApproval() {
		this.lastIsApproval = true;
		this.routine.reset();
	}
	/**
	* 由装配层喂入上下文压力信号（TUI 无 token 数据源时保持 0）。
	* @param pressure - 上下文压力，0..1。
	*/
	setContextPressure(pressure) {
		this.contextPressure = pressure;
	}
	/**
	* 切换当前活动阶段并重置静默计时起点。设置阶段意味着有活动在途
	* （A5：静默提示仅在在途时有效；onTurnComplete 复位）。
	* @param phase - 新的活动阶段。
	*/
	setPhase(phase) {
		this.phase = phase;
		this.inFlight = true;
		this.lastEventAt = Date.now();
	}
	/**
	* 回填已静默的时长（把静默计时起点拨回 silentMs 毫秒前）。
	* @param silentMs - 已静默的毫秒数。
	*/
	updateSilence(silentMs) {
		this.lastEventAt = Date.now() - silentMs;
	}
	/** 回合开始：标记请求在途，重置静默计时起点。静默提示仅在在途时有效。 */
	onTurnStart() {
		this.inFlight = true;
		this.lastEventAt = Date.now();
	}
	/** 回合结束：清空全部信号、复位在途标记并回到 idle 阶段。 */
	onTurnComplete() {
		this.routine.reset();
		this.lastIsError = false;
		this.lastIsApproval = false;
		this.outputRate = 0;
		this.resultLength = 0;
		this.lastEventAt = Date.now();
		this.phase = "idle";
		this.inFlight = false;
	}
	/**
	* 把当前信号快照折叠为渲染策略。
	* @returns 由 computeFluencyPolicy 计算的当前流利度策略。
	*/
	getPolicy() {
		return computeFluencyPolicy({
			phase: this.phase,
			silentMs: Date.now() - this.lastEventAt,
			outputRate: this.outputRate,
			resultLength: this.resultLength,
			contextPressure: this.contextPressure,
			isError: this.lastIsError,
			isApproval: this.lastIsApproval,
			consecutiveRoutine: this.routine.count,
			inFlight: this.inFlight
		});
	}
};
//#endregion
//#region lib/types/mention-parser.js
/**
* mention-parser — @路径展开解析器（RED 基线）。
*
* 纯函数：输入文本 + 光标 → 光标处的候选 @token（含 span/value/引号态）。
* 不读文件——文件内容摘要展开由装配层（后续）接线。
*
* token 形：裸 `@path` 与引号形 `@"a b.ts"`（路径含空格/反斜杠时）。
*/
const BARE_MENTION_RE = /@([^\s@]+)/g;
const QUOTED_MENTION_RE = /@"((?:[^"\\]|\\.)*)"/g;
/**
* 全量提取所有 mention token（裸 + 引号形）。
* @param input - 输入框全文。
* @returns 带分类的 token 列表（引号形优先，裸形跳过已被引号形消费的区域）。
*/
function parseMentions(input) {
	const out = [];
	for (const m of input.matchAll(QUOTED_MENTION_RE)) {
		const start = m.index;
		const raw = m[0];
		/* v8 ignore next -- matchAll 成功匹配的 RegExpMatchArray 索引必有值；noUncheckedIndexedAccess 收窄防御 */
		if (raw === void 0) continue;
		const value = m[1];
		/* v8 ignore next -- 参与匹配的捕获组必有值；noUncheckedIndexedAccess 收窄防御 */
		if (value === void 0) continue;
		out.push({
			start,
			end: start + raw.length,
			value,
			quoted: true,
			kind: mentionKind(value)
		});
	}
	for (const m of input.matchAll(BARE_MENTION_RE)) {
		const start = m.index;
		const raw = m[0];
		/* v8 ignore next -- matchAll 成功匹配的 RegExpMatchArray 索引必有值；noUncheckedIndexedAccess 收窄防御 */
		if (raw === void 0) continue;
		if (out.some((r) => start >= r.start && start < r.end)) continue;
		const value = m[1];
		/* v8 ignore next -- 参与匹配的捕获组必有值；noUncheckedIndexedAccess 收窄防御 */
		if (value === void 0) continue;
		out.push({
			start,
			end: start + raw.length,
			value,
			quoted: false,
			kind: mentionKind(value)
		});
	}
	return out;
}
/**
* token 形状启发式分类：尾斜杠 → folder；含 #/:: → symbol；空 → raw；其余 file。
* @param value - 去引号后的路径值。
* @returns 分类结果。
*/
function mentionKind(value) {
	if (value === "") return "raw";
	if (value.endsWith("/")) return "folder";
	if (value.includes("#") || value.includes("::")) return "symbol";
	return "file";
}
//#endregion
//#region lib/types/mention-expand.js
/**
* mention-expand — @mention 用户侧摘要展开（Phase 9a 装配层）。
*
* 语义决策（.agents/notes/implemented/feature/2026-08-10-tui-mention-semantics.*）：
* `@filename` 展开为截断的内容摘要展示在用户消息中，**不做** agent 上下文注入。
* 读取边界：仅限工作区（cwd）内文件；目录/不存在/越界 → 降级为引用名展示
* （token 原样保留，不展开）。摘要截断（首 20 行 / 4KB）加折叠标记。
*
* 文件读取在 file 边界做存在性与大小验证（AGENTS.md 边界验证纪律）：
* 先 resolve + 前缀校验（防越界），再 stat 存在性/类型，读取后截断。
*
* @module @deepseek-ai/dsh-tianshu-tui/mention-expand
*/
/** 摘要截断上限：首 20 行 / 4KB（决策 note）。 */
const MAX_SUMMARY_LINES = 20;
const MAX_SUMMARY_CHARS = 4096;
/** 是否在 cwd 内（resolve 后严格前缀，防 ../ 越界）。 */
function isInsideCwd(cwd, candidate) {
	return candidate === cwd || candidate.startsWith(cwd + sep);
}
/** 读取文件摘要：前 20 行 / 4KB 截断 + 折叠标记；读失败降级 null。 */
function readSummary(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const lines = raw.split("\n");
	const first = lines.slice(0, MAX_SUMMARY_LINES).join("\n");
	const truncated = first.length > MAX_SUMMARY_CHARS ? first.slice(0, MAX_SUMMARY_CHARS) : first;
	return truncated.length < raw.length || lines.length > MAX_SUMMARY_LINES ? `${truncated}\n… [截断 ${lines.length} 行 / ${raw.length} 字符]` : truncated;
}
/**
* 展开输入中的所有 @mention：file 类 token 读 cwd 内文件内容摘要，
* 替换为 `@path\n<摘要>`；folder/越界/不存在/读取失败 → token 原样保留。
* @param input - 输入文本。
* @param cwd - 工作区根（读取边界）。
* @returns 展开后的文本。
*/
function expandMentions(input, cwd) {
	const mentions = parseMentions(input);
	if (mentions.length === 0) return input;
	const segments = [];
	let cursor = input.length;
	for (let index = mentions.length - 1; index >= 0; index -= 1) {
		const mention = mentions[index];
		/* v8 ignore next -- 循环自 mentions.length-1 递减至 0，index 恒在界内；noUncheckedIndexedAccess 收窄防御 */
		if (mention === void 0) continue;
		const keep = () => {
			if (mention.end < cursor) segments.unshift(input.slice(mention.end, cursor));
			segments.unshift(input.slice(mention.start, mention.end));
			cursor = mention.start;
		};
		if (mention.kind !== "file") {
			keep();
			continue;
		}
		const candidate = resolve(cwd, mention.value);
		const summary = isInsideCwd(cwd, candidate) ? readSummary(candidate) : null;
		if (summary === null) {
			keep();
			continue;
		}
		if (mention.end < cursor) segments.unshift(input.slice(mention.end, cursor));
		segments.unshift(`@${mention.value}\n${summary}`);
		cursor = mention.start;
	}
	segments.unshift(input.slice(0, cursor));
	return segments.join("");
}
//#endregion
//#region lib/types/os-notify.js
/**
* os-notify — 后台完成时的系统通知（纯展示侧，失败静默）。
*
* 固定 argv（execFile 数组，不走 shell）。SSH / CI / 测试 / DSH_TUI_SKIP_NOTIFY
* 不发。用户文案经 sanitize + 平台引号转义后再进参数。
*
* @module @huiliyi37/dsh-tianshu-tui/os-notify
*/
const execFileAsync = promisify(execFile);
/** 设为 1/true 时关闭系统通知。 */
const SKIP_NOTIFY_ENV = "DSH_TUI_SKIP_NOTIFY";
/** 压扁控制字符并截断，避免通知中心/脚本被换行拆开。 */
function sanitizeNotifyText(text, max) {
	const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${[...flat].slice(0, Math.max(0, max - 1)).join("")}…`;
}
/** AppleScript 双引号字符串（`"` 与 `\` 转义）。 */
function quoteAppleScript(text) {
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
/** PowerShell 单引号字符串（`'` → `''`）。 */
function quotePowerShell(text) {
	return `'${text.replace(/'/g, "''")}'`;
}
function nonempty(env, key) {
	const v = env[key];
	return v !== void 0 && v !== "";
}
function flag$1(env, key) {
	const v = env[key];
	return v === "1" || v === "true";
}
/** 用户显式设了 DSH_TUI_SKIP_NOTIFY 时，面板开关不可切。 */
function notifyOsEnvLocked(env = process.env) {
	return flag$1(env, SKIP_NOTIFY_ENV);
}
/**
* 是否允许发系统通知。
* 关闭条件：用户偏好关、DSH_TUI_SKIP_NOTIFY、VITEST、CI、SSH_*。
*/
function shouldNotify(env, prefs) {
	if (prefs?.notifyOs === false) return false;
	if (flag$1(env, "DSH_TUI_SKIP_NOTIFY")) return false;
	if (flag$1(env, "VITEST")) return false;
	if (flag$1(env, "CI")) return false;
	if (nonempty(env, "SSH_CONNECTION") || nonempty(env, "SSH_CLIENT") || nonempty(env, "SSH_TTY")) return false;
	return true;
}
/**
* 子代理完成通知门槛：有活跃 workflow run 时静默。
* workflow 派生的子代理逐条完成会连发刷屏，汇总由 workflow/end 的
* 「工作流完成」通知统一承担；仅独立委派（无运行中 workflow）即时提醒。
*/
function subagentNotifySuppressed(activeWorkflowRuns) {
	return activeWorkflowRuns > 0;
}
/** 空参 → null（打开面板）；notify [on|off]；其余 usage。 */
function parseConfigNotifyArg(text) {
	const parts = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return null;
	if (parts[0] !== "notify") return "usage";
	if (parts.length === 1) return "toggle";
	if (parts[1] === "on") return "on";
	if (parts[1] === "off") return "off";
	return "usage";
}
/** 就地改 prefs；环境变量锁定时只警告。 */
function applyNotifyOsPref(prefs, action, env = process.env) {
	if (notifyOsEnvLocked(env)) return { warn: "⚠ 系统通知已被 DSH_TUI_SKIP_NOTIFY 关闭" };
	const next = action === "toggle" ? prefs.notifyOs === false : action === "on";
	prefs.notifyOs = next;
	return { echo: `系统通知已${next ? "开" : "关"}` };
}
/** 面板终端段：锁定时显示关。 */
function configTuiFromPrefs(prefs, env = process.env) {
	const locked = notifyOsEnvLocked(env);
	return {
		notifyOs: !locked && prefs.notifyOs !== false,
		notifyLocked: locked
	};
}
/**
* 平台通知命令计划；未知平台或空文案 → null。
*/
function planOsNotify(payload, platform) {
	const title = sanitizeNotifyText(payload.title, 80);
	const body = sanitizeNotifyText(payload.body, 200);
	if (title === "" && body === "") return null;
	if (platform === "darwin") return {
		bin: "osascript",
		args: ["-e", `display notification ${quoteAppleScript(body)} with title ${quoteAppleScript(title)}`]
	};
	if (platform === "linux") return {
		bin: "notify-send",
		args: [title, body]
	};
	if (platform === "win32") return {
		bin: "powershell",
		args: [
			"-NoProfile",
			"-WindowStyle",
			"Hidden",
			"-Command",
			[
				"Add-Type -AssemblyName System.Windows.Forms",
				"$n = New-Object System.Windows.Forms.NotifyIcon",
				"$n.Icon = [System.Drawing.SystemIcons]::Information",
				"$n.Visible = $true",
				`$n.ShowBalloonTip(4000, ${quotePowerShell(title)}, ${quotePowerShell(body)}, [System.Windows.Forms.ToolTipIcon]::Info)`,
				"Start-Sleep -Milliseconds 400"
			].join("; ")
		]
	};
	return null;
}
function defaultExec(bin, args) {
	return execFileAsync(bin, args, {
		timeout: 5e3,
		windowsHide: true,
		maxBuffer: 65536
	});
}
/**
* 发送系统通知。门闸关闭 / 无计划 / exec 失败 → false，永不抛。
*/
async function sendOsNotify(payload, opts = {}) {
	if (!shouldNotify(opts.env ?? process.env, opts.prefs)) return false;
	const plan = planOsNotify(payload, opts.platform ?? process.platform);
	if (plan === null) return false;
	const run = opts.execFile ?? defaultExec;
	try {
		await run(plan.bin, plan.args);
		return true;
	} catch {
		return false;
	}
}
/** 装配层 fire-and-forget（测试环境因 VITEST 门闸自动空操作）。 */
function notifyOs(payload, prefs) {
	sendOsNotify(payload, { prefs });
}
function flag(env, key) {
	return env[key] === "1" || env[key] === "true";
}
/**
* 是否允许响铃。
* 关闭条件：用户偏好关、DSH_TUI_SKIP_NOTIFY、VITEST、CI。
* SSH 不在此列——BEL 穿透 pty 到本地终端，远程会话反而最需要它。
*/
function shouldBell(env, prefs) {
	if (prefs?.notifyOs === false) return false;
	if (flag(env, "DSH_TUI_SKIP_NOTIFY")) return false;
	if (flag(env, "VITEST")) return false;
	if (flag(env, "CI")) return false;
	return true;
}
/**
* 门闸放行时向流写 BEL。写失败静默吞掉，永不抛。
*/
function writeBell(out, env, prefs) {
	if (!shouldBell(env, prefs)) return false;
	try {
		out.write("\x07");
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region lib/types/ui/config-flow.js
/**
* config-flow — /config 面板投影装配（从 TuiApp 抽出，守 app.ts 棘轮）。
*
* 宿主 settings/permission/credentials 均可缺席；终端段始终带上
* （系统通知开关不依赖宿主服务）。
*
* @module @huiliyi37/dsh-tianshu-tui/ui/config-flow
*/
/** 组装 /config 投影；三服务全缺仍返回带 tui 的对象（不再 null）。 */
async function loadConfigProjection(input) {
	const settings = input.reflect.get("settings", false);
	const permission = input.reflect.get("permission", false);
	const credentials = input.reflect.get("credentials", false);
	const projection = {
		settings: settings === void 0 ? [] : settings.describe({ redactSecrets: true }),
		permission: permission === void 0 ? null : {
			options: permission.names.map((n) => ({
				value: n,
				name: n
			})),
			currentValue: permission.current([])
		},
		credentials: [],
		tui: {
			...configTuiFromPrefs(input.prefs, input.env),
			compactMode: input.compactMode === true
		}
	};
	if (credentials === void 0) return projection;
	try {
		const info = await credentials.describe("DEEPSEEK_API_KEY");
		if (input.shouldAbort?.()) return projection;
		return {
			...projection,
			credentials: [{
				ref: "DEEPSEEK_API_KEY",
				configured: info.configured,
				writable: info.writable !== false,
				...info.source === void 0 ? {} : { source: info.source }
			}]
		};
	} catch {
		return projection;
	}
}
/**
* 待审批挂起状态机：handle() 按短路放行 / next() 委托 / 挂起三选一，
* settle() 结算用户决定，peek() 给 renderLive 出快照（见模块注释语义）。
* 挂起超过 timeoutMs 无人应答时自动结算 cancelled（fail-closed）。
*/
var ApprovalController = class {
	pending = null;
	alwaysApproveFlag = false;
	/**
	* 会话级工具白名单（任务4a，2026-08-27）：`t` 键「本会话允许此工具」加入，
	* 命中请求短路放行——其他工具仍逐卡审批（与 alwaysApprove 的全放行互补）。
	* 会话切换时 app 侧调 clearSessionGrants() 复位（跨会话残留清理节）。
	*/
	allowedTools = /* @__PURE__ */ new Set();
	/**
	* 会话级命令前缀白名单（决策分层阶段 2）：`p` 键「此命令前缀不再问」加入，
	* bash 类工具后续同前缀请求短路放行——比 t 键整工具放行再收敛一档。
	*/
	allowedPrefixes = /* @__PURE__ */ new Set();
	/** 拒绝反馈输入态（f 键进入；settle 复位——复刻 question-controller 范式）。 */
	feedback = false;
	getCurrentSessionId;
	onChanged;
	timeoutMs;
	getCommandPrefix;
	constructor(options) {
		this.getCurrentSessionId = options.getCurrentSessionId;
		this.onChanged = options.onChanged;
		this.timeoutMs = options.timeoutMs ?? 6e4;
		this.getCommandPrefix = options.getCommandPrefix;
	}
	/** 是否有挂起的审批（handleKey 分支入口判断）。 */
	get isPending() {
		return this.pending !== null;
	}
	/** C3 项 4：always-approve 模式激活标志（三态循环读写；退出/切会话时 app 侧复位）。 */
	get alwaysApprove() {
		return this.alwaysApproveFlag;
	}
	/**
	* 设置 always-approve 模式（C3 项 4 三态循环；statusLine 徽标由 app 侧同步）。
	* @param flag - true 时当前会话的审批请求短路放行。
	*/
	setAlwaysApprove(flag) {
		this.alwaysApproveFlag = flag;
	}
	/** 会话级工具白名单只读视图（渲染/调试用）。 */
	get allowedToolNames() {
		return [...this.allowedTools];
	}
	/** 白名单是否命中该工具（handleKey 决定键位提示可省；短路判定以 handle 为准）。 */
	isToolAllowed(toolName) {
		return this.allowedTools.has(toolName);
	}
	/** 把工具加入会话白名单（`t` 键；该工具后续请求自动放行）。 */
	allowTool(toolName) {
		this.allowedTools.add(toolName);
	}
	/** 命令前缀是否已加白（调试/测试用；短路判定以 handle 为准）。 */
	isPrefixAllowed(prefix) {
		return this.allowedPrefixes.has(prefix);
	}
	/** 把命令前缀加入会话白名单（`p` 键；bash 类同前缀请求后续自动放行）。 */
	allowCommandPrefix(prefix) {
		this.allowedPrefixes.add(prefix);
	}
	/**
	* 清空会话级授权（工具白名单 + 命令前缀白名单；会话切换时 app 侧复位——
	* 白名单语义限于单个会话）。
	*/
	clearSessionGrants() {
		this.allowedTools.clear();
		this.allowedPrefixes.clear();
	}
	/** 挂起请求的命令前缀（handle 时提取缓存；无挂起/非 bash 类 null）。 */
	get pendingCommandPrefix() {
		return this.pending?.prefix ?? null;
	}
	/** 拒绝反馈输入态（f 键进入；结算时复位）。 */
	get feedbackMode() {
		return this.feedback;
	}
	/**
	* 进入/退出拒绝反馈输入态（f 键 / Esc 返回选项态；不触发结算）。
	* @param flag - true 进入反馈输入态，false 返回选项态。
	*/
	setFeedbackMode(flag) {
		this.feedback = flag;
	}
	/**
	* `t` 键复合操作：挂起请求的工具入会话白名单并结算 allowed-once。
	* @returns false = 无挂起（未结算）。
	*/
	approveWithTool() {
		const pending = this.pending;
		if (pending === null) return false;
		this.allowTool(pending.req.toolName);
		this.settle("allowed-once");
		return true;
	}
	/**
	* `p` 键复合操作：挂起请求的命令前缀入会话白名单并结算 allowed-once。
	* @returns false = 无挂起或无前缀可提（未结算）。
	*/
	approveWithPrefix() {
		const prefix = this.pendingCommandPrefix;
		if (prefix === null) return false;
		this.allowCommandPrefix(prefix);
		this.settle("allowed-once");
		return true;
	}
	/**
	* 审批 answerer 入口：短路放行 / 委托 next() / 挂起，三选一。
	* @param req - 待决审批请求（approval/request 事件 payload）。
	* @param next - waterfall 委托（不处理时调用；链上其他 answerer 兜底）。
	* @returns 用户决定（allowed-once/rejected/cancelled）或 next() 结果。
	*/
	handle(req, next) {
		const current = this.getCurrentSessionId();
		if (this.alwaysApproveFlag && req.agent.session.id === current) return Promise.resolve("allowed-once");
		if (this.allowedTools.has(req.toolName) && req.agent.session.id === current) return Promise.resolve("allowed-once");
		const prefix = req.agent.session.id === current ? this.getCommandPrefix?.(req) ?? null : null;
		if (prefix !== null && this.allowedPrefixes.has(prefix)) return Promise.resolve("allowed-once");
		if (req.agent.session.id !== current || this.pending !== null) return next();
		return new Promise((resolve) => {
			const signal = req.signal;
			if (signal !== void 0 && signal.aborted) {
				resolve("cancelled");
				return;
			}
			const onAbort = () => {
				this.settle("cancelled");
			};
			const timer = Number.isFinite(this.timeoutMs) ? setTimeout(() => {
				this.settle("cancelled");
			}, this.timeoutMs) : void 0;
			this.pending = {
				req,
				resolve,
				since: Date.now(),
				prefix,
				timer,
				...signal !== void 0 ? { onAbort } : {}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.onChanged?.();
		});
	}
	/**
	* 结算挂起的审批请求（用户按键 y/N/Ctrl+C；会话卸载时 cancel 为 cancelled；
	* 请求 signal abort 时自动结算为 cancelled；挂起超过 timeoutMs 时自动结算为 cancelled）。
	* @param outcome - 用户决定。
	*/
	settle(outcome) {
		const pending = this.pending;
		/* v8 ignore next -- settle 仅在 pendingApproval 非 null 的调用点可达 */
		if (pending === null) return;
		this.pending = null;
		this.feedback = false;
		if (pending.timer !== void 0) clearTimeout(pending.timer);
		const onAbort = pending.onAbort;
		if (onAbort !== void 0) pending.req.signal?.removeEventListener("abort", onAbort);
		pending.resolve(outcome);
		this.onChanged?.();
	}
	/**
	* 当前挂起态快照（renderLive 审批段消费）。
	* @returns { req, since, feedbackMode }；无挂起 null。
	*/
	peek() {
		if (this.pending === null) return null;
		return {
			req: this.pending.req,
			since: this.pending.since,
			feedbackMode: this.feedback
		};
	}
};
//#endregion
//#region lib/types/controllers/question-controller.js
/**
* QuestionController — 挂起结构化提问状态机（Wave 1 从 ui/app.ts 提取）。
*
* 持有 pendingQuestion 挂起态（request + resolve/reject 句柄）与
* questionFeedbackMode（plan-review 反馈输入态）。状态、行为、渲染三件事的
* 对象边界：挂起/结算/取消收敛在本控制器，渲染经 peek() 快照由 renderLive
* 消费，键仲裁由 app.ts handleKey 读 isPending/feedbackMode 后调 settle/cancel。
*
* 副作用注入（不 import app.ts、不碰渲染）：
* - onEscapeImmediate(flag)：挂起期间 ESC 恒为「取消提问」而非 CSI 序列前缀，
*   立即派发避免 80ms 窗口内后续按键被吞进序列缓冲（input-handler 语义）。
* - onChanged()：状态实际变化（挂起/结算/取消）后回调，app 侧据此 flushLiveRender。
*
* 契约（与 user-questions provider 对齐）：
* - 重叠 ask → reject UserQuestionError(ASK_CANCELLED)（一次只呈现一个问题）。
* - cancel → reject UserQuestionError(ASK_CANCELLED)（取消必须 reject，非 resolve）。
*
* @module @deepseek-ai/dsh-tianshu-tui/controllers/question-controller
*/
/**
* 挂起结构化提问状态机：一次只挂起一个问题（重叠 ask 即 reject），
* settle/cancel 结算句柄，peek() 给 renderLive 出快照（见模块注释契约）。
*/
var QuestionController = class {
	pending = null;
	feedback = false;
	onEscapeImmediate;
	onChanged;
	constructor(options) {
		this.onEscapeImmediate = options.onEscapeImmediate;
		this.onChanged = options.onChanged;
	}
	/** 是否有挂起的提问（handleKey 分支入口判断）。 */
	get isPending() {
		return this.pending !== null;
	}
	/** plan-review 反馈输入态（f 键进入；结算/取消时复位）。 */
	get feedbackMode() {
		return this.feedback;
	}
	/**
	* 进入/退出反馈输入态（f 键 / Esc 返回选项态；不触发结算）。
	* @param flag - true 进入反馈输入态，false 返回选项态。
	*/
	setFeedbackMode(flag) {
		this.feedback = flag;
	}
	/**
	* 挂起一个提问请求：存 resolve/reject 句柄，返回等用户结算的 promise。
	* 已有挂起时 reject ASK_CANCELLED（重叠保护，不覆盖首个挂起）。
	* @param request - user-questions 的 AskUserQuestionRequest 形状（cast 自 unknown）。
	* @returns 结算值（settle 的 answer）或 UserQuestionError(ASK_CANCELLED)。
	*/
	ask(request) {
		const req = request;
		if (this.pending !== null) return Promise.reject(new UserQuestionError("a question is already pending; the user is answering it", "ASK_CANCELLED"));
		const promise = new Promise((resolve, reject) => {
			this.pending = {
				request: req,
				resolve,
				reject
			};
			this.onEscapeImmediate(true);
			this.onChanged?.();
		});
		promise.catch(() => {});
		return promise;
	}
	/**
	* 结算挂起的提问（用户选择/提交反馈）。
	* @param answer - provider 契约的结算值（{ answers: [{ id, selected[], custom? }] }）。
	*/
	settle(answer) {
		const pending = this.pending;
		/* v8 ignore next -- 调用点均先断言 isPending，null 分支仅类型收窄 */
		if (pending === null) return;
		this.pending = null;
		this.feedback = false;
		this.onEscapeImmediate(false);
		pending.resolve(answer);
		this.onChanged?.();
	}
	/**
	* 取消挂起的提问（Esc/Ctrl+C）——reject ASK_CANCELLED（provider 契约）。
	*/
	cancel() {
		const pending = this.pending;
		/* v8 ignore next -- 调用点均先断言 isPending，null 分支仅类型收窄 */
		if (pending === null) return;
		this.pending = null;
		this.feedback = false;
		this.onEscapeImmediate(false);
		pending.reject(new UserQuestionError("the user cancelled the question", "ASK_CANCELLED"));
		this.onChanged?.();
	}
	/**
	* 当前挂起态快照（renderLive 挂起段消费）。
	* @returns { request, feedbackMode }；无挂起 null。
	*/
	peek() {
		if (this.pending === null) return null;
		return {
			request: this.pending.request,
			feedbackMode: this.feedback
		};
	}
};
//#endregion
//#region lib/types/controllers/btw-controller.js
/**
* BtwController — /btw 侧问状态机（P1 提取，对齐 Question/Approval controller 模式）。
*
* 语义：用户可在主 agent 运行中途提出一个独立问题。btw 走本地 Cordis 旁路——
* 从当前会话 fork 一个「最后完整 turn」的事件前缀（seed）创建临时 btw agent
* （独立 session，不赋值 ownedHandle、不经过 switchSession），单轮问答后销毁。
* 答案经 session/event 流收集（text-delta → turn/end 定稿），渲染快照经 peek()
* 由 renderLive 消费；Esc 由 app 侧 handleKey 仲裁后调 dismiss()。
*
* 关键约束（与主对话流的隔离）：
* - seed 只含完整 turn：fork 语义禁止 ending inside open turn（SessionStore.fork
*   的 OPEN_TURN 检查同构）——主 agent 运行中（open turn）侧问不污染主上下文。
* - 不持 ownedHandle：btw agent 是 registry 级旁路（switchSession 兜底分支同款），
*   dispose 由本控制器在收尾时显式执行（dismiss/超时/完成）。
* - 事件订阅按 btw session id 过滤，不干扰主会话的 streamFeed。
*
* 状态机：idle → loading → done | error →（dismiss）idle。
* - done：答案定稿后等待 Esc 折叠（app 经 onAnswer 写 scrollback）。
* - error：超时/失败后仍可 Esc 关闭。
* - loading 时 Esc：取消并销毁 btw agent（无答案可写）。
* 重叠保护：ask 期间再次 ask 静默忽略（一次只跑一个侧问）。
*
* @module @deepseek-ai/dsh-tianshu-tui/controllers/btw-controller
*/
/**
* 从会话事件日志计算 btw 的 fork seed：最后一个 turn/end 之前的完整前缀。
* fork 语义要求 seed 是 balanced completed-turn prefix（SessionStore.fork 的
* OPEN_TURN 检查同构）——主 agent 运行中（open turn）时截到上一个完整 turn，
* 无任何完整 turn 时为空 seed（btw 从零上下文开始）。
* @param events - 源会话事件日志（seq 连续从 0 开始，数组下标即 seq）。
* @returns 完整 turn 前缀（可直接作 agents.create 的 seed）。
*/
function completedTurnSeed(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event !== void 0 && event.type === "turn/end") return events.slice(0, i + 1);
	}
	return [];
}
/**
* /btw 侧问状态机：fork 完整 turn 前缀创建临时 btw agent，单轮问答后销毁；
* 状态流 idle → loading → done|error →（dismiss）idle（见模块注释约束）。
*/
var BtwController = class {
	state = null;
	/** 当前 btw agent 的 owned handle（本控制器持有，收尾时 dispose）。 */
	handle = null;
	/** btw session 事件订阅 disposer（随收尾释放）。 */
	feed = null;
	/** loading 超时定时器（finish/fail/dismiss 时清除）。 */
	timer = null;
	ctx;
	activeSessionId;
	onChanged;
	onAnswer;
	timeoutMs;
	constructor(options) {
		this.ctx = options.ctx;
		this.activeSessionId = options.activeSessionId;
		this.onChanged = options.onChanged;
		this.onAnswer = options.onAnswer;
		this.timeoutMs = options.timeoutMs ?? 3e4;
	}
	/** 是否有挂起的侧问（handleKey Esc 分支入口判断）。 */
	get isActive() {
		return this.state !== null;
	}
	/**
	* 当前挂起态快照（renderLive btw 段消费）。
	* @returns 挂起态；无挂起侧问为 null。
	*/
	peek() {
		return this.state;
	}
	/**
	* 发起一次侧问：fork 完整 turn 前缀 → agents.create（btw session，不持
	* ownedHandle）→ 订阅答案流 → followup 单轮。已有挂起时静默忽略（一次一个）。
	* @param question - 侧问文本（已 trim；空文本由命令层拦截）。
	* @throws 无活跃会话/会话不存在/创建失败（命令分发层回显失败）。
	*/
	async ask(question) {
		if (this.state !== null) return;
		const activeId = this.activeSessionId();
		if (activeId === null) throw new Error("当前无活跃会话，无法发起侧问");
		const session = this.ctx.sessions.get(activeId);
		if (session === void 0) throw new Error(`unknown session: ${activeId}`);
		const btwId = SessionId(`session-btw-${randomUUID()}`);
		const seed = completedTurnSeed(session.snapshotEvents());
		const selection = this.ctx.agentDefaultModel.currentSelection();
		const parentAgent = this.ctx.agents.get(activeId);
		const handle = await this.ctx.agents.create({
			sessionId: btwId,
			seed,
			meta: {
				cwd: session.header.cwd ?? process.cwd(),
				parentSession: activeId,
				isSeeded: seed.length > 0
			},
			inheritedEventCount: SessionLogOffset(seed.length),
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: async (agentCtx) => {
				await joinPreset({
					facet: presetJoinFacet(this.ctx),
					agentCtx,
					mode: "child",
					parentCtx: parentAgent?.ctx
				});
			}
		});
		const buffer = [];
		const feed = this.ctx.on("session/event", (owner, event) => {
			if (owner.id !== btwId) return;
			if (event.type === "assistant/chunk" && event.data.chunk.type === "text-delta") buffer.push(event.data.chunk.text);
			else if (event.type === "turn/end") this.finish(buffer.join(""));
		});
		this.handle = handle;
		this.feed = feed;
		this.state = {
			status: "loading",
			question
		};
		this.timer = setTimeout(() => {
			this.fail("等待侧问回答超时（无响应）");
		}, this.timeoutMs);
		try {
			await controlsFromHandle(handle).followup(question);
		} catch (err) {
			this.teardown();
			this.state = null;
			throw err;
		}
		this.onChanged?.();
	}
	/**
	* 关闭挂起的侧问（Esc/Ctrl+C）。done 态把答案折叠进 scrollback（onAnswer
	* 回调）；loading 态取消并销毁 btw agent；error 态直接清除。
	*/
	dismiss() {
		const current = this.state;
		if (current === null) return;
		if (current.status === "done") this.onAnswer?.({
			question: current.question,
			answer: current.answer ?? ""
		});
		this.teardown();
		this.state = null;
		this.onChanged?.();
	}
	/**
	* 总清理（app dispose 时）：未决侧问（loading/error）直接销毁 btw agent，
	* done 态不折叠（答案未确认，丢弃——退出即弃，与 always-approve 同生命周期）。
	*/
	dispose() {
		if (this.state === null) return;
		this.teardown();
		this.state = null;
	}
	/** 答案定稿（turn/end 触发）：释放订阅与 agent（turn 已结束，dispose 安全）。 */
	finish(answer) {
		const current = this.state;
		if (current === null || current.status !== "loading") return;
		this.teardown();
		this.state = {
			status: "done",
			question: current.question,
			answer
		};
		this.onChanged?.();
	}
	/** 失败（超时）：销毁 btw agent，置 error 态（Esc 关闭）。 */
	fail(message) {
		const current = this.state;
		if (current === null || current.status !== "loading") return;
		this.teardown();
		this.state = {
			status: "error",
			question: current.question,
			error: message
		};
		this.onChanged?.();
	}
	/** 释放订阅 + dispose btw agent handle（幂等：收尾后再次调用 no-op）。 */
	teardown() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.feed?.();
		this.feed = null;
		const handle = this.handle;
		this.handle = null;
		if (handle !== null) handle.dispose();
	}
};
//#endregion
//#region lib/types/controllers/inspect-surface.js
/**
* InspectSurfaceController — 检查类 live 面板（/config /skills /status /lsp /tasks）
* 互斥开闭与键分发。监控类面板不在此列。
*
* @module @huiliyi37/dsh-tianshu-tui/controllers/inspect-surface
*/
const WARN = {
	skills: "⚠ skills 服务不可用（未装配 skill 插件），技能面板无数据",
	status: "⚠ sessionProjections 服务不可用（未装配 session-projection 插件），目标/任务/计划投影段无数据（会话汇总段为本地投影，不受影响）",
	tasks: "⚠ sessionProjections 服务不可用（未装配 session-projection 插件），任务窗格无数据"
};
/** 五项检查面板的显隐与打开副作用。 */
var InspectSurfaceController = class {
	opts;
	state = {
		config: false,
		skills: false,
		status: false,
		lsp: false,
		tasks: false
	};
	constructor(opts) {
		this.opts = opts;
	}
	flags() {
		return this.state;
	}
	is(which) {
		return this.state[which];
	}
	any() {
		return anyInspectOpen(this.state);
	}
	close() {
		this.state = exclusiveInspect("config", false);
	}
	hide(which) {
		this.state = {
			...this.state,
			[which]: false
		};
	}
	async toggle(which) {
		const next = exclusiveInspect(which, !this.state[which]);
		this.state = next;
		if (next.config) await this.opts.refreshConfig();
		if (next.skills) {
			if (!this.opts.hasService("skills")) this.opts.echoWarn(WARN.skills, "/doctor 体检");
			this.opts.refreshSkills();
		}
		if (next.lsp) this.opts.ensureLsp();
		if (next.status && !this.opts.hasService("sessionProjections")) this.opts.echoWarn(WARN.status, "/doctor 体检");
		if (next.tasks && !this.opts.hasService("sessionProjections")) this.opts.echoWarn(WARN.tasks, "/doctor 体检");
		this.opts.schedule();
	}
	dispatch(act) {
		if (act.type === "close") {
			this.close();
			this.opts.flush();
			return;
		}
		if (act.type === "notify") {
			this.opts.toggleNotify();
			return;
		}
		if (act.type === "density") {
			this.opts.toggleDensity();
			this.opts.flush();
			return;
		}
		if (act.type === "skills-move" && this.opts.moveSkills(act.delta)) this.opts.schedule();
	}
};
//#endregion
//#region lib/types/format/btw-panel.js
/**
* renderBtwPanel — /btw 侧问浮动面板纯函数（P1）。
*
* 把 BtwController 的 peek 快照投影为 live 区顶部面板行：loading 显示 spinner
* + 问题文本 + Esc 提示；done 显示问题 + 答案全文（逐行截断）+ 折叠提示；
* error 显示失败信息。纯函数：同一输入恒返回同一行序列，无 I/O、无时钟
* （spinner 是静态 glyph，不随 tick 变化——面板在 120ms ticker 下已自动刷新）。
* 着色由组合器（renderLive）按状态决定，本模块只产纯文本行。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/btw-panel
*/
/**
* 渲染 btw 侧问面板行。
* @param input - 挂起态快照。
* @param opts - 渲染选项。
* @returns 面板行数组（纯文本；状态行恒存在）。
*/
function renderBtwPanel(input, opts) {
	const rows = [];
	if (input.status === "loading") {
		rows.push(`⏳ 侧问: ${truncateToDisplayWidth(input.question, opts.width)}`);
		rows.push("（Esc 取消；不中断当前对话）");
		return rows;
	}
	if (input.status === "error") {
		rows.push(`⚠ 侧问失败: ${truncateToDisplayWidth(input.error ?? "", opts.width)}`);
		rows.push("（Esc 关闭）");
		return rows;
	}
	rows.push(`💬 侧问: ${truncateToDisplayWidth(input.question, opts.width)}`);
	const answer = input.answer ?? "";
	if (answer === "") rows.push("（空回答）");
	else for (const line of answer.split("\n")) rows.push(truncateToDisplayWidth(line, opts.width));
	rows.push("（Esc 关闭，答案已写入记录）");
	return rows;
}
//#endregion
//#region lib/types/format/pixel-grid.js
/**
* 半块像素画共享 blitter（format/pixel-grid.ts）— 纯渲染。
*
* 半块字符像素画：每个字符格用 `▀`（fg=上像素 + bg=下像素）表达 2 个纵向
* 像素；单色格用 `█`、半透明格用 `▀`/`▄` 仅设前景，全透明格纯空格（不涂
* 背景，终端底色透出）。块字符（U+2580–259F）在 narrow/wide 宽度档均按
* 1 列计（width.ts isBoxOrBlock），居中数学与宽度守恒成立；legacy CJK
* conhost（full 档）把块字符渲染成 2 列会拉伸错位——由调用方门禁降级。
*
* 本模块只做「像素网格 → ANSI 行」的转换；尺寸/色深/宽度档门禁与各画的
* 调色板由调用方（whale.ts / whale-star.ts）自持。
*/
/** SGR 背景回默认（49）：透明格前清背景，防止半块 bg 泄漏到空格。 */
const BG_DEFAULT = "\x1B[49m";
/**
* 像素网格 → 居中 ANSI 行数组（grid.length / 2 行）。
* 宽度守恒：输出行 displayWidth ≤ indent + cols；行尾透明段丢弃（右侧不补
* 空格）；每行 RESET 收尾防颜色泄漏。
* @param input - 网格、列宽、调色板与缩进。
* @returns ANSI 行数组（长度 = grid.length / 2）。
*/
function blitPixelGrid(input) {
	const { grid, cols, palette } = input;
	const indent = " ".repeat(Math.max(0, input.indent));
	const out = [];
	for (let y = 0; y < grid.length; y += 2) {
		const top = grid[y] ?? "";
		const bottom = grid[y + 1] ?? "";
		let line = "";
		let curFg = null;
		let curBg = null;
		let pendingSpaces = 0;
		for (let x = 0; x < cols; x++) {
			const t = palette[top[x] ?? "."] ?? null;
			const b = palette[bottom[x] ?? "."] ?? null;
			let ch;
			let wantFg;
			let wantBg = null;
			if (t === null) {
				if (b === null) {
					pendingSpaces++;
					continue;
				}
				ch = "▄";
				wantFg = b;
			} else if (b === null) {
				ch = "▀";
				wantFg = t;
			} else if (t === b) {
				ch = "█";
				wantFg = t;
			} else {
				ch = "▀";
				wantFg = t;
				wantBg = b;
			}
			if (pendingSpaces > 0) {
				if (curBg !== null) {
					line += BG_DEFAULT;
					curBg = null;
				}
				line += " ".repeat(pendingSpaces);
				pendingSpaces = 0;
			}
			if (wantBg !== curBg) {
				line += wantBg === null ? BG_DEFAULT : bg(wantBg);
				curBg = wantBg;
			}
			if (wantFg !== curFg) {
				line += fg(wantFg);
				curFg = wantFg;
			}
			line += ch;
		}
		out.push(line === "" ? "" : `${indent}${line}${ANSI.RESET}`);
	}
	return out;
}
//#endregion
//#region lib/types/format/whale.js
/**
* 欢迎页鲸鱼品牌像素画（format/whale.ts）— 纯渲染。
*
* 半块字符像素画（渲染细节见 format/pixel-grid.ts 共享 blitter）。
* 品牌资产用固定色（不随主题变）：DeepSeek 品牌蓝身体 + 白肚 + 深色眼。
* 白肚在亮色主题下与终端底色融合，恰好还原 logo 在白纸上的原始观感。
*/
/**
* 像素网格（16 行 × 24 列 → 8 文本行）。图例：
* `.` 透明 / `B` 身体蓝 / `W` 白肚 / `E` 眼睛 / `P` 腮红。
* 形状对照品牌手绘鲸鱼：圆润身体、左下白肚、上中深色眼 + 腮红、右上翘尾。
*/
const GRID = [
	".................BB..BB.",
	".................BBBBBB.",
	"......BBBBBBB....BBBB...",
	"....BBBBBBBBBBB..BBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	".BBBBBBBBBBBBBBBBBBB....",
	".BBBBBBBBEEBBBBBBBBB....",
	"BBWWWWBBBEEBBBBBBBBB....",
	"BWWWWWWPPBBBBBBBBBB.....",
	"BWWWWWWPPBBBBBBBBBB.....",
	"BWWWWWWWWWWWBBBBBB......",
	"BWWWWWWWWWWWWWBBBB......",
	".BWWWWWWWWWWWWWBBB......",
	"..BWWWWWWWWWWWBBB.......",
	"....BBWWWWWWWBBB........",
	".......BBBBBBBB........."
];
GRID.length / 2;
/** truecolor/256 轨：DeepSeek 品牌蓝 + 近白肚（纯白在暗底刺眼）+ 深藏青眼。 */
const TRUECOLOR_PALETTE = {
	B: "#4d6bfe",
	W: "#f2f5fa",
	E: "#14204a",
	P: "#f5a8b8"
};
/** 16 色轨：命名色近似；腮红细节该档不表达（映射回身体色）。 */
const ANSI16_PALETTE = {
	B: "blueBright",
	W: "whiteBright",
	E: "blue",
	P: "blueBright"
};
/**
* 欢迎页鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（WHALE_ROWS 行）。
* 降级矩阵（任一不满足返回空数组，调用方回落纯文字品牌区）：
* - `width ≥ WHALE_MIN_COLS` 且 `rows ≥ WHALE_MIN_ROWS`
* - `colorLevel ≥ 1`（无色终端画不出品牌色，纯剪影无识别度）
* - `ambiguousWidthMode() !== 'full'`（legacy conhost 块字符按 2 列渲染）
* 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
* @param input - 终端尺寸与颜色能力等级。
* @returns 居中 ANSI 行数组；降级时空数组。
*/
function formatWhaleLogo(input) {
	const level = input.colorLevel ?? chalk.level;
	if (level < 1) return [];
	if (input.width < 40 || input.rows < 22) return [];
	if (ambiguousWidthMode() === "full") return [];
	const palette = level >= 2 ? TRUECOLOR_PALETTE : ANSI16_PALETTE;
	const indent = Math.max(0, Math.floor((input.width - 24) / 2));
	return blitPixelGrid({
		grid: GRID,
		cols: 24,
		palette,
		indent
	});
}
//#endregion
//#region lib/types/format/whale-star-frames.js
/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
const STAR_WHALE_FRAME_PALETTE = [
	null,
	"#271d4c",
	"#3251c2",
	"#e2ddf2",
	"#6d37cc",
	"#6e3df3",
	"#4b45e9",
	"#4162e7",
	"#7d84ea",
	"#ce68f1",
	"#fef5d1",
	"#fef0ac",
	"#c87bd5",
	"#bec5fa",
	"#9e39f5",
	"#54a7fd"
];
/** 索引像素行（34 行 × 44 列，单 hex 位/像素，0 = 透明）。 */
const STAR_WHALE_FRAME_ROWS = [
	"00000000000000000000000000000000000000000000",
	"00000000000000000000000000000000000000000000",
	"00000000000000000000000000000000000011100000",
	"0000000000000000000000000000000000111a110000",
	"000000000000000000000000000000010011cbc11140",
	"000000000000000000000001000000011114aba44110",
	"000000000000000000e100550000000013babbbbba11",
	"0000000000000000055e14000000000004bbbbbbb400",
	"00000000000000000005110000000000019bbbbbe100",
	"0000000000000000000010e900000000004bbbbb4100",
	"00000000000000000f1010000000000000cbb4bbe111",
	"0000000000000000000000011110000000b44144a000",
	"00000000000000000019eeee999dc100000044100000",
	"0000000000000000eeeeeeeeeeeee910000999900000",
	"000000000000000eee99eeeeeeeeeee1000eeee00000",
	"00000000000000ee9e55ee555eeeeee9000555500000",
	"00000000000005e555e5555555555555c0e555500000",
	"00000000000005e55555555555555555666555800000",
	"00000000000055555555155555655566686666000000",
	"000000000000555555566666666666661d6666000000",
	"00000000000055555556d1666666661d33666f000000",
	"0000000c000455555666116621111d33337770000000",
	"0000005510045556666611668333333d337700000000",
	"09100556100655666666666833d33333317000000000",
	"66692666100666666666677333333333320000000000",
	"0666266100066666667777733d33d333d00000000000",
	"0066661000266677777777d33d3333d3000000000000",
	"00000671026677772fff7733d33d3d3d000000000000",
	"0000007777777772ffff77dddd3dddd0000000000000",
	"000000777777777fffff2dd8dd8ddd00000000000000",
	"000000027777772fffff2dddd8dd8800000000000000",
	"00000000222222ffff71888888880000000000000000",
	"0000000000222ffff218888888000000000000000000",
	"0000000000000f721222221000000000000000000000"
];
//#endregion
//#region lib/types/format/whale-star.js
/**
* 欢迎页 star 模式抱星鲸鱼像素画（format/whale-star.ts）— 纯渲染。
*
* 品牌画：紫罗兰鲸鱼托举光晕金星（8-22 品牌原图，字幕带已切除）。像素资产
* 为生成物（whale-star-frames.ts，scripts/generate-welcome-star.mjs 产出），
* 44×34 索引像素经 format/pixel-grid.ts 半块渲染（1×2 像素一格 → 44×17
* 文本格）。渐变图用实色双拼而非盲文点阵：渐变区盲文格全混色，亮点归前景
* 点/暗点归背景即成麻点（omts 渲染默认 half 档同理）。背景透明，暗色主题
* 还原参考图观感，亮色主题仍可读。固定品牌色（不随主题变），同 whale.ts 先例。
*/
/** 像素画宽度（文本列数 = 像素列）。 */
const STAR_WHALE_COLS = 44;
/** 图例字符（hex 位）→ 品牌 hex：索引 0 透明，1–F 取生成物调色板（level ≥2 轨）。 */
const PALETTE_HEX$1 = Object.fromEntries(STAR_WHALE_FRAME_PALETTE.flatMap((hex, i) => i === 0 || hex === null ? [] : [[i.toString(16), hex]]));
/** level 1 轨：同索引取现场最近邻 ANSI16 命名色（调色板变更免维护近似表）。 */
const PALETTE_ANSI16$1 = Object.fromEntries(STAR_WHALE_FRAME_PALETTE.flatMap((hex, i) => {
	if (i === 0 || hex === null) return [];
	const rgb = hexToRgb(hex);
	/* v8 ignore next -- 生成物调色板恒为合法 hex；noUncheckedIndexedAccess 收窄防御 */
	return rgb === null ? [] : [[i.toString(16), rgbToAnsi16Name(rgb[0], rgb[1], rgb[2])]];
}));
/**
* 抱星鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（STAR_WHALE_ROWS 行）。
* 降级矩阵同 formatWhaleLogo：窄屏/矮屏/无色/legacy conhost（full 宽度档）
* 返回空数组（调用方回落 retro 鲸鱼或纯文字品牌区）。
* 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
* @param input - 终端尺寸与颜色能力等级。
* @returns 居中 ANSI 行数组；降级时空数组。
*/
function formatStarWhaleLogo(input) {
	const level = input.colorLevel ?? chalk.level;
	if (level < 1) return [];
	if (input.width < 56 || input.rows < 24) return [];
	if (ambiguousWidthMode() === "full") return [];
	const indent = Math.max(0, Math.floor((input.width - STAR_WHALE_COLS) / 2));
	return blitPixelGrid({
		grid: STAR_WHALE_FRAME_ROWS,
		cols: STAR_WHALE_COLS,
		palette: level >= 2 ? PALETTE_HEX$1 : PALETTE_ANSI16$1,
		indent
	});
}
//#endregion
//#region lib/types/format/whale-blue-frames.js
/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
const BLUE_WHALE_FRAME_PALETTE = [
	null,
	"#102967",
	"#adc5ef",
	"#2c7ef6",
	"#0f3088",
	"#1255ce",
	"#314e85",
	"#2670eb",
	"#d9ab4d",
	"#fde66f",
	"#fdfdfd",
	"#fdf4b2",
	"#fd8cb2",
	"#c8dbfd",
	"#1048bf",
	"#479aff"
];
/** 索引像素行（34 行 × 44 列，单 hex 位/像素，0 = 透明）。 */
const BLUE_WHALE_FRAME_ROWS = [
	"0000000000000000000000000000000000000f300000",
	"00000000000000000000000000000000000034470000",
	"00000000000000000000000ffffffff0000007700000",
	"00000000000000000000f355eeeeeee55f0000000000",
	"000000000000000000f3eeeeeeeeeeeeee7300003f00",
	"0000000000000000035eeeeeeeeeeeeeeee570005e00",
	"00000000000000003e577ee7eeeeeeeeeeeee7005000",
	"0000000000000003ee7e77e7eeeeeeeeeeeeee000000",
	"000000000000007ee7eee77eeeeeeeeeeeeeeee00000",
	"000000000000007eee7e7eeeeeeeeeeeeeeeeee10000",
	"00000000000007eeeee7eeeeeeeeeeeeeeeeeee4005e",
	"00000000000005e77ee7eeeeeeeeeeeeeeeeeee40055",
	"00000000000005575777eeeeea1eeeeeeeeeeee40000",
	"0000000000007e7e5e7eeeee111eeeeeeeee11140000",
	"0000000000007ee7e5eeeeecc11eeeeee42dd2de0000",
	"ff000000ff007ee77eeeeeccceeeeee4dddddd220000",
	"5eff000fe7007eeeeeeeeeeeee3daddddddddd200000",
	"eeeef0feee007eeeeeeeeee5fdddd8bbdbddddd00000",
	"4eeee7eeee007eeeeeeeee32d2bb9b9bbbaddd000000",
	"04eeeeee4e007eeeeeeee32d2bb99b9bbbadd0000000",
	"0044eee44007eeeeeeeee2229889bbb9882de0000000",
	"00044eee4475eeee4ee752f29bbbbabbbb81e7000000",
	"000044ee57eeeeee4eee76f2899aaaab991155000000",
	"0000044eeeeeeee44eee77511899aaa991135e000000",
	"00000044eeeeee4444eee57ff689b9b983f5ee000000",
	"0000003344444447f44eeeee73f99998f75eee001110",
	"00110003ff444ff22f14eeeee576989875eee0011100",
	"000000000fff2fff222444eee4181168844400011100",
	"00011110003ffff22ff2f22270000000000001111000",
	"0001111000007ffffff2222000000000000100000000",
	"00000141111000000000000000100000001111100000",
	"00000000000000000000000041111111111111100000",
	"00000000000001441440001100011111111100000000",
	"00000000000000001441110000014114000000000000"
];
//#endregion
//#region lib/types/format/whale-blue.js
/**
* 欢迎页 blue 模式抱星鲸鱼像素画（format/whale-blue.ts）— 纯渲染。
*
* 品牌画：蓝鲸抱星（水面倒影/气泡/腮红构图）。像素资产为生成物
* （whale-blue-frames.ts，scripts/generate-welcome-blue.mjs 产出），
* 44×34 索引像素经 format/pixel-grid.ts 半块渲染（1×2 像素一格 → 44×17
* 文本格）。渐变图用实色双拼而非盲文点阵（同 star 管线结论）。背景透明，
* 暗色主题还原参考图观感，亮色主题仍可读。固定品牌色（不随主题变），
* 同 whale.ts / whale-star.ts 先例。
*/
/** 像素画宽度（文本列数 = 像素列）。 */
const BLUE_WHALE_COLS = 44;
/** 图例字符（hex 位）→ 品牌 hex：索引 0 透明，1–F 取生成物调色板（level ≥2 轨）。 */
const PALETTE_HEX = Object.fromEntries(BLUE_WHALE_FRAME_PALETTE.flatMap((hex, i) => i === 0 || hex === null ? [] : [[i.toString(16), hex]]));
/** level 1 轨：同索引取现场最近邻 ANSI16 命名色（调色板变更免维护近似表）。 */
const PALETTE_ANSI16 = Object.fromEntries(BLUE_WHALE_FRAME_PALETTE.flatMap((hex, i) => {
	if (i === 0 || hex === null) return [];
	const rgb = hexToRgb(hex);
	/* v8 ignore next -- 生成物调色板恒为合法 hex；noUncheckedIndexedAccess 收窄防御 */
	return rgb === null ? [] : [[i.toString(16), rgbToAnsi16Name(rgb[0], rgb[1], rgb[2])]];
}));
/**
* 蓝鲸抱星像素画：返回在 width 内水平居中的 ANSI 行数组（BLUE_WHALE_ROWS 行）。
* 降级矩阵同 formatStarWhaleLogo：窄屏/矮屏/无色/legacy conhost（full 宽度档）
* 返回空数组（调用方回落 retro 鲸鱼或纯文字品牌区）。
* 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
* @param input - 终端尺寸与颜色能力等级。
* @returns 居中 ANSI 行数组；降级时空数组。
*/
function formatBlueWhaleLogo(input) {
	const level = input.colorLevel ?? chalk.level;
	if (level < 1) return [];
	if (input.width < 56 || input.rows < 24) return [];
	if (ambiguousWidthMode() === "full") return [];
	const indent = Math.max(0, Math.floor((input.width - BLUE_WHALE_COLS) / 2));
	return blitPixelGrid({
		grid: BLUE_WHALE_FRAME_ROWS,
		cols: BLUE_WHALE_COLS,
		palette: level >= 2 ? PALETTE_HEX : PALETTE_ANSI16,
		indent
	});
}
//#endregion
//#region lib/types/format/welcome-title-frames.js
/**
* 生成物：scripts/generate-welcome-title.mjs 产出，勿手改。
*
* 欢迎页标题艺术字（figlet，生成期固化，运行时零依赖）：
* - STAR_TITLE_ART：star 风格，standard = Standard 字体宽档，mini = Mini 窄档。
* - BLUE_TITLE_ART：blue 风格（默认），wide = ANSI Shadow 宽档、mid =
*   Standard 中档（宽/中档副标纯文本），mini = Mini 窄档。
* welcome.ts 按右栏宽度选档（放不下窄档则整体回落 retro）。换字体/文本改
* ARTS 后重跑本脚本。
*/
/** star 风格标题艺术字（standard 宽档 / mini 窄档）。 */
const STAR_TITLE_ART = {
	standard: {
		title: [
			"  ____                 ____            _    ____",
			" |  _ \\  ___  ___ _ __/ ___|  ___  ___| | __\\ \\ \\",
			" | | | |/ _ \\/ _ \\ '_ \\___ \\ / _ \\/ _ \\ |/ / \\ \\ \\",
			" | |_| |  __/  __/ |_) |__) |  __/  __/   <  / / /",
			" |____/ \\___|\\___| .__/____/ \\___|\\___|_|\\_\\/_/_/",
			"                 |_|"
		],
		subtitle: [
			"   __  _   _                                 __",
			"  / / | | | | __ _ _ __ _ __   ___  ___ ___  \\ \\",
			" / /  | |_| |/ _` | '__| '_ \\ / _ \\/ __/ __|  \\ \\",
			" \\ \\  |  _  | (_| | |  | | | |  __/\\__ \\__ \\  / /",
			"  \\_\\ |_| |_|\\__,_|_|  |_| |_|\\___||___/___/ /_/"
		],
		width: 50
	},
	mini: {
		title: [
			"  _               __",
			" | \\  _   _  ._  (_   _   _  |  \\\\",
			" |_/ (/_ (/_ |_) __) (/_ (/_ |< //",
			"             |"
		],
		subtitle: [" /   |_|  _. ._ ._   _   _  _   \\", " \\   | | (_| |  | | (/_ _> _>   /"],
		width: 34
	}
};
/** blue 风格标题艺术字（wide = ANSI Shadow / mid = Standard / mini = Mini，宽→窄）。 */
const BLUE_TITLE_ART = {
	wide: {
		title: [
			"██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗",
			"██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝",
			"██║  ██║█████╗  █████╗  ██████╔╝███████╗█████╗  █████╗  █████╔╝",
			"██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ╚════██║██╔══╝  ██╔══╝  ██╔═██╗",
			"██████╔╝███████╗███████╗██║     ███████║███████╗███████╗██║  ██╗",
			"╚═════╝ ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝"
		],
		subtitle: ["< Harness >"],
		width: 64
	},
	mid: {
		title: [
			"  ____                 ____            _",
			" |  _ \\  ___  ___ _ __/ ___|  ___  ___| | __",
			" | | | |/ _ \\/ _ \\ '_ \\___ \\ / _ \\/ _ \\ |/ /",
			" | |_| |  __/  __/ |_) |__) |  __/  __/   <",
			" |____/ \\___|\\___| .__/____/ \\___|\\___|_|\\_\\",
			"                 |_|"
		],
		subtitle: ["< Harness >"],
		width: 44
	},
	mini: {
		title: [
			"  _               __",
			" | \\  _   _  ._  (_   _   _  |",
			" |_/ (/_ (/_ |_) __) (/_ (/_ |<",
			"             |"
		],
		subtitle: [" /   |_|  _. ._ ._   _   _  _   \\", " \\   | | (_| |  | | (/_ _> _>   /"],
		width: 33
	}
};
//#endregion
//#region lib/types/format/welcome.js
/**
* 启动欢迎面（format/welcome.ts）— 纯渲染。
*
* 首屏骨架对齐 Claude Code LogoV2：左栏鲸鱼 + 品牌 + 环境行，右栏 Tips
* （实用快捷键，不是可点菜单）。窄屏回落为垂直居中叠放。输入轨
* 由 format/input-frame 承担，本模块只出欢迎块。
* 宽度守恒：任何输入下每行显示宽度 ≤ width。
*/
function truncateTo$3(text, columns) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/** 在 width 内水平居中（左侧填充；右侧不补，宽度守恒即 ≤ width）。 */
function center(text, width) {
	const left = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
	return `${" ".repeat(left)}${text}`;
}
/** 右侧空格补到 width；超宽 ANSI 安全截断。 */
function padTo(text, width) {
	const w = displayWidth(text);
	if (w >= width) return truncateToDisplayWidth(text, width);
	return `${text}${" ".repeat(width - w)}`;
}
/** 鲸鱼行剥离恰好 indent 列居中缩进（居中由 format*WhaleLogo 烘焙进每行）。
* 只剥缩进、不动画内前导空格——画内空格是构图（星芒/气泡/喷水位置），
* 一并剥掉会把右侧内容甩到左缘（stripLeadingSpaces 曾把星图撕散）。
* 仅 star 鲸鱼用；retro 见 stripLeadingSpaces。 */
function stripIndent(line, indent) {
	let i = 0;
	while (i < line.length && i < indent && line[i] === " ") i++;
	return line.slice(i);
}
/** retro 鲸鱼行全剥前导空格——RELEASE 起 retro 的既有形态（左对齐紧凑），
* CHANGELOG 承诺 retro 画与此前逐字节一致，不可因 star 修复波及。 */
function stripLeadingSpaces(line) {
	let i = 0;
	while (i < line.length && line[i] === " ") i++;
	return line.slice(i);
}
/**
* 欢迎页品牌区：主标 brand（BOLD brandColor）+ 副标题（muted），各一行。
* @param input - 宽度、品牌名、副标题与对齐。
* @param theme - 当前主题（主标 brandColor BOLD，副标题 muted）。
* @returns 两行 ANSI；width ≤ 0 返回空数组。
*/
function formatBrandWelcome(input, theme) {
	if (input.width <= 0) return [];
	const brand = truncateTo$3(input.brand ?? "dsh-tianshu-tui", input.width);
	const subtitle = truncateTo$3(`${input.subtitle ?? "DeepSeek Harness"}${input.version === void 0 ? "" : ` · v${input.version}`}`, input.width);
	const brandLine = color(brand, theme.brandColor, { bold: true });
	const subLine = color(subtitle, theme.muted);
	if (input.align === "left") return [brandLine, subLine];
	return [center(brandLine, input.width), center(subLine, input.width)];
}
/**
* 环境检查紧凑行（欢迎页常驻）：`graphite · API Key ✓ · Git ✓`。
* 缺 API key 时该段换 warning 色并携带可行动提示（设 DEEPSEEK_API_KEY）；
* git ✗ 仅信息性展示。用「API Key」措辞（非 footer 的「API ✗」）。
* @param env - 环境检查结果（主题名/API key/git/对齐）。
* @param theme - 当前主题（muted；缺 key 段 warning）。
* @returns 单行 ANSI；cols ≤ 0 返回空数组。
*/
function formatEnvCheckLine(env, theme) {
	if (env.cols <= 0) return [];
	const sep = color(" · ", theme.muted);
	const api = env.hasApiKey ? color("API Key ✓", theme.muted) : color("API Key ✗（设 DEEPSEEK_API_KEY）", theme.warning);
	const git = color(`Git ${env.isGitRepo ? "✓" : "✗"}`, theme.muted);
	const line = `${color(env.themeName, theme.muted)}${sep}${api}${sep}${git}`;
	return [truncateToDisplayWidth(env.align === "left" ? line : center(line, env.cols), env.cols)];
}
/**
* 欢迎页右栏 Tips：标题 + 快捷键列对齐 + 说明。
* 不可用项整行 muted 且仍显示 keyHint（与旧菜单不同：tips 要让用户知道键还在）。
* 空 items 仍渲染标题（调用方恒有一组默认 tips）。
* @param input - 宽度、tips 项与对齐。
* @param theme - 当前主题（标题 brandColor，hint secondary，说明 muted）。
* @returns ANSI 行数组。
*/
function formatWelcomeTips(input, theme) {
	const { width, items } = input;
	if (width <= 0) return [];
	const budget = Math.max(0, width - 1);
	let hintCol = 0;
	for (const item of items) hintCol = Math.max(hintCol, displayWidth(item.keyHint));
	const rows = [];
	const title = color("Tips", theme.brandColor, { bold: true });
	rows.push(title);
	for (const item of items) {
		const hintPad = Math.max(0, hintCol - displayWidth(item.keyHint));
		const hintText = `${item.keyHint}${" ".repeat(hintPad)}`;
		const body = `${hintText}  ${item.label}`;
		const truncated = truncateTo$3(body, budget);
		if (item.available === false) {
			rows.push(color(truncated, theme.muted));
			continue;
		}
		const hintPart = color(hintText, theme.secondary);
		const labelPart = color(`  ${truncateTo$3(item.label, Math.max(0, budget - hintCol - 2))}`, theme.muted);
		rows.push(displayWidth(body) > budget ? color(truncated, theme.muted) : `${hintPart}${labelPart}`);
	}
	if (input.align === "center") {
		let blockW = 0;
		for (const row of rows) blockW = Math.max(blockW, displayWidth(row));
		blockW = Math.min(blockW, budget);
		const indent = " ".repeat(Math.max(0, Math.floor((width - blockW) / 2)));
		return rows.map((row) => truncateToDisplayWidth(`${indent}${row}`, budget));
	}
	return rows.map((row) => truncateToDisplayWidth(row, budget));
}
/** 左右栏间隙列数。 */
const HERO_GAP = 3;
/** 右栏 tips 放不下时回落叠放的最小宽度。 */
const TIPS_MIN_WIDTH = 18;
/**
* 欢迎英雄区：宽屏左鲸鱼/品牌/环境 + 右 Tips zip；窄屏垂直居中叠放。
* @param input - 终端宽、鲸鱼行、环境检查、tips 项。
* @param theme - 当前主题。
* @returns ANSI 行数组；width ≤ 0 返回空数组。
*/
function formatWelcomeHero(input, theme) {
	const { width, whale, tips } = input;
	if (width <= 0) return [];
	const env = {
		...input.env,
		cols: width
	};
	const stacked = () => {
		const out = [];
		if (whale.length > 0) {
			out.push(...whale);
			out.push("");
		}
		out.push(...formatBrandWelcome({
			width,
			align: "center",
			...input.version === void 0 ? {} : { version: input.version }
		}, theme));
		out.push("");
		out.push(...formatEnvCheckLine({
			...env,
			cols: width,
			align: "center"
		}, theme));
		out.push("");
		out.push(...formatWelcomeTips({
			width,
			items: tips,
			align: "center"
		}, theme));
		return out;
	};
	if (width < 72) return stacked();
	const gutter = width >= 22 ? 2 : 0;
	const inner = width - gutter;
	const brand = formatBrandWelcome({
		width: inner,
		align: "left",
		...input.version === void 0 ? {} : { version: input.version }
	}, theme);
	const envLeft = formatEnvCheckLine({
		...env,
		cols: inner,
		align: "left"
	}, theme);
	const whaleStripped = whale.map(stripLeadingSpaces);
	let leftW = 24;
	for (const line of [
		...whaleStripped,
		...brand,
		...envLeft
	]) leftW = Math.max(leftW, displayWidth(line));
	const rightW = inner - leftW - HERO_GAP;
	if (rightW < TIPS_MIN_WIDTH) return stacked();
	const leftCol = [];
	if (whaleStripped.length > 0) {
		leftCol.push(...whaleStripped);
		leftCol.push("");
	}
	leftCol.push(...brand);
	leftCol.push(...envLeft);
	const rightCol = formatWelcomeTips({
		width: rightW,
		items: tips,
		align: "left"
	}, theme);
	const rows = Math.max(leftCol.length, rightCol.length);
	const gap = " ".repeat(HERO_GAP);
	const pad = " ".repeat(gutter);
	const out = [];
	for (let i = 0; i < rows; i++) {
		const left = padTo(leftCol[i] ?? "", leftW);
		const right = rightCol[i] ?? "";
		out.push(truncateToDisplayWidth(`${pad}${left}${gap}${right}`, width));
	}
	return out;
}
STAR_TITLE_ART.standard.width;
/** star hero 宽屏门禁最小列数（gutter + 画 + 间隙 + 标题窄档）。 */
const STAR_HERO_MIN_COLS = 49 + STAR_TITLE_ART.mini.width;
BLUE_TITLE_ART.wide.width;
/** blue hero 宽屏门禁最小列数（与 star 同构：gutter + 画 + 间隙 + 标题窄档）。 */
const BLUE_HERO_MIN_COLS = 49 + BLUE_TITLE_ART.mini.width;
/**
* 像素画欢迎英雄区（star/blue 共用布局）：左鲸鱼 + 右艺术字标题块
* （主标 / 副标 / @tianshu·版本 / 环境行 / Tips）zip。左栏相对右栏
* 以品牌块为锚垂直居中。标题艺术字按右栏宽度宽→窄取首个放得下的档，
* 最窄档也放不下整体回落 retro。
* 降级（返回空数组，调用方回落 retro hero）：窄屏、矮屏、无色、
* legacy conhost full 宽度档、画已降级。
* 宽度守恒：任何输出行 displayWidth ≤ width。
*/
function formatPixelWelcomeHero(input, theme, spec) {
	const { width, whale, tips } = input;
	if (width <= 0) return [];
	if (width < spec.minCols || input.rows < spec.minRows) return [];
	if (whale.length === 0) return [];
	if ((input.colorLevel ?? chalk.level) < 1) return [];
	if (ambiguousWidthMode() === "full") return [];
	const env = {
		...input.env,
		cols: width
	};
	const gutter = 2;
	const inner = width - gutter;
	const whaleIndent = Math.max(0, Math.floor((width - spec.whaleCols) / 2));
	const whaleStripped = whale.map((l) => stripIndent(l, whaleIndent));
	let leftW = 0;
	for (const line of whaleStripped) leftW = Math.max(leftW, displayWidth(line));
	const rightW = inner - leftW - HERO_GAP;
	const art = spec.artTiers.find((t) => rightW >= t.width);
	if (art === void 0) return [];
	const rightCol = [];
	for (const line of art.title) rightCol.push(color(line, theme.brandColor, { bold: true }));
	rightCol.push("");
	for (const line of art.subtitle) rightCol.push(color(line, theme.secondary));
	const tag = `@tianshu${input.version === void 0 ? "" : ` · v${input.version}`}`;
	rightCol.push(color(truncateTo$3(tag, rightW), theme.muted));
	rightCol.push("");
	rightCol.push(...formatEnvCheckLine({
		...env,
		cols: rightW,
		align: "left"
	}, theme));
	rightCol.push("");
	rightCol.push(...formatWelcomeTips({
		width: rightW,
		items: tips,
		align: "left"
	}, theme));
	const rows = Math.max(whaleStripped.length, rightCol.length);
	const brandRows = art.title.length + 1 + art.subtitle.length + 1;
	const topPad = Math.max(0, Math.floor((brandRows - whaleStripped.length) / 2));
	const leftCol = [];
	for (let i = 0; i < topPad; i++) leftCol.push("");
	leftCol.push(...whaleStripped);
	const gap = " ".repeat(HERO_GAP);
	const pad = " ".repeat(gutter);
	const out = [];
	for (let i = 0; i < rows; i++) {
		const left = padTo(leftCol[i] ?? "", leftW);
		const right = rightCol[i] ?? "";
		out.push(truncateToDisplayWidth(`${pad}${left}${gap}${right}`, width));
	}
	return out;
}
/**
* star 模式欢迎英雄区：左抱星鲸鱼（紫）+ 右艺术字标题块（DeepSeek» /
* < Harness > / @tianshu·版本 / 环境行 / Tips）zip。布局/降级矩阵见
* formatPixelWelcomeHero；门禁常量 STAR_HERO_MIN_COLS / STAR_HERO_MIN_ROWS。
* @param input - 终端尺寸、鲸鱼行、环境检查、tips 项。
* @param theme - 当前主题（标题 brandColor BOLD、副标 secondary、标识/环境 muted）。
* @returns ANSI 行数组；降级时空数组。
*/
function formatStarWelcomeHero(input, theme) {
	return formatPixelWelcomeHero(input, theme, {
		whaleCols: STAR_WHALE_COLS,
		artTiers: [STAR_TITLE_ART.standard, STAR_TITLE_ART.mini],
		minCols: STAR_HERO_MIN_COLS,
		minRows: 24
	});
}
/**
* blue 模式欢迎英雄区（默认风格）：左蓝鲸抱星 + 右 ANSI Shadow 艺术字
* 标题块（DeepSeek / < Harness > / @tianshu·版本 / 环境行 / Tips）zip。
* 标题三档伸缩：ANSI Shadow（64）→ Standard（44）→ Mini（33）。
* 布局/降级矩阵见 formatPixelWelcomeHero；门禁常量 BLUE_HERO_MIN_COLS /
* BLUE_HERO_MIN_ROWS。
* @param input - 终端尺寸、鲸鱼行、环境检查、tips 项。
* @param theme - 当前主题（标题 brandColor BOLD、副标 secondary、标识/环境 muted）。
* @returns ANSI 行数组；降级时空数组。
*/
function formatBlueWelcomeHero(input, theme) {
	return formatPixelWelcomeHero(input, theme, {
		whaleCols: BLUE_WHALE_COLS,
		artTiers: [
			BLUE_TITLE_ART.wide,
			BLUE_TITLE_ART.mid,
			BLUE_TITLE_ART.mini
		],
		minCols: BLUE_HERO_MIN_COLS,
		minRows: 24
	});
}
//#endregion
//#region lib/types/format/top-bar.js
/**
* 顶部栏（format/top-bar.ts）— 纯渲染（C4 概念稿 A「航图」top bar）。
*
* 启动信息行：cwd + git 分支（可选）+ 模型（可选）。快捷键提示不在本行——
* 概念稿 A 的 shortcuts 行由底部 footer（format/prompt-footer.ts）承担。
* 段顺序（从前往后）：📁 cwd → 预设短名 → model → (branch)；超宽时从后往前丢段
* （branch → model → 预设），最后只剩 cwd 仍超宽则截断加省略号。
* 分支段 brandColor 强调；📁 图标 ascii 档降级为 `~`（legacy 终端宽度稳定）。
* 宽度守恒：任何输入下每行显示宽度 ≤ width。
*/
function truncateTo$2(text, columns) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/**
* 渲染顶部栏单行：段顺序 cwd → model → branch(●N)，超宽丢尾段。
* @param input - 宽度、cwd、可选分支/未提交数/模型/ascii。
* @param theme - 当前主题（cwd secondary、分支 brandColor、●N warning）。
* @returns 单行 ANSI；任何宽度下 ≤ width。
*/
function formatTopBar(input, theme) {
	const { width, cwd, branch, dirty, modelName, preset, ascii } = input;
	const base = `${ascii === true ? "~" : "📁"} ${cwd}`;
	const tail = [];
	if (preset !== void 0 && preset !== "") tail.push(preset);
	if (modelName !== void 0 && modelName !== "") tail.push(modelName);
	if (branch !== void 0 && branch !== "") tail.push(dirty !== void 0 && dirty > 0 ? `(${branch} ●${dirty})` : `(${branch})`);
	let segs = tail;
	for (;;) {
		if (displayWidth([base, ...segs].join(" · ")) <= width) {
			const parts = [color(base, theme.secondary)];
			for (const s of segs) parts.push(color(s, s.includes("●") ? theme.warning : theme.brandColor));
			return [parts.join(" · ")];
		}
		if (segs.length === 0) break;
		segs = segs.slice(0, -1);
	}
	const ellipsis = "…";
	return [color(`${truncateTo$2(base, Math.max(1, width - displayWidth(ellipsis)))}${ellipsis}`, theme.secondary)];
}
//#endregion
//#region lib/types/format/turn-status.js
/**
* 状态行（format/turn-status.ts）— 纯渲染（C4 概念稿 A「航图」turn_status）。
*
* statusline 文本的活动态呈现：agent 运行中 → braille spinner（tick 驱动帧
* 循环）；等待输入 → pulsing ◆。statusText 为 null/空时不渲染（不占位）。
* ascii 档：spinner 降级 `*`、等待降级 `-`（legacy 终端宽度稳定）。
* 宽度守恒：statusText 超宽截断（spinner 前缀保留）。
*/
function truncateTo$1(text, columns) {
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/**
* 渲染状态行：spinner（或 ◆）+ statusText。
* @param input - statusline 文本、tick、运行态、可选 ascii/width。
* @param theme - 当前主题（整行 primary 色）。
* @returns 单行 ANSI；无可渲染内容返回空数组。
*/
function formatTurnStatus(input, theme) {
	const { statusText, tick, active, ascii, width } = input;
	if (statusText === null || statusText === "") return [];
	let text = `${active ? ascii === true ? "*" : brailleSpinnerFrame(tick) : ascii === true ? "-" : "◆"} ${statusText}`;
	if (width !== void 0 && width > 0) text = truncateTo$1(text, width);
	return [color(text, theme.primary)];
}
//#endregion
//#region lib/types/format/chrome-colors.js
/**
* 输入轨 / footer 局部雾蓝（dsh-cc-tui Gentle Mist Blue dark）。
*
* 只给 chrome 用，不进 theme-palettes，避免改动全局主题与工具卡家族色。
* 来源：dsh-cc-tui `src/theme.ts` darkTheme.promptBorder / inactiveShimmer / subtle。
*/
/** 输入轨线（CC `promptBorder`）。 */
const CHROME_PROMPT_BORDER = "#55606F";
/** footer 模式字与右侧状态（CC `inactiveShimmer`）。 */
const CHROME_INACTIVE_SHIMMER = "#AAB2C2";
/** footer 快捷键提示（CC `subtle`）。 */
const CHROME_SUBTLE = "#5E6673";
//#endregion
//#region lib/types/format/prompt-footer.js
/**
* 底部 footer（format/prompt-footer.ts）— 纯渲染（C4 概念稿 C 三行底部区）。
*
* 输入行下方的模式/快捷键提示行：mode 段（normal + [plan]/[plan…]/[auto]
* 徽标，与 statusline 徽标词汇一致）在前，快捷键提示在后，mode 恒保留。
* 窄宽显式分级降级（对齐 glance-bar 行 2 的 drop 链）：审批态先走
* 「长文案→短文案」中间档（p 此命令不再问→p 不再问 等），再按固定位次
* 整段丢（esc→f→n→a→p→t，y 保底恒留）；空闲/检查态保持「从后整段丢」。
* 空闲态提示走 10s 轮播（对齐 kimi-code footer tips）：基础操作高频出现，
* 新功能/配置命令按权重旋转，让用户持续可发现；审批/检查面板等上下文态
* 优先显示操作提示不轮播。
* 右侧状态段（token/模型/API 等）右对齐合并进同一行；放不下按 priority
* 丢段（数值大者先丢，缺省=数组下标即从后丢），绝不另起 theme.primary
* 第二行。宽度守恒：任何输入下每行显示宽度 ≤ width。
*/
/** 提示轮播周期（ms）；对齐 kimi-code footer tips 10s 旋转。 */
const FOOTER_TIP_ROTATE_MS = 1e4;
/**
* 轮播提示表（纯数据）：基础操作高频（weight 3），新功能/配置类 weight 2，
* 其余 1。新增命令时在此补一条即可让用户在空闲态可发现。
*/
const FOOTER_TIPS = [
	{
		text: "/ 命令 · ctrl+p 面板",
		weight: 3
	},
	{
		text: "/info 输入区信息密度",
		weight: 2
	},
	{
		text: "/density 紧凑渲染",
		weight: 2
	},
	{
		text: "shift+tab 模式循环",
		weight: 1
	},
	{
		text: "/glance 隐藏 metrics 段",
		weight: 1
	},
	{
		text: "/preset 切换 agent 面",
		weight: 1
	},
	{
		text: "/theme 换主题",
		weight: 1
	},
	{
		text: "ctrl+o 展开推理",
		weight: 1
	},
	{
		text: "ctrl+n 新会话 · ctrl+s 恢复",
		weight: 1
	},
	{
		text: "/help 全部命令",
		weight: 1
	}
];
/** 权重展开序列（index 取模即得轮播序；展开缓存避免每次重算）。 */
const TIP_SEQUENCE = (() => {
	const seq = [];
	for (const t of FOOTER_TIPS) for (let i = 0; i < t.weight; i++) seq.push(t.text);
	return seq;
})();
/** 按序号取轮播提示（确定性；index 取模权重序列）。 */
function footerTipForIndex(index) {
	if (TIP_SEQUENCE.length === 0) return "";
	return TIP_SEQUENCE[(index % TIP_SEQUENCE.length + TIP_SEQUENCE.length) % TIP_SEQUENCE.length];
}
/** 当前轮播序号：now 按 FOOTER_TIP_ROTATE_MS 分片。 */
function footerTipIndex(now = Date.now()) {
	return Math.floor(now / FOOTER_TIP_ROTATE_MS);
}
/**
* 按档位组装分层 footer：行 1 状态行（mode + 提示 + 状态右段），行 2 指标行。
* full 两行 / compact 仅行 1 / off 空。对齐 kimi-code footer 的两行分层：
* 状态（mode/model/API/git）与指标（context/tokens/cost）分置，指标行弱化可整体摘除。
* @param input - 行 1 输入、档位与行 2 指标数据。
* @param theme - 当前主题。
* @returns 0-2 行 ANSI；每行显示宽度 ≤ width。
*/
function formatFooterInfo(input, theme) {
	const level = input.level ?? "full";
	if (level === "off") return [];
	const lines = formatPromptFooter(input, theme);
	if (level === "compact" || input.metrics === void 0) return lines;
	const metricLines = formatGlanceMetricsLine({
		...input.metrics,
		width: input.width
	}, theme);
	if (metricLines.length === 0) return lines;
	return [...lines, metricLines[0].text];
}
/** 审批挂起提示段缺省文案（与 actions/builtin-actions 的 approval 域 footerHint 同源对齐）。 */
const DEFAULT_APPROVAL_HINTS = [
	"y 允许",
	"p 此命令不再问",
	"t 记住此工具",
	"a 全放行",
	"n 拒绝",
	"f 拒绝并说明",
	"esc 取消"
];
/** 检查面板提示段缺省文案（inspect.close 动作 footerHint + 静态「/ 命令」尾段）。 */
const DEFAULT_INSPECT_HINTS = ["esc 关闭", "/ 命令"];
/**
* 审批提示段「长文案→短文案」中间档（显式分级的第一级）：key 为段首键位
* token。y/n/esc 文案已最短不收缩；未登记的自定义段原样保留。
*/
const APPROVAL_HINT_SHORT = {
	p: "p 不再问",
	t: "t 记住",
	a: "a 放行",
	f: "f 拒绝说明"
};
/**
* 审批提示段整段丢弃位次（中间档仍超宽后启用）：数值小者先丢，
* 即 esc→f→n→a→p→t；未登记的自定义段位次 6（核心决策键之后）；y 段
* 恒留（不入丢段序）。
*/
const APPROVAL_DROP_RANK = {
	esc: 0,
	f: 1,
	n: 2,
	a: 3,
	p: 4,
	t: 5
};
/** 提示段首键位 token（首个空白前；'y 允许'→'y'、'esc 取消'→'esc'）。 */
function hintKey(seg) {
	return seg.split(/\s/, 1)[0] ?? seg;
}
/**
* 审批态降级梯队：全长文案 → 全短文案（中间档）→ 按 APPROVAL_DROP_RANK
* 逐段丢（短文案形态；同位次靠后者先丢，y 段永不入队）。
* @param hints - 审批提示段（缺省文案或 action registry 投影）。
* @returns 逐级候选段集，渲染方取第一个放得下的梯队。
*/
function approvalHintTiers(hints) {
	const short = hints.map((s) => APPROVAL_HINT_SHORT[hintKey(s)] ?? s);
	const tiers = [[...hints]];
	if (short.some((s, i) => s !== hints[i])) tiers.push([...short]);
	const dropOrder = hints.map((seg, index) => ({
		index,
		rank: hintKey(seg) === "y" ? Number.POSITIVE_INFINITY : APPROVAL_DROP_RANK[hintKey(seg)] ?? 6
	})).filter((e) => Number.isFinite(e.rank)).sort((a, b) => a.rank - b.rank || b.index - a.index);
	let rest = short.map((text, index) => ({
		text,
		index
	}));
	for (const { index } of dropOrder) {
		rest = rest.filter((e) => e.index !== index);
		tiers.push(rest.map((e) => e.text));
	}
	return tiers;
}
/**
* 空闲/检查态降级梯队：从后整段丢（现状语义——tip/inspect 段先丢，mode 保底）。
* @param hints - 轮播 tip 单段或检查面板提示段。
* @returns 逐级候选段集（逐次少一个尾段）。
*/
function suffixTiers(hints) {
	const tiers = [];
	for (let n = hints.length; n >= 1; n--) tiers.push(hints.slice(0, n));
	return tiers;
}
/**
* 渲染底部 footer：mode 段 + 快捷键提示段，右侧状态段右对齐合并进同一行。
* 空闲态提示按 tipIndex 轮播（10s 一片）；审批/检查面板等上下文态固定操作提示。
* 左段超宽走显式分级降级（审批态：中间档 → 位次丢段；空闲/检查态：从后丢）。
* @param input - 宽度、模式徽标、右侧状态段与轮播序号。
* @param theme - 当前主题（plan/auto 徽标走 warning/error；其余用雾蓝 chrome）。
* @returns 单行 ANSI；任何宽度下 ≤ width。
*/
function formatPromptFooter(input, theme) {
	const { width, planActive, planPending, alwaysApprove } = input;
	const mode = `normal${planPending === true ? " [plan…]" : planActive === true ? " [plan]" : ""}${alwaysApprove === true ? " [auto]" : ""}`;
	const modeColor = planPending === true || planActive === true ? theme.warning : alwaysApprove === true ? theme.error : CHROME_INACTIVE_SHIMMER;
	const tiers = input.approvalPending === true ? approvalHintTiers(input.approvalHints ?? DEFAULT_APPROVAL_HINTS) : suffixTiers(input.inspectOpen === true ? input.inspectHints ?? DEFAULT_INSPECT_HINTS : [footerTipForIndex(input.tipIndex ?? footerTipIndex())]);
	for (const segs of tiers) {
		const text = [mode, ...segs].join(" · ");
		if (displayWidth(text) > width) continue;
		const parts = [color(mode, modeColor)];
		for (const s of segs) parts.push(color(s, CHROME_SUBTLE));
		const leftAnsi = parts.join(" · ");
		const right = input.rightSegments;
		if (right !== void 0 && right.length > 0) return mergeRightSegments(leftAnsi, text, right, width);
		return [leftAnsi];
	}
	return [color(mode, modeColor)];
}
/**
* 左侧 + 右侧状态段合并为一行（右对齐）；右段放不下时按 priority 丢段
* （数值大者先丢，并列时靠后者先丢；保活段仍按数组序展示）。
* @param leftAnsi - 已着色的左侧文本。
* @param leftPlain - 左侧纯文本（宽度度量用）。
* @param right - 右侧状态段（字符串或 { text, priority } 段对象）。
* @param width - 目标行宽。
* @returns 合并后的单行 ANSI。
*/
function mergeRightSegments(leftAnsi, leftPlain, right, width) {
	const segs = right.map((s, i) => typeof s === "string" ? {
		text: s,
		priority: i
	} : {
		text: s.text,
		priority: s.priority ?? i
	});
	const dropOrder = segs.map((_, index) => index).sort((a, b) => (segs[b]?.priority ?? 0) - (segs[a]?.priority ?? 0) || b - a);
	const alive = segs.map(() => true);
	for (const drop of dropOrder) {
		const cur = segs.filter((_, i) => alive[i] === true);
		if (cur.length === 0) return [leftAnsi];
		const rightPlain = cur.map((s) => s.text).join(" · ");
		const pad = width - displayWidth(leftPlain) - displayWidth(rightPlain);
		if (pad >= 0) {
			const rightAnsi = cur.map((s) => color(s.text, CHROME_INACTIVE_SHIMMER)).join(" · ");
			return [`${leftAnsi}${" ".repeat(pad)}${rightAnsi}`];
		}
		alive[drop] = false;
	}
	return [leftAnsi];
}
//#endregion
//#region lib/types/format/confirm-hints.js
/**
* 双击布防提示行（format/confirm-hints.ts）— live 区布防反馈。
*
* 「再按 Ctrl+C 退出」「再按 Esc 打开 rewind」两条提示同一模式：数据源是
* action registry 的 confirmMs 布防时间戳（confirmSince），窗口内渲染一行
* muted 提示、窗口过期撤防自清（组合器副作用——与 taskNotice 渲染后清空同款，
* 纯函数层不承担可变状态）。TuiApp.renderLive 每帧调用；未布防零行。
*
* @module @deepseek-ai/dsh-tianshu-tui/format/confirm-hints
*/
/** 提示表：动作 id + 确认窗口 + 文案（表序即渲染序）。 */
const CONFIRM_HINTS = [[
	"app.interrupt",
	EXIT_WINDOW_MS,
	"再按 Ctrl+C 退出 · Ctrl+Q 立即退出"
], [
	"session.rewind",
	REWIND_DOUBLE_ESC_MS,
	"再按 Esc 打开 rewind"
]];
/**
* 把处于布防窗口内的动作提示行推入 live 行集；过期布防撤防自清。
* @param actions - 动作注册表（confirmSince 数据源 / confirmDisarm 自清）。
* @param lines - live 区行集（就地追加）。
* @param theme - 当前主题（提示行 muted）。
* @param now - 当前时间戳（注入便于测试）。
*/
function pushConfirmHints(actions, lines, theme, now = Date.now()) {
	for (const [id, windowMs, text] of CONFIRM_HINTS) {
		const since = actions.confirmSince(id);
		if (since === 0) continue;
		if (now - since >= windowMs) {
			actions.confirmDisarm(id);
			continue;
		}
		lines.push({ text: color(text, theme.muted) });
	}
}
/** label 列宽硬上限（对齐 grok slash_dropdown 的 LABEL_CAP）。 */
const LABEL_CAP = 40;
/** label 列占可用宽度的比例上限（对齐 grok 的 3/5，取 0.5 保描述空间）。 */
const LABEL_BUDGET_RATIO = .5;
function truncateTo(text, columns) {
	/* v8 ignore next -- 调用点保证 columns ≥ 1（labelW ≥ 1；descW ≥ 2 才调用） */
	if (columns <= 0) return "";
	let out = "";
	for (const ch of text) {
		if (displayWidth(out + ch) > columns) break;
		out += ch;
	}
	return out;
}
/** 滚动窗口起点：total > maxRows 时让 selected 尽量居中，两端 clamp。 */
function windowStart(selected, total, maxRows) {
	if (total <= maxRows) return 0;
	const maxStart = total - maxRows;
	return Math.max(0, Math.min(maxStart, selected - Math.floor((maxRows - 1) / 2)));
}
/**
* 渲染 slash 命令下拉菜单行数组。
* @param input - 宽度、菜单项、选中下标与行数上限。
* @param theme - 当前主题（选中 label primary+bold、未选中 muted、描述 muted）。
* @returns ANSI 行数组；items 为空或 width ≤ 0 返回空数组。
*/
function formatSlashMenu(input, theme) {
	const { width, items, selected } = input;
	if (width <= 0 || items.length === 0) return [];
	const ascii = input.ascii === true;
	const maxRows = input.maxRows !== void 0 && input.maxRows > 0 ? input.maxRows : 8;
	const total = items.length;
	if (width < 4) return [color(truncateTo(ascii ? "> " : "❯ ", width), theme.muted)];
	const start = windowStart(selected, total, maxRows);
	const visible = items.slice(start, start + maxRows);
	const labelTexts = visible.map((item) => item.argsHint !== void 0 ? `/${item.name} ${item.argsHint}` : `/${item.name}`);
	const labelBudget = Math.min(LABEL_CAP, Math.max(0, Math.floor((width - 2) * LABEL_BUDGET_RATIO)));
	const labelW = Math.min(labelBudget, Math.max(0, ...labelTexts.map((t) => displayWidth(t))));
	const out = [];
	visible.forEach((item, i) => {
		const isSel = start + i === selected;
		const prefix = isSel ? ascii ? "> " : "❯ " : "  ";
		const labelTrimmed = truncateTo(labelTexts[i] ?? "", labelW);
		const pad = Math.max(0, labelW - displayWidth(labelTrimmed));
		const descW = width - displayWidth(prefix) - labelW - 2;
		const desc = descW >= 2 ? truncateTo(item.description, descW) : "";
		const labelAnsi = color(`${prefix}${labelTrimmed}`, isSel ? theme.primary : theme.muted, isSel ? { bold: true } : void 0);
		const descAnsi = desc === "" ? "" : color(`  ${desc}`, theme.muted);
		out.push(`${labelAnsi}${" ".repeat(pad)}${descAnsi}`);
	});
	if (total > maxRows) out.push(color(truncateTo(`  ${ascii ? "^v" : "↑↓"} 还有 ${total - maxRows} 项`, width), theme.muted));
	return out;
}
//#endregion
//#region lib/types/actions/key-contexts.js
/**
* actions/key-contexts — 阻塞态键上下文（question/btw/approval/inspect）统一接口。
*
* 原 handleKey 里四段「挂起中独占键盘」分支的收敛：各上下文暴露
* { isActive(), handleKey(key): boolean }，TuiApp 按固定优先级轮询
* （question > btw > approval 在 overlay 委派之后、主段动作之前；inspect
* 在 slash 菜单之后——均为现状顺序保持）。返回 false = 放行给后续路由
* （btw 只消费 Esc/Ctrl+C，其余键照常进输入行——现状语义）。
*
* 业务调用（settle/cancel/重绘）经 deps 闭包注入，本模块不 import app。
*
* ghost 抑制（任务 F）：approval/question 挂起期间输入行被独占，未匹配键
* 一律吞掉（→ 不触发 acceptGhost）；若 ghost 预览仍显示会误导——挂起吞键
* 路径先清除 ghost（deps.inputLine.setGhost(null) 借面），「看得见用不上」
* 的提示不该在屏上。
*
* @module @deepseek-ai/dsh-tianshu-tui/actions/key-contexts
*/
/**
* 挂起吞键时清除 ghost 预览（任务 F：审批/提问挂起中 ghost 可见但 → 被吞）。
* deps.inputLine 的真实实现（InputLine）含 setGhost；单元测试 stub 可缺省
* （optional call 跳过）——借面不改 deps 的类型面，装配侧零改动。
*/
function clearGhostOnBlock(inputLine) {
	inputLine.setGhost?.(null);
}
/**
* T3.1 结构化提问上下文：数字键选选项（1-based），Esc/Ctrl+C 取消；
* plan-review 卡 f 键进入反馈输入模式（文本走 inputLine，Enter 提交）。
* 挂起期间吞掉全部键（返回恒 true）。
*/
function createQuestionKeyContext(deps) {
	return {
		id: "question",
		isActive: () => deps.question.isPending,
		handleKey: (key) => {
			const item = deps.question.peek()?.request.questions[0];
			if (deps.question.feedbackMode) {
				if (key.name === "return") {
					const feedback = deps.inputLine.value;
					deps.inputLine.setValue("");
					const keepLabel = item?.options?.find((o) => o.label !== item.intent?.approve)?.label ?? item?.options?.[0]?.label ?? "";
					deps.settle({ answers: [{
						id: item?.id ?? "",
						selected: [keepLabel],
						custom: feedback
					}] });
				} else if (key.name === "escape" || key.name === "ctrl_c") {
					deps.question.setFeedbackMode(false);
					deps.flushLive();
				} else {
					deps.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true);
					deps.flushLive();
				}
			} else if (key.name === "escape" || key.name === "ctrl_c") deps.cancel();
			else if (item !== void 0 && item.intent?.kind === "plan-review" && (key.char === "f" || key.char === "F")) {
				deps.question.setFeedbackMode(true);
				deps.inputLine.setValue("");
				deps.flushLive();
			} else if (item !== void 0 && item.options !== void 0 && /^[0-9]$/.test(key.char)) {
				const idx = Number(key.char) - 1;
				const option = item.options[idx];
				if (option !== void 0) deps.settle({ answers: [{
					id: item.id,
					selected: [option.label]
				}] });
			} else clearGhostOnBlock(deps.inputLine);
			return true;
		}
	};
}
/**
* P1 /btw 侧问上下文：Esc/Ctrl+C 关闭（done 折叠答案入 scrollback；loading
* 取消并销毁 btw agent；error 直接清除）。其余键放行（返回 false）——
* 侧问不抢占输入焦点（现状语义）。
*/
function createBtwKeyContext(deps) {
	return {
		id: "btw",
		isActive: () => deps.btw.isActive,
		handleKey: (key) => {
			if (key.name !== "escape" && key.name !== "ctrl_c") return false;
			deps.btw.dismiss();
			deps.flushLive();
			return true;
		}
	};
}
/**
* Phase 8 审批上下文：y/p/t/a/n/f 决定、Ctrl+C/Esc 取消——具体键位收敛在
* registry 的 approval 域动作（与 footer/卡片键位行同源投影）；未匹配的键一律
* 吞掉（不干扰输入行——现状语义）。
* 决策分层阶段 2：反馈输入态（f 键进入）独占键盘——Enter 提交反馈结算、
* Esc/Ctrl+C 返回选项态、其余键进输入行（复刻 question 上下文反馈范式）。
*/
function createApprovalKeyContext(deps) {
	return {
		id: "approval",
		isActive: () => deps.approval.isPending,
		handleKey: (key) => {
			if (deps.approval.feedbackMode) {
				if (key.name === "return") {
					const feedback = deps.inputLine.value;
					deps.inputLine.setValue("");
					deps.submitFeedback(feedback);
				} else if (key.name === "escape" || key.name === "ctrl_c") {
					deps.approval.setFeedbackMode(false);
					deps.flushLive();
				} else {
					deps.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true);
					deps.flushLive();
				}
				return true;
			}
			const action = deps.registry.match(key, deps.ctx, { context: "approval" });
			if (action !== null) action.run(deps.ctx, key);
			else clearGhostOnBlock(deps.inputLine);
			return true;
		}
	};
}
/**
* slash 命令菜单上下文（grok slash_dropdown 键路由对齐）：↑↓ 移动、
* PageUp/PageDown 翻页、Tab 接受补全、Enter 接受并提交、Esc 关闭。
* 菜单打开时未命中键放行（false——字符照常进输入行驱动过滤）。
* 注：Ctrl+P/N 已被命令面板/新会话全局动作占用，不在此列。
*/
function createSlashMenuKeyContext(deps) {
	return {
		id: "slash-menu",
		isActive: () => deps.inputController.slashMenu.open,
		handleKey: (key) => {
			if (key.name === "up" || key.name === "down") {
				deps.inputController.moveSlashSelection(key.name === "up" ? -1 : 1);
				deps.flushLive();
				return true;
			}
			if (key.name === "pageup" || key.name === "pagedown") {
				deps.inputController.scrollSlashSelection(key.name === "pageup" ? -8 : 8);
				deps.flushLive();
				return true;
			}
			if (key.name === "tab") {
				deps.accept();
				return true;
			}
			if (key.name === "return") {
				deps.accept({ submit: true });
				return true;
			}
			if (key.name === "escape") {
				deps.inputController.closeSlash();
				deps.flushLive();
				return true;
			}
			return false;
		}
	};
}
/**
* 检查类面板上下文键：/config n 通知、d 密度；/skills j/k 移动选中。
* Esc 关闭不在此列——归 session.abort/inspect.close 主段动作（注册序保持）。
* 未命中返回 false 放行（现状：inspectKeyAction null → 继续路由）。
*/
function createInspectKeyContext(deps) {
	return {
		id: "inspect",
		isActive: () => deps.inspect.any(),
		handleKey: (key) => {
			const act = inspectKeyAction({
				name: key.name,
				char: key.char,
				empty: deps.inputLine.value === "",
				vimInsert: deps.inputLine.vimMode === "insert",
				flags: deps.inspect.flags()
			});
			if (act === null || act.type === "close") return false;
			deps.inspect.dispatch(act);
			return true;
		}
	};
}
//#endregion
//#region lib/types/actions/overlay-router.js
/**
* actions/overlay-router — overlay 键路由委派（scroll-pager 范式收敛）。
*
* 原 TuiApp.handleKey 里六段 overlay 分支的表驱动化：各 overlay 自持
* handleKey（统一返回词表 'close'|'handled'，Esc/Ctrl+C 关闭判定在类内），
* 本路由器只做「activeId → 键目标」委派与结果收尾（close → deactivate、
* handled → rerender）。委派顺序对齐原 if 链：key-dialog（Ctrl+V 粘贴拦截
* 在先）→ picker → search → scroll → rewind → memory → palette（以 isOpen
* 判定；commit 分流 execute 直接执行 / backfill 回填输入行）。
*
* 键目标缺席（控制器未装配）时不吞键、落后续路由——对齐原分支条件
* `activeId === x && controller !== null` 为 false 的穿透语义。keymap 等
* 静态面板不在表内（键位本就穿透给后续路由——现状语义）。
*
* @module @deepseek-ai/dsh-tianshu-tui/actions/overlay-router
*/
/**
* overlay 键路由器：route(key) 返回 true = 键已被 overlay 消费。
* 表驱动委派 + 结果收尾；行为逐分支对齐原 handleKey overlay 段。
*/
var OverlayKeyRouter = class {
	deps;
	/** 委派表（顺序即优先级；key-dialog 有 Ctrl+V 前置拦截，单独分支）。 */
	routes;
	constructor(deps) {
		this.deps = deps;
		this.routes = [
			["picker", () => deps.picker()],
			["search", () => deps.search()],
			["scroll", () => deps.scroll()],
			["rewind", () => deps.rewind()],
			["memory", () => deps.memory()]
		];
	}
	/**
	* 键路由委派：activeId 命中且控制器在装 → 消费；palette 以 isOpen 兜底判定。
	* @param key - 按键事件。
	* @returns true = 已消费（终止 handleKey 后续路由）。
	*/
	route(key) {
		const overlay = this.deps.overlay();
		if (overlay !== null) {
			const active = overlay.activeId();
			if (active === "key-dialog") {
				const dialog = this.deps.keyDialog();
				if (dialog !== null) {
					if (key.name === "ctrl_v") this.deps.pasteKeyDialog(dialog);
					else this.closeOrRerender(overlay, dialog.handleKey(key.name, key.char));
					return true;
				}
			}
			for (const [id, get] of this.routes) {
				if (active !== id) continue;
				const target = get();
				if (target === null) break;
				this.closeOrRerender(overlay, target.handleKey(key.name, key.char));
				return true;
			}
		}
		const palette = this.deps.palette();
		if (palette?.isOpen() === true) {
			if (palette.handleKey(key.name, key.char) === "close") {
				this.deps.overlay()?.deactivate();
				const committed = palette.takeCommit();
				if (committed !== null) {
					if (committed.execute) this.deps.submit(committed.text);
					else this.deps.backfill(committed.text);
				}
			} else this.deps.overlay()?.rerender();
			return true;
		}
		return false;
	}
	/** overlay 键结果收尾：'close' → deactivate；'handled' → rerender。 */
	closeOrRerender(overlay, result) {
		if (result === "close") overlay.deactivate();
		else overlay.rerender();
	}
};
//#endregion
//#region lib/types/format/input-frame.js
/**
* 输入轨（format/input-frame.ts）— 纯渲染。
*
* Claude Code PromptInput 形态：`borderStyle=round` + `borderLeft/Right=false`。
* 只画上下两条圆角横线（╭─╮ / ╰─╯），输入行本身不包左右 `│`。
* 轨线色随模式：normal 雾蓝 promptBorder / plan warning / auto error。
* ascii 降级由 boxCharsFor 走 +---+。columns < 4 时不加轨，原样返回输入行。
*/
/**
* 渲染输入轨：顶轨 + 输入行（无左右竖线）+ 底轨。
* @param input - 列数、输入行、光标坐标与模式标志。
* @param theme - 当前主题（plan warning / auto error；normal 用雾蓝轨线）。
* @returns 轨线行数组与 caretLine+1；columns < 4 时原样返回输入行。
*/
function formatInputFrame(input, theme) {
	const { columns } = input;
	if (columns < 4) return {
		lines: [...input.lines],
		caretLine: input.caretLine,
		caretCol: input.caretCol
	};
	const chars = boxCharsFor(input.separator ?? "thin");
	const borderColor = input.planPending === true || input.planActive === true ? theme.warning : input.alwaysApprove === true ? theme.error : CHROME_PROMPT_BORDER;
	const inner = Math.max(0, columns - 2);
	const top = color(`${chars.tl}${chars.h.repeat(inner)}${chars.tr}`, borderColor);
	const bottom = color(`${chars.bl}${chars.h.repeat(inner)}${chars.br}`, borderColor);
	return {
		lines: [
			top,
			...input.lines.map((line) => truncateToDisplayWidth(line, columns)),
			bottom
		],
		caretLine: input.caretLine + 1,
		caretCol: input.caretCol
	};
}
//#endregion
//#region lib/types/format/glance-metrics.js
/**
* glance metrics 投影 — app 缓存字段 → formatGlanceBar 输入（C4：自 ui/app.ts 提取）。
*
* 纯函数纪律：时间注入（now 参数）；诚实降级——适配器未报 cache 字段不显示
* 0%、定价表未命中不猜价。
*
* @module @huiliyi37/dsh-tianshu-tui/format/glance-metrics
*/
/**
* 组装 metrics 一行条输入；transcript/modelName 缺失返回 null（不渲染）。
* @param sources - app 缓存字段投影。
* @param now - 当前时刻（默认 Date.now()；注入可测）。
*/
function buildGlanceMetrics(sources, now = Date.now()) {
	if (sources.transcript === void 0) return null;
	if (sources.modelName === null) return null;
	const input = {
		width: sources.columns,
		modelName: sources.modelName
	};
	if (sources.effort !== null) input.effort = sources.effort;
	if (sources.preset !== void 0 && sources.preset !== null && sources.preset !== "") input.preset = sources.preset;
	const usage = sources.usage;
	if (usage !== null) {
		const billed = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		if (billed > 0) {
			if (usage.cacheReadTokens !== void 0 || usage.cacheWriteTokens !== void 0) input.cacheHitRate = (usage.cacheReadTokens ?? 0) / billed;
			if (sources.contextWindow !== null && sources.contextWindow > 0) {
				input.contextRatio = Math.min(1, billed / sources.contextWindow);
				input.tokens = {
					used: billed,
					max: sources.contextWindow
				};
			}
		}
		const cost = estimateCost(sources.modelName, usage);
		if (cost !== void 0) input.cost = cost;
	}
	if (sources.transcript.turn >= 0) {
		input.turnCount = sources.transcript.turn + 1;
		if (sources.transcript.firstInTurnTime !== void 0) input.elapsedMs = now - sources.transcript.firstInTurnTime;
	}
	return input;
}
//#endregion
//#region lib/types/format/memory-overlay.js
/**
* memory overlay — 记忆浏览器（P2 交互打磨）。
*
* 上下布局（终端宽度限制下左右分栏不友好）：上部为记忆列表（过滤后视口），
* 下部为选中项完整内容。交互：
* - ↑↓/j k：移动选中
* - 可打印字符：进过滤 query（text/tags 子串，大小写不敏感）
* - Backspace：退过滤
* - x：删除选中（异步执行 onDelete + refetch 刷新；注意：x/X 已专用于删除，
*   不进入过滤 query——只有字母数字/符号等非控制字符才进 query。若用户想输入
*   含 'x' 的过滤词，可用大写 'X' 代替——但 'X' 目前同 x 语义。后续可选：改为
*   dd 双键确认删除，释放单 x 给过滤。）
* - Ctrl+N/Ctrl+P：下/上一页（分页，每页 20 条）
* - Esc/Ctrl+C：关闭（handleKey 返回 'close'，装配方 deactivate）
*
* 数据源由装配方注入（TuiApp.openMemoryBrowser 经 memory 服务 list/delete），
* overlay 本身不碰 I/O——纯状态机 + 渲染（对齐 RewindOverlay 模式）。
*/
/** 每页条目数（与 grok-build memory 视图对齐：~20 条/页）。 */
const PAGE_SIZE = 20;
/** 记忆浏览器 overlay：过滤列表 + 选中项内容，删除/分页经装配方注入的回调（纯状态机 + 渲染，零 I/O）。 */
var MemoryBrowserOverlay = class {
	items = [];
	query = "";
	selected = 0;
	sources = null;
	/** 删除/翻页执行中（渲染占位，防连点）。 */
	deleting = false;
	/** 分页：是否还有更多页（setItems 装配方判定；翻页后按实拉条数刷新）。 */
	hasMore = false;
	theme;
	constructor(theme) {
		this.theme = theme ?? getTheme();
	}
	/**
	* 装配方提供条目快照 + 数据源回调；重复设置重置状态（回到首页）。
	* @param items - 首页条目快照。
	* @param sources - 删除/刷新/分页回调。
	* @param hasMore - 首页之后是否还有更多条目（Ctrl+N 翻页前提）。
	*/
	setItems(items, sources, hasMore) {
		this.items = items;
		this.sources = sources;
		this.query = "";
		this.selected = 0;
		this.deleting = false;
		this.hasMore = hasMore;
	}
	/** 过滤后的条目（query 为空 = 全量）。 */
	get filtered() {
		const needle = this.query.toLowerCase();
		if (needle === "") return this.items;
		return this.items.filter((item) => item.text.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle)));
	}
	/**
	* 键位路由（scroll-pager 范式收敛——Esc/Ctrl+C 关闭判定收进类内）。
	* @param name - 按键名（up/down/backspace/ctrl_n/ctrl_p/escape/ctrl_c 等）。
	* @param char - 可打印字符（j/k 移动，x/X 删除，其余进过滤 query）。
	* @returns close = 请求关闭（Esc/Ctrl+C）；handled = 已消费（含空格等未
	*   映射键——overlay 独占焦点，吞掉不穿透输入行）。
	*/
	handleKey(name, char) {
		if (name === "escape" || name === "ctrl_c") return "close";
		if (this.deleting) return "handled";
		if (name === "up" || char === "k") {
			this.selected = Math.max(0, this.selected - 1);
			return "handled";
		}
		if (name === "down" || char === "j") {
			this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
			return "handled";
		}
		if (name === "backspace") {
			if (this.query !== "") {
				this.query = this.query.slice(0, -1);
				this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
			}
			return "handled";
		}
		if (char === "x" || char === "X") {
			this.deleteSelected();
			return "handled";
		}
		if (name === "ctrl_n") {
			this.nextPage();
			return "handled";
		}
		if (name === "ctrl_p") {
			this.prevPage();
			return "handled";
		}
		if (char !== "" && char !== " ") {
			this.query += char;
			this.selected = 0;
			return "handled";
		}
		return "handled";
	}
	/** 删除当前选中项（异步：onDelete + refetch 刷新；失败静默保持列表）。 */
	async deleteSelected() {
		const sources = this.sources;
		const item = this.filtered[this.selected];
		if (sources === null || item === void 0) return;
		this.deleting = true;
		try {
			await sources.onDelete(item.id);
			this.items = await sources.refetch();
			this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
		} finally {
			this.deleting = false;
		}
	}
	/** 下一页（异步拉取，加载中静默）。offset 语义 = 已加载条数（fetchPage
	* 跳过前 N 条）；成功后 hasMore 按实拉条数刷新（满页 = 可能还有）。 */
	async nextPage() {
		const sources = this.sources;
		if (sources === null || !this.hasMore) return;
		this.deleting = true;
		try {
			const nextOffset = this.items.length;
			const page = await sources.fetchPage(nextOffset, PAGE_SIZE);
			if (page.length > 0) {
				this.items = [...this.items, ...page];
				this.hasMore = page.length >= PAGE_SIZE;
				this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
			}
		} finally {
			this.deleting = false;
		}
	}
	/** 上一页（Ctrl+P：无条件回到首页——fetchPage(0, limit) 覆盖为首页，幂等）。 */
	async prevPage() {
		const sources = this.sources;
		if (sources === null) return;
		this.deleting = true;
		try {
			const page = await sources.fetchPage(0, PAGE_SIZE);
			this.items = page;
			this.hasMore = page.length >= PAGE_SIZE;
			this.selected = 0;
		} finally {
			this.deleting = false;
		}
	}
	render(width, height) {
		const theme = this.theme;
		const contentWidth = Math.max(1, width - 2);
		if (this.items.length === 0) return [
			color("🧠 memory", theme.secondary),
			color("（暂无记忆）", theme.muted),
			color("用 /remember <text> 保存第一条", theme.muted)
		];
		if (this.deleting) return [color("🧠 memory", theme.secondary), color("删除中…", theme.muted)];
		const filtered = this.filtered;
		const rows = [color(`🧠 memory${this.query === "" ? "" : ` · filter: ${this.query}`}（${filtered.length}/${this.items.length} 条）`, theme.secondary)];
		if (filtered.length === 0) {
			rows.push(color("（无匹配条目——Backspace 清除过滤）", theme.muted));
			rows.push(color("─".repeat(contentWidth), theme.muted));
			rows.push(color("↑↓ 选择 · 输入过滤 · x 删除 · Ctrl+N/P 翻页 · Esc 关闭", theme.muted));
			return rows;
		}
		const listHeight = Math.max(1, Math.floor((height - 3) / 2));
		const offset = Math.max(0, Math.min(this.selected - listHeight + 1, filtered.length - listHeight));
		for (let i = offset; i < Math.min(offset + listHeight, filtered.length); i++) {
			const item = filtered[i];
			if (item === void 0) continue;
			const sel = i === this.selected;
			const firstLine = (item.text.split("\n")[0] ?? "").replace(/\n/g, " ");
			const tags = item.tags.length > 0 ? ` #${item.tags.join(" #")}` : "";
			const line = truncateToDisplayWidth(`[${item.id.slice(0, 8)}] ${firstLine}${tags}`, contentWidth - 2);
			rows.push(sel ? color(`▸ ${line}`, theme.success) : `  ${line}`);
		}
		rows.push(color("─".repeat(contentWidth), theme.muted));
		const selected = filtered[this.selected];
		if (selected !== void 0) {
			const remaining = Math.max(1, height - rows.length - 2);
			const contentLines = selected.text.split("\n");
			for (let i = 0; i < Math.min(remaining, contentLines.length); i++) {
				const line = contentLines[i];
				if (line !== void 0) rows.push(truncateToDisplayWidth(line, contentWidth));
			}
			if (contentLines.length > remaining) rows.push(color(`…（共 ${contentLines.length} 行）`, theme.muted));
		}
		rows.push(color("↑↓ 选择 · 输入过滤 · x 删除 · Ctrl+N/P 翻页 · Esc 关闭", theme.muted));
		return rows;
	}
};
//#endregion
//#region lib/types/ui/app.js
/**
* TuiApp — 会话界面主装配（中等 MVP）。
*
* 装配关系（渲染核心 + 适配层 + 本装配）：
* - CommitEngine：scrollback 转录区（不可回退的已提交行）
* - LiveEngine：底部 live 区（输入行 + 状态行 + 流式尾巴）
* - InputHandler：raw-mode 键盘事件 → 键路由
* - InputLine：输入缓冲区/光标/历史
* - BlockStreamWriter + StreamRenderer：assistant 流式块 → markdown 提交
* - adapter.transcript：会话事件日志 → TranscriptView 投影
* - adapter.send：提交/取消 → AgentControls
* - adapter.sessions：会话列表/新建/切换/退出 flush
* - adapter.live：agent 实时状态（status/inbox/error）
*
* 反目标（不做）：设置/权限审批/主题定制/插件管理、slash 命令全集、
* worker/星域面板。本装配只覆盖目标 1-6。
*
* @module @deepseek-ai/dsh-tianshu-tui/ui
*/
/** Wave 2：renderLive 8 面板纯函数 + 单帧快照类型（app.ts → render/ 单向依赖）。 */
/** Phase 8：审批 answerer 的请求/结果类型由 ApprovalController 持有（单向依赖）。 */
/** live 区预留行（顶轨 + 输入 + 底轨 + footer）。 */
const LIVE_RESERVED_ROWS = 4;
/** 历史渐进重放单片行数（任务5）：首片同步落屏，余片 setImmediate 逐片追加。 */
const REPLAY_CHUNK_ROWS = 100;
/** A3：`dsh --profile tui --help` 输出的用法文本。 */
const USAGE_TEXT = `dsh-tianshu-tui — DeepSeek Harness 交互式终端界面 / interactive terminal UI

用法 / Usage:
  dsh --profile tui                   启动交互式 TUI / start the interactive TUI
  dsh --profile tui "<提示词>"        启动并直接发送提示词 / start and send a prompt
  dsh --profile tui --help            显示本帮助 / show this help
  dsh --profile tui --version         输出版本 / print the version

快捷键 / Keys: ctrl+n 新会话 · ctrl+s 恢复 · ctrl+p 命令面板 · / slash 命令 · ctrl+o 展开推理 · shift+tab 模式循环 · ctrl+q / /exit 退出
`;
/**
* 读 launcher 转发的 argv。生产路径是 host `ctx.provide('cmdlineArgs')` 在注入
* 属性上可见（attach 前 waitForHostServices 已给就绪窗口）；`reflect.get` 兜底
* （同树 provide 非严格可读；单测走此路径）。两者皆无 → 无参数（降级启动）。
*/
function readCmdlineArgs(ctx) {
	try {
		const injected = ctx.cmdlineArgs;
		if (injected !== void 0) return injected.get();
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes("without inject")) throw err;
	}
	return ctx.reflect.get("cmdlineArgs", false)?.get() ?? [];
}
/** 读 launcher 的退出请求。优先注入属性，其次 reflect（单测 mock）。 */
function readAppExit(ctx) {
	try {
		const injected = ctx.appExit;
		if (typeof injected === "function") return injected;
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes("without inject")) throw err;
	}
	return ctx.reflect.get("appExit", false);
}
/** C3 项 3：写工具名判定（与 fs-snapshot 的 trackEdit 钩子同一集合）。 */
function isWriteToolCall(name) {
	return name === "write" || name === "edit" || name === "str_replace_editor";
}
/**
* 提交前规范化图片数组：只保留合法 data URL（parseImageDataUrl 校验），
* 截断到 MAX_IMAGES 上限。空/全非法返回 undefined（与无图提交同形）。
* @param images - 输入框携带的图片 data URL 列表
* @returns 规范化后的图片列表；无有效图片时 undefined
*/
function normalizeSubmitImages(images) {
	if (images === void 0 || images.length === 0) return void 0;
	const valid = images.filter((u) => parseImageDataUrl(u) !== null).slice(0, 4);
	return valid.length === 0 ? void 0 : valid;
}
/** 判断输入是否更像文件路径而非 slash 命令（移植自本体 looksLikeFilePath）：
*  /src/main.ts、/tmp/foo bar、~/xxx、Windows 盘符 C:\... 走普通文本流程；
*  /exit 等已知命令、/h 等命令前缀仍视为命令（触发解析/提示）。
*  单段绝对路径（/etc、/mnt）依赖 isKnownCommand 谓词区分命令与路径。 */
function looksLikeFilePath(input, isKnownCommand, isCommandPrefix) {
	if (input.startsWith("~/")) return true;
	if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
	if (!input.startsWith("/")) return false;
	const rest = input.slice(1);
	const slashIdx = rest.indexOf("/");
	if (slashIdx !== -1) {
		const spaceIdx = rest.indexOf(" ");
		return spaceIdx === -1 || slashIdx < spaceIdx;
	}
	if (isKnownCommand) {
		const firstToken = rest.split(/\s/)[0] ?? "";
		if (firstToken === "") return false;
		if (isCommandPrefix?.(firstToken)) return false;
		return !isKnownCommand(firstToken);
	}
	return false;
}
/** 命令 → InputController 提示条目的投影（slash hint / Tab 补全数据源）。 */
function toSlashHint(command) {
	return {
		name: command.name,
		description: command.description,
		...command.argsHint === void 0 ? {} : { argsHint: command.argsHint }
	};
}
/**
* 会话界面主装配。生命周期：构造 → attach()（接管终端）→ dispose()（恢复终端）。
* attach 前不写终端；dispose 后终端恢复 raw-mode 前状态。
*/
var TuiApp = class {
	ctx;
	stdout;
	stdin;
	commit;
	commitSurface;
	live;
	input;
	inputLine;
	resize;
	blockWriter;
	streamRenderer;
	/** 渲染性能监测（--debug-perf / RIVET_DEBUG_TELEMETRY=1 时激活；默认零开销）。 */
	perfMonitor;
	/** 输入状态控制器（slash 提示 / Tab 补全数据源，W-B5 提取的输入状态）。 */
	inputController;
	/** Slash 命令注册表：内置命令 + 'tui.commands' 服务面（外部插件可扩展）。 */
	slash;
	/** Ctrl+P 命令面板（overlay 渲染经 OverlayController 进出 alt screen）。 */
	palette = null;
	/** API key 就绪标志（footer 右侧段；attach 时经 credentials.describe 刷新）。 */
	apiKeyReady = Boolean(process.env.DEEPSEEK_API_KEY);
	/** composer 附件缩略图（半块预览；提取为 controllers/attachment-preview）。 */
	attachmentPreview = new AttachmentPreviewController({
		getColumns: () => this.stdout.columns,
		getBackground: () => this.theme.userMsgBg,
		onChanged: () => {
			this.flushLiveRender();
		}
	});
	/** 运行中提交的本地排队（turn/end 投递、↑ 取回；见 controllers/submit-queue）。 */
	submitQueue = new SubmitQueueController();
	/** /key、/login：API Key 设置对话框（掩码输入 + 联网验证 + 落盘）。 */
	keyDialog = null;
	/** /key 供应商密钥配置装配层（key-wizard/key-dialog 之上；deps 注入 openKeyDialog）。 */
	keyFlow;
	/** /key 首启自动弹窗禁用（宿主/测试装配显式关闭；缺省 false=启用）。 */
	disableKeyAutoPrompt;
	themeWarnings;
	overlay = null;
	/** C3 项 3：rewind overlay（/rewind 双阶段回退面板）。 */
	rewindOverlay = null;
	/** P2：memory 浏览器 overlay（/memory 记忆列表/过滤/删除）。 */
	memoryOverlay = null;
	/** #31：交互式选择器 overlay（/model /theme /session 无参打开；上下键选择）。 */
	picker = null;
	/** 统一 action registry：键路由/快捷键面板/footer 提示的单一事实来源。 */
	actions;
	/** 动作执行上下文门面（createActionContext 装配；闭包注入私有方法）。 */
	actionCtx;
	/** 阻塞态键上下文轮询表（现状顺序保持：question > btw > approval）。 */
	blockingKeys;
	/** slash 命令菜单键上下文（轮询位置在主段动作之后、inspect 之前——现状顺序）。 */
	menuKeys;
	/** inspect 上下文键（轮询位置在 slash 菜单之后——现状顺序保持）。 */
	inspectKeys;
	/** overlay 键路由器（key-dialog/picker/search/scroll/rewind/memory/palette 委派）。 */
	overlayRouter;
	/** footer 检查面板提示段（registry 构造期投影；审批段改由 renderLive 逐帧投影——p 段动态）。 */
	footerInspectHints;
	/** Phase 9d：流利度追踪（tool 事件 → 渲染策略；stale 提示消费于 renderLive）。 */
	fluency = new FluencyTracker();
	/** Phase 5.3：底部 glance（状态/错误行派生 + 节流；renderLive 消费 current()）。 */
	glance;
	/** Phase 5.3：glance metrics 行的 model 名缓存（会话挂载时更新一次；
	*  renderLive 每帧读缓存，不重复查询 agentDefaultModel——模型定路是
	*  mount 时的决策，渲染不该引入额外的 currentSelection 读取）。 */
	glanceModelName = null;
	/** 推理努力度缓存（挂载时 request/header 优先、currentSelection 兜底；
	*  request/header 事件更新——与 glanceModelName 同生命周期）。 */
	glanceEffort = null;
	/** 会话内最后一条 assistant/message 的 usage（缓存命中/上下文占比数据源；
	*  streamFeed 折叠，随会话挂载/卸载）。 */
	usageFold = null;
	/** 会话成本累计（assistant/message usage 按模型分桶；/cost 数据源，
	*  随会话卸载复位）。 */
	sessionCosts = /* @__PURE__ */ new Map();
	/** 当前模型路由的上下文窗口（request/context 事件折叠；adapter 未报时 null）。 */
	contextWindow = null;
	/** git 未提交改动文件数（gitDirtyCount 快照；attach + turn/end 刷新，0 = 干净/非仓库）。 */
	gitDirty = 0;
	/** A5：手动展开的进行中工具卡 callId（空输入 Enter 切换；turn/end 复位）。 */
	expandedToolCallId = null;
	transcript = null;
	liveAgent = null;
	controls = null;
	/** 工作流阶段/活动投影（Phase 5.1/6.2）；随会话挂载/卸载，dispose 时解绑订阅。 */
	statusLine = null;
	/** 流式提交供给的 session/event 订阅；随会话挂载/卸载。 */
	streamFeed = null;
	/** 本层经 create/resume 铸造的 handle；非 registry 兜底的裸 agent。dispose 时释放。 */
	ownedHandle = null;
	initialSessionId;
	themeName;
	onExit;
	onRestart;
	/** 外部编辑器触发键（Phase 6.4）；缺省 ctrl_e（ctrl+o 已恢复为推理展开）。 */
	editorKey;
	/** 外部编辑器命令注入（测试用）；缺省走环境变量/平台缺省。 */
	editorCommand;
	/** T1.1：5 域投影缓存（snapshot 全量 + onChanged 按 key 分流；服务缺失时为 null → 整体降级）。 */
	projectionCache = null;
	/** T4：任务窗格——sessionProjections 任务单元投影快照（服务缺失时为 null）。 */
	taskItems = null;
	/** T2.1：委派树面板显隐（/subagents 切换）。 */
	subagentsPanelVisible = false;
	/** T2.2：workflow 运行中面板显隐（/workflow 切换）。 */
	workflowPanelVisible = false;
	/** T2.1：子代理委派域（树缓存/运行行缓存/他会话投影入口）——提取自本文件，见 controllers/delegation-surface.ts。 */
	delegationSurface = new DelegationSurfaceController({
		getService: () => this.ctx.reflect.get("subagents", false),
		isDisposed: () => this.disposed,
		schedule: () => {
			this.renderBatcher.schedule();
		},
		onRunFinished: (done) => {
			this.commitToScrollback({
				text: formatSubagentDone({
					width: this.stdout.columns,
					label: done.label,
					elapsedMs: done.elapsedMs,
					stopReason: done.stopReason,
					stats: done.stats
				}, this.theme),
				trailingNewline: true
			});
			if (!subagentNotifySuppressed(this.workflowSurface.runningCount)) {
				notifyOs({
					title: "dsh · 子代理完成",
					body: done.label
				}, this.prefs);
				writeBell(this.stdout, process.env, this.prefs);
			}
			this.renderBatcher.schedule();
		}
	});
	activityBandEnabled;
	activityBandMaxRows;
	/** T2.2：workflow 事件域（订阅/运行态缓存/终态折叠）——提取自本文件，见 controllers/workflow-surface.ts。 */
	workflowSurface = new WorkflowSurfaceController({
		onCompleted: (view, name) => {
			this.commitToScrollback({
				text: formatWorkflowSummary(view, this.theme),
				trailingNewline: true
			});
			notifyOs({
				title: "dsh · 工作流完成",
				body: name
			}, this.prefs);
			writeBell(this.stdout, process.env, this.prefs);
			this.flushLiveRender();
		},
		schedule: () => {
			this.renderBatcher.schedule();
		},
		flushLive: () => {
			this.flushLiveRender();
		}
	});
	/** T2.3：后台任务同步快照（tasks.list() 每次事件/会话挂载刷新）。 */
	taskSnapshots = [];
	/** T2.3：onTaskDone 完成通知（live 区提示行；一次性，渲染后清空）。 */
	taskNotice = null;
	/** T3.2：/config 面板投影（打开后恒有终端段；null = 尚未刷新）。 */
	configProjection = null;
	/** #39：技能展示面控制器（快照缓存 + userInvocable 过滤 + slash 菜单投影 + 手势 MRU）。 */
	skillSurface;
	/** 检查类面板（/config /skills /status /lsp /tasks）互斥开闭。 */
	inspect;
	/** LSP：诊断桥（懒创建——首次工具触碰文件或 /lsp 打开时实例化；dispose 销毁）。 */
	lspBridge = null;
	/** LSP：装配配置（enabled/timeoutMs/spawnFor/which；缺省启用）。 */
	lspConfig;
	/** T3.1：userQuestions provider 注册 disposer；attach 注册、dispose 释放。 */
	interactionDisposer = null;
	/** T3.1：挂起提问状态机（pendingQuestion + questionFeedbackMode；Wave 1 提取）。 */
	question;
	/** C3 项 4：审批挂起状态机（pendingApproval + alwaysApprove；Wave 1 提取）。 */
	approval;
	/** P1：/btw 侧问状态机（临时 btw agent 旁路；Esc 折叠答案入 scrollback）。 */
	btw;
	/** P3：多会话快照层（live store 派生；tab 栏数据源）。 */
	sessionManager;
	/** T2.1：subagent 生命周期事件订阅 disposer；随会话挂载/卸载。 */
	subagentDisposer = null;
	/** T2.2：workflow 事件订阅 disposer；attach 订阅、dispose 释放（跨会话运行）。 */
	workflowDisposer = null;
	/** T2.3：tasks onTaskDone 订阅 disposer；随会话挂载/卸载。 */
	taskDoneDisposer = null;
	/** T2.3：tasks attachSurface('tui') 控制面 disposer；attach 声明、dispose 释放。 */
	taskSurfaceDisposer = null;
	/** T1.4：plan 投影 active 态（驱动 statusline [plan] 徽标；服务缺失时为 false）。 */
	planState = {
		active: false,
		pending: false
	};
	/** C2 项 4：当前会话的模型选择 ref（newSession/switchSession 挂载；registry 兜底为 null）。 */
	modelRef = null;
	/** C2 项 2：历史搜索 overlay（Ctrl+F；attach 时注册，消息快照激活时提供）。 */
	searchOverlay = null;
	scrollPager = null;
	/** /todos 紧凑待办面板显隐（/todos 切换；数据源为 todos 投影的保留快照）。 */
	todosPanelVisible = false;
	/** /todos all 看全表（false = 默认最多 5 条）。 */
	todosExpanded = false;
	/**
	* todos 保留快照：只吸收非空投影值。todos 投影在 turn/start 时被 fold 重置
	* 为 null（tool-todo 的投影语义：清单随回合开始清空），若面板直接跟随投影，
	* 每回合开始都会闪烁消失——保留快照让已显示的清单跨回合黏滞，null 只在
	* 会话首次写入前出现（渲染「尚无待办」空态）。
	*/
	todosRetained = null;
	/** 本会话仍允许首次非空 todos 自动开面板；关掉或 /clear 后解除。 */
	todosAutoArmed = true;
	/** T4：任务投影变更订阅 disposer；随会话卸载释放。 */
	projectionDisposer = null;
	/** T5：紧凑渲染模式（/density 切换）——工具卡仅标题行。 */
	compactMode = false;
	/** reasoning 流缓冲（reasoning-delta 累积）；段结束 commitReasoningBlock 落底清空。 */
	reasoningText = "";
	/** 当前推理段起点（首个 reasoning-delta 的事件时间，Unix epoch ms）；live/落底耗时数据源。 */
	reasoningStartedAt = null;
	/** 最近一次已落底推理块（折叠头行 + 保留全文；Ctrl+O 展开查看）。会话切换清理。 */
	lastReasoningBlock = null;
	/** Ctrl+O 展开/收起最近推理块（live 区展示全文；scrollback 保持折叠头行）。 */
	reasoningExpanded = false;
	/** 进行中工具的 presentCall 标题覆盖（callId → title）；result/abort/换会话清理。 */
	pendingCallTitles = /* @__PURE__ */ new Map();
	activeSessionId = null;
	history = [];
	/** P1：本地偏好（~/.dsh-tui/prefs.json；prefsPath null = 禁用——VITEST 密封门）。 */
	prefsPath = null;
	prefs = {};
	inputHistoryPath = null;
	tick = 0;
	ticker = null;
	/** 上一帧 idle key；overlay 退出时置空，强制下一帧组装。 */
	lastIdleKey = null;
	/** 错误落底/回填控制器（C4 提取；回流 Tianshu lastSubmittedText 语义）。 */
	errorAnnouncer = new ErrorAnnouncer({
		getTheme: () => this.theme,
		commit: (text) => {
			this.commitToScrollback({
				text,
				trailingNewline: true
			});
		},
		refillInput: (text) => {
			this.inputLine.setValue(text, text.length);
			this.flushLiveRender();
		}
	});
	/** 历史渐进重放代际（commitRows 每次递增；快速切换会话时旧链自毁）。 */
	replayEpoch = 0;
	/** 历史重放进行中（streamFeed 新事件进 backlog 排队，见 commitRows）。 */
	replayActive = false;
	/** 重放窗口内排队的 stream 事件（重放完按序回放 handleStreamEvent）。 */
	streamEventBacklog = [];
	/** ticker 路径才允许 shouldSkipIdleAssemble；flush/batcher 必须组装。 */
	renderLiveFromTicker = false;
	disposed = false;
	/** attach() 完成后才往 scrollback 写更新提示（避免欢迎页之前的空窗）。 */
	attached = false;
	pendingUpdateNotice = null;
	/** 自更新失败提示（attach 前排队，attach 后 flush；P1-1）。 */
	pendingUpdateFailNotice = null;
	/** OSC52 不支持警告：每进程首次触发时提示一次（P1-1；newSession 不重置，避免重复打扰）。 */
	osc52WarningShown = false;
	/** bracketed paste 处理器 disposer（attach 注册，dispose 释放）。 */
	pasteDisposer = null;
	/**
	* 动态段高水位（display rows），跨轮保留。回缩会使输入框上跳，并把旧轨线
	* 留在空隙里（重影）。新会话 / 切会话时归零。
	*/
	dynamicRowsHighWater = 0;
	/** 渲染帧合并器：事件路径走 schedule（16ms 合并），critical 路径走 flushLiveRender。 */
	renderBatcher;
	/** 上次输入框获得焦点的时间戳（Ctrl+V 剪贴板读图防抖；overlay 关闭后
	*  FOCUS_DEBOUNCE_MS 内走文本路径，避免把 overlay 里的图误附进输入框）。 */
	lastInputFocusAt = 0;
	/** 主控模型是否原生支持识图（图片附件气泡提示；装配方经 options.vision 注入）。 */
	supportsVision = false;
	/** 是否配置独立识图桥模型（主控不识图时经桥转文字描述后发送）。
	*  装配方经 options.vision 注入；未注入时提交图片前按 visionBridge 服务
	*  存在性探测补齐（resolveVisionBridge）。 */
	visionBridgeEnabled = false;
	/** 识图桥来源（'configured' / 'auto' / 'none'；气泡提示文案用）。 */
	visionBridgeSource;
	/** 投影层：turn 级工具统计 fold（turn/end 摘要行数据源；mountSession 复位）。 */
	turnSummary = emptyTurnSummary(0);
	/** 投影层：会话级跨 turn 汇总 fold（/status 会话段数据源；mountSession 重放重建）。 */
	sessionSummary = emptySummaryState(SessionId(""));
	constructor(options) {
		this.disableKeyAutoPrompt = options.disableKeyAutoPrompt === true;
		this.themeWarnings = options.themeWarnings ?? [];
		this.ctx = options.ctx;
		this.stdout = options.stdout;
		this.stdin = options.stdin;
		this.initialSessionId = options.initialSessionId;
		this.prefsPath = prefsEnabled(options.prefsPath);
		this.inputHistoryPath = inputHistoryEnabled(options.inputHistoryPath);
		this.prefs = this.prefsPath === null ? {} : readPrefs(this.prefsPath);
		if (this.inputHistoryPath !== null) this.history = loadInputHistory(this.inputHistoryPath);
		this.themeName = options.theme ?? this.prefs.theme ?? "auto";
		if (this.prefs.compactMode === true) this.compactMode = true;
		if (this.prefs.panels?.subagents === true) this.subagentsPanelVisible = true;
		if (this.prefs.panels?.workflow === true) this.workflowPanelVisible = true;
		this.onExit = options.onExit;
		this.onRestart = options.onRestart;
		this.editorKey = options.editorKey ?? "ctrl_e";
		this.editorCommand = options.editorCommand;
		this.activityBandEnabled = options.activityBand !== false;
		this.activityBandMaxRows = options.activityBandMaxRows ?? 5;
		this.supportsVision = options.vision?.supportsVision ?? false;
		this.visionBridgeEnabled = options.vision?.bridgeEnabled ?? false;
		this.visionBridgeSource = options.vision?.bridgeSource;
		this.lspConfig = {
			enabled: options.lsp?.enabled ?? true,
			timeoutMs: options.lsp?.timeoutMs ?? 2e3,
			...options.lsp?.spawnFor === void 0 ? {} : { spawnFor: options.lsp.spawnFor },
			...options.lsp?.which === void 0 ? {} : { which: options.lsp.which }
		};
		this.commit = new CommitEngine({
			stdout: options.stdout,
			scrollbackMaxLines: this.prefs.scrollbackMaxLines
		});
		this.live = new LiveEngine({
			stdout: options.stdout,
			reservedRows: LIVE_RESERVED_ROWS,
			maxRows: liveMaxRowsFor(options.stdout.rows)
		});
		this.commitSurface = new CommitSurface({
			live: this.live,
			commit: this.commit,
			stdout: options.stdout,
			isOverlayActive: () => this.overlay !== null && this.overlay.activeId() !== null,
			flushRender: () => {
				this.flushLiveRender();
			},
			getTheme: () => this.theme,
			previewBackground: () => this.attachmentPreview.background(),
			vision: () => ({
				supportsVision: this.supportsVision,
				bridgeEnabled: this.visionBridgeEnabled,
				bridgeSource: this.visionBridgeSource
			})
		});
		this.input = new InputHandler({
			stdin: options.stdin,
			mode: "input"
		});
		const vimResolved = options.vimEnabled ?? this.prefs.vimEnabled ?? false;
		this.inputLine = new InputLine({
			history: this.history,
			vimEnabled: vimResolved,
			insertRemapSequences: remapSequences(this.prefs.vimInsertRemaps),
			onSubmit: (text, images) => {
				this.handleSubmit(text, images);
			},
			onTabComplete: () => this.handleTabComplete(),
			onOpenHistorySearch: () => {
				this.toggleHistorySearchOverlay();
			},
			onImagesChange: (images) => {
				this.attachmentPreview.refresh(images);
			},
			onChange: (value) => {
				this.syncSlashHints();
				this.inputController.refreshSlash(value);
			}
		});
		this.resize = new ResizeHandler({ stdout: options.stdout });
		this.renderBatcher = new WriteBatcher(() => {
			this.renderLive();
		});
		this.blockWriter = new BlockStreamWriter({
			minChars: 60,
			maxChars: 200,
			idleMs: 180
		}, (block) => {
			/* v8 ignore next -- BlockStreamWriter flush 的 block 恒非空，push 恒返回 true */
			if (!this.streamRenderer.push(block)) this.renderBatcher.schedule();
		});
		this.perfMonitor = new TuiPerfMonitor({ enabled: isTuiPerfEnabled() });
		this.streamRenderer = new StreamRenderer({
			commit: (ansi) => {
				this.commitToScrollback({
					text: ansi,
					trailingNewline: true
				});
			},
			getColumns: () => this.stdout.columns,
			getTheme: () => getTheme(),
			getThemeKey: () => "tui-conversation",
			perfMonitor: this.perfMonitor
		});
		this.inputController = new InputController();
		this.slash = new SlashCommandRegistry();
		for (const command of createBuiltinCommands({
			onThemeChanged: () => {
				this.rerenderHistory();
			},
			newSession: () => this.newSession(),
			forkSession: (opts) => this.forkSession(opts),
			switchLiveModel: (selection) => this.switchLiveModel(selection),
			currentAgent: () => {
				const id = this.activeSessionId;
				if (id === null) return null;
				return this.ctx.agents.get(id) ?? null;
			},
			isBlankSession: () => this.isBlankSession(),
			clearScrollback: () => {
				this.inspect.close();
				this.todosPanelVisible = false;
				this.todosAutoArmed = false;
				this.subagentsPanelVisible = false;
				this.workflowPanelVisible = false;
				this.commit.reset();
				this.live.reset();
				this.stdout.write(`${ANSI.ERASE_SCREEN}\x1b[3J\x1b[H`);
				this.flushLiveRender();
			},
			toggleTaskPanel: () => {
				this.inspect.toggle("tasks");
			},
			toggleSubagentsPanel: () => {
				this.subagentsPanelVisible = !this.subagentsPanelVisible;
				if (this.subagentsPanelVisible && this.ctx.reflect.get("subagents", false) === void 0) this.echoWarn("⚠ subagents 服务不可用（未装配 subagent 插件），委派树面板无数据", "/doctor 体检");
				this.prefs.panels = {
					...this.prefs.panels,
					subagents: this.subagentsPanelVisible
				};
				this.persistPrefs();
				this.renderBatcher.schedule();
			},
			toggleWorkflowPanel: () => {
				this.workflowPanelVisible = !this.workflowPanelVisible;
				if (this.workflowPanelVisible && scopedService(this.ctx, this.activeSessionId, "workflowEngine") === void 0) this.echoWarn("⚠ workflow 引擎不可用（未装配 workflow 插件），面板无运行数据", "/doctor 体检");
				this.prefs.panels = {
					...this.prefs.panels,
					workflow: this.workflowPanelVisible
				};
				this.persistPrefs();
				this.renderBatcher.schedule();
			},
			rewindSession: () => this.rewindSession(),
			askBtw: (question) => this.askBtw(question),
			openMemoryBrowser: () => this.openMemoryBrowser(),
			openScrollPager: () => {
				this.toggleScrollPager();
			},
			switchSession: (id) => this.switchSession(SessionId(id)),
			exportTranscript: (path) => this.exportTranscript(path),
			requestExit: () => {
				this.onExit?.();
			},
			requestRestart: () => {
				this.onRestart?.();
			},
			listCommands: () => this.slash.list(),
			openCommandPalette: () => {
				this.palette?.open(false);
				if (this.palette !== null && this.overlay !== null) this.overlay.activate("command-palette");
				this.flushLiveRender();
			},
			setYoloMode: (flag) => {
				this.setYoloMode(flag);
			},
			openModelPicker: () => {
				this.openModelPicker();
			},
			openThemePicker: () => {
				this.openThemePicker();
			},
			openEffortPicker: () => {
				this.openEffortPicker();
			},
			onThemeApplied: (name) => {
				this.applyThemeAndPersist(name);
			},
			applyThemeAuto: (persist) => {
				this.applyThemeAuto(persist === true);
			},
			exportTheme: (name) => this.exportTheme(name),
			persistPresetDefault: (id) => {
				this.prefs.preset = id;
				this.persistPrefs();
			},
			currentDefaultPreset: () => this.prefs.preset,
			openSessionPicker: () => {
				this.openSessionPicker();
			},
			openKeyDialog: () => {
				this.keyFlow.openKeyDialog();
			},
			checkForUpdate: () => this.runUpdateCheck(),
			sessionCostReport: () => formatSessionCostReport([...this.sessionCosts.values()])
		})) this.slash.register(command);
		this.slash.register({
			name: "steer",
			category: "会话",
			description: "中轮转向（中途纠正方向）",
			argsHint: "<text>",
			run: (args) => {
				this.handleSteer(args.text);
			}
		});
		this.slash.register({
			name: "status",
			category: "面板",
			description: "切换状态面板（goal/todos/plan 投影快照）",
			run: () => {
				this.inspect.toggle("status");
			}
		});
		this.slash.register({
			name: "todos",
			category: "面板",
			description: "切换待办面板（无参显隐；all 看全表）",
			argsHint: "[all]",
			run: ({ text }) => {
				const sub = text.trim();
				if (sub !== "" && sub !== "all") {
					this.echoWarn("用法: /todos [all]");
					return;
				}
				if (sub === "all") {
					this.todosExpanded = !this.todosExpanded;
					this.todosPanelVisible = this.todosPanelVisible || this.todosExpanded;
				} else {
					this.todosPanelVisible = !this.todosPanelVisible;
					if (!this.todosPanelVisible) {
						this.todosExpanded = false;
						this.todosAutoArmed = false;
					}
				}
				if (this.todosPanelVisible && this.ctx.reflect.get("sessionProjections", false) === void 0) this.echoWarn("⚠ sessionProjections 服务不可用（未装配 session-projection 插件），待办面板无数据", "/doctor 体检");
				this.renderBatcher.schedule();
			}
		});
		this.slash.register({
			name: "config",
			category: "配置",
			description: "切换设置面板（n 通知 · d 密度）",
			argsHint: "[notify [on|off]]",
			run: async ({ text, echo }) => {
				const action = parseConfigNotifyArg(text);
				if (action === "usage") {
					echo("用法：/config  或  /config notify [on|off]");
					return;
				}
				if (action !== null) {
					this.applyNotifyPref(action, echo);
					return;
				}
				await this.inspect.toggle("config");
			}
		});
		this.slash.register({
			name: "skills",
			category: "面板",
			description: "切换技能浏览面板",
			run: () => {
				this.inspect.toggle("skills");
			}
		});
		this.slash.register({
			name: "lsp",
			category: "面板",
			description: "切换 LSP 诊断面板（本地语言服务）",
			run: () => {
				this.inspect.toggle("lsp");
			}
		});
		this.slash.register({
			name: "density",
			category: "配置",
			description: "切换紧凑渲染（带参 default=设为启动默认）",
			argsHint: "[default]",
			run: ({ text, echo }) => {
				const { persist } = splitDefaultFlag(text);
				if (persist) {
					this.prefs.compactMode = this.compactMode;
					this.persistPrefs();
					echo(echoSavedDefault("density", this.compactMode ? "紧凑" : "宽松"));
					return;
				}
				this.compactMode = !this.compactMode;
				if (this.configProjection !== null) this.configProjection = {
					...this.configProjection,
					tui: {
						...configTuiFromPrefs(this.prefs),
						compactMode: this.compactMode
					}
				};
				this.renderBatcher.schedule();
				echo(echoSessionOnly("density", this.compactMode ? "紧凑" : "宽松"));
			}
		});
		this.slash.register({
			name: "vim",
			category: "配置",
			description: "切换 vi/vim 编辑键位（带参 default=设为启动默认）",
			argsHint: "[on|off|default]",
			run: ({ text, echo }) => {
				const arg = text.trim();
				if (![
					"",
					"on",
					"off",
					"default"
				].includes(arg)) {
					echo("用法：/vim 或 /vim [on|off|default]");
					return;
				}
				if (arg === "default") {
					this.prefs.vimEnabled = this.inputLine.vimEnabled;
					this.persistPrefs();
					echo(echoSavedDefault("vim", this.inputLine.vimEnabled ? "on" : "off"));
					return;
				}
				const next = arg === "" ? !this.inputLine.vimEnabled : arg === "on";
				this.inputLine.setVimEnabled(next);
				this.renderBatcher.schedule();
				echo(echoSessionOnly("vim", next ? "on" : "off"));
			}
		});
		this.slash.register({
			name: "welcome",
			category: "配置",
			description: "切换欢迎页风格（blue 默认 / star 紫鲸 / retro 复古，下次启动生效）",
			argsHint: "[blue|star|retro]",
			run: ({ text, echo }) => {
				const arg = text.trim();
				if (arg === "") {
					echo(`欢迎页风格：${this.prefs.welcomeStyle ?? "blue"}（blue / star / retro，下次启动生效）`);
					return;
				}
				if (arg !== "blue" && arg !== "star" && arg !== "retro") {
					echo("用法：/welcome 或 /welcome [blue|star|retro]");
					return;
				}
				this.prefs.welcomeStyle = arg;
				this.persistPrefs();
				echo(`欢迎页风格已切换：${arg}（下次启动生效）`);
			}
		});
		this.slash.register({
			name: "info",
			category: "配置",
			description: "切换输入区信息密度（full 两行 / compact 状态行 / off 全关）",
			run: ({ echo }) => {
				const current = this.prefs.footerInfo ?? "full";
				const next = FOOTER_INFO_LEVELS[(FOOTER_INFO_LEVELS.indexOf(current) + 1) % FOOTER_INFO_LEVELS.length];
				this.prefs.footerInfo = next;
				this.persistPrefs();
				this.renderBatcher.schedule();
				echo(`输入区信息密度：${next}（${FOOTER_INFO_LEVELS.join(" / ")}）`);
			}
		});
		this.slash.register({
			name: "changelog",
			category: "系统",
			description: "查看版本更新内容（默认当前版本；all 全部；N 最近 N 版）",
			argsHint: "[all|N]",
			run: ({ text, echo }) => {
				const arg = text.trim();
				const changelog = readOwnChangelog(fileURLToPath(new URL(".", import.meta.url)));
				if (changelog === null) {
					echo("未找到 CHANGELOG.md（开发安装可能缺失，见仓库根）");
					return;
				}
				const entries = parseChangelog(changelog);
				if (entries.length === 0) {
					echo("CHANGELOG 暂无条目");
					return;
				}
				let selected;
				if (arg === "") {
					const own = readOwnVersion(fileURLToPath(new URL(".", import.meta.url)));
					const hit = own === void 0 ? void 0 : entries.find((e) => e.version === own);
					selected = hit === void 0 ? entries.slice(0, 1) : [hit];
				} else if (arg === "all") selected = entries;
				else if (/^\d+$/.test(arg)) selected = entries.slice(0, Math.min(Number(arg), entries.length));
				else {
					echo("用法: /changelog（当前版本）  /changelog all（全部）  /changelog N（最近 N 版）");
					return;
				}
				for (const entry of selected) {
					echo(entry.date === null ? `## ${entry.version}` : `## ${entry.version}（${entry.date}）`);
					for (const line of simplifyChangelogMarkdown(entry.body)) echo(line === "" ? "" : `  ${line}`);
				}
			}
		});
		this.slash.register({
			name: "glance",
			category: "配置",
			description: "切换 footer metrics 段显隐（如 /glance cost）",
			argsHint: "[segment]",
			run: ({ text, echo }) => {
				const seg = text.trim();
				const hidden = new Set(this.prefs.glance?.hideSegments ?? []);
				if (seg === "") {
					echo(`metrics 段：隐藏 ${hidden.size === 0 ? "无" : [...hidden].join(", ")}；可切换：${GLANCE_HIDEABLE_SEGMENTS.join(", ")}`);
					return;
				}
				if (!GLANCE_HIDEABLE_SEGMENTS.includes(seg)) {
					echo(`未知段: ${seg}。可切换: ${GLANCE_HIDEABLE_SEGMENTS.join(", ")}`);
					return;
				}
				const key = seg;
				if (hidden.has(key)) hidden.delete(key);
				else hidden.add(key);
				this.prefs.glance = { hideSegments: [...hidden] };
				this.persistPrefs();
				echo(`${key} 段已${hidden.has(key) ? "隐藏" : "恢复"}`);
				this.renderBatcher.schedule();
			}
		});
		this.skillSurface = new SkillSurfaceController({
			getService: (name) => this.ctx.reflect.get(name, false),
			listCommandHints: () => this.slash.list().map(toSlashHint),
			setSlashEntries: (entries) => {
				this.inputController.slashCommands = entries;
			},
			scheduleRender: () => {
				this.renderBatcher.schedule();
			},
			isDisposed: () => this.disposed,
			recordSlashUse: (name) => {
				this.inputController.recordSlashUse(name);
			},
			onEvent: (event, cb) => this.ctx.on(event, cb),
			getSessionCwd: () => this.sessionCwd()
		});
		this.skillSurface.refreshEntries();
		this.inspect = new InspectSurfaceController({
			hasService: (name) => this.ctx.reflect.get(name, false) !== void 0,
			echoWarn: (text, hint) => this.echoWarn(text, hint),
			refreshConfig: () => this.refreshConfigProjection(),
			refreshSkills: () => {
				this.skillSurface.refresh();
			},
			ensureLsp: () => {
				this.ensureLspBridge();
			},
			schedule: () => {
				this.renderBatcher.schedule();
			},
			flush: () => {
				this.flushLiveRender();
			},
			toggleNotify: () => {
				this.applyNotifyPref("toggle", (text) => {
					this.commitToScrollback({
						text,
						trailingNewline: true
					});
				});
			},
			toggleDensity: () => {
				this.compactMode = !this.compactMode;
				this.prefs.compactMode = this.compactMode;
				this.persistPrefs();
				if (this.configProjection !== null) this.configProjection = {
					...this.configProjection,
					tui: {
						...configTuiFromPrefs(this.prefs),
						compactMode: this.compactMode
					}
				};
			},
			moveSkills: (delta) => this.skillSurface.moveSelected(delta)
		});
		this.ctx.provide("tui.commands", this.slash);
		this.glance = new MetricsGlanceController({
			getStatusText: () => this.statusLine?.current ?? null,
			getLiveState: () => this.liveAgent?.state,
			getColumns: () => this.stdout.columns,
			throttleMs: 0
		});
		this.question = new QuestionController({
			onEscapeImmediate: (flag) => {
				this.input.setEscapeImmediate(flag);
			},
			onChanged: () => {
				this.flushLiveRender();
			}
		});
		this.approval = new ApprovalController({
			getCurrentSessionId: () => this.activeSessionId,
			onChanged: () => {
				this.flushLiveRender();
			},
			getCommandPrefix: (req) => commandPrefixForRequest(req, this.transcript?.view)
		});
		this.btw = new BtwController({
			ctx: this.ctx,
			activeSessionId: () => this.activeSessionId,
			onChanged: () => {
				this.flushLiveRender();
			},
			onAnswer: (entry) => {
				this.commitToScrollback({
					text: `[btw] ${entry.question}\n${entry.answer}`,
					trailingNewline: true
				});
			}
		});
		this.sessionManager = new SessionManager(this.ctx);
		this.actionCtx = this.createActionContext();
		this.actions = new ActionRegistry(createBuiltinActions({ editorKey: this.editorKey }));
		this.blockingKeys = [
			createQuestionKeyContext({
				question: this.question,
				inputLine: this.inputLine,
				settle: (answer) => {
					this.settleQuestion(answer);
				},
				cancel: () => {
					this.cancelQuestion();
				},
				flushLive: () => {
					this.flushLiveRender();
				}
			}),
			createBtwKeyContext({
				btw: this.btw,
				flushLive: () => {
					this.flushLiveRender();
				}
			}),
			createApprovalKeyContext({
				approval: this.approval,
				registry: this.actions,
				ctx: this.actionCtx,
				inputLine: this.inputLine,
				flushLive: () => {
					this.flushLiveRender();
				},
				submitFeedback: (text) => {
					this.approval.settle("rejected");
					this.handleSteer(text);
				}
			})
		];
		this.inspectKeys = createInspectKeyContext({
			inspect: this.inspect,
			inputLine: this.inputLine
		});
		this.menuKeys = createSlashMenuKeyContext({
			inputController: this.inputController,
			accept: (opts) => {
				this.acceptSlashCompletion(opts);
			},
			flushLive: () => {
				this.flushLiveRender();
			}
		});
		this.overlayRouter = new OverlayKeyRouter({
			overlay: () => this.overlay,
			keyDialog: () => this.keyDialog,
			picker: () => this.picker,
			search: () => this.searchOverlay,
			scroll: () => this.scrollPager,
			rewind: () => this.rewindOverlay,
			memory: () => this.memoryOverlay,
			palette: () => this.palette,
			pasteKeyDialog: (dialog) => {
				this.pasteClipboardIntoKeyDialog(dialog);
			},
			submit: (text) => {
				this.handleSubmit(text);
			},
			backfill: (text) => {
				this.inputLine.setValue(text);
			}
		});
		this.footerInspectHints = projectInspectHints(this.actions.list());
	}
	/** Phase 8：审批 answerer 订阅的 disposer（dispose 时解绑）。 */
	approvalDisposer = null;
	/** 当前会话 id（null = 尚未 attach）。 */
	get sessionId() {
		return this.activeSessionId;
	}
	/**
	* A1/A2：等待若干服务完成激活（fiber state 2，即 init 钩子已跑完、文件数据
	* 已装载）后再做首帧渲染。credentials/settings 由 dsh-base 异步激活（读文件 +
	* watcher），可能晚于本 runner——不等的话欢迎页会误报 API Key ✗、顶栏显示
	* 默认模型（settings 里的 agent-default-model 未生效）。
	*
	* 服务未注册（不在本 profile 组成中）时跳过；有界等待避免服务缺失时挂死。
	* 超时仍未激活则 warn 后继续（fail-soft：启动不挂死，但模型/API Key 可能仍是缺省）。
	* @param names - 要等待的服务名。
	* @param timeoutMs - 最大等待毫秒（缺省 5000）。
	*/
	async waitForServicesReady(names, timeoutMs = 5e3) {
		const deadline = Date.now() + timeoutMs;
		const stale = [];
		for (const name of names) {
			if (this.ctx.reflect.get(name, false) === void 0) continue;
			while (this.ctx.reflect.get(name) === void 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			if (this.ctx.reflect.get(name) === void 0) stale.push(name);
		}
		if (stale.length > 0) console.warn(`[tui-runner] timed out waiting for ${stale.join(", ")} after ${String(timeoutMs)}ms; continuing with possibly stale defaults`);
	}
	/**
	* 宿主服务（cmdlineArgs/appExit）就绪窗口：launcher 在 boot prepare 里
	* provide，正常时序下 attach 时已注册（0 等待）；仅当检测到宿主特征
	* （任一服务已注册）时为缺失方做短窗口轮询，覆盖 provide 略晚于装配的
	* 罕见时序。两服务均未注册 = 非宿主环境，立即返回。
	* @param timeoutMs - 最大等待毫秒（缺省 200）。
	*/
	async waitForHostServices(timeoutMs = 200) {
		const reflect = this.ctx.reflect;
		if (reflect.get("cmdlineArgs", false) === void 0 && reflect.get("appExit", false) === void 0) return;
		const deadline = Date.now() + timeoutMs;
		for (const name of ["cmdlineArgs", "appExit"]) while (reflect.get(name, false) === void 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	/**
	* 接管终端：切主题（'auto' 探测背景）、装配会话、注册键路由与 resize、启动渲染 ticker。
	* @param initialSessionId - 覆盖构造选项的起始会话；缺省用构造 initialSessionId，
	*   再缺省恢复最近会话（live store 为空才新建）。
	*/
	async attach(initialSessionId) {
		if (this.disposed) throw new Error("TuiApp already disposed");
		if (typeof Session.prototype.snapshotEvents !== "function") throw new Error("dsh-tianshu-tui 需要 0.1.2-rc.1+ 官方宿主（检测到旧线）。请升级官方 CLI：pnpm dlx @deepseek-ai/dsh@latest（或 @next）；或回退本插件：dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui@0.1.2-rc.28");
		await this.waitForHostServices();
		const args = readCmdlineArgs(this.ctx);
		const flags = args.filter((a) => a.startsWith("-"));
		const wantHelp = flags.includes("--help") || flags.includes("-h");
		const wantVersion = flags.includes("--version") || flags.includes("-v");
		const initialPrompt = flags.length === 0 ? args.filter((a) => !a.startsWith("-")).join(" ") : "";
		if (wantHelp || wantVersion) {
			const exit = readAppExit(this.ctx);
			this.stdout.write(wantHelp ? USAGE_TEXT : `dsh-tianshu-tui ${readOwnVersion(fileURLToPath(new URL(".", import.meta.url))) ?? "unknown"}\n`);
			if (exit !== void 0) {
				exit(0);
				return;
			}
			throw new Error("[tui-runner] --help/--version requested but no appExit service provided");
		}
		await this.waitForServicesReady(["settings", "credentials"]);
		this.stdout.write(ANSI.BRACKETED_PASTE_ON + kittyKeyboardPushSeq());
		this.pasteDisposer?.();
		this.pasteDisposer = this.input.onPaste((text) => {
			this.handlePaste(text);
		});
		if (this.themeName === "auto") {
			/* v8 ignore next -- autoThemeFor 恒返回有效主题名，setTheme 恒 true，graphite 兜底不可达 */
			if (!setTheme(autoThemeFor(await detectTerminalBackground()))) setTheme("graphite");
		} else if (!setTheme(this.themeName)) {
			if (!setTheme(autoThemeFor(await detectTerminalBackground()))) setTheme("graphite");
			this.prefs.theme = "auto";
			this.persistPrefs();
		}
		const target = initialSessionId ?? this.initialSessionId ?? this.ctx.sessions.list()[0]?.id;
		if (target !== void 0) await this.switchSession(target);
		else {
			const reuse = await findMostRecentEmptySession(this.ctx).catch(() => void 0);
			await this.newSession(reuse);
		}
		await this.renderRestorableSessions();
		this.resize.onResize(() => {
			this.live.setMaxRows(liveMaxRowsFor(this.stdout.rows));
			if (this.overlay !== null && this.overlay.activeId() !== null) {
				this.overlay.rerender();
				return;
			}
			this.flushLiveRender();
		});
		this.input.onAnyKey((key) => {
			this.handleKey(key);
		});
		this.approvalDisposer?.();
		this.approvalDisposer = this.ctx.on("approval/request", (req, next) => {
			return this.handleApprovalRequest(req, next);
		});
		this.skillSurface.attach();
		this.palette = new CommandPalette({
			getCommands: () => this.slash.list(),
			getSkills: () => this.skillSurface.paletteEntries(),
			getTheme: () => this.theme
		});
		this.overlay = new OverlayController({
			stdout: this.stdout,
			getSize: () => ({
				cols: this.stdout.columns,
				rows: this.stdout.rows
			}),
			live: this.live,
			onOverlayChange: (active) => {
				if (active) return;
				this.commitSurface.flushDeferred();
				this.flushLiveRender();
				this.lastInputFocusAt = Date.now();
			}
		});
		this.overlay.register("command-palette", this.palette);
		this.overlay.register("keymap", { render: (cols) => renderKeymapPanel(cols) });
		this.searchOverlay = new HistorySearchOverlay();
		this.overlay.register("search", this.searchOverlay);
		this.scrollPager = new ScrollPagerOverlay();
		this.overlay.register("scroll", this.scrollPager);
		this.rewindOverlay = new RewindOverlay(void 0, { onSettled: () => {
			this.overlay?.rerender();
		} });
		this.overlay.register("rewind", this.rewindOverlay);
		this.memoryOverlay = new MemoryBrowserOverlay();
		this.overlay.register("memory", this.memoryOverlay);
		this.picker = new PickerController({ getTheme: () => this.theme });
		this.overlay.register("picker", this.picker);
		this.keyDialog = new KeyDialogController({
			getTheme: () => this.theme,
			onSaved: () => {
				this.refreshApiKeyReady();
			}
		});
		this.overlay.register("key-dialog", this.keyDialog);
		this.keyFlow = new KeyFlow({
			overlay: this.overlay,
			picker: this.picker,
			keyDialog: this.keyDialog,
			reflect: this.ctx.reflect,
			isDisposed: () => this.disposed,
			stdinIsTTY: () => this.stdin.isTTY,
			apiKeyReady: () => this.apiKeyReady,
			...this.disableKeyAutoPrompt ? { autoPrompt: false } : {},
			agentDefaultModel: this.ctx.agentDefaultModel
		});
		this.input.setMode("input");
		this.ticker = setInterval(() => {
			if (this.hasVisibleSpinner()) this.tick++;
			this.renderLiveFromTicker = true;
			try {
				this.renderLive();
			} finally {
				this.renderLiveFromTicker = false;
			}
		}, 120);
		this.ticker.unref();
		this.interactionDisposer?.();
		this.interactionDisposer = this.ctx.on("user-questions/request", (request, _next) => this.handleQuestionRequest(request), { global: true });
		this.attached = true;
		if (this.pendingUpdateNotice !== null) {
			this.commitToScrollback({
				text: this.pendingUpdateNotice,
				trailingNewline: true
			});
			this.pendingUpdateNotice = null;
		}
		if (this.pendingUpdateFailNotice !== null) {
			this.echoWarn(this.pendingUpdateFailNotice);
			this.pendingUpdateFailNotice = null;
		}
		for (const w of this.themeWarnings) this.echoWarn(`⚠ 主题警告：${w}`, "/theme 检查自定义主题");
		this.flushLiveRender();
		if (initialPrompt !== "") this.handleSubmit(initialPrompt);
		else this.keyFlow.maybeAutoOpenKeyDialog();
	}
	/**
	* 自更新落盘后的用户提示。模块已加载，新代码要重启才生效。
	* attach 完成前调用则排队，完成后写入 scrollback。
	*/
	notifyPluginUpdated(version) {
		this.notifyUpdateLine(updateNoticeText(version));
	}
	/** 自更新后将自动重启的提示（装配方随后触发重启）。 */
	notifyAutoRestart(version) {
		this.notifyUpdateLine(autoRestartNoticeText(version));
	}
	/**
	* 当前会话是否 blank：无消息且无未结算工具调用。
	* /preset recompose 与更新后自动重启的守卫共用（非空白不打断会话）。
	*/
	isBlankSession() {
		const view = this.transcript?.view;
		return (view?.messages ?? []).length === 0 && (view?.tools ?? []).every((t) => t.result !== void 0);
	}
	/** 更新提示落盘：attach 完成前排队（pendingUpdateNotice），完成后写 scrollback。 */
	notifyUpdateLine(text) {
		if (this.disposed) return;
		if (!this.attached) {
			this.pendingUpdateNotice = text;
			return;
		}
		this.commitToScrollback({
			text,
			trailingNewline: true
		});
		this.flushLiveRender();
	}
	/**
	* 自更新失败的用户提示（P1-1；文案 #43 反馈优化）：可操作引导优先——
	* 重试/手动命令/关闭开关，而不是只甩环境变量。attach 完成前调用则排队。
	*/
	notifyPluginUpdateFailed(error) {
		if (this.disposed) return;
		const text = [
			`⚠ 自更新失败：${error}`,
			"  · 重启 dsh 会自动重试（网络恢复后即可成功）",
			`  · 手动更新：npx -y @deepseek-ai/dsh plugin --profile tui add ${updateNoticePackage}@latest`,
			"  · 不想再看到此提示：启动前设 DSH_TUI_SKIP_UPDATE=1"
		].join("\n");
		if (!this.attached) {
			this.pendingUpdateFailNotice = text;
			return;
		}
		this.echoWarn(text);
	}
	/** T3.1：结构化提问 answerer——薄转发 QuestionController（渲染/ESC/重绘由控制器回调承担）。 */
	handleQuestionRequest(request) {
		return this.question.ask(request);
	}
	/**
	* bracketed paste 文本落地（右键粘贴/终端菜单粘贴）：先尝试剪贴板读图
	* （命中则附图并吞掉这段 paste——粘贴进来的文本是图片字节的乱码，不插图
	* 会污染输入框）；再识别图片路径加载为附件；最后才是普通文本插入。
	* @param text - 终端传来的粘贴文本
	*/
	async handlePaste(text) {
		if (this.inputLine.images.length < 4) {
			const imgResult = await readImageFromClipboard();
			if (imgResult) try {
				await this.attachClipboardImage(imgResult.dataUrl, imgResult.name);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.commitToScrollback({
					text: color(`⚠ 剪贴板图片处理失败: ${message}`, this.theme.warning),
					trailingNewline: true
				});
				this.flushLiveRender();
				return;
			}
		}
		const trimmed = text.trim();
		if (trimmed && looksLikeImagePath(trimmed) && !trimmed.includes("\n")) {
			if (this.inputLine.images.length >= 4) {
				this.commitToScrollback({
					text: color(`⚠ 最多附加 4 张图片`, this.theme.warning),
					trailingNewline: true
				});
				this.flushLiveRender();
				return;
			}
			try {
				const attachment = await loadImageAttachment(resolve(trimmed));
				this.inputLine.addImage(attachment.dataUrl);
				this.flushLiveRender();
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.commitToScrollback({
					text: color(`⚠ 图片加载失败: ${message}`, this.theme.warning),
					trailingNewline: true
				});
				this.flushLiveRender();
			}
		}
		this.inputLine.insertText(text);
		this.flushLiveRender();
	}
	/**
	* Ctrl+V 处理：优先读剪贴板图片 → 失败则 fallback 到文本粘贴。
	* 焦点防抖：输入框在最近 FOCUS_DEBOUNCE_MS 内刚「重获焦点」（overlay
	* 关闭近似——终端 raw mode 下无窗口焦点事件）时跳过读图，避免把粘贴进
	* 对话框/选择器的那次 Ctrl+V 再当一次读图。
	*/
	async handleCtrlV() {
		if (Date.now() - this.lastInputFocusAt < 1e3) {
			const text = await readTextFromClipboard();
			if (text) {
				this.inputLine.insertText(text);
				this.flushLiveRender();
			}
			return;
		}
		try {
			const result = await readImageFromClipboard();
			if (result) {
				if (this.inputLine.images.length >= 4) {
					this.commitToScrollback({
						text: color(`⚠ 最多附加 4 张图片`, this.theme.warning),
						trailingNewline: true
					});
					this.flushLiveRender();
					return;
				}
				await this.attachClipboardImage(result.dataUrl, result.name);
				return;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.commitToScrollback({
				text: color(`⚠ 剪贴板图片处理失败: ${message}`, this.theme.warning),
				trailingNewline: true
			});
			this.flushLiveRender();
			return;
		}
		const text = await readTextFromClipboard();
		if (text) {
			this.inputLine.insertText(text);
			this.flushLiveRender();
		} else this.echoWarn("⚠ 剪贴板无内容可粘贴（读图需 osascript / wl-paste / xclip / PowerShell）");
	}
	/**
	* 剪贴板位图附件化：dataUrl 解回字节后走与文件路径同一条预算管线
	* （magic 校验 + 原样直发 + 三级自适应压缩）——超限大图在此被压缩或
	* 响亮失败，而不是挂上后在提交时被静默丢弃。
	* @param dataUrl - 剪贴板读图结果（data:image/...;base64,...）。
	* @param name - 附件显示名。
	*/
	async attachClipboardImage(dataUrl, name) {
		const comma = dataUrl.indexOf(",");
		const attachment = await loadClipboardImageAttachment(Buffer.from(comma === -1 ? dataUrl : dataUrl.slice(comma + 1), "base64"), name.length > 0 ? name : "clipboard.png");
		this.inputLine.addImage(attachment.dataUrl);
		this.flushLiveRender();
	}
	/**
	* 设置当前主控模型的识图能力与桥接状态（图片附件气泡提示数据源）。
	* 由装配方按 agent 配置注入；TUI 是纯表现层，不自行查询模型能力。
	* @param supportsVision - 主控模型是否原生支持识图（图片直发）
	* @param bridgeEnabled - 是否配置了独立识图桥模型（主控不识图时经桥转描述）
	* @param bridgeSource - 识图桥来源（configured/auto/none；气泡提示文案用）
	*/
	setVisionInfo(supportsVision, bridgeEnabled, bridgeSource) {
		this.supportsVision = supportsVision;
		this.visionBridgeEnabled = bridgeEnabled;
		this.visionBridgeSource = bridgeSource;
	}
	/**
	* 宿主视觉桥探测：视觉桥插件（dsh-vision-bridge）装配时应 provide('visionBridge')
	* 服务，存在即视为桥可用（来源按 configured 处理，装配方注入过 bridgeSource 时
	* 保留注入值）。显式注入 vision.bridgeEnabled 时短路；否则每次提交图片前补探，
	* 覆盖桥插件晚于 tui-runner 激活的装配时序（reflect.get 是字典读，代价可忽略）。
	* @returns 当前是否有可用识图桥。
	*/
	resolveVisionBridge() {
		if (this.visionBridgeEnabled) return true;
		if (this.ctx.reflect.get("visionBridge", false) !== void 0) {
			this.visionBridgeEnabled = true;
			this.visionBridgeSource = this.visionBridgeSource ?? "configured";
		}
		return this.visionBridgeEnabled;
	}
	/** T3.1：结算挂起的提问（用户选择/取消）——薄转发。 */
	settleQuestion(answer) {
		this.question.settle(answer);
	}
	/** T3.1：取消挂起的提问（Esc/Ctrl+C）——薄转发。 */
	cancelQuestion() {
		this.question.cancel();
	}
	/**
	* 查 DEEPSEEK_API_KEY 是否已配置：优先 credentials.describe（含 file / .env 层），
	* 服务缺失或抛错时回退 process.env。欢迎页与 footer 共用，避免只看环境变量的误报。
	*/
	async refreshApiKeyReady() {
		const credentials = this.ctx.reflect.get("credentials", false);
		if (credentials !== void 0) try {
			const info = await credentials.describe("DEEPSEEK_API_KEY");
			this.apiKeyReady = info.configured;
			return;
		} catch {}
		this.apiKeyReady = Boolean(process.env.DEEPSEEK_API_KEY);
	}
	/**
	* 按当前主控模型刷新识图标志。llm 服务缺失或查询失败时保持原值；
	* inputModalities 含 image 才直发图片，否则走桥或「未发送」。
	*/
	refreshVisionForSelection(selection) {
		const llm = this.ctx.reflect.get("llm", false);
		if (llm === void 0) return;
		llm.resolveModelInfo(selection.provider, selection.model).then((info) => {
			if (this.disposed) return;
			const modalities = info.inputModalities;
			this.supportsVision = modalities !== void 0 && modalities.includes("image");
		}).catch(() => {});
	}
	/** 当前会话工作区：header.cwd 优先，缺省回退启动目录。 */
	sessionCwd() {
		if (this.activeSessionId === null) return process.cwd();
		const cwd = getSession(this.ctx, this.activeSessionId)?.header?.cwd;
		return cwd === void 0 || cwd === "" ? process.cwd() : cwd;
	}
	/**
	* 懒创建诊断桥：首次工具触碰文件或 /lsp 打开时实例化（rootUri = 当时
	* 会话 cwd）；缓存更新回调触发 renderLive（WriteBatcher 节流）。
	*/
	ensureLspBridge() {
		if (this.lspBridge !== null) return this.lspBridge;
		const selected = selectDiagnosticSource(this.ctx.reflect.get("lsp", false), this.sessionCwd());
		const source = selected.kind === "service" ? selected.source : void 0;
		this.lspBridge = createLspBridge({
			cwd: this.sessionCwd(),
			...this.lspConfig.timeoutMs === void 0 ? {} : { timeoutMs: this.lspConfig.timeoutMs },
			...this.lspConfig.spawnFor === void 0 ? {} : { spawnFor: this.lspConfig.spawnFor },
			...this.lspConfig.which === void 0 ? {} : { which: this.lspConfig.which },
			...source === void 0 ? {} : { source }
		});
		this.lspBridge.onUpdate(() => {
			this.renderBatcher.schedule();
		});
		return this.lspBridge;
	}
	/**
	* 从工具参数提取文件路径并触发诊断拉取（write/read/edit 族；无 path 参数
	* 的工具如 bash 不触发）。嵌套工具调用（multi_tool_use 的 tool_uses）递归
	* 展开。只读展示：拉取失败/超时静默，不阻塞工具流。
	* @param argumentsRaw - tool/call 事件参数原文。
	*/
	touchLspPaths(argumentsRaw) {
		if (!this.lspConfig.enabled) return;
		const args = parseToolArguments(argumentsRaw);
		if (args === void 0) return;
		const paths = [];
		for (const key of [
			"path",
			"file_path",
			"file"
		]) {
			const value = args[key];
			if (typeof value === "string" && value !== "") paths.push(value);
		}
		const nested = args.tool_uses;
		if (Array.isArray(nested)) {
			for (const use of nested) if (use !== null && typeof use === "object" && typeof use.arguments === "string") this.touchLspPaths(use.arguments);
		}
		if (paths.length === 0) return;
		const bridge = this.ensureLspBridge();
		for (const path of paths) bridge.touchFile(path);
	}
	/** /lsp 面板数据源：桥未创建（从未触碰文件）→ []。 */
	lspDiagnosticsView() {
		return this.lspBridge === null ? [] : [...this.lspBridge.entries()];
	}
	/**
	* 工具卡标题徽标：参数里的文件有已就绪诊断 → `⚠ 1错 2警`；否则 null
	* （拉取中/无诊断/桥未创建/无 path 参数均不显示，不干扰标题）。
	*/
	lspBadgeFor(args) {
		if (!this.lspConfig.enabled || this.lspBridge === null || args === void 0) return null;
		const paths = [
			"path",
			"file_path",
			"file"
		].map((key) => args[key]).filter((v) => typeof v === "string" && v !== "");
		if (paths.length === 0) return null;
		for (const path of paths) {
			const diags = this.lspBridge.diagnosticsFor(path);
			if (diags !== void 0) {
				const badge = lspBadgeText(diags);
				if (badge !== null) return `⚠ ${badge}`;
			}
		}
		return null;
	}
	/**
	* Ctrl+S / 欢迎「恢复」：切到 listSessions 里最近的非当前会话（含 persistence）。
	* live store 没有时走 switchSession → resume。
	*/
	async restoreRecentOtherSession() {
		const target = (await listSessions(this.ctx).catch(() => [])).filter((s) => s.id !== this.activeSessionId)[0]?.id;
		if (target !== void 0) this.switchSessionGuarded(target);
	}
	/**
	* Phase 9b：把可恢复会话列表写进 scrollback（启动时）。
	* 排除当前活跃会话；无其他可恢复会话时静默（不占位）。
	* live 标注取 live store（listSessions 的 header 无 live 字段，
	* 经 ctx.sessions.list() 的 id 集合判定）。
	*/
	async renderRestorableSessions() {
		await this.refreshApiKeyReady();
		const cols = this.stdout.columns;
		const gutter = cols >= 12 ? 2 : 0;
		const commitLine = (text) => {
			this.commitToScrollback({ text });
		};
		const current = this.ctx.agentDefaultModel.currentSelection();
		const branch = gitBranch();
		this.gitDirty = gitDirtyCount();
		const welcomePreset = livePresetShort(this.ctx, this.activeSessionId);
		for (const line of formatTopBar({
			width: cols - gutter,
			cwd: this.sessionCwd(),
			modelName: `${current.provider}/${current.model}`,
			...branch === void 0 ? {} : { branch },
			...welcomePreset === void 0 ? {} : { preset: welcomePreset }
		}, this.theme)) commitLine(gutter > 0 ? `${" ".repeat(gutter)}${line}` : line);
		const active = this.activeSessionId;
		const others = (await listSessions(this.ctx)).filter((s) => s.id !== active);
		const env = {
			hasApiKey: this.apiKeyReady,
			isGitRepo: isGitRepo(),
			themeName: getActiveThemeName(),
			cols
		};
		const recent = others[0];
		const resumeAvailable = others.length > 0;
		const resumeLabel = recent === void 0 ? "恢复会话" : `恢复 · ${formatSessionAge(recent.createdAt, Date.now())}`;
		const whale = formatWhaleLogo({
			width: cols,
			rows: this.stdout.rows
		});
		commitLine("");
		const tips = [];
		if (this.prefs.onboarded !== true) {
			tips.push({
				keyHint: "/help",
				label: "命令帮助面板"
			});
			this.prefs.onboarded = true;
			this.persistPrefs();
		}
		if (!this.apiKeyReady) tips.push({
			keyHint: "/key",
			label: "配置 API key"
		});
		tips.push({
			keyHint: "ctrl+n",
			label: "新会话"
		}, {
			keyHint: "ctrl+s",
			label: resumeLabel,
			available: resumeAvailable
		}, {
			keyHint: "ctrl+p",
			label: "命令面板"
		}, {
			keyHint: "/",
			label: "slash 命令"
		}, {
			keyHint: "ctrl+o",
			label: "展开推理"
		}, {
			keyHint: "shift+tab",
			label: "模式循环"
		});
		const ownVersion = readOwnVersion(fileURLToPath(new URL(".", import.meta.url)));
		let hero = [];
		const welcomeStyle = this.prefs.welcomeStyle ?? "blue";
		if (welcomeStyle === "blue") {
			const blueWhale = formatBlueWhaleLogo({
				width: cols,
				rows: this.stdout.rows
			});
			hero = formatBlueWelcomeHero({
				width: cols,
				rows: this.stdout.rows,
				whale: blueWhale,
				env,
				tips,
				...ownVersion === void 0 ? {} : { version: ownVersion }
			}, this.theme);
		} else if (welcomeStyle === "star") {
			const starWhale = formatStarWhaleLogo({
				width: cols,
				rows: this.stdout.rows
			});
			hero = formatStarWelcomeHero({
				width: cols,
				rows: this.stdout.rows,
				whale: starWhale,
				env,
				tips,
				...ownVersion === void 0 ? {} : { version: ownVersion }
			}, this.theme);
		}
		if (hero.length === 0) hero = formatWelcomeHero({
			width: cols,
			whale,
			env,
			tips,
			...ownVersion === void 0 ? {} : { version: ownVersion }
		}, this.theme);
		for (const line of hero) commitLine(line);
		commitLine("");
	}
	/**
	* 新建会话：经 ctx.agents.create 铸造 session+agent，本层持有 handle。
	* 模型定路取 agentDefaultModel 当前选择（settings 用户层实时生效），并经
	* installModelSelection 耦合 prompt 装配与请求路由（headless 同款接线）。
	* 会话 id 由本层铸造（session-<uuid>），create 返回的 handle 由 ownedHandle 持有、
	* detach/dispose 时释放；controls 走 controlsFromHandle（驱动 handle.agent）。
	* 先卸载当前挂载（与 switchSession 对称）：否则 transcript/liveAgent/
	* statusLine/streamFeed 被覆盖即泄漏监听器，旧 ownedHandle 丢失即泄漏 agent。
	* @param reuse - 可选的启动复用空会话：id 复用、header.cwd 重绑启动目录；
	*   跨目录复用时先清掉旧目录的空 artifact（后端按 cwd 分目录存 artifact，
	*   同 id 双目录会被 duplicate/collision 拒绝）；清理不可行则退回全新 id。
	* @returns 新会话的 id（本层铸造或复用）。
	*/
	async newSession(reuse) {
		await this.detachProjections({ keepHandle: true });
		this.dynamicRowsHighWater = 0;
		let id = reuse?.id;
		if (reuse !== void 0) {
			if (!await clearEmptySessionArtifact(this.ctx, reuse)) id = void 0;
		}
		const sessionId = id ?? SessionId(`session-${randomUUID()}`);
		const selection = this.ctx.agentDefaultModel.currentSelection();
		this.modelRef = {
			current: selection,
			assembled: void 0
		};
		const ref = this.modelRef;
		let joinedId;
		const handle = await this.ctx.agents.create({
			sessionId,
			meta: { cwd: process.cwd() },
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: async (agentCtx) => {
				installModelSelection(agentCtx, ref);
				joinedId = await joinCreateOrWarn(this.ctx, agentCtx, this.prefs.preset, (m) => this.echoWarn(m));
			}
		});
		this.ownedHandle = handle;
		this.controls = controlsFromHandle(handle);
		this.activeSessionId = sessionId;
		if (joinedId !== void 0) handle.agent.session.append("agent-preset/selected", { agentPreset: joinedId });
		this.mountSession(sessionId);
		return sessionId;
	}
	/**
	* C2 项 4：热切当前会话的模型。改 modelRef.current——下一次 agent 步进
	* （prompt assembly）自动生效，不中断当前步骤。registry 兜底的会话
	* （ref 由其他装配方持有）返回 false，调用方提示不可热切。
	* @param selection - 新的 provider/model。
	* @returns 是否已热切（modelRef 存在）。
	*/
	switchLiveModel(selection) {
		if (this.modelRef === null) return false;
		this.modelRef.current = selection;
		this.glanceModelName = selection.model;
		this.glanceEffort = selection.reasoningEffort ?? null;
		this.refreshVisionForSelection(selection);
		return true;
	}
	/** A3：create({ seed }) 铸 child；禁止 fork 后再 resume live 会话。 */
	async forkSession(opts) {
		if (this.activeSessionId === null) throw new Error("当前无会话可分叉");
		const parent = this.ctx.sessions.get(this.activeSessionId);
		if (parent === void 0) throw new Error("当前无会话可分叉");
		const forked = await createForkedAgent(this.ctx, parent, this.activeSessionId, process.cwd());
		await this.detachProjections({ keepHandle: true });
		this.dynamicRowsHighWater = 0;
		this.modelRef = forked.ref;
		this.ownedHandle = forked.handle;
		this.controls = controlsFromHandle(forked.handle);
		this.activeSessionId = forked.childId;
		this.mountSession(forked.childId);
		if (opts?.directive) await this.controls?.followup(opts.directive);
		return forked.childId;
	}
	/**
	* C3 项 3：打开 rewind overlay（/rewind）。检查点 = transcript 里真人用户
	* 说过的非空 `user/message`；执行回调做「文件回退 + 会话截断 + 持久化截断」。
	* @returns 是否已打开（无活跃会话或无可回退用户消息时 false）。
	*/
	rewindSession() {
		const overlay = this.overlay;
		const rewind = this.rewindOverlay;
		if (overlay === null || rewind === null || this.activeSessionId === null) return false;
		const messages = collectUserRewindCheckpoints(this.transcript?.view.messages ?? []);
		if (messages.length === 0) {
			this.echoWarn("没有可回退的用户消息");
			return false;
		}
		rewind.setMessages(messages, (mode, atSeq) => this.executeRewind(mode, atSeq));
		overlay.activate("rewind");
		return true;
	}
	/**
	* P1：发起 /btw 侧问——BtwController 旁路（临时 btw agent，不持 ownedHandle、
	* 不经过 switchSession）。返回是否已发起：无活跃会话或已有挂起侧问时 false
	* （命令分发层回显提示）；创建/提问失败抛错由 runSlash 统一回显。
	* @param question - 侧问文本（已 trim）。
	* @returns 是否已发起。
	*/
	async askBtw(question) {
		if (this.activeSessionId === null) return false;
		if (this.btw.isActive) return false;
		await this.btw.ask(question);
		return true;
	}
	/**
	* T3：/export 会话导出——把当前会话完整事件日志渲染为 Markdown 并写盘。
	* 数据源是 session.events（权威事件流，非渲染视图）：完整内容、无折叠截断。
	* path 缺省 = 会话创建目录下 `dsh-export-<id>.md`（header.cwd 缺失时回退
	* 当前进程 cwd）。无活跃会话或写盘失败抛错——命令分发层回显失败（fails loud）。
	* @param path - 目标文件路径；缺省由会话 cwd 决定。
	* @returns 实际写入的导出文件路径。
	*/
	async exportTranscript(path) {
		if (this.activeSessionId === null) throw new Error("当前无会话，无法导出");
		const session = this.ctx.sessions.get(this.activeSessionId);
		if (session === void 0) throw new Error("会话不存在，无法导出");
		const target = path ?? join(session.header.cwd ?? process.cwd(), `dsh-export-${session.id}.md`);
		const markdown = renderSessionExport(session.snapshotEvents(), {
			sessionId: session.id,
			...session.header.cwd !== void 0 ? { cwd: session.header.cwd } : {}
		});
		await writeFile(target, markdown, "utf8");
		return target;
	}
	/**
	* P2：打开 memory 浏览器 overlay。条目快照 + 删除回调在激活时经 memory
	* 服务注入（reflect 动态获取；服务缺失返回 false，命令层回显不可用）。
	* @returns 是否已打开。
	*/
	async openMemoryBrowser() {
		const overlay = this.overlay;
		const browser = this.memoryOverlay;
		if (overlay === null || browser === null) return false;
		const memory = this.ctx.reflect.get("memory", false);
		if (memory === void 0) return false;
		const PAGE_SIZE = 20;
		const items = await memory.list({
			limit: PAGE_SIZE,
			offset: 0
		});
		const hasMore = items.length >= PAGE_SIZE;
		browser.setItems(items, {
			refetch: async () => memory.list(),
			onDelete: async (id) => {
				await memory.delete(id);
			},
			fetchPage: async (offset, limit) => memory.list({
				offset,
				limit
			})
		}, hasMore);
		overlay.activate("memory");
		return true;
	}
	/** #31：打开模型选择器（Enter 本会话 / S 写默认）。 */
	async openModelPicker() {
		const saved = this.ctx.agentDefaultModel?.currentSelection();
		const live = this.modelRef?.current ?? saved;
		await openModelPicker({
			overlay: this.overlay,
			picker: this.picker,
			echoWarn: (text, hint) => {
				this.echoWarn(text, hint);
			},
			commit: (text) => {
				this.commitToScrollback({
					text,
					trailingNewline: true
				});
			},
			...live === void 0 ? {} : { current: live },
			savedKey: saved === void 0 ? null : `${saved.provider}/${saved.model}`,
			llm: this.ctx.reflect.get("llm", false),
			applySession: (selection) => this.switchLiveModel(selection),
			applyDefault: (selection) => {
				this.ctx.agentDefaultModel?.saveSelection(selection);
			}
		});
	}
	/**
	* C2 项 2：历史搜索 overlay 开关（Ctrl+F 与 vim NORMAL '/' 共用入口）。
	* 打开时快照 transcript 消息；已打开则关闭。
	*/
	toggleHistorySearchOverlay() {
		const overlay = this.overlay;
		const search = this.searchOverlay;
		/* v8 ignore next -- overlay/searchOverlay 在 attach 时恒创建，null 仅类型收窄 */
		if (overlay !== null && search !== null) {
			if (overlay.activeId() === "search") overlay.deactivate();
			else {
				search.setMessages(this.transcript?.view.messages ?? []);
				overlay.activate("search");
			}
		}
	}
	/** /scroll 分页查看器开关：打开时快照 CommitEngine 全文，已打开则关闭。 */
	toggleScrollPager() {
		const overlay = this.overlay;
		const pager = this.scrollPager;
		/* v8 ignore next 2 -- overlay/scrollPager 在 attach 时恒创建，null 仅类型收窄 */
		if (overlay === null || pager === null) return;
		if (overlay.activeId() === "scroll") overlay.deactivate();
		else {
			pager.setContent(this.commit.getContent());
			overlay.activate("scroll");
		}
	}
	/** P1：偏好原子落盘（禁用态 no-op；prefs 已就地变更）。 */
	persistPrefs() {
		if (this.prefsPath === null) return;
		writePrefs(this.prefsPath, this.prefs);
	}
	/** P1.5：提交文本进输入历史——内存（Ctrl+P/N 即时可用）+ 磁盘异步追加（重启恢复）。 */
	pushHistory(trimmed) {
		this.history = [trimmed, ...this.history.filter((h) => h !== trimmed)].slice(0, MAX_INPUT_HISTORY);
		this.inputLine.setHistory(this.history);
		if (this.inputHistoryPath !== null) appendInputHistory(this.inputHistoryPath, trimmed);
	}
	/** P1：应用主题并持久化（/theme 与 picker 确认共用的写透点；未知主题 no-op）。 */
	applyThemeAndPersist(name) {
		if (!setTheme(name)) return false;
		this.prefs.theme = name;
		this.persistPrefs();
		return true;
	}
	/** /theme auto：探测明暗；persist 时才写 prefs。 */
	async applyThemeAuto(persist = false) {
		setTheme(autoThemeFor(await detectTerminalBackground()));
		if (persist) {
			this.prefs.theme = "auto";
			this.persistPrefs();
		}
		this.commitToScrollback({
			text: persist ? echoSavedDefault("theme", "auto") : echoSessionOnly("theme", "auto"),
			trailingNewline: true
		});
	}
	/** P1：/theme export——委托 theme-custom（模板构建 + 就地注册属于主题域）。 */
	exportTheme(nameArg) {
		return exportCurrentTheme(nameArg);
	}
	/** #31/#33：主题选择器（Enter 本会话 / S 写默认；↑↓ 预览，Esc 还原）。 */
	openThemePicker() {
		openThemePicker({
			overlay: this.overlay,
			picker: this.picker,
			savedTheme: this.prefs.theme,
			applyDefault: (name) => {
				this.applyThemeAndPersist(name);
			},
			rerenderHistory: () => {
				this.rerenderHistory();
			},
			flushLiveRender: () => {
				this.flushLiveRender();
			},
			commit: (text) => {
				this.commitToScrollback({
					text,
					trailingNewline: true
				});
			}
		});
	}
	/** /effort 无参：推理等级选择器。 */
	openEffortPicker() {
		const facet = this.ctx.agentDefaultModel;
		const saved = facet?.currentSelection();
		const live = this.modelRef?.current ?? saved;
		openEffortPicker({
			overlay: this.overlay,
			picker: this.picker,
			currentEffort: live?.reasoningEffort ?? "auto",
			savedEffort: saved?.reasoningEffort ?? "auto",
			apply: (level, persist) => {
				const base = persist ? saved : live ?? saved;
				if (base === void 0) return;
				const selection = effortSelection(base, level);
				if (persist) facet?.saveSelection(selection);
				const hot = this.switchLiveModel(selection);
				const text = persist ? hot ? echoSavedDefault("effort", level) : `${echoSavedDefault("effort", level)}（当前会话不可热切）` : hot ? echoSessionOnly("effort", level) : `推理等级已设为 ${level}（当前会话不可热切）。选择器按 S 或 /effort default 可设为启动默认`;
				this.commitToScrollback({
					text,
					trailingNewline: true
				});
			}
		});
	}
	/** #31：打开会话选择器（今天/昨天/本周/更早分组；当前 ● 高亮）。 */
	async openSessionPicker() {
		const overlay = this.overlay;
		const picker = this.picker;
		if (overlay === null || picker === null) return;
		const rows = await listSessions(this.ctx);
		if (rows.length === 0) {
			this.echoWarn("⚠ 当前无会话，会话选择器不可用");
			return;
		}
		const titled = [];
		for (const row of rows) {
			const events = await loadHistory(this.ctx, row.id);
			titled.push({
				id: row.id,
				createdAt: row.createdAt,
				title: sessionTitleFor(events)
			});
		}
		const { items, selectedIndex } = buildSessionPickerItems(titled, {
			now: Date.now(),
			...this.activeSessionId === null ? {} : { activeId: this.activeSessionId }
		});
		picker.open("选择会话", items, (item) => {
			this.switchSessionGuarded(SessionId(item.value));
		}, selectedIndex);
		overlay.activate("picker");
	}
	/**
	* C3 项 3：执行回退。mode 决定范围：
	* - convo：仅截断会话（内存 + 持久化）
	* - code：仅文件回退（FileHistory.rewindToBoundary）
	* - both：两者
	* 持久化失败向上抛（RewindOverlay 显示错误）；文件快照缺失计入 filesSkipped。
	* @returns 文件变更数/缺口数与截断 seq。
	*/
	async executeRewind(mode, atSeq) {
		let filesChanged = 0;
		let filesSkipped;
		if (mode !== "convo") {
			const r = await this.rewindFiles(atSeq);
			filesChanged = r.changed;
			filesSkipped = r.skipped;
		}
		const result = { filesChanged };
		if (filesSkipped !== void 0) result.filesSkipped = filesSkipped;
		if (mode === "convo" || mode === "both") {
			await this.truncateSession(atSeq);
			result.truncatedTo = atSeq;
		}
		return result;
	}
	/** 文件回退：收集 atSeq 之后的写工具 callId，经 fs-snapshot FileHistory 恢复。 */
	async rewindFiles(atSeq) {
		if (this.activeSessionId === null) return {
			changed: 0,
			skipped: 0
		};
		const session = this.ctx.sessions.get(this.activeSessionId);
		if (session === void 0) return {
			changed: 0,
			skipped: 0
		};
		const histories = this.ctx.reflect.get("fsSnapshot.histories", false);
		if (histories === void 0) throw new Error("rewind 文件快照不可用（fs-snapshot 未装配）");
		const fh = histories.get(this.activeSessionId);
		if (fh === void 0) return {
			changed: 0,
			skipped: 0
		};
		const postBoundaryIds = /* @__PURE__ */ new Set();
		for (const e of session.snapshotEvents()) {
			if (e.seq <= atSeq) continue;
			if (e.type === "tool/call" && isWriteToolCall(e.data.name)) postBoundaryIds.add(e.data.callId);
		}
		const { changed, skipped } = await fh.rewindToBoundary(postBoundaryIds);
		return {
			changed: changed.length,
			skipped
		};
	}
	/**
	* 会话截断：先持久化后内存——truncateStored 失败时内存不动（状态一致、
	* 可重试），成功后再截内存态（同步纯内存操作，不抛错）。
	* 公开版 dsh-session 以 fork 派生代替内存截断，Session 无 truncate 能力
	* 时 fails loud（rewind 的 convo/both 模式在无截断能力的宿主上不可用）。
	* @param atSeq - 截断到的 seq（含）。
	*/
	async truncateSession(atSeq) {
		if (this.activeSessionId === null) return;
		const persistence = this.ctx.reflect.get("sessionPersistence", false);
		if (persistence !== void 0) await persistence.truncateStored(this.activeSessionId, atSeq);
		const session = this.ctx.sessions.get(this.activeSessionId);
		if (session === void 0) return;
		const truncate = session.truncate;
		if (truncate === void 0) throw new Error("会话截断不可用：宿主 dsh-session 不支持 truncate（rewind 请改用 fork 派生）");
		truncate.call(session, atSeq);
	}
	/**
	* 切换到既有会话：卸载旧投影/控制面（并释放本层持有的旧 handle），
	* 再 agent-ensure 目标会话——registry 有 live agent 走 controlsFromRegistry 兜底
	* （非自有，不 dispose）；无则 resume 拿 handle（本层持有并 dispose）。
	* resume 的模型定路沿用会话持久化的 request header（跨重启续模），
	* 无 header（从未成功发起请求的会话）才落 agentDefaultModel 当前选择。
	* 恢复先于任何切换状态提交：目标不可恢复时在此抛错，应用停留在原会话（不进入半切换态）。
	* @param id - 目标会话 id；live 会话或可恢复的持久化会话。
	*/
	async switchSession(id) {
		const agent = this.ctx.agents.get(id);
		const selection = resumeModelSelection(agent === void 0 ? getSession(this.ctx, id)?.requestHeader()?.config : void 0, () => this.ctx.agentDefaultModel.currentSelection());
		const ref = {
			current: selection,
			assembled: void 0
		};
		const handle = agent !== void 0 ? void 0 : await this.ctx.agents.resume({
			resumeSessionId: id,
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup: async (agentCtx) => {
				installModelSelection(agentCtx, ref);
				const live = getSession(this.ctx, id);
				await joinResume(this.ctx, agentCtx, resolvePresetId(live?.header.agentPreset, live?.snapshotEvents()));
			}
		});
		await this.detachProjections({ keepHandle: true });
		this.dynamicRowsHighWater = 0;
		this.activeSessionId = id;
		if (agent !== void 0) {
			/* v8 ignore next -- agent 已确认存在（if 分支外），controlsFromRegistry 恒返回非空 */
			this.controls = controlsFromRegistry(this.ctx, id) ?? null;
			this.modelRef = null;
		} else if (handle !== void 0) {
			this.modelRef = ref;
			this.ownedHandle = handle;
			this.controls = controlsFromHandle(handle);
		}
		this.mountSession(id);
	}
	/** 按键面切换：失败回显 ⚠ 并停留原会话（rejection 不逃逸成 unhandled）。 */
	switchSessionGuarded(id) {
		this.switchSession(id).catch((error) => {
			this.echoWarn(`⚠ 会话切换失败: ${error instanceof Error ? error.message : String(error)}`, "/session 重新选择");
		});
	}
	/** 首次非空 todos 打开紧凑卡；关掉或 /clear 后本会话不再自动开。 */
	tryAutoOpenTodos(items) {
		if (!this.todosAutoArmed || items === null || items.length === 0) return;
		this.todosPanelVisible = true;
		this.todosAutoArmed = false;
	}
	/**
	* 挂载当前会话的投影与控制面：transcript/live/controls 就位后，
	* 将已提交的历史渲染进 scrollback。
	* @param id - 目标会话 id（activeSessionId 已在调用方设置）。
	*/
	mountSession(id) {
		const session = getSession(this.ctx, id);
		if (session === void 0) throw new Error(`unknown session: ${id}`);
		this.turnSummary = emptyTurnSummary(0);
		this.sessionSummary = summarizeSession(id, session.snapshotEvents());
		this.transcript = createTranscript(this.ctx, session);
		this.liveAgent = trackAgent(this.ctx, id);
		this.statusLine = new WorkflowStatusLine(this.ctx, id, () => {
			this.renderBatcher.schedule();
		});
		const headerConfig = session.requestHeader()?.config;
		if (headerConfig !== void 0) {
			this.glanceModelName = headerConfig.model;
			this.glanceEffort = headerConfig.reasoningEffort ?? null;
		} else {
			const selection = this.ctx.agentDefaultModel.currentSelection();
			this.glanceModelName = selection.model;
			this.glanceEffort = selection.reasoningEffort ?? null;
		}
		const visionSelection = headerConfig !== void 0 ? {
			provider: headerConfig.provider,
			model: headerConfig.model
		} : this.ctx.agentDefaultModel.currentSelection();
		this.refreshVisionForSelection(visionSelection);
		this.contextWindow = session.requestContext()?.contextWindow ?? null;
		this.streamEventBacklog = [];
		this.replayActive = false;
		this.streamFeed = this.ctx.on("session/event", (owner, event) => {
			if (owner.id !== id) return;
			if (this.replayActive) {
				this.streamEventBacklog.push(event);
				return;
			}
			this.handleStreamEvent(event);
		});
		this.inspect.hide("tasks");
		this.inspect.hide("status");
		this.todosPanelVisible = false;
		this.todosAutoArmed = true;
		this.taskItems = null;
		this.planState = {
			active: false,
			pending: false
		};
		this.projectionCache = null;
		const projections = this.ctx.reflect.get("sessionProjections", false);
		if (projections !== void 0) {
			const snap = projections.snapshot(session);
			this.projectionCache = { ...snap.values };
			const snapTodos = snap.values.todos;
			this.taskItems = snapTodos ?? null;
			this.todosRetained = snapTodos ?? null;
			this.tryAutoOpenTodos(this.todosRetained);
			const plan = snap.values.plan;
			this.planState = {
				active: plan?.active ?? false,
				pending: plan?.pending ?? false
			};
			this.statusLine?.setPlanState(this.planState);
			this.projectionDisposer = projections.onChanged((s, key, value) => {
				if (s.id !== id) {
					if (this.delegationSurface.handleForeignProjection({
						sessionId: String(s.id),
						key,
						value
					}, {
						panelVisible: this.subagentsPanelVisible,
						rootSessionId: id
					})) this.renderBatcher.schedule();
					return;
				}
				/* v8 ignore next -- projectionCache 在快照后恒非 null（L766 赋值），null 仅类型收窄 */
				if (this.projectionCache !== null) this.projectionCache[key] = value;
				if (key === "todos") {
					const items = value;
					this.taskItems = items;
					if (items !== null) {
						this.todosRetained = items;
						this.tryAutoOpenTodos(items);
					}
					this.renderBatcher.schedule();
				} else if (key === "plan") {
					const plan = value;
					this.planState = {
						active: plan?.active ?? false,
						pending: plan?.pending ?? false
					};
					this.statusLine?.setPlanState(this.planState);
					this.renderBatcher.schedule();
				} else this.renderBatcher.schedule();
			});
		}
		this.discardReasoning();
		this.lastReasoningBlock = null;
		this.reasoningExpanded = false;
		this.pendingCallTitles.clear();
		this.approval.clearSessionGrants();
		this.commitRows(this.renderHistoryRows());
		this.inputLine.setHistory(this.history);
		this.subagentDisposer = this.delegationSurface.attach(id, (event, cb) => this.ctx.on(event, cb));
		this.workflowDisposer = this.workflowSurface.attach((event, cb) => this.ctx.on(event, cb));
		this.taskDoneDisposer?.();
		this.taskSurfaceDisposer?.();
		this.taskSnapshots = [];
		this.taskNotice = null;
		if (this.submitQueue.size() > 0) this.commitToScrollback({
			text: `⚠ 切换会话：丢弃 ${this.submitQueue.size()} 条未发送的排队消息`,
			trailingNewline: true
		});
		this.submitQueue.clear();
		this.errorAnnouncer.reset();
		const tasks = this.ctx.reflect.get("tasks", false);
		if (tasks !== void 0) {
			this.taskSnapshots = tasks.list();
			this.taskDoneDisposer = tasks.onTaskDone((snapshot) => {
				this.taskNotice = `✓ 任务完成: ${snapshot.label}`;
				this.taskSnapshots = tasks.list();
				notifyOs({
					title: "dsh · 任务完成",
					body: snapshot.label
				}, this.prefs);
				writeBell(this.stdout, process.env, this.prefs);
				this.flushLiveRender();
			});
			this.taskSurfaceDisposer = tasks.attachSurface("tui");
		}
		this.flushLiveRender();
	}
	/** T3.2：刷新 /config 投影（宿主服务可缺；终端段始终带上）。 */
	async refreshConfigProjection() {
		const next = await loadConfigProjection({
			reflect: this.ctx.reflect,
			prefs: this.prefs,
			compactMode: this.compactMode,
			shouldAbort: () => this.disposed || !this.inspect.is("config")
		});
		if (this.disposed || !this.inspect.is("config")) return;
		this.configProjection = next;
	}
	/** /config notify 与空输入 n：写 prefs 并刷新终端段。 */
	applyNotifyPref(action, echo) {
		const r = applyNotifyOsPref(this.prefs, action);
		if (r.warn !== void 0) this.echoWarn(r.warn);
		else {
			this.persistPrefs();
			echo(r.echo);
		}
		if (this.configProjection !== null) this.configProjection = {
			...this.configProjection,
			tui: {
				...configTuiFromPrefs(this.prefs),
				compactMode: this.compactMode
			}
		};
		this.renderBatcher.schedule();
	}
	/** 回显警告行到 scrollback（fails-loud 提示共用出口）；hint 给 dim 色 `  ↳ ` 恢复指引尾随行。 */
	echoWarn(text, hint) {
		this.commitToScrollback({
			text: formatWarnWithHint(text, hint, this.theme),
			trailingNewline: true
		});
		this.flushLiveRender();
	}
	/** 当前主题（动态读取，切主题后立即生效）。 */
	get theme() {
		return getTheme();
	}
	/**
	* 统一 scrollback 写入委托（C4 第二波：实现已抽至 controllers/commit-surface——
	* 原子提交编舞 / overlay 暂存补写 / 用户气泡与图片链路，详见该模块 docstring）。
	* 全仓 ~28 个调用点保留本薄委托，签名不变。
	*/
	commitToScrollback(entry) {
		this.commitSurface.text(entry);
	}
	/**
	* 提交用户输入：追加输入历史、将用户消息渲染进 scrollback、
	* 走 adapter.send 的 followup 驱动 agent。slash 命令（/steer）分流到 handleSteer。
	* @param text - 输入框提交的文本；空文本但无图时 no-op
	* @param images - 输入框携带的图片附件 data URL 列表（可省略）
	*/
	handleSubmit(text, images) {
		images = normalizeSubmitImages(images);
		let trimmed = text.trim();
		const hasImages = images !== void 0 && images.length > 0;
		const imagesReachable = this.supportsVision || this.resolveVisionBridge();
		if (!trimmed && hasImages) {
			if (imagesReachable) {
				text = "📎 图片消息";
				trimmed = text;
			} else {
				this.commitSurface.userPrompt("", images);
				this.inputLine.clearImages();
				this.flushLiveRender();
				return;
			}
		}
		if (!trimmed) return;
		if (trimmed.startsWith("/") && !looksLikeFilePath(trimmed, (n) => this.isKnownCommand(n), (n) => this.isCommandPrefix(n))) {
			this.runSlash(trimmed);
			return;
		}
		const expanded = expandMentions(trimmed, this.sessionCwd());
		this.skillSurface.recordGesture(trimmed);
		this.pushHistory(trimmed);
		if (this.liveAgent?.state.status === "running") {
			this.submitQueue.push(expanded, images);
			this.flushLiveRender();
			return;
		}
		this.commitSurface.userPrompt(expanded, images);
		this.inputLine.clearImages();
		this.errorAnnouncer.recordSubmitted(expanded);
		this.controls?.followup(expanded, imagesReachable ? images : void 0).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			this.errorAnnouncer.notifyDeliveryFailure(expanded, message, this.inputLine.value === "");
			this.flushLiveRender();
		});
		this.flushLiveRender();
	}
	/** turn/end → 本地队列按序投递（气泡 → followup）；aborted 不 flush——打断后可能想 ↑ 取回。 */
	flushSubmitQueue(reason) {
		if (reason === "aborted") return;
		this.errorAnnouncer.clearSubmitted();
		const items = this.submitQueue.drain();
		for (const item of items) {
			this.commitSurface.userPrompt(item.text, item.images);
			this.errorAnnouncer.recordSubmitted(item.text);
			this.controls?.followup(item.text, item.images).catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				this.errorAnnouncer.notifyDeliveryFailure(item.text, message, this.inputLine.value === "", "排队消息发送失败");
				this.flushLiveRender();
			});
		}
		if (items.length > 0) this.flushLiveRender();
	}
	/**
	* 执行一条 slash 命令：注册表解析 → handler 运行 → 回显/错误提示。
	* 命令回显写 scrollback（用户可见），但不写回 session log（dsh 纪律：
	* 命令执行是 UI 层副作用，session 事件词汇不变）。
	* @param input - 输入行提交的原始文本（已 trim，以 / 开头）。
	*/
	async runSlash(input) {
		const echo = (text) => {
			this.commitToScrollback({
				text,
				trailingNewline: true
			});
		};
		const parsed = this.slash.resolve(input);
		if (parsed === null) {
			if (await this.runCordisCommand(input, echo)) {
				this.flushLiveRender();
				return;
			}
			const suggestions = suggestCommands(input, this.slash.list());
			echo(`未知命令: ${input}。${suggestions.length > 0 ? `你是要找: ${suggestions.map((c) => `/${c.name}`).join(" ")}?` : "试试 /help 查看全部命令"}`);
			this.flushLiveRender();
			return;
		}
		try {
			await parsed.command.run({
				text: parsed.text,
				ctx: this.ctx,
				sessionId: this.activeSessionId,
				echo,
				/* v8 ignore next -- 内置命令 run 均不消费 rerender（死回调，无调用方） */
				rerender: () => {
					this.flushLiveRender();
				}
			});
			this.inputController.recordSlashUse(parsed.command.name);
		} catch (err) {
			echo(`⚠ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.flushLiveRender();
	}
	/**
	* A1：把未命中的 slash 输入委托给 CommandService（cordis 命令通道）。
	* 无会话、commands 服务未装配、或命令未知名（execute 返回 undefined）时
	* 返回 false，由调用方维持「未知命令」回显；成功/失败回显在此完成。
	* @param input - 完整 slash 输入（含 / 前缀）。
	* @param echo - scrollback 回显回调。
	* @returns 命令是否被 CommandService 受理（true 时调用方不再回显未知命令）。
	*/
	async runCordisCommand(input, echo) {
		if (this.activeSessionId === null) return false;
		const commands = this.ctx.reflect.get("commands", false);
		if (commands === void 0) return false;
		const agent = this.ctx.agents.get(this.activeSessionId);
		if (agent === void 0) return false;
		try {
			const execution = await commands.execute(agent, input, new AbortController().signal);
			if (execution === void 0) return false;
			if (execution.result.kind === "success") echo(execution.result.text ?? "已执行");
			else echo(`⚠ 命令执行失败: ${execution.result.text}`);
			return true;
		} catch (err) {
			echo(`⚠ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`);
			return true;
		}
	}
	/**
	* 提交中轮转向：渲染差异化 steer 消息（marker/颜色区分 user）进 scrollback，
	* 走 adapter.send 的 steer API。空文本 no-op（/steer 无参数、Ctrl+T 空输入）。
	* @param text - 转向文本。
	*/
	handleSteer(text) {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.pushHistory(trimmed);
		this.commitToScrollback({
			text: formatSteerMessage({
				content: trimmed,
				width: this.stdout.columns
			}, this.theme).join("\n"),
			trailingNewline: true
		});
		this.controls?.steer(trimmed);
		this.flushLiveRender();
	}
	/**
	* 取消当前 agent 活动：Ctrl-C 走 adapter.cancel（cause { kind: 'user' }）。
	* 空闲时 Ctrl-C 幂等 no-op。
	*/
	/**
	* Phase 8：审批 answerer 入口——薄转发 ApprovalController（短路/委托/挂起
	* 由控制器内聚，会话归属经 getCurrentSessionId 注入）。
	* @param req - 待决审批请求。
	* @param next - waterfall 委托（不处理时调用）。
	* @returns 用户决定（allowed-once/rejected/cancelled）或 next() 结果。
	*/
	handleApprovalRequest(req, next) {
		return this.approval.handle(req, next);
	}
	/** 取消当前运行（Esc/Ctrl+C）：cancel agent（keepInbox——宿主 inbox 未消费的 steer/排队残留保留）、丢弃未发出的流式/推理缓冲并重置流渲染。 */
	/** 最近一次 Ctrl+C 字节（0x03）处理时间戳；0 = 未处理过（SIGINT 防抖用）。 */
	lastCtrlCAt = 0;
	/** 最近一次 handleAbort 时间戳；0 = 未打断过（双击 Esc rewind 的 grace 守卫数据源）。 */
	lastAbortAt = 0;
	/**
	* Windows 双触发防护：最近 800ms 内 Ctrl+C 字节（0x03）已处理（打断/退出）时，
	* 紧随的 SIGINT 应被忽略——否则刚打断的 TUI 被 teardown 拆掉（输入框消失、
	* 进程存活）。装配层（index.ts）的 SIGINT handler 先查此门再决定是否退出。
	* @param now - 当前时间戳（注入便于测试）。
	* @returns true = SIGINT 应忽略（0x03 刚处理过）。
	*/
	shouldDeferSigint(now) {
		return now - this.lastCtrlCAt < 800;
	}
	/** slash 注册表当前命令名集合（现取——/lsp 等动态注册命令不误判为路径）。 */
	isKnownCommand(name) {
		return this.slash.list().some((c) => c.name === name);
	}
	/** name 是否为某个已注册命令的前缀（/h → help；模糊输入仍视为命令）。 */
	isCommandPrefix(name) {
		return this.slash.list().some((c) => c.name.startsWith(name));
	}
	handleAbort() {
		this.lastAbortAt = Date.now();
		this.actions.confirmDisarm("session.rewind");
		this.overlay?.deactivate();
		this.palette?.close();
		this.picker?.close();
		this.controls?.cancel({ kind: "user" }, { keepInbox: true });
		this.blockWriter.discard();
		this.streamRenderer.reset();
		this.discardReasoning();
		this.pendingCallTitles.clear();
		this.commitToScrollback({
			text: "⏹ 已取消",
			trailingNewline: true
		});
		this.flushLiveRender();
	}
	/**
	* Phase 6.4：打开外部编辑器编辑当前输入行。编辑器是外部进程，必须暂时退出
	* raw-mode（spawnSync 阻塞期间 ticker 暂停），任何路径（含失败）都恢复。编辑结果回填输入行。
	*/
	openExternalEditor() {
		try {
			this.stdin.setRawMode(false);
		} catch {}
		let content = null;
		let editorError = null;
		try {
			const r = openInEditorDetailed(this.inputLine.value, this.editorCommand);
			content = r.content;
			editorError = r.error;
		} finally {
			try {
				this.stdin.setRawMode(true);
			} catch {}
		}
		if (content !== null) this.inputLine.setValue(content);
		else if (editorError !== null) this.echoWarn(`⚠ 外部编辑器启动失败（${this.editorCommand ?? getEditorCommand()}）：${editorError}`);
		this.flushLiveRender();
	}
	/**
	* Tab 补全（Phase 6.3）：委托 InputController 状态机——首次 Tab 解析
	* 光标前 @ 路径 token 的候选并应用首项，再次 Tab 循环。无 @ token 时
	* 返回 false，Tab 保持原行为（InputLine 照常发出 'tab' 事件）。
	*/
	handleTabComplete() {
		const result = this.inputController.tabComplete(this.inputLine.value, this.inputLine.cursor, this.sessionCwd());
		if (result === null) return false;
		this.inputLine.setValue(result.text, result.cursor);
		this.flushLiveRender();
		return true;
	}
	/** 把 slash 注册表投影到 InputController（菜单 / Tab 补全数据源）。
	* 注册表可被外部插件经 tui.commands 服务在构造后扩展（回流 tianshu
	* bc5cec1359：bundle 行序使插件 apply 晚于 TUI 构造），故每次输入变化前
	* 重投影一次；#39 技能条目由 skillSurface 缓存合并，重投影不会丢。
	* 列表很小，成本可忽略。
	*/
	syncSlashHints() {
		this.skillSurface.refreshEntries();
	}
	/** slash ghost 预览：菜单选中命令补全剩余（/th→eme）；完整命令名+尾空格 → 参数占位。
	*  菜单关闭/光标不在末尾/无补全关系 → null。 */
	slashGhostText() {
		const menu = this.inputController.slashMenu;
		if (!menu.open) return null;
		const selected = menu.matches[menu.selected];
		if (selected === void 0) return null;
		const value = this.inputLine.value;
		if (this.inputLine.cursor !== value.length || value === "") return null;
		const name = `/${selected.name}`;
		if (value === `${name} ` && selected.argsHint !== void 0) return selected.argsHint;
		if (value === name) return null;
		if (name.startsWith(value)) return name.slice(value.length);
		return null;
	}
	/** fish 式历史建议 ghost：prefs 关 / `/` 开头 / 光标不在末尾 / 有选区 / vim normal → null。 */
	historyGhostText() {
		const value = this.inputLine.value;
		if (this.prefs.ghostSuggest === false || value.startsWith("/")) return null;
		if (this.inputLine.cursor !== value.length || this.inputLine.selectionRange !== null) return null;
		if (this.inputLine.vimEnabled && this.inputLine.vimMode === "normal") return null;
		return historyGhostSuffix(this.history, value);
	}
	/** 接受 slash 菜单当前选中项（Tab / Enter）：Enter 且输入已是完整命令名 →
	*  关菜单直接提交（opts.submit）；否则补全命令名（有 argsHint 补到 `cmd `
	*  留参数位，参数建议留待下一批）后关菜单。 */
	acceptSlashCompletion(opts) {
		const menu = this.inputController.slashMenu;
		const selected = menu.matches[menu.selected];
		if (selected === void 0) {
			this.inputController.closeSlash();
			this.flushLiveRender();
			return;
		}
		const name = `/${selected.name}`;
		const current = this.inputLine.value;
		if (opts?.submit === true && (current === name || current === `${name} `)) {
			this.inputController.closeSlash();
			this.inputLine.setValue("");
			this.handleSubmit(current);
			return;
		}
		this.inputLine.setValue(selected.argsHint !== void 0 ? `${name} ` : name);
		this.inputController.closeSlash();
		this.flushLiveRender();
	}
	/**
	* C3 项 4：Shift+Tab 三态循环（对齐 grok 的两轴模型，plan 与 permission 正交）：
	* Normal → Plan（planMode.set(true)）→ Always-Approve（plan off + 本地短路）→ Normal。
	* plan 切换经 planMode 服务（投影总线驱动 planState 徽标）；always-approve 是
	* 纯 TUI 本地标志（不持久化，退出即失），对审批 answerer 短路放行。
	* alwaysApprove 优先判断：它是同步本地态；planState 经投影异步更新，
	* 若按投影判断会在 Always-Approve 态误走回 Plan 分支。
	*/
	cycleMode() {
		if (this.approval.alwaysApprove) {
			this.approval.setAlwaysApprove(false);
			this.statusLine?.setAlwaysApprove(false);
			this.flushLiveRender();
		} else if (this.planState.active) {
			this.setPlanMode(false);
			this.approval.setAlwaysApprove(true);
			this.statusLine?.setAlwaysApprove(true);
			this.flushLiveRender();
		} else this.setPlanMode(true);
	}
	/**
	* /yolo：全放行模式快捷入口（approval always-approve 的显式开关）。
	* 与 Shift+Tab 循环进 always-approve 同语义（allowed-once 短路），但提供
	* 命令入口；退出会话时 app 侧复位逻辑（setAlwaysApprove(false)）同样覆盖。
	* @param flag - true 开启全放行（后续审批自动放行）；false 关闭。
	*/
	setYoloMode(flag) {
		this.approval.setAlwaysApprove(flag);
		this.statusLine?.setAlwaysApprove(flag);
		this.flushLiveRender();
	}
	/** C3 项 4：经 planMode 服务切换 plan 状态（服务缺失时回显警告，不再静默）。 */
	setPlanMode(active) {
		const planMode = scopedService(this.ctx, this.activeSessionId, "planMode");
		if (planMode === void 0) {
			if (active) this.echoWarn("⚠ planMode 服务不可用（未装配 plan 插件），无法进入 plan 模式", "/doctor 体检");
			return;
		}
		if (this.activeSessionId === null) return;
		const agent = this.ctx.agents.get(this.activeSessionId);
		if (agent === void 0) return;
		planMode.set(agent, active);
		this.planState = {
			active,
			pending: this.planState.pending
		};
		this.statusLine?.setPlanState(this.planState);
		this.renderBatcher.schedule();
	}
	/** /key：Ctrl+V 读剪贴板文本进 Key 字段（空文本忽略；readTextFromClipboard 平台缺失时返回 null）。 */
	async pasteClipboardIntoKeyDialog(dialog) {
		const text = await readTextFromClipboard();
		if (text === void 0 || text === null || text === "") return;
		dialog.pasteText(text);
		this.overlay?.rerender();
	}
	/** /update：对照 npm latest 的只查不装检查（用户看到提示后手动更新；失败不抛）。 */
	async runUpdateCheck() {
		return checkForUpdate({ cachePath: defaultUpdateCachePath() });
	}
	/**
	* 键路由（统一 action registry）：布防清扫 → 早段全局动作（overlay 之前——
	* shift_tab/ctrl_n 等在面板打开时先生效）→ overlay 委派 → 阻塞上下文轮询
	* （question > btw > approval）→ 主段动作（esc/ctrl_c/ctrl_o/editorKey/
	* ctrl_t/ctrl_v）→ slash 菜单 → inspect 上下文键 → 尾段动作 → InputLine 兜底。
	*/
	handleKey(key) {
		this.actions.sweepConfirms(key);
		const ctx = this.actionCtx;
		const early = this.actions.match(key, ctx, {
			phase: "early",
			context: "global"
		});
		if (early !== null && early.run(ctx, key) !== false) return;
		if (this.overlayRouter.route(key)) return;
		for (const blocking of this.blockingKeys) if (blocking.isActive() && blocking.handleKey(key)) return;
		const main = this.actions.match(key, ctx, {
			phase: "main",
			context: "global"
		});
		if (main !== null && main.run(ctx, key) !== false) return;
		if (this.menuKeys.isActive() && this.menuKeys.handleKey(key)) return;
		if (this.inspectKeys.isActive() && this.inspectKeys.handleKey(key)) return;
		const tail = this.actions.match(key, ctx, {
			phase: "tail",
			context: "global"
		});
		if (tail !== null && tail.run(ctx, key) !== false) return;
		const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true);
		const clip = this.inputLine.takeClipboardOut();
		if (clip != null) {
			if (!supportsOsc52() && !this.osc52WarningShown) {
				this.osc52WarningShown = true;
				this.echoWarn("⚠ 终端不支持 OSC52 复制（Ctrl+K/Alt+W 无法写入系统剪贴板，请用终端原生复制）");
			}
			this.stdout.write(osc52Clipboard(clip));
		}
		if (event !== null) this.flushLiveRender();
	}
	/** A5：最后一张进行中工具卡（空输入 Enter 展开目标）；无则 undefined。 */
	latestPendingToolCall() {
		const pending = this.transcript?.view.tools.filter((t) => t.result === void 0) ?? [];
		return pending[pending.length - 1];
	}
	/** 动作执行上下文门面（ActionContext）：when/run 只经此触达本类私有方法
	*  （registry 不 import 本类）；confirmMs 原语转发 registry 布防状态。 */
	createActionContext() {
		return {
			hasExit: this.onExit !== void 0,
			isRunning: () => this.liveAgent?.state.status === "running",
			inputEmpty: () => this.inputLine.value === "",
			slashMenuOpen: () => this.inputController.slashMenu.open,
			inspectAny: () => this.inspect.any(),
			vimNormalEsc: () => this.inputLine.vimEnabled && this.inputLine.vimMode === "normal",
			inAbortGrace: (now) => now - this.lastAbortAt < REWIND_DOUBLE_ESC_MS,
			hasReasoning: () => this.reasoningText !== "" || this.lastReasoningBlock !== null,
			hasPendingToolCard: () => this.latestPendingToolCall() !== void 0,
			hasImages: () => this.inputLine.images.length > 0,
			hasQueuedSubmits: () => this.submitQueue.size() > 0,
			paletteOpen: () => this.palette?.isOpen() === true,
			approvalPending: () => this.approval.isPending,
			confirmArm: (id, now) => {
				this.actions.confirmArm(id, now);
			},
			confirmWithin: (id, now) => this.actions.confirmWithin(id, now),
			confirmDisarm: (id) => {
				this.actions.confirmDisarm(id);
			},
			cycleMode: () => {
				this.cycleMode();
			},
			newSession: () => {
				this.newSession();
			},
			restoreRecentSession: () => {
				this.restoreRecentOtherSession();
			},
			requestExit: () => {
				this.onExit?.();
			},
			togglePalette: () => {
				const palette = this.palette;
				const overlay = this.overlay;
				/* v8 ignore next 3 -- palette/overlay 在 attach 时恒创建（键路由仅 attach 后可达），null 仅类型收窄 */
				if (palette !== null && overlay !== null) {
					if (palette.isOpen()) {
						palette.close();
						overlay.deactivate();
					} else {
						palette.open();
						overlay.activate("command-palette");
					}
				}
			},
			openPaletteMenu: () => {
				const palette = this.palette;
				const overlay = this.overlay;
				/* v8 ignore next 3 -- palette/overlay 在 attach 时恒创建，null 仅类型收窄 */
				if (palette !== null && overlay !== null) {
					palette.open(true);
					overlay.activate("command-palette");
					this.flushLiveRender();
				}
			},
			toggleKeymap: () => {
				const overlay = this.overlay;
				/* v8 ignore next 2 -- overlay 在 attach 时恒创建，null 仅类型收窄 */
				if (overlay !== null) {
					if (overlay.activeId() === "keymap") overlay.deactivate();
					else overlay.activate("keymap");
				}
			},
			toggleHistorySearch: () => {
				this.toggleHistorySearchOverlay();
			},
			toggleLatestToolCard: () => {
				const latest = this.latestPendingToolCall();
				/* v8 ignore next -- when 守卫（hasPendingToolCard）已保证有进行中工具卡；防御 */
				if (latest === void 0) return;
				this.expandedToolCallId = this.expandedToolCallId === latest.callId ? null : latest.callId;
				this.flushLiveRender();
			},
			abort: () => {
				this.handleAbort();
			},
			inspectClose: () => {
				this.inspect.dispatch({ type: "close" });
			},
			rewindSession: () => {
				this.rewindSession();
			},
			toggleReasoning: () => {
				this.reasoningExpanded = !this.reasoningExpanded;
				this.renderBatcher.schedule();
			},
			openExternalEditor: () => {
				this.openExternalEditor();
			},
			steerInput: () => {
				const text = this.inputLine.value.trim();
				if (text !== "") {
					this.inputLine.setValue("");
					this.handleSteer(text);
				}
			},
			cancelAndSend: () => {
				cancelAndSendInput({
					input: this.inputLine,
					controls: this.controls ?? void 0,
					abort: () => {
						this.handleAbort();
					},
					submit: (t, i) => {
						this.handleSubmit(t, i);
					}
				});
			},
			pasteClipboard: () => {
				this.handleCtrlV();
			},
			removeLastImage: () => {
				this.inputLine.removeImage(this.inputLine.images.length - 1);
				this.flushLiveRender();
			},
			recallQueuedSubmit: () => {
				const first = this.submitQueue.takeFirst();
				if (first !== void 0) this.inputLine.setValue(first.text, first.text.length);
				this.flushLiveRender();
			},
			ghostAcceptable: () => this.historyGhostText() !== null,
			acceptGhost: () => {
				const ghost = this.historyGhostText();
				if (ghost !== null) {
					this.inputLine.append(ghost);
					this.flushLiveRender();
				}
			},
			passHistoryKey: (key) => {
				this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true);
				this.flushLiveRender();
			},
			clearInput: () => {
				this.inputLine.setValue("");
			},
			markCtrlC: (now) => {
				this.lastCtrlCAt = now;
			},
			flushLive: () => {
				this.flushLiveRender();
			},
			settleApproval: (outcome) => {
				this.approval.settle(outcome);
			},
			approveAlways: () => {
				this.approval.setAlwaysApprove(true);
				this.statusLine?.setAlwaysApprove(true);
				this.approval.settle("allowed-once");
			},
			approveToolSession: () => {
				this.approval.approveWithTool();
			},
			approvalCommandPrefix: () => this.approval.pendingCommandPrefix,
			approveCommandPrefix: () => {
				this.approval.approveWithPrefix();
			},
			startApprovalFeedback: () => {
				this.approval.setFeedbackMode(true);
				this.inputLine.setValue("");
				this.flushLiveRender();
			}
		};
	}
	/**
	* Phase 5.3：glance 一行条的可得数据。model（request header 优先、
	* agentDefaultModel 兜底）、effort（同构）、缓存命中率与上下文占比
	* （最后一条 assistant/message 的 usage 折叠）、上下文窗口
	* （request/context 折叠）、turn 数、本轮耗时。任何数据缺失 → 对应段
	* 省略（glance 段组装按可得段渲染，窄宽渐进 drop）。
	* 无可渲染数据返回 null（不占位）。
	*/
	glanceMetrics() {
		const view = this.transcript?.view;
		const preset = livePresetShort(this.ctx, this.activeSessionId);
		const built = buildGlanceMetrics({
			transcript: view === void 0 ? void 0 : {
				turn: view.turn,
				firstInTurnTime: view.firstInTurnTime
			},
			modelName: this.glanceModelName,
			effort: this.glanceEffort,
			usage: this.usageFold,
			contextWindow: this.contextWindow,
			columns: this.stdout.columns,
			preset: preset ?? null
		});
		if (built !== null || preset === void 0) return built;
		return {
			width: this.stdout.columns,
			preset
		};
	}
	/**
	* 历史行渐进落底（任务5，2026-08-27）：大会话 attach 不再单 tick 全量写入。
	* 首片同步 commit（首帧即有内容），余片经 setImmediate 链逐片追加——每片
	* 走原子提交编舞（sync 窗内 erase+append+重绘，无撕裂），事件循环在片间
	* 让位，输入/渲染不再被千行会话冻住一拍。
	*
	* 顺序与代际守卫：replayEpoch 每次 commitRows 递增，快速切换会话时旧链在
	* 下一片前自毁；重放期间 streamFeed 新事件由 mountSession 的 backlog 排队
	* （见 streamFeed 接线注释），最后一片写完置 replayActive=false 并按序回放。
	* dispose/epoch 不匹配即刻停止，不写半截。
	*
	* @param rows - renderHistoryRows 产出的已渲染行（保持时间顺序）。
	*/
	commitRows(rows) {
		if (rows.length === 0) return;
		const epoch = ++this.replayEpoch;
		const texts = rows.map((r) => r.ansi);
		const firstTo = Math.min(REPLAY_CHUNK_ROWS, texts.length);
		this.commitToScrollback({
			text: texts.slice(0, firstTo).join("\n"),
			trailingNewline: true
		});
		let i = firstTo;
		if (i >= texts.length) return;
		this.replayActive = true;
		const step = () => {
			if (this.disposed || epoch !== this.replayEpoch) {
				this.replayActive = false;
				this.streamEventBacklog = [];
				return;
			}
			const to = Math.min(i + REPLAY_CHUNK_ROWS, texts.length);
			this.commitToScrollback({
				text: texts.slice(i, to).join("\n"),
				trailingNewline: true
			});
			i = to;
			if (i < texts.length) {
				setImmediate(step);
				return;
			}
			this.replayActive = false;
			const backlog = this.streamEventBacklog;
			this.streamEventBacklog = [];
			for (const event of backlog) this.handleStreamEvent(event);
		};
		setImmediate(step);
	}
	/** 当前主题变化后，清理终端并用最新颜色重放当前会话历史。 */
	rerenderHistory() {
		if (this.disposed || this.overlay !== null && this.overlay.activeId() !== null) return;
		this.reasoningExpanded = false;
		this.commit.reset();
		this.live.reset();
		this.stdout.write(`${ANSI.ERASE_SCREEN}\x1b[3J\x1b[H`);
		this.commitRows(this.renderHistoryRows());
		this.flushLiveRender();
	}
	/** 生成当前会话历史消息的主题化渲染行。 */
	renderHistoryRows() {
		const transcript = this.transcript;
		if (transcript === null) return [];
		return renderTranscript(transcript.view, this.theme, this.stdout.columns, {
			compact: this.compactMode,
			resolveViews: (tool) => resolveToolViews(this.toolPresenters(), {
				name: tool.name,
				argumentsRaw: tool.arguments,
				...tool.result === void 0 ? {} : { result: {
					content: tool.result.data.message.content[0].content,
					isError: toolResultText(tool.result).isError,
					...tool.result.data.meta === void 0 ? {} : { meta: tool.result.data.meta }
				} }
			})
		});
	}
	/**
	* 流式事件供给：assistant text-delta 推进 blockWriter（节流切块，稳定前缀
	* commit 进 scrollback）；message/turn 边界 flush + finalize 收尾。aborted
	* turn 的残文由 handleAbort discard/reset，不在此 commit。
	* @param event - 当前会话的 session/event（订阅处已按会话过滤）。
	*/
	handleStreamEvent(event) {
		this.turnSummary = applyTurnEvent(this.turnSummary, event);
		this.sessionSummary = applySummaryEvent(this.sessionSummary, event);
		switch (event.type) {
			case "assistant/chunk": {
				const { chunk } = event.data;
				if (chunk.type === "text-delta") {
					this.commitReasoningBlock();
					this.blockWriter.push(chunk.text);
				} else if (chunk.type === "reasoning-delta") {
					if (this.reasoningText === "") this.reasoningStartedAt = event.time;
					this.reasoningText += chunk.text;
					this.renderBatcher.schedule();
				}
				break;
			}
			case "assistant/message":
				this.commitReasoningBlock();
				if (event.data.usage !== void 0) {
					this.usageFold = event.data.usage;
					const model = this.glanceModelName ?? "unknown";
					this.sessionCosts.set(model, accumulateUsage(this.sessionCosts.get(model), event.data.usage, model));
				}
				this.flushStream();
				break;
			case "request/header":
				this.glanceEffort = event.data.header.config.reasoningEffort ?? null;
				this.glanceModelName = event.data.header.config.model;
				break;
			case "request/context":
				this.contextWindow = event.data.contextWindow ?? null;
				break;
			case "tool/call": {
				this.commitReasoningBlock();
				const { call } = resolveToolViews(this.toolPresenters(), {
					name: event.data.name,
					argumentsRaw: event.data.arguments
				});
				if (call !== void 0) this.pendingCallTitles.set(event.data.callId, call.title);
				this.touchLspPaths(event.data.arguments);
				this.fluency.setPhase("tool");
				break;
			}
			case "tool/result": {
				const { message, error } = event.data;
				const resultBlock = message.content[0];
				const resultLength = resultBlock.content.reduce((acc, block) => acc + (block.type === "text" ? block.text.length : 0), 0);
				const callId = message.source.callId;
				const name = this.transcript?.view.tools.findLast((t) => t.callId === callId)?.name ?? "tool";
				this.fluency.recordToolResult({
					name,
					isError: error !== void 0 || resultBlock.isError === true,
					resultLength
				});
				this.pendingCallTitles.delete(callId);
				this.commitSettledToolCard(event);
				break;
			}
			case "turn/start":
				this.fluency.onTurnStart();
				break;
			case "turn/end":
				this.fluency.onTurnComplete();
				this.flushSubmitQueue(event.data.reason.kind === "aborted" ? "aborted" : "completed");
				this.gitDirty = gitDirtyCount();
				this.expandedToolCallId = null;
				if (event.data.reason.kind !== "aborted") {
					this.commitReasoningBlock();
					const summary = this.turnSummary;
					const sid = this.activeSessionId;
					if (summary.toolCount > 0) this.flushStream().then(() => {
						if (this.disposed || this.activeSessionId !== sid) return;
						this.commitTurnSummaryLine(summary, event.data.turn);
					});
					else this.flushStream();
				} else this.discardReasoning();
				this.pendingCallTitles.clear();
		}
	}
	/** tools 服务的 presenter 面（可选服务：未装配返回 undefined → 桥软降级）。 */
	toolPresenters() {
		return this.ctx.reflect.get("tools", false);
	}
	/**
	* 结算工具卡实时提交：从 transcript 查配对 call 的 name/arguments →
	* presenter 桥 → 卡片渲染 → 串行在流式文本 flush 之后 commit 进
	* scrollback（保证「文本 → 卡」的事件序）。配对缺失（截断/rewind 边界）
	* 无卡可渲染，静默跳过。
	*/
	commitSettledToolCard(event) {
		const callId = event.data.message.source.callId;
		const tool = this.transcript?.view.tools.findLast((t) => t.callId === callId);
		if (tool === void 0) return;
		const { content, isError } = toolResultText(event);
		const views = resolveToolViews(this.toolPresenters(), {
			name: tool.name,
			argumentsRaw: tool.arguments,
			result: {
				content: event.data.message.content[0].content,
				isError,
				...event.data.meta === void 0 ? {} : { meta: event.data.meta }
			}
		});
		const rows = formatToolViewCard({
			toolName: tool.name,
			argumentsRaw: tool.arguments,
			content,
			isError,
			...views.call === void 0 ? {} : { callView: views.call },
			...views.result === void 0 ? {} : { resultView: views.result },
			elapsedMs: Math.max(0, event.time - tool.time),
			compact: this.compactMode
		}, this.theme);
		this.flushStream().then(() => {
			if (this.disposed) return;
			this.commitToScrollback({
				text: rows.join("\n"),
				trailingNewline: true
			});
			this.renderBatcher.schedule();
		});
	}
	/**
	* 推理段落底：静态 `✻ 思考 (Ns) · N 行` 折叠头行（对标竞品默认折叠——
	* 正文经 Ctrl+O 展开查看）整块 commit 进 scrollback，清缓冲。空缓冲 no-op。
	* 调用点即段边界：首个 text-delta / tool/call / assistant/message /
	* 非中止 turn/end。
	*/
	commitReasoningBlock() {
		if (this.reasoningText === "") return;
		const elapsedMs = this.reasoningStartedAt === null ? void 0 : Math.max(0, Date.now() - this.reasoningStartedAt);
		const lines = formatReasoningBlock({
			text: this.reasoningText,
			...elapsedMs === void 0 ? {} : { elapsedMs },
			compact: this.compactMode
		}, this.theme);
		this.lastReasoningBlock = {
			text: this.reasoningText,
			...elapsedMs === void 0 ? {} : { elapsedMs }
		};
		this.reasoningExpanded = false;
		this.discardReasoning();
		this.commitToScrollback({
			text: lines.join("\n"),
			trailingNewline: true
		});
	}
	/** 丢弃推理缓冲（abort / 会话切换；aborted turn 的推理不落底）。 */
	discardReasoning() {
		this.reasoningText = "";
		this.reasoningStartedAt = null;
	}
	/** 流式收尾：吐尽节流缓冲，并把 StreamRenderer 剩余 pending commit 进 scrollback。 */
	async flushStream() {
		await this.blockWriter.flush();
		this.streamRenderer.finalize();
	}
	/**
	* turn 结束摘要行（投影层：turn-summary 模型 → format/turn-summary 渲染半）：
	* `turn N · 读X 改Y · elapsed` 单行 dim 落 scrollback。读/改计数复用
	* tool-meta 的 read|find/write 家族（投影不重复造「工具名 → 域」映射）。
	* @param summary - 该 turn 的统计快照（fold 于 handleStreamEvent，调用点取定）。
	* @param turn - 轮号（取 turn/end 事件的权威值；中途挂载错过 turn/start 时
	*   快照内轮号是初值 0）。
	*/
	commitTurnSummaryLine(summary, turn) {
		const reads = summary.calls.filter((c) => {
			const family = getToolFamily(c.name).family;
			return family === "read" || family === "find";
		}).length;
		const writes = summary.calls.filter((c) => getToolFamily(c.name).family === "write").length;
		const lines = formatTurnSummary({
			turnNumber: turn,
			segments: [],
			filesRead: reads,
			filesModified: writes,
			...summary.totalElapsedMs > 0 ? { elapsedMs: summary.totalElapsedMs } : {},
			width: this.stdout.columns
		}, this.theme);
		for (const line of lines) this.commitToScrollback({
			text: line,
			trailingNewline: true
		});
	}
	/** wrapping-aware display rows（空行计 1）。 */
	displayRowsFor(text) {
		const cols = this.stdout.columns;
		if (cols <= 0) return 1;
		const dw = displayWidth(text, { ambiguousAsWide: ambiguousWideEnabled() });
		if (dw === 0) return 1;
		return Math.ceil(dw / cols);
	}
	/** critical 路径同步穿透：用户交互（提交/审批/按键）不等 16ms 帧边界。 */
	flushLiveRender() {
		this.renderBatcher.flushNow();
	}
	/** 三类缓存 → 活动带 items（idle key / spinner / snapshot 共用）。 */
	foldActivityItems() {
		return foldActivityFromCaches({
			subagentRuns: this.delegationSurface.runningEntries(),
			childProgress: this.delegationSurface.progressView(),
			workflowRuns: this.workflowSurface.runningViews(),
			tasks: this.taskSnapshots
		});
	}
	/** 转圈源：agent / 活动带 running / 未结算工具 / 推理展开或流式。 */
	hasVisibleSpinner(activityItems = this.foldActivityItems()) {
		return liveHasSpinner({
			agentRunning: this.liveAgent?.state.status === "running",
			activityRunning: activityItems.some((item) => item.status === "running"),
			pendingTools: this.transcript?.view.tools.some((tool) => tool.result === void 0) ?? false,
			reasoningLive: this.reasoningText !== "" || this.reasoningExpanded
		});
	}
	/** 当前帧 idle key（不含 now/tick）。 */
	currentIdleKey(activityItems = this.foldActivityItems()) {
		const pending = this.transcript?.view.tools.filter((tool) => tool.result === void 0) ?? [];
		const slash = this.inputController.slashMenu;
		const approval = this.approval.peek();
		return assembleIdleKey({
			agentStatus: this.liveAgent?.state.status ?? "",
			activity: activityItems,
			pendingCallIds: pending.map((tool) => tool.callId),
			activityBandEnabled: this.activityBandEnabled,
			compactMode: this.compactMode,
			rows: this.stdout.rows,
			columns: this.stdout.columns,
			panelFlags: [
				this.todosPanelVisible ? "todos" : "",
				this.inspect.is("tasks") ? "tasks" : "",
				this.inspect.is("status") ? "status" : "",
				this.subagentsPanelVisible ? "subagents" : "",
				this.workflowPanelVisible ? "workflow" : "",
				this.inspect.is("skills") ? "skills" : "",
				this.inspect.is("lsp") ? "lsp" : "",
				this.inspect.is("config") ? "config" : ""
			].join(","),
			btwActive: this.btw.peek() !== null,
			taskNotice: this.taskNotice ?? "",
			gitDirty: this.gitDirty,
			apiKeyReady: this.apiKeyReady,
			reasoningChars: this.reasoningText.length,
			reasoningExpanded: this.reasoningExpanded,
			streamPeekChars: this.blockWriter.peek().length,
			inputValue: this.inputLine.value,
			questionPending: this.question.peek() !== null,
			approvalPending: approval !== null,
			approvalTool: approval?.req.toolName ?? "",
			alwaysApprove: this.approval.alwaysApprove,
			newlineMode: this.inputLine.newlineMode,
			slashKey: `${slash.open ? 1 : 0}:${slash.query}:${slash.selected}:${slash.matches.length}`
		});
	}
	/** 渲染一帧 live 区：状态行 + 流式尾巴 + 进行中工具卡 + 输入行。 */
	renderLive() {
		if (this.disposed) return;
		if (this.overlay !== null && this.overlay.activeId() !== null) {
			this.lastIdleKey = null;
			return;
		}
		const activityItems = this.foldActivityItems();
		const idleKey = this.currentIdleKey(activityItems);
		if (this.renderLiveFromTicker && shouldSkipIdleAssemble({
			prevKey: this.lastIdleKey,
			nextKey: idleKey,
			hasSpinner: this.hasVisibleSpinner(activityItems)
		})) return;
		this.lastIdleKey = idleKey;
		const renderStart = performance.now();
		const theme = this.theme;
		const termCols = this.stdout.columns;
		const gutter = termCols >= 12 ? 2 : 0;
		const cols = Math.max(1, termCols - gutter * 2);
		const tightViewport = this.stdout.rows < 22;
		const compactLive = this.compactMode || tightViewport;
		const lines = [];
		this.glance.refresh();
		const glance = this.glance.current();
		this.errorAnnouncer.announce(glance.errorFull, this.inputLine.value === "");
		const turnStatusLines = formatTurnStatus({
			statusText: glance.status,
			tick: this.tick,
			active: this.liveAgent?.state.status === "running",
			width: cols
		}, theme);
		const now = Date.now();
		const workflowRuns = foldWorkflowViews(this.workflowSurface.runningViews(), this.workflowSurface.completedViews(), now);
		const snapshot = {
			cols,
			theme,
			glanceStatus: turnStatusLines[0] ?? null,
			glanceError: glance.error,
			taskPanelVisible: this.inspect.is("tasks"),
			taskItems: this.taskItems,
			taskSnapshots: this.taskSnapshots,
			taskNotice: this.taskNotice,
			statusPanelVisible: this.inspect.is("status"),
			goal: this.projectionCache?.goal ?? null,
			todos: this.projectionCache?.todos ?? null,
			plan: this.projectionCache?.plan ?? null,
			sessionTotals: {
				turns: this.sessionSummary.totalTurns,
				toolCalls: this.sessionSummary.totalToolCalls,
				elapsedMs: this.sessionSummary.totalElapsedMs
			},
			todosPanelVisible: this.todosPanelVisible,
			todosExpanded: this.todosExpanded,
			todosItems: this.todosRetained,
			...delegationSnapshotSlice({
				subagentsPanelVisible: this.subagentsPanelVisible,
				delegationEntries: this.delegationSurface.entries,
				projectionCache: this.projectionCache,
				externalRuns: this.delegationSurface.externalRuns(),
				now
			}),
			workflowPanelVisible: this.workflowPanelVisible,
			workflowRuns,
			configPanelVisible: this.inspect.is("config"),
			configProjection: this.configProjection,
			skillsPanelVisible: this.inspect.is("skills"),
			skillItems: this.skillSurface.all(),
			skillSelected: this.skillSurface.selectedName(),
			lspPanelVisible: this.inspect.is("lsp"),
			lspDiagnostics: this.lspDiagnosticsView(),
			lspAvailable: this.lspBridge === null ? true : this.lspBridge.isAvailable(),
			tick: this.tick,
			activityBandEnabled: this.activityBandEnabled,
			activityItems,
			activityBandMaxRows: this.activityBandMaxRows
		};
		for (const line of renderGlancePanel(snapshot)) lines.push({ text: line });
		for (const line of renderTasksPanel(snapshot)) lines.push({ text: line });
		if (this.inspect.is("status")) for (const line of renderStatusPanel(snapshot)) lines.push({ text: line });
		for (const line of renderDelegationPanel(snapshot)) lines.push({ text: line });
		for (const line of renderWorkflowPanel(snapshot)) lines.push({ text: line });
		for (const line of renderConfigPanel(snapshot)) lines.push({ text: line });
		for (const line of renderSkillsPanel(snapshot)) lines.push({ text: line });
		for (const line of renderLspPanel(snapshot)) lines.push({ text: line });
		const btwPeek = this.btw.peek();
		if (btwPeek !== null) {
			const btwColor = btwPeek.status === "error" ? theme.warning : btwPeek.status === "loading" ? theme.secondary : null;
			for (const line of renderBtwPanel(btwPeek, { width: cols })) lines.push({ text: btwColor === null ? line : color(line, btwColor) });
		}
		if (snapshot.taskNotice !== null) {
			lines.push({ text: color(snapshot.taskNotice, theme.muted) });
			this.taskNotice = null;
		}
		const policy = this.fluency.getPolicy();
		if (policy.staleMessage !== void 0 && policy.staleLevel !== void 0) {
			const staleColor = policy.staleLevel === "action" ? theme.error : policy.staleLevel === "warn" ? theme.warning : theme.secondary;
			lines.push({ text: color(`⏳ ${policy.staleMessage}`, staleColor) });
		}
		pushConfirmHints(this.actions, lines, theme);
		if (this.reasoningExpanded) {
			if (this.reasoningText !== "") {
				const reasoningLines = formatReasoningLive({
					text: this.reasoningText,
					...this.reasoningStartedAt === null ? {} : { elapsedMs: Math.max(0, Date.now() - this.reasoningStartedAt) },
					tick: this.tick,
					columns: cols,
					expanded: true
				}, theme);
				for (const line of reasoningLines) lines.push({ text: line });
				lines.push({ text: color("— ctrl+o 收起", theme.dim) });
			} else if (this.lastReasoningBlock !== null) {
				const blockLines = formatReasoningBlock({
					text: this.lastReasoningBlock.text,
					...this.lastReasoningBlock.elapsedMs === void 0 ? {} : { elapsedMs: this.lastReasoningBlock.elapsedMs },
					expanded: true
				}, theme);
				for (const line of blockLines) lines.push({ text: line });
				lines.push({ text: color("— ctrl+o 收起", theme.dim) });
			}
		}
		if (this.reasoningText !== "" && !this.reasoningExpanded) {
			const reasoningLines = formatReasoningLive({
				text: this.reasoningText,
				...this.reasoningStartedAt === null ? {} : { elapsedMs: Math.max(0, Date.now() - this.reasoningStartedAt) },
				tick: this.tick,
				columns: cols,
				compact: compactLive,
				maxRows: reasoningTailBudget(this.stdout.rows)
			}, theme);
			for (const line of reasoningLines) lines.push({ text: line });
		}
		for (const line of this.streamRenderer.getLiveTailLines(tightViewport ? 2 : 6, this.blockWriter.peek())) lines.push({ text: line });
		const pendingTools = this.transcript?.view.tools.filter((t) => t.result === void 0) ?? [];
		const overflow = Math.max(0, pendingTools.length - 3);
		const shownTools = overflow > 0 ? pendingTools.slice(-3) : pendingTools;
		for (const [i, tool] of shownTools.entries()) {
			const args = parseToolArguments(tool.arguments);
			const titleOverride = this.pendingCallTitles.get(tool.callId);
			const latest = i === shownTools.length - 1;
			const lspBadge = this.lspBadgeFor(args);
			const title = lspBadge === null ? titleOverride ?? toolCardTitle(tool.name, args) : `${titleOverride ?? toolCardTitle(tool.name, args)} ${lspBadge}`;
			const rows = formatToolCardLive({
				toolName: tool.name,
				...args === void 0 ? {} : { toolInput: args },
				title,
				columns: cols,
				elapsedMs: Math.max(0, Date.now() - tool.time),
				tailLines: compactLive || !latest ? 0 : tightViewport ? 1 : 3,
				tick: this.tick,
				compact: compactLive,
				expanded: this.expandedToolCallId === tool.callId
			}, theme);
			for (const line of rows) lines.push({ text: line });
		}
		if (overflow > 0) lines.push({ text: color(` …(+${overflow}) 个工具进行中`, theme.muted) });
		if (this.activityBandEnabled) for (const line of renderActivityBand(snapshot)) lines.push({ text: line });
		else for (const line of renderActivitySection({
			enabled: false,
			subagentRuns: this.delegationSurface.runningEntries(),
			childProgress: this.delegationSurface.progressView(),
			workflowRuns: this.workflowSurface.runningViews(),
			tasks: this.taskSnapshots,
			width: cols,
			maxRows: this.activityBandMaxRows,
			now,
			tick: this.tick,
			theme
		})) lines.push({ text: line });
		const chromeStart = lines.length;
		for (const line of renderTodosPanel(snapshot)) lines.push({ text: line });
		const questionPeek = this.question.peek();
		if (questionPeek !== null) {
			for (const line of projectQuestionPanel(questionPeek.request, {
				width: cols,
				theme
			})) lines.push({ text: line });
			if (questionPeek.feedbackMode) lines.push({ text: color("📝 反馈输入中（Enter 提交 / Esc / Ctrl+C 返回选项）", theme.muted) });
		}
		const approvalHintSegs = projectApprovalHints(this.actions.list(), this.actionCtx);
		const approvalPeek = this.approval.peek();
		if (approvalPeek !== null) {
			const toolCall = findApprovalToolCall(approvalPeek.req, this.transcript?.view);
			const diff = toolCall === void 0 ? null : formatPermissionDiff({
				toolName: toolCall.name,
				arguments: toolCall.arguments
			}, this.theme);
			for (const line of formatApprovalCard({
				columns: cols,
				toolName: approvalPeek.req.toolName,
				...approvalPeek.req.reason === void 0 ? {} : { reason: approvalPeek.req.reason },
				diffLines: diff,
				compact: compactLive,
				keyHintSegments: approvalHintSegs,
				feedback: approvalPeek.feedbackMode
			}, theme)) lines.push({ text: line });
		}
		const inputValue = this.inputLine.value;
		const slashLines = [];
		if (this.inputController.slashMenu.open) for (const line of formatSlashMenu({
			width: cols,
			items: this.inputController.slashMenu.matches,
			selected: this.inputController.slashMenu.selected
		}, theme)) slashLines.push(line);
		else {
			const hint = this.slash.hint(inputValue);
			if (hint !== null) slashLines.push(hint);
		}
		for (const line of slashLines) lines.push({ text: line });
		const absorbTo = lines.length;
		if (this.inputLine.vimEnabled && this.inputLine.vimMode !== "insert") {
			const modeLabel = this.inputLine.vimMode === "visual" ? this.inputLine.visualLineWise ? "-- VISUAL LINE --" : "-- VISUAL --" : "-- NORMAL --";
			lines.push({ text: color(modeLabel, theme.secondary) });
		}
		for (const summary of this.inputLine.imageSummary(cols)) lines.push({ text: color(summary, theme.muted) });
		for (const line of this.attachmentPreview.lines) lines.push({ text: line });
		if (this.submitQueue.size() > 0) lines.push({ text: formatQueueLine(cols, this.submitQueue.peekAll()) });
		const ghostBlocked = this.question.isPending || this.approval.isPending;
		this.inputLine.setGhost(ghostBlocked ? null : this.slashGhostText() ?? this.historyGhostText());
		lines.push({ text: "" });
		const planProj = this.projectionCache?.plan;
		const modeColor = planProj?.pending === true || planProj?.active === true ? theme.warning : this.approval.alwaysApprove ? theme.error : theme.secondary;
		const promptColor = this.liveAgent?.state.status === "running" ? theme.dim : modeColor;
		const inputView = this.inputLine.displayLinesWithCaret({
			maxWidth: cols,
			maxLines: inputViewportMaxLines(this.stdout.rows)
		});
		const frame = formatInputFrame({
			columns: cols,
			lines: inputView.lines.map((line) => line.startsWith("❯ ") ? `${color("❯", promptColor)}${line.slice(1)}` : line),
			caretLine: inputView.caret.line,
			caretCol: inputView.caret.col,
			planActive: planProj?.active === true,
			planPending: planProj?.pending === true,
			alwaysApprove: this.approval.alwaysApprove
		}, theme);
		for (const [i, line] of frame.lines.entries()) lines.push(i === frame.caretLine ? {
			text: line,
			caretCol: frame.caretCol
		} : { text: line });
		const bottomMetrics = this.glanceMetrics();
		const apiSeg = {
			text: `API ${this.apiKeyReady ? "✓" : "✗"}`,
			priority: 100
		};
		const dirtySeg = this.gitDirty > 0 ? [{
			text: `●${this.gitDirty}`,
			priority: 200
		}] : [];
		const rightSegments = bottomMetrics === null ? dirtySeg.length === 0 ? void 0 : [apiSeg, ...dirtySeg] : [
			...glanceStatusSegments({
				...bottomMetrics,
				hideSegments: this.prefs.glance?.hideSegments
			}),
			apiSeg,
			...dirtySeg
		];
		const footerLines = formatFooterInfo({
			width: cols,
			planActive: planProj?.active === true,
			planPending: planProj?.pending === true,
			alwaysApprove: this.approval.alwaysApprove,
			approvalPending: this.approval.isPending,
			inspectOpen: this.inspect.any(),
			approvalHints: approvalHintSegs,
			inspectHints: this.footerInspectHints,
			level: this.prefs.footerInfo ?? "full",
			...rightSegments !== void 0 ? { rightSegments } : {},
			...bottomMetrics !== null ? { metrics: {
				...bottomMetrics,
				hideSegments: this.prefs.glance?.hideSegments
			} } : {}
		}, theme);
		for (const line of footerLines) lines.push({ text: line });
		if (gutter > 0) {
			const pad = " ".repeat(gutter);
			for (const line of lines) {
				line.text = `${pad}${line.text}`;
				if (line.caretCol !== void 0) line.caretCol += gutter;
			}
		}
		const rowsForLine = (text) => this.displayRowsFor(text);
		let chromeRows = 0;
		for (let i = chromeStart; i < lines.length; i++) {
			const row = lines[i];
			if (row === void 0) continue;
			chromeRows += rowsForLine(row.text);
		}
		let dynamicRows = 0;
		for (let i = 0; i < chromeStart; i++) {
			const row = lines[i];
			if (row === void 0) continue;
			dynamicRows += rowsForLine(row.text);
		}
		const terminalRows = this.stdout.rows || 24;
		const raw = terminalRows - chromeRows - 2;
		const ceiling = Math.max(0, Math.min(raw, workingRowsCap(terminalRows, chromeRows)));
		let absorbedRows = 0;
		for (let i = chromeStart; i < absorbTo; i++) {
			const row = lines[i];
			if (row === void 0) continue;
			absorbedRows += rowsForLine(row.text);
		}
		const skipPad = (this.transcript?.view.messages ?? []).length === 0 && this.liveAgent?.state.status !== "running" && absorbedRows === 0 && this.dynamicRowsHighWater === 0;
		const next = nextDynamicBudget(this.dynamicRowsHighWater, dynamicRows + absorbedRows, ceiling + absorbedRows, skipPad, this.reasoningExpanded);
		this.dynamicRowsHighWater = next.highWater;
		const padded = padDynamicRegion(lines, chromeStart, Math.max(0, next.budget - absorbedRows), rowsForLine, { pad: !skipPad });
		const chromeTail = padded.lines.length - padded.chromeStart;
		this.live.render(padded.lines, chromeTail > 0 ? { reservedTail: chromeTail } : void 0);
		this.perfMonitor.record("renderLive", performance.now() - renderStart);
	}
	/**
	* 卸载当前会话的投影与控制面，并按 opts 处理本层持有的 handle：
	* - keepHandle（P3 side conversation 切换）：所有权让渡 registry——agent
	*   保持 live（可切回复用），退出时由 agent-loop factory 统一 teardown；
	*   modelRef 同步让渡（registry 兜底语义：不可热切）。
	* - 缺省（dispose 退出）：释放本层 handle（create/resume 铸造的）。
	* registry 兜底的裸 agent 非自有，两种情况都不 dispose。会话本身所有权归
	* 持有方，不销毁。
	* @param opts - keepHandle：切换保留模式（默认释放）。
	*/
	async detachProjections(opts) {
		this.transcript?.dispose();
		this.liveAgent?.dispose();
		this.statusLine?.dispose();
		this.streamFeed?.();
		this.streamFeed = null;
		this.projectionDisposer?.();
		this.projectionDisposer = null;
		this.subagentDisposer?.();
		this.subagentDisposer = null;
		this.workflowDisposer?.();
		this.workflowDisposer = null;
		this.taskDoneDisposer?.();
		this.taskDoneDisposer = null;
		this.taskSnapshots = [];
		this.taskNotice = null;
		this.usageFold = null;
		this.sessionCosts.clear();
		this.glanceEffort = null;
		this.contextWindow = null;
		this.projectionCache = null;
		this.taskItems = null;
		this.planState = {
			active: false,
			pending: false
		};
		this.approval.setAlwaysApprove(false);
		if (this.approval.isPending) this.approval.settle("cancelled");
		if (this.question.isPending) this.question.cancel();
		this.inspect.hide("tasks");
		this.inspect.hide("status");
		this.blockWriter.discard();
		this.streamRenderer.reset();
		if (this.ownedHandle !== null) {
			if (opts?.keepHandle === true) {
				this.ownedHandle = null;
				this.modelRef = null;
			} else {
				const handle = this.ownedHandle;
				this.ownedHandle = null;
				await handle.dispose();
			}
		}
		this.transcript = null;
		this.liveAgent = null;
		this.statusLine = null;
		this.controls = null;
	}
	/**
	* 退出：先 flush 所有 live 会话到持久层（退出恢复 checkpoint）、停止 ticker、
	* 卸载投影、恢复终端 raw-mode。
	* @returns 全部 flush 完成后 resolve。
	*/
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.ticker !== null) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
		try {
			await flushAll(this.ctx);
		} catch {}
		this.approvalDisposer?.();
		this.approvalDisposer = null;
		if (this.approval.isPending) this.approval.settle("cancelled");
		this.interactionDisposer?.();
		this.interactionDisposer = null;
		if (this.question.isPending) this.question.cancel();
		this.skillSurface.dispose();
		this.commitSurface.flushDeferred();
		await this.detachProjections();
		this.btw.dispose();
		this.taskSurfaceDisposer?.();
		this.taskSurfaceDisposer = null;
		this.lspBridge?.dispose();
		this.lspBridge = null;
		this.overlay?.deactivate();
		this.stdout.write(kittyKeyboardPopSeq() + ANSI.BRACKETED_PASTE_OFF);
		this.pasteDisposer?.();
		this.pasteDisposer = null;
		this.input.dispose();
		this.resize.dispose();
		this.glance.dispose();
		this.perfMonitor.stop();
		this.live.clear();
		this.stdout.write(ANSI.SHOW_CURSOR);
	}
	/**
	* 刷新会话列表（供外部面板查询；本 MVP 的会话面板直接读 store）。
	* @returns 全部会话的摘要列表。
	*/
	async refreshSessions() {
		return listSessions(this.ctx);
	}
};
//#endregion
//#region lib/types/stream-window.js
const LIVE_STREAM_TRUNCATION_MARKER = "… truncated live stream output …\n";
/**
* 追加流式输出并保持窗口上限：超过 maxChars 时只留尾部并前置截断标记。
* @param current - 已累计的窗口内容。
* @param next - 新到的输出片段。
* @param maxChars - 窗口字符上限（不含截断标记本身）。
* @returns 追加（并按需截尾）后的窗口内容。
*/
function appendStreamWindow(current, next, maxChars) {
	const combined = current + next;
	if (combined.length <= maxChars) return combined;
	return LIVE_STREAM_TRUNCATION_MARKER + combined.slice(-maxChars);
}
//#endregion
//#region lib/types/gutter.js
/** Single-char gutter glyph + the theme color key used to render it. */
const GUTTER = {
	user: {
		glyph: "▍",
		colorKey: "userColor"
	},
	assistant: {
		glyph: "▍",
		colorKey: "assistantColor"
	},
	thinking: {
		glyph: "┊",
		colorKey: "muted"
	},
	tool: {
		glyph: "│",
		colorKey: "primary"
	},
	system: {
		glyph: "·",
		colorKey: "systemColor"
	}
};
/**
* 某语义类别的 gutter 字形（未知类别回退 system 档）。
* @param kind - gutter 语义类别。
* @returns 单字符 gutter 字形。
*/
function gutterGlyph(kind) {
	return (GUTTER[kind] ?? GUTTER.system).glyph;
}
//#endregion
//#region lib/types/ui-glyphs.js
/**
* 高频 UI chrome 的宽度稳定字形。
*
* 核心界面不使用彩色 emoji：它们由宿主字体决定颜色与字面，通常占两列，
* 会让主题语义色失效。legacy 终端继续走纯 ASCII 降级。
*/
const UNICODE_GLYPHS = {
	sideQuestion: "◇",
	planSubmitted: "◈",
	planApproved: "✓",
	planRejected: "✗",
	planExecuted: "◆"
};
const ASCII_GLYPHS = {
	sideQuestion: "?",
	planSubmitted: "-",
	planApproved: "+",
	planRejected: "x",
	planExecuted: "*"
};
/**
* 当前终端应使用的字形集。
* @returns legacy 终端为 ASCII 降级档，其余为 Unicode 档。
*/
function uiGlyphs() {
	return useAsciiGlyphs() ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
//#endregion
//#region lib/types/index.js
/**
* @huiliyi37/dsh-tianshu-tui — interactive terminal UI profile bundle. The bundle
* patch rides over dsh-base and inserts this runner under the stable
* `tui-runner` id. Render core: the terminal rendering engine ported from
* `.rivet/tui-source/tui/` (Apache-2.0 source; see SOURCE-MAP.md for the
* per-file mapping). The engine is pure presentation — all agent state arrives
* via {@link TuiPort}.
*
* @module @huiliyi37/dsh-tianshu-tui
*/
/** Stable Cordis plugin name the bundle patch inserts. */
const name = "tui-runner";
/**
* Mount the terminal UI runner.
* @param ctx - plugin context; the render core wires its services here.
* @param config - stream injection and starting session (defaults to process).
*/
function apply(ctx, config = {}) {
	const themeWarnings = [];
	loadCustomThemes(void 0, (w) => {
		themeWarnings.push(w);
	});
	if (config.workflowHistoryLimit !== void 0 && (!Number.isInteger(config.workflowHistoryLimit) || config.workflowHistoryLimit <= 0)) throw new Error(`[tui-runner] workflowHistoryLimit must be a positive integer, got ${config.workflowHistoryLimit}`);
	if (config.activityBandMaxRows !== void 0 && (!Number.isInteger(config.activityBandMaxRows) || config.activityBandMaxRows <= 0)) throw new Error(`[tui-runner] activityBandMaxRows must be a positive integer, got ${config.activityBandMaxRows}`);
	const stdin = config.stdin ?? process.stdin;
	const stdout = config.stdout ?? process.stdout;
	process.on("exit", () => {
		try {
			if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
		} catch {}
	});
	ctx.inject([
		"sessions",
		"agents",
		"agentDefaultModel"
	], (runtimeCtx) => {
		const requestHostExit = () => {
			const exit = runtimeCtx.reflect.get("appExit", false);
			if (typeof exit === "function") exit(0);
			else process.exit(0);
		};
		const teardown = async (quit, restart = false) => {
			await app.dispose();
			if (restart) {
				if (!await spawnSelfRestart()) console.error("[tui-runner] 重启失败：无法重新启动当前命令，请手动运行 dsh --profile tui");
				requestHostExit();
				return;
			}
			if (quit) requestHostExit();
		};
		const app = new TuiApp({
			ctx: runtimeCtx,
			stdin,
			stdout,
			onExit: () => {
				teardown(true);
			},
			onRestart: () => {
				teardown(true, true);
			},
			...config.initialSessionId === void 0 ? {} : { initialSessionId: config.initialSessionId },
			...config.editorKey === void 0 ? {} : { editorKey: config.editorKey },
			...config.vimEnabled === void 0 ? {} : { vimEnabled: config.vimEnabled },
			...config.vision === void 0 ? {} : { vision: config.vision },
			...config.workflowHistoryLimit === void 0 ? {} : { workflowHistoryLimit: config.workflowHistoryLimit },
			...config.activityBand === void 0 ? {} : { activityBand: config.activityBand },
			...config.activityBandMaxRows === void 0 ? {} : { activityBandMaxRows: config.activityBandMaxRows },
			...config.lsp === void 0 ? {} : { lsp: config.lsp },
			...config.theme === void 0 ? {} : { theme: config.theme },
			...config.prefsPath === void 0 ? {} : { prefsPath: config.prefsPath },
			...config.inputHistoryPath === void 0 ? {} : { inputHistoryPath: config.inputHistoryPath },
			...config.disableKeyAutoPrompt === void 0 ? {} : { disableKeyAutoPrompt: config.disableKeyAutoPrompt },
			...themeWarnings.length === 0 ? {} : { themeWarnings }
		});
		let lastSigintAt = 0;
		const onSigint = () => {
			const now = Date.now();
			if (app.shouldDeferSigint(now)) return;
			if (now - lastSigintAt < 500) return;
			lastSigintAt = now;
			teardown(true);
		};
		process.on("SIGINT", onSigint);
		stdin.on("SIGINT", onSigint);
		ctx.effect(() => () => {
			stdin.off("SIGINT", onSigint);
			process.off("SIGINT", onSigint);
			return teardown(false);
		});
		let attachFailed = false;
		const attachPromise = app.attach().catch((err) => {
			attachFailed = true;
			app.dispose().finally(() => {
				console.error("[tui-runner] attach failed:", err);
			});
		});
		const autoRestartOnUpdate = config.autoRestartOnUpdate !== false;
		runSelfUpdate({ startDir: fileURLToPath(new URL(".", import.meta.url)) }).then(async (result) => {
			if (result.kind === "updated") {
				await attachPromise;
				if (attachFailed) return;
				if (autoRestartOnUpdate && app.isBlankSession()) {
					app.notifyAutoRestart(result.version);
					await new Promise((r) => setTimeout(r, 400));
					teardown(true, true);
				} else app.notifyPluginUpdated(result.version);
			} else if (result.kind === "failed") app.notifyPluginUpdateFailed(result.error);
		});
	});
}
//#endregion
export { ANSI, BUILTIN_COMMAND_NAMES, BlockStreamWriter, CommitEngine, FALLBACK_EDGE, FALLBACK_QUALITY, GUTTER, IMAGE_TEMP_DIR_PREFIX, INPUT_BOX_CHARS, InputController, InputHandler, InputLine, JPEG_QUALITY, LIVE_TOOL_CARD_MAX, LiveEngine, MAX_EDGE, MAX_IMAGES, MAX_IMAGE_BYTES, MIN_FRAME_INTERVAL_MS, OverlayEngine, QUERY_CURSOR_POS, QUERY_TERMINAL_SIZE, ResizeHandler, SLASH_MRU_MAX, SlashCommandRegistry, StatusLineRunner, StreamRenderer, THEMES, THEME_NAMES, THEME_PALETTES, TRUNCATION_MARKER_RE, TuiPerfMonitor, WorkflowStatusLine, WriteBatcher, ambiguousWideEnabled, ambiguousWidthMode, appendStreamWindow, apply, applyWorkflowEvent, assembleIdleKey, autoThemeFor, bg, boxCharsFor, boxInnerWidth, boxOuterWidth, brailleSpinnerFrame, capLiveTail, capLiveTailMarkdownSafe, charDisplayWidth, circleSpinnerFrame, clearCustomThemes, color, createBuiltinCommands, createRingBuffer, cumulativeRowsToMessage, cursorBack, cursorDown, cursorForward, cursorTo, cursorToCol, cursorUp, customThemesDir, detectHyperlinkSupport, detectImageMime, detectImageProtocol, detectTerminalBackground, displayRowsForText, displayWidth, emptyWorkflowView, encodeIterm2Image, encodeKittyImage, encodeTermImage, estimateMessageRows, exportCurrentTheme, fg, fileLink, findNextMatch, findPrevMatch, findStableBoundary, formatStatusLine, getActiveThemeBackground, getActiveThemeName, getTheme, gutterGlyph, hexToRgb, hyperlink, imageProtocol, inferPhaseFromTool, inputViewportMaxLines, isCjkLocale, isColorSuppressed, isCompletePng, isLegacyCjkConsole, isLegacyWindowsConsole, isTuiPerfEnabled, kittyKeyboardPopSeq, kittyKeyboardPushSeq, listCustomThemes, liveHasSpinner, liveIdleKey, liveMaxRowsFor, loadClipboardImageAttachment, loadCustomThemes, loadImageAttachment, looksLikeImagePath, makeImageTempDir, name, nextDynamicBudget, noColorRequested, osc52Clipboard, padDynamicRegion, parseColorFgBg, parseCustomThemeJson, parseImageDataUrl, parseOsc11Luminance, parseScrollbackTranscript, prepareTermImage, prepareTermImageForCommit, probeImageSize, registerCustomTheme, removeImageTempDir, resetCharWidthCache, resetTermCapsCache, resetWidthModeCache, resizeCandidates, resizeJpegCandidates, resolveSlashCommand, resolveThemeEntry, rgbToAnsi16Name, rgbToXterm256, runImageTool, searchTranscript, setColorSuppressed, setHyperlinksEnabled, setImageProtocol, setImageToolRunner, setTermImagePreparer, setTheme, shouldSkipIdleAssemble, suggestCommands, supportsKittyKeyboard, supportsOsc52, sweepStaleImageTempDirs, toPngCandidates, truncateToDisplayWidth, truncationHint, uiGlyphs, useAsciiBorders, useAsciiGlyphs, workingRowsCap, wrapToDisplayWidth };
