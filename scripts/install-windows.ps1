# install-windows.ps1 - Fleuron installer for Windows (this account only; no administrator rights).
# The copy in the repository is a template and refuses to run. CI renders the release asset with
# scripts/render-install-windows.sh, pinning the version and the setup file's SHA-256.
# Run: powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File install-windows.ps1 [--reinstall | --uninstall | --help]
# ASCII only (scripts/verify-ps1-ascii.sh). Works in Windows PowerShell 5.1 and PowerShell 7.
# Every action lives in a function and the last line is the only call, so a truncated file runs nothing.
# Design and threat model: docs/maintainers/TERMINAL-INSTALL.md, section 13.
Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$FleuronVersion = '__FLEURON_VERSION__'
$FleuronSetupSha256 = '__FLEURON_SETUP_SHA256__'

$script:SetupName = "Fleuron_${FleuronVersion}_x64-setup.exe"
$script:BaseUrl = "https://github.com/wilsonhyeh/fleuron/releases/download/v$FleuronVersion"
$script:IssueUrl = 'https://github.com/wilsonhyeh/fleuron/issues/new?template=install-help.yml'
$script:UninstallSubkey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
$script:ProductSubkey = 'Software\Fleuron\Fleuron'
$script:FleuronExit = 0
$script:TestMode = $false
$script:SystemRootDir = ''
$script:CurlExe = ''
$script:RegHKLM = 'HKLM:'
$script:RegHKCU = 'HKCU:'
$script:TimeoutSec = 900
$script:Work = ''
$script:SetupProc = $null

function Write-FleuronLog {
    param([string]$Message)
    [Console]::Error.WriteLine('fleuron-install: ' + $Message)
}

function Stop-Fleuron {
    param([int]$Code, [string]$Message, [switch]$Security, [switch]$Policy)
    $prefix = ''
    if ($Security) { $prefix = 'SECURITY STOP: ' }
    if ($Policy) { $prefix = 'POLICY STOP: ' }
    Write-FleuronLog ($prefix + $Message)
    $script:FleuronExit = $Code
    throw 'FLEURON-STOP'
}

function Show-FleuronUsage {
    $lines = @(
        'Usage: powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File install-windows.ps1 [OPTION]',
        '',
        'Install or uninstall Fleuron for this Windows account from the pinned GitHub release.',
        '',
        'Options:',
        '  (none)         Install Fleuron (or verify/upgrade an existing install)',
        '  --reinstall    Reinstall even if the pinned version is already installed',
        '  --uninstall    Remove Fleuron for this Windows account (studies are kept)',
        '  -h, --help     Show this help message and exit'
    )
    foreach ($l in $lines) { [Console]::Error.WriteLine($l) }
}

function Test-FleuronSemver { param([string]$Value) return ($Value -cmatch '^[0-9]+\.[0-9]+\.[0-9]+$') }
function Test-FleuronSha256 { param([string]$Value) return ($Value -cmatch '^[0-9a-f]{64}$') }

# Returns -1, 0 or 1.
function Compare-FleuronVersion {
    param([string]$Left, [string]$Right)
    $a = $Left.Split('.')
    $b = $Right.Split('.')
    for ($i = 0; $i -lt 3; $i++) {
        $x = [int]$a[$i]
        $y = [int]$b[$i]
        if ($x -lt $y) { return -1 }
        if ($x -gt $y) { return 1 }
    }
    return 0
}

function Test-FleuronTemplate {
    $marker = '__FLEURON' + '_'
    $bad = $FleuronVersion.Contains($marker) -or $FleuronSetupSha256.Contains($marker)
    if ($bad -or -not (Test-FleuronSemver $FleuronVersion) -or -not (Test-FleuronSha256 $FleuronSetupSha256)) {
        Stop-Fleuron -Code 2 -Message 'unrendered installer template; download install-windows.ps1 from the release page'
    }
}

function Get-FleuronTestValue {
    param([string]$Name)
    if (-not $script:TestMode) { return $null }
    return [System.Environment]::GetEnvironmentVariable($Name)
}

function Initialize-FleuronContext {
    $sysroot = $env:FLEURON_INSTALL_TEST_SYSROOT
    $regroot = $env:FLEURON_INSTALL_TEST_REGROOT
    if ($sysroot -or $regroot) {
        if (-not ($sysroot -and $regroot)) {
            Stop-Fleuron -Code 2 -Message 'incomplete test mode: set both FLEURON_INSTALL_TEST_SYSROOT and FLEURON_INSTALL_TEST_REGROOT'
        }
        $script:TestMode = $true
        Write-FleuronLog ('TEST MODE (sysroot=' + $sysroot + ', regroot=' + $regroot + ')')
        $script:SystemRootDir = $sysroot
        $script:RegHKLM = $regroot + '\HKLM'
        $script:RegHKCU = $regroot + '\HKCU'
        $t = Get-FleuronTestValue 'FLEURON_INSTALL_TEST_TIMEOUT_SEC'
        if ($t) { $script:TimeoutSec = [int]$t }
    } else {
        $script:SystemRootDir = "$env:SystemRoot"
    }
    if ($script:SystemRootDir) {
        $script:CurlExe = Join-Path $script:SystemRootDir 'System32\curl.exe'  # CURL-PATH
    }
}

function Test-FleuronElevated {
    if ($script:TestMode) { return ((Get-FleuronTestValue 'FLEURON_INSTALL_TEST_ELEVATED') -eq '1') }
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-FleuronPreflight {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        Stop-Fleuron -Code 3 -Message 'unsupported OS; this installer is for Windows only'
    }
    $v = $PSVersionTable.PSVersion
    if ($v.Major -lt 5 -or ($v.Major -eq 5 -and $v.Minor -lt 1)) {
        Stop-Fleuron -Code 3 -Message ('PowerShell 5.1 or newer is required (found ' + $v + ')')
    }
    $build = [System.Environment]::OSVersion.Version.Build
    $tb = Get-FleuronTestValue 'FLEURON_INSTALL_TEST_OSBUILD'
    if ($tb) { $build = [int]$tb }
    if ($build -lt 17763) {
        Stop-Fleuron -Code 3 -Message ('unsupported Windows build ' + $build + '; Windows 10 version 1809 or newer is required (Windows 11 recommended)')
    }
    if (Test-FleuronElevated) { Stop-Fleuron -Code 3 -Message 'Do not run this installer as administrator. Close this window, open PowerShell normally (not Run as administrator), and run it again. It never needs administrator rights.' }  # ELEVATION-GATE
    if (-not $env:LOCALAPPDATA -or -not [System.IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
        Stop-Fleuron -Code 3 -Message 'LOCALAPPDATA must be set to an absolute path'
    }
    if (-not $script:CurlExe -or -not (Test-Path -LiteralPath $script:CurlExe -PathType Leaf)) {
        Stop-Fleuron -Code 3 -Message ('curl.exe was not found at ' + $script:CurlExe + '; use option A (the setup file) from the install guide')
    }
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq 'ARM64') {
        Write-FleuronLog 'warning: Windows on ARM runs the x64 build under emulation (best effort, untested).'
    } elseif ($arch -ne 'AMD64') {
        Stop-Fleuron -Code 3 -Message ("unsupported processor architecture '" + $arch + "'; Fleuron ships an x64 build only")
    }
}

function Get-FleuronRegValue {
    param([string]$Key, [string]$Name)
    if (-not (Test-Path -LiteralPath $Key)) { return $null }
    $item = Get-ItemProperty -LiteralPath $Key -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    $prop = $item.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-FleuronUmciStatus {
    if ($script:TestMode) {
        $t = Get-FleuronTestValue 'FLEURON_INSTALL_TEST_DEVICEGUARD'
        if ($t) { return [int]$t }
        return 0
    }
    try {
        $dg = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName 'Win32_DeviceGuard' -ErrorAction Stop
        return [int]$dg.UsermodeCodeIntegrityPolicyEnforcementStatus
    } catch {
        return 0
    }
}

function Invoke-FleuronPolicyChecks {
    $ci = Join-Path $script:RegHKLM 'SYSTEM\CurrentControlSet\Control\CI\Policy'
    $sac = Get-FleuronRegValue -Key $ci -Name 'VerifiedAndReputablePolicyState'
    if ($sac -eq 1) { Stop-Fleuron -Code 30 -Policy -Message 'Smart App Control is on. It blocks apps that do not have a recognized publisher signature, and Fleuron does not have one yet. Smart App Control has no per-app exception and this installer will not change it. Do not disable Smart App Control to run Fleuron. Nothing was installed.' }  # SAC-GATE
    if ($sac -eq 2) { Write-FleuronLog 'warning: Smart App Control is in evaluation mode. If Windows later blocks Fleuron, see Stop here if in docs/INSTALLING.md.' }
    $sku = Get-FleuronRegValue -Key $ci -Name 'SkuPolicyRequired'
    if ($sku -eq 1) { Stop-Fleuron -Code 30 -Policy -Message 'Windows is in S mode, which runs Microsoft Store apps only. Fleuron is not supported in S mode, and we do not recommend leaving S mode for it. Nothing was installed.' }  # SMODE-GATE
    foreach ($root in @($script:RegHKLM, $script:RegHKCU)) {
        $sys = Join-Path $root 'SOFTWARE\Policies\Microsoft\Windows\System'
        $enabled = Get-FleuronRegValue -Key $sys -Name 'EnableSmartScreen'
        $level = "$(Get-FleuronRegValue -Key $sys -Name 'ShellSmartScreenLevel')"
        if ($enabled -eq 1 -and $level -eq 'Block') { Stop-Fleuron -Code 30 -Policy -Message 'your organization set Microsoft Defender SmartScreen to block unrecognized apps on this PC. This installer follows that policy. Contact your IT department and share docs/IT-DEPLOYMENT.md. Nothing was installed.' }  # SMARTSCREEN-POLICY-GATE
    }
    $umci = Get-FleuronUmciStatus
    if ($umci -eq 2) { Stop-Fleuron -Code 30 -Policy -Message 'App Control for Business (WDAC) enforces user-mode code integrity on this PC, and Fleuron is not on its allow list. Contact your IT department and share docs/IT-DEPLOYMENT.md. Nothing was installed.' }  # WDAC-GATE
    $srp = Join-Path $script:RegHKLM 'SOFTWARE\Policies\Microsoft\Windows\SrpV2\Exe'
    if ((Get-FleuronRegValue -Key $srp -Name 'EnforcementMode') -eq 1) {
        Write-FleuronLog 'warning: AppLocker executable rules are enforced on this PC; if Windows blocks the setup file, contact your IT department.'
    }
}

function Get-FleuronInstallState {
    $uk = Join-Path $script:RegHKCU $script:UninstallSubkey
    $pk = Join-Path $script:RegHKCU $script:ProductSubkey
    $dir = "$(Get-FleuronRegValue -Key $pk -Name '(default)')"
    $location = "$(Get-FleuronRegValue -Key $uk -Name 'InstallLocation')".Trim('"')
    if (-not $dir) { $dir = $location }
    if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Fleuron' }
    $exe = Join-Path $dir 'Fleuron.exe'
    $state = @{
        Dir = $dir
        Exe = $exe
        Uninstaller = (Join-Path $dir 'uninstall.exe')
        UninstallKey = $uk
        Registered = (Test-Path -LiteralPath $uk)
        UninstallString = "$(Get-FleuronRegValue -Key $uk -Name 'UninstallString')".Trim('"')
        Present = $false
        Version = ''
        ProductName = ''
        MachineWide = $false
    }
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $state.Present = $true
        $vi = (Get-Item -LiteralPath $exe -Force).VersionInfo
        $state.Version = '{0}.{1}.{2}' -f $vi.FileMajorPart, $vi.FileMinorPart, $vi.FileBuildPart
        $state.ProductName = "$($vi.ProductName)".Trim()
    }
    foreach ($sub in @('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron', 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron')) {
        if (Test-Path -LiteralPath (Join-Path $script:RegHKLM $sub)) { $state.MachineWide = $true }
    }
    if ($env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Fleuron\Fleuron.exe'))) { $state.MachineWide = $true }
    return $state
}

function Test-FleuronReparsePoint {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Test-FleuronDirWritable {
    param([string]$Dir)
    $probe = Join-Path $Dir ('.fleuron-install-probe-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        [System.IO.File]::WriteAllText($probe, 'probe')
        Remove-Item -LiteralPath $probe -Force
        return $true
    } catch {
        return $false
    }
}

function Assert-FleuronInstallSafe {
    param($State)
    if ($State.MachineWide) { Stop-Fleuron -Code 5 -Message 'Fleuron is installed for all users on this PC (by IT or another administrator). This installer manages per-user installs only and will not add a second copy. Ask whoever installed it.' }  # MACHINE-WIDE-GATE
    if ((Test-FleuronReparsePoint $State.Dir) -or (Test-FleuronReparsePoint $State.Exe)) { Stop-Fleuron -Code 5 -Message ($State.Dir + ' is a link (junction or symbolic link); refusing to modify it (another account or IT may manage it)') }  # OWNERSHIP-GATE
    if ($State.Present -and $State.ProductName -and $State.ProductName -ne 'Fleuron') {
        Stop-Fleuron -Code 5 -Message ($State.Exe + ' is a different app (product name: ' + $State.ProductName + '); refusing to modify it')
    }
    if ($State.UninstallString -and $State.UninstallString -ne $State.Uninstaller) {
        Stop-Fleuron -Code 5 -Message ('the registered uninstaller (' + $State.UninstallString + ') is not inside ' + $State.Dir + '; refusing to continue')
    }
    if ((Test-Path -LiteralPath $State.Dir -PathType Container) -and -not (Test-FleuronDirWritable $State.Dir)) {
        Stop-Fleuron -Code 5 -Message ($State.Dir + ' is not writable; another account or IT installed it')
    }
}

function Assert-FleuronNotRunning {
    $running = @(Get-Process -Name 'Fleuron' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) { Stop-Fleuron -Code 4 -Message 'Fleuron is running. Quit Fleuron, then run this again.' }  # RUNNING-GATE
}

function Invoke-FleuronCurl {
    param([string]$Url, [string]$OutFile, [switch]$Progress)
    $curlArgs = @('--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '900', '--show-error')
    if ($Progress) { $curlArgs += '--progress-bar' } else { $curlArgs += '--silent' }
    $curlArgs += @('--output', $OutFile, $Url)
    & $script:CurlExe @curlArgs | Out-Null
    return $LASTEXITCODE
}

function Test-FleuronSumsFile {
    param([string]$Path)
    $matchName = 0
    $matchExact = 0
    foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
        $line = $raw.TrimEnd("`r").Trim()
        if (-not $line) { continue }
        $parts = $line -split '\s+', 2
        if ($parts.Count -lt 2) { continue }
        $h = $parts[0]
        $n = $parts[1].TrimStart('*')
        if ($n -ceq $script:SetupName) {
            $matchName++
            if ($h -ceq $FleuronSetupSha256) { $matchExact++ }
        }
    }
    if ($matchName -ne 1 -or $matchExact -ne 1) { Stop-Fleuron -Code 20 -Security -Message ('SHA256SUMS.txt does not match the pinned hash for ' + $script:SetupName + '. Nothing was installed.') }  # SUMS-GATE
}

# Hash with .NET, not Get-FileHash: the cmdlet needs Microsoft.PowerShell.Utility to
# autoload, and that can fail when powershell.exe is started from a shell carrying a
# PowerShell 7 module path (the installer then died with "Get-FileHash is not
# recognized"). ComputeHash is the same SHA-256 over the same bytes, in every host.
function Get-FleuronFileSha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $bytes = $sha.ComputeHash($stream)
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
    $hex = ''
    foreach ($b in $bytes) { $hex = $hex + $b.ToString('x2') }
    return $hex
}

# 1260 ERROR_ACCESS_DISABLED_BY_POLICY, 4551 ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION,
# 225 ERROR_VIRUS_INFECTED, 226 ERROR_VIRUS_DELETED. Mapping is unverified on Windows.
function Get-FleuronLaunchFailureCode {
    param([int]$NativeError)
    if (@(1260, 4551, 225, 226) -contains $NativeError) { return 30 }
    return 50
}

function Invoke-FleuronSetup {
    param([string]$SetupPath)
    try {
        $script:SetupProc = Start-Process -FilePath $SetupPath -ArgumentList '/S' -PassThru
    } catch {
        $native = 0
        $e = $_.Exception
        while ($null -ne $e) {
            if ($e -is [System.ComponentModel.Win32Exception]) { $native = $e.NativeErrorCode; break }
            $e = $e.InnerException
        }
        if ((Get-FleuronLaunchFailureCode -NativeError $native) -eq 30) {
            Stop-Fleuron -Code 30 -Policy -Message ('Windows refused to start the verified setup file (error ' + $native + '). Smart App Control, Microsoft Defender, or a device policy blocked it. Do not restore or allow the file. File an install issue: ' + $script:IssueUrl)
        }
        Stop-Fleuron -Code 50 -Message ('could not start the setup file: ' + $_.Exception.Message)
    }
    $null = $script:SetupProc.Handle
    if (-not $script:SetupProc.WaitForExit($script:TimeoutSec * 1000)) {
        Stop-Fleuron -Code 50 -Message ('the setup file did not finish within ' + $script:TimeoutSec + ' seconds and was stopped; run this again or use option A')
    }
    $rc = $script:SetupProc.ExitCode
    $script:SetupProc = $null
    if ($rc -ne 0) {
        Stop-Fleuron -Code 50 -Message ('the setup file exited with code ' + $rc + '; Fleuron may not be installed. Run this again, or use option A from the install guide.')
    }
}

function New-FleuronWorkDir {
    $base = [System.IO.Path]::GetTempPath()
    $script:Work = Join-Path $base ('fleuron-install.' + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Path $script:Work | Out-Null
}

function Invoke-FleuronInstall {
    param([bool]$Reinstall)
    Invoke-FleuronPolicyChecks
    Assert-FleuronNotRunning
    $state = Get-FleuronInstallState
    Assert-FleuronInstallSafe -State $state
    if ($state.Present -and $state.Version -ne '0.0.0' -and (Test-FleuronSemver $state.Version)) {
        $cmp = Compare-FleuronVersion $state.Version $FleuronVersion
        if ($cmp -gt 0) {
            Write-FleuronLog ('newer version ' + $state.Version + ' already installed at ' + $state.Dir + '; nothing to do.')
            return
        }
        if ($cmp -eq 0 -and -not $Reinstall) {
            if ($state.Registered -and (Test-Path -LiteralPath $state.Uninstaller -PathType Leaf)) {
                Write-FleuronLog ('Fleuron ' + $FleuronVersion + ' is already installed at ' + $state.Dir + '; nothing to do.')
                return
            }
            Write-FleuronLog ('existing Fleuron ' + $FleuronVersion + ' at ' + $state.Dir + ' is incomplete; repairing.')
        }
    }
    Write-FleuronLog ('Fleuron ' + $FleuronVersion + ' installer for Windows (x64)')
    Write-FleuronLog ('install location: ' + $state.Dir)
    New-FleuronWorkDir
    $sums = Join-Path $script:Work 'SHA256SUMS.txt'
    if ((Invoke-FleuronCurl -Url ($script:BaseUrl + '/SHA256SUMS.txt') -OutFile $sums) -ne 0) {
        Stop-Fleuron -Code 10 -Message 'could not download the release checksum list; nothing was installed'
    }
    Test-FleuronSumsFile -Path $sums
    Write-FleuronLog 'checking the release checksum list ... ok'
    Write-FleuronLog ('downloading ' + $script:SetupName + ' ...')
    $partial = Join-Path $script:Work ($script:SetupName + '.download')
    if ((Invoke-FleuronCurl -Url ($script:BaseUrl + '/' + $script:SetupName) -OutFile $partial -Progress) -ne 0) {
        Stop-Fleuron -Code 10 -Message 'download failed or was cut off; nothing was installed'
    }
    if (-not (Test-Path -LiteralPath $partial -PathType Leaf)) {
        Stop-Fleuron -Code 30 -Policy -Message ('the downloaded setup file is missing or unreadable. Security software such as Microsoft Defender may have removed it. Do not restore or allow the file. Nothing was installed. File an install issue: ' + $script:IssueUrl)
    }
    $h = Get-FleuronFileSha256 -Path $partial
    if ($h -cne $FleuronSetupSha256) { Stop-Fleuron -Code 20 -Security -Message ('downloaded setup file hash (' + $h + ') does not match pinned release value (' + $FleuronSetupSha256 + '). Do not run this file. Nothing was installed. Report it: ' + $script:IssueUrl) }  # CHECKSUM-GATE
    Write-FleuronLog 'SHA-256 matches the pinned release value ... ok'
    $setup = Join-Path $script:Work $script:SetupName
    Move-Item -LiteralPath $partial -Destination $setup
    $zone = Get-Item -LiteralPath $setup -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
    if ($null -ne $zone) { Stop-Fleuron -Code 30 -Policy -Message 'Windows marked the downloaded setup file as coming from the internet (Zone.Identifier), which this installer never expects for a curl.exe download. Security software or a device policy on this PC may be adding the mark. This installer will not remove the mark. Use option A in the install guide (double-click the setup file) instead. Nothing was installed.' }  # MOTW-GATE
    Write-FleuronLog 'running the verified setup file for this Windows account (no administrator rights) ...'
    Invoke-FleuronSetup -SetupPath $setup
    $after = Get-FleuronInstallState
    if (-not $after.Present -or $after.Version -ne $FleuronVersion) {
        Stop-Fleuron -Code 50 -Message ('setup finished but Fleuron ' + $FleuronVersion + ' was not found at ' + $after.Dir)
    }
    Write-FleuronLog ('installed Fleuron ' + $FleuronVersion + ' to ' + $after.Dir)
    Write-FleuronLog "done. Open Fleuron from the Start menu. Later updates arrive through Fleuron's built-in updater."
}

function Invoke-FleuronUninstall {
    $state = Get-FleuronInstallState
    if (-not $state.Present -and -not $state.Registered -and -not $state.MachineWide) {
        Write-FleuronLog 'Fleuron is not installed for this Windows account.'
        return
    }
    Assert-FleuronInstallSafe -State $state
    Assert-FleuronNotRunning
    if (-not (Test-Path -LiteralPath $state.Uninstaller -PathType Leaf)) {
        Stop-Fleuron -Code 50 -Message ('the uninstaller is missing from ' + $state.Dir + '; remove Fleuron from Settings > Apps > Installed apps')
    }
    try {
        $p = Start-Process -FilePath $state.Uninstaller -ArgumentList '/S' -PassThru
    } catch {
        Stop-Fleuron -Code 50 -Message ('could not start the uninstaller: ' + $_.Exception.Message)
    }
    $null = $p.Handle
    [void]$p.WaitForExit($script:TimeoutSec * 1000)
    $deadline = (Get-Date).AddSeconds($script:TimeoutSec)
    while ((Test-Path -LiteralPath $state.Exe) -or (Test-Path -LiteralPath $state.UninstallKey)) {
        if ((Get-Date) -gt $deadline) { Stop-Fleuron -Code 50 -Message 'the uninstaller did not finish removing Fleuron' }
        Start-Sleep -Milliseconds 500
    }
    Write-FleuronLog ('removed Fleuron from ' + $state.Dir)
    Write-FleuronLog 'Your studies (%USERPROFILE%\Fleuron by default) and settings (%APPDATA%\study.fleuron.desktop) were not touched.'
}

function Invoke-FleuronCleanup {
    if ($null -ne $script:SetupProc) {
        try {
            if (-not $script:SetupProc.HasExited) {
                Stop-Process -Id $script:SetupProc.Id -Force -ErrorAction SilentlyContinue
                [void]$script:SetupProc.WaitForExit(10000)
            }
        } catch { }
        $script:SetupProc = $null
    }
    if ($script:Work -and (Test-Path -LiteralPath $script:Work)) {
        # Retry: antivirus can hold the just-run setup file open for a moment, and a
        # failed removal would leave a downloaded installer behind in %TEMP%.
        for ($i = 0; $i -lt 5; $i++) {
            Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $script:Work)) { break }
            Start-Sleep -Milliseconds 200
        }
    }
}

function Invoke-FleuronCore {
    param([string[]]$ArgList)
    Initialize-FleuronContext
    if ($null -eq $ArgList) { $ArgList = @() }
    $mode = 'install'
    $reinstall = $false
    foreach ($a in $ArgList) {
        if ($a -match '\.(exe|msi)$' -or $a -match '[\\/:]' -or $a.StartsWith('~')) {
            Stop-Fleuron -Code 2 -Message 'This installer never uses a setup file you already have; it downloads and verifies its own copy.'
        }
    }
    if ($ArgList.Count -gt 1) { Stop-Fleuron -Code 2 -Message 'too many arguments (run with --help for usage)' }
    if ($ArgList.Count -eq 1) {
        $a = $ArgList[0]
        if (@('--help', '-h', '-help') -contains $a) { Show-FleuronUsage; return }
        elseif (@('--uninstall', '-uninstall') -contains $a) { $mode = 'uninstall' }
        elseif (@('--reinstall', '-reinstall') -contains $a) { $reinstall = $true }
        else { Stop-Fleuron -Code 2 -Message ("unknown option '" + $a + "' (run with --help for usage)") }
    }
    if ($mode -eq 'install') { Test-FleuronTemplate }
    Invoke-FleuronPreflight
    if ($mode -eq 'uninstall') { Invoke-FleuronUninstall } else { Invoke-FleuronInstall -Reinstall $reinstall }
}

function Invoke-FleuronMain {
    param([string[]]$ArgList)
    $lang = "$($ExecutionContext.SessionState.LanguageMode)"
    if ($env:FLEURON_INSTALL_TEST_SYSROOT -and $env:FLEURON_INSTALL_TEST_REGROOT -and $env:FLEURON_INSTALL_TEST_LANGMODE) { $lang = $env:FLEURON_INSTALL_TEST_LANGMODE }
    if ($lang -ne 'FullLanguage') { Write-Host ('fleuron-install: POLICY STOP: PowerShell is running in ' + $lang + ' mode, which means an application control policy (App Control for Business/WDAC or AppLocker) manages this PC. Fleuron is not approved by that policy. Contact your IT department and share docs/IT-DEPLOYMENT.md. Nothing was installed.'); exit 30 }  # LANGMODE-GATE
    $script:FleuronExit = 0
    try {
        Invoke-FleuronCore -ArgList $ArgList
    } catch {
        if ("$($_.Exception.Message)" -ne 'FLEURON-STOP') {
            Write-FleuronLog ('unexpected error: ' + $_.Exception.Message)
            $script:FleuronExit = 50
        }
    } finally {
        Invoke-FleuronCleanup
    }
    exit $script:FleuronExit
}

Invoke-FleuronMain -ArgList $args
