import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
// Run only against a disposable database; all changes are rolled back.
// AUTH_MIGRATION_TEST_DATABASE_URL=postgres://... node scripts/test-auth-migrations.mjs
const connectionString = process.env.AUTH_MIGRATION_TEST_DATABASE_URL;
if (!connectionString) throw new Error('Set AUTH_MIGRATION_TEST_DATABASE_URL to a disposable PostgreSQL database');
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { Pool } = require('pg');
const { jwt } = await import(require.resolve('better-auth/plugins'));
const { oauthProvider } = await import(require.resolve('@better-auth/oauth-provider'));
const coreRequire = createRequire(require.resolve('better-auth'));
const { getExpectedSchema, diffSchema } = await import(new URL('./schema-diff.mjs', pathToFileURL(coreRequire.resolve('@better-auth/core/db'))));
const pool = new Pool({ connectionString });
const db = await pool.connect();
const root = fileURLToPath(new URL('../api/migrations/', import.meta.url));
try {
 await db.query('BEGIN');
 await db.query('CREATE SCHEMA auth_migration_test');
 await db.query('SET LOCAL search_path TO auth_migration_test, public');
 for(const file of readdirSync(root).filter(f=>f.endsWith('.sql')).sort()) {
   if(file.startsWith('0098')) continue;
   await db.query(readFileSync(root+file,'utf8'));
 }
 await db.query(`INSERT INTO "user" (id,name,email) VALUES ('legacy-user','Test','test@example.test'); INSERT INTO account (id,"accountId","providerId","userId",issuer) VALUES ('legacy-account','subject','google','legacy-user','https://accounts.google.com');`);
 const expected = getExpectedSchema({emailAndPassword:{enabled:true},plugins:[jwt(),oauthProvider({loginPage:'/',consentPage:'/oauth/consent'})]});
 async function findings(){
  const {rows}=await db.query(`SELECT table_name,column_name,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema=current_schema()`);
  const tables=new Map();
  for(const r of rows){ if(!tables.has(r.table_name)) tables.set(r.table_name,{name:r.table_name,columns:[]}); tables.get(r.table_name).columns.push({name:r.column_name,nullable:r.is_nullable==='YES',hasDefault:r.column_default!==null||r.is_identity==='YES'}); }
  return diffSchema(expected,[...tables.values()]);
 }
 console.log('Before migration:', JSON.stringify(await findings()));
 const migration=readFileSync(root+'0098_better_auth_account_issuer_optional.sql','utf8');
 await db.query(migration);
 await db.query(migration);
 const after=await findings(); console.log('After migration:',JSON.stringify(after)); assert.deepEqual(after,[]);
 const {rows}=await db.query(`SELECT issuer,"userId" FROM account WHERE id='legacy-account'`); assert.equal(rows[0].issuer,'https://accounts.google.com'); assert.equal(rows[0].userId,'legacy-user');
 await db.query(`INSERT INTO account (id,"accountId","providerId","userId") VALUES ('new-account','subject','microsoft','legacy-user')`);
 await db.query('SAVEPOINT duplicate_identity');
 await assert.rejects(db.query(`INSERT INTO account (id,"accountId","providerId","userId") VALUES ('duplicate','subject','google','legacy-user')`),e=>e.code==='23505');
 await db.query('ROLLBACK TO SAVEPOINT duplicate_identity');
 const indexes=await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='account'`); assert(indexes.rows.some(r=>r.indexname==='account_provider_account_idx')); assert(!indexes.rows.some(r=>r.indexname==='account_issuer_accountId_uidx'));
 console.log('Existing identities preserved; new inserts work; provider uniqueness enforced; repeated migration succeeds.');
} finally {
 await db.query('ROLLBACK');
 db.release();
 await pool.end();
}
