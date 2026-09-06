import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createOutboxFailpoint } from '../src/core/outbox-failpoint.js';

const env={GATE_ENVIRONMENT:'staging-055',GATE_TEST_MODE:'true',PROVIDER_MODE:'fake-only',
  OUTBOX_FAILPOINT_AFTER_EFFECT_BEFORE_ACK:'true',OUTBOX_FAILPOINT_CORRELATION_ID:'target',OUTBOX_FAILPOINT_EVENT_TYPE:'renewal.ready'};
test('failpoint disabled by default',()=>assert.equal(createOutboxFailpoint({}),null));
for(const key of ['GATE_ENVIRONMENT','GATE_TEST_MODE','PROVIDER_MODE','OUTBOX_FAILPOINT_CORRELATION_ID','OUTBOX_FAILPOINT_EVENT_TYPE']) {
  test(`failpoint fails closed without ${key}`,()=>assert.throws(()=>createOutboxFailpoint({...env,[key]:''}),/GUARD_FAILED/));
}
test('failpoint ignores replay and unrelated events',()=>{
  const hook=createOutboxFailpoint(env);
  hook({event:{correlation_id:'other'},consumed:{processed:true}});
  hook({event:{correlation_id:'target',event_type:'renewal.ready'},consumed:{processed:false}});
});
test('failpoint terminates real child with SIGKILL before ACK',()=>{
  const code=`import {createOutboxFailpoint} from './src/core/outbox-failpoint.js';
    createOutboxFailpoint(${JSON.stringify(env)})({event:{event_id:'E1',correlation_id:'target',event_type:'renewal.ready'},consumer:'stable',workerId:'A',consumed:{processed:true}});
    console.log('ACK_MUST_NOT_HAPPEN');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});
  assert.equal(result.signal,'SIGKILL');
  assert.match(result.stdout,/COMMITTED_BEFORE_ACK/);
  assert.doesNotMatch(result.stdout,/ACK_MUST_NOT_HAPPEN/);
});
