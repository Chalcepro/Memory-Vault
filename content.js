// content.js - Memory Vault v4.1 (Stream-safe · Tag filtering · Bridge panel · Viewport-safe)
(function() {
  'use strict';

  const STORAGE_KEY = 'deepseek_memory_vault';
  const MAX_MEMORIES = 80;
  const VAULT_TAG = '[VAULT_UPDATE]';
  const VAULT_TAG_ESC = '\\[VAULT_UPDATE\\]';
  const FAB_ID = 'dsv-fab';
  const MODAL_ID = 'dsv-modal';
  const BACKDROP_ID = 'dsv-backdrop';
  const BRIDGE_ID = 'dsv-bridge';

  // Stream-safe: track in-progress raw content per signature,
  // and only commit once the content has been stable for STREAM_SETTLE_MS
  const STREAM_SETTLE_MS = 2200; // wait 2.2s of silence before saving
  const pendingStreams = {};       // sig -> { rawContent, timer }
  const processedSignatures = new Set();

  let notificationCount = 0;
  let notificationTimeout = null;
  let currentNotification = null;
  let scannerInterval = null;
  let activeTagFilter = null;
  let bridgeCurrentIndex = null;
  let searchDebounce = null;
  let lastVaultHintAt = 0;

  // ---- Vault Primer (injected into new chats to activate vault protocol) ----
  const VAULT_PRIMER = `[MEMORY VAULT ACTIVE]
You have access to a persistent Memory Vault browser extension that saves context across chat sessions.

TO SAVE A MEMORY — respond with this exact block format:
[VAULT_UPDATE]
{"title":"Short title under 50 chars","summary":"What to remember","context":"Extra details","nextSteps":"What comes next","tags":["tag1","tag2"]}
[/VAULT_UPDATE]

GUIDELINES:
- Use [VAULT_UPDATE] when the user asks you to save/remember something, or when you produce reusable output (code, decisions, designs, research).
- Keep titles short and descriptive. Include 2-4 relevant tags (e.g. "react", "project-c", "auth", "bugfix").
- Only save meaningful, reusable information — not every message.
- One [VAULT_UPDATE] block per response maximum.
- The user can search, filter, and inject memories using the Vault panel (red 🧠 button, bottom-right).

[END VAULT PRIMER]`;

  // ---- Helpers ----
  const loadMemories = () =>
    new Promise(resolve => chrome.storage.local.get([STORAGE_KEY], res => resolve(res[STORAGE_KEY] || [])));

  const saveMemories = (memories) =>
    new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: memories }, resolve));

  const escHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  };

  const hashCode = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0; }
    return h.toString(36);
  };

  // Rough similarity: returns true if two strings share >70% of their 6-grams
  function isTooSimilar(a, b) {
    if (!a || !b) return false;
    const ngrams = (s, n) => {
      const set = new Set();
      for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
      return set;
    };
    const ga = ngrams(a, 6), gb = ngrams(b, 6);
    if (ga.size === 0 || gb.size === 0) return false;
    let shared = 0;
    ga.forEach(g => { if (gb.has(g)) shared++; });
    return shared / Math.max(ga.size, gb.size) > 0.70;
  }

  const san = (v) => String(v ?? '').trim();

  function getInputEl() {
    const sel = [
      'textarea[placeholder*="Ask"]', 'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Message"]', 'textarea[placeholder*="message"]',
      'textarea[role="textbox"]', 'textarea',
      '[contenteditable="true"]', '[contenteditable="plaintext-only"]'
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function setInputValue(value) {
    const el = getInputEl();
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = value;
    } else if (el.isContentEditable) {
      el.innerText = value;
    } else return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return true;
  }

  function getCurrentInputValue() {
    const el = getInputEl();
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return san(el.value);
    if (el.isContentEditable) return san(el.innerText || el.textContent || '');
    return '';
  }

  // ---- Auto-tag extraction ----
  const COMMON_WORDS = new Set(['the','a','an','is','in','on','at','to','for','of','and','or','but','with','this','that','from','are','was','be','by','it','as','have','has','not','do','so']);
  function extractTags(title, content, existingTags = []) {
    if (existingTags && existingTags.length > 0) return existingTags.slice(0, 6);
    const text = `${title} ${content}`.toLowerCase();
    const words = text.match(/\b[a-z][a-z0-9-]{2,}\b/g) || [];
    const freq = {};
    words.forEach(w => { if (!COMMON_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);
  }

  // ---- Time helper ----
  function timeSince(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function dateGroup(ts) {
    const now = new Date(), d = new Date(ts);
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return 'This Week';
    if (diffDays < 30) return 'This Month';
    return 'Older';
  }

  // ---- UI creation ----
  function createUI() {
    ['dsv-fab','dsv-modal','dsv-backdrop','dsv-bridge'].forEach(id => document.getElementById(id)?.remove());

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID; backdrop.className = 'dsv-backdrop';
    document.body.appendChild(backdrop);

    // FAB
    const fab = document.createElement('button');
    fab.id = FAB_ID; fab.className = 'dsv-fab'; fab.title = 'Memory Vault';
    fab.setAttribute('aria-label', 'Open Memory Vault');
    fab.innerHTML = `<span class="dsv-fab-icon">🧠</span><span class="dsv-badge-dot" id="dsv-badge" style="display:none"></span>`;
    document.body.appendChild(fab);

    // Modal
    const modal = document.createElement('div');
    modal.id = MODAL_ID; modal.className = 'dsv-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Memory Vault');
    modal.innerHTML = `
      <div class="dsv-header">
        <h2>VAULT</h2>
        <div class="dsv-header-actions">
          <button class="dsv-primer-btn" id="dsv-primer-btn" title="Inject vault primer into chat input">📋 Primer</button>
          <button class="dsv-close-btn" id="dsv-close" aria-label="Close Memory Vault">✕</button>
        </div>
      </div>

      <div class="dsv-section dsv-capture-section">
        <div class="dsv-capture-title">SAVE</div>
        <div class="dsv-upload-area" id="dsv-upload-area">
          ↑ Upload file
          <input type="file" id="dsv-file-input" accept=".txt,.pdf,.docx,.json,.csv,.js,.py,.html,.css,.md,.ts,.java,.c,.cpp,.go,.rs,.sh" />
        </div>
        <div class="dsv-manual-save">
          <input id="dsv-memory-title" placeholder="Title..." />
          <button id="dsv-save-current">SAVE</button>
          <button id="dsv-scan-btn" class="dsv-scan-btn" title="Scan page for vault blocks" aria-label="Scan page for memory updates">🔄</button>
        </div>
      </div>

      <div class="dsv-section dsv-library-section">
        <div class="dsv-accordion-header" id="dsv-accordion-header">
          <span class="dsv-accordion-title">Memory</span>
          <span class="dsv-accordion-status" id="dsv-accordion-status">0 saved</span>
          <span class="dsv-accordion-icon" id="dsv-accordion-icon" aria-hidden="true">▼</span>
        </div>
        <div class="dsv-accordion-content" id="dsv-accordion-content">
          <div class="dsv-search-bar">
            <input type="text" id="dsv-search-input" placeholder="Search memories..." />
            <button class="dsv-select-all-btn" id="dsv-select-all" title="Select / deselect all" aria-label="Select or deselect all visible memories">☑</button>
          </div>
          <div class="dsv-tag-bar" id="dsv-tag-bar"></div>
          <div class="dsv-memory-list" id="dsv-memory-list">
            <div class="dsv-empty-state">No memories yet</div>
          </div>
        </div>
      </div>

      <div class="dsv-actions">
        <button class="dsv-inject-selected-btn" id="dsv-inject-selected">INJECT SEL.</button>
        <button class="dsv-inject-btn" id="dsv-inject-all">INJECT ALL</button>
        <button class="dsv-import-btn" id="dsv-import">IMPORT</button>
        <button class="dsv-export-btn" id="dsv-export">EXPORT</button>
        <button class="dsv-clear-btn" id="dsv-clear" aria-label="Clear all memories">🗑️</button>
        <input type="file" id="dsv-import-input" accept="application/json,.json" style="display:none" />
      </div>
    `;
    document.body.appendChild(modal);

    // Bridge panel (anchored left of modal, scrollable detail view)
    const bridge = document.createElement('div');
    bridge.id = BRIDGE_ID; bridge.className = 'dsv-bridge';
    bridge.innerHTML = `
      <div class="dsv-bridge-header">
        <span class="dsv-bridge-title" id="dsv-bridge-title">Details</span>
        <button class="dsv-bridge-close" id="dsv-bridge-close" aria-label="Close details panel">✕</button>
      </div>
      <div class="dsv-bridge-meta" id="dsv-bridge-meta"></div>
      <div class="dsv-bridge-tags" id="dsv-bridge-tags"></div>
      <div class="dsv-bridge-body" id="dsv-bridge-body"></div>
      <div class="dsv-bridge-footer">
        <button class="dsv-bridge-inject-btn" id="dsv-bridge-inject">⬆ Inject</button>
        <button class="dsv-bridge-delete-btn" id="dsv-bridge-delete">🗑 Delete</button>
      </div>
    `;
    document.body.appendChild(bridge);
  }

  // ---- Notifications ----
  function showNotification(message, type = 'info', count = 1) {
    if (notificationTimeout) clearTimeout(notificationTimeout);
    notificationCount += count;
    const badge = document.getElementById('dsv-badge');
    if (badge) { badge.style.display = 'block'; }
    if (currentNotification) {
      const c = currentNotification.querySelector('.dsv-toast-count');
      if (c) c.textContent = notificationCount > 99 ? '99+' : notificationCount;
      notificationTimeout = setTimeout(hideNotification, 2800);
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'dsv-toast';
    const icons = { info: 'ℹ', success: '✓', error: '✖' };
    const colors = { info: '#3b82f6', success: '#22c55e', error: '#ef4444' };
    toast.style.background = colors[type] || colors.info;
    toast.innerHTML = `<span class="dsv-toast-icon">${icons[type]||'ℹ'}</span><span>${message}</span><span class="dsv-toast-count">${notificationCount}</span>`;
    document.body.appendChild(toast);
    currentNotification = toast;
    requestAnimationFrame(() => toast.classList.add('show'));
    notificationTimeout = setTimeout(hideNotification, 2800);
  }

  function hideNotification() {
    if (notificationTimeout) clearTimeout(notificationTimeout);
    if (currentNotification) {
      currentNotification.classList.remove('show');
      setTimeout(() => { currentNotification?.remove(); currentNotification = null; notificationCount = 0; }, 300);
    }
    const badge = document.getElementById('dsv-badge');
    if (badge) badge.style.display = 'none';
  }

  // ---- Content parsing ----
  function buildStructuredContent(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return san(payload);
    const blocks = [];
    const push = (label, value) => {
      const text = Array.isArray(value) ? value.join(', ') : san(value);
      if (text) blocks.push(`**${label}:** ${text}`);
    };
    push('Summary', payload.summary || payload.overview || payload.description);
    push('Problem', payload.problem || payload.issue || payload.challenge);
    push('Solution', payload.solution || payload.fix || payload.answer || payload.result);
    push('Context', payload.context || payload.notes || payload.details);
    push('Files', payload.files);
    push('Next Steps', payload.nextSteps || payload.next_steps || payload.followUp);
    return blocks.length > 0 ? blocks.join('\n') : JSON.stringify(payload, null, 2);
  }

  function extractMemoryPayload(rawContent) {
    const cleaned = san(rawContent)
      .replace(/^\[?\w*\]?\s*/i, '').replace(/\s*\[?\/\w*\]?\s*$/i, '')
      .replace(/^```[\w-]*\s*/i, '').replace(/```$/i, '').trim();
    if (!cleaned) return null;
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch (e) {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        title: san(parsed.title || parsed.name || 'Memory'),
        content: buildStructuredContent(parsed),
        tags: extractTags(san(parsed.title || ''), buildStructuredContent(parsed), parsed.tags)
      };
    }
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    const title = lines[0] && lines[0].length < 60 ? lines[0] : 'Memory';
    const content = lines.length > 1 ? lines.slice(1).join('\n').trim() || cleaned : cleaned;
    return { title, content, tags: extractTags(title, content) };
  }

  // ---- Stream-safe save ----
  // We key pending streams by a "slot" based on the BEGINNING of the content
  // so that as DeepSeek streams more tokens, we update the same slot instead of
  // creating new ones. Only commit after STREAM_SETTLE_MS of no updates.
  function saveParsedMemoryStreamSafe(rawContent) {
    // The slot key is a hash of just the first 80 chars — stable across streaming
    const slotKey = hashCode(rawContent.slice(0, 80));

    // If a pending stream exists for this slot, update its content and reset timer
    if (pendingStreams[slotKey]) {
      clearTimeout(pendingStreams[slotKey].timer);
      pendingStreams[slotKey].rawContent = rawContent; // keep latest (longest) version
    } else {
      pendingStreams[slotKey] = { rawContent };
    }

    pendingStreams[slotKey].timer = setTimeout(async () => {
      const finalRaw = pendingStreams[slotKey].rawContent;
      delete pendingStreams[slotKey];

      const finalSig = hashCode(finalRaw);
      if (processedSignatures.has(finalSig)) return;

      const payload = extractMemoryPayload(finalRaw);
      if (!payload || !payload.content) return;

      const memories = await loadMemories();

      // Deduplicate: exact sig match OR content too similar to an existing memory
      const isDuplicate = memories.some(m =>
        m._sig === finalSig || isTooSimilar(m.content, payload.content)
      );
      if (isDuplicate) {
        processedSignatures.add(finalSig);
        return;
      }

      memories.push({
        title: payload.title,
        content: payload.content,
        tags: payload.tags || [],
        timestamp: Date.now(),
        source: 'auto',
        _sig: finalSig
      });
      if (memories.length > MAX_MEMORIES) memories.splice(0, memories.length - MAX_MEMORIES);
      await saveMemories(memories);
      processedSignatures.add(finalSig);

      const modal = document.getElementById(MODAL_ID);
      if (modal?.classList.contains('show')) {
        renderList(document.getElementById('dsv-search-input')?.value || '');
        renderTagBar();
      }
      showNotification('🧠 Memory saved', 'success', 1);
      updateStatus();
    }, STREAM_SETTLE_MS);
  }

  // ---- Tag bar ----
  async function renderTagBar() {
    const bar = document.getElementById('dsv-tag-bar');
    if (!bar) return;
    const memories = await loadMemories();
    const tagCount = {};
    memories.forEach(m => (m.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
    const topTags = Object.entries(tagCount).sort((a,b) => b[1]-a[1]).slice(0, 12);
    if (topTags.length === 0) { bar.innerHTML = ''; return; }
    bar.innerHTML = topTags.map(([tag, count]) => {
      const active = activeTagFilter === tag ? ' active' : '';
      return `<button class="dsv-tag-chip${active}" data-tag="${escHtml(tag)}">#${escHtml(tag)} <span class="dsv-tag-count">${count}</span></button>`;
    }).join('');
    bar.querySelectorAll('.dsv-tag-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        activeTagFilter = (activeTagFilter === tag) ? null : tag;
        renderTagBar();
        renderList(document.getElementById('dsv-search-input')?.value || '');
      });
    });
  }

  // ---- Render memory list (grouped by date) ----
  async function renderList(filter = '') {
    const list = document.getElementById('dsv-memory-list');
    if (!list) return;
    const memories = await loadMemories();
    let items = [...memories].sort((a, b) => b.timestamp - a.timestamp);

    // Tag filter
    if (activeTagFilter) {
      items = items.filter(m => (m.tags || []).includes(activeTagFilter));
    }
    // Text filter
    if (filter) {
      const q = filter.toLowerCase();
      items = items.filter(m =>
        (m.title || '').toLowerCase().includes(q) ||
        (m.content || '').toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.includes(q))
      );
    }

    if (!items.length) {
      list.innerHTML = `<div class="dsv-empty-state">${memories.length ? 'No match' : 'No memories yet'}</div>`;
      return;
    }

    // Group by date
    const groups = {};
    const GROUP_ORDER = ['Today','Yesterday','This Week','This Month','Older'];
    items.forEach(item => {
      const g = dateGroup(item.timestamp);
      if (!groups[g]) groups[g] = [];
      groups[g].push(item);
    });

    let html = '';
    GROUP_ORDER.forEach(group => {
      if (!groups[group]) return;
      html += `<div class="dsv-group-label">${group}</div>`;
      groups[group].forEach(item => {
        const realIndex = memories.indexOf(item);
        const preview = san(item.content).slice(0, 50) + (san(item.content).length > 50 ? '…' : '');
        const tagPills = (item.tags || []).slice(0,3).map(t => `<span class="dsv-item-tag">#${escHtml(t)}</span>`).join('');
        const src = item.source === 'auto' ? '⚡' : '✎';
        html += `
          <div class="dsv-memory-item" data-index="${realIndex}" role="listitem">
            <div class="dsv-item-body" data-index="${realIndex}" title="View full details">
              <div class="dsv-item-title"><span class="dsv-src">${src}</span>${escHtml(item.title || 'Untitled')}</div>
              <div class="dsv-item-preview">${escHtml(preview)}</div>
              ${tagPills ? `<div class="dsv-item-tags">${tagPills}</div>` : ''}
            </div>
            <div class="dsv-item-actions">
              <label class="dsv-checkbox-label" title="Select">
                <input type="checkbox" class="dsv-select-checkbox" data-index="${realIndex}" />
                <span class="dsv-checkmark"></span>
              </label>
              <button class="dsv-del-btn" data-index="${realIndex}" aria-label="Delete memory ${escHtml(item.title || 'Untitled')}">✖</button>
            </div>
          </div>`;
      });
    });
    list.innerHTML = html;

    list.querySelectorAll('.dsv-item-body').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); openBridge(parseInt(el.dataset.index)); });
    });
    list.querySelectorAll('.dsv-del-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const idx = Number(btn.dataset.index);
        const mems = await loadMemories();
        mems.splice(idx, 1);
        await saveMemories(mems);
        if (bridgeCurrentIndex === idx) closeBridge();
        renderList(document.getElementById('dsv-search-input')?.value || '');
        renderTagBar();
        updateStatus();
        showNotification('Deleted', 'info');
      });
    });

    // Select-all button
    document.getElementById('dsv-select-all').onclick = () => {
      const boxes = list.querySelectorAll('.dsv-select-checkbox');
      const allChecked = [...boxes].every(cb => cb.checked);
      boxes.forEach(cb => cb.checked = !allChecked);
    };
  }

  // ---- Bridge (detail panel anchored left of modal) ----
  function positionBridge() {
    const modal = document.getElementById(MODAL_ID);
    const bridge = document.getElementById(BRIDGE_ID);
    if (!modal || !bridge) return;
    const rect = modal.getBoundingClientRect();
    const bw = Math.min(320, rect.left - 20);
    if (bw < 160) { bridge.style.display = 'none'; return; } // not enough room
    bridge.style.display = '';
    bridge.style.width = `${bw}px`;
    bridge.style.left = `${rect.left - bw - 10}px`;
    bridge.style.top = `${rect.top}px`;
    bridge.style.maxHeight = `${window.innerHeight - rect.top - 12}px`;
  }

  function openBridge(index) {
    loadMemories().then(memories => {
      const item = memories[index];
      if (!item) return;
      bridgeCurrentIndex = index;
      document.getElementById('dsv-bridge-title').textContent = item.title || 'Untitled';
      document.getElementById('dsv-bridge-meta').innerHTML =
        `<span class="dsv-bridge-src">${item.source === 'auto' ? '⚡ Auto' : '✎ Manual'}</span> · <span>${timeSince(item.timestamp)}</span>`;
      // Tags
      const tagsEl = document.getElementById('dsv-bridge-tags');
      tagsEl.innerHTML = (item.tags || []).map(t => `<span class="dsv-item-tag">#${escHtml(t)}</span>`).join('');
      // Body: render **Label:** Value pairs nicely
      const lines = (item.content || '').split('\n');
      document.getElementById('dsv-bridge-body').innerHTML = lines.map(line => {
        const m = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
        if (m) return `<div class="dsv-field"><span class="dsv-field-label">${escHtml(m[1])}</span><span class="dsv-field-value">${escHtml(m[2])}</span></div>`;
        return line ? `<div class="dsv-field-line">${escHtml(line)}</div>` : '<div class="dsv-field-spacer"></div>';
      }).join('');
      positionBridge();
      document.getElementById(BRIDGE_ID).classList.add('open');
    });
  }

  function closeBridge() {
    document.getElementById(BRIDGE_ID)?.classList.remove('open');
    bridgeCurrentIndex = null;
  }

  // ---- Accordion ----
  function toggleAccordion() {
    const content = document.getElementById('dsv-accordion-content');
    const icon = document.getElementById('dsv-accordion-icon');
    const modal = document.getElementById(MODAL_ID);
    if (!content || !icon || !modal) return;
    const isOpen = content.classList.toggle('open');
    document.getElementById('dsv-accordion-header').classList.toggle('open', isOpen);
    document.getElementById('dsv-accordion-header').setAttribute('aria-expanded', String(isOpen));
    modal.classList.toggle('library-open', isOpen);
    icon.textContent = isOpen ? '▲' : '▼';
    if (isOpen) {
      renderList(document.getElementById('dsv-search-input')?.value || '');
      renderTagBar();
      setTimeout(() => { clampModal(); if (document.getElementById(BRIDGE_ID)?.classList.contains('open')) positionBridge(); }, 310);
    } else {
      closeBridge();
    }
  }

  // Keep modal from clipping top of viewport
  function clampModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal?.classList.contains('show')) return;
    const gap = 10;
    const rect = modal.getBoundingClientRect();
    if (rect.top < gap) {
      const overshoot = gap - rect.top;
      const currentBottom = parseFloat(modal.style.bottom) || 0;
      modal.style.bottom = `${Math.max(0, currentBottom - overshoot)}px`;
    }
  }

  // ---- Modal toggle ----
  function toggleModal(open) {
    const modal = document.getElementById(MODAL_ID);
    const backdrop = document.getElementById(BACKDROP_ID);
    if (!modal || !backdrop) return;
    const shouldOpen = open !== undefined ? open : !modal.classList.contains('show');
    modal.classList.toggle('show', shouldOpen);
    backdrop.classList.toggle('show', shouldOpen);
    if (shouldOpen) {
      document.getElementById(FAB_ID)?.setAttribute('aria-expanded', 'true');
      renderList(document.getElementById('dsv-search-input')?.value || '');
      renderTagBar();
      updateStatus();
      notificationCount = 0;
      document.getElementById('dsv-badge') && (document.getElementById('dsv-badge').style.display = 'none');
      closeBridge();
      setTimeout(() => document.getElementById('dsv-search-input')?.focus(), 30);
      setTimeout(clampModal, 50);
    } else {
      document.getElementById(FAB_ID)?.setAttribute('aria-expanded', 'false');
      closeBridge();
    }
  }

  function updateStatus() {
    loadMemories().then(memories => {
      const s = document.getElementById('dsv-accordion-status');
      if (s) s.textContent = `${memories.length} saved`;
    });
  }

  // ---- Primer inject ----
  function injectPrimer() {
    if (setInputValue(VAULT_PRIMER)) {
      showNotification('Primer injected — paste it at the start of a new chat!', 'success');
      toggleModal(false);
    } else {
      navigator.clipboard.writeText(VAULT_PRIMER)
        .then(() => showNotification('Primer copied to clipboard!', 'success'))
        .catch(() => showNotification('Could not copy primer', 'error'));
    }
  }

  // ---- Inject memories ----
  async function injectMemories(selectedOnly = false) {
    const memories = await loadMemories();
    if (!memories.length) { showNotification('No memories', 'error'); return; }
    let toInject = memories;
    if (selectedOnly) {
      const checked = [...document.querySelectorAll('.dsv-select-checkbox:checked')];
      if (!checked.length) { showNotification('Nothing selected', 'error'); return; }
      const idxs = checked.map(cb => parseInt(cb.dataset.index));
      toInject = memories.filter((_, i) => idxs.includes(i));
    }
    let ctx = `${VAULT_PRIMER}\n\n[MEMORY CONTEXT — ${toInject.length} item(s)]:\n`;
    toInject.forEach((m, i) => { ctx += `\n--- ${i+1}. ${m.title} ---\n${san(m.content)}\n`; });
    ctx += '\n[END MEMORY CONTEXT]\n\nPlease acknowledge the above memories and continue our session.';
    if (setInputValue(ctx)) {
      toggleModal(false);
      showNotification(`Injected ${toInject.length} memories`, 'success');
    } else {
      showNotification('Could not find chat input', 'error');
    }
  }

  // ---- Export ----
  async function exportMemories() {
    const memories = await loadMemories();
    if (!memories.length) { showNotification('No memories', 'error'); return; }
    const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `vault_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showNotification('Exported!', 'success');
  }

  // ---- Import ----
  async function importMemoriesFromFile(file) {
    if (!file) return;
    let parsed = null;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (e) {
      showNotification('Invalid JSON file', 'error');
      return;
    }
    if (!Array.isArray(parsed)) {
      showNotification('Expected an array of memories', 'error');
      return;
    }

    const existing = await loadMemories();
    let added = 0;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const title = san(entry.title || 'Memory');
      const content = san(entry.content || entry.summary || '');
      if (!content) continue;
      const sig = entry._sig || hashCode(content);
      const duplicate = existing.some(m =>
        m._sig === sig ||
        (san(m.title).toLowerCase() === title.toLowerCase() && isTooSimilar(san(m.content), content))
      );
      if (duplicate) continue;
      existing.push({
        title,
        content,
        tags: extractTags(title, content, Array.isArray(entry.tags) ? entry.tags : []),
        timestamp: Number(entry.timestamp) || Date.now(),
        source: entry.source || 'import',
        _sig: sig
      });
      processedSignatures.add(sig);
      added++;
    }
    if (existing.length > MAX_MEMORIES) existing.splice(0, existing.length - MAX_MEMORIES);
    await saveMemories(existing);
    renderList(document.getElementById('dsv-search-input')?.value || '');
    renderTagBar();
    updateStatus();
    showNotification(added ? `Imported ${added} new memorie(s)` : 'No new memories to import', added ? 'success' : 'info');
  }

  // ---- Manual save ----
  async function saveMemory(title, content, source = 'manual') {
    if (!san(content)) { showNotification('No content', 'error'); return; }
    const memories = await loadMemories();
    memories.push({ title: title || 'Memory', content: san(content), tags: extractTags(title, content), timestamp: Date.now(), source });
    if (memories.length > MAX_MEMORIES) memories.splice(0, memories.length - MAX_MEMORIES);
    await saveMemories(memories);
    renderList(document.getElementById('dsv-search-input')?.value || '');
    renderTagBar();
    updateStatus();
    showNotification('Saved!', 'success');
  }

  // ---- Scan page ----
  async function scanPage() {
    const allText = document.body.textContent || '';
    const regex = new RegExp(`${VAULT_TAG_ESC}([\\s\\S]*?)\\[/VAULT_UPDATE\\]`, 'g');
    let match, found = 0;
    while ((match = regex.exec(allText)) !== null) {
      const raw = match[1].trim();
      if (raw) { saveParsedMemoryStreamSafe(raw); found++; }
    }
    showNotification(found ? `Found ${found} vault block(s) on page` : 'No vault blocks found', found ? 'success' : 'info');
  }

  // ---- Auto-save observer ----
  function processVaultText(text) {
    if (!text || !text.includes(VAULT_TAG)) return null;
    lastVaultHintAt = Date.now();
    const regex = new RegExp(`${VAULT_TAG_ESC}([\\s\\S]*?)\\[/VAULT_UPDATE\\]`);
    const m = text.match(regex);
    if (m) return m[1].trim();
    // Partial: line contains open tag but no close yet
    for (const line of text.split('\n')) {
      if (line.includes(VAULT_TAG)) return line.replace(VAULT_TAG, '').trim();
    }
    return null;
  }

  function setupAutoSaveObserver() {
    const observer = new MutationObserver(mutations => {
      for (const mut of mutations) {
        if (mut.type === 'childList') {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            const raw = processVaultText(node.textContent || '');
            if (raw) saveParsedMemoryStreamSafe(raw);
          }
        } else if (mut.type === 'characterData') {
          const raw = processVaultText(mut.target.parentElement?.textContent || '');
          if (raw) saveParsedMemoryStreamSafe(raw);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Fallback periodic scan
    if (scannerInterval) clearInterval(scannerInterval);
    scannerInterval = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - lastVaultHintAt > 20000) return;
      const allText = document.body.textContent || '';
      if (!allText.includes(VAULT_TAG)) return;
      const regex = new RegExp(`${VAULT_TAG_ESC}([\\s\\S]*?)\\[/VAULT_UPDATE\\]`, 'g');
      let m;
      while ((m = regex.exec(allText)) !== null) {
        if (m[1].trim()) saveParsedMemoryStreamSafe(m[1].trim());
      }
    }, 3000);

    console.log('🧠 Memory Vault v4.1 active — stream-safe, tag-filtered, bridge panel.');
  }

  // ---- Init ----
  function init() {
    createUI();
    document.getElementById('dsv-accordion-header').setAttribute('role', 'button');
    document.getElementById('dsv-accordion-header').setAttribute('tabindex', '0');
    document.getElementById('dsv-accordion-header').setAttribute('aria-expanded', 'false');
    document.getElementById('dsv-accordion-content').setAttribute('aria-label', 'Saved memories list');
    document.getElementById('dsv-memory-list').setAttribute('role', 'list');

    document.getElementById(FAB_ID).addEventListener('click', () => toggleModal(true));
    document.getElementById('dsv-close').addEventListener('click', () => toggleModal(false));
    document.getElementById(BACKDROP_ID).addEventListener('click', () => toggleModal(false));
    document.getElementById('dsv-accordion-header').addEventListener('click', toggleAccordion);
    document.getElementById('dsv-accordion-header').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAccordion();
      }
    });
    document.getElementById('dsv-primer-btn').addEventListener('click', injectPrimer);
    document.getElementById('dsv-bridge-close').addEventListener('click', closeBridge);
    document.getElementById('dsv-scan-btn').addEventListener('click', scanPage);
    document.getElementById('dsv-inject-selected').addEventListener('click', () => injectMemories(true));
    document.getElementById('dsv-inject-all').addEventListener('click', () => injectMemories(false));
    document.getElementById('dsv-import').addEventListener('click', () => document.getElementById('dsv-import-input').click());
    document.getElementById('dsv-import-input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      await importMemoriesFromFile(file);
      e.target.value = '';
    });
    document.getElementById('dsv-export').addEventListener('click', exportMemories);

    document.getElementById('dsv-bridge-inject').addEventListener('click', async () => {
      if (bridgeCurrentIndex === null) return;
      const mems = await loadMemories();
      const item = mems[bridgeCurrentIndex];
      if (!item) return;
      if (setInputValue(`[MEMORY: ${item.title}]\n${item.content}\n[/MEMORY]`)) {
        closeBridge(); toggleModal(false); showNotification('Injected!', 'success');
      } else {
        showNotification('Could not find chat input', 'error');
      }
    });

    document.getElementById('dsv-bridge-delete').addEventListener('click', async () => {
      if (bridgeCurrentIndex === null) return;
      if (!confirm('Delete this memory?')) return;
      const mems = await loadMemories();
      mems.splice(bridgeCurrentIndex, 1);
      await saveMemories(mems);
      closeBridge();
      renderList(document.getElementById('dsv-search-input')?.value || '');
      renderTagBar();
      updateStatus();
      showNotification('Deleted', 'info');
    });

    document.getElementById('dsv-upload-area').addEventListener('click', () => document.getElementById('dsv-file-input').click());
    document.getElementById('dsv-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const unsupported = /\.(pdf|docx)$/i.test(file.name);
      if (unsupported) {
        showNotification('PDF/DOCX upload not yet supported', 'error');
        e.target.value = '';
        return;
      }
      const title = document.getElementById('dsv-memory-title').value || file.name;
      const reader = new FileReader();
      reader.onload = async ev => { await saveMemory(title, ev.target.result, 'file'); document.getElementById('dsv-memory-title').value = ''; };
      reader.readAsText(file); e.target.value = '';
    });

    document.getElementById('dsv-save-current').addEventListener('click', async () => {
      const val = getCurrentInputValue();
      if (!val) { showNotification('Nothing in chat input', 'error'); return; }
      const title = document.getElementById('dsv-memory-title').value || 'Chat Snippet';
      await saveMemory(title, val); document.getElementById('dsv-memory-title').value = '';
    });

    document.getElementById('dsv-memory-title').addEventListener('keypress', async e => {
      if (e.key !== 'Enter') return;
      const val = getCurrentInputValue();
      if (!val) { showNotification('Nothing in chat input', 'error'); return; }
      await saveMemory(e.target.value || 'Chat Snippet', val); e.target.value = '';
    });

    document.getElementById('dsv-clear').addEventListener('click', async () => {
      if (!confirm('Clear ALL memories? This cannot be undone.')) return;
      await saveMemories([]); processedSignatures.clear(); Object.keys(pendingStreams).forEach(k => { clearTimeout(pendingStreams[k].timer); delete pendingStreams[k]; });
      closeBridge(); renderList(); renderTagBar(); updateStatus(); showNotification('All memories cleared', 'info');
    });

    document.getElementById('dsv-search-input').addEventListener('input', e => {
      const q = e.target.value;
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => renderList(q), 120);
    });

    window.addEventListener('resize', () => {
      clampModal();
      if (document.getElementById(BRIDGE_ID)?.classList.contains('open')) positionBridge();
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (document.getElementById(BRIDGE_ID)?.classList.contains('open')) closeBridge();
      else if (document.getElementById(MODAL_ID)?.classList.contains('show')) toggleModal(false);
    });

    setupAutoSaveObserver();
    updateStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
