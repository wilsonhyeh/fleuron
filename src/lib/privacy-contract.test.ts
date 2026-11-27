/**
 * Static contract test: the trust/privacy disclosure cannot drift from what
 * the code actually does.
 *
 * Three couplings enforced here (all fail loudly if either side changes):
 *   1. Every field Sync Protocol 2 allowlists in src-tauri/src/sync_v2.rs
 *      must be disclosed in src/content/trust-and-permissions.ts, and every
 *      local-only claim there must still be forbidden on the wire.
 *   2. Tauri capabilities must not silently grow; a new permission has to be
 *      added to KNOWN_ALLOWED_PERMISSIONS deliberately or the test fails.
 *   3. No public/in-app text may teach bypassing OS security or claim
 *      compliance certification.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(SRC, "..");
const SYNC_V2_RS = resolve(REPO_ROOT, "src-tauri/src/sync_v2.rs");
const CAPABILITIES = resolve(REPO_ROOT, "src-tauri/capabilities/default.json");
const TRUST = resolve(SRC, "content/trust-and-permissions.ts");

const SYNC_V2 = () => readFileSync(SYNC_V2_RS, "utf8");
const TRUST_TS = () => readFileSync(TRUST, "utf8");

/** Literals that appear inside object_has_only blocks but are not wire fields. */
const NON_FIELD_LITERALS = new Set([
  "patch", // envelope key carrying patch objects
  "keep_current",
  "accept_proposal",
  "custom", // conflict.resolve enum values
]);

interface OpFields {
  [op: string]: string[];
}

function extractForbidden(): string[] {
  const m = SYNC_V2().match(/let forbidden = \[([\s\S]*?)\];/);
  if (!m) throw new Error("forbidden list not found in sync_v2.rs");
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
}

function extractAllowlist(): OpFields {
  const src = SYNC_V2();
  const begin = src.indexOf("let valid = match op_kind {");
  if (begin < 0) throw new Error("validate_payload match block not found");
  // Top-level arms are indented exactly eight spaces inside validate_payload.
  const armRe = /\n        "([a-z]+\.[a-z_]+)" =>/g;
  const marks: { op: string; at: number }[] = [];
  for (const m of src.matchAll(armRe)) {
    if (m.index !== undefined && m.index > begin) {
      marks.push({ op: m[1], at: m.index });
    }
  }
  const result: OpFields = {};
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.indexOf("\n    }", mark.at);
    const chunk = src.slice(mark.at, end);
    const fields = [...chunk.matchAll(/"([a-z0-9_]+)"/g)]
      .map((f) => f[1])
      .filter((f) => !NON_FIELD_LITERALS.has(f));
    result[mark.op] = [...new Set(fields)];
  });
  return result;
}

describe("Protocol 2 wire allowlist is fully disclosed", () => {
  it("discloses every allowlisted sync field in the trust content source", () => {
    const allowlist = extractAllowlist();
    const ops = Object.keys(allowlist);
    expect(ops.length).toBeGreaterThanOrEqual(5);
    expect(ops).toEqual(
      expect.arrayContaining(["code.create", "code.patch", "interview.patch", "coding.patch"]),
    );
    const disclosure = TRUST_TS();
    const undisclosed: string[] = [];
    for (const [op, fields] of Object.entries(allowlist)) {
      for (const field of fields) {
        if (!disclosure.includes(`"${field}"`)) undisclosed.push(`${op}:${field}`);
      }
    }
    expect(undisclosed, `fields missing from DATA_BOUNDARY disclosure: ${undisclosed.join(", ")}`).toEqual([]);
  });

  it("maps codebook criteria/examples under the Codebook boundary row tokens", () => {
    const disclosure = TRUST_TS();
    const codebookChunk = disclosure.slice(disclosure.indexOf('"Codebook"'), disclosure.indexOf('"Coding"'));
    for (const f of ["definition", "inclusion_criteria", "exclusion_criteria", "example"]) {
      expect(codebookChunk, `"${f}" must be listed as a synced Codebook token`).toContain(`"${f}"`);
    }
  });

  it("keeps local-only claims out of the wire — forbidden list still forbids them", () => {
    const forbidden = extractForbidden();
    expect(forbidden).toEqual(expect.arrayContaining(["memo", "transcript", "filename"]));
    const allowlisted = new Set(Object.values(extractAllowlist()).flat());
    const leaked = forbidden.filter((f) => allowlisted.has(f));
    expect(leaked, `forbidden fields re-allowlisted: ${leaked.join(", ")}`).toEqual([]);
  });

  it("publishes the canonical publisher-verification notice verbatim", () => {
    const disclosure = TRUST_TS();
    expect(disclosure).toContain(
      "so your operating system cannot verify its publisher automatically",
    );
    expect(disclosure).toContain("Download only from the official release page at https://github.com/wilsonhyeh/fleuron/releases");
    expect(disclosure).toContain("A malware warning, checksum mismatch, or unexpected administrator request means stop.");
  });
});

describe("Tauri capabilities stay minimal and truthful", () => {
  /** Deliberate additions require editing this set AND Trust Center copy. */
  const KNOWN_ALLOWED_PERMISSIONS = [
    "core:default",
    "opener:default",
    "dialog:default",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
  ];

  it("grants no capability beyond the known deliberate set", () => {
    const caps = JSON.parse(readFileSync(CAPABILITIES, "utf8")) as {
      permissions: string[];
    };
    const extra = caps.permissions.filter((p) => !KNOWN_ALLOWED_PERMISSIONS.includes(p));
    expect(extra, `unexpected new permissions: ${extra.join(", ")}`).toEqual([]);
  });

  it("capability config never names a hardware/sensor permission", () => {
    const capsText = readFileSync(CAPABILITIES, "utf8").toLowerCase();
    for (const sensor of ["camera", "microphone", "screen-recording", "accessibility", "geolocation", "bluetooth", "notifications"]) {
      expect(capsText).not.toContain(sensor);
    }
  });
});

describe("prohibited guidance never appears in user-facing text", () => {
  /**
   * Fails if any scanned file teaches defeating an OS security control,
   * claims compliance certification, uses "opaque IDs" framing, or suggests
   * adding firewall exceptions. Negations ("do not disable…") are fine.
   */
  function* markdownAndContentFiles(): Generator<{ file: string; text: string }> {
    const readme = resolve(REPO_ROOT, "README.md");
    yield { file: "README.md", text: readFileSync(readme, "utf8") };
    try {
      for (const name of readdirSync(resolve(REPO_ROOT, "docs"))) {
        if (!name.endsWith(".md")) continue;
        yield {
          file: `docs/${name}`,
          text: readFileSync(resolve(REPO_ROOT, "docs", name), "utf8"),
        };
      }
    } catch {
      /* docs dir contents grow during v1.2; absence is not a violation */
    }
    // The maintainer doc is the one place that names inspection commands, and
    // the installer's messages are user-facing, so both must be inside the ban.
    for (const name of readdirSync(resolve(REPO_ROOT, "docs/maintainers"))) {
      if (!name.endsWith(".md")) continue;
      yield {
        file: `docs/maintainers/${name}`,
        text: readFileSync(resolve(REPO_ROOT, "docs/maintainers", name), "utf8"),
      };
    }
    yield {
      file: "scripts/install-mac.sh",
      text: readFileSync(resolve(REPO_ROOT, "scripts/install-mac.sh"), "utf8"),
    };
    yield {
      file: "scripts/install-windows.ps1",
      text: readFileSync(resolve(REPO_ROOT, "scripts/install-windows.ps1"), "utf8"),
    };
    for (const name of readdirSync(resolve(SRC, "content"))) {
      if (!name.endsWith(".ts")) continue;
      yield {
        file: `src/content/${name}`,
        text: readFileSync(resolve(SRC, "content", name), "utf8"),
      };
    }
  }

  function sentences(text: string): string[] {
    return text.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  }

  // Amended for the Terminal install path (docs/maintainers/TERMINAL-INSTALL.md).
  // The Mac verification checklist must INSPECT extended attributes, so exactly
  // two read-only forms are allowed: `xattr -l <path>` and `xattr -p <name> <path>`.
  // Prose mentions, -d/-c/-w/-r, combined or extra flags all still fail: we
  // never teach mutating or clearing com.apple.quarantine, and the installer
  // never needs to (curl writes no quarantine attribute).
  function xattrMisuse(s: string): boolean {
    for (const m of s.matchAll(/\bxattr\b([^`;|&)]*)/g)) {
      const flags = m[1].match(/(?:^|\s)-\S+/g)?.map((f) => f.trim()) ?? [];
      if (flags.length !== 1 || (flags[0] !== "-l" && flags[0] !== "-p")) return true;
    }
    return false;
  }

  // Amended for the Windows PowerShell install path (scripts/install-windows.ps1
  // and docs/maintainers/TERMINAL-INSTALL.md). Read-only stream inspection
  // (`Get-Item ... -Stream Zone.Identifier`) and `-ExecutionPolicy RemoteSigned`
  // are allowed; unblocking files, changing execution policy, Defender/mitigation
  // mutations, and pipe-to-iex are banned unless explicitly negated in prose.
  const WIN_NEGATION =
    /\b(never|not|no|do not|don't|does not|doesn't|will not|won't|rejected|refuses|banned)\b/i;
  const WIN_ALWAYS: RegExp[] = [
    /\bUnblock-File\s+(-|["'$.~\\/]|[A-Za-z]:)/i,
    /-ExecutionPolicy\s+(Bypass|Unrestricted)\s+-(File|Command)\b/i,
    /\bSet-ExecutionPolicy\s+(-|Bypass\b|Unrestricted\b|RemoteSigned\b|AllSigned\b|Undefined\b)/i,
    /\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n|]*https?:\/\/[^\n|]*\|\s*(iex|Invoke-Expression)\b/i,
    /\b(Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File)\b[^\n]*-Stream\b/i,
    /\b(Add|Set|Remove)-MpPreference\b/i,
    /\bSet-ProcessMitigation\b/i,
  ];
  const WIN_GUARDED: RegExp[] = [
    /\bUnblock-File\b/gi,
    /-ExecutionPolicy\s+(Bypass|Unrestricted)\b/gi,
    /\bSet-ExecutionPolicy\b/gi,
    /\bInvoke-Expression\b/gi,
    /\|\s*iex\b/gi,
  ];
  function windowsMisuse(line: string): boolean {
    if (WIN_ALWAYS.some((re) => re.test(line))) return true;
    for (const re of WIN_GUARDED) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const before = line.slice(Math.max(0, m.index - 100), m.index);
        if (!WIN_NEGATION.test(before)) return true;
      }
    }
    return false;
  }

  function violationIn(text: string): string | null {
    for (const line of text.split("\n")) {
      if (windowsMisuse(line)) {
        return `Windows unblock/execution-policy guidance: "${line.trim().slice(0, 120)}"`;
      }
    }
    // No `g` flag: CONTROL is only used with .test(); a global regex's lastIndex
    // leaked between sentences and could skip a violation.
    const CONTROL =
      /(Gatekeeper|Defender|SmartScreen|Smart App Control|Controlled Folder Access|User Account Control|\bUAC\b)/i;
    const BYPASS_VERB =
      /\b(disable|turn\s+off|bypass|weaken|defeat)\s+(?:\w+\s+){0,2}?(Gatekeeper|Defender|SmartScreen|Smart App Control|Controlled Folder Access|User Account Control|\bUAC\b)/i;
    const stripQuarantine = /\b(strip|remove)\s+(?:\w+\s+){0,3}?quarantine/i;
    const bypassVerb = new RegExp(BYPASS_VERB.source, "gi");
    for (const s of sentences(text)) {
      // A bypass verb directly governing a control name is banned UNLESS a
      // negation ("do not disable…") governs the same clause.
      let m: RegExpExecArray | null;
      while ((m = bypassVerb.exec(s)) !== null) {
        const before = s.slice(Math.max(0, m.index - 80), m.index);
        if (!/\b(do not|don't|never|without)\b[^.]*(disable|turn off)?$/i.test(before)) {
          return `security-control bypass: "${s.slice(0, 120)}"`;
        }
      }
      if (
        !/\b(do not|don't|never|no)\b/i.test(s) &&
        (stripQuarantine.test(s) || (/\bbypass\b/i.test(s) && CONTROL.test(s)))
      )
        return `security-control bypass: "${s.slice(0, 120)}"`;
      if (/HIPAA|IRB/i.test(s)) return `compliance claim: "${s.slice(0, 120)}"`;
      if (/opaque\s+ids?/i.test(s)) return `'opaque IDs' framing: "${s.slice(0, 120)}"`;
      if (xattrMisuse(s)) return `xattr guidance: "${s.slice(0, 120)}"`;
      if (
        /\bspctl\s+--?(master-disable|global-disable|add|remove|disable)\b/i.test(s) ||
        /\bcsrutil\s+disable\b/i.test(s)
      )
        return `security-setting mutation: "${s.slice(0, 120)}"`;
      if (/Properties\s*(→|->)\s*Unblock/i.test(s)) return `Unblock guidance: "${s.slice(0, 120)}"`;
      if (/right-?click\s*(→|->)?\s*open/i.test(s)) return `right-click Open guidance: "${s.slice(0, 120)}"`;
      if (/\b(add|create|allow)\b[^.]{0,60}\bfirewall\b[^.]{0,30}\b(exception|rule)\b/i.test(s) && !/\bno\s+(firewall|inbound)/i.test(s))
        return `firewall exception advice: "${s.slice(0, 120)}"`;
      if (/(switch|turning|turn)\s+(out\s+of|off)\s+(S mode)?/i.test(s) && /S mode/i.test(s) && !/not recommend|unsupported|do not|don't|stop/i.test(s))
        return `S-mode switch advice: "${s.slice(0, 120)}"`;
    }
    return null;
  }

  it("README, docs, and in-app content contain no prohibited guidance", () => {
    const violations: string[] = [];
    for (const { file, text } of markdownAndContentFiles()) {
      const v = violationIn(text);
      if (v) violations.push(`${file}: ${v}`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("source-available does not equal safe anywhere in our own copy", () => {
    for (const { file, text } of markdownAndContentFiles()) {
      expect(/because it('s| is) open[- ]source[, ]*(it )?(is )?safe/i.test(text), `${file} claims open-source proves safe`).toBe(false);
    }
  });

  it("scans maintainer docs and the terminal installer", () => {
    const files = [...markdownAndContentFiles()].map((f) => f.file);
    expect(files).toContain("docs/maintainers/TERMINAL-INSTALL.md");
    expect(files).toContain("docs/maintainers/SIGNING-ACTIVATION.md");
    expect(files).toContain("scripts/install-mac.sh");
    expect(files).toContain("scripts/install-windows.ps1");
  });

  it("bans Windows unblocking, execution-policy changes and pipe-to-iex; permits read-only stream inspection", () => {
    for (const ok of [
      "The installer never runs Unblock-File and never removes a Zone.Identifier stream",
      "Get-Item .\\Fleuron_2.11.0_x64-setup.exe -Stream Zone.Identifier",
      "Get-Content .\\Fleuron_2.11.0_x64-setup.exe -Stream Zone.Identifier",
      "powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File install-windows.ps1",
      "We never document -ExecutionPolicy Bypass for users",
      "Rejected: irm <url> | iex, because it leaves nothing on disk to inspect",
      "Do not disable Smart App Control to run Fleuron",
    ]) {
      expect(violationIn(ok), `expected allowed Windows text: ${ok}`).toBeNull();
    }

    for (const bad of [
      "Run Unblock-File on the downloaded installer",
      "Unblock-File -Path .\\Fleuron_2.11.0_x64-setup.exe",
      "powershell -ExecutionPolicy Bypass -File install-windows.ps1",
      "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
      "irm https://example.invalid/install.ps1 | iex",
      "Remove-Item .\\Fleuron.exe -Stream Zone.Identifier",
      "Add-MpPreference -ExclusionPath C:\\Fleuron",
      "Set-ProcessMitigation -Name Fleuron.exe -Disable DEP",
      "Open Properties -> Unblock on the setup file",
      "Add a firewall exception for Fleuron",
      "Switch out of S mode to install Fleuron",
      "Turn off Smart App Control to install",
    ]) {
      expect(violationIn(bad), `expected Windows violation for: ${bad}`).not.toBeNull();
    }
  });

  it("permits only read-only xattr inspection", () => {
    expect(violationIn("xattr -l ~/Applications/Fleuron.app")).toBeNull();
    expect(violationIn("xattr -p com.apple.quarantine ~/Applications/Fleuron.app")).toBeNull();

    for (const bad of [
      "xattr -d com.apple.quarantine Fleuron.app",
      "xattr -c Fleuron.app",
      "xattr -cr Fleuron.app",
      "xattr -w com.apple.quarantine x Fleuron.app",
      "xattr -l -d com.apple.quarantine x",
      "sudo xattr -r -d com.apple.quarantine /Applications/Fleuron.app",
      "Run xattr on the app",
    ]) {
      expect(violationIn(bad), `expected xattr violation for: ${bad}`).not.toBeNull();
    }
  });

  it("still bans the rest", () => {
    // Each negative sample triggers its own rule in violationIn() (quarantine
    // stripping, right-click Open, Gatekeeper bypass, spctl/csrutil mutation,
    // compliance claim) and is not shadowed by an unrelated rule.
    for (const bad of [
      "Remove the quarantine attribute with Terminal",
      "Use right-click → Open",
      "To install, bypass Gatekeeper",
      "spctl --master-disable",
      "sudo spctl --global-disable",
      "csrutil disable",
      "IRB approved",
    ]) {
      expect(violationIn(bad), `expected violation for: ${bad}`).not.toBeNull();
    }

    expect(violationIn("Never bypass Gatekeeper")).toBeNull();
    expect(violationIn("spctl -a -vv /Applications/Fleuron.app")).toBeNull();
  });
});
