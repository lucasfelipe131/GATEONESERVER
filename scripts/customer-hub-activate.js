import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb, getSetting, setSetting } from '../src/db.js';
import { getRuntimeConfig } from '../src/integrations/runtime-config.js';
import { assertCustomerHubReadProofEnvironment, assertCustomerHubReadProofReady, runCustomerHubReadProof, customerHubReadProofErrorCode } from './customer-hub-read-proof.js';

const failedReports=new WeakMap();
const activationErrors=new Set(['PAYMENT_MODE_MUST_BE_LIVE','AUTOMATIONS_MUST_BE_UNPAUSED',
  'BITPANEL_MODE_MUST_BE_DISABLED_OR_LIVE','GLOBAL_RENEWAL_APPROVAL_MUST_REMAIN_REQUIRED',
  'PENDING_HUMAN_APPROVED_RENEWALS_BLOCK_LIVE_TRANSITION','ACTIVATION_SETTINGS_CHANGED','ACTIVATION_POSTCHECK_FAILED']);

export function customerHubActivationFailureReport(error) {
  const proofCode=customerHubReadProofErrorCode(error);
  const assertionCode=error?.message?.split('\n')[0];
  const errorCode=proofCode!=='READ_PROOF_UNAVAILABLE' ? proofCode :
    activationErrors.has(assertionCode) ? assertionCode : 'ACTIVATION_UNAVAILABLE';
  return {...(failedReports.get(error) || {}),activated:false,validated:false,errorCode,
    realTestCharges:0,realTestMessages:0,realTestRenewals:0};
}

export async function assertCustomerHubActivationPreflight(db, { lock = false } = {}) {
  // Match the worker's policy/runtime lock order. The final check and settings
  // update share one short transaction; no browser runs while these locks exist.
  if (lock) await db.query("SELECT value FROM system_settings WHERE key='automatic_renewal_policy' FOR UPDATE");
  const rows = (await db.query(`SELECT key,value FROM system_settings
    WHERE key IN ('payment_mode','global_pause','bitpanel_mode','renewal_requires_approval')${lock ? ' FOR UPDATE' : ''}`)).rows;
  const settings = Object.fromEntries(rows.map(row => [row.key,row.value]));
  assert.equal(settings.payment_mode, 'live', 'PAYMENT_MODE_MUST_BE_LIVE');
  assert.equal(settings.global_pause, false, 'AUTOMATIONS_MUST_BE_UNPAUSED');
  assert.ok(['disabled','live'].includes(settings.bitpanel_mode), 'BITPANEL_MODE_MUST_BE_DISABLED_OR_LIVE');
  assert.equal(settings.renewal_requires_approval, true, 'GLOBAL_RENEWAL_APPROVAL_MUST_REMAIN_REQUIRED');
  if (lock && settings.bitpanel_mode === 'disabled')
    await db.query('LOCK TABLE renewal_jobs IN SHARE ROW EXCLUSIVE MODE');
  const pendingHumanApprovedRenewals = (await db.query(`SELECT count(*)::int AS pending FROM renewal_jobs
    WHERE status IN ('awaiting_approval','queued') AND (core_status='READY' OR core_status IS NULL)
      AND approved_at IS NOT NULL AND attempts=0`)).rows[0].pending;
  if (settings.bitpanel_mode === 'disabled')
    assert.equal(pendingHumanApprovedRenewals, 0, 'PENDING_HUMAN_APPROVED_RENEWALS_BLOCK_LIVE_TRANSITION');
  const eligibleCustomers = (await db.query(`SELECT count(*)::int AS eligible FROM customers c
    JOIN LATERAL (SELECT bitpanel_list_id FROM subscriptions WHERE customer_id=c.id
      ORDER BY created_at DESC,id DESC LIMIT 1) s ON true
    WHERE c.automation_eligible IS TRUE AND c.bitpanel_reference IS NOT NULL AND trim(c.bitpanel_reference)<>''
      AND regexp_replace(lower(normalize(c.bitpanel_owner,NFD)),'[^a-z0-9]','','g') IN ('gateoneproserver','gateoneserver')
      AND s.bitpanel_list_id ~ '^[0-9]{1,20}$'`)).rows[0].eligible;
  return { bitpanelMode:settings.bitpanel_mode,eligibleCustomers,pendingHumanApprovedRenewals };
}

export async function runCustomerHubActivation({db,config,expectedSha,env=process.env,activate=false,
  runtimeConfig=client=>getRuntimeConfig(client || db,config),now=()=>new Date(),proofOptions={}}={}) {
  // A fresh, process-local proof is required for every invocation, including reruns.
  // All browser work and read-cache writes finish before the short live transaction.
  assertCustomerHubReadProofEnvironment({env,expectedSha});
  let preflight=await assertCustomerHubActivationPreflight(db);
  const previousPolicy=await getSetting(db,'automatic_renewal_policy',null);
  const proof=await runCustomerHubReadProof({...proofOptions,db,config,runtimeConfig:()=>runtimeConfig(db),
    now,env,expectedSha,cacheContent:true});
  const report=()=>({activated:false,validated:false,sha:expectedSha,proof,
    eligibleCustomers:preflight.eligibleCustomers,pendingHumanApprovedRenewals:preflight.pendingHumanApprovedRenewals,
    realTestCharges:0,realTestMessages:0,realTestRenewals:0});
  if(proof.proved!==true) return report();
  try {
    await assertCustomerHubReadProofReady({db,config,proof,expectedSha,env,runtimeConfig:()=>runtimeConfig(db),now,requireBalance:activate});
    if(!activate) return {...report(),validated:true,policyEnabled:previousPolicy?.enabled===true};
    let policy;
    await db.transaction(async client=>{
      const finalPreflight=await assertCustomerHubActivationPreflight(client,{lock:true});
      assert.equal(finalPreflight.bitpanelMode,preflight.bitpanelMode,'ACTIVATION_SETTINGS_CHANGED');
      const currentPolicy=await getSetting(client,'automatic_renewal_policy',null);
      assert.deepEqual(currentPolicy,previousPolicy,'ACTIVATION_SETTINGS_CHANGED');
      // Keep credential updates and plan changes out of the final verification/write window.
      await client.query('LOCK TABLE integration_credentials IN SHARE MODE');
      await client.query('SELECT provider FROM integration_credentials FOR SHARE');
      const verified=await assertCustomerHubReadProofReady({db:client,config,proof,expectedSha,env,
        runtimeConfig:()=>runtimeConfig(client),now,lock:true,requireBalance:true});
      const cutoff=now().toISOString();
      // A new cutoff also excludes payments received while the provider was disabled.
      // Re-running --activate is conservative even when an old policy is still enabled.
      policy={enabled:true,activatedAt:cutoff,validatedAt:verified.validatedAt,
        validatedSource:verified.sourceUrl,validatedSha:expectedSha,provider:'mercadopago',operation:'renew',
        planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,plans:verified.plans};
      await setSetting(client,'renewal_requires_approval',true);
      await setSetting(client,'bitpanel_read_sync_enabled',true);
      await setSetting(client,'automatic_renewal_policy',policy);
      await setSetting(client,'bitpanel_mode','live');
      assert.equal(await getSetting(client,'renewal_requires_approval',null),true,'ACTIVATION_POSTCHECK_FAILED');
      assert.equal(await getSetting(client,'bitpanel_read_sync_enabled',null),true,'ACTIVATION_POSTCHECK_FAILED');
      assert.equal(await getSetting(client,'bitpanel_mode',null),'live','ACTIVATION_POSTCHECK_FAILED');
      assert.deepEqual(await getSetting(client,'automatic_renewal_policy',null),policy,'ACTIVATION_POSTCHECK_FAILED');
      await assertCustomerHubReadProofReady({db:client,config,proof,expectedSha,env,
        runtimeConfig:()=>runtimeConfig(client),now,lock:true,requireBalance:true});
      preflight=finalPreflight;
    });
    return {...report(),activated:true,validated:true,activatedAt:policy.activatedAt,validatedAt:policy.validatedAt};
  } catch(error) {
    if(error && typeof error==='object') failedReports.set(error,report());
    throw error;
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    const expectedSha=process.argv[2];
    assertCustomerHubReadProofEnvironment({expectedSha});
    const config=loadConfig();
    db=createDb(config.DATABASE_URL,{ssl:config.DATABASE_SSL});
    const report=await runCustomerHubActivation({db,config,expectedSha,activate:process.argv.includes('--activate')});
    console.log(JSON.stringify(report));
    if(!report.validated) process.exitCode=1;
  } catch(error) {
    console.log(JSON.stringify(customerHubActivationFailureReport(error)));
    process.exitCode=1;
  } finally {if(db) await db.close().catch(()=>{process.exitCode=1;});}
}
