#!/usr/bin/env node
/**
 * blue 欢迎页鲸鱼像素资产生成管线（scripts/generate-welcome-blue.mjs）。
 *
 * assets/welcome-blue-source.png（蓝鲸抱星原图，无字幕带，底部带水面倒影/水沫）
 * → src/format/whale-blue-frames.ts：
 * - 内容 bbox 检测（本图无字幕带，不做字幕切除——底部鲸鱼与水沫之间的
 *   稀疏间隙会误触 generate-welcome-star.mjs 的「间隙后仍有内容」下刀规则）
 * - 边缘洪泛抠图（omts author 同款）：连通外界的近背景色才判透明，
 *   被包围的暗色（眼睛/背部螺旋纹，均与背景色距离 <5）全保，不误吃成洞
 * - 逐格统计投影（替代单点最近邻）：每格映射回源矩形，掩码按格内不透明
 *   覆盖率判定（星芒尖角/气泡圈/水沫等细结构在 21px→1px 单点采样下凭
 *   运气，覆盖率采样稳定保留），颜色取格内不透明像素的逐通道中位色
 *  （抗边缘背景污染与噪点，区域色为众数而非几何中心那一颗像素）
 * - 关键色锚定（星核/星金/腮红粉/白肚/身体主蓝/顶部高光蓝 6 色，防小面积
 *   关键色被 median-cut 稀释）+ 内容像素 median-cut 9 色 = 15 色调色板
 * - 每像素归一到最近调色板色（2:4:3 感知加权），输出单 hex 位索引行
 *  （0 = 透明，1–F = 调色板下标）
 *
 * 用法：node scripts/generate-welcome-blue.mjs（LIFT=1 可选暗色终端提亮）
 * 运行时机：更换品牌原图后手工重跑并提交生成物；CI 校验由
 * tests/whale-blue.spec.ts 的形状/调色板不变量兜底。
 */
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, 'assets/welcome-blue-source.png')
const OUTPUT = resolve(ROOT, 'src/format/whale-blue-frames.ts')

/** 像素网格列数（half-block 渲染 1 像素/列 → 44 文本列；与 star 同款上限：
 * 块字符（U+2580–259F）在「ambiguous 按宽渲染」的终端上占 2 列，88 列在
 * ≥96 列终端内不折行；更宽的画在该类终端会逐行折散）。
 * 行数按内容宽高比动态计算（2 的倍数），保纵横比不拉伸。 */
const PIXEL_COLS = 44
/** median-cut 主色族色数（+ 6 锚色 = 15 色板）。 */
const N_BLUES = 9

/** 暗色终端显示提亮（同 star 管线；默认关闭，LIFT=1 开启）。 */
const LIFT_FLOOR = 100
const LIFT_FACTOR = 1.45
const LIFT_ENABLED = process.env.LIFT === '1'

/** 必须保住的锚色（从原图采样，见 /tmp/whale-extract/sample.py 采样点；
 * 小面积但构图关键）。顺序约定：[0] 纯白兼作眼睛高光补点色。 */
const ANCHORS = [
  [253, 253, 253], // 星核心白炽（兼眼白点）
  [253, 244, 178], // 星金
  [253, 140, 178], // 腮红粉
  [200, 219, 253], // 白肚
  [16, 72, 191], // 身体主蓝
  [71, 154, 255], // 顶部高光/水沫亮蓝
]

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const distW = (a, b) => 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** 读图 → { width, height, pixels: [r,g,b][] }。 */
async function loadRgb(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixels = []
  for (let i = 0; i < data.length; i += 3) pixels.push([data[i], data[i + 1], data[i + 2]])
  return { width: info.width, height: info.height, pixels }
}

/** 内容 bbox：与四角背景色距离 > 40 的像素范围。 */
function contentBbox({ width, height, pixels }) {
  const bg = pixels[0]
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dist(pixels[y * width + x], bg) > 40) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, bg }
}

/** 逐格统计投影：每格映射回源图矩形。
 * - 掩码：格内不透明像素覆盖率 ≥ COVER_MIN → 内容格（细结构稳定保留；
 *   单点最近邻在 21px→1px 降采样下会凭运气丢星芒尖角/气泡圈/水沫）。
 *   调低更保细线条、调高更去边缘毛刺（0.25/0.3/0.4 三联对比实测：
 *   0.25 水沫/星芒细节最全且背景仍干净，0.4 明显丢水沫）。
 * - 颜色：格内不透明像素逐通道中位色（不用均值——边缘格混入背景会拉灰；
 *   不用单点——21 取 1 全凭运气）。勿用 lanczos/面积平均整图缩放，混色毁像素画。 */
const COVER_MIN = Number(process.env.COVER_MIN ?? '0.25')
function projectGrid({ width, pixels }, mask, bbox, pixelRows) {
  const cellW = bbox.width / PIXEL_COLS
  const cellH = bbox.height / pixelRows
  const colors = []
  const maskGrid = Buffer.alloc(PIXEL_COLS * pixelRows)
  const at = (x, y) => pixels[(bbox.top + y) * width + (bbox.left + x)]
  for (let gy = 0; gy < pixelRows; gy++) {
    const y0 = Math.floor(gy * cellH)
    const y1 = Math.min(bbox.height, Math.max(y0 + 1, Math.round((gy + 1) * cellH)))
    for (let gx = 0; gx < PIXEL_COLS; gx++) {
      const x0 = Math.floor(gx * cellW)
      const x1 = Math.min(bbox.width, Math.max(x0 + 1, Math.round((gx + 1) * cellW)))
      const rs = [], gs = [], bs = []
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++
          if (mask.data[y * mask.width + x] === 0) continue
          const p = at(x, y)
          rs.push(p[0]); gs.push(p[1]); bs.push(p[2])
        }
      }
      const gi = gy * PIXEL_COLS + gx
      if (rs.length / total < COVER_MIN) { colors.push([0, 0, 0]); continue }
      maskGrid[gi] = 255
      rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b)
      const m = rs.length >> 1
      colors.push([rs[m], gs[m], bs[m]])
    }
  }
  return { colors, maskGrid }
}

/** median-cut 量化：pixels → n 个均值色。 */
function medianCut(pixels, n) {
  let boxes = [pixels]
  while (boxes.length < n) {
    // 找「最大通道极差 × 像素数」最大的盒子切
    let target = -1, targetScore = -1, targetCh = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.length < 2) continue
      let bestRange = 0, bestCh = 0
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0
        for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch] }
        if (hi - lo > bestRange) { bestRange = hi - lo; bestCh = ch }
      }
      const score = bestRange * box.length
      if (score > targetScore) { target = i; targetScore = score; targetCh = bestCh }
    }
    if (target < 0) break
    const box = boxes.splice(target, 1)[0].slice().sort((a, b) => a[targetCh] - b[targetCh])
    const mid = box.length >> 1
    boxes.push(box.slice(0, mid), box.slice(mid))
  }
  return boxes.map((box) => {
    const n = box.length
    return [0, 1, 2].map((ch) => Math.round(box.reduce((s, p) => s + p[ch], 0) / n))
  })
}

/** 洪泛抠图（omts author-welcome-whale-assets keyBackground 同款）：从裁切区
 * 四缘出发，把「与角点背景色距离 < 阈值」且连通到边缘的像素判透明；
 * 被内容包围的暗像素（眼睛、背部螺旋纹）到不了边缘 → 全部保住。 */
const FLOOD_DIST = 48
function opaqueMask({ width, pixels }, bbox) {
  const W = bbox.width, H = bbox.height
  const mask = Buffer.alloc(W * H, 255)
  const visited = new Uint8Array(W * H)
  const queue = []
  const at = (x, y) => pixels[(bbox.top + y) * width + (bbox.left + x)]
  const enqueue = (x, y) => {
    const i = y * W + x
    if (visited[i] || dist(at(x, y), bbox.bg) >= FLOOD_DIST) return
    visited[i] = 1
    queue.push(i)
  }
  for (let x = 0; x < W; x++) { enqueue(x, 0); enqueue(x, H - 1) }
  for (let y = 0; y < H; y++) { enqueue(0, y); enqueue(W - 1, y) }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    mask[i] = 0
    const x = i % W, y = Math.floor(i / W)
    if (x > 0) enqueue(x - 1, y)
    if (x < W - 1) enqueue(x + 1, y)
    if (y > 0) enqueue(x, y - 1)
    if (y < H - 1) enqueue(x, y + 1)
  }
  return { data: mask, width: W, height: H }
}

const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`

// ── 主流程 ──────────────────────────────────────────────────
const src = await loadRgb(SOURCE)
const bbox = contentBbox(src)
console.log(`内容 bbox: ${bbox.width}×${bbox.height} @ (${bbox.left},${bbox.top})，背景 #${bbox.bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)

// 网格行数按内容宽高比（2 的倍数，half-block 2 像素/文本行）
const PIXEL_ROWS = Math.max(2, Math.round(PIXEL_COLS * (bbox.height / bbox.width) / 2) * 2)
console.log(`像素网格: ${PIXEL_COLS}×${PIXEL_ROWS}`)
const { colors: grid, maskGrid } = projectGrid(src, opaqueMask(src, bbox), bbox, PIXEL_ROWS)

// 内容像素（不透明、非锚色邻近）参与 median-cut；锚色独享槽位防稀释
const content = grid.filter((p, i) => maskGrid[i] >= 128 && Math.min(...ANCHORS.map((a) => distW(p, a))) >= 2500)
const blues = medianCut(content, N_BLUES)
// 像素归类用原始色，发射调色板做暗色终端提亮（索引不变）
const paletteRaw = [...blues, ...ANCHORS]
const palette = paletteRaw.map((c, i) => {
  if (!LIFT_ENABLED || i >= blues.length) return c
  return lum(c) < LIFT_FLOOR ? c.map((v) => Math.min(255, Math.round(v * LIFT_FACTOR))) : c
})
console.log('调色板:', palette.map(hex).join(' '))

// 每像素 → 最近调色板色（1–F）；掩码透明 → 0
const rows = []
for (let y = 0; y < PIXEL_ROWS; y++) {
  let row = ''
  for (let x = 0; x < PIXEL_COLS; x++) {
    const i = y * PIXEL_COLS + x
    if (maskGrid[i] < 128) { row += '0'; continue }
    const p = grid[i]
    let best = 0, bestD = Infinity
    for (let k = 0; k < paletteRaw.length; k++) {
      const d = distW(p, paletteRaw[k])
      if (d < bestD) { best = k; bestD = d }
    }
    row += (best + 1).toString(16)
  }
  rows.push(row)
}

// ── 精细化后处理 ────────────────────────────────────────────
const g = rows.map((r) => [...r].map((c) => Number.parseInt(c, 16)))
const H = g.length, W = g[0].length
const around = function* (x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const nx = x + dx, ny = y + dy
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) yield [nx, ny]
    }
  }
}

// 1. 填内部小洞：透明格且 8 邻 ≥6 个内容格 → 取邻居众数色（采样裂缝/噪洞；
//    孤立气泡与水沫邻居少，不受影响）。
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (g[y][x] !== 0) continue
    const cnt = new Map()
    for (const [nx, ny] of around(x, y)) {
      if (g[ny][nx] !== 0) cnt.set(g[ny][nx], (cnt.get(g[ny][nx]) ?? 0) + 1)
    }
    const total = [...cnt.values()].reduce((a, b) => a + b, 0)
    if (total < 6) continue
    let bestK = 0, bestN = -1
    for (const [k, n] of cnt) if (n > bestN) { bestK = k; bestN = n }
    g[y][x] = bestK
  }
}

// 2. 眼睛高光：最深色调色板槽位的中部连通簇（≥4 格 = 眼睛）左上角补 1 格白
//   （44 列下原图眼白点会被采样吞掉，不补就是死鱼眼）。最深色按亮度现场
//   定位（median-cut 槽位顺序不保证）；簇 meanY 限 (H/3, 2H/3) 中段——
//   上 1/3 的暗簇是背部螺旋纹、底部暗簇是身体下缘描边/水影，均排除。
{
  let darkest = 1, darkestLum = Infinity
  for (let k = 0; k < paletteRaw.length; k++) {
    const l = lum(paletteRaw[k])
    if (l < darkestLum) { darkestLum = l; darkest = k + 1 }
  }
  const WHITE = 10 // 锚色[0] 星核心白炽的发射索引（median-cut 9 色之后第 1 个）
  const seen = new Set()
  let eyeCluster = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y][x] !== darkest || seen.has(`${x},${y}`)) continue
      const cluster = []
      const q = [[x, y]]
      seen.add(`${x},${y}`)
      while (q.length > 0) {
        const [cx, cy] = q.pop()
        cluster.push([cx, cy])
        for (const [nx, ny] of around(cx, cy)) {
          if (!seen.has(`${nx},${ny}`) && g[ny][nx] === darkest) {
            seen.add(`${nx},${ny}`)
            q.push([nx, ny])
          }
        }
      }
      if (cluster.length >= 4) {
        const meanY = cluster.reduce((s, c) => s + c[1], 0) / cluster.length
        if (meanY > H / 3 && meanY < (2 * H) / 3 && cluster.length > eyeCluster.length) eyeCluster = cluster
      }
    }
  }
  if (eyeCluster.length > 0) {
    eyeCluster.sort((a, b) => a[1] - b[1] || a[0] - b[0])
    const [ex, ey] = eyeCluster[0]
    g[ey][ex] = WHITE
    console.log(`眼高光补点 @ (${ex},${ey})，眼簇 ${eyeCluster.length} 格（最深色槽位 ${darkest.toString(16)}）`)
  } else {
    console.log('警告：未定位到眼睛簇，未补高光')
  }
}

const outRows = g.map((r) => r.map((v) => v.toString(16)).join(''))

const banner = `/**
 * 生成物：scripts/generate-welcome-blue.mjs 由 assets/welcome-blue-source.png 产出，勿手改。
 *
 * blue 欢迎页抱星鲸鱼索引像素资产：${PIXEL_COLS}×${PIXEL_ROWS} 像素网格（贴合原图内容
 * 宽高比），half-block 渲染 1×2 像素一格 → ${PIXEL_COLS}×${PIXEL_ROWS / 2} 文本格。索引为单 hex 位：
 * 0 = 透明，1–F = BLUE_WHALE_FRAME_PALETTE 下标。调色板 15 色 =
 * median-cut 9 主色 + 锚定 6 关键色（星核/星金/腮红粉/白肚/身体主蓝/高光蓝）。
 * 换图重跑：node scripts/generate-welcome-blue.mjs
 */

/** 像素网格列数（half-block 渲染文本列 = 本值）。 */
export const BLUE_WHALE_PIXEL_COLS = ${PIXEL_COLS}
/** 像素网格行数（half-block 渲染文本行 = 本值 / 2）。 */
export const BLUE_WHALE_PIXEL_ROWS = ${PIXEL_ROWS}

/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
export const BLUE_WHALE_FRAME_PALETTE: readonly (\`#\${string}\` | null)[] = [
  null,
${palette.map((c) => `  '${hex(c)}',`).join('\n')}
]

/** 索引像素行（${PIXEL_ROWS} 行 × ${PIXEL_COLS} 列，单 hex 位/像素，0 = 透明）。 */
export const BLUE_WHALE_FRAME_ROWS: readonly string[] = [
${outRows.map((r) => `  '${r}',`).join('\n')}
]
`

await writeFile(OUTPUT, banner)
console.log(`已生成 ${OUTPUT}`)
