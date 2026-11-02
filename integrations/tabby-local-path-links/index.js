'use strict'
// 让本地终端输出里的文件路径可点击（支持中文、~/、绝对路径和相对当前目录的路径），点击后用系统默认程序打开。
// Tabby 自带的 tabby-linkifier 只认 ASCII 绝对路径，且其 web-links 组件会用 new URL() 过滤掉所有本地路径
const { Injectable, NgModule } = require('@angular/core')
const { ConfigService, PlatformService } = require('tabby-core')
const { TerminalDecorator, XTermFrontend } = require('tabby-terminal')
const { findPathLinks } = require('./paths')
const { quotaLinkHandler } = require('./claude-quota')

class LocalPathLinkDecorator extends TerminalDecorator {
    constructor (config, platform) {
        super()
        this.config = config
        this.platform = platform
        this.providers = new WeakMap()
        this.quotaHandlers = new WeakMap()
    }

    attach (tab) {
        // SSH 等远程会话里的路径不在本机，只处理本地终端
        if (!(tab.frontend instanceof XTermFrontend) || tab.profile?.type !== 'local') {
            return
        }
        const xterm = tab.frontend.xterm
        const registration = {}
        this.quotaHandlers.set(tab, registration)
        // 等本轮所有装饰器挂载完再包装，避免内置链接插件按加载顺序覆盖处理器。
        queueMicrotask(() => {
            if (this.quotaHandlers.get(tab) !== registration) {
                return
            }
            registration.original = xterm.options.linkHandler
            registration.handler = quotaLinkHandler(registration.original)
            xterm.options.linkHandler = registration.handler
        })
        const provider = tab.frontend.xterm.registerLinkProvider({
            provideLinks: (lineNumber, callback) => {
                this.provideLinks(tab, lineNumber - 1).then(callback, error => {
                    console.error('tabby-local-path-links:', error)
                    callback(undefined)
                })
            },
        })
        this.providers.set(tab, provider)
    }

    detach (tab) {
        this.providers.get(tab)?.dispose()
        this.providers.delete(tab)
        const quota = this.quotaHandlers.get(tab)
        if (quota && tab.frontend.xterm.options.linkHandler === quota.handler) {
            tab.frontend.xterm.options.linkHandler = quota.original
        }
        this.quotaHandlers.delete(tab)
        super.detach(tab)
    }

    async provideLinks (tab, y) {
        const cwd = await tab.session?.getWorkingDirectory().catch(() => null)
        const links = await findPathLinks(tab.frontend.xterm.buffer.active, y, cwd)
        if (!links.length) {
            return undefined
        }
        return links.map(({ range, text, target }) => ({
            range,
            text,
            activate: event => {
                // 沿用 Tabby 设置里“点击链接需按住的修饰键”
                const modifier = this.config.store.clickableLinks?.modifier
                if (modifier && !event[modifier]) {
                    return
                }
                this.platform.openPath(target)
            },
        }))
    }
}
LocalPathLinkDecorator.ctorParameters = () => [
    { type: ConfigService },
    { type: PlatformService },
]
Injectable()(LocalPathLinkDecorator)

class LocalPathLinksModule { }
NgModule({
    providers: [
        { provide: TerminalDecorator, useClass: LocalPathLinkDecorator, multi: true },
    ],
})(LocalPathLinksModule)

exports.default = LocalPathLinksModule
