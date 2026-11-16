$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$target=[System.IO.Path]::GetFullPath([string]$request.path)
$manifestPath=[System.IO.Path]::GetFullPath([string]$request.manifest)
if($manifestPath -notmatch '[\\/]dsh-recovery-vault[\\/]entries[\\/][a-zA-Z0-9-]+[\\/]manifest\.json$') { throw 'A completed recovery manifest is required.' }
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.status -ne 'recycle-pending' -or [System.IO.Path]::GetFullPath([string]$manifest.original) -ne $target) { throw 'The recovery transaction does not authorize this exact target.' }
Add-Type -AssemblyName Microsoft.VisualBasic
if([System.IO.Directory]::Exists($target)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
}
