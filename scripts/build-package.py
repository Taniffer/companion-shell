# -*- coding: utf-8 -*-
from pathlib import Path
import zipfile
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
out = root.parent
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
android_version=re.search(r'android:versionName="([^"]+)"',(root/'android/AndroidManifest.xml').read_text(encoding='utf-8')).group(1)
apk_name=f'companion-capture-{android_version}.apk'
directories = {'.github', 'src', 'web', 'scripts', 'test', 'docs', 'android', 'vendor', 'bridge-kit'}
leaves = {'.gitattributes', 'playwright.config.mjs', 'package.json', 'package-lock.json', '.gitignore', 'README.md', 'LICENSE', 'NOTICE.md', '安装伴随.cmd', '启动伴随.cmd', '诊断伴随.cmd', '恢复原桥接.cmd'}
forbidden = {'data', 'logs', '.runtime', 'build', '__pycache__', '.git'}
def include(path, dependencies=False):
    parts = path.relative_to(root).parts
    if 'node_modules' in parts:
        return dependencies and (parts[0] == 'node_modules' or parts[:2] == ('bridge-kit','node_modules'))
    if any(part in forbidden for part in parts): return False
    if any(part == 'runtime' for part in parts) and not (dependencies and parts[:2] == ('bridge-kit','runtime')): return False
    if path.name.endswith(('.local.json', '.jks', '.keystore', '.dpapi', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.pyc')): return False
    if parts[0] == 'dist': return path.name == apk_name
    return parts[0] in directories or path.name in leaves and len(parts) == 1 or dependencies and parts[0] == 'node_modules'

results=[]
for needed in ['node_modules/@larksuiteoapi/node-sdk/package.json','node_modules/qrcode/package.json','node_modules/selfsigned/package.json','bridge-kit/node_modules/@larksuiteoapi/node-sdk/package.json','bridge-kit/runtime/node.exe','bridge-kit/runtime/LICENSE']:
    if not (root/needed).is_file(): raise RuntimeError('Windows release needs its installed dependencies and Node runtime: '+needed)
for name,deps in [(f'companion-mvp-{version}-source.zip',False),(f'companion-mvp-{version}-windows.zip',True)]:
    target=out/name
    files=[p for p in root.rglob('*') if p.is_file() and include(p,deps)]
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for path in files:
            if not path.resolve().is_relative_to(root.resolve()): raise ValueError('A package file escapes its root')
            z.write(path,'companion-mvp/'+path.relative_to(root).as_posix())
    with zipfile.ZipFile(target) as z:
        if z.testzip(): raise ValueError('Archive validation failed')
        for member in z.namelist():
            if any(x in member for x in ['config.local.json','admin.key','app-secret.dpapi','companion.sqlite','bridge.sqlite','.jks']): raise ValueError('Private file in archive')
    results.append({'file':name,'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'files':len(files)})
apk=root/'dist'/apk_name
results.append({'file':'companion-mvp/dist/'+apk.name,'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()})
(out/f'companion-mvp-{version}-sha256.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
