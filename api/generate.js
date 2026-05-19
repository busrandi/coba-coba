// Vercel Serverless: POST /api/generate
// Receives upload URLs + settings, calls provider API with server-side keys
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { mode, provider, image_url, video_url, end_image_url, prompt, negative_prompt, settings } = req.body;
        if (!mode || !provider) return res.status(400).json({ error: 'Mode dan provider wajib diisi' });

        const key = getKey(provider);
        if (!key) return res.status(400).json({ error: `API key untuk ${provider} belum dikonfigurasi di server. Tambahkan environment variable ${envName(provider)} di Vercel.` });

        let result;
        if (mode === 'motion') {
            result = await genMotion(provider, key, { image_url, video_url, prompt, settings });
        } else {
            result = await genVideo(provider, key, { image_url, end_image_url, prompt, negative_prompt, settings });
        }

        return res.status(200).json(result);
    } catch (e) {
        console.error('Generate error:', e);
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
function envName(p) { return ENV_MAP[p] || `${p.toUpperCase()}_API_KEY`; }
function getKey(p) { return process.env[envName(p)] || ''; }

// ─── PROVIDER CONFIG ───
const PROV = {
    freepik:  { base: 'https://api.freepik.com',  hdr: 'x-freepik-api-key',  htype: 'custom' },
    magnific: { base: 'https://api.magnific.com', hdr: 'x-magnific-api-key', htype: 'custom' },
    kie:      { base: 'https://api.kie.ai',       hdr: 'Authorization',      htype: 'bearer' },
    grok:     { base: 'https://api.x.ai',         hdr: 'Authorization',      htype: 'bearer' },
};

function makeHeaders(provider, key) {
    const info = PROV[provider];
    if (!info) throw apiErr(400, `Provider "${provider}" tidak dikenal`);
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    h[info.hdr] = info.htype === 'bearer' ? `Bearer ${key}` : key;
    return { headers: h, base: info.base };
}

function apiErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

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
        if (e.name === 'AbortError') throw apiErr(504, 'API timeout (30 detik)');
        throw e;
    }
}

// ─── MOTION CONTROL ───
async function genMotion(provider, key, { image_url, video_url, prompt, settings = {} }) {
    if (!image_url) throw apiErr(400, 'URL gambar karakter wajib diisi');
    if (!video_url) throw apiErr(400, 'URL video referensi wajib diisi');

    const { headers, base } = makeHeaders(provider, key);

    if (provider === 'kie') {
        const body = {
            model: 'kling-3.0/motion-control',
            callBackUrl: 'https://example.com/cb',
            input: {
                input_urls: [image_url],
                video_urls: [video_url],
                mode: settings.quality === 'pro' ? '1080p' : '720p',
                character_orientation: settings.orientation || 'video',
                background_source: 'input_video',
            }
        };
        if (prompt) body.input.prompt = prompt;

        const res = await apiFetch(`${base}/api/v1/jobs/createTask`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.data?.taskId) throw apiErr(502, 'Kie.ai tidak mengembalikan taskId');
        return { job_id: res.data.taskId, provider: 'kie' };
    }

    // Freepik / Magnific
    const ep = settings.quality === 'pro' ? '/v1/ai/video/kling-v3-motion-control-pro' : '/v1/ai/video/kling-v3-motion-control-std';
    const body = {
        image_url,
        video_url,
        character_orientation: settings.orientation || 'video',
        cfg_scale: parseFloat(settings.cfg_scale || 0.5),
    };
    if (prompt) body.prompt = prompt;

    const res = await apiFetch(`${base}${ep}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.data?.task_id) throw apiErr(502, `${provider} tidak mengembalikan task_id`);
    return { job_id: res.data.task_id, provider };
}

// ─── VIDEO GENERATE ───
async function genVideo(provider, key, { image_url, end_image_url, prompt, negative_prompt, settings = {} }) {
    const { headers, base } = makeHeaders(provider, key);

    if (provider === 'grok') {
        const body = {
            model: 'grok-imagine-video',
            prompt: prompt || '',
            aspect_ratio: settings.aspect_ratio || '16:9',
            duration: parseInt(settings.duration || 8),
            resolution: settings.resolution || '720p',
        };
        if (image_url) {
            body.image = { url: image_url };
        } else if (!body.prompt) {
            throw apiErr(400, 'Masukkan prompt atau upload gambar');
        }

        const res = await apiFetch(`${base}/v1/videos/generations`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.request_id) throw apiErr(502, 'Grok tidak mengembalikan request_id');
        return { job_id: res.request_id, provider: 'grok' };
    }

    // Freepik / Magnific
    const body = {
        prompt: prompt || '',
        aspect_ratio: settings.aspect_ratio || '16:9',
        duration: parseInt(settings.duration || 8),
        negative_prompt: negative_prompt || '',
        cfg_scale: 0.5,
    };
    if (image_url) {
        body.start_image_url = image_url;
        if (end_image_url) body.end_image_url = end_image_url;
    } else if (!body.prompt) {
        throw apiErr(400, 'Masukkan prompt atau upload gambar');
    }

    const ep = settings.quality === 'pro' ? '/v1/ai/video/kling-v3-pro' : '/v1/ai/video/kling-v3-std';
    const res = await apiFetch(`${base}${ep}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.data?.task_id) throw apiErr(502, `${provider} tidak mengembalikan task_id`);
    return { job_id: res.data.task_id, provider };
}
