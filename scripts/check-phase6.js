import { spawnSync } from 'node:child_process';
const files = [
  'src/core/support.js',
  'src/services/support-repository.js',
  'src/services/support-operations.js',
  'src/services/support-agent.js',
  'src/services/support-event-handlers.js',
  'src/services/command-center.js',
  'public/command-center.js',
  'scripts/support-fixture.js',
  'scripts/support-ui-check.js',
  'scripts/support-cross-repo-e2e.js',
];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`Phase 06 syntax: ${files.length} files PASS`);
