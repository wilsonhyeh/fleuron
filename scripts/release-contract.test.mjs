#!/usr/bin/env node
// Release-contract enforcement.
//
// Every shipping decision this project made about trust/provenance/packaging
// is encoded here as an executable assertion plus a negative mutation that is
// OBSERVED FAILING inside its own test — token-presence assertions cannot
// pass dead. Run via `node --test scripts/release-contract.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  verifyWindowsTemplateConfig,
  verifyNoSecurityMutations,
} from "./nsis-template.test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const wf = (name) => `.github/workflows/${name}.yml`;
const readWf = (name) => readFileSync(`${root}${wf(name)}`, "utf8");
const readJson = (p) => JSON.parse(readFileSync(`${root}${p}`, "utf8"));
const readFile = (p) => readFileSync(`${root}${p}`, "utf8");

const RELEASE_VERSION = readJson("package.json").version;
const VERSION_TOKEN = "$" + "{VERSION}";
const CANONICAL_MAC_DMG = "Fleuron_" + RELEASE_VERSION + "_universal.dmg";
const CANONICAL_WIN_EXE = "Fleuron_" + RELEASE_VERSION + "_x64-setup.exe";
// The QA runners are maintainer tools, NOT release assets. They wipe
// %USERPROFILE%\Fleuron / ~/Fleuron -- the default study library -- with no
// confirmation prompt, so a researcher who downloads one from a release page
// loses their coding. Match a release to its runner by checking out the tag
// instead: github.com/wilsonhyeh/fleuron/archive/refs/tags/v<version>.zip
const MAC_QA_RUNNER_TEMPLATE = "Fleuron_" + VERSION_TOKEN + "_macos-qa-runner.zip";
const WIN_QA_RUNNER_TEMPLATE = "Fleuron_" + VERSION_TOKEN + "_windows-qa-runner.zip";
const DISCLOSURE_SNIPPET =
  "so your operating system cannot verify its publisher automatically";

// ----------------------
// Helpers
// ----------------------

/** Frontmatter parsing good enough for trigger/permission keys.
 * GitHub workflow files carry no `---` fences; fall back to the whole doc. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : text;
}

function expectStepPresent(yaml, needle, label) {
  assert.match(
    yaml,
    new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `${label}: expected step matching "${needle}"`,
  );
}

function expectNoContinueOnError(yaml, label) {
  assert.doesNotMatch(yaml, /continue-on-error/, `${label}: must never swallow failures`);
}

function assertQaRunnersNotShipped(yaml) {
  // 1. No runner archive may appear anywhere in the release pipeline.
  for (const asset of [MAC_QA_RUNNER_TEMPLATE, WIN_QA_RUNNER_TEMPLATE, "qa-runner"]) {
    assert.ok(
      !yaml.includes(asset),
      "QA runner must not be a release asset (found " + asset + " in release.yml)",
    );
  }
  // 2. Nor may anything archive one.
  const buildAssets = jobBlock(yaml, "build-draft-assets");
  assert.ok(!buildAssets.includes("zip -qr"), "release must not archive a QA runner");
  assert.ok(!buildAssets.includes("Compress-Archive"), "release must not archive a QA runner");
  // 3. The release notes must not advertise one.
  const finalize = jobBlock(yaml, "finalize-draft");
  assert.ok(
    !/verification runners/i.test(finalize),
    "release notes must not advertise QA runners as downloadable",
  );
  // 4. But the runner sources still ship in-repo and must still be gated,
  //    because Wilson runs them against every candidate.
  assert.ok(buildAssets.includes("qa/Test-Parse.ps1"), "Windows runner must be syntax-checked");
  assert.ok(buildAssets.includes("qa/Invoke-FleuronQA.ps1 -SelfCheck"), "Windows runner must self-check");
  assert.match(yaml, /qa\/macos\/Invoke-FleuronQA\.sh/);
  assert.ok(existsSync(root + "qa/macos/Invoke-FleuronQA.sh"), "macOS QA runner source missing");
  assert.ok(existsSync(root + "qa/macos/README.md"), "macOS QA runner guide missing");
  assert.ok(existsSync(root + "qa/Invoke-FleuronQA.ps1"), "Windows QA runner source missing");

  const macRunner = readFile("qa/macos/Invoke-FleuronQA.sh");
  assert.match(macRunner, /hdiutil verify/);
  assert.match(macRunner, /codesign --verify --deep --strict/);
  assert.match(macRunner, /--selftest/);
  const winRunner = readFile("qa/Invoke-FleuronQA.ps1");
  assert.match(winRunner, /Resolve-ExpectedVersion/);
  assert.match(winRunner, /release\.json/);
}

// ----------------------
// 1. Test workflow — OS matrix
// ----------------------

test("test.yml runs Rust CI on macOS AND Windows", () => {
  const yaml = readWf("test");
  assert.match(yaml, /platform:\s*\[\s*macos-latest,\s*windows-latest\s*\]/);
});

test("test.yml keeps frontend on Ubuntu and Playwright on its existing runner", () => {
  const yaml = readWf("test");
  assert.match(yaml, /runs-on:\s*ubuntu-latest/, "frontend job stays on Ubuntu");
  const e2e = readWf("test-e2e");
  assert.match(e2e, /runs-on:\s*macos-latest/);
});

test("negative mutation: macOS-only Rust matrix fails", () => {
  const mutated = readWf("test").replace(
    /platform:\s*\[\s*macos-latest,\s*windows-latest\s*\]/,
    "platform: [macos-latest]",
  );
  assert.doesNotMatch(mutated, /windows-latest/);
  // The real file must contain windows — this flip proves the assertion sees it.
  assert.throws(() => {
    assert.match(mutated, /windows-latest/, "");
  }, /windows-latest/);
});

// ----------------------
// 2. E2E workflow — live push gate
// ----------------------

test("test-e2e.yml triggers on push to main, pull_request, and dispatch", () => {
  const fm = frontmatter(readWf("test-e2e"));
  assert.match(fm, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(fm, /pull_request:/);
  assert.match(fm, /workflow_dispatch:/);
  assert.match(fm, /paths:\s*\n\s+-\s+"src\/\*\*"/);
});

test("negative mutation: removing the push trigger is detected", () => {
  const fm = frontmatter(readWf("test-e2e")).replace(/push:[\s\S]*?(?=pull_request:)/, "");
  assert.doesNotMatch(fm, /^push:/m);
  assert.throws(() => {
    assert.match(fm, /push:\s*\n\s*branches:\s*\[main\]/);
  });
});

// ----------------------
// 3. candidate.yml — non-public rehearsal
// ----------------------

test("candidate.yml is workflow_dispatch-only with read-only repo access", () => {
  const text = readWf("candidate");
  const fm = frontmatter(text);
  assert.match(fm, /on:\s*\n\s*workflow_dispatch:\s*(\{\}|\n|$)/m);
  assert.doesNotMatch(fm, /\bpull_request\b/);
  assert.match(text, /permissions:\s*\n\s*contents:\s*read/);
});

test("candidate.yml never creates a GitHub Release", () => {
  const yaml = readWf("candidate");
  assert.doesNotMatch(yaml, /tauri-apps\/tauri-action/);
  assert.doesNotMatch(yaml, /gh release create/i);
  assert.doesNotMatch(yaml, /gh release edit/i);
});

test("candidate.yml stamps FLEURON_BUILD_COMMIT from github.sha in both build legs", () => {
  const yaml = readWf("candidate");
  const count = [...yaml.matchAll(/FLEURON_BUILD_COMMIT[^]*?\$\{\{ github\.sha \}\}/g)].length;
  assert.ok(count >= 2, `expected commit stamping in ≥2 places, found ${count}`);
});

test("negative mutation: candidate that publishes via tauri-action fails", () => {
  const yaml = readWf("candidate") + "\n# probe:uses: tauri-apps/tauri-action@v0\n";
  // Assert the DETECTOR fires, not the wording of node's failure message:
  // assert.throws(fn, /re/) matches the regex against err.message, and node
  // truncates a large "Input:" dump, so matching the probe there silently
  // depended on candidate.yml staying under the truncation limit.
  assert.match(yaml, /tauri-apps\/tauri-action/);
  assert.throws(
    () => assert.doesNotMatch(yaml, /tauri-apps\/tauri-action/),
    (err) => err instanceof assert.AssertionError,
  );
  // And the real workflow must still be clean.
  assert.doesNotMatch(readWf("candidate"), /tauri-apps\/tauri-action/);
});

// ----------------------
// 4. Selftest wiring (real packaged app) — candidate AND release, fail-closed
// ----------------------

const SELFTEST_CALL_RE = /run-selftest/;

/** Slice a single top-level job body out of a workflow document. */
function jobBlock(yaml, jobName) {
  const startRe = new RegExp(`^  ${jobName}:\\s*$`, "m");
  const m = startRe.exec(yaml);
  assert.ok(m, `workflow is missing job '${jobName}'`);
  const rest = yaml.slice(m.index + m[0].length);
  const end = rest.search(/^  [a-zA-Z_-]+:\s*(#|$)/m);
  return end === -1 ? rest : rest.slice(0, end);
}

test("candidate.yml runs the real-app selftest in EVERY platform job, fail-closed", () => {
  const yaml = readWf("candidate");
  expectNoContinueOnError(yaml, "candidate.yml");
  for (const job of ["build-macos", "build-windows"]) {
    assert.match(
      jobBlock(yaml, job),
      SELFTEST_CALL_RE,
      `${job} must launch the packaged app with --selftest`,
    );
    assert.match(
      jobBlock(yaml, job),
      /universal-apple-darwin|x86_64-pc-windows-msvc/,
      `${job} targets the canonical platform`,
    );
  }
});

test("release.yml runs the selftest in EVERY platform build leg, blocking the draft", () => {
  const yaml = readWf("release");
  expectNoContinueOnError(yaml, "release.yml");
  const legBlock = jobBlock(yaml, "build-draft-assets");
  // The matrix build uploads artifacts only after the selftest passes.
  const selftestIdx = legBlock.search(SELFTEST_CALL_RE);
  const uploadIdx = legBlock.indexOf("actions/upload-artifact");
  assert.ok(selftestIdx !== -1, "release build leg must contain a selftest step");
  assert.ok(uploadIdx > selftestIdx, "selftest must precede any artifact upload");
  assert.ok(legBlock.includes("universal-apple-darwin") && legBlock.includes("x86_64-pc-windows-msvc"));
});

// Release workflow: build legs, finalize, provenance ordering.
test("release.yml orders selftest → artifacts → finalize → provenance", () => {
  const yaml = readWf("release");
  const needs = ["build-draft-assets", "finalize-draft"];
  for (const n of needs) assert.ok(new RegExp(`^  ${n}:`, "m").test(yaml), `missing job ${n}`);
  const provBlock = jobBlock(yaml, "provenance");
  assert.match(provBlock, /needs:\s*\n\s+-\s+finalize-draft/);
});

test("negative mutation: deleting the candidate selftest step fails", () => {
  const yaml = readWf("candidate")
    .split("\n")
    .filter((l) => !l.includes("run-selftest"))
    .join("\n");
  assert.throws(() => {
    assert.match(
      jobBlock(yaml, "build-macos"),
      SELFTEST_CALL_RE,
      "selftest missing",
    );
  }, /selftest/);
});

test("negative mutation: neutering the selftest with continue-on-error fails", () => {
  const yaml = readWf("candidate").replace(
    /(- name:[^\n]*[Ss]elftest[^\n]*)/,
    "$1\n        continue-on-error: true",
  );
  assert.throws(() => expectNoContinueOnError(yaml, "neutered"), /must never swallow/);
});

// ----------------------
// 5. release.yml — draft-only provenance release
// ----------------------

test("release.yml stays tag-triggered and creates ONLY a draft", () => {
  const text = readWf("release");
  const fm = frontmatter(text);
  assert.match(fm, /tags:\s*\n\s+-\s+"v\*"/);
  assert.match(text, /releaseDraft: true|--draft\b/i);
  assert.doesNotMatch(text, /releaseDraft: false/);
  assert.doesNotMatch(text, /--draft=false/);
  assert.doesNotMatch(text, /gh release edit .*--draft=false/);
});

test("release.yml provenance job holds the right scopes and pins actions/attest@v4", () => {
  const yaml = readWf("release");
  const provIdx = yaml.indexOf("provenance:");
  assert.ok(provIdx !== -1, "provenance job missing");
  const provSection = yaml.slice(provIdx);
  assert.match(provSection.slice(0, 400), /permissions:/);
  for (const scope of ["contents: write", "id-token: write", "attestations: write"]) {
    assert.ok(provSection.includes(scope), `provenance must declare ${scope}`);
  }
  assert.match(yaml, /actions\/attest@v4/);
});

test("release.yml enforces the exact eight-asset inventory before any further step", () => {
  const yaml = readWf("release");
  for (const asset of [
    "Fleuron_" + VERSION_TOKEN + "_universal.dmg",
    "Fleuron_" + VERSION_TOKEN + "_x64-setup.exe",
    "Fleuron_" + VERSION_TOKEN + "_x64-setup.exe.sig",
    "Fleuron_universal.app.tar.gz",
    "Fleuron_universal.app.tar.gz.sig",
    "latest.json",
    "install-mac.sh",
    "install-windows.ps1",
  ]) {
    assert.ok(yaml.includes(asset), "inventory must reference " + asset);
  }
});

function assertInstallMacWiring(yaml) {
  const finalize = jobBlock(yaml, "finalize-draft");
  assert.ok(
    finalize.includes("scripts/render-install-mac.sh"),
    "finalize-draft must call scripts/render-install-mac.sh",
  );
  assert.ok(
    finalize.includes('"assets/install-mac.sh" \\'),
    'finalize-draft must upload "assets/install-mac.sh" \\',
  );
  const renderIdx = finalize.indexOf("scripts/render-install-mac.sh");
  const uploadIdx = finalize.indexOf("gh release upload");
  assert.ok(uploadIdx !== -1 && renderIdx < uploadIdx, "render must precede gh release upload");

  const prov = jobBlock(yaml, "provenance");
  const expectedLine = prov.match(/^.*EXPECTED=.*$/m)?.[0] ?? "";
  assert.ok(
    expectedLine.includes("install-mac.sh"),
    "provenance EXPECTED= line must include install-mac.sh",
  );
  assert.ok(
    prov.includes('FLEURON_DMG_SHA256=\\"${WANT}\\"'),
    "provenance must validate the FLEURON_DMG_SHA256 pin",
  );
  const shaIdx = prov.indexOf("Generate sorted SHA256SUMS.txt");
  assert.ok(shaIdx !== -1, "provenance must include Generate sorted SHA256SUMS.txt step");
  const shaRest = prov.slice(shaIdx);
  const nextStep = shaRest.search(/^\s+- name:/m);
  const shaBlock = nextStep === -1 ? shaRest : shaRest.slice(0, nextStep);
  assert.ok(
    shaBlock.includes("install-mac.sh"),
    "SHA256SUMS step must include install-mac.sh",
  );
}

test("release.yml renders, uploads, pins and checksums install-mac.sh", () => {
  const yaml = readWf("release");
  assertInstallMacWiring(yaml);
  const mutated = yaml.replace(/(EXPECTED="[^"\n]*) install-mac\.sh"/, '$1"');
  assert.notEqual(mutated, yaml, "negative mutation must modify EXPECTED=");
  assert.throws(() => assertInstallMacWiring(mutated), /EXPECTED=/);
});

function assertInstallWindowsWiring(yaml) {
  const finalize = jobBlock(yaml, "finalize-draft");
  assert.ok(
    finalize.includes("scripts/render-install-windows.sh"),
    "finalize-draft must call scripts/render-install-windows.sh",
  );
  assert.ok(
    finalize.includes('"assets/install-windows.ps1" \\'),
    'finalize-draft must upload "assets/install-windows.ps1" \\',
  );
  const renderIdx = finalize.indexOf("scripts/render-install-windows.sh");
  const uploadIdx = finalize.indexOf("gh release upload");
  assert.ok(uploadIdx !== -1 && renderIdx < uploadIdx, "render must precede gh release upload");
  assert.ok(
    finalize.includes("command -v pwsh"),
    "finalize-draft must check command -v pwsh before parse-checking install-windows.ps1",
  );
  assert.ok(
    finalize.includes("[System.Management.Automation.Language.Parser]::ParseFile"),
    "finalize-draft must parse-check install-windows.ps1 with Parser::ParseFile",
  );
  assert.ok(
    finalize.includes("FleuronSetupSha256 = '${WANT}'"),
    "finalize-draft must validate the FleuronSetupSha256 pin",
  );

  const prov = jobBlock(yaml, "provenance");
  const expectedLine = prov.match(/^.*EXPECTED=.*$/m)?.[0] ?? "";
  assert.ok(
    expectedLine.includes("install-windows.ps1"),
    "provenance EXPECTED= line must include install-windows.ps1",
  );
  assert.ok(
    prov.includes("command -v pwsh"),
    "provenance must check command -v pwsh before parse-checking install-windows.ps1",
  );
  assert.ok(
    prov.includes("FleuronSetupSha256 = '${WANT}'"),
    "provenance must validate the FleuronSetupSha256 pin",
  );
  assert.ok(
    prov.includes("[System.Management.Automation.Language.Parser]::ParseFile"),
    "provenance must parse-check install-windows.ps1 with Parser::ParseFile",
  );
  const shaIdx = prov.indexOf("Generate sorted SHA256SUMS.txt");
  assert.ok(shaIdx !== -1, "provenance must include Generate sorted SHA256SUMS.txt step");
  const shaRest = prov.slice(shaIdx);
  const nextStep = shaRest.search(/^\s+- name:/m);
  const shaBlock = nextStep === -1 ? shaRest : shaRest.slice(0, nextStep);
  assert.ok(
    shaBlock.includes("install-windows.ps1"),
    "SHA256SUMS step must include install-windows.ps1",
  );
}

test("release.yml renders, parse-checks, uploads, pins and checksums install-windows.ps1", () => {
  const yaml = readWf("release");
  assertInstallWindowsWiring(yaml);
  const mutatedExpected = yaml.replace(/(EXPECTED="[^"\n]*) install-windows\.ps1/, "$1");
  assert.notEqual(mutatedExpected, yaml, "negative mutation must modify EXPECTED=");
  assert.throws(() => assertInstallWindowsWiring(mutatedExpected), /EXPECTED=/);

  const mutatedPwsh = yaml.replace(/command -v pwsh/g, "true");
  assert.notEqual(mutatedPwsh, yaml, "negative mutation must replace command -v pwsh");
  assert.throws(() => assertInstallWindowsWiring(mutatedPwsh), /pwsh/);
});

function assertWindowsInstallerCiWiring(testYaml, releaseYaml) {
  assert.ok(
    testYaml.includes("scripts/install-windows.test.ps1"),
    "test.yml must run scripts/install-windows.test.ps1",
  );
  assert.ok(
    testYaml.includes("scripts/install-windows-contract.test.mjs"),
    "test.yml must run scripts/install-windows-contract.test.mjs",
  );
  assert.ok(
    testYaml.includes("runner.os == 'Windows'"),
    "test.yml must gate Windows runtime tests with runner.os == 'Windows'",
  );
  const validateBlock = jobBlock(releaseYaml, "validate");
  assert.ok(
    validateBlock.includes("scripts/install-windows-contract.test.mjs"),
    "release.yml validate job must run scripts/install-windows-contract.test.mjs",
  );
  const buildBlock = jobBlock(releaseYaml, "build-draft-assets");
  assert.ok(
    buildBlock.includes("scripts/install-windows.test.ps1"),
    "release.yml build-draft-assets job must run scripts/install-windows.test.ps1",
  );
}

test("CI runs the Windows installer suite and its static contract", () => {
  const testYaml = readWf("test");
  const releaseYaml = readWf("release");
  assertWindowsInstallerCiWiring(testYaml, releaseYaml);

  const mutated = testYaml.replaceAll("scripts/install-windows.test.ps1", "scripts/removed.ps1");
  assert.notEqual(mutated, testYaml, "negative mutation must remove scripts/install-windows.test.ps1");
  assert.throws(
    () => assertWindowsInstallerCiWiring(mutated, releaseYaml),
    /install-windows\.test\.ps1/,
  );
});

test("release.yml keeps the QA runners out of the published assets", () => {
  assertQaRunnersNotShipped(readWf("release"));
});

test("release.yml and candidate.yml keep support/ probe tools out of published release assets", () => {
  const rel = readWf("release");
  const cand = readWf("candidate");
  assert.ok(!/support\//.test(rel), "release.yml must not upload support/ as an asset");
  assert.ok(!/support\//.test(cand), "candidate.yml must not upload support/ as an asset");
  assert.ok(existsSync(`${root}support/fleuron-probe.sh`), "support/fleuron-probe.sh must exist in repo");
  assert.ok(existsSync(`${root}support/Get-FleuronProbe.ps1`), "support/Get-FleuronProbe.ps1 must exist in repo");
});

test("negative mutation: re-adding a QA runner asset fails", () => {
  const mutated = readWf("release").replace(
    '"$(echo assets/*.app.tar.gz.sig)" \\',
    '"$(echo assets/*.app.tar.gz.sig)" \\\n            "assets/' + MAC_QA_RUNNER_TEMPLATE + '" \\',
  );
  assert.ok(mutated.includes(MAC_QA_RUNNER_TEMPLATE), "mutation must actually land");
  assert.throws(() => assertQaRunnersNotShipped(mutated), /must not be a release asset/);
});

test("release.yml validates latest.json version/platform/urls/signatures", () => {
  const yaml = readWf("release");
  expectStepPresent(yaml, "Validate latest.json", "latest.json gate");
  assert.match(yaml, /releases\/download\/v\$\{|latest\.json.*version|version == "/);
});

test("release.yml supplies FLEURON_BUILD_COMMIT to both legs", () => {
  const yaml = readWf("release");
  const count = [...yaml.matchAll(/FLEURON_BUILD_COMMIT[^]*?\$\{\{ github\.sha \}\}/g)].length;
  assert.ok(count >= 2, `expected commit stamping in ≥2 places, found ${count}`);
});

test("negative mutation: releaseDraft:false fails the draft-only assertion", () => {
  const flipped = readWf("release").replace("releaseDraft: true", "releaseDraft: false");
  assert.throws(() => {
    assert.doesNotMatch(flipped, /releaseDraft: false/);
  });
});

test("negative mutation: missing attestation permission fails", () => {
  const stripped = readWf("release").replace(/attestations: write/, "attestations: none");
  assert.throws(() => {
    assert.ok(stripped.includes("attestations: write"));
  }, /attestations: write/);
});

// ----------------------
// 6. Packaging contracts wired in
// ----------------------

test("mac packaging contract: ad-hoc identity, bound plist, minimum 10.15", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const mac = conf.bundle?.macOS ?? {};
  assert.equal(mac.signingIdentity, "-");
  assert.ok(mac.infoPlist, "bundle.macOS.infoPlist must point at src-tauri/Info.plist");
  assert.equal(mac.minimumSystemVersion, "10.15");
  assert.ok(existsSync(`${root}src-tauri/Info.plist`));
});

test("negative mutation: mac signingIdentity removed fails", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  delete conf.bundle.macOS.signingIdentity;
  assert.throws(() => {
    assert.equal(conf.bundle?.macOS?.signingIdentity, "-");
  });
});

test("windows packaging contract: NSIS/currentUser/skip/no-mutations", () => {
  const winConf = readJson("src-tauri/tauri.windows.conf.json");
  verifyWindowsTemplateConfig(winConf);
  const hooks = readFile("src-tauri/nsis-hooks.nsh");
  const nsi = readFile("src-tauri/installer.nsi");
  verifyNoSecurityMutations(nsi, hooks);
});

test("negative mutation: WindowscurrentUser→perMachine and WebView bootstrapper fail", () => {
  const winConf = readJson("src-tauri/tauri.windows.conf.json");
  const m1 = structuredClone(winConf);
  m1.bundle.windows.nsis.installMode = "perMachine";
  assert.throws(() => verifyWindowsTemplateConfig(m1), /currentUser/);
  const m2 = structuredClone(winConf);
  m2.bundle.windows.webviewInstallMode.type = "downloadBootstrapper";
  assert.throws(() => verifyWindowsTemplateConfig(m2), /'skip'/);
});

test("updater channel is retained verbatim", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const updater = conf.plugins?.updater;
  assert.ok(updater?.pubkey, "updater pubkey missing");
  assert.deepEqual(updater.endpoints, [
    "https://github.com/wilsonhyeh/fleuron/releases/latest/download/latest.json",
  ]);
});

test("canonical support matrix + filenames appear in candidate summary/report", () => {
  const yaml = readWf("candidate");
  assert.ok(
    yaml.includes(CANONICAL_MAC_DMG) ||
      yaml.includes("Fleuron_" + VERSION_TOKEN + "_universal.dmg"),
  );
  assert.ok(
    yaml.includes(CANONICAL_WIN_EXE) ||
      yaml.includes("Fleuron_" + "$" + "{version}_x64-setup.exe"),
  );
});

test("current install materials name assets by the version placeholder", () => {
  const surfaces = [
    "docs/INSTALLING.md",
    "README.md",
    "docs/IT-DEPLOYMENT.md",
    "src/content/trust-and-permissions.ts",
  ];
  for (const p of surfaces) {
    const text = readFile(p);
    assert.ok(
      text.includes("Fleuron_<version>_universal.dmg") ||
        text.includes("Fleuron_<version>_x64-setup.exe"),
      `${p} must name the manual downloads with the <version> placeholder`,
    );
    assert.doesNotMatch(
      text,
      /Fleuron_\d+\.\d+\.\d+_/,
      `${p} must not hard-code a release version in an asset name`,
    );
  }
  // Install materials must never point a user at a QA runner: running one
  // wipes the default study library without asking.
  assert.ok(
    !/qa-runner/.test(readFile("docs/INSTALLING.md")),
    "INSTALLING.md must not advertise a QA runner",
  );
  assert.ok(!/qa-runner/.test(readFile("README.md")), "README.md must not advertise a QA runner");
});

// ----------------------
// 7. Required trust documents + forms
// ----------------------

test("required install/privacy/support/security/IT docs and issue forms exist", () => {
  const required = [
    "docs/INSTALLING.md",
    "docs/PRIVACY-AND-PERMISSIONS.md",
    "docs/IT-DEPLOYMENT.md",
    "SUPPORT.md",
    "SECURITY.md",
    ".github/ISSUE_TEMPLATE/install-help.yml",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ];
  for (const p of required) {
    assert.ok(existsSync(`${root}${p}`), `missing required file: ${p}`);
  }
});

test("canonical publisher disclosure is carried verbatim by INSTALLING + README", () => {
  for (const p of ["docs/INSTALLING.md", "README.md"]) {
    const text = readFile(p);
    assert.ok(text.includes(DISCLOSURE_SNIPPET), `${p} lost the canonical notice`);
    assert.ok(
      text.includes("https://github.com/wilsonhyeh/fleuron/releases"),
      `${p} must name the official releases URL`,
    );
  }
});

test("negative mutation: dropping the disclosure from INSTALLING fails", () => {
  const text = readFile("docs/INSTALLING.md").replace(DISCLOSURE_SNIPPET, "[removed]");
  assert.throws(() => {
    assert.ok(text.includes(DISCLOSURE_SNIPPET), "lost the canonical notice");
  }, /canonical notice/);
});

test("install-help issue form collects warning-category + exact filename and bans sensitive data", () => {
  const form = readFile(".github/ISSUE_TEMPLATE/install-help.yml");
  assert.match(form, /Do not upload transcripts/);
  assert.match(form, /Exact warning text/);
  assert.match(form, /exact filename/);
});

test("security policy routes confidential reports through GitHub private reporting", () => {
  const sec = readFile("SECURITY.md");
  assert.match(sec, /Report a vulnerability/);
  assert.doesNotMatch(sec, /mailto:/);
});

test("four workflow YAML files parse (authoritative Ruby loader; structural fallback)", () => {
  for (const name of ["test", "test-e2e", "candidate", "release"]) {
    const file = `${root}${wf(name)}`;
    const text = readFile(wf(name));
    assert.doesNotMatch(text, /^\t/m, `${name}: tabs are illegal YAML indentation`);
    try {
      execFileSync(
        "ruby",
        [
          "-e",
          'require "yaml"; YAML.load_file(ARGV.fetch(0)); warn "#{$PROGRAM_NAME}: YAML OK"',
          file,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      assert.ok(true, `${name} parsed by Ruby`);
    } catch (err) {
      if (err?.code === "ENOENT") {
        // Ruby unavailable locally: structural fallback only.
        assert.match(text, /^jobs:/m, `${name}: no jobs section`);
        continue;
      }
      throw err;
    }
  }
});

// ----------------------
// 8. Terminal installer contract (scripts/install-mac.sh & docs)
// ----------------------

function verifyInstallerTemplate(text) {
  assert.match(
    text,
    /^FLEURON_VERSION="__FLEURON_VERSION__"$/m,
    'missing exact FLEURON_VERSION="__FLEURON_VERSION__" line',
  );
  assert.match(
    text,
    /^FLEURON_DMG_SHA256="__FLEURON_DMG_SHA256__"$/m,
    'missing exact FLEURON_DMG_SHA256="__FLEURON_DMG_SHA256__" line',
  );
  assert.ok(text.includes("--proto '=https'"), "must include --proto '=https'");
  assert.ok(
    text.includes("--proto-redir '=https'"),
    "must include --proto-redir '=https' so a redirect can never downgrade to plain http",
  );
  assert.ok(text.includes("--fail"), "must include --fail");
  assert.ok(text.includes("--tlsv1.2"), "must include --tlsv1.2");
  assert.ok(
    text.includes("hdiutil attach -readonly -nobrowse"),
    "must attach DMG with -readonly -nobrowse",
  );
  // Order matters for the negative mutation below: the "never fetch latest"
  // detector runs FIRST so a template that points at releases/latest fails with
  // this exact reason, instead of tripping the tag-pinned include check with a
  // less precise message.
  assert.doesNotMatch(text, /releases\/latest/, "template must never fetch releases/latest");
  assert.ok(
    text.includes("/releases/download/v${FLEURON_VERSION}"),
    "must download from /releases/download/v${FLEURON_VERSION}",
  );
  assert.doesNotMatch(
    text,
    /^\s*[^#\n]*\bsudo\s+(?!or\b)[a-z\/]/m,
    "installer must never invoke sudo",
  );
  assert.doesNotMatch(
    text,
    /\bxattr\b|\bspctl\b|\bcsrutil\b|--noqtn|-noverify|\|\s*(ba)?sh\b/,
    "installer must never run xattr/spctl/csrutil/--noqtn/-noverify or pipe to sh",
  );
  assert.ok(text.includes("# PATH-RESET"), "must include # PATH-RESET marker");
  assert.ok(text.includes("# CHECKSUM-GATE"), "must include # CHECKSUM-GATE marker");
  const nonEmpty = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  assert.equal(nonEmpty[nonEmpty.length - 1], 'main "$@"', 'last non-empty line must be main "$@"');
}

function assertNoTerminalPromise(text, label) {
  assert.doesNotMatch(
    text,
    /No Terminal steps|never requires Terminal/i,
    `${label}: must drop the no-Terminal promise`,
  );
}

test("scripts/install-mac.sh satisfies the terminal installer security contract", () => {
  assert.ok(existsSync(`${root}scripts/render-install-mac.sh`), "missing scripts/render-install-mac.sh");
  assert.ok(existsSync(`${root}scripts/install-mac.test.sh`), "missing scripts/install-mac.test.sh");

  const tpl = readFile("scripts/install-mac.sh");
  verifyInstallerTemplate(tpl);

  assert.throws(() => verifyInstallerTemplate(tpl + "\nsudo ditto a b\n"), /sudo/);

  const noRedir = tpl.replace(/--proto-redir '=https' /g, "");
  assert.notEqual(noRedir, tpl, "--proto-redir mutation must land");
  assert.throws(() => verifyInstallerTemplate(noRedir), /--proto-redir/);

  const latestMut = tpl.replace(/\/releases\/download\/v\$\{FLEURON_VERSION\}/g, "/releases/latest/download");
  assert.notEqual(latestMut, tpl, "releases/latest mutation must land");
  assert.throws(() => verifyInstallerTemplate(latestMut), /releases\/latest/);

  assert.throws(
    () => verifyInstallerTemplate(tpl + "\nxattr -d com.apple.quarantine x\n"),
    /xattr/,
  );
});

test("install guide documents the Terminal installer and drops the no-Terminal promise", () => {
  assert.ok(
    existsSync(`${root}docs/maintainers/TERMINAL-INSTALL.md`),
    "missing docs/maintainers/TERMINAL-INSTALL.md",
  );
  const installing = readFile("docs/INSTALLING.md");
  assert.ok(
    installing.includes("https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh"),
    "INSTALLING.md must document the stable install-mac.sh URL",
  );
  assert.ok(
    installing.includes("/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL"),
    "INSTALLING.md must document the pinned curl invocation, including --proto-redir '=https'",
  );
  assert.ok(
    installing.includes("/bin/bash ~/fleuron-install-mac.sh"),
    "INSTALLING.md must document running /bin/bash ~/fleuron-install-mac.sh",
  );

  for (const [label, p] of [
    ["README.md", "README.md"],
    ["docs/INSTALLING.md", "docs/INSTALLING.md"],
    ["src/content/trust-and-permissions.ts", "src/content/trust-and-permissions.ts"],
  ]) {
    assertNoTerminalPromise(readFile(p), label);
  }

  assert.throws(
    () =>
      assertNoTerminalPromise(
        installing + "\nNormal installation never requires Terminal or checksums.\n",
        "mutated INSTALLING.md",
      ),
    /no-Terminal promise/,
  );
});

function assertWindowsInstallDocs(installing, readme, trust, termDoc) {
  assert.ok(
    installing.includes("https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-windows.ps1"),
    "INSTALLING.md must document the stable install-windows.ps1 URL",
  );
  assert.ok(
    installing.includes("& \"$env:SystemRoot\\System32\\curl.exe\" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL"),
    "INSTALLING.md must document the pinned System32 curl.exe invocation",
  );
  assert.ok(
    installing.includes("-NoProfile -ExecutionPolicy RemoteSigned -File \"$env:USERPROFILE\\fleuron-install-windows.ps1\""),
    "INSTALLING.md must document running PowerShell with -ExecutionPolicy RemoteSigned",
  );
  for (const [label, text] of [
    ["README.md", readme],
    ["docs/INSTALLING.md", installing],
    ["src/content/trust-and-permissions.ts", trust],
  ]) {
    assert.doesNotMatch(
      text,
      /-ExecutionPolicy\s+Bypass/i,
      `${label}: must never suggest -ExecutionPolicy Bypass`,
    );
  }
  assert.ok(
    termDoc.includes("## 13. Windows PowerShell installer"),
    "TERMINAL-INSTALL.md must include section ## 13. Windows PowerShell installer",
  );
  assert.ok(
    termDoc.includes("unverified on Windows"),
    "TERMINAL-INSTALL.md must document unverified on Windows status",
  );
  assert.ok(
    termDoc.includes("https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies"),
    "TERMINAL-INSTALL.md must link to about_execution_policies",
  );
}

test("install guide documents the PowerShell installer", () => {
  const installing = readFile("docs/INSTALLING.md");
  const readme = readFile("README.md");
  const trust = readFile("src/content/trust-and-permissions.ts");
  const termDoc = readFile("docs/maintainers/TERMINAL-INSTALL.md");
  assertWindowsInstallDocs(installing, readme, trust, termDoc);

  const curlLine = "& \"$env:SystemRoot\\System32\\curl.exe\" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL";
  const mutated = installing.replace(curlLine, "");
  assert.notEqual(mutated, installing, "negative mutation must remove the curl.exe line");
  assert.throws(
    () => assertWindowsInstallDocs(mutated, readme, trust, termDoc),
    /curl\.exe/,
  );
});
