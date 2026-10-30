/**
 * 迁移脚本：按 version 递增，只追加不修改。
 */
export type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
create table if not exists platform (
  id text primary key,
  slug text not null unique,
  name text not null,
  base_url text not null,
  auth_kind text not null default 'none',
  auth_config text not null default '{}',
  default_headers text not null default '{}',
  egress_allow_hosts text not null default '[]',
  rate_limit text not null default '{"qps":5,"daily":10000}',
  allow_private integer not null default 0,
  notes text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists endpoint (
  id text primary key,
  platform_id text not null references platform(id) on delete cascade,
  slug text not null,
  grp text not null default 'default',
  method text not null,
  path_template text not null,
  summary text not null default '',
  description text not null default '',
  params text not null default '[]',
  body text,
  response text not null default '{}',
  side_effect text not null default 'read',
  sensitivity text not null default 'low',
  tags text not null default '[]',
  examples text not null default '[]',
  notes text not null default '',
  status text not null default 'draft',
  version integer not null default 0,
  content_hash text not null default '',
  source_kind text not null default 'manual',
  source_ref text not null default '',
  created_at text not null,
  updated_at text not null,
  unique(platform_id, slug)
);
create index if not exists idx_endpoint_platform on endpoint(platform_id);

create table if not exists endpoint_version (
  id text primary key,
  endpoint_id text not null references endpoint(id) on delete cascade,
  version integer not null,
  snapshot text not null,
  note text not null default '',
  created_at text not null,
  unique(endpoint_id, version)
);

create table if not exists tool (
  id text primary key,
  endpoint_id text not null unique references endpoint(id) on delete cascade,
  name text not null unique,
  namespace text not null default '',
  title text not null default '',
  description text not null default '',
  input_schema text not null default '{}',
  cache_ttl integer not null default 0,
  annotations text not null default '{"readOnly":true,"destructive":false,"idempotent":true}',
  enabled integer not null default 1,
  created_at text not null,
  updated_at text not null
);

create table if not exists secret (
  name text primary key,
  ciphertext text not null,
  hint text not null default '',
  created_at text not null,
  rotated_at text
);

create table if not exists api_key (
  id text primary key,
  label text not null,
  prefix text not null,
  key_hash text not null unique,
  scopes text not null default '{}',
  enabled integer not null default 1,
  last_used_at text,
  created_at text not null
);

create table if not exists import_job (
  id text primary key,
  kind text not null,
  input_ref text not null default '',
  status text not null default 'pending',
  stats text not null default '{}',
  error text,
  ai_used integer not null default 0,
  created_at text not null,
  finished_at text
);

create table if not exists import_candidate (
  id text primary key,
  job_id text not null references import_job(id) on delete cascade,
  platform_slug text not null,
  payload text not null,
  diff_kind text not null default 'new',
  target_endpoint_id text,
  decision text not null default 'pending',
  created_at text not null
);
create index if not exists idx_candidate_job on import_candidate(job_id);

create table if not exists audit_log (
  id text primary key,
  ts text not null,
  request_id text not null,
  api_key_id text,
  channel text not null default 'rest',
  tool_name text not null,
  endpoint_id text,
  status integer not null default 0,
  ok integer not null default 0,
  latency_ms integer not null default 0,
  upstream_host text not null default '',
  error_code text,
  req_meta text not null default '{}',
  resp_meta text not null default '{}'
);
create index if not exists idx_audit_ts on audit_log(ts desc);

create table if not exists chat_session (
  id text primary key,
  title text not null default '新会话',
  created_at text not null,
  updated_at text not null
);

create table if not exists chat_message (
  id text primary key,
  session_id text not null references chat_session(id) on delete cascade,
  role text not null,
  content text not null default '',
  tool_calls text,
  tool_result text,
  created_at text not null
);
create index if not exists idx_chat_msg_session on chat_message(session_id, created_at);

create table if not exists setting (
  key text primary key,
  value text not null
);
`,
  },
  {
    version: 2,
    name: 'accounts-and-exposure',
    sql: `
create table if not exists account (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  role text not null default 'member',
  enabled integer not null default 1,
  created_at text not null,
  last_login_at text
);

create table if not exists session (
  token_hash text primary key,
  account_id text not null references account(id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  last_seen_at text
);
create index if not exists idx_session_account on session(account_id);

alter table endpoint add column exposure text not null default 'open';
alter table endpoint add column allowed_key_ids text not null default '[]';

alter table api_key add column account_id text;
`,
  },
  {
    version: 3,
    name: 'api-key-quota',
    sql: `
alter table api_key add column expires_at text;
alter table api_key add column quota_limit integer not null default 0;
alter table api_key add column quota_used integer not null default 0;
alter table api_key add column quota_period text not null default 'total';
alter table api_key add column quota_reset_at text;
alter table api_key add column call_count integer not null default 0;
alter table api_key add column notes text not null default '';
create index if not exists idx_api_key_account on api_key(account_id);
`,
  },
  {
    version: 4,
    name: 'gateway-alias-and-ip-allowlist',
    sql: `
alter table endpoint add column public_name text not null default '';
alter table api_key add column ip_allowlist text not null default '[]';
create index if not exists idx_endpoint_public_name on endpoint(public_name);
`,
  },
  {
    version: 5,
    name: 'import-progress-and-site-title',
    sql: `
alter table import_job add column steps text not null default '[]';
alter table import_job add column progress integer not null default 0;
alter table import_job add column site_count integer not null default 0;
alter table platform add column site_title text not null default '';
alter table platform add column site_icon text not null default '';
create index if not exists idx_import_job_created on import_job(created_at);
`,
  },
  {
    version: 6,
    name: 'audit-actor',
    sql: `
-- 审计归因：以前匿名操作在流水里是 api_key_id=null + channel=console，查不到人。
-- actor 记录已认证主体（account:<id> / key:<id> / admin-token / anonymous）。
alter table audit_log add column actor text;
create index if not exists idx_audit_actor on audit_log(actor);
`,
  },
];
