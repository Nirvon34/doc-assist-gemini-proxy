import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GEMINI_MODEL       = 'gemini-2.5-flash-preview-09-2025'; // или твоя модель
const GEMINI_API_VERSION = 'v1beta';

if (!GEMINI_API_KEY) {
  console.error('⚠ GEMINI_API_KEY не задан');
}

/**
 * Вспомогательная функция: вызов Gemini с 2 ретраями при 503.
 */
async function callGeminiWithRetry(payload, maxRetries = 2) {
  const url =
    `https://generativelanguage.googleapis.com/` +
    `${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent` +
    `?key=${GEMINI_API_KEY}`;

  let attempt = 0;
  let delayMs = 1500;

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
      // сетевые ошибки — сразу выходим
      return {
        ok: false,
        status: 0,
        body: String(e),
      };
    }

    // если всё ок — возвращаем ответ
    if (resp.ok) {
      return {
        ok: true,
        status: resp.status,
        body: text,
      };
    }

    // если 503 — пробуем ещё раз с backoff
    if (resp.status === 503 && attempt <= maxRetries + 1) {
      console.warn(
        `Gemini 503 (attempt ${attempt}), retry после ${delayMs}ms`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
      continue;
    }

    // для всех остальных случаев (и если ретраи закончились) — ошибка
    return {
      ok: false,
      status: resp.status,
      body: text,
    };
  }
}

// ====== Основной маршрут: POST /chat ======
app.post('/chat', async (req, res) => {
  try {
    const { text, prompt, systemPrompt, userPrompt } = req.body || {};

    const userText =
      text || prompt || userPrompt || '';

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
      // отдаем так, как ты сейчас логируешь
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
