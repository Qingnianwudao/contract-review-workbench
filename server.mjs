import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const localEnv = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const port = Number(process.env.PORT || 3000);
const workflowId = process.env.COZE_WORKFLOW_ID || '7694552059777417256';
const token = process.env.COZE_PAT;
const apiBase = (process.env.COZE_API_BASE || 'https://api.coze.cn').replace(/\/$/, '');
const maxBytes = 10 * 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function upstreamFailure(message, status, code) {
  const error = new Error(message || '扣子 API 返回错误');
  error.upstreamStatus = status;
  error.upstreamCode = code;
  return error;
}

function explainUpstreamFailure(error) {
  const status = error.upstreamStatus;
  if (status === 401 || status === 403) return '凭据无效，或访问令牌未开通工作流 run 权限。请在扣子重新核对 PAT 权限。';
  if (status === 404) return '未找到工作流或 API 地址。请核对工作流 ID、发布状态及服务区域。';
  if (error.name === 'TimeoutError') return '扣子调用超时。请检查工作流是否在扣子平台可正常运行，或稍后重试。';
  const causeCode = error.cause?.code;
  if (causeCode) return `服务器无法连接扣子 API（${causeCode}）。请检查服务器网络、DNS 或代理设置。`;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return '服务器无法连接扣子 API。请检查服务器网络、DNS 或代理设置。';
  const detail = error.message || '未知上游错误';
  const code = error.upstreamCode ? `，扣子错误码 ${error.upstreamCode}` : '';
  return `扣子 API 调用失败${status ? `（HTTP ${status}${code}）` : code}：${detail}`;
}

function adaptWorkflowResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = { ...data };
  const review = result.output;
  if (typeof review === 'string' && review.trim()) {
    try {
      const parsed = JSON.parse(review);
      if (Array.isArray(parsed)) result.issues ??= parsed;
      else if (parsed && typeof parsed === 'object') Object.assign(result, parsed);
    } catch {
      result.review_text ??= review;
    }
  }
  if (typeof result.output1 === 'string' && result.output1.trim()) {
    result.law_verification_summary ??= result.output1;
  }
  if (result.enterprise != null) result.company_verification_summary ??= result.enterprise;
  if (result.url != null) result.feishu_report_url ??= result.url;
  return result;
}

async function handleReview(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes + 1024 * 1024) return send(res, 413, { error: '请求过大，请将文件控制在 10MB 以内。' });
    chunks.push(chunk);
  }
  let form;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData(); }
  catch { return send(res, 400, { error: '无法读取提交内容，请重试。' }); }
  const file = form.get('file');
  const contractText = String(form.get('contractText') || '').trim();
  if (!file && !contractText) return send(res, 400, { error: '请先上传合同文件或粘贴合同文本。' });
  if (file && file.size > maxBytes) return send(res, 413, { error: '单个文件不能超过 10MB。' });
  if (!file && Buffer.byteLength(contractText, 'utf8') > maxBytes) return send(res, 413, { error: '粘贴的合同文本不能超过 10MB。' });
  if (!token) return send(res, 503, { error: '服务端尚未配置 COZE_PAT，暂时无法连接扣子。请配置后重试，或使用演示模式查看示例结果。', code: 'NOT_CONFIGURED' });

  const contractType = String(form.get('contractType') || '');
  const stance = String(form.get('stance') || '中立');
  const focusAreas = String(form.get('focusAreas') || '');
  const requirements = String(form.get('requirements') || '');
  const params = {
    xuqiu: [
      `合同类型：${contractType || '未指定'}`,
      `审查立场：${stance}`,
      `重点审查：${focusAreas || '未指定'}`,
      `补充要求：${requirements || '无'}`
    ].join('\n')
  };
  try {
    // This workflow requires a `wenjian` document input. Convert pasted text
    // to a TXT document so both submission modes satisfy the same schema.
    const contractFile = file && file.size
      ? file
      : new File([contractText], '粘贴合同.txt', { type: 'text/plain' });
    if (contractFile.size > maxBytes) return send(res, 413, { error: '单个文件不能超过 10MB。' });
    {
      const upload = new FormData(); upload.append('file', contractFile, contractFile.name);
      const up = await fetch(`${apiBase}/v1/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: upload, signal: AbortSignal.timeout(120000) });
      const uploaded = await up.json();
      if (!up.ok || uploaded.code !== 0 || !uploaded.data?.id) throw upstreamFailure(uploaded.msg || '文件上传失败', up.status, uploaded.code);
      // Coze's workflow-run API expects file parameters as serialized JSON.
      params.wenjian = JSON.stringify({ file_id: uploaded.data.id });
    }
    const response = await fetch(`${apiBase}/v1/workflow/run`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: workflowId, parameters: params }), signal: AbortSignal.timeout(300000)
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw upstreamFailure(result.msg || '工作流调用失败', response.status, result.code);
    let data = result.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = { output: data }; } }
    data = adaptWorkflowResult(data);
    send(res, 200, { result: data, debugUrl: result.debug_url || null, source: 'coze' });
  } catch (error) {
    // Keep credentials and upstream response details out of logs and browser responses.
    send(res, 502, { error: explainUpstreamFailure(error), code: 'UPSTREAM_ERROR' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/review') return handleReview(req, res);
  if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { configured: Boolean(token), workflowId });
  if (req.method === 'GET') {
    const requested = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1).split('?')[0]);
    const filePath = path.resolve(root, requested);
    if (!filePath.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const content = await readFile(filePath);
      const type = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : filePath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      return send(res, 200, content, type);
    } catch { return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  }
  send(res, 405, { error: 'Method not allowed' });
});
server.listen(port, () => console.log(`合同审查工作台运行于 http://localhost:${port}`));
