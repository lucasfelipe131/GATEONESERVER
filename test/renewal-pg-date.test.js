import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgRenewalRepository } from '../src/services/renewal-orchestration.js';
test('renewal repository preserves PostgreSQL DATE as calendar strings',async()=>{
 const db={async query(sql){const cast=sql.includes('target_expiration::text');return {rows:[{
  previous_expiration:cast?'2026-09-06':pg.types.getTypeParser(1082)('2026-09-06'),
  target_expiration:cast?'2026-10-06':pg.types.getTypeParser(1082)('2026-10-06')
 }]};}};
 const result=await new PgRenewalRepository(db).get('id');
 assert.equal(result.target_expiration,'2026-10-06');
 assert.equal(result.previous_expiration,'2026-09-06');
});
