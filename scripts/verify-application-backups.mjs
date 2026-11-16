import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Vault} from '../lib/vault.js';
const config=JSON.parse(await fs.readFile(path.resolve(import.meta.dirname,'../recovery.config.json'),'utf8'));
const vault=new Vault(config);
const parent=process.argv[2];if(!parent||!path.isAbsolute(parent))throw new Error('Supply a pre-created private verification directory.');
const report=[];
const summary=JSON.parse(await fs.readFile(path.join(vault.root,'state/application-checkpoint-latest.json'),'utf8'));
for(const original of [path.join(os.homedir(),'.codex'),path.join(os.homedir(),'.dsh'),path.join(os.homedir(),'.cockpit_tools'),path.join(os.homedir(),'.config','magpie')]){
  const entry=summary.results.find(e=>e.original.toLowerCase()===original.toLowerCase());if(!entry)throw new Error(`Missing successful application checkpoint: ${original}`);
  const destination=path.join(parent,path.basename(original).replace(/^\./,''));
  await vault.restore(entry.id,{destination});
  report.push({id:entry.id,source:original,destination,files:entry.files,sqliteSnapshots:entry.sqliteSnapshots,status:'restored-and-hash-verified'});
}
await fs.writeFile(path.join(parent,'restore-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
