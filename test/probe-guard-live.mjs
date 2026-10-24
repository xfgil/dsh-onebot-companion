import { sanitizeText, sanitizeSegments } from '../lib/modules/guard.js';
const cfg = { enabled: true, stripAside: true, stripNarration: true, muteQueueNotice: true, muteAdminOnlyNotice: true };
const cases = ['你今天怎么样呀喵~','看这个（笑）','（1）第一点\n（2）第二点','等你回话呢，说啊','等他来了我们再点吧，你说呢','那你现在饿不饿呀','今天好累啊喵\n（这条不是点我，不接话）'];
for (const c of cases) {
  const r = sanitizeText(c, cfg);
  console.log(JSON.stringify(c), '=>', JSON.stringify(r));
}

