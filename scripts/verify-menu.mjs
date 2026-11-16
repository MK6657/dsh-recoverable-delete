// Run the real recovery menu in an independent process using only disposable
// samples. This is a redirected-input test, not a desktop mouse acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {Vault,digest} from '../lib/vault.js';
import {catalogEntries} from '../lib/projects.js';
const sourceRoot=await fs.mkdtemp('D:/dsh-recovery-tests/menu-flow-');
const source=path.join(sourceRoot,'source');await fs.mkdir(path.join(source,'readonly'),{recursive:true});
await fs.writeFile(path.join(source,'plain.txt'),'menu recovery fixture\n');
const locked=path.join(source,'readonly','locked.bin');await fs.writeFile(locked,Buffer.alloc(80,37));await fs.chmod(locked,0o444);
const vault=new Vault({vaultRoot:'D:/dsh-recovery-vault'});
const [snapshot]=await vault.remove([source],{workspace:sourceRoot,owner:'menu-acceptance',destination:'quarantine'});
const decoySource=path.join(sourceRoot,'do-not-restore.txt');await fs.writeFile(decoySource,'unselected menu fixture\n');
const decoy=await vault.snapshot(decoySource,{kind:'human-menu-acceptance',owner:'menu-acceptance'});
const listing=await catalogEntries(vault,100);const index=listing.findIndex(entry=>entry.id===snapshot.id);if(index<0)throw new Error('Acceptance snapshot is not listed.');
if(index<1)throw new Error('Menu acceptance must select a non-first record.');
const manifest=JSON.parse(await fs.readFile(path.join(vault.root,'entries',snapshot.id,'manifest.json'),'utf8'));
const destination=path.resolve(source);
const env={...process.env};delete env.DSH_SHELL;delete env.RECOVERABLE_DELETE_CONTEXT;
env.PSModulePath=[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';');
const menuPath=path.resolve(import.meta.dirname,'recovery-menu.ps1');
const execution=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',menuPath],{windowsHide:true,encoding:'utf8',timeout:30000,env,input:`2\r\n${index+1}\r\n\r\n5\r\n0\r\n`});
if(execution.status!==0)throw new Error(`Menu process failed: ${execution.stderr}`);
if(execution.stderr||/恢复未完成|记录编号无效|恢复列表格式无效/.test(execution.stdout))throw new Error('Menu reported an error.');
const numbers=[...execution.stdout.matchAll(/^\[(\d+)\] /gm)].map(m=>Number(m[1]));
if(numbers.length!==listing.length||!numbers.every((n,i)=>n===i+1))throw new Error('Menu did not enumerate each record separately.');
if(!execution.stdout.includes('已选择记录: '+snapshot.id))throw new Error('Menu did not select the requested non-first ID.');
if(!/"status": "restored"/.test(execution.stdout)||!/"state": "complete"/.test(execution.stdout))throw new Error('Menu did not report a complete audited restore.');
for(const item of manifest.entries.filter(e=>e.type==='file')){
  const out=path.join(destination,item.relative);if(await digest(out)!==item.hash)throw new Error('Menu-restored sample hash mismatch.');
  if((item.mode&0o200)===0&&((await fs.stat(out)).mode&0o200)!==0)throw new Error('Menu-restored readonly sample became writable.');
}
const events=(await fs.readFile(path.join(vault.root,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const start=events.find(e=>e.event==='restore-started'&&e.id===snapshot.id&&path.resolve(e.destination)===path.resolve(destination));
const end=events.find(e=>e.event==='restored'&&e.transactionId===start?.transactionId);
if(!start||!end)throw new Error('Menu recovery audit is incomplete.');
if(events.some(e=>e.event==='restored'&&e.id===decoy.id))throw new Error('An unselected record was restored.');
if(await fs.readFile(decoySource,'utf8')!=='unselected menu fixture\n')throw new Error('Unselected original changed.');
const runtime=spawnSync('powershell.exe',['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],{windowsHide:true,encoding:'utf8',env});
if(runtime.status!==0||!runtime.stdout.trim().startsWith('5.1.'))throw new Error('Desktop PowerShell 5.1 was not exercised.');
const evidence={at:new Date().toISOString(),method:'independent Windows PowerShell 5.1 recovery-menu process with redirected test input; not a mouse test',menuRevision:3,menuSha256:crypto.createHash('sha256').update(await fs.readFile(menuPath)).digest('hex'),powerShellVersion:runtime.stdout.trim(),recordCount:listing.length,selectionNumber:index+1,nonFirstSelection:true,defaultDestinationAccepted:true,unselectedRecordUntouched:true,snapshotId:snapshot.id,destination,status:'restored',audit:'complete',files:2,readonlyPreserved:true,menuExitCode:execution.status,reconcileReturnedEmpty:/"transactions": \[\]/.test(execution.stdout)};
await fs.writeFile(path.resolve(import.meta.dirname,'../menu-acceptance.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
