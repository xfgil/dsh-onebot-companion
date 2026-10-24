import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('D:/ruanjian/NapCatShell/_diag/_archive-debug-20261014/sysface-full.json', 'utf8'));
const seen = new Map();
for (const item of raw) {
  const id = String(item.id ?? '').trim();
  let name = String(item.name ?? '').trim().replace(/^\//, '');
  if (id === '' || name === '') continue;
  if (!/^\d+$/.test(id)) continue;
  if (seen.has(id)) continue;
  seen.set(id, name);
}
const entries = [...seen.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
console.log('count', entries.length);

const lines = entries.map(([id, name]) => `  '${id}': '${name.replace(/'/g, "\\'")}',`);
const body = `/**
 * QQ 表情 id → 中文名。
 *
 * 数据源：\`D:\\ruanjian\\NapCatShell\\_diag\\_archive-debug-20261014\\sysface-full.json\`
 * （NapCat 导出的系统表情全表，${entries.length} 条，字段只有 id 与 name）。
 *
 * **为什么不用上游 \`cq.js\` 的 \`FACE_EMOJI\`**：那张表把 id 当 emoji 码位映射，
 * 329 个 id 里 123 个落到兜底 \`😀\`，其余语义全错 —— 实测 \`/变形\`(312) 被翻成
 * 🐳（她于是回「又发个鲸鱼」）、\`/笑哭\`(182) 被翻成 🧕、\`/亲亲\`(360) 被翻成 🐇。
 * 表情的「意思」只在这张中文名表里，emoji 猜不出来。
 *
 * 重新生成：改 \`_gen_faces_in.mjs\` 里的数据源路径后跑它。
 *
 * @module dsh-onebot-companion/face-names
 */

/** id（字符串）→ 表情名（不带前导斜杠）。 */
export const FACE_NAMES_IN = Object.freeze({
${lines.join('\n')}
});

/** 全表条数，自测用。 */
export const FACE_NAMES_IN_COUNT = ${entries.length};

/**
 * 取表情名。
 *
 * @param {string|number} id 表情 id
 * @returns {string|null} 认识就返回名字，不认识返回 null（不回落到瞎猜的 emoji）
 */
export function faceNameOf(id) {
  const key = String(id ?? '').trim();
  if (key === '') return null;
  return FACE_NAMES_IN[key] ?? null;
}
`;
writeFileSync('D:/Plugins/dsh-onebot-companion/lib/modules/face-names.js', body, 'utf8');
console.log('written');
