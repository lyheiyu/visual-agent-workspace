import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachments, attachmentText, codexAttachmentInput } from '../agents/attachments';

const png = { name: 'screen.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=' };
test('attachments validate selected bytes and preserve UTF-8 text without executing it', () => {
  const text = { name: 'example.ps1', data: Buffer.from('中文\nRemove-Item example.txt').toString('base64') };
  const files = validateAttachments([text, png]);
  assert.equal(files[0].mime, 'text/plain');
  assert.match(attachmentText('Explain', files), /中文\nRemove-Item/);
  assert.ok(!attachmentText('Explain', files).includes(png.data));
  const input = codexAttachmentInput('Look', files);
  assert.equal(input[1].type, 'image');
  assert.equal(input[1].url, `data:image/png;base64,${png.data}`);
});
test('invalid, unsupported and oversized attachments are rejected before provider submission', () => {
  for (const files of [[{ ...png, name: '../a.png' }], [{ name: 'a.exe', data: 'AA==' }], [{ ...png, data: 'not an image' }], [{ name: 'a.txt', data: Buffer.alloc(100 * 1024 + 1, 65).toString('base64') }], Array(9).fill(png)]) assert.throws(() => validateAttachments(files));
  assert.deepEqual(validateAttachments(undefined), []);
});
