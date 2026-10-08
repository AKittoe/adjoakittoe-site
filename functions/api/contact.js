// POST /api/contact  { name, email, topic, message }  ->  new row in Contact Inbox
import { addRow, text, reply } from './_notion.js';
const INBOX = 'fe4a5cc589b84f58b538de7f5c00a31d';
export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  if (b.website) return reply(true);
  if (!b.name || !b.email || !b.message) return reply(false, 400);
  return reply(await addRow(env, INBOX, {
    Name: { title: text(b.name) },
    Email: { email: String(b.email).slice(0, 200) },
    Topic: { rich_text: text(b.topic) },
    Message: { rich_text: text(b.message) },
  }));
}
