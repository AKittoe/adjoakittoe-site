// POST /api/resource  { name, url, type, deadline, why, from }  ->  new row in Resource Suggestions
import { addRow, text, reply } from './_notion.js';
const SUGGESTIONS = '3f300fffbfbb4aa2885bb9d9a209bb58';
const TYPES = ['Organization', 'Funding', 'Tool', 'Learning'];
export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (b.website) return reply(true);
  if (!b.name || !b.url) return reply(false, 400);
  const link = /^https?:\/\//i.test(b.url) ? String(b.url).slice(0, 1900) : null;
  return reply(await addRow(env, SUGGESTIONS, {
    Name: { title: text(b.name) },
    Link: { url: link },
    ...(TYPES.includes(b.type) ? { Type: { select: { name: b.type } } } : {}),
    Deadline: { rich_text: text(b.deadline) },
    'Why it helped': { rich_text: text(b.why) },
    From: { rich_text: text(b.from) },
  }));
}
