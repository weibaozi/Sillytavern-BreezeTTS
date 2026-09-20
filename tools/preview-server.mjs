// Local, self-contained UI preview. All audio and API responses are synthetic demo data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(project, 'extension');
const port = Number(process.env.BREEZE_PREVIEW_PORT || 8019);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid BREEZE_PREVIEW_PORT');
const ids = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const voice = (id, name, ref_text) => ({ id, name, ref_text, duration: 0.4, audio_url: `/breeze/voices/${id}/audio`, demo: true });
let state;
function reset() {
    state = {
        demo: true, nextId: 10, cancelled: [], requests: [], jobs: {}, streamEvents: [], audioRequests: [],
        voices: [
            voice(ids[0], '清朗男声 · 演示', '先说好，我负责拍。咱们能不能边吃边聊？'),
            voice(ids[1], '明快女声 · 演示', '我有个主意！拍食堂隐藏菜单怎么样？'),
            voice(ids[2], '温柔女声 · 演示', '吃饭可以，不过选题最好今天定下来。'),
        ],
    };
}
reset();
const nextId = () => (state.nextId++).toString(16).padStart(32, '0');
function wav() {
    const rate = 16000, samples = 6400, bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    for (let n = 0; n < samples; n++) bytes.writeInt16LE(Math.round(Math.sin(n / rate * Math.PI * 440 * 2) * 1000 * Math.sin(Math.PI * n / samples)), 44 + n * 2);
    return bytes;
}
const demoAudio = wav();

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Breeze Studio · 交互预览</title>
<link rel="stylesheet" href="/extension/style.css">
<style>
*{box-sizing:border-box}body{margin:0;background:#eeeae4;color:#363b37;font-family:system-ui,"Microsoft YaHei",sans-serif}button{font:inherit;cursor:pointer}.demo-shell{max-width:950px;margin:auto;padding:30px 24px}.demo-label{font-size:11px;letter-spacing:.15em;color:#6b756e;text-transform:uppercase}.demo-title{font-size:24px;margin:12px 0 6px}.demo-note{color:#747b72;font-size:13px;line-height:1.8}.demo-chat{padding:26px;border:1px solid #d7d9d0;border-radius:18px;background:#f8f8f3;margin-top:24px;line-height:1.8}.demo-chat h2{font-size:15px;color:#73796f}#send_form{display:flex;align-items:center;gap:12px;position:relative;margin-top:22px;border:1px solid #d4d8ce;background:#fffdf8;padding:12px;border-radius:14px}#send_form textarea{resize:none;flex:1;border:0;background:transparent;color:#72796e;font:inherit;min-width:0}#extensionsMenuButton{width:44px;height:44px;background:#e2eada;border:0;border-radius:10px;color:#466343;font-size:24px}#extensionsMenu{position:absolute;left:0;bottom:76px;width:248px;padding:8px;border:1px solid #d6dbd0;border-radius:12px;background:#fafbf5;box-shadow:0 14px 50px #17331b22;z-index:100}#extensionsMenu [hidden]{display:none}#extensionsMenu button,.list-group-item{display:flex;align-items:center;gap:10px;width:100%;padding:11px;border:0;background:transparent;color:#555e52;text-align:left;font-size:14px;border-radius:7px}#extensionsMenu button:hover,.list-group-item:hover{background:#e7eddc}.demo-tag{font-size:11px;border:1px solid #cfdbc6;padding:2px 7px;border-radius:5px}.mes_text{white-space:pre-wrap}.demo-footer{margin-top:20px;font-size:12px;color:#7b8276}@media(max-width:500px){.demo-shell{padding:22px 14px}.demo-chat{padding:20px}}
</style></head><body><main class="demo-shell"><div class="demo-label">BREEZE STUDIO / LOCAL PREVIEW</div><h1 class="demo-title">交互预览 · 演示数据</h1><p class="demo-note">从左下方魔法棒菜单打开 Breeze 语音工作室。这里使用独立的模拟聊天与音色；不会连接酒馆或真实模型。试听为短测试音。</p><section class="demo-chat"><h2>青禾大学 · 课程作业小组 <span class="demo-tag">演示聊天</span></h2><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div></div></div></section><form id="send_form"><button id="extensionsMenuButton" type="button" aria-label="打开扩展菜单" aria-expanded="false">✧</button><textarea aria-label="演示聊天输入框" readonly rows="1">从这里开始管理角色声音…</textarea><div id="extensionsMenu" role="menu" hidden><button type="button" role="menuitem" disabled>翻译聊天（演示占位）</button><button type="button" role="menuitem" disabled>变量管理器（演示占位）</button></div></form><div id="extensions_settings" hidden></div><p class="demo-footer">设置仅保存在当前浏览器标签页的演示会话中；不会修改真实酒馆配置。</p></main>
<script>
const raw = '周启明把相机放到桌上。\\n[TTSVoice:周启明:轻松:先吃饭吧，[笑]拍摄计划可以边吃边聊。]\\n\\n林知夏翻开笔记本。\\n[TTSVoice:林知夏:开心:那就去二食堂！我有个新点子。]\\n\\n沈予安看了一眼时间。“记得今晚把选题定下来。”\\n[TTSVoice:沈予安:自然:记得今晚把选题定下来。]';
document.querySelector('.mes_text').textContent = raw;
const handlers = new Map();
const storageKey = 'breeze-studio-demo-v1';
let saved;
try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
const chatStates = saved?.chats || {};
function persistDemo() {
    chatStates[context.chatId] = context.chatMetadata;
    sessionStorage.setItem(storageKey, JSON.stringify({ settings: context.extensionSettings, chats: chatStates }));
}
const events = ['GENERATION_STARTED','GENERATION_AFTER_COMMANDS','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_RECEIVED','CHAT_CHANGED','CHAT_LOADED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','PERSONA_CHANGED','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED','GROUP_UPDATED','PRESET_CHANGED','OAI_PRESET_CHANGED_AFTER'];
const context = {name1:'演示用户', characterId:0, groupId:'demo-campus', groups:[{id:'demo-campus',name:'青禾大学 · 演示聊天',members:['demo-zhou.png','demo-lin.png','demo-shen.png']}], chatId:'demo-campus-chat', characters:[{name:'周启明',avatar:'demo-zhou.png'},{name:'林知夏',avatar:'demo-lin.png'},{name:'沈予安',avatar:'demo-shen.png'}], chat:[{mes:raw,swipe_id:0}], chatMetadata:{breeze_voice:{mappings:{'周启明':'${ids[0]}','林知夏':'${ids[1]}'},manual:[],cache:{},demo:true}},extensionSettings:{breeze_voice:{baseUrl:location.origin,autoGenerate:false,autoPlay:false}},extensionPrompts:{},eventTypes:Object.fromEntries(events.map(e=>[e,e])),eventSource:{on(e,fn){if(!handlers.has(e))handlers.set(e,[]);handlers.get(e).push(fn)}},async saveMetadata(){window.__breezeDemo.metadataSaves++},saveSettingsDebounced(){window.__breezeDemo.settingsSaves++},setExtensionPrompt(key,value,position,depth,scan,role){this.extensionPrompts[key]={value,position,depth,scan,role}}};
if (saved?.settings) context.extensionSettings = saved.settings;
if (chatStates[context.chatId]) context.chatMetadata = chatStates[context.chatId];
context.saveMetadata = async () => { window.__breezeDemo.metadataSaves++; persistDemo(); };
context.saveSettingsDebounced = () => { window.__breezeDemo.settingsSaves++; persistDemo(); };
window.SillyTavern = {getContext:()=>context};
window.__breezeDemo = {
    context,metadataSaves:0,settingsSaves:0,
    emit:(event,...args)=>{for(const handler of handlers.get(event)||[])handler(...args)},
    switchChat(id) {
        chatStates[context.chatId] = context.chatMetadata;
        context.chatId = id;
        context.chatMetadata = chatStates[id] || {breeze_voice:{mappings:{'周启明':'${ids[0]}','林知夏':'${ids[1]}'},manual:[],cache:{},demo:true}};
        persistDemo();
        this.emit('CHAT_CHANGED');
    },
};
const menu = document.querySelector('#extensionsMenu'), toggle = document.querySelector('#extensionsMenuButton');
toggle.onclick = () => {menu.hidden=!menu.hidden;toggle.setAttribute('aria-expanded',String(!menu.hidden))};
menu.addEventListener('click',event=>{if(event.target.closest('#breeze_studio_wand_entry')){menu.hidden=true;toggle.setAttribute('aria-expanded','false')}});
</script><script type="module" src="/extension/index.js"></script></body></html>`;

function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 25 * 1024 * 1024) throw new Error('Demo upload exceeds 25 MB'); chunks.push(chunk); }
    return Buffer.concat(chunks);
}
const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
        if (path === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html); }
        if (path === '/__demo/reset' && req.method === 'POST') { reset(); return json(res, { demo: true, reset: true }); }
        if (path === '/__demo/state' && req.method === 'GET') return json(res, state);
        if (path === '/breeze/health' && req.method === 'GET') return json(res, { version: 1, loaded: true, queued: 0, running: false, streaming: true, demo: true });
        if (path === '/breeze/voices' && req.method === 'GET') return json(res, { voices: state.voices, demo: true });
        if (path === '/breeze/voices' && req.method === 'POST') {
            const data = await new Request('http://127.0.0.1/demo-upload', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: await body(req) }).formData();
            const name = String(data.get('name') || '').trim(), text = String(data.get('ref_text') || '').trim();
            if (!name || !text || !data.get('audio')?.size) return json(res, { detail: '请填写名称、准确文字并选择参考音频。' }, 422);
            if (state.voices.some(v => v.name === name)) return json(res, { detail: '音色名称已存在（演示响应）。' }, 409);
            const record = voice(nextId(), name, text); state.voices.push(record); return json(res, record, 201);
        }
        if (path === '/breeze/voices/from-job' && req.method === 'POST') {
            const data = JSON.parse(await body(req)), job = state.jobs[data.job_id];
            if (!job || job.status !== 'done') return json(res, { detail: '候选尚未完成。' }, 409);
            if (state.voices.some(v => v.name === data.name)) return json(res, { detail: '音色名称已存在（演示响应）。' }, 409);
            const record = voice(nextId(), data.name, job.text); state.voices.push(record); return json(res, record, 201);
        }
        if (['/breeze/jobs', '/breeze/jobs/direction'].includes(path) && req.method === 'POST') {
            let data;
            if (path.endsWith('/direction')) {
                const form = await new Request('http://127.0.0.1/demo-direction', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: await body(req) }).formData();
                const audio = form.get('audio');
                if (!form.get('text')?.trim() || !form.get('ref_text')?.trim() || !audio?.size) return json(res, { detail: '请填写试听文本、准确文字并选择参考音频。' }, 422);
                data = { kind: 'direction', text: form.get('text'), instruction: form.get('instruction') || '', ref_text: form.get('ref_text'), cfg_scale: Number(form.get('cfg_scale')), seed: Number(form.get('seed')), audio: { name: audio.name, size: audio.size } };
            } else data = JSON.parse(await body(req));
            const id = nextId(); state.requests.push({ ...data, id, demo: true });
            const failed = data.instruction?.includes('[演示失败]'), slow = data.instruction?.includes('[演示慢速]');
            const job = { id, text: data.text, status: failed ? 'error' : slow || data.stream ? 'running' : 'done', duration: 0.4, demo: true };
            if (data.stream) job.stream_url = `/breeze/jobs/${id}/stream`;
            if (job.status === 'done') job.audio_url = `/breeze/jobs/${id}/audio`;
            if (failed) job.error = '演示生成失败：请修改声音描述后重试。';
            state.jobs[id] = job; return json(res, job, 202);
        }
        const streamMatch = /^\/breeze\/jobs\/([a-f0-9]{32})\/stream$/.exec(path);
        if (streamMatch && req.method === 'GET') {
            const demoState = state, job = demoState.jobs[streamMatch[1]];
            if (!job?.stream_url) return json(res, { detail: '演示流式任务不存在。' }, 404);
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
            res.flushHeaders();
            const timers = [];
            const send = event => {
                if (res.destroyed || res.writableEnded) return;
                demoState.streamEvents.push({ id: job.id, type: event.type, at: Date.now() });
                res.write(JSON.stringify(event) + '\n');
            };
            const schedule = (ms, action) => timers.push(setTimeout(() => {
                if (job.status === 'cancelled') { send({ type: 'error', status: 'cancelled', error: '演示任务已取消。' }); res.end(); }
                else action();
            }, ms));
            const pcm = demoAudio.subarray(44);
            if (job.status === 'error') { send({ type: 'error', status: 'error', error: job.error }); res.end(); return; }
            schedule(30, () => send({ type: 'audio', sample_rate: 16000, pcm: pcm.subarray(0, 6400).toString('base64') }));
            schedule(380, () => send({ type: 'audio', sample_rate: 16000, pcm: pcm.subarray(6400).toString('base64') }));
            schedule(1500, () => {
                job.status = 'done'; job.audio_url = `/breeze/jobs/${job.id}/audio`;
                send({ type: 'done', job }); res.end();
            });
            res.on('close', () => {
                for (const timer of timers) clearTimeout(timer);
                demoState.streamEvents.push({ id: job.id, type: 'closed', at: Date.now() });
            });
            return;
        }
        const jobMatch = /^\/breeze\/jobs\/([a-f0-9]{32})$/.exec(path);
        if (jobMatch) {
            const job = state.jobs[jobMatch[1]];
            if (!job) return json(res, { detail: '演示任务不存在。' }, 404);
            if (req.method === 'DELETE') { job.status = 'cancelled'; state.cancelled.push(job.id); }
            return json(res, job);
        }
        if (/^\/breeze\/(voices|jobs)\/[a-f0-9]{32}\/audio$/.test(path) && req.method === 'GET') {
            state.audioRequests.push({ path, at: Date.now() });
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': demoAudio.length, 'Cache-Control': 'no-store' }); return res.end(demoAudio);
        }
        if (path.startsWith('/extension/') && req.method === 'GET') {
            const filename = resolve(extensionRoot, decodeURIComponent(path.slice('/extension/'.length)));
            const child = relative(extensionRoot, filename);
            if (!child || child.startsWith('..') || isAbsolute(child) || !['.js', '.css', '.json'].includes(extname(filename))) return json(res, { detail: 'Invalid preview asset' }, 403);
            const content = await readFile(filename);
            res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(filename)] + '; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(content);
        }
        return json(res, { detail: 'Local demo route not found' }, 404);
    } catch (error) { return json(res, { detail: error.message }, error.code === 'ENOENT' ? 404 : 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Breeze Studio demo: http://127.0.0.1:${port} (synthetic data only)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
