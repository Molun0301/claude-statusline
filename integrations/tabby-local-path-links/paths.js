'use strict'
// 从 xterm 缓冲区中找出实际存在的本地文件路径，交给 index.js 注册成可点击链接
const fs = require('fs/promises')
const os = require('os')
const path = require('path')

// 路径片段的分隔符：空白、引号、括号、管道符、中文标点、制表符号和 Claude Code 的列表/结果前缀
const TOKEN_RE = /[^\s"'`<>()[\]{}|;,，。；：、！？（）【】「」『』《》“”‘’…⎿●•─-▟]+/g
const TRAILING_PUNCT_RE = /[.:!?]+$/
// file.ts:42 或 file.ts:42:7 这类行号后缀
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/
const EXT_RE = /\.[\w-]{1,12}$/
// 一个逻辑行最多拼接的软换行行数
const MAX_ROWS = 20
const MAX_CANDIDATES = 64

// 读取 y 所在的逻辑行（含软换行），返回文本及每个 UTF-16 码元对应的单元格位置
function readLogicalLine (buffer, y) {
    let start = y
    while (start > 0 && y - start < MAX_ROWS && buffer.getLine(start)?.isWrapped) {
        start--
    }
    let text = ''
    const cells = []
    const cell = buffer.getNullCell()
    for (let row = start; row < start + MAX_ROWS; row++) {
        const line = buffer.getLine(row)
        if (!line || (row > start && !line.isWrapped)) {
            break
        }
        const nextWrapped = !!buffer.getLine(row + 1)?.isWrapped
        for (let col = 0; col < line.length; col++) {
            line.getCell(col, cell)
            const width = cell.getWidth()
            if (width === 0) {
                // 宽字符的后半格
                continue
            }
            let chars = cell.getChars()
            if (!chars) {
                // 宽字符放不下时软换行前留下的空格，拼接时去掉
                if (nextWrapped && col === line.length - 1) {
                    continue
                }
                chars = ' '
            }
            for (let i = 0; i < chars.length; i++) {
                cells.push({ row, col, width })
            }
            text += chars
        }
    }
    return { text, cells }
}

function looksLikePath (p) {
    if (p.length < 2 || p.includes('://')) {
        return false
    }
    return p.includes('/') || EXT_RE.test(p)
}

function resolvePath (p, cwd) {
    if (p.startsWith('~/')) {
        return path.join(os.homedir(), p.slice(2))
    }
    if (path.isAbsolute(p)) {
        return p
    }
    return cwd ? path.resolve(cwd, p) : null
}

async function exists (p) {
    try {
        await fs.stat(p)
        return true
    } catch {
        return false
    }
}

// y 为 0 起始的缓冲区行号；cwd 用于解析相对路径，为空时只识别绝对路径和 ~/ 路径
async function findPathLinks (buffer, y, cwd) {
    const { text, cells } = readLogicalLine(buffer, y)
    const candidates = []
    for (const m of text.matchAll(TOKEN_RE)) {
        const token = m[0].replace(TRAILING_PUNCT_RE, '')
        const p = token.replace(LINE_SUFFIX_RE, '').replace(TRAILING_PUNCT_RE, '')
        if (!looksLikePath(p)) {
            continue
        }
        const target = resolvePath(p, cwd)
        if (target) {
            candidates.push({ index: m.index, token, target })
        }
        if (candidates.length >= MAX_CANDIDATES) {
            break
        }
    }
    const found = await Promise.all(candidates.map(c => exists(c.target)))
    return candidates.filter((_, i) => found[i]).map(({ index, token, target }) => {
        const first = cells[index]
        const last = cells[index + token.length - 1]
        return {
            // xterm 链接坐标从 1 开始，end 为包含在内的最后一格
            range: {
                start: { x: first.col + 1, y: first.row + 1 },
                end: { x: last.col + last.width, y: last.row + 1 },
            },
            text: token,
            target,
        }
    })
}

module.exports = { findPathLinks }
