import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import { Vault, digest } from '../lib/vault.js';
import {ProjectRecovery,catalogEntries} from '../lib/projects.js';
import { assess, assertMutable, parsePatchTargets, simpleDeletion, shellAssessment, DELETION_MARKER, SOURCE_ROOT,hasDestructiveCommand } from '../lib/policy.js';

const base=path.resolve('D:/dsh-recovery-tests');
await fs.mkdir(base,{recursive:true});
async function fixture(options={}) {
  const root=await fs.mkdtemp(path.join(base,'unit-'));
  const workspace=path.join(root,'workspace'); await fs.mkdir(workspace);
  const config={vaultRoot:path.join(root,'dsh-recovery-vault'),...options};
  return {root,workspace,config,vault:new Vault(config)};
}
async function put(file,text='original') { await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,text); return file; }
const context=(workspace,name,args)=>({name,arguments:args,agent:{id:'test-agent',session:{header:{cwd:workspace,id:'test-session'}}}});

test('file quarantine and byte-for-byte restoration without overwriting existing files',async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'old file.txt'),'原始内容\n'); const hash=await digest(file);
  const [entry]=await f.vault.remove([file],{workspace:f.workspace,owner:'file'});
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  assert.equal(entry.status,'quarantined');
  await f.vault.restore(entry.id); assert.equal(await digest(file),hash);
  await assert.rejects(f.vault.restore(entry.id),/never overwrites/);
});
test('recursive directories, empty directories and unicode names are recoverable',async()=>{
  const f=await fixture(); const dir=path.join(f.workspace,'旧目录'); await put(path.join(dir,'子目录','文本.txt'),'hello'); await fs.mkdir(path.join(dir,'empty'));
  const [entry]=await f.vault.remove([dir],{workspace:f.workspace,owner:'tree'});
  const restored=path.join(f.root,'restored-tree'); await f.vault.restore(entry.id,{destination:restored});
  assert.equal(await fs.readFile(path.join(restored,'子目录','文本.txt'),'utf8'),'hello'); assert((await fs.stat(path.join(restored,'empty'))).isDirectory());
});
test('all batch targets are validated before any original moves',async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'keep.txt'));
  await assert.rejects(f.vault.remove([file,path.join(f.workspace,'missing')],{workspace:f.workspace,owner:'batch'}),/does not exist/);
  assert.equal(await fs.readFile(file,'utf8'),'original');
});
test('corrupt recovery objects fail closed and leave the restore target absent',async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'corrupt.txt')); const [entry]=await f.vault.remove([file],{workspace:f.workspace,owner:'corruption'});
  const manifest=JSON.parse(await fs.readFile(path.join(f.vault.root,'entries',entry.id,'manifest.json')));
  await fs.writeFile(path.join(f.vault.root,'objects',manifest.entries[0].hash),'corruption');
  await assert.rejects(f.vault.restore(entry.id),/integrity/); await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('snapshot failure or configured size limit retains originals',async()=>{
  const f=await fixture({maxBytes:2}); const file=await put(path.join(f.workspace,'large.txt'),'too large');
  await assert.rejects(f.vault.remove([file],{workspace:f.workspace,owner:'limit'}),/size limit/); assert.equal(await fs.readFile(file,'utf8'),'too large');
});
test('source mutation during backup cancels deletion',async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'changing.txt')); const original=f.vault.objectFor.bind(f.vault);
  f.vault.objectFor=async(...args)=>{ const hash=await original(...args); await fs.writeFile(file,'new content'); return hash; };
  await assert.rejects(f.vault.remove([file],{workspace:f.workspace,owner:'race'}),/changed/); assert.equal(await fs.readFile(file,'utf8'),'new content');
});
test('deletion budgets survive recreation of the plugin and count descendants',async()=>{
  const f=await fixture({maxDeletedFilesPerSession:1}); const first=await put(path.join(f.workspace,'first')); const second=await put(path.join(f.workspace,'second'));
  await f.vault.remove([first],{workspace:f.workspace,owner:'same-owner'});
  await assert.rejects(new Vault(f.config).remove([second],{workspace:f.workspace,owner:'same-owner'}),/budget/); assert.equal(await fs.readFile(second,'utf8'),'original');
});
test('linked paths do not inherit deletion authority',async()=>{
  const f=await fixture(); const actual=path.join(f.root,'important'); await put(path.join(actual,'keep'));
  const alias=path.join(f.workspace,'alias'); await fs.symlink(actual,alias,'junction');
  await assert.rejects(f.vault.remove([alias],{workspace:f.workspace,owner:'link'}),/Linked/); assert.equal(await fs.readFile(path.join(actual,'keep'),'utf8'),'original');
});
test('backup contents are independent of source hard links',async()=>{
  const f=await fixture(); const first=await put(path.join(f.workspace,'original')); const alias=path.join(f.root,'hardlink'); await fs.link(first,alias);
  const [entry]=await f.vault.remove([first],{workspace:f.workspace,owner:'hardlink'}); await fs.writeFile(alias,'later change'); await f.vault.restore(entry.id);
  assert.equal(await fs.readFile(first,'utf8'),'original');
});
test('protected app trees, their ancestors, vault and Windows aliases are denied',async()=>{
  const f=await fixture();
  for(const target of [os.homedir(),path.join(os.homedir(),'.codex','sessions'),path.join(os.homedir(),'.dsh'),path.join(os.homedir(),'.cockpit_tools'),f.vault.root,path.dirname(os.homedir())]) assert.throws(()=>assertMutable(target,f.workspace,f.config),/protected|Protected/);
  for(const bad of ['C:relative','\\\\?\\C:\\Users\\EXAMPLE_USER\\.codex','C:\\temp\\nul.txt','C:\\temp\\file.']) assert.throws(()=>assess(context(f.workspace,'recoverable_delete',{paths:[bad]}),f.config));
});
test('ordinary project edits and bounded literal deletion remain usable',async()=>{
  const f=await fixture();
  assert.equal(assess(context(f.workspace,'write',{path:'src/app.js'}),f.config).kind,'mutate');
  assert.deepEqual(simpleDeletion("Remove-Item -LiteralPath 'old file.txt' -Recurse -Force",'pwsh'),['old file.txt']);
  assert.deepEqual(simpleDeletion("rm -rf -- 'old file.txt'",'bash'),['old file.txt']);
  for(const command of ['Get-ChildItem | Select-Object Name','python -m pytest -q','npm test','git status']) assert.equal(shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config).kind,'run');
});
test('compound, wildcard, dynamic, inline-script and destructive Git deletions do not execute',async()=>{
  const f=await fixture();
  for(const command of ["Remove-Item 'a'; Remove-Item 'b'",'Remove-Item $env:USERPROFILE -Recurse','Remove-Item *.json',"Remove-Item 'a'\nWrite-Output 'x'","python -c \"import shutil; shutil.rmtree('a')\"",'git clean -fd','git reset --hard HEAD','Clear-RecycleBin -Force','powershell -EncodedCommand ignored']) assert.throws(()=>shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config),command);
});
test('native patch deletions and moves include every original and destination',async()=>{
  const f=await fixture(); const text='*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** Delete File: second.txt\n*** End Patch';
  assert.equal(parsePatchTargets(text).length,3); const plan=assess(context(f.workspace,'apply_patch',{input:text}),f.config); assert.equal(plan.paths.length,3); assert.equal(plan.deletions,1);
});
test('no fake success when recycling is unavailable; quarantine is retained',async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'recycle.txt')); f.vault.recycle=async()=>{throw new Error('recycler unavailable');};
  const [entry]=await f.vault.remove([file],{workspace:f.workspace,owner:'recycle-failure',destination:'recycle'}); assert.equal(entry.status,'quarantined'); await f.vault.restore(entry.id); assert.equal(await fs.readFile(file,'utf8'),'original');
});
test('native Windows recycling still retains an independently restorable backup',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture(); const file=await put(path.join(f.workspace,'回收站 中文 文件.txt')); const [entry]=await f.vault.remove([file],{workspace:f.workspace,owner:'windows-recycle',destination:'recycle'});
  assert.equal(entry.status,'recycled'); await f.vault.restore(entry.id); assert.equal(await fs.readFile(file,'utf8'),'original');
});
test('restoration works in a fresh Node process after plugin restart',async()=>{
  const f=await fixture();const file=await put(path.join(f.workspace,'restart.txt'),'persist after restart');
  const [entry]=await f.vault.remove([file],{workspace:f.workspace,owner:'restart'});
  const cli=path.resolve(import.meta.dirname,'../bin/recover.mjs');
  const child=spawnSync(process.execPath,[cli,'--vault',f.vault.root,'restore',entry.id],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);assert.equal(await fs.readFile(file,'utf8'),'persist after restart');
});
test('profile budget is shared across different sessions and subagents',async()=>{
  const f=await fixture({maxDeletedFilesPerDay:1});const a=await put(path.join(f.workspace,'parent'));const b=await put(path.join(f.workspace,'child'));
  await f.vault.remove([a],{workspace:f.workspace,owner:'parent-session'});
  await assert.rejects(new Vault(f.config).remove([b],{workspace:f.workspace,owner:'different-child-session'}),/Profile-wide/);assert.equal(await fs.readFile(b,'utf8'),'original');
});
test('workspace checkpoints preserve dependency junctions without following them',async()=>{
  const f=await fixture();const dependency=path.join(f.root,'dependency');await put(path.join(dependency,'external.txt'),'dependency data');
  await fs.symlink(dependency,path.join(f.workspace,'dependency-link'),'junction');
  const snapshot=await f.vault.snapshot(f.workspace,{kind:'workspace-checkpoint',owner:'links'});
  assert(snapshot.entries.some(e=>e.type==='link'));assert(!snapshot.entries.some(e=>e.relative.endsWith('external.txt')));
  const restored=path.join(f.root,'restored-workspace');await f.vault.restore(snapshot.id,{destination:restored});assert((await fs.lstat(path.join(restored,'dependency-link'))).isSymbolicLink());
});
test('C drive deletion is quarantined on C while its verified backup is held on D',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture();const croot=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-recovery-canary-'));const file=await put(path.join(croot,'C-drive-dummy.txt'),'C drive original');
  const [entry]=await f.vault.remove([file],{workspace:croot,owner:'c-drive',destination:'quarantine'});
  const manifest=JSON.parse(await fs.readFile(path.join(f.vault.root,'entries',entry.id,'manifest.json'),'utf8'));
  assert.equal(path.parse(manifest.quarantine).root.toLowerCase(),'c:\\');assert.equal(await fs.readFile(manifest.quarantine,'utf8'),'C drive original');
  await f.vault.restore(entry.id);assert.equal(await fs.readFile(file,'utf8'),'C drive original');
});
test('a concrete project under Desktop/Documents is usable while the containing root is protected',async()=>{
  const f=await fixture();
  for(const folder of ['Desktop','Documents']){
    const parent=path.join(os.homedir(),folder);const project=path.join(parent,'specific-project');
    assert.equal(assertMutable(path.join(project,'app.py'),project,f.config),path.join(project,'app.py'));
    assert.throws(()=>assertMutable(parent,project,f.config),/root itself is protected/);
  }
});
test('readonly Git-style objects can be checkpointed without changing their source attributes',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'.git','objects','07','object'),'readonly git object');
  await fs.chmod(source,0o444);const before=await fs.stat(source);assert.equal(before.mode&0o200,0);
  const snapshot=await f.vault.snapshot(f.workspace,{kind:'workspace-checkpoint',owner:'readonly-checkpoint',cacheAllowed:true});
  const object=snapshot.entries.find(e=>e.type==='file');assert(object);assert.equal(await fs.readFile(path.join(f.vault.root,'objects',object.hash),'utf8'),'readonly git object');
  assert.equal((await fs.stat(source)).mode&0o200,0);assert.deepEqual((await fs.readdir(path.join(f.vault.root,'objects'))).filter(n=>n.endsWith('.tmp')),[]);
});
test('directory deletion containing readonly files remains recoverable with readonly metadata',async()=>{
  const f=await fixture();const directory=path.join(f.workspace,'readonly-dir');const file=await put(path.join(directory,'readonly.txt'),'readonly original');await fs.chmod(file,0o444);
  const [entry]=await f.vault.remove([directory],{workspace:f.workspace,owner:'readonly-directory',destination:'quarantine'});
  await assert.rejects(fs.stat(directory),{code:'ENOENT'});await f.vault.restore(entry.id);
  assert.equal(await fs.readFile(file,'utf8'),'readonly original');assert.equal((await fs.stat(file)).mode&0o200,0);
});
test('an object publication error removes only the temporary copy from that attempt',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'publish-failure.txt'));await f.vault.init();
  const prior=path.join(f.vault.root,'objects','pre-existing-sample.tmp');await fs.writeFile(prior,'preserve historical sample');
  const originalRename=fs.rename;
  fs.rename=async(from,to)=>{if(path.dirname(String(from))===path.join(f.vault.root,'objects')&&String(from).endsWith('.tmp'))throw Object.assign(new Error('simulated publish failure'),{code:'EIO'});return originalRename(from,to);};
  try{await assert.rejects(f.vault.snapshot(source),/publish failure/);}finally{fs.rename=originalRename;}
  assert.equal(await fs.readFile(source,'utf8'),'original');assert.equal(await fs.readFile(prior,'utf8'),'preserve historical sample');
  assert.deepEqual((await fs.readdir(path.join(f.vault.root,'objects'))).filter(n=>n.endsWith('.tmp')),['pre-existing-sample.tmp']);
});
test('read-only PowerShell pipelines accept spacing while write pipelines stay protected',async()=>{
  const f=await fixture();
  for(const command of [`Get-ChildItem '${f.workspace}'|Select-Object -First 3`,`Get-ChildItem '${f.workspace}' | Select-Object -First 3`,`Get-Acl '${f.vault.root}' | Format-List`,`Get-Item '${f.vault.root}' | Where-Object Name | Select-Object Name | Out-String`]){
    const plan=shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config);assert.equal(plan.checkpoint,false,command);
  }
  assert.throws(()=>shellAssessment(`Get-Item '${f.vault.root}' | Out-File '${f.vault.root}/overwrite.txt'`,'pwsh',f.workspace,f.workspace,f.config),/protected/);
});
test('only exact version probes skip checkpoints; executable extra arguments still require one',async()=>{
  const f=await fixture();
  for(const command of ['node -v','node --version','npm -v','npm --version','python -V','python --version','pip --version','git --version','git rev-parse --show-toplevel'])assert.equal(shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config).checkpoint,false,command);
  for(const command of ['python -v','node --version -e "console.log(1)"','npm install','git commit -m fixture'])assert.equal(shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config).checkpoint,true,command);
});
test('recovery list and doctor are exact read-only capabilities without a writable CLI bypass',async()=>{
  const f=await fixture();const cli=path.join(SOURCE_ROOT,'bin','recover.mjs');
  assert.equal(DELETION_MARKER.test(cli),false);
  for(const action of ['list','doctor']){
    const plan=shellAssessment(`node '${cli}' ${action}`,'pwsh',f.workspace,f.workspace,f.config);assert.equal(plan.kind,'recovery-query');assert.equal(plan.action,action);
  }
  for(const suffix of ['restore fake-id','snapshot .','backup-apps','list --vault D:/other','doctor; Write-Output injected','list | Out-File output.txt'])assert.throws(()=>shellAssessment(`node '${cli}' ${suffix}`,'pwsh',f.workspace,f.workspace,f.config));
  assert.equal(DELETION_MARKER.test('find . -delete'),true);assert.equal(DELETION_MARKER.test('find . -exec command'),true);assert.equal(DELETION_MARKER.test('rsync --delete source target'),true);
});
test('deletion aliases in path names are not commands, but command positions remain protected',async()=>{
  const f=await fixture();
  for(const command of ["Set-ItemProperty -LiteralPath '.rd-v011-sample/ri/del.txt' -Name IsReadOnly -Value $true","node ./.rd-v011-probe.mjs","Get-ChildItem './ri/del/rd'","Write-Output 'rd; ri; del; rm'","node ./remove-item-test.mjs"]){
    assert.equal(hasDestructiveCommand(command,'pwsh'),false,command);assert.equal(shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config).kind,'run',command);
  }
  for(const command of ["Write-Output ready; rd old","Get-ChildItem | del","& 'C:/Windows/System32/cmd.exe' /c rd old",'cmd /c "rd old"',"pwsh -Command 'ri old'","bash -c 'rm old'","if ($true) { Remove-Item old }"]){
    assert.equal(hasDestructiveCommand(command,'pwsh'),true,command);assert.throws(()=>shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config),command);
  }
  for(const alias of ['rd','ri','del'])assert.equal(shellAssessment(`${alias} 'literal.txt'`,'pwsh',f.workspace,f.workspace,f.config).kind,'delete');
});
test('restore refuses an unwritable audit before creating its target or staging copy',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'audit-before.txt'),'audit prerequisite');const snapshot=await f.vault.snapshot(source);const target=path.join(f.root,'must-not-appear.txt');
  const before=await fs.readdir(f.root);
  f.vault.audit=async()=>{throw Object.assign(new Error('audit denied'),{code:'EPERM'});};
  await assert.rejects(f.vault.restore(snapshot.id,{destination:target}),{code:'RECOVERY_AUDIT_UNAVAILABLE'});
  await assert.rejects(fs.stat(target),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.root),before);assert.equal(await fs.readFile(source,'utf8'),'audit prerequisite');
});
test('completed restore with failed final audit is explicit and can be reconciled without another restore',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'audit-after.txt'),'restored exactly once');const snapshot=await f.vault.snapshot(source);const target=path.join(f.root,'restored-audit-after.txt');
  const audit=f.vault.audit.bind(f.vault);f.vault.audit=async(event,details)=>{if(event==='restored')throw Object.assign(new Error('simulated final audit fault'),{code:'EIO'});return audit(event,details);};
  const outcome=await f.vault.restore(snapshot.id,{destination:target});assert.equal(outcome.status,'restored-audit-pending');assert.equal(outcome.audit.state,'pending');assert.equal(await fs.readFile(target,'utf8'),'restored exactly once');
  const receipt=JSON.parse(await fs.readFile(outcome.audit.receiptPath,'utf8'));assert.equal(receipt.state,'restored-audit-pending');
  f.vault.audit=audit;const reconciled=await f.vault.reconcileRestores();assert.equal(reconciled.transactions[0].status,'reconciled');
  const events=(await fs.readFile(path.join(f.vault.root,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert(events.some(e=>e.event==='restore-started'&&e.transactionId===receipt.transactionId));assert(events.some(e=>e.event==='restored'&&e.reconciled===true&&e.transactionId===receipt.transactionId));
  assert.equal((await f.vault.reconcileRestores()).transactions.length,0);await assert.rejects(f.vault.restore(snapshot.id,{destination:target}),/never overwrites/);
});
test('audit reconciliation does not certify a restored target that has changed',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'source'),'snapshot text');const snapshot=await f.vault.snapshot(source);const target=path.join(f.root,'changed-restore');const audit=f.vault.audit.bind(f.vault);
  f.vault.audit=async(event,details)=>{if(event==='restored')throw new Error('final audit fault');return audit(event,details);};
  await f.vault.restore(snapshot.id,{destination:target});await fs.writeFile(target,'human edited text');f.vault.audit=audit;
  const reconciled=await f.vault.reconcileRestores();assert.equal(reconciled.transactions[0].status,'target-changed-not-reconciled');assert.equal(await fs.readFile(target,'utf8'),'human edited text');
});
test('restore CLI distinguishes audit-pending completion from failure',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'cli-pending'),'CLI restored bytes');const snapshot=await f.vault.snapshot(source);const target=path.join(f.root,'cli-target');
  const vaultUrl=new URL('../lib/vault.js',import.meta.url).href;
  const initialization=`import {Vault} from ${JSON.stringify(vaultUrl)};const original=Vault.prototype.audit;Vault.prototype.audit=async function(event,details){if(event==='restored')throw Object.assign(new Error('final fault'),{code:'EIO'});return original.call(this,event,details);};`;
  const cli=path.resolve(import.meta.dirname,'../bin/recover.mjs');
  const child=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(initialization)}`,cli,'--vault',f.vault.root,'restore',snapshot.id,'--to',target],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,2,child.stderr);assert.equal(JSON.parse(child.stdout).status,'restored-audit-pending');assert.equal(await fs.readFile(target,'utf8'),'CLI restored bytes');
  const reconcile=spawnSync(process.execPath,[cli,'--vault',f.vault.root,'reconcile'],{encoding:'utf8',windowsHide:true});assert.equal(reconcile.status,0,reconcile.stderr);assert.equal(JSON.parse(reconcile.stdout).transactions[0].status,'reconciled');
});
test('CMD deletion switches never become filesystem targets in PowerShell',async()=>{
  const f=await fixture();
  for(const command of ["rd /s /q 'literal-directory'","rmdir 'literal-directory' /S /Q","del /f /q 'literal-file'","erase /F 'literal-file'","Remove-Item /s 'literal-directory'","rd -- /s literal-directory"]){
    assert.throws(()=>shellAssessment(command,'pwsh',f.workspace,f.workspace,f.config),/CMD-style slash switches/,command);
  }
  assert.deepEqual(simpleDeletion("Remove-Item -LiteralPath 'literal-directory' -Recurse -Force",'pwsh'),['literal-directory']);
  assert.deepEqual(simpleDeletion('rm -rf /tmp/literal-directory','bash'),['/tmp/literal-directory']);
});
test('human recovery menu explains inherited agent context before prompting or doing work',{skip:process.platform!=='win32'},async()=>{
  const menu=path.resolve(import.meta.dirname,'../scripts/recovery-menu.ps1');
  const env={...process.env};delete env.DSH_SHELL;delete env.RECOVERABLE_DELETE_CONTEXT;
  env.PSModulePath=[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';');
  for(const flag of [{DSH_SHELL:'1'},{RECOVERABLE_DELETE_CONTEXT:'agent'}]){
    const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',menu],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...env,...flag}});
    assert.equal(child.status,1,child.stderr);assert.match(child.stdout,/资源管理器/);assert.match(child.stdout,/不会在这里启动/);assert.doesNotMatch(child.stdout,/请选择/);
  }
  const outside=spawnSync('powershell.exe',['-NoProfile','-File',menu],{encoding:'utf8',windowsHide:true,timeout:10000,env,input:'0\r\n'});
  assert.equal(outside.status,0,outside.stderr);assert.match(outside.stdout,/列出可恢复记录/);assert.doesNotMatch(outside.stdout,/不会在这里启动/);
});

// Copy the shipped entry points unchanged into an isolated installation with
// its own vault config. Tests exercise the real menu/CLI, never the user vault.
async function menuFixture() {
  const f=await fixture();const install=path.join(f.root,'menu-install');
  for(const relative of ['package.json','scripts/recovery-menu.ps1','bin/recover.mjs','lib/vault.js','lib/policy.js','lib/projects.js','lib/execution-context.js']){
    const target=path.join(install,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.resolve(import.meta.dirname,'..',relative),target);
  }
  await fs.writeFile(path.join(install,'recovery.config.json'),JSON.stringify(f.config));
  const env={...process.env};delete env.DSH_SHELL;delete env.RECOVERABLE_DELETE_CONTEXT;
  env.PSModulePath=[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';');
  f.menu=(engine,input)=>spawnSync(engine,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(install,'scripts/recovery-menu.ps1')],{encoding:'utf8',windowsHide:true,timeout:20000,env,input});
  f.install=install;return f;
}
function assertMenuSuccess(child){
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');assert.doesNotMatch(child.stdout,/恢复未完成|恢复列表格式无效|记录编号无效/);
}
test('real menu enumerates empty, single and multiple JSON records in PowerShell 5.1 and 7',{skip:process.platform!=='win32'},async()=>{
  for(const engine of ['powershell.exe','pwsh.exe']){
    const f=await menuFixture();let child=f.menu(engine,'2\r\n0\r\n');assertMenuSuccess(child);assert.match(child.stdout,/没有可恢复记录/);assert.doesNotMatch(child.stdout,/输入记录编号/);
    const first=await f.vault.snapshot(await put(path.join(f.workspace,'第一条 中文.txt'),'first menu record'));
    child=f.menu(engine,'1\r\n0\r\n');assertMenuSuccess(child);assert.deepEqual([...child.stdout.matchAll(/^\[(\d+)\] /gm)].map(m=>m[1]),['1']);assert(child.stdout.includes(first.id));assert(child.stdout.includes(first.original));
    await f.vault.snapshot(await put(path.join(f.workspace,'second.txt'),'second menu record'));
    await f.vault.snapshot(await put(path.join(f.workspace,'third.txt'),'third menu record'));
    child=f.menu(engine,'1\r\n0\r\n');assertMenuSuccess(child);assert.deepEqual([...child.stdout.matchAll(/^\[(\d+)\] /gm)].map(m=>m[1]),['1','2','3']);
    for(const entry of await f.vault.list())assert(child.stdout.includes('记录ID: '+entry.id));
  }
});

async function projectFixture(options={}) {
  const f=await fixture(options);const manager=new ProjectRecovery(f.config,f.vault);const project=await manager.open(f.workspace);
  return {...f,manager,project};
}
test('project backup byte limit retains source, deduplicates content, and never clears prior records',async()=>{
  const f=await projectFixture({maxProjectStoredBytes:8});const first=await put(path.join(f.workspace,'first.txt'),'12345678');
  const initial=await f.manager.remove(f.project,[first],{owner:'scope',reason:'first'});
  const same=await put(path.join(f.workspace,'same.txt'),'12345678');await f.manager.remove(f.project,[same],{owner:'scope',reason:'dedup'});
  assert.equal((await fs.readdir(path.join(f.project.root,'objects'))).length,1);
  const extra=await put(path.join(f.workspace,'extra.txt'),'more bytes');await assert.rejects(f.manager.remove(f.project,[extra],{owner:'scope',reason:'over limit'}),/storage budget/);
  assert.equal(await fs.readFile(extra,'utf8'),'more bytes');assert((await f.project.vault.list()).some(e=>e.id===initial[0].id));
});
test('project initialization refuses an unrelated pre-existing recovery directory',async()=>{
  const f=await fixture();const root=path.join(f.workspace,'.dsh-recovery');await fs.mkdir(root);await put(path.join(root,'existing.txt'),'human data');
  await assert.rejects(new ProjectRecovery(f.config,f.vault).open(f.workspace),/unregistered/);assert.equal(await fs.readFile(path.join(root,'existing.txt'),'utf8'),'human data');
});
test('automatic restore validates durable ownership and metadata before writing',async()=>{
  const f=await projectFixture();const source=await put(path.join(f.workspace,'original.txt'),'original');const [entry]=await f.manager.remove(f.project,[source],{owner:'scope',reason:'fixture'});
  await assert.rejects(f.manager.restore(f.project,'different-task',{id:entry.id,reason:'fixture'}),/limited to this task/);
  const file=path.join(f.project.root,'entries',entry.id,'manifest.json');const m=JSON.parse(await fs.readFile(file,'utf8'));m.original=path.join(f.workspace,'forged.txt');await fs.writeFile(file,JSON.stringify(m));
  await assert.rejects(f.manager.restore(f.project,'scope',{id:entry.id,reason:'fixture'}),/integrity/);await assert.rejects(fs.stat(m.original),{code:'ENOENT'});await assert.rejects(fs.stat(source),{code:'ENOENT'});
});
test('automatic restore refuses damaged objects, links, and protected project storage selections',async()=>{
  const f=await projectFixture();const source=await put(path.join(f.workspace,'source.txt'),'original');const m=await f.manager.snapshot(f.project,source,{owner:'scope',reason:'fixture'});
  await fs.writeFile(path.join(f.project.root,'objects',m.entries[0].hash),'damaged');await fs.unlink(source);
  await assert.rejects(f.manager.restore(f.project,'scope',{id:m.id,reason:'fixture'}),/integrity/);await assert.rejects(fs.stat(source),{code:'ENOENT'});
  const outside=path.join(f.root,'outside');await put(path.join(outside,'keep.txt'),'outside');await fs.symlink(outside,path.join(f.workspace,'linked'),'junction');
  const checkpoint=await f.manager.snapshot(f.project,f.workspace,{owner:'scope',reason:'links',kind:'workspace-checkpoint'});
  await assert.rejects(f.manager.restore(f.project,'scope',{id:checkpoint.id,relative_path:'linked',reason:'fixture'}),/link/i);
  assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'outside');
});
test('disposable recycle failure retains test originals without creating backup objects or permanent fallback',async()=>{
  const f=await projectFixture();const temp=await f.manager.temp(f.project,'scope','reproducible fixture');const sample=await put(path.join(temp.directory,'sample.txt'),'can regenerate');
  f.project.vault.recycle=async()=>{throw new Error('simulated recycler failure');};
  await assert.rejects(f.manager.remove(f.project,[temp.directory],{owner:'scope',reason:'cleanup'}),/no permanent-delete fallback/);
  assert.equal(await fs.readFile(sample,'utf8'),'can regenerate');assert.deepEqual(await fs.readdir(path.join(f.project.root,'objects')),[]);
});
test('mixed disposable and ordinary batches retain verified backups for all targets',async()=>{
  const f=await projectFixture();const temp=await f.manager.temp(f.project,'scope','reproducible fixture');await put(path.join(temp.directory,'temp.txt'),'temporary');const real=await put(path.join(f.workspace,'test-source.txt'),'real source');
  const results=await f.manager.remove(f.project,[temp.directory,real],{owner:'scope',reason:'mixed cleanup',destination:'quarantine'});
  assert(results.every(e=>e.backupMode!=='recycle-only'));assert.equal((await fs.readdir(path.join(f.project.root,'objects'))).length,2);
});
test('workspace checkpoints exclude only registered disposable roots and never snapshot the recovery store',async()=>{
  const f=await projectFixture();const temp=await f.manager.temp(f.project,'scope','registered');await put(path.join(temp.directory,'output.txt'),'disposable');
  const real=await put(path.join(f.workspace,'.dsh-test-tmp','human-existing','real.txt'),'keep this');
  const checkpoint=await f.manager.snapshot(f.project,f.workspace,{owner:'scope',reason:'checkpoint',kind:'workspace-checkpoint'});
  assert(!checkpoint.entries.some(e=>e.relative.includes('.dsh-recovery')));assert(!checkpoint.entries.some(e=>e.relative.includes(path.basename(temp.directory))));assert(checkpoint.entries.some(e=>path.join(f.workspace,e.relative)===real));
});
test('project deletion budgets remain profile-wide across workspaces',async()=>{
  const f=await fixture({maxDeletedFilesPerDay:1});const manager=new ProjectRecovery(f.config,f.vault);const a=await manager.open(f.workspace);const another=path.join(f.root,'second-project');await fs.mkdir(another);const b=await manager.open(another);
  await manager.remove(a,[await put(path.join(f.workspace,'one'),'first')],{owner:'a',reason:'fixture',destination:'quarantine'});
  const second=await put(path.join(another,'two'),'second');await assert.rejects(manager.remove(b,[second],{owner:'b',reason:'fixture',destination:'quarantine'}),/Profile-wide/);assert.equal(await fs.readFile(second,'utf8'),'second');
});
test('partial batch failure retains discoverable authorization for already removed project files',async()=>{
  const f=await projectFixture();const first=await put(path.join(f.workspace,'first.txt'),'first original');const second=await put(path.join(f.workspace,'second.txt'),'second original');const rename=fs.rename;
  fs.rename=async(from,to)=>{if(from===second)throw Object.assign(new Error('simulated second move failure'),{code:'EPERM'});return rename(from,to);};
  try{await assert.rejects(f.manager.remove(f.project,[first,second],{owner:'scope',reason:'batch failure fixture',destination:'quarantine'}),/second move failure/);}finally{fs.rename=rename;}
  await assert.rejects(fs.stat(first),{code:'ENOENT'});assert.equal(await fs.readFile(second,'utf8'),'second original');
  const records=await f.manager.list(f.project,'scope');const prior=records.find(e=>e.original===first);assert(prior);
  const restored=await f.manager.restore(f.project,'scope',{id:prior.id,reason:'recover already moved item after a partial batch failure'});assert.equal(restored.status,'restored');assert.equal(await fs.readFile(first,'utf8'),'first original');
});
test('host session scopes persist and cannot be reassigned by changed ancestry or workspace',async()=>{
  const f=await fixture();const manager=new ProjectRecovery(f.config,f.vault);const exec=header=>({agent:{session:{header}}});
  const parent={id:'parent',cwd:f.workspace};assert.equal(await manager.task(exec(parent),f.workspace),'parent');assert.equal(await manager.task(exec({id:'child',parentSession:'parent'}),f.workspace),'parent');
  const restarted=new ProjectRecovery(f.config,new Vault(f.config));assert.equal(await restarted.task(exec({id:'child',parentSession:'parent'}),f.workspace),'parent');
  await assert.rejects(restarted.task(exec({id:'child',parentSession:'other'}),f.workspace),/Task identity/);await assert.rejects(restarted.task(exec(parent),f.root),/Task identity/);
});

test('recovery list separates deletion status from the latest durable restore destination and audit',async()=>{
  const f=await projectFixture();const source=await put(path.join(f.workspace,'summary.txt'),'original summary bytes');const [deleted]=await f.manager.remove(f.project,[source],{owner:'scope',reason:'summary fixture',destination:'quarantine'});
  let listed=(await f.manager.list(f.project,'scope')).find(e=>e.id===deleted.id);assert.equal(listed.lastRestore,null);assert.equal(listed.restoreDestination,null);assert.equal(listed.audit,null);
  const restored=await f.manager.restore(f.project,'scope',{id:deleted.id,reason:'recover needed source'});
  listed=(await f.manager.list(f.project,'scope')).find(e=>e.id===deleted.id);assert.equal(listed.status,'quarantined');assert.equal(listed.lastRestore.status,'restored');assert.equal(listed.restoreDestination,source);assert.equal(listed.audit.state,'complete');assert.equal(listed.audit.transactionId,restored.audit.transactionId);
  const conflicted=await f.manager.restore(f.project,'scope',{id:deleted.id,reason:'compare old source with existing content'});
  const auditBefore=await fs.readFile(path.join(f.project.root,'audit.jsonl'),'utf8');listed=(await f.manager.list(f.project,'scope')).find(e=>e.id===deleted.id);assert.equal(listed.restoreDestination,conflicted.destination);assert.equal(listed.audit.transactionId,conflicted.audit.transactionId);assert.equal(listed.restoreQuery.state,'complete');assert.equal(await fs.readFile(path.join(f.project.root,'audit.jsonl'),'utf8'),auditBefore);
  assert.deepEqual(await f.manager.list(f.project,'other-task'),[]);
});

test('recovery list distinguishes pending, prepared and unreadable receipts without claiming a successful restore',async()=>{
  const f=await projectFixture();const source=await put(path.join(f.workspace,'pending-summary.txt'),'pending content');const snapshot=await f.manager.snapshot(f.project,source,{owner:'scope',reason:'pending fixture'});
  const audit=f.project.vault.audit.bind(f.project.vault);f.project.vault.audit=async(event,details)=>{if(event==='restored')throw new Error('final audit unavailable');return audit(event,details);};
  const outcome=await f.manager.restore(f.project,'scope',{id:snapshot.id,reason:'pending summary test'});assert.equal(outcome.status,'restored-audit-pending');
  let entry=(await f.manager.list(f.project,'scope'))[0];assert.equal(entry.audit.state,'pending');assert.equal(entry.lastRestore.status,'restored-audit-pending');
  f.project.vault.audit=audit;await f.project.vault.reconcileRestores();entry=(await f.manager.list(f.project,'scope'))[0];assert.equal(entry.audit.state,'complete');
  const receiptRoot=path.join(f.project.root,'state','restore-transactions');await fs.writeFile(path.join(receiptRoot,'later-prepared.json'),JSON.stringify({transactionId:'later-prepared',snapshotId:snapshot.id,destination:path.join(f.workspace,'not-published'),state:'prepared',at:'2099-01-01T00:00:00.000Z'}));
  await fs.writeFile(path.join(receiptRoot,'broken.json'),'{not valid json');entry=(await f.manager.list(f.project,'scope'))[0];assert.equal(entry.lastRestore.status,'incomplete');assert.equal(entry.audit.state,'incomplete');assert.equal(entry.restoreQuery.state,'partial');assert.equal(entry.restoreQuery.unreadableReceipts,1);
});
test('restore publication never overwrites a file created after the preflight check',async()=>{
  const f=await fixture();const source=await put(path.join(f.workspace,'source.txt'),'old recovery bytes');const snapshot=await f.vault.snapshot(source);const destination=path.join(f.root,'racing-target.txt');const originalLink=fs.link;
  fs.link=async(from,to)=>{if(to===destination)await fs.writeFile(destination,'new concurrent work',{flag:'wx'});return originalLink(from,to);};
  try{await assert.rejects(f.vault.restore(snapshot.id,{destination}),{code:'EEXIST'});}finally{fs.link=originalLink;}
  assert.equal(await fs.readFile(destination,'utf8'),'new concurrent work');
});
test('human menu discovers legacy and project records and restores a selected project ID',{skip:process.platform!=='win32'},async()=>{
  for(const engine of ['powershell.exe','pwsh.exe']){
    const f=await menuFixture();const manager=new ProjectRecovery(f.config,f.vault);const project=await manager.open(f.workspace);const file=await put(path.join(f.workspace,'project-restore.txt'),'project default restore');
    const [entry]=await manager.remove(project,[file],{owner:'scope',reason:'menu fixture',destination:'quarantine'});await f.vault.snapshot(await put(path.join(f.root,'legacy.txt'),'legacy fixture'));
    const listing=await catalogEntries(f.vault,100);assert(listing.some(e=>e.id===entry.id&&e.vaultRoot===project.root));assert(listing.some(e=>e.vaultRoot===f.vault.root));const number=listing.findIndex(e=>e.id===entry.id)+1;
    const child=f.menu(engine,`2\r\n${number}\r\n\r\n5\r\n0\r\n`);assertMenuSuccess(child);assert.match(child.stdout,/"status": "restored"/);assert.match(child.stdout,/"state": "complete"/);assert.equal(await fs.readFile(file,'utf8'),'project default restore');
  }
});
test('real menu selects a non-first record and restores both file and directory using default paths',{skip:process.platform!=='win32'},async()=>{
  for(const engine of ['powershell.exe','pwsh.exe']){
    const f=await menuFixture();const directory=path.join(f.workspace,'目录样本');const locked=await put(path.join(directory,'只读.txt'),'directory record content');await fs.chmod(locked,0o444);
    const [dir]=await f.vault.remove([directory],{workspace:f.workspace,owner:'menu-directory'});
    const file=await put(path.join(f.workspace,'file-sample.txt'),'file record content');const [single]=await f.vault.remove([file],{workspace:f.workspace,owner:'menu-file'});
    const decoy=await f.vault.snapshot(await put(path.join(f.workspace,'leave-this-alone.txt'),'decoy must remain unchanged'));
    const listing=await f.vault.list();const dirNo=listing.findIndex(e=>e.id===dir.id)+1;const fileNo=listing.findIndex(e=>e.id===single.id)+1;assert(dirNo>1);assert(fileNo>1);
    const child=f.menu(engine,`2\r\n${dirNo}\r\n\r\n2\r\n${fileNo}\r\n\r\n5\r\n0\r\n`);assertMenuSuccess(child);
    assert.equal((child.stdout.match(/"status": "restored"/g)||[]).length,2,child.stdout);assert.equal((child.stdout.match(/"state": "complete"/g)||[]).length,2,child.stdout);
    assert(child.stdout.includes('已选择记录: '+dir.id));assert(child.stdout.includes('已选择记录: '+single.id));
    assert.equal(await fs.readFile(locked,'utf8'),'directory record content');assert.equal((await fs.stat(locked)).mode&0o200,0);assert.equal(await fs.readFile(file,'utf8'),'file record content');
    const restored=(await fs.readFile(path.join(f.vault.root,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.event==='restored');
    assert.deepEqual(restored.map(e=>e.id),[dir.id,single.id]);assert(!restored.some(e=>e.id===decoy.id));
    assert.deepEqual(restored.map(e=>path.resolve(e.destination)),[directory,file]);
    assert.equal(await fs.readFile(decoy.original,'utf8'),'decoy must remain unchanged');
  }
});
test('real menu rejects array-valued record fields before selection or target prompts',{skip:process.platform!=='win32'},async()=>{
  const f=await menuFixture();const source=await put(path.join(f.workspace,'bad-record.txt'),'retained');const snapshot=await f.vault.snapshot(source);
  const manifest=path.join(f.vault.root,'entries',snapshot.id,'manifest.json');const contents=JSON.parse(await fs.readFile(manifest,'utf8'));contents.original=[source,path.join(f.workspace,'second.txt')];await fs.writeFile(manifest,JSON.stringify(contents));
  for(const engine of ['powershell.exe','pwsh.exe']){
    const child=f.menu(engine,'2\r\n0\r\n');assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/恢复列表格式无效/);assert.doesNotMatch(child.stdout,/输入记录编号|直接回车使用|已选择记录/);
  }
  assert.equal(await fs.readFile(source,'utf8'),'retained');assert.doesNotMatch(await fs.readFile(path.join(f.vault.root,'audit.jsonl'),'utf8'),/restore-started/);
});
test('restore CLI refuses extra record IDs instead of silently restoring the first',async()=>{
  const f=await fixture();const snapshot=await f.vault.snapshot(await put(path.join(f.workspace,'strict-cli.txt'),'strict CLI source'));const destination=path.join(f.root,'must-not-appear');
  const cli=path.resolve(import.meta.dirname,'../bin/recover.mjs');
  for(const extra of [[snapshot.id,'--to',destination],['--to'],['--unexpected',destination]]){
    const child=spawnSync(process.execPath,[cli,'--vault',f.vault.root,'restore',snapshot.id,...extra],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/exactly one record ID/);await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  }
  assert.doesNotMatch(await fs.readFile(path.join(f.vault.root,'audit.jsonl'),'utf8'),/restore-started/);
});
