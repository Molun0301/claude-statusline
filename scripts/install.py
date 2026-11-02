#!/usr/bin/env python3
"""管理状态栏文件，并合并、恢复 statusLine 设置。"""
import argparse
import os
import shlex
import shutil
from pathlib import Path
from lifecycle import Installation, read_json
ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('action', choices=['install', 'uninstall'])
p.add_argument('--config-dir', type=Path, default=Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude')))
p.add_argument('--replace', action='store_true', help='替换已有文件/状态栏，记录原值供卸载恢复')
a = p.parse_args()
try:
    directory = a.config_dir.expanduser().absolute()
    install = Installation(directory, 'claude-statusline', '1.0.0')
    settings = directory / 'settings.json'
    if a.action == 'uninstall':
        install.uninstall(settings)
    else:
        node = shutil.which('node')
        if not node:
            raise ValueError('需要先安装 Node.js 18 或更新版本')
        value = {'type': 'command', 'command': 'CLAUDE_CONFIG_DIR=' + shlex.quote(str(directory)) + ' ' + shlex.quote(node) + ' ' + shlex.quote(str(directory / 'local-statusline.js')), 'refreshInterval': 2}
        current = read_json(settings)
        old = install.state['settings'].get('statusLine')
        if current.get('statusLine') not in (None, value) and not a.replace and (not old or current['statusLine'] != old['installed']):
            raise ValueError('已有其他状态栏；确认替换时加 --replace，卸载会恢复原设置')
        files = {f.name: f.read_bytes() for f in (ROOT / 'src').glob('*.js')}
        install.install(files, a.replace)
        install.set_field(settings, 'statusLine', value, a.replace)
    print(f'{a.action} 完成：{directory}；重新打开 Claude 会话后生效')
except (ValueError, OSError) as exc:
    p.exit(1, str(exc) + '\n')
