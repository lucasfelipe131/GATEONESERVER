import { randomUUID } from 'node:crypto';
import { getSetting } from '../db.js';
import { decryptSecret, encryptSecret } from '../security.js';
import { getRuntimeConfig } from '../integrations/runtime-config.js';
import { isGateOneOwner, normalizeBitPanelText, readBitPanelLinkedAccess, readBitPanelCustomerInformation } from '../integrations/bitpanel.js';

export const CUSTOMER_ACCESS_FRESH_MS = 24 * 60 * 60_000;
export const CUSTOMER_ACCESS_RETRY_MS = 15 * 60_000;
const failure = code => Object.assign(new Error(code), { code, statusCode: 409 });
const errorCodes = new Set(['BITPANEL_READ_LINK_UNVERIFIED','BITPANEL_READ_REAUTH_REQUIRED','BITPANEL_READ_UNAVAILABLE','BITPANEL_READ_TIMEOUT']);
const safeCode = error => errorCodes.has(error?.code) ? error.code : 'BITPANEL_READ_UNAVAILABLE';
const sameBinding = (left, right) => left && right && ['customer_id','whatsapp_e164','username','owner','subscription_id','list_id'].every(key => left[key] === right[key]);
const complete = row => row?.whatsapp_e164 && /^\d{1,20}$/.test(String(row.list_id || '')) &&
  Boolean(row.username && String(row.username).trim() === row.username && row.username.length <= 120 && !/[\r\n\x00]/.test(row.username)) && isGateOneOwner(row.owner);

function sourceMatches(value, listId, config) {
  try {
    const base = new URL(config.BITPANEL_BASE_URL), source = new URL(value);
    return base.protocol === 'https:' && ['bitpanel.vip','www.bitpanel.vip'].includes(base.hostname) &&
      source.origin === base.origin && !source.username && !source.password && !source.search && !source.hash &&
      source.pathname === `/list/view/${listId}`;
  } catch { return false; }
}

/** No provider actuator, payment service, messaging transport or claimed-login lookup. */
export class CustomerAccessSync {
  constructor({ db, config, readAccess = readBitPanelLinkedAccess, readInformation = readBitPanelCustomerInformation, runtimeConfig, now = () => new Date() }) {
    Object.assign(this, { db, config, readAccess, readInformation, now });
    this.runtimeConfig = runtimeConfig || (() => getRuntimeConfig(db, config));
  }

  async binding(client, customerId, lock = false) {
    const customer = (await client.query(`SELECT id AS customer_id,whatsapp_e164,bitpanel_reference AS username,
      bitpanel_owner AS owner,access_password_encrypted FROM customers WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [customerId])).rows[0];
    if (!customer) return null;
    const subscription = (await client.query(`SELECT id AS subscription_id,bitpanel_list_id AS list_id,
      expires_on::text AS expires_on FROM subscriptions WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [customerId])).rows[0];
    return { ...customer, subscription_id: subscription?.subscription_id || null, list_id: subscription?.list_id || null,
      expires_on: subscription?.expires_on || null };
  }

  async conflicting(client, row) {
    const result = await client.query(`SELECT EXISTS(
      SELECT 1 FROM customers c WHERE c.id<>$1 AND lower(trim(c.bitpanel_reference))=lower(trim($2))
      UNION ALL SELECT 1 FROM subscriptions s WHERE s.customer_id<>$1 AND s.bitpanel_list_id=$3
    ) AS conflict`, [row.customer_id, row.username, row.list_id]);
    return result.rows[0]?.conflict === true;
  }

  async saveFailure(snapshot, code) {
    return this.db.transaction(async client => {
      const current = await this.binding(client, snapshot.customer_id, true);
      if (!current) return 'UNVERIFIED_LINK';
      const unchanged = sameBinding(snapshot, current) && complete(current) && !(await this.conflicting(client, current));
      const status = !unchanged || code === 'BITPANEL_READ_LINK_UNVERIFIED' ? 'UNVERIFIED_LINK' :
        code === 'BITPANEL_READ_REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'STALE';
      const recordedCode = !unchanged ? 'BITPANEL_READ_LINK_UNVERIFIED' : code;
      await client.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,
        verified_whatsapp_e164,status,last_error_code,attempted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(customer_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,list_id=EXCLUDED.list_id,
          username=EXCLUDED.username,owner=EXCLUDED.owner,verified_whatsapp_e164=EXCLUDED.verified_whatsapp_e164,
          source_url=CASE WHEN $10 THEN customer_access_sync.source_url ELSE NULL END,
          verified_at=CASE WHEN $10 THEN customer_access_sync.verified_at ELSE NULL END,
          status=EXCLUDED.status,last_error_code=EXCLUDED.last_error_code,attempted_at=EXCLUDED.attempted_at,updated_at=now()`,
      [current.customer_id,current.subscription_id,current.list_id,current.username,current.owner,current.whatsapp_e164,
        status,recordedCode,this.now().toISOString(),unchanged && status !== 'UNVERIFIED_LINK']);
      return status;
    });
  }

  async saveSuccess(snapshot, observation, runtime) {
    if (!observation || observation.listId !== snapshot.list_id || observation.username !== snapshot.username ||
        !isGateOneOwner(observation.owner) || normalizeBitPanelText(observation.owner) !== normalizeBitPanelText(snapshot.owner) ||
        !sourceMatches(observation.sourceUrl,snapshot.list_id,runtime) || typeof observation.password !== 'string' ||
        !observation.password || observation.password.length > 1000 || /[\r\n\x00]/.test(observation.password))
      throw failure('BITPANEL_READ_LINK_UNVERIFIED');
    const encrypted = encryptSecret(observation.password, this.config.COOKIE_SECRET);
    return this.db.transaction(async client => {
      const current = await this.binding(client, snapshot.customer_id, true);
      if (!sameBinding(snapshot,current) || !complete(current) || await this.conflicting(client,current))
        throw failure('BITPANEL_READ_LINK_UNVERIFIED');
      await client.query('UPDATE customers SET access_password_encrypted=$2,updated_at=now() WHERE id=$1', [current.customer_id,encrypted]);
      await client.query(`INSERT INTO customer_access_sync(customer_id,subscription_id,list_id,username,owner,
        verified_whatsapp_e164,source_url,verified_at,attempted_at,status,last_error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'READY',NULL)
        ON CONFLICT(customer_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,list_id=EXCLUDED.list_id,
          username=EXCLUDED.username,owner=EXCLUDED.owner,verified_whatsapp_e164=EXCLUDED.verified_whatsapp_e164,
          source_url=EXCLUDED.source_url,verified_at=EXCLUDED.verified_at,attempted_at=EXCLUDED.attempted_at,
          status='READY',last_error_code=NULL,updated_at=now()`,
      [current.customer_id,current.subscription_id,current.list_id,current.username,current.owner,current.whatsapp_e164,
        observation.sourceUrl,this.now().toISOString()]);
      return 'READY';
    });
  }

  async syncInformation(runtime, { maxDurationMs = 30_000 } = {}) {
    if (!this.readInformation || await getSetting(this.db,'bitpanel_read_sync_enabled',false) !== true) return {status:'DISABLED'};
    let information, source, errorCode = null, timer;
    try {
      if (!runtime) throw failure('BITPANEL_READ_REAUTH_REQUIRED');
      information = await Promise.race([
        this.readInformation(runtime),
        new Promise((_resolve,reject) => {timer=setTimeout(() => reject(failure('BITPANEL_READ_TIMEOUT')),Math.max(1,Math.min(maxDurationMs,30_000))); timer.unref?.();})
      ]);
      source = new URL(information.source);
      if (source.origin !== new URL(runtime.BITPANEL_BASE_URL).origin || source.pathname !== '/notices' ||
          source.username || source.password || source.search || source.hash || !Array.isArray(information.posts) || !information.posts.length)
        throw failure('BITPANEL_READ_LINK_UNVERIFIED');
    } catch (error) { errorCode=safeCode(error); }
    finally {if(timer) clearTimeout(timer);}
    // Re-read the current catalog only after the browser has closed. A concurrent
    // administrator update to guides or apps must not be replaced by an old copy.
    return this.db.transaction(async client => {
      await client.query("INSERT INTO system_settings(key,value) VALUES('customer_help_catalog','{}'::jsonb) ON CONFLICT(key) DO NOTHING");
      const row=(await client.query("SELECT value FROM system_settings WHERE key='customer_help_catalog' FOR UPDATE")).rows[0];
      const previous=row?.value && typeof row.value==='object' ? row.value : {};
      const oldDns=Array.isArray(previous.dns) ? previous.dns : [];
      let bitpanel,catalog;
      if (!errorCode) {
        bitpanel={status:'READY',sourceUrl:source.href,syncedAt:this.now().toISOString(),attemptedAt:this.now().toISOString(),lastErrorCode:null};
        catalog={...previous,bitpanelSync:bitpanel,
          posts:[...(Array.isArray(previous.posts) ? previous.posts.filter(post=>post.source!=='bitpanel') : []),...information.posts.slice(0,10)].slice(-60),
          dns:information.dnsVerified ? information.dns : oldDns.map(item=>({...item,status:'STALE'})),
          telegram:information.telegram || (previous.telegram ? {...previous.telegram,status:'STALE'} : null),downloadsUrl:information.downloadsUrl};
      } else {
        bitpanel={...previous.bitpanelSync,status:errorCode==='BITPANEL_READ_REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'STALE',
          attemptedAt:this.now().toISOString(),lastErrorCode:errorCode};
        catalog={...previous,bitpanelSync:bitpanel,dns:oldDns.map(item=>({...item,status:'STALE'}))};
      }
      await client.query("UPDATE system_settings SET value=$1::jsonb,updated_at=now() WHERE key='customer_help_catalog'",[JSON.stringify(catalog)]);
      return {status:bitpanel.status,errorCode};
    });
  }

  async sync({ limit = 5, maxDurationMs = 90_000 } = {}) {
    if (await getSetting(this.db,'bitpanel_read_sync_enabled',false) !== true) return { enabled:false,checked:0,synced:0 };
    const boundedLimit = Math.max(1,Math.min(Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 5,20));
    const duration = Math.max(1_000,Math.min(Number(maxDurationMs) || 90_000,180_000));
    const holder = randomUUID(), startedAt = Date.now(), leaseSeconds = Math.ceil((duration + 35_000)/1000);
    const lease = await this.db.query(`INSERT INTO customer_access_sync_lease(singleton,holder,expires_at)
      VALUES(true,$1,now()+($2::int * interval '1 second'))
      ON CONFLICT(singleton) DO UPDATE SET holder=EXCLUDED.holder,expires_at=EXCLUDED.expires_at
      WHERE customer_access_sync_lease.expires_at<=now() RETURNING holder`, [holder,leaseSeconds]);
    if (!lease.rows.length) return { enabled:true,busy:true,checked:0,synced:0 };
    const report = { enabled:true,checked:0,synced:0,reauthRequired:0,unverified:0,stale:0,deadlineReached:false };
    try {
      const candidates = (await this.db.query(`SELECT c.id FROM customers c
        LEFT JOIN customer_access_sync a ON a.customer_id=c.id
        WHERE c.whatsapp_e164 IS NOT NULL AND (c.bitpanel_reference IS NOT NULL OR a.customer_id IS NOT NULL)
          AND (a.attempted_at IS NULL OR a.attempted_at <= now()-interval '15 minutes')
        ORDER BY a.attempted_at ASC NULLS FIRST,c.id LIMIT $1`, [boundedLimit])).rows;
      let runtime;
      try { runtime = await this.runtimeConfig(); } catch { runtime = null; }
      if (this.readInformation) {
        const content=await this.syncInformation(runtime,{maxDurationMs:Math.max(1,duration-(Date.now()-startedAt))});
        report.contentStatus=content.status;
        if(content.errorCode==='BITPANEL_READ_REAUTH_REQUIRED') runtime=null;
      }
      for (const candidate of candidates) {
        if (Date.now()-startedAt >= duration) { report.deadlineReached=true; break; }
        const snapshot = await this.binding(this.db,candidate.id);
        if (!snapshot) continue;
        report.checked += 1;
        let status;
        try {
          if (!complete(snapshot) || await this.conflicting(this.db,snapshot)) throw failure('BITPANEL_READ_LINK_UNVERIFIED');
          if (!runtime) throw failure('BITPANEL_READ_REAUTH_REQUIRED');
          let timer;
          try {
            const observation = await Promise.race([
              this.readAccess(runtime,{listId:snapshot.list_id,username:snapshot.username,owner:snapshot.owner}),
              new Promise((_resolve,reject) => { timer=setTimeout(() => reject(failure('BITPANEL_READ_TIMEOUT')),Math.max(1,duration-(Date.now()-startedAt))); timer.unref?.(); })
            ]);
            status = await this.saveSuccess(snapshot,observation,runtime);
          } finally { if (timer) clearTimeout(timer); }
        } catch (error) { status = await this.saveFailure(snapshot,safeCode(error)); }
        if (status === 'READY') report.synced += 1;
        else if (status === 'REAUTH_REQUIRED') report.reauthRequired += 1;
        else if (status === 'UNVERIFIED_LINK') report.unverified += 1;
        else report.stale += 1;
      }
      return report;
    } finally { await this.db.query('DELETE FROM customer_access_sync_lease WHERE holder=$1',[holder]); }
  }

  async view(client, customerId, lock = false) {
    const binding = await this.binding(client,customerId,lock);
    if (!binding) throw Object.assign(failure('PORTAL_SESSION_INVALID'),{statusCode:401});
    const record = (await client.query(`SELECT * FROM customer_access_sync WHERE customer_id=$1${lock ? ' FOR SHARE' : ''}`,[customerId])).rows[0];
    const bound = complete(binding) && record && record.subscription_id === binding.subscription_id &&
      record.list_id === binding.list_id && record.username === binding.username && record.owner === binding.owner &&
      record.verified_whatsapp_e164 === binding.whatsapp_e164 && !(await this.conflicting(client,binding));
    const valid = bound && sourceMatches(record.source_url,binding.list_id,this.config) && record.verified_at;
    const age = valid ? this.now().getTime()-new Date(record.verified_at).getTime() : Infinity;
    const status = !valid ? (bound && ['REAUTH_REQUIRED','STALE'].includes(record.status) ? record.status : 'UNVERIFIED_LINK') :
      record.status === 'READY' && (age < 0 || age > CUSTOMER_ACCESS_FRESH_MS) ? 'STALE' : record.status;
    const ready = Boolean(valid && status === 'READY' && age >= 0 && age <= CUSTOMER_ACCESS_FRESH_MS && binding.access_password_encrypted);
    return { binding, metadata:{username:binding.username || null,passwordAvailable:ready,status,
      source:valid ? record.source_url : null,syncedAt:valid ? record.verified_at : null,
      expiresAt:valid ? new Date(new Date(record.verified_at).getTime()+CUSTOMER_ACCESS_FRESH_MS).toISOString() : null} };
  }

  async metadata(customerId) { return (await this.view(this.db,customerId)).metadata; }

  async reveal(customerId) {
    return this.db.transaction(async client => {
      const {binding,metadata} = await this.view(client,customerId,true);
      if (!metadata.passwordAvailable) throw failure('CUSTOMER_ACCESS_UPDATE_REQUIRED');
      let password;
      try { password=decryptSecret(binding.access_password_encrypted,this.config.COOKIE_SECRET); }
      catch { throw failure('CUSTOMER_ACCESS_UPDATE_REQUIRED'); }
      return {username:metadata.username,password,expiresInSeconds:60};
    });
  }
}
