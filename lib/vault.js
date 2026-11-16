import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { assertNoLinks, assertMutable, within } from './policy.js';
import { assertHumanRecoveryContext } from './execution-context.js';

export async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function atomicJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const h = await fsp.open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(data, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
  await fsp.rename(temp, file);
}
const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function exists(file) { try { await fsp.lstat(file); return true; } catch(e) { if (e.code === 'ENOENT') return false; throw e; } }
export class Vault {
  constructor(config = {}) {
    this.config = config;
    this.root = path.resolve(config.vaultRoot ?? 'D:/dsh-recovery-vault');
    this.maxFiles = config.maxFiles ?? 100000;
    this.maxBytes = config.maxBytes ?? 5 * 1024 ** 3;
    this.cache = new Map();
    this.queue = Promise.resolve();
  }
  serial(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  async init() {
    assertNoLinks(this.root);
    for (const directory of ['entries','objects','state']) await fsp.mkdir(path.join(this.root, directory), { recursive: true, mode: 0o700 });
  }
  async audit(event, details = {}) {
    await this.init();
    await fsp.appendFile(path.join(this.root, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', { mode: 0o600 });
  }
  async collect(target, signal, allowLinks = false, exclusions = []) {
    const entries = []; let bytes = 0;
    const visit = async (current, relative) => {
      signal?.throwIfAborted();
      if(exclusions.some(root=>within(root,current))) return;
      if(relative&&path.basename(current).toLowerCase()==='.dsh-recovery') {
        if(allowLinks) return;
        throw new Error('A target containing project recovery storage cannot be removed.');
      }
      if (entries.length >= this.maxFiles) throw new Error('Recovery checkpoint file-count limit reached; nothing was deleted.');
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        if(!allowLinks) throw new Error(`Checkpoint cannot follow a link: ${current}`);
        const link=await fsp.readlink(current); let linkType='file';
        try { if((await fsp.stat(current)).isDirectory()) linkType=process.platform==='win32'?'junction':'dir'; } catch {}
        entries.push({relative,type:'link',link,linkType,size:0,mode:stat.mode,mtimeMs:stat.mtimeMs,identity:identity(stat)});
        return;
      }
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported filesystem object: ${current}`);
      bytes += stat.isFile() ? stat.size : 0;
      if (bytes > this.maxBytes) throw new Error('Recovery checkpoint size limit reached; nothing was deleted.');
      entries.push({ relative, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, identity: identity(stat) });
      if (stat.isDirectory()) for (const name of (await fsp.readdir(current)).sort()) await visit(path.join(current, name), path.join(relative, name));
    };
    await visit(target, '');
    return { entries, bytes };
  }
  async objectFor(file, item, signal, cacheAllowed) {
    signal?.throwIfAborted();
    const cached = this.cache.get(file);
    if (cacheAllowed && cached?.identity === item.identity && await exists(path.join(this.root, 'objects', cached.hash))) return cached.hash;
    const hash = await digest(file);
    const object = path.join(this.root, 'objects', hash);
    if (!await exists(object)) {
      if(this.config.maxStoredBytes!==undefined){
        let used=0;for(const name of await fsp.readdir(path.join(this.root,'objects')))used+=(await fsp.lstat(path.join(this.root,'objects',name))).size;
        if(used+item.size>this.config.maxStoredBytes)throw new Error('Project backup storage budget reached; originals were retained. No old backups were cleared.');
        const space=await fsp.statfs(this.root);
        if(space.bavail*space.bsize-item.size<(this.config.minFreeBytes??64*1024**2))throw new Error('Insufficient free disk space for a verified backup; originals were retained.');
      }
      const temp = path.join(this.root, 'objects', `${hash}.${crypto.randomUUID()}.tmp`);
      // Reserve exclusively first so cleanup can never remove an older file.
      let handle = await fsp.open(temp, 'wx', 0o600);
      let published = false;
      try {
        await handle.close(); handle = undefined;
        await fsp.copyFile(file, temp);
        // Windows CopyFile copies ReadOnly too. Change only our copy, retaining
        // the source's original mode in the manifest for restoration.
        await fsp.chmod(temp, 0o600);
        if (await digest(temp) !== hash) throw new Error('Backup verification failed; original was not removed.');
        handle = await fsp.open(temp, 'r+');
        await handle.sync(); await handle.close(); handle = undefined;
        await fsp.rename(temp, object); published = true;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!published) {
          try { await fsp.chmod(temp, 0o600); await fsp.unlink(temp); }
          catch (error) {
            if (error.code !== 'ENOENT') await this.audit('temporary-cleanup-failed', { file:path.basename(temp), code:error.code??'unknown' }).catch(() => {});
          }
        }
      }
    } else if (!cacheAllowed && await digest(object) !== hash) {
      throw new Error('Existing recovery object failed integrity verification.');
    }
    if (identity(await fsp.lstat(file)) !== item.identity || (!cacheAllowed && await digest(file) !== hash)) throw new Error('Source changed during backup; operation cancelled.');
    this.cache.set(file, { identity: item.identity, hash });
    return hash;
  }
  async snapshot(target, { kind = 'pre-mutation', owner = 'unscoped', signal, cacheAllowed = false, reason = '', workspace, exclusions = [] } = {}) {
    await this.init(); assertNoLinks(target);
    if (!await exists(target)) return undefined;
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0,8)}`;
    const entryRoot = path.join(this.root, 'entries', id);
    await fsp.mkdir(entryRoot);
    const manifest = { version:1, id, kind, owner, reason, ...(workspace?{workspace}:{}), original:target, at:new Date().toISOString(), status:'preparing', entries:[], bytes:0 };
    const manifestPath = path.join(entryRoot, 'manifest.json');
    await atomicJson(manifestPath, manifest);
    try {
      const allowLinks=kind==='workspace-checkpoint';
      const collected = await this.collect(target, signal, allowLinks, exclusions);
      manifest.bytes = collected.bytes;
      for (const item of collected.entries) {
        const file = path.join(target, item.relative);
        const hash = item.type === 'file' ? await this.objectFor(file, item, signal, cacheAllowed) : undefined;
        manifest.entries.push({ ...item, ...(hash ? { hash } : {}) });
      }
      // Check membership and identities again. Partial scans never authorize deletion.
      const after = await this.collect(target, signal, allowLinks, exclusions);
      if (JSON.stringify(after.entries) !== JSON.stringify(collected.entries)) throw new Error('Tree changed while checkpointing; operation cancelled.');
      manifest.status = 'ready';
      await atomicJson(manifestPath, manifest);
      await this.audit('snapshot-ready', { id, kind, original:target, files:manifest.entries.length, bytes:manifest.bytes });
      return manifest;
    } catch(error) {
      manifest.status = 'failed'; manifest.error = String(error.message);
      await atomicJson(manifestPath, manifest); throw error;
    }
  }
  async charge(owner, manifests) {
    const file = path.join(this.root,'state','deletion-budget.json');
    let ledger = {}; try { ledger = JSON.parse(await fsp.readFile(file,'utf8')); } catch(error) { if (error.code !== 'ENOENT') throw error; }
    const key = crypto.createHash('sha256').update(owner).digest('hex');
    const day = new Date().toISOString().slice(0,10);
    const prior = ledger[key]?.day === day ? ledger[key] : { day, files:0, bytes:0 };
    const files = manifests.reduce((n,m) => n + m.entries.length,0);
    const bytes = manifests.reduce((n,m) => n + m.bytes,0);
    if (prior.files + files > (this.config.maxDeletedFilesPerSession ?? 20000) || prior.bytes + bytes > (this.config.maxDeletedBytesPerSession ?? 2*1024**3)) throw new Error('Cumulative deletion budget reached; no further targets were removed.');
    ledger[key] = { day, files:prior.files+files, bytes:prior.bytes+bytes };
    const global=ledger.global?.day===day?ledger.global:{day,files:0,bytes:0};
    if(global.files+files>(this.config.maxDeletedFilesPerDay??50000)||global.bytes+bytes>(this.config.maxDeletedBytesPerDay??5*1024**3)) throw new Error('Profile-wide cumulative deletion budget reached; no further targets were removed.');
    ledger.global={day,files:global.files+files,bytes:global.bytes+bytes};
    await atomicJson(file,ledger);
  }
  async remove(paths, { workspace, owner, signal, reason = '', onRecord = async()=>{}, destination = this.config.defaultDestination??'quarantine' } = {}) {
    return this.serial(async () => {
      const normalized = [...new Set(paths.map(p => assertMutable(path.resolve(p), workspace, this.config)))];
      for (let i=0;i<normalized.length;i++) for(let j=i+1;j<normalized.length;j++) if(within(normalized[i],normalized[j])||within(normalized[j],normalized[i])) throw new Error('Parent and child deletion targets overlap.');
      const manifests = [];
      // Every target must have a verified snapshot before ANY target is moved.
      for (const target of normalized) {
        signal?.throwIfAborted();
        const m = await this.snapshot(target, { kind:'recoverable-delete', owner, signal, reason, workspace });
        if (!m) throw new Error(`Deletion target does not exist: ${target}`);
        manifests.push(m);
        await onRecord(m);
      }
      await this.charge(owner, manifests);
      const results = [];
      for (const m of manifests) {
        signal?.throwIfAborted(); assertMutable(m.original, workspace, this.config);
        const current = await this.collect(m.original, signal);
        if (current.entries.some((e,i) => e.identity !== m.entries[i]?.identity || e.relative !== m.entries[i]?.relative) || current.entries.length !== m.entries.length) throw new Error(`Target changed before deletion; retained: ${m.original}`);
        const mp=path.join(this.root,'entries',m.id,'manifest.json');
        if(destination==='recycle' && process.platform==='win32') {
          m.status='recycle-pending';await atomicJson(mp,m);
          try { await this.recycle(m.original,mp); if(await exists(m.original))throw new Error('Recycle helper retained the source.'); m.status='recycled'; }
          catch(error) { m.recycleError=String(error.message);if(!await exists(m.original))m.status='removed-with-backup'; }
          if(['recycled','removed-with-backup'].includes(m.status)) {
            await atomicJson(mp,m);await this.audit(m.status,{id:m.id,original:m.original,files:m.entries.length,bytes:m.bytes});
            results.push({id:m.id,original:m.original,status:m.status,files:m.entries.length,bytes:m.bytes});continue;
          }
        }
        const volume = path.parse(m.original).root.toLowerCase();
        let quarantineRoot = path.parse(this.root).root.toLowerCase() === volume ? path.join(this.root,'quarantine') : this.config.volumeVaults?.[volume];
        if (!quarantineRoot && process.platform === 'win32' && volume === path.parse(process.env.USERPROFILE ?? '').root.toLowerCase()) quarantineRoot = path.join(process.env.LOCALAPPDATA,'DSH-Recovery-vault','quarantine');
        if (!quarantineRoot) throw new Error('No same-volume quarantine configured. The verified backup exists; original was retained.');
        assertNoLinks(path.resolve(quarantineRoot));
        const payload = path.join(quarantineRoot,m.id,path.basename(m.original));
        await fsp.mkdir(path.dirname(payload),{recursive:true,mode:0o700});
        m.status='move-pending'; m.quarantine=payload;
        await atomicJson(mp,m);
        await fsp.rename(m.original,payload);
        m.status='quarantined';
        await atomicJson(mp,m);
        await this.audit(m.status,{id:m.id,original:m.original,files:m.entries.length,bytes:m.bytes});
        results.push({id:m.id,original:m.original,status:m.status,files:m.entries.length,bytes:m.bytes});
      }
      return results;
    });
  }
  async recycle(target,manifest) {
    const script=path.resolve(import.meta.dirname,'../scripts/recycle.ps1');
    await new Promise((resolve,reject)=>{
      const env={...process.env,PSModulePath:[path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules'),path.join(process.env.ProgramFiles,'WindowsPowerShell/Modules')].join(';')};
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
      let error=''; child.stderr.on('data',c=>{error+=c.toString();});
      child.on('error',reject); child.on('close',code=>code===0?resolve():reject(new Error(error||`Recycle helper exited ${code}`)));
      child.stdin.end(JSON.stringify({path:target,manifest}));
    });
  }
  async list(limit=30) {
    await this.init(); const results=[];
    const names=(await fsp.readdir(path.join(this.root,'entries'))).sort().reverse();
    for(const id of names) { if(results.length>=limit) break; try { const m=JSON.parse(await fsp.readFile(path.join(this.root,'entries',id,'manifest.json'),'utf8')); if(m.status!=='failed') results.push({id:m.id,kind:m.kind,status:m.status,original:m.original,at:m.at,files:m.entries.length,bytes:m.bytes}); } catch {} }
    return results;
  }
  async restore(id,{destination,relative}={}) {
    assertHumanRecoveryContext();
    if(!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid recovery id.');
    const original=JSON.parse(await fsp.readFile(path.join(this.root,'entries',id,'manifest.json'),'utf8'));
    const m=selectManifest(original,relative);
    if(!['ready','quarantined','recycled','move-pending','recycle-pending','removed-with-backup','restored'].includes(m.status)) throw new Error('Snapshot was not completed.');
    const target=path.resolve(destination??m.original); assertNoLinks(target);
    if(await exists(target)) throw new Error('Restore never overwrites an existing path. Choose a new destination.');
    if(within(this.root,target)||within(target,this.root)) throw new Error('Cannot restore into or over recovery storage.');
    for(const e of m.entries) {
      if(path.isAbsolute(e.relative)||!within(target,path.resolve(target,e.relative))) throw new Error('Unsafe recovery manifest path.');
      if(e.type==='file' && (!/^[0-9a-f]{64}$/.test(e.hash)||await digest(path.join(this.root,'objects',e.hash))!==e.hash)) throw new Error('Recovery object failed integrity verification.');
    }
    const transactionId=crypto.randomUUID();
    const receiptPath=path.join(this.root,'state','restore-transactions',`${transactionId}.json`);
    const transaction={version:1,transactionId,snapshotId:id,...(relative?{relative}:{}),destination:target,at:new Date().toISOString(),state:'prepared'};
    // Prove that the journal is writable BEFORE touching the recovery target.
    // A sandbox cannot perform a partial restore and only then discover its
    // audit write is forbidden.
    try {
      await atomicJson(receiptPath,transaction);
      await this.audit('restore-started',{id,destination:target,transactionId});
    } catch(cause) {
      const error=new Error('Recovery audit is unavailable; no recovery target was written. Run the human DSH-Recovery menu outside the agent shell.',{cause});
      error.code='RECOVERY_AUDIT_UNAVAILABLE';throw error;
    }
    // Publish after materializing all files. The same-volume staging path is kept
    // for diagnosis if an IO error occurs; it is never recursively deleted.
    await fsp.mkdir(path.dirname(target),{recursive:true});
    const staging=path.join(path.dirname(target),`.dsh-restore-${crypto.randomUUID()}`);
    const rootFile=m.entries.length===1&&m.entries[0].relative===''&&m.entries[0].type==='file';
    for(const e of m.entries) {
      const out=path.join(staging,e.relative);
      if(e.type==='directory') await fsp.mkdir(out,{recursive:true});
      else if(e.type==='link') { await fsp.mkdir(path.dirname(out),{recursive:true}); await fsp.symlink(e.link,out,e.linkType); }
      else { await fsp.mkdir(path.dirname(out),{recursive:true}); await fsp.copyFile(path.join(this.root,'objects',e.hash),out,fs.constants.COPYFILE_EXCL); if(await digest(out)!==e.hash) throw new Error('Restored file failed verification.'); await fsp.utimes(out,new Date(e.mtimeMs),new Date(e.mtimeMs)); if(!rootFile&&process.platform==='win32'&&Number.isInteger(e.mode)&&(e.mode&0o200)===0) await fsp.chmod(out,0o444); }
    }
    if(await exists(target)) throw new Error('Restore target appeared during restore; nothing was overwritten.');
    if(rootFile){
      // A rename can replace a file created after the preflight existence
      // check. Same-volume link publication is exclusive and never clobbers.
      await fsp.link(staging,target);
      await fsp.unlink(staging).catch(error=>this.audit('restore-staging-retained',{id,staging,code:error.code}).catch(()=>{}));
      if(process.platform==='win32'&&(m.entries[0].mode&0o200)===0)await fsp.chmod(target,0o444);
    }else await fsp.rename(staging,target);
    try {
      await this.audit('restored',{id,destination:target,transactionId});
      transaction.state='complete';transaction.completedAt=new Date().toISOString();
      await atomicJson(receiptPath,transaction);
      return {id,destination:target,status:'restored',audit:{state:'complete',transactionId,receiptPath}};
    } catch(error) {
      transaction.state='restored-audit-pending';transaction.error=String(error.message);
      await atomicJson(receiptPath,transaction).catch(()=>{});
      return {id,destination:target,status:'restored-audit-pending',warning:'Files are restored. Audit completion is pending; do not repeat restore. Use the human recovery menu to reconcile audit.',audit:{state:'pending',transactionId,receiptPath,code:error.code??'unknown'}};
    }
  }
  async reconcileRestores() {
    assertHumanRecoveryContext();
    const directory=path.join(this.root,'state','restore-transactions');
    let names;try{names=await fsp.readdir(directory);}catch(error){if(error.code==='ENOENT')return {transactions:[]};throw error;}
    const results=[];
    for(const name of names.filter(n=>/^[a-zA-Z0-9-]+\.json$/.test(n))) {
      const receiptPath=path.join(directory,name);const transaction=JSON.parse(await fsp.readFile(receiptPath,'utf8'));
      if(transaction.state==='complete')continue;
      const item={transactionId:transaction.transactionId,id:transaction.snapshotId,destination:transaction.destination};
      if(!/^[a-zA-Z0-9-]+$/.test(transaction.snapshotId??'')||!path.isAbsolute(transaction.destination??''))throw new Error('Invalid restore transaction.');
      const manifest=selectManifest(JSON.parse(await fsp.readFile(path.join(this.root,'entries',transaction.snapshotId,'manifest.json'),'utf8')),transaction.relative);
      if(!await exists(transaction.destination)){results.push({...item,status:'target-absent'});continue;}
      assertNoLinks(transaction.destination);
      const actual=await this.collect(transaction.destination,undefined,true);
      const expected=new Map(manifest.entries.map(e=>[e.relative,e]));
      let matches=actual.entries.length===expected.size;
      for(const current of actual.entries) {
        const prior=expected.get(current.relative);if(!prior||current.type!==prior.type){matches=false;break;}
        if(current.type==='file'&&(await digest(path.join(transaction.destination,current.relative))!==prior.hash||(process.platform==='win32'&&(prior.mode&0o200)===0&&(current.mode&0o200)!==0))){matches=false;break;}
        if(current.type==='link'&&current.link!==prior.link){matches=false;break;}
      }
      if(!matches){results.push({...item,status:'target-changed-not-reconciled'});continue;}
      await this.audit('restored',{id:transaction.snapshotId,destination:transaction.destination,transactionId:transaction.transactionId,reconciled:true});
      transaction.state='complete';transaction.reconciledAt=new Date().toISOString();await atomicJson(receiptPath,transaction);
      results.push({...item,status:'reconciled'});
    }
    return {transactions:results};
  }
}

export function selectManifest(manifest,relative) {
  if(relative===undefined) return manifest;
  if(typeof relative!=='string'||!relative||relative==='.'||/[\0\r\n:*?]/.test(relative)||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p==='')) throw new Error('Supply a safe, nonempty relative snapshot path.');
  const selected=path.normalize(relative);
  const source=path.resolve(manifest.original,selected);
  if(!within(manifest.original,source)) throw new Error('Snapshot selection escapes the original path.');
  const entries=manifest.entries.filter(e=>within(source,path.resolve(manifest.original,e.relative))).map(e=>({...e,relative:path.relative(source,path.resolve(manifest.original,e.relative))}));
  if(!entries.length||!entries.some(e=>e.relative==='')) throw new Error('Snapshot does not contain that exact path.');
  return {...manifest,original:source,entries,bytes:entries.reduce((n,e)=>n+(e.type==='file'?e.size:0),0)};
}
