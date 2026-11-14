/**
 * ask_image — the vision co-pilot's query tool.
 *
 * Lets the main model re-interrogate an image the user already put into the
 * session, any number of times, from different angles — without the user
 * re-sending it.
 *
 * Two modes, chosen per call from the primary model's actual capability:
 *  - Multimodal primary (inputModalities includes image, or forced by config)
 *    → the original image is forwarded back as an image content block so the
 *    primary sees the pixels itself.
 *  - Text-only primary → the configured vision adapter answers the specific
 *    question; repeated same-angle asks hit the description cache (zero calls).
 *
 * Ported from opencode-tui's tools/ask-image.ts (Apache-2.0 upstream); adapted
 * to the dsh tool contract (canonical JSON value + output.render).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, HarnessError, LlmError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageRegistry, RegisteredImage } from './registry.ts'
import { visionCacheKey } from './registry.ts'
import { buildVisionMessage } from './vision-adapter.ts'

/** Canonical value of one ask_image call. */
export type AskImageValue =
  | { kind: 'answer'; answer: string; imageId: string; cached: boolean }
  | { kind: 'forwarded'; ref: ImageAttachmentRef; imageId: string; question: string }

const ASK_IMAGE_OUTPUT = {
  schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'answer' },
          answer: { type: 'string', required: true },
          imageId: { type: 'string', required: true },
          cached: { type: 'boolean', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'forwarded' },
          ref: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' },
            },
          },
          imageId: { type: 'string', required: true },
          question: { type: 'string', required: true },
        },
      },
    ],
  },
  render: (_args: unknown, value: AskImageValue) => {
    if (value.kind === 'answer') {
      return [{ type: 'text' as const, text: `${value.cached ? '（缓存）' : ''}${value.answer}` }]
    }
    // 多模态主控：原图引用直发，主控直接看像素。
    return [
      {
        type: 'text' as const,
        text: `已把图片（${value.imageId}）附上供你直接查看，请据此回答：${value.question}`,
      },
      { type: 'image' as const, attachment: value.ref },
    ]
  },
} as const

const ASK_IMAGE_DESCRIPTION =
  '就本会话中已发送的图片提出具体问题（视觉副驾）。'
  + '\n\n### 何时调用'
  + '\n- 用户发过图片，你需要就图中某个细节再确认（"第几行的报错文本"、"这个按钮的坐标"、"配色值"）。'
  + '\n- 你之前拿到的是图片描述，但需要换个角度看同一张图。'
  + '\n\n### 做了什么'
  + '\n把你的问题定向发给视觉模型（或在主控支持识图时直接附原图），返回针对该问题的答案。可反复调用、可指定不同图片。'
  + '\n\n### 字段'
  + '\n- question：你要问的具体问题（越具体越好，如"逐字念出红色报错那一行"）。'
  + '\n- imageId（可选）：目标图片 id（如 img_1）；省略则用最近一张图。'

/** 工具执行依赖：按会话隔离的注册表 + 视觉路由配置。 */
export interface AskImageDeps {
  /** 会话图片注册表（key = sessionId）。 */
  registries: ReadonlyMap<string, ImageRegistry>
  /** 视觉模型 route（注册在 llm 服务的 adapter provider 名）与模型 id。 */
  visionProvider: string
  visionModel: string
  /** 描述输出 token 上限。 */
  maxTokens: number
  /** true 强制多模态直发；false 强制走描述；undefined 动态判定。 */
  primarySupportsVision?: boolean
}

/** 定位调用会话的注册表并解析目标图片。 */
function resolveImage(
  deps: AskImageDeps,
  exec: ToolRunContext,
  imageId: string | undefined,
): { registry: ImageRegistry; image: RegisteredImage } {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('ask_image 需要调用 agent', 'ASK_IMAGE_AGENT_REQUIRED')
  }
  const registry = deps.registries.get(agent.session.id)
  if (registry === undefined || registry.size === 0) {
    throw new HarnessError(
      '视觉功能当前不可用：本会话还没有已发送的图片（图片在提交时自动登记，可先请用户发图）。'
      + '如需识图能力，请检查 vision-ask 插件配置。',
      'ASK_IMAGE_NO_IMAGE',
    )
  }
  const image = imageId !== undefined ? registry.get(imageId) : registry.get()
  if (image === undefined) {
    const known = registry.list().map(i => i.id).join('、')
    throw new HarnessError(
      `没有找到图片 ${imageId}（当前保留：${known || '无'}）。请用现有图片 id 重试。`,
      'ASK_IMAGE_NOT_FOUND',
    )
  }
  return { registry, image }
}

/** 主控是否原生识图：配置强制优先，否则动态查 resolveModelInfo 的 inputModalities。 */
async function primarySeesImages(
  deps: AskImageDeps,
  ctx: Context,
  exec: ToolRunContext,
): Promise<boolean> {
  if (deps.primarySupportsVision !== undefined) return deps.primarySupportsVision
  const agent = exec.agent
  const provider = agent?.options.provider
  const model = agent?.options.model
  if (provider === undefined || model === undefined) return false
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
    return resolved.inputModalities?.includes('image') ?? false
  } catch {
    // 主控模型未知/查询失败：按 text-only 走描述路径（描述始终可用，不炸轮）。
    return false
  }
}

/** 描述路径：缓存命中零调用；未命中经视觉 adapter 定向回答。 */
async function describeImage(
  deps: AskImageDeps,
  ctx: Context,
  exec: ToolRunContext,
  registry: ImageRegistry,
  image: RegisteredImage,
  question: string,
): Promise<{ answer: string; cached: boolean }> {
  const key = visionCacheKey(question)
  const cached = registry.getCachedDescription(image.id, key)
  if (cached !== undefined) return { answer: cached, cached: true }

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: deps.visionProvider,
    model: deps.visionModel,
    messages: [buildVisionMessage(question, [image.ref])],
    maxTokens: deps.maxTokens,
    signal: exec.signal,
  })) {
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    // 视觉 provider 的 code 由本适配器自定（不保证是内置码），按 failure 原样重抛。
    throw LlmError.fromFailure(finish.failure)
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const answer = (finish.kind === 'max-tokens' ? `${text}\n[图片描述被截断]` : text).trim()
  if (answer.length === 0) {
    throw new LlmError('视觉模型返回了空描述，请换种问法重试', 'EMPTY_RESPONSE')
  }
  registry.cacheDescription(image.id, key, answer)
  return { answer, cached: false }
}

/**
 * 构造 ask_image 工具定义（可测试工厂；注册与定义分离）。
 * @param ctx - plugin context（llm 服务用于视觉调用与主控能力查询）。
 * @param deps - 注册表与视觉路由（由插件 apply 组装）。
 * @returns ask_image 的 ToolDefinition。
 */
export function askToolDefinition(ctx: Context, deps: AskImageDeps) {
  return defineTool({
    name: 'ask_image',
    description: ASK_IMAGE_DESCRIPTION,
    parameters: {
      question: { type: 'string', required: true, description: '就图片提出的具体问题' },
      imageId: { type: 'string', description: '可选：目标图片 id（如 img_1），省略用最近一张' },
    },
    output: ASK_IMAGE_OUTPUT,
    async execute(args, exec) {
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (question.length === 0) {
        throw new HarnessError('question 必填（要就图片问的具体问题）', 'ASK_IMAGE_INVALID_QUESTION')
      }
      const imageId = typeof args.imageId === 'string' && args.imageId.trim().length > 0
        ? args.imageId.trim()
        : undefined
      const { registry, image } = resolveImage(deps, exec, imageId)
      if (await primarySeesImages(deps, ctx, exec)) {
        return { kind: 'forwarded', ref: image.ref, imageId: image.id, question } as const
      }
      const { answer, cached } = await describeImage(deps, ctx, exec, registry, image, question)
      return { kind: 'answer', answer, imageId: image.id, cached } as const
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Ask image',
      kind: 'other',
      ...typeof args.question === 'string' ? { rawInput: args.question } : {},
    }),
    isConcurrencySafe: () => false,
  })
}

/**
 * 注册 ask_image 工具。返回 disposer（与 ctx.tools.register 一致）。
 * @param ctx - plugin context（llm/tools 服务）。
 * @param deps - 注册表与视觉路由（由插件 apply 组装）。
 * @returns 工具注册的 disposer。
 */
export function registerAskImageTool(ctx: Context, deps: AskImageDeps): () => void {
  return ctx.tools.register(askToolDefinition(ctx, deps))
}
