import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { assess, ownerFor, assertMutable, SOURCE_ROOT } from './policy.js';
import { Vault, atomicJson } from './vault.js';

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
  const config={vaultRoot:'D:/dsh-recovery-vault',checkpointWorkspace:true,confineShell:true,defaultDestination:'recycle',...supplied};
  const vault=new Vault(config);
  const sourceFingerprint=crypto.createHash('sha256');
  for(const file of ['package.json','lib/index.js','lib/policy.js','lib/vault.js','lib/execution-context.js'])sourceFingerprint.update(fs.readFileSync(path.join(SOURCE_ROOT,file)));
  const state={version:VERSION,hostVersion:null,active:false,shellConfinement:'waiting',startupError:null,lastCheckpoint:null,sourceRoot:SOURCE_ROOT,vaultRoot:vault.root,defaultDestination:config.defaultDestination,sourceFingerprint:sourceFingerprint.digest('hex'),hostNodeVersion:process.version,hostNodeExecutable:process.execPath};
  try { state.hostVersion=compatibility(config); state.active=true; } catch(error) { state.startupError=String(error.message); }
  const deny = error => `[recoverable-delete] ${error.message??error} No destructive command was executed. Use recoverable_delete with exact paths; do not bypass this protection.`;
  const status = () => ({...state});
  const preparedWorkspaces=new Set();
  async function prepareWorkspace(workspace) {
    if(process.platform!=='win32'||preparedWorkspaces.has(workspace)||!config.confineShell) return;
    assertMutable(workspace,workspace,config);
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
        const value=plan.action==='list'?await vault.list(50):{...status(),pid:process.pid,reportedAt:new Date().toISOString()};
        return shellResult(exec,{cwd:plan.cwd},JSON.stringify(value,null,2));
      } catch(error) { return result({},deny(error),true); }
    }
    return vault.serial(async()=>{
      try {
        exec.signal?.throwIfAborted();
        if(plan.kind==='delete') {
          // Already inside the serial queue: use a separate queue only for the
          // removal transaction so remove() cannot wait behind itself.
          const deletionVault=new Vault(config); deletionVault.cache=vault.cache;
          const entries=await deletionVault.remove(plan.paths,{workspace:plan.workspace,owner:ownerFor(exec),signal:exec.signal,destination:exec.arguments?.destination??config.defaultDestination});
          const text=`Recoverable deletion completed. Originals are preserved in recovery storage. Recovery IDs: ${entries.map(e=>e.id).join(', ')}`;
          return shellResult(exec,{cwd:plan.cwd,entries},text);
        }
        if(plan.kind==='mutate') {
          const snapshots=[];
          for(const target of plan.paths) { const snap=await vault.snapshot(target,{owner:ownerFor(exec),signal:exec.signal}); if(snap) snapshots.push(snap); }
          if(plan.deletions) await vault.charge(ownerFor(exec),snapshots);
          const outcome=await next();
          await vault.audit('native-mutation',{tool:exec.name,recoveryIds:snapshots.map(s=>s.id),isError:outcome.isError===true});
          return outcome;
        }
        if(plan.checkpoint && config.checkpointWorkspace) {
          assertMutable(plan.workspace,plan.workspace,config);
          const snapshot=await vault.snapshot(plan.workspace,{kind:'workspace-checkpoint',owner:ownerFor(exec),signal:exec.signal,cacheAllowed:true});
          state.lastCheckpoint=snapshot?.id??null;
        }
        await prepareWorkspace(plan.workspace);
        return await storage.run({workspace:plan.workspace,sessionId:ownerFor(exec)},next);
      } catch(error) {
        await vault.audit('operation-stopped',{tool:exec.name,reason:String(error.message)}).catch(()=>{});
        return result({},deny(error),true);
      }
    });
  },{prepend:true});
  ctx.tools.register(tool('recoverable_delete',
    'Remove exact local files/directories recoverably. A verified independent backup is retained first. Windows Recycle Bin is preferred, with same-volume quarantine as fallback; quarantine can also be chosen explicitly. Never deletes protected app data. Prefer this over rm/Remove-Item or script deletion.',
    {type:'object',additionalProperties:false,required:['paths'],properties:{paths:{type:'array',minItems:1,maxItems:128,items:{type:'string'}},reason:{type:'string'},destination:{type:'string',enum:['quarantine','recycle']}}},
    async(args,exec)=>{
      const plan=assess({...exec,name:'recoverable_delete',arguments:args},config);
      return {entries:await vault.remove(plan.paths,{workspace:plan.workspace,owner:ownerFor(exec),signal:exec.signal,destination:args.destination})};
    }));
  ctx.tools.register(tool('recovery_status','Read recoverable-delete protection status and recent recovery IDs; does not expose file contents or restore data.',
    {type:'object',additionalProperties:false,properties:{}},async()=>({...status(),recent:await vault.list(10)})));
  // The native Windows ACL runner remains the implementation. Only model-driven
  // shell calls are narrowed, using the immutable session workspace, not workdir.
  const shellFiber=ctx.inject(['shell'],async scope=>{
    const service=scope.shell;
    if(service[WRAPPED]) { state.shellConfinement='active'; return; }
    if(service.sandboxMode===undefined) { state.shellConfinement='unavailable'; return; }
    const original=service.execute;
    const wrapper=async function(spec){
      const call=storage.getStore();
      if(!call || !config.confineShell) return original.call(this,spec);
      const env={...spec.env,RECOVERABLE_DELETE_CONTEXT:'agent'};
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
    text:'Use recoverable_delete for file removal. It preserves verified backups before recycling or quarantining originals. write/edit/apply_patch originals are backed up. Mutating shell calls checkpoint the workspace and run with workspace-write confinement even in Full access. Protected account/config/session data cannot be removed or overwritten by tools. Persistent unsupervised terminals, obfuscated deletion, permission changes and destructive Git cleanup are refused. If blocked, choose a recoverable operation; do not retry through another interpreter. The exact commands node D:/dsh_projects/dsh-recoverable-delete/bin/recover.mjs list and doctor are read-only diagnostic capabilities, answered by this plugin without executing the CLI. For restoration, the human uses the desktop DSH recovery menu outside the agent. restore, snapshot, backup-apps and clearing storage are not agent CLI capabilities.'
  }));
  void vault.audit('plugin-loaded',status()).catch(error=>ctx.logger?.warn?.(`Recovery audit initialization failed: ${error.message}`));
  const writeStatus=()=>atomicJson(path.join(vault.root,'state','plugin-live.json'),{...status(),pid:process.pid,heartbeat:new Date().toISOString()}).catch(()=>{});
  await writeStatus();
  const heartbeat=setInterval(writeStatus,15000);heartbeat.unref();
  ctx.on('dispose',async()=>{clearInterval(heartbeat);state.active=false;await writeStatus();});
}
