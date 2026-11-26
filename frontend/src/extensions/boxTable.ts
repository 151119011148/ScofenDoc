// 每对横线之间是一行。忽略框线的字符宽度，中文和半角字符混排时仍能读到完整单元格。
const topBorder = /^[┌┏╔]([─━═]+(?:[┬┳╦][─━═]+)*)[┐┓╗]$/
const rowBorder = /^[├┣╠]([─━═]+(?:[┼╋╬][─━═]+)*)[┤┫╣]$/
const bottomBorder = /^[└┗╚]([─━═]+(?:[┴┻╩][─━═]+)*)[┘┛╝]$/
const vertical = /^[│┃║]$/

export function parseBoxTable(source: string): string[][][] | null {
  const text = source.trim()
  if (!/^[┌┏╔]/.test(text)) return null
  const lines = text.split(/\r?\n/).map(line => line.trim())
  const top = topBorder.exec(lines[0])
  const bottom = bottomBorder.exec(lines[lines.length - 1])
  if (!top || !bottom || lines.length < 3) return null

  const countColumns = (border: string) => border.split(/[^─━═]/).length
  const columns = countColumns(top[1])
  if (countColumns(bottom[1]) !== columns) return null

  const rows: string[][][] = []
  let row: string[][] = Array.from({ length: columns }, () => [])
  for (const line of lines.slice(1, -1)) {
    const separator = rowBorder.exec(line)
    if (separator) {
      if (countColumns(separator[1]) !== columns || row[0].length === 0) return null
      rows.push(row)
      row = Array.from({ length: columns }, () => [])
      continue
    }

    if (!vertical.test(line[0]) || !vertical.test(line[line.length - 1])) return null
    const body = line.slice(1, -1)
    // 单列表格的文字也可能包含竖线。外框已确定只有一列，保留内部字符。
    const cells = columns === 1 ? [body] : body.split(/[│┃║]/)
    if (cells.length !== columns) return null
    cells.forEach((cell, index) => row[index].push(cell.trim()))
  }
  if (row[0].length === 0) return null
  rows.push(row)
  return rows
}
