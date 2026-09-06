# 개발 문서 (dev.md)

모아푸드코트 AI 음성주문 키오스크의 **개발자용** 상세 문서입니다.
(전체 안내는 [`README.md`](README.md), 디자인·UX는 [`design.md`](design.md))

---

## 1. 아키텍처

```
┌───────────────────────── 브라우저 (키오스크) ─────────────────────────┐
│  static/index.html + css/style.css + js/app.js                        │
│   · 터치/마우스 UI   · 음성 UI(MediaRecorder)   · 장바구니/결제 UI       │
└───────────────┬───────────────────────────────────────────────────────┘
                │  fetch /api/*   (OpenAI 키는 절대 브라우저에 없음)
                ▼
┌───────────────────────── Flask 백엔드 (app.py) ───────────────────────┐
│  /api/config  /api/menu  /api/weather  /api/stt  /api/match  /api/order │
└──────┬───────────────┬────────────────────┬──────────────────────────┘
       ▼               ▼                    ▼
  OpenAI API      Supabase(PG)         OpenWeatherMap
  Whisper+GPT     menus/orders          기온 조회
```

핵심 원칙(지침 3장):
1. **이중 입력 동등성** — 음성으로 가능한 주문은 터치로도 가능.
2. **실패해도 막히지 않음** — 외부 연동 실패 시 자동 폴백, 터치는 항상 동작.
3. **키 은닉** — OpenAI 키는 백엔드 프록시에서만 사용.

---

## 2. 기술 스택

| 영역 | 채택 | 비고 |
|------|------|------|
| 백엔드 | **Flask 3** + flask-cors | 정적 서빙 + API 프록시(단일 서버) |
| 프론트 | **순수 HTML/CSS/JS** | 빌드 불필요, 키오스크 브라우저 호환성↑ |
| 음성 녹음 | Web **MediaRecorder** API | `audio/webm` |
| STT | OpenAI **whisper-1** | 사투리/영어 자동 감지 |
| 매칭 | OpenAI **gpt-4o-mini** | `response_format=json_object` 강제 |
| DB | **Supabase**(PostgreSQL) | 미설정 시 `data/menu.json` |
| 날씨 | OpenWeatherMap | 미설정 시 `DEFAULT_TEMP` |
| 배포 | 로컬 실행 / waitress | `requirements.txt` 에 waitress 포함 |

> 지침서는 프론트 React·백엔드 Node(Express)를 예시로 들었으나, 본 구현은
> 요청(“파이썬 프로그램”)에 맞춰 **백엔드·프록시를 Python(Flask)** 으로 통일했습니다.
> 프론트는 빌드 단계 없는 순수 HTML/JS로 두어 키오스크 배포를 단순화했습니다.

---

## 3. 환경변수 (.env)

`.env.example` 를 복사해 사용. 값이 비어 있으면 해당 기능만 폴백됩니다.

| 키 | 설명 | 기본/폴백 |
|----|------|-----------|
| `OPENAI_API_KEY` | 음성(STT+매칭) | 없으면 음성 OFF |
| `OPENAI_STT_MODEL` | STT 모델 | `whisper-1` |
| `OPENAI_MATCH_MODEL` | 매칭 모델 | `gpt-4o-mini` |
| `SUPABASE_URL` / `SUPABASE_KEY` | DB 접속 | 없으면 로컬 JSON |
| `WEATHER_API_KEY` | 날씨 | 없으면 DEFAULT_TEMP |
| `STORE_LAT` / `STORE_LON` | 매장 좌표 | 강남 인근 예시값 |
| `DEFAULT_TEMP` | 폴백 기온(℃) | `28` |
| `FLASK_HOST` / `FLASK_PORT` / `FLASK_DEBUG` | 서버 | `127.0.0.1:5000`, debug on |

---

## 4. 백엔드 API 명세

### GET `/api/config`
```json
{ "storeName":"모아푸드코트", "voiceEnabled":true, "supabaseEnabled":false,
  "todayTemp":28.0, "tempSource":"default", "recommendTemp":"ICE" }
```
프론트는 `voiceEnabled=false` 이면 음성 버튼을 숨깁니다.

### GET `/api/menu`
```json
{ "source":"supabase|local",
  "menus":[ { "id":"coffee_americano","category":"coffee","name":"아메리카노",
    "nameEn":"Americano","price":2500,"priceHot":2300,"priceIce":2500,
    "temperature":"both","emoji":"☕","badge":"인기","aliases":["아아","따아"] } ] }
```

### POST `/api/stt`  (multipart/form-data, field `audio`)
```json
{ "text":"시원한 아메리카노 한 잔 주세요" }
```
STT 처리 후 서버는 오디오를 저장하지 않습니다(개인정보 NF-03).

### POST `/api/match`  (application/json)
요청: `{ "text":"시원한 아메리카노 한 잔 주세요" }`
응답(지침 10.2 스키마 + 표시용 메타 보강):
```json
{ "status":"matched|need_temperature|not_found|unclear",
  "matched":[ {"menu_id":"coffee_americano","name":"아메리카노","quantity":1,
    "temperature":"ICE","ask_temperature":false,"suggested_temperature":"ICE",
    "emoji":"☕","price":2500,"priceIce":2500,"temperatureType":"both"} ],
  "recommendations":[ {"menu_id":"...","name":"...","reason":"...","emoji":"...","price":0} ],
  "assistant_message":"'아이스 아메리카노 한 잔' 맞으실까요?" }
```

### POST `/api/order`  (application/json)
요청:
```json
{ "inputMethod":"voice|touch|mixed",
  "items":[ {"menuId":"coffee_americano","name":"아메리카노","temperature":"ICE",
    "quantity":2,"unitPrice":2500,"lineTotal":5000} ] }
```
응답: `{ "success":true, "orderNo":"A-042", "totalQty":2, "totalPrice":5000, "saved":true }`

---

## 5. 음성 주문 파이프라인 (프론트)

`static/js/app.js` 의 `Voice` 모듈:

```
startVoice()
  └ getUserMedia(audio) → MediaRecorder.start()
  └ 6초 자동정지 또는 마이크 재탭 → stopVoiceRecording()
onRecordStop()
  └ Blob(webm) → POST /api/stt → showHeard(text)
  └ POST /api/match → handleMatch(result)
handleMatch()
  ├ matched/need_temperature → renderMatchedSheet()  (확인카드+온도/수량)
  ├ not_found(+추천)         → renderRecoSheet()      (유사메뉴 버튼)
  └ unclear/실패            → voiceFail()             (재시도/터치, 2회연속시 터치 전면유도)
```

상태 표시(지침 6.3): `듣고 있어요 → 주문을 확인하고 있어요… → 메뉴를 찾았어요`.
모든 안내는 화면 자막으로 동시에 노출됩니다.

> **무음 감지 대체**: 브라우저 표준만으로 정확한 무음 감지는 한계가 있어,
> 현재는 6초 자동 종료 + 사용자 재탭 방식입니다. 필요 시 `AudioContext` 기반
> RMS 임계값 무음 감지로 개선 가능(향후 과제).

---

## 6. GPT 매칭 프롬프트

`app.py > build_system_prompt(menus, today_temp)` 가 지침 10.2 시스템 프롬프트를 생성합니다.
- 판매 메뉴는 `id·name·aliases·temperature` 만 slim하게 전달(토큰 절약 + 별칭으로 정확도↑).
- `temperature="both"` 인데 사용자가 온도 미지정 → `ask_temperature=true`, `suggested_temperature`에 날씨 추천값.
- 없는 메뉴 → `recommendations` 2~3개.
- `temperature=0`, `response_format=json_object` 로 안정적 JSON 강제.

---

## 7. 온도 추천 로직 (지침 11장)

```python
def recommend_temperature(temp):   # 25℃ 이상 ICE, 미만 HOT
    return "ICE" if temp >= 25 else "HOT"
```
적용 지점: 시작/메인 배너 추천 칩, 음성 매칭의 `suggested_temperature`, 옵션 모달 기본 온도.
추천은 **제안일 뿐**이며 사용자는 반대 온도를 항상 선택할 수 있습니다.

---

## 8. 데이터베이스

- 스키마: `db/schema.sql` — `menus`, `orders`, `order_items` + RLS + updated_at 트리거.
- 시드: `db/seed_menus.sql` — `data/menu.json` 으로부터 생성됨.
- 생성 위치/순서는 [`README.md` 3장](README.md#3-데이터베이스supabase-만들기--sql--실행-위치) 참고.

시드 재생성(메뉴 수정 후):
```python
# scripts 없이 인라인으로 생성 가능 — README 참고. 요지:
import json
menus = json.load(open("data/menu.json", encoding="utf-8"))
# → INSERT ... ON CONFLICT DO UPDATE 문으로 db/seed_menus.sql 재작성
```

RLS 요약:
- `menus` : 활성 메뉴 **읽기 공개**.
- `orders`/`order_items` : anon **insert 허용**(데모). 운영에서는 백엔드 `service_role` 로 제한 권장.

---

## 9. 결제(모의) 및 확장 지점

`app.py > api_order()` 가 주문번호를 발급하고 Supabase에 저장합니다.
실제 PG 연동 시 이 지점만 교체(지침 13.4 `processPayment` 인터페이스):

```python
# 실제 PG 연동 시 이 지점만 교체 (토스페이먼츠/나이스페이 등)
return jsonify({"success": True, "orderNo": order_no, ...})
```

---

## 10. 로컬 실행/디버깅

```bat
python app.py            REM 개발 (FLASK_DEBUG=1)
```
프로덕션(선택):
```bat
waitress-serve --host=127.0.0.1 --port=5000 app:app
```
헬스체크: `GET /api/health` → `{"ok":true,"voiceEnabled":...,"supabaseEnabled":...}`

---

## 11. 테스트 관점 (지침 17장)

- 기능: 탭 전환/담기/수량/삭제/합계, `both` 메뉴 HOT/ICE 분기, 모의결제 주문번호.
- 음성 시나리오: 표준어/사투리/영어/온도미지정/없는메뉴/복수주문/모호발화.
- 온도: 28℃→ICE, 18℃→HOT, 경계 25℃→ICE.
- 사용성: 시니어 5~8명 과업 성공률·시간, 폴백 흐름 자연스러움.

---

## 12. 향후 과제 (지침 18장)

실제 PG 연동 · 다국어 UI · TTS 음성응답 · 회원/적립 · 관리자 백오피스 ·
오프라인 캐시 · 판매 패턴 대시보드 · 무음 감지 고도화.
