$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$target=[System.IO.Path]::GetFullPath([string]$request.path)
$info=Get-Item -LiteralPath $target -Force
if(-not $info.PSIsContainer -or ($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Workspace must be a real directory.' }
$acl=Get-Acl -LiteralPath $target
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if($owner.Value -ne $current.User.Value) { throw 'The workspace is not owned by the current user; permissions were not changed.' }
$before=$acl.Sddl
if([string]::IsNullOrWhiteSpace([string]$request.evidencePath)) {
  $digest=[System.Security.Cryptography.SHA256]::Create()
  try{$name=([System.BitConverter]::ToString($digest.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()}finally{$digest.Dispose()}
  $evidencePath='D:\dsh-recovery-vault\state\workspace-acl-'+$name+'.json'
}else{$evidencePath=[System.IO.Path]::GetFullPath([string]$request.evidencePath)}
if(-not [System.IO.File]::Exists($evidencePath)) {
  $evidence=[pscustomobject]@{path=$target;owner=$owner.Value;beforeSddl=$before;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  $stream=[System.IO.File]::Open($evidencePath,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::Read)
  try{$bytes=[System.Text.Encoding]::UTF8.GetBytes($evidence);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
# The native runner sets a Low integrity label and needs WRITE_OWNER in addition
# to WRITE_DAC. On D: this user inherits Modify, despite being the owner.
# Grant only that same owner, never Everyone/Users/another account.
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($current.User,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
[pscustomobject]@{path=$target;owner=$owner.Value;beforeSddl=$before;afterSddl=(Get-Acl -LiteralPath $target).Sddl} | ConvertTo-Json -Compress
