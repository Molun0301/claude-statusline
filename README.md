# Claude 多账户状态栏

显示模型、目录、Git（版本管理工具）分支、上下文占用、keepwarm 次数，以及当前会话实际使用账户的 5 小时 / 7 天额度。额度来自用户自己的 vm2api 网关，按会话请求记录与账户身份核对，归属不明时显示“待确认”。

支持 Linux 和 macOS 的命令型状态栏；需要 Python 3.10+、Node.js 18+。当前验证环境是 Linux、Node.js 24、Claude Code 2.1.316。账户展开点击依赖终端支持，可选 Tabby 适配器随仓库提供。

## 安装

```bash
git clone https://github.com/Molun0301/claude-statusline.git
cd claude-statusline
python3 scripts/install.py install
```

安装到 `~/.claude`，或通过 `--config-dir /path/to/claude-config` / `CLAUDE_CONFIG_DIR` 指定目录。安装器合并 `settings.json` 的 `statusLine` 字段，保留其他设置。已有其他状态栏时需检查后加 `--replace`，卸载可恢复原值。重新打开 Claude 会话生效。

清单附带 `account-statusline` 插件的 `setup` 安装指导技能；市场名为 `molun-statusline`。仅安装 Claude 技能不会自动配置状态栏，以上安装器才完成注册。[Claude 官方状态栏说明](https://code.claude.com/docs/en/statusline)说明了标准输入及命令输出协议。

## 账户额度配置

没有网关配置时，模型、目录、上下文仍可显示，账户额度为待确认。需要账户额度时：

1. 按 [额度配置示例](examples/额度配置示例.json) 创建 `~/.claude/local-statusline-quota-config.json`。
2. `base_url` 写你的网关地址，`vm_id` 写与 keepwarm 固定槽缓存对应的虚拟机标识，`credentials_file` 指向本机私密凭据文件的绝对路径。
3. 凭据格式参考 [示例](examples/凭据格式示例.json)，填写管理页面、用户名、密码。服务器别名和远端安装目录仅供 keepwarm 多账户唤醒使用，单纯显示额度不需要。
4. 两个私密配置文件设置仅本人可读权限：`chmod 600 文件路径`。

支持的 vm2api 接口：`POST /api/panel/login`、`GET /api/panel/vms`、`GET /api/panel/vms/:id`、`GET /api/panel/usage-logs`。面板必须返回本仓库 `src/vm2api-quota.js` 所处理的结构；不代表兼容所有同名网关。测试覆盖的响应样例见 `tests/双账户状态栏.test.cjs`。

状态栏从缓存立即返回，网络刷新在独立后台完成。约 30 秒刷新一次，超过 10 分钟的额度不显示。未知会话、账户换绑或查询失败不会借用其他账户额度。

金额为网关记录及估算，不能直接视为订阅账单。缓存和登录会话文件以 `0600` 权限写入 `~/.claude/cache`。

## 展开与 Tabby 点击

按会话手动切换展开：

```bash
node ~/.claude/statusline-accounts.js --handle-uri claude-quota://toggle/你的会话ID
```

Tabby 用户可安装可选组件：

```bash
python3 scripts/tabby.py install
```

默认写入 `~/.config/tabby/plugins/local/tabby-local-path-links`，其他系统用 `--tabby-config` 指定 Tabby 配置目录。重启 Tabby，并在启动 Claude 前设置 `FORCE_HYPERLINK=1`。若图形应用找不到 Node.js，设置 `CLAUDE_STATUSLINE_NODE` 为其绝对路径。该组件同时保留原有本地文件路径点击功能，远程终端不启用本机处理器。

## 更新、回退与卸载

```bash
git pull --ff-only
python3 scripts/install.py install
# 安装过 Tabby 组件的用户还需执行：
python3 scripts/tabby.py install

# 卸载：
python3 scripts/tabby.py uninstall
python3 scripts/install.py uninstall
```

更新保留凭据、额度配置和缓存。若自己改过插件文件，安装器会报告冲突；核对后用 `--replace`。卸载恢复仍由本插件持有的状态栏设置，保留用户后来修改的设置和文件。私密凭据与缓存可在确认其他插件不再使用后自行删除。

固定版本或回退：`git fetch origin --tags`，`git checkout v1.0.0`，再运行安装命令。

## 维护

`python3 scripts/check.py` 运行模拟网关、慢网络后台生命周期、终端点击与安装配置恢复测试，不连接个人网关。

版本 `1.0.0`，MIT 许可。[维护与发布](docs/公开文档/维护与发布.md) · [更新记录](docs/公开文档/更新记录.md)。
