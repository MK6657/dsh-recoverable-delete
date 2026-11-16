import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { assess, ownerFor, assertMutable, SOURCE_ROOT,workspaceFor } from './policy.js';
import { Vault, atomicJson } from './vault.js';
import {ProjectRecovery} from './projects.js';

export const name = 'recoverable-delete';
export const inject = ['tools'];
const HOST_ROOT = 'D:/DeepSeek_dsh_win/resources/app/dsh';
const storage = new AsyncLocalStorage();
const WRAPPED = Symbol.for('dsh-recoverable-delete.shell');
const SANDBOX_WRAPPED = Symbol.for('dsh-recoverable-delete.sandbox');
const VERSION = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT,'package.json'),'utf8')).version;
function result(value, text, isError = false) {
  return { value, content:[{type:'text',text}], isError, ...(isError?{error:{message:text}}:{}) };
}
function shellResult(exec, value, text) {
  if (!['pwsh','bash'].includes(exec.name)) return result(value,text);
  return result({kind:'foreground',cwd:value.cwd,exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:exec.arguments?.timeout??120000,stdout:{text,truncated:false},stderr:{text:'',truncated:false}},text);
}
function compatibility(config) {
  const root = config.hostRoot ?? HOST_ROOT;
  const versions=['dsh-tools','dsh-shell','dsh-fs','dsh-user-approval'].map(n=>JSON.parse(fs.readFileSync(path.join(root,'node_modules/@deepseek-ai',n,'package.json'),'utf8')).version);
  if(versions.some(v=>v!=='0.2.2-rc.3')) throw new Error(`Unvalidated Harness package versions: ${versions.join(', ')}`);
  const pipeline=fs.readFileSync(path.join(root,'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js'),'utf8');
  if(!pipeline.includes('this.tools.checkGuards(exec)')) throw new Error('The native monotonic tool guard is missing.');
  return versions[0];
}
function tool(name, description, parameters, execute) {
  return {name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},execute};
}
export async function apply(ctx, supplied = {}) {
  const config={vaultRoot:'D:/dsh-recovery-vault',checkpointWorkspace:true,confineShell:true,defaultDestination:'recycle',projectRecovery:true,...supplied};
  const vault=new Vault(config);
  const sourceFingerprint=crypto.createHash('sha256');
  for(const file of ['package.json','lib/index.js','lib/policy.js','lib/vault.js','lib/projects.js','lib/execution-context.js','python-compat/sitecustomize.py','scripts/protect-project-vault.ps1'])sourceFingerprint.update(fs.readFileSync(path.join(SOURCE_ROOT,file)));
  const state={version:VERSION,hostVersion:null,active:false,shellConfinement:'waiting',startupError:null,lastCheckpoint:null,projectRecovery:config.projectRecovery,automaticRestore:config.projectRecovery,sourceRoot:SOURCE_ROOT,vaultRoot:vault.root,defaultDestination:config.defaultDestination,sourceFingerprint:sourceFingerprint.digest('hex'),hostNodeVersion:process.version,hostNodeExecutable:process.execPath};
  try { state.hostVersion=compatibility(config); state.active=true; } catch(error) { state.startupError=String(error.message); }
  const deny = error => `[recoverable-delete] ${error.message??error} Operation stopped. Use recoverable_delete with exact paths; do not bypass this protection.`;
  const status = () => ({...state});
  const preparedWorkspaces=new Set();
  async function prepareWorkspace(workspace) {
    if(process.platform!=='win32'||preparedWorkspaces.has(workspace)||!config.confineShell) return;
    assertMutable(workspace,workspace,{...config,allowRecoveryContainer:true});
    await vault.init();
    const aclEvidence=path.join(vault.root,'state',`workspace-acl-${crypto.createHash('sha256').update(workspace.toLowerCase()).digest('hex')}.json`);
    const evidence=await new Promise((resolve,reject)=>{
      const env={...process.env,PSModulePath:[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';')};
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(SOURCE_ROOT,'scripts/prepare-workspace.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
      let output='',error=''; child.stdout.on('data',c=>{output+=c.toString();});child.stderr.on('data',c=>{error+=c.toString();});
      child.on('error',reject);child.on('close',code=>{if(code!==0)reject(new Error(error||'Workspace permission preparation failed'));else{try{resolve(JSON.parse(output));}catch(e){reject(e);}}});
      child.stdin.end(JSON.stringify({path:workspace,evidencePath:aclEvidence}));
    });
    if(!fs.existsSync(aclEvidence)) await atomicJson(aclEvidence,evidence);
    preparedWorkspaces.add(workspace);
  }
  let supervisedService;
  const projects=new ProjectRecovery(config,vault,{prepare:prepareWorkspace,protect:async(workspace,root)=>{
    if(process.platform!=='win32'||!config.confineShell)throw new Error('Protected project recovery requires the validated Windows sandbox.');
    const host=config.hostRoot??HOST_ROOT;
    const {workspaceWriteSid}=await import(pathToFileURL(path.join(host,'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js')).href);
    const {canonicalPath}=await import(pathToFileURL(path.join(host,'node_modules/@deepseek-ai/dsh-sandbox/lib/index.js')).href);
    const evidence=await new Promise((resolve,reject)=>{
      const env={...process.env,PSModulePath:[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';')};
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(SOURCE_ROOT,'scripts/protect-project-vault.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
      let output='',error='';child.stdout.on('data',c=>{output+=c.toString();});child.stderr.on('data',c=>{error+=c.toString();});child.on('error',reject);
      child.on('close',code=>{if(code!==0)reject(new Error(error||'Project vault ACL protection failed'));else{try{resolve(JSON.parse(output));}catch(e){reject(e);}}});
      child.stdin.end(JSON.stringify({workspace,vault:root,writeSid:workspaceWriteSid(canonicalPath(workspace))}));
    });
    const aclFile=path.join(vault.root,'state','project-acl-'+crypto.createHash('sha256').update(workspace.toLowerCase()).digest('hex')+'.json');
    if(!fs.existsSync(aclFile))await atomicJson(aclFile,evidence);
    if(!supervisedService)throw new Error('The supervised shell is not ready.');
    const canary=path.join(root,'protection-canary.txt');await fsp.writeFile(canary,'protected-project-vault');
    const command=`Set-Content -LiteralPath '${canary.replaceAll("'","''")}' -Value 'must-be-denied' -ErrorAction SilentlyContinue; Write-Output 'vault-probe'`;
    await storage.run({workspace,sessionId:`project-probe-${process.pid}`},async()=>{
      const proc=await supervisedService.execute(supervisedService.resolve({command,workdir:workspace,timeoutMs:15000,onExpiry:'kill'}));await proc.result();
    });
    if(await fsp.readFile(canary,'utf8')!=='protected-project-vault')throw new Error('Project vault write-denial probe failed; project commands are paused.');
  }});
  if(state.active && config.confineShell) {
    try {
      const {Context}=await import(pathToFileURL(path.join(config.hostRoot??HOST_ROOT,'node_modules/@deepseek-ai/cordis/lib/index.js')).href);
      const official=await import('./vendor/sandbox-local.js');
      const privateContext=new Context();
      await privateContext.plugin(official.default).await();
      ctx.inject(['sandbox'],scope=>{
        const service=scope.sandbox;
        if(service[SANDBOX_WRAPPED]) return;
        const original=service.confine;
        const wrapper=function(argv,policy,signal){
          return storage.getStore() ? privateContext.sandbox.confine(argv,policy,signal) : original.call(this,argv,policy,signal);
        };
        const record={original,wrapper}; service.confine=wrapper; service[SANDBOX_WRAPPED]=record;
        scope.on('dispose',()=>{if(service[SANDBOX_WRAPPED]===record){service.confine=original;delete service[SANDBOX_WRAPPED];}});
      });
      ctx.on('dispose',()=>privateContext.fiber.dispose());
      state.sandboxProvider='official-private-0.2.2-rc.3';
      state.sandboxEnforcement='Windows ACL partial; independently tested outside-write denial';
    } catch(error) { state.startupError=`Private sandbox unavailable: ${error.message}`; state.active=false; }
  }
  const assessCall=exec=>{
    const plan=assess(exec,config);
    if(plan.kind!=='pass' && plan.kind!=='recovery-query' && state.startupError) throw new Error(state.startupError);
    if(plan.kind==='run' && config.confineShell && state.shellConfinement!=='active') throw new Error('The supervised shell is unavailable; writes are paused.');
    return plan;
  };
  const readQuery=async(exec,limit)=>{
    const workspace=exec?workspaceFor(exec):null;
    if(config.projectRecovery){
      if(!workspace)return {boundWorkspace:null,projectVault:null,projectVaultState:'unscoped',recentSource:'project',recent:[]};
      return projects.query(exec,workspace,limit);
    }
    return {boundWorkspace:workspace,projectVault:null,projectVaultState:'disabled',recentSource:'legacy-global',recent:(await vault.list(limit,{readOnly:true})).map(e=>({...e,vaultRoot:vault.root}))};
  };
  ctx.tools.guard(exec=>{
    try { assessCall(exec); }
    catch(error) { void vault.audit('blocked',{tool:exec.name,reason:String(error.message)}).catch(()=>{}); return deny(error); }
  });
  // All presets, including Full access and inherited subagents, use this path.
  // It never changes purge's hooks, prompts, retries, patch files or presets.
  ctx.on('tools/execute',async(exec,next)=>{
    let plan;
    try { plan=assessCall(exec); } catch(error) { return result({},deny(error),true); }
    if(plan.kind==='pass') return next();
    if(plan.kind==='recovery-query') {
      try {
        const query=await vault.serial(()=>readQuery(exec,50));
        const value=plan.action==='list'?query.recent:{...status(),...query,pid:process.pid,reportedAt:new Date().toISOString()};
        return shellResult(exec,{cwd:plan.cwd},JSON.stringify(value,null,2));
      } catch(error) { return result({},deny(error),true); }
    }
    if(plan.kind==='recovery_list'){
      try{const query=await vault.serial(()=>readQuery(exec,50));return result(query,JSON.stringify(query,null,2));}
      catch(error){return result({},deny(error),true);}
    }
    return vault.serial(async()=>{
      try {
        exec.signal?.throwIfAborted();
        const wantsProject=config.projectRecovery&&(plan.kind!=='run'||plan.checkpoint);
        const project=wantsProject?await projects.open(plan.workspace):undefined;
        const owner=project?await projects.task(exec,plan.workspace):ownerFor(exec);
        const reason=String(exec.arguments?.reason??exec.arguments?.description??`${exec.name} file operation`).slice(0,2000);
        const tempRoot=project&&plan.kind==='run'?await projects.shellTemp(project,owner):undefined;
        if(plan.kind==='recoverable_restore'){
          if(!project)throw new Error('Automatic project restoration is disabled.');
          const restored=await projects.restore(project,owner,exec.arguments,exec.signal);
          return result(restored,JSON.stringify(restored,null,2));
        }
        if(plan.kind==='recovery_create_temp'){
          if(!project)throw new Error('Disposable project directories are disabled.');
          const temp=await projects.temp(project,owner,exec.arguments?.reason);return result(temp,JSON.stringify(temp,null,2));
        }
        if(plan.kind==='delete') {
          // Already inside the serial queue: use a separate queue only for the
          // removal transaction so remove() cannot wait behind itself.
          const deletionVault=new Vault(config); deletionVault.cache=vault.cache;
          const entries=project?await projects.remove(project,plan.paths,{owner,reason,signal:exec.signal,destination:exec.arguments?.destination??config.defaultDestination}):await deletionVault.remove(plan.paths,{workspace:plan.workspace,owner,reason,signal:exec.signal,destination:exec.arguments?.destination??config.defaultDestination});
          const text=`Recoverable deletion completed. ${entries.some(e=>e.backupMode==='recycle-only')?'Disposable test output is in the Recycle Bin only; no content backup was stored.':'Verified backup copies are retained.'} Recovery IDs: ${entries.map(e=>e.id).join(', ')}`;
          return shellResult(exec,{cwd:plan.cwd,entries},text);
        }
        if(plan.kind==='mutate') {
          const snapshots=[];
          for(const target of plan.paths) { const snap=project?await projects.snapshot(project,target,{owner,reason,signal:exec.signal}):await vault.snapshot(target,{owner,reason,signal:exec.signal}); if(snap) snapshots.push(snap); }
          if(plan.deletions) await vault.charge(owner,snapshots);
          const outcome=await next();
          await vault.audit('native-mutation',{tool:exec.name,recoveryIds:snapshots.map(s=>s.id),isError:outcome.isError===true});
          return outcome;
        }
        if(plan.checkpoint && config.checkpointWorkspace) {
          assertMutable(plan.workspace,plan.workspace,{...config,allowRecoveryContainer:true});
          const targets=project&&plan.mutationPaths?plan.mutationPaths:[plan.workspace];
          for(const target of targets){
            const kind=project&&plan.mutationPaths?'pre-mutation':'workspace-checkpoint';
            const snapshot=project?await projects.snapshot(project,target,{kind,owner,reason,signal:exec.signal,cacheAllowed:true}):await vault.snapshot(target,{kind,owner,reason,signal:exec.signal,cacheAllowed:true});
            state.lastCheckpoint=snapshot?.id??null;
          }
        }
        await prepareWorkspace(plan.workspace);
        return await storage.run({workspace:plan.workspace,sessionId:ownerFor(exec),tempRoot},next);
      } catch(error) {
        await vault.audit('operation-stopped',{tool:exec.name,reason:String(error.message)}).catch(()=>{});
        return result({},deny(error),true);
      }
    });
  },{prepend:true});
  ctx.tools.register(tool('recoverable_delete',
    'Remove exact local files/directories with a reason. Ordinary data retains a verified backup before recycle/quarantine. Registered disposable test output is recycled WITHOUT a content copy; it must be reproducible. Never clears backups or protected app data. After a partial batch failure use recovery_list to find preserved records.',
    {type:'object',additionalProperties:false,required:['paths'],properties:{paths:{type:'array',minItems:1,maxItems:128,items:{type:'string'}},reason:{type:'string'},destination:{type:'string',enum:['quarantine','recycle']}}},
    async(args,exec)=>{
      const plan=assess({...exec,name:'recoverable_delete',arguments:args},config);
      return {entries:await vault.remove(plan.paths,{workspace:plan.workspace,owner:ownerFor(exec),signal:exec.signal,destination:args.destination})};
    }));
  ctx.tools.register(tool('recovery_status','Read protection status and this task\'s persisted project records, including immediately after restart. projectVaultState and recentSource distinguish absent/unavailable stores from legacy archives. Does not initialize a project, change ACLs or restore data.',
    {type:'object',additionalProperties:false,properties:{}},async(_args,exec)=>vault.serial(async()=>({...status(),...await readQuery(exec,10),workspaceBinding:'session-header; cwd/workdir does not rebind',storagePolicy:'targeted-before-mutation; deduplicated full-workspace fallback for unknown scripts'}))));
  const intercepted=async()=>{throw new Error('Project capability must pass through the recovery tool guard.');};
  ctx.tools.register(tool('recoverable_restore','Restore this task\'s ordinary project backup. Existing targets are preserved and a separate recovered copy is created. For workspace checkpoints supply one exact relative_path. No arbitrary destination, other-task data, links, app data, or backup clearing.',
    {type:'object',additionalProperties:false,required:['id','reason'],properties:{id:{type:'string'},reason:{type:'string'},relative_path:{type:'string'}}},intercepted));
  ctx.tools.register(tool('recovery_create_temp','Create a new disposable test-output directory for this task. Only put reproducible temporary artifacts here, never sole copies of real data or test source. recoverable_delete recycles these artifacts without a content backup.',
    {type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string'}}},intercepted));
  ctx.tools.register(tool('recovery_list','Read this task\'s project records from the same source as recovery_status. lastRestore and audit describe past restores; receiptIndex only says readable/partial and does not mean restored. Prefer relativePath in summaries; legacy aliases remain. No initialization, ACL changes or backup clearing.',{type:'object',additionalProperties:false,properties:{}},intercepted));
  // The native Windows ACL runner remains the implementation. Only model-driven
  // shell calls are narrowed, using the immutable session workspace, not workdir.
  const shellFiber=ctx.inject(['shell'],async scope=>{
    const service=scope.shell;
    supervisedService=service;
    if(service[WRAPPED]) { state.shellConfinement='active'; return; }
    if(service.sandboxMode===undefined) { state.shellConfinement='unavailable'; return; }
    const original=service.execute;
    const wrapper=async function(spec){
      const call=storage.getStore();
      if(!call || !config.confineShell) return original.call(this,spec);
      const env={...spec.env,RECOVERABLE_DELETE_CONTEXT:'agent'};
      if(call.tempRoot){
        env.DSH_RECOVERY_PY_TEMP=call.tempRoot;
        env.PYTHONPATH=[path.join(SOURCE_ROOT,'python-compat'),spec.env?.PYTHONPATH??process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      }
      // A Windows PowerShell 5 child may inherit PS7 module paths from its
      // launcher. Prefer its own built-ins without changing the host env or
      // discarding custom module paths. Otherwise Get-Acl cannot auto-load.
      if(process.platform==='win32'&&/[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(service.pwshPath??'')&&!Object.hasOwn(env,'PSModulePath')) {
        env.PSModulePath=[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules'),process.env.PSModulePath].filter(Boolean).join(';');
      }
      return original.call(this,{...spec,env,sandboxPolicy:{mode:'workspace-write',workspaceRoot:call.workspace,sessionId:call.sessionId}});
    };
    const record={original,wrapper};
    service.execute=wrapper; service[WRAPPED]=record;
    state.shellConfinement='probing';
    scope.on('dispose',()=>{ if(service[WRAPPED]===record) { service.execute=original; delete service[WRAPPED]; } state.shellConfinement='unloaded'; });
    try {
      const probeRoot=await fsp.mkdtemp('D:/dsh-recovery-tests/startup-');
      const workspace=path.join(probeRoot,'workspace');await fsp.mkdir(workspace);
      const outside=path.join(probeRoot,'outside.txt');await fsp.writeFile(outside,'unchanged');
      await prepareWorkspace(workspace);
      const command=`Set-Content -LiteralPath '${outside.replaceAll("'","''")}' -Value 'must-be-denied' -ErrorAction SilentlyContinue; Set-Content -LiteralPath 'inside.txt' -Value 'inside-ok'; Write-Output 'startup-probe'`;
      const outcome=await storage.run({workspace,sessionId:`probe-${process.pid}`},async()=>{
        const proc=await service.execute(service.resolve({command,workdir:workspace,timeoutMs:15000,onExpiry:'kill'}));
        return proc.result();
      });
      if(await fsp.readFile(outside,'utf8')!=='unchanged'||!(await fsp.readFile(path.join(workspace,'inside.txt'),'utf8')).includes('inside-ok')||outcome.sandbox?.mode!=='workspace-write') throw new Error('The native outside-write canary failed. Shell commands are paused.');
      state.startupProbe={passed:true,path:probeRoot,mode:outcome.sandbox.mode,enforcement:outcome.sandbox.enforcement,at:new Date().toISOString()};
      state.shellConfinement='active';
    } catch(error) { state.startupProbe={passed:false,error:String(error.message)};state.shellConfinement='failed'; }
  });
  if(ctx.get('shell')!==undefined) await shellFiber.await();
  ctx.inject(['systemPrompt'],scope=>scope.systemPrompt.section({
    name:'recoverable-delete:usage',order:6000,
    text:'Use recoverable_delete with exact paths and a reason. Existing project data is backed up in the protected project .dsh-recovery directory before recycle/quarantine. write/edit/apply_patch originals are backed up; unknown mutating scripts still receive deduplicated workspace checkpoints, excluding registered disposable output and recovery storage. Use recovery_list then recoverable_restore with an ID and reason to recover THIS task\'s ordinary project data; checkpoint recovery requires one relative_path. Existing targets are preserved and a separate conflict copy is returned; compare it before editing. If repeated restore is refused, stop the delete/restore loop. Use recovery_create_temp for reproducible temporary test output: its recoverable_delete cleanup uses the Recycle Bin only and has NO content backup, so regenerate it or ask the human for Bin restoration. Do not move sole copies of real data into disposable storage. These rules apply even in Full access; no arbitrary workspace-outside writes, clearing recovery storage or Recycle Bin, protected app/account/session mutations, detached terminals or permission changes. Do not bypass a refusal with another interpreter. Direct restore/reconcile CLI remains human-only; use the bounded recovery tool for automation. The human desktop menu supports historical global and registered project backups. No automated backup retirement or permanent deletion capability exists.'
  }));
  void vault.audit('plugin-loaded',status()).catch(error=>ctx.logger?.warn?.(`Recovery audit initialization failed: ${error.message}`));
  const writeStatus=()=>atomicJson(path.join(vault.root,'state','plugin-live.json'),{...status(),pid:process.pid,heartbeat:new Date().toISOString()}).catch(()=>{});
  await writeStatus();
  const heartbeat=setInterval(writeStatus,15000);heartbeat.unref();
  ctx.on('dispose',async()=>{clearInterval(heartbeat);state.active=false;await writeStatus();});
}
