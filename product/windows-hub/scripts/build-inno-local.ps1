<#
.SYNOPSIS
    Build local 聚元灵创 Inno installers for quick validation.

.DESCRIPTION
    Publishes the tray app into a production-style layout, then runs ISCC to
    create local unsigned installers.

    Use -NoPublish after changing only installer.iss or docs/tests; it reuses
    the existing publish-local-* payloads and only recompiles Inno.

    .EXAMPLE
    .\scripts\build-inno-local.ps1 -Arch x64 -ProductApiBaseUrl https://app.example.com -Fast
    .\scripts\build-inno-local.ps1 -Arch x64 -ProductApiBaseUrl http://192.168.120.12:8787 -Dev -Fast
    .\scripts\build-inno-local.ps1 -Arch All -ProductApiBaseUrl https://app.example.com
    .\scripts\build-inno-local.ps1 -Arch x64 -NoPublish -Fast
#>

[CmdletBinding()]
param(
    [ValidateSet("x64", "arm64", "All")]
    [string]$Arch = "x64",

    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",

    [string]$Version,

    [string]$ProductApiBaseUrl,

    [switch]$NoPublish,

    [switch]$Fast,

    [switch]$Dev,

    [switch]$InstallInno
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Write-Step {
    param([string]$Message)
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Resolve-InnoCompiler {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    if ($InstallInno) {
        Write-Step "Installing Inno Setup with winget"
        winget install --id JRSoftware.InnoSetup -e --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-Host
        $wingetExitCode = $LASTEXITCODE
        if ($wingetExitCode -ne 0) {
            throw "winget failed to install Inno Setup."
        }
        return Resolve-InnoCompiler
    }

    throw "Inno Setup compiler (ISCC.exe) was not found. Install it, or rerun with -InstallInno."
}

function Get-RidForArch {
    param([string]$Architecture)
    if ($Architecture -eq "arm64") {
        return "win-arm64"
    }
    return "win-x64"
}

function Test-PrivateOrLocalHost {
    param([string]$HostName)

    if ([string]::IsNullOrWhiteSpace($HostName)) {
        return $false
    }
    if ($HostName -ieq "localhost") {
        return $true
    }

    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($HostName, [ref]$address)) {
        return $false
    }
    if ([System.Net.IPAddress]::IsLoopback($address)) {
        return $true
    }
    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $bytes = $address.GetAddressBytes()
        return ($bytes[0] -eq 10) -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
            ($bytes[0] -eq 169 -and $bytes[1] -eq 254)
    }
    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        return $address.IsIPv6LinkLocal -or $address.IsIPv6SiteLocal -or $address.IsIPv6UniqueLocal
    }
    return $false
}

function Test-DevHttpHostAllowed {
    param([Uri]$Uri)
    return $Uri.IsLoopback -or (Test-PrivateOrLocalHost $Uri.Host)
}

function Publish-ArchitecturePayload {
    param(
        [string]$Architecture,
        [string]$RuntimeIdentifier,
        [string]$PublishVersion
    )

    $publishDir = Join-Path $repoRoot "publish-local-$Architecture"

    Write-Step "Publishing $Architecture payload"
    Remove-Item -LiteralPath $publishDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $publishDir | Out-Null

    $configuredProductApiUrl = $ProductApiBaseUrl
    if (-not $configuredProductApiUrl) {
        if ($Dev) {
            throw "Product API URL is empty. Pass -ProductApiBaseUrl http://192.168.x.x:8787 for Dev LAN builds."
        }
        throw "Product API URL is empty. Pass -ProductApiBaseUrl https://your-public-product-host before publishing."
    }

    $configuredUri = [Uri]$configuredProductApiUrl
    if ($Dev) {
        $isHttp = $configuredUri.Scheme -eq "http"
        $isHttps = $configuredUri.Scheme -eq "https"
        if (-not $isHttp -and -not $isHttps) {
            throw "Dev ProductApiBaseUrl must use http or https."
        }
        if ($isHttp -and -not (Test-DevHttpHostAllowed $configuredUri)) {
            throw "Dev HTTP ProductApiBaseUrl must target localhost or a private LAN address."
        }
    }
    elseif ($configuredUri.Scheme -ne "https" -or $configuredUri.IsLoopback -or (Test-PrivateOrLocalHost $configuredUri.Host)) {
        throw "Release ProductApiBaseUrl must be a public HTTPS URL."
    }

    $trayPublishArgs = @(
        ".\src\OpenClaw.Tray.WinUI\OpenClaw.Tray.WinUI.csproj",
        "-c", $Configuration,
        "-r", $RuntimeIdentifier,
        "--self-contained",
        "-o", $publishDir,
        "-v:minimal",
        "-p:DevBuild=$($Dev.IsPresent.ToString().ToLowerInvariant())",
        "-p:ProductApiBaseUrl=$($configuredUri.AbsoluteUri.TrimEnd('/'))"
    )
    if ($PublishVersion) {
        $trayPublishArgs += "-p:Version=$PublishVersion"
    }

    dotnet publish @trayPublishArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Tray publish failed for $Architecture."
    }
}

function Assert-PayloadReady {
    param([string]$Architecture)

    $publishDir = Join-Path $repoRoot "publish-local-$Architecture"
    $trayExe = Join-Path $publishDir "JuyuanLingchuang.exe"

    if (-not (Test-Path -LiteralPath $trayExe)) {
        throw "Missing tray payload at $trayExe. Rerun without -NoPublish."
    }

    $identityMarker = Join-Path $publishDir "app-identity.txt"
    $expectedIdentity = if ($Dev) { "dev" } else { "release" }
    if (-not (Test-Path -LiteralPath $identityMarker)) {
        throw "Missing payload identity marker at $identityMarker. Rerun without -NoPublish."
    }
    $actualIdentity = (Get-Content -LiteralPath $identityMarker -Raw).Trim()
    if ($actualIdentity -ne $expectedIdentity) {
        throw "Payload identity '$actualIdentity' does not match requested '$expectedIdentity' installer. Rerun without -NoPublish."
    }

    $setupExe = Get-ChildItem -LiteralPath $publishDir -Recurse -File -Filter "OpenClaw.SetupEngine.UI.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($setupExe) {
        throw "SetupEngine.UI.exe should not be present in the installer payload: $($setupExe.FullName)"
    }

    return $publishDir
}

function Invoke-InnoCompiler {
    param(
        [string]$InnoCompiler,
        [string]$Architecture,
        [string]$PublishDir,
        [string]$InstallerVersion
    )

    Write-Step "Compiling $Architecture installer"

    $args = @(
        "/DMyAppVersion=$InstallerVersion",
        "/DMyAppArch=$Architecture",
        "/Dpublish=$PublishDir"
    )

    if ($Fast) {
        $args += "/DMyCompression=zip"
        $args += "/DMySolidCompression=no"
    }

    if ($Dev) {
        $args += "/DDevBuild=1"
    }

    $args += ".\installer.iss"

    & $InnoCompiler @args
    if ($LASTEXITCODE -ne 0) {
        throw "ISCC failed for $Architecture."
    }
}

$versionWasProvided = $PSBoundParameters.ContainsKey("Version")

if (-not $Version) {
    $versionScript = Join-Path $PSScriptRoot "Get-OpenClawVersion.ps1"
    $Version = & $versionScript -Variable SemVer
}

if (-not $Version) {
    throw "Could not determine a version. Pass -Version explicitly."
}

$iscc = Resolve-InnoCompiler
$architectures = if ($Arch -eq "All") { @("x64", "arm64") } else { @($Arch) }

Write-Step "Using ISCC: $iscc"
Write-Host "Version: $Version"
Write-Host "Configuration: $Configuration"
Write-Host "Identity: $(if ($Dev) { 'dev' } else { 'release' })"
Write-Host "Fast compression: $($Fast.IsPresent)"
Write-Host "No publish: $($NoPublish.IsPresent)"

foreach ($architecture in $architectures) {
    $rid = Get-RidForArch $architecture
    if (-not $NoPublish) {
        $publishVersion = if ($versionWasProvided) { $Version } else { $null }
        Publish-ArchitecturePayload -Architecture $architecture -RuntimeIdentifier $rid -PublishVersion $publishVersion
    }

    $payload = Assert-PayloadReady $architecture
    Invoke-InnoCompiler -InnoCompiler $iscc -Architecture $architecture -PublishDir $payload -InstallerVersion $Version
}

Write-Step "Built installers"
Get-ChildItem -Path (Join-Path $repoRoot "Output\JuyuanLingchuang*-Setup-*.exe") |
    Sort-Object Name |
    ForEach-Object {
        "{0}`t{1:N2} MB`t{2}" -f $_.FullName, ($_.Length / 1MB), $_.LastWriteTime
    }
