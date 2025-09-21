const chatContainer = document.getElementById('chat');
const form = document.getElementById('composer');
const messageInput = document.getElementById('message');
const clearChatButton = document.getElementById('clear-chat');
const toggleSettingsButton = document.getElementById('toggle-settings');
const settingsPanel = document.getElementById('settings-panel');
const endpointInput = document.getElementById('endpoint');
const modelInput = document.getElementById('model');
const systemInput = document.getElementById('system');
const thinkInput = document.getElementById('think');
const sidebar = document.querySelector('.sidebar');
const workspaceSubtitle = document.getElementById('workspace-subtitle');
const modelBadge = document.getElementById('active-model');
const endpointBadge = document.getElementById('active-endpoint');
const thinkBadge = document.getElementById('active-think');

const STORAGE_KEY = 'ai-agent-playground-settings-v1';
const DEFAULT_ENDPOINT = 'https://impossible-georgeanna-yuhfjrifj-d252474c.koyeb.app/api/chat';

const state = {
  messages: [],
  pending: false
};

function summariseEndpoint(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch (_error) {
    return url;
  }
}

function normaliseThinking(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normaliseThinking(item)).join('').trim();
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'value', 'message']) {
      if (typeof value[key] === 'string') {
        return value[key].trim();
      }
      if (Array.isArray(value[key])) {
        return value[key].map((item) => normaliseThinking(item)).join('').trim();
      }
    }
    return Object.values(value)
      .map((item) => (typeof item === 'string' ? item : normaliseThinking(item)))
      .join('')
      .trim();
  }
  return '';
}

function renderConnectionMeta() {
  const endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT;
  const model = modelInput.value.trim() || 'gpt-oss:20b';
  const thinkEnabled = thinkInput.checked;

  const endpointSummary = summariseEndpoint(endpoint);

  if (workspaceSubtitle) {
    workspaceSubtitle.textContent = `${model} • ${endpointSummary}`;
  }

  if (modelBadge) {
    modelBadge.textContent = model;
    modelBadge.title = model;
  }

  if (endpointBadge) {
    endpointBadge.textContent = endpointSummary;
    endpointBadge.title = endpoint;
  }

  if (thinkBadge) {
    thinkBadge.textContent = thinkEnabled ? 'Мысли: вкл' : 'Мысли: выкл';
    thinkBadge.dataset.state = thinkEnabled ? 'on' : 'off';
    thinkBadge.title = thinkEnabled ? 'Режим размышлений активен' : 'Режим размышлений отключён';
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      endpointInput.value = DEFAULT_ENDPOINT;
      modelInput.value = 'gpt-oss:20b';
      thinkInput.checked = true;
      renderConnectionMeta();
      return;
    }
    const parsed = JSON.parse(raw);
    endpointInput.value = parsed.endpoint || DEFAULT_ENDPOINT;
    modelInput.value = parsed.model || 'gpt-oss:20b';
    systemInput.value = parsed.system || '';
    thinkInput.checked = parsed.think ?? true;
  } catch (error) {
    console.warn('Не удалось загрузить сохранённые настройки', error);
    endpointInput.value = DEFAULT_ENDPOINT;
    modelInput.value = 'gpt-oss:20b';
    thinkInput.checked = true;
  }
  renderConnectionMeta();
}

function persistSettings() {
  const payload = {
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    model: modelInput.value.trim() || 'gpt-oss:20b',
    system: systemInput.value,
    think: thinkInput.checked
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  renderConnectionMeta();
}

function autoResizeTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function formatRole(role) {
  switch (role) {
    case 'user':
      return 'Пользователь';
    case 'assistant':
      return 'Ассистент';
    case 'tool':
      return 'Терминал';
    default:
      return role;
  }
}

function createMessageElement(message) {
  const template = document.getElementById('message-template');
  const element = template.content.firstElementChild.cloneNode(true);
  const avatar = element.querySelector('.avatar');
  const roleLabel = element.querySelector('.role');
  const content = element.querySelector('.content');
  const timestamp = element.querySelector('.timestamp');
  const thinkingDetails = element.querySelector('.thinking');
  const thinkingContent = element.querySelector('.thinking-content');

  element.dataset.role = message.role;

  avatar.dataset.role = message.role;
  avatar.textContent = message.role === 'user' ? 'U' : message.role === 'assistant' ? 'AI' : 'FX';
  roleLabel.textContent = formatRole(message.role);

  const created = message.createdAt || message.timestamp || new Date().toISOString();
  timestamp.textContent = new Date(created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const text = typeof message.content === 'string' ? message.content.trim() : '';
  if (text) {
    content.textContent = text;
  } else if (message.role === 'assistant' && !message.pending) {
    content.textContent = 'Готово.';
  } else if (message.pending) {
    content.textContent = 'Модель формулирует ответ…';
  } else {
    content.textContent = '';
  }

  const thinkingText = normaliseThinking(message.thinking);
  if (thinkingText) {
    thinkingContent.textContent = thinkingText;
    thinkingDetails.open = true;
  } else {
    thinkingDetails.remove();
  }

  if (message.pending) {
    element.classList.add('pending');
  }

  return element;
}

function renderChat() {
  chatContainer.innerHTML = '';
  state.messages.forEach((message) => {
    const element = createMessageElement(message);
    chatContainer.appendChild(element);
  });
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function updateStateMessages(nextMessages) {
  state.messages = nextMessages
    .filter((msg) => msg && typeof msg.role === 'string')
    .map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : '',
      name: msg.name,
      tool_call_id: msg.tool_call_id,
      thinking: normaliseThinking(msg.thinking),
      createdAt: msg.createdAt || msg.timestamp || new Date().toISOString()
    }));
  renderChat();
}

async function sendMessage(text) {
  const userMessage = {
    role: 'user',
    content: text,
    createdAt: new Date().toISOString()
  };

  const optimisticMessages = [...state.messages, userMessage];
  updateStateMessages(optimisticMessages);

  const pendingMessage = {
    role: 'assistant',
    content: '',
    thinking: thinkInput.checked ? 'Модель размышляет…' : '',
    pending: true,
    createdAt: new Date().toISOString()
  };

  state.messages = [...optimisticMessages, pendingMessage];
  renderChat();

  const payloadMessages = optimisticMessages.map(({ role, content, name, tool_call_id }) => ({
    role,
    content,
    name,
    tool_call_id
  }));

  const body = {
    messages: payloadMessages,
    model: modelInput.value.trim() || 'gpt-oss:20b',
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    system: systemInput.value.trim(),
    think: thinkInput.checked
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.details || data?.error || 'Неизвестная ошибка сервера');
    }

    const conversation = Array.isArray(data.conversation)
      ? data.conversation.filter((msg) => msg.role !== 'system')
      : [];

    updateStateMessages(conversation);
  } catch (error) {
    console.error(error);
    const fallbackMessages = optimisticMessages.concat({
      role: 'assistant',
      content: `Ошибка: ${error.message}`,
      createdAt: new Date().toISOString()
    });
    updateStateMessages(fallbackMessages);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.pending) {
    return;
  }
  const text = messageInput.value.trim();
  if (!text) {
    return;
  }
  persistSettings();
  messageInput.value = '';
  autoResizeTextarea();
  state.pending = true;
  sendMessage(text).finally(() => {
    state.pending = false;
  });
});

clearChatButton.addEventListener('click', () => {
  state.messages = [];
  renderChat();
});

if (toggleSettingsButton && sidebar) {
  toggleSettingsButton.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    toggleSettingsButton.setAttribute('aria-expanded', String(!collapsed));
    toggleSettingsButton.textContent = collapsed ? 'Развернуть панель' : 'Свернуть панель';
  });
}

if (settingsPanel) {
  settingsPanel.addEventListener('input', persistSettings);
}

thinkInput.addEventListener('change', persistSettings);
messageInput.addEventListener('input', autoResizeTextarea);

loadSettings();
autoResizeTextarea();
renderChat();
