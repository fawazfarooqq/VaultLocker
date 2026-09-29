-- VaultLock Pro schema. Safe to apply repeatedly in the Supabase SQL editor.
-- The vault_documents bucket must remain PRIVATE. Configure a 25 MB limit and
-- allow PDF, PNG, JPEG and DOCX MIME types in Storage settings.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  phone text,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;
drop policy if exists vaultlock_profiles_select_own on public.profiles;
drop policy if exists vaultlock_profiles_insert_own on public.profiles;
drop policy if exists vaultlock_profiles_update_own on public.profiles;
create policy vaultlock_profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy vaultlock_profiles_insert_own on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy vaultlock_profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Creates the profile when a Google user signs up. Idempotent (on conflict) and never blocks
-- sign-in: a failure here would otherwise surface as "Database error saving new user" and the
-- OAuth callback would fail. The frontend also creates a missing profile as a fallback.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.profiles(id, full_name, email, avatar_url)
    values (
      new.id,
      coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
      new.email,
      coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
    )
    on conflict (id) do update set
      email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name),
      avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);
  exception when others then
    raise warning 'handle_new_user: profile creation failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
-- Replace earlier VaultLock triggers (including any older on_auth_user_created) with a single one.
drop trigger if exists vaultlock_on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.vaultlock_handle_new_user();
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name varchar(255) not null,
  file_path varchar(1000) not null unique,
  file_size bigint not null check (file_size > 0 and file_size <= 26214400),
  mime_type varchar(150) not null,
  category varchar(50) not null default 'General',
  label varchar(100),
  notes text,
  folder varchar(100) not null default 'General',
  is_confidential boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Upgrade the earlier VaultLock schema without touching unrelated objects.
alter table public.documents add column if not exists category varchar(50) not null default 'General';
alter table public.documents add column if not exists folder varchar(100) not null default 'General';
alter table public.documents add column if not exists is_confidential boolean not null default true;
alter table public.documents add column if not exists updated_at timestamptz not null default now();
alter table public.documents alter column file_path type varchar(1000);
alter table public.documents alter column mime_type type varchar(150);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='documents' and column_name='folder_name') then
    execute 'update public.documents set folder = folder_name where folder_name is not null';
  end if;
end $$;
alter table public.documents enable row level security;
revoke all on public.documents from anon;
grant select, insert, update, delete on public.documents to authenticated;
create index if not exists vaultlock_documents_user_id_idx on public.documents(user_id);
create index if not exists vaultlock_documents_category_idx on public.documents(category);
create index if not exists vaultlock_documents_folder_idx on public.documents(folder);
create index if not exists vaultlock_documents_created_at_idx on public.documents(created_at desc);
drop policy if exists vaultlock_documents_select_own on public.documents;
drop policy if exists vaultlock_documents_insert_own on public.documents;
drop policy if exists vaultlock_documents_update_own on public.documents;
drop policy if exists vaultlock_documents_delete_own on public.documents;
create policy vaultlock_documents_select_own on public.documents for select to authenticated using ((select auth.uid()) = user_id);
create policy vaultlock_documents_insert_own on public.documents for insert to authenticated with check ((select auth.uid()) = user_id);
create policy vaultlock_documents_update_own on public.documents for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy vaultlock_documents_delete_own on public.documents for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.vaultlock_set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists vaultlock_documents_updated_at on public.documents;
create trigger vaultlock_documents_updated_at before update on public.documents
for each row execute function public.vaultlock_set_updated_at();

-- Private bucket: created if missing, forced private, 25 MB, PDF/PNG/JPEG/DOCX only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault_documents', 'vault_documents', false, 26214400,
  array['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies reference storage.objects.name (there is no folder_name column).
-- Do not alter/delete policies not owned by VaultLock.
drop policy if exists vaultlock_storage_insert_own on storage.objects;
drop policy if exists vaultlock_storage_select_own on storage.objects;
drop policy if exists vaultlock_storage_delete_own on storage.objects;
create policy vaultlock_storage_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'vault_documents' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy vaultlock_storage_select_own on storage.objects for select to authenticated
using (bucket_id = 'vault_documents' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy vaultlock_storage_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'vault_documents' and split_part(name, '/', 1) = (select auth.uid())::text);
