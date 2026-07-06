// content.js - DeepSeek Memory Vault v3.0
// Compact floating modal with accordion
(function() {
  'use strict';

  const STORAGE_KEY = 'deepseek_memory_vault';
  const MAX_MEMORIES = 80;
  const VAULT_TAG = '[VAULT_UPDATE]';
  const FAB_ID = 'dsv-fab';
  const MODAL_ID = 'dsv-modal';
  const BACKDROP_ID = 'dsv-backdrop';
  const processedSignatures = new Set();
  
  // Notification state
  let notificationCount = 0;
  let notificationTimeout = null;
  let currentNotification = null;

  const loadMemories = () =>
    new Promise(resolve => chrome.storage.local.get([STORAGE_KEY], res => resolve(res[STORAGE_KEY] || [])));

  const saveMemories = (memories) =>
    new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: memories }, resolve));

  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  };

  const hashCode = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString();
  };

  const sanitizeText = (value) => String(value ?? '').trim();

  function getCurrentInputValue() {
    const selectors = [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="ask"]',
      'textarea[role="textbox"]',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        return sanitizeText(element.value);
      }
      if (element.isContentEditable) {
        return sanitizeText(element.innerText || element.textContent || '');
      }
    }

    const active = document.activeElement;
    if (active && active.isContentEditable) {
      return sanitizeText(active.innerText || active.textContent || '');
    }

    return '';
  }

  function createUI() {
    // Remove existing elements if any
    const existingFab = document.getElementById(FAB_ID);
    const existingModal = document.getElementById(MODAL_ID);
    const existingBackdrop = document.getElementById(BACKDROP_ID);
    
    if (existingFab) existingFab.remove();
    if (existingModal) existingModal.remove();
    if (existingBackdrop) existingBackdrop.remove();

    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.className = 'dsv-backdrop';
    document.body.appendChild(backdrop);

    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.className = 'dsv-fab';
    fab.innerHTML = '<span>🧠</span><span class="notification-badge" id="dsv-notification-badge" style="display:none;"></span>';
    fab.title = 'Memory Vault';
    document.body.appendChild(fab);

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'dsv-modal';
    modal.innerHTML = `
      <div class="dsv-header">
        <h2>VAULT</h2>
        <button class="dsv-close-btn" id="dsv-close" aria-label="Close">✕</button>
      </div>

      <div class="dsv-section dsv-capture-section">
        <div class="dsv-capture-title">IMPORT / SAVE</div>
        <div class="dsv-upload-area" id="dsv-upload-area">
          📤 Import file
          <input type="file" id="dsv-file-input" accept=".txt,.pdf,.docx,.json,.csv,.js,.py,.html,.css,.md">
        </div>
        <div class="dsv-manual-save">
          <input id="dsv-memory-title" placeholder="Title..." />
          <button id="dsv-save-current">SAVE</button>
        </div>
      </div>

      <div class="dsv-section dsv-library-section">
        <div class="dsv-accordion-header" id="dsv-accordion-header">
          <span class="dsv-accordion-title">MEMORY LIBRARY</span>
          <span class="dsv-accordion-status" id="dsv-accordion-status">0 saved</span>
          <span class="dsv-accordion-icon" id="dsv-accordion-icon">▼</span>
        </div>
        <div class="dsv-accordion-content" id="dsv-accordion-content">
          <div class="dsv-memory-list" id="dsv-memory-list">
            <div class="dsv-empty-state">No memories yet</div>
          </div>
        </div>
      </div>

      <div class="dsv-actions">
        <button class="dsv-inject-btn" id="dsv-inject">INJECT</button>
        <button class="dsv-export-btn" id="dsv-export">EXPORT</button>
        <button class="dsv-clear-btn" id="dsv-clear">CLEAR</button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function timeSince(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  function updateStatus() {
    const status = document.getElementById('dsv-accordion-status');
    if (status) {
      loadMemories().then(memories => {
        status.textContent = `${memories.length} saved`;
      });
    }
    updateNotificationBadge();
  }

  function updateNotificationBadge() {
    const badge = document.getElementById('dsv-notification-badge');
    if (!badge) return;
    
    if (notificationCount > 0) {
      badge.textContent = notificationCount > 99 ? '99+' : notificationCount;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function showNotification(message, type = 'info', count = 1) {
    if (notificationTimeout) {
      clearTimeout(notificationTimeout);
    }
    
    notificationCount += count;
    updateNotificationBadge();
    
    if (currentNotification) {
      const countEl = currentNotification.querySelector('.dsv-toast-count');
      if (countEl) {
        countEl.textContent = notificationCount > 99 ? '99+' : notificationCount;
      }
      notificationTimeout = setTimeout(() => {
        hideNotification();
      }, 2800);
      return;
    }
    
    const toast = document.createElement('div');
    toast.className = 'dsv-toast';
    
    const icons = { info: 'ℹ️', success: '✓', error: '✖' };
    const colors = { info: '#3b82f6', success: '#22c55e', error: '#ef4444' };
    
    toast.innerHTML = `
      <span class="dsv-toast-icon">${icons[type] || icons.info}</span>
      <span>${message}</span>
      <span class="dsv-toast-count">${notificationCount > 99 ? '99+' : notificationCount}</span>
    `;
    toast.style.background = colors[type] || colors.info;
    
    document.body.appendChild(toast);
    currentNotification = toast;
    
    requestAnimationFrame(() => toast.classList.add('show'));
    
    notificationTimeout = setTimeout(() => {
      hideNotification();
    }, 2800);
  }

  function hideNotification() {
    if (notificationTimeout) {
      clearTimeout(notificationTimeout);
      notificationTimeout = null;
    }
    
    if (currentNotification) {
      currentNotification.classList.remove('show');
      setTimeout(() => {
        currentNotification.remove();
        currentNotification = null;
        notificationCount = 0;
        updateNotificationBadge();
      }, 300);
    }
  }

  function buildStructuredContent(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return sanitizeText(payload);
    }

    const blocks = [];
    const pushSection = (label, value) => {
      if (value === undefined || value === null) return;
      const text = sanitizeText(value);
      if (text) blocks.push(`**${label}:** ${text}`);
    };

    pushSection('Summary', payload.summary || payload.overview || payload.description);
    pushSection('Problem', payload.problem || payload.issue || payload.challenge);
    pushSection('Solution', payload.solution || payload.fix || payload.answer || payload.result);
    pushSection('Context', payload.context || payload.notes || payload.details);
    pushSection('Files', Array.isArray(payload.files) ? payload.files.join(', ') : payload.files);
    pushSection('Next', payload.nextSteps || payload.next_steps || payload.followUp);

    return blocks.length > 0 ? blocks.join(' | ') : JSON.stringify(payload, null, 2);
  }

  function extractMemoryPayload(rawContent) {
    const cleaned = sanitizeText(rawContent)
      .replace(/^\[?\w*\]?\s*/i, '')
      .replace(/\s*\[?\/\w*\]?\s*$/i, '')
      .replace(/^```[\w-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    if (!cleaned) {
      return { title: 'Memory', content: '', fileName: 'Auto' };
    }

    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch (e) {}

    if (parsed && typeof parsed === 'object') {
      return {
        title: sanitizeText(parsed.title || parsed.name || 'Memory'),
        content: buildStructuredContent(parsed),
        fileName: sanitizeText(parsed.fileName || 'AI')
      };
    }

    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    return {
      title: lines[0] && lines[0].length < 50 ? lines[0] : 'Memory',
      content: lines.length > 1 ? lines.slice(1).join(' ').trim() || cleaned : cleaned,
      fileName: 'DeepSeek'
    };
  }

  async function saveParsedMemory(rawContent) {
    const payload = extractMemoryPayload(rawContent);
    const signature = hashCode(rawContent);
    if (processedSignatures.has(signature)) return false;
    processedSignatures.add(signature);

    const memories = await loadMemories();
    memories.push({
      title: payload.title,
      content: payload.content,
      fileName: payload.fileName,
      timestamp: Date.now(),
      autoSaved: true,
      source: 'auto'
    });

    if (memories.length > MAX_MEMORIES) {
      memories.splice(0, memories.length - MAX_MEMORIES);
    }

    await saveMemories(memories);
    updateStatus();
    return true;
  }

  async function renderList() {
    const list = document.getElementById('dsv-memory-list');
    const memories = await loadMemories();

    if (!memories.length) {
      list.innerHTML = '<div class="dsv-empty-state">No memories yet</div>';
      return;
    }

    const sorted = [...memories].sort((a, b) => b.timestamp - a.timestamp);
    list.innerHTML = sorted.map(item => {
      const preview = sanitizeText(item.content).length > 80
        ? `${sanitizeText(item.content).slice(0, 77)}…`
        : sanitizeText(item.content);
      const realIndex = memories.indexOf(item);
      return `
        <div class="dsv-memory-item">
          <button class="del-btn" data-index="${realIndex}" aria-label="Delete">✖</button>
          <div class="dsv-item-topline">
            <span class="dsv-badge ${item.autoSaved ? 'auto' : 'manual'}">${item.autoSaved ? 'A' : 'M'}</span>
            <span class="dsv-item-time">${timeSince(item.timestamp)}</span>
          </div>
          <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="preview">${escapeHtml(preview)}</div>
          <div class="meta">${escapeHtml(item.fileName || 'AI')}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.del-btn').forEach(button => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const idx = Number(event.currentTarget.dataset.index);
        const mems = await loadMemories();
        mems.splice(idx, 1);
        await saveMemories(mems);
        renderList();
        updateStatus();
        showNotification('Deleted', 'info');
      });
    });
  }

  function processVaultText(textContent) {
    if (!textContent || !textContent.includes(VAULT_TAG)) return null;
    const regex = new RegExp(`${VAULT_TAG}([\\s\\S]*?)\\[/VAULT_UPDATE\\]`);
    const match = textContent.match(regex);
    if (match) return match[1].trim();
    const lines = textContent.split('\n');
    for (const line of lines) {
      if (line.includes(VAULT_TAG)) return line.replace(VAULT_TAG, '').trim();
    }
    return null;
  }

  function setupAutoSaveObserver() {
    const targetNode = document.body;
    const config = { childList: true, subtree: true };

    const callback = async function(mutationsList) {
      let savedCount = 0;
      for (const mutation of mutationsList) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const rawContent = processVaultText(node.textContent || '');
          if (!rawContent) continue;
          const saved = await saveParsedMemory(rawContent);
          if (saved) savedCount++;
        }
      }
      if (savedCount > 0) {
        const modal = document.getElementById(MODAL_ID);
        if (modal && modal.classList.contains('show')) {
          renderList();
        }
        showNotification(`+${savedCount}`, 'success', savedCount);
      }
    };

    const observer = new MutationObserver(callback);
    observer.observe(targetNode, config);
    console.log('🧠 DeepSeek Memory Vault v3.0 watching for updates.');
  }

  async function saveMemory(title, content, fileName = '') {
    if (!content || !sanitizeText(content)) {
      showNotification('No content', 'error');
      return;
    }
    const memories = await loadMemories();
    memories.push({
      title: title || 'Memory',
      content: sanitizeText(content),
      fileName: fileName || 'Manual',
      timestamp: Date.now(),
      source: 'manual'
    });
    if (memories.length > MAX_MEMORIES) {
      memories.splice(0, memories.length - MAX_MEMORIES);
    }
    await saveMemories(memories);
    renderList();
    updateStatus();
    showNotification('Saved', 'success');
  }

  async function injectMemories() {
    const memories = await loadMemories();
    if (!memories.length) {
      showNotification('No memories', 'error');
      return;
    }
    let context = '[CONTEXT]:\n';
    memories.forEach((memory, index) => {
      context += `${index + 1}. ${memory.title}: ${sanitizeText(memory.content)}\n`;
    });
    context += '[END CONTEXT]';

    const textarea = document.querySelector('textarea[placeholder*="Ask"]') ||
      document.querySelector('textarea[placeholder*="ask"]') ||
      document.querySelector('textarea[role="textbox"]') ||
      document.querySelector('textarea');

    if (textarea) {
      textarea.value = context;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      toggleModal(false);
      showNotification('Injected', 'success');
    } else {
      showNotification('No input found', 'error');
    }
  }

  async function exportMemories() {
    const memories = await loadMemories();
    if (!memories.length) {
      showNotification('No memories', 'error');
      return;
    }
    const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `memories_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showNotification('Exported', 'success');
  }

  function toggleAccordion() {
    const header = document.getElementById('dsv-accordion-header');
    const content = document.getElementById('dsv-accordion-content');
    const icon = document.getElementById('dsv-accordion-icon');
    const modal = document.getElementById(MODAL_ID);

    if (!header || !content || !icon || !modal) return;

    const isOpen = content.classList.toggle('open');
    header.classList.toggle('open', isOpen);
    modal.classList.toggle('library-open', isOpen);

    if (isOpen) {
      renderList();
      icon.textContent = '▲';
    } else {
      icon.textContent = '▼';
    }
  }

  function toggleModal(open) {
    const modal = document.getElementById(MODAL_ID);
    const backdrop = document.getElementById(BACKDROP_ID);
    if (!modal || !backdrop) return;

    const shouldOpen = open !== undefined ? open : !modal.classList.contains('show');
    modal.classList.toggle('show', shouldOpen);
    backdrop.classList.toggle('show', shouldOpen);

    if (shouldOpen) {
      renderList();
      updateStatus();
      notificationCount = 0;
      updateNotificationBadge();
    }
  }

  function init() {
    createUI();

    const fab = document.getElementById(FAB_ID);
    const closeBtn = document.getElementById('dsv-close');
    const uploadArea = document.getElementById('dsv-upload-area');
    const fileInput = document.getElementById('dsv-file-input');
    const saveBtn = document.getElementById('dsv-save-current');
    const titleInput = document.getElementById('dsv-memory-title');
    const injectBtn = document.getElementById('dsv-inject');
    const exportBtn = document.getElementById('dsv-export');
    const clearBtn = document.getElementById('dsv-clear');
    const backdrop = document.getElementById(BACKDROP_ID);
    const accordionHeader = document.getElementById('dsv-accordion-header');

    fab.addEventListener('click', () => toggleModal(true));
    closeBtn.addEventListener('click', () => toggleModal(false));
    backdrop.addEventListener('click', () => toggleModal(false));
    accordionHeader.addEventListener('click', toggleAccordion);

    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const title = titleInput.value || file.name;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        await saveMemory(title, ev.target.result, file.name);
        titleInput.value = '';
      };
      reader.readAsText(file);
      event.target.value = '';
    });

    saveBtn.addEventListener('click', async () => {
      const currentValue = getCurrentInputValue();
      if (!currentValue) {
        showNotification('No text', 'error');
        return;
      }
      const title = titleInput.value || 'Chat';
      await saveMemory(title, currentValue, 'Manual');
      titleInput.value = '';
    });

    titleInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const currentValue = getCurrentInputValue();
        if (!currentValue) {
          showNotification('No text', 'error');
          return;
        }
        const title = titleInput.value || 'Chat';
        await saveMemory(title, currentValue, 'Manual');
        titleInput.value = '';
      }
    });

    injectBtn.addEventListener('click', injectMemories);
    exportBtn.addEventListener('click', exportMemories);
    clearBtn.addEventListener('click', async () => {
      if (confirm('Clear all memories?')) {
        await saveMemories([]);
        processedSignatures.clear();
        renderList();
        updateStatus();
        showNotification('Cleared', 'info');
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const modal = document.getElementById(MODAL_ID);
        if (modal && modal.classList.contains('show')) {
          toggleModal(false);
        }
      }
    });

    setupAutoSaveObserver();
    updateStatus();
    console.log('🧠 DeepSeek Memory Vault v3.0 loaded.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();