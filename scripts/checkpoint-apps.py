"""Read-only application checkpoints. SQLite uses its backup API, never a live-file copy."""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, pathlib, shutil, sqlite3, stat as stat_module, tempfile, time, uuid
from contextlib import closing

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT/'recovery.config.json').read_text(encoding='utf-8'))
VAULT = pathlib.Path(CONFIG['vaultRoot'])
HOME = pathlib.Path.home()
def atomic_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
    with temp.open('x', encoding='utf-8') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.flush(); os.fsync(output.fileno())
    os.replace(temp,file)
def sha(file):
    digest=hashlib.sha256()
    with file.open('rb') as input:
        for chunk in iter(lambda:input.read(1024*1024),b''): digest.update(chunk)
    return digest.hexdigest()
def capture_file(file):
    with file.open('rb') as input: sqlite=input.read(16)==b'SQLite format 3\x00'
    temp=VAULT/'objects'/(uuid.uuid4().hex+'.tmp')
    if sqlite:
        deadline=time.monotonic()+30
        def progress(*_):
            if time.monotonic()>deadline: raise TimeoutError('SQLite backup deadline exceeded')
        with closing(sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=3)) as source,closing(sqlite3.connect(temp)) as destination:
            source.backup(destination,pages=512,progress=progress,sleep=.02)
            if destination.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('SQLite snapshot failed quick_check')
    else:
        for attempt in range(3):
            before=file.stat(); shutil.copyfile(file,temp); after=file.stat()
            if (before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns): break
        else: raise RuntimeError('File kept changing during checkpoint')
    with temp.open('r+b') as output: output.flush();os.fsync(output.fileno())
    digest=sha(temp); stored=VAULT/'objects'/digest
    if stored.exists():
        if sha(stored)!=digest: raise RuntimeError('Existing backup object is corrupt')
        # This temp is our own duplicate copy, never user data.
        temp.unlink()
    else: os.replace(temp,stored)
    return digest,sqlite
def checkpoint(original, include=None, exclude=()):
    if not original.exists():return None
    now=datetime.datetime.now(datetime.timezone.utc)
    id=now.isoformat(timespec='milliseconds').replace(':','-').replace('.','-').replace('+00-00','Z')+'-'+uuid.uuid4().hex[:8]
    manifest={'version':1,'id':id,'kind':'application-checkpoint','owner':'application-backup','original':str(original),'at':now.isoformat(),'status':'preparing','entries':[],'bytes':0,'skipped':[],'sqliteSnapshots':0}
    target=VAULT/'entries'/id/'manifest.json';atomic_json(target,manifest)
    def visit(file,relative):
        if file.is_symlink() or (getattr(file.lstat(),'st_file_attributes',0) & stat_module.FILE_ATTRIBUTE_REPARSE_POINT):
            manifest['skipped'].append({'path':str(relative),'reason':'link-not-followed'});return
        if file.name in exclude or file.name in {'LOCK','lockfile','DawnGraphiteCache','DawnWebGPUCache','GPUCache','ShaderCache','GrShaderCache','Code Cache','blob_storage','Crashpad'} or file.name.endswith(('-wal','-shm','.lock','.guard')):return
        stat=file.stat()
        if file.is_dir():
            manifest['entries'].append({'relative':str(relative) if str(relative)!='.' else '', 'type':'directory','mode':stat.st_mode,'mtimeMs':stat.st_mtime*1000,'size':0})
            for child in sorted(file.iterdir()):visit(child,relative/child.name)
        else:
            hash,is_sqlite=capture_file(file)
            manifest['entries'].append({'relative':str(relative),'type':'file','size':(VAULT/'objects'/hash).stat().st_size,'mtimeMs':stat.st_mtime*1000,'mode':stat.st_mode,'hash':hash,**({'sqliteBackup':True} if is_sqlite else {})})
            manifest['bytes']+=stat.st_size;manifest['sqliteSnapshots']+=int(is_sqlite)
    try:
        manifest['entries'].append({'relative':'','type':'directory','mode':original.stat().st_mode,'mtimeMs':original.stat().st_mtime*1000,'size':0})
        for child in sorted(original.iterdir()):
            if include is None or child.name in include:visit(child,pathlib.Path(child.name))
        manifest['status']='ready';atomic_json(target,manifest)
        return {k:manifest[k] for k in ['id','original','status','bytes','sqliteSnapshots']}|{'files':len(manifest['entries']),'skipped':len(manifest['skipped'])}
    except Exception as error:
        manifest['status']='failed';manifest['error']=str(error);atomic_json(target,manifest);raise
def main():
    for name in ['objects','entries','state']:(VAULT/name).mkdir(parents=True,exist_ok=True)
    codex=HOME/'.codex'
    codex_names={p.name for p in codex.iterdir() if p.is_file()}|{'sessions','archived_sessions','sqlite','skills','rules'}
    jobs=[
        (codex,codex_names,()),
        (HOME/'.dsh',None,('node_modules','attachments')),
        (HOME/'.cockpit_tools',None,()),
        (HOME/'.antigravity_cockpit',None,('logs','cache','Cache','temp','tmp')),
        (HOME/'.config/magpie',None,('logs','cache','Cache')),
        # This directory contains only a running WebView profile. The actual
        # backend/account store is captured under .config/magpie and the other
        # Magpie app directory; locked browser storage is deliberately excluded.
        (HOME/'AppData/Roaming/magpie.exe',None,('EBWebView','logs','cache','Cache')),
        (HOME/'AppData/Roaming/magpie-windows-amd64.exe',None,('logs','cache','Cache')),
    ]
    results=[];errors=[]
    for source,include,exclude in jobs:
        try:
            info=checkpoint(source,include,exclude)
            if info:results.append(info);print(json.dumps(info),flush=True)
        except Exception as error:
            errors.append({'source':str(source),'error':str(error)});print(json.dumps({'source':str(source),'error':str(error)}),flush=True)
    summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results,'errors':errors}
    atomic_json(VAULT/'state'/'application-checkpoint-latest.json',summary)
    if errors:raise SystemExit(1)
if __name__=='__main__':main()
