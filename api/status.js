// Vercel Serverless: GET /api/status?provider=xxx&job_id=yyy
// Polls provider API for job status using server-side keys
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { provider, job_id } = req.query;
        if (!provider || !job_id) return res.status(400).json({ error: 'provider dan job_id wajib diisi' });

        const key = getKey(provider);
        if (!key) return res.status(400).json({ error: `API key untuk ${provider} belum dikonfigurasi` });

        const result = await checkStatus(provider, key, job_id);
        return res.status(200).json(result);
    } catch (e) {
        console.error('Status error:', e);
        const msg = e.message || 'Terjadi kesalahan server';
        const status = e.status || 500;
        return res.status(status).json({ error: msg });
    }
}

// ─── ENV KEYS ───
const ENV_MAP = {
    freepik: 'FREEPIK_API_KEY',
    magnific: 'MAGNIFIC_API_KEY',
    kie: 'KIE_API_KEY',
    grok: 'GROK_API_KEY',
};
function getKey(p) { return process.env[ENV_MAP[p] || `${p.toUpperCase()}_API_KEY`] || ''; }

// ─── PROVIDER CONFIG ───
const PROV = {
    freepik:  { base: 'https://api.freepik.com',  hdr: 'x-freepik-api-key',  htype: 'custom' },
    magnific: { base: 'https://api.magnific.com', hdr: 'x-magnific-api-key', htype: 'custom' },
    kie:      { base: 'https://api.kie.ai',       hdr: 'Authorization',      htype: 'bearer' },
    grok:     { base: 'https://api.x.ai',         hdr: 'Authorization',      htype: 'bearer' },
};

function apiErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

function makeHeaders(provider, key) {
    const info = PROV[provider];
    if (!info) throw apiErr(400, `Provider "${provider}" tidak dikenal`);
    const h = { 'Accept': 'application/json' };
    h[info.hdr] = info.htype === 'bearer' ? `Bearer ${key}` : key;
    return { headers: h, base: info.base };
}

async function apiFetch(url, opts) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 30000);
    try {
        const r = await fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(tid);
        const d = await r.json();
        if (!r.ok) throw apiErr(r.status, d.message || d.msg || d.error?.message || `API error HTTP ${r.status}`);
        return d;
    } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') throw apiErr(504, 'API timeout');
        throw e;
    }
}

// ─── STATUS CHECK ───
async function checkStatus(provider, key, job_id) {
    const { headers, base } = makeHeaders(provider, key);

    if (provider === 'kie') {
        const d = await apiFetch(`${base}/api/v1/jobs/recordInfo?taskId=${job_id}`, { method: 'GET', headers });
        const task = d.data || d;
        const st = task.status || task.taskStatus;
        if (st === 'success') {
            const url = task.output?.works?.[0]?.resource?.resource || task.output?.video_url || task.resultUrl || '';
            if (url) return { status: 'done', video_url: url };
            return { status: 'done', video_url: null, warning: 'Selesai tapi URL video tidak ditemukan' };
        }
        if (st === 'fail' || st === 'failed') return { status: 'failed', error: 'AI gagal memproses video. Coba lagi dengan gambar/video yang berbeda.' };
        return { status: 'processing', detail: st === 'generating' ? 'Memproses...' : 'Dalam antrian...' };
    }

    if (provider === 'grok') {
        const d = await apiFetch(`${base}/v1/videos/${job_id}`, { method: 'GET', headers });
        if (d.status === 'done' && d.video?.url) return { status: 'done', video_url: d.video.url };
        if (d.status === 'failed' || d.error) return { status: 'failed', error: d.error?.message || 'AI gagal memproses video. Coba lagi.' };
        return { status: 'processing', progress: d.progress || 0, detail: `Memproses... ${d.progress || 0}%` };
    }

    // Freepik / Magnific — try both motion control and video endpoints
    const eps = [
        `/v1/ai/video/kling-v2-6-motion-control/${job_id}`,
        `/v1/ai/video/kling-v2-6/${job_id}`,
    ];
    let lastErr = null;
    for (const ep of eps) {
        try {
            const d = await apiFetch(`${base}${ep}`, { method: 'GET', headers });
            if (!d?.data) continue;
            const t = d.data;
            if (t.status === 'COMPLETED') {
                const urls = t.generated || [];
                if (urls.length) return { status: 'done', video_url: urls[0] };
                return { status: 'done', video_url: null, warning: 'Selesai tapi URL video tidak ditemukan' };
            }
            if (t.status === 'FAILED') return { status: 'failed', error: 'AI gagal memproses video. Coba lagi dengan parameter yang berbeda.' };
            return { status: 'processing', detail: t.status === 'IN_PROGRESS' ? 'Memproses...' : 'Dalam antrian...' };
        } catch (e) {
            lastErr = e;
            continue;
        }
    }
    // If all endpoints failed, return processing (might just be too early)
    return { status: 'processing', detail: 'Menunggu status...' };
}
