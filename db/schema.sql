-- ============================================================
--  모아버거 AI 음성주문 키오스크 - Supabase(PostgreSQL) 스키마
-- ------------------------------------------------------------
--  실행 위치:  Supabase 대시보드 > 좌측 메뉴 [SQL Editor] > New query
--             아래 전체를 붙여넣고 [Run] 클릭.
--  실행 순서:  1) schema.sql (이 파일)  →  2) seed_menus.sql (메뉴 데이터)
-- ============================================================

-- 재실행 편의를 위해 기존 객체 제거(운영 데이터가 있으면 주의!)
drop table if exists order_items cascade;
drop table if exists orders cascade;
drop table if exists menus cascade;

-- ------------------------------------------------------------
-- 1) 메뉴 테이블 : 코드 수정 없이 데이터로 메뉴 관리 (지침 NF-04)
-- ------------------------------------------------------------
create table menus (
    id            text primary key,                 -- 예: 'coffee_americano'
    category      text not null,                    -- burger | side | drink | coffee | smoothie_tea
    name          text not null,                    -- 한글 메뉴명
    name_en       text,                             -- 영문 메뉴명
    price         integer not null,                 -- 기본 가격(원)
    price_hot     integer,                          -- HOT 가격(온도별 가격차가 있을 때)
    price_ice     integer,                          -- ICE 가격
    temperature   text not null default 'none',     -- none | hot | ice | both
    emoji         text default '🍔',                 -- 메뉴 대표 이미지(이모지/URL 대체)
    image_url     text,                             -- 실사 이미지 URL(있으면 우선 사용)
    badge         text default '',                  -- '인기' | '추천' | ''
    tags          text[] default '{}',              -- 검색/매칭 보조 키워드
    aliases       text[] default '{}',              -- 음성 매칭용 별칭(사투리/줄임말/영어)
    sold_out      boolean not null default false,   -- 품절 여부
    sort_order    integer not null default 0,       -- 그리드 정렬 순서
    is_active     boolean not null default true,    -- 노출 여부
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index idx_menus_category on menus (category) where is_active;

-- ------------------------------------------------------------
-- 2) 주문 테이블 (모의 결제 결과 저장)
-- ------------------------------------------------------------
create table orders (
    id            uuid primary key default gen_random_uuid(),
    order_no      text not null unique,             -- 예: 'A-042'
    total_qty     integer not null default 0,
    total_price   integer not null default 0,
    status        text not null default 'paid',     -- paid | canceled (모의)
    input_method  text default 'touch',             -- touch | voice | mixed
    today_temp    numeric,                          -- 주문 시점 기온(참고)
    created_at    timestamptz not null default now()
);

create index idx_orders_created on orders (created_at desc);

-- ------------------------------------------------------------
-- 3) 주문 상세 항목
-- ------------------------------------------------------------
create table order_items (
    id            bigint generated always as identity primary key,
    order_id      uuid not null references orders(id) on delete cascade,
    menu_id       text,                             -- 메뉴 삭제되어도 주문내역 보존(FK 미설정)
    name          text not null,
    temperature   text default 'none',              -- HOT | ICE | none
    quantity      integer not null,
    unit_price    integer not null,
    line_total    integer not null
);

create index idx_order_items_order on order_items (order_id);

-- ------------------------------------------------------------
-- 4) updated_at 자동 갱신 트리거
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger trg_menus_updated
    before update on menus
    for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- 5) RLS(행 수준 보안) 설정
--    - 키오스크는 Supabase 'anon' 키로 접속.
--    - 메뉴: 활성 항목만 읽기 허용.
--    - 주문: 삽입(insert)만 허용, 읽기는 서버(service_role)만.
--    ⚠️ 운영에서는 주문 생성은 service_role 키를 쓰는 백엔드에서만 하는 것을 권장.
-- ------------------------------------------------------------
alter table menus enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

-- 메뉴: 누구나 활성 메뉴 조회 가능
create policy "menus_public_read"
    on menus for select
    using (is_active = true);

-- 주문/항목: anon 도 생성 가능(데모용). 운영 시 service_role 로 제한 권장.
create policy "orders_public_insert"
    on orders for insert
    with check (true);

create policy "order_items_public_insert"
    on order_items for insert
    with check (true);

-- (선택) 서비스 롤은 RLS 우회하므로 별도 정책 불필요.
