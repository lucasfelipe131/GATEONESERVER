import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { runWhatsAppIdentityScan } from '../src/services/whatsapp-identity-scan.js';

const fail = code => Object.assign(new Error(code), { code });
export function assertWhatsAppIdentityScanEnvironment({ env = process.env, expectedSha } = {}) {
  if (env.RAILWAY_PROJECT_ID !== 'a0f107fe-acaf-459f-a640-38ef6010d1e5') throw fail('IDENTITY_SCAN_PROJECT_MISMATCH');
  if (env.RAILWAY_ENVIRONMENT_ID !== '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc') throw fail('IDENTITY_SCAN_ENVIRONMENT_MISMATCH');
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || env.RAILWAY_GIT_COMMIT_SHA !== expectedSha) throw fail('IDENTITY_SCAN_VERSION_MISMATCH');
}

export function parseWhatsAppIdentityScanArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--apply') {
      if (options.mode) throw fail('IDENTITY_SCAN_ARGUMENTS_INVALID');
      options.mode = arg.slice(2);
    } else if (arg === '--expected-sha' || arg === '--audit-digest') {
      const field = arg === '--expected-sha' ? 'expectedSha' : 'expectedAuditDigest';
      if (options[field] || !args[index + 1] || args[index + 1].startsWith('--')) throw fail('IDENTITY_SCAN_ARGUMENTS_INVALID');
      options[field] = args[++index];
    } else throw fail('IDENTITY_SCAN_ARGUMENTS_INVALID');
  }
  if (!options.mode || !/^[a-f0-9]{40}$/.test(options.expectedSha || '') ||
      options.mode === 'apply' && !/^[a-f0-9]{64}$/.test(options.expectedAuditDigest || '')) throw fail('IDENTITY_SCAN_ARGUMENTS_INVALID');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    const options = parseWhatsAppIdentityScanArgs(process.argv.slice(2));
    const assertEnvironment = () => assertWhatsAppIdentityScanEnvironment(options);
    assertEnvironment();
    const config = loadConfig();
    db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
    const report = await runWhatsAppIdentityScan({ db, config, ...options, assertEnvironment });
    console.log(JSON.stringify({ sha: options.expectedSha, ...report }));
    if (report.counts.transactionFailures || report.counts.readFailures || report.counts.snapshotChanged) process.exitCode = 1;
  } catch (error) {
    const code = /^IDENTITY_SCAN_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'IDENTITY_SCAN_UNAVAILABLE';
    console.log(JSON.stringify({ errorCode: code, realMessagesSent: 0, realChargesCreated: 0, realRenewals: 0 }));
    process.exitCode = 1;
  } finally { if (db) await db.close().catch(() => { process.exitCode = 1; }); }
}
