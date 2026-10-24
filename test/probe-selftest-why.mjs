import { loadTargetClass } from '../lib/core/profile.js';
const found = await loadTargetClass({ get: () => undefined, inject: () => {} }, { packageName: 'dsh-onebot-qq', profileDir: 'C:\\Users\\user\\.dsh\\profiles\\desktop' }, 'outbound.js', 'OutboundPipeline');
console.log('found', found.ok, found.error ?? found.url);
if (!found.ok) process.exit(0);
const sent = [];
const fakeCtx = {
  connected: () => true, selfId: () => '0', isStopping: () => false,
  log: (l, m) => console.log('[log]', l, m), trace: () => undefined, getChat: () => undefined,
  config: { botQQ: '0', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 1<<20, cardFooter: '', fontFiles: [], fontFamilies: [] },
  call: async (action, params, chatId) => { sent.push({action, params}); return { message_id: 'x'+sent.length }; },
};
const fake = new found.klass(fakeCtx);
try { const r = await fake.sendToChat('private:1', '你今天怎么样呀喵~', {}); console.log('returned', JSON.stringify(r)); }
catch (e) { console.log('threw', e && e.message); }
console.log('sent', sent.length, JSON.stringify(sent));

