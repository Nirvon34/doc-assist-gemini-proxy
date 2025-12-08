import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ====== Настройки Gemini ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('⚠ GEMINI_API_KEY не задан');
}

// актуальная модель
const GEMINI_MODEL = 'gemini-1.5-flash-latest';
// используем стабильную версию API v1
const GEMINI_API_VERSION = 'v1';

const PORT = process.env.PORT || 3000;

// Проверка, что прокси живой
app.get('/', (req, res) => {
  res.send('Gemini proxy OK');
});

// ====== Основной маршрут для PHP: POST /chat ======
app.post('/chat', async (req, res) => {
  try {
    const { prompt, systemPrompt, userPrompt } = req.body || {};

    const userText = userPrompt || prompt;
    const systemText =
      systemPrompt ||
      'You are an assistant that analyzes tender documents and answers in Russian.';

    if (!userText) {
      return res.status(400).json({ error: 'No prompt provided' });
    }

    // ВАЖНО: v1, а не v1beta
    const geminiUrl =
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent` +
      `?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                systemText +
                '\n\nПользовательский запрос:\n' +
                userText,
            },
          ],
        },
      ],
    };

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Gemini error:', response.status, text);
      return res.status(500).json({
        error: 'Gemini API error',
        status: response.status,
        body: text,
      });
    }

    const data = await response.json();

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join(' ')
        .trim() || '';

    return res.json({
      reply,
      raw: data,
    });
  } catch (err) {
    console.error('Proxy /chat error:', err);
    return res.status(500).json({ error: 'Internal proxy error' });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Gemini proxy listening on port ${PORT}`);
});
