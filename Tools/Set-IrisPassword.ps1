<#
.SYNOPSIS
  Encrypt the IRIS password with your own Windows account key, once.

.DESCRIPTION
  Writes a DPAPI-protected file. DPAPI encrypts with a key derived from the
  logged-in Windows account, so the file is readable only by you, and only on
  this machine. Copying it to another box, or another user reading it, gets
  ciphertext and nothing else.

  That is the part that makes it worth doing. Encrypting a password with a key
  stored beside it protects nobody: the tool has to decrypt unattended, so
  whatever the tool can read, a reader of the folder can read.

  Run once. Then put this in .env, and no secret is in that file at all:

    IRIS_USER=_system
    IRIS_PASSWORD_CMD=powershell -NoProfile -ExecutionPolicy Bypass -File .\Tools\Get-IrisPassword.ps1

.PARAMETER Path
  Where to write the encrypted file. Defaults beside this script.

.EXAMPLE
  .\Tools\Set-IrisPassword.ps1
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $PSScriptRoot 'iris-password.dpapi')
)

$secure = Read-Host -Prompt 'IRIS password' -AsSecureString
if (-not $secure -or $secure.Length -eq 0) {
    Write-Error 'Nothing entered. Not writing an empty file, which would fail at the prompt instead of here.'
    exit 1
}

$secure | ConvertFrom-SecureString | Set-Content -Path $Path -Encoding ASCII

Write-Host ""
Write-Host "Wrote $Path"
Write-Host "Encrypted for $env:USERDOMAIN\$env:USERNAME on $env:COMPUTERNAME. Nobody else can read it."
Write-Host ""
Write-Host "Add to .env, and remove IRIS_PASSWORD:"
Write-Host "  IRIS_PASSWORD_CMD=powershell -NoProfile -ExecutionPolicy Bypass -File .\Tools\Get-IrisPassword.ps1"
