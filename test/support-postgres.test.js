import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase, verifyMigrations } from '../src/migrations.js';
import { PgSupportRepository } from '../src/services/support-repository.js';
import { PgCommandCenter } from '../src/services/command-center.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { fixture } from '../scripts/support-fixture.js';
import { OutboxDispatcher } from '../src/core/outbox.js';
import { createSupportEventHandlers } from '../src/services/support-event-handlers.js';

// PostgreSQL WASM, process-local and ephemeral. No DATABASE_URL or network access.
function adapter(pg) {
  const client = (p) => ({
    query: async (sql, params) => {
      if (!params && /;\s*\S/.test(sql.trim().replace(/;$/, ''))) {
        const results = await p.exec(sql);
        return {
          ...results.at(-1),
          rowCount: results.at(-1)?.affectedRows || 0,
        };
      }
      const r = await p.query(sql, params);
      return { ...r, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    ...client(pg),
    transaction: (fn) => pg.transaction((tx) => fn(client(tx))),
  };
}
test('phase6 PostgreSQL: migrations, repositories, outbox, dedup, human resolution and actual Customer360', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const db = adapter(pg);
  try {
    const first = await migrateDatabase(db);
    assert.equal(first.executed.length, 7);
    assert.equal((await migrateDatabase(db)).executed.length, 0);
    assert.equal((await verifyMigrations(db)).ready, true);
    const customers = [randomUUID(), randomUUID()];
    for (const id of customers)
      await db.query(
        "INSERT INTO customers(id,name,whatsapp_e164) VALUES($1,'Synthetic Phase06',$2)",
        [id, `fake-${id}`],
      );
    const plan = randomUUID();
    await db.query(
      "INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'fake-monthly','Fake',1,1000)",
      [plan],
    );
    for (const id of customers)
      await db.query(
        "INSERT INTO subscriptions(customer_id,plan_id,status,starts_on,expires_on) VALUES($1,$2,'active','2026-01-01','2030-01-01')",
        [id, plan],
      );
    const repository = new PgSupportRepository(db);
    const loadCustomer = async (customerId) =>
      (
        await createCustomerContextSnapshot(db, {
          customerId,
          purpose: 'CONVERSATION',
          channel: 'ADMIN',
          correlationId: randomUUID(),
        })
      ).customer360;
    const f = await fixture({
      repository,
      customers,
      contextLoader: loadCustomer,
    });
    const r = await f.run();
    assert.equal(r.outcome, 'RESOLVED', JSON.stringify(r));
    assert.equal(
      (await repository.list('cases', { customer_id: f.a }))[0].status,
      'RESOLVED',
    );
    const context = await loadCustomer(f.a);
    assert.equal(context.support.last_case.status, 'RESOLVED');
    assert.equal(context.support.last_case.verification_result, 'VERIFIED');
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM gate_event_outbox WHERE event_type='support.case_resolved'",
          )
        ).rows[0].n,
      ),
      1,
    );
    const handoff = await f.run('quero falar com alguém', f.b);
    assert.equal(handoff.outcome, 'HANDOFF_CREATED');
    await f.run('quero falar com alguém', f.b);
    assert.equal(
      (await repository.list('exceptions', { customer_id: f.b })).length,
      1,
    );
    const e = (await repository.list('exceptions', { customer_id: f.b }))[0];
    await assert.rejects(
      repository.get('exceptions', e.id, f.a),
      /RESOURCE_NOT_FOUND/,
    );
    await f.operations.humanAction({
      customer_id: f.b,
      exception_id: e.id,
      action: 'resolve',
      actor: { type: 'ADMIN', id: 'local-reviewer' },
      result: 'VERIFIED',
      note: 'Synthetic customer confirmed the resolution.',
      correlation_id: randomUUID(),
    });
    assert.equal(
      (await loadCustomer(f.b)).support.exceptions[0].status,
      'RESOLVED',
    );
    assert.ok(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM audit_logs WHERE action='exception.resolved'",
          )
        ).rows[0].n,
      ) > 0,
    );
    const readModel = new PgCommandCenter({ db, repository, loadCustomer });
    assert.equal((await readModel.summary()).support_cases, 2);
    assert.equal(
      (await readModel.metrics()).autonomous_resolution_rate.value,
      1,
    );
    assert.equal(
      (await readModel.list('exceptions', { human_required: 'true' })).items
        .length,
      0,
    );
    assert.equal((await readModel.customer(f.a)).customer360.customer_id, f.a);
    assert.ok((await readModel.activity()).items.length > 0);
    let notificationEffects = 0;
    const handlers = {
      ...createSupportEventHandlers(),
      'notification.requested': async (event, client) => {
        const r = await client.query(
          "UPDATE notification_requests SET status='SENT' WHERE id=$1 AND customer_id=$2 AND status='PENDING' RETURNING id",
          [event.subject.id, event.payload.customer_id],
        );
        notificationEffects += r.rowCount;
      },
    };
    const crashEvent = (
      await db.query(
        "SELECT event_id FROM gate_event_outbox WHERE event_type='notification.requested' ORDER BY created_at LIMIT 1",
      )
    ).rows[0].event_id;
    let failAck = true;
    const crashing = {
      transaction: (fn) =>
        db.transaction((client) =>
          fn({
            query: async (sql, args) => {
              if (
                failAck &&
                args?.[0] === crashEvent &&
                sql.includes("SET publish_status = 'PUBLISHED'")
              ) {
                failAck = false;
                throw new Error('LOCAL_AFTER_EFFECT_BEFORE_ACK');
              }
              return client.query(sql, args);
            },
          }),
        ),
    };
    const firstDispatch = await new OutboxDispatcher({
      db: crashing,
      workerId: 'phase6-worker-A',
      handlers,
      env: {},
    }).dispatchBatch({ limit: 100 });
    assert.equal(firstDispatch.failed, 1);
    const effectsBeforeReplay = notificationEffects;
    const replay = await new OutboxDispatcher({
      db,
      workerId: 'phase6-worker-B',
      handlers,
      env: {},
    }).dispatchBatch({ limit: 100, now: new Date(Date.now() + 60000) });
    assert.equal(replay.failed, 0);
    assert.equal(replay.published, 1);
    assert.equal(notificationEffects, effectsBeforeReplay);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM gate_event_outbox WHERE publish_status!='PUBLISHED'",
          )
        ).rows[0].n,
      ),
      0,
    );
  } finally {
    await pg.close();
  }
});
test('phase6 migration 0006 is expand-only and preserves existing support entity', async () => {
  const sql = await readFile(
    new URL(
      '../database/migrations/0006_support_exception_command_center.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    sql,
    /\b(DROP|TRUNCATE|RENAME|DELETE|UPDATE|INSERT INTO)\b/i,
  );
  assert.match(
    sql,
    /ALTER TABLE customer_issues ADD COLUMN IF NOT EXISTS support_data jsonb/,
  );
  assert.doesNotMatch(sql, /CREATE TABLE.*support_cases/i);
});
