const express = require('express');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const fetchFn = (...args) => {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(...args);
  }
  if (!fetchFn._fetchPromise) {
    fetchFn._fetchPromise = import('node-fetch').then(({ default: fetch }) => fetch);
  }
  return fetchFn._fetchPromise.then((fetch) => fetch(...args));
};

const app = express();
const PORT = process.env.PORT || 8000;
const DEFAULT_ENDPOINT = process.env.DEFAULT_MODEL_ENDPOINT || 'https://impossible-georgeanna-yuhfjrifj-d252474c.koyeb.app/api/chat';
const SANDBOX_DIR = path.join(process.cwd(), 'sandbox');
const TERMINAL_TIMEOUT_MS = Number(process.env.TERMINAL_TIMEOUT_MS || 15000);
const TERMINAL_MAX_BUFFER = Number(process.env.TERMINAL_MAX_BUFFER || 1024 * 1024);

const BUILTIN_SYSTEM_PROMPT = [
  'Ты — ИИ агент-разработчик senior-уровня. Выполняй любые задачи пользователя уверенно и проактивно.',
  'Всегда анализируй запрос и, если требуется создать, изменить или запустить код/проект, используй инструмент terminal для выполнения команд внутри каталога sandbox.',
  'При создании сайтов, приложений, скриптов или других артефактов обязательно разворачивай их локально в sandbox с помощью terminal, прежде чем давать итоговый ответ.',
  'Не покидай каталог sandbox и не выполняй команды вне его пределов.',
  'Фиксируй в ответе ключевые действия и результаты работы, чтобы пользователь видел ход разработки.'
].join('\n');

const TERMINAL_TOOL = {
  type: 'function',
  function: {
    name: 'terminal',
    description: 'Выполнение shell-команд строго внутри директории sandbox. Инструмент не позволяет выходить за её пределы.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell-команда, которую необходимо выполнить внутри директории sandbox без перехода за её пределы.'
        }
      },
      required: ['command']
    }
  }
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

function validateCommand(command) {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Команда не может быть пустой.' };
  }

  const forbiddenPatterns = [
    /\.\./,
    /(^|[;&|])\s*cd\s+/i,
    /(^|[;&|])\s*source\b/i,
    /(^|[;&|])\s*\.\s+/,
    /(^|[;&|])\s*export\b/i,
    /(^|[;&|])\s*set\b/i
  ];

  if (trimmed.startsWith('/') || /\s\//.test(trimmed)) {
    return { ok: false, error: 'Разрешены только относительные пути внутри sandbox.' };
  }

  if (/~/.test(trimmed)) {
    return { ok: false, error: 'Использование домашнего каталога запрещено в песочнице.' };
  }

  if (/\\/.test(trimmed)) {
    return { ok: false, error: 'Обратные слеши запрещены в командах песочницы.' };
  }

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: 'Команда нарушает правила песочницы.' };
    }
  }

  return { ok: true };
}

async function runTerminal(command) {
  const validation = validateCommand(command);
  if (!validation.ok) {
    return {
      success: false,
      output: '',
      error: validation.error
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: SANDBOX_DIR,
      timeout: TERMINAL_TIMEOUT_MS,
      maxBuffer: TERMINAL_MAX_BUFFER,
      shell: '/bin/bash'
    });

    return {
      success: true,
      output: stdout.trim(),
      error: stderr.trim()
    };
  } catch (error) {
    const stdout = (error.stdout || '').toString().trim();
    const stderr = (error.stderr || '').toString().trim();

    return {
      success: false,
      output: stdout,
      error: [stderr, error.killed ? 'Команда завершена по таймауту.' : error.message].filter(Boolean).join('\n')
    };
  }
}

function normaliseMessages(rawMessages = []) {
  return rawMessages
    .filter(Boolean)
    .map((msg) => ({
      role: msg.role,
      content: msg.content,
      name: msg.name,
      tool_call_id: msg.tool_call_id
    }))
    .filter((msg) => typeof msg.role === 'string' && typeof msg.content === 'string');
}

async function callModel({ endpoint, model, conversation, think, toolResults = [] }) {
  const payload = {
    model,
    messages: conversation,
    tools: [TERMINAL_TOOL],
    stream: false,
    think: Boolean(think)
  };

  if (Array.isArray(toolResults) && toolResults.length) {
    const preparedResults = toolResults
      .filter((entry) => entry && typeof entry.tool_call_id === 'string')
      .map((entry) => {
        const textPayload = entry.output ?? entry.content ?? '';
        return {
          tool_call_id: entry.tool_call_id,
          content: textPayload,
          output: textPayload
        };
      });

    if (preparedResults.length) {
      payload.tool_results = preparedResults;
    }
  }

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let parsedDetails;
    try {
      parsedDetails = JSON.parse(errorText);
    } catch (_jsonError) {
      parsedDetails = null;
    }

    const err = new Error(`Ошибка запроса к модели: ${response.status} ${response.statusText}`);
    err.status = response.status;
    err.statusText = response.statusText;
    err.details = parsedDetails ?? errorText;
    if (parsedDetails && typeof parsedDetails.error === 'string') {
      err.message = parsedDetails.error;
    }

    const mismatchMessage = 'mismatch between tool calls and tool results';
    if (typeof errorText === 'string' && errorText.toLowerCase().includes(mismatchMessage)) {
      err.hint = 'Убедитесь, что для каждого вызова инструмента, запрошенного моделью, возвращается ответ с тем же tool_call_id.';
    }

    throw err;
  }

  const data = await response.json();
  return data;
}

function extractAssistantMessage(data) {
  if (!data) return null;
  if (data.message) return data.message;
  if (Array.isArray(data.messages) && data.messages.length) {
    return data.messages[data.messages.length - 1];
  }
  if (data.choices && Array.isArray(data.choices) && data.choices[0]?.message) {
    return data.choices[0].message;
  }
  return null;
}

function formatToolResult({ command, result }) {
  const blocks = [];
  const displayCommand = command && command.trim() ? command.trim() : '(пустая команда)';
  blocks.push(`$ ${displayCommand}`);
  if (result.output) {
    blocks.push(result.output);
  }
  if (result.error) {
    blocks.push(result.error);
  }
  return blocks.join('\n');
}

function normaliseHistoryForModel(messages) {
  return messages
    .map((msg) => {
      if (!msg || typeof msg.role !== 'string') {
        return null;
      }

      if (msg.role === 'tool') {
        const label = msg.name ? `[tool:${msg.name}]` : '[tool]';
        const body = typeof msg.content === 'string' ? msg.content.trim() : '';
        const content = body ? `${label}\n${body}` : label;
        return {
          role: 'assistant',
          content,
          name: msg.name ? `tool:${msg.name}` : undefined
        };
      }

      return {
        role: msg.role,
        content: msg.content,
        name: msg.name
      };
    })
    .filter((msg) => msg && typeof msg.content === 'string');
}

function parseErrorDetails(details) {
  if (!details) {
    return null;
  }

  if (typeof details === 'object') {
    return details;
  }

  if (typeof details === 'string') {
    const trimmed = details.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch (_jsonError) {
      return trimmed;
    }
  }

  return null;
}

app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages = [],
      model,
      endpoint,
      system = '',
      think = true
    } = req.body || {};

    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'Необходимо указать модель.' });
    }

    const targetEndpoint = typeof endpoint === 'string' && endpoint.trim()
      ? endpoint.trim()
      : DEFAULT_ENDPOINT;

    const systemPrompt = [BUILTIN_SYSTEM_PROMPT.trim(), system.trim()].filter(Boolean).join('\n\n');

    const initialMessages = normaliseMessages(messages).filter((msg) => msg.role !== 'system');
    const conversationForClient = [{ role: 'system', content: systemPrompt }, ...initialMessages];
    const conversationForModel = [{ role: 'system', content: systemPrompt }, ...normaliseHistoryForModel(initialMessages)];

    const toolExecutions = [];
    let pendingToolResults = [];
    const safetyLimit = 6;
    let iterations = 0;
    let lastModelResponse = null;

    while (iterations < safetyLimit) {
      iterations += 1;
      const data = await callModel({
        endpoint: targetEndpoint,
        model,
        conversation: conversationForModel,
        think,
        toolResults: pendingToolResults
      });

      pendingToolResults = [];

      const assistantMessage = extractAssistantMessage(data);
      if (!assistantMessage) {
        throw new Error('Модель не вернула сообщение.');
      }

      conversationForModel.push(assistantMessage);
      conversationForClient.push(assistantMessage);
      lastModelResponse = assistantMessage;

      const toolCalls = Array.isArray(assistantMessage.tool_calls)
        ? assistantMessage.tool_calls
        : [];

      if (!toolCalls.length) {
        break;
      }

      for (const call of toolCalls) {
        if (!call?.function?.name) {
          continue;
        }

        const toolCallId = call.id || call.tool_call_id;
        if (!toolCallId) {
          throw new Error('Модель вернула вызов инструмента без идентификатора tool_call_id.');
        }

        if (call.function.name !== 'terminal') {
          const toolMessage = {
            role: 'tool',
            name: call.function.name,
            content: 'Инструмент не поддерживается сервером.',
            tool_call_id: toolCallId
          };
          conversationForClient.push(toolMessage);
          toolExecutions.push({
            tool: call.function.name,
            command: null,
            result: 'Инструмент не поддерживается сервером.'
          });
          pendingToolResults.push({
            tool_call_id: toolCallId,
            content: 'Инструмент не поддерживается сервером.',
            output: 'Инструмент не поддерживается сервером.'
          });
          continue;
        }

        let command = '';
        try {
          if (typeof call.function.arguments === 'string') {
            command = JSON.parse(call.function.arguments).command || '';
          } else if (call.function.arguments && typeof call.function.arguments === 'object') {
            command = call.function.arguments.command || '';
          }
        } catch (parseError) {
          command = '';
        }

        const result = await runTerminal(command);
        const formattedResult = formatToolResult({ command, result });
        const toolMessage = {
          role: 'tool',
          name: call.function.name,
          content: formattedResult,
          tool_call_id: toolCallId
        };
        conversationForClient.push(toolMessage);
        toolExecutions.push({
          tool: call.function.name,
          command,
          result: formattedResult,
          success: result.success
        });

        pendingToolResults.push({
          tool_call_id: toolCallId,
          content: formattedResult,
          output: formattedResult
        });
      }
    }

    if (iterations >= safetyLimit) {
      return res.status(500).json({ error: 'Превышен лимит итераций при взаимодействии с моделью.' });
    }

    res.json({
      message: lastModelResponse,
      conversation: conversationForClient,
      toolExecutions
    });
  } catch (error) {
    console.error('Ошибка /api/chat:', error);
    const statusCode = typeof error.status === 'number' && error.status >= 400 ? error.status : 500;
    const details = parseErrorDetails(error.details || error.message);
    const responsePayload = {
      error: statusCode === 400 ? 'Некорректный запрос к модели.' : 'Не удалось обработать запрос к модели.',
      message: error.message,
      details
    };

    if (typeof error.status === 'number') {
      responsePayload.upstreamStatus = error.status;
    }

    if (typeof error.statusText === 'string') {
      responsePayload.upstreamStatusText = error.statusText;
    }

    if (error.hint) {
      responsePayload.hint = error.hint;
    }

    res.status(statusCode).json(responsePayload);
  }
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
