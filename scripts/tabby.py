#!/usr/bin/env python3
"""安装或卸载可选 Tabby 本地点击适配器。"""
import argparse
import os
from pathlib import Path
from lifecycle import Installation
ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('action', choices=['install', 'uninstall'])
p.add_argument('--tabby-config', type=Path, default=Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'tabby')
p.add_argument('--replace', action='store_true')
a = p.parse_args()
try:
    install = Installation(a.tabby_config / 'plugins/local', 'claude-statusline-tabby', '1.1.0')
    if a.action == 'uninstall':
        install.uninstall()
    else:
        source = ROOT / 'integrations'
        install.install({str(f.relative_to(source)): f.read_bytes() for f in (source / 'tabby-local-path-links').iterdir() if f.is_file()}, a.replace)
    print('操作完成；请重启 Tabby 加载。终端启动前设置 FORCE_HYPERLINK=1 可启用状态栏超链接。')
except (ValueError, OSError) as exc:
    p.exit(1, str(exc) + '\n')
