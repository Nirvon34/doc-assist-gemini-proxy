import express from 'express';
import cors from 'cors';

console.log('[BOOT] doc-assist-gemini-proxy START');
console.log('[BOOT] NODE_ENV =', process.env.NODE_ENV);
console.log(
  '[BOOT] GEMINI_KEYS =',
  process.env.GEMINI_KEYS
    ? process.env.GEMINI_KEYS.split(',').filter(Boolean).length
    : 'NONE',
);
console.log(
  '[BOOT] GEMINI_API_KEY =',
  process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
);
console.log('[BOOT] TIME =', new Date().toISOString());

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ====== Настройки Gemini ======
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';
const GEMINI_API_VERSION = 'v1beta';

// Берём либо список ключей, либо один старый
const RAW_KEYS =
  process.env.GEMINI_KEYS ||
  process.env.GEMINI_API_KEYS ||
  process.env.GEMINI_API_KEY ||
  '';

const GEMINI_KEYS = RAW_KEYS.split(',').map((k) => k.trim()).filter(Boolean);

if (!GEMINI_KEYS.length) {
  console.error(
    '⚠ GEMINI_KEYS / GEMINI_API_KEYS / GEMINI_API_KEY не заданы — нет ни одного ключа',
  );
} else {
  console.log('✅ Загружено Gemini ключей:', GEMINI_KEYS.length);
}

/**
 * Вызов Gemini с ретраями по 503 и
 * переключением на следующий ключ при 429 (quota).
 */
async function callGeminiWithRetry(payload, maxRetriesPerKey = 2) {
  if (!GEMINI_KEYS.length) {
    return { ok: false, status: 0, body: 'No Gemini API keys configured' };
  }

  let lastError = null;

  for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
    const apiKey = GEMINI_KEYS[keyIndex];
    const url =
      `https://generativelanguage.googleapis.com/` +
      `${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent` +
      `?key=${apiKey}`;

    console.log(`▶ Используем ключ #${keyIndex + 1} из ${GEMINI_KEYS.length}`);

    let attempt = 0;
    let delayMs = 1500;

    while (true) {
      attempt += 1;

      let resp;
      let text;

      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        });
        text = await resp.text();
      } catch (e) {
        console.warn(`⚠ Сетевая ошибка на ключе #${keyIndex + 1}:`, e);
        lastError = { ok: false, status: 0, body: String(e) };
        break;
      }

      if (resp.ok) {
        console.log(
          `✅ Ответ от Gemini на ключе #${keyIndex + 1}, статус ${resp.status}`,
        );
        return { ok: true, status: resp.status, body: text };
      }

      if (resp.status === 503 && attempt <= maxRetriesPerKey + 1) {
        console.warn(
          `Gemini 503 (attempt ${attempt}) на ключе #${keyIndex + 1}, retry через ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
        continue;
      }

      if (resp.status === 429) {
        console.warn(
          `Gemini 429 (quota) на ключе #${keyIndex + 1}, переключаемся на следующий ключ`,
        );
        lastError = { ok: false, status: resp.status, body: text };
        break;
      }

      console.warn(
        `Gemini ошибка ${resp.status} на ключе #${keyIndex + 1}, не ретраим`,
      );
      return { ok: false, status: resp.status, body: text };
    }
  }

  return lastError || { ok: false, status: 0, body: 'All Gemini API keys failed' };
}

// ====== Проверочный маршрут ======
app.get('/', (req, res) => {
  res.send('Gemini proxy OK');
});

// ====== Основной маршрут ======
app.post('/chat', async (req, res) => {
  try {
    const { text, prompt, systemPrompt, userPrompt } = req.body || {};
    const userText = text || prompt || userPrompt || '';
    const systemText =
      systemPrompt ||
      'You are a helpful assistant for tender analysis. Answer in Russian.';

    if (!userText) {
      return res.status(400).json({ error: 'Empty prompt' });
    }

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemText}\n\n${userText}` }],
        },
      ],
    };

    const geminiResp = await callGeminiWithRetry(payload, 2);

    if (!geminiResp.ok) {
      return res.status(500).json({
        error: 'Gemini API error',
        status: geminiResp.status,
        body: geminiResp.body,
      });
    }

    let data;
    try {
      data = JSON.parse(geminiResp.body);
    } catch {
      return res.status(500).json({
        error: 'Bad JSON from Gemini',
        status: geminiResp.status,
        body: geminiResp.body,
      });
    }

    let reply = '';
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      reply = parts
        .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
        .join('\n')
        .trim();
    }

    return res.json({ reply, raw: data });
  } catch (e) {
    console.error('Proxy error', e);
    return res.status(500).json({ error: 'Proxy error', details: String(e) });
  }
});

// ====== Запуск сервера ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Gemini proxy listening on', PORT);
});
