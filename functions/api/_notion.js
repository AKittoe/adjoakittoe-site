// Shared helper: add a row to a Notion database using the NOTION_TOKEN set in Cloudflare.
export async function addRow(env, databaseId, properties) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });
  return res.ok;
}
export const text = s => [{ text: { content: String(s || '').slice(0, 1900) } }];
export const reply = (ok, status = ok ? 200 : 502) => new Response(JSON.stringify({ ok }), { status, headers: { 'Content-Type': 'application/json' } });
