const els = {
  statusText: document.getElementById('statusText'),
  accountSelect: document.getElementById('accountSelect'),
  addAccount: document.getElementById('addAccount'),
  qrButton: document.getElementById('qrButton'),
  activeAccountLabel: document.getElementById('activeAccountLabel'),
  skipHistoryToggle: document.getElementById('skipHistoryToggle'),
  inlineStatus: document.getElementById('inlineStatus'),
  qrModal: document.getElementById('qrModal'),
  qrClose: document.getElementById('qrClose'),
  qrCanvas: document.getElementById('qrCanvas'),
  qrImage: document.getElementById('qrImage'),
  qrCanvasInline: document.getElementById('qrCanvasInline'),
  qrImageInline: document.getElementById('qrImageInline'),
  toast: document.getElementById('toast')
};

const state = {
  accounts: [],
  selectedId: null
};

function showToast(message, isError = false) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('show');
  els.toast.classList.toggle('error', !!isError);
  setTimeout(() => els.toast.classList.remove('show'), 2600);
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function updateSelectionMeta() {
  const account = state.accounts.find((a) => a.id === state.selectedId) || null;
  els.activeAccountLabel.textContent = account
    ? `${account.label} (${account.status || 'unknown'})`
    : 'Select or add an account';

  const canAct = !!account;
  els.qrButton.disabled = !canAct;
  els.skipHistoryToggle.disabled = !canAct;

  if (account) {
    const pressed = !!account.skipHistoryBeforeReady;
    els.skipHistoryToggle.setAttribute('aria-pressed', String(pressed));
    els.skipHistoryToggle.textContent = pressed ? 'Skip old messages: ON' : 'Skip old messages';
  } else {
    els.skipHistoryToggle.setAttribute('aria-pressed', 'false');
    els.skipHistoryToggle.textContent = 'Skip old messages';
  }
}

function renderAccounts() {
  const previous = state.selectedId;
  const options = state.accounts.map((a) => `<option value="${a.id}">${a.label} (${a.status || 'unknown'})</option>`);
  els.accountSelect.innerHTML = options.length
    ? options.join('')
    : '<option value="">No accounts</option>';

  if (options.length) {
    const valid = state.accounts.some((a) => a.id === previous);
    state.selectedId = valid ? previous : state.accounts[0].id;
    els.accountSelect.value = String(state.selectedId);
    els.statusText.textContent = `${state.accounts.length} account(s) loaded`;
  } else {
    state.selectedId = null;
    els.accountSelect.value = '';
    els.statusText.textContent = 'No accounts yet. Click Add Account.';
  }

  updateSelectionMeta();
}

async function loadAccounts() {
  const data = await request('/api/accounts');
  state.accounts = Array.isArray(data.items) ? data.items : [];
  renderAccounts();
}

function drawQr(qrText) {
  if (window.QRCode && els.qrCanvas) {
    QRCode.toCanvas(els.qrCanvas, qrText, { width: 240 }, () => {});
  }
  if (window.QRCode && els.qrCanvasInline) {
    QRCode.toCanvas(els.qrCanvasInline, qrText, { width: 200 }, () => {});
  }
}

function applyQrImage(dataUrl) {
  if (dataUrl) {
    els.qrImage.src = dataUrl;
    els.qrImage.style.display = 'block';
    els.qrCanvas.style.display = 'none';

    els.qrImageInline.src = dataUrl;
    els.qrImageInline.style.display = 'block';
    els.qrCanvasInline.style.display = 'none';
    return;
  }

  els.qrImage.style.display = 'none';
  els.qrCanvas.style.display = 'block';
  els.qrImageInline.style.display = 'none';
  els.qrCanvasInline.style.display = 'block';
}

async function addAccount() {
  const label = window.prompt('Enter account label');
  if (!label || !label.trim()) return;

  els.addAccount.disabled = true;
  try {
    await request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label.trim() })
    });
    await loadAccounts();
    showToast('Account added');
  } catch (err) {
    showToast(err.message || 'Failed to add account', true);
  } finally {
    els.addAccount.disabled = false;
  }
}

async function showQr() {
  if (!state.selectedId) {
    showToast('Select an account first', true);
    return;
  }

  try {
    els.inlineStatus.textContent = 'Fetching QR...';
    const data = await request(`/api/accounts/${state.selectedId}/qr`);
    applyQrImage(data.qrImage || null);
    if (!data.qrImage && data.qr) {
      drawQr(data.qr);
    }
    els.inlineStatus.textContent = 'QR ready';
    els.qrModal.style.display = 'grid';
  } catch (err) {
    els.inlineStatus.textContent = 'QR unavailable';
    showToast(err.message || 'QR not available yet', true);
  }
}

async function toggleSkipHistory() {
  if (!state.selectedId) return;
  const current = state.accounts.find((a) => a.id === state.selectedId);
  if (!current) return;
  const next = !current.skipHistoryBeforeReady;

  try {
    const updated = await request(`/api/accounts/${state.selectedId}/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipHistoryBeforeReady: next })
    });
    state.accounts = state.accounts.map((a) => (a.id === updated.id ? updated : a));
    renderAccounts();
    showToast('Preference updated');
  } catch (err) {
    showToast(err.message || 'Failed to update preference', true);
  }
}

function setupEvents() {
  els.accountSelect.addEventListener('change', () => {
    state.selectedId = Number(els.accountSelect.value) || null;
    updateSelectionMeta();
  });

  els.addAccount.addEventListener('click', addAccount);
  els.qrButton.addEventListener('click', showQr);
  els.skipHistoryToggle.addEventListener('click', toggleSkipHistory);

  els.qrClose.addEventListener('click', () => {
    els.qrModal.style.display = 'none';
  });

  els.qrModal.addEventListener('click', (event) => {
    if (event.target === els.qrModal) {
      els.qrModal.style.display = 'none';
    }
  });
}

function setupEventsStream() {
  const ev = new EventSource('/api/events');
  ev.addEventListener('status', (event) => {
    try {
      const payload = JSON.parse(event.data || '{}');
      if (Array.isArray(payload.accounts)) {
        state.accounts = payload.accounts;
        renderAccounts();
      }
    } catch (_err) {
      // Ignore malformed SSE payloads.
    }
  });
}

(async function init() {
  setupEvents();
  try {
    await loadAccounts();
  } catch (err) {
    els.statusText.textContent = 'Failed to load accounts';
    showToast(err.message || 'Failed to load accounts', true);
  }
  setupEventsStream();
})();
