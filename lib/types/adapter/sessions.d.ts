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
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, SessionForkSource, SessionId } from '@deepseek-ai/dsh-session';
import { SessionLogOffset } from '@deepseek-ai/dsh-session';
/** One session row for the TUI session list. */
export interface SessionSummary {
    /** Session identity (shared with its agent, when live). */
    readonly id: SessionId;
    /** On-disk format version from the durable header. */
    readonly version: number;
    /** Non-negative safe-integer Unix epoch milliseconds of creation. */
    readonly createdAt: number;
    /** Working directory the session was bound to, when recorded. */
    readonly cwd: string | undefined;
    /** The session this one was forked from, when known. */
    readonly parentSession: SessionId | undefined;
    /**
     * Agent preset id in effect for the session (header 创建值 + 日志切换值 fold；
     * 持久化会话无事件日志时回落 header 值）。null = 未记录（host 未装配 preset）。
     */
    readonly agentPreset: string | undefined;
}
/**
 * List known sessions, newest first. Persisted sessions come from
 * `ctx.sessionPersistence` (metadata-only listing) when that service is
 * configured; otherwise the live in-memory store's headers are used.
 * @param ctx - any context exposing `ctx.sessions` and optionally
 *   `ctx.sessionPersistence`.
 * @returns one summary per known session, ordered by `createdAt` descending.
 */
export declare function listSessions(ctx: Context): Promise<SessionSummary[]>;
/**
 * Resolve the live session object for an id.
 * @param ctx - any context exposing `ctx.sessions`.
 * @param id - the session id to look up.
 * @returns the live session, or `undefined` when not in the live store.
 */
export declare function getSession(ctx: Context, id: SessionId): Session | undefined;
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
export declare function liveForkSeed(events: readonly SessionEvent[]): readonly SessionEvent[];
/**
 * 组装 agents.create 的 fork 参数（seed + 血缘 meta）。
 * @param parent - 源 live 会话。
 * @param fallbackCwd - header.cwd 缺失时的工作区（启动目录）。
 */
export declare function forkAgentSpec(parent: Session, fallbackCwd: string, parentSessionId?: SessionId): {
    seed: readonly SessionEvent[];
    meta: {
        cwd: string;
        parentSession: SessionId;
        isSeeded: boolean;
    };
    inheritedEventCount: SessionLogOffset;
};
export declare function forkSession(ctx: Context, source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session;
/**
 * Load a session's event log for display. A live session's in-process log is
 * authoritative (it includes events not yet flushed); a persisted-only session
 * is loaded through `ctx.sessionPersistence.inspect` when available.
 * @param ctx - any context exposing `ctx.sessions` and optionally
 *   `ctx.sessionPersistence`.
 * @param id - the session whose log is requested.
 * @returns the immutable event log, or an empty array when the session is unknown.
 */
export declare function loadHistory(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]>;
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
export declare function findMostRecentEmptySession(ctx: Context): Promise<SessionSummary | undefined>;
/** 启动复用候选扫描上限（只翻最近 N 个会话）。 */
export declare const REUSE_SCAN_LIMIT = 15;
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
export declare function clearEmptySessionArtifact(ctx: Context, summary: SessionSummary): Promise<boolean>;
/**
 * Flush every live session to durable storage — the teardown checkpoint.
 * Each flush dispatches the awaited `session/flush` durability barrier through
 * `ctx.sessions.flush`; persistence plugins drain their buffers there.
 * @param ctx - any context exposing `ctx.sessions`.
 * @returns after every live session's flush has settled; the first listener
 *   failure propagates.
 */
export declare function flushAll(ctx: Context): Promise<void>;
