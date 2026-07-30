import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 20_000;
const MAX_TEXT_LENGTH = 2_500;
const ELEVENLABS_TIMEOUT_MS = 15_000;

const VOICES = Object.freeze({
  girl: 'EXAVITQu4vr4xnSDxMaL', // Sarah
  boy: 'pNInz6obpgDQGcFmaJgB', // Adam
});

const OUTPUT_FORMATS = new Set([
  'mp3_22050_32',
  'mp3_44100_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'mp3_44100_128',
  'mp3_44100_192',
]);

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// La lectura estática permite que Vercel incluya el frontend en el bundle del servidor.
const indexFile = readFileSync(new URL('./index.html', import.meta.url));
const frontendFiles = new Map([
  ['/', { body: indexFile, contentType: MIME['.html'] }],
  ['/index.html', { body: indexFile, contentType: MIME['.html'] }],
]);

function securityHeaders() {
  return {
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, JSON.stringify(body), {
    'Cache-Control': 'no-store',
    'Content-Type': MIME['.json'],
  });
}

async function readJson(request) {
  if (request.body && typeof request.body === 'object') {
    return request.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('La solicitud es demasiado grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : {};
}

async function handleTts(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Método no permitido.' });
    return;
  }

  const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!apiKey) {
    sendJson(response, 503, {
      error: 'Falta configurar ELEVENLABS_API_KEY en el servidor.',
    });
    return;
  }

  const body = await readJson(request);
  const text = String(body.text || '').trim();
  const voiceId = VOICES[String(body.voiceId || '')];

  if (!text || text.length > MAX_TEXT_LENGTH) {
    sendJson(response, 400, {
      error: `El texto debe tener entre 1 y ${MAX_TEXT_LENGTH} caracteres.`,
    });
    return;
  }
  if (!voiceId) {
    sendJson(response, 400, { error: 'Voz no permitida.' });
    return;
  }

  const requestedFormat = String(body.outputFormat || 'mp3_44100_128');
  const outputFormat = OUTPUT_FORMATS.has(requestedFormat)
    ? requestedFormat
    : 'mp3_44100_128';

  let elevenResponse;
  try {
    elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: body.modelId || 'eleven_multilingual_v2',
          voice_settings: body.voiceSettings,
        }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      },
    );
  } catch (error) {
    console.error('No se pudo contactar con ElevenLabs:', error);
    sendJson(response, 502, {
      error: 'El servicio de voz no está disponible temporalmente.',
    });
    return;
  }

  if (!elevenResponse.ok) {
    const detail = await elevenResponse.text();
    console.error(`ElevenLabs respondió ${elevenResponse.status}:`, detail);
    sendJson(response, elevenResponse.status, {
      error: 'ElevenLabs rechazó la solicitud.',
    });
    return;
  }

  send(response, 200, Buffer.from(await elevenResponse.arrayBuffer()), {
    'Cache-Control': 'private, max-age=86400',
    'Content-Type': elevenResponse.headers.get('content-type') || 'audio/mpeg',
  });
}

function serveFrontend(request, response, pathname) {
  const exactFile = frontendFiles.get(pathname);
  if (exactFile) {
    send(response, 200, request.method === 'HEAD' ? undefined : exactFile.body, {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Type': exactFile.contentType,
    });
    return;
  }

  // Las rutas sin extensión pertenecen a la SPA.
  if (!extname(pathname)) {
    send(response, 200, request.method === 'HEAD' ? undefined : indexFile, {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Type': MIME['.html'],
    });
    return;
  }

  send(response, 404, 'Archivo no encontrado.', {
    'Cache-Control': 'public, max-age=60',
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

async function handler(request, response) {
  try {
    if (!request.url) {
      sendJson(response, 400, { error: 'Solicitud inválida.' });
      return;
    }

    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (pathname === '/api/tts') {
      await handleTts(request, response);
      return;
    }

    if (!['GET', 'HEAD'].includes(request.method || '')) {
      send(response, 405, 'Método no permitido.', {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return;
    }

    serveFrontend(request, response, pathname);
  } catch (error) {
    console.error('Error no controlado durante la solicitud:', error);
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    sendJson(response, status, {
      error: status < 500 ? error.message : 'Error interno del servidor.',
    });
  }
}

export default handler;

// Vercel importa el handler; en desarrollo se inicia un servidor HTTP normal.
if (!process.env.VERCEL && process.argv[1] === modulePath) {
  createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`Immersia disponible en http://127.0.0.1:${PORT}`);
  });
}
