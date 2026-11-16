import json, pathlib, sqlite3, sys
from contextlib import closing
root=pathlib.Path(sys.argv[1]).resolve()
databases=0;jsonl_files=0;records=0
for file in root.rglob('*'):
    if not file.is_file() or file.is_symlink():continue
    with file.open('rb') as input:header=input.read(16)
    if header==b'SQLite format 3\x00':
        with closing(sqlite3.connect(file.as_uri()+'?mode=ro',uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Restored database failed integrity check')
        databases+=1
    if file.suffix=='.jsonl':
        with file.open('r',encoding='utf-8-sig') as input:
            for line in input:
                if line.strip():json.loads(line);records+=1
        jsonl_files+=1
report={'restoredRoot':str(root),'sqliteIntegrityPassed':databases,'jsonlFilesParsed':jsonl_files,'jsonlRecordsParsed':records,'status':'passed'}
(root/'content-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report))
