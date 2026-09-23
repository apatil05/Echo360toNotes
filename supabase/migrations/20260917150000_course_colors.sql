-- Course cover colours. Each course keeps one colour everywhere it appears,
-- and a student's courses use all eight theme colours before any repeats.
-- (Letting students choose a colour is a later version; the column allows it.)

alter table public.courses
  add column color text check (color in ('violet', 'coral', 'teal', 'blue', 'pink', 'amber', 'green', 'indigo'));

create or replace function public.assign_course_color()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.color is null then
    select palette.color into new.color
      from unnest(array['violet', 'coral', 'teal', 'blue', 'pink', 'amber', 'green', 'indigo'])
             with ordinality as palette(color, ord)
      left join public.courses used
        on used.user_id = new.user_id and used.color = palette.color
     group by palette.color, palette.ord
     order by count(used.id), palette.ord
     limit 1;
  end if;
  return new;
end;
$$;

revoke all on function public.assign_course_color() from public, anon, authenticated;

create trigger courses_assign_color
  before insert on public.courses
  for each row execute function public.assign_course_color();

-- Existing courses, oldest first per student.
do $$
declare
  c record;
begin
  for c in select id from public.courses order by user_id, created_at, id loop
    update public.courses
       set color = (
         select palette.color
           from unnest(array['violet', 'coral', 'teal', 'blue', 'pink', 'amber', 'green', 'indigo'])
                  with ordinality as palette(color, ord)
           left join public.courses used
             on used.user_id = (select user_id from public.courses where id = c.id)
            and used.color = palette.color
          group by palette.color, palette.ord
          order by count(used.id), palette.ord
          limit 1)
     where id = c.id;
  end loop;
end;
$$;

alter table public.courses alter column color set not null;
