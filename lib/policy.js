import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');
export const PROJECT_VAULT = '.dsh-recovery';
export const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
export function resolveLiteral(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error('An exact literal filesystem path is required.');
  if (/^[A-Za-z]:(?![\\/])/.test(value) || /^(?:\\\\[?.]\\|\\(?:device|global\?\?|\?\?)\\)/i.test(value)) throw new Error('Device and drive-relative paths are not accepted.');
  if (/[\*?\[\]]/.test(value)) throw new Error('Resolve wildcard paths first; use exact paths with recoverable_delete.');
  const expanded = value === '~' ? os.homedir() : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  const result = path.resolve(cwd, expanded);
  if (process.platform === 'win32') {
    for (const component of result.slice(path.parse(result).root.length).split(/[\\/]/)) {
      if (/[ .]$/.test(component) || component.includes(':') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw new Error('Ambiguous Windows path component.');
    }
  }
  return result;
}
// Resolve existing ancestors, but never traverse a junction/symlink. Checking the
// lexical path alone would allow an innocent project alias to modify app data.
export function assertNoLinks(target) {
  const root = path.parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked path needs human handling: ${current}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}
export function defaultProtectedRoots(config = {}) {
  const home = os.homedir();
  return [
    '.dsh', '.codex', '.cockpit_tools', '.antigravity_cockpit', '.config/magpie',
    '.ssh', '.gnupg', '.aws', '.azure', '.kube',
  ].map(p => path.join(home, p)).concat([
    path.join(home, 'AppData/Roaming/magpie.exe'),
    path.join(home, 'AppData/Roaming/magpie-windows-amd64.exe'),
    path.join(home, 'AppData/Roaming/@deepseek-ai'),
    path.join(home, 'AppData/Local/DSH-Recovery-vault'),
    config.vaultRoot ?? 'D:/dsh-recovery-vault', 'D:/dsh-restoration-acceptance', SOURCE_ROOT,
    ...(config.protectedRoots ?? []),
  ]).map(p => path.resolve(p));
}
export function assertMutable(target, workspace, config = {}) {
  assertNoLinks(target);
  if(target.split(/[\\/]/).some(part=>part.toLowerCase()===PROJECT_VAULT)) throw new Error('Project recovery storage is protected.');
  if(!config.allowRecoveryContainer&&fs.existsSync(path.join(target,PROJECT_VAULT))) throw new Error('A directory containing project recovery storage cannot be removed or overwritten.');
  if (target === path.parse(target).root || target.toLowerCase() === os.homedir().toLowerCase()) throw new Error('Filesystem and user-profile roots are protected.');
  if(['Desktop','Documents'].some(name=>target.toLowerCase()===path.join(os.homedir(),name).toLowerCase())) throw new Error('The Desktop/Documents root itself is protected; use an exact project or file path.');
  if (process.platform === 'win32' && /^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata|boot)(?:\\|$)/i.test(target)) throw new Error('Operating-system and installed application trees are protected.');
  const worktreeBase = path.join(os.homedir(), '.codex', 'worktrees');
  for (const root of defaultProtectedRoots(config)) {
    if (!(within(root, target) || within(target, root))) continue;
    const codexWorktreeException = root.toLowerCase() === path.join(os.homedir(), '.codex').toLowerCase()
      && within(worktreeBase, workspace) && workspace !== worktreeBase && within(workspace, target);
    if (!codexWorktreeException) throw new Error(`Protected data or recovery storage: ${root}`);
  }
  return target;
}
export function workspaceFor(exec) {
  return path.resolve(exec.agent?.session?.header?.cwd ?? exec.agent?.session?.cwd ?? process.cwd());
}
export function ownerFor(exec) {
  return String(exec.agent?.session?.header?.id ?? exec.agent?.session?.id ?? exec.agent?.id ?? 'unscoped');
}
export function parsePatchTargets(text) {
  if (typeof text !== 'string' || !text.startsWith('*** Begin Patch') || !text.trimEnd().endsWith('*** End Patch')) throw new Error('Unrecognized patch envelope.');
  const targets = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) targets.push({ kind: match[1], path: match[2] });
  }
  if (!targets.length) throw new Error('Patch has no explicit file targets.');
  return targets;
}
// This recognizer is deliberately narrower than a shell parser. An ambiguous
// destructive command is denied rather than rewritten or executed speculatively.
export function words(source) {
  const result = []; let text = ''; let quote; let active = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && source[i + 1] === "'") { text += "'"; i++; }
        else quote = undefined;
      } else { if (quote === '"' && /[$`]/.test(c)) throw new Error('Expanded deletion target.'); text += c; }
    } else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) { result.push(text); text = ''; active = false; } }
    else if (/[;$`|&<>(){}\r\n]/.test(c)) throw new Error('Compound or expanded shell expression.');
    else { text += c; active = true; }
  }
  if (quote) throw new Error('Unbalanced quote.');
  if (active) result.push(text);
  return result;
}
// Function calls and destructive flags remain semantic markers. Command aliases
// such as rd/ri/del are checked in command position below, never in path text.
export const DELETION_MARKER = /(?:\.\s*(?:unlink|rmdir|rmtree|remove|delete|truncate)(?:sync)?\s*\()|\b(?:unlink|rmtree|remove|rmdir|truncate)\s*\(|(?<![\w-])-(?:delete|exec)\b|--delete\b|\/(?:mir|purge)\b/i;
const DESTRUCTIVE_COMMANDS=new Set(['remove-item','clear-content','clear-recyclebin','rm','ri','del','erase','rmdir','rd','unlink','shred','sdelete','wipe','format-volume','clear-disk']);
function commandTokens(source,dialect) {
  const tokens=[];let text='',quote,active=false;
  const flush=()=>{if(active){tokens.push({text});text='';active=false;}};
  for(let index=0;index<source.length;index++) {
    const char=source[index];
    if(quote){
      if(char===quote){if(quote==="'"&&dialect==='pwsh'&&source[index+1]==="'"){text+="'";index++;}else quote=undefined;}
      else if((char==='`'&&dialect==='pwsh')||(char==='\\'&&dialect==='bash'&&quote==='"')){text+=source[++index]??'';}
      else text+=char;
      continue;
    }
    if(char==='"'||char==="'"){quote=char;active=true;}
    else if((char==='`'&&dialect==='pwsh')||(char==='\\'&&dialect==='bash')){text+=source[++index]??'';active=true;}
    else if(/[;|&\r\n(){}<>]/.test(char)){flush();tokens.push({operator:char});}
    else if(/\s/.test(char))flush();
    else{text+=char;active=true;}
  }
  flush();return tokens;
}
export function hasDestructiveCommand(source,dialect,depth=0) {
  if(depth>4)return true;
  const tokens=commandTokens(source,dialect);let commandPosition=true,executable='';
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    if(token.operator){if(/[;|&\r\n(){}]/.test(token.operator)){commandPosition=true;executable='';}else index++;continue;}
    const name=path.win32.basename(token.text).replace(/\.(?:exe|cmd|ps1)$/i,'').toLowerCase();
    if(commandPosition){
      if(['command','builtin','exec','sudo','doas','call','nohup','!'].includes(name)||/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text))continue;
      if(DESTRUCTIVE_COMMANDS.has(name))return true;
      executable=name;commandPosition=false;
    }else if(['cmd','powershell','pwsh','bash','sh','zsh'].includes(executable)&&['/c','/k','-c','-command'].includes(token.text.toLowerCase())){
      const nested=tokens[index+1]?.text;
      if(nested!==undefined&&hasDestructiveCommand(nested,dialect,depth+1))return true;
    }
  }
  return false;
}
const DESTRUCTIVE_GIT = /\bgit(?:\.exe)?\s+(?:clean(?![^\r\n]*(?:--dry-run|\s-[a-z]*n))|reset\b[^\r\n]*--hard|restore\b|(?:checkout|switch)\b[^\r\n]*(?:--force|\s-f\b))/i;
export function simpleDeletion(command, dialect) {
  if (/[\r\n#]/.test(command.trim()) || (dialect === 'bash' && command.includes('\\'))) return undefined;
  let tokens;
  try { tokens = words(command.trim()); } catch { return undefined; }
  if (!tokens.length) return undefined;
  const name = path.win32.basename(tokens.shift()).replace(/\.exe$/i, '').toLowerCase();
  const eligible = dialect === 'bash' ? ['rm', 'rmdir', 'unlink'] : ['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir'];
  if (!eligible.includes(name)) return undefined;
  const targets = []; let literalOnly = false;
  for (const token of tokens) {
    // These cmd.exe switches have no defined meaning for a PowerShell alias.
    // Never resolve /s or /q into a drive-root path and delete that instead.
    if(dialect==='pwsh' && token.startsWith('/')) throw new Error('CMD-style slash switches/root-relative deletion operands are not supported. Use recoverable_delete with exact paths, or Remove-Item -LiteralPath with an explicit drive path.');
    if (token === '--') { literalOnly = true; continue; }
    if (!literalOnly && token.startsWith('-')) {
      const allowed = dialect === 'bash' ? /^-(?:[rfdiv]+|-recursive|-force)$/i : /^-(?:literalpath|path|recurse|force|confirm:\$false|erroraction|ea|verbose)$/i;
      if (!allowed.test(token)) throw new Error('Unsupported deletion option; use recoverable_delete.');
      if (/^-(?:erroraction|ea)$/i.test(token)) throw new Error('Use recoverable_delete instead of suppressing errors.');
      continue;
    }
    if (/[\*?\[\]$,]/.test(token)) throw new Error('Dynamic, wildcard or array deletion requires exact paths in recoverable_delete.');
    targets.push(token);
  }
  if (!targets.length) throw new Error('No exact deletion target.');
  return targets;
}
const READ_ONLY = /^(?:get-(?:childitem|content|item|itemproperty|command|process|location|date|filehash|acl)|test-path|resolve-path|select-(?:object|string)|where-object|measure-object|format-(?:table|list)|write-output|out-string|echo|pwd|ls|dir|cat|type|head|tail|rg|grep|findstr|git\s+(?:status|diff|log|show|ls-files|rev-parse)\b)(?:\s|$)/i;
function literalInvocation(command, dialect) {
  if (/[\r\n#]/.test(command)) return undefined;
  let source=command.trim();
  if(dialect==='pwsh' && /^&\s+/.test(source)) source=source.replace(/^&\s+/,'');
  try { return words(source); } catch { return undefined; }
}
function versionProbe(command, dialect) {
  const invocation=literalInvocation(command,dialect);
  if(invocation?.length!==2) return false;
  const executable=path.win32.basename(invocation[0]).replace(/\.(?:exe|cmd|ps1)$/i,'').toLowerCase();
  const flag=invocation[1];
  if(['python','python3','py','pip','pip3'].includes(executable)) return flag==='--version'||flag==='-V';
  if(['node','nodejs','npm','pnpm','yarn','bun'].includes(executable)) return flag==='--version'||flag==='-v';
  return executable==='git' && flag==='--version';
}
function recoveryQuery(command, dialect, cwd) {
  const invocation=literalInvocation(command,dialect);
  if(invocation?.length!==3 || !['list','doctor'].includes(invocation[2])) return undefined;
  if(!/^node(?:\.exe)?$/i.test(path.win32.basename(invocation[0]))) return undefined;
  let script;
  try { script=resolveLiteral(invocation[1],cwd); } catch { return undefined; }
  const expected=path.join(SOURCE_ROOT,'bin','recover.mjs');
  if(process.platform==='win32'?script.toLowerCase()!==expected.toLowerCase():script!==expected) return undefined;
  // A capability marker only: the tools/execute handler answers it directly.
  // It must never turn the whole recovery CLI into an executable allowlist.
  return {kind:'recovery-query',action:invocation[2]};
}
function preciseShellMutation(command,dialect,cwd,workspace,config) {
  if(dialect!=='pwsh')return undefined;
  const invocation=literalInvocation(command,dialect);if(!invocation)return undefined;
  const name=invocation[0]?.toLowerCase();
  const rules={
    'set-content':{path:['-literalpath','-path'],values:['-value','-encoding'],flags:['-force','-nonewline']},
    'add-content':{path:['-literalpath','-path'],values:['-value','-encoding'],flags:['-force','-nonewline']},
    'out-file':{path:['-literalpath','-filepath'],values:['-encoding','-width'],flags:['-force','-append','-nonewline','-noclobber']},
    'set-itemproperty':{path:['-literalpath','-path'],values:['-name','-value'],flags:['-force']}
  };
  const rule=rules[name];if(!rule)return undefined;
  let target;
  for(let i=1;i<invocation.length;i++){
    const token=invocation[i].toLowerCase();
    if(rule.path.includes(token)){if(target!==undefined||i+1>=invocation.length)return undefined;target=invocation[++i];}
    else if(rule.values.includes(token)){if(i+1>=invocation.length)return undefined;i++;}
    else if(!rule.flags.includes(token))return undefined;
  }
  if(!target||/[$`*?\[\],]/.test(target))return undefined;
  const resolved=assertMutable(resolveLiteral(target,cwd),workspace,config);
  return [resolved];
}
export function shellAssessment(command, dialect, cwd, workspace, config = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Missing shell command.');
  const query=recoveryQuery(command,dialect,cwd);
  if(query) return query;
  const targets = simpleDeletion(command, dialect);
  if (targets) return { kind: 'delete', paths: targets.map(p => assertMutable(resolveLiteral(p, cwd), workspace, config)) };
  if (hasDestructiveCommand(command,dialect) || DELETION_MARKER.test(command) || DESTRUCTIVE_GIT.test(command)) throw new Error('Destructive shell operation was not run. Use recoverable_delete with exact paths; native file patches are backed up automatically.');
  if (/\b(?:invoke-expression|iex|clear-recyclebin|takeown|icacls|set-acl|set-executionpolicy|fsutil|vssadmin|diskpart)\b|-(?:en(?:c(?:odedcommand)?)?)\b/i.test(command)) throw new Error('Opaque execution, backup deletion or permission changes require human handling.');
  // Protect recovery/app-data paths even when Full access and purge are active.
  const readOnly = versionProbe(command,dialect) || (READ_ONLY.test(command.trim()) && !/[;>&`\r\n]/.test(command) && !/\|(?!\s*(?:select-|where-object|measure-object|format-|out-string))/i.test(command));
  if(!readOnly && literalInvocation(command,dialect)?.some(token=>['dsh-recovery.cmd','dsh 文件恢复.cmd','recovery-menu.ps1'].includes(path.win32.basename(token).toLowerCase()))) {
    throw new Error('Human recovery menu: please double-click DSH 文件恢复.cmd from the Windows desktop or File Explorer, outside DSH. 请在资源管理器或桌面双击“DSH 文件恢复.cmd”，不要从 DSH 会话或集成终端启动。');
  }
  const lower = command.replaceAll('\\', '/').toLowerCase();
  if (!readOnly) {
    if(lower.includes(PROJECT_VAULT)) throw new Error('Project recovery storage cannot be modified by shell commands.');
    for (const root of defaultProtectedRoots(config)) {
      const normalized = root.replaceAll('\\', '/').toLowerCase();
      const marker = path.basename(root).toLowerCase();
      if (lower.includes(normalized) || (['.dsh','.codex','.cockpit_tools','.antigravity_cockpit'].includes(marker) && lower.includes(marker))) throw new Error('Shell mutation references protected application data or recovery storage.');
    }
  }
  if (/\b(?:terminal_send|start-process|start-job|invoke-command|schtasks|wmic|psexec)\b/i.test(command)) throw new Error('Detached execution cannot be checkpointed reliably; run a foreground command.');
  const mutationPaths=!readOnly?preciseShellMutation(command,dialect,cwd,workspace,config):undefined;
  return { kind: 'run', checkpoint: !readOnly, ...(mutationPaths?{mutationPaths}:{}) };
}
export function assess(exec, config = {}) {
  const args = exec.arguments ?? {};
  const workspace = workspaceFor(exec);
  const cwd = path.resolve(args.workdir ?? args.cwd ?? workspace);
  if(['recoverable_restore','recovery_create_temp','recovery_list'].includes(exec.name)) return {kind:exec.name,workspace,cwd};
  if (['pwsh','bash'].includes(exec.name)) return { ...shellAssessment(args.command, exec.name, cwd, workspace, config), workspace, cwd };
  if (exec.name === 'recoverable_delete') {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 128) throw new Error('Supply 1–128 exact paths.');
    return { kind: 'delete', paths: args.paths.map(p => assertMutable(resolveLiteral(p, workspace), workspace, config)), workspace, cwd };
  }
  if (exec.name === 'apply_patch') {
    const entries = parsePatchTargets(args.input ?? args.patch ?? args.command);
    return { kind: 'mutate', paths: [...new Set(entries.map(e => assertMutable(resolveLiteral(e.path, workspace), workspace, config)))], deletions: entries.filter(e => e.kind === 'Delete File').length, workspace, cwd };
  }
  if (['write','edit','str_replace_editor'].includes(exec.name) && args.command !== 'view') {
    return { kind: 'mutate', paths: [assertMutable(resolveLiteral(args.file_path ?? args.path, workspace), workspace, config)], workspace, cwd };
  }
  if (/^(?:terminal_open|terminal_send)$/.test(exec.name)) throw new Error('Persistent terminal state is outside recoverable execution. Use pwsh/bash foreground calls.');
  if (/(?:^|[_-])(?:delete|remove|purge|erase|wipe|truncate|destroy|drop|reset)(?:$|[_-])/i.test(exec.name)) throw new Error('Use recoverable_delete for file removal; account/session deletion needs the human application interface.');
  if (['exec_command','run_shell','execute_command'].includes(exec.name)) throw new Error('Use the supervised pwsh/bash tools.');
  return { kind: 'pass', workspace, cwd };
}
