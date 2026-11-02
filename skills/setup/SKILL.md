---
name: setup
description: 安装、更新或卸载 Claude 状态栏，配置可选的 vm2api 账户额度。
---

阅读本插件 README.md，按用户所需操作执行插件根目录 `scripts/install.py`。安装需要 Python 3.10+ 和 Node.js 18+。仅安装此技能不会自动改写状态栏。
配置凭据时只让用户填写本机私密文件，不将真实值写进项目、报告或提交。修改现有设置前读取现状，保留无关字段；发现已有其他状态栏时说明替换效果，使用 --replace。卸载使用 uninstall 子命令。
