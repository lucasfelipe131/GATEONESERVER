import { decryptSecret, encryptSecret, hmacSha256, maskPhone, normalizePhone, safeEqual } from '../security.js';
import { getRuntimeConfig } from '../integrations/runtime-config.js';
import { isGateOneOwner, normalizeBitPanelText, readBitPanelLinkedAccess } from '../integrations/bitpanel.js';

const fail = code => Object.assign(new Error(code), { code });
const SECRET_TEXT = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const SAFE_SOURCE_TABLES = new Set(['message_logs', 'conversation_sessions', 'customer_identity_links',
  'customer_identities', 'customer_portal_links', 'customer_portal_sessions']);
const SAFE_ERRORS = new Set(['IDENTITY_SCAN_INVALID_MODE', 'IDENTITY_SCAN_SECRET_REQUIRED', 'IDENTITY_SCAN_AUDIT_REQUIRED',
  'IDENTITY_SCAN_AUDIT_CHANGED', 'IDENTITY_SCAN_TOO_LARGE', 'IDENTITY_SCAN_SCHEMA_UNSUPPORTED',
  'BITPANEL_READ_REAUTH_REQUIRED', 'BITPANEL_READ_LINK_UNVERIFIED', 'BITPANEL_READ_TIMEOUT', 'BITPANEL_READ_UNAVAILABLE']);
const REVIEW_REASONS = new Set(['source_binding_unverified', 'duplicate_login', 'target_not_found', 'target_access_unverified',
  'duplicate_provider_list', 'target_has_other_phone', 'historical_recipient_unverified', 'contact_permission_conflict',
  'source_has_protected_history', 'phone_identity_conflict', 'confirmed_identity_conflict', 'existing_pending_review',
  'stored_access_unreadable', 'stored_password_mismatch', 'multiple_accesses_for_phone', 'multiple_phones_for_access']);
const safeError = error => SAFE_ERRORS.has(error?.code) ? error.code : 'IDENTITY_SCAN_UNAVAILABLE';
const instant = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null; };
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (secret, value) => hmacSha256(secret, `whatsapp-identity-scan-v1:${JSON.stringify(canonical(value))}`);
const runtimeDigest = (config, runtime) => digest(config.COOKIE_SECRET, Object.fromEntries(Object.entries(runtime || {})
  .filter(([key]) => /^BITPANEL_(?:BASE_URL|LOGIN_URL|USERNAME|PASSWORD|STORAGE_STATE)$/.test(key))));
const validPhone = value => {
  if (typeof value !== 'string' || !/^[1-9]\d{7,14}$/.test(value)) return false;
  try { return normalizePhone(value) === value; } catch { return false; }
};
const validCredential = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit &&
  value.trim() === value && !SECRET_TEXT.test(value);

function labelledPair(message) {
  if (message.direction !== 'outbound' || !['whatsapp', 'whatsapp_qr'].includes(message.channel) ||
      String(message.status).toLowerCase() !== 'sent' || message.simulated !== false ||
      message.content_type && message.content_type !== 'TEXT' ||
      typeof message.provider_id !== 'string' || !/^[A-Za-z0-9._:-]{6,180}$/.test(message.provider_id) ||
      /^(?:sim(?:[-_.:]|$)|test|fake|synthetic|manual|dry[-_])/i.test(message.provider_id) ||
      typeof message.content !== 'string' || message.content.length > 12_000 ||
      /\b(?:forwarded|encaminhad[oa]s?|mensagem\s+encaminhada)\b|(?:^|\n)\s*>/iu.test(message.content)) return null;
  const fields = { username: [], password: [] };
  for (const line of message.content.split(/\r?\n/)) {
    // Strip presentation markup around a label, never normalise credential values.
    const match = /^\s*(?:[👤🔑🔐🆔✅•-]\s*)?\*{0,2}(login|usu[aá]rio|username|senha|password)\*{0,2}\s*:\s*\*{0,2}\s*(.*?)\s*$/iu.exec(line);
    if (!match) continue;
    const field = /^(?:senha|password)$/i.test(match[1]) ? 'password' : 'username';
    fields[field].push(match[2]);
  }
  if (fields.username.length !== 1 || fields.password.length !== 1 ||
      !validCredential(fields.username[0], 120) || !validCredential(fields.password[0], 1000)) return null;
  return { username: fields.username[0], password: fields.password[0] };
}

async function loadSource(client, message, { lock = false } = {}) {
  const source = (await client.query(`SELECT * FROM customers WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [message.customer_id])).rows[0];
  if (!source) return null;
  const sessions = (await client.query(`SELECT * FROM conversation_sessions WHERE
    ($1::uuid IS NOT NULL AND conversation_id=$1) OR
    ($2::text IS NOT NULL AND whatsapp_e164=$2) ORDER BY whatsapp_e164${lock ? ' FOR UPDATE' : ''}`,
  [message.conversation_id || null, source.whatsapp_e164 || null])).rows;
  const phones = new Set([source.whatsapp_e164, ...sessions.map(session => session.whatsapp_e164)].filter(Boolean));
  const phone = phones.size === 1 ? [...phones][0] : null;
  const sessionBinding = sessions.every(session => (!session.customer_id || session.customer_id === source.id) &&
    (!session.data?.customerId || session.data.customerId === source.id));
  const historicallyBound = Boolean(message.conversation_id && sessions.some(session =>
    session.conversation_id === message.conversation_id && session.whatsapp_e164 === phone &&
    (session.customer_id === source.id || session.data?.customerId === source.id)));
  return { source, sessions, phone, historicallyBound, bound: validPhone(phone) && sessionBinding &&
    (source.whatsapp_e164 === phone || sessions.some(session => session.customer_id === source.id || session.data?.customerId === source.id)) };
}

async function loadTarget(client, username, { lock = false } = {}) {
  const targets = (await client.query(`SELECT * FROM customers WHERE lower(trim(bitpanel_reference))=lower(trim($1))
    ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [username])).rows;
  const target = targets.length === 1 ? targets[0] : null;
  const subscriptions = target ? (await client.query(`SELECT * FROM subscriptions WHERE customer_id=$1
    ORDER BY created_at DESC,id DESC${lock ? ' FOR UPDATE' : ''}`, [target.id])).rows : [];
  return { targets, target, subscriptions, subscription: subscriptions[0] || null };
}

async function protectedSourceReferences(client, sourceId) {
  const references = (await client.query(`SELECT DISTINCT n.nspname AS schema_name,r.relname AS table_name,a.attname AS column_name
    FROM pg_constraint f JOIN pg_class r ON r.oid=f.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=ANY(f.conkey)
    WHERE f.contype='f' AND f.confrelid='customers'::regclass ORDER BY table_name,column_name`)).rows;
  for (const reference of references) {
    if (SAFE_SOURCE_TABLES.has(reference.table_name)) continue;
    if (reference.schema_name !== 'public' || !/^[a-z_][a-z0-9_]*$/.test(reference.table_name) ||
        !/^[a-z_][a-z0-9_]*$/.test(reference.column_name)) throw fail('IDENTITY_SCAN_SCHEMA_UNSUPPORTED');
    // Identifiers come from the server catalog and pass an identifier-only allowlist.
    if ((await client.query(`SELECT 1 FROM "${reference.table_name}" WHERE "${reference.column_name}"=$1 LIMIT 1`, [sourceId])).rows.length) return true;
  }
  return false;
}

async function assess(client, message, pair, config, { lock = false } = {}) {
  const origin = await loadSource(client, message, { lock });
  const matched = await loadTarget(client, pair.username, { lock });
  const snapshot = { message, ...origin, ...matched, pair };
  if (!origin?.bound) return { ...snapshot, reason: 'source_binding_unverified' };
  if (!matched.target) return { ...snapshot, reason: matched.targets.length ? 'duplicate_login' : 'target_not_found' };
  const { target, subscription } = matched;
  if (target.bitpanel_reference !== pair.username || !isGateOneOwner(target.bitpanel_owner) ||
      target.automation_eligible !== true || target.status === 'cancelled' ||
      !subscription || !/^[1-9]\d{0,19}$/.test(String(subscription.bitpanel_list_id || '')) || subscription.status === 'cancelled')
    return { ...snapshot, reason: 'target_access_unverified' };
  const duplicate = (await client.query(`SELECT EXISTS(SELECT 1 FROM subscriptions WHERE customer_id<>$1 AND bitpanel_list_id=$2) AS conflict`,
  [target.id, subscription.bitpanel_list_id])).rows[0]?.conflict;
  if (duplicate) return { ...snapshot, reason: 'duplicate_provider_list' };
  if (target.whatsapp_e164 === origin.phone) return { ...snapshot, reason: 'already_linked' };
  if (target.whatsapp_e164) return { ...snapshot, reason: 'target_has_other_phone' };
  if (!origin.historicallyBound) return { ...snapshot, reason: 'historical_recipient_unverified' };
  // A global opt-out blocks non-billing notices too; false consent alone cannot replace it.
  if (!target.opt_out_at && (origin.source.opt_out_at || target.consent_contact && !origin.source.consent_contact))
    return { ...snapshot, reason: 'contact_permission_conflict' };
  if (origin.source.status !== 'lead' || origin.source.bitpanel_reference || origin.source.access_password_encrypted ||
      await protectedSourceReferences(client, origin.source.id)) return { ...snapshot, reason: 'source_has_protected_history' };
  const identities = (await client.query(`SELECT * FROM customer_identities WHERE customer_id=$1 OR
    (identity_type IN ('WHATSAPP','PHONE') AND (normalized_value=$2 OR customer_id=$3))${lock ? ' FOR UPDATE' : ''}`,
  [origin.source.id, origin.phone, target.id])).rows;
  const phoneOwner = (await client.query(`SELECT id FROM customers WHERE whatsapp_e164=$1 AND id<>$2${lock ? ' FOR UPDATE' : ''}`,
  [origin.phone, origin.source.id])).rows;
  if (phoneOwner.length || identities.some(identity => !['WHATSAPP', 'PHONE'].includes(identity.identity_type) ||
      identity.customer_id !== origin.source.id || identity.normalized_value !== origin.phone))
    return { ...snapshot, identities, reason: 'phone_identity_conflict' };
  const confirmed = (await client.query(`SELECT * FROM customer_identity_links WHERE status='confirmed' AND
    (whatsapp_e164=$1 OR source_customer_id=ANY($2::uuid[]) OR candidate_customer_id=ANY($2::uuid[]))${lock ? ' FOR UPDATE' : ''}`,
  [origin.phone, [origin.source.id, target.id]])).rows;
  if (confirmed.some(link => link.whatsapp_e164 !== origin.phone || link.candidate_customer_id !== target.id ||
      link.source_customer_id && link.source_customer_id !== origin.source.id))
    return { ...snapshot, identities, reason: 'confirmed_identity_conflict' };
  const pending = (await client.query(`SELECT id FROM customer_identity_links WHERE status='pending' AND
    (whatsapp_e164=$1 OR source_customer_id=ANY($2::uuid[]) OR candidate_customer_id=ANY($2::uuid[]))${lock ? ' FOR UPDATE' : ''}`,
  [origin.phone, [origin.source.id, target.id]])).rows;
  if (pending.length) return { ...snapshot, identities, reason: 'existing_pending_review' };
  let localPasswordMatches = null;
  if (target.access_password_encrypted) {
    try { localPasswordMatches = safeEqual(decryptSecret(target.access_password_encrypted, config.COOKIE_SECRET), pair.password); }
    catch { return { ...snapshot, identities, reason: 'stored_access_unreadable' }; }
    if (!localPasswordMatches) return { ...snapshot, identities, reason: 'stored_password_mismatch' };
  }
  return { ...snapshot, identities, localPasswordMatches, reason: 'fresh_verification_required' };
}

function evidence(snapshot, config) {
  return digest(config.COOKIE_SECRET, { message: snapshot.message, source: snapshot.source,
    sessions: snapshot.sessions, phone: snapshot.phone, targets: snapshot.targets, subscriptions: snapshot.subscriptions,
    identities: snapshot.identities, reason: snapshot.assessmentReason || snapshot.reason });
}

function relatedHistory(rows, snapshot, config) {
  const conversations = new Set((snapshot.sessions || []).map(session => session.conversation_id).filter(Boolean));
  return digest(config.COOKIE_SECRET, rows.filter(message => {
    const pair = labelledPair(message);
    return pair && (message.customer_id === snapshot.source?.id || message.customer_id === snapshot.target?.id ||
      conversations.has(message.conversation_id) || pair.username.toLowerCase() === snapshot.pair.username.toLowerCase());
  }).sort((left, right) => left.id.localeCompare(right.id)));
}

async function messageRows(client, maxMessages) {
  const rows = (await client.query(`SELECT id,customer_id,conversation_id,direction,channel,content,provider_id,status,simulated,content_type,processing_status,created_at
    FROM message_logs WHERE direction='outbound' AND channel IN ('whatsapp','whatsapp_qr') AND lower(status)='sent' AND simulated=false
    ORDER BY created_at DESC,id DESC LIMIT $1`, [maxMessages + 1])).rows;
  if (rows.length > maxMessages) throw fail('IDENTITY_SCAN_TOO_LARGE');
  return rows;
}

async function collect(db, config, maxMessages) {
  const rows = await messageRows(db, maxMessages);
  const snapshots = [];
  for (const message of rows) {
    const pair = labelledPair(message);
    if (pair) snapshots.push(await assess(db, message, pair, config));
  }
  const byPhone = new Map(), byTarget = new Map();
  for (const item of snapshots) {
    if (!item.phone || !item.bound) continue;
    const phoneItems = byPhone.get(item.phone) || [];phoneItems.push(item);byPhone.set(item.phone, phoneItems);
  }
  const selected = [];
  for (const items of byPhone.values()) {
    const users = new Set(items.map(item => item.pair.username));
    if (users.size > 1) for (const item of items) selected.push({ ...item, assessmentReason: item.reason, reason: 'multiple_accesses_for_phone' });
    else selected.push(items[0]); // Most recent complete pair; historical versions are superseded.
  }
  selected.push(...snapshots.filter(item => !item.phone || !item.bound));
  for (const item of selected) {
    if (item.reason !== 'fresh_verification_required') continue;
    const items = byTarget.get(item.target.id) || [];items.push(item);byTarget.set(item.target.id, items);
  }
  for (const items of byTarget.values()) if (new Set(items.map(item => item.phone)).size > 1)
    for (const item of items) { item.assessmentReason = item.reason;item.reason = 'multiple_phones_for_access'; }
  for (const item of selected) item.historyDigest = relatedHistory(rows, item, config);
  return { rows: rows.length, pairs: snapshots.length, selected, auditDigest: digest(config.COOKIE_SECRET,
    selected.map(item => ({ id: item.message.id, proof: evidence(item, config), decision: item.reason, historyDigest: item.historyDigest }))
      .sort((left, right) => left.id.localeCompare(right.id))) };
}

async function queueReview(client, snapshot, reason) {
  if (!snapshot.bound || !validPhone(snapshot.phone)) return false;
  const result = await client.query(`INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,candidate_customer_id,claimed_login,status,reason,confidence)
    VALUES($1,$2,$3,$4,'pending',$5,0)
    ON CONFLICT(whatsapp_e164,lower(claimed_login)) WHERE status='pending' DO NOTHING RETURNING id`,
  [snapshot.phone, snapshot.source.id, snapshot.target?.id || null, snapshot.pair.username, `historical_scan_${reason}`]);
  return result.rows.length > 0;
}

function validObservation(observation, snapshot, runtime, startedAt, now) {
  const verified = instant(observation?.verifiedAt);
  let source, base;
  try { source = new URL(observation?.sourceUrl);base = new URL(runtime.BITPANEL_BASE_URL); } catch { return false; }
  return base.protocol === 'https:' && ['bitpanel.vip', 'www.bitpanel.vip'].includes(base.hostname) &&
    !base.port && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/' &&
    source.origin === base.origin && source.pathname === `/list/view/${snapshot.subscription.bitpanel_list_id}` &&
    !source.username && !source.password && !source.search && !source.hash &&
    observation.listId === snapshot.subscription.bitpanel_list_id && observation.username === snapshot.pair.username &&
    isGateOneOwner(observation.owner) && normalizeBitPanelText(observation.owner) === normalizeBitPanelText(snapshot.target.bitpanel_owner) &&
    validCredential(observation.password, 1000) && safeEqual(observation.password, snapshot.pair.password) &&
    verified && verified >= startedAt && verified <= now && now - verified <= 60_000;
}

async function applySnapshot(db, config, snapshot, observation, runtime, startedAt, now, assertEnvironment, runtimeConfig, maxMessages) {
  return db.transaction(async client => {
    assertEnvironment();
    // Prevent phantom login/list/phone conflicts while this short transaction rechecks and links.
    await client.query('LOCK TABLE customers,subscriptions,customer_identities,conversation_sessions,message_logs,customer_identity_links,integration_credentials,system_settings IN SHARE ROW EXCLUSIVE MODE');
    const message = (await client.query('SELECT * FROM message_logs WHERE id=$1 FOR UPDATE', [snapshot.message.id])).rows[0];
    const pair = message && labelledPair(message);
    if (!pair) return 'snapshot_changed';
    const current = await assess(client, message, pair, config, { lock: true });
    // Compare only the original message columns; SELECT * may contain unrelated schema additions.
    current.message = Object.fromEntries(Object.keys(snapshot.message).map(key => [key, message[key]]));
    // Another review inserted in this run may block the same target. It can only permit
    // a separate pending review; never turn a previously eligible assignment into approval.
    if (snapshot.reason !== 'fresh_verification_required' && current.reason === 'existing_pending_review')
      current.assessmentReason = snapshot.assessmentReason || snapshot.reason;
    if (evidence(current, config) !== evidence(snapshot, config)) return 'snapshot_changed';
    // A new complete credential message for this phone/login may change the identity decision.
    if (relatedHistory(await messageRows(client, maxMessages), current, config) !== snapshot.historyDigest) return 'snapshot_changed';
    if (snapshot.reason !== 'fresh_verification_required') return await queueReview(client, current, snapshot.reason) ? 'queued' : 'review';
    if (runtimeDigest(config, await runtimeConfig(client)) !== runtimeDigest(config, runtime)) return 'snapshot_changed';
    if (!validObservation(observation, current, runtime, startedAt, now()))
      return await queueReview(client, current, 'provider_access_mismatch') ? 'queued' : 'review';
    const { source, target, subscription, phone } = current;
    await client.query('UPDATE customers SET whatsapp_e164=NULL,portal_token_hash=NULL,portal_token_expires_at=NULL,updated_at=now() WHERE id=$1', [source.id]);
    await client.query(`UPDATE customers SET whatsapp_e164=$2,access_password_encrypted=$3,
      portal_token_hash=NULL,portal_token_expires_at=NULL,updated_at=now() WHERE id=$1`,
    [target.id, phone, encryptSecret(observation.password, config.COOKIE_SECRET)]);
    await client.query(`UPDATE customer_identities SET customer_id=$2,metadata=metadata || $3::jsonb,updated_at=now()
      WHERE customer_id=$1 AND identity_type IN ('WHATSAPP','PHONE') AND normalized_value=$4`,
    [source.id, target.id, JSON.stringify({ historicalSourceCustomerId: source.id, evidenceMessageId: message.id }), phone]);
    await client.query(`UPDATE conversation_sessions SET customer_id=$2::uuid,data=jsonb_set(data,'{customerId}',to_jsonb($2::uuid::text),true),
      revision=revision+1 WHERE whatsapp_e164=$3 AND (customer_id=$1 OR customer_id IS NULL)`, [source.id, target.id, phone]);
    await client.query('UPDATE customer_portal_links SET used_at=COALESCE(used_at,now()),expires_at=LEAST(expires_at,now()) WHERE customer_id=ANY($1::uuid[])', [[source.id, target.id]]);
    await client.query('DELETE FROM customer_portal_sessions WHERE customer_id=ANY($1::uuid[])', [[source.id, target.id]]);
    await client.query(`INSERT INTO customer_identity_links(whatsapp_e164,source_customer_id,candidate_customer_id,claimed_login,status,reason,confidence,resolved_at)
      VALUES($1,$2,$3,$4,'confirmed','historical_outbound_credentials_verified',100,now())`, [phone, source.id, target.id, pair.username]);
    await client.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,verified_whatsapp_e164,source_url,verified_at,attempted_at,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'READY') ON CONFLICT(customer_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,
      list_id=EXCLUDED.list_id,username=EXCLUDED.username,owner=EXCLUDED.owner,verified_whatsapp_e164=EXCLUDED.verified_whatsapp_e164,
      source_url=EXCLUDED.source_url,verified_at=EXCLUDED.verified_at,attempted_at=EXCLUDED.attempted_at,status='READY',last_error_code=NULL,updated_at=now()`,
    [target.id, subscription.id, subscription.bitpanel_list_id, pair.username, target.bitpanel_owner, phone, observation.sourceUrl, observation.verifiedAt]);
    await client.query(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES('system','whatsapp-identity-scan','customer.whatsapp_identity_linked','customer',$1,$2::jsonb,$3::jsonb)`,
    [target.id, JSON.stringify({ sourceCustomerId: source.id, phoneMasked: maskPhone(phone) }), JSON.stringify({ targetCustomerId: target.id,
      sourceCustomerId: source.id, messageId: message.id, evidenceDigest: evidence(snapshot, config), sourceUrl: observation.sourceUrl,
      verifiedAt: observation.verifiedAt, preservedSource: true, consentChanged: false, financialActions: 0 })]);
    assertEnvironment();
    return 'applied';
  });
}

/** Offline audit by default; never sends messages, charges, renewals or consent changes. */
export async function runWhatsAppIdentityScan({ db, config, mode = 'dry-run', expectedAuditDigest,
  readAccess = readBitPanelLinkedAccess, runtimeConfig = client => getRuntimeConfig(client || db, config), now = () => new Date(),
  assertEnvironment = () => {}, maxMessages = 10_000, maxProviderReads = 40 } = {}) {
  if (!['dry-run', 'apply'].includes(mode)) throw fail('IDENTITY_SCAN_INVALID_MODE');
  if (typeof config?.COOKIE_SECRET !== 'string' || config.COOKIE_SECRET.length < 16) throw fail('IDENTITY_SCAN_SECRET_REQUIRED');
  assertEnvironment();
  const limit = Math.max(1, Math.min(20_000, Number(maxMessages) || 10_000));
  const collected = await collect(db, config, limit);
  const report = { mode, auditDigest: collected.auditDigest, counts: { messagesScanned: collected.rows, completePairs: collected.pairs,
    candidates: collected.selected.length, localMatches: 0, freshPending: 0, alreadyLinked: 0, reviewCandidates: 0,
    providerReads: 0, applied: 0, queued: 0, snapshotChanged: 0, readFailures: 0, transactionFailures: 0 },
    maskedPhones: [...new Set(collected.selected.filter(item => validPhone(item.phone)).map(item => maskPhone(item.phone)))].sort(),
    reviewReasons: {}, errors: {}, realMessagesSent: 0, realChargesCreated: 0, realRenewals: 0 };
  for (const item of collected.selected) {
    if (item.reason === 'already_linked') report.counts.alreadyLinked++;
    else if (item.reason === 'fresh_verification_required') {
      report.counts.freshPending++;if (item.localPasswordMatches) report.counts.localMatches++;
    } else {
      report.counts.reviewCandidates++;
      const reason = REVIEW_REASONS.has(item.reason) ? item.reason : 'identity_review_required';
      report.reviewReasons[reason] = (report.reviewReasons[reason] || 0) + 1;
    }
  }
  if (mode === 'dry-run') return report;
  if (!/^[a-f0-9]{64}$/.test(expectedAuditDigest || '')) throw fail('IDENTITY_SCAN_AUDIT_REQUIRED');
  if (!safeEqual(expectedAuditDigest, collected.auditDigest)) throw fail('IDENTITY_SCAN_AUDIT_CHANGED');
  let runtime;
  for (const snapshot of collected.selected) {
    if (snapshot.reason === 'already_linked' || !snapshot.bound) continue;
    let observation, startedAt;
    if (snapshot.reason === 'fresh_verification_required') {
      if (report.counts.providerReads >= Math.max(0, Math.min(100, Number(maxProviderReads) || 0))) continue;
      startedAt = now();report.counts.providerReads++;
      try {
        runtime = await runtimeConfig(db);
        if (!runtime?.BITPANEL_STORAGE_STATE) throw fail('BITPANEL_READ_REAUTH_REQUIRED');
        observation = await readAccess({ ...runtime, BITPANEL_READ_TIMEOUT_MS: 30_000 },
          { listId: snapshot.subscription.bitpanel_list_id, username: snapshot.pair.username, owner: snapshot.target.bitpanel_owner });
      } catch (error) {
        const code = safeError(error);report.errors[code] = (report.errors[code] || 0) + 1;report.counts.readFailures++;continue;
      }
    }
    try {
      const result = await applySnapshot(db, config, snapshot, observation, runtime, startedAt, now, assertEnvironment, runtimeConfig, limit);
      if (result === 'applied') { report.counts.applied++;report.counts.freshPending--; }
      else if (result === 'queued') report.counts.queued++;
      else if (result === 'snapshot_changed') report.counts.snapshotChanged++;
    } catch { report.counts.transactionFailures++;report.errors.IDENTITY_SCAN_TRANSACTION_FAILED = (report.errors.IDENTITY_SCAN_TRANSACTION_FAILED || 0) + 1; }
  }
  assertEnvironment();
  return report;
}
