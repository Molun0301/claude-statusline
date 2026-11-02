'use strict'
const { spawn } = require('node:child_process')

const URI_PATTERN = /^claude-quota:\/\/toggle\/[a-zA-Z0-9_-]{1,128}$/
const path = require('node:path')
const os = require('node:os')
const NODE = process.env.CLAUDE_STATUSLINE_NODE || 'node'
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const SCRIPT = path.join(CONFIG, 'statusline-accounts.js')

// 只处理状态栏自己生成的本机会话链接，参数直接传给进程，不经过 shell。
function quotaLinkHandler (original, launch = spawn) {
    return {
        ...original,
        allowNonHttpProtocols: true,
        activate (event, uri, ...args) {
            if (typeof uri === 'string' && URI_PATTERN.test(uri)) {
                if (event.button != null && event.button !== 0) {
                    return
                }
                event.preventDefault?.()
                event.stopPropagation?.()
                const child = launch(NODE, [SCRIPT, '--handle-uri', uri], {
                    detached: true,
                    stdio: 'ignore',
                    // 与状态栏共享配置目录，可通过环境变量显式指定。
                    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
                })
                child.once('error', () => {})
                child.unref()
                return
            }
            // 开启非 HTTP 识别后仍限制转交范围，不能借此开放任意自定义协议。
            let url
            try { url = new URL(uri) } catch (_) { return }
            if (!['http:', 'https:'].includes(url.protocol)) {
                return
            }
            return original?.activate?.(event, uri, ...args)
        },
    }
}

module.exports = { quotaLinkHandler }
