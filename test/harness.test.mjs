import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SOURCE_ROOT } from '../lib/policy.js';
import * as Recovery from '../lib/index.js';
import { Vault } from '../lib/vault.js';
const host='D:/DeepSeek_dsh_win/resources/app/dsh';
const module=async name=>import(pathToFileURL(path.join(host,'node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await module('cordis');
const [Prompt,Tools,Native,Subprocess,Sandbox,Shell,ShellEnv,Fs,FsTools,ShellTools]=await Promise.all(['dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-subprocess-local','dsh-sandbox-local','dsh-pwsh-sandbox','dsh-shell-env','dsh-fs-local','dsh-tool-fs','dsh-tool-pwsh'].map(module));
await fs.mkdir('D:/dsh-recovery-tests',{recursive:true});
async function setup({purge=false,projectRecovery=false,existing}={}) {
  const root=existing?.root??await fs.mkdtemp('D:/dsh-recovery-tests/harness-');
  const workspace=existing?.workspace??path.join(root,'workspace-项目'); await fs.mkdir(workspace,{recursive:true});
  const config={hostRoot:host,vaultRoot:path.join(root,'dsh-recovery-vault'),checkpointWorkspace:true,confineShell:true,projectRecovery};
  const ctx=new Context();
  ctx.reflect.provide('workingDirectory',{ensure:async(agent)=>agent.session.header.cwd});
  ctx.reflect.provide('sandboxPolicy',{defaultMode:'danger-full-access',resolve:session=>({mode:'danger-full-access',workspaceRoot:session?.header?.cwd??workspace})});
  await ctx.plugin(Prompt.default).await();
  await ctx.plugin(Tools.default).await();
  await ctx.plugin(Native).await();
  await ctx.plugin(Subprocess.default).await();
  await ctx.plugin(Sandbox.default).await();
  await ctx.plugin(Shell.default,{cwd:workspace,pwshPath:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'}).await();
  await ctx.plugin(ShellEnv,{dshHome:path.join(root,'dsh-home')}).await();
  await ctx.plugin(Fs.default,{cwd:workspace}).await();
  await ctx.plugin(FsTools,{read:true,readImage:false,write:true,edit:true,applyPatch:true}).await();
  await ctx.plugin(ShellTools,{enableRunInBackground:false,promoteOnTimeout:false}).await();
  if(purge) {
    const saved=process.env.DSH_HOME; process.env.DSH_HOME=path.join(root,'dsh-home'); await fs.mkdir(process.env.DSH_HOME,{recursive:true});
    const purgeModule=await import(pathToFileURL(path.join(os.homedir(),'.dsh/profiles/desktop/node_modules/dsh-purge-community/lib/index.js')).href);
    await ctx.plugin(purgeModule,{enabled:true,autoApplyOnStart:false,autoUpdateOnStart:false,autoRevertOnMissing:false,autoRetry:false,autoContinue:false,capabilityProtocol:false,hooksDenyBypass:true}).await();
    if(saved===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=saved;
  }
  // An unconditional upstream pre-execute allow must not defeat the guard.
  ctx.on('tools/pre-execute',async()=>({kind:'allow'}),{prepend:true});
  await ctx.plugin(Recovery,config).await();
  const agent={id:'acceptance-agent',session:{header:{cwd:workspace,id:'acceptance-session'},append:()=>({seq:0})}};
  let counter=0;
  const run=async(name,args)=>{
    const batch=await ctx.tools.execute({agent,calls:[{id:`acceptance-${++counter}`,name,arguments:JSON.stringify(args)}],signal:new AbortController().signal});
    return batch.results[0].result;
  };
  const runAs=async(header,name,args)=>{
    const batch=await ctx.tools.execute({agent:{...agent,session:{...agent.session,header:{cwd:workspace,...header}}},calls:[{id:`acceptance-${++counter}`,name,arguments:JSON.stringify(args)}],signal:new AbortController().signal});return batch.results[0].result;
  };
  return {root,workspace,ctx,config,run,runAs,vault:new Vault(config),projectVault:new Vault({...config,vaultRoot:path.join(workspace,'.dsh-recovery')})};
}
function text(r){return r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');}
test('real patched Harness: file writes, edits, patches and removal are recoverable',async()=>{
  const f=await setup();
  try {
    assert.equal((await f.run('recovery_status',{})).value.shellConfinement,'active');
    const file=path.join(f.workspace,'existing.txt'); await fs.writeFile(file,'old\n');
    const write=await f.run('write',{file_path:file,content:'new\n'}); assert.equal(write.isError,false,text(write));
    assert.equal(await fs.readFile(file,'utf8'),'new\n');
    const backups=await f.vault.list(); const original=backups.find(b=>b.original===file); assert(original);
    await f.vault.restore(original.id,{destination:path.join(f.root,'old-copy.txt')}); assert.equal(await fs.readFile(path.join(f.root,'old-copy.txt'),'utf8'),'old\n');
    const removed=await f.run('pwsh',{command:"Remove-Item -LiteralPath 'existing.txt' -Force",description:'acceptance fixture deletion'}); assert.equal(removed.isError,false,text(removed));
    await assert.rejects(fs.stat(file),{code:'ENOENT'}); assert.match(text(removed),/Recovery IDs/);
    const deletion=(await f.vault.list()).find(e=>e.kind==='recoverable-delete'); await f.vault.restore(deletion.id); assert.equal(await fs.readFile(file,'utf8'),'new\n');
    const patch=await f.run('apply_patch',{input:'*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch'}); assert.equal(patch.isError,false,text(patch));
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
    const prePatch=(await f.vault.list()).find(e=>e.kind==='pre-mutation'&&e.original===file); await f.vault.restore(prePatch.id); assert.equal(await fs.readFile(file,'utf8'),'new\n');
  } finally { await f.ctx.fiber.dispose(); }
});

test('project tools: selective local backup and scoped automatic restore survive a host restart',async()=>{
  let f=await setup({projectRecovery:true});const original=f;
  try{
    const source=path.join(f.workspace,'keep-code.txt'),unrelated=path.join(f.workspace,'large-unrelated.bin');await fs.writeFile(source,'recover original code');await fs.writeFile(unrelated,Buffer.alloc(256*1024,77));
    const removed=await f.run('recoverable_delete',{paths:[source],reason:'remove obsolete fixture'});assert.equal(removed.isError,false,text(removed));
    const id=removed.value.entries[0].id;const manifest=JSON.parse(await fs.readFile(path.join(f.projectVault.root,'entries',id,'manifest.json'),'utf8'));
    const brokered=await f.run('pwsh',{command:`node '${path.join(SOURCE_ROOT,'bin/recover.mjs')}' list`,description:'scoped recovery list through read-only broker'});assert.equal(brokered.isError,false,text(brokered));assert(JSON.parse(brokered.value.stdout.text).some(e=>e.id===id));
    assert.equal(manifest.reason,'remove obsolete fixture');assert.equal(manifest.original,source);assert.equal(manifest.entries.length,1);assert.equal((await fs.readdir(path.join(f.projectVault.root,'objects'))).length,1);
    const outsider=await f.runAs({id:'another-task'},'recoverable_restore',{id,reason:'cross-task attempt'});assert.equal(outsider.isError,true,text(outsider));await assert.rejects(fs.stat(source),{code:'ENOENT'});
    await f.ctx.fiber.dispose();f=await setup({projectRecovery:true,existing:original});
    const restored=await f.run('recoverable_restore',{id,reason:'deleted needed code by mistake'});assert.equal(restored.isError,false,text(restored));assert.equal(restored.value.status,'restored');assert.equal(restored.value.audit.state,'complete');assert.equal(await fs.readFile(source,'utf8'),'recover original code');assert.equal((await fs.stat(unrelated)).size,256*1024);
  }finally{await f.ctx.fiber.dispose();}
});

test('project tools: conflicts preserve new content, trusted children share scope, repeated restores stop',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const source=path.join(f.workspace,'conflict.txt');await fs.writeFile(source,'old contents');
    const removed=await f.run('recoverable_delete',{paths:[source],reason:'fixture deletion'});assert.equal(removed.isError,false,text(removed));const id=removed.value.entries[0].id;await fs.writeFile(source,'new work must survive');
    const child=await f.runAs({id:'trusted-child',parentSession:'acceptance-session'},'recoverable_restore',{id,reason:'need the old version for comparison'});assert.equal(child.isError,false,text(child));assert.equal(child.value.conflictCopy,true);assert.equal(await fs.readFile(source,'utf8'),'new work must survive');assert.equal(await fs.readFile(child.value.destination,'utf8'),'old contents');
    for(let i=0;i<2;i++){const again=await f.run('recoverable_restore',{id,reason:'loop fixture'});assert.equal(again.isError,false,text(again));}
    const stopped=await f.run('recoverable_restore',{id,reason:'loop fixture'});assert.equal(stopped.isError,true,text(stopped));assert.match(text(stopped),/Repeated restore limit/);assert.equal(await fs.readFile(source,'utf8'),'new work must survive');
  }finally{await f.ctx.fiber.dispose();}
});

test('project tools: disposable directories recycle without object backups; ordinary test names remain backed up',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const temp=await f.run('recovery_create_temp',{reason:'generated test output only'});assert.equal(temp.isError,false,text(temp));const directory=temp.value.directory;
    assert.deepEqual(await fs.readdir(directory),[]);const sample=path.join(directory,'output.bin');const written=await f.run('write',{file_path:sample,content:'disposable output'});assert.equal(written.isError,false,text(written));
    const before=await fs.readdir(path.join(f.projectVault.root,'objects'));const removed=await f.run('recoverable_delete',{paths:[directory],reason:'finished temporary test'});assert.equal(removed.isError,false,text(removed));assert.equal(removed.value.entries[0].status,'recycled-no-backup');assert.deepEqual(await fs.readdir(path.join(f.projectVault.root,'objects')),before);
    const cannotRestore=await f.run('recoverable_restore',{id:removed.value.entries[0].id,reason:'fixture'});assert.equal(cannotRestore.isError,true,text(cannotRestore));assert.match(text(cannotRestore),/no backup copy/);
    const ordinary=path.join(f.workspace,'tmp-test-source.txt');await fs.writeFile(ordinary,'important test source');const regular=await f.run('recoverable_delete',{paths:[ordinary],reason:'ordinary fixture'});assert.equal(regular.isError,false,text(regular));assert.equal(regular.value.entries[0].backupMode,undefined);assert.equal((await fs.readdir(path.join(f.projectVault.root,'objects'))).length,before.length+1);
  }finally{await f.ctx.fiber.dispose();}
});

test('project sandbox: hidden script cannot overwrite backup objects or rename the recovery directory',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const source=path.join(f.workspace,'source.txt');await fs.writeFile(source,'protected backup bytes');const removed=await f.run('recoverable_delete',{paths:[source],reason:'vault guard fixture'});assert.equal(removed.isError,false,text(removed));
    const id=removed.value.entries[0].id;const manifest=JSON.parse(await fs.readFile(path.join(f.projectVault.root,'entries',id,'manifest.json'),'utf8'));const object=path.join(f.projectVault.root,'objects',manifest.entries[0].hash);
    const script=path.join(f.workspace,'vault-probe.mjs');await fs.writeFile(script,`import fs from 'node:fs';import path from 'node:path';const root=path.join(process.cwd(),'.dsh'+'-recovery');let denied=0;for(const operation of [()=>fs.writeFileSync(path.join(root,'objects',${JSON.stringify(manifest.entries[0].hash)}),'bad'),()=>fs.renameSync(root,root+'-moved')]){try{operation();}catch{denied++;}}console.log('denied='+denied);`);
    const outcome=await f.run('pwsh',{command:'node vault-probe.mjs',description:'probe project backup protection using synthetic data'});assert.equal(outcome.isError,false,text(outcome));assert.match(text(outcome),/denied=2/);assert.equal(await fs.readFile(object,'utf8'),'protected backup bytes');
    for(const call of [['write',{file_path:path.join(f.projectVault.root,'bad.txt'),content:'bad'}],['recoverable_delete',{paths:[f.projectVault.root],reason:'must refuse'}],['pwsh',{command:'Clear-RecycleBin -Force',description:'must refuse'}]]){const result=await f.run(...call);assert.equal(result.isError,true,text(result));}
    const native=await f.run('write',{file_path:path.join(f.workspace,'normal.txt'),content:'ordinary work still works'});assert.equal(native.isError,false,text(native));
  }finally{await f.ctx.fiber.dispose();}
});

test('project checkpoint: generic script deletion is recoverable by exact relative path and excludes recovery storage',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const source=path.join(f.workspace,'script-original.txt');await fs.writeFile(source,'before script deletion');const script=path.join(f.workspace,'worker.mjs');await fs.writeFile(script,"import fs from 'node:fs';fs.unlinkSync('script-original.txt');console.log('script-done');");
    const outcome=await f.run('pwsh',{command:'node worker.mjs',description:'script with unpredictable file effects'});assert.equal(outcome.isError,false,text(outcome));assert.match(text(outcome),/script-done/);
    const listing=await f.run('recovery_list',{});assert.equal(listing.isError,false,text(listing));const snapshot=listing.value.recent.find(e=>e.kind==='workspace-checkpoint');assert(snapshot);
    const manifest=JSON.parse(await fs.readFile(path.join(f.projectVault.root,'entries',snapshot.id,'manifest.json'),'utf8'));assert(!manifest.entries.some(e=>e.relative.includes('.dsh-recovery')));
    const full=await f.run('recoverable_restore',{id:snapshot.id,reason:'must refuse full rollback'});assert.equal(full.isError,true,text(full));
    const restored=await f.run('recoverable_restore',{id:snapshot.id,relative_path:'script-original.txt',reason:'restore one accidentally deleted file'});assert.equal(restored.isError,false,text(restored));assert.equal(await fs.readFile(source,'utf8'),'before script deletion');
    for(const relative_path of ['../escape','..\\escape','.dsh-recovery/project.json']){const denied=await f.run('recoverable_restore',{id:snapshot.id,relative_path,reason:'invalid fixture'});assert.equal(denied.isError,true,text(denied));}
  }finally{await f.ctx.fiber.dispose();}
});

test('project shell: exact content writes snapshot only their target and reject dynamic-path shortcuts',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const source=path.join(f.workspace,'small.txt');await fs.writeFile(source,'small original');await fs.writeFile(path.join(f.workspace,'unrelated.bin'),Buffer.alloc(512*1024,63));
    const edited=await f.run('pwsh',{command:"Set-Content -LiteralPath 'small.txt' -Value 'updated'",description:'precise shell mutation'});assert.equal(edited.isError,false,text(edited));assert.equal(edited.value.exitCode,0,text(edited));
    const records=await f.projectVault.list();assert.equal(records.length,1);assert.equal(records[0].kind,'pre-mutation');assert.equal(records[0].original,source);assert.equal((await fs.readdir(path.join(f.projectVault.root,'objects'))).length,1);
    const snapshot=records[0],restored=await f.run('recoverable_restore',{id:snapshot.id,reason:'compare before content edit'});assert.equal(restored.isError,false,text(restored));assert.equal(restored.value.conflictCopy,true);assert.match(await fs.readFile(source,'utf8'),/updated/);assert.equal(await fs.readFile(restored.value.destination,'utf8'),'small original');
  }finally{await f.ctx.fiber.dispose();}
});

test('project shell: Python tests and Git commits work while recovery contents stay out of Git',async()=>{
  const f=await setup({projectRecovery:true});
  const git=(args)=>{const child=spawnSync('git',args,{cwd:f.workspace,encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);return child.stdout;};
  try{
    git(['init','--quiet']);await fs.writeFile(path.join(f.workspace,'test_sample.py'),"import unittest,tempfile,pathlib\nclass Sample(unittest.TestCase):\n def test_temporary_output(self):\n  with tempfile.TemporaryDirectory() as directory:\n   output=pathlib.Path(directory)/'sample.txt'\n   output.write_text('temporary')\n   self.assertEqual(output.read_text(),'temporary')\n");
    const tested=await f.run('pwsh',{command:'python -m unittest -q',description:'real Python temporary-file test'});assert.equal(tested.isError,false,text(tested));assert.equal(tested.value.exitCode,0,text(tested));
    const add=await f.run('pwsh',{command:'git add -- .',description:'stage fixture project, excluding recovery objects'});assert.equal(add.isError,false,text(add));assert.equal(add.value.exitCode,0,text(add));assert(!git(['ls-files']).includes('.dsh-recovery'));
    await fs.mkdir(path.join(f.root,'no-hooks'));const committed=await f.run('pwsh',{command:`git -c user.name='Recovery Fixture' -c user.email=recovery-fixture@invalid.example -c commit.gpgsign=false -c core.hooksPath='${path.join(f.root,'no-hooks')}' commit --quiet -m 'project recovery fixture'`,description:'real local fixture commit'});assert.equal(committed.isError,false,text(committed));assert.equal(committed.value.exitCode,0,text(committed));assert.equal(git(['log','-1','--format=%s']).trim(),'project recovery fixture');
  }finally{await f.ctx.fiber.dispose();}
});

test('project recovery with Purge: scoped restore works and protected data/backup clearing stay denied',async()=>{
  const f=await setup({purge:true,projectRecovery:true});
  try{
    const source=path.join(f.workspace,'purge-scoped.txt');await fs.writeFile(source,'purge scoped original');const removed=await f.run('recoverable_delete',{paths:[source],reason:'scoped purge fixture'});assert.equal(removed.isError,false,text(removed));
    const restored=await f.run('recoverable_restore',{id:removed.value.entries[0].id,reason:'accidental cleanup blocked continuing work'});assert.equal(restored.isError,false,text(restored));assert.equal(await fs.readFile(source,'utf8'),'purge scoped original');
    for(const [name,args] of [['recoverable_delete',{paths:[f.config.vaultRoot],reason:'must refuse'}],['recoverable_delete',{paths:[f.projectVault.root],reason:'must refuse'}],['pwsh',{command:'Clear-RecycleBin -Force',description:'must refuse'}]]){const blocked=await f.run(name,args);assert.equal(blocked.isError,true,text(blocked));}
    const prompts=await f.ctx.systemPrompt.assemble({});assert.match(JSON.stringify(prompts),/dsh-purge|破甲|Purge|purge/i);
  }finally{await f.ctx.fiber.dispose();}
});

test('project status reports the immutable workspace and cwd changes cannot expand recovery authority',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const outside=path.join(f.root,'external-acceptance');await fs.mkdir(outside);const file=path.join(outside,'fixture.txt');await fs.writeFile(file,'outside sample must stay');
    const location=await f.run('pwsh',{command:'pwd',workdir:outside,description:'read-only cwd change'});assert.equal(location.isError,false,text(location));
    const status=await f.run('recovery_status',{});assert.equal(status.value.boundWorkspace,f.workspace);assert.match(status.value.workspaceBinding,/does not rebind/);
    for(const [name,args] of [['recoverable_delete',{paths:[file],reason:'outside fixture must refuse'}],['write',{file_path:file,content:'must refuse'}]]){const denied=await f.run(name,args);assert.equal(denied.isError,true,text(denied));}
    assert.equal(await fs.readFile(file,'utf8'),'outside sample must stay');
    const source=path.join(f.workspace,'inside.txt');await fs.writeFile(source,'inside source');const deleted=await f.run('recoverable_delete',{paths:[source],reason:'inside fixture'});assert.equal(deleted.isError,false,text(deleted));const id=deleted.value.entries[0].id;
    const restored=await f.run('recoverable_restore',{id,reason:'inside recovery'});assert.equal(restored.isError,false,text(restored));const listing=await f.run('recovery_list',{});const record=listing.value.recent.find(e=>e.id===id);assert.equal(record.restoreDestination,source);assert.equal(record.audit.state,'complete');assert.equal(record.audit.transactionId,restored.value.audit.transactionId);
  }finally{await f.ctx.fiber.dispose();}
});
async function queryFootprint(f){
  const names=(await fs.readdir(f.config.vaultRoot,{recursive:true})).sort(),files=[];
  for(const name of names){if(name===path.join('state','plugin-live.json')||name.endsWith('.tmp'))continue;const file=path.join(f.config.vaultRoot,name);if((await fs.lstat(file)).isFile())files.push([name,(await fs.readFile(file)).toString('base64')]);}
  return files;
}
test('project queries after restart find persisted records before any open and agree without writing metadata',async()=>{
  let f=await setup({projectRecovery:true});const original=f;
  try{
    const file=path.join(f.workspace,'persisted-status.txt');await fs.writeFile(file,'persistent status sample');const removed=await f.run('recoverable_delete',{paths:[file],reason:'status restart fixture'});assert.equal(removed.isError,false,text(removed));const id=removed.value.entries[0].id;
    const restored=await f.run('recoverable_restore',{id,reason:'status receipt fixture'});assert.equal(restored.isError,false,text(restored));
    await f.vault.snapshot(path.join(f.workspace,'persisted-status.txt'),{owner:'legacy',reason:'unrelated global record'});
    await f.ctx.fiber.dispose();f=await setup({projectRecovery:true,existing:original});const before=await queryFootprint(f);const canaryBefore=await fs.stat(path.join(f.projectVault.root,'protection-canary.txt'));
    const status=await f.run('recovery_status',{});assert.equal(status.isError,false,text(status));assert.equal(status.value.projectVault,f.projectVault.root);assert.equal(status.value.projectVaultState,'ready');assert.equal(status.value.recentSource,'project');assert(status.value.recent.some(e=>e.id===id));assert(status.value.recent.every(e=>e.vaultRoot===f.projectVault.root));
    const listing=await f.run('recovery_list',{});assert.equal(listing.isError,false,text(listing));assert.deepEqual(status.value.recent,listing.value.recent.slice(0,10));assert.equal(listing.value.recent[0].receiptIndex.state,'readable');
    const other=await f.runAs({id:'unregistered-other-query'},'recovery_status',{});assert.equal(other.value.projectVault,f.projectVault.root);assert.deepEqual(other.value.recent,[]);
    assert.deepEqual(await queryFootprint(f),before);const canaryAfter=await fs.stat(path.join(f.projectVault.root,'protection-canary.txt'));assert.equal(canaryAfter.mtimeMs,canaryBefore.mtimeMs);
  }finally{await f.ctx.fiber.dispose();}
});
test('fresh project queries stay empty and read-only even if the global archive has older records',async()=>{
  const f=await setup({projectRecovery:true});
  try{
    const legacy=path.join(f.root,'legacy.txt');await fs.writeFile(legacy,'global archive content');await f.vault.snapshot(legacy,{owner:'legacy'});const before=await queryFootprint(f);
    for(const name of ['recovery_status','recovery_list']){const result=await f.run(name,{});assert.equal(result.isError,false,text(result));assert.equal(result.value.projectVault,null);assert.equal(result.value.projectVaultState,'absent');assert.equal(result.value.recentSource,'project');assert.deepEqual(result.value.recent,[]);}
    await assert.rejects(fs.stat(f.projectVault.root),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.workspace),[]);assert.deepEqual(await queryFootprint(f),before);
    const missing=await f.run('recoverable_delete',{paths:[path.join(f.workspace,'.rd-probe-none.txt')],reason:'nonexistent target fixture'});assert.equal(missing.isError,true,text(missing));assert.match(text(missing),/Deletion target does not exist/);assert.doesNotMatch(text(missing),/partial batch/i);
  }finally{await f.ctx.fiber.dispose();}
});
test('legacy-mode status and list identify the global source explicitly',async()=>{
  const f=await setup();
  try{
    const legacy=path.join(f.root,'legacy.txt');await fs.writeFile(legacy,'global archive content');await f.vault.snapshot(legacy,{owner:'legacy'});
    const status=await f.run('recovery_status',{}),listing=await f.run('recovery_list',{});assert.equal(status.value.recentSource,'legacy-global');assert.equal(status.value.projectVaultState,'disabled');assert.deepEqual(status.value.recent,listing.value.recent.slice(0,10));assert(status.value.recent.every(e=>e.vaultRoot===f.vault.root));
  }finally{await f.ctx.fiber.dispose();}
});

test('real Windows shell: normal work runs, arbitrary workspace script deletion has a prior checkpoint, outside writes fail',async()=>{
  const f=await setup();
  try {
    const existing=path.join(f.workspace,'from-script.txt'); await fs.writeFile(existing,'script original');
    const script=path.join(f.workspace,'worker.ps1');
    await fs.writeFile(script,"[System.IO.File]::Delete((Join-Path $PSScriptRoot 'from-script.txt'))\nWrite-Output 'worker-done'\n");
    const normal=await f.run('pwsh',{command:"Set-Content -LiteralPath 'created.txt' -Value 'created'; Write-Output 'inside-ok'",description:'normal project write'});
    assert.equal(normal.isError,false,text(normal)); assert.match(text(normal),/inside-ok/); assert.match(await fs.readFile(path.join(f.workspace,'created.txt'),'utf8'),/created/);
    const scripted=await f.run('pwsh',{command:"powershell.exe -NoProfile -File .\\worker.ps1",description:'existing workspace script'});
    assert.equal(scripted.isError,false,text(scripted)); assert.match(text(scripted),/worker-done/); await assert.rejects(fs.stat(existing),{code:'ENOENT'});
    const checkpoints=(await f.vault.list()).filter(e=>e.kind==='workspace-checkpoint'); assert(checkpoints.length>=2);
    const restored=path.join(f.root,'script-recovery'); await f.vault.restore(checkpoints[0].id,{destination:restored}); assert.equal(await fs.readFile(path.join(restored,'from-script.txt'),'utf8'),'script original');
    const outside=path.join(f.root,'outside.txt'); await fs.writeFile(outside,'outside original');
    const escaped=await f.run('pwsh',{command:`Set-Content -LiteralPath '${outside}' -Value 'bad'`,description:'outside-write canary'});
    assert.equal(await fs.readFile(outside,'utf8'),'outside original',text(escaped)); assert.match(text(escaped),/denied|拒绝|sandbox|Access/i);
  } finally { await f.ctx.fiber.dispose(); }
});
test('real patched Harness: protected data and ambiguous deletion remain denied despite pre-execute allow',async()=>{
  const f=await setup();
  try {
    for(const [name,args] of [
      ['pwsh',{command:`Remove-Item -LiteralPath '${path.join(os.homedir(),'.codex','sessions')}' -Recurse -Force`,description:'protected path canary'}],
      ['write',{file_path:path.join(os.homedir(),'.dsh','settings.yaml'),content:'must not write'}],
      ['pwsh',{command:'Remove-Item *.json',description:'wildcard canary'}],
      ['pwsh',{command:'git clean -fd',description:'destructive Git canary'}],
    ]) { const outcome=await f.run(name,args); assert.equal(outcome.isError,true,text(outcome)); assert.match(text(outcome),/recoverable-delete/); }
    const okay=await f.run('pwsh',{command:'Write-Output "still-responsive"',description:'subsequent normal call'}); assert.equal(okay.isError,false,text(okay)); assert.match(text(okay),/still-responsive/);
  } finally { await f.ctx.fiber.dispose(); }
});
test('real purge plugin coexistence: prompt injection remains mounted and deletion protection still works',async()=>{
  const f=await setup({purge:true});
  try {
    const file=path.join(f.workspace,'purge-test.txt'); await fs.writeFile(file,'purge coexistence');
    const removed=await f.run('recoverable_delete',{paths:[file]}); assert.equal(removed.isError,false,text(removed)); await assert.rejects(fs.stat(file),{code:'ENOENT'});
    const blocked=await f.run('pwsh',{command:`Remove-Item -LiteralPath '${path.join(os.homedir(),'.codex')}' -Recurse -Force`,description:'purge coexistence canary'}); assert.equal(blocked.isError,true,text(blocked));
    const sections=await f.ctx.systemPrompt.assemble({}); assert.match(JSON.stringify(sections),/dsh-purge|破甲|Purge|purge/i);
  } finally { await f.ctx.fiber.dispose(); }
});
test('real Windows shell: readonly Git objects do not block Node, Python, npm or git commit',async()=>{
  const f=await setup();
  const gitArgs=['-c','user.name=Recovery Fixture','-c','user.email=recovery-fixture@invalid.example','-c','commit.gpgsign=false','-c',`core.hooksPath=${path.join(f.root,'empty-hooks')}`];
  const fixtureGit=(args)=>{const execution=spawnSync('git',[...gitArgs,...args],{cwd:f.workspace,encoding:'utf8',windowsHide:true});assert.equal(execution.status,0,execution.stderr);return execution.stdout;};
  try{
    await fs.mkdir(path.join(f.root,'empty-hooks'));fixtureGit(['init','--quiet']);
    await fs.writeFile(path.join(f.workspace,'seed.txt'),'seed\n');fixtureGit(['add','--','seed.txt']);fixtureGit(['commit','--quiet','-m','seed fixture']);
    const objectDirectory=path.join(f.workspace,'.git','objects');let readonlyCount=0;
    for(const prefix of await fs.readdir(objectDirectory)){if(!/^[0-9a-f]{2}$/.test(prefix))continue;for(const name of await fs.readdir(path.join(objectDirectory,prefix)))if(((await fs.stat(path.join(objectDirectory,prefix,name))).mode&0o200)===0)readonlyCount++;}
    assert(readonlyCount>0,'The fixture must contain real readonly Git objects.');
    for(const command of ['node -v','npm --version','python --version','git status --short']){
      const outcome=await f.run('pwsh',{command,description:'read-only probe with readonly Git objects'});assert.equal(outcome.isError,false,text(outcome));assert.equal(outcome.value.exitCode,0,text(outcome));
    }
    assert.equal((await f.run('recovery_status',{})).value.lastCheckpoint,null);
    for(const command of ['node -e "console.log(123)"','python -c "print(456)"']){
      const outcome=await f.run('pwsh',{command,description:'runtime with a complete readonly-object checkpoint'});assert.equal(outcome.isError,false,text(outcome));assert.equal(outcome.value.exitCode,0,text(outcome));
    }
    await fs.writeFile(path.join(f.workspace,'changed.txt'),'commit after readonly checkpoint\n');
    const commands=['git add -- changed.txt',`git -c user.name='Recovery Fixture' -c user.email=recovery-fixture@invalid.example -c commit.gpgsign=false -c core.hooksPath='${path.join(f.root,'empty-hooks')}' commit --quiet -m 'checkpoint regression'`];
    for(const command of commands){const outcome=await f.run('pwsh',{command,description:'local fixture Git commit'});assert.equal(outcome.isError,false,text(outcome));assert.equal(outcome.value.exitCode,0,text(outcome));}
    assert.equal(fixtureGit(['log','-1','--format=%s']).trim(),'checkpoint regression');
    assert((await f.vault.list(50)).some(e=>e.kind==='workspace-checkpoint'));
    const directory=path.join(f.workspace,'readonly-delete');await fs.mkdir(directory);const file=path.join(directory,'readonly.txt');await fs.writeFile(file,'readonly directory restore');await fs.chmod(file,0o444);
    const deleted=await f.run('recoverable_delete',{paths:[directory]});assert.equal(deleted.isError,false,text(deleted));
    const entry=deleted.value.entries[0];assert(['recycled','quarantined'].includes(entry.status));await f.vault.restore(entry.id);
    assert.equal(await fs.readFile(file,'utf8'),'readonly directory restore');assert.equal((await fs.stat(file)).mode&0o200,0);
    assert.equal((await fs.readdir(path.join(f.vault.root,'objects'))).filter(n=>n.endsWith('.tmp')).length,0);
  }finally{await f.ctx.fiber.dispose();}
});
test('real Windows shell: spaced ACL pipeline and brokered recovery diagnostics keep vault writes blocked',async()=>{
  const f=await setup();const cli=path.join(SOURCE_ROOT,'bin','recover.mjs');
  try{
    const sentinel=path.join(f.vault.root,'preserved.txt');await fs.writeFile(sentinel,'must stay unchanged');
    for(const command of [`Get-ChildItem '${f.workspace}' | Select-Object -First 3`,`Get-Acl '${f.vault.root}' | Format-List`]){
      const outcome=await f.run('pwsh',{command,description:'safe spaced read-only pipeline'});assert.equal(outcome.isError,false,text(outcome));assert.equal(outcome.value.exitCode,0,text(outcome));
    }
    const list=await f.run('pwsh',{command:`node '${cli}' list`,description:'read-only recovery listing'});assert.equal(list.isError,false,text(list));assert(Array.isArray(JSON.parse(list.value.stdout.text)));
    const doctor=await f.run('pwsh',{command:`& 'D:/dsh-recovery-tests/never-installed-node/node.exe' '${cli}' doctor`,description:'brokered diagnostic marker, no executable is launched'});
    assert.equal(doctor.isError,false,text(doctor));assert.equal(JSON.parse(doctor.value.stdout.text).version,JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version);
    assert.equal((await f.run('recovery_status',{})).value.lastCheckpoint,null);
    for(const command of [`node '${cli}' restore fake-id`,`node '${cli}' backup-apps`,`node '${cli}' list --vault D:/other`,`node '${cli}' doctor; Set-Content '${sentinel}' 'bad'`,`Get-Item '${sentinel}' | Out-File '${sentinel}'`]){
      const denied=await f.run('pwsh',{command,description:'diagnostic capability must not authorize mutation'});assert.equal(denied.isError,true,text(denied));
    }
    assert.equal(await fs.readFile(sentinel,'utf8'),'must stay unchanged');
  }finally{await f.ctx.fiber.dispose();}
});
test('real sandbox: alias-named files work and an imported recovery library refuses agent restoration before writing',async()=>{
  const f=await setup();
  try{
    const directory=path.join(f.workspace,'.rd-v012-sample');await fs.mkdir(directory);const source=path.join(directory,'del.txt');await fs.writeFile(source,'alias path original');
    const attribute=await f.run('pwsh',{command:"Set-ItemProperty -LiteralPath '.rd-v012-sample/del.txt' -Name IsReadOnly -Value $true",description:'ordinary attribute edit of alias-named fixture'});assert.equal(attribute.isError,false,text(attribute));assert.equal(attribute.value.exitCode,0,text(attribute));assert.equal((await fs.stat(source)).mode&0o200,0);
    const snapshot=await f.vault.snapshot(source);const destination=path.join(f.workspace,'must-not-restore.txt');
    const moduleUrl=new URL('../lib/vault.js',import.meta.url).href;
    const worker=path.join(f.workspace,'.rd-v012-probe.mjs');
    await fs.writeFile(worker,`import {Vault} from ${JSON.stringify(moduleUrl)};const vault=new Vault(${JSON.stringify(f.config)});try{await vault.restore(${JSON.stringify(snapshot.id)},{destination:${JSON.stringify(destination)}});process.stdout.write('unexpected success');process.exitCode=1;}catch(error){process.stdout.write(JSON.stringify({code:error.code,message:error.message,context:process.env.RECOVERABLE_DELETE_CONTEXT}));}`);
    const outcome=await f.run('pwsh',{command:`& '${process.execPath}' '.rd-v012-probe.mjs'`,description:'sandboxed imported recovery library regression'});
    assert.equal(outcome.isError,false,text(outcome));assert.equal(outcome.value.exitCode,0,text(outcome));const denial=JSON.parse(outcome.value.stdout.text.trim());assert.equal(denial.code,'RECOVERY_HUMAN_REQUIRED');assert.equal(denial.context,'agent');await assert.rejects(fs.stat(destination),{code:'ENOENT'});
    const human=await f.vault.restore(snapshot.id,{destination});assert.equal(human.status,'restored');assert.equal(human.audit.state,'complete');assert.equal(await fs.readFile(destination,'utf8'),'alias path original');
    const events=(await fs.readFile(path.join(f.vault.root,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert(events.some(e=>e.event==='restored'&&e.destination===destination));
  }finally{await f.ctx.fiber.dispose();}
});
test('real Harness rejects CMD slash-switch deletion without snapshots or moves and explains the human menu',async()=>{
  const f=await setup();
  try{
    const target=path.join(f.workspace,'keep-directory');await fs.mkdir(target);const file=path.join(target,'keep.txt');await fs.writeFile(file,'must stay');
    const before=await f.vault.list(50);
    for(const command of [`rd /s /q '${target}'`,`rmdir '${target}' /s /q`,`del /f /q '${file}'`]){
      const denied=await f.run('pwsh',{command,description:'slash flags must be rejected before a target is resolved'});
      assert.equal(denied.isError,true,text(denied));assert.match(text(denied),/CMD-style slash switches/);assert.doesNotMatch(text(denied),/does not exist/);
    }
    assert.equal(await fs.readFile(file,'utf8'),'must stay');assert.deepEqual(await f.vault.list(50),before);
    const menu=await f.run('pwsh',{command:`& '${path.join(SOURCE_ROOT,'DSH-Recovery.cmd')}'`,description:'explain why human recovery entry cannot be started by the agent'});
    assert.equal(menu.isError,true,text(menu));assert.match(text(menu),/资源管理器/);assert.match(text(menu),/桌面/);
    const removed=await f.run('recoverable_delete',{paths:[target]});assert.equal(removed.isError,false,text(removed));const entry=removed.value.entries[0];assert(['recycled','quarantined'].includes(entry.status));
    const restored=await f.vault.restore(entry.id);assert.equal(restored.audit.state,'complete');assert.equal(await fs.readFile(file,'utf8'),'must stay');
  }finally{await f.ctx.fiber.dispose();}
});
