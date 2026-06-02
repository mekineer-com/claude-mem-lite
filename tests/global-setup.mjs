// Vitest globalSetup: reap claude-mem-lite test-fixture dirs leaked into temp by
// prior runs that were interrupted/SIGKILL'd before afterEach could clean up.
// Per-test cleanup cannot survive a hard kill, so we self-heal at the next run's
// start. 1h age guard means an in-flight parallel run is never disturbed.
import { sweepStaleTestFixtures } from '../lib/tmp-fixture-sweep.mjs';

export default function setup() {
  try {
    const { removed } = sweepStaleTestFixtures();
    if (removed > 0 && process.env.MEM_TEST_SWEEP_VERBOSE === '1') {
      console.log(`[test-setup] reaped ${removed} stale fixture dir(s)`);
    }
  } catch { /* never block the suite on cleanup */ }
}
