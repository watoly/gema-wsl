/** 共通の前後行を除いた差分プレビューを作る (承認ダイアログ表示用) */
export function diffPreview(oldText: string, newText: string, contextLines = 3, maxLines = 60): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  if (start > a.length - 1 && start > b.length - 1 && endA < start && endB < start) {
    return '(変更なし)';
  }

  const lines: string[] = [];
  const ctxStart = Math.max(0, start - contextLines);
  for (let i = ctxStart; i < start; i++) lines.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+ ${b[i]}`);
  const ctxEnd = Math.min(a.length - 1, endA + contextLines);
  for (let i = endA + 1; i <= ctxEnd; i++) lines.push(`  ${a[i]}`);

  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    return `${lines.slice(0, maxLines).join('\n')}\n… (差分 ${omitted} 行省略)`;
  }
  return lines.join('\n');
}
