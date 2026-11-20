(function () {
  'use strict';

  /* ---------- pomocnicze ---------- */
  const $ = (s) => document.querySelector(s);
  const cfg = window.MANHUNT_CONFIG || {};
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const rnd = (n) => {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[a[i] % ALPHABET.length];
    return s;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  };
  const fmtAgo = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 5) return 'przed chwilą';
    if (s < 60) return `${s} s temu`;
    return `${Math.floor(s / 60)} min temu`;
  };
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  const ROLE = { hunter: 'Łowca', runner: 'Biegacz' };

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function arrow(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    const deg = (Math.atan2(y, x) / rad + 360) % 360;
    return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][Math.round(deg / 45) % 8];
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function setBanner(msg) {
    const b = $('#banner');
    if (msg) { b.textContent = msg; b.hidden = false; } else b.hidden = true;
  }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }

  /* ---------- stan ---------- */
  const DEFAULTS = { assign: 'random', hunters: 1, revealSec: 120, headStartSec: 60, durationMin: 30, catchMode: 'scan' };
  const REVEAL_OPTS = [[30, '30 sekund'], [60, '1 minuta'], [120, '2 minuty'], [180, '3 minuty'], [300, '5 minut'], [600, '10 minut']];
  const HEAD_OPTS = [[0, 'brak'], [30, '30 sekund'], [60, '1 minuta'], [120, '2 minuty'], [300, '5 minut'], [600, '10 minut']];

  let DB = (store.get('mh_db') || cfg.databaseUrl || '').trim().replace(/\/+$/, '');
  let myId = store.get('mh_id');
  if (!myId) { myId = rnd(10); store.set('mh_id', myId); }
  let myName = store.get('mh_name') || '';
  let code = store.get('mh_code') || null;
  let lobby = null;
  let current = 'home';
  let failCount = 0;
  let loopToken = 0;
  let pollTimer = null;
  let finalizing = false;

  // stan pojedynczej rozgrywki
  let gameKey = null;
  let lastSentTick = -2;
  let seenTicks = {};
  let firstSeen = true;
  let listSig = '';

  /* ---------- baza (Firebase REST) ---------- */
  async function api(method, path, body) {
    if (!DB) throw new Error('Najpierw wpisz adres serwera (Firebase)');
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${DB}/${path}.json`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!r.ok) {
        throw new Error(r.status === 401 || r.status === 403
          ? 'Serwer odrzucił dostęp - sprawdź reguły bazy Firebase'
          : `Błąd serwera (${r.status})`);
      }
      return await r.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Serwer nie odpowiada');
      throw e;
    } finally {
      clearTimeout(to);
    }
  }
  const dbGet = (p) => api('GET', p);
  const dbPut = (p, b) => api('PUT', p, b);
  const dbPatch = (p, b) => api('PATCH', p, b);
  const dbDel = (p) => api('DELETE', p);

  /* ---------- GPS i ekran ---------- */
  let pos = null, watchId = null, geoErr = null;
  function startGeo() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => { pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now() }; geoErr = null; },
      (e) => { geoErr = e.code === 1 ? 'denied' : 'unavailable'; },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
    );
  }
  function stopGeo() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null; pos = null; geoErr = null;
  }
  function updateGpsText() {
    let txt = 'GPS: czekam na sygnał…', bad = false;
    if (geoErr === 'denied') { txt = 'GPS: brak zgody na lokalizację - włącz ją w ustawieniach telefonu'; bad = true; }
    else if (geoErr === 'unavailable' && !pos) { txt = 'GPS: brak sygnału - wyjdź na zewnątrz'; bad = true; }
    else if (pos) txt = `GPS OK (dokładność ±${Math.round(pos.acc)} m)`;
    ['#lobby-gps', '#g-gps'].forEach((id) => { const el = $(id); el.textContent = txt; el.classList.toggle('bad', bad); });
  }

  let wl = null;
  async function wake() {
    try {
      if ('wakeLock' in navigator && !wl) {
        wl = await navigator.wakeLock.request('screen');
        wl.addEventListener('release', () => { wl = null; });
      }
    } catch (e) { /* ignore */ }
  }
  function unwake() { try { if (wl) wl.release(); } catch (e) { /* ignore */ } wl = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && code) wake(); });

  /* ---------- ekrany ---------- */
  function show(name) {
    if (current === name) return;
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== 's-' + name; });
    current = name;
    if (name !== 'game') { delete document.body.dataset.role; closeScan(); closeMyCode(); stopHce(); stopNfcRead(); showNfcNote(''); }
    if (name === 'game') { ensureMap(); setTimeout(() => map && map.invalidateSize(), 60); }
  }

  /* ---------- mapa ---------- */
  let map = null, meMarker = null, centered = false;
  const runnerMarkers = {};
  function ensureMap() {
    if (map || !window.L) return;
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.0, 19.0], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  function pinIcon(label, cls) {
    return L.divIcon({ className: '', html: `<div class="pin ${cls}"><i></i><span>${esc(label)}</span></div>`, iconSize: [0, 0] });
  }
  function clearMap() {
    if (!map) return;
    Object.keys(runnerMarkers).forEach((k) => { map.removeLayer(runnerMarkers[k]); delete runnerMarkers[k]; });
    if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
    centered = false;
  }
  function updateMap(res, showReveals, tick) {
    if (!map) return;
    if (pos) {
      if (!meMarker) meMarker = L.marker([pos.lat, pos.lng], { icon: pinIcon('Ty', 'me'), interactive: false }).addTo(map);
      else meMarker.setLatLng([pos.lat, pos.lng]);
      if (!centered) { map.setView([pos.lat, pos.lng], 16); centered = true; }
    }
    const keep = {};
    if (showReveals) {
      res.runners.forEach((r) => {
        const rev = r.reveal;
        if (!rev) return;
        const cls = r.caught ? 'out' : (rev.tick === tick ? 'fresh' : 'stale');
        keep[r.id] = true;
        let m = runnerMarkers[r.id];
        if (!m) {
          m = L.marker([rev.lat, rev.lng], { icon: pinIcon(r.name, cls), interactive: false }).addTo(map);
          m._cls = cls; runnerMarkers[r.id] = m;
        } else {
          m.setLatLng([rev.lat, rev.lng]);
          if (m._cls !== cls) { m.setIcon(pinIcon(r.name, cls)); m._cls = cls; }
        }
      });
    }
    Object.keys(runnerMarkers).forEach((k) => { if (!keep[k]) { map.removeLayer(runnerMarkers[k]); delete runnerMarkers[k]; } });
  }
  $('#btn-me').addEventListener('click', () => { if (map && pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16)); });
  $('#btn-all').addEventListener('click', () => {
    if (!map) return;
    const pts = [];
    if (pos) pts.push([pos.lat, pos.lng]);
    Object.values(runnerMarkers).forEach((m) => pts.push(m.getLatLng()));
    if (pts.length > 1) map.fitBounds(pts, { padding: [50, 50], maxZoom: 17 });
    else if (pts.length === 1) map.setView(pts[0], 16);
  });

  /* ---------- logika gry ---------- */
  function playersArr() {
    return Object.entries((lobby && lobby.players) || {})
      .map(([id, p]) => Object.assign({ id }, p))
      .sort((a, b) => (a.joined || 0) - (b.joined || 0));
  }
  const isHost = () => !!lobby && lobby.host === myId;
  function timing() {
    const s = lobby.settings;
    const start = lobby.startAt;
    return { start, release: start + s.headStartSec * 1000, end: start + s.durationMin * 60000, step: s.revealSec * 1000 };
  }
  const tickAt = (t, tm) => (t < tm.release ? -1 : Math.floor((t - tm.release) / tm.step));

  function evaluate() {
    const tm = timing();
    const now = Date.now();
    const pl = playersArr();
    const runners = pl.filter((p) => p.role === 'runner');
    const alive = runners.filter((p) => !p.caught);
    let over = false, winner = null;
    if (lobby.state === 'ended') { over = true; winner = lobby.winner || 'none'; }
    else if (runners.length && alive.length === 0) { over = true; winner = 'hunters'; }
    else if (now >= tm.end) { over = true; winner = 'runners'; }
    return { tm, now, pl, runners, alive, over, winner };
  }

  function hostFinalize(res) {
    if (!isHost() || lobby.state !== 'running' || finalizing) return;
    finalizing = true;
    lobby.state = 'ended'; lobby.winner = res.winner;
    dbPatch('lobbies/' + code, { state: 'ended', winner: res.winner })
      .catch(() => {})
      .finally(() => { finalizing = false; });
  }

  function route() {
    if (!lobby) return;
    if (lobby.state === 'lobby') { show('lobby'); renderLobby(); return; }
    if (lobby.startAt == null) return;
    if (lobby.startAt !== gameKey) resetGameLocals();
    const res = evaluate();
    if (res.over) { show('end'); renderEnd(res); hostFinalize(res); }
    else { show('game'); renderGame(res); }
  }

  function resetGameLocals() {
    gameKey = lobby.startAt;
    lastSentTick = -2; seenTicks = {}; firstSeen = true; listSig = '';
    clearMap();
  }

  /* ---------- lobby ---------- */
  function fillSelect(sel, opts) {
    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  fillSelect($('#set-reveal'), REVEAL_OPTS);
  fillSelect($('#set-head'), HEAD_OPTS);

  function setField(el, val) { if (document.activeElement !== el) el.value = String(val); }

  function renderLobby() {
    const s = Object.assign({}, DEFAULTS, lobby.settings);
    const host = isHost();
    const pl = playersArr();
    $('#lobby-code').textContent = code;
    $('#pcount').textContent = pl.length;

    setField($('#set-assign'), s.assign);
    setField($('#set-hunters'), s.hunters);
    setField($('#set-reveal'), s.revealSec);
    setField($('#set-head'), s.headStartSec);
    setField($('#set-duration'), s.durationMin);
    setField($('#set-catch'), s.catchMode);
    ['#set-assign', '#set-hunters', '#set-reveal', '#set-head', '#set-duration', '#set-catch'].forEach((id) => { $(id).disabled = !host; });
    $('#lbl-hunters').hidden = s.assign !== 'random';

    $('#players').innerHTML = pl.map((p) => {
      const mine = p.id === myId;
      let right = '';
      if (lobby.host === p.id) right += '<span class="tag">host</span>';
      if (s.assign === 'manual') {
        if (mine) {
          right += `<span class="rolepick">
            <button data-role="hunter" class="${p.role === 'hunter' ? 'on hunter' : ''}">Łowca</button>
            <button data-role="runner" class="${p.role === 'runner' ? 'on runner' : ''}">Biegacz</button></span>`;
        } else if (p.role) right += `<span class="tag ${p.role}">${ROLE[p.role]}</span>`;
        else right += '<span class="tag">wybiera…</span>';
      }
      return `<li><span>${esc(p.name)}${mine ? ' (Ty)' : ''}</span><span class="tags">${right}</span></li>`;
    }).join('');

    $('#btn-start').hidden = !host;
    $('#lobby-hint').textContent = s.assign === 'random'
      ? (host ? `Role zostaną wylosowane przy starcie. Łowców: ${s.hunters}.` : 'Role zostaną wylosowane przy starcie gry.')
      : 'Każdy wybiera sobie rolę - musi być co najmniej jeden łowca i jeden biegacz.';
    if (!host) $('#lobby-hint').textContent += ' Czekaj, aż host wystartuje grę.';
    updateGpsText();
  }

  function saveSettings() {
    if (!isHost()) return;
    const s = {
      assign: $('#set-assign').value === 'manual' ? 'manual' : 'random',
      hunters: clamp(parseInt($('#set-hunters').value, 10) || 1, 1, 29),
      revealSec: parseInt($('#set-reveal').value, 10) || DEFAULTS.revealSec,
      headStartSec: parseInt($('#set-head').value, 10),
      durationMin: clamp(parseInt($('#set-duration').value, 10) || DEFAULTS.durationMin, 1, 720),
      catchMode: $('#set-catch').value === 'manual' ? 'manual' : 'scan',
    };
    if (isNaN(s.headStartSec)) s.headStartSec = DEFAULTS.headStartSec;
    lobby.settings = s;
    renderLobby();
    dbPatch(`lobbies/${code}/settings`, s).catch((e) => toast(e.message));
  }
  ['#set-assign', '#set-hunters', '#set-reveal', '#set-head', '#set-duration', '#set-catch'].forEach((id) => $(id).addEventListener('change', saveSettings));

  $('#players').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b || !lobby) return;
    const role = b.dataset.role;
    lobby.players[myId].role = role;
    renderLobby();
    dbPatch(`lobbies/${code}/players/${myId}`, { role }).catch((err) => toast(err.message));
  });

  $('#btn-share').addEventListener('click', async () => {
    const text = `Dołącz do mojej gry w Manhunt! Kod lobby: ${code}`;
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      toast('Skopiowano kod');
    } catch (e) { toast(`Kod lobby: ${code}`); }
  });

  $('#btn-start').addEventListener('click', async () => {
    if (!lobby || !isHost()) return;
    const pl = playersArr();
    const s = Object.assign({}, DEFAULTS, lobby.settings);
    if (pl.length < 2) return toast('Potrzeba co najmniej 2 graczy');
    const roles = {};
    if (s.assign === 'random') {
      const n = clamp(s.hunters, 1, pl.length - 1);
      const ids = pl.map((p) => p.id);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      ids.forEach((id, i) => { roles[id] = i < n ? 'hunter' : 'runner'; });
    } else {
      if (pl.some((p) => !p.role)) return toast('Każdy gracz musi wybrać rolę');
      if (!pl.some((p) => p.role === 'hunter') || !pl.some((p) => p.role === 'runner')) return toast('Potrzeba przynajmniej jednego łowcy i jednego biegacza');
      pl.forEach((p) => { roles[p.id] = p.role; });
    }
    const upd = { state: 'running', startAt: Date.now() + 5000, winner: null };
    pl.forEach((p) => {
      upd[`players/${p.id}/role`] = roles[p.id];
      upd[`players/${p.id}/reveal`] = null;
      upd[`players/${p.id}/caught`] = null;
      upd[`players/${p.id}/ch`] = null;
    });
    $('#btn-start').disabled = true;
    try { await dbPatch('lobbies/' + code, upd); await poll(); }
    catch (e) { toast(e.message); }
    finally { $('#btn-start').disabled = false; }
  });

  /* ---------- widok gry ---------- */
  function renderGame(res) {
    const me = lobby.players[myId] || {};
    const role = me.role;
    const { tm, now } = res;
    const tick = tickAt(now, tm);
    const spectator = role === 'hunter' || !!me.caught;

    const badge = $('#g-role');
    badge.textContent = me.caught ? 'Złapany' : (ROLE[role] || '?');
    badge.className = 'badge ' + (me.caught ? 'caught' : (role || ''));
    document.body.dataset.role = me.caught ? 'caught' : (role || '');
    $('#g-left').textContent = now < tm.start ? 'Start…' : '⏱ ' + fmt(tm.end - now);
    $('#g-alive').textContent = `Biegaczy: ${res.alive.length}/${res.runners.length}`;

    let main = '', sub = '';
    if (now < tm.start) {
      main = `Start za ${fmt(tm.start - now)}`;
      sub = role === 'hunter' ? 'Jesteś łowcą - przygotuj się.' : 'Jesteś biegaczem - przygotuj się do ucieczki.';
    } else if (now < tm.release) {
      if (me.caught) main = `Biegacze mają fory: ${fmt(tm.release - now)}`;
      else if (role === 'hunter') { main = `Czekaj… biegacze uciekają: ${fmt(tm.release - now)}`; sub = 'Potem dostaniesz pierwszą lokalizację.'; }
      else { main = `Uciekaj! Łowcy ruszają za ${fmt(tm.release - now)}`; sub = 'Pierwsza lokalizacja zostanie wtedy ujawniona.'; }
    } else {
      const next = tm.release + (tick + 1) * tm.step;
      if (me.caught) main = `Obserwujesz grę · następne odsłonięcie za ${fmt(next - now)}`;
      else if (role === 'hunter') main = `Następne pozycje biegaczy za ${fmt(next - now)}`;
      else { main = `Twoja pozycja zostanie ujawniona za ${fmt(next - now)}`; sub = 'Rusz się, zanim łowcy dotrą na miejsce.'; }
    }
    $('#g-status').innerHTML = `${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ''}`;

    const scanMode = ((lobby.settings && lobby.settings.catchMode) || 'scan') === 'scan';
    const runnerAlive = role === 'runner' && !me.caught;
    $('#btn-caught').hidden = !runnerAlive;
    $('#btn-end').hidden = !isHost();
    $('#btn-scan').hidden = !(scanMode && role === 'hunter' && now >= tm.start);
    $('#btn-mycode').hidden = !(scanMode && runnerAlive);
    $('#g-list').hidden = !spectator;
    if (spectator) renderRunnerList(res, role === 'hunter' && !scanMode);
    if (scanMode && runnerAlive) publishCatchHash(me);
    ensureHce(scanMode && runnerAlive);
    ensureNfcHunter(scanMode && role === 'hunter' && now >= tm.start);
    if (runnerAlive === false) closeMyCode();

    updateMap(res, spectator, tick);
    maybeSendReveal(res, tick, me);
    notifyReveals(res, spectator);
    updateDynamic(res.now);
    updateGpsText();
  }

  function renderRunnerList(res, canCatch) {
    const sig = JSON.stringify([canCatch, res.runners.map((r) => [r.id, !!r.caught, r.reveal ? r.reveal.tick : null])]);
    if (sig === listSig) return;
    listSig = sig;
    $('#g-list').innerHTML = res.runners.map((r) => {
      const rev = r.reveal;
      const info = r.caught ? 'złapany'
        : rev ? `<span class="ago" data-ts="${rev.ts}"></span> · <span class="dist" data-lat="${rev.lat}" data-lng="${rev.lng}"></span>`
          : 'jeszcze nieodsłonięty';
      return `<div class="rrow ${r.caught ? 'out' : ''}">
        <div><div class="rname">${esc(r.name)}</div><div class="rinfo">${info}</div></div>
        ${canCatch && !r.caught ? `<button class="mini" data-catch="${r.id}">Złapany</button>` : ''}
      </div>`;
    }).join('');
  }

  function updateDynamic(now) {
    document.querySelectorAll('#g-list .ago').forEach((el) => { el.textContent = fmtAgo(now - Number(el.dataset.ts)); });
    document.querySelectorAll('#g-list .dist').forEach((el) => {
      if (!pos) { el.textContent = 'brak GPS'; return; }
      const target = { lat: Number(el.dataset.lat), lng: Number(el.dataset.lng) };
      el.textContent = `${arrow(pos, target)} ${fmtDist(haversine(pos, target))}`;
    });
  }

  function maybeSendReveal(res, tick, me) {
    if (me.role !== 'runner' || me.caught) return;
    if (tick < 0 || tick <= lastSentTick || !pos) return;
    const prev = lastSentTick;
    lastSentTick = tick;
    dbPut(`lobbies/${code}/players/${myId}/reveal`, { lat: pos.lat, lng: pos.lng, acc: Math.round(pos.acc), tick, ts: Date.now() })
      .then(() => vibrate([150, 80, 150]))
      .catch(() => { if (lastSentTick === tick) lastSentTick = prev; });
  }

  function notifyReveals(res, spectator) {
    if (!spectator) return;
    let fresh = false;
    res.runners.forEach((r) => {
      if (!r.reveal) return;
      if (seenTicks[r.id] !== r.reveal.tick) { if (!firstSeen) fresh = true; seenTicks[r.id] = r.reveal.tick; }
    });
    if (fresh) { vibrate([250, 100, 250, 100, 250]); toast('Nowe pozycje biegaczy!'); }
    firstSeen = false;
  }

  $('#g-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-catch]');
    if (!b) return;
    const id = b.dataset.catch;
    const p = lobby.players[id];
    if (!p || !confirm(`Oznaczyć gracza ${p.name} jako złapanego?`)) return;
    p.caught = true; listSig = '';
    dbPatch(`lobbies/${code}/players/${id}`, { caught: true }).catch((err) => toast(err.message));
    route();
  });
  $('#btn-caught').addEventListener('click', () => {
    if (!confirm('Na pewno zostałeś złapany?')) return;
    lobby.players[myId].caught = true; listSig = '';
    dbPatch(`lobbies/${code}/players/${myId}`, { caught: true }).catch((err) => toast(err.message));
    route();
  });
  $('#btn-end').addEventListener('click', () => {
    if (!isHost() || !confirm('Zakończyć grę dla wszystkich?')) return;
    lobby.state = 'ended'; lobby.winner = 'none';
    dbPatch('lobbies/' + code, { state: 'ended', winner: 'none' }).catch((err) => toast(err.message));
    route();
  });

  /* ---------- koniec gry ---------- */
  function renderEnd(res) {
    const me = lobby.players[myId] || {};
    const w = res.winner;
    $('#end-title').textContent = w === 'hunters' ? 'Łowcy wygrali!' : w === 'runners' ? 'Biegacze wygrali!' : 'Gra zakończona';
    let sub = '';
    if (w === 'hunters' || w === 'runners') {
      const won = (w === 'hunters') === (me.role === 'hunter');
      sub = won ? 'Wygrałeś! 🎉' : 'Tym razem się nie udało.';
    } else sub = 'Host zakończył grę.';
    $('#end-sub').textContent = sub;
    $('#end-list').innerHTML = res.runners.map((r) =>
      `<li><span>${esc(r.name)}</span><span class="tag ${r.caught ? '' : 'runner'}">${r.caught ? 'złapany' : 'przetrwał'}</span></li>`).join('')
      || '<li><span class="muted">brak biegaczy</span></li>';
    $('#btn-again').hidden = !isHost();
    $('#end-wait').hidden = isHost();
  }

  $('#btn-again').addEventListener('click', async () => {
    if (!isHost()) return;
    const upd = { state: 'lobby', startAt: null, winner: null };
    const random = (lobby.settings || DEFAULTS).assign === 'random';
    playersArr().forEach((p) => {
      upd[`players/${p.id}/reveal`] = null;
      upd[`players/${p.id}/caught`] = null;
      upd[`players/${p.id}/ch`] = null;
      if (random) upd[`players/${p.id}/role`] = null;
    });
    try { await dbPatch('lobbies/' + code, upd); await poll(); }
    catch (e) { toast(e.message); }
  });

  /* ---------- łapanie: kod QR i tag NFC ---------- */
  // Każdy biegacz ma sekretny kod (zostaje w jego telefonie). W bazie leży tylko jego skrót,
  // więc łowca nie odczyta kodu z bazy - musi go zeskanować z telefonu albo tagu biegacza.
  const PAYLOAD_RE = /MH1:([A-Z0-9]{5}):([A-Z0-9]{10})/;
  const SECRET_RE = /^[A-Z0-9]{10}$/;
  const secrets = {};
  let myHash = null, chSentKey = null, hashBusy = false;

  function getSecret() {
    const k = 'mh_secret_' + code;
    if (!secrets[k]) { secrets[k] = store.get(k) || rnd(10); store.set(k, secrets[k]); }
    return secrets[k];
  }
  function cyrb53(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  // Zwraca [sha256, zapasowy]. Biegacz publikuje pierwszy, łowca porównuje z oboma.
  async function hashVariants(secret) {
    const text = secret + ':' + code;
    const out = [];
    try {
      if (window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        out.push(Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''));
      }
    } catch (e) { /* zapasowy skrót poniżej */ }
    out.push('x' + cyrb53(text));
    return out;
  }
  async function publishCatchHash(me) {
    if (hashBusy || chSentKey === gameKey) return;
    hashBusy = true;
    try {
      if (!myHash) myHash = (await hashVariants(getSecret()))[0];
      if (me.ch !== myHash) await dbPatch(`lobbies/${code}/players/${myId}`, { ch: myHash });
      chSentKey = gameKey;
    } catch (e) { /* spróbujemy przy następnym odświeżeniu */ }
    finally { hashBusy = false; }
  }

  let catching = false;
  async function handleScan(raw) {
    if (catching || !lobby) return false;
    const text = String(raw || '').trim().toUpperCase();
    let secret = null;
    const m = text.match(PAYLOAD_RE);
    if (m) {
      if (m[1] !== code) { scanMsg('To kod z innego lobby.', true); return false; }
      secret = m[2];
    } else if (SECRET_RE.test(text)) secret = text;
    else return false;

    const me = lobby.players[myId] || {};
    if (me.role !== 'hunter') { scanMsg('Tylko łowca może łapać.', true); return false; }
    catching = true;
    try {
      const hs = await hashVariants(secret);
      const hit = playersArr().find((p) => p.role === 'runner' && p.ch && hs.includes(p.ch));
      if (!hit) { scanMsg('Ten kod nie pasuje do żadnego biegacza.', true); return false; }
      if (hit.caught) { scanMsg(`${hit.name} jest już złapany.`, true); return false; }
      lobby.players[hit.id].caught = true; listSig = '';
      await dbPatch(`lobbies/${code}/players/${hit.id}`, { caught: true });
      vibrate([200, 80, 200]);
      closeScan();
      toast(`Złapany: ${hit.name}!`);
      route();
      return true;
    } catch (e) {
      scanMsg(e.message || 'Nie udało się zapisać. Spróbuj jeszcze raz.', true);
      return false;
    } finally { catching = false; }
  }

  /* skaner (łowca) */
  let scanOpen = false, stream = null, scanRaf = 0, scanCanvas = null, lastScanAt = 0, lastText = '', lastTextAt = 0;
  function scanMsg(t, bad) {
    if (!scanOpen) { if (t && bad) toast(t); return; } // skaner zamknięty (np. łapanie przez NFC): pokaż błąd jako komunikat
    const el = $('#scan-msg'); el.textContent = t || ''; el.classList.toggle('bad', !!bad);
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanMsg('Kamera jest niedostępna. Wpisz kod ręcznie.', true); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (!scanOpen) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      const v = $('#scan-video');
      v.srcObject = s;
      await v.play();
      if ($('#scan-msg').textContent === 'Uruchamiam aparat…') scanMsg('Skieruj aparat na kod QR biegacza.');
      scanLoop();
    } catch (e) {
      scanMsg('Brak dostępu do kamery. Zezwól na nią w ustawieniach telefonu albo wpisz kod ręcznie.', true);
    }
  }
  function scanLoop() {
    if (!scanOpen) return;
    const v = $('#scan-video');
    const now = Date.now();
    if (window.jsQR && v.readyState >= 2 && v.videoWidth && now - lastScanAt > 120) {
      lastScanAt = now;
      const w = Math.min(480, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
      if (!scanCanvas) scanCanvas = document.createElement('canvas');
      scanCanvas.width = w; scanCanvas.height = h;
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (r && r.data) onScanText(r.data);
    }
    scanRaf = requestAnimationFrame(scanLoop);
  }
  function onScanText(text) {
    const now = Date.now();
    if (text === lastText && now - lastTextAt < 2500) return;
    lastText = text; lastTextAt = now;
    handleScan(text);
  }
  function openScan() {
    if (scanOpen) return;
    scanOpen = true; lastText = ''; scanMsg('Uruchamiam aparat…');
    $('#scan').hidden = false; $('#scan-manual').value = '';
    startCamera();
    nfcAvailable().then((ok) => { $('#btn-nfc-scan').hidden = !scanOpen || !ok || nfcReading; });
  }
  function closeScan() {
    if (!scanOpen) return;
    scanOpen = false;
    cancelAnimationFrame(scanRaf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    try { $('#scan-video').srcObject = null; } catch (e) { /* ignore */ }
    $('#scan').hidden = true;
  }

  /* NFC - tylko jeśli wtyczka jest w tej wersji aplikacji i telefon ma NFC */
  let nfcOk = null, nfcListener = null, nfcReading = false;
  function nfcPlugin() {
    try {
      const C = window.Capacitor;
      if (!C) return null;
      if (C.Plugins && C.Plugins.NFC) return C.Plugins.NFC;
      if (typeof C.registerPlugin === 'function') return C.registerPlugin('NFC');
    } catch (e) { /* brak wtyczki */ }
    return null;
  }
  async function nfcAvailable() {
    if (nfcOk !== null) return nfcOk;
    nfcOk = false;
    const p = nfcPlugin();
    if (p) {
      try { const r = await p.getStatus(); nfcOk = !!r && r.status !== 'NOT_SUPPORTED'; } catch (e) { nfcOk = false; }
    }
    return nfcOk;
  }
  async function nfcDisabled() {
    try { const r = await nfcPlugin().getStatus(); return r.status === 'DISABLED'; } catch (e) { return false; }
  }
  function nfcTextFrom(ev) {
    const found = [];
    ((ev && ev.messages) || []).forEach((msg) => (msg.records || []).forEach((rec) => {
      let s = '';
      try {
        const bin = atob(rec.payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        s = new TextDecoder('utf-8').decode(bytes);
      } catch (e) { s = String(rec.payload || ''); }
      found.push(s);
    }));
    for (const s of found) { const m = s.toUpperCase().match(PAYLOAD_RE); if (m) return m[0]; }
    return null;
  }
  async function startNfcRead() {
    const p = nfcPlugin();
    if (await nfcDisabled()) { scanMsg('Włącz NFC w ustawieniach telefonu.', true); return; }
    nfcListener = await p.addListener('nfcTag', (ev) => {
      const t = nfcTextFrom(ev);
      if (t) onScanText(t); else scanMsg('Na tym tagu nie ma kodu Manhunt.', true);
    });
    try { await p.startScan({}); } catch (e) { /* na Androidzie odbiór działa bez tego */ }
    nfcReading = true;
    $('#btn-nfc-scan').textContent = 'NFC włączone - przyłóż tag';
    scanMsg('Przyłóż telefon do tagu NFC biegacza.');
  }
  async function stopNfcRead() {
    if (!nfcReading && !nfcListener) return;
    nfcReading = false;
    try { if (nfcListener) await nfcListener.remove(); } catch (e) { /* ignore */ }
    nfcListener = null;
    try { await nfcPlugin().cancelScan(); } catch (e) { /* ignore */ }
  }
  $('#btn-nfc-scan').addEventListener('click', async () => {
    if (nfcReading) return;
    try { await startNfcRead(); } catch (e) { scanMsg('Nie udało się włączyć NFC.', true); }
  });

  $('#btn-scan').addEventListener('click', openScan);
  $('#btn-scan-close').addEventListener('click', closeScan);
  $('#btn-manual-ok').addEventListener('click', async () => {
    const v = $('#scan-manual').value;
    if (!v.trim()) return;
    const ok = await handleScan(v);
    if (!ok && !$('#scan-msg').classList.contains('bad')) scanMsg('Zły kod. Sprawdź i wpisz jeszcze raz.', true);
  });

  /* mój kod (biegacz) */
  let myCodeOpen = false, nfcWriting = false, writeSubs = [];
  function myMsg(t, bad) { const el = $('#mycode-msg'); el.textContent = t || ''; el.classList.toggle('bad', !!bad); }
  function openMyCode() {
    if (myCodeOpen || !code) return;
    const secret = getSecret();
    const qr = qrcode(0, 'M');
    qr.addData(`MH1:${code}:${secret}`);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    $('#secret').textContent = secret;
    $('#hce-note').hidden = !hceActive;
    myMsg('');
    $('#mycode').hidden = false; myCodeOpen = true;
    nfcAvailable().then((ok) => { $('#btn-nfc-write').hidden = !myCodeOpen || !ok; });
  }
  async function stopNfcWrite() {
    if (!nfcWriting) return;
    nfcWriting = false;
    writeSubs.forEach((h) => { try { h.remove(); } catch (e) { /* ignore */ } });
    writeSubs = [];
    try { await nfcPlugin().cancelWriteAndroid(); } catch (e) { /* ignore */ }
    $('#btn-nfc-write').textContent = 'Zapisz kod na tagu NFC';
  }
  function closeMyCode() {
    if (!myCodeOpen) return;
    myCodeOpen = false;
    stopNfcWrite();
    $('#mycode').hidden = true;
  }
  $('#btn-nfc-write').addEventListener('click', async () => {
    if (nfcWriting) return;
    const p = nfcPlugin();
    try {
      if (await nfcDisabled()) { myMsg('Włącz NFC w ustawieniach telefonu.', true); return; }
      const text = `MH1:${code}:${getSecret()}`;
      const body = Array.from(new TextEncoder().encode(text));
      const lang = [0x65, 0x6e]; // "en"
      nfcWriting = true;
      writeSubs = [
        await p.addListener('nfcWriteSuccess', () => { myMsg('Zapisano! Łowca może teraz zeskanować ten tag.'); stopNfcWrite(); }),
        await p.addListener('nfcError', (e) => { myMsg((e && e.error) || 'Nie udało się zapisać tagu.', true); stopNfcWrite(); }),
      ];
      await p.writeNDEF({ records: [{ type: 'T', payload: [lang.length, ...lang, ...body] }] });
      $('#btn-nfc-write').textContent = 'Przyłóż pusty tag do telefonu…';
      myMsg('Przyłóż telefon do tagu NFC.');
    } catch (e) {
      myMsg('Nie udało się włączyć zapisu NFC.', true);
      stopNfcWrite();
    }
  });
  $('#btn-mycode').addEventListener('click', openMyCode);
  $('#btn-mycode-close').addEventListener('click', closeMyCode);

  /* NFC telefon do telefonu: telefon biegacza udaje tag (natywna wtyczka ManhuntHce), łowca go odczytuje */
  let hceActive = false, hceKey = null, hceBusy = false, hceOk = null, nfcAutoKey = null;
  function hcePlugin() {
    try {
      const C = window.Capacitor;
      if (!C) return null;
      if (C.Plugins && C.Plugins.ManhuntHce) return C.Plugins.ManhuntHce;
      if (typeof C.registerPlugin === 'function') return C.registerPlugin('ManhuntHce');
    } catch (e) { /* brak wtyczki */ }
    return null;
  }
  async function hceAvailable() {
    if (hceOk !== null) return hceOk;
    hceOk = false;
    const p = hcePlugin();
    if (p) {
      try { const r = await p.isSupported(); hceOk = !!(r && r.supported); } catch (e) { hceOk = false; }
    }
    return hceOk;
  }
  function showNfcNote(t) {
    const el = $('#g-nfc');
    el.textContent = t || ''; el.hidden = !t;
    $('#hce-note').hidden = !hceActive;
  }
  async function ensureHce(want) {
    if (hceBusy) return;
    const key = code + ':' + gameKey;
    if (want && hceActive && hceKey === key) return;
    if (!want && !hceActive) return;
    hceBusy = true;
    try {
      if (want) {
        if (await hceAvailable()) {
          await hcePlugin().start({ text: `MH1:${code}:${getSecret()}` });
          hceActive = true; hceKey = key;
          showNfcNote('NFC włączone: łowca może Cię złapać, przykładając swój telefon do Twojego.');
        }
      } else await stopHce();
    } catch (e) { /* bez tego zostaje kod QR */ }
    finally { hceBusy = false; }
  }
  async function stopHce() {
    if (!hceActive) return;
    hceActive = false; hceKey = null;
    try { await hcePlugin().stop(); } catch (e) { /* ignore */ }
    showNfcNote('');
  }
  async function ensureNfcHunter(want) {
    if (!want) { if (nfcReading) stopNfcRead(); return; }
    const key = code + ':' + gameKey;
    if (nfcReading || nfcAutoKey === key) return;
    nfcAutoKey = key;
    if (!(await nfcAvailable())) return;
    try { await startNfcRead(); } catch (e) { /* zostaje przycisk w skanerze */ }
    if (nfcReading) showNfcNote('NFC włączone: przyłóż swój telefon do telefonu biegacza, żeby go złapać.');
  }

  /* ---------- polling ---------- */
  async function poll() {
    if (!code) return;
    try {
      const data = await dbGet('lobbies/' + code);
      failCount = 0; setBanner(null);
      if (data === null) { toast('Lobby zostało zamknięte'); resetLocal(); return; }
      if (!data.players || !data.players[myId]) { toast('Nie ma Cię już w tym lobby'); resetLocal(); return; }
      lobby = data;
      if (!lobby.settings) lobby.settings = Object.assign({}, DEFAULTS);
      route();
    } catch (e) {
      if (++failCount >= 3) setBanner('Brak połączenia z serwerem… próbuję dalej');
    }
  }
  function startLoop() {
    const token = ++loopToken;
    clearTimeout(pollTimer);
    const run = async () => {
      if (token !== loopToken) return;
      await poll();
      if (token === loopToken) pollTimer = setTimeout(run, 2000);
    };
    run();
  }
  setInterval(() => {
    if (!lobby) return;
    if (lobby.state === 'running') route();
    else updateGpsText();
  }, 1000);

  function resetLocal() {
    loopToken++;
    clearTimeout(pollTimer);
    code = null; lobby = null; gameKey = null; finalizing = false; myHash = null; chSentKey = null;
    store.del('mh_code');
    stopGeo(); unwake(); clearMap(); setBanner(null);
    show('home');
  }

  async function enter(c) {
    code = c;
    store.set('mh_code', c);
    lobby = null; gameKey = null; myHash = null; chSentKey = null;
    startGeo(); wake();
    startLoop();
  }

  /* ---------- ekran startowy ---------- */
  function checkName() {
    myName = $('#name').value.trim().slice(0, 16);
    if (!myName) { toast('Wpisz swój nick'); return false; }
    store.set('mh_name', myName);
    return true;
  }
  function checkDb() {
    if (!DB) { $('#server').open = true; toast('Najpierw wpisz adres serwera (Firebase)'); return false; }
    return true;
  }
  let busyNow = false;
  function busy(b) { busyNow = b; $('#btn-create').disabled = b; $('#btn-join').disabled = b; }

  $('#btn-create').addEventListener('click', async () => {
    if (busyNow || !checkName() || !checkDb()) return;
    busy(true);
    try {
      let c = null;
      for (let i = 0; i < 6; i++) {
        const cand = rnd(5);
        if ((await dbGet('lobbies/' + cand)) === null) { c = cand; break; }
      }
      if (!c) throw new Error('Nie udało się wygenerować kodu - spróbuj ponownie');
      await dbPut('lobbies/' + c, {
        host: myId, created: Date.now(), state: 'lobby',
        settings: Object.assign({}, DEFAULTS),
        players: { [myId]: { name: myName, joined: Date.now() } },
      });
      await enter(c);
    } catch (e) { toast(e.message); }
    finally { busy(false); }
  });

  $('#btn-join').addEventListener('click', async () => {
    if (busyNow || !checkName() || !checkDb()) return;
    const c = $('#join-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 5) return toast('Kod ma 5 znaków');
    busy(true);
    try {
      const data = await dbGet('lobbies/' + c);
      if (!data) throw new Error('Nie ma lobby o takim kodzie');
      const existing = data.players && data.players[myId];
      if (data.state !== 'lobby' && !existing) throw new Error('Ta gra już trwa');
      if (!existing && Object.keys(data.players || {}).length >= 30) throw new Error('Lobby jest pełne');
      await dbPatch(`lobbies/${c}/players/${myId}`, existing ? { name: myName } : { name: myName, joined: Date.now() });
      await enter(c);
    } catch (e) { toast(e.message); }
    finally { busy(false); }
  });

  async function leaveLobby() {
    if (!confirm('Na pewno wyjść z lobby?')) return;
    try {
      if (code && lobby) {
        const others = playersArr().filter((p) => p.id !== myId);
        if (!others.length) await dbDel('lobbies/' + code);
        else {
          const upd = { [`players/${myId}`]: null };
          if (lobby.host === myId) upd.host = others[0].id;
          await dbPatch('lobbies/' + code, upd);
        }
      }
    } catch (e) { /* i tak wychodzimy */ }
    resetLocal();
  }
  $('#btn-leave').addEventListener('click', leaveLobby);
  $('#btn-leave2').addEventListener('click', leaveLobby);

  /* ---------- ustawienia serwera ---------- */
  function normalizeDb(v) {
    v = v.trim().replace(/\.json.*$/, '').replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) v = 'https://' + v;
    return v;
  }
  $('#btn-db-save').addEventListener('click', async () => {
    const url = normalizeDb($('#db-url').value);
    const st = $('#db-status');
    if (!url) { st.textContent = 'Wpisz adres bazy.'; return; }
    st.textContent = 'Sprawdzam…';
    try {
      const r = await fetch(`${url}/.json?shallow=true`, { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        // reguły mogą blokować odczyt korzenia - to normalne przy zalecanych regułach
        st.textContent = 'Zapisano. (Serwer odpowiada, korzeń bazy jest zablokowany - tak ma być.)';
      } else if (!r.ok) throw new Error('HTTP ' + r.status);
      else st.textContent = 'Zapisano. Serwer działa ✔';
      DB = url; store.set('mh_db', url); $('#db-url').value = url;
    } catch (e) {
      st.textContent = 'Nie udało się połączyć: ' + e.message + '. Sprawdź adres.';
    }
  });

  /* ---------- start ---------- */
  $('#name').value = myName;
  $('#db-url').value = DB;
  if (!DB) { $('#server').open = true; $('#db-status').textContent = 'Wpisz adres bazy, żeby móc grać.'; }
  if (code) { startGeo(); wake(); startLoop(); }
})();
