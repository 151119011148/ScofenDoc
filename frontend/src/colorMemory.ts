/**
 * 文字颜色的「记忆」。
 *
 * 实际问题：一段话标成红色之后，紧接着的句子十有八九还想用红色，
 * 每次都要重新打开色板点一次，纯粹是重复劳动。
 *
 * 这里把「最近一次用过的颜色」存进 localStorage（跨文档、跨刷新都还在），
 * 由编辑器在「光标紧挨着同色文字」时自动续上；浮动工具条的色板也会把这一格
 * 标出来，一眼能看出当前延续的是哪个颜色。
 *
 * 只存颜色值，不按文档/用户区分：选色是个人书写习惯，跟着浏览器走更顺手。
 * 点「默认」或「清除格式」会把记忆清掉，避免整篇被上一次的颜色带走。
 */

const KEY = 'scofendoc:lastColor'

/** 读取记忆色；没有则返回空串（表示默认黑） */
export function getLastColor(): string {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    // 隐私模式下 localStorage 可能不可写，读失败当作没记忆
    return ''
  }
}

/** 写入/清空记忆色；传空串表示恢复默认 */
export function setLastColor(value: string): void {
  try {
    if (value) localStorage.setItem(KEY, value)
    else localStorage.removeItem(KEY)
  } catch {
    /* 写不进去就算了，功能降级为不记忆，不影响编辑 */
  }
}
