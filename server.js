import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ====== Настройки Gemini ======
const GEMINI_MODEL       = 'gemini-2.5-flash-preview-09-2025'; // или твоя модель
const GEMINI_API_VERSION = 'v1beta';

// Можно передать либо GEMINI_API_KEYS (через запятую), либо старый GEMINI_API_KEY
const RAW_KEYS =
  process.env.GEMINI_API_KEYS ||
  process.env.GEMINI_API_KEY   || '';

const GEMINI_KEYS = RAW_KEYS
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

if (!GEMINI_KEYS.length) {
  console.error('⚠ GEMINI_API_KEYS / GEMINI_API_KEY не заданы — нет ни одного ключа');
}

/**
 * Вспомогательная функция: вызов Gemini с ретраями по 503
 * и переключением ключей при 429 (quota).
 *
 * maxRetriesPerKey — сколько раз пробуем ОДИН ключ при 503.
 */
async function callGeminiWithRetry(payload, maxRetriesPerKey = 2) {
  if (!GEMINI_KEYS.length) {
    return {
      ok: false,
      status: 0,
      body: 'No Gemini API keys configured',
    };
  }

  let lastError = null;

  // Идём по ключам по очереди
  for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
    const apiKey = GEMINI_KEYS[keyIndex];
    const url =
      `https://generativelanguage.googleapis.com/` +
      `${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent` +
      `?key=${apiKey}`;

    console.log(`▶ Используем ключ #${keyIndex + 1} из ${GEMINI_KEYS.length}`);

    let attempt = 0;
    let delayMs = 1500;

    // Ретраи по 503 для ТЕКУЩЕГО ключа
    while (true) {
      attempt += 1;

      let resp;
      let text;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(payload),
        });
        text = await resp.text();
      } catch (e) {
        // сетевые ошибки — просто сохраняем и пробуем следующий ключ
        console.warn(`Сетевая ошибка на ключе #${keyIndex + 1}:`, e);
        lastError = {
          ok: false,
          status: 0,
          body: String(e),
        };
        break; // выходим из цикла ретраев, переходим к следующему ключу
      }

      // если всё ок — возвращаем ответ
      if (resp.ok) {
        return {
          ok: true,
          status: resp.status,
          body: text,
        };
      }

      // ==== ОБРАБОТКА 503: ретраим этот же ключ с backoff ====
      if (resp.status === 503 && attempt <= maxRetriesPerKey + 1) {
        console.warn(
          `Gemini 503 (attempt ${attempt}) на ключе #${keyIndex + 1}, retry через ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
        continue;
      }

      // ==== ОБРАБОТКА 429: исчерпан лимит этого ключа — переключаемся на следующий ====
      if (resp.status === 429) {
        console.warn(
          `Gemini 429 (quota) на ключе #${keyIndex + 1}, пробуем следующий ключ`,
        );
        lastError = {
          ok: false,
          status: resp.status,
          body: text,
        };
        // выходим из цикла ретраев по этому ключу => перейдём к следующему ключу
        break;
      }

      // ==== Любая другая ошибка: дальше крутить смысла нет, возвращаем ====
      console.warn(
        `Gemini ошибка ${resp.status} на ключе #${keyIndex + 1}, не ретраим`,
      );
      return {
        ok: false,
        status: resp.status,
        body: text,
      };
    }

    // Переходим к следующему ключу (если был 429 / сеть / 503 без успеха)
  }

  // Если дошли сюда, значит все ключи отстрелялись с ошибкой
  return (
    lastError || {
      ok: false,
      status: 0,
      body: 'All Gemini API keys failed',
    }
  );
}

// ====== Основной маршрут: POST /chat ======
app.post('/chat', async (req, res) => {
  try {
    const { text, prompt, systemPrompt, userPrompt } = req.body || {};

    const userText = text || prompt || userPrompt || '';

    const systemText =
      systemPrompt ||
      'You are a helpful assistant for tender analysis. Answer in Russian.';

    if (!userText) {
      return res.status(400).json({
        error: 'Empty prompt',
      });
    }

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${systemText}\n\n${userText}`,
            },
          ],
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

    return res.json({
      reply,
      raw: data,
    });
  } catch (e) {
    console.error('Proxy error', e);
    return res.status(500).json({
      error: 'Proxy error',
      details: String(e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Gemini proxy listening on', PORT);
});
