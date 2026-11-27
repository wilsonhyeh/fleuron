# Mocked offline test suite for scripts/install-windows.ps1.
# ASCII only (scripts/verify-ps1-ascii.sh).
# Runs under Windows PowerShell 5.1, pwsh 7 on Windows, and pwsh on Linux.
# Static, unit, truncation, and non-Windows checks run everywhere; runtime and
# gate-mutation checks require Windows and run on windows-latest CI.

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$Template = Join-Path (Join-Path $Root 'scripts') 'install-windows.ps1'

$script:PassCount = 0
$script:FailCount = 0
$script:SkipCount = 0

function Pass {
    param([string]$Id, [string]$Msg)
    Write-Host ("  PASS {0}: {1}" -f $Id, $Msg)
    $script:PassCount++
}

function Fail {
    param([string]$Id, [string]$Msg)
    Write-Host ("  FAIL {0}: {1}" -f $Id, $Msg)
    $script:FailCount++
}

function Skip {
    param([string]$Id, [string]$Why)
    Write-Host ("  SKIP {0}: {1}" -f $Id, $Why)
    $script:SkipCount++
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Sha256Lower {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Render-Installer {
    param(
        [string]$TemplatePath,
        [string]$Version,
        [string]$Sha256,
        [string]$OutPath
    )
    $raw = [System.IO.File]::ReadAllText($TemplatePath)
    $nl = "`n"
    if ($raw.Contains("`r`n")) { $nl = "`r`n" }
    $lines = $raw -split "`r?`n"

    $verTarget = '$FleuronVersion = ''__FLEURON_VERSION__'''
    $shaTarget = '$FleuronSetupSha256 = ''__FLEURON_SETUP_SHA256__'''
    $verRepl = '$FleuronVersion = ''' + $Version + ''''
    $shaRepl = '$FleuronSetupSha256 = ''' + $Sha256 + ''''

    $verHits = 0
    $shaHits = 0
    $outLines = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ($line -ceq $verTarget) {
            $verHits++
            $outLines.Add($verRepl)
        } elseif ($line -ceq $shaTarget) {
            $shaHits++
            $outLines.Add($shaRepl)
        } else {
            $outLines.Add($line)
        }
    }
    if ($verHits -ne 1) {
        throw ("expected 1 version placeholder line, found " + $verHits)
    }
    if ($shaHits -ne 1) {
        throw ("expected 1 sha256 placeholder line, found " + $shaHits)
    }
    $renderedText = $outLines -join $nl
    if ($renderedText.Contains('__FLEURON_')) {
        throw 'unreplaced __FLEURON_ token remains after rendering'
    }
    Write-Utf8NoBom -Path $OutPath -Text $renderedText
}

function Remove-ReparsePointsUnder {
    param([string]$RootPath)
    if (-not (Test-Path -LiteralPath $RootPath)) { return }
    try {
        $items = @(Get-ChildItem -LiteralPath $RootPath -Recurse -Force -ErrorAction SilentlyContinue)
        for ($i = $items.Count - 1; $i -ge 0; $i--) {
            $it = $items[$i]
            if ([bool]($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                if ($it.PSIsContainer) {
                    [System.IO.Directory]::Delete($it.FullName)
                } else {
                    [System.IO.File]::Delete($it.FullName)
                }
            }
        }
    } catch { }
}

function Read-TextShared {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
        try {
            return $sr.ReadToEnd()
        } finally {
            $sr.Dispose()
        }
    } finally {
        $fs.Dispose()
    }
}

function Invoke-ShellFile {
    param(
        [string]$ShellExe,
        [string]$ScriptPath,
        [string[]]$ArgList,
        [hashtable]$ExtraEnv,
        [switch]$UseExecutionPolicy,
        [int]$TimeoutMs = 180000
    )
    if ($null -eq $ArgList) { $ArgList = @() }
    if ($null -eq $ExtraEnv) { $ExtraEnv = @{} }

    $saved = @{}
    foreach ($k in $ExtraEnv.Keys) {
        $saved[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
        $val = $ExtraEnv[$k]
        if ($null -eq $val) {
            [System.Environment]::SetEnvironmentVariable($k, $null, 'Process')
        } else {
            [System.Environment]::SetEnvironmentVariable($k, [string]$val, 'Process')
        }
    }

    $callId = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $outFile = Join-Path $T ('child_stdout_' + $callId + '.txt')
    $errFile = Join-Path $T ('child_stderr_' + $callId + '.txt')

    $rc = -1
    $combined = ''
    try {
        $parts = New-Object System.Collections.Generic.List[string]
        $parts.Add('-NoProfile')
        $parts.Add('-NonInteractive')
        if ($UseExecutionPolicy) {
            $parts.Add('-ExecutionPolicy')
            $parts.Add('RemoteSigned')
        }
        $parts.Add('-File')
        $parts.Add(('"' + $ScriptPath + '"'))
        foreach ($a in $ArgList) {
            $parts.Add(('"' + $a.Replace('"', '\"') + '"'))
        }
        $argStr = $parts -join ' '

        $p = Start-Process -FilePath $ShellExe -ArgumentList $argStr -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -NoNewWindow
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutMs)) {
            if ($IsWin) {
                & taskkill /T /F /PID $p.Id 2>&1 | Out-Null
            } else {
                try { $p.Kill() } catch { }
            }
            $rc = -1
        } else {
            $p.WaitForExit()
            $rc = $p.ExitCode
        }
    } finally {
        foreach ($k in $saved.Keys) {
            [System.Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process')
        }
    }

    $combined = (Read-TextShared -Path $outFile) + (Read-TextShared -Path $errFile)
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    return @{ ExitCode = $rc; Out = $combined }
}

function Test-S3AstShape {
    param($Ast)
    if ($null -eq $Ast -or $null -eq $Ast.EndBlock) { return $false }
    if ($null -ne $Ast.ParamBlock -or $null -ne $Ast.BeginBlock -or $null -ne $Ast.ProcessBlock -or $null -ne $Ast.DynamicParamBlock) {
        return $false
    }
    $stmts = @($Ast.EndBlock.Statements)
    if ($stmts.Count -lt 2) { return $false }

    for ($i = 0; $i -lt ($stmts.Count - 1); $i++) {
        $st = $stmts[$i]
        if ($st -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            continue
        }
        if ($st -is [System.Management.Automation.Language.AssignmentStatementAst]) {
            $right = $st.Right
            if ($right -is [System.Management.Automation.Language.PipelineAst]) {
                $elems = @($right.PipelineElements)
                if ($elems.Count -ne 1) { return $false }
                $right = $elems[0]
            }
            if (-not ($right -is [System.Management.Automation.Language.CommandExpressionAst])) {
                return $false
            }
            $expr = $right.Expression
            $okExpr = ($expr -is [System.Management.Automation.Language.StringConstantExpressionAst]) -or
                      ($expr -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) -or
                      ($expr -is [System.Management.Automation.Language.ConstantExpressionAst]) -or
                      ($expr -is [System.Management.Automation.Language.VariableExpressionAst])
            if (-not $okExpr) { return $false }
            continue
        }
        if ($st -is [System.Management.Automation.Language.PipelineAst]) {
            $elems = @($st.PipelineElements)
            if ($elems.Count -ne 1) { return $false }
            $cmd = $elems[0]
            if (-not ($cmd -is [System.Management.Automation.Language.CommandAst])) { return $false }
            if ($cmd.GetCommandName() -ne 'Set-StrictMode') { return $false }
            continue
        }
        return $false
    }

    $last = $stmts[$stmts.Count - 1]
    if ($last -is [System.Management.Automation.Language.PipelineAst]) {
        $elems = @($last.PipelineElements)
        if ($elems.Count -ne 1) { return $false }
        $last = $elems[0]
    }
    if (-not ($last -is [System.Management.Automation.Language.CommandAst])) { return $false }
    if ($last.GetCommandName() -ne 'Invoke-FleuronMain') { return $false }
    return $true
}

function Test-S5Lint {
    param($Ast, $Tokens)
    $forbiddenKinds = @(
        'AndAnd',
        'OrOr',
        'QuestionQuestion',
        'QuestionQuestionEquals',
        'QuestionDot',
        'QuestionLBracket',
        'QuestionMark'
    )
    foreach ($tok in @($Tokens)) {
        if ($forbiddenKinds -contains $tok.Kind.ToString()) {
            return $false
        }
    }
    $badVars = @($Ast.FindAll({
        param($node)
        if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) {
            $vp = $node.VariablePath.UserPath
            return (@('IsWindows', 'IsLinux', 'IsMacOS') -contains $vp)
        }
        return $false
    }, $true))
    if ($badVars.Count -gt 0) { return $false }
    return $true
}

$IsWin = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
$CurrentShell = (Get-Process -Id $PID).Path
$RunGuid = [System.Guid]::NewGuid().ToString('N').Substring(0, 12)
$T = Join-Path ([System.IO.Path]::GetTempPath()) ('fleuron-iw-test-' + $RunGuid)
$TestRegParent = 'HKCU:\Software\FleuronInstallTest\' + $RunGuid

try {
    New-Item -ItemType Directory -Path $T -Force | Out-Null

    $FixtureExe = Join-Path $T 'fixture.exe'
    [System.IO.File]::WriteAllBytes($FixtureExe, [System.Text.Encoding]::ASCII.GetBytes('MZ fleuron fixture'))
    $FixSha = Get-Sha256Lower -Path $FixtureExe

    $Rendered = Join-Path $T 'install-windows.ps1'
    Render-Installer -TemplatePath $Template -Version '2.11.0' -Sha256 $FixSha -OutPath $Rendered

    $TemplateText = [System.IO.File]::ReadAllText($Template)
    $RenderedText = [System.IO.File]::ReadAllText($Rendered)

    Write-Host '-- Static and unit checks (S1-S6, U1-U4) ...'

    # S1 & S1-MUT
    $tTok = $null; $tErr = $null
    $astT = [System.Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tTok, [ref]$tErr)
    $rTok = $null; $rErr = $null
    $astR = [System.Management.Automation.Language.Parser]::ParseFile($Rendered, [ref]$rTok, [ref]$rErr)
    if (@($tErr).Count -eq 0 -and @($rErr).Count -eq 0) {
        Pass 'S1' 'ParseFile passes with 0 errors on template and rendered script'
    } else {
        Fail 'S1' ("parse errors: template=" + @($tErr).Count + " rendered=" + @($rErr).Count)
    }

    $lastBrace = $RenderedText.LastIndexOf('}')
    $s1MutOk = $false
    if ($lastBrace -ge 0) {
        $mutS1Text = $RenderedText.Remove($lastBrace, 1)
        $mTok = $null; $mErr = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($mutS1Text, [ref]$mTok, [ref]$mErr)
        if (@($mErr).Count -gt 0) { $s1MutOk = $true }
    }
    if ($s1MutOk) {
        Pass 'S1-MUT' 'removing last brace from rendered script causes parse errors'
    } else {
        Fail 'S1-MUT' 'removing last brace was not caught as a parse error'
    }

    # S2: template bytes all < 0x80
    $tBytes = [System.IO.File]::ReadAllBytes($Template)
    $badByteIdx = -1
    for ($i = 0; $i -lt $tBytes.Length; $i++) {
        if ($tBytes[$i] -ge 0x80) {
            $badByteIdx = $i
            break
        }
    }
    if ($badByteIdx -lt 0) {
        Pass 'S2' 'template bytes are all ASCII (< 0x80)'
    } else {
        Fail 'S2' ("non-ASCII byte at offset " + $badByteIdx)
    }

    # S3 & S3-MUT: AST shape
    if ((Test-S3AstShape -Ast $astT) -and (Test-S3AstShape -Ast $astR)) {
        Pass 'S3' 'AST top-level shape matches expected definitions, assignments, and Invoke-FleuronMain tail'
    } else {
        Fail 'S3' 'unexpected top-level AST statement shape'
    }

    $shaPlaceholder = '$FleuronSetupSha256 = ''__FLEURON_SETUP_SHA256__'''
    $mutS3Lines = New-Object System.Collections.Generic.List[string]
    foreach ($ln in ($TemplateText -split "`r?`n")) {
        $mutS3Lines.Add($ln)
        if ($ln -ceq $shaPlaceholder) {
            $mutS3Lines.Add("Write-Output 'x'")
        }
    }
    $mutS3Text = $mutS3Lines -join "`n"
    $m3Tok = $null; $m3Err = $null
    $astM3 = [System.Management.Automation.Language.Parser]::ParseInput($mutS3Text, [ref]$m3Tok, [ref]$m3Err)
    if (@($m3Err).Count -eq 0 -and -not (Test-S3AstShape -Ast $astM3)) {
        Pass 'S3-MUT' "inserting Write-Output 'x' after SHA placeholder fails S3 AST check"
    } else {
        Fail 'S3-MUT' 'AST shape check failed to catch injected top-level Write-Output'
    }

    # S4: placeholders
    $verLineCount = (@($TemplateText -split "`r?`n" | Where-Object { $_ -ceq '$FleuronVersion = ''__FLEURON_VERSION__''' })).Count
    $shaLineCount = (@($TemplateText -split "`r?`n" | Where-Object { $_ -ceq '$FleuronSetupSha256 = ''__FLEURON_SETUP_SHA256__''' })).Count
    $tMarkers = [regex]::Matches($TemplateText, '__FLEURON_').Count
    $rMarkers = [regex]::Matches($RenderedText, '__FLEURON_').Count
    if ($verLineCount -eq 1 -and $shaLineCount -eq 1 -and $tMarkers -eq 2 -and $rMarkers -eq 0) {
        Pass 'S4' 'template has exact placeholder lines (2 __FLEURON_ occurrences); rendered has 0'
    } else {
        Fail 'S4' ("ver=$verLineCount sha=$shaLineCount tMarkers=$tMarkers rMarkers=$rMarkers")
    }

    # S5 & S5-MUT: PS7-only lint
    if ((Test-S5Lint -Ast $astT -Tokens $tTok) -and (Test-S5Lint -Ast $astR -Tokens $rTok)) {
        Pass 'S5' 'no PS7-only operators or automatic OS variables in template or rendered script'
    } else {
        Fail 'S5' 'found forbidden PS7-only token or OS variable'
    }

    $mutS5Text = $TemplateText + "`n" + '$a = $null ?? 1' + "`n"
    $m5Tok = $null; $m5Err = $null
    $astM5 = [System.Management.Automation.Language.Parser]::ParseInput($mutS5Text, [ref]$m5Tok, [ref]$m5Err)
    if (@($m5Err).Count -gt 0 -or -not (Test-S5Lint -Ast $astM5 -Tokens $m5Tok)) {
        Pass 'S5-MUT' 'appended null-coalescing expression caught by parse error or S5 lint'
    } else {
        Fail 'S5-MUT' 'failed to catch appended null-coalescing expression'
    }

    # S6: markers
    $Markers = @(
        'CURL-PATH',
        'CHECKSUM-GATE',
        'SUMS-GATE',
        'MOTW-GATE',
        'SAC-GATE',
        'SMODE-GATE',
        'SMARTSCREEN-POLICY-GATE',
        'WDAC-GATE',
        'LANGMODE-GATE',
        'ELEVATION-GATE',
        'RUNNING-GATE',
        'OWNERSHIP-GATE',
        'MACHINE-WIDE-GATE'
    )
    $tLineList = @($TemplateText -split "`r?`n")
    $rLineList = @($RenderedText -split "`r?`n")
    $s6Bad = @()
    foreach ($mk in $Markers) {
        $suffix = '# ' + $mk
        $tc = (@($tLineList | Where-Object { $_.EndsWith($suffix) })).Count
        $rc = (@($rLineList | Where-Object { $_.EndsWith($suffix) })).Count
        if ($tc -ne 1 -or $rc -ne 1) {
            $s6Bad += ($mk + "(t=" + $tc + ",r=" + $rc + ")")
        }
    }
    if ($s6Bad.Count -eq 0) {
        Pass 'S6' 'all 13 gate/path markers appear exactly once in template and rendered script'
    } else {
        Fail 'S6' ("bad marker counts: " + ($s6Bad -join ', '))
    }

    # U1-U4: dot-source rendered minus last line
    $rTrimLines = @([System.IO.File]::ReadAllLines($Rendered))
    while ($rTrimLines.Count -gt 0 -and $rTrimLines[$rTrimLines.Count - 1].Trim() -eq '') {
        $rTrimLines = $rTrimLines[0..($rTrimLines.Count - 2)]
    }
    $withoutLastText = ($rTrimLines[0..($rTrimLines.Count - 2)]) -join "`n"
    $sb = [scriptblock]::Create($withoutLastText)
    . $sb
    $ErrorActionPreference = 'Continue'

    # U1: Compare-FleuronVersion
    $u1Ok = ((Compare-FleuronVersion '2.10.0' '2.11.0') -eq -1) -and
            ((Compare-FleuronVersion '2.11.0' '2.11.0') -eq 0) -and
            ((Compare-FleuronVersion '2.12.0' '2.11.0') -eq 1) -and
            ((Compare-FleuronVersion '10.0.0' '9.9.9') -eq 1)
    if ($u1Ok) {
        Pass 'U1' 'Compare-FleuronVersion ordering matches semver rules'
    } else {
        Fail 'U1' 'Compare-FleuronVersion returned unexpected comparison result'
    }

    # U2: Test-FleuronSemver / Test-FleuronSha256
    $u2Ok = (Test-FleuronSemver '2.11.0') -and
            (-not (Test-FleuronSemver '2.11')) -and
            (-not (Test-FleuronSemver 'v2.11.0')) -and
            (Test-FleuronSha256 $FixSha) -and
            (-not (Test-FleuronSha256 ($FixSha.ToUpperInvariant()))) -and
            (-not (Test-FleuronSha256 '0123'))
    if ($u2Ok) {
        Pass 'U2' 'Test-FleuronSemver and Test-FleuronSha256 accept/reject expected inputs'
    } else {
        Fail 'U2' 'Test-FleuronSemver or Test-FleuronSha256 validation mismatch'
    }

    # U3: Test-FleuronSumsFile
    $u3Dir = Join-Path $T 'u3'
    New-Item -ItemType Directory -Path $u3Dir -Force | Out-Null
    $u3Ok = $true

    $sumsOk1 = Join-Path $u3Dir 'ok1.txt'
    Write-Utf8NoBom -Path $sumsOk1 -Text ($FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
    try { Test-FleuronSumsFile -Path $sumsOk1 } catch { $u3Ok = $false }

    $sumsOk2 = Join-Path $u3Dir 'ok2.txt'
    Write-Utf8NoBom -Path $sumsOk2 -Text ($FixSha + ' *Fleuron_2.11.0_x64-setup.exe' + "`n")
    try { Test-FleuronSumsFile -Path $sumsOk2 } catch { $u3Ok = $false }

    $sumsOk3 = Join-Path $u3Dir 'ok3.txt'
    Write-Utf8NoBom -Path $sumsOk3 -Text ($FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`r`n")
    try { Test-FleuronSumsFile -Path $sumsOk3 } catch { $u3Ok = $false }

    $sumsBadList = @(
        ($FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n" + $FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n"),
        (('0' * 64) + '  Fleuron_2.11.0_x64-setup.exe' + "`n"),
        ($FixSha + '  Other_File.exe' + "`n"),
        ($FixSha.ToUpperInvariant() + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
    )
    for ($bi = 0; $bi -lt $sumsBadList.Count; $bi++) {
        $bp = Join-Path $u3Dir ("bad_" + $bi + ".txt")
        Write-Utf8NoBom -Path $bp -Text $sumsBadList[$bi]
        $script:FleuronExit = 0
        $threwStop = $false
        try {
            Test-FleuronSumsFile -Path $bp
        } catch {
            if ("$($_.Exception.Message)" -eq 'FLEURON-STOP' -and $script:FleuronExit -eq 20) {
                $threwStop = $true
            }
        }
        if (-not $threwStop) { $u3Ok = $false }
    }
    if ($u3Ok) {
        Pass 'U3' 'Test-FleuronSumsFile accepts LF/CRLF/asterisk and rejects duplicates, wrong hash, missing name, uppercase'
    } else {
        Fail 'U3' 'Test-FleuronSumsFile failed one or more acceptance/rejection assertions'
    }

    # U4: Get-FleuronLaunchFailureCode
    $u4Ok = ((Get-FleuronLaunchFailureCode 1260) -eq 30) -and
            ((Get-FleuronLaunchFailureCode 4551) -eq 30) -and
            ((Get-FleuronLaunchFailureCode 225) -eq 30) -and
            ((Get-FleuronLaunchFailureCode 226) -eq 30) -and
            ((Get-FleuronLaunchFailureCode 2) -eq 50) -and
            ((Get-FleuronLaunchFailureCode 5) -eq 50)
    if ($u4Ok) {
        Pass 'U4' 'Get-FleuronLaunchFailureCode maps policy/AV native codes to 30 and others to 50'
    } else {
        Fail 'U4' 'Get-FleuronLaunchFailureCode returned unexpected exit code mapping'
    }

    if (-not $IsWin) {
        # T1-T3 on non-Windows (no mocks)
        $rBytes = [System.IO.File]::ReadAllBytes($Rendered)

        $t1File = Join-Path $T 'trunc_t1.ps1'
        $t1Len = [int][Math]::Floor($rBytes.Length / 2)
        $t1Slice = New-Object byte[] $t1Len
        [Array]::Copy($rBytes, 0, $t1Slice, 0, $t1Len)
        [System.IO.File]::WriteAllBytes($t1File, $t1Slice)
        $resT1 = Invoke-ShellFile -ShellExe $CurrentShell -ScriptPath $t1File -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_SYSROOT = $null; FLEURON_INSTALL_TEST_REGROOT = $null }
        if ($resT1.Out -notmatch 'checking the release checksum list' -and $resT1.Out -notmatch 'installer for Windows') {
            Pass 'T1' '50% truncated script printed no installer progress lines'
        } else {
            Fail 'T1' ("unexpected output: " + $resT1.Out)
        }

        $t2Ok = $true
        $t2Detail = ''
        foreach ($pct in @(10, 20, 30, 40, 50, 60, 70, 80, 90)) {
            $t2File = Join-Path $T ("trunc_t2_" + $pct + ".ps1")
            $t2Len = [int][Math]::Floor($rBytes.Length * $pct / 100)
            $t2Slice = New-Object byte[] $t2Len
            [Array]::Copy($rBytes, 0, $t2Slice, 0, $t2Len)
            [System.IO.File]::WriteAllBytes($t2File, $t2Slice)
            $resT2 = Invoke-ShellFile -ShellExe $CurrentShell -ScriptPath $t2File -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_SYSROOT = $null; FLEURON_INSTALL_TEST_REGROOT = $null }
            if ($resT2.Out -match 'checking the release checksum list' -or $resT2.Out -match 'installer for Windows') {
                $t2Ok = $false
                $t2Detail = "pct=$pct out=$($resT2.Out)"
                break
            }
        }
        if ($t2Ok) {
            Pass 'T2' '10%-90% truncated scripts printed no installer progress lines'
        } else {
            Fail 'T2' $t2Detail
        }

        $t3File = Join-Path $T 'trunc_t3.ps1'
        Write-Utf8NoBom -Path $t3File -Text ($withoutLastText + "`n")
        $resT3 = Invoke-ShellFile -ShellExe $CurrentShell -ScriptPath $t3File -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_SYSROOT = $null; FLEURON_INSTALL_TEST_REGROOT = $null }
        if ($resT3.ExitCode -eq 0 -and
            $resT3.Out -notmatch 'fleuron-install:' -and
            $resT3.Out -notmatch 'checking the release checksum list' -and
            $resT3.Out -notmatch 'installer for Windows') {
            Pass 'T3' 'script minus final line exits 0 with no fleuron-install output'
        } else {
            Fail 'T3' ("rc=" + $resT3.ExitCode + " out=" + $resT3.Out)
        }

        # L1: non-Windows OS rejection
        $resL1 = Invoke-ShellFile -ShellExe $CurrentShell -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_SYSROOT = $null; FLEURON_INSTALL_TEST_REGROOT = $null }
        if ($resL1.ExitCode -eq 3 -and $resL1.Out -match 'unsupported OS') {
            Pass 'L1' 'non-Windows host exits 3 with unsupported OS message'
        } else {
            Fail 'L1' ("expected rc=3 and 'unsupported OS', got rc=" + $resL1.ExitCode + " out=" + $resL1.Out)
        }

        $plat = [System.Environment]::OSVersion.Platform
        Write-Host ("SKIP: runtime cases C1-C27 and M-* need Windows (this host: {0}). They run on windows-latest CI." -f $plat)
        $script:SkipCount++
    } else {
        # -- SECTION 2: Windows runtime harness --
        Write-Host '-- Setting up Windows mock harness ...'
        $preProc = @(Get-Process -Name 'Fleuron' -ErrorAction SilentlyContinue)
        if ($preProc.Count -gt 0) {
            Fail 'PRE-FLIGHT' 'Fleuron process is already running before test suite; refusing to continue'
            throw 'PRE-FLIGHT-ABORT'
        }

        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
            Fail 'PRE-FLIGHT' ("csc.exe not found at " + $csc)
            throw 'PRE-FLIGHT-ABORT'
        }

        $WinPsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $PwshCmd = Get-Command -Name 'pwsh' -CommandType Application -ErrorAction SilentlyContinue
        $PwshExe = $null
        if ($null -ne $PwshCmd) { $PwshExe = $PwshCmd.Source }

        $ShimTemplate = @'
using System; using System.Diagnostics; using System.IO; using System.Reflection; using System.Text;
[assembly: AssemblyProduct("__PRODUCT__")]
[assembly: AssemblyFileVersion("__VERSION__.0")]
[assembly: AssemblyVersion("__VERSION__.0")]
public static class FleuronMockShim {
  public static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string name = Path.GetFileNameWithoutExtension(self);
    string script = Path.Combine(Path.GetDirectoryName(self), name + ".mock.ps1");
    if (!File.Exists(script)) {
      string mockDir = Environment.GetEnvironmentVariable("MOCK_DIR");
      if (mockDir == null) { return 97; }
      script = Path.Combine(mockDir, name + ".mock.ps1");
    }
    if (!File.Exists(script)) { return 96; }
    StringBuilder sb = new StringBuilder();
    sb.Append("-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File \"").Append(script).Append("\"");
    foreach (string a in args) { sb.Append(" \"").Append(a.Replace("\"", "\\\"")).Append("\""); }
    string ps = Environment.GetEnvironmentVariable("MOCK_PS_EXE");
    if (ps == null) { return 95; }
    ProcessStartInfo psi = new ProcessStartInfo(ps, sb.ToString());
    psi.UseShellExecute = false;
    Process p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
'@

        $Sysroot = Join-Path $T 'sysroot'
        $Sys32 = Join-Path $Sysroot 'System32'
        $MockDir = Join-Path $T 'mock'
        $ServerClean = Join-Path $T 'server_clean'
        $EvilDir = Join-Path $T 'evil'
        $RunningDir = Join-Path $T 'running'
        $ShimDir = Join-Path $T 'shims'
        foreach ($d in @($Sys32, $MockDir, $ServerClean, $EvilDir, $RunningDir, $ShimDir)) {
            New-Item -ItemType Directory -Path $d -Force | Out-Null
        }

        function Build-ShimVariant {
            param([string]$Tag, [string]$Product, [string]$Version, [string]$OutExe)
            $csPath = Join-Path $ShimDir ($Tag + '.cs')
            $csText = $ShimTemplate.Replace('__PRODUCT__', $Product).Replace('__VERSION__', $Version)
            Write-Utf8NoBom -Path $csPath -Text $csText
            $cscOut = & $csc /nologo /target:exe ("/out:" + $OutExe) $csPath 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw ("csc failed for " + $Tag + ": " + ($cscOut -join ' '))
            }
        }

        $SetupShimExe = Join-Path $ShimDir 'setup-shim.exe'
        Build-ShimVariant -Tag 'setup-shim' -Product 'Fleuron Setup' -Version '2.11.0' -OutExe $SetupShimExe
        Build-ShimVariant -Tag 'app-2.10.0' -Product 'Fleuron' -Version '2.10.0' -OutExe (Join-Path $MockDir 'app-2.10.0.exe')
        Build-ShimVariant -Tag 'app-2.11.0' -Product 'Fleuron' -Version '2.11.0' -OutExe (Join-Path $MockDir 'app-2.11.0.exe')
        Build-ShimVariant -Tag 'app-2.12.0' -Product 'Fleuron' -Version '2.12.0' -OutExe (Join-Path $MockDir 'app-2.12.0.exe')
        Build-ShimVariant -Tag 'app-foreign' -Product 'Other App' -Version '2.11.0' -OutExe (Join-Path $MockDir 'app-foreign.exe')

        Copy-Item -LiteralPath $SetupShimExe -Destination (Join-Path $Sys32 'curl.exe') -Force
        Copy-Item -LiteralPath $SetupShimExe -Destination (Join-Path $EvilDir 'curl.exe') -Force
        Copy-Item -LiteralPath $SetupShimExe -Destination (Join-Path $RunningDir 'Fleuron.exe') -Force
        Copy-Item -LiteralPath $SetupShimExe -Destination $FixtureExe -Force

        $FixSha = Get-Sha256Lower -Path $FixtureExe
        Copy-Item -LiteralPath $SetupShimExe -Destination (Join-Path $ServerClean 'Fleuron_2.11.0_x64-setup.exe') -Force
        Write-Utf8NoBom -Path (Join-Path $ServerClean 'SHA256SUMS.txt') -Text ($FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
        Render-Installer -TemplatePath $Template -Version '2.11.0' -Sha256 $FixSha -OutPath $Rendered
        $RenderedText = [System.IO.File]::ReadAllText($Rendered)

        $EvilMarker = Join-Path $T 'EVIL_RAN'
        $evilMockText = @"
[System.IO.File]::WriteAllText('$($EvilMarker.Replace("'", "''"))', 'evil')
exit 1
"@
        Write-Utf8NoBom -Path (Join-Path $EvilDir 'curl.mock.ps1') -Text $evilMockText

        $curlMockText = @'
$logLine = 'curl ' + ($args -join ' ')
[System.IO.File]::AppendAllText($env:MOCK_LOG, $logLine + "`r`n")
$protoOk = $false
$protoRedirOk = $false
$hasFail = $false
$hasTls = $false
$out = ''
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = $args[$i]
    if ($a -eq '--proto' -and ($i + 1) -lt $args.Count -and $args[$i + 1] -eq '=https') { $protoOk = $true }
    if ($a -eq '--proto-redir' -and ($i + 1) -lt $args.Count -and $args[$i + 1] -eq '=https') { $protoRedirOk = $true }
    if ($a -eq '--fail') { $hasFail = $true }
    if ($a -eq '--tlsv1.2') { $hasTls = $true }
    if ($a -eq '--output' -and ($i + 1) -lt $args.Count) { $out = $args[$i + 1] }
}
if (-not ($protoOk -and $protoRedirOk -and $hasFail -and $hasTls)) { exit 99 }
if ($args.Count -lt 1) { exit 98 }
$url = $args[$args.Count - 1]
$prefix = 'https://github.com/wilsonhyeh/fleuron/releases/download/v2.11.0/'
if (-not $url.StartsWith($prefix)) { exit 98 }
$base = $url.Substring($url.LastIndexOf('/') + 1)
if ($env:MOCK_CURL_404 -eq $base) { exit 22 }
$src = Join-Path $env:MOCK_SERVER $base
if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { exit 22 }
if ($env:MOCK_CURL_TRUNC) {
    $parts = $env:MOCK_CURL_TRUNC.Split(':', 2)
    if ($parts.Count -eq 2 -and $parts[0] -eq $base) {
        $bytes = [System.IO.File]::ReadAllBytes($src)
        $half = [int][Math]::Floor($bytes.Length / 2)
        $slice = New-Object byte[] $half
        [Array]::Copy($bytes, 0, $slice, 0, $half)
        [System.IO.File]::WriteAllBytes($out, $slice)
        exit ([int]$parts[1])
    }
}
Copy-Item -LiteralPath $src -Destination $out -Force
if ($env:MOCK_CURL_MOTW -eq '1' -and $base -like '*.exe') {
    Set-Content -LiteralPath $out -Stream 'Zone.Identifier' -Value "[ZoneTransfer]`r`nZoneId=3"
}
exit 0
'@
        Write-Utf8NoBom -Path (Join-Path $MockDir 'curl.mock.ps1') -Text $curlMockText

        $setupMockText = @'
$logLine = 'setup ' + ($args -join ' ')
[System.IO.File]::AppendAllText($env:MOCK_LOG, $logLine + "`r`n")
if ($env:MOCK_SETUP_SLEEP) {
    Start-Sleep -Seconds ([int]$env:MOCK_SETUP_SLEEP)
    exit 0
}
if ($env:MOCK_SETUP_EXIT) {
    exit ([int]$env:MOCK_SETUP_EXIT)
}
$regRoot = $env:FLEURON_INSTALL_TEST_REGROOT
$pk = Join-Path $regRoot 'HKCU\Software\Fleuron\Fleuron'
$uk = Join-Path $regRoot 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
$dir = $null
if (Test-Path -LiteralPath $pk) {
    $it = Get-ItemProperty -LiteralPath $pk -ErrorAction SilentlyContinue
    if ($null -ne $it) {
        $prop = $it.PSObject.Properties['(default)']
        if ($null -ne $prop -and $prop.Value) { $dir = "$($prop.Value)" }
    }
}
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Fleuron' }
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$ver = $env:MOCK_SETUP_VERSION
if (-not $ver) { $ver = '2.11.0' }
Copy-Item -LiteralPath (Join-Path $env:MOCK_DIR ('app-' + $ver + '.exe')) -Destination (Join-Path $dir 'Fleuron.exe') -Force
$shimSrc = Join-Path (Split-Path -Parent $env:MOCK_DIR) 'sysroot\System32\curl.exe'
Copy-Item -LiteralPath $shimSrc -Destination (Join-Path $dir 'uninstall.exe') -Force
New-Item -Path $uk -Force | Out-Null
Set-ItemProperty -LiteralPath $uk -Name 'DisplayName' -Value 'Fleuron'
Set-ItemProperty -LiteralPath $uk -Name 'DisplayVersion' -Value '2.11.0'
Set-ItemProperty -LiteralPath $uk -Name 'InstallLocation' -Value ('"' + $dir + '"')
Set-ItemProperty -LiteralPath $uk -Name 'UninstallString' -Value ('"' + $dir + '\uninstall.exe"')
Set-ItemProperty -LiteralPath $uk -Name 'Publisher' -Value 'Fleuron'
New-Item -Path $pk -Force | Out-Null
Set-Item -LiteralPath $pk -Value $dir
exit 0
'@
        Write-Utf8NoBom -Path (Join-Path $MockDir 'Fleuron_2.11.0_x64-setup.mock.ps1') -Text $setupMockText

        $uninstallMockText = @'
$logLine = 'uninstall ' + ($args -join ' ')
[System.IO.File]::AppendAllText($env:MOCK_LOG, $logLine + "`r`n")
if ($env:MOCK_UNINSTALL_NOOP -eq '1') { exit 0 }
$regRoot = $env:FLEURON_INSTALL_TEST_REGROOT
$pk = Join-Path $regRoot 'HKCU\Software\Fleuron\Fleuron'
$uk = Join-Path $regRoot 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
$dir = $null
if (Test-Path -LiteralPath $pk) {
    $it = Get-ItemProperty -LiteralPath $pk -ErrorAction SilentlyContinue
    if ($null -ne $it) {
        $prop = $it.PSObject.Properties['(default)']
        if ($null -ne $prop -and $prop.Value) { $dir = "$($prop.Value)" }
    }
}
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Fleuron' }
Remove-Item -LiteralPath (Join-Path $dir 'Fleuron.exe') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $uk -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pk -Recurse -Force -ErrorAction SilentlyContinue
exit 0
'@
        Write-Utf8NoBom -Path (Join-Path $MockDir 'uninstall.mock.ps1') -Text $uninstallMockText

        Write-Utf8NoBom -Path (Join-Path $MockDir 'Fleuron.mock.ps1') -Text "Start-Sleep -Seconds 60`n"

        # Per-case harness helpers
        $script:CaseDir = Join-Path $T 'case'
        $script:CaseHome = Join-Path $script:CaseDir 'home'
        $script:CaseLocal = Join-Path $script:CaseDir 'local'
        $script:CaseRoaming = Join-Path $script:CaseDir 'roaming'
        $script:CaseTemp = Join-Path $script:CaseDir 'temp'
        $script:CasePf = Join-Path $script:CaseDir 'pf'
        $script:CaseServer = Join-Path $script:CaseDir 'server'
        $script:CaseLog = Join-Path $script:CaseDir 'mock.log'
        $script:RegRoot = $TestRegParent + '\case'

        function Setup-Case {
            Remove-ReparsePointsUnder -RootPath $script:CaseDir
            if (Test-Path -LiteralPath $script:CaseDir) {
                Remove-Item -LiteralPath $script:CaseDir -Recurse -Force
            }
            foreach ($d in @($script:CaseHome, $script:CaseLocal, $script:CaseRoaming, $script:CaseTemp, $script:CasePf, $script:CaseServer)) {
                New-Item -ItemType Directory -Path $d -Force | Out-Null
            }
            Copy-Item -LiteralPath (Join-Path $ServerClean '*') -Destination $script:CaseServer -Force
            Write-Utf8NoBom -Path $script:CaseLog -Text ''

            if (-not $script:RegRoot.StartsWith('HKCU:\Software\FleuronInstallTest\')) {
                throw ("unsafe RegRoot: " + $script:RegRoot)
            }
            if (Test-Path -LiteralPath $script:RegRoot) {
                Remove-Item -LiteralPath $script:RegRoot -Recurse -Force
            }
            New-Item -Path $script:RegRoot -Force | Out-Null
        }

        function Run-Installer {
            param(
                [string]$ScriptPath,
                [string[]]$ArgList,
                [hashtable]$ExtraEnv,
                [string]$ShellExe
            )
            if (-not $ShellExe) { $ShellExe = $WinPsExe }
            $envMap = @{
                USERPROFILE = $script:CaseHome
                LOCALAPPDATA = $script:CaseLocal
                APPDATA = $script:CaseRoaming
                TEMP = $script:CaseTemp
                TMP = $script:CaseTemp
                ProgramFiles = $script:CasePf
                FLEURON_INSTALL_TEST_SYSROOT = $Sysroot
                FLEURON_INSTALL_TEST_REGROOT = $script:RegRoot
                MOCK_DIR = $MockDir
                MOCK_SERVER = $script:CaseServer
                MOCK_LOG = $script:CaseLog
                MOCK_PS_EXE = $WinPsExe
                FLEURON_INSTALL_TEST_TIMEOUT_SEC = '30'
            }
            if ($null -ne $ExtraEnv) {
                foreach ($k in $ExtraEnv.Keys) {
                    $envMap[$k] = $ExtraEnv[$k]
                }
            }
            return Invoke-ShellFile -ShellExe $ShellExe -ScriptPath $ScriptPath -ArgList $ArgList -ExtraEnv $envMap -UseExecutionPolicy
        }

        function Get-MockLogLines {
            if (-not (Test-Path -LiteralPath $script:CaseLog -PathType Leaf)) { return @() }
            return @([System.IO.File]::ReadAllLines($script:CaseLog))
        }

        function Test-LogHas {
            param([string]$Pattern)
            foreach ($ln in (Get-MockLogLines)) {
                if ($ln -match $Pattern) { return $true }
            }
            return $false
        }

        function Get-ExeFileVersion {
            param([string]$ExePath)
            if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { return '' }
            $vi = (Get-Item -LiteralPath $ExePath -Force).VersionInfo
            return ('{0}.{1}.{2}' -f $vi.FileMajorPart, $vi.FileMinorPart, $vi.FileBuildPart)
        }

        function Get-ExeProductName {
            param([string]$ExePath)
            if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { return '' }
            $vi = (Get-Item -LiteralPath $ExePath -Force).VersionInfo
            return "$($vi.ProductName)".Trim()
        }

        function Install-MockState {
            param(
                [string]$ExeSource,
                [string]$DisplayVersion,
                [string]$UninstallStringOverride
            )
            $dir = Join-Path $script:CaseLocal 'Fleuron'
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Copy-Item -LiteralPath $ExeSource -Destination (Join-Path $dir 'Fleuron.exe') -Force
            Copy-Item -LiteralPath $SetupShimExe -Destination (Join-Path $dir 'uninstall.exe') -Force
            $uk = Join-Path $script:RegRoot 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
            $pk = Join-Path $script:RegRoot 'HKCU\Software\Fleuron\Fleuron'
            New-Item -Path $uk -Force | Out-Null
            Set-ItemProperty -LiteralPath $uk -Name 'DisplayName' -Value 'Fleuron'
            Set-ItemProperty -LiteralPath $uk -Name 'DisplayVersion' -Value $DisplayVersion
            Set-ItemProperty -LiteralPath $uk -Name 'InstallLocation' -Value ('"' + $dir + '"')
            $uStr = '"' + $dir + '\uninstall.exe"'
            if ($UninstallStringOverride) { $uStr = $UninstallStringOverride }
            Set-ItemProperty -LiteralPath $uk -Name 'UninstallString' -Value $uStr
            Set-ItemProperty -LiteralPath $uk -Name 'Publisher' -Value 'Fleuron'
            New-Item -Path $pk -Force | Out-Null
            Set-Item -LiteralPath $pk -Value $dir
        }

        function Assert-NoLeftovers {
            param([string]$Id)
            $leftTmp = @(Get-ChildItem -LiteralPath $script:CaseTemp -Filter 'fleuron-install.*' -Force -ErrorAction SilentlyContinue)
            if ($leftTmp.Count -gt 0) {
                Fail ($Id + ' (cleanup)') ("leftover temp dir in case\\temp: " + $leftTmp[0].FullName)
                return $false
            }
            $leftProc = @(Get-Process -Name 'Fleuron_2.11.0_x64-setup' -ErrorAction SilentlyContinue)
            if ($leftProc.Count -gt 0) {
                Fail ($Id + ' (cleanup)') 'leftover Fleuron_2.11.0_x64-setup process'
                return $false
            }
            $fleuronDir = Join-Path $script:CaseLocal 'Fleuron'
            if (Test-Path -LiteralPath $fleuronDir -PathType Container) {
                $leftProbe = @(Get-ChildItem -LiteralPath $fleuronDir -Filter '.fleuron-install-probe-*' -Force -ErrorAction SilentlyContinue)
                if ($leftProbe.Count -gt 0) {
                    Fail ($Id + ' (cleanup)') ("leftover probe file: " + $leftProbe[0].FullName)
                    return $false
                }
            }
            return $true
        }

        function Start-MockRunningFleuron {
            $savedMock = $env:MOCK_DIR
            $savedPs = $env:MOCK_PS_EXE
            try {
                [System.Environment]::SetEnvironmentVariable('MOCK_DIR', $MockDir, 'Process')
                [System.Environment]::SetEnvironmentVariable('MOCK_PS_EXE', $WinPsExe, 'Process')
                $p = Start-Process -FilePath (Join-Path $RunningDir 'Fleuron.exe') -PassThru -NoNewWindow
                Start-Sleep -Milliseconds 300
                return $p
            } finally {
                [System.Environment]::SetEnvironmentVariable('MOCK_DIR', $savedMock, 'Process')
                [System.Environment]::SetEnvironmentVariable('MOCK_PS_EXE', $savedPs, 'Process')
            }
        }

        function Stop-MockRunningFleuron {
            param($Proc)
            if ($null -ne $Proc) {
                try { & taskkill /T /F /PID $Proc.Id 2>&1 | Out-Null } catch { }
            }
        }

        # T1-T3 truncation on Windows (with mocks)
        $rBytes = [System.IO.File]::ReadAllBytes($Rendered)

        Setup-Case
        $t1File = Join-Path $T 'trunc_t1.ps1'
        $t1Len = [int][Math]::Floor($rBytes.Length / 2)
        $t1Slice = New-Object byte[] $t1Len
        [Array]::Copy($rBytes, 0, $t1Slice, 0, $t1Len)
        [System.IO.File]::WriteAllBytes($t1File, $t1Slice)
        $resT1 = Run-Installer -ScriptPath $t1File -ArgList @() -ShellExe $CurrentShell
        if ($resT1.Out -notmatch 'checking the release checksum list' -and
            $resT1.Out -notmatch 'installer for Windows' -and
            -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'T1') { Pass 'T1' '50% truncated script printed no installer progress and logged no curl' }
        } else {
            Fail 'T1' ("out=" + $resT1.Out)
        }

        $t2Ok = $true
        $t2Detail = ''
        foreach ($pct in @(10, 20, 30, 40, 50, 60, 70, 80, 90)) {
            Setup-Case
            $t2File = Join-Path $T ("trunc_t2_" + $pct + ".ps1")
            $t2Len = [int][Math]::Floor($rBytes.Length * $pct / 100)
            $t2Slice = New-Object byte[] $t2Len
            [Array]::Copy($rBytes, 0, $t2Slice, 0, $t2Len)
            [System.IO.File]::WriteAllBytes($t2File, $t2Slice)
            $resT2 = Run-Installer -ScriptPath $t2File -ArgList @() -ShellExe $CurrentShell
            if ($resT2.Out -match 'checking the release checksum list' -or
                $resT2.Out -match 'installer for Windows' -or
                (Test-LogHas '^curl ')) {
                $t2Ok = $false
                $t2Detail = "pct=$pct out=$($resT2.Out)"
                break
            }
            if (-not (Assert-NoLeftovers ('T2-' + $pct))) {
                $t2Ok = $false
                $t2Detail = "leftovers at pct=$pct"
                break
            }
        }
        if ($t2Ok) {
            Pass 'T2' '10%-90% truncated scripts printed no installer progress and logged no curl'
        } else {
            Fail 'T2' $t2Detail
        }

        Setup-Case
        $rTrimWin = @([System.IO.File]::ReadAllLines($Rendered))
        while ($rTrimWin.Count -gt 0 -and $rTrimWin[$rTrimWin.Count - 1].Trim() -eq '') {
            $rTrimWin = $rTrimWin[0..($rTrimWin.Count - 2)]
        }
        $t3WinText = ($rTrimWin[0..($rTrimWin.Count - 2)]) -join "`r`n"
        $t3File = Join-Path $T 'trunc_t3.ps1'
        Write-Utf8NoBom -Path $t3File -Text ($t3WinText + "`r`n")
        $resT3 = Run-Installer -ScriptPath $t3File -ArgList @() -ShellExe $CurrentShell
        if ($resT3.ExitCode -eq 0 -and
            $resT3.Out -notmatch 'fleuron-install:' -and
            $resT3.Out -notmatch 'checking the release checksum list' -and
            $resT3.Out -notmatch 'installer for Windows' -and
            -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'T3') { Pass 'T3' 'script minus final line exits 0 with no fleuron-install output or curl' }
        } else {
            Fail 'T3' ("rc=" + $resT3.ExitCode + " out=" + $resT3.Out)
        }

        Write-Host '-- Runtime cases C1-C27 (Windows PowerShell 5.1) ...'

        # C1: fresh install
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        $installedExe = Join-Path $script:CaseLocal 'Fleuron\Fleuron.exe'
        if ($res.ExitCode -eq 0 -and
            (Get-ExeFileVersion $installedExe) -eq '2.11.0' -and
            (Test-LogHas '^curl .*https://github\.com/wilsonhyeh/fleuron/releases/download/v2\.11\.0/SHA256SUMS\.txt') -and
            (Test-LogHas '^curl .*https://github\.com/wilsonhyeh/fleuron/releases/download/v2\.11\.0/Fleuron_2\.11\.0_x64-setup\.exe') -and
            (Test-LogHas '^setup /S$')) {
            if (Assert-NoLeftovers 'C1') { Pass 'C1' 'fresh install installs 2.11.0, verifies URLs, and invokes setup /S' }
        } else {
            Fail 'C1' ("rc=" + $res.ExitCode + " ver=" + (Get-ExeFileVersion $installedExe) + " out=" + $res.Out)
        }

        # C2: second run (already current, zero curl)
        Write-Utf8NoBom -Path $script:CaseLog -Text ''
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 0 -and $res.Out -match 'nothing to do' -and -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'C2') { Pass 'C2' 'second run exits 0 with nothing to do and zero curl calls' }
        } else {
            Fail 'C2' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C3: upgrade from 2.10.0 -> 2.11.0
        Setup-Case
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.10.0.exe') -DisplayVersion '2.10.0'
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 0 -and (Get-ExeFileVersion $installedExe) -eq '2.11.0') {
            if (Assert-NoLeftovers 'C3') { Pass 'C3' 'upgrade from 2.10.0 installs 2.11.0' }
        } else {
            Fail 'C3' ("rc=" + $res.ExitCode + " ver=" + (Get-ExeFileVersion $installedExe))
        }

        # C4: newer 2.12.0 installed -> 0, unchanged, zero curl
        Setup-Case
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.12.0.exe') -DisplayVersion '2.12.0'
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 0 -and (Get-ExeFileVersion $installedExe) -eq '2.12.0' -and -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'C4') { Pass 'C4' 'newer version 2.12.0 preserved with exit 0 and zero curl' }
        } else {
            Fail 'C4' ("rc=" + $res.ExitCode + " ver=" + (Get-ExeFileVersion $installedExe))
        }

        # C5a: HKLM uninstall key under RegRoot -> 5, zero curl
        Setup-Case
        $hklmUk = Join-Path $script:RegRoot 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
        New-Item -Path $hklmUk -Force | Out-Null
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 5 -and -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'C5a') { Pass 'C5a' 'HKLM machine-wide uninstall key exits 5 with zero curl' }
        } else {
            Fail 'C5a' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C5b: ProgramFiles\Fleuron\Fleuron.exe exists -> 5
        Setup-Case
        $pfFleuron = Join-Path $script:CasePf 'Fleuron'
        New-Item -ItemType Directory -Path $pfFleuron -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $MockDir 'app-2.11.0.exe') -Destination (Join-Path $pfFleuron 'Fleuron.exe') -Force
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 5) {
            if (Assert-NoLeftovers 'C5b') { Pass 'C5b' 'ProgramFiles Fleuron.exe exits 5' }
        } else {
            Fail 'C5b' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C6a: junction at case\local\Fleuron -> 5
        Setup-Case
        $jTarget = Join-Path $script:CaseTemp 'jtarget'
        New-Item -ItemType Directory -Path $jTarget -Force | Out-Null
        $jPath = Join-Path $script:CaseLocal 'Fleuron'
        New-Item -ItemType Junction -Path $jPath -Target $jTarget | Out-Null
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 5) {
            if (Assert-NoLeftovers 'C6a') { Pass 'C6a' 'junction at install dir exits 5' }
        } else {
            Fail 'C6a' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C6b: app-foreign as Fleuron.exe -> 5, unchanged
        Setup-Case
        $fDir = Join-Path $script:CaseLocal 'Fleuron'
        New-Item -ItemType Directory -Path $fDir -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $MockDir 'app-foreign.exe') -Destination $installedExe -Force
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 5 -and (Get-ExeProductName $installedExe) -eq 'Other App') {
            if (Assert-NoLeftovers 'C6b') { Pass 'C6b' 'foreign product name exits 5 without modifying exe' }
        } else {
            Fail 'C6b' ("rc=" + $res.ExitCode + " prod=" + (Get-ExeProductName $installedExe))
        }

        # C6c: deny write ACE on install dir -> 5 (or Skip if probe write still succeeds)
        Setup-Case
        $fDir = Join-Path $script:CaseLocal 'Fleuron'
        New-Item -ItemType Directory -Path $fDir -Force | Out-Null
        $curSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $denyAce = '*' + $curSid + ':(OI)(CI)(W)'
        try {
            & icacls.exe $fDir /deny $denyAce 2>&1 | Out-Null
            $probeFile = Join-Path $fDir 'test-probe.txt'
            $probeBlocked = $false
            try {
                [System.IO.File]::WriteAllText($probeFile, 'x')
                Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
            } catch {
                $probeBlocked = $true
            }
            if (-not $probeBlocked) {
                Skip 'C6c' 'deny write ACE did not block probe write for current account'
            } else {
                $res = Run-Installer -ScriptPath $Rendered -ArgList @()
                if ($res.ExitCode -eq 5) {
                    if (Assert-NoLeftovers 'C6c') { Pass 'C6c' 'non-writable install dir exits 5' }
                } else {
                    Fail 'C6c' ("rc=" + $res.ExitCode + " out=" + $res.Out)
                }
            }
        } finally {
            & icacls.exe $fDir /remove:d ('*' + $curSid) 2>&1 | Out-Null
        }

        # C7: append one byte to served exe -> 20, no setup line, nothing installed
        Setup-Case
        $srvExe = Join-Path $script:CaseServer 'Fleuron_2.11.0_x64-setup.exe'
        $oldBytes = [System.IO.File]::ReadAllBytes($srvExe)
        $newBytes = New-Object byte[] ($oldBytes.Length + 1)
        [Array]::Copy($oldBytes, 0, $newBytes, 0, $oldBytes.Length)
        $newBytes[$oldBytes.Length] = [byte][char]'X'
        [System.IO.File]::WriteAllBytes($srvExe, $newBytes)
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 20 -and -not (Test-LogHas '^setup ') -and -not (Test-Path -LiteralPath $installedExe)) {
            if (Assert-NoLeftovers 'C7') { Pass 'C7' 'altered setup exe exits 20 before running setup' }
        } else {
            Fail 'C7' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C8: SUMS lists another hash -> 20, no exe curl line
        Setup-Case
        Write-Utf8NoBom -Path (Join-Path $script:CaseServer 'SHA256SUMS.txt') -Text (('0' * 64) + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 20 -and -not (Test-LogHas 'Fleuron_2\.11\.0_x64-setup\.exe')) {
            if (Assert-NoLeftovers 'C8') { Pass 'C8' 'SHA256SUMS mismatch exits 20 without downloading setup exe' }
        } else {
            Fail 'C8' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C8b: SUMS lists the name twice -> 20
        Setup-Case
        Write-Utf8NoBom -Path (Join-Path $script:CaseServer 'SHA256SUMS.txt') -Text ($FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n" + $FixSha + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 20) {
            if (Assert-NoLeftovers 'C8b') { Pass 'C8b' 'duplicate entry in SHA256SUMS exits 20' }
        } else {
            Fail 'C8b' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C9: MOCK_CURL_404=SHA256SUMS.txt -> 10
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_CURL_404 = 'SHA256SUMS.txt' }
        if ($res.ExitCode -eq 10) {
            if (Assert-NoLeftovers 'C9') { Pass 'C9' 'SHA256SUMS 404 exits 10' }
        } else {
            Fail 'C9' ("rc=" + $res.ExitCode)
        }

        # C10: MOCK_CURL_TRUNC=Fleuron_2.11.0_x64-setup.exe:18 -> 10
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_CURL_TRUNC = 'Fleuron_2.11.0_x64-setup.exe:18' }
        if ($res.ExitCode -eq 10) {
            if (Assert-NoLeftovers 'C10') { Pass 'C10' 'truncated setup with curl exit 18 exits 10' }
        } else {
            Fail 'C10' ("rc=" + $res.ExitCode)
        }

        # C11: MOCK_CURL_TRUNC=Fleuron_2.11.0_x64-setup.exe:0 -> 20
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_CURL_TRUNC = 'Fleuron_2.11.0_x64-setup.exe:0' }
        if ($res.ExitCode -eq 20) {
            if (Assert-NoLeftovers 'C11') { Pass 'C11' 'truncated setup with curl exit 0 exits 20' }
        } else {
            Fail 'C11' ("rc=" + $res.ExitCode)
        }

        # C12: MOCK_CURL_MOTW=1 -> 30, Zone.Identifier + POLICY STOP, no Unblock, no setup
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_CURL_MOTW = '1' }
        if ($res.ExitCode -eq 30 -and
            $res.Out -match 'Zone\.Identifier' -and
            $res.Out -match 'POLICY STOP' -and
            $res.Out -notmatch 'Unblock' -and
            -not (Test-LogHas '^setup ')) {
            if (Assert-NoLeftovers 'C12') { Pass 'C12' 'MOTW Zone.Identifier exits 30 with POLICY STOP without running setup' }
        } else {
            Fail 'C12' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C13a: SAC = 1 -> 30, zero curl
        Setup-Case
        $ciKey = Join-Path $script:RegRoot 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
        New-Item -Path $ciKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $ciKey -Name 'VerifiedAndReputablePolicyState' -Value 1 -Type DWord
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 30 -and -not (Test-LogHas '^curl ')) {
            if (Assert-NoLeftovers 'C13a') { Pass 'C13a' 'Smart App Control enforced (1) exits 30 with zero curl' }
        } else {
            Fail 'C13a' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C13b: SAC = 2 -> 0 with evaluation mode warning
        Setup-Case
        $ciKey = Join-Path $script:RegRoot 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
        New-Item -Path $ciKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $ciKey -Name 'VerifiedAndReputablePolicyState' -Value 2 -Type DWord
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 0 -and $res.Out -match 'evaluation mode') {
            if (Assert-NoLeftovers 'C13b') { Pass 'C13b' 'Smart App Control evaluation mode (2) warns and installs' }
        } else {
            Fail 'C13b' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C14: ConstrainedLanguage -> 30
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_LANGMODE = 'ConstrainedLanguage' }
        if ($res.ExitCode -eq 30) {
            if (Assert-NoLeftovers 'C14') { Pass 'C14' 'ConstrainedLanguage mode exits 30' }
        } else {
            Fail 'C14' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C15a: HKLM SmartScreen Block -> 30
        Setup-Case
        $ssHklm = Join-Path $script:RegRoot 'HKLM\SOFTWARE\Policies\Microsoft\Windows\System'
        New-Item -Path $ssHklm -Force | Out-Null
        Set-ItemProperty -LiteralPath $ssHklm -Name 'EnableSmartScreen' -Value 1 -Type DWord
        Set-ItemProperty -LiteralPath $ssHklm -Name 'ShellSmartScreenLevel' -Value 'Block'
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 30) {
            if (Assert-NoLeftovers 'C15a') { Pass 'C15a' 'HKLM SmartScreen Block policy exits 30' }
        } else {
            Fail 'C15a' ("rc=" + $res.ExitCode)
        }

        # C15b: HKCU SmartScreen Block -> 30
        Setup-Case
        $ssHkcu = Join-Path $script:RegRoot 'HKCU\SOFTWARE\Policies\Microsoft\Windows\System'
        New-Item -Path $ssHkcu -Force | Out-Null
        Set-ItemProperty -LiteralPath $ssHkcu -Name 'EnableSmartScreen' -Value 1 -Type DWord
        Set-ItemProperty -LiteralPath $ssHkcu -Name 'ShellSmartScreenLevel' -Value 'Block'
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 30) {
            if (Assert-NoLeftovers 'C15b') { Pass 'C15b' 'HKCU SmartScreen Block policy exits 30' }
        } else {
            Fail 'C15b' ("rc=" + $res.ExitCode)
        }

        # C15c: S Mode SkuPolicyRequired=1 -> 30
        Setup-Case
        $ciKey = Join-Path $script:RegRoot 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
        New-Item -Path $ciKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $ciKey -Name 'SkuPolicyRequired' -Value 1 -Type DWord
        $res = Run-Installer -ScriptPath $Rendered -ArgList @()
        if ($res.ExitCode -eq 30) {
            if (Assert-NoLeftovers 'C15c') { Pass 'C15c' 'S Mode SkuPolicyRequired=1 exits 30' }
        } else {
            Fail 'C15c' ("rc=" + $res.ExitCode)
        }

        # C15d: DeviceGuard UMCI = 2 -> 30
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_DEVICEGUARD = '2' }
        if ($res.ExitCode -eq 30) {
            if (Assert-NoLeftovers 'C15d') { Pass 'C15d' 'WDAC DeviceGuard UMCI=2 exits 30' }
        } else {
            Fail 'C15d' ("rc=" + $res.ExitCode)
        }

        # C16a: MOCK_SETUP_EXIT=2 -> 50
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_SETUP_EXIT = '2' }
        if ($res.ExitCode -eq 50) {
            if (Assert-NoLeftovers 'C16a') { Pass 'C16a' 'setup exit code 2 exits 50' }
        } else {
            Fail 'C16a' ("rc=" + $res.ExitCode)
        }

        # C16b: MOCK_SETUP_SLEEP=60 + TIMEOUT=3 -> 50, no setup process, temp dir removed
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ MOCK_SETUP_SLEEP = '60'; FLEURON_INSTALL_TEST_TIMEOUT_SEC = '3' }
        if ($res.ExitCode -eq 50) {
            if (Assert-NoLeftovers 'C16b') { Pass 'C16b' 'setup timeout exits 50 and cleans up setup process and temp dir' }
        } else {
            Fail 'C16b' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C17: running Fleuron.exe -> 4, zero curl
        Setup-Case
        $runProc = $null
        try {
            $runProc = Start-MockRunningFleuron
            $res = Run-Installer -ScriptPath $Rendered -ArgList @()
            if ($res.ExitCode -eq 4 -and -not (Test-LogHas '^curl ')) {
                if (Assert-NoLeftovers 'C17') { Pass 'C17' 'running Fleuron process exits 4 with zero curl' }
            } else {
                Fail 'C17' ("rc=" + $res.ExitCode + " out=" + $res.Out)
            }
        } finally {
            Stop-MockRunningFleuron -Proc $runProc
        }

        # C18: elevated -> 3
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_ELEVATED = '1' }
        if ($res.ExitCode -eq 3) {
            if (Assert-NoLeftovers 'C18') { Pass 'C18' 'elevated check exits 3' }
        } else {
            Fail 'C18' ("rc=" + $res.ExitCode)
        }

        # C19: old OS build 17134 -> 3
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_OSBUILD = '17134' }
        if ($res.ExitCode -eq 3) {
            if (Assert-NoLeftovers 'C19') { Pass 'C19' 'unsupported Windows build 17134 exits 3' }
        } else {
            Fail 'C19' ("rc=" + $res.ExitCode)
        }

        # C20: local installer path args -> 2, zero curl
        Setup-Case
        $r20a = Run-Installer -ScriptPath $Rendered -ArgList @('C:\x\Fleuron_2.11.0_x64-setup.exe')
        $hasCurlA = Test-LogHas '^curl '
        Setup-Case
        $r20b = Run-Installer -ScriptPath $Rendered -ArgList @('foo.exe')
        $hasCurlB = Test-LogHas '^curl '
        if ($r20a.ExitCode -eq 2 -and -not $hasCurlA -and $r20b.ExitCode -eq 2 -and -not $hasCurlB) {
            if (Assert-NoLeftovers 'C20') { Pass 'C20' 'local setup file/path args exit 2 with zero curl' }
        } else {
            Fail 'C20' ("rcA=" + $r20a.ExitCode + " rcB=" + $r20b.ExitCode)
        }

        # C21: evil dir prepended to PATH -> 0 and no EVIL_RAN
        Setup-Case
        Remove-Item -LiteralPath $EvilMarker -Force -ErrorAction SilentlyContinue
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ PATH = ($EvilDir + ';' + $env:PATH) }
        if ($res.ExitCode -eq 0 -and -not (Test-Path -LiteralPath $EvilMarker)) {
            if (Assert-NoLeftovers 'C21') { Pass 'C21' 'shadowed curl.exe on PATH is ignored' }
        } else {
            Fail 'C21' ("rc=" + $res.ExitCode + " evil=" + (Test-Path -LiteralPath $EvilMarker))
        }

        # C22: incomplete test mode (only SYSROOT set, REGROOT removed) -> 2
        Setup-Case
        $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_REGROOT = $null }
        if ($res.ExitCode -eq 2) {
            if (Assert-NoLeftovers 'C22') { Pass 'C22' 'incomplete test mode without REGROOT exits 2' }
        } else {
            Fail 'C22' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C23: unrendered template -> 2, "unrendered"
        Setup-Case
        $res = Run-Installer -ScriptPath $Template -ArgList @()
        if ($res.ExitCode -eq 2 -and $res.Out -match 'unrendered') {
            if (Assert-NoLeftovers 'C23') { Pass 'C23' 'unrendered template exits 2 with unrendered message' }
        } else {
            Fail 'C23' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C25: --uninstall
        Setup-Case
        $rC25Inst = Run-Installer -ScriptPath $Rendered -ArgList @()
        $studyDir = Join-Path $script:CaseHome 'Fleuron'
        $roamDir = Join-Path $script:CaseRoaming 'study.fleuron.desktop'
        New-Item -ItemType Directory -Path $studyDir -Force | Out-Null
        New-Item -ItemType Directory -Path $roamDir -Force | Out-Null
        $studyCanary = Join-Path $studyDir 'study.txt'
        $roamCanary = Join-Path $roamDir 'x'
        Write-Utf8NoBom -Path $studyCanary -Text 'keep-study'
        Write-Utf8NoBom -Path $roamCanary -Text 'keep-roam'

        $r25a = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall')
        $c25aOk = ($rC25Inst.ExitCode -eq 0) -and
                  ($r25a.ExitCode -eq 0) -and
                  (-not (Test-Path -LiteralPath $installedExe)) -and
                  (Test-Path -LiteralPath $studyCanary) -and
                  (Test-Path -LiteralPath $roamCanary) -and
                  ([System.IO.File]::ReadAllText($studyCanary) -eq 'keep-study') -and
                  ([System.IO.File]::ReadAllText($roamCanary) -eq 'keep-roam')

        $r25b = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall')
        $c25bOk = ($r25b.ExitCode -eq 0) -and ($r25b.Out -match 'not installed')

        Setup-Case
        $fDir = Join-Path $script:CaseLocal 'Fleuron'
        New-Item -ItemType Directory -Path $fDir -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $MockDir 'app-foreign.exe') -Destination $installedExe -Force
        $r25c = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall')
        $c25cOk = ($r25c.ExitCode -eq 5)

        Setup-Case
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.11.0.exe') -DisplayVersion '2.11.0' -UninstallStringOverride '"C:\elsewhere\uninstall.exe"'
        $r25d = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall')
        $c25dOk = ($r25d.ExitCode -eq 5)

        Setup-Case
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.11.0.exe') -DisplayVersion '2.11.0'
        $r25e = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall') -ExtraEnv @{ MOCK_UNINSTALL_NOOP = '1'; FLEURON_INSTALL_TEST_TIMEOUT_SEC = '3' }
        $c25eOk = ($r25e.ExitCode -eq 50)

        if ($c25aOk -and $c25bOk -and $c25cOk -and $c25dOk -and $c25eOk) {
            if (Assert-NoLeftovers 'C25') { Pass 'C25' '--uninstall removes Fleuron, preserves studies/settings, handles absent/foreign/bad-uninstaller/timeout' }
        } else {
            Fail 'C25' ("a=$c25aOk b=$c25bOk c=$c25cOk d=$c25dOk e=$c25eOk")
        }

        # C26: --reinstall on current -> 0, exe curl and setup lines present
        Setup-Case
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.11.0.exe') -DisplayVersion '2.11.0'
        $res = Run-Installer -ScriptPath $Rendered -ArgList @('--reinstall')
        if ($res.ExitCode -eq 0 -and
            (Test-LogHas '^curl .*Fleuron_2\.11\.0_x64-setup\.exe') -and
            (Test-LogHas '^setup /S$')) {
            if (Assert-NoLeftovers 'C26') { Pass 'C26' '--reinstall on current version re-downloads and runs setup' }
        } else {
            Fail 'C26' ("rc=" + $res.ExitCode + " out=" + $res.Out)
        }

        # C27: CLI flags (--help, -h, --bogus, two args, -Uninstall)
        Setup-Case
        $r27h1 = Run-Installer -ScriptPath $Rendered -ArgList @('--help')
        $r27h2 = Run-Installer -ScriptPath $Rendered -ArgList @('-h')
        $r27bogus = Run-Installer -ScriptPath $Rendered -ArgList @('--bogus')
        $r27two = Run-Installer -ScriptPath $Rendered -ArgList @('--help', '--reinstall')
        Install-MockState -ExeSource (Join-Path $MockDir 'app-2.11.0.exe') -DisplayVersion '2.11.0'
        $r27u = Run-Installer -ScriptPath $Rendered -ArgList @('-Uninstall')
        $c27Ok = ($r27h1.ExitCode -eq 0 -and $r27h1.Out -match 'Usage:') -and
                 ($r27h2.ExitCode -eq 0 -and $r27h2.Out -match 'Usage:') -and
                 ($r27bogus.ExitCode -eq 2) -and
                 ($r27two.ExitCode -eq 2) -and
                 ($r27u.ExitCode -eq 0 -and -not (Test-Path -LiteralPath $installedExe))
        if ($c27Ok) {
            if (Assert-NoLeftovers 'C27') { Pass 'C27' 'CLI options --help, -h, --bogus, two args, and -Uninstall behave as specified' }
        } else {
            Fail 'C27' ("h1=$($r27h1.ExitCode) h2=$($r27h2.ExitCode) bogus=$($r27bogus.ExitCode) two=$($r27two.ExitCode) u=$($r27u.ExitCode)")
        }

        # pwsh 7 checks on Windows (if available)
        if ($null -ne $PwshExe) {
            Write-Host '-- PowerShell 7 checks (C1-pwsh, C2-pwsh, C25-pwsh, C27-pwsh) ...'

            Setup-Case
            $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ShellExe $PwshExe
            if ($res.ExitCode -eq 0 -and (Get-ExeFileVersion $installedExe) -eq '2.11.0' -and (Test-LogHas '^setup /S$')) {
                if (Assert-NoLeftovers 'C1-pwsh') { Pass 'C1-pwsh' 'fresh install succeeds under pwsh 7' }
            } else {
                Fail 'C1-pwsh' ("rc=" + $res.ExitCode + " out=" + $res.Out)
            }

            Write-Utf8NoBom -Path $script:CaseLog -Text ''
            $res = Run-Installer -ScriptPath $Rendered -ArgList @() -ShellExe $PwshExe
            if ($res.ExitCode -eq 0 -and $res.Out -match 'nothing to do' -and -not (Test-LogHas '^curl ')) {
                if (Assert-NoLeftovers 'C2-pwsh') { Pass 'C2-pwsh' 'second run exits 0 without curl under pwsh 7' }
            } else {
                Fail 'C2-pwsh' ("rc=" + $res.ExitCode + " out=" + $res.Out)
            }

            Setup-Case
            Install-MockState -ExeSource (Join-Path $MockDir 'app-2.11.0.exe') -DisplayVersion '2.11.0'
            $res = Run-Installer -ScriptPath $Rendered -ArgList @('--uninstall') -ShellExe $PwshExe
            if ($res.ExitCode -eq 0 -and -not (Test-Path -LiteralPath $installedExe)) {
                if (Assert-NoLeftovers 'C25-pwsh') { Pass 'C25-pwsh' '--uninstall succeeds under pwsh 7' }
            } else {
                Fail 'C25-pwsh' ("rc=" + $res.ExitCode + " out=" + $res.Out)
            }

            Setup-Case
            $rH = Run-Installer -ScriptPath $Rendered -ArgList @('--help') -ShellExe $PwshExe
            $rB = Run-Installer -ScriptPath $Rendered -ArgList @('--bogus') -ShellExe $PwshExe
            if ($rH.ExitCode -eq 0 -and $rH.Out -match 'Usage:' -and $rB.ExitCode -eq 2) {
                if (Assert-NoLeftovers 'C27-pwsh') { Pass 'C27-pwsh' 'CLI flag handling succeeds under pwsh 7' }
            } else {
                Fail 'C27-pwsh' ("h=$($rH.ExitCode) b=$($rB.ExitCode)")
            }
        }

        # -- Gate mutation checks M-<MARKER> --
        Write-Host '-- Gate mutation checks (M-*) ...'

        function New-MutatedScript {
            param([string]$Marker, [string]$ReplacementLine, [string]$OutPath)
            $suffix = '# ' + $Marker
            $lines = $RenderedText -split "`r?`n"
            $hits = 0
            $outLines = New-Object System.Collections.Generic.List[string]
            foreach ($ln in $lines) {
                if ($ln.EndsWith($suffix)) {
                    $hits++
                    $outLines.Add($ReplacementLine)
                } else {
                    $outLines.Add($ln)
                }
            }
            if ($hits -ne 1) { return $false }
            Write-Utf8NoBom -Path $OutPath -Text ($outLines -join "`r`n")
            return $true
        }

        # M-CURL-PATH
        Setup-Case
        Remove-Item -LiteralPath $EvilMarker -Force -ErrorAction SilentlyContinue
        $mutPath = Join-Path $script:CaseTemp 'mut_curl_path.ps1'
        $curlMutLine = '$script:CurlExe = (Get-Command -Name ''curl.exe'' -CommandType Application | Select-Object -First 1).Source  # CURL-PATH-MUT'
        if (-not (New-MutatedScript -Marker 'CURL-PATH' -ReplacementLine $curlMutLine -OutPath $mutPath)) {
            Fail 'M-CURL-PATH' 'marker # CURL-PATH not found exactly once'
        } else {
            $null = Run-Installer -ScriptPath $mutPath -ArgList @() -ExtraEnv @{ PATH = ($EvilDir + ';' + $env:PATH) }
            $ranEvil = Test-Path -LiteralPath $EvilMarker
            Remove-Item -LiteralPath $EvilMarker -Force -ErrorAction SilentlyContinue
            if ($ranEvil) {
                if (Assert-NoLeftovers 'M-CURL-PATH') { Pass 'M-CURL-PATH' 'mutating CURL-PATH allows shadowed curl.exe to run' }
            } else {
                Fail 'M-CURL-PATH' 'shadowed curl.exe did not run after mutating CURL-PATH'
            }
        }

        # M-CHECKSUM-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_checksum.ps1'
        if (-not (New-MutatedScript -Marker 'CHECKSUM-GATE' -ReplacementLine '$null = 0  # CHECKSUM-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-CHECKSUM-GATE' 'marker # CHECKSUM-GATE not found exactly once'
        } else {
            $srvExe = Join-Path $script:CaseServer 'Fleuron_2.11.0_x64-setup.exe'
            $oldBytes = [System.IO.File]::ReadAllBytes($srvExe)
            $newBytes = New-Object byte[] ($oldBytes.Length + 1)
            [Array]::Copy($oldBytes, 0, $newBytes, 0, $oldBytes.Length)
            $newBytes[$oldBytes.Length] = [byte][char]'X'
            [System.IO.File]::WriteAllBytes($srvExe, $newBytes)
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 20) {
                if (Assert-NoLeftovers 'M-CHECKSUM-GATE') { Pass 'M-CHECKSUM-GATE' ("mutating CHECKSUM-GATE skips exit 20 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-CHECKSUM-GATE' 'mutated script still exited 20'
            }
        }

        # M-SUMS-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_sums.ps1'
        if (-not (New-MutatedScript -Marker 'SUMS-GATE' -ReplacementLine '$null = 0  # SUMS-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-SUMS-GATE' 'marker # SUMS-GATE not found exactly once'
        } else {
            Write-Utf8NoBom -Path (Join-Path $script:CaseServer 'SHA256SUMS.txt') -Text (('0' * 64) + '  Fleuron_2.11.0_x64-setup.exe' + "`n")
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 20) {
                if (Assert-NoLeftovers 'M-SUMS-GATE') { Pass 'M-SUMS-GATE' ("mutating SUMS-GATE skips exit 20 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-SUMS-GATE' 'mutated script still exited 20'
            }
        }

        # M-MOTW-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_motw.ps1'
        if (-not (New-MutatedScript -Marker 'MOTW-GATE' -ReplacementLine '$null = 0  # MOTW-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-MOTW-GATE' 'marker # MOTW-GATE not found exactly once'
        } else {
            $res = Run-Installer -ScriptPath $mutPath -ArgList @() -ExtraEnv @{ MOCK_CURL_MOTW = '1' }
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-MOTW-GATE') { Pass 'M-MOTW-GATE' ("mutating MOTW-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-MOTW-GATE' 'mutated script still exited 30'
            }
        }

        # M-SAC-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_sac.ps1'
        if (-not (New-MutatedScript -Marker 'SAC-GATE' -ReplacementLine '$null = 0  # SAC-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-SAC-GATE' 'marker # SAC-GATE not found exactly once'
        } else {
            $ciKey = Join-Path $script:RegRoot 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
            New-Item -Path $ciKey -Force | Out-Null
            Set-ItemProperty -LiteralPath $ciKey -Name 'VerifiedAndReputablePolicyState' -Value 1 -Type DWord
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-SAC-GATE') { Pass 'M-SAC-GATE' ("mutating SAC-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-SAC-GATE' 'mutated script still exited 30'
            }
        }

        # M-SMODE-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_smode.ps1'
        if (-not (New-MutatedScript -Marker 'SMODE-GATE' -ReplacementLine '$null = 0  # SMODE-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-SMODE-GATE' 'marker # SMODE-GATE not found exactly once'
        } else {
            $ciKey = Join-Path $script:RegRoot 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
            New-Item -Path $ciKey -Force | Out-Null
            Set-ItemProperty -LiteralPath $ciKey -Name 'SkuPolicyRequired' -Value 1 -Type DWord
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-SMODE-GATE') { Pass 'M-SMODE-GATE' ("mutating SMODE-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-SMODE-GATE' 'mutated script still exited 30'
            }
        }

        # M-SMARTSCREEN-POLICY-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_smartscreen.ps1'
        if (-not (New-MutatedScript -Marker 'SMARTSCREEN-POLICY-GATE' -ReplacementLine '$null = 0  # SMARTSCREEN-POLICY-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-SMARTSCREEN-POLICY-GATE' 'marker # SMARTSCREEN-POLICY-GATE not found exactly once'
        } else {
            $ssHklm = Join-Path $script:RegRoot 'HKLM\SOFTWARE\Policies\Microsoft\Windows\System'
            New-Item -Path $ssHklm -Force | Out-Null
            Set-ItemProperty -LiteralPath $ssHklm -Name 'EnableSmartScreen' -Value 1 -Type DWord
            Set-ItemProperty -LiteralPath $ssHklm -Name 'ShellSmartScreenLevel' -Value 'Block'
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-SMARTSCREEN-POLICY-GATE') { Pass 'M-SMARTSCREEN-POLICY-GATE' ("mutating SMARTSCREEN-POLICY-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-SMARTSCREEN-POLICY-GATE' 'mutated script still exited 30'
            }
        }

        # M-WDAC-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_wdac.ps1'
        if (-not (New-MutatedScript -Marker 'WDAC-GATE' -ReplacementLine '$null = 0  # WDAC-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-WDAC-GATE' 'marker # WDAC-GATE not found exactly once'
        } else {
            $res = Run-Installer -ScriptPath $mutPath -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_DEVICEGUARD = '2' }
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-WDAC-GATE') { Pass 'M-WDAC-GATE' ("mutating WDAC-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-WDAC-GATE' 'mutated script still exited 30'
            }
        }

        # M-LANGMODE-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_langmode.ps1'
        if (-not (New-MutatedScript -Marker 'LANGMODE-GATE' -ReplacementLine '$null = 0  # LANGMODE-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-LANGMODE-GATE' 'marker # LANGMODE-GATE not found exactly once'
        } else {
            $res = Run-Installer -ScriptPath $mutPath -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_LANGMODE = 'ConstrainedLanguage' }
            if ($res.ExitCode -ne 30) {
                if (Assert-NoLeftovers 'M-LANGMODE-GATE') { Pass 'M-LANGMODE-GATE' ("mutating LANGMODE-GATE skips exit 30 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-LANGMODE-GATE' 'mutated script still exited 30'
            }
        }

        # M-ELEVATION-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_elevation.ps1'
        if (-not (New-MutatedScript -Marker 'ELEVATION-GATE' -ReplacementLine '$null = 0  # ELEVATION-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-ELEVATION-GATE' 'marker # ELEVATION-GATE not found exactly once'
        } else {
            $res = Run-Installer -ScriptPath $mutPath -ArgList @() -ExtraEnv @{ FLEURON_INSTALL_TEST_ELEVATED = '1' }
            if ($res.ExitCode -ne 3) {
                if (Assert-NoLeftovers 'M-ELEVATION-GATE') { Pass 'M-ELEVATION-GATE' ("mutating ELEVATION-GATE skips exit 3 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-ELEVATION-GATE' 'mutated script still exited 3'
            }
        }

        # M-RUNNING-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_running.ps1'
        if (-not (New-MutatedScript -Marker 'RUNNING-GATE' -ReplacementLine '$null = 0  # RUNNING-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-RUNNING-GATE' 'marker # RUNNING-GATE not found exactly once'
        } else {
            $runProc = $null
            try {
                $runProc = Start-MockRunningFleuron
                $res = Run-Installer -ScriptPath $mutPath -ArgList @()
                if ($res.ExitCode -ne 4) {
                    if (Assert-NoLeftovers 'M-RUNNING-GATE') { Pass 'M-RUNNING-GATE' ("mutating RUNNING-GATE skips exit 4 (rc=" + $res.ExitCode + ")") }
                } else {
                    Fail 'M-RUNNING-GATE' 'mutated script still exited 4'
                }
            } finally {
                Stop-MockRunningFleuron -Proc $runProc
            }
        }

        # M-OWNERSHIP-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_ownership.ps1'
        if (-not (New-MutatedScript -Marker 'OWNERSHIP-GATE' -ReplacementLine '$null = 0  # OWNERSHIP-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-OWNERSHIP-GATE' 'marker # OWNERSHIP-GATE not found exactly once'
        } else {
            $jTarget = Join-Path $script:CaseTemp 'jtarget_mut'
            New-Item -ItemType Directory -Path $jTarget -Force | Out-Null
            $jPath = Join-Path $script:CaseLocal 'Fleuron'
            New-Item -ItemType Junction -Path $jPath -Target $jTarget | Out-Null
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 5) {
                if (Assert-NoLeftovers 'M-OWNERSHIP-GATE') { Pass 'M-OWNERSHIP-GATE' ("mutating OWNERSHIP-GATE skips exit 5 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-OWNERSHIP-GATE' 'mutated script still exited 5'
            }
        }

        # M-MACHINE-WIDE-GATE
        Setup-Case
        $mutPath = Join-Path $script:CaseTemp 'mut_machinewide.ps1'
        if (-not (New-MutatedScript -Marker 'MACHINE-WIDE-GATE' -ReplacementLine '$null = 0  # MACHINE-WIDE-GATE-MUT' -OutPath $mutPath)) {
            Fail 'M-MACHINE-WIDE-GATE' 'marker # MACHINE-WIDE-GATE not found exactly once'
        } else {
            $hklmUk = Join-Path $script:RegRoot 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron'
            New-Item -Path $hklmUk -Force | Out-Null
            $res = Run-Installer -ScriptPath $mutPath -ArgList @()
            if ($res.ExitCode -ne 5) {
                if (Assert-NoLeftovers 'M-MACHINE-WIDE-GATE') { Pass 'M-MACHINE-WIDE-GATE' ("mutating MACHINE-WIDE-GATE skips exit 5 (rc=" + $res.ExitCode + ")") }
            } else {
                Fail 'M-MACHINE-WIDE-GATE' 'mutated script still exited 5'
            }
        }
    }
} catch {
    if ("$($_.Exception.Message)" -ne 'PRE-FLIGHT-ABORT') {
        Fail 'HARNESS' ("unhandled exception: " + $_.Exception.Message)
    }
} finally {
    if ($IsWin) {
        try {
            $stray = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($RunGuid) -and [int]$_.ProcessId -ne $PID })
            foreach ($sp in $stray) {
                & taskkill /T /F /PID ([int]$sp.ProcessId) 2>&1 | Out-Null
            }
        } catch { }
        if ($TestRegParent.StartsWith('HKCU:\Software\FleuronInstallTest\')) {
            if (Test-Path -LiteralPath $TestRegParent) {
                Remove-Item -LiteralPath $TestRegParent -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Remove-ReparsePointsUnder -RootPath $T
    if (Test-Path -LiteralPath $T) {
        Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
if ($script:FailCount -gt 0) {
    Write-Host ("install-windows test suite: {0} failed, {1} passed" -f $script:FailCount, $script:PassCount)
    exit 1
}
Write-Host ("install-windows test suite: all {0} checks passed ({1} skipped)" -f $script:PassCount, $script:SkipCount)
exit 0
