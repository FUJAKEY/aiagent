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

const STORAGE_KEY = 'ai-agent-playground-settings-v1';
const DEFAULT_ENDPOINT = 'https://impossible-georgeanna-yuhfjrifj-d252474c.koyeb.app/api/chat';

const state = {
  messages: [],
  pending: false
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      endpointInput.value = DEFAULT_ENDPOINT;
      modelInput.value = 'gpt-oss:20b';
      thinkInput.checked = true;
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
}

function persistSettings() {
  const payload = {
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    model: modelInput.value.trim() || 'gpt-oss:20b',
    system: systemInput.value,
    think: thinkInput.checked
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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

  avatar.dataset.role = message.role;
  avatar.textContent = message.role === 'user' ? 'U' : message.role === 'assistant' ? 'AI' : 'FX';
  roleLabel.textContent = formatRole(message.role);
  timestamp.textContent = new Date(message.createdAt || Date.now()).toLocaleTimeString();
  content.textContent = message.content || '';

  if (message.pending) {
    element.classList.add('pending');
    content.textContent = 'Модель размышляет...';
  }

  if (message.role === 'assistant' && !message.content && !message.pending) {
    content.textContent = 'Готово.';
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
      content: msg.content || '',
      name: msg.name,
      tool_call_id: msg.tool_call_id,
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

toggleSettingsButton.addEventListener('click', () => {
  const isHidden = settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', !isHidden);
  settingsPanel.classList.toggle('visible', isHidden);
  if (isHidden) {
    settingsPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

settingsPanel.addEventListener('input', persistSettings);
messageInput.addEventListener('input', autoResizeTextarea);

loadSettings();
autoResizeTextarea();
renderChat();
