// POST /api/seed  { note }  ->  new row in the Seeds database (unapproved)
import { addRow, text, reply } from './_notion.js';
const SEEDS = 'ccb69c16f1024169b288d7f13c5df17d';
export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  if (body.website) return reply(true);            // spam trap: real people never fill this
  const note = String(body.note || '').trim().slice(0, 80);
  if (!note) return reply(false, 400);
  return reply(await addRow(env, SEEDS, { Note: { title: text(note) } }));
}
