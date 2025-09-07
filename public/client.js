(() => {
  const socket = io();

  const qs = (s) => document.querySelector(s);
  const joinScreen = qs('#join-screen');
  const chatScreen = qs('#chat-screen');
  const joinForm = qs('#join-form');
  const usernameInput = qs('#username');
  const avatarFile = qs('#avatar-file');
  const messagesEl = qs('#messages');
  const typingEl = qs('#typing');
  const composer = qs('#composer');
  const messageInput = qs('#message-input');
  const attachBtn = qs('#attach-btn');
  const fileInput = qs('#file-input');
  const micBtn = qs('#mic-btn');
  const messageCountEl = qs('#message-count');
  const toastEl = qs('#toast');
  const settingsBtn = qs('#settings-btn');
  const settingsEl = qs('#settings');
  const bgColorInput = qs('#bg-color');
  const bgImageFile = qs('#bg-image-file');
  const bgFitInput = qs('#bg-fit');
  const bgClearBtn = qs('#bg-clear');
  const profileFile = qs('#profile-file');
  const settingsClose = qs('#settings-close');
  const viewport = qs('.viewport');

  let myName = null;
  let myAvatarUrl = null;
  let messageCount = 0;

  const typers = new Set();

  // Apply saved appearance
  applySavedAppearance();

  // Join flow (robust: retries when socket is not yet connected)
  let joined = false;
  let pendingJoin = null;

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = usernameInput.value.trim();
    if (!name) return usernameInput.focus();

    // Upload avatar if provided
    let avatarUrl = null;
    const f = avatarFile?.files?.[0];
    if (f) {
      try { const info = await uploadFile(f); avatarUrl = info?.url || null; } catch (_) { avatarUrl = null; }
    }

    pendingJoin = { name, avatarUrl };
    trySendJoin();
  });

  function trySendJoin() {
    if (!pendingJoin) return;
    if (!socket.connected) {
      showToast('Connecting...');
      socket.connect();
      return;
    }
    const { name, avatarUrl } = pendingJoin;
    let timedOut = false;
    const to = setTimeout(() => { timedOut = true; showToast('Join taking longer...'); }, 4000);
    socket.emit('join', { name, avatarUrl }, async (resp) => {
      clearTimeout(to);
      if (timedOut) return; // late ack, ignore
      const ok = resp === true || (resp && resp.ok);
      if (!ok) { alert('Join failed'); return; }
      const serverPrefs = (resp && resp.prefs) || {};
      joined = true; myName = name; myAvatarUrl = avatarUrl || serverPrefs.avatarUrl || myAvatarUrl;
      pendingJoin = null;
      joinScreen.classList.add('hidden');
      chatScreen.classList.remove('hidden');
      messageInput?.focus();
      // Apply server prefs and mirror into localStorage
      if (serverPrefs.bgColor) {
        document.documentElement.style.setProperty('--bg', serverPrefs.bgColor);
        localStorage.setItem('chat.bgColor', serverPrefs.bgColor);
      }
      if (serverPrefs.bgImageUrl) {
        const fit = serverPrefs.bgFit || localStorage.getItem('chat.bgFit') || (bgFitInput?.value || 'contain');
        setBackgroundImage(serverPrefs.bgImageUrl, fit);
        localStorage.setItem('chat.bgImageUrl', serverPrefs.bgImageUrl);
        localStorage.setItem('chat.bgFit', fit);
        if (bgFitInput) bgFitInput.value = fit;
      }
      showToast(`Joined as ${name}`);
      // Load history once joined
      await loadHistory(300);
    });
  }

  socket.on('connect', () => {
    if (!joined && pendingJoin) trySendJoin();
  });
  socket.on('connect_error', () => {
    showToast('Connection failed');
  });

  // Send text
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('message', text);
    messageInput.value = '';
    stopTypingSoon();
  });

  // Typing indicator (throttled)
  let typingTimer;
  let lastTypingEmit = 0;
  messageInput.addEventListener('input', () => {
    const now = Date.now();
    if (now - lastTypingEmit > 500) {
      socket.emit('typing', true);
      lastTypingEmit = now;
    }
    stopTypingSoon();
  }, { passive: true });
  function stopTypingSoon() {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', false), 900);
  }

  // Attach: open file picker
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    for (const file of files) await uploadAndSend(file);
    fileInput.value = '';
  });

  // Paste from keyboard GIF picker (mobile keyboards paste a GIF file)
  messageInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && /^image\//.test(f.type)) {
          e.preventDefault();
          await uploadAndSend(f);
          return;
        }
      }
    }
  });

  // Drag & drop support
  composer.addEventListener('dragover', (e) => { e.preventDefault(); });
  composer.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      if (/^(image|video|audio)\//.test(f.type)) await uploadAndSend(f);
    }
  });

  // Settings toggles
  settingsBtn?.addEventListener('click', () => settingsEl.classList.toggle('hidden'));
  settingsClose?.addEventListener('click', () => settingsEl.classList.add('hidden'));
  bgColorInput?.addEventListener('input', () => {
    const hex = bgColorInput.value;
    document.documentElement.style.setProperty('--bg', hex);
    localStorage.setItem('chat.bgColor', hex);
    savePrefs({ bgColor: hex });
  });
  bgImageFile?.addEventListener('change', async () => {
    const f = bgImageFile.files?.[0];
    if (f) {
      const info = await uploadFile(f).catch(() => null);
      const url = info?.url;
      if (url) {
        const fit = (bgFitInput?.value) || 'contain';
        setBackgroundImage(url, fit);
        localStorage.setItem('chat.bgImageUrl', url);
        localStorage.setItem('chat.bgFit', fit);
        savePrefs({ bgImageUrl: url, bgFit: fit });
      }
    }
  });
  bgClearBtn?.addEventListener('click', () => {
    setBackgroundImage('');
    localStorage.removeItem('chat.bgImageUrl');
    localStorage.removeItem('chat.bgFit');
    savePrefs({ bgImageUrl: '', bgFit: '' });
  });
  profileFile?.addEventListener('change', async () => {
    const f = profileFile.files?.[0];
    if (!f) return;
    const info = await uploadFile(f).catch(() => null);
    const url = info?.url;
    if (url) {
      myAvatarUrl = url;
      socket.emit('update_avatar', url);
      savePrefs({ avatarUrl: url });
      // update my existing avatars in DOM
      document.querySelectorAll('.msg.me .avatar').forEach(av => {
        av.textContent = '';
        const img = document.createElement('img');
        img.src = url; img.alt = `${myName} avatar`;
        av.innerHTML = ''; av.appendChild(img);
      });
      showToast('Profile photo updated');
    }
  });

  // Voice notes via MediaRecorder
  let recorder = null;
  let recChunks = [];
  micBtn.addEventListener('click', async () => {
    if (!recorder || recorder.state === 'inactive') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        recChunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
        recorder.onstop = async () => {
          const blob = new Blob(recChunks, { type: 'audio/webm' });
          const file = new File([blob], 'voice-note.webm', { type: 'audio/webm' });
          await uploadAndSend(file);
          stream.getTracks().forEach(t => t.stop());
          micBtn.classList.remove('recording');
        };
        recorder.start();
        micBtn.classList.add('recording');
      } catch (err) {
        alert('Microphone access denied');
        console.error(err);
      }
    } else if (recorder.state === 'recording') {
      recorder.stop();
    }
  });

  async function uploadAndSend(file) {
    const info = await uploadFile(file);
    const mime = info.mime || file.type || '';
    const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio';
    socket.emit('message', { type, url: info.url, mime });
  }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('upload failed');
    return await res.json();
  }

  function setBackgroundImage(url, fit) {
    const size = fit || localStorage.getItem('chat.bgFit') || (bgFitInput?.value) || 'contain';
    if (viewport) {
      viewport.style.backgroundImage = url ? `url(${url})` : 'none';
      viewport.style.backgroundSize = size;
      viewport.style.backgroundAttachment = 'fixed';
      viewport.style.backgroundPosition = 'center center';
      viewport.style.backgroundRepeat = 'no-repeat';
    } else {
      document.body.style.backgroundImage = url ? `url(${url})` : 'none';
      document.body.style.backgroundSize = size;
      document.body.style.backgroundAttachment = 'fixed';
      document.body.style.backgroundPosition = 'center center';
      document.body.style.backgroundRepeat = 'no-repeat';
    }
  }

  function applySavedAppearance() {
    const c = localStorage.getItem('chat.bgColor');
    if (c) { document.documentElement.style.setProperty('--bg', c); if (bgColorInput) bgColorInput.value = c; }
    const img = localStorage.getItem('chat.bgImageUrl');
    const fit = localStorage.getItem('chat.bgFit') || (bgFitInput?.value) || 'contain';
    if (bgFitInput) bgFitInput.value = fit;
    if (img) setBackgroundImage(img, fit);
  }

  async function savePrefs(patch) {
    if (!myName) return;
    try {
      await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: myName, ...patch }) });
    } catch (e) {
      console.error('save prefs failed', e);
    }
  }


  // Fit toggle
  bgFitInput?.addEventListener('change', () => {
    const fit = bgFitInput.value;
    const url = localStorage.getItem('chat.bgImageUrl');
    if (url) {
      setBackgroundImage(url, fit);
      localStorage.setItem('chat.bgFit', fit);
      savePrefs({ bgFit: fit });
    } else {
      localStorage.setItem('chat.bgFit', fit);
      savePrefs({ bgFit: fit });
    }
  });

  // Socket events
  socket.on('message', (payload) => {
    renderMessage(payload);
    messageCount += 1; messageCountEl.textContent = String(messageCount);
  });

  async function loadHistory(limit = 200) {
    try {
      const res = await fetch(`/messages?limit=${encodeURIComponent(limit)}`);
      if (!res.ok) return;
      const items = await res.json();
      messagesEl.innerHTML = '';
      items.forEach((m) => renderMessage(m));
      // Keep count aligned
      messageCount = items.length;
      messageCountEl.textContent = String(messageCount);
    } catch (e) {
      console.error('history load failed', e);
    }
  }

  socket.on('user_joined', ({ username }) => { showToast(`${username} joined`); addSystemMessage(`${username} joined`); });
  socket.on('user_left', ({ username }) => { showToast(`${username} left`); addSystemMessage(`${username} left`); });

  socket.on('typing', ({ username, isTyping }) => {
    if (isTyping) typers.add(username); else typers.delete(username);
    renderTyping();
  });

  function renderTyping() {
    if (typers.size === 0) { typingEl.textContent = ''; typingEl.classList.add('hidden'); return; }
    typingEl.classList.remove('hidden');
    const names = Array.from(typers);
    typingEl.textContent = names.length === 1 ? `${names[0]} is typing...` : `${names.slice(0,2).join(', ')}${names.length>2?' and others':''} are typing...`;
  }

  // Rendering
  function renderMessage(m) {
    const isMe = myName && m.username === myName;
    const row = document.createElement('div');
    row.className = `msg ${isMe ? 'me' : 'them'}`;
    if (m.id) row.dataset.id = m.id;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (m.avatarUrl || (isMe && myAvatarUrl)) {
      const img = document.createElement('img');
      img.src = m.avatarUrl || myAvatarUrl; img.alt = `${m.username} avatar`;
      avatar.appendChild(img);
    } else {
      const initials = initialsOf(m.username || '?');
      const color = colorFor(initials);
      avatar.style.background = color.bg; avatar.style.color = color.fg;
      avatar.textContent = initials;
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.type === 'image') {
      const img = document.createElement('img');
      img.src = m.url; img.alt = 'image';
      img.loading = 'lazy';
      bubble.appendChild(img);
    } else if (m.type === 'video') {
      const vid = document.createElement('video');
      vid.src = m.url; vid.controls = true; vid.playsInline = true;
      bubble.appendChild(vid);
    } else if (m.type === 'audio') {
      bubble.classList.add('voice');
      // Custom audio UI
      const aud = document.createElement('audio');
      aud.src = m.url; aud.preload = 'metadata';
      aud.hidden = true;
      const player = document.createElement('div');
      player.className = 'audio';
      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      toggle.title = 'Play / Pause';
      toggle.textContent = '▶️';
      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('div');
      fill.className = 'fill';
      track.appendChild(fill);
      const timewrap = document.createElement('div');
      timewrap.className = 'timewrap';
      const progress = document.createElement('span');
      progress.className = 'progress';
      progress.textContent = '0:00';
      const duration = document.createElement('span');
      duration.className = 'duration';
      duration.textContent = '';
      timewrap.appendChild(progress);
      timewrap.appendChild(duration);

      player.appendChild(toggle);
      player.appendChild(track);
      player.appendChild(timewrap);
      bubble.appendChild(player);
      bubble.appendChild(aud);

      function fmt(t) {
        const m = Math.floor(t/60); const s = Math.floor(t%60).toString().padStart(2,'0'); return `${m}:${s}`;
      }
      aud.addEventListener('loadedmetadata', () => { duration.textContent = fmt(aud.duration || 0); });
      aud.addEventListener('timeupdate', () => {
        progress.textContent = fmt(aud.currentTime);
        const ratio = (aud.currentTime / (aud.duration || 1));
        fill.style.width = `${Math.min(100, Math.max(0, ratio*100))}%`;
      });
      aud.addEventListener('ended', () => { toggle.textContent = '▶️'; });
      toggle.addEventListener('click', () => {
        if (aud.paused) { aud.play(); toggle.textContent = '⏸'; } else { aud.pause(); toggle.textContent = '▶️'; }
      });
    } else {
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = m.text || '';
      bubble.appendChild(text);
    }

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(m.timestamp || Date.now());
    bubble.appendChild(time);

    if (isMe && m.id) {
      addDeleteControls(bubble, m);
    }

    if (isMe) {
      row.appendChild(bubble);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(bubble);
    }

    messagesEl.appendChild(row);
    // Only auto-scroll if user is near bottom
    const nearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 80;
    if (nearBottom) {
      requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
    }
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'sysmsg';
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), 1800);
  }

  function initialsOf(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    const s = (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
    return s.toUpperCase().slice(0, 2);
  }

  function colorFor(seed) {
    const h = [...seed].reduce((a,c) => a + c.charCodeAt(0), 0) % 360;
    return { bg: `hsl(${h} 70% 30%)`, fg: `hsl(${h} 90% 90%)` };
  }

  // Add delete controls (hover button, right-click, long-press)
  function addDeleteControls(bubble, m) {
    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.title = 'Delete';
    del.textContent = '🗑';
    del.addEventListener('click', (e) => { e.stopPropagation(); doDelete(); });
    bubble.appendChild(del);

    // Desktop: right-click
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); doDelete(); });

    // Mobile: long-press (~600ms)
    let pressTimer;
    const start = (e) => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { doDelete(); }, 600);
    };
    const cancel = () => { if (pressTimer) clearTimeout(pressTimer); };
    bubble.addEventListener('touchstart', start, { passive: true });
    bubble.addEventListener('touchend', cancel);
    bubble.addEventListener('touchmove', cancel);

    function doDelete() {
      if (!m.id) return;
      if (confirm('Delete this message?')) {
        socket.emit('delete_message', m.id, (ok) => {
          if (!ok) showToast('Failed to delete');
        });
      }
    }
  }

  // Deletion events
  socket.on('message_deleted', ({ id }) => {
    if (!id) return;
    const el = messagesEl.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  });
})();

