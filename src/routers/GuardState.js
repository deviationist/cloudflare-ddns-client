import { readFileSync, writeFileSync, existsSync } from 'fs';

// Tiny persistence for the router guard's last verdict, so notification emails
// fire only on a state transition (e.g. healthy -> failover) rather than on
// every cron run while the state persists. No state file configured -> no dedup
// store, and (by design) no transition emails.
export function readGuardState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch (e) {
    return null;
  }
}

export function writeGuardState(stateFile, state) {
  if (!stateFile) return;
  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    /* best-effort; never block a DNS run on state persistence */
  }
}
