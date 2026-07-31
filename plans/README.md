# Development plans

| Number | Title | Severity | Status |
| --- | --- | --- | --- |
| 001 | Unify motion and interaction feedback | HIGH | DONE |
| 002 | Codex CLI session sync (local and SSH) | HIGH | IMPLEMENTING |
| 003 | Keep the desktop pet animation alive | HIGH | DONE |
| 004 | Keep the pet visible and animated across macOS Spaces | HIGH | DONE |
| 005 | Keep every pet preview animation alive | HIGH | DONE |

Plan 002 is the source of truth for the Codex session integration. Execute its
phases in order and do not begin remote-host work before the local lifecycle and
content contracts pass their acceptance gates.

Plan 003 is independent of the Codex transport work and may be implemented in
parallel with the remaining Plan 002 integration phases.

Plan 004 is complete. A genuine native non-activating `NSPanel` survived
forward and reverse Space switches in an isolated runtime smoke test without a
new crash report, while the elapsed-time sprite watchdog remained enabled.

Plan 005 is complete. Today, Pet settings, drag, landing, and the desktop
companion all use elapsed-time animation loops with stable semantic identities.
