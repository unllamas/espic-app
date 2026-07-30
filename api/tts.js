const VOICES = Object.freeze({
  girl: 'EXAVITQu4vr4xnSDxMaL', // Sarah
  boy: 'pNInz6obpgDQGcFmaJgB', // Adam
});

const MAX_TEXT_LENGTH = 2_500;

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (request.body && typeof request.body === 'object') {
    return request.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) throw new Error('La solicitud es demasiado grande.');
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : {};
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Método no permitido.' });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, {
      error: 'Falta configurar ELEVENLABS_API_KEY en Vercel.',
    });
    return;
  }

  try {
    const body = await readBody(request);
    const text = String(body.text || '').trim();
    const voiceKey = String(body.voiceId || '');
    const voiceId = VOICES[voiceKey];

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

    const outputFormat = body.outputFormat || 'mp3_44100_128';
    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
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
      sendJson(response, elevenResponse.status, {
        error: 'ElevenLabs rechazó la solicitud.',
        detail,
      });
      return;
    }

    response.statusCode = 200;
    response.setHeader(
      'Content-Type',
      elevenResponse.headers.get('content-type') || 'audio/mpeg',
    );
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.end(Buffer.from(await elevenResponse.arrayBuffer()));
  } catch (error) {
    console.error('Error en /api/tts:', error);
    sendJson(response, 500, {
      error: 'No se pudo generar el audio.',
    });
  }
}
