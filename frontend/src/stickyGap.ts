/**
 * 正文滚动时顶部被「已连接协同」格式栏占住的高度 + 呼吸留白。
 *
 * 大纲跳转、站内锚点（?h=）都是自己算 scrollTop，不能只用 scrollIntoView：
 * .collab .bar 是 .main 里的 position:sticky，滚动后始终压在正文最上面，
 * 若落点只留 12px，标题第一行会被工具栏盖住。
 *
 * 工具栏高度不能写死：宽屏一行约 45px，窗口窄时 flex-wrap 会换成两行约 76px，
 * 只读态又只剩一行文字。所以每次滚动前实测一次 .bar 的实际高度。
 * 取值 = max(CSS 里的 --jump-gap 兜底值, 实测栏高 + 12px 呼吸位)。
 * 手机端 --jump-gap 是 64px（含工具栏），取 max 后仍保持原来的 64px。
 */
export function stickyTopGap(scroller: HTMLElement | null | undefined): number {
  if (!scroller) return 12
  const bar = scroller.querySelector('.collab .bar') as HTMLElement | null
  const barH = bar ? bar.getBoundingClientRect().height : 0
  const v = parseFloat(getComputedStyle(scroller).getPropertyValue('--jump-gap'))
  const fallback = Number.isFinite(v) ? v : 12
  return Math.max(fallback, barH + 12)
}
