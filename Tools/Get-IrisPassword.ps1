<#
.SYNOPSIS
  Print the DPAPI-protected IRIS password on one line, for IRIS_PASSWORD_CMD.

.DESCRIPTION
  Decrypts the file written by Set-IrisPassword.ps1. DPAPI will only do this for
  the same Windows account on the same machine, so this script is not a way round
  the protection -- run as anyone else, it fails.

  The Marshal round trip is how PowerShell 5.1 gets plain text out of a
  SecureString. PowerShell 7 has `ConvertFrom-SecureString -AsPlainText`, which
  5.1 does not, and the work PC is 5.1.

  Contract for IRIS_PASSWORD_CMD: password on the first line of stdout, exit 0.

.PARAMETER Path
  The encrypted file. Defaults beside this script.
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $PSScriptRoot 'iris-password.dpapi')
)

if (-not (Test-Path $Path)) {
    Write-Error "No password file at $Path. Run .\Tools\Set-IrisPassword.ps1 first."
    exit 1
}

try {
    $secure = Get-Content -Path $Path -Raw | ConvertTo-SecureString
} catch {
    Write-Error @"
Could not decrypt $Path.
DPAPI only decrypts for the account that encrypted it, on the machine that
encrypted it. A file copied from another box, or written by another user, reads
as ciphertext. Run .\Tools\Set-IrisPassword.ps1 again as this user.
"@
    exit 1
}

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
