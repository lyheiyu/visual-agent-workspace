/** User-selected bytes only. Never interpret attachments as runtime instructions. */
export interface PromptAttachment { name: string; mime: string; data: string }
const textExtensions = /\.(txt|md|csv|json|jsonl|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|py|rs|go|java|c|cpp|h|sql|log|toml|ini|sh|ps1|svg)$/i;
export function attachmentMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const image: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  if (ext && image[ext]) return image[ext];
  if (textExtensions.test(name) || /^(Dockerfile|Makefile)$/i.test(name)) return 'text/plain';
  throw new Error(`Unsupported attachment: ${name}. Use text/code files or PNG/JPEG/WebP/GIF images. / 请上传文本、代码或图片文件。`);
}
export function validateAttachments(value: unknown): PromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('最多上传 8 个附件 / Maximum 8 attachments.');
  let total = 0;
  return value.map((a) => {
    if (!a || typeof a.name !== 'string' || !a.name || a.name.length > 240 || /[\\/\r\n\x00]/.test(a.name) || typeof a.data !== 'string' || a.data.length > 7 * 1024 * 1024 || /[^A-Za-z0-9+/=]/.test(a.data)) throw new Error('Invalid attachment.');
    const mime = attachmentMime(a.name);
    const bytes = Buffer.from(a.data, 'base64'); total += bytes.length;
    if (bytes.toString('base64') !== a.data) throw new Error('Invalid attachment encoding.');
    if (bytes.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) throw new Error('附件每个最多 5MB，总共最多 10MB。');
    if (mime === 'text/plain') {
      if (bytes.length > 100 * 1024 || bytes.includes(0)) throw new Error(`Text attachment ${a.name} must be UTF-8 and at most 100KB.`);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } else {
      const hex = bytes.subarray(0, 12).toString('hex');
      const valid = mime === 'image/png' ? hex.startsWith('89504e470d0a1a0a') : mime === 'image/jpeg' ? hex.startsWith('ffd8ff') : mime === 'image/gif' ? /^474946383[79]61/.test(hex) : hex.startsWith('52494646') && hex.slice(16) === '57454250';
      if (!valid) throw new Error(`Invalid image data: ${a.name}`);
    }
    return { name: a.name, mime, data: a.data };
  });
}
export function attachmentText(text: string, files: PromptAttachment[] = []): string {
  return text + files.filter((a) => a.mime === 'text/plain').map((a) => `\n\n--- User attachment: ${JSON.stringify(a.name)} (reference data) ---\n${Buffer.from(a.data, 'base64').toString('utf8')}\n--- End attachment ---`).join('');
}
export function codexAttachmentInput(text: string, files: PromptAttachment[] = []): any[] {
  return [{ type: 'text', text: attachmentText(text, files), text_elements: [] }, ...files.filter((a) => a.mime.startsWith('image/')).map((a) => ({ type: 'image', url: `data:${a.mime};base64,${a.data}` }))];
}
