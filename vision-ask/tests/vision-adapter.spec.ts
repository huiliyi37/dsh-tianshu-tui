/**
 * vision-adapter — OpenAI 兼容视觉 adapter 契约测试。
 *
 * - parseSse：事件帧解析、[DONE] 哨兵、截断抛 STREAM_CLOSED
 * - mapFinishReason / mapUsage / translateChunk 纯函数
 * - VisionAdapter.stream：mock fetch + mock attachments（image block →
 *   image_url parts；finish 单发；空输出改判 EMPTY_RESPONSE）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  buildVisionMessage,
  mapFinishReason,
  mapUsage,
  parseSse,
  translateChunk,
  VisionAdapter,
} from '../src/vision-adapter.ts'

/** 每个流式测试前提供 key；afterEach 恢复环境。 */
const PREVIOUS_VISION_KEY = process.env.VISION_KEY
beforeEach(() => { process.env.VISION_KEY = 'test-key' })
afterEach(() => {
  if (PREVIOUS_VISION_KEY === undefined) delete process.env.VISION_KEY
  else process.env.VISION_KEY = PREVIOUS_VISION_KEY
  vi.unstubAllGlobals()
})

function ref(): ImageAttachmentRef {
  return {
    attachmentId: 'att_1' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
  }
}

/** 把字符串事件组装成 SSE 字节流。 */
function sseStream(...events: string[]): ReadableStream<Uint8Array> {
  const body = events.map(data => `data: ${data}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

describe('parseSse', () => {
  it('逐事件产出 data，[DONE] 为最后一项', async () => {
    const events: string[] = []
    for await (const data of parseSse(sseStream('{"a":1}', '[DONE]'))) events.push(data)
    expect(events).toEqual(['{"a":1}', '[DONE]'])
  })

  it('无 [DONE] 正常结束（截断由调用方裁决）；多行 data 拼接；CRLF 兼容', async () => {
    const events: string[] = []
    const body = 'data: {"a":1}\n\n' + 'data: line1\r\ndata: line2\r\n\r\n'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    for await (const data of parseSse(stream)) events.push(data)
    expect(events).toEqual(['{"a":1}', 'line1\nline2'])
  })

  it('注释行忽略；无 data 字段的帧不产出', async () => {
    const events: string[] = []
    // 原始 SSE 文本：注释行（: ...）不应产出事件。
    const body = ': keep-alive\n\n' + 'data: {"b":2}\n\n' + 'data: [DONE]\n\n'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    for await (const data of parseSse(stream)) events.push(data)
    expect(events).toEqual(['{"b":2}', '[DONE]'])
  })
})

describe('mapFinishReason / mapUsage / translateChunk', () => {
  it('finish_reason 映射', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toMatchObject({ kind: 'error', failure: { code: 'CONTENT_FILTER' } })
    expect(mapFinishReason('weird')).toMatchObject({ kind: 'error', failure: { code: 'WEIRD' } })
  })

  it('usage：cache 读从输入中扣除', () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }))
      .toEqual({ inputTokens: 6, outputTokens: 5, cacheReadTokens: 4 })
  })

  it('translateChunk：text delta 产出 block-start/text-delta', () => {
    const chunks = [...translateChunk({ choices: [{ delta: { content: '你好' } }] })]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
    ])
  })

  it('translateChunk：usage 与空 delta', () => {
    const chunks = [...translateChunk({ usage: { prompt_tokens: 1, completion_tokens: 1 } })]
    expect(chunks[0]).toMatchObject({ type: 'usage' })
  })
})

describe('VisionAdapter.stream', () => {
  const CONFIG = { baseUrl: 'https://vision.test', apiKeyEnv: 'VISION_KEY', model: 'vl-1', maxTokens: 256 }

  function mockFetch(chunks: Array<Record<string, unknown>>) {
    const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    // 参数类型带上 fetch 签名（url/init），断言侧才能读 calls[0][1].body。
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function mockCtx() {
    return {
      reflect: {
        get: () => ({
          readImage: async () => ({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
        }),
      },
    } as never
  }

  function message(): Message {
    return buildVisionMessage('这张图里有什么？', [ref()])
  }

  it('成功流：text delta + usage + 单 finish（stop）', async () => {
    const fetchMock = mockFetch([
      { choices: [{ delta: { content: '一个' } }] },
      { choices: [{ delta: { content: '错误框' } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    const chunks: string[] = []
    let finishCount = 0
    for await (const chunk of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
      if (chunk.type === 'finish') finishCount += 1
    }
    expect(chunks.join('')).toBe('一个错误框')
    expect(finishCount).toBe(1)
    // 请求体：image_url part 存在且含 data URL
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { messages: Array<{ content: unknown[] }> }
    const parts = body.messages[0]?.content
    expect(parts).toHaveLength(2)
    expect(parts?.[1]).toMatchObject({ type: 'image_url', image_url: { url: expect.stringContaining('data:image/png;base64,') } })
  })

  it('stop 但无文本 → EMPTY_RESPONSE finish', async () => {
    mockFetch([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    const finishes: unknown[] = []
    for await (const chunk of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) {
      if (chunk.type === 'finish') finishes.push(chunk.reason)
    }
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } })
  })

  it('截断（无 finish 且无 [DONE]）→ STREAM_CLOSED finish', async () => {
    const fetchMock = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"半"}}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    const finishes: unknown[] = []
    for await (const chunk of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) {
      if (chunk.type === 'finish') finishes.push(chunk.reason)
    }
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ kind: 'error', failure: { code: 'STREAM_CLOSED' } })
  })

  it('缺 API key → AUTH 错误（不发起请求）', async () => {
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    const previous = process.env.VISION_KEY
    delete process.env.VISION_KEY
    try {
      await expect(async () => {
        for await (const _ of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) { /* drain */ }
      }).rejects.toMatchObject({ code: 'AUTH' })
    } finally {
      if (previous !== undefined) process.env.VISION_KEY = previous
    }
  })

  it('HTTP 401 → AUTH 错误', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.VISION_KEY = 'k'
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('HTTP 429 → 内置 RATE_LIMIT 码', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.VISION_KEY = 'k'
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('无法归类的 HTTP 状态 → HTTP_<status> 内置形态', async () => {
    // 418 不落在 401/403/429/5xx/400 任一分支，走兜底；宿主接受 `HTTP_<number>` 形态，
    // 不再从响应体截字符臆造码。
    const fetchMock = vi.fn(async () => new Response('teapot says no', { status: 418 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.VISION_KEY = 'k'
    const adapter = new VisionAdapter(mockCtx(), CONFIG)
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'vision-ask', model: 'vl-1', messages: [message()] })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'HTTP_418' })
  })
})
