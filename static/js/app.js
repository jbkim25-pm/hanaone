/* ============================================================
   모아푸드코트 키오스크 프론트엔드 로직
   - 하이브리드 입력: 음성(MediaRecorder→/api/stt→/api/match) + 터치/클릭
   - 폴백: 음성 실패/미지원 시 항상 터치 주문 가능 (지침 NF-02)
   - 메뉴 실사진: imageUrl(키워드 자동연결) 표시, 실패 시 이모지 폴백
   ============================================================ */
'use strict';

const State = {
  config: { storeName: '모아푸드코트', voiceEnabled: false, todayTemp: 28, recommendTemp: 'ICE' },
  menus: [],
  byId: {},
  cart: [],                 // {menuId,name,emoji,temperature,quantity,unitPrice,lineTotal}
  category: 'burger',
  inputMethod: 'touch',     // 주문에 사용된 입력 방식 추적
  option: null,             // 옵션 모달 임시 상태
};

const CATEGORIES = [
  { id: 'burger',  label: '버거',  emoji: '🍔' },
  { id: 'coffee',  label: '커피',  emoji: '☕' },
  { id: 'bunsik',  label: '분식',  emoji: '🍙' },
  { id: 'korean',  label: '한식',  emoji: '🍲' },
  { id: 'chinese', label: '중식',  emoji: '🍜' },
  { id: 'western', label: '양식',  emoji: '🍱' },
];

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const won = n => (n || 0).toLocaleString('ko-KR') + '원';

/* ---------- 메뉴 실사진 썸네일 (이모지 폴백) ---------- */
function menuThumb(m) {
  const emoji = (m && m.emoji) || '🍽️';
  if (m && m.imageUrl) {
    return `<img class="thumb-img" src="${m.imageUrl}" alt="${m.name || ''}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'"><span class="thumb-emoji">${emoji}</span>`;
  }
  return `<span class="thumb-emoji">${emoji}</span>`;
}

/* ---------- 화면 전환 ---------- */
function show(screenId) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + screenId).classList.add('active');
  const grid = $('#menuGrid');
  if (grid) grid.scrollTop = 0;
}

/* ---------- 토스트 ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ============================================================
   초기화
   ============================================================ */
async function init() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    State.config = cfg;
  } catch (e) { console.warn('config 로드 실패, 기본값 사용', e); }

  try {
    const data = await fetch('/api/menu').then(r => r.json());
    State.menus = data.menus || [];
    State.byId = Object.fromEntries(State.menus.map(m => [m.id, m]));
  } catch (e) {
    console.error('메뉴 로드 실패', e);
    toast('메뉴를 불러오지 못했어요');
  }

  applyWeatherUI();
  renderTabs();
  renderGrid();
  updateCartBar();
  bindEvents();

  // 음성 미지원(키 없음 or 브라우저 미지원)이면 음성 버튼 숨김
  if (!State.config.voiceEnabled || !navigator.mediaDevices?.getUserMedia) {
    $('#micFab').classList.add('hidden');
    $('#btnStartVoice').style.display = 'none';
  }
}

/* ---------- 날씨 UI ---------- */
function applyWeatherUI() {
  const t = State.config.todayTemp;
  const isIce = State.config.recommendTemp === 'ICE';
  const word = isIce ? '시원한' : '따뜻한';
  $('#startWeatherChip').innerHTML = `☀️ <b>${t}℃</b> · ${word} 메뉴`;
  $('#weatherTitle').innerHTML = `오늘은 <b>${t}℃</b>, ${word} 메뉴 어떠세요?`;
  $('#weatherSub').textContent = `AI가 오늘 날씨에 맞춰 ${isIce ? '아이스' : '따뜻한'} 메뉴를 추천해요`;

  // 추천 칩: 추천 온도에 맞는 커피 2개
  const picks = State.menus
    .filter(m => m.category === 'coffee')
    .filter(m => isIce ? (m.temperature === 'ice' || m.temperature === 'both')
                       : (m.temperature === 'hot' || m.temperature === 'both'))
    .slice(0, 2);
  const recWrap = $('#weatherRecs');
  recWrap.innerHTML = '';
  picks.forEach(m => {
    const chip = document.createElement('button');
    chip.className = 'rec-chip';
    chip.textContent = `${m.emoji} ${isIce ? '아이스 ' : ''}${m.name}`;
    chip.onclick = () => openOption(m.id, isIce ? 'ICE' : 'HOT');
    recWrap.appendChild(chip);
  });
}

/* ---------- 탭 ---------- */
function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  CATEGORIES.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (c.id === State.category ? ' active' : '');
    btn.innerHTML = `<div class="tab-emoji">${c.emoji}</div><div class="tab-label">${c.label}</div>`;
    btn.onclick = () => { State.category = c.id; renderTabs(); renderGrid(); };
    wrap.appendChild(btn);
  });
}

/* ---------- 메뉴 그리드 ---------- */
function tempBadge(t) {
  if (t === 'ice')  return '<span class="menu-temp-badge tb-ice">🧊 ICE</span>';
  if (t === 'hot')  return '<span class="menu-temp-badge tb-hot">🔥 HOT</span>';
  if (t === 'both') return '<span class="menu-temp-badge tb-both">🌡 HOT·ICE</span>';
  return '';
}
function renderGrid() {
  const grid = $('#menuGrid');
  grid.innerHTML = '';
  const list = State.menus.filter(m => m.category === State.category);
  if (!list.length) {
    grid.innerHTML = '<div class="cart-empty">메뉴를 준비 중이에요</div>';
    return;
  }
  list.forEach(m => {
    const card = document.createElement('div');
    card.className = 'menu-card' + (m.soldOut ? ' soldout' : '');
    const badge = m.badge === '추천'
      ? '<div class="menu-badge rec">추천</div>'
      : (m.badge ? `<div class="menu-badge">${m.badge}</div>` : '');
    const thumb = `<div class="menu-thumb">${menuThumb(m)}</div>`;
    card.innerHTML = `
      ${badge}
      ${thumb}
      <div class="menu-name">${m.name}</div>
      <div class="menu-name-en">${m.nameEn || ''}</div>
      <div class="menu-bottom">
        <div><span class="menu-price">${m.price.toLocaleString()}<small>원</small></span>${tempBadge(m.temperature)}</div>
        <button class="menu-add" aria-label="담기">＋</button>
      </div>`;
    const add = () => openOption(m.id);
    card.querySelector('.menu-add').onclick = (e) => { e.stopPropagation(); add(); };
    card.onclick = add;
    grid.appendChild(card);
  });
}

/* ============================================================
   옵션 모달 (터치 주문)
   ============================================================ */
function openOption(menuId, presetTemp) {
  const m = State.byId[menuId];
  if (!m) return;
  const needTemp = m.temperature === 'both';
  let temp = presetTemp || (needTemp ? (State.config.recommendTemp || 'ICE')
                : (m.temperature === 'ice' ? 'ICE' : m.temperature === 'hot' ? 'HOT' : 'none'));
  State.option = { menuId, temp, qty: 1, needTemp };

  $('#optEmoji').innerHTML = menuThumb(m);
  $('#optName').textContent = m.name;
  $('#optQty').textContent = '1';
  updateOptPrice();

  const row = $('#optTempRow');
  if (needTemp) {
    row.style.display = 'flex';
    $$('.temp-btn', row).forEach(b => b.classList.toggle('active', b.dataset.temp === temp));
  } else {
    row.style.display = 'none';
  }
  $('#optionModal').style.display = 'flex';
}
function unitPriceOf(m, temp) {
  if (temp === 'HOT' && m.priceHot != null) return m.priceHot;
  if (temp === 'ICE' && m.priceIce != null) return m.priceIce;
  return m.price;
}
function updateOptPrice() {
  const o = State.option, m = State.byId[o.menuId];
  const unit = unitPriceOf(m, o.temp);
  $('#optPrice').textContent = won(unit * o.qty);
}
function closeOption() { $('#optionModal').style.display = 'none'; State.option = null; }
function confirmOption() {
  const o = State.option, m = State.byId[o.menuId];
  addToCart(m, o.temp, o.qty);
  closeOption();
  toast(`${m.name} ${o.qty}개 담았어요`);
}

/* ============================================================
   장바구니
   ============================================================ */
function addToCart(m, temperature, quantity) {
  const unitPrice = unitPriceOf(m, temperature);
  // 같은 메뉴+같은 온도는 수량 합산
  const found = State.cart.find(i => i.menuId === m.id && i.temperature === temperature);
  if (found) {
    found.quantity += quantity;
    found.lineTotal = found.unitPrice * found.quantity;
  } else {
    State.cart.push({
      menuId: m.id, name: m.name, emoji: m.emoji || '🍽️',
      temperature, quantity, unitPrice, lineTotal: unitPrice * quantity,
    });
  }
  updateCartBar();
}
function cartTotals() {
  const qty = State.cart.reduce((s, i) => s + i.quantity, 0);
  const price = State.cart.reduce((s, i) => s + i.lineTotal, 0);
  return { qty, price };
}
function updateCartBar() {
  const { qty, price } = cartTotals();
  $('#cartCount').textContent = qty;
  $('#cartQty').textContent = qty;
  $('#cartTotal').textContent = won(price);
}
function tempLabel(t) {
  if (t === 'HOT') return '🔥 따뜻하게';
  if (t === 'ICE') return '🧊 시원하게';
  return '';
}
function renderCart() {
  const list = $('#cartList');
  list.innerHTML = '';
  if (!State.cart.length) {
    list.innerHTML = '<div class="cart-empty">담긴 메뉴가 없어요.<br>메뉴를 골라 주세요 🙂</div>';
    $('#cartFootTotal').textContent = won(0);
    return;
  }
  State.cart.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'cart-item';
    const m = State.byId[it.menuId] || { emoji: it.emoji };
    row.innerHTML = `
      <div class="cart-item-emoji">${menuThumb(m)}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${it.name}</div>
        ${it.temperature && it.temperature !== 'none' ? `<div class="cart-item-temp">${tempLabel(it.temperature)}</div>` : ''}
        <div class="cart-item-price">${won(it.unitPrice)} × ${it.quantity} = <b>${won(it.lineTotal)}</b></div>
      </div>
      <div class="cart-item-right">
        <button class="cart-item-del" aria-label="삭제">🗑️</button>
        <div class="qty-stepper">
          <button class="qty-btn dec">－</button>
          <span class="qty-num">${it.quantity}</span>
          <button class="qty-btn inc">＋</button>
        </div>
      </div>`;
    row.querySelector('.inc').onclick = () => { it.quantity++; it.lineTotal = it.unitPrice * it.quantity; renderCart(); updateCartBar(); };
    row.querySelector('.dec').onclick = () => {
      it.quantity--;
      if (it.quantity <= 0) State.cart.splice(idx, 1);
      else it.lineTotal = it.unitPrice * it.quantity;
      renderCart(); updateCartBar();
    };
    row.querySelector('.cart-item-del').onclick = () => { State.cart.splice(idx, 1); renderCart(); updateCartBar(); };
    list.appendChild(row);
  });
  $('#cartFootTotal').textContent = won(cartTotals().price);
}

/* ---------- 확인/결제 ---------- */
function renderConfirm() {
  const wrap = $('#confirmList');
  wrap.innerHTML = '';
  State.cart.forEach(it => {
    const r = document.createElement('div');
    r.className = 'confirm-row';
    r.innerHTML = `
      <span><span class="r-name">${it.emoji} ${it.name}</span>
        ${it.temperature && it.temperature !== 'none' ? `<span class="r-temp"> (${tempLabel(it.temperature)})</span>` : ''}
        × ${it.quantity}</span>
      <b>${won(it.lineTotal)}</b>`;
    wrap.appendChild(r);
  });
  $('#confirmTotal').textContent = won(cartTotals().price);
}

async function pay() {
  const payload = {
    items: State.cart,
    inputMethod: State.inputMethod,
  };
  let orderNo = null;
  try {
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    orderNo = res.orderNo;
  } catch (e) {
    console.error('주문 실패', e);
  }
  if (!orderNo) orderNo = 'A-' + String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
  finishOrder(orderNo);
}

let doneTimer, doneCountdown;
function finishOrder(orderNo) {
  $('#doneOrderNo').textContent = orderNo;
  show('screen-done');
  // 초기화
  State.cart = [];
  State.inputMethod = 'touch';
  updateCartBar();
  // 카운트다운 후 처음 화면
  let sec = 10;
  $('#doneCount').textContent = `${sec}초 후 처음 화면으로 돌아갑니다`;
  clearInterval(doneCountdown); clearTimeout(doneTimer);
  doneCountdown = setInterval(() => {
    sec--;
    $('#doneCount').textContent = `${sec}초 후 처음 화면으로 돌아갑니다`;
    if (sec <= 0) clearInterval(doneCountdown);
  }, 1000);
  doneTimer = setTimeout(goHome, 10000);
}
function goHome() {
  clearInterval(doneCountdown); clearTimeout(doneTimer);
  State.category = 'burger';
  renderTabs(); renderGrid();
  show('screen-start');
}

/* ============================================================
   음성 주문
   ============================================================ */
const Voice = {
  recorder: null, chunks: [], stream: null,
  state: 'idle',    // idle | listening | processing | result
  current: null,    // 단건 확인 중 아이템
  list: [],         // 다건 확인 중 아이템 배열
};

function setVoiceStatus(text, listening) {
  $('#voiceStatusText').textContent = text;
  $('#screen-voice').classList.toggle('paused', !listening);
}

async function startVoice() {
  if (!State.config.voiceEnabled) { toast('음성 기능이 꺼져 있어요'); return; }
  show('screen-voice');
  resetVoiceUI();
  setVoiceStatus('듣고 있어요', true);
  Voice.state = 'listening';
  try {
    Voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.error(e);
    voiceFail('마이크를 사용할 수 없어요. 화면을 눌러 주문해 주세요.');
    return;
  }
  Voice.chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  Voice.recorder = new MediaRecorder(Voice.stream, mime ? { mimeType: mime } : undefined);
  Voice.recorder.ondataavailable = e => { if (e.data.size) Voice.chunks.push(e.data); };
  Voice.recorder.onstop = onRecordStop;
  Voice.recorder.start();

  // 자동 종료(무음 감지 대용): 6초 뒤 자동 정지. 사용자가 시각적으로 재탭도 가능.
  Voice._auto = setTimeout(stopVoiceRecording, 6000);
  // 마이크 다시 탭하면 즉시 종료
  $('#voiceMic').onclick = stopVoiceRecording;
}

function stopVoiceRecording() {
  clearTimeout(Voice._auto);
  if (Voice.recorder && Voice.recorder.state === 'recording') {
    setVoiceStatus('주문을 확인하고 있어요…', false);
    Voice.state = 'processing';
    Voice.recorder.stop();
  }
}

async function onRecordStop() {
  // 마이크 트랙 정리
  if (Voice.stream) Voice.stream.getTracks().forEach(t => t.stop());
  const blob = new Blob(Voice.chunks, { type: 'audio/webm' });
  if (blob.size < 800) { voiceFail('잘 못 들었어요. 다시 말씀해 주세요.'); return; }

  try {
    // 1) STT
    const fd = new FormData();
    fd.append('audio', blob, 'order.webm');
    const stt = await fetch('/api/stt', { method: 'POST', body: fd }).then(r => r.json());
    if (stt.error || !stt.text) { voiceFail('잘 못 들었어요. 다시 말씀해 주시거나 화면을 눌러 주세요.'); return; }
    showHeard(stt.text);

    // 2) GPT 매칭
    const match = await fetch('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: stt.text }),
    }).then(r => r.json());
    handleMatch(match);
  } catch (e) {
    console.error(e);
    voiceFail('네트워크 문제가 있어요. 화면을 눌러 주문해 주세요.');
  }
}

function showHeard(text) {
  $('#heardLabel').style.display = 'block';
  $('#heardCard').style.display = 'block';
  $('#heardText').textContent = `"${text}"`;
  $('#voiceHint').style.display = 'block';
}

function resetVoiceUI() {
  $('#heardLabel').style.display = 'none';
  $('#heardCard').style.display = 'none';
  $('#voiceHint').style.display = 'none';
  $('#voiceSheet').style.display = 'none';
  $('#voiceSheet').innerHTML = '';
}

/* ---------- 매칭 결과 처리 ---------- */
function handleMatch(res) {
  State.inputMethod = 'voice';

  // 1) 실제 판매 메뉴로 매칭된 주문 항목들
  const matchedItems = (res.matched || []).map(buildVoiceItem).filter(Boolean);

  // 2) 메뉴에 없어 추천된 항목 → '하나만' (실제 존재하는 메뉴 중 첫 번째)
  const recoItem = (res.recommendations || [])
    .filter(r => State.byId[r.menu_id])
    .slice(0, 1)
    .map(r => {
      const vi = buildVoiceItem({ menu_id: r.menu_id, quantity: 1 });
      if (vi) vi.isReco = true;
      return vi;
    })
    .filter(Boolean)[0];

  // 3) 매칭된 메뉴 + (있으면) 추천 메뉴 하나를 '한 목록'에 함께 표시
  const combined = [...matchedItems];
  if (recoItem) combined.push(recoItem);

  if (combined.length) {
    Voice.state = 'result';
    // 매칭 단건뿐이면 큰 카드, 추천이 섞였거나 2개 이상이면 리스트
    if (combined.length === 1 && !combined[0].isReco) {
      renderSingleMatched(combined[0]);
    } else {
      renderMultiMatched(combined);
    }
    return;
  }

  // 4) 매칭도 추천도 없으면 재시도/터치 주문으로 유도
  voiceFail(res.assistant_message || '다시 말씀해 주시거나, 화면을 눌러 골라 주세요.');
}

// 매칭 항목 → 화면용 모델 (없는 메뉴는 제외)
function buildVoiceItem(x) {
  const m = State.byId[x.menu_id];
  if (!m) return null;
  const needTemp = m.temperature === 'both';
  const temp = x.temperature || x.suggested_temperature
             || (needTemp ? (State.config.recommendTemp || 'ICE')
                 : (m.temperature === 'ice' ? 'ICE' : m.temperature === 'hot' ? 'HOT' : 'none'));
  return { menuId: m.id, temp, qty: x.quantity || 1, needTemp };
}

// 진입점: 1개면 단건 확인 카드, 2개 이상이면 전체 리스트를 보여줌
function renderMatchedSheet(matchedList) {
  const items = matchedList.map(buildVoiceItem).filter(Boolean);
  if (!items.length) { voiceFail('메뉴를 찾지 못했어요. 화면을 눌러 주세요.'); return; }
  Voice.state = 'result';
  if (items.length === 1) renderSingleMatched(items[0]);
  else renderMultiMatched(items);
}

/* ---------- 단건 확인 ---------- */
function renderSingleMatched(it) {
  setVoiceStatus('메뉴를 찾았어요', false);
  const m = State.byId[it.menuId];
  Voice.current = it;
  const needTemp = it.needTemp;
  const temp = it.temp, qty = it.qty;

  const recNote = needTemp && (temp === State.config.recommendTemp)
    ? `<span class="matched-tag rec">🌤 오늘 ${State.config.todayTemp}℃ 추천</span>` : '';
  const tempTag = (temp === 'ICE') ? '<span class="matched-tag">🧊 ICE</span>'
                : (temp === 'HOT') ? '<span class="matched-tag">🔥 HOT</span>' : '';

  const qLabel = `${m.name}${needTemp ? ' ' + (temp === 'ICE' ? '아이스' : '따뜻한') : ''} ${qty}개`;
  const sheet = $('#voiceSheet');
  sheet.style.display = 'block';
  sheet.innerHTML = `
    <div class="sheet-q"><span class="robot">🤖</span> '<b>${qLabel}</b>' 맞으실까요?</div>
    <div class="matched-card">
      <span class="matched-flag">✓ 메뉴를 찾았어요</span>
      <div class="matched-emoji">${menuThumb(m)}</div>
      <div class="matched-info">
        <div class="matched-name">${m.name}</div>
        <div class="matched-tags">${tempTag}${recNote}</div>
      </div>
      <div class="matched-price" id="vPrice">${won(unitPriceOf(m, temp) * qty)}</div>
    </div>
    <div class="sheet-controls">
      ${needTemp ? `<div class="temp-toggle">
        <button class="temp-btn hot ${temp==='HOT'?'active':''}" data-temp="HOT">🔥 따뜻하게</button>
        <button class="temp-btn ice ${temp==='ICE'?'active':''}" data-temp="ICE">🧊 시원하게</button>
      </div>` : '<div style="flex:1"></div>'}
      <div class="qty-stepper">
        <button class="qty-btn" id="vMinus">－</button>
        <span class="qty-num" id="vQty">${qty}</span>
        <button class="qty-btn" id="vPlus">＋</button>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn-ghost" id="vRetry">🎤 다시 말할게요</button>
      <button class="btn-primary" id="vAdd">🛒 네, 담아주세요</button>
    </div>`;

  $('#vMinus').onclick = () => { Voice.current.qty = Math.max(1, Voice.current.qty - 1); refreshVoicePrice(); };
  $('#vPlus').onclick  = () => { Voice.current.qty++; refreshVoicePrice(); };
  if (needTemp) {
    $$('.temp-btn', sheet).forEach(b => b.onclick = () => {
      Voice.current.temp = b.dataset.temp;
      $$('.temp-btn', sheet).forEach(x => x.classList.toggle('active', x === b));
      refreshVoicePrice();
    });
  }
  $('#vRetry').onclick = startVoice;
  $('#vAdd').onclick = () => {
    const mm = State.byId[Voice.current.menuId];
    addToCart(mm, Voice.current.temp, Voice.current.qty);
    toast(`담았어요! (총 ${cartTotals().qty}개)`);
    closeVoice();
    show('screen-order');
  };
}
function refreshVoicePrice() {
  const c = Voice.current, m = State.byId[c.menuId];
  $('#vQty').textContent = c.qty;
  $('#vPrice').textContent = won(unitPriceOf(m, c.temp) * c.qty);
}

/* ---------- 다건 확인 (2개 이상 주문 전체 표시) ---------- */
function voiceListTotal() {
  return Voice.list.reduce((s, it) => {
    const m = State.byId[it.menuId];
    return s + unitPriceOf(m, it.temp) * it.qty;
  }, 0);
}
function renderMultiMatched(items) {
  Voice.list = items;
  setVoiceStatus('주문 내용을 확인해 주세요', false);
  $('#voiceSheet').style.display = 'block';
  renderVoiceList();
}
function renderVoiceList() {
  const sheet = $('#voiceSheet');
  const rows = Voice.list.map((it, i) => {
    const m = State.byId[it.menuId];
    const unit = unitPriceOf(m, it.temp);
    const tempCtrl = it.needTemp ? `<div class="temp-toggle sm">
        <button class="temp-btn hot ${it.temp==='HOT'?'active':''}" data-act="hot" data-i="${i}">🔥</button>
        <button class="temp-btn ice ${it.temp==='ICE'?'active':''}" data-act="ice" data-i="${i}">🧊</button>
      </div>` : '';
    const sub = `${it.isReco ? '💡 비슷한 메뉴로 추천 · ' : ''}${it.needTemp ? (it.temp==='ICE'?'🧊 시원하게':'🔥 따뜻하게') + ' · ' : ''}${won(unit)}`;
    const recoTag = it.isReco ? '<div class="v-reco-tag">AI추천</div>' : '';
    return `<div class="v-item${it.isReco ? ' reco' : ''}">
      <div class="v-thumb">${menuThumb(m)}</div>
      <div class="v-info">
        ${recoTag}
        <div class="v-name">${m.name}</div>
        <div class="v-sub">${sub}</div>
        ${tempCtrl}
      </div>
      <div class="v-right">
        <div class="qty-stepper sm">
          <button class="qty-btn" data-act="dec" data-i="${i}">－</button>
          <span class="qty-num">${it.qty}</span>
          <button class="qty-btn" data-act="inc" data-i="${i}">＋</button>
        </div>
        <button class="v-del" data-act="del" data-i="${i}" aria-label="삭제">🗑️</button>
      </div>
      <div class="v-line">${won(unit * it.qty)}</div>
    </div>`;
  }).join('');

  const hasReco = Voice.list.some(it => it.isReco);
  sheet.innerHTML = `
    <div class="sheet-q"><span class="robot">🤖</span> <span class="sheet-q-text">이렇게 <b>${Voice.list.length}가지</b> 주문 맞으실까요?</span></div>
    ${hasReco ? '<div class="sheet-note">💡 말씀하신 메뉴 중 없는 건 비슷한 메뉴로 추천해 드렸어요. 필요 없으면 🗑️ 로 빼 주세요.</div>' : ''}
    <div class="v-list">${rows}</div>
    <div class="v-total"><span>합계</span><b>${won(voiceListTotal())}</b></div>
    <div class="sheet-actions">
      <button class="btn-ghost" id="vRetry">🎤 다시 말할게요</button>
      <button class="btn-primary" id="vAddAll">🛒 네, 모두 담아주세요</button>
    </div>`;

  $$('[data-act]', sheet).forEach(b => b.onclick = () => {
    const i = +b.dataset.i, act = b.dataset.act, it = Voice.list[i];
    if (!it) return;
    if (act === 'inc') it.qty++;
    else if (act === 'dec') { it.qty--; if (it.qty <= 0) Voice.list.splice(i, 1); }
    else if (act === 'del') Voice.list.splice(i, 1);
    else if (act === 'hot') it.temp = 'HOT';
    else if (act === 'ice') it.temp = 'ICE';
    if (!Voice.list.length) { voiceFail('주문을 비웠어요. 다시 말씀해 주시거나 화면을 눌러 주세요.'); return; }
    renderVoiceList();
  });
  $('#vRetry').onclick = startVoice;
  $('#vAddAll').onclick = () => {
    Voice.list.forEach(it => { const m = State.byId[it.menuId]; if (m) addToCart(m, it.temp, it.qty); });
    toast(`담았어요! (총 ${cartTotals().qty}개)`);
    closeVoice();
    show('screen-order');
  };
}

/* ---------- 추천(없는 메뉴) ---------- */
function renderRecoSheet(recos, message) {
  setVoiceStatus('비슷한 메뉴를 찾았어요', false);
  const sheet = $('#voiceSheet');
  sheet.style.display = 'block';
  let items = recos.map(r => {
    const m = State.byId[r.menu_id];
    if (!m) return '';
    return `<div class="reco-item" data-id="${m.id}">
      <div class="reco-emoji">${menuThumb(m)}</div>
      <div class="reco-name">${m.name}</div>
      <div class="reco-price">${won(m.price)}</div>
    </div>`;
  }).join('');
  sheet.innerHTML = `
    <div class="sheet-q"><span class="robot">🤖</span> ${message}</div>
    <div class="reco-list">${items}</div>
    <div class="sheet-actions">
      <button class="btn-ghost" id="vRetry">🎤 다시 말할게요</button>
      <button class="btn-primary" id="vTouch">👆 직접 고를게요</button>
    </div>`;
  $$('.reco-item', sheet).forEach(el => el.onclick = () => {
    closeVoice(); show('screen-order'); openOption(el.dataset.id);
  });
  $('#vRetry').onclick = startVoice;
  $('#vTouch').onclick = () => { closeVoice(); show('screen-order'); };
}

/* ---------- 음성 실패 ---------- */
let failCount = 0;
function voiceFail(message) {
  failCount++;
  setVoiceStatus('다시 도와드릴게요', false);
  $('#heardLabel').style.display = 'none';
  const sheet = $('#voiceSheet');
  sheet.style.display = 'block';
  // 2회 연속 실패 → 터치 주문 전면 유도 (지침 10.5)
  const pushTouch = failCount >= 2;
  sheet.innerHTML = `
    <div class="sheet-q"><span class="robot">🤖</span> ${message}</div>
    <div class="sheet-actions">
      <button class="btn-ghost" id="vRetry">🎤 다시 말할게요</button>
      <button class="btn-primary" id="vTouch">👆 화면 눌러서 주문</button>
    </div>
    ${pushTouch ? '<div style="text-align:center;margin-top:12px;color:#6B6577;font-weight:700">화면을 눌러 골라 주시면 더 빠를 수 있어요 🙂</div>' : ''}`;
  $('#vRetry').onclick = startVoice;
  $('#vTouch').onclick = () => { closeVoice(); show('screen-order'); };
}

function closeVoice() {
  clearTimeout(Voice._auto);
  if (Voice.recorder && Voice.recorder.state === 'recording') Voice.recorder.stop();
  if (Voice.stream) Voice.stream.getTracks().forEach(t => t.stop());
  Voice.state = 'idle';
  Voice.list = [];
  failCount = 0;
}

/* ============================================================
   이벤트 바인딩
   ============================================================ */
function bindEvents() {
  // 시작 화면
  $('#btnStartVoice').onclick = () => startVoice();
  $('#btnStartTouch').onclick = () => show('screen-order');

  // 메인
  $('#btnHome').onclick = goHome;
  $('#micFab').onclick = () => startVoice();
  $('#cartSummary').onclick = () => { if (cartTotals().qty) { renderCart(); show('screen-cart'); } };
  $('#btnGoCart').onclick = () => {
    if (!cartTotals().qty) { toast('메뉴를 먼저 담아 주세요'); return; }
    renderCart(); show('screen-cart');
  };

  // 옵션 모달
  $('#btnOptClose').onclick = closeOption;
  $('#optMinus').onclick = () => { State.option.qty = Math.max(1, State.option.qty - 1); $('#optQty').textContent = State.option.qty; updateOptPrice(); };
  $('#optPlus').onclick  = () => { State.option.qty++; $('#optQty').textContent = State.option.qty; updateOptPrice(); };
  $$('#optTempRow .temp-btn').forEach(b => b.onclick = () => {
    State.option.temp = b.dataset.temp;
    $$('#optTempRow .temp-btn').forEach(x => x.classList.toggle('active', x === b));
    updateOptPrice();
  });
  $('#btnOptAdd').onclick = confirmOption;
  $('#optionModal').onclick = (e) => { if (e.target.id === 'optionModal') closeOption(); };

  // 장바구니
  $('#btnCartBack').onclick = () => show('screen-order');
  $('#btnCartHome').onclick = goHome;
  $('#btnCheckout').onclick = () => {
    if (!cartTotals().qty) { toast('담긴 메뉴가 없어요'); return; }
    renderConfirm(); show('screen-confirm');
  };

  // 확인
  $('#btnConfirmBack').onclick = () => { renderCart(); show('screen-cart'); };
  $('#btnPay').onclick = pay;

  // 음성
  $('#btnVoiceClose').onclick = () => { closeVoice(); show('screen-order'); };
  $('#btnVoiceToTouch').onclick = () => { closeVoice(); show('screen-order'); };

  // 완료
  $('#btnDoneHome').onclick = goHome;
}

document.addEventListener('DOMContentLoaded', init);
