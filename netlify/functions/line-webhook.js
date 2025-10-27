// netlify/functions/line-webhook.js
export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    // log ดูบน Netlify → Deploys → Logs
    console.log('LINE event:', JSON.stringify(body, null, 2));
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
}
