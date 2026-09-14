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
    [string]$Path
)

# $PSScriptRoot is EMPTY in a param() default when a script with
# [CmdletBinding()] is run via `powershell -File`, on PowerShell 5.1. Direct
# invocation (.\\Script.ps1) populates it, which is how the encrypt half of this
# pair worked while the decrypt half -- the one .env actually calls, with -File --
# failed on "Cannot bind argument to parameter 'Path' because it is an empty
# string". Reproduced on 5.1 both ways 2026-09-14.
#
# So the default is computed in the body, where it is populated, with
# $MyInvocation as the fallback for the same reason.

if (-not $Path) {
    $root = $PSScriptRoot
    if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Definition }
    if (-not $root) { $root = (Get-Location).Path }
    $Path = Join-Path $root 'iris-password.dpapi'
}

if (-not (Test-Path $Path)) {
    Write-Error "No password file at $Path. Run .\Tools\Set-IrisPassword.ps1 first."
    exit 1
}

# .Trim() is load bearing. Set-Content appends a newline, Get-Content -Raw keeps
# it, and ConvertTo-SecureString rejects the result with "Input string was not in
# a correct format" -- which reads exactly like a DPAPI refusal and sends you
# looking at accounts and machines instead of at whitespace. Trimming on READ also
# means a file written by any means still opens.
try {
    $secure = (Get-Content -Path $Path -Raw).Trim() | ConvertTo-SecureString
} catch {
    Write-Error @"
Could not decrypt $Path.
  it said: $($_.Exception.Message)

DPAPI only decrypts for the account that encrypted it, on the machine that
encrypted it. A file copied from another box, or written by another user, reads
as ciphertext. Run .\Tools\Set-IrisPassword.ps1 again as this user.

"Input string was not in a correct format" is different: that is the file's
shape, not its ownership. It means what is in there is not a ConvertFrom-SecureString
string at all.
"@
    exit 1
}

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
