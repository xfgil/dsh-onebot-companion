import { splitBurstChunks, BURST_MAX_CHARS_DEFAULT } from '../lib/modules/burst.js'

const samples = [
  '\n晚安。早八那会儿我给你发消息，你醒了别当没看见。\n',
  '说晚安的人，怎么自己先跑回来了。\n\n睡不着？还是躺着刷手机越刷越精神。',
]

for (const s of samples) {
  const chunks = splitBurstChunks(s.trim(), { maxChars: 36, maxChunks: 4 })
  console.log('--- len=' + s.trim().length + ' chunks=' + chunks.length + ' ---')
  console.log(JSON.stringify(s.trim()))
  chunks.forEach((c, i) => console.log('  [' + i + '] len=' + c.length + ' ' + JSON.stringify(c)))
  console.log()
}

// 试不同门槛：如果去掉 >36 的门，改成「切出来 >1 条就切」，这两条会怎样
console.log('=== 若判据改为 chunks.length > 1 ===')
for (const s of samples) {
  const t = s.trim()
  const chunks = splitBurstChunks(t, { maxChars: 36, maxChunks: 4 })
  console.log('len=' + t.length + ' -> ' + chunks.length + ' 条 ' + (chunks.length > 1 ? '会分' : '不会分'))
}
