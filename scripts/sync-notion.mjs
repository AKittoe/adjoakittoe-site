// Pulls site content from Notion and saves it as JSON (and images) for the site.
// Runs in GitHub Actions with the NOTION_TOKEN secret. Node 20+, no packages needed.
import { writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('Missing NOTION_TOKEN'); process.exit(1); }

const DB = {
  notes: 'afe7486bd6514bc386098bfc1eada4ab',      // Notes
  states: '842c11ca23ee42a9bc1db398add83aec',     // State Tracker
  pieces: '42186f521a69443ea766bd41e27776ae',     // Essays & Vibe Projects
  guideItems: 'a735e91ed0f946eaaf75dd87155ed61a', // Guide Items
  hover: 'b6288723f6a04132b48ce0a2e6910332',      // Hover Images
  projects: '1a8da941e0cd4524ba50c1e11da6d9b9',   // Projects
  seeds: 'ccb69c16f1024169b288d7f13c5df17d',      // Seeds (from the seed bed)
};

const headers = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, body) {
  for (let tries = 0; tries < 5; tries++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * (tries + 1)); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Notion kept failing on ${path}`);
}
async function queryAll(id) {
  const rows = []; let cursor;
  do { const j = await api(`databases/${id}/query`, cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }); rows.push(...j.results); cursor = j.has_more ? j.next_cursor : null; } while (cursor);
  return rows;
}
async function children(id) {
  const out = []; let cursor;
  do { const j = await api(`blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`); out.push(...j.results); cursor = j.has_more ? j.next_cursor : null; } while (cursor);
  for (const b of out) if (b.has_children && !['child_page', 'child_database'].includes(b.type)) b.children = await children(b.id);
  return out;
}

const plain = p => (p?.title || p?.rich_text || []).map(t => t.plain_text).join('').trim();
const check = p => !!p?.checkbox;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function saveFile(url, folder, name) {
  if (!url) return '';
  try {
    const res = await fetch(url); if (!res.ok) return '';
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : type.includes('pdf') ? 'pdf' : type.includes('svg') ? 'svg' : 'jpg';
    await mkdir(`assets/${folder}`, { recursive: true });
    const path = `assets/${folder}/${name}.${ext}`;
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return '/' + path;
  } catch { return ''; }
}
const fileUrl = f => f ? (f.type === 'external' ? f.external.url : f.file?.url) : '';
const saveProp = (page, prop, folder) => saveFile(fileUrl(prop?.files?.[0]), folder, page.id.replace(/-/g, ''));

// ---------- simple lists ----------
const notes = [];
for (const p of await queryAll(DB.notes)) {
  const pr = p.properties; if (!check(pr.Publish)) continue;
  notes.push({ title: plain(pr.Title), text: plain(pr.Text), tag: plain(pr.Tag), collection: pr.Collection?.select?.name || '', date: pr.Date?.date?.start || '', order: pr.Order?.number ?? 999, image: await saveProp(p, pr.Image, 'notes') });
}
notes.sort((a, b) => a.order - b.order);

const states = (await queryAll(DB.states)).map(p => { const pr = p.properties; return { state: plain(pr.State), visited: check(pr.Visited), favorite: check(pr.Favorite), wontGo: check(pr["Won't go"]), note: plain(pr['Hover note']) }; }).filter(s => s.state).sort((a, b) => a.state.localeCompare(b.state));

const projects = [];
for (const p of await queryAll(DB.projects)) {
  const pr = p.properties; if (!check(pr.Publish)) continue;
  projects.push({ name: plain(pr.Name), status: plain(pr.Status), description: plain(pr.Description), page: plain(pr['Links to page']), link: pr.Link?.url || '', color: pr['Hover color']?.select?.name || '', order: pr.Order?.number ?? 999 });
}
projects.sort((a, b) => a.order - b.order);

const seeds = (await queryAll(DB.seeds)).filter(p => check(p.properties.Approved)).map(p => ({ note: plain(p.properties.Note), date: p.created_time })).filter(x => x.note).sort((a, b) => a.date.localeCompare(b.date));

const hover = {};
for (const p of await queryAll(DB.hover)) {
  const pr = p.properties; if (!check(pr.Publish)) continue;
  const name = plain(pr.Name); if (!name) continue;
  hover[name.toLowerCase()] = { image: await saveProp(p, pr.Image, 'hover'), caption: plain(pr.Caption), link: pr.Link?.url || '', wide: check(pr.Wide) };
}

// ---------- long pages ----------
const pieceRows = (await queryAll(DB.pieces)).filter(p => check(p.properties.Publish));
const slugById = {};
for (const p of pieceRows) slugById[p.id.replace(/-/g, '')] = plain(p.properties.Slug) || slugify(plain(p.properties.Title));

const guideRows = [];
for (const p of await queryAll(DB.guideItems)) {
  const pr = p.properties; if (!check(pr.Publish)) continue;
  guideRows.push({ pageIds: (pr.Page?.relation || []).map(r => r.id.replace(/-/g, '')), name: plain(pr.Name), section: plain(pr.Section) || 'More', type: pr.Type?.select?.name || 'Tool', note: plain(pr.Note), category: plain(pr.Category), link: pr.Link?.url || '', page: plain(pr['Links to page']), color: plain(pr['Icon color']), order: pr.Order?.number ?? 999, image: await saveProp(p, pr.Image, 'guide') });
}

function rich(rt = []) {
  return rt.map(t => {
    let s = esc(t.plain_text);
    const a = t.annotations || {};
    if (a.code) s = `<code>${s}</code>`;
    if (a.bold) s = `<strong>${s}</strong>`;
    if (a.italic) s = `<em>${s}</em>`;
    if (a.strikethrough) s = `<s>${s}</s>`;
    if (a.underline) s = `<u>${s}</u>`;
    if (a.color === 'yellow_background') s = `<mark class="np-hl">${s}</mark>`;
    else if (a.color === 'gray') s = `<span class="np-muted">${s}</span>`;
    else if (a.color === 'purple') {
      const h = hover[t.plain_text.trim().toLowerCase()];
      if (h && h.image) s = `<span class="np-hov${h.wide ? ' np-hov-wide' : ''}" tabindex="0">${s}<span class="np-hov-card"><img src="${esc(h.image)}" alt="">${h.caption ? `<span>${esc(h.caption)}</span>` : ''}</span></span>`;
    }
    const mentionPage = t.type === 'mention' && t.mention?.type === 'page' ? t.mention.page.id.replace(/-/g, '') : null;
    if (mentionPage && slugById[mentionPage]) s = `<a href="#" data-page="${esc(slugById[mentionPage])}" class="ab-link">${s}</a>`;
    else if (t.href) {
      const m = t.href.match(/notion\.so\/.*?([0-9a-f]{32})/);
      if (m && slugById[m[1]]) s = `<a href="#" data-page="${esc(slugById[m[1]])}" class="ab-link">${s}</a>`;
      else s = `<a href="${esc(t.href)}" target="_blank" rel="noopener" class="ab-link">${s}<span class="ab-ext">↗</span></a>`;
    }
    return s;
  }).join('');
}
const txt = rt => (rt || []).map(t => t.plain_text).join('');
const cites = (html, slug) => html.replace(/\[(\d{1,2})\]/g, (_, n) => `<sup class="np-cite"><a href="#${slug}-src-${n}" data-src="${slug}-src-${n}">${n}</a></sup>`);

async function blocksToHtml(blocks, ctx) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], t = b.type, v = b[t] || {};
    if (t === 'bulleted_list_item' || t === 'numbered_list_item' || t === 'to_do') {
      const run = [b]; while (blocks[i + 1] && blocks[i + 1].type === t) run.push(blocks[++i]);
      if (ctx.sources && t === 'numbered_list_item') {
        out += `<ol class="np-sources">${(await Promise.all(run.map(async (x, k) => `<li id="${ctx.slug}-src-${k + 1}">${rich(x[t].rich_text)}</li>`))).join('')}</ol>`; continue;
      }
      if (ctx.ingredients && t === 'bulleted_list_item') { out += ingredients(run); continue; }
      const boldStart = x => x[t].rich_text?.[0]?.annotations?.bold;
      if (t === 'numbered_list_item' && run.every(boldStart)) {
        const items = [];
        for (const x of run) { let inner = rich(x[t].rich_text); if (x.children) inner += await blocksToHtml(x.children, { ...ctx, inStep: true }); items.push(`<li>${cites(inner, ctx.slug)}</li>`); }
        out += `<ol class="np-steps${ctx.method ? ' np-method' : ''}">${items.join('')}</ol>`; continue;
      }
      if (t === 'bulleted_list_item' && run.every(x => boldStart(x) && /:\s*$/.test(x[t].rich_text[0].plain_text) || (boldStart(x) && x[t].rich_text[1]?.plain_text?.startsWith(':')))) {
        out += `<dl class="np-dl">${run.map(x => { const [first, ...rest] = x[t].rich_text; return `<dt>${esc(first.plain_text.replace(/:\s*$/, ''))}</dt><dd>${rich(rest).replace(/^:\s*/, '')}</dd>`; }).join('')}</dl>`; continue;
      }
      const tag = t === 'numbered_list_item' ? 'ol' : 'ul';
      const items = [];
      for (const x of run) { let inner = t === 'to_do' ? `<span class="np-box${x.to_do.checked ? ' on' : ''}"></span>${rich(x[t].rich_text)}` : rich(x[t].rich_text); if (x.children) inner += await blocksToHtml(x.children, ctx); items.push(`<li>${cites(inner, ctx.slug)}</li>`); }
      out += `<${tag} class="np-list${t === 'to_do' ? ' np-check' : ''}">${items.join('')}</${tag}>`; continue;
    }
    switch (t) {
      case 'paragraph': { const h = rich(v.rich_text); if (h) out += `<p>${cites(h, ctx.slug)}</p>`; if (b.children) out += `<div class="np-indent">${await blocksToHtml(b.children, ctx)}</div>`; break; }
      case 'heading_1': case 'heading_2': case 'heading_3': {
        const level = { heading_1: 2, heading_2: 3, heading_3: 4 }[t]; const label = txt(v.rich_text);
        if (level === 2) { ctx.sources = /^sources$/i.test(label); ctx.ingredients = /^ingredients$/i.test(label); ctx.method = /^method$/i.test(label); out += `</section><section class="np-sec" id="${ctx.slug}-${slugify(label) || 's' + i}" data-toc="${esc(label)}">`; }
        out += `<h${level} class="np-h${level}">${rich(v.rich_text)}</h${level}>`;
        if (ctx.ingredients && ctx.serves) out += `<div class="np-serves">Serves <button type="button" class="np-sv" data-d="-1" aria-label="Fewer">−</button><b>${ctx.serves}</b><button type="button" class="np-sv" data-d="1" aria-label="More">+</button></div>`;
        break;
      }
      case 'quote': {
        const lines = rich(v.rich_text).split('\n'); let cite = '';
        if (lines.length > 1 && /^~\s*/.test(lines[lines.length - 1])) cite = lines.pop().replace(/^~\s*/, '');
        out += `<blockquote class="np-quote"><p>${lines.join('<br>')}</p>${cite ? `<cite>${cite}</cite>` : ''}</blockquote>`; break;
      }
      case 'callout': {
        const icon = v.icon?.emoji || '';
        if (icon === '📊') {
          const lines = []; let cur = [];
          for (const r of v.rich_text) { const parts = r.plain_text.split('\n'); parts.forEach((p, k) => { if (k > 0) { lines.push(cur); cur = []; } if (p) cur.push({ ...r, plain_text: p }); }); }
          lines.push(cur);
          out += `<div class="np-stats">${lines.filter(l => l.length).map(l => { const [n, ...rest] = l; return `<div><span class="np-stat-n">${esc(n.plain_text)}</span><span class="np-stat-l">${rich(rest)}</span></div>`; }).join('')}</div>`; break;
        }
        const inner = rich(v.rich_text) + (b.children ? await blocksToHtml(b.children, ctx) : '');
        out += ctx.inStep ? `<aside class="np-tip">${inner}</aside>` : `<div class="np-note">${icon ? `<span class="np-note-i">${esc(icon)}</span>` : ''}<div>${inner}</div></div>`; break;
      }
      case 'divider': out += '<hr class="np-hr">'; break;
      case 'code': out += `<pre class="np-code"><code>${esc(txt(v.rich_text))}</code></pre>`; break;
      case 'image': {
        const cap = txt(v.caption); const wide = /\(wide\)\s*$/i.test(cap);
        const src = await saveFile(fileUrl(v), 'pieces', b.id.replace(/-/g, ''));
        if (src) { ctx.images.push({ src, cap: cap.replace(/\(wide\)\s*$/i, '').trim() }); out += `<figure class="np-fig${wide ? ' np-wide' : ''}"><img src="${esc(src)}" alt="${esc(cap.replace(/\(wide\)\s*$/i, '').trim())}" loading="lazy">${cap ? `<figcaption>${rich(v.caption).replace(/\(wide\)\s*$/i, '')}</figcaption>` : ''}</figure>`; }
        break;
      }
      case 'column_list': {
        const cols = await Promise.all((b.children || []).map(c => blocksToHtml(c.children || [], ctx)));
        out += `<div class="np-cols" style="--n:${cols.length}">${cols.map(c => `<div>${c}</div>`).join('')}</div>`; break;
      }
      case 'toggle': {
        const label = txt(v.rich_text).trim(); const kids = b.children || [];
        if (/^(slideshow|gallery)$/i.test(label)) {
          const imgs = [];
          for (const k of kids) if (k.type === 'image') { const src = await saveFile(fileUrl(k.image), 'pieces', k.id.replace(/-/g, '')); if (src) imgs.push({ src, cap: txt(k.image.caption) }); }
          out += /^slideshow$/i.test(label)
            ? `<div class="np-slides"><div class="np-slides-track">${imgs.map(m => `<figure><img src="${esc(m.src)}" alt="${esc(m.cap)}" loading="lazy">${m.cap ? `<figcaption>${esc(m.cap)}</figcaption>` : ''}</figure>`).join('')}</div><button type="button" class="np-prev" aria-label="Previous">←</button><button type="button" class="np-next" aria-label="Next">→</button></div>`
            : `<div class="np-gallery">${imgs.map(m => `<figure><img src="${esc(m.src)}" alt="${esc(m.cap)}" loading="lazy">${m.cap ? `<figcaption>${esc(m.cap)}</figcaption>` : ''}</figure>`).join('')}</div>`;
          break;
        }
        if (/^timeline$/i.test(label)) {
          const tbl = kids.find(k => k.type === 'table'); const rows = (tbl?.children || []).map(r => r.table_row.cells);
          const data = (tbl?.table?.has_column_header ? rows.slice(1) : rows).filter(r => r.length >= 2);
          out += `<div class="np-timeline"><div class="np-tl-ticks">${data.map((r, k) => `<button type="button" class="np-tl-tick${k ? '' : ' on'}" data-i="${k}"><b>${rich(r[0])}</b><span>${rich(r[1])}</span></button>`).join('')}</div><div class="np-tl-detail">${data.map((r, k) => `<p class="np-tl-d${k ? '' : ' on'}" data-i="${k}"><strong>${rich(r[0])}.</strong> ${rich(r[2] || r[1])}</p>`).join('')}</div></div>`;
          break;
        }
        out += `<details class="np-toggle"><summary>${rich(v.rich_text)}</summary>${await blocksToHtml(kids, ctx)}</details>`; break;
      }
      case 'table': {
        const rows = (b.children || []).map(r => r.table_row.cells);
        if (v.has_column_header) out += `<div class="np-table-wrap"><table class="np-table"><thead><tr>${rows[0].map(c => `<th>${rich(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${rich(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        else out += `<div class="np-table-wrap"><table class="np-table np-facts"><tbody>${rows.map(r => `<tr><th>${rich(r[0])}</th>${r.slice(1).map(c => `<td>${rich(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        break;
      }
      case 'video': {
        const url = fileUrl(v); let embed = '';
        const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/); const vm = url.match(/vimeo\.com\/(\d+)/);
        if (yt) embed = `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1`; else if (vm) embed = `https://player.vimeo.com/video/${vm[1]}?autoplay=1`;
        const thumb = yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : '';
        const cap = txt(v.caption);
        if (embed) out += `<button type="button" class="np-video" data-embed="${esc(embed)}" data-title="${esc(cap)}">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : ''}<span class="rc-play" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg></span>${cap ? `<span class="np-video-cap">${esc(cap)}</span>` : ''}</button>`;
        else if (url) out += `<a class="np-linkcard" href="${esc(url)}" target="_blank" rel="noopener"><b>${esc(cap || url)}</b><span>${esc(url.replace(/^https?:\/\//, '').split('/')[0])} ↗</span></a>`;
        break;
      }
      case 'bookmark': case 'embed': case 'link_preview': {
        const url = v.url || ''; const cap = txt(v.caption);
        if (url) out += `<a class="np-linkcard" href="${esc(url)}" target="_blank" rel="noopener"><b>${esc(cap || url.replace(/^https?:\/\//, ''))}</b><span>${esc(url.replace(/^https?:\/\//, '').split('/')[0])} ↗</span></a>`; break;
      }
      case 'file': case 'pdf': {
        const name = v.name || txt(v.caption) || 'Download';
        const src = await saveFile(fileUrl(v), 'files', slugify(name) || b.id.replace(/-/g, ''));
        if (src) out += `<p><a class="site-link np-download" href="${esc(src)}" download>${esc(txt(v.caption) || name)} <span>↓</span></a></p>`; break;
      }
      default: break;
    }
  }
  return out;
}

const UNITS = 'cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|ml|l|oz|lbs?|pounds?|pinch(?:es)?|cloves?|cans?|small|medium|large|bunch(?:es)?|sprigs?|slices?|pieces?|handfuls?';
function ingredients(run) {
  const frac = { '½': .5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': .25, '¾': .75, '⅛': .125 };
  return `<ul class="np-ingr">${run.map(x => {
    const s = txt(x.bulleted_list_item.rich_text).trim();
    const m = s.match(new RegExp(`^((?:\\d+\\s+)?(?:\\d+\\/\\d+|\\d*\\.?\\d+|[½⅓⅔¼¾⅛])(?:\\s*[½⅓⅔¼¾⅛])?)\\s*(${UNITS})?\\b\\s*(.*)$`, 'i'));
    if (!m) return `<li>${rich(x.bulleted_list_item.rich_text)}</li>`;
    let n = 0; for (const part of m[1].trim().split(/\s+/)) { if (frac[part]) n += frac[part]; else if (part.includes('/')) { const [a, c] = part.split('/'); n += a / c; } else if (/^\d*\.?\d+[½⅓⅔¼¾⅛]$/.test(part)) { n += parseFloat(part) + frac[part.slice(-1)]; } else n += parseFloat(part); }
    return `<li><span class="np-amt" data-amt="${n}">${esc(m[1].trim())}</span>${m[2] ? ` <span class="np-unit">${esc(m[2])}</span>` : ''} ${esc(m[3])}</li>`;
  }).join('')}</ul>`;
}

const pieces = [];
for (const p of pieceRows) {
  const pr = p.properties; const id = p.id.replace(/-/g, '');
  const slug = slugById[id];
  const template = pr.Template?.select?.name || ((pr.Tags?.multi_select || []).some(t => t.name === 'recipe') ? 'Recipe' : 'Essay');
  const ctx = { slug, images: [], serves: pr.Serves?.number || 0 };
  let body = '';
  try { body = await blocksToHtml(await children(p.id), ctx); } catch (e) { console.warn(`Skipped body of ${slug}: ${e.message}`); }
  body = `<section class="np-sec np-first">${body}</section>`.replace(/<section class="np-sec np-first"><\/section>/, '');
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const items = guideRows.filter(g => g.pageIds.includes(id)).sort((a, b) => a.order - b.order).map(({ pageIds, ...g }) => g);
  pieces.push({
    slug, template, title: plain(pr.Title), section: pr.Section?.select?.name || 'Vibe Projects', zone: pr.Zone?.select?.name || '',
    tags: (pr.Tags?.multi_select || []).map(t => t.name), dek: plain(pr.Dek), sideLine: plain(pr['Side line']), meta: plain(pr['Meta note']),
    date: pr.Date?.date?.start || '', ai: check(pr['AI drafted']), readTime: pr['Read time (min)']?.number || Math.max(1, Math.ceil(words / 230)),
    replace: check(pr['Replace built page']), serves: pr.Serves?.number || null, time: plain(pr['Total time']), order: pr.Order?.number ?? 999, about: plain(pr['About this piece']), html: body, items,
  });
}
pieces.sort((a, b) => a.order - b.order || (b.date || '').localeCompare(a.date || ''));

await mkdir('data', { recursive: true });
const save = (f, d) => writeFile(`data/${f}`, JSON.stringify(d, null, 2) + '\n');
await Promise.all([save('notes.json', notes), save('states.json', states), save('pieces.json', pieces), save('projects.json', projects), save('seeds.json', seeds)]);
console.log(`Saved ${notes.length} notes, ${states.length} states, ${pieces.length} pages, ${projects.length} projects, ${seeds.length} seeds.`);
