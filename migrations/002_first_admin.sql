-- Первый админ.
--
-- Порядок: заведи пользователя в Supabase → Authentication → Users, зайди им
-- один раз (триггер on_auth_user_created создаст профиль с ролью operator),
-- затем выполни это, подставив свой адрес. Роль намеренно не раздаётся из
-- приложения: право менять себе role — это право стать админом.

update public.profiles
   set role = 'admin'
 where email = 'admin@vyatkapoker.ru';

select id, email, role from public.profiles order by created_at;
