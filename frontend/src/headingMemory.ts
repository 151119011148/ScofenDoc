/**
 * 标题级别的「记忆」。
 *
 * 实际问题：把一段设成二级标题后，紧接着下面几段十有八九也是二级标题，
 * 每次都要重新点开「标题」面板再挑一次，纯粹是重复劳动。
 *
 * 和 colorMemory 同一套思路：把「最近一次用过的标题级别」存进 localStorage
 * （跨文档、跨刷新都在），浮动工具条的标题按钮主键直接套用，点 ▾ 才展开面板
 * 换级别 —— 选一次级别，后面每次只是「刷一下」，少一次展开 + 选择。
 *
 * 取值约定：
 *   1–6  上次用的是第 N 级标题
 *   0    上次用「正文」（用户想把选区变回普通段落，同样值得记住）
 *   null 从没设过：主键退化成直接打开面板，避免点一下毫无反应
 */

const KEY = 'scofendoc:lastHeading'

/** 读取记忆级别；null 表示还没有记忆（首次使用） */
export function getLastHeading(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null || raw === '') return null
    const level = Number(raw)
    if (!Number.isInteger(level) || level < 0 || level > 6) return null
    return level
  } catch {
    // 隐私模式下 localStorage 可能不可读，降级为不记忆
    return null
  }
}

/** 写入记忆级别；0 表示正文 */
export function setLastHeading(level: number): void {
  try {
    localStorage.setItem(KEY, String(Math.max(0, Math.min(6, Math.trunc(level)))))
  } catch {
    /* 写不进去就算了，功能降级为不记忆，不影响编辑 */
  }
}

/** 级别 → 展示用名称：0 是「正文」，其余是「二级标题」这种中文名 */
export function headingName(level: number): string {
  if (level === 0) return '正文'
  return ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'][level - 1] ?? `${level} 级标题`
}

/** 级别 → 工具条上的短标签：T / H1–H6 */
export function headingShort(level: number): string {
  return level === 0 ? 'T' : `H${level}`
}
