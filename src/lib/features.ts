/**
 * Collaboration — accounts, groups and sync — is shelved while the
 * single-user experience is finished. With this off, nothing in the UI offers
 * to sign in, share, join or sync, and the app never asks the backend for
 * sync status, so every "is this study in a group?" check reads false and the
 * workspace behaves as a single-user study.
 *
 * The collaboration code stays in place. Turn it back on here and in
 * `COLLABORATION_ENABLED` in src-tauri/src/lib.rs together.
 */
export const COLLABORATION_ENABLED = false;
