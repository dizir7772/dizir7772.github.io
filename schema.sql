-- ============================================================
-- Glucose Intelligence — схема бази даних Supabase
-- Виконати повністю в Supabase → SQL Editor → New query → Run
-- ============================================================

-- ---------- 1. Профілі (розширення auth.users) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('patient','doctor')),
  full_name text,
  created_at timestamptz default now()
);

-- Автоматично створює запис у profiles при реєстрації користувача.
-- Роль ('patient'/'doctor') і ім'я передаються при signUp() у полі options.data
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'patient'),
    new.raw_user_meta_data->>'full_name'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- 2. Виміри глюкози ----------
create table if not exists public.readings (
  id bigint generated always as identity primary key,
  patient_id uuid not null references public.profiles(id) on delete cascade,
  t bigint not null,        -- epoch ms, та сама конвенція, що й у локальній версії
  mgdl int not null,
  dev text,                 -- ідентифікатор сенсора (нормалізований, без префікса "Anytime")
  created_at timestamptz default now(),
  unique (patient_id, t, dev)
);
create index if not exists readings_patient_t_idx on public.readings (patient_id, t);

-- ---------- 3. Кольори сенсорів ----------
create table if not exists public.device_colors (
  patient_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null,
  color_key text not null,
  primary key (patient_id, device_id)
);

-- ---------- 4. Доступ лікарів до пацієнтів ----------
create table if not exists public.doctor_access (
  id bigint generated always as identity primary key,
  patient_id uuid not null references public.profiles(id) on delete cascade,
  doctor_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'accepted' check (status in ('accepted','revoked')),
  created_at timestamptz default now(),
  unique (patient_id, doctor_id)
);

-- ============================================================
-- Row Level Security — справжній захист на рівні бази даних.
-- Навіть якщо хтось підмінить запит у браузері, Postgres сам
-- не віддасть і не дозволить змінити чужі дані.
-- ============================================================

alter table public.profiles enable row level security;
alter table public.readings enable row level security;
alter table public.device_colors enable row level security;
alter table public.doctor_access enable row level security;

-- profiles: власний профіль повністю; профілі лікарів видно всім
-- автентифікованим (потрібно для пошуку лікаря за email при запрошенні)
create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or role = 'doctor');

-- profiles: лікар також бачить профіль ПАЦІЄНТА, який надав йому доступ
-- (без цієї політики ім'я/пошта пацієнта не підвантажується в списку лікаря)
create policy "profiles_select_granted_patient" on public.profiles
  for select using (
    exists (
      select 1 from public.doctor_access da
      where da.patient_id = profiles.id
        and da.doctor_id = auth.uid()
        and da.status = 'accepted'
    )
  );

create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid());

-- readings: пацієнт має повний доступ лише до своїх записів
create policy "readings_patient_all" on public.readings
  for all using (patient_id = auth.uid()) with check (patient_id = auth.uid());
-- readings: лікар бачить (тільки читання) записи пацієнтів, які надали доступ
create policy "readings_doctor_select" on public.readings
  for select using (
    exists (
      select 1 from public.doctor_access da
      where da.patient_id = readings.patient_id
        and da.doctor_id = auth.uid()
        and da.status = 'accepted'
    )
  );

-- device_colors: та сама логіка, що й readings
create policy "colors_patient_all" on public.device_colors
  for all using (patient_id = auth.uid()) with check (patient_id = auth.uid());
create policy "colors_doctor_select" on public.device_colors
  for select using (
    exists (
      select 1 from public.doctor_access da
      where da.patient_id = device_colors.patient_id
        and da.doctor_id = auth.uid()
        and da.status = 'accepted'
    )
  );

-- doctor_access: пацієнт керує своїми запрошеннями (додає/відкликає)
create policy "access_patient_manage" on public.doctor_access
  for all using (patient_id = auth.uid()) with check (patient_id = auth.uid());
-- doctor_access: лікар бачить записи, де він призначений лікарем
create policy "access_doctor_select" on public.doctor_access
  for select using (doctor_id = auth.uid());

-- ============================================================
-- Готово. Далі: Authentication → Providers → Email — переконайся,
-- що Email-провайдер увімкнений (за замовчуванням увімкнений).
-- Якщо не хочеш підтверджувати email при кожній реєстрації під час
-- тестів: Authentication → Settings → вимкнути "Confirm email".
-- ============================================================
