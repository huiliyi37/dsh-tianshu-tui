#!/usr/bin/env node
/**
 * star 欢迎页鲸鱼像素资产生成管线（scripts/generate-welcome-star.mjs）。
 *
 * assets/welcome-star-source.png（品牌原图，紫鲸举星 + DeepSeek› 字幕带）
 * → src/format/whale-star-frames.ts：
 * - 字幕带切除（底部行内容密度间隙检测）→ 内容 bbox 检测
 * - 边缘洪泛抠图（omts author 同款）：连通外界的近背景色才判透明，
   被包围的暗色（眼睛/暗紫阴影）全保，不再误吃身体暗部成洞
 * - 最近邻采样到原生像素网格（源图艺术像素 ≈7.5px 实测游程；网格行数按
 *   内容宽高比取 4 的倍数，不拉伸）——勿用 lanczos/面积平均，混色毁像素画
 * - 关键色锚定（星核/星金/光晕粉/白肚/身体紫/鳍蓝 6 色，防小面积关键色被
 *   median-cut 稀释）+ 内容像素 median-cut 9 色 = 15 色调色板
 * - 每像素归一到最近调色板色（2:4:3 感知加权），输出单 hex 位索引行
 *  （0 = 透明，1–F = 调色板下标）
 *
 * 用法：node scripts/generate-welcome-star.mjs（LIFT=1 可选暗色终端提亮）
 * 运行时机：更换品牌原图后手工重跑并提交生成物；CI 校验由
 * tests/whale-star.spec.ts 的形状/调色板不变量兜底。
 */
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, 'assets/welcome-star-source.png')
const OUTPUT = resolve(ROOT, 'src/format/whale-star-frames.ts')

/** 像素网格列数（half-block 渲染 1 像素/列 → 44 文本列；渐变图用实色双拼，
 * 不用盲文点阵——渐变区盲文格全混色，亮点归前景点/暗点归背景即成麻点）。
 * 44 = omts 最宽档：块字符（U+2580–259F）在「ambiguous 按宽渲染」的终端上
 * 占 2 列，88 列在 ≥96 列终端内不折行；更宽的画在该类终端会逐行折散。
 * 行数按内容宽高比动态计算（2 的倍数），保纵横比不拉伸。 */
const PIXEL_COLS = 44
/** median-cut 主色族色数（+ 6 锚色 = 15 色板）。 */
const N_BLUES = 9

/** 暗色终端显示提亮：median-cut 蓝族原色亮度偏低（身体 #1048be 亮度 ~69，
 * 深底终端上糊成暗团）。亮度 < LIFT_FLOOR 的非锚色按 LIFT_FACTOR 同比例
 * 提亮（通道 clamp 255）——保色相与相对渐变（暗部仍暗），锚色本已够亮不动。
 * 默认关闭（忠实原图；omts 管线亦不做提亮，其观感亮源于素材本身亮）；
 * 需要时 LIFT=1 开启。 */
const LIFT_FLOOR = 100
const LIFT_FACTOR = 1.45
const LIFT_ENABLED = process.env.LIFT === '1'

/** 必须保住的锚色（从原图采样；小面积但构图关键）。 */
const ANCHORS = [
  [254, 245, 209], // 星核心白炽
  [254, 240, 172], // 星金
  [200, 123, 213], // 星光晕粉/闪光
  [190, 197, 250], // 白肚（薰衣草白）
  [158, 57, 245], // 身体紫罗兰（顶部）
  [84, 167, 253], // 鳍/身体亮蓝（底部）
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

/** 字幕带切除：底部 40% 内找「长度 ≥16 且之后仍有密内容」的首个低密度
 * 行段（<2% 宽）——其起点即字幕上缘。取首个：字幕两行之间的间隙也满足
 * 条件，必须在上一个间隙下刀（底部页边空段无后续内容，天然排除）。 */
function captionCutY({ width, height, pixels }, bg) {
  const rowHas = (y) => {
    let n = 0
    for (let x = 0; x < width; x++) if (dist(pixels[y * width + x], bg) > 40) n++
    return n / width >= 0.02
  }
  let cur = -1
  for (let y = Math.floor(height * 0.6); y < height; y++) {
    if (rowHas(y)) {
      if (cur >= 0 && y - cur >= 16) {
        // 该低密度段已结束且够长；其后还有内容 → 切在这里
        return cur
      }
      cur = -1
    } else if (cur < 0) cur = y
  }
  return height
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

/** 裁剪 + 最近邻采样到原生像素网格（源图艺术像素 ≈7.5px，实测主结构
 * 游程 5–10；网格行数按内容宽高比取 4 的倍数，纵横比不拉伸。
 * 勿用 lanczos/面积平均——混色会把像素画糊成暗团，见 omts welcome-art-shared
 * projectCutoutToBands 全链 nearest 同款理由）。 */
async function project(path, bbox, pixelRows) {
  const { data } = await sharp(path)
    .removeAlpha()
    .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
    .resize(PIXEL_COLS, pixelRows, { kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = []
  for (let i = 0; i < data.length; i += 3) pixels.push([data[i], data[i + 1], data[i + 2]])
  return pixels
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
 * 被内容包围的暗像素（眼睛、身体暗紫阴影）到不了边缘 → 全部保住，
 * 不会像全局距离阈值那样把暗色身体误吃成洞。 */
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

/** 掩码最近邻投影到像素网格。注意：不用 sharp 缩 1 通道 raw 掩码——
 * libvips 对单通道 raw 大倍率 nearest 降采样有行错位怪癖（实测 931×704→56×42
 * 时实体区域隔行归零，同数据走 PNG 文件路径则正常）；JS 逐格采样几行搞定且确定。 */
function projectMask(mask, pixelRows) {
  const out = Buffer.alloc(PIXEL_COLS * pixelRows)
  for (let y = 0; y < pixelRows; y++) {
    const sy = Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / pixelRows))
    for (let x = 0; x < PIXEL_COLS; x++) {
      const sx = Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / PIXEL_COLS))
      out[y * PIXEL_COLS + x] = mask.data[sy * mask.width + sx]
    }
  }
  return out
}

const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`

// ── 主流程 ──────────────────────────────────────────────────
const src = await loadRgb(SOURCE)
const cornerBg = src.pixels[0]
const cutY = captionCutY(src, cornerBg)
console.log(`字幕带切除线 y = ${cutY}（原图 ${src.width}×${src.height}）`)
const above = { width: src.width, height: cutY, pixels: src.pixels.slice(0, cutY * src.width) }
const bbox = contentBbox(above)
console.log(`内容 bbox: ${bbox.width}×${bbox.height} @ (${bbox.left},${bbox.top})，背景 #${bbox.bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)

// 网格行数按内容宽高比（2 的倍数，half-block 2 像素/文本行）
const PIXEL_ROWS = Math.max(2, Math.round(PIXEL_COLS * (bbox.height / bbox.width) / 2) * 2)
console.log(`像素网格: ${PIXEL_COLS}×${PIXEL_ROWS}`)
const grid = await project(SOURCE, bbox, PIXEL_ROWS)
const maskGrid = projectMask(opaqueMask(above, bbox), PIXEL_ROWS)

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

// 1. 填内部小洞：透明格且 8 邻 ≥6 个内容格 → 取邻居众数色（采样裂缝/噪洞，
//    眼缘/腹部的小黑洞；孤立闪光点与喷水珠邻居少，不受影响）。
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

// 2. 眼睛高光：最深色最大连通簇（≥4 格 = 眼睛）的左上角补 1 格白
//   （44 列下原图眼白点会被采样吞掉，不补就是死鱼眼）。
{
  const DARKEST = 1 // 调色板 idx 1（median-cut 输出最暗槽位）
  const WHITE = paletteRaw.indexOf(ANCHORS[3]) + 1 // 锚色「白肚」的发射索引（1–F）
  const seen = new Set()
  let eyeCluster = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y][x] !== DARKEST || seen.has(`${x},${y}`)) continue
      const cluster = []
      const q = [[x, y]]
      seen.add(`${x},${y}`)
      while (q.length > 0) {
        const [cx, cy] = q.pop()
        cluster.push([cx, cy])
        for (const [nx, ny] of around(cx, cy)) {
          if (!seen.has(`${nx},${ny}`) && g[ny][nx] === DARKEST) {
            seen.add(`${nx},${ny}`)
            q.push([nx, ny])
          }
        }
      }
      if (cluster.length >= 4) {
        // 眼睛在鲸鱼头部（网格纵向下 2/3）；上 1/3 的暗簇是星光晕，排除
        const meanY = cluster.reduce((s, c) => s + c[1], 0) / cluster.length
        if (meanY > H / 3 && cluster.length > eyeCluster.length) eyeCluster = cluster
      }
    }
  }
  if (eyeCluster.length > 0) {
    eyeCluster.sort((a, b) => a[1] - b[1] || a[0] - b[0])
    const [ex, ey] = eyeCluster[0]
    g[ey][ex] = WHITE
    console.log(`眼高光补点 @ (${ex},${ey})，眼簇 ${eyeCluster.length} 格`)
  }
}

const outRows = g.map((r) => r.map((v) => v.toString(16)).join(''))

const banner = `/**
 * 生成物：scripts/generate-welcome-star.mjs 由 assets/welcome-star-source.png 产出，勿手改。
 *
 * star 欢迎页抱星鲸鱼索引像素资产：${PIXEL_COLS}×${PIXEL_ROWS} 像素网格（贴合原图内容
 * 宽高比），half-block 渲染 1×2 像素一格 → ${PIXEL_COLS}×${PIXEL_ROWS / 2} 文本格。索引为单 hex 位：
 * 0 = 透明，1–F = STAR_WHALE_FRAME_PALETTE 下标。调色板 15 色 =
 * median-cut 9 主色 + 锚定 6 关键色（星核/星金/光晕粉/白肚/身体紫/鳍蓝）。
 * 换图重跑：node scripts/generate-welcome-star.mjs
 */

/** 像素网格列数（half-block 渲染文本列 = 本值）。 */
export const STAR_WHALE_PIXEL_COLS = ${PIXEL_COLS}
/** 像素网格行数（half-block 渲染文本行 = 本值 / 2）。 */
export const STAR_WHALE_PIXEL_ROWS = ${PIXEL_ROWS}

/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
export const STAR_WHALE_FRAME_PALETTE: readonly (\`#\${string}\` | null)[] = [
  null,
${palette.map((c) => `  '${hex(c)}',`).join('\n')}
]

/** 索引像素行（${PIXEL_ROWS} 行 × ${PIXEL_COLS} 列，单 hex 位/像素，0 = 透明）。 */
export const STAR_WHALE_FRAME_ROWS: readonly string[] = [
${outRows.map((r) => `  '${r}',`).join('\n')}
]
`

await writeFile(OUTPUT, banner)
console.log(`已生成 ${OUTPUT}`)
