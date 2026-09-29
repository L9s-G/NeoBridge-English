/**
 * LLM 输出里的 JSON 提取：剥围栏、跳杂文、截平衡括号。
 *
 * 三道防线对应三种真实输出：
 *   1. ```json ... ``` 围栏（模型爱加）
 *   2. JSON 前后夹一句解释（"好的，以下是结果：..."）
 *   3. 输出被截断（括号没闭合）——直接抛错，让调用方按截断重试
 *
 * 纯函数、无依赖，Node 与浏览器共用。
 */

/** 从 LLM 的 content 里解析出 JSON 值；失败一律抛 Error */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('extractJson: 输入为空');
  }

  let s = text.trim();

  // 防线 1：剥围栏（```json / ``` 都吃）
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 防线 2：跳到第一个 { 或 [
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error('extractJson: 找不到 JSON 起始符');
  s = s.slice(start);

  // 防线 3：扫描到括号平衡；字符串内的括号不计
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error('extractJson: JSON 不完整（括号未闭合，输出可能被截断）');

  try {
    return JSON.parse(s.slice(0, end));
  } catch (err) {
    throw new Error(`extractJson: JSON 解析失败：${err.message}`);
  }
}
