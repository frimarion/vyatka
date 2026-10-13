-- Своя аватарка игрока.
--
-- Зачем: VK ID с какого-то момента отдаёт аватарку ссылкой, подписанной только
-- на 50×50 (as=50x50,32x32,48x48) — крупнее по ней не выпросить, VK отвечает
-- 404. Поэтому у игроков, вошедших позже, фото в профиле и особенно при
-- раскрытии мутное. Своя картинка решает и это, и просто желание сменить фото.
--
-- Файл кладём в публичный бакет Storage `avatars`, грузит его эдж-функция
-- `avatar` (supabase/functions/avatar) сервисным ключом: у игроков нет JWT
-- GoTrue, только наш токен сессии, и RLS Storage его не проверит. Функция
-- спрашивает у базы, чей это токен, и записывает ссылку — обе функции ниже
-- доступны только service_role.
--
-- Вход через VK/TG не перетрёт своё фото: везде photo_url = coalesce(photo_url, …).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.vp_avatar_session(p_token text)
returns bigint
language sql
security definer
set search_path = public, extensions
as $$ select public.vp_session_player(p_token) $$;

-- Возвращает прежнюю ссылку: если это тоже наш файл, функция его удалит.
create or replace function public.vp_avatar_set(p_player_id bigint, p_url text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old text;
begin
  select photo_url into v_old from public.players where id = p_player_id for update;
  if not found then
    raise exception 'player_not_found';
  end if;
  update public.players set photo_url = nullif(btrim(p_url), '') where id = p_player_id;
  return v_old;
end;
$$;

revoke all on function public.vp_avatar_session(text)       from public, anon, authenticated;
revoke all on function public.vp_avatar_set(bigint, text)   from public, anon, authenticated;
grant execute on function public.vp_avatar_session(text)     to service_role;
grant execute on function public.vp_avatar_set(bigint, text) to service_role;
