import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {migrateDatabase} from '../src/migrations.js';
import {verifyCustomerPortal} from '../scripts/customer-portal-verify.js';

test('customer portal authenticates the WhatsApp owner, isolates data, records privacy choices and reuses the Core checkout with rollback',async()=>{
  const pg=new PGlite({extensions:{pgcrypto}}),adapter=pg=>({query:async(sql,params)=>{const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await pg.exec(sql)).at(-1):await pg.query(sql,params);return {...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};}});
  const db={...adapter(pg),transaction:fn=>pg.transaction(tx=>fn(adapter(tx)))};
  const config={PAYMENT_MODE:'simulation',WHATSAPP_MODE:'simulation',BITPANEL_MODE:'disabled'};
  const env={...config,RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',RAILWAY_ENVIRONMENT_ID:'3f3188fb-0289-4f4d-93b9-574cfe1505f5',GATE_TEST_MODE:'true',PROVIDER_MODE:'fake-only'};
  try {await migrateDatabase(db);await db.query(`INSERT INTO plans(code,name,duration_months,price_cents,sort_order) VALUES('monthly','Mensal',1,3000,1),('annual','Anual',12,27000,4)`);
    const report=await verifyCustomerPortal({db,config,env});assert.equal(report.realProviderCalls,0);assert.equal(report.rolledBack,true);assert.equal(report.syntheticCheckouts,1);
    for(const patch of [{RAILWAY_ENVIRONMENT_ID:'697f58fb-5084-4cb3-bd9a-ecdbc921b7bc'},{PROVIDER_MODE:'live'},{PAYMENT_MODE:'live'}])await assert.rejects(verifyCustomerPortal({db:{},config,env:{...env,...patch}}),assert.AssertionError);
  }finally{await pg.close();}
});
