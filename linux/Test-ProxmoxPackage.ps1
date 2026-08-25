[CmdletBinding()]
param(
    [string]$ZipPath = 'artifacts/aoostar-oled-studio-proxmox-x86_64.zip'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ZipFullPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $ZipPath))
$ZipChecksumPath = "$ZipFullPath.sha256"
$PackageName = 'aoostar-oled-studio-proxmox-x86_64'
$ExpectedYtDlpSha256 = '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae'
$VerifyRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '_work/proxmox-package-independent-verify'))
$ProjectPrefix = $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $VerifyRoot.StartsWith($ProjectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe verification path: $VerifyRoot"
}
foreach ($file in @($ZipFullPath, $ZipChecksumPath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing artifact: $file" }
}

$expectedZipHash = (Get-Content -LiteralPath $ZipChecksumPath).Split(
    ' ', [StringSplitOptions]::RemoveEmptyEntries
)[0].ToLowerInvariant()
$actualZipHash = (Get-FileHash -LiteralPath $ZipFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualZipHash -ne $expectedZipHash) { throw 'ZIP checksum mismatch' }

$expectedEntries = @(
    "$PackageName/asterctl-web"
    "$PackageName/yt-dlp"
    "$PackageName/asterctl-web.service"
    "$PackageName/install-asterctl-web.sh"
    "$PackageName/verify-package.sh"
    "$PackageName/brightness-probe.py"
    "$PackageName/PROXMOX-INSTALL.md"
    "$PackageName/SHA256SUMS"
    "$PackageName/version.txt"
    "$PackageName/LICENSE-MIT"
    "$PackageName/LICENSE-APACHE"
    "$PackageName/LICENSE-YT-DLP"
) | Sort-Object

$archive = [IO.Compression.ZipFile]::OpenRead($ZipFullPath)
try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    $entryNames = @($entries | ForEach-Object FullName)
    if (Compare-Object ($entryNames | Sort-Object) $expectedEntries) {
        throw 'ZIP file set does not match the approved package manifest'
    }
    if (($entryNames | Select-Object -Unique).Count -ne $entryNames.Count) {
        throw 'ZIP contains duplicate entries'
    }

    foreach ($entry in $entries) {
        if ($entry.FullName.Contains('..') -or $entry.FullName.Contains('\') -or
            $entry.FullName.StartsWith('/')) {
            throw "Unsafe ZIP path: $($entry.FullName)"
        }
        $attributes = [BitConverter]::ToUInt32(
            [BitConverter]::GetBytes([int]$entry.ExternalAttributes), 0
        )
        $mode = ($attributes -shr 16) -band 0xffff
        $executable = $entry.Name -in @('asterctl-web', 'yt-dlp', 'install-asterctl-web.sh', 'verify-package.sh', 'brightness-probe.py')
        $expectedMode = if ($executable) { 0x81ed } else { 0x81a4 }
        if ($mode -ne $expectedMode) {
            throw ('ZIP mode 0x{0:x4} is wrong for {1}' -f $mode, $entry.FullName)
        }
    }
} finally {
    $archive.Dispose()
}

$zipBytes = [IO.File]::ReadAllBytes($ZipFullPath)
$minimumOffset = [Math]::Max(0, $zipBytes.Length - 65557)
$eocdOffset = -1
for ($index = $zipBytes.Length - 22; $index -ge $minimumOffset; $index--) {
    if ($zipBytes[$index] -eq 0x50 -and $zipBytes[$index + 1] -eq 0x4b -and
        $zipBytes[$index + 2] -eq 0x05 -and $zipBytes[$index + 3] -eq 0x06) {
        $eocdOffset = $index
        break
    }
}
if ($eocdOffset -lt 0) { throw 'ZIP end-of-central-directory record was not found' }
$centralEntries = [BitConverter]::ToUInt16($zipBytes, $eocdOffset + 10)
$cursor = [int][BitConverter]::ToUInt32($zipBytes, $eocdOffset + 16)
if ($centralEntries -ne $expectedEntries.Count) { throw 'ZIP central entry count is inconsistent' }
for ($entryIndex = 0; $entryIndex -lt $centralEntries; $entryIndex++) {
    if ($zipBytes[$cursor] -ne 0x50 -or $zipBytes[$cursor + 1] -ne 0x4b -or
        $zipBytes[$cursor + 2] -ne 0x01 -or $zipBytes[$cursor + 3] -ne 0x02) {
        throw "Invalid ZIP central directory entry at offset $cursor"
    }
    if ($zipBytes[$cursor + 5] -ne 3) { throw 'ZIP entry was not marked as created on Unix' }
    $nameLength = [BitConverter]::ToUInt16($zipBytes, $cursor + 28)
    $extraLength = [BitConverter]::ToUInt16($zipBytes, $cursor + 30)
    $commentLength = [BitConverter]::ToUInt16($zipBytes, $cursor + 32)
    $cursor += 46 + $nameLength + $extraLength + $commentLength
}

if (Test-Path -LiteralPath $VerifyRoot) {
    Remove-Item -LiteralPath $VerifyRoot -Recurse -Force
}
[IO.Compression.ZipFile]::ExtractToDirectory($ZipFullPath, $VerifyRoot)
$PackageRoot = Join-Path $VerifyRoot $PackageName
$linuxRuntimeTextFiles = @(
    'asterctl-web.service'
    'install-asterctl-web.sh'
    'verify-package.sh'
    'brightness-probe.py'
    'PROXMOX-INSTALL.md'
    'SHA256SUMS'
    'version.txt'
)
foreach ($name in $linuxRuntimeTextFiles) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot $name))
    if ($bytes.Length -eq 0 -or $bytes[-1] -ne 0x0a -or $bytes -contains 0x0d) {
        throw "Packaged Linux text file must use LF line endings: $name"
    }
}
$checksumLines = Get-Content -LiteralPath (Join-Path $PackageRoot 'SHA256SUMS')
foreach ($line in $checksumLines) {
    if ($line -notmatch '^([0-9a-f]{64})  ([^/\\]+)$') {
        throw "Malformed SHA256SUMS line: $line"
    }
    $actual = (Get-FileHash -LiteralPath (Join-Path $PackageRoot $Matches[2]) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Matches[1]) { throw "Internal checksum mismatch: $($Matches[2])" }
}

$forbidden = Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force | Where-Object {
    $_.Name -match '\.(exe|dll|pdb)$' -or
    $_.Name -in @('.git', 'node_modules', 'target', '.playwright-cli', 'output')
}
if ($forbidden) { throw 'Package contains a forbidden Windows, build, or private-state file' }

$binaryPath = Join-Path $PackageRoot 'asterctl-web'
$header = [IO.File]::ReadAllBytes($binaryPath)
if ($header.Length -lt 20 -or $header[0] -ne 0x7f -or $header[1] -ne 0x45 -or
    $header[2] -ne 0x4c -or $header[3] -ne 0x46 -or $header[4] -ne 2 -or
    $header[5] -ne 1 -or $header[18] -ne 0x3e -or $header[19] -ne 0x00) {
    throw 'Extracted binary is not little-endian ELF64 x86_64'
}

$versionValues = @{}
foreach ($line in (Get-Content -LiteralPath (Join-Path $PackageRoot 'version.txt'))) {
    if ($line -match '^([^=]+)=(.*)$') { $versionValues[$Matches[1]] = $Matches[2] }
}
$binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($versionValues['BINARY_SHA256'] -ne $binaryHash) {
    throw 'version.txt BINARY_SHA256 does not match the packaged binary'
}
$ytDlpPath = Join-Path $PackageRoot 'yt-dlp'
$ytDlpHash = (Get-FileHash -LiteralPath $ytDlpPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($versionValues['YTDLP_VERSION'] -ne '2026.07.04' -or
    $versionValues['YTDLP_SHA256'] -ne $ytDlpHash -or
    $ytDlpHash -ne $ExpectedYtDlpSha256) {
    throw 'packaged yt-dlp version or official release checksum is wrong'
}
if ($versionValues['SOURCE_STATE'] -notin @('local-workspace', 'standalone-workspace') -or
    -not $versionValues.ContainsKey('SOURCE_COMMIT')) {
    throw 'version.txt source metadata is missing or invalid'
}
if ($versionValues['SOURCE_STATE'] -eq 'standalone-workspace' -and
    $versionValues['SOURCE_COMMIT'] -ne 'unavailable') {
    throw 'standalone package must record unavailable Git commit metadata explicitly'
}

$installerText = Get-Content -LiteralPath (Join-Path $PackageRoot 'install-asterctl-web.sh') -Raw
if ($installerText -notmatch '(?m)^\s+--device PATH\s+') {
    throw 'Packaged installer does not document --device PATH'
}
if ($installerText -notmatch '(?m)^\s+--bind-address IPv4\s+') {
    throw 'Packaged installer does not document private-address binding'
}
if ($installerText.Contains('0.0.0.0:8787')) {
    throw 'Packaged installer still contains a wildcard service bind'
}
if ($installerText.Contains('AOOSTAR USB 0416:90a1 is not visible')) {
    throw 'Packaged installer contains the obsolete mandatory udev VID/PID gate'
}
if (-not $installerText.Contains("YTDLP_EXPECTED_SHA256=`"$ExpectedYtDlpSha256`"") -or
    -not $installerText.Contains('verify_ytdlp_hash "$YTDLP_SOURCE"')) {
    throw 'Packaged installer does not pin and enforce the official yt-dlp checksum'
}
$installerHashCheck = $installerText.IndexOf('verify_ytdlp_hash "$YTDLP_SOURCE"', [StringComparison]::Ordinal)
$installerYtDlpExecution = $installerText.IndexOf('$YTDLP_SOURCE" --version', [StringComparison]::Ordinal)
if ($installerHashCheck -lt 0 -or $installerYtDlpExecution -lt 0 -or
    $installerHashCheck -ge $installerYtDlpExecution) {
    throw 'Packaged installer does not verify yt-dlp before executing it'
}
$verifierText = Get-Content -LiteralPath (Join-Path $PackageRoot 'verify-package.sh') -Raw
if (-not $verifierText.Contains("YTDLP_EXPECTED_SHA256=`"$ExpectedYtDlpSha256`"") -or
    -not $verifierText.Contains('verify_file_sha256 yt-dlp "$YTDLP_EXPECTED_SHA256"')) {
    throw 'Packaged Linux verifier does not pin and enforce the official yt-dlp checksum'
}
$verifierHashCheck = $verifierText.IndexOf('verify_file_sha256 yt-dlp "$YTDLP_EXPECTED_SHA256"', [StringComparison]::Ordinal)
$verifierYtDlpExecution = $verifierText.IndexOf('./yt-dlp --version', [StringComparison]::Ordinal)
if ($verifierHashCheck -lt 0 -or $verifierYtDlpExecution -lt 0 -or
    $verifierHashCheck -ge $verifierYtDlpExecution) {
    throw 'Packaged Linux verifier does not verify yt-dlp before executing it'
}
$guideText = Get-Content -LiteralPath (Join-Path $PackageRoot 'PROXMOX-INSTALL.md') -Raw
if (-not $guideText.Contains('--device /dev/ttyACM0')) {
    throw 'Packaged guide does not document explicit serial-device migration'
}
if (-not $guideText.Contains('systemctl disable --now asterctl-web') -or
    -not $guideText.Contains('systemctl enable --now asterctl-web')) {
    throw 'Packaged guide does not safely disable and restore OLED Studio around the reboot probe'
}
if (-not $guideText.Contains('--control-lines')) {
    throw 'Packaged guide does not document the opt-in serial control-line risk'
}
if ([regex]::Matches($guideText, 'systemctl disable --now asterctl-web').Count -lt 2 -or
    [regex]::Matches($guideText, 'sudo reboot').Count -lt 2) {
    throw 'Packaged guide does not restore the boot-animation baseline before the control-line probe'
}

$probeText = Get-Content -LiteralPath (Join-Path $PackageRoot 'brightness-probe.py') -Raw
if (-not $probeText.Contains('--control-lines') -or
    -not $probeText.Contains('argparse.ArgumentParser')) {
    throw 'Packaged brightness probe does not expose the safe help/opt-in CLI'
}
if ($probeText.Contains('beyond doubt') -or
    $probeText.Contains('cannot put the firmware into an unknown state')) {
    throw 'Packaged brightness probe contains an unsupported safety or causality claim'
}
if (-not $probeText.Contains('send_command_expect_ack') -or
    -not $probeText.Contains('send_frame_expect_ack') -or
    -not $probeText.Contains('if args.control_lines:')) {
    throw 'Packaged brightness probe does not enforce acknowledged stages and opt-in control lines'
}
if (-not $probeText.Contains('off_attempted = False') -or
    -not $probeText.Contains('DISPLAY_ON_AFTER_OFF') -or
    -not $probeText.Contains('termios.tcsetattr(fd, termios.TCSANOW, tty_attrs)')) {
    throw 'Packaged brightness probe does not restore display-on and tty state during cleanup'
}
if (-not $probeText.Contains('set_control_state(fd, control_state)')) {
    throw 'Packaged brightness probe does not restore the saved control-line state'
}
foreach ($deviceSafetyMarker in @(
    'device_path_allowed',
    'resolve_device_path',
    'CANONICAL_DEVICE_RE',
    'os.path.realpath',
    'stat.S_ISCHR',
    'O_NOFOLLOW'
)) {
    if (-not $probeText.Contains($deviceSafetyMarker)) {
        throw "Packaged brightness probe is missing device safety marker: $deviceSafetyMarker"
    }
}
$probeStageMarkers = @(
    'S1_port_open_changed',
    'S2_display_on_changed',
    'S3_white_dimmer_than_boot_animation',
    'S4_bars_dimmer_than_boot_animation',
    'S5_display_off_blanked',
    'S6_display_on_after_off_dimmer'
)
$previousProbeStage = -1
foreach ($marker in $probeStageMarkers) {
    $stageOffset = $probeText.IndexOf($marker, $previousProbeStage + 1, [StringComparison]::Ordinal)
    if ($stageOffset -lt 0) { throw ('Packaged brightness probe is missing ordered stage: ' + $marker) }
    $previousProbeStage = $stageOffset
}

$workspaceSources = @{
    'asterctl-web.service' = Join-Path $ProjectRoot 'linux/asterctl-web.service'
    'install-asterctl-web.sh' = Join-Path $ProjectRoot 'linux/install-asterctl-web.sh'
    'verify-package.sh' = Join-Path $ProjectRoot 'linux/verify-asterctl-web-package.sh'
    'brightness-probe.py' = Join-Path $ProjectRoot 'linux/brightness-probe.py'
    'PROXMOX-INSTALL.md' = Join-Path $ProjectRoot 'linux/PROXMOX-INSTALL.md'
}
foreach ($name in $workspaceSources.Keys) {
    $packagedHash = (Get-FileHash -LiteralPath (Join-Path $PackageRoot $name) -Algorithm SHA256).Hash
    $sourceHash = (Get-FileHash -LiteralPath $workspaceSources[$name] -Algorithm SHA256).Hash
    if ($packagedHash -ne $sourceHash) { throw "Packaged $name is stale" }
}

[pscustomobject]@{
    Zip = $ZipFullPath
    ZipSha256 = $actualZipHash
    Entries = $expectedEntries.Count
    InternalChecksums = $checksumLines.Count
    UnixModes = 'verified'
    UnixCreator = 'verified'
    PathSafety = 'verified'
    ForbiddenFiles = 0
    Binary = 'ELF64 x86_64'
    BinaryMetadataHash = 'verified'
    YtDlpOfficialHash = 'verified'
    LinuxLineEndings = 'verified'
    PrivateBindPolicy = 'verified'
    SerialDeviceMigration = 'verified'
    BrightnessProbeSafety = 'verified'
    WorkspaceSources = 'current'
    ExtractedRoot = $PackageRoot
}
