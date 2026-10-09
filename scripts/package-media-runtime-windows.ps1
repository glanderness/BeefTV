#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$ArchivePath
)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Native Windows packaging is required" }
$version = "8.0.1"
$url = "https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip"
$sha = "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673"
if (Test-Path -LiteralPath $Destination) { throw "Refusing to overwrite media runtime: $Destination" }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("beeftv-media-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    if (-not $ArchivePath) {
        $ArchivePath = Join-Path $scratch "upstream.zip"
        Invoke-WebRequest -Uri $url -OutFile $ArchivePath -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) { throw "FFmpeg archive checksum mismatch" }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath (Join-Path $scratch "unpacked")
    $upstream = Join-Path $scratch "unpacked\ffmpeg-8.0.1-essentials_build"
    $stage = Join-Path $scratch "media-runtime"
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -LiteralPath (Join-Path $upstream "bin\ffmpeg.exe") -Destination $stage
    Copy-Item -LiteralPath (Join-Path $upstream "LICENSE") -Destination $stage
    Copy-Item -LiteralPath (Join-Path $upstream "README.txt") -Destination $stage
    $binary = Join-Path $stage "ffmpeg.exe"
    $info = & $binary -version
    if ($LASTEXITCODE -ne 0 -or $info[0] -notmatch '^ffmpeg version 8\.0\.1-essentials_build') { throw "Unexpected FFmpeg runtime" }
    # Relocated native conversion works with no globally installed media tools.
    & $binary -nostdin -hide_banner -loglevel error -f lavfi -i "color=c=red:s=64x48:r=5:d=0.4" -threads 2 -c:v libx264 -pix_fmt yuv420p -y (Join-Path $scratch "probe.mp4")
    if ($LASTEXITCODE -ne 0) { throw "Bundled FFmpeg H.264 smoke failed" }
    $manifest = [ordered]@{version=$version; archiveURL=$url; archiveSHA256=$sha; binarySHA256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant(); license="GPL-3.0-or-later"; source="https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d"}
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "manifest.json") -Encoding UTF8
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($Destination))) -Force | Out-Null
    Copy-Item -LiteralPath $stage -Destination $Destination -Recurse
    Write-Host "Packaged FFmpeg $version ($((Get-Item -LiteralPath $binary).Length) bytes)"
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
