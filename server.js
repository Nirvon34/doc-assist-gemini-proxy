import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('⚠ GEMINI_API_KEY не задан');
}

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Gemini proxy OK');
});

app.post('/analyze', async (req, res) => {
  try {
    const { text, extraNotes = '' } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }

    const maxLen = 15000;
    let trimmed = text.trim();
    if (trimmed.length > maxLen) {
      trimmed = trimmed.slice(0, maxLen) + '\n\n[Текст обрезан для анализа]';
    }

    const system = `
Ты помощник-аналитик тендерной документации в РФ.
Твоя задача — на основе текста извлечь ключевые условия закупки
и вернуть СТРОГО один JSON-объект без лишнего текста.
`.trim();

    const user = `Дополнительные пожелания заказчика: ${extraNotes}\n\nТЕКСТ:\n${trimmed}`;

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: system },
            { text: user }
          ]
        }
      ],
      generationConfig: {
        response_mime_type: 'application/json'
      }
    };

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      }
    );

    const json = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: json.error?.message });
    }

    const textResp = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    let result;

    try {
      const start = textResp.indexOf('{');
      const end = textResp.lastIndexOf('}');
      result = JSON.parse(textResp.slice(start, end + 1));
    } catch {
      return res.status(500).json({ ok: false, error: 'JSON parse error', raw: textResp });
    }

    res.json({ ok: true, data: result });

  } catch (e) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`Gemini proxy listening on ${PORT}`));
