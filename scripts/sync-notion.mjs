// Pulls Notes and State Tracker from Notion and saves them as JSON for the site.
// Runs in GitHub Actions with the NOTION_TOKEN secret. Node 20+, no packages needed.
import { writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('Missing NOTION_TOKEN'); process.exit(1); }

const DB = {
  notes: 'afe7486bd6514bc386098bfc1eada4ab',   // Personal Website > Notes
  states: '842c11ca23ee42a9bc1db398add83aec',  // Personal Website > State Tracker
};

const headers = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

async function queryAll(id) {
  const rows = []; let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${id}/query`, { method: 'POST', headers, body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }) });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const j = await res.json(); rows.push(...j.results); cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows;
}

const text = p => (p?.title || p?.rich_text || []).map(t => t.plain_text).join('').trim();
const check = p => !!p?.checkbox;

async function saveImage(page, prop) {
  const f = prop?.files?.[0]; if (!f) return '';
  const url = f.type === 'external' ? f.external.url : f.file.url;
  const res = await fetch(url); if (!res.ok) return '';
  const type = res.headers.get('content-type') || '';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
  await mkdir('assets/notes', { recursive: true });
  const path = `assets/notes/${page.id.replace(/-/g, '')}.${ext}`;
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return '/' + path;
}

const notesRaw = await queryAll(DB.notes);
const notes = [];
for (const p of notesRaw) {
  const pr = p.properties;
  if (!check(pr.Publish)) continue;
  notes.push({
    title: text(pr.Title),
    text: text(pr.Text),
    tag: text(pr.Tag),
    collection: pr.Collection?.select?.name || '',
    date: pr.Date?.date?.start || '',
    order: pr.Order?.number ?? 999,
    image: await saveImage(p, pr.Image),
  });
}
notes.sort((a, b) => a.order - b.order);

const statesRaw = await queryAll(DB.states);
const states = statesRaw.map(p => {
  const pr = p.properties;
  return { state: text(pr.State), visited: check(pr.Visited), favorite: check(pr.Favorite), wontGo: check(pr["Won't go"]), note: text(pr['Hover note']) };
}).filter(s => s.state).sort((a, b) => a.state.localeCompare(b.state));

await mkdir('data', { recursive: true });
await writeFile('data/notes.json', JSON.stringify(notes, null, 2) + '\n');
await writeFile('data/states.json', JSON.stringify(states, null, 2) + '\n');
console.log(`Saved ${notes.length} notes and ${states.length} states.`);
