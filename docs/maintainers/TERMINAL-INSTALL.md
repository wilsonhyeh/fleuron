# Terminal Installer Architecture and Threat Model (macOS and Windows)

## 1. Decision summary

Fleuron offers a checksum-verified macOS Terminal installer (`install-mac.sh`) alongside the Finder disk-image path. Partners run two commands with absolute paths:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o ~/fleuron-install-mac.sh https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh
/bin/bash ~/fleuron-install-mac.sh && rm ~/fleuron-install-mac.sh
```

- **Stable URL:** `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh`
- **Trust anchor:** the `wilsonhyeh/fleuron` GitHub release over TLS at the moment line 1 runs.
- **Verification and privileges:** the script downloads the release DMG itself, refuses any local disk-image path argument (exit `2`), verifies the DMG's SHA-256 against both a value baked into the script at release time and the release's `SHA256SUMS.txt`, checks the app's bundle identifier/version/signature, and copies to `/Applications` when writable or `~/Applications` with no administrator rights. It never prompts for a password and never modifies any macOS security setting.
- **Post-install updates:** arrive through Fleuron's built-in Tauri updater (minisign-verified).
- **Version placeholder:** `<version>` in the commands and filenames below is the release number; the release tag adds a leading `v` (`v<version>`).

## 2. Published where

- **Public URL:** `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh`
- **Rendering and upload (`.github/workflows/release.yml`, `finalize-draft` job):** the `"Render terminal installer"` step renders `assets/install-mac.sh` from the uploaded universal DMG via `scripts/render-install-mac.sh` and uploads it in the same `gh release upload` call as the other release files.
- **Provenance validation (`.github/workflows/release.yml`, `provenance` job):** `"Validate install-mac.sh pins the attested DMG"` re-checks that the rendered script pins the exact SHA-256 of the attested DMG.
- **Checksums and attestation:** `SHA256SUMS.txt` (and the `actions/attest` subject-checksums attestation) includes `install-mac.sh`.
- **Release inventory:** eight assets (`Fleuron_<version>_universal.dmg`, `Fleuron_<version>_x64-setup.exe`, `Fleuron_<version>_x64-setup.exe.sig`, `Fleuron_universal.app.tar.gz`, `Fleuron_universal.app.tar.gz.sig`, `latest.json`, `install-mac.sh`, `install-windows.ps1`) plus `SHA256SUMS.txt`.
- **Why the script uses tag-pinned URLs internally:** `releases/latest/download/install-mac.sh` resolves to the newest published release when line 1 runs, while inside the rendered script the DMG and `SHA256SUMS.txt` URLs are pinned to the specific tag (`releases/download/v<version>/...`) so a concurrent release publication mid-install cannot mix a script from one release with assets from the next.

## 3. Threat model

**Protected assets:** the researcher's Mac and the sensitive qualitative transcripts it will hold.

| Scenario | Pipe-to-shell | Two-step (adopted) | Minisign CLI | Homebrew tap | Tauri updater (adopted post-install) | Other (`.pkg` / ad-hoc bin / `gh attestation`) |
| --- | --- | --- | --- | --- | --- | --- |
| MITM | TLS defends; piped stream uninspectable | TLS + pinned DMG SHA-256 + `SHA256SUMS` | Same without out-of-band key | TLS + cask `sha256` | TLS + embedded minisign pubkey | `gh attestation` adds Sigstore log check |
| Repo / account compromise | Attacker serves arbitrary shell | Attacker replaces script + DMG together | Fails unless key held out-of-band | Main or tap compromise wins | Fails: updater rejects without minisign key | Immutable releases block post-publish edits only |
| Domain compromise (`fleuron.study`) | N/A (not served from site) | N/A (GitHub release URL) | N/A | N/A | N/A | N/A; hosting on site adds code-exec origin |
| Malicious mirror | Mirror serves altered script | Script checks tag-pinned GitHub URL + SHA-256 | Blocked if verified against out-of-band key | Blocked by cask `sha256` unless tap altered | Blocked by embedded minisign pubkey | `gh attestation` rejects altered artifact |
| Tampered cached DMG | N/A if fetching directly | Refused: path arg exits `2`, fresh DMG checked | Would check if pointed at DMG | Cask uses brew cache `sha256` | Fetches fresh archive via `reqwest` | Unsigned `.pkg` / bin lack independent check |
| `curl` shadowed on `PATH` | User's `curl` on `PATH` runs | Defeated: `/usr/bin/curl` and system paths | User's `PATH` invoked for install/run | `brew` runs on user `PATH` | Uses in-app Rust `reqwest` | Depends on caller `PATH` |
| Truncated download | Partial shell runs unless `main`-wrapped | Refused: `-fsSL`, `main`-wrapped, SHA-256 fails (`10`/`20`) | Signature fails on truncated file | Cask `sha256` fails | Signature check fails | Truncated `.pkg`/bin fails mount or seal |
| Run twice | Re-downloads and runs blindly | No-op exit `0` when current version verifies | Manual re-verify | Reinstalls or reports installed | Checks `latest.json`, skips same version | `.pkg` re-runs installer scripts |
| Uninstall | Not provided unless fetched again | `--uninstall` deletes app, keeps `~/Fleuron` | N/A | `brew uninstall` | N/A | `.pkg` needs manual removal |
| Upgrade | Re-runs full script | Rerunning newest script upgrades atomically | Manual fetch + verify | `brew upgrade` | Minisign-verified automatic in-app update | `.pkg` overwrites in place |
| Intel vs Apple Silicon | Universal DMG covers both | Universal DMG covers both (`uname -m` logged) | Universal artifact | Universal artifact | Both `darwin-aarch64` and `darwin-x86_64` | Universal binary/package |
| Non-admin user | Fails if script targets `/Applications` | Falls back to `~/Applications`, no `sudo` | Homebrew install fails (needs admin) | Fails (Homebrew requires admin) | Replaces app owned by user | `.pkg` `-target /` needs root |
| University MDM-managed Mac | Blocked if Terminal/scripts restricted | Runs if Terminal allowed; exit `30` if DMG blocked | Often blocked (no Homebrew) | Usually blocked by MDM | Works in user space | `.pkg`/MDM policies vary |
| Offline Mac | Fails (`10`) | Fails (`10`); use option A + offline digest check | Works if pubkey + CLI already present | Fails | Fails | Option A + external digest check |

## 4. Options

### 4.1 Pipe-to-shell

- **Partner types:** a single `curl ... | bash` command piped directly into the shell.
- **What fails:** a server can detect piped execution (via timing or client read behavior) and serve different bytes than a browser or file inspection shows; if the stream truncates mid-transfer, partial commands execute unless the entire script is wrapped in `main`; nothing remains on disk to inspect, hash, attest, or attach to an install-help issue.
- **Attacker gains:** silent, unlogged user-level code execution on origin or delivery compromise with zero artifact left for investigation.
- **Trust cost:** high — eliminates pre-execution inspection and digest checks to save one terminal line.
- **Verdict:** **Rejected** as the documented install form (the script is still `main`-wrapped at the bottom so accidental piping remains truncation-safe).

### 4.2 Two-step download-then-execute

- **Partner types:** two explicit commands using absolute paths (`/usr/bin/curl` and `/bin/bash`):
  download `~/fleuron-install-mac.sh`, optionally inspect/hash/attest it, then run and remove it.
- **What fails:** honestly, most partners will not read the script before running line 2; also, an attacker who controls the GitHub account or release token can replace both the script and the release assets at the same time.
- **Attacker gains:** user-level execution if the `wilsonhyeh` GitHub account, release token, or GitHub TLS delivery is compromised.
- **Trust cost:** costs one extra line; buys a concrete file on disk whose SHA-256 digest can be compared against `SHA256SUMS.txt`, checked with `gh attestation verify`, inspected by eye, or vetted once per release by institutional IT/security offices, and eliminates pipe-detection tricks.
- **Verdict:** **ADOPTED**.

### 4.3 Minisign

- **Partner types:** verifying the downloaded script or DMG with `minisign` before installation.
- **What fails:** `minisign` is not installed on stock macOS; installing it via Homebrew requires admin rights; shipping a vendored `minisign` binary introduces another unverified executable from the same GitHub origin; shipping a public key alongside the payload is circular on first install; writing a hand-rolled JS verifier via `osascript` creates custom cryptography to audit with the exact same circularity; signing `SHA256SUMS.txt` with the Tauri updater's minisign key would widen that key's operational exposure.
- **Attacker gains:** identical to origin compromise unless the partner already obtained a trusted public key out of band.
- **Trust cost:** heavy dependency friction or wider updater-key exposure without an independent first-install root of trust.
- **Verdict:** **Rejected** for now; revisit if research partners specifically request it.

### 4.4 Homebrew tap

- **Partner types:** `brew install --cask ...`.
- **What fails:** requires Homebrew first, which assumes administrator privileges and is frequently disallowed on university MDM-managed Macs; Homebrew applies quarantine to cask downloads and Homebrew's former option to skip quarantine is gone, so the same Open Anyway dialog appears with zero UX gain; the cask `sha256` lives in a separate tap repository on the same GitHub account, so git history acts as an audit trail rather than prevention while per-release tap updates add a second drift and compromise surface.
- **Attacker gains:** compromising either the main repo or the tap repo compromises installs.
- **Trust cost:** admin prerequisite, extra repository maintenance, and no dialog improvement.
- **Verdict:** **Rejected**.

### 4.5 Tauri updater

- **Partner types:** nothing after first install; the user clicks Update inside Fleuron.
- **What fails:** cannot bootstrap the initial installation because Fleuron is not yet on disk.
- **Attacker gains:** a release-asset or GitHub account compromise alone cannot forge an update because the updater refuses any payload lacking a valid signature from the embedded minisign key.
- **Trust cost:** low — the minisign public key is compiled into the installed application binary, providing an anchor independent of GitHub release assets, and fetches run over `reqwest` without creating a quarantine attribute.
- **Verdict:** **ADOPTED** for every update after first install; `install-mac.sh` no-ops when the same version is installed and refuses downgrades so it never fights the updater.

### 4.6 Other evaluated primitives and mechanisms

- **Unsigned `.pkg`:**
  - *Partner types:* `installer -pkg ... -target ...` or double-clicking a `.pkg`.
  - *What fails:* `installer -target /` requires root; per-user installs require a package built for the home domain; quarantined `.pkg` downloads opened in Installer.app hit the same unverified-developer dialog; `.pkg` scripts run with installer privileges.
  - *Attacker gains:* code execution during package scripts; only receipt tracking is gained over a `.app` copy.
  - *Trust cost:* higher complexity and privilege assumptions.
  - *Verdict:* **Rejected**.
- **Ad-hoc-signed bootstrap binary:**
  - *Partner types:* downloading and executing a compiled Mach-O helper instead of a shell script.
  - *What fails:* ad-hoc signing provides seal integrity only and carries no publisher identity; anyone can ad-hoc sign a binary; compiled binaries are far less inspectable than plain shell.
  - *Attacker gains:* opaque execution if replaced at the origin.
  - *Trust cost:* harder for IT/partners to inspect with no identity gain.
  - *Verdict:* **Rejected**.
- **`ditto` (copy primitive):**
  - *Partner types:* internal step inside `install-mac.sh`.
  - *What fails:* fails cleanly if disk space or target permissions are missing (handled by staging and rollback).
  - *Attacker gains:* none beyond the script itself.
  - *Trust cost:* low — preserves the app bundle's ad-hoc code signature and permissions cleanly without using any quarantine-altering flag.
  - *Verdict:* **ADOPTED** as the copy primitive.
- **`osascript`:**
  - *Partner types:* GUI-prompted shell wrapper via AppleScript/JXA.
  - *What fails:* adds macOS automation prompts and complexity with zero trust advantage over bash.
  - *Attacker gains:* same as shell execution.
  - *Trust cost:* unnecessary complexity and prompt friction.
  - *Verdict:* **Rejected**.
- **`gh attestation verify`:**
  - *Partner types:* optional verification command between line 1 and line 2 (`gh attestation verify ~/fleuron-install-mac.sh --repo wilsonhyeh/fleuron`).
  - *What fails:* requires GitHub CLI (`gh`) and authentication.
  - *Attacker gains:* cannot forge a Sigstore-backed workflow attestation without compromising GitHub Actions provenance for this repository.
  - *Trust cost:* extra CLI prerequisite, so unsuitable as a hard requirement for non-technical partners.
  - *Verdict:* **OPTIONAL** advanced verification step.
- **GitHub per-asset API digests:**
  - *Partner types:* querying GitHub's release asset API for a `sha256` field at install time.
  - *What fails:* GitHub computes API digests at upload time, so an attacker or maintainer re-uploading an asset automatically receives a matching fresh digest; shares the same trust root as `SHA256SUMS.txt` without build-time pinning.
  - *Attacker gains:* silent asset swap after release creation.
  - *Trust cost:* weakens immutability compared to a digest baked into the script during CI.
  - *Verdict:* **Rejected** for the script's internal pin.
- **GitHub immutable releases:**
  - *Partner types:* repository configuration in GitHub settings (no partner action).
  - *What fails:* prevents post-publish asset replacement and tag moves, but does not stop an attacker with write access from publishing a brand-new malicious `latest` release.
  - *Attacker gains:* must publish a visibly new release rather than silently mutating an existing tag.
  - *Trust cost:* zero partner friction; narrows maintainer re-upload mistakes and silent tag tampering.
  - *Verdict:* **RECOMMENDED** (repository owner enables in GitHub settings).

## 5. Mitigation → threat → test case

| Mitigation in `scripts/install-mac.sh` | Threat addressed | `scripts/install-mac.test.sh` cases |
| --- | --- | --- |
| Pinned DMG SHA-256 check | MITM, mirror swap, silent re-upload, partial swap | `C7`, `C11` |
| `SHA256SUMS.txt` cross-check | Partial asset swap / inconsistent release metadata | `C8` |
| Strict `curl -fsSL` + size/digest check | Truncated DMG download | `C10` |
| Installed-version check + verify before no-op | Re-running installer twice / fighting updater | `C2` |
| Writable `/Applications` check with `~/Applications` fallback | Standard (non-admin) macOS account | `C5` |
| Owner, foreign bundle ID, and symlink refusal (exit `5`) | Clobbering another user's or IT-managed install / symlink attack | `C6` |
| `Info.plist` bundle ID, version, and `codesign` checks | Wrong app or tampered bundle inside DMG (`study.fleuron.desktop`) | `C12`–`C15` |
| Stage-then-swap with rollback on failure (exit `50`) | Mid-copy disk full / interrupted replace leaving broken app | `C16` |
| Reject any positional DMG path argument (exit `2`) | Tricking installer into using a tampered cached DMG | `C20` |
| Absolute `/usr/bin/curl`, `/bin/bash`, and system tool paths | `curl` or helper shadowed on `PATH` | `C21`, `C21-MUT` |
| `--proto '=https' --proto-redir '=https'` on every `curl` | A redirect downgrading the download to plain http | `C27`, `C27-MUT` |
| Static/policy check forbidding security-setting mutations | Script altering Gatekeeper or system security configuration | `C22` |
| `main "$@"` invocation at EOF | Truncated pipe executing partial commands | `C23` |
| `--uninstall` removes only verified bundle, preserves `~/Fleuron` | Data loss during uninstall | `C25` |

## 6. Decision: the quarantine attribute is not touched

- Both `/usr/bin/curl` and the `ditto` copy from a `curl`-fetched disk image create no quarantine attribute.
- The installer never ingests a browser-downloaded disk image (it rejects any path argument with exit `2`).
- Because no quarantine attribute is ever created on this path, nothing needs clearing, and the contract test (`src/lib/privacy-contract.test.ts`) continues banning quarantine mutation while permitting only `xattr -l <path>` and `xattr -p <name> <path>` inspection.
- If a future macOS version begins quarantining `curl` output, the result is the normal Open Anyway dialog — failing in the safe direction.
- When the browser path does show that dialog, macOS 27.0.1 titles it “Fleuron” Not Opened and offers a blue, filled **Move to Trash** default above a grey **Done**. Move to Trash deletes the app; the safe click is Done, then System Settings → Privacy & Security → Open Anyway. The wording was verified on macOS 27.0.1 (build 26A434); earlier versions may differ, so check the title and the buttons rather than the version.
- **Is this working around OS protection?** No system setting is changed. Like any command-line install, fetching with `curl` does not attach a browser download attribute; Gatekeeper's first-launch assessment applies to browser-marked downloads. For this ad-hoc build that dialog never carried a publisher identity, and because the build is not notarized there was never an Apple malware scan to lose. We make no claim about any OS malware scan on this path.

## 7. Residual risk

The Terminal installer's trust anchor is the integrity of the wilsonhyeh GitHub account and GitHub's release delivery over TLS at the moment the partner runs line 1.
- The pinned SHA-256 and the SHA256SUMS cross-check turn 'whatever bytes arrive' into 'exactly the bytes this release's CI built'. That defeats network tampering without a CA compromise, truncation, mirrors, cached or tampered disk images, partial asset swaps and maintainer re-upload mistakes.
- They do not defend against an attacker who can replace the script itself (account, token or GitHub compromise). Only the optional `gh attestation verify` raises that bar today, and only notarization/Developer ID would give macOS an independent publisher identity.
- On this path macOS shows no unverified-developer dialog. For this ad-hoc build that dialog never carried an identity. We make no claim that any OS malware scan runs.
- Updates after install are protected by the updater's minisign key, which a release-asset compromise alone does not have.

## 8. Serving URL

- **Candidates:** `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh` vs `https://fleuron.study/install-mac.sh`.
- **Compromise cost comparison:**
  - *GitHub account/token compromise:* full compromise of new installs on **both** the GUI disk-image path and the Terminal path, though **not** existing-user updates (which require the separate minisign private key).
  - *`fleuron.study` domain, DNS, or host compromise:* if the marketing site hosted `install-mac.sh`, compromising the website host or DNS would turn it into a direct code-execution origin independent of GitHub.
  - *Per-release hash sync in a second repo:* storing a copy or pinned hash in `fleuron-site` introduces release-time drift between repos.
- **Chosen:** GitHub (`https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh`).
- **Optional site follow-up (not done):** `fleuron-site/src/pages/download.astro` could show the same two lines pointing at the GitHub URL; no `public/` file is hosted on the site. `/install` already renders `docs/INSTALLING.md`.

## 9. CI / inventory implications

- **`.github/workflows/release.yml`:** `finalize-draft` renders `assets/install-mac.sh` via `scripts/render-install-mac.sh` and uploads it in the same `gh release upload` call (eight release assets plus `SHA256SUMS.txt`). `provenance` verifies that `install-mac.sh` pins the attested DMG and includes it in the subject checksums.
- **`.github/workflows/test.yml`:** runs `scripts/install-mac.test.sh` to exercise all installer safety, verification, rollback, and policy invariants.
- **`scripts/install-windows.test.ps1`:** runs on `windows-latest` (with static cases also runnable on `ubuntu-latest` under `pwsh`) to exercise the Windows PowerShell installer invariants.
- **`scripts/install-windows-contract.test.mjs`:** enforces the Windows PowerShell installer template, CI render/validation, and privacy/policy contract.
- **`scripts/release-contract.test.mjs`:** enforces the eight-asset + `SHA256SUMS.txt` inventory, the render/validation workflow steps, and negative mutations.
- **`src/lib/privacy-contract.test.ts`:** scans `README.md`, `docs/*.md`, `docs/maintainers/*.md`, and `src/content/*.ts`, preserving the ban on quarantine mutation and security-control disabling/workaround guidance while permitting `xattr -l <path>` / `xattr -p <name> <path>` inspection.

## 10. Rollout

- `v2.11.2` is the first release that carries `install-mac.sh`, so `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh` resolves once that release is published. `v2.11.0` and earlier carry no such asset and return 404.
- The `docs/INSTALLING.md` rewrite ships in the same release commit and tag, and `fleuron.study/install` re-renders it automatically. Keep the ordering invariant regardless: never merge a `docs/INSTALLING.md` that documents the stable URL before a published release carries the asset, unless you backfill by hand — render locally from the `curl`-fetched DMG and run `gh release upload <tag> install-mac.sh`, accepting that a backfilled script sits outside that release's `SHA256SUMS.txt` and attestation.

## 11. Mac verification checklist (5 minutes)

```bash
# 0. Context
sw_vers; uname -m; id -Gn | tr ' ' '\n' | grep -qx admin && echo ADMIN || echo STANDARD
# 1. Render a test installer against the live release's assets (curl -> no quarantine)
mkdir -p /tmp/flt && cd /tmp/flt
/usr/bin/curl --proto '=https' --proto-redir '=https' -fL -o Fleuron_<version>_universal.dmg https://github.com/wilsonhyeh/fleuron/releases/download/v<version>/Fleuron_<version>_universal.dmg
bash ~/Developer/codemap/scripts/render-install-mac.sh <version> /tmp/flt/Fleuron_<version>_universal.dmg /tmp/flt/install-mac.sh
# 2. Browser vs curl attributes: also download the same DMG with Safari into ~/Downloads, then
xattr -l ~/Downloads/Fleuron_<version>_universal.dmg     # EXPECT com.apple.quarantine present
xattr -l /tmp/flt/Fleuron_<version>_universal.dmg        # EXPECT no com.apple.quarantine (record anything else, e.g. com.apple.provenance)
# 3. Install (remove any existing copy first)
/bin/bash /tmp/flt/install-mac.sh --uninstall
/bin/bash /tmp/flt/install-mac.sh; echo "exit=$?"     # EXPECT the success block, exit=0, NO password prompt
xattr -p com.apple.quarantine /Applications/Fleuron.app; echo "exit=$?"   # EXPECT attribute absent, exit=1
spctl -a -vv /Applications/Fleuron.app; echo "exit=$?"                    # EXPECT rejected (same as CI's recorded evidence); record the text
open /Applications/Fleuron.app                        # EXPECT the app opens with NO "cannot verify the developer" dialog; System Settings > Privacy & Security shows no "Fleuron was blocked"
# 4. Idempotency
/bin/bash /tmp/flt/install-mac.sh; echo "exit=$?"     # EXPECT "already installed ... nothing to do", exit=0
# 5. Non-admin (a Standard account via fast user switching; it can read /tmp/flt/install-mac.sh)
/bin/bash /tmp/flt/install-mac.sh; echo "exit=$?"     # with the admin's /Applications copy present: EXPECT exit=5 naming /Applications/Fleuron.app
#   then as admin: /bin/bash /tmp/flt/install-mac.sh --uninstall ; back as Standard:
/bin/bash /tmp/flt/install-mac.sh; echo "exit=$?"     # EXPECT install to ~/Applications/Fleuron.app, exit=0, no password prompt
open ~/Applications/Fleuron.app                       # EXPECT opens with no dialog
#   optional: as Standard, try the Safari DMG + Open Anyway path and record whether it demands admin credentials
# 6. Uninstall keeps data
/bin/bash /tmp/flt/install-mac.sh --uninstall; ls ~/Fleuron   # EXPECT app removed, studies listed
```

**Results template:** macOS version and arch | admin/standard | step 2 two `xattr -l <path>` outputs | step 3 installer output + exit | `xattr -p <name> <path>` output | spctl output | dialog seen? (Y/N + screenshot) | step 4 output | step 5 both outputs | step 6 output.

## 12. When signing activates

See [SIGNING-ACTIVATION.md](SIGNING-ACTIVATION.md) for the full maintainer runbook — in particular, replacing the `Signature=adhoc` / `TeamIdentifier=not set` assertions in `scripts/install-mac.sh` with the Developer ID authority and real TeamIdentifier, re-running `bash scripts/install-mac.test.sh`, and updating `docs/INSTALLING.md` once builds are signed and notarized.

## 13. Windows PowerShell installer

### 13.1 Decision summary

Fleuron offers a checksum-verified Windows PowerShell installer (`install-windows.ps1`) alongside the double-click setup file path (option A). Partners open Windows PowerShell (not Run as administrator) and run two commands with absolute system paths:

```powershell
& "$env:SystemRoot\System32\curl.exe" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$env:USERPROFILE\fleuron-install-windows.ps1" https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-windows.ps1
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:USERPROFILE\fleuron-install-windows.ps1"; if ($LASTEXITCODE -eq 0) { Remove-Item -LiteralPath "$env:USERPROFILE\fleuron-install-windows.ps1" }
```

- **Stable URL:** `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-windows.ps1`
- **Trust anchor:** the `wilsonhyeh/fleuron` GitHub release over TLS at the moment line 1 runs. Inside the rendered script, `SHA256SUMS.txt` and `Fleuron_<version>_x64-setup.exe` URLs are pinned to the tagged release (`releases/download/v<version>/...`).
- **Verification and privileges:** the script installs per-user into `%LOCALAPPDATA%\Fleuron`, never elevates or asks for administrator rights (exits `3` if run elevated), and writes no registry value itself (the verified NSIS setup binary writes the per-user `HKCU` uninstall and product entries). It never changes any Windows security setting.
- **Post-install updates:** arrive through Fleuron's built-in Tauri updater (minisign-verified).

### 13.2 Does this improve Windows?

Net effect: the PowerShell path leaves SmartScreen switched on and produces a file SmartScreen is never asked about. The partner trades Microsoft's reputation opinion for a release-pinned SHA-256 whose trust root is the same GitHub account and release as the script itself. Smart App Control, S mode, App Control for Business (WDAC), AppLocker and managed SmartScreen policies still apply, so the gain is small and bounded: two fewer clicks on an unmanaged PC, plus an enforced checksum.

| Dimension | Option A: setup file (double-click) | Option B: PowerShell (checksum-verified) |
| --- | --- | --- |
| Prompts | SmartScreen "Windows protected your PC" (More info -> Run anyway) on browser downloads; no UAC prompt | No SmartScreen prompt expected on `curl.exe` download; no UAC prompt; POLICY STOP (exit `30`) if Smart App Control, S mode, or device policy blocks |
| Steps | Download `.exe` in browser, double-click, click More info -> Run anyway, follow setup | Paste two PowerShell lines; optional Notepad, `Get-FileHash`, or `gh attestation verify` check between them |
| Verification | Manual SHA-256 or `gh attestation verify` only if the user runs it | Enforces pinned SHA-256 and `SHA256SUMS.txt` match automatically before running setup |
| Idempotency | Re-runs NSIS setup unconditionally | Checks installed version first; no-ops exit `0` when current or newer; `--reinstall` forces repair |
| Uninstall | Windows Settings -> Apps -> Installed apps | `--uninstall` flag or Settings -> Apps -> Installed apps; studies in `%USERPROFILE%\Fleuron` kept |
| Who it suits | Most Windows users (default recommendation) | Users comfortable pasting two commands who want automated SHA-256 enforcement |

- **Verdict:** **ADOPTED** as option B; option A stays first.

### 13.3 Mark of the Web analysis

| Claim | Status | Source |
| --- | --- | --- |
| `curl.exe` / `Invoke-WebRequest` / `Invoke-RestMethod` "may not mark" files | Documented by Microsoft | https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies |
| Windows PowerShell 5.1 `Invoke-WebRequest` writes `Zone.Identifier` | Not supported by Microsoft's docs, which list it among tools that may not mark files; unverified on Windows; checklist step 1 records it | https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies |
| SmartScreen only checks files with the Mark of the Web | Third-party documented: Elastic Security Labs; consistent with Microsoft's files-from-the-internet wording; unverified on Windows | https://www.elastic.co/security-labs/dismantling-smart-app-control |
| Microsoft Defender Antivirus still scans files without the mark | Expected; unverified on Windows | https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ |
| Smart App Control blocks unknown unsigned code and replaces SmartScreen when on | Documented by Microsoft | https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview and https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control |
| `VerifiedAndReputablePolicyState` `0`/`1`/`2` = Off/Enforce/Evaluation | Documented by Microsoft (test-your-app page) | https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control |
| `SkuPolicyRequired = 1` means S mode | Documented by Microsoft; registry location unverified | https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-codeintegrity-skupolicyrequired |
| `RemoteSigned`, `Process` scope not saved, Group Policy overrides, "isn't a security boundary" | Documented by Microsoft (`about_execution_policies`) | https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies |

The installer never runs `Unblock-File` (see section 13.5; not used: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file).

### 13.4 Threat-model delta

| Scenario | Option A (.exe) | Option B (adopted) | Rejected: `irm <url> \| iex` |
| --- | --- | --- | --- |
| MITM | TLS defends | TLS + pinned setup SHA-256 + `SHA256SUMS.txt` | TLS defends; piped text uninspectable |
| Repo / account compromise | Attacker serves arbitrary setup `.exe` | Attacker replaces script + setup `.exe` together | Attacker serves arbitrary PowerShell |
| Tampered cached / mirror exe | Runs whatever `.exe` the user double-clicks | Refused: path arg exits `2`; fetches tag-pinned GitHub URL and checks SHA-256 | N/A if fetching directly; no artifact on disk to verify |
| `curl` shadowed on `PATH` | N/A (browser download) | Defeated: invokes absolute `$env:SystemRoot\System32\curl.exe` and `-NoProfile` (in Windows PowerShell 5.1 bare `curl` is an alias for another cmdlet) | Depends on caller session aliases and profile |
| Truncated download | Partial `.exe` fails to launch | Refused: `curl.exe --fail`, top-level function wrapper, SHA-256 fails (`10`/`20`) | Partial statements can still execute |
| SmartScreen reputation | Shows "Windows protected your PC" (More info -> Run anyway) | Expected no prompt on unmarked `curl.exe` download (unverified on Windows) | PowerShell executes text in memory; no setup check until fetched |
| Defender scan | Microsoft Defender Antivirus scans `.exe` | Microsoft Defender Antivirus is expected to scan `.exe` without the mark (unverified on Windows) | In-memory script text receives no file-on-disk inspection first |
| Smart App Control on | Blocks unrecognized unsigned `.exe` | Detects `VerifiedAndReputablePolicyState=1` and stops (`30`); never changes setting | Blocked or script runs until `.exe` is blocked |
| S mode | Blocked (Store apps only) | Detects `SkuPolicyRequired=1` and stops (`30`); PowerShell is normally unavailable in S mode | PowerShell unavailable in S mode |
| WDAC / AppLocker | Blocked by device policy | Detects `ConstrainedLanguage` / WDAC (`30`) or warns on AppLocker; stops on launch error `1260`/`4551` (`30`) | Runs in `ConstrainedLanguage` or blocked |
| Managed SmartScreen Block | Blocked by org policy | Option B detects it (`EnableSmartScreen=1`, `ShellSmartScreenLevel=Block`) and stops (`30`); it never routes around policy | Runs until blocked or escapes policy check |
| Run twice | Re-runs NSIS setup | No-ops exit `0` when current or newer version is installed | Re-downloads and runs blindly |
| Upgrade | Re-runs setup or uses in-app updater | Rerunning newest script upgrades; normal updates use minisign-verified in-app updater | Re-runs blindly |
| Uninstall | Settings -> Apps -> Installed apps | `--uninstall` removes app and keeps `%USERPROFILE%\Fleuron` | Not provided unless fetched again |
| Non-admin | Per-user NSIS install, no UAC | Per-user install to `%LOCALAPPDATA%\Fleuron`, no UAC; exits `3` if run elevated | Inherits caller privileges |
| Offline | Option A + offline digest check | Fails (`10`); use option A + offline digest check | Fails |

### 13.5 Decision: the Mark of the Web is never removed

The installer never runs `Unblock-File` and never deletes or edits a Zone.Identifier stream. If a downloaded setup file carries one, it stops with POLICY STOP (exit `30`) and points to option A. The only stream commands this project documents are read-only: `Get-Item <path> -Stream Zone.Identifier` and `Get-Content <path> -Stream Zone.Identifier`. `src/lib/privacy-contract.test.ts` enforces this.

If a future Windows or `curl.exe` update attaches `Zone.Identifier` to `curl.exe` downloads, the installer fails in the safe direction and sends the user to option A.

### 13.6 Execution policy

Line 2 runs `$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "$env:USERPROFILE\fleuron-install-windows.ps1"`. Passing `-ExecutionPolicy RemoteSigned` applies only to that single child process (`Process` scope) and is not saved. Under `RemoteSigned`, local files without a `Zone.Identifier` stream execute while unsigned scripts marked by a browser as downloaded from the internet are refused, which sends users back to line 1 (`curl.exe`) rather than running an unverified browser copy. If an organization's Group Policy (`MachinePolicy` or `UserPolicy`) disables script execution, Group Policy overrides `-ExecutionPolicy` and PowerShell stops cleanly; the user falls back to option A or contacts IT.

We never document `-ExecutionPolicy Bypass` for users. The installer never calls `Set-ExecutionPolicy` and never asks the user to change the execution policy. Maintainer CI steps that run repository scripts on GitHub runners keep their existing execution-policy flags; those are not user guidance and are not part of this contract.

### 13.7 Rejected: `irm <url> | iex`

Rejected as a user install path: piping `Invoke-RestMethod` into `Invoke-Expression`:
- Nothing lands on disk to read in Notepad, hash with `Get-FileHash`, verify with `gh attestation verify`, or attach to an install issue.
- A server can detect streaming/piped reads and serve different bytes to a pipe than to a file download.
- The fetched text runs directly in the caller's interactive session and profile (with whatever variables, aliases, or modules are loaded) rather than an isolated `-NoProfile` child process.
- A truncated response can still parse and execute partial statements as valid PowerShell.

### 13.8 Truncation

Running `powershell.exe -File` parses the entire script before executing any command, so a cut mid-statement fails as a parse error and executes nothing. A cut at a clean statement boundary could still run valid top-level statements, so `scripts/install-windows.ps1` places only constants and function definitions at top level and puts `Invoke-FleuronMain -ArgList $args` on the final line. This invariant is proven by suite `S3`, `T1`-`T3`, and `scripts/install-windows-contract.test.mjs`.

### 13.9 Policy stops

| Control | Detection (read-only) | Reliability | Exit |
| --- | --- | --- | --- |
| ConstrainedLanguage | `$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'` | reliable | `30` |
| Smart App Control | `HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy` `VerifiedAndReputablePolicyState` = `1` (`2` = warn only) | documented, unverified | `30` (warning on `2`) |
| S mode | `HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy` `SkuPolicyRequired` = `1` (PowerShell itself is normally unavailable in S mode) | documented, unverified | `30` |
| WDAC | `Win32_DeviceGuard` `UsermodeCodeIntegrityPolicyEnforcementStatus` = `2` | best-effort | `30` |
| Managed SmartScreen | `SOFTWARE\Policies\Microsoft\Windows\System` `EnableSmartScreen` = `1` and `ShellSmartScreenLevel` = `Block` (`HKLM` or `HKCU`) | best-effort | `30` |
| AppLocker | `HKLM:\SOFTWARE\Policies\Microsoft\Windows\SrpV2\Exe` `EnforcementMode` = `1` | warning only | continues (warning) |
| Launch refused | Win32 native errors `1260`, `4551`, `225`, `226` when starting the setup `.exe` | mapping unverified | `30` |
| Internet mark on our download | `Get-Item -LiteralPath $setup -Stream 'Zone.Identifier'` returns non-null | reliable | `30` |

These controls stay in force on both paths. The installer only reads their state; it never changes them and never suggests changing them.

### 13.10 Residual risk

The Windows PowerShell installer's trust anchor is the integrity of the `wilsonhyeh` GitHub account and GitHub's release delivery over TLS at the moment the partner runs line 1.
- The pinned SHA-256 and `SHA256SUMS.txt` cross-check turn "whatever bytes arrive" into "exactly the bytes this release's CI built". That defeats network tampering without a CA compromise, truncation, mirrors, cached or tampered setup files, partial asset swaps, and maintainer re-upload mistakes.
- They do not defend against an attacker who can replace `install-windows.ps1` itself (account, token, or GitHub compromise). Only the optional `gh attestation verify` raises that bar today, and only an Authenticode signature would give Windows an independent publisher identity.
- On this path Windows is expected not to show SmartScreen's "Windows protected your PC" prompt (unverified on Windows), while Microsoft Defender Antivirus is expected to scan the setup file (unverified on Windows).
- Updates after install are protected by the updater's minisign key, which a release-asset compromise alone does not have.
- Test hooks are honored only with both `FLEURON_INSTALL_TEST_SYSROOT` and `FLEURON_INSTALL_TEST_REGROOT` set, and anyone who can set a user's environment already controls that account.

### 13.11 Mitigation -> threat -> test case

| Mitigation in `scripts/install-windows.ps1` | Threat addressed | `scripts/install-windows.test.ps1` / `scripts/install-windows-contract.test.mjs` cases |
| --- | --- | --- |
| Pinned setup SHA-256 check (`CHECKSUM-GATE`) | MITM, mirror swap, silent re-upload, partial swap | `C7`, `C11`, `M-*` |
| `SHA256SUMS.txt` cross-check (`SUMS-GATE`) | Partial asset swap / inconsistent release metadata | `C8`, `M-*` |
| Strict `curl.exe --fail --proto '=https' --proto-redir '=https' --tlsv1.2` + digest check | Truncated or downgraded setup download | `C10`, `T1`-`T3` |
| Installed-version check before no-op (`--reinstall` overrides) | Re-running installer twice / fighting in-app updater | `C2` |
| Elevation refusal (`ELEVATION-GATE`, exit `3`) | Running elevated or triggering unexpected UAC | `C4`, `M-*` |
| Machine-wide, reparse-point, product-name, uninstaller-path, writable checks (exit `5`) | Clobbering another user's or IT-managed install / junction attack | `C5`, `C6`, `M-*` |
| Running-process check (exit `4`) | Replacing `Fleuron.exe` while running | `C3` |
| Read-only policy gates (`LANGMODE-GATE`, `SAC-GATE`, `SMODE-GATE`, `SMARTSCREEN-POLICY-GATE`, `WDAC-GATE`, Win32 error map, exit `30`) | Running against OS/org policy blocks or changing security controls | `C12`-`C19`, `S1`-`S6` |
| `Zone.Identifier` gate (`MOTW-GATE`, exit `30`) without removal | Proceeding on an unexpectedly marked file or mutating streams | `C20`, `S1`-`S6`, `M-*` |
| Reject any positional file path / `.exe` / `.msi` argument (exit `2`) | Tricking installer into using a tampered cached setup file | `C21` |
| Absolute `$env:SystemRoot\System32\curl.exe` (`CURL-PATH`) and `-NoProfile` | `curl` shadowed on `PATH` or by PowerShell 5.1 alias | `C22`, `M-*` |
| Static/policy contract checks | Security-setting mutation, stream removal, or prohibited guidance | `C23`-`C25`, `S1`-`S6`, `M-*` |
| Functions-only top level + `Invoke-FleuronMain -ArgList $args` at EOF | Truncated file executing partial commands | `C26`, `S3`, `T1`-`T3`, `M-*` |
| `--uninstall` runs verified `uninstall.exe`, preserves `%USERPROFILE%\Fleuron` and `%APPDATA%\study.fleuron.desktop` | Data loss during uninstall | `C27` |
| ASCII-only template and unrendered-template refusal (exit `2`) | Encoding issues on PS 5.1 or running raw repo template | `C1`, `S1`-`S6`, `M-*` |

### 13.12 CI implications

- **`.github/workflows/release.yml`:** `finalize-draft` renders `assets/install-windows.ps1` via `scripts/render-install-windows.sh` (plus a required `pwsh` parse check) and uploads it in the same `gh release upload` call (eight release assets plus `SHA256SUMS.txt`). `provenance` verifies that `install-windows.ps1` pins the attested setup `.exe` and includes it in `SHA256SUMS.txt` and `actions/attest` subject checksums.
- **`.github/workflows/test.yml`:** runs `scripts/install-windows.test.ps1` on `windows-latest` (with static cases runnable on `ubuntu-latest` under `pwsh`) and `scripts/install-windows-contract.test.mjs`.
- **`scripts/release-contract.test.mjs`:** enforces the eight-asset + `SHA256SUMS.txt` inventory.
- **`src/lib/privacy-contract.test.ts`:** enforces the Windows installer privacy contract (no `Unblock-File`, no `-ExecutionPolicy Bypass`, no `Set-ExecutionPolicy`, no `Invoke-Expression`, and no `| iex` without explicit negation, plus no stream-mutating commands or security-preference mutations).
- The mocked suite executes only on windows-latest; nothing in this repository has been run on a Windows machine by the authors of this change.

### 13.13 Rollout

- `v2.11.2` is the first release that carries `install-windows.ps1`, so `https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-windows.ps1` resolves once that release is published. `v2.11.0` and earlier carry no such asset and return 404.
- The `docs/INSTALLING.md` rewrite ships in the same release commit and tag. Keep the ordering invariant regardless: do not land a guide that documents the stable URL before a published release carries the asset, unless you backfill by hand — render locally from the `curl`-fetched setup exe (`bash scripts/render-install-windows.sh <version> <setup-exe> install-windows.ps1`) and run `gh release upload <tag> install-windows.ps1`, accepting that a backfilled script sits outside that release's `SHA256SUMS.txt` and attestation.

### 13.14 Windows verification checklist (requires a real Windows 11 x64 PC)

```powershell
# 0. Context
[Environment]::OSVersion.Version
$PSVersionTable.PSVersion
whoami /groups | Select-String S-1-16-12288                                            # EXPECT no match
Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy |
  Select-Object VerifiedAndReputablePolicyState, SkuPolicyRequired
$ExecutionContext.SessionState.LanguageMode
Get-ExecutionPolicy -List

# 1. Browser vs curl.exe vs Invoke-WebRequest Zone.Identifier into $env:TEMP\flt
New-Item -ItemType Directory -Force -Path "$env:TEMP\flt" | Out-Null
# Download Fleuron_<version>_x64-setup.exe with Microsoft Edge to "$env:TEMP\flt\edge-setup.exe"
& "$env:SystemRoot\System32\curl.exe" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$env:TEMP\flt\curl-setup.exe" https://github.com/wilsonhyeh/fleuron/releases/download/v<version>/Fleuron_<version>_x64-setup.exe
# In Windows PowerShell 5.1:
Invoke-WebRequest -Uri https://github.com/wilsonhyeh/fleuron/releases/download/v<version>/Fleuron_<version>_x64-setup.exe -OutFile "$env:TEMP\flt\iwr-setup.exe"
Get-Content "$env:TEMP\flt\edge-setup.exe" -Stream Zone.Identifier                      # EXPECT ZoneId=3
Get-Content "$env:TEMP\flt\curl-setup.exe" -Stream Zone.Identifier                      # EXPECT absent
Get-Content "$env:TEMP\flt\iwr-setup.exe"  -Stream Zone.Identifier                      # RECORD whether ZoneId=3 or absent

# 2. Render a test installer on Linux (bash scripts/render-install-windows.sh <version> <curl-setup.exe> install-windows.ps1) and copy to "$env:TEMP\flt\install-windows.ps1"

# 3. Install with line 2 against "$env:TEMP\flt\install-windows.ps1"
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\install-windows.ps1"
$LASTEXITCODE                                                                           # EXPECT the output block, exit 0, no SmartScreen prompt, no UAC prompt
Get-Content "$env:LOCALAPPDATA\Fleuron\Fleuron.exe" -Stream Zone.Identifier             # EXPECT absent
(Get-Item "$env:LOCALAPPDATA\Fleuron\Fleuron.exe").VersionInfo |
  Format-List ProductName, FileVersion, FileMajorPart, FileMinorPart, FileBuildPart     # EXPECT Fleuron <version>
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleuron |
  Format-List DisplayVersion, InstallLocation, UninstallString
# Launch Fleuron from Start menu                                                        # EXPECT opens with no prompt

# 4. Rerun (idempotency)
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\install-windows.ps1"
$LASTEXITCODE                                                                           # EXPECT "already installed ... nothing to do", exit 0

# 5. Uninstall, then test option A with the Edge copy
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\install-windows.ps1" --uninstall
# Double-click "$env:TEMP\flt\edge-setup.exe"                                           # EXPECT the two-click SmartScreen prompt (screenshot)

# 6. Preserve studies on uninstall
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\Fleuron" | Out-Null
Set-Content -Path "$env:USERPROFILE\Fleuron\keep.txt" -Value 'keep'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\install-windows.ps1" --uninstall
Test-Path "$env:LOCALAPPDATA\Fleuron\Fleuron.exe"                                       # EXPECT False (app gone)
Test-Path "$env:USERPROFILE\Fleuron\keep.txt"                                           # EXPECT True (keep.txt present)
Test-Path "$env:APPDATA\study.fleuron.desktop"                                          # EXPECT True ($env:APPDATA\study.fleuron.desktop present)

# 7. Elevated window refusal (open PowerShell via Run as administrator)
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\install-windows.ps1"
$LASTEXITCODE                                                                           # EXPECT exit 3

# 8. Browser-downloaded install-windows.ps1
# Download install-windows.ps1 with Edge to "$env:TEMP\flt\edge-install-windows.ps1" (or copy with ZoneId=3), then run line 2 against it:
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:TEMP\flt\edge-install-windows.ps1"
                                                                                        # EXPECT PowerShell refuses it as not signed; do not unblock it

# 9. Smart App Control (on a PC with Smart App Control on or in evaluation, if available): record behavior for both option A and option B.

# 10. Upgrade: install an older release with option B, confirm the in-app updater upgrades, and confirm rerunning option B reports current/newer.
```

**Results template:** Windows build + PSVersion | elevated? | LanguageMode + ExecutionPolicy | Smart App Control + SkuPolicyRequired | step 1 three `Zone.Identifier` results | step 3 installer output + exit + SmartScreen/UAC? + `Zone.Identifier` + `VersionInfo` + Start launch | step 4 output + exit | step 5 SmartScreen screenshot? | step 6 app gone + `keep.txt` + AppData present? | step 7 exit | step 8 refused? | step 9 (if available) | step 10 upgrade + rerun.
