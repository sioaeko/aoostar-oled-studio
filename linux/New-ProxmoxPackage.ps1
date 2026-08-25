[CmdletBinding()]
param(
    [string]$BinaryPath = 'target/x86_64-unknown-linux-musl/release/asterctl-web',
    [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PackageName = 'aoostar-oled-studio-proxmox-x86_64'
$BinaryFullPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $BinaryPath))
$OutputFullPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputDirectory))
$WorkRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '_work/proxmox-package'))
$StageRoot = Join-Path $WorkRoot $PackageName
$ZipPath = Join-Path $OutputFullPath "$PackageName.zip"
$ZipChecksumPath = "$ZipPath.sha256"
$YtDlpVersion = '2026.07.04'
$ExpectedYtDlpSha256 = '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae'
$YtDlpPath = Join-Path $ProjectRoot 'third_party/yt-dlp/yt-dlp'
$FetchYtDlpScript = Join-Path $ProjectRoot 'scripts/Fetch-YtDlp.ps1'

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $prefix = $Parent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside $Parent`: $Child"
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string[]]$Lines)
    # Package metadata is consumed by Linux command-line tools. PowerShell on
    # Windows otherwise emits CRLF, causing sha256sum -c to treat the trailing
    # carriage return as part of every filename.
    $text = ($Lines -join "`n") + "`n"
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Get-UnixModeAttributes {
    param([int]$Mode)
    $regularFileWithMode = [uint32](0x8000 -bor $Mode)
    $bytes = [BitConverter]::GetBytes([uint32]($regularFileWithMode -shl 16))
    [BitConverter]::ToInt32($bytes, 0)
}

function Set-ZipUnixOrigin {
    param([string]$Path, [int]$ExpectedEntries)
    $bytes = [IO.File]::ReadAllBytes($Path)
    $minimumOffset = [Math]::Max(0, $bytes.Length - 65557)
    $eocdOffset = -1
    for ($index = $bytes.Length - 22; $index -ge $minimumOffset; $index--) {
        if ($bytes[$index] -eq 0x50 -and $bytes[$index + 1] -eq 0x4b -and
            $bytes[$index + 2] -eq 0x05 -and $bytes[$index + 3] -eq 0x06) {
            $eocdOffset = $index
            break
        }
    }
    if ($eocdOffset -lt 0) { throw 'ZIP end-of-central-directory record was not found' }

    $entryCount = [BitConverter]::ToUInt16($bytes, $eocdOffset + 10)
    $centralSize = [BitConverter]::ToUInt32($bytes, $eocdOffset + 12)
    $cursor = [int][BitConverter]::ToUInt32($bytes, $eocdOffset + 16)
    $centralEnd = $cursor + [int]$centralSize
    if ($entryCount -ne $ExpectedEntries) {
        throw "ZIP central directory contains $entryCount entries, expected $ExpectedEntries"
    }

    for ($entryIndex = 0; $entryIndex -lt $entryCount; $entryIndex++) {
        if ($bytes[$cursor] -ne 0x50 -or $bytes[$cursor + 1] -ne 0x4b -or
            $bytes[$cursor + 2] -ne 0x01 -or $bytes[$cursor + 3] -ne 0x02) {
            throw "Invalid ZIP central directory entry at offset $cursor"
        }
        # The high byte of "version made by" identifies the creator OS. Unix
        # makes Linux unzip honor the 0100755/0100644 external attributes.
        $bytes[$cursor + 5] = 3
        $nameLength = [BitConverter]::ToUInt16($bytes, $cursor + 28)
        $extraLength = [BitConverter]::ToUInt16($bytes, $cursor + 30)
        $commentLength = [BitConverter]::ToUInt16($bytes, $cursor + 32)
        $cursor += 46 + $nameLength + $extraLength + $commentLength
    }
    if ($cursor -ne $centralEnd) { throw 'ZIP central directory length is inconsistent' }
    [IO.File]::WriteAllBytes($Path, $bytes)
}

Assert-ChildPath -Parent $ProjectRoot -Child $OutputFullPath
Assert-ChildPath -Parent $ProjectRoot -Child $WorkRoot
if (-not (Test-Path -LiteralPath $BinaryFullPath -PathType Leaf)) {
    throw "Linux binary not found: $BinaryFullPath"
}

$header = [IO.File]::ReadAllBytes($BinaryFullPath)
if ($header.Length -lt 20 -or $header[0] -ne 0x7f -or $header[1] -ne 0x45 -or
    $header[2] -ne 0x4c -or $header[3] -ne 0x46 -or $header[4] -ne 2 -or
    $header[5] -ne 1 -or $header[18] -ne 0x3e -or $header[19] -ne 0x00) {
    throw 'asterctl-web must be a little-endian ELF64 x86_64 binary, not a Windows executable'
}

if (-not (Test-Path -LiteralPath $YtDlpPath -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $FetchYtDlpScript -PathType Leaf)) {
        throw "yt-dlp is missing and the verified fetch script was not found: $FetchYtDlpScript"
    }
    Write-Host 'Vendored yt-dlp is missing; fetching the pinned official Linux release.'
    & $FetchYtDlpScript | Out-Host
}
if (-not (Test-Path -LiteralPath $YtDlpPath -PathType Leaf)) {
    throw "Verified yt-dlp fetch did not create: $YtDlpPath"
}
$ytDlpHash = (Get-FileHash -LiteralPath $YtDlpPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ytDlpHash -ne $ExpectedYtDlpSha256) {
    throw "yt-dlp checksum mismatch: expected $ExpectedYtDlpSha256, got $ytDlpHash"
}

if (Test-Path -LiteralPath $WorkRoot) {
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputFullPath -Force | Out-Null

$sourceFiles = [ordered]@{
    'asterctl-web' = $BinaryFullPath
    'yt-dlp' = $YtDlpPath
    'asterctl-web.service' = Join-Path $ProjectRoot 'linux/asterctl-web.service'
    'install-asterctl-web.sh' = Join-Path $ProjectRoot 'linux/install-asterctl-web.sh'
    'verify-package.sh' = Join-Path $ProjectRoot 'linux/verify-asterctl-web-package.sh'
    'brightness-probe.py' = Join-Path $ProjectRoot 'linux/brightness-probe.py'
    'PROXMOX-INSTALL.md' = Join-Path $ProjectRoot 'linux/PROXMOX-INSTALL.md'
    'LICENSE-MIT' = Join-Path $ProjectRoot 'LICENSE-MIT'
    'LICENSE-APACHE' = Join-Path $ProjectRoot 'LICENSE-APACHE'
    'LICENSE-YT-DLP' = Join-Path $ProjectRoot 'third_party/yt-dlp/LICENSE'
}
foreach ($entry in $sourceFiles.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
        throw "Package source is missing: $($entry.Value)"
    }
    Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $StageRoot $entry.Key)
}
$stagedYtDlpHash = (Get-FileHash -LiteralPath (Join-Path $StageRoot 'yt-dlp') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($stagedYtDlpHash -ne $ExpectedYtDlpSha256) {
    throw "staged yt-dlp checksum mismatch: expected $ExpectedYtDlpSha256, got $stagedYtDlpHash"
}

$manifestPath = Join-Path $ProjectRoot 'Cargo.toml'
$metadata = cargo metadata --manifest-path $manifestPath --locked --format-version 1 --no-deps | ConvertFrom-Json
$webPackage = $metadata.packages | Where-Object name -eq 'asterctl-web' | Select-Object -First 1
if (-not $webPackage) { throw 'Could not determine asterctl-web version' }
$sourceCommit = 'unavailable'
$sourceState = 'standalone-workspace'
$gitMarker = Join-Path $ProjectRoot '.git'
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($gitCommand -and (Test-Path -LiteralPath $gitMarker)) {
    $commitOutput = @()
    $gitExitCode = 1
    $previousErrorAction = $ErrorActionPreference
    try {
        # A freshly initialized standalone repository has .git but no HEAD
        # commit yet. Treat that state like an unpacked source archive instead
        # of letting native stderr abort packaging under Windows PowerShell.
        $ErrorActionPreference = 'SilentlyContinue'
        $commitOutput = & $gitCommand.Source -C $ProjectRoot rev-parse --verify HEAD 2>$null
        $gitExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($gitExitCode -eq 0 -and $commitOutput) {
        $candidateCommit = ($commitOutput | Select-Object -First 1).Trim()
        if ($candidateCommit -match '^[0-9a-fA-F]{40,64}$') {
            $sourceCommit = $candidateCommit.ToLowerInvariant()
            $sourceState = 'local-workspace'
        }
    }
}
$uiIndex = Get-Content -LiteralPath (Join-Path $ProjectRoot 'oled-studio/dist/index.html') -Raw
$uiAssetMatch = [regex]::Match($uiIndex, '/assets/[^"'']+\.js')
if (-not $uiAssetMatch.Success) { throw 'Could not determine embedded OLED Studio asset' }
$binaryHash = (Get-FileHash -LiteralPath $BinaryFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
$versionLines = @(
    'PACKAGE_FORMAT=1'
    "PACKAGE_NAME=$PackageName"
    "ASTERCTL_WEB_VERSION=$($webPackage.version)"
    'BUILD_TARGET=x86_64-unknown-linux-musl'
    'BINARY_FORMAT=ELF64-x86_64-static-musl'
    "BINARY_SHA256=$binaryHash"
    "YTDLP_VERSION=$YtDlpVersion"
    "YTDLP_SHA256=$ExpectedYtDlpSha256"
    "EMBEDDED_UI_ASSET=$($uiAssetMatch.Value)"
    "SOURCE_COMMIT=$sourceCommit"
    "SOURCE_STATE=$sourceState"
    "RUSTC=$(rustc --version)"
    "BUILT_UTC=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
)
Write-Utf8NoBom -Path (Join-Path $StageRoot 'version.txt') -Lines $versionLines

$checksumNames = Get-ChildItem -LiteralPath $StageRoot -File | Sort-Object Name | Select-Object -ExpandProperty Name
$checksumLines = foreach ($name in $checksumNames) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $StageRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name"
}
Write-Utf8NoBom -Path (Join-Path $StageRoot 'SHA256SUMS') -Lines $checksumLines

foreach ($target in @($ZipPath, $ZipChecksumPath)) {
    Assert-ChildPath -Parent $OutputFullPath -Child $target
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}

Add-Type -AssemblyName System.IO.Compression
$zipStream = [IO.File]::Open($ZipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in (Get-ChildItem -LiteralPath $StageRoot -File | Sort-Object Name)) {
            $entryName = "$PackageName/$($file.Name)"
            $zipEntry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
            $mode = if ($file.Name -in @('asterctl-web', 'yt-dlp', 'install-asterctl-web.sh', 'verify-package.sh', 'brightness-probe.py')) { 0x1ed } else { 0x1a4 }
            $zipEntry.ExternalAttributes = Get-UnixModeAttributes -Mode $mode
            $input = [IO.File]::OpenRead($file.FullName)
            $output = $zipEntry.Open()
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    $zipStream.Dispose()
}

Set-ZipUnixOrigin -Path $ZipPath -ExpectedEntries (Get-ChildItem -LiteralPath $StageRoot -File).Count
$zipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Utf8NoBom -Path $ZipChecksumPath -Lines @("$zipHash  $([IO.Path]::GetFileName($ZipPath))")

[pscustomobject]@{
    Zip = $ZipPath
    Sha256 = $zipHash
    Bytes = (Get-Item -LiteralPath $ZipPath).Length
    Staging = $StageRoot
}
