[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Version = '2026.07.04'
$ExpectedSha256 = '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TargetDirectory = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'third_party/yt-dlp'))
$Target = Join-Path $TargetDirectory 'yt-dlp'
$Temporary = Join-Path $TargetDirectory 'yt-dlp.download'
$Url = "https://github.com/yt-dlp/yt-dlp/releases/download/$Version/yt-dlp_linux"

$prefix = $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $Target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $Temporary.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to write outside the project directory'
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }

try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Temporary
    $actual = (Get-FileHash -LiteralPath $Temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) {
        throw "yt-dlp checksum mismatch: expected $ExpectedSha256, got $actual"
    }
    Move-Item -LiteralPath $Temporary -Destination $Target -Force
} finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
}

[pscustomobject]@{
    Version = $Version
    Path = $Target
    Sha256 = $ExpectedSha256
}
