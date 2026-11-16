$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$workspace=[System.IO.Path]::GetFullPath([string]$request.workspace)
$vault=[System.IO.Path]::GetFullPath([string]$request.vault)
if($vault -ne (Join-Path $workspace '.dsh-recovery')) { throw 'Invalid project vault location.' }
foreach($folder in @($workspace,$vault)) {
  $info=Get-Item -LiteralPath $folder -Force
  if(-not $info.PSIsContainer -or ($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'A real project directory is required.' }
}
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$parentInfo=Get-Acl -LiteralPath $workspace
if($parentInfo.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'Workspace owner differs from current user.' }
$before=$parentInfo.Sddl
# Read/write only DACL sections. A restarted sandbox may have added a mandatory
# integrity label; reapplying its SACL through Set-Acl requires privileges this
# ordinary user does not hold and must not be requested.
$parent=[System.IO.Directory]::GetAccessControl($workspace,[System.Security.AccessControl.AccessControlSections]::Access)
$sid=[System.Security.Principal.SecurityIdentifier]::new([string]$request.writeSid)
# Parent DELETE_CHILD can otherwise authorize removal of a protected child even
# if the child's own DELETE is denied. Ordinary project children keep DELETE.
$parentRule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[System.Security.AccessControl.AccessControlType]::Deny)
$parent.SetAccessRule($parentRule)
[System.IO.Directory]::SetAccessControl($workspace,$parent)
$acl=[System.IO.Directory]::GetAccessControl($vault,[System.Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach($principal in @($identity.User,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow))
}
$blocked=[System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
$acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,$blocked,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Deny))
[System.IO.Directory]::SetAccessControl($vault,$acl)
[pscustomobject]@{workspace=$workspace;vault=$vault;beforeWorkspaceSddl=$before;vaultSddl=(Get-Acl -LiteralPath $vault).Sddl;writeSid=[string]$request.writeSid} | ConvertTo-Json -Compress
