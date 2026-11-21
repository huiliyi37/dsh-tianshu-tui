/**
 * LaTeX → Unicode 渲染契约测试。
 *
 * 这两个模块扛着 TUI 的数学公式渲染（`src/format/markdown.ts` 直接消费），
 * 是纯函数、无 I/O，却长期没有测试。断言写的是**承诺的行为**：空输入原样、
 * 未知命令降级、反货币启发式、非数学环境不被误改——而不是内部实现细节。
 */
import { describe, expect, it } from 'vitest'
import {
  inlineMathSpanEnd,
  isBareMathEnvironment,
  latexToUnicode,
  renderMathInText,
} from '../src/pi/latex-to-unicode.js'
import { latexToBlock } from '../src/pi/latex-block.js'

describe('latexToUnicode', () => {
  it('空串与非字符串原样返回，不抛错', () => {
    expect(latexToUnicode('')).toBe('')
    expect(latexToUnicode(undefined as unknown as string)).toBeUndefined()
  })

  it('常见命令转成 Unicode 字形', () => {
    expect(latexToUnicode('\\alpha')).toBe('α')
    expect(latexToUnicode('\\sqrt{x}')).toBe('√x')
    expect(latexToUnicode('\\mathbb{R}')).toBe('ℝ')
    expect(latexToUnicode('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿ i')
    expect(latexToUnicode('\\int_0^1 x dx')).toBe('∫₀¹ x dx')
  })

  it('上下标转成 Unicode 上/下标字符', () => {
    expect(latexToUnicode('x^2')).toBe('x²')
  })

  it('分数在没有横向空间时退化成 a/b', () => {
    expect(latexToUnicode('\\frac{a}{b}')).toBe('a/b')
  })

  it('未知命令降级为裸名，不留下反斜杠', () => {
    expect(latexToUnicode('\\unknowncmd')).toBe('unknowncmd')
  })

  it('双反斜杠转换行', () => {
    expect(latexToUnicode('a\\\\b')).toBe('a\nb')
  })
})

describe('isBareMathEnvironment', () => {
  it('星号变体与本体同等对待', () => {
    expect(isBareMathEnvironment('align*')).toBe(true)
    expect(isBareMathEnvironment('align')).toBe(true)
  })

  it('矩阵类环境可裸渲染', () => {
    expect(isBareMathEnvironment('pmatrix')).toBe(true)
    expect(isBareMathEnvironment('cases')).toBe(true)
  })

  it('文本模式环境拒绝裸渲染', () => {
    for (const env of ['tabular', 'itemize', 'verbatim', 'document']) {
      expect(isBareMathEnvironment(env), env).toBe(false)
    }
  })
})

describe('inlineMathSpanEnd', () => {
  it('正常闭合返回闭合符索引', () => {
    expect(inlineMathSpanEnd('$x$', 0)).toBe(2)
  })

  it('开符后紧跟空白不算数学（防货币）', () => {
    expect(inlineMathSpanEnd('$ x$', 0)).toBe(-1)
  })

  it('未闭合返回 -1', () => {
    expect(inlineMathSpanEnd('$x', 0)).toBe(-1)
  })

  it('跨行返回 -1（行内数学不跨行）', () => {
    expect(inlineMathSpanEnd('$a\nb$', 0)).toBe(-1)
  })

  it('货币写法不被当成闭合', () => {
    expect(inlineMathSpanEnd('$5 and $10', 0)).toBe(-1)
  })
})

describe('renderMathInText', () => {
  it('行内、显示、括号三种定界符都渲染', () => {
    expect(renderMathInText('in $x^2$ end')).toBe('in x² end')
    expect(renderMathInText('$$a+b$$')).toBe('a+b')
    expect(renderMathInText('\\(y\\)')).toBe('y')
  })

  it('反货币启发式：$5 and $10 原样保留', () => {
    expect(renderMathInText('$5 and $10')).toBe('$5 and $10')
  })

  it('转义美元是字面量，不作定界符', () => {
    expect(renderMathInText('\\$5')).toBe('$5')
  })

  it('行内数学不跨行，跨行时保留原文', () => {
    expect(renderMathInText('$a\n+b$')).toBe('$a\n+b$')
  })

  it('裸 align 环境（无定界符）也能渲染', () => {
    const out = renderMathInText('\\begin{align}\na &= b\n\\end{align}')
    expect(out).toMatch(/a\s*=\s*b/)
    expect(out).not.toContain('\\begin')
  })

  it('非数学环境整体原样保留，连包裹带内容都不动', () => {
    const src = '\\begin{verbatim}\n\\frac{a}{b}\n\\end{verbatim}'
    expect(renderMathInText(src)).toBe(src)
  })

  it('不含数学标记的文本原样返回（快速路径）', () => {
    expect(renderMathInText('plain text')).toBe('plain text')
    expect(renderMathInText('')).toBe('')
  })
})

describe('latexToBlock', () => {
  it('空串与纯空白返回空数组', () => {
    expect(latexToBlock('')).toEqual([])
    expect(latexToBlock('   ')).toEqual([])
  })

  it('单行表达式原样输出', () => {
    expect(latexToBlock('x = 1')).toEqual(['x = 1'])
  })

  it('源码换行变成独立的行', () => {
    expect(latexToBlock('a = 1\nb = 2')).toEqual(['a = 1', 'b = 2'])
  })

  it('分数在 display 模式下垂直堆叠成三行', () => {
    const lines = latexToBlock('\\frac{a}{b}')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('a')
    expect(lines[1]).toContain('─')
    expect(lines[2]).toContain('b')
  })
})
