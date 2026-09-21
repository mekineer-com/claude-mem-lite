// lib/doctor-modes.mjs — the DB-layer `doctor` modes, in one place.
//
// `doctor` is one command name with two implementations: install.mjs's health check, which
// owns `--json`, and cli/doctor.mjs's DB-layer modes. cli.mjs decides between them by looking
// for one of these flags, and its comment used to say so with a warning attached — "Adding a
// NEW DB-layer mode requires extending this list — a deliberate trade for a working --json".
// A mode added to cli/doctor.mjs and not to that list is answered silently by the install
// check instead, which is a command answering as a different command.
//
// Three consumers now read this instead of spelling the list:
//   cli.mjs      — the router condition
//   install.mjs  — the pointer plain `doctor` prints, so the modes are discoverable at all
//   tests/doctor-mode-router-sync.test.mjs — pins it against what cli/doctor.mjs implements
//
// A zero-dependency leaf on purpose. install.mjs is a recovery path and must not import
// anything that drags a load graph behind it (the lesson lib/data-paths.mjs exists for).
export const DOCTOR_DB_MODES = ['benchmark', 'metrics', 'session-audit'];

/**
 * The modes as PROSE — `--benchmark, --metrics or --session-audit`.
 *
 * Not `a | b | c`. A line shaped like a command invites a copy-paste, and `|` is a shell
 * pipe: pasting the first draft produced `bash: --metrics: command not found`. That is the
 * same defect 32c8923 fixed one commit earlier in this branch (a remedy that named a binary
 * which could not run), reintroduced two commits later in a different spelling. The wording
 * around it has to make clear this is a list of options, not a command line.
 */
export function doctorDbModeHint() {
  const flags = DOCTOR_DB_MODES.map((m) => `--${m}`);
  return `${flags.slice(0, -1).join(', ')} or ${flags[flags.length - 1]}`;
}
