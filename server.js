import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_GIRL_VOICE_ID = '';
const ELEVENLABS_BOY_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
const ROOT = new URL('.', import.meta.url).pathname;
const VOICES = {
  girl: ELEVENLABS_GIRL_VOICE_ID,
  boy: ELEVENLABS_BOY_VOICE_ID,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw new Error('La solicitud es demasiado grande.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handleTts(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Método no permitido.' });
    return;
  }
  if (!ELEVENLABS_API_KEY) {
    json(res, 503, { error: 'Falta configurar ELEVENLABS_API_KEY en el servidor.' });
    return;
  }

  try {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    const voiceKey = String(body.voiceId || '');
    const voiceId = VOICES[voiceKey];
    if (!text || text.length > 2_500) {
      json(res, 400, { error: 'El texto debe tener entre 1 y 2500 caracteres.' });
      return;
    }
    if (!Object.hasOwn(VOICES, voiceKey)) {
      json(res, 400, { error: 'Voz no permitida.' });
      return;
    }
    if (!voiceId) {
      json(res, 503, {
        error: `Falta configurar ELEVENLABS_${voiceKey.toUpperCase()}_VOICE_ID en el archivo .env.`,
      });
      return;
    }

    const outputFormat = body.outputFormat || 'mp3_44100_128';
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: body.modelId || 'eleven_multilingual_v2',
          voice_settings: body.voiceSettings,
        }),
      },
    );

    if (!elevenResponse.ok) {
      const detail = await elevenResponse.text();
      json(res, elevenResponse.status, { error: 'ElevenLabs rechazó la solicitud.', detail });
      return;
    }

    res.writeHead(200, {
      'Content-Type': elevenResponse.headers.get('content-type') || 'audio/mpeg',
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(Buffer.from(await elevenResponse.arrayBuffer()));
  } catch (error) {
    json(res, 400, { error: error.message || 'Solicitud inválida.' });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/tts') {
    await handleTts(req, res);
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'Método no permitido.' });
    return;
  }

  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const safePath = normalize(requested);
  if (safePath.startsWith('..')) {
    json(res, 403, { error: 'Ruta no permitida.' });
    return;
  }

  try {
    const file = await readFile(join(ROOT, safePath));
    res.writeHead(200, { 'Content-Type': MIME[extname(safePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    // La interfaz es una SPA: cualquier ruta GET vuelve al documento principal.
    try {
      const index = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(index);
    } catch {
      json(res, 404, { error: 'No se encontró index.html.' });
    }
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  createServer(handleRequest).listen(PORT, () => {
    console.log(`Immersia disponible en http://localhost:${PORT}`);
  });
}
