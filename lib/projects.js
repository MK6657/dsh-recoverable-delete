import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Vault,atomicJson,selectManifest} from './vault.js';
import {assertMutable,assertNoLinks,within,PROJECT_VAULT,restorePathConflict} from './policy.js';
import {assertHumanRecoveryContext} from './execution-context.js';

const key=value=>crypto.createHash('sha256').update(value.toLowerCase()).digest('hex');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=async file=>{try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const manifestDigest=m=>{
  // State transitions and move receipts are mutable; task, source and object
  // references are not. Authorize the verified preimage before any batch move.
  const {status,recycleError,quarantine,error,...immutable}=m;
  return crypto.createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
};
export class ProjectRecovery {
  constructor(config,control,{prepare=async()=>{},protect=async()=>{}}={}) {
    this.config=config;this.control=control;this.prepare=prepare;this.protect=protect;this.opened=new Map();this.shellTemps=new Map();
  }
  async task(exec,workspace,{register=true}={}) {
    const header=exec.agent?.session?.header;
    if(typeof header?.id!=='string'||!header.id) throw new Error('A persistent host session identity is required.');
    const file=path.join(this.control.root,'state','tasks',key(header.id)+'.json');
    let prior;try{prior=await read(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(prior){if(prior.workspace!==workspace||prior.session!==header.id||prior.parent!==(header.parentSession??null))throw new Error('Task identity or workspace changed; automatic recovery is paused.');return prior.scope;}
    let scope=header.id;
    if(header.parentSession){
      let parent;try{parent=await read(path.join(this.control.root,'state','tasks',key(header.parentSession)+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(parent?.workspace===workspace)scope=parent.scope;
    }
    if(register)await atomicJson(file,{session:header.id,parent:header.parentSession??null,workspace,scope});return scope;
  }
  async inspect(workspace) {
    workspace=path.resolve(workspace);
    const root=path.join(workspace,PROJECT_VAULT),catalog=path.join(this.control.root,'state','projects',key(workspace)+'.json');
    assertNoLinks(this.control.root);assertNoLinks(root);
    let record;try{record=await read(catalog);}catch(e){if(e.code==='ENOENT')return {project:null,state:await exists(root)?'unregistered':'absent'};throw e;}
    if(record.workspace!==workspace||record.vaultRoot!==root)throw new Error('Project catalog location mismatch.');
    if(record.state!=='ready')return {project:null,state:'initializing'};
    if(!await exists(root))return {project:null,state:'missing'};
    const marker=await read(path.join(root,'project.json'));
    if(marker.projectId!==record.projectId||marker.workspace!==workspace)throw new Error('Project recovery marker mismatch.');
    for(const name of ['entries','objects','state']){
      const directory=path.join(root,name);assertNoLinks(directory);
      if(!await exists(directory)||!(await fs.lstat(directory)).isDirectory())return {project:null,state:'incomplete'};
    }
    return {project:{workspace,root,record,vault:new Vault({...this.config,vaultRoot:root})},state:'ready'};
  }
  async query(exec,workspace,limit=30) {
    const base={boundWorkspace:workspace,expectedProjectVault:path.join(workspace,PROJECT_VAULT),projectVault:null,projectVaultState:'absent',recentSource:'project',recent:[]};
    try{
      // Queries must not create task registrations, change ACLs, run canaries,
      // or depend on this process having opened the project for a mutation.
      const owner=await this.task(exec,workspace,{register:false});
      const found=await this.inspect(workspace);
      return {...base,projectVault:found.project?.root??null,projectVaultState:found.state,recent:found.project?(await this.list(found.project,owner,limit)).map(e=>({...e,vaultRoot:found.project.root})):[]};
    }catch(error){return {...base,projectVaultState:'unavailable',projectVaultError:String(error.message)};}
  }
  async open(workspace) {
    assertHumanRecoveryContext();workspace=path.resolve(workspace);
    assertMutable(workspace,workspace,{...this.config,allowRecoveryContainer:true});
    if(this.opened.has(workspace))return this.opened.get(workspace);
    const root=path.join(workspace,PROJECT_VAULT), catalog=path.join(this.control.root,'state','projects',key(workspace)+'.json');
    let record;try{record=await read(catalog);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!record){
      if(await exists(root))throw new Error('An unregistered .dsh-recovery directory already exists; human inspection required.');
      record={version:1,projectId:crypto.randomUUID(),workspace,vaultRoot:root,state:'preparing'};
      await atomicJson(catalog,record);
    }
    if(record.workspace!==workspace||record.vaultRoot!==root)throw new Error('Project catalog location mismatch.');
    assertNoLinks(root);await this.prepare(workspace);await fs.mkdir(root,{recursive:true,mode:0o700});
    const marker=path.join(root,'project.json');
    if(await exists(marker)){
      const value=await read(marker);if(value.projectId!==record.projectId||value.workspace!==workspace)throw new Error('Project recovery marker mismatch.');
    }else{
      if(record.state!=='preparing'||(await fs.readdir(root)).length)throw new Error('Unrecognized project recovery contents.');
      await atomicJson(marker,{version:1,projectId:record.projectId,workspace});
    }
    await this.protect(workspace,root);
    const vault=new Vault({...this.config,vaultRoot:root,protectedRoots:[this.control.root,...(this.config.protectedRoots??[])],maxStoredBytes:this.config.maxProjectStoredBytes??2*1024**3});
    vault.charge=(owner,manifests)=>this.control.charge(owner,manifests);
    await vault.init();await fs.writeFile(path.join(root,'.gitignore'),'*\n');record.state='ready';await atomicJson(catalog,record);
    const value={workspace,root,vault,record};this.opened.set(workspace,value);return value;
  }
  async remember(project,m) {
    if(!m)return;
    await atomicJson(path.join(this.control.root,'state','project-entries',m.id+'.json'),{workspace:project.workspace,vaultRoot:project.root,id:m.id,owner:m.owner,digest:manifestDigest(m)});
  }
  async snapshot(project,target,{owner,reason,kind='pre-mutation',signal,cacheAllowed=false}={}) {
    if(!within(project.workspace,target))throw new Error('Project backups require an in-workspace target.');
    const exclusions=[project.root];
    if(kind==='workspace-checkpoint'){
      let registrations=[];try{registrations=await fs.readdir(path.join(this.control.root,'state','disposable'));}catch(e){if(e.code!=='ENOENT')throw e;}
      for(const name of registrations.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const r=await read(path.join(this.control.root,'state','disposable',name));if(r.owner===owner&&r.workspace===project.workspace&&within(path.join(project.workspace,'.dsh-test-tmp'),r.directory))exclusions.push(r.directory);}
    }
    const m=await project.vault.snapshot(target,{kind,owner,reason,workspace:project.workspace,signal,cacheAllowed,exclusions:kind==='workspace-checkpoint'?exclusions:[]});
    await this.remember(project,m);return m;
  }
  async temp(project,owner,reason) {
    if(typeof reason!=='string'||!reason.trim())throw new Error('Explain the disposable test directory purpose.');
    const parent=path.join(project.workspace,'.dsh-test-tmp');assertNoLinks(parent);await fs.mkdir(parent,{recursive:true});
    const directory=await fs.mkdtemp(path.join(parent,'task-'));
    const id=key(directory);
    await atomicJson(path.join(this.control.root,'state','disposable',id+'.json'),{directory,workspace:project.workspace,owner,reason,createdAt:new Date().toISOString()});
    await project.vault.audit('disposable-created',{directory,owner,reason});
    return {directory,backupPolicy:'recycle-only',warning:'Only disposable test output belongs here. Use recoverable_delete for cleanup; Recycle Bin restoration is manual.'};
  }
  async disposable(project,target,owner) {
    const parent=path.join(project.workspace,'.dsh-test-tmp');if(!within(parent,target)||target===parent)return false;
    const first=path.relative(parent,target).split(path.sep)[0], directory=path.join(parent,first);
    try{const record=await read(path.join(this.control.root,'state','disposable',key(directory)+'.json'));return record.owner===owner&&record.workspace===project.workspace&&record.directory===directory;}catch(e){if(e.code==='ENOENT')return false;throw e;}
  }
  async shellTemp(project,owner){
    const id=project.workspace+'|'+owner;let directory=this.shellTemps.get(id);
    if(!directory||!await exists(directory)){directory=(await this.temp(project,owner,'Sandbox Python test temporary output')).directory;this.shellTemps.set(id,directory);}
    assertNoLinks(directory);return directory;
  }
  async remove(project,paths,{owner,reason,signal,destination='recycle'}={}) {
    if(!['recycle','quarantine'].includes(destination))throw new Error('Unsupported deletion destination.');
    for(const target of paths){assertMutable(target,project.workspace,{...this.config,vaultRoot:project.root});if(!within(project.workspace,target))throw new Error('Project deletion must stay in the current workspace.');}
    const disposable=await Promise.all(paths.map(p=>this.disposable(project,p,owner)));
    // Mixed batches use verified backups for every item; there is no partial
    // exemption that could move one target before validating the others.
    if(destination==='recycle'&&disposable.every(Boolean)){
      if(process.platform!=='win32')throw new Error('Recycle-only test cleanup requires the Windows Recycle Bin.');
      if(new Set(paths).size!==paths.length)throw new Error('Duplicate test cleanup target.');
      for(const a of paths)for(const b of paths)if(a!==b&&(within(a,b)||within(b,a)))throw new Error('Overlapping test cleanup targets.');
      const records=[];
      for(const target of paths){
        const collected=await project.vault.collect(target,signal);
        const id=`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,8)}`;
        const m={version:1,id,kind:'disposable-test',owner,workspace:project.workspace,reason,original:target,at:new Date().toISOString(),status:'recycle-pending',backupMode:'recycle-only',entries:collected.entries,bytes:collected.bytes};
        await atomicJson(path.join(project.root,'entries',id,'manifest.json'),m);records.push(m);
      }
      await this.control.charge(owner,records);
      const outcomes=[];
      for(const m of records){
        signal?.throwIfAborted();const current=await project.vault.collect(m.original,signal);
        if(JSON.stringify(current.entries)!==JSON.stringify(m.entries))throw new Error('Disposable test target changed; retained.');
        const file=path.join(project.root,'entries',m.id,'manifest.json');
        try{await project.vault.recycle(m.original,file);if(await exists(m.original))throw new Error('Recycle helper retained the test source.');m.status='recycled-no-backup';}
        catch(e){m.status=await exists(m.original)?'retained':'recycle-outcome-uncertain';m.error=String(e.message);await atomicJson(file,m);await project.vault.audit(m.status,{id:m.id,original:m.original});throw new Error('Test cleanup did not complete reliably; no permanent-delete fallback was attempted.');}
        await atomicJson(file,m);await project.vault.audit(m.status,{id:m.id,original:m.original,reason,owner});await this.remember(project,m);
        outcomes.push({id:m.id,original:m.original,status:m.status,files:m.entries.length,bytes:m.bytes,backupMode:'recycle-only'});
      }
      return outcomes;
    }
    const prepared=[];let results;
    try{results=await project.vault.remove(paths,{workspace:project.workspace,owner,reason,signal,destination,onRecord:async m=>{await this.remember(project,m);prepared.push({id:m.id,original:m.original});}});}
    catch(error){
      const absent=[];for(const record of prepared)if(!await exists(record.original))absent.push(record.id);
      if(absent.length)throw new Error(`${error.message} Some verified-backup targets are no longer at their original paths. Recovery IDs: ${absent.join(', ')}. Check recovery_list before retrying.`,{cause:error});
      throw error;
    }
    for(const result of results)await this.remember(project,await read(path.join(project.root,'entries',result.id,'manifest.json')));
    return results;
  }
  async list(project,owner,limit=30) {
    const entries=await project.vault.list(100000,{readOnly:true});const result=[];
    for(const e of entries){const m=await read(path.join(project.root,'entries',e.id,'manifest.json'));if(m.owner===owner){result.push({...e,reason:m.reason,backupMode:m.backupMode??'verified-copy'});if(result.length>=limit)break;}}
    const selected=new Set(result.map(e=>e.id)),latest=new Map();
    const receiptRoot=path.join(project.root,'state','restore-transactions');
    let names=[];try{names=await fs.readdir(receiptRoot);}catch(e){if(e.code!=='ENOENT')throw e;}
    let unreadable=0;
    for(const name of names.filter(n=>/^[a-zA-Z0-9-]+\.json$/.test(n))){
      let receipt;try{receipt=await read(path.join(receiptRoot,name));}catch{unreadable++;continue;}
      if(!selected.has(receipt.snapshotId))continue;
      const at=receipt.completedAt??receipt.reconciledAt??receipt.failedAt??receipt.at;
      if(typeof receipt.transactionId!=='string'||name!==receipt.transactionId+'.json'||typeof receipt.destination!=='string'||!path.isAbsolute(receipt.destination)||!Number.isFinite(Date.parse(at))||!['prepared','complete','restored-audit-pending','failed','published-incomplete'].includes(receipt.state)||(receipt.targetPublished!==undefined&&receipt.targetPublished!==null&&typeof receipt.targetPublished!=='boolean')||(receipt.stagingPath!==undefined&&(typeof receipt.stagingPath!=='string'||!path.isAbsolute(receipt.stagingPath)||path.dirname(receipt.stagingPath)!==path.dirname(receipt.destination)||!/^\.dsh-restore-[a-f0-9-]+$/.test(path.basename(receipt.stagingPath))))){unreadable++;continue;}
      const previous=latest.get(receipt.snapshotId);
      if(previous&&(Date.parse(previous.at)>Date.parse(at)||(Date.parse(previous.at)===Date.parse(at)&&previous.audit.transactionId>receipt.transactionId)))continue;
      latest.set(receipt.snapshotId,{
        at,destination:receipt.destination,relativePath:receipt.relative??null,relative_path:receipt.relative??null,
        status:receipt.state==='complete'?'restored':receipt.state==='restored-audit-pending'?'restored-audit-pending':receipt.state==='failed'?'failed':'incomplete',
        phase:receipt.phase??null,stagingPath:receipt.stagingPath??null,targetPublished:receipt.targetPublished??(receipt.state==='complete'?true:null),error:receipt.error??null,errorCode:receipt.errorCode??null,
        audit:{state:receipt.state==='complete'?'complete':receipt.state==='restored-audit-pending'?'pending':'incomplete',transactionId:receipt.transactionId,receiptPath:path.join(receiptRoot,name)}
      });
    }
    for(const entry of result){
      entry.lastRestore=latest.get(entry.id)??null;
      entry.restoreDestination=entry.lastRestore?.destination??null;
      entry.audit=entry.lastRestore?.audit??null;
      entry.restoreQuery={state:unreadable?'partial':'complete',unreadableReceipts:unreadable};
      entry.receiptIndex={state:unreadable?'partial':'readable',unreadableReceipts:unreadable};
    }
    return result;
  }
  async restore(project,owner,{id,relative_path:relative,reason},signal) {
    assertHumanRecoveryContext();signal?.throwIfAborted();
    if(!/^[a-zA-Z0-9-]+$/.test(id??'')||typeof reason!=='string'||!reason.trim())throw new Error('A recovery ID and reason are required.');
    const authorization=await read(path.join(this.control.root,'state','project-entries',id+'.json'));
    if(authorization.workspace!==project.workspace||authorization.vaultRoot!==project.root||authorization.owner!==owner)throw new Error('Automatic restore is limited to this task and workspace.');
    const m=await read(path.join(project.root,'entries',id,'manifest.json'));
    if(m.owner!==owner||m.workspace!==project.workspace||manifestDigest(m)!==authorization.digest)throw new Error('Recovery metadata integrity or ownership mismatch.');
    if(m.backupMode==='recycle-only')throw new Error('This disposable test record has no backup copy; recreate it or restore manually from the Recycle Bin.');
    if(m.kind==='workspace-checkpoint'&&!relative)throw new Error('Choose a specific relative_path from the checkpoint; whole-project automatic rollback is not allowed.');
    const selected=selectManifest(m,relative);
    assertMutable(selected.original,project.workspace,{...this.config,vaultRoot:project.root});
    if(!within(project.workspace,selected.original)||selected.original===project.workspace||selected.entries.some(e=>e.type==='link'))throw new Error('Automatic recovery must select ordinary files inside the original workspace, without links.');
    const ledgerFile=path.join(this.control.root,'state','restore-budgets',key(owner+'|'+id+'|'+(relative??''))+'.json');
    let ledger;try{ledger=await read(ledgerFile);}catch(e){if(e.code!=='ENOENT')throw e;}
    const now=Date.now();if(!ledger||now-ledger.since>30*60*1000)ledger={since:now,count:0};
    if(ledger.count>=3)throw new Error('Repeated restore limit reached. Stop the delete/restore loop and ask the human to inspect.');
    const previousAttempts=ledger.count;
    let destination=selected.original,conflictCopy=false;
    const conflict=restorePathConflict(destination);
    if(conflict){
      conflictCopy=true;const parent=path.join(project.workspace,'.dsh-recovered',id);assertNoLinks(parent);
      destination=path.join(parent,`${path.basename(selected.original)}-${crypto.randomUUID().slice(0,8)}`);
    }
    assertMutable(destination,project.workspace,{...this.config,vaultRoot:project.root});
    ledger.count++;await atomicJson(ledgerFile,ledger);
    await project.vault.audit('automatic-restore-requested',{id,owner,reason,relative,destination,conflictCopy});
    const result=await project.vault.restore(id,{destination,relative});
    const repeatWarning=previousAttempts?'This record/selection already had a restore attempt in the current 30-minute window. Check recovery_list and existing recovered copies before restoring again.':'';
    const warning=[result.warning,repeatWarning].filter(Boolean).join(' ');
    return {...result,conflictCopy,conflictReason:conflict?.kind??null,original:selected.original,previousAttempts,...(warning?{warning}:{}),...(conflictCopy?{nextStep:'Existing target or parent-file conflict was preserved. Compare the recovered copy before editing.'}:{})};
  }
}

export async function registeredVaults(control) {
  const stores=[control];
  let projects;try{projects=await fs.readdir(path.join(control.root,'state','projects'));}catch(e){if(e.code==='ENOENT')return stores;throw e;}
  for(const name of projects.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
    const record=await read(path.join(control.root,'state','projects',name));
    if(record.state!=='ready'||record.vaultRoot!==path.join(record.workspace,PROJECT_VAULT))continue;
    assertNoLinks(record.vaultRoot);
    if(await exists(record.vaultRoot))stores.push(new Vault({...control.config,vaultRoot:record.vaultRoot}));
  }
  return stores;
}
export async function catalogEntries(control,limit=100) {
  const entries=[];
  for(const store of await registeredVaults(control))for(const e of await store.list(limit))entries.push({...e,vaultRoot:store.root});
  return entries.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
}
