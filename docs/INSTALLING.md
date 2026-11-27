# Installing Fleuron

> **Publisher verification notice**
> Fleuron is an independent open-source application. This build does not yet carry an Apple Developer ID/notarization or Windows Authenticode publisher signature, so your operating system cannot verify its publisher automatically. Download only from `https://fleuron.study` or the official release page at `https://github.com/wilsonhyeh/fleuron/releases`. Continue only when the version, filename, and warning match this guide. A malware warning, checksum mismatch, or unexpected administrator request means stop.

## Choose your file

Fleuron is distributed from `https://fleuron.study` and the [official Releases page](https://github.com/wilsonhyeh/fleuron/releases); website buttons link directly to binaries hosted on that release page.
Only these files are manual downloads. In the filenames below, `<version>` is the release number shown on the [Releases page](https://github.com/wilsonhyeh/fleuron/releases/latest).

| Your computer | Download this exact file |
| --- | --- |
| macOS (Intel or Apple Silicon) — disk image | `Fleuron_<version>_universal.dmg` |
| macOS (Intel or Apple Silicon) — Terminal installer (downloads and checks the DMG for you; see below) | `install-mac.sh` |
| Windows 11 x64 | `Fleuron_<version>_x64-setup.exe` |
| Windows 11 x64 — PowerShell installer (downloads and checks the setup file for you; see below) | `install-windows.ps1` |

You may also see these on a release page. They are **updater infrastructure — do not download them by hand**:
`Fleuron_universal.app.tar.gz`, `.sig` signature files, `latest.json`, `SHA256SUMS.txt`.

## Three checks before you continue

1. **Official source:** you are on `https://fleuron.study` or `https://github.com/wilsonhyeh/fleuron/releases`, and the download link points to `github.com/wilsonhyeh/fleuron/releases`, not a mirror or ad link.
2. **Version and filename:** the file matches the exact name above for your platform.
3. **Expected warning:** the warning your OS shows matches the *expected* text below.

## Install on macOS — option A: disk image (Finder)

1. Open the DMG and drag **Fleuron** into **Applications**.
2. Launch Fleuron.
3. **Expected warning:** “Apple cannot check the app for malicious software” / “cannot verify the developer”. This release does not have Apple Developer ID signing or notarization. Open-source licensing does not determine whether an app is signed.

   The dialog on macOS 27.0.1 is titled **“Fleuron” Not Opened** and reads:

   > Apple could not verify “Fleuron” is free of malware that may harm your Mac or compromise your privacy.

   It offers two buttons, stacked: **Move to Trash** — blue, filled, and highlighted, the default — and **Done** — grey, below it.

   This wording was verified on **macOS 27.0.1** (build 26A434). Earlier macOS versions may differ — Fleuron supports macOS 10.15 and later — so check the title and the buttons rather than the version.

   **Warning: the blue button deletes the app.** **Move to Trash** is the prominent button, so clicking it — or pressing Return — moves Fleuron to the Trash and removes it from Applications. Click the grey **Done** instead, then continue with step 4.

4. Continue: close the dialog, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, authenticate, then **Open**.

The **Open Anyway** button appears only after a blocked launch, only for the last app macOS blocked, and only for about an hour. If it is gone, open Fleuron from Applications again, click the grey **Done** — never the blue **Move to Trash**, which deletes the app — and go straight back to **System Settings → Privacy & Security**.

The approval is what persists: once you have opened the app this way, later launches need nothing — until an update replaces the binary and macOS asks again.

## Install on macOS — option B: Terminal (checksum-verified)

Choose this option when you are comfortable pasting two commands, want the installer to enforce the SHA-256 check automatically, or have no administrator account (it installs to `~/Applications` when `/Applications` is not writable).

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o ~/fleuron-install-mac.sh https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-mac.sh
/bin/bash ~/fleuron-install-mac.sh && rm ~/fleuron-install-mac.sh
```

**Optional checks between the two lines:**

- Open `~/fleuron-install-mac.sh` in a text editor to read it before running.
- Run `shasum -a 256 ~/fleuron-install-mac.sh` and compare it with the `install-mac.sh` line of `SHA256SUMS.txt` on the release page.
- Run `gh attestation verify ~/fleuron-install-mac.sh --repo wilsonhyeh/fleuron` if you use GitHub CLI.

**What it does:**

1. Checks the release checksum list (`SHA256SUMS.txt`).
2. Downloads `Fleuron_<version>_universal.dmg` from the tagged GitHub release.
3. Refuses the file unless its SHA-256 equals the value built into the installer and matches `SHA256SUMS.txt`.
4. Opens the disk image read-only.
5. Confirms the app's identifier, version, and signature.
6. Copies Fleuron to `/Applications` (or `~/Applications` if you cannot write `/Applications`).
7. Replaces an older copy only after the new one is complete.

**What it never does:**

- Ask for your password or use `sudo`.
- Change any macOS security setting.
- Touch the quarantine attribute.
- Use a disk image you already downloaded.
- Touch your studies.

> macOS shows its 'cannot verify the developer' dialog for files a web browser marks as downloaded. Files fetched by Terminal are not marked, so on this path you should not see that dialog or need Open Anyway. Neither path gives macOS a verified publisher. On this path the installer's SHA-256 check against the official release is the check, and it stops rather than continuing on any mismatch. If macOS does show that dialog anyway, click the grey **Done** — never the blue **Move to Trash**, which deletes the app.
>
> If Terminal asks for a password, press Control-C and stop.

**Expected output:**

```text
fleuron-install: Fleuron <version> installer for macOS (arm64)
fleuron-install: install location: /Applications/Fleuron.app
fleuron-install: checking the release checksum list ... ok
fleuron-install: downloading Fleuron_<version>_universal.dmg ...
<curl progress bar>
fleuron-install: SHA-256 matches the pinned release value ... ok
fleuron-install: checking the app inside the disk image ... ok (study.fleuron.desktop <version>, ad-hoc signed)
fleuron-install: installed Fleuron <version> to /Applications/Fleuron.app
fleuron-install: done. Open Fleuron from Applications. Later updates arrive through Fleuron's built-in updater.
```

Running it again when Fleuron is already at the latest version prints:
`fleuron-install: Fleuron <version> is already installed at <path> and verifies; nothing to do.`

Upgrades normally arrive through the in-app updater; rerunning the newest installer also upgrades.

**Uninstall:** download `~/fleuron-install-mac.sh` again with line 1 first, then run `/bin/bash ~/fleuron-install-mac.sh --uninstall`. Studies in `~/Fleuron` are kept.

**Exit codes:**

| Code | What it means | What to do |
| --- | --- | --- |
| `0` | Installed, already current, newer already installed, or uninstall done | Open Fleuron from Applications (or `~/Applications`) |
| `2` | Usage error or a disk-image path was passed | Run without a file path; the installer fetches the release DMG itself |
| `3` | Unsupported (not macOS, macOS older than 10.15, run as root, or not bash) | Run as a regular user on macOS 10.15 or later with `/bin/bash` |
| `4` | Fleuron is running | Quit Fleuron and run the installer again |
| `5` | Existing install cannot be replaced safely (owned by another account or IT, a different bundle, or a symlink) | Another account or IT installed Fleuron; ask them |
| `10` | Download failed or was cut off | Check your connection and retry; every release from v2.11.2 onward carries the Terminal installer, so a 404 means the download is unavailable right now — use option A |
| `20` | `SECURITY STOP` — checksum mismatch | Stop. Do not retry from another website. File an install issue |
| `30` | Disk image could not be opened | A managed Mac may block disk images; contact IT |
| `40` | `SECURITY STOP` — app identity or signature check failed | Stop. Do not retry from another website. File an install issue |
| `50` | Copy or replace failed; previous version restored or nothing installed | Check disk space and folder permissions, then retry or use option A |

**Offline Macs:** use option A, and check the digest from another device.

## Install on Windows 11 — option A: setup file (double-click)

1. Double-click `Fleuron_<version>_x64-setup.exe`.
2. **Expected warning:** SmartScreen shows **“Windows protected your PC”** with *Unknown publisher*. Expected for a newly published, non-store app.
3. Click **More info**, confirm *Unknown publisher*, then **Run anyway**.
4. The installer installs for **your user account only**. It never asks for administrator credentials. There is no UAC prompt anywhere in this flow.

## Install on Windows 11 — option B: PowerShell (checksum-verified)

Choose this option when you are comfortable pasting two commands into PowerShell and want the installer to enforce the SHA-256 check automatically. Open **Windows PowerShell** from the Start menu (do not choose *Run as administrator*), then run:

```powershell
& "$env:SystemRoot\System32\curl.exe" --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$env:USERPROFILE\fleuron-install-windows.ps1" https://github.com/wilsonhyeh/fleuron/releases/latest/download/install-windows.ps1
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:USERPROFILE\fleuron-install-windows.ps1"; if ($LASTEXITCODE -eq 0) { Remove-Item -LiteralPath "$env:USERPROFILE\fleuron-install-windows.ps1" }
```

`-ExecutionPolicy RemoteSigned` applies only to that one PowerShell process and is not saved. It still refuses an unsigned copy that a web browser marked as downloaded, which is why line 1 uses `curl.exe`.

**Optional checks between the two lines:**
- Open the file in Notepad to read it: `notepad "$env:USERPROFILE\fleuron-install-windows.ps1"`.
- Run `Get-FileHash "$env:USERPROFILE\fleuron-install-windows.ps1" -Algorithm SHA256` and compare it (ignoring upper/lower case) with the `install-windows.ps1` line of `SHA256SUMS.txt` on the release page.
- Run `gh attestation verify "$env:USERPROFILE\fleuron-install-windows.ps1" --repo wilsonhyeh/fleuron` if you use GitHub CLI.

**What it does:**
1. Checks the release checksum list (`SHA256SUMS.txt`).
2. Downloads `Fleuron_<version>_x64-setup.exe` from the tagged GitHub release with the built-in `curl.exe`.
3. Refuses the file unless its SHA-256 equals the value built into the installer and matches `SHA256SUMS.txt`.
4. Stops with POLICY STOP if Smart App Control, S mode, or an organization policy would block Fleuron.
5. Runs the verified setup file silently for your account only; like option A it adds Start menu and desktop shortcuts.
6. Confirms Fleuron <version> is installed in `%LOCALAPPDATA%\Fleuron`.

**What it never does:**
- Ask for administrator rights or show a User Account Control prompt.
- Change any Windows security setting, the execution policy, or Microsoft Defender settings.
- Remove the internet mark (Zone.Identifier) from any file.
- Use a setup file you already downloaded.
- Touch your studies.

> Windows shows SmartScreen's "Windows protected your PC" for files a web browser marks as downloaded from the internet. Files fetched by `curl.exe` are not marked, so on this path you should not see that prompt or need **Run anyway**. Neither path gives Windows a verified publisher, and Microsoft Defender Antivirus still scans the files. On this path the installer's SHA-256 check against the official release is the check, and it stops rather than continuing on any mismatch. Smart App Control, S mode, and organization policies apply to both paths; see **Stop here if…**.
>
> If a User Account Control prompt or a password request appears, choose **No** and stop.

**Expected output:**
```text
fleuron-install: Fleuron <version> installer for Windows (x64)
fleuron-install: install location: C:\Users\<you>\AppData\Local\Fleuron
fleuron-install: checking the release checksum list ... ok
fleuron-install: downloading Fleuron_<version>_x64-setup.exe ...
<curl progress bar>
fleuron-install: SHA-256 matches the pinned release value ... ok
fleuron-install: running the verified setup file for this Windows account (no administrator rights) ...
fleuron-install: installed Fleuron <version> to C:\Users\<you>\AppData\Local\Fleuron
fleuron-install: done. Open Fleuron from the Start menu. Later updates arrive through Fleuron's built-in updater.
```
Running it again when Fleuron is current prints:
`fleuron-install: Fleuron <version> is already installed at <path>; nothing to do.`
Upgrades normally arrive through the in-app updater; rerunning the newest installer also upgrades.

**Uninstall:** download the installer again with line 1, then run `& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "$env:USERPROFILE\fleuron-install-windows.ps1" --uninstall`. Studies in `%USERPROFILE%\Fleuron` are kept. You can also remove Fleuron from **Settings → Apps → Installed apps**.

**Exit codes (PowerShell installer):**

| Code | What it means | What to do |
| --- | --- | --- |
| `0` | Installed, already current, newer already installed, or uninstall done | Open Fleuron from the Start menu |
| `2` | Usage error, a file path was passed, or the file is not a release copy | Run without a file path; download `install-windows.ps1` with line 1 |
| `3` | Unsupported (not Windows, Windows older than 10 version 1809, PowerShell older than 5.1, `curl.exe` missing, non-x64 processor, or run as administrator) | Run from a normal PowerShell window on Windows 11 x64, or use option A |
| `4` | Fleuron is running | Quit Fleuron and run the installer again |
| `5` | Existing install cannot be managed safely (installed for all users by IT, a different app named Fleuron, a linked folder, or a folder you cannot write) | Ask whoever installed it |
| `10` | Download failed or was cut off | Check your connection and retry; every release from v2.11.2 onward carries the PowerShell installer, so a 404 means the download is unavailable right now — use option A |
| `20` | `SECURITY STOP` — checksum mismatch | Stop. Do not retry from another website. File an install issue |
| `30` | `POLICY STOP` — Smart App Control, S mode, an organization policy, Microsoft Defender, or an unexpected internet mark blocked the install | Stop. Follow the message. Do not change security settings for Fleuron; on a managed PC contact IT |
| `50` | Setup or uninstall failed | Retry once or use option A; file an install issue with the full output |

Code `40` is macOS-only: a Windows setup file without a publisher signature has no identity Windows can verify, so the pinned SHA-256 is the identity check.

## Stop here if…

| You see | What it means | What to do |
| --- | --- | --- |
| macOS says the app is **damaged**, or “will damage your computer”, or a malware alert | Not the ordinary unsigned warning | Stop. Delete the download. Compare the SHA-256 digest below; if an official re-download repeats it, [file an install issue](https://github.com/wilsonhyeh/fleuron/issues/new?template=install-help.yml) from a safe device |
| The Terminal or PowerShell installer prints SECURITY STOP | The file or app did not match the official release | Stop. Do not run it again from any other source. File an install issue with the full output |
| The PowerShell installer prints POLICY STOP | Smart App Control, S mode, Microsoft Defender, or your organization's policy blocks unrecognized apps on this PC | Stop. Follow the message. Do not change security settings for Fleuron; on a managed PC contact IT and share [docs/IT-DEPLOYMENT.md](IT-DEPLOYMENT.md) |
| Microsoft Defender reports a threat or quarantines the installer | Real security signal pending investigation | Stop. Do not restore or allow the file. Save the exact warning text and file an issue |
| A UAC / administrator prompt appears during install | Fleuron installs per-user; this should never happen | Cancel. Do not enter credentials. File an install issue |
| **Smart App Control** blocks the app | No per-app bypass exists | Stop. Do not disable Smart App Control |
| Windows **S mode** blocks installation | S mode runs Store apps only | Stop. Fleuron does not support S mode and we will not suggest switching out of it |
| WDAC / AppLocker / managed policy blocks the app | Organization-controlled device | Contact IT and share [docs/IT-DEPLOYMENT.md](IT-DEPLOYMENT.md) |
| PowerShell says the script "is not digitally signed" or "cannot be loaded" | That copy was downloaded another way (for example, by a web browser) and Windows marked it as coming from the internet | Delete it and download it with line 1 of option B. Do not unblock it or change the execution policy |
| PowerShell says running scripts is disabled by Group Policy | Your organization controls PowerShell on this PC | Use option A, or contact IT. Do not change the execution policy |

## File access troubleshooting

- New studies default to `~/Fleuron` (macOS) or `%USERPROFILE%\Fleuron` (Windows), which avoids protected Documents/Desktop folders.
- macOS may ask once about Documents/Desktop/Downloads/network or removable volumes **because you selected such a location yourself**. Allow, or cancel and choose another folder. Fleuron never requests Full Disk Access.
- If macOS Files & Folders access was denied by mistake: System Settings → Privacy & Security → Files and Folders → Fleuron → enable what you chose. Deleting data was never involved — Fleuron simply could not read there.
- **Controlled Folder Access** (Windows) blocked a save into a protected folder? Choose another folder; the default `%USERPROFILE%\Fleuron` is outside protected folders. Never disable CFA.

## WebView2 (rare)

Windows 11 normally includes WebView2. Fleuron never downloads, bundles, or repairs it. If it is missing or damaged, use Microsoft’s official Evergreen Runtime guidance — managed devices contact IT.

## Advanced verification

Optional steps for the disk-image and setup-file paths. The Terminal and PowerShell installers (option B) perform the SHA-256 check for you.

```bash
# GitHub's per-asset digest, visible on the release page:
shasum -a 256 Fleuron_<version>_universal.dmg
```

Verify against the published `SHA256SUMS.txt` on the release page:

```bash
gh release download v<version> --repo wilsonhyeh/fleuron --dir .
shasum -a 256 -c SHA256SUMS.txt
```

Artifact attestation proves which public repository, workflow, and commit produced each asset:

```bash
gh attestation verify Fleuron_<version>_universal.dmg --repo wilsonhyeh/fleuron
```

On Windows (PowerShell):

```powershell
Get-FileHash .\Fleuron_<version>_x64-setup.exe -Algorithm SHA256
gh attestation verify .\Fleuron_<version>_x64-setup.exe --repo wilsonhyeh/fleuron
```

These checks help verify file integrity and build provenance. They do not establish software safety or replace an OS publisher identity.

## Troubleshooting & diagnostics

If you encounter unexpected behavior or errors:

1. **In-app diagnostic report:** If Fleuron launches, open **About → Generate diagnostic report**. You can preview the full plain-text report, copy it, or save it to a file. It is designed to include allowlisted installation and sync metadata rather than study content. Review the entire report before sharing; do not include transcripts, participant identifiers, code names, credentials, or personal file paths.
2. **External read-only probe:** If the application fails to launch at all, run the standalone diagnostic probe from the `support/` directory in the repository:
   - macOS: `bash support/fleuron-probe.sh --output fleuron-diag.txt`
   - Windows: `powershell -NoProfile -File support\Get-FleuronProbe.ps1 -OutputFilePath fleuron-diag.txt`
   Both probes are strictly read-only and never modify your system or study files.

## Still stuck?

[Open an install-help issue](https://github.com/wilsonhyeh/fleuron/issues/new?template=install-help.yml). Do not attach transcripts, quotes, participant/study identifiers, project databases, tokens, or unredacted crash logs/screenshots.
