import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';

const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Helper for model fallback when primary models experience temporary demand spikes
async function callWithModelFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  // gemini-3.1-flash-lite has best availability, followed by gemini-3.8-flash and gemini-flash-latest
  const models = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
  let lastError: any = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fn(model);
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);
        const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');
        if (isTransient && attempt === 0) {
          console.warn(`Model ${model} experiencing temporary demand spike, retrying in 750ms...`);
          await new Promise((r) => setTimeout(r, 750));
          continue;
        }
        console.warn(`Model ${model} attempt failed:`, msg.slice(0, 100));
        break;
      }
    }
  }

  throw lastError;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Increase payload limit for high-res camera image uploads
  app.use(express.json({ limit: '35mb' }));

  // API endpoint for analyzing medicine image
  app.post('/api/analyze-medicine', async (req, res) => {
    try {
      const { base64Image, currentMedicines = [] } = req.body;
      if (!base64Image) {
        return res.status(400).json({ error: 'Image data is required' });
      }

      // Clean base64 input and detect MIME type
      let cleanBase64 = base64Image;
      let detectedMime = 'image/jpeg';

      if (typeof base64Image === 'string' && base64Image.includes(',')) {
        const parts = base64Image.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        if (mimeMatch) {
          detectedMime = mimeMatch[1];
        }
        cleanBase64 = parts[1];
      }
      cleanBase64 = cleanBase64.replace(/\s+/g, '');

      const medicineListContext = currentMedicines
        .map((m: any) => `${m.name} (${m.dosage || ''})`)
        .join(', ');

      const prompt = `
        أنت المساعد الطبي والصيدلي الذكي "بصير" المخصص لمساعدة المكفوفين وضعاف البصر.
        افحص صورة علبة الدواء أو شريط الحبوب أو الوصفة الطبية بعناية:
        1. استخرج اسم الدواء التجاري والعلمي بوضوح.
        2. استخرج المواد الفعالة والتركيز إن وُجدت.
        3. وضح دواعي وطريقة الاستخدام والجرعة النموذجية.
        4. اذكر أهم التحذيرات والآثار الجانبية وموانع الاستعمال.
        5. قارن هذا الدواء مع أدوية المريض الحالية: [${medicineListContext || 'لا توجد أدوية مسجلة حالياً'}].
        6. هل هناك تعارض دوائي؟
        7. حدد هل الدواء متوافق وآمن (isCompatible: true إذا لم يوجد تعارض خطير، أو false إذا كان هناك خطر).

        ملاحظات هامة جداً:
        - إذا لم تستطع قراءة اسم الدواء بسبب ضبابية الصورة أو الإضاءة، ضع name: "دواء غير واضح"، واذكر في warnings نصيحة لطيفة واضحة باللهجة البيضاء لتوجيه الكاميرا بإضاءة كافية على اسم العلبة.
        - تأكد من أن الرد JSON صالح ومكتمل بالعربية دائماً.
      `;

      const result = await callWithModelFallback(async (model) => {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { data: cleanBase64, mimeType: detectedMime } },
              { text: prompt },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                activeIngredients: { type: Type.ARRAY, items: { type: Type.STRING } },
                usage: { type: Type.STRING },
                warnings: { type: Type.STRING },
                interactions: { type: Type.STRING },
                isCompatible: { type: Type.BOOLEAN },
              },
              required: ['name', 'activeIngredients', 'usage', 'warnings', 'interactions', 'isCompatible'],
            },
          },
        });

        let responseText = response.text || '{}';
        // Strip any markdown code fences if present
        responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
      });

      return res.json(result);
    } catch (error: any) {
      console.error('Error analyzing medicine:', error);
      const statusCode = error?.status && typeof error.status === 'number' ? error.status : 500;
      return res.status(statusCode).json({
        error: error?.message || 'Failed to analyze medicine image',
        status: error?.status,
      });
    }
  });

  // API endpoint for AI assistant chat
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, currentMedicines = [] } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const medicineListContext = currentMedicines
        .map((m: any) => `${m.name} (${m.dosage || ''})`)
        .join(', ');

      const systemInstruction = `أنت "بصير"، رفيق طبي وصيدلي ذكي متخصص بمساعدة المكفوفين وضعاف البصر بأسلوب إنساني دافئ وبلهجة سعودية بيضاء محترمة ومطمئنة. قائمة أدوية المريض الحالية هي: [${medicineListContext || 'لا توجد أدوية مسجلة'}]. أجب دائماً بالعربية وبإيجاز دقيق ومريح ومناسب للقراءة الصوتية، مع التركيز على السلامة ومواعيد الدواء وتحذيرات التعارض.`;

      const reply = await callWithModelFallback(async (model) => {
        const response = await ai.models.generateContent({
          model,
          contents: message,
          config: {
            systemInstruction,
          },
        });
        return response.text || '';
      });

      return res.json({ reply });
    } catch (error: any) {
      console.error('Error in chat:', error);
      const statusCode = error?.status && typeof error.status === 'number' ? error.status : 500;
      return res.status(statusCode).json({
        error: error?.message || 'Failed to get AI response',
        status: error?.status,
      });
    }
  });

  // In-memory audio cache for instant playback, eliminating quota drain and latency
  const ttsAudioCache = new Map<string, { audio: string; mimeType: string; sampleRate: number }>();

  const introTextStandard = `يا هلا فيك في تطبيق بصير، رفيقك الصيدلي الذكي.
تطبيق بصير يقدم لك ثلاث خدمات رئيسية:
أولاً، فحص وقراءة الدواء بالكاميرا لمعرفة الاسم والجرعة ودواعي الاستخدام والتحقق من عدم وجود تعارض دوائي.
ثانياً، سجل الأدوية والتذكير اليومي بمواعيد جرعاتك لتناول دوائك بأمان وفي وقته.
ثالثاً، الاستشارة الصيدلية للإجابة عن استفساراتك الطبية فورياً.
للبدء، وجّه الكاميرا نحو علبة الدواء أو اختر صورة من جهازك.`;

  // Pre-load static intro audio if present
  try {
    const introWavPath = path.resolve(__dirname, 'public/audio/intro.wav');
    if (fs.existsSync(introWavPath)) {
      const buf = fs.readFileSync(introWavPath);
      ttsAudioCache.set(introTextStandard.trim(), {
        audio: buf.toString('base64'),
        mimeType: 'audio/wav',
        sampleRate: 24000,
      });
      console.log('Intro WAV loaded into cache successfully.');
    }
  } catch (err) {
    console.warn('Could not load static intro WAV:', err);
  }

  // Helper function to encapsulate raw PCM audio (L16) into standard 24kHz WAV container
  function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1): Buffer {
    if (pcmBuffer.length > 12 && pcmBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
      return pcmBuffer;
    }
    const header = Buffer.alloc(44);
    const dataLength = pcmBuffer.length;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
    header.writeUInt16LE(numChannels, 22); // NumChannels
    header.writeUInt32LE(sampleRate, 24); // SampleRate
    header.writeUInt32LE(sampleRate * numChannels * 2, 28); // ByteRate
    header.writeUInt16LE(numChannels * 2, 32); // BlockAlign
    header.writeUInt16LE(16, 34); // BitsPerSample
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return Buffer.concat([header, pcmBuffer]);
  }

  // Helper for Google Arabic TTS segment download
  function fetchGoogleTtsChunk(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url =
        'https://translate.google.com/translate_tts?ie=UTF-8&q=' +
        encodeURIComponent(text) +
        '&tl=ar&client=tw-ob';
      https
        .get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Google TTS status ${res.statusCode}`));
          }
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        })
        .on('error', reject);
    });
  }

  // Break text into punctuation-aware chunks for fluent synthesis
  function splitTextIntoSentences(text: string, maxLen = 130): string[] {
    const parts: string[] = [];
    const rawParts = text.split(/([.،!؟\n]+)/);
    let current = '';

    for (let i = 0; i < rawParts.length; i++) {
      const chunk = rawParts[i];
      if (!chunk) continue;
      if ((current + chunk).length <= maxLen) {
        current += chunk;
      } else {
        if (current.trim()) parts.push(current.trim());
        if (chunk.length > maxLen) {
          const words = chunk.split(' ');
          let sub = '';
          for (const w of words) {
            if ((sub + ' ' + w).length <= maxLen) {
              sub = sub ? sub + ' ' + w : w;
            } else {
              if (sub) parts.push(sub);
              sub = w;
            }
          }
          current = sub;
        } else {
          current = chunk;
        }
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  // Synthesizes text with unified, natural Arabic neural voice (unlimited quota, studio clarity)
  async function synthesizeWithGoogleArabicTts(text: string): Promise<Buffer> {
    const chunks = splitTextIntoSentences(text);
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      if (chunk.trim()) {
        const buf = await fetchGoogleTtsChunk(chunk.trim());
        buffers.push(buf);
      }
    }
    return Buffer.concat(buffers);
  }

  // Synthesize text with unified realistic Arabic voice
  async function synthesizeSpeech(text: string): Promise<{ audio: string; mimeType: string; sampleRate: number }> {
    const cleanText = text.trim().slice(0, 800);
    const cacheKey = cleanText;

    if (ttsAudioCache.has(cacheKey)) {
      return ttsAudioCache.get(cacheKey)!;
    }

    let base64Audio = '';
    let detectedRate = 24000;
    let mimeType = 'audio/wav';

    // 1. Try Gemini TTS models if quota is available
    const ttsModels = [
      { model: 'gemini-2.5-flash-preview-tts', voice: 'Aoede' },
      { model: 'gemini-3.1-flash-tts-preview', voice: 'Aoede' },
      { model: 'gemini-3.8-flash-tts', voice: 'Aoede' },
      { model: 'gemini-2.5-pro-preview-tts', voice: 'Aoede' },
    ];

    for (const config of ttsModels) {
      try {
        const response = await ai.models.generateContent({
          model: config.model,
          contents: [
            {
              role: 'user',
              parts: [{ text: cleanText }],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: config.voice },
              },
            },
          },
        });

        const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (inline?.data) {
          const rawMime = inline.mimeType || '';
          const rateMatch = rawMime.match(/rate=(\d+)/);
          if (rateMatch && rateMatch[1]) {
            detectedRate = parseInt(rateMatch[1], 10);
          }

          const rawBuffer = Buffer.from(inline.data, 'base64');
          const wavBuffer = pcmToWav(rawBuffer, detectedRate, 1);
          base64Audio = wavBuffer.toString('base64');
          mimeType = 'audio/wav';
          break;
        }
      } catch (err: any) {
        // Continue to fallback
      }
    }

    // 2. High-fidelity natural Arabic Neural TTS (unlimited, unified voice matching app intro)
    if (!base64Audio) {
      try {
        const mp3Buffer = await synthesizeWithGoogleArabicTts(cleanText);
        if (mp3Buffer && mp3Buffer.length > 0) {
          base64Audio = mp3Buffer.toString('base64');
          mimeType = 'audio/mpeg';
          detectedRate = 24000;
        }
      } catch (backupErr) {
        console.warn('Google Arabic TTS synthesis error:', backupErr);
      }
    }

    if (!base64Audio) {
      throw new Error('TTS synthesis failed');
    }

    const result = { audio: base64Audio, mimeType, sampleRate: detectedRate };
    ttsAudioCache.set(cacheKey, result);
    return result;
  }

  // API endpoint for Text-to-Speech (high-fidelity realistic Saudi voice)
  app.post('/api/tts', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await synthesizeSpeech(text);
      return res.json(result);
    } catch (error: any) {
      const msg = String(error?.message || error);
      const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
      return res.status(isQuota ? 429 : 503).json({
        error: isQuota ? 'TTS quota exceeded' : 'TTS service unavailable',
        fallback: true,
      });
    }
  });

  // Serve static assets from public folder directly (including /audio/*.wav)
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use('/audio', express.static(path.resolve(__dirname, 'public/audio')));

  // Ensure unmatched /api routes never serve HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  // Global JSON error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.warn('Express error:', err?.message || err);
    res.status(err?.status || 500).json({
      error: err?.message || 'Internal server error',
    });
  });

  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.use((_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
