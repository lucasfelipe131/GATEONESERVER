import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createDb, getSetting, setSetting } from '../src/db.js';
import { getRuntimeConfig, saveBitPanelStorageState } from '../src/integrations/runtime-config.js';
import { testBitPanelConnection } from '../src/integrations/bitpanel.js';
import { CustomerAccessSync } from '../src/services/customer-access-sync.js';

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
  const subjects = (await db.query(`SELECT count(*)::int AS eligible FROM customers c
    JOIN subscriptions s ON s.customer_id=c.id WHERE c.automation_eligible=true
    AND c.bitpanel_owner IN ('GATE ONE PRO SERVER','GATE ONE SERVER') AND s.bitpanel_list_id IS NOT NULL`)).rows[0].eligible;
  let policy = await getSetting(db,'automatic_renewal_policy',null);
  if (activate) {
    const now=new Date().toISOString();
    policy={enabled:true,activatedAt:policy?.enabled === true ? policy.activatedAt : now,
      validatedAt:now,validatedSource:'https://bitpanel.vip/list',provider:'mercadopago',operation:'renew',
      planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,plans};
    await db.transaction(async client=>{
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
      connection:connection.ok,eligibleCustomers:subjects,access,realTestCharges:0,realTestMessages:0,realTestRenewals:0}));
  } else {
    console.log(JSON.stringify({validated:true,sha:expectedSha,connection:connection.ok,eligibleCustomers:subjects,
      policyEnabled:policy?.enabled === true,plans:4,realTestCharges:0,realTestMessages:0,realTestRenewals:0}));
  }
} finally { await db.close(); }
