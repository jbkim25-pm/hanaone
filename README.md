# 🍔 모아푸드코트 — AI 음성주문 키오스크

시니어를 포함한 **모든 세대가 쉽게 주문하는** 음성 · 터치 하이브리드 키오스크입니다.
말로 주문하거나(🎤 OpenAI Whisper + GPT), 화면을 터치/클릭해서 주문할 수 있습니다.

> 기존 키오스크는 그대로 두고 **AI 음성 주문 기능만 추가**한다 — 개발 지침서 v1.0 기반 구현.

- 🗣️ **음성 주문**: 사투리·영어 발화 인식 → 메뉴 자동 매칭 → 확인 후 담기
- 👆 **터치/마우스 주문**: 큰 버튼·큰 글씨의 접근성 우선 UI (음성과 100% 동등)
- 🌤️ **날씨 추천**: 당일 기온 25℃ 이상 아이스 / 미만 따뜻한 음료 자동 추천
- 🛒 **장바구니 · 모의 결제**: 주문번호 발급까지 완결 (실제 PG 연동 지점 분리)
- ♻️ **무중단 설계**: OpenAI/Supabase/날씨 키가 없어도 **터치 주문은 항상 동작**

문서 안내: 개발 상세는 [`dev.md`](dev.md), 디자인·UX는 [`design.md`](design.md) 참고.

---

## 1. 빠른 시작 (3분)

Windows 기준, 프로젝트 폴더는 `D:\ai-agent\hanaone` 입니다.

```bat
cd D:\ai-agent\hanaone

REM (1) 가상환경 활성화  ※ .venv 는 이미 생성되어 있음
.venv\Scripts\activate

REM (2) 패키지 설치
pip install -r requirements.txt

REM (3) 환경변수 파일 준비 (키가 없어도 실행됩니다)
copy .env.example .env

REM (4) 실행
python app.py
```

브라우저에서 **http://127.0.0.1:5000** 접속.
키오스크는 브라우저 **전체화면(F11)** 으로 사용하는 것을 권장합니다.

> ⚠️ 마이크(음성주문)는 보안 컨텍스트에서만 동작합니다.
> `localhost`/`127.0.0.1` 은 허용되며, 다른 PC에서 접속하려면 HTTPS가 필요합니다.

---

## 2. 실행 모드 — 키가 없어도 켜집니다

| 기능 | 필요한 키 | 없을 때 동작 |
|------|-----------|--------------|
| 음성 주문(STT+매칭) | `OPENAI_API_KEY` | 음성 버튼 자동 숨김, **터치 주문만** |
| 메뉴/주문 저장 | `SUPABASE_URL`, `SUPABASE_KEY` | 로컬 `data/menu.json` 사용, 주문은 메모리 처리 |
| 날씨 추천 | `WEATHER_API_KEY` | `.env` 의 `DEFAULT_TEMP`(기본 28℃) 사용 |

즉, **아무 키 없이 `python app.py` 만 해도 데모가 바로 동작**합니다.
음성까지 쓰려면 `.env` 에 `OPENAI_API_KEY` 만 넣으면 됩니다.

---

## 3. 데이터베이스(Supabase) 만들기 — SQL & 실행 위치

DB는 **Supabase(PostgreSQL)** 에 만듭니다. (없어도 로컬 `data/menu.json` 으로 동작)

### 3-1. Supabase 프로젝트 준비
1. https://supabase.com 접속 → 로그인 → **New project** 생성.
2. 프로젝트가 생성되면 좌측 하단 **⚙️ Project Settings → API** 이동.
3. 아래 두 값을 복사해 `.env` 에 붙여넣기:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** 키(또는 서버 전용이면 `service_role`) → `SUPABASE_KEY`

### 3-2. 테이블 생성 SQL 실행 (⭐ 어디서 만드나요?)
> **위치: Supabase 대시보드 → 좌측 메뉴 [SQL Editor] → [+ New query]**
> 아래 순서대로 붙여넣고 각각 **[Run]** (단축키 Ctrl/Cmd+Enter)

1. **1단계 — 테이블 생성**: `db/schema.sql` 전체 내용을 붙여넣고 실행
   → `menus`, `orders`, `order_items` 테이블 + RLS 정책 생성
2. **2단계 — 메뉴 시드**: `db/seed_menus.sql` 전체 내용을 붙여넣고 실행
   → 31종 메뉴 데이터 입력

실행 후 좌측 **[Table Editor]** 에서 `menus` 테이블에 31행이 보이면 성공입니다.

### 3-3. 메뉴 데이터 관리
- 메뉴 추가/수정/품절/가격변경은 **코드 수정 없이** `menus` 테이블에서 직접 하거나,
  `data/menu.json` 을 고친 뒤 `db/seed_menus.sql` 을 재생성해 다시 Run 하면 됩니다.
- `sold_out` 을 `true` 로 바꾸면 화면에서 흐리게 비활성화됩니다.

> 📁 SQL 파일 위치: [`db/schema.sql`](db/schema.sql) · [`db/seed_menus.sql`](db/seed_menus.sql)

---

## 4. 외부 연동(솔루션) 정리

| 연동 | 용도 | 발급처 | 필수 여부 |
|------|------|--------|-----------|
| **OpenAI** | Whisper(STT) + GPT(메뉴 매칭) | https://platform.openai.com/api-keys | 음성 기능에 필요 |
| **Supabase** | 메뉴·주문 DB (PostgreSQL) | https://supabase.com | 선택(폴백 있음) |
| **OpenWeatherMap** | 당일 기온 조회 | https://openweathermap.org/api | 선택(폴백 있음) |

> 🔐 **보안**: OpenAI 키는 **백엔드(app.py)에서만** 사용되며 브라우저에 절대 노출되지 않습니다.
> 프론트엔드는 우리 서버의 `/api/*` 프록시만 호출합니다. `.env` 는 `.gitignore` 로 커밋 제외됩니다.

---

## 5. 폴더 구조

```
hanaone/
├─ app.py                 # Flask 백엔드 (정적 서빙 + OpenAI/Supabase/날씨 프록시)
├─ requirements.txt       # 설치할 Python 패키지
├─ .env.example           # 환경변수 예시 (복사해서 .env 로 사용)
├─ .gitignore
├─ README.md / dev.md / design.md
├─ data/
│  └─ menu.json           # 31종 메뉴 (Supabase 미사용 시 폴백 원본)
├─ db/
│  ├─ schema.sql          # 테이블 생성 DDL + RLS
│  └─ seed_menus.sql      # 메뉴 31종 시드 (menu.json 에서 생성)
└─ static/                # 프론트엔드
   ├─ index.html          # 전체 화면(시작/주문/음성/장바구니/확인/완료)
   ├─ css/style.css       # 디자인 토큰·시니어 접근성 스타일
   └─ js/app.js           # 하이브리드 입력·장바구니·음성 파이프라인
```

---

## 6. 주요 화면 흐름

```
[시작] 화면 터치 or 🎤 → [메인 주문] ─┬─ 터치: 카드 → 옵션(온도/수량) → 담기
                                    └─ 음성: 🎤 → 인식 → 확인카드 → 담기
   → [장바구니](수량변경/삭제) → [주문 확인] → 💳 모의결제 → [완료: 주문번호] → 자동 초기화
```

음성 인식이 실패하거나 메뉴가 없으면 → **유사 메뉴 추천** 또는 **터치 주문**으로 자연스럽게 유도됩니다.

---

## 7. API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/config` | 매장명·음성사용여부·오늘 기온·추천온도 |
| GET | `/api/menu` | 메뉴 목록(Supabase 우선, 실패 시 로컬) |
| GET | `/api/weather` | 현재 기온·ICE/HOT 추천 |
| POST | `/api/stt` | 오디오(webm) → 텍스트 (Whisper) |
| POST | `/api/match` | 텍스트 → 구조화 주문 JSON (GPT) |
| POST | `/api/order` | 모의 결제 → 주문번호 발급·저장 |

자세한 요청/응답 스키마는 [`dev.md`](dev.md) 참고.

---

## 8. 자주 묻는 문제

- **음성 버튼이 안 보여요** → `.env` 에 `OPENAI_API_KEY` 가 비어 있거나, 브라우저가 마이크를 지원하지 않는 경우입니다. 터치 주문은 정상 동작합니다.
- **마이크 권한 팝업이 안 떠요** → `http://localhost:5000` / `http://127.0.0.1:5000` 로 접속했는지 확인하세요(HTTP는 localhost만 마이크 허용).
- **메뉴가 안 나와요** → 로컬 폴백이 있어 보통 나옵니다. 콘솔 로그와 `data/menu.json` 을 확인하세요.
- **Supabase 저장이 안 돼요** → 주문은 저장 실패해도 정상 완료됩니다(무중단). 키/RLS 정책을 확인하세요.

---

*본 프로젝트는 개발 지침서 v1.0 을 기준으로 구현된 MVP 이며, 실제 운영 전 가격·메뉴·PG 연동 검증이 필요합니다.*
