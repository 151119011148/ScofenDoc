/**
 * 界面操作撤销栈（文档树的移动 / 重命名 / 删除）。
 *
 * 正文编辑器的撤销不在这里 —— 那是 Yjs UndoManager 的事（按文档、跨端一致）。
 * 这里只兜住「元数据类」操作：拖拽改层级、改标题、删除文档，这些都是调后端接口，
 * 不进 CRDT 历史，所以必须自己记一份逆操作。
 *
 * 每条记录同时带 undo 和 redo，撤销后再按一次 Ctrl+Shift+Z 就能重做。
 * 栈深限制 50 条：足够覆盖手滑，又不会把内存拖起来。
 */
import { reactive } from 'vue'

export interface UndoEntry {
  /** 用于提示，例如「移动 3 篇文档」 */
  label: string
  undo: () => Promise<void> | void
  redo: () => Promise<void> | void
}

const MAX_DEPTH = 50

export const undoState = reactive({
  past: [] as UndoEntry[],
  future: [] as UndoEntry[],
  /** 撤销/重做执行中，避免连按造成的并发错乱 */
  busy: false,
})

export function pushUndo(entry: UndoEntry) {
  undoState.past.push(entry)
  if (undoState.past.length > MAX_DEPTH) undoState.past.shift()
  // 产生新操作后，原来的「重做」分支就作废了
  undoState.future.length = 0
}

export function clearUndo() {
  undoState.past.length = 0
  undoState.future.length = 0
}

/** 能否撤销 / 重做（供 UI 置灰用） */
export const canUndo = () => undoState.past.length > 0
export const canRedo = () => undoState.future.length > 0

/** 栈顶那条操作的描述，没有则空串 */
export function undoLabel(): string {
  return undoState.past[undoState.past.length - 1]?.label ?? ''
}

export function redoLabel(): string {
  return undoState.future[undoState.future.length - 1]?.label ?? ''
}

/** 执行一步撤销，返回被撤销操作的描述（无操作可撤时返回 null） */
export async function undoOnce(): Promise<string | null> {
  const entry = undoState.past.pop()
  if (!entry) return null
  undoState.busy = true
  try {
    await entry.undo()
    undoState.future.push(entry)
    return entry.label
  } finally {
    undoState.busy = false
  }
}

/** 执行一步重做 */
export async function redoOnce(): Promise<string | null> {
  const entry = undoState.future.pop()
  if (!entry) return null
  undoState.busy = true
  try {
    await entry.redo()
    undoState.past.push(entry)
    return entry.label
  } finally {
    undoState.busy = false
  }
}
