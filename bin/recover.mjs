import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { Vault } from '../lib/vault.js';
import { assertHumanRecoveryContext } from '../lib/execution-context.js';
const configPath=path.resolve(import.meta.dirname,'../recovery.config.json');
const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
const raw=process.argv.slice(2);
if(raw[0]==='--vault'){config.vaultRoot=raw[1];raw.splice(0,2);}
const vault=new Vault(config);
const [command='list',id,...args]=raw;
try {
  let output;
  if(!['list','doctor'].includes(command))assertHumanRecoveryContext();
  if(command==='list') output=await vault.list(50);
  else if(command==='doctor') output=JSON.parse(fs.readFileSync(path.join(vault.root,'state/plugin-live.json'),'utf8'));
  else if(command==='backup-apps') {
    const execution=spawnSync(config.pythonPath??'D:/ProjectRuntimes/python311/Scripts/python.exe',[path.resolve(import.meta.dirname,'../scripts/checkpoint-apps.py')],{windowsHide:true,stdio:'inherit'});
    if(execution.status!==0)throw new Error('Application checkpoint did not complete; see the checkpoint summary.');
    output={status:'complete',summary:path.join(vault.root,'state/application-checkpoint-latest.json')};
  }
  else if(command==='restore') {
    if(!id || (args.length!==0 && (args.length!==2 || args[0]!=='--to' || !args[1]))) {
      throw new Error('Restore requires exactly one record ID and optionally --to NEW_PATH. Nothing was restored.');
    }
    output=await vault.restore(id,{destination:args.length===2?args[1]:undefined});
  } else if(command==='reconcile') output=await vault.reconcileRestores();
  else if(command==='snapshot') output=await vault.snapshot(path.resolve(id),{kind:'human-checkpoint',owner:'human-cli'});
  else throw new Error('Usage: node bin/recover.mjs [--vault PATH] list | doctor | backup-apps | restore ID [--to NEW_PATH] | reconcile | snapshot PATH');
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
  if(output?.status==='restored-audit-pending')process.exitCode=2;
} catch(error) { process.stderr.write(error.message+'\n'); process.exitCode=1; }
