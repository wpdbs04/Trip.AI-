/**
 * AI Travel Planner - LLM 백엔드 프록시 (의존성 없음, Node.js 18+)
 *
 * 목적: 브라우저에 API 키를 노출하지 않고 서버에서 Gemini API를 호출한다.
 *
 * 실행 (PowerShell):
 *   $env:GEMINI_API_KEY="발급받은_키"; node server/llm-proxy.js
 *
 * nginx 설정 (conf/nginx.conf 의 server { ... } 블록 안에 추가):
 *   location /api/ {
 *     proxy_pass http://127.0.0.1:8787;
 *     proxy_read_timeout 120s;
 *   }
 *
 * 그 다음 Trip.html 우측 상단 "AI 설정" → "백엔드 프록시" → URL: /api/llm
 *
 * 요청:  POST /api/llm   { "system": "...", "prompt": "..." }
 * 응답:  200 { "text": "<LLM이 생성한 JSON 문자열>" }  |  4xx/5xx { "error": "..." }
 */
const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_BODY = 200 * 1024; // 200KB

if (!API_KEY) {
  console.error('[llm-proxy] 환경변수 GEMINI_API_KEY 가 필요합니다.');
  process.exit(1);
}

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('요청 본문이 너무 큽니다.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function callGemini(system, prompt) {
  const model = MODEL.replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const sendReq = async (useThinkingConfig) => {
    const gen = { responseMimeType: 'application/json' };
    if (useThinkingConfig && model.includes('gemini-3')) gen.thinkingConfig = { thinkingLevel: 'low' };
    else if (useThinkingConfig && model.includes('gemini-2.5-flash')) gen.thinkingConfig = { thinkingBudget: 0 };
    else gen.temperature = 0.7;

    const payload = {
      contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
      generationConfig: gen
    };
    if (system) payload.systemInstruction = { parts: [{ text: String(system) }] };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(110000)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  let { res, data } = await sendReq(true);
  if (res.status === 400) ({ res, data } = await sendReq(false));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API 오류 (${res.status})`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const answer = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  return answer || parts.map((p) => p.text || '').join('').trim();
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST' || !req.url.startsWith('/api/llm')) return send(res, 404, { error: 'Not Found' });

  try {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.prompt) return send(res, 400, { error: 'prompt 가 필요합니다.' });
    const text = await callGemini(body.system, body.prompt);
    if (!text) return send(res, 502, { error: 'LLM 응답이 비어 있습니다.' });
    send(res, 200, { text });
  } catch (err) {
    console.error('[llm-proxy]', err.message);
    send(res, 500, { error: err.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[llm-proxy] http://127.0.0.1:${PORT}/api/llm  (model: ${MODEL})`);
});

