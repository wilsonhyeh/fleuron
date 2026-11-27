# Signing activation runbook (maintainer checklist)

A future release may add a **personal** Apple Developer ID / notarization and/or a Windows Authenticode certificate. This page is the activation checklist for that day — it deliberately contains no pipeline, no secrets handling, and no institutional/organization routes.

## macOS — Apple Developer ID + notarization

Prerequisite: personal Apple Developer Program membership is active.

- [ ] Create a Developer ID Application certificate in Xcode/account portal
- [ ] Replace `signingIdentity: "-"` with the real identity name
- [ ] Do **not** add hardened runtime — it is already on. `bundle.macOS.hardenedRuntime` defaults to `true`, and the shipped ad-hoc signature already carries the flag (`codesign -dvv Fleuron.app` reports `flags=…runtime`). After signing, the only task is to confirm it survived (`codesign -dvv` still lists `runtime`); there is nothing to enable and nothing new to declare.
- [ ] Notarize + staple: `xcrun notarytool submit` then `xcrun stapler staple`
- [ ] Fix every gate below in the same change. They are hard assertions, not warnings, and the first real identity fails all of them:
  - [ ] `node --test scripts/release-contract.test.mjs` — `mac packaging contract: ad-hoc identity, bound plist, minimum 10.15` asserts `signingIdentity === "-"`. Change it to the real identity; keep the `infoPlist` and `minimumSystemVersion` assertions.
  - [ ] `bash scripts/verify-mac-bundle.sh` — requires `Signature=adhoc` and `TeamIdentifier=not set`. Require `Authority=Developer ID Application`, the real `TeamIdentifier`, and turn the recorded `spctl` assessment from "expected reject" into "must pass".
  - [ ] `bash scripts/install-mac.test.sh` — `scripts/install-mac.sh`'s `do_verify_bundle` stops with exit `40` unless `Signature=adhoc` and `TeamIdentifier=not set`. Replace both with the Developer ID authority and real TeamIdentifier, update the mocked `codesign` output the suite serves (`C12`–`C15`), and re-run the suite.
  - [ ] `npm test` — `src/content/trust-and-permissions.test.ts` fails twice:
    - `publisher verification notice › matches the canonical wording exactly` hard-asserts a notice saying this build "does not yet carry an Apple Developer ID/notarization or Windows Authenticode publisher signature". Rewrite `PUBLISHER_VERIFICATION_NOTICE` and that expectation together.
    - `warning response contract › macOS separates expected ordinary warnings from stop conditions` requires an `expected` card whose `userAction` includes "Open Anyway". A notarized build never shows that dialog, so that card must change and the test with it; keep the "damaged / malware" stop card.
  - [ ] The same notice is carried verbatim by `docs/INSTALLING.md` and `README.md`, and asserted by `node --test scripts/release-contract.test.mjs` (`canonical publisher disclosure is carried verbatim by INSTALLING + README`) and by `npm test` (`src/lib/privacy-contract.test.ts` › `publishes the canonical publisher-verification notice verbatim`). Update the source and all three carriers in one commit.
- [ ] Update `docs/INSTALLING.md`: delete the expected-warning section, document zero-warning launch, and re-check the "Stop here if…" table and both exit-code tables (code `40`'s meaning changes; the damaged/malware rows stay).
- [ ] Update `docs/IT-DEPLOYMENT.md` → "Package provenance" (it states no certificate is purchased and the bundle is ad-hoc signed) and `SECURITY.md` → "Security model notes".
- [ ] Update `docs/PRIVACY-AND-PERMISSIONS.md` → "Stored sign-in": Keychain is unused *while builds are ad-hoc signed* because rebuilds change the signature and would re-prompt. Signing removes that reason, so either migrate to Keychain or restate why not.
- [ ] Recapture all macOS screenshots from signed builds before replacing docs imagery
- [ ] Regenerate candidates; rerun the full gate set

## Windows — Authenticode

Prerequisite: an OV or EV code-signing certificate you personally control.

- [ ] Sign both installer and updater archive post-build (`signtool sign /fd SHA256`), with one stable publisher identity release after release.
- [ ] Expect SmartScreen to keep warning at first: **no certificate type buys instant reputation.** Microsoft removed EV's special treatment in 2024 — EV- and OV-signed files now build reputation the same way, from the file hash plus the publisher certificate, over download volume, with no published threshold (weeks and hundreds of clean installs). Paying the EV premium ($400+/yr against roughly $150–300 for OV) solely to avoid SmartScreen is no longer justified; use EV only if some other procurement context demands it. Microsoft's recommended non-Store route is Azure Artifact Signing (formerly Trusted Signing, about $9.99/month; individual developers limited to the US and Canada).
- [ ] Do not promise the warning ends. What signing fixes immediately: the dialog names your verified publisher instead of *Unknown publisher*, and enterprise allowlisting can key on the signing identity.
- [ ] An unsigned release never stops warning: without a signature, reputation cannot carry from one version to the next, so every new build starts at zero. Signing every release with the same identity is the only way it accumulates.
- [ ] Update `docs/INSTALLING.md`'s SmartScreen section and `WINDOWS_WARNING_CARDS` in `src/content/trust-and-permissions.ts` to match observed behavior for signed builds; update the canonical notice too (its single sentence covers both platforms).
- [ ] Extend `scripts/nsis-template.test.mjs`/release-contract tests: fail when a shipping artifact is unsigned once signing is active
- [ ] Recapture SmartScreen screenshots only from signed builds
- [ ] Add a publisher check (`Get-AuthenticodeSignature`) to `scripts/install-windows.ps1`, re-run its suite on windows-latest, and update § 13 of `TERMINAL-INSTALL.md`.

## What must NEVER change, signed or not

- Updater minisign keys and verification stay in place alongside any new signature
- Prohibited-guidance contract tests keep passing (no bypass advice anywhere)
- The publisher-verification notice wording updates to reflect reality — never disappears silently

## Sources for the Windows claims

- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) — EV no longer bypasses SmartScreen; OV and EV build reputation identically; unsigned files rebuild reputation every version.
- [Current status of Windows app distribution features](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status) — status of the 2024 change.
- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) — OV/EV/Artifact Signing comparison and pricing.
