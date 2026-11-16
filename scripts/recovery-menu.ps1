$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
if($env:DSH_SHELL -eq '1' -or $env:RECOVERABLE_DELETE_CONTEXT -eq 'agent') {
  Write-Host '请在资源管理器或 Windows 桌面双击“DSH 文件恢复.cmd”。' -ForegroundColor Yellow
  Write-Host '当前入口继承了 DSH 会话/集成终端环境，恢复功能不会在这里启动。没有修改恢复目标或备份库。'
  exit 1
}
$nodePath='D:\DeepSeek_dsh_win\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$cli=Join-Path $PSScriptRoot '..\bin\recover.mjs'
while($true){
  Write-Host ''
  Write-Host 'DSH Recoverable Files / 文件恢复（菜单修订 3）' -ForegroundColor Cyan
  Write-Host '1. 列出可恢复记录  2. 恢复文件  3. 查看保护状态  4. 备份重要应用数据  5. 核验并补记恢复审计  0. 退出'
  $choice=Read-Host '请选择'
  if($choice -eq '0'){break}
  try{
    if($choice -eq '3'){& $nodePath $cli doctor;continue}
    if($choice -eq '4'){& $nodePath $cli backup-apps;continue}
    if($choice -eq '5'){& $nodePath $cli reconcile;continue}
    if($choice -notin @('1','2')){continue}
    $json=& $nodePath $cli list
    if($LASTEXITCODE -ne 0){throw '读取恢复列表失败；没有执行恢复。'}
    # Windows PowerShell 5.1 emits a JSON array as one pipeline object.
    # Enumerate explicitly before counting/indexing; otherwise property access
    # silently joins every record's ID and original path into one selection.
    $records=@($json | ConvertFrom-Json | ForEach-Object { $_ })
    $seenIds=@{}
    foreach($record in $records){
      if($record -is [System.Array] -or $record.id -isnot [string] -or $record.id -notmatch '^[a-zA-Z0-9-]+$' -or $record.original -isnot [string] -or [string]::IsNullOrWhiteSpace($record.original) -or $record.original -match '[\r\n\x00]' -or -not [System.IO.Path]::IsPathRooted($record.original) -or $record.vaultRoot -isnot [string] -or -not [System.IO.Path]::IsPathRooted($record.vaultRoot) -or $seenIds.ContainsKey($record.id)){
        throw '恢复列表格式无效，已停止；没有选择或恢复任何记录。'
      }
      $seenIds[$record.id]=$true
    }
    if($records.Count -eq 0){Write-Host '没有可恢复记录。';continue}
    for($index=0;$index -lt $records.Count;$index++){
      $record=$records[$index]
      Write-Host ('[{0}] {1} | {2} | {3}' -f ($index+1),$record.at,$record.kind,$record.status)
      Write-Host ('    原路径: '+$record.original)
      Write-Host ('    记录ID: '+$record.id)
    }
    if($choice -ne '2'){continue}
    $number=0
    if(-not [int]::TryParse((Read-Host '输入记录编号'),[ref]$number) -or $number -lt 1 -or $number -gt $records.Count){throw '记录编号无效'}
    $selected=$records[$number-1]
    if($selected.status -eq 'recycled-no-backup') { throw '这是免备份测试产物，请在 Windows 回收站手动还原，或重新生成。' }
    Write-Host ('已选择记录: '+$selected.id)
    Write-Host ('原路径: '+$selected.original)
    $default=[string]$selected.original
    if(Test-Path -LiteralPath $default){
      $privateRoot='D:\dsh-restoration-acceptance'
      New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
      $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      & icacls.exe $privateRoot /inheritance:r /grant:r ($identity+':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
      $default=Join-Path $privateRoot ((Split-Path $selected.original -Leaf)+'-recovered-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    Write-Host '恢复不会覆盖已有文件。账号库、会话数据库请先导出副本，核对后再导入应用。'
    $destination=Read-Host ('恢复到（直接回车使用 '+$default+'）')
    if([string]::IsNullOrWhiteSpace($destination)){$destination=$default}
    & $nodePath $cli --vault $selected.vaultRoot restore $selected.id --to $destination
    if($LASTEXITCODE -eq 2){Write-Host '文件已经恢复；审计待补记。不要重复恢复，请选择“核验并补记恢复审计”。' -ForegroundColor Yellow;continue}
    if($LASTEXITCODE -ne 0){throw '恢复未完成；原备份仍保留。'}
  }catch{Write-Host $_.Exception.Message -ForegroundColor Red}
}
