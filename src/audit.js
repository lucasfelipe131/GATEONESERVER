export async function audit(db, {
  actorType = 'system',
  actorId = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  ip = null
}) {
  await db.query(
    `INSERT INTO audit_logs
      (actor_type, actor_id, action, entity_type, entity_id, before_data, after_data, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip
    ]
  );
}
