import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb, getSetting, setSetting } from '../src/db.js';
import { getRuntimeConfig, saveBitPanelStorageState } from '../src/integrations/runtime-config.js';
import { testBitPanelConnection } from '../src/integrations/bitpanel.js';
import { CustomerAccessSync } from '../src/services/customer-access-sync.js';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
// Administrator console only. No payment, renewal, provisioning or WhatsApp actuator.
assert.equal(process.env.RAILWAY_PROJECT_ID, 'a0f107fe-acaf-459f-a640-38ef6010d1e5');
assert.equal(process.env.RAILWAY_ENVIRONMENT_ID, '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc');
const expectedSha = process.argv[2];
assert.match(expectedSha || '', /^[a-f0-9]{40}$/);
assert.equal(process.env.RAILWAY_GIT_COMMIT_SHA, expectedSha);
const activate = process.argv.includes('--activate');
const config = loadConfig();
const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
try {
  const schema = await db.query("SELECT to_regclass('customer_access_sync') AS access_table");
  assert.ok(schema.rows[0].access_table, 'Customer access migration is required');
  let preflight = await assertCustomerHubActivationPreflight(db);
  const runtime = { ...await getRuntimeConfig(db, config),
    saveBitPanelStorageState: state => saveBitPanelStorageState(db, config, state) };
  assert.ok(runtime.BITPANEL_STORAGE_STATE, 'Fresh protected session is required');
  const connection = await testBitPanelConnection(runtime);
  assert.equal(connection.ok, true);
  const plans = {};
  const mapping = [['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]];
  for (const [code,months,price] of mapping) {
    const result = await db.query('SELECT duration_months,price_cents FROM plans WHERE code=$1 AND active=true',[code]);
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].duration_months,months);
    assert.equal(result.rows[0].price_cents,price);
    plans[code]={durationMonths:months,priceCents:price,creditCost:months};
  }
  let policy = await getSetting(db,'automatic_renewal_policy',null);
  if (activate) {
    const now=new Date().toISOString();
    policy={enabled:true,activatedAt:policy?.enabled === true ? policy.activatedAt : now,
      validatedAt:now,validatedSource:'https://bitpanel.vip/list',provider:'mercadopago',operation:'renew',
      planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,plans};
    await db.transaction(async client=>{
      preflight = await assertCustomerHubActivationPreflight(client,{lock:true});
      await setSetting(client,'renewal_requires_approval',true);
      await setSetting(client,'bitpanel_mode','live');
      await setSetting(client,'automatic_renewal_policy',policy);
      await setSetting(client,'bitpanel_read_sync_enabled',true);
      const existing=await getSetting(client,'customer_help_catalog',{});
      const date=new Date().toISOString();
      const apps=[{device:'Samsung',name:'SmartOne IPTV',url:'https://smartone-iptv.com/',sourceUrl:'https://smartone-iptv.com/',verifiedAt:date},
        {device:'LG',name:'SmartOne IPTV',url:'https://smartone-iptv.com/',sourceUrl:'https://smartone-iptv.com/',verifiedAt:date}];
      await setSetting(client,'customer_help_catalog',{...existing,suggestedApps:apps,
        telegram:{channelUrl:'https://t.me/+OkM9So6d9npjODRh',verifiedAt:date,sourceUrl:'https://bitpanel.vip/'}});
    });
    const sync=new CustomerAccessSync({db,config,runtimeConfig:async()=>runtime});
    await sync.syncInformation(runtime,{maxDurationMs:30000});
    const access=await sync.sync({limit:5,maxDurationMs:90000});
    console.log(JSON.stringify({activated:true,sha:expectedSha,activatedAt:policy.activatedAt,
      connection:connection.ok,eligibleCustomers:preflight.eligibleCustomers,
      pendingHumanApprovedRenewals:preflight.pendingHumanApprovedRenewals,access,realTestCharges:0,realTestMessages:0,realTestRenewals:0}));
  } else {
    console.log(JSON.stringify({validated:true,sha:expectedSha,connection:connection.ok,eligibleCustomers:preflight.eligibleCustomers,
      pendingHumanApprovedRenewals:preflight.pendingHumanApprovedRenewals,
      policyEnabled:policy?.enabled === true,plans:4,realTestCharges:0,realTestMessages:0,realTestRenewals:0}));
  }
} finally { await db.close(); }
}
