from pathlib import Path
import argparse
import subprocess
import zipfile
import sys
import os

sys.stdout.reconfigure(encoding='utf-8',errors='replace')
sys.stderr.reconfigure(encoding='utf-8',errors='replace')
os.environ['JAVA_TOOL_OPTIONS']='-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8'

parser=argparse.ArgumentParser()
parser.add_argument('--tools',required=True,type=Path)
parser.add_argument('--project',type=Path,help='Alternative Android project, used by the test sharing host')
parser.add_argument('--apk-name',default='companion-capture-0.2.0.apk')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
project=args.project.resolve() if args.project else root/'android'
toolroot=args.tools.resolve()
javac=next((toolroot/'jdk').rglob('javac.exe'))
java=javac.with_name('java.exe')
jar=javac.with_name('jar.exe')
keytool=javac.with_name('keytool.exe')
android=next((toolroot/'platform').rglob('android.jar'))
aapt=next((toolroot/'build-tools').rglob('aapt2.exe'))
tools=aapt.parent
d8=tools/'lib'/'d8.jar'
apksigner=tools/'lib'/'apksigner.jar'
build=project/'build'
dist=root/'dist'
for part in [build,dist,build/'gen',build/'classes',build/'dex']:part.mkdir(parents=True,exist_ok=True)

def run(*argv):
    result=subprocess.run([str(x) for x in argv],cwd=root,capture_output=True,text=True,encoding='utf-8',errors='replace')
    if result.stdout.strip():print(result.stdout.strip())
    if result.stderr.strip():print(result.stderr.strip())
    if result.returncode:raise subprocess.CalledProcessError(result.returncode,[str(x) for x in argv],result.stdout,result.stderr)

run(aapt,'compile','--dir',project/'res','-o',build/'resources.zip')
run(aapt,'link','-I',android,'--manifest',project/'AndroidManifest.xml','--java',build/'gen','--min-sdk-version','26','--target-sdk-version','35','--auto-add-overlay','-o',build/'base.apk',build/'resources.zip')
sources=list((project/'src').rglob('*.java'))+list((build/'gen').rglob('*.java'))
run(javac,'-encoding','UTF-8','-source','8','-target','8','-classpath',android,'-d',build/'classes',*sources)
run(jar,'cf',build/'classes.jar','-C',build/'classes','.')
run(java,'-cp',d8,'com.android.tools.r8.D8','--lib',android,'--min-api','26','--output',build/'dex',build/'classes.jar')
unsigned=build/'unsigned.apk'
with zipfile.ZipFile(build/'base.apk') as original,zipfile.ZipFile(unsigned,'w',zipfile.ZIP_DEFLATED) as output:
    for item in original.infolist():output.writestr(item,original.read(item.filename))
    for dex in (build/'dex').glob('*.dex'):output.write(dex,dex.name)
run(tools/'zipalign.exe','-f','-p','4',unsigned,build/'aligned.apk')
keystore=toolroot/'companion-development.jks'
if not keystore.exists():run(keytool,'-genkeypair','-keystore',keystore,'-storepass','android','-keypass','android','-alias','companion-development','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Companion MVP Development, O=Companion')
run(java,'-jar',apksigner,'sign','--ks',keystore,'--ks-key-alias','companion-development','--ks-pass','pass:android','--key-pass','pass:android','--out',dist/args.apk_name,build/'aligned.apk')
run(java,'-jar',apksigner,'verify','--verbose',dist/args.apk_name)
run(aapt,'dump','badging',dist/args.apk_name)
print('APK ready:',dist/args.apk_name)
