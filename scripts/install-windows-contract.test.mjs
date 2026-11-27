#!/usr/bin/env node
// Windows PowerShell installer static contract tests.
//
// Enforces every security, policy, and rendering invariant on
// scripts/install-windows.ps1 and scripts/render-install-windows.sh.
// Run via `node --test scripts/install-windows-contract.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNoSecurityMutations } from "./nsis-template.test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const readFile = (p) => readFileSync(`${root}${p}`, "utf8");
const readJson = (p) => JSON.parse(readFile(p));

const MARKERS = [
  "CURL-PATH",
  "CHECKSUM-GATE",
  "SUMS-GATE",
  "MOTW-GATE",
  "SAC-GATE",
  "SMODE-GATE",
  "SMARTSCREEN-POLICY-GATE",
  "WDAC-GATE",
  "LANGMODE-GATE",
  "ELEVATION-GATE",
  "RUNNING-GATE",
  "OWNERSHIP-GATE",
  "MACHINE-WIDE-GATE",
];

const EXPECTED_EXIT_CODES = [2, 3, 4, 5, 10, 20, 30, 50];

/**
 * Validate the static security and structural contract of
 * scripts/install-windows.ps1. Throws with a descriptive message on violation.
 */
export function verifyWindowsInstallerTemplate(text) {
  const lines = text.split(/\r?\n/);

  // 1. BANS (whole text, comments included) — checked first so negative
  //    mutations report the exact banned construct rather than a downstream check.
  const bans = [
    [/-ExecutionPolicy\s+(Bypass|Unrestricted)/i, "template must never use -ExecutionPolicy Bypass or Unrestricted"],
    [/\bSet-ExecutionPolicy\b/i, "template must never call Set-ExecutionPolicy"],
    [/\bUnblock-File\b/i, "template must never call Unblock-File"],
    [/\bInvoke-Expression\b/i, "template must never call Invoke-Expression"],
    [/\biex\b/i, "template must never invoke iex"],
    [/\[scriptblock\]::Create/i, "template must never call [scriptblock]::Create"],
    [/-EncodedCommand|FromBase64String/i, "template must never use -EncodedCommand or FromBase64String"],
    [/\bAdd-Type\b/i, "template must never call Add-Type"],
    [
      /\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\biwr\b|\birm\b|WebClient|DownloadString|DownloadFile|BitsTransfer|bitsadmin|HttpClient/i,
      "template must never use Invoke-WebRequest/Invoke-RestMethod/WebClient/BITS/HttpClient",
    ],
    [/-Verb\s+RunAs/i, "template must never elevate with -Verb RunAs"],
    [/\brunas(\.exe)?\b/i, "template must never invoke runas"],
    [/\bsudo\b/i, "template must never invoke sudo"],
    [/\bgsudo\b/i, "template must never invoke gsudo"],
    [/Start-Process[^\n]*-Credential/i, "template must never pass -Credential to Start-Process"],
    [/\b(Add|Set|Remove)-MpPreference\b/i, "template must never call Add/Set/Remove-MpPreference"],
    [/\bMpCmdRun\b/i, "template must never invoke MpCmdRun"],
    [/\bSet-ProcessMitigation\b/i, "template must never call Set-ProcessMitigation"],
    [/\bCiTool\b/i, "template must never invoke CiTool"],
    [
      /\bSet-RuleOption\b|\bSet-CIPolicy\b|\bMerge-CIPolicy\b|\bSet-AppLockerPolicy\b/i,
      "template must never mutate WDAC or AppLocker policies",
    ],
    [/\bbcdedit\b/i, "template must never invoke bcdedit"],
    [/\bnetsh\b/i, "template must never invoke netsh"],
    [/\bcertutil\b/i, "template must never invoke certutil"],
    [/\btaskkill\b/i, "template must never invoke taskkill"],
    [/\breg(\.exe)?\s+(add|delete|import|copy|load|restore)\b/i, "template must never mutate the registry with reg"],
    [/\[Microsoft\.Win32\.Registry/i, "template must never access Microsoft.Win32.Registry"],
    [/\bCreateSubKey\b|\bSetValue\s*\(/, "template must never call CreateSubKey or SetValue"],
    [
      /\b(New-Item|Set-Item|Set-ItemProperty|New-ItemProperty|Remove-Item|Remove-ItemProperty|Rename-Item|Rename-ItemProperty|Copy-ItemProperty|Move-ItemProperty|Clear-ItemProperty)\b[^\n]*(HKLM|HKCU|HKEY_|Registry::|RegHK)/i,
      "template must never mutate registry keys or properties (HKLM/HKCU/Registry::/RegHK)",
    ],
    [/releases\/latest/, "template must never fetch releases/latest"],
    [/\$IsWindows|\$IsLinux|\$IsMacOS/, "template must remain PowerShell 5.1 compatible (no $IsWindows/$IsLinux/$IsMacOS)"],
    [/&&|\|\||\?\?|\?\./, "template must remain PowerShell 5.1 compatible (no &&, ||, ??, or ?. operators)"],
    [/@"|@'/, "template must not use here-strings (@\" or @')"],
    [/[^\x00-\x7f]/, "template must contain ASCII characters only"],
  ];

  for (const [re, msg] of bans) {
    assert.doesNotMatch(text, re, msg);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.includes("-Stream")) {
      assert.match(
        line,
        /Get-Item -LiteralPath \$\w+ -Stream 'Zone\.Identifier' -ErrorAction SilentlyContinue/,
        `line ${lineNo}: -Stream may only be used for read-only Zone.Identifier inspection via Get-Item`,
      );
    }
    if (/\bRemove-Item\b/.test(line)) {
      assert.match(
        line,
        /Remove-Item -LiteralPath \$(script:Work|probe)\b/,
        `line ${lineNo}: Remove-Item may only delete $script:Work or $probe`,
      );
    }
    if (/\bStart-Process\b/.test(line)) {
      assert.ok(
        line.includes("-ArgumentList '/S' -PassThru") && !line.includes("-Verb"),
        `line ${lineNo}: Start-Process must include "-ArgumentList '/S' -PassThru" and never "-Verb"`,
      );
    }
    if (/\bStop-Process\b/.test(line)) {
      assert.ok(
        line.includes("-Id"),
        `line ${lineNo}: Stop-Process must target a specific process with -Id`,
      );
    }
    if (/^\s*&\s*['"]?[^$\s]*curl/im.test(line) || /\bcurl(?:\.exe)?\s+-/i.test(line)) {
      assert.fail(`line ${lineNo}: curl must only be invoked via $script:CurlExe @curlArgs`);
    }
  }

  verifyNoSecurityMutations(text);

  // 2. PRESENCE
  const verMatches = [...text.matchAll(/^\$FleuronVersion = '__FLEURON_VERSION__'\r?$/gm)].length;
  assert.equal(
    verMatches,
    1,
    `expected exactly 1 "$FleuronVersion = '__FLEURON_VERSION__'" line, found ${verMatches}`,
  );
  const shaMatches = [...text.matchAll(/^\$FleuronSetupSha256 = '__FLEURON_SETUP_SHA256__'\r?$/gm)].length;
  assert.equal(
    shaMatches,
    1,
    `expected exactly 1 "$FleuronSetupSha256 = '__FLEURON_SETUP_SHA256__'" line, found ${shaMatches}`,
  );

  const placeholderCount = [...text.matchAll(/__FLEURON_/g)].length;
  assert.equal(
    placeholderCount,
    2,
    `expected exactly 2 occurrences of "__FLEURON_", found ${placeholderCount}`,
  );

  const expectedCurlLine = "$script:CurlExe = Join-Path $script:SystemRootDir 'System32\\curl.exe'  # CURL-PATH";
  assert.ok(
    lines.some((l) => l.trim() === expectedCurlLine),
    `missing exact trimmed line: ${expectedCurlLine}`,
  );

  for (const literal of [
    "& $script:CurlExe @curlArgs",
    "'--proto', '=https'",
    "'--proto-redir', '=https'",
    "'--tlsv1.2'",
    "'--fail'",
    "https://github.com/wilsonhyeh/fleuron/releases/download/v$FleuronVersion",
    "SHA256SUMS.txt",
    "Get-FileHash -LiteralPath",
    "-Algorithm SHA256",
    "VerifiedAndReputablePolicyState",
    "SkuPolicyRequired",
    "ShellSmartScreenLevel",
    "UsermodeCodeIntegrityPolicyEnforcementStatus",
    "LanguageMode",
    "Zone.Identifier",
    "uninstall.exe",
    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fleuron",
    "Software\\Fleuron\\Fleuron",
  ]) {
    assert.ok(text.includes(literal), `missing required token: ${literal}`);
  }

  assert.ok(
    lines.some((l) => l.includes("-cne $FleuronSetupSha256") && l.trimEnd().endsWith("# CHECKSUM-GATE")),
    'missing line containing "-cne $FleuronSetupSha256" and ending "# CHECKSUM-GATE"',
  );

  for (const marker of MARKERS) {
    const count = [...text.matchAll(new RegExp(`#\\s*${marker}(?![A-Za-z0-9_-])`, "g"))].length;
    assert.equal(count, 1, `expected marker # ${marker} exactly once, found ${count}`);
  }

  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  assert.equal(
    nonEmpty[nonEmpty.length - 1],
    "Invoke-FleuronMain -ArgList $args",
    'last non-empty line must be "Invoke-FleuronMain -ArgList $args"',
  );

  assert.doesNotMatch(text, /-Code\s+40\b/, 'exit code "-Code 40" must be absent');
  const foundCodes = [...new Set([...text.matchAll(/-Code (\d+)/g)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
  assert.deepEqual(
    foundCodes,
    EXPECTED_EXIT_CODES,
    `expected -Code set {${EXPECTED_EXIT_CODES.join(",")}}, found {${foundCodes.join(",")}}`,
  );
}

/** Insert a test probe line just before the final Invoke-FleuronMain call. */
function insertBeforeMain(text, line) {
  const marker = "\nInvoke-FleuronMain -ArgList $args";
  const idx = text.lastIndexOf(marker);
  assert.notEqual(idx, -1, "template missing Invoke-FleuronMain tail");
  return `${text.slice(0, idx)}\n${line}${text.slice(idx)}`;
}

// ----------------------
// Tests
// ----------------------

test("the Windows installer template satisfies its security contract", () => {
  const tpl = readFile("scripts/install-windows.ps1");
  verifyWindowsInstallerTemplate(tpl);
});

test("negative mutations make the contract fail", () => {
  const tpl = readFile("scripts/install-windows.ps1");
  const mutations = [
    ["Unblock-File banned sample", (t) => insertBeforeMain(t, "Unblock-File -Path x"), /Unblock-File/],
    [
      "ExecutionPolicy Bypass banned sample",
      (t) => insertBeforeMain(t, "powershell -ExecutionPolicy Bypass -File x"),
      /-ExecutionPolicy/,
    ],
    [
      "Set-ExecutionPolicy banned sample",
      (t) => insertBeforeMain(t, "Set-ExecutionPolicy RemoteSigned"),
      /Set-ExecutionPolicy/,
    ],
    ["iex banned sample", (t) => insertBeforeMain(t, "iex $s"), /iex/],
    [
      "Invoke-WebRequest banned sample",
      (t) => insertBeforeMain(t, "Invoke-WebRequest -Uri u -OutFile f"),
      /Invoke-WebRequest/,
    ],
    [
      "Start-Process -Verb RunAs banned sample",
      (t) => insertBeforeMain(t, "Start-Process x -Verb RunAs"),
      /-Verb\s+RunAs|RunAs/,
    ],
    [
      "Add-MpPreference banned sample",
      (t) => insertBeforeMain(t, "Add-MpPreference -ExclusionPath C:\\x"),
      /Add\/Set\/Remove-MpPreference|MpPreference/,
    ],
    [
      "Set-ItemProperty HKLM banned sample",
      (t) =>
        insertBeforeMain(
          t,
          "Set-ItemProperty -Path HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System -Name EnableSmartScreen -Value 0",
        ),
      /registry/i,
    ],
    [
      "New-ItemProperty RegHKLM banned sample",
      (t) => insertBeforeMain(t, "New-ItemProperty -Path $script:RegHKLM -Name x"),
      /registry/i,
    ],
    [
      "Remove-Item on USERPROFILE banned sample",
      (t) => insertBeforeMain(t, 'Remove-Item -LiteralPath "$env:USERPROFILE\\Fleuron" -Recurse'),
      /Remove-Item/,
    ],
    [
      "Remove-Item -Stream Zone.Identifier banned sample",
      (t) => insertBeforeMain(t, "Remove-Item -Path x -Stream Zone.Identifier"),
      /Stream|Remove-Item/,
    ],
    ["PowerShell 7 null-coalescing ?? banned sample", (t) => insertBeforeMain(t, "$a = $b ?? 1"), /\?\?/],
    [
      "releases/latest banned sample",
      (t) => insertBeforeMain(t, "# https://github.com/wilsonhyeh/fleuron/releases/latest/download/x"),
      /releases\/latest/,
    ],
    ["curl.exe -fsSL banned sample", (t) => insertBeforeMain(t, "curl.exe -fsSL u"), /curl/],
    ["curly-quote non-ASCII character", (t) => insertBeforeMain(t, "# \u201chello\u201d"), /ASCII/],
    ["Invoke-Expression banned sample", (t) => insertBeforeMain(t, "Invoke-Expression $cmd"), /Invoke-Expression/],
    ["Add-Type banned sample", (t) => insertBeforeMain(t, "Add-Type -TypeDefinition $cs"), /Add-Type/],
    [
      "Start-Process -Credential banned sample",
      (t) => insertBeforeMain(t, "Start-Process -FilePath $setup -Credential $cred"),
      /-Credential/,
    ],
    [
      "Start-Process missing /S -PassThru",
      (t) => insertBeforeMain(t, "Start-Process -FilePath $setup"),
      /Start-Process/,
    ],
    ["Stop-Process missing -Id", (t) => insertBeforeMain(t, "Stop-Process -Name Fleuron"), /Stop-Process/],
    ["here-string banned sample", (t) => insertBeforeMain(t, '$s = @"\nhi\n"@'), /here-string/],
    ["deleting # CHECKSUM-GATE", (t) => t.replace("  # CHECKSUM-GATE", ""), /CHECKSUM-GATE/],
    ["deleting # MOTW-GATE", (t) => t.replace("  # MOTW-GATE", ""), /MOTW-GATE/],
    ["deleting # SUMS-GATE", (t) => t.replace("  # SUMS-GATE", ""), /SUMS-GATE/],
    ["deleting # LANGMODE-GATE", (t) => t.replace("  # LANGMODE-GATE", ""), /LANGMODE-GATE/],
    [
      "duplicating a placeholder line",
      (t) =>
        t.replace(
          "$FleuronVersion = '__FLEURON_VERSION__'",
          "$FleuronVersion = '__FLEURON_VERSION__'\n$FleuronVersion = '__FLEURON_VERSION__'",
        ),
      /FleuronVersion/,
    ],
    [
      "removing the final line",
      (t) => t.replace(/\nInvoke-FleuronMain -ArgList \$args\s*$/, "\n"),
      /Invoke-FleuronMain/,
    ],
    [
      "appending -Code 40",
      (t) => insertBeforeMain(t, "function Test-BadCode { Stop-Fleuron -Code 40 -Message 'x' }"),
      /-Code 40/,
    ],
    [
      "removing '--proto-redir', '=https'",
      (t) => t.replace(" '--proto-redir', '=https',", ""),
      /--proto-redir/,
    ],
    ["removing '--tlsv1.2'", (t) => t.replace(" '--tlsv1.2',", ""), /--tlsv1\.2/],
  ];

  assert.ok(mutations.length >= 25, `expected at least 25 negative mutations, found ${mutations.length}`);
  for (const [name, mutate, expectedRe] of mutations) {
    const mutated = mutate(tpl);
    assert.notEqual(mutated, tpl, `mutation "${name}" did not modify template`);
    assert.throws(() => verifyWindowsInstallerTemplate(mutated), expectedRe, `mutation "${name}" must fail`);
  }
});

test("the PowerShell suite is wired", () => {
  assert.ok(
    existsSync(`${root}scripts/install-windows.test.ps1`),
    "missing scripts/install-windows.test.ps1",
  );
  const psTest = readFile("scripts/install-windows.test.ps1");
  for (const marker of MARKERS) {
    assert.ok(psTest.includes(marker), `scripts/install-windows.test.ps1 must reference marker ${marker}`);
  }
  assert.ok(psTest.includes("SKIP"), 'scripts/install-windows.test.ps1 must handle/mention "SKIP"');
  assert.ok(psTest.includes("csc.exe"), 'scripts/install-windows.test.ps1 must reference "csc.exe"');
});

test("the renderer works on Linux", (t) => {
  const bashCheck = spawnSync("bash", ["--version"], { stdio: "ignore" });
  if (bashCheck.error?.code === "ENOENT") {
    t.skip("bash is not installed");
    return;
  }

  const pkgVersion = readJson("package.json").version;
  const rendererPath = `${root}scripts/render-install-windows.sh`;
  const tpl = readFile("scripts/install-windows.ps1");
  const tplLines = tpl.split(/\r?\n/);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleuron-win-render-"));
  try {
    const exeName = `Fleuron_${pkgVersion}_x64-setup.exe`;
    const exePath = path.join(tmpDir, exeName);
    const payload = Buffer.from("fleuron-windows-installer-contract-fixture\n");
    writeFileSync(exePath, payload);
    const expectedSha = createHash("sha256").update(payload).digest("hex");

    const outPath = path.join(tmpDir, "out", "install-windows.ps1");
    const res = spawnSync("bash", [rendererPath, pkgVersion, exePath, outPath], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `renderer failed: ${res.stderr}`);
    assert.ok(existsSync(outPath), "rendered file must exist");
    assert.ok(!existsSync(`${outPath}.tmp`), "rendered .tmp file must not remain");

    const rendered = readFileSync(outPath, "utf8");
    const renderedLines = rendered.split(/\r?\n/);

    const shaLine = `$FleuronSetupSha256 = '${expectedSha}'`;
    const verLine = `$FleuronVersion = '${pkgVersion}'`;
    assert.equal(
      renderedLines.filter((l) => l === shaLine).length,
      1,
      `expected exactly one "${shaLine}" line`,
    );
    assert.equal(
      renderedLines.filter((l) => l === verLine).length,
      1,
      `expected exactly one "${verLine}" line`,
    );
    assert.ok(!rendered.includes("__FLEURON_"), "rendered script must contain no __FLEURON_ placeholders");
    assert.doesNotMatch(rendered, /[^\x00-\x7f]/, "rendered script must be ASCII only");

    assert.equal(renderedLines.length, tplLines.length, "template and output line counts must match");
    const diffs = [];
    for (let i = 0; i < tplLines.length; i++) {
      if (tplLines[i] !== renderedLines[i]) {
        diffs.push({ i, tpl: tplLines[i], out: renderedLines[i] });
      }
    }
    assert.equal(diffs.length, 2, `expected differences ONLY at the 2 placeholder lines, found ${diffs.length}`);
    assert.deepEqual(
      diffs.map((d) => d.tpl),
      ["$FleuronVersion = '__FLEURON_VERSION__'", "$FleuronSetupSha256 = '__FLEURON_SETUP_SHA256__'"],
    );
    assert.deepEqual(
      diffs.map((d) => d.out),
      [verLine, shaLine],
    );

    // Negative cases
    const runNegative = (label, script, args, negOut) => {
      const r = spawnSync("bash", [script, ...args, negOut], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `${label}: expected non-zero exit`);
      assert.ok(!existsSync(negOut), `${label}: output file must not exist`);
      assert.ok(!existsSync(`${negOut}.tmp`), `${label}: .tmp file must not exist`);
    };

    runNegative(
      "non-semver version 2.11",
      rendererPath,
      ["2.11", exePath],
      path.join(tmpDir, "neg-ver.ps1"),
    );

    const armExe = path.join(tmpDir, `Fleuron_${pkgVersion}_arm64-setup.exe`);
    writeFileSync(armExe, payload);
    runNegative(
      "arm64 setup basename",
      rendererPath,
      [pkgVersion, armExe],
      path.join(tmpDir, "neg-arch.ps1"),
    );

    const missingExe = path.join(tmpDir, "missing", exeName);
    runNegative(
      "missing setup file",
      rendererPath,
      [pkgVersion, missingExe],
      path.join(tmpDir, "neg-missing.ps1"),
    );

    const emptyExe = path.join(tmpDir, "empty-dir", exeName);
    mkdirSync(path.dirname(emptyExe), { recursive: true });
    writeFileSync(emptyExe, "");
    runNegative(
      "empty setup file",
      rendererPath,
      [pkgVersion, emptyExe],
      path.join(tmpDir, "neg-empty.ps1"),
    );

    // Temp copy with duplicated version placeholder line
    const dupScriptsDir = path.join(tmpDir, "dup", "scripts");
    mkdirSync(dupScriptsDir, { recursive: true });
    const dupRenderer = path.join(dupScriptsDir, "render-install-windows.sh");
    copyFileSync(rendererPath, dupRenderer);
    chmodSync(dupRenderer, 0o755);
    writeFileSync(
      path.join(dupScriptsDir, "install-windows.ps1"),
      tpl.replace(
        "$FleuronVersion = '__FLEURON_VERSION__'",
        "$FleuronVersion = '__FLEURON_VERSION__'\n$FleuronVersion = '__FLEURON_VERSION__'",
      ),
    );
    runNegative(
      "duplicated version placeholder in template",
      dupRenderer,
      [pkgVersion, exePath],
      path.join(tmpDir, "neg-dup-tpl.ps1"),
    );

    // Temp copy with removed version placeholder line
    const remScriptsDir = path.join(tmpDir, "rem", "scripts");
    mkdirSync(remScriptsDir, { recursive: true });
    const remRenderer = path.join(remScriptsDir, "render-install-windows.sh");
    copyFileSync(rendererPath, remRenderer);
    chmodSync(remRenderer, 0o755);
    writeFileSync(
      path.join(remScriptsDir, "install-windows.ps1"),
      tpl.replace("$FleuronVersion = '__FLEURON_VERSION__'\n", ""),
    );
    runNegative(
      "removed version placeholder in template",
      remRenderer,
      [pkgVersion, exePath],
      path.join(tmpDir, "neg-rem-tpl.ps1"),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
