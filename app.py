# -*- coding: utf-8 -*-
"""
모아푸드코트 AI 음성주문 키오스크 - Flask 백엔드
------------------------------------------------------------
역할:
  1) 프론트엔드 정적 파일 서빙 (static/)
  2) OpenAI 프록시  : /api/stt (Whisper), /api/match (GPT 메뉴매칭)
     -> OpenAI API 키를 브라우저에 절대 노출하지 않음 (지침 15장)
  3) 메뉴 제공      : /api/menu  (Supabase 우선, 없으면 data/menu.json)
  4) 날씨/온도 추천 : /api/weather
  5) 모의 결제      : /api/order (주문번호 발급 + Supabase 저장 시도)

설계 원칙:
  - 모든 외부 연동(OpenAI/Supabase/날씨)은 '없어도 앱이 동작'하도록 폴백.
  - 터치 주문은 어떤 상황에서도 항상 가능 (지침 NF-02 가용성).

실행:
  python app.py     또는     flask run
"""
import os
import io
import json
import random
import string
import datetime as dt
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

# ------------------------------------------------------------
# 환경변수 로드
# ------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_STT_MODEL = os.getenv("OPENAI_STT_MODEL", "whisper-1").strip()
OPENAI_MATCH_MODEL = os.getenv("OPENAI_MATCH_MODEL", "gpt-4o-mini").strip()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()

WEATHER_API_KEY = os.getenv("WEATHER_API_KEY", "").strip()
STORE_LAT = os.getenv("STORE_LAT", "37.4979").strip()
STORE_LON = os.getenv("STORE_LON", "127.0276").strip()
DEFAULT_TEMP = float(os.getenv("DEFAULT_TEMP", "28") or 28)

HOST = os.getenv("FLASK_HOST", "127.0.0.1")
PORT = int(os.getenv("FLASK_PORT", "5000"))
DEBUG = os.getenv("FLASK_DEBUG", "1") == "1"

# 기능 활성화 플래그
VOICE_ENABLED = bool(OPENAI_API_KEY)
SUPABASE_ENABLED = bool(SUPABASE_URL and SUPABASE_KEY)
# 메뉴 노출 소스: local(기본, data/menu.json) | supabase
MENU_SOURCE = os.getenv("MENU_SOURCE", "local").strip().lower()

# ------------------------------------------------------------
# 선택적 클라이언트 초기화 (설치/키 없어도 앱은 뜬다)
# ------------------------------------------------------------
openai_client = None
if VOICE_ENABLED:
    try:
        from openai import OpenAI
        openai_client = OpenAI(api_key=OPENAI_API_KEY)
    except Exception as e:  # noqa
        print(f"[warn] OpenAI 초기화 실패 → 음성주문 비활성화: {e}")
        VOICE_ENABLED = False

supabase = None
if SUPABASE_ENABLED:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:  # noqa
        print(f"[warn] Supabase 초기화 실패 → 로컬 menu.json 사용: {e}")
        SUPABASE_ENABLED = False

# ------------------------------------------------------------
# 메뉴 로드 (Supabase 우선, 실패 시 로컬 json)
# ------------------------------------------------------------
LOCAL_MENU_PATH = BASE_DIR / "data" / "menu.json"


def load_local_menu():
    with open(LOCAL_MENU_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_menus():
    """활성 메뉴 리스트 반환. Supabase 실패 시 자동으로 로컬 폴백."""
    if MENU_SOURCE == "supabase" and SUPABASE_ENABLED and supabase is not None:
        try:
            res = (
                supabase.table("menus")
                .select("*")
                .eq("is_active", True)
                .order("sort_order")
                .execute()
            )
            rows = res.data or []
            if rows:
                # DB 스네이크케이스 → 프론트 카멜케이스 변환
                out = []
                for r in rows:
                    out.append({
                        "id": r["id"],
                        "category": r["category"],
                        "name": r["name"],
                        "nameEn": r.get("name_en"),
                        "price": r["price"],
                        "priceHot": r.get("price_hot"),
                        "priceIce": r.get("price_ice"),
                        "temperature": r.get("temperature", "none"),
                        "emoji": r.get("emoji", "🍔"),
                        "imageUrl": r.get("image_url"),
                        "badge": r.get("badge", ""),
                        "tags": r.get("tags", []),
                        "aliases": r.get("aliases", []),
                        "soldOut": r.get("sold_out", False),
                    })
                return out, "supabase"
        except Exception as e:  # noqa
            print(f"[warn] Supabase 메뉴 조회 실패 → 로컬 폴백: {e}")
    return load_local_menu(), "local"


# ------------------------------------------------------------
# 날씨/온도
# ------------------------------------------------------------
def get_today_temp():
    """현재 기온(℃) 반환. 실패 시 DEFAULT_TEMP."""
    if WEATHER_API_KEY:
        try:
            import requests
            url = (
                "https://api.openweathermap.org/data/2.5/weather"
                f"?lat={STORE_LAT}&lon={STORE_LON}&units=metric&appid={WEATHER_API_KEY}"
            )
            r = requests.get(url, timeout=4)
            r.raise_for_status()
            return round(float(r.json()["main"]["temp"]), 1), "api"
        except Exception as e:  # noqa
            print(f"[warn] 날씨 API 실패 → 기본 기온 사용: {e}")
    return DEFAULT_TEMP, "default"


def recommend_temperature(temp):
    """25℃ 이상 → ICE, 미만 → HOT (지침 11장)"""
    return "ICE" if temp >= 25 else "HOT"


# ------------------------------------------------------------
# GPT 매칭용 시스템 프롬프트 (지침 10.2)
# ------------------------------------------------------------
def build_system_prompt(menus, today_temp):
    slim = [
        {
            "menu_id": m["id"],
            "name": m["name"],
            "aliases": m.get("aliases", []),
            "temperature": m.get("temperature", "none"),
        }
        for m in menus if not m.get("soldOut")
    ]
    menu_list_json = json.dumps(slim, ensure_ascii=False)
    return f"""당신은 패스트푸드/카페 키오스크의 주문 도우미입니다.
사용자의 자유로운 발화(사투리, 영어 포함)를 아래 '판매 메뉴 목록' 안의 실제 메뉴로 매칭하세요.

규칙:
1. 반드시 목록에 있는 menu_id만 사용합니다. 목록에 없으면 매칭하지 마세요.
2. 요청한 메뉴가 목록에 없으면, 가장 비슷한 메뉴 2~3개를 recommendations에 담으세요.
3. 온도 선택(HOT/ICE, temperature="both")이 가능한 메뉴인데 사용자가 명시하지 않았다면
   temperature를 null로 두고 ask_temperature를 true로 설정하세요.
4. 수량이 명시되지 않으면 1로 간주합니다.
5. 오늘 기온은 {today_temp}℃ 입니다. 사용자가 온도를 고르지 않은 음료라면
   25℃ 이상은 ICE, 미만은 HOT을 suggested_temperature로 제안하세요.
6. 반드시 아래 JSON 스키마로만 답하세요. 설명 문장 금지.

판매 메뉴 목록:
{menu_list_json}

출력 스키마:
{{
  "matched": [
    {{"menu_id": "string", "name": "string", "quantity": number,
     "temperature": "HOT|ICE|null", "ask_temperature": boolean,
     "suggested_temperature": "HOT|ICE|null"}}
  ],
  "recommendations": [
    {{"menu_id": "string", "name": "string", "reason": "string"}}
  ],
  "status": "matched | need_temperature | not_found | unclear",
  "assistant_message": "사용자에게 보여줄 한 줄 확인 문구"
}}"""


# ------------------------------------------------------------
# 주문번호 생성
# ------------------------------------------------------------
def generate_order_no():
    letter = random.choice(string.ascii_uppercase)
    num = random.randint(1, 999)
    return f"{letter}-{num:03d}"


# ============================================================
# Flask 앱
# ============================================================
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)


# ---------- 정적 페이지 ----------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------- 설정/상태 ----------
@app.route("/api/config")
def api_config():
    temp, temp_src = get_today_temp()
    return jsonify({
        "storeName": "모아푸드코트",
        "voiceEnabled": VOICE_ENABLED,      # 음성주문 버튼 노출 여부
        "supabaseEnabled": SUPABASE_ENABLED,
        "todayTemp": temp,
        "tempSource": temp_src,             # api | default
        "recommendTemp": recommend_temperature(temp),
    })


# ---------- 메뉴 ----------
@app.route("/api/menu")
def api_menu():
    menus, source = get_menus()
    return jsonify({"menus": menus, "source": source})


# ---------- 날씨 ----------
@app.route("/api/weather")
def api_weather():
    temp, src = get_today_temp()
    return jsonify({
        "temp": temp,
        "source": src,
        "recommend": recommend_temperature(temp),
    })


# ---------- STT (음성 → 텍스트) ----------
@app.route("/api/stt", methods=["POST"])
def api_stt():
    if not VOICE_ENABLED:
        return jsonify({"error": "voice_disabled",
                        "message": "음성 기능이 비활성화되어 있습니다(OPENAI_API_KEY 필요)."}), 503
    if "audio" not in request.files:
        return jsonify({"error": "no_audio"}), 400
    f = request.files["audio"]
    try:
        audio_bytes = f.read()
        buf = io.BytesIO(audio_bytes)
        buf.name = f.filename or "order.webm"   # openai SDK 는 파일명 확장자로 포맷 추론
        tr = openai_client.audio.transcriptions.create(
            file=buf,
            model=OPENAI_STT_MODEL,
            # language 미지정 → 자동 감지(한국어/영어 혼용 대응)
        )
        return jsonify({"text": tr.text})
    except Exception as e:  # noqa
        print(f"[error] STT 실패: {e}")
        return jsonify({"error": "stt_failed", "message": str(e)}), 502


# ---------- GPT 메뉴 매칭 ----------
@app.route("/api/match", methods=["POST"])
def api_match():
    if not VOICE_ENABLED:
        return jsonify({"error": "voice_disabled"}), 503
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"status": "unclear",
                        "assistant_message": "다시 말씀해 주시거나 화면을 눌러 주세요.",
                        "matched": [], "recommendations": []})

    menus, _ = get_menus()
    today_temp, _ = get_today_temp()
    try:
        completion = openai_client.chat.completions.create(
            model=OPENAI_MATCH_MODEL,
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": build_system_prompt(menus, today_temp)},
                {"role": "user", "content": text},
            ],
        )
        result = json.loads(completion.choices[0].message.content)

        # 매칭 결과에 가격/이모지 등 표시용 메타 보강
        menu_by_id = {m["id"]: m for m in menus}
        for item in result.get("matched", []):
            m = menu_by_id.get(item.get("menu_id"))
            if m:
                item["emoji"] = m.get("emoji", "🍔")
                item["temperatureType"] = m.get("temperature", "none")
                item["price"] = m.get("price")
                item["priceHot"] = m.get("priceHot")
                item["priceIce"] = m.get("priceIce")
        for rec in result.get("recommendations", []):
            m = menu_by_id.get(rec.get("menu_id"))
            if m:
                rec["emoji"] = m.get("emoji", "🍔")
                rec["price"] = m.get("price")
        result["_recognizedText"] = text
        return jsonify(result)
    except Exception as e:  # noqa
        print(f"[error] 매칭 실패: {e}")
        return jsonify({"status": "unclear",
                        "assistant_message": "죄송해요, 다시 한 번 말씀해 주시거나 화면을 눌러 주세요.",
                        "matched": [], "recommendations": [],
                        "error": str(e)}), 200  # 프론트 폴백 유도(200)


# ---------- 모의 결제/주문 저장 ----------
@app.route("/api/order", methods=["POST"])
def api_order():
    body = request.get_json(force=True, silent=True) or {}
    items = body.get("items", [])
    if not items:
        return jsonify({"error": "empty_cart"}), 400

    total_qty = sum(int(i.get("quantity", 0)) for i in items)
    total_price = sum(int(i.get("lineTotal", 0)) for i in items)
    order_no = generate_order_no()
    input_method = body.get("inputMethod", "touch")
    today_temp, _ = get_today_temp()

    # Supabase 저장 시도 (실패해도 주문은 성공 처리 - 무중단)
    saved = False
    if SUPABASE_ENABLED and supabase is not None:
        try:
            ins = supabase.table("orders").insert({
                "order_no": order_no,
                "total_qty": total_qty,
                "total_price": total_price,
                "status": "paid",
                "input_method": input_method,
                "today_temp": today_temp,
            }).execute()
            order_id = ins.data[0]["id"]
            rows = [{
                "order_id": order_id,
                "menu_id": i.get("menuId"),
                "name": i.get("name"),
                "temperature": i.get("temperature", "none"),
                "quantity": int(i.get("quantity", 1)),
                "unit_price": int(i.get("unitPrice", 0)),
                "line_total": int(i.get("lineTotal", 0)),
            } for i in items]
            supabase.table("order_items").insert(rows).execute()
            saved = True
        except Exception as e:  # noqa
            print(f"[warn] 주문 저장 실패(무시하고 진행): {e}")

    # 실제 PG 연동 시 이 지점만 교체 (지침 13.4 processPayment 인터페이스)
    return jsonify({
        "success": True,
        "orderNo": order_no,
        "totalQty": total_qty,
        "totalPrice": total_price,
        "saved": saved,
    })


@app.route("/api/health")
def health():
    return jsonify({"ok": True,
                    "voiceEnabled": VOICE_ENABLED,
                    "supabaseEnabled": SUPABASE_ENABLED})


if __name__ == "__main__":
    print("=" * 56)
    print("  모아푸드코트 AI 음성주문 키오스크")
    print(f"  - 음성주문(OpenAI) : {'ON' if VOICE_ENABLED else 'OFF (터치주문만)'}")
    print(f"  - Supabase DB      : {'ON' if SUPABASE_ENABLED else 'OFF (로컬 menu.json)'}")
    print(f"  - 접속 주소        : http://{HOST}:{PORT}")
    print(f"  - 서버 모드        : {'개발(auto-reload)' if DEBUG else '프로덕션(waitress)'}")
    print("=" * 56)

    if DEBUG:
        # 개발 모드: auto-reload 지원, 단 Flask WARNING 표시됨
        app.run(host=HOST, port=PORT, debug=True)
    else:
        # 프로덕션 모드: waitress 사용 (WARNING 없음)
        from waitress import serve
        serve(app, host=HOST, port=PORT)
