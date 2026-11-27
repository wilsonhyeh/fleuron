# Session Log

Running history of significant work sessions in this repo. Short entries only:
date, what was done, gate results, what remains blocked. Release-grade evidence
lives in `qa/`; this file is just a pointer-level memory.

// (Note: repo has no `write` tool for edits — this file was created 2026-09-06;
// append new entries at the bottom, newest last.)

## 2026-09-06 — Note-reliability implementation finished, all gates green

Continued the HQ plan `fleuron-next-release-reliability` (private local draft
recovery, revision-safe saves, one inline editor, departure/export guards,
focused polish). Prior sessions had built the feature tree; this session:

- Fixed the single failing unit test (`project-store.test.ts` "hydrates the
  workspace atomically"): the new same-path `openProject` no-op (reopening the
  already-open study returns early so it can't rotate the workspace epoch and
  strand drafts) meant the test had to start from `project: null` before
  opening. Convention: same-path reopen is intentionally a no-op; tests that
  exercise hydration must start closed.
- Deleted leftover debug probe `e2e/debug-note-begin.spec.ts`.
- Ran every gate green: `tsc` 0; `npm test` 56 files / 453 passed; `npm run
  build` ok; `npm run test:e2e` 54 passed (incl. `note-draft-lifecycle` 13/13);
  `cargo fmt --check` 0; `clippy -D warnings` 0; fuzz-budget `cargo test` 301
  passed; `release-contract` 55 passed; Supabase migration guards + ps1-ascii
  passed; fresh `tauri build --debug` + `run-selftest` passed (note suites
  14–17); macOS debug binary launched and quit cleanly.
- Evidence: `qa/note-reliability/VERIFICATION.md` + refreshed `fuzz-3600.log`
  and `selftest-debug.log`. Plan task statuses updated in the HQ plan file
  (six implementation tasks complete, verification in-progress).
- Blocked (no Windows access, no real updater install, release out of scope):
  Windows close/Alt+F4 rows, real updater install, forced-kill crash test,
  `RELEASE-SMOKE.md` untouched, `verify-release-smoke.mjs --final` not run.
- Version bumped to 2.6.0 across manifests and docs; release commit and tag v2.6.0 pushed.

## 2026-09-06 — Fleuron 2.7.0: Study lifecycle, guided setup, speaker management

Implemented HQ plan `fleuron-project-lifecycle.md` across Tauri Rust core, React frontend, and production Supabase backend:

- Guided setup flow: 4-step wizard with non-blocking "Finish setup later" and journal persistence in study file.
- Whole-interview speaker management: "Manage Speakers" modal with turn/coded stats, full-interview renames, and merges with rollback.
- Trash-only deletion & lifecycle safety: removed hard unlinks; delete moves study to OS Trash/Recycle Bin; guarded sole-member leave and multi-member deletion.
- Applied Supabase migration `20260906000000_study_lifecycle_guards.sql` to production database.
- Fixed macOS dock reopen behavior when all windows are closed.
- Version bumped to 2.7.0 across manifests, lockfiles, release smoke, and trust documentation.

## 2026-10-25 — Fleuron 2.8.0: save workflow, single-user focus

- File > Save (Cmd/Ctrl+S), toolbar save status, "where is my work saved" panel, passage-note autosave, "Unsaved notes" wording, participant ID from file name, workspace declutter.
- Fixed: macOS Quit skipped the unsaved-notes guard; note keystrokes hijacked by passage shortcuts; Add a note dead in new studies; hour dropped from timestamps; Settings sign-in flash.
- Collaboration shelved behind `COLLABORATION_ENABLED` (`src/lib/features.ts` + `src-tauri/src/lib.rs`); collaboration e2e cases and the online selftest suite skip while it is off.
- Version bumped to 2.8.0 across manifests, lockfiles, release smoke, install docs, and trust documentation.

## 2026-10-26 — Fleuron 2.9.0: UI polish pass

Shipped the ranked UI review on branch `ui-consistency-pass` (e6dbc5d, 3717ba2,
e57bceb, 13150a3, 288e405): one control style and real CSS tokens; one coding
mark plus the side bar; codebook at real name lengths with parent totals that
count each passage once (computed `rollup_count`, no schema change); one chip
per code per passage; reading header tidy; coding bubble with fixed ⌘1–⌘9; new
code palette; lighter frame. No Supabase migration. Gates listed in
`RELEASE-SMOKE.md` § 21.

## 2026-10-26 — Fleuron 2.10.0: relationship map and family colours

Shipped branch `relationship-map` (25b2703, b79ccee, dda5c6b): a live map of
code co-occurrence beside the transcript with Network, Timeline and Structure
views (`src/components/RelationshipMap.tsx`, builders in
`src/lib/relationship-map.ts`, a dependency-free force layout in
`src/lib/force-layout.ts`); Colour codes by family, on by default and display
only (`withFamilyColors`, `useDisplayCodes`), so stored colours are never
rewritten; codebook hide button, page inset and review control polish. New
`family_colors` preference with a serde default; no schema change, no Supabase
migration. Gates listed in `RELEASE-SMOKE.md` § 22.

## 2026-10-26 — Fleuron 2.11.0: reading header

Shipped branch `reading-header` (fe4185c): the interview name became one menu
(`src/components/InterviewMenu.tsx`) holding the interview list, review count
and interview actions; review progress as a header hairline; search, filter and
text size (`src/components/TextSizeButton.tsx`) as matching icon buttons;
toolbar title uncapped and "coding as" shown only with 2+ coders; Structure map
centre wraps the title (`src/lib/wrap-lines.ts`). Frontend only; no schema
change, no Supabase migration.

## 2026-11-27 — Fleuron 2.11.1: terminal installers shipped

Shipped the macOS Terminal installer (`scripts/install-mac.sh`, its renderer,
mock suite and the `C1`-`C27` cases) and the Windows PowerShell installer
(`scripts/install-windows.ps1`, renderer, contract suite, mocked `pwsh` suite),
wired into `.github/workflows/test.yml` and `release.yml` (render + pin-check,
upload inside the draft release, `SHA256SUMS.txt`, `actions/attest` subject
checksums), with `docs/INSTALLING.md` rewritten around option A / option B and
`docs/maintainers/TERMINAL-INSTALL.md` recording the design, threat models and
unverified-on-Windows status.

Three defects fixed on the way: both `curl` calls in `install-mac.sh` now pass
`--proto-redir '=https'` so a redirect cannot downgrade the download to plain
http (the Windows installer already did; the mock `curl` now refuses to serve
without it, and `C27`/`C27-MUT` fail if it disappears); the README's download
table uses the version-agnostic `Fleuron_<version>_*` form instead of the stale
`2.1.0` names (`docs/IT-DEPLOYMENT.md` had a stale `2.0.1` name); and the
transcript panel's "How to fix access" link targets
`#file-access-troubleshooting`, which is the guide's real heading.

Gates: tsc clean; vitest 514/514; install-mac suite 33/33; windows installer
contract 22/22; release-contract 61/61; workflow-shell 75 blocks clean; ps1
ASCII clean; sync-version --check clean. Nothing was executed on macOS or
Windows: the first real runs are the `v2.11.1` release workflow's
`windows-latest` leg and RELEASE-SMOKE § 24.
